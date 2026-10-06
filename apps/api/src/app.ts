import express, { type Express, type RequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { authenticate } from "./auth/principal.js";
import { HttpError, errorHandler, notFoundHandler } from "./lib/errors.js";
import { adminRouter } from "./routes/admin.js";
import { healthRouter } from "./routes/health.js";
import { ingestRouter } from "./routes/ingest.js";
import { publicRouter } from "./routes/public.js";
import { submissionsRouter } from "./routes/submissions.js";

/** Runbook switch: blocks every write while data is being moved. */
const readOnlyGuard: RequestHandler = (req, _res, next) => {
  if (config().READ_ONLY_MODE && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next(new HttpError(503, "read_only", "the service is temporarily read-only"));
  }
  next();
};

export function createApp(): Express {
  const cfg = config();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", cfg.TRUST_PROXY);
  app.set("query parser", "extended");
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/healthz" } }));
  app.use(helmet());
  app.use(
    cors({
      origin: cfg.CORS_ORIGINS.length ? cfg.CORS_ORIGINS : false,
      allowedHeaders: ["authorization", "content-type", "if-match"],
      exposedHeaders: ["etag"],
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  app.use(healthRouter);

  const v1 = express.Router();
  v1.use(authenticate, readOnlyGuard);
  v1.use("/admin", adminRouter);
  v1.use("/ingest", ingestRouter);
  v1.use("/submissions", submissionsRouter);
  v1.use(publicRouter);
  app.use("/v1", v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
