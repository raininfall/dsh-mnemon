import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every test that reaches the global storage root — the review marker record, the
// reconcile ledger, storage probing — must land here instead of the developer's real
// ~/.mnemon. Tests that need a specific root override it with vi.stubEnv.
process.env.MNEMON_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'dsh-mnemon-test-home-'))
