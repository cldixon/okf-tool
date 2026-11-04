import type { Urls } from "../urls";
import type { Version } from "./data";

/** How many versions the History panel lists at first, and adds with each "older versions". */
export const PAGE = 10;

/**
 * Where a version in History leads: that version as it was (`?at=`, or the plain page for the
 * latest) with what it changed drawn in its text, the word diff from the version before it
 * (`?since=`); the first version has nothing before it and opens as it was. History stays open.
 */
export function versionHref(urls: Urls, path: string, versions: Version[], n: number): string {
  const i = versions.findIndex((v) => v.n === n);
  const version = versions[i];
  if (!version) return urls.pinned(undefined).file(path);
  const latest = i === versions.length - 1;
  const page = urls.pinned(latest ? undefined : version.event.seq).file(path);
  const before = versions[i - 1];
  const params = new URLSearchParams();
  if (before) params.set("since", String(before.event.seq));
  params.set("panel", "history");
  return `${page}${page.includes("?") ? "&" : "?"}${params}`;
}
