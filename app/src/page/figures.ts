import { actorText } from "../agents";
import { api } from "../api";
import { hostOf } from "../pages/attachment";
import type { FigureView, ImageFacts } from "../reader/lightbox";
import { enc, type Urls } from "../urls";
import type { Namer } from "./byline";
import { actedBy, type FileJson, type HistoryEvent } from "./data";

/**
 * What the full-screen view says about a concept's images (tempra-dev: app/reader, Figures): the
 * concept's title, and for an image stored in the library its size, who added it, where it was
 * fetched from and what it shows (TEMPRA-170), asked for
 * once per image when the view first shows it. Made afresh when its inputs change (`$derived`).
 */
export function figureViewOf(urls: Urls, title: string, name: Namer): FigureView {
  const asked = new Map<string, Promise<ImageFacts | null>>();
  const describe = (path: string) => {
    let facts = asked.get(path);
    if (!facts) {
      facts = Promise.all([
        api<FileJson>(urls.api(`files/${enc(path)}`, { at: urls.at })),
        api<{ events: HistoryEvent[] }>(urls.api(`history/${enc(path)}`)),
      ]).then(
        ([file, history]) => {
          const added = [...history.events].reverse().find((e) => e.op !== "comment");
          const a = file.kind === "attachment" ? file : null;
          return {
            size: a ? a.size : null,
            media: a ? a.media : null,
            host: a?.source ? hostOf(a.source.url) : null,
            description: a?.description ?? null,
            by: added ? actorText(name(added.actor, actedBy(added))) : null,
            at: added?.ts ?? null,
          };
        },
        () => null,
      );
      asked.set(path, facts);
    }
    return facts;
  };
  return {
    title,
    describe,
    fileHref: (path: string) => urls.pinned(undefined).file(path),
    downloadHref: (path: string) => urls.download(path),
  };
}
