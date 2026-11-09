<script lang="ts">
  import { Button, Field } from "@tempra/design/components";
  import { untrack } from "svelte";
  import { api, field, post } from "../api";
  import ConfirmDialog from "../ConfirmDialog.svelte";
  import { useConfirm } from "../confirm.svelte.ts";
  import { useAction, useLoad } from "../load.svelte.ts";
  import Moment from "../Moment.svelte";
  import Status from "../Status.svelte";
  import ThemeChoice from "../ThemeChoice.svelte";
  import { useTheme } from "../theme.svelte.ts";
  import { day, localTime } from "../ui";
  import { useScrollToHash, useTitle } from "../ui.svelte.ts";
  import { type AccountData, DONE, LEGAL, monthLines } from "./account";
  import EmailSwitch from "./EmailSwitch.svelte";

  /**
   * The account: email, name (TEMPRA-54), handle, limits, appearance, email settings
   * (TEMPRA-189), sessions, deleting it (v2 spec: Accounts).
   */
  let { done }: { done: string | null } = $props();
  useTitle(() => "Account");
  const loaded = useLoad(
    () => "account",
    () => api<AccountData>("/api/v1/account"),
  );
  const action = useAction();
  // Mail's "Email settings" link, and /notifications, land on the Email section (#email).
  useScrollToHash(() => loaded.state === "ready");
  // The page opened from a link that says what was done (`?done=`): said once, from the first
  // value of the prop, and then replaced by what the page does next.
  let notice = $state<string | null>(untrack(() => (done ? (DONE[done] ?? null) : null)));
  let devLink = $state<string | null>(null);
  let deleted = $state(false);
  const c = useConfirm();
  /** The theme (take 4): System, Light or Dark, applied at once and saved on the account. */
  const theme = useTheme();
  /** The handle a confirmation is about: the new one and the one it replaces. */
  let renaming = $state.raw<{ handle: string; current: string }>({ handle: "", current: "" });

  function changeEmail(e: SubmitEvent & { currentTarget: HTMLFormElement }) {
    e.preventDefault();
    const email = field(e.currentTarget, "email");
    void action.run(async () => {
      const res = await post<{ sent_to: string; dev_link?: string }>("/api/v1/account/email", {
        email,
      });
      notice = `Check ${res.sent_to} for a link, and open it while signed in as you are now.`;
      devLink = res.dev_link ?? null;
    });
  }
  /** The name (TEMPRA-54): optional; an empty field clears it. A full load, so the avatar follows. */
  function changeName(e: SubmitEvent & { currentTarget: HTMLFormElement }, current: string | null) {
    e.preventDefault();
    const name = field(e.currentTarget, "name").trim();
    if (name === (current ?? "")) return;
    void action.run(async () => {
      await post("/api/v1/account", { name: name || null }, "PATCH");
      location.assign("/account");
    });
  }
  function changeHandle(e: SubmitEvent & { currentTarget: HTMLFormElement }, current: string) {
    e.preventDefault();
    const handle = field(e.currentTarget, "handle").replace(/^@/, "");
    if (handle.toLowerCase() === current.toLowerCase()) return;
    renaming = { handle, current };
    c.confirm({
      title: `Change your handle to @${handle}?`,
      body: handleBody,
      action: "Change handle",
      run: () =>
        action.run(async () => {
          await post("/api/v1/account/handle", { handle }, "PUT");
          // A full load: the header and every library link follow the new handle.
          location.assign("/account");
        }),
    });
  }
  const endSession = (id: string) =>
    action.run(async () => {
      await api(`/api/v1/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      loaded.reload();
    });
  function remove(e: SubmitEvent & { currentTarget: HTMLFormElement }) {
    e.preventDefault();
    const confirm = field(e.currentTarget, "confirm");
    void action.run(async () => {
      await post("/api/v1/account/delete", { confirm });
      deleted = true;
    });
  }
</script>

{#snippet handleBody()}
  <p>
    Every one of your libraries moves to a new address under /{renaming.handle}/, and links to the
    old ones stop working.
  </p>
  <p>@{renaming.current} is held for 90 days, then anyone may take it.</p>
{/snippet}

{#if deleted}
  <h1>Account deleted</h1>
  <p>
    <a href={LEGAL}>tempra.dev</a>
  </p>
{:else}
  <h1>Account</h1>
  <ConfirmDialog asking={c} />
  {#if notice}<div class="notice ok">{notice}</div>{/if}
  {#if devLink}
    <p>
      Local dev, no email sent: <a id="dev-link" href={devLink}>confirm the new email</a>
    </p>
  {/if}
  {#if action.error}<div class="notice">{action.error}</div>{/if}
  <Status loaded={loaded.current}>
    {#snippet children(a)}
      <form class="field-action" onsubmit={changeEmail}>
        <Field label="Email"
          ><input type="email" name="email" autocomplete="email" defaultValue={a.email} required /></Field
        >
        <Button type="submit" disabled={action.busy}>Change</Button>
      </form>
      <form class="field-action" onsubmit={(e) => changeName(e, a.name)}>
        <Field label="Name" hint="Optional. Your avatar's initials come from it."
          ><input
            type="text"
            name="name"
            autocomplete="name"
            maxlength={80}
            defaultValue={a.name ?? ""}
          /></Field
        >
        <Button type="submit" disabled={action.busy}>Change</Button>
      </form>
      <form class="field-action" onsubmit={(e) => changeHandle(e, a.handle)}>
        <Field label="Handle" hint="Your handle is in every library's address."
          ><input type="text" name="handle" defaultValue={a.handle} required /></Field
        >
        <Button type="submit" disabled={action.busy}>Change</Button>
      </form>
      <h2 id="usage">Limits</h2>
      <p>
        Libraries: {a.usage.libraries} of {a.limits.libraries}. Active tokens:
        {a.usage.tokens} of {a.limits.tokens}.
      </p>
      {#if a.month}
        {#each monthLines(a.month) as line (line.label)}
          <p>{line.label}: {line.text}.</p>
        {/each}
        <p class="small muted">
          Your agents' writes and requests start again on {day(a.month.resets, "UTC")}. Past the
          writes or storage limit they can still read; past the requests limit they get no
          answers. Tempra in your browser keeps working.
        </p>
      {/if}
      <h2>Appearance</h2>
      <p class="field-row">
        <span>Theme</span><ThemeChoice value={theme.current} onChange={theme.choose} />
      </p>
      <h2 id="email">Email</h2>
      <EmailSwitch />
      <h2>Sessions</h2>
      <div class="table-wrap">
        <table class="list">
          <thead>
            <tr>
              <th>Started</th>
              <th>Last seen</th>
              <th>Device</th>
              <th>
                <span class="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {#each a.sessions as s (s.id)}
              <tr>
                <td class="when">{localTime(s.created)}</td>
                <td class="when">
                  <Moment ts={s.last_seen} />
                </td>
                <td class="small muted">{s.user_agent ?? ""}</td>
                <td>
                  {#if s.current}this device{:else}<Button disabled={action.busy} onclick={() => void endSession(s.id)}>Sign out</Button>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <!-- Signing out stays a server form: it must work whatever state the app is in. -->
      <div class="actions">
        <form method="post" action="/sign-out">
          <Button type="submit">Sign out</Button>
        </form>
        <form method="post" action="/sign-out/everywhere">
          <Button type="submit">Sign out everywhere</Button>
        </form>
      </div>
      <h2>Delete account</h2>
      <p>Deletes every library you own. Export them first.</p>
      <form onsubmit={remove}>
        <Field label={`Type ${a.handle} to confirm`}
          ><input type="text" name="confirm" autocomplete="off" required /></Field
        >
        <p>
          <Button type="submit" disabled={action.busy}>Delete account</Button>
        </p>
      </form>
      <p>
        <a href={`${LEGAL}/terms`}>Terms</a> · <a href={`${LEGAL}/privacy`}>Privacy</a>
      </p>
    {/snippet}
  </Status>
{/if}
