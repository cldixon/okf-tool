import { describe, expect, test } from "bun:test";
import { StoreError } from "../src/store/errors";
import { LibraryStore, type RequestContext } from "../src/store/store";
import { bunSqlHandle } from "./sqlite";

let n = 0;
const ctx = (actor: string, person?: string, agent?: string): RequestContext => ({
  actor,
  request_id: `req-${++n}`,
  by: person ? (agent ? { person, agent } : { person }) : null,
});
const agent = () => ctx("claude-code/ana", "u_ana", "a_ana");

function newStore() {
  let t = Date.parse("2026-10-05T12:00:00Z");
  return new LibraryStore(bunSqlHandle(), {
    now: () => {
      t += 1000;
      return new Date(t);
    },
  });
}

const doc = (title: string, fm = "", body = "Revenue minus cost.") =>
  `---\ntype: Metric\ntitle: ${title}\ndescription: About ${title}.\n${fm}---\n# ${title}\n\n${body}\n`;

function write(s: LibraryStore, c: RequestContext, path: string, content = doc(path)) {
  const if_match = s.pages().items.find((i) => i.path === path)?.hash ?? null;
  return s.apply(c, [{ op: "write", path, content, if_match }]);
}

function seeded() {
  const s = newStore();
  write(s, agent(), "metrics/margin.md", doc("Margin"));
  write(s, agent(), "metrics/churn.md", doc("Churn", "stale_after: 2026-10-01T00:00:00Z\n"));
  write(s, agent(), "metrics/finance/revenue.md", doc("Revenue"));
  write(s, agent(), "metrics/finance/deep/cost.md", doc("Cost"));
  s.apply(agent(), [
    {
      op: "attach",
      path: "metrics/chart.png",
      blob: { hash: "a".repeat(64), size: 3, media: null },
    },
    {
      op: "attach",
      path: "metrics/img/logo.png",
      blob: { hash: "b".repeat(64), size: 3, media: null },
    },
  ]);
  write(s, agent(), "about.md", doc("About"));
  return s;
}

describe("an attachment's links", () => {
  test("the pages that use it, and none of its own", () => {
    const s = seeded();
    write(s, agent(), "about.md", doc("About", "", "![chart](/metrics/chart.png)"));
    write(s, agent(), "metrics/margin.md", doc("Margin", "", "See [the chart](chart.png)."));
    const links = s.links("metrics/chart.png");
    expect(links.inbound.map((l) => l.path)).toEqual(["about.md", "metrics/margin.md"]);
    expect(links.outbound).toEqual([]);
    expect(links.broken).toEqual([]);
    expect(s.links("metrics/img/logo.png").inbound).toEqual([]);
    expect(() => s.links("metrics/none.png")).toThrow(StoreError);
  });
});
