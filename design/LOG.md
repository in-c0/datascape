# Design log
Stage: 3 — building from DESIGN.md while Stage 2 renders land (hero done, storyboard generating, component sheet next); Stage 4 motion review to follow
Direction: The Ruling Brief (chosen 2026-09-06 ~13:40 after one push-back; see reviews/stage1-directions.md)
Regular ChatGPT chat used for renders (temporary chats cannot generate images): https://chatgpt.com/c/6a9cd8f0-7504-83ec-a183-9de653aa15d3 — owner may delete it once the concepts are saved

## Components
| component | build | review # | verdict | notes |
|---|---|---|---|---|
| Sheet header + read-only line | build-4 | — | static (no motion) | `Needs you · Sunday 6 Sep · 50 decisions from 57 open · 7 shown · 43 folded · 3 overtaken` |
| Decision row (question, YES/NO, metadata, ≤3 pills, numeral) | build-4 | — | static | grouped rows show `settles 3: 4580 90ac b822`; title in tooltip |
| Ruling queued (thread → tray, row contraction, body collapse, renumber) | build-4 | 1 (strips review-queue-1..3) | pending | 220ms + 140ms per DESIGN.md |
| Fold open/close ("43 folded" seam) | build-4 | 1 (strips review-fold-1..3) | pending | 180ms measured height; folded list capped to 64vh scroll |
| Overtaken seam + "Dismiss all 3 — one confirm" | build-4 | — | same fold motion as above | queues `dismiss` ×3 into the tray |
| Phone (375, read-only) | build-3-phone | — | static | stacked YES/NO, no buttons, one honest line |

## Open questions (ASK OWNER)
- **Thread timing authority (motion review 1, item 1).** The spec's `220ms cubic-bezier(.16,1,.3,1)` reaches the tray ~98% by 120 ms; the storyboard prompt said "halfway at 120 ms". Options: (a) keep the curve, fix the storyboard note — recommended, it is the direction's "signal along a thread"; (b) keep the halfway beat and change the thread to ~`cubic-bezier(.45,.15,.65,.85)`, slower and more mechanical. One word: "curve" or "halfway".
- References: keep the three stand-ins (Linear triage inbox, Things 3 Today, Braun/Rams instrument panel) or name your own? (build proceeded under the stand-ins)
- Phone: the read-only note once at the top (built) — or once per card?

## Session history
- 2026-09-06 13:0x — Data layer moved out of the hash-locked store into `_ship_inbox/ops/triage.mjs` (store restored byte-for-byte; ruling gate green). 37/37 triage selftests. All 56 live items authored with question / costs / choices / decision; 3 overtaken.
- 2026-09-06 13:1x — Stage 1 sent to a ChatGPT temporary chat (owner's Mac Chrome, High reasoning): brief + banned defaults + request for three directions.
- 2026-09-06 13:3x — Stage 1 push-back and convergence: The Ruling Brief. DESIGN.md written.
- 2026-09-06 13:5x–14:2x — Stage 2: hero, storyboard and component-sheet renders in the regular chat (not yet downloaded; owner permission pending). Stage 3 built from DESIGN.md: RulingBrief.jsx + ruling-brief.css, Plex fonts, mount at entry level ABOVE the temporal field (deviation recorded in DESIGN.md).
- 2026-09-06 14:3x–15:0x — Verified through headless Edge: read-only 5314 and live 5315 (ruling host on 5319, gate green). Seven rows on one screen at 874; phone 375 stacked; fonts loaded; no horizontal scroll. Frame series captured with paused animations at 20 ms for the queue and fold moments; strips `review-queue-1..4`, `review-fold-1..3`.
- 2026-09-06 15:1x — Stage 4: seven strips uploaded to a fresh temporary chat via the Mac Chrome (served over LAN from this PC on :8765, killed after the review); verdict pending.
- 2026-09-06 12:40 Sydney — owner: "build the triage view". Data layer built first (exception.mjs triage fields + `triage()` + CLI card; briefing.mjs `triage` section). UI to follow the workflow.
- 2026-09-06 13:20 — Stage 0: captures taken (desktop 1536×874, phone 375×812 via headless Edge), BRIEF.md written. Chrome available for the ChatGPT stages: the owner's Mac Chrome (connected to the extension).
