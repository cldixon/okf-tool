import type {
  BetaMessage,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { blocksOf, type Doc, type DocNode, idOf, signature } from "@tempra/editor/doc";
import type { Accounts } from "../accounts";
import { agentId, agentName } from "../agents";
import type { TokenInfo } from "../auth";
import type { BlobStore, LibraryClient } from "../client";
import { normalizePath } from "../format/paths";
import type { Images } from "../images";
import { appLinks, type McpContext } from "../mcp/server";
import { type NotifyDeps, notifying, postComment } from "../notify";
import { instructionsSection, managedShorten, managedSystem, managedTurn } from "../prompts";
import type { RenderLintDeps } from "../render-lint";
import type { CommentAction, ThreadView } from "../store/comments";
import { StoreError } from "../store/errors";
import type { ReadSurface } from "../store/reads";
import type { RequestContext } from "../store/store";
import { admit, tokenAdmission, type UsageDeps, WRITE_TOOLS } from "../usage";
import {
  AGENT_ACTOR,
  AGENT_KEY,
  type AgentJob,
  agentEnabled,
  type ManagedDeps,
  MODEL,
  reading,
  replying,
} from "./agent";
import { type AgentBudget, costMicros, usageDay } from "./budget";
import { agentTools, LocalMcp } from "./local-mcp";

/**
 * One turn of the library's managed agent (TEMPRA-222; tempra-dev: agents/managed-agent): the
 * queue's job, run to one reply in the thread. Claude through the Anthropic SDK with our own tool
 * loop; its tools are Tempra's MCP server in process (local-mcp.ts), as the asker's agent ("Tempra
 * for @handle") capped by the asker's role. Free of Worker APIs: the Worker passes the model, the
 * budget and the library; tests pass fakes.
 */

/** The Messages API as a turn uses it: `client.beta.messages.create`, or a fake. */
export interface ModelClient {
  create(params: MessageCreateParamsNonStreaming): Promise<BetaMessage>;
}

/** A turn's guard rails (tempra-dev: agents/managed-agent, Guard rails). */
export interface TurnLimits {
  /** max_tokens on each model call. */
  maxTokens: number;
  /** Model calls in one turn. */
  maxModelCalls: number;
  /** Tool calls in one turn, all tools together. */
  maxToolCalls: number;
  /** Wall-clock time for the turn, checked before each model call. */
  wallMs: number;
  /** Blocks a turn may change, on one page. */
  editBlocks: number;
  /** A tool result, in characters, as the model sees it. */
  toolChars: number;
  /** The page's markdown in the prompt, in characters (an excerpt past it, `pageExcerpt`). */
  pageChars: number;
}

/**
 * Everything the model reads is input on every later call of the turn and written to the cache
 * once (TEMPRA-231), so the page and tool results are kept to what a reply needs: about 3,000 and
 * 4,000 tokens.
 */
export const TURN_LIMITS: TurnLimits = {
  maxTokens: 8000,
  maxModelCalls: 12,
  maxToolCalls: 20,
  wallMs: 120_000,
  editBlocks: 3,
  toolChars: 16_000,
  pageChars: 12_000,
};

/**
 * The thread's page as the prompt gives it (TEMPRA-231): whole when it fits in `max` characters;
 * otherwise its head (frontmatter, title, opening) and, for a thread on a quote, the text around
 * the quote, marked as an excerpt so the model `read`s the page only when it needs the rest.
 */
export function pageExcerpt(markdown: string, quote: string | null, max: number): string {
  if (markdown.length <= max) return markdown;
  const note = `[An excerpt: the page is ${markdown.length} characters. \`read\` or \`grep\` it for the rest.]`;
  const at = quote ? markdown.indexOf(quote) : -1;
  if (!quote || at === -1) return `${markdown.slice(0, max)}\n[…]\n${note}`;
  const headChars = Math.floor(max / 3);
  const around = max - headChars;
  const from = Math.max(headChars, at - Math.floor(Math.max(0, around - quote.length) / 2));
  const to = Math.min(markdown.length, from + around);
  const rest = to < markdown.length ? "\n[…]" : "";
  if (from <= headChars) return `${markdown.slice(0, to)}${rest}\n${note}`;
  return `${markdown.slice(0, headChars)}\n[…]\n${markdown.slice(from, to)}${rest}\n${note}`;
}

export type TurnDeps = NotifyDeps &
  RenderLintDeps &
  UsageDeps & {
    accounts: Accounts;
    managed?: ManagedDeps | null;
    /** The library as the token's caller: the agent's reads are presence on the feed. */
    library(token: TokenInfo, surface?: ReadSurface): LibraryClient;
    blobs: BlobStore;
    images?: Images;
    /** Claude; null when the deployment has no ANTHROPIC_API_KEY. */
    model: ModelClient | null;
    budget: AgentBudget;
    /** The Worker's public origin, for the app's links. */
    origin: string;
    now?: () => Date;
    limits?: Partial<TurnLimits>;
    waitUntil?: (p: Promise<unknown>) => void;
  };

/** A turn's tokens, summed over its model calls, as the usage reports them. */
export interface TurnTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export type TurnOutcome =
  | {
      status: "replied";
      calls: number;
      tools: number;
      micro_usd: number;
      edited: string[];
      tokens: TurnTokens;
    }
  | { status: "skipped"; why: string }
  | { status: "unavailable" | "out_of_budget" | "failed" | "refused"; why?: string };

/** What it says when it cannot help, in the thread, as itself. */
export const SAY = {
  unavailable:
    "I'm not available in this deployment yet: it has no key for the model. Ask the operator to set ANTHROPIC_API_KEY.",
  outOfBudget:
    "I've reached today's spending limit for this library, so I can't answer now. Ask me again tomorrow.",
  failed: "Sorry, I couldn't finish answering this time. Ask me again in a moment.",
  refused: "Sorry, I can't help with this one.",
  noReply:
    "I looked into this but didn't get to a full answer this time. Ask me again, more narrowly.",
} as const;

/**
 * The longest reply a turn may post (TEMPRA-225): one over it is sent back once to be shortened,
 * then posted as it is rather than lose the answer.
 */
export const REPLY_MAX_WORDS = 70;

/** Words in a reply, as people count them: runs of non-space. */
export const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * The server's instructions (what /mcp tells any agent) as far as they apply to a reply
 * (TEMPRA-231): the sections of prompts/mcp/instructions.md with these names, their opening and
 * the item on editing. The rest is about writing pages, media, `work`, `show` and linking by URL,
 * which a turn never does (or does the other way: it cites by path and never resolves), and is
 * input on every model call.
 */
export const SERVER_SECTIONS = ["intro", "edits"] as const;

export function serverInstructions(): string {
  return SERVER_SECTIONS.map(instructionsSection).join("\n\n");
}

/**
 * The system prompt (prompts/managed/system.md), the same for every turn so the tools and it are
 * one cached prefix; the turn's own context (the library, the asker, the thread, the page) is the
 * first user message.
 */
export const SYSTEM_PROMPT = managedSystem({
  REPLY_MAX_WORDS,
  SERVER_INSTRUCTIONS: serverInstructions(),
});

/** The library's pages a reply cites, by path: `/<path>.md` or `<library url>/<path>.md`. */
export function citedPaths(body: string, library: string): string[] {
  const base = library.replace(/\/+$/, "");
  const out: string[] = [];
  let at = body.indexOf(`${base}/`);
  while (at !== -1) {
    const rest = body.slice(at + base.length + 1);
    const m = /^([^\s?#)\]>"']+\.md)/.exec(rest);
    if (m?.[1] && !m[1].startsWith("-/")) out.push(decodeURIComponent(m[1]));
    at = body.indexOf(`${base}/`, at + base.length + 1);
  }
  for (const m of body.matchAll(/(?<![\w/.:])\/([\w./-]*[\w-]\.md)\b/g)) {
    if (m[1] && !m[1].startsWith("-/")) out.push(m[1]);
  }
  return [...new Set(out)];
}

/** Library text as data in the prompt: its closing tag cannot be forged from inside. */
const quoted = (tag: string, s: string) => s.replaceAll(`</${tag}>`, `<\\/${tag}>`);

/** A tool result cut to `n` characters, saying so and how to find the rest. */
const clip = (s: string, n: number) =>
  s.length > n
    ? `${s.slice(0, n)}\n[cut at ${n} of ${s.length} characters: \`grep\` or \`search\` for the part you need]`
    : s;

/** A person by handle, an agent for whom it acts, as the thread is written for the model. */
async function names(
  d: TurnDeps,
  thread: ThreadView,
): Promise<(c: ThreadView["comments"][number]) => string> {
  const ids = thread.comments.flatMap((c) => c.by?.agent ?? []);
  const agents = ids.length
    ? new Map((await d.accounts.agents(ids).catch(() => [])).map((a) => [a.id, agentName(a)]))
    : new Map<string, string>();
  return (c) =>
    c.actor === AGENT_ACTOR
      ? "Tempra (you)"
      : c.actor.startsWith("human:")
        ? `@${c.actor.slice("human:".length)}`
        : ((c.by?.agent && agents.get(c.by.agent)) ?? c.actor);
}

/** The turn's first message: the library, who asks and with what access, the thread, the page. */
export async function turnPrompt(
  d: TurnDeps,
  o: {
    library: string;
    url: string;
    handle: string;
    mayEdit: boolean;
    thread: ThreadView;
    asked: string | null;
    page: string | null;
  },
): Promise<string> {
  const who = await names(d, o.thread);
  const t = o.thread;
  const comments = t.comments.map((c) => {
    const ask = c.id === o.asked ? " [the comment to answer]" : "";
    return `<comment by="${who(c)}" at="${c.ts}"${ask}>\n${quoted("comment", c.body)}\n</comment>`;
  });
  return managedTurn({
    LIBRARY: o.library,
    URL: o.url,
    HANDLE: o.handle,
    ACCESS: o.mayEdit
      ? "may edit pages here"
      : "may read and comment here but not edit: answer, or file a request",
    THREAD_ID: t.id,
    WHERE: [
      t.path ? `on the page ${t.path}` : "on the library itself (no page)",
      t.kind === "request" ? ", already marked a request" : "",
      t.anchor ? `, on the quote "${quoted("thread", t.anchor.quote).slice(0, 500)}"` : "",
    ].join(""),
    COMMENTS: comments.map((c) => `\n${c}`).join(""),
    PAGE: o.page !== null ? `\n\n<page path="${t.path}">\n${quoted("page", o.page)}\n</page>` : "",
  });
}

/** Leaf blocks by ID and content, to count what an edit changed. */
function leaves(doc: Doc): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: DocNode) => {
    const kids = blocksOf(n);
    if (kids.length === 0 && n.type !== "root") {
      const id = idOf(n);
      if (id) out.set(id, signature(n));
      return;
    }
    for (const k of kids) walk(k);
  };
  walk(doc);
  return out;
}

/** How many blocks differ between two versions of a page: changed, added and removed. */
export function changedBlocks(before: Doc, after: Doc): number {
  const a = leaves(before);
  const b = leaves(after);
  let n = 0;
  for (const [id, sig] of a) if (b.get(id) !== sig) n++;
  for (const id of b.keys()) if (!a.has(id)) n++;
  return n;
}

/** Blocks an edit's pairs would touch at least: the paragraphs in each side's text. */
export function blocksTouched(edits: unknown): number {
  if (!Array.isArray(edits)) return 0;
  const paras = (s: unknown) =>
    typeof s === "string" ? Math.max(1, s.split(/\n\s*\n/).filter((p) => p.trim()).length) : 1;
  return edits.reduce(
    (n: number, e) =>
      n + Math.max(paras((e as { old?: unknown })?.old), paras((e as { new?: unknown })?.new)),
    0,
  );
}

/** The MCP tools as the Messages API takes them; cached with the system prompt after them. */
const asTools = (list: Awaited<ReturnType<LocalMcp["tools"]>>): BetaTool[] =>
  list.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as BetaTool["input_schema"],
  }));

/** The token the agent acts with for the asker: their role, the agent's own actor. */
function agentToken(
  lib: { id: string; slug: string; do_id: string; owner: string },
  asker: { id: string; handle: string },
  role: TokenInfo["role"],
  agent: string,
): TokenInfo {
  return {
    id: `agent:${lib.id}:${asker.id}`,
    actor: AGENT_ACTOR,
    scope: role === "read" ? "read" : "write",
    prefix: null,
    mcp_tiers: "all",
    library: { id: lib.id, slug: lib.slug, do_id: lib.do_id, owner: lib.owner },
    created_by: asker.id,
    role,
    person: asker.handle,
    agent,
  };
}

/**
 * Runs one job to one reply. Returns what happened; throws only for a failure worth one retry (the
 * model or the library unreachable before anything was written), unless `lastAttempt`, when it
 * says in the thread that it could not answer instead.
 */
export async function runTurn(
  d: TurnDeps,
  job: AgentJob,
  opts: { lastAttempt?: boolean } = {},
): Promise<TurnOutcome> {
  const limits = { ...TURN_LIMITS, ...d.limits };
  const now = d.now ?? (() => new Date());
  const started = now().getTime();

  // Everything again from D1: access may have changed since the comment.
  const lib = await d.accounts.libraryByDoId(job.do_id);
  if (!lib || lib.id !== job.library) return { status: "skipped", why: "no such library" };
  const owner = await d.accounts.limits(lib.ownerId);
  if (!agentEnabled(owner)) return { status: "skipped", why: "the agent is off" };
  const asker = await d.accounts.account(job.asker);
  if (!asker) return { status: "skipped", why: "no such person" };
  const role = lib.ownerId === asker.id ? "owner" : await d.accounts.memberRole(lib.id, asker.id);
  if (!role) return { status: "skipped", why: "the asker can no longer reach the library" };
  const agent = await d.accounts
    .recordAgent(asker.id, AGENT_KEY)
    .catch(() => agentId(asker.id, AGENT_KEY.platform));
  const mayEdit = role !== "read";
  const token = agentToken(lib, asker, role, agent);
  const ref = token.library;
  const by = { person: asker.id, agent };
  const lib0 = d.library(token, "mcp");
  const thread = await lib0.thread(job.thread).catch((e) => {
    if (e instanceof StoreError && e.status === 404) return null;
    throw e;
  });
  if (thread?.status !== "open") return { status: "skipped", why: "the thread is closed" };
  // A retried job whose reply already landed does nothing again.
  if (thread.comments.some((c) => c.actor === AGENT_ACTOR && c.seq > job.seq)) {
    return { status: "skipped", why: "already answered" };
  }

  const request = (note: string | null = null): RequestContext => ({
    actor: AGENT_ACTOR,
    request_id: crypto.randomUUID(),
    note,
    by,
  });
  let replied = false;
  const say = async (body: string) => {
    if (replied) return;
    const action: CommentAction = { kind: "reply", thread: thread.id, body };
    await postComment(d, token, lib0, request(), action);
    replied = true;
  };
  const announce = () =>
    d.managed?.announce?.(lib.do_id, replying(thread.id, thread.path, by)).catch(() => {});
  /** The pages the turn works from, shimmering in the tree as an agent's reads do. */
  const readingNow = async (paths: string[]) => {
    const unique = [...new Set(paths.filter((p) => p))];
    if (unique.length > 0)
      await d.managed?.announce?.(lib.do_id, reading(unique, by)).catch(() => {});
  };

  if (!d.model) {
    await say(SAY.unavailable);
    return { status: "unavailable" };
  }
  const cap = owner.agent_daily_usd * 1_000_000;
  const day = usageDay(now());
  if ((await d.budget.spent(lib.ownerId, day)) >= cap) {
    await say(SAY.outOfBudget);
    return { status: "out_of_budget" };
  }
  await d.budget.charge(lib.ownerId, day, 0, true);
  await announce();

  // Tempra's MCP server in process, as the asker's agent: the same tools /mcp serves.
  const who = tokenAdmission(token);
  const ctx: McpContext = {
    actor: AGENT_ACTOR,
    scope: token.scope,
    tiers: "all",
    libraries: [token],
    by,
    open: (t) => notifying(d, t, d.library(t, "mcp"), d.waitUntil),
    comment: (t, req, action) => postComment(d, t, d.library(t, "mcp"), req, action),
    about: (id) => d.accounts.about(id),
    agentNames: async (ids) =>
      new Map((await d.accounts.agents(ids)).map((a) => [a.id, agentName(a)])),
    blobs: d.blobs,
    images: d.images,
    meter: (e) => d.meter?.({ ...e, account: who.account }),
    origin: d.origin,
  };
  const mcp = new LocalMcp(ctx, agentTools(mayEdit));
  const tools = asTools(await mcp.tools());
  const links = appLinks(d.origin, ref.owner, ref.slug);
  let page: string | null = null;
  if (thread.path) {
    const view = await lib0.read(thread.path).catch(() => null);
    if (view?.kind === "page")
      page = pageExcerpt(view.markdown, thread.anchor?.quote ?? null, limits.pageChars);
  }
  // It reads the thread's page from the prompt, not with `read`, so say so on the feed.
  const onPage = page !== null ? [thread.path] : [];
  await readingNow(onPage);
  const messages: BetaMessageParam[] = [
    {
      role: "user",
      content: await turnPrompt(d, {
        library: `${ref.owner}/${ref.slug}`,
        url: links.library,
        handle: asker.handle,
        mayEdit,
        thread,
        asked: job.comment,
        page,
      }),
    },
  ];

  // The edit gate: one page, a few blocks, with a note.
  let edited: { path: string; seq: number; doc: Doc } | null = null;
  let editedBlocks = 0;
  let toolCalls = 0;
  let calls = 0;
  let spent = 0;
  const tokens: TurnTokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let wrote = false;
  let shortened = false;

  const refuse = (text: string) => ({ text, isError: true });
  const gate = async (name: string, raw: unknown): Promise<{ text: string; isError: boolean }> => {
    if (toolCalls >= limits.maxToolCalls) {
      return refuse(
        `That is the turn's limit of ${limits.maxToolCalls} tool calls: reply now with \`comment\`.`,
      );
    }
    toolCalls++;
    const input = { ...((raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>) };
    delete input.library;
    if (name === "comment") {
      if (replied) return refuse("You have replied in this turn already; end the turn.");
      const action = input.action;
      if (action === "resolve") {
        return refuse(
          "You never resolve a thread: reply instead and leave it open; the person resolves it once they have read your answer.",
        );
      }
      if (action !== "reply") {
        return refuse("Here you only reply in this thread; you do not open or reopen threads.");
      }
      if (input.thread !== undefined && input.thread !== thread.id) {
        return refuse(`Reply in this thread only: ${thread.id}.`);
      }
      input.thread = thread.id;
      const words = wordCount(String(input.body ?? ""));
      if (words > REPLY_MAX_WORDS && !shortened) {
        shortened = true;
        return refuse(managedShorten({ WORDS: words, REPLY_MAX_WORDS }));
      }
    }
    if (name === "edit") {
      if (!mayEdit)
        return refuse("The person you act for may not edit here: file a request instead.");
      const path = normalizePath(String(input.path ?? ""));
      if (!path) return refuse("`edit` needs the page's `path`.");
      if (edited && edited.path !== path) {
        return refuse(`One page a turn: you have edited ${edited.path}. For more, file a request.`);
      }
      const more = blocksTouched(input.edits);
      if (editedBlocks + more > limits.editBlocks) {
        return refuse(
          `That is more than a small edit (at most ${limits.editBlocks} blocks a turn): file a request instead.`,
        );
      }
      if (!edited) {
        const view = await lib0.read(path).catch(() => null);
        if (view?.kind !== "page")
          return refuse(`There is no page ${path} to edit; you only edit pages that exist.`);
        edited = { path: view.path, seq: view.seq, doc: view.doc };
      }
      if (typeof input.note !== "string" || !input.note.trim()) {
        input.note = `Tempra for @${asker.handle}, asked in a comment`;
      }
      input.path = path;
    }
    try {
      await admit(d, who, WRITE_TOOLS.has(name));
    } catch (e) {
      return refuse(e instanceof Error ? e.message : String(e));
    }
    const out = await mcp.call(name, input);
    if (out.isError) return out;
    if (name === "comment") {
      replied = true;
      wrote = true;
      // The pages its reply cites are the ones it answered from.
      await readingNow(citedPaths(String(input.body ?? ""), links.library));
    }
    if (name === "edit" && edited) {
      wrote = true;
      const after = await lib0.read(edited.path).catch(() => null);
      if (after?.kind === "page") editedBlocks = changedBlocks(edited.doc, after.doc);
      const since = `${links.page(edited.path)}?since=${edited.seq}`;
      return { text: `${out.text}\nChanges: ${since}`, isError: false };
    }
    return out;
  };

  try {
    for (;;) {
      if (calls >= limits.maxModelCalls || now().getTime() - started > limits.wallMs) break;
      if ((await d.budget.spent(lib.ownerId, day)) >= cap) {
        if (!replied) await say(SAY.outOfBudget);
        return { status: "out_of_budget" };
      }
      // Said again while it works, never once its reply has landed (that clears it).
      if (calls > 0 && !replied) {
        await announce();
        await readingNow(onPage);
      }
      calls++;
      const res = await d.model.create({
        model: MODEL,
        max_tokens: limits.maxTokens,
        // Opus 5.5 thinks adaptively; effort is the only control. Never forced tool choice.
        output_config: { effort: "low" },
        // The server-side refusal fallback, by refusal category.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools,
        messages,
        // The turn's conversation, cached as it grows.
        cache_control: { type: "ephemeral" },
      });
      const usage = res.usage ?? {};
      const micro = costMicros(usage);
      spent += micro;
      const call = {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cache_read: usage.cache_read_input_tokens ?? 0,
        cache_write: usage.cache_creation_input_tokens ?? 0,
      };
      for (const k of Object.keys(call) as (keyof TurnTokens)[]) tokens[k] += call[k];
      // One line a model call, so what a reply costs, and where, can be read from the logs.
      console.log(
        JSON.stringify({
          agent_call: thread.id,
          library: lib.id,
          n: calls,
          model: res.model,
          stop: res.stop_reason,
          ...call,
          micro_usd: micro,
        }),
      );
      await d.budget.charge(lib.ownerId, day, micro);
      messages.push({ role: "assistant", content: res.content });
      if (res.stop_reason === "refusal") {
        if (!replied) await say(SAY.refused);
        return { status: "refused", why: res.stop_details?.category ?? undefined };
      }
      const uses = res.content.filter((b) => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || uses.length === 0) {
        // Said, not posted: its last words become the reply, so a turn always ends with one.
        if (!replied) {
          const text = res.content
            .flatMap((b) => (b.type === "text" ? [b.text] : []))
            .join("\n")
            .trim();
          await say(res.stop_reason === "max_tokens" || !text ? SAY.noReply : text.slice(0, 4000));
        }
        break;
      }
      const results: BetaToolResultBlockParam[] = [];
      for (const b of uses) {
        if (b.type !== "tool_use") continue;
        const out = await gate(b.name, b.input);
        results.push({
          type: "tool_result",
          tool_use_id: b.id,
          content: clip(out.text, limits.toolChars),
          ...(out.isError ? { is_error: true } : {}),
        });
      }
      // Its reply is the turn's last act: once it lands there is nothing to ask the model, so the
      // call that would only end the turn is not made (TEMPRA-231).
      if (replied) break;
      messages.push({ role: "user", content: results });
    }
    if (!replied) await say(SAY.noReply);
    return {
      status: "replied",
      calls,
      tools: toolCalls,
      micro_usd: spent,
      edited: edited ? [(edited as { path: string }).path] : [],
      tokens,
    };
  } catch (e) {
    // Retried once while nothing was written; then said in the thread.
    if (!wrote && !opts.lastAttempt) throw e;
    console.error(JSON.stringify({ agent_turn_failed: job.thread, error: String(e) }));
    await say(SAY.failed).catch(() => {});
    return { status: "failed", why: String(e).slice(0, 300) };
  }
}

/**
 * The last attempt failed before the turn could say so (the library or D1 unreachable): one more
 * try at telling the thread, as the agent, if the job still stands.
 */
export async function failTurn(d: TurnDeps, job: AgentJob): Promise<void> {
  const lib = await d.accounts.libraryByDoId(job.do_id);
  const asker = await d.accounts.account(job.asker);
  if (!lib || !asker) return;
  const role = lib.ownerId === asker.id ? "owner" : await d.accounts.memberRole(lib.id, asker.id);
  if (!role) return;
  const agent = agentId(asker.id, AGENT_KEY.platform);
  const token = agentToken(lib, asker, role, agent);
  const client = d.library(token, "mcp");
  await postComment(
    d,
    token,
    client,
    {
      actor: AGENT_ACTOR,
      request_id: crypto.randomUUID(),
      note: null,
      by: { person: asker.id, agent },
    },
    { kind: "reply", thread: job.thread, body: SAY.failed },
  );
}
