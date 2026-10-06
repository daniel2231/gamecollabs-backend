import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "../config.js";

/** Rejects loopback, private, link-local and other non-public addresses (SSRF guard). */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  if (config().ALLOW_PRIVATE_FETCH) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error("private address");
}

export type FetchOptions = { method?: "GET" | "HEAD"; timeoutMs?: number; maxRedirects?: number; maxBytes?: number };

/**
 * Fetches a public URL, re-checking every redirect hop against the SSRF guard.
 * The body is read only up to `maxBytes`; `maxBytes: 0` skips it.
 */
export async function safeFetch(
  raw: string,
  { method = "GET", timeoutMs = 8000, maxRedirects = 5, maxBytes = 15 * 1024 * 1024 }: FetchOptions = {},
): Promise<{ status: number; url: string; headers: Headers; body: Buffer | null }> {
  let url = new URL(raw);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHost(url);
    const res = await fetch(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "GameCollabsBot/1.0 (+source verification)", accept: "*/*" },
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    let body: Buffer | null = null;
    if (maxBytes === 0) {
      await res.body?.cancel();
    } else if (method === "GET" && res.body) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > maxBytes) throw new Error("response too large");
        chunks.push(Buffer.from(chunk));
      }
      body = Buffer.concat(chunks);
    }
    return { status: res.status, url: url.toString(), headers: res.headers, body };
  }
  throw new Error("too many redirects");
}

/** HEAD first, GET when the server refuses HEAD. Returns the final HTTP status or null on network error. */
export async function checkUrl(url: string): Promise<{ status: number | null; error?: string }> {
  try {
    let res = await safeFetch(url, { method: "HEAD" });
    if (res.status === 405 || res.status === 501) res = await safeFetch(url, { method: "GET", maxBytes: 0 });
    return { status: res.status };
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 401/403/429 usually mean bot protection on a live page, so they count as reachable. */
export function isReachable(status: number | null): boolean {
  return status !== null && (status < 400 || status === 401 || status === 403 || status === 429);
}
