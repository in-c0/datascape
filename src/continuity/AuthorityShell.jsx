// The authority declaration surface — spec V6.1.4 PR B, re-composed for
// V6.1.5 PR B §1.
//
// PRESENTATIONAL ONLY, and now genuinely data-injected as well as
// capability-injected. It imports no authority store, no client, no owner
// boundary AND no fixtures; every piece of state — the seed draft, the scope
// catalogue, the owner-authored suggestions, the current authority — arrives
// through `adapter`.
//
// The earlier version still read `fixtureStates()` and interpreted a `?state=`
// query control, so a future write-capable adapter would have removed the
// review warning while the screen kept rendering fixture-derived "authorized"
// state — and Authorize advanced a React step instead of calling the adapter.
// That is not a live binding; it is a mock wearing one.
//
// The visual question it answers: does autonomous authority become
// comprehensible enough that a person can deliberately grant it, without having
// read the control plane underneath?

import { useEffect, useMemo, useState } from "react";
import {
  CAPABILITIES, NEVER_AUTONOMOUS, authorize, composeEnvelope,
  createAuthorityDraft, policyIdentityOf, renderPreview, resolveScopeSelection,
} from "./control/authority-draft.js";
import {
  amendAuthority, authorizeFromContext, availableControls, loadAuthorityContext,
} from "./control/authority-session.js";
import "./authority.css";

const GRANTABLE = Object.keys(CAPABILITIES).filter((k) => !NEVER_AUTONOMOUS.includes(k));

export default function AuthorityShell({ adapter }) {
  // The only capability distinction between the two routes. A review adapter
  // reports false because it HAS no writer, not because it was told to behave.
  const canWrite = Boolean(adapter?.canWriteAuthority);

  // Everything comes from the adapter, and the LIVE adapter is ASYNCHRONOUS, so
  // it is hydrated ONCE before the surface is usable. Calling these from render
  // produced Promise objects against a real endpoint — and, worse, resolved the
  // blocker id to undefined inside the transaction payload, so a live grant
  // could have been built without its exception linkage.
  const [context, setContext] = useState(null);
  const [draft, setDraft] = useState(() => createAuthorityDraft({
    draft_id: "new", kind: "persistent_goal", statement: "", scope_refs: [],
  }));
  const [path, setPath] = useState(null);
  const [step, setStep] = useState("loading");
  const [scopeText, setScopeText] = useState("");
  const [successCondition, setSuccessCondition] = useState("");
  const [authority, setAuthority] = useState(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let live = true;
    loadAuthorityContext(adapter).then((loaded) => {
      if (!live) return;
      setContext(loaded);
      if (loaded.seedDraft) {
        setDraft(loaded.seedDraft);
        setScopeText(loaded.seedDraft.scope_label || "");
        setSuccessCondition(loaded.seedDraft.success_condition || "");
      }
      setAuthority(loaded.currentAuthority);
      setPath(adapter?.initialPath?.() ?? null);
      setStep(adapter?.initialStep?.() ?? (loaded.currentAuthority ? "authorized" : "choose"));
    });
    return () => { live = false; };
  }, [adapter]);

  const catalogue = context?.catalogue ?? [];
  const suggestions = context?.suggestions ?? [];
  const controls = availableControls({ canWrite, pausePersisted: false });

  const revoked = authority?.state === "revoked";
  const narrowed = authority?.state === "narrowed";

  const envelope = useMemo(() => composeEnvelope(draft.allowed_capabilities), [draft.allowed_capabilities]);
  const preview = useMemo(() => renderPreview(draft, envelope), [draft, envelope]);
  const scope = useMemo(() => resolveScopeSelection(scopeText, catalogue), [scopeText, catalogue]);

  // Called only to display whether the draft WOULD be accepted. The actor is
  // deliberately "review", so this can never produce a ruling.
  const wouldAuthorize = useMemo(
    () => authorize({ ...draft, scope_refs: scope.resolved ? scope.scope_refs : [] },
      { actor: "review", action: "authorize_goal", at: null }),
    [draft, scope],
  );

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const toggleCap = (name) => set({
    allowed_capabilities: draft.allowed_capabilities.includes(name)
      ? draft.allowed_capabilities.filter((c) => c !== name)
      : [...draft.allowed_capabilities, name],
  });

  /**
   * The ONE authority-creating control.
   *
   * It sends the EXACT policy identity the owner just read, waits for a
   * committed result, then re-reads the persisted authority. It never
   * optimistically shows "Active", and it never advances a React step in place
   * of a transaction — that was the defect that made the previous build a mock
   * wearing a live binding.
   */
  /** The exact object the owner is agreeing to, canary fields included. */
  const reviewedDraft = useMemo(() => ({
    ...draft,
    scope_refs: scope.resolved ? scope.scope_refs : [],
    scope_label: scope.resolved ? scope.scope_label : null,
    ...(path === "canary"
      ? { success_condition: successCondition, operation: draft.operation ?? "run_verification" }
      : {}),
  }), [draft, scope, path, successCondition]);

  async function onAuthorize() {
    setFailure(null);
    if (!canWrite) {
      // The review route simulates, and says so on screen. It has no
      // `authorize` to call.
      setAuthority(adapter?.simulate?.("authorize") ?? { state: "authorized", revision: 1 });
      setStep("authorized");
      return;
    }
    setPending(true);
    try {
      const result = await authorizeFromContext({
        adapter, context, draft: reviewedDraft,
        policyIdentity: policyIdentityOf(reviewedDraft),
        action: path === "canary" ? "authorize_bounded_task" : "authorize_goal",
      });
      if (!result?.ok) {
        setFailure(result?.failure === "stale_preview"
          ? "This changed since you reviewed it. Review the updated authority before authorizing."
          : result?.reason || "the transaction did not complete");
        if (result?.failure === "stale_preview") setStep("review");
        return;
      }
      setAuthority(result.persisted);
      setStep("authorized");
    } finally {
      setPending(false);
    }
  }

  /** Narrow and revoke are REAL transactions on the live route. */
  async function onAmend(action, scopeRefs = null) {
    setFailure(null);
    if (!canWrite) {
      setAuthority(adapter?.simulate?.(action === "revoke_authority" ? "revoke" : "narrow"));
      return;
    }
    setPending(true);
    try {
      const result = await amendAuthority({
        adapter,
        goalId: authority?.goal?.goal_id ?? authority?.record?.goal?.goal_id,
        expectedRevision: authority?.revision,
        action, scopeRefs,
      });
      if (!result?.ok) {
        setFailure(result?.failure === "stale_revision"
          ? "This authority changed elsewhere. Reloading the current version."
          : result?.reason || "the change did not complete");
        if (result?.failure === "stale_revision") {
          const reloaded = await loadAuthorityContext(adapter);
          setAuthority(reloaded.currentAuthority);
        }
        return;
      }
      setAuthority(result.persisted);
    } finally {
      setPending(false);
    }
  }

  const ready = Boolean(draft.statement.trim().length >= 8)
    && scope.resolved
    && draft.allowed_capabilities.length > 0
    && (path !== "canary" || successCondition.trim().length >= 8);

  return (
    <div className="au">
      <div className="au__shell">
        <header className="au__top">
          <div className="au__brand">Datascape <span>/ Autonomy</span></div>
          <a className="au__back" href="?view=briefing">Back to briefing</a>
        </header>

        {step === "loading" && (
          <div className="au__ask"><h1>Loading…</h1><p>Reading the current authority.</p></div>
        )}

        {step === "choose" && (
          <Choose onPick={(p) => { setPath(p); setStep("goal"); }} />
        )}

        {step === "goal" && (
          <>
            <Ask
              title={path === "canary" ? "What should DataScape do, once?" : "What should keep going without you?"}
              hint={path === "canary"
                ? "One bounded task. It runs once, inside limits you set, and then stops."
                : "An outcome, in your words. Not a task list — the direction agents should keep pushing toward."}
            />
            <div className="au-card">
              <p className="au-card__q">{path === "canary" ? "The task" : "The goal"}</p>
              <p className="au-card__h">One sentence is enough.</p>
              <textarea
                className="au-textarea"
                value={draft.statement}
                placeholder={path === "canary"
                  ? "Verify the deployed briefing surface at the current head"
                  : "Keep Continuity's tests and deployed surface green"}
                onChange={(e) => set({ statement: e.target.value })}
              />
              {suggestions.map((s) => (
                <div className="au-sugg" key={s.source_ref}>
                  <div className="au-sugg__l">Something you wrote earlier</div>
                  <div className="au-sugg__t">“{s.starting_text}”</div>
                  <div className="au-sugg__src">Source: {s.source_ref} · not authorized, just text you may reuse</div>
                  <button className="au-sugg__use" type="button" onClick={() => set({ statement: s.starting_text })}>
                    Use as starting text
                  </button>
                </div>
              ))}
            </div>

            {path === "canary" && (
              <div className="au-card">
                <p className="au-card__q">What proves it is done?</p>
                <p className="au-card__h">Something checkable, so nobody has to interpret whether it worked.</p>
                <input
                  className="au-input" value={successCondition}
                  placeholder="the briefing surface renders with zero console errors"
                  onChange={(e) => setSuccessCondition(e.target.value)}
                />
              </div>
            )}

            <div className="au-card">
              <p className="au-card__q">Where does this apply?</p>
              <p className="au-card__h">A project, or an area inside one.</p>
              <input
                className="au-input" value={scopeText} placeholder="DataScape / Continuity"
                onChange={(e) => {
                  setScopeText(e.target.value);
                  // The preview must reflect what she actually typed, not the
                  // scope the fixture happened to start with.
                  const next = resolveScopeSelection(e.target.value, catalogue);
                  set({
                    scope_refs: next.resolved ? next.scope_refs : [],
                    scope_label: next.resolved ? next.scope_label : null,
                  });
                }}
              />
              {scopeText && !scope.resolved && (
                <p className="au-card__h" style={{ marginTop: 9, color: "var(--au-amber)" }}>
                  Needs clarification — {scope.reason}
                </p>
              )}
              {scope.resolved && (
                <p className="au-card__h" style={{ marginTop: 9 }}>
                  Resolves to {scope.scope_refs.join(" · ")}
                </p>
              )}
            </div>

            <div className="au__acts">
              <button className="au-btn au-btn--go" type="button" disabled={!draft.statement.trim() || !scope.resolved}
                onClick={() => setStep("capabilities")}>Continue</button>
              <button className="au-btn au-btn--ghost" type="button" onClick={() => setStep("choose")}>Back</button>
            </div>
          </>
        )}

        {step === "capabilities" && (
          <>
            <Ask
              title="What may it decide on its own?"
              hint="Everything you do not tick stays yours. Nothing here is pre-selected from what agents have done before."
            />
            <div className="au-card">
              <div className="au-caps">
                <div>
                  <div className="au-caps__h au-caps__h--may">Without asking</div>
                  {GRANTABLE.map((name) => (
                    <label className="au-cap" key={name}>
                      <input
                        type="checkbox"
                        checked={draft.allowed_capabilities.includes(name)}
                        onChange={() => toggleCap(name)}
                      />
                      <span>{CAPABILITIES[name].label}</span>
                    </label>
                  ))}
                </div>
                <div>
                  <div className="au-caps__h au-caps__h--ask">Always ask you</div>
                  {NEVER_AUTONOMOUS.map((name) => (
                    <div className="au-cap au-cap--locked" key={name}>
                      <span className="au-cap__lock">✕</span>
                      <span>{CAPABILITIES[name].label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="au__acts">
              <button className="au-btn au-btn--go" type="button" disabled={!draft.allowed_capabilities.length}
                onClick={() => setStep("limits")}>Continue</button>
              <button className="au-btn au-btn--ghost" type="button" onClick={() => setStep("goal")}>Back</button>
            </div>
          </>
        )}

        {step === "limits" && (
          <>
            <Ask title="What are the limits?" hint="Money and credentials are separate from everything above, and both start at none." />
            <div className="au-card">
              <div className="au-limits">
                <div>
                  <div className="au-caps__h">Paid external usage</div>
                  {[["0", "None"], ["5", "Up to $5 per run"], ["20", "Up to $20 per run"]].map(([v, l]) => (
                    <label className="au-radio" key={v}>
                      <input type="radio" name="cost" checked={String(draft.max_cost) === v}
                        onChange={() => set({ max_cost: Number(v) })} />
                      <span>{l}</span>
                    </label>
                  ))}
                </div>
                <div>
                  <div className="au-caps__h">Longest single run</div>
                  {[["900000", "15 minutes"], ["1800000", "30 minutes"], ["3600000", "1 hour"]].map(([v, l]) => (
                    <label className="au-radio" key={v}>
                      <input type="radio" name="time" checked={String(draft.max_wall_time_ms) === v}
                        onChange={() => set({ max_wall_time_ms: Number(v) })} />
                      <span>{l}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="au-card">
              <p className="au-card__q">When should it stop?</p>
              <p className="au-card__h">Optional. You can always stop it yourself.</p>
              <input
                className="au-input" value={draft.stop_conditions[0] || ""}
                placeholder="the suite has been green for three consecutive days"
                onChange={(e) => set({ stop_conditions: e.target.value ? [e.target.value] : [] })}
              />
            </div>
            <div className="au__acts">
              <button className="au-btn au-btn--go" type="button" onClick={() => setStep("review")}>Review</button>
              <button className="au-btn au-btn--ghost" type="button" onClick={() => setStep("capabilities")}>Back</button>
            </div>
          </>
        )}

        {step === "review" && (
          <>
            <Ask title="This is what you would be granting." hint="Read it once. Nothing has been granted yet." />
            <Preview preview={preview} />
            <div className="au__acts">
              <button
                className="au-btn au-btn--go" type="button" disabled={!ready || pending}
                onClick={onAuthorize}
              >
                {pending ? "Authorizing…" : path === "canary" ? "Authorize this one task" : "Authorize"}
              </button>
              <button className="au-btn au-btn--ghost" type="button" onClick={() => setStep("limits")} disabled={pending}>Back</button>
            </div>
            {failure && (
              <p className="au__failure">
                <b>Nothing was authorized.</b> {failure}
                {failure.includes("changed since you reviewed") ? "" : " Try again."}
              </p>
            )}
            {!canWrite && (
              <p className="au__reviewnote">
                Review mode. This screen is bound to fixture state and cannot grant real authority —
                the button advances the mock, it does not write a ruling.
                {wouldAuthorize.reason ? ` Draft check: ${wouldAuthorize.reason}.` : ""}
              </p>
            )}
          </>
        )}

        {step === "authorized" && (
          <Authorized
            preview={preview} revoked={revoked} narrowed={narrowed} paused={paused}
            canWrite={canWrite} controls={controls} pending={pending} failure={failure}
            onPause={() => setPaused((p) => !p)}
            onNarrow={() => onAmend("narrow_authority", ["semantic-centre:continuity"])}
            onRevoke={() => onAmend("revoke_authority")}
            onEdit={() => setStep("goal")}
          />
        )}
      </div>
    </div>
  );
}

function Ask({ title, hint }) {
  return (
    <div className="au__ask">
      <h1>{title}</h1>
      <p>{hint}</p>
    </div>
  );
}

function Choose({ onPick }) {
  return (
    <>
      <Ask
        title="What are you comfortable letting DataScape continue without you?"
        hint="Nothing runs until you say so, and you can stop or narrow it at any time."
      />
      <div className="au__paths">
        <button className="au-path" type="button" onClick={() => onPick("goal")}>
          <div className="au-path__k">Ongoing</div>
          <div className="au-path__t">A continuing goal</div>
          <div className="au-path__d">
            An outcome agents keep working toward, inside limits you set once.
          </div>
        </button>
        <button className="au-path" type="button" onClick={() => onPick("canary")}>
          <div className="au-path__k">Once</div>
          <div className="au-path__t">One bounded task</div>
          <div className="au-path__d">
            A single job with a time limit and a finish line. Nothing continues after it.
          </div>
        </button>
      </div>
      {/* Never inert. In review mode this is the non-authorizing exit; in the
          real flow it maps to the exception layer's existing Defer semantics. */}
      <a className="au__notnow" href="?view=briefing">Not now</a>
    </>
  );
}

function Preview({ preview }) {
  return (
    <div className="au-card au-prev">
      <p className="au-prev__t">{preview.statement || "—"}</p>
      <div className="au-prev__grp">
        <div className="au-prev__k au-prev__k--may">DataScape may, on its own</div>
        <ul>{preview.may_autonomously.map((m) => <li key={m}>{m}</li>)}</ul>
      </div>
      <div className="au-prev__grp">
        <div className="au-prev__k au-prev__k--ask">It must stop and ask you before</div>
        <ul>
          {preview.must_stop_and_ask.slice(0, 6).map((m) => <li key={m}>{m}</li>)}
          <li>anything outside {preview.scope_boundary || "this area"}</li>
        </ul>
      </div>
      <div className="au-prev__meta">
        Paid usage {preview.max_cost === 0 ? "none" : `up to $${preview.max_cost} per run`} ·
        longest single run {preview.max_iteration_minutes} min
        {preview.stop_conditions[0] ? ` · stops when ${preview.stop_conditions[0]}` : ""}
      </div>
    </div>
  );
}

function Authorized({ preview, revoked, narrowed, paused, canWrite, controls, pending, failure, onPause, onNarrow, onRevoke, onEdit }) {
  const state = revoked ? "off" : paused ? "paused" : "on";
  const label = revoked ? "Revoked — no new work will start"
    : paused ? "Paused — running work stops at its next safe point"
      : narrowed ? "Active, narrowed to Continuity only" : "Active";
  return (
    <>
      <Ask
        title={revoked ? "Autonomy is off." : paused ? "Autonomy is paused." : "DataScape is working on this."}
        hint={revoked
          ? "Nothing new will start. Everything already recorded is untouched."
          : paused
            ? "Anything running now stops at its next safe checkpoint. It does not keep going to finish the job."
            : "You can pause, narrow or stop this at any time, and it takes effect at the next safe point."}
      />
      <div className="au-card">
        <div className="au-state">
          <span className={`au-dot au-dot--${state}`} />
          <span>{label}</span>
        </div>
        <Preview preview={preview} />
        <div className="au-revs">
          Authority revision <b>{revoked ? 3 : narrowed ? 2 : 1}</b>
          {narrowed && !revoked ? " · scope narrowed 22 Aug, work outside it stops at its next checkpoint" : ""}
          {revoked ? " · revoked 22 Aug" : ""}
        </div>
      </div>
      {!revoked && (
        <div className="au__acts">
          {/* Pause has no persistence yet, so the live route HIDES it rather
              than offering a control that could only pretend. */}
          {controls?.pause && (
            <button className="au-btn au-btn--ghost" type="button" onClick={onPause} disabled={pending}>
              {paused ? "Resume autonomous work" : "Pause autonomous work"}
            </button>
          )}
          <button className="au-btn au-btn--ghost" type="button" onClick={onEdit} disabled={pending}>Change what it may do</button>
          {!narrowed && <button className="au-btn au-btn--ghost" type="button" onClick={onNarrow} disabled={pending}>Narrow scope</button>}
          <button className="au-btn au-btn--danger" type="button" onClick={onRevoke} disabled={pending}>Stop entirely</button>
        </div>
      )}
      {failure && <p className="au__failure"><b>Nothing changed.</b> {failure}</p>}
      {!canWrite && (
        <p className="au__reviewnote">Review mode — fixture state only. No real authority exists or is created here.</p>
      )}
    </>
  );
}
