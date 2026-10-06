import type { IngestCandidate, IngestResponse } from "@gamecollabs/schema";
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
  constructor(private readonly cfg: Pick<Config, "API_URL" | "INTERNAL_API_KEY">) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(path, this.cfg.API_URL), {
      method,
      headers: { authorization: `Bearer ${this.cfg.INTERNAL_API_KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    const json = (await res.json().catch(() => null)) as { data?: T } | null;
    if (!res.ok) throw new ApiError(res.status, json);
    return json!.data as T;
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

  submitCandidates(body: { runId: string; client: string; model?: string; candidates: IngestCandidate[] }) {
    return this.call<IngestResponse>("POST", "/v1/ingest/candidates", body);
  }
}

export type TaxonomyNode = { key: string; label: string; labels: { ko: string; en: string }; children: TaxonomyNode[] };
