#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { SqliteTenantStore, TenantPair } from "mcp-tenant-pair";

interface PkgShape {
  name: string;
  version: string;
}

function readPkg(): PkgShape {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "..", "package.json");
  return JSON.parse(readFileSync(path, "utf8")) as PkgShape;
}

function makePair(dbPath: string): TenantPair {
  const store = new SqliteTenantStore({ path: dbPath });
  return new TenantPair({ store });
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function buildProgram(): Command {
  const pkg = readPkg();
  const program = new Command();
  program
    .name("mcp-tenant-pair-cli")
    .description("Inspect and operate mcp-tenant-pair stores")
    .version(pkg.version)
    .option("--db <path>", "SQLite database path", "./tenant-pair.sqlite");

  const pair = program.command("pair").description("Pair lifecycle");

  pair
    .command("create")
    .description("Create a new pair")
    .requiredOption("--member <id>", "Creator member id")
    .option("--name <displayName>", "Optional display name")
    .action(async (opts: { member: string; name?: string }) => {
      const tp = makePair(program.opts<{ db: string }>().db);
      try {
        const result = await tp.createPair({
          creatorMemberId: opts.member,
          displayName: opts.name ?? null,
        });
        printJson(result);
      } finally {
        await tp.close();
      }
    });

  pair
    .command("invite")
    .description("Generate an invite token")
    .requiredOption("--pair <id>")
    .requiredOption("--by <memberId>")
    .option("--ttl <seconds>", "Lifetime in seconds")
    .action(async (opts: { pair: string; by: string; ttl?: string }) => {
      const tp = makePair(program.opts<{ db: string }>().db);
      try {
        const result = await tp.inviteMember({
          pairId: opts.pair,
          inviterMemberId: opts.by,
          ttlSeconds: opts.ttl ? Number(opts.ttl) : undefined,
        });
        printJson(result);
      } finally {
        await tp.close();
      }
    });

  pair
    .command("list-members")
    .description("List active members")
    .requiredOption("--pair <id>")
    .action(async (opts: { pair: string }) => {
      const tp = makePair(program.opts<{ db: string }>().db);
      try {
        printJson(await tp.listMembers(opts.pair));
      } finally {
        await tp.close();
      }
    });

  const member = program.command("member").description("Member preferences");

  member
    .command("set-pref")
    .description("Set a member preference")
    .requiredOption("--pair <id>")
    .requiredOption("--member <id>")
    .requiredOption("--key <key>")
    .requiredOption("--value <json>", "JSON-encoded value")
    .action(async (opts: { pair: string; member: string; key: string; value: string }) => {
      const tp = makePair(program.opts<{ db: string }>().db);
      try {
        const value: unknown = JSON.parse(opts.value);
        const result = await tp.setMemberPreference(
          opts.pair,
          opts.member,
          opts.key,
          value,
        );
        printJson(result);
      } finally {
        await tp.close();
      }
    });

  const state = program.command("state").description("Shared state");

  state
    .command("get")
    .description("Read shared state")
    .requiredOption("--pair <id>")
    .option("--namespace <ns>")
    .action(async (opts: { pair: string; namespace?: string }) => {
      const tp = makePair(program.opts<{ db: string }>().db);
      try {
        printJson(await tp.getSharedState(opts.pair, opts.namespace));
      } finally {
        await tp.close();
      }
    });

  state
    .command("set")
    .description("Write shared state")
    .requiredOption("--pair <id>")
    .requiredOption("--by <memberId>")
    .requiredOption("--key <key>")
    .requiredOption("--value <json>", "JSON-encoded value")
    .option("--namespace <ns>")
    .action(
      async (opts: {
        pair: string;
        by: string;
        key: string;
        value: string;
        namespace?: string;
      }) => {
        const tp = makePair(program.opts<{ db: string }>().db);
        try {
          const value: unknown = JSON.parse(opts.value);
          const result = await tp.setSharedState(
            opts.pair,
            opts.by,
            opts.key,
            value,
            opts.namespace,
          );
          printJson(result);
        } finally {
          await tp.close();
        }
      },
    );

  const conflict = program.command("conflict").description("Conflict inspection");

  conflict
    .command("list")
    .description("List unresolved conflicts")
    .requiredOption("--pair <id>")
    .option("--namespace <ns>")
    .action(async (opts: { pair: string; namespace?: string }) => {
      const tp = makePair(program.opts<{ db: string }>().db);
      try {
        printJson(await tp.listConflicts(opts.pair, opts.namespace));
      } finally {
        await tp.close();
      }
    });

  conflict
    .command("resolve")
    .description("Resolve conflicts using LWW")
    .requiredOption("--pair <id>")
    .option("--namespace <ns>")
    .action(async (opts: { pair: string; namespace?: string }) => {
      const tp = makePair(program.opts<{ db: string }>().db);
      try {
        printJson(await tp.resolveConflicts(opts.pair, opts.namespace));
      } finally {
        await tp.close();
      }
    });

  return program;
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  const program = buildProgram();
  program.parseAsync(process.argv).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`mcp-tenant-pair-cli error: ${message}\n`);
    process.exit(1);
  });
}
