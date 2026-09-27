import { Hono } from "hono";

export { Library } from "./library";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true }));

export default app satisfies ExportedHandler<Env>;
