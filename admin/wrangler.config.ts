import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  types: {
    generate: false,
  },
  // The design stylesheet, its fonts and the icon, written by build.ts.
  assetsDirectory: "dist/public",
});
