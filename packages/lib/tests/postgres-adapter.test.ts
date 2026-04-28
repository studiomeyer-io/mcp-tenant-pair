/**
 * Comprehensive Postgres-adapter tests with a MockPg pool. No live DB required —
 * the tests exercise every code path the adapter takes (init, CRUD, atomic
 * transaction, forgetMember, markConflictResolved with winner-version filter,
 * pendingInvites with asOf clock, schema-identifier validation).
 *
 * Pattern: each test instantiates a small MockPg that records every query +
 * params it sees and returns canned rows. We then assert on the recorded SQL
 * and on the adapter's return values.
 */
import { describe, expect, it } from "vitest";
import {
  PostgresTenantStore,
  type PgClient,
  type PgQueryable,
} from "../src/index.js";

interface RecordedQuery {
  text: string;
  params?: unknown[];
}

class MockPgPool implements PgQueryable {
  recorded: RecordedQuery[] = [];
  responses = new Map<string, { rows: unknown[] }>();
  /**
   * Only assigned when `withConnect()` is called — undefined otherwise so the
   * adapter's `if (!this.pool.connect)` check resolves true and we exercise
   * the non-atomic fallback path explicitly.
   */
  connect?: () => Promise<PgClient>;

  async query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }> {
    this.recorded.push({ text, params });
    const response = this.matchResponse(text);
    return response as { rows: R[] };
  }

  async end(): Promise<void> {
    /* no-op */
  }

  withConnect(factory: () => PgClient): this {
    this.connect = async (): Promise<PgClient> => factory();
    return this;
  }

  setResponse(matcher: string, rows: unknown[]): void {
    this.responses.set(matcher, { rows });
  }

  private matchResponse(text: string): { rows: unknown[] } {
    for (const [matcher, response] of this.responses) {
      if (text.includes(matcher)) return response;
    }
    return { rows: [] };
  }
}

class MockPgClient implements PgClient {
  recorded: RecordedQuery[] = [];
  responses = new Map<string, { rows: unknown[] }>();
  released = false;

  async query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }> {
    this.recorded.push({ text, params });
    // Use longest-matcher-first so a more specific match like
    // "SELECT accepted_by_member_id FROM public.invites" wins over
    // a generic "FROM public.invites WHERE invite_token".
    const matchers = [...this.responses.keys()].sort(
      (a, b) => b.length - a.length,
    );
    for (const matcher of matchers) {
      if (text.includes(matcher)) {
        return this.responses.get(matcher) as { rows: R[] };
      }
    }
    return { rows: [] as R[] };
  }

  release(): void {
    this.released = true;
  }

  setResponse(matcher: string, rows: unknown[]): this {
    this.responses.set(matcher, { rows });
    return this;
  }
}

describe("PostgresTenantStore — schema-identifier validation", () => {
  it("accepts default schema 'public'", () => {
    const pool = new MockPgPool();
    expect(() => new PostgresTenantStore({ pool })).not.toThrow();
  });

  it("accepts valid lowercase identifiers", () => {
    for (const schema of ["a", "_x", "tenant_pair", "v2_schema", "abc_123"]) {
      const pool = new MockPgPool();
      expect(() => new PostgresTenantStore({ pool, schema })).not.toThrow();
    }
  });

  it("rejects empty string", () => {
    expect(
      () => new PostgresTenantStore({ pool: new MockPgPool(), schema: "" }),
    ).toThrow(/INVALID_SCHEMA_IDENTIFIER/);
  });

  it("rejects strings with whitespace", () => {
    expect(
      () => new PostgresTenantStore({ pool: new MockPgPool(), schema: "a b" }),
    ).toThrow(/INVALID_SCHEMA_IDENTIFIER/);
  });

  it("rejects strings with hyphen", () => {
    expect(
      () => new PostgresTenantStore({ pool: new MockPgPool(), schema: "a-b" }),
    ).toThrow(/INVALID_SCHEMA_IDENTIFIER/);
  });

  it("rejects unicode characters", () => {
    expect(
      () => new PostgresTenantStore({ pool: new MockPgPool(), schema: "café" }),
    ).toThrow(/INVALID_SCHEMA_IDENTIFIER/);
  });

  it("rejects exactly 64-char identifier (Postgres NAMEDATALEN limit is 63)", () => {
    expect(
      () =>
        new PostgresTenantStore({
          pool: new MockPgPool(),
          schema: "a".repeat(64),
        }),
    ).toThrow(/INVALID_SCHEMA_IDENTIFIER/);
  });

  it("accepts exactly 63-char identifier", () => {
    expect(
      () =>
        new PostgresTenantStore({
          pool: new MockPgPool(),
          schema: "a".repeat(63),
        }),
    ).not.toThrow();
  });
});

describe("PostgresTenantStore — init() runs DDL once", () => {
  it("runs CREATE TABLE statements on first init, no-op on second", async () => {
    const pool = new MockPgPool();
    const store = new PostgresTenantStore({ pool });
    await store.init();
    const ddlAfterFirst = pool.recorded.length;
    expect(ddlAfterFirst).toBeGreaterThan(0);
    expect(pool.recorded[0]?.text).toMatch(/CREATE TABLE IF NOT EXISTS/);
    await store.init();
    expect(pool.recorded.length).toBe(ddlAfterFirst);
  });

  it("uses configured schema in DDL", async () => {
    const pool = new MockPgPool();
    const store = new PostgresTenantStore({ pool, schema: "tenant_v2" });
    await store.init();
    expect(pool.recorded[0]?.text).toMatch(/tenant_v2\.pairs/);
  });
});

describe("PostgresTenantStore — atomic acceptInviteAtomic via connect()", () => {
  it("runs BEGIN → SELECT FOR UPDATE → INSERT member → UPDATE invite → COMMIT", async () => {
    const client = new MockPgClient()
      .setResponse("FROM public.invites WHERE invite_token", [
        {
          invite_token: "tok",
          pair_id: "pair-1",
          accepted_at: null,
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      ])
      .setResponse("FROM public.members WHERE pair_id", [])
      .setResponse("SELECT accepted_by_member_id FROM public.invites", [
        { accepted_by_member_id: "alice" },
      ]);
    const pool = new MockPgPool().withConnect(() => client);
    const store = new PostgresTenantStore({ pool });
    const result = await store.acceptInviteAtomic({
      inviteToken: "tok",
      memberId: "alice",
      displayName: null,
      nowIso: "2026-01-01T00:00:00.000Z",
    });
    expect(result.pairId).toBe("pair-1");
    expect(result.reactivated).toBe(false);
    const sqlOrder = client.recorded.map((q) => q.text);
    expect(sqlOrder[0]).toBe("BEGIN");
    expect(sqlOrder.some((s) => s.includes("FOR UPDATE"))).toBe(true);
    expect(sqlOrder.some((s) => s.includes("INSERT INTO public.members"))).toBe(true);
    expect(sqlOrder.some((s) => s.includes("UPDATE public.invites SET accepted_at"))).toBe(true);
    expect(sqlOrder[sqlOrder.length - 1]).toBe("COMMIT");
    expect(client.released).toBe(true);
  });

  it("ROLLBACK on INVITE_NOT_FOUND", async () => {
    const client = new MockPgClient().setResponse("FROM public.invites WHERE invite_token", []);
    const pool = new MockPgPool().withConnect(() => client);
    const store = new PostgresTenantStore({ pool });
    await expect(
      store.acceptInviteAtomic({
        inviteToken: "tok",
        memberId: "alice",
        displayName: null,
        nowIso: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/INVITE_NOT_FOUND/);
    expect(client.recorded.some((q) => q.text === "ROLLBACK")).toBe(true);
    expect(client.released).toBe(true);
  });

  it("ROLLBACK on INVITE_ALREADY_ACCEPTED", async () => {
    const client = new MockPgClient().setResponse("FROM public.invites WHERE invite_token", [
      {
        invite_token: "tok",
        pair_id: "pair-1",
        accepted_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    ]);
    const pool = new MockPgPool().withConnect(() => client);
    const store = new PostgresTenantStore({ pool });
    await expect(
      store.acceptInviteAtomic({
        inviteToken: "tok",
        memberId: "alice",
        displayName: null,
        nowIso: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/INVITE_ALREADY_ACCEPTED/);
  });

  it("ROLLBACK on INVITE_EXPIRED", async () => {
    const client = new MockPgClient().setResponse("FROM public.invites WHERE invite_token", [
      {
        invite_token: "tok",
        pair_id: "pair-1",
        accepted_at: null,
        expires_at: "2024-01-01T00:00:00.000Z",
      },
    ]);
    const pool = new MockPgPool().withConnect(() => client);
    const store = new PostgresTenantStore({ pool });
    await expect(
      store.acceptInviteAtomic({
        inviteToken: "tok",
        memberId: "alice",
        displayName: null,
        nowIso: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/INVITE_EXPIRED/);
  });

  it("ROLLBACK on ALREADY_MEMBER (active member tries to accept)", async () => {
    const client = new MockPgClient()
      .setResponse("FROM public.invites WHERE invite_token", [
        {
          invite_token: "tok",
          pair_id: "pair-1",
          accepted_at: null,
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      ])
      .setResponse("FROM public.members WHERE pair_id", [
        { member_id: "alice", left_at: null },
      ]);
    const pool = new MockPgPool().withConnect(() => client);
    const store = new PostgresTenantStore({ pool });
    await expect(
      store.acceptInviteAtomic({
        inviteToken: "tok",
        memberId: "alice",
        displayName: null,
        nowIso: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/ALREADY_MEMBER/);
  });

  it("reactivates left member instead of inserting (rejoin path)", async () => {
    const client = new MockPgClient()
      .setResponse("FROM public.invites WHERE invite_token", [
        {
          invite_token: "tok",
          pair_id: "pair-1",
          accepted_at: null,
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      ])
      .setResponse("FROM public.members WHERE pair_id", [
        { member_id: "bob", left_at: "2026-01-01T00:00:00.000Z" },
      ])
      .setResponse("SELECT accepted_by_member_id FROM public.invites", [
        { accepted_by_member_id: "bob" },
      ]);
    const pool = new MockPgPool().withConnect(() => client);
    const store = new PostgresTenantStore({ pool });
    const result = await store.acceptInviteAtomic({
      inviteToken: "tok",
      memberId: "bob",
      displayName: null,
      nowIso: "2026-02-01T00:00:00.000Z",
    });
    expect(result.reactivated).toBe(true);
    expect(client.recorded.some((q) => q.text.includes("UPDATE public.members SET left_at = NULL"))).toBe(true);
    expect(client.recorded.some((q) => q.text.includes("INSERT INTO public.members"))).toBe(false);
  });

  it("falls back to non-atomic when pool has no connect()", async () => {
    const pool = new MockPgPool();
    pool.setResponse("FROM public.invites WHERE invite_token", [
      {
        invite_token: "tok",
        pair_id: "pair-1",
        accepted_at: null,
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    ]);
    const store = new PostgresTenantStore({ pool });
    const warn = (() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orig = console.warn;
      const captured: string[] = [];
      console.warn = (msg: string): void => void captured.push(msg);
      return {
        captured,
        restore: (): void => {
          console.warn = orig;
        },
      };
    })();
    await store.acceptInviteAtomic({
      inviteToken: "tok",
      memberId: "alice",
      displayName: null,
      nowIso: "2026-01-01T00:00:00.000Z",
    });
    warn.restore();
    expect(warn.captured.some((m) => m.includes("non-atomic"))).toBe(true);
  });
});

describe("PostgresTenantStore — countPendingInvites with asOf parameter", () => {
  it("forwards caller-supplied asOf as $2 parameter (no DB clock)", async () => {
    const pool = new MockPgPool();
    pool.setResponse("FROM public.invites WHERE pair_id", [{ c: "5" }]);
    const store = new PostgresTenantStore({ pool });
    const count = await store.countPendingInvites("pair-1", "2026-04-28T12:00:00.000Z");
    expect(count).toBe(5);
    const last = pool.recorded[pool.recorded.length - 1];
    expect(last?.text).toContain("expires_at > $2");
    expect(last?.params?.[0]).toBe("pair-1");
    expect(last?.params?.[1]).toBe("2026-04-28T12:00:00.000Z");
    // Critically: no NOW() in SQL — clock authority is fully caller-side.
    expect(last?.text).not.toContain("NOW()");
  });
});

describe("PostgresTenantStore — markConflictResolved keeps winner row NULL", () => {
  it("UPDATE filters by version <> $5 + resolved_at IS NULL", async () => {
    const pool = new MockPgPool();
    const store = new PostgresTenantStore({ pool });
    await store.markConflictResolved(
      "pair-1",
      "default",
      "tonight",
      2 /* winner version */,
      "2026-01-01T00:00:00.000Z",
    );
    const last = pool.recorded[pool.recorded.length - 1];
    expect(last?.text).toContain("version <> $5");
    expect(last?.text).toContain("resolved_at IS NULL");
    expect(last?.params?.[0]).toBe("2026-01-01T00:00:00.000Z");
    expect(last?.params?.[4]).toBe(2);
  });
});

describe("PostgresTenantStore — forgetMember (DSGVO Art. 17) atomic", () => {
  it("uses BEGIN/COMMIT transaction when connect is available", async () => {
    const client = new MockPgClient();
    const pool = new MockPgPool().withConnect(() => client);
    const store = new PostgresTenantStore({ pool });
    await store.forgetMember("pair-1", "bob");
    const sqlOrder = client.recorded.map((q) => q.text);
    expect(sqlOrder[0]).toBe("BEGIN");
    expect(sqlOrder.some((s) => s.includes("DELETE FROM public.member_state"))).toBe(true);
    expect(sqlOrder.some((s) => s.includes("UPDATE public.members SET display_name = NULL"))).toBe(true);
    expect(sqlOrder[sqlOrder.length - 1]).toBe("COMMIT");
    expect(client.released).toBe(true);
  });

  it("falls back to two sequential queries when no connect()", async () => {
    const pool = new MockPgPool();
    const store = new PostgresTenantStore({ pool });
    await store.forgetMember("pair-1", "bob");
    expect(pool.recorded.some((q) => q.text.includes("DELETE FROM public.member_state"))).toBe(true);
    expect(pool.recorded.some((q) => q.text.includes("UPDATE public.members SET display_name = NULL"))).toBe(true);
  });

  it("ROLLBACK on error mid-transaction", async () => {
    let firstQuery = true;
    const client: PgClient = {
      recorded: [] as RecordedQuery[],
      released: false,
      async query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any).recorded.push({ text, params });
        if (firstQuery && text.includes("DELETE FROM public.member_state")) {
          firstQuery = false;
          throw new Error("DB connection lost");
        }
        return { rows: [] as R[] };
      },
      release(): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any).released = true;
      },
    } as PgClient;
    const pool = new MockPgPool().withConnect(() => client);
    const store = new PostgresTenantStore({ pool });
    await expect(store.forgetMember("pair-1", "bob")).rejects.toThrow(/DB connection lost/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (client as any).recorded.map((q: RecordedQuery) => q.text);
    expect(calls.some((s: string) => s === "ROLLBACK")).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).released).toBe(true);
  });
});

describe("PostgresTenantStore — listMembers respects includeLeft flag", () => {
  it("default excludes left_at IS NOT NULL members", async () => {
    const pool = new MockPgPool();
    const store = new PostgresTenantStore({ pool });
    await store.listMembers("pair-1");
    expect(pool.recorded[0]?.text).toContain("left_at IS NULL");
  });

  it("includeLeft=true returns full audit trail (no left_at filter)", async () => {
    const pool = new MockPgPool();
    const store = new PostgresTenantStore({ pool });
    await store.listMembers("pair-1", true);
    expect(pool.recorded[0]?.text).not.toContain("left_at IS NULL");
  });
});

describe("PostgresTenantStore — close() ends the pool", () => {
  it("calls pool.end() if defined", async () => {
    let ended = false;
    const pool: PgQueryable = {
      async query() {
        return { rows: [] };
      },
      async end() {
        ended = true;
      },
    };
    const store = new PostgresTenantStore({ pool });
    await store.close();
    expect(ended).toBe(true);
  });

  it("does not throw if pool has no end()", async () => {
    const pool: PgQueryable = {
      async query() {
        return { rows: [] };
      },
    };
    const store = new PostgresTenantStore({ pool });
    await expect(store.close()).resolves.toBeUndefined();
  });
});
