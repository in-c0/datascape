// Composing the authority transaction for the deployed host.
//
// This is the piece that turns the reviewed parts into a thing she can use: the
// durable journal, the receipt store, the private exception adapter and the
// record construction, assembled once and handed to the HTTP surface as a
// single `transaction` object.
//
// Two boundaries are deliberate and load-bearing:
//
// 1. The private exception adapter is reached ONLY by the journal, from inside
//    a transaction. It is not an operation name, not a route, and not exported
//    from the host. A browser cannot address it, and neither can a CLI.
//
// 2. `atomic` — the writer that actually touches her exception files — is
//    INJECTED by the composing host rather than imported here. The repo and the
//    deployed tree have different layouts, and an import that only resolves in
//    one of them is how a security module silently becomes unreachable.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(path.join(HERE, name)).href);

const { createReceiptStore } = await load("authority-receipt.js");
const { createAuthorityJournal, createFileStorage } = await load("authority-journal.js");
const { createAuthorityStore } = await load("authority-store.js");
const { createAuthorityExceptionAdapter } = await load("authority-exception-adapter.js");
const { createCommitJournalPort, createJournalExceptionPort } = await load("authority-exception-port.js");
const { revisionOf } = await load("authority-operation.js");

/**
 * @param fs          node:fs, injected so tests can run against a temp tree
 * @param journalFile where the durable authority journal lives
 * @param inbox       the exception directory
 * @param atomic      the atomic exception writer (see boundary 2 above)
 * @param resolveDomain  () -> the authority domain this host is acting for.
 *                       HOST-DERIVED. The browser never names a lineage.
 */
export function createAuthorityTransaction({
  fs, journalFile, inbox, atomic, now = () => Date.now(), resolveDomain = () => null,
}) {
  const receipts = createReceiptStore({ now });

  const adapter = createAuthorityExceptionAdapter({ inbox, now, atomic });
  const exceptions = createJournalExceptionPort(adapter);

  const journal = createAuthorityJournal({
    storage: createFileStorage({ fs, path: journalFile }),
    exceptions,
    now,
  });

  // The record builder. `createAuthorityStore` owns how an authority record is
  // constructed and verified; using it here rather than re-deriving the shape
  // is what keeps ONE definition of what an authority IS.
  //
  // Its own `commit()` is not used: it opens a transaction, and this path needs
  // the write to sit inside the transaction that already holds the pre-prompt
  // claim and the presence consume.
  const store = createAuthorityStore({
    boundary: { verify: () => ({ ok: true }) },
    exceptions,
    now,
    storage: { read: () => [], append: () => {}, update: () => {} },
  });

  /** The revision a receipt's domain is currently at. Absence stays absence. */
  function currentRevision(receipt) {
    const domain = receipt.authority_domain ?? receipt.source_exception_id ?? null;
    if (!domain) return null;
    return journal.currentForDomain(domain);
  }

  const operations = createCommitJournalPort({
    journal, revisionOf, now, currentRevision,
    applyAuthority: (receipt) => store.buildFor({
      // Every field comes from the RECEIPT, which the host issued. This is the
      // same rule as the Windows prompt text: what she reviewed and what gets
      // written have to be one object.
      action: receipt.action,
      draft: receipt.draft ?? null,
      policy_identity: receipt.policy_identity ?? null,
      goal_id: receipt.goal_id ?? null,
      expected_revision: receipt.base_authority_revision ?? null,
      source_exception_id: receipt.source_exception_id ?? null,
      scope_refs: receipt.resulting_scope_refs ?? null,
    }, now()),
  });

  return {
    receipts,
    operations,
    journal,
    currentRevision,

    /**
     * Prepare a review.
     *
     * The domain is HOST-DERIVED and the read session is REQUIRED — issuing an
     * unbound receipt from the browser path has to be impossible rather than
     * dependent on a caller remembering an argument.
     */
    prepare({ body, authenticate }) {
      const auth = authenticate();
      if (!auth.ok) return { ok: false, failure: auth.failure, reason: auth.reason };
      const readSessionId = auth.context.read_session_id;

      const domain = resolveDomain();
      if (!domain) {
        return {
          ok: false, failure: "no_authority_domain",
          reason: "this host is not currently acting for an owner-gated authority domain",
        };
      }

      const action = typeof body?.authorization_action === "string"
        ? body.authorization_action : "authorize_goal";
      const amending = action === "narrow_authority" || action === "revoke_authority";
      const lineage = amending ? journal.currentForDomain(domain) : null;
      if (amending && !lineage) {
        return { ok: false, failure: "no_current_authority", reason: "there is no authority here to amend" };
      }

      const receipt = receipts.issue({
        draft: body?.draft ?? null,
        action,
        authorityDomain: domain,
        // Bound HOST-side. A browser cannot point a review at another domain.
        sourceExceptionId: amending ? null : domain,
        goalId: amending ? lineage.goal.goal_id : null,
        baseRevision: amending ? lineage.revision : null,
        resultingScopeRefs: amending
          ? (action === "revoke_authority" ? [] : (body?.scope_refs ?? []))
          : null,
        readSessionId,
      });
      if (receipt.read_session_id !== readSessionId) {
        return { ok: false, failure: "receipt_not_bound", reason: "the prepared review was not bound to this session" };
      }

      return {
        ok: true,
        preview_receipt: receipt.receipt_id,
        expires_at: receipt.expires_at,
        action: receipt.action,
        base_authority_revision: receipt.base_authority_revision,
        resulting_scope_refs: receipt.resulting_scope_refs,
      };
    },
  };
}
