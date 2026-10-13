import type { FollowUpReport, IngestCandidate, IngestResponse } from "@gamecollabs/schema";
import type { Config } from "./config.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API responded ${status}`);
  }
}

/** Thin client for the internal Express API. The MCP server never touches MongoDB. */
export class ApiClient {
  constructor(private readonly cfg: Pick<Config, "API_URL" | "INTERNAL_API_KEY" | "ADMIN_API_KEY">) {}

  get hasAdmin(): boolean {
    return !!this.cfg.ADMIN_API_KEY;
  }

  private async call<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, opts: { admin?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
    const key = opts.admin ? this.cfg.ADMIN_API_KEY : this.cfg.INTERNAL_API_KEY;
    if (!key) throw new Error("admin tools are not configured (ADMIN_API_KEY)");
    const res = await fetch(new URL(path, this.cfg.API_URL), {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}), ...opts.headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    const json = (await res.json().catch(() => null)) as { data?: T } | null;
    if (!res.ok) throw new ApiError(res.status, json);
    return json!.data as T;
  }

  /* -------- admin (ADMIN_API_KEY) -------- */

  private admin<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, headers?: Record<string, string>) {
    return this.call<T>(method, path, body, { admin: true, headers });
  }

  listCollabs(params: Record<string, string | number | undefined>) {
    const qs = new URLSearchParams(Object.entries(params).flatMap(([k, v]): [string, string][] => (v === undefined || v === "" ? [] : [[k, String(v)]])));
    return this.admin<AdminCollab[]>("GET", `/v1/admin/collabs?${qs}`);
  }

  getCollab(idOrSlug: string) {
    return this.admin<AdminCollab>("GET", `/v1/admin/collabs/${encodeURIComponent(idOrSlug)}`);
  }

  collabDuplicates(idOrSlug: string) {
    return this.admin<unknown[]>("GET", `/v1/admin/collabs/${encodeURIComponent(idOrSlug)}/duplicates`);
  }

  collabRevisions(idOrSlug: string) {
    return this.admin<unknown[]>("GET", `/v1/admin/collabs/${encodeURIComponent(idOrSlug)}/revisions`);
  }

  updateCollab(idOrSlug: string, rev: number, patch: unknown) {
    return this.admin<AdminCollab>("PATCH", `/v1/admin/collabs/${encodeURIComponent(idOrSlug)}`, patch, { "if-match": String(rev) });
  }

  transitionCollab(idOrSlug: string, body: { action: string; reason?: string }, rev?: number) {
    return this.admin<AdminCollab>("POST", `/v1/admin/collabs/${encodeURIComponent(idOrSlug)}/transition`, body, rev ? { "if-match": String(rev) } : undefined);
  }

  mirrorCover(idOrSlug: string) {
    return this.admin<unknown>("POST", `/v1/admin/collabs/${encodeURIComponent(idOrSlug)}/cover/mirror`);
  }

  followUpQueue(view: string, limit: number) {
    return this.admin<FollowUpRow[]>("GET", `/v1/admin/followups?${new URLSearchParams({ view, limit: String(limit) })}`);
  }

  resolveFollowUp(idOrSlug: string, action: "apply" | "dismiss", rev?: number) {
    return this.admin<AdminCollab>("POST", `/v1/admin/collabs/${encodeURIComponent(idOrSlug)}/followup`, { action }, rev ? { "if-match": String(rev) } : undefined);
  }

  searchEntities(kind: EntityKind, q: string) {
    return this.admin<unknown[]>("GET", `/v1/admin/${entityPath(kind)}?${new URLSearchParams({ q, limit: "20" })}`);
  }

  createEntity(kind: EntityKind, body: unknown) {
    return this.admin<unknown>("POST", `/v1/admin/${entityPath(kind)}`, body);
  }

  updateEntity(kind: EntityKind, id: string, patch: unknown) {
    return this.admin<unknown>("PATCH", `/v1/admin/${entityPath(kind)}/${encodeURIComponent(id)}`, patch);
  }

  mergeEntities(kind: EntityKind, targetId: string, sourceId: string) {
    return this.admin<unknown>("POST", `/v1/admin/${entityPath(kind)}/${encodeURIComponent(targetId)}/merge`, { from: sourceId });
  }

  taxonomy() {
    return this.call<Record<string, TaxonomyNode[]>>("GET", "/v1/taxonomies?locale=en");
  }

  lookupCollabs(params: { q?: string; from?: string; to?: string; limit?: number }) {
    const qs = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]): [string, string] => [k, String(v)]),
    );
    return this.call<unknown[]>("GET", `/v1/ingest/lookup/collabs?${qs}`);
  }

  lookupEntities(name: string) {
    return this.call<unknown[]>("GET", `/v1/ingest/lookup/entities?${new URLSearchParams({ name })}`);
  }

  dueFollowUps(limit: number) {
    return this.call<FollowUpRow[]>("GET", `/v1/ingest/followups?limit=${limit}`);
  }

  reportFollowUp(idOrSlug: string, report: FollowUpReport) {
    return this.call<unknown>("POST", `/v1/ingest/followups/${encodeURIComponent(idOrSlug)}`, report);
  }

  submitCandidates(body: { runId: string; client: string; model?: string; candidates: IngestCandidate[] }) {
    return this.call<IngestResponse>("POST", "/v1/ingest/candidates", body);
  }
}

export type TaxonomyNode = { key: string; label: string; labels: { ko: string; en: string }; children: TaxonomyNode[] };

/** A collab in the re-check queue, as `/followups` returns it. */
export type FollowUpRow = { id: string; slug: string; status: string; rev: number; reason: string | null } & Record<string, unknown>;

export type EntityKind = "property" | "company";
const entityPath = (kind: EntityKind) => (kind === "property" ? "properties" : "companies");

/** The stored collab document as the admin API returns it (only fields the tools read). */
export type AdminCollab = {
  id: string;
  slug: string;
  status: string;
  rev: number;
  i18n: { ko: { title: string }; en: { title: string } };
  parties: { propertyId: string | null; slug: string | null; role: string; name: { ko: string | null; en: string | null } | null }[];
  period: { start: string | null; end: string | null; endKind: string };
  sources: { url: string }[];
  origin: { type: string; runId: string | null };
  duplicateCount?: number;
  updatedAt: string;
} & Record<string, unknown>;
