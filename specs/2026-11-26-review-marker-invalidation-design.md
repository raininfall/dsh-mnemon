# 审查标记失效（Review Marker Invalidation）设计

日期：2026-11-26 · 状态：待批准 · 前置：2026-11-23-sidebar-review-marker-design.md

## 目标

已审查（`reviewed` 或 `skipped`）的会话收到新的用户输入后，取消「已审查」状态：
侧栏标记立即消失，`state/review-markers.json` 中该会话的条目被删除。
用户选定方案 B（2026-11-26，删除持久标记，而不只是改显示）。

## 非目标

- 不改审查触发节奏、clock 文件与 watermark。
- 不改 DSH 本体，不新增 SessionEvent。
- 助手输出、mnemon 注入消息、系统上下文都不算「新输入」。

## 触发语义

只认真实用户输入：`session/event` 中 `type === 'user/message'` 且
`event.data.source.kind === 'user'`。这与 DSH 侧栏 `api-session/activity`
的判定（`packages/api/session-controller/src/index.ts:245`）完全一致，因此
「标记消失」与「侧栏会话上浮」永远同时发生。

mnemon 注入的上下文消息 `source.kind` 为 `'mnemon'` 系（`isMnemonMessageSource`），
不会触发失效；subagent 的会话不写 marker，清除是空操作。

## 机制

| 层 | 改动 |
| --- | --- |
| host store | `ReviewMarkerStore.clear(sessionId)`：load 后无该键直接返回（不建目录、不写文件）；有则删除该键并整体写回，保留其它会话条目 |
| host lifecycle | `sessionEvent` 在 session 身份校验后调用 `isUserInputEvent(event)`，命中则 clear 当前 agent 的 marker |
| client | `ReviewMarkerState` 收敛为 `'none' \| 'reviewed'`；`updatedAt > marker.at` 返回 `'none'`，不再渲染「待复审」空心勾 |

`record` 与 `clear` 共用同一 warn-once 降级（写失败只 warn 一次，不影响审查）。

### 为什么客户端也要改

`clear` 生效前，客户端最多持有 15 秒的旧 markers 快照（`refresh` 节流），
期间若保留 `stale` 态就会显示空心勾，与「取消已审查状态」不符；
直接按 `updatedAt` 判定为 `'none'` 可以立即消失，且与 host 的持久删除同语义。

## 边界与已知限制

- 审查运行中收到新输入：`preStep` 在 step 1 已 `abortIdleReview()`，
  `runIdleReview` 在 `recordMarker('reviewed')` 之前因 signal aborted 返回，
  不会把标记写回。
- 多个 DSH 实例共享 `~/.mnemon` 时，sweep 在另一实例完成审查会写回 marker；
  store 是 per-session last-write-wins，接受（与现状一致）。
- 失效只删 marker，不重置 `lastHandledDueAt`：当天已处理过的 occurrence 不会重跑，
  下一次审查按正常节奏进行。

## 测试

- store：`clear` 删除目标并保留其它会话；目标不存在时不创建文件。
- lifecycle：审查写入 marker 后，投递一条真实用户消息事件 → marker 消失；
  投递 mnemon source 的用户消息 → marker 保留。
- client：`markerState` 在 `updatedAt > at` 时返回 `'none'`；组件不渲染任何图标。

## 落地文件清单

```
src/host/review-marker-store.ts            (改：clear)
src/host/lifecycle.ts                      (改：isUserInputEvent + invalidate)
src/client/session-row-review-marker.tsx   (改：去 stale 态)
src/client/locales.ts                      (改：删 marker.stale 两语言)
tests/review-marker-store.spec.ts          (改)
tests/review-marker-lifecycle.spec.ts      (改)
tests/client-session-row-marker.spec.tsx   (改)
docs/{en,zh-CN}/guides/ui-guide.md         (改)
docs/{en,zh-CN}/reference/configuration.md (改)
docs/{en,zh-CN}/reference/storage-model.md (改)
.changeset/review-marker-invalidation.md   (新)
```
