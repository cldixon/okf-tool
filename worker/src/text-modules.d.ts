/**
 * Markdown imported as text (`with { type: "text" }`): the MCP server's prompts (TEMPRA-314),
 * bundled by the `Text` rule in wrangler.config.ts.
 */
declare module "*.md" {
  const text: string;
  export default text;
}
