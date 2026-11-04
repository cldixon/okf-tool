import { describe, expect, test } from "bun:test";
import { parseMarkdown, reconcile } from "@tempra/editor/doc";
// Pele is a dev dependency only: the Worker checks diagrams without it (tempra-dev: app/diagrams),
// and these tests hold the check to what Pele accepts and refuses.
import { parse } from "pele";
import { checkDiagram, diagramLint } from "../src/format/diagrams";
import { LibraryStore, type RequestContext } from "../src/store/store";
import { bunSqlHandle } from "./sqlite";

const fence = (src: string, lang = "mermaid") => `\`\`\`${lang}\n${src}\n\`\`\``;

/** Diagrams Pele draws, with the constructs a naive bracket count gets wrong. */
const VALID: Record<string, string> = {
  flowchart: `flowchart LR
  A[Write] --> B{Parses?}
  B -->|yes| C([Drawn])
  B -- no --> D>Flag]
  D --> E[(Store)] & F{{Hex}} & G((Circle))
  E -.-> H[/Para/] ==> I[\\Alt\\]
  subgraph S [A group]
    J["Quoted (with a paren"] --> K
  end
  %% a comment ( with a paren
  classDef hot fill:#f96,stroke:#333
  class C hot
  style A stroke-width:2px
  click A "https://example.com" "A tip"`,
  graph: "graph TD\n  A --> B",
  markdownString: 'flowchart LR\n  A["`**Bold** and\n  a second line (open`"] --> B',
  frontmatter: "---\ntitle: With frontmatter\n---\nflowchart LR\n  A --> B",
  directive: "%%{init: {'theme': 'neutral'}}%%\nsequenceDiagram\n  A->>B: hi",
  sequence: `sequenceDiagram
  participant A as Alice (the first
  Alice->>Bob: Hello [world
  Bob-->>Alice: Fine {thanks
  Note right of Bob: a note ( unbalanced
  loop Every minute
    Alice->>Bob: ping
  end`,
  class: `classDiagram
  class Animal {
    +String name
    +eat(food) bool
    +List~int~ ids
  }
  class Duck
  <<interface>> Duck
  Animal <|-- Duck : is a (kind
  Animal "1" --> "*" Duck`,
  state: `stateDiagram-v2
  [*] --> Still
  Still --> Moving : push (hard
  state Moving {
    [*] --> Slow
    Slow --> Fast
  }
  note right of Still
    Free text ( with { brackets
  end note
  Moving --> [*]`,
  er: `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE-ITEM : contains
  CUSTOMER }|..|{ DELIVERY-ADDRESS : uses
  CUSTOMER {
    string name
    string id PK "the key (unique"
  }`,
  pie: 'pie title Pets\n  "Dogs" : 386\n  "Cats (house" : 85',
  gantt:
    "gantt\n  title A plan (draft\n  dateFormat YYYY-MM-DD\n  section A\n  Task :a1, 2026-01-01, 30d",
  mindmap: "mindmap\n  root((Tempra))\n    )Cloud(\n    ))Bang((\n    [Square]",
  journey: "journey\n  title My day\n  section Work\n    Write ( code: 5: Me",
  timeline: "timeline\n  title History\n  2026 : Tempra (v1",
  gitGraph: "gitGraph\n  commit\n  branch dev\n  commit\n  checkout main\n  merge dev",
  info: "info",
};

/** Broken diagrams, the problem the check reports, and where. */
const BROKEN: [string, string, RegExp, number, number][] = [
  ["unknown type", "notadiagram\n  A --> B", /`notadiagram` is not a diagram type/, 1, 1],
  ["empty fence", "\n  \n", /no diagram in it/, 1, 1],
  ["header only", "flowchart LR", /Nothing follows `flowchart LR`/, 1, 13],
  ["unclosed bracket", "flowchart LR\n  A[Start --> B", /`\[` is never closed/, 2, 4],
  [
    "wrong closer",
    "flowchart LR\n  A[Start) --> B",
    /`\)` closes `\[` from line 2, column 4/,
    2,
    10,
  ],
  ["stray closer", "flowchart LR\n  A --> B]", /`\]` closes nothing/, 2, 10],
  ["unclosed quote", 'flowchart LR\n  A["Start] --> B', /quote is never closed/, 2, 5],
  ["unclosed class body", "classDiagram\n  class A {\n    +name", /`\{` is never closed/, 2, 11],
  [
    "unclosed ER block",
    "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  CUSTOMER {\n    string name",
    /`\{` is never closed/,
    3,
    12,
  ],
];

let n = 0;
const ctx = (): RequestContext => ({ actor: "claude-code/test", request_id: `req-${++n}` });
const codes = (lint: { code: string }[]) => lint.map((l) => l.code);
const md = (body: string) =>
  `---\ntype: Memo\ndescription: A test page.\nstatus: stable\n---\n${body}\n`;
const pele = (src: string) => {
  try {
    parse(src);
    return true;
  } catch {
    return false;
  }
};

describe("diagram check (TEMPRA-98)", () => {
  for (const [name, src] of Object.entries(VALID)) {
    test(`passes what Pele draws: ${name}`, () => {
      expect(pele(src)).toBe(true);
      expect(checkDiagram(src)).toBeNull();
    });
  }

  for (const [name, src, message, line, column] of BROKEN) {
    test(`reports what Pele refuses: ${name}`, () => {
      const p = checkDiagram(src);
      expect(p?.message).toMatch(message);
      expect({ line: p?.line, column: p?.column }).toEqual({ line, column });
      // Everything it reports, Pele refuses too, but a header alone, which Pele draws as nothing.
      if (name !== "header only") expect(pele(src)).toBe(false);
    });
  }

  test("never reports what Pele draws: every sample with any one character deleted", () => {
    for (const [name, src] of Object.entries(VALID)) {
      for (let i = 0; i < src.length; i++) {
        const cut = src.slice(0, i) + src.slice(i + 1);
        const p = checkDiagram(cut);
        if (p && !p.message.startsWith("Nothing follows")) {
          expect({ name, at: i, problem: p.message, pele: pele(cut) }).toEqual({
            name,
            at: i,
            problem: p.message,
            pele: false,
          });
        }
      }
    }
  });

  test("every header Pele detects is one the check knows", () => {
    const headers = [
      "flowchart-elk TD",
      "mindmap",
      "architecture-beta",
      "C4Context",
      "kanban",
      "classDiagram-v2",
      "erDiagram",
      "gantt",
      "pie",
      "requirementDiagram",
      "sequenceDiagram",
      "graph LR",
      "timeline",
      "gitGraph",
      "stateDiagram",
      "journey",
      "quadrantChart",
      "sankey-beta",
      "packet-beta",
      "xychart-beta",
      "block-beta",
      "radar-beta",
      "treemap-beta",
      "venn-beta",
    ];
    for (const h of headers) {
      expect({ h, problem: checkDiagram(`${h}\n  x`)?.kind }).not.toEqual({
        h,
        problem: "unsupported-diagram",
      });
    }
  });

  test("lint names the diagram, its block, the line and column, and the problem", () => {
    const doc = reconcile(
      null,
      parseMarkdown(
        `Intro.\n\n${fence(VALID.graph ?? "")}\n\n${fence("flowchart LR\n  A[Start --> B")}\n\n${fence("x", "text")}`,
      ),
    );
    const [w, ...rest] = diagramLint(doc);
    expect(rest).toEqual([]);
    expect(w?.code).toBe("diagram_invalid");
    expect(w?.block).toBe((doc.children[2] as { id?: string }).id);
    expect(w?.message).toContain("Figure 2 (mermaid, `flowchart LR`, block ");
    expect(w?.message).toContain(
      "has a syntax error at line 2, column 4 of the fence: `[` is never closed with `]`.",
    );
  });

  test("lint numbers fences as read's Figures list does, across kinds and images (TEMPRA-215)", () => {
    // The trial's page: vega-lite, svg, mermaid, svg, vega-lite, vega-lite, with an image first.
    const chart = (ok: boolean) => fence(ok ? '{"mark":"bar"' : "{nope", "vega-lite");
    const svg = (ok: boolean) => fence(ok ? '<svg alt="x"><title>t</title></svg>' : "<svg>", "svg");
    const body = [
      "![A photo](/a.png)",
      chart(false),
      svg(true),
      fence("flowchart LR\n  A[Start --> B"),
      svg(false),
      chart(false),
      `${"```"}vega-lite alt="x"\n{"mark": "bar", "data": {"url": "https://example.com/x.csv"}}\n${"```"}`,
      "[^n]\n\n[^n]: A note.\n\n    indented",
    ].join("\n\n");
    const doc = reconcile(null, parseMarkdown(body));
    const said = diagramLint(doc).map((w) => `${w.code} ${w.message.split(")")[0]})`);
    const block = (i: number) => (doc.children[i] as { id?: string }).id;
    expect(said).toEqual([
      `chart_invalid Figure 2 (vega-lite, block ${block(1)})`,
      `diagram_invalid Figure 4 (mermaid, \`flowchart LR\`, block ${block(3)})`,
      `svg_invalid Figure 5 (svg, block ${block(4)})`,
      `chart_invalid Figure 6 (vega-lite, block ${block(5)})`,
      `chart_invalid Figure 7 (vega-lite, block ${block(6)})`,
    ]);
  });

  test("a fence that is not a figure (in a footnote) is named by its language", () => {
    const doc = reconcile(
      null,
      parseMarkdown("Text.[^n]\n\n[^n]: A note.\n\n    ```svg\n    <svg>\n    ```"),
    );
    expect(diagramLint(doc).map((w) => w.message)).toEqual([
      expect.stringMatching(/^The svg fence( \(block \w+\))? does not parse/),
    ]);
  });

  test("a write lands with the lint, stores it, and a fix clears it; import lints too", () => {
    const broken = "flowchart LR\n  A[Start --> B";
    const s = new LibraryStore(bunSqlHandle());
    const res = s.apply(ctx(), [{ op: "write", path: "d.md", content: md(fence(broken)) }]);
    expect(codes(res.results[0]?.lint ?? [])).toEqual(["diagram_invalid"]);
    const v = s.read("d");
    expect(v.kind === "page" && codes(v.lint)).toEqual(["diagram_invalid"]);
    expect(s.work({ kind: "lint" }).items.map((i) => i.path)).toEqual(["d.md"]);
    const hash = v.kind === "page" ? v.hash : "";
    const fixed = s.apply(ctx(), [
      { op: "write", path: "d.md", content: md(fence(VALID.graph ?? "")), if_match: hash },
    ]);
    expect(fixed.results[0]?.lint).toEqual([]);
    const imported = s.import(ctx(), [{ path: "e.md", markdown: md(fence(broken)) }]);
    expect(imported.warnings.flatMap((w) => codes(w.lint))).toContain("diagram_invalid");
  });
});
