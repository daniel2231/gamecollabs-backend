import mongoose from "mongoose";
import { logger } from "./logger.js";

mongoose.set("strictQuery", true);

export async function connectDb(uri: string): Promise<typeof mongoose> {
  const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  logger.info({ db: conn.connection.name }, "mongodb connected");
  return conn;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

export function dbReady(): boolean {
  return mongoose.connection.readyState === 1;
}

/** Runs `fn` in a transaction (requires a replica set, which we always run). */
export async function withTransaction<T>(fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => fn(session));
  } finally {
    await session.endSession();
  }
}
