/**
 * Shared disk cache for provider model-list fetches.
 *
 * Provider extensions (kilo, tokenrouter) fetch their model lists over the
 * network at extension load time. The agent-team extension loads every
 * extension into every spawned subagent process, so each subagent boot paid
 * one or more remote fetches (up to 10s timeout each) before it could even
 * start the LLM. Caching the model list to disk makes subagent boots read a
 * local file instead — network only happens when the cache is missing or
 * stale. The host process refreshes the cache on its own boot; short-lived
 * subagents consume it.
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "fs";
import { randomBytes } from "crypto";
import { safeUnlink } from "./core";

const CACHE_DIR = join(homedir(), ".pi", "cache");
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/** Owner-only. Cached model lists can reflect account-specific entitlements
 *  (e.g. a provider's custom/allowed model set for the caller's API key), so
 *  the cache directory and its files should not be world-readable on shared
 *  machines. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function ensureCacheDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true, mode: DIR_MODE });
  // mkdirSync's `mode` isn't reliably honoured for pre-existing directories
  // (e.g. left over from before this change, or created with a wider
  // process umask), so enforce it explicitly. Best-effort: unsupported on
  // some platforms/filesystems.
  try { chmodSync(CACHE_DIR, DIR_MODE); } catch { /* best effort */ }
}

interface CacheEnvelope<T> {
  cachedAt: number;
  data: T;
}

function cacheFile(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

function readEnvelope<T>(key: string): CacheEnvelope<T> | null {
  try {
    if (!existsSync(cacheFile(key))) return null;
    const env = JSON.parse(readFileSync(cacheFile(key), "utf-8")) as CacheEnvelope<T>;
    if (env && typeof env.cachedAt === "number" && Array.isArray(env.data)) return env;
  } catch {
    /* missing / corrupted — treat as no cache */
  }
  return null;
}

/** A model list is only usable when non-empty — caching an empty array would
 *  pin the provider to zero models for the whole TTL (e.g. a rate-limited
 *  upstream that momentarily returns `{ data: [] }`). */
function isUsable(models: unknown[]): boolean {
  return models.length > 0;
}

/**
 * Return the cached model list for `key` when it exists and is fresher than
 * `ttlMs`; otherwise fetch via `fetchFn` and write the result to disk. On a
 * fetch failure, fall back to the stale cache when one exists (better to
 * serve slightly stale model metadata than an empty provider). Throws only
 * when there is neither a usable cache nor a successful fetch.
 */
export async function loadCachedModels<T>(
  key: string,
  fetchFn: () => Promise<T[]>,
  opts?: { ttlMs?: number },
): Promise<T[]> {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;

  const fresh = readEnvelope<T[]>(key);
  if (fresh && isUsable(fresh.data) && Date.now() - fresh.cachedAt < ttlMs) return fresh.data;

  try {
    const data = await fetchFn();
    // Write via temp file + rename so a concurrent reader (host + a
    // subagent booting at the same time) never sees a torn file. The temp
    // name is unique per call (pid + random suffix) so two writers racing
    // on the same key — e.g. two host processes booting at once — never
    // share a path and interleave writes into the same file; whichever
    // rename lands last simply wins atomically instead of corrupting.
    const tmp = `${cacheFile(key)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      ensureCacheDir();
      writeFileSync(tmp, JSON.stringify({ cachedAt: Date.now(), data } satisfies CacheEnvelope<T[]>), { mode: FILE_MODE });
      renameSync(tmp, cacheFile(key));
    } catch {
      /* cache write failure is non-fatal — but don't leave an orphaned
       * temp file sitting on disk forever if we got past the write. */
      safeUnlink(tmp);
    }
    return data;
  } catch (err) {
    const stale = readEnvelope<T[]>(key);
    if (stale && isUsable(stale.data)) return stale.data;
    throw err;
  }
}
