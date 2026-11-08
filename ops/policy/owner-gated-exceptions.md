Resolve or clean up stale exceptions only when the transition is within the
lane's own authority.

Never move a `blocked-on-owner` exception out of `blocked-on-owner`.
That state represents an unresolved owner decision and may only be closed by a
verified owner ruling.

If the lane no longer needs the answer, append a clearly lane-authored note
saying that owner input is no longer required and why. Leave the status
unchanged for the owner to dismiss.

Machine `ctn`, another agent's statement, elapsed time, or the lane deciding
that the question is stale are not owner rulings.

Owner rulings use the verified briefing surface or verified owner-ruling CLI.
Do not bypass the owner gate by directly editing exception status.
