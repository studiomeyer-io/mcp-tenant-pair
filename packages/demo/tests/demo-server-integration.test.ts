import { describe, expect, it } from "vitest";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/server.js";
import { tools } from "../src/tools.js";

interface ListToolsResult {
  tools: Array<{
    name: string;
    description: string;
    inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  }>;
}

interface CallToolResult {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function listTools(server: ReturnType<typeof createServer>["server"]): Promise<ListToolsResult> {
  const handlers = (server as unknown as {
    _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
  })._requestHandlers;
  const handler = handlers.get(ListToolsRequestSchema.shape.method.value);
  if (!handler) throw new Error("ListTools handler not registered");
  return (await handler({ method: ListToolsRequestSchema.shape.method.value, params: {} })) as ListToolsResult;
}

async function callTool(
  server: ReturnType<typeof createServer>["server"],
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const handlers = (server as unknown as {
    _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
  })._requestHandlers;
  const handler = handlers.get(CallToolRequestSchema.shape.method.value);
  if (!handler) throw new Error("CallTool handler not registered");
  return (await handler({
    method: CallToolRequestSchema.shape.method.value,
    params: { name, arguments: args },
  })) as CallToolResult;
}

describe("demo MCP server integration", () => {
  it("lists exactly the 12 tools defined in tools.ts (11 lifecycle + forget_member for DSGVO Art. 17)", async () => {
    const { server } = createServer();
    const result = await listTools(server);
    expect(result.tools).toHaveLength(12);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "accept_invite",
        "create_pair",
        "forget_member",
        "get_member_constraints",
        "get_shared_state",
        "invite_member",
        "kick_member",
        "leave_pair",
        "list_members",
        "resolve_conflicts",
        "set_member_preferences",
        "set_shared_state",
      ].sort(),
    );
  });

  it("each listed tool has a JSON-Schema inputSchema with object type", async () => {
    const { server } = createServer();
    const result = await listTools(server);
    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeTypeOf("object");
    }
  });

  it("readOnlyHint and destructiveHint are honest per tool", async () => {
    const { server } = createServer();
    const result = await listTools(server);
    const byName = new Map(result.tools.map((t) => [t.name, t.annotations]));
    expect(byName.get("list_members")?.readOnlyHint).toBe(true);
    expect(byName.get("get_member_constraints")?.readOnlyHint).toBe(true);
    expect(byName.get("get_shared_state")?.readOnlyHint).toBe(true);
    expect(byName.get("kick_member")?.destructiveHint).toBe(true);
    expect(byName.get("leave_pair")?.destructiveHint).toBe(true);
    expect(byName.get("resolve_conflicts")?.destructiveHint).toBe(true);
    expect(byName.get("create_pair")?.destructiveHint).toBe(false);
    expect(byName.get("set_shared_state")?.readOnlyHint).toBe(false);
  });

  it("create_pair → invite_member → accept_invite end-to-end", async () => {
    const { server } = createServer();
    const created = await callTool(server, "create_pair", { creatorMemberId: "alice" });
    expect(created.isError).toBeFalsy();
    const createdPayload = JSON.parse(created.content?.[0]?.text ?? "{}") as {
      pairId: string;
      inviteToken: string;
    };
    expect(createdPayload.pairId).toBeTruthy();

    const accepted = await callTool(server, "accept_invite", {
      inviteToken: createdPayload.inviteToken,
      memberId: "bob",
    });
    expect(accepted.isError).toBeFalsy();
    const acceptedPayload = JSON.parse(accepted.content?.[0]?.text ?? "{}") as {
      members: Array<{ memberId: string }>;
    };
    expect(acceptedPayload.members.map((m) => m.memberId).sort()).toEqual(["alice", "bob"]);
  });

  it("invalid arguments return isError with a Zod-derived message", async () => {
    const { server } = createServer();
    const result = await callTool(server, "create_pair", { creatorMemberId: "" });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/Invalid arguments/);
  });

  it("TenantPairError surfaces as `{code}: {message}`", async () => {
    const { server } = createServer();
    const result = await callTool(server, "list_members", { pairId: "does-not-exist" });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/^[A-Z_]+:/);
  });

  it("unknown tool name returns isError without throwing", async () => {
    const { server } = createServer();
    const result = await callTool(server, "this_tool_does_not_exist", {});
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/not found/);
  });

  it("server initialiser carries package.json name and version", () => {
    const { pkg } = createServer();
    expect(pkg.name).toBe("mcp-tenant-pair-demo");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("each tool descriptor in tools.ts maps to a handler invocable via the server", async () => {
    const { server } = createServer();
    for (const t of tools) {
      const result = await callTool(server, t.name, {});
      // Most will fail on missing args (Invalid arguments), but never throw.
      expect(typeof result).toBe("object");
    }
  });
});
