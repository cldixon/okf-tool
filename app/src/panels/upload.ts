/**
 * The upload panel (TEMPRA-200; tempra-dev app/media, Upload panel): an MCP App that a host draws
 * in the chat beside a `prepare_upload` call. The person chooses (or drops) the file there, and
 * their browser PUTs it to the call's `/ul/` URL, the token its only credential; the server runs
 * what curl and the upload link run. When it lands, the panel tells the conversation, so the
 * agent carries on. The bridge to the host is ext-apps' `App` (main.ts); this module is the
 * panel itself, over a small `PanelHost`, so it can be tested without a host.
 */

import { markSvg } from "@tempra/design/mark";

/** What `prepare_upload` puts in its result's `structuredContent.upload`. */
export interface PreparedUpload {
  /** The `/ul/` URL: one PUT, until `expires`. */
  url: string;
  /** The person's upload link, the fallback. */
  page?: string;
  path: string;
  library: string;
  media?: string | null;
  /** The kind of file expected, as people say it: "PNG image". */
  kind?: string;
  /** Who has the file: the agent made it and handed it to the person (TEMPRA-205), or theirs. */
  origin?: "person" | "agent";
  description?: string;
  expires: string;
}

/** What the panel needs from its host: the call's result, and a way to speak to the chat. */
export interface PanelHost {
  /** Whether the host takes `ui/message`. */
  canMessage(): boolean;
  /** Adds a message to the conversation as the person; false when the host refused it. */
  sendMessage(text: string): Promise<boolean>;
  /** Opens a link in the person's browser; false when the host cannot. */
  openLink(url: string): Promise<boolean>;
}

/** What a PUT answered: its status and its JSON body (the write result, or `{code, message}`). */
export interface PutAnswer {
  status: number;
  body: { code?: string; message?: string; path?: string; hash?: string } | null;
}

/** Sends the file; `progress` gets a share from 0 to 1 as the bytes go. */
export type Put = (
  url: string,
  file: File,
  progress: (share: number) => void,
) => Promise<PutAnswer>;

/** A size as people read it: "349 KB". */
export function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The `structuredContent.upload` of a tool result, when it is one. */
export function preparedFrom(result: { structuredContent?: unknown }): PreparedUpload | null {
  const sc = result.structuredContent as { upload?: Partial<PreparedUpload> } | undefined;
  const u = sc?.upload;
  if (!u || typeof u.url !== "string" || typeof u.path !== "string") return null;
  return {
    url: u.url,
    path: u.path,
    library: typeof u.library === "string" ? u.library : "",
    expires: typeof u.expires === "string" ? u.expires : "",
    ...(typeof u.page === "string" ? { page: u.page } : {}),
    ...(typeof u.media === "string" ? { media: u.media } : {}),
    ...(typeof u.kind === "string" ? { kind: u.kind } : {}),
    ...(u.origin === "agent" || u.origin === "person" ? { origin: u.origin } : {}),
    ...(typeof u.description === "string" ? { description: u.description } : {}),
  };
}

/** The PUT, with progress, through XMLHttpRequest (fetch reports none for uploads). */
export const xhrPut: Put = (url, file, progress) =>
  new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    if (file.type) xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: PutAnswer["body"] = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => resolve({ status: 0, body: null });
    xhr.send(file);
  });

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (props.className) e.className = props.className;
  if (props.text !== undefined) e.textContent = props.text;
  e.append(...children);
  return e;
};

/** The panel's heading, after the Tempra mark (TEMPRA-279), which says whose panel it is. */
function heading(text: string): HTMLHeadingElement {
  const h = el("h1", { className: "mark-lockup" });
  h.innerHTML = markSvg({ small: true, label: "Tempra" });
  h.append(text);
  return h;
}

/**
 * Draws the panel into `root` and returns `show`, which the host's tool result calls with the
 * prepared upload. Until then it waits.
 */
export function mountUploadPanel(
  root: HTMLElement,
  host: PanelHost,
  put: Put = xhrPut,
): { show(upload: PreparedUpload | null): void } {
  root.replaceChildren(el("p", { className: "muted", text: "Waiting for the upload…" }));

  const show = (upload: PreparedUpload | null) => {
    if (!upload) {
      root.replaceChildren(
        el("p", { text: "This upload has no details. Ask the agent to prepare it again." }),
      );
      return;
    }
    const fromAgent = upload.origin === "agent";
    const input = el("input");
    input.type = "file";
    input.name = "file";
    if (upload.media) input.accept = upload.media;
    const drop = el(
      "label",
      { className: "drop" },
      el("span", { text: "Drop the file here, or choose it" }),
      input,
      el("span", {
        className: "muted hint",
        text: fromAgent
          ? "Save it from the chat first, then choose it here."
          : "If it came from the chat, choose it again here.",
      }),
    );
    const status = el("p", { className: "status" });
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const bar = el("progress");
    bar.max = 1;
    bar.value = 0;
    bar.hidden = true;
    const actions = el("div", { className: "actions" });
    if (upload.page) {
      const open = el("button", { text: "Open the upload page instead" });
      open.type = "button";
      open.addEventListener("click", async () => {
        if (!(await host.openLink(upload.page as string))) {
          status.textContent = `Open this link to upload in your browser: ${upload.page}`;
        }
      });
      actions.append(open);
    }
    root.replaceChildren(
      heading("Upload a file"),
      el(
        "p",
        {},
        upload.library ? `To ${upload.library}, as ` : "As ",
        el("code", { text: upload.path }),
        ".",
      ),
      ...(fromAgent
        ? [
            el("p", {
              text: "The agent made this file and gave it to you in the chat. Agents can't send files to Tempra themselves yet, so choose it here.",
            }),
          ]
        : []),
      ...(upload.description ? [el("p", { className: "muted", text: upload.description })] : []),
      ...(upload.kind ? [el("p", { className: "muted", text: `Kind: ${upload.kind}` })] : []),
      drop,
      bar,
      status,
      actions,
    );

    let busy = false;
    const send = async (file: File) => {
      if (busy) return;
      busy = true;
      input.disabled = true;
      bar.hidden = false;
      bar.value = 0;
      status.textContent = `Uploading ${file.name} (${readableSize(file.size)})…`;
      const answer = await put(`${upload.url}?via=chat`, file, (share) => {
        bar.value = share;
      });
      bar.hidden = true;
      if (answer.status >= 200 && answer.status < 300) {
        const done = `${file.name} (${readableSize(file.size)}) to ${upload.path}`;
        status.textContent = `Uploaded ${done}.`;
        drop.hidden = true;
        actions.replaceChildren();
        const told =
          host.canMessage() &&
          (await host
            .sendMessage(`I uploaded ${done} through the upload panel.`)
            .catch(() => false));
        if (!told) status.textContent = `Uploaded ${done}. Tell the agent it is there.`;
        return;
      }
      const code = answer.body?.code;
      if (code === "upload_used" || code === "bad_upload") {
        status.textContent =
          "This upload has expired or was already used. Ask the agent for a new one.";
        drop.hidden = true;
        return;
      }
      status.textContent =
        answer.status === 0
          ? "The upload did not reach Tempra. Try again, or open the upload page instead."
          : `Not uploaded: ${answer.body?.message ?? `the server answered ${answer.status}`}`;
      busy = false;
      input.disabled = false;
      input.value = "";
    };
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) void send(file);
    });
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      const file = e.dataTransfer?.files?.[0];
      if (file) void send(file);
    });
  };
  return { show };
}
