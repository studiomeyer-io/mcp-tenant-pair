# mcp-tenant-pair

Library for multi-user tenancy in MCP servers. See the [root README](../../README.md) for the 5-minute quickstart.

## Install

```sh
npm install mcp-tenant-pair
# Optional, only if using Postgres adapter:
npm install pg
```

## Public API

```ts
import {
  TenantPair,
  TenantPairError,
  SqliteTenantStore,
  PostgresTenantStore,
  LWWResolver,
  ManualResolver,
  type ConflictResolver,
  type Conflict,
  type Resolution,
  type TenantStore,
  type PairRecord,
  type MemberRecord,
} from "mcp-tenant-pair";
```

## TenantPair methods

| Method                                         | Returns                                            |
|------------------------------------------------|----------------------------------------------------|
| `createPair({ creatorMemberId, displayName })` | `{ pairId, inviteToken, expiresAt }`              |
| `inviteMember({ pairId, inviterMemberId, ttlSeconds? })` | `{ inviteToken, expiresAt }`            |
| `acceptInvite({ inviteToken, memberId })`      | `{ pairId, members }`                              |
| `listMembers(pairId)`                          | `MemberRecord[]`                                   |
| `kickMember(pairId, actingMemberId, targetMemberId)` | `{ removedMemberId }`                       |
| `leavePair(pairId, memberId)`                  | `void`                                             |
| `setMemberPreference(pairId, memberId, key, value)`   | `{ validFrom }`                             |
| `getMemberConstraints(pairId, memberId, keys?)`| `Record<string, unknown>`                          |
| `setSharedState(pairId, writerMemberId, key, value, namespace?)` | `{ version, validFrom }`         |
| `getSharedState(pairId, namespace?)`           | `{ state, version }`                               |
| `listConflicts(pairId, namespace?)`            | `Conflict[]`                                       |
| `resolveConflicts(pairId, namespace?)`         | `{ resolved, remaining }`                          |
| `getPairStateHistory(pairId, namespace, key)`  | `PairStateRow[]`                                   |
| `close()`                                      | `void`                                             |

## Errors

`TenantPairError` carries a stable string `code` (e.g. `PAIR_NOT_FOUND`, `INVITE_EXPIRED`, `NOT_OWNER`, `MEMBER_INACTIVE`, `INVITE_LIMIT`). MCP servers should map these to error responses verbatim.

## Storage interface

Implement `TenantStore` (in `src/store/interface.ts`) for any backend. SQLite and Postgres adapters are reference implementations; both follow the same SCHEMA_VERSION (1).

## License

MIT, Copyright (c) 2026 Matthias Meyer (StudioMeyer)
