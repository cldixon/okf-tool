/**
 * The spike's page (TEMPRA-291): loads source-diff.ts on demand, as the SPA would load a chunk,
 * draws a sample patch as `?mode=plain|markdown&layout=unified|split&cssom=0|1|2` asks, records
 * every CSP violation, and leaves what it saw on `window.__spike` for measure.ts.
 */
import { SAMPLE_PATCH } from "./sample";

type Seen = { directive: string; sample: string };
const violations: Seen[] = [];
document.addEventListener(
  "securitypolicyviolation",
  (e) => violations.push({ directive: e.effectiveDirective, sample: e.sample.slice(0, 60) }),
  true,
);

const q = new URLSearchParams(location.search);
const mode = q.get("mode") === "markdown" ? "markdown" : "plain";
const layout = q.get("layout") === "split" ? "split" : "unified";
const cssom = q.get("cssom") === "2" ? "rewrite" : q.get("cssom") === "1" ? "shim" : false;
const root = document.getElementById("root") as HTMLElement;

const { drawSourceDiff } = await import("./source-diff");
await drawSourceDiff(root, SAMPLE_PATCH, { path: "notes/sample.md", mode, layout, cssom });

const shadow = root.querySelector("diffs-container")?.shadowRoot;
const spans = Array.from(shadow?.querySelectorAll("code span") ?? []);
const colors = new Set(spans.map((s) => getComputedStyle(s).color));
const added = shadow?.querySelector('[data-line-type="change-addition"]');
const pre = shadow?.querySelector("pre");
(window as unknown as { __spike: unknown }).__spike = {
  violations,
  styleElements: shadow?.querySelectorAll("style").length ?? 0,
  styleAttributes: shadow?.querySelectorAll("[style]").length ?? 0,
  adoptedSheets: shadow?.adoptedStyleSheets.length ?? 0,
  sampleLine: added?.outerHTML.slice(0, 400),
  rows: shadow?.querySelectorAll("[data-line]").length ?? 0,
  fingerprint: {
    height: Math.round(pre?.getBoundingClientRect().height ?? 0),
    width: Math.round(pre?.getBoundingClientRect().width ?? 0),
    tokenColors: colors.size,
    addedBackground: added ? getComputedStyle(added).backgroundColor : null,
    preGridColumns: pre
      ? getComputedStyle(pre).getPropertyValue("--diffs-min-number-column-width-default")
      : null,
  },
};
document.body.dataset.done = "";
