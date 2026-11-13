import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { Types } from "mongoose";
import { decodeJwt, jwtVerify } from "jose";
import { config } from "../config.js";
import { HttpError, forbidden } from "../lib/errors.js";
import { Member } from "../models/member.js";
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
  "changelog:write",
  /** Create or refresh a member after a Discord login (Next.js server only). */
  "members:write",
  /** List, block and delete members (admin only: personal data). */
  "members:manage",
] as const;
export type Scope = (typeof SCOPES)[number];

const ROLE_SCOPES: Record<Role | "service", Scope[]> = {
  service: ["public:read", "submissions:write", "members:write"],
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
  kind: "service" | "user" | "member";
  role: Role | "service" | "member";
  userId: Types.ObjectId | null;
  /** Set only for members (Discord login). Members have no scopes: `/v1/me` checks this instead. */
  memberId?: Types.ObjectId;
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

  const key = new TextEncoder().encode(cfg.ADMIN_JWT_SECRET);
  // Member JWT issued by the Next.js app after Discord login. Its own audience, so it
  // never passes the admin check below (and an admin JWT never passes this one).
  if (audienceOf(token) === cfg.MEMBER_JWT_AUDIENCE) {
    try {
      const { payload } = await jwtVerify(token, key, {
        issuer: cfg.ADMIN_JWT_ISSUER,
        audience: cfg.MEMBER_JWT_AUDIENCE,
        algorithms: ["HS256"],
        requiredClaims: ["exp", "sub"],
        maxTokenAge: "31d",
      });
      if (payload.scope !== "member" || !isObjectId(payload.sub)) throw unauthorized();
      const member = await Member.findOne({ _id: payload.sub, active: true }, { _id: 1, discordId: 1 }).lean();
      if (!member) throw unauthorized("member is not active");
      return { kind: "member", role: "member", userId: null, memberId: member._id, label: `discord:${member.discordId}`, scopes: new Set() };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw unauthorized();
    }
  }

  // Admin JWT issued by the Next.js app after GitHub login (short-lived, HS256).
  try {
    const { payload } = await jwtVerify(token, key, {
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

/** Unverified `aud` of a JWT, only to pick which check to run. */
function audienceOf(token: string): string | null {
  try {
    const { aud } = decodeJwt(token);
    return typeof aud === "string" ? aud : null;
  } catch {
    return null;
  }
}

const isObjectId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);

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

/** `/v1/me/*`: only a signed-in member (not staff, not the service token). */
export const requireMember: RequestHandler = (req, _res, next) => {
  if (!req.principal) return next(unauthorized());
  if (req.principal.kind !== "member" || !req.principal.memberId) return next(forbidden("requires a member session"));
  next();
};

export function hasScope(req: { principal?: Principal }, scope: Scope): boolean {
  return !!req.principal?.scopes.has(scope);
}

export function principal(req: { principal?: Principal }): Principal {
  if (!req.principal) throw unauthorized();
  return req.principal;
}
