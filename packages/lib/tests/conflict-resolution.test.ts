import { describe, expect, it } from "vitest";
import {
  type Conflict,
  type ConflictResolver,
  LWWResolver,
  ManualResolver,
  type Resolution,
  SqliteTenantStore,
  TenantPair,
} from "../src/index.js";

function makePair(now?: () => Date, resolver?: ConflictResolver): TenantPair {
  return new TenantPair({
    store: new SqliteTenantStore(),
    now,
    resolver,
  });
}

async function setupTwoMembers(tp: TenantPair): Promise<{ pairId: string }> {
  const { pairId, inviteToken } = await tp.createPair({ creatorMemberId: "alice" });
  await tp.acceptInvite({ inviteToken, memberId: "bob" });
  return { pairId };
}

describe("conflict resolution", () => {
  it("LWWResolver picks the candidate with the latest validFrom", () => {
    const lww = new LWWResolver();
    const conflicts: Conflict[] = [
      {
        pairId: "p",
        namespace: "ns",
        key: "k",
        candidates: [
          {
            pairId: "p",
            namespace: "ns",
            key: "k",
            value: "old",
            writtenByMemberId: "alice",
            validFrom: "2026-01-01T00:00:00Z",
            validTo: "2026-01-02T00:00:00Z",
            version: 1,
          },
          {
            pairId: "p",
            namespace: "ns",
            key: "k",
            value: "new",
            writtenByMemberId: "bob",
            validFrom: "2026-01-02T00:00:00Z",
            validTo: null,
            version: 2,
          },
        ],
      },
    ];
    const res = lww.resolve(conflicts);
    expect(res).toHaveLength(1);
    expect(res[0]?.winnerVersion).toBe(2);
  });

  it("LWWResolver tie-breaks on highest version when validFrom matches", () => {
    const lww = new LWWResolver();
    const ts = "2026-01-01T00:00:00Z";
    const candidates = [1, 2, 3].map((v) => ({
      pairId: "p",
      namespace: "ns",
      key: "k",
      value: v,
      writtenByMemberId: "alice",
      validFrom: ts,
      validTo: null,
      version: v,
    }));
    const res = lww.resolve([{ pairId: "p", namespace: "ns", key: "k", candidates }]);
    expect(res[0]?.winnerVersion).toBe(3);
  });

  it("ManualResolver returns no resolutions (pending for human)", () => {
    const manual = new ManualResolver();
    const result = manual.resolve([
      {
        pairId: "p",
        namespace: "ns",
        key: "k",
        candidates: [],
      },
    ]);
    expect(result).toEqual([]);
  });

  it("custom resolver can be injected", async () => {
    const customResolver: ConflictResolver = {
      name: "first-version",
      resolve: (conflicts) =>
        conflicts.map<Resolution>((c) => ({
          pairId: c.pairId,
          namespace: c.namespace,
          key: c.key,
          winnerVersion: 1,
        })),
    };
    const tp = makePair(undefined, customResolver);
    const { pairId } = await setupTwoMembers(tp);
    await tp.setSharedState(pairId, "alice", "favorite", "pizza");
    await tp.setSharedState(pairId, "bob", "favorite", "sushi");
    const result = await tp.resolveConflicts(pairId);
    expect(result.resolved).toBe(1);
    await tp.close();
  });

  it("set_shared_state creates monotonic versions", async () => {
    const tp = makePair();
    const { pairId } = await setupTwoMembers(tp);
    const r1 = await tp.setSharedState(pairId, "alice", "favorite", "pizza");
    const r2 = await tp.setSharedState(pairId, "bob", "favorite", "sushi");
    const r3 = await tp.setSharedState(pairId, "alice", "favorite", "ramen");
    expect(r1.version).toBe(1);
    expect(r2.version).toBe(2);
    expect(r3.version).toBe(3);
    await tp.close();
  });

  it("overwriting marks the previous active row with valid_to (bi-temporal)", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const tp = makePair(() => now);
    const { pairId } = await setupTwoMembers(tp);
    await tp.setSharedState(pairId, "alice", "favorite", "pizza");
    now = new Date("2026-01-02T00:00:00Z");
    await tp.setSharedState(pairId, "bob", "favorite", "sushi");
    const history = await tp.getPairStateHistory(pairId, "default", "favorite");
    expect(history).toHaveLength(2);
    expect(history[0]?.validTo).toBe("2026-01-02T00:00:00.000Z");
    expect(history[1]?.validTo).toBeNull();
    await tp.close();
  });

  it("namespace isolation: writes in one namespace don't conflict with another", async () => {
    const tp = makePair();
    const { pairId } = await setupTwoMembers(tp);
    await tp.setSharedState(pairId, "alice", "key", 1, "meals");
    await tp.setSharedState(pairId, "bob", "key", 2, "tastes");
    const meals = await tp.getSharedState(pairId, "meals");
    const tastes = await tp.getSharedState(pairId, "tastes");
    expect(meals.state["key"]).toBe(1);
    expect(tastes.state["key"]).toBe(2);
    const conflicts = await tp.listConflicts(pairId);
    expect(conflicts).toHaveLength(0);
    await tp.close();
  });

  it("listConflicts surfaces multi-version keys", async () => {
    const tp = makePair();
    const { pairId } = await setupTwoMembers(tp);
    await tp.setSharedState(pairId, "alice", "favorite", "pizza");
    await tp.setSharedState(pairId, "bob", "favorite", "sushi");
    const conflicts = await tp.listConflicts(pairId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.candidates).toHaveLength(2);
    await tp.close();
  });

  it("resolveConflicts is idempotent", async () => {
    const tp = makePair();
    const { pairId } = await setupTwoMembers(tp);
    await tp.setSharedState(pairId, "alice", "favorite", "pizza");
    await tp.setSharedState(pairId, "bob", "favorite", "sushi");
    const first = await tp.resolveConflicts(pairId);
    const second = await tp.resolveConflicts(pairId);
    expect(first.resolved).toBe(1);
    expect(second.resolved).toBe(0);
    expect(second.remaining).toBe(0);
    await tp.close();
  });

  it("resolver interface contract: resolutions reference the conflict's pairId+namespace+key", () => {
    const lww = new LWWResolver();
    const conflicts: Conflict[] = [
      {
        pairId: "pair-X",
        namespace: "meals",
        key: "tonight",
        candidates: [
          {
            pairId: "pair-X",
            namespace: "meals",
            key: "tonight",
            value: "pizza",
            writtenByMemberId: "alice",
            validFrom: "2026-01-01T00:00:00Z",
            validTo: null,
            version: 1,
          },
        ],
      },
    ];
    const res = lww.resolve(conflicts);
    expect(res[0]).toMatchObject({
      pairId: "pair-X",
      namespace: "meals",
      key: "tonight",
    });
  });

  it("batch resolve over multiple keys returns one resolution per conflict group", async () => {
    const tp = makePair();
    const { pairId } = await setupTwoMembers(tp);
    await tp.setSharedState(pairId, "alice", "k1", "a1");
    await tp.setSharedState(pairId, "bob", "k1", "b1");
    await tp.setSharedState(pairId, "alice", "k2", "a2");
    await tp.setSharedState(pairId, "bob", "k2", "b2");
    const result = await tp.resolveConflicts(pairId);
    expect(result.resolved).toBe(2);
    await tp.close();
  });

  it("conflict-free single-write does not appear in conflict list", async () => {
    const tp = makePair();
    const { pairId } = await setupTwoMembers(tp);
    await tp.setSharedState(pairId, "alice", "loner", 42);
    const conflicts = await tp.listConflicts(pairId);
    expect(conflicts).toHaveLength(0);
    await tp.close();
  });

  it("LWWResolver throws on empty candidate list (defensive)", () => {
    const lww = new LWWResolver();
    expect(() =>
      lww.resolve([{ pairId: "p", namespace: "ns", key: "k", candidates: [] }]),
    ).toThrow();
  });
});
