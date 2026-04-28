import { z } from "zod";

export const PairIdSchema = z.string().min(1).max(64);
export const MemberIdSchema = z.string().min(1).max(64);
export const InviteTokenSchema = z.string().min(8).max(128);
export const NamespaceSchema = z.string().min(1).max(64).default("default");
export const KeySchema = z.string().min(1).max(128);

export type PairId = z.infer<typeof PairIdSchema>;
export type MemberId = z.infer<typeof MemberIdSchema>;
export type InviteToken = z.infer<typeof InviteTokenSchema>;

export const MemberRoleSchema = z.enum(["owner", "member"]);
export type MemberRole = z.infer<typeof MemberRoleSchema>;

export interface PairRecord {
  pairId: PairId;
  displayName: string | null;
  createdAt: string;
  schemaVersion: number;
}

export interface MemberRecord {
  memberId: MemberId;
  pairId: PairId;
  displayName: string | null;
  joinedAt: string;
  leftAt: string | null;
  role: MemberRole;
}

export interface InviteRecord {
  inviteToken: InviteToken;
  pairId: PairId;
  inviterMemberId: MemberId;
  inviteeHint: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedByMemberId: MemberId | null;
}

export interface MemberStateRow {
  memberId: MemberId;
  pairId: PairId;
  key: string;
  value: unknown;
  validFrom: string;
  validTo: string | null;
}

export interface PairStateRow {
  pairId: PairId;
  namespace: string;
  key: string;
  value: unknown;
  writtenByMemberId: MemberId;
  validFrom: string;
  validTo: string | null;
  version: number;
}

export interface Conflict {
  pairId: PairId;
  namespace: string;
  key: string;
  candidates: PairStateRow[];
}

export interface Resolution {
  pairId: PairId;
  namespace: string;
  key: string;
  winnerVersion: number;
}

export interface CreatePairOptions {
  creatorMemberId: MemberId;
  displayName?: string | null | undefined;
}

export interface InviteMemberOptions {
  pairId: PairId;
  inviterMemberId: MemberId;
  inviteeHint?: string | null | undefined;
  ttlSeconds?: number | undefined;
}

export interface AcceptInviteOptions {
  inviteToken: InviteToken;
  memberId: MemberId;
  displayName?: string | null | undefined;
}

export class TenantPairError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "TenantPairError";
  }
}

export const SCHEMA_VERSION = 1;
export const DEFAULT_INVITE_TTL_SECONDS = 60 * 60 * 24 * 7;
export const DEFAULT_NAMESPACE = "default";
