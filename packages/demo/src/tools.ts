import { z } from "zod";
import {
  type ConflictResolver,
  LWWResolver,
  ManualResolver,
  type TenantPair,
} from "mcp-tenant-pair";

const PairIdShape = z.string().min(1).max(64);
const MemberIdShape = z.string().min(1).max(64);
const InviteTokenShape = z.string().min(8).max(256);
const NamespaceShape = z.string().min(1).max(64).optional();
const KeyShape = z.string().min(1).max(128);

export const CreatePairInputShape = {
  creatorMemberId: MemberIdShape,
  displayName: z.string().min(1).max(120).optional(),
};

export const InviteMemberInputShape = {
  pairId: PairIdShape,
  inviterMemberId: MemberIdShape,
  inviteeHint: z.string().min(1).max(200).optional(),
  ttlSeconds: z.number().int().positive().max(60 * 60 * 24 * 30).optional(),
};

export const AcceptInviteInputShape = {
  inviteToken: InviteTokenShape,
  memberId: MemberIdShape,
  displayName: z.string().min(1).max(120).optional(),
};

export const ListMembersInputShape = {
  pairId: PairIdShape,
};

export const SetMemberPreferencesInputShape = {
  pairId: PairIdShape,
  memberId: MemberIdShape,
  key: KeyShape,
  value: z.unknown(),
};

export const GetMemberConstraintsInputShape = {
  pairId: PairIdShape,
  memberId: MemberIdShape,
  keys: z.array(KeyShape).optional(),
};

export const GetSharedStateInputShape = {
  pairId: PairIdShape,
  namespace: NamespaceShape,
};

export const SetSharedStateInputShape = {
  pairId: PairIdShape,
  memberId: MemberIdShape,
  namespace: NamespaceShape,
  key: KeyShape,
  value: z.unknown(),
};

export const ResolveConflictsInputShape = {
  pairId: PairIdShape,
  namespace: NamespaceShape,
  strategy: z.enum(["lww", "manual"]).optional(),
};

export const KickMemberInputShape = {
  pairId: PairIdShape,
  actingMemberId: MemberIdShape,
  targetMemberId: MemberIdShape,
  reason: z.string().min(1).max(500).optional(),
};

export const LeavePairInputShape = {
  pairId: PairIdShape,
  memberId: MemberIdShape,
};

export const ForgetMemberInputShape = {
  pairId: PairIdShape,
  memberId: MemberIdShape,
};

export interface ToolDescriptor<S extends z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: S;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
  };
  handler: (
    args: z.infer<z.ZodObject<S>>,
    pair: TenantPair,
  ) => Promise<Record<string, unknown>>;
}

function jsonResult(value: Record<string, unknown>): Record<string, unknown> {
  return value;
}

/**
 * Re-throws an error. Both branches throw — the function exists only to mark
 * the error path explicitly in handler bodies. Closes Cold-Cross F8 (the
 * previous version had a redundant `if (err instanceof TenantPairError)`
 * branch that did exactly the same thing as the fallback).
 */
function asError(err: unknown): never {
  throw err;
}

export const tools: Array<ToolDescriptor<z.ZodRawShape>> = [
  {
    name: "create_pair",
    description:
      "Create a new pair. The creator becomes owner. Returns pairId and the first invite token.",
    inputSchema: CreatePairInputShape,
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (args, pair) => {
      const parsed = z.object(CreatePairInputShape).parse(args);
      try {
        const result = await pair.createPair(parsed);
        return jsonResult(result as unknown as Record<string, unknown>);
      } catch (err) {
        asError(err);
      }
    },
  },
  {
    name: "invite_member",
    description:
      "Generate an invite token. Only an active member of the pair may invite. Caps pending invites per pair.",
    inputSchema: InviteMemberInputShape,
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (args, pair) => {
      const parsed = z.object(InviteMemberInputShape).parse(args);
      try {
        const result = await pair.inviteMember(parsed);
        return jsonResult(result as unknown as Record<string, unknown>);
      } catch (err) {
        asError(err);
      }
    },
  },
  {
    name: "accept_invite",
    description:
      "Redeem an invite token to join a pair. Idempotent rejection on double-accept and expired tokens.",
    inputSchema: AcceptInviteInputShape,
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (args, pair) => {
      const parsed = z.object(AcceptInviteInputShape).parse(args);
      try {
        const result = await pair.acceptInvite(parsed);
        return jsonResult(result as unknown as Record<string, unknown>);
      } catch (err) {
        asError(err);
      }
    },
  },
  {
    name: "list_members",
    description: "List all active members of a pair (excludes members who left or were kicked).",
    inputSchema: ListMembersInputShape,
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (args, pair) => {
      const parsed = z.object(ListMembersInputShape).parse(args);
      try {
        const members = await pair.listMembers(parsed.pairId);
        return jsonResult({ members } as unknown as Record<string, unknown>);
      } catch (err) {
        asError(err);
      }
    },
  },
  {
    name: "set_member_preferences",
    description:
      "Set a per-user preference (e.g. allergy, taste). Only readable by the same member via get_member_constraints.",
    inputSchema: SetMemberPreferencesInputShape,
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (args, pair) => {
      const parsed = z.object(SetMemberPreferencesInputShape).parse(args);
      try {
        const result = await pair.setMemberPreference(
          parsed.pairId,
          parsed.memberId,
          parsed.key,
          parsed.value,
        );
        return jsonResult({ ok: true, validFrom: result.validFrom });
      } catch (err) {
        asError(err);
      }
    },
  },
  {
    name: "get_member_constraints",
    description:
      "Read per-user state. A member can only read their own state; cross-member reads are not exposed.",
    inputSchema: GetMemberConstraintsInputShape,
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (args, pair) => {
      const parsed = z.object(GetMemberConstraintsInputShape).parse(args);
      try {
        const constraints = await pair.getMemberConstraints(
          parsed.pairId,
          parsed.memberId,
          parsed.keys,
        );
        return jsonResult({ constraints });
      } catch (err) {
        asError(err);
      }
    },
  },
  {
    name: "get_shared_state",
    description:
      "Read shared state for the entire pair (default namespace). All members can read.",
    inputSchema: GetSharedStateInputShape,
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (args, pair) => {
      const parsed = z.object(GetSharedStateInputShape).parse(args);
      try {
        const result = await pair.getSharedState(parsed.pairId, parsed.namespace);
        return jsonResult(result as unknown as Record<string, unknown>);
      } catch (err) {
        asError(err);
      }
    },
  },
  {
    name: "set_shared_state",
    description:
      "Write shared state. Bi-temporal: previous active row gets valid_to, new row appended.",
    inputSchema: SetSharedStateInputShape,
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (args, pair) => {
      const parsed = z.object(SetSharedStateInputShape).parse(args);
      try {
        const result = await pair.setSharedState(
          parsed.pairId,
          parsed.memberId,
          parsed.key,
          parsed.value,
          parsed.namespace,
        );
        return jsonResult({ ok: true, version: result.version });
      } catch (err) {
        asError(err);
      }
    },
  },
  {
    name: "resolve_conflicts",
    description:
      "Resolve pending conflicts using LWW (default) or manual. Idempotent: re-running on a clean state is a no-op.",
    inputSchema: ResolveConflictsInputShape,
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, pair) => {
      const parsed = z.object(ResolveConflictsInputShape).parse(args);
      try {
        // Pick the resolver explicitly based on user-supplied strategy so
        // the response cannot lie about what was actually applied. Closes
        // Cold-Cross F4 — previously the strategy parameter was parsed,
        // echoed back, but never wired into the resolveConflicts call.
        const strategy = parsed.strategy ?? "lww";
        const customResolver: ConflictResolver | undefined =
          strategy === "manual" ? new ManualResolver() :
          strategy === "lww" ? new LWWResolver() :
          undefined; // "custom" passes through to the pair's default resolver
        const result = await pair.resolveConflicts(
          parsed.pairId,
          parsed.namespace,
          customResolver,
        );
        return jsonResult({
          resolved: result.resolved,
          remaining: result.remaining,
          strategy,
        });
      } catch (err) {
        asError(err);
      }
    },
  },
  {
    name: "kick_member",
    description:
      "Remove a member from a pair. Only the owner may kick. Owner cannot kick themselves.",
    inputSchema: KickMemberInputShape,
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, pair) => {
      const parsed = z.object(KickMemberInputShape).parse(args);
      try {
        const result = await pair.kickMember(
          parsed.pairId,
          parsed.actingMemberId,
          parsed.targetMemberId,
        );
        return jsonResult({ ok: true, removedMemberId: result.removedMemberId });
      } catch (err) {
        asError(err);
      }
    },
  },
  {
    name: "leave_pair",
    description: "Voluntarily leave a pair. Sets left_at; shared state remains for other members.",
    inputSchema: LeavePairInputShape,
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, pair) => {
      const parsed = z.object(LeavePairInputShape).parse(args);
      try {
        await pair.leavePair(parsed.pairId, parsed.memberId);
        return jsonResult({ ok: true });
      } catch (err) {
        asError(err);
      }
    },
  },
  {
    name: "forget_member",
    description:
      "DSGVO Art. 17 right-to-erasure: hard-delete the member's per-user state (allergies, dietary preferences, etc.) and null their display name. The membership trace (left_at marker) is retained for audit. Idempotent.",
    inputSchema: ForgetMemberInputShape,
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args, pair) => {
      const parsed = z.object(ForgetMemberInputShape).parse(args);
      try {
        await pair.forgetMember(parsed.pairId, parsed.memberId);
        return jsonResult({ ok: true });
      } catch (err) {
        asError(err);
      }
    },
  },
];
