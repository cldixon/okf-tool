import type { BodyScan } from "./markdown";
import { hasOffset, isActor } from "./trust";
import type { Json, JsonObject, LintWarning, Verification } from "./types";

const STATUSES = new Set(["draft", "stable", "deprecated"]);

function get(entries: [string, Json][], key: string): Json | undefined {
  return entries.find(([k]) => k === key)?.[1];
}

function isObject(v: Json | undefined): v is JsonObject {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Field-level lint on write (spec: OKF conformance; warn, never reject, per OKF §11). Broken links
 * and the size cap are checked by the store, which knows the library.
 */
export function lintFields(
  entries: [string, Json][],
  generated: JsonObject | null,
  verified: Verification[],
  footnotes: Pick<BodyScan, "footnoteRefs" | "footnoteDefs">,
): LintWarning[] {
  const out: LintWarning[] = [];
  const type = get(entries, "type");
  if (typeof type !== "string" || type.trim() === "") {
    out.push({
      code: "missing_type",
      message: "`type` is required and must be a non-empty string.",
    });
  }
  const status = get(entries, "status");
  if (status !== undefined && (typeof status !== "string" || !STATUSES.has(status))) {
    out.push({
      code: "invalid_status",
      message: `\`status\` must be one of draft, stable, deprecated; got ${JSON.stringify(status)}.`,
    });
  }

  const timestamps: [string, Json | undefined][] = [["stale_after", get(entries, "stale_after")]];
  if (generated) timestamps.push(["generated.at", generated.at]);
  verified.forEach((v, i) => {
    timestamps.push([`verified[${i}].at`, v.at]);
  });
  const window = get(entries, "usage_window");
  if (isObject(window))
    timestamps.push(["usage_window.from", window.from], ["usage_window.to", window.to]);

  const sources = get(entries, "sources");
  const sourceIds = new Set<string>();
  if (sources !== undefined && !Array.isArray(sources)) {
    out.push({ code: "invalid_sources", message: "`sources` must be a list." });
  } else if (Array.isArray(sources)) {
    sources.forEach((s, i) => {
      if (!isObject(s) || typeof s.resource !== "string" || s.resource === "") {
        out.push({
          code: "source_missing_resource",
          message: `\`sources[${i}]\` has no \`resource\`, which is required within an entry.`,
        });
      }
      if (isObject(s)) {
        if (typeof s.id === "string") sourceIds.add(s.id);
        timestamps.push([`sources[${i}].last_modified`, s.last_modified]);
      }
    });
  }

  for (const [name, value] of timestamps) {
    if (typeof value === "string" && !hasOffset(value)) {
      const example = /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? `${value}T00:00:00Z; a plain date is not enough`
        : "2026-06-30T14:00:00Z";
      out.push({
        code: "timestamp_offset",
        message: `\`${name}\` should be an ISO 8601 datetime with an explicit offset, e.g. ${example}.`,
      });
    }
  }

  const actors: [string, Json | undefined][] = [];
  if (generated) actors.push(["generated.by", generated.by]);
  verified.forEach((v, i) => {
    actors.push([`verified[${i}].by`, v.by]);
  });
  for (const [name, value] of actors) {
    if (typeof value !== "string" || !isActor(value)) {
      out.push({
        code: "invalid_actor",
        message: `\`${name}\` should follow the actor convention: human:<id>, process:<id> or <producer>/<version>.`,
      });
    }
  }

  const defined = new Set(footnotes.footnoteDefs.map((d) => d.toLowerCase()));
  for (const label of footnotes.footnoteRefs) {
    if (!sourceIds.has(label)) {
      out.push({
        code: "footnote_unmatched",
        message: `Footnote [^${label}] has no matching \`sources[].id\`.`,
      });
    }
    if (!defined.has(label.toLowerCase())) {
      out.push({
        code: "footnote_undefined",
        message: `Footnote [^${label}] has no \`[^${label}]: …\` definition line, so markdown renderers show it as literal text. Add one at the end of the body.`,
      });
    }
  }
  return out;
}
