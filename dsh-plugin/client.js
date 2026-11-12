/**
 * session-bridge 右侧边栏看板（手写 __ModuleLoader__ bundle，无构建步骤）。
 *
 * 浏览器半：把一个「经验桥」tab 类型注册进右侧栏，正文是一个看板面板，
 * 展示跨会话规矩（经验/交接/教训/约定）、群组与可见会话，并提供只读轮询
 * 与受控写操作。数据来自宿主半的同源 loopback 接口：
 *   GET  /api/session-bridge/state
 *   POST /api/session-bridge/command
 *
 * 约束：只用 react 共享模块 + React.createElement（不写 JSX）；所有样式内联，
 * 通过 --dsw-alias-* CSS 变量适配浅色/深色；任何数据形状异常都只能降级显示，
 * 绝不能把异常抛给右侧栏框架（面板外层另有 ErrorBoundary 兜底）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-bridge',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    //#region 常量
    /** 本实现的全局唯一 tab 类型 id，同时也是正文 slot 的 key。 */
    var PLUGIN_ID = 'dsh-plugin-session-bridge'
    /** 右侧栏 tab 类型 kind。 */
    var TAB_KIND = 'session-bridge'
    var STATE_URL = '/api/session-bridge/state'
    var COMMAND_URL = '/api/session-bridge/command'
    var POLL_INTERVAL_MS = 5000
    var ACTION_HEADER = 'x-session-bridge-action'
    var FONT_STACK =
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'

    var KIND_LABELS = {
      note: '经验',
      handoff: '交接',
      lesson: '教训',
      decision: '约定',
      request: '请求',
      command: '命令',
      task: '任务',
      chat: '交流',
      bug: 'BUG'
    }
    var KIND_ORDER = ['note', 'handoff', 'lesson', 'decision']
    var KIND_TONE = {
      note: 'business',
      handoff: 'success',
      lesson: 'warn',
      decision: 'brand',
      request: 'error',
      command: 'warn',
      task: 'brand',
      chat: 'business',
      bug: 'error'
    }
    /** 用户自己在面板发的内容显示为「命令」，而不是「经验」。 */
    function displayKindOf(rule) {
      if (rule && rule.kind === 'note' && (rule.author === 'panel' || rule.origin === 'panel')) return 'command'
      return rule ? rule.kind : 'note'
    }
    var TONE_COLORS = {
      business: 'var(--dsw-alias-state-business-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
      neutral: 'var(--dsw-alias-label-secondary)'
    }
    //#endregion

    //#region 纯工具（防御性：任何输入都不抛异常）
    function isPlainObject(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function asString(value, fallback) {
      if (typeof value === 'string') return value
      if (typeof value === 'number' && isFinite(value)) return String(value)
      return typeof fallback === 'string' ? fallback : ''
    }

    function asNumber(value, fallback) {
      var n = typeof value === 'number' ? value : Number(value)
      if (isFinite(n)) return n
      return typeof fallback === 'number' ? fallback : 0
    }

    function asTimestamp(value) {
      var n = asNumber(value, 0)
      return n > 0 ? n : 0
    }

    function pad2(n) {
      return n < 10 ? '0' + n : String(n)
    }

    /** 本地 `YYYY-MM-DD HH:mm`；非法时间返回占位符，绝不抛异常。 */
    function formatLocalTime(value) {
      var ts = asNumber(value, 0)
      if (!(ts > 0)) return '—'
      var d = new Date(ts)
      if (isNaN(d.getTime())) return '—'
      return (
        d.getFullYear() +
        '-' +
        pad2(d.getMonth() + 1) +
        '-' +
        pad2(d.getDate()) +
        ' ' +
        pad2(d.getHours()) +
        ':' +
        pad2(d.getMinutes())
      )
    }

    /** 会话/规矩 id 的短形式：取尾部 8 位，前缀 `session-` 先剥掉。 */
    function shortId(id) {
      var s = asString(id)
      if (s === '') return '未知'
      if (s.indexOf('session-') === 0) s = s.slice('session-'.length)
      return s.length > 8 ? s.slice(-8) : s
    }

    /** contactId：与宿主端 contactIdOf 一致——完整 id 去掉 session- 前缀后的前 8 位（稳定短 ID，可直接复制给 session_ask 的 to）。 */
    function contactIdOf(id) {
      var s = asString(id)
      if (s === '') return ''
      if (s.indexOf('session-') === 0) s = s.slice('session-'.length)
      return s.replace(/[^0-9a-zA-Z]/g, '').toLowerCase().slice(0, 8)
    }

    /** 点击复制 contactId（剪贴板不可用时静默失败，不阻塞面板）。 */
    function copyContactId(text) {
      var value = asString(text)
      if (value === '') return
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(value)
        }
      } catch (error) {
        /* ignore */
      }
    }

    /** 路径最后一段，用于会话行的紧凑显示。 */
    function cwdTail(cwd) {
      var s = asString(cwd)
      if (s === '') return ''
      var parts = s.split(/[\\/]+/).filter(function (part) {
        return part !== ''
      })
      return parts.length > 0 ? parts[parts.length - 1] : s
    }

    function errorMessage(error) {
      if (error === null || error === undefined) return '未知错误'
      if (typeof error === 'string') return error === '' ? '未知错误' : error
      if (typeof error.message === 'string' && error.message !== '') return error.message
      try {
        var text = String(error)
        return text === '' || text === '[object Object]' ? '未知错误' : text
      } catch (e) {
        return '未知错误'
      }
    }

    function confirmAction(message) {
      try {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          return window.confirm(message) === true
        }
      } catch (e) {
        // 确认框不可用时按“确认”处理（用户已经点了按钮）。
      }
      return true
    }

    /** 正文是否长到需要折叠（默认最多 3 行）。 */
    function isLongText(text) {
      var s = asString(text)
      if (s === '') return false
      return s.length > 150 || s.split('\n').length > 3
    }
    //#endregion

    //#region 状态归一化
    function normalizeRule(raw) {
      var src = isPlainObject(raw) ? raw : {}
      var kind = asString(src.kind, 'note')
      if (!KIND_LABELS[kind]) kind = 'note'
      var scope = asString(src.scope, 'workspace')
      if (scope !== 'global' && scope !== 'group') scope = 'workspace'
      var groupId = typeof src.groupId === 'string' && src.groupId !== '' ? src.groupId : null
      return {
        id: asString(src.id),
        kind: kind,
        scope: scope,
        groupId: groupId,
        groupName: asString(src.groupName) || null,
        workspace: asString(src.workspace),
        author: asString(src.author),
        title: asString(src.title) || '（无标题）',
        text: asString(src.text),
        tags: asArray(src.tags)
          .map(function (tag) {
            return asString(tag)
          })
          .filter(function (tag) {
            return tag !== ''
          }),
        files: asArray(src.files)
          .map(function (file) {
            return asString(file)
          })
          .filter(function (file) {
            return file !== ''
          }),
        requestTo: asArray(src.requestTo)
          .map(function (sessionId) {
            return asString(sessionId)
          })
          .filter(function (sessionId) {
            return sessionId !== ''
          }),
        mentions: asArray(src.mentions)
          .map(function (sessionId) {
            return asString(sessionId)
          })
          .filter(function (sessionId) {
            return sessionId !== ''
          }),
        hiddenFromChat: src.hiddenFromChat === true,
        curated: src.curated === true,
        // ⚡ 加急插话（v2.9.3）：UI 据此显示加急徽章/红色气泡。
        urgent: src.urgent === true,
        urgentBy: asString(src.urgentBy),
        urgentTo: asArray(src.urgentTo)
          .map(function (sessionId) {
            return asString(sessionId)
          })
          .filter(function (sessionId) {
            return sessionId !== ''
          }),
        taskId: asString(src.taskId),
        taskRole: asString(src.taskRole),
        taskStatus: asString(src.taskStatus),
        coordinator: asString(src.coordinator),
        assignees: asArray(src.assignees)
          .map(function (sessionId) {
            return asString(sessionId)
          })
          .filter(function (sessionId) {
            return sessionId !== ''
          }),
        // v2.10.1 任务归属锁 + 范围约束：owner/claimState/taskScope 由 state 原样下发。
        owner: asString(src.owner),
        ownerRole: asString(src.ownerRole),
        claimedAt: asTimestamp(src.claimedAt),
        claimState: asString(src.claimState),
        taskScope: asString(src.taskScope),
        scopeWarning: asString(src.scopeWarning),
        proposal: src.proposal === true,
        taskVerdict: asString(src.taskVerdict),
        proposalCount: asNumber(src.proposalCount, 0),
        lastProposalBy: asString(src.lastProposalBy),
        status: asString(src.status),
        answeredBy: asString(src.answeredBy),
        replyId: asString(src.replyId),
        ts: asTimestamp(src.ts),
        expiresAt: asTimestamp(src.expiresAt) || null
      }
    }

    function normalizeGroup(raw) {
      var src = isPlainObject(raw) ? raw : {}
      return {
        id: asString(src.id),
        name: asString(src.name) || '（未命名群组）',
        workspace: asString(src.workspace),
        goal: asString(src.goal),
        managerSessionId: asString(src.managerSessionId),
        createdAt: asTimestamp(src.createdAt),
        sessionIds: asArray(src.sessionIds)
          .map(function (sessionId) {
            return asString(sessionId)
          })
          .filter(function (sessionId) {
            return sessionId !== ''
          }),
        updatedAt: asTimestamp(src.updatedAt)
      }
    }

    function normalizeSession(raw) {
      var src = isPlainObject(raw) ? raw : {}
      var status = asString(src.status, 'idle')
      if (status !== 'running' && status !== 'idle') status = 'idle'
      var currentTask = isPlainObject(src.currentTask)
        ? {
            id: asString(src.currentTask.id),
            title: asString(src.currentTask.title),
            kind: asString(src.currentTask.kind),
            role: asString(src.currentTask.role),
            since: asTimestamp(src.currentTask.since),
            owner: asString(src.currentTask.owner),
            taskScope: asString(src.currentTask.taskScope),
            claimState: asString(src.currentTask.claimState)
          }
        : null
      return {
        id: asString(src.id),
        contactId: asString(src.contactId) || contactIdOf(src.id),
        title: asString(src.title) || '（未命名会话）',
        cwd: asString(src.cwd),
        live: src.live === true,
        status: status,
        availability: src.availability === 'busy' ? 'busy' : 'idle',
        currentTask: currentTask,
        openRequestCount: asNumber(src.openRequestCount, 0),
        lastSubmittedAt: asTimestamp(src.lastSubmittedAt),
        createdAt: asTimestamp(src.createdAt),
        hasProfile: src.hasProfile === true,
        profileDeclined: src.profileDeclined === true,
        internal: src.internal === true,
        handle: asString(src.handle),
        avatar: asString(src.avatar)
      }
    }

    function normalizeDeliveries(raw) {
      var out = {}
      if (!isPlainObject(raw)) return out
      Object.keys(raw).forEach(function (ruleId) {
        var list = asArray(raw[ruleId])
          .map(function (item) {
            var src = isPlainObject(item) ? item : {}
            var acceptedAt = asTimestamp(src.acceptedAt)
            return {
              sessionId: asString(src.sessionId),
              title: asString(src.title),
              deliveredAt: asTimestamp(src.deliveredAt),
              acceptedAt: acceptedAt > 0 ? acceptedAt : null
            }
          })
          .filter(function (item) {
            return item.sessionId !== ''
          })
        out[ruleId] = list
      })
      return out
    }

    // ---------------------------------------------------------------- 4.0 指挥中心数据（防御性归一化）
    /**
     * 收件箱条目：宿主 4.0 state.inbox.items 的降级形态。
     * 正式契约见 docs/API-V4.md §2.5（id=<kind>:<业务id>、target、actions、unread…），
     * 旧宿主可能只有 id/kind/priority/ts/title/detail/groupId/action；缺失字段一律给默认值。
     */
    function normalizeInboxItem(raw) {
      var src = isPlainObject(raw) ? raw : {}
      var target = isPlainObject(src.target) ? src.target : {}
      return {
        id: asString(src.id),
        kind: asString(src.kind, 'notice'),
        category: asString(src.category),
        priority: asNumber(src.priority, 0),
        ts: asTimestamp(src.ts),
        title: asString(src.title),
        detail: asString(src.detail),
        groupId: asString(src.groupId || target.groupId),
        groupName: asString(src.groupName),
        action: asString(src.action),
        taskId: asString(src.taskId || target.taskId),
        sessionId: asString(src.sessionId || target.sessionId || src.author),
        approvalId: asString(src.approvalId || target.approvalId),
        requestId: asString(src.requestId),
        target: {
          view: asString(target.view),
          groupId: asString(target.groupId),
          taskId: asString(target.taskId),
          approvalId: asString(target.approvalId),
          sessionId: asString(target.sessionId)
        },
        unread: src.unread === true,
        read: src.unread !== true,
        createdAt: asTimestamp(src.createdAt),
        expiresAt: asTimestamp(src.expiresAt)
      }
    }

    /** state.inbox：{items, attention, total, attentionCount, unreadCount, generatedAt}。 */
    function normalizeInbox(raw) {
      var src = isPlainObject(raw) ? raw : {}
      var items = asArray(src.items)
        .filter(isPlainObject)
        .map(normalizeInboxItem)
        .filter(function (item) {
          return item.id !== '' || item.title !== ''
        })
      var attention = asArray(src.attention)
        .filter(isPlainObject)
        .map(normalizeInboxItem)
        .filter(function (item) {
          return item.id !== '' || item.title !== ''
        })
      var total = asNumber(src.total, items.length)
      var attentionCount = asNumber(src.attentionCount, attention.length || items.filter(function (item) { return item.priority >= 75 }).length)
      var unreadCount = asNumber(src.unreadCount, items.filter(function (item) { return item.unread === true }).length)
      return {
        items: items,
        attention: attention,
        total: Math.max(0, total),
        attentionCount: Math.max(0, attentionCount),
        unreadCount: Math.max(0, unreadCount),
        generatedAt: asTimestamp(src.generatedAt)
      }
    }

    /** 小议会（state.council：members 是会话 id 数组）。 */
    function normalizeCouncil(raw) {
      var src = isPlainObject(raw) ? raw : {}
      return {
        version: asNumber(src.version, 1),
        groupId: asString(src.groupId),
        chair: asString(src.chair),
        members: asArray(src.members)
          .map(function (item) { return asString(item) })
          .filter(function (item) { return item !== '' }),
        createdAt: asTimestamp(src.createdAt),
        updatedAt: asTimestamp(src.updatedAt)
      }
    }

    /** computer-use 桌面租约（state.computerResource，见 docs/API-V4.md §2.7）。 */
    function normalizeComputerResource(raw) {
      var src = isPlainObject(raw) ? raw : {}
      var lease = isPlainObject(src.lease) ? src.lease : null
      var available = src.available === true
      var priorityRaw = src.priority
      var priority = isPlainObject(priorityRaw)
        ? {
            current: asNumber(priorityRaw.current, 0),
            office: asString(priorityRaw.office),
            officeLevel: asNumber(priorityRaw.officeLevel, 0),
            points: asNumber(priorityRaw.points, 0),
            scale: asString(priorityRaw.scale)
          }
        : {
            current: asNumber(priorityRaw, 0),
            office: asString(src.office),
            officeLevel: 0,
            points: 0,
            scale: ''
          }
      return {
        schemaVersion: asString(src.schemaVersion),
        ok: src.ok !== false,
        available: available,
        resourceId: asString(src.resourceId, 'desktop'),
        label: asString(src.label),
        priority: priority,
        office: priority.office,
        queue: asArray(src.queue),
        degraded: src.degraded === true,
        degradedReason: asString(src.degradedReason),
        observedAt: asTimestamp(src.observedAt),
        lease: available && lease
          ? {
              owner: asString(lease.owner),
              ownerName: asString(lease.ownerName),
              label: asString(lease.label),
              acquiredAt: asTimestamp(lease.acquiredAt),
              expiresAt: asTimestamp(lease.expiresAt),
              ttlMs: asNumber(lease.ttlMs, 0),
              heldByMe: lease.heldByMe === true
            }
          : null
      }
    }

    /** commandCenter：4.0 控制面摘要（正式契约见 docs/API-V4.md §2.6）。 */
    function normalizeCommandCenter(raw) {
      var src = isPlainObject(raw) ? raw : {}
      var council = isPlainObject(src.council) ? src.council : {}
      var computer = isPlainObject(src.computer) ? src.computer : {}
      var membersRaw = council.members
      return {
        schemaVersion: asString(src.schemaVersion, ''),
        attentionCount: asNumber(src.attentionCount, 0),
        inboxCount: asNumber(src.inboxCount, 0),
        unreadCount: asNumber(src.unreadCount, 0),
        activeTasks: asNumber(src.activeTasks, 0),
        stalledTasks: asNumber(src.stalledTasks, 0),
        pausedTasks: asNumber(src.pausedTasks, 0),
        approvalTimeoutCount: asNumber(src.approvalTimeoutCount, 0),
        council: {
          members: Array.isArray(membersRaw) ? membersRaw.length : asNumber(membersRaw, 0),
          chair: asString(council.chair),
          pendingApprovals: asNumber(council.pendingApprovals, 0)
        },
        computer: {
          available: computer.available === true,
          owner: asString(computer.owner),
          ttlMs: asNumber(computer.ttlMs, 0),
          degraded: computer.degraded === true
        }
      }
    }

    /** 待复核/待议会审批记录。 */
    function normalizeApproval(raw) {
      var src = isPlainObject(raw) ? raw : {}
      return {
        id: asString(src.id),
        title: asString(src.title),
        text: asString(src.text),
        reason: asString(src.reason),
        status: asString(src.status, 'pending'),
        source: asString(src.source),
        groupId: asString(src.groupId),
        createdAt: asTimestamp(src.createdAt)
      }
    }

    /** 任务线统计（卡住数等）：优先用宿主给的任务线，缺失时从 taskLineStats 兜底。 */
    function normalizeTaskLineStats(rawStats, rawLines) {
      var src = isPlainObject(rawStats) ? rawStats : {}
      var lines = asArray(rawLines).filter(isPlainObject)
      var countStatus = function (status) {
        return lines.filter(function (line) { return asString(line.lineStatus) === status }).length
      }
      return {
        total: asNumber(src.total, lines.length),
        waiting: asNumber(src.waiting, countStatus('waiting')),
        active: asNumber(src.active, countStatus('active')),
        stalled: asNumber(src.stalled, countStatus('stalled')),
        paused: asNumber(src.paused, countStatus('paused')),
        done: asNumber(src.done, countStatus('done')),
        canceled: asNumber(src.canceled, countStatus('canceled')),
        nudged: asNumber(src.nudged, 0)
      }
    }

    /** 把任意响应体收敛成面板可安全消费的形状；缺失字段一律补默认值。 */
    function normalizeState(raw) {
      var src = isPlainObject(raw) ? raw : {}
      var rules = asArray(src.rules)
        .filter(isPlainObject)
        .map(normalizeRule)
        .filter(function (rule) {
          return rule.id !== ''
        })
      var groups = asArray(src.groups)
        .filter(isPlainObject)
        .map(normalizeGroup)
        .filter(function (group) {
          return group.id !== ''
        })
      var sessions = asArray(src.sessions)
        .filter(isPlainObject)
        .map(normalizeSession)
        .filter(function (session) {
          return session.id !== ''
        })
      var rawStats = isPlainObject(src.stats) ? src.stats : {}
      var profiles = {}
      if (isPlainObject(src.profiles)) {
        Object.keys(src.profiles).forEach(function (sessionId) {
          var rawProfile = isPlainObject(src.profiles[sessionId]) ? src.profiles[sessionId] : {}
          var realId = asString(rawProfile.sessionId) || sessionId
          profiles[realId] = {
            sessionId: realId,
            summary: asString(rawProfile.summary),
            direction: asString(rawProfile.direction),
            assets: asArray(rawProfile.assets)
              .map(function (item) {
                return asString(item)
              })
              .filter(function (item) {
                return item !== ''
              }),
            needs: asString(rawProfile.needs),
            declined: rawProfile.declined === true,
            updatedAt: asTimestamp(rawProfile.updatedAt)
          }
        })
      }
      var world = asArray(src.world)
        .filter(isPlainObject)
        .map(normalizeRule)
        .filter(function (rule) {
          return rule.id !== ''
        })
      // v2.10.1：重复任务合并建议（只提示，不自动删数据）。
      var duplicates = asArray(src.duplicates)
        .filter(isPlainObject)
        .map(function (item) {
          var primary = isPlainObject(item.primary) ? item.primary : {}
          return {
            primary: {
              id: asString(primary.id),
              title: asString(primary.title),
              owner: asString(primary.owner),
              taskScope: asString(primary.taskScope),
              groupId: asString(primary.groupId),
              taskStatus: asString(primary.taskStatus),
              ts: asTimestamp(primary.ts)
            },
            duplicates: asArray(item.duplicates)
              .filter(isPlainObject)
              .map(function (dup) {
                return {
                  id: asString(dup.id),
                  title: asString(dup.title),
                  owner: asString(dup.owner),
                  taskScope: asString(dup.taskScope),
                  reason: asString(dup.reason)
                }
              })
              .filter(function (dup) {
                return dup.id !== ''
              })
          }
        })
        .filter(function (group) {
          return group.primary.id !== '' && group.duplicates.length > 0
        })
      var permissions = {}
      if (isPlainObject(src.permissions)) {
        Object.keys(src.permissions).forEach(function (sessionId) {
          permissions[sessionId] = asArray(src.permissions[sessionId])
            .map(function (item) {
              return asString(item)
            })
            .filter(function (item) {
              return item !== ''
            })
        })
      }
      var reputation = asArray(src.reputation)
        .filter(isPlainObject)
        .map(function (item) {
          return {
            sessionId: asString(item.sessionId),
            title: asString(item.title),
            points: asNumber(item.points, 0),
            successes: asNumber(item.successes, 0),
            failures: asNumber(item.failures, 0),
            closed: item.closed === true
          }
        })
        .filter(function (item) {
          return item.sessionId !== ''
        })
      var config = {}
      if (isPlainObject(src.config)) {
        config = {
          provider: asString(src.config.provider),
          model: asString(src.config.model),
          injectMode: asString(src.config.injectMode),
          autoPrompt: src.config.autoPrompt !== false,
          autoCapture: src.config.autoCapture !== false,
          askOnCreate: src.config.askOnCreate !== false,
          instructions: src.config.instructions !== false,
          scope: asString(src.config.scope),
          maxShown: asNumber(src.config.maxShown, 8),
          maxChars: asNumber(src.config.maxChars, 460),
          maxStored: asNumber(src.config.maxStored, 80),
          boardDir: asString(src.config.boardDir)
        }
      }
      var inbox = normalizeInbox(src.inbox)
      var council = normalizeCouncil(
        isPlainObject(src.council) ? src.council : isPlainObject(src.commandCenter) ? src.commandCenter.council : null
      )
      var computerResource = normalizeComputerResource(
        isPlainObject(src.computerResource) ? src.computerResource : isPlainObject(src.commandCenter) ? src.commandCenter.computer : null
      )
      var approvals = asArray(src.approvals)
        .filter(isPlainObject)
        .map(normalizeApproval)
        .filter(function (item) {
          return item.id !== ''
        })
      var taskLineStats = normalizeTaskLineStats(src.taskLineStats, src.taskLines)
      var taskFlows = isPlainObject(src.taskFlows) ? src.taskFlows : {}
      var commandCenter = normalizeCommandCenter(src.commandCenter)
      // 老宿主没有 commandCenter 时，用 inbox / approvals / taskLineStats 派生同一份摘要。
      if (!commandCenter.schemaVersion) commandCenter.schemaVersion = asString(src.schemaVersion)
      if (!commandCenter.attentionCount) commandCenter.attentionCount = inbox.attentionCount
      if (!commandCenter.inboxCount) commandCenter.inboxCount = inbox.total
      if (!commandCenter.unreadCount) commandCenter.unreadCount = inbox.unreadCount
      if (!commandCenter.council.pendingApprovals) {
        commandCenter.council.pendingApprovals = approvals.filter(function (item) { return item.status === 'pending' }).length
      }
      if (!commandCenter.council.members) commandCenter.council.members = council.members.length
      if (!commandCenter.council.chair) commandCenter.council.chair = council.chair
      if (!commandCenter.stalledTasks) commandCenter.stalledTasks = taskLineStats.stalled
      if (!commandCenter.pausedTasks) commandCenter.pausedTasks = taskLineStats.paused
      if (!commandCenter.computer.available) {
        commandCenter.computer.available = computerResource.available
        commandCenter.computer.owner = computerResource.lease ? computerResource.lease.owner : ''
        commandCenter.computer.ttlMs = computerResource.lease ? computerResource.lease.ttlMs : 0
        commandCenter.computer.degraded = computerResource.degraded
      }
      return {
        ok: src.ok !== false,
        version: asString(src.version),
        schemaVersion: asString(src.schemaVersion),
        config: config,
        reputation: reputation,
        rules: rules,
        world: world,
        duplicates: duplicates,
        permissions: permissions,
        groups: groups,
        sessions: sessions,
        profiles: profiles,
        deliveries: normalizeDeliveries(src.deliveries),
        inbox: inbox,
        commandCenter: commandCenter,
        council: council,
        computerResource: computerResource,
        taskFlows: taskFlows,
        taskLineStats: taskLineStats,
        approvals: approvals,
        stats: {
          rules: asNumber(rawStats.rules, rules.length),
          groups: asNumber(rawStats.groups, groups.length),
          sessions: asNumber(rawStats.sessions, sessions.length),
          profiles: asNumber(rawStats.profiles, Object.keys(profiles).length)
        }
      }
    }

    /** 从状态里派生渲染用的索引；任何字段缺失都退化为空表。 */
    function buildIndexes(state) {
      var out = {
        groupById: {},
        sessionById: {},
        rulesByGroup: {},
        groupsBySession: {},
        profilesBySession: {},
        permissionsBySession: {},
        rules: [],
        world: [],
        groups: [],
        sessions: []
      }
      if (!isPlainObject(state)) return out
      out.rules = asArray(state.rules)
      out.world = asArray(state.world)
      out.groups = asArray(state.groups)
      out.sessions = asArray(state.sessions)
      if (isPlainObject(state.permissions)) {
        Object.keys(state.permissions).forEach(function (sessionId) {
          out.permissionsBySession[sessionId] = asArray(state.permissions[sessionId])
        })
      }
      if (isPlainObject(state.profiles)) {
        Object.keys(state.profiles).forEach(function (sessionId) {
          out.profilesBySession[sessionId] = state.profiles[sessionId]
        })
      }
      out.groups.forEach(function (group) {
        out.groupById[group.id] = group
        asArray(group.sessionIds).forEach(function (sessionId) {
          if (!out.groupsBySession[sessionId]) out.groupsBySession[sessionId] = []
          out.groupsBySession[sessionId].push(group)
        })
      })
      out.sessions.forEach(function (session) {
        out.sessionById[session.id] = session
      })
      out.rules.forEach(function (rule) {
        if (!rule.groupId) return
        if (!out.rulesByGroup[rule.groupId]) out.rulesByGroup[rule.groupId] = []
        out.rulesByGroup[rule.groupId].push(rule)
      })
      return out
    }

    var EMPTY_INDEX = buildIndexes(null)
    //#endregion

    //#region 同源 HTTP 访问
    function fetchJson(url, init) {
      if (typeof fetch !== 'function') {
        return Promise.reject(new Error('当前环境不支持 fetch'))
      }
      var options = Object.assign({ credentials: 'same-origin', cache: 'no-store' }, init || {})
      return fetch(url, options).then(function (response) {
        return response.text().then(function (text) {
          var payload = null
          if (text) {
            try {
              payload = JSON.parse(text)
            } catch (e) {
              payload = null
            }
          }
          if (!response.ok) {
            var message =
              isPlainObject(payload) && typeof payload.error === 'string' && payload.error !== ''
                ? payload.error
                : 'HTTP ' + response.status
            throw new Error(message)
          }
          if (!isPlainObject(payload)) throw new Error('响应不是合法的 JSON 对象')
          return payload
        })
      })
    }

    /** GET 一次看板状态。 */
    function loadState() {
      return fetchJson(STATE_URL, {
        method: 'GET',
        headers: { accept: 'application/json' }
      }).then(function (payload) {
        if (payload.ok !== true) {
          throw new Error(typeof payload.error === 'string' && payload.error ? payload.error : '状态加载失败')
        }
        return normalizeState(payload)
      })
    }

    /** 构造命令请求（纯函数，便于自检）；所有写操作都必须带动作校验头。 */
    function buildCommandRequest(action, payload) {
      return {
        url: COMMAND_URL,
        init: {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            'content-type': 'application/json',
            'x-session-bridge-action': '1'
          },
          body: JSON.stringify({
            action: asString(action),
            payload: isPlainObject(payload) ? payload : {}
          })
        }
      }
    }

    /**
     * 发一条看板命令。
     * 成功时返回归一化后的最新 state；宿主没回 state 时返回 null（调用方补一次 GET）。
     */
    function sendCommand(action, payload) {
      var request = buildCommandRequest(action, payload)
      return fetchJson(request.url, request.init).then(function (result) {
        if (result.ok !== true) {
          throw new Error(typeof result.error === 'string' && result.error ? result.error : '命令执行失败')
        }
        if (isPlainObject(result.state)) return normalizeState(result.state)
        return null
      })
    }

    /** 世界发布任务需要原始响应（assigned / createdSession），不走 state 归一化。 */
    function postCommandRaw(action, payload) {
      var request = buildCommandRequest(action, payload)
      return fetchJson(request.url, request.init).then(function (result) {
        if (result.ok !== true) {
          throw new Error(typeof result.error === 'string' && result.error ? result.error : '命令执行失败')
        }
        return result
      })
    }

    /** 让宿主按「共同特征」分析既有主会话，返回可一键创建群组的建议。 */
    function fetchSuggestions() {
      var request = buildCommandRequest('group.suggest', {})
      return fetchJson(request.url, request.init).then(function (result) {
        if (result.ok !== true) {
          throw new Error(typeof result.error === 'string' && result.error ? result.error : '智能成组失败')
        }
        return Array.isArray(result.suggestions) ? result.suggestions : []
      })
    }
    //#endregion

    //#region 样式（内联 + CSS 变量，适配浅色/深色）
    function mergeStyle() {
      var out = {}
      for (var i = 0; i < arguments.length; i += 1) {
        var part = arguments[i]
        if (!isPlainObject(part)) continue
        for (var key in part) {
          if (Object.prototype.hasOwnProperty.call(part, key)) out[key] = part[key]
        }
      }
      return out
    }

    var styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        width: '100%',
        boxSizing: 'border-box',
        fontSize: 12,
        lineHeight: 1.45,
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: FONT_STACK,
        background: 'transparent',
        overflow: 'hidden'
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flex: 'none',
        padding: '8px 10px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l3)'
      },
      headerTitle: {
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
        whiteSpace: 'nowrap',
        flex: 'none'
      },
      headerMeta: {
        flex: 1,
        minWidth: 0,
        fontSize: 11,
        color: 'var(--dsw-alias-label-tertiary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      },
      headerButtons: { display: 'flex', alignItems: 'center', gap: 6, flex: 'none' },
      banner: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 6,
        flex: 'none',
        padding: '6px 10px',
        fontSize: 11.5,
        color: 'var(--dsw-alias-state-error-primary)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
        borderBottom:
          '0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent)'
      },
      bannerText: { flex: 1, minWidth: 0, wordBreak: 'break-word' },
      bannerClose: {
        flex: 'none',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 13,
        lineHeight: 1,
        padding: '0 2px',
        cursor: 'pointer',
        fontFamily: 'inherit'
      },
      tabBar: {
        display: 'flex',
        gap: 4,
        flex: 'none',
        padding: '6px 10px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l3)'
      },
      tabButton: {
        flex: 1,
        minWidth: 0,
        padding: '4px 6px',
        borderRadius: 6,
        border: '0.5px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
        lineHeight: 1.3,
        cursor: 'pointer',
        fontFamily: 'inherit',
        textAlign: 'center',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      },
      tabButtonActive: {
        background: 'var(--dsw-alias-bg-layer-2)',
        borderColor: 'var(--dsw-alias-border-l3)',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 600
      },
      content: {
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '8px 10px 14px'
      },
      footerBar: {
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '4px 10px',
        fontSize: 10.5,
        color: 'var(--dsw-alias-label-tertiary)',
        borderTop: '0.5px solid var(--dsw-alias-border-l3)'
      },
      card: {
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '8px 9px',
        marginBottom: 8
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      cardTitle: {
        fontSize: 12.5,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
        margin: '4px 0 2px',
        wordBreak: 'break-word'
      },
      cardText: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        margin: '4px 0 0'
      },
      clamp3: {
        display: '-webkit-box',
        WebkitLineClamp: '3',
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden'
      },
      metaRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        marginTop: 5,
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 10.5
      },
      actionsRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        marginTop: 8
      },
      spacer: { flex: 1, minWidth: 0 },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        flex: 'none',
        maxWidth: '100%',
        height: 18,
        padding: '0 6px',
        borderRadius: 9,
        border: '0.5px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 10.5,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      },
      tag: {
        display: 'inline-flex',
        alignItems: 'center',
        flex: 'none',
        padding: '0 6px',
        height: 18,
        borderRadius: 9,
        border: '0.5px solid var(--dsw-alias-border-l3)',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 10.5,
        lineHeight: 1,
        whiteSpace: 'nowrap'
      },
      btn: {
        padding: '3px 8px',
        borderRadius: 6,
        border: '0.5px solid var(--dsw-alias-border-l4)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 11.5,
        lineHeight: 1.3,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap'
      },
      btnPrimary: {
        padding: '3px 9px',
        borderRadius: 6,
        border: '0.5px solid var(--dsw-alias-state-business-primary)',
        background: 'var(--dsw-alias-state-business-primary)',
        color: 'var(--dsw-alias-label-primary-foreground)',
        fontSize: 11.5,
        lineHeight: 1.3,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap'
      },
      btnDanger: {
        padding: '3px 8px',
        borderRadius: 6,
        border:
          '0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 11.5,
        lineHeight: 1.3,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap'
      },
      btnGhost: {
        padding: '2px 4px',
        borderRadius: 6,
        border: '0.5px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-state-business-primary)',
        fontSize: 11,
        lineHeight: 1.3,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap'
      },
      btnDisabled: { opacity: 0.45, cursor: 'default' },
      linkButton: {
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-state-business-primary)',
        fontSize: 11,
        lineHeight: 1.3,
        padding: 0,
        cursor: 'pointer',
        fontFamily: 'inherit'
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '4px 6px',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: 12,
        lineHeight: 1.4,
        outline: 'none'
      },
      textarea: { resize: 'vertical', minHeight: 54 },
      select: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '3px 4px',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: 11.5,
        lineHeight: 1.4,
        outline: 'none'
      },
      selectSmall: { maxWidth: 170 },
      fieldLabel: {
        display: 'block',
        fontSize: 10.5,
        color: 'var(--dsw-alias-label-tertiary)',
        margin: '6px 0 3px'
      },
      form: {
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '8px 9px',
        marginBottom: 8
      },
      formTitle: { fontSize: 12, fontWeight: 600, marginBottom: 2 },
      formHint: { fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary)', marginTop: 4 },
      empty: {
        padding: '16px 8px',
        textAlign: 'center',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 12
      },
      pickerBox: {
        maxHeight: 150,
        overflowY: 'auto',
        overflowX: 'hidden',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-base)',
        padding: '2px 6px',
        marginTop: 4
      },
      checkRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 0',
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer'
      },
      checkLabel: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      },
      sessionRow: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '6px 8px',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 7,
        background: 'var(--dsw-alias-bg-layer-1)',
        marginBottom: 6
      },
      rowLine: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
      rowTitle: {
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0
      },
      rowMuted: {
        fontSize: 11,
        color: 'var(--dsw-alias-label-tertiary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0
      },
      divider: { height: 1, background: 'var(--dsw-alias-border-l2)', margin: '6px 0' },
      groupMemberRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 0',
        borderTop: '0.5px solid var(--dsw-alias-border-l2)'
      },
      deliveryRow: { marginTop: 8 },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        maxWidth: '100%',
        padding: '2px 7px',
        borderRadius: 999,
        border: '0.5px solid var(--dsw-alias-border-l4)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 10.5,
        lineHeight: 1.3,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      },
      chipAccepted: {
        background:
          'color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)',
        border:
          '0.5px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent)',
        color: 'var(--dsw-alias-state-success-primary)'
      },
      dot: {
        width: 6,
        height: 6,
        borderRadius: 999,
        flex: 'none',
        background: 'var(--dsw-alias-label-tertiary)'
      },
      dotLive: { background: 'var(--dsw-alias-state-success-primary)' },
      dotIdle: { background: 'var(--dsw-alias-label-tertiary)' },
      dotRunning: { background: 'var(--dsw-alias-state-business-primary)' },
      boundary: {
        padding: 12,
        fontFamily: FONT_STACK,
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        background: 'transparent',
        height: '100%',
        boxSizing: 'border-box',
        overflowY: 'auto'
      },
      boundaryTitle: {
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--dsw-alias-state-error-primary)',
        marginBottom: 6
      },
      boundaryMsg: {
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        marginBottom: 10
      },
      // ---- 4.0 指挥中心（右侧栏常驻摘要 · 默认折叠，低打扰） ----
      commandStrip: {
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '7px 10px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
        background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, transparent)'
      },
      commandRow: { display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
      commandTitle: {
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
        flex: 'none',
        marginRight: 1
      },
      commandSpacer: { flex: 1, minWidth: 4 },
      statChip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: '1px 7px',
        borderRadius: 999,
        border: '0.5px solid var(--dsw-alias-border-l3)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 10.5,
        lineHeight: 1.5,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap'
      },
      statChipAlert: {
        borderColor: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)'
      },
      statNum: { fontWeight: 700, color: 'var(--dsw-alias-label-primary)' },
      statNumAlert: { color: 'var(--dsw-alias-state-warn-primary)' },
      cmdInboxList: {
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        marginTop: 1
      },
      cmdInboxRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        padding: '3px 5px',
        border: '0.5px solid transparent',
        borderRadius: 6,
        background: 'transparent',
        color: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit'
      },
      cmdInboxKind: { flex: 'none', width: 15, textAlign: 'center', fontSize: 11, lineHeight: 1.4 },
      cmdInboxTitle: {
        flex: 1,
        minWidth: 0,
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-primary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      },
      cmdInboxTime: { flex: 'none', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' },
      cmdEmpty: { fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary)', padding: '2px 4px' },
      // ---- 4.1 无感入口（header chip / composer dock / 注意力气泡） ----
      ambientChipWrap: { position: 'relative', display: 'inline-flex', alignItems: 'center', minWidth: 0 },
      ambientChip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        maxWidth: 178,
        minWidth: 0,
        padding: '1px 6px',
        borderRadius: 6,
        border: '0.5px solid var(--dsw-alias-border-l3)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: FONT_STACK,
        fontSize: 10.5,
        lineHeight: 1.5,
        cursor: 'pointer',
        transition: 'none'
      },
      ambientChipOpen: { background: 'var(--dsw-alias-bg-layer-2)' },
      ambientChipPulse: {},
      ambientChipText: {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      },
      ambientChipBadge: {
        flex: 'none',
        minWidth: 15,
        height: 15,
        padding: '0 4px',
        borderRadius: 999,
        background: 'var(--dsw-alias-state-warn-primary)',
        color: 'var(--dsw-alias-bg-layer-1)',
        fontSize: 9.5,
        fontWeight: 700,
        lineHeight: '15px',
        textAlign: 'center'
      },
      ambientPopover: {
        position: 'fixed',
        zIndex: 9999,
        width: 300,
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: '70vh',
        overflowY: 'auto',
        padding: '8px 9px 7px',
        borderRadius: 10,
        border: '0.5px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: '0 16px 42px rgba(0,0,0,.32)',
        fontFamily: FONT_STACK,
        fontSize: 12,
        boxSizing: 'border-box'
      },
      ambientDock: {
        width: '100%',
        boxSizing: 'border-box',
        borderRadius: 10,
        border: '0.5px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent)',
        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, transparent)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: FONT_STACK,
        fontSize: 11.5,
        overflow: 'hidden',
        margin: '4px 0'
      },
      ambientDockRow: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
      ambientDockMain: {
        flex: 1,
        minWidth: 0,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 9px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        fontFamily: 'inherit',
        fontSize: 11.5,
        textAlign: 'left',
        cursor: 'pointer'
      },
      ambientDockBadge: { flex: 'none', fontSize: 12 },
      ambientDockText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      ambientDockAction: {
        flex: 'none',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)',
        fontFamily: 'inherit',
        fontSize: 11,
        padding: '4px 6px',
        borderRadius: 6,
        cursor: 'pointer'
      },
      ambientPanel: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
      ambientPanelHead: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      ambientPanelTitle: { fontSize: 12.5, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      ambientPanelMuted: { fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary)', fontWeight: 400 },
      ambientPanelClose: {
        marginLeft: 'auto',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)',
        fontFamily: 'inherit',
        fontSize: 13,
        lineHeight: 1,
        padding: '0 2px',
        cursor: 'pointer'
      },
      ambientSection: {
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        padding: '7px 8px',
        borderRadius: 8,
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)'
      },
      ambientSectionHead: { fontSize: 11.5, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      ambientTaskTitle: { fontSize: 12, color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-word' },
      ambientMetaRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)' },
      ambientProgressTrack: { height: 5, borderRadius: 999, background: 'var(--dsw-alias-border-l2)', overflow: 'hidden' },
      ambientProgressBar: { height: '100%', borderRadius: 999, background: 'var(--dsw-alias-brand-primary)' },
      ambientSteps: { display: 'flex', flexDirection: 'column', gap: 2 },
      ambientStep: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)' },
      ambientStepActive: { color: 'var(--dsw-alias-brand-primary)', fontWeight: 600 },
      ambientFlows: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 },
      ambientFlowLine: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis' },
      ambientFlowTime: { marginRight: 5, color: 'var(--dsw-alias-label-tertiary)' },
      ambientItem: {
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        padding: '5px 6px',
        borderRadius: 6,
        background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-1) 70%, transparent)'
      },
      ambientItemHead: { display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between', fontSize: 11.5, color: 'var(--dsw-alias-label-primary)', minWidth: 0 },
      ambientItemDetail: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-word' },
      ambientTemplate: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' },
      ambientBtnRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      ambientBtn: {
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: 10.5,
        lineHeight: 1.4,
        padding: '2px 8px',
        cursor: 'pointer',
        whiteSpace: 'nowrap'
      },
      ambientBtnPrimary: {
        border: '0.5px solid transparent',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-layer-1)',
        fontWeight: 600
      },
      ambientPanelFoot: { display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 2 },
      ambientPanelNotice: {
        fontSize: 10.5,
        color: 'var(--dsw-alias-state-success-primary)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
        borderRadius: 6,
        padding: '3px 6px'
      },
      ambientPanelError: {
        fontSize: 10.5,
        color: 'var(--dsw-alias-state-error-primary)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
        borderRadius: 6,
        padding: '3px 6px'
      }
    }
    //#endregion

    //#region 通用小组件
    function Btn(props) {
      var variant = props.variant
      var base =
        variant === 'primary'
          ? styles.btnPrimary
          : variant === 'danger'
            ? styles.btnDanger
            : variant === 'ghost'
              ? styles.btnGhost
              : styles.btn
      var style = mergeStyle(base, props.style)
      if (props.disabled === true) style = mergeStyle(style, styles.btnDisabled)
      return h(
        'button',
        {
          type: 'button',
          disabled: props.disabled === true,
          title: props.title === undefined ? undefined : String(props.title),
          'aria-label': props.ariaLabel === undefined ? undefined : String(props.ariaLabel),
          onClick: props.disabled === true ? undefined : props.onClick,
          style: style
        },
        props.children
      )
    }

    function RawInput(props) {
      var style = mergeStyle(styles.input, props.multiline === true ? styles.textarea : null, props.style)
      if (props.multiline === true) {
        return h('textarea', {
          value: props.value,
          placeholder: props.placeholder || '',
          rows: props.rows || 3,
          disabled: props.disabled === true,
          onChange: props.onChange,
          onKeyDown: props.onKeyDown,
          spellCheck: false,
          style: style
        })
      }
      return h('input', {
        type: props.type || 'text',
        value: props.value,
        placeholder: props.placeholder || '',
        disabled: props.disabled === true,
        onChange: props.onChange,
        onKeyDown: props.onKeyDown,
        spellCheck: false,
        style: style
      })
    }

    function RawSelect(props) {
      var style = mergeStyle(styles.select, props.small === true ? styles.selectSmall : null, props.style)
      return h(
        'select',
        {
          value: props.value,
          disabled: props.disabled === true,
          onChange: props.onChange,
          title: props.title === undefined ? undefined : String(props.title),
          'aria-label': props.ariaLabel === undefined ? undefined : String(props.ariaLabel),
          style: style
        },
        asArray(props.options).map(function (option) {
          return h('option', { key: String(option.value), value: option.value }, option.label)
        })
      )
    }

    function Badge(props) {
      var toneColor = props.tone ? TONE_COLORS[props.tone] : null
      var style = mergeStyle(
        styles.badge,
        toneColor
          ? {
              background:
                'color-mix(in srgb, ' + toneColor + ' 12%, transparent)',
              border:
                '0.5px solid color-mix(in srgb, ' + toneColor + ' 30%, transparent)',
              color: toneColor
            }
          : null,
        props.style
      )
      return h(
        'span',
        {
          style: style,
          title: props.title === undefined ? undefined : String(props.title)
        },
        props.children
      )
    }

    function EmptyHint(props) {
      return h('div', { style: mergeStyle(styles.empty, props.style) }, props.children)
    }

    function FieldLabel(props) {
      return h('span', { style: styles.fieldLabel }, props.children)
    }

    function ErrorBanner(props) {
      if (!props.message) return null
      return h(
        'div',
        { style: styles.banner, role: 'alert' },
        h('span', { style: styles.bannerText }, props.message),
        props.onDismiss
          ? h(
              'button',
              {
                type: 'button',
                style: styles.bannerClose,
                title: '关闭错误提示',
                'aria-label': '关闭错误提示',
                onClick: props.onDismiss
              },
              '×'
            )
          : null
      )
    }

    function SessionPicker(props) {
      var sessions = asArray(props.sessions).filter(function (session) {
        return session.internal !== true
      })
      var selected = asArray(props.selectedIds)
      if (sessions.length === 0) {
        return h(EmptyHint, { style: { padding: '8px 4px' } }, props.emptyText || '暂无可选会话')
      }
      return h(
        'div',
        { style: mergeStyle(styles.pickerBox, props.style) },
        sessions.map(function (session) {
          var checked = selected.indexOf(session.id) >= 0
          var label = session.title + '（' + (session.contactId || contactIdOf(session.id)) + '）'
          return h(
            'label',
            { key: 'pick-' + session.id, style: styles.checkRow, title: session.cwd || session.id },
            h('input', {
              type: 'checkbox',
              checked: checked,
              onChange: function () {
                var next = selected.slice()
                var at = next.indexOf(session.id)
                if (at >= 0) next.splice(at, 1)
                else next.push(session.id)
                if (typeof props.onChange === 'function') props.onChange(next)
              }
            }),
            h('span', { style: styles.checkLabel }, label),
            h(
              'span',
              { style: mergeStyle(styles.rowMuted, { flex: 'none' }) },
              cwdTail(session.cwd)
            )
          )
        })
      )
    }
    //#endregion

    //#region ErrorBoundary：渲染异常时只坏这一块，不白屏
    class PanelErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
        this.reset = this.reset.bind(this)
      }

      static getDerivedStateFromError(error) {
        return { error: error || new Error('未知渲染错误') }
      }

      componentDidCatch(error, info) {
        try {
          console.error('[session-bridge] 看板渲染异常：', error, info)
        } catch (e) {
          // 日志失败不影响降级界面。
        }
      }

      reset() {
        this.setState({ error: null })
      }

      render() {
        var error = this.state ? this.state.error : null
        if (error) {
          return h(
            'div',
            { style: styles.boundary },
            h('div', { style: styles.boundaryTitle }, '经验桥面板渲染出错'),
            h('div', { style: styles.boundaryMsg }, errorMessage(error)),
            h(Btn, { variant: 'primary', onClick: this.reset }, '重试')
          )
        }
        return this.props && this.props.children ? this.props.children : null
      }
    }
    //#endregion

    //#region 规矩页
    function scopeBadgeText(rule, index) {
      if (rule.groupId) {
        var group = index.groupById[rule.groupId]
        if (group && group.name) return group.name
        if (rule.groupName) return rule.groupName
        return '群组'
      }
      return rule.scope === 'global' ? '全局' : '工作区'
    }

    function scopeBadgeTone(rule) {
      if (rule.groupId) return 'brand'
      return rule.scope === 'global' ? 'business' : 'neutral'
    }

    function DeliveryChips(props) {
      var rule = props.rule
      var deliveries = asArray(props.deliveries)
      if (deliveries.length === 0) {
        return h('div', { style: styles.deliveryRow }, h('span', { style: styles.rowMuted }, '尚未送达任何会话'))
      }
      return h(
        'div',
        { style: styles.deliveryRow },
        h(
          'div',
          { style: mergeStyle(styles.rowMuted, { marginBottom: 4 }) },
          '已送达 ' + deliveries.length + ' 个会话（点击切换接受状态）'
        ),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
          deliveries.map(function (delivery, index) {
            var accepted = delivery.acceptedAt !== null
            var title = delivery.title !== '' ? delivery.title : '会话 ' + shortId(delivery.sessionId)
            var label =
              title +
              '（' +
              shortId(delivery.sessionId) +
              '） · ' +
              formatLocalTime(delivery.deliveredAt)
            return h(
              'button',
              {
                key: 'delivery-' + delivery.sessionId + '-' + index,
                type: 'button',
                title: accepted
                  ? label + ' · 已于 ' + formatLocalTime(delivery.acceptedAt) + ' 接受'
                  : label + ' · 未接受',
                'aria-pressed': accepted,
                onClick: function () {
                  var payload = { id: rule.id, sessionId: delivery.sessionId }
                  // 已接受时附带 accepted:false 表示尝试取消；宿主不识别该字段时按幂等标记处理，
                  // 界面始终以服务端返回的 state 为准。
                  if (accepted) payload.accepted = false
                  props.run('rule.accept', payload)
                },
                style: mergeStyle(styles.chip, accepted ? styles.chipAccepted : null)
              },
              accepted ? '✓ ' : '',
              label
            )
          })
        )
      )
    }

    function RuleCard(props) {
      var rule = props.rule
      var index = props.index
      var run = props.run
      var busy = props.busy
      var state = React.useState(false)
      var expanded = state[0]
      var setExpanded = state[1]
      var long = isLongText(rule.text)
      var deliveries = asArray(props.deliveries)
      var groupOptions = [{ value: '', label: '工作区（不指定群组）' }].concat(
        index.groups.map(function (group) {
          return { value: group.id, label: group.name }
        })
      )
      return h(
        'div',
        { style: styles.card },
        h(
          'div',
          { style: styles.cardHead },
          h(Badge, { tone: KIND_TONE[displayKindOf(rule)] || 'neutral' }, KIND_LABELS[displayKindOf(rule)] || '经验'),
          h(Badge, { tone: scopeBadgeTone(rule), title: rule.workspace || '' }, scopeBadgeText(rule, index)),
          h('span', { style: styles.spacer }),
          h(
            'span',
            { style: mergeStyle(styles.rowMuted, { flex: 'none' }) },
            formatLocalTime(rule.ts)
          )
        ),
        h('div', { style: styles.cardTitle }, rule.title),
        rule.text !== ''
          ? h(
              'div',
              { style: mergeStyle(styles.cardText, long && !expanded ? styles.clamp3 : null) },
              rule.text
            )
          : null,
        long
          ? h(
              'button',
              {
                type: 'button',
                style: mergeStyle(styles.linkButton, { marginTop: 3 }),
                onClick: function () {
                  setExpanded(!expanded)
                }
              },
              expanded ? '收起' : '展开全文'
            )
          : null,
        rule.tags.length > 0
          ? h(
              'div',
              { style: mergeStyle(styles.metaRow, { marginTop: 4 }) },
              rule.tags.map(function (tag, tagIndex) {
                return h('span', { key: 'tag-' + tagIndex, style: styles.tag }, '#' + tag)
              })
            )
          : null,
        rule.files.length > 0
          ? h(
              'div',
              { style: mergeStyle(styles.rowMuted, { marginTop: 4 }), title: rule.files.join('\n') },
              '文件：' + rule.files.join('、')
            )
          : null,
        rule.kind === 'request'
          ? h(
              'div',
              { style: mergeStyle(styles.rowMuted, { marginTop: 4 }) },
              rule.status === 'answered'
                ? '请求已由会话 ' + shortId(rule.answeredBy) + ' 回复'
                : rule.status === 'canceled'
                  ? '请求已撤回（不再结算奖励）'
                  : '请求待响应（目标会话在线时会被唤醒；离线时下次运行看到）'
            )
          : null,
        h(
          'div',
          { style: styles.metaRow },
          h('span', null, '作者 ' + shortId(rule.author)),
          rule.scope === 'global' ? h('span', null, '· 全局可见') : null,
          rule.groupId ? h('span', null, '· 群组规矩') : null
        ),
        h(DeliveryChips, { rule: rule, deliveries: deliveries, run: run, busy: busy }),
        h(
          'div',
          { style: styles.actionsRow },
          h(RawSelect, {
            small: true,
            value: rule.groupId || '',
            title: '把这条规矩指定到群组（工作区 = 取消群组）',
            ariaLabel: '指定群组',
            options: groupOptions,
            onChange: function (event) {
              var next = event && event.target ? event.target.value : ''
              if (next === (rule.groupId || '')) return
              run('rule.retarget', { id: rule.id, groupId: next === '' ? null : next })
            }
          }),
          h('span', { style: styles.spacer }),
          rule.kind === 'task' || rule.kind === 'request'
            ? h(
                Btn,
                {
                  variant: 'danger',
                  disabled: busy,
                  title: '撤回这条任务/请求（同时取消关联未完成请求与待复核，不结算奖励）',
                  onClick: function () {
                    run('entry.retract', { id: rule.id }, '已撤回「' + asString(rule.title).slice(0, 20) + '」')
                  }
                },
                '撤回'
              )
            : null,
          h(
            Btn,
            {
              variant: 'danger',
              disabled: busy,
              onClick: function () {
                if (!confirmAction('确认删除规矩「' + rule.title + '」？删除后无法恢复。')) return
                run('rule.remove', { id: rule.id })
              }
            },
            '删除'
          )
        )
      )
    }

    function CreateRuleForm(props) {
      var state = React.useState('')
      var title = state[0]
      var setTitle = state[1]
      var textState = React.useState('')
      var text = textState[0]
      var setText = textState[1]
      var kindState = React.useState('note')
      var kind = kindState[0]
      var setKind = kindState[1]
      var targetState = React.useState('workspace')
      var target = targetState[0]
      var setTarget = targetState[1]
      var filesState = React.useState('')
      var files = filesState[0]
      var setFiles = filesState[1]
      var groups = asArray(props.groups)
      var canSubmit = title.trim() !== '' && text.trim() !== '' && props.busy !== true

      function submit() {
        if (!canSubmit) return
        var groupId = target.indexOf('g:') === 0 ? target.slice(2) : null
        var payload = {
          title: title.trim(),
          text: text.trim(),
          kind: kind,
          groupId: groupId,
          scope: target === 'global' ? 'global' : 'workspace',
          files: files.trim()
        }
        props.run('rule.create', payload).then(function (ok) {
          if (!ok) return
          setTitle('')
          setText('')
          setKind('note')
          setTarget('workspace')
          setFiles('')
          if (typeof props.onDone === 'function') props.onDone()
        })
      }

      var targetOptions = [
        { value: 'workspace', label: '工作区（同工作区所有会话）' },
        { value: 'global', label: '全局（所有工作区）' }
      ].concat(
        groups.map(function (group) {
          return { value: 'g:' + group.id, label: '群组：' + group.name }
        })
      )

      return h(
        'div',
        { style: styles.form },
        h('div', { style: styles.formTitle }, '发布新规矩'),
        h(FieldLabel, null, '标题'),
        h(RawInput, {
          value: title,
          placeholder: '例如：论文图片统一 600dpi',
          onChange: function (event) {
            setTitle(event && event.target ? event.target.value : '')
          }
        }),
        h(FieldLabel, null, '正文'),
        h(RawInput, {
          multiline: true,
          value: text,
          placeholder: '写清楚适用范围、做法与注意事项',
          onChange: function (event) {
            setText(event && event.target ? event.target.value : '')
          }
        }),
        h(
          'div',
          { style: { display: 'flex', gap: 6 } },
          h(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            h(FieldLabel, null, '类型'),
            h(RawSelect, {
              value: kind,
              options: KIND_ORDER.map(function (item) {
                return { value: item, label: KIND_LABELS[item] }
              }),
              onChange: function (event) {
                setKind(event && event.target ? event.target.value : 'note')
              }
            })
          ),
          h(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            h(FieldLabel, null, '目标'),
            h(RawSelect, {
              value: target,
              options: targetOptions,
              onChange: function (event) {
                setTarget(event && event.target ? event.target.value : 'workspace')
              }
            })
          )
        ),
        h('div', { style: styles.formHint }, '发布后会同步给目标范围内的其它会话，无需重启。'),
        h(FieldLabel, null, '关键文件（可选，交接/结论涉及的文件）'),
        h(RawInput, {
          value: files,
          placeholder: '例如：output/report.docx, results/step3.png（逗号或换行分隔）',
          onChange: function (event) {
            setFiles(event && event.target ? event.target.value : '')
          }
        }),
        h(
          'div',
          { style: styles.formHint },
          '群组成员会在「群组共享上下文」里看到关键文件，避免重复产出；交接给其他会话时建议类型选「交接」。'
        ),
        h(
          'div',
          { style: mergeStyle(styles.actionsRow, { marginTop: 8 }) },
          h(Btn, { variant: 'primary', disabled: !canSubmit, onClick: submit }, '发布'),
          h(
            Btn,
            {
              onClick: function () {
                if (typeof props.onCancel === 'function') props.onCancel()
              }
            },
            '取消'
          )
        )
      )
    }

    function RulesSection(props) {
      var state = props.state
      var index = props.index
      var [showForm, setShowForm] = React.useState(false)
      var rules = asArray(state.rules).filter(function (rule) {
        return rule.hiddenFromChat !== true
      })

      return h(
        'div',
        null,
        h(
          'div',
          { style: mergeStyle(styles.rowLine, { marginBottom: 8 }) },
          h('span', { style: { fontSize: 12, fontWeight: 600 } }, '规矩 ' + rules.length),
          h('span', { style: styles.spacer }),
          h(
            Btn,
            {
              variant: showForm ? undefined : 'primary',
              onClick: function () {
                setShowForm(!showForm)
              }
            },
            showForm ? '收起表单' : '+ 发布新规矩'
          )
        ),
        showForm
          ? h(CreateRuleForm, {
              groups: index.groups,
              busy: props.busy,
              run: props.run,
              onDone: function () {
                setShowForm(false)
              },
              onCancel: function () {
                setShowForm(false)
              }
            })
          : null,
        rules.length === 0
          ? h(EmptyHint, null, '暂无规矩。点击「+ 发布新规矩」创建第一条。')
          : rules.map(function (rule) {
              return h(RuleCard, {
                key: 'rule-' + rule.id,
                rule: rule,
                index: index,
                deliveries: asArray(state.deliveries[rule.id]),
                run: props.run,
                busy: props.busy
              })
            })
      )
    }
    //#endregion

    //#region 群组页
    function CreateGroupForm(props) {
      var nameState = React.useState('')
      var name = nameState[0]
      var setName = nameState[1]
      var goalState = React.useState('')
      var goal = goalState[0]
      var setGoal = goalState[1]
      var selectedState = React.useState([])
      var selectedIds = selectedState[0]
      var setSelectedIds = selectedState[1]
      var sessions = asArray(props.sessions)
      var canSubmit = name.trim() !== '' && props.busy !== true

      function submit() {
        if (!canSubmit) return
        var workspace = ''
        for (var i = 0; i < sessions.length; i += 1) {
          if (selectedIds.indexOf(sessions[i].id) >= 0 && sessions[i].cwd !== '') {
            workspace = sessions[i].cwd
            break
          }
        }
        if (workspace === '' && sessions.length > 0) workspace = sessions[0].cwd || ''
        props.run('group.create', {
          name: name.trim(),
          workspace: workspace,
          goal: goal.trim(),
          sessionIds: selectedIds.slice()
        }).then(function (ok) {
          if (!ok) return
          setName('')
          setGoal('')
          setSelectedIds([])
          if (typeof props.onDone === 'function') props.onDone()
        })
      }

      return h(
        'div',
        { style: styles.form },
        h('div', { style: styles.formTitle }, '新建群组'),
        h(FieldLabel, null, '群组名称'),
        h(RawInput, {
          value: name,
          placeholder: '例如：论文组',
          onChange: function (event) {
            setName(event && event.target ? event.target.value : '')
          }
        }),
        h(FieldLabel, null, '群组目标（可选，写给成员看：这组要一起完成什么）'),
        h(RawInput, {
          multiline: true,
          value: goal,
          placeholder: '例如：完成论文第 3 章（正文 + 图 + 参考文献）；已有产出见群文件，别重复做',
          onChange: function (event) {
            setGoal(event && event.target ? event.target.value : '')
          }
        }),
        h(FieldLabel, null, '初始成员（可留空，之后再加）'),
        h(SessionPicker, {
          sessions: sessions,
          selectedIds: selectedIds,
          emptyText: '当前没有可用会话',
          onChange: setSelectedIds
        }),
        h('div', { style: styles.formHint }, '已选 ' + selectedIds.length + ' 个会话'),
        h(
          'div',
          { style: mergeStyle(styles.actionsRow, { marginTop: 8 }) },
          h(Btn, { variant: 'primary', disabled: !canSubmit, onClick: submit }, '创建群组'),
          h(
            Btn,
            {
              onClick: function () {
                if (typeof props.onCancel === 'function') props.onCancel()
              }
            },
            '取消'
          )
        )
      )
    }

    function GroupMemberRow(props) {
      var session = props.session
      var live = session.live === true
      var running = session.status === 'running'
      var grants = asArray(props.grants)
      var others = asArray(props.otherMembers).filter(function (member) {
        return member.id !== session.id && grants.indexOf(member.id) < 0
      })
      return h(
        'div',
        { style: { borderBottom: '0.5px solid var(--dsw-alias-border-l3)' } },
        h(
          'div',
          { style: styles.groupMemberRow },
          h('span', {
            style: mergeStyle(
              styles.dot,
              running ? styles.dotRunning : live ? styles.dotLive : styles.dotIdle
            ),
            title: running ? '运行中' : live ? '空闲（在线）' : '离线'
          }),
          h(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            h(
              'div',
              { style: styles.rowTitle },
              (session.avatar || '👤') + ' ' + session.title,
              props.group && props.group.managerSessionId === session.id
                ? '（群管理）'
                : session.protected
                  ? '（维护者·观察）'
                  : '',
              ' ',
              h(
                Badge,
                {
                  tone: session.protected ? 'warn' : session.availability === 'busy' ? 'warn' : 'success',
                  title: session.protected
                    ? '维护者 protected/service：只观察、不接普通任务（bug 走修bug群）'
                    : session.availability === 'busy'
                      ? '忙碌：' + ((session.currentTask && session.currentTask.title) || '有未回答请求/未完成任务')
                      : '空闲：可以接新任务'
                },
                session.protected ? '维护者' : session.availability === 'busy' ? '忙' : '空闲'
              )
            ),
            session.handle
              ? h(
                  'div',
                  { style: mergeStyle(styles.rowMuted, { fontSize: 10.5 }) },
                  'ID：' + session.handle,
                  h(
                    'button',
                    {
                      type: 'button',
                      title: 'contactId：点击复制（可直接用作 session_ask 的 to）',
                      onClick: function () {
                        copyContactId(session.contactId || contactIdOf(session.id))
                      },
                      style: mergeStyle(styles.chip || {}, {
                        cursor: 'pointer',
                        marginLeft: 6,
                        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                        fontSize: 10
                      })
                    },
                    session.contactId || contactIdOf(session.id)
                  )
                )
              : h(
                  'div',
                  { style: mergeStyle(styles.rowMuted, { fontSize: 10.5 }) },
                  'contactId：',
                  h(
                    'button',
                    {
                      type: 'button',
                      title: '点击复制（可直接用作 session_ask 的 to）',
                      onClick: function () {
                        copyContactId(session.contactId || contactIdOf(session.id))
                      },
                      style: mergeStyle(styles.chip || {}, {
                        cursor: 'pointer',
                        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                        fontSize: 10
                      })
                    },
                    session.contactId || contactIdOf(session.id)
                  )
                ),
            props.profile && props.profile.summary
              ? h(
                  'div',
                  { style: mergeStyle(styles.rowMuted, { fontSize: 10.5 }), title: props.profile.summary },
                  asString(props.profile.summary).slice(0, 70)
                )
              : h('div', { style: mergeStyle(styles.rowMuted, { fontSize: 10.5 }) }, '未申报')
          ),
          h('span', {
            key: 'contact-' + session.id,
            title: 'contactId：点击复制（可直接用作 session_ask 的 to）',
            onClick: function () {
              copyContactId(session.contactId || contactIdOf(session.id))
            },
            style: mergeStyle(styles.rowMuted, {
              flex: 'none',
              cursor: 'pointer',
              fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace'
            })
          }, session.contactId || contactIdOf(session.id)),
          h(
            'span',
            { style: mergeStyle(styles.rowMuted, { flex: 'none', fontSize: 10.5 }) },
            typeof session.points === 'number' ? (session.points >= 0 ? '+' : '') + session.points : ''
          ),
          h(
            'span',
            { style: mergeStyle(styles.rowMuted, { flex: 'none' }) },
            running ? '运行中' : live ? '在线' : '离线'
          ),
          running
            ? h(
                Btn,
                {
                  variant: 'danger',
                  disabled: props.busy,
                  title: '打断这一轮（不删会话、不丢历史；宿主不支持时会明确提示）',
                  onClick: function () {
                    props.run('agent.interrupt', { sessionId: session.id }, '已打断「' + asString(session.title).slice(0, 20) + '」')
                  }
                },
                '打断'
              )
            : null,
          h(
            Btn,
            {
              variant: 'ghost',
              disabled: props.busy,
              title: '从该群组移除',
              onClick: function () {
                props.run('group.remove', { id: props.group.id, sessionId: session.id })
              }
            },
            '移除'
          )
        ),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', padding: '0 0 6px 10px' } },
          h('span', { style: mergeStyle(styles.rowMuted, { flex: 'none', fontSize: 10.5 }) }, '可唤醒：'),
          grants.length === 0
            ? h('span', { style: mergeStyle(styles.rowMuted, { fontSize: 10.5 }) }, '（未授权，不能主动唤醒别人）')
            : grants.map(function (targetId) {
                var target = null
                for (var i = 0; i < asArray(props.otherMembers).length; i += 1) {
                  if (props.otherMembers[i].id === targetId) target = props.otherMembers[i]
                }
                return h(
                  'button',
                  {
                    key: 'grant-' + targetId,
                    type: 'button',
                    title: '点击撤销对该成员的唤醒授权',
                    onClick: function () {
                      props.run('perm.revoke', { sessionId: session.id, targetId: targetId })
                    },
                    style: mergeStyle(styles.chip || {}, { cursor: 'pointer' })
                  },
                  '× ' + (target ? target.title : shortId(targetId))
                )
              }),
          others.length > 0
            ? h(
                'select',
                {
                  value: '',
                  disabled: props.busy,
                  style: { fontSize: 10.5, maxWidth: 150 },
                  onChange: function (event) {
                    var targetId = event && event.target ? event.target.value : ''
                    if (targetId) props.run('perm.grant', { sessionId: session.id, targetId: targetId })
                  }
                },
                h('option', { value: '' }, '+ 授权唤醒…'),
                others.map(function (member) {
                  return h('option', { key: 'opt-' + member.id, value: member.id }, member.title.slice(0, 16))
                })
              )
            : null
        )
      )
    }

    function GroupCard(props) {
      var group = props.group
      var index = props.index
      var run = props.run
      var busy = props.busy
      var curatedRuleList = (function () {
        var seen = {}
        var list = []
        asArray(index.rules)
          .filter(function (rule) {
            return rule.curated === true && rule.groupId === group.id
          })
          .sort(function (a, b) {
            return (b.ts || 0) - (a.ts || 0)
          })
          .forEach(function (rule) {
            var key = asString(rule.title).replace(/\s+/g, ' ').trim().toLowerCase()
            if (!key || seen[key]) return
            seen[key] = true
            list.push(rule)
          })
        return list.slice(0, 8)
      })()
      var expandedState = React.useState(props.defaultExpanded === true)
      var expanded = expandedState[0]
      var setExpanded = expandedState[1]
      var renamingState = React.useState(false)
      var renaming = renamingState[0]
      var setRenaming = renamingState[1]
      var draftState = React.useState(group.name)
      var draftName = draftState[0]
      var setDraftName = draftState[1]
      var addingState = React.useState(false)
      var adding = addingState[0]
      var setAdding = addingState[1]
      var addSelectedState = React.useState([])
      var addSelected = addSelectedState[0]
      var setAddSelected = addSelectedState[1]

      var members = asArray(group.sessionIds).map(function (sessionId) {
        return (
          index.sessionById[sessionId] || {
            id: sessionId,
            title: '（已不可见的会话）',
            cwd: '',
            live: false,
            status: 'idle',
            createdAt: 0
          }
        )
      })
      var rules = asArray(index.rulesByGroup[group.id])
      var groupFiles = []
      rules.forEach(function (rule) {
        asArray(rule.files).forEach(function (file) {
          if (file !== '' && groupFiles.indexOf(file) < 0) groupFiles.push(file)
        })
      })
      var handoffCount = rules.filter(function (rule) {
        return rule.kind === 'handoff'
      }).length
      var goalEditingState = React.useState(false)
      var editingGoal = goalEditingState[0]
      var setEditingGoal = goalEditingState[1]
      var goalDraftState = React.useState(group.goal || '')
      var goalDraft = goalDraftState[0]
      var setGoalDraft = goalDraftState[1]

      function submitGoal() {
        run('group.update', { id: group.id, goal: goalDraft.trim() }).then(function (ok) {
          if (ok) setEditingGoal(false)
        })
      }
      var available = index.sessions.filter(function (session) {
        return group.sessionIds.indexOf(session.id) < 0
      })

      function submitRename() {
        var next = draftName.trim()
        if (next === '' || next === group.name) {
          setRenaming(false)
          setDraftName(group.name)
          return
        }
        run('group.rename', { id: group.id, name: next }).then(function (ok) {
          if (ok) setRenaming(false)
        })
      }

      function submitAdd() {
        if (addSelected.length === 0) return
        run('group.add', { id: group.id, sessionIds: addSelected.slice() }).then(function (ok) {
          if (!ok) return
          setAddSelected([])
          setAdding(false)
        })
      }

      return h(
        'div',
        { style: styles.card },
        h(
          'div',
          { style: styles.cardHead },
          h(
          'div',
          { style: mergeStyle(styles.rowMuted, { marginTop: 2 }), title: group.goal || '' },
          '目标：' + (group.goal || '未设置（展开后可编辑）')
        ),
        h(
          'div',
          { style: mergeStyle(styles.rowMuted, { marginTop: 2 }) },
          '交接 ' + handoffCount + ' 条' + (groupFiles.length ? ' · 关键文件 ' + groupFiles.length + ' 个' : '')
        ),
        renaming
            ? h(RawInput, {
                value: draftName,
                style: { flex: 1, minWidth: 80 },
                onChange: function (event) {
                  setDraftName(event && event.target ? event.target.value : '')
                },
                onKeyDown: function (event) {
                  if (event && event.key === 'Enter') submitRename()
                  if (event && event.key === 'Escape') {
                    setRenaming(false)
                    setDraftName(group.name)
                  }
                }
              })
            : h('span', { style: mergeStyle(styles.cardTitle, { margin: 0, flex: 1 }) }, group.name),
          h('span', { style: mergeStyle(styles.rowMuted, { flex: 'none' }) }, '成员 ' + members.length),
          h('span', { style: mergeStyle(styles.rowMuted, { flex: 'none' }) }, '规矩 ' + rules.length),
          h(
            Btn,
            {
              variant: 'ghost',
              onClick: function () {
                setExpanded(!expanded)
              }
            },
            expanded ? '收起' : '展开'
          )
        ),
        h(
          'div',
          { style: mergeStyle(styles.rowMuted, { marginTop: 2 }), title: group.goal || '' },
          '目标：' + (group.goal || '未设置（展开后可编辑）')
        ),
        h(
          'div',
          { style: mergeStyle(styles.rowMuted, { marginTop: 2 }) },
          '交接 ' + handoffCount + ' 条' + (groupFiles.length ? ' · 关键文件 ' + groupFiles.length + ' 个' : '')
        ),
        renaming
          ? h(
              'div',
              { style: mergeStyle(styles.actionsRow, { marginTop: 6 }) },
              h(Btn, { variant: 'primary', disabled: busy, onClick: submitRename }, '保存'),
              h(
                Btn,
                {
                  onClick: function () {
                    setRenaming(false)
                    setDraftName(group.name)
                  }
                },
                '取消'
              )
            )
          : null,
        expanded
          ? h(
              'div',
              { style: { marginTop: 4 } },
              h(
                'div',
                { style: { margin: '6px 0 2px' } },
                h('div', { style: styles.rowMuted }, '群管理（AI）'),
                h(
                  'div',
                  { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                  h(
                    'span',
                    { style: { flex: 1, minWidth: 80, fontSize: 11 } },
                    group.managerSessionId && index.sessionById[group.managerSessionId]
                      ? index.sessionById[group.managerSessionId].title
                      : '未设置'
                  ),
                  h(RawSelect, {
                    small: true,
                    value: group.managerSessionId || '',
                    options: [{ value: '', label: '选择成员…' }].concat(
                      asArray(group.sessionIds).map(function (sessionId) {
                        var session = index.sessionById[sessionId]
                        return { value: sessionId, label: session ? asString(session.title).slice(0, 14) : shortId(sessionId) }
                      })
                    ),
                    onChange: function (event) {
                      var managerId = event && event.target ? event.target.value : ''
                      run('group.manager', { id: group.id, managerId: managerId })
                    }
                  }),
                  h(
                    Btn,
                    {
                      variant: 'ghost',
                      disabled: busy,
                      onClick: function () {
                        run('group.manager', { id: group.id, create: true })
                      }
                    },
                    '＋ 新建 AI 管理'
                  ),
                  h(
                    Btn,
                    {
                      variant: 'primary',
                      disabled: busy || !group.managerSessionId,
                      onClick: function () {
                        run('group.manager', { id: group.id, kickoff: true })
                      }
                    },
                    '让群管理介入'
                  )
                ),
                h(
                  'div',
                  { style: mergeStyle(styles.rowMuted, { fontSize: 10.5 }) },
                  '复核后需要修改时，群管理会自动把修改项指派给成员，不用你手动派。'
                )
              ),
              h(
                'div',
                { style: { margin: '6px 0 2px' } },
                (function () {
                  var curatedRules = curatedRuleList
                  return h(
                    'div',
                    null,
                    h(
                      'div',
                      { style: styles.rowMuted },
                      '群规矩（群管理整理，' + curatedRules.length + ' 条；聊天记录不算规矩）'
                    ),
                    curatedRules.length === 0
                      ? h(
                          'div',
                          { style: mergeStyle(styles.rowMuted, { fontSize: 10.5 }) },
                          '还没有整理过的群规矩（群管理每轮结束后会沉淀，最多 3 条）'
                        )
                      : curatedRules.map(function (rule) {
                          return h(
                            'div',
                            {
                              key: 'curated-' + rule.id,
                              style: mergeStyle(styles.rowMuted, { fontSize: 10.5 }),
                              title: rule.text
                            },
                            '· ' + rule.title + '：' + asString(rule.text).slice(0, 70)
                          )
                        })
                  )
                })()
              ),
              h('div', { style: mergeStyle(styles.rowMuted, { margin: '6px 0 2px' }) }, '成员'),
              members.length === 0
                ? h(EmptyHint, { style: { padding: '6px 4px' } }, '该群组暂无成员')
                : members.map(function (member) {
                    return h(GroupMemberRow, {
                      key: 'member-' + member.id,
                      group: group,
                      session: member,
                      profile: index.profilesBySession[member.id],
                      grants: index.permissionsBySession[member.id] || [],
                      otherMembers: members,
                      run: run,
                      busy: busy
                    })
                  }),
              adding
                ? h(
                    'div',
                    null,
                    h(SessionPicker, {
                      sessions: available,
                      selectedIds: addSelected,
                      emptyText: '没有可加入的会话',
                      onChange: setAddSelected
                    }),
                    h(
                      'div',
                      { style: mergeStyle(styles.actionsRow, { marginTop: 6 }) },
                      h(
                        Btn,
                        {
                          variant: 'primary',
                          disabled: busy || addSelected.length === 0,
                          onClick: submitAdd
                        },
                        '加入所选（' + addSelected.length + '）'
                      ),
                      h(
                        Btn,
                        {
                          onClick: function () {
                            setAdding(false)
                            setAddSelected([])
                          }
                        },
                        '取消'
                      )
                    )
                  )
                : null,
              h(
                'div',
                { style: { margin: '6px 0 2px' } },
                h('div', { style: styles.rowMuted }, '共享上下文（成员每轮自动看到，避免重复造轮子）'),
                editingGoal
                  ? h(RawInput, {
                      multiline: true,
                      value: goalDraft,
                      style: { width: '100%', boxSizing: 'border-box', marginTop: 2 },
                      placeholder: '这组要一起完成什么？已有产出/文件/不要重复做什么',
                      onChange: function (event) {
                        setGoalDraft(event && event.target ? event.target.value : '')
                      }
                    })
                  : h(
                      'div',
                      { style: mergeStyle(styles.rowMuted, { marginTop: 2 }), title: group.goal || '' },
                      group.goal || '（未设置目标）'
                    ),
                h(
                  'div',
                  { style: mergeStyle(styles.actionsRow, { marginTop: 4 }) },
                  editingGoal
                    ? h(Btn, { variant: 'primary', disabled: busy, onClick: submitGoal }, '保存目标')
                    : h(
                        Btn,
                        {
                          onClick: function () {
                            setGoalDraft(group.goal || '')
                            setEditingGoal(true)
                          }
                        },
                        '编辑目标'
                      ),
                  editingGoal
                    ? h(
                        Btn,
                        {
                          onClick: function () {
                            setGoalDraft(group.goal || '')
                            setEditingGoal(false)
                          }
                        },
                        '取消'
                      )
                    : null
                ),
                groupFiles.length > 0
                  ? h(
                      'div',
                      { style: mergeStyle(styles.rowMuted, { marginTop: 2 }), title: groupFiles.join('\n') },
                      '关键文件：' + groupFiles.slice(0, 8).join('、')
                    )
                  : null,
                handoffCount > 0
                  ? h(
                      'div',
                      { style: mergeStyle(styles.rowMuted, { marginTop: 2 }) },
                      '交接：' + handoffCount + ' 条（见下方规矩列表；成员轮次会自动注入）'
                    )
                  : null
              ),
              h(
                'div',
                { style: { margin: '6px 0 2px' } },
                h('div', { style: styles.rowMuted }, '规矩'),
                rules.length === 0
                  ? h('div', { style: mergeStyle(styles.rowMuted, { marginTop: 2 }) }, '该群组暂无规矩')
                  : rules.map(function (rule) {
                      return h(
                        'div',
                        { key: 'group-rule-' + rule.id, style: mergeStyle(styles.rowMuted, { marginTop: 2 }) },
                        '· ' + rule.title
                      )
                    })
              ),
              h('div', { style: styles.divider }),
              h(
                'div',
                { style: styles.actionsRow },
                h(
                  Btn,
                  {
                    disabled: busy || available.length === 0,
                    onClick: function () {
                      setAdding(!adding)
                      setAddSelected([])
                    }
                  },
                  '+ 加成员'
                ),
                h(
                  Btn,
                  {
                    onClick: function () {
                      setRenaming(true)
                      setDraftName(group.name)
                    }
                  },
                  '重命名'
                ),
                h('span', { style: styles.spacer }),
                h(
                  Btn,
                  {
                    variant: 'danger',
                    disabled: busy,
                    onClick: function () {
                      if (!confirmAction('确认删除群组「' + group.name + '」？群内规矩会回到工作区。')) return
                      run('group.delete', { id: group.id })
                    }
                  },
                  '删除群组'
                )
              )
            )
          : null
      )
    }

    //#region 群聊（微信聊天式）
    var CHAT_COLORS = ['#5B8FF9', '#61DDAA', '#F6BD16', '#7262FD', '#78D3F8', '#9661BC', '#F6903D', '#008685']
    function chatColorFor(id) {
      var text = asString(id)
      var total = 0
      for (var i = 0; i < text.length; i += 1) total += text.charCodeAt(i)
      return CHAT_COLORS[total % CHAT_COLORS.length]
    }
    function chatDayKey(ts) {
      return formatLocalTime(ts).slice(0, 10)
    }
    function chatClock(ts) {
      return formatLocalTime(ts).slice(11)
    }
    function chatDayLabel(key) {
      var today = formatLocalTime(Date.now()).slice(0, 10)
      return key === today ? '今天' : key
    }
    var chatStyles = {
      listRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '8px 6px',
        background: 'transparent',
        border: 'none',
        borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
        cursor: 'pointer',
        textAlign: 'left',
        color: 'inherit',
        fontFamily: 'inherit',
        fontSize: 12
      },
      chatRoot: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, flex: 1 },
      retractBtn: {
        marginLeft: 'auto',
        border: '0.5px solid rgba(229,72,77,.45)',
        background: 'transparent',
        color: '#e5484d',
        borderRadius: 999,
        padding: '0 6px',
        fontSize: 10,
        lineHeight: '16px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        flex: 'none'
      },
      chatHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 4px 8px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
        flex: 'none'
      },
      backBtn: {
        width: 22,
        height: 22,
        flex: 'none',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        fontSize: 18,
        lineHeight: 1,
        padding: 0,
        fontFamily: 'inherit'
      },
      chatColumn: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
      settings: { flex: 1, minHeight: 0, overflow: 'auto', paddingTop: 6 },
      chatBody: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 2px 4px' },
      day: { textAlign: 'center', fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary)', margin: '6px 0' },
      bubbleOther: {
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: '3px 10px 10px 10px',
        padding: '6px 8px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        width: 'fit-content',
        maxWidth: '100%',
        boxSizing: 'border-box'
      },
      bubbleSelf: {
        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, var(--dsw-alias-bg-layer-2))',
        border: '0.5px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent)',
        borderRadius: '10px 3px 10px 10px',
        padding: '6px 8px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        width: 'fit-content',
        maxWidth: '100%',
        boxSizing: 'border-box',
        marginLeft: 'auto'
      },
      fileBox: {
        marginTop: 4,
        padding: '4px 6px',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 6,
        fontSize: 11
      },
      bubbleUrgent: {
        border: '0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, var(--dsw-alias-bg-layer-2))'
      },
      urgentNotice: {
        padding: '3px 2px 2px',
        fontSize: 10.5,
        color: 'var(--dsw-alias-state-warn-primary)',
        wordBreak: 'break-word'
      },
      inputBar: {
        display: 'flex',
        gap: 6,
        alignItems: 'flex-end',
        paddingTop: 6,
        borderTop: '0.5px solid var(--dsw-alias-border-l3)',
        flex: 'none'
      },
      mentionBar: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
        padding: '4px 0',
        borderTop: '0.5px dashed var(--dsw-alias-border-l3)'
      },
      avatar: {
        width: 28,
        height: 28,
        flex: 'none',
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        fontWeight: 600,
        color: '#fff'
      }
    }

    function ChatAvatar(props) {
      var label = asString(props.label).trim()
      var text = label ? label.slice(0, 1) : '群'
      return h(
        'div',
        { style: mergeStyle(chatStyles.avatar, { background: props.color || chatColorFor(label) }) },
        text
      )
    }

    /** 群列表里的一行：像微信会话列表（头像 + 群名 + 最后一条消息 + 时间）。 */
    function GroupChatRow(props) {
      var group = props.group
      var index = props.index
      var rules = asArray(index.rulesByGroup[group.id])
        .filter(function (rule) {
          return rule.hiddenFromChat !== true
        })
        .slice()
        .sort(function (a, b) {
          return (b.ts || 0) - (a.ts || 0)
        })
      var last = rules[0]
      var preview = last
        ? ('[' + (KIND_LABELS[displayKindOf(last)] || '经验') + '] ' + asString(last.title)).slice(0, 44)
        : '暂无消息'
      return h(
        'button',
        {
          type: 'button',
          onClick: function () {
            props.onOpen(group.id)
          },
          style: chatStyles.listRow
        },
        h(ChatAvatar, { label: group.name, color: chatColorFor(group.name) }),
        h(
          'div',
          { style: { flex: 1, minWidth: 0 } },
          h(
            'div',
            { style: styles.rowLine },
            h('span', { style: mergeStyle(styles.rowTitle, { flex: 1 }) }, group.name),
            group.kind === 'bugfix' ? h(Badge, { tone: 'warn', title: '维护者的修bug群：只收 BUG 报告，不派普通任务' }, '修bug群') : null,
            h('span', { style: mergeStyle(styles.rowMuted, { flex: 'none' }) }, last ? chatClock(last.ts) : '')
          ),
          h(
            'div',
            { style: mergeStyle(styles.rowMuted, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) },
            preview
          )
        ),
        h(
          'span',
          { style: mergeStyle(styles.rowMuted, { flex: 'none', marginLeft: 4 }) },
          asArray(group.sessionIds).length + ' 人'
        )
      )
    }

    /** 一条群消息气泡：来自会话的消息在左边，从看板发的消息在右边。 */
    function ChatBubble(props) {
      var rule = props.rule
      var index = props.index
      var run = props.run
      var self = rule.author === 'panel' || rule.origin === 'panel'
      var session = index.sessionById[rule.author]
      var name = self ? '我（看板）' : session ? session.title : shortId(rule.author)
      var displayKind = displayKindOf(rule)
      var kindLabel = KIND_LABELS[displayKind] || '经验'
      var requestStatus = ''
      if (rule.kind === 'request') {
        requestStatus =
          rule.status === 'answered'
            ? '已由 ' + shortId(rule.answeredBy) + ' 回复'
            : rule.status === 'queued'
              ? '排队中' +
                (asArray(rule.dependsOn).length ? '，依赖 ' + asArray(rule.dependsOn).length + ' 项前置' : '') +
                (rule.notBefore && rule.notBefore > Date.now() ? '，延时未到' : '')
              : rule.status === 'failed'
                ? '未发出：' + (rule.failReason || '排队失败')
                : rule.status === 'canceled'
                  ? '已撤回'
                  : '待响应'
      }
      return h(
        'div',
        { style: { display: 'flex', gap: 6, marginBottom: 10, flexDirection: self ? 'row-reverse' : 'row' } },
        h(ChatAvatar, { label: name, color: chatColorFor(rule.author) }),
        h(
          'div',
          { style: { maxWidth: '82%', minWidth: 0 } },
          h(
            'div',
            {
              style: mergeStyle(styles.rowMuted, {
                fontSize: 10.5,
                marginBottom: 2,
                textAlign: self ? 'right' : 'left'
              })
            },
            name + (self ? '' : ' · ' + chatClock(rule.ts))
          ),
          h(
            'div',
            {
              style: mergeStyle(
                self ? chatStyles.bubbleSelf : chatStyles.bubbleOther,
                rule.urgent ? chatStyles.bubbleUrgent : null
              )
            },
            h(
              'div',
              { style: { display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2, flexWrap: 'wrap' } },
              rule.urgent ? h(Badge, { tone: 'error' }, '⚡ 加急') : null,
              h(Badge, { tone: KIND_TONE[displayKind] || 'neutral' }, kindLabel),
              requestStatus !== '' ? h(Badge, { tone: rule.status === 'answered' ? 'success' : rule.status === 'queued' ? undefined : rule.status === 'canceled' ? 'neutral' : 'warn' }, requestStatus) : null,
              h(
                'button',
                {
                  type: 'button',
                  title: '撤回这条消息/任务（任务会同时取消关联请求与待复核）',
                  onClick: function (event) {
                    if (event && event.stopPropagation) event.stopPropagation()
                    if (run) run('entry.retract', { id: rule.id }, '已撤回「' + asString(rule.title).slice(0, 20) + '」')
                  },
                  style: chatStyles.retractBtn
                },
                '撤回'
              )
            ),
            rule.kind === 'task'
              ? h(
                  'div',
                  { style: mergeStyle(styles.rowMuted, { fontSize: 10.5, margin: '2px 0' }) },
                  '🧑‍✈️ 组长：' +
                    (index.sessionById[rule.coordinator] ? index.sessionById[rule.coordinator].title : shortId(rule.coordinator)) +
                    ' · 成员：' +
                    (rule.assignees.length
                      ? rule.assignees
                          .map(function (sessionId) {
                            return index.sessionById[sessionId] ? index.sessionById[sessionId].title : shortId(sessionId)
                          })
                          .join('、')
                      : '（无）') +
                    ' · 状态：' +
                    ({ assigned: '已分配', claimed: '已认领', released: '已释放', delegating: '已派发', collecting: '收集中', done: '已完成', canceled: '已撤回' }[rule.taskStatus] || rule.taskStatus || '已分配') +
                    ' · 归属：' +
                    (rule.owner
                      ? (index.sessionById[rule.owner] ? index.sessionById[rule.owner].title : shortId(rule.owner))
                      : '未认领') +
                    '（' +
                    ({ assigned: '已指派', claimed: '已认领', released: '已释放', unclaimed: '未认领' }[rule.claimState] || rule.claimState || '未认领') +
                    '）' +
                    ' / 仅 scope：' +
                    asString(rule.taskScope).slice(0, 60) +
                    (rule.scopeWarning ? ' · ⚠ 超出 scope：' + asString(rule.scopeWarning).slice(0, 40) : '') +
                    (function () {
                      var steps = asArray(rule.steps)
                      if (!steps.length) return ''
                      var done = steps.filter(function (step) {
                        return step && step.status === 'done'
                      }).length
                      var next = steps.filter(function (step) {
                        return step && step.status !== 'done'
                      })[0]
                      return ' · 步骤 ' + done + '/' + steps.length + (next ? '（下一步 ' + next.i + '：' + next.text + '）' : '（全部完成）')
                    })()
                )
              : null,
            h('div', { style: { fontWeight: 600, wordBreak: 'break-word' } }, rule.title),
            rule.text !== '' ? h('div', { style: { marginTop: 2 } }, h(SummaryText, { text: rule.text, limit: 120 })) : null,
            rule.files.length > 0
              ? h(
                  'div',
                  { style: chatStyles.fileBox },
                  h('div', { style: mergeStyle(styles.rowMuted, { fontSize: 10.5 }) }, '📎 文件'),
                  rule.files.map(function (file, fileIndex) {
                    return h(
                      'div',
                      { key: 'bubble-file-' + fileIndex, style: { wordBreak: 'break-all', fontSize: 11 } },
                      file
                    )
                  })
                )
              : null,
            rule.mentions.length > 0
              ? h(
                  'div',
                  { style: mergeStyle(styles.rowMuted, { fontSize: 10.5, marginTop: 2 }) },
                  '🔔 @ ' +
                    rule.mentions
                      .map(function (sessionId) {
                        var session = index.sessionById[sessionId]
                        return session ? session.title : shortId(sessionId)
                      })
                      .join('、')
                )
              : null
          )
        )
      )
    }

    /** 群聊窗口：头部（返回/群名/人数/设置）+ 消息流 + 底部输入框。 */
    function GroupChat(props) {
      var group = props.group
      var index = props.index
      var rules = asArray(index.rulesByGroup[group.id])
        .filter(function (rule) {
          return rule.hiddenFromChat !== true
        })
        .slice()
        .sort(function (a, b) {
          return (a.ts || 0) - (b.ts || 0)
        })
      var draftState = React.useState('')
      var draft = draftState[0]
      var setDraft = draftState[1]
      var settingsState = React.useState(false)
      var settings = settingsState[0]
      var setSettings = settingsState[1]
      var bodyRef = React.useRef(null)
      var mentionsState = React.useState([])
      var mentions = mentionsState[0]
      var setMentions = mentionsState[1]
      var coordinatorState = React.useState('')
      var coordinatorId = coordinatorState[0]
      var setCoordinatorId = coordinatorState[1]
      // ⚡ 加急模式（v2.9.3）：开启后发送走 session.urgent，而不是普通群消息。
      var urgentState = React.useState(false)
      var urgent = urgentState[0]
      var setUrgent = urgentState[1]
      var noticeState = React.useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var members = asArray(group.sessionIds).map(function (sessionId) {
        return index.sessionById[sessionId] || { id: sessionId, title: shortId(sessionId) }
      })

      React.useEffect(
        function () {
          var el = bodyRef.current
          if (!el) return
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
        },
        [rules.length]
      )

      // 进入群聊默认滚到最下方（不用手动翻）。
      React.useEffect(
        function () {
          var el = bodyRef.current
          if (!el) return
          var toBottom = function () {
            el.scrollTop = el.scrollHeight
          }
          toBottom()
          var timer = setTimeout(toBottom, 80)
          var timer2 = setTimeout(toBottom, 320)
          return function () {
            clearTimeout(timer)
            clearTimeout(timer2)
          }
        },
        [group.id]
      )

      function toggleAll() {
        if (mentions.indexOf('all') >= 0) setMentions([])
        else setMentions(['all'])
      }
      function toggleMember(sessionId) {
        var next = mentions.filter(function (item) {
          return item !== 'all'
        })
        var at = next.indexOf(sessionId)
        if (at >= 0) next.splice(at, 1)
        else next.push(sessionId)
        setMentions(next)
      }
      function send() {
        var text = draft.trim()
        if (text === '' || props.busy) return
        var mentionAll = mentions.indexOf('all') >= 0 || /@\s*(all|所有人|全体|大家)/i.test(text)
        var mentionIds = mentions.filter(function (item) {
          return item !== 'all'
        })
        // 正文里内嵌的 @ID/@标题 也自动识别，方便一句话拆多个任务。
        asArray(group.sessionIds).forEach(function (sessionId) {
          var session = props.index.sessionById[sessionId]
          if (!session || mentionIds.indexOf(sessionId) >= 0) return
          var keys = [session.handle, session.title].filter(Boolean)
          var lower = text.toLowerCase()
          var hit = keys.some(function (key) {
            var needle = String(key).toLowerCase()
            return needle !== '' && (lower.indexOf('@' + needle) >= 0 || lower.indexOf('@ ' + needle) >= 0)
          })
          if (hit) mentionIds.push(sessionId)
        })
        if (urgent) {
          // ⚡ 加急：逐个 @ 目标发送 session.urgent；宿主会处理 idle 唤醒 / running 打断或降级。
          if (mentionIds.length === 0) {
            setNotice('⚠ 加急需要先点 @ 选一位群成员（最多 3 位），再发送')
            return
          }
          var urgentTargets = mentionIds.slice(0, 3)
          setNotice('⚡ 加急发送中…')
          var urgentJobs = urgentTargets.map(function (sessionId) {
            return postCommandRaw('session.urgent', { to: sessionId, text: text, group: group.id }).then(
              function (payload) {
                return { sessionId: sessionId, payload: payload }
              },
              function (failure) {
                return { sessionId: sessionId, failure: failure }
              }
            )
          })
          Promise.all(urgentJobs).then(function (results) {
            var okParts = []
            var badParts = []
            results.forEach(function (item) {
              var session = index.sessionById[item.sessionId]
              var label = session ? asString(session.title) : shortId(item.sessionId)
              if (item.payload && item.payload.ok !== false) {
                var how = item.payload.interrupted
                  ? '已打断并插话'
                  : item.payload.degraded
                    ? '已插话（宿主不支持打断）'
                    : '已唤醒'
                okParts.push(label + '：' + how)
              } else {
                badParts.push(label + '：' + errorMessage(item.failure || (item.payload && item.payload.error)))
              }
            })
            setNotice(
              (okParts.length ? '⚡ 加急已发送：' + okParts.join('；') : '') +
                (badParts.length ? (okParts.length ? '；' : '') + '加急失败：' + badParts.join('；') : '')
            )
            if (okParts.length) {
              setDraft('')
              setMentions([])
            }
            if (typeof props.onRefresh === 'function') props.onRefresh()
          })
          return
        }
        var action = mentionAll || mentionIds.length > 0 ? 'group.post' : 'rule.create'
        var payload =
          action === 'group.post'
            ? {
                id: group.id,
                text: text,
                mentionAll: mentionAll,
                mentionSessionIds: mentionIds,
                ...(coordinatorId ? { coordinatorId: coordinatorId } : {})
              }
            : { title: text.slice(0, 20), text: text, kind: 'note', groupId: group.id, scope: 'workspace' }
        props.run(action, payload).then(function (ok) {
          if (!ok) return
          setDraft('')
          setMentions([])
          setCoordinatorId('')
        })
      }

      var seq = []
      var lastDay = ''
      rules.forEach(function (rule) {
        var day = chatDayKey(rule.ts)
        if (day !== lastDay) {
          seq.push({ type: 'day', key: 'day-' + day, day: day })
          lastDay = day
        }
        seq.push({ type: 'msg', key: rule.id, rule: rule })
      })

      var chatColumn = h(
        'div',
        { style: chatStyles.chatColumn },
        h(
          'div',
          { ref: bodyRef, style: chatStyles.chatBody },
          seq.length === 0
            ? h(EmptyHint, null, '群里还没有消息。可以在下面发一条，或在会话里发交接/请求。')
            : seq.map(function (item) {
                if (item.type === 'day') return h('div', { key: item.key, style: chatStyles.day }, chatDayLabel(item.day))
                return h(ChatBubble, { key: item.key, rule: item.rule, index: index, run: props.run })
              })
        ),
        h(
          'div',
          { style: chatStyles.mentionBar },
          h(
            Btn,
            {
              variant: mentions.indexOf('all') >= 0 ? 'primary' : 'ghost',
              'aria-label': '@所有人',
              onClick: toggleAll
            },
            '@所有人'
          ),
          members.map(function (member) {
            return h(
              Btn,
              {
                key: 'mention-' + member.id,
                variant: mentions.indexOf(member.id) >= 0 ? 'primary' : undefined,
                'aria-label': '@' + asString(member.title),
                title: asString(member.title),
                onClick: function () {
                  toggleMember(member.id)
                }
              },
              '@' + asString(member.title).slice(0, 8)
            )
          }),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' } },
            h('span', { style: mergeStyle(styles.rowMuted, { flex: 'none', fontSize: 10.5 }) }, '组长：'),
            h(RawSelect, {
              small: true,
              value: coordinatorId,
              options: [{ value: '', label: '自动选' }].concat(
                members
                  .filter(function (member) {
                    return mentions.indexOf('all') >= 0 || mentions.indexOf(member.id) >= 0
                  })
                  .map(function (member) {
                    return { value: member.id, label: asString(member.title).slice(0, 12) }
                  })
              ),
              onChange: function (event) {
                setCoordinatorId(event && event.target ? event.target.value : '')
              }
            })
          )
        ),
        h(
          'div',
          { style: chatStyles.inputBar },
          h(RawInput, {
            multiline: true,
            value: draft,
            placeholder: urgent
              ? '⚡ 加急：先点 @ 选目标成员，再写要立刻处理的内容…'
              : mentions.length > 0
                ? '@' +
                  mentions
                    .map(function (item) {
                      if (item === 'all') return '所有人'
                      var session = index.sessionById[item]
                      return session ? asString(session.title).slice(0, 8) : shortId(item)
                    })
                    .join('、') +
                  '：输入工作内容…'
                : '发消息到群里；点 @ 选择要唤醒的成员或所有人',
            style: { flex: 1, minWidth: 0, boxSizing: 'border-box' },
            onChange: function (event) {
              setDraft(event && event.target ? event.target.value : '')
            }
          }),
          h(
            Btn,
            {
              variant: urgent ? 'danger' : 'ghost',
              disabled: props.busy,
              title: urgent
                ? '加急模式已开启：发送会立即唤醒/插话被 @ 的成员（60 秒内同一成员限 1 条）'
                : '开启加急：先 @ 目标成员再发送，立即唤醒；running 会先尝试打断',
              onClick: function () {
                setUrgent(!urgent)
                setNotice(
                  urgent
                    ? ''
                    : '⚡ 加急模式：先 @ 目标成员再发送；目标 running 会先尝试打断，宿主不支持时会明确降级为插话'
                )
              }
            },
            urgent ? '⚡ 加急 ON' : '⚡ 加急'
          ),
          h(
            Btn,
            {
              variant: 'ghost',
              disabled: props.busy || draft.trim() === '',
              title: '把输入框内容作为讨论主题，唤醒群成员聊两句（不是任务）',
              onClick: function () {
                var topic = draft.trim()
                if (topic === '' || props.busy) return
                props.run('group.discuss', { id: group.id, topic: topic }).then(function (okResult) {
                  if (okResult) setDraft('')
                })
              }
            },
            '发起讨论'
          ),
          h(Btn, { variant: 'primary', disabled: props.busy || draft.trim() === '', onClick: send }, '发送')
        ),
        notice !== ''
          ? h(
              'div',
              {
                style: mergeStyle(
                  chatStyles.urgentNotice,
                  notice.indexOf('失败') >= 0 || notice.indexOf('⚠') >= 0
                    ? { color: 'var(--dsw-alias-state-error-primary)' }
                    : null
                )
              },
              notice
            )
          : null,
        h(
          'div',
          { style: mergeStyle(styles.rowMuted, { padding: '2px 0 4px', textAlign: 'center', fontSize: 10.5 }) },
          mentions.length > 0
            ? '发送后会立即唤醒被 @ 的在线成员；离线成员下次运行被注入。'
            : '不 @ 时只是群消息，成员下一轮自动看到，不会立即唤醒。'
        )
      )

      return h(
        'div',
        { style: chatStyles.chatRoot },
        h(
          'div',
          { style: chatStyles.chatHead },
          h(
            'button',
            { type: 'button', title: '返回群列表', onClick: props.onBack, style: chatStyles.backBtn },
            '‹'
          ),
          h(ChatAvatar, { label: group.name, color: chatColorFor(group.name) }),
          h(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            h(
              'div',
              { style: styles.rowLine },
              h('span', { style: mergeStyle(styles.rowTitle, { flex: 1 }) }, group.name),
              group.kind === 'bugfix' ? h(Badge, { tone: 'warn', title: '维护者的修bug群：只收 BUG 报告，不派普通任务' }, '修bug群') : null,
              h('span', { style: mergeStyle(styles.rowMuted, { flex: 'none' }) }, members.length + ' 人')
            ),
            h(
              'div',
              { style: mergeStyle(styles.rowMuted, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) },
              (group.goal ? '目标：' + group.goal : '未设置群目标') +
                ' · 群管理：' +
                (group.managerSessionId && index.sessionById[group.managerSessionId]
                  ? index.sessionById[group.managerSessionId].title
                  : '未设置')
            )
          ),
          h(
            Btn,
            {
              variant: 'ghost',
              onClick: function () {
                setSettings(!settings)
              }
            },
            settings ? '返回聊天' : '设置'
          )
        ),
        settings
          ? h('div', { style: chatStyles.settings }, h(GroupCard, { group: group, index: index, run: props.run, busy: props.busy, defaultExpanded: true }))
          : chatColumn
      )
    }
    //#endregion

    function GroupsSection(props) {
      var state = props.state
      var index = props.index
      var showFormState = React.useState(false)
      var showForm = showFormState[0]
      var setShowForm = showFormState[1]
      var smartState = React.useState(null) // null=未展开；{loading,error,suggestions}
      var smart = smartState[0]
      var setSmart = smartState[1]
      var selectedState = React.useState('')
      var selectedId = selectedState[0]
      var setSelectedId = selectedState[1]
      var groups = asArray(state.groups)
      var selectedGroup = null
      for (var groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        if (groups[groupIndex].id === selectedId) {
          selectedGroup = groups[groupIndex]
          break
        }
      }

      function openSmart() {
        setSmart({ loading: true, error: '', suggestions: [] })
        fetchSuggestions().then(
          function (list) {
            setSmart({ loading: false, error: '', suggestions: asArray(list) })
          },
          function (failure) {
            setSmart({ loading: false, error: errorMessage(failure), suggestions: [] })
          }
        )
      }
      function createFromSuggestion(suggestion) {
        if (!suggestion) return
        var payload = {
          name: asString(suggestion.name),
          workspace: asString(suggestion.workspace),
          sessionIds: asArray(suggestion.sessionIds)
        }
        Promise.resolve(props.run('group.create', payload)).then(function (ok) {
          if (!ok) return
          var current = smart
          if (!current) return
          setSmart({
            loading: false,
            error: '',
            suggestions: asArray(current.suggestions).filter(function (item) {
              return item && item.id !== suggestion.id
            })
          })
        })
      }
      function createAll() {
        var pending = asArray(smart && smart.suggestions).slice()
        if (!pending.length) return
        function step() {
          var next = pending.shift()
          if (!next) {
            setSmart(null)
            return
          }
          var payload = {
            name: asString(next.name),
            workspace: asString(next.workspace),
            sessionIds: asArray(next.sessionIds)
          }
          Promise.resolve(props.run('group.create', payload)).then(function () {
            step()
          }, function () {
            step()
          })
        }
        step()
      }
      function renderSmart() {
        if (!smart) return null
        var body
        if (smart.loading) {
          body = h(EmptyHint, null, '正在分析既有主会话的共同特征…')
        } else if (smart.error) {
          body = h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11.5, padding: '4px 0' } }, smart.error)
        } else if (!smart.suggestions.length) {
          body = h(EmptyHint, null, '没有找到可自动成组的未分组主会话（已在群里的会话不参与建议）。')
        } else {
          body = smart.suggestions.map(function (suggestion) {
            var sampleTitles = asArray(suggestion.sessions)
              .slice(0, 3)
              .map(function (session) {
                return asString(session.title)
              })
              .filter(function (title) {
                return title !== ''
              })
              .join('、')
            var more = asArray(suggestion.sessionIds).length > 3 ? ' 等' : ''
            return h(
              'div',
              { key: 'smart-' + asString(suggestion.id), style: mergeStyle(styles.card, { marginBottom: 8 }) },
              h(
                'div',
                { style: styles.cardHead },
                h('span', { style: mergeStyle(styles.cardTitle, { flex: 1, minWidth: 0 }) }, asString(suggestion.name)),
                h(
                  Btn,
                  {
                    variant: 'primary',
                    disabled: props.busy,
                    onClick: function () {
                      createFromSuggestion(suggestion)
                    }
                  },
                  '创建'
                )
              ),
              h(
                'div',
                { style: styles.rowMuted },
                asString(suggestion.reason) + ' · ' + asArray(suggestion.sessionIds).length + ' 个主会话'
              ),
              sampleTitles !== ''
                ? h('div', { style: mergeStyle(styles.rowMuted, { marginTop: 2 }) }, sampleTitles + more)
                : null
            )
          })
        }
        return h(
          'div',
          { style: mergeStyle(styles.form, { marginBottom: 8 }) },
          h(
            'div',
            { style: styles.rowLine },
            h('span', { style: styles.formTitle }, '智能成组建议'),
            h('span', { style: styles.spacer }),
            !smart.loading && !smart.error && smart.suggestions.length > 1
              ? h(
                  Btn,
                  {
                    disabled: props.busy,
                    onClick: createAll
                  },
                  '全部创建'
                )
              : null,
            h(
              Btn,
              {
                variant: 'ghost',
                onClick: function () {
                  setSmart(null)
                }
              },
              '收起'
            )
          ),
          body
        )
      }

      // 点进某个群：整个「群组」页变成微信式群聊窗口（返回键回列表）。
      if (selectedGroup) {
        return h(GroupChat, {
          group: selectedGroup,
          index: index,
          run: props.run,
          busy: props.busy,
          onRefresh: props.onRefresh,
          onBack: function () {
            setSelectedId('')
          }
        })
      }

      return h(
        'div',
        null,
        h(
          'div',
          { style: mergeStyle(styles.rowLine, { marginBottom: 8 }) },
          h('span', { style: { fontSize: 12, fontWeight: 600 } }, '群聊 ' + groups.length),
          h('span', { style: styles.spacer }),
          h(
            Btn,
            {
              variant: smart ? undefined : 'ghost',
              onClick: function () {
                if (smart) {
                  setSmart(null)
                } else {
                  openSmart()
                }
              }
            },
            smart ? '收起智能建议' : '智能成组'
          ),
          h(
            Btn,
            {
              variant: 'ghost',
              title: '一键创建/复用「星桥 · 修bug」群：维护者为群管理，普通成员把 BUG 报告投递到该群，维护者不再接普通任务',
              disabled: props.busy || !(state && state.capabilities && state.capabilities.bugfixGroup),
              onClick: function () {
                Promise.resolve(props.run('bugfix.ensure', {}))
              }
            },
            state && state.bugfix && state.bugfix.exists ? '🛡️ 修bug群' : '🛡️ 建修bug群'
          ),
          h(
            Btn,
            {
              variant: showForm ? undefined : 'primary',
              onClick: function () {
                setShowForm(!showForm)
              }
            },
            showForm ? '收起表单' : '+ 新建群组'
          )
        ),
        renderSmart(),
        showForm
          ? h(CreateGroupForm, {
              sessions: index.sessions,
              busy: props.busy,
              run: props.run,
              onDone: function () {
                setShowForm(false)
              },
              onCancel: function () {
                setShowForm(false)
              }
            })
          : null,
        groups.length === 0
          ? h(EmptyHint, null, '暂无群组。可以点「智能成组」按共同话题自动建组（支持跨工作目录），或者手动新建。')
          : groups.map(function (group) {
              return h(GroupChatRow, {
                key: 'chat-' + group.id,
                group: group,
                index: index,
                onOpen: setSelectedId
              })
            })
      )
    }
    //#endregion

    //#region 会话页
    function SessionRow(props) {
      var session = props.session
      var groups = asArray(props.groups)
      var allGroups = asArray(props.allGroups)
      var run = props.run
      var busy = props.busy
      var joinState = React.useState('')
      var joinValue = joinState[0]
      var setJoinValue = joinState[1]
      var live = session.live === true
      var running = session.status === 'running'
      var joinable = allGroups.filter(function (group) {
        return group.sessionIds.indexOf(session.id) < 0
      })
      var joinOptions = [{ value: '', label: joinable.length === 0 ? '已加入所有群组' : '加入群组…' }].concat(
        joinable.map(function (group) {
          return { value: group.id, label: group.name }
        })
      )
      var cwdLabel = cwdTail(session.cwd)
      return h(
        'div',
        { style: styles.sessionRow },
        h(
          'div',
          { style: styles.rowLine },
          h('span', { style: mergeStyle(styles.dot, running ? styles.dotRunning : live ? styles.dotLive : styles.dotIdle) }),
          h('span', { style: mergeStyle(styles.rowTitle, { flex: 1 }) }, session.title),
          h(
            Badge,
            {
              tone: session.availability === 'busy' ? 'warn' : 'success',
              title:
                session.availability === 'busy'
                  ? '忙碌：' + ((session.currentTask && session.currentTask.title) || '有未回答请求/未完成任务')
                  : '空闲：可以接新任务'
            },
            session.availability === 'busy' ? '忙' : '空闲'
          ),
          h(
            Badge,
            { tone: running ? 'business' : live ? 'success' : 'neutral' },
            running ? '运行中' : live ? '在线' : '离线'
          ),
          session.protected
            ? h(
                Badge,
                { tone: 'warn', title: '维护者 protected/service：不接普通任务，只能通过显式 @ 或修bug群投递 bug' },
                '维护者·服务'
              )
            : null,
          session.hasProfile
            ? h(Badge, { tone: 'success' }, '已申报')
            : session.profileDeclined
              ? h(Badge, { tone: 'neutral' }, '未申报')
              : h(Badge, { tone: 'warn' }, '待申报')
        ),
        h(
          'div',
          { style: styles.rowLine },
          h('span', {
            key: 'contact-' + session.id,
            title: 'contactId：点击复制（可直接用作 session_ask 的 to）',
            onClick: function () {
              copyContactId(session.contactId || contactIdOf(session.id))
            },
            style: mergeStyle(styles.rowMuted, {
              flex: 'none',
              cursor: 'pointer',
              fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace'
            })
          }, session.contactId || contactIdOf(session.id)),
          h('span', { style: mergeStyle(styles.rowMuted, { flex: 1 }), title: session.cwd || '' }, cwdLabel || '（未知工作区）')
        ),
        props.profile && props.profile.summary
          ? h(
              'div',
              { style: mergeStyle(styles.rowMuted, { marginTop: 2 }), title: props.profile.summary },
              '申报：' + asString(props.profile.summary).slice(0, 90)
            )
          : null,
        session.availability === 'busy' && session.currentTask
          ? h(
              'div',
              {
                style: mergeStyle(styles.rowMuted, { marginTop: 2 }),
                title: asString(session.currentTask.title)
              },
              '忙碌中：' + asString(session.currentTask.title).slice(0, 60) +
                (session.currentTask.since ? ' · ' + formatLocalTime(session.currentTask.since) : '')
            )
          : null,
        groups.length > 0
          ? h(
              'div',
              { style: mergeStyle(styles.rowLine, { flexWrap: 'wrap', gap: 4 }) },
              groups.map(function (group) {
                return h(Badge, { key: 'session-group-' + group.id, tone: 'brand' }, group.name)
              })
            )
          : h('div', { style: styles.rowMuted }, '未加入任何群组'),
        h(
          'div',
          { style: styles.rowLine },
          h(RawSelect, {
            small: true,
            value: joinValue,
            options: joinOptions,
            disabled: joinable.length === 0 || busy,
            ariaLabel: '加入群组',
            style: { flex: 1, minWidth: 0 },
            onChange: function (event) {
              var groupId = event && event.target ? event.target.value : ''
              setJoinValue('')
              if (groupId === '') return
              run('group.add', { id: groupId, sessionIds: [session.id] })
            }
          }),
          running
            ? h(
                Btn,
                {
                  variant: 'danger',
                  disabled: busy,
                  title: '打断这一轮（不删会话、不丢历史；宿主不支持时会明确提示）',
                  onClick: function () {
                    run('agent.interrupt', { sessionId: session.id }, '已打断「' + asString(session.title).slice(0, 20) + '」')
                  }
                },
                '打断'
              )
            : null
        )
      )
    }

    function SessionsSection(props) {
      var state = props.state
      var index = props.index
      var sessions = asArray(state.sessions)
      return h(
        'div',
        null,
        h(
          'div',
          { style: mergeStyle(styles.rowLine, { marginBottom: 8 }) },
          h('span', { style: { fontSize: 12, fontWeight: 600 } }, '会话 ' + sessions.length),
          h('span', { style: styles.spacer })
        ),
        h('div', { style: mergeStyle(styles.rowMuted, { marginBottom: 8 }) }, '只显示主会话（lead）；子代理/团队成员不进群，由各自 lead 接收规矩后自行交接。'),
        sessions.length === 0
          ? h(EmptyHint, null, '当前没有可见会话。')
          : sessions.map(function (session) {
              return h(SessionRow, {
                key: 'session-' + session.id,
                session: session,
                profile: index.profilesBySession[session.id],
                groups: asArray(index.groupsBySession[session.id]),
                allGroups: index.groups,
                run: props.run,
                busy: props.busy
              })
            })
      )
    }
    //#endregion

    //#region 设置页（路由模型 / 注入 / 申报提示）
    function SettingsSection(props) {
      var state = props.state || EMPTY_STATE_FOR_RENDER
      var config = state.config || {}
      var providerState = React.useState(config.provider || '')
      var provider = providerState[0]
      var setProvider = providerState[1]
      var modelState = React.useState(config.model || '')
      var model = modelState[0]
      var setModel = modelState[1]
      var injectState = React.useState(config.injectMode || 'targeted')
      var injectMode = injectState[0]
      var setInjectMode = injectState[1]
      var promptState = React.useState(config.autoPrompt !== false)
      var autoPrompt = promptState[0]
      var setAutoPrompt = promptState[1]
      var createState = React.useState(config.askOnCreate !== false)
      var askOnCreate = createState[0]
      var setAskOnCreate = createState[1]
      var captureState = React.useState(config.autoCapture !== false)
      var autoCapture = captureState[0]
      var setAutoCapture = captureState[1]
      var savedState = React.useState('')
      var saved = savedState[0]
      var setSaved = savedState[1]

      function save() {
        setSaved('')
        props
          .run('config.update', {
            patch: {
              router: { provider: provider.trim(), model: model.trim() },
              injectMode: injectMode,
              autoPrompt: autoPrompt,
              askOnCreate: askOnCreate,
              autoCapture: autoCapture
            }
          })
          .then(function (okResult) {
            setSaved(okResult ? '已保存，立即生效' : '保存失败')
          })
      }

      function toggle(label, value, onChange) {
        return h(
          Btn,
          {
            variant: value ? 'primary' : 'ghost',
            onClick: function () {
              onChange(!value)
            }
          },
          label + (value ? '：开' : '：关')
        )
      }

      return h(
        'div',
        { style: styles.form },
        h('div', { style: styles.formTitle }, '经验桥设置'),
        h(
          'div',
          { style: mergeStyle(styles.rowMuted, { marginBottom: 8 }) },
          '全部在这里改，不用去翻配置文件；保存后写入 settings.json，重启仍生效。'
        ),
        h('div', { style: styles.formTitle, marginTop: 4 }, '世界任务路由模型'),
        h(
          'div',
          { style: mergeStyle(styles.rowMuted, { marginBottom: 4 }) },
          '决定任务交给哪个会话、是否新建会话/工作区。可填任意已配置的免费模型。'
        ),
        h(
          'div',
          { style: styles.rowLine },
          h('span', { style: { flex: 'none', minWidth: 60, fontSize: 11 } }, 'provider'),
          h(RawInput, {
            value: provider,
            placeholder: '留空则用当前默认模型（如 opencode-go）',
            style: { flex: 1, minWidth: 0 },
            onChange: function (event) {
              setProvider(event && event.target ? event.target.value : '')
            }
          })
        ),
        h(
          'div',
          { style: styles.rowLine },
          h('span', { style: { flex: 'none', minWidth: 60, fontSize: 11 } }, 'model'),
          h(RawInput, {
            value: model,
            placeholder: '留空则用当前默认模型（如 deepseek-v4.1-flash）',
            style: { flex: 1, minWidth: 0 },
            onChange: function (event) {
              setModel(event && event.target ? event.target.value : '')
            }
          })
        ),
        h('div', { style: styles.formTitle, marginTop: 10 }, '注入与提示'),
        h(
          'div',
          { style: styles.rowLine },
          h('span', { style: mergeStyle(styles.rowMuted, { flex: 1 }) }, '上下文注入'),
          h(RawSelect, {
            small: true,
            value: injectMode,
            options: [
              { value: 'targeted', label: '按需（只注入与本人相关）' },
              { value: 'broadcast', label: '广播（所有规矩都注入）' }
            ],
            onChange: function (event) {
              setInjectMode(event && event.target ? event.target.value : 'targeted')
            }
          })
        ),
        h(
          'div',
          { style: styles.rowLine },
          h('span', { style: mergeStyle(styles.rowMuted, { flex: 1 }) }, '未申报时提示一句'),
          toggle('未申报提示', autoPrompt, setAutoPrompt)
        ),
        h(
          'div',
          { style: styles.rowLine },
          h('span', { style: mergeStyle(styles.rowMuted, { flex: 1 }) }, '新会话主动询问是否注册'),
          toggle('新会话询问', askOnCreate, setAskOnCreate)
        ),
        h(
          'div',
          { style: styles.rowLine },
          h('span', { style: mergeStyle(styles.rowMuted, { flex: 1 }) }, '自动捕获「告诉其他会话」'),
          toggle('自动捕获', autoCapture, setAutoCapture)
        ),
        h(
          'div',
          { style: mergeStyle(styles.actionsRow, { marginTop: 10 }) },
          h(Btn, { variant: 'primary', disabled: props.busy, onClick: save }, '保存设置'),
          saved !== '' ? h('span', { style: styles.rowMuted }, saved) : null
        ),
        h('div', { style: mergeStyle(styles.rowMuted, { marginTop: 12, wordBreak: 'break-all' }) }, '数据目录：' + (config.boardDir || '—'))
      )
    }
    //#endregion

    //#region 世界聊天（用户发任务；先匹配申报成员，没有匹配则新建会话）
    /** 长文本默认只显示概要，点一下展开（消息界面更清爽）。 */
    function SummaryText(props) {
      var expandedState = React.useState(false)
      var expanded = expandedState[0]
      var setExpanded = expandedState[1]
      var text = asString(props.text)
      var limit = asNumber(props.limit, 120)
      var long = text.length > limit
      var shown = expanded || !long ? text : text.slice(0, limit) + '…'
      return h(
        'span',
        {
          onClick: function () {
            if (long) setExpanded(!expanded)
          },
          style: { cursor: long ? 'pointer' : 'default' }
        },
        h('span', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, shown),
        long
          ? h(
              'span',
              { style: { color: 'var(--dsw-alias-brand-primary)', marginLeft: 4, fontSize: 10.5 } },
              expanded ? '收起' : '展开'
            )
          : null
      )
    }

    function WorldBubble(props) {
      var rule = props.rule
      var index = props.index
      var run = props.run
      var self = rule.author === 'panel' || rule.origin === 'panel'
      var session = index.sessionById[rule.author]
      var name = self ? '我（用户）' : session ? session.title : shortId(rule.author)
      var kindLabel = KIND_LABELS[displayKindOf(rule)] || '经验'
      return h(
        'div',
        { style: { display: 'flex', gap: 6, marginBottom: 10, flexDirection: self ? 'row-reverse' : 'row' } },
        h(ChatAvatar, { label: name, color: chatColorFor(rule.author) }),
        h(
          'div',
          { style: { maxWidth: '82%', minWidth: 0 } },
          h(
            'div',
            {
              style: mergeStyle(styles.rowMuted, {
                fontSize: 10.5,
                marginBottom: 2,
                textAlign: self ? 'right' : 'left'
              })
            },
            name + (self ? '' : ' · ' + chatClock(rule.ts))
          ),
          h(
            'div',
            {
              style: mergeStyle(
                self ? chatStyles.bubbleSelf : chatStyles.bubbleOther,
                rule.urgent ? chatStyles.bubbleUrgent : null
              )
            },
            h(
              'div',
              { style: { display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2, flexWrap: 'wrap' } },
              rule.urgent ? h(Badge, { tone: 'error' }, '⚡ 加急') : null,
              h(Badge, { tone: KIND_TONE[displayKindOf(rule)] || 'neutral' }, kindLabel),
              h(
                'button',
                {
                  type: 'button',
                  title: '撤回这条世界消息（任务会同时取消关联请求与待复核）',
                  onClick: function (event) {
                    if (event && event.stopPropagation) event.stopPropagation()
                    if (run) run('entry.retract', { id: rule.id }, '已撤回「' + asString(rule.title).slice(0, 20) + '」')
                  },
                  style: chatStyles.retractBtn
                },
                '撤回'
              )
            ),
            h('div', { style: { fontWeight: 600, wordBreak: 'break-word' } }, rule.title),
            rule.text !== ''
              ? h('div', { style: { marginTop: 2 } }, h(SummaryText, { text: rule.text, limit: 140 }))
              : null,
            rule.files.length > 0
              ? h(
                  'div',
                  { style: chatStyles.fileBox },
                  h('div', { style: mergeStyle(styles.rowMuted, { fontSize: 10.5 }) }, '📎 文件'),
                  rule.files.map(function (file, fileIndex) {
                    return h(
                      'div',
                      { key: 'world-file-' + fileIndex, style: { wordBreak: 'break-all', fontSize: 11 } },
                      file
                    )
                  })
                )
              : null,
            rule.mentions.length > 0
              ? h(
                  'div',
                  { style: mergeStyle(styles.rowMuted, { fontSize: 10.5, marginTop: 2 }) },
                  '🔔 @ ' +
                    rule.mentions
                      .map(function (sessionId) {
                        var member = index.sessionById[sessionId]
                        return member ? member.title : shortId(sessionId)
                      })
                      .join('、')
                )
              : null
          )
        )
      )
    }

    function WorldSection(props) {
      var state = props.state
      var index = props.index
      var rules = asArray(state.world)
      var profiles = state.profiles || {}
      var members = asArray(index.sessions).filter(function (session) {
        return profiles[session.id] && profiles[session.id].summary
      })
      var draftState = React.useState('')
      var draft = draftState[0]
      var setDraft = draftState[1]
      var resultState = React.useState(null)
      var result = resultState[0]
      var setResult = resultState[1]
      var directoryState = React.useState(false)
      var directoryOpen = directoryState[0]
      var setDirectoryOpen = directoryState[1]
      var boardState = React.useState(false)
      var boardOpen = boardState[0]
      var setBoardOpen = boardState[1]
      var bodyRef = React.useRef(null)
      var sendingState = React.useState(false)
      var sending = sendingState[0]
      var setSending = sendingState[1]
      var pendingState = React.useState([])
      var pending = pendingState[0]
      var setPending = pendingState[1]

      React.useEffect(
        function () {
          var el = bodyRef.current
          if (!el) return
          var toBottom = function () {
            el.scrollTop = el.scrollHeight
          }
          toBottom()
          var timer = setTimeout(toBottom, 80)
          var timer2 = setTimeout(toBottom, 320)
          return function () {
            clearTimeout(timer)
            clearTimeout(timer2)
          }
        },
        [rules.length, pending.length]
      )

      function send() {
        var text = draft.trim()
        if (text === '' || props.busy || sending) return
        // 先清空输入框并把消息塞进聊天流（乐观显示），避免路由期间重复点击发送。
        var pendingId = 'pending-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
        setDraft('')
        setSending(true)
        setPending(function (prev) {
          return prev.concat([{ id: pendingId, text: text }])
        })
        setResult({ loading: true })
        postCommandRaw('world.post', { text: text }).then(
          function (payload) {
            setPending(function (prev) {
              return prev.filter(function (item) {
                return item.id !== pendingId
              })
            })
            setSending(false)
            setResult({
              loading: false,
              duplicate: payload.duplicate === true,
              existing: payload.existing && typeof payload.existing === 'object' ? payload.existing : null,
              owner: asString(payload.owner),
              taskId: asString(payload.taskId),
              assigned: asArray(payload.assigned),
              createdSession: asString(payload.createdSession),
              createdSessionTitle: asString(payload.createdSessionTitle),
              createdWorkspace: asString(payload.createdWorkspace),
              createError: asString(payload.createError),
              woken: asNumber(payload.woken, 0),
              route: asString(payload.route),
              forceNew: payload.forceNew === true,
              router: payload.router && typeof payload.router === 'object' ? payload.router : null
            })
            if (typeof props.onRefresh === 'function') props.onRefresh()
          },
          function (failure) {
            setPending(function (prev) {
              return prev.filter(function (item) {
                return item.id !== pendingId
              })
            })
            setSending(false)
            setResult({ loading: false, error: errorMessage(failure) })
          }
        )
      }

      var resultLine = null
      if (result && result.error) {
        resultLine = h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 } }, result.error)
      } else if (result && !result.loading) {
        var assignedTitles = asArray(result.assigned)
          .map(function (item) {
            return asString(item.title)
          })
          .filter(function (title) {
            return title !== ''
          })
        var routerText =
          result.router && result.router.engine
            ? '［' + (result.router.engine === 'llm' ? '模型路由' : '关键词兜底') + '］' + (result.router.reason || '')
            : ''
        resultLine = h(
          'div',
          { style: mergeStyle(styles.rowMuted, { fontSize: 11 }) },
          result.duplicate
            ? '⚠ 24h 内已有同类任务，已合并到 existing task id=' +
              ((result.existing && result.existing.taskId) || result.taskId || '').slice(0, 14) +
              '…，owner=' +
              (result.owner || (result.existing && result.existing.owner) || '（未指定）') +
              '；本次未再建群/任务'
            : routerText,
          h('br'),
          result.duplicate
            ? '如确认是新任务，请加「新一轮/全新」或 forceNew=true 重新发布。'
            : result.createdWorkspace
              ? '已新建工作区：' + result.createdWorkspace + '；并新建会话派发任务'
              : result.createdSession
                ? '已新建会话' + (result.createdSessionTitle ? '「' + result.createdSessionTitle + '」' : '') + '并把任务派发过去'
                : assignedTitles.length
                  ? '已派给：' + assignedTitles.join('、') + (result.woken ? '（已唤醒）' : '（离线，下次运行处理）')
                  : '已发布到世界' + (result.createError ? '；新建失败：' + result.createError : '')
        )
      }

      return h(
        'div',
        { style: chatStyles.chatRoot },
        h(
          'div',
          { style: chatStyles.chatHead },
          h(ChatAvatar, { label: '世界', color: chatColorFor('world') }),
          h(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            h(
              'div',
              { style: styles.rowLine },
              h('span', { style: mergeStyle(styles.rowTitle, { flex: 1 }) }, '世界聊天'),
              h('span', { style: styles.rowMuted }, members.length + ' 位成员已申报')
            ),
            h(
              'div',
              { style: mergeStyle(styles.rowMuted, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) },
              '发布任务：先按申报匹配成员，匹配不到会自动新建会话'
            )
          ),
          h(
            Btn,
            {
              variant: boardOpen ? 'primary' : 'ghost',
              onClick: function () {
                setBoardOpen(!boardOpen)
              }
            },
            '🏆 积分榜'
          ),
          h(
            Btn,
            {
              variant: 'ghost',
              onClick: function () {
                setDirectoryOpen(!directoryOpen)
              }
            },
            directoryOpen ? '收起成员' : '成员'
          )
        ),
        boardOpen
          ? h(
              'div',
              { style: chatStyles.settings },
              (state.reputation || []).length === 0
                ? h(EmptyHint, null, '还没有积分记录：完成任务、被点赞会获得积分。')
                : asArray(state.reputation).slice(0, 12).map(function (item, rankIndex) {
                    return h(
                      'div',
                      { key: 'rep-' + item.sessionId, style: styles.groupMemberRow },
                      h('span', { style: { flex: 'none', width: 24, textAlign: 'center', fontWeight: 600 } }, '#' + (rankIndex + 1)),
                      h('span', { style: { flex: 'none', fontSize: 16 } }, (index.sessionById[item.sessionId] && index.sessionById[item.sessionId].avatar) || '👤'),
                      h(
                        'div',
                        { style: { flex: 1, minWidth: 0 } },
                        h(
                          'div',
                          { style: styles.rowTitle },
                          item.title + (item.closed ? '（已关闭）' : '') ,
                          ' ',
                          h('span', { style: mergeStyle(styles.rowMuted, { fontSize: 10.5 }) }, '@' + ((index.sessionById[item.sessionId] && index.sessionById[item.sessionId].handle) || ''))
                        ),
                        h(
                          'div',
                          { style: mergeStyle(styles.rowMuted, { fontSize: 10.5 }) },
                          '成功 ' + item.successes + ' · 失败 ' + item.failures
                        )
                      ),
                      h('span', { style: { flex: 'none', fontWeight: 600 } }, (item.points >= 0 ? '+' : '') + item.points)
                    )
                  })
            )
          : directoryOpen
          ? h(
              'div',
              { style: chatStyles.settings },
              members.length === 0
                ? h(EmptyHint, null, '还没有会话申报。可以先去群组里拉人，或在会话里说「申报一下经验桥」。')
                : members.map(function (member) {
                    var profile = profiles[member.id]
                    return h(
                      'div',
                      { key: 'world-member-' + member.id, style: styles.groupMemberRow },
                      h(ChatAvatar, { label: member.title, color: chatColorFor(member.id) }),
                      h(
                        'div',
                        { style: { flex: 1, minWidth: 0 } },
                        h('div', { style: styles.rowTitle }, member.title),
                        h(
                          'div',
                          { style: mergeStyle(styles.rowMuted, { fontSize: 10.5 }) },
                          h(SummaryText, { text: asString(profile && profile.summary), limit: 80 })
                        ),
                        profile && profile.assets && profile.assets.length
                          ? h(
                              'div',
                              { style: mergeStyle(styles.rowMuted, { fontSize: 10.5 }) },
                              '资产：' + profile.assets.join('、')
                            )
                          : null
                      )
                    )
                  })
            )
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { ref: bodyRef, style: chatStyles.chatBody },
                asArray(state.duplicates).length > 0
                  ? h(
                      'div',
                      {
                        style: {
                          margin: '6px 0 10px',
                          padding: '6px 8px',
                          border: '1px solid rgba(255,193,7,.45)',
                          borderRadius: 6,
                          background: 'rgba(255,193,7,.08)',
                          fontSize: 11,
                          lineHeight: 1.5
                        }
                      },
                      '⚠ 发现 ' +
                        state.duplicates.length +
                        ' 组疑似重复任务：' +
                        state.duplicates
                          .slice(0, 3)
                          .map(function (group) {
                            return (
                              (group.primary.title || shortId(group.primary.id)) +
                              (group.primary.owner ? '（owner ' + shortId(group.primary.owner) + '）' : '')
                            )
                          })
                          .join('、') +
                        '。已阻止重复建群/任务；可在任务详情或用 task.dedupe 查看合并建议。'
                    )
                  : null,
                rules.length === 0
                  ? h(EmptyHint, null, '世界里还没有任务。把要做的事写在下面发出来：有对应申报的成员就派给他，没有就自动新建会话。')
                  : rules.map(function (rule) {
                      return h(WorldBubble, { key: rule.id, rule: rule, index: index, run: props.run })
                    }),
                pending.map(function (item) {
                  return h(
                    'div',
                    { key: item.id, style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 10 } },
                    h(
                      'div',
                      { style: mergeStyle(chatStyles.bubbleSelf, { opacity: 0.8 }) },
                      h('div', { style: { fontSize: 10.5, marginBottom: 2, textAlign: 'right' } }, '我（用户）· 发送中…'),
                      h('div', { style: { fontWeight: 600, wordBreak: 'break-word' } }, item.text.slice(0, 60)),
                      item.text.length > 60 ? h('div', { style: { fontSize: 11, marginTop: 2 } }, item.text.slice(60, 240)) : null,
                      h('div', { style: { fontSize: 10.5, marginTop: 4 } }, '路由中（消息已先显示，完成后更新状态）')
                    )
                  )
                })
              ),
              resultLine,
              h(
                'div',
                { style: chatStyles.inputBar },
                h(RawInput, {
                  multiline: true,
                  value: draft,
                  placeholder: '发布新任务到世界…（例：把中期报告的路线图重画成学术风格）',
                  style: { flex: 1, minWidth: 0, boxSizing: 'border-box' },
                  onChange: function (event) {
                    setDraft(event && event.target ? event.target.value : '')
                  }
                }),
                h(
                  Btn,
                  { variant: 'primary', disabled: props.busy || sending || draft.trim() === '', onClick: send },
                  sending ? '发送中…' : '发布'
                )
              ),
              h(
                'div',
                { style: mergeStyle(styles.rowMuted, { padding: '2px 0 4px', textAlign: 'center', fontSize: 10.5 }) },
                '会先看谁申报过对应方向；匹配不到才新建会话。'
              )
            )
      )
    }
    //#endregion

    //#region 4.0 指挥中心（右侧栏常驻摘要 + 收起式收件箱）
    var APP_URL = '/session-bridge/app'
    var APP_WINDOW_NAME = 'nebula-bridge'
    var APP_WINDOW_FEATURES = 'width=1280,height=860'
    var bridgeWindowRef = null
    function focusBridgeWindow(win) {
      if (!win) return
      try { win.focus() } catch (error) { /* ignore */ }
      try { win.postMessage({ type: 'session-bridge:focus' }, window.location.origin) } catch (error) { /* ignore */ }
      try { window.setTimeout(function () { try { win.focus() } catch (e) {} }, 80) } catch (error) { /* ignore */ }
      try { window.setTimeout(function () { try { win.focus() } catch (e) {} }, 260) } catch (error) { /* ignore */ }
    }

    function clipText(value, max) {
      var s = asString(value)
      if (!max || s.length <= max) return s
      return s.slice(0, max).replace(/\s+$/, '') + '…'
    }

    function inboxKindIcon(kind) {
      var k = asString(kind)
      if (k === 'approval') return '🛡️'
      if (k === 'approval-timeout') return '⏰'
      if (k === 'urgent-request') return '⚡'
      if (k === 'lease-wait') return '🖥️'
      if (k === 'request') return '📨'
      if (k === 'stuck-task') return '⏳'
      if (k === 'paused-task') return '⏸️'
      if (k === 'queued-ask') return '🧾'
      if (k === 'completion') return '✅'
      return '•'
    }

    /**
     * 收件箱条目 → 独立 app 跳转目标。
     * 契约（docs/API-V4.md §6）：能否跳转只看 `target` 字段，不用标题猜；
     * 老宿主没有 target 时按 action / kind 兜底。
     */
    function targetRouteOf(item) {
      var src = isPlainObject(item) ? item : {}
      var target = isPlainObject(src.target) ? src.target : {}
      var view = asString(target.view)
      var action = asString(src.action)
      var id = asString(src.id)
      if (!view) {
        if (action === 'open-approval') view = 'approvals'
        else if (action === 'open-task') view = 'tasks'
        else if (action === 'open-group' || action === 'open-session') view = 'groups'
        else if (action === 'open-resource') view = 'resource'
        else if (action === 'open-world') view = 'world'
      }
      var approvalId = asString(src.approvalId || target.approvalId)
      var taskId = asString(src.taskId || target.taskId)
      var groupId = asString(src.groupId || target.groupId)
      var sessionId = asString(src.sessionId || target.sessionId)
      var bizId = id.indexOf(':') > 0 ? id.slice(id.indexOf(':') + 1) : id
      if (view === 'approvals') {
        return {
          route: 'approvals',
          approvalId: approvalId || bizId,
          filter: 'approval',
          itemId: id
        }
      }
      if (view === 'tasks') return { route: 'tasks', taskId: taskId || bizId, itemId: id }
      if (view === 'groups') {
        return sessionId && !groupId
          ? { route: 'groups', sessionId: sessionId, itemId: id }
          : { route: 'groups', groupId: groupId, itemId: id }
      }
      if (view === 'resource') return { route: 'resource', itemId: id }
      if (view === 'world') return { route: 'world', entryId: bizId, itemId: id }
      return { route: 'inbox', itemId: id }
    }

    function inboxItemNav(item) {
      var src = isPlainObject(item) ? item : {}
      var nav = targetRouteOf(src)
      if (nav.route !== 'inbox') return nav
      var kind = asString(src.kind)
      if (kind === 'stuck-task' || kind === 'paused-task' || kind === 'completion') {
        return { route: 'tasks', taskId: asString(src.taskId) || asString(src.id) }
      }
      if (kind === 'request' || kind === 'urgent-request' || kind === 'queued-ask' || kind === 'lease-wait') {
        return asString(src.groupId) ? { route: 'groups', groupId: asString(src.groupId) } : { route: 'inbox' }
      }
      if (kind === 'approval' || kind === 'approval-timeout') {
        return { route: 'approvals', approvalId: asString(src.approvalId) || asString(src.id), filter: 'approval' }
      }
      return { route: 'inbox' }
    }

    /** nav → 独立 app 的 hash 深链（docs/API-V4.md §6）。 */
    function navigationHash(nav) {
      var target = isPlainObject(nav) ? nav : {}
      var route = asString(target.route || target.view)
      var query = []
      var push = function (key, value) {
        var text = asString(value)
        if (text !== '') query.push(key + '=' + encodeURIComponent(text))
      }
      var suffix = function () {
        return query.length ? '?' + query.join('&') : ''
      }
      if (route === 'approvals') {
        push('approvalId', target.approvalId || target.id || target.itemId)
        push('filter', target.filter || 'approval')
        return '#/approvals' + suffix()
      }
      if (route === 'tasks') {
        push('taskId', target.taskId || target.id)
        return '#/tasks' + suffix()
      }
      if (route === 'groups') {
        push('groupId', target.groupId)
        push('sessionId', target.sessionId)
        return '#/groups' + suffix()
      }
      if (route === 'resource') return '#/resource/desktop'
      if (route === 'world') {
        push('entryId', target.entryId || target.id)
        return '#/world' + suffix()
      }
      if (route === 'inbox') {
        push('itemId', target.itemId || target.id)
        push('filter', target.filter)
        return '#/inbox' + suffix()
      }
      return ''
    }

    function clickFirstInDoc(doc, selector) {
      try {
        var node = doc.querySelector(selector)
        if (node && typeof node.click === 'function') {
          node.click()
          return true
        }
      } catch (error) {
        /* ignore */
      }
      return false
    }

    function clickByAttrInDoc(doc, selector, attr, value) {
      if (!value) return false
      try {
        var nodes = doc.querySelectorAll(selector)
        for (var i = 0; i < nodes.length; i += 1) {
          if (nodes[i] && nodes[i].getAttribute(attr) === value && typeof nodes[i].click === 'function') {
            nodes[i].click()
            return true
          }
        }
      } catch (error) {
        /* ignore */
      }
      return false
    }

    /**
     * 打开独立「星桥指挥中心」：URL 带 docs/API-V4.md §6 的 hash 深链（#/approvals、
     * #/tasks、#/groups、#/resource/desktop、#/world…）；app 尚未消费 hash 时，再用
     * 同源窗口 DOM 做「尽力导航」（点 tab / 群 / 收件箱条目），任何异常都静默放弃。
     */
    function openBridgeApp(nav) {
      var target = isPlainObject(nav) ? nav : {}
      var hash = ''
      try {
        hash = navigationHash(target)
      } catch (error) {
        hash = ''
      }
      var url = APP_URL + hash
      var win = null
      try {
        if (bridgeWindowRef && !bridgeWindowRef.closed) {
          win = bridgeWindowRef
          focusBridgeWindow(win)
          driveAppNavigation(win, target)
          return win
        }
      } catch (error) { /* ignore */ }
      try {
        win = window.open(url, APP_WINDOW_NAME, APP_WINDOW_FEATURES)
      } catch (error) {
        win = null
      }
      if (win) {
        bridgeWindowRef = win
        focusBridgeWindow(win)
      }
      if (!win) {
        try {
          window.open(url, '_blank')
        } catch (error) {
          /* ignore */
        }
        return null
      }
      driveAppNavigation(win, target)
      return win
    }

    /**
     * app 目前不解析 URL：#4.0 用同源窗口 DOM 做「尽力导航」——等它挂载后点对应 tab /
     * 群 / 收件箱条目；任何异常（跨域、窗口被关）都静默放弃，绝不影响侧栏。
     */
    function driveAppNavigation(win, nav) {
      if (!win || typeof window === 'undefined') return
      // 浏览器里 window.setTimeout === setTimeout；桩环境里只提供全局 setTimeout 时也降级可用。
      var later =
        typeof window.setTimeout === 'function'
          ? function (fn, ms) { return window.setTimeout(fn, ms) }
          : typeof setTimeout === 'function'
            ? function (fn, ms) { return setTimeout(fn, ms) }
            : function () {}
      var target = isPlainObject(nav) ? nav : {}
      var attempts = 0
      var viewSwitched = false
      var tick = function () {
        attempts += 1
        if (attempts > 40) return
        try {
          if (win.closed) return
          var doc = win.document
          if (!doc || !doc.querySelector) {
            later(tick, 250)
            return
          }
          if (doc.readyState && doc.readyState !== 'complete') {
            later(tick, 250)
            return
          }
          var tabs = doc.querySelectorAll('.tab[data-view]')
          if (!tabs || !tabs.length) {
            later(tick, 250)
            return
          }
          var route = asString(target.route || target.view)
          // 路由 → app 现有 tab（app 的 hash 深链由另一任务补齐；这里先按 tab/DOM 尽力跳）。
          var view = 'home'
          if (route === 'approvals' || route === 'inbox') view = 'inbox'
          else if (route === 'groups') view = 'groups'
          else if (route === 'tasks') view = 'tasks'
          else if (route === 'world') view = 'world'
          if (!route) return
          if (!viewSwitched) {
            clickFirstInDoc(doc, '.tab[data-view="' + view + '"]')
            viewSwitched = true
          }
          var resolved = false
          if (view === 'inbox') {
            if (route === 'approvals' || target.filter) {
              clickByAttrInDoc(doc, '[data-inbox-filter]', 'data-inbox-filter', target.filter || 'approval')
            }
            var itemId = asString(target.itemId)
            var approvalId = asString(target.approvalId)
            if (itemId) {
              resolved = clickByAttrInDoc(doc, '[data-inbox-open]', 'data-inbox-open', itemId)
            }
            if (!resolved && approvalId) {
              resolved =
                clickByAttrInDoc(doc, '[data-inbox-open]', 'data-inbox-open', approvalId) ||
                clickByAttrInDoc(doc, '[data-inbox-id]', 'data-inbox-id', approvalId)
            }
            if (!resolved && !itemId && !approvalId) {
              if (target.groupId) {
                resolved = clickByAttrInDoc(doc, '[data-inbox-group]', 'data-inbox-group', target.groupId)
              } else {
                resolved = true
              }
            }
          } else if (view === 'groups') {
            if (target.groupId) resolved = clickByAttrInDoc(doc, '[data-group]', 'data-group', target.groupId)
            if (!resolved && target.sessionId) resolved = clickByAttrInDoc(doc, '[data-jump]', 'data-jump', target.sessionId)
            if (!target.groupId && !target.sessionId) resolved = true
          } else if (view === 'tasks') {
            if (target.taskId) {
              resolved = clickByAttrInDoc(doc, '[data-task-detail]', 'data-task-detail', target.taskId)
            } else {
              resolved = true
            }
          } else {
            resolved = true
          }
          if (resolved) return
          later(tick, 250)
        } catch (error) {
          /* 跨域/窗口关闭等：静默放弃 */
          return
        }
      }
      later(tick, 350)
    }

    /** 单个摘要数字（chip）：默认只读展示，点击可跳到独立 app 对应视图。 */
    function CommandCenterChip(props) {
      var alert = props && props.alert === true
      return h(
        'button',
        {
          type: 'button',
          'data-cmd-stat': props && props.name ? String(props.name) : '',
          title: props && props.title ? String(props.title) : undefined,
          onClick: props && typeof props.onClick === 'function' ? props.onClick : undefined,
          style: mergeStyle(styles.statChip, alert ? styles.statChipAlert : null)
        },
        h('span', null, props && props.label ? String(props.label) : ''),
        h('span', { style: mergeStyle(styles.statNum, alert ? styles.statNumAlert : null) }, props && props.value !== undefined ? String(props.value) : '0')
      )
    }

    /**
     * 4.0 右侧栏顶部「指挥中心」常驻摘要：
     *  - 一行显示 待处理 / 卡住 / 议会待批 / computer-use 占用；
     *  - 默认折叠（低打扰），点「收件箱」或「待处理」展开前 5 条；
     *  - 「打开星桥指挥中心」打开独立窗口，并尽力跳到对应视图/群/任务。
     * 任何字段缺失/轮询失败都只显示「—」或 0，不抛异常。
     */
    function CommandCenterStrip(props) {
      var expandedState = React.useState(false)
      var expanded = expandedState[0]
      var setExpanded = expandedState[1]
      var state = isPlainObject(props && props.state) ? props.state : {}
      var hasData = props && props.hasData === true
      var inbox = isPlainObject(state.inbox) ? state.inbox : {}
      var commandCenter = isPlainObject(state.commandCenter) ? state.commandCenter : {}
      var computer = isPlainObject(state.computerResource) ? state.computerResource : {}
      var ccCouncil = isPlainObject(commandCenter.council) ? commandCenter.council : {}
      var ccComputer = isPlainObject(commandCenter.computer) ? commandCenter.computer : {}
      var taskStats = isPlainObject(state.taskLineStats) ? state.taskLineStats : {}
      var items = asArray(inbox.items)
      var approvals = asArray(state.approvals)
      var pendingCount = asNumber(inbox.attentionCount, asNumber(commandCenter.attentionCount, asArray(inbox.attention).length))
      var stalledCount = asNumber(
        commandCenter.stalledTasks,
        asNumber(
          taskStats.stalled,
          items.filter(function (item) {
            return asString(item.kind) === 'stuck-task'
          }).length
        )
      )
      // 议会待批：优先宿主摘要 commandCenter.council.pendingApprovals。
      var councilPending = asNumber(ccCouncil.pendingApprovals, 0)
      if (!councilPending) {
        councilPending = approvals.filter(function (item) {
          return asString(item.status) === 'pending'
        }).length
      }
      if (!councilPending) {
        councilPending = items.filter(function (item) {
          return asString(item.kind) === 'approval' || asString(item.kind) === 'approval-timeout'
        }).length
      }
      var lease = isPlainObject(computer.lease) ? computer.lease : null
      var computerOwner = lease !== null ? asString(lease.owner) : asString(ccComputer.owner)
      var computerBusy = computer.available === true || ccComputer.available === true
      if (computerOwner === '') computerBusy = false
      var computerDegraded = computer.degraded === true || ccComputer.degraded === true
      var totalCount = asNumber(inbox.total, items.length)
      var displayNumber = function (value) {
        return hasData ? String(Math.max(0, asNumber(value, 0))) : '—'
      }
      var computerLabel = hasData ? (computerDegraded ? '—' : computerBusy ? '占用' : '空闲') : '—'
      var computerTitle =
        'computer-use 桌面：' +
        (computerDegraded
          ? '租约读不到（degraded）'
          : computerBusy
            ? asString(lease && (lease.ownerName || lease.label)) || shortId(computerOwner) || '占用'
            : '当前空闲')
      var openApp = function (nav) {
        if (props && typeof props.onOpenApp === 'function') {
          props.onOpenApp(nav)
          return
        }
        openBridgeApp(nav)
      }
      var toggle = function () {
        setExpanded(!expanded)
      }
      var rows = items.slice(0, 5).map(function (item) {
        var nav = inboxItemNav(item)
        return h(
          'button',
          {
            key: asString(item.id) || asString(item.title),
            type: 'button',
            'data-cmd-inbox-item': asString(item.id),
            title: (asString(item.detail) || asString(item.title)) + '（点击打开指挥中心对应位置）',
            onClick: function () {
              openApp(nav)
            },
            style: styles.cmdInboxRow
          },
          h('span', { style: styles.cmdInboxKind }, inboxKindIcon(item.kind)),
          h('span', { style: styles.cmdInboxTitle }, clipText(item.title || item.detail, 30)),
          h('span', { style: styles.cmdInboxTime }, item.ts > 0 ? formatLocalTime(item.ts) : '')
        )
      })
      return h(
        'div',
        { style: styles.commandStrip, 'data-session-bridge-command-center': true },
        h(
          'div',
          { style: styles.commandRow },
          h('span', { style: styles.commandTitle }, '指挥中心'),
          h(CommandCenterChip, {
            name: 'pending',
            label: '待处理',
            value: displayNumber(pendingCount),
            alert: hasData && pendingCount > 0,
            title: '待处理 ' + displayNumber(pendingCount) + ' 项（收件箱共 ' + displayNumber(totalCount) + ' 条）',
            onClick: toggle
          }),
          h(CommandCenterChip, {
            name: 'stalled',
            label: '卡住',
            value: displayNumber(stalledCount),
            alert: hasData && stalledCount > 0,
            title: '卡住/暂停的任务（点击打开指挥中心任务视图）',
            onClick: function () {
              openApp({ route: 'tasks' })
            }
          }),
          h(CommandCenterChip, {
            name: 'council',
            label: '议会待批',
            value: displayNumber(councilPending),
            alert: hasData && councilPending > 0,
            title: '等待小议会审批的事项（点击打开审批详情）',
            onClick: function () {
              openApp({ route: 'approvals', filter: 'approval' })
            }
          }),
          h(CommandCenterChip, {
            name: 'computer',
            label: 'computer-use',
            value: computerLabel,
            alert: computerBusy,
            title: computerTitle,
            onClick: function () {
              openApp({ route: 'resource' })
            }
          }),
          h('span', { style: styles.commandSpacer }),
          h(
            Btn,
            { variant: 'ghost', title: expanded ? '收起收件箱' : '展开收件箱（最多 5 条）', onClick: toggle, style: { fontSize: 11, padding: '2px 6px' } },
            expanded ? '收起 ▲' : '收件箱 ▼'
          ),
          h(
            Btn,
            {
              variant: 'primary',
              title: '打开星桥指挥中心（独立窗口）',
              ariaLabel: '打开星桥指挥中心',
              onClick: function () {
                openApp({})
              },
              style: { fontSize: 11, padding: '2px 7px' }
            },
            '打开星桥指挥中心'
          )
        ),
        expanded
          ? h(
              'div',
              { style: styles.cmdInboxList, 'data-cmd-inbox': true },
              !hasData
                ? h('div', { style: styles.cmdEmpty }, '状态加载中…')
                : rows.length
                  ? rows
                  : h('div', { style: styles.cmdEmpty }, '暂无待处理事项；点「打开星桥指挥中心」查看全部')
            )
          : null
      )
    }
    //#endregion

    //#region 4.1 无感入口（ambientStore + header chip + composer dock + 注意力气泡）
    /**
     * 4.1 Ambient Entry：DSH 原生会话页里的零切换入口。
     *  - 模块级 ambientStore：所有组件共享同一条 /ambient 轮询（引用计数、document.hidden 暂停）；
     *  - header chip（conversation.session.header.utilities）：任务/阶段/待办/资源冲突；
     *  - composer dock（conversation.composer.dock）：可选全宽 1 行任务条；
     *  - 注意力气泡：attention.count>0 时自动展开一次（轻 pulse），列 top3，1-click 处理。
     * 任何失败/字段缺失/过期数据 → 组件直接不渲染，不抛错、不影响输入。
     */
    var AMBIENT_URL = '/api/session-bridge/ambient'
    var AMBIENT_POLL_MS = 4000
    /** 超过这么久没有一次成功的 /ambient，就视为 stale：隐藏 chip/气泡。 */
    var AMBIENT_STALE_MS = 30000
    var AMBIENT_ACK_STORAGE_PREFIX = 'session-bridge.ack.'
    var AMBIENT_MAX_ATTENTION = 3

    /** /ambient 响应归一化（docs/4.1-ambient-plan.md §3.7 + 实际 host buildAmbientFromState）。 */
    function normalizeAmbient(raw) {
      var src = isPlainObject(raw) ? raw : {}
      var sessionSrc = isPlainObject(src.session) ? src.session : {}
      var task = null
      if (isPlainObject(src.task)) {
        var t = src.task
        var taskId = asString(t.id || t.taskId)
        if (taskId !== '' || asString(t.title) !== '') {
          task = {
            id: taskId,
            title: asString(t.title),
            lineStatus: asString(t.lineStatus),
            stage: asNumber(t.stage, 0),
            stageText: asString(t.stageText),
            stageTotal: asNumber(t.stageTotal, 5),
            progress: asNumber(t.progress, 0),
            leader: isPlainObject(t.leader)
              ? { id: asString(t.leader.id), handle: asString(t.leader.handle || t.leader.title) }
              : null,
            steps: asArray(t.steps)
              .filter(isPlainObject)
              .slice(0, 5)
              .map(function (step) {
                return {
                  i: asNumber(step.i, 0),
                  text: asString(step.text),
                  status: asString(step.status, 'pending')
                }
              }),
            flows: asArray(t.flows)
              .filter(isPlainObject)
              .slice(-3)
              .map(function (flow) {
                return {
                  ts: asTimestamp(flow.ts),
                  action: asString(flow.action || flow.kind),
                  detail: asString(flow.detail),
                  fromName: asString(flow.fromName || flow.from)
                }
              })
          }
        }
      }
      var attentionSrc = isPlainObject(src.attention) ? src.attention : {}
      var attentionItems = asArray(attentionSrc.items)
        .filter(isPlainObject)
        .map(function (item) {
          return {
            id: asString(item.id),
            kind: asString(item.kind, 'notice'),
            priority: asNumber(item.priority, 0),
            ts: asTimestamp(item.ts),
            title: asString(item.title),
            detail: asString(item.detail),
            approvalId: asString(item.approvalId),
            requestId: asString(item.requestId),
            taskId: asString(item.taskId),
            groupId: asString(item.groupId),
            sessionId: asString(item.sessionId),
            from: asString(item.from),
            fromHandle: asString(item.fromHandle || item.authorHandle),
            action: asString(item.action)
          }
        })
        .filter(function (item) {
          return item.id !== '' || item.title !== ''
        })
      attentionItems.sort(function (a, b) {
        return b.priority - a.priority || b.ts - a.ts
      })
      var pendingSrc = isPlainObject(src.pending) ? src.pending : {}
      var requests = asArray(pendingSrc.requests)
        .filter(isPlainObject)
        .map(function (item) {
          return {
            id: asString(item.id || item.requestId),
            title: asString(item.title),
            detail: asString(item.detail),
            groupId: asString(item.groupId),
            from: asString(item.from || item.author),
            fromHandle: asString(item.fromHandle || item.authorHandle || item.fromName),
            requestTo: asArray(item.requestTo)
              .map(function (entry) {
                return asString(entry)
              })
              .filter(function (entry) {
                return entry !== ''
              }),
            tool: asString(item.tool, 'session_ask')
          }
        })
        .filter(function (item) {
          return item.id !== '' || item.title !== ''
        })
      var transfers = asArray(pendingSrc.transfers)
        .filter(isPlainObject)
        .map(function (item) {
          return {
            id: asString(item.id || item.requestId || item.transferId),
            requestId: asString(item.requestId || item.id),
            taskId: asString(item.taskId),
            title: asString(item.title),
            detail: asString(item.detail),
            from: asString(item.from || item.author),
            fromHandle: asString(item.fromHandle || item.authorHandle || item.fromName)
          }
        })
        .filter(function (item) {
          return item.id !== '' || item.title !== ''
        })
      var approvals = asArray(pendingSrc.approvals)
        .filter(isPlainObject)
        .map(function (item) {
          return {
            id: asString(item.id),
            title: asString(item.title),
            source: asString(item.source),
            reason: asString(item.reason)
          }
        })
        .filter(function (item) {
          return item.id !== ''
        })
      var councilSrc = isPlainObject(pendingSrc.council) ? pendingSrc.council : {}
      var resourceSrc = isPlainObject(src.resource) ? src.resource : {}
      var actions = asArray(src.actions)
        .filter(isPlainObject)
        .map(function (item) {
          return {
            id: asString(item.id),
            kind: asString(item.kind),
            label: asString(item.label),
            tool: asString(item.tool),
            command: asString(item.command),
            target: asString(item.target),
            payload: isPlainObject(item.payload) ? item.payload : {}
          }
        })
      return {
        ok: src.ok !== false,
        schemaVersion: asString(src.schemaVersion),
        generatedAt: asTimestamp(src.generatedAt),
        stale: src.stale === true,
        session: {
          id: asString(sessionSrc.id),
          title: asString(sessionSrc.title),
          availability: asString(sessionSrc.availability)
        },
        task: task,
        attention: {
          count: Math.max(0, asNumber(attentionSrc.count, attentionItems.length)),
          items: attentionItems.slice(0, AMBIENT_MAX_ATTENTION)
        },
        pending: {
          requests: requests,
          transfers: transfers,
          approvals: approvals,
          council: {
            members: asNumber(councilSrc.members, 0),
            chair: asString(councilSrc.chair),
            isMember: councilSrc.isMember === true,
            pendingApprovals: asNumber(councilSrc.pendingApprovals, approvals.length)
          }
        },
        resource: {
          available: resourceSrc.available === true,
          degraded: resourceSrc.degraded === true,
          owner: asString(resourceSrc.owner),
          ownerName: asString(resourceSrc.ownerName),
          heldByMe: resourceSrc.heldByMe === true,
          ttlMs: asNumber(resourceSrc.ttlMs, 0),
          priority: isPlainObject(resourceSrc.priority)
            ? asNumber(resourceSrc.priority.current, 0)
            : asNumber(resourceSrc.priority, 0)
        },
        actions: actions
      }
    }

    /** localStorage 兜底 ack：kind:id:ts + 纯 id 双 key，刷新后不重复冒泡。 */
    function ambientReadAcked(sessionId) {
      var out = {}
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          var raw = window.localStorage.getItem(AMBIENT_ACK_STORAGE_PREFIX + asString(sessionId))
          var parsed = raw ? JSON.parse(raw) : null
          if (isPlainObject(parsed)) out = parsed
        }
      } catch (error) {
        out = {}
      }
      return out
    }

    function ambientWriteAcked(sessionId, acked) {
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(AMBIENT_ACK_STORAGE_PREFIX + asString(sessionId), JSON.stringify(acked || {}))
        }
      } catch (error) {
        /* 存储不可用时静默 */
      }
    }

    function ambientAckKeysOf(id, ts) {
      var raw = asString(id)
      var keys = []
      if (raw === '') return keys
      keys.push(raw)
      keys.push(raw + ':' + String(asNumber(ts, 0)))
      var colon = raw.lastIndexOf(':')
      if (colon > 0 && colon < raw.length - 1) keys.push(raw.slice(colon + 1))
      return keys
    }

    function ambientIsAcked(acked, item) {
      if (!isPlainObject(acked) || !item) return false
      var keys = ambientAckKeysOf(item.id, item.ts)
      for (var i = 0; i < keys.length; i += 1) {
        if (acked[keys[i]] === 1 || acked[keys[i]] === true) return true
      }
      return false
    }

    /** 把本地已读应用到一条 ambient（过滤 attention / approvals，重算 count）。 */
    function ambientApplyLocalAcks(sessionId, ambient) {
      var acked = ambientReadAcked(sessionId)
      if (!isPlainObject(ambient)) return ambient
      var total = asNumber(ambient.attention.count, 0)
      var original = asArray(ambient.attention.items)
      var filtered = []
      var removed = 0
      for (var i = 0; i < original.length; i += 1) {
        if (ambientIsAcked(acked, original[i])) removed += 1
        else filtered.push(original[i])
      }
      if (removed > 0) {
        ambient.attention.items = filtered
        ambient.attention.count = total <= original.length ? filtered.length : Math.max(0, total - removed)
      }
      ambient.pending.approvals = asArray(ambient.pending.approvals).filter(function (approval) {
        return !ambientIsAcked(acked, { id: approval.id, ts: 0 })
      })
      return ambient
    }

    function ambientIsUsable(entry, sessionId) {
      if (!isPlainObject(entry) || !isPlainObject(entry.ambient)) return false
      var ambient = entry.ambient
      if (ambient.ok === false || ambient.stale === true) return false
      if (asString(ambient.session.id) !== asString(sessionId)) return false
      if (!(entry.lastGoodAt > 0)) return false
      return Date.now() - entry.lastGoodAt <= AMBIENT_STALE_MS
    }

    /** 模块级共享 ambientStore：同页多组件只轮询一份。 */
    function createAmbientStore() {
      var entries = {}
      var listeners = {}
      var timer = null
      var visibilityInstalled = false
      var autoOpened = {}
      var requestSeq = 0

      function listenerList(sessionId) {
        return listeners[sessionId] || []
      }
      function hasListeners() {
        for (var key in listeners) {
          if (Object.prototype.hasOwnProperty.call(listeners, key) && listeners[key].length > 0) return true
        }
        return false
      }
      function snapshot(sessionId) {
        return entries[asString(sessionId)] || null
      }
      function notify(sessionId) {
        var list = listenerList(sessionId).slice()
        for (var i = 0; i < list.length; i += 1) {
          try {
            list[i]()
          } catch (error) {
            /* 单个订阅者异常不能影响其它组件 */
          }
        }
      }
      function isDocumentHidden() {
        try {
          return typeof document !== 'undefined' && document.hidden === true
        } catch (error) {
          return false
        }
      }
      function tick() {
        if (isDocumentHidden()) return
        var ids = Object.keys(listeners)
        for (var i = 0; i < ids.length; i += 1) {
          var sid = ids[i]
          if (listenerList(sid).length === 0) continue
          var previous = entries[sid] || null
          // 连续失败退避：旧宿主没有 /ambient 或后端未实现时，每 60s 探测一次即可，不刷 404。
          if (
            previous &&
            asNumber(previous.errorCount, 0) >= 5 &&
            Date.now() - asNumber(previous.lastAttemptAt, 0) < 60000
          ) {
            continue
          }
          fetchOne(sid, false)
        }
      }
      function ensureTimer() {
        if (timer !== null || !hasListeners()) return
        if (typeof window === 'undefined' || typeof window.setInterval !== 'function') return
        timer = window.setInterval(tick, AMBIENT_POLL_MS)
        tick()
      }
      function stopTimer() {
        if (timer === null) return
        try {
          if (typeof window !== 'undefined' && typeof window.clearInterval === 'function') window.clearInterval(timer)
        } catch (error) {
          /* ignore */
        }
        timer = null
      }
      function installVisibility() {
        if (visibilityInstalled) return
        visibilityInstalled = true
        try {
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
          document.addEventListener('visibilitychange', function () {
            try {
              if (document.hidden === true) stopTimer()
              else ensureTimer()
            } catch (error) {
              /* ignore */
            }
          })
        } catch (error) {
          /* ignore */
        }
      }
      function fetchOne(sessionId, force) {
        var sid = asString(sessionId)
        if (sid === '') return Promise.resolve(null)
        var existing = entries[sid] || null
        if (existing && existing.inFlight && force !== true) return existing.inFlight
        if (typeof fetch !== 'function') {
          entries[sid] = {
            ambient: existing ? existing.ambient : null,
            lastGoodAt: existing ? existing.lastGoodAt : 0,
            lastAttemptAt: Date.now(),
            inFlight: null,
            error: 'fetch-unavailable',
            errorCount: asNumber(existing ? existing.errorCount : 0, 0) + 1
          }
          notify(sid)
          return Promise.resolve(null)
        }
        var seq = ++requestSeq
        var promise = fetchJson(AMBIENT_URL + '?sessionId=' + encodeURIComponent(sid), {
          method: 'GET',
          headers: { accept: 'application/json' }
        }).then(
          function (payload) {
            var ambient = normalizeAmbient(payload)
            var usable =
              ambient.ok === true &&
              asString(ambient.session.id) === sid &&
              ambient.generatedAt > 0 &&
              ambient.stale !== true
            if (!usable) {
              var previous = entries[sid] || null
              entries[sid] = {
                ambient: previous ? previous.ambient : null,
                lastGoodAt: previous ? previous.lastGoodAt : 0,
                lastAttemptAt: Date.now(),
                inFlight: null,
                error: 'invalid-ambient',
                errorCount: asNumber(previous ? previous.errorCount : 0, 0) + 1
              }
              notify(sid)
              return null
            }
            ambientApplyLocalAcks(sid, ambient)
            entries[sid] = {
              ambient: ambient,
              lastGoodAt: Date.now(),
              lastAttemptAt: Date.now(),
              inFlight: null,
              error: '',
              errorCount: 0
            }
            notify(sid)
            return ambient
          },
          function (error) {
            var previous = entries[sid] || null
            entries[sid] = {
              ambient: previous ? previous.ambient : null,
              lastGoodAt: previous ? previous.lastGoodAt : 0,
              lastAttemptAt: Date.now(),
              inFlight: null,
              error: errorMessage(error),
              errorCount: asNumber(previous ? previous.errorCount : 0, 0) + 1
            }
            notify(sid)
            return null
          }
        )
        entries[sid] = {
          ambient: existing ? existing.ambient : null,
          lastGoodAt: existing ? existing.lastGoodAt : 0,
          lastAttemptAt: Date.now(),
          inFlight: promise,
          error: existing ? existing.error : '',
          errorCount: existing ? asNumber(existing.errorCount, 0) : 0
        }
        // seq 只用于调试；多请求时以最后一次落地为准（后写覆盖，无需丢弃旧响应）。
        void seq
        return promise
      }
      function subscribe(sessionId, listener) {
        var sid = asString(sessionId)
        if (sid === '' || typeof listener !== 'function') return function () {}
        if (!listeners[sid]) listeners[sid] = []
        listeners[sid].push(listener)
        installVisibility()
        ensureTimer()
        if (!entries[sid] || !entries[sid].lastGoodAt) fetchOne(sid, false)
        return function () {
          var list = listeners[sid] || []
          var index = list.indexOf(listener)
          if (index >= 0) list.splice(index, 1)
          if (!list.length) delete listeners[sid]
          if (!hasListeners()) stopTimer()
        }
      }
      function refresh(sessionId) {
        return fetchOne(sessionId, true)
      }
      /** 本地已读 + 后端 inbox.ack（后端失败保留本地已读，避免重复打扰）。 */
      function ack(sessionId, ids) {
        var sid = asString(sessionId)
        var list = asArray(ids)
          .map(function (id) {
            return asString(id)
          })
          .filter(function (id) {
            return id !== ''
          })
        if (list.length === 0) return Promise.resolve({ ok: true })
        var entry = entries[sid]
        var ambient = entry && entry.ambient
        if (ambient) {
          var acked = ambientReadAcked(sid)
          for (var i = 0; i < list.length; i += 1) {
            var keys = ambientAckKeysOf(list[i], 0)
            for (var k = 0; k < keys.length; k += 1) acked[keys[k]] = 1
          }
          var attentionItems = asArray(ambient.attention.items)
          var kept = []
          var removed = 0
          for (var j = 0; j < attentionItems.length; j += 1) {
            if (ambientIsAcked(acked, attentionItems[j])) removed += 1
            else kept.push(attentionItems[j])
          }
          var total = asNumber(ambient.attention.count, 0)
          ambient.attention.items = kept
          ambient.attention.count = total <= attentionItems.length ? kept.length : Math.max(0, total - removed)
          ambient.pending.approvals = asArray(ambient.pending.approvals).filter(function (approval) {
            return !ambientIsAcked(acked, { id: approval.id, ts: 0 })
          })
          ambientWriteAcked(sid, acked)
          notify(sid)
        }
        return sendCommand('inbox.ack', { ids: list }).then(
          function () {
            refresh(sid)
            return { ok: true }
          },
          function (error) {
            return { ok: false, local: true, error: errorMessage(error) }
          }
        )
      }
      function approve(sessionId, approvalId) {
        var sid = asString(sessionId)
        var id = asString(approvalId)
        if (id === '') return Promise.resolve({ ok: false, error: '缺少审批 id' })
        return sendCommand('approval.approve', { id: id }).then(
          function () {
            refresh(sid)
            return { ok: true }
          },
          function (error) {
            return { ok: false, error: errorMessage(error) }
          }
        )
      }
      function reject(sessionId, approvalId) {
        var sid = asString(sessionId)
        var id = asString(approvalId)
        if (id === '') return Promise.resolve({ ok: false, error: '缺少审批 id' })
        return sendCommand('approval.reject', { id: id }).then(
          function () {
            refresh(sid)
            return { ok: true }
          },
          function (error) {
            return { ok: false, error: errorMessage(error) }
          }
        )
      }
      /** 宿主允许时用 ambient.act steer 当前会话；未知 action 会 reject，由调用方降级复制模板。 */
      function steer(sessionId, act) {
        var sid = asString(sessionId)
        if (sid === '') return Promise.resolve({ ok: false, error: '缺少会话 id' })
        return sendCommand('ambient.act', { sessionId: sid, act: isPlainObject(act) ? act : {} }).then(
          function () {
            refresh(sid)
            return { ok: true }
          },
          function (error) {
            return { ok: false, error: errorMessage(error) }
          }
        )
      }
      function shouldAutoOpen(sessionId, signature) {
        var sid = asString(sessionId)
        var sig = asString(signature)
        if (sid === '' || sig === '') return false
        return autoOpened[sid] !== sig
      }
      function markAutoOpened(sessionId, signature) {
        autoOpened[asString(sessionId)] = asString(signature)
      }
      return {
        subscribe: subscribe,
        snapshot: snapshot,
        refresh: refresh,
        ack: ack,
        approve: approve,
        reject: reject,
        steer: steer,
        shouldAutoOpen: shouldAutoOpen,
        markAutoOpened: markAutoOpened,
        stop: stopTimer
      }
    }

    var ambientStore = createAmbientStore()

    // ---- 纯展示/交互工具 ----
    function ambientClip(value, max) {
      var text = asString(value)
      var limit = asNumber(max, 24)
      if (limit <= 0 || text.length <= limit) return text
      return text.slice(0, limit).replace(/\s+$/, '') + '…'
    }

    function ambientKindIcon(kind) {
      var k = asString(kind)
      if (k === 'approval') return '🛡️'
      if (k === 'approval-timeout') return '⏰'
      if (k === 'urgent-request') return '⚡'
      if (k === 'request') return '📨'
      if (k === 'stuck-task') return '⏳'
      if (k === 'paused-task') return '⏸️'
      if (k === 'lease-wait') return '🖥️'
      if (k === 'queued-ask') return '🧾'
      if (k === 'completion') return '✅'
      return '•'
    }

    function ambientAttentionSignature(ambient) {
      if (!isPlainObject(ambient) || !isPlainObject(ambient.attention)) return ''
      var items = asArray(ambient.attention.items)
      var parts = []
      for (var i = 0; i < items.length; i += 1) parts.push(asString(items[i].id) + ':' + String(asNumber(items[i].ts, 0)))
      return parts.join('|')
    }

    function ambientHasTask(ambient) {
      return isPlainObject(ambient) && isPlainObject(ambient.task) && (asString(ambient.task.id) !== '' || asString(ambient.task.title) !== '')
    }

    function ambientAttentionCount(ambient) {
      return ambient && isPlainObject(ambient.attention) ? Math.max(0, asNumber(ambient.attention.count, 0)) : 0
    }

    function ambientPendingCount(ambient) {
      if (!isPlainObject(ambient) || !isPlainObject(ambient.pending)) return 0
      return (
        asArray(ambient.pending.requests).length +
        asArray(ambient.pending.transfers).length +
        asArray(ambient.pending.approvals).length
      )
    }

    /** chip 只在「有任务」或「有 attention」时出现（无任务无 attention 完全零占位）。 */
    function ambientChipVisible(ambient) {
      // 常驻最小入口：没有任务/attention 时也保留一个星桥 chip，避免无入口。
      return true
    }

    /** dock 条在有任何态势时出现（含待协作/待审批）。 */
    function ambientDockVisible(ambient) {
      return ambientHasTask(ambient) || ambientAttentionCount(ambient) > 0 || ambientPendingCount(ambient) > 0
    }

    function ambientResourceConflict(ambient, sessionId) {
      if (!isPlainObject(ambient) || !isPlainObject(ambient.resource)) return null
      var resource = ambient.resource
      if (resource.available !== true || resource.degraded === true) return null
      if (asString(resource.owner) === '' || resource.heldByMe === true) return null
      if (asString(resource.owner) === asString(sessionId)) return null
      return resource
    }

    function ambientOwnerText(resource) {
      if (!isPlainObject(resource)) return '其他会话'
      var name = asString(resource.ownerName)
      if (name !== '') return ambientClip(name, 16)
      return shortId(resource.owner)
    }

    function ambientProgressPercent(task) {
      if (!isPlainObject(task)) return 0
      var value = asNumber(task.progress, 0)
      if (value < 0) value = 0
      if (value > 100) value = 100
      return value
    }

    function ambientTaskStageText(task) {
      if (!isPlainObject(task)) return ''
      var stageText = asString(task.stageText)
      var stage = Math.max(0, asNumber(task.stage, 0))
      var total = Math.max(0, asNumber(task.stageTotal, 0))
      if (total > 0) return (stageText !== '' ? stageText + ' ' : '') + stage + '/' + total
      return stageText
    }

    function ambientReplyTemplate(request) {
      var item = isPlainObject(request) ? request : {}
      var id = asString(item.id || item.requestId)
      var title = ambientClip(item.title || item.detail, 60)
      var groupHint = asString(item.groupId) !== '' ? asString(item.groupId) : '同一群'
      var toHint = asString(item.fromHandle || item.from) !== '' ? asString(item.fromHandle || item.from) : '请求方'
      return (
        '【星桥内联动作】请用 session_ask 处理请求 ' +
        id +
        '：' +
        title +
        '（group=' +
        groupHint +
        '，to=' +
        toHint +
        '；拿到结果后用 session_share kind=handoff replyTo=' +
        id +
        ' 回复）。'
      )
    }

    function ambientTransferTemplate(transfer, approve) {
      var item = isPlainObject(transfer) ? transfer : {}
      var id = asString(item.id || item.requestId)
      return (
        '【星桥内联动作】请用 task_transfer action=' +
        (approve === true ? 'approve' : 'reject') +
        ' requestId=' +
        id +
        ' 处理这条转交申请。'
      )
    }

    function copyAmbientText(text) {
      var value = asString(text)
      if (value === '') return false
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(value)
          return true
        }
      } catch (error) {
        /* fall through */
      }
      try {
        if (typeof document !== 'undefined' && document.body && typeof document.createElement === 'function') {
          var node = document.createElement('textarea')
          node.value = value
          node.setAttribute('readonly', 'readonly')
          node.style.position = 'fixed'
          node.style.opacity = '0'
          document.body.appendChild(node)
          node.select()
          var copied = document.execCommand && document.execCommand('copy')
          document.body.removeChild(node)
          return copied === true
        }
      } catch (error) {
        /* ignore */
      }
      return false
    }

    /** 订阅当前会话的 ambient；模块级 store 共享一份轮询。 */
    function useAmbientEntry(sessionId) {
      var state = React.useState(function () {
        return ambientStore.snapshot(sessionId)
      })
      var entry = state[0]
      var setEntry = state[1]
      React.useEffect(
        function () {
          var disposed = false
          var update = function () {
            if (!disposed) setEntry(ambientStore.snapshot(sessionId))
          }
          var unsubscribe = ambientStore.subscribe(sessionId, update)
          update()
          return function () {
            disposed = true
            unsubscribe()
          }
        },
        [sessionId]
      )
      return entry
    }

    /** 供 slot 注册用：所有 ambient 组件都包一层现有 ErrorBoundary，渲染异常只隐藏自己。 */
    function ambientSafeComponent(Component) {
      return function SessionBridgeAmbientSlot(props) {
        return h(PanelErrorBoundary, null, h(Component, props))
      }
    }

    function AmbientChip(props) {
      var sessionId = asString(props && props.ambientSessionId)
      var entry = useAmbientEntry(sessionId)
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var pulseState = React.useState(false)
      var pulse = pulseState[0]
      var setPulse = pulseState[1]
      var anchorState = React.useState({ top: 56, right: 12 })
      var anchor = anchorState[0]
      var setAnchor = anchorState[1]
      var rootRef = React.useRef(null)
      var panelRef = React.useRef(null)
      var pulseTimer = React.useRef(null)
      var autoSigRef = React.useRef('')
      var ambient = entry && isPlainObject(entry.ambient) ? entry.ambient : null
      var usable = ambientIsUsable(entry, sessionId)

      // v4.2：不自动展开、不 pulse；只有用户点击 header chip 才打开。
      // 关闭时清理 pulse 定时器。
      React.useEffect(function () {
        return function () {
          if (pulseTimer.current) {
            try {
              clearTimeout(pulseTimer.current)
            } catch (error) {
              /* ignore */
            }
          }
        }
      }, [])

      // 点击外部 / Escape 关闭 popover。
      React.useEffect(
        function () {
          if (!open) return undefined
          var onPointerDown = function (event) {
            try {
              var target = event && event.target
              if (rootRef.current && rootRef.current.contains(target)) return
              if (panelRef.current && panelRef.current.contains(target)) return
              setOpen(false)
            } catch (error) {
              /* ignore */
            }
          }
          var onKeyDown = function (event) {
            if (event && event.key === 'Escape') setOpen(false)
          }
          try {
            if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
              document.addEventListener('pointerdown', onPointerDown, true)
              document.addEventListener('keydown', onKeyDown, true)
            }
          } catch (error) {
            /* ignore */
          }
          return function () {
            try {
              if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
                document.removeEventListener('pointerdown', onPointerDown, true)
                document.removeEventListener('keydown', onKeyDown, true)
              }
            } catch (error) {
              /* ignore */
            }
          }
        },
        [open, setOpen]
      )

      if (!usable || !ambientChipVisible(ambient)) return null

      var task = isPlainObject(ambient.task) ? ambient.task : null
      var attentionCount = ambientAttentionCount(ambient)
      var resource = ambientResourceConflict(ambient, sessionId)
      var parts = []
      if (task) {
        var stage = ambientTaskStageText(task)
        parts.push(
          '任务：' + ambientClip(task.title, 18) + (stage !== '' ? ' · ' + stage : '') + ' · ' + ambientProgressPercent(task) + '%'
        )
      }
      if (attentionCount > 0) parts.push('待处理 ' + attentionCount)
      if (task && resource) parts.push('桌面被 ' + ambientOwnerText(resource) + ' 占用')
      var label = '🌉 星桥'
      if (attentionCount > 0) label += ' · ' + attentionCount
      else if (task) label += ' · ' + ambientClip(task.title, 10) + ' · ' + ambientProgressPercent(task) + '%'
      var tooltipParts = []
      if (task) {
        tooltipParts.push('任务：' + task.title + ' · ' + ambientTaskStageText(task) + ' · ' + ambientProgressPercent(task) + '%')
        if (isPlainObject(task.leader) && asString(task.leader.handle || task.leader.id) !== '') {
          tooltipParts.push('组长：' + asString(task.leader.handle || task.leader.id))
        }
      }
      if (attentionCount > 0) tooltipParts.push('待处理 ' + attentionCount + ' 条（点开处理）')
      if (ambientPendingCount(ambient) > 0) tooltipParts.push('待协作/待审批 ' + ambientPendingCount(ambient) + ' 条')
      if (resource) tooltipParts.push('computer-use 桌面被 ' + ambientOwnerText(resource) + ' 占用（TTL ' + Math.max(0, Math.round(asNumber(resource.ttlMs, 0) / 1000)) + 's）')
      var onClick = function (event) {
        try {
          if (event && event.currentTarget && typeof event.currentTarget.getBoundingClientRect === 'function') {
            var rect = event.currentTarget.getBoundingClientRect()
            var viewport = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1200
            setAnchor({ top: Math.round(rect.bottom + 6), right: Math.max(8, Math.round(viewport - rect.right)) })
          }
        } catch (error) {
          /* ignore */
        }
        setOpen(!open)
      }
      var chipStyle = pulse ? mergeStyle(styles.ambientChip, styles.ambientChipPulse) : styles.ambientChip
      return h(
        'span',
        { ref: rootRef, style: styles.ambientChipWrap, 'data-session-bridge-ambient-chip': true },
        h(
          'button',
          {
            type: 'button',
            title: tooltipParts.join('\n') || '星桥：本会话态势',
            'aria-label': '星桥本会话态势',
            onClick: onClick,
            style: open ? mergeStyle(chipStyle, styles.ambientChipOpen) : chipStyle
          },
          h('span', { style: styles.ambientChipText }, label),
          attentionCount > 0 ? h('span', { style: styles.ambientChipBadge }, String(attentionCount)) : null
        ),
        open
          ? h(
              'div',
              {
                ref: panelRef,
                style: mergeStyle(styles.ambientPopover, { top: anchor.top, right: anchor.right }),
                role: 'dialog',
                'aria-label': '星桥本会话态势'
              },
              h(AmbientDetailPanel, {
                sessionId: sessionId,
                ambient: ambient,
                onClose: function () {
                  setOpen(false)
                }
              })
            )
          : null
      )
    }

    function AmbientDock(props) {
      var sessionId = asString(props && props.ambientSessionId)
      var entry = useAmbientEntry(sessionId)
      var expandedState = React.useState(false)
      var expanded = expandedState[0]
      var setExpanded = expandedState[1]
      var ambient = entry && isPlainObject(entry.ambient) ? entry.ambient : null
      var usable = ambientIsUsable(entry, sessionId)
      if (!usable || !ambientDockVisible(ambient)) return null
      var task = isPlainObject(ambient.task) ? ambient.task : null
      var attentionCount = ambientAttentionCount(ambient)
      var pending = isPlainObject(ambient.pending) ? ambient.pending : {}
      var resource = ambientResourceConflict(ambient, sessionId)
      var summary = []
      if (task) {
        var stage = ambientTaskStageText(task)
        summary.push(ambientClip(task.title, 24) + (stage !== '' ? ' · ' + stage : '') + ' · ' + ambientProgressPercent(task) + '%')
      }
      if (attentionCount > 0) summary.push('待处理 ' + attentionCount)
      if (asArray(pending.requests).length > 0) summary.push('待协作 ' + asArray(pending.requests).length)
      if (asArray(pending.approvals).length > 0) summary.push('待批 ' + asArray(pending.approvals).length)
      if (resource) summary.push('桌面被 ' + ambientOwnerText(resource) + ' 占用')
      return h(
        'div',
        { style: styles.ambientDock, 'data-session-bridge-ambient-dock': true },
        h(
          'div',
          { style: styles.ambientDockRow },
          h(
            'button',
            {
              type: 'button',
              onClick: function () {
                setExpanded(!expanded)
              },
              title: '展开星桥本会话态势',
              style: styles.ambientDockMain
            },
            h('span', { style: styles.ambientDockBadge }, '🌉'),
            h('span', { style: styles.ambientDockText }, '星桥 · ' + summary.join(' · '))
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: function () {
                openBridgeApp({})
              },
              title: '打开星桥指挥中心',
              style: styles.ambientDockAction
            },
            '指挥中心 ›'
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: function () {
                setExpanded(!expanded)
              },
              title: expanded ? '收起' : '详情',
              style: styles.ambientDockAction
            },
            expanded ? '收起' : '详情'
          )
        ),
        expanded
          ? h(AmbientDetailPanel, {
              sessionId: sessionId,
              ambient: ambient,
              onClose: function () {
                setExpanded(false)
              }
            })
          : null
      )
    }

    /**
     * 注意力/待办详情面板（header popover 与 composer dock 共用）。
     * 1-click 动作：approval.approve/reject、inbox.ack（panel 直执行）；
     * request/transfer 用 ambient.act steer 当前会话（宿主未实现时降级为复制命令模板）。
     */
    function AmbientDetailPanel(props) {
      var sessionId = asString(props && props.sessionId)
      var ambient = isPlainObject(props && props.ambient) ? props.ambient : null
      var noticeState = React.useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var busyState = React.useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var timerRef = React.useRef(null)
      var mountedRef = React.useRef(true)
      React.useEffect(function () {
        mountedRef.current = true
        return function () {
          mountedRef.current = false
          if (timerRef.current) {
            try {
              clearTimeout(timerRef.current)
            } catch (error) {
              /* ignore */
            }
          }
        }
      }, [])
      if (!ambient) return null

      var showNotice = function (text) {
        if (!mountedRef.current) return
        setNotice(asString(text))
        if (timerRef.current) {
          try {
            clearTimeout(timerRef.current)
          } catch (error) {
            /* ignore */
          }
        }
        timerRef.current = setTimeout(function () {
          if (mountedRef.current) setNotice('')
        }, 3200)
      }
      var runAction = function (key, promise, successText) {
        setBusy(key)
        setError('')
        promise.then(
          function (result) {
            if (!mountedRef.current) return
            setBusy('')
            if (result && result.ok === true) {
              if (successText) showNotice(successText)
              if (typeof props.onChanged === 'function') props.onChanged()
            } else if (result && result.local === true) {
              showNotice('已标记为已读（后端未确认：' + asString(result.error) + '）')
              if (typeof props.onChanged === 'function') props.onChanged()
            } else {
              setError((result && result.error) || '操作失败')
            }
          },
          function (failure) {
            if (!mountedRef.current) return
            setBusy('')
            setError(errorMessage(failure))
          }
        )
      }
      var doAck = function (ids) {
        var list = asArray(ids)
          .map(function (id) {
            return asString(id)
          })
          .filter(function (id) {
            return id !== ''
          })
        if (list.length === 0) {
          if (typeof props.onClose === 'function') props.onClose()
          return
        }
        runAction('ack', ambientStore.ack(sessionId, list), '已标记 ' + list.length + ' 条为已读')
      }
      var doApprove = function (approvalId) {
        runAction('approve:' + approvalId, ambientStore.approve(sessionId, approvalId), '已通过审批')
      }
      var doReject = function (approvalId) {
        runAction('reject:' + approvalId, ambientStore.reject(sessionId, approvalId), '已驳回审批')
      }
      var doSteerRequest = function (request) {
        var template = ambientReplyTemplate(request)
        var act = {
          kind: 'ask',
          tool: 'session_ask',
          requestId: asString(request.id || request.requestId),
          groupId: asString(request.groupId),
          text: template
        }
        var key = 'steer:' + asString(request.id || request.requestId)
        setBusy(key)
        setError('')
        ambientStore.steer(sessionId, act).then(
          function (result) {
            if (!mountedRef.current) return
            setBusy('')
            if (result && result.ok === true) {
              showNotice('已让当前会话用 session_ask 处理（稍后看回复）')
            } else {
              var copied = copyAmbientText(template)
              setError('')
              showNotice(copied ? '宿主未实现 steer：命令模板已复制，直接粘贴发送即可' : '宿主未实现 steer：请手动用 session_ask 处理 ' + asString(request.id))
            }
          },
          function (failure) {
            if (!mountedRef.current) return
            setBusy('')
            setError(errorMessage(failure))
          }
        )
      }
      var doSteerTransfer = function (transfer, approve) {
        var template = ambientTransferTemplate(transfer, approve)
        var act = {
          kind: 'transfer',
          tool: 'task_transfer',
          requestId: asString(transfer.id || transfer.requestId),
          action: approve ? 'approve' : 'reject',
          text: template
        }
        var key = 'transfer:' + asString(transfer.id || transfer.requestId) + ':' + (approve ? 'a' : 'r')
        setBusy(key)
        setError('')
        ambientStore.steer(sessionId, act).then(
          function (result) {
            if (!mountedRef.current) return
            setBusy('')
            if (result && result.ok === true) {
              showNotice('已让当前会话用 task_transfer 处理')
            } else {
              var copied = copyAmbientText(template)
              setNotice(copied ? '宿主未实现 steer：转交命令模板已复制' : '宿主未实现 steer：请手动用 task_transfer 处理 ' + asString(transfer.id))
            }
          },
          function (failure) {
            if (!mountedRef.current) return
            setBusy('')
            setError(errorMessage(failure))
          }
        )
      }

      var task = isPlainObject(ambient.task) ? ambient.task : null
      var attention = asArray(ambient.attention.items)
      var pending = isPlainObject(ambient.pending) ? ambient.pending : { requests: [], transfers: [], approvals: [], council: {} }
      var requests = asArray(pending.requests)
      var transfers = asArray(pending.transfers)
      var approvals = asArray(pending.approvals)
      var council = isPlainObject(pending.council) ? pending.council : {}
      var resource = ambientResourceConflict(ambient, sessionId)
      var attentionIds = []
      for (var idx = 0; idx < attention.length; idx += 1) attentionIds.push(asString(attention[idx].id))
      for (var aidx = 0; aidx < approvals.length; aidx += 1) attentionIds.push(asString(approvals[aidx].id))
      var approvalIdsInAttention = {}
      for (var aix = 0; aix < attention.length; aix += 1) {
        if (asString(attention[aix].kind) === 'approval' && asString(attention[aix].approvalId) !== '') {
          approvalIdsInAttention[asString(attention[aix].approvalId)] = true
        }
      }
      var extraApprovals = approvals.filter(function (approval) {
        return approvalIdsInAttention[asString(approval.id)] !== true
      })
      var visibleRequests = requests.slice(0, 3)
      var visibleTransfers = transfers.slice(0, 3)
      var rendered = []

      rendered.push(
        h(
          'div',
          { key: 'head', style: styles.ambientPanelHead },
          h('span', { style: styles.ambientPanelTitle }, '🌉 星桥 · 本会话'),
          h('span', { style: styles.ambientPanelMuted }, '自动刷新 · 只读同步'),
          typeof props.onClose === 'function'
            ? h(
                'button',
                {
                  type: 'button',
                  onClick: function () {
                    props.onClose()
                  },
                  title: '关闭',
                  style: styles.ambientPanelClose
                },
                '✕'
              )
            : null
        )
      )

      if (task) {
        var percent = ambientProgressPercent(task)
        rendered.push(
          h(
            'div',
            { key: 'task', style: styles.ambientSection },
            h('div', { style: styles.ambientSectionHead }, '🎯 当前任务'),
            h('div', { style: styles.ambientTaskTitle }, task.title || '（未命名任务）'),
            h(
              'div',
              { style: styles.ambientMetaRow },
              h('span', null, ambientTaskStageText(task) || asString(task.lineStatus) || '进行中'),
              h('span', null, percent + '%'),
              isPlainObject(task.leader) && asString(task.leader.handle || task.leader.id) !== ''
                ? h('span', null, '组长 ' + asString(task.leader.handle || task.leader.id))
                : null
            ),
            h(
              'div',
              { style: styles.ambientProgressTrack },
              h('div', { style: mergeStyle(styles.ambientProgressBar, { width: percent + '%' }) })
            ),
            task.steps.length
              ? h(
                  'div',
                  { style: styles.ambientSteps },
                  task.steps.map(function (step, stepIndex) {
                    var status = asString(step.status)
                    var mark = status === 'done' || status === 'completed' ? '☑' : status === 'active' || status === 'current' ? '◉' : '☐'
                    return h(
                      'span',
                      {
                        key: 'step-' + stepIndex,
                        style: mergeStyle(styles.ambientStep, status === 'active' || status === 'current' ? styles.ambientStepActive : null)
                      },
                      mark + ' ' + (step.text || '步骤 ' + (step.i || stepIndex + 1))
                    )
                  })
                )
              : null,
            task.flows.length
              ? h(
                  'div',
                  { style: styles.ambientFlows },
                  task.flows.slice(0, 3).map(function (flow, flowIndex) {
                    return h(
                      'div',
                      { key: 'flow-' + flowIndex, style: styles.ambientFlowLine },
                      h('span', { style: styles.ambientFlowTime }, flow.ts > 0 ? formatLocalTime(flow.ts) : ''),
                      flow.action + (flow.detail ? '：' + ambientClip(flow.detail, 40) : '')
                    )
                  })
                )
              : null,
            h(
              'div',
              { style: styles.ambientBtnRow },
              h(
                'button',
                {
                  type: 'button',
                  style: styles.ambientBtn,
                  onClick: function () {
                    openBridgeApp({ route: 'tasks', taskId: asString(task.id) })
                  }
                },
                '查看任务详情 ›'
              )
            )
          )
        )
      }

      if (attention.length > 0) {
        rendered.push(
          h(
            'div',
            { key: 'attention', style: styles.ambientSection },
            h('div', { style: styles.ambientSectionHead }, '⚠️ 注意力（' + asNumber(ambient.attention.count, attention.length) + '）'),
            attention.map(function (item, index) {
              var kind = asString(item.kind)
              var approvalId = asString(item.approvalId || (kind === 'approval' ? item.id : ''))
              var buttons = []
              if (kind === 'approval' || kind === 'approval-timeout') {
                buttons.push(
                  h(
                    'button',
                    {
                      key: 'approve',
                      type: 'button',
                      disabled: busy !== '',
                      onClick: function () {
                        doApprove(approvalId)
                      },
                      style: mergeStyle(styles.ambientBtn, styles.ambientBtnPrimary)
                    },
                    busy === 'approve:' + approvalId ? '…' : '批准'
                  ),
                  h(
                    'button',
                    {
                      key: 'reject',
                      type: 'button',
                      disabled: busy !== '',
                      onClick: function () {
                        doReject(approvalId)
                      },
                      style: styles.ambientBtn
                    },
                    busy === 'reject:' + approvalId ? '…' : '驳回'
                  )
                )
              } else if (kind === 'request' || kind === 'urgent-request') {
                buttons.push(
                  h(
                    'button',
                    {
                      key: 'reply',
                      type: 'button',
                      disabled: busy !== '',
                      onClick: function () {
                        doSteerRequest({ id: item.requestId || item.id, title: item.title, detail: item.detail })
                      },
                      style: mergeStyle(styles.ambientBtn, styles.ambientBtnPrimary)
                    },
                    busy === 'steer:' + asString(item.requestId || item.id) ? '…' : '让当前会话回复'
                  ),
                  h(
                    'button',
                    {
                      key: 'ack',
                      type: 'button',
                      disabled: busy !== '',
                      onClick: function () {
                        doAck([item.id])
                      },
                      style: styles.ambientBtn
                    },
                    '已读'
                  )
                )
              } else {
                buttons.push(
                  h(
                    'button',
                    {
                      key: 'open',
                      type: 'button',
                      onClick: function () {
                        openBridgeApp({ route: 'tasks', taskId: asString(item.taskId) })
                      },
                      style: styles.ambientBtn
                    },
                    '查看'
                  ),
                  h(
                    'button',
                    {
                      key: 'ack',
                      type: 'button',
                      disabled: busy !== '',
                      onClick: function () {
                        doAck([item.id])
                      },
                      style: styles.ambientBtn
                    },
                    '已读'
                  )
                )
              }
              return h(
                'div',
                { key: 'att-' + asString(item.id) + '-' + index, style: styles.ambientItem },
                h(
                  'div',
                  { style: styles.ambientItemHead },
                  h('span', null, ambientKindIcon(kind) + ' ' + ambientClip(item.title || '待处理事项', 40)),
                  item.ts > 0 ? h('span', { style: styles.ambientPanelMuted }, formatLocalTime(item.ts)) : null
                ),
                item.detail ? h('div', { style: styles.ambientItemDetail }, ambientClip(item.detail, 80)) : null,
                h('div', { style: styles.ambientBtnRow }, buttons)
              )
            })
          )
        )
      }

      if (visibleRequests.length > 0) {
        rendered.push(
          h(
            'div',
            { key: 'requests', style: styles.ambientSection },
            h('div', { style: styles.ambientSectionHead }, '🤝 待协作（' + requests.length + '）'),
            visibleRequests.map(function (request, index) {
              var template = ambientReplyTemplate(request)
              return h(
                'div',
                { key: 'req-' + asString(request.id) + '-' + index, style: styles.ambientItem },
                h(
                  'div',
                  { style: styles.ambientItemHead },
                  h('span', null, '📨 ' + ambientClip(request.title || request.id, 40)),
                  request.fromHandle ? h('span', { style: styles.ambientPanelMuted }, '来自 ' + asString(request.fromHandle)) : null
                ),
                h('div', { style: styles.ambientTemplate }, ambientClip(template, 120)),
                h(
                  'div',
                  { style: styles.ambientBtnRow },
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: busy !== '',
                      onClick: function () {
                        openBridgeApp({ route: asString(request.groupId) !== '' ? 'groups' : 'inbox', groupId: asString(request.groupId) })
                      },
                      style: styles.ambientBtn
                    },
                    '打开上下文'
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: busy !== '',
                      onClick: function () {
                        doSteerRequest(request)
                      },
                      style: mergeStyle(styles.ambientBtn, styles.ambientBtnPrimary)
                    },
                    busy === 'steer:' + asString(request.id) ? '…' : '让当前会话回复'
                  )
                )
              )
            })
          )
        )
      }

      if (visibleTransfers.length > 0) {
        rendered.push(
          h(
            'div',
            { key: 'transfers', style: styles.ambientSection },
            h('div', { style: styles.ambientSectionHead }, '🔁 转交申请（' + transfers.length + '）'),
            visibleTransfers.map(function (transfer, index) {
              return h(
                'div',
                { key: 'tr-' + asString(transfer.id) + '-' + index, style: styles.ambientItem },
                h('div', { style: styles.ambientItemHead }, h('span', null, '🔁 ' + ambientClip(transfer.title || asString(transfer.id), 40))),
                h(
                  'div',
                  { style: styles.ambientBtnRow },
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: busy !== '',
                      onClick: function () {
                        doSteerTransfer(transfer, true)
                      },
                      style: mergeStyle(styles.ambientBtn, styles.ambientBtnPrimary)
                    },
                    '批准转交'
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: busy !== '',
                      onClick: function () {
                        doSteerTransfer(transfer, false)
                      },
                      style: styles.ambientBtn
                    },
                    '驳回'
                  )
                )
              )
            })
          )
        )
      }

      if (extraApprovals.length > 0) {
        rendered.push(
          h(
            'div',
            { key: 'approvals', style: styles.ambientSection },
            h('div', { style: styles.ambientSectionHead }, '🛡️ 待审批（' + extraApprovals.length + '）'),
            extraApprovals.map(function (approval, index) {
              return h(
                'div',
                { key: 'ap-' + asString(approval.id) + '-' + index, style: styles.ambientItem },
                h('div', { style: styles.ambientItemHead }, h('span', null, ambientClip(approval.title || asString(approval.id), 40))),
                approval.reason ? h('div', { style: styles.ambientItemDetail }, ambientClip(approval.reason, 80)) : null,
                h(
                  'div',
                  { style: styles.ambientBtnRow },
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: busy !== '',
                      onClick: function () {
                        doApprove(approval.id)
                      },
                      style: mergeStyle(styles.ambientBtn, styles.ambientBtnPrimary)
                    },
                    busy === 'approve:' + asString(approval.id) ? '…' : '批准'
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: busy !== '',
                      onClick: function () {
                        doReject(approval.id)
                      },
                      style: styles.ambientBtn
                    },
                    '驳回'
                  )
                )
              )
            })
          )
        )
      }

      if (council.isMember === true && asNumber(council.pendingApprovals, 0) > 0) {
        rendered.push(
          h(
            'div',
            { key: 'council', style: styles.ambientSection },
            h('div', { style: styles.ambientSectionHead }, '🏛️ 小议会'),
            h(
              'div',
              { style: styles.ambientItemDetail },
              '你是议员：有 ' + asNumber(council.pendingApprovals, 0) + ' 条待批。请让当前会话用 council_vote 投票（UI 不代投）。'
            ),
            h(
              'div',
              { style: styles.ambientBtnRow },
              h(
                'button',
                {
                  type: 'button',
                  disabled: busy !== '',
                  onClick: function () {
                    var template = '【星桥内联动作】请用 council_vote action=status 查看待批，再用 action=vote vote=approve|reject 处理。'
                    var act = { kind: 'council', tool: 'council_vote', text: template }
                    setBusy('council')
                    setError('')
                    ambientStore.steer(sessionId, act).then(
                      function (result) {
                        if (!mountedRef.current) return
                        setBusy('')
                        if (result && result.ok === true) showNotice('已让当前会话用 council_vote 处理')
                        else if (copyAmbientText(template)) showNotice('已复制投票指令模板')
                      },
                      function (failure) {
                        if (!mountedRef.current) return
                        setBusy('')
                        setError(errorMessage(failure))
                      }
                    )
                  },
                  style: styles.ambientBtn
                },
                '让当前会话投票'
              )
            )
          )
        )
      }

      if (resource) {
        rendered.push(
          h(
            'div',
            { key: 'resource', style: styles.ambientSection },
            h('div', { style: styles.ambientSectionHead }, '🖥️ computer-use 资源'),
            h(
              'div',
              { style: styles.ambientItemDetail },
              '桌面被 ' +
                ambientOwnerText(resource) +
                ' 占用（TTL ' +
                Math.max(0, Math.round(asNumber(resource.ttlMs, 0) / 1000)) +
                's）。不要抢，先等待或询问用户。'
            )
          )
        )
      }

      rendered.push(
        h(
          'div',
          { key: 'foot', style: styles.ambientPanelFoot },
          notice !== '' ? h('div', { style: styles.ambientPanelNotice }, notice) : null,
          error !== '' ? h('div', { style: styles.ambientPanelError }, error) : null,
          h(
            'div',
            { style: styles.ambientBtnRow },
            h(
              'button',
              {
                type: 'button',
                disabled: busy !== '' || attentionIds.length === 0,
                onClick: function () {
                  doAck(attentionIds)
                },
                style: mergeStyle(styles.ambientBtn, styles.ambientBtnPrimary)
              },
              busy === 'ack' ? '…' : '全部已读'
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: function () {
                  openBridgeApp({})
                },
                style: styles.ambientBtn
              },
              '打开星桥指挥中心'
            ),
            h('span', { style: styles.ambientPanelMuted }, ambient.generatedAt > 0 ? '更新于 ' + formatLocalTime(ambient.generatedAt) : '')
          )
        )
      )

      return h('div', { style: styles.ambientPanel, 'data-session-bridge-ambient-panel': true }, rendered)
    }
    //#endregion

    //#region 面板主体
    function TabBar(props) {
      var tabs = [
        { key: 'world', label: '世界', count: asArray(props.state.world).length },
        { key: 'groups', label: '群组', count: asArray(props.state.groups).length }
      ]
      return h(
        'div',
        { style: styles.tabBar, role: 'tablist' },
        tabs.map(function (tab) {
          var active = props.tab === tab.key
          return h(
            'button',
            {
              key: tab.key,
              type: 'button',
              role: 'tab',
              'aria-selected': active,
              onClick: function () {
                props.onChange(tab.key)
              },
              style: mergeStyle(styles.tabButton, active ? styles.tabButtonActive : null)
            },
            tab.label + ' ' + tab.count
          )
        })
      )
    }

    function SessionBridgePanelInner(props) {
      var dataState = React.useState(null)
      var data = dataState[0]
      var setData = dataState[1]
      var loadingState = React.useState(true)
      var loading = loadingState[0]
      var setLoading = loadingState[1]
      var errorState = React.useState(null)
      var error = errorState[0]
      var setError = errorState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var tabState = React.useState('world')
      var tab = tabState[0]
      var setTab = tabState[1]
      var settingsState = React.useState(false)
      var settingsOpen = settingsState[0]
      var setSettingsOpen = settingsState[1]
      var refreshedState = React.useState(0)
      var refreshedAt = refreshedState[0]
      var setRefreshedAt = refreshedState[1]
      // 操作成功后的轻量 toast（撤回/打断等），2.6 秒自动消失。
      var noticeState = React.useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var noticeTimerRef = React.useRef(null)
      var showNotice = React.useCallback(function (text) {
        var message = asString(text).trim()
        if (!message) return
        setNotice(message)
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = setTimeout(function () {
          if (mountedRef.current) setNotice('')
        }, 2600)
      }, [])
      var mountedRef = React.useRef(true)
      var seqRef = React.useRef(0)

      var refresh = React.useCallback(function () {
        var seq = seqRef.current + 1
        seqRef.current = seq
        loadState().then(
          function (next) {
            if (!mountedRef.current || seq !== seqRef.current) return
            setData(next)
            setError(null)
            setLoading(false)
            setRefreshedAt(Date.now())
          },
          function (failure) {
            if (!mountedRef.current || seq !== seqRef.current) return
            setError(errorMessage(failure))
            setLoading(false)
          }
        )
      }, [])

      React.useEffect(
        function () {
          mountedRef.current = true
          refresh()
          var timer = setInterval(function () {
            if (typeof document !== 'undefined' && document.hidden) return
            refresh()
          }, POLL_INTERVAL_MS)
          return function () {
            mountedRef.current = false
            clearInterval(timer)
            if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
          }
        },
        [refresh]
      )

      var run = React.useCallback(
        function (action, payload, successText) {
          setBusy(true)
          setError(null)
          return sendCommand(action, payload).then(
            function (next) {
              if (!mountedRef.current) return false
              if (next) {
                setData(next)
                setRefreshedAt(Date.now())
              } else {
                refresh()
              }
              setBusy(false)
              if (successText) showNotice(successText)
              return true
            },
            function (failure) {
              if (mountedRef.current) {
                setError(errorMessage(failure))
                setBusy(false)
              }
              return false
            }
          )
        },
        [refresh, showNotice]
      )

      var index = React.useMemo(
        function () {
          return buildIndexes(data)
        },
        [data]
      )

      var state = data || EMPTY_STATE_FOR_RENDER
      var hasError = error !== null && error !== ''

      var body = null
      if (data === null && loading) {
        body = h(EmptyHint, null, '正在加载经验桥状态…')
      } else if (data === null && hasError) {
        body = h(
          'div',
          null,
          h(EmptyHint, null, '状态加载失败：' + error),
          h(
            'div',
            { style: { textAlign: 'center' } },
            h(
              Btn,
              {
                variant: 'primary',
                onClick: function () {
                  setLoading(true)
                  refresh()
                }
              },
              '重试'
            )
          )
        )
      } else if (tab === 'groups') {
        body = h(GroupsSection, { state: state, index: index, run: run, busy: busy, onRefresh: refresh })
      } else {
        body = h(WorldSection, { state: state, index: index, run: run, busy: busy, onRefresh: refresh })
      }
      if (settingsOpen) {
        body = h(SettingsSection, { state: state, run: run, busy: busy })
      }

      var statsText = ''
      if (data !== null) {
        statsText =
          state.world.length + ' 世界消息 · ' + state.groups.length + ' 群组 · ' + state.sessions.length + ' 会话 · ' + Object.keys(state.profiles || {}).length + ' 申报'
      }
      var versionText = data !== null && state.version !== '' ? ' v' + state.version : ''

      return h(
        'div',
        { style: styles.root, 'data-session-bridge-panel': true },
        h(
          'div',
          { style: styles.header },
          h('span', { style: styles.headerTitle }, '🌌 星桥'),
          versionText !== '' ? h('span', { style: mergeStyle(styles.rowMuted, { flex: 'none' }) }, versionText) : null,
          h('span', { style: styles.headerMeta, title: statsText }, statsText),
          h(
            Btn,
            {
              variant: settingsOpen ? 'primary' : 'ghost',
              ariaLabel: settingsOpen ? '返回' : '打开设置',
              onClick: function () {
                setSettingsOpen(!settingsOpen)
              }
            },
            settingsOpen ? '‹ 返回' : '⚙ 设置'
          ),
          h(
            Btn,
            {
              variant: 'primary',
              title: '在新窗口打开星桥指挥中心',
              ariaLabel: '打开星桥指挥中心',
              onClick: function () {
                openBridgeApp({})
              }
            },
            '🪟 指挥中心'
          ),
          h(
            Btn,
            {
              variant: 'ghost',
              disabled: busy,
              title: refreshedAt > 0 ? '最近刷新：' + formatLocalTime(refreshedAt) : '刷新',
              ariaLabel: '刷新看板状态',
              onClick: refresh
            },
            busy ? '刷新中…' : '↻ 刷新'
          )
        ),
        h(CommandCenterStrip, {
          state: state,
          hasData: data !== null,
          busy: busy,
          onOpenApp: openBridgeApp,
          onRefresh: refresh
        }),
        h(ErrorBanner, {
          message: hasError ? error : null,
          onDismiss: function () {
            setError(null)
          }
        }),
        notice !== ''
          ? h(
              'div',
              {
                role: 'status',
                style: {
                  position: 'fixed',
                  right: 16,
                  bottom: 46,
                  zIndex: 60,
                  maxWidth: 300,
                  background: 'var(--dsw-alias-bg-layer-2)',
                  color: 'var(--dsw-alias-label-primary)',
                  border: '0.5px solid var(--dsw-alias-border-l3)',
                  borderRadius: 10,
                  padding: '8px 12px',
                  fontSize: 12,
                  boxShadow: '0 10px 30px rgba(0,0,0,.28)'
                }
              },
              notice
            )
          : null,
        data !== null && !settingsOpen ? h(TabBar, { tab: tab, state: state, onChange: setTab }) : null,
        h('div', { style: styles.content }, body),
        h(
          'div',
          { style: styles.footerBar },
          h('span', null, '每 5 秒自动刷新 · 只读同步'),
          h('span', null, refreshedAt > 0 ? '最近 ' + formatLocalTime(refreshedAt) : '尚未刷新')
        )
      )
    }

    var EMPTY_STATE_FOR_RENDER = normalizeState({})

    /** 对外暴露的面板组件：ErrorBoundary 包裹，渲染异常也不白屏。 */
    function SessionBridgePanel(props) {
      return h(PanelErrorBoundary, null, h(SessionBridgePanelInner, props))
    }
    //#endregion

    //#region 左侧栏底部入口
    function BridgeIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { flex: 'none' }
        },
        h('path', {
          d: 'M6.4 9.6 4.7 11.3a2.3 2.3 0 0 1-3.3-3.3l2-2a2.3 2.3 0 0 1 3.2-.1'
        }),
        h('path', {
          d: 'M9.6 6.4l1.7-1.7a2.3 2.3 0 0 1 3.3 3.3l-2 2a2.3 2.3 0 0 1-3.2.1'
        }),
        h('path', { d: 'M6.1 9.9 9.9 6.1' })
      )
    }

    /**
     * 打开右侧经验桥面板。
     *
     * 坑：右侧栏从未展开过的会话里，controller.openTab() 会抛
     * "sidebarRight: no session surface is mounted"（store 还没被 adopt），
     * 而左侧栏底部按钮在任何时候都在，所以必须两级兜底：
     *   1) 直接 openTab（右侧栏已展开/已 adopt 时可用）；
     *   2) 失败则点内置的「展开右侧边栏」按钮（它是 header 槽里的组件，
     *      持有 sidebar-right 的 store actions，不依赖 adopt），等面板挂载后再 retry。
     */
    function openBoard(ctx) {
      var warned = false
      var attempt = 0
      var lastError = null
      var panelSelector = '[data-session-bridge-panel]'
      function warnOnce(error) {
        if (warned) return
        warned = true
        try {
          console.warn('[session-bridge] 无法打开右侧经验桥看板：', error)
        } catch (e) {
          // 控制台不可用时静默降级。
        }
      }
      function hasDom() {
        return typeof document !== 'undefined' && document !== null && typeof document.querySelector === 'function'
      }
      function isMounted() {
        try {
          if (!hasDom()) return false
          const element = document.querySelector(panelSelector)
          if (element === null) return false
          // 必须「真正可见」：右侧栏收起时面板只是被 transform 平移出屏，元素仍在、
          // 仍有 rect，所以要看 rect 是否落在视口内。
          const rect = element.getBoundingClientRect()
          const viewportWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 0
          return rect.width > 0 && rect.height > 0 && rect.left < viewportWidth - 20 && rect.right > 0
        } catch (e) {
          return false
        }
      }
      /** 已存在经验桥 tab chip 但没被激活时，直接点它的 chip。 */
      function clickTabChip() {
        if (!hasDom()) return false
        try {
          const chips = document.querySelectorAll('[data-dockkit-tab], [data-sidebar-right-tab]')
          for (let i = 0; i < chips.length; i += 1) {
            const chip = chips[i]
            const text = chip && typeof chip.textContent === 'string' ? chip.textContent : ''
            if (text.indexOf('经验桥') >= 0 && typeof chip.click === 'function') {
              chip.click()
              return true
            }
          }
        } catch (e) {
          /* ignore */
        }
        return false
      }
      function openTabNow() {
        try {
          ctx.sidebarRight.openTab(TAB_KIND, { replaceTab: true })
        } catch (error) {
          lastError = error
        }
      }
      /** 直接调用 DOM 节点上的 React onClick（有些 Button 对合成 click 不响应时的兜底）。 */
      function invokeReactClick(node) {
        try {
          var key = Object.keys(node).find(function (name) {
            return name.indexOf('__reactProps' + '$') === 0
          })
          var props = key ? node[key] : null
          if (props && typeof props.onClick === 'function') {
            props.onClick({ preventDefault: function () {}, stopPropagation: function () {} })
            return true
          }
        } catch (e) {
          /* ignore */
        }
        return false
      }
      /** 只有右侧栏处于「收起」状态时才点内置展开按钮；已展开时不要 toggle（会把它关掉）。 */
      function expandIfCollapsed() {
        if (!hasDom()) return false
        try {
          var triggers = document.querySelectorAll('[data-sidebar-right-expand], [data-sidebar-right-toggle]')
          for (var i = 0; i < triggers.length; i += 1) {
            var trigger = triggers[i]
            if (trigger && trigger.getClientRects().length > 0) {
              invokeReactClick(trigger)
              if (typeof trigger.click === 'function') trigger.click()
              return true
            }
          }
        } catch (e) {
          /* ignore */
        }
        return false
      }
      /** 收起状态下直接调 controller.toggleExpanded（只在确实收起时调用，避免把已展开的关掉）。 */
      function toggleIfCollapsed() {
        if (!hasDom()) return false
        try {
          if (document.querySelector('[data-sidebar-right-open]')) return false
          ctx.sidebarRight.toggleExpanded()
          return true
        } catch (e) {
          return false
        }
      }
      // 非浏览器环境（离线契约测试/桩运行时）：只尝试一次并降级告警。
      if (!hasDom()) {
        openTabNow()
        if (lastError) warnOnce(lastError)
        return
      }
      openTabNow()
      function tick() {
        if (isMounted()) return
        attempt += 1
        if (attempt > 10) {
          warnOnce(lastError || new Error('经验桥面板在 10 次重试后仍未挂载'))
          return
        }
        // 展开按钮只出现在「右侧栏收起 + 会话界面」；与 openTab 交替尝试，覆盖
        // 「右侧栏从未展开过（store 未 adopt）」「已展开但打开被打断」
        // 「tab 建了但没切到前台」三种情况。
        if (attempt % 2 === 1) expandIfCollapsed()
        if (attempt % 4 === 0) toggleIfCollapsed()
        if (attempt % 3 === 0) clickTabChip()
        openTabNow()
        setTimeout(tick, 220)
      }
      setTimeout(tick, 240)
    }

    /** 打开独立「星桥」窗口（不再使用右侧栏/浮窗面板）。 */
    function openBridgeWindow() {
      var url = '/session-bridge/app'
      try {
        if (bridgeWindowRef && !bridgeWindowRef.closed) {
          focusBridgeWindow(bridgeWindowRef)
          return true
        }
      } catch (e) { /* ignore */ }
      try {
        var win = window.open(url, APP_WINDOW_NAME, APP_WINDOW_FEATURES)
        if (win) {
          bridgeWindowRef = win
          focusBridgeWindow(win)
          return true
        }
      } catch (e) {
        /* fall through */
      }
      try {
        window.open(url, '_blank')
        return true
      } catch (e) {
        return false
      }
    }

    /** 左侧栏底部入口：点击直接打开星桥独立窗口。 */
    function OpenBoardButton(ctx) {
      return function SessionBridgeFooterAction(props) {
        var wide = !props || props.wide !== false
        return h(
          'button',
          {
            type: 'button',
            'data-session-bridge-footer': true,
            title: '打开星桥独立窗口',
            'aria-label': '打开星桥独立窗口',
            onClick: function () {
              openBridgeWindow()
            },
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: wide ? 'flex-start' : 'center',
              gap: 6,
              width: wide ? '100%' : 'auto',
              boxSizing: 'border-box',
              padding: wide ? '5px 8px' : '5px',
              borderRadius: 8,
              border: '0.5px solid var(--dsw-alias-border-l4)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              fontFamily: FONT_STACK,
              fontSize: 12,
              lineHeight: 1.3,
              cursor: 'pointer'
            }
          },
          h(BridgeIcon, null),
          wide ? h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '星桥') : null,
          wide ? h('span', { style: mergeStyle(styles.rowMuted, { flex: 1, textAlign: 'right' }) }, '新窗口') : null
        )
      }
    }

    //#region 插件注册
    /**
     * 4.0：恢复「右侧栏常驻入口」——注册星桥 tab 类型 + pane 主体（顶部指挥中心摘要 +
     * 原世界/群组/设置面板），并保留左侧栏底部入口（打开独立指挥中心窗口）。
     * 独立窗口仍承载完整 4.0 指挥中心；右侧栏只做低打扰摘要，默认折叠。
     * 任何注册失败都只降级（例如宿主版本没有 sidebarRightTabs），不能影响侧栏其它功能。
     */
    function apply(ctx) {
      // v4.2 简约耦合：DSH 主界面只保留会话 header 的一个星桥 chip。
      // 右侧栏 tab/pane/footer、composer dock、自动弹泡全部移除；完整控制台在独立 app。
      try {
        if (ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
          ctx.effect(
            function () {
              return ctx.slots.inject('conversation.session.header.utilities', function () {
                return ctx.slots.register(
                  {
                    name: 'conversation.session.header.utilities',
                    id: 'session-bridge-ambient-chip',
                    order: -10,
                    inject: function (sessionId) {
                      return { ambientSessionId: asString(sessionId) }
                    }
                  },
                  ambientSafeComponent(AmbientChip)
                )
              })
            },
            'session-bridge: ambient header chip'
          )
        }
      } catch (error) {
        try {
          console.warn('[session-bridge] 注册 header 星桥 chip 失败（降级隐藏）：', error)
        } catch (e) { /* ignore */ }
      }
    }



    exports.apply = apply
    exports.inject = ['slots']
    exports.SessionBridgePanel = SessionBridgePanel
    exports.SessionBridgePanelInner = SessionBridgePanelInner
    exports.PanelErrorBoundary = PanelErrorBoundary
    exports.normalizeState = normalizeState
    exports.normalizeRule = normalizeRule
    exports.normalizeDeliveries = normalizeDeliveries
    exports.buildIndexes = buildIndexes
    exports.formatLocalTime = formatLocalTime
    exports.shortId = shortId
    exports.cwdTail = cwdTail
    exports.isLongText = isLongText
    exports.buildCommandRequest = buildCommandRequest
    // 下列组件仅为桩测试（_recon/client-smoke.mjs）可渲染性检查而导出，运行时不依赖。
    exports.TabBar = TabBar
    exports.DeliveryChips = DeliveryChips
    exports.RuleCard = RuleCard
    exports.CreateRuleForm = CreateRuleForm
    exports.RulesSection = RulesSection
    exports.CreateGroupForm = CreateGroupForm
    exports.GroupCard = GroupCard
    exports.GroupsSection = GroupsSection
    exports.SessionRow = SessionRow
    exports.SessionsSection = SessionsSection
    exports.SettingsSection = SettingsSection
    exports.OpenBoardButton = OpenBoardButton
    // 4.1 无感入口（ambient store + header chip + composer dock + 注意力气泡），供冒烟/静态检查使用。
    exports.normalizeAmbient = normalizeAmbient
    exports.ambientStore = ambientStore
    exports.ambientIsUsable = ambientIsUsable
    exports.AmbientChip = AmbientChip
    exports.AmbientDock = AmbientDock
    exports.AmbientDetailPanel = AmbientDetailPanel
    exports.ambientSafeComponent = ambientSafeComponent
    // 4.0 右侧栏指挥中心（供冒烟/静态检查使用）
    exports.CommandCenterStrip = CommandCenterStrip
    exports.CommandCenterChip = CommandCenterChip
    exports.inboxItemNav = inboxItemNav
    exports.openBridgeApp = openBridgeApp
    exports.KIND_LABELS = KIND_LABELS
    exports.PLUGIN_ID = PLUGIN_ID
    exports.TAB_KIND = TAB_KIND
    return module.exports
  }
})
