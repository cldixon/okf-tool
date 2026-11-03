<script lang="ts">
  import {
    AvatarMark,
    Badge,
    Button,
    Chip,
    CommentMark,
    ComposeDialog,
    Dialog,
    Field,
    type Glyph,
    ICONS,
    Icon,
    IconButton,
    Menu,
    Notice,
    PanelHead,
    PillButton,
    SearchButton,
    SearchField,
    Segmented,
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
    light: { tab: "open", text: "", search: "", dialog: false, compose: false, clicks: 0 },
    dark: { tab: "open", text: "", search: "", dialog: false, compose: false, clicks: 0 },
  });
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
  {/snippet}
  {@render item("IconButton", iconButtons)}

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
        <a class="menu-item" href="#b"><Icon name="history" />History</a>
        <hr />
        <a class="menu-item" href="#c"><Icon name="link" />Copy link</a>
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
