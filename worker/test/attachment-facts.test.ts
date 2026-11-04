import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { API, setup } from "./harness";
import { base64, makePng } from "./images";
import { attachFile } from "./upload";

type S = ReturnType<typeof setup>;
type Text = { type: "text"; text: string };

async function mcp(s: S, token = "writer") {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (url, init) => s.app.request(url.toString(), init as RequestInit),
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as Text[]).map((c) => c.text).join("\n"), isError: !!r.isError };
  };
}

const describeFile = async (s: S, path: string, at?: number) =>
  (await (
    await s.app.request(`${API}/files/${path}${at === undefined ? "" : `?at=${at}`}`, {
      headers: { Accept: "application/json" },
    })
  ).json()) as Record<string, unknown>;

const PNG = makePng(6, 4);
const png = () =>
  new Response(PNG as unknown as BodyInit, { headers: { "Content-Type": "image/png" } });

describe("an attachment's credit and licence (TEMPRA-170)", () => {
  test("on every way in, returned in the JSON, kept per version, and checked", async () => {
    const s = setup();
    const call = await mcp(s);
    // prepare_upload
    const b = await attachFile(s.app, call, "one.png", PNG, {
      credit: "  Ann Example  ",
      licence: "CC BY-SA 4.0",
    });
    expect(b.ok).toBe(true);
    const one = await describeFile(s, "one.png");
    expect(one.credit).toBe("Ann Example");
    expect(one.licence).toBe("CC BY-SA 4.0");
    expect(one.description).toBeNull();
    // source_url
    s.web.set("https://example.com/fig.png", png);
    await call("attach", {
      path: "two.png",
      source_url: "https://example.com/fig.png",
      credit: "Example Inc.",
    });
    expect((await describeFile(s, "two.png")).credit).toBe("Example Inc.");
    expect((await describeFile(s, "two.png")).licence).toBeNull();
    // prepare_upload
    const up = await call("prepare_upload", { path: "three.png", licence: "Public domain" });
    const url = /'(http\S+)'/.exec(up.text)?.[1] ?? "";
    expect((await s.app.request(url, { method: "PUT", body: PNG })).status).toBe(200);
    expect((await describeFile(s, "three.png")).licence).toBe("Public domain");
    // REST: PUT with the facts in the query, POST ?from= with them in a JSON body.
    const put = await s.req("/files/four.png?credit=Bo&licence=MIT&description=Four", {
      method: "PUT",
      body: PNG,
      headers: { "Content-Type": "image/png" },
    });
    expect(put.status).toBe(200);
    const four = await describeFile(s, "four.png");
    expect([four.description, four.credit, four.licence]).toEqual(["Four", "Bo", "MIT"]);
    const post = await s.req("/files/five.png", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_url: "https://example.com/fig.png", licence: "CC0" }),
    });
    expect(post.status).toBe(200);
    expect((await describeFile(s, "five.png")).licence).toBe("CC0");
    // The same bytes with a new credit is a write of its own; the same again is a no-op.
    const seq = s.store().headSeq();
    const hash = one.hash as string;
    await attachFile(s.app, call, "one.png", PNG, { if_match: hash, credit: "Ann E." });
    expect(s.store().headSeq()).toBe(seq + 1);
    await attachFile(s.app, call, "one.png", PNG, { if_match: hash, credit: "Ann E." });
    expect(s.store().headSeq()).toBe(seq + 1);
    const now = await describeFile(s, "one.png");
    // The licence given earlier for these bytes still stands.
    expect([now.credit, now.licence]).toEqual(["Ann E.", "CC BY-SA 4.0"]);
    expect((await describeFile(s, "one.png", seq)).credit).toBe("Ann Example");
    // Checked: a line each.
    for (const k of ["credit", "licence"]) {
      expect(
        (await call("prepare_upload", { path: "y.png", [k]: "x".repeat(201) })).text,
      ).toContain(`bad_${k}`);
    }
    const restLong = await s.req(`/files/z.png?credit=${"x".repeat(201)}`, {
      method: "PUT",
      body: PNG,
      headers: { "Content-Type": "image/png" },
    });
    expect(restLong.status).toBe(400);
  });

  test("MCP read prints credit, licence and the number of versions", async () => {
    const s = setup();
    const call = await mcp(s);
    await attachFile(s.app, call, "a.png", PNG, {
      description: "Two boxes.",
      credit: "Ann",
      licence: "CC BY 4.0",
    });
    const hash = (await describeFile(s, "a.png")).hash as string;
    await attachFile(s.app, call, "a.png", makePng(3, 3), { if_match: hash });
    const r = await call("read", { path: "a.png", image: false });
    expect(r.text).toContain("versions: 2");
    // The new bytes start without the old version's facts.
    expect(r.text).not.toContain("credit:");
    const old = await call("read", { path: "a.png", image: false, at: s.store().headSeq() - 1 });
    expect(old.text).toContain("description: Two boxes.");
    expect(old.text).toContain("credit: Ann");
    expect(old.text).toContain("licence: CC BY 4.0");
  });

  test("an attachment's history lists each version with its size and dimensions", async () => {
    const s = setup();
    const call = await mcp(s);
    await attachFile(s.app, call, "h.png", PNG);
    const hash = (await describeFile(s, "h.png")).hash as string;
    const bigger = makePng(30, 20);
    await attachFile(s.app, call, "h.png", bigger, { if_match: hash });
    const res = await s.req("/history/h.png");
    expect(res.status).toBe(200);
    const h = (await res.json()) as {
      events: { op: string; prev_hash: string | null; file?: Record<string, unknown> }[];
    };
    const versions = h.events.filter((e) => e.file);
    expect(versions.length).toBe(2);
    expect(versions[0]?.file).toEqual({
      size: PNG.length,
      media: "image/png",
      width: 6,
      height: 4,
    });
    expect(versions[1]?.file).toMatchObject({ size: bigger.length, width: 30, height: 20 });
    expect(versions[1]?.prev_hash).toBe(hash);
    // A page's history carries no file facts.
    await s.req("/files/c.md", {
      method: "PUT",
      body: "---\ntype: Note\ntitle: C\n---\nBody.\n",
      headers: { "Content-Type": "text/markdown" },
    });
    const c = (await (await s.req("/history/c.md")).json()) as { events: { file?: unknown }[] };
    expect(c.events.every((e) => e.file === undefined)).toBe(true);
  });
});
