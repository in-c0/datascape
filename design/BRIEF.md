# Design brief — owner-queue triage view (Stage 0)

Written 2026-09-06 ~13:20 Sydney (+10:00) by the implementing session, from the live surface and the owner's words. Owner directive: "build the triage view" (12:40), after an ELI5 of the 56-item blocked-on-owner queue and a six-point interface proposal she accepted.

## What it is

The **Needs you** half of the Continuity briefing (Datascape app, `?view=briefing`), re-rendered as *decisions* instead of files. It is not a new surface: rule 3 of the portfolio contract forbids new owner surfaces, and every button on it is one of the six existing owner-ruling classes (approve / done / no / need context / defer / dismiss) routed through the existing ruling tray and its one Windows prompt. The data already exists: `node _ship_inbox/ops/exception.mjs triage --json` returns the document; the briefing JSON now carries it as `triage`.

Six behaviours it must carry (accepted by the owner 06/09):

1. **At most three fixed answers per ask, as buttons.** Labels are plain words the lane authored ("Pay it · Skip · Later"). One tap queues one ruling. Defaults when a lane authored none: Yes, do it / No / Later (or Done / No / Later when there is nothing to approve).
2. **Group by decision, not by file.** Three "GitHub Actions billing" exceptions are one card; the card settles every id under it.
3. **Overtaken by events.** Lane-flagged items fold into one strip with a single "Dismiss all N — one confirm". Nothing is hidden; her ruling still closes them.
4. **Cost-of-delay order, capped at seven.** Deadline inside two days beats everything, then outages, then money-blocked work, then one-command unblocks; age only breaks ties. Everything past seven folds by kind (money 9 · command 6 · …) and opens on demand.
5. **The question in plain words**, with "yes costs / no costs" as the two lines under it. The lane title stays available one level down, as does the proposal and the evidence.
6. **A daily card, not a 56-line list.** The whole of Needs-you fits one screen on her PC and one thumb-scroll on her phone.

## Who, where, when

- One user: the owner. Solo founder in Sydney running ~15 autonomous lanes. She opens this first thing in the morning and between sessions, for 10–30 seconds at a time, with low attention and no patience for reading.
- **PC** (Windows, `localhost:5313`, 1536×874 typical): actionable. Rulings are queued to the tray and applied with one Windows Hello prompt for the batch.
- **Phone** (375–430 wide, `ctn-briefing.pages.dev`): read-only static build refreshed by a script. She reads, she does not act, and the view must say so without nagging.
- Lighting/context: night (dark room, the surface is already dark) and daytime desk. Both.

## The one feeling

**Decisive.** Opening it should feel like being handed a short, honest list by a chief of staff who already did the reading — never like opening a ticket queue.

## Existing surface (must stay coherent with it)

Captures: `design/current/briefing-desktop-1536x874.png`, `design/current/briefing-phone-375x812.png`.

- A dark "observatory": near-black ground (`--bf-bg #05060d`), a temporal band across the width with hour ticks, stars, and record nodes as glowing rings with thread fans. Panels are translucent navy (`--bf-panel rgba(13,16,31,.97)`), 14 px radius, soft deep shadow.
- Palette tokens already on the surface: text `#e8ecf6`, muted `#8b96b3`, line `rgba(84,98,140,.28)`, amber `#e8c078` (medium), red-ish `#e8a0a0` (high), teal `#5eead4` (approve / ok), cyan `#7dd3fc`, violet `#a78bfa` (focus / on-state).
- Controls: pill buttons (999 px) with hairline borders, 8 px chips, 12.5 px labels; a "Brief me in: 30 sec · 3 min · Full" selector; a bottom pager "+6 quieter · 1/3" and a detail dial.
- Motion today: 200 ms card-in, a slow ring pulse on the focal node, reduced-motion honoured.
- Typography: the surface's own stack (see briefing.css); the wider app is monospace. Whatever the direction chooses must load a real font with a fallback stack.

## References the owner has already endorsed (from the record)

- The current Continuity surface itself — she signed it off in August; the direction must read as the same instrument, not a replacement.
- "Show, don't tell" and "depth over breadth" are standing owner rules: no explanatory prose, real derived insight (the ordering and grouping ARE the insight).
- Hates (standing): generic admin dashboards (sidebar + topbar + cards), purple-to-pink gradients, emoji as icons, marketing copy, anything that could belong to any product.

Owner to confirm or replace: two or three external references she likes (proposed for her yes/no: Linear's triage inbox for keyboard-first density; Things 3 "Today" for a calm capped list; an instrument panel — Braun/Rams — for hierarchy without decoration).

## Hard constraints

- React 18 + Vite, no new dependencies; CSS in `src/continuity/briefing.css`; tokens extend the `--bf-*` family.
- Every button maps to one existing ruling class; "Dismiss all" fills the existing tray (batch ≤ 20 per prompt — a larger strip pages).
- Read-only mode (no `VITE_BRIEFING_API`) must render the same view with the buttons replaced by the existing "Read-only — launch with node …catchup.mjs" note, once, not per card.
- Keyboard: number keys 1–7 focus a card, then the first letters of the three answers rule it; Esc closes a fold. Screen-reader: each card is a `group` named by its question.
- `prefers-reduced-motion`: all motion collapses to instant state changes.
- Phone: no horizontal scroll at 375; the seven cards stack; folds are tap targets ≥ 44 px.
- Performance: no extra network requests; the document is already in `store.briefing`.

## Data contract the view renders

```
triage: {
  counts: { open, live, decisions, top, folded, later, overtaken, high, olderThan7d, authored },
  top:    [ { key, question|null, title, authored, severity, kind, costOfDelay, yesCosts, noCosts,
              choices:[{action,label}] (≤3), hasProposal, expires, oldestDays, loops, ids,
              items:[{ id, title, loop, severity, opened, ageDays, expires, question, proposed, steps }] } ],
  folded: [ same shape ], foldedByKind: [ { kind, count, keys } ],
  later:  [ { id, title, loop, until } ],
  overtaken: [ { id, title, loop, at, reason, choices:[{action:"dismiss",label}] } ]
}
```

## Gate

Owner confirms this brief in one line, or the implementer proceeds under these stated assumptions: (a) the direction extends the existing observatory rather than replacing it; (b) the three proposed references stand in for hers until she names her own; (c) "decisive" is the feeling.
