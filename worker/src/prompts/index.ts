/**
 * Tempra's prompts (TEMPRA-314), as markdown files beside this loader, bundled at build time (a
 * Wrangler `Text` rule; bun reads them through the import attribute, without which it renders a
 * `.md` import to HTML): `mcp/`, what the MCP server sends every agent (its instructions and each
 * tool's description), and `managed/`, the managed agent's (its system prompt, a turn's first
 * message, the note that sends a long reply back). Free of Worker APIs.
 *
 * A file is what the model is sent, except that
 * - the newline an editor ends it with is dropped;
 * - HTML comments (`<!-- … -->`, on one line) are notes for whoever edits it, never sent: one that
 *   fills a line goes with its line;
 * - `{{NAME}}` is a placeholder the code fills through `render`;
 * - `<!-- section: name -->…<!-- /section -->` marks a part another prompt quotes by name
 *   (`instructionsSection`), so it quotes it whatever its wording or place.
 */

import shortenMd from "./managed/shorten.md" with { type: "text" };
import systemMd from "./managed/system.md" with { type: "text" };
import turnMd from "./managed/turn.md" with { type: "text" };
import instructionsMd from "./mcp/instructions.md" with { type: "text" };
import attachMd from "./mcp/tools/attach.md" with { type: "text" };
import batchMd from "./mcp/tools/batch.md" with { type: "text" };
import browseMd from "./mcp/tools/browse.md" with { type: "text" };
import commentMd from "./mcp/tools/comment.md" with { type: "text" };
import commentsMd from "./mcp/tools/comments.md" with { type: "text" };
import createLibraryMd from "./mcp/tools/create_library.md" with { type: "text" };
import deleteMd from "./mcp/tools/delete.md" with { type: "text" };
import diffMd from "./mcp/tools/diff.md" with { type: "text" };
import editMd from "./mcp/tools/edit.md" with { type: "text" };
import exportMd from "./mcp/tools/export.md" with { type: "text" };
import grepMd from "./mcp/tools/grep.md" with { type: "text" };
import historyMd from "./mcp/tools/history.md" with { type: "text" };
import linksMd from "./mcp/tools/links.md" with { type: "text" };
import logMd from "./mcp/tools/log.md" with { type: "text" };
import moveMd from "./mcp/tools/move.md" with { type: "text" };
import prepareUploadMd from "./mcp/tools/prepare_upload.md" with { type: "text" };
import queryMd from "./mcp/tools/query.md" with { type: "text" };
import readMd from "./mcp/tools/read.md" with { type: "text" };
import renderMd from "./mcp/tools/render.md" with { type: "text" };
import revertMd from "./mcp/tools/revert.md" with { type: "text" };
import searchMd from "./mcp/tools/search.md" with { type: "text" };
import showMd from "./mcp/tools/show.md" with { type: "text" };
import sourcesMd from "./mcp/tools/sources.md" with { type: "text" };
import startMd from "./mcp/tools/start.md" with { type: "text" };
import transformMd from "./mcp/tools/transform.md" with { type: "text" };
import verifyMd from "./mcp/tools/verify.md" with { type: "text" };
import workMd from "./mcp/tools/work.md" with { type: "text" };
import writeMd from "./mcp/tools/write.md" with { type: "text" };

/** A comment: on one line, up to its first `-->`. */
const COMMENT = /<!--(?:(?!-->)[^\n])*-->/g;
/** A line that is one comment and nothing else. */
const COMMENT_LINE = /^<!--(?:(?!-->)[^\n])*-->\n/gm;

/** A file as it is sent: without its final newline and its comments. */
function load(file: string): string {
  const text = file.endsWith("\n") ? file.slice(0, -1) : file;
  const out = text.replace(COMMENT_LINE, "").replace(COMMENT, "");
  if (out.includes("<!--")) throw new Error("prompt: a comment must open and close on one line");
  return out;
}

const PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

/** Values a prompt's placeholders take: numbers and strings, written as they print. */
export type PromptVars = Record<string, string | number>;

/**
 * A prompt with its `{{NAME}}` placeholders filled. Throws on a placeholder with no value and on
 * a value with no placeholder, so a prompt and the code that fills it cannot drift apart unseen.
 * Values go in as they are: a `{{NAME}}` inside one is not filled.
 */
export function render(text: string, vars: PromptVars = {}): string {
  const used = new Set<string>();
  const out = text.replace(PLACEHOLDER, (_, name: string) => {
    if (!Object.hasOwn(vars, name)) throw new Error(`prompt: no value for {{${name}}}`);
    used.add(name);
    return String(vars[name]);
  });
  const unused = Object.keys(vars).filter((k) => !used.has(k));
  if (unused.length) throw new Error(`prompt: unused ${unused.map((k) => `{{${k}}}`).join(", ")}`);
  return out;
}

/** The part of `file` marked as section `name`, as it is sent. */
function section(file: string, name: string): string {
  const open = `<!-- section: ${name} -->`;
  const from = file.indexOf(open);
  if (from === -1 || file.indexOf(open, from + 1) !== -1) {
    throw new Error(`prompt: no single section ${name}`);
  }
  const to = file.indexOf("<!-- /section -->", from);
  if (to === -1) throw new Error(`prompt: section ${name} is not closed`);
  return load(file.slice(from + open.length, to));
}

// ---- mcp/: what the MCP server sends every agent.

/** What `/mcp` tells every agent when it connects (most clients never load a skill). */
export const INSTRUCTIONS = render(load(instructionsMd));

/** A named part of the instructions, as the instructions send it (the managed agent quotes it). */
export const instructionsSection = (name: string): string => render(section(instructionsMd, name));

const TOOLS = {
  attach: attachMd,
  batch: batchMd,
  browse: browseMd,
  comment: commentMd,
  comments: commentsMd,
  create_library: createLibraryMd,
  delete: deleteMd,
  diff: diffMd,
  edit: editMd,
  export: exportMd,
  grep: grepMd,
  history: historyMd,
  links: linksMd,
  log: logMd,
  move: moveMd,
  prepare_upload: prepareUploadMd,
  query: queryMd,
  read: readMd,
  render: renderMd,
  revert: revertMd,
  search: searchMd,
  show: showMd,
  sources: sourcesMd,
  start: startMd,
  transform: transformMd,
  verify: verifyMd,
  work: workMd,
  write: writeMd,
} as const;

/** A tool the server registers, by the name agents call it. */
export type ToolName = keyof typeof TOOLS;

/** The description of tool `name`, its placeholders filled from `vars`. */
export const toolDescription = (name: ToolName, vars?: PromptVars): string =>
  render(load(TOOLS[name]), vars);

// ---- managed/: the managed agent, @tempra (TEMPRA-222).

/** The system prompt, the same for every turn so it and the tools are one cached prefix. */
export const managedSystem = (vars: { REPLY_MAX_WORDS: number; SERVER_INSTRUCTIONS: string }) =>
  render(load(systemMd), vars);

/** A turn's first message: the library, who asks and with what access, the thread, the page. */
export const managedTurn = (vars: {
  LIBRARY: string;
  URL: string;
  HANDLE: string;
  ACCESS: string;
  THREAD_ID: string;
  WHERE: string;
  COMMENTS: string;
  PAGE: string;
}) => render(load(turnMd), vars);

/** What a reply over the limit gets back, once, to be shortened. */
export const managedShorten = (vars: { WORDS: number; REPLY_MAX_WORDS: number }) =>
  render(load(shortenMd), vars);
