// `pnpm --filter @gamecollabs/api job <name>`: shortcut for `cli job <name>`.
process.argv.splice(2, 0, "job");
await import("./index.js");
