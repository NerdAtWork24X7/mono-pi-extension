#!/usr/bin/env python3
"""Persistent batch web-fetch runner for the pi `web-fetch` tool.

ONE AsyncWebCrawler (ONE Chromium, multiple tabs) is started once and reused
across batches, so the multi-second Python + Playwright + Chromium startup is
paid once per session instead of once per tool call. The TS side keeps this
process alive between tool calls (idle-timeout / session end closes stdin,
which shuts us down gracefully).

Protocol (newline-delimited JSON)
---------------------------------
stdin : one request per line:
        {"batch": int, "concurrency": int, "timeout_ms": int,
         "page_delay_s": float, "scan_full_page": bool,
         "jobs": [{"key": int, "url": str, "raw": bool, "light": bool}, ...]}
        stdin EOF -> graceful shutdown.
stdout: one result per completed job:
        {"batch": int, "key": int, "url": str, "ok": true,  "text": str}
        {"batch": int, "key": int, "url": str, "ok": false, "error": str}
        then a batch terminator: {"batch": int, "done": true}
exit  : 0 on EOF, 1 on fatal/crawler error (TS respawns lazily on next batch).
"""
import asyncio
import json
import sys
import traceback

from crawl4ai import (
    AsyncWebCrawler,
    BrowserConfig,
    CrawlerRunConfig,
    SemaphoreDispatcher,
    DefaultMarkdownGenerator,
    PruningContentFilter,
    CacheMode,
)

# Remove cookie/consent dialogs (mirrors the old crwl js_code flag).
JS_CODE = (
    "const s='[role=\"dialog\"]|[aria-modal=\"true\"]|.cookie-consent|.consent-popup"
    "|#cookieChoiceInfo|.govuk-cookie-banner';"
    "s.split('|').forEach(x=>{document.querySelectorAll(x).forEach(y=>y.remove())})"
)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def extract_text(result, raw):
    if raw:
        return result.html or ""
    md = result.markdown
    if md is None:
        return ""
    return getattr(md, "fit_markdown", None) or getattr(md, "raw_markdown", None) or ""


def make_run_cfg(timeout_ms, page_delay_s, scan_full_page, light):
    """Per-batch crawl config. `light` skips the expensive human-simulation
    knobs (used for the static DuckDuckGo results page, where only the raw
    link list matters) — it is several seconds faster per fetch."""
    common = dict(
        remove_overlay_elements=True,
        remove_consent_popups=True,
        js_code=JS_CODE,
        page_timeout=timeout_ms,
        cache_mode=CacheMode.BYPASS,  # TS owns the disk cache; don't let crawl4ai cache
        markdown_generator=DefaultMarkdownGenerator(content_filter=PruningContentFilter()),
        verbose=False,
    )
    if light:
        return CrawlerRunConfig(delay_before_return_html=0.3, **common)
    return CrawlerRunConfig(
        magic=True,
        scan_full_page=scan_full_page,
        scroll_delay=0.5,
        delay_before_return_html=page_delay_s,
        override_navigator=True,
        simulate_user=True,
        **common,
    )


async def run_group(crawler, jobs, run_cfg, concurrency, batch_id):
    """Crawl one group of jobs (shared config). Returns False if the crawler
    itself failed (browser crash etc.) so the caller can stop the process and
    let TS respawn a fresh one. Per-page failures arrive as ok:false results,
    NOT as exceptions."""
    if not jobs:
        return True
    # SemaphoreDispatcher bounds parallel tabs. It runs non-streaming, so
    # arun_many returns results in INPUT ORDER — we zip by index, no key matching.
    dispatcher = SemaphoreDispatcher(semaphore_count=concurrency)
    try:
        results = await crawler.arun_many([j["url"] for j in jobs], config=run_cfg, dispatcher=dispatcher)
    except Exception as e:
        traceback.print_exc()
        for job in jobs:
            emit({"batch": batch_id, "key": job["key"], "url": job["url"],
                  "ok": False, "text": "", "error": "crawler error: %s" % e})
        return False
    for job, result in zip(jobs, results):
        ok = bool(getattr(result, "success", False))
        text = ""
        error = ""
        if ok:
            try:
                text = extract_text(result, bool(job.get("raw")))
            except Exception as e:
                ok = False
                error = "extract failed: %s" % e
        else:
            error = getattr(result, "error_message", None) or "crawl failed"
        emit({"batch": batch_id, "key": job["key"], "url": getattr(result, "url", None),
              "ok": ok, "text": text, "error": error})
    return True


async def handle_batch(crawler, req):
    """Run one batch: light jobs first (cheap), then full jobs. Always emits
    the batch terminator. Returns False if the crawler is unhealthy."""
    jobs = req.get("jobs") or []
    batch_id = req.get("batch")
    concurrency = int(req.get("concurrency") or 4)
    timeout_ms = int(req.get("timeout_ms") or 60000)
    page_delay_s = float(req.get("page_delay_s") or 2.0)
    scan_full = bool(req.get("scan_full_page", True))
    healthy = await run_group(
        crawler, [j for j in jobs if j.get("light")],
        make_run_cfg(timeout_ms, page_delay_s, scan_full, True), concurrency, batch_id)
    if healthy:
        healthy = await run_group(
            crawler, [j for j in jobs if not j.get("light")],
            make_run_cfg(timeout_ms, page_delay_s, scan_full, False), concurrency, batch_id)
    emit({"batch": batch_id, "done": True})
    return healthy


async def serve():
    browser_cfg = BrowserConfig(
        browser_type="chromium",
        headless=True,
        enable_stealth=True,
        viewport_width=1366,
        viewport_height=768,
        ignore_https_errors=True,
    )
    async with AsyncWebCrawler(config=browser_cfg) as crawler:
        while True:
            # Blocking readline in a thread: stdin is only read between batches.
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                return 0  # EOF — TS closed stdin (idle timeout / session end)
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except Exception as e:
                sys.stderr.write("bad request line: %s\n" % e)
                continue
            try:
                healthy = await handle_batch(crawler, req)
            except Exception:
                traceback.print_exc()
                healthy = False
                # Best-effort terminator so TS never waits for a lost batch.
                try:
                    emit({"batch": req.get("batch"), "done": True})
                except Exception:
                    pass
            if not healthy:
                return 1  # let TS respawn a fresh browser on the next batch


def main():
    try:
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
        sys.exit(asyncio.run(serve()))
    except KeyboardInterrupt:
        pass
    except Exception:
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
