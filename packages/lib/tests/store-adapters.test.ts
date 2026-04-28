import { describe, expect, it } from "vitest";
import {
  PostgresTenantStore,
  SqliteTenantStore,
  TenantPair,
} from "../src/index.js";
import type { PgQueryable } from "../src/store/postgres.js";

describe("store adapters", () => {
  it("SqliteTenantStore initialises a fresh in-memory database", () => {
    const store = new SqliteTenantStore();
    store.init();
    // re-running init is a no-op
    store.init();
    store.close();
  });

  it("SqliteTenantStore supports an in-memory pair lifecycle", async () => {
    const tp = new TenantPair({ store: new SqliteTenantStore() });
    const { pairId } = await tp.createPair({ creatorMemberId: "alice" });
    expect(pairId).toBeTruthy();
    await tp.close();
  });

  it("SqliteTenantStore migrations are idempotent across reopen", async () => {
    const path = `:memory:`;
    const a = new SqliteTenantStore({ path });
    a.init();
    a.close();
    const b = new SqliteTenantStore({ path });
    b.init();
    b.close();
  });

  it("PostgresTenantStore issues parameterised SQL via the pg-like client", async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const pool: PgQueryable = {
      async query<R = unknown>(text: string, params?: unknown[]) {
        calls.push({ text, params });
        if (text.includes("FROM public.pairs WHERE pair_id")) {
          return {
            rows: [
              {
                pair_id: "p1",
                display_name: null,
                created_at: "2026-01-01T00:00:00Z",
                schema_version: 1,
              },
            ] as unknown as R[],
          };
        }
        return { rows: [] as R[] };
      },
    };
    const store = new PostgresTenantStore({ pool });
    await store.init();
    expect(calls.some((c) => c.text.includes("CREATE TABLE IF NOT EXISTS public.pairs"))).toBe(true);
    const fetched = await store.getPair("p1");
    expect(fetched?.pairId).toBe("p1");
  });

  it("PostgresTenantStore honours custom schema option", async () => {
    const calls: string[] = [];
    const pool: PgQueryable = {
      async query<R = unknown>(text: string) {
        calls.push(text);
        return { rows: [] as R[] };
      },
    };
    const store = new PostgresTenantStore({ pool, schema: "tenant" });
    await store.init();
    expect(calls.some((sql) => sql.includes("tenant.pairs"))).toBe(true);
  });

  it("PostgresTenantStore close calls pool.end when present", async () => {
    let endCalled = false;
    const pool: PgQueryable = {
      async query<R = unknown>() {
        return { rows: [] as R[] };
      },
      async end() {
        endCalled = true;
      },
    };
    const store = new PostgresTenantStore({ pool });
    await store.close();
    expect(endCalled).toBe(true);
  });
});
