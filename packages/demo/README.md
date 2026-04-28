# mcp-tenant-pair-demo

Reference Low-Level MCP server (stdio transport) exposing the 11 tenant-pair tools defined by `mcp-tenant-pair`. Use as a runnable example, an MCP-Inspector target, or a smoke-test fixture.

## Install + run

```sh
npm install -g mcp-tenant-pair-demo
mcp-tenant-pair-demo
```

Or in an MCP client config (Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "tenant-pair": {
      "command": "npx",
      "args": ["-y", "mcp-tenant-pair-demo"],
      "env": { "MCP_TENANT_PAIR_DB": "/path/to/pair.sqlite" }
    }
  }
}
```

`MCP_TENANT_PAIR_DB` defaults to `:memory:` (state is wiped between restarts). Use a real path for persistence.

## Tools

All 11 tools from the library are exposed (see [root README](../../README.md) for the matrix). Annotations:

- `readOnlyHint: true` — `list_members`, `get_member_constraints`, `get_shared_state`
- `destructiveHint: true` — `kick_member`, `leave_pair`, `resolve_conflicts`

## Error semantics

| Source                | Surface                                               |
|-----------------------|-------------------------------------------------------|
| Zod validation        | `isError: true`, content text begins `Invalid arguments:` |
| `TenantPairError`     | `isError: true`, content text is `{code}: {message}`  |
| Anything else         | `isError: true`, content text begins `Internal error:`|
| Unknown tool name     | `isError: true`, content text contains `not found`    |

## Graceful shutdown

Listens for `SIGTERM` and `SIGINT`. Closes the MCP server cleanly before `process.exit(0)`.

## Programmatic embedding

```ts
import { createServer } from "mcp-tenant-pair-demo/dist/server.js";

const { server, pair, pkg } = createServer({ storePath: ":memory:" });
// server: MCP Server instance (not yet connected to a transport)
// pair:   TenantPair backing the server
// pkg:    package.json shape (name, version)
```

## License

MIT, Copyright (c) 2026 Matthias Meyer (StudioMeyer)
