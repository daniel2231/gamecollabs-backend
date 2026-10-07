import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { SignJWT } from "jose";
import request from "supertest";
import { loadConfig, setConfig, type Config } from "../src/config.js";
import { createApp } from "../src/app.js";
import { generateToken, hashToken } from "../src/auth/principal.js";
import { Collab } from "../src/models/collab.js";
import { Company, Property } from "../src/models/entities.js";
import { User } from "../src/models/support.js";
import { seedTaxonomy } from "../src/seed/run.js";
import { invalidateTaxonomy } from "../src/services/taxonomy.js";

export const SERVICE_TOKEN = "service-token-for-tests";
export const JWT_SECRET = "test-secret-that-is-at-least-32-characters";

/** Integration tests need a replica set (transactions). Default: local `rs0` from docker. */
const BASE_URI = process.env.TEST_MONGODB_URI ?? "mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true";

export function testConfig(overrides: Record<string, string> = {}): Config {
  const dbName = `gc_test_${randomBytes(4).toString("hex")}`;
  const url = new URL(BASE_URI);
  url.pathname = `/${dbName}`;
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    MONGODB_URI: url.toString(),
    SERVICE_TOKENS: SERVICE_TOKEN,
    ADMIN_JWT_SECRET: JWT_SECRET,
    INGEST_VERIFY_SOURCES: "false",
    ...overrides,
  });
}

export async function setupDb(overrides: Record<string, string> = {}) {
  const cfg = testConfig(overrides);
  setConfig(cfg);
  await mongoose.connect(cfg.MONGODB_URI);
  await Promise.all([Collab, Property, Company, User].map((m) => m.init()));
  await seedTaxonomy(false);
  invalidateTaxonomy();
  return cfg;
}

export async function teardownDb() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

export const app = () => createApp();

export async function adminJwt(login: string, role: "admin" | "editor" = "admin") {
  await User.updateOne({ githubLogin: login }, { kind: "human", githubLogin: login, name: login, role, active: true }, { upsert: true });
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(login)
    .setIssuer("gamecollabs-web")
    .setAudience("gamecollabs-api")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(JWT_SECRET));
}

export async function apiToken(name: string, role: "agent" | "ingest") {
  const token = generateToken();
  await User.create({ kind: "token", name, role, tokenHash: hashToken(token), tokenPrefix: token.slice(0, 10) });
  return token;
}

export const as = (token: string) => {
  const a = request(app());
  const h = { authorization: `Bearer ${token}` };
  return {
    get: (url: string) => a.get(url).set(h),
    post: (url: string) => a.post(url).set(h),
    patch: (url: string) => a.patch(url).set(h),
  };
};

export async function seedEntities() {
  const [aot, pubg, blood, krafton, taiko, jagariko] = await Promise.all([
    Property.create({ slug: "attack-on-titan", kind: "partner_category.anime_manga", name: { ko: "진격의 거인", en: "Attack on Titan", original: "進撃の巨人" }, aliases: ["AoT", "Shingeki no Kyojin"] }),
    Property.create({ slug: "pubg-mobile", kind: "partner_category.game", name: { ko: "배틀그라운드 모바일", en: "PUBG Mobile" }, aliases: ["PUBG M"] }),
    Property.create({ slug: "blood-strike", kind: "partner_category.game", name: { ko: "블러드 스트라이크", en: "Blood Strike" } }),
    Company.create({ slug: "krafton", name: { ko: "크래프톤", en: "Krafton" }, country: "KR" }),
    Property.create({ slug: "taiko-no-tatsujin", kind: "partner_category.game", name: { ko: "태고의 달인", en: "Taiko no Tatsujin" } }),
    Property.create({ slug: "jagariko", kind: "partner_category.f_and_b", name: { ko: "자가리코", en: "Jagariko" } }),
  ]);
  return { aot, pubg, blood, krafton, taiko, jagariko };
}

export function draftBody(host: string, partner: string, extra: Record<string, unknown> = {}) {
  return {
    i18n: {
      ko: { title: "배틀그라운드 모바일 × 진격의 거인", summary: "진격의 거인 테마 스킨과 맵이 추가된다." },
      en: { title: "PUBG Mobile x Attack on Titan", summary: "Attack on Titan themed skins and a map arrive." },
    },
    parties: [
      { propertyId: host, role: "host" },
      { propertyId: partner, role: "partner" },
    ],
    category: "category.in_game",
    regions: ["region.korea", "region.japan"],
    platforms: ["platform.android", "platform.ios"],
    collabTypes: ["collab_type.cosmetic_item", "collab_type.map_stage"],
    period: { start: "2026-09-01", end: "2026-10-31" },
    sources: [{ url: "https://example.com/news/aot?utm_source=x#top", type: "official" }],
    ...extra,
  };
}
