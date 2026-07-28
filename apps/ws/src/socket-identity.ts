import type { WebAuthorizationGranted } from "./web-authorize.js";

export interface EstablishedSocketIdentity {
  userId: string;
  isAnonymous: boolean;
}

/**
 * A socket keeps one identity for its entire lifetime. Switching between an
 * authenticated identity and an anonymous share-link identity can leak the
 * former into another project, so require a reconnect when the identity mode
 * changes. Authenticated sockets must also remain bound to the same user.
 */
export function isSocketIdentityCompatible(
  current: EstablishedSocketIdentity,
  authorization: WebAuthorizationGranted
): boolean {
  if (current.isAnonymous !== authorization.isAnonymous) return false;
  return current.isAnonymous || current.userId === authorization.userId;
}
