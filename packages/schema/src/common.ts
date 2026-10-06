import { z } from "zod";

export const LOCALES = ["ko", "en"] as const;
export const Locale = z.enum(LOCALES);
export type Locale = z.infer<typeof Locale>;

export const ObjectIdString = z.string().regex(/^[a-f0-9]{24}$/i, "invalid ObjectId");

export const Slug = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase kebab-case");

/** `YYYY-MM-DD` (calendar date, interpreted as UTC midnight). */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** `YYYY-MM-DD` or `YYYY-MM` (month precision). */
export const IsoDateOrMonth = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, "expected YYYY-MM-DD or YYYY-MM");

export const HttpUrl = z.url({ protocol: /^https?$/ }).max(2048);

const trimmed = (max: number) => z.string().trim().min(1).max(max);

/** Names of a property or company in each language plus the original-script name. */
export const EntityName = z.object({
  ko: trimmed(200).nullish(),
  en: trimmed(200).nullish(),
  original: trimmed(200).nullish(),
});
export type EntityName = z.infer<typeof EntityName>;

export const LocalizedText = (max: number) =>
  z.object({
    ko: z.string().trim().max(max).nullish(),
    en: z.string().trim().max(max).nullish(),
  });

/** Standard error envelope returned by the API. */
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string().optional(),
    fields: z.record(z.string(), z.array(z.string())).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/** Turns a ZodError into the `fields` map of the error envelope. */
export function zodFieldErrors(error: z.ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join(".") : "_";
    (fields[key] ??= []).push(issue.message);
  }
  return fields;
}

/** Accepts `a,b` or repeated query params and returns a string array. */
export const CsvList = z
  .union([z.string(), z.array(z.string())])
  .transform((v) =>
    (Array.isArray(v) ? v : [v])
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter(Boolean),
  );
