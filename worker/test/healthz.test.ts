import { describe, expect, mock, test } from "bun:test";

// `cloudflare:workers` only exists inside workerd; stub it for unit tests under bun.
mock.module("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));

const { default: worker } = await import("../src/index");

describe("GET /healthz", () => {
  test("returns ok", async () => {
    const env = {} as Env;
    const ctx = {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request("http://localhost/healthz"), env, ctx);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ ok: true });
  });
});
