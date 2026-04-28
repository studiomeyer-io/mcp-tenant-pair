import { describe, expect, it } from "vitest";
import { SqliteTenantStore, TenantPair, TenantPairError } from "../src/index.js";

function makePair(opts: { now?: () => Date; maxPendingInvites?: number } = {}): TenantPair {
  return new TenantPair({
    store: new SqliteTenantStore(),
    now: opts.now,
    maxPendingInvites: opts.maxPendingInvites,
  });
}

describe("invite flow", () => {
  it("invite_member returns a token and expiresAt in the future", async () => {
    const tp = makePair();
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    const inv = await tp.inviteMember({ pairId, inviterMemberId: "alice" });
    expect(inv.inviteToken).toBeTruthy();
    expect(new Date(inv.expiresAt).getTime()).toBeGreaterThan(Date.now());
    await tp.close();
  });

  it("accept_invite adds the member and reports both members", async () => {
    const tp = makePair();
    const { pairId, inviteToken } = await tp.createPair({ creatorMemberId: "alice" });
    const result = await tp.acceptInvite({ inviteToken, memberId: "bob" });
    expect(result.pairId).toBe(pairId);
    expect(result.members.map((m) => m.memberId).sort()).toEqual(["alice", "bob"]);
    await tp.close();
  });

  it("rejects acceptance after the invite has expired", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const tp = makePair({ now: () => now });
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    const inv = await tp.inviteMember({
      pairId,
      inviterMemberId: "alice",
      ttlSeconds: 60,
    });
    now = new Date("2026-01-01T00:02:00Z");
    await expect(
      tp.acceptInvite({ inviteToken: inv.inviteToken, memberId: "bob" }),
    ).rejects.toBeInstanceOf(TenantPairError);
    await tp.close();
  });

  it("rejects double-accept of the same invite", async () => {
    const tp = makePair();
    const { inviteToken } = await tp.createPair({ creatorMemberId: "alice" });
    await tp.acceptInvite({ inviteToken, memberId: "bob" });
    await expect(
      tp.acceptInvite({ inviteToken, memberId: "carol" }),
    ).rejects.toBeInstanceOf(TenantPairError);
    await tp.close();
  });

  it("rejects invites issued by a non-member", async () => {
    const tp = makePair();
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    await expect(
      tp.inviteMember({ pairId, inviterMemberId: "stranger" }),
    ).rejects.toBeInstanceOf(TenantPairError);
    await tp.close();
  });

  it("rejects invites issued after a member has left", async () => {
    const tp = makePair();
    const { pairId, inviteToken } = await tp.createPair({ creatorMemberId: "alice" });
    await tp.acceptInvite({ inviteToken, memberId: "bob" });
    await tp.leavePair(pairId, "bob");
    await expect(
      tp.inviteMember({ pairId, inviterMemberId: "bob" }),
    ).rejects.toBeInstanceOf(TenantPairError);
    await tp.close();
  });

  it("emits a base32 short code component readable over voice", async () => {
    const tp = makePair();
    const { inviteToken } = await tp.createPair({ creatorMemberId: "alice" });
    const [, shortCode] = inviteToken.split(".");
    expect(shortCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    await tp.close();
  });

  it("caps pending invites per pair", async () => {
    const tp = makePair({ maxPendingInvites: 2 });
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    // createPair already issued 1; one more allowed, third must fail
    await tp.inviteMember({ pairId, inviterMemberId: "alice" });
    await expect(
      tp.inviteMember({ pairId, inviterMemberId: "alice" }),
    ).rejects.toBeInstanceOf(TenantPairError);
    await tp.close();
  });

  it("supports kick-and-reinvite of the same member", async () => {
    const tp = makePair();
    const { pairId, inviteToken } = await tp.createPair({ creatorMemberId: "alice" });
    await tp.acceptInvite({ inviteToken, memberId: "bob" });
    await tp.kickMember(pairId, "alice", "bob");
    const reinvite = await tp.inviteMember({ pairId, inviterMemberId: "alice" });
    const result = await tp.acceptInvite({ inviteToken: reinvite.inviteToken, memberId: "bob" });
    expect(result.members.map((m) => m.memberId).sort()).toEqual(["alice", "bob"]);
    await tp.close();
  });

  it("supports leave-and-rejoin", async () => {
    const tp = makePair();
    const { pairId, inviteToken } = await tp.createPair({ creatorMemberId: "alice" });
    await tp.acceptInvite({ inviteToken, memberId: "bob" });
    await tp.leavePair(pairId, "bob");
    const reinvite = await tp.inviteMember({ pairId, inviterMemberId: "alice" });
    const result = await tp.acceptInvite({ inviteToken: reinvite.inviteToken, memberId: "bob" });
    expect(result.members.find((m) => m.memberId === "bob")).toBeTruthy();
    await tp.close();
  });
});
