/**
 * The changes panel's entry (TEMPRA-291, a spike; tempra-dev app/source-diff): connects to the
 * host through ext-apps' `App`, follows the host's light or dark, and draws the diff a `diff`
 * result brings. app/build.ts bundles it into the panel's one document.
 */
import { App, applyDocumentTheme, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { changesFrom, mountChangesPanel } from "./changes";

const app = new App({ name: "Tempra changes", version: "1.0.0" }, {}, { autoResize: true });
const root = document.getElementById("panel") as HTMLElement;

const theme = (ctx: McpUiHostContext | undefined) => {
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
};

const panel = mountChangesPanel(root, {
  scheme: () => app.getHostContext()?.theme ?? "system",
});

app.ontoolresult = (result) => panel.show(changesFrom(result));
app.onhostcontextchanged = () => {
  theme(app.getHostContext());
  panel.redraw();
};
await app.connect();
theme(app.getHostContext());
