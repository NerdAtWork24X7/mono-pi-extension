#!/usr/bin/env python3
"""Batch web-fetch runner for the pi `web-fetch` tool.

Uses a single Crawl4AI AsyncWebCrawler (ONE Chromium, multiple tabs/pages) to
crawl a batch of URLs via `arun_many` + SemaphoreDispatcher. Replaces the old
behaviour of spawning one `crwl` process per URL (N Chromium instances).

Protocol
--------
stdin : JSON
        {"jobs":[{"key":int,"url":str,"raw":bool}, ...],
         "concurrency":int, "timeout_ms":int}
stdout: newline-delimited JSON, one object per completed job:
        {"key":int,"url":str,"ok":true,"text":str}
        {"key":int,"url":str,"ok":false,"error":str}
exit  : 0 on normal completion (per-job failures are reported via ok:false).
"""
import json
import sys
import asyncio
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


def extract_text(result, raw):
    if raw:
        return result.html or ""
    md = result.markdown
    if md is None:
        return ""
    return getattr(md, "fit_markdown", None) or getattr(md, "raw_markdown", None) or ""


async def crawl(jobs, concurrency, timeout_ms, write):
    browser_cfg = BrowserConfig(
        browser_type="chromium",
        headless=True,
        enable_stealth=True,
        viewport_width=1366,
        viewport_height=768,
        ignore_https_errors=True,
    )
    run_cfg = CrawlerRunConfig(
        magic=True,
        remove_overlay_elements=True,
        remove_consent_popups=True,
        scan_full_page=True,
        scroll_delay=0.5,
        delay_before_return_html=2,
        override_navigator=True,
        simulate_user=True,
        js_code=JS_CODE,
        page_timeout=timeout_ms,
        cache_mode=CacheMode.BYPASS,  # TS owns the disk cache; don't let crawl4ai cache
        markdown_generator=DefaultMarkdownGenerator(content_filter=PruningContentFilter()),
        verbose=False,
    )
    # SemaphoreDispatcher bounds parallel tabs. It runs non-streaming, so
    # arun_many returns results in INPUT ORDER — we zip by index, no key matching.
    dispatcher = SemaphoreDispatcher(semaphore_count=concurrency)

    def emit(job, result):
        key = job["key"]
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
        rec = {"key": key, "url": getattr(result, "url", None), "ok": ok, "text": text, "error": error}
        write(json.dumps(rec, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    async with AsyncWebCrawler(config=browser_cfg) as crawler:
        results = await crawler.arun_many(
            [j["url"] for j in jobs], config=run_cfg, dispatcher=dispatcher
        )
        for job, result in zip(jobs, results):
            emit(job, result)


def main():
    try:
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
        req = json.load(sys.stdin)
    except Exception as e:
        sys.stderr.write("bad stdin: %s\n" % e)
        sys.exit(2)

    jobs = req.get("jobs") or []
    concurrency = int(req.get("concurrency") or 4)
    timeout_ms = int(req.get("timeout_ms") or 60000)
    if not jobs:
        return

    try:
        asyncio.run(crawl(jobs, concurrency, timeout_ms, sys.stdout.write))
    except Exception:
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
