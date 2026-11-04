import type { ActedBy, ActorView } from "../agents";

/** Names an actor (an agent for its person, the signed-in person as "You"). */
export type Namer = (actor: string, by?: ActedBy | null) => ActorView;

/** How long after an agent's write the byline says it is editing now. */
export const EDITING_MS = 60_000;
