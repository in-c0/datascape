// Request sanitization — spec V6.1.5 PR B §2.
//
// Split out of the old client so both sides of the boundary can share it
// without the browser half gaining a dependency on the privileged half. It
// deliberately holds no capability at all: it moves fields around.

/** Fields a caller may legitimately supply. Everything else is dropped. */
const CLIENT_FIELDS = [
  "draft_id", "policy_identity", "operation_id", "expected_authority_revision",
  "authorization_action", "draft", "goal_id", "scope_refs", "source_exception_id",
  // The opaque receipt from a host-prepared review. It is an IDENTIFIER, not a
  // capability: the host looks it up in its own store, so a forged one simply
  // does not resolve.
  "preview_receipt",
];

/** Fields a caller might supply that must NEVER influence authentication. */
export const SPOOFABLE_FIELDS = ["actor", "isOwner", "role", "authorizedBy", "owner", "principal", "credentials", "session"];

/**
 * Strip anything identity-shaped from a request payload.
 *
 * Not "validate and reject" — REMOVE. A rejected spoof is still a spoof that
 * reached the decision; a stripped one cannot be read by code written later
 * that forgets why the check was there.
 */
export function sanitizeClientRequest(payload = {}) {
  const request = {};
  for (const key of CLIENT_FIELDS) {
    if (payload[key] !== undefined) request[key] = payload[key];
  }
  const stripped_identity_fields = SPOOFABLE_FIELDS.filter((f) => payload[f] !== undefined);
  return { request, stripped_identity_fields };
}
