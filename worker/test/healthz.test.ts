import { describe, expect, mock, test } from "bun:test";

// `cloudflare:workers` only exists inside workerd; stub it for unit tests under bun.
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

const { default: app } = await import("../src/index");

describe("GET /healthz", () => {
  test("returns ok", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ ok: true });
  });
});
