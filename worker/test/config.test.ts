import { describe, expect, test } from "bun:test";
import config, { deploymentFor, previewDeployment } from "../cloudflare.config";
import renderConfig from "../render/cloudflare.config";

/** The metering and rate-limit bindings one deployment gets from cloudflare.config.ts. */
async function counters(mode: string) {
  const worker = (await (
    await config({ isPreview: false, mode } as never)
  ).worker) as {
    env: Record<string, { name?: string; namespace?: string }>;
  };
  return {
    usage: worker.env.USAGE?.name,
    write: worker.env.WRITE_LIMITER?.namespace,
    request: worker.env.REQUEST_LIMITER?.namespace,
    session: worker.env.SESSION_LIMITER?.namespace,
  };
}

// TEMPRA-76: staging metered into production's dataset and shared its limiter namespaces.
describe("each deployment meters and rate-limits on its own", () => {
  test("production is unchanged", async () => {
    expect(await counters("production")).toEqual({
      usage: "tempra_usage",
      write: "1001",
      request: "1002",
      session: "1003",
    });
  });

  test("staging and previews share nothing with production or each other", async () => {
    const all = [
      await counters("production"),
      await counters("staging"),
      // The preview mode reads its ids from the environment; the deployment itself is the same.
      (({ usage, limiters }) => ({
        usage,
        write: limiters?.write,
        request: limiters?.request,
        session: limiters?.session,
      }))(previewDeployment("7")),
    ];
    for (const key of ["usage", "write", "request", "session"] as const) {
      const values = all.map((c) => c[key]);
      expect(new Set(values).size).toBe(values.length);
    }
    // No namespace is used twice anywhere, within a deployment or across them.
    const namespaces = all.flatMap((c) => [c.write, c.request, c.session]);
    expect(namespaces.every(Boolean)).toBe(true);
    expect(new Set(namespaces).size).toBe(namespaces.length);
    expect(all[1]?.usage).toBe("tempra_usage_staging");
  });
});

// TEMPRA-81: the blob sweep's queue, sent to and consumed by the same Worker, one per deployment.
describe("each deployment has its own sweep queue", () => {
  async function sweepQueue(mode: string) {
    const worker = (await (
      await config({ isPreview: false, mode } as never)
    ).worker) as {
      env: Record<string, { name?: string }>;
      triggers: { type: string; name?: string }[];
    };
    return {
      producer: worker.env.SWEEP_QUEUE?.name,
      consumer: worker.triggers.find((t) => t.type === "queue")?.name,
    };
  }

  test("production, staging and previews", async () => {
    expect(await sweepQueue("production")).toEqual({
      producer: "tempra-sweep",
      consumer: "tempra-sweep",
    });
    expect(await sweepQueue("staging")).toEqual({
      producer: "tempra-sweep-staging",
      consumer: "tempra-sweep-staging",
    });
    expect(previewDeployment("7").queue).toBe("tempra-sweep-pr-7");
  });
});

// TEMPRA-222: the managed agent's queue, beside the sweep's, one per deployment.
describe("each deployment has its own agent queue", () => {
  async function agentQueue(mode: string) {
    const worker = (await (
      await config({ isPreview: false, mode } as never)
    ).worker) as {
      env: Record<string, { name?: string }>;
      triggers: { type: string; name?: string; maxBatchSize?: number; maxRetries?: number }[];
    };
    const consumer = worker.triggers.find(
      (t) => t.type === "queue" && t.name === worker.env.AGENT_QUEUE?.name,
    );
    return {
      producer: worker.env.AGENT_QUEUE?.name,
      consumer: consumer?.name,
      batch: consumer?.maxBatchSize,
      retries: consumer?.maxRetries,
    };
  }

  test("production, staging and previews", async () => {
    expect(await agentQueue("production")).toEqual({
      producer: "tempra-agent",
      consumer: "tempra-agent",
      batch: 1,
      retries: 1,
    });
    expect((await agentQueue("staging")).producer).toBe("tempra-agent-staging");
    expect((await agentQueue("staging")).consumer).toBe("tempra-agent-staging");
    expect(previewDeployment("7").agentQueue).toBe("tempra-agent-pr-7");
  });
});

// TEMPRA-125: the landing page asks people to Request access while production is invite-only.
describe("the landing page's calls to action match production's SIGNUP", () => {
  test("invite in production: Request access and Sign in, never Sign up", async () => {
    const worker = (await (
      await config({ isPreview: false, mode: "production" } as never)
    ).worker) as { env: Record<string, unknown> };
    expect(JSON.stringify(worker.env.SIGNUP)).toContain("invite");
    const site = new URL("../../site/src/", import.meta.url);
    const file = (p: string) => Bun.file(new URL(p, site));
    if (!(await file("pages/index.astro").exists())) return; // worker/ built on its own
    for (const page of ["pages/index.astro", "layouts/Base.astro"]) {
      const text = await file(page).text();
      expect(text).toContain("/request-access");
      expect(text).toContain("/sign-in");
      expect(text).not.toMatch(/Sign up|Get started/);
    }
  });
});

// TEMPRA-165: each deployment has its own diagram render Worker, bound as RENDER, on its own bucket.
describe("each deployment has its own render Worker", () => {
  type Binding = { type?: string; worker?: string; exportName?: string; name?: string };
  async function workers(mode: string | undefined) {
    const main = (await (
      await config({ isPreview: false, mode } as never)
    ).worker) as {
      name: string;
      env: Record<string, Binding>;
    };
    const render = (await (
      await renderConfig({ isPreview: false, mode } as never)
    ).worker) as {
      name: string;
      domains?: string[];
      workersDev?: boolean;
      exports: Record<string, unknown>;
      env: Record<string, Binding>;
    };
    return { main, render };
  }

  test("production and staging: names, the binding and the bucket", async () => {
    for (const [mode, name] of [
      ["production", "tempra-render"],
      ["staging", "tempra-render-staging"],
    ] as const) {
      const { main, render } = await workers(mode);
      expect(render.name).toBe(name);
      expect(main.env.RENDER).toMatchObject({ worker: name, exportName: "Renderer" });
      // The render Worker caches in its deployment's own bucket, under renders/.
      expect(render.env.BLOBS?.name).toBe(main.env.BLOBS?.name as string);
      expect(render.env.BROWSER?.type).toBe("browser");
      expect(Object.keys(render.exports)).toEqual(["Renderer"]);
      // Reached only through the binding.
      expect(render.domains).toEqual([]);
      expect(render.workersDev).toBe(false);
    }
    expect(deploymentFor("production").render).toBe("tempra-render");
    expect(previewDeployment("7").render).toBe("tempra-render-pr-7");
  });

  test("no mode (cf dev, types, dry runs): no RENDER binding, so renders are unavailable", async () => {
    const { main, render } = await workers(undefined);
    expect(main.env.RENDER).toBeUndefined();
    expect(render.name).toBe("tempra-render");
  });

  test("a preview's render Worker is named by TEMPRA_PR, on the preview's bucket", async () => {
    const before = process.env.TEMPRA_PR;
    process.env.TEMPRA_PR = "42";
    try {
      // The render Worker needs no D1 or KV ids, so it resolves before they exist.
      const render = (await (
        await renderConfig({ isPreview: false, mode: "preview" } as never)
      ).worker) as { name: string; env: Record<string, Binding> };
      expect(render.name).toBe("tempra-render-pr-42");
      expect(render.env.BLOBS?.name).toBe("tempra-blobs-pr-42");
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "TEMPRA_PR");
      else process.env.TEMPRA_PR = before;
    }
  });
});

// TEMPRA-276 (tempra-dev decisions/the-app-at-tempra-dev.md): the app at the apex, app.tempra.dev
// an alias, www a redirect, the landing page bound as SITE. Built from the config alone, so a
// fresh account gets the same hosts from a deploy.
describe("hosts and the landing page", () => {
  async function worker(mode?: string) {
    return (await (
      await config({ isPreview: false, mode } as never)
    ).worker) as {
      domains: string[];
      env: Record<string, unknown>;
    };
  }

  test("production serves tempra.dev, keeps app.tempra.dev, redirects www", async () => {
    const w = await worker("production");
    expect(w.domains).toEqual(["tempra.dev", "app.tempra.dev", "www.tempra.dev"]);
    expect(w.env.APP_ORIGIN).toMatchObject({ value: "https://tempra.dev" });
    expect(w.env.ALIAS_HOSTS).toMatchObject({ value: "app.tempra.dev" });
    expect(w.env.REDIRECT_HOSTS).toMatchObject({ value: "www.tempra.dev" });
    expect(w.env.SITE).toMatchObject({ worker: "tempra-site" });
  });

  test("staging and previews have one host each and the same landing page", async () => {
    const w = await worker("staging");
    expect(w.domains).toEqual(["staging.tempra.dev"]);
    expect(w.env.SITE).toMatchObject({ worker: "tempra-site" });
    expect(previewDeployment("7")).toMatchObject({ host: "pr-7.tempra.dev", site: "tempra-site" });
    expect(previewDeployment("7").aliases).toBeUndefined();
  });

  test("local dev binds no site and attaches no host", async () => {
    const w = await worker();
    expect(w.domains).toEqual([]);
    expect(w.env.SITE).toBeUndefined();
  });
});
