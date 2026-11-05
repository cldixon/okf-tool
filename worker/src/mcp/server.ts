import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { changesPanel, pagePanel, uploadPanel } from "@tempra/app/panels";
import { z } from "zod";
import type { TokenInfo } from "../auth";
import { chartForRender, libraryText } from "../chart-data";
import {
  type BlobStore,
  figuresWithDimensions,
  type LibraryClient,
  mediaFor,
  putBlob,
  withDimensions,
} from "../client";
import { type FetchFn, fetchBlob, selfHosts } from "../fetch-source";
import { diagramTypeOf, previewLint, vegaErrorText } from "../format/diagrams";
import { type FigureFact, figureLine, sizeText } from "../format/figures";
import { normalizePath, underPrefix } from "../format/paths";
import type { LintWarning } from "../format/types";
import {
  IMAGE_BYTES_PER_CALL,
  IMAGES_PER_CALL,
  type Images,
  type ImageTransform,
  imagesService,
  RASTER_MEDIA,
  readBytes,
  toBase64,
} from "../images";
import { imageInfo } from "../media";
import {
  drawerOf,
  isRenderLang,
  MAX_RENDER_SOURCE,
  type PosterResult,
  RENDER_LANGS,
  RENDER_UNAVAILABLE,
  RENDER_WIDTH,
  type RenderError,
  type RenderLang,
  type RenderRequest,
  type RenderResult,
  sourceLang,
} from "../render";
import type { CommentAction, CommentResult } from "../store/comments";
import { StoreError } from "../store/errors";
import { readsText } from "../store/reads";
import {
  checkFacts,
  EXPORT_FORMATS,
  type LibraryHealth,
  type RequestContext,
  type WriteOp,
  type WriteResult,
} from "../store/store";
import { requireOwner } from "../tenancy";
import { Urls } from "../ui/urls";
import { kindOf, prepareUpload } from "../uploads";
import { pagePayload, pageUrl } from "./page";

export interface McpContext {
  /** The ledger actor, access and tool tier: the same in every library the caller reaches. */
  actor: string;
  scope: "read" | "write";
  tiers: string;
  /** The libraries the caller reaches now, each as the token it acts with there. */
  libraries: TokenInfo[];
  /** The person and agent behind the actor, for the ledger (TEMPRA-75). */
  by?: RequestContext["by"];
  open(token: TokenInfo): LibraryClient;
  /**
   * Posts a comment action and notifies whom it addresses (notify.ts: mentions, the inbox);
   * without it, the library records the comment and nobody is told.
   */
  comment?(token: TokenInfo, req: RequestContext, action: CommentAction): Promise<CommentResult>;
  /**
   * Names agents by id for whom they act ("Claude for @ann", TEMPRA-77); unknown ids are left
   * out. Without it, transcripts show the raw actor.
   */
  agentNames?(ids: string[]): Promise<Map<string, string>>;
  /**
   * Creates a library owned by the connection's person and returns the token the connection acts
   * with there (tenancy.ts createLibraryForGrant: it refuses connections without "Create
   * libraries"). Absent for bearer tokens, which reach one library and never create one.
   */
  createLibrary?(input: {
    slug: string;
    title?: string;
    description?: string;
  }): Promise<{ token: TokenInfo; title: string | null; description: string | null }>;
  /** A library's title and description as its creator gave them, for `start`. */
  about?(libraryId: string): Promise<{ title: string | null; description: string | null } | null>;
  blobs: BlobStore;
  /** Attachment images scaled for the model (images.ts); without it, small originals only. */
  images?: Images;
  /**
   * Meters what a call costs beyond a request: an image sent (`read_image`), a file fetched from
   * a URL (`fetch`, TEMPRA-157).
   */
  meter?(e: { kind: "read_image" | "read_pdf" | "fetch"; library: string; bytes: number }): void;
  /** Outbound fetch for `attach` with `source_url` (fetch-source.ts); tests pass a double. */
  fetch?: FetchFn;
  /**
   * Draws a Mermaid source on the render Worker (render.ts, TEMPRA-165), counted against the
   * caller's account; without it, `render` and `read`'s diagrams say the service is unavailable.
   */
  render?(req: RenderRequest, library?: string): Promise<RenderResult>;
  /** A video's frame for `transform`'s poster (TEMPRA-208); without it, posters are unavailable. */
  poster?(req: { url: string; time: number }, library?: string): Promise<PosterResult>;
  /** One render against the account's per-minute cap (RENDERS_PER_MINUTE); false when over it. */
  allowRender?(): Promise<boolean>;
  /** The Worker's origin, for download URLs. */
  origin: string;
}

/** Name the MCP server reports; provisional until the product is named (spec: Open questions). */
export const SERVER_NAME = "tempra";
/** Resource URI scheme; provisional for the same reason. */
export const URI_SCHEME = "tempra";

const BEYOND = "Beyond files: ";

/** Compressed workflow guidance, sent as the server's instructions (most clients never load a skill). */
export const INSTRUCTIONS = `This server holds Tempra libraries: folders of markdown pages, each with YAML frontmatter, plus attachments. Every change is attributed to your actor and recorded in the library's ledger.

How to work:
1. Call \`start\` first. It opens your library, or lists the libraries you can reach when there are several; then pass \`library\` (owner/slug) on every call. When the person asks for a new library, \`create_library\` makes one they own and opens it (only on a connection they allowed to). Then \`browse\` a directory before reading, follow links, and \`read\` what you need. Check a page's trust tier and staleness before relying on it.
2. Write pages people and agents can find their way through: a \`title\` and a one-line \`description\` (indexes and search show it), absolute links like [x](/dir/x.md), footnotes [^id] keyed to \`sources[].id\` (an entry is \`id\`, \`title\` and \`resource\`: a URL or a path in this library). Shape folders and pages to the content: a long page is fine when it reads as one, and a library may say how it likes to be written in a \`guide.md\` at its root, which you read first when there is one. Other frontmatter is yours to add as a page needs it; \`tags\` let \`query\` find pages of a kind.
3. Media, where a figure helps: a screenshot of what the page describes, a chart of data it discusses, a diagram of an architecture or a flow. Prefer rendered media, code in the page that the app draws: a chart as a Vega-Lite spec in a \`vega-lite\` fence (\`\`\`vega-lite alt="what it shows" title="Caption"\`; its data inline in \`values\`, or a CSV, TSV or JSON file in this library named by \`data.url\`; never a picture of a chart), a Mermaid diagram in a \`mermaid\` fence, or a drawing in an \`svg\` fence (\`\`\`svg alt="what it shows" title="Caption"\`; plain shapes and text, \`currentColor\` for ink, no scripts, style elements, images or links). It is text, diffs like text and needs no upload (preview a non-trivial one with \`render\`). A file (an image, video, audio or PDF) comes in only two ways, and never as bytes you type into a call: on the public web, \`attach\` with \`source_url\` (the server fetches it; never hotlink); one you made or the person has, \`prepare_upload\`: run its curl line when your shell reaches this server, else the person sends it from their browser (in a chat that shows apps an upload panel appears with the call; give them its upload link too). A file you made where you cannot reach this server (a chart in a chat's sandbox): give it to the person in the chat, call \`prepare_upload\` with \`origin: "agent"\`, and tell them in a sentence why: you cannot send files to Tempra yourself, so they upload the one you gave them. Put a file beside the page that uses it, named for what it shows (\`dir/x.md\` uses \`dir/x-architecture.png\`). Write \`![what it shows](/dir/x-architecture.png "Caption")\` (alt says what it shows, the title is the caption), in a \`:::figure\` block for size, placement or a group (\`write\` says how), and cite a work taken from elsewhere (a web image) in \`sources\`, its footnote right after the image (\`![…](/dir/x.jpg "Caption")[^src]\`, still a figure); a file the person gave you or you made carries its own \`credit\` and \`licence\` instead, with no \`sources\` entry. To change a stored image (resize, crop, convert, a thumbnail) or make a video's poster, use \`transform\`: the server does it, since you cannot fetch the file. Before changing a figure or answering a comment on one, \`read\` with \`images: true\` (\`diagrams: true\` for diagrams).
4. Prefer \`edit\` for small changes, \`write\` for new pages or rewrites, \`batch\` for related changes so they land as one request. Pass \`if_match\` (the hash from your last read); on a conflict, re-read and reapply. Bodies are stored in a canonical form (\`-\` bullets, \`*\` emphasis, padded tables): what you write reads back normalized, so \`edit\` the text as \`read\` shows it.
5. Put a one-line \`note\` on every write. Read the \`lint\` in every write result and fix what it reports (figure and diagram lint too: \`image_*\`, \`figure_invalid\`, \`diagram_invalid\`, \`diagram_unrendered\`, \`svg_invalid\`, \`svg_unsafe\`, \`chart_invalid\` mean fix the image or the fence; a fence's lint names it by its number in \`read\`'s Figures list, the number \`render\` and \`read\` take); the result's notes say what else to know (ignored fields, the stored form, open comments). A page with no frontmatter or invalid YAML is refused. Keep pages under 100 KB; split big ones into linked pages.
6. Never write index.md or log.md (the server synthesizes them). Never set \`generated\` (the server stamps it) or \`verified\` (not yours to claim). \`status\` is optional: \`draft\` while a page is unfinished, \`deprecated\` once it is retired; it is not a review, which only people give. Set \`stale_after\` only when something the page relies on will change. Timestamps are full ISO 8601 datetimes with an offset (\`stale_after: 2026-12-31T00:00:00Z\`); a plain date is flagged.
7. Use \`work\` to find what needs doing: open comments, stale pages, broken links, lint, hotlinked images (\`external_image\`), and structure (a directory's index.md made poor by its pages: missing, long or title-repeating descriptions, titles that read the same, over 50 pages in one directory); \`work\` with kind stale_soon lists what goes stale within 14 days. Only a new \`stale_after\` resets a page's clock; other edits leave it stale.
8. Comments are how people ask you for changes. Before editing a page, read its open threads with \`comments\`; make the change a comment asks for, then answer it with \`comment\` (reply, and resolve what you fixed). Ask with a reply when unsure; never resolve a thread you did not address. A page with open threads cannot be deleted until they are resolved. A thread may be on the whole library rather than a page (no path). A thread marked a \`request\` (\`work\` lists it as a \`request\` item) is a bigger ask someone left for people's agents: do the work it asks for, reply with what you did, then resolve it.
9. When the person asks to see a page, or you want them to read one (e.g. one you just wrote), \`show\` it: a chat that shows apps draws it in a panel as the Tempra app does. Do not \`show\` what you only read for yourself.
10. When you tell the person about a page, link it by its URL, never its bare path: \`read\` gives a page's \`url\`, a write's result names each written page's, \`search\` gives one per result, and \`start\` gives the library's (a page opens at its path after it).`;

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });

/**
 * The upload panel (TEMPRA-200; tempra-dev app/media, Upload panel): an MCP App (SEP-1865) that
 * a host with `io.modelcontextprotocol/ui` draws in the chat beside a `prepare_upload` call. The
 * server is stateless, so it cannot tell on each call whether the client takes apps: the tool
 * always names the panel, and a host without the extension ignores `_meta.ui`.
 */
export const UPLOAD_PANEL_URI = "ui://tempra/upload";
export const MCP_APP_MIME = "text/html;profile=mcp-app";

/** The panel's `_meta.ui`: it talks to this deployment and nothing else. */
const panelMeta = (origin: string) => ({
  ui: { csp: { connectDomains: [origin] }, prefersBorder: true },
});

/**
 * The page panel (tempra-dev: app/page-panel): `show` draws one page in the chat with the app's
 * reader and the design package, read only. It loads Inter, Pele (for diagrams) and the page's
 * images from this deployment (signed image links; the fonts and Pele are static assets), so it
 * declares the origin for resources, which hosts allow for scripts too; it calls nothing.
 */
export const PAGE_PANEL_URI = "ui://tempra/page";
const pagePanelMeta = (origin: string) => ({
  ui: { csp: { resourceDomains: [origin] }, prefersBorder: true },
});
/**
 * The panel's document, its fonts at this deployment's own `/_design/` URLs and Pele at its
 * `/_app/` chunk (app/build.ts leaves `__TEMPRA_ORIGIN__` for the origin).
 */
/**
 * The changes panel (TEMPRA-291, a spike; tempra-dev: app/source-diff): `diff` draws the page's
 * Markdown between two versions in the chat with Pierre's diffs, stacked or split. Everything is
 * in its one document and the result, so it declares no domains.
 */
export const CHANGES_PANEL_URI = "ui://tempra/changes";
const changesPanelMeta = { ui: { prefersBorder: true } };
export const pagePanelHtml = (origin: string) =>
  pagePanel
    .replaceAll('url("/_design/', `url("${origin}/_design/`)
    .replaceAll("__TEMPRA_ORIGIN__/_app/", `${origin}/_app/`);
const line = (t: string) => ({ type: "text" as const, text: t });

/** SVG text `read` returns as is (models read it well enough until TEMPRA-165 rasterizes it). */
const SVG_TEXT_BYTES = 100 * 1024;
/** Files an `tempra://` resource carries as bytes (TEMPRA-155); above it, the download link. */
const RESOURCE_BYTES = 2 * 1024 * 1024;
/**
 * A PDF `read` returns as an embedded resource (TEMPRA-164), as much as a call's images may be
 * (IMAGE_BYTES_PER_CALL) and no more than a resource carries; above it, the facts and the link.
 */
export const PDF_RESOURCE_BYTES = Math.min(RESOURCE_BYTES, IMAGE_BYTES_PER_CALL);

export { RENDER_WIDTH };
/**
 * Renders per account a minute (tempra-dev: app/media, Limits): the `render` rate limit, counted
 * on WRITE_LIMITER under its own key (`render:<account>`), whose limit is the same 60.
 */
export const RENDERS_PER_MINUTE = 60;

/** Pele's error as one line, with its place and the source line it names. */
export function renderErrorText(e: RenderError, source?: string): string {
  const at = e.line > 0 ? ` (line ${e.line}${e.column > 0 ? `, column ${e.column}` : ""})` : "";
  const src = e.line > 0 ? source?.split("\n")[e.line - 1] : undefined;
  return `${e.message}${at}${src !== undefined ? `\n  ${e.line} | ${src}` : ""}`;
}

/** What one drawing of a diagram for a model came to. */
type Drawn =
  | { kind: "image"; bytes: Uint8Array; media: string; width: number; height: number }
  /** The PNG could not be drawn or sent: the SVG instead, with why. */
  | { kind: "svg"; svg: string; why: string }
  /** Pele refused the source. */
  | { kind: "refused"; error: RenderError }
  /** Nothing drawn: the service is unavailable or the account is over its cap. */
  | { kind: "unavailable"; why: string };

/**
 * The library's health summary for `start` (TEMPRA-66): the daily check's counts by kind, and
 * the newest changes nobody has verified since. Kinds with nothing open are left out.
 */
export function healthLines(h: LibraryHealth): string[] {
  const names: [keyof LibraryHealth["counts"], string][] = [
    ["stale", "stale"],
    ["stale_soon", "stale soon"],
    ["broken_link", "broken links"],
    ["lint", "lint"],
    ["external_image", "hotlinked images"],
    ["structure", "structure"],
    ["comment", "open comments"],
    ["request", "requests"],
  ];
  const counts = names
    .filter(([k]) => (h.counts[k] ?? 0) > 0)
    .map(([k, label]) => `${label} ${h.counts[k]}`)
    .join(" · ");
  const newest = h.unverified.newest
    .slice(0, 3)
    .map((c) => `${c.path} (${c.actor}, ${c.ts})`)
    .join(", ");
  return [
    `Health (checked ${h.at}): ${counts || "nothing open"}`,
    ...(h.unverified.total > 0
      ? [
          `Unverified: ${h.unverified.total} page${h.unverified.total === 1 ? "" : "s"} changed since anyone last verified them; newest ${newest}`,
        ]
      : []),
  ];
}

/**
 * A call that still sends the removed `content_base64` (an old client, a cached schema) is
 * refused by name, never stored or ignored (TEMPRA-203; tempra-dev
 * decisions/agents-never-type-file-bytes).
 */
function base64Removed(): StoreError {
  return new StoreError(
    400,
    "base64_removed",
    "`attach` no longer takes `content_base64`: a file's bytes never go through a tool argument. For a file on the public web, call `attach` with `source_url` and the server fetches it. For a file you made or the person has, call `prepare_upload`: run its curl line if your shell reaches this server, otherwise the person sends the file from their browser (the upload panel or link). Nothing was written.",
  );
}

function errorResult(e: unknown): CallToolResult {
  if (!(e instanceof StoreError)) throw e;
  const lines = [`Error ${e.status} ${e.code}: ${e.message}`];
  if (e.extra.current_hash !== undefined) {
    lines.push(`current_hash: ${e.extra.current_hash ?? "(none: the path does not exist)"}`);
  }
  if (typeof e.extra.current === "string") {
    lines.push("", "Current document:", "", e.extra.current);
  }
  if (e.status === 412)
    lines.push("", "Re-read the file, reapply your change, and pass the new hash as if_match.");
  if (e.code === "exists")
    lines.push(
      "",
      "To replace it, pass current_hash as if_match; to keep both, pick another path.",
    );
  return { isError: true, content: [{ type: "text", text: lines.join("\n") }] };
}

function lintText(lint: LintWarning[]): string {
  if (lint.length === 0) return "Lint: none.";
  return ["Lint (fix these):", ...lint.map((l) => `- ${l.code}: ${l.message}`)].join("\n");
}

/** Where a library's pages open in the app, from this deployment's origin (TEMPRA-5). */
interface AppLinks {
  library: string;
  activity: string;
  page: (path: string, at?: number) => string;
  folder: (dir: string) => string;
}

/** The app's URLs for one library, on this origin, so previews and staging link to themselves. */
export function appLinks(origin: string, owner: string, slug: string): AppLinks {
  const urls = new Urls(owner, slug);
  return {
    library: `${origin}${urls.base}`,
    activity: `${origin}${urls.base}-/activity`,
    page: (path, at) => `${origin}${new Urls(owner, slug, at).file(path)}`,
    folder: (dir) => `${origin}${urls.tree(dir)}`,
  };
}

/**
 * A write's result. With `links` (TEMPRA-5), each file that still exists carries its page's URL
 * in the app, and the request names the library's Activity, so the agent can hand the person a
 * link rather than a path.
 */
function writeText(verb: string, res: WriteResult, links?: AppLinks): string {
  const lines = res.results.map((r) => {
    const what = r.from ? `${r.from} → ${r.path}` : r.path;
    if (r.hash === null) return `${verb} ${what} (${r.op}, seq ${r.seq}).`;
    const url = links ? ` · ${links.page(r.path)}` : "";
    return `${verb} ${what} (${r.op}, seq ${r.seq}): hash ${r.hash}${url}`;
  });
  const seqs = res.results.map((r) => r.seq);
  const range =
    res.results.length > 1
      ? ` (${res.results.length} files, seq ${Math.min(...seqs)}–${Math.max(...seqs)})`
      : "";
  const lint = res.results.flatMap((r) =>
    r.lint.map((l) => ({ ...l, message: `${r.path}: ${l.message}` })),
  );
  const notices = res.results.flatMap((r) =>
    (r.notices ?? []).map((l) => `- ${l.code}: ${r.path}: ${l.message}`),
  );
  const diffs = res.results.flatMap((r) =>
    r.normalized
      ? ["", `Stored form of ${r.path} (diff from what you sent):`, "", r.normalized.trimEnd()]
      : [],
  );
  return [
    ...lines,
    `Request ${res.request_id}${range}.${links ? ` Activity: ${links.activity}` : ""}`,
    lintText(lint),
    ...(notices.length > 0 ? ["Notes:", ...notices] : []),
    ...diffs,
  ].join("\n");
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

const EditSchema = z.object({
  old: z.string().describe("Text to find; must occur exactly once in the rendered document."),
  new: z.string().describe("Replacement text."),
});

const BatchOpSchema = z.object({
  op: z.enum(["write", "edit", "move", "delete"]),
  path: z.string(),
  content: z.string().optional().describe("write: the whole page: frontmatter and markdown."),
  edits: z.array(EditSchema).optional().describe("edit: find-and-replace pairs."),
  to: z.string().optional().describe("move: the destination path."),
  if_match: z.string().optional().describe("write (replace), edit, delete: the current hash."),
});

const LIBRARY_ARG =
  "The library, as owner/slug from `start` (a bare slug works when it is unique). Needed only when you can reach more than one.";

const libraryList = (libs: TokenInfo[]) =>
  libs.map((t) => `${t.library.owner}/${t.library.slug}`).join(", ");

export function buildServer(ctx: McpContext): McpServer {
  const tier2 = ctx.tiers !== "files";
  const libArg = { library: z.string().optional().describe(LIBRARY_ARG) };
  const server = new McpServer(
    { name: SERVER_NAME, version: "0.2.0" },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, resources: {} } },
  );

  /** The library a call names, or the only one there is. */
  const pick = (name?: string): { token: TokenInfo; lib: LibraryClient } => {
    const libs = ctx.libraries;
    if (libs.length === 0) {
      throw new StoreError(
        404,
        "no_library",
        `This connection reaches no libraries yet. Create one with \`create_library\` if the person asks for one (and allowed it at consent), or at ${ctx.origin}/, or reconnect and choose one.`,
      );
    }
    const want = (name ?? "")
      .trim()
      .replace(/^\/+|\/+$/g, "")
      .toLowerCase();
    if (want === "" && libs.length > 1) {
      throw new StoreError(
        400,
        "library_required",
        `You can reach ${libs.length} libraries; pass library, one of: ${libraryList(libs)}.`,
      );
    }
    const bySlug = libs.filter((t) => t.library.slug === want);
    const found =
      want === ""
        ? libs[0]
        : want.includes("/")
          ? libs.find((t) => `${t.library.owner}/${t.library.slug}` === want)
          : bySlug.length === 1
            ? bySlug[0]
            : undefined;
    if (!found) {
      throw new StoreError(
        404,
        "no_library",
        `There is no library ${name} here; you can reach: ${libraryList(libs)}.`,
      );
    }
    return { token: found, lib: ctx.open(found) };
  };

  const linksFor = (token: TokenInfo) =>
    appLinks(ctx.origin, token.library.owner, token.library.slug);

  const request = (note?: string): RequestContext => ({
    actor: ctx.actor,
    request_id: crypto.randomUUID(),
    note: note ?? null,
    by: ctx.by ?? null,
  });

  /** A comment action, told to the people it addresses where the Worker wires that. */
  const post = (token: TokenInfo, lib: LibraryClient, action: CommentAction) =>
    ctx.comment ? ctx.comment(token, request(), action) : lib.comment(request(), action);

  const checkWrite = (token: TokenInfo, ...paths: string[]) => {
    if (token.scope !== "write") {
      throw new StoreError(
        403,
        "read_only",
        "You have read access here: you can read and comment, not change content.",
      );
    }
    checkPrefix(token, paths);
  };

  /** Comments are their own permission (tempra-dev: v2/sharing): read access may comment. */
  const checkComment = (token: TokenInfo, path: string) => checkPrefix(token, [path]);

  const checkPrefix = (token: TokenInfo, paths: string[]) => {
    if (token.prefix === null) return;
    for (const p of paths) {
      if (!underPrefix(normalizePath(p) ?? "", token.prefix)) {
        throw new StoreError(
          403,
          "outside_prefix",
          `This token may only write under ${token.prefix}/.`,
        );
      }
    }
  };

  const guarded =
    <A>(fn: (args: A) => Promise<CallToolResult>) =>
    async (args: A): Promise<CallToolResult> => {
      try {
        return await fn(args);
      } catch (e) {
        return errorResult(e);
      }
    };

  const downloadUrl = async (
    { token, lib }: ReturnType<typeof pick>,
    payload: Parameters<LibraryClient["signDownload"]>[0],
  ) =>
    `${ctx.origin}/dl/${encodeURIComponent(token.library.do_id)}/${await lib.signDownload(payload)}`;

  const images = ctx.images ?? imagesService({ blobs: ctx.blobs });

  /**
   * What `read` adds for an image attachment (TEMPRA-153): the image itself, or why not; for a
   * PDF within PDF_RESOURCE_BYTES, the PDF as an embedded resource (TEMPRA-164). Video and audio
   * stay facts.
   */
  const shown = async (
    token: TokenInfo,
    blob: { path: string; hash: string; size: number; media: string | null },
  ): Promise<CallToolResult["content"]> => {
    if (blob.media === "application/pdf") {
      if (blob.size > PDF_RESOURCE_BYTES) {
        return [
          line(
            `PDF over ${sizeText(PDF_RESOURCE_BYTES)}, not attached here; download it from the URL above.`,
          ),
        ];
      }
      const obj = await ctx.blobs.get(blob.hash);
      if (!obj) return [];
      ctx.meter?.({ kind: "read_pdf", library: token.library.id, bytes: blob.size });
      return [
        {
          type: "resource",
          resource: {
            uri: `${URI_SCHEME}://${token.library.owner}/${token.library.slug}/${blob.path}`,
            mimeType: "application/pdf",
            blob: toBase64(await readBytes(obj.body)),
          },
        },
      ];
    }
    if (blob.media === "image/svg+xml") {
      if (blob.size > SVG_TEXT_BYTES) {
        return [
          line(`SVG too large to show here (over ${SVG_TEXT_BYTES / 1024} KB); download it.`),
        ];
      }
      const obj = await ctx.blobs.get(blob.hash);
      if (!obj) return [];
      return [line(`SVG source:\n${new TextDecoder().decode(await readBytes(obj.body))}`)];
    }
    if (!blob.media || !RASTER_MEDIA.has(blob.media)) return [];
    const img = await images.forModel(blob);
    if ("missing" in img) return [];
    if ("tooLarge" in img) {
      return [line("Image too large to show here; download it from the URL above.")];
    }
    ctx.meter?.({ kind: "read_image", library: token.library.id, bytes: img.bytes.byteLength });
    return [{ type: "image", data: toBase64(img.bytes), mimeType: img.media }];
  };

  /**
   * A diagram drawn for a model (TEMPRA-166): the render Worker's PNG (its cache makes a fence
   * that did not change cost one R2 read), sized like an image for a model; the SVG when the PNG
   * cannot be drawn (Browser Rendering not enabled, a timeout) or sent; Pele's error; or why
   * nothing was drawn. Each call counts once against the account's render cap.
   */
  const draw = async (
    source: string,
    theme: "light" | "dark",
    library?: string,
    lang: RenderLang = "mermaid",
    /** For a chart: the library and the page its data paths resolve from (TEMPRA-207). */
    from?: { lib: LibraryClient; path: string },
  ): Promise<Drawn> => {
    const unavailable = (message = RENDER_UNAVAILABLE): Drawn => ({
      kind: "unavailable",
      why: `the render service is unavailable${message.slice(RENDER_UNAVAILABLE.length)}`,
    });
    if (!ctx.render) return unavailable();
    if (source.length > MAX_RENDER_SOURCE) {
      return {
        kind: "refused",
        error: {
          message: `The diagram is longer than the limit of ${MAX_RENDER_SOURCE} characters.`,
          line: 0,
          column: 0,
        },
      };
    }
    if (ctx.allowRender && !(await ctx.allowRender())) {
      return {
        kind: "unavailable",
        why: `over the limit of ${RENDERS_PER_MINUTE} renders a minute for this account; try again in a minute`,
      };
    }
    if (lang === "vega-lite") {
      const chart = await chartForRender(
        source,
        from?.path ?? "",
        from ? libraryText(from.lib, ctx.blobs) : async () => null,
      );
      if (!chart.ok) return { kind: "refused", error: chart.error };
      source = chart.source;
    }
    const r = await ctx.render(
      { source, ...(lang !== "mermaid" ? { lang } : {}), theme, width: RENDER_WIDTH, png: true },
      library,
    );
    if (r.png) {
      const img = await images.fitForModel(r.png, "image/png");
      if ("bytes" in img) {
        const info = imageInfo(img.bytes);
        return {
          kind: "image",
          bytes: img.bytes,
          media: img.media,
          width: info?.ok ? info.width : 0,
          height: info?.ok ? info.height : 0,
        };
      }
      if (r.svg) return { kind: "svg", svg: r.svg, why: "the PNG is too large to send" };
    }
    if (r.svg) {
      return {
        kind: "svg",
        svg: r.svg,
        why: r.error ? r.error.message : "the render service drew no PNG",
      };
    }
    const error = r.error ?? { message: "Nothing was drawn.", line: 0, column: 0 };
    if (error.message.startsWith(RENDER_UNAVAILABLE)) return unavailable(error.message);
    if (lang === "vega-lite")
      return { kind: "refused", error: { ...error, message: vegaErrorText(error.message) } };
    return { kind: "refused", error };
  };

  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const writes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  // ------------------------------------------------------------------ tier 1: file-equivalent

  const you = () =>
    `You are ${ctx.actor} (${ctx.scope}${ctx.libraries[0]?.prefix ? `, under ${ctx.libraries[0].prefix}/` : ""}). Tools: ${tier2 ? "file tools and beyond-files tools" : "file tools only"}.`;

  /** What `start` shows for one library, and `create_library` for the one it made. */
  const opening = async (token: TokenInfo, lib: LibraryClient): Promise<string> => {
    const [summary, root, about] = await Promise.all([
      lib.summary(),
      lib.read("index.md"),
      ctx.about ? ctx.about(token.library.id).catch(() => null) : null,
    ]);
    const empty = summary.pages + summary.attachments === 0;
    const others = ctx.libraries.filter((t) => t !== token);
    const lines = [
      `# Library ${token.library.owner}/${token.library.slug} (seq ${summary.seq})`,
      "",
      `In the app: ${linksFor(token).library} (a page opens at its path after it; link it when you tell the person about a page)`,
      ...(about?.title ? [`Title: ${about.title}`] : []),
      ...(about?.description ? [`Description: ${about.description}`] : []),
      `Pages: ${summary.pages} · attachments: ${summary.attachments} · open work items: ${summary.open_work} (${summary.open_comments} of them comment threads)${summary.stale_soon > 0 ? ` · stale soon: ${summary.stale_soon} (\`work\` kind stale_soon)` : ""}`,
      ...healthLines(summary.health),
      you(),
      ...(others.length > 0
        ? [`Other libraries you can reach: ${libraryList(others)}. Pass \`library\` on every call.`]
        : []),
      "",
      "## Root index.md",
      "",
      empty
        ? "(The library is empty. Start with a `guide.md` at the root that says what the library is for, then the pages; `write` describes the format.)"
        : root.kind === "derived"
          ? root.markdown.trimEnd()
          : "",
      "",
      "## How to work here",
      "",
      "- If the root holds a `guide.md`, read it first: it says what the library is for and how it is written.",
      "- `browse` a directory before reading; follow links; check a page's trust tier and staleness before relying on it.",
      "- `edit` for small changes, `write` for new pages or rewrites, `batch` for related changes. Pass `if_match` from your last read; on a 412, re-read and reapply.",
      "- A one-line `note` on every write. Fix the `lint` each write returns. Never write index.md or log.md, and never set generated or verified.",
      "- A page starts with YAML frontmatter (its `title` and a one-line `description`), or the write is refused. A page with open comment threads cannot be deleted until they are resolved.",
    ];
    if (tier2) {
      lines.push(
        "- `work` lists open comments, stale pages, broken links and lint to fix; `log` shows what others changed recently.",
        "- Comments are requests from people: read a page's open threads (`comments`) before editing it, then reply and resolve with `comment`.",
      );
    }
    return lines.join("\n");
  };

  server.registerTool(
    "start",
    {
      title: "Start here",
      description:
        "Call this first in every session. Opens a library: its root index.md (what is here, one level down), counts by page type, the number of open work items, the daily health check (open work by kind, the newest unverified changes), and how to work in it. When you can reach several libraries and pass no `library`, lists them instead.",
      inputSchema: libArg,
      annotations: readOnly,
    },
    guarded(async ({ library }) => {
      if (!library && ctx.libraries.length !== 1) {
        if (ctx.libraries.length === 0) pick();
        return text(
          [
            `# Your libraries (${ctx.libraries.length})`,
            "",
            you(),
            "",
            ...ctx.libraries.map((t) => `- ${t.library.owner}/${t.library.slug}`),
            "",
            "Call `start` with `library` to open one, and pass the same `library` on every other call.",
          ].join("\n"),
        );
      }
      const { token, lib } = pick(library);
      return text(await opening(token, lib));
    }),
  );

  server.registerTool(
    "create_library",
    {
      title: "Create a library",
      description:
        "Creates a new library owned by the person you act for, exactly as if they made it in the app, and opens it as `start` does; then pass its owner/slug as `library` on every call. Only when the person asks for a new library. Needs a read-and-write connection the person allowed to create libraries at consent; it counts against their library limit. You cannot invite members, share, transfer or delete it: the person does that in the app.",
      inputSchema: {
        slug: z
          .string()
          .describe(
            "The library's name in its URL: lowercase letters, digits and hyphens, up to 63 characters, e.g. `recipes`. Its owner is always the person you act for.",
          ),
        title: z
          .string()
          .optional()
          .describe("Optional: what the library is called, one line (up to 120 characters)."),
        description: z
          .string()
          .optional()
          .describe("Optional: what the library is for, one line (up to 300 characters)."),
      },
      annotations: writes,
    },
    guarded(async ({ slug, title, description }) => {
      if (!ctx.createLibrary) {
        throw new StoreError(
          403,
          "create_not_allowed",
          `This token reaches one library and cannot create libraries. The person can create one at ${ctx.origin}/, or connect an app over OAuth and allow Create libraries.`,
        );
      }
      const made = await ctx.createLibrary({ slug, title, description });
      // Later calls in this request reach it too; later requests resolve it from the grant.
      ctx.libraries = [...ctx.libraries, made.token];
      const { token, lib } = pick(`${made.token.library.owner}/${made.token.library.slug}`);
      return text(
        [
          `Created library ${token.library.owner}/${token.library.slug}, owned by @${token.library.owner}. Pass library: "${token.library.owner}/${token.library.slug}" on every call.`,
          "",
          await opening(token, lib),
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "browse",
    {
      title: "Browse a directory",
      description:
        "One directory level, like `ls` plus `cat index.md`: subdirectories with page counts, and pages with their titles and descriptions. The index is synthesized by the server from the pages' frontmatter. Omit `dir` for the root.",
      inputSchema: {
        dir: z.string().optional().describe("Directory path, e.g. `tables`. Omit for the root."),
        ...libArg,
      },
      annotations: readOnly,
    },
    guarded(async ({ dir, library }) => {
      const { token, lib } = pick(library);
      const d = normalizePath(dir ?? "") ?? "";
      const view = await lib.read(d ? `${d}/index.md` : "index.md");
      const links = linksFor(token);
      return text(
        view.kind === "derived"
          ? `In the app: ${d ? links.folder(d) : links.library} (each page at its path under ${links.library})\n\n${view.markdown}`
          : "",
      );
    }),
  );

  /**
   * The figures `read` of a page sends as images: internal raster images (TEMPRA-154) and
   * drawn diagrams (TEMPRA-166), each after a line naming it, within IMAGES_PER_CALL and
   * IMAGE_BYTES_PER_CALL together; then what was left out and why. `want` is every image, every
   * diagram, or figures by number (either kind). External images are never fetched.
   */
  const figureImages = async (
    token: TokenInfo,
    figures: FigureFact[],
    want: { images: boolean; diagrams: boolean } | number[],
    from?: { lib: LibraryClient; path: string },
  ): Promise<CallToolResult["content"]> => {
    const left = new Map<number, string>();
    const asked: FigureFact[] = [];
    if (!Array.isArray(want)) {
      asked.push(...figures.filter((f) => (f.kind === "diagram" ? want.diagrams : want.images)));
    } else {
      for (const n of [...new Set(want)].sort((a, b) => a - b)) {
        const f = figures[n - 1];
        if (f) asked.push(f);
        else left.set(n, `no such figure (this page has ${figures.length})`);
      }
    }
    const candidates: FigureFact[] = [];
    for (const f of asked) {
      if (f.kind === "diagram") {
        if (!isRenderLang(f.lang)) left.set(f.n, `not a figure the server draws (${f.lang})`);
        else candidates.push(f);
      } else if (f.status === "external") {
        left.set(f.n, "external images are not fetched (TEMPRA-163)");
      } else if (f.status === "missing" || !f.blob) {
        left.set(f.n, `missing: no attachment at ${f.path !== null ? `/${f.path}` : f.url}`);
      } else if (f.blob.media === "image/svg+xml") {
        left.set(f.n, `SVG is not sent as an image yet; \`read\` /${f.path} for its source`);
      } else if (!f.blob.media || !RASTER_MEDIA.has(f.blob.media)) {
        const media = f.blob.media ?? "unknown type";
        left.set(
          f.n,
          media === "application/pdf"
            ? `a PDF; \`read\` /${f.path} for it`
            : `not an image (${media})`,
        );
      } else candidates.push(f);
    }
    for (const f of candidates.slice(IMAGES_PER_CALL)) {
      left.set(f.n, `over the cap of ${IMAGES_PER_CALL} images a call; ask with figures: [${f.n}]`);
    }
    type Got =
      | { f: FigureFact & { kind: "image" }; img: Awaited<ReturnType<Images["forModel"]>> }
      | { f: FigureFact & { kind: "diagram" }; drawn: Drawn };
    const fetched = await Promise.all(
      candidates.slice(0, IMAGES_PER_CALL).map(
        async (f): Promise<Got> =>
          f.kind === "diagram"
            ? {
                f,
                drawn: await draw(f.source, "light", token.library.id, f.lang as RenderLang, from),
              }
            : { f, img: await images.forModel(f.blob as NonNullable<typeof f.blob>) },
      ),
    );
    const out: CallToolResult["content"] = [];
    let bytes = 0;
    const overBytes = (n: number) =>
      `over the cap of ${sizeText(IMAGE_BYTES_PER_CALL)} of images a call; ask with figures: [${n}]`;
    for (const got of fetched) {
      if ("drawn" in got) {
        const { f, drawn } = got;
        const name = `Figure ${f.n}: ${f.title || `diagram (${f.type ?? f.lang})`}`;
        if (drawn.kind === "refused") {
          left.set(
            f.n,
            `${drawerOf(f.lang)} could not draw it: ${renderErrorText(drawn.error, f.source)}`,
          );
        } else if (drawn.kind === "unavailable") {
          left.set(f.n, `not drawn: ${drawn.why}`);
        } else if (drawn.kind === "svg") {
          const svgBytes = new TextEncoder().encode(drawn.svg).byteLength;
          if (svgBytes > SVG_TEXT_BYTES) {
            left.set(
              f.n,
              `not drawn as a PNG (${drawn.why}), and its SVG is over ${sizeText(SVG_TEXT_BYTES)}`,
            );
          } else if (bytes + svgBytes > IMAGE_BYTES_PER_CALL) left.set(f.n, overBytes(f.n));
          else {
            bytes += svgBytes;
            out.push(line(`${name} (as SVG: ${drawn.why})\n${drawn.svg}`));
          }
        } else if (bytes + drawn.bytes.byteLength > IMAGE_BYTES_PER_CALL) {
          left.set(f.n, overBytes(f.n));
        } else {
          bytes += drawn.bytes.byteLength;
          ctx.meter?.({
            kind: "read_image",
            library: token.library.id,
            bytes: drawn.bytes.byteLength,
          });
          out.push(line(name));
          out.push({ type: "image", data: toBase64(drawn.bytes), mimeType: drawn.media });
        }
        continue;
      }
      const { f, img } = got;
      if ("missing" in img) {
        left.set(f.n, `its bytes are missing (/${f.path})`);
        continue;
      }
      if ("tooLarge" in img) {
        left.set(
          f.n,
          `too large to send (${sizeText(img.size)}); \`read\` /${f.path} for a download URL`,
        );
        continue;
      }
      if (bytes + img.bytes.byteLength > IMAGE_BYTES_PER_CALL) {
        left.set(f.n, overBytes(f.n));
        continue;
      }
      bytes += img.bytes.byteLength;
      ctx.meter?.({ kind: "read_image", library: token.library.id, bytes: img.bytes.byteLength });
      out.push(line(`Figure ${f.n}: ${f.title || f.alt || `/${f.path}`}`));
      out.push({ type: "image", data: toBase64(img.bytes), mimeType: img.media });
    }
    if (left.size > 0) {
      const lines = [...left].sort(([a], [b]) => a - b).map(([n, why]) => `Figure ${n}: ${why}`);
      out.push(line(["Not shown:", ...lines].join("\n")));
    }
    return out;
  };

  const readSchema = {
    path: z.string().describe("Page or file path, e.g. `tables/orders.md` (the .md is optional)."),
    image: z
      .boolean()
      .optional()
      .describe("For an image attachment: false returns only its facts, without the image itself."),
    images: z
      .boolean()
      .optional()
      .describe(
        `For a page: true adds its figures' images after the markdown (at most ${IMAGES_PER_CALL}).`,
      ),
    diagrams: z
      .boolean()
      .optional()
      .describe(
        "For a page: true adds its Mermaid diagrams drawn as images, as people see them, after the markdown (sharing the cap with `images`).",
      ),
    figures: z
      .array(z.number().int().min(1))
      .optional()
      .describe(
        "For a page: only these figures (images or diagrams), by number as the Figures list gives them.",
      ),
    ...(tier2
      ? {
          at: z
            .number()
            .int()
            .optional()
            .describe(
              `${BEYOND}read the file as it was at this ledger sequence number (time travel).`,
            ),
        }
      : {}),
    ...libArg,
  };
  server.registerTool(
    "read",
    {
      title: "Read a file",
      description: `Read a page as markdown (frontmatter and body), with its hash, sequence, trust tier, staleness, lint, inbound link count and its figures above it (one line each, numbered as the app numbers them: path or URL, alt, caption, dimensions, size, and ok, missing or external; diagrams by type). Pass the hash as \`if_match\` when you edit, replace or delete. Check trust tier and \`stale\` before relying on the content. Ask for the figures' images with \`images: true\`, for the Mermaid diagrams drawn as people see them with \`diagrams: true\`, or for some figures of either kind with \`figures: [n]\`, when you review the page, change a figure or its caption, or answer a comment on one; they come after the markdown, each after a line naming it, at most ${IMAGES_PER_CALL} and ${IMAGE_BYTES_PER_CALL / 1048576} MB a call in all, what was left out listed with the reason (for a diagram that does not draw, Pele's error); external images are not fetched. Also reads index.md and log.md (the latest 200 requests; \`log\` pages back further); for an attachment returns its size and a short-lived download URL, and for an image (PNG, JPEG, GIF, WebP) the image itself, scaled to at most 1568 px (SVG as its text); for a PDF up to ${sizeText(PDF_RESOURCE_BYTES)}, the PDF as an embedded resource.`,
      inputSchema: readSchema,
      annotations: readOnly,
    },
    guarded(
      async (args: {
        path: string;
        image?: boolean;
        images?: boolean;
        diagrams?: boolean;
        figures?: number[];
        at?: number;
        library?: string;
      }) => {
        const picked = pick(args.library);
        const view = await withDimensions(
          picked.lib,
          ctx.blobs,
          await picked.lib.read(args.path, { at: args.at, figures: true, reads: true }),
        );
        if (view.kind === "derived") return text(view.markdown);
        if (view.kind === "attachment") {
          const url = await downloadUrl(picked, {
            k: "file",
            path: view.path,
            hash: view.hash,
            media: view.media,
          });
          // How many versions the file has had, as its page's File history lists them.
          const versions = (await picked.lib.history(view.path)).events.filter(
            (e) => (e.op === "put" || e.op === "import" || e.op === "revert") && e.hash !== null,
          ).length;
          const facts = text(
            [
              `path: ${view.path}`,
              `url: ${linksFor(picked.token).page(view.path)}`,
              `hash: ${view.hash}`,
              `seq: ${view.seq}`,
              `size: ${view.size} bytes · media: ${view.media ?? "unknown"}`,
              ...(view.width && view.height ? [`dimensions: ${view.width}×${view.height} px`] : []),
              ...(view.source
                ? [
                    `source: ${view.source.url}, fetched ${view.source.fetched_at}${view.source.final_url ? ` (from ${view.source.final_url} after redirects)` : ""}; cite it in \`sources\` where you use it`,
                  ]
                : []),
              ...(view.description ? [`description: ${view.description}`] : []),
              ...(view.credit ? [`credit: ${view.credit}`] : []),
              ...(view.licence ? [`licence: ${view.licence}`] : []),
              ...(view.made_from
                ? [
                    `made from: /${view.made_from.path} (${view.made_from.op}; that file at hash ${view.made_from.hash.slice(0, 12)})`,
                  ]
                : []),
              ...(view.supplied_by
                ? [
                    `supplied by: @${view.supplied_by} (${view.origin === "agent" ? "an agent made the file; the person sent it" : "the person sent the file"})`,
                  ]
                : []),
              ...(view.poster ? [`poster: /${view.poster.path}`] : []),
              ...(view.poster_for ? [`poster for: /${view.poster_for}`] : []),
              `versions: ${versions}`,
              `download (15 minutes): ${url}`,
            ].join("\n"),
          );
          if (args.image !== false) facts.content.push(...(await shown(picked.token, view)));
          return facts;
        }
        const status =
          typeof view.frontmatter.status === "string"
            ? view.frontmatter.status
            : "not set (reads as stable)";
        const figures = await figuresWithDimensions(picked.lib, ctx.blobs, view.figures ?? []);
        const result = text(
          [
            `path: ${view.path}`,
            `url: ${linksFor(picked.token).page(view.path, args.at)}`,
            `hash: ${view.hash}`,
            `seq: ${view.seq}${args.at !== undefined ? ` (as of ${args.at})` : ""}`,
            `trust: ${view.trust_tier} · stale: ${view.stale ? "yes" : view.stale_soon ? "soon" : "no"} · status: ${status} · inbound links: ${view.inbound_links}`,
            // How much the page is read and how recently (TEMPRA-220): counts only, never who.
            ...(view.reads ? [readsText(view.reads, Date.now())] : []),
            ...(tier2 && view.open_comments > 0
              ? [
                  `Open comments: ${view.open_comments}. Read them with \`comments\` (path ${view.path}) before you edit.`,
                ]
              : []),
            lintText(view.lint),
            ...(figures.length > 0 ? ["Figures:", ...figures.map(figureLine)] : []),
            "",
            view.markdown,
          ].join("\n"),
        );
        const want =
          args.figures ??
          (args.images || args.diagrams
            ? { images: !!args.images, diagrams: !!args.diagrams }
            : null);
        if (want) {
          result.content.push(
            ...(await figureImages(picked.token, figures, want, {
              lib: picked.lib,
              path: view.path,
            })),
          );
        }
        return result;
      },
    ),
  );

  server.registerTool(
    "show",
    {
      title: "Show a page to the person",
      description:
        "Show one page to the person you work for, drawn as the Tempra app draws it, in a panel in the chat (in a chat that shows apps; elsewhere give them the link this returns). Use it when they ask to see a page, or when you want them to read one, e.g. after you wrote it. It is for reading only. Writes nothing.",
      _meta: { ui: { resourceUri: PAGE_PANEL_URI } },
      inputSchema: {
        path: z.string().describe("The page, e.g. `v2/limits.md`."),
        ...libArg,
      },
      annotations: readOnly,
    },
    guarded(async ({ path, library }) => {
      const { token, lib } = pick(library);
      const page = await pagePayload(lib, token, ctx.origin, path, ctx.agentNames);
      const result = text(
        [
          `Showing "${page.page.title}" (${page.page.path}) to the person in the chat, as the app draws it.`,
          `If it does not show, give them the link: ${pageUrl(ctx.origin, page)}`,
        ].join("\n"),
      );
      // The panel's data: the host hands it to the panel and keeps it out of the model's context.
      result.structuredContent = { page };
      return result;
    }),
  );

  server.registerTool(
    "write",
    {
      title: "Create or replace a page",
      description:
        'Write a whole page as markdown: a YAML frontmatter block with a `title` and a one-line `description` (plus, as the page needs them, `tags`, `sources`, `status`, `stale_after`, `resource`, or fields of your own), then a markdown body. Each `sources` entry is `id`, `title` and `resource` (a URL, or a path in this library such as `/dir/x.md`); `url` is taken as `resource`. `stale_after` and other timestamps are full ISO 8601 datetimes with an offset, e.g. 2026-12-31T00:00:00Z (a plain date is flagged). Prefer absolute links like [orders](/tables/orders.md); cite sources with footnotes: [^id] in the text, matching a `sources[].id`, plus a `[^id]: …` definition line at the end of the body. Diagrams and charts are best as rendered media, code the app draws, rather than a picture: a chart as a Vega-Lite spec in a ```vega-lite fence, Mermaid in a ```mermaid fence, or SVG in a ```svg fence (preview a non-trivial one with `render`); a fence with an unknown type, nothing after its header, or a bracket or quote left open is saved, shown as its source, and reported as `diagram_invalid` lint with the line and column inside the fence; `diagram_unrendered` lint (in the result when the renderer answers quickly, else in `work` and the next `read`) means Pele could not draw the fence, with its message, line and column: fix the fence. An SVG fence (```svg alt="what it shows" title="Caption"; up to 50 KB; `currentColor` takes the text colour in light and dark) is sanitized when drawn: `svg_invalid` lint means it does not parse (line and column given), `svg_unsafe` names what was taken out (scripts, event handlers, `<style>`, images, links, animation, references outside the SVG), and a missing alt (no `alt="…"` nor a `<title>`) is `image_no_alt`. A Vega-Lite fence (```vega-lite alt="what it shows" title="Caption"; a JSON spec, Vega-Lite 6) is drawn in the reader\'s greys in light and dark; its data is inline (`values`, rows or CSV text with `format`) or a CSV, TSV or JSON file in this library (`data.url`, a path such as `/data/sales.csv`, put there with `attach` or `prepare_upload`), nothing else is fetched; `chart_invalid` lint means it is not JSON, names data from elsewhere, does not fit the Vega-Lite schema (said at its path in the spec, e.g. `encoding.x.type: "bogus" is not one of …`), or Vega could not draw it (with its message); no alt (`alt="…"` or the spec\'s `description`) is `image_no_alt`. Images are `![what it shows](/dir/x-architecture.png "Caption")`, the file put beside the page by `attach` with `source_url` (on the web) or `prepare_upload` (one you made or the person has; never type its bytes); for a width, a placement or a group, wrap one to four images, one to a line, in `:::figure[group caption]{width=480|60% layout=column|wide|full frame}` and a closing `:::` (`frame` is a hairline for screenshots; in a group each title is a small label). An image may carry its footnote right after it, e.g. `![…](/x.jpg "Caption")[^src]` for a web image cited in `sources`: it is still a figure, with the marker at its caption\'s end. Video, audio and PDF use the same spelling (a video\'s poster is `x.poster.png` beside `x.mp4`). Figures are lint, never refused: `image_no_alt` (say what it shows), `image_external` (hotlinked; `attach` it with `source_url`), `image_large` (over 2 MB or 4000 px; make a smaller one with `transform`), `image_not_image` (not an image, video, audio or PDF; link it instead), `figure_invalid` (the markup does not parse). A file with no frontmatter or frontmatter that is not valid YAML is refused (400) and nothing is written. Without `if_match` it creates and fails if the path exists; to replace, pass the hash from your last read. The server stamps `generated` from your token; `verified` is not yours to set. The page is stored in a canonical form (`-` bullets, `*` emphasis; `sources` entries one key per line, `tags: [a, b]` on one line); when that differs from what you sent, the result shows the diff, so `edit` the stored text. Prefer `edit` for small changes. Read the lint and notes in the result and fix the lint.',
      inputSchema: {
        path: z.string().describe("Where to write, e.g. `metrics/revenue.md`."),
        content: z.string().describe("The whole page: frontmatter and markdown."),
        if_match: z.string().optional().describe("The current hash, to replace an existing page."),
        note: z.string().optional().describe("One line for the ledger: why you made this change."),
        ...libArg,
      },
      annotations: writes,
    },
    guarded(async ({ path, content, if_match, note, library }) => {
      const { token, lib } = pick(library);
      checkWrite(token, path);
      const res = await lib.apply(request(note), [{ op: "write", path, content, if_match }]);
      return text(writeText("Wrote", res, linksFor(token)));
    }),
  );

  server.registerTool(
    "edit",
    {
      title: "Edit a page",
      description:
        "Find-and-replace on the rendered document, frontmatter included, like an Edit tool. Each `old` must match exactly once; include enough surrounding text to make it unique; match the text as `read` shows it (stored in canonical form, which may differ from what was written). Edits apply in order. `if_match` is optional because the quoted text guards the edit. Preferred for small changes. On a mismatch the error includes the current document. The result names the page's open comment threads and any whose quote the edit removed.",
      inputSchema: {
        path: z.string(),
        edits: z.array(EditSchema).min(1),
        if_match: z.string().optional(),
        note: z.string().optional().describe("One line for the ledger."),
        ...libArg,
      },
      annotations: writes,
    },
    guarded(async ({ path, edits, if_match, note, library }) => {
      const { token, lib } = pick(library);
      checkWrite(token, path);
      const res = await lib.apply(request(note), [{ op: "edit", path, edits, if_match }]);
      return text(writeText("Edited", res, linksFor(token)));
    }),
  );

  server.registerTool(
    "grep",
    {
      title: "Search text",
      description:
        "Find lines matching a literal string (or a JavaScript regular expression with `regex: true`) across rendered pages, frontmatter included, like `grep -n`. Returns path:line: text.",
      inputSchema: {
        pattern: z.string(),
        regex: z.boolean().optional(),
        prefix: z.string().optional().describe("Only search under this directory."),
        limit: z.number().int().optional().describe("Maximum matches (default 100)."),
        ...libArg,
      },
      annotations: readOnly,
    },
    guarded(async ({ pattern, regex, prefix, limit, library }) => {
      const { lib } = pick(library);
      const r = await lib.grep(pattern, { regex, prefix, limit });
      const lines = r.matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
      if (lines.length === 0) lines.push("No matches.");
      if (r.truncated)
        lines.push(`(truncated at ${lines.length} matches; narrow with prefix or raise limit)`);
      return text(lines.join("\n"));
    }),
  );

  server.registerTool(
    "move",
    {
      title: "Move or rename",
      description:
        "Move or rename a file, or a whole directory when `from` is a directory prefix (one request, one ledger event per file; the result lists each file moved). Links keep working: they are stored by identity, not path, and render with the new path. Fails if a destination is taken.",
      inputSchema: {
        from: z.string(),
        to: z.string(),
        note: z.string().optional().describe("One line for the ledger."),
        ...libArg,
      },
      annotations: writes,
    },
    guarded(async ({ from, to, note, library }) => {
      const { token, lib } = pick(library);
      checkWrite(token, from, to);
      const res = await lib.apply(request(note), [{ op: "move", path: from, to }]);
      return text(writeText("Moved", res, linksFor(token)));
    }),
  );

  server.registerTool(
    "delete",
    {
      title: "Delete a file",
      description:
        "Delete a page or attachment. Requires `if_match` with its current hash. A page with open comment threads is not deleted (409 `open_comments`): resolve them first. History is kept: the ledger records the delete and it can be reverted. Links pointing here become broken and show up in the work queue.",
      inputSchema: {
        path: z.string(),
        if_match: z.string(),
        note: z.string().optional().describe("One line for the ledger."),
        ...libArg,
      },
      annotations: { ...writes, destructiveHint: true },
    },
    guarded(async ({ path, if_match, note, library }) => {
      const { token, lib } = pick(library);
      checkWrite(token, path);
      const res = await lib.apply(request(note), [{ op: "delete", path, if_match }]);
      return text(writeText("Deleted", res, linksFor(token)));
    }),
  );

  server.registerTool(
    "batch",
    {
      title: "Several changes as one",
      description:
        "Apply writes, edits, moves and deletes as one all-or-nothing request, like a commit: related changes land together in the ledger and one failure applies none (the error says which op, as `Op n of m`). Each op has its own path and, where needed, if_match.",
      inputSchema: {
        ops: z.array(BatchOpSchema).min(1),
        note: z.string().optional().describe("One line for the ledger, for the whole request."),
        ...libArg,
      },
      annotations: writes,
    },
    guarded(async ({ ops, note, library }) => {
      const { token, lib } = pick(library);
      const wire: WriteOp[] = ops.map((o) => {
        switch (o.op) {
          case "write":
            if (o.content === undefined)
              throw new StoreError(400, "bad_op", `write ${o.path}: needs content.`);
            return { op: "write", path: o.path, content: o.content, if_match: o.if_match };
          case "edit":
            if (!o.edits) throw new StoreError(400, "bad_op", `edit ${o.path}: needs edits.`);
            return { op: "edit", path: o.path, edits: o.edits, if_match: o.if_match };
          case "move":
            if (!o.to) throw new StoreError(400, "bad_op", `move ${o.path}: needs to.`);
            return { op: "move", path: o.path, to: o.to };
          default:
            return { op: "delete", path: o.path, if_match: o.if_match };
        }
      });
      checkWrite(token, ...ops.flatMap((o) => (o.to ? [o.path, o.to] : [o.path])));
      const res = await lib.apply(request(note), wire);
      return text(writeText("Applied", res, linksFor(token)));
    }),
  );

  server.registerTool(
    "attach",
    {
      title: "Add an attachment from the web",
      description:
        "Store a file from the public web at a path: the server fetches `source_url` (https only, no credentials in the URL, at most 3 redirects, 10 s, up to 10 MB; images, video, audio and PDF only, judged by the bytes), so nothing passes through you, and records the URL and fetch time as the file's source; a refused fetch is `fetch_refused` naming the rule. Put a figure beside the page that uses it, named for what it shows (`dir/x.md` uses `dir/x-architecture.png`), and link it by absolute path. Never hotlink a web image in a page; bring it in this way, and cite the original in the page's `sources` (the fetch records where it came from but is not a citation). A file that is not on the web (one you made, or one the person has) goes in with `prepare_upload`. Images (PNG, JPEG, GIF, WebP, AVIF, SVG) are checked on write: a broken or truncated one is refused with `bad_image`, and the type is taken from the bytes, not the extension. `description` says in a line what the file shows (up to 500 characters); `credit` (who made it) and `licence` (free text) a line each, up to 200 characters; they show on the file's page. Replacing needs `if_match`; the same bytes with a new description, credit or licence is a write too. Reading it back with `read` returns its facts, a short-lived download URL and, for an image, the image.",
      // Loose, so a call that still sends the removed `content_base64` reaches the handler and is
      // refused by name rather than having it silently dropped (TEMPRA-203).
      inputSchema: z.looseObject({
        path: z.string(),
        // Optional only so a call without it reaches the handler and is answered in words.
        source_url: z
          .string()
          .optional()
          .describe("A public https URL the server fetches the file from (required)."),
        description: z
          .string()
          .optional()
          .describe("What the file shows, in a line (at most 500 characters)."),
        credit: z
          .string()
          .optional()
          .describe("Who made it, as they should be credited (at most 200 characters)."),
        licence: z
          .string()
          .optional()
          .describe("Its licence, as free text, e.g. `CC BY-SA 4.0` (at most 200 characters)."),
        if_match: z.string().optional(),
        note: z.string().optional().describe("One line for the ledger."),
        ...libArg,
      }),
      annotations: writes,
    },
    guarded(async (args) => {
      const { path, source_url, description, credit, licence, if_match, note, library } = args;
      const { token, lib } = pick(library);
      checkWrite(token, path);
      if ("content_base64" in args) throw base64Removed();
      if (source_url === undefined) {
        throw new StoreError(
          400,
          "bad_attach",
          "Pass `source_url`, a public https URL the server fetches. A file that is not on the web goes in with `prepare_upload`.",
        );
      }
      const facts = checkFacts({ description, credit, licence });
      const clean = normalizePath(path) ?? path;
      if (!clean || clean.endsWith(".md")) {
        throw new StoreError(400, "bad_attachment", "Markdown files are pages, not attachments.");
      }
      const got = await fetchBlob(
        {
          fetch: ctx.fetch ?? ((u, i) => fetch(u, i)),
          blobs: ctx.blobs,
          selfHosts: selfHosts(ctx.origin),
        },
        source_url,
        clean,
      );
      ctx.meter?.({ kind: "fetch", library: token.library.id, bytes: got.bytes.byteLength });
      const res = await lib.apply(request(note), [
        { op: "attach", path, blob: got.blob, if_match, source: got.source, ...facts },
      ]);
      return text(
        [
          writeText("Stored", res, linksFor(token)),
          `Fetched ${got.bytes.byteLength} bytes from ${got.source.final_url ?? got.source.url} as ${got.blob.media ?? "unknown"}. Cite the original in the page's \`sources\` too.`,
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "prepare_upload",
    {
      title: "Upload a file",
      description:
        "The way to add a file that is not on the web, up to 10 MB: one you made (a screenshot, a processed image, a PDF) or one the person has (a photo they attached in the chat). Never type a file's bytes into a call, and for a chart, a flow or a drawing prefer rendered media in the page (a ```vega-lite, ```mermaid or ```svg fence) to a picture. Put it beside the page that uses it, named for what it shows (`dir/x-architecture.png`). Returns a URL good for one PUT within an hour, a ready `curl -T <file> '<url>'` line and an upload link for the person; in a chat that shows apps, an upload panel appears with the call. Then, by where the file is: (1) your shell reaches this server: run the curl line, and the server attaches the file at `path` as you, with your `note`; curl prints the write result as JSON (path, hash, seq, lint). (2) The person has it (you cannot pass on a chat's attachment): ask them to choose it in the panel, and give them the link in case the panel does not show. (3) You made it where you cannot reach this server (curl fails to connect, or a proxy refuses it, as in a chat's sandbox): give the file to the person in the chat, pass `origin` `agent`, and tell them in a sentence or two why they are asked: you cannot send files to Tempra yourself, so they upload the one you gave them (the panel and the link say the same). From their browser it is attached as your write, with your note, description, credit and licence, recorded as supplied by them; `read` the path to see when it has arrived. Whatever file arrives is the file; a transfer cut short is refused (`incomplete_upload`). The URL needs no token, so keep it to yourself; the link needs the person signed in with write access.",
      _meta: { ui: { resourceUri: UPLOAD_PANEL_URI } },
      inputSchema: {
        path: z
          .string()
          .describe(
            "Where the file goes, beside the page that uses it, e.g. `metrics/latency-p99.png`.",
          ),
        media: z.string().optional().describe("MIME type; guessed from the extension if omitted."),
        origin: z
          .enum(["person", "agent"])
          .optional()
          .describe(
            "Who has the file: `person` (default; e.g. one they attached in the chat) or `agent` (you made it, cannot send it from your sandbox, and have handed it to the person in the chat).",
          ),
        if_match: z.string().optional().describe("Replacing a file: its current hash."),
        description: z
          .string()
          .optional()
          .describe("What the file shows, in a line (at most 500 characters)."),
        credit: z
          .string()
          .optional()
          .describe("Who made it, as they should be credited (at most 200 characters)."),
        licence: z
          .string()
          .optional()
          .describe("Its licence, as free text, e.g. `CC BY-SA 4.0` (at most 200 characters)."),
        note: z.string().optional().describe("One line for the ledger."),
        ...libArg,
      },
      annotations: writes,
    },
    guarded(
      async ({ path, media, origin, if_match, description, credit, licence, note, library }) => {
        const picked = pick(library);
        checkWrite(picked.token, path);
        const clean = normalizePath(path);
        if (!clean || clean.endsWith(".md")) {
          throw new StoreError(
            400,
            "bad_path",
            "prepare_upload is for attachments: a file path that is not markdown (use `write` for pages).",
          );
        }
        const req = request(note);
        const facts = checkFacts({ description, credit, licence });
        const up = await prepareUpload(picked.lib, ctx.origin, {
          path: clean,
          media: media ?? mediaFor(clean),
          origin: origin ?? "person",
          if_match,
          ...facts,
          note: req.note ?? null,
          actor: req.actor,
          by: req.by,
          token: picked.token,
        });
        const result = text(
          [
            `Upload URL for ${clean} (one PUT, until ${up.expires}):`,
            up.url,
            "",
            "Run, from the directory holding the file (rename it to the file's real name if it differs):",
            up.curl,
            "",
            "curl prints the write result as JSON; read its lint. An error comes back as JSON with a code (incomplete_upload, media_mismatch, bad_image, upload_used); prepare again and resend.",
            ...(up.upload_page
              ? [
                  "",
                  "If your shell cannot reach this server, or the file is the person's (one they attached in the chat), give them this link to upload it from their browser, signed in; the same link, so it works once, until the same time:",
                  up.upload_page,
                ]
              : []),
            "",
            "In a chat that shows apps, an upload panel appears with this call: the person can choose the file there instead, and the chat is told when it has arrived. Say so, and give the link too in case the panel does not show.",
            ...(origin === "agent"
              ? [
                  "",
                  "You made this file: make sure the person has it in the chat, and tell them in a sentence or two why they are asked to upload it: you cannot send files to Tempra yourself (MCP has no way to pass a file to a server, and your sandbox cannot reach it), so they choose the file you gave them in the panel or the link. The panel and the link say the same.",
                ]
              : []),
          ].join("\n"),
        );
        // For the upload panel (TEMPRA-200): the host hands it the result, and keeps
        // structuredContent out of the model's context.
        result.structuredContent = {
          upload: {
            url: up.url,
            ...(up.upload_page ? { page: up.upload_page } : {}),
            path: clean,
            library: picked.token.library.slug,
            media: media ?? mediaFor(clean),
            ...(kindOf(media ?? mediaFor(clean)) ? { kind: kindOf(media ?? mediaFor(clean)) } : {}),
            origin: origin ?? "person",
            ...(facts.description ? { description: facts.description } : {}),
            expires: up.expires,
          },
        };
        return result;
      },
    ),
  );

  server.registerTool(
    "transform",
    {
      title: "Make a file from an attachment",
      description:
        "Change an attachment on the server, since you cannot fetch it to change it yourself: `resize` an image to a long edge (`edge`, never enlarged; fixes `image_large`), `crop` it to a `box` in its pixels, `convert` it to `format` (webp, png or jpeg), make a `thumbnail` (a long edge of `edge`, default 320), or make a video's `poster`, its frame at `time` seconds as a PNG beside it, which the reader shows before the video plays (WebM for now: the server cannot decode MP4's H.264 yet). The result is an ordinary write as you, its source recorded as made from the original at its hash. Where it goes: `to`, or by default resize and crop replace the image itself (pass `if_match`, its hash from `read`), convert writes `x.<format>`, thumbnail `x.thumb.<ext>`, poster `x.poster.png`, beside the original. The description, credit and licence carry over unless you give new ones. `read` the original with `image: true` first to see what to change.",
      inputSchema: {
        path: z.string().describe("The attachment to make from, e.g. `ops/latency.png`."),
        op: z.enum(["resize", "crop", "convert", "thumbnail", "poster"]),
        edge: z
          .number()
          .int()
          .min(16)
          .max(4000)
          .optional()
          .describe("resize, thumbnail: the long edge in pixels."),
        box: z
          .object({
            x: z.number().int().min(0),
            y: z.number().int().min(0),
            width: z.number().int().min(1),
            height: z.number().int().min(1),
          })
          .optional()
          .describe("crop: the box to keep, in the image's pixels from its top left."),
        format: z
          .enum(["webp", "png", "jpeg"])
          .optional()
          .describe("convert: the new format; others keep the original's (WebP when it has none)."),
        time: z.number().min(0).optional().describe("poster: seconds into the video (default 0)."),
        to: z.string().optional().describe("Where the new file goes, if not the default."),
        if_match: z.string().optional().describe("Replacing a file at `to`: its current hash."),
        description: z.string().optional(),
        credit: z.string().optional(),
        licence: z.string().optional(),
        note: z.string().optional().describe("One line for the ledger."),
        ...libArg,
      },
      annotations: writes,
    },
    guarded(async (args) => {
      const picked = pick(args.library);
      const from = normalizePath(args.path);
      if (!from || from.endsWith(".md")) {
        throw new StoreError(400, "bad_path", "`transform` works on attachments, not pages.");
      }
      const view = await picked.lib.read(from).catch(() => null);
      if (!view || view.kind !== "attachment") {
        throw new StoreError(404, "not_found", `No attachment at /${from}.`);
      }
      const media = (view.media ?? "").toLowerCase();
      const base = from.replace(/\.[^./]+$/, "");
      const ext = (f: string) => (f === "jpeg" ? "jpg" : f);
      const own = ({ "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" } as const)[
        media as "image/png"
      ];
      const format = args.format ?? own ?? "webp";
      const defaultTo = {
        resize: from,
        crop: from,
        convert: `${base}.${ext(format)}`,
        thumbnail: `${base}.thumb.${ext(format)}`,
        poster: `${base}.poster.png`,
      }[args.op];
      const to = normalizePath(args.to ?? defaultTo);
      if (!to || to.endsWith(".md")) {
        throw new StoreError(400, "bad_path", "`to` is an attachment path, not a page.");
      }
      checkWrite(picked.token, to);
      // A replacement in place needs the hash, as any replace does.
      if (to === from && args.if_match === undefined) {
        throw new StoreError(
          400,
          "if_match_required",
          `This replaces /${from}; pass \`if_match\` (its hash, ${view.hash}) or a \`to\` path.`,
        );
      }
      let made: { bytes: Uint8Array; media: string };
      let op: string;
      if (args.op === "poster") {
        if (!media.startsWith("video/")) {
          throw new StoreError(
            400,
            "not_a_video",
            `/${from} is ${media || "not a video"}; a poster is made from a video.`,
          );
        }
        if (ctx.allowRender && !(await ctx.allowRender())) {
          throw new StoreError(
            429,
            "rate_limited",
            `Over ${RENDERS_PER_MINUTE} renders a minute for this account; try again in a minute.`,
          );
        }
        const time = args.time ?? 0;
        const url = await downloadUrl(picked, {
          k: "file",
          path: view.path,
          hash: view.hash,
          media: view.media,
        });
        const r = ctx.poster
          ? await ctx.poster({ url, time }, picked.token.library.id)
          : { error: RENDER_UNAVAILABLE };
        if ("error" in r) {
          // The render Worker's browser has no H.264 decoder (seen on a preview, 2026-10-27).
          const why =
            media === "video/mp4" && r.error.includes("decoded")
              ? `${r.error} (the server's browser cannot decode MP4's H.264 yet; a WebM poster works, or upload a poster image beside the video as ${base}.poster.png)`
              : r.error;
          throw new StoreError(502, "transform_failed", `No poster for /${from}: ${why}.`);
        }
        made = { bytes: r.png, media: "image/png" };
        op = `poster ${time}s`;
      } else {
        if (!["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(media)) {
          throw new StoreError(
            400,
            "not_an_image",
            `/${from} is ${media || "of no known type"}; resize, crop, convert and thumbnail take PNG, JPEG, GIF, WebP or AVIF.`,
          );
        }
        let t: ImageTransform;
        if (args.op === "resize" || args.op === "thumbnail") {
          const edge = args.edge ?? (args.op === "thumbnail" ? 320 : undefined);
          if (edge === undefined)
            throw new StoreError(400, "bad_request", "`resize` needs `edge`.");
          t = { width: edge, height: edge, fit: "scale-down" };
          op = `${args.op} ${edge}`;
        } else if (args.op === "crop") {
          const b = args.box;
          if (!b) throw new StoreError(400, "bad_request", "`crop` needs `box`.");
          const sized = await withDimensions(picked.lib, ctx.blobs, view);
          const w = sized.kind === "attachment" ? sized.width : null;
          const h = sized.kind === "attachment" ? sized.height : null;
          if (w && h && (b.x + b.width > w || b.y + b.height > h)) {
            throw new StoreError(
              400,
              "bad_request",
              `The box runs past the image, which is ${w}×${h}.`,
            );
          }
          t = { trim: { top: b.y, left: b.x, width: b.width, height: b.height } };
          op = `crop ${b.x},${b.y} ${b.width}x${b.height}`;
        } else {
          t = {};
          op = `convert ${format}`;
        }
        const obj = await ctx.blobs.get(view.hash);
        if (!obj) throw new StoreError(500, "blob_missing", `Bytes for /${from} are missing.`);
        const out = await images.transform(await readBytes(obj.body), t, format).catch((e) => {
          throw new StoreError(
            502,
            "transform_failed",
            `Images could not ${args.op} /${from}: ${e instanceof Error ? e.message : String(e)}.`,
          );
        });
        if (!out) {
          throw new StoreError(
            503,
            "transform_unavailable",
            "Image transforms are not available on this deployment.",
          );
        }
        made = out;
      }
      const blob = await putBlob(ctx.blobs, made.bytes, made.media, to);
      // What the original says of itself carries over unless new words are given.
      const facts = checkFacts({
        description: args.description ?? view.description ?? undefined,
        credit: args.credit ?? view.credit ?? undefined,
        licence: args.licence ?? view.licence ?? undefined,
      });
      const res = await picked.lib.apply(request(args.note), [
        {
          op: "attach",
          path: to,
          blob,
          if_match: args.if_match,
          made_from: { path: from, hash: view.hash, op },
          ...facts,
        },
      ]);
      const dims = blob.width && blob.height ? `${blob.width}×${blob.height}, ` : "";
      return text(
        [
          writeText("Stored", res, linksFor(picked.token)),
          `Made /${to} from /${from} (${op}): ${dims}${sizeText(blob.size)}, ${blob.media ?? made.media}.`,
        ].join("\n"),
      );
    }),
  );

  // ------------------------------------------------------------------ tier 2: beyond files

  if (tier2) {
    server.registerTool(
      "render",
      {
        title: "Draw a diagram",
        description: `${BEYOND}draw rendered media as the app draws it and see it: a Mermaid diagram (Pele, the reader's column and greys), an SVG fence (sanitized as the reader sanitizes it) or a Vega-Lite chart (Vega, its data inline or from this library). Preview a non-trivial one before you write it (layout, labels that fit), or look at one while you review it or fix its \`diagram_invalid\`, \`diagram_unrendered\`, \`svg_invalid\` or \`chart_invalid\` lint: pass \`source\` (a fence's body, or the whole fence with its header; the language from \`lang\`, the fence, or the source itself: \`<svg\` is SVG, a JSON object Vega-Lite), or \`path\` and \`figure\` (its number in \`read\`'s Figures list). A \`source\` is checked as a write would check it, with the same sanitizing and data rules (only data inline or in this library), and what a write would report comes back with the drawing (\`svg_unsafe\` naming what is taken out, \`chart_invalid\`, \`svg_invalid\`, and \`image_no_alt\` when you pass the whole fence); one a write would call invalid is not drawn. Returns a line with what it is and its size, then the drawing as a PNG image; if it cannot be drawn, the error with line and column, and the line it names; if the PNG cannot be made, the SVG as text. Writes nothing and records nothing in the ledger. At most ${RENDERS_PER_MINUTE} renders a minute per account.`,
        inputSchema: {
          source: z
            .string()
            .optional()
            .describe(
              "The figure's source: what goes inside a ```mermaid (or ```svg, ```vega-lite) fence.",
            ),
          path: z
            .string()
            .optional()
            .describe("A page holding the diagram, with `figure`, instead of `source`."),
          figure: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("The diagram's figure number in that page, as `read` lists it."),
          lang: z
            .enum(RENDER_LANGS)
            .optional()
            .describe(
              "With `source`: the fence's language, `mermaid`, `svg` or `vega-lite`. Left out, it is told from the source: `<svg …>` is SVG, a JSON object is Vega-Lite, anything else Mermaid.",
            ),
          theme: z
            .enum(["light", "dark"])
            .optional()
            .describe("The app's light (default) or dark theme."),
          ...libArg,
        },
        annotations: readOnly,
      },
      guarded(
        async (args: {
          source?: string;
          path?: string;
          figure?: number;
          lang?: RenderLang;
          theme?: "light" | "dark";
          library?: string;
        }) => {
          let source: string;
          let lang: RenderLang = args.lang ?? "mermaid";
          let what: string;
          let library: string | undefined;
          // A pasted fence's header (its alt and title), for what a write would lint (TEMPRA-213).
          let meta: string | null = null;
          // Where a chart's data paths resolve (TEMPRA-207): its page, or the library's root.
          let from: { lib: LibraryClient; path: string } | undefined;
          if (args.source !== undefined) {
            if (args.path !== undefined || args.figure !== undefined) {
              throw new StoreError(
                400,
                "bad_request",
                "Pass `source`, or `path` and `figure`, not both.",
              );
            }
            // A whole fence pasted in is drawn as its body, in its language.
            const fence =
              /^\s*(`{3,}|~{3,})\s*(mermaid|svg|vega-lite)\b([^\n]*)\n([\s\S]*?)\n?\s*\1\s*$/i.exec(
                args.source,
              );
            source = fence?.[4] ?? args.source;
            if (fence) {
              lang = (fence[2] as string).toLowerCase() as RenderLang;
              meta = (fence[3] as string).trim();
            } else if (args.lang === undefined) lang = sourceLang(source);
            what = "Diagram";
            if (args.library || ctx.libraries.length === 1) {
              const picked = pick(args.library);
              library = picked.token.library.id;
              from = { lib: picked.lib, path: "" };
            }
          } else {
            if (args.path === undefined || args.figure === undefined) {
              throw new StoreError(
                400,
                "bad_request",
                "Pass `source` (the fence's Mermaid, SVG or Vega-Lite), or `path` and `figure`.",
              );
            }
            const picked = pick(args.library);
            library = picked.token.library.id;
            const view = await picked.lib.read(args.path, { figures: true });
            if (view.kind !== "page") {
              throw new StoreError(400, "not_a_page", `${args.path} is not a page.`);
            }
            const figures = view.figures ?? [];
            const f = figures[args.figure - 1];
            if (!f) {
              throw new StoreError(
                404,
                "no_figure",
                `${view.path} has no figure ${args.figure} (it has ${figures.length}).`,
              );
            }
            if (f.kind !== "diagram") {
              throw new StoreError(
                400,
                "not_a_diagram",
                `Figure ${f.n} of ${view.path} is an image, not a diagram; \`read\` it with figures: [${f.n}].`,
              );
            }
            if (!isRenderLang(f.lang)) {
              throw new StoreError(
                400,
                "not_a_diagram",
                `Figure ${f.n} of ${view.path} is a ${f.lang} fence, which the server does not draw.`,
              );
            }
            lang = f.lang;
            source = f.source;
            from = { lib: picked.lib, path: view.path };
            what = `Figure ${f.n} of /${view.path}${f.title ? ` (${JSON.stringify(f.title)})` : ""}`;
          }
          if (source.trim() === "") {
            throw new StoreError(400, "bad_request", "The diagram's source is empty.");
          }
          const theme = args.theme ?? "light";
          const type = lang === "mermaid" ? diagramTypeOf(source) : null;
          const head = `${what} · ${lang}${type ? `, ${type}` : ""} · ${theme}`;
          // A source not yet written gets the lint its write would (TEMPRA-213); one a write would
          // call invalid is not sent to be drawn. A figure's lint is already on its page.
          const findings = args.source !== undefined ? previewLint(lang, source, meta) : [];
          const said = findings.length
            ? `\nA write would report:\n${findings.map((l) => `- ${l.code}: ${l.message}`).join("\n")}`
            : "";
          if (findings.some((l) => l.code === "svg_invalid" || l.code === "chart_invalid")) {
            return text(`${head}\nNot drawn.${said}`);
          }
          const drawn = await draw(source, theme, library, lang, from);
          if (drawn.kind === "unavailable") {
            return { ...text(`${head}\nNot drawn: ${drawn.why}.${said}`), isError: true };
          }
          if (drawn.kind === "refused") {
            return text(
              `${head}\n${drawerOf(lang)} could not draw it: ${renderErrorText(drawn.error, source)}\nFix the source and render it again; the app shows a figure that does not draw as its source.${said}`,
            );
          }
          if (drawn.kind === "svg") {
            const size = new TextEncoder().encode(drawn.svg).byteLength;
            return text(
              size > SVG_TEXT_BYTES
                ? `${head}\nDrawn, but the PNG could not be made (${drawn.why}) and the SVG is ${sizeText(size)}, over ${sizeText(SVG_TEXT_BYTES)}; it draws, so the source is valid.${said}`
                : `${head}\nDrawn, but the PNG could not be made (${drawn.why}); the SVG follows as text (${sizeText(size)}).${said}\n${drawn.svg}`,
            );
          }
          ctx.meter?.({
            kind: "read_image",
            library: library ?? "",
            bytes: drawn.bytes.byteLength,
          });
          return {
            content: [
              line(
                `${head} · ${drawn.width > 0 ? `${drawn.width}×${drawn.height} px` : "drawn"}${said}`,
              ),
              { type: "image", data: toBase64(drawn.bytes), mimeType: drawn.media },
            ],
          };
        },
      ),
    );

    server.registerTool(
      "search",
      {
        title: "Ranked search",
        description: `${BEYOND}ranked full-text search over titles, bodies and tags, with snippets. Any of the words matches, and pages with more of them, rarer ones or ones in the title rank first (BM25); words are stemmed, so comments finds comment. Use it to find pages by meaning words when you do not know the path; use grep for exact strings.`,
        inputSchema: {
          q: z
            .string()
            .describe(
              'Words to search for, any of which may match; "a quoted phrase" must match as a phrase, and a trailing * matches a prefix.',
            ),
          prefix: z.string().optional(),
          limit: z.number().int().optional(),
          ...libArg,
        },
        annotations: readOnly,
      },
      guarded(async ({ q, prefix, limit, library }) => {
        const { token, lib } = pick(library);
        const r = await lib.search(q, { prefix, limit });
        if (r.results.length === 0) return text("No results.");
        const links = linksFor(token);
        return text(
          r.results
            .map(
              (x) =>
                `${x.path} — ${x.title}\n  ${links.page(x.path)}\n  ${x.snippet.replace(/\s+/g, " ").trim()}`,
            )
            .join("\n"),
        );
      }),
    );

    server.registerTool(
      "query",
      {
        title: "Filter by frontmatter",
        description: `${BEYOND}list pages by frontmatter: tag, status, trust tier, staleness, directory. Faster and exact where grep over YAML is not. Find hot or cold pages by their reads over 30 days (each reader once a day): \`sort: "reads"\` (most read first), \`min_reads\`, \`max_reads\` (\`max_reads: 0\` for pages nobody read).`,
        inputSchema: {
          type: z
            .string()
            .optional()
            .describe(
              "Not a filter: pages have no special `type`. Use `tag`, `prefix` or `search` instead.",
            ),
          tag: z.string().optional(),
          status: z.enum(["draft", "stable", "deprecated"]).optional(),
          trust: z.enum(["unverified", "machine-confirmed", "human-reviewed"]).optional(),
          stale: z.boolean().optional(),
          prefix: z.string().optional(),
          sort: z
            .enum(["path", "reads"])
            .optional()
            .describe("`reads`: most read over 30 days first. Default: by path."),
          min_reads: z.number().int().optional().describe("At least this many reads in 30 days."),
          max_reads: z.number().int().optional().describe("At most this many reads in 30 days."),
          limit: z.number().int().optional(),
          offset: z.number().int().optional(),
          ...libArg,
        },
        annotations: readOnly,
      },
      guarded(async ({ library, type, ...args }) => {
        if (type !== undefined) {
          throw new StoreError(
            400,
            "bad_param",
            "`type` is not a filter: pages have no special type. Filter by `tag` or `prefix`, or `search` for words.",
          );
        }
        const { token, lib } = pick(library);
        const r = await lib.pages(args);
        const lines = r.items.map(
          (c) =>
            `${c.path} · ${c.status}${c.status_set === false ? " (not set)" : ""} · ${c.trust_tier}${c.stale ? " · STALE" : ""}${"reads" in c ? ` · ${c.reads} read${c.reads === 1 ? "" : "s"} in 30 days` : ""} — ${c.title ?? ""}${c.description ? `: ${c.description}` : ""}`,
        );
        lines.unshift(
          `${r.total} matching page${r.total === 1 ? "" : "s"}${r.next_offset !== null ? ` (next offset ${r.next_offset})` : ""} (each opens in the app at its path under ${linksFor(token).library}):`,
        );
        return text(lines.join("\n"));
      }),
    );

    server.registerTool(
      "links",
      {
        title: "Links and backlinks",
        description: `${BEYOND}a page's outbound links (with current target paths), inbound links (backlinks), and broken links. \`kind\` is \`body\` for a markdown link or \`source\` for a \`sources[].resource\` inside the library.`,
        inputSchema: { path: z.string(), ...libArg },
        annotations: readOnly,
      },
      guarded(async ({ path, library }) => text(json(await pick(library).lib.links(path)))),
    );

    server.registerTool(
      "sources",
      {
        title: "Sources and citations",
        description: `${BEYOND}a page's sources with how often the body cites each (\`cited\`: every [^id] reference), footnotes with no matching source, and for sources inside the library their current path, trust tier and staleness (\`broken: true\` when the path does not exist).`,
        inputSchema: { path: z.string(), ...libArg },
        annotations: readOnly,
      },
      guarded(async ({ path, library }) => text(json(await pick(library).lib.sources(path)))),
    );

    server.registerTool(
      "log",
      {
        title: "What changed",
        description: `${BEYOND}recent requests newest first: who (actor), when, their note, and the files each touched. Use it to see what other agents and humans did before you start, and to page back past what log.md shows (its latest 200 requests).`,
        inputSchema: {
          prefix: z.string().optional(),
          since: z.number().int().optional().describe("Only requests after this sequence number."),
          before: z
            .number()
            .int()
            .optional()
            .describe("Only requests before this sequence number: the cursor for older pages."),
          limit: z.number().int().optional(),
          ...libArg,
        },
        annotations: readOnly,
      },
      guarded(async ({ prefix, since, before, limit, library }) => {
        const r = await pick(library).lib.requests({ prefix, since, before, limit });
        if (r.requests.length === 0) return text("No changes.");
        const out = r.requests.map((q) => {
          const seqs = q.events.map((e) => e.seq);
          const head = `seq ${Math.min(...seqs)}–${Math.max(...seqs)} · ${q.ts} · ${q.actor}${q.note ? ` · ${q.note}` : ""} · request ${q.request_id}`;
          const evs = q.events
            .slice(0, 20)
            .map(
              (e) => `  ${e.op} ${e.path}${e.meta?.from_path ? ` (from ${e.meta.from_path})` : ""}`,
            );
          if (q.events.length > 20) evs.push(`  … and ${q.events.length - 20} more`);
          return [head, ...evs].join("\n");
        });
        if (r.next) out.push(`(older: pass before=${r.next}, or narrow with prefix)`);
        return text(out.join("\n"));
      }),
    );

    server.registerTool(
      "history",
      {
        title: "A file's history",
        description: `${BEYOND}every ledger event for a page across moves: sequence, time, actor, op and hash. Read an old version with read(path, at).`,
        inputSchema: { path: z.string(), ...libArg },
        annotations: readOnly,
      },
      guarded(async ({ path, library }) => {
        const h = await pick(library).lib.history(path);
        const lines = h.events.map(
          (e) =>
            `seq ${e.seq} · ${e.ts} · ${e.actor} · ${e.op} ${e.path}${e.hash ? ` · ${e.hash.slice(0, 12)}` : ""}${e.meta?.note ? ` · ${e.meta.note}` : ""}`,
        );
        return text([`History of ${h.path}:`, ...lines].join("\n"));
      }),
    );

    server.registerTool(
      "diff",
      {
        title: "Compare versions",
        description: `${BEYOND}unified diff of a page between two sequence numbers. Omit both to see its latest change; omit \`to\` for head. In a chat that shows apps, the person sees it drawn in a panel.`,
        _meta: { ui: { resourceUri: CHANGES_PANEL_URI } },
        inputSchema: {
          path: z.string(),
          from: z.number().int().optional(),
          to: z.number().int().optional(),
          ...libArg,
        },
        annotations: readOnly,
      },
      guarded(async ({ path, from, to, library }) => {
        const { token, lib } = pick(library);
        const d = await lib.diff(path, { from, to });
        const result = text(
          d.diff || `No difference in ${d.path} between seq ${d.from} and ${d.to}.`,
        );
        // The changes panel's data (TEMPRA-291): the host hands it to the panel.
        result.structuredContent = {
          changes: {
            v: 1,
            library: { owner: token.library.owner, slug: token.library.slug },
            path: d.path,
            from: d.from,
            to: d.to,
            patch: d.diff,
          },
        };
        return result;
      }),
    );

    server.registerTool(
      "revert",
      {
        title: "Undo",
        description: `${BEYOND}undo safely, forward-only: revert one path to its state at \`to_seq\`, or a whole request by \`request_id\` (from log). Adds new ledger events; nothing is erased. Only for the library's owner and their agents (403 \`owner_only\` in a library shared with you).`,
        inputSchema: {
          path: z.string().optional(),
          to_seq: z.number().int().optional(),
          request_id: z.string().optional(),
          note: z.string().optional().describe("One line for the ledger: why."),
          ...libArg,
        },
        annotations: { ...writes, destructiveHint: true },
      },
      guarded(async ({ path, to_seq, request_id, note, library }) => {
        const { token, lib } = pick(library);
        // The owner's recovery tool (TEMPRA-124), as REST's revert: the owner's agents alone.
        requireOwner(token.role, "revert changes");
        if (request_id) {
          if (token.prefix !== null) {
            throw new StoreError(
              403,
              "outside_prefix",
              "Prefix-scoped tokens revert one path at a time.",
            );
          }
          checkWrite(token);
          return text(
            writeText("Reverted", await lib.revert(request(note), { request_id }), linksFor(token)),
          );
        }
        if (!path || to_seq === undefined) {
          throw new StoreError(400, "bad_revert", "Pass path and to_seq, or request_id.");
        }
        checkWrite(token, path);
        return text(
          writeText("Reverted", await lib.revert(request(note), { path, to_seq }), linksFor(token)),
        );
      }),
    );

    server.registerTool(
      "work",
      {
        title: "Maintenance queue",
        description: `${BEYOND}what needs doing in this library: open comment threads (requests from people; a thread with no path is on the library itself), requests (\`request\`: threads marked as a bigger ask, left for people's agents to do, then reply and resolve), stale pages (past stale_after), broken links (body links and \`sources\` resources in this library that point nowhere; checked on every write and again daily, so a move or delete elsewhere shows here), lint (dangling footnotes included), hotlinked images (\`external_image\`, one item per page: \`attach\` each with \`source_url\`, \`edit\` the image to the attached path, cite the original in \`sources\`), and structure (what makes a directory's index.md poor: descriptions missing, too long or repeating the title, duplicate titles, pages nothing links to, directories with one page, none or too many; reported on the page or on the directory's index.md, and never fixed for you), ranked by how many pages link in. Each item has a suggested action; fix it through the normal write tools, and answer comments with \`comment\`. \`kind: "stale_soon"\` looks ahead instead: pages within 14 days of stale_after, to refresh before they go stale; only moving stale_after resets the clock.`,
        inputSchema: {
          kind: z
            .enum([
              "comment",
              "request",
              "stale",
              "stale_soon",
              "broken_link",
              "lint",
              "external_image",
              "structure",
            ])
            .optional(),
          limit: z.number().int().optional(),
          ...libArg,
        },
        annotations: readOnly,
      },
      guarded(async ({ kind, limit, library }) => {
        const w = await pick(library).lib.work({ kind, limit });
        if (w.items.length === 0) return text("Nothing to do.");
        const lines = w.items.map(
          (i) =>
            `[${i.kind}] ${i.path || "(the library)"} (since ${i.since}, ${i.inbound_links} inbound)${i.thread ? ` · thread ${i.thread}` : ""}\n  ${i.detail}\n  → ${i.suggested_action}`,
        );
        return text([`${w.total} open item${w.total === 1 ? "" : "s"}:`, ...lines].join("\n"));
      }),
    );

    server.registerTool(
      "comments",
      {
        title: "Read comment threads",
        description: `${BEYOND}comment threads: requests and questions people (and agents) left on pages or on the library itself, each with the quoted text it is about, every reply, its kind (comment, or request: a bigger ask left for people's agents) and its thread id. Pass \`path\` for one page's threads (read them before editing it), an empty \`path\` for the threads on the library itself (on no page), or omit it for all of them. \`status\` is open (default), resolved or all. An outdated thread's quote is no longer in the body.`,
        inputSchema: {
          path: z
            .string()
            .optional()
            .describe("A page, e.g. `metrics/margin.md`; empty for the library's own threads."),
          status: z.enum(["open", "resolved", "all"]).optional(),
          limit: z.number().int().optional().describe("Threads per page (default 50)."),
          before: z.number().int().optional().describe("The `next` cursor from the previous page."),
          ...libArg,
        },
        annotations: readOnly,
      },
      guarded(async ({ path, status, limit, before, library }) => {
        const r = await pick(library).lib.comments({ path, status, limit, before });
        if (r.threads.length === 0) {
          return text(`No ${status === "all" ? "" : `${status ?? "open"} `}comment threads.`);
        }
        // Agents named for whom they act, as the app names them; the actor where unknown.
        const ids = r.threads.flatMap((t) => t.actions.flatMap((a) => a.by?.agent ?? []));
        const names =
          ctx.agentNames && ids.length > 0
            ? await ctx.agentNames(ids).catch(() => new Map<string, string>())
            : new Map<string, string>();
        const out = r.threads.map((t) => {
          const head = `## Thread ${t.id} · ${t.path || "the library"} · ${t.kind === "request" ? "request · " : ""}${t.status}${t.outdated ? " · outdated (the quote is no longer in the body)" : ""}`;
          const quote = t.anchor ? [`> ${t.anchor.quote.replace(/\n/g, "\n> ")}`] : [];
          // Every action in order: who said what, and when it was resolved and reopened.
          const bodies = new Map(t.comments.map((c) => [c.id, c.body]));
          const mentions = new Map(t.comments.map((c) => [c.id, c.mentions]));
          const said = t.actions.map((a) => {
            const body = a.comment ? bodies.get(a.comment) : undefined;
            const verb =
              a.kind === "resolve" ? " resolved it" : a.kind === "reopen" ? " reopened it" : "";
            const text = body ? `\n  ${body.replace(/\n/g, "\n  ")}` : "";
            const named = a.comment ? mentions.get(a.comment) : undefined;
            const to = named ? ` (mentioned ${named.join(", ")})` : "";
            const who = (a.by?.agent && names.get(a.by.agent)) ?? a.actor;
            return `- ${who}${verb} at ${a.ts}${to}${text ? ":" : "."}${text}`;
          });
          return [head, ...quote, ...said].join("\n");
        });
        if (r.next) out.push(`More: pass before=${r.next}.`);
        return text(out.join("\n\n"));
      }),
    );

    server.registerTool(
      "comment",
      {
        title: "Comment, reply or resolve",
        description: `${BEYOND}answer a comment thread or start one. \`reply\` adds to a thread; \`resolve\` closes it (with an optional closing reply, e.g. what you changed); \`reopen\` opens it again; \`open\` starts a thread on a page, optionally on a \`quote\` copied from its body as \`read\` shows it (matched by the text it reads as, markup aside; it must occur once; quote more of the sentence if it repeats), or with no \`path\` on the library itself. \`kind: "request"\` with \`open\` or \`reply\` marks the thread a request, a bigger ask left open for people's agents (\`work\` lists it as a \`request\`); \`kind: "comment"\` makes it a plain thread again. Resolve only what you actually addressed. Write \`@handle\` in a body to address someone who can reach the library: it reaches their inbox. Comments never change the page; edit it with the write tools.`,
        inputSchema: {
          action: z.enum(["reply", "resolve", "reopen", "open"]),
          thread: z.string().optional().describe("reply, resolve, reopen: the thread id."),
          path: z
            .string()
            .optional()
            .describe("open: the page to comment on; omit it for a thread on the library."),
          kind: z
            .enum(["comment", "request"])
            .optional()
            .describe("open, reply: mark the thread a request (or a comment again)."),
          quote: z
            .string()
            .optional()
            .describe(
              "open: text copied from the body, as `read` shows it, to anchor the comment on.",
            ),
          body: z
            .string()
            .optional()
            .describe("The comment (needed for reply and open; optional for resolve and reopen)."),
          ...libArg,
        },
        annotations: writes,
      },
      guarded(async ({ action, thread, path, quote, body, kind, library }) => {
        const { token, lib } = pick(library);
        const on = (p: string) => p || "the library";
        if (action === "open") {
          checkComment(token, path ?? "");
          const r = await post(token, lib, {
            kind: "open",
            path: path ?? "",
            body: body ?? "",
            anchor: quote ? { quote } : null,
            ...(kind ? { thread_kind: kind } : {}),
          });
          return text(
            `Opened ${r.thread.kind === "request" ? "request" : "thread"} ${r.thread.id} on ${on(r.thread.path)} (seq ${r.seq}).`,
          );
        }
        if (!thread)
          throw new StoreError(400, "bad_request", `\`${action}\` needs the \`thread\` id.`);
        if (kind && action !== "reply") {
          throw new StoreError(400, "bad_request", "`kind` goes with `open` or `reply`.");
        }
        const t = await lib.thread(thread);
        checkComment(token, t.path);
        const r = await post(
          token,
          lib,
          action === "reply"
            ? { kind: "reply", thread, body: body ?? "", ...(kind ? { thread_kind: kind } : {}) }
            : { kind: action, thread, body: body ?? "" },
        );
        const verb = { reply: "Replied to", resolve: "Resolved", reopen: "Reopened" }[action];
        return text(
          `${verb} ${r.thread.kind === "request" ? "request" : "thread"} ${thread} on ${on(r.thread.path)} (seq ${r.seq}); it is ${r.thread.status}.`,
        );
      }),
    );

    server.registerTool(
      "export",
      {
        title: "Export the library",
        description: `${BEYOND}a short-lived download URL (15 minutes) for the whole library as a tar: every page and attachment as a file, each Mermaid, SVG and Vega-Lite figure drawn beside its page as \`<page>.diagrams/<n>.svg\` (n its figure number; derived, so import ignores them). \`format: "okf"\` makes it a bundle that conforms to Google's Open Knowledge Format instead: each directory's index.md and log.md materialized, and \`type: Page\` on a page with no \`type\`. \`at\` exports an earlier sequence.`,
        inputSchema: {
          at: z.number().int().optional(),
          format: z.enum(EXPORT_FORMATS).optional(),
          ...libArg,
        },
        annotations: readOnly,
      },
      guarded(async ({ at, format, library }) => {
        const picked = pick(library);
        const seq = at ?? (await picked.lib.headSeq());
        const payload = { k: "export" as const, at: seq, ...(format === "okf" ? { format } : {}) };
        return text(
          `${format === "okf" ? "OKF bundle" : "Export"} at seq ${seq} (valid 15 minutes): ${await downloadUrl(picked, payload)}`,
        );
      }),
    );

    if (ctx.actor.startsWith("process:")) {
      server.registerTool(
        "verify",
        {
          title: "Record a verification",
          description: `${BEYOND}record that this process re-checked the page against its sources and resource: adds { by: ${ctx.actor}, at: now } to \`verified\`. The content is unchanged. Only call it after an actual check.`,
          inputSchema: { path: z.string(), ...libArg },
          annotations: writes,
        },
        guarded(async ({ path, library }) => {
          const { token, lib } = pick(library);
          checkWrite(token, path);
          return text(writeText("Verified", await lib.verify(request(), path), linksFor(token)));
        }),
      );
    }
  }

  // ------------------------------------------------------------------ resources

  server.registerResource(
    "upload_panel",
    UPLOAD_PANEL_URI,
    {
      title: "Upload a file",
      description:
        "The panel prepare_upload shows in the chat: the person chooses the file and their browser sends it.",
      mimeType: MCP_APP_MIME,
      _meta: panelMeta(ctx.origin),
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MCP_APP_MIME,
          text: uploadPanel,
          _meta: panelMeta(ctx.origin),
        },
      ],
    }),
  );

  server.registerResource(
    "page_panel",
    PAGE_PANEL_URI,
    {
      title: "Show a page",
      description: "The panel `show` draws in the chat: one page as the app shows it, to read.",
      mimeType: MCP_APP_MIME,
      _meta: pagePanelMeta(ctx.origin),
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MCP_APP_MIME,
          text: pagePanelHtml(ctx.origin),
          _meta: pagePanelMeta(ctx.origin),
        },
      ],
    }),
  );

  server.registerResource(
    "changes_panel",
    CHANGES_PANEL_URI,
    {
      title: "Changes to a page",
      description: "The panel `diff` draws in the chat: a page's Markdown between two versions.",
      mimeType: MCP_APP_MIME,
      _meta: changesPanelMeta,
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: MCP_APP_MIME, text: changesPanel, _meta: changesPanelMeta },
      ],
    }),
  );

  server.registerResource(
    "page",
    new ResourceTemplate(`${URI_SCHEME}://{owner}/{library}/{+path}`, {
      list: async () => {
        const resources = [];
        for (const token of ctx.libraries) {
          if (resources.length >= 1000) break;
          const tree = await ctx.open(token).tree();
          for (const e of tree.entries) {
            if (e.kind === "dir") continue;
            if (resources.length >= 1000) break;
            resources.push({
              uri: `${URI_SCHEME}://${token.library.owner}/${token.library.slug}/${e.path}`,
              name: e.path,
              title: "title" in e && e.title ? e.title : undefined,
              description: "description" in e && e.description ? e.description : undefined,
              mimeType:
                e.kind === "page" ? "text/markdown" : ("media" in e && e.media) || undefined,
            });
          }
        }
        return { resources };
      },
    }),
    {
      title: "Library files",
      description:
        "Pages in your libraries as markdown, and attachments as their bytes (images scaled for the model), addressable by owner, library and path.",
      mimeType: "text/markdown",
    },
    async (uri, vars) => {
      const one = (v: string | string[] | undefined) =>
        Array.isArray(v) ? v.join("/") : (v ?? "");
      const picked = pick(`${one(vars.owner)}/${one(vars.library)}`);
      const view = await picked.lib.read(decodeURIComponent(one(vars.path)));
      if (view.kind === "attachment") {
        const url = await downloadUrl(picked, {
          k: "file",
          path: view.path,
          hash: view.hash,
          media: view.media,
        });
        const link = {
          contents: [
            { uri: uri.href, mimeType: "text/plain", text: `Attachment; download: ${url}` },
          ],
        };
        // The bytes themselves (TEMPRA-155): images scaled for the model, other files up to a cap.
        if (view.media && RASTER_MEDIA.has(view.media)) {
          const img = await images.forModel(view);
          if (!("bytes" in img)) return link;
          ctx.meter?.({
            kind: "read_image",
            library: picked.token.library.id,
            bytes: img.bytes.byteLength,
          });
          return { contents: [{ uri: uri.href, mimeType: img.media, blob: toBase64(img.bytes) }] };
        }
        if (view.size > RESOURCE_BYTES) return link;
        const obj = await ctx.blobs.get(view.hash);
        if (!obj) return link;
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: view.media ?? "application/octet-stream",
              blob: toBase64(await readBytes(obj.body)),
            },
          ],
        };
      }
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: view.markdown }] };
    },
  );

  return server;
}

/** Serves one MCP request statelessly: a fresh server and transport per HTTP request. */
export async function handleMcp(req: Request, ctx: McpContext): Promise<Response> {
  const server = buildServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}
