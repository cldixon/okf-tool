import { describe, expect, spyOn, test } from "bun:test";
import type {
  BetaContentBlock,
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseMarkdown, reconcile } from "@tempra/editor/doc";
import {
  AGENT_ACTOR,
  type AgentJob,
  type ReadingMessage,
  type ReplyingMessage,
} from "../src/managed/agent";
import { type AgentBudget, costMicros, d1AgentBudget, usageDay } from "../src/managed/budget";
import { handleAgentMessage } from "../src/managed/consumer";
import { fakeModel } from "../src/managed/fake";
import { agentTools } from "../src/managed/local-mcp";
import {
  blocksTouched,
  changedBlocks,
  citedPaths,
  type ModelClient,
  pageExcerpt,
  REPLY_MAX_WORDS,
  runTurn,
  SAY,
  SERVER_SECTIONS,
  SYSTEM_PROMPT,
  serverInstructions,
  type TurnDeps,
} from "../src/managed/turn";
import { INSTRUCTIONS } from "../src/mcp/server";
import { instructionsSection } from "../src/prompts";
import { bunD1 } from "./d1";
import { API, LIB, ORIGIN, OWNER, setup } from "./harness";

type S = ReturnType<typeof setup>;
type Text = { type: "text"; text: string };
type Thread = {
  id: string;
  path: string;
  kind: string;
  status: string;
  comments: { actor: string; body: string; by?: { person: string; agent?: string } }[];
};

const doc = (title: string, body: string) =>
  `---\ntype: Metric\ntitle: ${title}\ndescription: ${title} in one line.\n---\n${body}`;

async function seed(s: S) {
  for (const [path, title, body] of [
    [
      "metrics/margin.md",
      "Margin",
      "# Margin\n\nMargin is revenue minus cost.\n\nIt is reported monthly.\n",
    ],
    ["metrics/churn.md", "Churn", "# Churn\n\nChurn is customers lost.\n"],
  ] as const) {
    const r = await s.req(`/files/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: doc(title, body),
    });
    expect(r.status).toBeLessThan(300);
  }
}

/** The agent on for the demo library's owner, with a daily cap in dollars. */
function enable(s: S, usd = 5) {
  s.db.run("UPDATE users SET limits = ? WHERE id = ?", [
    JSON.stringify({ agent_daily_usd: usd }),
    OWNER.id,
  ]);
}

/** The agent's queue and feed as the Worker would wire them, captured. */
function wire(s: S) {
  const jobs: AgentJob[] = [];
  const announced: { doId: string; message: ReplyingMessage | ReadingMessage }[] = [];
  s.deps.managed = {
    enqueue: async (job) => {
      jobs.push(job);
    },
    announce: async (doId, message) => {
      announced.push({ doId, message });
    },
  };
  return { jobs, announced };
}

function memoryBudget(): AgentBudget & { charged: number[] } {
  const spent = new Map<string, number>();
  const charged: number[] = [];
  return {
    charged,
    async spent(user, day) {
      return spent.get(`${user}|${day}`) ?? 0;
    },
    async charge(user, day, micro) {
      charged.push(micro);
      spent.set(`${user}|${day}`, (spent.get(`${user}|${day}`) ?? 0) + micro);
    },
  };
}

function turnDeps(
  s: S,
  model: ModelClient | null,
  budget = memoryBudget(),
): TurnDeps & { budget: ReturnType<typeof memoryBudget> } {
  return { ...s.deps, model, budget, origin: ORIGIN };
}

/** A scripted model: each call answers with the next step's blocks; it records what it was sent. */
function scripted(
  steps: ((p: MessageCreateParamsNonStreaming) => Partial<BetaMessage> & { content: unknown[] })[],
) {
  const sent: MessageCreateParamsNonStreaming[] = [];
  const model: ModelClient = {
    async create(params) {
      sent.push(structuredClone(params));
      const step = steps[sent.length - 1];
      if (!step) throw new Error("the script ran out");
      const r = step(params);
      return {
        id: `msg_${sent.length}`,
        type: "message",
        role: "assistant",
        model: params.model,
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 10_000 },
        ...r,
      } as unknown as BetaMessage;
    },
  };
  return { model, sent };
}

const use = (name: string, input: Record<string, unknown>, id = `tu_${name}`) =>
  ({ type: "tool_use", id, name, input }) as unknown as BetaContentBlock;
const said = (text: string) => ({ type: "text", text }) as unknown as BetaContentBlock;
const end =
  (text = "Done.") =>
  () => ({ stop_reason: "end_turn" as const, content: [said(text)] });

/** The tool results the model was sent after its last call, as text. */
function results(p: MessageCreateParamsNonStreaming): { text: string; error: boolean }[] {
  const last = p.messages[p.messages.length - 1];
  const blocks = Array.isArray(last?.content) ? last.content : [];
  return blocks.flatMap((b) =>
    b.type === "tool_result"
      ? [{ text: String(b.content), error: (b as { is_error?: boolean }).is_error === true }]
      : [],
  );
}

function post(s: S, path: string, body?: unknown, app = s.app) {
  return app.request(`${API}${path}`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function thread(s: S, id: string): Promise<Thread> {
  return (await (await s.app.request(`${API}/comments/${id}`)).json()) as Thread;
}

async function mcp(s: S, token = "writer") {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (url, init) => s.app.request(url.toString(), init as RequestInit),
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as Text[]).map((c) => c.text).join("\n"), isError: !!r.isError };
  };
}

/** Opens a thread asking the agent, as the signed-in owner; answers the queued job. */
async function ask(
  s: S,
  jobs: AgentJob[],
  body: string,
  path: string | null = "metrics/margin.md",
) {
  const r = await post(s, "/comments", { ...(path ? { path } : {}), body });
  expect(r.status).toBe(201);
  const { thread: t } = (await r.json()) as { thread: Thread };
  return { id: t.id, job: jobs[jobs.length - 1] };
}

describe("the trigger (postComment)", () => {
  test("a mention of @tempra queues one turn and says the agent is replying", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs, announced } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra what is margin?");
    expect(jobs).toHaveLength(1);
    expect(job).toMatchObject({
      type: "agent_turn",
      library: LIB.id,
      do_id: LIB.do_id,
      thread: id,
      asker: OWNER.id,
    });
    expect(announced).toHaveLength(1);
    expect(announced[0]?.message).toMatchObject({
      type: "presence",
      kind: "replying",
      actor: AGENT_ACTOR,
      thread: id,
      paths: ["metrics/margin.md"],
    });
    // The mention is kept as the agent's, not a person's.
    const t = (await (await s.app.request(`${API}/comments?status=all`)).json()) as {
      threads: (Thread & { comments: { mentions?: string[] }[] })[];
    };
    expect(t.threads[0]?.comments[0]?.mentions).toEqual(["@tempra"]);
  });

  test("off for the owner's account: @tempra is plain text and nothing is queued", async () => {
    const s = setup();
    await seed(s);
    const { jobs, announced } = wire(s);
    await ask(s, jobs, "@tempra what is margin?");
    expect(jobs).toHaveLength(0);
    expect(announced).toHaveLength(0);
  });

  test("no mention, a resolve, or the agent's own comment: nothing; a reply in its thread: a turn", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    await ask(s, jobs, "Plain remark.");
    expect(jobs).toHaveLength(0);
    const { id } = await ask(s, jobs, "@tempra what is margin?");
    expect(jobs).toHaveLength(1);
    // The agent answers (no key: it says it is unavailable), which queues nothing.
    await runTurn(turnDeps(s, null), jobs[0] as AgentJob);
    expect(jobs).toHaveLength(1);
    expect((await thread(s, id)).comments.at(-1)?.actor).toBe(AGENT_ACTOR);
    // A follow-up in a thread it answered needs no mention.
    expect((await post(s, `/comments/${id}`, { body: "And monthly?" })).status).toBe(200);
    expect(jobs).toHaveLength(2);
    expect((await post(s, `/comments/${id}/resolve`, {})).status).toBe(200);
    expect(jobs).toHaveLength(2);
    // Reopening it bare asks nothing; reopening it with a comment is a reply.
    expect((await post(s, `/comments/${id}/reopen`, {})).status).toBe(200);
    expect(jobs).toHaveLength(2);
    expect((await post(s, `/comments/${id}/resolve`, {})).status).toBe(200);
    expect((await post(s, `/comments/${id}/reopen`, { body: "Yes, please do." })).status).toBe(200);
    expect(jobs).toHaveLength(3);
  });

  test("a mention by an agent acting for a person asks for that person", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    const call = await mcp(s, "human");
    const r = await call("comment", {
      action: "open",
      path: "metrics/margin.md",
      body: "@tempra check this",
    });
    expect(r.isError).toBe(false);
    expect(jobs[0]?.asker).toBe(OWNER.id);
  });
});

describe("a turn", () => {
  test("no key: it says it is unavailable, in the thread, as the asker's agent", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra hello");
    const out = await runTurn(turnDeps(s, null), job as AgentJob);
    expect(out.status).toBe("unavailable");
    const t = await thread(s, id);
    expect(t.comments.at(-1)).toMatchObject({ actor: AGENT_ACTOR, body: SAY.unavailable });
    expect(t.comments.at(-1)?.by?.person).toBe(OWNER.id);
    expect(t.comments.at(-1)?.by?.agent).toMatch(/^agt_/);
  });

  test("it reads through the MCP tools, replies once, as the Tempra agent of the person who asked", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs, announced } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra what is margin?");
    const { model, sent } = scripted([
      () => ({ content: [use("read", { path: "metrics/churn.md" })] }),
      () => ({
        content: [
          use("comment", {
            action: "reply",
            thread: id,
            body: "Revenue minus cost: http://localhost/owner/demo/metrics/margin.md",
          }),
        ],
      }),
    ]);
    const d = turnDeps(s, model);
    const out = await runTurn(d, job as AgentJob);
    // Its reply ends the turn: no model call after it only to stop (TEMPRA-231).
    expect(out).toMatchObject({
      status: "replied",
      calls: 2,
      tools: 2,
      tokens: { input: 4000, output: 200, cache_read: 20_000, cache_write: 0 },
    });
    expect(sent).toHaveLength(2);
    const t = await thread(s, id);
    expect(t.comments).toHaveLength(2);
    expect(t.comments[1]).toMatchObject({ actor: AGENT_ACTOR });
    expect(t.comments[1]?.body).toContain("Revenue minus cost");
    // The request: the cached system prompt and tools, low effort, the refusal fallback, no
    // thinking setting and no forced tool choice.
    const first = sent[0] as MessageCreateParamsNonStreaming & Record<string, unknown>;
    expect(first.model).toBe("claude-opus-5-5");
    expect(first.output_config).toEqual({ effort: "low" });
    expect(first.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(first.fallbacks).toBe("default");
    expect(first.thinking).toBeUndefined();
    expect(first.tool_choice).toBeUndefined();
    expect(first.system).toEqual([
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ]);
    expect(String(first.messages[0]?.content)).toContain("@tempra what is margin?");
    expect(String(first.messages[0]?.content)).toContain('<page path="metrics/margin.md">');
    // Its reads are an agent's on the feed (TEMPRA-219), and it said it was replying.
    expect(
      s.presence.some(
        (p) => p.message.actor === AGENT_ACTOR && p.message.paths.includes("metrics/churn.md"),
      ),
    ).toBe(true);
    // At the comment, at the turn's start, before its second call; not after its reply landed.
    expect(
      announced.filter((a) => a.message.kind === "replying" && a.message.thread === id),
    ).toHaveLength(3);
    // The thread's page, which it is given rather than reads, and the page its reply cites, are
    // its reads too (TEMPRA-224): announced as such, so the tree shimmers them.
    const read = announced.filter((a) => a.message.kind === "reading");
    expect(read.length).toBeGreaterThanOrEqual(2);
    expect(read.every((a) => a.message.actor === AGENT_ACTOR)).toBe(true);
    expect(read.at(-1)?.message.paths).toEqual(["metrics/margin.md"]);
    // It is the asker's agent on its own platform.
    const agents = (await (await s.app.request(`${API}/agents`)).json()) as {
      agents: { name: string }[];
    };
    expect(JSON.stringify(agents)).toContain('"name":"Tempra","platform":"tempra"');
    expect(JSON.stringify(agents)).toContain(`"actor":"${AGENT_ACTOR}"`);
    // What it cost, at list price.
    expect(d.budget.charged.reduce((a, b) => a + b, 0)).toBe(
      2 * costMicros({ input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 10_000 }),
    );
  });

  test("a turn that ends without commenting posts its last words as the reply", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra hi");
    const { model } = scripted([end("Margin is revenue minus cost.")]);
    await runTurn(turnDeps(s, model), job as AgentJob);
    expect((await thread(s, id)).comments.at(-1)?.body).toBe("Margin is revenue minus cost.");
  });

  test("its reply naming @tempra is not a mention of itself", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    const { job } = await ask(s, jobs, "@tempra how do I ask you?");
    const { model } = scripted([end("Mention @tempra in a comment and I reply.")]);
    await runTurn(turnDeps(s, model), job as AgentJob);
    const t = (await (await s.app.request(`${API}/comments?status=all`)).json()) as {
      threads: { comments: { actor: string; mentions?: string[] }[] }[];
    };
    const reply = t.threads[0]?.comments.at(-1);
    expect(reply?.actor).toBe(AGENT_ACTOR);
    expect(reply?.mentions ?? []).toEqual([]);
    // And its reply asked for no further turn.
    expect(jobs).toHaveLength(1);
  });

  test("a refusal says it cannot help; a retried job already answered does nothing", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra something");
    const { model } = scripted([() => ({ stop_reason: "refusal", content: [] })]);
    expect((await runTurn(turnDeps(s, model), job as AgentJob)).status).toBe("refused");
    expect((await thread(s, id)).comments.at(-1)?.body).toBe(SAY.refused);
    expect((await runTurn(turnDeps(s, model), job as AgentJob)).status).toBe("skipped");
    expect((await thread(s, id)).comments).toHaveLength(2);
  });

  test("the queue's consumer retries a failure once, then says it could not answer", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra hi");
    const broken: ModelClient = {
      async create() {
        throw new Error("overloaded");
      },
    };
    expect(await handleAgentMessage(turnDeps(s, broken), job, 1)).toBe("retry");
    expect((await thread(s, id)).comments).toHaveLength(1);
    expect(await handleAgentMessage(turnDeps(s, broken), job, 2)).toBe("ack");
    expect((await thread(s, id)).comments.at(-1)?.body).toBe(SAY.failed);
    expect(await handleAgentMessage(turnDeps(s, broken), { nope: 1 }, 1)).toBe("ack");
  });

  test("the stand-in model for local dev reads, then replies, or files a request", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    const answer = await ask(s, jobs, "@tempra what is margin?");
    await runTurn(turnDeps(s, fakeModel(0)), answer.job as AgentJob);
    expect((await thread(s, answer.id)).comments.at(-1)?.body).toContain(
      "I read metrics/margin.md",
    );
    const bigger = await ask(s, jobs, "@tempra request: a new page on pricing", null);
    await runTurn(turnDeps(s, fakeModel(0)), bigger.job as AgentJob);
    const t = await thread(s, bigger.id);
    expect(t).toMatchObject({ kind: "request", status: "open", path: "" });
  });
});

describe("what it may do", () => {
  test("its tools: read-only ones, comment, and edit only when the asker may write", () => {
    expect(agentTools(true)).toContain("edit");
    expect(agentTools(false)).not.toContain("edit");
    for (const never of [
      "write",
      "move",
      "delete",
      "batch",
      "attach",
      "prepare_upload",
      "transform",
      "revert",
      "create_library",
      "export",
      "show",
      "render",
    ]) {
      expect(agentTools(true)).not.toContain(never);
    }
  });

  test("a tool it was not given, or a second reply, comes back as an error", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra make a page");
    const { model, sent } = scripted([
      (p) => {
        expect((p.tools ?? []).map((t) => (t as { name: string }).name)).toEqual(agentTools(true));
        return {
          content: [
            use("write", { path: "x.md", content: "x" }, "a"),
            use("delete", { path: "metrics/churn.md" }, "b"),
          ],
        };
      },
      () => ({
        content: [use("comment", { action: "open", path: "metrics/churn.md", body: "x" }, "c")],
      }),
      () => ({ content: [use("comment", { action: "reply", thread: "another", body: "x" }, "d")] }),
      () => ({
        content: [
          use("comment", { action: "reply", body: "Filed.", kind: "request" }, "e"),
          use("comment", { action: "reply", body: "Again." }, "f"),
        ],
      }),
      end(),
    ]);
    await runTurn(turnDeps(s, model), job as AgentJob);
    expect(results(sent[1] as MessageCreateParamsNonStreaming).every((r) => r.error)).toBe(true);
    expect(results(sent[2] as MessageCreateParamsNonStreaming)[0]?.error).toBe(true);
    expect(results(sent[3] as MessageCreateParamsNonStreaming)[0]?.error).toBe(true);
    // The reply ended the turn; the second one in the same answer did not land.
    expect(sent).toHaveLength(4);
    // Nothing was written, the churn page stands, and one reply landed, marking a request.
    expect((await s.req("/files/metrics/churn.md")).status).toBe(200);
    expect((await s.req("/files/x.md")).status).toBe(404);
    const t = await thread(s, id);
    expect(t.comments).toHaveLength(2);
    expect(t.kind).toBe("request");
  });

  test("it never resolves a request", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra big job");
    const { model, sent } = scripted([
      () => ({ content: [use("comment", { action: "resolve", body: "Done", kind: "request" })] }),
      () => ({
        content: [
          use("comment", { action: "reply", body: "Marked as a request.", kind: "request" }),
        ],
      }),
      end(),
    ]);
    await runTurn(turnDeps(s, model), job as AgentJob);
    expect(results(sent[1] as MessageCreateParamsNonStreaming)[0]?.error).toBe(true);
    expect(await thread(s, id)).toMatchObject({ kind: "request", status: "open" });
  });

  test("it never resolves a thread it answered: the reply lands and the thread stays open", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra what is margin?");
    const { model, sent } = scripted([
      () => ({
        content: [use("comment", { action: "resolve", body: "Margin is revenue less cost." })],
      }),
      () => ({
        content: [use("comment", { action: "reply", body: "Margin is revenue less cost." })],
      }),
      end(),
    ]);
    const out = await runTurn(turnDeps(s, model), job as AgentJob);
    expect(out.status).toBe("replied");
    const refused = results(sent[1] as MessageCreateParamsNonStreaming)[0];
    expect(refused?.error).toBe(true);
    expect(JSON.stringify(refused)).toContain("never resolve");
    const t = await thread(s, id);
    expect(t.status).toBe("open");
    expect(t.comments).toHaveLength(2);
    expect(t.comments[1]?.body).toBe("Margin is revenue less cost.");
  });

  test("its system prompt says to reply and leave the thread open", () => {
    expect(SYSTEM_PROMPT).toContain("leave the thread open");
    expect(SYSTEM_PROMPT).toContain("You never resolve");
    expect(SYSTEM_PROMPT).not.toMatch(/`resolve` with a body/);
  });

  test("a small edit lands with a note and a link to its changes; a big one or a second page is refused", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra say quarterly, not monthly");
    const before = (await (
      await s.req("/files/metrics/margin.md", { headers: { Accept: "application/json" } })
    ).json()) as { seq: number };
    const big = Array.from({ length: 4 }, (_, i) => `Para ${i}.`).join("\n\n");
    const { model, sent } = scripted([
      () => ({
        content: [
          use("edit", {
            path: "metrics/margin.md",
            edits: [{ old: "It is reported monthly.", new: big }],
          }),
        ],
      }),
      () => ({
        content: [
          use("edit", { path: "metrics/margin.md", edits: [{ old: "monthly", new: "quarterly" }] }),
        ],
      }),
      () => ({
        content: [
          use("edit", {
            path: "metrics/churn.md",
            edits: [{ old: "customers lost", new: "customers who left" }],
          }),
        ],
      }),
      () => ({
        content: [use("comment", { action: "reply", body: "Changed monthly to quarterly." })],
      }),
      end(),
    ]);
    const out = await runTurn(turnDeps(s, model), job as AgentJob);
    expect(out).toMatchObject({ status: "replied", edited: ["metrics/margin.md"] });
    expect(results(sent[1] as MessageCreateParamsNonStreaming)[0]?.error).toBe(true);
    const ok = results(sent[2] as MessageCreateParamsNonStreaming)[0];
    expect(ok?.error).toBe(false);
    expect(ok?.text).toContain(
      `Changes: ${ORIGIN}/owner/demo/metrics/margin.md?since=${before.seq}`,
    );
    expect(results(sent[3] as MessageCreateParamsNonStreaming)[0]?.error).toBe(true);
    const page = await (await s.req("/files/metrics/margin.md")).text();
    expect(page).toContain("reported quarterly");
    expect(await (await s.req("/files/metrics/churn.md")).text()).toContain("customers lost");
    // The edit is the agent's, for the owner, with a note.
    const log = (await (await s.req("/events?limit=50")).json()) as {
      events: { op: string; actor: string; meta?: { note?: string } }[];
    };
    const edit = log.events.find((e) => e.op !== "comment" && e.actor === AGENT_ACTOR);
    expect(edit?.meta?.note).toContain("Tempra for @owner");
    expect((await thread(s, id)).comments.at(-1)?.body).toBe("Changed monthly to quarterly.");
  });

  test("for a read member it may not edit: no edit tool, and an edit call is refused", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    const friend = await s.stranger("friend@example.com");
    s.db.run(
      "INSERT INTO library_members (library, user, role, created) VALUES (?, ?, 'read', ?)",
      [LIB.id, friend.user.id, new Date().toISOString()],
    );
    const r = await post(
      s,
      "/comments",
      { path: "metrics/margin.md", body: "@tempra fix the typo" },
      friend.app,
    );
    expect(r.status).toBe(201);
    const job = jobs[0] as AgentJob;
    expect(job.asker).toBe(friend.user.id);
    const { model, sent } = scripted([
      (p) => {
        expect((p.tools ?? []).map((t) => (t as { name: string }).name)).not.toContain("edit");
        expect(String(p.messages[0]?.content)).toContain("may read and comment here but not edit");
        return {
          content: [
            use("edit", { path: "metrics/margin.md", edits: [{ old: "monthly", new: "weekly" }] }),
          ],
        };
      },
      () => ({
        content: [
          use("comment", { action: "reply", body: "Filed as a request.", kind: "request" }),
        ],
      }),
      end(),
    ]);
    await runTurn(turnDeps(s, model), job);
    expect(results(sent[1] as MessageCreateParamsNonStreaming)[0]?.error).toBe(true);
    expect(await (await s.req("/files/metrics/margin.md")).text()).toContain("monthly");
  });

  test("the tool-call cap stops a runaway turn, which still replies once", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra loop");
    const { model } = scripted(
      Array.from({ length: 30 }, () => () => ({ content: [use("browse", { path: "" })] })),
    );
    const d = { ...turnDeps(s, model), limits: { maxToolCalls: 3, maxModelCalls: 6 } };
    const out = await runTurn(d, job as AgentJob);
    expect(out).toMatchObject({ status: "replied", calls: 6, tools: 3 });
    expect((await thread(s, id)).comments.at(-1)?.body).toBe(SAY.noReply);
  });
});

describe("the daily budget", () => {
  test("list prices: input $4/M, output $20/M, cache reads $0.20/M, cache writes $5/M", () => {
    expect(costMicros({ input_tokens: 1_000_000 })).toBe(4_000_000);
    expect(costMicros({ output_tokens: 1_000_000 })).toBe(20_000_000);
    expect(costMicros({ cache_read_input_tokens: 1_000_000 })).toBe(200_000);
    expect(costMicros({ cache_creation_input_tokens: 1_000_000 })).toBe(5_000_000);
    expect(costMicros({ input_tokens: 1, output_tokens: null })).toBe(4);
  });

  test("kept per account and day in D1", async () => {
    const { d1, db } = bunD1();
    db.run(
      "INSERT INTO users (id, email, actor, handle, created) VALUES ('u', 'u@x', 'human:u', 'u', ?)",
      [new Date().toISOString()],
    );
    const b = d1AgentBudget(d1);
    await b.charge("u", "2026-10-30", 0, true);
    await b.charge("u", "2026-10-30", 1500);
    await b.charge("u", "2026-10-30", 500);
    expect(await b.spent("u", "2026-10-30")).toBe(2000);
    expect(await b.spent("u", "2026-10-31")).toBe(0);
    expect(db.query("SELECT calls, turns FROM agent_usage").get()).toEqual({ calls: 2, turns: 1 });
  });

  test("at the cap it says it is out of budget today, and calls no model", async () => {
    const s = setup();
    await seed(s);
    enable(s, 1);
    const { jobs } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra hi");
    const budget = memoryBudget();
    await budget.charge(OWNER.id, usageDay(new Date()), 1_000_000);
    const { model, sent } = scripted([end()]);
    const out = await runTurn(turnDeps(s, model, budget), job as AgentJob);
    expect(out.status).toBe("out_of_budget");
    expect(sent).toHaveLength(0);
    expect((await thread(s, id)).comments.at(-1)?.body).toBe(SAY.outOfBudget);
  });

  test("a turn that spends past the cap stops before its next model call", async () => {
    const s = setup();
    await seed(s);
    enable(s, 1);
    const { jobs } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra hi");
    const { model, sent } = scripted([
      () => ({
        usage: { input_tokens: 300_000, output_tokens: 0 },
        content: [use("browse", { path: "" })],
      }),
      () => ({ content: [use("browse", { path: "" })] }),
    ]);
    const out = await runTurn(turnDeps(s, model), job as AgentJob);
    expect(out.status).toBe("out_of_budget");
    expect(sent).toHaveLength(1);
    expect((await thread(s, id)).comments.at(-1)?.body).toBe(SAY.outOfBudget);
  });
});

describe("edit size", () => {
  test("blocks an edit touches, and blocks two versions differ by", () => {
    expect(blocksTouched([{ old: "a", new: "b" }])).toBe(1);
    expect(
      blocksTouched([
        { old: "a", new: "b\n\nc\n\nd" },
        { old: "x", new: "y" },
      ]),
    ).toBe(4);
    const a = reconcile(null, parseMarkdown("# T\n\nOne.\n\nTwo.\n"));
    const b = reconcile(a, parseMarkdown("# T\n\nOne.\n\nTwo!\n"));
    expect(changedBlocks(a, a)).toBe(0);
    expect(changedBlocks(a, b)).toBe(1);
  });
});

describe("requests and library threads", () => {
  test("a thread marked a request is a request item in work; resolving it closes it", async () => {
    const s = setup();
    await seed(s);
    const call = await mcp(s);
    const opened = await call("comment", {
      action: "open",
      path: "metrics/margin.md",
      body: "Write a pricing page.",
      kind: "request",
    });
    expect(opened.text).toContain("Opened request");
    const work = await call("work", { kind: "request" });
    expect(work.text).toContain("[request] metrics/margin.md");
    expect(work.text).toContain("asked");
    expect((await call("work", { kind: "comment" })).text).not.toContain("Write a pricing page");
    const id = /request ([0-9a-f-]{36})/.exec(opened.text)?.[1] as string;
    // Back to a plain comment with a reply; REST takes the same.
    await call("comment", { action: "reply", thread: id, body: "Not needed.", kind: "comment" });
    expect((await thread(s, id)).kind).toBe("comment");
    expect((await post(s, `/comments/${id}`, { body: "Yes it is.", kind: "request" })).status).toBe(
      200,
    );
    expect((await thread(s, id)).kind).toBe("request");
    expect((await post(s, `/comments/${id}`, { body: "x", kind: "chore" })).status).toBe(400);
    const health = (await call("start")).text;
    expect(health).toContain("requests 1");
  });

  test("a library thread over REST: no path, listed with an empty path, no quote", async () => {
    const s = setup();
    await seed(s);
    const r = await post(s, "/comments", { body: "Should we split metrics by team?" });
    expect(r.status).toBe(201);
    const { thread: t } = (await r.json()) as { thread: Thread };
    expect(t.path).toBe("");
    expect((await post(s, "/comments", { body: "x", anchor: { quote: "Margin" } })).status).toBe(
      400,
    );
    await post(s, "/comments", { path: "metrics/margin.md", body: "On a page." });
    const lib = (await (await s.app.request(`${API}/comments?path=&status=all`)).json()) as {
      threads: Thread[];
      path: string;
    };
    expect(lib.path).toBe("");
    expect(lib.threads.map((x) => x.id)).toEqual([t.id]);
    const all = (await (await s.app.request(`${API}/comments?status=all`)).json()) as {
      threads: Thread[];
    };
    expect(all.threads).toHaveLength(2);
    // Replies and resolves work as on a page.
    expect((await post(s, `/comments/${t.id}`, { body: "Yes." })).status).toBe(200);
    expect((await post(s, `/comments/${t.id}/resolve`, {})).status).toBe(200);
    expect((await thread(s, t.id)).status).toBe("resolved");
    // The ledger has the library's comments on no file.
    const ev = (await (await s.req("/events?limit=50")).json()) as {
      events: { op: string; path: string }[];
    };
    expect(ev.events.filter((e) => e.op === "comment" && e.path === "")).toHaveLength(3);
  });

  test("a library thread over MCP: comment open with no path, comments with an empty path, work", async () => {
    const s = setup();
    await seed(s);
    const call = await mcp(s);
    const opened = await call("comment", { action: "open", body: "Is this library current?" });
    expect(opened.isError).toBe(false);
    expect(opened.text).toContain("on the library");
    const listed = await call("comments", { path: "" });
    expect(listed.text).toContain("the library · open");
    expect(listed.text).toContain("Is this library current?");
    const work = await call("work", { kind: "comment" });
    expect(work.text).toContain("[comment] (the library)");
    expect(work.text).toContain("on the library");
    const id = /thread ([0-9a-f-]{36})/.exec(opened.text)?.[1] as string;
    const replied = await call("comment", { action: "reply", thread: id, body: "Yes." });
    expect(replied.text).toContain("on the library");
    // A token limited to a folder cannot comment on the library itself.
    const scoped = await mcp(s, "scoped");
    expect((await scoped("comment", { action: "open", body: "x" })).isError).toBe(true);
  });

  test("a reply on a library thread notifies with no path; a stranger cannot reach it", async () => {
    const s = setup();
    await seed(s);
    const r = await post(s, "/comments", { body: "Library question" });
    const { thread: t } = (await r.json()) as { thread: Thread };
    const friend = await s.stranger("friend@example.com");
    s.db.run(
      "INSERT INTO library_members (library, user, role, created) VALUES (?, ?, 'write', ?)",
      [LIB.id, friend.user.id, new Date().toISOString()],
    );
    expect((await post(s, `/comments/${t.id}`, { body: "An answer." }, friend.app)).status).toBe(
      200,
    );
    const inbox = await s.notifications.inbox(OWNER.id);
    expect(inbox.items.find((i) => i.kind === "reply")).toMatchObject({ path: "", thread: t.id });
    const other = await s.stranger();
    expect((await other.app.request(`${API}/comments?path=`)).status).toBe(404);
    expect((await post(s, "/comments", { body: "x" }, other.app)).status).toBe(404);
  });
});

describe("the pages a reply cites (TEMPRA-224)", () => {
  test("the library's page URLs, by path, once each; nothing else", () => {
    const lib = "https://app.tempra.dev/ann/notes";
    expect(
      citedPaths(
        `See ${lib}/metrics/margin.md and (${lib}/a%20b.md). Again ${lib}/metrics/margin.md?since=4, ` +
          `not ${lib}/-/activity, https://app.tempra.dev/ann/other/x.md or https://example.com/y.md.`,
        lib,
      ),
    ).toEqual(["metrics/margin.md", "a b.md"]);
    expect(citedPaths("No links here.", lib)).toEqual([]);
    // By path, as it now cites them (TEMPRA-225); not a path inside a URL.
    expect(
      citedPaths("See /datasets/ntsb-findings.md and https://example.com/z/y.md.", lib),
    ).toEqual(["datasets/ntsb-findings.md"]);
  });
});

describe("reply length (TEMPRA-225)", () => {
  test("a reply over the cap is sent back once to shorten; the shorter one lands", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra what is margin?");
    const long = Array.from({ length: REPLY_MAX_WORDS + 10 }, () => "word").join(" ");
    const { model, sent } = scripted([
      () => ({ content: [use("comment", { action: "reply", thread: id, body: long })] }),
      () => ({
        content: [
          use("comment", {
            action: "reply",
            thread: id,
            body: "Revenue minus cost: /metrics/margin.md",
          }),
        ],
      }),
      end(),
    ]);
    await runTurn(turnDeps(s, model), job as AgentJob);
    const t = await thread(s, id);
    expect(t.comments).toHaveLength(2);
    expect(t.comments[1]?.body).toBe("Revenue minus cost: /metrics/margin.md");
    // The model was told why.
    expect(JSON.stringify(sent[1]?.messages.at(-1))).toContain(`at most ${REPLY_MAX_WORDS} words`);
  });

  test("a second long reply is posted rather than lose the answer", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra what is margin?");
    const long = Array.from({ length: REPLY_MAX_WORDS + 10 }, () => "word").join(" ");
    const reply = () => ({
      content: [use("comment", { action: "reply", thread: id, body: long })],
    });
    const { model } = scripted([reply, reply, end()]);
    await runTurn(turnDeps(s, model), job as AgentJob);
    expect((await thread(s, id)).comments.at(-1)?.body).toBe(long);
  });
});

describe("what a reply costs (TEMPRA-231)", () => {
  test("its tools are only what answering needs, read members' fewer still", () => {
    for (const gone of ["start", "work", "log", "sources"]) {
      expect(agentTools(true)).not.toContain(gone);
    }
    expect(agentTools(false)).toEqual(agentTools(true).filter((t) => t !== "edit"));
  });

  test("the server's instructions as far as they apply to a reply, and no further", () => {
    const kept = serverInstructions();
    // Each section it keeps is in the server's instructions as they send it, by name (TEMPRA-314):
    // instructionsSection throws on a missing section, and the markers never reach agents.
    for (const name of SERVER_SECTIONS) expect(INSTRUCTIONS).toContain(instructionsSection(name));
    expect(INSTRUCTIONS).not.toContain("<!--");
    expect(kept).toContain("This server holds Tempra libraries");
    expect(kept).toContain("Prefer `edit`");
    // Not what it never does, or does the other way.
    expect(kept).not.toContain("Call `start` first");
    expect(kept).not.toContain("link it by its URL");
    expect(kept).not.toContain("resolve what you fixed");
    expect(kept).not.toContain("vega-lite");
    expect(kept.length).toBeLessThan(INSTRUCTIONS.length / 5);
    expect(SYSTEM_PROMPT).toContain(kept);
    expect(SYSTEM_PROMPT).not.toContain(INSTRUCTIONS);
  });

  test("a long page is an excerpt: its head, the quoted part, and a note", () => {
    expect(pageExcerpt("short page", null, 100)).toBe("short page");
    const long = `---\ntitle: T\n---\n# T\n\n${"Filler sentence here. ".repeat(2000)}The quoted part.\n\n${"More. ".repeat(500)}`;
    const head = pageExcerpt(long, null, 3000);
    expect(head.startsWith("---\ntitle: T")).toBe(true);
    expect(head).toContain(`the page is ${long.length} characters`);
    expect(head.length).toBeLessThan(3200);
    const quoted = pageExcerpt(long, "The quoted part.", 3000);
    expect(quoted.startsWith("---\ntitle: T")).toBe(true);
    expect(quoted).toContain("The quoted part.");
    expect(quoted).toContain("`read` or `grep` it for the rest");
    expect(quoted.length).toBeLessThan(3200);
    // A quote not in the markdown as written: the head.
    expect(pageExcerpt(long, "nowhere", 3000)).toBe(head);
  });

  test("every call reads the one before it from the cache: same tools and system, history only appended", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra what is margin?");
    const { model, sent } = scripted([
      () => ({ content: [use("search", { query: "margin" })] }),
      () => ({ content: [use("read", { path: "metrics/churn.md" })] }),
      () => ({
        content: [use("comment", { action: "reply", thread: id, body: "Revenue less cost." })],
      }),
    ]);
    await runTurn(turnDeps(s, model), job as AgentJob);
    expect(sent).toHaveLength(3);
    for (let i = 1; i < sent.length; i++) {
      const a = sent[i - 1] as MessageCreateParamsNonStreaming;
      const b = sent[i] as MessageCreateParamsNonStreaming;
      expect(b.tools).toEqual(a.tools);
      expect(b.system).toEqual(a.system);
      expect((b as unknown as { cache_control: unknown }).cache_control).toEqual({
        type: "ephemeral",
      });
      expect(b.messages.slice(0, a.messages.length)).toEqual(a.messages);
      expect(b.messages.length).toBe(a.messages.length + 2);
    }
  });

  test("the page in the prompt and each tool result are capped", async () => {
    const s = setup();
    const huge = `# Margin\n\n${Array.from({ length: 400 }, (_, i) => `Paragraph ${i} about margin and how it is computed.`).join("\n\n")}\n`;
    for (const path of ["metrics/margin.md", "metrics/long.md"]) {
      const r = await s.req(`/files/${path}`, {
        method: "PUT",
        headers: { "Content-Type": "text/markdown" },
        body: doc("Margin", huge),
      });
      expect(r.status).toBeLessThan(300);
    }
    enable(s);
    const { jobs } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra what is margin?");
    const { model, sent } = scripted([
      () => ({ content: [use("read", { path: "metrics/long.md" })] }),
      () => ({
        content: [use("comment", { action: "reply", thread: id, body: "Revenue less cost." })],
      }),
    ]);
    const d = { ...turnDeps(s, model), limits: { pageChars: 4000, toolChars: 5000 } };
    await runTurn(d, job as AgentJob);
    const prompt = String(sent[0]?.messages[0]?.content);
    expect(prompt).toContain("[An excerpt: the page is");
    expect(prompt.length).toBeLessThan(6000);
    const read = results(sent[1] as MessageCreateParamsNonStreaming)[0];
    expect(read?.text).toContain("[cut at 5000 of");
    expect(read?.text.length).toBeLessThan(5200);
  });

  test("each model call logs its tokens and cost, and the turn sums them", async () => {
    const s = setup();
    await seed(s);
    enable(s);
    const { jobs } = wire(s);
    const { id, job } = await ask(s, jobs, "@tempra what is margin?");
    const usage = {
      input_tokens: 30,
      output_tokens: 120,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 9000,
    };
    const asUsage = (u: typeof usage) => u as unknown as BetaMessage["usage"];
    const { model } = scripted([
      () => ({ usage: asUsage(usage), content: [use("search", { query: "margin" })] }),
      () => ({
        usage: asUsage({
          ...usage,
          cache_read_input_tokens: 9000,
          cache_creation_input_tokens: 500,
        }),
        content: [use("comment", { action: "reply", thread: id, body: "Revenue less cost." })],
      }),
    ]);
    const logged: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logged.push(String(a[0]));
    });
    try {
      const out = await runTurn(turnDeps(s, model), job as AgentJob);
      expect(out).toMatchObject({
        status: "replied",
        calls: 2,
        tokens: { input: 60, output: 240, cache_read: 9000, cache_write: 9500 },
      });
      const calls = logged.flatMap((l) => {
        try {
          const j = JSON.parse(l) as { agent_call?: string };
          return j.agent_call ? [j] : [];
        } catch {
          return [];
        }
      });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        agent_call: id,
        n: 1,
        stop: "tool_use",
        cache_write: 9000,
        micro_usd: costMicros(usage),
      });
    } finally {
      log.mockRestore();
    }
  });
});
