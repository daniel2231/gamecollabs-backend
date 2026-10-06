import { readFile } from "node:fs/promises";
import { z } from "zod";
import { IngestCandidate, MAX_CANDIDATES_PER_CALL } from "@gamecollabs/schema";
import { config } from "../config.js";
import { IngestRun } from "../models/support.js";
import type { Principal } from "../auth/principal.js";
import { notify } from "../lib/outbound.js";
import { ingestCandidates } from "../services/ingest.js";
import { taxonomy } from "../services/taxonomy.js";

/** Scheduler identity: same scopes as an ingest token, no user record. */
const SCHEDULER: Principal = {
  kind: "user",
  role: "ingest",
  userId: null,
  label: "scheduler:openai",
  scopes: new Set(["public:read", "ingest:read", "ingest:write"]),
};

type ResponsesApiResult = {
  output?: { type: string; content?: { type: string; text?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
};

function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Fallback path when ChatGPT scheduled tasks + MCP are not available:
 * the home server calls the OpenAI Responses API (`web_search` + JSON output)
 * and feeds the result into the same `ingestCandidates` function.
 */
export async function discoverWithOpenAI(now = new Date()) {
  const cfg = config();
  if (!cfg.OPENAI_API_KEY || !cfg.OPENAI_MODEL) return { skipped: "OPENAI_API_KEY / OPENAI_MODEL not set" };

  const [spent] = await IngestRun.aggregate<{ total: number }>([
    { $match: { client: "openai-scheduler", createdAt: { $gte: monthStart(now) } } },
    { $group: { _id: null, total: { $sum: "$costUsd" } } },
  ]);
  if ((spent?.total ?? 0) >= cfg.OPENAI_MONTHLY_BUDGET_USD) {
    notify(`OpenAI collector skipped: monthly budget $${cfg.OPENAI_MONTHLY_BUDGET_USD} reached`);
    return { skipped: "budget" };
  }

  // Widen the window when the last run is older than a day (e.g. after an outage).
  const last = await IngestRun.findOne({ client: "openai-scheduler" }).sort({ createdAt: -1 }).lean();
  const hours = last ? Math.min(24 * 7, Math.max(48, Math.ceil((now.getTime() - last.createdAt.getTime()) / 3_600_000) + 24)) : 48;

  const tax = await taxonomy();
  const keys = tax.terms().map((t) => `${t._id} (${t.label.en})`).join("\n");
  const template = await readFile(cfg.DISCOVER_PROMPT_PATH, "utf8");
  const prompt = template.replaceAll("{{HOURS}}", String(hours)).replaceAll("{{TODAY}}", now.toISOString().slice(0, 10)) + `\n\n## Taxonomy keys\n${keys}`;

  const schema = z.toJSONSchema(z.object({ candidates: z.array(IngestCandidate).max(MAX_CANDIDATES_PER_CALL) }), { target: "draft-7", io: "input" });
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg.OPENAI_MODEL,
      input: prompt,
      tools: [{ type: "web_search" }],
      text: { format: { type: "json_schema", name: "collab_candidates", schema, strict: false } },
    }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const body = (await res.json()) as ResponsesApiResult;
  const text = body.output?.flatMap((o) => o.content ?? []).find((c) => c.type === "output_text")?.text ?? "{}";
  const candidates = (JSON.parse(text) as { candidates?: unknown[] }).candidates ?? [];
  const cost =
    ((body.usage?.input_tokens ?? 0) * cfg.OPENAI_PRICE_INPUT_PER_MTOK + (body.usage?.output_tokens ?? 0) * cfg.OPENAI_PRICE_OUTPUT_PER_MTOK) / 1_000_000;

  const runId = `openai-scheduler-${now.toISOString().slice(0, 10)}-${now.getTime().toString(36)}`;
  const summary = { created: 0, duplicate: 0, rejected: 0 };
  for (let i = 0; i < Math.max(candidates.length, 1); i += MAX_CANDIDATES_PER_CALL) {
    const chunk = candidates.slice(i, i + MAX_CANDIDATES_PER_CALL);
    if (!chunk.length) break;
    const result = await ingestCandidates({ runId, client: "openai-scheduler", model: cfg.OPENAI_MODEL, candidates: chunk }, SCHEDULER);
    for (const k of Object.keys(summary) as (keyof typeof summary)[]) summary[k] += result.summary[k];
  }
  await IngestRun.updateOne(
    { runId },
    { $setOnInsert: { runId, channel: "candidates", client: "openai-scheduler", model: cfg.OPENAI_MODEL }, $inc: { costUsd: cost } },
    { upsert: true },
  );
  return { runId, candidates: candidates.length, hours, costUsd: Number(cost.toFixed(4)), ...summary };
}
