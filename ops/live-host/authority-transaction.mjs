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
import crypto from "node:crypto";
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
const draftMod = await load("authority-draft.js");
const { composeEnvelope, createAuthorityDraft, renderPreview } = draftMod;
const { promptForReceipt } = await load("authority-commit.js");
const domainMod = await load("authority-domain.js");
const { publicBlocker, readExceptionIndex, resolveAuthorityDomain, scopeCatalogue } = domainMod;

/**
 * @param fs          node:fs, injected so tests can run against a temp tree
 * @param journalFile where the durable authority journal lives
 * @param inbox       the exception directory
 * @param atomic      the atomic exception writer (see boundary 2 above)
 * @param authorityLoop  the loop whose exception IS the authority domain.
 *                        HOST-DERIVED. The browser never names a lineage.
 */
export function createAuthorityTransaction({
  fs, journalFile, inbox, atomic, now = () => Date.now(),
  authorityLoop = process.env.CONTINUITY_AUTHORITY_LOOP || null,
}) {
  const receipts = createReceiptStore({ now });

  // Host-minted draft ids. Random rather than derived from the browser's input,
  // so two separately prepared grants of the SAME text still get distinct
  // durable identities — they are two authorizations, not one.
  const mintId = () => crypto.randomBytes(12).toString("base64url");

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

  /**
   * The domain, resolved fresh on every call from her real exception files.
   *
   * Not cached. A cached domain would keep pointing at a blocker after the file
   * moved, was renamed, or was resolved somewhere else, and the surface would
   * go on describing a world that no longer exists.
   */
  function domain() {
    const entries = readExceptionIndex({ fs, inbox, parseException: atomic.parseException });
    const resolved = resolveAuthorityDomain({
      entries,
      loop: authorityLoop,
      hasLineage: (id) => Boolean(journal.currentForDomain(id)),
    });
    return { ...resolved, entries };
  }

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
      // The HOST-AUTHORED draft, carrying the host-minted `draft_id` the
      // durable goal and ruling identities are built from. `receipt.draft` did
      // not exist, so this used to pass null and every initial grant was
      // refused by the record builder before it could be written.
      draft: receipt.prepared_draft ?? null,
      policy_identity: receipt.policy_identity ?? null,
      goal_id: receipt.goal_id ?? null,
      expected_revision: receipt.base_authority_revision ?? null,
      source_exception_id: receipt.source_exception_id ?? null,
      scope_refs: receipt.resulting_scope_refs ?? null,
      // THE REAL CURRENT RECORD, from the durable outer journal. The store's own
      // journal is a dummy in this composition, so without this narrow and
      // revoke would look up an authority that is never there.
      existing: receipt.goal_id ? journal.current(receipt.goal_id) : null,
    }, now()),
  });

  /**
   * THE READ SURFACE.
   *
   * Every operation resolves the domain itself rather than accepting one, so
   * there is no argument a browser could supply to change which authority it is
   * reading. Each returns a NAMED refusal when the domain is not exactly one,
   * because a surface that quietly picked a candidate would be showing her
   * somebody else's decision.
   */
  const reads = {
    context() {
      const found = domain();
      if (!found.ok) {
        return {
          ok: false, failure: found.failure, reason: found.reason,
          candidates: found.candidates ?? null,
        };
      }
      return {
        ok: true,
        authority_domain: found.domain,
        blocker: publicBlocker(found.entry),
        // Found by originating exception, so it keeps resolving AFTER the grant
        // has resolved that blocker.
        current: journal.currentForDomain(found.domain),
        catalogue: scopeCatalogue(found.entries),
        // Deliberately empty rather than invented. Owner-authored suggestions
        // are hers; this host has none to offer and says so.
        suggestions: [],
        suggestions_reason: "no owner-authored suggestions exist for this domain yet",
      };
    },

    current() {
      const found = domain();
      if (!found.ok) return { ok: false, failure: found.failure, reason: found.reason };
      return { ok: true, authority_domain: found.domain, current: journal.currentForDomain(found.domain) };
    },

    blocker() {
      const found = domain();
      if (!found.ok) return { ok: false, failure: found.failure, reason: found.reason };
      return { ok: true, authority_domain: found.domain, blocker: publicBlocker(found.entry) };
    },

    catalogue() {
      const found = domain();
      const entries = found.entries ?? readExceptionIndex({ fs, inbox, parseException: atomic.parseException });
      return { ok: true, catalogue: scopeCatalogue(entries) };
    },

    suggestions() {
      return {
        ok: true, suggestions: [],
        reason: "no owner-authored suggestions exist for this domain yet",
      };
    },
  };

  return {
    receipts,
    operations,
    journal,
    currentRevision,
    domain,
    reads,

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

      const found = domain();
      if (!found.ok) {
        return {
          ok: false, failure: found.failure, reason: found.reason,
          candidates: found.candidates ?? null,
        };
      }
      const domainId = found.domain;

      const action = typeof body?.authorization_action === "string"
        ? body.authorization_action : "authorize_goal";
      const amending = action === "narrow_authority" || action === "revoke_authority";
      const lineage = amending ? journal.currentForDomain(domainId) : null;
      if (amending && !lineage) {
        return { ok: false, failure: "no_current_authority", reason: "there is no authority here to amend" };
      }

      // THE DURABLE IDENTITY IS MINTED HERE, by the host.
      //
      // `goal:<draft_id>` and `owner-ruling:<draft_id>:rev<n>` are built from
      // the draft id, and the React form sends the literal string "new". Left
      // alone, every authorization this machine ever granted would share one
      // durable goal identity. Whatever the browser sends is overwritten, so
      // there is nothing to trust and nothing to validate.
      let preparedDraft = null;
      if (!amending) {
        if (!body?.draft) {
          return { ok: false, failure: "no_draft", reason: "an initial grant needs a draft to review" };
        }
        try {
          preparedDraft = createAuthorityDraft({
            ...body.draft,
            draft_id: `prepared:${mintId()}`,
          });
        } catch (error) {
          return { ok: false, failure: "invalid_draft", reason: error.message };
        }
      }

      const receipt = receipts.issue({
        draft: preparedDraft,
        action,
        authorityDomain: domainId,
        // Bound HOST-side. A browser cannot point a review at another domain.
        sourceExceptionId: amending ? null : domainId,
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

      // THE HOST'S OWN PRESENTATION, and the host's own prompt text.
      //
      // `prompt_preview` is produced by the SAME function the commit path hands
      // to the verifier, so the words she reads here and the words Windows shows
      // are one string by construction rather than by two implementations
      // agreeing. The surface refuses to draw a prepared review without it.
      const envelope = composeEnvelope(receipt.normalized_policy?.allowed_capabilities ?? []);
      return {
        ok: true,
        preview_receipt: receipt.receipt_id,
        expires_at: receipt.expires_at,
        action: receipt.action,
        base_authority_revision: receipt.base_authority_revision,
        resulting_scope_refs: receipt.resulting_scope_refs,
        // Presentation, not authority: everything needed to render the review
        // and nothing the browser could act on. `read_session_id` is host-
        // private and never appears here.
        preview: receipt.normalized_policy
          ? { ...renderPreview(receipt.normalized_policy, envelope) }
          : null,
        prompt_preview: promptForReceipt(receipt),
      };
    },
  };
}
