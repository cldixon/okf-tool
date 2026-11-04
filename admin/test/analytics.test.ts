import { describe, expect, test } from "bun:test";
import { DAYS, dailyActivity, dailyFrom, dailySql } from "../src/analytics";

const NOW = new Date("2026-11-03T15:00:00Z");

describe("daily activity from Analytics Engine (TEMPRA-278)", () => {
  test("the query names only a real dataset", () => {
    expect(dailySql("tempra_usage")).toContain("FROM tempra_usage");
    expect(() => dailySql("x; DROP")).toThrow();
  });

  test("rows become 30 days, distinct accounts counted per day", () => {
    const days = dailyFrom(
      [
        { day: "2026-11-03 00:00:00", kind: "request", account: "ann", n: 10 },
        { day: "2026-11-03 00:00:00", kind: "request", account: "bob", n: "4" },
        { day: "2026-11-03 00:00:00", kind: "write", account: "ann", n: 3 },
        { day: "2026-11-01 00:00:00", kind: "request", account: "ann", n: 1 },
        // Outside the window, or not a request or write: ignored.
        { day: "2026-09-01 00:00:00", kind: "request", account: "old", n: 1 },
        { day: "2026-11-03 00:00:00", kind: "email", account: "cy", n: 1 },
      ],
      NOW,
    );
    expect(days).toHaveLength(DAYS);
    expect(days.at(-1)).toEqual({ day: "2026-11-03", accounts: 2, requests: 14, writes: 3 });
    expect(days.at(-3)).toEqual({ day: "2026-11-01", accounts: 1, requests: 1, writes: 0 });
    expect(days[0]?.day).toBe("2026-10-05");
    expect(days.filter((d) => d.accounts > 0)).toHaveLength(2);
  });

  test("asks the SQL API with the token, and is null without one or on failure", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const ok = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json({
        data: [{ day: "2026-11-03 00:00:00", kind: "request", account: "ann", n: 2 }],
      });
    }) as unknown as typeof fetch;
    const days = await dailyActivity(
      { accountId: "acc", token: "t", dataset: "tempra_usage" },
      ok,
      NOW,
    );
    expect(days?.at(-1)?.accounts).toBe(1);
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc/analytics_engine/sql",
    );
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer t");
    expect(await dailyActivity({ accountId: "acc", dataset: "tempra_usage" }, ok)).toBeNull();
    const down = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    expect(
      await dailyActivity({ accountId: "acc", token: "t", dataset: "tempra_usage" }, down),
    ).toBeNull();
  });
});
