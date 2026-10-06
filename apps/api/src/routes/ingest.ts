import { Router } from "express";
import { z } from "zod";
import { IngestRequest, IsoDate } from "@gamecollabs/schema";
import { principal, requireScope } from "../auth/principal.js";
import { HttpError, parse } from "../lib/errors.js";
import { ingestCandidates, lookupCollabs, lookupEntities } from "../services/ingest.js";

/**
 * Collector API (MCP server, agents, OpenAI scheduler). Responses carry only
 * what a collector needs: no reviewer data, no internal notes.
 */
export const ingestRouter: Router = Router();

ingestRouter.get("/lookup/entities", requireScope("ingest:read"), async (req, res) => {
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(200) }), req.query);
  res.json({ data: await lookupEntities(name) });
});

ingestRouter.get("/lookup/collabs", requireScope("ingest:read"), async (req, res) => {
  const q = parse(
    z.object({
      q: z.string().trim().max(200).optional(),
      from: IsoDate.optional(),
      to: IsoDate.optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }),
    req.query,
  );
  res.json({ data: await lookupCollabs(q) });
});

/**
 * Channels share one route shape so other automations can be added later
 * (`POST /v1/ingest/:channel`). `candidates` is the collab channel.
 */
const CHANNELS = {
  candidates: ingestCandidates,
} as const;

ingestRouter.post("/:channel", requireScope("ingest:write"), async (req, res) => {
  const channel = String(req.params.channel);
  const handler = Object.hasOwn(CHANNELS, channel) ? CHANNELS[channel as keyof typeof CHANNELS] : undefined;
  if (!handler) throw new HttpError(404, "unknown_channel", `no ingest channel ${channel}`);
  const body = parse(IngestRequest, req.body);
  res.json({ data: await handler(body, principal(req), channel) });
});
