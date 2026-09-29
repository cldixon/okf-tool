export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface LintWarning {
  code: string;
  message: string;
  /** The path the warning is about, when it is not the concept itself (e.g. a broken link). */
  target?: string;
}

/** A body link as stored in a concept record: the written link plus its resolved target. */
export interface StoredLink {
  start: number;
  end: number;
  raw: string;
  /** Bundle path the target resolved to at write time, without anchor. */
  path: string;
  anchor: string | null;
  form: "absolute" | "relative";
  /** concept_id of the target, or null when it did not exist at write time. */
  target: string | null;
}

/**
 * A concept's content version (spec: Concept model). Hashing its canonical serialization gives the
 * content-version hash used by ETags, If-Match and the ledger. `verified` is not part of it.
 */
export interface ConceptRecord {
  v: 1;
  /** Writer frontmatter in arrival order, minus server-owned and computed keys. */
  fm: [string, Json][];
  /** Frontmatter text kept verbatim when it could not be parsed as a YAML mapping. */
  raw_fm: string | null;
  /** Server-owned `generated`. */
  generated: JsonObject | null;
  body: string;
  links: StoredLink[];
}

export interface Verification {
  by: string;
  at: string;
}

export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";
