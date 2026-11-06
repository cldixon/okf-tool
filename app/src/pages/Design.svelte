<script lang="ts">
  import {
    AvatarMark,
    Badge,
    Button,
    ChangeRow,
    Chip,
    CommentMark,
    ComposeDialog,
    Dialog,
    Disclosure,
    Field,
    type Glyph,
    ICONS,
    Icon,
    IconButton,
    Mark,
    Menu,
    Notice,
    PanelHead,
    PillButton,
    SearchButton,
    SearchField,
    Segmented,
    Select,
    SplitButton,
    TextInput,
    Tile,
    ToolPill,
  } from "@tempra/design/components";

  /**
   * The design components' catalogue (TEMPRA-252; `/_dev/design`, which the Worker serves in local
   * dev only): every component of @tempra/design/components and its variants, in light and in dark
   * side by side (`.theme-light`, `.theme-dark`), to try a change to the package's CSS in the app.
   * Hover and focus are the pointer's and the keyboard's to show; disabled is drawn where it applies.
   */
  // The title set here, not with useTitle: importing ui.svelte.ts from this chunk splits it out of
  // the entry into a shared chunk every page would then fetch.
  $effect(() => {
    document.title = "Components · Tempra";
  });

  type Theme = "light" | "dark";
  const GLYPHS = Object.keys(ICONS) as Glyph[];
  const state = $state({
    light: {
      tab: "open",
      text: "",
      search: "",
      dialog: false,
      compose: false,
      clicks: 0,
      who: "everyone",
      tip: null as string | null,
      more: false,
    },
    dark: {
      tab: "open",
      text: "",
      search: "",
      dialog: false,
      compose: false,
      clicks: 0,
      who: "everyone",
      tip: null as string | null,
      more: false,
    },
  });
  /** A press's tip (TEMPRA-312), shown 1.5 s as Copy page's: Copied, or Couldn't copy. */
  function showTip(theme: Theme, text: string) {
    state[theme].tip = text;
    setTimeout(() => {
      if (state[theme].tip === text) state[theme].tip = null;
    }, 1500);
  }
</script>

{#snippet item(name: string, body: import("svelte").Snippet)}
  <section class="catalogue-item" aria-label={name}>
    <h2>{name}</h2>
    <div class="catalogue-row">{@render body()}</div>
  </section>
{/snippet}

{#snippet catalogue(theme: Theme)}
  {@const s = state[theme]}
  {#snippet icons()}{#each GLYPHS as g (g)}<span title={g}><Icon name={g} /></span>{/each}{/snippet}
  {@render item("Icon", icons)}

  {#snippet buttons()}
    <Button onclick={() => s.clicks++}>Default</Button>
    <Button variant="primary" onclick={() => s.clicks++}>Primary</Button>
    <Button variant="ghost" onclick={() => s.clicks++}>Ghost</Button>
    <Button disabled>Disabled</Button>
    <Button variant="primary" disabled>Primary disabled</Button>
    <span class="small muted">{s.clicks} clicks</span>
  {/snippet}
  {@render item("Button", buttons)}

  {#snippet pills()}
    <PillButton icon="previous" label="Back to page" />
    <PillButton icon="download" label="Download" href="#download" />
    <PillButton icon="plus" label="New library" class="tool-pill primary" />
    <PillButton label="No glyph" />
  {/snippet}
  {@render item("PillButton", pills)}

  {#snippet toolPills()}
    <ToolPill label="Tool pill" />
    <ToolPill label="As a link" href="#tool" />
  {/snippet}
  {@render item("ToolPill", toolPills)}

  {#snippet iconButtons()}
    <IconButton icon="more" label="More" />
    <IconButton icon="sidebar" label="Pressed" pressed />
    <IconButton icon="close" label="Touch" touch />
    <IconButton icon="copy" label="Disabled" disabled />
    <IconButton variant="outlined" icon="info" label="Outlined" />
    <IconButton variant="outlined" icon="info" label="Outlined, pressed" pressed />
    <IconButton variant="outlined" icon="comments" label="Outlined, with a count" count={2} />
    <IconButton variant="outlined" icon="info" label="Outlined, with the dot" dot />
  {/snippet}
  {@render item("IconButton", iconButtons)}

  {#snippet splitButtons()}
    <SplitButton
      icon="copy"
      label="Copy page"
      menuLabel="More copy options"
      tip={s.tip === "Copied" ? s.tip : null}
      onclick={() => showTip(theme, "Copied")}
    >
      {#snippet children()}
        <a class="menu-item" href="#m"><Icon name="markdown" />View Markdown</a>
        <a class="menu-item" href="#d"><Icon name="download" />Download .md</a>
      {/snippet}
    </SplitButton>
    <IconButton
      variant="outlined"
      icon="copy"
      label="Copy, failing"
      tip={s.tip === "Couldn't copy" ? s.tip : null}
      onclick={() => showTip(theme, "Couldn't copy")}
    />
  {/snippet}
  {@render item("SplitButton", splitButtons)}

  {#snippet disclosures()}
    <Disclosure label="Earlier versions" count={7} bind:open={s.more} />
    <Disclosure label="Open" count={3} open />
    <Disclosure label="No count" />
  {/snippet}
  {@render item("Disclosure", disclosures)}

  {#snippet search()}<SearchButton shortcut="Ctrl K" />{/snippet}
  {@render item("SearchButton", search)}

  {#snippet fields()}
    <Field label="Name" hint="What people see">
      <TextInput bind:value={s.text} placeholder="Team notes" />
    </Field>
    <Field label="Disabled">
      <TextInput value="Read only" disabled />
    </Field>
  {/snippet}
  {@render item("Field and TextInput", fields)}

  {#snippet searchField()}<SearchField bind:value={s.search} label="Search pages" placeholder="Search…" />{/snippet}
  {@render item("SearchField", searchField)}

  {#snippet chips()}<Chip>Draft</Chip><Chip tone="warn">expired</Chip><Chip tone="bad">revoked</Chip>{/snippet}
  {@render item("Chip", chips)}

  {#snippet segmented()}
    <Segmented
      label="Threads"
      options={[
        { value: "open", label: "Open" },
        { value: "resolved", label: "Resolved 3" },
      ]}
      bind:value={s.tab}
    />
  {/snippet}
  {@render item("Segmented", segmented)}

  {#snippet selects()}
    <Select
      label="Who"
      bind:value={s.who}
      options={[
        { value: "everyone", label: "Anyone" },
        { value: "agents", label: "Agents" },
        { group: "Who worked here", options: [{ value: "actor:x", label: "Claude Code for @dev" }] },
      ]}
    />
    <Select variant="plain" label="Access" value="read" options={[{ value: "read", label: "Read and comment" }]} />
    <Select label="Disabled" value="a" disabled options={[{ value: "a", label: "Disabled" }]} />
  {/snippet}
  {@render item("Select", selects)}

  {#snippet changeRows()}
    <div class="activity-day">
      <ChangeRow>
        {#snippet lead()}<AvatarMark kind="agent" initials="C" />{/snippet}
        Claude Code for @dev edited <a href="#change-row">Revenue</a>
        {#snippet detail()}<q class="entry-note">Tightened the definition</q>{/snippet}
        {#snippet when()}14 min ago{/snippet}
      </ChangeRow>
      <ChangeRow continued>
        {#snippet lead()}<AvatarMark kind="agent" initials="C" />{/snippet}
        Added <a href="#change-row">Gross margin</a>
        {#snippet when()}20 min ago{/snippet}
      </ChangeRow>
      <ChangeRow live>
        {#snippet lead()}<AvatarMark kind="agent" initials="C" />{/snippet}
        Claude Code for @dev is editing <a href="#change-row">Revenue</a>
        {#snippet when()}<span class="entry-now"><span class="change-dot live" aria-hidden="true"></span>now</span>{/snippet}
      </ChangeRow>
    </div>
  {/snippet}
  {@render item("ChangeRow", changeRows)}

  {#snippet notices()}
    <Notice>Could not save: the server answered 500.</Notice>
    <Notice tone="ok">Saved.</Notice>
  {/snippet}
  {@render item("Notice", notices)}

  {#snippet avatars()}
    <AvatarMark initials="AN" />
    <AvatarMark kind="agent" initials="C" />
    <AvatarMark kind="tempra" initials="T" />
    <AvatarMark initials="AN" size="small" />
  {/snippet}
  {@render item("AvatarMark", avatars)}

  {#snippet tiles()}
    <Tile letter="D" size="small" />
    <Tile letter="D" />
    <Tile letter="D" size="large" />
    <Tile letter="S" shared />
  {/snippet}
  {@render item("Tile", tiles)}

  {#snippet tempraMarks()}
    <Mark small label="Tempra" />
    <Mark label="Tempra" />
    <span class="brand-lockup mark-lockup"><Mark small /><span class="brand-name">tempra-dev</span></span>
  {/snippet}
  {@render item("Mark", tempraMarks)}

  {#snippet badges()}
    <Badge count={3} />
    <Badge count={120} />
  {/snippet}
  {@render item("Badge", badges)}

  {#snippet menu()}
    <Menu name="Open the menu" buttonClass="icon-button">
      {#snippet label()}<Icon name="more" />{/snippet}
      {#snippet children()}
        <a class="menu-item" href="#a"><Icon name="copy" />Copy page</a>
        <a class="menu-item" href="#b"><Icon name="markdown" />View Markdown</a>
        <hr />
        <a class="menu-item" href="#c"><Icon name="download" />Download .md</a>
      {/snippet}
    </Menu>
  {/snippet}
  {@render item("Menu", menu)}

  {#snippet dialogs()}
    <Button onclick={() => (s.dialog = true)}>Open Dialog</Button>
    <Button onclick={() => (s.compose = true)}>Open ComposeDialog</Button>
    <Dialog title="A dialog" open={s.dialog} onClose={() => (s.dialog = false)}>
      <p>What the dialog says.</p>
    </Dialog>
    <ComposeDialog
      open={s.compose}
      onClose={() => (s.compose = false)}
      title="New library"
      action="Create library"
      error="An error under the fields."
      onSubmit={(e) => {
        e.preventDefault();
        s.compose = false;
      }}
    >
      {#snippet context()}@dev{/snippet}
      <input class="compose-title" aria-label="Name" placeholder="Library name" />
    </ComposeDialog>
  {/snippet}
  {@render item("Dialog and ComposeDialog", dialogs)}

  {#snippet panelHead()}<PanelHead title="Comments" count="3 open" onClose={() => {}} />{/snippet}
  {@render item("PanelHead", panelHead)}

  {#snippet marks()}<CommentMark count={1} /><CommentMark count={12} />{/snippet}
  {@render item("CommentMark", marks)}
{/snippet}

<main class="catalogue">
  <h1>Components</h1>
  <p class="muted">@tempra/design/components, in light and in dark. Local dev only.</p>
  <div class="catalogue-themes">
    <div class="catalogue-theme theme-light" role="region" aria-label="Light">{@render catalogue("light")}</div>
    <div class="catalogue-theme theme-dark" role="region" aria-label="Dark">{@render catalogue("dark")}</div>
  </div>
</main>
