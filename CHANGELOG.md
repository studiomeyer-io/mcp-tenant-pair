# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-11-01


### Dependency maintenance

- Include the complete root MIT license in the library, CLI and demo npm archives.

- Align the library, CLI, demo and registry descriptor at 0.1.3.
- Migrate library/demo Zod dependencies to ^4.6.7 and the official input-schema converter, preserving closed roots and optional unknown values. Use a scoped rimraf -> glob ^14.0.3 development override; verify matching-fixture removal through the real upstream operation.
- The checked workspace build/typecheck passes, with 142 passing tests and one existing skip. A real SQLite-backed stdio handshake exposes 12 tools. All-dependency and production audits report zero findings.

### Added
- Initial monorepo skeleton with three packages
- `mcp-tenant-pair` core library with `TenantPair` class, `TenantStore` interface, SQLite + Postgres adapters
- `LWWResolver` (default) and `ManualResolver` conflict resolvers with bi-temporal `valid_from`/`valid_to` semantics
- `mcp-tenant-pair-cli` for inspection and manual operations
- `mcp-tenant-pair-demo` reference MCP server exposing 12 tools over stdio (11 lifecycle + `forget_member` for DSGVO Art. 17 erasure)
- Test suite covering pair creation, invite flow, conflict resolution, member preferences, shared state, store adapters, and demo-server integration

### Fixed
- Invite expiry is now inclusive of the boundary instant in both adapters: at the exact `expires_at` time an invite is rejected as `INVITE_EXPIRED` (was previously still acceptable). This makes the accept path the exact complement of `countPendingInvites` (pending iff `expires_at > asOf`), and aligns SQLite and Postgres behaviour. Fixed in `acceptInviteAtomic` (both adapters) and the Postgres non-atomic fallback.

### Security
- Refreshed `package-lock.json` to pull patched transitive prod dependencies via `@modelcontextprotocol/sdk` (within existing semver ranges, no SDK change): `hono` 4.12.18 to 4.12.26 (closes 8 advisories incl. GHSA-wwfh-h76j-fc44, high) and `qs` 6.15.1 to 6.15.2 (GHSA-q8mj-m7cp-5q26). The production dependency tree now reports 0 known advisories under `npm audit --omit=dev`, restoring the CI audit gate. That earlier update left dev-only vitest/vite advisories; the dependency maintenance above resolves the current development tree.

### Tests
- Added invite-expiry boundary tests (SQLite + Postgres parity, including the atomic and non-atomic accept paths).
- Added a cross-adapter parity + tenant-isolation suite (`adapter-parity.test.ts`): identical bi-temporal versioning, history ordering, conflict listing/resolution, cross-member and cross-pair isolation, and DSGVO erasure across SQLite and Postgres. The Postgres leg runs only when `TENANT_PAIR_TEST_PG_URL`/`DATABASE_URL` reaches a live database and is skipped otherwise (no false-fail without Postgres).
- Test total: 142 passing (+1 Postgres-conditional skip), up from 130.

## [0.1.1] - 2026-05-03

### Added
- `mcpName: "io.studiomeyer/tenant-pair"` field in `packages/demo/package.json` — required for MCP Registry publish (HTTP 400 without it).

### Changed
- All three packages (`mcp-tenant-pair`, `mcp-tenant-pair-cli`, `mcp-tenant-pair-demo`) bumped from `0.1.0` to `0.1.1` in lockstep.
- Internal `mcp-tenant-pair` dependency in cli + demo updated to `0.1.1`.

### Notes
- No code changes. Pure metadata patch to enable Official MCP Registry listing.

## [0.1.0]

- Pre-publish foundation build, see Unreleased.
