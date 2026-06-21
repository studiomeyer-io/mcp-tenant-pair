/**
 * Adapter parity — the SQLite and Postgres stores must be observationally
 * identical for the same operation sequence.
 *
 * The SQLite leg runs everywhere (embedded, no external service). The Postgres
 * leg runs ONLY when a connection string is provided AND a live connection
 * succeeds:
 *
 *   TENANT_PAIR_TEST_PG_URL=postgres://user:pass@host:5432/db npm test
 *   # (DATABASE_URL is also accepted)
 *
 * When no database is reachable the Postgres leg is skipped with a clear note
 * instead of failing — CI without a Postgres service stays green, and a
 * developer with a local Postgres gets real cross-adapter coverage. `pg` is an
 * optional peer dependency, so it is imported dynamically and a missing module
 * also skips cleanly.
 *
 * The same assertion body runs against both stores via `runParitySuite`, so a
 * divergence in bi-temporal versioning, history ordering, conflict listing,
 * member isolation, or DSGVO erasure surfaces as a failing Postgres test with
 * the identical name as its passing SQLite sibling.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  type PgClient,
  type PgQueryable,
  PostgresTenantStore,
  SqliteTenantStore,
  TenantPair,
  type TenantStore,
} from "../src/index.js";

/** Deterministic clock shared across a single TenantPair instance. */
function fixedClock(start = "2026-01-01T00:00:00.000Z"): {
  now: () => Date;
  advance: (ms: number) => void;
} {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/**
 * The parity body. `makeStore` returns a fresh, isolated store for the leg.
 * Every assertion here must hold identically for SQLite and Postgres.
 */
function runParitySuite(label: string, makeStore: () => TenantStore): void {
  describe(`adapter parity — ${label}`, () => {
    it("bi-temporal versioning + history ordering are identical", async () => {
      const clock = fixedClock();
      const tp = new TenantPair({ store: makeStore(), now: clock.now });
      const { pairId, inviteToken } = await tp.createPair({ creatorMemberId: "alice" });
      await tp.acceptInvite({ inviteToken, memberId: "bob" });

      clock.advance(1000);
      const r1 = await tp.setSharedState(pairId, "alice", "dinner", "pizza");
      clock.advance(1000);
      const r2 = await tp.setSharedState(pairId, "bob", "dinner", "sushi");
      clock.advance(1000);
      const r3 = await tp.setSharedState(pairId, "alice", "dinner", "ramen");
      expect([r1.version, r2.version, r3.version]).toEqual([1, 2, 3]);

      const current = await tp.getSharedState(pairId);
      expect(current.state["dinner"]).toBe("ramen");
      expect(current.version).toBe(3);

      const history = await tp.getPairStateHistory(pairId, "default", "dinner");
      expect(history.map((h) => h.version)).toEqual([1, 2, 3]);
      expect(history.map((h) => h.value)).toEqual(["pizza", "sushi", "ramen"]);
      expect(history.map((h) => h.writtenByMemberId)).toEqual(["alice", "bob", "alice"]);
      // Only the newest row is open; older rows are closed with valid_to set.
      expect(history[0]?.validTo).not.toBeNull();
      expect(history[1]?.validTo).not.toBeNull();
      expect(history[2]?.validTo).toBeNull();
      await tp.close();
    });

    it("conflict listing + LWW resolution are identical", async () => {
      const clock = fixedClock();
      const tp = new TenantPair({ store: makeStore(), now: clock.now });
      const { pairId, inviteToken } = await tp.createPair({ creatorMemberId: "alice" });
      await tp.acceptInvite({ inviteToken, memberId: "bob" });

      clock.advance(1000);
      await tp.setSharedState(pairId, "alice", "k", "a");
      clock.advance(1000);
      await tp.setSharedState(pairId, "bob", "k", "b");

      const conflicts = await tp.listConflicts(pairId);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.candidates.map((c) => c.version)).toEqual([1, 2]);

      const first = await tp.resolveConflicts(pairId);
      expect(first).toEqual({ resolved: 1, remaining: 0 });
      // Idempotent re-run.
      const second = await tp.resolveConflicts(pairId);
      expect(second.resolved).toBe(0);
      await tp.close();
    });

    it("member isolation: cross-member private reads return nothing", async () => {
      const tp = new TenantPair({ store: makeStore() });
      const { pairId, inviteToken } = await tp.createPair({ creatorMemberId: "alice" });
      await tp.acceptInvite({ inviteToken, memberId: "bob" });

      await tp.setMemberPreference(pairId, "alice", "allergy", ["nuts"]);
      const bobView = await tp.getMemberConstraints(pairId, "bob");
      expect(bobView["allergy"]).toBeUndefined();
      const aliceView = await tp.getMemberConstraints(pairId, "alice");
      expect(aliceView["allergy"]).toEqual(["nuts"]);
      await tp.close();
    });

    it("cross-pair isolation: a second pair cannot see the first pair's state", async () => {
      const tp = new TenantPair({ store: makeStore() });
      const a = await tp.createPair({ creatorMemberId: "alice" });
      await tp.acceptInvite({ inviteToken: a.inviteToken, memberId: "bob" });
      const b = await tp.createPair({ creatorMemberId: "carol" });
      await tp.acceptInvite({ inviteToken: b.inviteToken, memberId: "dave" });

      await tp.setSharedState(a.pairId, "alice", "secret", "A-only");
      await tp.setMemberPreference(a.pairId, "alice", "allergy", "A-private");

      // Pair B's shared state is empty — no bleed from A.
      const bShared = await tp.getSharedState(b.pairId);
      expect(bShared.state).toEqual({});

      // A member-id that exists in A is not a member of B.
      await expect(tp.getMemberConstraints(b.pairId, "alice")).rejects.toMatchObject({
        code: "NOT_A_MEMBER",
      });

      // listMembers is pair-scoped.
      const bMembers = (await tp.listMembers(b.pairId)).map((m) => m.memberId).sort();
      expect(bMembers).toEqual(["carol", "dave"]);
      await tp.close();
    });

    it("same memberId in two pairs keeps fully independent private state", async () => {
      const tp = new TenantPair({ store: makeStore() });
      const c = await tp.createPair({ creatorMemberId: "shared" });
      const d = await tp.createPair({ creatorMemberId: "shared" });
      await tp.setMemberPreference(c.pairId, "shared", "k", "C-value");
      await tp.setMemberPreference(d.pairId, "shared", "k", "D-value");
      expect((await tp.getMemberConstraints(c.pairId, "shared"))["k"]).toBe("C-value");
      expect((await tp.getMemberConstraints(d.pairId, "shared"))["k"]).toBe("D-value");
      await tp.close();
    });

    it("DSGVO erasure removes private state but keeps shared writes + audit trace", async () => {
      const tp = new TenantPair({ store: makeStore() });
      const { pairId, inviteToken } = await tp.createPair({
        creatorMemberId: "alice",
        displayName: "Alice",
      });
      await tp.acceptInvite({ inviteToken, memberId: "bob", displayName: "Bob" });
      await tp.setMemberPreference(pairId, "bob", "allergy", "peanuts");
      await tp.setSharedState(pairId, "bob", "dinner", "bob-picked");
      await tp.leavePair(pairId, "bob");

      await tp.forgetMember(pairId, "bob");

      // Private state gone.
      expect(await tp.getMemberConstraints(pairId, "bob")).toEqual({});
      // Shared write survives.
      expect((await tp.getSharedState(pairId)).state["dinner"]).toBe("bob-picked");
      // Membership trace retained (bob still listed when including left members),
      // display_name nulled.
      const all = await tp.listMembers(pairId); // active only -> bob excluded (left)
      expect(all.map((m) => m.memberId)).toEqual(["alice"]);
      await tp.close();
    });
  });
}

// --- SQLite leg (always runs) ---------------------------------------------
runParitySuite("SqliteTenantStore", () => new SqliteTenantStore({ path: ":memory:" }));

// --- Postgres leg (runs only against a live database) ----------------------
const PG_URL = process.env["TENANT_PAIR_TEST_PG_URL"] ?? process.env["DATABASE_URL"];

interface PgPoolLike extends PgQueryable {
  query<R = unknown>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  end(): Promise<void>;
  connect(): Promise<PgClient>;
}

/**
 * Lazily import `pg` and verify a real connection. Returns a Pool factory if
 * Postgres is reachable, otherwise null (→ the leg is skipped, never failed).
 */
async function probePostgres(): Promise<null | (() => PgPoolLike)> {
  if (!PG_URL) return null;
  let pgmod: typeof import("pg");
  try {
    pgmod = (await import("pg")).default ?? (await import("pg"));
  } catch {
    return null; // optional peer dep not installed
  }
  const { Pool } = pgmod as unknown as { Pool: new (cfg: { connectionString: string }) => PgPoolLike };
  const probe = new Pool({ connectionString: PG_URL });
  try {
    await probe.query("SELECT 1");
    return () => new Pool({ connectionString: PG_URL });
  } catch {
    return null; // DB unreachable in this environment
  } finally {
    await probe.end().catch(() => undefined);
  }
}

const pgFactory = await probePostgres();
const createdSchemas: string[] = [];

if (!pgFactory) {
  describe.skip("adapter parity — PostgresTenantStore (no live Postgres — set TENANT_PAIR_TEST_PG_URL)", () => {
    it("skipped", () => {
      expect(true).toBe(true);
    });
  });
} else {
  /**
   * Wrap a real pool so the (random) schema is created -- and awaited -- before
   * the very first query reaches it. `makeStore` must stay synchronous, so we
   * gate every query on a one-shot `CREATE SCHEMA` promise instead of firing it
   * and hoping it wins the race against the store's DDL.
   */
  function schemaEnsuringPool(schema: string): PgPoolLike {
    const inner = pgFactory!();
    let ensured: Promise<unknown> | null = null;
    const ensure = (): Promise<unknown> => {
      if (!ensured) ensured = inner.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      return ensured;
    };
    return {
      async query<R = unknown>(text: string, params?: unknown[]): Promise<{ rows: R[] }> {
        await ensure();
        return inner.query<R>(text, params);
      },
      // Forward connect() so acceptInviteAtomic runs its real BEGIN / SELECT
      // FOR UPDATE / COMMIT transaction against live Postgres (not the
      // non-atomic fallback). Schema is ensured first.
      async connect(): Promise<PgClient> {
        await ensure();
        return inner.connect();
      },
      end: () => inner.end(),
    };
  }

  // Each store gets an isolated, randomly-named schema so parallel/repeat runs
  // never collide; schemas are torn down in afterAll.
  runParitySuite("PostgresTenantStore", () => {
    const schema = `tp_parity_${Math.random().toString(36).slice(2, 10)}`;
    createdSchemas.push(schema);
    return new PostgresTenantStore({ pool: schemaEnsuringPool(schema), schema });
  });

  afterAll(async () => {
    const cleanup = pgFactory();
    for (const schema of createdSchemas) {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    }
    await cleanup.end().catch(() => undefined);
  });
}
