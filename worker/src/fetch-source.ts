/**
 * Attach from a URL (TEMPRA-157; tempra-dev decisions/server-fetches-agent-urls.md): the Worker
 * fetches a public https file an agent names and hands its bytes on, with where they came from.
 * The rules: https only, no credentials in the URL, never the deployment's own host, no literal
 * private, loopback or link-local address and no `localhost` name (Workers cannot reach private
 * networks; this is defence in depth), at most 3 redirects each checked again, 10 s for the whole
 * fetch, the size cap read from the stream (Content-Length is never trusted), and only the
 * design's media types, decided by the bytes. A refusal is 400 `fetch_refused` naming the rule.
 * Free of Worker APIs: the fetch is injected.
 */
import { type BlobStore, putBlob, WORKER_ATTACHMENT_CAP } from "./client";
import { IMAGE_MEDIA, sniffImage, sniffMedia } from "./media";
import { StoreError } from "./store/errors";
import type { AttachSource, BlobRef } from "./store/store";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 10_000;
/**
 * Sent on every hop. A descriptive User-Agent with a contact URL, as sites such as Wikimedia
 * require (they answer 400 or 403 without one).
 */
export const FETCH_USER_AGENT =
  "Tempra/1.0 (+https://tempra.dev; fetches an image an agent named for a library)";
export const FETCH_ACCEPT = "image/*, application/pdf, video/*, audio/*;q=0.8, */*;q=0.1";

/** Where an attachment fetched from a URL came from, as the attach op records it. */
export type UrlSource = AttachSource;

export type FetchRule =
  | "url"
  | "scheme"
  | "credentials"
  | "host"
  | "redirect"
  | "status"
  | "size"
  | "type"
  | "timeout"
  | "network";

export const refused = (rule: FetchRule, message: string, extra: Record<string, unknown> = {}) =>
  new StoreError(400, "fetch_refused", message, { rule, ...extra });

/** The deployment's own hostnames, from its origin: a source_url never names them. */
export function selfHosts(origin: string): string[] {
  try {
    return [new URL(origin).hostname];
  } catch {
    return [];
  }
}

/** IPv4 dotted quads a public fetch must never name. */
function privateV4(host: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && Number(m[3]) === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** IPv6 literals (the URL parser's bracketed, compressed form) a public fetch must never name. */
function privateV6(host: string): boolean {
  if (!host.startsWith("[")) return false;
  const h = host.slice(1, -1).toLowerCase();
  if (h === "::" || h === "::1") return true;
  // IPv4-mapped and -compatible: the URL parser writes the quad as hex (::ffff:7f00:1).
  const mapped = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) {
    const hi = Number.parseInt(mapped[1] as string, 16);
    const lo = Number.parseInt(mapped[2] as string, 16);
    return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = Number.parseInt(h.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 // multicast
  );
}

/**
 * A URL the fetch may go to, parsed; refused with the rule it breaks. `selfHosts` are the
 * deployment's own hostnames.
 */
export function checkSourceUrl(raw: string, selfHosts: string[] = []): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw refused("url", `source_url is not a URL: ${JSON.stringify(raw.slice(0, 200))}.`);
  }
  if (url.protocol !== "https:") {
    throw refused("scheme", `source_url must be https; this one is ${url.protocol}.`);
  }
  if (url.username || url.password) {
    throw refused("credentials", "source_url must not carry a user name or password.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    privateV4(host) ||
    privateV6(host)
  ) {
    throw refused("host", `source_url must be a public host; ${host} is not.`);
  }
  if (selfHosts.some((h) => h.toLowerCase() === host)) {
    throw refused("host", `source_url must be another site; ${host} is this one.`);
  }
  return url;
}

/** The body read whole within the deadline, refused once it passes `cap`. */
async function readBody(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
  late: Promise<never>,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), late]);
      if (done) break;
      total += value.length;
      if (total > cap) {
        throw refused("size", `The file at source_url is over the ${cap}-byte cap.`, { cap });
      }
      chunks.push(value);
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export interface Fetched {
  bytes: Uint8Array;
  /** The type the bytes have: an image format's, or one of the design's other media. */
  media: string;
  source: UrlSource;
}

/**
 * Fetches `raw` under the rules above. The bytes' type is checked here (an image's validity is
 * putBlob's, after); what is not one of the design's media is refused as `type`.
 */
export async function fetchSource(
  fetchFn: FetchFn,
  raw: string,
  opts: { selfHosts?: string[]; now?: () => Date; timeoutMs?: number; cap?: number } = {},
): Promise<Fetched> {
  const selfHosts = opts.selfHosts ?? [];
  const first = checkSourceUrl(raw, selfHosts);
  const ms = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(refused("timeout", `source_url did not answer in full within ${ms / 1000} s.`));
    }, ms);
  });
  late.catch(() => {});
  try {
    let url = first;
    for (let hop = 0; ; hop++) {
      let res: Response;
      try {
        res = await Promise.race([
          fetchFn(url.href, {
            method: "GET",
            redirect: "manual",
            signal: abort.signal,
            headers: {
              Accept: FETCH_ACCEPT,
              "User-Agent": FETCH_USER_AGENT,
            },
          }),
          late,
        ]);
      } catch (e) {
        if (e instanceof StoreError) throw e;
        throw refused("network", `Could not fetch ${url.host}: ${(e as Error).message}.`);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.has("Location")) {
        res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) {
          throw refused("redirect", `source_url redirects more than ${MAX_REDIRECTS} times.`);
        }
        const next = new URL(res.headers.get("Location") as string, url);
        try {
          url = checkSourceUrl(next.href, selfHosts);
        } catch (e) {
          if (e instanceof StoreError) {
            throw new StoreError(e.status, e.code, `A redirect from source_url: ${e.message}`, {
              ...e.extra,
              redirect: next.href,
            });
          }
          throw e;
        }
        continue;
      }
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        throw refused(
          "status",
          `${url.host} answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""} for ${url.href}; nothing was stored.`,
          { status: res.status, host: url.host },
        );
      }
      const cap = opts.cap ?? WORKER_ATTACHMENT_CAP;
      const bytes = await readBody(res.body, cap, late);
      const image = sniffImage(bytes);
      const media = image ? null : sniffMedia(bytes);
      if (!image && !media) {
        const said = res.headers.get("Content-Type")?.split(";")[0]?.trim();
        throw refused(
          "type",
          `The file at source_url is not an image, video, audio or PDF${said ? ` (it says ${said})` : ""}. Only those can be fetched.`,
        );
      }
      const source: UrlSource = {
        via: "url",
        url: first.href,
        fetched_at: (opts.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
      };
      if (url.href !== first.href) source.final_url = url.href;
      return {
        bytes,
        media: image ? IMAGE_MEDIA[image] : (media as string),
        source,
      };
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * `fetchSource`, then the bytes stored like any other attachment's (`putBlob`: an image is
 * checked and typed by its bytes). What `attach` with `source_url` and REST `?from=` share.
 */
export async function fetchBlob(
  d: { fetch: FetchFn; blobs: BlobStore; selfHosts: string[]; now?: () => Date },
  url: string,
  path: string,
): Promise<{ blob: BlobRef; bytes: Uint8Array; source: UrlSource }> {
  const got = await fetchSource(d.fetch, url, { selfHosts: d.selfHosts, now: d.now });
  const blob = await putBlob(d.blobs, got.bytes, got.media, path);
  return { blob, bytes: got.bytes, source: got.source };
}
