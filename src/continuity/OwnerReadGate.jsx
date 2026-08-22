// The owner-read gate — the surface for parts 4 and 5, and the thing the
// governing lane is being asked to look at.
//
// PRESENTATIONAL AND CLIENT-INJECTED, for the same reason `AuthorityShell` is:
// the earlier authority surface read fixtures directly and interpreted a
// `?state=` query control, so a screen could render "authorized" from a fixture
// while sitting on a write-capable adapter. A gate with that flaw would be
// worse — it would draw an unlocked window over a host that never verified her.
//
// So this component holds no fetch, no path and no session. It renders what a
// client tells it, and the FIXTURE client and the LIVE client are different
// modules reached from different routes.
//
// Four states, and the reason each is drawn separately:
//
//   LOCKED    she has not opened the door. Unlock is the only control.
//   UNLOCKED  a finite window, shown as a countdown, with the standing fact
//             that reads are permitted and every mutation asks again.
//   PREPARED  a review the host has prepared, showing the EXACT words Windows
//             will use — supplied by the host, never composed here.
//   EXPIRED   the window closed. Nothing was written. This is not an error and
//             it is not "locked"; it is the outcome of a timer she can see.

import { useCallback, useEffect, useRef, useState } from "react";
import { gateStateFrom } from "./control/owner-read-state.js";
import "./owner-gate.css";

function remaining(expiresAt, now) {
  if (!expiresAt) return null;
  return Math.max(0, expiresAt - now);
}

function clock(ms) {
  if (ms === null) return null;
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export default function OwnerReadGate({ client, now = () => Date.now(), sawOpenSession = false, children }) {
  const [status, setStatus] = useState(null);
  const [asking, setAsking] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const [tick, setTick] = useState(() => now());
  // Only the browser can know it once held a live window, which is what makes
  // "expired" sayable at all. It is a label for her, never an authorization:
  // nothing downstream reads it.
  const sawOpen = useRef(sawOpenSession);

  const refresh = useCallback(async () => {
    const next = await client.status();
    if (next.ok && next.open) sawOpen.current = true;
    setStatus(next);
    return next;
  }, [client]);

  useEffect(() => { refresh(); }, [refresh]);

  // The countdown is a SECOND-HAND, not a clock with authority. When it reaches
  // zero the gate asks the host what is true rather than declaring the session
  // over on its own arithmetic — the host's expiry is the only one that governs,
  // and a browser that decided for itself could just as easily decide the other
  // way.
  useEffect(() => {
    if (!status?.ok || !status.open) return undefined;
    const id = setInterval(() => {
      const at = now();
      setTick(at);
      if (status.expires_at && at >= status.expires_at) refresh();
    }, 1000);
    return () => clearInterval(id);
  }, [status, refresh, now]);

  const state = status === null ? "checking" : gateStateFrom(status, { sawOpenSession: sawOpen.current });

  const unlock = async () => {
    setAsking(true);
    setRefusal(null);
    const result = await client.unlock();
    setAsking(false);
    if (!result.ok) {
      setRefusal(result);
      return;
    }
    sawOpen.current = true;
    setStatus({ ok: true, open: true, expires_at: result.expires_at, permits: result.permits });
    setTick(now());
  };

  const lock = async () => {
    await client.lock();
    // Deliberately re-ask rather than assume: if the lock did not take, showing
    // her a locked screen over a live session is the wrong way to be wrong.
    await refresh();
  };

  const left = status?.open ? remaining(status.expires_at, tick) : null;

  return (
    <div className="og">
      <div className="og__shell">
        <header className="og__top">
          <div className="og__brand">Datascape <span>/ Owner controls</span></div>
          <a className="og__back" href="?view=briefing">Back to briefing</a>
        </header>

        {state === "checking" && (
          <section className="og__card og__card--quiet">
            <h1 className="og__h">Checking…</h1>
            <p className="og__p">Asking the host whether this browser holds a session.</p>
          </section>
        )}

        {state === "unavailable" && (
          <section className="og__card og__card--quiet" data-gate="unavailable">
            <h1 className="og__h">Owner controls are not being served.</h1>
            <p className="og__p">
              This is not a lock state. The host that verifies you is not answering
              {status?.status ? ` (${status.status})` : ""}, so nothing here can be unlocked —
              and nothing here has been written.
            </p>
          </section>
        )}

        {state === "locked" && (
          <section className="og__card" data-gate="locked">
            <div className="og__badge og__badge--locked">Locked</div>
            <h1 className="og__h">Owner controls are locked.</h1>
            <p className="og__p">
              Unlocking asks Windows to verify it is you. If it does, this browser — and
              only this browser — can read your authority context and prepare reviews for
              five minutes.
            </p>
            <p className="og__p og__p--fine">
              Reading is all it buys. Authorising, narrowing, revoking and every ruling on a
              blocker asks you again, at the moment of the write.
            </p>
            <button className="og__go" type="button" onClick={unlock} disabled={asking}>
              {asking ? "Waiting for Windows…" : "Unlock owner controls"}
            </button>
            {refusal && (
              <p className="og__refusal">
                {refusal.failure === "prompt_budget_exhausted"
                  ? "Too many verification prompts in a short window. This is a guard against prompt fatigue — try again shortly."
                  : refusal.failure === "owner_controls_origin_incompatible"
                    ? "This host is not configured to keep an owner session for the page you are on, so it refuses rather than opening one it cannot retain."
                    : `Windows did not verify you (${refusal.failure}).`}
                {refusal.reason ? ` ${refusal.reason}` : ""}
              </p>
            )}
          </section>
        )}

        {state === "expired" && (
          <section className="og__card" data-gate="expired">
            <div className="og__badge og__badge--expired">Window closed</div>
            <h1 className="og__h">Your five minutes ran out.</h1>
            <p className="og__p">
              Nothing was written. The window is fixed at five minutes and reading does not
              extend it, so a long review ends here rather than quietly staying open.
            </p>
            <button className="og__go" type="button" onClick={unlock} disabled={asking}>
              {asking ? "Waiting for Windows…" : "Unlock again"}
            </button>
          </section>
        )}

        {state === "unlocked" && (
          <>
            <section className="og__card og__card--open" data-gate="unlocked">
              <div className="og__badge og__badge--open">Unlocked</div>
              <h1 className="og__h">Owner controls are open for {clock(left)}.</h1>
              <p className="og__p">
                This browser can read your authority context and prepare reviews. It cannot
                authorise anything: every write asks Windows again, immediately before it
                happens.
              </p>
              <div className="og__row">
                <div className="og__meter" aria-hidden="true">
                  <span style={{ width: `${Math.max(0, Math.min(100, (left / (5 * 60 * 1000)) * 100))}%` }} />
                </div>
                <button className="og__lock" type="button" onClick={lock}>Lock now</button>
              </div>
              <p className="og__p og__p--fine">
                Closing this browser, restarting the host, or unlocking somewhere else ends
                this window immediately.
              </p>
            </section>
            {children}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The prepared-review panel.
 *
 * `promptPreview` is the host's OWN prompt text, computed from the receipt it
 * will commit. It is not derived here, and if the host did not send one this
 * refuses to draw the panel — a browser-composed description of a dialog is a
 * place where what she reads and what she authorises can differ, which is the
 * exact failure this whole transaction exists to prevent.
 */
export function PreparedReview({ prepared, onConfirm, onDiscard }) {
  if (!prepared?.prompt_preview) {
    return (
      <section className="og__card og__card--warn" data-gate="prepared-unavailable">
        <h1 className="og__h">This review cannot be shown.</h1>
        <p className="og__p">
          The host prepared something but did not say what Windows will ask. Rendering our own
          description of that dialog would let the words you read and the change you approve
          drift apart, so this refuses instead.
        </p>
      </section>
    );
  }
  return (
    <section className="og__card og__card--review" data-gate="prepared">
      <div className="og__badge og__badge--review">Prepared review</div>
      <h1 className="og__h">{prepared.title || "Ready for your verification"}</h1>
      <p className="og__p">
        Confirming shows the Windows dialog below. It is written by the host from the exact
        change it will make — not by this page.
      </p>
      <pre className="og__prompt">{prepared.prompt_preview}</pre>
      {prepared.scope_refs?.length ? (
        <ul className="og__scope">
          {prepared.scope_refs.map((ref) => <li key={ref}>{ref}</li>)}
        </ul>
      ) : null}
      <p className="og__p og__p--fine">
        This review is bound to this browser session. If the window closes, or the authority
        changes underneath it, the confirmation is refused and nothing is written.
      </p>
      <div className="og__row">
        <button className="og__go" type="button" onClick={onConfirm}>Confirm with Windows</button>
        <button className="og__lock" type="button" onClick={onDiscard}>Discard</button>
      </div>
    </section>
  );
}
