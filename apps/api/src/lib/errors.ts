import type { ErrorRequestHandler, RequestHandler } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { zodFieldErrors } from "@gamecollabs/schema";
import { logger } from "../logger.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly fields?: Record<string, string[]>,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code: string, message?: string, fields?: Record<string, string[]>) =>
  new HttpError(400, code, message, fields);
export const notFound = (what = "resource") => new HttpError(404, "not_found", `${what} not found`);
export const forbidden = (message = "insufficient scope") => new HttpError(403, "forbidden", message);
export const conflict = (code: string, message?: string) => new HttpError(409, code, message);
export const validationFailed = (fields: Record<string, string[]>, message?: string) =>
  new HttpError(422, "validation_failed", message, fields);

/** Parses with a Zod schema and throws the API's `validation_failed` error. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationFailed(zodFieldErrors(result.error));
  return result.data;
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(new HttpError(404, "not_found", "route not found"));

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let error: HttpError;
  if (err instanceof HttpError) {
    error = err;
  } else if (err instanceof mongoose.Error.ValidationError) {
    const fields: Record<string, string[]> = {};
    for (const [path, e] of Object.entries(err.errors)) fields[path] = [e.message];
    error = validationFailed(fields);
  } else if (err?.code === 11000) {
    const key = Object.keys(err.keyValue ?? {})[0] ?? "key";
    error = new HttpError(409, "duplicate_key", `${key} already exists`, { [key]: ["already exists"] });
  } else if (err?.type === "entity.parse.failed") {
    error = badRequest("invalid_json", "request body is not valid JSON");
  } else if (err?.type === "entity.too.large") {
    error = new HttpError(413, "payload_too_large");
  } else {
    (req.log ?? logger).error({ err }, "unhandled error");
    error = new HttpError(500, "internal_error", "internal server error");
  }
  res.status(error.status).json({
    error: {
      code: error.code,
      ...(error.message && error.message !== error.code ? { message: error.message } : {}),
      ...(error.fields ? { fields: error.fields } : {}),
    },
  });
};
