---
"dsh-mnemon": minor
---

Mark reviewed conversations in DSH's session sidebar: a filled check on a session row means the daily review already handled it and it is safe to archive; an outlined check means the conversation continued after that review and waits for the next one. A session the review found too short to judge gets the filled mark too, so nothing without a reason is left unmarked. A fresh session's first eligible turn now runs the review the same day instead of waiting for the next clock time, so restarting DSH no longer skips a day of review. The record lives in `state/review-markers.json` in the storage root and leaves the machine through neither Packs nor Git sync.
