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
const ADMIN_KEY = "gct_admin_test_key";
let baseCfg: ReturnType<typeof loadConfig>;
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
  const doc = { id: "6ac8ddb4baf0384ec4d7163c", slug: "a-b-2026-10", status: "draft", rev: 3, i18n: { ko: { title: "가" }, en: { title: "A" } }, parties: [], period: { start: null, end: null, endKind: "tba" }, sources: [{ url: "https://x.example" }], origin: { type: "gpt", runId: "r" }, updatedAt: "2026-10-11T00:00:00.000Z" };
  api.get("/v1/admin/collabs", (_req, res) => res.json({ data: [doc] }));
  api.get("/v1/admin/collabs/:id", (_req, res) => res.json({ data: doc }));
  api.get("/v1/admin/collabs/:id/duplicates", (_req, res) => res.json({ data: [] }));
  api.patch("/v1/admin/collabs/:id", (req, res) => res.json({ data: { ...doc, ...req.body, rev: Number(req.get("if-match")) + 1 } }));
  const names = (en: string, original: string | null = null) => ({ ko: en, en, original });
  api.get("/v1/admin/companies", (_req, res) =>
    res.json({
      data: [
        { id: "c".repeat(24), slug: "sega", names: names("SEGA", "セガ"), aliases: [], collabCount: 9, country: "JP", exact: false },
        { id: "d".repeat(24), slug: "netease-games", names: names("NetEase Games"), aliases: [], collabCount: 4, country: null, exact: false },
      ],
    }),
  );
  api.get("/v1/admin/properties", (_req, res) =>
    res.json({
      data: [
        { id: "e".repeat(24), slug: "knives-out", names: names("Knives Out", "荒野行動"), aliases: [], collabCount: 5, kind: { key: "partner_category.game", label: "Game" }, officialUrl: null, featuredOrder: null, image: null, exact: false },
        { id: "f".repeat(24), slug: "monaki", names: names("Monaki"), aliases: [], collabCount: 1, kind: { key: "partner_category.music", label: "Music" }, officialUrl: "https://monaki.example", featuredOrder: 2, image: { url: "https://media.example/m.webp" }, exact: false },
      ],
    }),
  );
  api.patch("/v1/admin/:type/:id", (req, res) => res.json({ data: { _id: req.params.id, ...req.body } }));
  api.post("/v1/admin/properties/:id/merge", (req, res) => res.json({ data: { _id: req.params.id, merged: req.body.from } }));
  api.get("/v1/ingest/followups", (_req, res) => res.json({ data: [{ id: doc.id, slug: doc.slug, status: "draft", rev: 3, reason: "start_tba" }] }));
  api.post("/v1/ingest/followups/:id", (req, res) => res.json({ data: { result: req.body.outcome === "no_change" ? "recorded" : "applied", slug: req.params.id } }));
  api.get("/v1/admin/followups", (_req, res) => res.json({ data: [] }));
  api.post("/v1/admin/collabs/:id/followup", (req, res) => res.json({ data: { ...doc, rev: Number(req.get("if-match") ?? doc.rev) + 1 } }));
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
    ADMIN_API_KEY: ADMIN_KEY,
    MCP_JWT_SECRET: "mcp-secret-that-is-long-enough-for-hs256",
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    ALLOWED_GITHUB_LOGIN: "Daniel2231",
    DATA_DIR: await mkdtemp(join(tmpdir(), "mcp-test-")),
  });
  baseCfg = cfg;
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

  it("lists the ingest and follow-up tools with honest annotations", async () => {
    const res = await rpc(accessToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(200);
    const tools = Object.fromEntries(res.body.result.tools.map((t: { name: string; annotations: unknown }) => [t.name, t.annotations]));
    expect(Object.keys(tools).sort()).toEqual(["find_entity", "get_taxonomy", "list_followups", "report_followup", "search_collabs", "submit_collab_candidates"]);
    expect(tools.get_taxonomy).toMatchObject({ readOnlyHint: true });
    expect(tools.list_followups).toMatchObject({ readOnlyHint: true });
    expect(tools.report_followup).toMatchObject({ readOnlyHint: false, destructiveHint: false });
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

  it("lists due follow-ups and reports re-checks with the ingest key", async () => {
    const call = (id: number, name: string, args: unknown) => rpc(accessToken, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const list = await call(5, "list_followups", {});
    expect(JSON.parse(list.body.result.content[0].text)[0]).toMatchObject({ slug: "a-b-2026-10", reason: "start_tba" });
    expect(received.at(-1)).toMatchObject({ path: "/v1/ingest/followups?limit=20", auth: `Bearer ${API_KEY}` });

    const report = { outcome: "updated", rev: 3, changes: { period: { start: "2026-11-01", endKind: "tba" } }, sources: [{ url: "https://news.example.com/date" }] };
    const res = await call(6, "report_followup", { id_or_slug: "a-b-2026-10", report });
    expect(JSON.parse(res.body.result.content[0].text)).toEqual({ result: "applied", slug: "a-b-2026-10" });
    expect(received.at(-1)).toMatchObject({ path: "/v1/ingest/followups/a-b-2026-10", auth: `Bearer ${API_KEY}`, body: { outcome: "updated", rev: 3 } });

    const before = received.length;
    const bad = await call(7, "report_followup", { id_or_slug: "a-b-2026-10", report: { outcome: "updated", rev: 3, changes: { period: { start: "2026-11-01" } } } });
    expect(bad.body.result?.isError ?? bad.body.error).toBeTruthy();
    expect(received.length).toBe(before);
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

describe("admin endpoint", () => {
  let accessToken: string;
  const adminRpc = (body: unknown) =>
    request(app).post("/mcp/admin").set("authorization", `Bearer ${accessToken}`).set("accept", "application/json, text/event-stream").send(body);
  const call = async (name: string, args: unknown) => {
    const res = await adminRpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } });
    return res.body.result as { isError?: boolean; content: { text: string }[] };
  };
  beforeAll(async () => {
    accessToken = (await token()).access_token;
  });

  it("has its own protected resource metadata and challenge", async () => {
    const meta = await request(app).get("/.well-known/oauth-protected-resource/mcp/admin");
    expect(meta.body).toMatchObject({ resource: `${PUBLIC_URL}/mcp/admin`, authorization_servers: [`${PUBLIC_URL}/`] });
    const res = await request(app).post("/mcp/admin").send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/oauth-protected-resource\/mcp\/admin/);
  });

  it("adds the editing tools there and only there", async () => {
    const res = await adminRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = res.body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(
      [
        "collab_history",
        "create_entity",
        "find_entity",
        "followup_queue",
        "get_collab",
        "get_taxonomy",
        "list_collabs",
        "list_entities",
        "list_followups",
        "merge_entities",
        "mirror_cover",
        "report_followup",
        "resolve_followup",
        "search_collabs",
        "submit_collab_candidates",
        "transition_collab",
        "update_collab",
        "update_entity",
      ].sort(),
    );
    const merge = res.body.result.tools.find((t: { name: string }) => t.name === "merge_entities");
    expect(merge.annotations).toMatchObject({ destructiveHint: true });
    const ingest = await rpc(accessToken, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(ingest.body.result.tools).toHaveLength(6);
  });

  it("calls the admin API with the admin key, defaulting the review queue and sending If-Match", async () => {
    const list = await call("list_collabs", {});
    expect(JSON.parse(list.content[0]!.text)[0]).toMatchObject({ slug: "a-b-2026-10", rev: 3, origin: "gpt" });
    const listCall = received.filter((r) => r.path.startsWith("/v1/admin/collabs?")).at(-1)!;
    expect(listCall.auth).toBe(`Bearer ${ADMIN_KEY}`);
    expect(listCall.path).toContain("status=draft%2Cin_review");

    const upd = await call("update_collab", { id_or_slug: "a-b-2026-10", rev: 3, patch: { period: { start: "2026-10-20", endKind: "tba" } } });
    expect(upd.isError).toBeFalsy();
    expect(JSON.parse(upd.content[0]!.text)).toMatchObject({ rev: 4, start: "2026-10-20" });

    await call("update_entity", { kind: "company", id: "d".repeat(24), patch: { country: "CN" } });
    expect(received.at(-1)).toMatchObject({ path: `/v1/admin/companies/${"d".repeat(24)}`, body: { country: "CN" } });
    await call("update_entity", { kind: "property", id: "e".repeat(24), patch: { kind: "partner_category.game" } });
    expect(received.at(-1)).toMatchObject({ path: `/v1/admin/properties/${"e".repeat(24)}`, body: { kind: "partner_category.game" } });

    const merged = await call("merge_entities", { kind: "property", target_id: "a".repeat(24), source_id: "b".repeat(24) });
    expect(JSON.parse(merged.content[0]!.text)).toEqual({ _id: "a".repeat(24), merged: "b".repeat(24) });
  });

  it("lists companies and properties, filtered by a missing field or kind", async () => {
    const companies = JSON.parse((await call("list_entities", { kind: "company", missing: "country" })).content[0]!.text);
    expect(received.at(-1)).toMatchObject({ path: "/v1/admin/companies?limit=1000&locale=en", auth: `Bearer ${ADMIN_KEY}` });
    expect(companies).toEqual({
      total: 1,
      offset: 0,
      items: [{ id: "d".repeat(24), slug: "netease-games", names: { ko: "NetEase Games", en: "NetEase Games", original: null }, aliases: [], collabCount: 4, country: null }],
    });

    const noImage = JSON.parse((await call("list_entities", { kind: "property", missing: "image" })).content[0]!.text);
    expect(noImage.items.map((e: { slug: string }) => e.slug)).toEqual(["knives-out"]);
    expect(noImage.items[0]).toMatchObject({ kind: "partner_category.game", officialUrl: null, image: null, featuredOrder: null });

    const music = JSON.parse((await call("list_entities", { kind: "property", partner_category: "partner_category.music" })).content[0]!.text);
    expect(music.items).toEqual([expect.objectContaining({ slug: "monaki", image: "https://media.example/m.webp", featuredOrder: 2 })]);

    const paged = JSON.parse((await call("list_entities", { kind: "company", offset: 1, limit: 1 })).content[0]!.text);
    expect(paged).toMatchObject({ total: 2, offset: 1, items: [{ slug: "netease-games" }] });

    const before = received.length;
    expect((await call("list_entities", { kind: "property", missing: "country" })).isError).toBeTruthy();
    expect((await call("list_entities", { kind: "company", partner_category: "partner_category.game" })).isError).toBeTruthy();
    expect(received.length).toBe(before);
  });

  it("reads the re-check queue and resolves proposals with If-Match", async () => {
    await call("followup_queue", {});
    expect(received.at(-1)).toMatchObject({ path: "/v1/admin/followups?view=proposals&limit=20", auth: `Bearer ${ADMIN_KEY}` });
    const res = await call("resolve_followup", { id_or_slug: "a-b-2026-10", action: "apply", rev: 3 });
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ slug: "a-b-2026-10", rev: 4 });
    expect(received.at(-1)).toMatchObject({ path: "/v1/admin/collabs/a-b-2026-10/followup", body: { action: "apply" } });
  });

  it("validates patches against the collab schema before calling the API", async () => {
    const before = received.length;
    const bad = await call("update_collab", { id_or_slug: "a-b-2026-10", rev: 3, patch: { period: { start: "next week" } } });
    expect(bad.isError).toBeTruthy();
    expect(received.length).toBe(before);
  });

  it("does not exist without an admin key", async () => {
    const plain = createApp({ ...baseCfg, ADMIN_API_KEY: undefined });
    expect((await request(plain).post("/mcp/admin").send({})).status).toBe(404);
  });
});
