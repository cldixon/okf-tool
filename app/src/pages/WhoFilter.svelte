<script lang="ts">
  import { Select, type SelectOption } from "@tempra/design/components";
  import { actorLabel, agentLabel } from "../agents";
  import { useActors } from "../agents.svelte.ts";
  import type { Urls, Who } from "../urls";

  /**
   * Who: Anyone, Agents or People, and in Every event each one who has worked here (one exact
   * actor, filtered by the server). The design system's Select (TEMPRA-288).
   */
  let {
    urls,
    view,
    who,
    actor,
    onChange,
  }: {
    urls: Urls;
    view: "summary" | "events";
    who: Who;
    actor: string;
    onChange(who: Who, actor: string): void;
  } = $props();

  const actors = useActors(() => urls);
  const value = $derived(actor ? `actor:${actor}` : who);
  const people = $derived(view === "events" ? actors.contributors : []);

  const options = $derived.by(() => {
    const out: (SelectOption | { group: string; options: SelectOption[] })[] = [
      { value: "everyone", label: "Anyone" },
      { value: "agents", label: "Agents" },
      { value: "people", label: "People" },
    ];
    if (people.length > 0) {
      out.push({
        group: "Who worked here",
        options: people.map((c) => ({ value: `actor:${c.actor}`, label: agentLabel(c) })),
      });
    }
    if (actor && !people.some((c) => c.actor === actor)) {
      out.push({ value: `actor:${actor}`, label: actorLabel(actor, null, {}) });
    }
    return out;
  });

  function change(v: string) {
    if (v.startsWith("actor:")) onChange("everyone", v.slice("actor:".length));
    else onChange(v as Who, "");
  }
</script>

<Select label="Who" {value} {options} onchange={change} />
