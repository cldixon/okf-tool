/**
 * The page panel (tempra-dev: app/page-panel): what MCP `show` hands the panel a host draws in the
 * chat, so the person reads one page there as the app draws it. Read only: no comments, no
 * actions, no moving to other pages. The panel cannot use the app's session (a host's iframe gets
 * no cookie), so everything it draws comes in the tool result: the stored tree, the page's sources,
 * who wrote it, and a short-lived signed URL per image.
 */
import type { Doc } from "@tempra/editor/doc";
import type { TokenInfo } from "../auth";
import type { LibraryClient } from "../client";
import { StoreError } from "../store/errors";
import type { ImageRef } from "../store/store";

/** How long the panel's image links last: as an upload link does. */
export const PANEL_TTL_SECONDS = 3600;
/** Images signed for one page; past it the panel shows the rest as broken. */
const SIGNED_IMAGES = 60;

/** Ops that make a version of a page (app/src/page/data.ts CONTENT_OPS, less delete). */
const VERSION_OPS = new Set(["put", "import", "revert", "attach"]);

/** What the panel is given (structuredContent.page); app/src/panels/page.ts reads it. */
export interface PagePayload {
  v: 1;
  library: { owner: string; slug: string };
  page: {
    path: string;
    seq: number;
    title: string;
    description: string | null;
    status: string | null;
    stale: boolean;
    doc: Doc;
    /** Its images by library path: what the reader needs, and a signed URL to load each. */
    images: Record<string, ImageRef & { src: string | null }>;
  };
  sources: { id: string; title: string | null; resource: string | null }[];
  /**
   * Who made the version shown, and when: a person's handle, or an agent as the library names it
   * ("claude for @ann", its app's slug when unnamed), which the panel reads as words.
   */
  byline: { name: string; agent: boolean; at: string } | null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The page panel's payload for one page at head; `not_page` for anything else. */
export async function pagePayload(
  lib: LibraryClient,
  token: TokenInfo,
  origin: string,
  path: string,
  names?: (ids: string[]) => Promise<Map<string, string>>,
): Promise<PagePayload> {
  // The person sees it: their read, not the agent's (TEMPRA-220).
  const page = await lib.page(path, { shown: true });
  const file = page.file;
  if (file.kind !== "page" || !("sources" in page)) {
    throw new StoreError(400, "not_page", "`show` draws a page (a page), not other files.");
  }
  const fm = file.frontmatter;

  // Images: one signed link each, so the panel loads them from this deployment with no cookie.
  const images: PagePayload["page"]["images"] = {};
  let signed = 0;
  for (const [p, ref] of Object.entries(file.images ?? {})) {
    let src: string | null = null;
    if (signed < SIGNED_IMAGES) {
      signed++;
      const t = await lib.signDownload(
        { k: "file", path: p, hash: ref.hash, media: ref.media ?? null },
        PANEL_TTL_SECONDS,
      );
      src = `${origin}/dl/${encodeURIComponent(token.library.do_id)}/${t}`;
    }
    images[p] = { ...ref, src };
  }

  // The byline: who wrote the version shown, an agent for its person ("Claude for @ann").
  const events = (
    page.history as {
      events: {
        seq: number;
        ts: string;
        actor: string;
        op: string;
        meta: Record<string, unknown> | null;
      }[];
    }
  ).events;
  const current = events.filter((e) => VERSION_OPS.has(e.op) && e.seq <= file.seq).at(-1);
  let byline: PagePayload["byline"] = null;
  if (current) {
    const by = current.meta?.by as { agent?: unknown } | undefined;
    const agent = typeof by?.agent === "string" ? by.agent : null;
    const named =
      agent && names
        ? (await names([agent]).catch(() => new Map<string, string>())).get(agent)
        : undefined;
    const name = current.actor.startsWith("human:")
      ? current.actor.slice("human:".length)
      : (named ?? current.actor.split("/")[0] ?? current.actor);
    byline = { name, agent: !current.actor.startsWith("human:"), at: current.ts };
  }

  const sources = (page.sources as { sources: Record<string, unknown>[] }).sources.flatMap((s) =>
    typeof s.id === "string"
      ? [{ id: s.id, title: str(s.title), resource: str(s.resource) ?? str(s.url) }]
      : [],
  );
  return {
    v: 1,
    library: { owner: token.library.owner, slug: token.library.slug },
    page: {
      path: file.path,
      seq: file.seq,
      title: str(fm.title) ?? file.path.split("/").pop() ?? file.path,
      description: str(fm.description),
      status: str(fm.status),
      stale: file.stale,
      doc: file.doc,
      images,
    },
    sources,
    byline,
  };
}

/** The page's URL in the app. */
export function pageUrl(origin: string, p: PagePayload): string {
  const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");
  const { owner, slug } = p.library;
  return `${origin}/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/${enc(p.page.path)}`;
}
