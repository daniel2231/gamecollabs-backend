import { Router } from "express";
import mongoose from "mongoose";
import { dbReady } from "../db.js";

/** Unauthenticated liveness/readiness for uptime checks and container platforms. */
export const healthRouter: Router = Router();

healthRouter.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

healthRouter.get("/readyz", async (_req, res) => {
  try {
    if (!dbReady()) throw new Error("mongodb not connected");
    await mongoose.connection.db!.admin().ping();
    res.json({ status: "ready" });
  } catch (err) {
    res.status(503).json({ status: "unavailable", error: err instanceof Error ? err.message : String(err) });
  }
});
