/** Line-based unified diff (Myers), for comparing rendered concepts between sequences. */

type Op = { kind: " " | "-" | "+"; line: string };

/** Marks a last line with no trailing newline, so it never matches one that has one. */
const NO_EOL = "\u0000";

function toLines(s: string): string[] {
  if (s === "") return [];
  if (s.endsWith("\n")) return s.slice(0, -1).split("\n");
  const lines = s.split("\n");
  lines[lines.length - 1] += NO_EOL;
  return lines;
}

function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) {
        x = v[offset + k + 1] ?? 0;
      } else {
        x = (v[offset + k - 1] ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        done = true;
        break;
      }
    }
    v = next;
  }
  trace.push(v);
  // Walk back through the trace to recover the edit script.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d] as Int32Array;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (vd[offset + k - 1] ?? 0) < (vd[offset + k + 1] ?? 0))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vd[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: " ", line: a[x - 1] ?? "" });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: "+", line: b[y - 1] ?? "" });
      else ops.push({ kind: "-", line: a[x - 1] ?? "" });
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: " ", line: a[x - 1] ?? "" });
    x--;
    y--;
  }
  return ops.reverse();
}

/** A unified diff with `context` lines around each change; "" when the texts are equal. */
export function unifiedDiff(
  before: string,
  after: string,
  labels: { from: string; to: string },
  context = 3,
): string {
  if (before === after) return "";
  const a = toLines(before);
  const b = toLines(after);
  const ops = myers(a, b);
  const out = [`--- ${labels.from}`, `+++ ${labels.to}`];
  let i = 0;
  let aLine = 1;
  let bLine = 1;
  while (i < ops.length) {
    // Skip to the next change.
    let j = i;
    while (j < ops.length && ops[j]?.kind === " ") j++;
    if (j === ops.length) break;
    const start = Math.max(i, j - context);
    aLine += start - i;
    bLine += start - i;
    // Extend the hunk while changes are within 2*context lines of each other.
    let end = j;
    let lastChange = j;
    while (end < ops.length) {
      if (ops[end]?.kind !== " ") lastChange = end;
      else if (end - lastChange > 2 * context) break;
      end++;
    }
    end = Math.min(ops.length, lastChange + context + 1);
    const hunk = ops.slice(start, end);
    const aCount = hunk.filter((o) => o.kind !== "+").length;
    const bCount = hunk.filter((o) => o.kind !== "-").length;
    out.push(
      `@@ -${aCount ? aLine : aLine - 1},${aCount} +${bCount ? bLine : bLine - 1},${bCount} @@`,
    );
    for (const o of hunk) {
      if (o.line.endsWith(NO_EOL)) {
        out.push(`${o.kind}${o.line.slice(0, -NO_EOL.length)}`, "\\ No newline at end of file");
      } else out.push(`${o.kind}${o.line}`);
    }
    aLine += aCount;
    bLine += bCount;
    i = end;
  }
  return `${out.join("\n")}\n`;
}
