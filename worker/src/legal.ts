import type { Hono } from "hono";
import { page } from "./oauth/pages";

/**
 * /terms and /privacy (v2 spec: Limits and A3). Plain pages. The privacy page states what the
 * service does; the terms are a draft until the legal entity is settled (v2 spec: open question 10).
 */

const PRIVACY = `<h1>Privacy</h1>
<h2>What we store</h2>
<ul>
<li>Your email address and handle.</li>
<li>Your libraries: concepts, attachments, and the ledger of every change, with who made it.</li>
<li>Tokens and connected apps (only hashes of secrets).</li>
<li>Sessions: when, and your browser's user agent.</li>
<li>Usage counts (requests, writes, emails) for limits.</li>
</ul>
<h2>Where</h2>
<p>On Cloudflare (Workers, Durable Objects, D1, R2, KV), encrypted at rest by Cloudflare. The operator can read stored data.</p>
<h2>What we do not do</h2>
<p>No models read your content. No ads, no selling data, no tracking scripts.</p>
<h2>Export and deletion</h2>
<p>Export any library at any time. Deleting a library or your account removes it at once. Backups and attachment files can last up to 31 more days, then are gone. A hash of a deleted account's email is kept to handle abuse.</p>
<h2>Email</h2>
<p>We email you only sign-in links and notices about your account.</p>
<p><a href="/terms">Terms</a></p>`;

const TERMS = `<h1>Terms</h1>
<p><strong>Draft.</strong> This service is experimental.</p>
<ul>
<li>Use it for your own knowledge and your agents. Do not store anything illegal, or other people's private data without their consent.</li>
<li>Limits apply (libraries, tokens, storage, rate). We may suspend accounts that abuse the service.</li>
<li>Keep your own exports. The service is provided as is, with no warranty, and may change or end.</li>
<li>You own your content. We store and serve it only to run the service.</li>
</ul>
<p><a href="/privacy">Privacy</a></p>`;

function plain(title: string, body: string): Response {
  return new Response(page(title, body), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

export function registerLegalRoutes<E extends object>(app: Hono<E>) {
  app.get("/privacy", () => plain("Privacy", PRIVACY));
  app.get("/terms", () => plain("Terms", TERMS));
}
