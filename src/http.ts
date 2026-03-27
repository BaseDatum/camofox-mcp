#!/usr/bin/env node

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import rateLimit from "express-rate-limit";
import { fileURLToPath } from "node:url";

import { CamofoxClient } from "./client.js";
import { loadConfig } from "./config.js";
import { syncUserCookies } from "./cookie-sync.js";
import { createServer } from "./server.js";
import { getAllTrackedTabs, removeTrackedTab, setupCleanup } from "./state.js";
import type { Config } from "./types.js";
import { McpAuthValidator, AuthError } from "shared-bao-auth";

let httpServer: ReturnType<ReturnType<typeof createMcpExpressApp>["listen"]> | null = null;
let cleanupClient: CamofoxClient | null = null;
let cleanupInitialized = false;
let httpSignalHandlersRegistered = false;

function ensureHttpSignalHandlers(): void {
  if (httpSignalHandlersRegistered) {
    return;
  }

  httpSignalHandlersRegistered = true;

  const closeHttpServer = () => {
    if (httpServer) {
      httpServer.close();
      httpServer = null;
    }
  };

  process.once("SIGINT", closeHttpServer);
  process.once("SIGTERM", closeHttpServer);
}

function ensureCleanup(config: Config): void {
  cleanupClient = new CamofoxClient(config);

  if (cleanupInitialized) {
    return;
  }

  cleanupInitialized = true;
  setupCleanup(async (tabId, userId) => {
    if (!cleanupClient) {
      return;
    }
    await cleanupClient.closeTab(tabId, userId);
    removeTrackedTab(tabId);
  });
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === process.argv[1];
}

export async function startHttpServer(config: Config = loadConfig()): Promise<void> {
  ensureHttpSignalHandlers();
  ensureCleanup(config);

  const app = createMcpExpressApp({ host: config.httpHost });

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: config.httpRateLimit,
    standardHeaders: true,
    legacyHeaders: false
  });

  app.use("/mcp", limiter);

  // Module-level auth validator — initialized lazily.
  let mcpValidator: McpAuthValidator | null = null;
  function getValidator(): McpAuthValidator {
    if (!mcpValidator) mcpValidator = new McpAuthValidator();
    return mcpValidator;
  }

  app.post("/mcp", async (req: any, res: any) => {
    try {
      // Authenticate via OpenBao Vault token.
      // The user_id is extracted from the token's entity alias (bound to the
      // pod's per-user ServiceAccount), preventing user impersonation.
      let trustedUserId: string | undefined;
      try {
        trustedUserId = await getValidator().extractUserId(
          req.headers["authorization"] as string | undefined,
        );
      } catch (err) {
        const msg = err instanceof AuthError ? err.message : "Authentication failed";
        res.status(401).json({ error: msg });
        return;
      }

      const perRequestConfig = trustedUserId
        ? { ...config, trustedUserId, defaultUserId: trustedUserId }
        : config;

      // Auto-inject stored browser cookies into the user's camofox session.
      if (trustedUserId && perRequestConfig.dialogueApiUrl) {
        const cookieClient = new CamofoxClient(perRequestConfig);
        syncUserCookies(trustedUserId, cookieClient, perRequestConfig.dialogueApiUrl).catch(
          (err) => console.error("[camofox-mcp] cookie-sync background error:", err)
        );
      }

      const { server } = createServer(perRequestConfig);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      res.on("close", () => {
        transport.close().catch((err) =>
          console.error("[camofox-mcp] transport close error:", err)
        );
        server.close().catch((err) => console.error("[camofox-mcp] server close error:", err));
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[camofox-mcp] HTTP request error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });

  app.delete("/mcp", (_req: any, res: any) => {
    res.status(405).json({ error: "Method not allowed in stateless HTTP mode" });
  });

  app.get("/mcp", (_req: any, res: any) => {
    res.status(405).json({ error: "Method not allowed in stateless HTTP mode" });
  });

  app.get("/health", (_req: any, res: any) => {
    res.status(200).json({ ok: true });
  });

  if (!config.apiKey) {
    console.error(
      "[camofox-mcp] ⚠️  CAMOFOX_API_KEY not set in HTTP mode — if your CamoFox server requires auth, requests will fail."
    );
  }

  await new Promise<void>((resolve, reject) => {
    httpServer = app.listen(config.httpPort, config.httpHost, () => {
      console.error(
        `[camofox-mcp] HTTP transport listening on http://${config.httpHost}:${config.httpPort}/mcp (rate limit: ${config.httpRateLimit} req/min)`
      );
      resolve();
    });

    httpServer.on("error", reject);
  });
}

if (isDirectExecution()) {
  const config = loadConfig();

  startHttpServer(config).catch(async (error) => {
    const openTabs = getAllTrackedTabs();
    const client = new CamofoxClient(config);

    await Promise.allSettled(
      openTabs.map(async (tab) => {
        try {
          await client.closeTab(tab.tabId, tab.userId);
          removeTrackedTab(tab.tabId);
        } catch {
          return;
        }
      })
    );

    process.stderr.write(`${error instanceof Error ? error.message : "Unknown startup error"}\n`);
    process.exit(1);
  });
}
