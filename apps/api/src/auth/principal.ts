import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { Types } from "mongoose";
import { jwtVerify } from "jose";
import { config } from "../config.js";
import { HttpError, forbidden } from "../lib/errors.js";
import { User, type Role } from "../models/support.js";

export const SCOPES = [
  "public:read",
  "submissions:write",
  "collabs:read_internal",
  "collabs:write",
  "collabs:submit",
  "collabs:publish",
  "entities:write",
  "entities:merge",
  "taxonomy:write",
  "ingest:read",
  "ingest:write",
  "ops:read",
] as const;
export type Scope = (typeof SCOPES)[number];

const ROLE_SCOPES: Record<Role | "service", Scope[]> = {
  service: ["public:read", "submissions:write"],
  admin: [...SCOPES],
  editor: [
    "public:read",
    "collabs:read_internal",
    "collabs:write",
    "collabs:submit",
    "entities:write",
    "ingest:read",
    "ops:read",
  ],
  // Agents write drafts only (enforced again in the collab service).
  agent: ["public:read", "collabs:read_internal", "collabs:write", "ingest:read"],
  // Automated collectors (MCP server, scheduler): candidate submission + lookups.
  ingest: ["public:read", "ingest:read", "ingest:write"],
};

export type Principal = {
  kind: "service" | "user";
  role: Role | "service";
  userId: Types.ObjectId | null;
  label: string;
  scopes: ReadonlySet<Scope>;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

export const TOKEN_PREFIX = "gct_";

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const unauthorized = (message = "missing or invalid token") => new HttpError(401, "unauthorized", message);

function principalFor(role: Role | "service", userId: Types.ObjectId | null, label: string): Principal {
  return { kind: role === "service" ? "service" : "user", role, userId, label, scopes: new Set(ROLE_SCOPES[role]) };
}

async function resolve(token: string): Promise<Principal> {
  const cfg = config();
  if (cfg.SERVICE_TOKENS.some((t) => safeEqual(t, token))) return principalFor("service", null, "service");

  if (token.startsWith(TOKEN_PREFIX)) {
    const user = await User.findOne({ tokenHash: hashToken(token), kind: "token", active: true });
    if (!user) throw unauthorized();
    if (!user.lastUsedAt || Date.now() - user.lastUsedAt.getTime() > 60_000) {
      await User.updateOne({ _id: user._id }, { lastUsedAt: new Date() });
    }
    return principalFor(user.role as Role, user._id, `token:${user.name}`);
  }

  // Admin JWT issued by the Next.js app after GitHub login (short-lived, HS256).
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(cfg.ADMIN_JWT_SECRET), {
      issuer: cfg.ADMIN_JWT_ISSUER,
      audience: cfg.ADMIN_JWT_AUDIENCE,
      algorithms: ["HS256"],
      requiredClaims: ["exp", "sub"],
      maxTokenAge: "12h",
    });
    const user = await User.findOne({ kind: "human", githubLogin: String(payload.sub).toLowerCase(), active: true });
    if (!user) throw unauthorized("account is not allowed");
    return principalFor(user.role as Role, user._id, `github:${user.githubLogin}`);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw unauthorized();
  }
}

/** Every route requires a token: service token, admin JWT or an API token. */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return next(unauthorized());
  try {
    req.principal = await resolve(token.trim());
    req.log?.setBindings?.({ actor: req.principal.label });
    next();
  } catch (err) {
    next(err);
  }
};

export const requireScope =
  (...scopes: Scope[]): RequestHandler =>
  (req, _res, next) => {
    const p = req.principal;
    if (!p) return next(unauthorized());
    if (!scopes.every((s) => p.scopes.has(s))) return next(forbidden(`requires ${scopes.join(", ")}`));
    next();
  };

export function hasScope(req: { principal?: Principal }, scope: Scope): boolean {
  return !!req.principal?.scopes.has(scope);
}

export function principal(req: { principal?: Principal }): Principal {
  if (!req.principal) throw unauthorized();
  return req.principal;
}
