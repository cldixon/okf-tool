import { describe, expect, test } from "bun:test";
import { lazy, RELOAD_GAP_MS, RELOAD_KEY, type ReloadEnv, reloadForNewBuild } from "./src/chunks";

// A tab from before a deploy asks for chunks the new build does not serve: the page loads afresh
// once, rather than stay blank, and never in a loop.

function env(t0 = 1_000_000) {
  const store = new Map<string, string>();
  const e = {
    t: t0,
    reloads: 0,
    store,
    now: () => e.t,
    get: (k: string) => store.get(k) ?? null,
    set: (k: string, v: string) => void store.set(k, v),
    reload: () => void e.reloads++,
  };
  return e satisfies ReloadEnv & { t: number; reloads: number };
}

describe("loading a chunk a new build replaced", () => {
  test("reloads once, then not again within the gap, then again after it", () => {
    const e = env();
    expect(reloadForNewBuild(e)).toBe(true);
    expect(e.reloads).toBe(1);
    expect(e.store.get(RELOAD_KEY)).toBe(String(e.t));
    e.t += RELOAD_GAP_MS - 1;
    expect(reloadForNewBuild(e)).toBe(false);
    expect(e.reloads).toBe(1);
    e.t += 2;
    expect(reloadForNewBuild(e)).toBe(true);
    expect(e.reloads).toBe(2);
  });

  test("without storage it still reloads", () => {
    const e = env();
    const broken: ReloadEnv = {
      ...e,
      get: () => {
        throw new Error("blocked");
      },
      set: () => {
        throw new Error("blocked");
      },
    };
    expect(reloadForNewBuild(broken)).toBe(true);
    expect(e.reloads).toBe(1);
  });

  test("lazy: loads once and keeps it; a failure reloads and stays pending", async () => {
    const e = env();
    let calls = 0;
    const ok = lazy(
      async () => {
        calls++;
        return "chunk";
      },
      () => e,
    );
    expect(await ok()).toBe("chunk");
    expect(await ok()).toBe("chunk");
    expect(calls).toBe(1);

    const gone = lazy(
      () => Promise.reject(new Error("Failed to fetch dynamically imported module")),
      () => e,
    );
    let settled = false;
    void gone().then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(e.reloads).toBe(1);
    expect(settled).toBe(false);
  });

  test("lazy: right after a reload it rejects, for the page to say so, and tries again next time", async () => {
    const e = env();
    e.store.set(RELOAD_KEY, String(e.t));
    let calls = 0;
    const gone = lazy(
      () => {
        calls++;
        return Promise.reject(new Error("missing"));
      },
      () => e,
    );
    await expect(gone()).rejects.toThrow("missing");
    await expect(gone()).rejects.toThrow("missing");
    expect(calls).toBe(2);
    expect(e.reloads).toBe(0);
  });
});
