<!-- studiomeyer-mcp-stack-banner:start -->
> **Part of the [StudioMeyer MCP Stack](https://studiomeyer.io)** — Built in Mallorca 🌴 · ⭐ if you use it
<!-- studiomeyer-mcp-stack-banner:end -->

# mcp-tenant-pair

Foundation library + reference MCP server for multi-user tenancy in consumer MCP servers (couples, families, small groups). Identity-separated state, bi-temporal storage, conflict-resolver interface.

**Spec:** MCP 2025-06-18
**License:** MIT
**Repo layout:** monorepo (npm workspaces)

```
packages/
  lib/        mcp-tenant-pair          (TypeScript library)
  cli/        mcp-tenant-pair-cli      (commander CLI)
  demo/       mcp-tenant-pair-demo     (reference Low-Level MCP server, stdio)
```

## A note from us

We have been building tools and systems for ourselves for the past two years. The fact that this repo is small and has few stars is not because it is new. It is because we only just decided to share what we have built. It is not a fresh experiment, it is a long story with a recent commit.

We love building things and sharing them. We do not love social media tactics, growth hacks, or chasing stars and followers. So this repo is small. The code is real, it gets used, issues get answered. Judge for yourself.

If it helps you, sharing, testing, and feedback help us. If it could be better, an issue is more useful. If you build something with it, tell us at hello@studiomeyer.io. That genuinely makes our day.

From a small studio in Palma de Mallorca.

## Why this exists

Most MCP servers today are single-user. The moment you want to share state across two or more humans (couples, families, small groups) you hit the same five sub-problems each time: pair creation, invite flow, identity-separated state, conflict resolution, voluntary leave / kick. This library solves them once, so downstream MCP servers (Pet-Platform, recipe-sharing, household, calendar) do not re-invent them.

## 5-Minute Quickstart

### Library

```ts
import { TenantPair, SqliteTenantStore, LWWResolver } from "mcp-tenant-pair";

const tp = new TenantPair({
  store: new SqliteTenantStore({ path: "./tenant-pair.sqlite" }),
  resolver: new LWWResolver(),
});

const { pairId, inviteToken } = await tp.createPair({ creatorMemberId: "alice" });
await tp.acceptInvite({ inviteToken, memberId: "bob" });

await tp.setMemberPreference(pairId, "alice", "allergy", ["nuts"]);
await tp.setSharedState(pairId, "alice", "tonight", "pizza");

const aliceConstraints = await tp.getMemberConstraints(pairId, "alice");
const shared = await tp.getSharedState(pairId);
```

### CLI

```sh
npx mcp-tenant-pair-cli pair create --member-id alice
npx mcp-tenant-pair-cli pair invite --pair-id <id> --member-id alice
npx mcp-tenant-pair-cli state set --pair-id <id> --member-id alice --key tonight --value pizza
npx mcp-tenant-pair-cli state get --pair-id <id>
```

### Demo MCP server

```sh
node packages/demo/dist/server.js
# or via stdio in your MCP client config
```

Reads `MCP_TENANT_PAIR_DB` env (default `:memory:`).

## Tools (12)

| Tool                       | readOnlyHint | destructiveHint |
|----------------------------|--------------|-----------------|
| create_pair                | false        | false           |
| invite_member              | false        | false           |
| accept_invite              | false        | false           |
| list_members               | true         | false           |
| set_member_preferences     | false        | false           |
| get_member_constraints     | true         | false           |
| get_shared_state           | true         | false           |
| set_shared_state           | false        | false           |
| resolve_conflicts          | false        | true            |
| kick_member                | false        | true            |
| leave_pair                 | false        | true            |
| forget_member              | false        | true            |

## Compatibility Matrix

| Concern              | Supported                                   |
|----------------------|---------------------------------------------|
| MCP Spec             | 2025-06-18                                  |
| Node                 | >= 20.0.0                                   |
| Storage              | SQLite (default), Postgres (peer-dep)       |
| Conflict Resolver    | LWWResolver (default), ManualResolver, custom (interface) |
| Transport            | stdio (demo), library is transport-free     |

## Storage adapters

- **SqliteTenantStore** — default, embedded, single-process. Uses `better-sqlite3` with WAL mode. Pass `{ path: "./pair.sqlite" }` or `:memory:`.
- **PostgresTenantStore** — multi-process, multi-tenant. Accepts any `pg.Pool`-shaped client (`{ query<R>(text, params): Promise<{rows: R[]}>, end?(): Promise<void> }`). `pg` is a peer dependency.

## Conflict resolution

`ConflictResolver` is an interface. Two implementations ship:

- `LWWResolver` — picks the row with the latest `validFrom`, ties broken by highest `version`. Throws on empty candidate list.
- `ManualResolver` — returns no resolutions; conflicts stay pending until a human resolves them externally.

Inject your own by implementing `{ name: string; resolve(conflicts: Conflict[]): Resolution[] }`.

## Bi-temporal model

Every overwrite of a `(pairId, namespace, key)` triple sets `valid_to` on the previous active row and inserts a new row with a fresh `valid_from`. `version` is monotonic per key. This lets you replay history (`getPairStateHistory`) and detect concurrent writes deterministically.

## Identity separation

`member_state` is per-member (only readable by that member via `get_member_constraints`).
`pair_state` is shared (all active members can read via `get_shared_state`).

Writes by a member who later leaves or is kicked stay visible in shared state.

## Security notes

- Invite tokens are `<uuid v4>.<XXXX-XXXX>` — uuid v4 (122 bits CSPRNG entropy via `node:crypto`) plus a voice-readable base32 short-code (default RNG is `node:crypto.randomInt`, injectable for tests).
- Per-pair pending-invite cap (default 25, configurable via `maxPendingInvites`).
- Owner-only kick. Owner cannot kick themselves; use leave instead.
- DSGVO Art. 17 erasure path: `forgetMember(pairId, memberId)` hard-deletes the member's `member_state` rows (allergies, dietary preferences) and nulls `display_name`. Membership trace (`left_at`) is retained for audit.
- Postgres adapter rejects schema names that don't match `/^[a-z_][a-z0-9_]{0,62}$/` at construction time (defense against SQL injection via integrator-supplied schema strings).
- `acceptInvite` is race-safe — both adapters use atomic transactions (better-sqlite3 immediate transaction; pg `BEGIN` + `SELECT ... FOR UPDATE`).
- Time is injectable (`now: () => Date`) for deterministic tests.

## Development

```sh
npm install
npm run build
npm test
```

Tests cover (76 total):
- Pair creation (8)
- Invite flow (10)
- Member preferences (8)
- Shared state (8)
- Conflict resolution (13)
- Store adapters (6)
- Demo server integration (9)
- Round-1 regression fixes (14) — SQL-injection schema-validation, TOCTOU acceptInvite race, conflict-resolved winner-marker, asOf-clock, DSGVO erasure, CSPRNG-default

## Status

Foundation build, Round 1. Reviewed (Cold-Cross-Review + MCP Factory Reviewer + Tester) — all HIGH/MEDIUM findings fixed in this round. tsc clean, 76/76 tests green.

## About StudioMeyer

[StudioMeyer](https://studiomeyer.io) is an AI and design studio based in Palma de Mallorca, working with clients worldwide. We build custom websites and AI infrastructure for small and medium businesses. Production stack on Claude Agent SDK, MCP and n8n, with Sentry, Langfuse and LangGraph for observability and an in-house guard layer.

