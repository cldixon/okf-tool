import { heardWrites, isLive, LIVE_MS, type LiveWrite } from "./activity";
import { isAgentChange } from "./changes";
import type { FeedEvent } from "./live";
import { useNow } from "./ui.svelte.ts";

/**
 * Agents' writes as they arrive on the feed (tempra-dev: app/live): each agent's last one, read
 * as writing now for LIVE_MS (By page's Working now, Option B: several agents at once), and each
 * event's arrival by seq (Every event's pulsing rows). `heard` takes a batch from useFeed, `reset`
 * a rollback. Its clock (useNow) ticks every 5 s once anything has been heard, else every 30 s,
 * so the dots stop when the writes do.
 */
export function useLiveWrites() {
  let writes = $state.raw(new Map<string, LiveWrite>());
  let seqs = $state.raw(new Map<number, number>());
  const clock = useNow(() => (writes.size > 0 || seqs.size > 0 ? 5000 : 30_000));
  return {
    /** The clock relative times are read against. */
    get now() {
      return clock.current;
    },
    /** Every agent writing now (its last write under LIVE_MS old), in no order: see workingNow. */
    get writing() {
      return [...writes.values()].filter((w) => isLive(w, clock.current));
    },
    /** Whether the event with this seq arrived recently enough to pulse. */
    pulses(seq: number) {
      return (seqs.get(seq) ?? 0) > clock.current - LIVE_MS;
    },
    heard(events: FeedEvent[]) {
      const at = Date.now();
      if (events.some(isAgentChange)) writes = heardWrites(writes, events, at);
      const fromAgents = events.filter((e) => !e.actor.startsWith("human:") || e.by?.agent);
      if (fromAgents.length > 0) {
        const pulsing = new Map(seqs);
        for (const e of fromAgents) pulsing.set(e.seq, at);
        seqs = pulsing;
      }
    },
    reset() {
      writes = new Map();
      seqs = new Map();
    },
  };
}
