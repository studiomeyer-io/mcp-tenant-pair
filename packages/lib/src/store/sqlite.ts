import Database from "better-sqlite3";
import type { Database as SqliteDb } from "better-sqlite3";
import {
  type Conflict,
  type InviteRecord,
  type MemberId,
  type MemberRecord,
  type MemberStateRow,
  type PairId,
  type PairRecord,
  type PairStateRow,
  SCHEMA_VERSION,
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

export interface SqliteTenantStoreOptions {
  /** File path or ":memory:". Defaults to ":memory:". */
  path?: string;
  /** Pre-opened Database instance (advanced). */
  db?: SqliteDb;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pairs (
  pair_id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  member_id TEXT NOT NULL,
  pair_id TEXT NOT NULL REFERENCES pairs(pair_id) ON DELETE CASCADE,
  display_name TEXT,
  joined_at TEXT NOT NULL,
  left_at TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (pair_id, member_id)
);

CREATE TABLE IF NOT EXISTS invites (
  invite_token TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL REFERENCES pairs(pair_id) ON DELETE CASCADE,
  inviter_member_id TEXT NOT NULL,
  invitee_hint TEXT,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by_member_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_invites_pair ON invites(pair_id);

CREATE TABLE IF NOT EXISTS member_state (
  pair_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  PRIMARY KEY (pair_id, member_id, key, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_member_state_active
  ON member_state(pair_id, member_id, key)
  WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS pair_state (
  pair_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  written_by_member_id TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  version INTEGER NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (pair_id, namespace, key, version)
);

CREATE INDEX IF NOT EXISTS idx_pair_state_active
  ON pair_state(pair_id, namespace, key)
  WHERE valid_to IS NULL;
`;

interface PairRow {
  pair_id: string;
  display_name: string | null;
  created_at: string;
  schema_version: number;
}

interface MemberRow {
  member_id: string;
  pair_id: string;
  display_name: string | null;
  joined_at: string;
  left_at: string | null;
  role: "owner" | "member";
}

interface InviteRow {
  invite_token: string;
  pair_id: string;
  inviter_member_id: string;
  invitee_hint: string | null;
  expires_at: string;
  accepted_at: string | null;
  accepted_by_member_id: string | null;
}

interface MemberStateDbRow {
  pair_id: string;
  member_id: string;
  key: string;
  value: string;
  valid_from: string;
  valid_to: string | null;
}

interface PairStateDbRow {
  pair_id: string;
  namespace: string;
  key: string;
  value: string;
  written_by_member_id: string;
  valid_from: string;
  valid_to: string | null;
  version: number;
  resolved_at: string | null;
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function deserialize(raw: string): unknown {
  return JSON.parse(raw);
}

function mapPair(row: PairRow): PairRecord {
  return {
    pairId: row.pair_id,
    displayName: row.display_name,
    createdAt: row.created_at,
    schemaVersion: row.schema_version,
  };
}

function mapMember(row: MemberRow): MemberRecord {
  return {
    memberId: row.member_id,
    pairId: row.pair_id,
    displayName: row.display_name,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    role: row.role,
  };
}

function mapInvite(row: InviteRow): InviteRecord {
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

function mapMemberState(row: MemberStateDbRow): MemberStateRow {
  return {
    pairId: row.pair_id,
    memberId: row.member_id,
    key: row.key,
    value: deserialize(row.value),
    validFrom: row.valid_from,
    validTo: row.valid_to,
  };
}

function mapPairState(row: PairStateDbRow): PairStateRow {
  return {
    pairId: row.pair_id,
    namespace: row.namespace,
    key: row.key,
    value: deserialize(row.value),
    writtenByMemberId: row.written_by_member_id,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    version: row.version,
  };
}

export class SqliteTenantStore implements TenantStore {
  private readonly db: SqliteDb;
  private initialized = false;

  constructor(options: SqliteTenantStoreOptions = {}) {
    if (options.db) {
      this.db = options.db;
    } else {
      this.db = new Database(options.path ?? ":memory:");
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  init(): void {
    if (this.initialized) return;
    this.db.exec(SCHEMA_SQL);
    this.initialized = true;
  }

  close(): void {
    this.db.close();
  }

  createPair(input: CreatePairInput): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO pairs (pair_id, display_name, created_at, schema_version) VALUES (?, ?, ?, ?)",
        )
        .run(input.pairId, input.displayName, input.createdAt, input.schemaVersion);
      this.db
        .prepare(
          "INSERT INTO members (member_id, pair_id, display_name, joined_at, role) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          input.creator.memberId,
          input.pairId,
          input.creator.displayName,
          input.creator.joinedAt,
          "owner",
        );
    });
    tx();
  }

  getPair(pairId: PairId): PairRecord | null {
    const row = this.db
      .prepare("SELECT * FROM pairs WHERE pair_id = ?")
      .get(pairId) as PairRow | undefined;
    return row ? mapPair(row) : null;
  }

  addMember(input: AddMemberInput): void {
    this.db
      .prepare(
        "INSERT INTO members (member_id, pair_id, display_name, joined_at, role) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        input.memberId,
        input.pairId,
        input.displayName,
        input.joinedAt,
        "member",
      );
  }

  reactivateMember(pairId: PairId, memberId: MemberId, joinedAt: string): void {
    this.db
      .prepare(
        "UPDATE members SET left_at = NULL, joined_at = ? WHERE pair_id = ? AND member_id = ? AND left_at IS NOT NULL",
      )
      .run(joinedAt, pairId, memberId);
  }

  removeMember(pairId: PairId, memberId: MemberId, leftAt: string): void {
    this.db
      .prepare(
        "UPDATE members SET left_at = ? WHERE pair_id = ? AND member_id = ? AND left_at IS NULL",
      )
      .run(leftAt, pairId, memberId);
  }

  listMembers(pairId: PairId, includeLeft = false): MemberRecord[] {
    const sql = includeLeft
      ? "SELECT * FROM members WHERE pair_id = ? ORDER BY joined_at ASC"
      : "SELECT * FROM members WHERE pair_id = ? AND left_at IS NULL ORDER BY joined_at ASC";
    const rows = this.db.prepare(sql).all(pairId) as MemberRow[];
    return rows.map(mapMember);
  }

  getMember(pairId: PairId, memberId: MemberId): MemberRecord | null {
    const row = this.db
      .prepare("SELECT * FROM members WHERE pair_id = ? AND member_id = ?")
      .get(pairId, memberId) as MemberRow | undefined;
    return row ? mapMember(row) : null;
  }

  createInvite(input: CreateInviteInput): void {
    this.db
      .prepare(
        "INSERT INTO invites (invite_token, pair_id, inviter_member_id, invitee_hint, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        input.inviteToken,
        input.pairId,
        input.inviterMemberId,
        input.inviteeHint,
        input.expiresAt,
      );
  }

  getInvite(inviteToken: string): InviteRecord | null {
    const row = this.db
      .prepare("SELECT * FROM invites WHERE invite_token = ?")
      .get(inviteToken) as InviteRow | undefined;
    return row ? mapInvite(row) : null;
  }

  acceptInvite(input: AcceptInviteInput): void {
    this.db
      .prepare(
        "UPDATE invites SET accepted_at = ?, accepted_by_member_id = ? WHERE invite_token = ? AND accepted_at IS NULL",
      )
      .run(input.acceptedAt, input.memberId, input.inviteToken);
  }

  acceptInviteAtomic(input: AcceptInviteAtomicInput): AcceptInviteAtomicResult {
    // better-sqlite3 transactions are synchronous + atomic. Wraps the full
    // accept-invite sequence so two concurrent callers cannot both pass the
    // accepted_at check and both add the same member. The IMMEDIATE mode
    // acquires a RESERVED lock on first write — here that's the UPDATE on
    // invites — preventing a second tx from racing past the same check.
    const tx = this.db.transaction((): AcceptInviteAtomicResult => {
      const inviteRow = this.db
        .prepare("SELECT * FROM invites WHERE invite_token = ?")
        .get(input.inviteToken) as InviteRow | undefined;
      if (!inviteRow) throw new Error("INVITE_NOT_FOUND");
      if (inviteRow.accepted_at) throw new Error("INVITE_ALREADY_ACCEPTED");
      if (inviteRow.expires_at < input.nowIso) throw new Error("INVITE_EXPIRED");
      const existingRow = this.db
        .prepare("SELECT * FROM members WHERE pair_id = ? AND member_id = ?")
        .get(inviteRow.pair_id, input.memberId) as MemberRow | undefined;
      if (existingRow && !existingRow.left_at) throw new Error("ALREADY_MEMBER");
      let reactivated = false;
      if (!existingRow) {
        this.db
          .prepare(
            "INSERT INTO members (member_id, pair_id, display_name, joined_at, role) VALUES (?, ?, ?, ?, ?)",
          )
          .run(input.memberId, inviteRow.pair_id, input.displayName, input.nowIso, "member");
      } else {
        this.db
          .prepare(
            "UPDATE members SET left_at = NULL, joined_at = ? WHERE pair_id = ? AND member_id = ? AND left_at IS NOT NULL",
          )
          .run(input.nowIso, inviteRow.pair_id, input.memberId);
        reactivated = true;
      }
      const updated = this.db
        .prepare(
          "UPDATE invites SET accepted_at = ?, accepted_by_member_id = ? WHERE invite_token = ? AND accepted_at IS NULL",
        )
        .run(input.nowIso, input.memberId, input.inviteToken);
      // changes() must be 1 — if 0, a concurrent tx accepted first.
      if (updated.changes !== 1) throw new Error("INVITE_ALREADY_ACCEPTED");
      return { pairId: inviteRow.pair_id, reactivated };
    });
    return tx.immediate();
  }

  countPendingInvites(pairId: PairId, asOf: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM invites WHERE pair_id = ? AND accepted_at IS NULL AND expires_at > ?",
      )
      .get(pairId, asOf) as { c: number };
    return row.c;
  }

  forgetMember(pairId: PairId, memberId: MemberId): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM member_state WHERE pair_id = ? AND member_id = ?")
        .run(pairId, memberId);
      this.db
        .prepare(
          "UPDATE members SET display_name = NULL WHERE pair_id = ? AND member_id = ?",
        )
        .run(pairId, memberId);
    });
    tx();
  }

  setMemberState(input: SetMemberStateInput): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE member_state SET valid_to = ? WHERE pair_id = ? AND member_id = ? AND key = ? AND valid_to IS NULL",
        )
        .run(input.validFrom, input.pairId, input.memberId, input.key);
      this.db
        .prepare(
          "INSERT INTO member_state (pair_id, member_id, key, value, valid_from) VALUES (?, ?, ?, ?, ?)",
        )
        .run(input.pairId, input.memberId, input.key, serialize(input.value), input.validFrom);
    });
    tx();
  }

  getMemberState(
    pairId: PairId,
    memberId: MemberId,
    keys?: string[],
  ): MemberStateRow[] {
    if (keys && keys.length > 0) {
      const placeholders = keys.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT * FROM member_state WHERE pair_id = ? AND member_id = ? AND valid_to IS NULL AND key IN (${placeholders})`,
        )
        .all(pairId, memberId, ...keys) as MemberStateDbRow[];
      return rows.map(mapMemberState);
    }
    const rows = this.db
      .prepare(
        "SELECT * FROM member_state WHERE pair_id = ? AND member_id = ? AND valid_to IS NULL",
      )
      .all(pairId, memberId) as MemberStateDbRow[];
    return rows.map(mapMemberState);
  }

  getMemberStateHistory(
    pairId: PairId,
    memberId: MemberId,
    key: string,
  ): MemberStateRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM member_state WHERE pair_id = ? AND member_id = ? AND key = ? ORDER BY valid_from ASC",
      )
      .all(pairId, memberId, key) as MemberStateDbRow[];
    return rows.map(mapMemberState);
  }

  setPairState(input: SetPairStateInput): { version: number } {
    let assignedVersion = 0;
    const tx = this.db.transaction(() => {
      const maxRow = this.db
        .prepare(
          "SELECT MAX(version) AS v FROM pair_state WHERE pair_id = ? AND namespace = ? AND key = ?",
        )
        .get(input.pairId, input.namespace, input.key) as { v: number | null };
      assignedVersion = (maxRow.v ?? 0) + 1;
      this.db
        .prepare(
          "UPDATE pair_state SET valid_to = ? WHERE pair_id = ? AND namespace = ? AND key = ? AND valid_to IS NULL",
        )
        .run(input.validFrom, input.pairId, input.namespace, input.key);
      this.db
        .prepare(
          "INSERT INTO pair_state (pair_id, namespace, key, value, written_by_member_id, valid_from, version) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.pairId,
          input.namespace,
          input.key,
          serialize(input.value),
          input.writtenByMemberId,
          input.validFrom,
          assignedVersion,
        );
    });
    tx();
    return { version: assignedVersion };
  }

  getPairState(pairId: PairId, namespace?: string): PairStateRow[] {
    if (namespace !== undefined) {
      const rows = this.db
        .prepare(
          "SELECT * FROM pair_state WHERE pair_id = ? AND namespace = ? AND valid_to IS NULL ORDER BY key ASC",
        )
        .all(pairId, namespace) as PairStateDbRow[];
      return rows.map(mapPairState);
    }
    const rows = this.db
      .prepare(
        "SELECT * FROM pair_state WHERE pair_id = ? AND valid_to IS NULL ORDER BY namespace ASC, key ASC",
      )
      .all(pairId) as PairStateDbRow[];
    return rows.map(mapPairState);
  }

  getPairStateHistory(
    pairId: PairId,
    namespace: string,
    key: string,
  ): PairStateRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM pair_state WHERE pair_id = ? AND namespace = ? AND key = ? ORDER BY version ASC",
      )
      .all(pairId, namespace, key) as PairStateDbRow[];
    return rows.map(mapPairState);
  }

  listConflicts(pairId: PairId, namespace?: string): Conflict[] {
    const sql = namespace !== undefined
      ? "SELECT * FROM pair_state WHERE pair_id = ? AND namespace = ? AND resolved_at IS NULL ORDER BY namespace, key, version"
      : "SELECT * FROM pair_state WHERE pair_id = ? AND resolved_at IS NULL ORDER BY namespace, key, version";
    const rows = (namespace !== undefined
      ? (this.db.prepare(sql).all(pairId, namespace) as PairStateDbRow[])
      : (this.db.prepare(sql).all(pairId) as PairStateDbRow[]));
    const grouped = new Map<string, PairStateRow[]>();
    for (const row of rows) {
      const groupKey = `${row.namespace}::${row.key}`;
      const arr = grouped.get(groupKey) ?? [];
      arr.push(mapPairState(row));
      grouped.set(groupKey, arr);
    }
    const conflicts: Conflict[] = [];
    for (const [, candidates] of grouped) {
      if (candidates.length >= 2) {
        const first = candidates[0]!;
        conflicts.push({
          pairId: first.pairId,
          namespace: first.namespace,
          key: first.key,
          candidates,
        });
      }
    }
    return conflicts;
  }

  markConflictResolved(
    pairId: PairId,
    namespace: string,
    key: string,
    winnerVersion: number,
    resolvedAt: string,
  ): void {
    // Mark only the LOSER candidates as resolved — keep the winner row's
    // resolved_at NULL so audit-queries can distinguish "what won" from
    // "what was discarded". Closes Reviewer F2 / Cold-Cross F3.
    this.db
      .prepare(
        "UPDATE pair_state SET resolved_at = ? WHERE pair_id = ? AND namespace = ? AND key = ? AND version <> ? AND resolved_at IS NULL",
      )
      .run(resolvedAt, pairId, namespace, key, winnerVersion);
  }

  /** Internal: SCHEMA_VERSION used by migration tests. */
  static schemaVersion(): number {
    return SCHEMA_VERSION;
  }
}
