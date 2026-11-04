/**
 * @tempra/editor: page bodies without an editor (tempra-dev: app/markdown-bridge). The
 * stored tree and everything that works on it (`@tempra/editor/doc`, which the Worker imports),
 * plus the word diff the reader draws. DOM-free; the app renders the tree itself (app/reader).
 */
export { type WordDiff, wordDiff } from "./diff";
export * from "./doc";
