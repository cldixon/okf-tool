/**
 * The MCP server's prompts (TEMPRA-314): its instructions and each tool's description, one
 * markdown file each beside this loader, bundled at build time (a Wrangler `Text` rule; bun reads
 * them through the import attribute). A file is exactly what the model sees, but for the one
 * newline an editor ends it with, and for `{{NAME}}` placeholders, which the code fills from its
 * constants through `render`. Free of Worker APIs.
 */
import instructionsMd from "./instructions.md" with { type: "text" };
import attachMd from "./tools/attach.md" with { type: "text" };
import batchMd from "./tools/batch.md" with { type: "text" };
import browseMd from "./tools/browse.md" with { type: "text" };
import commentMd from "./tools/comment.md" with { type: "text" };
import commentsMd from "./tools/comments.md" with { type: "text" };
import createLibraryMd from "./tools/create_library.md" with { type: "text" };
import deleteMd from "./tools/delete.md" with { type: "text" };
import diffMd from "./tools/diff.md" with { type: "text" };
import editMd from "./tools/edit.md" with { type: "text" };
import exportMd from "./tools/export.md" with { type: "text" };
import grepMd from "./tools/grep.md" with { type: "text" };
import historyMd from "./tools/history.md" with { type: "text" };
import linksMd from "./tools/links.md" with { type: "text" };
import logMd from "./tools/log.md" with { type: "text" };
import moveMd from "./tools/move.md" with { type: "text" };
import prepareUploadMd from "./tools/prepare_upload.md" with { type: "text" };
import queryMd from "./tools/query.md" with { type: "text" };
import readMd from "./tools/read.md" with { type: "text" };
import renderMd from "./tools/render.md" with { type: "text" };
import revertMd from "./tools/revert.md" with { type: "text" };
import searchMd from "./tools/search.md" with { type: "text" };
import showMd from "./tools/show.md" with { type: "text" };
import sourcesMd from "./tools/sources.md" with { type: "text" };
import startMd from "./tools/start.md" with { type: "text" };
import transformMd from "./tools/transform.md" with { type: "text" };
import verifyMd from "./tools/verify.md" with { type: "text" };
import workMd from "./tools/work.md" with { type: "text" };
import writeMd from "./tools/write.md" with { type: "text" };

/** A file's text without the newline that ends it. */
const body = (text: string) => (text.endsWith("\n") ? text.slice(0, -1) : text);

const PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

/** Values a prompt's placeholders take: numbers and strings, written as they print. */
export type PromptVars = Record<string, string | number>;

/**
 * A prompt with its `{{NAME}}` placeholders filled. Throws on a placeholder with no value and on
 * a value with no placeholder, so a prompt and the code that fills it cannot drift apart unseen.
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

/** What `/mcp` tells every agent when it connects (most clients never load a skill). */
export const INSTRUCTIONS = render(body(instructionsMd));

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
  render(body(TOOLS[name]), vars);
