import { describe, expect, it } from "vitest";
import { SqliteTenantStore, TenantPair, TenantPairError } from "../src/index.js";

async function setup(): Promise<{ tp: TenantPair; pairId: string }> {
  const tp = new TenantPair({ store: new SqliteTenantStore() });
  const { pairId, inviteToken } = await tp.createPair({ creatorMemberId: "alice" });
  await tp.acceptInvite({ inviteToken, memberId: "bob" });
  return { tp, pairId };
}

describe("member preferences", () => {
  it("set_member_preferences and get_member_constraints round-trip", async () => {
    const { tp, pairId } = await setup();
    await tp.setMemberPreference(pairId, "alice", "allergy", ["nuts"]);
    const result = await tp.getMemberConstraints(pairId, "alice");
    expect(result["allergy"]).toEqual(["nuts"]);
    await tp.close();
  });

  it("filtering by keys returns only requested keys", async () => {
    const { tp, pairId } = await setup();
    await tp.setMemberPreference(pairId, "alice", "allergy", ["nuts"]);
    await tp.setMemberPreference(pairId, "alice", "diet", "vegetarian");
    const subset = await tp.getMemberConstraints(pairId, "alice", ["allergy"]);
    expect(Object.keys(subset)).toEqual(["allergy"]);
    await tp.close();
  });

  it("member A and member B have isolated state (cross-member read returns nothing)", async () => {
    const { tp, pairId } = await setup();
    await tp.setMemberPreference(pairId, "alice", "secret", "alice-only");
    const bobView = await tp.getMemberConstraints(pairId, "bob");
    expect(bobView["secret"]).toBeUndefined();
    const aliceView = await tp.getMemberConstraints(pairId, "alice");
    expect(aliceView["secret"]).toBe("alice-only");
    await tp.close();
  });

  it("supports JSON-roundtrip for nested objects", async () => {
    const { tp, pairId } = await setup();
    const value = { taste: { sweet: 0.8, salty: 0.2 }, tags: ["spicy"] };
    await tp.setMemberPreference(pairId, "alice", "profile", value);
    const result = await tp.getMemberConstraints(pairId, "alice", ["profile"]);
    expect(result["profile"]).toEqual(value);
    await tp.close();
  });

  it("recording history of preference changes", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const tp = new TenantPair({
      store: new SqliteTenantStore(),
      now: () => now,
    });
    const { pairId, inviteToken } = await tp.createPair({ creatorMemberId: "alice" });
    await tp.acceptInvite({ inviteToken, memberId: "bob" });
    await tp.setMemberPreference(pairId, "alice", "allergy", ["nuts"]);
    now = new Date("2026-01-02T00:00:00Z");
    await tp.setMemberPreference(pairId, "alice", "allergy", ["nuts", "eggs"]);
    const result = await tp.getMemberConstraints(pairId, "alice");
    expect(result["allergy"]).toEqual(["nuts", "eggs"]);
    await tp.close();
  });

  it("setting null is a valid value (not a delete)", async () => {
    const { tp, pairId } = await setup();
    await tp.setMemberPreference(pairId, "alice", "diet", null);
    const result = await tp.getMemberConstraints(pairId, "alice");
    expect(result["diet"]).toBeNull();
    await tp.close();
  });

  it("rejects setMemberPreference for inactive members (after leave)", async () => {
    const { tp, pairId } = await setup();
    await tp.leavePair(pairId, "bob");
    await expect(
      tp.setMemberPreference(pairId, "bob", "diet", "vegan"),
    ).rejects.toBeInstanceOf(TenantPairError);
    await tp.close();
  });

  it("handles unknown member gracefully", async () => {
    const { tp, pairId } = await setup();
    await expect(
      tp.getMemberConstraints(pairId, "ghost"),
    ).rejects.toBeInstanceOf(TenantPairError);
    await tp.close();
  });
});
