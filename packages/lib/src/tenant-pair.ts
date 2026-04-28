import { randomInt } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { LWWResolver } from "./resolvers/lww.js";
import type { ConflictResolver } from "./resolvers/interface.js";
import type { TenantStore } from "./store/interface.js";
import {
  type AcceptInviteOptions,
  type Conflict,
  type CreatePairOptions,
  DEFAULT_INVITE_TTL_SECONDS,
  DEFAULT_NAMESPACE,
  type InviteMemberOptions,
  type InviteToken,
  type MemberId,
  type MemberRecord,
  type PairId,
  type PairStateRow,
  SCHEMA_VERSION,
  TenantPairError,
} from "./types.js";

export interface TenantPairOptions {
  store: TenantStore;
  /** Defaults to LWWResolver */
  resolver?: ConflictResolver;
  /** Provide a deterministic clock for tests */
  now?: () => Date;
  /** Provide a deterministic id factory for tests */
  idFactory?: { pairId: () => string; inviteToken: () => string };
  /** Maximum simultaneously pending invites per pair (default 25). */
  maxPendingInvites?: number;
}

const BASE32_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * Cryptographically-secure default RNG. Uses `node:crypto.randomInt` which
 * pulls from a CSPRNG and rejects modulo bias. Closes Cold-Cross F7
 * (Math.random was predictable + brute-forceable for invite-codes spoken
 * over voice).
 */
function cryptoRng(): number {
  return randomInt(0, 0x100000000) / 0x100000000;
}

/**
 * Generate a short, human-friendly base32 id. Used as a suffix on the invite
 * token so a user can read it back over voice ("INVITE: 4HKQ-9XPT").
 *
 * Default `rng` is a crypto-secure CSPRNG. Tests may inject a deterministic
 * function (e.g., `() => 0`).
 */
export function generateShortCode(rng: () => number = cryptoRng, length = 8): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const idx = Math.floor(rng() * BASE32_ALPHABET.length);
    out += BASE32_ALPHABET[idx];
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

export class TenantPair {
  private readonly store: TenantStore;
  private readonly resolver: ConflictResolver;
  private readonly now: () => Date;
  private readonly idFactory: { pairId: () => string; inviteToken: () => string };
  private readonly maxPendingInvites: number;
  private initialized = false;

  constructor(options: TenantPairOptions) {
    this.store = options.store;
    this.resolver = options.resolver ?? new LWWResolver();
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? {
      pairId: () => uuidv4(),
      inviteToken: () => `${uuidv4()}.${generateShortCode()}`,
    };
    this.maxPendingInvites = options.maxPendingInvites ?? 25;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.store.init();
    this.initialized = true;
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  // -- Pair lifecycle ----------------------------------------------------

  async createPair(opts: CreatePairOptions): Promise<{ pairId: PairId; inviteToken: InviteToken }> {
    await this.init();
    const pairId = this.idFactory.pairId();
    const createdAt = this.now().toISOString();
    await this.store.createPair({
      pairId,
      displayName: opts.displayName ?? null,
      createdAt,
      schemaVersion: SCHEMA_VERSION,
      creator: {
        memberId: opts.creatorMemberId,
        displayName: opts.displayName ?? null,
        joinedAt: createdAt,
      },
    });
    const inviteToken = await this.inviteMember({
      pairId,
      inviterMemberId: opts.creatorMemberId,
    });
    return { pairId, inviteToken: inviteToken.inviteToken };
  }

  async inviteMember(opts: InviteMemberOptions): Promise<{ inviteToken: InviteToken; expiresAt: string }> {
    await this.init();
    const pair = await this.store.getPair(opts.pairId);
    if (!pair) throw new TenantPairError("PAIR_NOT_FOUND", `Pair ${opts.pairId} not found`);
    const inviter = await this.store.getMember(opts.pairId, opts.inviterMemberId);
    if (!inviter || inviter.leftAt) {
      throw new TenantPairError(
        "NOT_A_MEMBER",
        `Inviter ${opts.inviterMemberId} is not an active member of pair ${opts.pairId}`,
      );
    }
    const pending = await this.store.countPendingInvites(opts.pairId, this.now().toISOString());
    if (pending >= this.maxPendingInvites) {
      throw new TenantPairError(
        "TOO_MANY_PENDING_INVITES",
        `Pair ${opts.pairId} already has ${pending} pending invites (max ${this.maxPendingInvites})`,
      );
    }
    const ttl = opts.ttlSeconds ?? DEFAULT_INVITE_TTL_SECONDS;
    const expiresAt = new Date(this.now().getTime() + ttl * 1000).toISOString();
    const inviteToken = this.idFactory.inviteToken();
    await this.store.createInvite({
      inviteToken,
      pairId: opts.pairId,
      inviterMemberId: opts.inviterMemberId,
      inviteeHint: opts.inviteeHint ?? null,
      expiresAt,
    });
    return { inviteToken, expiresAt };
  }

  async acceptInvite(opts: AcceptInviteOptions): Promise<{ pairId: PairId; members: MemberRecord[] }> {
    await this.init();
    const nowIso = this.now().toISOString();
    try {
      const result = await this.store.acceptInviteAtomic({
        inviteToken: opts.inviteToken,
        memberId: opts.memberId,
        displayName: opts.displayName ?? null,
        nowIso,
      });
      const members = await this.store.listMembers(result.pairId);
      return { pairId: result.pairId, members };
    } catch (err) {
      // Translate plain Error codes from the store layer into TenantPairError.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "INVITE_NOT_FOUND") {
        throw new TenantPairError("INVITE_NOT_FOUND", "Invalid invite token");
      }
      if (msg === "INVITE_ALREADY_ACCEPTED") {
        throw new TenantPairError("INVITE_ALREADY_ACCEPTED", "Invite already accepted");
      }
      if (msg === "INVITE_EXPIRED") {
        throw new TenantPairError("INVITE_EXPIRED", "Invite expired");
      }
      if (msg === "ALREADY_MEMBER") {
        throw new TenantPairError(
          "ALREADY_MEMBER",
          `Member ${opts.memberId} is already in this pair`,
        );
      }
      throw err;
    }
  }

  async listMembers(pairId: PairId): Promise<MemberRecord[]> {
    await this.init();
    const pair = await this.store.getPair(pairId);
    if (!pair) throw new TenantPairError("PAIR_NOT_FOUND", `Pair ${pairId} not found`);
    return this.store.listMembers(pairId);
  }

  async kickMember(
    pairId: PairId,
    actingMemberId: MemberId,
    targetMemberId: MemberId,
  ): Promise<{ removedMemberId: MemberId }> {
    await this.init();
    const acting = await this.store.getMember(pairId, actingMemberId);
    if (!acting || acting.leftAt) {
      throw new TenantPairError("NOT_A_MEMBER", `Acting member ${actingMemberId} is not active`);
    }
    if (acting.role !== "owner") {
      throw new TenantPairError("FORBIDDEN", "Only owner may kick members");
    }
    if (actingMemberId === targetMemberId) {
      throw new TenantPairError("CANNOT_KICK_SELF", "Owner cannot kick self; use leavePair");
    }
    const target = await this.store.getMember(pairId, targetMemberId);
    if (!target || target.leftAt) {
      throw new TenantPairError("NOT_A_MEMBER", `Target ${targetMemberId} is not active`);
    }
    await this.store.removeMember(pairId, targetMemberId, this.now().toISOString());
    return { removedMemberId: targetMemberId };
  }

  async leavePair(pairId: PairId, memberId: MemberId): Promise<void> {
    await this.init();
    const member = await this.store.getMember(pairId, memberId);
    if (!member || member.leftAt) {
      throw new TenantPairError("NOT_A_MEMBER", `Member ${memberId} is not active in pair ${pairId}`);
    }
    await this.store.removeMember(pairId, memberId, this.now().toISOString());
  }

  /**
   * DSGVO Art. 17 right-to-erasure path. Hard-deletes the member's
   * `member_state` rows (allergies, dietary restrictions — Art. 9 special
   * categories) and nulls the `display_name`. The member row itself is
   * retained for audit (`left_at` is preserved) — only personal data is
   * erased, not the membership trace.
   *
   * Idempotent: calling on an unknown member is a no-op.
   *
   * Closes Cold-Cross F6: library was advertised for health-category data
   * but had no erasure path, blocking DSGVO compliance for downstream
   * consumers.
   */
  async forgetMember(pairId: PairId, memberId: MemberId): Promise<void> {
    await this.init();
    await this.store.forgetMember(pairId, memberId);
  }

  // -- Member-state -------------------------------------------------------

  async setMemberPreference(
    pairId: PairId,
    memberId: MemberId,
    key: string,
    value: unknown,
  ): Promise<{ validFrom: string }> {
    await this.init();
    const member = await this.store.getMember(pairId, memberId);
    if (!member || member.leftAt) {
      throw new TenantPairError("NOT_A_MEMBER", `Member ${memberId} is not active in pair ${pairId}`);
    }
    const validFrom = this.now().toISOString();
    await this.store.setMemberState({ pairId, memberId, key, value, validFrom });
    return { validFrom };
  }

  async getMemberConstraints(
    pairId: PairId,
    memberId: MemberId,
    keys?: string[],
  ): Promise<Record<string, unknown>> {
    await this.init();
    const member = await this.store.getMember(pairId, memberId);
    if (!member) {
      throw new TenantPairError("NOT_A_MEMBER", `Member ${memberId} not found in pair ${pairId}`);
    }
    const rows = await this.store.getMemberState(pairId, memberId, keys);
    const result: Record<string, unknown> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  }

  // -- Pair-state ---------------------------------------------------------

  async getSharedState(
    pairId: PairId,
    namespace?: string,
  ): Promise<{ state: Record<string, unknown>; version: number }> {
    await this.init();
    const pair = await this.store.getPair(pairId);
    if (!pair) throw new TenantPairError("PAIR_NOT_FOUND", `Pair ${pairId} not found`);
    const ns = namespace ?? DEFAULT_NAMESPACE;
    const rows = await this.store.getPairState(pairId, ns);
    const state: Record<string, unknown> = {};
    let maxVersion = 0;
    for (const row of rows) {
      state[row.key] = row.value;
      if (row.version > maxVersion) maxVersion = row.version;
    }
    return { state, version: maxVersion };
  }

  async setSharedState(
    pairId: PairId,
    memberId: MemberId,
    key: string,
    value: unknown,
    namespace?: string,
  ): Promise<{ version: number }> {
    await this.init();
    const member = await this.store.getMember(pairId, memberId);
    if (!member || member.leftAt) {
      throw new TenantPairError("NOT_A_MEMBER", `Member ${memberId} is not active in pair ${pairId}`);
    }
    const ns = namespace ?? DEFAULT_NAMESPACE;
    const validFrom = this.now().toISOString();
    return this.store.setPairState({
      pairId,
      namespace: ns,
      key,
      value,
      writtenByMemberId: memberId,
      validFrom,
    });
  }

  // -- Conflict resolution ------------------------------------------------

  async listConflicts(pairId: PairId, namespace?: string): Promise<Conflict[]> {
    await this.init();
    return this.store.listConflicts(pairId, namespace);
  }

  async resolveConflicts(
    pairId: PairId,
    namespace?: string,
    customResolver?: ConflictResolver,
  ): Promise<{ resolved: number; remaining: number }> {
    await this.init();
    const resolver = customResolver ?? this.resolver;
    const conflicts = await this.store.listConflicts(pairId, namespace);
    if (conflicts.length === 0) return { resolved: 0, remaining: 0 };
    const resolutions = await resolver.resolve(conflicts);
    const resolvedAt = this.now().toISOString();
    for (const resolution of resolutions) {
      await this.store.markConflictResolved(
        resolution.pairId,
        resolution.namespace,
        resolution.key,
        resolution.winnerVersion,
        resolvedAt,
      );
    }
    return {
      resolved: resolutions.length,
      remaining: conflicts.length - resolutions.length,
    };
  }

  // -- Inspection helpers (also used by CLI) -----------------------------

  async getPairStateHistory(
    pairId: PairId,
    namespace: string,
    key: string,
  ): Promise<PairStateRow[]> {
    await this.init();
    return this.store.getPairStateHistory(pairId, namespace, key);
  }
}
