import type {
  Conflict,
  InviteRecord,
  MemberId,
  MemberRecord,
  MemberStateRow,
  PairId,
  PairRecord,
  PairStateRow,
} from "../types.js";

export interface SetMemberStateInput {
  pairId: PairId;
  memberId: MemberId;
  key: string;
  value: unknown;
  validFrom: string;
}

export interface SetPairStateInput {
  pairId: PairId;
  namespace: string;
  key: string;
  value: unknown;
  writtenByMemberId: MemberId;
  validFrom: string;
}

export interface CreatePairInput {
  pairId: PairId;
  displayName: string | null;
  createdAt: string;
  schemaVersion: number;
  creator: {
    memberId: MemberId;
    displayName: string | null;
    joinedAt: string;
  };
}

export interface AddMemberInput {
  pairId: PairId;
  memberId: MemberId;
  displayName: string | null;
  joinedAt: string;
}

export interface CreateInviteInput {
  inviteToken: string;
  pairId: PairId;
  inviterMemberId: MemberId;
  inviteeHint: string | null;
  expiresAt: string;
}

export interface AcceptInviteInput {
  inviteToken: string;
  memberId: MemberId;
  acceptedAt: string;
}

export interface AcceptInviteAtomicInput {
  inviteToken: string;
  memberId: MemberId;
  displayName: string | null;
  nowIso: string;
}

export interface AcceptInviteAtomicResult {
  pairId: PairId;
  reactivated: boolean;
}

export interface TenantStore {
  init(): Promise<void> | void;
  close(): Promise<void> | void;

  createPair(input: CreatePairInput): Promise<void> | void;
  getPair(pairId: PairId): Promise<PairRecord | null> | PairRecord | null;

  addMember(input: AddMemberInput): Promise<void> | void;
  reactivateMember(pairId: PairId, memberId: MemberId, joinedAt: string): Promise<void> | void;
  removeMember(pairId: PairId, memberId: MemberId, leftAt: string): Promise<void> | void;
  listMembers(pairId: PairId, includeLeft?: boolean): Promise<MemberRecord[]> | MemberRecord[];
  getMember(pairId: PairId, memberId: MemberId): Promise<MemberRecord | null> | MemberRecord | null;

  createInvite(input: CreateInviteInput): Promise<void> | void;
  getInvite(inviteToken: string): Promise<InviteRecord | null> | InviteRecord | null;
  acceptInvite(input: AcceptInviteInput): Promise<void> | void;
  /** Atomic accept-invite: race-safe single transaction. Returns pairId + whether the member was reactivated (vs newly added). */
  acceptInviteAtomic(input: AcceptInviteAtomicInput): Promise<AcceptInviteAtomicResult> | AcceptInviteAtomicResult;
  countPendingInvites(pairId: PairId, asOf: string): Promise<number> | number;
  /** DSGVO Art. 17 erasure: hard-delete member_state for a member, null display_name. Member row remains for audit (left_at retained). */
  forgetMember(pairId: PairId, memberId: MemberId): Promise<void> | void;

  setMemberState(input: SetMemberStateInput): Promise<void> | void;
  getMemberState(
    pairId: PairId,
    memberId: MemberId,
    keys?: string[],
  ): Promise<MemberStateRow[]> | MemberStateRow[];
  getMemberStateHistory(
    pairId: PairId,
    memberId: MemberId,
    key: string,
  ): Promise<MemberStateRow[]> | MemberStateRow[];

  setPairState(input: SetPairStateInput): Promise<{ version: number }> | { version: number };
  getPairState(
    pairId: PairId,
    namespace?: string,
  ): Promise<PairStateRow[]> | PairStateRow[];
  getPairStateHistory(
    pairId: PairId,
    namespace: string,
    key: string,
  ): Promise<PairStateRow[]> | PairStateRow[];
  listConflicts(
    pairId: PairId,
    namespace?: string,
  ): Promise<Conflict[]> | Conflict[];
  markConflictResolved(
    pairId: PairId,
    namespace: string,
    key: string,
    winnerVersion: number,
    resolvedAt: string,
  ): Promise<void> | void;
}
