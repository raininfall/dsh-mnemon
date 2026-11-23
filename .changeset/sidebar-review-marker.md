---
"dsh-mnemon": minor
---

Mark reviewed conversations in DSH's session sidebar: a filled check on a session row means the daily review already handled it and it is safe to archive; an outlined check means the conversation continued after that review and waits for the next one. A session the review found too short to judge gets the filled mark too, so nothing without a reason is left unmarked. A session that already existed at the most recent daily occurrence still runs that occurrence's review on its first eligible turn, so restarting DSH no longer skips a day of review; a session created after the occurrence treats it as handled and waits for the next clock time instead of reviewing its own first turn. The record lives in `state/review-markers.json` in the storage root and leaves the machine through neither Packs nor Git sync.
