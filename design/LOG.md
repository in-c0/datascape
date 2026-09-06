# Design log
Stage: 3 — building from DESIGN.md while Stage 2 renders land (hero done, storyboard generating, component sheet next); Stage 4 motion review to follow
Direction: The Ruling Brief (chosen 2026-09-06 ~13:40 after one push-back; see reviews/stage1-directions.md)
Regular ChatGPT chat used for renders (temporary chats cannot generate images): https://chatgpt.com/c/6a9cd8f0-7504-83ec-a183-9de653aa15d3 — owner may delete it once the concepts are saved

## Components
| component | build | review # | verdict | notes |
|---|---|---|---|---|
| TriageCard (question + yes/no costs + ≤3 answer buttons) | — | — | — | maps to existing ruling classes; queues to the tray |
| DecisionGroup (N exceptions → one card) | — | — | — | data from `triage.top[].ids` |
| FoldStrip (past-seven, by kind) | — | — | — | opens on demand; keyboard Esc closes |
| OvertakenStrip ("Dismiss all N — one confirm") | — | — | — | fills the tray with `dismiss` rulings |
| DailyCard header (counts, cap, later) | — | — | — | |

## Open questions (ASK OWNER)
- References: keep the three stand-ins (Linear triage inbox, Things 3 Today, Braun/Rams instrument panel) or name your own?
- Phone: the read-only note once at the top, or once per card?

## Session history
- 2026-09-06 13:0x — Data layer moved out of the hash-locked store into `_ship_inbox/ops/triage.mjs` (store restored byte-for-byte; ruling gate green). 37/37 triage selftests. All 56 live items authored with question / costs / choices / decision; 3 overtaken.
- 2026-09-06 13:1x — Stage 1 sent to a ChatGPT temporary chat (owner's Mac Chrome, High reasoning): brief + banned defaults + request for three directions.
- 2026-09-06 12:40 Sydney — owner: "build the triage view". Data layer built first (exception.mjs triage fields + `triage()` + CLI card; briefing.mjs `triage` section). UI to follow the workflow.
- 2026-09-06 13:20 — Stage 0: captures taken (desktop 1536×874, phone 375×812 via headless Edge), BRIEF.md written. Chrome available for the ChatGPT stages: the owner's Mac Chrome (connected to the extension).
