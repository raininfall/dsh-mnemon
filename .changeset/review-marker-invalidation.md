---
"dsh-mnemon": minor
---

A new user message now ends a Session's reviewed state: the sidebar review marker disappears immediately and the Session's entry is removed from `state/review-markers.json`, so the next daily review owns the marker again. Assistant output and Mnemon's own injected messages leave the marker in place.
