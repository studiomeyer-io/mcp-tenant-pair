# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial monorepo skeleton with three packages
- `mcp-tenant-pair` core library with `TenantPair` class, `TenantStore` interface, SQLite + Postgres adapters
- `LWWResolver` (default) and `ManualResolver` conflict resolvers with bi-temporal `valid_from`/`valid_to` semantics
- `mcp-tenant-pair-cli` for inspection and manual operations
- `mcp-tenant-pair-demo` reference MCP server exposing 11 tools over stdio
- Test suite covering pair creation, invite flow, conflict resolution, member preferences, shared state, store adapters, and demo-server integration

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
