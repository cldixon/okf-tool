import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  types: {
    generate: false,
  },
  // The Worker's static assets (TEMPRA-174), written by the app's build (app/build.ts). Through
  // node_modules, so the path holds wherever this file is copied with node_modules beside it (the
  // gate's throwaway project under .gate/).
  assetsDirectory: "node_modules/@tempra/app/dist/public",
  // Markdown imported as text: the MCP server's prompts (src/mcp/prompts/, TEMPRA-314), each a
  // module of its own in the upload. The code imports them `with { type: "text" }`, which bun needs
  // (it renders a bare `.md` import to HTML).
  rules: [{ type: "Text", globs: ["**/*.md"], fallthrough: true }],
});
