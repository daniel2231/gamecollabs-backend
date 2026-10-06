import { config } from "../config.js";
import { logger } from "../logger.js";

async function post(url: string, body: unknown, headers: Record<string, string> = {}, attempts = 3): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return;
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt === attempts) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

/**
 * Asks the Next.js app to drop cached responses for these tags
 * (`collabs`, `collab:<slug>`, `property:<slug>`, `company:<slug>`). Fire and forget.
 */
export function revalidate(tags: Iterable<string>): void {
  const cfg = config();
  const list = [...new Set(tags)];
  if (!cfg.WEB_REVALIDATE_URL || list.length === 0) return;
  const headers: Record<string, string> = cfg.WEB_REVALIDATE_SECRET ? { authorization: `Bearer ${cfg.WEB_REVALIDATE_SECRET}` } : {};
  post(cfg.WEB_REVALIDATE_URL, { tags: list }, headers)
    .then(() => logger.debug({ tags: list }, "revalidated"))
    .catch((err) => logger.warn({ err, tags: list }, "revalidate webhook failed"));
}

/** Operator alert (Slack/Discord compatible `{ text }` webhook). Fire and forget. */
export function notify(text: string, details?: Record<string, unknown>): void {
  const url = config().ALERT_WEBHOOK_URL;
  logger.warn({ alert: text, ...details }, "alert");
  if (!url) return;
  const body = details ? `${text}\n\`\`\`${JSON.stringify(details, null, 2).slice(0, 1800)}\`\`\`` : text;
  post(url, { text: body, content: body }).catch((err) => logger.error({ err }, "alert webhook failed"));
}
