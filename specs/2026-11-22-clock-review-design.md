# 钟点审查（clock review）设计

- 状态：待批准
- 日期：2026-11-22
- 仓库：`raininfall/dsh-mnemon`（fork of `omdsh-dev/dsh-mnemon`）
- 需求来源：m00167；触发方式选型：m00293（方案 B）；行为不变的约束：m00267

## 1. 背景

当前“空闲审查”（idle review）不是会话结束触发，而是在每个正常回合结束时累计活动分，达标后等 `idleReviewMs`（默认 30s）且距上次尝试 ≥ `minIntervalMs`（默认 5min），在 Agent 空闲时后台跑一次审查。会话关闭不触发，Host 重启会丢失未处理的累计活动，也没有补跑。

需求是把触发从“回合结束后的空闲延迟”换成“每天固定钟点（默认 00:00）”，并且钟点可配置。审查内容、资格判定、admission 检查、写入规则全部不变，只换触发时机。

## 2. 目标 / 非目标

目标：

- 每个存活的会话每天在配置的本地时间触发一次审查，默认 `00:00`。
- 到点时若正在回合中，等该回合结束再跑，不打断对话。
- 会话未运行或 Host 重启导致错过时点：下次会话活动时补跑一次（方案 B），不无限追补。
- 保留现有活动分门槛、`reviewAdmitted` 内容门槛、`reviewAdmission` 工具准入、`maxPerSession`、`minIntervalMs`、`silent`、写入规则与 watermark 语义。
- 配置、设置页、文档、测试同步更新。

非目标：

- 不做宿主级跨会话全局调度（方案 C）：不枚举/恢复未打开的会话。
- 不改审查 Agent 的提示词、可用工具、写入层级（一份 Document 或一次运行时记忆修改）。
- 不改技能复盘（`skills.evolution`）的审查内容、候选生成与自动采纳策略；但触发同样改为每日钟点（见第 9 节）。
- v1 不做 IANA 时区与多时区；使用 Host 本地时区。
- v1 不支持一天多个钟点；后续可把 `at` 扩展为数组。

## 3. 配置

新增 `idleReview.at`：

```yaml
idleReview:
  at: "00:00"    # HH:MM，Host 本地时区，默认 "00:00"
```

- 校验：`^([01]\d|2[0-3]):[0-5]\d$`；非法值在配置加载时报错（fail loud）。
- `idleReviewMs` 标记为 deprecated：仍可解析但不再参与调度，保留一个版本避免旧配置校验失败；设置页本就没有该字段。
- `minIntervalMs` 保留：两次审查尝试之间的最小间隔；补跑时若违反则跳过本次。
- 其余 `idleReview` 字段不变；默认值、边界不变。

## 4. 调度模型

### 4.1 时钟

每个 Agent 一个长期存活的时钟 timer，指向下一个 `at` 时点。

- Agent 启动时：
  - 读取该会话的调度状态 `lastHandledDueAt`。
  - 计算最近一个应审时点 `due = previousOccurrence(at, now)`（今天或昨天的 `at`，≤ now）。
  - 若状态存在且 `lastHandledDueAt < due`，把 `pendingDue` 设为 `due`（补跑）。
  - 若状态不存在（首次运行/状态丢失），把 `lastHandledDueAt` 初始化为 `due`，不补跑，避免升级后立刻多跑一次。
  - 无论是否 pending，都武装下一次 `at` 的 timer。
- timer 到点：`pendingDue = 该时点`，立即尝试执行，并立刻武装下一天的 timer（处理期间不会漏掉下一天）。
- 系统休眠、时钟回拨导致 timer 过早/过晚：回调中重新计算 `previousOccurrence`/`nextOccurrence`；若目标时点仍在未来则重新武装，不提前跑。
- 配置变化（`at` 或其他 review 字段）时：清除并重新武装；中止正在运行的审查（沿用现有 `reviewEpoch` 语义）。
- Agent 销毁：清除 timer，中止运行中的审查。

### 4.2 什么时候真正跑

`maybeRunClockReview()` 在两种时机调用：时钟到点、回合结束。全部条件满足才跑：

1. 未销毁、上下文活跃、`idleReview.enabled`、`idleReviewAttempts < maxPerSession`。
2. 存在最后一个正常完成的回合（`turn/end` 存在且该回合未被 abort）。
3. 现有审查资格：`reviewActivity().eligible` 且 `reviewAdmitted(turn)`。
4. 现有准入：`reviewAdmission` 存在、`turn` 为最后一回合、`policy` 与当前一致、`available === true`。
5. `agent.status === 'idle'`，且没有正在运行的审查。
6. 距上次尝试 ≥ `minIntervalMs`。

满足则进入 `runIdleReview()`。**在开始尝试时**把 `lastHandledDueAt` 推进到 `pendingDue` 并清空 pending：失败、中断、abort 都算已处理，与现有“尝试计数”语义一致，避免同一晚反复重试。

不满足时：

| 阻塞原因 | 处理 |
| --- | --- |
| 正在回合中 / Agent 非 idle | 保留 pending，回合结束时再试 |
| 还没有完成的回合，或 `reviewAdmission` 尚未建立（例如刚重启） | 保留 pending，等下一次回合结束；若到下一次时钟 tick 仍未处理，旧 pending 被新的 due 取代 |
| 活动分不足、内容门槛不足、`maxPerSession` 用尽、`minIntervalMs` 未到 | 视为已处理（跳过本次），写状态，等明天 |
| `reviewAdmission` 明确不可用 | 视为已处理（跳过本次），避免整天空转；下次回合重新做准入检查后自然恢复 |
| 审查正在运行 | 跳过本 tick，不排队第二次 |

### 4.3 与回合结束、新回合的关系

- `finishTurn`：更新活动分后调用 `maybeRunClockReview()`，替代现在的“排 `idleReviewMs` 定时器”。
- 新回合开始（`agent/pre-step` step 1、`assemblePrompt`）：只中止“正在运行”的审查（现有行为），不清除时钟 timer，也不取消 pending；pending 在本回合结束后再执行。
- `finishTurn` 原本会 `cancelIdleReview(true)`；改造后拆成两个动作：
  - `abortRunningReview()`：中止正在运行的审查/准入检查，bump `reviewEpoch`。
  - `clearClockTimer()` / `armClock()`：只在销毁、配置变化、执行完 tick 时操作。
- 被 abort 的回合不更新“最后完成回合”，因此不会成为钟点审查的对象。

### 4.4 补跑边界

- 补跑窗口天然 ≤ 24h：`previousOccurrence` 最多回看一天。
- 连续多天没运行：只补最近一个 due；活动分来自 `turnActivity` 内存累计，重启后为空，通常不满足资格，直接跳过。
- 补跑发生在“下一次回合结束”时，因为 `reviewAdmission` 只能在真实 open step 里通过 `checkReviewAccess` 建立（见第 5 节）。
- `lastHandledDueAt` 只在成功执行或判定跳过时写；busy/未建立准入导致的延迟不写。

## 5. 关键约束：admission 只能在回合内检查

`AutomaticReviewAdmission.check()` 要求 `openAgentStep(agent) !== undefined`，并通过 `executeHostTool` 实际调用 `mnemon_subagent_result` 做 5 秒挑战；Agent 空闲时没有 open step，钟点触发时无法现场检查。因此：

- 钟点执行复用该会话**最后一个完成回合**留下的 `reviewAdmission`（`turn`、`policy`、`available`）。这和现在 `finishTurn` 排定审查后使用同一份准入状态是同一语义。
- 若刚重启、`reviewAdmission` 为空，钟点审查推迟到下一次回合结束；届时 `prepareReviewAccess` 会为新回合建立准入，补跑随即执行。
- 若最后一次准入是 `unavailable`，跳过当次；下次回合会重新检查。
- 不新增“空闲时合成 open step”的机制，不降低准入强度。

## 6. 状态持久化

新状态文件，与现有 watermark 同目录：

```
<runtimeDirectory>/state/idle-review/<sha256(sessionId)>.clock.json
```

```json
{ "version": 1, "sessionId": "…", "lastHandledDueAt": 1794384000000 }
```

- 与 `IdleReviewWatermarkStore` 相同的目录、原子写、大小上限；不共享 watermark 文件，因为 watermark 受 `persistWatermark` 开关控制且语义是尝试配额。
- 不受 `persistWatermark` 影响：补跑需要它，默认开启。
- 读取失败、损坏、缺失：视为首次运行，按“最近一个 due 已处理”初始化，不补跑，不阻塞审查。
- 写入失败：记录错误，内存中仍推进，避免整晚循环；下一次成功写入时修正。
- 不保存 `pendingDue`：它由 `lastHandledDueAt` 与当前 `due` 推导，因此最多补一次。

## 7. 配置解析、策略与快照

- `src/host/config/schema.ts`：`IdleReviewSchema` 增加 `at: z.string().regex(...).default(DEFAULT_IDLE_REVIEW.at)`。
- `src/host/config/defaults.ts`：新增 `DEFAULT_IDLE_REVIEW_AT = '00:00'` 与 `CLOCK_TIME_PATTERN`。
- `src/host/protocol/config.ts`：`DEFAULT_IDLE_REVIEW`、`ResolvedIdleReviewConfig` 增加 `at: string`。
- `src/host/config/normalize.ts`：把 `at` 纳入归一化（非法值报错）。
- `reviewPolicy()` 自动包含 `idleReview.at`（整个 `idleReview` 已序列化），因此改钟点会使旧准入/旧 timer 失效。
- `snapshot()`：
  - `idleReviewPending` 改为 `pendingDue !== undefined || reviewRunning`（不再等于“timer 存在”）。
  - `nextReviewAt` 改为下一次 `at` 的 ISO 时间。
  - 可选新增 `clockReview: { at, nextReviewAt, lastHandledDueAt }`，便于诊断；若加，同步 client 类型与测试。
- `idleReviewMs` 仍保留在 `Config`/`normalize`/`reviewPolicy` 中但不再驱动调度；文档标注 deprecated。

## 8. 设置页

- `src/client/component-settings.tsx` 的 `IdleReviewRows` 在“启用”开关下新增一行 “Review time”：`<input type="time">`（或 `text` + `pattern`），值来自 `savedReview.at`，写入走 `reviewWrite(..., { at }, ...)`。
- 去掉 `idleReviewMs` 的展示（现状本来就没有，确认无残留）。
- locale：`src/client/locales.ts` 新增 `config.reviewAt`、`config.reviewAtHint`（en；若仓库有 zh-CN 同步）。
- 限制区徽标保持 `minIntervalMs · maxPerSession` 不变。

## 9. 技能复盘同钟点

技能复盘（`src/host/skill-evolution.ts`）当前在 `turn/end` 后累计轨迹窗口，满足 `reviewThreshold` 后等 `idleSeconds`（默认 20s）+ `cooldownSeconds`（默认 150s）在 Agent 空闲时跑。改造为同一钟点：

- 时钟时间复用 `idleReview.at`，不新增第二个时间字段。`SkillEvolutionHost` 增加 `reviewAt(): string`，由 `plugin.ts` 注入 `() => runtime.config.idleReview.at`；设置页的时间输入始终可见（即使 idle review 关闭），文案说明它同时控制技能复盘。
- `SkillEvolution.watch(agent)` 在会话加载时武装每日 timer；`turn/end` 只累计窗口，不再排 `idleSeconds` 定时器。
- 到点：若 `evolution` 关闭、`allowCreate`/`allowUpdate` 都关、窗口分低于 `reviewThreshold`、`cooldownSeconds` 未到、或 `state.running` 存在，则跳过本次；Agent 非 idle 时保留 pending，回合结束再试。
- `cooldownSeconds` 保留为两次技能复盘的最小间隔；若到点仅因冷却未到，排一个短的一次性重试（剩余冷却时间），不丢当天。
- `idleSeconds` 标记 deprecated：保留解析，不再参与调度；设置页移除该参数。
- 不做持久化补跑：轨迹窗口只在内存，Host 重启后为空，没有可复盘的内容；重启后等下一个钟点。
- `settingsChanged()` 对每个已 watch 的会话重新武装 timer，使新时间立即生效；`reviewNow()` 只取消“待执行的一次性重试”，不清除每日时钟。

## 10. 文档

- `docs/en/reference/configuration.md` 与 `docs/zh-CN/reference/configuration.md`：
  - 示例由 `idleReviewMs: 30000` 改为 `idleReview.at: "00:00"`（并保留 `idleReviewMs` 的 deprecated 说明）。
  - idleReview 选项表增加 `at`。
  - 505–531 行关于 idle review 的段落改写：触发改为每日钟点；补跑语义；删除 “Restart never replays work or schedules catch-up review” 这句不成立的描述。
- `docs/en/reference/workflows.md:338` 与 zh-CN 对应段落改为“下一个 `idleReview.at`；错过则下一次会话活动时补跑”。
- README 中“idle review”描述若有“30 seconds / idle”措辞一并更新。
- `verify:docs` 必须通过。

## 11. 测试

新增单元测试：

- 时点计算：当天已过/未过、跨月、跨年、DST 春令时 02:30、23:59。
- `at` 校验：非法字符串在配置加载时报错。
- 状态 store：读写、缺失、损坏、超限、原子写。
- 补跑判定：无状态不补跑；`lastHandledDueAt < due` 补跑；已处理不补跑。

生命周期测试（fake timers）：

- 00:00 空闲且资格满足 → 跑一次；次日再跑。
- 到点正在回合中 → 该回合结束后跑。
- 新回合开始不丢时钟 timer、不丢 pending；中止运行中的审查但保留时钟。
- 重启补跑：状态落后 → 下一次回合结束跑一次；之后不重复。
- 活动不足 / 无完成回合 / `reviewAdmission` 不可用 → 跳过并推进；准入随后可用时按规则补跑。
- `maxPerSession` 用尽、`minIntervalMs` 未到、`enabled=false`、配置改钟点重排、销毁清理。
- 技能复盘：到点窗口分不足不跑；到点正在回合中，回合结束跑；`cooldownSeconds` 未到时短重试；`settingsChanged` 改时间后立即重排；手动 `reviewNow` 不清每日时钟。
- 审查失败/中断也推进 `lastHandledDueAt`，同一晚不重试。

回归与更新：

- `tests/lifecycle.spec.ts` 中依赖 `idleReviewMs` 的 138 处匹配、`tests/config.spec.ts`、`tests/idle-review-tool-access-host.spec.ts`、`tests/review-tools.spec.ts` 与 fixture 同步调整。
- snapshot 字段变化同步到 client 类型与断言。

## 12. 发布与安装

- changeset：`minor`，版本 0.6.0；CHANGELOG 说明触发方式变更与 `idleReviewMs` 弃用。
- 分支 `feat/clock-review` 推送到 `raininfall/dsh-mnemon`，PR 到 fork 的 `main`。
- 本机验证：`pnpm build` 后把 `~/.dsh/profiles/web/package.json` 的 `"dsh-mnemon": "0.5.50"` 换成 `link:/Users/rain/lab/dsh-mnemon`（或 `pnpm pack` 的 tarball），重启 DSH Web。
- 验证方式：临时把 `idleReview.at` 设为几分钟后，确认到点且会话空闲时执行一次；再重启验证补跑。
- 需要用户确认的点：是否允许改其 web profile 的依赖；link 还是 tarball。

## 13. 风险

- 会话必须加载/存活；未打开的会话不会在 00:00 被审查——这是方案 B 的固有限制，方案 C 才能覆盖。
- Host 重启后要等一次真实回合才建立 admission，补跑因此可能发生在重启后的首个回合结束时。
- 系统休眠/时钟跳变会让 timer 延迟；由回调重算与补跑兜底。
- 测试改动面大，`lifecycle.spec.ts` 的定时器断言需要系统性重写。
- 技能复盘与 idle review 同在 00:00 触发，两个后台任务可能同时占用 provider/子代理并发；若实际冲突明显，再考虑给技能复盘加固定偏移。
- 首次升级不补跑，用户可能期望“升级当晚就跑”——当晚的 00:00 正常跑，不受影响。

## 14. 决策记录

- 选 B（m00293）：每会话钟点 + 补跑；不选 C，因为跨会话枚举/恢复/并发控制风险大、收益小。
- 审查行为不变（m00267）：只换触发，不改评分、准入、写入规则。
- 用独立 clock 状态文件而不是扩展 watermark：watermark 受 `persistWatermark` 控制，且语义不同。
- 状态缺失按“已处理”初始化：避免升级/状态损坏后突然补跑一次。

## 15. 待确认

1. 默认 `00:00`、配置键 `idleReview.at` 是否可以。
2. 安装方式：改你的 web profile 用 `link:`，还是 `pnpm pack` 后装 tarball，还是只推到 fork 由你自行安装。
3. 已确认：技能复盘也改同一钟点（`idleReview.at`）。
