import { Router, type Request } from "express";
import { z } from "zod";
import {
  AdminCollabListQuery,
  CollabInput,
  CollabPatch,
  CompanyInput,
  CompanyPatch,
  EntitySearchQuery,
  Locale,
  MergeInput,
  ObjectIdString,
  PropertyInput,
  PropertyPatch,
  TaxonomyTermInput,
  TaxonomyTermPatch,
  TransitionInput,
} from "@gamecollabs/schema";
import { principal, requireScope } from "../auth/principal.js";
import { badRequest, notFound, parse } from "../lib/errors.js";
import { IngestRun, Submission } from "../models/support.js";
import {
  createDraft,
  duplicatesOf,
  getById,
  listAdmin,
  patchCollab,
  revisions,
  transition,
} from "../services/collabs.js";
import {
  createCompany,
  createProperty,
  mergeEntities,
  searchEntities,
  updateEntity,
  type EntityType,
} from "../services/entities.js";
import { lookupCollabs } from "../services/ingest.js";
import { mirrorCover } from "../services/media.js";
import { collabAdmin, entitySummary } from "../services/serialize.js";
import { createTerm, taxonomy, updateTerm } from "../services/taxonomy.js";

export const adminRouter: Router = Router();

const id = (req: Request) => String(req.params.id);

/** `If-Match: 3` or `If-Match: "3"` → 3. */
function ifMatch(req: Request): number | null {
  const raw = req.get("if-match");
  if (!raw) return null;
  const n = Number(raw.replace(/^W\//, "").replace(/"/g, "").trim());
  if (!Number.isInteger(n) || n < 1) throw badRequest("invalid_if_match", "If-Match must be the collab rev");
  return n;
}

/* ---------------------------------------------------------------- collabs */

adminRouter.get("/collabs", requireScope("collabs:read_internal"), async (req, res) => {
  const page = await listAdmin(parse(AdminCollabListQuery, req.query));
  res.json({ data: page.items.map((d) => collabAdmin(d)), meta: { nextCursor: page.nextCursor } });
});

/** Creates a draft (always `draft`) and returns possible duplicates. */
adminRouter.post("/collabs", requireScope("collabs:write"), async (req, res) => {
  const { doc, duplicates } = await createDraft(parse(CollabInput, req.body), principal(req));
  res.status(201).setHeader("etag", `"${doc.rev}"`).json({ data: collabAdmin(doc.toObject()), meta: { duplicates } });
});

adminRouter.get("/collabs/:id", requireScope("collabs:read_internal"), async (req, res) => {
  const doc = await getById(id(req));
  res.setHeader("etag", `"${doc.rev}"`).json({ data: collabAdmin(doc.toObject()) });
});

adminRouter.patch("/collabs/:id", requireScope("collabs:write"), async (req, res) => {
  const doc = await patchCollab(id(req), parse(CollabPatch, req.body), ifMatch(req), principal(req));
  res.setHeader("etag", `"${doc.rev}"`).json({ data: collabAdmin(doc.toObject()) });
});

adminRouter.post("/collabs/:id/transition", requireScope("collabs:submit"), async (req, res) => {
  const doc = await transition(id(req), parse(TransitionInput, req.body), ifMatch(req), principal(req));
  res.setHeader("etag", `"${doc.rev}"`).json({ data: collabAdmin(doc.toObject()) });
});

adminRouter.get("/collabs/:id/revisions", requireScope("collabs:read_internal"), async (req, res) => {
  res.json({ data: await revisions(id(req)) });
});

adminRouter.get("/collabs/:id/duplicates", requireScope("collabs:read_internal"), async (req, res) => {
  res.json({ data: await duplicatesOf(id(req)) });
});

adminRouter.post("/collabs/:id/cover/mirror", requireScope("collabs:write"), async (req, res) => {
  const doc = await getById(id(req));
  const result = await mirrorCover(doc);
  res.json({ data: { result, collab: collabAdmin((await getById(id(req))).toObject()) } });
});

/* ---------------------------------------------------------------- entities */

const AdminLocale = z.object({ locale: Locale.default("ko") });

function entityRoutes(type: EntityType, path: string, input: z.ZodType, patch: z.ZodType) {
  adminRouter.get(`/${path}`, requireScope("collabs:read_internal"), async (req, res) => {
    const q = parse(EntitySearchQuery, req.query);
    const { locale } = parse(AdminLocale, req.query);
    const tax = await taxonomy();
    const hits = await searchEntities(type, q.q, q.limit);
    res.json({ data: hits.map((h) => ({ ...entitySummary(h.doc, locale, tax), exact: h.exact })) });
  });
  adminRouter.post(`/${path}`, requireScope("entities:write"), async (req, res) => {
    const body = parse(input, req.body);
    const doc = type === "property" ? await createProperty(body as PropertyInput) : await createCompany(body as CompanyInput);
    res.status(201).json({ data: doc.toObject() });
  });
  adminRouter.patch(`/${path}/:id`, requireScope("entities:write"), async (req, res) => {
    const doc = await updateEntity(type, id(req), parse(patch, req.body) as PropertyPatch | CompanyPatch);
    res.json({ data: doc.toObject() });
  });
  adminRouter.post(`/${path}/:id/merge`, requireScope("entities:merge"), async (req, res) => {
    const { from } = parse(MergeInput, req.body);
    const doc = await mergeEntities(type, id(req), from, principal(req));
    res.json({ data: doc.toObject() });
  });
}
entityRoutes("property", "properties", PropertyInput, PropertyPatch);
entityRoutes("company", "companies", CompanyInput, CompanyPatch);

/** Existing entities and duplicate collab candidates for a name (autocomplete, dedupe). */
adminRouter.get("/match", requireScope("ingest:read"), async (req, res) => {
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(200) }), req.query);
  const { locale } = parse(AdminLocale, req.query);
  const tax = await taxonomy();
  const [properties, companies, collabs] = await Promise.all([
    searchEntities("property", name, 10),
    searchEntities("company", name, 10),
    lookupCollabs({ q: name, limit: 10 }),
  ]);
  res.json({
    data: {
      properties: properties.map((h) => ({ ...entitySummary(h.doc, locale, tax), exact: h.exact })),
      companies: companies.map((h) => ({ ...entitySummary(h.doc, locale, tax), exact: h.exact })),
      collabs,
    },
  });
});

/* ---------------------------------------------------------------- taxonomy */

adminRouter.get("/taxonomies", requireScope("collabs:read_internal"), async (_req, res) => {
  res.json({ data: (await taxonomy()).terms(undefined, { includeDeprecated: true }) });
});

adminRouter.post("/taxonomies", requireScope("taxonomy:write"), async (req, res) => {
  res.status(201).json({ data: await createTerm(parse(TaxonomyTermInput, req.body)) });
});

adminRouter.patch("/taxonomies/:key", requireScope("taxonomy:write"), async (req, res) => {
  const { term, parentChanged } = await updateTerm(String(req.params.key), parse(TaxonomyTermPatch, req.body));
  res.json({ data: term, meta: parentChanged ? { note: "run the reindex-facets job to refresh collab facets" } : {} });
});

/* ---------------------------------------------------------------- operations */

const PageQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

adminRouter.get("/ingest-runs", requireScope("ops:read"), async (req, res) => {
  const { limit } = parse(PageQuery, req.query);
  res.json({ data: await IngestRun.find().sort({ createdAt: -1 }).limit(limit).lean() });
});

adminRouter.get("/submissions", requireScope("ops:read"), async (req, res) => {
  const { limit } = parse(PageQuery, req.query);
  const { status } = parse(z.object({ status: z.enum(["new", "accepted", "dismissed"]).optional() }), req.query);
  res.json({ data: await Submission.find(status ? { status } : {}).sort({ createdAt: -1 }).limit(limit).lean() });
});

adminRouter.patch("/submissions/:id", requireScope("collabs:submit"), async (req, res) => {
  const body = parse(z.object({ status: z.enum(["new", "accepted", "dismissed"]), collabId: z.string().regex(/^[a-f0-9]{24}$/).optional() }), req.body);
  const { id } = parse(z.object({ id: ObjectIdString }), req.params);
  const doc = await Submission.findByIdAndUpdate(id, body, { returnDocument: "after" }).lean();
  if (!doc) throw notFound("submission");
  res.json({ data: doc });
});
