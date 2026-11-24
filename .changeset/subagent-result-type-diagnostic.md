---
"dsh-mnemon": patch
---

A rejected child result now names the JSON type and the value it actually carried, as in `result.checks[0].index must be an integer, received the string "1"`, so a delegated child can see what it sent instead of resubmitting the same payload. The child's completion protocol also states that a number or boolean stays bare in the result JSON.
