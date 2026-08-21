# Continuity worker lanes — the Auto Run lane contract

Status: **v1, promoted from the 2026-08-21 overnight run**
Supersedes nothing in [`CONTINUITY-V0.md`](CONTINUITY-V0.md); it fills the gap that
document names as the current native-ChatGPT limitation.

## What changed

`CONTINUITY-V0.md` states the boundary plainly:

> Continuity cannot assume a supported API exists to open arbitrary existing
> ChatGPT conversations, retrieve exact live transcripts, inject messages into
> them, or programmatically spawn new branch chats.

On the night of 2026-08-20→21 that boundary was crossed, not by an API, but by a
**Claude Code Auto Run session driving the conversation as an operator**. Four
ran concurrently against one ChatGPT Plus account. They were not monitors: they
verified claims against the repository before answering, withheld merges, found
defects the worker's own green suite had missed, and filed owner-gated items as
exceptions.

That is the missing actuator. This document makes it a contract.

## The lane

A **lane** is one long-running ChatGPT conversation under machine supervision,
plus the Claude Code session that drives it.

```text
owner ─ gives a chat link ─▶ lane bootstrap ─▶ Auto Run session ─┬─▶ ctn to the worker
                                                                 ├─▶ verification on real state
                                                                 ├─▶ must-read per tick
                                                                 └─▶ exception when she is needed
```

One lane owns one conversation. A lane survives the session that drives it: on
2026-08-21 the PersonalOS thread changed hands mid-run and the catch-up surface
must still show one continuous lane, not two truncated ones.

## Lane bootstrap (owner directive, 2026-08-21)

A lane starts when the owner supplies a ChatGPT link. The link she gives is
**not** the conversation the loop then drives.

1. **Branch off the last message** as at the moment she gave the link — or off
   the specific message she points to when she rules one out. ("Ignore the Tim
   Ferris DSSS framework message" ⇒ branch off the last *Break further down*
   message instead.)
2. **The original is now the Seed.** It is frozen: a snapshot of what the lane
   was told at birth. It is never driven again.
3. **Save both links** in the lane manifest. A seed link that exists only in a
   chat message is gone by morning.
4. **Rename the branch** to `Auto Run: {original chat name}`, so the sidebar
   shows at a glance which conversations are under machine control.
5. **Only then start `ctn`**, and only against the branch.

The branch point matters because `ctn` is state-relative. A loop driving the
original would keep re-reading her exploratory turns as live instruction.

> A share id is **not** a conversation id. `/c/<share-id>` answers "You don't
> have access to this conversation" even signed in as the owner. Share links
> stay on `/share/`; the driveable conversation id is recovered from the share
> payload's `backing_conversation_id`.

## Operating rules, as they were actually learned

These are not proposals. Each one cost something on 2026-08-21.

- **Never send while the thread is generating.** A square stop button means
  generating. A `ctn` sent mid-generation is lost or interleaved.
- **Send with the composer's send button, not Enter.** Enter is intercepted by
  the auto-mode classifier.
- **Type one paragraph, with no newlines.** The composer sends on the first
  newline: a three-paragraph message delivered only paragraph one, and a merge
  authorisation, two-device evidence and a bug report were all lost.
- **Verify before you claim.** Every `ctn` that asserts tests pass must be
  backed by a run against real state in the same tick. A fully green suite is
  not a security review — that lesson cost 3.4 hours of a DNS-rebinding hole on
  master.
- **A timeout is a soft signal.** Do not retry; wait for the next tick and let
  the worker re-infer state. (`CONTINUITY-V0.md`, unchanged.)
- **Never authorise on the owner's behalf.** When the worker asks for merge
  authority, say plainly in-thread that the `ctn` is machine-sent and is not the
  instruction it is waiting for, then file the ask as an exception.
- **Keep the merge action on one side.** "You now have merge authority via me"
  was ambiguous enough to be read as self-merge permission. The rule that held:
  *the worker implements and pushes; the driver alone merges, after verifying.*
- **On any rate-limit or usage-cap banner, the newest lane stops first** and
  yields the remaining quota to the older ones.

## Every tick is owner-facing

**The finding that reshaped this contract.** All four lanes that ran overnight
emitted **zero** `### Must-read` blocks. Not one, across four transcripts.

They were not being negligent. The must-read rule applies to owner-facing
messages, and nobody was awake, so there was no message to end. Everything they
learned went into `_hub/reviews/*-ctn-babysitter-log.md` — readable only by
opening four separate files and scrolling.

So the rule changes:

> **In a ctn loop, every tick is owner-facing.** The loop is not writing to a
> person who is awake; it is writing to a catch-up surface she will read later.
> A tick that produced nothing worth a line has not earned a must-read — but a
> tick that verified, merged, found, or blocked has.

Capture is automatic. A `Stop` hook persists the block from the transcript at
the end of every turn, so this does not depend on a session remembering to call
anything — the failure mode that killed the PM lane and that left ~25 sessions
running against rules they had never loaded.

## What a lane owes the surface

| Obligation | Where it lands |
|---|---|
| A must-read per meaningful tick | captured automatically from the turn |
| An owner-gated ask | a `blocked-on-owner` exception — **never** a chat message |
| Atomic steps for that ask | the exception's `## Owner steps` section |
| Both conversation links | the lane manifest |
| Evidence for any claim | commits, PRs, probe output, exception ids |

The catch-up surface is a **read**. It is not a second action queue: its action
half is a rendering of the exception inbox, read live, so nothing can appear
there that is not already in the one list she reads daily. That constraint is
deliberate — a second owner surface is exactly what killed the PM lane.

## Next: `ctn` on the supervisor

Today the supervisor is a person: the owner decides which lanes exist and when.
The lanes themselves are autonomous.

The next step is to apply the same primitive one level up — a Datascape /
Continuity conversation that is itself an Auto Run lane, whose bounded action
each tick is to **operate the other lanes** rather than to write code:

```text
                 ┌──────────────────────────────┐
   ctn ──────────▶ Auto Run: Datascape/Continuity│  supervisor lane
                 └──────────────┬───────────────┘
                                │ reads the briefing document
                                │ allocates / reprioritises / escalates
                 ┌──────────────┼──────────────┐
                 ▼              ▼              ▼
            lane: A         lane: B        lane: C     worker lanes
```

The supervisor's tick is bounded to observation and allocation:

- read the briefing document (lanes, ages, owner actions, congestion signals);
- decide which lane is starved, blocked, or duplicating another;
- write that allocation to `ops/continuity/` as an artifact;
- escalate to an exception when the next step is the owner's.

**It must not gain new powers by being called a supervisor.** The self-building
rule in `CONTINUITY-V0.md` still binds: Continuity Stable may operate work that
builds Continuity Candidate, and the Candidate must not modify the active policy
while that policy is evaluating it. Concretely, the supervisor lane may
recommend a change to the worker-lane contract; it may not edit this file during
a run.

Promotion criteria, before the supervisor lane drives anything:

1. two consecutive nights where worker lanes emit must-reads without manual
   prompting;
2. an owner-action queue where the majority carry authored atomic steps;
3. a demonstrated case of the supervisor detecting a starved or duplicated lane
   that a human would also have called.
