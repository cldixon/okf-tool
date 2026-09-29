import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const FIXTURES_DIR = join(import.meta.dir, "../../fixtures");
export const BUNDLES = ["acme_retail", "crypto_bitcoin", "ga4", "stackoverflow"];

export interface FixtureFile {
  path: string;
  bytes: Uint8Array;
}

/** All files of a vendored sample bundle, paths relative to the bundle root. */
export function loadBundle(name: string): FixtureFile[] {
  const root = join(FIXTURES_DIR, name);
  const out: FixtureFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: relative(root, full), bytes: new Uint8Array(readFileSync(full)) });
    }
  };
  walk(root);
  return out;
}

export const text = (b: Uint8Array) => new TextDecoder().decode(b);
