const DDG_SKIP_DOMAINS = ["duckduckgo.com", "duck.co", "help.duckduckgo.com", "spreadprivacy.com"];

/** Extract real result URLs from the markdown rendering of DuckDuckGo.
 *  Unwraps `duckduckgo.com/l/?uddg=` redirects, skips DDG's own domains and
 *  non-http(s) schemes. */
export function extractUrlsFromDDGMarkdown(md: string, limit: number): string[] {
	const seen = new Set<string>();
	const urls: string[] = [];
	const patterns = [/\[.*?\]\((https?:\/\/[^)]+)\)/g, /(https?:\/\/[^\s)]+)/g];
	for (const re of patterns) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(md)) !== null) {
			let raw = m[1] || m[0];
			try {
				const probe = new URL(raw, "https://duckduckgo.com");
				const uddg = probe.searchParams.get("uddg"); // unwrap //duckduckgo.com/l/?uddg=REAL_URL
				if (uddg) raw = uddg;
			} catch { /* not a redirect, keep raw */ }
			try {
				const u = new URL(raw);
				if (u.protocol !== "http:" && u.protocol !== "https:") continue;
				const host = u.hostname.toLowerCase();
				if (DDG_SKIP_DOMAINS.some((d) => host === d || host.endsWith("." + d))) continue;
				if (seen.has(u.href)) continue;
				seen.add(u.href);
				urls.push(u.href);
				if (urls.length >= limit) return urls;
			} catch { /* skip malformed */ }
		}
	}
	return urls;
}
