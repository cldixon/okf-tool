import type { ActedBy, ActorView } from "../agents";

/** Names an actor (an agent for its person, the signed-in person as "You"). */
export type Namer = (actor: string, by?: ActedBy | null) => ActorView;
