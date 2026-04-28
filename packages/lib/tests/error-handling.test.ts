/**
 * Error-handling coverage. Every TenantPairError code that the public API can
 * surface gets at least one explicit test. We don't trust the higher-level
 * tests to incidentally cover them; downstream MCP clients dispatch on these
 * codes and a regression here is a silent breaking change.
 */
import { describe, expect, it } from "vitest";
import {
  SqliteTenantStore,
  TenantPair,
  TenantPairError,
} from "../src/index.js";

function newPair(): TenantPair {
  return new TenantPair({ store: new SqliteTenantStore({ path: ":memory:" }) });
}

async function expectError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error("expected error code " + code + " but resolved");
  } catch (err) {
    if (!(err instanceof TenantPairError)) {
      throw new Error(
        "expected TenantPairError with code " +
          code +
          " but got " +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    if (err.code !== code) {
      throw new Error(
        "expected code " + code + " but got " + err.code,
      );
    }
  }
}

describe("TenantPairError — exhaustive code coverage", () => {
  it("PAIR_NOT_FOUND on inviteMember to unknown pair", async () => {
    const tp = newPair();
    await expectError(
      tp.inviteMember({ pairId: "ghost", inviterMemberId: "alice" }),
      "PAIR_NOT_FOUND",
    );
    await tp.close();
  });

  it("NOT_A_MEMBER on inviteMember from non-member", async () => {
    const tp = newPair();
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    await expectError(
      tp.inviteMember({ pairId, inviterMemberId: "ghost" }),
      "NOT_A_MEMBER",
    );
    await tp.close();
  });

  it("INVITE_NOT_FOUND on accept of unknown token", async () => {
    const tp = newPair();
    await tp.createPair({ creatorMemberId: "alice" });
    await expectError(
      tp.acceptInvite({ inviteToken: "fake-token", memberId: "bob" }),
      "INVITE_NOT_FOUND",
    );
    await tp.close();
  });

  it("INVITE_ALREADY_ACCEPTED on second accept of same token", async () => {
    const tp = newPair();
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    const { inviteToken } = await tp.inviteMember({
      pairId,
      inviterMemberId: "alice",
    });
    await tp.acceptInvite({ inviteToken, memberId: "bob" });
    await expectError(
      tp.acceptInvite({ inviteToken, memberId: "carol" }),
      "INVITE_ALREADY_ACCEPTED",
    );
    await tp.close();
  });

  it("INVITE_EXPIRED when expires_at is past", async () => {
    let mockTime = new Date("2026-01-01T00:00:00.000Z");
    const tp = new TenantPair({
      store: new SqliteTenantStore({ path: ":memory:" }),
      now: () => mockTime,
    });
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    const { inviteToken } = await tp.inviteMember({
      pairId,
      inviterMemberId: "alice",
      ttlSeconds: 60,
    });
    mockTime = new Date("2026-01-01T01:00:00.000Z");
    await expectError(
      tp.acceptInvite({ inviteToken, memberId: "bob" }),
      "INVITE_EXPIRED",
    );
    await tp.close();
  });

  it("ALREADY_MEMBER when active member tries to accept new invite", async () => {
    const tp = newPair();
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    const inv1 = await tp.inviteMember({ pairId, inviterMemberId: "alice" });
    await tp.acceptInvite({ inviteToken: inv1.inviteToken, memberId: "bob" });
    const inv2 = await tp.inviteMember({ pairId, inviterMemberId: "alice" });
    await expectError(
      tp.acceptInvite({ inviteToken: inv2.inviteToken, memberId: "bob" }),
      "ALREADY_MEMBER",
    );
    await tp.close();
  });

  it("FORBIDDEN on non-owner kick attempt", async () => {
    const tp = newPair();
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    const inv = await tp.inviteMember({ pairId, inviterMemberId: "alice" });
    await tp.acceptInvite({ inviteToken: inv.inviteToken, memberId: "bob" });
    await expectError(
      tp.kickMember(pairId, "bob", "alice"),
      "FORBIDDEN",
    );
    await tp.close();
  });

  it("CANNOT_KICK_SELF on owner self-kick", async () => {
    const tp = newPair();
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    await expectError(
      tp.kickMember(pairId, "alice", "alice"),
      "CANNOT_KICK_SELF",
    );
    await tp.close();
  });

  it("NOT_A_MEMBER on kick of unknown target", async () => {
    const tp = newPair();
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    await expectError(
      tp.kickMember(pairId, "alice", "ghost"),
      "NOT_A_MEMBER",
    );
    await tp.close();
  });

  it("NOT_A_MEMBER on kick of already-left target", async () => {
    const tp = newPair();
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    const inv = await tp.inviteMember({ pairId, inviterMemberId: "alice" });
    await tp.acceptInvite({ inviteToken: inv.inviteToken, memberId: "bob" });
    await tp.leavePair(pairId, "bob");
    await expectError(
      tp.kickMember(pairId, "alice", "bob"),
      "NOT_A_MEMBER",
    );
    await tp.close();
  });

  it("NOT_A_MEMBER on leavePair from non-member", async () => {
    const tp = newPair();
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    await expectError(
      tp.leavePair(pairId, "ghost"),
      "NOT_A_MEMBER",
    );
    await tp.close();
  });

  it("NOT_A_MEMBER on setMemberPreference for non-member", async () => {
    const tp = newPair();
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    await expectError(
      tp.setMemberPreference(pairId, "ghost", "allergy", ["nuts"]),
      "NOT_A_MEMBER",
    );
    await tp.close();
  });

  it("NOT_A_MEMBER on setSharedState write from non-member", async () => {
    const tp = newPair();
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    await expectError(
      tp.setSharedState(pairId, "ghost", "default", "key", "value"),
      "NOT_A_MEMBER",
    );
    await tp.close();
  });

  it("PAIR_NOT_FOUND on getSharedState for unknown pair", async () => {
    const tp = newPair();
    await expectError(
      tp.getSharedState("non-existent-pair"),
      "PAIR_NOT_FOUND",
    );
    await tp.close();
  });

  it("PAIR_NOT_FOUND on listMembers for unknown pair", async () => {
    const tp = newPair();
    await expectError(
      tp.listMembers("non-existent-pair"),
      "PAIR_NOT_FOUND",
    );
    await tp.close();
  });
});

describe("TenantPairError — error metadata is stable", () => {
  it("error has both .code and .message", async () => {
    const tp = newPair();
    try {
      await tp.kickMember("ghost", "alice", "bob");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TenantPairError);
      expect((err as TenantPairError).code).toBeTypeOf("string");
      expect((err as TenantPairError).message).toBeTypeOf("string");
      expect((err as TenantPairError).message.length).toBeGreaterThan(0);
    }
    await tp.close();
  });

  it("error.name is 'TenantPairError'", async () => {
    const tp = newPair();
    try {
      await tp.leavePair("nope", "alice");
    } catch (err) {
      expect((err as Error).name).toBe("TenantPairError");
    }
    await tp.close();
  });
});
