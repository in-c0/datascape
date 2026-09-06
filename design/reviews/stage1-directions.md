# Stage 1 — concept directions (ChatGPT temporary chat, High reasoning)

2026-09-06 ~13:25 Sydney (+10:00). Prompt = BRIEF.md condensed to one paragraph + the banned-defaults list + the ask for three directions. ChatGPT's reply, verbatim:

## 1. Ruling Rail

Thesis: Turn the existing temporal band into a seven-stop decision rail: the observatory remains visible, but today's unresolved rulings become its foreground constellation.

Mood / palette: Near-black #05060d; panel #0d101f; text #e8ecf6; muted #8b96b3; structural line #54628c47; decisive teal #5eead4; risk amber #e8c078; high-cost rose #e8a0a0; focus violet #a78bfa. Cyan #7dd3fc is reserved for metadata, never actions.

Type: IBM Plex Sans + IBM Plex Mono. Plex Sans has the compressed, operational tone of an instrument panel without looking like generic SaaS; Mono makes lane names, counts and technical titles visibly subordinate.

Layout signature: PC: slim "Needs you · 7 of 56" daily header overlays the existing hour band; below it, seven full-width ruling rows, varying naturally in height. Question left; two cost lines centre; 2–3 answer pills right. A narrow folded-by-kind rail follows; "Overtaken · 18" is a final collapsed seam. At 375px, each row becomes question → costs → full-width 44px answer row, all one thumb-scroll.

Motion: Selection travels like a signal along an existing thread: cubic-bezier(.2,.8,.2,1), 180–240ms. Reduced motion: immediate border/state swap.

Signature moment: Press Pay it: its record ring closes, a thin thread runs into a persistent "Batch · 1" node—visibly queued, not yet executed.

Lazy AI: Builds seven rounded mini-tickets with colored severity badges. This refuses ticket anatomy entirely: continuous rail, questions first, technical detail demoted.

## 2. Morning Brief

Thesis: Make Needs you read like a chief-of-staff briefing sheet laid over the observatory, with hierarchy coming from editorial typography rather than more containers.

Mood / palette: Ground #05060d; "paper-dark" field #0b0e19; text #f0f1ed deliberately warmer than the existing token; muted #939bb0; line #54628c47; teal #5eead4; amber #e8c078; rose #e8a0a0; violet #a78bfa only for keyboard focus.

Type: Source Serif 4 for questions + Source Sans 3 for controls/metadata. The serif makes each ask feel considered and human-authored; the sans keeps commands crisp. Technical titles use Source Sans 3 at small size, not faux-code styling.

Layout signature: PC: one translucent existing-style panel, not cards-within-cards. Header reads "Sunday · seven decisions worth interrupting you for." Seven asks are separated only by hairlines and numbered 1–7 in the margin. Costs sit directly beneath each question as aligned "YES" / "NO" clauses; answer pills live on the same baseline when space permits. Bottom two ruled lines are "More, folded by kind" and "Overtaken by events." Phone preserves exactly that document order; controls wrap beneath each ask.

Motion: Editorial, not spatial: ruled answer compresses 2px then resolves in 140ms, cubic-bezier(.16,1,.3,1). Folding uses 200ms measured height. Reduced motion: instant.

Signature moment: A ruling leaves behind a terse docket mark—QUEUED · approve · GitHub Actions ×3—while the remaining asks renumber immediately.

Lazy AI: Adds icons, progress rings and dashboards. This direction removes visual explanation until only consequential prose and rulings remain.

## 3. Decision Orbits

Thesis: Preserve Continuity's astronomy literally: seven asks are temporary foreground objects whose visual mass reflects cost of delay, while actions collapse them back into the underlying record graph.

Mood / palette: Existing #05060d, #0d101f, #e8ecf6, #8b96b3; orbit lines #54628c47; teal #5eead4; cyan #7dd3fc; amber #e8c078; rose #e8a0a0; focus violet #a78bfa. No gradients; illumination comes from borders and tiny point sources, never neon bloom.

Type: Söhne if licensed, otherwise Public Sans, paired with Recursive Mono Casual=0 for lane/time metadata. The grotesk gives questions authority; Recursive supplies technical precision without turning the whole product into developer tooling.

Layout signature: PC: the existing temporal band remains across the top quarter. Beneath it, seven horizontally offset decision slabs align to faint vertical "now" threads; higher cost-of-delay asks begin farther left and get slightly stronger edge weight—not bigger cards. Answers form a consistent right-hand ruling column. Folded kinds become one compact census line beneath. Overtaken items sit behind that line as a recessed strip. At 375px, orbital offsets disappear: a strict single column, tiny node/thread marker at left, controls underneath.

Motion: Objects resolve rather than disappear: 220ms cubic-bezier(.4,0,.1,1) inward contraction toward their originating node. Reduced motion swaps to an immediate "queued" state.

Signature moment: Rule a grouped ask and its three faint source threads converge into one teal batch tick: one decision visibly settles three histories.

Lazy AI: Makes a decorative space-themed dashboard with glowing planets. This uses observatory grammar only where it encodes provenance, grouping, urgency and settlement.

## Implementer's critique (sent back as the push-back)

- Ruling Rail fits the surface best, but overlaying the header on the hour band fights the band's job, and "Batch · 1" must not be a new node — the surface already has a ruling tray; the thread must run to it.
- Morning Brief has the strongest ten-second hierarchy (numbered margin = keyboard hint, hairlines not containers, YES/NO clauses, docket mark, renumbering); worry: serif on dark at phone sizes.
- Decision Orbits: most literal, least legible (offsets read as misalignment), Söhne not free.
- Asked for a MERGE: Brief's anatomy on Rail's structure, below the band, thread-to-tray as the signature moment — one spec with fonts (Google Fonts only), type scale, row anatomy at 1536 and 375, header copy with today's numbers, the two seams, read-only phone treatment, three motion moments with easings and reduced-motion fallbacks, colour rules, and a name.

## Convergence (ChatGPT, after the push-back) — chosen direction

**The Ruling Brief.** Thesis: An editorial decision sheet beneath the untouched temporal band: seven questions, no ticket chrome, with every ruling visibly handed to Continuity's existing tray.

- Typography (Google Fonts only): IBM Plex Sans + IBM Plex Mono. No serif. Plex Sans 600 for questions; Plex Mono for lane/title/id provenance. Questions never below 16/22 at 375.
- Type scale: header 13/18 600; question 18/24 600 desktop, 16/22 phone; YES/NO clauses 13/18 (450 requested; Plex ships 400/500, see DESIGN.md); metadata 11/16 400 Plex Mono; buttons 13/16 600.
- 1536 anatomy: band untouched; ONE outer panel (existing panel token, 14px radius) below it; grid 40px numeral / minmax(0,1fr) question / 336px answers, 20px gaps; question column stacks question, two cost clauses, metadata line "lane title · settles ids"; answers are 2 to 3 right-aligned pills, min 96x44.
- 375: 16px padding; 28px numeral + question; YES clause, NO clause, metadata, then actions at 44px min, no horizontal scroll.
- Header copy: "Needs you · Sunday 6 Sep · 50 decisions from 57 open · 7 shown · 43 folded · 3 overtaken".
- Seams: "43 folded · Money 6 · Command 5 · … Show" opens inline into grouped decision rows, never nested cards; "Overtaken by events · 3 Review" muted with a rose hairline marker; open state lists titles/reasons then one right-aligned "Dismiss all 3, one confirm" pill that queues three dismiss rulings into the existing tray.
- Phone read-only: no answer buttons, no dismiss control; one line under the header: "Read-only on phone · queue rulings from Continuity on your PC."
- Motion, exactly three moments: ruling queued 220ms cubic-bezier(.16,1,.3,1), row contracts 2px, thin teal thread grows from the answer edge to the tray, tray count increments (reduced: instant); fold open/close 180ms cubic-bezier(.2,.8,.2,1), measured height + chevron (reduced: instant); renumber 140ms cubic-bezier(.4,0,.2,1), rows translate, numerals change at start (reduced: reflow).
- Colour: #e8ecf6 question/action text; #8b96b3 costs/metadata; line token for structure; #e8c078 medium only; #e8a0a0 high cost/overtaken only; #a78bfa keyboard focus only; #7dd3fc provenance/thread-source only; teal #5eead4 the sole interactive accent (selected ruling, queued thread, tray handoff). No glow.
