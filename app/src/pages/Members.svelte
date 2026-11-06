<script lang="ts">
  import { Button, Select } from "@tempra/design/components";
  import { agentLabel, type Contributor } from "../agents";
  import { api, field, post } from "../api";
  import ConfirmDialog from "../ConfirmDialog.svelte";
  import { useConfirm } from "../confirm.svelte.ts";
  import { useAction, useLoad } from "../load.svelte.ts";
  import Moment from "../Moment.svelte";
  import Status from "../Status.svelte";
  import { day, plural } from "../ui";
  import type { Urls } from "../urls";
  import { type MembersData, ROLE_WORDS } from "./manage";

  const ROLE_OPTIONS = [
    { value: "read", label: ROLE_WORDS.read },
    { value: "write", label: ROLE_WORDS.write },
  ] as const;

  /**
   * Who is in the library (tempra-dev: v2/sharing): the owner, members with their access, and the
   * agents that have worked here, each for its person. The owner invites, changes access and
   * removes; a member may leave. Each of those asks first (S-4).
   */
  let { urls, me }: { urls: Urls; me: string | null } = $props();
  const loaded = useLoad(
    () => `members ${urls.base}`,
    async () => {
      const [m, a] = await Promise.all([
        api<MembersData>(urls.api("members")),
        api<{ contributors: Contributor[] }>(urls.api("agents")),
      ]);
      return { ...m, contributors: a.contributors };
    },
  );
  const action = useAction();
  const c = useConfirm();
  let notice = $state<string | null>(null);
  /** Whom a confirmation is about, for its body. */
  let subject = $state.raw<{ handle: string; role: "read" | "write" }>({
    handle: "",
    role: "read",
  });
  const done = (text: string) => {
    notice = text;
    loaded.reload();
  };

  function invite(e: SubmitEvent & { currentTarget: HTMLFormElement }) {
    e.preventDefault();
    const form = e.currentTarget;
    const to = field(form, "to");
    const role = field(form, "role");
    void action.run(async () => {
      const r = await post<{ sent: string; handle?: string }>(urls.api("invitations"), {
        to,
        role,
      });
      form.reset();
      done(
        r.sent === "invited"
          ? `Invited @${r.handle}. They accept it from their notifications.`
          : "If that address has a Tempra account, they will get the invitation.",
      );
    });
  }
  const member = (handle: string) => urls.api(`members/${encodeURIComponent(handle)}`);
  const setRole = (handle: string, role: "read" | "write") => {
    subject = { handle, role };
    c.confirm({
      title: `Change @${handle}'s access?`,
      body: roleBody,
      action: "Change access",
      run: () =>
        action.run(async () => {
          await post(member(handle), { role }, "PUT");
          done(`@${handle} now has ${role} access.`);
        }),
    });
  };
  const remove = (handle: string) => {
    subject = { handle, role: "read" };
    c.confirm({
      title: `Remove @${handle}?`,
      body: removeBody,
      action: "Remove",
      run: () =>
        action.run(async () => {
          await api(member(handle), { method: "DELETE" });
          done(`Removed @${handle}.`);
        }),
    });
  };
  const leave = (handle: string) =>
    c.confirm({
      title: "Leave this library?",
      body: leaveBody,
      action: "Leave",
      run: () =>
        action.run(async () => {
          await api(member(handle), { method: "DELETE" });
          location.assign("/");
        }),
    });
  const withdraw = (id: string, handle: string) => {
    subject = { handle, role: "read" };
    c.confirm({
      title: "Withdraw the invitation?",
      body: withdrawBody,
      action: "Withdraw",
      run: () =>
        action.run(async () => {
          await api(urls.api(`invitations/${encodeURIComponent(id)}`), { method: "DELETE" });
          done("Invitation withdrawn.");
        }),
    });
  };
</script>

{#snippet roleBody()}
  <p>
    @{subject.handle} and their agents will {subject.role === "write" ? "read and write" : "read and comment"}
    here, from their next request.
  </p>
{/snippet}

{#snippet removeBody()}
  <p>@{subject.handle} and their agents lose access to this library at once.</p>
{/snippet}

{#snippet leaveBody()}
  <p>You and your agents lose access at once. Only @{urls.owner} can invite you back.</p>
{/snippet}

{#snippet withdrawBody()}
  <p>@{subject.handle} can no longer accept it.</p>
{/snippet}

<ConfirmDialog asking={c} />
{#if notice}<div class="notice ok">{notice}</div>{/if}
{#if action.error}<div class="notice">{action.error}</div>{/if}
<Status loaded={loaded.current}>
  {#snippet children(d)}
    {@const owner = d.role === "owner"}
    <div class="table-wrap">
      <table class="list">
        <thead>
          <tr>
            <th>Person</th>
            <th>Access</th>
            <th>
              <span class="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="name">@{d.owner}</td>
            <td>Owner</td>
            <td></td>
          </tr>
          {#each d.members as m (m.handle)}
            <tr>
              <td class="name">@{m.handle}</td>
              <td>
                {#if owner}
                  <Select
                    variant="plain"
                    label={`Access for @${m.handle}`}
                    value={m.role}
                    options={ROLE_OPTIONS}
                    disabled={action.busy}
                    onchange={(role, e) => {
                      // The select shows the saved access until the change is confirmed and saved.
                      e.currentTarget.value = m.role;
                      setRole(m.handle, role as "read" | "write");
                    }}
                  />
                {:else}
                  {ROLE_WORDS[m.role]}
                {/if}
              </td>
              <td>
                {#if owner}
                  <Button disabled={action.busy} onclick={() => remove(m.handle)}>Remove…</Button>
                {:else if m.handle === me}
                  <Button disabled={action.busy} onclick={() => leave(m.handle)}>Leave…</Button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    {#if owner}
      <h3>Invite</h3>
      <form class="token" onsubmit={invite}>
        <p>
          <label>
            Handle or email
            <input type="text" name="to" required autocomplete="off" placeholder="@ann" />
          </label>
          <label>
            Access
            <Select variant="plain" name="role" value="read" options={ROLE_OPTIONS} />
          </label>
          <Button variant="primary" type="submit" disabled={action.busy}>Invite</Button>
        </p>
        <p class="small muted">
          Only people with a Tempra account. Their agents reach this library at most at their access.
        </p>
      </form>
      {#if (d.invitations ?? []).length > 0}
        <h3>Waiting</h3>
        <ul>
          {#each d.invitations ?? [] as i (i.id)}
            <li>
              @{i.handle}, {ROLE_WORDS[i.role].toLowerCase()}, open until {day(i.expires)}
              <Button disabled={action.busy} onclick={() => withdraw(i.id, i.handle)}>Withdraw…</Button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}

    <h3>Who has worked here</h3>
    {#if d.contributors.length === 0}
      <p class="muted">Nobody yet.</p>
    {:else}
      <ul>
        {#each d.contributors as w (`${w.person}|${w.agent?.id ?? ""}`)}
          <li>
            <a href={urls.activity({ view: "events", actor: w.actor })}>{agentLabel(w)}</a>
            <span class="small muted">{plural(w.requests, "change")}, last <Moment ts={w.last_ts} /></span>
          </li>
        {/each}
      </ul>
    {/if}
  {/snippet}
</Status>
