import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import { FileClientsStore } from "./clientsStore.js";

export const SCOPE = "collabs:ingest";

type Pending = { clientId: string; params: AuthorizationParams; expiresAt: number };
type IssuedCode = Pending & { login: string };

const TEN_MINUTES = 10 * 60_000;

/** Exchanges a GitHub OAuth code for the user's login. Replaced in tests. */
export type GitHubLogin = (code: string, redirectUri: string) => Promise<string>;

export function githubLogin(cfg: Pick<Config, "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET">): GitHubLogin {
  return async (code, redirectUri) => {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: cfg.GITHUB_CLIENT_ID, client_secret: cfg.GITHUB_CLIENT_SECRET, code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(10_000),
    });
    const token = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!token.access_token) throw new Error(`GitHub token exchange failed: ${token.error ?? tokenRes.status}`);
    const userRes = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": "gamecollabs-mcp" },
      signal: AbortSignal.timeout(10_000),
    });
    const user = (await userRes.json()) as { login?: string };
    if (!user.login) throw new Error("GitHub user lookup failed");
    return user.login;
  };
}

/**
 * OAuth 2.1 authorization server for MCP clients (ChatGPT): dynamic client
 * registration, PKCE (verified by the SDK), login delegated to GitHub with a
 * single allowed account. Access/refresh tokens are signed JWTs, so the
 * server keeps no token state; pending logins and codes live in memory for
 * minutes only.
 */
export class GitHubOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: FileClientsStore;
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, IssuedCode>();
  private readonly key: Uint8Array;
  readonly callbackPath = "/oauth/github/callback";

  constructor(
    private readonly cfg: Config,
    private readonly exchangeGitHubCode: GitHubLogin = githubLogin(cfg),
  ) {
    this.clientsStore = new FileClientsStore(cfg.DATA_DIR);
    this.key = new TextEncoder().encode(cfg.MCP_JWT_SECRET);
  }

  private get callbackUrl() {
    return new URL(this.callbackPath, this.cfg.PUBLIC_URL).toString();
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.sweep();
    const tx = randomBytes(24).toString("base64url");
    this.pending.set(tx, { clientId: client.client_id, params, expiresAt: Date.now() + TEN_MINUTES });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: this.cfg.GITHUB_CLIENT_ID,
      redirect_uri: this.callbackUrl,
      state: tx,
      scope: "read:user",
      allow_signup: "false",
    }).toString();
    res.redirect(302, url.toString());
  }

  /** GitHub redirects here; on success the MCP client gets its authorization code. */
  readonly githubCallback = async (req: Request, res: Response) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const tx = this.pending.get(state);
    this.pending.delete(state);
    if (!tx || tx.expiresAt < Date.now()) {
      res.status(400).send("Login session expired. Start the connection again.");
      return;
    }
    const back = new URL(tx.params.redirectUri);
    if (tx.params.state) back.searchParams.set("state", tx.params.state);
    let login: string;
    try {
      if (!code) throw new Error(String(req.query.error ?? "missing code"));
      login = (await this.exchangeGitHubCode(code, this.callbackUrl)).toLowerCase();
    } catch (err) {
      logger.warn({ err }, "github login failed");
      back.searchParams.set("error", "access_denied");
      res.redirect(302, back.toString());
      return;
    }
    if (login !== this.cfg.ALLOWED_GITHUB_LOGIN) {
      logger.warn({ login }, "github account not allowed");
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "This GitHub account is not allowed.");
      res.redirect(302, back.toString());
      return;
    }
    const authCode = randomBytes(32).toString("base64url");
    this.codes.set(authCode, { ...tx, login, expiresAt: Date.now() + 5 * 60_000 });
    back.searchParams.set("code", authCode);
    logger.info({ login, clientId: tx.clientId }, "authorization code issued");
    res.redirect(302, back.toString());
  };

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const code = this.codes.get(authorizationCode);
    if (!code || code.clientId !== client.client_id || code.expiresAt < Date.now()) throw new InvalidGrantError("invalid authorization code");
    return code.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const code = this.codes.get(authorizationCode);
    this.codes.delete(authorizationCode); // single use
    if (!code || code.clientId !== client.client_id || code.expiresAt < Date.now()) throw new InvalidGrantError("invalid authorization code");
    if (redirectUri && redirectUri !== code.params.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    return this.issue(client.client_id, code.login, (resource ?? code.params.resource)?.toString());
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    try {
      const { payload } = await jwtVerify(refreshToken, this.key, { issuer: this.cfg.PUBLIC_URL, algorithms: ["HS256"] });
      if (payload.typ !== "refresh" || payload.client_id !== client.client_id) throw new Error("wrong token");
      if (payload.sub !== this.cfg.ALLOWED_GITHUB_LOGIN) throw new Error("account no longer allowed");
      return this.issue(client.client_id, payload.sub, resource?.toString() ?? (payload.resource as string | undefined));
    } catch {
      throw new InvalidGrantError("invalid refresh token");
    }
  }

  private async issue(clientId: string, login: string, resource: string | undefined): Promise<OAuthTokens> {
    const now = Math.floor(Date.now() / 1000);
    const sign = (typ: string, ttl: number) =>
      new SignJWT({ typ, client_id: clientId, scope: SCOPE, ...(resource ? { resource } : {}) })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(this.cfg.PUBLIC_URL)
        .setSubject(login)
        .setIssuedAt(now)
        .setExpirationTime(now + ttl)
        .setJti(randomBytes(12).toString("base64url"))
        .sign(this.key);
    return {
      access_token: await sign("access", this.cfg.ACCESS_TOKEN_TTL_SECONDS),
      token_type: "Bearer",
      expires_in: this.cfg.ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: await sign("refresh", this.cfg.REFRESH_TOKEN_TTL_SECONDS),
      scope: SCOPE,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: this.cfg.PUBLIC_URL, algorithms: ["HS256"] });
      if (payload.typ !== "access") throw new Error("not an access token");
      if (payload.sub !== this.cfg.ALLOWED_GITHUB_LOGIN) throw new Error("account no longer allowed");
      return {
        token,
        clientId: String(payload.client_id),
        scopes: String(payload.scope ?? "").split(" ").filter(Boolean),
        expiresAt: payload.exp,
        ...(payload.resource ? { resource: new URL(String(payload.resource)) } : {}),
        extra: { login: payload.sub },
      };
    } catch {
      throw new InvalidTokenError("invalid or expired access token");
    }
  }
}
