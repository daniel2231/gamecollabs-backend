import express, { type Express } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { Config } from "./config.js";
import { ApiClient } from "./apiClient.js";
import { createMcpServer } from "./tools.js";
import { GitHubOAuthProvider, SCOPE, type GitHubLogin } from "./oauth/provider.js";
import { logger } from "./logger.js";

export function createApp(cfg: Config, deps: { api?: ApiClient; githubLogin?: GitHubLogin } = {}): Express {
  const api = deps.api ?? new ApiClient(cfg);
  const provider = new GitHubOAuthProvider(cfg, deps.githubLogin);
  const publicUrl = new URL(cfg.PUBLIC_URL);
  const mcpUrl = new URL("/mcp", publicUrl);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // OAuth 2.1 endpoints: metadata, /authorize, /token, /register (+ protected resource metadata).
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      resourceServerUrl: mcpUrl,
      scopesSupported: [SCOPE],
      resourceName: "Game Collab Tracker ingest",
    }),
  );
  app.get(provider.callbackPath, provider.githubCallback);

  const auth = requireBearerAuth({
    verifier: provider,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  // Stateless Streamable HTTP: a new server + transport per request.
  app.post("/mcp", auth, express.json({ limit: "1mb" }), async (req, res) => {
    const server = createMcpServer(api);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, "mcp request failed");
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  });
  const methodNotAllowed: express.RequestHandler = (_req, res) => {
    res.status(405).set("allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}
