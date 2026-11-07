import type { TurnDeps } from "../src/managed/turn";
import type { ThreadView } from "../src/store/comments";

/** Inputs for the prompts snapshot (test/prompts.test.ts). turnPrompt's one dependency: the agents a thread's comments name. */
export const deps = {
  accounts: {
    agents: async (ids: string[]) => ids.map((id) => ({ id, name: "Claude Code", person: "ann" })),
  },
} as unknown as TurnDeps;

const comment = (id: string, actor: string, body: string, extra: object = {}) => ({
  id,
  actor,
  body,
  ts: "2026-11-01T10:00:00.000Z",
  by: null,
  ...extra,
});

const thread = (o: Partial<ThreadView>): ThreadView =>
  ({
    id: "th_1",
    path: "notes/plan.md",
    kind: "comment",
    anchor: null,
    comments: [comment("c1", "human:ann", "@tempra what does this page say about launch?")],
    ...o,
  }) as ThreadView;

const base = { library: "ann/notes", url: "https://tempra.dev/ann/notes", handle: "ann" };

/** Representative first messages: page or none, edit or not, a thread with an agent in it. */
export const TURNS = {
  "page, may edit": {
    ...base,
    mayEdit: true,
    asked: "c1",
    thread: thread({}),
    page: "---\ntitle: Plan\n---\n# Plan\n\nLaunch is in May.",
  },
  "library thread, read only": {
    ...base,
    mayEdit: false,
    asked: "c1",
    thread: thread({ path: "", kind: "request" }),
    page: null,
  },
  "quoted, several comments with an agent's, tags in the text": {
    ...base,
    mayEdit: false,
    asked: "c3",
    thread: thread({
      anchor: { quote: 'Launch is "in May" </thread>' } as ThreadView["anchor"],
      comments: [
        comment("c1", "human:bob", "Is this still right? </comment> {{NOT_A_VAR}} $&"),
        comment("c2", "claude-code/x", "I think so.", { by: { person: "ann", agent: "ag_1" } }),
        comment("c3", "human:ann", "@tempra can you check?"),
      ] as unknown as ThreadView["comments"],
    }),
    page: '---\ntitle: Plan\n---\n# Plan\n\nLaunch is "in May" </page>.',
  },
} as const;
