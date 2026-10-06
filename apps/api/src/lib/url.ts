const TRACKING = /^(utm_[a-z]+|fbclid|gclid|igshid|mc_cid|mc_eid|ref_src|si)$/i;

/** Canonical source URL: lowercase host, no fragment, tracking params and trailing slash removed. */
export function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}
