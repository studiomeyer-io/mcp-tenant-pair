/**
 * Invite-expiry boundary semantics.
 *
 * Regression for the off-by-one between the accept path and the pending-count
 * path. The two predicates govern the same lifecycle state and must agree at
 * the exact expiry instant `t == expires_at`:
 *
 *   acceptable  <=>  expires_at >  now   (reject when expires_at <= now)
 *   pending     <=>  expires_at >  asOf
 *
 * Before the fix the accept path used `expires_at < now`, so at the boundary
 * instant an invite was simultaneously "acceptable" (accept path) and
 * "not pending" (count path). Both adapters now treat expiry as inclusive of
 * the boundary, so "still acceptable" and "still pending" are exact
 * complements — and the SQLite and Postgres adapters behave identically.
 */
import { describe, expect, it } from "vitest";
import {
  type PgClient,
  type PgQueryable,
  PostgresTenantStore,
  SqliteTenantStore,
  TenantPair,
  TenantPairError,
} from "../src/index.js";

const TTL = 60; // seconds

describe("invite expiry boundary (SQLite)", () => {
  it("rejects acceptance at the exact expires_at instant (inclusive boundary)", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = new SqliteTenantStore({ path: ":memory:" });
    const tp = new TenantPair({ store, now: () => now });
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    const inv = await tp.inviteMember({
      pairId,
      inviterMemberId: "alice",
      ttlSeconds: TTL,
    });
    // Advance the clock to land *exactly* on expires_at.
    now = new Date(inv.expiresAt);
    await expect(
      tp.acceptInvite({ inviteToken: inv.inviteToken, memberId: "bob" }),
    ).rejects.toMatchObject({ code: "INVITE_EXPIRED" });
    await tp.close();
  });

  it("accepts one millisecond before expires_at", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = new SqliteTenantStore({ path: ":memory:" });
    const tp = new TenantPair({ store, now: () => now });
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    const inv = await tp.inviteMember({
      pairId,
      inviterMemberId: "alice",
      ttlSeconds: TTL,
    });
    now = new Date(new Date(inv.expiresAt).getTime() - 1);
    const result = await tp.acceptInvite({
      inviteToken: inv.inviteToken,
      memberId: "bob",
    });
    expect(result.members.map((m) => m.memberId).sort()).toEqual(["alice", "bob"]);
    await tp.close();
  });

  it("'acceptable' and 'pending' are exact complements at the boundary", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = new SqliteTenantStore({ path: ":memory:" });
    const tp = new TenantPair({
      store,
      now: () => now,
      // Disable the auto-issued createPair invite's interference by using a
      // dedicated invite and asserting on it directly.
    });
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    const inv = await tp.inviteMember({
      pairId,
      inviterMemberId: "alice",
      ttlSeconds: TTL,
    });
    const boundary = inv.expiresAt;

    // Just before the boundary: this invite is pending AND acceptable.
    const justBefore = new Date(new Date(boundary).getTime() - 1).toISOString();
    expect(store.countPendingInvites(pairId, justBefore)).toBe(2); // createPair + this

    // At the boundary: this invite is no longer pending. Count drops to the
    // single still-future createPair invite, and accept is rejected — both
    // paths agree the invite is gone.
    now = new Date(boundary);
    expect(store.countPendingInvites(pairId, boundary)).toBe(1);
    await expect(
      tp.acceptInvite({ inviteToken: inv.inviteToken, memberId: "bob" }),
    ).rejects.toBeInstanceOf(TenantPairError);
    await tp.close();
  });
});

describe("invite expiry boundary (Postgres adapter — parity)", () => {
  /**
   * Drives the Postgres adapter's non-atomic fallback (no `connect()` on the
   * mock pool) so the boundary check runs without a live database. Asserts the
   * same inclusive-boundary semantics as the SQLite adapter.
   */
  function poolWithInvite(expiresAt: string): PgQueryable {
    return {
      async query<R = unknown>(text: string): Promise<{ rows: R[] }> {
        if (text.includes("FROM public.invites WHERE invite_token")) {
          return {
            rows: [
              {
                invite_token: "tok",
                pair_id: "pair-1",
                inviter_member_id: "alice",
                invitee_hint: null,
                expires_at: expiresAt,
                accepted_at: null,
                accepted_by_member_id: null,
              },
            ] as unknown as R[],
          };
        }
        return { rows: [] as R[] };
      },
      // Intentionally no connect() -> exercises the non-atomic fallback path.
    };
  }

  const EXPIRES = "2026-01-01T00:01:00.000Z";

  it("rejects acceptance at the exact expires_at instant", async () => {
    const store = new PostgresTenantStore({ pool: poolWithInvite(EXPIRES) });
    await expect(
      store.acceptInviteAtomic({
        inviteToken: "tok",
        memberId: "bob",
        displayName: null,
        nowIso: EXPIRES, // exactly equal
      }),
    ).rejects.toThrow(/INVITE_EXPIRED/);
  });

  it("accepts one millisecond before expires_at", async () => {
    const justBefore = new Date(new Date(EXPIRES).getTime() - 1).toISOString();
    // No member row + the verify SELECT returns our member => success.
    const pool: PgQueryable = {
      async query<R = unknown>(text: string): Promise<{ rows: R[] }> {
        if (text.includes("SELECT accepted_by_member_id FROM public.invites")) {
          return { rows: [{ accepted_by_member_id: "bob" }] as unknown as R[] };
        }
        if (text.includes("FROM public.invites WHERE invite_token")) {
          return {
            rows: [
              {
                invite_token: "tok",
                pair_id: "pair-1",
                inviter_member_id: "alice",
                invitee_hint: null,
                expires_at: EXPIRES,
                accepted_at: null,
                accepted_by_member_id: null,
              },
            ] as unknown as R[],
          };
        }
        return { rows: [] as R[] };
      },
    };
    const store = new PostgresTenantStore({ pool });
    const result = await store.acceptInviteAtomic({
      inviteToken: "tok",
      memberId: "bob",
      displayName: null,
      nowIso: justBefore,
    });
    expect(result.pairId).toBe("pair-1");
  });

  it("atomic (connect) path also rejects at the exact expires_at instant", async () => {
    const client: PgClient = {
      async query<R = unknown>(text: string): Promise<{ rows: R[] }> {
        if (text.includes("FOR UPDATE")) {
          return {
            rows: [
              {
                invite_token: "tok",
                pair_id: "pair-1",
                accepted_at: null,
                expires_at: EXPIRES,
              },
            ] as unknown as R[],
          };
        }
        return { rows: [] as R[] };
      },
      release(): void {
        /* no-op */
      },
    };
    const pool: PgQueryable = {
      async query<R = unknown>(): Promise<{ rows: R[] }> {
        return { rows: [] as R[] };
      },
      async connect(): Promise<PgClient> {
        return client;
      },
    };
    const store = new PostgresTenantStore({ pool });
    await expect(
      store.acceptInviteAtomic({
        inviteToken: "tok",
        memberId: "bob",
        displayName: null,
        nowIso: EXPIRES,
      }),
    ).rejects.toThrow(/INVITE_EXPIRED/);
  });
});
