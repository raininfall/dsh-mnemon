---
"dsh-mnemon": minor
---

Review stored sessions that have no loaded Agent. At `idleReview.at` the Host now sweeps up to `idleReview.sweepMaxPerRun` sessions that are not archived and have no turn in progress, resumes each one, reviews it against its stored checkpoint, and disposes the resumed Agent; `idleReview.sweepEnabled` turns the sweep off. Sessions handled through their own per-session clock are skipped, and a failed review keeps that occurrence open for the next sweep. A sweep works through the longest-waiting sessions first and lets a skipped session leave the run's budget to the next candidate, so a backlog drains. The Status page lists the sessions the daily rule still owes under **Awaiting review** and reviews one on request, even when its per-session clock already handled that occurrence; the `idle-review-queue` and `idle-review-now` endpoints of the review RPC channel serve that list and request.
