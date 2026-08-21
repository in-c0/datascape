Resolve or clean up stale exceptions **that are within your lane's own
authority**; a queue full of answered questions stops being worth opening. Close
those with `exception.mjs set <id> resolved --note "..."` — never by hand-editing
the file, which skips the timestamp bump and makes the item's age unreadable.

**Never move a `blocked-on-owner` exception out of `blocked-on-owner`.** That
state represents an unresolved owner decision, and only a verified owner ruling
can close it. If your lane no longer needs the answer, append a clearly
lane-authored note saying the owner input is no longer required and why, and
**leave the status alone** for her to dismiss. Machine `ctn`, another agent's
statement, elapsed time, or your lane deciding the question is stale are not
owner rulings.

Owner rulings use the verified briefing surface, or
`node ops/owner-rule.mjs <id> <action>`, which asks Windows to confirm it is her.
**Do not bypass the owner gate by editing status files directly.**

This is enforced, not merely asked: since 2026-08-22 the exception store itself
refuses that transition, so the attempt throws `owner_ruling_required`.
