import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { config } from "../config.js";
import { connectDb, disconnectDb } from "../db.js";
import { generateToken, hashToken } from "../auth/principal.js";
import { ROLES, User, type Role } from "../models/support.js";
import { TaxonomyTerm } from "../models/taxonomyTerm.js";
import { seedTaxonomy } from "../seed/run.js";
import { JOBS, runJob } from "../jobs/index.js";
import { migrateMdx } from "./migrate.js";
import { Collab } from "../models/collab.js";
import { Company, Property } from "../models/entities.js";
import { IngestRun, Revision, Submission } from "../models/support.js";

const HELP = `Usage: pnpm --filter @gamecollabs/api cli <command> [options]

Commands:
  sync-indexes                         Create/update MongoDB indexes from the models
  seed-taxonomy [--update]             Insert the initial taxonomy (--update overwrites labels/legacy values)
  create-user --github <login> --role <admin|editor> [--name <name>]
  create-token --name <name> --role <agent|ingest>   Prints a new API token once
  revoke-token --name <name>
  migrate-mdx --dir <content/collab-tracker> [--dry-run] [--allow-unmapped]
              [--fields fields.json] [--mapping mapping.json] [--entity-map entities.json] [--report report.json]
              [--image-base-url https://<old blog domain>]
  job <name>                           Run a periodic job now (${Object.keys(JOBS).join(", ")})
`;

async function readJson<T>(path: string | undefined): Promise<T | undefined> {
  return path ? (JSON.parse(await readFile(path, "utf8")) as T) : undefined;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      github: { type: "string" },
      role: { type: "string" },
      name: { type: "string" },
      update: { type: "boolean", default: false },
      dir: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "allow-unmapped": { type: "boolean", default: false },
      fields: { type: "string" },
      mapping: { type: "string" },
      "entity-map": { type: "string" },
      report: { type: "string" },
      "image-base-url": { type: "string" },
    },
  });
  if (!command || command === "help") {
    console.log(HELP);
    return;
  }

  await connectDb(config().MONGODB_URI);
  try {
    switch (command) {
      case "sync-indexes": {
        for (const model of [Collab, Property, Company, TaxonomyTerm, User, Revision, Submission, IngestRun]) await model.syncIndexes();
        console.log("indexes synced");
        break;
      }
      case "seed-taxonomy":
        console.log(await seedTaxonomy(values.update));
        break;
      case "create-user": {
        const role = values.role as Role;
        if (!values.github || !["admin", "editor"].includes(role)) throw new Error("--github and --role admin|editor are required");
        const user = await User.findOneAndUpdate(
          { githubLogin: values.github.toLowerCase() },
          { kind: "human", githubLogin: values.github.toLowerCase(), name: values.name ?? values.github, role, active: true },
          { upsert: true, returnDocument: "after" },
        );
        console.log(`user ${user.githubLogin} (${user.role}) ready`);
        break;
      }
      case "create-token": {
        const role = values.role as Role;
        if (!values.name || !["agent", "ingest"].includes(role) || !ROLES.includes(role)) throw new Error("--name and --role agent|ingest are required");
        if (await User.exists({ kind: "token", name: values.name, active: true })) throw new Error(`active token ${values.name} exists; revoke it first`);
        const token = generateToken();
        await User.create({ kind: "token", name: values.name, role, tokenHash: hashToken(token), tokenPrefix: token.slice(0, 10) });
        console.log(`token for ${values.name} (${role}) — shown once:\n${token}`);
        break;
      }
      case "revoke-token": {
        const res = await User.updateMany({ kind: "token", name: values.name, active: true }, { active: false, $unset: { tokenHash: 1 } });
        console.log(`revoked ${res.modifiedCount} token(s)`);
        break;
      }
      case "migrate-mdx": {
        if (!values.dir) throw new Error("--dir is required");
        const result = await migrateMdx({
          dir: values.dir,
          dryRun: values["dry-run"],
          allowUnmapped: values["allow-unmapped"],
          fields: await readJson(values.fields),
          mapping: await readJson(values.mapping),
          entityMap: await readJson(values["entity-map"]),
          reportPath: values.report,
          imageBaseUrl: values["image-base-url"],
        });
        console.log(JSON.stringify(result, null, 2));
        const missing = (result.reconciliation as { missing?: string[] } | null)?.missing?.length ?? 0;
        if (result.aborted || missing > 0) process.exitCode = 1;
        break;
      }
      case "job": {
        const name = positionals[0];
        if (!name) throw new Error(`job name required: ${Object.keys(JOBS).join(", ")}`);
        console.log(JSON.stringify(await runJob(name), null, 2));
        break;
      }
      default:
        console.log(HELP);
        process.exitCode = 1;
    }
  } finally {
    await disconnectDb();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
