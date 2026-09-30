import { describe, expect, mock, test } from "bun:test";

// `cloudflare:workers` only exists inside workerd; stub it for unit tests under bun.
mock.module("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));

const { default: worker } = await import("../src/index");

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

/** Just enough of D1, R2 and the Durable Object namespace for the health checks. */
function fakeEnv(opts: { r2Fails?: boolean } = {}) {
  return {
    DB: { prepare: () => ({ first: async () => ({ 1: 1 }) }) },
    BLOBS: {
      list: async () => {
        if (opts.r2Fails) throw new Error("R2 unreachable");
        return { objects: [], delimitedPrefixes: [], truncated: false };
      },
    },
    LIBRARY: { idFromName: (n: string) => n, get: () => ({ ping: async () => "ok" }) },
  } as unknown as Env;
}

describe("GET /healthz", () => {
  test("checks D1, R2 and the Durable Object namespace", async () => {
    const res = await worker.fetch(new Request("http://localhost/healthz"), fakeEnv(), ctx);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({
      ok: true,
      checks: { d1: "ok", r2: "ok", durable_objects: "ok" },
    });
  });

  test("503 and the failing dependency when one is down", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/healthz"),
      fakeEnv({ r2Fails: true }),
      ctx,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; checks: Record<string, string> };
    expect(body.ok).toBe(false);
    expect(body.checks.r2).toBe("R2 unreachable");
  });
});
