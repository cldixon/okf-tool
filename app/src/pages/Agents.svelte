<script lang="ts">
  import { Button, Chip, ComposeDialog, Dialog } from "@tempra/design/components";
  import { untrack } from "svelte";
  import { api, field, post } from "../api";
  import ConfirmDialog from "../ConfirmDialog.svelte";
  import CopyField from "../CopyField.svelte";
  import { useConfirm } from "../confirm.svelte.ts";
  import { useAction, useLoad } from "../load.svelte.ts";
  import { isShared, LIBRARY_NAMES_URL, type ReachableLibrary } from "../role";
  import Status from "../Status.svelte";
  import { day, type Me } from "../ui";
  import { useNow, useTitle } from "../ui.svelte.ts";
  import { type AppGrant, chosenLibrary, liveToken, type Minted, type TokenRow } from "./account";
  import ConnectSteps from "./ConnectSteps.svelte";

  /**
   * /agents: how agents get into the person's libraries, in one place (2026-10-23; it replaced
   * Connect an agent, Tokens and Connected apps): the steps to connect, then everything that can act
   * in their libraries, apps connected over OAuth and tokens alike, each with Revoke; New token
   * opens the compose dialog (`?new=token`, with `?library=` picking its library).
   */
  let props: { me: Me | null; newToken: boolean; library: string | null } = $props();
  useTitle(() => "Agents");
  const loaded = useLoad(
    () => "agents",
    async () => {
      const [a, t, l] = await Promise.all([
        api<{ apps: AppGrant[] }>("/api/v1/apps"),
        api<{ tokens: TokenRow[] }>("/api/v1/tokens"),
        api<{ libraries: ReachableLibrary[] }>(LIBRARY_NAMES_URL),
      ]);
      // An own library by its slug; one shared with the person as owner/slug, the name the
      // server mints on (a member's token is held to their role there).
      const names = l.libraries.map((x) => (isShared(x) ? `${x.owner}/${x.slug}` : x.slug));
      return { apps: a.apps, tokens: t.tokens, libraries: names };
    },
  );
  let creating = $state(untrack(() => props.newToken));
  let minted = $state.raw<Minted | null>(null);
  const action = useAction();
  let notice = $state<string | null>(null);
  const c = useConfirm();
  /** The clock tokens are checked against, so one turns "expired" while the page is open. */
  const now = useNow();
  /** The token a confirmation is about, for its body. */
  let revoking = $state.raw<TokenRow | null>(null);

  const revokeApp = (a: AppGrant) =>
    c.confirm({
      title: `Revoke ${a.app}?`,
      body: appBody,
      action: "Revoke",
      run: () =>
        action.run(async () => {
          await api(`/api/v1/apps/${encodeURIComponent(a.id)}`, { method: "DELETE" });
          notice = `${a.app} revoked.`;
          loaded.reload();
        }),
    });
  const revokeToken = (t: TokenRow) => {
    revoking = t;
    c.confirm({
      title: "Revoke this token?",
      body: tokenBody,
      action: "Revoke",
      run: () =>
        action.run(async () => {
          await api(`/api/v1/tokens/${encodeURIComponent(t.id)}`, { method: "DELETE" });
          notice = `${t.actor} revoked.`;
          loaded.reload();
        }),
    });
  };

  /**
   * New token, as a compose dialog (spec: Auth, identity and actors): its name, which its changes
   * show as, then the library, access, directory, expiry and tools as small fields.
   */
  const tokenAction = useAction();
  function create(e: SubmitEvent & { currentTarget: HTMLFormElement }) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = (k: string) => field(form, k);
    void tokenAction.run(async () => {
      const res = await post<Minted>("/api/v1/tokens", {
        library: f("library"),
        actor: f("actor"),
        scope: f("scope") === "read" ? "read" : "write",
        prefix: f("prefix") || null,
        expires: f("expires") || null,
        mcp_tiers: f("tiers") === "files" ? "files" : "all",
      });
      creating = false;
      minted = res;
      loaded.reload();
    });
  }

  /** The new token's secret, shown once, with the command that uses it. */
  const command = (m: Minted) =>
    `claude mcp add --transport http ${m.library} ${location.origin}/mcp --header "Authorization: Bearer ${m.secret}"`;
</script>

{#snippet appBody()}
  <p>Its agents are cut off at once. To use it again, connect it again.</p>
{/snippet}

{#snippet tokenBody()}
  <p>Whatever uses it as {revoking?.actor} is cut off at once. This cannot be undone.</p>
{/snippet}

<h1>Agents</h1>
<ConfirmDialog asking={c} />
<p>One connection can reach all your libraries, or the ones you select.</p>
<ConnectSteps onNewToken={() => (creating = true)} />
<h2>Connected</h2>
{#if notice}<div class="notice ok">{notice}</div>{/if}
{#if action.error}<div class="notice">{action.error}</div>{/if}
<Status loaded={loaded.current}>
  {#snippet children({ apps, tokens, libraries })}
    {@const live = (t: TokenRow) => liveToken(t, now.current)}
    <!-- What can act now first (apps, then tokens), then the tokens that no longer can. -->
    {@const ordered = [...tokens.filter(live), ...tokens.filter((t) => !live(t))]}
    {#if apps.length === 0 && tokens.length === 0}
      <p class="muted">Nothing connected yet.</p>
    {:else}
      <div class="table-wrap">
        <table class="list">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Libraries</th>
              <th>Access</th>
              <th>
                <span class="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {#each apps as a (`app ${a.id}`)}
              <tr>
                <td class="name"
                  ><strong>{a.app}</strong><div class="small muted">App · connected {day(a.created)}</div></td
                >
                <td
                  >{a.libraries === "all"
                    ? "All libraries"
                    : a.libraries.length > 0
                      ? a.libraries.join(", ")
                      : "None (deleted)"}{#if a.prefix}<div class="small muted">under {a.prefix}/</div>{/if}</td
                >
                <td
                  >{a.access === "write" ? "Read and write" : "Read only"}{#if a.tiers === "files"}<div class="small muted">file tools only</div>{/if}{#if a.create_libraries}<div class="small muted">can create libraries</div>{/if}</td
                >
                <td>
                  <Button disabled={action.busy} onclick={() => revokeApp(a)}>Revoke…</Button>
                </td>
              </tr>
            {/each}
            {#each ordered as t (`token ${t.id}`)}
              <tr>
                <td class="name"
                  ><strong>{t.actor}</strong><div class="small muted">
                    Token · {#if t.revoked}<Chip tone="bad">revoked</Chip>{:else if !live(t)}<Chip tone="warn"
                        >expired</Chip
                      >{:else if t.expires}{`expires ${day(t.expires)}`}{:else}no expiry{/if}
                  </div></td
                >
                <td>{t.library}{#if t.prefix}<div class="small muted">under {t.prefix}/</div>{/if}</td>
                <td
                  >{t.scope === "read" ? "Read only" : "Read and write"}{#if t.mcp_tiers === "files"}<div class="small muted">file tools only</div>{/if}</td
                >
                <td>
                  {#if live(t)}
                    <Button disabled={action.busy} onclick={() => revokeToken(t)}>Revoke…</Button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    {@const chosen = chosenLibrary(libraries, props.library, props.me)}
    <ComposeDialog
      open={creating}
      onClose={() => (creating = false)}
      title="New token"
      action="Create token"
      busy={tokenAction.busy || libraries.length === 0}
      error={libraries.length === 0 ? "Create a library first." : tokenAction.error}
      onSubmit={create}
    >
      {#snippet context()}{props.me ? `@${props.me.handle}` : "You"}{/snippet}
      {#snippet fields()}
        <label class="compose-field">
          <span>Library</span>
          <select name="library">
            {#each libraries as l (l)}
              <option value={l} selected={l === chosen}>{l}</option>
            {/each}
          </select>
        </label>
        <label class="compose-field">
          <span>Access</span>
          <select name="scope">
            <option value="write" selected>Read and write</option>
            <option value="read">Read only</option>
          </select>
        </label>
        <label class="compose-field">
          <span>Directory</span>
          <input type="text" name="prefix" placeholder="whole library" />
        </label>
        <label class="compose-field">
          <span>Expires</span>
          <input type="date" name="expires" />
        </label>
        <label class="compose-field">
          <span>Tools</span>
          <select name="tiers">
            <option value="all" selected>All MCP tools</option>
            <option value="files">File tools only</option>
          </select>
        </label>
      {/snippet}
      <input
        class="compose-title"
        name="actor"
        type="text"
        aria-label="Name"
        aria-describedby="token-name-hint"
        placeholder="Name, like claude-code/laptop"
        required
        autocomplete="off"
        spellcheck="false"
        data-autofocus="true"
      />
      <p id="token-name-hint" class="compose-hint">What its changes show as: the agent, then where it runs.</p>
    </ComposeDialog>
  {/snippet}
</Status>
<Dialog title="Token created" open={minted !== null} onClose={() => (minted = null)} wide>
  {#if minted}
    <p>
      For <strong>{minted.actor}</strong> on <strong>{minted.library}</strong>. Shown once: copy it now.
    </p>
    <p>
      <CopyField value={minted.secret} label="the token" id="token-secret" />
    </p>
    <p class="small muted">Claude Code:</p>
    <p>
      <CopyField value={command(minted)} label="the Claude Code command" />
    </p>
    <p class="actions">
      <Button variant="primary" onclick={() => (minted = null)}>Done</Button>
    </p>
  {/if}
</Dialog>
