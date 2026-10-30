import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  COLLAB_STATUSES,
  CollabPatch,
  CompanyInput,
  CompanyPatch,
  FOLLOW_UP_VIEWS,
  FollowUpReport,
  IngestCandidate,
  IsoDate,
  MAX_CANDIDATES_PER_CALL,
  ORIGIN_TYPES,
  PropertyInput,
  PropertyPatch,
  TRANSITION_ACTIONS,
} from "@gamecollabs/schema";
import { ApiError, type AdminCollab, type AdminEntity, type ApiClient, type TaxonomyNode } from "./apiClient.js";
import { logger } from "./logger.js";

const INSTRUCTIONS = `Game × IP collab tracker (public sources, human-reviewed).
Workflow: call get_taxonomy once, research collabs announced in the requested window,
check each with search_collabs and find_entity, then submit only new ones with
submit_collab_candidates (max ${MAX_CANDIDATES_PER_CALL} per call). Submissions are stored as drafts
and published only after a person reviews them. Every candidate needs a title and a summary
in both Korean and English, and at least one public source URL; never invent dates or
details that the source does not state. When the start date has not been announced, leave
period.start out: the candidate is still stored as a draft for review. When the announcement does
not say yet what the collab adds (items, skins, events), set contentTba: true so it is re-checked.
Always give game.names, partner.names and companies[].names (official Korean and English
names, plus the original-script name when it differs; for companies also country as ISO
alpha-2): if find_entity finds nothing, the server creates the game/IP/company from them so
the draft is linked; use the slug from find_entity when it does find one. Give every company its
role: developer (makes the game), publisher (publishes/operates it), licensor (owns the partner IP),
brand_partner (brand, food & beverage, retail), organizer (venue or event operator).
For offline collabs (cafés, pop-up stores, events, shop campaigns) add venues: the official venue
name in Korean and English, the address as officially written, and the venue page URL if any.

Follow-ups: collabs announced without dates (start not out, only the month known, end not announced)
or without their content (contentTba) are re-checked on a schedule. list_followups returns the ones due; look each up again (official site,
press release, patch notes, store page) and call report_followup once per collab: outcome "no_change"
when nothing new is public (the next check moves back: 3, 7, 14, then 30 days), or "updated" with
the rev from list_followups, the changed period and/or i18n (plus contentTba: false once the content
is announced), and the source that states it. Drafts are
updated directly; for collabs under review or published the change waits for an admin. Only report what
a source states; an end date that a guide or community post guesses is not announced.`;

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

const ADMIN_INSTRUCTIONS = `${INSTRUCTIONS}

Admin tools (editing the live tracker): list_collabs / get_collab to read drafts and published
collabs (by id or slug); update_collab to fix fields (pass the rev from get_collab; each top-level
field you send replaces the stored one, so send complete i18n / sources / parties / companies
arrays); transition_collab to submit, publish, reject (reason required), archive or reopen;
find_entity, list_entities, create_entity, update_entity and merge_entities for games/IPs/companies
(list_entities with missing: "country", "official_url", "image" or "original_name" finds the entries
to fill in; set only what the official site or another public source states). Every change
is recorded in the collab history (collab_history) and can be undone by editing again. Only change
what a public source supports, and publish only complete collabs (ko/en text, linked parties,
category, start date, sources).
followup_queue shows re-check proposals (changes found for collabs under review or published) and
escalated collabs (no news after many checks: set the dates, endKind "permanent", or archive);
resolve_followup applies a proposal (rev required, same rules as update_collab) or dismisses it.`;

/** Compact row for lists: enough to pick what to open with get_collab. */
function row(c: AdminCollab) {
  return {
    id: c.id,
    slug: c.slug,
    status: c.status,
    rev: c.rev,
    title: { ko: c.i18n?.ko?.title, en: c.i18n?.en?.title },
    start: c.period?.start?.slice(0, 10) ?? null,
    end: c.period?.end?.slice(0, 10) ?? null,
    endKind: c.period?.endKind,
    parties: c.parties?.map((p) => ({ role: p.role, slug: p.slug, linked: !!p.propertyId, name: p.name?.en ?? p.name?.ko ?? null })),
    sources: c.sources?.length ?? 0,
    origin: c.origin?.type,
    duplicateCount: c.duplicateCount ?? 0,
    updatedAt: c.updatedAt,
  };
}

/** Builds a fresh MCP server (stateless transport: one per request). `admin` adds the editing tools. */
export function createMcpServer(api: ApiClient, opts: { admin?: boolean } = {}): McpServer {
  const admin = !!opts.admin && api.hasAdmin;
  const server = new McpServer(
    { name: admin ? "gamecollabs-admin" : "gamecollabs-ingest", version: "1.1.0" },
    { instructions: admin ? ADMIN_INSTRUCTIONS : INSTRUCTIONS },
  );

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
      description: `Submits up to ${MAX_CANDIDATES_PER_CALL} newly found collabs. The server re-validates everything (schema, source URL reachability, taxonomy mapping, duplicates) and stores accepted ones as drafts for human review; it never publishes. Resubmitting the same source URL does not create a second draft. Omit period.start when no start date has been announced (do not guess one); set contentTba: true when what the collab adds is not announced yet. Give game.names / partner.names / companies[].names ({ ko, en, original? }) so a game, IP or company that is not in the tracker yet is created and linked. Returns created / duplicate / rejected per candidate with reasons.`,
      inputSchema: { candidates: z.array(IngestCandidate).min(1).max(MAX_CANDIDATES_PER_CALL) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args, ctx) =>
      logged("submit_collab_candidates", { count: args.candidates.length }, ctx, async () =>
        json(await api.submitCandidates({ runId: dailyRunId("chatgpt-mcp"), client: "chatgpt-mcp", candidates: args.candidates })),
      ),
  );

  server.registerTool(
    "list_followups",
    {
      title: "List collabs due for a re-check",
      description:
        "Collabs whose dates or content were not fully announced and whose next check is due, oldest first: reason start_tba (start date not out), month_only (only the month known), end_tba (end not announced), end_missing, or content_tba (dates known, content not announced). Each row has id, rev, titles, summary, parties, current period, contentTba and source URLs; when contentTba is true, look for the content too, whatever the reason.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, ctx) => logged("list_followups", args, ctx, async () => json(await api.dueFollowUps(args.limit))),
  );

  server.registerTool(
    "report_followup",
    {
      title: "Report a collab re-check",
      description:
        'Records the result of re-checking one collab from list_followups. outcome "no_change": nothing new is public (schedules the next check). outcome "updated": pass rev (from list_followups), changes.period (complete period: start, end, endKind fixed|permanent|tba; YYYY-MM-DD or YYYY-MM) and/or changes.i18n (whole ko and en title/summary) and/or changes.contentTba (false once the content is announced; send it with the i18n that describes it), and the sources stating it (added to the stored ones). Drafts are updated at once; collabs under review or published get a proposal that an admin applies or dismisses.',
      inputSchema: { id_or_slug: z.string().trim().min(1).max(200).describe("id or slug from list_followups"), report: FollowUpReport },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args, ctx) => logged("report_followup", args, ctx, async () => json(await api.reportFollowUp(args.id_or_slug, args.report))),
  );

  if (admin) registerAdminTools(server, api, logged);
  return server;
}

type Logged = (tool: string, args: unknown, ctx: Ctx, fn: () => Promise<CallToolResult>) => Promise<CallToolResult>;

const IdOrSlug = z.string().trim().min(1).max(200).describe("Collab id (24 hex) or slug");
const Kind = z.enum(["property", "company"]).describe("property = game/IP, company = company");

/** Fields `list_entities` can filter on by absence, and the entity kind each belongs to (null: both). */
const ENTITY_GAP_KIND = { country: "company", official_url: "property", image: "property", original_name: null } as const;
const ENTITY_GAPS = Object.keys(ENTITY_GAP_KIND) as [keyof typeof ENTITY_GAP_KIND, ...(keyof typeof ENTITY_GAP_KIND)[]];

function isMissing(e: AdminEntity, gap: keyof typeof ENTITY_GAP_KIND): boolean {
  if (gap === "country") return !e.country;
  if (gap === "official_url") return !e.officialUrl;
  if (gap === "image") return !e.image?.url;
  return !e.names?.original;
}

/** Compact entity row: what update_entity needs plus the fields worth checking. */
function entityRow(e: AdminEntity) {
  return {
    id: e.id,
    slug: e.slug,
    names: e.names,
    aliases: e.aliases,
    collabCount: e.collabCount,
    ...(e.country !== undefined ? { country: e.country } : {}),
    ...(e.kind !== undefined ? { kind: e.kind?.key ?? null } : {}),
    ...(e.officialUrl !== undefined ? { officialUrl: e.officialUrl } : {}),
    ...(e.image !== undefined ? { image: e.image?.url ?? null } : {}),
    ...(e.featuredOrder !== undefined ? { featuredOrder: e.featuredOrder } : {}),
  };
}
const EntityId = z.string().regex(/^[a-f0-9]{24}$/).describe("Entity id from find_entity");

function registerAdminTools(server: McpServer, api: ApiClient, logged: Logged) {
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

  server.registerTool(
    "list_collabs",
    {
      title: "List collabs (admin)",
      description: "Lists collabs of any status, newest change first: drafts waiting for review, published ones, etc. Returns compact rows (id, slug, status, rev, titles, dates, parties, duplicate count).",
      inputSchema: {
        status: z.array(z.enum(COLLAB_STATUSES)).optional().describe("Default: draft and in_review"),
        origin: z.array(z.enum(ORIGIN_TYPES)).optional(),
        query: z.string().trim().max(100).optional().describe("Search in titles and names"),
        limit: z.number().int().min(1).max(100).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, ctx) =>
      logged("list_collabs", args, ctx, async () => {
        const rows = await api.listCollabs({
          status: (args.status ?? ["draft", "in_review"]).join(","),
          origin: args.origin?.join(","),
          q: args.query,
          limit: args.limit,
        });
        return json(rows.map(row));
      }),
  );

  server.registerTool(
    "get_collab",
    {
      title: "Get a collab (admin)",
      description: "Full stored document of one collab (any status) with its current rev, plus duplicate candidates. Call this before update_collab or transition_collab.",
      inputSchema: { id_or_slug: IdOrSlug },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, ctx) =>
      logged("get_collab", args, ctx, async () => {
        const [collab, duplicates] = await Promise.all([api.getCollab(args.id_or_slug), api.collabDuplicates(args.id_or_slug)]);
        return json({ collab, duplicates });
      }),
  );

  server.registerTool(
    "update_collab",
    {
      title: "Update a collab (admin)",
      description:
        "Changes fields of a collab. Each top-level field in `patch` replaces the stored value (send the whole i18n object with ko and en, the whole sources/parties/companies arrays). Parties link games/IPs with { propertyId, role: host|partner }. Dates: YYYY-MM-DD or YYYY-MM; period.endKind fixed|permanent|tba. `rev` must be the current rev from get_collab (a stale rev is refused).",
      inputSchema: { id_or_slug: IdOrSlug, rev: z.number().int().min(1), patch: CollabPatch },
      annotations: { ...write, idempotentHint: true },
    },
    (args, ctx) => logged("update_collab", args, ctx, async () => json(row(await api.updateCollab(args.id_or_slug, args.rev, args.patch)))),
  );

  server.registerTool(
    "transition_collab",
    {
      title: "Change collab status (admin)",
      description: "submit (draft → in_review), publish (makes it public; it must be complete), reject (back to draft, reason required), archive (hide), reopen (archived → draft).",
      inputSchema: {
        id_or_slug: IdOrSlug,
        action: z.enum(TRANSITION_ACTIONS),
        reason: z.string().trim().max(1000).optional(),
        rev: z.number().int().min(1).optional().describe("Current rev; refused if it changed meanwhile"),
      },
      annotations: write,
    },
    (args, ctx) =>
      logged("transition_collab", args, ctx, async () =>
        json(row(await api.transitionCollab(args.id_or_slug, { action: args.action, ...(args.reason ? { reason: args.reason } : {}) }, args.rev))),
      ),
  );

  server.registerTool(
    "followup_queue",
    {
      title: "Re-check queue (admin)",
      description: "view proposals: changes a re-check found for collabs under review or published, waiting for a decision. view applied: changes a re-check already made to drafts that no admin has acknowledged yet (with the values before them). view escalated: collabs with no news after many checks. view due: what list_followups returns. view queued: every collab still being re-checked, by next check date.",
      inputSchema: { view: z.enum(FOLLOW_UP_VIEWS).default("proposals"), limit: z.number().int().min(1).max(50).default(20) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, ctx) => logged("followup_queue", args, ctx, async () => json(await api.followUpQueue(args.view, args.limit))),
  );

  server.registerTool(
    "resolve_followup",
    {
      title: "Apply or dismiss a re-check proposal (admin)",
      description: "apply: makes the proposed period/text change and adds its sources, like update_collab (rev required, published collabs must stay complete). dismiss: drops the proposal and resumes checking.",
      inputSchema: { id_or_slug: IdOrSlug, action: z.enum(["apply", "dismiss"]), rev: z.number().int().min(1).optional().describe("Current rev, required to apply") },
      annotations: write,
    },
    (args, ctx) => logged("resolve_followup", args, ctx, async () => json(row(await api.resolveFollowUp(args.id_or_slug, args.action, args.rev)))),
  );

  server.registerTool(
    "collab_history",
    {
      title: "Collab change history (admin)",
      description: "Revisions of a collab (who changed what, newest first). Use it to review or undo a change.",
      inputSchema: { id_or_slug: IdOrSlug },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, ctx) => logged("collab_history", args, ctx, async () => json(await api.collabRevisions(args.id_or_slug))),
  );

  server.registerTool(
    "mirror_cover",
    {
      title: "Mirror a collab cover (admin)",
      description: "Copies the collab's cover image (cover.originalUrl, set with update_collab) to the tracker's own storage so it keeps working if the source removes it.",
      inputSchema: { id_or_slug: IdOrSlug },
      annotations: { ...write, idempotentHint: true },
    },
    (args, ctx) => logged("mirror_cover", args, ctx, async () => json(await api.mirrorCover(args.id_or_slug))),
  );

  server.registerTool(
    "list_entities",
    {
      title: "List games/IPs or companies (admin)",
      description:
        "Lists every property (game/IP) or company, most collabs first, with id, slug, names, aliases and collab count; companies also carry country, properties their kind (partner_category), officialUrl, image and home placement. `missing` keeps only entries without that field (country: companies only; official_url, image: properties only; original_name: both), e.g. to fill them in with update_entity.",
      inputSchema: {
        kind: Kind,
        missing: z.enum(ENTITY_GAPS).optional(),
        partner_category: z.string().regex(/^partner_category\.[a-z0-9_]+$/).optional().describe("Properties only: keep this kind, e.g. partner_category.anime"),
        offset: z.number().int().min(0).max(1000).default(0),
        limit: z.number().int().min(1).max(500).default(200),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, ctx) =>
      logged("list_entities", args, ctx, async () => {
        const gapKind = args.missing && ENTITY_GAP_KIND[args.missing];
        if (gapKind && gapKind !== args.kind) throw new Error(`missing "${args.missing}" only applies to kind "${gapKind}"`);
        if (args.partner_category && args.kind !== "property") throw new Error('partner_category only applies to kind "property"');
        const all = (await api.listEntities(args.kind)).filter(
          (e) => (!args.missing || isMissing(e, args.missing)) && (!args.partner_category || e.kind?.key === args.partner_category),
        );
        return json({ total: all.length, offset: args.offset, items: all.slice(args.offset, args.offset + args.limit).map(entityRow) });
      }),
  );

  server.registerTool(
    "create_entity",
    {
      title: "Create a game/IP or company (admin)",
      description: "Creates a property (game/IP: slug, kind = partner_category key, name {ko,en,original?}, aliases) or a company (slug, name, aliases, country). Check find_entity first to avoid duplicates.",
      inputSchema: { kind: Kind, data: z.union([PropertyInput, CompanyInput]) },
      annotations: write,
    },
    (args, ctx) => logged("create_entity", args, ctx, async () => json(await api.createEntity(args.kind, args.data))),
  );

  server.registerTool(
    "update_entity",
    {
      title: "Update a game/IP or company (admin)",
      description: "Renames or edits a property or company (fields given replace stored ones). A slug change keeps the old slug as a redirect; collabs referencing it are updated.",
      // Strict, or the all-optional PropertyPatch matches a company patch first and strips `country`.
      inputSchema: { kind: Kind, id: EntityId, patch: z.union([PropertyPatch.strict(), CompanyPatch.strict()]) },
      annotations: { ...write, idempotentHint: true },
    },
    (args, ctx) => logged("update_entity", args, ctx, async () => json(await api.updateEntity(args.kind, args.id, args.patch))),
  );

  server.registerTool(
    "merge_entities",
    {
      title: "Merge duplicate games/IPs or companies (admin)",
      description: "Merges `source_id` into `target_id`: collabs move to the target, the source's names become aliases and its slug redirects to the target. The source entry is deleted.",
      inputSchema: { kind: Kind, target_id: EntityId, source_id: EntityId },
      annotations: { ...write, destructiveHint: true },
    },
    (args, ctx) => logged("merge_entities", args, ctx, async () => json(await api.mergeEntities(args.kind, args.target_id, args.source_id))),
  );
}
