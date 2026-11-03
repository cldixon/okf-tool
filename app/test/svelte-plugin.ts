/**
 * Lets `bun test` import Svelte (TEMPRA-176): `.svelte` components and `.svelte.ts` rune modules
 * compiled with svelte/compiler for the client, as Vite compiles them, so the tests mount them
 * into happy-dom. `bun test --conditions browser` (the package's test script) resolves `svelte`
 * to its client runtime. The filters match by extension wherever a file lives, so the design
 * package's components (`@tempra/design/components`, design/src/components/) compile the same way.
 */
import { plugin } from "bun";
import { compile, compileModule } from "svelte/compiler";

const ts = new Bun.Transpiler({ loader: "ts" });

plugin({
  name: "svelte",
  setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const out = compile(source, { filename: path, generate: "client", dev: false });
      return { contents: out.js.code, loader: "js" };
    });
    build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
      const source = ts.transformSync(await Bun.file(path).text());
      const out = compileModule(source, { filename: path, generate: "client", dev: false });
      return { contents: out.js.code, loader: "js" };
    });
  },
});
