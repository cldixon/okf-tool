import { jsonEqual, parseConcept } from "../src/okf/concept";

const dec = new TextDecoder();
const SYNTHESIZED = /(^|\/)(index|log)\.md$/;

/**
 * The Phase 1 gate comparison: every concept has the same parsed frontmatter fields (`generated`
 * and `verified` included) and the same body; every attachment is byte-identical; `index.md` and
 * `log.md` are ignored because the service synthesizes them. Returns a list of mismatches.
 */
export function compareBundle(
  original: { path: string; bytes: Uint8Array }[],
  exported: Map<string, Uint8Array>,
): string[] {
  const problems: string[] = [];
  for (const f of original) {
    if (SYNTHESIZED.test(f.path)) continue;
    const got = exported.get(f.path);
    if (!got) {
      problems.push(`${f.path}: missing from export`);
      continue;
    }
    if (!f.path.endsWith(".md")) {
      if (got.length !== f.bytes.length || got.some((b, i) => b !== f.bytes[i])) {
        problems.push(`${f.path}: attachment bytes differ`);
      }
      continue;
    }
    const a = parseConcept(dec.decode(f.bytes));
    const b = parseConcept(dec.decode(got));
    if (!jsonEqual(Object.fromEntries(a.entries), Object.fromEntries(b.entries))) {
      problems.push(`${f.path}: frontmatter fields differ`);
    }
    if (!jsonEqual(a.generated, b.generated)) problems.push(`${f.path}: generated differs`);
    if (!jsonEqual(a.verified, b.verified)) problems.push(`${f.path}: verified differs`);
    if (a.body !== b.body) problems.push(`${f.path}: body differs`);
  }
  const originals = new Set(original.map((f) => f.path));
  for (const path of exported.keys()) {
    if (!originals.has(path) && !SYNTHESIZED.test(path))
      problems.push(`${path}: unexpected in export`);
  }
  return problems;
}
