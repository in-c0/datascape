# DESIGN.md — The Ruling Brief (owner-queue triage view)

Direction chosen 2026-09-06 ~13:40 Sydney after Stage 1 (three directions, one push-back, one convergence — `reviews/stage1-directions.md`). Concept art from Stage 2 lives in `concepts/` and is referenced below as it lands.

## Thesis

An editorial decision sheet beneath the untouched temporal band: seven questions, no ticket chrome, every ruling visibly handed to Continuity's existing tray.

## Tokens

Existing surface tokens are reused; the view adds only what the sheet needs. All new tokens are prefixed `--rb-`.

| token | value | meaning on this view |
|---|---|---|
| `--bf-bg` | `#05060d` | ground (unchanged) |
| `--bf-panel` | `rgba(13,16,31,.97)` | the ONE outer sheet panel |
| `--bf-text` | `#e8ecf6` | question text, button labels |
| `--bf-muted` | `#8b96b3` | YES/NO clauses, metadata, seams, numerals |
| `--bf-line` | `rgba(84,98,140,.28)` | hairlines between rows, seam rules, pill borders |
| `--bf-teal` | `#5eead4` | the SOLE interactive accent: selected/queued ruling, the thread, the tray handoff |
| `--bf-amber` | `#e8c078` | "medium" severity mark only |
| `--rb-rose` | `#e8a0a0` | "high" severity mark and the overtaken marker only |
| `--bf-violet` | `#a78bfa` | keyboard focus ring only |
| `--bf-cyan` | `#7dd3fc` | provenance / thread-source detail only |
| `--rb-numeral` | `rgba(139,150,179,.72)` | margin numerals (muted, lighter) |
| `--rb-radius-sheet` | `14px` | the sheet (matches existing panels) |
| `--rb-radius-pill` | `999px` | answers (matches existing buttons) |
| `--rb-gap` | `20px` | grid column gap |
| `--rb-shadow` | `0 18px 50px rgba(0,0,0,.45)` | existing panel shadow |

Rules: no gradients, no glow, no blur beyond the existing panel backdrop, no icons, no emoji. One accent (teal). Rose and amber appear only as one-word severity marks and the overtaken rule.

## Type

Loaded from Google Fonts in `index.html` (`IBM Plex Sans` 400/500/600, `IBM Plex Mono` 400), with fallback stacks `"IBM Plex Sans", "Segoe UI", system-ui, sans-serif` and `"IBM Plex Mono", ui-monospace, Consolas, monospace`. Existing surface text outside the sheet is untouched.

| role | font | size/line | weight |
|---|---|---|---|
| sheet header | Plex Sans | 13/18 | 600, letter-spacing .02em |
| question (desktop ≥ 901) | Plex Sans | 18/24 | 600 |
| question (phone) | Plex Sans | 16/22 | 600 |
| YES / NO clauses | Plex Sans | 13/18 | 400 (ChatGPT asked 450; Plex on Google Fonts ships 400 and 500 — 400 chosen so clauses sit visibly under the 600 question) |
| clause label `YES` / `NO` | Plex Mono | 11/18 | 400, uppercase |
| metadata (lane title · settles ids) | Plex Mono | 11/16 | 400 |
| answer buttons | Plex Sans | 13/16 | 600 |
| seams | Plex Sans | 13/18 | 500 |
| numerals | Plex Mono | 13/16 | 400 |

## Layout

Desktop (≥ 901): the temporal band stays exactly as it is. The sheet begins below it, one outer panel (`--bf-panel`, 14px, hairline border, existing shadow), max-width 1180px, padding 18px 22px. Header line is the first row. Each decision row is a grid `40px minmax(0,1fr) 336px` with 20px gaps and a hairline above (first row none). Column 2 stacks: question → YES clause → NO clause → metadata. Column 3 right-aligns 2–3 pills, min 96×44, gap 8px. Rows have natural height.

Phone (≤ 900): padding 16px. Grid `28px minmax(0,1fr)`; answers move below the metadata as a wrapping row of full-height (≥ 44px) pills; no horizontal scroll at 375.

Seams: after row seven, a hairline seam `43 folded · Money 6 · Command 5 · … · Show ▾` (a button spanning the sheet). Open: grouped decision rows inline, in the same grid, never nested cards; closing restores the seam. Then `Overtaken by events · 3 · Review ▾` in muted text with a 2px rose rule at its left. Open: the technical titles and reasons, then one right-aligned `Dismiss all 3 — one confirm` pill; pressing it queues `dismiss` rulings into the existing tray; nothing mutates until Apply.

Read-only (no action API, i.e. the phone build): no answer buttons, no dismiss control, and one line under the header: `Read-only on phone · queue rulings from Continuity on your PC.`

Keyboard: 1–7 focus a row (violet ring on the numeral); the first letter of an answer label rules it; Esc closes an open seam. Screen readers: each row is `role="group"` labelled by its question; answers are buttons named `<label> — <question>`.

## Motion (exactly three moments)

| moment | duration | easing | transform | reduced-motion |
|---|---|---|---|---|
| ruling queued | 220ms | `cubic-bezier(.16,1,.3,1)` | row `scaleX(.997)` from the answer edge (reads as a 2px contraction) and a 1px teal thread (`--bf-teal`) grows from the pressed pill's right edge to the tray; the tray count increments as it arrives | instant queued state + count |
| fold open/close | 180ms | `cubic-bezier(.2,.8,.2,1)` | measured block height + seam chevron rotation only | instant |
| renumber after a ruling | 140ms | `cubic-bezier(.4,0,.2,1)` | remaining rows translateY into place; numerals change at motion start | immediate reflow |

Nothing else moves. No fade-in-on-scroll, no hover bounces; hover is a border-colour change only.

## Do / don't

- Do keep the temporal band, header bar, footer dial and the ruling tray exactly as they are; the sheet is the only new element.
- Do let the question be the largest text on the sheet; the lane's technical title lives on the metadata line, one level down.
- Do show the ids a grouped decision settles (`settles 3 · b822 90ac 4580`).
- Don't nest a card inside the sheet; rows are separated by hairlines only.
- Don't colour buttons by severity; severity is one small word on the metadata line.
- Don't introduce a second accent; violet is focus, teal is action.
- Don't render answers when there is no action API; render the one honest line instead.

## Concept images (Stage 2)

Three renders, generated 2026-09-06 13:55–14:15 Sydney in the regular ChatGPT chat https://chatgpt.com/c/6a9cd8f0-7504-83ec-a183-9de653aa15d3 (image generation is unavailable in temporary chats). Saving the files into `concepts/` needs the owner's download permission (asked in the hand-off); until then the chat is the record and the captures below describe them.

1. **Hero, desktop** (`concepts/hero-desktop.png`, pending download): header bar, ~120px temporal band with hour ticks and four ring nodes, then the sheet — header line `Needs you · Sunday 6 Sep · 50 decisions from 57 open · 7 shown · 43 folded · 3 overtaken`, seven hairline rows with margin numerals, question / YES and NO clauses on one line / mono metadata, 2–3 right-aligned pills per row, row 1's first pill teal-outlined with a 1px teal thread curving down to the tray pill `Batch mode · 1 queued · Apply 1, one confirm`; seams `43 folded · Money 6 · Command 5 · Access 6 · Ruling 8 · Show` and `Overtaken by events · 3 · Review` with a rose marker. Build deviation recorded below.
2. **Motion storyboard** (`concepts/storyboard.png`, pending): six panels at 0 / 60 / 120 / 220 / 360 / 540 ms — idle; first pill pressed, row contracted 2px; thread most of the way to the tray; thread arrived, tray reads `1 queued · Apply 1, one confirm`; row collapsed to the teal docket line `QUEUED · Started it · sumzup/digest-pipeline` with the next row renumbered to 1; folded seam opening with rotated chevron and two revealed rows. _Correction after motion review 1: the render prompt said "halfway at 120 ms", which the canonical curve cannot do (`cubic-bezier(.16,1,.3,1)` is ~98% complete at 120 ms). The curve is canonical; the panel reads "most of the way"._
3. **Component sheet** (`concepts/components.png`, pending): header; decision row in default / keyboard-focused (violet ring on the numeral) / hover (teal border on the first pill) / queued (docket line); pill states default / first-choice teal / pressed faint-teal fill; YES/NO clauses; metadata lines with `high` in rose and `medium` in amber; folded seam closed and open; overtaken seam closed and open with `Dismiss all 3, one confirm`; phone variant with the read-only line and no buttons; tray pill empty and with three queued.

## Deviations from the concept, and why

- **Sheet above the temporal field, not below it.** The render assumed a ~120px band. The real entry field is four placed rows of 92px (~520px), so a sheet beneath it started 600px down at 874px tall — the first question below the fold. Decisions first is the reason the sheet exists; the field follows intact.
- **Clause weight 400, not 450.** IBM Plex Sans on Google Fonts has no 450.
- **Month "Sep"** assembled from an en-US month token; en-AU renders "Sept".
