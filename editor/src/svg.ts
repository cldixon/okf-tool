/**
 * SVG fences (TEMPRA-206; tempra-dev: app/diagrams, app/media): SVG an agent writes in a page is
 * rendered media, code Tempra draws, and untrusted. This reads it as XML with no DOM and gives back
 * a sanitized SVG that the reader draws, the Worker exports and the render Worker rasterizes, the
 * same bytes everywhere, or where it does not parse.
 *
 * Sanitizing is an allowlist: shapes, text, paint servers, markers, clips, masks and filters stay;
 * scripts, `foreignObject`, `<style>`, animation, images and anything else that runs, loads or
 * links is dropped (links unwrapped), as are event handlers, references outside the SVG (`href`
 * and `url()` may only name an `#id` in it) and any `javascript:`. Ids are prefixed when asked, so
 * two figures on a page never share one. Style attributes stay as attributes: the reader moves
 * them into the CSSOM (decisions/diagram-styles-through-cssom), so the shell's CSP holds.
 */

/** The largest SVG fence drawn, in characters (as `render`'s limit). */
export const SVG_MAX_SOURCE = 50_000;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Elements kept, by their name in the SVG namespace. */
const KEEP = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "title",
  "desc",
  "switch",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
  "linearGradient",
  "radialGradient",
  "stop",
  "pattern",
  "clipPath",
  "mask",
  "marker",
  "filter",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
]);

/** Elements dropped with what they hold, and what each is called when reported. */
const UNSAFE: Record<string, string> = {
  script: "scripts",
  foreignObject: "foreignObject",
  style: "<style> elements (use attributes)",
  image: "images",
  feImage: "images",
  iframe: "embedded content",
  embed: "embedded content",
  object: "embedded content",
  video: "embedded content",
  audio: "embedded content",
  canvas: "embedded content",
  animate: "animation",
  animateMotion: "animation",
  animateTransform: "animation",
  animateColor: "animation",
  set: "animation",
  discard: "animation",
  mpath: "animation",
};

/** Elements dropped quietly: editors' and metadata, which draw nothing. */
const QUIET = new Set(["metadata", "cursor", "view"]);

export type SvgCheck =
  | {
      ok: true;
      /** The sanitized SVG, standing alone (its own xmlns). */
      svg: string;
      /** What was taken out, as people say it, each once. */
      removed: string[];
      /** The root's `<title>`, for alt text when the fence gives none. */
      title: string | null;
    }
  | {
      ok: false;
      message: string;
      /** 1-based in the source; 0 when the problem has no place. */
      line: number;
      column: number;
    };

interface El {
  name: string;
  attrs: [string, string][];
  children: (El | string)[];
}

class XmlError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(s: string, at: number): string {
  return s.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);?/g,
    (m, e: string, i: number) => {
      if (!m.endsWith(";")) throw new XmlError(`"&" must start an entity such as &amp;`, at + i);
      if (e.startsWith("#x") || e.startsWith("#")) {
        const n = e.startsWith("#x") ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
        if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) {
          throw new XmlError(`${m} is not a character`, at + i);
        }
        return String.fromCodePoint(n);
      }
      const v = ENTITIES[e];
      if (v === undefined) throw new XmlError(`unknown entity ${m}`, at + i);
      return v;
    },
  );
}

const NAME = /[A-Za-z_][\w.:-]*/y;

/** XML to a tree: elements, attributes and text; comments, PIs and the doctype skipped. */
function parse(src: string): El {
  let i = 0;
  const stack: El[] = [{ name: "#root", attrs: [], children: [] }];
  let root: El | null = null;
  const top = () => stack[stack.length - 1] as El;
  const name = (): string => {
    NAME.lastIndex = i;
    const m = NAME.exec(src);
    if (!m) throw new XmlError("expected a name", i);
    i += m[0].length;
    return m[0];
  };
  const space = () => {
    while (i < src.length && /\s/.test(src[i] as string)) i++;
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const text = src.slice(i, lt < 0 ? src.length : lt);
    if (text) {
      if (stack.length === 1) {
        if (text.trim()) throw new XmlError("text outside the <svg> element", i);
      } else top().children.push(decode(text, i));
    }
    if (lt < 0) break;
    i = lt;
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end < 0) throw new XmlError("a comment is not closed", i);
      i = end + 3;
    } else if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      if (end < 0) throw new XmlError("a CDATA section is not closed", i);
      if (stack.length === 1) throw new XmlError("text outside the <svg> element", i);
      top().children.push(src.slice(i + 9, end));
      i = end + 3;
    } else if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end < 0) throw new XmlError("a processing instruction is not closed", i);
      i = end + 2;
    } else if (src.startsWith("<!", i)) {
      if (root) throw new XmlError("a declaration after the <svg> element", i);
      // A doctype; one with an internal subset (entity declarations) is not read.
      const end = src.indexOf(">", i);
      if (end < 0) throw new XmlError("a declaration is not closed", i);
      if (src.slice(i, end).includes("[")) {
        throw new XmlError("a DOCTYPE with declarations is not read", i);
      }
      i = end + 1;
    } else if (src.startsWith("</", i)) {
      const at = i;
      i += 2;
      const n = name();
      space();
      if (src[i] !== ">") throw new XmlError(`expected ">" to close </${n}>`, i);
      i++;
      const open = top();
      if (stack.length === 1 || open.name !== n) {
        throw new XmlError(
          stack.length === 1 ? `</${n}> closes nothing` : `</${n}> closes <${open.name}>`,
          at,
        );
      }
      stack.pop();
    } else {
      const at = i;
      i++;
      const el: El = { name: name(), attrs: [], children: [] };
      if (stack.length === 1 && root) throw new XmlError("a second top-level element", at);
      for (;;) {
        const before = i;
        space();
        if (src[i] === ">" || src.startsWith("/>", i)) break;
        if (i === before) throw new XmlError(`expected a space, ">" or "/>" in <${el.name}>`, i);
        const an = name();
        space();
        if (src[i] !== "=") throw new XmlError(`expected "=" after ${an}`, i);
        i++;
        space();
        const q = src[i];
        if (q !== '"' && q !== "'") throw new XmlError(`${an}'s value must be quoted`, i);
        const end = src.indexOf(q, i + 1);
        if (end < 0) throw new XmlError(`${an}'s value is not closed`, i);
        const raw = src.slice(i + 1, end);
        if (raw.includes("<")) throw new XmlError(`"<" in ${an}'s value`, i + 1 + raw.indexOf("<"));
        if (el.attrs.some(([k]) => k === an)) throw new XmlError(`${an} is given twice`, i);
        el.attrs.push([an, decode(raw, i + 1).replace(/[\t\n\r]/g, " ")]);
        i = end + 1;
      }
      top().children.push(el);
      if (stack.length === 1) root = el;
      if (src.startsWith("/>", i)) i += 2;
      else {
        i++;
        stack.push(el);
      }
    }
  }
  if (stack.length > 1) throw new XmlError(`<${top().name}> is not closed`, src.length);
  if (!root) throw new XmlError("no <svg> element", 0);
  return root;
}

const local = (n: string) => n.slice(n.indexOf(":") + 1);
const prefix = (n: string) => (n.includes(":") ? n.slice(0, n.indexOf(":")) : "");

/** `javascript:` however it is spelt: spaces, controls and case aside. */
const SCRIPTY = /j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i;

/** A value's `url(…)`s, each to an `#id` only (rewritten with the prefix); null when one is not. */
function internalUrls(value: string, idPrefix: string): string | null {
  let bad = false;
  const out = value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_m, _q, target: string) => {
    if (!/^#[\w.:-]+$/.test(target)) {
      bad = true;
      return "";
    }
    return `url(#${idPrefix}${target.slice(1)})`;
  });
  return bad || /url\(/i.test(out.replace(/url\(#[\w.:-]+\)/g, "")) ? null : out;
}

/** A style attribute kept declaration by declaration; what loads anything is dropped. */
function cleanStyle(css: string, idPrefix: string, removed: Set<string>): string {
  const kept: string[] = [];
  for (const part of css.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 1) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    let value = part.slice(colon + 1).trim();
    if (!/^-?[a-z][a-z-]*$/.test(prop) || !value) continue;
    // Nothing that could load or hide a load: escapes, `image-set("…")`, `src()`, any `//`.
    if (
      /expression\s*\(|@|behavior|binding|\\|image-set|image\s*\(|src\s*\(|\/\//i.test(part) ||
      SCRIPTY.test(value)
    ) {
      removed.add("unsafe styles");
      continue;
    }
    if (/url\(/i.test(value)) {
      const v = internalUrls(value, idPrefix);
      if (v === null) {
        removed.add("references outside the SVG");
        continue;
      }
      value = v;
    }
    kept.push(`${prop}:${value}`);
  }
  return kept.join(";");
}

function cleanAttrs(el: El, idPrefix: string, removed: Set<string>): [string, string][] {
  const out: [string, string][] = [];
  for (const [rawName, rawValue] of el.attrs) {
    let n = rawName;
    let v = rawValue;
    const p = prefix(n);
    if (p === "xmlns" || n === "xmlns") continue;
    if (p === "xlink" && local(n) === "href") n = "href";
    else if (p === "xml" && (local(n) === "space" || local(n) === "lang")) {
      // kept as is
    } else if (p) continue; // editors' own (inkscape:, sodipodi:, …)
    if (/^on/i.test(n)) {
      removed.add("event handlers");
      continue;
    }
    if (SCRIPTY.test(v)) {
      removed.add("javascript: links");
      continue;
    }
    if (n === "href") {
      if (!/^#[\w.:-]+$/.test(v.trim())) {
        removed.add("references outside the SVG");
        continue;
      }
      v = `#${idPrefix}${v.trim().slice(1)}`;
    } else if (n === "id") {
      v = `${idPrefix}${v}`;
    } else if (n === "style") {
      v = cleanStyle(v, idPrefix, removed);
      if (!v) continue;
    } else if (/url\(/i.test(v)) {
      const u = internalUrls(v, idPrefix);
      if (u === null) {
        removed.add("references outside the SVG");
        continue;
      }
      v = u;
    } else if (n === "src" || n === "action" || n === "formaction" || v.includes("://")) {
      removed.add("references outside the SVG");
      continue;
    }
    out.push([n, v]);
  }
  return out;
}

function clean(el: El, idPrefix: string, removed: Set<string>): (El | string)[] {
  const n = local(el.name);
  const ns = prefix(el.name);
  if (ns && ns !== "svg") return [];
  if (n === "a") {
    removed.add("links (their contents are kept)");
    return el.children.flatMap((c) => (typeof c === "string" ? [c] : clean(c, idPrefix, removed)));
  }
  const unsafe = UNSAFE[n];
  if (unsafe) {
    removed.add(unsafe);
    return [];
  }
  if (QUIET.has(n)) return [];
  if (!KEEP.has(n)) {
    removed.add(`unknown elements (<${n}>)`);
    return [];
  }
  const attrs = cleanAttrs(el, idPrefix, removed);
  // A <use> that names nothing in this SVG draws nothing; dropped with its reference.
  if (n === "use" && !attrs.some(([k]) => k === "href")) return [];
  return [
    {
      name: n,
      attrs,
      children: el.children.flatMap((c) =>
        typeof c === "string" ? [c] : clean(c, idPrefix, removed),
      ),
    },
  ];
}

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");

function serialize(el: El | string): string {
  if (typeof el === "string") return escText(el);
  const attrs = el.attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");
  if (el.children.length === 0) return `<${el.name}${attrs}/>`;
  return `<${el.name}${attrs}>${el.children.map(serialize).join("")}</${el.name}>`;
}

function textOf(el: El): string {
  return el.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
}

/** 1-based line and column of an offset. */
function place(src: string, at: number): { line: number; column: number } {
  const before = src.slice(0, Math.max(0, Math.min(at, src.length)));
  const lines = before.split("\n");
  return { line: lines.length, column: (lines[lines.length - 1] as string).length + 1 };
}

/**
 * Reads an SVG fence's source and sanitizes it. `idPrefix` is put before every id and every
 * reference to one (the reader passes one per figure; exports and renders none). `maxLength`
 * raises the size limit for SVG Tempra drew itself (a chart's, TEMPRA-207).
 */
export function sanitizeSvg(
  source: string,
  opts: { idPrefix?: string; maxLength?: number } = {},
): SvgCheck {
  const max = opts.maxLength ?? SVG_MAX_SOURCE;
  if (source.length > max) {
    return {
      ok: false,
      message: `it is longer than the limit of ${max} characters`,
      line: 0,
      column: 0,
    };
  }
  let root: El;
  try {
    root = parse(source);
  } catch (e) {
    if (e instanceof XmlError) return { ok: false, message: e.message, ...place(source, e.at) };
    throw e;
  }
  if (local(root.name) !== "svg" || (prefix(root.name) && prefix(root.name) !== "svg")) {
    return {
      ok: false,
      message: `the top element is <${root.name}>, not <svg>`,
      line: 1,
      column: 1,
    };
  }
  const removed = new Set<string>();
  const [cleaned] = clean(root, opts.idPrefix ?? "", removed) as [El];
  const attrs = cleaned.attrs.filter(([k]) => k !== "xmlns");
  // Sized by its viewBox, so it scales to the column; one from width and height when it has none.
  const has = (k: string) => attrs.find(([a]) => a === k)?.[1];
  const w = Number.parseFloat(has("width") ?? "");
  const h = Number.parseFloat(has("height") ?? "");
  if (!has("viewBox") && w > 0 && h > 0) attrs.push(["viewBox", `0 0 ${w} ${h}`]);
  cleaned.attrs = [["xmlns", SVG_NS], ...attrs];
  const titleEl = cleaned.children.find(
    (c): c is El => typeof c !== "string" && c.name === "title",
  );
  const title = titleEl ? textOf(titleEl).replace(/\s+/g, " ").trim() || null : null;
  return { ok: true, svg: serialize(cleaned), removed: [...removed], title };
}

/** A fence's attribute after its language, `name="…"` (or `'…'`, or one word). */
export function fenceAttr(meta: string | null | undefined, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)'|(\\S+))`).exec(meta ?? "");
  const t = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
  return t || null;
}
