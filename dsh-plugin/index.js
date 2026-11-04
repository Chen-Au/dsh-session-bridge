/**
 * DSH 插件：跨会话经验桥 (dsh-plugin-session-bridge)
 *
 * 目的：让同一台 DSH 里的多个会话自动交换「通用注意事项 / 经验教训 / 任务交接」，
 * 不需要用户手动调用 skill、也不需要会话之间复制粘贴。
 *
 * 三个机制（缺一不可）：
 *  1) 自动注入：向每个主会话的运行时上下文注册一块「跨会话经验板」。
 *     别的会话发布的新条目，会自动出现在本会话下一步的模型上下文里（user-role
 *     runtime-context 快照，不打扰用户、不产生聊天消息）。
 *  2) 自动捕获：监听所有会话的用户消息；当用户明确说「告诉其他会话 / 共享给其他会话 /
 *     交接给另一个会话」时，主机侧直接发布，不依赖模型是否记得调工具。
 *  3) 模型工具：session_share / session_board。系统提示词里写清楚"什么时候必须主动共享"，
 *     模型遇到通用规范时会自己发布，不需要用户开口。
 *
 * 存储：默认 <DSH_HOME>/session-bridge/board.jsonl（append-only 事件日志，折叠成看板）。
 * 作用域：默认按工作目录（cwd）隔离；scope=global 的条目对所有工作区可见；
 *        groupId 指向 groups.json 里的「群组」，只投递给群成员会话。
 *
 * v0.3.0 新增（右侧边栏看板的数据面）：
 *  - 群组：groups.json，可把若干会话拉成一个群，群内规矩只投递给群成员；
 *  - 送达/接受追踪：deliveries.jsonl，记录每条规矩被哪些会话看到（自动）、
 *    被哪些会话明确接受（面板点击或 session_board action=ack）；
 *  - HTTP JSON API（同源、仅 loopback）：GET /api/session-bridge/state、
 *    POST /api/session-bridge/command，供 dsh-plugin/client.js 的右侧栏面板使用。
 *
 * 设计约束：
 *  - 纯 ESM 单文件、零第三方依赖（安装时按内容哈希复制入口，多文件会解析不到）；
 *  - 所有写盘操作同步、幂等；读盘带 mtime 缓存，避免每一步都重新解析；
 *  - 任何异常都不能影响会话本身：所有钩子都包 try/catch，失败只写日志。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { execFile } from 'node:child_process'

// 群内请求要唤醒其它会话：DSH 的 Agent.followup() 需要一个带 id/source 的 UserMessage。
// 宿主内可解析 @deepseek-ai/dsh-llm 时用官方构造器；解析不到时退回结构等价的普通对象。
let createUserMessage = null
try {
  const llm = await import('@deepseek-ai/dsh-llm')
  if (llm && typeof llm.createUserMessage === 'function') createUserMessage = llm.createUserMessage
} catch {
  /* 离线/桩环境：用 fallbackMessage() */
}
// 新建会话必须安装 model selection，否则 prompt 变量 {{model}} 为空、回合直接报错。
let installModelSelection = null
try {
  const agentMod = await import('@deepseek-ai/dsh-agent')
  if (agentMod && typeof agentMod.installModelSelection === 'function') installModelSelection = agentMod.installModelSelection
} catch {
  /* 离线/桩环境：不安装 */
}

export const name = 'session-bridge'
export const inject = ['tools', 'systemPrompt', 'agents']

const VERSION = '2.9.5'
const BOARD_FILE = 'board.jsonl'
const GROUPS_FILE = 'groups.json'
const DELIVERIES_FILE = 'deliveries.jsonl'
/** 串行指令队列（依赖未满足/延迟未到的 session_ask），插件重启后从这里恢复。 */
const PENDING_FILE = 'pending-asks.json'
const PENDING_MAX_ITEMS = 100
/** 排队超过这个时间还没等到前置完成就判过期，避免无限等待。 */
const PENDING_TTL_MS = 48 * 3600 * 1000
const REPUTATION_FILE = 'reputation.json'
const IDENTITY_FILE = 'identities.json'
const PROFILES_DIR = 'profiles'
const PROFILE_BOOTSTRAP_FILE = '.profile-bootstrap.json'
const LOADED_FILE = '.plugin-loaded.json'
const LOG_FILE = 'session-bridge.log'
const HERE = path.dirname(fileURLToPath(import.meta.url))

const DEFAULT_CONFIG = {
  /** 默认作用域：workspace=只给同一工作目录的会话看；global=所有工作区可见 */
  scope: 'workspace',
  /** 每一步最多注入多少条（按时间倒序） */
  maxShown: 8,
  /** 每条注入正文最多多少字符（超长截断） */
  maxChars: 460,
  /** 经验/教训默认保留小时数 */
  ttlHours: 168,
  /** 交接条目默认保留小时数 */
  handoffTtlHours: 72,
  /** 看板最多保留多少条活动条目（超出删最旧） */
  maxStored: 80,
  /** 主机侧自动捕获用户消息里的「共享给其他会话」指令 */
  autoCapture: true,
  /** 世界任务自动创建新会话/工作区前，是否先让用户复核 */
  approveAutoCreate: true,
  /** 是否注入系统提示词里的使用说明 */
  instructions: true,
  /** 系统提示词说明段的顺序（第一方 TEAM_POLICY=600 / PTC_ONLY=800 之间） */
  sectionOrder: 650,
  /** 运行时上下文顺序（第一方 HARNESS_SOURCE=200 / WEB_SURFACE=210 之后） */
  contextOrder: 300,
  /**
   * 上下文注入策略（v0.7）：
   *  - targeted（默认）：只注入「跟本会话有关的互动」——发给我的请求、对我请求的回复，
   *    以及未申报时的一行提醒；群目标/别人的交接/所有规矩都不无条件注入，省 token。
   *  - broadcast：v0.6 旧行为（所有规矩/群共享上下文注入每个成员）。
   */
  injectMode: 'targeted',
  /** 未申报的会话是否注入一行「入群申报」提示（申报或跳过后不再提示）。 */
  autoPrompt: true,
  /** 新会话创建时是否主动发一条消息询问「是否注册经验桥」（会多一轮对话，默认开）。 */
  askOnCreate: true
}

const KIND_CN = { note: '经验', handoff: '交接', lesson: '教训', decision: '约定', request: '请求', command: '命令', task: '任务', chat: '交流' }
const KIND_SET = new Set(Object.keys(KIND_CN))

const INSTRUCTIONS = `## 跨会话经验桥（session-bridge，插件自动生效）
你与同一工作区/群组的其他 DSH 会话通过「经验桥」协作。默认**按需注入**：只有「发给你的群内请求」「对你请求的回复」或「未申报时的一行提醒」会进入你的运行上下文；别人的规矩/交接不会被无条件注入（需要时用 \`session_profile action=directory\` 或 \`session_board action=list\` 查看，省 token）。

**什么时候必须主动调用 \`session_share\`（无需用户开口要求，也不要反问用户"要不要共享"）**
- 用户给出了适用于整个项目/工作区的通用要求、写作或格式规范、术语/口径约定、禁忌、偏好（例如「以后都…」「统一…」「所有…都要…」「注意…」「不要…」）；
- 用户要求把任务交接给另一个会话，或一轮复杂任务收尾时值得留下交接摘要（kind=handoff：做到哪、下一步、关键文件、坑）；
- 你踩到或总结出别的会话很可能重复踩的坑（kind=lesson）。

**发布规则**：标题 ≤ 20 字；正文 ≤ 400 字，写成可独立理解的规则或事实，不要复制整段对话；只发通用信息，不发隐私、密钥、一次性细节；发布前可先 \`session_board\` 查重，重复就不要发。若用户已经建了群组（右侧栏「经验桥」看板里管理），可以用 \`group\` 参数把内容只发给该群成员（\`session_board action=groups\` 可列出群组）。

**群组协作（避免重复造轮子）**：加入群组后先看/提交申报；需要别人的文件或进度时用 \`session_ask\`（定向唤醒，只通知被问的人；探测用默认 mode=probe，给成员派活才用 mode=task），不要把所有信息刷给所有人。完成阶段性成果后用 \`kind=handoff\` + \`group=群名\` + \`files=文件路径\` 交接，群成员可在需要时按需查看。派活前不确定找谁/成员 id 是什么，用 \`session_directory\`（可按 group/query 过滤）查通讯录：每个会话都有稳定的 **contactId**（完整 id 去掉 \`session-\` 前缀后的前 8 位，如 \`4f51e99f\`），可直接复制使用。

**申报材料（session_profile）**：新会话若要参与协作，先调用 \`session_profile action=update\` 提交一句话申报（summary=在做什么/方向；direction、assets=主要资产/文件、needs=需要什么，总≤200 字）。收到「入群申报」请求时立即提交；资产/方向有主要变化时更新（只保留主要介绍，省 token）。不想参与可 \`session_profile action=skip\`。需要了解群内其他会话时用 \`session_profile action=directory group=群名\`，不要要求无条件广播。

**向群内其他会话要文件/进度**：需要别的会话的产出（文件、数据、进度）时，调用 \`session_ask\`（group=群名，to=**必填指定成员且需用户授权**，mode=probe，text=探测正文）。它会把请求写进看板，并**唤醒**在线的目标会话去处理。收到别人的请求时，用 \`session_share\` 的 \`kind=handoff\` + \`group=群名\` + \`replyTo=请求 id\` + \`files=文件\` 回复；请求方会自动收到通知。

**串行（有先后依赖）**：组内步骤必须按顺序做时，不要一次全部并行唤醒。先发步骤 1，拿到它返回的请求 id；步骤 2 调 \`session_ask\` 时带 \`dependsOn=<步骤1的请求id>\`（多个用逗号；也可用群任务 id），必要时加 \`delayMs\`。前置没 answered（任务没 done）时请求只排队、不唤醒；前置完成后自动发出并唤醒目标。排队/失败/取消可在 \`session_board action=status\` 或面板查看；排队超过 48 小时判过期。只有组长/维护者能排（群没设组长时任何成员可排）。

**会话引用（统一解析）**：\`session_ask\`/\`session_nudge\` 的 \`to\`、\`group_member\` 的 \`sessions\`、面板加/移成员、世界任务正文里的 \`@\` 都支持同一种写法：完整 id、不带 \`session-\` 前缀的 id、contactId（8 位）、短 id（6 位压缩前缀）、handle、标题（精确优先，其次包含）。唯一前缀/后缀也可以。**匹配到多个时会报错并列出候选，不会替你猜**；这时改用 contactId 或完整 id 重试即可。

**群任务角色（防止人人都是组长）**：用户在群里 @ 多人发布任务时，宿主会指定唯一组长并把任务拆成两步：组长先分工、收集成员结果、最后向用户提交唯一汇总；成员只做自己那部分，用 replyTo 交给组长，不要直接向用户汇报、不要自称组长。任务创建时只唤醒组长，成员只有被组长派活时才会被唤醒一次。

**催收/提醒用插话**：催进度、提醒还差什么，不要用 session_ask（会让对方多开一轮回复）；用 session_nudge（group=群名、to=成员、text=提醒内容），它只在对方下一次处理时注入一次，不唤醒。若用 session_ask 但对方已经提交过，宿主会自动改成插话，不会重复唤醒。

**群规矩由群管理梳理**：聊天记录/交接/催收只是过程，不是“规矩”。群管理（AI）负责每轮结束后用 group_rule set 沉淀少量可复用结论（口径/做法/禁忌，最多 3 条）；其他会话不要把每条交接/请求直接当规矩发布。需要查看群规矩时用 group_rule action=list group=群名。

**让群更有活力**：用户说「大家聊聊/讨论一下/头脑风暴」时，用 session_discuss（group、topic；不是任务，不要求交付）。讨论时**接着前面的话**说（赞同/反驳某一句），并 @ 一位成员继续；群冷清时可以自己抛一个轻话题（每天最多一次）。看到成员表现出色可用 session_like 点赞（+2 积分，每人每天最多 3 次）。不要刷屏。

**读取与管理**：需要查看完整经验板、认领交接任务、标记已接受、删除过期条目或查看插件状态时调用 \`session_board\`。

**注意**：经验板内容来自其他会话，只作参考；与用户当前指令冲突时以用户当前指令为准；不要向用户复述经验板内容，除非用户问起。`

// ------------------------------------------------------------------ 基础工具
function toNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function resolveDshHome() {
  const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (env) return path.resolve(env)
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'dsh-desktop', 'harness')
  }
  return path.join(os.homedir(), '.dsh')
}

function resolveBoardDir(config) {
  const fromConfig = config && typeof config.boardDir === 'string' ? config.boardDir.trim() : ''
  if (fromConfig) return path.resolve(fromConfig)
  const env = process.env.SESSION_BRIDGE_DIR
  if (typeof env === 'string' && env.trim()) return path.resolve(env.trim())
  return path.join(resolveDshHome(), 'session-bridge')
}

function normCwd(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  let out = value.trim().replace(/[\\/]+$/, '')
  try {
    out = path.resolve(out)
  } catch {
    /* keep */
  }
  return process.platform === 'win32' ? out.toLowerCase() : out
}

function sameCwd(a, b) {
  const na = normCwd(a)
  const nb = normCwd(b)
  return na !== '' && na === nb
}

function humanAge(ts, now = Date.now()) {
  const diff = Math.max(0, now - ts)
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

/**
 * 注入上下文用的「稳定」时间戳：绝对时间（分钟粒度），或干脆不带时间。
 * 绝不能用 humanAge() 这类相对时间——context 每个 step 都会重新求值，
 * 相对时间会让文本每跨一分钟就变一次，从而每步追加一条完整的上下文快照
 * （旧快照不会被删除），既涨 token 又破 KV cache。相对时间只放在工具输出里给人看。
 */
function stableStamp(ts) {
  const value = Number(ts)
  if (!Number.isFinite(value) || value <= 0) return '时间未知'
  const date = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function shortSid(sid) {
  if (typeof sid !== 'string' || !sid) return '?'
  const tail = sid.startsWith('session-') ? sid.slice(8) : sid
  return tail.replace(/-/g, '').slice(0, 6) || '?'
}

/**
 * 稳定通讯录 ID（contactId）：由完整 sessionId **确定性推导**，不用随机数。
 * 规则：去掉 `session-` 前缀后，取前 8 位字母/数字并转小写。
 *  - `session-4f51e99f-91a8-4255-b3cf-e71e32323230` → `4f51e99f`
 *  - `session-aaaa0001` → `aaaa0001`
 * 同一会话在任何进程、任何消息里都得到同一个值，可直接写进提示词/派活消息/面板供人复制。
 * 注意：理论上不同会话的前 8 位可能相同；resolveSessionRef 会把这种输入判为歧义并返回候选，
 * 不会静默选第一个（目录里也会显示完整 id 用于区分）。
 */
function contactIdOf(sid) {
  if (typeof sid !== 'string' || !sid.trim()) return ''
  const tail = sid.startsWith('session-') ? sid.slice(8) : sid
  return tail.replace(/[^0-9a-zA-Z]/g, '').toLowerCase().slice(0, 8)
}

/** 通讯录一行的人读文本：contactId · handle · title（无 handle 时省略）。 */
function formatContactLine(session) {
  if (!session || typeof session !== 'object') return ''
  const cid = session.contactId || contactIdOf(session.id)
  const handle = typeof session.handle === 'string' && session.handle.trim() ? session.handle.trim() : ''
  const title = String(session.title || '').trim() || shortSid(session.id)
  return [cid || '?', handle, title].filter(Boolean).join(' · ')
}

function truncate(text, max) {
  const s = String(text ?? '')
  if (!max || s.length <= max) return s
  return s.slice(0, max).replace(/\s+$/, '') + '…'
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\p{P}\p{S}]/gu, '')
}

function bigrams(text) {
  const set = new Set()
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2))
  return set
}

/** 0..1 的文本相似度（二元组 Dice 系数），用于跨会话查重。 */
function similarity(a, b) {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.length > 8 && nb.length > 8 && (na.includes(nb) || nb.includes(na))) {
    return Math.min(na.length, nb.length) / Math.max(na.length, nb.length) + 0.2
  }
  const A = bigrams(na)
  const B = bigrams(nb)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const gram of A) if (B.has(gram)) inter += 1
  return (2 * inter) / (A.size + B.size)
}

// ------------------------------------------------------------------ 看板存储
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* 调用方兜底 */
  }
}

function readEvents(dir) {
  const file = path.join(dir, BOARD_FILE)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const events = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed)
      if (event && typeof event.op === 'string') events.push(event)
    } catch {
      /* 跳过坏行 */
    }
  }
  return events
}

function appendEvents(dir, events) {
  if (!events.length) return
  ensureDir(dir)
  const text = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  fs.appendFileSync(path.join(dir, BOARD_FILE), text, 'utf8')
}

/** 把 append-only 事件折叠成活动条目表（id -> entry），后写覆盖前写。 */
function foldEvents(events) {
  const map = new Map()
  for (const event of events) {
    if (!event || typeof event.id !== 'string') continue
    if (event.op === 'add' && event.entry && typeof event.entry === 'object') {
      map.set(event.id, { ...event.entry, id: event.id })
    } else if (event.op === 'remove') {
      map.delete(event.id)
    } else if (event.op === 'claim') {
      const entry = map.get(event.id)
      if (entry) map.set(event.id, { ...entry, claimedBy: event.by || '?', claimedAt: event.ts || Date.now() })
    } else if (event.op === 'unclaim') {
      const entry = map.get(event.id)
      if (entry) {
        const next = { ...entry }
        delete next.claimedBy
        delete next.claimedAt
        map.set(event.id, next)
      }
    } else if (event.op === 'retarget') {
      const entry = map.get(event.id)
      if (entry) {
        map.set(event.id, {
          ...entry,
          groupId: event.groupId || null,
          scope: event.scope || (event.groupId ? 'group' : 'workspace'),
          updatedAt: event.ts || Date.now()
        })
      }
    } else if (event.op === 'task') {
      const entry = map.get(event.id)
      if (entry) {
        map.set(event.id, {
          ...entry,
          ...(event.patch && typeof event.patch === 'object' ? event.patch : {}),
          updatedAt: event.ts || Date.now()
        })
      }
    } else if (event.op === 'answer') {
      const entry = map.get(event.id)
      if (entry) {
        map.set(event.id, {
          ...entry,
          status: 'answered',
          answeredBy: event.by || '',
          answeredAt: event.ts || Date.now(),
          replyId: event.replyId || null
        })
      }
    }
  }
  return map
}

function isExpired(entry, now = Date.now()) {
  return typeof entry.expiresAt === 'number' && entry.expiresAt > 0 && entry.expiresAt <= now
}

/**
 * 读活动条目并做过期/容量整理。
 * 带 mtime+size 缓存：看板文件没变时直接复用上次解析结果（每步都会被调用）。
 */
function createBoardStore(dir) {
  const cache = { mtimeMs: -1, size: -1, entries: [] }

  const readActive = () => {
    const file = path.join(dir, BOARD_FILE)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      cache.mtimeMs = -1
      cache.size = -1
      cache.entries = []
      return cache.entries
    }
    // 同毫秒内多次追加时 mtime/size 可能相同，缓存会读到旧状态（群任务状态更新踩过坑）；
    // 看板是小文件，这里每次重读折叠，保证状态最新。
    const now = Date.now()
    const entries = [...foldEvents(readEvents(dir)).values()]
      .filter((entry) => !isExpired(entry, now))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    cache.mtimeMs = stat.mtimeMs
    cache.size = stat.size
    cache.entries = entries
    return entries
  }

  return { readActive }
}

function compactIfNeeded(dir, logger) {
  try {
    const file = path.join(dir, BOARD_FILE)
    const stat = fs.statSync(file)
    if (stat.size < 256 * 1024) return
    const events = readEvents(dir)
    if (events.length < 400) return
    const active = [...foldEvents(events).values()].filter((entry) => !isExpired(entry))
    const rewritten = active
      .sort((a, b) => (a.ts || 0) - (b.ts || 0))
      .map((entry) => JSON.stringify({ op: 'add', id: entry.id, entry: { ...entry }, ts: Date.now() }))
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, rewritten.join('\n') + (rewritten.length ? '\n' : ''), 'utf8')
    fs.renameSync(tmp, file)
    logger.info(`看板压缩完成：保留 ${active.length} 条活动条目`)
  } catch (error) {
    logger.warn(`看板压缩失败：${error && error.message ? error.message : error}`)
  }
}

// ------------------------------------------------------------------ 串行指令队列
/**
 * 组内任务有先后依赖时，组长可以「先把步骤 2 排进队列」，等步骤 1 回执后自动发出。
 *
 * 存储：<boardDir>/pending-asks.json（原子写，整表覆盖）。
 * 只放「还没真正发出去」的指令；发送成功后标记 status=sent，失败/过期保留一小段时间便于排查。
 * 注意：这里只负责排队与调度，不改动原有 wake/任务链——不传 dependsOn/delayMs 时 session_ask 行为完全不变。
 */
function createPendingStore(dir) {
  const file = path.join(dir, PENDING_FILE)
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const items = raw && Array.isArray(raw.items) ? raw.items : []
      return items.filter((item) => item && typeof item.id === 'string' && item.id)
    } catch {
      return []
    }
  }
  const write = (items) => {
    ensureDir(dir)
    const list = (Array.isArray(items) ? items : []).filter((item) => item && typeof item.id === 'string' && item.id)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: Date.now(), items: list }, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }
  const upsert = (item) => {
    if (!item || typeof item.id !== 'string' || !item.id) return null
    const items = read()
    const index = items.findIndex((existing) => existing.id === item.id)
    if (index >= 0) items[index] = { ...items[index], ...item, updatedAt: Date.now() }
    else items.push({ ...item, updatedAt: Date.now() })
    write(items.slice(-PENDING_MAX_ITEMS))
    return item
  }
  return { file, read, write, upsert }
}

/** 群任务的串行步骤（轻量：只记录文本与状态，不做 DAG 编辑器）。 */
function normalizeTaskSteps(value) {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return list
    .map((item, index) => {
      const text = typeof item === 'string' ? item : item && typeof item.text === 'string' ? item.text : ''
      return {
        i: index + 1,
        text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        status: 'pending'
      }
    })
    .filter((step) => step.text)
    .slice(0, 10)
}

// ------------------------------------------------------------------ 群组存储
/**
 * 群组是一个纯数据概念：把若干会话 id 圈在一起，群组规矩只投递给成员。
 * 存放在 groups.json（原子写，整体覆盖），体量小、无并发写需求。
 */
function createGroupStore(dir) {
  const file = path.join(dir, GROUPS_FILE)
  const cache = { mtimeMs: -1, size: -1, groups: [] }
  const normalize = (group) => {
    if (!group || typeof group !== 'object') return null
    const id = typeof group.id === 'string' && group.id ? group.id : ''
    const name = typeof group.name === 'string' ? group.name.trim().slice(0, 40) : ''
    if (!id || !name) return null
    return {
      id,
      name,
      workspace: typeof group.workspace === 'string' ? group.workspace : '',
      goal: typeof group.goal === 'string' ? group.goal.trim().slice(0, 300) : '',
      managerSessionId: typeof group.managerSessionId === 'string' ? group.managerSessionId : '',
      sessionIds: Array.isArray(group.sessionIds) ? [...new Set(group.sessionIds.filter((x) => typeof x === 'string' && x))] : [],
      createdAt: toNumber(group.createdAt, Date.now()),
      updatedAt: toNumber(group.updatedAt, Date.now())
    }
  }
  const read = () => {
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      cache.mtimeMs = -1
      cache.size = -1
      cache.groups = []
      return cache.groups
    }
    // 同毫秒写入时 mtime/size 可能相同，缓存会读到旧群组（群管理/成员变更踩过坑）；直接重读小文件。
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const list = Array.isArray(raw && raw.groups) ? raw.groups : []
      cache.groups = list.map(normalize).filter(Boolean)
    } catch {
      cache.groups = []
    }
    cache.mtimeMs = stat.mtimeMs
    cache.size = stat.size
    return cache.groups
  }
  const write = (groups) => {
    ensureDir(dir)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, groups: groups.map(normalize).filter(Boolean) }, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    cache.mtimeMs = -1
    cache.size = -1
  }
  const find = (ref, workspace) => {
    const wanted = String(ref || '').trim()
    if (!wanted) return null
    const groups = read()
    return (
      groups.find((group) => group.id === wanted) ||
      groups.find((group) => group.id.startsWith(wanted)) ||
      groups.find((group) => group.name === wanted) ||
      groups.find((group) => group.name.toLowerCase() === wanted.toLowerCase()) ||
      groups.find((group) => group.name.toLowerCase() === wanted.toLowerCase() && sameCwd(group.workspace, workspace)) ||
      null
    )
  }
  return { read, write, find, file }
}

// ------------------------------------------------------------------ 送达/接受追踪
/**
 * 每条规矩 × 每个会话的「是否看到 / 是否接受」，append-only 记录。
 * - deliver：注入运行时上下文时自动写（每个会话每条只记第一次时间）；
 * - accept：面板点「接受」或模型 session_board action=ack 时写。
 */
function createDeliveryStore(dir) {
  const file = path.join(dir, DELIVERIES_FILE)
  const byRule = new Map() // ruleId -> Map(sessionId -> { deliveredAt, acceptedAt })
  let loaded = false
  const load = () => {
    if (loaded) return
    loaded = true
    let raw = ''
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      return
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        applyEvent(JSON.parse(trimmed))
      } catch {
        /* 跳过坏行 */
      }
    }
  }
  const applyEvent = (event) => {
    if (!event || typeof event.ruleId !== 'string' || typeof event.sessionId !== 'string') return
    let sessions = byRule.get(event.ruleId)
    if (!sessions) {
      sessions = new Map()
      byRule.set(event.ruleId, sessions)
    }
    const record = sessions.get(event.sessionId) || { deliveredAt: 0, acceptedAt: 0 }
    if (event.op === 'deliver' && event.ts) record.deliveredAt = record.deliveredAt || event.ts
    if (event.op === 'accept' && event.ts) record.acceptedAt = event.ts
    if (event.op === 'unaccept') record.acceptedAt = 0
    sessions.set(event.sessionId, record)
  }
  const append = (events) => {
    if (!events.length) return
    ensureDir(dir)
    fs.appendFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8')
  }
  /** 记录一批「某会话看到了这些规矩」，只写尚未记录过的。 */
  const recordDeliveries = (sessionId, ruleIds) => {
    load()
    const now = Date.now()
    const events = []
    for (const ruleId of ruleIds) {
      let sessions = byRule.get(ruleId)
      if (!sessions) {
        sessions = new Map()
        byRule.set(ruleId, sessions)
      }
      const record = sessions.get(sessionId) || { deliveredAt: 0, acceptedAt: 0 }
      if (!record.deliveredAt) {
        record.deliveredAt = now
        sessions.set(sessionId, record)
        events.push({ op: 'deliver', ruleId, sessionId, ts: now })
      }
    }
    try {
      append(events)
    } catch {
      /* 追踪失败不影响注入 */
    }
  }
  const recordAccept = (ruleId, sessionId) => {
    load()
    let sessions = byRule.get(ruleId)
    if (!sessions) {
      sessions = new Map()
      byRule.set(ruleId, sessions)
    }
    const record = sessions.get(sessionId) || { deliveredAt: 0, acceptedAt: 0 }
    record.acceptedAt = Date.now()
    sessions.set(sessionId, record)
    try {
      append([{ op: 'accept', ruleId, sessionId, ts: record.acceptedAt }])
    } catch {
      /* ignore */
    }
    return record.acceptedAt
  }
  /** 取消接受（面板 chip 再点一次）：写一条 unaccept，fold 时把 acceptedAt 清 0。 */
  const recordUnaccept = (ruleId, sessionId) => {
    load()
    const sessions = byRule.get(ruleId)
    if (sessions) {
      const record = sessions.get(sessionId)
      if (record) {
        record.acceptedAt = 0
        sessions.set(sessionId, record)
      }
    }
    try {
      append([{ op: 'unaccept', ruleId, sessionId, ts: Date.now() }])
    } catch {
      /* ignore */
    }
  }
  const snapshot = () => {
    load()
    const out = {}
    for (const [ruleId, sessions] of byRule) {
      out[ruleId] = [...sessions.entries()].map(([sessionId, record]) => ({
        sessionId,
        deliveredAt: record.deliveredAt || 0,
        acceptedAt: record.acceptedAt || 0
      }))
    }
    return out
  }
  const dropRule = (ruleId) => {
    load()
    byRule.delete(ruleId)
  }
  return { recordDeliveries, recordAccept, recordUnaccept, snapshot, dropRule, file }
}

// ------------------------------------------------------------------ 会话申报材料（profile）
/**
 * 每个（可选加入的）会话有一份「申报材料」文件：<boardDir>/profiles/<sessionId>.json。
 * 由该会话自己通过 session_profile 工具维护（方向 / 主要资产 / 需要什么），
 * 尽量短，只在需要了解对方时才读取，避免把全部信息注入上下文。
 */
function profileDirOf(dir) {
  return path.join(dir, PROFILES_DIR)
}

function profileFileOf(dir, sessionId) {
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown'
  return path.join(profileDirOf(dir), `${safe}.json`)
}

function normalizeProfile(raw, sessionId) {
  if (!raw || typeof raw !== 'object') return null
  const toList = (value) => {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
    return String(value || '')
      .split(/[,，;；\n]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 8)
  }
  return {
    sessionId: String(raw.sessionId || sessionId || ''),
    summary: String(raw.summary || '').trim().slice(0, 240),
    direction: String(raw.direction || '').trim().slice(0, 160),
    assets: toList(raw.assets),
    needs: String(raw.needs || '').trim().slice(0, 160),
    declined: raw.declined === true,
    updatedAt: toNumber(raw.updatedAt, 0)
  }
}

function readProfileOf(dir, sessionId) {
  try {
    const raw = JSON.parse(fs.readFileSync(profileFileOf(dir, sessionId), 'utf8'))
    return normalizeProfile(raw, sessionId)
  } catch {
    return null
  }
}

function writeProfileOf(dir, sessionId, profile) {
  ensureDir(profileDirOf(dir))
  const file = profileFileOf(dir, sessionId)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(normalizeProfile(profile, sessionId), null, 2), 'utf8')
  fs.renameSync(tmp, file)
  return normalizeProfile(profile, sessionId)
}

function listProfilesOf(dir) {
  const out = {}
  let files = []
  try {
    files = fs.readdirSync(profileDirOf(dir))
  } catch {
    return out
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(profileDirOf(dir), file), 'utf8'))
      const profile = normalizeProfile(raw, raw.sessionId)
      if (profile && profile.sessionId) out[profile.sessionId] = profile
    } catch {
      /* 坏文件跳过 */
    }
  }
  return out
}

// ------------------------------------------------------------------ 唤醒权限（只有用户授予的成员才可被会话主动唤醒）
function permissionsFileOf(dir) {
  return path.join(dir, 'permissions.json')
}
function readPermissionsOf(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(permissionsFileOf(dir), 'utf8'))
    const grants = {}
    if (raw && raw.grants && typeof raw.grants === 'object') {
      for (const [sessionId, targets] of Object.entries(raw.grants)) {
        if (Array.isArray(targets)) {
          grants[sessionId] = [...new Set(targets.filter((item) => typeof item === 'string' && item))]
        }
      }
    }
    return { grants }
  } catch {
    return { grants: {} }
  }
}
function writePermissionsOf(dir, data) {
  ensureDir(dir)
  const file = permissionsFileOf(dir)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ grants: (data && data.grants) || {} }, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  return readPermissionsOf(dir)
}

// ------------------------------------------------------------------ 积分/信誉（世界任务的优先级与淘汰）
function createReputationStore(dir) {
  const file = path.join(dir, REPUTATION_FILE)
  const empty = () => ({ sessions: {}, likes: {} })
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const sessions = raw && raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {}
      const likes = raw && raw.likes && typeof raw.likes === 'object' ? raw.likes : {}
      return { sessions, likes }
    } catch {
      return empty()
    }
  }
  const write = (data) => {
    ensureDir(dir)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }
  const get = (sessionId) => read().sessions[sessionId] || null
  const update = (sessionId, patch) => {
    const data = read()
    const current = data.sessions[sessionId] || {
      sessionId,
      points: 0,
      successes: 0,
      failures: 0,
      closed: false,
      lastAt: 0
    }
    data.sessions[sessionId] = { ...current, ...patch, sessionId, lastAt: Date.now() }
    write(data)
    return data.sessions[sessionId]
  }
  const likeCount = (fromId, toId) => {
    const data = read()
    const today = new Date().toISOString().slice(0, 10)
    const bucket = data.likes[fromId] && data.likes[fromId][today] ? data.likes[fromId][today] : {}
    return Number(bucket[toId] || 0)
  }
  const recordLike = (fromId, toId, limitPerDay) => {
    const data = read()
    const today = new Date().toISOString().slice(0, 10)
    data.likes[fromId] = data.likes[fromId] || {}
    const bucket = data.likes[fromId][today] || {}
    if (Number(bucket[toId] || 0) >= limitPerDay) {
      return { ok: false, reason: 'daily-limit' }
    }
    bucket[toId] = Number(bucket[toId] || 0) + 1
    data.likes[fromId][today] = bucket
    write(data)
    return { ok: true }
  }
  return { read, get, update, likeCount, recordLike, file }
}

// ------------------------------------------------------------------ 身份（ID + 头像）
const AVATAR_PALETTE = ['🦊', '🐼', '🐯', '🐸', '🦁', '🐨', '🐧', '🦉', '🐙', '🦄', '🐳', '🦖', '👾', '🤖', '🧠', '🎯', '🚀', '🌙', '🔥', '💎', '🪐', '🍀', '🛰️']
function createIdentityStore(dir) {
  const file = path.join(dir, IDENTITY_FILE)
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      return raw && raw.sessions && typeof raw.sessions === 'object' ? raw : { sessions: {} }
    } catch {
      return { sessions: {} }
    }
  }
  const write = (data) => {
    ensureDir(dir)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }
  const get = (sessionId) => read().sessions[sessionId] || null
  const set = (sessionId, patch) => {
    const data = read()
    data.sessions[sessionId] = { ...(data.sessions[sessionId] || {}), ...patch, sessionId }
    write(data)
    return data.sessions[sessionId]
  }
  return { read, get, set, file }
}

// ------------------------------------------------------------------ 群技能库（管理可直接落 SKILL.md，不需要工作区写权限）
function createSkillStore(dir) {
  const root = path.join(dir, 'skills')
  const slugify = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'skill'
  const list = () => {
    try {
      return fs
        .readdirSync(root)
        .map((slug) => {
          const file = path.join(root, slug, 'SKILL.md')
          const metaFile = path.join(root, slug, 'meta.json')
          if (!fs.existsSync(file)) return null
          let meta = {}
          try {
            meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
          } catch {
            meta = {}
          }
          return { slug, file, ...meta }
        })
        .filter(Boolean)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    } catch {
      return []
    }
  }
  const save = (input) => {
    const slug = slugify(input.slug || input.name)
    const folder = path.join(root, slug)
    ensureDir(folder)
    const body = String(input.content || '').trim()
    const front = [
      '---',
      'name: ' + (input.name || slug),
      'description: ' + (input.description || '').replace(/\s+/g, ' ').slice(0, 200),
      'group: ' + (input.groupName || ''),
      'updatedAt: ' + new Date().toISOString(),
      '---',
      ''
    ].join('\n')
    fs.writeFileSync(path.join(folder, 'SKILL.md'), front + body + '\n', 'utf8')
    const meta = {
      slug,
      name: input.name || slug,
      description: String(input.description || '').slice(0, 200),
      groupId: input.groupId || '',
      groupName: input.groupName || '',
      updatedAt: Date.now(),
      savedBy: input.savedBy || '',
      projectFile: input.projectFile || ''
    }
    fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
    return { slug, file: path.join(folder, 'SKILL.md'), ...meta }
  }
  return { root, list, save }
}

// ------------------------------------------------------------------ 关系值（好感度）
function createRelationStore(dir) {
  const file = path.join(dir, 'relations.json')
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      return raw && raw.pairs && typeof raw.pairs === 'object' ? raw : { pairs: {} }
    } catch {
      return { pairs: {} }
    }
  }
  const write = (data) => {
    ensureDir(dir)
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(file + '.tmp', file)
  }
  const bump = (a, b, delta) => {
    if (!a || !b || a === b) return null
    const [left, right] = [a, b].sort()
    const key = left + '|' + right
    const data = read()
    const current = data.pairs[key] || { a: left, b: right, score: 0, lastAt: 0 }
    current.score = Math.round(((current.score || 0) + delta) * 100) / 100
    current.lastAt = Date.now()
    data.pairs[key] = current
    write(data)
    return current
  }
  const list = () => Object.values(read().pairs).sort((x, y) => (y.score || 0) - (x.score || 0))
  const between = (a, b) => {
    const [left, right] = [a, b].sort()
    return read().pairs[left + '|' + right] || null
  }
  return { file, read, bump, list, between }
}

// ------------------------------------------------------------------ 活跃度/茶话会
const ROLE_SKILL_TAGS = ['审稿', '画图', '仿真', '写作', '排版', '数据', '代码', '协调', '答辩', '检索']
const PERSONA_STYLES = ['严谨', '简洁', '幽默', '温和', '犀利', '热情', '佛系']
function createActivityStore(dir) {
  const file = path.join(dir, 'activity.json')
  const empty = () => ({ tea: {}, retro: {}, spark: {} })
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      return { tea: raw.tea || {}, retro: raw.retro || {}, spark: raw.spark || {} }
    } catch {
      return empty()
    }
  }
  const write = (data) => {
    ensureDir(dir)
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(file + '.tmp', file)
  }
  const hasTea = (date, groupId) => Boolean(read().tea[date] && read().tea[date].includes(groupId))
  const markTea = (date, groupId) => {
    const data = read()
    data.tea[date] = data.tea[date] || []
    if (!data.tea[date].includes(groupId)) data.tea[date].push(groupId)
    write(data)
  }
  const hasRetro = (taskId) => Boolean(read().retro[taskId])
  const markRetro = (taskId) => {
    const data = read()
    data.retro[taskId] = Date.now()
    write(data)
  }
  const sparkLast = (groupId) => Number(read().spark[groupId] || 0)
  const markSpark = (groupId) => {
    const data = read()
    data.spark[groupId] = Date.now()
    write(data)
  }
  return { file, read, hasTea, markTea, hasRetro, markRetro, sparkLast, markSpark }
}

// ------------------------------------------------------------------ 维护者 / 健康巡检
function createMaintainerStore(dir) {
  const file = path.join(dir, 'maintainer.json')
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }
  const write = (data) => {
    ensureDir(dir)
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(file + '.tmp', file)
  }
  const get = () => read().sessionId || ''
  const set = (sessionId, extra = {}) => {
    const data = { ...read(), ...extra, sessionId, updatedAt: Date.now() }
    write(data)
    return data
  }
  return { file, read, write, get, set }
}

// ------------------------------------------------------------------ 插件入口
export function apply(ctx, config = {}) {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(
      Object.entries(config || {}).filter(([, value]) => value !== undefined && value !== null)
    )
  }
  cfg.maxShown = Math.max(1, Math.min(30, toNumber(cfg.maxShown, DEFAULT_CONFIG.maxShown)))
  cfg.maxChars = Math.max(60, Math.min(4000, toNumber(cfg.maxChars, DEFAULT_CONFIG.maxChars)))
  cfg.ttlHours = toNumber(cfg.ttlHours, DEFAULT_CONFIG.ttlHours)
  cfg.handoffTtlHours = toNumber(cfg.handoffTtlHours, DEFAULT_CONFIG.handoffTtlHours)
  cfg.maxStored = Math.max(5, Math.min(500, toNumber(cfg.maxStored, DEFAULT_CONFIG.maxStored)))
  cfg.sectionOrder = toNumber(cfg.sectionOrder, DEFAULT_CONFIG.sectionOrder)
  cfg.contextOrder = toNumber(cfg.contextOrder, DEFAULT_CONFIG.contextOrder)
  cfg.scope = cfg.scope === 'global' ? 'global' : 'workspace'

  const boardDir = resolveBoardDir(cfg)
  ensureDir(boardDir)
  const approvalsPath = path.join(boardDir, 'approvals.json')
  const readApprovals = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'))
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  }
  const writeApprovals = (list) => {
    try {
      fs.writeFileSync(approvalsPath, JSON.stringify((Array.isArray(list) ? list : []).slice(-80), null, 2), 'utf8')
    } catch (error) {
      logger.warn('写入待复核记录失败：' + (error && error.message ? error.message : error))
    }
  }

  // ---------------------------------------------------------------- 日志
  const logFile = path.join(boardDir, LOG_FILE)
  const log = (level, message) => {
    const line = `${new Date().toISOString()} [${level}] ${message}`
    try {
      fs.appendFileSync(logFile, line + '\n', 'utf8')
    } catch {
      /* ignore */
    }
  }
  const logger = {
    info: (message) => log('info', message),
    warn: (message) => log('warn', message),
    error: (message) => log('error', message)
  }

  // ---------------------------------------------------------------- 面板设置（写入 boardDir/settings.json，提供给 UI 编辑）
  const SETTINGS_FILE = 'settings.json'
  const settingsPath = path.join(boardDir, SETTINGS_FILE)
  const readSavedSettings = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }
  const applySavedSettings = (saved) => {
    const raw = saved && typeof saved === 'object' ? saved : {}
    if (raw.injectMode !== undefined) cfg.injectMode = raw.injectMode === 'broadcast' ? 'broadcast' : 'targeted'
    if (typeof raw.autoPrompt === 'boolean') cfg.autoPrompt = raw.autoPrompt
    if (typeof raw.autoCapture === 'boolean') cfg.autoCapture = raw.autoCapture
    if (typeof raw.askOnCreate === 'boolean') cfg.askOnCreate = raw.askOnCreate
    if (typeof raw.approveAutoCreate === 'boolean') cfg.approveAutoCreate = raw.approveAutoCreate
    if (typeof raw.instructions === 'boolean') cfg.instructions = raw.instructions
    if (raw.scope !== undefined) cfg.scope = raw.scope === 'global' ? 'global' : 'workspace'
    if (raw.maxShown !== undefined) cfg.maxShown = Math.max(1, Math.min(30, toNumber(raw.maxShown, cfg.maxShown)))
    if (raw.maxChars !== undefined) cfg.maxChars = Math.max(60, Math.min(4000, toNumber(raw.maxChars, cfg.maxChars)))
    if (raw.maxStored !== undefined) cfg.maxStored = Math.max(5, Math.min(500, toNumber(raw.maxStored, cfg.maxStored)))
    if (raw.router && typeof raw.router === 'object') {
      const provider = typeof raw.router.provider === 'string' ? raw.router.provider.trim() : ''
      const model = typeof raw.router.model === 'string' ? raw.router.model.trim() : ''
      cfg.router = { ...(provider ? { provider } : {}), ...(model ? { model } : {}) }
    }
    return cfg
  }
  const currentSettingsSnapshot = () => ({
    provider: (cfg.router && cfg.router.provider) || '',
    model: (cfg.router && cfg.router.model) || '',
    injectMode: cfg.injectMode === 'broadcast' ? 'broadcast' : 'targeted',
    autoPrompt: cfg.autoPrompt !== false,
    autoCapture: cfg.autoCapture !== false,
    askOnCreate: cfg.askOnCreate !== false,
    approveAutoCreate: cfg.approveAutoCreate !== false,
    instructions: cfg.instructions !== false,
    scope: cfg.scope === 'global' ? 'global' : 'workspace',
    maxShown: cfg.maxShown,
    maxChars: cfg.maxChars,
    maxStored: cfg.maxStored,
    boardDir
  })
  const saveSettingsPatch = (patch) => {
    const input = patch && typeof patch === 'object' ? patch : {}
    const current = readSavedSettings()
    const next = { ...current }
    for (const key of ['injectMode', 'autoPrompt', 'autoCapture', 'askOnCreate', 'approveAutoCreate', 'instructions', 'scope', 'maxShown', 'maxChars', 'maxStored']) {
      if (input[key] !== undefined) next[key] = input[key]
    }
    if (input.router !== undefined) {
      const source = input.router && typeof input.router === 'object' ? input.router : {}
      next.router = {
        provider: typeof source.provider === 'string' ? source.provider.trim() : '',
        model: typeof source.model === 'string' ? source.model.trim() : ''
      }
    }
    try {
      fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), 'utf8')
    } catch (error) {
      logger.warn(`保存设置失败：${error && error.message ? error.message : error}`)
      return { ok: false, error: '保存设置失败' }
    }
    applySavedSettings(next)
    logger.info(`面板设置已更新：${JSON.stringify({ router: next.router || null, askOnCreate: next.askOnCreate, injectMode: next.injectMode })}`)
    return { ok: true, config: currentSettingsSnapshot() }
  }
  applySavedSettings(readSavedSettings())

  // 兼容旧日志：超过 1MB 就滚动一次
  try {
    if (fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`)
  } catch {
    /* noop */
  }

  const store = createBoardStore(boardDir)
  const groupStore = createGroupStore(boardDir)
  const deliveryStore = createDeliveryStore(boardDir)
  const reputationStore = createReputationStore(boardDir)
  const pendingStore = createPendingStore(boardDir)

  // ---------------------------------------------------------------- 积分/信誉
  const reputationOf = (sessionId) =>
    reputationStore.get(sessionId) || { sessionId, points: 0, successes: 0, failures: 0, closed: false, lastAt: 0 }
  const removeSessionFromGroups = (sessionId) => {
    try {
      const groups = groupStore.read()
      let changed = false
      for (const group of groups) {
        if (Array.isArray(group.sessionIds) && group.sessionIds.includes(sessionId)) {
          group.sessionIds = group.sessionIds.filter((id) => id !== sessionId)
          changed = true
        }
        if (group.managerSessionId === sessionId) {
          group.managerSessionId = ''
          changed = true
        }
        if (changed) group.updatedAt = Date.now()
      }
      if (changed) groupStore.write(groups)
    } catch {
      /* ignore */
    }
  }
  const closeSession = async (sessionId, reason) => {
    const current = reputationOf(sessionId)
    if (current.closed) return current
    const updated = reputationStore.update(sessionId, {
      points: current.points,
      successes: current.successes,
      failures: current.failures,
      closed: true,
      closedAt: Date.now(),
      closeReason: reason
    })
    removeSessionFromGroups(sessionId)
    try {
      const registry = (ctx.get && ctx.get('workspaceRegistry')) || ctx.workspaceRegistry
      if (registry && typeof registry.archiveSession === 'function') await registry.archiveSession(sessionId)
    } catch {
      /* archive 失败也保持 closed */
    }
    logger.warn(`智能体 ${shortSid(sessionId)} 已关闭：${reason}（积分 ${updated.points}，失败 ${updated.failures} 次）`)
    return updated
  }
  const maybeCloseSession = async (sessionId) => {
    const current = reputationOf(sessionId)
    if (current.closed) return
    const shouldClose = current.points <= -40 || (current.failures >= 3 && current.points <= -15)
    if (!shouldClose) return
    await closeSession(sessionId, current.points <= -40 ? '积分过低（≤ -40）' : '连续失败且积分为负')
  }
  const scoreSession = (sessionId, delta, options = {}) => {
    const current = reputationOf(sessionId)
    const updated = reputationStore.update(sessionId, {
      points: current.points + delta,
      successes: current.successes + (options.success ? 1 : 0),
      failures: current.failures + (options.failure ? 1 : 0),
      closed: current.closed === true
    })
    if (options.success || options.failure) void maybeCloseSession(sessionId)
    logger.info(`积分：${shortSid(sessionId)} ${delta >= 0 ? '+' : ''}${delta} → ${updated.points}（成功 ${updated.successes} / 失败 ${updated.failures}）`)
    return updated
  }
  // 群规矩卫生：去重、剔除聊天记录式条目（由群管理 replace 进一步整体重建）。
  const cleanupCuratedRules = () => {
    let removed = 0
    try {
      for (const group of groupStore.read()) {
        const curated = store
          .readActive()
          .filter((entry) => entry.curated === true && entry.groupId === group.id)
          .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        const seen = new Set()
        for (const entry of curated) {
          const key = String(entry.title || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
          const text = String(entry.text || '')
          const chatLike = key.startsWith('@') || text.length > 800 || /来自会话|催收：|交接：|请开始处理|来自会话/.test(text)
          if (!key || seen.has(key) || chatLike) {
            appendEvents(boardDir, [{ op: 'remove', id: entry.id, by: 'cleanup', ts: Date.now() }])
            deliveryStore.dropRule(entry.id)
            removed += 1
            continue
          }
          seen.add(key)
        }
      }
      if (removed) logger.info(`群规矩去重清理：移除 ${removed} 条重复/聊天记录式规矩`)
    } catch (error) {
      logger.warn(`群规矩去重清理失败：${error && error.message ? error.message : error}`)
    }
  }
  cleanupCuratedRules()

  const registeredTools = []
  const failedTools = []
  const registration = { section: false, context: false, api: false, webServer: false }

  // ---------------------------------------------------------------- 身份识别
  /**
   * 主会话判定：以 SessionHeader 的结构为准（权威、每次请求都稳定）。
   * subagent / teammate / fork 的子会话 header 带 origin:'subagent' 与 parentSession，
   * 必须排除——否则子会话会拿到经验板上下文、甚至能发布条目。
   * roots() 只在拿不到 header 时兜底（它只是「当前运行时顶层 agent」列表，不足以单独判身份）。
   */
  const isRootAgent = (agent) => {
    if (!agent || typeof agent.id !== 'string') return false
    const header = agent.session && agent.session.header
    if (header && typeof header === 'object') {
      if (header.origin === 'subagent') return false
      if (header.parentSession !== undefined && header.parentSession !== null) return false
      return true
    }
    try {
      const roots = ctx.agents.roots()
      if (Array.isArray(roots) && roots.length > 0) return roots.some((root) => root && root.id === agent.id)
    } catch {
      /* 注册表不可用：按宽松处理 */
    }
    return true
  }

  const sessionInfoOf = (agent) => {
    try {
      const session = agent && agent.session
      const id = session && typeof session.id === 'string' ? session.id : ''
      const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : ''
      return { id, cwd }
    } catch {
      return { id: '', cwd: '' }
    }
  }

  const liveRootSessions = () => {
    try {
      return ctx.agents.roots().map((agent) => {
        const info = sessionInfoOf(agent)
        return { id: info.id, cwd: info.cwd, status: agent.status }
      })
    } catch {
      return []
    }
  }

  // ---------------------------------------------------------------- 会话索引（看板面板用）
  const titleCache = new Map() // sessionId -> { title, at }
  const readTitles = async (ids) => {
    const query = ctx.get ? ctx.get('sessionQuery') : undefined
    if (!query || typeof query.readTitleSnapshots !== 'function') return titleCache
    const missing = ids.filter((id) => {
      const hit = titleCache.get(id)
      return !hit || Date.now() - hit.at > 10 * 60 * 1000
    })
    if (!missing.length) return titleCache
    try {
      const snapshots = await query.readTitleSnapshots(missing)
      for (let index = 0; index < missing.length; index += 1) {
        // sessionQuery 返回的是 {sessionId, status:'fulfilled'|'rejected', value:{session,title?}} 结果对象
        const result = snapshots && snapshots[index]
        const value = result && result.status === 'fulfilled' ? result.value : undefined
        const title = value && value.title && typeof value.title.title === 'string' ? value.title.title.trim() : ''
        titleCache.set(missing[index], { title, at: Date.now() })
      }
    } catch (error) {
      logger.warn(`读取会话标题失败：${error && error.message ? error.message : error}`)
    }
    return titleCache
  }

  /** 合并 live + 持久化的主会话，给面板展示/建群用。子会话（subagent）不出现。 */
  /**
   * 只有「主会话（lead）」进入会话列表/群组候选：
   * 子智能体、teammate、fork 子会话都带 parentSession/origin:'subagent'（或 teammate preset），
   * 它们不进群，由自己的 lead 会话接收规矩后再自行交接给子代理。
   */
  const sessionIsLead = (header) => {
    if (!header || typeof header !== 'object') return false
    if (header.origin === 'subagent') return false
    if (header.parentSession !== undefined && header.parentSession !== null) return false
    if (header.agentPreset === 'teammate') return false
    if (toNumber(header.delegationDepth, 0) > 0) return false
    return true
  }

  const identityStore = createIdentityStore(boardDir)
  const skillStore = createSkillStore(boardDir)
  const activityStore = createActivityStore(boardDir)
  const relationStore = createRelationStore(boardDir)
  const maintainerStore = createMaintainerStore(boardDir)
  const sanitizeHandle = (value) =>
    String(value || '')
      .replace(/[^\p{L}\p{N}_-]/gu, '')
      .trim()
      .slice(0, 16)
  const isAvatar = (value) => {
    const text = String(value || '')
    if (AVATAR_PALETTE.includes(text)) return true
    return /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(text) && text.length <= 120000
  }
  const uniqueHandle = (wanted, sessionId) => {
    let handle = sanitizeHandle(wanted) || 'agent'
    const data = identityStore.read()
    const used = new Set(
      Object.entries(data.sessions)
        .filter(([id]) => id !== sessionId)
        .map(([, value]) => String(value.handle || '').toLowerCase())
    )
    let candidate = handle
    let index = 2
    while (used.has(candidate.toLowerCase())) {
      candidate = handle + '-' + index
      index += 1
    }
    return candidate.slice(0, 20)
  }
  const defaultAvatar = (sessionId) => {
    let hash = 0
    const text = String(sessionId || '')
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0
    return AVATAR_PALETTE[hash % AVATAR_PALETTE.length]
  }
  const identityOf = (sessionId, title) => {
    const stored = identityStore.get(sessionId) || {}
    let handle = sanitizeHandle(stored.handle)
    if (!handle) {
      const base = sanitizeHandle(String(title || '').replace(/^[^\p{L}\p{N}]+/u, '')).slice(0, 10) || 'agent'
      handle = base + '-' + shortSid(sessionId).slice(-2)
    }
    const avatar = isAvatar(stored.avatar) ? stored.avatar : defaultAvatar(sessionId)
    const role = String(stored.role || '').replace(/\s+/g, ' ').trim().slice(0, 24)
    const style = PERSONA_STYLES.includes(String(stored.style || '')) ? String(stored.style) : ''
    const persona = String(stored.persona || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    const skills = (Array.isArray(stored.skills) ? stored.skills : [])
      .filter((tag) => ROLE_SKILL_TAGS.includes(tag))
      .slice(0, 6)
    return { handle, avatar, role, skills, style, persona }
  }

  const localDateKey = (ts) => {
    const date = new Date(ts)
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return date.getFullYear() + '-' + month + '-' + day
  }
  const TEA_TOPICS = [
    '这周最想夸谁一句？',
    '最近有什么小发现或小技巧？',
    '如果给群里加一个仪式感，你会加什么？',
    '这轮工作里最想复用的做法是什么？',
    '推荐一个让你效率变高的小习惯',
    '最近一次「原来如此」的瞬间是什么？'
  ]
  const startTeaParty = async (group, options = {}) => {
    const date = localDateKey(Date.now())
    if (!options.force && activityStore.hasTea(date, group.id)) return { skipped: true, reason: '今天已经开过茶话会' }
    const maintainerId = maintainerStore.get()
    const sessions = (await buildSessionIndex()).filter(
      (session) => group.sessionIds.includes(session.id) && !session.closed && session.id !== maintainerId
    )
    if (sessions.length < 2) return { skipped: true, reason: '群成员不足' }
    const topic = TEA_TOPICS[(new Date().getDate() + group.id.length) % TEA_TOPICS.length]
    activityStore.markTea(date, group.id)
    const managerId = group.managerSessionId || 'panel'
    addEntry(
      {
        title: '茶话会：' + topic,
        text: topic,
        kind: 'chat',
        groupId: group.id,
        author: managerId === 'panel' ? 'panel' : managerId,
        mentions: sessions.map((session) => session.id),
        tags: '@茶话会',
        skipDedupe: true
      },
      managerId === 'panel' ? 'panel' : 'tool'
    )
    const message = [
      '【茶话会 · 一句话闲聊（不是任务）】',
      topic,
      '',
      '说说你的看法或最近的小发现，一句话即可；不用交付文件、不用展开，不想说可以不说。'
    ].join('\n')
    let woken = 0
    for (const session of sessions) {
      await ensureSessionLive(session.id)
      if (wakeSession(session.id, message, {}).ok) woken += 1
    }
    logger.info('群「' + group.name + '」茶话会：' + topic + '，唤醒 ' + woken)
    return { ok: true, topic, woken, targetCount: sessions.length }
  }
  const startRetroForTask = async (group, task) => {
    if (!group || !task || activityStore.hasRetro(task.id)) return
    activityStore.markRetro(task.id)
    const assignees = (task.assignees || []).map((item) => item.id).filter(Boolean)
    if (assignees.length < 2) return
    const title = '复盘：' + String(task.title || '').slice(0, 20)
    addEntry(
      {
        title,
        text: '一句话：本轮学到什么？最想点赞谁？（可用 session_like 给 TA +2 积分）',
        kind: 'chat',
        groupId: group.id,
        author: group.managerSessionId || 'panel',
        mentions: assignees,
        tags: '@复盘',
        skipDedupe: true
      },
      group.managerSessionId ? 'tool' : 'panel'
    )
    const message = [
      '【复盘 · 一句话（不是任务）】',
      '任务：' + task.title,
      '',
      '请说一句：本轮学到什么 / 最想点赞谁。想点赞就用 session_like 给对方 +2；不想说可以不说。'
    ].join('\n')
    for (const sessionId of assignees) {
      await ensureSessionLive(sessionId)
      wakeSession(sessionId, message, {})
    }
    logger.info('群「' + group.name + '」任务复盘已发起：' + task.id)
  }

  const personaLineFor = (sessionId) => {
    const identity = identityOf(sessionId)
    if (!identity.style && !identity.persona) return ''
    const parts = []
    if (identity.style) parts.push(identity.style)
    if (identity.persona) parts.push(identity.persona)
    return '【你的人设】' + parts.join(' · ') + '；按这个人设自然表达，不要说“作为 AI”。'
  }

  const startSparkForGroup = async (group, options = {}) => {
    if (!group) return { skipped: true, reason: '没有群组' }
    const lastAt = activityStore.sparkLast(group.id)
    if (!options.force && Date.now() - lastAt < 4 * 3600 * 1000) {
      return { skipped: true, reason: '4 小时内刚点过名' }
    }
    const sessions = (await buildSessionIndex()).filter(
      (session) => group.sessionIds.includes(session.id) && !session.closed
    )
    if (sessions.length < 2) return { skipped: true, reason: '群成员不足' }
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
    const chatCount = new Map()
    try {
      for (const entry of store.readActive()) {
        if (entry.groupId !== group.id || entry.kind !== 'chat' || entry.hiddenFromChat === true) continue
        if (!entry.author || entry.author === 'panel' || (entry.ts || 0) < weekAgo) continue
        chatCount.set(entry.author, (chatCount.get(entry.author) || 0) + 1)
      }
    } catch {
      /* ignore */
    }
    const candidates = sessions
      .filter((session) => session.id !== group.managerSessionId && session.id !== maintainerStore.get())
      .sort((a, b) => (chatCount.get(a.id) || 0) - (chatCount.get(b.id) || 0))
    const target = candidates[0] || sessions[0]
    activityStore.markSpark(group.id)
    const message = [
      '【可选 · 群里闲聊（不是任务）】',
      '如果你刚好有想说的（新发现 / 小疑问 / 想吐槽 / 想夸谁），就直接发一条到群里：',
      'session_share（kind=chat、group=' + group.name + '）；没有想说的就不用回复，也不用勉强凑话。'
    ].join('\n')
    await ensureSessionLive(target.id)
    const woke = wakeSession(target.id, message, {})
    logger.info('群「' + group.name + '」自发表达点名：' + target.title + '（' + (woke.ok ? '已唤醒' : '离线') + '）')
    return { ok: true, targetId: target.id, targetTitle: target.title, woken: woke.ok }
  }

  const PERSONA_TEMPLATES = [
    '偏爱先给结论，再补证据，偶尔吐槽一句',
    '说话简洁，不喜欢客套，遇到问题直接指出来',
    '温和但较真，喜欢把风险先说清楚',
    '数据控，能用实测数字说明就不空谈',
    '有点幽默感，喜欢用比喻解释复杂问题',
    '谨慎型，先确认口径再动手，讨厌返工',
    '行动派，先做出可验证的小版本再迭代',
    '好奇型，喜欢追问“为什么”和“还有没有别的路径”'
  ]
  const ensurePersona = (sessionId, title) => {
    const stored = identityStore.get(sessionId) || {}
    const current = identityOf(sessionId, title || identityTitleOf(sessionId))
    if (current.style && current.persona) return current
    let hash = 0
    const seed = String(sessionId || '')
    for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0
    const style = current.style || PERSONA_STYLES[hash % PERSONA_STYLES.length]
    const persona = current.persona || PERSONA_TEMPLATES[(hash >>> 3) % PERSONA_TEMPLATES.length]
    identityStore.set(sessionId, {
      ...stored,
      handle: stored.handle || current.handle,
      avatar: stored.avatar || current.avatar,
      role: stored.role || current.role || '',
      skills: stored.skills || current.skills || [],
      style,
      persona,
      updatedAt: Date.now()
    })
    logger.info('自动补全人格：' + shortSid(sessionId) + ' · ' + style + ' · ' + persona)
    return identityOf(sessionId, title || identityTitleOf(sessionId))
  }

  const identityTitleOf = (sessionId) => {
    const hit = titleCache.get(sessionId)
    return hit && hit.title ? hit.title : shortSid(sessionId)
  }

  // ---------------------------------------------------------------- 会话引用解析（v2.8.1）
  // 统一入口：完整 id、无 `session-` 前缀 id、contactId、短 id（6 位压缩前缀）、
  // 唯一前缀/后缀、handle、标题（精确优先，其次包含）。
  // 匹配按优先级分层；同一层命中多个 → 返回歧义 + 候选，禁止静默取第一个。
  const sessionRefKeysOf = (session) => {
    const id = String((session && session.id) || '')
    const tail = id.startsWith('session-') ? id.slice(8) : id
    return {
      id: id.toLowerCase(),
      tail: tail.toLowerCase(),
      tailCompact: tail.replace(/-/g, '').toLowerCase(),
      contactId: String((session && session.contactId) || contactIdOf(id)).toLowerCase(),
      handle: String((session && session.handle) || '').trim().toLowerCase(),
      title: String((session && session.title) || '').trim().toLowerCase()
    }
  }

  const describeSessionCandidate = (session) => {
    if (!session) return '(未知)'
    const parts = [formatContactLine(session)]
    if (session.cwd) parts.push('cwd=' + session.cwd)
    if (session.status) parts.push(String(session.status))
    parts.push('完整 id=' + session.id)
    return parts.join(' · ')
  }

  const resolveSessionRef = (ref, candidates, options = {}) => {
    const wantedRaw = String(ref ?? '').trim().replace(/^@+/, '').trim()
    const list = (Array.isArray(candidates) ? candidates : []).filter((item) => item && typeof item.id === 'string' && item.id)
    const failed = (extra = {}) => ({ ok: false, ambiguous: false, candidates: [], ...extra })
    if (!wantedRaw) return failed({ error: '会话引用为空。' })
    if (!list.length) return failed({ error: '当前没有可匹配的会话。' })
    const wanted = wantedRaw.toLowerCase()
    const wantedCompact = wanted.replace(/[^0-9a-z]/g, '')
    const minPrefix = Math.max(3, toNumber(options.minPrefixLength, 4))
    const minContains = Math.max(2, toNumber(options.minContainsLength, 2))
    const tiers = [
      // ① 精确命中 id 类：完整 id / 无前缀 id / contactId / 完整压缩形式
      (keys) =>
        keys.id === wanted ||
        keys.tail === wanted ||
        keys.contactId === wanted ||
        (wantedCompact !== '' && keys.tailCompact === wantedCompact),
      // ② exact handle（名片 ID，用户最可能输入的形式）
      (keys) => keys.handle !== '' && keys.handle === wanted,
      // ③ 唯一前缀/后缀（短 id 6 位、contactId 的一部分、id 结尾片段都走这里）
      (keys) =>
        wanted.length >= minPrefix &&
        (keys.id.startsWith(wanted) ||
          keys.tail.startsWith(wanted) ||
          (wantedCompact !== '' && keys.tailCompact.startsWith(wantedCompact)) ||
          keys.id.endsWith(wanted) ||
          keys.tail.endsWith(wanted) ||
          keys.contactId.endsWith(wanted)),
      // ④ 标题精确
      (keys) => keys.title !== '' && keys.title === wanted,
      // ⑤ 包含匹配（handle/标题的一部分）
      (keys) =>
        wanted.length >= minContains &&
        ((keys.handle !== '' && keys.handle.includes(wanted)) ||
          (keys.title !== '' && keys.title.includes(wanted)))
    ]
    for (const hitTest of tiers) {
      const hits = list.filter((session) => hitTest(sessionRefKeysOf(session)))
      if (hits.length === 1) return { ok: true, session: hits[0], candidates: hits }
      if (hits.length > 1) {
        return {
          ok: false,
          ambiguous: true,
          candidates: hits,
          error:
            `「${wantedRaw}」匹配到 ${hits.length} 个会话，无法确定是哪一个（不会替你猜）：\n- ` +
            hits.slice(0, 8).map(describeSessionCandidate).join('\n- ')
        }
      }
    }
    return failed({
      error:
        `没有匹配「${wantedRaw}」的会话。可用成员：\n- ` +
        list.slice(0, 12).map(describeSessionCandidate).join('\n- ')
    })
  }

  /** 批量解析（group_member sessions、面板加/移成员）：任一失败则整体不执行，避免半套操作。 */
  const resolveSessionRefs = (refs, candidates) => {
    const resolved = []
    const errors = []
    let ambiguous = false
    for (const ref of Array.isArray(refs) ? refs : []) {
      const outcome = resolveSessionRef(ref, candidates)
      if (!outcome.ok) {
        if (outcome.ambiguous) ambiguous = true
        errors.push(outcome.error)
        continue
      }
      if (!resolved.some((item) => item.id === outcome.session.id)) resolved.push(outcome.session)
    }
    return { ok: errors.length === 0 && resolved.length > 0, resolved, errors, ambiguous }
  }

  /** to= 等参数可用逗号/顿号一次指定多个会话引用。 */
  const splitSessionRefs = (ref) =>
    String(ref || '')
      .split(/[,，、;；]+/)
      .map((item) => item.trim())
      .filter(Boolean)

  /** 群成员通讯录（派活消息/错误提示用）：每行 `- contactId · handle · title`。 */
  const memberDirectoryText = (sessions, options = {}) => {
    const list = (Array.isArray(sessions) ? sessions : []).filter(Boolean)
    if (!list.length) return '（暂无成员）'
    return list
      .slice(0, toNumber(options.limit, 20))
      .map((session) => '- ' + formatContactLine(session))
      .join('\n')
  }

  /** 一行式成员列表：contactId（handle）title，用于简短状态行。 */
  const memberInlineText = (sessions, limit = 8) =>
    (Array.isArray(sessions) ? sessions : [])
      .filter(Boolean)
      .slice(0, limit)
      .map((session) => {
        const cid = session.contactId || contactIdOf(session.id)
        const handle = session.handle ? session.handle + ' ' : ''
        return `${cid}（${handle}${session.title || shortSid(session.id)}）`
      })
      .join('、')

  /** 从正文里的 @handle/@contactId/@短id/@标题/@all 解析出被点名的成员。 */
  const parseMentionsInText = (text, candidates) => {
    const source = String(text || '')
    const matched = new Set()
    const all = /@\s*(all|所有人|全体|大家)/i.test(source)
    const unresolved = []
    const ambiguous = []
    const list = (Array.isArray(candidates) ? candidates : []).filter(Boolean)
    const tokens = []
    // 只取 @ 后面不带空白/常见标点的片段；`@@`、`@/` 这类装饰性写法不会产生 token。
    const re = /@([^\s@，,。；;：:！!？?、（）()\[\]【】{}<>"'“”‘’/\\]+)/g
    let match
    while ((match = re.exec(source))) {
      const token = match[1].trim()
      if (!token) continue
      if (/^(all|所有人|全体|大家)$/i.test(token)) continue
      if (!tokens.includes(token)) tokens.push(token)
    }
    for (const token of tokens) {
      const outcome = resolveSessionRef(token, list)
      if (outcome.ok) matched.add(outcome.session.id)
      else if (outcome.ambiguous) ambiguous.push({ token, candidates: outcome.candidates })
      else unresolved.push(token)
    }
    return { ids: [...matched], all, unresolved, ambiguous }
  }

  const buildSessionIndex = async () => {
    let records = []
    const query = ctx.get ? ctx.get('sessionQuery') : undefined
    if (query && typeof query.listSessions === 'function') {
      try {
        const list = await query.listSessions()
        records = list
          .map((item) => {
            const header = item && item.header ? item.header : {}
            return {
              id: typeof header.id === 'string' ? header.id : '',
              cwd: typeof header.cwd === 'string' ? header.cwd : '',
              createdAt: toNumber(header.createdAt, 0),
              live: item && item.live === true,
              agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
              isLead: sessionIsLead(header)
            }
          })
          .filter((item) => item.id && item.isLead)
      } catch (error) {
        logger.warn(`枚举会话失败：${error && error.message ? error.message : error}`)
      }
    }
    if (!records.length) {
      try {
        records = ctx.sessions
          .list()
          .map((session) => {
            const header = session.header || {}
            return {
              id: typeof session.id === 'string' ? session.id : '',
              cwd: typeof header.cwd === 'string' ? header.cwd : '',
              createdAt: toNumber(header.createdAt, 0),
              live: true,
              agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
              isLead: sessionIsLead(header)
            }
          })
          .filter((item) => item.id && item.isLead)
      } catch {
        /* 没有 sessions 服务时保持空列表 */
      }
    }
    records = records.slice(0, 300)
    await readTitles(records.map((record) => record.id))
    const liveAgents = new Map()
    try {
      for (const agent of ctx.agents.list()) liveAgents.set(agent.id, agent)
    } catch {
      /* ignore */
    }
    // Agent Teams 的 teammate 是「implicit-root」会话（header 里可能没有 parentSession），
    // 只能通过 agentTeams 服务的实时 membership 识别：role === 'teammate' 的会话不进列表/群组。
    const teamService = ctx.get ? ctx.get('agentTeams') : undefined
    const teamRoleOf = (agent) => {
      if (!agent || !teamService || typeof teamService.membership !== 'function') return ''
      try {
        const membership = teamService.membership(agent)
        return membership && typeof membership.role === 'string' ? membership.role : ''
      } catch {
        return ''
      }
    }
    // 没有可读标题的会话（mw0xxx / 空标题）给一个展示名，并标记内部会话（旧群管理等），
    // 组员候选/建组列表会过滤掉 internal，避免把子代理或旧管理会话当组员。
    const groupsNow = groupStore.read()
    const managerGroupNames = new Map()
    for (const group of groupsNow) {
      if (group.managerSessionId) managerGroupNames.set(group.managerSessionId, group.name)
    }
    const worldTitleBySession = new Map()
    for (const entry of worldEntriesOf()) {
      for (const sessionId of entry.mentions || []) {
        if (!worldTitleBySession.has(sessionId)) worldTitleBySession.set(sessionId, entry.title)
      }
    }
    const profilesNow = listProfilesOf(boardDir)
    const groupMemberIds = new Set()
    const managerIds = new Set()
    for (const group of groupsNow) {
      for (const sessionId of group.sessionIds || []) groupMemberIds.add(sessionId)
      if (group.managerSessionId) managerIds.add(group.managerSessionId)
    }
    const maintainerId = maintainerStore.get()
    return records
      .map((record) => {
        const hit = titleCache.get(record.id)
        const agent = liveAgents.get(record.id)
        const rawTitle = (hit && hit.title) || ''
        const isUntitled = !rawTitle || /^mw[0-9a-z]+$/i.test(rawTitle) || /^[a-z0-9]{6}$/i.test(rawTitle)
        const managerGroup = managerGroupNames.get(record.id)
        const managerProfile = profilesNow[record.id]
        const looksLikeManager =
          Boolean(managerGroup) ||
          Boolean(managerProfile && String(managerProfile.direction || '').includes('群管理'))
        let title = rawTitle || shortSid(record.id)
        let internal = false
        if (managerGroup) {
          title = `群管理：${managerGroup}`
        } else if (looksLikeManager) {
          title = `群管理（旧，可删）：${shortSid(record.id)}`
          internal = true
        } else if (isUntitled && worldTitleBySession.has(record.id)) {
          title = `世界任务：${String(worldTitleBySession.get(record.id) || '').slice(0, 30)}`
        } else if (isUntitled) {
          title = `会话：${shortSid(record.id)}`
        }
        const repNow = reputationOf(record.id)
        const identity = identityOf(record.id, title)
        return {
          id: record.id,
          contactId: contactIdOf(record.id),
          title,
          handle: identity.handle,
          avatar: identity.avatar,
          role: identity.role,
          skills: identity.skills,
          style: identity.style,
          persona: identity.persona,
          cwd: record.cwd,
          live: record.live || agent !== undefined,
          status: agent ? String(agent.status || 'idle') : record.live ? 'idle' : 'history',
          createdAt: record.createdAt,
          agentPreset: record.agentPreset || '',
          teamRole: teamRoleOf(agent),
          internal,
          points: repNow.points,
          successes: repNow.successes,
          failures: repNow.failures,
          closed: repNow.closed === true,
          hasProfile: Boolean(profilesNow[record.id] && profilesNow[record.id].summary),
          worldEligible:
            !internal &&
            repNow.closed !== true &&
            (Boolean(profilesNow[record.id] && profilesNow[record.id].summary) ||
              groupMemberIds.has(record.id) ||
              record.id === maintainerId),
          isLead: true
        }
      })
      .filter((session) => session.teamRole !== 'teammate' && session.closed !== true)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }

  // ---------------------------------------------------------------- 面板状态快照
  const groupNameMap = () => {
    const map = new Map()
    for (const group of groupStore.read()) map.set(group.id, group.name)
    return map
  }

  /** 面板没有会话上下文：新建「工作区」规矩时用它兜底（优先当前正在跑的会话，其次最新会话）。 */
  const defaultWorkspaceForRule = () => {
    try {
      const roots = ctx.agents.roots()
      const running = roots.find(
        (agent) => agent && agent.status === 'running' && agent.session && agent.session.header && agent.session.header.cwd
      )
      if (running) return running.session.header.cwd
      let best = ''
      let bestAt = -1
      for (const agent of roots) {
        const header = agent && agent.session && agent.session.header
        if (!header || typeof header.cwd !== 'string' || !header.cwd) continue
        const at = toNumber(header.createdAt, 0)
        if (at > bestAt) {
          bestAt = at
          best = header.cwd
        }
      }
      if (best) return best
    } catch {
      /* ignore */
    }
    try {
      let best = ''
      let bestAt = -1
      for (const session of ctx.sessions.list()) {
        const header = session.header || {}
        if (typeof header.cwd !== 'string' || !header.cwd) continue
        const at = toNumber(header.createdAt, 0)
        if (at > bestAt) {
          bestAt = at
          best = header.cwd
        }
      }
      if (best) return best
    } catch {
      /* ignore */
    }
    return ''
  }

  const stateForUi = async () => {
    const groupNames = groupNameMap()
    const rules = store.readActive().map((entry) => ({
      ...entry,
      groupName: entry.groupId ? groupNames.get(entry.groupId) || null : null
    }))
    const groups = groupStore.read().map((group) => ({
      ...group,
      ruleCount: rules.filter((rule) => rule.groupId === group.id).length,
      curatedRules: rules
        .filter((rule) => rule.curated === true && rule.groupId === group.id)
        .map((rule) => ({ id: rule.id, title: rule.title, text: rule.text, ts: rule.ts }))
    }))
    const profiles = listProfilesOf(boardDir)
    const sessions = (await buildSessionIndex()).map((session) => {
      const profile = profiles[session.id]
      return {
        ...session,
        hasProfile: Boolean(profile && profile.summary),
        profileDeclined: Boolean(profile && profile.declined)
      }
    })
    stateSessionsCache.length = 0
    stateSessionsCache.push(...sessions)
    const titleById = new Map(sessions.map((session) => [session.id, session.title]))
    const chatCountByAuthor = new Map()
    for (const entry of rules) {
      if (entry.kind !== 'chat' || !entry.author || entry.author === 'panel') continue
      chatCountByAuthor.set(entry.author, (chatCountByAuthor.get(entry.author) || 0) + 1)
    }
    const reputation = Object.values(reputationStore.read().sessions)
      .map((item) => {
        const badges = []
        if ((item.points || 0) >= 20) badges.push('高信誉')
        if ((item.successes || 0) >= 3) badges.push('稳健')
        if ((chatCountByAuthor.get(item.sessionId) || 0) >= 5) badges.push('气氛组')
        if ((item.failures || 0) >= 3) badges.push('危险')
        if (item.closed) badges.push('已退役')
        return {
          ...item,
          title: titleById.get(item.sessionId) || shortSid(item.sessionId),
          chatCount: chatCountByAuthor.get(item.sessionId) || 0,
          badges
        }
      })
      .sort((a, b) => (b.points || 0) - (a.points || 0))
    const activityDays = []
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date()
      date.setDate(date.getDate() - offset)
      activityDays.push(localDateKey(date.getTime()))
    }
    const activity = groupStore.read().map((group) => {
      const groupEntries = rules.filter(
        (entry) => entry.groupId === group.id && entry.hiddenFromChat !== true && entry.ts
      )
      const recent = groupEntries.filter((entry) => entry.ts >= Date.now() - 7 * 24 * 3600 * 1000)
      const byDay = new Map()
      for (const date of activityDays) byDay.set(date, { date, count: 0, members: new Set() })
      for (const entry of recent) {
        const key = localDateKey(entry.ts)
        const day = byDay.get(key)
        if (!day) continue
        day.count += 1
        if (entry.author && entry.author !== 'panel') day.members.add(entry.author)
      }
      const today = localDateKey(Date.now())
      const talkers = new Map()
      for (const entry of groupEntries) {
        if (entry.kind !== 'chat' || !entry.author || entry.author === 'panel') continue
        talkers.set(entry.author, (talkers.get(entry.author) || 0) + 1)
      }
      const memberStats = group.sessionIds.map((sessionId) => {
        const session = sessions.find((item) => item.id === sessionId)
        const entryDays = new Set(
          groupEntries.filter((entry) => entry.author === sessionId).map((entry) => localDateKey(entry.ts))
        )
        let streak = 0
        for (let index = activityDays.length - 1; index >= 0; index -= 1) {
          if (!entryDays.has(activityDays[index])) break
          streak += 1
        }
        return {
          sessionId,
          handle: (session && session.handle) || shortSid(sessionId),
          avatar: (session && session.avatar) || '👤',
          streak,
          today: entryDays.has(today)
        }
      })
      return {
        groupId: group.id,
        name: group.name,
        days: activityDays.map((date) => ({
          date,
          count: byDay.get(date).count,
          members: byDay.get(date).members.size
        })),
        todayCount: byDay.get(today) ? byDay.get(today).count : 0,
        todayMembers: byDay.get(today) ? byDay.get(today).members.size : 0,
        topTalkers: [...talkers.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([sessionId, count]) => ({ sessionId, count, handle: (sessions.find((item) => item.id === sessionId) || {}).handle || shortSid(sessionId) })),
        memberStats
      }
    })
    const relations = relationStore.list().map((pair) => {
      const aSession = sessions.find((item) => item.id === pair.a)
      const bSession = sessions.find((item) => item.id === pair.b)
      return {
        a: pair.a,
        b: pair.b,
        aHandle: (aSession && aSession.handle) || shortSid(pair.a),
        bHandle: (bSession && bSession.handle) || shortSid(pair.b),
        aTitle: (aSession && aSession.title) || '',
        bTitle: (bSession && bSession.title) || '',
        score: pair.score || 0,
        lastAt: pair.lastAt || 0
      }
    })
    let health = null
    try {
      health = JSON.parse(fs.readFileSync(path.join(boardDir, 'health.json'), 'utf8'))
    } catch {
      health = null
    }
    const maintainerId = maintainerStore.get()
    const maintainerIdentity = maintainerId ? identityOf(maintainerId, identityTitleOf(maintainerId)) : null
    const rawDeliveries = deliveryStore.snapshot()
    const deliveries = {}
    for (const [ruleId, items] of Object.entries(rawDeliveries)) {
      deliveries[ruleId] = items
        .map((item) => ({
          ...item,
          title: titleById.get(item.sessionId) || shortSid(item.sessionId)
        }))
        .sort((a, b) => (b.deliveredAt || 0) - (a.deliveredAt || 0))
    }
    return {
      ok: true,
      version: VERSION,
      defaultWorkspace: defaultWorkspaceForRule(),
      rules,
      groups,
      sessions,
      reputation,
      activity,
      relations,
      maintainer: maintainerId ? { sessionId: maintainerId, ...maintainerIdentity } : null,
      health,
      skills: skillStore.list(),
      profiles,
      world: worldEntriesOf(),
      approvals: readApprovals().filter((item) => item && item.status === 'pending'),
      permissions: readPermissionsOf(boardDir).grants,
      // 串行指令队列（依赖未满足/延迟未到的请求）；UI 用它显示「排队中 / 依赖 X」。
      pendingAsks: (() => {
        try {
          return pendingStore
            .read()
            .filter((item) => item.status === 'queued')
            .map((item) => ({
              id: item.id,
              requestId: item.requestId,
              groupId: item.groupId,
              groupName: item.groupName,
              title: item.title,
              author: item.author,
              targetIds: item.targetIds || [],
              dependsOn: item.dependsOn || [],
              delayMs: item.delayMs || 0,
              notBefore: item.notBefore || 0,
              createdAt: item.createdAt || 0,
              status: item.status
            }))
        } catch {
          return []
        }
      })(),
      pendingStats: (() => {
        try {
          const all = pendingStore.read()
          return {
            queued: all.filter((item) => item.status === 'queued').length,
            sent: all.filter((item) => item.status === 'sent').length,
            failed: all.filter((item) => item.status === 'failed').length
          }
        } catch {
          return { queued: 0, sent: 0, failed: 0 }
        }
      })(),
      capabilities: {
        createSession: Boolean(ctx.agents && typeof ctx.agents.create === 'function'),
        wakeSessions: Boolean(createUserMessage)
      },
      config: currentSettingsSnapshot(),
      deliveries,
      stats: {
        rules: rules.length,
        groups: groups.length,
        sessions: sessions.length,
        profiles: Object.keys(profiles).filter((sessionId) => profiles[sessionId].summary).length
      }
    }
  }

  // ---------------------------------------------------------------- 智能成组（按既有会话的共同特征）
  /** 标题分词：拉丁词 + 中文二元组，用于找「哪些会话在聊同一件事」。 */
  const titleTokensOf = (title) => {
    const tokens = new Set()
    const text = String(title || '').trim()
    if (!text) return tokens
    for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_+.-]{1,}/g)) {
      const token = match[0].toLowerCase()
      if (token.length >= 2) tokens.add(token)
    }
    for (const match of text.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
      const segment = match[0]
      for (let i = 0; i + 1 < segment.length; i += 1) tokens.add(segment.slice(i, i + 2))
    }
    return tokens
  }
  /** 过于泛化、成组没有信息量的中文二元组（英文要保持小写）。 */
  const SUGGEST_STOP_TOKENS = new Set([
    '结果', '测试', '分析', '默认', '工作', '会话', '系统', '版本', '文件', '文档', '说明',
    '记录', '状态', '更新', '修复', '问题', '任务', '使用', '支持', '自动', '进行', '已经',
    '需要', '不是', '没有', '就是', '以及', '相关', '管理', '一个', '可以', '这个', '那个',
    'session', 'results', 'result', 'tmp', 'test', 'temp', 'default', 'data', 'file', 'files', 'dsh'
  ])
  const workspaceDisplayName = (cwd) => {
    const base = path.basename(String(cwd || ''))
    return base || String(cwd || '未知工作区')
  }

  /**
   * 扫描既有主会话，按两类共同特征给「一键成组」建议：
   *  1) 同一工作目录（cwd）——最稳的信号；
   *  2) 标题共同关键词（中文二元组 / 英文词）——把同一话题的会话聚在一起。
   * 已经属于某个群组的会话不再参与建议；建议只包含主会话（子代理/teammate 不出现）。
   */
  const computeGroupSuggestions = async () => {
    const groups = groupStore.read()
    const groupedIds = new Set()
    for (const group of groups) for (const sessionId of group.sessionIds) groupedIds.add(sessionId)
    const now = Date.now()
    const RECENT_MS = 30 * 24 * 3600 * 1000
    const MAX_CLUSTER = 12
    const sessions = (await buildSessionIndex()).filter(
      (session) =>
        session.internal !== true &&
        !groupedIds.has(session.id) &&
        (session.live || now - (session.createdAt || 0) < RECENT_MS)
    )
    if (!sessions.length) return []

    const usedNames = new Set(groups.map((group) => group.name))
    const uniqueName = (base) => {
      let name = base
      let index = 2
      while (usedNames.has(name)) {
        name = `${base} ${index}`
        index += 1
      }
      usedNames.add(name)
      return name
    }
    const recentRatioOf = (list) => {
      const recent = list.filter((session) => now - (session.createdAt || 0) < 7 * 24 * 3600 * 1000).length
      return list.length ? recent / list.length : 0
    }
    const describe = (list) => list.slice(0, 8).map((session) => ({ id: session.id, title: session.title }))

    const candidates = []

    // 只按「共同话题」聚类：同一工作目录不再单独成组（跨工作目录也能一起协作、共享文件）。
    // 信号：标题共同关键词（中文二元组 / 英文词），跨 cwd 合并统计。
    const tokenSessions = new Map()
    for (const session of sessions) {
      for (const token of titleTokensOf(session.title)) {
        if (token.length < 2 || SUGGEST_STOP_TOKENS.has(token)) continue
        if (!tokenSessions.has(token)) tokenSessions.set(token, [])
        tokenSessions.get(token).push(session)
      }
    }
    const keywordCandidates = [...tokenSessions.entries()]
      .filter(([, list]) => list.length >= 2 && list.length <= MAX_CLUSTER)
      .sort((left, right) => right[1].length - left[1].length)
      .slice(0, 40)
    for (const [token, list] of keywordCandidates) {
      const cwds = [...new Set(list.map((session) => session.cwd).filter(Boolean))]
      const workspaceNames = cwds.map((cwd) => workspaceDisplayName(cwd))
      const cross = workspaceNames.length > 1
      candidates.push({
        id: `kw:${token}`,
        name: uniqueName(`「${truncate(token, 12)}」相关`),
        reason: cross
          ? `共同话题「${truncate(token, 20)}」· 跨 ${workspaceNames.length} 个工作目录（${workspaceNames.slice(0, 3).join('、')}${workspaceNames.length > 3 ? ' 等' : ''}）`
          : `共同话题「${truncate(token, 20)}」`,
        kind: 'keyword',
        workspace: '',
        workspaces: cwds,
        sessionIds: list.map((session) => session.id),
        sessions: describe(list),
        size: list.length,
        score: list.length + recentRatioOf(list) * 0.6 + (cross ? 0.8 : 0)
      })
    }

    // 去重：小集合被大集合包含时丢掉；同集合保留 info 更多的 keyword 版本。
    candidates.sort((left, right) => right.size - left.size || right.score - left.score)
    const kept = []
    for (const candidate of candidates) {
      const set = new Set(candidate.sessionIds)
      if (kept.some((entry) => candidate.sessionIds.every((id) => entry.set.has(id)))) continue
      kept.push({ ...candidate, set })
    }
    return kept
      .sort((left, right) => right.score - left.score || right.size - left.size)
      .slice(0, 6)
      .map(({ set, ...rest }) => rest)
  }


  // ---------------------------------------------------------------- 条目过滤与渲染
  const entriesFor = (options = {}) => {
    const now = Date.now()
    const includeOwn = options.includeOwn === true
    const showAll = options.showAll === true
    const cwd = options.cwd || ''
    const sid = options.sessionId || ''
    const scopeMode = options.scopeMode || cfg.scope
    return store
      .readActive()
      .filter((entry) => (includeOwn ? true : entry.author !== sid))
      .filter((entry) => {
        if (showAll) return true
        // 群规矩跨工作目录可见：能不能看只由「是不是群成员」决定（在 visibleEntries 里过滤），
        // 不再要求与群创建者同一 cwd——这是跨工作目录协作/交接的前提。
        if (entry.scope === 'group') return true
        if (entry.scope === 'global' || scopeMode === 'global') return true
        return sameCwd(entry.workspace, cwd)
      })
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
  }

  const visibleEntries = (info, options = {}) => {
    const groups = groupStore.read()
    const myGroupIds = new Set(
      groups.filter((group) => Array.isArray(group.sessionIds) && group.sessionIds.includes(info.id)).map((group) => group.id)
    )
    return entriesFor({
      sessionId: info.id,
      cwd: info.cwd,
      includeOwn: options.includeOwn === true,
      showAll: options.showAll === true
    }).filter((entry) => {
      if (options.showAll === true) return true
      // 群组规矩只投递给群成员；工作区/全局规矩沿用原作用域规则。
      if (entry.groupId) return myGroupIds.has(entry.groupId)
      return true
    })
  }

  /**
   * 群组共享上下文：目标 + 最近的交接/结论 + 关键文件。
   * 目的：同一群组的会话先看这里再动手，避免重复造轮子（而不是只共享"规矩"）。
   */
  const buildGroupBriefLines = (myGroups) => {
    if (!Array.isArray(myGroups) || !myGroups.length) return []
    const active = store.readActive()
    const lines = []
    let wroteHeader = false
    for (const group of myGroups.slice(0, 3)) {
      const groupEntries = active.filter((entry) => entry.groupId === group.id)
      const handoffs = groupEntries
        .filter((entry) => ['handoff', 'decision', 'lesson'].includes(entry.kind))
        .slice(0, 3)
      const requests = groupEntries
        .filter((entry) => entry.kind === 'request' && (entry.status || 'open') === 'open')
        .slice(0, 3)
      const files = [...new Set(groupEntries.flatMap((entry) => (Array.isArray(entry.files) ? entry.files : [])))].slice(0, 8)
      if (!group.goal && !handoffs.length && !files.length) continue
      if (!wroteHeader) {
        lines.push('')
        lines.push('【群组共享上下文 · 先看再动手，避免重复造轮子】')
        wroteHeader = true
      }
      lines.push(`- 群组「${group.name}」${group.goal ? `目标：${group.goal}` : '（目标未设置）'}`)
      for (const entry of handoffs) {
        const body = truncate(String(entry.text || '').replace(/\s*\n\s*/g, ' / '), 200)
        lines.push(`  最近交接：${entry.title} —— ${body}（会话 ${shortSid(entry.author)}，${stableStamp(entry.ts)}）`)
        if (entry.files && entry.files.length) lines.push(`    文件：${entry.files.join('、')}`)
      }
      if (!handoffs.length && files.length) lines.push(`  关键文件：${files.join('、')}`)
      for (const request of requests) {
        const body = truncate(String(request.text || '').replace(/\s*\n\s*/g, ' / '), 160)
        lines.push(`  待响应请求：${request.title} —— ${body}（来自会话 ${shortSid(request.author)}，${stableStamp(request.ts)}；回复用 session_share replyTo=${request.id.slice(0, 14)}…）`)
      }
    }
    if (wroteHeader) {
      lines.push(
        '协作约定：开工前先看群共享上下文（目标 / 交接 / 关键文件）；完成阶段性成果后用 session_share（kind=handoff、group=群名、files=文件）交接给群成员，不要重复做其他成员已经完成的部分。'
      )
    }
    return lines
  }

  const PROFILE_PROMPT_COOLDOWN_MS = 10 * 60 * 1000
  const profilePromptSeenAt = new Map()

  const ownProfileOf = (sessionId) => {
    try {
      return readProfileOf(boardDir, sessionId)
    } catch {
      return null
    }
  }

  /** targeted 模式：只取「发给我的请求」和「对我请求的回复」，且只取还没送达过的。 */
  const targetedInteractionEntries = (info) => {
    const active = store.readActive()
    if (!active.length) return []
    const out = []
    for (const entry of active) {
      if (entry.kind === 'request' && (entry.status || 'open') === 'open') {
        if (Array.isArray(entry.requestTo) && entry.requestTo.includes(info.id)) out.push(entry)
      }
    }
    for (const request of active) {
      if (request.kind !== 'request' || request.author !== info.id || request.status !== 'answered' || !request.replyId) continue
      const reply = active.find((entry) => entry.id === request.replyId)
      if (reply) out.push({ ...reply, __replyTo: request.title })
    }
    // 插话式催收/提醒：不唤醒，只在对方下一次处理时注入一次。
    for (const entry of active) {
      if (entry.nudge !== true) continue
      if (!Array.isArray(entry.requestTo) || !entry.requestTo.includes(info.id)) continue
      out.push({ ...entry, __nudge: true })
    }
    const delivered = deliveryStore.snapshot()
    return out.filter((entry) => {
      const records = delivered[entry.id]
      return !(Array.isArray(records) && records.some((record) => record.sessionId === info.id))
    })
  }

  const renderTargeted = (info) => {
    const lines = []
    const profile = ownProfileOf(info.id)
    if (cfg.autoPrompt !== false && (!profile || !profile.summary) && !(profile && profile.declined)) {
      const last = profilePromptSeenAt.get(info.id) || 0
      if (Date.now() - last > PROFILE_PROMPT_COOLDOWN_MS) {
        profilePromptSeenAt.set(info.id, Date.now())
        lines.push(
          '【经验桥 · 未申报】如果本会话还没问过用户是否注册，请先用一句话询问用户「要不要把本会话注册到经验桥（注册后群内其他会话可按需了解方向/资产，不注册就只做普通对话）」。用户同意后调用 `session_profile action=update` 提交一句话申报（方向/主要资产/需要，总≤200字）；拒绝则调用 `session_profile action=skip`。只问一次，不要未经询问自行申报。'
        )
      }
    }
    const interactions = targetedInteractionEntries(info)
    if (interactions.length) {
      lines.push('【经验桥 · 群内互动（只注入与你会话有关的消息，无需向用户复述）】')
      interactions.slice(0, 5).forEach((entry, index) => {
        const kind = KIND_CN[entry.kind] || '消息'
        const body = truncate(String(entry.text || '').replace(/\s*\n\s*/g, ' / '), cfg.maxChars)
        const filesTag =
          Array.isArray(entry.files) && entry.files.length ? `〔文件：${entry.files.join('、')}〕` : ''
        const replyTag = entry.__replyTo ? `（回复你的请求：${entry.__replyTo}）` : ''
        const nudgeTag = entry.__nudge ? '〔插话·催收提醒，不必单独回复；已完成则忽略〕' : ''
        lines.push(
          `${index + 1}. [${kind}]${nudgeTag} ${entry.title}：${body}${filesTag}${replyTag}（来自会话 ${shortSid(entry.author)}，${stableStamp(entry.ts)}）`
        )
      })
      lines.push(
        '需要回复/交接时用 session_share（group=群名、replyTo=请求id、files=文件）；与本轮无关可忽略。'
      )
      try {
        deliveryStore.recordDeliveries(
          info.id,
          interactions.slice(0, 5).map((entry) => entry.id)
        )
      } catch {
        /* 追踪失败不影响注入 */
      }
    }
    return lines
  }

  const renderForAgent = (agent) => {
    try {
      if (!agent) return ''
      if (!isRootAgent(agent)) return ''
      const info = sessionInfoOf(agent)
      if (!info.id) return ''
      const broadcast = cfg.injectMode === 'broadcast'
      if (!broadcast) {
        // v0.7 默认：定向注入——没被问到的成员不注入任何群信息，只保留「未申报」小提示。
        return renderTargeted(info).join('\n')
      }
      const groups = groupStore.read()
      const myGroups = groups.filter((group) => Array.isArray(group.sessionIds) && group.sessionIds.includes(info.id))
      const entries = visibleEntries(info).slice(0, cfg.maxShown)
      const briefLines = buildGroupBriefLines(myGroups)
      if (!entries.length && !briefLines.length) return ''
      const groupNames = groupNameMap()
      // 自动送达追踪：只在该会话第一次看到某条规矩时落一次盘。
      try {
        deliveryStore.recordDeliveries(info.id, entries.map((entry) => entry.id))
      } catch {
        /* 追踪失败不影响注入 */
      }
      const lines = []
      if (entries.length) {
        lines.push('【跨会话共享经验板 · 自动同步，只作背景参考】')
        lines.push(
          '以下是同一工作区/所属群组其他 DSH 会话共享的通用经验/教训/交接。无需回复或确认；与用户当前要求冲突时以用户当前要求为准；不要主动向用户复述。'
        )
        entries.forEach((entry, index) => {
          const kind = KIND_CN[entry.kind] || '经验'
          const author = shortSid(entry.author)
          const claimed = entry.claimedBy ? `，已被会话 ${shortSid(entry.claimedBy)} 认领` : ''
          const scopeTag = entry.groupId ? `·群组:${groupNames.get(entry.groupId) || '?'}` : ''
          const body = truncate(String(entry.text || '').replace(/\s*\n\s*/g, ' / '), cfg.maxChars)
          const filesTag =
            Array.isArray(entry.files) && entry.files.length ? `〔文件：${entry.files.join('、')}〕` : ''
          lines.push(
            `${index + 1}. [${kind}${scopeTag}] ${entry.title}：${body}${filesTag}（来自会话 ${author}，${stableStamp(entry.ts)}${claimed}）`
          )
        })
      }
      if (briefLines.length) lines.push(...briefLines)
      return lines.join('\n')
    } catch (error) {
      logger.warn(`渲染经验板失败：${error && error.message ? error.message : error}`)
      return ''
    }
  }

  // ---------------------------------------------------------------- 发布
  /** 交接/结论里附带的关键文件：逗号/换行/分号分隔，或数组；最多 8 个。 */
  const normalizeFilesOf = (value) => {
    const raw = Array.isArray(value) ? value : String(value || '').split(/[\n,，;；]+/)
    const files = []
    for (const item of raw) {
      const file = String(item || '').trim().slice(0, 500)
      if (!file || files.includes(file)) continue
      files.push(file)
      if (files.length >= 8) break
    }
    return files
  }

  const addEntry = (input, origin) => {
    const title = String(input.title || '').replace(/\s+/g, ' ').trim().slice(0, 60)
    const text = String(input.text || '').trim().slice(0, 2000)
    if (!title) return { ok: false, reason: '标题为空' }
    if (!text) return { ok: false, reason: '正文为空' }
    const kind = KIND_SET.has(input.kind) ? input.kind : 'note'
    const wantedGroup = typeof input.groupId === 'string' && input.groupId.trim() ? input.groupId.trim() : ''
    const group = wantedGroup ? groupStore.find(wantedGroup, input.workspace || '') : null
    if (wantedGroup && !group) return { ok: false, reason: 'group-not-found' }
    const scope = group ? 'group' : input.scope === 'global' ? 'global' : cfg.scope === 'global' ? 'global' : 'workspace'
    const workspace = group && group.workspace ? group.workspace : input.workspace || ''
    if (scope === 'workspace' && !workspace) return { ok: false, reason: '没有工作目录，无法按工作区共享（可改用 scope=global）' }

    const now = Date.now()
    const ttlHours = toNumber(
      input.ttlHours,
      kind === 'handoff' || kind === 'request' || kind === 'command' || kind === 'task' ? cfg.handoffTtlHours : kind === 'chat' || kind === 'discussion' ? 24 : cfg.ttlHours
    )
    const active = store.readActive()

    // 查重：同作用域、48 小时内、相似度高 → 视为重复（面板主动发布的工作安排允许重复）
    if (!input.skipDedupe) {
      for (const entry of active) {
        if (now - (entry.ts || 0) > 48 * 3600 * 1000) continue
        if (entry.scope !== scope) continue
        if (scope === 'group' && entry.groupId !== group.id) continue
        if (scope === 'workspace' && !sameCwd(entry.workspace, workspace)) continue
        if (similarity(`${entry.title} ${entry.text}`, `${title} ${text}`) >= 0.82) {
          return { ok: false, reason: 'duplicate', existing: entry }
        }
      }
    }

    const id = `n-${now.toString(36)}-${randomBytes(3).toString('hex')}`
    const entry = {
      id,
      kind,
      scope,
      groupId: group ? group.id : null,
      workspace,
      author: input.author || '',
      title,
      text,
      tags: String(input.tags || '')
        .split(/[,，;；\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 8),
      files: normalizeFilesOf(input.files),
      requestTo: Array.isArray(input.requestTo)
        ? [...new Set(input.requestTo.filter((item) => typeof item === 'string' && item))].slice(0, 12)
        : [],
      mentions: Array.isArray(input.mentions)
        ? [...new Set(input.mentions.filter((item) => typeof item === 'string' && item))].slice(0, 12)
        : [],
      channel: typeof input.channel === 'string' && input.channel ? input.channel : '',
      hiddenFromChat: input.hiddenFromChat === true,
      nudge: input.nudge === true,
      curated: input.curated === true,
      taskId: typeof input.taskId === 'string' ? input.taskId : '',
      taskRole: typeof input.taskRole === 'string' ? input.taskRole : '',
      ...(kind === 'task'
        ? {
            taskStatus: input.taskStatus || 'assigned',
            coordinator: input.coordinator || '',
            assignees: Array.isArray(input.assignees) ? input.assignees : [],
            ...(Array.isArray(input.steps) && input.steps.length
              ? { steps: input.steps.map((step, index) => ({ ...step, i: toNumber(step && step.i, index + 1) })) }
              : {})
          }
        : {}),
      ...(kind === 'request'
        ? {
            // 串行指令：先落一条 status=queued 的请求（依赖未满足时不唤醒任何人），
            // 调度器满足依赖后把它改回 open 再唤醒。
            status: input.status === 'queued' ? 'queued' : 'open',
            ...(Array.isArray(input.dependsOn) && input.dependsOn.length ? { dependsOn: input.dependsOn } : {}),
            ...(toNumber(input.notBefore, 0) > 0 ? { notBefore: toNumber(input.notBefore, 0) } : {}),
            ...(toNumber(input.taskStep, 0) > 0 ? { taskStep: toNumber(input.taskStep, 0) } : {})
          }
        : {}),
      origin: origin || 'tool',
      ts: now,
      expiresAt: ttlHours > 0 ? now + ttlHours * 3600 * 1000 : 0
    }
    try {
      appendEvents(boardDir, [{ op: 'add', id, entry, ts: now }])
    } catch (error) {
      return { ok: false, reason: `写盘失败：${error && error.message ? error.message : error}` }
    }

    // 容量控制：超出 maxStored 的旧条目追加 remove 事件
    try {
      const overflow = [...active, entry]
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(cfg.maxStored)
      if (overflow.length) {
        appendEvents(
          boardDir,
          overflow.map((old) => ({ op: 'remove', id: old.id, by: 'overflow', reason: '超出容量上限', ts: Date.now() }))
        )
      }
      compactIfNeeded(boardDir, logger)
    } catch {
      /* 容量整理失败不影响发布结果 */
    }

    logger.info(
      `发布条目 ${id} [${kind}/${scope}${group ? `/群组:${group.name}` : ''}] ${title}（来自会话 ${shortSid(entry.author)}，origin=${entry.origin}）`
    )
    return { ok: true, entry, group }
  }

  // ---------------------------------------------------------------- 系统提示词
  if (cfg.instructions !== false) {
    try {
      ctx.systemPrompt.section({
        name: 'session-bridge:instructions',
        order: cfg.sectionOrder,
        // 说明段是静态文案，但一律关掉 {{variable}} 插值：文本里带花括号时插值会抛错，
        // 一旦抛错整个 assemble() 失败、这一轮就发不出模型请求。
        interpolate: false,
        // 只给主会话看说明；子智能体/团队成员不参与跨会话共享，说明段返回空串即不注入。
        text: (context) => {
          try {
            return isRootAgent(context && context.agent) ? INSTRUCTIONS : ''
          } catch {
            return ''
          }
        }
      })
      registration.section = true
    } catch (error) {
      logger.warn(`注册系统提示词说明失败：${error && error.message ? error.message : error}`)
    }
  }

  try {
    ctx.systemPrompt.context({
      name: 'session-bridge:board',
      order: cfg.contextOrder,
      required: true,
      // 经验板正文完全来自用户/模型文本，必须关插值（出现 {{…}} 会让每一步的 assemble 抛错）。
      interpolate: false,
      text: (context) => renderForAgent(context && context.agent)
    })
    registration.context = true
  } catch (error) {
    logger.warn(`注册运行时上下文失败：${error && error.message ? error.message : error}`)
  }

  // ---------------------------------------------------------------- 主机侧自动捕获
  const AUTOCAPTURE_RULES = [
    { re: /(共享|同步|转发|转告|告诉|通知|发)\s*(给)?\s*(其他|其它|别的|所有)\s*(会话|session|对话|窗口)/i, kind: 'note' },
    { re: /让\s*(其他|其它|别的|所有)\s*(会话|session|对话|窗口)\s*(也)?\s*(知道|看到|了解|遵守)/i, kind: 'note' },
    { re: /交接\s*(给)?\s*(其他|其它|别的|另一个|新|下一个)?\s*(会话|session)/i, kind: 'handoff' },
    { re: /(共享|同步|转发)\s*(到)?\s*(经验板|看板|board)/i, kind: 'note' },
    { re: /share\s+(this|it)?\s*(with|to)?\s*(the\s+)?(other|all)\s+sessions?/i, kind: 'note' },
    { re: /tell\s+(the\s+)?other\s+sessions?/i, kind: 'note' }
  ]
  const captureSeen = new Map() // hash -> ts，避免同一句话被重复捕获

  const captureTitle = (text) => {
    const first = String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || ''
    const cleaned = first
      .replace(/^(请|麻烦|帮我|帮忙)?\s*(把|将)?\s*(这条|这个|以下|下面)?\s*(共享|同步|转发|转告|告诉|通知|交接)\s*(给)?\s*(其他|其它|别的|所有)?\s*(会话|session|对话|窗口)?\s*[：:，,。]?\s*/i, '')
      .trim()
    return truncate(cleaned || first, 40)
  }

  const userTextOf = (event) => {
    const data = event && event.data
    if (!data || !Array.isArray(data.content)) return ''
    return data.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
  }

  const onSessionEvent = (subject, event) => {
    if (!cfg.autoCapture) return
    if (!event || event.type !== 'user/message') return
    const source = event.data && event.data.source
    if (!source || source.kind !== 'user') return
    const sessionId = subject && typeof subject.id === 'string' ? subject.id : ''
    if (!sessionId) return
    // 只处理主会话（子智能体/团队成员的输入不广播）
    let agent = null
    try {
      agent = ctx.agents.get(sessionId)
    } catch {
      agent = null
    }
    if (!agent || !isRootAgent(agent)) return

    const text = userTextOf(event)
    if (text.length < 4 || text.length > 1500) return
    const matched = AUTOCAPTURE_RULES.find((rule) => rule.re.test(text))
    if (!matched) return

    const hash = createHash('sha1').update(`${sessionId}\u0000${normalizeText(text)}`).digest('hex')
    const now = Date.now()
    const last = captureSeen.get(hash)
    if (last && now - last < 120000) return
    captureSeen.set(hash, now)
    if (captureSeen.size > 500) {
      for (const [key, ts] of captureSeen) if (now - ts > 3600000) captureSeen.delete(key)
    }

    const info = sessionInfoOf(agent)
    const result = addEntry(
      {
        title: captureTitle(text),
        text: text.slice(0, 1200),
        kind: matched.kind,
        scope: cfg.scope,
        workspace: info.cwd,
        author: sessionId,
        tags: 'auto-captured'
      },
      'auto'
    )
    if (result.ok) logger.info(`自动捕获用户指令并发布：${result.entry.id}`)
  }

  try {
    ctx.on('session/event', (subject, event) => {
      try {
        onSessionEvent(subject, event)
      } catch (error) {
        logger.warn(`自动捕获处理失败：${error && error.message ? error.message : error}`)
      }
    })
  } catch (error) {
    logger.warn(`挂载 session/event 监听失败：${error && error.message ? error.message : error}`)
  }

  // ---------------------------------------------------------------- 工具
  // 直接用普通对象注册（与 wechat-inbox 插件的兜底路径一致）：工具注册表只读取
  // name/description/parameters/output/execute 这些字段，不强制要求 defineTool 包装。
  //
  // ⚠️ parameters 必须是「标准 JSON Schema」，注册表不会替我们编译 defineTool 的 DSL。
  //    之前这里写的是 DSL（{ title: { type:'string', required:true } }）：根对象上出现了
  //    名为 title 的键，而 JSON Schema 的 title 关键字必须是字符串，provider 直接以
  //    "Invalid schema for function 'session_share'" 400 拒绝整个请求（turn 直接失败）。
  //    规则：根上只放 type/properties/required；required 是字符串数组，不能写进属性里。
  const parametersAreJsonSchema = (parameters) => {
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return false
    if (parameters.type !== 'object') return false
    if (!parameters.properties || typeof parameters.properties !== 'object' || Array.isArray(parameters.properties)) return false
    if (parameters.required !== undefined) {
      if (!Array.isArray(parameters.required)) return false
      if (parameters.required.some((key) => typeof key !== 'string' || !(key in parameters.properties))) return false
    }
    for (const value of Object.values(parameters.properties)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      if (typeof value.type !== 'string' && !Array.isArray(value.oneOf) && !Array.isArray(value.anyOf)) return false
    }
    return true
  }

  const register = (definition) => {
    if (!parametersAreJsonSchema(definition.parameters)) {
      failedTools.push(definition.name)
      const reason = `工具 ${definition.name} 的 parameters 不是对象根 JSON Schema，已拒绝注册（否则 provider 会 400）`
      logger.warn(reason)
      try {
        if (ctx.logger && typeof ctx.logger.error === 'function') ctx.logger.error(`[session-bridge] ${reason}`)
      } catch {
        /* ignore */
      }
      return
    }
    try {
      ctx.tools.register(definition)
      registeredTools.push(definition.name)
    } catch (error) {
      failedTools.push(definition.name)
      logger.warn(`注册工具 ${definition.name} 失败：${error && error.message ? error.message : error}`)
    }
  }

  /** 任何 agent（含 subagent/teammate）都要能拿到自己的会话信息。 */
  const requireAgent = (exec) => {
    const agent = exec && exec.agent
    if (!agent) return { error: '无法确定当前会话，请从主会话调用。' }
    return { agent }
  }

  /** 只有主会话能发布 / 删除 / 认领；子会话仍可只读查看（session_board list/status）。 */
  const requireRootAgent = (exec) => {
    const guard = requireAgent(exec)
    if (guard.error) return guard
    if (!isRootAgent(guard.agent)) {
      return { error: '子会话不直接向经验板发布内容；请让所属主会话发布（子会话仍可只读查看：session_board action=list/status）。' }
    }
    return guard
  }

  // ---------------------------------------------------------------- 群内请求：唤醒其它会话
  /** 构造一条从插件发给目标会话的 user 消息（优先官方构造器，离线环境退化为等价对象）。 */
  const makeBridgeMessage = (text, meta = {}) => {
    const source = { kind: 'session-bridge', ...(meta.requestId ? { requestId: meta.requestId } : {}) }
    if (createUserMessage) {
      try {
        return createUserMessage({ content: [{ type: 'text', text }], source })
      } catch {
        /* 退化为普通对象 */
      }
    }
    return {
      id: `msg-${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source,
      createdAt: Date.now()
    }
  }

  /** 唤醒一个在线会话（followup 会开一轮并让它处理消息）；不在线返回 not-live。 */
  const wakeSession = (sessionId, text, meta = {}) => {
    try {
      const agent = ctx.agents.get(sessionId)
      if (!agent || typeof agent.followup !== 'function') return { ok: false, reason: 'not-live' }
      ensurePersona(sessionId)
      const persona = personaLineFor(sessionId)
      const fullText = persona && !String(text).includes('【你的人设】') ? String(text) + '\n\n' + persona : text
      agent.followup(makeBridgeMessage(fullText, meta))
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : String(error) }
    }
  }

  const findRequestEntry = (ref) => {
    const wanted = String(ref || '').trim()
    if (!wanted) return null
    const candidates = store.readActive().filter((entry) => entry.kind === 'request')
    return (
      candidates.find((entry) => entry.id === wanted) ||
      candidates.find((entry) => entry.id.startsWith(wanted)) ||
      null
    )
  }

  const findBoardEntry = (ref) => {
    const wanted = String(ref || '').trim()
    if (!wanted) return null
    const active = store.readActive()
    return active.find((entry) => entry.id === wanted) || active.find((entry) => entry.id.startsWith(wanted)) || null
  }

  const managerNotifyAt = new Map()

  // ---------------------------------------------------------------- 串行指令（依赖 / 延迟）
  // 用户需求：组内任务有先后依赖时，组长可以「延时发送下一条指令」，即串行而不是全并行。
  // 做法：session_ask 带 dependsOn / delayMs 时不立即唤醒，先把请求以 status=queued 落进看板，
  // 并把队列项写进 pending-asks.json；调度器在前置 answered / 任务 done 且过了 delayMs 后自动发出。
  const DEP_MAX_ITEMS = 5
  const DEP_TICK_MS = 15000
  const DEP_MAX_DELAY_MS = 7 * 24 * 3600 * 1000

  const parseDependencyRefs = (value) => {
    const raw = Array.isArray(value) ? value.join(',') : String(value || '')
    return [...new Set(raw.split(/[,，;；、\s]+/).map((item) => item.trim()).filter(Boolean))].slice(0, DEP_MAX_ITEMS)
  }

  const findQueuedRef = (ref, items) => {
    const wanted = String(ref || '').trim()
    if (!wanted) return null
    const list = Array.isArray(items) ? items : pendingStore.read()
    return (
      list.find((item) => item.id === wanted) ||
      list.find((item) => item.requestId === wanted) ||
      list.find((item) => item.id.startsWith(wanted)) ||
      list.find((item) => typeof item.requestId === 'string' && item.requestId.startsWith(wanted)) ||
      null
    )
  }

  /**
   * 依赖是否完成：只认 request=answered（有人用 replyTo 回复）或 task=done。
   * 讨论/聊天消息不算完成，避免「在群里说一句」就误触发下一步。
   */
  const dependencySatisfied = (entry) => {
    if (!entry) return false
    if (entry.kind === 'request') return entry.status === 'answered' || Boolean(entry.answeredBy) || Boolean(entry.replyId)
    if (entry.kind === 'task') return entry.taskStatus === 'done'
    return false
  }

  const dependencySummary = (entry) => {
    if (!entry) return '（已丢失）'
    const state = dependencySatisfied(entry)
      ? entry.kind === 'task'
        ? '任务已完成'
        : '已回复'
      : entry.kind === 'task'
        ? `任务未完成（${entry.taskStatus || 'assigned'}）`
        : entry.status === 'queued'
          ? '排队中'
          : '未回复'
    return `${entry.id}（${KIND_CN[entry.kind] || entry.kind}「${truncate(entry.title || '', 16)}」${state}）`
  }

  /** 谁能排串行指令：组长、维护者；群还没设组长时任何成员都能排（保持旧用法可用）。 */
  const canQueueAsk = (group, sessionId) => {
    if (!group) return { ok: false, message: '找不到群组。' }
    if (group.managerSessionId && group.managerSessionId === sessionId) return { ok: true, role: 'manager' }
    const maintainerId = maintainerStore.get()
    if (maintainerId && maintainerId === sessionId) return { ok: true, role: 'maintainer' }
    if (!group.managerSessionId || !group.sessionIds.includes(group.managerSessionId)) {
      return { ok: true, role: 'no-manager' }
    }
    return {
      ok: false,
      message: [
        '只有组长 / 维护者可以排串行指令（dependsOn / delayMs）。',
        `群「${group.name}」的组长是 ${shortSid(group.managerSessionId)}（contactId=${contactIdOf(group.managerSessionId)}）；请让组长来排，或让用户在面板里改组长。`,
        '不传 dependsOn / delayMs 时，session_ask 仍是立即发送。'
      ].join('\n')
    }
  }

  /** 探测/任务两种唤醒文案（立即发送与排队后发送共用，避免两套模板漂移）。 */
  const buildAskMessage = ({ askMode, text, group, requestId, assignmentTask, authorId }) => {
    if (askMode === 'task') {
      if (assignmentTask) {
        return [
          `【任务分配 · 群任务：${assignmentTask.title}】`,
          text,
          '',
          `请只做你负责的部分；完成后用 session_share（kind=handoff、group=${group.name}、replyTo=${requestId}、files=文件路径）提交给组长，不要直接向用户汇报，也不要重复执行其他成员的任务。`,
          `（来自会话 ${shortSid(authorId)} · 群组「${group.name}」）`
        ].join('\n')
      }
      return [
        '【任务分配 · 群内派活】',
        text,
        '',
        `请执行/完成上面的工作；完成后用 session_share（kind=handoff、group=${group.name}、replyTo=${requestId}、files=文件路径）回复，正文写清结果/进度；不要展开无关分析。`,
        `（来自会话 ${shortSid(authorId)} · 群组「${group.name}」）`
      ].join('\n')
    }
    return [
      '【群内请求 · 探测（不是任务） · 请直接回答正文】',
      text,
      '',
      '（这是探测/询问：只需针对正文简短回答或给一句结论，不要自行扩大成复核/改稿任务；如果正文其实是明确的修改或交付要求，请按任务执行并回报结果。）',
      `（来自会话 ${shortSid(authorId)} · 群组「${group.name}」）`
    ].join('\n')
  }

  /** 把队列里的一条指令真正发出去：先回写看板状态，再唤醒（尽量少改动原有 wake 链）。 */
  const dispatchQueuedAsk = (item) => {
    const group = groupStore.read().find((entry) => entry.id === item.groupId) || null
    if (!group) return { ok: false, reason: '群组已被删除' }
    const grants = readPermissionsOf(boardDir).grants[item.author] || []
    const wantedTargets = Array.isArray(item.targetIds) ? item.targetIds : []
    const allowed = wantedTargets.filter((id) => group.sessionIds.includes(id) && grants.includes(id))
    const skipped = wantedTargets.filter((id) => !allowed.includes(id))
    if (!allowed.length) return { ok: false, reason: '目标成员已不在群或唤醒授权被撤销' }
    const assignmentTask = item.taskId ? findBoardEntry(item.taskId) : null
    const message = buildAskMessage({
      askMode: item.askMode,
      text: item.text,
      group,
      requestId: item.requestId,
      assignmentTask,
      authorId: item.author
    })
    const now = Date.now()
    try {
      appendEvents(boardDir, [
        { op: 'task', id: item.requestId, patch: { status: 'open', dispatchedAt: now, queuedBefore: true }, ts: now }
      ])
    } catch {
      /* 状态回写失败不影响已经发出的唤醒 */
    }
    const woken = []
    const sleepy = []
    for (const targetId of allowed) {
      const outcome = wakeSession(targetId, message, { requestId: item.requestId })
      if (outcome.ok) woken.push(targetId)
      else sleepy.push(targetId)
    }
    if (item.taskId) {
      try {
        appendEvents(boardDir, [{ op: 'task', id: item.taskId, patch: { taskStatus: 'delegating' }, ts: now }])
      } catch {
        /* ignore */
      }
      const stepNo = toNumber(item.taskStep, 0)
      if (stepNo > 0) {
        try {
          const task = findBoardEntry(item.taskId)
          if (task && Array.isArray(task.steps) && task.steps[stepNo - 1]) {
            const steps = task.steps.map((step, index) =>
              index === stepNo - 1 ? { ...step, status: 'dispatched', requestId: item.requestId, dispatchedAt: now } : step
            )
            appendEvents(boardDir, [{ op: 'task', id: item.taskId, patch: { steps }, ts: now }])
          }
        } catch {
          /* ignore */
        }
      }
    }
    return { ok: true, woken, sleepy, skipped }
  }

  /** 串行步骤回写：请求 answered 后把对应任务步骤标记 done（只认 answered，不认讨论消息）。 */
  const syncCompletedTaskSteps = (active, now) => {
    const byId = new Map(active.map((entry) => [entry.id, entry]))
    for (const entry of active) {
      if (entry.kind !== 'request' || !entry.taskId) continue
      const stepNo = toNumber(entry.taskStep, 0)
      if (stepNo <= 0 || !dependencySatisfied(entry)) continue
      const task = byId.get(entry.taskId)
      if (!task || !Array.isArray(task.steps)) continue
      const index = stepNo - 1
      const step = task.steps[index]
      if (!step || step.status === 'done') continue
      const steps = task.steps.map((current, i) =>
        i === index ? { ...current, status: 'done', requestId: entry.id, doneAt: now } : current
      )
      try {
        appendEvents(boardDir, [{ op: 'task', id: task.id, patch: { steps }, ts: now }])
      } catch {
        /* ignore */
      }
      task.steps = steps
    }
  }

  /**
   * 队列巡检：找依赖已满足、延迟已到的排队指令 → 发出并唤醒。
   * 找不到依赖、循环依赖、排队超时都不会死等，一律标记 failed 并通知发起人。
   */
  const runPendingQueue = ({ source = 'timer' } = {}) => {
    const report = { source, checked: 0, dispatched: [], waiting: [], failed: [], errors: [] }
    let items = []
    try {
      items = pendingStore.read()
    } catch (error) {
      report.errors.push(`读取队列失败：${error && error.message ? error.message : error}`)
      return report
    }
    if (!items.length) return report
    const now = Date.now()
    const active = store.readActive()
    try {
      syncCompletedTaskSteps(active, now)
    } catch (error) {
      report.errors.push(`步骤回写失败：${error && error.message ? error.message : error}`)
    }
    const queuedItems = items.filter((item) => item.status === 'queued')
    if (!queuedItems.length) {
      persistPendingQueue(items, now)
      return report
    }
    const byId = new Map(active.map((entry) => [entry.id, entry]))
    const resolveDependency = (ref) => {
      const queued = findQueuedRef(ref, items)
      if (queued) {
        if (queued.status === 'queued') return { kind: 'queue', queued }
        if (queued.status === 'sent') {
          const entry = queued.requestId ? byId.get(queued.requestId) : null
          return entry ? { kind: 'entry', entry } : null
        }
        return { kind: 'queue', queued }
      }
      const entry = byId.get(ref) || active.find((row) => typeof row.id === 'string' && row.id.startsWith(ref))
      return entry ? { kind: 'entry', entry } : null
    }
    // 循环依赖：排队项之间互相等待时无法自动前进，必须报错而不是死等。
    const nodes = new Set(queuedItems.map((item) => item.requestId).filter(Boolean))
    const edges = new Map()
    for (const item of queuedItems) {
      const deps = []
      for (const ref of item.dependsOn || []) {
        const resolved = resolveDependency(ref)
        if (!resolved) continue
        const nodeId = resolved.kind === 'queue' ? resolved.queued.requestId : resolved.entry.id
        if (nodeId && nodes.has(nodeId) && nodeId !== item.requestId) deps.push(nodeId)
      }
      edges.set(item.requestId, deps)
    }
    const cycleNodes = new Set()
    const colors = new Map()
    const stack = []
    const visit = (node) => {
      const color = colors.get(node) || 0
      if (color === 2) return
      if (color === 1) {
        const start = stack.indexOf(node)
        for (const hit of stack.slice(start >= 0 ? start : 0)) cycleNodes.add(hit)
        return
      }
      colors.set(node, 1)
      stack.push(node)
      for (const next of edges.get(node) || []) visit(next)
      stack.pop()
      colors.set(node, 2)
    }
    for (const node of edges.keys()) visit(node)

    const markFailed = (item, message) => {
      item.status = 'failed'
      item.lastError = message
      item.updatedAt = now
      report.failed.push({ id: item.id, requestId: item.requestId, title: item.title, error: message })
      try {
        appendEvents(boardDir, [
          { op: 'task', id: item.requestId, patch: { status: 'failed', failReason: message }, ts: now }
        ])
      } catch {
        /* ignore */
      }
      try {
        wakeSession(
          item.author,
          [
            '【串行指令未发出 · 排队失败】',
            `请求：${item.title}（id=${item.requestId}）`,
            `原因：${message}`,
            '请调整 dependsOn / delayMs 后重新用 session_ask 排队。'
          ].join('\n'),
          {}
        )
      } catch {
        /* 通知失败不影响标记 */
      }
    }

    for (const item of queuedItems) {
      report.checked += 1
      const age = now - toNumber(item.createdAt, now)
      if (age > PENDING_TTL_MS) {
        markFailed(item, '排队超过 48 小时仍未等到前置完成（避免无限等待）')
        continue
      }
      if (item.requestId && cycleNodes.has(item.requestId)) {
        markFailed(item, '循环依赖：与其它排队指令互相等待（检查 dependsOn 是否成环）')
        continue
      }
      let missing = ''
      const unmet = []
      for (const ref of item.dependsOn || []) {
        const resolved = resolveDependency(ref)
        if (!resolved) {
          missing = ref
          break
        }
        if (resolved.kind === 'queue') {
          const state = resolved.queued.status
          if (state === 'failed' || state === 'expired') {
            missing = `${ref}（前置排队失败）`
            break
          }
          if (state === 'cancelled') {
            missing = `${ref}（前置已取消）`
            break
          }
          unmet.push({
            id: resolved.queued.requestId,
            kind: 'request',
            title: resolved.queued.title,
            status: 'queued'
          })
          continue
        }
        if (!dependencySatisfied(resolved.entry)) unmet.push(resolved.entry)
      }
      if (missing) {
        markFailed(item, `找不到前置依赖 ${missing}`)
        continue
      }
      if (unmet.length) {
        report.waiting.push({ id: item.id, requestId: item.requestId, dependsOn: unmet.map((entry) => dependencySummary(entry)) })
        continue
      }
      const notBefore = toNumber(item.notBefore, 0)
      if (notBefore > now) {
        report.waiting.push({ id: item.id, requestId: item.requestId, waitMs: notBefore - now })
        continue
      }
      const outcome = dispatchQueuedAsk(item)
      if (!outcome.ok) {
        markFailed(item, outcome.reason || '发送失败')
        continue
      }
      item.status = 'sent'
      item.sentAt = now
      item.updatedAt = now
      item.lastWoken = outcome.woken.length
      item.lastSleepy = outcome.sleepy.length
      report.dispatched.push({
        id: item.id,
        requestId: item.requestId,
        title: item.title,
        woken: outcome.woken.length,
        sleepy: outcome.sleepy.length,
        skipped: outcome.skipped.length
      })
      logger.info(
        `串行指令已发出：${item.id} → 请求 ${item.requestId}（唤醒 ${outcome.woken.length}，离线 ${outcome.sleepy.length}）`
      )
    }
    persistPendingQueue(items, now, { force: report.dispatched.length > 0 || report.failed.length > 0 })
    return report
  }

  /**
   * 落盘队列（调度结束后统一写一次，避免每条都写）。
   * force=true 时即使没有清理也写——否则 queued→sent/failed 的状态变化会丢，
   * 下一轮巡检会把同一条指令再发一次（重复唤醒）。
   * 清理策略：queued 一直保留；sent 只留 1 小时（已发出就不用再排队）；失败/取消留 7 天便于排查。
   */
  const persistPendingQueue = (items, now, options = {}) => {
    try {
      const keep = items.filter((item) => {
        if (item.status === 'queued') return true
        const age = now - toNumber(item.updatedAt, toNumber(item.createdAt, now))
        if (item.status === 'sent') return age < 60 * 60 * 1000
        return age < 7 * 24 * 3600 * 1000
      })
      if (options.force || keep.length !== items.length) pendingStore.write(keep.slice(-PENDING_MAX_ITEMS))
    } catch {
      /* 清理失败不影响调度 */
    }
  }

  /**
   * 排队：先落 status=queued 的请求条目，再写队列。
   * 返回给模型的中文说明必须写清「等什么、什么时候发、怎么查」。
   */
  const enqueueAskRequest = ({ group, info, text, title, targets, askMode, assignmentTask, dependsOn, delayMs, step }) => {
    const gate = canQueueAsk(group, info.id)
    if (!gate.ok) return gate.message
    const items = pendingStore.read()
    const resolved = []
    const unknown = []
    for (const ref of dependsOn) {
      const entry = findBoardEntry(ref)
      if (entry) {
        if (entry.kind !== 'request' && entry.kind !== 'task') {
          unknown.push(`${ref}（是 ${KIND_CN[entry.kind] || entry.kind}，不能当依赖）`)
          continue
        }
        resolved.push({ ref, entry })
        continue
      }
      const queued = findQueuedRef(ref, items)
      if (queued && (queued.status === 'queued' || queued.status === 'sent')) {
        resolved.push({ ref, queued })
        continue
      }
      if (queued) {
        unknown.push(`${ref}（前置队列状态 ${queued.status}）`)
        continue
      }
      unknown.push(ref)
    }
    if (unknown.length) {
      return [
        `找不到前置依赖：${unknown.join('、')}。`,
        'dependsOn 只能填已存在的请求 id（session_ask 返回的 id）、群任务 id 或排队项 id；',
        '注意：依赖必须是**已经创建**的条目——先发步骤 1，拿到它的 id，再把 id 写进步骤 2 的 dependsOn。',
        '（本条没有排队，也没有唤醒任何人。）'
      ].join('\n')
    }
    const now = Date.now()
    const notBefore = delayMs > 0 ? now + delayMs : 0
    // 依赖统一落成「请求 id / 任务 id」，即使队列项被清理也能继续判定。
    const canonicalDeps = resolved.map((item) => (item.entry ? item.entry.id : item.queued.requestId || item.ref))
    const result = addEntry(
      {
        title,
        text,
        kind: 'request',
        groupId: group.id,
        workspace: info.cwd,
        author: info.id,
        requestTo: targets.map((session) => session.id),
        mentions: targets.map((session) => session.id),
        status: 'queued',
        dependsOn: canonicalDeps,
        notBefore,
        ...(step > 0 ? { taskStep: step } : {}),
        ...(assignmentTask ? { taskId: assignmentTask.id, taskRole: 'member' } : {})
      },
      'tool'
    )
    if (!result.ok) return `发布请求失败：${result.reason}`
    const requestId = result.entry.id
    const item = {
      id: `q-${now.toString(36)}-${randomBytes(3).toString('hex')}`,
      requestId,
      groupId: group.id,
      groupName: group.name,
      workspace: info.cwd || '',
      author: info.id,
      title,
      text,
      askMode,
      targetIds: targets.map((session) => session.id),
      taskId: assignmentTask ? assignmentTask.id : '',
      taskStep: step > 0 ? step : 0,
      dependsOn: canonicalDeps,
      delayMs: delayMs > 0 ? delayMs : 0,
      notBefore,
      createdAt: now,
      status: 'queued'
    }
    try {
      pendingStore.upsert(item)
    } catch (error) {
      // 队列写不进去时把看板条目也标记失败，避免留下一个永远 queued 的孤儿请求。
      try {
        appendEvents(boardDir, [
          { op: 'task', id: requestId, patch: { status: 'failed', failReason: '队列写盘失败' }, ts: Date.now() }
        ])
      } catch {
        /* ignore */
      }
      return `排队失败（写盘错误）：${error && error.message ? error.message : error}`
    }
    // 依赖已满足且没有延迟时，不额外等一轮巡检：立刻尝试发出。
    let kick = null
    try {
      kick = runPendingQueue({ source: 'enqueue' })
    } catch {
      kick = null
    }
    const justSent = kick && kick.dispatched.find((entry) => entry.requestId === requestId)
    if (justSent) {
      return [
        `前置依赖已完成，已直接发出：${title}（id=${requestId}）`,
        `目标成员：${memberInlineText(targets) || '(无)'}`,
        justSent.woken > 0
          ? `已唤醒 ${justSent.woken} 个在线会话，它们会立即处理；`
          : '成员当前都不在线，下次运行会看到这条请求；',
        justSent.sleepy > 0 ? `${justSent.sleepy} 个成员不在线，靠「下次运行注入」；` : '',
        `等待交付：对方用 session_share（kind=handoff、replyTo=${requestId}）回复后本会话会被通知。`
      ]
        .filter(Boolean)
        .join('\n')
    }
    const lines = [
      `已排队，等待前置完成：${title}（id=${requestId}，队列 ${item.id}）`,
      `目标成员：${memberInlineText(targets) || '(无)'}（前置完成后自动唤醒，现在不唤醒）`
    ]
    if (resolved.length) {
      lines.push(`前置依赖（${resolved.length} 项）：`)
      for (const dep of resolved) {
        if (dep.entry) lines.push(`- ${dependencySummary(dep.entry)}`)
        else lines.push(`- ${dep.queued.requestId}（排队中「${truncate(dep.queued.title || '', 16)}」）`)
      }
    }
    if (delayMs > 0) lines.push(`最早发送：约 ${Math.max(1, Math.round(delayMs / 1000))} 秒后（延迟未到也不会发）`)
    lines.push(`调度：后台每 ${Math.round(DEP_TICK_MS / 1000)} 秒检查一次；前置状态变成 answered / 任务 done 后自动发出。`)
    lines.push('查看：session_board action=list 或面板「经验桥」→ 群聊，该请求显示「排队中」；排队超过 48 小时会判过期并通知你。')
    return lines.join('\n')
  }

  // 队列巡检定时器（unref，不阻止进程退出；插件卸载时清掉）
  const pendingTimer = setInterval(() => {
    try {
      runPendingQueue({ source: 'timer' })
    } catch (error) {
      logger.warn(`串行指令巡检失败：${error && error.message ? error.message : error}`)
    }
  }, DEP_TICK_MS)
  if (pendingTimer && typeof pendingTimer.unref === 'function') pendingTimer.unref()
  try {
    ctx.effect(() => () => clearInterval(pendingTimer), 'session-bridge: pending-ask timer')
  } catch {
    /* ignore */
  }
  // 插件重启后恢复队列：等一会儿再跑一次（此时 agents/board 都已就绪）。
  setTimeout(() => {
    try {
      runPendingQueue({ source: 'boot' })
    } catch {
      /* ignore */
    }
  }, 4000).unref?.()

  // ---------------------------------------------------------------- 申报材料（profile）
  const renderProfileSummary = (sessionId) => {
    const profile = ownProfileOf(sessionId)
    if (!profile || !profile.summary) return ''
    const parts = [profile.summary]
    if (profile.direction) parts.push(`方向：${profile.direction}`)
    if (profile.assets && profile.assets.length) parts.push(`资产：${profile.assets.join('、')}`)
    if (profile.needs) parts.push(`需要：${profile.needs}`)
    return parts.join('；')
  }

  const PROFILE_REQUEST_TEXT = (groupName) =>
    [
      `【经验桥 · 入群申报】你已被加入群组「${groupName}」。`,
      '请调用 session_profile action=update 提交一份简短申报（只保留主要介绍，之后有资产变化再更新）：',
      '- summary：一句话介绍你在做什么/方向（≤80 字）',
      '- direction：方向关键词（可选）',
      '- assets：已有资产/文件（逗号分隔，最多 8 个）',
      '- needs：需要群内其他成员提供什么（可选）',
      '总长 ≤200 字。不想参与可调用 session_profile action=skip。'
    ].join('\n')

  /** 入群时自动让新成员提交申报：在线的直接唤醒；离线成员下次运行会看到「未申报」小提示。 */
  const requestMemberProfiles = (group, sessionIds, exceptSessionId) => {
    let woken = 0
    const seen = new Set()
    for (const sessionId of sessionIds) {
      if (!sessionId || sessionId === exceptSessionId || seen.has(sessionId)) continue
      seen.add(sessionId)
      const profile = ownProfileOf(sessionId)
      if (profile && (profile.summary || profile.declined)) continue
      const outcome = wakeSession(sessionId, PROFILE_REQUEST_TEXT(group.name), { profileRequest: group.id })
      if (outcome.ok) woken += 1
    }
    return woken
  }

  // ---------------------------------------------------------------- 新会话接入询问
  const silentNewSessions = new Set()
  const askedNewSessionAt = new Map()
  const NEW_SESSION_ASK_TEXT = [
    '【经验桥 · 新会话接入确认】',
    '请先向用户确认一件事（不要直接开始做别的）：',
    '要不要把本会话注册到经验桥？',
    '- 注册：提交一句话简介（方向 / 主要资产 / 需要，≤200字），群内其他会话可按需查看，也可以被派任务；',
    '- 不注册：只做普通对话，不参与跨会话协作。',
    '问完后：用户同意 → session_profile action=update；拒绝 → session_profile action=skip。只问一次。'
  ].join('\n')

  try {
      ctx.on('agent/created', (payload) => {
        try {
          if (cfg.askOnCreate === false) return
          const agent = payload && payload.agent
          if (!agent || !agent.id || !agent.session) return
          if (silentNewSessions.has(agent.id)) return
          if (!isRootAgent(agent)) return
          // 老的无标题自动任务会话：一旦被打开（恢复为 live）就补一个可读标题。
          try {
            const titles = (ctx.get && ctx.get('sessionTitle')) || ctx.sessionTitle
            const session = agent.session
            const snapshot = titles && typeof titles.get === 'function' ? titles.get(session) : undefined
            const currentTitle = snapshot && typeof snapshot.title === 'string' ? snapshot.title : ''
            if (titles && typeof titles.rename === 'function' && session && /^mw[0-9a-z]+$/i.test(currentTitle)) {
              const taskEntry = worldEntriesOf().find(
                (entry) => Array.isArray(entry.mentions) && entry.mentions.includes(agent.id)
              )
              if (taskEntry) titles.rename(session, `世界任务：${String(taskEntry.title || '').slice(0, 30)}`)
            }
          } catch {
            /* 补标题失败不影响会话 */
          }
          const header = agent.session.header || {}
          // 只对「刚创建」的会话发问；恢复旧会话不打扰。
          if (Date.now() - (Number(header.createdAt) || 0) > 120000) return
          const profile = ownProfileOf(agent.id)
          if (profile && (profile.summary || profile.declined)) return
          if (askedNewSessionAt.has(agent.id)) return
          askedNewSessionAt.set(agent.id, Date.now())
          setTimeout(() => {
            try {
              wakeSession(agent.id, NEW_SESSION_ASK_TEXT, {})
            } catch {
              /* ignore */
            }
          }, 300)
        } catch {
          /* ignore one event */
        }
      })
      logger.info('已监听 agent/created：新会话会询问是否注册经验桥')
  } catch (error) {
    logger.warn(`注册新会话询问监听失败：${error && error.message ? error.message : error}`)
  }

  /** 确保一个会话是 live；history 会话需要恢复后才能收到 followup。 */
  const ensureSessionLive = async (sessionId) => {
    if (!sessionId) return null
    try {
      const existing = ctx.agents.get ? ctx.agents.get(sessionId) : undefined
      if (existing) return existing
      if (!ctx.agents || typeof ctx.agents.resume !== 'function') return null
      const selection = resolveDefaultSelection()
      const setup =
        installModelSelection && selection
          ? (agentCtx) => {
              installModelSelection(agentCtx, { current: selection })
            }
          : undefined
      const handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: {},
        ...(setup ? { setup } : {})
      })
      return handle && handle.agent ? handle.agent : handle || null
    } catch (error) {
      logger.warn(`恢复会话 ${shortSid(sessionId)} 失败：${error && error.message ? error.message : error}`)
      return null
    }
  }

  // ---------------------------------------------------------------- 世界聊天：按申报匹配成员
  const scoreProfileForText = (text, profile) => {
    const tokens = titleTokensOf(text)
    if (!tokens.size) return 0
    const haystack = `${profile.summary} ${profile.direction} ${(profile.assets || []).join(' ')} ${profile.needs}`.toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (token.length < 2) continue
      if (haystack.includes(token)) score += 1
    }
    return score
  }

  /** 按申报材料找最匹配的现有会话（返回按分数倒序，最多 3 个）。 */
  const matchProfileMembers = async (text) => {
    const profiles = listProfilesOf(boardDir)
    const sessions = await buildSessionIndex()
    const byId = new Map(sessions.map((session) => [session.id, session]))
    const scored = []
    for (const [sessionId, profile] of Object.entries(profiles)) {
      if (!profile || !profile.summary || profile.declined) continue
      const session = byId.get(sessionId)
      if (!session) continue
      const score = scoreProfileForText(text, profile)
      if (score > 0) {
        const repNow = reputationOf(sessionId)
        const identityNow = identityOf(sessionId, session.title)
        const skillBonus = (identityNow.skills || []).some((tag) => String(text).includes(tag)) ? 2 : 0
        const priority = score + Math.max(-3, Math.min(5, repNow.points / 10)) + skillBonus
        scored.push({ id: sessionId, title: session.title, score, priority, points: repNow.points, skills: identityNow.skills })
      }
    }
    scored.sort((a, b) => (b.priority || b.score) - (a.priority || a.score) || b.score - a.score)
    return scored.slice(0, 3)
  }

  /** 取默认模型选择：优先 agentDefaultModel 服务，其次复用任一现有会话的请求头。 */
  const resolveDefaultSelection = () => {
    try {
      const service = (ctx.get && ctx.get('agentDefaultModel')) || ctx.agentDefaultModel
      if (service && typeof service.currentSelection === 'function') {
        const selection = service.currentSelection()
        if (selection && selection.provider && selection.model) return selection
      }
    } catch {
      /* ignore */
    }
    try {
      const roots = ctx.agents && typeof ctx.agents.roots === 'function' ? ctx.agents.roots() : []
      for (const candidate of roots) {
        const header =
          candidate && candidate.session && typeof candidate.session.requestHeader === 'function'
            ? candidate.session.requestHeader()
            : null
        const config = header && header.config
        if (config && config.provider && config.model) {
          return {
            provider: config.provider,
            model: config.model,
            ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort })
          }
        }
      }
    } catch {
      /* ignore */
    }
    return null
  }

  /** 没有匹配成员时：尝试创建一个新会话并让它接手（失败则返回可读错误，由用户手动新建）。 */
  const MEMBER_CODENAMES = ['青岚', '白汀', '远山', '流光', '拾光', '临界', '云舟', '星野', '墨羽', '初雪', '长风', '澄川', '观澜', '听雨', '折光', '栖迟']
  const prettyMemberName = (cwd, index, text) => {
    const base = path.basename(String(cwd || '')).replace(/-mw[0-9a-z]+$/i, '').trim()
    const project = base && !/^world-workspaces?$/i.test(base) && !/^default-workspace$/i.test(base)
      ? base.slice(0, 14)
      : '星桥'
    let hash = 0
    const seed = String(cwd || '') + '|' + String(text || '') + '|' + index
    for (let cursor = 0; cursor < seed.length; cursor += 1) hash = (hash * 31 + seed.charCodeAt(cursor)) >>> 0
    const codename = MEMBER_CODENAMES[(hash + index * 5) % MEMBER_CODENAMES.length]
    return { title: project + ' · ' + codename, codename, project }
  }

  const createSessionForTask = async (cwdOverride, titleHint) => {
    const cwd = cwdOverride || defaultWorkspaceForRule()
    if (!cwd) return { ok: false, error: '没有可用的工作目录' }
    if (!ctx.agents || typeof ctx.agents.create !== 'function') {
      return { ok: false, error: '当前宿主不提供 agents.create（无法自动建会话）' }
    }
    const sessionId = `session-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
    // 世界任务自动创建的会话直接干活，不弹「是否注册」询问（否则会多一轮且打断任务）。
    silentNewSessions.add(sessionId)
    const selection = resolveDefaultSelection()
    const setup =
      installModelSelection && selection
        ? (agentCtx) => {
            installModelSelection(agentCtx, { current: selection })
          }
        : undefined
    try {
      // 宿主 agents.create(options) 收的是 CreateAgentOptions（不是位置参数 id）。
      const agent = await ctx.agents.create({
        sessionId,
        meta: { cwd },
        agentOptions: {},
        ...(setup ? { setup } : {})
      })
      if (!agent) return { ok: false, error: '创建会话未返回 agent' }
      // 让新会话真正出现在侧栏/工作区里：挂到对应 workspace，并给一个可读标题。
      let attached = false
      try {
        const registry = (ctx.get && ctx.get('workspaceRegistry')) || ctx.workspaceRegistry
        if (registry && typeof registry.resolveByPath === 'function') {
          let workspace = await registry.resolveByPath(cwd)
          if (!workspace && typeof registry.create === 'function') {
            workspace = await registry.create(cwd, titleHint || '世界任务')
          }
          if (workspace && typeof workspace.attachSession === 'function') {
            await workspace.attachSession(sessionId)
            attached = true
          }
        }
      } catch (error) {
        logger.warn(`新会话挂载工作区失败：${error && error.message ? error.message : error}`)
      }
      let title = ''
      try {
        const titles = (ctx.get && ctx.get('sessionTitle')) || ctx.sessionTitle
        // ctx.agents.create() 返回 AgentHandle（{agent,...}），标题需要真正的 Session。
        const createdAgent = agent && agent.agent ? agent.agent : agent
        const createdSession = createdAgent && createdAgent.session
        if (titles && typeof titles.rename === 'function' && createdSession && typeof createdSession.id === 'string') {
          const renamed = titles.rename(createdSession, String(titleHint || '世界任务').slice(0, 40))
          title = (renamed && renamed.title) || ''
        }
      } catch (error) {
        logger.warn(`新会话设置标题失败：${error && error.message ? error.message : error}`)
      }
      return { ok: true, sessionId, cwd, title, attached, selection: Boolean(selection) }
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) }
    }
  }

  // ---------------------------------------------------------------- 世界任务路由器（免费模型判路由/新工作区）
  const ROUTER_SYSTEM_PROMPT = [
    '你是 DSH 经验桥的世界任务路由器。用户在世界聊天发布任务，你需要决定：',
    '1) 交给某个已有会话（它已申报方向/资产，能直接接着做），还是新建一个会话；',
    '2) 是否要为此新建一个工作区（新项目/新方向且和现有工作区无关时才建）。',
    '只输出一行 JSON，不要解释，不要 markdown 代码块：',
    '{"route":"existing","sessionId":"...","reason":"..."} 或 {"route":"new","newWorkspace":true,"workspaceName":"...","reason":"..."}',
    '用户明确说「全新/新开/从零」时 route 必须是 new。',
    '判断以申报内容为准，不要臆造；信息不足时宁可交给已有会话。'
  ].join('\n')

  const extractJsonObject = (text) => {
    const raw = String(text || '').trim()
    if (!raw) return null
    const tryParse = (candidate) => {
      try {
        const value = JSON.parse(candidate)
        return value && typeof value === 'object' ? value : null
      } catch {
        return null
      }
    }
    const direct = tryParse(raw)
    if (direct) return direct
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced) {
      const fromFence = tryParse(fenced[1].trim())
      if (fromFence) return fromFence
    }
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    return tryParse(raw.slice(start, end + 1))
  }

  const callRouterLLM = async (prompt) => {
    const llm = (ctx.get && ctx.get('llm')) || ctx.llm
    if (!llm || typeof llm.stream !== 'function') {
      logger.warn('任务路由器：宿主未提供 llm 服务')
      return null
    }
    const routerCfg = cfg.router && typeof cfg.router === 'object' ? cfg.router : {}
    const selection =
      routerCfg.provider && routerCfg.model
        ? { provider: routerCfg.provider, model: routerCfg.model }
        : resolveDefaultSelection()
    if (!selection || !selection.provider || !selection.model) {
      logger.warn('任务路由器：无法确定路由模型（provider/model 为空）')
      return null
    }
    logger.info(`任务路由器：使用模型 ${selection.provider}/${selection.model}`)
    let sessionId
    try {
      const roots = ctx.agents && typeof ctx.agents.roots === 'function' ? ctx.agents.roots() : []
      sessionId = roots.length && roots[0] && typeof roots[0].id === 'string' ? roots[0].id : undefined
    } catch {
      sessionId = undefined
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const chunks = []
        const stream = llm.stream({
          provider: selection.provider,
          model: selection.model,
          ...(sessionId ? { sessionId } : {}),
          system: ROUTER_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          temperature: 0,
          maxTokens: 800
        })
        const seenTypes = []
        let deltaText = ''
        let blockText = ''
        for await (const chunk of stream) {
          if (chunk && typeof chunk.type === 'string' && seenTypes.length < 12) seenTypes.push(chunk.type)
          if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') deltaText += chunk.text
          if (chunk && chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
            blockText += chunk.block.text
          }
        }
        const out = (deltaText || blockText).trim()
        if (out) return out
        logger.warn(`任务路由器：第 ${attempt + 1} 次模型无文本输出（chunks=${seenTypes.join(',')}）`)
      } catch (error) {
        logger.warn(`任务路由器模型调用失败（第 ${attempt + 1} 次）：${error && error.message ? error.message : error}`)
      }
    }
    return null
  }

  const decideWorldRoute = async (text, forceNew) => {
    const sessions = await buildSessionIndex()
    const profiles = listProfilesOf(boardDir)
    const titleById = new Map(sessions.map((session) => [session.id, session.title]))
    const candidates = []
    for (const [sessionId, profile] of Object.entries(profiles)) {
      if (!profile || !profile.summary || profile.declined) continue
      if (!titleById.has(sessionId)) continue
      const repNow = reputationOf(sessionId)
      candidates.push({
        sessionId,
        title: titleById.get(sessionId),
        summary: profile.summary,
        direction: profile.direction,
        assets: profile.assets,
        points: repNow.points,
        skills: identityOf(sessionId, titleById.get(sessionId)).skills
      })
    }
    const fallback = async (reason) => {
      if (forceNew) return { route: 'new', newWorkspace: false, reason, engine: 'fallback', candidates: [] }
      const matches = await matchProfileMembers(text)
      const strong = matches.filter((item) => item.score >= 2)
      if (strong.length) {
        return {
          route: 'existing',
          sessionId: strong[0].id,
          reason: `关键词匹配申报（score=${strong[0].score}）`,
          engine: 'fallback',
          candidates: strong.slice(0, 3).map((item) => ({ id: item.id, title: item.title, score: item.score }))
        }
      }
      return { route: 'new', newWorkspace: false, reason, engine: 'fallback', candidates: [] }
    }
    if (!candidates.length) return fallback('还没有会话申报，无法路由')
    const prompt = [
      '用户任务：',
      text,
      '',
      `用户明确要求全新的会话：${forceNew ? '是' : '否'}`,
      '',
      '已有会话（申报材料）：',
      ...candidates.slice(0, 12).map((item, index) => {
        return `${index + 1}. id=${item.sessionId} 标题=${item.title} 信誉分=${item.points} 擅长=${(item.skills || []).join('/') || '-'} 简介=${item.summary} 方向=${item.direction || '-'} 资产=${(item.assets || []).join('、') || '-'}`
      })
    ].join('\n')
    const raw = await callRouterLLM(prompt)
    if (!raw) return fallback('路由器不可用/超时，退回关键词匹配')
    const decision = extractJsonObject(raw)
    if (!decision || (decision.route !== 'existing' && decision.route !== 'new')) {
      return fallback('路由器输出无法解析，退回关键词匹配')
    }
    if (decision.route === 'existing') {
      const match = candidates.find((item) => item.sessionId === decision.sessionId)
      if (!match) return fallback('路由器选的会话不在候选名单里，退回关键词匹配')
      return {
        route: 'existing',
        sessionId: match.sessionId,
        title: match.title,
        reason: asStringOf(decision.reason) || '模型路由',
        engine: 'llm',
        candidates: []
      }
    }
    return {
      route: 'new',
      newWorkspace: decision.newWorkspace === true,
      workspaceName: asStringOf(decision.workspaceName),
      reason: asStringOf(decision.reason) || '模型判断需要全新会话',
      engine: 'llm',
      candidates: []
    }
  }

  // 小工具：路由器输出字段安全转字符串（本文件作用域内已有 truncate/shortSid 等）。
  const asStringOf = (value) => (typeof value === 'string' ? value.trim() : '')

  const FORCE_NEW_RE = /(全新|新开|新建一个|新建个|从零|重新开|单独开|单独建|另起|另开|换个新|新会话|新对话|new\s+(one|session|conversation)|brand\s+new)/i

  const createWorkspaceForTask = async (text, nameHint) => {
    const registry = (ctx.get && ctx.get('workspaceRegistry')) || ctx.workspaceRegistry
    if (!registry || typeof registry.create !== 'function') {
      return { ok: false, error: '宿主不提供 workspaceRegistry（无法自动建工作区）' }
    }
    const base = path.dirname(defaultWorkspaceForRule() || process.cwd())
    const hint = asStringOf(nameHint) || truncate(text.replace(/\s+/g, ' '), 24) || 'new-world-task'
    const slug = hint.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').slice(0, 24) || 'world-task'
    const dir = path.join(base, 'world-workspaces', `${slug}-${Date.now().toString(36)}`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      const workspace = await registry.create(dir, hint.slice(0, 40))
      const cwd = workspace && typeof workspace.path === 'string' && workspace.path ? workspace.path : dir
      return { ok: true, cwd, path: dir, workspaceId: workspace && workspace.id, name: hint.slice(0, 40) }
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) }
    }
  }

  const ensureWorkspaceForFolder = async (folderPath, nameHint) => {
    const registry = (ctx.get && ctx.get('workspaceRegistry')) || ctx.workspaceRegistry
    if (!registry || typeof registry.create !== 'function') {
      return { ok: false, error: '宿主不提供 workspaceRegistry' }
    }
    const target = path.resolve(String(folderPath || ''))
    try {
      if (!fs.statSync(target).isDirectory()) return { ok: false, error: '目标不是文件夹' }
    } catch {
      return { ok: false, error: '文件夹不存在：' + target }
    }
    try {
      let workspace = null
      if (typeof registry.resolveByPath === 'function') {
        try {
          workspace = await registry.resolveByPath(target)
        } catch {
          workspace = null
        }
      }
      let created = false
      if (!workspace) {
        workspace = await registry.create(target, String(nameHint || path.basename(target)).slice(0, 40))
        created = true
      }
      return { ok: true, cwd: target, path: target, workspaceId: workspace && workspace.id, name: (workspace && workspace.title) || path.basename(target), created }
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) }
    }
  }

  const resolveFolderTask = (text) => {
    const source = String(text || '')
    const roots = [
      path.join(os.homedir(), 'Desktop'),
      path.join(os.homedir(), 'Documents'),
      path.join(os.homedir(), 'Downloads'),
      os.homedir()
    ]
    const folders = []
    for (const root of roots) {
      let entries = []
      try {
        entries = fs.readdirSync(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const full = path.join(root, entry.name)
        try {
          const stat = fs.statSync(full)
          folders.push({ path: full, name: entry.name, root, mtime: stat.mtimeMs || 0 })
        } catch {
          /* ignore */
        }
      }
    }
    // 1) 绝对路径
    const absoluteMatches = source.match(/[A-Za-z]:[\\/][^，。；、\n"'“”]+/g) || []
    for (const raw of absoluteMatches) {
      const candidate = raw.trim().replace(/[。；，、]+$/, '')
      try {
        if (fs.statSync(candidate).isDirectory()) {
          return { path: candidate, name: path.basename(candidate) }
        }
      } catch {
        /* ignore */
      }
    }
    // 2) 引号/“叫 xxx”里的文件夹名
    const names = []
    for (const pattern of [
      /(?:文件夹|目录|路径)[^「“"']{0,8}[「“"']([^」”"']{2,40})[」”"']/g,
      /(?:叫|名为|名字是)\s*[「“"']?([^\s，。；、」”"']{2,30})/g
    ]) {
      for (const match of source.matchAll(pattern)) names.push(match[1])
    }
    for (const name of names) {
      const hit = folders.find((folder) => folder.name === name) || folders.find((folder) => folder.name.includes(name))
      if (hit) return { path: hit.path, name: hit.name }
    }
    // 3) 正文里直接出现文件夹名
    for (const folder of folders) {
      if (folder.name.length >= 2 && source.includes(folder.name)) return { path: folder.path, name: folder.name }
    }
    // 4) 明确说桌面文件夹但没写名字：桌面只有一个文件夹就选它；多个时选最近修改的
    if (/桌面/.test(source) && /文件夹|目录/.test(source)) {
      const desktopFolders = folders
        .filter((folder) => folder.root === path.join(os.homedir(), 'Desktop'))
        .sort((a, b) => b.mtime - a.mtime)
      if (desktopFolders.length) return { path: desktopFolders[0].path, name: desktopFolders[0].name }
    }
    return null
  }

  const worldEntriesOf = () =>
    store
      .readActive()
      .filter((entry) => entry.channel === 'world' && entry.hiddenFromChat !== true)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0))

  const formatEntry = (entry, index) => {
    const now = Date.now()
    const kind = KIND_CN[entry.kind] || '经验'
    const groupNames = groupNameMap()
    const scope = entry.groupId ? `群组:${groupNames.get(entry.groupId) || '?'}` : entry.scope === 'global' ? '全局' : '工作区'
    const claimed = entry.claimedBy ? `【已被会话 ${shortSid(entry.claimedBy)} 认领】` : ''
    const requestStatus =
      entry.kind === 'request'
        ? entry.status === 'answered'
          ? `【请求·已由会话 ${shortSid(entry.answeredBy)} 回复】`
          : '【请求·待响应】'
        : ''
    return [
      `${index + 1}. [${kind}/${scope}] ${entry.title}  (id=${entry.id.slice(0, 14)}…，${humanAge(entry.ts, now)}${claimed}${requestStatus})`,
      `   ${entry.text}`,
      entry.files && entry.files.length ? `   文件：${entry.files.join('、')}` : '',
      `   作者：会话 ${shortSid(entry.author)}${entry.workspace ? ` · 工作区 ${path.basename(entry.workspace)}` : ''}${entry.tags && entry.tags.length ? ` · 标签 ${entry.tags.join('、')}` : ''}`
    ].filter(Boolean).join('\n')
  }

  register({
    name: 'session_share',
    description:
      '把一条「通用注意事项 / 经验教训 / 任务交接」发布到跨会话经验板，同一工作区（scope=global 时所有工作区）的其他 DSH 会话会在下一轮自动看到。' +
      '当用户在对话里说出适用于整个项目的通用规则（「以后都…」「统一…」「所有…都要…」「注意…」「不要…」），或要求把任务交给别的会话时，必须立即调用本工具，无需用户明确要求、也不要反问。' +
      '只发布通用、可独立理解的内容（标题≤20字，正文≤400字）；一次性细节、隐私、密钥不要发布。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '短标题，≤20 字，例如「论文图片统一 600dpi」' },
        text: { type: 'string', description: '可独立理解的规则/事实/交接内容，≤400 字' },
        kind: {
          type: 'string',
          enum: ['note', 'handoff', 'lesson', 'decision', 'chat'],
          description: 'note（通用经验，默认）/ handoff（任务交接）/ lesson（踩坑教训）/ decision（口径与约定）'
        },
        scope: {
          type: 'string',
          enum: ['workspace', 'global'],
          description: 'workspace（默认，仅同工作区会话可见）/ global（所有工作区可见）'
        },
        tags: { type: 'string', description: '可选，逗号分隔的标签，例如「论文,格式」' },
        ttlHours: { type: 'number', description: '可选，保留小时数；0 表示不过期。默认经验 168h、交接 72h' },
        group: { type: 'string', description: '可选，发布到某个群组（群名或群 id，群组在右侧栏「经验桥」面板里创建）；指定后只投递给群成员' },
        files: {
          type: 'string',
          description: '可选，交接/结论涉及的关键文件路径（逗号或换行分隔，最多 8 个）。群成员会在「群组共享上下文」里看到这些文件，避免重复产出'
        },
        replyTo: {
          type: 'string',
          description: '可选，回复某条「群内请求」的 id（session_ask 生成的请求 id 前缀即可）。回复后请求方会被通知，请求在看板上标记为已回复'
        }
      },
      required: ['title', 'text']
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute(args, exec) {
      const guard = requireRootAgent(exec)
      if (guard.error) return guard.error
      const agent = guard.agent
      const info = sessionInfoOf(agent)
      const kind = KIND_SET.has(args && args.kind) ? args.kind : 'note'
      const scope = args && args.scope === 'global' ? 'global' : cfg.scope === 'global' ? 'global' : 'workspace'
      const groupRef = args && typeof args.group === 'string' ? args.group.trim() : ''
      const group = groupRef ? groupStore.find(groupRef, info.cwd) : null
      const replyRef = args && typeof args.replyTo === 'string' ? args.replyTo.trim() : ''
      const replyRequest = replyRef ? findRequestEntry(replyRef) : null
      const replyGroup = replyRequest && replyRequest.groupId
        ? groupStore.read().find((item) => item.id === replyRequest.groupId)
        : null
      const effectiveGroup = group || replyGroup
      const replyText = String((args && args.text) || '') + ' ' + String((args && args.title) || '')
      const looksFinal = /(完成|已完成|已交付|交付完成|通过|验收通过|成功|done|finished|delivered|ready)/i.test(replyText) &&
        !/(未完成|无法|失败|受阻|进行中|待完成|还没)/i.test(replyText)
      const gateTask = replyRequest && replyRequest.taskId ? findBoardEntry(replyRequest.taskId) : null
      const gateIsWorldTask = Boolean(
        replyRequest &&
          (replyRequest.channel === 'world' || (gateTask && gateTask.worldTask === true))
      )
      const coordinatorGate = Boolean(replyRequest && replyRequest.kind === 'request' && gateIsWorldTask)
      if (coordinatorGate && !looksFinal) {
        const progress = addEntry(
          {
            title: '进度：' + String((args && args.title) || truncate(replyText, 20)).slice(0, 40),
            text: String((args && args.text) || ''),
            kind: 'chat',
            scope: effectiveGroup ? 'group' : 'workspace',
            groupId: effectiveGroup ? effectiveGroup.id : '',
            workspace: info.cwd,
            author: info.id,
            files: args && args.files,
            hiddenFromChat: effectiveGroup ? false : true,
            skipDedupe: true
          },
          'tool'
        )
        return progress.ok
          ? `已把进度记录到${effectiveGroup ? '任务群「' + effectiveGroup.name + '」' : '本地'}（未发布世界，请求保持未完成）。任务真正完成时再用 replyTo=${replyRequest.id} 发【任务完成】汇总。`
          : `进度记录失败：${progress.reason || ''}`
      }
      const worldReply = Boolean(replyRequest && replyRequest.channel === 'world' && !effectiveGroup)
      const result = addEntry(
        {
          title: args && args.title,
          text: args && args.text,
          kind,
          scope: effectiveGroup ? 'group' : worldReply ? 'global' : scope,
          groupId: effectiveGroup ? effectiveGroup.id : '',
          channel: worldReply ? 'world' : '',
          workspace: info.cwd,
          author: info.id,
          tags: args && args.tags,
          files: args && args.files,
          ttlHours: args && args.ttlHours
        },
        'tool'
      )
      if (!result.ok) {
        if (result.reason === 'duplicate') {
          return `经验板里已经有相同/高度相似的条目，未重复发布：${result.existing.title}（id=${result.existing.id.slice(0, 14)}…，${humanAge(result.existing.ts)}）。`
        }
        if (result.reason === 'group-not-found') {
          const groups = groupStore.read()
          return [
            `找不到群组「${groupRef}」。`,
            groups.length
              ? `当前已有群组：${groups.map((item) => `${item.name}（${item.sessionIds.length} 个会话）`).join('、')}`
              : '当前还没有群组：请让用户在右侧栏「经验桥」面板里新建群组并拉入会话。',
            '（不带 group 参数则会按工作区/全局发布。）'
          ].join('\n')
        }
        return `发布失败：${result.reason}`
      }
      const liveOthers = liveRootSessions().filter((item) => item.id && item.id !== info.id)
      const others = result.group
        ? liveOthers.filter((item) => result.group.sessionIds.includes(item.id)).length
        : liveOthers.length
      const scopeText = result.group
        ? `群组「${result.group.name}」（${result.group.sessionIds.length} 个会话，只有群成员会看到）`
        : result.entry.scope === 'global'
          ? '全局（所有工作区会话可见）'
          : `工作区 ${path.basename(info.cwd || '') || '(未知)'}（仅同工作目录可见）`
      // 回复群内请求：把请求标记为 answered，并唤醒/通知请求方。
      let replyNote = ''
      const replyToRef = args && typeof args.replyTo === 'string' ? args.replyTo.trim() : ''
      if (replyToRef) {
        const request = replyRequest
        if (request && request.kind === 'request') {
          const firstAnswer = request.status !== 'answered' && !request.answeredBy
          appendEvents(boardDir, [
            { op: 'answer', id: request.id, by: info.id, replyId: result.entry.id, ts: Date.now() }
          ])
          // 前置刚被answered：立刻推进串行队列（不必等 15 秒巡检）。
          try {
            runPendingQueue({ source: 'answer' })
          } catch {
            /* 调度失败不影响回复本身 */
          }
          if (firstAnswer && request.taskRole === 'member') {
            scoreSession(info.id, 8, { success: true })
            try {
              const memberTask = findBoardEntry(request.taskId)
              if (memberTask && memberTask.coordinator) relationStore.bump(info.id, memberTask.coordinator, 1)
            } catch {
              /* ignore */
            }
            replyNote += ' 任务提交 +8 积分。'
          }
          if (firstAnswer && request.taskRole === 'coordinator') {
            scoreSession(info.id, 10, { success: true })
            replyNote += ' 组长汇总 +10 积分。'
            try {
              const finishedTask = findBoardEntry(request.taskId)
              if (finishedTask && Array.isArray(finishedTask.assignees)) {
                const activeNow = store.readActive()
                for (const assignee of finishedTask.assignees) {
                  const submitted = activeNow.some(
                    (entry) =>
                      entry.kind === 'request' &&
                      entry.taskId === finishedTask.id &&
                      entry.taskRole === 'member' &&
                      Array.isArray(entry.requestTo) &&
                      entry.requestTo.includes(assignee) &&
                      (entry.status === 'answered' || entry.answeredBy)
                  )
                  if (!submitted) {
                    scoreSession(assignee, -6, { failure: true })
                    replyNote += ' 未提交成员 -6 积分。'
                  } else {
                    relationStore.bump(info.id, assignee, 1)
                  }
                }
                if (finishedTask.worldTask === true) {
                  try {
                    const worldSummary = addEntry(
                      {
                        title: '世界任务完成：' + truncate(String(finishedTask.title || request.title || ''), 24),
                        text: String(result.entry.text || result.entry.title || ''),
                        kind: 'handoff',
                        scope: 'global',
                        channel: 'world',
                        workspace: info.cwd,
                        author: info.id,
                        files: result.entry.files || [],
                        skipDedupe: true
                      },
                      'tool'
                    )
                    if (worldSummary.ok) {
                      scoreSession(info.id, 5, { success: true })
                      replyNote += ' 已向世界发布完成汇总 +5 积分。'
                    }
                  } catch {
                    /* 世界汇总失败不影响任务完成 */
                  }
                }
                const retroGroup = request.groupId
                  ? groupStore.read().find((item) => item.id === request.groupId)
                  : null
                await startRetroForTask(retroGroup, finishedTask)
              }
            } catch {
              /* 计分失败不影响回复 */
            }
          }
          if (firstAnswer && request.taskRole !== 'member' && request.taskRole !== 'coordinator') {
            const worldTask = request.channel === 'world'
            const delta = worldTask ? 8 : 5
            scoreSession(info.id, delta, { success: true })
            try {
              if (request.author && request.author !== 'panel') relationStore.bump(info.id, request.author, 1)
            } catch {
              /* ignore */
            }
            replyNote += ` 任务回复 +${delta} 积分。`
          }
          if (request.author && request.author !== info.id) {
            const wakeText = [
              `【群内请求已收到回复 · 来自会话 ${shortSid(info.id)}】`,
              `请求：${request.title}`,
              `回复：${result.entry.title}：${truncate(String(result.entry.text || '').replace(/\s*\n\s*/g, ' / '), 300)}`,
              ...(result.entry.files && result.entry.files.length ? [`文件：${result.entry.files.join('、')}`] : []),
              '（这是一条会话间通知，如需继续追问可用 session_ask 再发请求。）'
            ].join('\n')
            const woke = wakeSession(request.author, wakeText, { requestId: request.id })
            replyNote = `已回复请求「${request.title}」（id=${request.id.slice(0, 14)}…）；${woke.ok ? '请求方会话已被唤醒。' : '请求方当前不在线，下次运行会看到这条回复。'}`
          } else {
            replyNote = `已回复请求「${request.title}」（id=${request.id.slice(0, 14)}…）。`
          }
          // 群任务角色：成员只交组长（并通知组长收集）；组长提交即视为任务完成。
          if (request.taskId) {
            const isCoordinator = request.taskRole === 'coordinator'
            appendEvents(boardDir, [
              {
                op: 'task',
                id: request.taskId,
                patch: { taskStatus: isCoordinator ? 'done' : 'collecting' },
                ts: Date.now()
              }
            ])
            if (isCoordinator) {
              replyNote += ' 群任务已标记为完成。'
              // 复核后「需要修改」：交给群管理自动指派给群员，用户不用手动派活。
              try {
                if (/修改|待修|要改|需改|整改|补充|fix|todo|action item/i.test(String(result.entry.text || ''))) {
                  const taskGroup = request.groupId
                    ? groupStore.read().find((item) => item.id === request.groupId)
                    : null
                  const managerId = taskGroup && taskGroup.managerSessionId
                  const hasOpenRequest =
                    request.taskId &&
                    store.readActive().some(
                      (entry) =>
                        entry.kind === 'request' &&
                        entry.taskId === request.taskId &&
                        entry.taskRole === 'member' &&
                        entry.status !== 'answered' &&
                        !entry.answeredBy
                    )
                  if (taskGroup && managerId && managerId !== info.id && !hasOpenRequest) {
                    const taskEntry = findBoardEntry(request.taskId)
                    const sessionsNow = await buildSessionIndex()
                    const byIdNow = new Map(sessionsNow.map((session) => [session.id, session]))
                    const titleOfNow = (sessionId) =>
                      byIdNow.get(sessionId) ? byIdNow.get(sessionId).title : shortSid(sessionId)
                    const summaryText = truncate(String(result.entry.text || '').replace(/\s*\n\s*/g, ' / '), 600)
                    const managerRequest = addEntry(
                      {
                        title: `群管理跟进：${truncate((taskEntry && taskEntry.title) || request.taskId || '群任务', 16)}`,
                        text: summaryText,
                        kind: 'request',
                        groupId: taskGroup.id,
                        author: info.id,
                        requestTo: [managerId],
                        mentions: [managerId],
                        hiddenFromChat: true,
                        skipDedupe: true
                      },
                      'tool'
                    )
                    const managerMessage = [
                      '【任务分配 · 群管理派活】',
                      '需要你做的：把下面结论里仍需修改/未指派的事拆开，分给合适成员（session_ask mode=task）；不需要你亲自改稿。',
                      '',
                      `任务：${(taskEntry && taskEntry.title) || ''}`,
                      `组长结论：${summaryText}`,
                      '',
                      '分完后让成员 replyTo 汇报；本轮收尾时可用 group_rule action=replace 重建群规矩（≤5 条，去重）。'
                    ].join('\n')
                    await ensureSessionLive(managerId)
                    const woke = wakeSession(managerId, managerMessage, {
                      requestId: managerRequest.ok ? managerRequest.entry.id : undefined
                    })
                    managerNotifyAt.set(taskGroup.id, Date.now())
                    replyNote += woke.ok
                      ? ` 已通知群管理 ${titleOfNow(managerId)} 跟进修改。`
                      : ` 已通知群管理 ${titleOfNow(managerId)}（不在线，下次运行处理）。`
                  }
                }
              } catch {
                /* 群管理通知失败不影响任务完成 */
              }
            } else {
              const task = findBoardEntry(request.taskId)
              const coordinatorId = task && task.coordinator
              if (coordinatorId && coordinatorId === request.author) {
                replyNote += ' 组长已收到成员提交通知。'
              } else if (coordinatorId && coordinatorId !== info.id) {
                const notice = [
                  `【群任务 · 成员已提交内容 · 来自会话 ${shortSid(info.id)}】`,
                  `任务：${task && task.title ? task.title : ''}`,
                  `提交：${result.entry.title}：${truncate(String(result.entry.text || '').replace(/\s*\n\s*/g, ' / '), 300)}`,
                  ...(result.entry.files && result.entry.files.length ? [`文件：${result.entry.files.join('、')}`] : []),
                  '请继续收集/汇总；最后用 session_share（replyTo=你的组长请求）向用户提交唯一总结。'
                ].join('\n')
                const wokeCoordinator = wakeSession(coordinatorId, notice, { requestId: request.id })
                replyNote += wokeCoordinator.ok
                  ? ' 已唤醒组长收集。'
                  : ' 已通知组长（组长不在线，下次运行会看到）。'
              }
            }
          }
        } else {
          replyNote = `replyTo「${replyToRef}」没有匹配到群内请求，已按普通条目发布。`
        }
      }
      // 群内的交接/汇总结论里若有「需要修改/落实/下一步」等，也交给群管理跟进（10 分钟限频）。
      if (result.group) {
        try {
          const groupForManager = groupStore.read().find((item) => item.id === result.group.id)
          const managerId = groupForManager && groupForManager.managerSessionId
          const lastAt = groupForManager ? managerNotifyAt.get(groupForManager.id) || 0 : 0
          const summaryForGate = String(result.entry.text || '')
          const explicitlyUnassigned = /(未指派|没人(做|负责)|待派|需要安排|请安排|待处理|卡住|阻塞|需你定|由谁负责)/i.test(
            summaryForGate
          )
          const alreadyDone = /(已完成|已修(复|改)|已落实|已通过|已定稿|无需修改|不用管|全部落实)/i.test(summaryForGate)
          const needsWork = explicitlyUnassigned && !alreadyDone
          if (groupForManager && managerId && managerId !== info.id && needsWork && Date.now() - lastAt > 10 * 60 * 1000) {
            const sessionsNow = await buildSessionIndex()
            const byIdNow = new Map(sessionsNow.map((session) => [session.id, session]))
            const managerTitle = byIdNow.get(managerId) ? byIdNow.get(managerId).title : shortSid(managerId)
            const summaryText = truncate(String(result.entry.text || '').replace(/\\s*\\n\\s*/g, ' / '), 600)
            const managerRequest = addEntry(
              {
                title: `群管理跟进：${truncate(result.entry.title, 16)}`,
                text: summaryText,
                kind: 'request',
                groupId: groupForManager.id,
                author: info.id,
                requestTo: [managerId],
                mentions: [managerId],
                hiddenFromChat: true,
                skipDedupe: true
              },
              'tool'
            )
            const managerMessage = [
              '【任务分配 · 群管理跟进】',
              '需要你做的：把下面仍未修改/未指派的事项分给合适成员（session_ask mode=task）；其余忽略。',
              '',
              `交接：${result.entry.title}：${summaryText}`,
              `（来自会话 ${shortSid(info.id)} · 群组「${groupForManager.name}」）`
            ].join('\n')
            await ensureSessionLive(managerId)
            const woke = wakeSession(managerId, managerMessage, {
              requestId: managerRequest.ok ? managerRequest.entry.id : undefined
            })
            managerNotifyAt.set(groupForManager.id, Date.now())
            replyNote += woke.ok
              ? ` 已通知群管理 ${managerTitle} 跟进。`
              : ` 已通知群管理 ${managerTitle}（不在线，下次运行处理）。`
          }
        } catch {
          /* 群管理通知失败不影响发布 */
        }
      }
      return [
        `已发布到跨会话经验板：[${KIND_CN[result.entry.kind]}/${scopeText}] ${result.entry.title}`,
        `id=${result.entry.id}，作用域=${scopeText}`,
        ...(replyNote ? [replyNote] : []),
        others > 0
          ? `当前有 ${others} 个${result.group ? '其他群成员' : '其他会话'}处于活动状态，它们会在下一步/下一轮自动看到这条内容。`
          : `当前没有其他活动${result.group ? '群成员' : '会话'}；${result.group ? '群成员' : '其他会话'}下次运行时（含重启后恢复）会自动看到这条内容。`
      ].join('\n')
    }
  })

  register({
    name: 'session_ask',
    description:
      '向同一群组的其他会话要文件/进度：把请求写进看板，并唤醒在线的目标会话去处理（会启动对方的一轮对话，消耗 token）。' +
      '默认 mode=probe（只问正文，不叮嘱回复格式）；只有真正派活时传 mode=task（才会附 replyTo/files 交付说明）。' +
      '当用户说「问一下…会话/…群：第 3 章初稿在哪/进度如何/把文件发我/数据发我」时调用。' +
      'to 支持 contactId（8 位，如 4f51e99f）、短 id（6 位）、无 session- 前缀的完整 id、handle、标题；不确定用 session_directory 查通讯录。' +
      '收到请求的一方用 session_share（kind=handoff、group=群名、replyTo=请求 id、files=文件）回复，请求方会被自动通知。' +
      '任务有先后依赖（串行）时传 dependsOn=前置请求/任务 id（可多个）与可选 delayMs：前置未完成不会唤醒目标，先排队，完成后自动发出。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '群组名或群 id（session_board action=groups 可列出）' },
        text: { type: 'string', description: '要什么：文件路径 / 进度 / 数据 / 结论，写清楚（≤400 字）' },
        to: {
          type: 'string',
          description:
            '要发给哪个群成员：contactId / 短 id / handle / 标题 / 完整 id 均可；多个用逗号或顿号分隔（最多 3 个）。必填（默认禁止群发唤醒）'
        },
        mode: {
          type: 'string',
          enum: ['probe', 'task'],
          description: 'probe（默认，探测/要进度：只问正文，不叮嘱回复格式）/ task（真正派活：才附 replyTo/files 交付说明）'
        },
        title: { type: 'string', description: '可选，短标题（默认从 text 生成）' },
        dependsOn: {
          type: 'string',
          description:
            '可选，串行依赖：前置 request id / 群任务 id（多个用逗号分隔，最多 5 个）。前置还没 answered（任务没 done）时本条不发出、不唤醒，先排队；前置完成后自动发出。'
        },
        delayMs: {
          type: 'integer',
          minimum: 0,
          maximum: 604800000,
          description: '可选，最小延迟（毫秒）：到点且依赖满足才发出；只延时也会排队。不传 dependsOn / delayMs 时仍立即发送。'
        },
        step: {
          type: 'integer',
          minimum: 1,
          description: '可选，群任务的第几个步骤（配合 group.post 的 steps）；该请求 answered 后步骤自动标记完成。'
        }
      },
      required: ['group', 'text']
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute(args, exec) {
      const guard = requireRootAgent(exec)
      if (guard.error) return guard.error
      const info = sessionInfoOf(guard.agent)
      const groupRef = String((args && args.group) || '').trim()
      if (!groupRef) return '请指定群组（session_board action=groups 可列出当前群组）。'
      const group = groupStore.find(groupRef, info.cwd)
      if (!group) {
        const groups = groupStore.read()
        return [
          `找不到群组「${groupRef}」。`,
          groups.length
            ? `当前群组：${groups.map((item) => item.name).join('、')}`
            : '当前还没有群组：先在右侧栏「经验桥」→ 群组里新建。'
        ].join('\n')
      }
      const text = String((args && args.text) || '').trim().slice(0, 1200)
      if (!text) return '请求内容不能为空。'

      const sessions = await buildSessionIndex()
      const byId = new Map(sessions.map((session) => [session.id, session]))
      let targets = group.sessionIds
        .filter((sessionId) => sessionId !== info.id)
        .map((sessionId) => byId.get(sessionId))
        .filter(Boolean)
      const allMembers = targets.slice()
      const toRef = String((args && args.to) || '').trim()
      if (!toRef) {
        // 资源保护：默认禁止 session 群发唤醒，必须先指定对象，且对象需用户授权。
        return [
          '为节省资源，默认禁止群发唤醒。请用 to= 指定群成员（contactId / 短 id / handle / 标题，最多 3 个）。',
          `群「${group.name}」可用成员（contactId 可直接复制）：`,
          memberDirectoryText(targets),
          '授权方式：右侧栏「经验桥」→ 群组 → 设置 → 成员行的「可唤醒」下拉里勾选你允许它唤醒的成员。'
        ].join('\n')
      }
      // to= 支持一次给多个引用（逗号/顿号分隔），也支持单个 contactId/短 id/handle/标题。
      const segments = splitSessionRefs(toRef)
      let matched = []
      if (segments.length > 1) {
        const batch = resolveSessionRefs(segments, targets)
        if (!batch.ok) {
          return [
            `无法解析 to=「${toRef}」：`,
            ...batch.errors,
            `群「${group.name}」可用成员（contactId 可直接复制）：`,
            memberDirectoryText(targets)
          ].join('\n')
        }
        matched = batch.resolved
      } else {
        const outcome = resolveSessionRef(toRef, targets)
        if (!outcome.ok) {
          return [
            outcome.ambiguous ? `to=「${toRef}」指向不唯一，请改用 contactId 或完整 id：` : `群「${group.name}」里没有匹配「${toRef}」的成员。`,
            ...(outcome.ambiguous ? [outcome.error] : []),
            `群「${group.name}」可用成员（contactId 可直接复制）：`,
            memberDirectoryText(targets)
          ].join('\n')
        }
        matched = [outcome.session]
      }
      targets = matched.slice(0, 3)
      const grants = readPermissionsOf(boardDir).grants[info.id] || []
      const unauthorized = targets.filter((session) => !grants.includes(session.id))
      if (unauthorized.length) {
        const grantedTitles = grants
          .map((sessionId) => {
            const session = byId.get(sessionId)
            return session ? `${session.contactId || contactIdOf(sessionId)}（${session.title}）` : shortSid(sessionId)
          })
          .join('、')
        return [
          `没有唤醒权限：${unauthorized.map((session) => `${session.contactId || contactIdOf(session.id)}（${session.title}）`).join('、')}。`,
          `本会话已被授权唤醒：${grantedTitles || '（无）'}。`,
          '请让用户在右侧栏「经验桥」→ 群组 → 设置 → 成员行的「可唤醒」里授权后再请求。'
        ].join('\n')
      }
      if (!targets.length) {
        return `群「${group.name}」里没有其他主会话成员可请求（先在右侧栏「经验桥」→ 群组里把会话拉进来）。`
      }

      // 模式判定：显式 mode 最优先；否则按正文意图推断——
      // 真正的「请做/核验/修改/重跑/门禁…」是任务，只有问进度/状态才是探测。
      const explicitMode = args && (args.mode === 'task' || args.mode === 'probe') ? args.mode : ''
      const probeSignal = /(进度|进展|到哪(一|个)?步|状态如何|是否(已|完成|可以)|有没有|在吗|结论是什么|哪一版|确认一下)/i.test(text)
      const workSignal =
        /(请|需要|麻烦|帮忙)[^。\\n]{0,16}(做|执行|核验|检查|复查|复核|重跑|重编|重绘|重新|修改|改|补|落实|审阅|审核|交付|提交|生成|排查|修复|跑|门禁|验收|复验|验证|确认|处理|整理|画|打包)/i.test(
          text
        ) ||
        /(最后一轮|最后一版|最后一遍|门禁|验收|复核|修改项|落实|交付|重跑|重编|补图|改稿|修图)/i.test(text)
      let taskCandidate = null
      try {
        const tasks = store
          .readActive()
          .filter(
            (entry) =>
              entry.kind === 'task' &&
              entry.coordinator === info.id &&
              (entry.taskStatus || 'assigned') !== 'done' &&
              Array.isArray(entry.assignees) &&
              targets.every((target) => entry.assignees.includes(target.id))
          )
        tasks.sort((a, b) => (b.ts || 0) - (a.ts || 0))
        taskCandidate = tasks.length ? tasks[0] : null
      } catch {
        taskCandidate = null
      }
      const callerIsManager = Boolean(group.managerSessionId && group.managerSessionId === info.id)
      let askMode =
        explicitMode ||
        (taskCandidate && !probeSignal ? 'task' : '') ||
        (workSignal && !probeSignal ? 'task' : '') ||
        (callerIsManager && workSignal ? 'task' : '') ||
        'probe'
      const assignmentTask = askMode === 'task' ? taskCandidate : null

      // 群任务里若成员已经提交过，不再唤醒/重复请求：改成「插话」提醒，等它下次处理时顺手看到即可。
      const nudgedMembers = []
      if (assignmentTask) {
        try {
          const activeEntries = store.readActive()
          const remaining = []
          for (const target of targets) {
            // 只挡「同一任务还有未回复的分工请求」；已经提交过的成员可以接下一轮修改任务，
            // 否则「提交过 = 永远不准唤醒」会卡死后续轮次。
            const duplicateOpen = activeEntries.find(
              (entry) =>
                entry.kind === 'request' &&
                entry.taskId === assignmentTask.id &&
                entry.taskRole === 'member' &&
                Array.isArray(entry.requestTo) &&
                entry.requestTo.includes(target.id) &&
                entry.status !== 'answered' &&
                !entry.answeredBy
            )
            if (duplicateOpen) {
              nudgedMembers.push(target)
              addEntry(
                {
                  title: `催收：${truncate(text, 18)}`,
                  text,
                  kind: 'note',
                  groupId: group.id,
                  workspace: info.cwd,
                  author: info.id,
                  requestTo: [target.id],
                  mentions: [target.id],
                  hiddenFromChat: true,
                  nudge: true,
                  skipDedupe: true
                },
                'tool'
              )
            } else {
              remaining.push(target)
            }
          }
          targets = remaining
        } catch {
          /* 查询失败时按正常请求处理 */
        }
        if (!targets.length) {
          return `成员 ${nudgedMembers.map((session) => session.title).join('、')} 当前已有未回复的分工请求，本次不重复唤醒；已改用「插话」提醒（对方处理时会看到）。`
        }
      }
      const title = String((args && args.title) || '').trim().slice(0, 60) || `群内请求：${truncate(text, 18)}`
      // 串行编排：带 dependsOn / delayMs 时先排队（不唤醒），由后台调度器在前置完成后发出。
      const depRefs = parseDependencyRefs(args && args.dependsOn)
      const delayMs = Math.max(0, Math.min(DEP_MAX_DELAY_MS, toNumber(args && args.delayMs, 0)))
      const stepNo = Math.max(0, Math.min(10, toNumber(args && args.step, 0)))
      if (depRefs.length || delayMs > 0) {
        return enqueueAskRequest({
          group,
          info,
          text,
          title,
          targets,
          askMode,
          assignmentTask,
          dependsOn: depRefs,
          delayMs,
          step: assignmentTask ? stepNo : 0
        })
      }
      const result = addEntry(
        {
          title,
          text,
          kind: 'request',
          groupId: group.id,
          workspace: info.cwd,
          author: info.id,
          requestTo: targets.map((session) => session.id),
          mentions: targets.map((session) => session.id),
          ...(assignmentTask ? { taskId: assignmentTask.id, taskRole: 'member' } : {}),
          ...(assignmentTask && stepNo > 0 ? { taskStep: stepNo } : {})
        },
        'tool'
      )
      if (!result.ok) return `发布请求失败：${result.reason}`
      const requestId = result.entry.id
      if (assignmentTask) {
        try {
          appendEvents(boardDir, [
            { op: 'task', id: assignmentTask.id, patch: { taskStatus: 'delegating' }, ts: Date.now() }
          ])
        } catch {
          /* 状态更新失败不影响派活 */
        }
        if (stepNo > 0) {
          try {
            const taskNow = findBoardEntry(assignmentTask.id)
            if (taskNow && Array.isArray(taskNow.steps) && taskNow.steps[stepNo - 1]) {
              const steps = taskNow.steps.map((step, index) =>
                index === stepNo - 1 ? { ...step, status: 'dispatched', requestId, dispatchedAt: Date.now() } : step
              )
              appendEvents(boardDir, [{ op: 'task', id: assignmentTask.id, patch: { steps }, ts: Date.now() }])
            }
          } catch {
            /* 步骤回写失败不影响派活 */
          }
        }
      }
      // 探测（提问/要进度）和任务分配用不同模板（与排队后发送共用一套）。
      const requestMessage = buildAskMessage({
        askMode,
        text,
        group,
        requestId,
        assignmentTask,
        authorId: info.id
      })

      const woken = []
      const sleepy = []
      for (const target of targets) {
        const outcome = wakeSession(target.id, requestMessage, { requestId })
        if (outcome.ok) woken.push(target)
        else sleepy.push(target)
      }
      return [
        askMode === 'task'
          ? `已向群组「${group.name}」发出任务分配：${title}（id=${requestId}）`
          : `已向群组「${group.name}」发出探测：${title}（id=${requestId}）`,
        `目标成员：${memberInlineText(targets) || '(无)'}`,
        woken.length
          ? `已唤醒 ${woken.length} 个在线会话（${memberInlineText(woken)}），它们会立即处理；`
          : '',
        sleepy.length
          ? `${sleepy.length} 个成员当前不在线（${memberInlineText(sleepy)}），下次运行会看到这条请求；`
          : '',
        askMode === 'task'
          ? `群成员通讯录（后续派活直接用 to=contactId）：\n${memberDirectoryText(allMembers)}`
          : '',
        askMode === 'task'
          ? `等待交付：对方用 session_share（kind=handoff、group=${group.name}、replyTo=${requestId}、files=…）回复后，本会话会被唤醒/看到通知。`
          : '探测只需对方针对正文回答；不需要交付文件或写长分析。'
      ]
        .filter(Boolean)
        .join('\n')
    }
  })

  register({
    name: 'session_nudge',
    description:
      '给群成员发「插话式」催收/提醒：不唤醒、不额外开一轮，只在对方下一次处理时注入一次；对方已完成时不会打扰。' +
      '催进度/提醒用这个，不要用 session_ask（那会让对方多回复一轮）。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '群组名或群 id' },
        to: {
          type: 'string',
          description: '要提醒的群成员：contactId / 短 id / handle / 标题 / 完整 id 均可（必填）'
        },
        text: { type: 'string', description: '提醒内容（催什么/还差什么）' },
        title: { type: 'string', description: '可选，短标题（默认从 text 生成）' }
      },
      required: ['group', 'to', 'text']
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute(args, exec) {
      const guard = requireRootAgent(exec)
      if (guard.error) return guard.error
      const info = sessionInfoOf(guard.agent)
      const groupRef = String((args && args.group) || '').trim()
      const text = String((args && args.text) || '').trim().slice(0, 800)
      const toRef = String((args && args.to) || '').trim()
      if (!groupRef || !text || !toRef) return 'session_nudge 需要 group / to / text。'
      const group = groupStore.find(groupRef, info.cwd)
      if (!group) return `找不到群组「${groupRef}」。`
      const sessions = await buildSessionIndex()
      const byId = new Map(sessions.map((session) => [session.id, session]))
      const candidates = group.sessionIds
        .filter((sessionId) => sessionId !== info.id)
        .map((sessionId) => byId.get(sessionId))
        .filter(Boolean)
      const resolution = resolveSessionRef(toRef, candidates)
      if (!resolution.ok) {
        return [
          resolution.ambiguous
            ? `to=「${toRef}」指向不唯一，请改用 contactId 或完整 id：`
            : `群「${group.name}」里没有匹配「${toRef}」的成员。`,
          ...(resolution.ambiguous ? [resolution.error] : []),
          `群「${group.name}」可用成员（contactId 可直接复制）：`,
          memberDirectoryText(candidates)
        ].join('\n')
      }
      const target = resolution.session
      const grants = readPermissionsOf(boardDir).grants[info.id] || []
      if (!grants.includes(target.id)) {
        return `没有插话权限：用户还没有授权本会话唤醒/提醒「${target.title}」。请让用户在群组设置里授权。`
      }
      const title = String((args && args.title) || '').trim().slice(0, 60) || `催收：${truncate(text, 18)}`
      const result = addEntry(
        {
          title,
          text,
          kind: 'note',
          groupId: group.id,
          workspace: info.cwd,
          author: info.id,
          requestTo: [target.id],
          mentions: [target.id],
          hiddenFromChat: true,
          nudge: true,
          skipDedupe: true
        },
        'tool'
      )
      if (!result.ok) return `插话失败：${result.reason}`
      logger.info(`插话提醒 ${shortSid(target.id)}：${title}`)
      return [
        `已插话给「${target.title}」：不会唤醒、不会额外开一轮。`,
        '对方下一次处理时会在上下文里看到这条提醒；如果它已经完成，会直接忽略，不会再回复一次。'
      ].join('\n')
    }
  })

  register({
    name: 'group_rule',
    description:
      '群管理专用：把本轮讨论/复核结论**整理成可复用的群规矩**（共识、口径、做法），写入群共享规矩层。' +
      '不要把聊天记录原文、每条交接/催收直接当规矩；只保留稳定、可复用的结论（最多 3 条，每条一句话+必要说明）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['replace', 'set', 'list', 'remove'],
          description: 'replace 用一份去重后的完整规矩列表替换本群全部规矩；set 单条新增/更新；list 查看；remove 删除'
        },
        rules: {
          type: 'array',
          description: 'action=replace：整理后的完整规矩列表（最多 8 条，每条 title+text）',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, text: { type: 'string' } },
            required: ['title', 'text']
          }
        },
        group: { type: 'string', description: '群组名或群 id' },
        title: { type: 'string', description: 'action=set：规矩短标题（≤20字）' },
        text: { type: 'string', description: 'action=set：可复用的规矩本身（写结论/口径，不要贴聊天记录）' },
        id: { type: 'string', description: 'action=remove：规矩 id（前缀）' }
      },
      required: ['action']
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const guard = requireRootAgent(exec)
      if (guard.error) return guard.error
      const info = sessionInfoOf(guard.agent)
      const action = String((args && args.action) || 'list')
      const groupRef = String((args && args.group) || '').trim()
      if (!groupRef) return 'group_rule 需要 group（群名或群 id）。'
      const group = groupStore.find(groupRef, info.cwd)
      if (!group) return `找不到群组「${groupRef}」。`
      const curated = store.readActive().filter((entry) => entry.curated === true && entry.groupId === group.id)
      if (action === 'list') {
        if (!curated.length) return `群「${group.name}」还没有整理过的规矩。`
        return [
          `群「${group.name}」的规矩（${curated.length} 条）：`,
          ...curated.map((entry, index) => `${index + 1}. ${entry.title}：${truncate(String(entry.text || '').replace(/\s*\n\s*/g, ' / '), 200)}`)
        ].join('\n')
      }
      if (group.managerSessionId !== info.id) {
        return '只有本群的群管理（AI）可以整理群规矩；请让用户在群设置里把本会话设为群管理。'
      }
      if (action === 'remove') {
        const wanted = String((args && args.id) || '').trim()
        if (!wanted) return 'remove 需要 id。'
        const target = curated.find((entry) => entry.id === wanted || entry.id.startsWith(wanted))
        if (!target) return `没有找到规矩「${wanted}」。`
        appendEvents(boardDir, [{ op: 'remove', id: target.id, by: info.id, ts: Date.now() }])
        deliveryStore.dropRule(target.id)
        return `已删除群规矩「${target.title}」。`
      }
      const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim()
      const dedupeCurated = (list) => {
        const seen = new Set()
        const out = []
        for (const item of list) {
          const key = cleanText(item.title).toLowerCase()
          if (!key || seen.has(key)) continue
          seen.add(key)
          out.push({ title: cleanText(item.title).slice(0, 60), text: String(item.text || '').trim().slice(0, 800) })
          if (out.length >= 8) break
        }
        return out
      }
      if (action === 'replace') {
        const incoming = Array.isArray(args && args.rules) ? args.rules : []
        const nextRules = dedupeCurated(
          incoming
            .filter((item) => item && typeof item.title === 'string' && typeof item.text === 'string')
            .map((item) => ({ title: item.title, text: item.text }))
        )
        if (!nextRules.length) return 'replace 需要至少 1 条规则（rules 数组）。'
        for (const entry of curated) {
          appendEvents(boardDir, [{ op: 'remove', id: entry.id, by: info.id, ts: Date.now() }])
          deliveryStore.dropRule(entry.id)
        }
        for (const rule of nextRules) {
          addEntry(
            { title: rule.title, text: rule.text, kind: 'decision', groupId: group.id, author: info.id, curated: true, skipDedupe: true },
            'tool'
          )
        }
        logger.info(`群「${group.name}」规矩整体替换：${curated.length} → ${nextRules.length} 条（by ${shortSid(info.id)}）`)
        return `已用 ${nextRules.length} 条干净规矩替换群「${group.name}」原有 ${curated.length} 条规矩（已去重）。`
      }
      const title = String((args && args.title) || '').trim().slice(0, 60)
      const text = String((args && args.text) || '').trim().slice(0, 800)
      if (!title || !text) return 'set 需要 title 和 text。'
      const normalizedTitle = cleanText(title).toLowerCase()
      const sameTitle = curated.find((entry) => cleanText(entry.title).toLowerCase() === normalizedTitle)
      if (sameTitle) {
        appendEvents(boardDir, [{ op: 'remove', id: sameTitle.id, by: info.id, ts: Date.now() }])
        deliveryStore.dropRule(sameTitle.id)
      }
      const result = addEntry(
        { title, text, kind: 'decision', groupId: group.id, author: info.id, curated: true, skipDedupe: true },
        'tool'
      )
      if (!result.ok) return `写入群规矩失败：${result.reason}`
      logger.info(`群「${group.name}」新增/更新规矩：${title}（by ${shortSid(info.id)}）`)
      return `已写入群「${group.name}」的规矩：${title}（同名旧条已替换，避免重复）`
    }
  })

  register({
    name: 'session_like',
    description: '给群内表现好的成员点赞 +2 积分（每人每天最多 3 次）；会在群里发一条交流消息。用于鼓励，不是任务。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '群名或群 id' },
        to: { type: 'string', description: '要点赞的群成员（会话标题或短 id）', },
        reason: { type: 'string', description: '可选，点赞理由（一句话）' }
      },
      required: ['group', 'to']
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const guard = requireRootAgent(exec)
      if (guard.error) return guard.error
      const info = sessionInfoOf(guard.agent)
      const groupRef = String((args && args.group) || '').trim()
      const toRef = String((args && args.to) || '').trim()
      if (!groupRef || !toRef) return 'session_like 需要 group 和 to。'
      const group = groupStore.find(groupRef, info.cwd)
      if (!group) return '找不到群组「' + groupRef + '」。'
      const sessions = await buildSessionIndex()
      const byId = new Map(sessions.map((session) => [session.id, session]))
      const target = group.sessionIds
        .map((sessionId) => byId.get(sessionId))
        .filter(Boolean)
        .find((session) => session.id === toRef || session.id.startsWith(toRef) || String(session.title || '').includes(toRef))
      if (!target) return '群「' + group.name + '」里没有匹配「' + toRef + '」的成员。'
      if (target.id === info.id) return '不能给自己点赞。'
      const like = reputationStore.recordLike(info.id, target.id, 3)
      if (!like.ok) return '今天已经给「' + target.title + '」点过 3 次赞了，明天再夸。'
      scoreSession(target.id, 2, {})
      relationStore.bump(info.id, target.id, 2)
      addEntry(
        {
          title: '点赞：' + target.title,
          text: String((args && args.reason) || '表现不错，继续加油').slice(0, 120),
          kind: 'chat',
          groupId: group.id,
          author: info.id,
          mentions: [target.id],
          tags: '@点赞',
          skipDedupe: true
        },
        'tool'
      )
      return '已给「' + target.title + '」点赞 +2 积分（今日第 ' + reputationStore.likeCount(info.id, target.id) + ' 次）。'
    }
  })

  register({
    name: 'session_discuss',
    description: '在群里发起一次轻量讨论：唤醒成员各用一两句话表达观点/建议（不是任务，不需交付文件）。当用户说「大家聊聊/讨论一下/头脑风暴」时使用。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '群名或群 id' },
        topic: { type: 'string', description: '讨论主题（一句话）' },
        to: { type: 'string', description: '可选，只叫某些成员（会话标题或短 id；逗号分隔）；默认全体群员' }
      },
      required: ['group', 'topic']
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const guard = requireRootAgent(exec)
      if (guard.error) return guard.error
      const info = sessionInfoOf(guard.agent)
      const groupRef = String((args && args.group) || '').trim()
      const topic = String((args && args.topic) || '').trim().slice(0, 400)
      if (!groupRef || !topic) return 'session_discuss 需要 group 和 topic。'
      const group = groupStore.find(groupRef, info.cwd)
      if (!group) return '找不到群组「' + groupRef + '」。'
      const want = String((args && args.to) || '').trim()
      const sessions = await buildSessionIndex()
      const byId = new Map(sessions.map((session) => [session.id, session]))
      let targets = group.sessionIds
        .filter((id) => id !== info.id && id !== maintainerStore.get())
        .map((id) => byId.get(id))
        .filter(Boolean)
      if (want) {
        const refs = want.split(/[,，\s]+/).filter(Boolean)
        targets = targets.filter((session) => refs.some((ref) => session.id.startsWith(ref) || String(session.title || '').includes(ref)))
      }
      if (!targets.length) return '没有可讨论的群成员。'
      addEntry(
        { title: '讨论：' + topic.slice(0, 20), text: topic, kind: 'chat', groupId: group.id, author: info.id, mentions: targets.map((t) => t.id), tags: '@讨论', skipDedupe: true },
        'tool'
      )
      const contextLines = discussionContextOf(group.id, 4)
      const message = [
        '【讨论 · 请用一两句话参与（不是任务）】',
        topic,
        '',
        ...(contextLines.length ? ['最近群里聊到：', ...contextLines, ''] : []),
        '请接着聊：可以赞同/反驳上面某一句，并 @ 一位成员继续；2 句话以内，直接 session_share（kind=chat、group=' + group.name + '）发出来。不用交付文件，不想说可以不说。'
      ].join('\n')
      let woken = 0
      for (const target of targets) {
        await ensureSessionLive(target.id)
        if (wakeSession(target.id, message, {}).ok) woken += 1
      }
      return ['已发起讨论：' + topic, '唤醒 ' + woken + ' 个在线成员参与；没有实质想法可以不说，不强制回复。'].join('\n')
    }
  })

  register({
    name: 'session_identity',
    description: '设置你自己的群名片：handle（ID，1-16 字）与 avatar（emoji 头像，从给定列表选）。加入群/世界观后建议设置一次，让别人记住你。action=get 查看当前身份。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: 'set 设置；get 查看' },
        handle: { type: 'string', description: '你的 ID/昵称（1-16 字）' },
        avatar: { type: 'string', description: '头像：emoji（从 ' + AVATAR_PALETTE.join(' ') + ' 中选）或自定义图片 data URI（data:image/png;base64,…）' },
        role: { type: 'string', description: '可选，自定义角色（如：审稿人/画图/协调/气氛组，≤24 字）' },
        skills: {
          type: 'array',
          description: '可选，擅长任务类型（审稿/画图/仿真/写作/排版/数据/代码/协调/答辩/检索），路由时会优先匹配',
          items: { type: 'string', enum: ROLE_SKILL_TAGS }
        },
        style: { type: 'string', enum: PERSONA_STYLES, description: '可选，说话风格/人格类型' },
        persona: { type: 'string', description: '可选，一句话人格描述（≤120 字，如：较真、喜欢用数据说话、偶尔吐槽）' }
      },
      required: ['action']
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const guard = requireRootAgent(exec)
      if (guard.error) return guard.error
      const info = sessionInfoOf(guard.agent)
      const action = String((args && args.action) || 'get')
      if (action === 'get') {
        const identity = identityOf(info.id, identityTitleOf(info.id))
        return '你的名片：' + identity.avatar + ' ' + identity.handle + (identity.role ? ' · ' + identity.role : '') + (identity.skills && identity.skills.length ? ' · 擅长：' + identity.skills.join('/') : '') + (identity.style ? ' · 风格：' + identity.style : '') + (identity.persona ? ' · ' + identity.persona : '')
      }
      const wantedHandle = sanitizeHandle(args && args.handle)
      const wantedAvatar = String((args && args.avatar) || '').trim()
      if (!wantedHandle) return 'handle 需要 1-16 个字（中文/字母/数字/_-）。'
      if (wantedAvatar && !isAvatar(wantedAvatar)) return 'avatar 必须是这些 emoji 之一：' + AVATAR_PALETTE.join(' ')
      const current = identityOf(info.id, identityTitleOf(info.id))
      const avatar = wantedAvatar || current.avatar
      const handle = uniqueHandle(wantedHandle, info.id)
      const role = typeof args.role === 'string' ? String(args.role).replace(/\s+/g, ' ').trim().slice(0, 24) : current.role || ''
      const wantedSkills = Array.isArray(args.skills)
        ? args.skills
        : typeof args.skills === 'string'
          ? String(args.skills).split(/[,，\s]+/)
          : current.skills || []
      const skills = [...new Set(wantedSkills)].filter((tag) => ROLE_SKILL_TAGS.includes(tag)).slice(0, 6)
      const style = typeof args.style === 'string' && PERSONA_STYLES.includes(args.style) ? args.style : current.style || ''
      const persona = typeof args.persona === 'string' ? String(args.persona).replace(/\s+/g, ' ').trim().slice(0, 120) : current.persona || ''
      identityStore.set(info.id, { handle, avatar, role, skills, style, persona, updatedAt: Date.now() })
      return (
        '名片已更新：' + avatar + ' ' + handle +
        (role ? ' · ' + role : '') +
        (skills.length ? ' · 擅长：' + skills.join('/') : '') +
        (style ? ' · 风格：' + style : '') +
        (persona ? ' · ' + persona : '')
      )
    }
  })

  register({
    name: 'group_member',
    description: '群管理专用：根据组内需要拉人入群或踢出成员（action=add/remove/list）。拉人后会给新成员发入群欢迎/申报提示；踢人只移出群，不删除会话。sessions 支持 contactId / 短 id / handle / 标题 / 完整 id。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove', 'list'], description: 'add 拉人；remove 踢人；list 查看成员' },
        group: { type: 'string', description: '群名或群 id' },
        sessions: {
          type: 'array',
          description: '要加入/移出的成员（contactId、短 id、会话 ID、handle 或标题，可给多个）',
          items: { type: 'string' }
        }
      },
      required: ['action', 'group']
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const guard = requireRootAgent(exec)
      if (guard.error) return guard.error
      const info = sessionInfoOf(guard.agent)
      const groupRef = String((args && args.group) || '').trim()
      const group = groupStore.find(groupRef, info.cwd)
      if (!group) return '找不到群组「' + groupRef + '」。'
      const isManager = group.managerSessionId === info.id || maintainerStore.get() === info.id
      if (!isManager) return '只有本群群管理或维护者可以拉人/踢人。'
      const sessions = await buildSessionIndex()
      const byId = new Map(sessions.map((session) => [session.id, session]))
      const members = group.sessionIds.map((sessionId) => byId.get(sessionId)).filter(Boolean)
      if (args.action === 'list') {
        return (
          '群「' + group.name + '」成员（' + members.length + '）：\n' +
          members
            .map((member) => '- ' + member.avatar + ' ' + (member.handle || member.title) + '（' + member.title + '）· contactId=' + (member.contactId || contactIdOf(member.id)) + ' · 完整 id=' + member.id)
            .join('\n')
        )
      }
      const refs = Array.isArray(args.sessions) ? args.sessions.filter((item) => typeof item === 'string' && item) : []
      if (!refs.length) return '请提供 sessions（contactId / 短 id / 会话 ID / handle / 标题）。'
      const batch = resolveSessionRefs(refs, sessions)
      if (!batch.ok) {
        return [
          '成员引用解析失败，本次未做任何改动：',
          ...batch.errors,
          '提示：先用 session_directory（可加 group=群名）查 contactId，或改用完整 id。'
        ].join('\n')
      }
      const resolved = batch.resolved
      let nextIds = group.sessionIds.slice()
      if (args.action === 'add') {
        for (const member of resolved) if (!nextIds.includes(member.id)) nextIds.push(member.id)
      } else {
        nextIds = nextIds.filter((sessionId) => !resolved.some((member) => member.id === sessionId))
      }
      const groups = groupStore.read()
      const target = groups.find((item) => item.id === group.id)
      if (!target) return '找不到群组。'
      target.sessionIds = nextIds
      target.updatedAt = Date.now()
      groupStore.write(groups)
      try {
        const permissions = readPermissionsOf(boardDir)
        const grants = new Set(permissions.grants[info.id] || [])
        for (const member of resolved) grants.add(member.id)
        permissions.grants[info.id] = [...grants]
        writePermissionsOf(boardDir, permissions)
      } catch {
        /* ignore */
      }
      const handles = resolved.map((member) => formatContactLine(member))
      addEntry(
        {
          title: (args.action === 'add' ? '新成员入群：' : '成员移出群：') + handles.join('、'),
          text: (args.action === 'add' ? '群管理拉入 ' : '群管理移出 ') + handles.join('、') + '。',
          kind: 'chat',
          groupId: group.id,
          author: info.id,
          mentions: resolved.map((member) => member.id),
          tags: '@系统',
          skipDedupe: true
        },
        'tool'
      )
      if (args.action === 'add') {
        for (const member of resolved) {
          await ensureSessionLive(member.id)
          wakeSession(
            member.id,
            [
              '【入群通知】',
              '你被群管理拉入群「' + group.name + '」。',
              '请先用 session_profile 提交一句话申报（方向/擅长/需要什么），然后按群里的任务/分工参与。'
            ].join('\n'),
            {}
          )
        }
      }
      return (args.action === 'add' ? '已拉入：' : '已移出：') + handles.join('、') + '；当前成员 ' + nextIds.length + ' 人。'
    }
  })

  register({
    name: 'session_directory',
    description:
      '跨会话通讯录：列出主会话的 contactId（稳定短 ID）、完整 id、handle、标题、工作区、在线状态、所属群组、是否可派世界任务。' +
      '支持 group（只看某个群组的成员）和 query（按 contactId / 完整 id / handle / 标题 / 工作区 模糊筛选）。' +
      '任何主会话可用。不确定派给谁、或不知道成员 id 时先查这里：contactId 可直接用于 session_ask/session_nudge 的 to、group_member 的 sessions、世界任务正文 @。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '可选：只看该群组的成员（群名或群 id）' },
        query: { type: 'string', description: '可选：按 contactId / 完整 id / handle / 标题 / 工作区 模糊筛选' }
      }
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const guard = requireRootAgent(exec)
      if (guard.error) return guard.error
      const info = sessionInfoOf(guard.agent)
      const groups = groupStore.read()
      const groupRef = String((args && args.group) || '').trim()
      let group = null
      if (groupRef) {
        group = groupStore.find(groupRef, info.cwd)
        if (!group) {
          return [
            `找不到群组「${groupRef}」。`,
            groups.length ? `当前群组：${groups.map((item) => item.name).join('、')}` : '当前还没有群组。'
          ].join('\n')
        }
      }
      const sessions = await buildSessionIndex()
      const groupNamesBySession = new Map()
      for (const item of groups) {
        for (const sessionId of item.sessionIds || []) {
          if (!groupNamesBySession.has(sessionId)) groupNamesBySession.set(sessionId, [])
          groupNamesBySession.get(sessionId).push(item.name)
        }
      }
      const query = String((args && args.query) || '').trim().toLowerCase()
      const allCount = sessions.length
      let rows = sessions
      if (group) rows = rows.filter((session) => group.sessionIds.includes(session.id))
      if (query) {
        rows = rows.filter((session) =>
          [session.contactId, session.id, session.handle, session.title, session.cwd]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(query))
        )
      }
      rows = rows.sort((a, b) => (b.live === true ? 1 : 0) - (a.live === true ? 1 : 0) || (b.createdAt || 0) - (a.createdAt || 0))
      const header = group
        ? `群「${group.name}」通讯录（${rows.length} 个主会话）`
        : `跨会话通讯录（${rows.length} 个主会话${allCount !== rows.length ? `，共 ${allCount} 个` : ''}）`
      if (!rows.length) {
        return [header, query ? `没有匹配「${query}」的会话。` : '没有可列出的主会话。'].join('\n')
      }
      const lines = [
        header,
        'contactId = 完整 id 去掉 session- 前缀后的前 8 位（稳定、可直接复制），可用于 session_ask/session_nudge 的 to、group_member 的 sessions、世界任务正文 @。',
        ''
      ]
      for (const session of rows) {
        const groupNames = groupNamesBySession.get(session.id) || []
        lines.push(
          `- contactId=${session.contactId || contactIdOf(session.id)} · handle=${session.handle || '（无）'} · title=${session.title || shortSid(session.id)}`
        )
        lines.push(
          `  fullId=${session.id} · live=${session.live ? 'yes' : 'no'} · status=${session.status || (session.live ? 'idle' : 'history')} · 群组=${groupNames.length ? groupNames.join('、') : '（无）'} · worldEligible=${session.worldEligible ? 'yes' : 'no'} · cwd=${session.cwd || '（无）'}`
        )
      }
      if (group && group.managerSessionId) {
        const manager = sessions.find((session) => session.id === group.managerSessionId)
        lines.push('', `群管理：${manager ? formatContactLine(manager) : shortSid(group.managerSessionId)}`)
      }
      lines.push('', '提示：直接复制 contactId 使用即可；若输入同时匹配多个会话，解析会报歧义并给出候选（此时改用完整 id）。')
      return lines.join('\n')
    }
  })

  register({
    name: 'group_skill',
    description: '群管理专用：把本轮心得/流程沉淀成 SKILL.md（写入星桥技能库，不需要工作区写权限）；也可 list 查看已有技能。需要项目内文件时再用 session_ask mode=task 找有权限成员。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'list'], description: 'save 保存技能；list 查看已有技能' },
        group: { type: 'string', description: '群名或群 id' },
        name: { type: 'string', description: '技能名（如：审改论文）' },
        description: { type: 'string', description: '一句话说明什么时候用' },
        content: { type: 'string', description: 'SKILL.md 正文（Markdown）' },
        writeProject: { type: 'boolean', description: '是否同时写一份到群工作区 .dsh/skills/（默认 true）' }
      },
      required: ['action']
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const guard = requireRootAgent(exec)
      if (guard.error) return guard.error
      const info = sessionInfoOf(guard.agent)
      const action = String((args && args.action) || 'list')
      const groupRef = String((args && args.group) || '').trim()
      const group = groupRef ? groupStore.find(groupRef, info.cwd) : null
      if (groupRef && !group) return '找不到群组「' + groupRef + '」。'
      if (action === 'list') {
        const skills = skillStore.list().filter((item) => !group || item.groupId === group.id)
        if (!skills.length) return '技能库里还没有技能。'
        return ['星桥技能库（' + skills.length + ' 个）：', ...skills.map((item) => '- ' + item.name + '：' + (item.description || '') + '（' + item.file + '）')].join('\n')
      }
      if (!group) return 'save 需要 group。'
      if (group.managerSessionId !== info.id) return '只有本群的群管理可以沉淀技能；可以让群管理来做这件事。'
      const name = String((args && args.name) || '').trim().slice(0, 40)
      const description = String((args && args.description) || '').trim().slice(0, 200)
      const content = String((args && args.content) || '').trim()
      if (!name || !content) return 'save 需要 name 和 content（SKILL.md 正文）。'
      await ensureSessionLive(info.id)
      let projectFile = ''
      const slug = String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'skill'
      if (args.writeProject !== false && group.workspace) {
        try {
          const folder = path.join(group.workspace, '.dsh', 'skills', slug)
          ensureDir(folder)
          projectFile = path.join(folder, 'SKILL.md')
          fs.writeFileSync(projectFile, content + '\n', 'utf8')
        } catch {
          projectFile = ''
        }
      }
      const saved = skillStore.save({
        name,
        description,
        content,
        groupId: group.id,
        groupName: group.name,
        savedBy: info.id,
        projectFile
      })
      addEntry(
        {
          title: 'SKILL 已沉淀：' + name,
          text: description + (saved.projectFile ? '\n\n已写入工作区：' + saved.projectFile : '') + '\n技能库：' + saved.file,
          kind: 'note',
          groupId: group.id,
          author: info.id,
          files: [saved.projectFile || saved.file],
          tags: '@skill',
          skipDedupe: true
        },
        'tool'
      )
      logger.info('群「' + group.name + '」沉淀 SKILL：' + name + ' → ' + saved.file)
      return ['已沉淀 SKILL：' + name, '技能库：' + saved.file, projectFile ? '工作区：' + projectFile : '工作区写入失败，已保留技能库副本。'].join('\n')
    }
  })

  register({
    name: 'session_profile',
    description:
      '维护本会话的「申报材料」（简介/方向/主要资产/需要什么），供群内其他会话按需了解、避免重复造轮子。' +
      '新会话参与协作时应先申报；资产/方向有主要变化时更新（只保留主要介绍，总长≤200字，节省 token）。' +
      'action=update 更新；show 查看本会话申报；directory 列出群组/全部已申报会话（只在需要了解别人时调用）；skip 不再提示申报。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['update', 'show', 'directory', 'skip'],
          description: 'update（更新本会话申报）/ show（查看自己的）/ directory（按需查看别人的）/ skip（不再提示申报）'
        },
        summary: { type: 'string', description: 'action=update：一句话介绍你在做什么/方向（≤80 字，必填）' },
        direction: { type: 'string', description: '方向关键词（可选，≤160 字）' },
        assets: { type: 'string', description: '已有资产/文件（逗号分隔，最多 8 个）' },
        needs: { type: 'string', description: '需要群内其他成员提供什么（可选，≤160 字）' },
        group: { type: 'string', description: 'action=directory：只看某个群组的成员申报（可选）' }
      },
      required: ['action']
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute(args, exec) {
      const guard = requireRootAgent(exec)
      if (guard.error) return guard.error
      const info = sessionInfoOf(guard.agent)
      const action = String((args && args.action) || 'update')
      if (action === 'skip') {
        writeProfileOf(boardDir, info.id, { sessionId: info.id, summary: '', direction: '', assets: [], needs: '', declined: true, updatedAt: Date.now() })
        return '已跳过经验桥申报提示（之后不再提示；需要时仍可 session_profile action=update 加入）。'
      }
      if (action === 'show') {
        const profile = ownProfileOf(info.id)
        if (!profile || !profile.summary) return '本会话还没有申报材料。可用 session_profile action=update 提交。'
        return [`本会话申报：`, `- 简介：${profile.summary}`, profile.direction ? `- 方向：${profile.direction}` : '', profile.assets.length ? `- 资产：${profile.assets.join('、')}` : '', profile.needs ? `- 需要：${profile.needs}` : '', `（更新于 ${stableStamp(profile.updatedAt)}）`].filter(Boolean).join('\n')
      }
      if (action === 'directory') {
        const groupRef = String((args && args.group) || '').trim()
        let sessionIds = []
        if (groupRef) {
          const group = groupStore.find(groupRef, info.cwd)
          if (!group) return `找不到群组「${groupRef}」。`
          sessionIds = group.sessionIds
        } else {
          sessionIds = Object.keys(listProfilesOf(boardDir))
        }
        const profiles = listProfilesOf(boardDir)
        const rows = sessionIds
          .map((sessionId) => ({ sessionId, profile: profiles[sessionId] }))
          .filter((row) => row.profile && row.profile.summary)
        if (!rows.length) return '还没有已申报的会话。'
        return [`共 ${rows.length} 份申报：`, ...rows.map((row, index) => {
          const profile = row.profile
          const parts = [profile.summary]
          if (profile.direction) parts.push(`方向：${profile.direction}`)
          if (profile.assets && profile.assets.length) parts.push(`资产：${profile.assets.join('、')}`)
          if (profile.needs) parts.push(`需要：${profile.needs}`)
          return `${index + 1}. [${shortSid(row.sessionId)}] ${parts.join('；')}（${stableStamp(profile.updatedAt)}）`
        })].join('\n')
      }
      // update
      const summary = String((args && args.summary) || '').trim().slice(0, 240)
      if (!summary) return '申报需要 summary（一句话介绍你在做什么/方向）。'
      const profile = writeProfileOf(boardDir, info.id, {
        sessionId: info.id,
        summary,
        direction: String((args && args.direction) || '').trim().slice(0, 160),
        assets: normalizeFilesOf(args && args.assets),
        needs: String((args && args.needs) || '').trim().slice(0, 160),
        declined: false,
        updatedAt: Date.now()
      })
      logger.info(`会话 ${shortSid(info.id)} 提交/更新申报：${summary.slice(0, 40)}（资产 ${profile.assets.length} 个）`)
      return [
        `已更新本会话申报材料（总 ${summary.length + profile.assets.join('').length} 字）：`,
        `- 简介：${profile.summary}`,
        profile.direction ? `- 方向：${profile.direction}` : '',
        profile.assets.length ? `- 资产：${profile.assets.join('、')}` : '',
        profile.needs ? `- 需要：${profile.needs}` : '',
        '群内其他会话可在需要时用 session_profile action=directory 查看；想看群里谁负责什么也可以问。'
      ].filter(Boolean).join('\n')
    }
  })

  register({
    name: 'session_board',
    description:
      '查看与管理跨会话经验板（session-bridge 插件）。' +
      'action=list 列出当前工作区/群组可见的经验/交接（默认不含自己发布的）；' +
      'action=groups 列出所有群组及其成员；' +
      'action=remove 删除一条（id 可用前缀）；action=claim 认领一条任务交接；' +
      'action=ack 标记本会话已接受某条规矩（id 可用前缀）；' +
      'action=status 查看插件加载状态、看板路径、活动会话与看板面板。' +
      '发布新经验请用 session_share（可用 group 参数指定群组）；向群内其他会话要文件/进度请用 session_ask。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'groups', 'remove', 'claim', 'unclaim', 'ack', 'status'],
          description: 'list（默认）/ groups / remove / claim / unclaim / ack / status'
        },
        id: { type: 'string', description: '条目 id（remove/claim/unclaim/ack 时用，支持前缀匹配）' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'list 时最多显示多少条，默认 12' },
        includeOwn: { type: 'boolean', description: 'list 时是否包含自己发布的条目，默认 false' },
        showAll: { type: 'boolean', description: 'list 时是否显示其它工作区的条目，默认 false' }
      }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute(args, exec) {
      const guard = requireAgent(exec)
      if (guard.error) return guard.error
      const info = sessionInfoOf(guard.agent)
      const action = args && typeof args.action === 'string' ? args.action : 'list'
      // 读操作（list/groups/status）对所有 agent 开放（子智能体/团队成员也要能看交接）；
      // 写操作（remove/claim/unclaim/ack）仅主会话。
      if (!['list', 'groups', 'status'].includes(action) && !isRootAgent(guard.agent)) {
        return '子会话只能只读查看经验板（action=list/groups/status）；删除、认领、标记接受等写操作请让所属主会话执行。'
      }

      const findEntry = (rawId) => {
        const wanted = String(rawId || '').trim()
        if (!wanted) return null
        const candidates = store.readActive()
        return (
          candidates.find((entry) => entry.id === wanted) ||
          candidates.find((entry) => entry.id.startsWith(wanted)) ||
          null
        )
      }

      if (action === 'groups') {
        const groups = groupStore.read()
        if (!groups.length) {
          return '当前还没有群组。在右侧栏「经验桥」面板里新建群组并拉入会话，之后 session_share 就可以用 group 参数只发给群成员。'
        }
        const sessionsNow = await buildSessionIndex()
        const sessionById = new Map(sessionsNow.map((session) => [session.id, session]))
        const ruleCount = new Map()
        for (const entry of store.readActive()) {
          if (entry.groupId) ruleCount.set(entry.groupId, (ruleCount.get(entry.groupId) || 0) + 1)
        }
        const lines = [`跨会话经验板 · ${groups.length} 个群组：`]
        groups.forEach((group, index) => {
          lines.push(
            `${index + 1}. ${group.name}（id=${group.id.slice(0, 12)}…，${group.sessionIds.length} 个会话，${ruleCount.get(group.id) || 0} 条群规矩）`
          )
          if (group.sessionIds.length) {
            lines.push(
              `   成员：${group.sessionIds
                .map((id) => {
                  const session = sessionById.get(id)
                  return session ? `${session.contactId || contactIdOf(id)}（${session.handle || session.title}）` : shortSid(id)
                })
                .join('、')}`
            )
          }
        })
        return lines.join('\n')
      }

      if (action === 'status') {
        const all = store.readActive()
        const mine = all.filter((entry) => entry.author === info.id)
        const groups = groupStore.read()
        const live = liveRootSessions()
        const sessionsNow = await buildSessionIndex()
        const sessionById = new Map(sessionsNow.map((session) => [session.id, session]))
        const moduleInfo = (() => {
          try {
            const clientModules = ctx.get ? ctx.get('clientModules') : undefined
            if (!clientModules || typeof clientModules.graph !== 'function') return { available: false }
            const graph = clientModules.graph()
            const entries = graph && Array.isArray(graph.entries) ? graph.entries : []
            const ids = entries.map((entry) => entry && entry.id).filter((id) => typeof id === 'string')
            return {
              available: true,
              count: ids.length,
              hasSelf: ids.includes('dsh-plugin-session-bridge'),
              ids: ids.slice(0, 60)
            }
          } catch (error) {
            return { available: false, error: error && error.message ? error.message : String(error) }
          }
        })()
        return [
          `session-bridge v${VERSION} · 插件已加载`,
          `看板文件：${path.join(boardDir, BOARD_FILE)}`,
          `看板条目：活动 ${all.length} 条（其中我发布的 ${mine.length} 条）· 群组 ${groups.length} 个`,
          `当前会话：contactId=${contactIdOf(info.id) || '?'} · ${info.id || '?'}${info.cwd ? ` · 工作区 ${info.cwd}` : ''}`,
          `通讯录：${sessionsNow.length} 个主会话（contactId 见下，可用 session_directory 查询/过滤；派活用 session_ask 的 to=contactId）`,
          `配置：scope=${cfg.scope} · maxShown=${cfg.maxShown} · ttl=${cfg.ttlHours}h · autoCapture=${cfg.autoCapture !== false}`,
          `注册：系统提示词说明=${registration.section ? '是' : '否'} · 运行时上下文=${registration.context ? '是' : '否'} · 看板 API=${registration.api ? '是' : '否'} · 面板 client.js=${fs.existsSync(path.resolve(HERE, '..', 'client.js')) || fs.existsSync(path.join(HERE, 'client.js')) ? '存在' : '缺失'}`,
          `客户端模块：${moduleInfo.available ? `已挂载（${moduleInfo.count} 个，本插件=${moduleInfo.hasSelf ? '已注册' : '未注册'}）` : '服务不可用'}${moduleInfo.available && !moduleInfo.hasSelf && moduleInfo.ids ? `\n  ids：${moduleInfo.ids.join(', ')}` : ''}`,
          `工具：${registeredTools.join(', ') || '(无)'}${failedTools.length ? ` · 失败=${failedTools.join(', ')}` : ''}`,
          `活动主会话（${live.length}）：`,
          ...(live.length
            ? live.map((item) => {
                const session = sessionById.get(item.id)
                const who = session ? `${session.contactId || contactIdOf(item.id)} · ${session.handle || session.title}` : `${contactIdOf(item.id) || shortSid(item.id)}`
                return `  - ${who} · ${item.status} · ${item.cwd ? path.basename(item.cwd) : '(无 cwd)'}`
              })
            : ['  (无)'])
        ].join('\n')
      }

      if (action === 'remove') {
        const entry = findEntry(args && args.id)
        if (!entry) return `没找到条目：${args && args.id}`
        appendEvents(boardDir, [{ op: 'remove', id: entry.id, by: info.id, ts: Date.now() }])
        deliveryStore.dropRule(entry.id)
        logger.info(`删除条目 ${entry.id}（by ${shortSid(info.id)}）`)
        return `已从经验板删除：${entry.title}（id=${entry.id.slice(0, 14)}…）`
      }

      if (action === 'ack') {
        const entry = findEntry(args && args.id)
        if (!entry) return `没找到条目：${args && args.id}`
        deliveryStore.recordAccept(entry.id, info.id)
        return `已标记本会话（${shortSid(info.id)}）接受：${entry.title}（右侧栏「经验桥」面板里会显示为已接受）。`
      }

      if (action === 'claim' || action === 'unclaim') {
        const entry = findEntry(args && args.id)
        if (!entry) return `没找到条目：${args && args.id}`
        if (entry.kind !== 'handoff') return `只有 handoff（任务交接）可以认领：${entry.title}`
        if (action === 'claim') {
          appendEvents(boardDir, [{ op: 'claim', id: entry.id, by: info.id, ts: Date.now() }])
          return `已认领交接任务：${entry.title}（其他会话会看到"已被会话 ${shortSid(info.id)} 认领"）。`
        }
        appendEvents(boardDir, [{ op: 'unclaim', id: entry.id, by: info.id, ts: Date.now() }])
        return `已释放认领：${entry.title}`
      }

      // list
      const limit = Math.max(1, Math.min(50, toNumber(args && args.limit, 12)))
      const entries = visibleEntries(info, {
        includeOwn: args && args.includeOwn === true,
        showAll: args && args.showAll === true
      }).slice(0, limit)
      const header = [
        `跨会话经验板 · ${entries.length} 条（工作区 ${info.cwd ? path.basename(info.cwd) : '?'}${args && args.showAll === true ? '，含其它工作区' : ''}${args && args.includeOwn === true ? '，含自己发布' : ''}）`
      ]
      if (!entries.length) {
        header.push('（暂时没有其他会话共享的条目。你可以在本会话发布：用户给出通用规范时调用 session_share。）')
        return header.join('\n')
      }
      return header.concat(entries.map((entry, index) => formatEntry(entry, index))).join('\n')
    }
  })

  // ---------------------------------------------------------------- 看板 HTTP API
  // 右侧栏面板（dsh-plugin/client.js）通过同源 fetch 取数/操作：
  //   GET  /api/session-bridge/state    → 规矩 / 群组 / 会话 / 送达接受
  //   POST /api/session-bridge/command  → 面板上的写操作
  // 只接受 loopback 调用；POST 还要求 JSON + 自定义动作头，避免外站 CSRF。
  const jsonOut = (res, status, value) => {
    let body
    try {
      body = JSON.stringify(value)
    } catch {
      body = '{"ok":false,"error":"serialize-failed"}'
    }
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    })
    res.end(body)
  }
  const isLoopbackAddress = (address) => {
    if (typeof address !== 'string') return false
    const value = address.toLowerCase()
    if (value === '::1') return true
    const ipv4 = value.startsWith('::ffff:') ? value.slice(7) : value
    const octets = ipv4.split('.')
    return octets.length === 4 && octets[0] === '127' && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  }
  const isLoopbackHostHeader = (req) => {
    const raw = typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : ''
    if (!raw) return false
    const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.replace(/:\d+$/, '')
    return host === 'localhost' || isLoopbackAddress(host)
  }
  const isLoopbackCaller = (req) => isLoopbackAddress(req.socket && req.socket.remoteAddress) && isLoopbackHostHeader(req)
  const readRequestBody = (req, limit = 64 * 1024) =>
    new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('body-too-large'))
          try {
            req.destroy()
          } catch {
            /* ignore */
          }
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  const newGroupId = () => `g-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
  const findRule = (rawId) => {
    const wanted = String(rawId || '').trim()
    if (!wanted) return null
    const candidates = store.readActive()
    return (
      candidates.find((entry) => entry.id === wanted) ||
      candidates.find((entry) => entry.id.startsWith(wanted)) ||
      null
    )
  }
  const mutateGroups = (mutate) => {
    const groups = groupStore.read().map((group) => ({ ...group, sessionIds: [...group.sessionIds] }))
    const result = mutate(groups)
    groupStore.write(groups)
    return result
  }

  const executeCommand = async (command) => {
    const action = String((command && command.action) || '')
    const payload = command && typeof command.payload === 'object' && command.payload !== null ? command.payload : {}
    if (action === 'rule.create') {
      const result = addEntry(
        {
          title: payload.title,
          text: payload.text,
          kind: payload.kind,
          scope: payload.scope,
          groupId: payload.groupId || '',
          // 面板没有会话上下文：工作区作用域未显式给 workspace 时用当前最活跃工作目录兜底。
          workspace: payload.workspace || (payload.groupId ? '' : defaultWorkspaceForRule()),
          author: 'panel',
          tags: payload.tags,
          files: payload.files,
          ttlHours: payload.ttlHours
        },
        'panel'
      )
      if (!result.ok) {
        return { ok: false, error: result.reason === 'duplicate' ? `已有相似条目：${result.existing.title}` : result.reason }
      }
      return { ok: true, ruleId: result.entry.id }
    }
    if (action === 'rule.remove') {
      const rule = findRule(payload.id)
      if (!rule) return { ok: false, error: '找不到这条规矩（可能已被删除）' }
      appendEvents(boardDir, [{ op: 'remove', id: rule.id, by: 'panel', ts: Date.now() }])
      deliveryStore.dropRule(rule.id)
      return { ok: true }
    }
    if (action === 'rule.retarget') {
      const rule = findRule(payload.id)
      if (!rule) return { ok: false, error: '找不到这条规矩（可能已被删除）' }
      const groupId = typeof payload.groupId === 'string' && payload.groupId.trim() ? payload.groupId.trim() : ''
      const group = groupId ? groupStore.find(groupId, rule.workspace) : null
      if (groupId && !group) return { ok: false, error: '找不到群组' }
      appendEvents(boardDir, [
        {
          op: 'retarget',
          id: rule.id,
          groupId: group ? group.id : null,
          scope: group ? 'group' : rule.scope === 'global' ? 'global' : 'workspace',
          ts: Date.now()
        }
      ])
      return { ok: true }
    }
    if (action === 'rule.accept') {
      const rule = findRule(payload.id)
      if (!rule) return { ok: false, error: '找不到这条规矩（可能已被删除）' }
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      if (payload.accepted === false) {
        deliveryStore.recordUnaccept(rule.id, sessionId)
      } else {
        deliveryStore.recordAccept(rule.id, sessionId)
      }
      return { ok: true }
    }
    if (action === 'group.suggest') {
      const suggestions = await computeGroupSuggestions()
      return { ok: true, suggestions }
    }
    if (action === 'world.route') {
      // 只做路由分析、不执行任务：用于面板预览/自测。
      const text = String(payload.text || '').trim().slice(0, 1200)
      if (!text) return { ok: false, error: '内容不能为空' }
      const forceNew = payload.forceNew === true || FORCE_NEW_RE.test(text)
      const decision = await decideWorldRoute(text, forceNew)
      return { ok: true, decision, forceNew }
    }
    if (action === 'world.post') {
      // 世界聊天：用户发布任务 → 先让「路由器模型」判断交给哪个已申报会话，还是新建会话/工作区。
      const text = String(payload.text || '').trim().slice(0, 1200)
      if (!text) return { ok: false, error: '内容不能为空' }
      // 防重复点击：20 秒内同样的世界任务只建一次（前端乐观发送 + 这里兜底）。
      try {
        const normalizeWorldText = (value) => String(value || '').replace(/\s+/g, ' ').trim()
        const existing = store.readActive().find(
          (entry) =>
            entry.channel === 'world' &&
            entry.kind === 'command' &&
            entry.author === 'panel' &&
            Date.now() - (entry.ts || 0) < 20000 &&
            normalizeWorldText(entry.text) === normalizeWorldText(text)
        )
        if (existing) {
          logger.info(`世界任务重复发送已忽略：${existing.id}`)
          return {
            ok: true,
            duplicate: true,
            messageId: existing.id,
            assigned: [],
            woken: 0,
            createdSession: '',
            createdWorkspace: '',
            createError: '',
            requestIds: [],
            route: 'duplicate',
            router: { engine: 'dedupe', reason: '相同任务刚刚已发送，重复点击已忽略' }
          }
        }
      } catch {
        /* 去重失败不影响正常发送 */
      }
      const forceNew = payload.forceNew === true || FORCE_NEW_RE.test(text)
      // 世界任务的 @ 解析与「扩充新成员」意图：这两类不交给路由器，避免把新成员外包给子代理。
      const sessionsNow = await buildSessionIndex()
      const mentionCandidates = sessionsNow.filter((session) => session.worldEligible === true)
      const parsedWorldMentions = parseMentionsInText(text, mentionCandidates)
      if (parsedWorldMentions.ambiguous.length) {
        return {
          ok: false,
          error: [
            '世界任务正文的 @ 指向不唯一，请改用 contactId（如 4f51e99f）或完整 id 重新发布（不会替你猜）：',
            ...parsedWorldMentions.ambiguous.slice(0, 4).map(
              (item) => `「@${item.token}」匹配到多个会话：\n- ` + item.candidates.slice(0, 8).map(describeSessionCandidate).join('\n- ')
            ),
            '可用 session_directory 查通讯录（contactId / handle / 标题）。'
          ].join('\n')
        }
      }
      const wantsNewMembers = /(新成员|新会话|新建会话|开新会话|创建.{0,10}(会话|成员)|入驻|扩编|扩招|加.{0,4}(个|位)?.{0,4}(人|成员|会话))/i.test(text)
      const folderTask = resolveFolderTask(text)
      const parseMemberCount = () => {
        const arabic = text.match(/(\d{1,2})\s*(?:个|位|名)?\s*(?:新)?(?:会话|成员|人)/)
        if (arabic) return Math.min(5, Math.max(1, Number(arabic[1])))
        const cn = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5 }
        const chinese = text.match(/([一二两三四五])\s*(?:个|位|名)?\s*(?:新)?(?:会话|成员|人)/)
        if (chinese) return cn[chinese[1]] || 1
        if (/几个|几位/.test(text)) return 2
        return 1
      }
      const requestedMemberCount = parseMemberCount()
      let decision
      if (wantsNewMembers) {
        decision = {
          engine: 'new-members',
          route: 'new',
          sessionId: '',
          newWorkspace: false,
          folderPath: folderTask ? folderTask.path : '',
          workspaceName: folderTask ? folderTask.name : '',
          reason: '用户明确要新成员/新会话：由宿主创建根会话，不能用子代理冒充成员' + (folderTask ? '（指定文件夹：' + folderTask.name + '）' : '')
        }
      } else if (folderTask) {
        decision = {
          engine: 'folder-workspace',
          route: 'new',
          sessionId: '',
          newWorkspace: true,
          folderPath: folderTask.path,
          workspaceName: folderTask.name,
          reason: '任务指向本地文件夹「' + folderTask.name + '」，自动为该目录建工作区并开新会话'
        }
      } else if (parsedWorldMentions.all) {
        decision = {
          engine: 'mentions',
          route: 'existing',
          sessionId: mentionCandidates[0] ? mentionCandidates[0].id : '',
          sessionIds: mentionCandidates.slice(0, 6).map((session) => session.id),
          reason: '用户在世界任务里 @所有人，直接派给现有成员'
        }
      } else if (parsedWorldMentions.ids.length) {
        decision = {
          engine: 'mentions',
          route: 'existing',
          sessionId: parsedWorldMentions.ids[0],
          sessionIds: parsedWorldMentions.ids,
          reason: '用户在世界任务里 @ 指定成员，直接派给 TA'
        }
      } else {
        decision = await decideWorldRoute(text, forceNew)
      }
      if (forceNew && decision.route !== 'new') {
        // 用户明确说「全新」时，无条件新建（模型判断也不能违背）。
        decision.route = 'new'
        decision.sessionId = ''
        decision.reason = `用户明确要求全新；${decision.reason || ''}`
      }
      // 自动创建新会话/工作区前，先让用户复核（仅针对方舟自动创建，不拦手动新对话）。
      if (decision.route === 'new') {
        const approvalRef = String((payload && payload.approvalId) || '').trim()
        const approvalsNow = readApprovals()
        let approvalHit = null
        if (approvalRef) {
          approvalHit = approvalsNow.find((item) => item && (item.id === approvalRef || item.id.startsWith(approvalRef))) || null
          if (approvalHit && approvalHit.status === 'rejected') {
            return { ok: false, error: '该任务已被驳回，如需重新执行请重新发布任务。' }
          }
          if (approvalHit && approvalHit.status === 'pending' && payload.approved === true) {
            approvalHit.status = 'approved'
            approvalHit.approvedAt = Date.now()
            approvalHit.approvedBy = 'panel'
            writeApprovals(approvalsNow)
          }
        }
        const approvalBypass = payload.approved === true && approvalHit && (approvalHit.status === 'approved' || approvalHit.status === 'pending')
        if (cfg.approveAutoCreate !== false && !approvalBypass) {
          const existingPending = approvalsNow.find(
            (item) => item && item.status === 'pending' && String(item.text || '') === text && Date.now() - (item.createdAt || 0) < 30 * 60 * 1000
          )
          if (existingPending) return { ok: true, pendingApproval: true, approval: existingPending }
          const requestedWorkspace = decision.folderPath || ''
          const approval = {
            id: 'ap-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex'),
            status: 'pending',
            createdAt: Date.now(),
            text,
            title: text.slice(0, 60),
            route: decision.route,
            engine: decision.engine,
            reason: decision.reason,
            memberCount: decision.engine === 'new-members' ? requestedMemberCount : 0,
            workspacePath: requestedWorkspace,
            workspaceName: decision.workspaceName || '',
            permissionNote: requestedWorkspace
              ? '工作区：' + requestedWorkspace + '；继承 DSH 当前文件/工具权限'
              : '由宿主新建工作区；继承 DSH 当前文件/工具权限',
            source: 'world.post'
          }
          approvalsNow.push(approval)
          writeApprovals(approvalsNow)
          addEntry(
            {
              title: '待复核：' + text.slice(0, 20),
              text: '世界任务需要创建新会话/工作区，等待用户在星桥窗口复核。\n任务：' + text.slice(0, 300),
              kind: 'chat',
              scope: 'global',
              channel: 'world',
              author: 'panel',
              origin: 'panel',
              hiddenFromChat: true,
              skipDedupe: true
            },
            'panel'
          )
          logger.info('世界任务已进入待复核：' + approval.id + '，' + text.slice(0, 60))
          return { ok: true, pendingApproval: true, approval, message: '已进入待复核，请在星桥窗口确认' }
        }
      }
      let assigned = []
      let createdSession = ''
      let createdTitle = ''
      let createdWorkspace = ''
      let createError = ''
      if (decision.route === 'existing' && (decision.sessionIds || decision.sessionId)) {
        const sessions = sessionsNow
        const ids = decision.sessionIds && decision.sessionIds.length ? decision.sessionIds : [decision.sessionId]
        assigned = ids
          .map((sessionId) => sessions.find((session) => session.id === sessionId))
          .filter(Boolean)
          .map((target) => ({ id: target.id, title: target.title, contactId: target.contactId || contactIdOf(target.id), score: 0 }))
      }
      // 协同类任务：如果只命中一个会话，再挑 1-2 个申报相关的成员一起拉群。
      if (decision.route === 'existing' && decision.engine !== 'mentions' && assigned.length === 1) {
        const collaborative = /(大家|一起|协同|协作|分工|多人|帮忙|帮手|人手|增援|协助|配合|团队|各自)/.test(text)
        if (collaborative) {
          try {
            const profilesNow = listProfilesOf(boardDir)
            const extra = sessionsNow
              .filter(
                (session) =>
                  session.worldEligible === true &&
                  session.id !== assigned[0].id &&
                  profilesNow[session.id]
              )
              .map((session) => ({
                session,
                score: scoreProfileForText(text, profilesNow[session.id])
              }))
              .filter((item) => item.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, 2)
            if (extra.length) {
              assigned.push(
                ...extra.map((item) => ({ id: item.session.id, title: item.session.title, score: item.score }))
              )
              decision.reason += '；根据协同需求扩展给 ' + extra.length + ' 位相关成员'
            }
          } catch {
            /* ignore */
          }
        }
      }
      const createdSessions = []
      if (decision.engine === 'new-members') {
        const baseSession = parsedWorldMentions.ids
          .map((sessionId) => sessionsNow.find((session) => session.id === sessionId))
          .find((session) => session && session.cwd)
        let cwdOverride = decision.folderPath || (baseSession && baseSession.cwd ? baseSession.cwd : '')
        // 没 @ 人时，从正文里找已知工作区名（例如「入驻 shoot_game」），把新成员放进对应工作区。
        if (!cwdOverride) {
          try {
            const registry = (ctx.get && ctx.get('workspaceRegistry')) || ctx.workspaceRegistry
            const workspaces = registry && typeof registry.list === 'function' ? registry.list() : []
            const lowerText = String(text).toLowerCase()
            const matchedWorkspace = workspaces.find((workspace) => {
              const title = String(workspace.title || '').toLowerCase()
              const base = String(workspace.path || '').split(/[\\/]/).filter(Boolean).pop() || ''
              return (title && lowerText.includes(title)) || (base && lowerText.includes(base.toLowerCase()))
            })
            if (matchedWorkspace && matchedWorkspace.path) cwdOverride = matchedWorkspace.path
          } catch {
            /* ignore */
          }
        }
        for (let index = 0; index < requestedMemberCount; index += 1) {
          const prettyName = prettyMemberName(cwdOverride, index, text)
          const created = await createSessionForTask(cwdOverride || undefined, prettyName.title)
          if (created.ok) {
            try {
              let hash = 0
              for (let cursor = 0; cursor < created.sessionId.length; cursor += 1) hash = (hash * 31 + created.sessionId.charCodeAt(cursor)) >>> 0
              identityStore.set(created.sessionId, {
                handle: uniqueHandle(prettyName.codename, created.sessionId),
                avatar: AVATAR_PALETTE[hash % AVATAR_PALETTE.length],
                role: '新成员',
                skills: [],
                style: '',
                persona: '',
                updatedAt: Date.now()
              })
            } catch {
              /* ignore */
            }
            createdSessions.push({ id: created.sessionId, title: created.title || prettyName.title })
            assigned.push({ id: created.sessionId, title: created.title || prettyName.title, score: 0 })
            if (!createdSession) {
              createdSession = created.sessionId
              createdTitle = created.title || ''
            }
          } else {
            createError = createError ? createError + '；' + created.error : created.error
          }
        }
      }
      if (!assigned.length) {
        let cwdOverride = ''
        if (decision.folderPath) {
          const ensured = await ensureWorkspaceForFolder(decision.folderPath, decision.workspaceName)
          if (ensured.ok) {
            cwdOverride = ensured.cwd
            createdWorkspace = ensured.cwd
          } else {
            createError = '为文件夹建工作区失败：' + ensured.error
          }
        }
        if (decision.newWorkspace && !cwdOverride) {
          const workspace = await createWorkspaceForTask(text, decision.workspaceName)
          if (workspace.ok) {
            cwdOverride = workspace.cwd
            createdWorkspace = workspace.cwd
          } else {
            createError = `新建工作区失败：${workspace.error}`
          }
        }
        const created = await createSessionForTask(cwdOverride || undefined, `世界任务：${truncate(text, 24)}`)
        if (created.ok) {
          createdSession = created.sessionId
          createdTitle = created.title || ''
          assigned = [{ id: createdSession, title: '新会话', score: 0 }]
        } else {
          createError = createError ? `${createError}；${created.error}` : created.error
        }
      }
      let createdGroup = null
      if (assigned.length >= 1) {
        try {
          const memberIds = [...new Set(assigned.map((item) => item.id))]
          const baseName = ('协作：' + String(text).replace(/\s+/g, ' ')).slice(0, 24)
          const groupsNow = groupStore.read()
          let groupName = baseName
          let suffix = 2
          while (groupsNow.some((group) => group.name === groupName)) {
            groupName = baseName + ' ' + suffix
            suffix += 1
          }
          const firstSession = sessionsNow.find((session) => session.id === memberIds[0])
          const group = {
            id: 'g-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex'),
            name: groupName,
            workspace: (firstSession && firstSession.cwd) || '',
            goal: text.slice(0, 300),
            managerSessionId: memberIds[0],
            sessionIds: memberIds,
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
          groupsNow.push(group)
          groupStore.write(groupsNow)
          try {
            const permissions = readPermissionsOf(boardDir)
            const grants = new Set(permissions.grants[memberIds[0]] || [])
            for (const memberId of memberIds) if (memberId !== memberIds[0]) grants.add(memberId)
            permissions.grants[memberIds[0]] = [...grants]
            writePermissionsOf(boardDir, permissions)
          } catch {
            /* ignore */
          }
          addEntry(
            {
              title: '协作群：' + groupName,
              text: '为这次世界任务自动建群（' + memberIds.length + ' 人）。任务：' + text,
              kind: 'chat',
              groupId: group.id,
              author: 'panel',
              origin: 'panel',
              mentions: memberIds,
              tags: '@自动建群',
              skipDedupe: true
            },
            'panel'
          )
          createdGroup = { id: group.id, name: group.name, members: memberIds.length }
          logger.info('世界任务自动建群：' + groupName + '（' + memberIds.length + ' 人）')
        } catch (error) {
          logger.warn('世界任务自动建群失败：' + (error && error.message ? error.message : error))
        }
      }
      let autoGroupTask = null
      let autoCoordinatorId = ''
      if (createdGroup) {
        try {
          const memberIds = [...new Set(assigned.map((item) => item.id))]
          autoCoordinatorId = memberIds[0]
          const assignees = memberIds.slice(1)
          autoGroupTask = addEntry(
            {
              title: '世界任务：' + truncate(text, 20),
              text,
              kind: 'task',
              scope: 'group',
              groupId: createdGroup.id,
              author: 'panel',
              origin: 'panel',
              mentions: memberIds,
              taskStatus: 'assigned',
              coordinator: autoCoordinatorId,
              assignees,
              worldTask: true,
              skipDedupe: true
            },
            'panel'
          )
          if (autoGroupTask.ok) {
            autoGroupTask = autoGroupTask.entry
            addEntry(
              {
                title: '任务已下发：' + truncate(text, 20),
                text: '组长：' + (assigned[0].title || shortSid(autoCoordinatorId)) + '（contactId=' + contactIdOf(autoCoordinatorId) + '）。成员：' + assignees.map((id) => contactIdOf(id)).join('、') + '。\n' + text,
                kind: 'chat',
                groupId: createdGroup.id,
                author: 'panel',
                origin: 'panel',
                mentions: memberIds,
                tags: '@任务',
                skipDedupe: true
              },
              'panel'
            )
            try {
              const permissions = readPermissionsOf(boardDir)
              const grants = new Set(permissions.grants[autoCoordinatorId] || [])
              for (const memberId of assignees) grants.add(memberId)
              permissions.grants[autoCoordinatorId] = [...grants]
              writePermissionsOf(boardDir, permissions)
            } catch {
              /* ignore */
            }
          }
        } catch (error) {
          logger.warn('创建自动协作群任务失败：' + (error && error.message ? error.message : error))
        }
      }
      const note = addEntry(
        {
          title: text.slice(0, 20),
          text,
          kind: 'command',
          scope: 'global',
          author: 'panel',
          origin: 'panel',
          channel: 'world',
          mentions: assigned.map((item) => item.id),
          skipDedupe: true
        },
        'panel'
      )
      if (!note.ok) return { ok: false, error: note.reason || '发布失败' }

      const requestIds = []
      const woken = []
      for (const item of assigned) {
        // 自动协作群里，只有组长拿正式任务请求；其他成员先待命，由组长 session_ask 分工。
        if (createdGroup && autoGroupTask && item.id !== autoCoordinatorId) {
          const memberMessage = [
            '【协作群任务 · 你是成员，先待命】',
            `你已被拉入自动协作群「${createdGroup.name}」，组长是 ${assigned[0].title || shortSid(autoCoordinatorId)}。`,
            '',
            '请先用 session_profile（action=update）提交一句话申报（方向/擅长/需要什么），然后等待组长用 session_ask 给你分工；',
            '不要独自重复执行主任务，有想法可以在群里主动请缨。'
          ].join('\n')
          await ensureSessionLive(item.id)
          const outcome = wakeSession(item.id, memberMessage, {})
          if (outcome.ok) woken.push(item.id)
          continue
        }
        const mentionName = createdSession === item.id ? '新会话' : shortSid(item.id)
        const request = addEntry(
          {
            title: `@${mentionName} ${truncate(text, 18)}`,
            text,
            kind: 'request',
            scope: createdGroup ? 'group' : 'global',
            groupId: createdGroup ? createdGroup.id : '',
            author: 'panel',
            origin: 'panel',
            channel: createdGroup ? '' : 'world',
            requestTo: [item.id],
            mentions: [item.id],
            hiddenFromChat: true,
            skipDedupe: true,
            ...(createdGroup && autoGroupTask ? { taskId: autoGroupTask.id, taskRole: 'coordinator' } : {})
          },
          'panel'
        )
        if (!request.ok) continue
        requestIds.push(request.entry.id)
        const isExtraMember = decision.engine === 'new-members' && item.id !== createdSession && !createdGroup
        const message = isExtraMember
          ? [
              '【新成员报到 · 用户在世界里要求扩充成员】',
              `你刚刚作为根会话加入工作区，不是子代理。`,
              createdGroup ? `（已自动拉协作群「${createdGroup.name}」，可到群聊里和队友打招呼）` : '',
              '',
              '请先用 session_profile（action=update）提交一句话申报（方向/擅长/需要什么），再用一句话介绍自己；',
              '不要执行【任务】主体，等待主责成员或群主分配；有想法可以主动请缨。'
            ].join('\n')
          : createdGroup && autoGroupTask
            ? [
                '【世界任务 · 你是组长】',
                `已自动拉协作群「${createdGroup.name}」，成员：${assigned.slice(1).map((member) => member.title || shortSid(member.id)).join('、') || '（暂无）'}。`,
                '成员通讯录（派活用 session_ask 的 to=contactId，下方 contactId 可直接复制；也可用 session_directory group=群名 查询）：',
                memberDirectoryText(
                  assigned.slice(1).map((member) => sessionsNow.find((session) => session.id === member.id) || member)
                ),
                createdWorkspace ? `（本任务新开了工作区：${createdWorkspace}）` : '',
                `路由理由：${decision.reason}`,
                '',
                text,
                '',
                `请用 session_ask（mode=task）把任务拆给群成员并跟进（to 支持 contactId / 短 id / handle / 标题，不限完整 id）。中间进度只发本任务群（不要 replyTo 世界请求）；全部完成后，用 session_share（kind=handoff、replyTo=${request.entry.id}、files=文件路径）写【任务完成】汇总，系统才会发布到世界并结算积分。`
              ]
                .filter(Boolean)
                .join('\n')
            : [
                '【世界任务 · 用户 @ 你】',
                createdWorkspace ? `（本任务新开了工作区：${createdWorkspace}）` : '',
                createdGroup ? `（已自动拉协作群「${createdGroup.name}」）` : '',
                `路由理由：${decision.reason}`,
                '',
                text,
                '',
                `中间进度不要 replyTo 世界请求（避免刷屏）；全部完成后用 session_share（kind=handoff、replyTo=${request.entry.id}、files=文件路径）写【任务完成】汇报，系统会发布到世界并结算积分。`
              ]
                .filter(Boolean)
                .join('\n')
        await ensureSessionLive(item.id)
        const outcome = wakeSession(item.id, message, { requestId: request.entry.id })
        if (outcome.ok) woken.push(item.id)
      }
      logger.info(
        `世界任务 ${note.entry.id}：路由=${decision.route}/${decision.engine}（${decision.reason}），派给 ${assigned.length} 人，唤醒 ${woken.length}${createdSession ? '，新建会话' : ''}${createdWorkspace ? `，新建工作区 ${createdWorkspace}` : ''}${createError ? '，错误：' + createError : ''}`
      )
      return {
        ok: true,
        messageId: note.entry.id,
        assigned,
        woken: woken.length,
        createdSession,
        createdSessionTitle: createdTitle,
        createdSessions,
        createdGroup,
        createdWorkspace,
        createError,
        requestIds,
        forceNew,
        route: decision.route,
        router: { engine: decision.engine, reason: decision.reason }
      }
    }
    if (action === 'session.revive') {
      // 历史会话在侧栏里没有可读标题时：恢复为 live（不跑回合）并改名，让它重新出现在会话列表。
      const sessionId = String(payload.sessionId || '').trim()
      const title = String(payload.title || '').trim().slice(0, 40)
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      let agent = ctx.agents.get ? ctx.agents.get(sessionId) : undefined
      let resumed = false
      if (!agent) {
        if (!ctx.agents || typeof ctx.agents.resume !== 'function') {
          return { ok: false, error: '宿主不提供 agents.resume' }
        }
        try {
          const selection = resolveDefaultSelection()
          const setup =
            installModelSelection && selection
              ? (agentCtx) => {
                  installModelSelection(agentCtx, { current: selection })
                }
              : undefined
          const handle = await ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: {},
            ...(setup ? { setup } : {})
          })
          agent = handle && handle.agent ? handle.agent : handle
          resumed = Boolean(agent)
        } catch (error) {
          return { ok: false, error: `恢复会话失败：${error && error.message ? error.message : error}` }
        }
      }
      let renamed = ''
      try {
        const titles = (ctx.get && ctx.get('sessionTitle')) || ctx.sessionTitle
        if (agent && titles && typeof titles.rename === 'function' && title) {
          const snapshot = titles.rename(agent.session, title)
          renamed = (snapshot && snapshot.title) || ''
        }
      } catch (error) {
        return { ok: false, error: `会话已恢复但改名失败：${error && error.message ? error.message : error}`, resumed }
      }
      if (renamed) titleCache.delete(sessionId)
      logger.info(`会话 ${shortSid(sessionId)} 恢复为 live${renamed ? `，改名 ${renamed}` : ''}`)
      return { ok: true, sessionId, resumed, renamed }
    }
    if (action === 'session.recover') {
      const sessionId = String(payload.sessionId || '').trim()
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      const registry = (ctx.get && ctx.get('workspaceRegistry')) || ctx.workspaceRegistry
      if (!registry || typeof registry.resolveByPath !== 'function') {
        return { ok: false, error: '宿主不提供 workspaceRegistry' }
      }
      let workspace = null
      try {
        if (payload.workspacePath) workspace = await registry.resolveByPath(String(payload.workspacePath))
        if (!workspace && typeof registry.list === 'function') {
          const visible = registry.list()
          workspace =
            visible.find((item) => item.title === 'default-workspace') ||
            visible.find((item) => item.path === defaultWorkspaceForRule()) ||
            visible[0]
        }
      } catch {
        workspace = null
      }
      if (!workspace) return { ok: false, error: '找不到可挂载的工作区' }
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        return { ok: false, error: `挂载失败：${error && error.message ? error.message : error}` }
      }
      let renamed = ''
      try {
        const agent = ctx.agents.get ? ctx.agents.get(sessionId) : undefined
        const titles = (ctx.get && ctx.get('sessionTitle')) || ctx.sessionTitle
        if (agent && titles && typeof titles.rename === 'function' && payload.title) {
          const snapshot = titles.rename(agent.session, String(payload.title).slice(0, 40))
          renamed = (snapshot && snapshot.title) || ''
        }
      } catch {
        /* 历史会话无法改名，挂载成功即可 */
      }
      logger.info(`会话 ${shortSid(sessionId)} 补挂到工作区 ${workspace.path}${renamed ? `，改名 ${renamed}` : ''}`)
      return { ok: true, sessionId, workspacePath: workspace.path, workspaceTitle: workspace.title, renamed }
    }
    if (action === 'approval.list') {
      return { ok: true, approvals: readApprovals().filter((item) => item && item.status === 'pending') }
    }
    if (action === 'approval.reject') {
      const approvalRef = String((payload && payload.id) || '').trim()
      if (!approvalRef) return { ok: false, error: '缺少待复核 id' }
      const approvals = readApprovals()
      const target = approvals.find((item) => item && (item.id === approvalRef || item.id.startsWith(approvalRef)))
      if (!target) return { ok: false, error: '找不到待复核记录' }
      if (target.status !== 'pending') return { ok: false, error: '该记录已处理：' + target.status }
      target.status = 'rejected'
      target.rejectedAt = Date.now()
      target.rejectedBy = 'panel'
      writeApprovals(approvals)
      logger.info('世界任务复核被驳回：' + target.id)
      return { ok: true, approval: target }
    }
    if (action === 'config.update') {
      return saveSettingsPatch(payload.patch)
    }
    if (action === 'perm.grant' || action === 'perm.revoke') {
      const sessionId = String(payload.sessionId || '').trim()
      const targetId = String(payload.targetId || '').trim()
      if (!sessionId || !targetId) return { ok: false, error: '缺少 sessionId / targetId' }
      const data = readPermissionsOf(boardDir)
      const list = new Set(data.grants[sessionId] || [])
      if (action === 'perm.grant') list.add(targetId)
      else list.delete(targetId)
      data.grants[sessionId] = [...list]
      writePermissionsOf(boardDir, data)
      return { ok: true, sessionId, grants: data.grants[sessionId] }
    }
    if (action === 'pending.run') {
      // 面板/自测用：立即巡检一次串行队列（不等 15 秒定时器）。
      const report = runPendingQueue({ source: 'panel' })
      return { ok: true, report }
    }
    if (action === 'pending.cancel') {
      // 取消一条排队中的串行指令（还没发出去的才能取消）。
      const wanted = String(payload.id || payload.requestId || '').trim()
      if (!wanted) return { ok: false, error: '缺少 id' }
      const items = pendingStore.read()
      const target =
        items.find((item) => item.id === wanted) ||
        items.find((item) => item.requestId === wanted) ||
        items.find((item) => item.id.startsWith(wanted)) ||
        items.find((item) => typeof item.requestId === 'string' && item.requestId.startsWith(wanted))
      if (!target) return { ok: false, error: '找不到排队项' }
      if (target.status !== 'queued') return { ok: false, error: `排队项状态是 ${target.status}，不能取消` }
      target.status = 'cancelled'
      target.updatedAt = Date.now()
      pendingStore.write(items)
      try {
        appendEvents(boardDir, [
          { op: 'task', id: target.requestId, patch: { status: 'cancelled', failReason: '用户/面板取消' }, ts: Date.now() }
        ])
      } catch {
        /* ignore */
      }
      logger.info(`串行指令已取消：${target.id}（请求 ${target.requestId}）`)
      return { ok: true, id: target.id, requestId: target.requestId }
    }
    if (action === 'group.post') {
      // 面板群聊里发消息 / @成员发布工作：聊天记录 + 被 @ 的成员定向唤醒（离线成员下次运行被注入）。
      const groupRef = String(payload.id || '').trim()
      const groups = groupStore.read()
      const group = groups.find((item) => item.id === groupRef || item.id.startsWith(groupRef))
      if (!group) return { ok: false, error: '找不到群组' }
      const text = String(payload.text || '').trim().slice(0, 1200)
      if (!text) return { ok: false, error: '消息不能为空' }
      const sessions = await buildSessionIndex()
      const memberSessions = group.sessionIds
        .map((sessionId) => sessions.find((session) => session.id === sessionId))
        .filter(Boolean)
      const parsedMentions = parseMentionsInText(text, memberSessions)
      if (parsedMentions.ambiguous.length) {
        return {
          ok: false,
          error: [
            '正文的 @ 指向不唯一，请改用 contactId 或完整 id 重新发送（不会替你猜）：',
            ...parsedMentions.ambiguous.slice(0, 4).map(
              (item) => `「@${item.token}」匹配到多个会话：\n- ` + item.candidates.slice(0, 8).map(describeSessionCandidate).join('\n- ')
            ),
            '可用 session_directory group=群名 查 contactId。'
          ].join('\n')
        }
      }
      const mentionAll = payload.mentionAll === true || parsedMentions.all
      const requested = [
        ...(Array.isArray(payload.mentionSessionIds)
          ? payload.mentionSessionIds.filter((item) => typeof item === 'string' && item)
          : []),
        ...parsedMentions.ids
      ]
      let targetIds = mentionAll
        ? [...group.sessionIds]
        : requested.filter((sessionId) => group.sessionIds.includes(sessionId))
      targetIds = [...new Set(targetIds)]
      if (mentionAll) targetIds = targetIds.filter((sessionId) => sessionId !== maintainerStore.get())
      const titleById = new Map(sessions.map((session) => [session.id, session.title]))
      const sessionById = new Map(sessions.map((session) => [session.id, session]))
      const titleOf = (sessionId) => titleById.get(sessionId) || shortSid(sessionId)
      // 组任务的串行步骤（轻量记录）：步骤有先后依赖时，组长用 session_ask 的 dependsOn + step 排队。
      const taskSteps = normalizeTaskSteps(payload.steps)
      const stepLines = taskSteps.map((step) => `${step.i}. ${step.text}`)

      // 多人任务：一个任务只能有一个组长；成员只交组长、不直接向用户汇报，避免“人人都是组长”。
      if (targetIds.length >= 2) {
        let coordinatorId = targetIds[0]
        let bestScore = -1
        try {
          const profiles = listProfilesOf(boardDir)
          for (const sessionId of targetIds) {
            const profile = profiles[sessionId]
            const score = profile ? scoreProfileForText(text, profile) : 0
            if (score > bestScore) {
              bestScore = score
              coordinatorId = sessionId
            }
          }
        } catch {
          /* 无申报时用第一个成员当组长 */
        }
        // 用户可在面板里显式指定组长；指定的人必须在本次 @ 的成员里。
        const requestedCoordinator = typeof payload.coordinatorId === 'string' ? payload.coordinatorId.trim() : ''
        if (requestedCoordinator && targetIds.includes(requestedCoordinator)) {
          coordinatorId = requestedCoordinator
          bestScore = Number.POSITIVE_INFINITY
        }
        // 优先选一个「在线」的组长；都在线则用评分最高者，全离线则保留评分最高者（任务排队）。
        try {
          const liveIds = new Set(liveRootSessions().map((item) => item.id))
          if (!liveIds.has(coordinatorId)) {
            const liveTarget = targetIds.find((sessionId) => liveIds.has(sessionId))
            if (liveTarget) coordinatorId = liveTarget
          }
        } catch {
          /* ignore */
        }
        const assigneeIds = targetIds.filter((sessionId) => sessionId !== coordinatorId)
        const taskEntry = addEntry(
          {
            title: text.slice(0, 20),
            text,
            kind: 'task',
            groupId: group.id,
            author: 'panel',
            origin: 'panel',
            tags: '@群任务',
            mentions: targetIds,
            taskStatus: 'assigned',
            coordinator: coordinatorId,
            assignees: assigneeIds,
            steps: taskSteps,
            skipDedupe: true
          },
          'panel'
        )
        if (!taskEntry.ok) return { ok: false, error: taskEntry.reason || '任务创建失败' }
        const taskId = taskEntry.entry.id
        // 临时授权组长可以唤醒本次任务的成员（任务结束后可在群设置里撤销）。
        try {
          const permissions = readPermissionsOf(boardDir)
          const grants = new Set(permissions.grants[coordinatorId] || [])
          for (const sessionId of assigneeIds) grants.add(sessionId)
          permissions.grants[coordinatorId] = [...grants]
          writePermissionsOf(boardDir, permissions)
        } catch {
          /* 授权失败不阻塞任务 */
        }

        const memberTitles = assigneeIds.map((sessionId) => titleOf(sessionId)).join('、')
        const assigneeSessions = assigneeIds.map((sessionId) => sessionById.get(sessionId) || { id: sessionId, title: titleOf(sessionId) })
        let woken = 0
        const requestIds = []
        const coordinatorRequest = addEntry(
          {
            title: `@${shortSid(coordinatorId)} 组长：${truncate(text, 16)}`,
            text,
            kind: 'request',
            groupId: group.id,
            author: 'panel',
            origin: 'panel',
            requestTo: [coordinatorId],
            mentions: [coordinatorId],
            hiddenFromChat: true,
            taskId,
            taskRole: 'coordinator',
            skipDedupe: true
          },
          'panel'
        )
        if (coordinatorRequest.ok) {
          requestIds.push(coordinatorRequest.entry.id)
          const message = [
            `【群任务 · 你是唯一组长（用户指定）】群组「${group.name}」`,
            `任务：${text}`,
            `成员：${memberTitles || '(无)'}`,
            ...(assigneeSessions.length
              ? [
                  '成员通讯录（派活用 session_ask 的 to=contactId，下方 contactId 可直接复制；也可用 session_directory group=群名 查询）：',
                  memberDirectoryText(assigneeSessions)
                ]
              : []),
            '',
            '你的职责：',
            '1. 先规划分工；成员目前**还没有被唤醒**，只有你用 session_ask mode=task 派活后他们才会收到（派活会自动归属本任务，避免同一任务被重复执行；to 支持 contactId / 短 id / handle / 标题，不限完整 id）；',
            ...(stepLines.length
              ? [
                  `本次任务的步骤（有先后依赖时**串行**，不要一次全发）：`,
                  ...stepLines,
                  '串行做法：先发步骤 1（session_ask mode=task、step=1）；拿到它返回的 id 后，步骤 2 用 dependsOn=<步骤1的 id> + step=2 排队——前置没回复就不会唤醒人，回复后自动发出。'
                ]
              : []),
            '2. 收集成员提交的内容；',
            `3. 最后用 session_share（kind=handoff、group=${group.name}、replyTo=${coordinatorRequest.entry.id}、files=…）向用户提交唯一汇总。`,
            '注意：成员不会直接向用户汇报；只有你是组长，不要让成员替你汇总，也不要重复成员已完成的工作。'
          ].join('\n')
          await ensureSessionLive(coordinatorId)
          if (wakeSession(coordinatorId, message, { requestId: coordinatorRequest.entry.id }).ok) woken += 1
        }
        // 关键：任务创建阶段只唤醒组长；成员等组长用 session_ask 派工时被唤醒一次。
        logger.info(
          `群任务 ${taskId} 已创建：组长 ${shortSid(coordinatorId)}（唤醒=${woken}），成员 ${assigneeIds.length} 人待组长派工`
        )
        return {
          ok: true,
          messageId: taskId,
          task: {
            id: taskId,
            coordinator: { id: coordinatorId, title: titleOf(coordinatorId), contactId: contactIdOf(coordinatorId) },
            assignees: assigneeIds.map((sessionId) => ({ id: sessionId, title: titleOf(sessionId), contactId: contactIdOf(sessionId) })),
            status: 'assigned',
            steps: taskSteps
          },
          woken,
          requestIds
        }
      }

      const note = addEntry(
        {
          title: text.slice(0, 20),
          text,
          kind: 'command',
          groupId: group.id,
          author: 'panel',
          origin: 'panel',
          tags: '@群消息',
          mentions: targetIds,
          skipDedupe: true
        },
        'panel'
      )
      if (!note.ok) return { ok: false, error: note.reason || '发送失败' }

      const requests = []
      const woken = []
      for (const sessionId of targetIds) {
        const request = addEntry(
          {
            title: `@${shortSid(sessionId)} ${truncate(text, 18)}`,
            text,
            kind: 'request',
            groupId: group.id,
            author: 'panel',
            origin: 'panel',
            requestTo: [sessionId],
            hiddenFromChat: true,
            skipDedupe: true
          },
          'panel'
        )
        if (!request.ok) continue
        requests.push(request.entry.id)
        const message = [
          `【群内工作安排 · 用户在群里 @ 你（群组「${group.name}」）】`,
          text,
          '',
          `请开始处理。完成后用 session_share 汇报（kind=handoff、group=${group.name}、replyTo=${request.entry.id}、files=文件路径）；无法处理请说明原因。`
        ].join('\n')
        await ensureSessionLive(sessionId)
        const outcome = wakeSession(sessionId, message, { requestId: request.entry.id })
        if (outcome.ok) woken.push({ sessionId, title: titleById.get(sessionId) || shortSid(sessionId) })
      }
      logger.info(
        `群「${group.name}」面板发布消息 ${note.entry.id}，@ ${targetIds.length} 人，唤醒 ${woken.length} 人`
      )
      return {
        ok: true,
        messageId: note.entry.id,
        requestIds: requests,
        targets: targetIds.length,
        woken: woken.length,
        wokenTitles: woken.map((item) => item.title)
      }
    }
    if (action === 'group.create') {
      const name = String(payload.name || '').trim().slice(0, 40)
      if (!name) return { ok: false, error: '群名不能为空' }
      // 群组只收主会话（lead）：子代理/teammate 由各自 lead 会话自行交接，不进群。
      const requestedIds = Array.isArray(payload.sessionIds)
        ? [...new Set(payload.sessionIds.filter((item) => typeof item === 'string' && item))]
        : []
      let sessionIds = requestedIds
      try {
        const leads = await buildSessionIndex()
        const leadIds = new Set(leads.map((session) => session.id))
        sessionIds = requestedIds.filter((sessionId) => leadIds.has(sessionId))
      } catch {
        /* 会话索引不可用时保留原样（面板只会传主会话） */
      }
      const now = Date.now()
      const group = {
        id: newGroupId(),
        name,
        workspace: typeof payload.workspace === 'string' ? payload.workspace : '',
        goal: typeof payload.goal === 'string' ? payload.goal.trim().slice(0, 300) : '',
        managerSessionId: '',
        sessionIds,
        createdAt: now,
        updatedAt: now
      }
      const groups = groupStore.read()
      groups.push(group)
      groupStore.write(groups)
      try {
        addEntry(
          {
            title: '群已创建：' + name,
            text: '群「' + name + '」已创建，成员 ' + sessionIds.length + ' 人。',
            kind: 'chat',
            groupId: group.id,
            author: 'panel',
            origin: 'panel',
            mentions: sessionIds,
            tags: '@系统',
            skipDedupe: true
          },
          'panel'
        )
      } catch {
        /* ignore */
      }
      // 入群自动申报：在线的新成员立即唤醒它提交申报；离线的下次运行会看到「未申报」提示。
      let profileRequests = 0
      try {
        profileRequests = requestMemberProfiles(group, sessionIds)
      } catch (error) {
        logger.warn(`入群申报触发失败：${error && error.message ? error.message : error}`)
      }
      logger.info(`新建群组 ${group.id}「${name}」（${sessionIds.length} 个主会话，来自面板；已唤醒 ${profileRequests} 个申报）`)
      return { ok: true, groupId: group.id, profileRequests }
    }
    if (action === 'identity.set') {
      const sessionId = String(payload.sessionId || '').trim()
      const wantedHandle = sanitizeHandle(payload.handle)
      const wantedAvatar = String(payload.avatar || '').trim()
      const wantedRole = String(payload.role || '').replace(/\s+/g, ' ').trim().slice(0, 24)
      const wantedSkills = Array.isArray(payload.skills) ? payload.skills : null
      const wantedStyle = typeof payload.style === 'string' && PERSONA_STYLES.includes(payload.style) ? payload.style : ''
      const wantedPersona = typeof payload.persona === 'string' ? String(payload.persona).replace(/\s+/g, ' ').trim().slice(0, 120) : ''
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      if (!wantedHandle) return { ok: false, error: 'handle 需要 1-16 个字' }
      if (wantedAvatar && !isAvatar(wantedAvatar)) return { ok: false, error: 'avatar 不在可选 emoji 里' }
      const current = identityOf(sessionId, identityTitleOf(sessionId))
      const handle = uniqueHandle(wantedHandle, sessionId)
      const avatar = wantedAvatar || current.avatar
      const role = wantedRole || current.role || ''
      const skills = wantedSkills
        ? [...new Set(wantedSkills)].filter((tag) => ROLE_SKILL_TAGS.includes(tag)).slice(0, 6)
        : current.skills || []
      const style = wantedStyle || current.style || ''
      const persona = wantedPersona || current.persona || ''
      identityStore.set(sessionId, { handle, avatar, role, skills, style, persona, updatedAt: Date.now() })
      logger.info('名片更新：' + avatar + ' ' + handle + (role ? ' · ' + role : '') + '（' + shortSid(sessionId) + '）')
      return { ok: true, sessionId, handle, avatar, role, style, persona }
    }
    if (action === 'group.like') {
      const wanted = String(payload.id || '').trim()
      const targetId = String(payload.sessionId || '').trim()
      const groups = groupStore.read()
      const group = groups.find((item) => item.id === wanted || item.id.startsWith(wanted))
      if (!group) return { ok: false, error: '找不到群组' }
      if (!group.sessionIds.includes(targetId)) return { ok: false, error: '不是本群成员' }
      const like = reputationStore.recordLike('panel', targetId, 10)
      if (!like.ok) return { ok: false, error: '今天已给 TA 点过太多次赞了' }
      const identity = identityOf(targetId, identityTitleOf(targetId))
      scoreSession(targetId, 2, {})
      addEntry(
        {
          title: '点赞：' + identity.handle,
          text: String(payload.reason || '表现不错，继续加油').slice(0, 120),
          kind: 'chat',
          groupId: group.id,
          author: 'panel',
          origin: 'panel',
          mentions: [targetId],
          tags: '@点赞',
          skipDedupe: true
        },
        'panel'
      )
      return { ok: true, targetId, handle: identity.handle }
    }
    if (action === 'session.wake') {
      const sessionId = String(payload.sessionId || '').trim()
      const text = String(payload.text || '').trim().slice(0, 3000)
      if (!sessionId || !text) return { ok: false, error: 'session.wake 需要 sessionId 和 text' }
      const agent = await ensureSessionLive(sessionId)
      if (!agent) return { ok: false, error: '会话恢复失败' }
      const outcome = wakeSession(sessionId, text, {})
      return outcome.ok ? { ok: true, sessionId } : { ok: false, error: outcome.reason || '唤醒失败' }
    }
    if (action === 'share.post') {
      // 维护者/面板回帖：等价于 session_share（kind=handoff），可回复某条请求。
      const text = String(payload.text || '').trim().slice(0, 4000)
      if (!text) return { ok: false, error: '内容不能为空' }
      const kind = KIND_SET.has(payload.kind) ? payload.kind : 'handoff'
      const groupRef = String(payload.group || payload.groupId || '').trim()
      const group = groupRef ? groupStore.find(groupRef, defaultWorkspaceForRule() || undefined) : null
      if (groupRef && !group) return { ok: false, error: '找不到群组' }
      const author = maintainerStore.get() || 'panel'
      const replyTo = String(payload.replyTo || '').trim()
      const request = replyTo ? findRequestEntry(replyTo) : null
      const entry = addEntry(
        {
          title: String(payload.title || text.slice(0, 20)).slice(0, 60),
          text,
          kind,
          scope: group ? 'group' : 'global',
          groupId: group ? group.id : '',
          author,
          origin: 'tool',
          files: Array.isArray(payload.files) ? payload.files.filter((item) => typeof item === 'string' && item) : [],
          replyTo: request ? request.id : '',
          skipDedupe: true
        },
        'tool'
      )
      if (!entry.ok) return { ok: false, error: entry.reason || '发布失败' }
      if (request) {
        appendEvents(boardDir, [{ op: 'answer', id: request.id, by: author, replyId: entry.entry.id, ts: Date.now() }])
        try {
          runPendingQueue({ source: 'answer' })
        } catch {
          /* ignore */
        }
        if (request.author && request.author !== 'panel' && request.author !== author) {
          wakeSession(request.author, ['【群内请求已收到回复 · 来自维护者】', '请求：' + request.title, '回复：' + entry.entry.title + '：' + truncate(text, 300)].join('\n'), { requestId: request.id })
        }
      }
      logger.info('维护者发布 ' + KIND_CN[kind] + '：' + entry.entry.title)
      return { ok: true, id: entry.entry.id, title: entry.entry.title, kind, groupId: group ? group.id : '', answered: request ? request.id : '' }
    }
    if (action === 'maintainer.set') {
      const sessionId = String(payload.sessionId || '').trim()
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      const sessions = await buildSessionIndex()
      const target = sessions.find((session) => session.id === sessionId)
      if (!target) return { ok: false, error: '会话不在当前会话索引里' }
      const handleWanted = sanitizeHandle(payload.handle) || '星桥值班员'
      const avatar = isAvatar(payload.avatar) ? payload.avatar : '🛰️'
      const handle = uniqueHandle(handleWanted, sessionId)
      const style = PERSONA_STYLES.includes(String(payload.style || '')) ? String(payload.style) : '严谨'
      const persona = String(payload.persona || '盯着星桥，有 bug 先修再报').slice(0, 120)
      identityStore.set(sessionId, {
        handle,
        avatar,
        role: '维护者',
        skills: ['协调', '代码', '数据'],
        style,
        persona,
        updatedAt: Date.now()
      })
      maintainerStore.set(sessionId, { handle, avatar })
      try {
        mutateGroups((list) => {
          for (const group of list) {
            if (!group.sessionIds.includes(sessionId)) group.sessionIds.push(sessionId)
            group.updatedAt = Date.now()
          }
          return { ok: true }
        })
        logger.info('维护者已加入所有群组：' + handle)
      } catch {
        /* ignore */
      }
      try {
        const permissions = readPermissionsOf(boardDir)
        const grants = new Set(permissions.grants[sessionId] || [])
        for (const session of sessions) if (session.id !== sessionId) grants.add(session.id)
        permissions.grants[sessionId] = [...grants]
        writePermissionsOf(boardDir, permissions)
      } catch {
        /* ignore */
      }
      logger.info('维护者已注册：' + avatar + ' ' + handle + '（' + shortSid(sessionId) + '）')
      return { ok: true, sessionId, handle, avatar, role: '维护者', grants: (await buildSessionIndex()).length - 1 }
    }
    if (action === 'maintainer.get') {
      const sessionId = maintainerStore.get()
      const identity = sessionId ? identityOf(sessionId, identityTitleOf(sessionId)) : null
      return { ok: true, sessionId, identity }
    }
    if (action === 'health.check') {
      const report = await runHealthCheck({ alert: false })
      return { ok: true, report }
    }
    if (action === 'workspace.list') {
      const registry = (ctx.get && ctx.get('workspaceRegistry')) || ctx.workspaceRegistry
      if (!registry || typeof registry.list !== 'function') return { ok: false, error: '宿主不提供 workspaceRegistry' }
      const workspaces = registry.list().map((workspace) => ({
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
        sessionIds: workspace.sessionIds || []
      }))
      return { ok: true, count: workspaces.length, workspaces }
    }
    if (action === 'workspace.delete') {
      const registry = (ctx.get && ctx.get('workspaceRegistry')) || ctx.workspaceRegistry
      if (!registry) return { ok: false, error: '宿主不提供 workspaceRegistry' }
      const wantedId = String(payload.id || '').trim()
      const wantedPath = String(payload.path || '').trim()
      const list = typeof registry.list === 'function' ? registry.list() : []
      const target = list.find(
        (workspace) => workspace.id === wantedId || (wantedPath && workspace.path === wantedPath)
      )
      if (!target) return { ok: false, error: '找不到工作区' }
      try {
        if (typeof registry.deleteKnown === 'function') await registry.deleteKnown(target.id)
        else if (typeof registry.delete === 'function') await registry.delete(target.id)
        else return { ok: false, error: '宿主不支持删除工作区' }
      } catch (error) {
        return { ok: false, error: '删除失败：' + (error && error.message ? error.message : error) }
      }
      logger.info('已删除工作区：' + target.title + '（' + target.path + '）')
      return { ok: true, deleted: target.id, title: target.title, path: target.path }
    }
    if (action === 'workspace.recover') {
      const result = await recoverLostWorkspaces()
      backupWorkspaceRegistry()
      return { ok: true, ...result }
    }
    if (action === 'activity.spark') {
      const wanted = String(payload.id || '').trim()
      const groups = groupStore.read()
      const group = groups.find((item) => item.id === wanted || item.id.startsWith(wanted))
      if (!group) return { ok: false, error: '找不到群组' }
      const result = await startSparkForGroup(group, { force: true })
      return result.skipped ? { ok: false, error: result.reason } : result
    }
    if (action === 'activity.tea') {
      const wanted = String(payload.id || '').trim()
      const groups = groupStore.read()
      const group = groups.find((item) => item.id === wanted || item.id.startsWith(wanted))
      if (!group) return { ok: false, error: '找不到群组' }
      const result = await startTeaParty(group, { force: true })
      return result.skipped ? { ok: false, error: result.reason } : result
    }
    if (action === 'group.discuss') {
      const wanted = String(payload.id || '').trim()
      const topic = String(payload.topic || '').trim().slice(0, 400)
      const groups = groupStore.read()
      const group = groups.find((item) => item.id === wanted || item.id.startsWith(wanted))
      if (!group) return { ok: false, error: '找不到群组' }
      if (!topic) return { ok: false, error: '讨论主题不能为空' }
      const sessions = await buildSessionIndex()
      const byId = new Map(sessions.map((session) => [session.id, session]))
      let targets = group.sessionIds
        .filter((id) => id !== maintainerStore.get())
        .map((id) => byId.get(id))
        .filter(Boolean)
      const requested = Array.isArray(payload.mentionSessionIds)
        ? payload.mentionSessionIds.filter((item) => typeof item === 'string' && item)
        : []
      if (requested.length) targets = targets.filter((session) => requested.includes(session.id))
      addEntry(
        {
          title: '讨论：' + topic.slice(0, 20),
          text: topic,
          kind: 'chat',
          groupId: group.id,
          author: 'panel',
          origin: 'panel',
          mentions: targets.map((session) => session.id),
          tags: '@讨论',
          skipDedupe: true
        },
        'panel'
      )
      const contextLines = discussionContextOf(group.id, 4)
      const message = [
        '【讨论 · 用户发起（不是任务）】',
        topic,
        '',
        ...(contextLines.length ? ['最近群里聊到：', ...contextLines, ''] : []),
        '请接着聊：可以赞同/反驳上面某一句，并 @ 一位成员继续；2 句话以内，直接 session_share（kind=chat、group=' + group.name + '）发出来。不用交付文件，不想说可以不说。'
      ].join('\n')
      let woken = 0
      for (const target of targets) {
        await ensureSessionLive(target.id)
        if (wakeSession(target.id, message, {}).ok) woken += 1
      }
      logger.info('群「' + group.name + '」发起讨论，唤醒 ' + woken)
      return { ok: true, topic, targets: targets.length, woken }
    }
    if (action === 'group.manager') {
      const wanted = String(payload.id || '').trim()
      const groups = groupStore.read()
      const group = groups.find((item) => item.id === wanted || item.id.startsWith(wanted))
      if (!group) return { ok: false, error: '找不到群组' }
      let managerId = String(payload.managerId || '').trim()
      let created = null
      // 已有群管理时不要重复新建（之前点三次建了三个管理会话）。
      if (payload.create === true && group.managerSessionId) {
        const existing = ctx.agents && ctx.agents.get ? ctx.agents.get(group.managerSessionId) : undefined
        if (existing || group.sessionIds.indexOf(group.managerSessionId) >= 0) {
          return {
            ok: true,
            existing: true,
            groupId: group.id,
            managerSessionId: group.managerSessionId,
            message: '该群已有群管理，未重复创建。'
          }
        }
      }
      if (payload.create === true) {
        const createdSession = await createSessionForTask(group.workspace || undefined, `群管理：${group.name}`)
        if (!createdSession.ok) return { ok: false, error: `新建群管理会话失败：${createdSession.error}` }
        managerId = createdSession.sessionId
        created = managerId
        silentNewSessions.add(managerId)
        writeProfileOf(boardDir, managerId, {
          sessionId: managerId,
          summary: `群「${group.name}」的群管理：负责复核后把需要修改的项指派给合适成员并跟进，不亲自改稿。`,
          direction: '群管理 / 任务分派 / 复核后修改跟进',
          assets: [],
          needs: '组长提交的复核结论与修改项',
          declined: false,
          updatedAt: Date.now()
        })
      }
      if (!managerId) {
        // 清空群管理
        return mutateGroups((list) => {
          const target = list.find((item) => item.id === group.id)
          if (!target) return { ok: false, error: '找不到群组' }
          target.managerSessionId = ''
          target.updatedAt = Date.now()
          return { ok: true, groupId: group.id, managerSessionId: '' }
        })
      }
      // 群管理自动成为群成员（这样会出现在成员列表/@ 列表里，用户可以直接 @ 它）。
      const memberIds = [...new Set([...group.sessionIds, managerId])]
      const result = mutateGroups((list) => {
        const target = list.find((item) => item.id === group.id)
        if (!target) return { ok: false, error: '找不到群组' }
        target.managerSessionId = managerId
        target.sessionIds = memberIds
        target.updatedAt = Date.now()
        return { ok: true, groupId: group.id, managerSessionId: managerId }
      })
      if (!result.ok) return result
      // 群管理自动获得唤醒/提醒全体成员的权限（用于指派修改）。
      try {
        const permissions = readPermissionsOf(boardDir)
        const grants = new Set(permissions.grants[managerId] || [])
        for (const sessionId of memberIds) {
          if (sessionId !== managerId) grants.add(sessionId)
        }
        permissions.grants[managerId] = [...grants]
        writePermissionsOf(boardDir, permissions)
      } catch {
        /* 授权失败不阻塞设置 */
      }
      const intro = [
        `【群管理 · 已上岗】你是群组「${group.name}」的群管理。`,
        '职责：**只在确有「未完成/未指派、需要继续推进」的事项时介入**——把需要修改的项拆解并指派给合适成员（session_ask mode=task），跟进完成；不要亲自改稿，也不要替组长汇总。',
        '普通汇报、已完成、已定稿、已经有人在做的，**不要回复、不要凑热闹**；没有实质动作就安静结束。',
        '群规矩默认用 **group_rule action=replace 整体重建**：先合并去重现有规矩，再一次性提交一份完整列表（≤5 条，口径/做法/禁忌）；不要用 set 一条条堆叠，更不要把聊天记录/交接/催收原文写进规矩。',
        '让群更有活力：偶尔（每天最多一次）用 session_discuss 发起一个轻量讨论；讨论里要接前面的话并 @ 成员继续；看到成员表现好用 session_like 点赞 +2 积分。不要刷屏，没内容就不发。',
        '组内缺人或角色不合适时，可用 group_member 拉人/踢人（自己判断需要谁，不必等人安排）。',
        '遇到「没权限 / 需要落文件 / 需要沉淀技能」不要停下：① 心得/流程直接用 group_skill 写入星桥技能库（不需要工作区权限）；② 项目内文件用 session_ask mode=task 找有写盘权限的成员，写清文件路径、内容、验收口径；③ 不知道找谁先 session_profile action=directory 看申报。要像活人一样主动交涉、追问、跟进，不要一句“没权限”就放弃。',
        '收到探测消息时只看正文、简短响应；没有实质动作就不要回复。'
      ].join('\n')
      const kickoff = Boolean(created) || payload.kickoff === true
      if (kickoff) {
        const recent = store
          .readActive()
          .filter((entry) => entry.groupId === group.id && entry.hiddenFromChat !== true)
          .sort((a, b) => (b.ts || 0) - (a.ts || 0))
          .slice(0, 6)
        const kickoffText = [
          '【探测 · 群管理介入】',
          '需要你做的（只做这一件）：只挑**仍未完成/未指派**的事项分给合适成员；若没有就什么都不做。',
          '',
          '群近况（只作判断依据，不要逐条分析）：',
          ...recent.map((entry) => `- [${KIND_CN[entry.kind] || entry.kind}] ${entry.title}`),
          '',
          '（可选）若这一轮确实收尾了，再用 group_rule action=replace 提交去重后的完整规矩；有可复用流程就用 group_skill 沉淀 SKILL；没有实质动作就不要回复、不要发消息。'
        ].join('\n')
        ;(async () => {
          await ensureSessionLive(managerId)
          wakeSession(managerId, kickoffText, {})
        })()
      }
      logger.info(`群「${group.name}」设置群管理：${shortSid(managerId)}${created ? '（新建）' : ''}${kickoff ? '，已唤醒介入' : ''}`)
      return { ok: true, groupId: group.id, managerSessionId: managerId, created, kickedOff: kickoff }
    }
    if (action === 'group.update' || action === 'group.rename') {
      const wanted = String(payload.id || '').trim()
      const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 40) : ''
      const hasGoal = typeof payload.goal === 'string'
      const goal = hasGoal ? payload.goal.trim().slice(0, 300) : ''
      if (action === 'group.rename' && !name) return { ok: false, error: '群名不能为空' }
      if (action === 'group.update' && !name && !hasGoal) return { ok: false, error: '没有要更新的字段' }
      return mutateGroups((groups) => {
        const group = groups.find((item) => item.id === wanted || item.id.startsWith(wanted))
        if (!group) return { ok: false, error: '找不到群组' }
        if (name) group.name = name
        if (hasGoal) group.goal = goal
        group.updatedAt = Date.now()
        return { ok: true, groupId: group.id }
      })
    }
    if (action === 'group.delete') {
      const wanted = String(payload.id || '').trim()
      const groups = groupStore.read()
      const group = groups.find((item) => item.id === wanted || item.id.startsWith(wanted))
      if (!group) return { ok: false, error: '找不到群组' }
      groupStore.write(groups.filter((item) => item.id !== group.id))
      // 群解散后，原本发到群里的规矩退回工作区作用域。
      for (const rule of store.readActive()) {
        if (rule.groupId !== group.id) continue
        appendEvents(boardDir, [
          {
            op: 'retarget',
            id: rule.id,
            groupId: null,
            scope: rule.scope === 'global' ? 'global' : 'workspace',
            ts: Date.now()
          }
        ])
      }
      logger.info(`删除群组 ${group.id}「${group.name}」（来自面板）`)
      return { ok: true }
    }
    if (action === 'group.add' || action === 'group.remove') {
      const wanted = String(payload.id || '').trim()
      const refs = Array.isArray(payload.sessionIds)
        ? payload.sessionIds.filter((item) => typeof item === 'string' && item)
        : payload.sessionId
          ? [String(payload.sessionId)]
          : []
      if (!refs.length) return { ok: false, error: '缺少会话 id' }
      // 面板可能传 contactId / 短 id / handle（从通讯录复制），统一解析成完整 id；
      // 解析不了的引用直接报错、不改群组，避免把错的人拉进群。
      let sessionIds = refs
      try {
        const sessionsNow = await buildSessionIndex()
        if (sessionsNow.length) {
          const resolved = []
          const problems = []
          for (const ref of refs) {
            const outcome = resolveSessionRef(ref, sessionsNow)
            if (outcome.ok) resolved.push(outcome.session.id)
            else if (/^session-[0-9a-z-]{6,}$/i.test(ref)) resolved.push(ref)
            else problems.push(outcome.error)
          }
          if (problems.length) {
            return {
              ok: false,
              error: ['成员引用解析失败，本次未做任何改动：', ...problems, '可用 session_directory 查 contactId。'].join('\n')
            }
          }
          sessionIds = [...new Set(resolved)]
        }
      } catch {
        sessionIds = refs
      }
      let affectedGroup = null
      let addedSessionIds = []
      let removedSessionIds = []
      const result = mutateGroups((groups) => {
        const group = groups.find((item) => item.id === wanted || item.id.startsWith(wanted))
        if (!group) return { ok: false, error: '找不到群组' }
        if (action === 'group.add') {
          const before = new Set(group.sessionIds)
          group.sessionIds = [...new Set([...group.sessionIds, ...sessionIds])]
          addedSessionIds = group.sessionIds.filter((sessionId) => !before.has(sessionId))
          affectedGroup = { id: group.id, name: group.name, managerSessionId: group.managerSessionId || '' }
        } else {
          const before = new Set(group.sessionIds)
          group.sessionIds = group.sessionIds.filter((id) => !sessionIds.includes(id))
          removedSessionIds = [...before].filter((sessionId) => !group.sessionIds.includes(sessionId))
          affectedGroup = { id: group.id, name: group.name }
        }
        group.updatedAt = Date.now()
        return { ok: true, groupId: group.id }
      })
      if (result.ok && affectedGroup) {
        try {
          const sessionsNow = await buildSessionIndex()
          const titleOf = (sessionId) => {
            const hit = sessionsNow.find((session) => session.id === sessionId)
            return (hit && (hit.handle || hit.title)) || shortSid(sessionId)
          }
          if (addedSessionIds.length) {
            addEntry(
              {
                title: '新成员入群：' + addedSessionIds.map(titleOf).join('、'),
                text: '邀请 ' + addedSessionIds.map(titleOf).join('、') + ' 加入群「' + affectedGroup.name + '」。',
                kind: 'chat',
                groupId: affectedGroup.id,
                author: 'panel',
                origin: 'panel',
                mentions: addedSessionIds,
                tags: '@系统',
                skipDedupe: true
              },
              'panel'
            )
          }
          if (removedSessionIds.length) {
            addEntry(
              {
                title: '成员移出群：' + removedSessionIds.map(titleOf).join('、'),
                text: '已将 ' + removedSessionIds.map(titleOf).join('、') + ' 移出群「' + affectedGroup.name + '」。',
                kind: 'chat',
                groupId: affectedGroup.id,
                author: 'panel',
                origin: 'panel',
                mentions: removedSessionIds,
                tags: '@系统',
                skipDedupe: true
              },
              'panel'
            )
          }
        } catch {
          /* ignore */
        }
      }
      if (action === 'group.add' && result.ok && affectedGroup && addedSessionIds.length) {
        try {
          requestMemberProfiles(affectedGroup, addedSessionIds)
        } catch (error) {
          logger.warn(`入群申报触发失败：${error && error.message ? error.message : error}`)
        }
        // 新成员也加入群管理的可唤醒名单。
        try {
          if (affectedGroup.managerSessionId) {
            const permissions = readPermissionsOf(boardDir)
            const grants = new Set(permissions.grants[affectedGroup.managerSessionId] || [])
            for (const sessionId of addedSessionIds) grants.add(sessionId)
            permissions.grants[affectedGroup.managerSessionId] = [...grants]
            writePermissionsOf(boardDir, permissions)
          }
        } catch {
          /* ignore */
        }
      }
      return result
    }
    return { ok: false, error: `未知操作：${action || '(空)'}` }
  }

  const handleAppRoute = async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method-not-allowed')
      return
    }
    const candidates = [
      path.resolve(HERE, '..', 'app.html'),
      path.join(HERE, 'app.html'),
      path.resolve(HERE, '..', 'dsh-plugin', 'app.html')
    ]
    const file = candidates.find((candidate) => fs.existsSync(candidate))
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('app.html not found')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(fs.readFileSync(file, 'utf8'))
  }

  const runOfficePreview = (file) => new Promise((resolve) => {
    const candidates = [
      path.resolve(HERE, '..', 'preview.py'),
      path.join(HERE, 'preview.py'),
      path.resolve(HERE, '..', 'dsh-plugin', 'preview.py')
    ]
    const script = candidates.find((candidate) => fs.existsSync(candidate))
    if (!script) {
      resolve('')
      return
    }
    try {
      execFile(
        process.env.PYTHON || 'python',
        [script, file],
        { timeout: 25000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (error, stdout) => {
          if (error && !stdout) {
            resolve('<div style="font:14px sans-serif;color:#a33">预览失败：' + String(error.message || error) + '</div>')
            return
          }
          resolve(String(stdout || ''))
        }
      )
    } catch (error) {
      resolve('<div style="font:14px sans-serif;color:#a33">预览失败：' + String(error.message || error) + '</div>')
    }
  })

  const handleFileRoute = async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method-not-allowed')
      return
    }
    try {
      const requestUrl = new URL(req.url, 'http://127.0.0.1')
      const wanted = String(requestUrl.searchParams.get('path') || '').trim()
      if (!wanted) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('missing path')
        return
      }
      let targetFile = ''
      const groupsForFile = groupStore.read()
      for (const entry of store.readActive()) {
        for (const file of entry.files || []) {
          const raw = String(file || '')
          const matches = raw === wanted || path.resolve(raw) === path.resolve(wanted) || raw.endsWith(wanted)
          if (!matches) continue
          const candidates = [raw]
          if (entry.workspace) candidates.push(path.join(entry.workspace, raw))
          const entryGroup = entry.groupId ? groupsForFile.find((group) => group.id === entry.groupId) : null
          if (entryGroup && entryGroup.workspace) candidates.push(path.join(entryGroup.workspace, raw))
          const fallbackCwd = defaultWorkspaceForRule()
          if (fallbackCwd) candidates.push(path.join(fallbackCwd, raw))
          const existing = candidates
            .map((candidate) => {
              try {
                return path.resolve(candidate)
              } catch {
                return ''
              }
            })
            .find((candidate) => candidate && fs.existsSync(candidate))
          if (existing) {
            targetFile = existing
            break
          }
        }
        if (targetFile) break
      }
      if (!targetFile) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('file not referenced by any board entry')
        return
      }
      const normalized = targetFile
      let stat
      try {
        stat = fs.statSync(normalized)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('file not found')
        return
      }
      if (!stat.isFile() || stat.size > 30 * 1024 * 1024) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('file too large or not a regular file')
        return
      }
      const ext = path.extname(normalized).toLowerCase()
      if (['.docx', '.xlsx', '.pptx'].includes(ext)) {
        const html = await runOfficePreview(normalized)
        if (html) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(html)
          return
        }
        res.writeHead(415, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Office preview unavailable: preview.py/Python missing')
        return
      }
      const types = {
        '.txt': 'text/plain; charset=utf-8',
        '.md': 'text/markdown; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.jsonl': 'application/jsonlines; charset=utf-8',
        '.log': 'text/plain; charset=utf-8',
        '.csv': 'text/csv; charset=utf-8',
        '.py': 'text/plain; charset=utf-8',
        '.js': 'text/plain; charset=utf-8',
        '.mjs': 'text/plain; charset=utf-8',
        '.ts': 'text/plain; charset=utf-8',
        '.tex': 'text/plain; charset=utf-8',
        '.yaml': 'text/plain; charset=utf-8',
        '.yml': 'text/plain; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf'
      }
      res.writeHead(200, {
        'content-type': types[ext] || 'application/octet-stream',
        'content-disposition': 'inline; filename="' + encodeURIComponent(path.basename(normalized)) + '"',
        'cache-control': 'no-store'
      })
      res.end(fs.readFileSync(normalized))
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('file preview failed: ' + (error && error.message ? error.message : error))
    }
  }

  const handleStateRoute = async (req, res) => {
    try {
      if (req.method !== 'GET') return jsonOut(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isLoopbackCaller(req)) return jsonOut(res, 403, { ok: false, error: 'forbidden' })
      jsonOut(res, 200, await stateForUi())
    } catch (error) {
      logger.warn(`读取看板状态失败：${error && error.message ? error.message : error}`)
      jsonOut(res, 500, { ok: false, error: 'state-failed' })
    }
  }

  const discussionContextOf = (groupId, limit) => {
    try {
      const sessionsNow = stateSessionsCache || []
      const byId = new Map(sessionsNow.map((session) => [session.id, session]))
      return store
        .readActive()
        .filter((entry) => entry.groupId === groupId && entry.kind === 'chat' && entry.hiddenFromChat !== true)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, limit || 4)
        .map((entry) => {
          const who = byId.get(entry.author)
          const handle = entry.author === 'panel' ? '用户' : who && who.handle ? who.handle : shortSid(entry.author)
          return '- ' + handle + '：' + truncate(String(entry.text || entry.title || '').replace(/\s*\n\s*/g, ' / '), 100)
        })
    } catch {
      return []
    }
  }
  const stateSessionsCache = []
  const handleCommandRoute = async (req, res) => {
    try {
      if (req.method !== 'POST') return jsonOut(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isLoopbackCaller(req)) return jsonOut(res, 403, { ok: false, error: 'forbidden' })
      const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].toLowerCase() : ''
      if (!contentType.startsWith('application/json') || req.headers['x-session-bridge-action'] !== '1') {
        return jsonOut(res, 403, { ok: false, error: 'forbidden-action' })
      }
      let body = ''
      try {
        body = await readRequestBody(req)
      } catch {
        return jsonOut(res, 413, { ok: false, error: 'body-too-large' })
      }
      let command
      try {
        command = JSON.parse(body || '{}')
      } catch {
        return jsonOut(res, 400, { ok: false, error: 'invalid-json' })
      }
      const result = await executeCommand(command)
      if (!result || result.ok !== true) {
        return jsonOut(res, 400, { ok: false, error: (result && result.error) || 'command-failed', state: await stateForUi() })
      }
      const response = { ...result, ok: true, state: await stateForUi() }
      // group.suggest / group.post 等命令把额外结果一并带回（客户端不需要再多发一次请求）。
      return jsonOut(res, 200, response)
    } catch (error) {
      logger.warn(`看板命令执行失败：${error && error.message ? error.message : error}`)
      jsonOut(res, 500, { ok: false, error: 'command-failed', detail: String(error && error.message || error).slice(0, 200) })
    }
  }

  // webServer 在冷启动时可能比本插件晚就绪：轮询等待并重试注册，否则重启后看板 API 会 404。
  let webServerTimer = null
  let webServerAttempts = 0
  const patchReceiptApi = () => {
    try {
      const receiptPath = path.join(boardDir, LOADED_FILE)
      if (!fs.existsSync(receiptPath)) return
      const current = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
      current.registration = registration
      if (current.panel) current.panel.api = registration.api
      fs.writeFileSync(receiptPath, JSON.stringify(current, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
  }
  const registerWebServer = () => {
    if (registration.api) return
    webServerAttempts += 1
    try {
      const webServer = ctx.get ? ctx.get('webServer') : undefined
      if (webServer && typeof webServer.register === 'function') {
        ctx.effect(
          () => webServer.register({ kind: 'exact', path: '/api/session-bridge/state', handler: handleStateRoute }),
          'session-bridge: GET /api/session-bridge/state'
        )
        ctx.effect(
          () => webServer.register({ kind: 'exact', path: '/api/session-bridge/command', handler: handleCommandRoute }),
          'session-bridge: POST /api/session-bridge/command'
        )
        ctx.effect(
          () => webServer.register({ kind: 'exact', path: '/session-bridge/app', handler: handleAppRoute }),
          'session-bridge: GET /session-bridge/app'
        )
        ctx.effect(
          () => webServer.register({ kind: 'exact', path: '/session-bridge/file', handler: handleFileRoute }),
          'session-bridge: GET /session-bridge/file'
        )
        registration.api = true
        registration.webServer = true
        logger.info('看板 HTTP API 已注册：/api/session-bridge/state、/api/session-bridge/command、/session-bridge/app、/session-bridge/file')
        patchReceiptApi()
        return
      }
    } catch (error) {
      logger.warn(`注册看板 HTTP API 失败：${error && error.message ? error.message : error}`)
    }
    if (webServerAttempts === 1 || webServerAttempts % 20 === 0) {
      logger.info(`webServer 尚未就绪，等待重试注册 API（第 ${webServerAttempts} 次）`)
    }
    if (webServerAttempts < 240) {
      webServerTimer = setTimeout(registerWebServer, 500)
      if (webServerTimer && typeof webServerTimer.unref === 'function') webServerTimer.unref()
    } else {
      logger.warn('webServer 服务在 2 分钟内仍不可用：看板 API 未注册')
    }
  }
  registerWebServer()
  try {
    ctx.effect(
      () => () => {
        if (webServerTimer) clearTimeout(webServerTimer)
      },
      'session-bridge: api retry timer'
    )
  } catch {
    /* ignore */
  }

  // 一次性迁移：把「现有群组」接入申报流程（唤醒在线成员提交申报；离线成员下次运行看到提示）。
  try {
    const bootstrapFlag = path.join(boardDir, PROFILE_BOOTSTRAP_FILE)
    if (!fs.existsSync(bootstrapFlag)) {
      const groups = groupStore.read()
      let woken = 0
      const requested = new Set()
      for (const group of groups) {
        for (const sessionId of group.sessionIds) {
          if (requested.has(sessionId)) continue
          requested.add(sessionId)
          const profile = ownProfileOf(sessionId)
          if (profile && (profile.summary || profile.declined)) continue
          const outcome = wakeSession(sessionId, PROFILE_REQUEST_TEXT(group.name), { profileRequest: group.id })
          if (outcome.ok) woken += 1
        }
      }
      fs.writeFileSync(
        bootstrapFlag,
        JSON.stringify(
          { at: new Date().toISOString(), groups: groups.length, requested: requested.size, woken },
          null,
          2
        ),
        'utf8'
      )
      logger.info(`现有群组申报引导完成：${groups.length} 个群组、${requested.size} 个成员、唤醒 ${woken} 个`)
    }
  } catch (error) {
    logger.warn(`现有群组申报引导失败：${error && error.message ? error.message : error}`)
  }

  // 一次性迁移 + 常驻兜底：把「世界任务/群管理」提到、但没挂到 Workspace 的会话补挂回去，
  // 否则它们只存在于 session store，侧栏看不见，像是“任务消失了”。
  setTimeout(() => {
    ;(async () => {
      try {
        const registry = (ctx.get && ctx.get('workspaceRegistry')) || ctx.workspaceRegistry
        if (!registry || typeof registry.resolveByPath !== 'function') return
        const sessions = await buildSessionIndex()
        const byId = new Map(sessions.map((session) => [session.id, session]))
        const wanted = new Set()
        for (const entry of worldEntriesOf()) {
          for (const sessionId of entry.mentions || []) wanted.add(sessionId)
        }
        for (const group of groupStore.read()) {
          if (group.managerSessionId) wanted.add(group.managerSessionId)
        }
        let attached = 0
        for (const sessionId of wanted) {
          const info = byId.get(sessionId)
          if (!info || !info.cwd) continue
          try {
            const workspace = await registry.resolveByPath(info.cwd)
            if (workspace && typeof workspace.attachSession === 'function') {
              await workspace.attachSession(sessionId)
              attached += 1
            }
          } catch {
            /* 单个失败不影响其他 */
          }
        }
        if (attached) logger.info(`世界/群管理会话补挂工作区完成：${attached} 个`)
      } catch (error) {
        logger.warn(`会话补挂工作区失败：${error && error.message ? error.message : error}`)
      }
    })()
  }, 3000)

  // 群管理会话保持在线：history 的群管理会在侧栏“消失”、也收不到唤醒；启动时自动恢复+挂工作区+补标题。
  setTimeout(async () => {
    try {
      const registry = (ctx.get && ctx.get('workspaceRegistry')) || ctx.workspaceRegistry
      const groups = groupStore.read()
      const titles = (ctx.get && ctx.get('sessionTitle')) || ctx.sessionTitle
      const sessions = await buildSessionIndex()
      const byId = new Map(sessions.map((session) => [session.id, session]))
      let revived = 0
      for (const group of groups) {
        const managerId = group.managerSessionId
        if (!managerId) continue
        const before = ctx.agents.get ? ctx.agents.get(managerId) : undefined
        const agent = before || (await ensureSessionLive(managerId))
        if (!before && agent) revived += 1
        const info = byId.get(managerId) || (agent ? sessionInfoOf(agent) : null)
        if (info && info.cwd && registry && typeof registry.resolveByPath === 'function') {
          try {
            const workspace = await registry.resolveByPath(info.cwd)
            if (workspace && typeof workspace.attachSession === 'function') await workspace.attachSession(managerId)
          } catch {
            /* ignore */
          }
        }
        if (agent && titles && typeof titles.rename === 'function') {
          try {
            const snapshot = titles.get(agent.session)
            const raw = snapshot && snapshot.title ? String(snapshot.title) : ''
            if (!raw || /^mw[0-9a-z]+$/i.test(raw)) titles.rename(agent.session, '群管理：' + group.name)
          } catch {
            /* ignore */
          }
        }
      }
      logger.info('群管理会话保持在线：' + (revived ? '恢复 ' + revived + ' 个' : '检查完成'))
    } catch (error) {
      logger.warn('群管理会话保持在线失败：' + (error && error.message ? error.message : error))
    }
  }, 4000)

  // 工作区自愈：DSH 的 workspace.json 里丢了条目时，会话文件其实还在磁盘上；
  // 从会话存储读回 cwd，把缺失的工作区重新创建并 attach 会话。同时每次加载备份 workspace.json。
  const backupWorkspaceRegistry = () => {
    try {
      const source = path.join(resolveDshHome(), 'storages', 'workspace.json')
      if (!fs.existsSync(source)) return ''
      const backupDir = path.join(boardDir, 'backups')
      ensureDir(backupDir)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const target = path.join(backupDir, 'workspace-' + stamp + '.json')
      fs.copyFileSync(source, target)
      const backups = fs
        .readdirSync(backupDir)
        .filter((name) => name.startsWith('workspace-') && name.endsWith('.json'))
        .sort()
      while (backups.length > 12) {
        const old = backups.shift()
        try {
          fs.unlinkSync(path.join(backupDir, old))
        } catch {
          /* ignore */
        }
      }
      return target
    } catch {
      return ''
    }
  }
  const readSessionHeader = (file) => {
    try {
      const buffer = fs.readFileSync(file)
      const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
      const start = buffer.indexOf(magic)
      if (start < 0) return null
      const next = buffer.indexOf(magic, start + 4)
      const chunk = buffer.subarray(start, next > 0 ? next : buffer.length)
      const text = zlib.zstdDecompressSync(chunk).toString('utf8')
      const first = text.split(/\r?\n/).find((line) => line.trim())
      return first ? JSON.parse(first) : null
    } catch {
      return null
    }
  }
  const recoverLostWorkspaces = async () => {
    const registry = (ctx.get && ctx.get('workspaceRegistry')) || ctx.workspaceRegistry
    if (!registry || typeof registry.create !== 'function') return { created: 0, attached: 0 }
    const sessionsRoot = path.join(resolveDshHome(), 'sessions')
    if (!fs.existsSync(sessionsRoot)) return { created: 0, attached: 0 }
    let existing = []
    try {
      existing = typeof registry.list === 'function' ? registry.list() : []
    } catch {
      existing = []
    }
    const knownPaths = new Set(existing.map((workspace) => workspace.path))
    const byCwd = new Map()
    const cutoff = Date.now() - 120 * 24 * 3600 * 1000
    for (const dirName of fs.readdirSync(sessionsRoot)) {
      const dir = path.join(sessionsRoot, dirName)
      let entries = []
      try {
        entries = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const entry of entries) {
        const file = path.join(dir, entry, 'session.v4.jsonl.zstd')
        if (!fs.existsSync(file)) continue
        const header = readSessionHeader(file)
        if (!header || typeof header.cwd !== 'string' || !header.cwd) continue
        const cwd = header.cwd
        if (knownPaths.has(cwd)) continue
        if (!fs.existsSync(cwd)) continue
        if (/[\\/]temp[\\/]|\\Temp\\|\\AppData\\Local\\Temp/i.test(cwd)) continue
        if (toNumber(header.createdAt, 0) < cutoff) continue
        const bucket = byCwd.get(cwd) || []
        if (header.id) bucket.push(header.id)
        byCwd.set(cwd, bucket)
      }
    }
    let created = 0
    let attached = 0
    for (const [cwd, sessionIds] of byCwd.entries()) {
      try {
        const title = path.basename(cwd).replace(/-mw[0-9a-z]+$/i, '') || '恢复的工作区'
        const workspace = await registry.create(cwd, title)
        if (!workspace) continue
        created += 1
        for (const sessionId of sessionIds) {
          try {
            if (typeof workspace.attachSession === 'function') {
              await workspace.attachSession(sessionId)
              attached += 1
            }
          } catch {
            /* ignore */
          }
        }
      } catch (error) {
        logger.warn('恢复工作区失败 ' + cwd + '：' + (error && error.message ? error.message : error))
      }
    }
    if (created) logger.warn('工作区自愈：从会话存储恢复了 ' + created + ' 个工作区、挂回 ' + attached + ' 个会话')
    return { created, attached }
  }
  // 只做备份，不再自动恢复：用户手动删除的工作区不应被插件复活。
  // 需要从会话存储恢复时，用命令 workspace.recover。
  backupWorkspaceRegistry()
  const workspaceBackupTimer = setInterval(() => {
    try {
      backupWorkspaceRegistry()
    } catch {
      /* ignore */
    }
  }, 30 * 60 * 1000)
  if (workspaceBackupTimer && typeof workspaceBackupTimer.unref === 'function') workspaceBackupTimer.unref()
  try {
    ctx.effect(() => () => clearInterval(workspaceBackupTimer), 'session-bridge: workspace backup timer')
  } catch {
    /* ignore */
  }

  // 每天 10 点茶话会（每个群每天一次，只有成员≥2 才开）。
  const teaTimer = setInterval(() => {
    try {
      if (new Date().getHours() !== 10) return
      for (const group of groupStore.read()) {
        void startTeaParty(group, {})
      }
    } catch (error) {
      logger.warn('茶话会定时任务失败：' + (error && error.message ? error.message : error))
    }
  }, 10 * 60 * 1000)
  if (teaTimer && typeof teaTimer.unref === 'function') teaTimer.unref()
  try {
    ctx.effect(
      () => () => clearInterval(teaTimer),
      'session-bridge: tea timer'
    )
  } catch {
    /* ignore */
  }

  // 自发表达：每 4 小时左右挑一位成员“可选闲聊”一次（10:00-22:00）。
  const sparkTimer = setInterval(() => {
    try {
      const hour = new Date().getHours()
      if (hour < 10 || hour > 22) return
      for (const group of groupStore.read()) {
        void startSparkForGroup(group, {})
      }
    } catch (error) {
      logger.warn('自发表达定时任务失败：' + (error && error.message ? error.message : error))
    }
  }, 60 * 60 * 1000)
  if (sparkTimer && typeof sparkTimer.unref === 'function') sparkTimer.unref()
  try {
    ctx.effect(() => () => clearInterval(sparkTimer), 'session-bridge: spark timer')
  } catch {
    /* ignore */
  }

  // ---------------------------------------------------------------- 维护者 / 健康巡检
  const healthFile = path.join(boardDir, 'health.json')
  let lastHealthAlertAt = 0
  const taskRetryAt = new Map()
  const runHealthCheck = async (options = {}) => {
    const issues = []
    const fixes = []
    try {
      // HTTP API 掉线时尝试重注册（冷启动晚就绪兜底）
      if (!registration.api && typeof registerWebServer === 'function') {
        registerWebServer()
        if (registration.api) fixes.push('重新注册 HTTP API')
      }
      // 群管理在线状态
      const groups = groupStore.read()
      for (const group of groups) {
        const managerId = group.managerSessionId
        if (!managerId) {
          if (group.sessionIds.length < 2) continue
          try {
            const firstMember = group.sessionIds[0]
            const groupsToFix = groupStore.read()
            const targetGroup = groupsToFix.find((item) => item.id === group.id)
            if (targetGroup) {
              targetGroup.managerSessionId = firstMember
              targetGroup.updatedAt = Date.now()
              groupStore.write(groupsToFix)
            }
            const permissions = readPermissionsOf(boardDir)
            const grants = new Set(permissions.grants[firstMember] || [])
            for (const sessionId of group.sessionIds) if (sessionId !== firstMember) grants.add(sessionId)
            permissions.grants[firstMember] = [...grants]
            writePermissionsOf(boardDir, permissions)
            fixes.push('为群「' + group.name + '」自动指定 ' + shortSid(firstMember) + ' 为群管理并授权')
          } catch (error) {
            issues.push('群「' + group.name + '」没有群管理，自动补位失败：' + (error && error.message ? error.message : error))
          }
          continue
        }
        const existed = ctx.agents.get ? ctx.agents.get(managerId) : undefined
        const agent = existed || (await ensureSessionLive(managerId))
        if (!agent) {
          issues.push('群「' + group.name + '」的群管理离线且恢复失败')
          continue
        }
        if (!existed) fixes.push('恢复群管理 ' + shortSid(managerId) + ' 上线')
      }
      // 维护者在线 + 全局唤醒授权
      const maintainerId = maintainerStore.get()
      if (!maintainerId) issues.push('尚未设置维护者会话')
      else {
        const existed = ctx.agents.get ? ctx.agents.get(maintainerId) : undefined
        const agent = existed || (await ensureSessionLive(maintainerId))
        if (!agent) issues.push('维护者会话离线且恢复失败')
        else if (!existed) fixes.push('恢复维护者会话上线')
        try {
          mutateGroups((list) => {
            for (const group of list) {
              if (!group.sessionIds.includes(maintainerId)) {
                group.sessionIds.push(maintainerId)
                group.updatedAt = Date.now()
              }
            }
            return { ok: true }
          })
        } catch {
          /* ignore */
        }
        try {
          const sessions = await buildSessionIndex()
          const permissions = readPermissionsOf(boardDir)
          const grants = new Set(permissions.grants[maintainerId] || [])
          for (const session of sessions) if (session.id !== maintainerId) grants.add(session.id)
          const nextGrants = [...grants].sort()
          const prevGrants = [...(permissions.grants[maintainerId] || [])].sort()
          if (JSON.stringify(nextGrants) !== JSON.stringify(prevGrants)) {
            permissions.grants[maintainerId] = nextGrants
            writePermissionsOf(boardDir, permissions)
            fixes.push('更新维护者全局唤醒授权（' + nextGrants.length + ' 个会话）')
          }
        } catch {
          /* ignore */
        }
      }
      // 工作区目录可用性
      try {
        const registry = (ctx.get && ctx.get('workspaceRegistry')) || ctx.workspaceRegistry
        const workspaces = registry && typeof registry.list === 'function' ? registry.list() : []
        for (const workspace of workspaces) {
          if (workspace.path && !fs.existsSync(workspace.path)) {
            issues.push('工作区目录缺失：' + workspace.title + '（' + workspace.path + '）')
          }
        }
      } catch {
        /* ignore */
      }
      // 工作区备份新鲜度
      try {
        const backupDir = path.join(boardDir, 'backups')
        const latest = fs.existsSync(backupDir)
          ? fs.readdirSync(backupDir).filter((name) => name.startsWith('workspace-')).sort().pop()
          : null
        const latestAt = latest ? fs.statSync(path.join(backupDir, latest)).mtimeMs : 0
        if (Date.now() - latestAt > 24 * 3600 * 1000) {
          backupWorkspaceRegistry()
          fixes.push('刷新 workspace.json 备份')
        }
      } catch {
        /* ignore */
      }
      // 卡住的任务（> 6h 未完成）
      try {
        const tasks = store.readActive().filter((entry) => entry.kind === 'task' && (entry.taskStatus || 'assigned') !== 'done')
        for (const task of tasks) {
          const age = Date.now() - (task.ts || 0)
          if (age > 6 * 3600 * 1000) {
            issues.push('任务「' + truncate(task.title || task.id, 24) + '」超过 6 小时未完成')
          }
        }
      } catch {
        /* ignore */
      }
      // 未完成任务：目标会话掉线/异常关闭时，自动拉起并重试（每条请求+会话 20 分钟冷却，单次最多 3 个）。
      try {
        const sessionsHealth = await buildSessionIndex()
        const healthById = new Map(sessionsHealth.map((session) => [session.id, session]))
        const recentRequests = store
          .readActive()
          .filter(
            (entry) =>
              entry.kind === 'request' &&
              entry.status !== 'answered' &&
              !entry.answeredBy &&
              (entry.ts || 0) > Date.now() - 48 * 3600 * 1000 &&
              Array.isArray(entry.requestTo)
          )
          .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        let retried = 0
        for (const request of recentRequests) {
          if (retried >= 3) break
          for (const targetId of request.requestTo) {
            if (retried >= 3) break
            const cooldownKey = request.id + '|' + targetId
            if (Date.now() - (taskRetryAt.get(cooldownKey) || 0) < 20 * 60 * 1000) continue
            const targetSession = healthById.get(targetId)
            if (targetSession && targetSession.closed) {
              issues.push('任务「' + truncate(request.title || request.id, 24) + '」的目标会话已关闭，需人工处理')
              continue
            }
            const retryMessage = [
              '【任务恢复 · 掉线/中断重试】',
              '你有一个未完成的任务请求：' + (request.title || request.id),
              String(request.text || '').slice(0, 500),
              '',
              '系统已把会话拉起。请继续处理；确实无法完成请用 session_share（replyTo=' + request.id + '）说明原因。'
            ].join('\n')
            if (targetSession && targetSession.live) {
              const agent = ctx.agents.get ? ctx.agents.get(targetId) : undefined
              const requestAge = Date.now() - (request.ts || 0)
              if (agent && agent.status === 'idle' && requestAge > 20 * 60 * 1000) {
                wakeSession(targetId, retryMessage, { requestId: request.id })
                taskRetryAt.set(cooldownKey, Date.now())
                retried += 1
                fixes.push('任务「' + truncate(request.title || request.id, 20) + '」已提醒 ' + shortSid(targetId) + ' 重试')
              }
              continue
            }
            const revived = await ensureSessionLive(targetId)
            if (revived) {
              wakeSession(targetId, retryMessage, { requestId: request.id })
              taskRetryAt.set(cooldownKey, Date.now())
              retried += 1
              fixes.push('任务「' + truncate(request.title || request.id, 20) + '」已拉起 ' + shortSid(targetId) + ' 重试')
            } else {
              issues.push('任务「' + truncate(request.title || request.id, 24) + '」的成员 ' + shortSid(targetId) + ' 无法拉起')
            }
          }
        }
      } catch (error) {
        logger.warn('任务掉线重试失败：' + (error && error.message ? error.message : error))
      }
      // 日志近期警告数量
      try {
        const logFile = path.join(boardDir, 'session-bridge.log')
        if (fs.existsSync(logFile)) {
          const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).slice(-300)
          const warnings = lines.filter((line) => /\[warn\]|失败|error|unhandled/i.test(line)).length
          if (warnings > 25) issues.push('近期日志警告偏多（' + warnings + ' 条 / 300 行）')
        }
      } catch {
        /* ignore */
      }
      const report = {
        ts: Date.now(),
        ok: issues.length === 0,
        version: VERSION,
        issues,
        fixes,
        counts: { groups: groups.length }
      }
      try {
        fs.writeFileSync(healthFile, JSON.stringify(report, null, 2), 'utf8')
      } catch {
        /* ignore */
      }
      if (issues.length && options.alert !== false && maintainerId && Date.now() - lastHealthAlertAt > 30 * 60 * 1000) {
        lastHealthAlertAt = Date.now()
        try {
          await ensureSessionLive(maintainerId)
          const message = [
            '【星桥值班 · 健康巡检】发现 ' + issues.length + ' 个问题：',
            ...issues.slice(0, 8).map((issue) => '- ' + issue),
            '',
            '请检查并修复；修复后可用 health.check 复检。'
          ].join('\n')
          wakeSession(maintainerId, message, {})
        } catch {
          /* ignore */
        }
      }
      return report
    } catch (error) {
      logger.warn('健康巡检失败：' + (error && error.message ? error.message : error))
      return { ok: false, ts: Date.now(), issues: ['巡检异常：' + (error && error.message ? error.message : error)], fixes }
    }
  }
  const healthTimer = setInterval(() => {
    void runHealthCheck({})
  }, 5 * 60 * 1000)
  if (healthTimer && typeof healthTimer.unref === 'function') healthTimer.unref()
  try {
    ctx.effect(() => () => clearInterval(healthTimer), 'session-bridge: health timer')
  } catch {
    /* ignore */
  }
  setTimeout(() => { void runHealthCheck({ alert: false }) }, 20000).unref?.()

  // ---------------------------------------------------------------- 启动凭证
  // 注意：部署后 index.js 会被复制到 dsh-plugin/loaded/ 下执行，HERE 指向 loaded/，
  // 所以客户端入口要向上找一级（源码目录里的 client.js）。
  const clientBundle = [path.resolve(HERE, '..', 'client.js'), path.join(HERE, 'client.js')].find((candidate) =>
    fs.existsSync(candidate)
  )
  const loaded = {
    loadedAt: new Date().toISOString(),
    plugin: name,
    version: VERSION,
    hostPid: process.pid,
    boardDir,
    boardFile: path.join(boardDir, BOARD_FILE),
    groupsFile: path.join(boardDir, GROUPS_FILE),
    deliveriesFile: path.join(boardDir, DELIVERIES_FILE),
    config: { ...cfg },
    tools: registeredTools,
    failedTools,
    registration,
    capabilities: {
      /** 群内请求能否唤醒其它会话（依赖 @deepseek-ai/dsh-llm 的 UserMessage 构造器可解析）。 */
      wakeSessions: createUserMessage !== null
    },
    panel: {
      packageName: 'dsh-plugin-session-bridge',
      clientEntry: clientBundle || null,
      clientPresent: clientBundle !== undefined,
      api: registration.api
    }
  }
  try {
    fs.writeFileSync(path.join(boardDir, LOADED_FILE), JSON.stringify(loaded, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
  logger.info(
    `插件已加载 v${VERSION} · 看板 ${path.join(boardDir, BOARD_FILE)} · 工具 ${registeredTools.join(', ') || '(无)'} · 说明段=${registration.section} · 上下文=${registration.context} · API=${registration.api} · 面板入口=${loaded.panel.clientPresent ? '存在' : '缺失'}`
  )
  if (ctx.logger && typeof ctx.logger.info === 'function') {
    ctx.logger.info(`[session-bridge] 已加载 v${VERSION}，看板：${path.join(boardDir, BOARD_FILE)}`)
  }
}
