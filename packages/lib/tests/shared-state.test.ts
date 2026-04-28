import { describe, expect, it } from "vitest";
import { SqliteTenantStore, TenantPair } from "../src/index.js";

async function setup(): Promise<{ tp: TenantPair; pairId: string }> {
  const tp = new TenantPair({ store: new SqliteTenantStore() });
  const { pairId, inviteToken } = await tp.createPair({ creatorMemberId: "alice" });
  await tp.acceptInvite({ inviteToken, memberId: "bob" });
  return { tp, pairId };
}

describe("shared state", () => {
  it("set + get round-trip in default namespace", async () => {
    const { tp, pairId } = await setup();
    await tp.setSharedState(pairId, "alice", "tonight", "pizza");
    const result = await tp.getSharedState(pairId);
    expect(result.state["tonight"]).toBe("pizza");
    expect(result.version).toBe(1);
    await tp.close();
  });

  it("default namespace is 'default' when none provided", async () => {
    const { tp, pairId } = await setup();
    await tp.setSharedState(pairId, "alice", "k", "v");
    const explicit = await tp.getSharedState(pairId, "default");
    expect(explicit.state["k"]).toBe("v");
    await tp.close();
  });

  it("version is monotonic per (namespace, key)", async () => {
    const { tp, pairId } = await setup();
    const r1 = await tp.setSharedState(pairId, "alice", "k", 1);
    const r2 = await tp.setSharedState(pairId, "alice", "k", 2);
    const r3 = await tp.setSharedState(pairId, "alice", "k", 3);
    expect(r1.version).toBe(1);
    expect(r2.version).toBe(2);
    expect(r3.version).toBe(3);
    await tp.close();
  });

  it("written_by_member_id tracked in history", async () => {
    const { tp, pairId } = await setup();
    await tp.setSharedState(pairId, "alice", "k", "a");
    await tp.setSharedState(pairId, "bob", "k", "b");
    const history = await tp.getPairStateHistory(pairId, "default", "k");
    expect(history.map((r) => r.writtenByMemberId)).toEqual(["alice", "bob"]);
    await tp.close();
  });

  it("all members can read the same shared state", async () => {
    const { tp, pairId } = await setup();
    await tp.setSharedState(pairId, "alice", "k", "v");
    const reader = await tp.getSharedState(pairId);
    expect(reader.state["k"]).toBe("v");
    await tp.close();
  });

  it("kicked member's writes remain visible in shared state", async () => {
    const { tp, pairId } = await setup();
    await tp.setSharedState(pairId, "bob", "k", "bob-was-here");
    await tp.kickMember(pairId, "alice", "bob");
    const result = await tp.getSharedState(pairId);
    expect(result.state["k"]).toBe("bob-was-here");
    await tp.close();
  });

  it("left member's writes remain visible in shared state", async () => {
    const { tp, pairId } = await setup();
    await tp.setSharedState(pairId, "bob", "k", "bob-was-here");
    await tp.leavePair(pairId, "bob");
    const result = await tp.getSharedState(pairId);
    expect(result.state["k"]).toBe("bob-was-here");
    await tp.close();
  });

  it("multiple namespaces are isolated in get_shared_state output", async () => {
    const { tp, pairId } = await setup();
    await tp.setSharedState(pairId, "alice", "k", "default-value");
    await tp.setSharedState(pairId, "alice", "k", "meals-value", "meals");
    const def = await tp.getSharedState(pairId, "default");
    const meals = await tp.getSharedState(pairId, "meals");
    expect(def.state["k"]).toBe("default-value");
    expect(meals.state["k"]).toBe("meals-value");
    await tp.close();
  });
});
