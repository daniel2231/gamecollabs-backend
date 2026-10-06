import { createHash } from "node:crypto";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { SubmissionInput } from "@gamecollabs/schema";
import { config } from "../config.js";
import { requireScope } from "../auth/principal.js";
import { HttpError, parse } from "../lib/errors.js";
import { normalizeUrl } from "../lib/url.js";
import { Submission } from "../models/support.js";

export const submissionsRouter: Router = Router();

/** The browser never calls the API; Next.js relays the visitor IP in X-Client-IP. */
const clientIp = (req: { get(name: string): string | undefined; ip?: string }) => req.get("x-client-ip") ?? req.ip ?? "unknown";

async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  const secret = config().TURNSTILE_SECRET;
  if (!secret) return true;
  if (!token) return false;
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    signal: AbortSignal.timeout(5000),
  });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean };
  return !!body.success;
}

submissionsRouter.post(
  "/",
  requireScope("submissions:write"),
  rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => clientIp(req),
    handler: (_req, res) => res.status(429).json({ error: { code: "rate_limited", message: "too many submissions" } }),
  }),
  async (req, res) => {
    const input = parse(SubmissionInput, req.body);
    const ip = clientIp(req);
    if (!(await verifyTurnstile(input.turnstileToken, ip))) throw new HttpError(400, "bot_check_failed");
    const url = normalizeUrl(input.url);
    const existing = await Submission.findOne({ url, status: "new" }).lean();
    if (!existing) {
      await Submission.create({
        url,
        note: input.note ?? null,
        locale: input.locale ?? null,
        ipHash: createHash("sha256").update(`${ip}:${config().ADMIN_JWT_SECRET}`).digest("hex").slice(0, 32),
      });
    }
    res.status(202).json({ data: { accepted: true } });
  },
);
