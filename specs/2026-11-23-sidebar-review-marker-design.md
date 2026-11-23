# 侧栏审查标记（Sidebar Review Marker）设计

日期：2026-11-23 · 状态：待批准 · 前置：2026-11-22-clock-review-design.md（每日时钟审查）

## 目标

在 DSH 左侧栏的会话行上标记「dsh-mnemon 空闲审查已覆盖该会话当前内容」，
让用户安全归档已审查会话，不因归档错过记忆提取。审查之后会话又产生新对话时，
标记改为「待复审」样式（用户选定语义，m00231）。

## 非目标

- 不改变审查触发节奏（当天新会话当天不审查的限制保留，见「已知限制」）。
- 不改 DSH 本体（无新 SessionEvent、无 slot 声明改动）。
- 不覆盖 subagent 会话（审查本身只跑 root session）。

## 机制总览（方案 A）

| 层 | 改动 |
| --- | --- |
| host（dsh-mnemon） | 新增全局 marker store + 两处写入点 + review RPC 新增 `markers` 方法 |
| client（dsh-mnemon） | 注册 `sidebar.session.row.trailing` 槽位，渲染双态图标 |
| DSH | 无 |

## 数据

### marker 文件

`~/.mnemon/state/review-markers.json`（全局 storage root，`resolveGlobalDataDir()`，
与 clock 文件同根但独立单文件；`storageScope` 为 workspace 时 marker 仍写全局根，
因为侧栏跨 workspace 按 sessionId 读取，无法预知行属于哪个 scope）：

```json
{
  "version": 1,
  "markers": {
    "session-45b27009-…": { "at": 1795276800000, "outcome": "reviewed" },
    "session-ec251cb5-…": { "at": 1795363200000, "outcome": "skipped" }
  }
}
```

- `at`：epoch ms，写入时刻。
- `outcome`：`"reviewed"`（真跑了审查，成功或被中止前已 consumeDue 之后的正常完成路径）
  或 `"skipped"`（每日 due 到点但内容门槛不足，`reviewActivity().eligible` 或
  `reviewAdmitted()` 为 false）。门槛不足也算「已审查」是用户明确要求（m00186 语义），
  但图标可区分（见呈现）。
- 写失败静默降级（与 clock store 相同的 warnClock 模式），不影响审查本身。
- 无限增长不做淘汰：一条 marker ≈ 90 B，千会话 90 KB，可忽略；不做 LRU（KISS）。

### 写入点（lifecycle，`MnemonAgentLifecycle`）

1. `tryPendingIdleReview`：内容门槛不足而 `consumeDue(due)` 的分支 →
   `recordMarker("skipped")`。
2. `runIdleReview` 成功路径末尾（`this.mark("review")` 第二次出现处）→
   `recordMarker("reviewed")`。中止/失败路径不写。

`recordMarker` 在 `MnemonAgentLifecycle` 上，经 `runtimeDirectory?.()` 的同一来源
解析全局根（`resolveGlobalDataDir()` 直接调用即可，与 forAgent 的 workspace 图无关），
agent id 即 sessionId。

### RPC

`MNEMON_REVIEW_CHANNEL` 新方法 `markers`：无参数，返回
`{ markers: Record<sessionId, {at, outcome}> }`（读整个 JSON 文件，解析失败返回空集）。
注册进 `MNEMON_RPC_ENDPOINTS[MNEMON_REVIEW_CHANNEL]` 数组（src/host/protocol/channels.ts:48）。

## 呈现（client）

组件 `SessionRowReviewMarker`，注册
`ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({ name, id: 'mnemon.review-marker', order: 15, locale: 'mnemon' }, …))`。
（order 15：forge 占 10，mnemon 排其后；槽位是 root scope，owner 只给 `sessionId`，
标准 props 带 `useSessions`。）

判定（纯前端，无逐行 IO）：

```
marker = markers[sessionId]                       // 一次性批量拉取，见下
updatedAt = useSessions(s => s.byId[sessionId]?.updatedAt)
!marker            → 不渲染
marker.at >= updatedAt → 实心勾   aria: t('marker.reviewed')  ('已审查，可安全归档')
marker.at <  updatedAt → 空心勾   aria: t('marker.stale')     ('审查后有新对话，待复审')
```

- `updatedAt` 由 DSH 在每条 `user/message` 事件上 emit `api-session/activity`
  实时推进（session-controller/src/index.ts:245），所以「新对话撤销标记」自动成立，
  不需要任何失效写入。
- 助手单方面输出（无新用户消息）不会使标记失效——与审查节奏一致（审查按 turn 计），
  记录此决定。
- markers 快照获取：client mount 时 `call(MNEMON_REVIEW_CHANNEL, 'markers')` 一次，
  存模块级 observable；每次 `conversation/turn` 完成信号（复用现有 change-signal.ts）
  刷新一次。不做逐行拉取、不做轮询。
- 图标用 `dsh-client-ui-primitives` 现有 glyph（check-circle / circle 变体），
  16px，颜色走行的 subdued 色，stale 态降低透明度。hover 时随槽位整体隐藏（owner 行为）。

## 已知限制（接受）

- 每日时钟：当天创建的会话当天不进入审查 → 当天不会有标记；关闭且隔天未 reopen 的
  会话永远无标记。用户已见此说明并选 A（m00435→m00436）。
- `outcome:"skipped"` 显示实心勾的语义 = 「审查器看过这段内容并判定无记忆可提取」，
  真审查与门槛跳过共用一个实心态（用户要求两者都算已审查，m00186）；不额外做第三态。
- marker 文件写于全局根：多 DSH 实例共享 `~/.mnemon` 时天然合并语义（last-write-wins
  per session）。

## 测试

- host 单测：marker store 读写/损坏文件容错；skipped/reviewed 两写入点（用现有
  lifecycle spec 骨架）；`markers` RPC handler。
- client 单测：判定函数 `markerState(marker, updatedAt)` 纯函数三分支。
- 手动：本机 web profile reopen 一个已审会话验证实心→发消息→空心→等审查→实心。

## 落地文件清单

```
src/host/review-marker-store.ts        (新)
src/host/lifecycle.ts                  (改：两处 recordMarker)
src/host/protocol/channels.ts          (改：'markers')
src/host/rpc.ts                        (改：review handler)
src/client/session-row-review-marker.tsx (新)
src/client/index.ts                    (改：slot 注册 + markers 拉取)
src/client/locales.ts                  (改：marker.reviewed / marker.stale)
+ 对应 tests/
```
