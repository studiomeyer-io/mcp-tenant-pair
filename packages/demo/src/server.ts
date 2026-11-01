#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SqliteTenantStore, TenantPair, TenantPairError } from "mcp-tenant-pair";
import { tools } from "./tools.js";

interface PackageJsonShape {
  name: string;
  version: string;
}

function readPackageJson(): PackageJsonShape {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/server.js -> ../package.json (one level up from dist)
  const pkgPath = join(here, "..", "package.json");
  return JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJsonShape;
}

function zodToJsonSchema(shape: z.ZodRawShape): Record<string, unknown> {
  return z.toJSONSchema(z.strictObject(shape), { target: "draft-07", io: "input" });
}

export interface CreateServerOptions {
  storePath?: string;
}

export function createServer(options: CreateServerOptions = {}): {
  server: Server;
  pair: TenantPair;
  pkg: PackageJsonShape;
} {
  const pkg = readPackageJson();
  const store = new SqliteTenantStore({ path: options.storePath ?? ":memory:" });
  const pair = new TenantPair({ store });

  const server = new Server(
    { name: pkg.name, version: pkg.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Tool ${name} not found` }],
      };
    }
    try {
      const result = await tool.handler((args ?? {}) as never, pair);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Invalid arguments: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            },
          ],
        };
      }
      if (err instanceof TenantPairError) {
        return {
          isError: true,
          content: [{ type: "text", text: `${err.code}: ${err.message}` }],
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Internal error: ${message}` }],
      };
    }
  });

  return { server, pair, pkg };
}

async function main(): Promise<void> {
  const storePath = process.env.MCP_TENANT_PAIR_DB ?? ":memory:";
  const { server } = createServer({ storePath });
  const transport = new StdioServerTransport();

  const shutdown = async (): Promise<void> => {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await server.connect(transport);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`mcp-tenant-pair-demo fatal: ${message}\n`);
    process.exit(1);
  });
}
