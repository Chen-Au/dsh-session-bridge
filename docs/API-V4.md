# 星桥 API V4 契约（state / command / events / resource）

> 配套文档：`docs/4.0-architecture.md`（分层与领域设计）
> 基线：`session-bridge` v3.5.0 快照；目标：4.0.0（`schemaVersion='4.0.0'`）
> 原则：**additive only**。V3 客户端继续可用；V4 客户端必须容忍缺失的新字段（默认空）。
> 落盘说明：本文件同样因沙箱限制写在 `default-workspace/docs/`，合并时复制到仓库 `docs/`。

---

## 1. 端点总览

| 方法 | 路径 | 状态 | 用途 | 鉴权 |
|---|---|---|---|---|
| GET | `/api/session-bridge/state` | 已有 | 全量状态快照（UI 每 5s 轮询） | loopback + Host 校验 |
| GET | `/api/session-bridge/state?v=4` | 新增（参数） | 显式请求 V4 形状（当前默认已含 V4 字段，参数仅作未来分支） | 同上 |
| POST | `/api/session-bridge/command` | 已有 | 唯一写入口；body `{action,payload,requestId?}` | 同上 + `content-type: application/json` + `x-session-bridge-action: 1` |
| GET | `/api/session-bridge/computer/priority?owner=<sessionId>` | 已有（**注册待修**） | computer-use 优先级查询 | loopback |
| GET | `/api/session-bridge/events?sinceSeq=<n>&limit=<1..500>` | 新增（4.0 可选） | 事件导出/调试/审计 | loopback |
| GET | `/session-bridge/app` | 已有 | 星桥独立窗口 HTML | loopback |
| GET | `/session-bridge/file?path=<abs>` | 已有 | 文件预览（白名单扩展名） | loopback |

通用响应头：`content-type: application/json; charset=utf-8`、`cache-control: no-store`、`x-content-type-options: nosniff`。

### 1.1 命令请求

```json
POST /api/session-bridge/command
{
  "action": "task.claim",
  "payload": { "id": "n-abc123" },
  "requestId": "cli-9f2a1c"        // 可选：幂等重试键（4.0 新增，v3 服务端忽略）
}
```

响应（成功）：

```json
{ "ok": true, "result": { }, "state": { }, "schemaVersion": "4.0.0" }
```

响应（失败）：HTTP 400/500，body 仍尽量带 `error`、可读细节与最新 `state`：

```json
{ "ok": false, "error": "任务已被会话 … 认领", "owner": "session-…", "state": { } }
```

### 1.2 actor 约定

| actor.kind | 含义 | 权限 |
|---|---|---|
| `panel` | 用户/面板（HTTP 命令） | 最高（user 50） |
| `session` | 某会话（工具调用/内部） | 按保护级别与角色判定 |
| `tool` | 模型工具调用（审计区分） | 同 session |
| `system` | 定时器/巡检 | 仅维护类动作 |

---

## 2. `state` V4 形状

顶层字段（★=V4 新增/扩展；其余为 V3 保留，语义不变）：

```jsonc
{
  "ok": true,
  "version": "3.5.0",              // 插件版本（仍为包版本）
  "schemaVersion": "4.0.0",        // ★ 数据契约版本
  "defaultWorkspace": "C:\\…",
  "rules": [ /* board entries，V3 兼容视图 */ ],
  "groups": [ { "id":"g-…","name":"…","kind":"|bugfix|council","workspace":"…","goal":"…",
                "managerSessionId":"…","sessionIds":["…"],"focusSessionId":"…","focusUpdatedAt":0,
                "createdAt":0,"updatedAt":0 } ],
  "sessions": [ /* 见 2.1 */ ],
  "reputation": [], "activity": [], "relations": [],
  "maintainer": null | { "sessionId":"…","handle":"…","avatar":"…","role":"…",
                         "protectionLevel":"maintainer","protectionLabel":"…","protected":true,"service":true },
  "bugfix": { "available":true,"exists":true,"groupId":"…","name":"星桥 · 修bug",
              "managerSessionId":"…","memberCount":0,"openReports":0 },
  "health": null | { },
  "skills": [], "profiles": {}, "offices": [], "pauses": { "sessions":{},"tasks":{},"requests":{} },
  "council": { "version":1,"groupId":"…","members":["…"],"chair":"…","createdAt":0,"updatedAt":0 },
  "officeCatalog": [ { "id":"owner","name":"星桥主理人","level":100,"description":"…" } ],
  "officePromotionRules": [ /* 晋升规则 */ ],
  "world": [ /* channel==='world' 的条目（V3 形状） */ ],

  "taskLines": [ /* 见 2.2 */ ],
  "taskLineStats": { "total":0,"waiting":0,"active":0,"stalled":0,"paused":0,"done":0,"canceled":0,"nudged":0 },
  "taskFlows": { "<taskId>": [ /* 见 2.3 */ ] },

  "completionNotices": [ { "id":"…","taskId":"…","groupId":"…","groupName":"…","title":"…","text":"…",
                           "author":"…","authorHandle":"…","panelMention":false,
                           "completionNotice":true,"completedAt":0,"ts":0 } ],
  "completionStats": { "total":0,"latestAt":0 },
  "duplicates": [ /* 合并建议 */ ],
  "approvals": [ /* 见 2.4（仅 pending 下发） */ ],
  "inbox": { /* ★ 见 2.5 */ },
  "commandCenter": { /* ★ 见 2.6 */ },
  "computerResource": { /* ★ 见 2.7 */ },
  "permissions": { "grants": [] },
  "pendingAsks": [ { "id":"…","requestId":"…","groupId":"…","groupName":"…","title":"…","author":"…",
                      "targetIds":[],"dependsOn":[],"delayMs":0,"notBefore":0,"createdAt":0,"status":"queued" } ],
  "pendingStats": { "queued":0,"sent":0,"failed":0 },
  "capabilities": { "createSession":true,"wakeSessions":true,"bugfixGroup":true,
                    "protectionLevels":["user","maintainer","group-manager","coordinator","member"],
                    "interrupt":"cancel","retract":true },
  "config": { "provider":"","model":"","injectMode":"targeted","autoPrompt":true,"autoCapture":true,
              "askOnCreate":true,"approveAutoCreate":true,"instructions":true,"scope":"workspace",
              "maxShown":8,"maxChars":460,"maxStored":80,"urgentIntervalMs":60000,"boardDir":"…" },
  "deliveries": { "<entryId>":[ { "sessionId":"…","title":"…","deliveredAt":0,"acceptedAt":0 } ] },
  "stats": { "rules":0,"groups":0,"sessions":0,"profiles":0 },
  "eventsCursor": 0                // ★ 可选：最后已应用 v4 事件 seq
}
```

### 2.1 session 元素

```jsonc
{
  "id":"session-…", "contactId":"aaaaaaaa", "title":"…", "handle":"…", "avatar":"🐼",
  "role":"…", "office":"首席技术员", "officeLevel":80, "officeMerit":0, "officeNext":"运维总管",
  "officePrivileges": { "level":80, "priorityRouting":80, "canRecruit":true,
                         "canApproveTransfer":true, "canPauseTask":false, "technicalPriority":true },
  "skills":["写作"], "style":"严谨", "persona":"…",
  "cwd":"C:\\…", "live":true, "status":"idle|running|history", "createdAt":0,
  "agentPreset":"", "teamRole":"lead|teammate|null", "internal":false,
  "points":0, "successes":0, "failures":0, "closed":false,
  "hasProfile":true, "protectionLevel":"member", "protectionRank":10, "protectionLabel":"成员",
  "protected":false, "service":false, "worldEligible":true, "mentionEligible":true,
  "availability":"idle|busy", "currentTask":null|{"…":"…"}, "openRequestCount":0, "lastSubmittedAt":0,
  "isLead":true
}
```

### 2.2 taskLine（V3 已有，V4 冻结）

```jsonc
{
  "title":"…", "taskId":"n-…","groupId":"g-…","groupName":"…","worldTask":false,
  "taskStatus":"assigned|delegating|collecting|done|working|canceled",
  "leaderId":"session-…",
  "leader": { "id":"…","title":"…","handle":"…","contactId":"…","protected":false } | null,
  "members":[ { "id":"…","title":"…","handle":"…","contactId":"…","protected":false } ],
  "steps":[ { "i":1,"text":"接收与确认","status":"pending|dispatched|done|canceled",
              "auto":true,"dispatchedAt":0,"doneAt":0,"requestId":"" } ],
  "currentStep":1, "currentStepText":"执行", "progress":0,
  "lineStatus":"waiting|active|stalled|done|canceled|paused",
  "lastProgressAt":0, "lastNudgeAt":0, "nudgeCount":0, "stalledSince":0,
  "replyRequestId":"", "taskScope":"", "ts":0,
  "synthetic":true|undefined,      // 群工作合成线
  "paused":true|undefined, "pauseReason":"", "pausedAt":0
}
```

### 2.3 taskFlow 事件（V3 已有；V4 起来源切到 events，结构不变）

```jsonc
{ "ts":0, "from":"session-…|panel", "fromName":"…", "to":["session-…"], "toNames":["…"],
  "action":"任务创建 / 分配|派发任务|请求 / 探测|回复 / 交接|交接|补充说明|完成通知",
  "detail":"…", "kind":"assign|request|reply|handoff|note|done",
  "status":"open|answered|canceled", "step":0 }
```

### 2.4 approval（V3 已有 + V4 扩展）

```jsonc
{
  "id":"ap-…", "status":"pending|approved|rejected|canceled",
  "createdAt":0, "title":"…", "text":"…",
  "source":"group.recruit|world", "engine":"group.recruit",
  "route":"new", "reason":"…", "memberCount":1,
  "workspacePath":"", "workspaceName":"…", "permissionNote":"…",
  "groupId":"g-…", "groupName":"…", "requester":"session-…|panel",
  "payload": { "group":"g-…","text":"…","count":1,"mode":"auto","skills":[] },
  "votes": { "<voterSessionId>": { "vote":"approve|reject","reason":"","at":0 } },
  "councilGroupId":"g-council-…", "councilRequestId":"n-…", "councilNotifiedAt":0,
  "approvedAt":0, "approvedBy":"council|panel", "rejectedAt":0, "rejectedBy":"…",
  "expiresAt":0,                    // ★ 4.0：超时交还用户（默认 +30min）
  "escalatedAt":0, "escalatedTo":"panel"
}
```

法定票数：`quorum = max(1, ceil(council.members.length / 2))`。
终态唯一；`approveCount>=quorum → approved`；`rejectCount>=quorum → rejected`。
面板直批：`approval.approve`（新增，actor=panel，直接 resolved+executed）。

### 2.5 `inbox`（★ 4.0 正式契约）

```jsonc
{
  "items": [ {
    "id":"approval:ap-…",                 // 唯一 id：<kind>:<业务id>
    "kind":"approval|approval-timeout|urgent-request|request|stuck-task|paused-task|queued-ask|completion|lease-wait",
    "priority":90,
    "ts":0,
    "title":"…", "detail":"…",
    "groupId":"", "groupName":"", "taskId":"", "sessionId":"",
    "action":"open-approval|open-group|open-task|open-session|open-resource|open-world",
    "target": { "view":"approvals|tasks|groups|resource|world", "groupId":"", "taskId":"", "approvalId":"", "sessionId":"" },
    "actions": [ { "id":"approve","label":"批准","command": { "action":"approval.approve","payload": { "approvalId":"ap-…" } } } ],
    "unread":true, "createdAt":0, "expiresAt":0
  } ],
  "attention": [ /* items 中 priority>=75 的前 12 条（同结构） */ ],
  "total":0, "attentionCount":0, "unreadCount":0,
  "generatedAt":0
}
```

kind → priority：`approval 90`、`approval-timeout 92`、`urgent-request 85`、`lease-wait 82`、`stuck-task 80`、`request 60`、`paused-task 50`、`queued-ask 45`、`completion 35`。
排序：`priority desc → ts desc → id asc`；`items` 上限 40，`attention` 上限 12。

### 2.6 `commandCenter`（★ 4.0）

```jsonc
{
  "schemaVersion":"4.0.0",
  "attentionCount":3, "inboxCount":9, "unreadCount":2,
  "activeTasks":5,
  "stalledTasks":1, "pausedTasks":0,
  "approvalTimeoutCount":0,
  "council": { "members":3,"chair":"session-…","pendingApprovals":1 },
  "computer": { "available":true,"owner":"session-…","ttlMs":38000,"degraded":false }
}
```

### 2.7 `computerResource`（★ 4.0 扩展）

```jsonc
{
  "schemaVersion":"4.0.0",
  "ok":true, "available":true, "resourceId":"desktop",
  "label":"Windows 桌面（computer-use）",
  "lease": {
    "owner":"session-…", "ownerName":"论文写作-第一篇", "label":"session:…",
    "acquiredAt":0, "expiresAt":0, "ttlMs":0, "heldByMe":false
  },
  "priority": { "scale":"office*10000+points", "current":800012, "office":"首席技术员", "officeLevel":80, "points":12 },
  "queue": [],
  "degraded": false,
  "degradedReason": "",
  "observedAt": 0
}
```

`available:false` 时保留 `ok:true` 且 `lease:null`；读文件失败 → `ok:false, degraded:true, degradedReason:"lease-unreadable"`。
`queue` 4.0 恒为 `[]`（computer-use 未暴露 waiters）；4.1 起从 `waiters.json` 只读投影。

---

## 3. 命令目录（V4）

> 全部经 `POST /command`（`action` + `payload`）。权限由服务端 governance 判定；下表“actor”为建议调用方。

### 3.1 任务 / 信息流

| action | payload | 说明 |
|---|---|---|
| `world.post` | `{text, workspace?, members?, steps?, taskScope?, allowDuplicate?, forceNew?, approved?}` | 发布世界任务/建群 |
| `group.post` | `{group, text, task?, coordinator?, assignees?, steps?, taskScope?}` | 群任务/群聊 |
| `task.claim` | `{id}` | 认领归属锁 |
| `task.release` | `{id}` | 释放归属锁 |
| `task.dedupe` | `{apply?}` | 重复任务建议/合并 |
| `task.pause` / `task.resume` | `{id?, sessionId?, reason?}` | 暂停/恢复任务线 |
| `task.lines` | `{}` | 手动返回 taskLines（调试） |
| `entry.retract` / `message.retract` | `{id, reason?}` | 撤回条目/任务/请求 |
| `session.ask`（工具侧） | 见工具参数 | 定向请求/派活（串行 dependsOn） |
| `pending.cancel` | `{id}` | 取消排队 |

### 3.2 收件箱（★ 4.0 新增）

| action | payload | 说明 |
|---|---|---|
| `inbox.ack` | `{id?}` | 标记已读；缺省=全部 attention 已读 |
| `inbox.mute` | `{kind, minutes}` | 静音某类（approval 不可静音） |
| `inbox.act` | `{itemId}` | 执行 item 默认动作（等价前端点 action 按钮） |

### 3.3 治理 / 小议会

| action | payload | 说明 |
|---|---|---|
| `council.vote`（工具 `council_vote` 等价） | `{approvalId, vote, reason?}` | 仅议会成员 |
| `council.status` | `{}` | 议会 + 待审批 |
| `approval.list` | `{}` | pending 列表 |
| `approval.reject` | `{approvalId, reason?}` | 面板/维护者驳回 |
| `approval.approve` | `{approvalId}` | ★ 面板直批（绕过 quorum，审计 by=panel） |
| `approval.escalate` | `{approvalId}` | ★ 交还用户（超时自动调用） |
| `office.list` / `office.promote` / `office.assign` / `office.revoke` / `office.user.set` | 见实现 | 官职 |
| `perm.grant` / `perm.revoke` | `{sessionId}` | 唤醒授权 |
| `maintainer.set` / `maintainer.get` | `{sessionId?}` | 维护者 |
| `session.pause` / `session.resume` | `{sessionId, reason?}` | 会话暂停（巡检跳过） |
| `health.check` | `{}` | 巡检 |

### 3.4 资源（★ 4.0 新增/冻结）

| action | payload | 说明 |
|---|---|---|
| `resource.status` | `{resourceId?}` | 刷新并返回 computerResource |
| `resource.priority` | `{sessionId}` | 调试：返回优先级分解 |
| `resource.lease.release` | `{resourceId?, force?}` | 4.2：管理员强制释放；4.0 返回 `not-supported` |
| `agent.interrupt` | `{sessionId, reason?}` | 打断运行轮（已有，非资源域） |

### 3.5 群 / 世界 / 会话 / 社交（V3 保留，不在此重复）

`group.create|update|rename|delete|add|remove|manager|focus|discuss|recruit|like|suggest|skill`、`session.wake|urgent|revive|recover|compact|identity.set`、`share.post`、`rule.*`、`activity.*`、`bugfix.*`、`presence.ping`、`config.update`、`workspace.*` 等保持原样；V4 不删除任何 action。

---

## 4. 事件（events.v4.jsonl）

### 4.1 Envelope（每行一条）

```jsonc
{
  "v":4, "seq":123, "id":"ev-123-1a2b3c4d",
  "type":"task.assigned",
  "ts":1794303194786,
  "actor": { "kind":"panel|session|tool|system", "id":"session-…|panel|timer", "name":"…" },
  "subject": { "kind":"task|request|entry|approval|lease|group|session|office|resource", "id":"…" },
  "payload": { },
  "dedupeKey":"task:assigned:<taskId>:<owner>",
  "source": { "surface":"tool|panel|timer|system", "command":"session_ask" },
  "causedBy":"ev-…|null"
}
```

### 4.2 类型表（4.0 必选）

| 域 | type |
|---|---|
| 任务 | `task.created` `task.assigned` `task.delegated` `task.replied` `task.handoff` `task.completed` `task.reassigned` `task.retracted` `task.paused` `task.resumed` |
| 条目 | `entry.created` `entry.retracted` `entry.answered` `entry.retargeted` `entry.claimed` |
| 治理 | `council.formed` `approval.requested` `approval.voted` `approval.resolved` `approval.executed` `approval.escalated` `office.promoted` `permission.granted` `permission.revoked` `pause.set` `pause.cleared` |
| 资源 | `lease.acquire.requested` `lease.granted` `lease.renewed` `lease.released` `lease.expired` `lease.queued` `lease.preempted` |

### 4.3 幂等与保留

- `dedupeKey` 24h 内重复 → 丢弃（返回 `deduped:true`，不写行）。
- `seq` 单文件单调；启动回填 `lastSeq` 与最近 5000 个 dedupeKey。
- 保留：最近 90 天 + 全部终态（`*.completed`、`approval.*resolved/executed`、`lease.*`），8MB/30 天触发压缩。
- 导出：`GET /events?sinceSeq=N&limit=500` 返回 `{ok, events:[…], lastSeq}`。

---

## 5. 错误码（V4 统一）

| code | HTTP | 含义 | UI 处理 |
|---|---|---|---|
| `ok` | 200 | 成功 | — |
| `duplicate` | 400 | 24h 查重命中 | 展示 existing id/owner |
| `group-not-found` | 400 | 群不存在 | 刷新群列表 |
| `forbidden` | 403 | loopback/Host 校验失败 | 不重试 |
| `forbidden-action` | 403 | 缺 CSRF 头 | 前端补 `x-session-bridge-action:1` |
| `missing-owner` | 400 | priority 缺 owner | 补参数 |
| `not-supported` | 400 | 宿主/版本不支持（如强制释放） | 提示替代 |
| `lease-unreadable` | 200(ok:false) | 租约文件坏 | 显示 degraded |
| `inbox-item-gone` | 400 | item 已消失（业务已处理） | 本地移除 |
| `approval-closed` | 400 | 审批已终态 | 刷新 |
| `rate-limited` | 429 | 加急限频 | 显示 retryAfterMs |
| `state-failed` | 500 | 构建 state 失败 | 显示重连中 |

---

## 6. 深链（UI hash 路由）

| 目标 | 链接 | 打开 |
|---|---|---|
| 审批 | `#/approvals?approvalId=ap-…` | 通知中心/审批详情 |
| 任务线 | `#/tasks?taskId=n-…` | 任务 tab + 展开信息流 |
| 群 | `#/groups?groupId=g-…` | 群聊 tab + 选中群 |
| 会话 | `#/groups?sessionId=session-…` | 群聊/成员卡 |
| 资源 | `#/resource/desktop` | 资源详情 |
| 世界 | `#/world?entryId=n-…` | 世界流定位 |

约定：**能否跳转只看 `target` 字段**；不接受用标题/名称猜目标。

---

## 7. 兼容矩阵

| 客户端 / 服务端 | V3 服务端（旧包） | V4 服务端（新包） |
|---|---|---|
| V3 UI | 正常 | 正常（新增字段被忽略） |
| V4 UI | 正常（新字段缺失 → 显示空/降级） | 正常 |
| computer-use 旧版 | 硬编码 43129 查询 priority | 读 `bridge.json` 优先，失败回退硬编码 |
| 契约测试 | 旧 123 条 | 旧 123 条 + V4 段（≥8 条）全 PASS |

V4 UI 必须实现的降级：

```js
const inbox = state.inbox || { items: [], attention: [], attentionCount: 0, unreadCount: 0 }
const computer = state.computerResource || { available: false, degraded: true }
const schema = state.schemaVersion || '3.0.0'
```

---

## 8. 契约测试清单（M1 新增，`test/contract.mjs`）

1. `state.schemaVersion === '4.0.0'`；
2. `state.inbox` 结构：items/attention/total/attentionCount 存在；open request → 出现 `kind:'request'`；approval → `kind:'approval'` 且 `priority:90`；
3. `state.commandCenter` 字段齐全且 `attentionCount === state.inbox.attentionCount`；
4. `state.computerResource`：无租约文件 → `available:false` 且 `degraded:true`；有夹具租约文件 → `lease.owner` 正确；
5. priority 路由：桩 `webServer` 捕获的 routes 含 `/api/session-bridge/computer/priority`（防 R1 回归）；
6. `inbox.ack` 后 `unreadCount` 下降、业务对象不变；
7. 幂等：同一 `requestId` 发两次 `task.claim` → 第二次 `deduped:true`，状态不变；
8. 事件：一次 `task.completed` 只产生 1 条 `task.completed` 事件（fixture 读 events 文件计数）。

---

## 9. 变更日志模板（每次改 API 必须填）

```md
## vX.Y.Z — YYYY-MM-DD
- 新增：<字段/action/事件/端点>
- 修改：<语义变化（尽量避免）>
- 兼容：旧客户端表现 / 回滚开关
- 测试：contract 新增 N 条；ALL PASS
```
