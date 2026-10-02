import type { Accounts, LibraryRef, User } from "./accounts";
import type { TokenInfo } from "./auth";
import { OkfError } from "./store/errors";

/**
 * The one place that decides whether a caller may reach a library (v2 spec: Tenancy and
 * authorization). Routes resolve {owner}/{slug} through here and never compare IDs themselves.
 * A library the caller cannot reach is answered exactly like one that does not exist: 404.
 *
 * Phase A: a signed-in person reaches the libraries they own; a token reaches its own library.
 * Phase B adds members with roles here, without touching routes.
 */
export type Caller = { user: User } | { token: TokenInfo };

export function noLibrary(owner: string, slug: string): OkfError {
  return new OkfError(404, "no_library", `There is no library ${owner}/${slug}.`);
}

export async function authorizeLibrary(
  accounts: Accounts,
  caller: Caller,
  owner: string,
  slug: string,
): Promise<LibraryRef> {
  if ("token" in caller) {
    const lib = caller.token.library;
    if (lib.owner && lib.owner === owner && lib.slug === slug) return lib;
    throw noLibrary(owner, slug);
  }
  const ref = await accounts.library(owner, slug);
  if (!ref || ref.ownerId !== caller.user.id) throw noLibrary(owner, slug);
  return { id: ref.id, slug: ref.slug, do_id: ref.do_id, owner: ref.owner };
}
