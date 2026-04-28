/**
 * Regression tests for the fixes applied 2026-04-28 after Cold-Cross-Review +
 * MCP Factory Reviewer found 3 HIGH + 4 MEDIUM + 1 LOW + drift issues.
 *
 * These tests bind specific defects to specific behaviour so future regressions
 * are caught — every test name names the finding it closes.
 */
import { describe, expect, it } from "vitest";
import {
  generateShortCode,
  PostgresTenantStore,
  SqliteTenantStore,
  TenantPair,
  TenantPairError,
} from "../src/index.js";

describe("F1 HIGH — Postgres SQL injection via schema parameter", () => {
  it("rejects schema names with semicolons (DROP TABLE attack)", () => {
    expect(
      () =>
        new PostgresTenantStore({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pool: { query: async () => ({ rows: [] }) } as any,
          schema: "public; DROP TABLE pairs; --",
        }),
    ).toThrow(/INVALID_SCHEMA_IDENTIFIER/);
  });

  it("rejects schema names with quotes", () => {
    expect(
      () =>
        new PostgresTenantStore({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pool: { query: async () => ({ rows: [] }) } as any,
          schema: 'a"b',
        }),
    ).toThrow(/INVALID_SCHEMA_IDENTIFIER/);
  });

  it("rejects schema starting with digit", () => {
    expect(
      () =>
        new PostgresTenantStore({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pool: { query: async () => ({ rows: [] }) } as any,
          schema: "1abc",
        }),
    ).toThrow(/INVALID_SCHEMA_IDENTIFIER/);
  });

  it("rejects uppercase letters (would silently break unquoted DDL)", () => {
    expect(
      () =>
        new PostgresTenantStore({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pool: { query: async () => ({ rows: [] }) } as any,
          schema: "MySchema",
        }),
    ).toThrow(/INVALID_SCHEMA_IDENTIFIER/);
  });

  it("rejects schema names longer than 63 chars (Postgres NAMEDATALEN)", () => {
    expect(
      () =>
        new PostgresTenantStore({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pool: { query: async () => ({ rows: [] }) } as any,
          schema: "a".repeat(64),
        }),
    ).toThrow(/INVALID_SCHEMA_IDENTIFIER/);
  });

  it("accepts default 'public'", () => {
    expect(
      () =>
        new PostgresTenantStore({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pool: { query: async () => ({ rows: [] }) } as any,
        }),
    ).not.toThrow();
  });

  it("accepts valid lowercase ASCII identifiers", () => {
    expect(
      () =>
        new PostgresTenantStore({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pool: { query: async () => ({ rows: [] }) } as any,
          schema: "tenant_pair_v2",
        }),
    ).not.toThrow();
  });
});

describe("F2 HIGH — TOCTOU acceptInvite race", () => {
  it("two concurrent accept_invite calls cannot both succeed (atomic transaction)", async () => {
    const store = new SqliteTenantStore({ path: ":memory:" });
    const tp = new TenantPair({ store });
    const created = await tp.createPair({ creatorMemberId: "alice" });
    const invite = await tp.inviteMember({
      pairId: created.pairId,
      inviterMemberId: "alice",
    });
    // Run both at once — better-sqlite3 immediate-tx serializes.
    const [result1, result2] = await Promise.allSettled([
      tp.acceptInvite({ inviteToken: invite.inviteToken, memberId: "bob" }),
      tp.acceptInvite({ inviteToken: invite.inviteToken, memberId: "carol" }),
    ]);
    const fulfilled = [result1, result2].filter((r) => r.status === "fulfilled");
    const rejected = [result1, result2].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === "rejected") {
      expect((rejected[0].reason as TenantPairError).code).toBe(
        "INVITE_ALREADY_ACCEPTED",
      );
    }
    await tp.close();
  });
});

describe("F3 HIGH — markConflictResolved must keep winner row resolved_at NULL", () => {
  it("only loser versions get resolved_at, winner keeps NULL", async () => {
    const store = new SqliteTenantStore({ path: ":memory:" });
    await store.init();
    const pairId = "pair-x";
    // Manually seed two competing pair_state rows to simulate a conflict.
    // We bypass the public API to control timing exactly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (store as any).db;
    db.prepare(
      "INSERT INTO pairs (pair_id, display_name, created_at, schema_version) VALUES (?, NULL, ?, 1)",
    ).run(pairId, "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO pair_state (pair_id, namespace, key, value, written_by_member_id, valid_from, valid_to, version, resolved_at) VALUES (?, 'default', 'k', '\"loser\"', 'alice', ?, NULL, 1, NULL)",
    ).run(pairId, "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO pair_state (pair_id, namespace, key, value, written_by_member_id, valid_from, valid_to, version, resolved_at) VALUES (?, 'default', 'k', '\"winner\"', 'bob', ?, NULL, 2, NULL)",
    ).run(pairId, "2026-01-01T00:00:01.000Z");

    store.markConflictResolved(
      pairId,
      "default",
      "k",
      2 /* winner version */,
      "2026-01-01T00:01:00.000Z",
    );

    const rows = db
      .prepare("SELECT version, resolved_at FROM pair_state WHERE pair_id = ? ORDER BY version")
      .all(pairId) as { version: number; resolved_at: string | null }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.version).toBe(1);
    expect(rows[0]?.resolved_at).not.toBeNull(); // loser
    expect(rows[1]?.version).toBe(2);
    expect(rows[1]?.resolved_at).toBeNull(); // winner stays NULL — audit-friendly
    store.close();
  });
});

describe("F5 MEDIUM — countPendingInvites uses caller-supplied asOf", () => {
  it("respects deterministic clock injected via asOf parameter", async () => {
    const store = new SqliteTenantStore({ path: ":memory:" });
    let mockedTime = new Date("2026-01-01T12:00:00.000Z");
    const tp = new TenantPair({ store, now: () => mockedTime });
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    // createPair emits one initial invite; inviteMember adds a second.
    await tp.inviteMember({ pairId, inviterMemberId: "alice", ttlSeconds: 3600 });
    expect(await store.countPendingInvites(pairId, mockedTime.toISOString())).toBe(2);
    // Advance the test clock past both invites' expiry windows
    // (createPair's initial invite uses DEFAULT_INVITE_TTL_SECONDS = 7d).
    mockedTime = new Date("2026-02-01T00:00:00.000Z");
    expect(await store.countPendingInvites(pairId, mockedTime.toISOString())).toBe(0);
    await tp.close();
  });
});

describe("F6 MEDIUM — DSGVO Art. 17 forgetMember erasure", () => {
  it("deletes member_state but retains membership trace", async () => {
    const store = new SqliteTenantStore({ path: ":memory:" });
    const tp = new TenantPair({ store });
    const { pairId } = await tp.createPair({
      creatorMemberId: "alice",
      displayName: "Alice",
    });
    const invite = await tp.inviteMember({ pairId, inviterMemberId: "alice" });
    await tp.acceptInvite({
      inviteToken: invite.inviteToken,
      memberId: "bob",
      displayName: "Bob",
    });
    await tp.setMemberPreference(pairId, "bob", "allergy", "peanuts");
    await tp.leavePair(pairId, "bob");

    // Sanity: pre-erasure, bob's allergy is still in the bi-temporal store.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (store as any).db;
    const preRows = db
      .prepare("SELECT * FROM member_state WHERE pair_id = ? AND member_id = ?")
      .all(pairId, "bob");
    expect(preRows.length).toBeGreaterThan(0);

    await tp.forgetMember(pairId, "bob");

    const postRows = db
      .prepare("SELECT * FROM member_state WHERE pair_id = ? AND member_id = ?")
      .all(pairId, "bob");
    expect(postRows).toHaveLength(0);

    // display_name nulled, but membership trace (left_at) retained for audit.
    const memberRow = db
      .prepare("SELECT * FROM members WHERE pair_id = ? AND member_id = ?")
      .get(pairId, "bob") as { display_name: string | null; left_at: string | null };
    expect(memberRow.display_name).toBeNull();
    expect(memberRow.left_at).not.toBeNull();
    await tp.close();
  });

  it("is idempotent on unknown member", async () => {
    const store = new SqliteTenantStore({ path: ":memory:" });
    const tp = new TenantPair({ store });
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    await expect(tp.forgetMember(pairId, "ghost")).resolves.toBeUndefined();
    await expect(tp.forgetMember(pairId, "ghost")).resolves.toBeUndefined();
    await tp.close();
  });
});

describe("F7 MEDIUM — generateShortCode uses CSPRNG by default + injectable for tests", () => {
  it("default rng is non-deterministic across calls (statistical sanity)", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i += 1) codes.add(generateShortCode());
    // 50 base32-8 codes from a CSPRNG should all be distinct.
    expect(codes.size).toBe(50);
  });

  it("accepts injected deterministic rng for tests", () => {
    const rng = (): number => 0; // always picks first char
    const code = generateShortCode(rng, 8);
    expect(code).toBe("AAAA-AAAA");
  });
});
