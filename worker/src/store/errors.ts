/** An error with an HTTP status, rendered as `{ error, code, detail }` (spec: HTTP API conventions). */
export class OkfError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }

  toJSON() {
    return { error: this.message, code: this.code, ...this.extra };
  }
}

export const notFound = (path: string) => new OkfError(404, "not_found", `No file at ${path}.`);
