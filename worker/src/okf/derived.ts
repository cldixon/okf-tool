/** Synthesized `index.md` (OKF §8) and `log.md` (OKF §9). Never authored, never stored. */

import { basename } from "./paths";

export const OKF_VERSION = "0.2";

export interface IndexInput {
  /** The directory, "" for the bundle root. */
  dir: string;
  subdirs: { name: string; concepts: number }[];
  concepts: { path: string; title: string | null; description: string | null }[];
  attachments: { path: string }[];
}

/** One directory level: a section for subdirectories, one for concepts, one for other files. */
export function renderIndex(input: IndexInput): string {
  const parts: string[] = [];
  if (input.dir === "") parts.push(`---\nokf_version: "${OKF_VERSION}"\n---\n`);
  const line = (label: string, href: string, desc: string | null) =>
    `* [${escapeLabel(label)}](${encodeHref(href)})${desc ? ` - ${oneLine(desc)}` : ""}`;
  if (input.subdirs.length > 0) {
    parts.push("# Subdirectories\n");
    for (const d of input.subdirs) {
      const n = d.concepts === 1 ? "1 concept" : `${d.concepts} concepts`;
      parts.push(line(d.name, `${d.name}/index.md`, n));
    }
    parts.push("");
  }
  if (input.concepts.length > 0) {
    parts.push("# Concepts\n");
    for (const c of input.concepts) {
      const name = basename(c.path);
      parts.push(line(c.title || name.replace(/\.md$/, ""), name, c.description));
    }
    parts.push("");
  }
  if (input.attachments.length > 0) {
    parts.push("# Files\n");
    for (const a of input.attachments) parts.push(line(basename(a.path), basename(a.path), null));
    parts.push("");
  }
  if (parts.length === (input.dir === "" ? 1 : 0)) parts.push("*This directory is empty.*\n");
  return parts.join("\n");
}

export interface LogRequest {
  ts: string;
  actor: string;
  note: string | null;
  events: { op: string; path: string; created: boolean; fromPath?: string | null }[];
}

const LABELS: Record<string, string> = {
  create: "Creation",
  put: "Update",
  delete: "Deletion",
  move: "Move",
  import: "Import",
  revert: "Revert",
  verify: "Verification",
};

/** Requests newest first, grouped by UTC day; one bullet per request. */
export function renderLog(requests: LogRequest[], title = "Library log"): string {
  const out: string[] = [`# ${title}\n`];
  let day = "";
  for (const r of requests) {
    const d = r.ts.slice(0, 10);
    if (d !== day) {
      out.push(`## ${d}\n`);
      day = d;
    }
    const kinds = new Set(r.events.map((e) => (e.op === "put" && e.created ? "create" : e.op)));
    const label = kinds.size === 1 ? (LABELS[[...kinds][0] ?? ""] ?? "Update") : "Update";
    const paths = [...new Set(r.events.map((e) => e.path))];
    const shown = paths.slice(0, 10).map((p) => `[${escapeLabel(p)}](/${encodeHref(p)})`);
    if (paths.length > 10) shown.push(`and ${paths.length - 10} more`);
    const note = r.note ? ` ${oneLine(r.note)}` : "";
    out.push(`* **${label}** by \`${r.actor}\`:${note} ${shown.join(", ")}`);
    const next = requests[requests.indexOf(r) + 1];
    if (!next || next.ts.slice(0, 10) !== day) out.push("");
  }
  if (requests.length === 0) out.push("*No changes yet.*\n");
  return out.join("\n");
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function escapeLabel(s: string): string {
  return s.replace(/([[\]\\])/g, "\\$1");
}

function encodeHref(s: string): string {
  return s.replace(/[ ()<>]/g, (c) => encodeURIComponent(c));
}
