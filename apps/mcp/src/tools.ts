import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { IngestCandidate, IsoDate, MAX_CANDIDATES_PER_CALL } from "@gamecollabs/schema";
import { ApiError, type ApiClient, type TaxonomyNode } from "./apiClient.js";
import { logger } from "./logger.js";

const INSTRUCTIONS = `Game × IP collab tracker (public sources, human-reviewed).
Workflow: call get_taxonomy once, research collabs announced in the requested window,
check each with search_collabs and find_entity, then submit only new ones with
submit_collab_candidates (max ${MAX_CANDIDATES_PER_CALL} per call). Submissions are stored as drafts
and published only after a person reviews them. Every candidate needs a title and a summary
in both Korean and English, and at least one public source URL; never invent dates or
details that the source does not state.`;

function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function failure(err: unknown): CallToolResult {
  const message =
    err instanceof ApiError ? `API error ${err.status}: ${JSON.stringify(err.body).slice(0, 1000)}` : err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: message }] };
}

const flatten = (nodes: TaxonomyNode[], parent: string | null = null): { key: string; en: string; ko: string; parent: string | null }[] =>
  nodes.flatMap((n) => [{ key: n.key, en: n.labels.en, ko: n.labels.ko, parent }, ...flatten(n.children, n.key)]);

/** Run id shared by all submissions of the same KST day from this client. */
export function dailyRunId(client: string, now = new Date()): string {
  return `${client}-${new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10)}`;
}

type Ctx = { authInfo?: { extra?: Record<string, unknown>; clientId?: string } };

/** Builds a fresh MCP server (stateless transport: one per request). */
export function createMcpServer(api: ApiClient): McpServer {
  const server = new McpServer({ name: "gamecollabs-ingest", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  /** Every tool call is logged (tool, account, duration, outcome). */
  const logged = async (tool: string, args: unknown, ctx: Ctx, fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    const started = Date.now();
    const result = await fn().catch(failure);
    logger.info(
      {
        tool,
        user: ctx.authInfo?.extra?.login,
        clientId: ctx.authInfo?.clientId,
        ms: Date.now() - started,
        error: !!result.isError,
        args: JSON.stringify(args ?? {}).slice(0, 500),
      },
      "tool call",
    );
    return result;
  };

  server.registerTool(
    "get_taxonomy",
    {
      title: "Get taxonomy keys",
      description: "Returns every classification key (category, partner_category, region, platform, collab_type) with Korean/English labels. Use these keys or labels in submissions.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (ctx) =>
      logged("get_taxonomy", {}, ctx, async () => {
        const tree = await api.taxonomy();
        return json(Object.fromEntries(Object.entries(tree).map(([tax, nodes]) => [tax, flatten(nodes)])));
      }),
  );

  server.registerTool(
    "search_collabs",
    {
      title: "Search existing collabs",
      description: "Finds collabs already in the tracker (drafts included) by title or game/IP name and start-date range, to avoid duplicate submissions.",
      inputSchema: {
        query: z.string().trim().min(1).max(200).describe("Title, game name or IP name"),
        from: IsoDate.optional().describe("Earliest start date, YYYY-MM-DD"),
        to: IsoDate.optional().describe("Latest start date, YYYY-MM-DD"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, ctx) =>
      logged("search_collabs", args, ctx, async () => json(await api.lookupCollabs({ q: args.query, from: args.from, to: args.to, limit: 20 }))),
  );

  server.registerTool(
    "find_entity",
    {
      title: "Find a game, IP or company",
      description: "Looks up games/IPs (properties) and companies by name or alias, returning their canonical slug and names. Use the slug in submissions so names stay consistent.",
      inputSchema: { name: z.string().trim().min(1).max(200) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, ctx) => logged("find_entity", args, ctx, async () => json(await api.lookupEntities(args.name))),
  );

  server.registerTool(
    "submit_collab_candidates",
    {
      title: "Submit collab candidates",
      description: `Submits up to ${MAX_CANDIDATES_PER_CALL} newly found collabs. The server re-validates everything (schema, source URL reachability, taxonomy mapping, duplicates) and stores accepted ones as drafts for human review; it never publishes. Resubmitting the same source URL does not create a second draft. Returns created / duplicate / rejected per candidate with reasons.`,
      inputSchema: { candidates: z.array(IngestCandidate).min(1).max(MAX_CANDIDATES_PER_CALL) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args, ctx) =>
      logged("submit_collab_candidates", { count: args.candidates.length }, ctx, async () =>
        json(await api.submitCandidates({ runId: dailyRunId("chatgpt-mcp"), client: "chatgpt-mcp", candidates: args.candidates })),
      ),
  );

  return server;
}
