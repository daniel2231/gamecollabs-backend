import { createHash, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { dailyRunId } from "../src/tools.js";

const PUBLIC_URL = "http://localhost:3001";
const API_KEY = "gct_internal_test_key";
const received: { path: string; auth?: string; body?: unknown }[] = [];
let fakeApi: Server;
let app: ReturnType<typeof createApp>;
let loginAs = "daniel2231";

beforeAll(async () => {
  // Stand-in for the Express API.
  const api = express();
  api.use(express.json());
  api.use((req, _res, next) => {
    received.push({ path: req.originalUrl, auth: req.get("authorization"), body: req.body });
    next();
  });
  api.get("/v1/taxonomies", (_req, res) => {
    res.json({ data: { platform: [{ key: "platform.mobile", label: "Mobile", labels: { ko: "모바일", en: "Mobile" }, children: [{ key: "platform.android", label: "Android", labels: { ko: "안드로이드", en: "Android" }, children: [] }] }] } });
  });
  api.get("/v1/ingest/lookup/entities", (_req, res) => {
    res.json({ data: [{ type: "property", slug: "attack-on-titan", exact: true }] });
  });
  api.post("/v1/ingest/candidates", (req, res) => {
    res.json({ data: { runId: req.body.runId, results: [{ index: 0, status: "created", slug: "x" }], summary: { created: 1, duplicate: 0, rejected: 0 } } });
  });
  fakeApi = await new Promise<Server>((resolve) => {
    const s = api.listen(0, () => resolve(s));
  });
  const cfg = loadConfig({
    PUBLIC_URL,
    API_URL: `http://127.0.0.1:${(fakeApi.address() as AddressInfo).port}`,
    INTERNAL_API_KEY: API_KEY,
    MCP_JWT_SECRET: "mcp-secret-that-is-long-enough-for-hs256",
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    ALLOWED_GITHUB_LOGIN: "Daniel2231",
    DATA_DIR: await mkdtemp(join(tmpdir(), "mcp-test-")),
  });
  app = createApp(cfg, { githubLogin: async (code) => (code === "good" ? loginAs : Promise.reject(new Error("bad code"))) });
});

afterAll(() => new Promise<void>((r) => fakeApi.close(() => r())));

const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

async function oauthFlow() {
  const reg = await request(app).post("/register").send({ redirect_uris: [REDIRECT], client_name: "ChatGPT", token_endpoint_auth_method: "none" });
  expect(reg.status).toBe(201);
  const clientId = reg.body.client_id as string;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const auth = await request(app)
    .get("/authorize")
    .query({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s1", scope: "collabs:ingest" });
  expect(auth.status).toBe(302);
  const gh = new URL(auth.headers.location!);
  expect(gh.host).toBe("github.com");
  expect(gh.searchParams.get("redirect_uri")).toBe(`${PUBLIC_URL}/oauth/github/callback`);

  const cb = await request(app).get("/oauth/github/callback").query({ code: "good", state: gh.searchParams.get("state")! });
  expect(cb.status).toBe(302);
  const back = new URL(cb.headers.location!);
  return { clientId, verifier, back };
}

async function token() {
  const { clientId, verifier, back } = await oauthFlow();
  expect(back.searchParams.get("state")).toBe("s1");
  const tok = await request(app)
    .post("/token")
    .type("form")
    .send({ grant_type: "authorization_code", client_id: clientId, code: back.searchParams.get("code")!, code_verifier: verifier, redirect_uri: REDIRECT });
  expect(tok.status, JSON.stringify(tok.body)).toBe(200);
  return { clientId, ...tok.body } as { clientId: string; access_token: string; refresh_token: string };
}

const rpc = (accessToken: string, body: unknown) =>
  request(app).post("/mcp").set("authorization", `Bearer ${accessToken}`).set("accept", "application/json, text/event-stream").send(body);

describe("OAuth", () => {
  it("publishes metadata and challenges unauthenticated MCP calls", async () => {
    const meta = await request(app).get("/.well-known/oauth-authorization-server");
    expect(meta.body).toMatchObject({ issuer: `${PUBLIC_URL}/`, code_challenge_methods_supported: ["S256"] });
    expect(meta.body.registration_endpoint).toBe(`${PUBLIC_URL}/register`);
    const res = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/resource_metadata=/);
  });

  it("issues tokens after GitHub login and refreshes them", async () => {
    const t = await token();
    expect(t.access_token).toBeTruthy();
    const refreshed = await request(app).post("/token").type("form").send({ grant_type: "refresh_token", client_id: t.clientId, refresh_token: t.refresh_token });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).not.toBe(t.access_token);
  });

  it("rejects reused codes and wrong verifiers", async () => {
    const { clientId, back } = await oauthFlow();
    const bad = await request(app)
      .post("/token")
      .type("form")
      .send({ grant_type: "authorization_code", client_id: clientId, code: back.searchParams.get("code")!, code_verifier: "x".repeat(43), redirect_uri: REDIRECT });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_grant");
  });

  it("only lets the allowed GitHub account in", async () => {
    loginAs = "someone-else";
    try {
      const { back } = await oauthFlow();
      expect(back.searchParams.get("error")).toBe("access_denied");
      expect(back.searchParams.get("code")).toBeNull();
    } finally {
      loginAs = "daniel2231";
    }
  });
});

describe("tools", () => {
  let accessToken: string;
  beforeAll(async () => {
    accessToken = (await token()).access_token;
  });

  it("lists the four tools with honest annotations", async () => {
    const res = await rpc(accessToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(200);
    const tools = Object.fromEntries(res.body.result.tools.map((t: { name: string; annotations: unknown }) => [t.name, t.annotations]));
    expect(Object.keys(tools).sort()).toEqual(["find_entity", "get_taxonomy", "search_collabs", "submit_collab_candidates"]);
    expect(tools.get_taxonomy).toMatchObject({ readOnlyHint: true });
    expect(tools.submit_collab_candidates).toMatchObject({ readOnlyHint: false, idempotentHint: true });
  });

  it("flattens the taxonomy", async () => {
    const res = await rpc(accessToken, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_taxonomy", arguments: {} } });
    const data = JSON.parse(res.body.result.content[0].text);
    expect(data.platform).toEqual([
      { key: "platform.mobile", en: "Mobile", ko: "모바일", parent: null },
      { key: "platform.android", en: "Android", ko: "안드로이드", parent: "platform.mobile" },
    ]);
  });

  it("submits candidates to the internal API with the server-side key", async () => {
    const candidate = {
      title: { ko: "배틀그라운드 모바일 × 진격의 거인", en: "PUBG Mobile x Attack on Titan" },
      summary: { ko: "콜라보 스킨이 추가된다.", en: "Collab skins are added." },
      game: { name: "PUBG Mobile" },
      partner: { name: "Attack on Titan" },
      period: { start: "2026-11-01" },
      sources: [{ url: "https://news.example.com/a" }],
    };
    const res = await rpc(accessToken, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "submit_collab_candidates", arguments: { candidates: [candidate] } } });
    expect(res.body.result.isError).toBeFalsy();
    const call = received.find((r) => r.path === "/v1/ingest/candidates")!;
    expect(call.auth).toBe(`Bearer ${API_KEY}`);
    expect(call.body).toMatchObject({ client: "chatgpt-mcp", runId: dailyRunId("chatgpt-mcp") });
  });

  it("validates tool input before calling the API", async () => {
    const before = received.length;
    const res = await rpc(accessToken, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "submit_collab_candidates", arguments: { candidates: Array.from({ length: 21 }, () => ({})) } },
    });
    expect(res.body.result?.isError ?? res.body.error).toBeTruthy();
    expect(received.length).toBe(before);
  });
});
