/**
 * Writes the portal's static assets to dist/public/ (the directory wrangler.config.ts names): the
 * design stylesheet at its hashed name, the fonts it names, the icon and `_headers`. Run before
 * cf dev, tests, typecheck and deploy (package.json). Access covers these too: they are served on
 * the portal's host, which Access guards before anything is served.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { css, fonts, href } from "@tempra/design";

const ROOT = import.meta.dir;
const PUBLIC = join(ROOT, "dist", "public");

const HEADERS = `/_design/*
  Cache-Control: private, max-age=31536000, immutable
  X-Content-Type-Options: nosniff
/favicon.svg
  Cache-Control: private, max-age=86400
  X-Content-Type-Options: nosniff
`;

rmSync(PUBLIC, { recursive: true, force: true });
mkdirSync(join(PUBLIC, "_design"), { recursive: true });
writeFileSync(join(PUBLIC, href.slice(1)), css);
for (const [served, source] of Object.entries(fonts)) {
  writeFileSync(
    join(PUBLIC, "_design", served),
    readFileSync(Bun.resolveSync(`@tempra/design/fonts/${source}`, ROOT)),
  );
}
writeFileSync(
  join(PUBLIC, "favicon.svg"),
  readFileSync(Bun.resolveSync("@tempra/design/favicon.svg", ROOT)),
);
writeFileSync(join(PUBLIC, "_headers"), HEADERS);
