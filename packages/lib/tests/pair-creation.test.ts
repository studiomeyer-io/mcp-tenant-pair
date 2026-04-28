import { describe, expect, it } from "vitest";
import { SqliteTenantStore, TenantPair, SCHEMA_VERSION } from "../src/index.js";

function makePair(): TenantPair {
  return new TenantPair({ store: new SqliteTenantStore() });
}

describe("create_pair", () => {
  it("creates a pair and emits an invite token (happy path)", async () => {
    const tp = makePair();
    const result = await tp.createPair({ creatorMemberId: "alice" });
    expect(result.pairId).toBeTruthy();
    expect(result.inviteToken).toBeTruthy();
    expect(result.inviteToken).toContain(".");
    await tp.close();
  });

  it("records the creator as the only active member with role=owner", async () => {
    const tp = makePair();
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    const members = await tp.listMembers(pairId);
    expect(members).toHaveLength(1);
    expect(members[0]?.memberId).toBe("alice");
    expect(members[0]?.role).toBe("owner");
    await tp.close();
  });

  it("accepts an optional displayName", async () => {
    const tp = makePair();
    const { pairId } = await tp.createPair({
      creatorMemberId: "alice",
      displayName: "Alice & Bob",
    });
    const members = await tp.listMembers(pairId);
    expect(members[0]?.displayName).toBe("Alice & Bob");
    await tp.close();
  });

  it("rejects creating a duplicate pair with the same id (idempotency at store level)", async () => {
    const store = new SqliteTenantStore();
    const tp = new TenantPair({
      store,
      idFactory: { pairId: () => "fixed-pair", inviteToken: () => "tok-1" },
    });
    await tp.createPair({ creatorMemberId: "alice" });
    await expect(tp.createPair({ creatorMemberId: "carol" })).rejects.toThrow();
    await tp.close();
  });

  it("uses uuid-format pair ids by default", async () => {
    const tp = makePair();
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    expect(pairId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    await tp.close();
  });

  it("generates unique invite tokens across calls", async () => {
    const tp = makePair();
    const a = await tp.createPair({ creatorMemberId: "a" });
    const b = await tp.createPair({ creatorMemberId: "b" });
    expect(a.inviteToken).not.toBe(b.inviteToken);
    await tp.close();
  });

  it("persists schema_version on the pair record", async () => {
    const store = new SqliteTenantStore();
    const tp = new TenantPair({ store });
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    const pair = await store.getPair(pairId);
    expect(pair?.schemaVersion).toBe(SCHEMA_VERSION);
    await tp.close();
  });

  it("allows the same memberId across different pairs", async () => {
    const tp = makePair();
    const a = await tp.createPair({ creatorMemberId: "shared" });
    const b = await tp.createPair({ creatorMemberId: "shared" });
    const aMembers = await tp.listMembers(a.pairId);
    const bMembers = await tp.listMembers(b.pairId);
    expect(aMembers[0]?.memberId).toBe("shared");
    expect(bMembers[0]?.memberId).toBe("shared");
    expect(a.pairId).not.toBe(b.pairId);
    await tp.close();
  });
});
