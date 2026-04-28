import {
  type Conflict,
  type InviteRecord,
  type MemberId,
  type MemberRecord,
  type MemberStateRow,
  type PairId,
  type PairRecord,
  type PairStateRow,
} from "../types.js";
import type {
  AcceptInviteAtomicInput,
  AcceptInviteAtomicResult,
  AcceptInviteInput,
  AddMemberInput,
  CreateInviteInput,
  CreatePairInput,
  SetMemberStateInput,
  SetPairStateInput,
  TenantStore,
} from "./interface.js";

/**
 * Minimal contract this adapter requires from a `pg.Pool`-like client.
 * Keeps the dependency optional and the surface small for testing with a mock.
 *
 * For race-safe `acceptInviteAtomic` the pool MUST also implement `connect()`
 * returning a per-call client (real `pg.Pool` does). Mock-pools without
 * `connect()` get a non-atomic fallback path with a console.warn.
 */
export interface PgQueryable {
  query<R = unknown>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  end?(): Promise<void>;
  connect?(): Promise<PgClient>;
}

/** Minimal `pg.PoolClient` contract for the atomic transaction path. */
export interface PgClient {
  query<R = unknown>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  release(err?: Error | boolean): void;
}

/**
 * Postgres identifier validator. Postgres allows letters, digits, underscores,
 * dollar signs, and Unicode after the first character — but we restrict to a
 * conservative ASCII subset because the schema is interpolated into DDL
 * unquoted. Length <= 63 (Postgres NAMEDATALEN — 1).
 *
 * Closes Reviewer F1 / Cold-Cross F1: SQL-injection via `schema` parameter.
 * Caller-provided schema strings are now rejected at construction time.
 */
const POSTGRES_IDENTIFIER_RE = /^[a-z_][a-z0-9_]{0,62}$/;
function validateSchemaIdentifier(schema: string): void {
  if (!POSTGRES_IDENTIFIER_RE.test(schema)) {
    throw new Error(
      `INVALID_SCHEMA_IDENTIFIER: ${schema} — must match /^[a-z_][a-z0-9_]{0,62}$/ (lowercase ASCII letters, digits, underscore; max 63 chars; cannot start with digit)`,
    );
  }
}

export interface PostgresTenantStoreOptions {
  pool: PgQueryable;
  /** Optional schema name. Defaults to "public". MUST match `/^[a-z_][a-z0-9_]{0,62}$/` — validated in constructor. */
  schema?: string;
}

const SCHEMA_SQL = (schema: string): string => `
CREATE TABLE IF NOT EXISTS ${schema}.pairs (
  pair_id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ${schema}.members (
  member_id TEXT NOT NULL,
  pair_id TEXT NOT NULL REFERENCES ${schema}.pairs(pair_id) ON DELETE CASCADE,
  display_name TEXT,
  joined_at TIMESTAMPTZ NOT NULL,
  left_at TIMESTAMPTZ,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (pair_id, member_id)
);

CREATE TABLE IF NOT EXISTS ${schema}.invites (
  invite_token TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL REFERENCES ${schema}.pairs(pair_id) ON DELETE CASCADE,
  inviter_member_id TEXT NOT NULL,
  invitee_hint TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by_member_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_invites_pair ON ${schema}.invites(pair_id);

CREATE TABLE IF NOT EXISTS ${schema}.member_state (
  pair_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  PRIMARY KEY (pair_id, member_id, key, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_member_state_active
  ON ${schema}.member_state(pair_id, member_id, key)
  WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS ${schema}.pair_state (
  pair_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  written_by_member_id TEXT NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  version INTEGER NOT NULL,
  resolved_at TIMESTAMPTZ,
  PRIMARY KEY (pair_id, namespace, key, version)
);

CREATE INDEX IF NOT EXISTS idx_pair_state_active
  ON ${schema}.pair_state(pair_id, namespace, key)
  WHERE valid_to IS NULL;
`;

export class PostgresTenantStore implements TenantStore {
  private readonly pool: PgQueryable;
  private readonly schema: string;
  private initialized = false;

  constructor(options: PostgresTenantStoreOptions) {
    this.pool = options.pool;
    this.schema = options.schema ?? "public";
    validateSchemaIdentifier(this.schema);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.pool.query(SCHEMA_SQL(this.schema));
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.pool.end) await this.pool.end();
  }

  async createPair(input: CreatePairInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.schema}.pairs (pair_id, display_name, created_at, schema_version) VALUES ($1, $2, $3, $4)`,
      [input.pairId, input.displayName, input.createdAt, input.schemaVersion],
    );
    await this.pool.query(
      `INSERT INTO ${this.schema}.members (member_id, pair_id, display_name, joined_at, role) VALUES ($1, $2, $3, $4, 'owner')`,
      [
        input.creator.memberId,
        input.pairId,
        input.creator.displayName,
        input.creator.joinedAt,
      ],
    );
  }

  async getPair(pairId: PairId): Promise<PairRecord | null> {
    const { rows } = await this.pool.query<{
      pair_id: string;
      display_name: string | null;
      created_at: string;
      schema_version: number;
    }>(`SELECT * FROM ${this.schema}.pairs WHERE pair_id = $1`, [pairId]);
    const row = rows[0];
    if (!row) return null;
    return {
      pairId: row.pair_id,
      displayName: row.display_name,
      createdAt: row.created_at,
      schemaVersion: row.schema_version,
    };
  }

  async addMember(input: AddMemberInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.schema}.members (member_id, pair_id, display_name, joined_at, role) VALUES ($1, $2, $3, $4, 'member')`,
      [input.memberId, input.pairId, input.displayName, input.joinedAt],
    );
  }

  async reactivateMember(
    pairId: PairId,
    memberId: MemberId,
    joinedAt: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.schema}.members SET left_at = NULL, joined_at = $1 WHERE pair_id = $2 AND member_id = $3 AND left_at IS NOT NULL`,
      [joinedAt, pairId, memberId],
    );
  }

  async removeMember(
    pairId: PairId,
    memberId: MemberId,
    leftAt: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.schema}.members SET left_at = $1 WHERE pair_id = $2 AND member_id = $3 AND left_at IS NULL`,
      [leftAt, pairId, memberId],
    );
  }

  async listMembers(pairId: PairId, includeLeft = false): Promise<MemberRecord[]> {
    const sql = includeLeft
      ? `SELECT * FROM ${this.schema}.members WHERE pair_id = $1 ORDER BY joined_at ASC`
      : `SELECT * FROM ${this.schema}.members WHERE pair_id = $1 AND left_at IS NULL ORDER BY joined_at ASC`;
    const { rows } = await this.pool.query<{
      member_id: string;
      pair_id: string;
      display_name: string | null;
      joined_at: string;
      left_at: string | null;
      role: "owner" | "member";
    }>(sql, [pairId]);
    return rows.map((r) => ({
      memberId: r.member_id,
      pairId: r.pair_id,
      displayName: r.display_name,
      joinedAt: r.joined_at,
      leftAt: r.left_at,
      role: r.role,
    }));
  }

  async getMember(pairId: PairId, memberId: MemberId): Promise<MemberRecord | null> {
    const members = await this.listMembers(pairId, true);
    return members.find((m) => m.memberId === memberId) ?? null;
  }

  async createInvite(input: CreateInviteInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.schema}.invites (invite_token, pair_id, inviter_member_id, invitee_hint, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [
        input.inviteToken,
        input.pairId,
        input.inviterMemberId,
        input.inviteeHint,
        input.expiresAt,
      ],
    );
  }

  async getInvite(inviteToken: string): Promise<InviteRecord | null> {
    const { rows } = await this.pool.query<{
      invite_token: string;
      pair_id: string;
      inviter_member_id: string;
      invitee_hint: string | null;
      expires_at: string;
      accepted_at: string | null;
      accepted_by_member_id: string | null;
    }>(`SELECT * FROM ${this.schema}.invites WHERE invite_token = $1`, [inviteToken]);
    const row = rows[0];
    if (!row) return null;
    return {
      inviteToken: row.invite_token,
      pairId: row.pair_id,
      inviterMemberId: row.inviter_member_id,
      inviteeHint: row.invitee_hint,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      acceptedByMemberId: row.accepted_by_member_id,
    };
  }

  async acceptInvite(input: AcceptInviteInput): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.schema}.invites SET accepted_at = $1, accepted_by_member_id = $2 WHERE invite_token = $3 AND accepted_at IS NULL`,
      [input.acceptedAt, input.memberId, input.inviteToken],
    );
  }

  /**
   * Atomic accept-invite via single-connection transaction with row-locking.
   * Closes Reviewer F2 / Cold-Cross F2: TOCTOU race where two concurrent
   * callers could both pass the accepted_at check.
   *
   * Locking strategy: BEGIN → SELECT FOR UPDATE on invite row → caller is
   * serialized. The first to commit takes the slot, the second reads
   * accepted_at IS NOT NULL on its own SELECT and returns INVITE_ALREADY_ACCEPTED.
   *
   * Fallback: when the pool does NOT expose `connect()` (mock-pools in unit
   * tests), we run the non-atomic path with a console.warn — production
   * `pg.Pool` always has connect().
   */
  async acceptInviteAtomic(input: AcceptInviteAtomicInput): Promise<AcceptInviteAtomicResult> {
    if (!this.pool.connect) {
      // eslint-disable-next-line no-console
      console.warn(
        "[mcp-tenant-pair] PostgresTenantStore.acceptInviteAtomic: pool has no connect() — falling back to non-atomic sequence. Production pools must implement connect().",
      );
      return this.#acceptInviteSequenceNonAtomic(input);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inviteRes = await client.query<{
        invite_token: string;
        pair_id: string;
        accepted_at: string | null;
        expires_at: string;
      }>(
        `SELECT invite_token, pair_id, accepted_at, expires_at FROM ${this.schema}.invites WHERE invite_token = $1 FOR UPDATE`,
        [input.inviteToken],
      );
      const invite = inviteRes.rows[0];
      if (!invite) {
        await client.query("ROLLBACK");
        throw new Error("INVITE_NOT_FOUND");
      }
      if (invite.accepted_at) {
        await client.query("ROLLBACK");
        throw new Error("INVITE_ALREADY_ACCEPTED");
      }
      if (invite.expires_at < input.nowIso) {
        await client.query("ROLLBACK");
        throw new Error("INVITE_EXPIRED");
      }
      const memberRes = await client.query<{
        member_id: string;
        left_at: string | null;
      }>(
        `SELECT member_id, left_at FROM ${this.schema}.members WHERE pair_id = $1 AND member_id = $2`,
        [invite.pair_id, input.memberId],
      );
      const existing = memberRes.rows[0];
      if (existing && !existing.left_at) {
        await client.query("ROLLBACK");
        throw new Error("ALREADY_MEMBER");
      }
      let reactivated = false;
      if (!existing) {
        await client.query(
          `INSERT INTO ${this.schema}.members (member_id, pair_id, display_name, joined_at, role) VALUES ($1, $2, $3, $4, 'member')`,
          [input.memberId, invite.pair_id, input.displayName, input.nowIso],
        );
      } else {
        await client.query(
          `UPDATE ${this.schema}.members SET left_at = NULL, joined_at = $1 WHERE pair_id = $2 AND member_id = $3 AND left_at IS NOT NULL`,
          [input.nowIso, invite.pair_id, input.memberId],
        );
        reactivated = true;
      }
      const upd = await client.query(
        `UPDATE ${this.schema}.invites SET accepted_at = $1, accepted_by_member_id = $2 WHERE invite_token = $3 AND accepted_at IS NULL`,
        [input.nowIso, input.memberId, input.inviteToken],
      );
      // pg returns affected row count via rowCount, but our minimal PgClient
      // contract only exposes rows — re-read to verify.
      const verifyRes = await client.query<{ accepted_by_member_id: string | null }>(
        `SELECT accepted_by_member_id FROM ${this.schema}.invites WHERE invite_token = $1`,
        [input.inviteToken],
      );
      void upd;
      if (verifyRes.rows[0]?.accepted_by_member_id !== input.memberId) {
        await client.query("ROLLBACK");
        throw new Error("INVITE_ALREADY_ACCEPTED");
      }
      await client.query("COMMIT");
      return { pairId: invite.pair_id, reactivated };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* swallow rollback errors after primary failure */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async #acceptInviteSequenceNonAtomic(
    input: AcceptInviteAtomicInput,
  ): Promise<AcceptInviteAtomicResult> {
    const invite = await this.getInvite(input.inviteToken);
    if (!invite) throw new Error("INVITE_NOT_FOUND");
    if (invite.acceptedAt) throw new Error("INVITE_ALREADY_ACCEPTED");
    if (invite.expiresAt < input.nowIso) throw new Error("INVITE_EXPIRED");
    const existing = await this.getMember(invite.pairId, input.memberId);
    if (existing && !existing.leftAt) throw new Error("ALREADY_MEMBER");
    let reactivated = false;
    if (!existing) {
      await this.addMember({
        pairId: invite.pairId,
        memberId: input.memberId,
        displayName: input.displayName,
        joinedAt: input.nowIso,
      });
    } else {
      await this.reactivateMember(invite.pairId, input.memberId, input.nowIso);
      reactivated = true;
    }
    await this.acceptInvite({
      inviteToken: input.inviteToken,
      memberId: input.memberId,
      acceptedAt: input.nowIso,
    });
    return { pairId: invite.pairId, reactivated };
  }

  async countPendingInvites(pairId: PairId, asOf: string): Promise<number> {
    const { rows } = await this.pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM ${this.schema}.invites WHERE pair_id = $1 AND accepted_at IS NULL AND expires_at > $2`,
      [pairId, asOf],
    );
    return Number(rows[0]?.c ?? 0);
  }

  async forgetMember(pairId: PairId, memberId: MemberId): Promise<void> {
    if (!this.pool.connect) {
      await this.pool.query(
        `DELETE FROM ${this.schema}.member_state WHERE pair_id = $1 AND member_id = $2`,
        [pairId, memberId],
      );
      await this.pool.query(
        `UPDATE ${this.schema}.members SET display_name = NULL WHERE pair_id = $1 AND member_id = $2`,
        [pairId, memberId],
      );
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM ${this.schema}.member_state WHERE pair_id = $1 AND member_id = $2`,
        [pairId, memberId],
      );
      await client.query(
        `UPDATE ${this.schema}.members SET display_name = NULL WHERE pair_id = $1 AND member_id = $2`,
        [pairId, memberId],
      );
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async setMemberState(input: SetMemberStateInput): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.schema}.member_state SET valid_to = $1 WHERE pair_id = $2 AND member_id = $3 AND key = $4 AND valid_to IS NULL`,
      [input.validFrom, input.pairId, input.memberId, input.key],
    );
    await this.pool.query(
      `INSERT INTO ${this.schema}.member_state (pair_id, member_id, key, value, valid_from) VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [input.pairId, input.memberId, input.key, JSON.stringify(input.value), input.validFrom],
    );
  }

  async getMemberState(
    pairId: PairId,
    memberId: MemberId,
    keys?: string[],
  ): Promise<MemberStateRow[]> {
    let sql = `SELECT * FROM ${this.schema}.member_state WHERE pair_id = $1 AND member_id = $2 AND valid_to IS NULL`;
    const params: unknown[] = [pairId, memberId];
    if (keys && keys.length > 0) {
      sql += ` AND key = ANY($3::text[])`;
      params.push(keys);
    }
    const { rows } = await this.pool.query<{
      pair_id: string;
      member_id: string;
      key: string;
      value: unknown;
      valid_from: string;
      valid_to: string | null;
    }>(sql, params);
    return rows.map((r) => ({
      pairId: r.pair_id,
      memberId: r.member_id,
      key: r.key,
      value: r.value,
      validFrom: r.valid_from,
      validTo: r.valid_to,
    }));
  }

  async getMemberStateHistory(
    pairId: PairId,
    memberId: MemberId,
    key: string,
  ): Promise<MemberStateRow[]> {
    const { rows } = await this.pool.query<{
      pair_id: string;
      member_id: string;
      key: string;
      value: unknown;
      valid_from: string;
      valid_to: string | null;
    }>(
      `SELECT * FROM ${this.schema}.member_state WHERE pair_id = $1 AND member_id = $2 AND key = $3 ORDER BY valid_from ASC`,
      [pairId, memberId, key],
    );
    return rows.map((r) => ({
      pairId: r.pair_id,
      memberId: r.member_id,
      key: r.key,
      value: r.value,
      validFrom: r.valid_from,
      validTo: r.valid_to,
    }));
  }

  async setPairState(input: SetPairStateInput): Promise<{ version: number }> {
    const versionResult = await this.pool.query<{ v: number | null }>(
      `SELECT MAX(version)::int AS v FROM ${this.schema}.pair_state WHERE pair_id = $1 AND namespace = $2 AND key = $3`,
      [input.pairId, input.namespace, input.key],
    );
    const assignedVersion = (versionResult.rows[0]?.v ?? 0) + 1;
    await this.pool.query(
      `UPDATE ${this.schema}.pair_state SET valid_to = $1 WHERE pair_id = $2 AND namespace = $3 AND key = $4 AND valid_to IS NULL`,
      [input.validFrom, input.pairId, input.namespace, input.key],
    );
    await this.pool.query(
      `INSERT INTO ${this.schema}.pair_state (pair_id, namespace, key, value, written_by_member_id, valid_from, version) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
      [
        input.pairId,
        input.namespace,
        input.key,
        JSON.stringify(input.value),
        input.writtenByMemberId,
        input.validFrom,
        assignedVersion,
      ],
    );
    return { version: assignedVersion };
  }

  async getPairState(pairId: PairId, namespace?: string): Promise<PairStateRow[]> {
    let sql = `SELECT * FROM ${this.schema}.pair_state WHERE pair_id = $1 AND valid_to IS NULL`;
    const params: unknown[] = [pairId];
    if (namespace !== undefined) {
      sql += ` AND namespace = $2`;
      params.push(namespace);
    }
    sql += ` ORDER BY namespace ASC, key ASC`;
    const { rows } = await this.pool.query<{
      pair_id: string;
      namespace: string;
      key: string;
      value: unknown;
      written_by_member_id: string;
      valid_from: string;
      valid_to: string | null;
      version: number;
    }>(sql, params);
    return rows.map((r) => ({
      pairId: r.pair_id,
      namespace: r.namespace,
      key: r.key,
      value: r.value,
      writtenByMemberId: r.written_by_member_id,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      version: r.version,
    }));
  }

  async getPairStateHistory(
    pairId: PairId,
    namespace: string,
    key: string,
  ): Promise<PairStateRow[]> {
    const { rows } = await this.pool.query<{
      pair_id: string;
      namespace: string;
      key: string;
      value: unknown;
      written_by_member_id: string;
      valid_from: string;
      valid_to: string | null;
      version: number;
    }>(
      `SELECT * FROM ${this.schema}.pair_state WHERE pair_id = $1 AND namespace = $2 AND key = $3 ORDER BY version ASC`,
      [pairId, namespace, key],
    );
    return rows.map((r) => ({
      pairId: r.pair_id,
      namespace: r.namespace,
      key: r.key,
      value: r.value,
      writtenByMemberId: r.written_by_member_id,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      version: r.version,
    }));
  }

  async listConflicts(pairId: PairId, namespace?: string): Promise<Conflict[]> {
    let sql = `SELECT * FROM ${this.schema}.pair_state WHERE pair_id = $1 AND resolved_at IS NULL`;
    const params: unknown[] = [pairId];
    if (namespace !== undefined) {
      sql += ` AND namespace = $2`;
      params.push(namespace);
    }
    sql += ` ORDER BY namespace, key, version`;
    const { rows } = await this.pool.query<{
      pair_id: string;
      namespace: string;
      key: string;
      value: unknown;
      written_by_member_id: string;
      valid_from: string;
      valid_to: string | null;
      version: number;
    }>(sql, params);
    const grouped = new Map<string, PairStateRow[]>();
    for (const r of rows) {
      const groupKey = `${r.namespace}::${r.key}`;
      const arr = grouped.get(groupKey) ?? [];
      arr.push({
        pairId: r.pair_id,
        namespace: r.namespace,
        key: r.key,
        value: r.value,
        writtenByMemberId: r.written_by_member_id,
        validFrom: r.valid_from,
        validTo: r.valid_to,
        version: r.version,
      });
      grouped.set(groupKey, arr);
    }
    const out: Conflict[] = [];
    for (const [, candidates] of grouped) {
      if (candidates.length >= 2) {
        const first = candidates[0]!;
        out.push({
          pairId: first.pairId,
          namespace: first.namespace,
          key: first.key,
          candidates,
        });
      }
    }
    return out;
  }

  async markConflictResolved(
    pairId: PairId,
    namespace: string,
    key: string,
    winnerVersion: number,
    resolvedAt: string,
  ): Promise<void> {
    // Mark only the LOSER candidates as resolved — keep the winner row's
    // resolved_at NULL so audit-queries can distinguish "what won" from
    // "what was discarded". Closes Reviewer F2 / Cold-Cross F3.
    await this.pool.query(
      `UPDATE ${this.schema}.pair_state SET resolved_at = $1 WHERE pair_id = $2 AND namespace = $3 AND key = $4 AND version <> $5 AND resolved_at IS NULL`,
      [resolvedAt, pairId, namespace, key, winnerVersion],
    );
  }
}
