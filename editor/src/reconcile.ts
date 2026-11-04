/**
 * Block IDs across versions (tempra-dev: decisions/structured-documents): when a new version of
 * a body arrives, each of its blocks is matched to a block of the stored version so IDs, and the
 * comments anchored to them, survive the edit. Unchanged blocks and blocks edited in place keep
 * their ID; inserts and deletes are aligned like lines in a diff.
 */
import { lcs } from "./lcs";
import { blocksOf, type Doc, type DocNode, idOf, setId, signature, walk } from "./tree";

/** A short random block ID. */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b: number) => (b % 36).toString(36)).join("");
}

/**
 * Gives every block of `next` an ID, keeping the IDs of `prev` (the stored version, or null for a
 * new page) where blocks match. An ID `next` already carries is a hint: kept when it names a
 * block of `prev` among the same siblings and no other block claims it. Changes `next` in place.
 */
export function reconcile(prev: Doc | null, next: Doc, fresh: () => string = newId): Doc {
  const used = new Set<string>();
  const take = (node: DocNode, id: string | undefined) => {
    let next = id;
    while (next === undefined || used.has(next)) next = fresh();
    used.add(next);
    setId(node, next);
  };
  const level = (before: readonly DocNode[], after: readonly DocNode[]) => {
    const pairs = match(before, after);
    after.forEach((node, i) => {
      const old = pairs[i] === undefined ? undefined : before[pairs[i] as number];
      take(node, old && idOf(old));
      level(old ? blocksOf(old) : [], blocksOf(node));
    });
  };
  level(prev ? prev.children : [], next.children);
  return next;
}

/**
 * For each block of `after`, the index of the block of `before` it continues (undefined for a new
 * one): by ID hint, then equal content in order, then equal content moved, then blocks edited in
 * place.
 */
function match(before: readonly DocNode[], after: readonly DocNode[]): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(after.length).fill(undefined);
  const taken = new Set<number>();

  // 1. Hints: an ID of a sibling in `before`, claimed by one block only.
  const index = new Map<string, number>();
  before.forEach((n, i) => {
    const id = idOf(n);
    if (id !== undefined) index.set(id, i);
  });
  const claims = new Map<string, number>();
  for (const n of after) {
    const id = idOf(n);
    if (id !== undefined) claims.set(id, (claims.get(id) ?? 0) + 1);
  }
  after.forEach((n, i) => {
    const id = idOf(n);
    const j = id === undefined ? undefined : index.get(id);
    if (id !== undefined && j !== undefined && claims.get(id) === 1) {
      out[i] = j;
      taken.add(j);
    }
  });

  // 2. Equal content, in order, among the rest.
  const restA = after.flatMap((_, i) => (out[i] === undefined ? [i] : []));
  const restB = before.flatMap((_, j) => (taken.has(j) ? [] : [j]));
  const toB = lcs(
    restA.map((i) => signature(after[i] as DocNode)),
    restB.map((j) => signature(before[j] as DocNode)),
  );
  restA.forEach((i, k) => {
    const m = toB[k];
    if (m === undefined) return;
    const j = restB[m] as number;
    out[i] = j;
    taken.add(j);
  });

  // 3. Moved: equal content anywhere else, first come first served.
  const bySig = new Map<string, number[]>();
  before.forEach((n, j) => {
    if (taken.has(j)) return;
    const sig = signature(n);
    bySig.set(sig, [...(bySig.get(sig) ?? []), j]);
  });
  after.forEach((n, i) => {
    if (out[i] !== undefined) return;
    const j = bySig.get(signature(n))?.shift();
    if (j === undefined) return;
    out[i] = j;
    taken.add(j);
  });

  // 4. Edited in place: in each gap between matched neighbours, blocks of the same type. When the
  // gap holds as many blocks on each side, they pair in order; otherwise by shared words, so a
  // block inserted next to an edited one does not take its ID.
  let i = 0;
  while (i < after.length) {
    if (out[i] !== undefined) {
      i++;
      continue;
    }
    const lo = i === 0 ? -1 : (out[i - 1] as number);
    let end = i;
    while (end < after.length && out[end] === undefined) end++;
    const hi = end < after.length ? (out[end] as number) : before.length;
    const A = Array.from({ length: end - i }, (_, k) => i + k);
    const B: number[] = [];
    for (let j = lo + 1; j < hi; j++) if (!taken.has(j)) B.push(j);
    for (const [a, b] of pairGap(A, B, after, before)) {
      out[a] = b;
      taken.add(b);
    }
    i = end;
  }
  return out;
}

/** Pairs the unmatched blocks of a gap: in order when the counts agree, else by shared words. */
function pairGap(
  A: number[],
  B: number[],
  after: readonly DocNode[],
  before: readonly DocNode[],
): [number, number][] {
  const type = (n: DocNode | undefined) => n?.type;
  if (A.length === B.length) {
    return A.flatMap((a, k) => {
      const b = B[k] as number;
      return type(after[a]) === type(before[b]) ? [[a, b] as [number, number]] : [];
    });
  }
  const candidates: { a: number; b: number; score: number }[] = [];
  for (const a of A) {
    for (const b of B) {
      if (type(after[a]) !== type(before[b])) continue;
      const score = similarity(after[a] as DocNode, before[b] as DocNode);
      if (score >= 0.3) candidates.push({ a, b, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  const pairs: [number, number][] = [];
  for (const c of candidates) {
    const crosses = pairs.some(([a, b]) => a === c.a || b === c.b || a < c.a !== b < c.b);
    if (!crosses) pairs.push([c.a, c.b]);
  }
  return pairs;
}

/** How much two blocks' words overlap (Jaccard), from 0 to 1. */
function similarity(x: DocNode, y: DocNode): number {
  const words = (n: DocNode) => {
    const out = new Set<string>();
    walk(n, (c) => {
      if ("value" in c) for (const w of c.value.match(/[\p{L}\p{N}]+/gu) ?? []) out.add(w);
      return undefined;
    });
    return out;
  };
  const a = words(x);
  const b = words(y);
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const all = a.size + b.size - shared;
  return all === 0 ? 1 : shared / all;
}

/** Every block ID in a document, in document order. */
export function blockIds(doc: Doc): string[] {
  const out: string[] = [];
  walk(doc, (n) => {
    const id = idOf(n);
    if (id !== undefined && n.type !== "root") out.push(id);
    return undefined;
  });
  return out;
}

/**
 * Copies block IDs from `from` onto `to` where the two have the same shape (the same block type
 * at the same place), as hints for {@link reconcile}: the app's tree, rewritten canonically by
 * the server, keeps the IDs it was sent with. Stops at the first block where the shapes part.
 */
export function carryIds(from: Doc, to: Doc): Doc {
  const level = (a: readonly DocNode[], b: readonly DocNode[]) => {
    for (const [i, node] of b.entries()) {
      const src = a[i];
      if (!src || src.type !== node.type) return;
      const id = idOf(src);
      if (id !== undefined) setId(node, id);
      level(blocksOf(src), blocksOf(node));
    }
  };
  level(from.children, to.children);
  return to;
}
