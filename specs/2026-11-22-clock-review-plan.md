# 钟点审查（Clock Review）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 dsh-mnemon 的空闲审查（idle review）与技能复盘（skill evolution）从“回合结束后空闲计时”改为“每天固定本地钟点触发 + 错过补跑”，审查内容、资格判定、写入规则、admission 与限制不变。

**Architecture:** 每个 Agent 持有一个墙上时钟 timer，按 `idleReview.at`（默认 `00:00`，Host 本地时区）排到下一次发生时刻；到点把 due 记入内存并尝试执行。审查是否真正运行仍由现有 `idleReviewAllowed`、活动分、`reviewAdmission`（上一回合 open step 获得）与 `maxPerSession` 决定；`minIntervalMs` 作为防重复护栏，若到点仅因间隔不足则排一次短重试。新增每会话的 `lastHandledDueAt` 持久化（不依赖 `persistWatermark`），会话下次加载时若发现最近一个钟点未处理且 24 小时内，补跑一次。技能复盘复用同一个 `at`，不新增配置字段，轨迹窗口仍在内存，不做跨重启补跑。

**Tech Stack:** TypeScript（strict，ESM）、Node >= 20（本机 v24.22.1）、pnpm 11、vitest、tsdown、schemastery（`@deepseek-ai/schemastery`）、React 客户端设置页。无新运行时依赖。

**设计文档:** `specs/2026-11-22-clock-review-design.md`（已获用户批准）。

**仓库:** `/Users/rain/lab/dsh-mnemon`，fork 自 `omdsh-dev/dsh-mnemon`，远程 `origin` 指向 `raininfall/dsh-mnemon`。所有提交都在新分支 `feat/clock-review` 上，最后开 PR。

---

## 全局约束

- `idleReviewMs` 保留解析与 `ResolvedConfig` 字段（旧配置不报错），但不再参与调度；文档标记 deprecated。
- 不改 `review-activity.ts`、`review-admission.ts`、`review-tools.ts` 的评分/准入/写入规则。
- 时钟时间只用 `HH:MM` 24 小时制，Host 本地时区；v1 不支持 IANA 时区（与 `skills.autoAdoptTimeZone` 的 `local` 行为一致）。
- 不新增运行时依赖；延续 `idle-review-watermark.ts` 的原子写 + 锁 + 大小校验模式。
- 失败要显式：配置里的非法 `at` 在解析时抛错；时钟状态文件损坏时不阻塞审查，仅警告并当作首次运行。
- 每个任务结束跑该任务的测试并提交；最后跑 `pnpm run verify`。
- 提交信息用 Conventional Commits，不加 AI 署名。

---

### Task 0: 分支与依赖

**Files:** 无源码改动。

- [ ] **Step 1: 建分支并确认工作树**

```bash
cd /Users/rain/lab/dsh-mnemon
git switch -c feat/clock-review
git status --short
```

预期：只有 `?? specs/`（设计文档未跟踪），其余干净。

- [ ] **Step 2: 安装依赖**

```bash
pnpm install
```

预期：成功生成 `node_modules`，不修改 `pnpm-lock.yaml`（若 lockfile 变化，先停下检查）。

- [ ] **Step 3: 基线**

```bash
pnpm run typecheck
pnpm exec vitest run tests/review-clock.spec.ts 2>/dev/null || true
```

预期：typecheck 通过；新测试文件尚不存在。

---

### Task 1: 时钟数学模块

**Files:**
- Create: `src/host/review-clock.ts`
- Create: `tests/review-clock.spec.ts`

**Interfaces:**
```ts
export interface ClockTime { readonly hours: number; readonly minutes: number }
export function parseClockTime(value: string): ClockTime
export function previousOccurrence(at: string, now: Date): Date
export function nextOccurrence(at: string, now: Date): Date
```

- [ ] **Step 1: 写失败测试**

`tests/review-clock.spec.ts`：
```ts
import { describe, expect, it } from 'vitest'
import { nextOccurrence, parseClockTime, previousOccurrence } from '../src/host/review-clock.ts'

const local = (y: number, m: number, d: number, h: number, min: number): Date => new Date(y, m, d, h, min, 0, 0)

describe('review clock', () => {
  it('parses 24-hour local times and rejects everything else', () => {
    expect(parseClockTime('00:00')).toEqual({ hours: 0, minutes: 0 })
    expect(parseClockTime('23:59')).toEqual({ hours: 23, minutes: 59 })
    for (const value of ['24:00', '7:30', '07:60', '0730', '', ' 07:30', '07:30 ']) {
      expect(() => parseClockTime(value)).toThrow('HH:MM')
    }
  })

  it('finds the next occurrence strictly after now', () => {
    expect(nextOccurrence('00:00', local(2026, 0, 1, 23, 59)).getTime()).toBe(local(2026, 0, 2, 0, 0).getTime())
    expect(nextOccurrence('00:00', local(2026, 0, 2, 0, 0)).getTime()).toBe(local(2026, 0, 3, 0, 0).getTime())
    expect(nextOccurrence('23:30', local(2026, 0, 1, 23, 29)).getTime()).toBe(local(2026, 0, 1, 23, 30).getTime())
    expect(nextOccurrence('23:30', local(2026, 0, 1, 23, 30)).getTime()).toBe(local(2026, 0, 2, 23, 30).getTime())
  })

  it('crosses month and year boundaries', () => {
    expect(nextOccurrence('00:00', local(2026, 11, 31, 23, 59)).getTime()).toBe(local(2027, 0, 1, 0, 0).getTime())
    expect(previousOccurrence('00:00', local(2026, 0, 1, 0, 0)).getTime()).toBe(local(2026, 0, 1, 0, 0).getTime())
    expect(previousOccurrence('00:00', local(2026, 0, 1, 0, 1)).getTime()).toBe(local(2026, 0, 1, 0, 0).getTime())
    expect(previousOccurrence('00:00', local(2026, 0, 1, 0, 0)).getTime()).toBe(local(2026, 0, 1, 0, 0).getTime())
  })

  it('returns local wall-clock instants across DST transitions without throwing', () => {
    const spring = local(2026, 2, 8, 1, 0)
    const next = nextOccurrence('02:30', spring)
    expect(next.getTime()).toBeGreaterThan(spring.getTime())
    expect(next.getDate()).toBe(8)
    const fall = local(2026, 10, 1, 0, 0)
    expect(previousOccurrence('01:30', fall).getTime()).toBeLessThanOrEqual(fall.getTime())
  })
})
```

`previousOccurrence` 语义：返回“不晚于 now 的最近一次”，因此 `now` 正好等于今天该时刻时返回今天该时刻。

- [ ] **Step 2: 运行测试，确认失败**

```bash
pnpm exec vitest run tests/review-clock.spec.ts
```

预期：`Cannot find module '../src/host/review-clock.ts'`。

- [ ] **Step 3: 实现**

`src/host/review-clock.ts`：
```ts
export interface ClockTime {
  readonly hours: number
  readonly minutes: number
}

const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/u

/** Parses a 24-hour local wall-clock time; throws on any other form. */
export function parseClockTime(value: string): ClockTime {
  const match = CLOCK_TIME.exec(value)
  if (match === null) throw new Error(`idleReview.at must be HH:MM in 24-hour local time, received ${JSON.stringify(value)}`)
  return { hours: Number(match[1]), minutes: Number(match[2]) }
}

function at(time: ClockTime, year: number, month: number, day: number): Date {
  return new Date(year, month, day, time.hours, time.minutes, 0, 0)
}

/** Returns the most recent occurrence at or before now, in Host local time. */
export function previousOccurrence(value: string, now: Date): Date {
  const time = parseClockTime(value)
  const today = at(time, now.getFullYear(), now.getMonth(), now.getDate())
  return today.getTime() <= now.getTime() ? today : at(time, now.getFullYear(), now.getMonth(), now.getDate() - 1)
}

/** Returns the next occurrence strictly after now, in Host local time. */
export function nextOccurrence(value: string, now: Date): Date {
  const time = parseClockTime(value)
  const today = at(time, now.getFullYear(), now.getMonth(), now.getDate())
  return today.getTime() > now.getTime() ? today : at(time, now.getFullYear(), now.getMonth(), now.getDate() + 1)
}
```

- [ ] **Step 4: 运行测试**

```bash
pnpm exec vitest run tests/review-clock.spec.ts
```

预期：4 个测试全绿。若 DST 测试在当前 TZ（Asia/Shanghai，无 DST）下 `02:30` 正常存在，`getDate()` 仍为 8。

- [ ] **Step 5: 提交**

```bash
git add src/host/review-clock.ts tests/review-clock.spec.ts
git commit -m "feat: add local wall-clock review scheduler math"
```

---

### Task 2: 钟点状态存储

**Files:**
- Create: `src/host/review-clock-state.ts`
- Create: `tests/review-clock-state.spec.ts`

**Interfaces:**
```ts
export interface ReviewClockState {
  readonly version: 1
  readonly sessionId: string
  readonly lastHandledDueAt: number | null
}
export class ReviewClockStore {
  constructor(directory: string, sessionId: string)
  load(): ReviewClockState
  save(state: Pick<ReviewClockState, 'lastHandledDueAt'>): void
}
```

- [ ] **Step 1: 写失败测试**

`tests/review-clock-state.spec.ts`：
```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ReviewClockStore } from '../src/host/review-clock-state.ts'

const dirs: string[] = []
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'dsh-mnemon-clock-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('review clock state', () => {
  it('returns a first-run state when the file is missing', () => {
    expect(new ReviewClockStore(temp(), 'session-1').load()).toEqual({ version: 1, sessionId: 'session-1', lastHandledDueAt: null })
  })

  it('round-trips the last handled due and isolates sessions', () => {
    const directory = temp()
    const store = new ReviewClockStore(directory, 'session-1')
    store.save({ lastHandledDueAt: 1_700_000_000_000 })
    expect(store.load().lastHandledDueAt).toBe(1_700_000_000_000)
    expect(new ReviewClockStore(directory, 'session-2').load().lastHandledDueAt).toBeNull()
  })

  it('treats a corrupt or foreign file as first run instead of blocking review', () => {
    const directory = temp()
    const store = new ReviewClockStore(directory, 'session-1')
    store.save({ lastHandledDueAt: 1 })
    const path = (store as unknown as { path: string }).path
    require('node:fs').writeFileSync(path, '{"version":1,"sessionId":"other","lastHandledDueAt":5}')
    expect(store.load().lastHandledDueAt).toBeNull()
    require('node:fs').writeFileSync(path, 'not json')
    expect(store.load().lastHandledDueAt).toBeNull()
  })
})
```

测试里不要用 `as unknown` 访问私有字段——改为从 `load()`/`save()` 行为验证；实现一个公开的 `path` 只读属性更干净。把第三例改成：
```ts
import { writeFileSync } from 'node:fs'
...
const path = store.path
writeFileSync(path, '{"version":1,"sessionId":"other","lastHandledDueAt":5}')
expect(store.load().lastHandledDueAt).toBeNull()
writeFileSync(path, 'not json')
expect(store.load().lastHandledDueAt).toBeNull()
```
接口相应加 `readonly path: string`。

- [ ] **Step 2: 运行测试，确认失败**

```bash
pnpm exec vitest run tests/review-clock-state.spec.ts
```

预期：模块不存在。

- [ ] **Step 3: 实现**

镜像 `src/host/idle-review-watermark.ts` 的安全读取与原子写：

```ts
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { writeAtomicJsonSync } from './fs-atomic.ts'

export interface ReviewClockState {
  readonly version: 1
  readonly sessionId: string
  readonly lastHandledDueAt: number | null
}

const MAX_STATE_BYTES = 16_384
const MAX_TIMESTAMP = 8_640_000_000_000_000

export class ReviewClockStore {
  readonly path: string
  private readonly directory: string
  private readonly sessionId: string

  constructor(directory: string, sessionId: string) {
    this.directory = join(resolve(directory), 'state', 'idle-review')
    this.sessionId = sessionId
    this.path = join(this.directory, createHash('sha256').update(sessionId).digest('hex') + '.clock.json')
  }

  load(): ReviewClockState {
    const empty: ReviewClockState = { version: 1, sessionId: this.sessionId, lastHandledDueAt: null }
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(this.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
      const info = fs.fstatSync(descriptor)
      if (!info.isFile() || info.size > MAX_STATE_BYTES) return empty
      const bytes = Buffer.alloc(MAX_STATE_BYTES + 1)
      let length = 0
      while (length < bytes.length) {
        const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null)
        if (count === 0) break
        length += count
      }
      if (length > MAX_STATE_BYTES) return empty
      const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'))
      if (value === null || typeof value !== 'object') return empty
      const state = value as Partial<ReviewClockState>
      const valid = state.lastHandledDueAt === null
        || typeof state.lastHandledDueAt === 'number' && Number.isSafeInteger(state.lastHandledDueAt)
          && state.lastHandledDueAt >= 0 && state.lastHandledDueAt <= MAX_TIMESTAMP
      if (state.version !== 1 || state.sessionId !== this.sessionId || !valid) return empty
      return { version: 1, sessionId: this.sessionId, lastHandledDueAt: state.lastHandledDueAt ?? null }
    } catch {
      return empty
    } finally {
      if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch { /* descriptor already gone */ }
    }
  }

  save(state: Pick<ReviewClockState, 'lastHandledDueAt'>): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    writeAtomicJsonSync(this.path, { version: 1, sessionId: this.sessionId, lastHandledDueAt: state.lastHandledDueAt },
      { fs, indent: 0, flag: 'wx' })
  }
}
```

损坏/外会话文件一律返回首次运行，不抛错；写失败由调用方捕获并告警。

- [ ] **Step 4: 运行测试**

```bash
pnpm exec vitest run tests/review-clock-state.spec.ts
```

- [ ] **Step 5: 提交**

```bash
git add src/host/review-clock-state.ts tests/review-clock-state.spec.ts
git commit -m "feat: persist the last handled daily review due per session"
```

---

### Task 3: 配置面 `idleReview.at`

**Files:**
- Modify: `src/host/config/defaults.ts`
- Modify: `src/host/protocol/config.ts`
- Modify: `src/host/config/schema.ts`
- Modify: `src/host/config/normalize.ts`
- Test: `tests/config.spec.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/config.spec.ts` 的 config describe 中加入：
```ts
it('schedules automatic review at a local wall-clock time', () => {
  expect(resolveConfig({}).idleReview.at).toBe('00:00')
  expect(resolveConfig({ idleReview: { at: '23:30' } }).idleReview.at).toBe('23:30')
  expect(Config({ idleReview: { at: '07:05' } }).idleReview?.at).toBe('07:05')
  for (const value of ['24:00', '7:30', '07:60', '', 'midnight']) {
    expect(() => resolveConfig({ idleReview: { at: value } } as never)).toThrow(/idleReview\.at|HH:MM/u)
  }
  // 旧字段继续可解析，但不再影响调度。
  expect(resolveConfig({ idleReviewMs: 5_000 }).idleReviewMs).toBe(5_000)
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
pnpm exec vitest run tests/config.spec.ts -t "wall-clock"
```

- [ ] **Step 3: 实现**

`src/host/config/defaults.ts`：在 `DEFAULT_IDLE_REVIEW` 加 `at: '00:00'`（`DEFAULT_IDLE_REVIEW_MS` 与 bounds 保留）。

`src/host/protocol/config.ts`：
```ts
export interface ResolvedIdleReviewConfig {
  // ...现有字段
  readonly at: string
}
export const DEFAULT_IDLE_REVIEW: ResolvedIdleReviewConfig = { /* ... */ at: '00:00' }
```
`DEFAULT_IDLE_REVIEW` 的 `at` 用 `satisfies ResolvedIdleReviewConfig` 或显式类型保持一致。

`src/host/config/schema.ts`：
```ts
at: z.string().pattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/u).default(DEFAULT_IDLE_REVIEW.at),
```

`src/host/config/normalize.ts`：在 `resolveConfig` 里 `idleReview` 之后显式校验，给出可读错误：
```ts
const idleReview = IdleReviewSchema(config.idleReview ?? {})
parseClockTime(idleReview.at) // 非法值抛 "idleReview.at must be HH:MM ..."
// ...
return { /* ... */ idleReview }
```

- [ ] **Step 4: 运行配置测试与 typecheck**

```bash
pnpm exec vitest run tests/config.spec.ts
pnpm run typecheck
```

- [ ] **Step 5: 提交**

```bash
git add src/host/config/defaults.ts src/host/protocol/config.ts src/host/config/schema.ts src/host/config/normalize.ts tests/config.spec.ts
git commit -m "feat: add idleReview.at daily review time config"
```

---

### Task 4: Lifecycle 钟点调度

**Files:**
- Modify: `src/host/lifecycle.ts`
- Test: 新逻辑先在 `tests/lifecycle.spec.ts` 里用最小用例覆盖（大规模迁移在 Task 6）。

**改动要点：**

1. 新增字段：
```ts
private idleReviewRetryTimer: ReturnType<typeof setTimeout> | undefined
private pendingReviewDueAt: number | undefined
private lastHandledDueAt: number | undefined
private clockStore: ReviewClockStore | undefined
private clockWarned = false
```

2. 拆分取消：
```ts
private abortIdleReview(): void {
  this.reviewEpoch += 1
  this.reviewController?.abort()
}
private clearIdleReviewTimers(): void {
  if (this.idleReviewTimer !== undefined) clearTimeout(this.idleReviewTimer)
  if (this.idleReviewRetryTimer !== undefined) clearTimeout(this.idleReviewRetryTimer)
  this.idleReviewTimer = undefined
  this.idleReviewRetryTimer = undefined
}
private clearPendingIdleReview(): void {
  this.pendingReviewDueAt = undefined
  this.clearIdleReviewTimers()
}
```
调用点：
- `start()` 返回的 disposer：`this.clearPendingIdleReview(); this.abortIdleReview()`（替换原 `cancelIdleReview(true)`）。
- `preStep` step 1、`assemblePrompt`：只 `this.abortIdleReview()`，**不要**清每日 timer。
- `configurationChanged()`：`this.abortIdleReview(); this.clearPendingIdleReview(); this.restoreClock(); this.armIdleReviewClock()`。
- `finishTurn()`：开头 `this.abortIdleReview()`；末尾若到点 pending 则尝试。

3. 时钟武装：
```ts
private armIdleReviewClock(): void {
  if (this.idleReviewTimer !== undefined) { clearTimeout(this.idleReviewTimer); this.idleReviewTimer = undefined }
  if (this.disposed) return
  const now = new Date()
  const due = nextOccurrence(this.config.idleReview.at, now)
  this.idleReviewTimer = setTimeout(() => {
    this.idleReviewTimer = undefined
    try {
      if (this.disposed) return
      this.pendingReviewDueAt = Math.max(due.getTime(), this.pendingReviewDueAt ?? -Infinity)
      this.armIdleReviewClock()
      this.tryPendingIdleReview()
    } catch (error) {
      if (this.disposed || isInactiveContextError(error)) return
      try { if (!contextIsActive(this.agent.ctx)) return } catch { return }
      this.fail(error)
    }
  }, Math.max(0, due.getTime() - now.getTime()))
}
```

4. 尝试执行（替换 `scheduleIdleReview`）：
```ts
private latestCompletedTurn(): number | undefined {
  const found = findSessionEvent(this.agent.session, event => event.type === 'turn/end')
  const turn = found === undefined ? undefined : eventTurn(found.event)
  return typeof turn === 'number' ? turn : undefined
}

private tryPendingIdleReview(turn = this.latestCompletedTurn(), settle = 0): void {
  const due = this.pendingReviewDueAt
  if (due === undefined || this.reviewRunning || this.disposed) return
  if (!this.restoreWatermark() || !this.idleReviewAllowed()) return
  if (turn === undefined) return
  const activity = this.reviewActivity()
  if (!activity.eligible || !this.reviewAdmitted(turn)) { this.consumeDue(due); return }
  const admission = this.reviewAdmission
  if (admission?.turn !== turn || admission.policy !== this.reviewPolicy() || !admission.available) return
  if (this.agent.status !== 'idle') {
    if (settle < 10 && this.idleReviewRetryTimer === undefined) {
      this.idleReviewRetryTimer = setTimeout(() => {
        this.idleReviewRetryTimer = undefined
        this.tryPendingIdleReview(turn, settle + 1)
      }, 250)
    }
    return
  }
  const remaining = (this.lastReviewAttemptAt ?? -Infinity) + this.config.idleReview.minIntervalMs - Date.now()
  if (remaining > 0) {
    if (this.idleReviewRetryTimer === undefined) {
      this.idleReviewRetryTimer = setTimeout(() => {
        this.idleReviewRetryTimer = undefined
        this.tryPendingIdleReview(turn, settle)
      }, remaining)
    }
    return
  }
  this.consumeDue(due)
  void this.runIdleReview().catch(error => {
    if (this.disposed || isInactiveContextError(error)) return
    try { if (!contextIsActive(this.agent.ctx)) return } catch { return }
    this.fail(error)
  })
}

private consumeDue(due: number): void {
  this.pendingReviewDueAt = undefined
  this.lastHandledDueAt = Math.max(this.lastHandledDueAt ?? -Infinity, due)
  try { this.clockStore?.save({ lastHandledDueAt: this.lastHandledDueAt }) } catch (error) { this.warnClock(error) }
}
```

5. `finishTurn()` 末尾：
```ts
if (!this.reviewActivity().eligible || !this.reviewAdmitted(payload.turn)) return
this.tryPendingIdleReview(payload.turn)
```
（删除 `scheduleIdleReview` 调用。）

6. `start()` 末尾：`this.restoreClock(); this.armIdleReviewClock()`。

7. `snapshot()`：
```ts
idleReviewPending: this.pendingReviewDueAt !== undefined || this.reviewRunning,
// ...
nextReviewAt: nextOccurrence(this.config.idleReview.at, new Date()).toISOString(),
```

8. 删除 `scheduleIdleReview` 与旧 `cancelIdleReview`；所有调用点按上面替换。`reviewPolicy()` 已包含 `idleReview`，`at` 变化会触发重排。

- [ ] **Step 1: 先用一个测试驱动**

在 `tests/lifecycle.spec.ts` 加最小用例（沿用该文件 fixture 与 fake timers）：
```ts
it('runs automatic review at the configured local time', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 0, 1, 23, 59, 0))
  const value = fixture(resolveConfig({ idleReview: { at: '00:00' } }))
  // 完成一个有实质内容的回合（复用文件中已有的 turn 驱动 helper）
  await value.finishSubstantiveTurn()
  expect(value.lifecycle.snapshot('session-1').current?.idleReviewPending).toBe(false)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(value.reviewCalls).toBe(1)
})
```
若 fixture 没有 `finishSubstantiveTurn`，用文件里现有的驱动方式（`beginTurn`/`finishTurn` helper）。

- [ ] **Step 2: 实现后在最小用例上跑绿**

```bash
pnpm exec vitest run tests/lifecycle.spec.ts -t "configured local time"
```

- [ ] **Step 3: typecheck**

```bash
pnpm run typecheck
```

- [ ] **Step 4: 提交**

```bash
git add src/host/lifecycle.ts tests/lifecycle.spec.ts
git commit -m "feat: schedule idle review at a daily wall-clock time"
```

---

### Task 5: 补跑与状态接线

**Files:**
- Modify: `src/host/lifecycle.ts`
- Test: `tests/lifecycle.spec.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('catches up the most recent missed occurrence once per session', async () => {
  const directory = tempDirectory()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 0, 2, 9, 0, 0)) // 今天 00:00 已过
  const store = new ReviewClockStore(directory, 'session-1')
  store.save({ lastHandledDueAt: new Date(2026, 0, 1, 0, 0, 0).getTime() })
  const value = fixture(resolveConfig({ idleReview: { at: '00:00' } }), { directory })
  await value.finishSubstantiveTurn()
  // 触发 idle 检查（advance 0/250ms），补跑 1 月 2 日 00:00
  await vi.advanceTimersByTimeAsync(1_000)
  expect(value.reviewCalls).toBe(1)
})

it('marks the most recent occurrence handled on first run without replaying history', async () => {
  const directory = tempDirectory()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 0, 2, 9, 0, 0))
  const value = fixture(resolveConfig({ idleReview: { at: '00:00' } }), { directory })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(value.reviewCalls).toBe(0)
  expect(new ReviewClockStore(directory, 'session-1').load().lastHandledDueAt)
    .toBe(new Date(2026, 0, 2, 0, 0, 0).getTime())
})

it('does not catch up after the daily occurrence has been consumed', async () => {
  const directory = tempDirectory()
  const store = new ReviewClockStore(directory, 'session-1')
  store.save({ lastHandledDueAt: new Date(2026, 0, 2, 0, 0, 0).getTime() })
  const value = fixture(resolveConfig({ idleReview: { at: '00:00' } }), { directory })
  await value.finishSubstantiveTurn()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(value.reviewCalls).toBe(0)
})
```

- [ ] **Step 2: 实现 `restoreClock()`**

```ts
private restoreClock(): void {
  const directory = this.runtimeDirectory?.()
  if (directory === undefined || directory.trim() === '') { this.clockStore = undefined; return }
  try {
    this.clockStore = new ReviewClockStore(directory, this.agent.id)
    const state = this.clockStore.load()
    this.lastHandledDueAt = state.lastHandledDueAt ?? undefined
    const due = previousOccurrence(this.config.idleReview.at, new Date()).getTime()
    if (state.lastHandledDueAt === null) {
      this.clockStore.save({ lastHandledDueAt: due })
      this.lastHandledDueAt = due
      return
    }
    if (due > state.lastHandledDueAt) this.pendingReviewDueAt = due
  } catch (error) { this.warnClock(error) }
}

private warnClock(error: unknown): void {
  if (this.clockWarned) return
  this.clockWarned = true
  console.warn(`[dsh-mnemon] review clock state unavailable: ${error instanceof Error ? error.message : String(error)}`)
}
```

补跑只在 `start()` 与 `configurationChanged()` 调用 `restoreClock()`；`persistWatermark` 关闭时仍工作。

- [ ] **Step 3: 运行补跑测试**

```bash
pnpm exec vitest run tests/lifecycle.spec.ts -t "catch up"
```

- [ ] **Step 4: 提交**

```bash
git add src/host/lifecycle.ts tests/lifecycle.spec.ts
git commit -m "feat: catch up the latest missed daily review"
```

---

### Task 6: 迁移现有 lifecycle 测试

**Files:**
- Modify: `tests/lifecycle.spec.ts`
- Modify: `tests/fixtures/lifecycle.ts`（若需要）

- [ ] **Step 1: 全量迁移策略**

1. 在所有启用 `vi.useFakeTimers()` 的测试块里把系统时间设到 `2026-01-01 23:59:00`（`vi.setSystemTime(new Date(2026, 0, 1, 23, 59, 0))`），使默认 `at: '00:00'` 在 60 秒后触发。
2. `resolveConfig({ idleReviewMs: 5_000 })` 改为 `resolveConfig({ idleReview: { at: '00:00' } })`（`persistWatermark` 等原字段保留）。
3. 把“推进 600_000ms 等 idle review”改为推进到 00:00 之后：`advanceTimersByTimeAsync(60_000)`；原断言 `idleReviewPending === true` 的时刻改为“刚结束回合、尚未到点”，`nextReviewAt` 断言改为下一个 00:00。
4. 断言 `idleReviewMs` 不再影响触发：新增用例——`idleReviewMs: 1` 但未到点时不跑。

- [ ] **Step 2: 逐段运行并修**

```bash
pnpm exec vitest run tests/lifecycle.spec.ts
```

重复直到全绿；不要改实现去迁就旧断言，除非旧断言描述的正是要废弃的行为。

- [ ] **Step 3: 补关键边界用例**

- 到点 agent 正忙 → 回合结束补跑；
- `reviewAdmission` 不可用 → 保留 pending，下个回合结束再试；
- 活动分不足 → 消费 due 且不跑；
- `minIntervalMs` 未到 → 短重试后跑；
- 配置改 `at` → 立即重排；
- dispose → 清 timer，不再跑。

- [ ] **Step 4: 提交**

```bash
git add tests/lifecycle.spec.ts tests/fixtures/lifecycle.ts
git commit -m "test: cover daily clock review scheduling"
```

---

### Task 7: 技能复盘同钟点

**Files:**
- Modify: `src/host/skill-evolution.ts`
- Modify: `src/host/plugin.ts`
- Modify: `src/client/skills-settings.tsx`
- Modify: `src/client/locales.ts`
- Test: `tests/skill-evolution.spec.ts`、`tests/client-skills.spec.tsx`

- [ ] **Step 1: 写失败测试**

在 `tests/skill-evolution.spec.ts` 用 fake timers：
```ts
it('reviews at the shared daily clock instead of idleSeconds', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 0, 1, 23, 59, 0))
  const host = hostFixture({ reviewAt: () => '00:00', settings: { evolution: true, idleSeconds: 3600 } })
  const agent = host.agent()
  host.evolution.watch(agent)
  await host.turnEnded(agent, 1) // 已有 helper，窗口分达标
  expect(host.reviewCalls).toBe(0)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(host.reviewCalls).toBe(1)
})
```
另加：窗口分不足到点不跑；`cooldownSeconds` 未到时短重试；`settingsChanged()` 改时间后重排；`reviewNow()` 不清每日 timer。

- [ ] **Step 2: 实现**

`SkillEvolutionHost` 增加 `reviewAt(): string`。

`plugin.ts` 的 `new SkillEvolution({ ... })` 增加：
```ts
reviewAt: () => runtime.config.idleReview.at,
```

`SessionState` 增加：
```ts
agent?: HostAgent
clockTimer?: ReturnType<typeof setTimeout>
retryTimer?: ReturnType<typeof setTimeout>
pendingDue?: number
```

`watch()`：`state.agent = agent`；末尾 `this.armClock(agent, state)`；disposer 里 `this.clearTimers(state)`。

删除 `schedule()` 的 `idleSeconds` 逻辑，改为：
```ts
private armClock(agent: HostAgent, state: SessionState): void {
  if (state.clockTimer !== undefined) clearTimeout(state.clockTimer)
  const next = nextOccurrence(this.host.reviewAt(), this.now())
  state.clockTimer = setTimeout(() => {
    delete state.clockTimer
    if (this.disposed) return
    state.pendingDue = next.getTime()
    this.armClock(agent, state)
    this.tryDue(agent, state)
  }, Math.max(0, next.getTime() - this.now().getTime()))
}

private tryDue(agent: HostAgent, state: SessionState): void {
  if (this.disposed || state.pendingDue === undefined || state.running !== undefined) return
  const settings = this.host.settings()
  if (!settings.evolution || (!settings.allowCreate && !settings.allowUpdate)) { delete state.pendingDue; return }
  if (state.window.score().score < settings.reviewThreshold) { delete state.pendingDue; return }
  if (agent.status !== 'idle') return
  const remaining = state.lastReviewAt === undefined ? 0 : state.lastReviewAt + settings.cooldownSeconds * 1000 - this.now().getTime()
  if (remaining > 0) {
    if (state.retryTimer === undefined) state.retryTimer = setTimeout(() => { delete state.retryTimer; this.tryDue(agent, state) }, remaining)
    return
  }
  delete state.pendingDue
  state.scheduled = state.window.lastTurn
  state.running = this.trackJob(this.review(agent, state, 'automatic').then(() => undefined))
    .finally(() => { delete state.running; delete state.scheduled })
}
```

`turnEnded()` 末尾把 `this.schedule(...)` 改为 `this.tryDue(agent, state)`；`reviewNow()` 里 `cancelTimer` 改为只清 `pendingDue`/`retryTimer`，不清 `clockTimer`。

`settingsChanged()`：
```ts
settingsChanged(): void {
  this.automatic.settingsChanged()
  for (const state of this.sessions.values()) {
    if (state.agent === undefined) continue
    this.clearPending(state)
    this.armClock(state.agent, state)
  }
}
```

- [ ] **Step 3: 运行测试**

```bash
pnpm exec vitest run tests/skill-evolution.spec.ts tests/client-skills.spec.tsx
```

- [ ] **Step 4: 移除 `idleSeconds` 设置项**

`skills-settings.tsx`：从 `PARAMETERS` 删除 `idleSeconds`；参数类型与 `draft` 映射同步删除。
`locales.ts`：删除 en/zh 的 `skills.idleSeconds`。
保留 `SkillsConfig.idleSeconds` 解析（deprecated），文档注明。

- [ ] **Step 5: 提交**

```bash
git add src/host/skill-evolution.ts src/host/plugin.ts src/client/skills-settings.tsx src/client/locales.ts tests/skill-evolution.spec.ts tests/client-skills.spec.tsx
git commit -m "feat: run skill evolution review on the shared daily clock"
```

---

### Task 8: 设置页时间输入

**Files:**
- Modify: `src/client/component-settings.tsx`
- Modify: `src/client/locales.ts`
- Test: `tests/client-settings.spec.tsx`

- [ ] **Step 1: 写失败测试**

在 `tests/client-settings.spec.tsx` 加：
```tsx
it('writes the daily review time even when idle review is disabled', async () => {
  // 复用文件里的 render + scope helper
  // 找到 type="time" 的输入，设为 23:30，断言 mutate 调用 { op:'set', path:['idleReview'], value: { at:'23:30', ... } }
})
```

- [ ] **Step 2: 实现**

`ReviewChoice` 加入 `'at'`；`choiceOf` 返回 `at`；在 `IdleReviewRows` 的 `<ToggleRow ... reviewTitle>` 之后、`{choice.enabled && ...}` 之前渲染：
```tsx
<SettingRow htmlFor={`${baseId}-at`} title={t('config.reviewAt')} hint={t('config.reviewAtHint')}>
  <input id={`${baseId}-at`} type="time" step="60" value={choice.at} disabled={props.disabled}
    onChange={event => { const value = event.target.value; if (/^\d{2}:\d{2}$/u.test(value)) props.onChoice({ at: value }) }} />
</SettingRow>
```

locale（en/zh）：
```ts
'reviewAt': 'Daily review time',
'reviewAtHint': 'Runs idle review and skill review once a day at this local time.',
```
中文：`每日审查时间` / `每天按本地时间执行一次空闲审查与技能复盘。`

- [ ] **Step 3: 运行客户端测试**

```bash
pnpm exec vitest run tests/client-settings.spec.tsx tests/client-skills.spec.tsx
```

- [ ] **Step 4: 提交**

```bash
git add src/client/component-settings.tsx src/client/locales.ts tests/client-settings.spec.tsx
git commit -m "feat: edit the daily review time in settings"
```

---

### Task 9: 文档

**Files:**
- Modify: `docs/en/reference/configuration.md`
- Modify: `docs/zh-CN/reference/configuration.md`
- Modify: `docs/en/reference/workflows.md`
- Modify: `docs/zh-CN/reference/workflows.md`
- 视情况：`README.md` / `README.zh-CN.md`

- [ ] **Step 1: 改英文配置文档**

- 示例 `idleReviewMs: 30000` 改为 `idleReview: { at: '00:00' }`，并注明 `idleReviewMs` deprecated。
- idleReview 选项表加 `at`（`HH:MM`，默认 `00:00`，Host 本地时区，同时控制技能复盘）。
- 505-531 段落改写：到点触发、忙则回合结束补跑、错过补跑 24 小时、`minIntervalMs` 防重复、admission 仍需上一回合 open step、重启不重放历史但会补最近一次未处理。
- 删除 “Restart never replays work or schedules catch-up review” 这句。

- [ ] **Step 2: 同步中文**

逐段对应翻译，保持 `at`、`deprecated`、`minIntervalMs` 等标识符不变。

- [ ] **Step 3: workflows 文档**

`workflows.md:338` 的 “wait idleReviewMs (default 30 s)...” 改为 “wait until the configured daily time (default 00:00 local)”。

- [ ] **Step 4: 校验**

```bash
pnpm run verify:docs
```

- [ ] **Step 5: 提交**

```bash
git add docs README.md README.zh-CN.md
git commit -m "docs: document daily clock review"
```

---

### Task 10: 全量验证与发布

- [ ] **Step 1: 构建与全量测试**

```bash
pnpm run build
pnpm run test
pnpm run typecheck
pnpm run verify
```

- [ ] **Step 2: 增加 changeset**

```bash
pnpm exec changeset
```
选择 minor（新配置项 + 行为变化），描述从 idle 到 daily clock。

- [ ] **Step 3: 本地接入 web profile**

```bash
cd /Users/rain/.dsh/profiles/web
# package.json 把 "dsh-mnemon": "0.5.50" 改为 "dsh-mnemon": "link:/Users/rain/lab/dsh-mnemon"
pnpm install
```
（先备份 `package.json` 与 `pnpm-lock.yaml`；若 profile 使用 workspace 协议导致 link 失败，回退为 `pnpm pack` 的 tarball。）

- [ ] **Step 4: 冒烟**

- 在 Web GUI 的 dsh-mnemon 设置页确认“每日审查时间”可见、可保存；
- 把时间设为 1-2 分钟后，完成一个有实质内容的回合，确认到点跑一次审查；
- 重启 Host 后确认补跑状态与 `state/idle-review/*.clock.json` 正确。

- [ ] **Step 5: 提交并开 PR**

```bash
git add .
git commit -m "chore: add release changeset"
git push -u origin feat/clock-review
gh pr create --repo raininfall/dsh-mnemon --base main --head feat/clock-review \
  --title "feat: daily clock review replacing idle debounce" \
  --body "..."
```

---

## 风险与回滚

- **DST/时区**：本地墙钟用 `new Date(y,m,d,h,min)`；春季不存在的时刻会顺延到有效时刻，秋季重复时刻取第一次。测试覆盖不抛错、不跳过整天。
- **重启补跑**：只在 `start()`/配置变化时读状态；首次运行不补历史。若状态写失败，仅告警，不阻塞当晚审查。
- **并发**：idle review 与 skill review 同在 00:00，可能同时占用 provider；先按现状并行，若实测冲突再评估固定偏移。
- **回滚**：删掉新字段与 timer 逻辑、恢复 `scheduleIdleReview` 即可；`idleReview.at` 留在配置里无副作用。
