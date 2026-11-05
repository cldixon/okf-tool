/**
 * TEMPRA-291, a spike, not wired into the app: a page's Markdown source as a diff with Pierre's
 * `@pierre/diffs`, drawn the way the SPA would draw it, so measure.ts can try it under the shell's
 * CSP (`style-src 'self'`) in Chromium and size the lazily loaded chunk. Findings: tempra-dev
 * app/source-diff.
 *
 * Two modes:
 * - `plain`: the source as plain text (`lang: "text"`, no grammar), Pierre's CSS-variables theme
 *   so no theme catalogue loads.
 * - `markdown`: Shiki's Markdown grammar (the one language imported, not Shiki's catalogue),
 *   token colours from the same CSS-variables theme, so every token's colour is `var(--…)`.
 *
 * `cssom: "shim"` adds the shim this spike tries: Pierre writes rows with `innerHTML`, so their
 * `style` attributes are parsed from markup (which the CSP refuses), and puts its theme in a
 * `<style>` element (also refused). A MutationObserver on the shadow root moves both into the
 * CSSOM, which CSP leaves alone, as reader/svgdom.ts does for diagrams: each `style` attribute's
 * declarations through `style.setProperty`, each `<style>`'s text into an adopted sheet.
 */
import {
  FileDiff,
  type FileDiffMetadata,
  parsePatchFiles,
  registerCustomCSSVariableTheme,
  registerCustomLanguage,
} from "@pierre/diffs";

export type Mode = "plain" | "markdown";

const THEME = "tempra";
let registered = false;

/** The theme: Tempra's greys through custom properties a stylesheet can set (`--diffs-…`). */
function registerTheme(): void {
  if (registered) return;
  registered = true;
  registerCustomCSSVariableTheme(THEME, {
    foreground: "var(--tempra-color-text, CanvasText)",
    background: "var(--tempra-color-bg, Canvas)",
    "token-comment": "var(--tempra-color-muted, GrayText)",
    "token-keyword": "var(--tempra-color-text, CanvasText)",
    "token-string": "var(--tempra-color-muted, GrayText)",
    "token-string-expression": "var(--tempra-color-muted, GrayText)",
    "token-constant": "var(--tempra-color-text, CanvasText)",
    "token-function": "var(--tempra-color-text, CanvasText)",
    "token-link": "var(--tempra-color-link, LinkText)",
    "token-punctuation": "var(--tempra-color-muted, GrayText)",
  });
  // Shiki's Markdown grammar alone, loaded with this chunk, rather than its catalogue of 200.
  registerCustomLanguage("markdown", () => import("@shikijs/langs/markdown"), ["md"]);
}

/** The patch's one file, named for the page. */
export function fileOf(patch: string, path: string, mode: Mode): FileDiffMetadata | null {
  const file = parsePatchFiles(patch)[0]?.files[0];
  if (!file) return null;
  return { ...file, name: path, prevName: undefined, lang: mode === "plain" ? "text" : "markdown" };
}

/** A style attribute's declarations (reader/svgdom.ts has the careful one; this is a spike). */
function declarations(css: string): [string, string][] {
  return css
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .flatMap((d): [string, string][] => {
      const i = d.indexOf(":");
      return i > 0 ? [[d.slice(0, i).trim(), d.slice(i + 1).trim()]] : [];
    });
}

/** Moves what markup carried into the CSSOM, now and on every later render; returns a stop. */
export function cssomShim(root: ShadowRoot): () => void {
  const sheets = new Map<HTMLStyleElement, CSSStyleSheet>();
  const fix = (node: Node) => {
    if (!(node instanceof Element)) return;
    applyRenamed(node);
    const els = [node, ...Array.from(node.querySelectorAll("[style], style"))];
    for (const el of els) {
      if (el instanceof HTMLStyleElement) {
        let sheet = sheets.get(el);
        if (!sheet) {
          sheet = new CSSStyleSheet();
          sheets.set(el, sheet);
          root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
        }
        sheet.replaceSync(el.textContent ?? "");
        continue;
      }
      const css = el.getAttribute("style");
      if (css === null || el.hasAttribute("data-cssom")) continue;
      const style = (el as HTMLElement).style;
      for (const [name, value] of declarations(css)) style.setProperty(name, value);
      el.setAttribute("data-cssom", "");
    }
  };
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData" && r.target.parentElement instanceof HTMLStyleElement)
        fix(r.target.parentElement);
      for (const n of Array.from(r.addedNodes)) fix(n);
      if (r.type === "attributes" && r.target instanceof Element) {
        r.target.removeAttribute("data-cssom");
        fix(r.target);
      }
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["style"],
  });
  for (const n of Array.from(root.children)) fix(n);
  return () => observer.disconnect();
}

/**
 * The further step measured as `cssom: "rewrite"`: Pierre's markup has its `style` attributes
 * renamed before it is parsed, as svgdom.ts does for Pele's SVG, so the CSP never sees them; the
 * shim then applies them. Pierre parses rows with `innerHTML` and `insertAdjacentHTML`, often on
 * elements not yet in the document, and sets the `<pre>`'s and tokens' `style` with
 * `setAttribute`, so this wraps all three on `Element.prototype`, for elements in the given roots
 * or not yet connected. A global patch of the DOM: measured, not recommended.
 */
const rewritten = new Set<Node>();
let patched = false;
function rewriteBeforeParse(root: ShadowRoot): void {
  rewritten.add(root);
  if (patched) return;
  patched = true;
  const ours = (el: Element) => !el.isConnected || rewritten.has(el.getRootNode());
  const rename = (html: string) => html.replace(/(<[^<>]*?\s)style="/g, '$1data-css-style="');
  const inner = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  const adjacent = Element.prototype.insertAdjacentHTML;
  const set = Element.prototype.setAttribute;
  Object.defineProperty(Element.prototype, "innerHTML", {
    configurable: true,
    get(this: Element) {
      return inner?.get?.call(this);
    },
    set(this: Element, html: string) {
      inner?.set?.call(this, ours(this) ? rename(String(html)) : html);
    },
  });
  Element.prototype.insertAdjacentHTML = function (this: Element, where, html) {
    adjacent.call(this, where, ours(this) ? rename(html) : html);
  };
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    if (name === "style" && ours(this)) {
      for (const [n, v] of declarations(value)) (this as HTMLElement).style.setProperty(n, v);
      return;
    }
    set.call(this, name, value);
  };
}

/** Applies `data-css-style` (from rewriteBeforeParse) through the CSSOM, as the shim does. */
function applyRenamed(node: Node): void {
  if (!(node instanceof Element)) return;
  for (const el of [node, ...Array.from(node.querySelectorAll("[data-css-style]"))]) {
    const css = el.getAttribute("data-css-style");
    if (css === null) continue;
    el.removeAttribute("data-css-style");
    for (const [name, value] of declarations(css))
      (el as HTMLElement).style.setProperty(name, value);
  }
}

/** Draws the diff into `container`; resolves once Pierre has rendered (it may load a theme). */
export async function drawSourceDiff(
  container: HTMLElement,
  patch: string,
  opts: {
    path: string;
    mode: Mode;
    layout: "unified" | "split";
    cssom: false | "shim" | "rewrite";
  },
): Promise<FileDiff> {
  registerTheme();
  const file = fileOf(patch, opts.path, opts.mode);
  if (!file) throw new Error("No file in the patch.");
  const host = document.createElement("diffs-container");
  container.append(host);
  // Pierre attaches the shadow root in the custom element's constructor; watch it before render.
  if (opts.cssom === "rewrite" && host.shadowRoot) rewriteBeforeParse(host.shadowRoot);
  const stop = opts.cssom && host.shadowRoot ? cssomShim(host.shadowRoot) : () => {};
  const diff = new FileDiff({
    theme: THEME,
    diffStyle: opts.layout,
    diffIndicators: "classic",
    lineDiffType: "word",
    overflow: "wrap",
    disableFileHeader: true,
    onPostRender: () => {},
  });
  diff.render({ fileDiff: file, fileContainer: host });
  // The highlighter (and, in markdown mode, the grammar) loads once; Pierre renders again then.
  await new Promise((r) => setTimeout(r, 400));
  void stop;
  return diff;
}
