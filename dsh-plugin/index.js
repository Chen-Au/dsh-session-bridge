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

const VERSION = '4.3.3'
const BOARD_FILE = 'board.jsonl'
const GROUPS_FILE = 'groups.json'
const DELIVERIES_FILE = 'deliveries.jsonl'
/** 串行指令队列（依赖未满足/延迟未到的 session_ask），插件重启后从这里恢复。 */
const PENDING_FILE = 'pending-asks.json'
const PENDING_MAX_ITEMS = 100
/** 排队超过这个时间还没等到前置完成就判过期，避免无限等待。 */
const PENDING_TTL_MS = 48 * 3600 * 1000
const REPUTATION_FILE = 'reputation.json'
// session_ask 正文上限：显式报错，不静默截断；看板入库上限必须不小于它。
const ASK_TEXT_LIMIT = 8000
const BOARD_TEXT_LIMIT = 12000
const CHAT_TEXT_LIMIT = 240
const IDENTITY_FILE = 'identities.json'
const INBOX_ACK_FILE = 'inbox-ack.json'
function createInboxAckStore(dir) {
  const file = path.join(dir, INBOX_ACK_FILE)
  const empty = () => ({ version: 1, acks: {} })
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const data = raw && typeof raw === 'object' ? raw : empty()
      if (!data.acks || typeof data.acks !== 'object') data.acks = {}
      return data
    } catch { return empty() }
  }
  const write = (data) => {
    ensureDir(dir)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }
  return { read, write, file }
}

const COUNCIL_FILE = 'council.json'
function createCouncilStore(dir) {
  const file = path.join(dir, COUNCIL_FILE)
  const empty = () => ({ version: 1, groupId: '', members: [], chair: '', createdAt: 0, updatedAt: 0 })
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const data = raw && typeof raw === 'object' ? raw : empty()
      if (!Array.isArray(data.members)) data.members = []
      return data
    } catch { return empty() }
  }
  const write = (data) => {
    ensureDir(dir)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ ...data, updatedAt: Date.now() }, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }
  return { read, write, file }
}

const PAUSE_FILE = 'pauses.json'
function createPauseStore(dir) {
  const file = path.join(dir, PAUSE_FILE)
  const empty = () => ({ version: 1, sessions: {}, tasks: {}, requests: {} })
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const data = raw && typeof raw === 'object' ? raw : empty()
      for (const key of ['sessions', 'tasks', 'requests']) if (!data[key] || typeof data[key] !== 'object') data[key] = {}
      return data
    } catch { return empty() }
  }
  const write = (data) => {
    ensureDir(dir)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }
  const set = (kind, id, patch) => {
    const data = read()
    data[kind][id] = { ...(data[kind][id] || {}), ...patch, pausedAt: Date.now() }
    write(data)
    return data[kind][id]
  }
  const remove = (kind, id) => { const data = read(); delete data[kind][id]; write(data) }
  const get = (kind, id) => read()[kind][id] || null
  const isPaused = (kind, id) => Boolean(get(kind, id))
  return { read, write, set, remove, get, isPaused, file }
}

const OFFICE_FILE = 'offices.json'
const OFFICE_PROMOTION_RULES = [
  { from: '专员', to: '部门主管', merit: 40, completed: 3, successes: 2, auto: true, privileges: ['可发起招募', '可审批转交', '任务优先当组长'] },
  { from: '部门主管', to: '首席技术员', merit: 120, completed: 8, likes: 4, auto: false, privileges: ['技术任务优先接手', '可审批转交', '可发起跨组技术复核'] },
  { from: '首席技术员', to: '运维总管', merit: 200, completed: 15, auto: false, privileges: ['维护者级暂停/恢复', '跨组异常处置'] }
]

const OFFICE_CATALOG = [
  { id: 'owner', name: '星桥主理人', level: 100, description: '用户本人，星桥最高决策者' },
  { id: 'ops', name: '运维总管', level: 90, description: '维护者/值班员，负责修 bug 与环境运维' },
  { id: 'cto', name: '首席技术员', level: 80, description: '技术负责人，可处理高优先级技术问题' },
  { id: 'dept', name: '部门主管', level: 60, description: '群管理/部门负责人，负责拆解与分派' },
  { id: 'member', name: '专员', level: 10, description: '普通成员，按 scope 执行任务' }
]
const PROFILES_DIR = 'profiles'
const PROFILE_BOOTSTRAP_FILE = '.profile-bootstrap.json'
const LOADED_FILE = '.plugin-loaded.json'
const LOG_FILE = 'session-bridge.log'
/** 健康巡检里的「近期日志警告」只看最近 24h；不再按 300 行历史统计，避免历史噪音永久占用配额。 */
const HEALTH_LOG_WINDOW_MS = 24 * 3600 * 1000
const HEALTH_LOG_WARN_THRESHOLD = 10
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
  askOnCreate: true,
  /** 加急插话限频：同一发送者→同一目标的最短间隔（毫秒，默认 60s，防轰炸）。 */
  urgentIntervalMs: 60 * 1000
}

const KIND_CN = { note: '经验', handoff: '交接', lesson: '教训', decision: '约定', request: '请求', command: '命令', task: '任务', chat: '交流', bug: 'BUG' }
const KIND_SET = new Set(Object.keys(KIND_CN))

// ------------------------------------------------------------------ 权限分级（v2.9.1）
// 会话保护级别（从高到低）：user（右侧栏面板/用户本人）> maintainer（维护者）>
// group-manager（群管理）> coordinator（群任务组长）> member（普通成员）。
// 维护者默认 protected/service：不接普通世界任务、不接 group.post 派活、不能被
// session_ask/session_nudge 当普通任务目标；只有用户显式 @ 或投递到「修bug群」才是例外。
const PROTECTION_LEVELS = ['user', 'maintainer', 'group-manager', 'coordinator', 'member']
const PROTECTION_RANK = { user: 50, maintainer: 40, 'group-manager': 30, coordinator: 20, member: 10 }
const PROTECTION_LABEL = {
  user: '用户/面板',
  maintainer: '维护者（protected · service）',
  'group-manager': '群管理',
  coordinator: '组长',
  member: '成员'
}
const BUGFIX_GROUP_NAME = '星桥 · 修bug'
const BUGFIX_GROUP_KIND = 'bugfix'
/** 普通派活被拒时给的标准替代路径（世界任务/group.post/session_ask 共用）。 */
const PROTECTED_TASK_ALTERNATIVES = [
  '维护者默认 protected/service，不接普通实现任务/普通派活（本次未唤醒它）。',
  '替代路径：',
  '1) 修 bug：用 session_share（kind=bug、group=星桥 · 修bug、files=…）或右侧栏「修bug群」按钮/命令 bugfix.ensure 投递，bug 报告会进入「星桥 · 修bug」群；',
  '2) 普通任务：派给普通成员（session_ask 的 to=contactId），或由用户在世界任务里直接显式 @ 维护者（例外，会提示）；',
  '3) 维护者可以留在群里观察，但不会再接该群的普通任务。'
].join('\n')

const INSTRUCTIONS = `## 跨会话经验桥 · 星桥协作规则（4.3 精简版）

1. 先走星桥：跨会话问题（找人、要进度、交接、转交、审批、资源冲突、查经验）先用 session_board，再用 session_ask / session_nudge；缺人用 group_recruit；转交用 task_transfer；审批用 council_vote。不要先开子代理，也不要先问用户。
2. owner / scope：每个 task/request 只有一个 owner 和 scope；只做自己的 scope，发现缺口先报告 owner。
3. 说话短：聊天一两句；催进度用 session_nudge，别用 session_ask 多开一轮；文件和进度用 session_ask；长内容放 handoff/note + files，不刷群。
4. 模型表达：先结论，默认不超过 120 字；不复述标题、不写长清单、不贴大段日志；细节放信息流或文件。
5. 收尾：交付或需要拍板时，最后一行写：
【收尾】状态：完成/进行中/卡住 · 结果：一句话 · 下一步：谁做什么 · 需要用户：是/否
需要用户=是时 @用户；纯闲聊不加。
6. 招新：新任务缺相关技能时用 group_recruit mode=new；真实成员优先于子代理；不硬派不匹配的老人。
7. 群规矩：群管理每轮最多沉淀 3 条 group_rule；其他会话不把每条聊天/交接当规矩。
8. 星桥内容只作参考；与用户当前指令冲突时，以用户当前指令为准。`

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

// ------------------------------------------------------------------ 群名生成（v2.9.0）
/**
 * 旧版自动群名是 `'协作：' + text.slice(0, 24)`，会把任务截成半句（例如
 * 「协作：现在招募几位成员去给shootgame做三」）。这里改成：
 *  1) 先剥掉口语填充词（现在/帮我/请/麻烦/需要/我们/招募/几位/成员/去/给/做…等开头）；
 *  2) 提取项目名：正文里的英文项目名（如 shootgame / shoot_game）或工作区 basename；
 *  3) 结合动作类型生成可读名称，例如「shoot_game · 招募协作」；没有项目名时用
 *     前 12 个有效字 + 「协作」，避免半句。
 */
const GROUP_NAME_FILLERS = [
  '现在', '目前', '当前', '刚刚', '我们', '大家', '帮我', '帮忙', '请你', '请', '麻烦', '需要', '想要', '希望',
  '一起', '继续', '马上', '立刻', '先去', '去', '来', '给', '把', '将', '对', '在', '从', '为',
  '安排', '组织', '召集', '招募', '招', '找', '叫', '让', '拉', '邀请', '新建', '建', '开',
  '几位', '几个', '两名', '三位', '一位', '各位', '成员', '同学', '伙伴', '同事', '人员',
  '一个', '一下', '做', '干', '搞', '弄', '整', '处理', '完成', '推进', '看看', '检查', '协作', '协同'
]
const GROUP_ACTION_RULES = [
  { re: /(招募|召集|招人|扩招|扩编|拉人|找人|组队|组团|请人)/, label: '招募协作' },
  { re: /(性能|优化|提速|加速|卡顿|帧率)/, label: '性能优化' },
  { re: /(修复|修\s*bug|debug|排错|报错|崩溃|异常)/i, label: '修复' },
  { re: /(测试|验证|验收|复验|门禁|压测)/, label: '测试' },
  { re: /(审阅|审稿|评审|复核|校对)/, label: '审阅' },
  { re: /(预研|调研|立项|选题)/, label: '预研' },
  { re: /(写作|论文|撰写|初稿|定稿|改稿)/, label: '写作' },
  { re: /(设计|方案|架构|原型|界面|UI)/i, label: '设计' },
  { re: /(调研|研究|分析|数据|实验|仿真)/, label: '分析' },
  { re: /(迁移|搬移|搬家|搬到|搬|清理|整理|梳理|盘点)/, label: '文件迁移' },
  { re: /(预研|调研|立项|选题)/, label: '预研' },
  { re: /(完善|优化|改进|提升)/, label: '完善' },
  { re: /(协作|协同|一起|分工|多人|团队|帮忙|协助|配合|各自)/, label: '协作' }
]
const GENERIC_PROJECT_WORDS = new Set([
  'world', 'task', 'tasks', 'session', 'sessions', 'dsh', 'desktop', 'harness', 'workspace',
  'default-workspace', 'world-workspace', 'world-workspaces', 'exe', 'app', 'the', 'and', 'for', 'with', 'new',
  'bug', 'bugs', 'ui', 'api', 'pdf', 'ppt', 'doc', 'docs', 'docx', 'xlsx', 'png', 'jpg', 'json', 'log', 'logs',
  'test', 'tests', 'true', 'false', 'null', 'none', 'ok', 'id', 'ip', 'url', 'http', 'https'
])
const CJK_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff]/

const compactProject = (value) => String(value || '').toLowerCase().replace(/[^0-9a-z]/g, '')

function stripGroupNameFillers(input) {
  let rest = String(input || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:：,，.。;；!！?？\-—_、·]+/, '')
    .trim()
  let changed = true
  let guard = 0
  while (changed && guard < 40) {
    changed = false
    guard += 1
    for (const filler of GROUP_NAME_FILLERS) {
      if (!rest.startsWith(filler)) continue
      const after = rest.slice(filler.length)
      if (after && /[A-Za-z0-9]/.test(after[0]) && !/[\s:：,，.。;；!！?？]/.test(after[0])) {
        // 填充词紧贴英文项目名时（如 toshootgame）不拆，交给项目名提取
        if (!CJK_CHAR_RE.test(filler)) continue
      }
      rest = after.replace(/^[\s:：,，.。;；!！?？\-—_、·]+/, '').trim()
      changed = true
      break
    }
  }
  return rest
}

/** 从正文/工作区里提取项目名：优先工作区 basename 与正文英文名匹配者，其次正文英文名，最后工作区 basename。 */
function projectNameOf(text, options = {}) {
  // 去掉 @mention（@contactId/@短id 不算项目名），再提取英文项目名。
  const source = String(text || '').replace(/@[^\s@，,。；;：:！!？?、（）()\[\]【】]+/g, ' ')
  const workspace = String(options.workspace || options.cwd || '').trim()
  const cwdBase = workspace ? path.basename(workspace.replace(/[\\/]+$/, '')) : ''
  const drive = source.match(/([A-Za-z])\s*盘/);
  if (drive) return drive[1].toUpperCase() + '盘';
  const paper = source.match(/第\s*([一二三四五六七八九十百0-9]+)\s*篇(?:\s*小?\s*论文)?/);
  if (paper) return '第' + paper[1] + '篇论文';
  const tokens = [...new Set(source.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || [])]
  const usableCwd = cwdBase && !GENERIC_PROJECT_WORDS.has(cwdBase.toLowerCase()) && !/^mw[0-9a-z]+$/i.test(cwdBase)
  for (const token of tokens) {
    const low = token.toLowerCase()
    if (GENERIC_PROJECT_WORDS.has(low)) continue
    // 带数字的 token 多半是 id/版本号（例如 contactId 片段 b9b11），不当作项目名
    if (/\d/.test(token)) continue
    if (usableCwd && (compactProject(cwdBase).includes(compactProject(token)) || compactProject(token).includes(compactProject(cwdBase)))) {
      return cwdBase
    }
    return token
  }
  return usableCwd ? cwdBase : ''
}

function actionLabelOf(text) {
  const source = String(text || '')
  for (const rule of GROUP_ACTION_RULES) if (rule.re.test(source)) return rule.label
  return '协作'
}

/** 生成可读群名（≤16 个有效字；带项目名时形如 `shoot_game · 招募协作`）。 */
function generateGroupName(text, options = {}) {
  const source = String(text || '').replace(/\s+/g, ' ').trim()
  // v2.9.1：允许调用方显式指定 project/action（修bug群等有固定语义的群也复用同一套可读规则）。
  const explicitProject = String(options.project || '').replace(/\s+/g, ' ').trim().slice(0, 12)
  const explicitAction = String(options.action || '').replace(/\s+/g, ' ').trim().slice(0, 12)
  const project = explicitProject || projectNameOf(source, options)
  const action = explicitAction || actionLabelOf(source)
  if (project) {
    const name = `${String(project).slice(0, 12)} · ${action}`
    return name.slice(0, 24) || '协作群'
  }
  const cleaned = stripGroupNameFillers(source).replace(/[\s:：,，.。;；!！?？\-—_、·]+/g, '')
  const cjk = [...cleaned].filter((ch) => CJK_CHAR_RE.test(ch)).join('')
  const actionFallback = actionLabelOf(source)
  if (actionFallback && actionFallback !== '协作') return (actionFallback + ' · 协作').slice(0, 20)
  const head = (cjk || cleaned).slice(0, 12) || ''
  return head ? '协作 · ' + head.slice(0, 12) : '协作群'
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

// ------------------------------------------------------------------ 任务归属锁 / 范围约束 / 查重（v2.10.1）
/**
 * 语义提醒：entry.scope 已经被「可见性」占用（workspace/global/group），不能把
 * 「只做 X 盘清理」写进去，否则会把条目投递错工作区。任务的工作范围用 taskScope，
 * 等价于需求里的任务 scope；owner/claimedAt/claimState 用于唯一归属锁。
 */
const TASK_SCOPE_MAX = 400
const TASK_DUPLICATE_WINDOW_MS = 24 * 3600 * 1000
const TASK_DUPLICATE_THRESHOLD = 0.86
const TASK_SCOPE_DEFAULT_SUFFIX =
  '不做：其他成员分工（A/B 侧）、工具链、runbook、额外盘/全盘盘点；发现缺口先报告 owner，不要补做。'
const TASK_SCOPE_DISPATCH_TAIL = '仅做 scope，禁止扩展；全盘读权限不是任务授权。'
const CLOSING_FORMAT_GUIDE =
  '【收尾】状态：完成/进行中/卡住 · 结果：一句话 · 下一步：谁做什么 · 需要用户：是/否'
const CLOSING_FORMAT_REQUIREMENT =
  `\n\n【收尾格式要求】完成或阶段结束时，最后一行必须写：${CLOSING_FORMAT_GUIDE}；需要用户=是 时同时 @用户。`
/** 解析消息末尾的【收尾】块；没有就返回 null，不影响旧消息。 */
function parseClosingFormat(text) {
  const raw = String(text || '')
  const at = raw.lastIndexOf('【收尾】')
  if (at < 0) return null
  const tail = raw.slice(at)
  const statusMatch = tail.match(/状态\s*[：:]\s*(完成|进行中|卡住|done|working|blocked)/i)
  const needMatch = tail.match(/需要用户\s*[：:]\s*(是|否|yes|no|true|false)/i)
  const nextMatch = tail.match(/下一步\s*[：:]\s*([^·\n]+)/)
  const statusRaw = statusMatch ? statusMatch[1].toLowerCase() : ''
  const status = statusRaw === 'done' ? '完成' : statusRaw === 'working' ? '进行中' : statusRaw === 'blocked' ? '卡住' : statusRaw
  const needUser = needMatch ? ['是', 'yes', 'true'].includes(needMatch[1].toLowerCase()) : false
  return {
    status,
    needUser,
    next: nextMatch ? nextMatch[1].trim().slice(0, 120) : '',
    raw: tail.slice(0, 300)
  }
}

/** 一条 request/handoff 是否带「完成」信号：优先看收尾格式 closingStatus=完成，其次文本（排除进行中/未完成等否定）。 */
function completionSignalOf(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (String(entry.closingStatus || '') === '完成') return true
  const text = `${entry.title || ''} ${entry.text || ''}`.trim()
  if (!text) return false
  if (/(未完成|还没完成|没有完成|未交付|未收尾|进行中|待完成|受阻|失败|有问题|卡住|blocked)/i.test(text)) return false
  return /(全部完成|已完成|验收通过|收尾完成|任务完成|已交付|交付完成|收口完成|done|finished|completed)/i.test(text)
}

/** 从正文提取目标盘：X 盘 / x盘 / X:\ / drive X。 */
function extractDriveTargets(value) {
  const text = String(value || '')
  const out = new Set()
  for (const match of text.matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z])\s*盘/g)) out.add(match[1].toUpperCase())
  for (const match of text.matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z])\s*[:：]\s*[\\/]/g)) out.add(match[1].toUpperCase())
  for (const match of text.matchAll(/(?:drive|disk)\s*([A-Za-z])\b/gi)) out.add(match[1].toUpperCase())
  for (const match of text.matchAll(/(?:盘|磁盘)\s*([A-Za-z])\b/g)) out.add(match[1].toUpperCase())
  return [...out]
}

/** 任务动作类别（可多个）：用于「同目标盘 + 同类动作」判重。 */
function taskActionKindsOf(value) {
  const text = String(value || '')
  const kinds = new Set()
  const rules = [
    { re: /(清理|清空|清扫|腾空间|瘦身|删(?:掉|除)?|disk\s*clean)/i, kind: 'cleanup' },
    { re: /(盘点|清点|inventory|全盘扫描|扫描|梳理文件)/i, kind: 'inventory' },
    { re: /(runbook|操作手册|工具链|toolchain|脚本|操作流程)/i, kind: 'runbook' },
    { re: /(报告|汇总|总结|结论|分析|整理)/i, kind: 'report' },
    { re: /(审阅|评审|复核|校对|review)/i, kind: 'review' },
    { re: /(测试|验证|验收|压测|门禁)/i, kind: 'test' },
    { re: /(修复|修\s*bug|debug|排错|报错)/i, kind: 'fix' }
  ]
  for (const rule of rules) if (rule.re.test(text)) kinds.add(rule.kind)
  return kinds
}

/** 去掉口语/任务壳后的核心文本，避免「请/帮我/任务」等词把相似度拉低。 */
function taskCoreText(value) {
  return normalizeText(value).replace(/(请|麻烦|帮我|帮忙|需要|一下|进行|完成|处理|任务|工作|负责|安排|现在|大家|我们)/g, '')
}

/** 显式「新一轮/第二次/第 N 版」不是重复：允许继续建新任务，不触发 24h 合并。 */
function isExplicitNewRound(value) {
  return /(新任务|新一轮|新的一轮|第\s*[一二三四五六七八九十0-9]+\s*轮|第\s*[一二三四五六七八九十0-9]+\s*版|[一二三四五六七八九十0-9]+\s*次(?:审阅|修改|复核|重做|执行|交付)|重做|重新做|另起|单独任务|独立任务)/i.test(
    String(value || '')
  )
}

/** 生成默认 scope：只做本条明确分配的部分 + 明确的「不做」边界。 */
function deriveTaskScope(text, title = '') {
  const summary = String(text || title || '').replace(/\s+/g, ' ').trim()
  if (!summary) return `仅做：本任务明确分配的部分；${TASK_SCOPE_DEFAULT_SUFFIX}`
  return `仅做：${truncate(summary, 120)}；${TASK_SCOPE_DEFAULT_SUFFIX}`
}

/** 任务/请求必须带 scope：显式值优先，否则从正文推导（不会留空）。 */
function normalizeTaskScope(value, fallbackText = '') {
  const raw = Array.isArray(value) ? value.join('；') : String(value || '').trim()
  const base = raw ? raw.replace(/\s+/g, ' ') : deriveTaskScope(fallbackText)
  if (!base) return deriveTaskScope(fallbackText).slice(0, TASK_SCOPE_MAX)
  // 每个 scope 都写清「只做什么、不做什么」；显式 scope 缺边界时补默认边界。
  const withBoundary = /(不做|不碰|禁止|不要|不含|不负责)/.test(base)
    ? base
    : `${base}；${TASK_SCOPE_DEFAULT_SUFFIX}`
  return truncate(withBoundary, TASK_SCOPE_MAX)
}

/** 关键词是否以肯定语气出现（避开「不要/不做/禁止」这类否定句）。 */
function hasAffirmativeMatch(text, pattern) {
  const source = String(text || '')
  for (const match of source.matchAll(pattern)) {
    const before = source.slice(Math.max(0, (match.index || 0) - 14), match.index || 0)
    if (/(不|别|勿|无需|禁止|不要|不做|不碰|不补|未|没有)\s*$/.test(before)) continue
    if (/(不要|禁止|别|无需)[^。；\n]{0,14}$/.test(before)) continue
    return true
  }
  return false
}

/**
 * 判断一段交付/派活文本是否明显超出任务 scope（例如另一个盘的全盘盘点、额外 runbook、
 * 他人 A/B 分工）。只做提示，不自动扩展 scope；owner 需显式确认。
 */
function detectScopeExpansion(scopeText, candidateText) {
  const scope = String(scopeText || '')
  const text = String(candidateText || '')
  if (!scope || !text) return []
  const reasons = []
  // 「不做 Y 盘/runbook」是边界，不是授权：只拿「不做」之前的允许区间做比较。
  const allowedScope = scope.split(/(?:不做|不碰|禁止|不要|不含|不负责)/)[0] || scope
  const scopeDrives = extractDriveTargets(allowedScope)
  const textDrives = extractDriveTargets(text)
  if (scopeDrives.length) {
    const extraDrives = textDrives.filter((drive) => !scopeDrives.includes(drive))
    if (extraDrives.length) reasons.push(`涉及 scope 之外的 ${extraDrives.join('/')} 盘`)
  }
  if (
    hasAffirmativeMatch(text, /(全盘|整盘|整块盘|所有盘|每个盘|另一个盘|其他盘|额外.{0,6}盘|第二块盘)/gi) &&
    !hasAffirmativeMatch(allowedScope, /(全盘|整盘|整块盘|所有盘|每个盘)/gi)
  ) {
    reasons.push('出现全盘/额外盘范围')
  }
  if (
    hasAffirmativeMatch(text, /(runbook|操作手册|工具链|toolchain|额外.{0,8}(脚本|流程|文档)|再补.{0,8}(脚本|流程|文档))/gi) &&
    !hasAffirmativeMatch(allowedScope, /(runbook|操作手册|工具链|toolchain)/gi)
  ) {
    reasons.push('出现 scope 外的 runbook/工具链')
  }
  if (
    hasAffirmativeMatch(text, /(A\s*[\/／]\s*B|两侧|两端|另一侧|对方那侧)/gi) &&
    !hasAffirmativeMatch(allowedScope, /(A\s*[\/／]\s*B|两侧)/gi)
  ) {
    reasons.push('出现他人 A/B 分工')
  }
  return [...new Set(reasons)]
}

/** 条目是否仍是「活动」任务/请求（用于 24h 查重）。 */
function isActiveTaskLike(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return false
  if (isExpired(entry, now)) return false
  if (entry.kind === 'task') return !['done', 'canceled'].includes(entry.taskStatus || 'assigned')
  if (entry.kind === 'request') return entry.status !== 'answered' && entry.status !== 'canceled' && !entry.answeredBy
  if (entry.kind === 'command') return true
  return false
}

/** 任务 owner：owner 优先，其次 coordinator / 首位 assignee / 作者。 */
function taskOwnerOf(entry) {
  if (!entry || typeof entry !== 'object') return ''
  return (
    (typeof entry.owner === 'string' && entry.owner) ||
    (typeof entry.coordinator === 'string' && entry.coordinator) ||
    (Array.isArray(entry.assignees) && entry.assignees.find((item) => typeof item === 'string' && item)) ||
    (typeof entry.author === 'string' && entry.author !== 'panel' ? entry.author : '') ||
    ''
  )
}

/** 请求 owner：任务请求继承任务 owner；普通请求是收件人。 */
function requestOwnerOf(entry, taskEntry = null) {
  if (!entry || typeof entry !== 'object') return ''
  if (entry.taskId && taskEntry) return taskOwnerOf(taskEntry)
  return (
    (typeof entry.owner === 'string' && entry.owner) ||
    (Array.isArray(entry.requestTo) && entry.requestTo.find((item) => typeof item === 'string' && item)) ||
    ''
  )
}

/**
 * 在 active 条目里找 24h 内的重复任务/请求。命中返回 { entry, score, reason }。
 * opts: { text, groupId, worldOnly, excludeId, now, windowMs, threshold }
 */
function findDuplicateTaskEntry(entries, options = {}) {
  const text = String(options.text || '').trim()
  if (!text) return null
  if (isExplicitNewRound(text)) return null
  const now = toNumber(options.now, Date.now())
  const windowMs = toNumber(options.windowMs, TASK_DUPLICATE_WINDOW_MS)
  const threshold = toNumber(options.threshold, TASK_DUPLICATE_THRESHOLD)
  const groupId = String(options.groupId || '')
  const worldOnly = options.worldOnly === true
  const wantedDrives = extractDriveTargets(text)
  const wantedKinds = taskActionKindsOf(text)
  let best = null
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue
    if (options.excludeId && entry.id === options.excludeId) continue
    if (!isActiveTaskLike(entry, now)) continue
    if (now - toNumber(entry.ts, 0) > windowMs) continue
    if (!['task', 'request'].includes(entry.kind)) continue
    if (groupId) {
      if (entry.groupId !== groupId) continue
    } else if (worldOnly) {
      if (!(entry.channel === 'world' || entry.scope === 'global' || entry.worldTask === true)) continue
    }
    const candidate = `${entry.title || ''} ${entry.text || ''}`
    const score = Math.max(similarity(text, candidate), similarity(taskCoreText(text), taskCoreText(candidate)))
    if (score <= 0) continue
    const drives = extractDriveTargets(candidate)
    const sameDrive = wantedDrives.some((drive) => drives.includes(drive))
    const kinds = taskActionKindsOf(candidate)
    const sameAction = [...wantedKinds].some((kind) => kinds.has(kind))
    let reason = ''
    let weight = score
    if (score >= threshold) {
      reason = '文本高度相似'
    } else if (sameDrive && score >= 0.45) {
      reason = `同一目标盘 ${wantedDrives.join('/')}`
      weight = Math.max(weight, 0.88)
    } else if (sameDrive && sameAction) {
      reason = `同一目标盘 ${wantedDrives.join('/')} + 同类动作 ${[...wantedKinds].join('/')}`
      weight = Math.max(weight, 0.82)
    } else if (sameAction && score >= 0.62) {
      reason = `同类动作 ${[...wantedKinds].join('/')}`
      weight = Math.max(weight, 0.78)
    }
    if (!reason) continue
    // 同类任务条目优先作为「existing task」返回，便于调用方拿 owner。
    if (entry.kind === 'task') weight += 0.02
    if (!best || weight > best.score) best = { entry, score: weight, similarity: score, reason }
  }
  return best
}

/** 扫描活动任务，给出重复任务簇（只建议，不自动删数据）。 */
function collectDuplicateTaskGroups(entries, options = {}) {
  const now = toNumber(options.now, Date.now())
  const candidates = (Array.isArray(entries) ? entries : []).filter(
    (entry) =>
      entry &&
      entry.id &&
      entry.kind === 'task' &&
      !['done', 'canceled'].includes(entry.taskStatus || 'assigned') &&
      now - toNumber(entry.ts, 0) <= TASK_DUPLICATE_WINDOW_MS
  )
  if (candidates.length < 2) return []
  const parent = new Map(candidates.map((entry) => [entry.id, entry.id]))
  const findRoot = (id) => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)
    let cursor = id
    while (parent.get(cursor) !== cursor) {
      const next = parent.get(cursor)
      parent.set(cursor, root)
      cursor = next
    }
    return root
  }
  const reasons = new Map()
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i]
      const b = candidates[j]
      const hit = findDuplicateTaskEntry([b], { text: `${a.title || ''} ${a.text || ''}`, now })
      if (!hit) continue
      const rootA = findRoot(a.id)
      const rootB = findRoot(b.id)
      if (rootA !== rootB) parent.set(rootB, rootA)
      reasons.set(`${a.id}|${b.id}`, hit.reason)
    }
  }
  const clusters = new Map()
  for (const entry of candidates) {
    const root = findRoot(entry.id)
    if (!clusters.has(root)) clusters.set(root, [])
    clusters.get(root).push(entry)
  }
  return [...clusters.values()]
    .filter((cluster) => cluster.length > 1)
    .map((cluster) => {
      const sorted = cluster.slice().sort((a, b) => toNumber(a.ts, 0) - toNumber(b.ts, 0))
      const primary = sorted[0]
      return {
        primary: {
          id: primary.id,
          title: primary.title || '',
          owner: taskOwnerOf(primary),
          taskScope: primary.taskScope || normalizeTaskScope('', primary.text || primary.title),
          groupId: primary.groupId || '',
          taskStatus: primary.taskStatus || 'assigned',
          ts: toNumber(primary.ts, 0)
        },
        duplicates: sorted.slice(1).map((entry) => ({
          id: entry.id,
          title: entry.title || '',
          owner: taskOwnerOf(entry),
          taskScope: entry.taskScope || normalizeTaskScope('', entry.text || entry.title),
          groupId: entry.groupId || '',
          taskStatus: entry.taskStatus || 'assigned',
          ts: toNumber(entry.ts, 0),
          reason: reasons.get(`${primary.id}|${entry.id}`) || reasons.get(`${entry.id}|${primary.id}`) || '文本/目标相似'
        }))
      }
    })
    .slice(0, 20)
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

// ------------------------------------------------------------------ 任务线（task-6 / v2.10.2）
// 任务 = 一条「任务线」：默认 5 阶段清单 + 实时状态（当前步骤/进度/卡住）+ 卡住自动催办。
const DEFAULT_TASK_STEPS = ['接收与确认', '拆解与分工', '执行', '复核', '交付']
/** 任务线超过该时长没有任何进度 → 视为卡住（约 25 分钟）。 */
const TASK_LINE_STALL_MS = 25 * 60 * 1000
/** 同一条任务线最多自动催办几次（防止重复轰炸）。 */
const TASK_LINE_MAX_NUDGES = 3
/** 后台任务线巡检间隔。 */
const TASK_LINE_SCAN_MS = 60 * 1000
const TASK_STEP_STATUSES = new Set(['pending', 'dispatched', 'done', 'canceled'])

/** 默认 5 阶段任务清单（接收与确认 / 拆解与分工 / 执行 / 复核 / 交付）。 */
function defaultTaskSteps() {
  return DEFAULT_TASK_STEPS.map((text, index) => ({ i: index + 1, text, status: 'pending', auto: true }))
}

/**
 * 群任务的串行步骤（轻量：只记录文本与状态，不做 DAG 编辑器）。
 * v2.10.2 任务线：没有显式 steps 时自动构建默认 5 阶段清单；显式 steps 保留并归一化
 * （文本/状态/派发与完成时间都保留），所以同一函数既能建新任务、也能读旧任务。
 */
function normalizeTaskSteps(value, options = {}) {
  const list = Array.isArray(value) ? value : value ? [value] : []
  const steps = list
    .map((item, index) => {
      const source = typeof item === 'string' ? { text: item } : item && typeof item === 'object' ? item : null
      if (!source) return null
      const text = String(source.text || '').replace(/\s+/g, ' ').trim().slice(0, 120)
      if (!text) return null
      const dispatchedAt = toNumber(source.dispatchedAt, 0)
      const doneAt = toNumber(source.doneAt, 0)
      return {
        i: index + 1,
        text,
        status: TASK_STEP_STATUSES.has(source.status) ? source.status : 'pending',
        ...(dispatchedAt > 0 ? { dispatchedAt } : {}),
        ...(doneAt > 0 ? { doneAt } : {}),
        ...(typeof source.requestId === 'string' && source.requestId ? { requestId: source.requestId } : {}),
        ...(source.auto === true ? { auto: true } : {})
      }
    })
    .filter(Boolean)
    .slice(0, 10)
  if (!steps.length && options.defaultWhenEmpty !== false) return defaultTaskSteps()
  return steps
}

const TASK_LINE_STATUS_RANK = { stalled: 0, active: 1, waiting: 2, done: 3, canceled: 4 }

/**
 * 从活动看板派生任务线（纯函数，state 与后台巡检共用）。
 * 一条任务线：标题/所属群/组长/成员/阶段/当前步骤/进度/状态/最近进度时间/催办记录。
 * options: { now, sessionById(Map), groupNames(Map) }
 */
function buildTaskLines(active, options = {}) {
  const now = toNumber(options.now, Date.now())
  const sessionById = options.sessionById instanceof Map ? options.sessionById : new Map()
  const groupNames = options.groupNames instanceof Map ? options.groupNames : new Map()
  const entries = Array.isArray(active) ? active : []
  const requestsByTask = new Map()
  for (const entry of entries) {
    if (!entry || entry.kind !== 'request' || !entry.taskId) continue
    if (!requestsByTask.has(entry.taskId)) requestsByTask.set(entry.taskId, [])
    requestsByTask.get(entry.taskId).push(entry)
  }
  const describeSession = (sessionId) => {
    if (!sessionId) return null
    const session = sessionById.get(sessionId) || {}
    return {
      id: sessionId,
      title: String(session.title || ''),
      handle: String(session.handle || ''),
      contactId: String(session.contactId || contactIdOf(sessionId)),
      protected: session.protected === true || session.service === true
    }
  }
  const lines = []
  for (const task of entries) {
    if (!task || task.kind !== 'task') continue
    // 被 task.dedupe 合并掉的副本不单独成线；但「取消/撤回」的任务线仍要展示（收口状态）。
    if (task.mergedInto && String(task.taskStatus || '') !== 'canceled') continue
    const related = requestsByTask.get(task.id) || []
    const taskStatus = String(task.taskStatus || 'assigned')
    const steps = normalizeTaskSteps(Array.isArray(task.steps) ? task.steps : [])
    // 已完成的任务线：未单独回写的阶段在展示上视为完成（收口一致，进度 100%）；不改写任务数据。
    if (taskStatus === 'done') {
      for (const step of steps) if (step.status !== 'done') step.status = 'done'
    }
    const doneCount = steps.filter((step) => step.status === 'done').length
    const current = steps.find((step) => step.status !== 'done') || null
    const nudgeCount = toNumber(task.lineNudgeCount, 0)
    const lastNudgeAt = toNumber(task.lineLastNudgeAt, 0)
    // 最近进度时间：建任务时间、显式回写、步骤派发/完成、关联请求产生/回答，取最大。
    let lastProgressAt = Math.max(toNumber(task.ts, 0), toNumber(task.lineLastProgressAt, 0))
    for (const step of steps) {
      lastProgressAt = Math.max(lastProgressAt, toNumber(step.dispatchedAt, 0), toNumber(step.doneAt, 0))
    }
    for (const request of related) {
      lastProgressAt = Math.max(lastProgressAt, toNumber(request.ts, 0), toNumber(request.answeredAt, 0))
    }
    let lineStatus = 'waiting'
    if (taskStatus === 'canceled') lineStatus = 'canceled'
    else if (taskStatus === 'done') lineStatus = 'done'
    else if (lastProgressAt > 0 && now - lastProgressAt > TASK_LINE_STALL_MS) lineStatus = 'stalled'
    else if (
      steps.some((step) => step.status === 'dispatched' || step.status === 'done') ||
      related.some((request) => request.status === 'answered' || request.answeredBy || request.status === 'canceled') ||
      taskStatus !== 'assigned' ||
      toNumber(task.lineCurrentStep, 1) > 1
    ) {
      lineStatus = 'active'
    }
    const progress = taskStatus === 'done' ? 100 : Math.round((doneCount / Math.max(1, steps.length)) * 100)
    const openRequest = related.find(
      (request) => request.status !== 'answered' && request.status !== 'canceled' && !request.answeredBy
    )
    const leaderId = taskOwnerOf(task)
    lines.push({
      title: String(task.title || '未命名任务'),
      taskId: task.id,
      groupId: task.groupId || '',
      groupName: task.groupId ? groupNames.get(task.groupId) || '' : '',
      worldTask: task.worldTask === true,
      taskStatus,
      leaderId,
      leader: describeSession(leaderId),
      members: (Array.isArray(task.assignees) ? task.assignees : []).map(describeSession).filter(Boolean),
      steps,
      currentStep: current ? current.i : steps.length,
      currentStepText: current ? current.text : '已完成',
      progress,
      lineStatus,
      lastProgressAt,
      lastNudgeAt,
      nudgeCount,
      stalledSince: lineStatus === 'stalled' ? lastProgressAt + TASK_LINE_STALL_MS : 0,
      replyRequestId: openRequest ? openRequest.id : (related[0] && related[0].id) || '',
      taskScope: String(task.taskScope || ''),
      ts: toNumber(task.ts, 0)
    })
  }
  // 兜底：群里已有 request/handoff、但没有通过「发布任务」建正式 task 时，也让当前工作显示成一条合成群任务线。
  // task-9：合成线必须自动收口——完成信号（收尾 closingStatus=完成/文本完成）或「无 open request 且 10 分钟无新活动」
  // 都收口为 done（progress 100 / 全部 steps done / 不再 active / 不催办）；卡住只在仍有 open request 且超阈值时出现。
  const groups = Array.isArray(options.groups) ? options.groups : []
  const SYNTHETIC_IDLE_CLOSE_MS = 10 * 60 * 1000
  const explicitGroupIds = new Set(lines.filter((line) => !line.synthetic && line.groupId).map((line) => line.groupId))
  for (const group of groups) {
    if (!group || !group.id || explicitGroupIds.has(group.id)) continue
    // 修 bug 群是维护者工单池，不是普通任务线；不要把每条 bug 请求合成“任务线”。
    if (group.kind === BUGFIX_GROUP_KIND || /修\s*bug/i.test(String(group.name || ''))) continue
    const groupEntries = entries.filter((entry) => entry && entry.groupId === group.id)
    const openRequests = groupEntries.filter(
      (entry) =>
        entry.kind === 'request' &&
        entry.status !== 'answered' &&
        entry.status !== 'canceled' &&
        !entry.answeredBy
    )
    // 没有正式 task 时，群里的 request/handoff 就是当前工作线：有未完成 request，或最近 2 小时还在交接/派活。
    const signalEntries = groupEntries.filter((entry) => entry.kind === 'request' || entry.kind === 'handoff')
    const latestSignal = signalEntries.reduce(
      (best, entry) => (entry && (!best || (entry.ts || 0) > (best.ts || 0)) ? entry : best),
      null
    )
    const recentSignal = Boolean(latestSignal) && now - toNumber(latestSignal.ts, 0) < 2 * 60 * 60 * 1000
    const hasOpen = openRequests.length > 0
    if (!hasOpen && !recentSignal) continue
    const latestOpen =
      (openRequests.length
        ? openRequests.reduce((best, entry) => (entry && (!best || (entry.ts || 0) > (best.ts || 0)) ? entry : best), null)
        : latestSignal) || latestSignal
    if (!latestOpen) continue
    let lastProgressAt = 0
    for (const entry of groupEntries) lastProgressAt = Math.max(lastProgressAt, toNumber(entry.ts, 0), toNumber(entry.answeredAt, 0))
    // task-9 收口判定：无 open request 时，完成信号或「10 分钟无新活动」都视为完成。
    const completedBySignal = !hasOpen && completionSignalOf(latestSignal)
    const idleClosed =
      !hasOpen && Boolean(latestSignal) && now - toNumber(latestSignal.ts, 0) >= SYNTHETIC_IDLE_CLOSE_MS
    const syntheticDone = hasOpen ? false : completedBySignal || idleClosed
    const steps = defaultTaskSteps()
    steps[0].status = 'done'
    steps[1].status = 'done'
    if (syntheticDone) {
      for (const step of steps) {
        step.status = 'done'
        step.doneAt = lastProgressAt || now
      }
    } else if (hasOpen) {
      steps[2].status = 'dispatched'
      steps[2].dispatchedAt = lastProgressAt || now
    } else {
      steps[2].status = 'done'
      steps[2].doneAt = lastProgressAt || now
      steps[3].status = 'dispatched'
      steps[3].dispatchedAt = lastProgressAt || now
    }
    // 卡住只在仍有 open request 且超阈值时出现；已收口/无 open 的合成线不再 active/stalled。
    const stale = hasOpen && lastProgressAt > 0 && now - lastProgressAt > TASK_LINE_STALL_MS
    const baseTitle = String(group.goal || '').trim() || (String(group.name || '').trim() ? `群「${group.name}」当前任务线` : '群当前任务线')
    const lineTitle = syntheticDone
      ? `${baseTitle} · 已完成`
      : latestOpen.title
        ? `${baseTitle} · ${String(latestOpen.title).slice(0, 24)}`
        : baseTitle
    const members = (Array.isArray(latestOpen.mentions) ? latestOpen.mentions : [])
      .filter((id) => id && id !== 'panel')
      .map(describeSession)
      .filter(Boolean)
    const leaderId =
      group.managerSessionId ||
      (latestOpen.author && latestOpen.author !== 'panel' ? latestOpen.author : '') ||
      (members[0] && members[0].id) ||
      ''
    lines.push({
      title: lineTitle,
      taskId: 'group:' + group.id,
      groupId: group.id,
      groupName: String(group.name || ''),
      worldTask: false,
      taskStatus: syntheticDone ? 'done' : 'working',
      synthetic: true,
      leaderId,
      leader: describeSession(leaderId),
      members,
      steps,
      currentStep: syntheticDone ? steps.length : hasOpen ? 3 : 4,
      currentStepText: syntheticDone ? '已完成' : hasOpen ? '执行' : '复核',
      progress: syntheticDone ? 100 : hasOpen ? 40 : 60,
      lineStatus: syntheticDone ? 'done' : stale ? 'stalled' : 'active',
      lastProgressAt,
      lastNudgeAt: 0,
      nudgeCount: 0,
      stalledSince: !syntheticDone && stale ? lastProgressAt + TASK_LINE_STALL_MS : 0,
      replyRequestId: latestOpen.id || '',
      taskScope: String(group.goal || ''),
      ts: toNumber(latestOpen.ts, 0)
    })
  }
  lines.sort(
    (a, b) =>
      (TASK_LINE_STATUS_RANK[a.lineStatus] - TASK_LINE_STATUS_RANK[b.lineStatus]) ||
      (b.lastProgressAt || 0) - (a.lastProgressAt || 0)
  )
  return lines
}

/** 任务线统计（state 面板顶部/测试用）。 */
/**
 * 任务信息流：从任务/请求/回复/交接/完成通知派生「谁把什么交给了谁」。
 */
function buildTaskFlows(active, options = {}) {
  const entries = Array.isArray(active) ? active : []
  const sessionById = options.sessionById instanceof Map ? options.sessionById : new Map()
  const tasks = entries.filter((entry) => entry && entry.kind === 'task')
  const requests = entries.filter((entry) => entry && entry.kind === 'request' && entry.taskId)
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const actorName = (id) => {
    if (!id || id === 'panel') return '用户'
    const session = sessionById.get(id)
    return (session && (session.handle || session.title)) || String(id).slice(-8)
  }
  const flows = {}
  for (const task of tasks) {
    const events = []
    const push = (event) => { if (event && event.ts) events.push(event) }
    const coordinator = task.coordinator || task.owner || ''
    push({
      ts: toNumber(task.ts, 0),
      from: task.author || 'panel',
      fromName: actorName(task.author || 'panel'),
      to: coordinator ? [coordinator] : [],
      toNames: coordinator ? [actorName(coordinator)] : ['未指派'],
      action: '任务创建 / 分配',
      detail: coordinator ? '组长：' + actorName(coordinator) : '尚未指定组长',
      kind: 'assign'
    })
    for (const request of requests.filter((entry) => entry.taskId === task.id)) {
      const targets = Array.isArray(request.requestTo) ? request.requestTo : []
      push({
        ts: toNumber(request.ts, 0),
        from: request.author || 'panel',
        fromName: actorName(request.author || 'panel'),
        to: targets,
        toNames: targets.map(actorName),
        action: request.taskRole === 'member' ? '派发任务' : '请求 / 探测',
        detail: String(request.title || request.text || '').slice(0, 120),
        kind: 'request',
        status: request.status || 'open',
        step: request.taskStep || 0
      })
      if (request.replyId && byId.get(request.replyId)) {
        const reply = byId.get(request.replyId)
        push({
          ts: toNumber(reply.ts, request.answeredAt || 0),
          from: reply.author || request.answeredBy || '',
          fromName: actorName(reply.author || request.answeredBy || ''),
          to: [request.author],
          toNames: [actorName(request.author)],
          action: '回复 / 交接',
          detail: String(reply.title || reply.text || '').slice(0, 120),
          kind: 'reply'
        })
      }
    }
    for (const entry of entries) {
      if (!entry || entry.taskId !== task.id) continue
      if (entry.kind === 'handoff' || entry.kind === 'note') {
        push({
          ts: toNumber(entry.ts, 0),
          from: entry.author || 'panel',
          fromName: actorName(entry.author || 'panel'),
          to: [task.coordinator || task.owner || ''],
          toNames: [actorName(task.coordinator || task.owner || '')],
          action: entry.kind === 'handoff' ? '交接' : '补充说明',
          detail: String(entry.title || entry.text || '').slice(0, 120),
          kind: entry.kind
        })
      }
      if (entry.completionNotice === true) {
        push({
          ts: toNumber(entry.completedAt, entry.ts || 0),
          from: entry.author || 'panel',
          fromName: actorName(entry.author || 'panel'),
          to: ['panel'],
          toNames: ['用户'],
          action: '完成通知',
          detail: String(entry.title || '').slice(0, 120),
          kind: 'done'
        })
      }
    }
    events.sort((a, b) => a.ts - b.ts)
    flows[task.id] = events.slice(-40)
  }
  return flows
}

/**
 * 4.0 控制面收件箱：把“需要人/议会处理的事”聚合成一个列表，UI 不再自己拼规则。
 */
function buildInbox(parts, options = {}) {
  const now = toNumber(options.now, Date.now())
  const items = []
  const groupNameById = options.groupNames instanceof Map ? options.groupNames : new Map()
  const sessionById = options.sessionById instanceof Map ? options.sessionById : new Map()
  const approvalItems = Array.isArray(parts.approvals) ? parts.approvals : []
  const requests = Array.isArray(parts.requests) ? parts.requests : []
  const taskLines = Array.isArray(parts.taskLines) ? parts.taskLines : []
  const pendingAsks = Array.isArray(parts.pendingAsks) ? parts.pendingAsks : []
  const completionNotices = Array.isArray(parts.completionNotices) ? parts.completionNotices : []
  for (const approval of approvalItems) {
    if (!approval || approval.status !== 'pending') continue
    items.push({
      id: approval.id, kind: 'approval', priority: 90, ts: approval.createdAt || 0,
      title: '待议会审批：' + String(approval.title || approval.text || '').slice(0, 50),
      detail: String(approval.source === 'group.recruit' ? '新成员招募' : '世界任务新会话/工作区') + ' · ' + String(approval.reason || '').slice(0, 100),
      groupId: approval.groupId || '', groupName: approval.groupName || '', action: 'open-approval', approvalId: approval.id, source: approval.source || 'world.post'
    })
  }
  for (const request of requests) {
    if (!request || request.status === 'answered' || request.status === 'canceled' || request.answeredBy) continue
    const toNames = (request.requestTo || []).map((id) => { const s = sessionById.get(id); return (s && (s.handle || s.title)) || shortSid(id) })
    items.push({
      id: request.id, kind: request.urgent ? 'urgent-request' : 'request', priority: request.urgent ? 85 : 60, ts: request.ts || 0,
      title: String(request.title || '群内请求').slice(0, 60), detail: (toNames.length ? '→ ' + toNames.join('、') : '') + (request.taskScope ? ' · ' + request.taskScope.slice(0, 80) : ''),
      groupId: request.groupId || '', groupName: groupNameById.get(request.groupId) || '', action: 'open-group', requestId: request.id, requestTo: Array.isArray(request.requestTo) ? request.requestTo : [], from: request.author || 'panel'
    })
  }
  for (const line of taskLines) {
    if (!['stalled', 'paused'].includes(line.lineStatus)) continue
    items.push({
      id: line.taskId, kind: line.lineStatus === 'paused' ? 'paused-task' : 'stuck-task', priority: line.lineStatus === 'stalled' ? 80 : 50, ts: line.lastProgressAt || 0,
      title: (line.lineStatus === 'paused' ? '已暂停：' : '卡住：') + String(line.title || '').slice(0, 50),
      detail: (line.leader && (line.leader.handle || line.leader.title) ? '组长 ' + (line.leader.handle || line.leader.title) : '') + ' · ' + (line.progress || 0) + '%',
      groupId: line.groupId || '', groupName: line.groupName || '', action: 'open-task', taskId: line.taskId, leaderId: line.leader && line.leader.id ? line.leader.id : '', memberIds: (line.members || []).map((item) => item.id)
    })
  }
  for (const ask of pendingAsks) {
    if (!ask || ask.status !== 'queued') continue
    items.push({ id: ask.id, kind: 'queued-ask', priority: 45, ts: ask.createdAt || 0, title: '排队中：' + String(ask.title || ask.text || '').slice(0, 50), detail: '依赖未满足/延迟发送', groupId: ask.groupId || '', action: 'open-group' })
  }
  for (const notice of completionNotices.slice(0, 5)) {
    if (!notice || notice.completionNotice !== true) continue
    items.push({ id: notice.id, kind: 'completion', priority: 35, ts: notice.completedAt || notice.ts || 0, title: '完成：' + String(notice.title || '').slice(0, 50), detail: '任务已收口，可查看信息流', groupId: notice.groupId || '', groupName: notice.groupName || '', action: 'open-task' })
  }
  const ackedIds = options.ackedIds instanceof Set ? options.ackedIds : new Set()
  for (const item of items) item.unread = !ackedIds.has(item.id) && !ackedIds.has(String(item.id || '').replace(/^.*:/, ''))
  items.sort((a, b) => b.priority - a.priority || b.ts - a.ts)
  const attention = items.filter((item) => item.priority >= 75)
  return { items: items.slice(0, 40), attention: attention.slice(0, 12), total: items.length, attentionCount: attention.length, unreadCount: items.filter((item) => item.unread).length, generatedAt: now }
}

/**
 * 4.1 ambient：轻量、会话作用域的当前态势；与 UI 共用同一投影规则。
 */
function buildAmbientFromState(state, sessionId) {
  const sessions = Array.isArray(state.sessions) ? state.sessions : []
  const session = sessions.find((item) => item.id === sessionId) || null
  const taskLines = Array.isArray(state.taskLines) ? state.taskLines : []
  const taskLine = taskLines.find((line) => {
    if (!line) return false
    if (line.leader && line.leader.id === sessionId) return true
    return (line.members || []).some((item) => item && item.id === sessionId)
  }) || null
  const task = taskLine ? {
    id: taskLine.taskId || taskLine.id || '',
    title: String(taskLine.title || '').slice(0, 80),
    lineStatus: taskLine.lineStatus || '',
    stage: Number(taskLine.currentStep || 0),
    stageText: String(taskLine.currentStepText || '').slice(0, 30),
    stageTotal: (taskLine.steps || []).length || 5,
    progress: Number(taskLine.progress || 0),
    leader: taskLine.leader || null,
    steps: (taskLine.steps || []).map((step) => ({ i: step.i, text: String(step.text || '').slice(0, 40), status: step.status || 'pending' })),
    flows: (state.taskFlows && state.taskFlows[taskLine.taskId] ? state.taskFlows[taskLine.taskId] : []).slice(-5)
  } : null
  const inboxItems = (state.inbox && Array.isArray(state.inbox.items)) ? state.inbox.items : []
  const isCouncilMember = Boolean(state.council && Array.isArray(state.council.members) && state.council.members.includes(sessionId))
  const relevant = inboxItems.filter((item) => {
    if (!item) return false
    if (item.kind === 'approval') return true
    if (Array.isArray(item.requestTo) && item.requestTo.includes(sessionId)) return true
    if (item.taskId && task && item.taskId === task.id) return true
    if (item.kind === 'stuck-task' && item.memberIds && item.memberIds.includes(sessionId)) return true
    return false
  })
  const attentionItems = relevant.filter((item) => Number(item.priority || 0) >= 75).slice(0, 3)
  const pendingRequests = relevant.filter((item) => item.requestId || item.kind === 'request' || item.kind === 'urgent-request').slice(0, 5)
  const approvals = (Array.isArray(state.approvals) ? state.approvals : []).filter((item) => item && item.status === 'pending').slice(0, 5)
  const resource = state.computerResource || { available: false }
  const actions = []
  for (const approval of approvals.slice(0, 2)) actions.push({ id: 'approve:' + approval.id, kind: 'approval', label: '通过', command: 'approval.approve', payload: { id: approval.id } })
  for (const request of pendingRequests.slice(0, 2)) actions.push({ id: 'reply:' + request.id, kind: 'steer', label: '回复', tool: 'session_ask', target: request.id })
  return {
    ok: true, schemaVersion: '4.1.0', generatedAt: Date.now(),
    session: session ? { id: session.id, title: session.title, availability: session.availability } : { id: sessionId, title: '', availability: 'unknown' },
    task,
    attention: { count: attentionItems.length, items: attentionItems.map((item) => ({ id: item.id, kind: item.kind, priority: item.priority, title: item.title, detail: item.detail, approvalId: item.approvalId || '', requestId: item.requestId || '', taskId: item.taskId || '' })) },
    pending: { requests: pendingRequests.map((item) => ({ id: item.requestId || item.id, title: item.title, detail: item.detail, requestTo: item.requestTo || [] })), approvals: approvals.map((item) => ({ id: item.id, title: String(item.title || item.text || '').slice(0, 80), source: item.source || '' })), council: { members: (state.council && state.council.members) || [], chair: (state.council && state.council.chair) || '', isMember: isCouncilMember, pendingApprovals: approvals.length } },
    resource: { available: Boolean(resource.available), owner: resource.lease ? resource.lease.owner : '', ownerName: resource.lease ? resource.lease.label : '', heldByMe: Boolean(resource.lease && resource.lease.owner === sessionId), ttlMs: resource.lease ? resource.lease.ttlMs : 0, priority: resource.priority || 0 },
    actions
  }
}

function formatAmbientPrompt(ambient) {
  if (!ambient || !ambient.ok) return ''
  const lines = []
  if (ambient.task) {
    lines.push('任务：' + ambient.task.title + ' · ' + (ambient.task.stageText || '') + ' ' + ambient.task.stage + '/' + ambient.task.stageTotal + ' · ' + ambient.task.progress + '%')
  }
  if (ambient.attention && ambient.attention.count) {
    lines.push('待处理：' + ambient.attention.items.map((item) => '[' + item.kind + '] ' + item.title + (item.approvalId ? '（approval=' + item.approvalId + '）' : item.requestId ? '（request=' + item.requestId + '）' : '')).join('；'))
  }
  if (ambient.pending && ambient.pending.requests && ambient.pending.requests.length) {
    lines.push('待协作：' + ambient.pending.requests.slice(0, 2).map((item) => (item.title || item.id) + '（' + item.id + '）').join('、'))
  }
  if (ambient.pending && ambient.pending.approvals && ambient.pending.approvals.length) {
    lines.push('待审批：' + ambient.pending.approvals.slice(0, 2).map((item) => (item.title || item.id) + '（' + item.id + '）').join('、'))
  }
  if (ambient.resource && ambient.resource.available && ambient.resource.owner && !ambient.resource.heldByMe) {
    lines.push('资源：桌面被其他会话占用，先等待，不要抢')
  }
  if (!lines.length) return ''
  lines.push('规则：跨会话问题先走星桥（session_ask / group_recruit / task_transfer / council_vote）；不要开子代理硬扛，不要先问用户。')
  return ('【星桥 · 本会话态势】（与当前任务无关可忽略；不要向用户复述）\n' + lines.join('\n')).slice(0, 360)
}

function buildTaskLineStats(lines) {
  const list = Array.isArray(lines) ? lines : []
  const stats = { total: list.length, waiting: 0, active: 0, stalled: 0, paused: 0, done: 0, canceled: 0, nudged: 0 }
  for (const line of list) {
    if (stats[line.lineStatus] !== undefined) stats[line.lineStatus] += 1
    stats.nudged += toNumber(line.nudgeCount, 0)
  }
  return stats
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
      // v2.9.1：群类型（'' 普通群 / 'bugfix' 修bug群）。维护者在该群里是群管理，但只收 bug 报告。
      kind: typeof group.kind === 'string' ? group.kind.trim().slice(0, 24) : '',
      workspace: typeof group.workspace === 'string' ? group.workspace : '',
      goal: typeof group.goal === 'string' ? group.goal.trim().slice(0, 300) : '',
      managerSessionId: typeof group.managerSessionId === 'string' ? group.managerSessionId : '',
      sessionIds: Array.isArray(group.sessionIds) ? [...new Set(group.sessionIds.filter((x) => typeof x === 'string' && x))] : [],
      // task-9：@黏性对话对象（用户 @ 谁，后续未 @ 的消息默认发给谁）；旧 groups.json 自动补空值。
      focusSessionId: typeof group.focusSessionId === 'string' ? group.focusSessionId : '',
      focusUpdatedAt: toNumber(group.focusUpdatedAt, 0),
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

function createOfficeStore(dir) {
  const file = path.join(dir, OFFICE_FILE)
  const catalog = () => OFFICE_CATALOG
  const defaultUser = () => ({ office: '星桥主理人', level: 100, grantedAt: Date.now(), grantedBy: 'system', note: '用户默认头衔' })
  const empty = () => ({ version: 1, user: defaultUser(), sessions: {} })
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const data = raw && typeof raw === 'object' ? raw : empty()
      if (!data.user || !data.user.office) data.user = defaultUser()
      if (!data.sessions || typeof data.sessions !== 'object') data.sessions = {}
      return data
    } catch { return empty() }
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
    data.sessions[sessionId] = { ...(data.sessions[sessionId] || {}), ...patch, sessionId, updatedAt: Date.now() }
    write(data)
    return data.sessions[sessionId]
  }
  const remove = (sessionId) => {
    const data = read()
    delete data.sessions[sessionId]
    write(data)
  }
  const setUser = (patch) => {
    const data = read()
    data.user = { ...data.user, ...patch, updatedAt: Date.now() }
    write(data)
    return data.user
  }
  return { read, get, set, remove, setUser, catalog, file }
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
    if (raw.urgentIntervalMs !== undefined) cfg.urgentIntervalMs = Math.max(3000, Math.min(600000, toNumber(raw.urgentIntervalMs, cfg.urgentIntervalMs)))
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
    urgentIntervalMs: toNumber(cfg.urgentIntervalMs, 60 * 1000),
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
  // 闲聊超时只关闭/归档对话，不踢群、不删除历史；归档接口不可用时才退回 soft close。
  const archiveChatSession = async (sessionId, reason) => {
    try {
      const registry = (ctx.get && ctx.get('workspaceRegistry')) || ctx.workspaceRegistry
      if (registry && typeof registry.archiveSession === 'function') {
        await registry.archiveSession(sessionId)
        logger.warn('闲聊超时：已归档会话 ' + shortSid(sessionId) + '（' + reason + '）')
        return true
      }
    } catch (error) {
      logger.warn('闲聊超时归档失败：' + (error && error.message ? error.message : error))
    }
    await closeSession(sessionId, reason)
    return true
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

  let injectedCompaction = null
  try {
    ctx.inject(['compaction'], (child) => { injectedCompaction = child.compaction || null })
  } catch { /* compaction is often a preset-scoped service */ }
  const identityStore = createIdentityStore(boardDir)
const officeStore = createOfficeStore(boardDir)
const pauseStore = createPauseStore(boardDir)
const councilStore = createCouncilStore(boardDir)
const inboxAckStore = createInboxAckStore(boardDir)
  const skillStore = createSkillStore(boardDir)
  const activityStore = createActivityStore(boardDir)
  // 用户在场心跳：只有星桥窗口可见且聚焦时由 app 上报，自动茶话会/自发闲聊必须依赖它。
  let lastUserPresenceAt = 0
  const USER_PRESENCE_TTL_MS = 15 * 60 * 1000
  const userPresent = () => Date.now() - lastUserPresenceAt < USER_PRESENCE_TTL_MS
  const relationStore = createRelationStore(boardDir)
  const maintainerStore = createMaintainerStore(boardDir)
  // ---------------------------------------------------------------- 权限分级（v2.9.1）
  // 维护者（maintainerStore 注册的会话）默认 protected/service：优先级最高，不接普通任务。
  const isMaintainerSession = (sessionId) => {
    const wanted = String(sessionId || '').trim()
    return Boolean(wanted) && maintainerStore.get() === wanted
  }
  const groupManagerIdsOf = (groups) =>
    new Set((Array.isArray(groups) ? groups : []).map((group) => group && group.managerSessionId).filter(Boolean))
  const activeCoordinatorIdsOf = () => {
    try {
      return new Set(
        store
          .readActive()
          .filter((entry) => entry.kind === 'task' && entry.coordinator && (entry.taskStatus || 'assigned') !== 'done')
          .map((entry) => entry.coordinator)
      )
    } catch {
      return new Set()
    }
  }
  /** 计算某个会话的保护级别（user/panel 不经过这里，直接视为最高级）。 */
  const protectionLevelOf = (sessionId, context = {}) => {
    if (!sessionId || sessionId === 'panel') return 'user'
    if (isMaintainerSession(sessionId)) return 'maintainer'
    const managerIds = context.managerIds instanceof Set ? context.managerIds : groupManagerIdsOf(groupStore.read())
    if (managerIds.has(sessionId)) return 'group-manager'
    const coordinatorIds = context.coordinatorIds instanceof Set ? context.coordinatorIds : activeCoordinatorIdsOf()
    if (coordinatorIds.has(sessionId)) return 'coordinator'
    return 'member'
  }
  const protectionOf = (sessionId, context = {}) => {
    const level = protectionLevelOf(sessionId, context)
    const protectedSession = level === 'maintainer'
    return {
      level,
      rank: PROTECTION_RANK[level] || 0,
      protected: protectedSession,
      service: protectedSession,
      label: PROTECTION_LABEL[level] || PROTECTION_LABEL.member
    }
  }
  const protectedSessionIdsNow = () => {
    const maintainerId = maintainerStore.get()
    return maintainerId ? [maintainerId] : []
  }
  const bugfixGroupOf = (groups) => {
    const list = Array.isArray(groups) ? groups : groupStore.read()
    return (
      list.find((group) => group && group.kind === BUGFIX_GROUP_KIND) ||
      list.find((group) => group && /修\s*bug/i.test(String(group.name || ''))) ||
      null
    )
  }
  const isBugfixGroup = (group) => Boolean(group) && (group.kind === BUGFIX_GROUP_KIND || /修\s*bug/i.test(String(group.name || '')))
  /** 判断正文是否像「派活/普通任务」而不是闲聊/探测。 */
  const textLooksLikeWork = (text) => {
    const source = String(text || '')
    return (
      /(请|需要|麻烦|帮忙)[^。\n]{0,16}(做|执行|核验|检查|复查|复核|重跑|重编|重绘|重新|修改|改|补|落实|审阅|审核|交付|提交|生成|排查|修复|跑|门禁|验收|复验|验证|确认|处理|整理|画|打包|实现|开发)/i.test(
        source
      ) ||
      /(最后一轮|最后一版|最后一遍|门禁|验收|复核|修改项|落实|交付|重跑|重编|补图|改稿|修图|实现一下|开发一下)/i.test(source)
    )
  }
  /** 判断正文是否像 bug 报告（修bug群里的普通消息按 bug 报告处理）。 */
  const textLooksLikeBugReport = (text) =>
    /(bug|BUG|Bug|报错|异常|崩溃|闪退|卡死|卡住|无响应|不能用|没反应|坏了|故障|错误|失败|修复|修一下|修下|修好|问题|缺陷|白屏|黑屏|报障|error|fail|crash|broken)/i.test(
      String(text || '')
    )
  const protectedRefusalText = (targetLabel, extraLines = []) =>
    [`维护者「${targetLabel}」是 protected/service 会话，不接普通任务/普通派活。`, ...extraLines, '', PROTECTED_TASK_ALTERNATIVES].join('\n')

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
  const officeForSession = (sessionId) => {
    const catalog = officeStore.catalog()
    const stored = officeStore.get(sessionId)
    const byName = (name) => catalog.find((item) => item.name === name) || catalog.find((item) => item.id === name)
    let hit = stored && stored.office ? byName(stored.office) : null
    if (!hit) {
      const groups = groupStore.read()
      const isManager = groups.some((group) => group && group.managerSessionId === sessionId)
      const name = isMaintainerSession(sessionId) ? '运维总管' : isManager ? '部门主管' : '专员'
      hit = byName(name) || catalog[catalog.length - 1]
    }
    return { office: hit.name, officeId: hit.id, officeLevel: hit.level, officeGrantedAt: stored?.grantedAt || 0, officeGrantedBy: stored?.grantedBy || '', officeNote: stored?.note || '' }
  }
  // 官职不是摆设：军功=信誉+完成数+被点赞+任期；专员可自动晋升部门主管，更高官职需审批。
  const officeLikesOf = (sessionId) => {
    try {
      const likes = reputationStore.read().likes
      let total = 0
      for (const byDay of Object.values(likes || {})) {
        for (const bucket of Object.values(byDay || {})) total += Number(bucket && bucket[sessionId] ? bucket[sessionId] : 0)
      }
      return total
    } catch { return 0 }
  }
  const officeMeritOf = (sessionId) => {
    const rep = reputationOf(sessionId)
    const tasks = store.readActive().filter((entry) => entry && entry.kind === 'task' && entry.taskStatus === 'done' && (entry.coordinator === sessionId || (Array.isArray(entry.assignees) && entry.assignees.includes(sessionId)) || entry.owner === sessionId))
    const record = officeStore.get(sessionId)
    const tenureDays = record && record.grantedAt ? Math.max(0, Math.floor((Date.now() - record.grantedAt) / 86400000)) : 0
    const likes = officeLikesOf(sessionId)
    const merit = Math.max(0, Math.round(Number(rep.points || 0) + Number(rep.successes || 0) * 5 - Number(rep.failures || 0) * 3 + tasks.length * 8 + likes * 2 + tenureDays))
    return { merit, completedTasks: tasks.length, likes, tenureDays, successes: Number(rep.successes || 0), failures: Number(rep.failures || 0) }
  }
  const officeProgressOf = (sessionId) => {
    const current = officeForSession(sessionId)
    const stats = officeMeritOf(sessionId)
    const next = OFFICE_PROMOTION_RULES.find((rule) => rule.from === current.office) || null
    return {
      ...current,
      ...stats,
      nextOffice: next ? next.to : '',
      nextMerit: next ? next.merit : 0,
      nextCompleted: next ? next.completed : 0,
      nextAuto: next ? next.auto === true : false,
      privileges: officePrivilegesOf(sessionId)
    }
  }
  const officePrivilegesOf = (sessionId) => {
    const level = officeForSession(sessionId).officeLevel || 10
    return {
      level,
      priorityRouting: level,
      canRecruit: level >= 60,
      canApproveTransfer: level >= 60,
      canPauseTask: level >= 90,
      technicalPriority: level >= 80
    }
  }
  const evaluateOfficePromotions = () => {
    const promoted = []
    const ids = new Set([...Object.keys(identityStore.read().sessions || {}), ...Object.keys(officeStore.read().sessions || {})])
    for (const sessionId of ids) {
      if (!sessionId || isMaintainerSession(sessionId)) continue
      const current = officeForSession(sessionId)
      if (current.office !== '专员') continue
      const stats = officeMeritOf(sessionId)
      const rule = OFFICE_PROMOTION_RULES.find((item) => item.from === '专员' && item.to === '部门主管')
      if (!rule) continue
      const completedWork = Math.max(stats.completedTasks, stats.successes)
      if (stats.merit < rule.merit || completedWork < rule.completed || stats.successes < rule.successes) continue
      const saved = officeStore.set(sessionId, {
        office: rule.to,
        officeId: 'dept',
        level: 60,
        grantedBy: 'promotion',
        note: '军功晋升：merit=' + stats.merit + '，完成任务=' + stats.completedTasks,
        promotionHistory: [...((officeStore.get(sessionId) && officeStore.get(sessionId).promotionHistory) || []), { from: current.office, to: rule.to, at: Date.now(), merit: stats.merit }]
      })
      promoted.push({ sessionId, office: rule.to, merit: stats.merit })
      try {
        const groups = groupStore.read()
        const group = groups.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))
        addEntry({ title: '军功晋升：' + (identityOf(sessionId) || {}).handle + ' → ' + rule.to, text: '军功值 ' + stats.merit + '，完成任务 ' + stats.completedTasks + '，按晋升通道授予「' + rule.to + '」。', kind: 'chat', groupId: group ? group.id : null, author: 'panel', origin: 'panel', skipDedupe: true }, 'panel')
      } catch { /* ignore */ }
    }
    return promoted
  }

  // 星桥小议会：由现有高官组成，接管新成员/世界任务审批；不新增会话。
  const COUNCIL_GROUP_NAME = '星桥 · 小议会'
  const ensureCouncil = async () => {
    let data = councilStore.read()
    let groups = groupStore.read()
    let group = groups.find((item) => item && (item.id === data.groupId || item.name === COUNCIL_GROUP_NAME))
    if (!data.members.length || !group) {
      const sessions = await buildSessionIndex()
      const ranked = sessions
        .filter((session) => session && session.closed !== true && session.protected !== true)
        .map((session) => ({ session, level: officeForSession(session.id).officeLevel || 10, merit: officeMeritOf(session.id).merit || 0 }))
        .filter((item) => item.level >= 60)
        .sort((a, b) => b.level - a.level || b.merit - a.merit)
        .slice(0, 3)
      const fallback = ranked.length ? ranked : sessions
        .filter((session) => session && session.closed !== true && session.protected !== true)
        .map((session) => ({ session, level: officeForSession(session.id).officeLevel || 10, merit: officeMeritOf(session.id).merit || 0 }))
        .sort((a, b) => b.level - a.level || b.merit - a.merit)
        .slice(0, 3)
      if (!fallback.length) return { ok: false, error: '没有可组成小议会的会话' }
      const members = fallback.map((item) => item.session.id)
      if (!group) {
        group = {
          id: 'g-council-' + Date.now().toString(36),
          name: COUNCIL_GROUP_NAME,
          kind: 'council',
          workspace: '',
          goal: '小议会：审核新成员招募与世界任务发布；多数票通过。',
          managerSessionId: members[0],
          sessionIds: members,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
        groups.push(group)
      } else {
        group.sessionIds = members
        group.managerSessionId = members[0]
        group.updatedAt = Date.now()
      }
      groupStore.write(groups)
      data = { ...data, groupId: group.id, chair: members[0], members, createdAt: data.createdAt || Date.now() }
      councilStore.write(data)
      addEntry({ title: '小议会成立', text: '小议会成员：' + members.map((id) => shortSid(id)).join('、') + '。负责审批新成员招募与世界任务发布，多数票通过。', kind: 'chat', groupId: group.id, author: 'panel', origin: 'panel', skipDedupe: true }, 'panel')
    }
    return { ok: true, data, group }
  }
  const notifyCouncilApproval = async (approval) => {
    if (!approval || approval.status !== 'pending' || approval.councilNotifiedAt) return
    const ensured = await ensureCouncil()
    if (!ensured.ok) return
    const { data, group } = ensured
    const request = addEntry({
      title: '议会审议：' + String(approval.title || approval.text || approval.id).slice(0, 30),
      text: ['待审批类型：' + String(approval.source || approval.engine || 'world'), '内容：' + String(approval.text || '').slice(0, 360), '原因：' + String(approval.reason || '')].join('\n'),
      kind: 'request',
      groupId: group.id,
      author: 'panel',
      requestTo: data.members,
      mentions: data.members,
      skipDedupe: true
    }, 'panel')
    approval.councilGroupId = group.id
    approval.councilRequestId = request.ok ? request.entry.id : ''
    approval.councilNotifiedAt = Date.now()
    const approvals = readApprovals()
    const idx = approvals.findIndex((item) => item && item.id === approval.id)
    if (idx >= 0) { approvals[idx] = approval; writeApprovals(approvals) }
    const message = [
      '【小议会审议 · 请投票】',
      '审批：' + String(approval.title || approval.id),
      '内容：' + String(approval.text || '').slice(0, 500),
      '',
      '用 council_vote action=vote approvalId=' + approval.id + ' vote=approve 或 reject 投票；多数票自动生效。'
    ].join('\n')
    const sessionsNowForCouncil = await buildSessionIndex()
    const councilById = new Map(sessionsNowForCouncil.map((session) => [session.id, session]))
    for (const memberId of data.members) {
      const memberNow = councilById.get(memberId)
      if (memberNow && memberNow.availability === 'busy') continue
      try { await ensureSessionLive(memberId); wakeSession(memberId, message, { requestId: approval.id }) } catch { /* ignore */ }
    }
  }
  const executeApprovedApproval = async (approval) => {
    try {
      if (approval.source === 'group.recruit' || approval.engine === 'group.recruit') {
        const group = groupStore.read().find((item) => item.id === approval.groupId)
        const payload = approval.payload || {}
        if (group) return await recruitMembers({ group, text: payload.text || approval.text, count: payload.count, mode: payload.mode, skills: payload.skills, requesterId: approval.requester || 'panel', origin: 'panel', approved: true, approvalId: approval.id })
      }
      return await executeCommand({ action: 'world.post', payload: { text: approval.text, approved: true, approvalId: approval.id, allowDuplicate: true } }, { actor: { kind: 'panel' } })
    } catch (error) {
      logger.warn('小议会批准执行失败：' + (error && error.message ? error.message : error))
      return { ok: false, error: error && error.message ? error.message : String(error) }
    }
  }
  const councilVote = async ({ approvalId, voter, vote, reason }) => {
    const ensured = await ensureCouncil()
    if (!ensured.ok) return ensured
    const { data } = ensured
    if (!data.members.includes(voter)) return { ok: false, error: '只有小议会成员可以投票' }
    const approvals = readApprovals()
    const approval = approvals.find((item) => item && item.id === approvalId)
    if (!approval) return { ok: false, error: '找不到待审批记录' }
    if (approval.status !== 'pending') return { ok: false, error: '该审批已处理：' + approval.status }
    approval.votes = { ...(approval.votes || {}), [voter]: { vote: vote === 'reject' ? 'reject' : 'approve', reason: String(reason || '').slice(0, 200), at: Date.now() } }
    const quorum = Math.max(1, Math.ceil(data.members.length / 2))
    const approveCount = Object.values(approval.votes).filter((item) => item.vote === 'approve').length
    const rejectCount = Object.values(approval.votes).filter((item) => item.vote === 'reject').length
    let outcome = 'pending'
    if (approveCount >= quorum) outcome = 'approved'
    else if (rejectCount >= quorum) outcome = 'rejected'
    if (outcome === 'approved') { approval.status = 'approved'; approval.approvedAt = Date.now(); approval.approvedBy = 'council' }
    if (outcome === 'rejected') { approval.status = 'rejected'; approval.rejectedAt = Date.now(); approval.rejectedBy = 'council' }
    writeApprovals(approvals)
    addEntry({ title: '小议会投票：' + (outcome === 'pending' ? '待定' : outcome === 'approved' ? '通过' : '驳回'), text: '审批：' + String(approval.title || approval.id) + '\n投票：' + voter + ' → ' + (vote === 'reject' ? '驳回' : '通过') + '\n当前：通过 ' + approveCount + ' / 驳回 ' + rejectCount + ' / 法定 ' + quorum, kind: 'chat', groupId: ensured.group.id, author: voter, origin: 'tool', skipDedupe: true }, 'tool')
    if (outcome === 'approved') await executeApprovedApproval(approval)
    return { ok: true, outcome, approveCount, rejectCount, quorum, approval }
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
    return { handle, avatar, role, skills, style, persona, ...officeForSession(sessionId) }
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
    // ---------------------------------------------------------------- 空闲看板（v2.9.0）
    // availability 完全由看板派生（不新增存储）：
    //  - 有「发给该会话且未回答的 request」→ busy；request 被 answer（status=answered）后自动回 idle；
    //  - 该会话是未完成群任务的 coordinator → 也视为 busy（正常情况下 coordinator request open 已覆盖）；
    //  - 记录 currentTask（谁占着）、openRequestCount、lastSubmittedAt（最近一次提交/交接时间）。
    const activeEntriesNow = store.readActive()
    const openRequestsBySession = new Map()
    const openTasksByCoordinator = new Map()
    const lastSubmittedBySession = new Map()
    for (const entry of activeEntriesNow) {
      if (!entry || typeof entry !== 'object') continue
      const isOpenRequest = entry.kind === 'request' && entry.status !== 'answered' && !entry.answeredBy
      if (isOpenRequest) {
        const targets = [
          ...new Set([
            ...(Array.isArray(entry.requestTo) ? entry.requestTo : []),
            ...(Array.isArray(entry.mentions) ? entry.mentions : [])
          ])
        ]
        for (const targetId of targets) {
          if (typeof targetId !== 'string' || !targetId || targetId === 'panel') continue
          if (!openRequestsBySession.has(targetId)) openRequestsBySession.set(targetId, [])
          openRequestsBySession.get(targetId).push(entry)
        }
      }
      if (entry.kind === 'task' && typeof entry.coordinator === 'string' && entry.coordinator && (entry.taskStatus || 'assigned') !== 'done') {
        if (!openTasksByCoordinator.has(entry.coordinator)) openTasksByCoordinator.set(entry.coordinator, [])
        openTasksByCoordinator.get(entry.coordinator).push(entry)
      }
      if (
        typeof entry.author === 'string' &&
        entry.author &&
        entry.author !== 'panel' &&
        (entry.kind === 'handoff' || entry.kind === 'decision')
      ) {
        const ts = toNumber(entry.answeredAt || entry.ts, 0)
        if (ts > (lastSubmittedBySession.get(entry.author) || 0)) lastSubmittedBySession.set(entry.author, ts)
      }
    }
    const availabilityOf = (sessionId, agentStatus) => {
      const requests = openRequestsBySession.get(sessionId) || []
      const tasks = openTasksByCoordinator.get(sessionId) || []
      const source = requests[0] || tasks[0] || null
      const running = String(agentStatus || '') === 'running'
      // v2.9.3：运行中的会话也算 busy（加急插话据此决定先打断；招募/世界路由据此避开），
      // 与 v2.9.0 的「空闲看板」字段保持同一套语义。
      if (!source && running) {
        return {
          availability: 'busy',
          currentTask: { id: '', title: '运行中', kind: 'running', role: '', since: 0, owner: '', taskScope: '', claimState: '' },
          openRequestCount: 0,
          lastSubmittedAt: lastSubmittedBySession.get(sessionId) || 0
        }
      }
      return {
        availability: source ? 'busy' : 'idle',
        currentTask: source
          ? {
              id: source.id,
              title: String(source.title || '').slice(0, 40),
              kind: requests[0] ? 'request' : 'task',
              role: String(source.taskRole || ''),
              since: toNumber(source.ts, 0),
              owner: source.kind === 'task' ? (typeof source.owner === 'string' ? source.owner : '') : source.owner || '',
              taskScope: source.taskScope || '',
              claimState: source.claimState || ''
            }
          : null,
        openRequestCount: requests.length,
        lastSubmittedAt: lastSubmittedBySession.get(sessionId) || 0
      }
    }
    // v2.9.1：保护级别需要「群管理 + 未完成任务的组长」两个上下文：一次读盘，循环里复用。
    // 组长集合直接复用上面 availability 的 openTasksByCoordinator（同为未完成 task 的 coordinator）。
    const coordinatorIdsNow = new Set(openTasksByCoordinator.keys())
    const protectionOfRecord = (sessionId) => protectionOf(sessionId, { managerIds, coordinatorIds: coordinatorIdsNow })
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
        const availability = availabilityOf(record.id, agent && agent.status)
        const protection = protectionOfRecord(record.id)
        const worldEligible =
          !internal &&
          !protection.protected &&
          repNow.closed !== true &&
          (Boolean(profilesNow[record.id] && profilesNow[record.id].summary) ||
            groupMemberIds.has(record.id) ||
            record.id === maintainerId)
        return {
          id: record.id,
          contactId: contactIdOf(record.id),
          title,
          handle: identity.handle,
          avatar: identity.avatar,
          role: identity.role,
          office: identity.office,
          officeLevel: identity.officeLevel,
          officeMerit: (officeProgressOf(record.id) || {}).merit || 0,
          officeNext: (officeProgressOf(record.id) || {}).nextOffice || '',
          officePrivileges: officePrivilegesOf(record.id),
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
          // v2.9.1 权限分级：protected/service 标记（维护者不参与自动路由）。
          protectionLevel: protection.level,
          protectionRank: protection.rank,
          protectionLabel: protection.label,
          protected: protection.protected,
          service: protection.service,
          worldEligible,
          // 用户显式 @ 仍可点名维护者（例外，宿主会给提示），所以单独给一个可解析标记。
          mentionEligible: !internal && (worldEligible || protection.protected),
          // v2.9.0 空闲看板（availability）与保护字段并存：busy 只表示忙碌，不改变 protected 语义。
          availability: availability.availability,
          currentTask: availability.currentTask,
          openRequestCount: availability.openRequestCount,
          lastSubmittedAt: availability.lastSubmittedAt,
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
    const activeEntriesForState = store.readActive()
    // task-6：先把「已 answered 的步骤请求」回写成步骤 done，任务线/任务卡/进度才实时（只在有变化时写盘）。
    try {
      syncCompletedTaskSteps(activeEntriesForState, Date.now())
    } catch {
      /* 步骤回写失败不影响 state 读取 */
    }
    const rules = activeEntriesForState.map((entry) => ({
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
    // 空闲/忙碌（v2.9.3）：兼容 task-2 的 availability 字段；没有时本地推导。
    const openRequestCountBySession = new Map()
    for (const entry of activeEntriesForState) {
      if (!entry || entry.kind !== 'request' || entry.status === 'answered' || entry.answeredBy) continue
      for (const sessionId of entry.requestTo || []) {
        openRequestCountBySession.set(sessionId, (openRequestCountBySession.get(sessionId) || 0) + 1)
      }
    }
    const sessions = (await buildSessionIndex()).map((session) => {
      const profile = profiles[session.id]
      const declared = session.availability
      const declaredState =
        typeof declared === 'string' ? declared : declared && typeof declared === 'object' ? declared.state : ''
      const openCount = openRequestCountBySession.get(session.id) || 0
      const availability =
        declaredState === 'idle' || declaredState === 'busy'
          ? declaredState
          : String(session.status || '') === 'running' || session.live !== true || openCount > 0
            ? 'busy'
            : 'idle'
      return {
        ...session,
        availability,
        openRequestCount: openCount,
        protected: isProtectedSession(session),
        hasProfile: Boolean(profile && profile.summary),
        profileDeclined: Boolean(profile && profile.declined)
      }
    })
    stateSessionsCache.length = 0
    stateSessionsCache.push(...sessions)
    // 任务线（task-6）：从活动看板派生，state 每轮轮询实时刷新（不额外写盘）。
    const pausesNow = pauseStore.read()
    const taskLines = buildTaskLines(activeEntriesForState, {
      now: Date.now(),
      sessionById: new Map(sessions.map((session) => [session.id, session])),
      groupNames,
      groups
    }).map((line) => {
      const pausedTask = pausesNow.tasks[line.taskId]
      const pausedLeader = line.leader && line.leader.id ? pausesNow.sessions[line.leader.id] : null
      if (!pausedTask && !pausedLeader) return line
      const hit = pausedTask || pausedLeader
      return { ...line, lineStatus: 'paused', paused: true, pauseReason: hit.reason || '', pausedAt: hit.pausedAt || 0 }
    })
    const taskLineStats = buildTaskLineStats(taskLines)
    const taskFlows = buildTaskFlows(activeEntriesForState, { sessionById: new Map(sessions.map((session) => [session.id, session])) })
    // task-7：完成通知数组（供星桥 app 轮询检测；未读由客户端按 lastSeen 时间戳计算）。
    const completionNotices = rules
      .filter((entry) => entry && entry.completionNotice === true)
      .map((entry) => {
        const authorSession = sessions.find((session) => session.id === entry.author)
        return {
          id: entry.id,
          taskId: entry.taskId || '',
          groupId: entry.groupId || '',
          groupName: entry.groupId ? groupNames.get(entry.groupId) || '' : '',
          title: entry.title || '',
          text: entry.text || '',
          author: entry.author || 'panel',
          authorHandle: authorSession ? authorSession.handle : entry.author === 'panel' ? '用户' : shortSid(entry.author),
          panelMention: entry.panelMention === true,
          completionNotice: true,
          completedAt: toNumber(entry.completedAt, 0) || toNumber(entry.ts, 0),
          ts: toNumber(entry.ts, 0)
        }
      })
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
      .slice(0, 50)
    const completionStats = {
      total: completionNotices.length,
      latestAt: completionNotices.length ? completionNotices[0].completedAt || completionNotices[0].ts : 0
    }
    const approvalsNow = readApprovals().filter((item) => item && item.status === 'pending')
    const pendingAsksNow = (() => { try { return pendingStore.read().filter((item) => item && item.status === 'queued') } catch { return [] } })()
    const inboxAcksNow = (() => { try { return inboxAckStore.read().acks || {} } catch { return {} } })()
    const panelAcked = new Set(Object.keys(inboxAcksNow.panel || {}))
    const inboxNow = buildInbox({ approvals: approvalsNow, requests: activeEntriesForState.filter((entry) => entry && entry.kind === 'request'), taskLines, pendingAsks: pendingAsksNow, completionNotices }, { now: Date.now(), groupNames, sessionById: new Map(sessions.map((session) => [session.id, session])), ackedIds: panelAcked })
    const computerResource = (() => { try { const base = path.join(process.env.LOCALAPPDATA || '', 'dsh-computer-use', 'lease'); const leaseFile = path.join(base, 'desktop-lease.json'); if (!fs.existsSync(leaseFile)) return { ok: true, available: false } ; const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8')); const owner = String(lease.owner || ''); const progress = owner ? officeProgressOf(owner) : null; return { ok: true, available: true, lease: { owner, label: lease.label || '', expiresAt: Number(lease.expires_at_ms || 0), ttlMs: Math.max(0, Number(lease.expires_at_ms || 0) - Date.now()) }, priority: progress ? progress.privileges.priorityRouting * 10000 + (progress.merit || 0) : 0, office: progress ? progress.office : '' } } catch { return { ok: false, available: false } } })()
    const commandCenter = { schemaVersion: '4.1.0', attentionCount: inboxNow.attentionCount, inboxCount: inboxNow.total, activeTasks: taskLines.filter((line) => ['active', 'waiting', 'stalled'].includes(line.lineStatus)).length, council: councilStore.read(), computer: computerResource }
    try {
      const councilNow = councilStore.read()
      const ambientState = { sessions, taskLines, taskFlows, inbox: inboxNow, approvals: approvalsNow, council: councilNow, computerResource }
      const ambientBlocks = new Map()
      for (const sessionNow of sessions) { const text = formatAmbientPrompt(buildAmbientFromState(ambientState, sessionNow.id)); if (text) ambientBlocks.set(sessionNow.id, text) }
      ambientPromptBySession = ambientBlocks
    } catch { /* ambient 缓存失败不影响 state */ }
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
    // v2.9.1：面板标记 + 修bug群状态（右侧栏/星桥窗口的按钮靠它显示「已创建/可创建」）。
    const bugfixGroup = bugfixGroupOf(groupStore.read())
    const bugfixOpenReports = bugfixGroup
      ? store
          .readActive()
          .filter((entry) => entry.groupId === bugfixGroup.id && entry.kind === 'request' && entry.status !== 'answered')
          .length
      : 0
    const bugfixInfo = {
      available: Boolean(maintainerId),
      exists: Boolean(bugfixGroup),
      groupId: bugfixGroup ? bugfixGroup.id : '',
      name: bugfixGroup ? bugfixGroup.name : BUGFIX_GROUP_NAME,
      managerSessionId: bugfixGroup ? bugfixGroup.managerSessionId || '' : maintainerId || '',
      memberCount: bugfixGroup ? (bugfixGroup.sessionIds || []).length : 0,
      openReports: bugfixOpenReports
    }
    const maintainerInfo = maintainerId
      ? {
          sessionId: maintainerId,
          ...maintainerIdentity,
          protectionLevel: 'maintainer',
          protectionLabel: PROTECTION_LABEL.maintainer,
          protected: true,
          service: true
        }
      : null
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
      schemaVersion: '4.1.0',
      defaultWorkspace: defaultWorkspaceForRule(),
      rules,
      groups,
      sessions,
      reputation,
      activity,
      relations,
      maintainer: maintainerInfo,
      bugfix: bugfixInfo,
      health,
      skills: skillStore.list(),
      profiles,
      offices: officeStore.read(),
      pauses: pauseStore.read(),
      council: councilStore.read(),
      officeCatalog: officeStore.catalog(),
      officePromotionRules: OFFICE_PROMOTION_RULES,
      world: worldEntriesOf(),
      // task-6：任务线看板（自动 5 阶段清单 + 实时状态 + 卡住催办记录）。
      taskLines,
      taskFlows,
      taskLineStats,
      // task-7：任务完成通知（组长在群里 @用户）与最新完成时间。
      completionNotices,
      completionStats,
      // v2.10.1：重复任务合并建议（只下发建议，UI 不自动删数据）。
      duplicates: collectDuplicateTaskGroups(rules),
      approvals: approvalsNow,
      inbox: inboxNow,
      commandCenter,
      computerResource,
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
        wakeSessions: Boolean(createUserMessage),
        // v2.9.1：修bug群一键创建/复用（需要已注册维护者）。
        bugfixGroup: Boolean(maintainerId),
        protectionLevels: PROTECTION_LEVELS.slice(),
        /** v2.9.2：宿主是否提供直接打断能力（cancel/interrupt/abort/stop），空串=不支持。 */
        interrupt: detectHostInterruptMethod() || '',
        retract: true
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
  /**
   * task-9：无人 @ 且没有 focus/群管理时，按文本与成员的 title/role/skills/handle 匹配度选对话负责人。
   * 平局优先 idle、低 openRequestCount；维护者/protected 不作为普通对话对象（用户显式 @ 才例外）。
   */
  const pickMemberForText = (text, sessions) => {
    const tokens = [...titleTokensOf(text)]
    const candidates = (Array.isArray(sessions) ? sessions : []).filter(
      (session) => session && session.id && session.protected !== true
    )
    if (!candidates.length) return null
    let best = null
    let bestScore = Number.NEGATIVE_INFINITY
    const source = String(text || '')
    for (const session of candidates) {
      const identity = identityOf(session.id, session.title)
      const haystack = [session.title, identity.role, (identity.skills || []).join(' '), identity.handle]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      let score = 0
      for (const token of tokens) if (token.length >= 2 && haystack.includes(token)) score += 2
      for (const tag of identity.skills || []) if (tag && source.includes(tag)) score += 3
      if (identity.handle && source.includes(identity.handle)) score += 4
      if (session.title && source.includes(String(session.title))) score += 3
      score += session.availability === 'busy' ? -1 : 1
      score -= Math.min(3, toNumber(session.openRequestCount, 0)) * 0.5
      if (score > bestScore) {
        bestScore = score
        best = session
      }
    }
    return best
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

  const ambientPromptFor = (sessionId) => ambientPromptBySession.get(sessionId) || ''
  const renderForAgent = (agent) => {
    try {
      if (!agent) return ''
      if (!isRootAgent(agent)) return ''
      const info = sessionInfoOf(agent)
      if (!info.id) return ''
      const broadcast = cfg.injectMode === 'broadcast'
      if (!broadcast) {
        // v0.7 默认：定向注入——没被问到的成员不注入任何群信息，只保留「未申报」小提示。
        return [renderTargeted(info).join('\n'), ambientPromptFor(info.id)].filter(Boolean).join('\n\n')
      }
      const groups = groupStore.read()
      const myGroups = groups.filter((group) => Array.isArray(group.sessionIds) && group.sessionIds.includes(info.id))
      const entries = visibleEntries(info).slice(0, cfg.maxShown)
      const briefLines = buildGroupBriefLines(myGroups)
      if (!entries.length && !briefLines.length) return ambientPromptFor(info.id)
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
      const ambientNow = ambientPromptFor(info.id)
      if (ambientNow) lines.push(ambientNow)
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
    const text = String(input.text || '').trim().slice(0, BOARD_TEXT_LIMIT)
    const closing = parseClosingFormat(`${title}\n${text}`)
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

    const linkedTask =
      typeof input.taskId === 'string' && input.taskId
        ? active.find((item) => item && item.id === input.taskId && item.kind === 'task') || null
        : null
    const taskScope = normalizeTaskScope(
      input.taskScope || input.scopeText || input.workScope || (linkedTask && linkedTask.taskScope),
      `${title} ${text}`
    )
    const owner =
      (typeof input.owner === 'string' && input.owner) ||
      (kind === 'task'
        ? input.coordinator || (Array.isArray(input.assignees) ? input.assignees[0] : '') || ''
        : linkedTask
          ? taskOwnerOf(linkedTask) || (Array.isArray(input.requestTo) ? input.requestTo[0] : '') || ''
          : (Array.isArray(input.requestTo) ? input.requestTo[0] : '') || '')
    const ownerRole =
      typeof input.ownerRole === 'string' && input.ownerRole
        ? input.ownerRole
        : owner && owner === input.coordinator
          ? 'coordinator'
          : owner
            ? kind === 'task'
              ? 'assignee'
              : 'recipient'
            : ''
    const claimedAt = toNumber(input.claimedAt, owner ? now : 0)
    const claimState =
      typeof input.claimState === 'string' && input.claimState ? input.claimState : owner ? 'assigned' : 'unclaimed'

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
      // 世界任务标记需要落盘，24h 查重和完成汇总都靠它识别「这是世界任务」。
      ...(input.worldTask === true ? { worldTask: true } : {}),
      // task-7 任务完成通知：completionNotice 标记 + 用户（panel）提及标记（聊天 @ 只渲染会话，用户需单独标 @你）。
      ...(input.completionNotice === true
        ? {
            completionNotice: true,
            completedAt: toNumber(input.completedAt, 0) || now,
            panelMention: input.panelMention !== false
          }
        : input.panelMention === true
          ? { panelMention: true }
          : {}),
      // task-8 统一收尾：从【收尾】块提取状态/下一步；需要用户=是 时点亮 @你。
      ...(closing
        ? { closingStatus: closing.status, closingNext: closing.next, closingNeedUser: closing.needUser }
        : {}),
      ...(closing && closing.needUser ? { panelMention: true } : {}),
      hiddenFromChat: input.hiddenFromChat === true,
      nudge: input.nudge === true,
      // 加急插话标记（v2.9.3）：UI 用它显示 ⚡ 徽章，urgentTo 便于审计「加急给谁」。
      urgent: input.urgent === true,
      ...(input.urgent === true
        ? {
            urgentTo: Array.isArray(input.urgentTo)
              ? [...new Set(input.urgentTo.filter((item) => typeof item === 'string' && item))].slice(0, 8)
              : Array.isArray(input.requestTo)
                ? [...new Set(input.requestTo.filter((item) => typeof item === 'string' && item))].slice(0, 8)
                : [],
            urgentBy: typeof input.urgentBy === 'string' ? input.urgentBy : input.author || ''
          }
        : {}),
      curated: input.curated === true,
      // v2.10.1：非 owner 的回复只作为 proposal；scope 超界时只提示、不自动扩展。
      ...(input.proposal === true ? { proposal: true } : {}),
      ...(typeof input.taskVerdict === 'string' && input.taskVerdict ? { taskVerdict: input.taskVerdict } : {}),
      ...(typeof input.scopeWarning === 'string' && input.scopeWarning ? { scopeWarning: input.scopeWarning } : {}),
      taskId: typeof input.taskId === 'string' ? input.taskId : '',
      ...(typeof input.transferCandidateId === 'string' && input.transferCandidateId ? { transferCandidateId: input.transferCandidateId, transferTaskId: typeof input.transferTaskId === 'string' ? input.transferTaskId : input.taskId || '', transferReason: String(input.transferReason || '').slice(0, 300), transferStatus: 'pending' } : {}),
      taskRole: typeof input.taskRole === 'string' ? input.taskRole : '',
      // 任务归属锁 + 工作范围（v2.10.1）：task/request 一律带 owner 与 taskScope。
      ...(kind === 'task' || kind === 'request'
        ? {
            owner,
            ownerRole,
            claimedAt: claimedAt > 0 ? claimedAt : 0,
            claimState,
            taskScope
          }
        : {}),
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

  // ---------------------------------------------------------------- 任务完成通知（task-7 / v2.10.3）
  /** 某任务的完成通知条目（幂等判据：completionNotice=true 且 taskId 相同）。 */
  const completionNoticeOf = (taskId) => {
    const wanted = String(taskId || '')
    if (!wanted) return null
    try {
      return (
        store.readActive().find((entry) => entry && entry.completionNotice === true && entry.taskId === wanted) || null
      )
    } catch {
      return null
    }
  }
  /**
   * 任务 done 时在所属群生成一条「完成通知」：作者=组长/coordinator（无则 owner/panel），
   * 内容含任务标题/完成时间，并通过 panelMention 在群里 @用户（panel 不是会话，聊天流需要单独标记）。
   * 幂等：同一 taskId 只生成一条；未完成（非 done）/已撤回不生成。
   * 无群的世界任务写世界流（channel=world）；既无群也无世界标记则跳过，避免污染工作区经验板。
   */
  const ensureTaskCompletionNotice = (taskId, options = {}) => {
    const task = findBoardEntry(taskId)
    if (!task || task.kind !== 'task') return { ok: false, reason: 'task-not-found' }
    if (String(task.taskStatus || '') !== 'done') return { ok: false, reason: 'not-done' }
    if (task.mergedInto) return { ok: false, reason: 'merged' }
    const existing = completionNoticeOf(task.id)
    if (existing) return { ok: true, skipped: true, entry: existing }
    const ownerId = taskOwnerOf(task)
    const authorId = ownerId || (typeof task.author === 'string' && task.author !== 'panel' ? task.author : 'panel')
    let authorName = authorId === 'panel' ? '用户' : shortSid(authorId)
    if (authorId !== 'panel') {
      try {
        const identity = identityOf(authorId, identityTitleOf(authorId))
        if (identity && identity.handle) authorName = identity.handle
      } catch {
        /* identity 读取失败时用短 id */
      }
    }
    const completedAt =
      toNumber(options.completedAt, 0) || toNumber(task.completedAt, 0) || toNumber(task.doneAt, 0) || Date.now()
    const group = task.groupId ? groupStore.read().find((item) => item.id === task.groupId) || null : null
    const isWorldNotice = !group && task.worldTask === true
    if (!group && !isWorldNotice) {
      // 没有群、也不是世界任务：没有合适的投递面（避免污染工作区经验板）。
      return { ok: false, reason: 'no-channel' }
    }
    const text = [
      '🎉 任务完成通知',
      `任务：${task.title || '未命名任务'}`,
      `组长：${authorName}${authorId !== 'panel' ? '（contactId=' + contactIdOf(authorId) + '）' : ''}`,
      `完成时间：${stableStamp(completedAt)}`,
      ...(group ? [`群组：${group.name}`] : ['（世界任务·无群消息）']),
      ...(Array.isArray(task.assignees) && task.assignees.length
        ? [`参与成员：${task.assignees.map((id) => shortSid(id)).join('、')}`]
        : []),
      '',
      '（系统在任务完成时自动生成的完成通知，无需重复回复；点击通知可跳到对应群/组长。）'
    ].join('\n')
    const mentionIds = [
      ...new Set([
        ...(authorId !== 'panel' ? [authorId] : []),
        ...(Array.isArray(task.assignees) ? task.assignees : [])
      ])
    ].slice(0, 12)
    const result = addEntry(
      {
        title: ('任务完成：' + String(task.title || '群任务')).slice(0, 40),
        text,
        kind: 'chat',
        groupId: group ? group.id : '',
        ...(group ? {} : { scope: 'global', channel: 'world' }),
        workspace: (group && group.workspace) || task.workspace || '',
        author: authorId,
        origin: authorId === 'panel' ? 'panel' : 'tool',
        mentions: mentionIds,
        completionNotice: true,
        panelMention: true,
        completedAt,
        taskId: task.id,
        tags: '@完成通知',
        skipDedupe: true
      },
      authorId === 'panel' ? 'panel' : 'tool'
    )
    if (!result.ok) return { ok: false, reason: result.reason || 'write-failed' }
    logger.info(
      `任务完成通知：${task.id}（${truncate(task.title, 24)}）→ ${group ? '群「' + group.name + '」' : '世界流'}，@用户`
    )
    return {
      ok: true,
      created: true,
      entry: result.entry,
      groupId: group ? group.id : '',
      groupName: group ? group.name : ''
    }
  }

  // ---------------------------------------------------------------- 任务线巡检（task-6 / v2.10.2）
  /** 回写任务线派生状态（只 patch 变化字段，避免每轮巡检都写盘）。 */
  const patchTaskLine = (taskId, patch, now = Date.now()) => {
    if (!taskId || !patch || !Object.keys(patch).length) return false
    try {
      appendEvents(boardDir, [{ op: 'task', id: taskId, patch, ts: now }])
      return true
    } catch (error) {
      logger.warn(`任务线状态回写失败：${error && error.message ? error.message : error}`)
      return false
    }
  }
  /**
   * 任务线巡检：派生状态回写 + 卡住自动催办。
   * - 只写看板 nudge（targeted 注入，不唤醒、不打断），复用现有 session_nudge 同一套机制；
   * - 同一任务线两次催办至少间隔 TASK_LINE_STALL_MS，最多 TASK_LINE_MAX_NUDGES 次；
   * - 跳过维护者/protected 会话；完成/撤回的任务线不再催办。
   */
  const runTaskLineWatch = ({ now = Date.now(), nudge = true, persist = true, source = 'timer' } = {}) => {
    const report = { source, scanned: 0, stalled: 0, nudged: [], skippedProtected: [], patched: 0, errors: [] }
    try {
      const active = store.readActive()
      // 先同步「已 answered 的步骤请求 → 步骤 done」，再派生任务线，巡检与面板读到的进度一致。
      try {
        syncCompletedTaskSteps(active, now)
      } catch {
        /* 步骤回写失败不阻塞巡检 */
      }
      const sessions = stateSessionsCache.length ? stateSessionsCache : []
      const lines = buildTaskLines(active, {
        now,
        sessionById: new Map(sessions.map((session) => [session.id, session])),
        groupNames: groupNameMap(),
        groups: groupStore.read()
      })
      report.scanned = lines.length
      const byId = new Map(active.map((entry) => [entry.id, entry]))
      for (const line of lines) {
        if (pauseStore.isPaused('tasks', line.taskId) || (line.leader && line.leader.id && pauseStore.isPaused('sessions', line.leader.id))) continue
      if (!['waiting', 'active', 'stalled'].includes(line.lineStatus)) continue
        const task = byId.get(line.taskId)
        if (!task) continue
        if (line.lineStatus === 'stalled') report.stalled += 1
        if (!persist) continue
        // ① 派生状态回写（只在变化时写）：lineStatus / lastProgressAt / currentStep / stalledSince。
        const patch = {}
        // 老任务没有 steps（功能上线前创建）→ 首次巡检把自动 5 阶段清单补落盘，之后 taskLines/任务卡一致。
        if (!Array.isArray(task.steps) || !task.steps.length) patch.steps = line.steps
        if (String(task.lineStatus || '') !== line.lineStatus) patch.lineStatus = line.lineStatus
        const prevProgressAt = toNumber(task.lineLastProgressAt, 0)
        if (line.lastProgressAt > prevProgressAt) {
          patch.lineLastProgressAt = line.lastProgressAt
          // 有新进展 → 视为新一轮，催办计数归零（但保留历史 lastNudgeAt 供 UI 展示）。
          if (toNumber(task.lineNudgeCount, 0) > 0) patch.lineNudgeCount = 0
        }
        if (toNumber(task.lineCurrentStep, 0) !== line.currentStep) patch.lineCurrentStep = line.currentStep
        if (line.lineStatus === 'stalled') {
          if (line.stalledSince && toNumber(task.lineStalledSince, 0) !== line.stalledSince) {
            patch.lineStalledSince = line.stalledSince
          }
        } else if (toNumber(task.lineStalledSince, 0) > 0) {
          patch.lineStalledSince = 0
        }
        if (Object.keys(patch).length) {
          if (patchTaskLine(line.taskId, patch, now)) report.patched += 1
        }
        // ② 卡住催办：写 nudge（不唤醒），限频 + 上限 + 跳过 protected。
        if (!nudge || line.lineStatus !== 'stalled') continue
        const leaderId = line.leaderId || ''
        if (!leaderId) continue
        if (isProtectedSession(leaderId)) {
          report.skippedProtected.push(line.taskId)
          continue
        }
        const count = toNumber(task.lineNudgeCount, line.nudgeCount)
        if (count >= TASK_LINE_MAX_NUDGES) continue
        const lastNudgeAt = toNumber(task.lineLastNudgeAt, line.lastNudgeAt)
        if (lastNudgeAt > 0 && now - lastNudgeAt < TASK_LINE_STALL_MS) continue
        // 兜底查重：同一任务线最近 25 分钟内已经有过催办条目（可能上次 patch 未落盘）。
        const duplicateNudge = active.some(
          (entry) =>
            entry &&
            entry.nudge === true &&
            entry.taskId === line.taskId &&
            Math.abs(now - toNumber(entry.ts, 0)) < TASK_LINE_STALL_MS
        )
        if (duplicateNudge) continue
        const leader = line.leader || {}
        const handle = leader.handle || leader.title || shortSid(leaderId)
        const currentStepText = line.currentStepText || '任务进行中'
        const staleMinutes = Math.max(1, Math.round((now - (line.lastProgressAt || now)) / 60000))
        const nudgeText = [
          '【任务线催办 · 不唤醒，下次处理时看】',
          `任务：${line.title}${line.groupName ? '（群组「' + line.groupName + '」）' : ''}`,
          `当前阶段：${currentStepText} · 进度 ${line.progress}%（已完成 ${line.steps.filter((step) => step.status === 'done').length}/${line.steps.length}）`,
          `已经 ${staleMinutes} 分钟没有进度更新，任务线被标记为「卡住」。`,
          '请先回一句进度/卡点（有请求可 replyTo 交付）；如果其实已完成，请在任务卡标记完成或撤回，避免继续占用。',
          line.replyRequestId ? `关联请求：${line.replyRequestId}（回复即视为一次进度）` : ''
        ]
          .filter(Boolean)
          .join('\n')
        const nudgeEntry = addEntry(
          {
            title: '任务线催办：' + truncate(line.title, 18),
            text: nudgeText,
            kind: 'note',
            groupId: line.groupId || '',
            workspace: (line.groupId ? (groupStore.read().find((group) => group.id === line.groupId) || {}).workspace : '') || String(task.workspace || ''),
            author: 'panel',
            origin: 'panel',
            requestTo: [leaderId],
            mentions: [leaderId],
            hiddenFromChat: true,
            nudge: true,
            taskId: line.taskId,
            tags: '@任务线',
            skipDedupe: true
          },
          'panel'
        )
        if (!nudgeEntry.ok) {
          report.errors.push(`${line.taskId}: ${nudgeEntry.reason || 'nudge 写入失败'}`)
          continue
        }
        patchTaskLine(
          line.taskId,
          {
            lineNudgeCount: count + 1,
            lineLastNudgeAt: now,
            lineStatus: 'stalled',
            lineStalledSince: line.stalledSince || line.lastProgressAt + TASK_LINE_STALL_MS
          },
          now
        )
        report.nudged.push({ taskId: line.taskId, leaderId, count: count + 1 })
        logger.info(
          `任务线催办：${line.taskId}（${truncate(line.title, 24)}）→ ${shortSid(leaderId)}，第 ${count + 1}/${TASK_LINE_MAX_NUDGES} 次`
        )
      }
      if (report.nudged.length || report.errors.length) {
        logger.info(
          `任务线巡检（${source}）：${report.scanned} 条任务线，卡住 ${report.stalled} 条，催办 ${report.nudged.length} 条${report.errors.length ? '，错误 ' + report.errors.length + ' 条' : ''}`
        )
      }
    } catch (error) {
      report.errors.push(error && error.message ? error.message : String(error))
      logger.warn(`任务线巡检失败：${error && error.message ? error.message : error}`)
    }
    return report
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

  // 恢复会话时的良性竞态：会话已在别处活跃（被写句柄占用），或宿主上下文已关闭。
  // 这两种情况重试也不会成功，属于预期路径，只记 info，不再刷 warn。
  const BENIGN_RESUME_ERROR = /already owned by an active (?:write )?handle|already (?:live|active|open)|inactive context|cannot get required service .*agents/i
  const isBenignResumeError = (message) => BENIGN_RESUME_ERROR.test(String(message || ''))

  /** 找到会话当前的 live agent：agents.get 偶尔会漏（被别的写句柄占用时），再查 list 兜底。 */
  const liveAgentOf = (sessionId) => {
    if (!sessionId) return undefined
    try {
      const direct = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(sessionId) : undefined
      if (direct) return direct
    } catch {
      /* ignore */
    }
    try {
      const all = ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() : []
      return all.find((agent) => agent && agent.id === sessionId)
    } catch {
      return undefined
    }
  }

  // ---------------------------------------------------------------- agent preset（核心工具的挂载点）
  //
  // DSH 的 Web 面把「agent 平面」整体挪到了 agent preset 后面：read/write/edit/pwsh/glob/grep/job_* /
  // web_* / subagent / skill / todo / present / ask_user_question 等 27 个核心工具，都是会话挂上 preset
  // 之后才注册进这个 agent 的。宿主的 SessionController.composeAgent() 会在 create/resume 的 setup 里
  // mount preset；插件若直接调 ctx.agents.create()/resume()（本插件历史上就是这么干的），agent 就只有
  // 宿主面注册的工具（session_*/group_*、office/ppt、wechat 等），核心工具一个都没有 —— 这就是用户
  // 看到的「工具被莫名其妙剥夺」。下面这些 helper 把 create/resume 的 setup 补齐到与宿主同款：
  // 先装模型选择，再挂 preset；另外给「已经活着但漏挂 preset」的会话做一次补救（recompose）。
  // 宿主把 agent preset 服务发布得比本插件晚（冷启动竞态），所以这里用可选注入捕获它，并在需要时等待。
  let agentPresetsService = null
  const agentPresetsWaiters = []
  try {
    ctx.inject(['agentPresets'], (child) => {
      agentPresetsService = child.agentPresets || (child.get && child.get('agentPresets')) || null
      for (const notify of agentPresetsWaiters.splice(0)) notify(agentPresetsService)
    })
  } catch {
    /* ignore */
  }

  const agentPresetService = () => {
    if (agentPresetsService) return agentPresetsService
    try {
      return (ctx.get && ctx.get('agentPresets')) || null
    } catch {
      return null
    }
  }

  /** 等宿主把 agent preset 服务挂上来（冷启动时本插件可能先加载）；超时返回 null。 */
  const waitForAgentPresetService = (timeoutMs = 15000) =>
    new Promise((resolve) => {
      const current = agentPresetService()
      if (current) return resolve(current)
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      agentPresetsWaiters.push(finish)
      const timer = setTimeout(() => finish(agentPresetService()), timeoutMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
    })

  /** 读会话已选的 preset（projection 里没有时返回 undefined，让宿主用默认 preset）。 */
  const agentPresetIdOfSession = (session) => {
    try {
      const projections = (ctx.get && ctx.get('sessionProjections')) || ctx.sessionProjections
      if (!projections || typeof projections.stateOf !== 'function' || !session) return undefined
      const preset = projections.stateOf(session, 'agentPreset')
      return typeof preset === 'string' && preset ? preset : undefined
    } catch {
      return undefined
    }
  }

  /** 解析 preset：宿主行还没就绪时短暂等待；会话记录的 preset 被删掉时回退默认（与宿主 composeAgent 同策略）。 */
  const resolveAgentPreset = async (presets, presetId) => {
    const tryResolve = async (wanted) => {
      let lastError = null
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          return await presets.resolve(wanted)
        } catch (error) {
          lastError = error
          const code = error && error.code
          if (code !== 'agent-preset/not-found' || attempt >= 39) throw error
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
      throw lastError || new Error('agent preset 不可用')
    }
    try {
      return await tryResolve(presetId)
    } catch (error) {
      if (presetId === undefined || (error && error.code !== 'agent-preset/not-found')) throw error
      logger.warn(`preset「${presetId}」已不可用，回退默认 preset 继续恢复`)
      return await tryResolve(undefined)
    }
  }

  /**
   * 生成 agents.create/resume 的 setup：装模型选择 + 挂 agent preset（核心工具）。
   * preset 服务晚就绪时先等它；实在等不到才退回旧行为（只装模型选择），并留下 warn 方便排查。
   */
  const buildAgentSetup = (options = {}) => {
    const selection = options.selection
    const wantsSelection = Boolean(installModelSelection && selection)
    return async (agentCtx, agent) => {
      if (wantsSelection) installModelSelection(agentCtx, { current: selection })
      const presets = await waitForAgentPresetService(15000)
      if (!presets) {
        logger.warn('agent preset 服务 15s 内不可用：本次 create/resume 未挂 preset，核心工具会缺失')
        return
      }
      const session = (agent && agent.session) || options.session
      const presetId = options.presetId !== undefined ? options.presetId : agentPresetIdOfSession(session)
      const resolved = await resolveAgentPreset(presets, presetId)
      const mounted = await presets.mount(agentCtx, resolved.id)
      if (resolved.broken) {
        logger.warn(`preset「${resolved.id}」有不可用行，核心工具可能不全：${String(resolved.broken).slice(0, 200)}`)
      }
      // 插件自建的新会话没有 header.agentPreset：补一条选择事件，之后宿主按同一 preset 恢复。
      if (options.recordPreset && mounted && agent && agent.session && typeof agent.session.append === 'function') {
        try {
          agent.session.append('agent-preset/selected', { agentPreset: mounted.id })
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** 给「活着但漏挂 preset」的 agent 补挂；recompose 会发 tools/change，下个回合核心工具就回来了。 */
  const repairPresetForLiveAgent = async (agent) => {
    const presets = await waitForAgentPresetService(3000)
    if (!presets || !agent || !agent.ctx) return { ok: false, reason: 'no-preset-service' }
    try {
      if (typeof presets.composedPreset === 'function' && presets.composedPreset(agent.ctx) !== undefined) {
        return { ok: true, skipped: true }
      }
    } catch {
      /* ignore */
    }
    const resolved = await resolveAgentPreset(presets, agentPresetIdOfSession(agent.session))
    if (typeof presets.recompose === 'function') await presets.recompose(agent.ctx, resolved.id)
    else await presets.mount(agent.ctx, resolved.id)
    return { ok: true, preset: resolved.id }
  }

  /** 巡检一轮所有 live 会话，把漏挂 preset 的补上；返回被修复的 [{session, preset}]。 */
  const repairPresetForLiveSessions = async (source) => {
    const presets = await waitForAgentPresetService(3000)
    if (!presets) {
      logger.info(`preset 修复巡检（${source}）：agent preset 服务不可用，跳过`)
      return []
    }
    let agents = []
    try {
      agents = ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() : []
    } catch {
      agents = []
    }
    const repaired = []
    for (const agent of agents) {
      if (!agent || !agent.session || !agent.ctx) continue
      // 只修根会话：子 agent（delegationDepth > 0）的 preset 由父 agent 的 revision 继承，不在这里重挂。
      const depth = agent.session.header ? agent.session.header.delegationDepth : 0
      if (typeof depth === 'number' && depth > 0) continue
      try {
        const outcome = await repairPresetForLiveAgent(agent)
        if (outcome && outcome.ok && !outcome.skipped) {
          repaired.push({ session: shortSid(agent.id || agent.session.id || ''), preset: outcome.preset })
        }
      } catch (error) {
        logger.warn(`补挂 preset 失败（${shortSid(agent.id || '')}）：${error && error.message ? error.message : error}`)
      }
    }
    logger.info(
      `preset 修复巡检（${source}）：live=${agents.length}，补挂=${repaired.length}` +
        (repaired.length > 0 ? `（${repaired.map((item) => `${item.session}->${item.preset}`).join('、')}）` : '')
    )
    return repaired
  }

  /** 唤醒一个在线会话（followup 会开一轮并让它处理消息）；不在线返回 not-live。 */
  const wakeSession = (sessionId, text, meta = {}) => {
    try {
      const agent = liveAgentOf(sessionId)
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

  // 闲聊限时回复：到点未回先警告，宽限期后仍未回才关闭对话；protected/维护者/群管理不关。
  const DISCUSSION_REPLY_TIMEOUT_MS = 120000
  const DISCUSSION_REPLY_GRACE_MS = 60000
  const discussionWatchTimers = new Map()
  const hasDiscussionReplySince = (groupId, sessionId, sinceTs) =>
    store.readActive().some(
      (entry) =>
        entry &&
        entry.author === sessionId &&
        Number(entry.ts || 0) >= sinceTs &&
        entry.hiddenFromChat !== true &&
        ((entry.groupId === groupId && entry.kind === 'chat') || entry.kind === 'bug')
    )
  const discussionTargetProtected = (sessionId, group) => {
    if (!sessionId) return true
    if (isMaintainerSession(sessionId)) return true
    if (group && group.managerSessionId === sessionId) return true
    try {
      const protection = protectionOf(sessionId)
      if (protection && protection.protected === true) return true
    } catch { /* ignore */ }
    return false
  }
  const watchDiscussionReply = ({ group, topic, targets, sinceTs, timeoutMs, graceMs }) => {
    if (!group || !Array.isArray(targets) || targets.length === 0) return
    const entryTopic = String(topic || '讨论').slice(0, 30)
    const waitMs = Math.max(30000, Math.min(600000, Number(timeoutMs) || DISCUSSION_REPLY_TIMEOUT_MS))
    const grace = Math.max(30000, Math.min(300000, Number(graceMs) || DISCUSSION_REPLY_GRACE_MS))
    for (const target of targets) {
      const sessionId = target && target.id ? target.id : String(target || '')
      if (!sessionId || discussionTargetProtected(sessionId, group)) continue
      const watchId = group.id + ':' + sessionId + ':' + sinceTs
      if (discussionWatchTimers.has(watchId)) continue
      const warnTimer = setTimeout(async () => {
        discussionWatchTimers.delete(watchId)
        try {
          if (hasDiscussionReplySince(group.id, sessionId, sinceTs)) return
          const current = (await buildSessionIndex()).find((session) => session.id === sessionId)
          const label = current ? current.handle || current.title || shortSid(sessionId) : shortSid(sessionId)
          addEntry(
            {
              title: '闲聊超时警告：' + entryTopic,
              text: '@' + label + ' 你还没参与这次闲聊。限时已到；' + Math.round(grace / 1000) + ' 秒内回一两句、或顺手提个 bug 都可以，但不要直接开始干活/执行任务；再不回应将关闭你的对话。',
              kind: 'chat',
              groupId: group.id,
              author: 'panel',
              mentions: [sessionId],
              tags: '@警告,@闲聊限时',
              skipDedupe: true
            },
            'panel'
          )
          await ensureSessionLive(sessionId)
          wakeSession(sessionId, '【闲聊限时警告】刚才的讨论还没见你参与。回一两句话，或顺手提个 bug 都可以；不要直接开始干活/读写文件/执行任务；' + Math.round(grace / 1000) + ' 秒内不回复将关闭对话。', {})
          const closeTimer = setTimeout(async () => {
            try {
              if (hasDiscussionReplySince(group.id, sessionId, sinceTs)) return
              if (discussionTargetProtected(sessionId, group)) return
              await archiveChatSession(sessionId, '闲聊限时未回应（警告后仍无闲聊或 bug 反馈）')
              addEntry(
                {
                  title: '闲聊超时关闭：' + entryTopic,
                  text: '成员 ' + label + ' 在警告宽限期后仍未回复，已关闭对话并移出群。',
                  kind: 'chat',
                  groupId: group.id,
                  author: 'panel',
                  tags: '@关闭,@闲聊限时',
                  skipDedupe: true
                },
                'panel'
              )
            } catch (error) {
              logger.warn('闲聊超时关闭失败：' + (error && error.message ? error.message : error))
            }
          }, grace)
          closeTimer.unref?.()
        } catch (error) {
          logger.warn('闲聊超时检查失败：' + (error && error.message ? error.message : error))
        }
      }, waitMs)
      warnTimer.unref?.()
      discussionWatchTimers.set(watchId, warnTimer)
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

  // ---------------------------------------------------------------- 撤回 / 打断（v2.9.2）
  // 面板用户（panel）拥有全量权限；会话调用（工具）按 维护者 > 群管理（仅本群）> 作者（仅自己未处理）> 普通成员 分级。
  /** 统一调用者：{kind:'panel'|'session', sessionId, label}。 */
  const actorOf = (rawActor) => {
    const actor = rawActor && typeof rawActor === 'object' ? rawActor : {}
    if (actor.kind === 'session' && typeof actor.sessionId === 'string' && actor.sessionId.trim()) {
      const sessionId = actor.sessionId.trim()
      return { kind: 'session', sessionId, label: sessionId }
    }
    return { kind: 'panel', sessionId: '', label: 'panel' }
  }
  const isSessionMaintainer = (sessionId) => Boolean(sessionId) && maintainerStore.get() === sessionId
  const actorManagesGroup = (sessionId, groupId) => {
    if (!sessionId || !groupId) return false
    return groupStore.read().some((group) => group.id === groupId && group.managerSessionId === sessionId)
  }
  /** 条目是否已被处理（作者只能撤回「自己未处理」的条目）。 */
  const entryProcessed = (entry) => {
    if (!entry) return true
    if (entry.kind === 'request') return entry.status === 'answered' || entry.status === 'canceled' || Boolean(entry.answeredBy)
    if (entry.kind === 'task') return entry.taskStatus === 'done' || entry.taskStatus === 'canceled'
    if (entry.claimedBy) return true
    return false
  }
  const canRetractEntry = (actor, entry) => {
    if (actor.kind === 'panel') return { ok: true, reason: 'panel' }
    const sessionId = actor.sessionId
    if (isSessionMaintainer(sessionId)) return { ok: true, reason: 'maintainer' }
    if (entry.groupId && actorManagesGroup(sessionId, entry.groupId)) return { ok: true, reason: 'group-manager' }
    if (entry.author && entry.author === sessionId) {
      if (entryProcessed(entry)) {
        return { ok: false, error: '这条条目已经被处理（已回复/已完成/已撤回），只有用户、维护者或本群群管理可以撤回。' }
      }
      return { ok: true, reason: 'author' }
    }
    return {
      ok: false,
      error: '没有权限撤回这条条目：普通成员只能撤回自己未处理的条目，群管理只能撤回本群条目。'
    }
  }
  const canRetractApproval = (actor) => {
    if (actor.kind === 'panel') return { ok: true }
    if (isSessionMaintainer(actor.sessionId)) return { ok: true }
    return { ok: false, error: '待复核记录只有面板用户或维护者可以撤回。' }
  }

  // ---------------------------------------------------------------- 任务归属锁（v2.10.1）
  const patchTaskEntry = (taskId, patch) => {
    appendEvents(boardDir, [{ op: 'task', id: taskId, patch, ts: Date.now() }])
  }

  /**
   * task.claim：只有 coordinator/assignee（面板需显式给 owner）可以认领；
   * 已被他人认领时返回当前 owner 和拒绝原因，绝不静默覆盖。
   */
  const claimTaskEntry = ({ ref, actorId, actorKind = 'session' }) => {
    const task = findBoardEntry(ref)
    if (!task) return { ok: false, error: `找不到任务：${ref}` }
    if (task.kind !== 'task') return { ok: false, error: `只有 task 可以认领：${task.title}` }
    if (['done', 'canceled'].includes(task.taskStatus || 'assigned')) {
      return { ok: false, error: `任务已${task.taskStatus === 'done' ? '完成' : '撤回'}，不能再认领。` }
    }
    const wanted = String(actorId || '').trim()
    if (!wanted) return { ok: false, error: '面板认领任务时需指定 owner（assignee/coordinator 的会话 id）。' }
    const coordinator = typeof task.coordinator === 'string' ? task.coordinator : ''
    const assignees = Array.isArray(task.assignees) ? task.assignees.filter((item) => typeof item === 'string' && item) : []
    // 严格按需求：只有该任务的 coordinator/assignee 可以 claim；面板也必须指定这两个角色之一，
    // 不允许拿用户权限把任务直接塞给任意会话。
    const eligible = wanted === coordinator || assignees.includes(wanted) || task.owner === wanted
    if (!eligible) {
      return {
        ok: false,
        reason: 'not-assignee',
        owner: task.owner || taskOwnerOf(task),
        error: `只有该任务的 coordinator/assignee 可以认领：任务「${task.title}」的 owner 是 ${taskOwnerOf(task) ? shortSid(taskOwnerOf(task)) : '（未指定）'}。`
      }
    }
    if (task.owner && task.owner !== wanted) {
      return {
        ok: false,
        reason: 'claimed-by-other',
        owner: task.owner,
        error: `任务已被会话 ${shortSid(task.owner)} 认领（owner=${task.owner}，claimedAt=${task.claimedAt || 0}），不能静默覆盖；请让当前 owner 用 task.release 释放，或由用户/维护者处理。`
      }
    }
    if (task.owner === wanted && task.claimState === 'claimed') {
      return { ok: true, already: true, owner: wanted, taskId: task.id }
    }
    const now = Date.now()
    patchTaskEntry(task.id, {
      owner: wanted,
      ownerRole: wanted === coordinator ? 'coordinator' : 'assignee',
      claimedAt: now,
      claimState: 'claimed',
      claimedBy: wanted
    })
    return { ok: true, taskId: task.id, owner: wanted, ownerRole: wanted === coordinator ? 'coordinator' : 'assignee', claimedAt: now }
  }

  /** task.release：owner 自己 / 组长 / 维护者 / 面板可释放；释放后 owner 清空，可被重新认领。 */
  const releaseTaskEntry = ({ ref, actorId, actorKind = 'session' }) => {
    const task = findBoardEntry(ref)
    if (!task) return { ok: false, error: `找不到任务：${ref}` }
    if (task.kind !== 'task') return { ok: false, error: `只有 task 可以释放：${task.title}` }
    if (['done', 'canceled'].includes(task.taskStatus || 'assigned')) {
      return { ok: false, error: `任务已${task.taskStatus === 'done' ? '完成' : '撤回'}，不能释放归属。` }
    }
    const wanted = String(actorId || '').trim()
    const isPanelAdmin = actorKind === 'panel'
    const allowed =
      isPanelAdmin ||
      isSessionMaintainer(wanted) ||
      (wanted && task.owner === wanted) ||
      (wanted && task.coordinator === wanted)
    if (!allowed) {
      return {
        ok: false,
        owner: task.owner || '',
        error: `只有当前 owner、组长、维护者或面板可以释放任务「${task.title}」；当前 owner=${task.owner || '（空）'}。`
      }
    }
    const previousOwner = task.owner || ''
    patchTaskEntry(task.id, {
      owner: '',
      ownerRole: '',
      claimedAt: 0,
      claimState: 'released',
      releasedBy: wanted || 'panel',
      releasedAt: Date.now(),
      previousOwner
    })
    return { ok: true, taskId: task.id, previousOwner, claimState: 'released' }
  }

  /** task.dedupe：只给合并建议；apply=true 时把重复任务标 canceled + 指向 primary，不删除数据。 */
  const taskDedupe = ({ apply = false, actorId = '' } = {}) => {
    const suggestions = collectDuplicateTaskGroups(store.readActive())
    if (!apply || !suggestions.length) return { suggestions, applied: 0 }
    let applied = 0
    const now = Date.now()
    for (const group of suggestions) {
      const primaryId = group.primary.id
      for (const duplicate of group.duplicates) {
        patchTaskEntry(duplicate.id, {
          taskStatus: 'canceled',
          mergedInto: primaryId,
          mergedAt: now,
          mergedBy: actorId || 'panel',
          mergeReason: duplicate.reason || '重复任务合并'
        })
        for (const entry of store.readActive()) {
          if (entry.kind !== 'request') continue
          if (entry.taskId !== duplicate.id) continue
          if (entry.status === 'answered' || entry.status === 'canceled') continue
          patchTaskEntry(entry.id, {
            status: 'canceled',
            cancelReason: `已合并到任务 ${primaryId}`,
            canceledAt: now
          })
        }
        applied += 1
      }
    }
    return { suggestions, applied }
  }
  /** 找出一条待复核记录关联的隐藏卡片条目（标题「待复核：…」）。 */
  const hiddenApprovalEntriesOf = (active, approval) => {
    const wanted = normalizeText(String((approval && approval.text) || '')).slice(0, 120)
    if (!wanted) return []
    return active.filter(
      (entry) =>
        entry &&
        entry.channel === 'world' &&
        entry.hiddenFromChat === true &&
        String(entry.title || '').startsWith('待复核') &&
        normalizeText(String(entry.text || '')).includes(wanted)
    )
  }
  /**
   * 撤回一条看板条目（或一条待复核记录）。
   * 清理规则：任务 → taskStatus=canceled + 关联未完成 request 标 canceled；消息 → 它派生的未完成请求一并撤回；
   * 关联 pending approval 标 canceled 并移除隐藏卡片；最后 append remove 事件并同步清理 delivery 记录。
   */
  const retractBoardEntry = ({ ref, actor: rawActor, reason }) => {
    const actor = actorOf(rawActor)
    const wanted = String(ref || '').trim()
    if (!wanted) return { ok: false, error: '缺少要撤回的条目 id' }
    const now = Date.now()
    const reasonText = String(reason || '').trim().slice(0, 200)
    const active = store.readActive()
    const entry = active.find((item) => item.id === wanted) || active.find((item) => item.id.startsWith(wanted)) || null

    // ① 直接按待复核记录 id 撤回（面板「待复核」卡片）
    if (!entry) {
      const approvals = readApprovals()
      const approval = approvals.find((item) => item && (item.id === wanted || item.id.startsWith(wanted))) || null
      if (!approval) return { ok: false, error: '找不到这条条目（可能已被撤回）' }
      if (approval.status !== 'pending') return { ok: false, error: '该待复核记录已处理：' + approval.status }
      const perm = canRetractApproval(actor)
      if (!perm.ok) return perm
      approval.status = 'canceled'
      approval.canceledAt = now
      approval.canceledBy = actor.label
      writeApprovals(approvals)
      const hidden = hiddenApprovalEntriesOf(active, approval)
      if (hidden.length) {
        appendEvents(
          boardDir,
          hidden.map((item) => ({
            op: 'remove',
            id: item.id,
            by: actor.label,
            reason: reasonText || '待复核记录撤回',
            ts: now
          }))
        )
      }
      for (const item of hidden) deliveryStore.dropRule(item.id)
      logger.info(`撤回待复核记录 ${approval.id}（by=${actor.label}）`)
      return {
        ok: true,
        kind: 'approval',
        id: approval.id,
        title: String(approval.title || approval.text || '').slice(0, 40),
        removedEntries: hidden.map((item) => item.id),
        canceledRequests: [],
        canceledApprovals: [approval.id],
        message: '已撤回该待复核记录（不会创建会话/工作区）。'
      }
    }

    const perm = canRetractEntry(actor, entry)
    if (!perm.ok) return perm

    const canceledRequests = []
    const canceledApprovals = []
    const removedEntries = []
    const patched = new Set()
    const patchEntry = (id, patch) => {
      if (!id || patched.has(id)) return
      patched.add(id)
      appendEvents(boardDir, [{ op: 'task', id, patch, ts: now }])
    }
    const cancelRequest = (request) => {
      if (!request || request.kind !== 'request') return
      if (request.status === 'answered' || request.status === 'canceled' || request.answeredBy) return
      patchEntry(request.id, { status: 'canceled', canceledAt: now, canceledBy: actor.label })
      canceledRequests.push(request.id)
    }

    // ② 任务：标记 canceled + 取消关联未完成 request（保留记录便于审计，不再结算奖励）
    if (entry.kind === 'task') {
      patchEntry(entry.id, { taskStatus: 'canceled', canceledAt: now, canceledBy: actor.label })
      for (const request of active) {
        if (request.kind === 'request' && request.taskId === entry.id) cancelRequest(request)
      }
    }
    // ③ 请求本身：直接标 canceled
    if (entry.kind === 'request') cancelRequest(entry)

    // ④ 消息/任务派生的请求与任务（同一正文、面板来源、时间接近）：世界消息 / 群消息撤回时一起收口
    if (entry.kind === 'command' || entry.kind === 'chat' || entry.kind === 'task') {
      const normalized = normalizeText(entry.text)
      if (normalized) {
        for (const request of active) {
          if (request.id === entry.id || request.kind !== 'request') continue
          if (request.hiddenFromChat !== true || request.author !== 'panel') continue
          if (normalizeText(request.text) !== normalized) continue
          if (Math.abs((request.ts || 0) - (entry.ts || 0)) > 10 * 60 * 1000) continue
          if (entry.groupId && request.groupId !== entry.groupId) continue
          if (!entry.groupId && entry.channel === 'world' && request.channel !== 'world') continue
          cancelRequest(request)
        }
        if (entry.channel === 'world' || entry.kind === 'command') {
          for (const task of active) {
            if (task.id === entry.id || task.kind !== 'task' || task.author !== 'panel') continue
            if (normalizeText(task.text) !== normalized) continue
            if (Math.abs((task.ts || 0) - (entry.ts || 0)) > 10 * 60 * 1000) continue
            patchEntry(task.id, { taskStatus: 'canceled', canceledAt: now, canceledBy: actor.label })
            for (const request of active) {
              if (request.kind === 'request' && request.taskId === task.id) cancelRequest(request)
            }
            removedEntries.push(task.id)
          }
        }
      }
    }

    // ⑤ 关联 pending approval：标 canceled + 移除隐藏卡片
    const approvals = readApprovals()
    const normalizedEntryText = normalizeText(entry.text)
    let approvalsChanged = false
    for (const approval of approvals) {
      if (!approval || approval.status !== 'pending') continue
      if (!normalizedEntryText || normalizeText(String(approval.text || '')) !== normalizedEntryText) continue
      approval.status = 'canceled'
      approval.canceledAt = now
      approval.canceledBy = actor.label
      approvalsChanged = true
      canceledApprovals.push(approval.id)
      for (const hidden of hiddenApprovalEntriesOf(active, approval)) {
        if (hidden.id !== entry.id) removedEntries.push(hidden.id)
      }
    }
    if (approvalsChanged) writeApprovals(approvals)

    // ⑥ 最后 append remove 事件（任务/请求的 canceled 补丁先写，审计可追溯），并清理 delivery
    const removeIds = [...new Set([...removedEntries, entry.id])]
    appendEvents(
      boardDir,
      removeIds.map((id) => ({
        op: 'remove',
        id,
        by: actor.label,
        ...(reasonText ? { reason: reasonText } : {}),
        ts: now
      }))
    )
    for (const id of removeIds) deliveryStore.dropRule(id)
    logger.info(
      `撤回条目 ${entry.id} [${entry.kind}/${entry.groupId ? '群组' : entry.scope}] ${entry.title}（by=${actor.label}/${perm.reason}，关联请求 ${canceledRequests.length} 条，待复核 ${canceledApprovals.length} 条）`
    )
    return {
      ok: true,
      kind: entry.kind,
      id: entry.id,
      title: entry.title,
      removedEntries: removeIds,
      canceledRequests,
      canceledApprovals,
      message:
        '已撤回' +
        (KIND_CN[entry.kind] || '条目') +
        '「' +
        String(entry.title || '').slice(0, 30) +
        '」' +
        (canceledRequests.length ? `，并取消 ${canceledRequests.length} 条关联请求` : '') +
        (canceledApprovals.length ? `，撤回 ${canceledApprovals.length} 条待复核` : '') +
        '。'
    }
  }

  // 宿主能力探测：不同 DSH 版本的 Agent 可能叫 cancel / interrupt / abort / stop，逐一探测，绝不假装成功。
  const INTERRUPT_METHODS = ['cancel', 'interrupt', 'abort', 'stop']
  const detectInterruptMethod = (agent) => {
    if (!agent || typeof agent !== 'object') return ''
    for (const method of INTERRUPT_METHODS) {
      try {
        if (typeof agent[method] === 'function') return method
      } catch {
        /* 属性访问异常：继续探测下一个 */
      }
    }
    return ''
  }
  /** 宿主级探测（用于 state 里给面板提示，不一定每个会话都支持）。 */
  const detectHostInterruptMethod = () => {
    try {
      const agents = ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() : []
      for (const agent of agents) {
        const method = detectInterruptMethod(agent)
        if (method) return method
      }
      for (const method of INTERRUPT_METHODS) {
        if (ctx.agents && typeof ctx.agents[method] === 'function') return 'agents.' + method
      }
    } catch {
      /* ignore */
    }
    return ''
  }
  const invokeAgentInterrupt = (agent, method, reason) => {
    const cause = { kind: 'user', reason: String(reason || '用户/群管理手动打断').slice(0, 120) }
    if (method === 'cancel') {
      // DSH 官方语义：keepInbox=true 只中止当前一轮，保留历史与排队输入。
      agent.cancel(cause, { keepInbox: true })
      return
    }
    try {
      agent[method](cause)
    } catch (error) {
      try {
        agent[method]()
      } catch {
        throw error
      }
    }
  }
  const canInterruptSession = (actor, targetId) => {
    if (actor.kind === 'panel') return { ok: true, reason: 'panel' }
    const sessionId = actor.sessionId
    if (!sessionId) return { ok: false, error: '无法确定调用者会话，请从主会话调用。' }
    if (isSessionMaintainer(sessionId)) return { ok: true, reason: 'maintainer' }
    if (sessionId === targetId) return { ok: true, reason: 'self' }
    if (isSessionMaintainer(targetId)) {
      return { ok: false, error: '维护者会话不能被群管理/普通成员打断；需要停止请联系用户或维护者本人。' }
    }
    const managed = groupStore.read().find(
      (group) => group.managerSessionId === sessionId && (group.sessionIds || []).includes(targetId)
    )
    if (managed) return { ok: true, reason: 'group-manager' }
    return { ok: false, error: '没有打断权限：普通成员不能打断他人；群管理只能打断本群正在运行的成员。' }
  }
  /**
   * 打断一个正在运行的一轮（不删除会话、不丢历史）。
   * 先按完整 id 找在线 agent，找不到再用会话索引解析 contactId/短 id/handle/标题。
   * 能力探测不到时返回明确的不支持错误与替代方案。
   */
  const interruptRunningSession = async ({ sessionId: rawRef, actor: rawActor, reason }) => {
    const actor = actorOf(rawActor)
    const ref = String(rawRef || '').trim()
    if (!ref) return { ok: false, error: '缺少要打断的会话（sessionId / contactId / 标题）' }
    let agent = null
    try {
      agent = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(ref) : undefined
    } catch {
      agent = undefined
    }
    let targetId = agent && typeof agent.id === 'string' ? agent.id : ''
    if (!agent) {
      const sessions = await buildSessionIndex()
      const resolution = resolveSessionRef(ref, sessions)
      if (!resolution.ok) {
        return {
          ok: false,
          code: 'not-found',
          error: resolution.ambiguous
            ? '会话引用不唯一，请改用 contactId 或完整 id：\n' + resolution.error
            : resolution.error
        }
      }
      targetId = resolution.session.id
      try {
        agent = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(targetId) : undefined
      } catch {
        agent = undefined
      }
    }
    if (!agent) {
      return {
        ok: false,
        code: 'not-live',
        error: '会话「' + ref + '」当前不在线（没有运行中的一轮），无需打断。'
      }
    }
    const perm = canInterruptSession(actor, targetId)
    if (!perm.ok) return { ...perm, code: 'forbidden', sessionId: targetId }
    const status = typeof agent.status === 'string' ? agent.status : ''
    if (status !== 'running') {
      return {
        ok: false,
        code: 'not-running',
        sessionId: targetId,
        error: '会话当前状态是 ' + (status || 'idle') + '，没有正在运行的一轮，不需要打断。'
      }
    }
    const method = detectInterruptMethod(agent)
    if (!method) {
      return {
        ok: false,
        code: 'unsupported',
        sessionId: targetId,
        error:
          '宿主不支持直接打断：当前 DSH 的 agent 没有提供 cancel / interrupt / abort / stop 能力，无法安全中止这一轮（不会假装成功）。',
        alternatives: [
          '用 session_nudge 插话提醒它下一步处理（不唤醒、不打断）',
          '等待这一轮结束（状态会变回 idle）',
          '在对应会话窗口点宿主自带的停止按钮'
        ],
        message: '宿主不支持直接打断，已给出替代方案。'
      }
    }
    try {
      invokeAgentInterrupt(agent, method, reason)
    } catch (error) {
      return {
        ok: false,
        code: 'interrupt-failed',
        sessionId: targetId,
        error: '调用宿主打断能力失败：' + (error && error.message ? error.message : error)
      }
    }
    let verified = false
    try {
      verified = agent.status !== 'running'
    } catch {
      verified = false
    }
    logger.info(`打断会话 ${shortSid(targetId)}（method=${method}，by=${actor.label}/${perm.reason}，verified=${verified}）`)
    return {
      ok: true,
      sessionId: targetId,
      method,
      verified,
      message: verified
        ? '已打断该会话正在运行的一轮（历史与排队输入保留）。'
        : '已向宿主发出打断请求（宿主仍在收尾，稍后状态会变回 idle；历史与排队输入保留）。'
    }
  }

  const managerNotifyAt = new Map()
  // chat + to 点名接话的冷却：同一目标 2 分钟内不重复唤醒，避免两人来回刷屏/唤醒风暴。
  const chatWakeAt = new Map()

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
  const buildAskMessage = ({ askMode, text, group, requestId, assignmentTask, authorId, taskScope, scopeWarning }) => {
    if (askMode === 'task') {
      const scopeLine = taskScope
        ? `【范围锁】归属：${assignmentTask ? shortSid(taskOwnerOf(assignmentTask)) : shortSid(authorId)} · 仅做 scope：${taskScope}（${TASK_SCOPE_DISPATCH_TAIL}）`
        : ''
      const warningLine = scopeWarning ? `⚠ 范围提醒：${scopeWarning} —— 已超出原 scope，需 owner 确认，不要自动扩展。` : ''
      if (assignmentTask) {
        return [
          `【任务分配 · 群任务：${assignmentTask.title}】`,
          text,
          scopeLine,
          warningLine,
          '',
          `请只做你负责的部分；完成后用 session_share（kind=handoff、group=${group.name}、replyTo=${requestId}、files=文件路径）提交给组长，不要直接向用户汇报，也不要重复执行其他成员的任务。`,
          CLOSING_FORMAT_REQUIREMENT,
          `（来自会话 ${shortSid(authorId)} · 群组「${group.name}」）`
        ].filter(Boolean).join('\n')
      }
      return [
        '【任务分配 · 群内派活】',
        text,
        scopeLine,
        warningLine,
        '',
        `请执行/完成上面的工作；完成后用 session_share（kind=handoff、group=${group.name}、replyTo=${requestId}、files=文件路径）回复，正文写清结果/进度；不要展开无关分析。`,
        CLOSING_FORMAT_REQUIREMENT,
        `（来自会话 ${shortSid(authorId)} · 群组「${group.name}」）`
      ].filter(Boolean).join('\n')
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
    // 只有任务 owner 才能把 taskStatus 推进到 delegating（排队期间 owner 可能已被释放/转移）。
    const itemOwnsTask = !assignmentTask || taskOwnerOf(assignmentTask) === item.author
    const message = buildAskMessage({
      askMode: item.askMode,
      text: item.text,
      group,
      requestId: item.requestId,
      assignmentTask,
      authorId: item.author,
      taskScope: item.taskScope || '',
      scopeWarning: item.scopeWarning || ''
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
    if (item.taskId && itemOwnsTask) {
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
          if (resolved.queued.id === item.id) {
            missing = `${ref}（依赖指向自己）`
            break
          }
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
  const enqueueAskRequest = ({ group, info, text, title, targets, askMode, assignmentTask, dependsOn, delayMs, step, taskScope, scopeWarning }) => {
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
        skipDedupe: Boolean(assignmentTask),
        ...(taskScope ? { taskScope } : {}),
        ...(scopeWarning ? { scopeWarning } : {}),
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
      taskScope: taskScope || '',
      scopeWarning: scopeWarning || '',
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

  // 任务线巡检定时器（task-6）：回写派生状态 + 对卡住任务线写 nudge（不唤醒，最多 3 次）。
  // unref 不阻止进程退出；插件卸载时清掉。
  const taskLineTimer = setInterval(() => {
    try {
      runTaskLineWatch({ source: 'timer' })
    } catch (error) {
      logger.warn(`任务线巡检定时器失败：${error && error.message ? error.message : error}`)
    }
  }, TASK_LINE_SCAN_MS)
  if (taskLineTimer && typeof taskLineTimer.unref === 'function') taskLineTimer.unref()
  try {
    ctx.effect(() => () => clearInterval(taskLineTimer), 'session-bridge: task-line timer')
  } catch {
    /* ignore */
  }
  // 插件重启后先跑一次（此时看板/会话缓存已就绪），避免卡住任务线要等一整轮。
  setTimeout(() => {
    try {
      runTaskLineWatch({ source: 'boot' })
    } catch {
      /* ignore */
    }
  }, 8000).unref?.()

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

  /** 会话索引里的 live/owned 状态（5 秒缓存，避免巡检逐个会话重复枚举）。 */
  let sessionLookCache = { at: 0, records: null }
  const sessionLookOf = async (sessionId) => {
    if (!sessionId) return null
    try {
      const now = Date.now()
      if (!sessionLookCache.records || now - sessionLookCache.at > 5000) {
        sessionLookCache = { at: now, records: await buildSessionIndex() }
      }
      return sessionLookCache.records.find((record) => record.id === sessionId) || null
    } catch {
      return null
    }
  }

  /** 恢复会话并返回细节：agent 为 live agent；skipped=已在活跃/上下文不可用（意料之中的跳过）。 */
  const resumeSessionForLive = async (sessionId) => {
    if (!sessionId) return { agent: null, skipped: false }
    const existing = liveAgentOf(sessionId)
    if (existing) return { agent: existing, skipped: false }
    // 巡检/任务重试可能重复恢复已经活跃的会话；先看索引里的 live，避免 resume 抛 already owned。
    const known = await sessionLookOf(sessionId)
    if (known && known.live === true) {
      logger.info(`恢复会话 ${shortSid(sessionId)}：会话已活跃，跳过恢复`)
      return { agent: null, skipped: true, reason: 'already-live' }
    }
    try {
      if (!ctx.agents || typeof ctx.agents.resume !== 'function') return { agent: null, skipped: false }
      const selection = resolveDefaultSelection()
      const setup = buildAgentSetup({ selection })
      const handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: {},
        ...(setup ? { setup } : {})
      })
      const agent = handle && handle.agent ? handle.agent : handle || null
      return { agent: agent || null, skipped: false }
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      if (isBenignResumeError(message)) {
        logger.info(`恢复会话 ${shortSid(sessionId)} 跳过：${message}`)
        return { agent: null, skipped: true, reason: message }
      }
      logger.warn(`恢复会话 ${shortSid(sessionId)} 失败：${message}`)
      return { agent: null, skipped: false, error: message }
    }
  }

  // ---------------------------------------------------------------- 修bug群（v2.9.1）
  // 维护者的专用任务池：普通成员把 BUG 报告投递到该群，维护者是群管理但只处理 bug；
  // 该群不参与普通任务派活（group.post 里维护者仍会被保护规则排除）。
  const nextBugfixGroupName = (groups, options = {}) => {
    const list = Array.isArray(groups) ? groups : []
    // v2.9.1：复用 v2.9.0 的 generateGroupName 可读命名规则（project+action 语义），
    // 得到「星桥 · 修bug」这类可读名；重名时加数字后缀，避免固定丑名/半句名。
    let base = BUGFIX_GROUP_NAME
    try {
      base =
        generateGroupName('修复 bug 报告任务池', {
          workspace: options.workspace || '',
          project: options.project || '星桥',
          action: options.action || '修bug'
        }) || BUGFIX_GROUP_NAME
    } catch {
      base = BUGFIX_GROUP_NAME
    }
    if (!list.some((group) => group && group.name === base)) return base
    let suffix = 2
    while (list.some((group) => group && group.name === `${base} ${suffix}`)) suffix += 1
    return `${base} ${suffix}`
  }
  const ensureBugfixGroup = async (options = {}) => {
    const maintainerId = maintainerStore.get()
    if (!maintainerId) {
      return {
        ok: false,
        error: '尚未注册维护者会话：请先在星桥面板执行 maintainer.set（注册「星桥值班员」），再创建修bug群。'
      }
    }
    const sessions = await buildSessionIndex()
    const maintainer = sessions.find((session) => session.id === maintainerId)
    const groups = groupStore.read()
    const existing = bugfixGroupOf(groups)
    const normalIds = sessions
      .filter((session) => session.id !== maintainerId && !session.protected && !session.internal && session.closed !== true)
      .map((session) => session.id)
    const now = Date.now()
    let group = existing
    let created = false
    let addedMembers = []
    if (!group) {
      const bugfixWorkspace = (maintainer && maintainer.cwd) || defaultWorkspaceForRule()
      group = {
        id: 'g-' + now.toString(36) + '-' + randomBytes(3).toString('hex'),
        // v2.9.1：复用 generateGroupName 可读命名规则（星桥 · 修bug），重名加序号。
        name: nextBugfixGroupName(groups, { workspace: bugfixWorkspace }),
        kind: BUGFIX_GROUP_KIND,
        workspace: bugfixWorkspace,
        goal: '维护者的修 bug 专用任务池：普通成员把 BUG 报告投递到本群（session_share kind=bug / 群聊 / 面板「报bug」），维护者集中处理；本群不派普通实现任务。',
        managerSessionId: maintainerId,
        sessionIds: [...new Set([maintainerId, ...normalIds])],
        createdAt: now,
        updatedAt: now
      }
      groups.push(group)
      groupStore.write(groups)
      created = true
    } else {
      const before = new Set(group.sessionIds)
      const nextIds = [...group.sessionIds]
      for (const sessionId of [maintainerId, ...normalIds]) if (!nextIds.includes(sessionId)) nextIds.push(sessionId)
      group.managerSessionId = maintainerId
      group.kind = BUGFIX_GROUP_KIND
      group.sessionIds = nextIds
      group.updatedAt = now
      groupStore.write(groups)
      addedMembers = nextIds.filter((sessionId) => !before.has(sessionId))
    }
    // 授权：维护者可以唤醒全体成员（跟进 bug）；普通成员也可以在修bug群里投递 bug 给维护者。
    try {
      const permissions = readPermissionsOf(boardDir)
      const maintainerGrants = new Set(permissions.grants[maintainerId] || [])
      for (const session of sessions) if (session.id !== maintainerId) maintainerGrants.add(session.id)
      permissions.grants[maintainerId] = [...maintainerGrants]
      for (const sessionId of normalIds) {
        const grants = new Set(permissions.grants[sessionId] || [])
        grants.add(maintainerId)
        permissions.grants[sessionId] = [...grants]
      }
      writePermissionsOf(boardDir, permissions)
    } catch {
      /* 授权失败不阻塞建群 */
    }
    if (created) {
      try {
        addEntry(
          {
            title: '修bug群已就绪：' + group.name,
            text:
              '该群是维护者的修 bug 任务池：普通成员把 BUG 报告投递到这里（session_share kind=bug / 直接群聊 / 面板「报bug」），维护者集中处理。' +
              '普通实现任务仍按常规派给普通成员，本群不接普通任务。',
            kind: 'chat',
            groupId: group.id,
            author: 'panel',
            origin: 'panel',
            mentions: [maintainerId],
            tags: '@系统',
            skipDedupe: true
          },
          'panel'
        )
      } catch {
        /* ignore */
      }
    }
    let woken = false
    if (created || options.kickoff === true) {
      const intro = [
        '【星桥 · 修bug群已就绪】你是该群的群管理（维护者，protected/service）。',
        '职责：只处理投递到本群的 BUG 报告（按严重度排序先修最影响使用的）；修完用 session_share（kind=handoff、group=' + group.name + '、files=…）回执，必要时用 session_ask mode=task 找有权限的成员协作。',
        '保护规则：本群和其他群都不会再把普通实现任务派给你；普通任务由普通成员承担。',
        created ? '' : '（本次为复用现有修bug群，成员已同步。）'
      ]
        .filter(Boolean)
        .join('\n')
      await ensureSessionLive(maintainerId)
      woken = wakeSession(maintainerId, intro, {}).ok
    }
    const openReports = store
      .readActive()
      .filter((entry) => entry.groupId === group.id && entry.kind === 'request' && entry.status !== 'answered').length
    logger.info(
      `修bug群${created ? '已创建' : '已复用'}「${group.name}」：成员 ${group.sessionIds.length} 人，维护者=${shortSid(maintainerId)}，待处理 bug ${openReports}`
    )
    return {
      ok: true,
      created,
      reused: !created,
      groupId: group.id,
      name: group.name,
      kind: BUGFIX_GROUP_KIND,
      managerSessionId: maintainerId,
      memberCount: group.sessionIds.length,
      addedMembers,
      openReports,
      woken
    }
  }
  /** 把一条 BUG 报告投递到修bug群并把维护者叫起来（用户/普通成员/工具共用）。 */
  const reportBugToMaintainer = async (input = {}) => {
    const maintainerId = maintainerStore.get()
    if (!maintainerId) return { ok: false, error: '尚未注册维护者会话（maintainer.set），无法投递 bug。' }
    const ensured = await ensureBugfixGroup({})
    if (!ensured.ok) return ensured
    const group = groupStore.read().find((item) => item.id === ensured.groupId)
    const titleRaw = String((input && input.title) || '').trim()
    const text = String((input && input.text) || '').trim().slice(0, 2000)
    if (!text) return { ok: false, error: 'bug 描述不能为空。' }
    const files = normalizeFilesOf(input && input.files)
    const title = 'BUG：' + (titleRaw || truncate(text, 24)).slice(0, 40)
    const entry = addEntry(
      {
        title,
        text,
        kind: 'request',
        groupId: group ? group.id : '',
        workspace: (input && input.workspace) || '',
        author: (input && input.author) || 'panel',
        requestTo: [maintainerId],
        mentions: [maintainerId],
        files,
        tags: '@bug',
        skipDedupe: true
      },
      (input && input.origin) || 'panel'
    )
    if (!entry.ok) return { ok: false, error: entry.reason || 'bug 报告写入看板失败' }
    const message = [
      '【BUG 报告 · 来自修bug群' + (group ? '「' + group.name + '」' : '') + '】',
      title,
      '',
      text,
      ...(files.length ? ['文件：' + files.join('、')] : []),
      '',
      '请按影响面排序处理；修好后用 session_share（kind=handoff、group=' + (group ? group.name : BUGFIX_GROUP_NAME) + '、replyTo=' + entry.entry.id + '、files=…）回执。',
      '（这是 bug 投递，不是普通任务派活；维护者默认 protected/service。）'
    ].join('\n')
    await ensureSessionLive(maintainerId)
    const woken = wakeSession(maintainerId, message, { requestId: entry.entry.id }).ok
    logger.info(`BUG 报告已投递到修bug群：${entry.entry.id}，唤醒维护者=${woken}`)
    return {
      ok: true,
      groupId: group ? group.id : '',
      groupName: group ? group.name : BUGFIX_GROUP_NAME,
      reportId: entry.entry.id,
      title,
      woken
    }
  }

  /** 确保一个会话是 live；history 会话需要恢复后才能收到 followup。 */
  const ensureSessionLive = async (sessionId) => {
    const outcome = await resumeSessionForLive(sessionId)
    return outcome.agent || null
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
      // v2.9.1：维护者（protected/service）不参与普通世界任务的自动路由。
      if (session.protected === true || isMaintainerSession(sessionId)) continue
      const score = scoreProfileForText(text, profile)
      if (score > 0) {
        const repNow = reputationOf(sessionId)
        const identityNow = identityOf(sessionId, session.title)
        const skillBonus = (identityNow.skills || []).some((tag) => String(text).includes(tag)) ? 2 : 0
        const priority = score + Math.max(-3, Math.min(5, repNow.points / 10)) + skillBonus + officeForSession(sessionId).officeLevel / 10
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
    const setup = buildAgentSetup({ selection, recordPreset: true })
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
        // 宿主失败路径可能返回没有 session / session.id 的 handle：这里必须先判空，
        // 否则 titles.rename 内部读 undefined.id 会抛 "Cannot read properties of undefined (reading 'id')"。
        const createdAgent = agent && agent.agent ? agent.agent : agent
        const createdSession = createdAgent && createdAgent.session
        if (titles && typeof titles.rename === 'function') {
          if (createdSession && typeof createdSession.id === 'string') {
            const renamed = titles.rename(createdSession, String(titleHint || '世界任务').slice(0, 40))
            title = (renamed && renamed.title) || ''
          } else {
            logger.info(`新会话设置标题跳过：宿主未返回带 id 的 session（${shortSid(sessionId)}）`)
          }
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
        // 模型只回 reasoning/usage 属于预期路径：会回退到关键词匹配，不需要 warn。
        const chunkSummary = [...new Set(seenTypes)].slice(0, 8).join(',')
        logger.info(`任务路由器：第 ${attempt + 1} 次模型无文本输出（chunks=${chunkSummary}），按预期回退`)
      } catch (error) {
        logger.warn(`任务路由器模型调用失败（第 ${attempt + 1} 次）：${error && error.message ? error.message : error}`)
      }
    }
    return null
  }

  // 新任务优先招新：需要专门技能、且现有成员申报/技能没有覆盖时，不把任务硬塞给空闲老成员。
  const SPECIALIST_DOMAIN_RE = /(3d|三维|建模|solidworks|solid\s*works|cad|机械|工装|夹具|支架|装配|图纸|bom|渲染|blender|catia|creo|有限元|结构设计|工业设计|模具|动画)/gi
  const specialistTokensOf = (text) => [...new Set((String(text || '').match(SPECIALIST_DOMAIN_RE) || []).map((token) => String(token).toLowerCase().replace(/\s+/g, '')))]
  const candidateCoversDomain = (candidate, tokens) => {
    if (!candidate || !tokens || !tokens.length) return true
    const haystack = [candidate.title, candidate.summary, candidate.direction, ...(candidate.assets || []), ...(candidate.skills || [])]
      .filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, '')
    return tokens.some((token) => haystack.includes(token))
  }

  const decideWorldRoute = async (text, forceNew) => {
    const sessions = await buildSessionIndex()
    const profiles = listProfilesOf(boardDir)
    const titleById = new Map(sessions.map((session) => [session.id, session.title]))
    const candidates = []
    for (const [sessionId, profile] of Object.entries(profiles)) {
      if (!profile || !profile.summary || profile.declined) continue
      if (!titleById.has(sessionId)) continue
      // v2.9.1：维护者默认 protected/service，普通自动路由一律排除（用户显式 @ 才例外）。
      if (isMaintainerSession(sessionId)) continue
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
    const specialistTokens = specialistTokensOf(text)
    const domainCovered = candidates.some((candidate) => candidateCoversDomain(candidate, specialistTokens))
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
      if (specialistTokens.length && !domainCovered) return { route: 'new', newWorkspace: false, reason: '任务需要专门技能，现有成员申报无覆盖，改新建成员', engine: 'fallback', candidates: [] }
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
    if (decision.route === 'existing' && specialistTokens.length && !domainCovered) {
      return { route: 'new', newWorkspace: false, reason: '任务需要专门技能，现有成员申报无覆盖，改新建成员', engine: 'llm', candidates: [] }
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

  /** 招募专用工作区：不把新成员直接放进用户现有 results 目录。 */
  const ensureRecruitWorkspace = async (group) => {
    const existing = String(group && group.recruitWorkspace || '').trim()
    if (existing) return existing
    const groupWorkspace = String(group && group.workspace || '').trim()
    // 已经是世界任务专用工作区时，成员应加入同一项目，而不是再拆一层。
    if (groupWorkspace && /world-workspaces?/i.test(groupWorkspace)) return groupWorkspace
    let managerCwd = ''
    try {
      const sessionsNow = await buildSessionIndex()
      const manager = sessionsNow.find((session) => session && session.id === group.managerSessionId)
      managerCwd = String(manager && manager.cwd || '').trim()
    } catch { /* ignore */ }
    if (managerCwd && !/world-workspaces?/i.test(managerCwd) && !/default-workspace/i.test(managerCwd)) return managerCwd
    const made = await createWorkspaceForTask(group && group.name ? group.name + ' · 招募' : '群招募', group && group.name ? group.name + ' · 成员' : '群成员')
    if (!made || !made.ok) {
      try {
        const base = path.dirname(defaultWorkspaceForRule() || process.cwd())
        const slug = String(group && group.name || 'group-recruit').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 24)
        const dir = path.join(base, 'world-workspaces', slug + '-recruit-' + Date.now().toString(36))
        fs.mkdirSync(dir, { recursive: true })
        return dir
      } catch { return groupWorkspace }
    }
    try {
      const groups = groupStore.read()
      const hit = groups.find((item) => item && item.id === group.id)
      if (hit) { hit.recruitWorkspace = made.cwd; groupStore.write(groups) }
    } catch { /* 记录失败不影响创建 */ }
    return made.cwd
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
    const lockInfo =
      entry.kind === 'task' || entry.kind === 'request'
        ? `   归属：owner=${entry.owner ? shortSid(entry.owner) : '（未指定）'} · 认领=${entry.claimState || '未认领'} · 仅 scope：${truncate(entry.taskScope || '', 160)}`
        : ''
    return [
      `${index + 1}. [${kind}/${scope}] ${entry.title}  (id=${entry.id.slice(0, 14)}…，${humanAge(entry.ts, now)}${claimed}${requestStatus})`,
      `   ${entry.text}`,
      lockInfo,
      entry.files && entry.files.length ? `   文件：${entry.files.join('、')}` : '',
      `   作者：会话 ${shortSid(entry.author)}${entry.workspace ? ` · 工作区 ${path.basename(entry.workspace)}` : ''}${entry.tags && entry.tags.length ? ` · 标签 ${entry.tags.join('、')}` : ''}`
    ].filter(Boolean).join('\n')
  }

  // ---------------------------------------------------------------- 招募（组长 ↔ 世界路由）与加急插话（v2.9.3）
  // 这两个能力都依赖「空闲/忙碌」判断与维护者保护。与并行分支（task-2 availability /
  // task-3 protected）兼容的做法：
  //   1) 会话已带 availability 字段（字符串 'idle'/'busy' 或 {state}）时直接采信；
  //   2) 已带 protected/service/isProtected 标记时视为受保护；
  //   3) 否则本地推导：running / 离线 / 有未完成 request = busy，其余 idle。
  // 这样合并其它分支时不需要改调用方。

  const URGENT_INTERVAL_DEFAULT_MS = 60 * 1000
  const urgentRateMap = new Map()
  const urgentIntervalMs = () =>
    Math.max(3000, Math.min(600000, toNumber(cfg.urgentIntervalMs, URGENT_INTERVAL_DEFAULT_MS)))

  const openRequestsForSession = (sessionId, activeEntries) => {
    const entries = Array.isArray(activeEntries) ? activeEntries : store.readActive()
    return entries.filter(
      (entry) =>
        entry &&
        entry.kind === 'request' &&
        entry.status !== 'answered' &&
        !entry.answeredBy &&
        Array.isArray(entry.requestTo) &&
        entry.requestTo.includes(sessionId)
    )
  }

  /** 派生一个会话的可用性：优先采信宿主/其它分支已算好的 availability，否则本地推导。 */
  const availabilityOfSession = (sessionId, sessionsNow, activeEntries) => {
    const sessions = Array.isArray(sessionsNow) ? sessionsNow : []
    const session = sessions.find((item) => item && item.id === sessionId)
    if (!session) return { state: 'busy', reason: '会话不可见' }
    // v2.9.3：运行中优先判定为 busy（即使旧分支给的 availability 是 idle），加急据此先打断。
    if (String(session.status || '') === 'running') return { state: 'busy', reason: '运行中' }
    const declared = session.availability
    const declaredState =
      typeof declared === 'string' ? declared : declared && typeof declared === 'object' ? declared.state : ''
    if (declaredState === 'idle' || declaredState === 'busy') {
      return { state: declaredState, reason: '由宿主 availability 提供' }
    }
    if (session.closed === true) return { state: 'busy', reason: '已退役' }
    if (session.live !== true) return { state: 'busy', reason: '离线/历史会话' }
    if (String(session.status || '') === 'running') return { state: 'busy', reason: '运行中' }
    const open = openRequestsForSession(sessionId, activeEntries)
    if (open.length) return { state: 'busy', reason: '有未完成请求', openRequestCount: open.length }
    return { state: 'idle', reason: '空闲' }
  }

  /** 维护者 / 受保护会话：不得当作普通执行人被招募或被普通任务选中。 */
  const isProtectedSession = (sessionOrId) => {
    const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId && sessionOrId.id
    if (!id) return false
    if (maintainerStore.get() === id) return true
    const session = typeof sessionOrId === 'object' && sessionOrId ? sessionOrId : null
    if (session && (session.protected === true || session.service === true || session.isProtected === true)) return true
    try {
      const identity = identityOf(id)
      if (identity && /维护者|maintainer/i.test(String(identity.role || ''))) return true
    } catch {
      /* ignore */
    }
    return false
  }

  /** 调用者在群里的管理角色：维护者 / 群管理 / 现任组长（coordinator）。 */
  const groupManageRoleOf = (group, sessionId) => {
    const role = { allowed: false, maintainer: false, manager: false, coordinator: false }
    if (!group || !sessionId) return role
    if (maintainerStore.get() === sessionId) {
      role.maintainer = true
      role.allowed = true
      return role
    }
    if (group.managerSessionId === sessionId) {
      role.manager = true
      role.allowed = true
      return role
    }
    if (Array.isArray(group.sessionIds) && group.sessionIds.includes(sessionId) && (officeForSession(sessionId).officeLevel || 10) >= 60) {
      role.rank = true
      role.allowed = true
      return role
    }
    try {
      const task = store
        .readActive()
        .find(
          (entry) =>
            entry &&
            entry.kind === 'task' &&
            entry.groupId === group.id &&
            entry.coordinator === sessionId &&
            entry.taskStatus !== 'done' &&
            entry.taskStatus !== 'canceled'
        )
      if (task) {
        role.coordinator = true
        role.allowed = true
      }
    } catch {
      /* ignore */
    }
    return role
  }

  /** 加急权限：panel 用户（命令层直接放行）/ 维护者 / 目标所在群的群管理；普通成员不行。 */
  const urgentPermissionOf = (fromId, target, groupRef) => {
    const groups = groupStore.read()
    const wanted = String(groupRef || '').trim()
    if (maintainerStore.get() === fromId) {
      const group = wanted
        ? groupStore.find(wanted, '')
        : groups.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(target.id)) || null
      if (wanted && !group) return { ok: false, error: '找不到群组「' + wanted + '」。' }
      return { ok: true, role: 'maintainer', group }
    }
    const managed = groups.filter(
      (item) => item.managerSessionId === fromId && Array.isArray(item.sessionIds) && item.sessionIds.includes(target.id)
    )
    const picked = wanted
      ? managed.find((item) => item.id === wanted || item.id.startsWith(wanted) || item.name === wanted)
      : managed[0]
    if (!picked) {
      if (wanted) return { ok: false, error: '你不是群「' + wanted + '」的群管理，或目标不在该群。' }
      return {
        ok: false,
        error: '普通成员不能对他人加急：只有用户面板、维护者、或目标所在群的群管理可以发送加急插话。'
      }
    }
    return { ok: true, role: 'manager', group: picked }
  }

  /** 探测宿主是否提供打断能力；返回 { fn, method } 或 { fn: null }。 */
  const probeInterruptAbility = (agent) => {
    if (!agent) return { fn: null, method: '' }
    for (const method of ['interrupt', 'abort', 'stop', 'cancel']) {
      try {
        if (typeof agent[method] === 'function') return { fn: () => agent[method](), method }
      } catch {
        /* 读方法失败：继续探测下一个 */
      }
    }
    return { fn: null, method: '' }
  }

  /** 宿主级打断能力兜底探测（agent 上没有时尝试 ctx.agents.interrupt/abort/stop/cancel(sessionId)）。 */
  const probeHostInterruptAbility = (sessionId) => {
    const registry = ctx.agents
    if (!registry) return { fn: null, method: '' }
    for (const method of ['interrupt', 'abort', 'stop', 'cancel']) {
      try {
        if (typeof registry[method] === 'function') {
          return { fn: () => registry[method](sessionId), method: 'agents.' + method }
        }
      } catch {
        /* ignore */
      }
    }
    return { fn: null, method: '' }
  }

  /**
   * 发送一条加急插话：写一条带 urgent 标记的群/世界消息，并唤醒（running 时先尝试打断）。
   * 返回可读结果；限频在真正发送前判定。
   */
  const sendUrgentSession = async (options) => {
    const target = options && options.target
    if (!target || !target.id) return { ok: false, error: '缺少目标会话' }
    const text = String((options && options.text) || '').trim().slice(0, 800)
    if (!text) return { ok: false, error: '加急内容不能为空' }
    const fromId = String((options && options.fromId) || 'panel')
    const fromLabel = fromId === 'panel' ? '用户面板' : '会话 ' + shortSid(fromId)
    const origin = (options && options.origin) === 'tool' ? 'tool' : 'panel'
    const group = (options && options.group) || null
    const key = `${fromId || 'panel'}->${target.id}`
    const now = Date.now()
    const interval = urgentIntervalMs()
    const last = urgentRateMap.get(key) || 0
    if (now - last < interval) {
      const waitMs = interval - (now - last)
      return {
        ok: false,
        code: 'rate-limited',
        error: `加急过于频繁：对同一会话每 ${Math.round(interval / 1000)} 秒最多 1 条（还需等待 ${Math.ceil(waitMs / 1000)} 秒）。`,
        retryAfterMs: waitMs,
        cooldownMs: interval
      }
    }

    const sessionsNow = await buildSessionIndex()
    const availability = availabilityOfSession(target.id, sessionsNow)
    const marker = '【加急】⚡ '
    const entryResult = addEntry(
      {
        title: '⚡ 加急：' + truncate(text, 24),
        text: marker + text + '\n\n（发起：' + fromLabel + (group ? ' · 群「' + group.name + '」' : '') + '）',
        kind: 'chat',
        ...(group ? { groupId: group.id } : { scope: 'global', channel: 'world' }),
        author: fromId,
        origin,
        mentions: [target.id],
        urgent: true,
        urgentTo: [target.id],
        urgentBy: fromId,
        tags: '@加急',
        skipDedupe: true
      },
      origin
    )
    if (!entryResult.ok) return { ok: false, error: entryResult.reason || '加急消息写入失败' }
    const urgentEntry = entryResult.entry

    await ensureSessionLive(target.id)
    const agent = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(target.id) : undefined
    const wasRunning = availability.state === 'busy' && availability.reason === '运行中'
    let interrupted = false
    let degraded = false
    let degradedReason = ''
    let interruptMethod = ''
    if (wasRunning) {
      let probe = probeInterruptAbility(agent)
      if (!probe.fn) probe = probeHostInterruptAbility(target.id)
      if (probe.fn) {
        try {
          await Promise.resolve(probe.fn())
          interrupted = true
          interruptMethod = probe.method
        } catch (error) {
          degraded = true
          degradedReason =
            '宿主打断调用失败（' + (error && error.message ? error.message : String(error)) + '），已退化为插话，当前轮结束后会立刻处理。'
        }
      } else {
        degraded = true
        degradedReason =
          '宿主不支持直接打断（目标 agent 没有 interrupt/abort/stop/cancel 能力），已退化为插话：当前轮结束后会立刻处理，未假装已打断。'
      }
    }

    const message = [
      '【加急 · 需要立即处理】⚡',
      `${fromLabel}${group ? '在群「' + group.name + '」' : ''}发来一条加急插话：`,
      '',
      text,
      '',
      degraded
        ? '（系统提示：目标正在运行但宿主无法直接打断，本条已排入插话队列，当前轮结束后立即处理。）'
        : interrupted
          ? '（系统提示：已打断当前一轮并插入本条加急消息，请优先处理。）'
          : '（系统提示：加急消息已直接唤醒你，请优先处理。）'
    ].join('\n')
    const wake = wakeSession(target.id, message, { urgent: urgentEntry.id })
    if (!wake.ok) {
      try {
        appendEvents(boardDir, [{ op: 'remove', id: urgentEntry.id, by: 'system', reason: 'wake-failed', ts: Date.now() }])
      } catch {
        /* ignore */
      }
      logger.warn(`加急插话失败（唤醒不了 ${shortSid(target.id)}）：${wake.reason}`)
      return {
        ok: false,
        error:
          wake.reason === 'not-live'
            ? '目标会话不在线且宿主无法恢复，加急未送达（不会假装已送达）。'
            : '加急唤醒失败：' + wake.reason
      }
    }
    urgentRateMap.set(key, now)
    logger.info(
      `加急插话 ${urgentEntry.id}：${fromLabel} → ${shortSid(target.id)}（${availability.state}/${availability.reason}，打断=${interrupted ? interruptMethod : degraded ? '降级' : '否'}）`
    )
    return {
      ok: true,
      messageId: urgentEntry.id,
      urgentEntryId: urgentEntry.id,
      target: {
        id: target.id,
        title: target.title || shortSid(target.id),
        contactId: target.contactId || contactIdOf(target.id)
      },
      availability: availability.state,
      availabilityReason: availability.reason,
      interrupted,
      interruptedBy: interruptMethod,
      degraded,
      degradedReason,
      cooldownMs: interval,
      content: text
    }
  }

  const RECRUIT_MODES = new Set(['auto', 'new', 'existing'])

  /**
   * 组长 ↔ 世界路由：招募/分配新成员。
   * - 优先挑 idle 的现有会话（自动入群）；
   * - 不足/指定新人时走「新会话复核」（approveAutoCreate），复核通过后新建会话；
   * - 维护者/受保护会话永不入选；成功后自动加入群组并创建/指派任务；
   * - 全程写 board/chat 审计。
   */
  const recruitMembers = async (options) => {
    const opts = options || {}
    const group = opts.group
    if (!group || !group.id) return { ok: false, error: '找不到群组。' }
    const requestText = String(opts.text || '').trim().slice(0, 800)
    if (!requestText) return { ok: false, error: '招募需求不能为空（text/need）。' }
    const count = Math.max(1, Math.min(5, toNumber(opts.count, 1)))
    const mode = RECRUIT_MODES.has(opts.mode) ? opts.mode : 'auto'
    const skills = Array.isArray(opts.skills)
      ? opts.skills.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
      : []
    const requesterId = String(opts.requesterId || 'panel')
    const requesterLabel = opts.requesterLabel || (requesterId === 'panel' ? '用户面板' : '会话 ' + shortSid(requesterId))
    const origin = opts.origin === 'tool' ? 'tool' : 'panel'
    // 工具调用时只有该群的管理/组长/维护者可以发起。
    if (origin === 'tool' && requesterId !== 'panel') {
      const role = groupManageRoleOf(group, requesterId)
      if (!role.allowed) {
        return { ok: false, error: '只有本群群管理、组长（coordinator）或维护者可以请求招募新成员。' }
      }
    }

    const sessionsNow = await buildSessionIndex()
    const activeEntries = store.readActive()
    const memberIds = new Set(group.sessionIds)
    const guarded = sessionsNow.filter(
      (session) =>
        session &&
        session.id &&
        !memberIds.has(session.id) &&
        session.id !== requesterId &&
        session.internal !== true &&
        session.closed !== true &&
        !isProtectedSession(session)
    )
    const scored = guarded.map((session) => {
      const availability = availabilityOfSession(session.id, sessionsNow, activeEntries)
      const skillMatch =
        skills.length && Array.isArray(session.skills)
          ? session.skills.filter((skill) =>
              skills.some((wanted) => {
                const a = String(skill || '').toLowerCase()
                const b = String(wanted || '').toLowerCase()
                return a && b && (a.includes(b) || b.includes(a))
              })
            ).length
          : 0
      const worldRank = session.worldEligible === true ? 1 : 0
      return { session, availability, skillMatch, worldRank }
    })
    // 专门技能任务：现有空闲成员没有相关覆盖时，auto 模式改为新建成员，不硬塞老成员。
    const specialistTokens = specialistTokensOf(requestText)
    const domainCovered = scored.some((item) => {
      const session = item.session || {}
      const haystack = [session.title, ...(session.skills || [])].filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, '')
      return specialistTokens.some((token) => haystack.includes(token))
    })
    const preferNewForSpecialist = mode === 'auto' && specialistTokens.length > 0 && !domainCovered

    const idleCandidates = scored
      .filter((item) => item.availability.state === 'idle')
      .sort(
        (a, b) =>
          b.skillMatch - a.skillMatch ||
          b.worldRank - a.worldRank ||
          (b.session.points || 0) - (a.session.points || 0) ||
          (a.session.createdAt || 0) - (b.session.createdAt || 0)
      )
    const busyCount = scored.length - idleCandidates.length
    // 新任务无相关经验时默认招新：不因老人空闲就硬派。
    const profilesForRecruit = listProfilesOf(boardDir)
    const relatedExisting = idleCandidates.some((item) => {
      const profile = profilesForRecruit[item.session.id]
      const profileScore = profile ? scoreProfileForText(requestText, profile) : 0
      return item.skillMatch > 0 || profileScore > 0
    })
    const preferNewForTask = mode === 'auto' && !relatedExisting && /(新任务|新项目|新课题|新需求|预研|开发|设计|搭建|建模|做一|帮我做)/.test(requestText)
    const effectiveMode = preferNewForSpecialist || preferNewForTask ? 'new' : mode


    if (effectiveMode === 'existing' && idleCandidates.length === 0) {
      return {
        ok: false,
        error:
          '没有空闲的现有成员可招募（现有成员都在忙/离线）。可改用 mode=auto/new（不足时新建会话，会触发复核），或等成员空闲后再试。',
        idleFound: 0,
        busyFound: busyCount
      }
    }
    const existing = effectiveMode === 'new' ? [] : idleCandidates.slice(0, count)
    const newNeeded = effectiveMode === 'existing' ? 0 : Math.max(0, count - existing.length)

    // ---- 新会话必须走复核（approveAutoCreate），不静默创建 ----
    const createdSessions = []
    let approval = null
    if (newNeeded > 0) {
      const recruitWorkspace = await ensureRecruitWorkspace(group).catch(() => '')
      const approvalsNow = readApprovals()
      const approvalRef = String(opts.approvalId || '').trim()
      let approvalHit = null
      if (approvalRef) {
        approvalHit = approvalsNow.find((item) => item && (item.id === approvalRef || item.id.startsWith(approvalRef))) || null
        if (approvalHit && approvalHit.status === 'rejected') {
          return { ok: false, error: '该招募已被复核驳回，如需重新招募请重新发起。' }
        }
        if (approvalHit && approvalHit.status === 'pending' && opts.approved === true) {
          approvalHit.status = 'approved'
          approvalHit.approvedAt = Date.now()
          approvalHit.approvedBy = origin === 'panel' ? 'panel' : requesterId
          writeApprovals(approvalsNow)
        }
      }
      const bypass = opts.approved === true && approvalHit && approvalHit.status === 'approved'
      if (cfg.approveAutoCreate !== false && !bypass) {
        const existingPending = approvalsNow.find(
          (item) =>
            item &&
            item.status === 'pending' &&
            item.source === 'group.recruit' &&
            item.groupId === group.id &&
            String(item.text || '') === requestText &&
            Date.now() - (item.createdAt || 0) < 30 * 60 * 1000
        )
        if (existingPending) {
          return { ok: true, pendingApproval: true, approval: existingPending, message: '同样内容的招募已在待复核中。' }
        }
        approval = {
          id: 'ap-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex'),
          status: 'pending',
          createdAt: Date.now(),
          text: requestText,
          title: '招募：' + requestText.slice(0, 50),
          route: 'new',
          engine: 'group.recruit',
          reason: `群「${group.name}」请求招募 ${newNeeded} 位新成员（现有空闲成员不足）`,
          memberCount: newNeeded,
          workspacePath: recruitWorkspace || group.workspace || '',
          workspaceName: group.name,
          permissionNote: '工作区：' + (group.workspace || '由宿主决定') + '；继承 DSH 当前文件/工具权限',
          source: 'group.recruit',
          groupId: group.id,
          groupName: group.name,
          requester: requesterId,
          payload: { group: group.id, text: requestText, count, mode: effectiveMode, skills, ...(preferNewForSpecialist || preferNewForTask ? { preferNew: true, preferNewForTask } : {}) }
        }
        approvalsNow.push(approval)
        writeApprovals(approvalsNow)
        void notifyCouncilApproval(approval)
        try {
          addEntry(
            {
              title: '招募待复核：' + truncate(requestText, 20),
              text:
                '群「' + group.name + '」请求招募 ' + newNeeded + ' 位新成员，需要你在星桥世界页复核后才会创建会话。\n需求：' + requestText,
              kind: 'chat',
              groupId: group.id,
              author: requesterId,
              origin,
              tags: '@招募',
              skipDedupe: true
            },
            origin
          )
        } catch {
          /* 审计失败不影响复核 */
        }
        logger.info('招募进入待复核：' + approval.id + '，群「' + group.name + '」，需新建 ' + newNeeded + ' 个会话')
        return { ok: true, pendingApproval: true, approval, groupId: group.id, groupName: group.name }
      }
      let createError = ''
      for (let index = 0; index < newNeeded; index += 1) {
        const titleHint = '招募：' + (truncate(requestText, 16) || group.name)
        const created = await createSessionForTask(recruitWorkspace || group.workspace || undefined, titleHint)
        if (!created.ok) {
          createError = created.error || '创建会话失败'
          break
        }
        try {
          let hash = 0
          for (let cursor = 0; cursor < created.sessionId.length; cursor += 1) {
            hash = (hash * 31 + created.sessionId.charCodeAt(cursor)) >>> 0
          }
          identityStore.set(created.sessionId, {
            handle: uniqueHandle('新成员', created.sessionId),
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
        createdSessions.push({ id: created.sessionId, title: created.title || titleHint })
      }
      if (!createdSessions.length) {
        return { ok: false, error: '新建招募会话失败：' + (createError || '宿主不支持自动建会话') }
      }
    }

    // ---- 自动加入本群 ----
    const added = [
      ...existing.map((item) => ({
        id: item.session.id,
        title: item.session.title || shortSid(item.session.id),
        contactId: item.session.contactId || contactIdOf(item.session.id),
        availability: item.availability.state,
        source: 'existing'
      })),
      ...createdSessions.map((item) => ({
        id: item.id,
        title: item.title || shortSid(item.id),
        contactId: contactIdOf(item.id),
        availability: 'idle',
        source: 'new'
      }))
    ]
    if (!added.length) return { ok: false, error: '没有招募到任何成员（没有空闲现有成员，也没有新建会话）。' }
    const nextIds = [...new Set([...group.sessionIds, ...added.map((item) => item.id)])]
    try {
      const groups = groupStore.read()
      const target = groups.find((item) => item.id === group.id)
      if (!target) return { ok: false, error: '群组在招募过程中被删除。' }
      target.sessionIds = nextIds
      target.updatedAt = Date.now()
      groupStore.write(groups)
    } catch (error) {
      return { ok: false, error: '加入群组失败：' + (error && error.message ? error.message : String(error)) }
    }
    const freshGroup = groupStore.read().find((item) => item.id === group.id) || { ...group, sessionIds: nextIds }

    // ---- 创建/指派任务：组长优先沿用发起人，其次群管理，最后首位新成员 ----
    let coordinatorId = ''
    if (requesterId !== 'panel' && freshGroup.sessionIds.includes(requesterId)) coordinatorId = requesterId
    else if (freshGroup.managerSessionId && freshGroup.sessionIds.includes(freshGroup.managerSessionId)) {
      coordinatorId = freshGroup.managerSessionId
    } else coordinatorId = added[0].id
    const assigneeIds = added.map((item) => item.id).filter((sessionId) => sessionId !== coordinatorId)
    const memberLines = added.map(
      (item) =>
        `${item.title}（contactId=${item.contactId}${item.source === 'new' ? '，新建' : '，现有空闲'}）`
    )
    // 招募是公告，不是任务：不生成任务线、不催办、不设组长/assignee。
    const announcement = addEntry(
      {
        title: '招募公告：' + truncate(requestText, 20),
        text: '【招募公告】' + requestText + '\n发起：' + requesterLabel + '\n新增成员：' + memberLines.join('、') + '\n说明：这是公告，不是任务；由群管理/被招募成员自行沟通分工。',
        kind: 'chat',
        groupId: freshGroup.id,
        author: requesterId === 'panel' ? 'panel' : requesterId,
        origin,
        mentions: added.map((item) => item.id),
        tags: '@招募,@公告',
        skipDedupe: true
      },
      origin
    )
    const taskId = ''
    const announcementId = announcement.ok ? announcement.entry.id : ''
    try {
      const permissions = readPermissionsOf(boardDir)
      const grants = new Set(permissions.grants[coordinatorId] || [])
      for (const sessionId of assigneeIds) grants.add(sessionId)
      permissions.grants[coordinatorId] = [...grants]
      writePermissionsOf(boardDir, permissions)
    } catch {
      /* 授权失败不阻塞招募 */
    }

    // ---- 审计（群聊可见：谁发起、路由结果） ----
    const auditResult = addEntry(
      {
        title: '招募：' + truncate(requestText, 20),
        text: [
          '招募需求：' + requestText,
          '发起：' + requesterLabel + '（' + (origin === 'tool' ? '会话工具' : '用户面板') + '）',
          '方式：' + mode + (skills.length ? ' · 技能偏好：' + skills.join('/') : ''),
          '新增成员：' + memberLines.join('、'),
          announcement.ok ? '公告：' + announcementId : '公告写入失败：' + (announcement.reason || '未知'),
          '路由：现有空闲 ' + existing.length + ' 人 / 新建 ' + createdSessions.length + ' 人 / 忙碌未选 ' + busyCount + ' 人'
        ].join('\n'),
        kind: 'chat',
        groupId: freshGroup.id,
        author: requesterId === 'panel' ? 'panel' : requesterId,
        origin,
        mentions: added.map((item) => item.id),
        tags: '@招募',
        skipDedupe: true
      },
      origin
    )

    // ---- 唤醒：组长 + 成员（成员先待命，由组长派工；发起人自己不再唤醒） ----
    const requestIds = []
    const woken = []
    const addedById = new Map(added.map((item) => [item.id, item]))
    const coordinatorMessage = [
      '【招募公告 · 群管理查看】群「' + freshGroup.name + '」',
      '发起：' + requesterLabel,
      '需求：' + requestText,
      '新增成员（contactId 可直接用于 session_ask 的 to）：',
      memberLines.map((line) => ' - ' + line).join('\n'),
      '',
      '这是公告，不是任务：不生成任务线、不自动催办。请由群管理/被招募成员自行沟通分工；需要正式派活时再用 group.post 显式发布任务。'
    ].join('\n')
    const memberMessageFor = (item, requestId) =>
      [
        '【招募入组 · 公告】你已被加入群「' + freshGroup.name + '」。',
        '需求：' + requestText,
        '',
        '先用 session_profile（action=update）提交一句话申报；这是公告，不是任务，不需要按任务线交付。等群管理正式派活后再动手。'
      ].join('\n')
    const coordinatorTarget = coordinatorId && coordinatorId !== requesterId ? addedById.get(coordinatorId) : null
    if (coordinatorTarget) {
      await ensureSessionLive(coordinatorTarget.id)
      if (wakeSession(coordinatorTarget.id, coordinatorMessage, { recruitment: freshGroup.id }).ok) {
        woken.push(coordinatorTarget.id)
      }
    } else if (coordinatorId && coordinatorId !== requesterId && !coordinatorTarget) {
      // 组长是群里的老成员（群管理）：也要通知到。
      const coordinator = sessionsNow.find((session) => session.id === coordinatorId)
      await ensureSessionLive(coordinatorId)
      if (wakeSession(coordinatorId, coordinatorMessage, { recruitment: freshGroup.id }).ok) woken.push(coordinatorId)
      if (coordinator) {
        try {
          addEntry(
            {
              title: '招募组长：' + truncate(requestText, 16),
              text: coordinatorMessage,
              kind: 'note',
              groupId: freshGroup.id,
              author: requesterId === 'panel' ? 'panel' : requesterId,
              hiddenFromChat: true,
              skipDedupe: true
            },
            origin
          )
        } catch {
          /* ignore */
        }
      }
    }
    for (const item of added) {
      if (item.id === coordinatorId) continue
      if (item.id === requesterId) continue
      const request = taskId
        ? addEntry(
            {
              title: '@' + shortSid(item.id) + ' 招募任务：' + truncate(requestText, 16),
              text: requestText,
              kind: 'request',
              groupId: freshGroup.id,
              author: requesterId === 'panel' ? 'panel' : requesterId,
              origin,
              requestTo: [item.id],
              mentions: [item.id],
              hiddenFromChat: true,
              taskId,
              taskRole: 'member',
              skipDedupe: true
            },
            origin
          )
        : null
      const requestId = request && request.ok ? request.entry.id : ''
      if (requestId) requestIds.push(requestId)
      await ensureSessionLive(item.id)
      if (wakeSession(item.id, memberMessageFor(item, requestId), { requestId }).ok) woken.push(item.id)
    }
    try {
      requestMemberProfiles(freshGroup, added.map((item) => item.id), requesterId)
    } catch {
      /* ignore */
    }
    logger.info(
      `招募 ${auditResult.ok ? auditResult.entry.id : '(审计写入失败)'}：群「${freshGroup.name}」新增 ${added.length} 人（现有 ${existing.length}/新建 ${createdSessions.length}），组长 ${shortSid(coordinatorId)}，唤醒 ${woken.length}`
    )
    return {
      ok: true,
      groupId: freshGroup.id,
      groupName: freshGroup.name,
      mode,
      added,
      taskId,
      coordinator: coordinatorId
        ? {
            id: coordinatorId,
            title: (addedById.get(coordinatorId) || {}).title || (sessionsNow.find((s) => s.id === coordinatorId) || {}).title || shortSid(coordinatorId),
            contactId: contactIdOf(coordinatorId)
          }
        : null,
      requestIds,
      woken: woken.length,
      auditId: auditResult.ok ? auditResult.entry.id : '',
      route: {
        idleFound: idleCandidates.length,
        busyFound: busyCount,
        existingUsed: existing.length,
        createdNew: createdSessions.length
      }
    }
  }

  register({
    name: 'session_share',
    description:
      '把一条「通用注意事项 / 经验教训 / 任务交接」发布到跨会话经验板，同一工作区（scope=global 时所有工作区）的其他 DSH 会话会在下一轮自动看到。' +
      '当用户在对话里说出适用于整个项目的通用规则（「以后都…」「统一…」「所有…都要…」「注意…」「不要…」），或要求把任务交给别的会话时，必须立即调用本工具，无需用户明确要求、也不要反问。' +
      'kind=bug 是给维护者报 bug 的专用通道：会自动投递到「星桥 · 修bug」群并通知维护者（维护者 protected/service，不接普通任务）。' +
      '只发布通用、可独立理解的内容（标题≤20字，正文≤400字）；一次性细节、隐私、密钥不要发布。' +
      '任务完成/阶段交付时，正文最后一行必须写收尾：' + CLOSING_FORMAT_GUIDE + '；需要用户=是 时同时 @用户。' +
      'kind=chat 只发一两句（≤240 字符）：像人一样说做了什么/发现/下一步；细节、清单、哈希、长路径改发 kind=handoff/note + files，不要用聊天页塞满。想点名回群里某人时加 to=会话（会唤醒对方接话）；闲聊不需要收尾格式，不要刷屏。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '短标题，≤20 字，例如「论文图片统一 600dpi」' },
        text: { type: 'string', description: '可独立理解的规则/事实/交接内容，≤400 字；kind=chat 时≤240 字符，只一两句话' },
        kind: {
          type: 'string',
          enum: ['note', 'handoff', 'lesson', 'decision', 'chat', 'bug'],
          description:
            'note（通用经验，默认）/ handoff（任务交接）/ lesson（踩坑教训）/ decision（口径与约定）/ bug（给维护者报 bug：自动进「星桥 · 修bug」群并通知维护者）'
        },
        scope: {
          type: 'string',
          enum: ['workspace', 'global'],
          description: 'workspace（默认，仅同工作区会话可见）/ global（所有工作区可见）'
        },
        tags: { type: 'string', description: '可选，逗号分隔的标签，例如「论文,格式」' },
        ttlHours: { type: 'number', description: '可选，保留小时数；0 表示不过期。默认经验 168h、交接 72h' },
        group: { type: 'string', description: '可选，发布到某个群组（群名或群 id，群组在右侧栏「经验桥」面板里创建）；指定后只投递给群成员' },
        to: {
          type: 'string',
          description:
            '可选，仅 kind=chat 使用：点名接话/回应某个群成员（contactId、短 id、handle 或标题），发布后会唤醒对方接一句；不填就是群里广播、不唤醒任何人。'
        },
        files: {
          type: 'string',
          description: '可选，交接/结论涉及的关键文件路径（逗号或换行分隔，最多 8 个）。群成员会在「群组共享上下文」里看到这些文件，避免重复产出'
        },
        replyTo: {
          type: 'string',
          description: '可选，回复某条「群内请求」的 id（session_ask 生成的请求 id 前缀即可）。回复后请求方会被通知，请求在看板上标记为已回复'
        },
        scopeConfirmed: {
          type: 'boolean',
          description:
            '可选，仅任务 owner 使用：交付明显超出 taskScope（额外盘/全盘、runbook、工具链等）但确认这是用户的新要求时传 true；否则不会被自动扩展/结算，只记录 scopeWarning'
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
      const incomingText = String((args && args.text) || '').trim()
      if (kind === 'chat' && incomingText.length > CHAT_TEXT_LIMIT) return `CHAT_TOO_LONG: ${incomingText.length} > ${CHAT_TEXT_LIMIT}；群聊只发一两句话，细节改发 kind=handoff/note 或 files。`
      const scope = args && args.scope === 'global' ? 'global' : cfg.scope === 'global' ? 'global' : 'workspace'
      const groupRef = args && typeof args.group === 'string' ? args.group.trim() : ''
      let group = groupRef ? groupStore.find(groupRef, info.cwd) : null
      // v2.9.1：kind=bug 是给维护者的专用投递通道 → 强制落到「星桥 · 修bug」群（没有就自动建/复用）。
      let bugRedirectFrom = ''
      let bugfixGroupNameNow = ''
      if (kind === 'bug') {
        const ensuredBugfix = await ensureBugfixGroup({})
        if (ensuredBugfix.ok) {
          bugfixGroupNameNow = ensuredBugfix.name
          const bugfixGroupNow = groupStore.read().find((item) => item.id === ensuredBugfix.groupId)
          if (bugfixGroupNow) {
            if (group && group.id !== bugfixGroupNow.id) bugRedirectFrom = group.name
            group = bugfixGroupNow
          }
        }
      }
      const replyRef = args && typeof args.replyTo === 'string' ? args.replyTo.trim() : ''
      const replyRequest = replyRef ? findRequestEntry(replyRef) : null
      const replyGroup = replyRequest && replyRequest.groupId
        ? groupStore.read().find((item) => item.id === replyRequest.groupId)
        : null
      const effectiveGroup = group || replyGroup
      // kind=chat + to：点名接话，只允许本群成员，避免唤醒无关会话。
      let chatTarget = null
      let chatTargetNote = ''
      if (kind === 'chat' && effectiveGroup && args && String(args.to || '').trim()) {
        try {
          const members = (await buildSessionIndex())
            .filter((session) => effectiveGroup.sessionIds.includes(session.id))
            .filter((session) => session.id !== info.id && session.id !== maintainerStore.get())
          const resolution = resolveSessionRef(String(args.to).trim(), members)
          if (resolution.ok) chatTarget = resolution.session
          else chatTargetNote = `接话对象未解析：${resolution.error}`
        } catch (error) {
          chatTargetNote = `接话对象解析失败：${error && error.message ? error.message : error}`
        }
      }
      const replyText = String((args && args.text) || '') + ' ' + String((args && args.title) || '')
      const looksFinal = /(完成|已完成|已交付|交付完成|通过|验收通过|成功|done|finished|delivered|ready)/i.test(replyText) &&
        !/(未完成|无法|失败|受阻|进行中|待完成|还没)/i.test(replyText)
      const gateTask = replyRequest && replyRequest.taskId ? findBoardEntry(replyRequest.taskId) : null
      // v2.10.1 归属锁：任务请求只看任务 owner（coordinator/assignee），普通请求看收件人。
      const gateTaskOwner = gateTask ? taskOwnerOf(gateTask) : ''
      const gateTaskScope = gateTask
        ? normalizeTaskScope(gateTask.taskScope, gateTask.text || gateTask.title)
        : replyRequest
          ? normalizeTaskScope(replyRequest.taskScope, replyRequest.text || replyRequest.title)
          : ''
      const isTaskReply = Boolean(replyRequest && replyRequest.taskId && gateTask)
      const replyIsOwner = Boolean(isTaskReply && gateTaskOwner && gateTaskOwner === info.id)
      const replyIsProposal = Boolean(isTaskReply && !replyIsOwner)
      const scopeExpansion = replyIsOwner ? detectScopeExpansion(gateTaskScope, replyText) : []
      const scopeNeedsConfirm = scopeExpansion.length > 0 && !(args && args.scopeConfirmed === true)
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
          ttlHours: args && args.ttlHours,
          mentions: chatTarget ? [chatTarget.id] : [],
          // 对请求的回复是「结算/建议」而不是普通广播，不能被 48h 文本查重吞掉（尤其 scopeConfirmed 重发）。
          skipDedupe: Boolean(replyRequest),
          ...(replyRequest && replyRequest.taskId ? { taskId: replyRequest.taskId } : {}),
          ...(replyIsProposal ? { proposal: true, taskVerdict: 'proposal' } : {}),
          ...(isTaskReply && replyIsOwner ? { taskVerdict: scopeNeedsConfirm ? 'scope-warning' : 'owner-delivery' } : {}),
          ...(scopeNeedsConfirm ? { scopeWarning: scopeExpansion.join('；') } : {})
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
      // kind=chat + to：点名接话，唤醒对方继续聊（只聊一句，不当作任务）。
      if (chatTarget) {
        try {
          const lastChatWake = chatWakeAt.get(chatTarget.id) || 0
          if (Date.now() - lastChatWake < 2 * 60 * 1000) {
            chatTargetNote = `已点名 ${shortSid(chatTarget.id)}；2 分钟内刚唤醒过，本条只留在群里，不重复唤醒。`
          } else {
          chatWakeAt.set(chatTarget.id, Date.now())
          await ensureSessionLive(chatTarget.id)
      const contextLines = discussionContextOf(effectiveGroup.id, 4)
          const chatMessage = [
            `【群聊接话 · 不是任务】${shortSid(info.id)} 在群「${effectiveGroup.name}」点名回了你：`,
            truncate(String((args && args.text) || '').replace(/\s*\n\s*/g, ' / '), 300),
            ...(contextLines.length ? ['', '最近聊到：', ...contextLines] : []),
            '',
            `你可以用一两句话接一句（session_share kind=chat、group=${effectiveGroup.name}${chatTarget ? '、to=' + shortSid(chatTarget.id) : ''}）；觉得有趣就回，不想接可以忽略，最多一句，不要刷屏。`
          ].join('\n')
          const woke = wakeSession(chatTarget.id, chatMessage, {})
          chatTargetNote = woke.ok
            ? `已点名接话并唤醒 ${shortSid(chatTarget.id)}（chat，不派任务）。`
            : `已点名 ${shortSid(chatTarget.id)}；对方当前不在线，下次运行会看到。`
          }
        } catch (error) {
          chatTargetNote = `点名接话失败：${error && error.message ? error.message : error}`
        }
      }
      // v2.9.1：kind=bug → 通知维护者处理（维护者 protected/service，不当作普通任务）。
      let bugNote = ''
      if (kind === 'bug') {
        const maintainerIdNow = maintainerStore.get()
        if (maintainerIdNow) {
          const bugFiles = normalizeFilesOf(args && args.files)
          const message = [
            '【BUG 报告' + (result.group ? ' · 修bug群「' + result.group.name + '」' : '') + '】',
            String((args && args.title) || truncate(String((args && args.text) || ''), 24)),
            '',
            String((args && args.text) || ''),
            ...(bugFiles.length ? ['文件：' + bugFiles.join('、')] : []),
            '',
            `请按影响面处理；修好后用 session_share（kind=handoff、group=${result.group ? result.group.name : BUGFIX_GROUP_NAME}、replyTo=${result.entry.id}、files=…）回执。`,
            `（来自会话 ${shortSid(info.id)}；这是 bug 投递，不是普通任务派活。）`
          ].join('\n')
          const wakeOutcome = wakeSession(maintainerIdNow, message, { requestId: result.entry.id })
          bugNote = wakeOutcome.ok
            ? ' 已通知维护者（protected/service）处理。'
            : ' 维护者当前不在线，下次运行会看到这条 BUG 报告。'
        }
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
        if (request && request.status === 'canceled') {
          // 任务/请求已被撤回：只按普通条目发布，不再结算积分、不标记任务完成、不唤醒请求方。
          replyNote = `replyTo 对应的请求「${request.title}」已被撤回：本条只按普通条目发布，不结算积分、不标记任务完成。`
        } else if (request && request.kind === 'request') {
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
          if (firstAnswer && request.taskRole === 'member' && replyIsOwner) {
            scoreSession(info.id, 8, { success: true })
            try {
              const memberTask = findBoardEntry(request.taskId)
              if (memberTask && memberTask.coordinator) relationStore.bump(info.id, memberTask.coordinator, 1)
            } catch {
              /* ignore */
            }
            replyNote += ' 任务提交 +8 积分。'
          }
          if (firstAnswer && request.taskRole === 'coordinator' && replyIsOwner) {
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
          if (firstAnswer && request.taskRole !== 'member' && request.taskRole !== 'coordinator' && (!isTaskReply || replyIsOwner)) {
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
          const wakeTarget = replyIsProposal && gateTaskOwner && gateTaskOwner !== info.id ? gateTaskOwner : request.author
          if (wakeTarget && wakeTarget !== info.id) {
            const wakeText = [
              replyIsProposal
                ? `【群任务 · 收到 proposal/建议（非 owner，未结算） · 来自会话 ${shortSid(info.id)}】`
                : `【群内请求已收到回复 · 来自会话 ${shortSid(info.id)}】`,
              `请求：${request.title}`,
              `${replyIsProposal ? '建议' : '回复'}：${result.entry.title}：${truncate(String(result.entry.text || '').replace(/\s*\n\s*/g, ' / '), 300)}`,
              ...(result.entry.files && result.entry.files.length ? [`文件：${result.entry.files.join('、')}`] : []),
              replyIsProposal
                ? `这只是 proposal：请 owner（${gateTaskOwner ? shortSid(gateTaskOwner) : '任务负责人'}）确认后再推进 taskStatus / 汇总，非 owner 不结算完成奖励。`
                : '（这是一条会话间通知，如需继续追问可用 session_ask 再发请求。）'
            ].join('\n')
            const woke = wakeSession(wakeTarget, wakeText, { requestId: request.id })
            replyNote = replyIsProposal
              ? `已作为 proposal/建议提交给 owner ${gateTaskOwner ? shortSid(gateTaskOwner) : '（未指定）'}（id=${request.id.slice(0, 14)}…）；非 owner 不推进任务状态、不结算完成奖励；${woke.ok ? '已唤醒组长收集（proposal 待确认）。' : '组长不在线，下次运行会看到 proposal。'}`
              : `已回复请求「${request.title}」（id=${request.id.slice(0, 14)}…）；${woke.ok ? '请求方会话已被唤醒。' : '请求方当前不在线，下次运行会看到这条回复。'}`
          } else {
            replyNote = replyIsProposal
              ? `已作为 proposal/建议记录（id=${request.id.slice(0, 14)}…）；非 owner 不推进任务状态、不结算完成奖励。`
              : `已回复请求「${request.title}」（id=${request.id.slice(0, 14)}…）。`
          }
          // 群任务角色：只有 owner 能推进 taskStatus；非 owner 只记为 proposal。
          if (request.taskId) {
            const isCoordinator = request.taskRole === 'coordinator'
            const taskAdvanced = replyIsOwner && !scopeNeedsConfirm
            if (!replyIsOwner) {
              appendEvents(boardDir, [
                {
                  op: 'task',
                  id: request.taskId,
                  patch: {
                    proposalCount: toNumber(gateTask && gateTask.proposalCount, 0) + 1,
                    lastProposalAt: Date.now(),
                    lastProposalBy: info.id,
                    proposalTaskStatus: (gateTask && gateTask.taskStatus) || 'assigned'
                  },
                  ts: Date.now()
                }
              ])
              replyNote += ` 任务归属锁：owner=${gateTaskOwner ? shortSid(gateTaskOwner) : '（未指定）'}，本次只作为 proposal，未推进 taskStatus、未结算完成奖励。`
            } else if (scopeNeedsConfirm) {
              appendEvents(boardDir, [
                {
                  op: 'task',
                  id: request.taskId,
                  patch: {
                    scopeWarning: scopeExpansion.join('；'),
                    scopeWarningAt: Date.now(),
                    scopeWarningBy: info.id
                  },
                  ts: Date.now()
                }
              ])
              replyNote += ` 检测到超出任务 scope：${scopeExpansion.join('；')}。已记录 warning，未自动扩展、未标记完成；如确认这是用户的新要求，请带 scopeConfirmed=true 重发，或在派活消息里先更新 scope。`
            } else {
              appendEvents(boardDir, [
                {
                  op: 'task',
                  id: request.taskId,
                  patch: {
                    taskStatus: isCoordinator ? 'done' : 'collecting',
                    ...(scopeExpansion.length
                      ? { scopeConfirmedAt: Date.now(), scopeConfirmedBy: info.id, scopeConfirmedReasons: scopeExpansion }
                      : {})
                  },
                  ts: Date.now()
                }
              ])
            }
            // task-7：组长把任务标记完成 → 在群里生成一条来自组长的完成通知并 @用户（幂等，只生成一次）。
            if (isCoordinator && taskAdvanced) {
              try {
                ensureTaskCompletionNotice(request.taskId, { completedAt: Date.now() })
              } catch (error) {
                logger.warn(`任务完成通知生成失败：${error && error.message ? error.message : error}`)
              }
            }
            // 任务刚变成 done：立刻推进以该任务为前置的串行指令。
            if (isCoordinator && taskAdvanced) {
              try {
                runPendingQueue({ source: 'task-done' })
              } catch {
                /* ignore */
              }
            }
            if (isCoordinator && taskAdvanced) {
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
                        entry.status !== 'canceled' &&
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
            } else if (taskAdvanced) {
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
        ...(chatTargetNote ? [chatTargetNote] : []),
        ...(bugNote ? [bugNote] : []),
        ...(bugRedirectFrom ? [`（本次指定了群「${bugRedirectFrom}」，BUG 报告已统一投递到「${bugfixGroupNameNow || BUGFIX_GROUP_NAME}」群。）`] : []),
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
      'text 上限 8000 字符；超限会直接返回 TEXT_TOO_LONG，不会静默截断。' +
      '收到请求的一方用 session_share（kind=handoff、group=群名、replyTo=请求 id、files=文件）回复，请求方会被自动通知。' +
      '任务有先后依赖（串行）时传 dependsOn=前置请求/任务 id（可多个）与可选 delayMs：前置未完成不会唤醒目标，先排队，完成后自动发出。' +
      '回复任务时最后一行必须写收尾：' + CLOSING_FORMAT_GUIDE + '；需要用户=是 时同时 @用户。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '群组名或群 id（session_board action=groups 可列出）' },
        text: { type: 'string', description: '要什么：文件路径 / 进度 / 数据 / 结论，写清楚（≤8000 字符；超限显式报错，不静默截断）' },
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
        },
        scope: {
          type: 'string',
          description:
            '可选，本次派活的工作范围（只做什么、不做什么）。不传则沿用所属任务 taskScope，或从正文推导；消息模板会写「仅做 scope，禁止扩展」'
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
      const rawAskText = String((args && args.text) || '').trim()
      if (rawAskText.length > ASK_TEXT_LIMIT) return `TEXT_TOO_LONG: ${rawAskText.length} > ${ASK_TEXT_LIMIT}；请拆成多条或先落文件，不要静默丢末项。`
      const text = rawAskText
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
      // v2.9.1 权限分级：维护者 protected/service，不能被 session_ask 当普通任务/探测目标。
      // 例外：在「星桥 · 修bug」群里投递 bug（按 BUG 报告处理，不挂任务角色）。
      const protectedTargets = targets.filter((session) => session.protected === true || isMaintainerSession(session.id))
      let bugfixDelivery = false
      if (protectedTargets.length) {
        if (!isBugfixGroup(group)) {
          return protectedRefusalText(
            protectedTargets
              .map((session) => `${session.title}（contactId=${session.contactId || contactIdOf(session.id)}）`)
              .join('、'),
            ['（session_ask 不会把维护者当作普通任务/探测目标；本次未写请求、未唤醒。）']
          )
        }
        bugfixDelivery = true
      }
      const unprotectedTargets = targets.filter((session) => !protectedTargets.includes(session))
      const grants = readPermissionsOf(boardDir).grants[info.id] || []
      const canEscalateToManager = (session) => Boolean(group.managerSessionId && session.id === group.managerSessionId && group.sessionIds.includes(info.id))
      const unauthorized = (bugfixDelivery ? unprotectedTargets : targets).filter((session) => !grants.includes(session.id) && !canEscalateToManager(session))
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
              taskOwnerOf(entry) === info.id &&
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
      // 修bug群里给维护者的投递一律按 BUG 报告（不是任务分配），避免被扣上组长/成员角色。
      if (bugfixDelivery) askMode = 'probe'
      const assignmentTask = askMode === 'task' ? taskCandidate : null
      // v2.10.1：请求也必须带 scope；超出已分配任务范围时提示 owner，不自动扩展。
      const explicitAskScope = String((args && args.scope) || '').trim()
      const askTaskScope = normalizeTaskScope(
        explicitAskScope || (assignmentTask && assignmentTask.taskScope),
        `${text}`
      )
      const askScopeExpansion = assignmentTask
        ? detectScopeExpansion(assignmentTask.taskScope || askTaskScope, text)
        : explicitAskScope
          ? detectScopeExpansion(explicitAskScope, text)
          : []
      const askScopeWarning = askScopeExpansion.length ? askScopeExpansion.join('；') : ''

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
                entry.status !== 'canceled' &&
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
      const title =
        String((args && args.title) || '').trim().slice(0, 60) ||
        (bugfixDelivery ? `BUG 报告：${truncate(text, 18)}` : `群内请求：${truncate(text, 18)}`)
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
          step: assignmentTask ? stepNo : 0,
          taskScope: askTaskScope,
          scopeWarning: askScopeWarning
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
          taskScope: askTaskScope,
          skipDedupe: Boolean(assignmentTask),
          ...(askScopeWarning ? { scopeWarning: askScopeWarning } : {}),
          ...(bugfixDelivery ? { tags: '@bug' } : {}),
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
      // 探测（提问/要进度）和任务分配用不同模板：
      // - 探测：正文顶到最前，只要求针对正文回答，不叮嘱复杂回复格式，避免对方过度分析；
      // - 任务：才附「怎么回复/交给谁」。
      const scopeMessageLine = `【范围锁】归属：${assignmentTask ? shortSid(taskOwnerOf(assignmentTask)) : shortSid((targets[0] && targets[0].id) || info.id)} · 仅做 scope：${askTaskScope}（${TASK_SCOPE_DISPATCH_TAIL}）`
      const scopeWarningLine = askScopeWarning
        ? `⚠ 范围提醒：${askScopeWarning} —— 已超出原 scope，需 owner 确认，不要自动扩展。`
        : ''
      const requestMessage = bugfixDelivery
        ? [
            '【BUG 报告 · 修bug群投递（不是普通任务）】',
            text,
            '',
            `请按影响面处理；修好后用 session_share（kind=handoff、group=${group.name}、replyTo=${requestId}、files=文件路径）回执。`,
            `（来自会话 ${shortSid(info.id)} · 群组「${group.name}」· 维护者 protected/service，只收 bug 报告，不接普通派活）`
          ].join('\n')
        : askMode === 'task'
        ? assignmentTask
          ? [
              `【任务分配 · 群任务：${assignmentTask.title}】`,
              text,
              scopeMessageLine,
              scopeWarningLine,
              '',
              `请只做你负责的部分；完成后用 session_share（kind=handoff、group=${group.name}、replyTo=${requestId}、files=文件路径）提交给组长，不要直接向用户汇报，也不要重复执行其他成员的任务。`,
              `（来自会话 ${shortSid(info.id)} · 群组「${group.name}」）`
            ].filter(Boolean).join('\n')
          : [
              '【任务分配 · 群内派活】',
              text,
              scopeMessageLine,
              scopeWarningLine,
              '',
              `请执行/完成上面的工作；完成后用 session_share（kind=handoff、group=${group.name}、replyTo=${requestId}、files=文件路径）回复，正文写清结果/进度；不要展开无关分析。`,
              `（来自会话 ${shortSid(info.id)} · 群组「${group.name}」）`
            ].filter(Boolean).join('\n')
        : [
            '【群内请求 · 探测（不是任务） · 请直接回答正文】',
            text,
            '',
            '（这是探测/询问：只需针对正文简短回答或给一句结论，不要自行扩大成复核/改稿任务；如果正文其实是明确的修改或交付要求，请按任务执行并回报结果。）',
            `（来自会话 ${shortSid(info.id)} · 群组「${group.name}」）`
          ].join('\n')

      const woken = []
      const sleepy = []
      for (const target of targets) {
        const outcome = wakeSession(target.id, requestMessage, { requestId })
        if (outcome.ok) woken.push(target)
        else sleepy.push(target)
      }
      return [
        bugfixDelivery
          ? `已向修bug群「${group.name}」投递 BUG 报告：${title}（id=${requestId}）`
          : askMode === 'task'
            ? `已向群组「${group.name}」发出任务分配：${title}（id=${requestId}）`
            : `已向群组「${group.name}」发出探测：${title}（id=${requestId}）`,
        `目标成员：${memberInlineText(targets) || '(无)'}`,
        askScopeWarning
          ? `⚠ 范围提醒：${askScopeWarning}。本次只记录 warning，不自动扩展 scope；请 owner 确认后再追加。`
          : '',
        bugfixDelivery ? '（维护者 protected/service：本次按 BUG 报告投递，不当作普通任务派活。）' : '',
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
      // v2.9.1 权限分级：维护者 protected/service，不能被 session_nudge 当普通催收对象。
      // 例外：在修bug群里对维护者发 bug 提醒是允许的（tag @bug）。
      const targetProtected = target.protected === true || isMaintainerSession(target.id)
      const bugfixNudge = targetProtected && isBugfixGroup(group)
      if (targetProtected && !bugfixNudge) {
        return protectedRefusalText(`${target.title}（contactId=${target.contactId || contactIdOf(target.id)}）`, [
          '（session_nudge 不会把维护者当作普通催收/提醒对象；本次未写入、未打扰。）'
        ])
      }
      const grants = readPermissionsOf(boardDir).grants[info.id] || []
      const canEscalateToManager = Boolean(group.managerSessionId && target.id === group.managerSessionId && group.sessionIds.includes(info.id))
      if (!bugfixNudge && !grants.includes(target.id) && !canEscalateToManager) {
        return `没有插话权限：用户还没有授权本会话唤醒/提醒「${target.title}」。请让用户在群组设置里授权。`
      }
      const title = String((args && args.title) || '').trim().slice(0, 60) || (bugfixNudge ? `BUG 提醒：${truncate(text, 18)}` : `催收：${truncate(text, 18)}`)
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
          ...(bugfixNudge ? { tags: '@bug' } : {}),
          skipDedupe: true
        },
        'tool'
      )
      if (!result.ok) return `插话失败：${result.reason}`
      logger.info(`插话提醒 ${shortSid(target.id)}：${title}`)
      return [
        `已插话给「${target.title}」：不会唤醒、不会额外开一轮。`,
        bugfixNudge ? '（维护者 protected/service：这条按 BUG 提醒投递，不是普通任务催收。）' : '',
        '对方下一次处理时会在上下文里看到这条提醒；如果它已经完成，会直接忽略，不会再回复一次。'
      ]
        .filter(Boolean)
        .join('\n')
    }
  })

  register({
    name: 'session_retract',
    description:
      '撤回看板里的消息/任务/请求（v2.9.2）：按看板条目 id 撤回；撤回任务会同时把关联未完成请求标 canceled、撤回关联待复核记录，且不会误发完成奖励。' +
      '权限：维护者全量；群管理只能撤回本群条目；作者只能撤回自己未处理的条目；普通成员不能撤回他人任务。面板用户可直接在星桥窗口点「撤回」。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要撤回的看板条目 id（前缀即可）或待复核记录 id（ap-…）' },
        reason: { type: 'string', description: '可选，撤回原因（写进审计事件）' }
      },
      required: ['id']
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const guard = requireRootAgent(exec)
      if (guard.error) return guard.error
      const info = sessionInfoOf(guard.agent)
      const id = String((args && args.id) || '').trim()
      if (!id) return 'session_retract 需要 id（看板条目 id 或待复核记录 id）。'
      const result = retractBoardEntry({
        ref: id,
        actor: { kind: 'session', sessionId: info.id },
        reason: args && args.reason
      })
      if (!result.ok) return '撤回失败：' + result.error
      return (
        result.message +
        (result.canceledRequests && result.canceledRequests.length
          ? '\n关联未完成请求已标 canceled：' + result.canceledRequests.map((item) => String(item).slice(0, 14)).join('、')
          : '')
      )
    }
  })

  register({
    name: 'session_interrupt',
    description:
      '打断某个会话正在运行的一轮（v2.9.2，不删除会话、不丢历史）：按 sessionId 打断，也支持 contactId / 短 id / handle / 标题。' +
      '权限：维护者全量；群管理只能打断本群 running 成员；普通成员只能打断自己。宿主不支持直接打断时会明确报错并给替代方案（不会假装成功）。面板用户可直接在星桥窗口点「打断」。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '要打断的会话：完整 id / contactId / 短 id / handle / 标题' },
        reason: { type: 'string', description: '可选，打断原因' }
      },
      required: ['sessionId']
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const guard = requireRootAgent(exec)
      if (guard.error) return guard.error
      const info = sessionInfoOf(guard.agent)
      const sessionId = String((args && args.sessionId) || '').trim()
      if (!sessionId) return 'session_interrupt 需要 sessionId（完整 id / contactId / 短 id / handle / 标题）。'
      const result = await interruptRunningSession({
        sessionId,
        actor: { kind: 'session', sessionId: info.id },
        reason: args && args.reason
      })
      if (!result.ok) {
        return [
          '打断失败：' + result.error,
          ...(Array.isArray(result.alternatives)
            ? ['替代方案：', ...result.alternatives.map((item, index) => `${index + 1}. ${item}`)]
            : [])
        ].join('\n')
      }
      return result.message
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
    description: '在群里发起一次轻量讨论：唤醒成员用一两句话接话/表达观点（不是任务，不需交付文件）。当用户说「大家聊聊/讨论一下/头脑风暴」时使用；成员可接着别人的话聊，也可用 session_share kind=chat + to=某人 继续。限时 2 分钟：到点不回复先警告，宽限期后仍不回复会关闭其对话。',
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
      const discussionEntry = addEntry(
        { title: '讨论：' + topic.slice(0, 20), text: topic, kind: 'chat', groupId: group.id, author: info.id, mentions: targets.map((t) => t.id), tags: '@讨论', skipDedupe: true },
        'tool'
      )
      if (discussionEntry && discussionEntry.ok) watchDiscussionReply({ group, topic, targets, sinceTs: discussionEntry.entry.ts || Date.now() })
      const contextLines = discussionContextOf(group.id, 4)
      const message = [
        '【讨论 · 请用一两句话参与（不是任务）】',
        topic,
        '',
        ...(contextLines.length ? ['最近群里聊到：', ...contextLines, ''] : []),
        '讨论不是每人各发一段观点：先看最近讨论，接着某一句赞同/反驳/补充，再 @ 一个具体成员继续。2 句话以内，直接 session_share（kind=chat、group=' + group.name + '；想点名接话加 to=<成员>）发出来。这是闲聊，禁止直接干活/执行任务/读写文件；如果刚好发现 bug，可以用 session_share kind=bug 提一下，但不要顺手修。限时 2 分钟回应；到点没反应先警告，警告后 60 秒仍无闲聊或 bug 反馈将关闭对话。'
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
    name: 'task_transfer',
    description: '任务路由后的转交申请/审批：被邀请人认为分配不合理时，用 action=request 指定更合适的候选人（contactId/标题）和理由；组长/群管理/高官用 action=approve 批准，或 action=reject 驳回；候选人可用 action=decline 拒绝。未经批准不会改 coordinator/assignees。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['request', 'approve', 'reject', 'decline'], description: 'request 申请 / approve 批准 / reject 驳回 / decline 候选人拒绝' },
        task: { type: 'string', description: '任务 id 或标题（request 时必填）' },
        to: { type: 'string', description: '更合适的候选人 contactId / 标题（request 时必填）' },
        reason: { type: 'string', description: '转交理由/审批意见' },
        requestId: { type: 'string', description: '转交申请 id（approve/reject/decline 时必填）' }
      },
      required: ['action']
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const guard = requireRootAgent(exec)
      if (guard.error) return guard.error
      const info = sessionInfoOf(guard.agent)
      const action = String((args && args.action) || '').trim()
      const sessionsNow = await buildSessionIndex()
      if (action === 'request') {
        const task = findBoardEntry(args && args.task)
        if (!task || task.kind !== 'task') return '找不到任务：' + (args && args.task)
        if (!(task.coordinator === info.id || (Array.isArray(task.assignees) && task.assignees.includes(info.id)) || task.owner === info.id)) return '只有该任务的组长/成员可以申请转交。'
        const candidateResolution = resolveSessionRef(String((args && args.to) || '').trim(), sessionsNow)
        if (!candidateResolution.ok) return '候选人无法解析：' + candidateResolution.error
        const candidate = candidateResolution.session
        if (candidate.id === info.id || candidate.id === task.coordinator) return '候选人与当前分配相同，无需转交。'
        if (candidate.protected || candidate.service || isMaintainerSession(candidate.id)) return '受保护/维护者会话不能作为普通任务候选人。'
        const group = groupStore.read().find((item) => item.id === task.groupId) || null
        const approverId = task.coordinator || task.owner || (group && group.managerSessionId) || ''
        if (!approverId) return '任务没有可审批的组长/群管理。'
        const request = addEntry({
          title: '转交申请：' + String(task.title || task.id).slice(0, 40) + ' → ' + (candidate.title || shortSid(candidate.id)),
          text: '申请把任务「' + String(task.title || task.id) + '」转交给 ' + (candidate.title || shortSid(candidate.id)) + '（contactId=' + (candidate.contactId || contactIdOf(candidate.id)) + '）。理由：' + (String((args && args.reason) || '').slice(0, 200) || '更合适') + '。审批前不改变原分配。',
          kind: 'request',
          groupId: task.groupId,
          author: info.id,
          requestTo: [approverId],
          taskId: task.id,
          transferTaskId: task.id,
          transferCandidateId: candidate.id,
          transferReason: String((args && args.reason) || ''),
          skipDedupe: true
        }, 'tool')
        if (!request.ok) return '转交申请创建失败：' + (request.reason || '未知')
        await ensureSessionLive(approverId)
        wakeSession(approverId, [
          '【转交申请 · 待审批】',
          '任务：' + String(task.title || task.id),
          '申请人：' + (info.handle || shortSid(info.id)),
          '候选人：' + (candidate.title || shortSid(candidate.id)) + '（' + (candidate.contactId || contactIdOf(candidate.id)) + '）',
          '理由：' + (String((args && args.reason) || '') || '更合适'),
          '',
          '批准用 task_transfer action=approve requestId=' + request.entry.id + '；驳回用 reject。'
        ].join('\n'), {})
        return '已发起转交申请：' + request.entry.id + '。待组长/群管理审批，批准前不改分配。'
      }
      const request = findBoardEntry(args && args.requestId)
      if (!request || request.kind !== 'request' || !request.transferCandidateId) return '找不到转交申请：' + (args && args.requestId)
      const task = findBoardEntry(request.transferTaskId || request.taskId)
      if (!task || task.kind !== 'task') return '转交申请对应的任务不存在。'
      if (action === 'decline') {
        if (info.id !== request.transferCandidateId) return '只有候选人本人可以拒绝转交。'
        appendEvents(boardDir, [{ op: 'task', id: request.id, patch: { status: 'canceled', canceledAt: Date.now(), canceledBy: info.id, transferStatus: 'declined' }, ts: Date.now() }])
        return '已拒绝转交：' + (task.title || task.id)
      }
      const group = groupStore.read().find((item) => item.id === task.groupId) || null
      const allowed =
        info.id === task.coordinator ||
        info.id === task.owner ||
        (group && group.managerSessionId === info.id) ||
        isMaintainerSession(info.id) ||
        (officePrivilegesOf(info.id).canApproveTransfer && group && group.sessionIds.includes(info.id))
      if (!allowed) return '只有组长/群管理/高官/维护者可以审批转交。'
      if (action === 'reject') {
        appendEvents(boardDir, [{ op: 'task', id: request.id, patch: { status: 'canceled', canceledAt: Date.now(), canceledBy: info.id, transferStatus: 'rejected' }, ts: Date.now() }])
        return '已驳回转交申请：' + (task.title || task.id)
      }
      if (action !== 'approve') return '未知操作：' + action
      const candidateResolution = resolveSessionRef(String(request.transferCandidateId), sessionsNow)
      if (!candidateResolution.ok) return '候选人已不可用：' + candidateResolution.error
      const candidate = candidateResolution.session
      const groupsNow = groupStore.read()
      const targetGroup = groupsNow.find((item) => item.id === task.groupId)
      if (targetGroup && !targetGroup.sessionIds.includes(candidate.id)) {
        targetGroup.sessionIds.push(candidate.id)
        targetGroup.updatedAt = Date.now()
        groupStore.write(groupsNow)
      }
      const oldCoordinator = task.coordinator || task.owner || ''
      const assignees = [...new Set([...(Array.isArray(task.assignees) ? task.assignees : []), oldCoordinator].filter((item) => item && item !== candidate.id))]
      appendEvents(boardDir, [
        { op: 'task', id: request.id, patch: { status: 'answered', answeredBy: info.id, answeredAt: Date.now(), transferStatus: 'approved' }, ts: Date.now() },
        { op: 'task', id: task.id, patch: { coordinator: candidate.id, owner: candidate.id, ownerRole: 'coordinator', claimState: 'assigned', claimedAt: Date.now(), taskStatus: 'assigned', assignees }, ts: Date.now() }
      ])
      await ensureSessionLive(candidate.id)
      wakeSession(candidate.id, [
        '【任务已转交给你 · 你是组长】',
        '任务：' + String(task.title || task.id),
        '范围：' + String(task.taskScope || '').slice(0, 500),
        '',
        '请先向群管理/用户确认再执行；原分配已保留为协作成员。'
      ].join('\n'), {})
      return '已批准转交：' + (task.title || task.id) + ' → ' + (candidate.title || shortSid(candidate.id)) + '（旧组长转为协作成员）。'
    }
  })
  register({
    name: 'council_vote',
    description: '星桥小议会专用：对新成员招募/世界任务待审批记录投票。action=status 查看议会与待审批；action=vote 用 approvalId + vote=approve/reject 投票；多数票自动生效并执行。只有小议会成员可投票。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'vote'], description: 'status 查看 / vote 投票' },
        approvalId: { type: 'string', description: '待审批 id（vote 时必填）' },
        vote: { type: 'string', enum: ['approve', 'reject'], description: '通过/驳回' },
        reason: { type: 'string', description: '可选投票理由' }
      },
      required: ['action']
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const guard = requireRootAgent(exec)
      if (guard.error) return guard.error
      const info = sessionInfoOf(guard.agent)
      const action = String((args && args.action) || 'status')
      const ensured = await ensureCouncil()
      if (!ensured.ok) return ensured.error
      if (action === 'status') {
        const approvals = readApprovals().filter((item) => item && item.status === 'pending')
        return ['小议会：' + ensured.data.members.map((id) => shortSid(id)).join('、'), '待审批：' + (approvals.length ? approvals.map((item) => item.id + '：' + String(item.title || item.text || '').slice(0, 40)).join('；') : '无')].join('\n')
      }
      const result = await councilVote({ approvalId: String((args && args.approvalId) || '').trim(), voter: info.id, vote: String((args && args.vote) || ''), reason: args && args.reason })
      return JSON.stringify(result)
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
        // v2.9.1：成员列表显示保护级别/角色（维护者在群里只观察，不接普通任务）。
        const roleTextOf = (member) => {
          if (member.protected === true) return '维护者（保护/服务，仅观察，不接普通任务）'
          if (group.managerSessionId === member.id) return '群管理'
          if (member.protectionLevel === 'coordinator') return '组长（临时）'
          return '成员'
        }
        return (
          '群「' + group.name + '」成员（' + members.length + '）：\n' +
          members
            .map((member) => '- ' + member.avatar + ' ' + (member.handle || member.title) + '（' + member.title + '）· 角色=' + roleTextOf(member) + ' · contactId=' + (member.contactId || contactIdOf(member.id)) + ' · 完整 id=' + member.id)
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
      '跨会话通讯录：列出主会话的 contactId（稳定短 ID）、完整 id、handle、标题、工作区、在线状态、所属群组、角色/保护级别、是否可派世界任务（worldEligible）。' +
      '支持 group（只看某个群组的成员）和 query（按 contactId / 完整 id / handle / 标题 / 工作区 模糊筛选）。' +
      '任何主会话可用。不确定派给谁、或不知道成员 id 时先查这里：contactId 可直接用于 session_ask/session_nudge 的 to、group_member 的 sessions、世界任务正文 @。' +
      '维护者会标记 protected=yes/service=yes：不接普通任务，只能通过显式 @ 或「修bug群」投递 bug。',
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
          `  fullId=${session.id} · live=${session.live ? 'yes' : 'no'} · status=${session.status || (session.live ? 'idle' : 'history')} · availability=${session.availability || 'idle'}${session.currentTask && session.currentTask.title ? `（${session.currentTask.title}）` : ''} · 群组=${groupNames.length ? groupNames.join('、') : '（无）'} · 角色=${session.protectionLabel || PROTECTION_LABEL.member} · protected=${session.protected ? 'yes' : 'no'} · service=${session.service ? 'yes' : 'no'} · worldEligible=${session.worldEligible ? 'yes' : 'no'} · cwd=${session.cwd || '（无）'}`
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
      'action=remove 删除一条（id 可用前缀）；action=claim 认领一条任务交接（对 task 等价 task.claim）；' +
      'action=task.claim / task.release 认领/释放任务归属锁（只有 assignee/coordinator 可 claim，冲突返回当前 owner）；' +
      'action=task.dedupe 查看重复任务合并建议（不自动删数据）；' +
      'action=ack 标记本会话已接受某条规矩（id 可用前缀）；' +
      'action=status 查看插件加载状态、看板路径、活动会话与看板面板；' +
      'action=bugfix 一键创建或复用「星桥 · 修bug」群（维护者/群管理可用，维护者为群管理，普通成员可投递 bug 报告）。' +
      '发布新经验请用 session_share（可用 group 参数指定群组）；向群内其他会话要文件/进度请用 session_ask。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'search', 'groups', 'remove', 'claim', 'unclaim', 'task.claim', 'task.release', 'task.dedupe', 'ack', 'status', 'bugfix'],
          description:
            'list（默认）/ groups / remove / claim / unclaim / task.claim / task.release / task.dedupe / ack / status / bugfix（创建或复用修bug群）'
        },
        id: { type: 'string', description: '条目 id（remove/claim/unclaim/ack 时用，支持前缀匹配）' },
        query: { type: 'string', description: '可选，按标题/正文/标签/群名搜索共享经验（list/search 时用）' },
        tag: { type: 'string', description: '可选，按标签过滤' },
        kind: { type: 'string', description: '可选，按类别过滤（note/handoff/lesson/decision/bug 等）' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'list 时最多显示多少条，默认 12' },
        includeOwn: { type: 'boolean', description: 'list 时是否包含自己发布的条目，默认 false' },
        showAll: { type: 'boolean', description: 'list 时是否显示其它工作区的条目，默认 false' },
        apply: {
          type: 'boolean',
          description: '仅 task.dedupe 用：true=把重复任务标 canceled 并指向 primary（保留数据，不删除）；默认只给建议'
        }
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
      let action = args && typeof args.action === 'string' ? args.action : 'list'
      if (action === 'search') action = 'list'
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

      if (action === 'bugfix') {
        const isMaintainerNow = isMaintainerSession(info.id)
        const isGroupManagerNow = groupStore.read().some((group) => group.managerSessionId === info.id)
        if (!isMaintainerNow && !isGroupManagerNow) {
          return (
            '只有维护者或群管理可以创建/复用修bug群。' +
            '普通成员/用户请用右侧栏「修bug群」按钮或面板命令 bugfix.ensure；报 bug 用 session_share（kind=bug）即可自动进群。'
          )
        }
        const ensured = await ensureBugfixGroup({ kickoff: isMaintainerNow })
        if (!ensured.ok) return ensured.error
        const groupNow = groupStore.read().find((item) => item.id === ensured.groupId)
        return [
          `已${ensured.created ? '创建' : '复用'}修bug群：${ensured.name}（id=${ensured.groupId.slice(0, 12)}…）`,
          `群管理（维护者）：${shortSid(ensured.managerSessionId)} · 成员 ${ensured.memberCount} 人 · 待处理 bug ${ensured.openReports} 条`,
          ensured.addedMembers && ensured.addedMembers.length ? `本次补入 ${ensured.addedMembers.length} 个普通成员` : '',
          groupNow ? `群目标：${groupNow.goal}` : '',
          '普通成员报 bug：session_share（kind=bug、group=星桥 · 修bug）或面板「报bug」；该群不派普通任务。'
        ]
          .filter(Boolean)
          .join('\n')
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
          const tag = isBugfixGroup(group) ? '[修bug群] ' : ''
          lines.push(
            `${index + 1}. ${tag}${group.name}（id=${group.id.slice(0, 12)}…，${group.sessionIds.length} 个会话，${ruleCount.get(group.id) || 0} 条群规矩）`
          )
          if (group.sessionIds.length) {
            lines.push(
              `   成员：${group.sessionIds
                .map((id) => {
                  const session = sessionById.get(id)
                  if (!session) return shortSid(id)
                  const roleTag = session.protected
                    ? '（维护者·观察，不接普通任务）'
                    : group.managerSessionId === id
                      ? '（群管理）'
                      : ''
                  return `${session.contactId || contactIdOf(id)}（${session.handle || session.title}）${roleTag}`
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
          `空闲看板：idle ${sessionsNow.filter((session) => session.availability !== 'busy').length} 个 · busy ${sessionsNow.filter((session) => session.availability === 'busy').length} 个（有未回答 request 或未完成群任务组长任务即为 busy；回答后自动回到 idle）`,
          `任务线：${(() => {
            const lines = buildTaskLines(store.readActive(), {
              now: Date.now(),
              sessionById: new Map(sessionsNow.map((session) => [session.id, session])),
              groupNames: groupNameMap(),
              groups: groupStore.read()
            })
            const stats = buildTaskLineStats(lines)
            return `共 ${stats.total} 条（等待 ${stats.waiting} / 进行中 ${stats.active} / 卡住 ${stats.stalled} / 完成 ${stats.done} / 已撤回 ${stats.canceled}），累计催办 ${stats.nudged} 次`
          })()}`,
          `权限分级：维护者=${(() => {
            const maintainerId = maintainerStore.get()
            return maintainerId ? shortSid(maintainerId) + '（protected/service，不接普通任务）' : '未注册'
          })()} · 修bug群=${(() => {
            const bugfixNow = bugfixGroupOf(groups)
            return bugfixNow ? bugfixNow.name + '（' + bugfixNow.sessionIds.length + ' 人）' : '未创建（session_board action=bugfix 或 bugfix.ensure）'
          })()}`,
          `配置：scope=${cfg.scope} · maxShown=${cfg.maxShown} · ttl=${cfg.ttlHours}h · autoCapture=${cfg.autoCapture !== false}`,
          `注册：系统提示词说明=${registration.section ? '是' : '否'} · 运行时上下文=${registration.context ? '是' : '否'} · 看板 API=${registration.api ? '是' : '否'} · 面板 client.js=${fs.existsSync(path.resolve(HERE, '..', 'client.js')) || fs.existsSync(path.join(HERE, 'client.js')) ? '存在' : '缺失'}`,
          `客户端模块：${moduleInfo.available ? `已挂载（${moduleInfo.count} 个，本插件=${moduleInfo.hasSelf ? '已注册' : '未注册'}）` : '服务不可用'}${moduleInfo.available && !moduleInfo.hasSelf && moduleInfo.ids ? `\n  ids：${moduleInfo.ids.join(', ')}` : ''}`,
          `工具：${registeredTools.join(', ') || '(无)'}${failedTools.length ? ` · 失败=${failedTools.join(', ')}` : ''}`,
          `活动主会话（${live.length}）：`,
          ...(live.length
            ? live.map((item) => {
                const session = sessionById.get(item.id)
                const who = session ? `${session.contactId || contactIdOf(item.id)} · ${session.handle || session.title}` : `${contactIdOf(item.id) || shortSid(item.id)}`
                const busyTag = session && session.availability === 'busy' ? ` · busy(${truncate(String((session.currentTask && session.currentTask.title) || '任务'), 20)})` : ' · idle'
                return `  - ${who} · ${item.status}${busyTag} · ${item.cwd ? path.basename(item.cwd) : '(无 cwd)'}`
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

      if (action === 'task.dedupe') {
        const report = taskDedupe({ apply: args && args.apply === true, actorId: info.id })
        if (!report.suggestions.length) {
          return '没有发现 24h 内可合并的重复任务（同一目标盘/同请求/同用户需求）。'
        }
        return [
          `发现 ${report.suggestions.length} 组疑似重复任务：`,
          ...report.suggestions.map((group, index) => {
            const primary = group.primary
            const owner = primary.owner ? shortSid(primary.owner) : '（未指定）'
            return [
              `${index + 1}. 保留：${primary.title}（id=${primary.id.slice(0, 14)}…，owner=${owner}，scope=${truncate(primary.taskScope, 80)}）`,
              ...group.duplicates.map(
                (item) =>
                  `   - 重复：${item.title}（id=${item.id.slice(0, 14)}…，owner=${item.owner ? shortSid(item.owner) : '（未指定）'}，${item.reason}）`
              )
            ].join('\n')
          }),
          report.applied
            ? `已把 ${report.applied} 个重复任务标为 canceled 并写入 mergedInto（保留数据，未删除）。`
            : '这只是合并建议：不会自动删数据；确认后用 apply=true（或面板确认）再合并。'
        ].join('\n')
      }
      if (action === 'task.claim' || action === 'task.release') {
        const result =
          action === 'task.claim'
            ? claimTaskEntry({ ref: args && args.id, actorId: info.id, actorKind: 'session' })
            : releaseTaskEntry({ ref: args && args.id, actorId: info.id, actorKind: 'session' })
        if (!result.ok) return result.error || '任务归属操作失败'
        return action === 'task.claim'
          ? `已认领任务：${result.taskId.slice(0, 14)}… · owner=${shortSid(result.owner)}（claimedAt=${result.claimedAt}）。其他会话不能再覆盖。`
          : `已释放任务：${result.taskId.slice(0, 14)}…（原 owner=${result.previousOwner ? shortSid(result.previousOwner) : '（空）'}），现在可被 assignee/coordinator 重新认领。`
      }
      if (action === 'claim' || action === 'unclaim') {
        const entry = findEntry(args && args.id)
        if (!entry) return `没找到条目：${args && args.id}`
        if (entry.kind === 'task') {
          const result =
            action === 'claim'
              ? claimTaskEntry({ ref: entry.id, actorId: info.id, actorKind: 'session' })
              : releaseTaskEntry({ ref: entry.id, actorId: info.id, actorKind: 'session' })
          return result.ok
            ? action === 'claim'
              ? `已认领任务：${entry.title}（owner=${shortSid(result.owner)}）`
              : `已释放任务：${entry.title}`
            : result.error || '任务归属操作失败'
        }
        if (entry.kind !== 'handoff') return `只有 handoff（任务交接）或 task（任务归属）可以认领：${entry.title}`
        if (action === 'claim') {
          appendEvents(boardDir, [{ op: 'claim', id: entry.id, by: info.id, ts: Date.now() }])
          return `已认领交接任务：${entry.title}（其他会话会看到"已被会话 ${shortSid(info.id)} 认领"）。`
        }
        appendEvents(boardDir, [{ op: 'unclaim', id: entry.id, by: info.id, ts: Date.now() }])
        return `已释放认领：${entry.title}`
      }

      // list
      const limit = Math.max(1, Math.min(50, toNumber(args && args.limit, 12)))
      const query = String(args && (args.query || args.q) || '').trim()
      const tagFilter = String(args && args.tag || '').trim().toLowerCase()
      const kindFilter = String(args && args.kind || '').trim().toLowerCase()
      let entries = visibleEntries(info, {
        includeOwn: args && args.includeOwn === true,
        showAll: args && args.showAll === true
      })
      if (query) {
        const q = normalizeText(query)
        entries = entries.filter((entry) => normalizeText([entry.title, entry.text, ...(entry.tags || []), entry.groupName || ''].join(' ')).includes(q))
      }
      if (tagFilter) entries = entries.filter((entry) => (entry.tags || []).some((tag) => String(tag).toLowerCase().includes(tagFilter)))
      if (kindFilter) entries = entries.filter((entry) => String(entry.kind || '').toLowerCase() === kindFilter)
      entries = entries.slice(0, limit)
      const header = [
        `跨会话经验板 · ${entries.length} 条${query ? '（搜索：' + query + '）' : ''}（工作区 ${info.cwd ? path.basename(info.cwd) : '?'}${args && args.showAll === true ? '，含其它工作区' : ''}${args && args.includeOwn === true ? '，含自己发布' : ''}）`
      ]
      if (!entries.length) {
        header.push('（暂时没有其他会话共享的条目。你可以在本会话发布：用户给出通用规范时调用 session_share。）')
        return header.join('\n')
      }
      return header.concat(entries.map((entry, index) => formatEntry(entry, index))).join('\n')
    }
  })

  register({
    name: 'group_recruit',
    description:
      '组长/群管理专用：向世界路由请求招募/分配新成员（优先空闲现有会话自动入群；不足时新建会话但必须先经用户复核），成功后自动加入本群并创建/指派任务。' +
      '参数：group=群名或群 id（你是多个群的管理/组长时必填）、text/need=招募需求、count=人数(1-5)、mode=auto(默认)/new/existing、skills=技能偏好。' +
      '维护者/受保护会话不会被当普通执行人选中；需要新建会话时返回待复核信息（不会偷偷创建）。普通成员无权调用。' +
      '需要能回话、可被群 @、可持续跟进的协作者时，用本工具招真实成员；不要用 subagent 代替群成员。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '群名或群 id（你是多个群的管理/组长时必填）' },
        text: { type: 'string', description: '招募需求/要做什么（≤800 字）' },
        need: { type: 'string', description: '同 text 的别名' },
        count: { type: 'integer', minimum: 1, maximum: 5, description: '需要几位成员（默认 1）' },
        mode: {
          type: 'string',
          enum: ['auto', 'new', 'existing'],
          description: 'auto（默认：优先空闲现有成员，不足再新建）/ new（只新建，走复核）/ existing（只从空闲现有成员挑）'
        },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description: '可选技能偏好，如 ["代码","数据"]，用于优先匹配'
        }
      },
      required: ['text']
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const guard = requireRootAgent(exec)
      if (guard.error) return guard.error
      const info = sessionInfoOf(guard.agent)
      const groups = groupStore.read()
      const ref = String((args && args.group) || '').trim()
      let group = null
      if (ref) {
        group =
          groups.find((item) => item.id === ref || item.id.startsWith(ref) || item.name === ref) ||
          groupStore.find(ref, info.cwd) ||
          null
        if (!group) {
          return ['找不到群组「' + ref + '」。', groups.length ? '当前群组：' + groups.map((item) => item.name).join('、') : '当前还没有群组。'].join('\n')
        }
      } else {
        const managed = groups.filter((item) => groupManageRoleOf(item, info.id).allowed)
        if (managed.length === 1) group = managed[0]
        else if (!groups.length) {
          return '当前还没有群组：先在右侧栏「经验桥」→ 群组里新建群组并拉入成员。'
        } else if (!managed.length) {
          return '你不是任何群的管理/组长/维护者，不能请求招募。只有本群群管理、组长（coordinator）或维护者可以。'
        } else {
          return '你是多个群的管理，请用 group= 指定要招募的群：' + managed.map((item) => item.name).join('、')
        }
      }
      const role = groupManageRoleOf(group, info.id)
      if (!role.allowed) return '只有本群群管理、组长（coordinator）或维护者可以请求招募新成员。'
      const text = String((args && (args.text || args.need)) || '').trim().slice(0, 800)
      if (!text) return '请说明招募需求（text）。'
      const result = await recruitMembers({
        group,
        text,
        count: args && args.count,
        mode: args && args.mode,
        skills: args && args.skills,
        requesterId: info.id,
        requesterLabel: '会话 ' + shortSid(info.id),
        origin: 'tool'
      })
      if (!result.ok) return '招募失败：' + (result.error || '未知原因')
      if (result.pendingApproval) {
        return [
          '【招募 · 待复核】需要新建会话，已提交世界路由复核（本次尚未创建会话、未加人）。',
          `待复核 id=${result.approval && result.approval.id ? result.approval.id : '?'} · 群「${result.groupName || group.name}」 · 需新建 ${(result.approval && result.approval.memberCount) || '?'} 人`,
          '请让用户在星桥世界页顶部的「待复核 · 自动创建」卡片点「通过并执行」（或由用户在面板里确认）。',
          '用户明确说「不用复核」时改用 mode=existing 只从空闲现有成员招募。'
        ].join('\n')
      }
      const memberText = result.added
        .map((item) => `- ${item.title}（contactId=${item.contactId}，${item.source === 'new' ? '新建' : '现有空闲'}）`)
        .join('\n')
      return [
        `【招募成功】群「${result.groupName}」新增 ${result.added.length} 位成员（世界路由：现有空闲 ${result.route.existingUsed} / 新建 ${result.route.createdNew} / 忙碌未选 ${result.route.busyFound}）。`,
        memberText,
        '',
        '这是招募公告，不是任务：未生成任务线、不自动催办；需要正式任务时再用 group.post 显式发布。',
        `已唤醒 ${result.woken} 人；审计已写入群聊（id=${String(result.auditId || '').slice(0, 14) || '-'}…）。`,
        '维护者/受保护会话不会被选中。后续用 session_ask（mode=task）给成员派活即可。'
      ].join('\n')
    }
  })

  register({
    name: 'session_urgent',
    description:
      '加急插话：把一条必须立刻处理的短消息插到目标会话。目标空闲会立即唤醒并标注【加急】；目标正在运行会尝试调用打断能力后插话，宿主不支持直接打断时退化为插话并明确提示（不假装已打断）。' +
      '权限：用户面板、维护者、目标所在群的群管理；普通成员不能对他人加急。同一发送者→同一目标每 60 秒最多 1 条（防轰炸）。' +
      'to 支持 contactId（8 位）、短 id、handle、标题、完整 id；不确定先用 session_directory 查通讯录。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '目标会话：contactId / 短 id / handle / 标题 / 完整 id' },
        text: { type: 'string', description: '加急内容（≤800 字，写清楚要对方立刻做什么）' },
        group: { type: 'string', description: '可选，从哪个群发起（群名或群 id）；群管理只能对自管群内成员加急' }
      },
      required: ['to', 'text']
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const guard = requireRootAgent(exec)
      if (guard.error) return guard.error
      const info = sessionInfoOf(guard.agent)
      const text = String((args && args.text) || '').trim().slice(0, 800)
      if (!text) return '加急内容不能为空（text）。'
      const toRef = String((args && args.to) || '').trim()
      if (!toRef) return '请用 to= 指定目标会话（contactId / 短 id / handle / 标题 / 完整 id）。'
      const sessionsNow = await buildSessionIndex()
      const outcome = resolveSessionRef(toRef, sessionsNow)
      if (!outcome.ok) {
        return [
          outcome.ambiguous ? 'to=「' + toRef + '」指向不唯一，请改用 contactId 或完整 id：' : '找不到目标会话「' + toRef + '」。',
          ...(outcome.ambiguous ? [outcome.error] : []),
          '可用 session_directory 查 contactId。'
        ].join('\n')
      }
      const target = outcome.session
      const permission = urgentPermissionOf(info.id, target, args && args.group)
      if (!permission.ok) return permission.error
      const result = await sendUrgentSession({
        fromId: info.id,
        target,
        text,
        group: permission.group || null,
        origin: 'tool'
      })
      if (!result.ok) return '加急发送失败：' + (result.error || '未知原因')
      const lines = [
        `【加急已送达】目标：${result.target.title}（contactId=${result.target.contactId}）`,
        `目标状态：${result.availability === 'idle' ? '空闲，已立即唤醒' : '忙碌（' + result.availabilityReason + '）'}`,
        result.interrupted
          ? '已调用宿主打断能力（' + result.interruptedBy + '）并插入加急消息。'
          : result.degraded
            ? '宿主无直接打断能力，已退化为插话：' + result.degradedReason
            : '已插入加急消息，目标会立即处理。',
        `加急消息 id=${result.urgentEntryId.slice(0, 14)}…（群/世界消息里带 ⚡ 标记）`,
        `限频：同一发送者→同一目标 ${Math.round((result.cooldownMs || 60000) / 1000)} 秒内最多 1 条。`
      ]
      return lines.join('\n')
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

  const executeCommand = async (command, options = {}) => {
    const action = String((command && command.action) || '')
    const payload = command && typeof command.payload === 'object' && command.payload !== null ? command.payload : {}
    const actor = actorOf(options.actor)
    if (action === 'entry.retract' || action === 'message.retract') {
      const ref = String(payload.id || payload.entryId || payload.messageId || payload.approvalId || '').trim()
      if (!ref) return { ok: false, error: '缺少要撤回的条目 id' }
      const result = retractBoardEntry({ ref, actor, reason: payload.reason })
      if (!result.ok) return result
      return { ...result, ok: true }
    }
    if (action === 'agent.interrupt') {
      const sessionRef = String(payload.sessionId || payload.to || payload.id || '').trim()
      if (!sessionRef) return { ok: false, error: '缺少要打断的会话 sessionId（也支持 contactId / 短 id / 标题）' }
      const result = await interruptRunningSession({ sessionId: sessionRef, actor, reason: payload.reason })
      if (!result.ok) return result
      return { ...result, ok: true }
    }
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
    if (action === 'task.claim') {
      const ref = String(payload.taskId || payload.id || '').trim()
      if (!ref) return { ok: false, error: '缺少 taskId/id' }
      // 面板认领必须显式给 owner（assignee/coordinator 的 sessionId）；会话调用用自身 id。
      const actorId =
        actor.kind === 'session'
          ? actor.sessionId
          : String(payload.owner || payload.assigneeId || payload.sessionId || '').trim()
      const result = claimTaskEntry({ ref, actorId, actorKind: actor.kind })
      if (!result.ok) return { ...result, ok: false }
      return { ...result, ok: true }
    }
    if (action === 'task.release') {
      const ref = String(payload.taskId || payload.id || '').trim()
      if (!ref) return { ok: false, error: '缺少 taskId/id' }
      const actorId = actor.kind === 'session' ? actor.sessionId : String(payload.owner || payload.sessionId || '').trim()
      const result = releaseTaskEntry({ ref, actorId, actorKind: actor.kind })
      if (!result.ok) return { ...result, ok: false }
      return { ...result, ok: true }
    }
    if (action === 'task.dedupe') {
      const report = taskDedupe({
        apply: payload.apply === true,
        actorId: actor.kind === 'session' ? actor.sessionId : 'panel'
      })
      return { ok: true, ...report }
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
      // v2.10.1：24h 内重复的世界任务（同请求/同目标盘/同用户需求）不再建第二个群/任务。
      if (!forceNew && payload.allowDuplicate !== true && !isExplicitNewRound(text)) {
        try {
          const dup = findDuplicateTaskEntry(store.readActive(), { text, worldOnly: true })
          if (dup) {
            const existingOwner = taskOwnerOf(dup.entry)
            const existingTaskId = dup.entry.kind === 'task' ? dup.entry.id : dup.entry.taskId || ''
            logger.info(`世界任务命中 24h 重复，已合并到 ${dup.entry.id}：${dup.reason}`)
            return {
              ok: true,
              duplicate: true,
              messageId: dup.entry.id,
              existing: {
                id: dup.entry.id,
                taskId: existingTaskId,
                title: dup.entry.title || '',
                owner: existingOwner,
                taskScope: dup.entry.taskScope || '',
                groupId: dup.entry.groupId || '',
                kind: dup.entry.kind,
                reason: dup.reason
              },
              taskId: existingTaskId,
              owner: existingOwner,
              assigned: [],
              woken: 0,
              createdSession: '',
              createdWorkspace: '',
              createdGroup: null,
              createError: '',
              requestIds: [],
              route: 'duplicate',
              router: {
                engine: 'dedupe',
                reason: `24h 内已有同类任务（${dup.reason}），已返回 existing task id/owner，不再建第二个群/任务`
              }
            }
          }
        } catch {
          /* 查重失败不影响正常发送 */
        }
      }
      // 世界任务的 @ 解析与「扩充新成员」意图：这两类不交给路由器，避免把新成员外包给子代理。
      const sessionsNow = await buildSessionIndex()
      // 自动路由/路由建议只用 worldEligible（已排除维护者）；用户显式 @ 仍可点名 protected 会话（例外）。
      const mentionCandidates = sessionsNow.filter((session) => session.worldEligible === true || session.protected === true)
      const parsedWorldMentions = parseMentionsInText(text, mentionCandidates)
      const explicitProtectedMentions = parsedWorldMentions.ids.filter((sessionId) => isMaintainerSession(sessionId))
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
        // @所有人 属于「非显式指定具体成员」的自动路由：排除 protected 维护者（空闲也不派普通任务）。
        const broadcastCandidates = mentionCandidates.filter((session) => session.protected !== true)
        decision = {
          engine: 'mentions',
          route: 'existing',
          sessionId: broadcastCandidates[0] ? broadcastCandidates[0].id : '',
          sessionIds: broadcastCandidates.slice(0, 6).map((session) => session.id),
          reason: '用户在世界任务里 @所有人，直接派给现有成员（维护者保持观察，不接普通任务）'
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
      // ---------------------------------------------------------------- 空闲看板路由（v2.9.0）
      // 显式 @ 具体成员：尊重用户选择（忙也派）；其它匹配（路由器/关键词/@所有人）只派 idle。
      const availabilityById = new Map(sessionsNow.map((session) => [session.id, session.availability || 'idle']))
      const isExplicitMention = decision.engine === 'mentions' && parsedWorldMentions.ids.length > 0
      if (decision.route === 'existing' && !isExplicitMention) {
        const wantedIds = [
          ...new Set([
            ...(Array.isArray(decision.sessionIds) ? decision.sessionIds : []),
            ...(decision.sessionId ? [decision.sessionId] : [])
          ])
        ].filter(Boolean)
        const busyWanted = wantedIds.filter((id) => availabilityById.get(id) === 'busy')
        const idleWanted = wantedIds.filter((id) => availabilityById.get(id) !== 'busy')
        if (idleWanted.length && busyWanted.length) {
          decision.sessionIds = idleWanted
          decision.sessionId = idleWanted[0]
          decision.reason = `${decision.reason || ''}；已跳过忙碌成员 ${busyWanted.map((id) => shortSid(id)).join('、')}`
        } else if (!idleWanted.length && wantedIds.length) {
          // 匹配成员都在忙：先尝试改派给空闲且申报相关的成员，没有则退回新建会话（触发复核），不硬派忙碌老人。
          let idleAlternative = null
          try {
            const matches = await matchProfileMembers(text)
            idleAlternative = matches.find((item) => availabilityById.get(item.id) !== 'busy') || null
          } catch {
            idleAlternative = null
          }
          if (idleAlternative) {
            decision.sessionIds = [idleAlternative.id]
            decision.sessionId = idleAlternative.id
            decision.reason = `${decision.reason || ''}；原匹配成员忙，改派空闲成员 ${shortSid(idleAlternative.id)}`
          } else {
            decision = {
              engine: 'busy-fallback',
              route: 'new',
              sessionId: '',
              sessionIds: [],
              newWorkspace: false,
              reason: `${decision.reason || ''}；匹配成员都在忙（${busyWanted.map((id) => shortSid(id)).join('、')}），改新建会话（需复核）`
            }
          }
        }
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
          void notifyCouncilApproval(approval)
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
      // 协同类任务：如果只命中一个会话，再挑 1-2 个申报相关且空闲的成员一起拉群（忙碌成员不加）。
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
                  session.availability !== 'busy' &&
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
              decision.reason += '；根据协同需求扩展给 ' + extra.length + ' 位空闲相关成员'
            }
          } catch {
            /* ignore */
          }
        }
      }
      const createdSessions = []
      let createdSessionCwd = ''
      // 维护者只能通过「用户显式 @」进入 assigned（自动路由已排除），这里标记并给提示。
      const assignedProtectedIds = assigned.filter((item) => isMaintainerSession(item.id)).map((item) => item.id)
      const protectedOnlyAssigned = assigned.length > 0 && assigned.every((item) => isMaintainerSession(item.id))
      const protectedNotice = assignedProtectedIds.length
        ? '维护者例外：用户在正文里显式 @ 了维护者（' +
          assignedProtectedIds.map((sessionId) => shortSid(sessionId)).join('、') +
          '），本次按「用户显式 @」例外处理并提示；维护者 protected/service，不接自动路由/普通派活，也不会担任组长；普通任务请派给其他成员，bug 请投递到「' +
          BUGFIX_GROUP_NAME +
          '」群。'
        : ''
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
        if (!cwdOverride) {
          const made = await createWorkspaceForTask(text, '世界任务')
          if (made && made.ok) { cwdOverride = made.cwd; createdWorkspace = made.cwd }
        }
        for (let index = 0; index < requestedMemberCount; index += 1) {
          const prettyName = prettyMemberName(cwdOverride, index, text)
          const created = await createSessionForTask(cwdOverride || undefined, prettyName.title)
          if (created.ok) {
            createdSessionCwd = created.cwd || cwdOverride || createdSessionCwd
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
          createdSessionCwd = created.cwd || cwdOverride || createdSessionCwd
          createdSession = created.sessionId
          createdTitle = created.title || ''
          assigned = [{ id: createdSession, title: '新会话', score: 0 }]
        } else {
          createError = createError ? `${createError}；${created.error}` : created.error
        }
      }
      let createdGroup = null
      if (assigned.length >= 1 && !protectedOnlyAssigned) {
        try {
          const memberIds = [...new Set(assigned.map((item) => item.id))]
          const firstSession = sessionsNow.find((session) => session.id === memberIds[0])
          // v2.9.0：用可读群名生成器，避免 '协作：' + 半句任务 这种丑名字。
          const baseName = generateGroupName(text, {
            workspace: (firstSession && firstSession.cwd) || decision.folderPath || ''
          })
          const groupsNow = groupStore.read()
          let groupName = baseName
          let suffix = 2
          while (groupsNow.some((group) => group.name === groupName)) {
            groupName = `${baseName} ${suffix}`
            suffix += 1
          }
          const group = {
            id: 'g-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex'),
            name: groupName,
            workspace: createdWorkspace || createdSessionCwd || (firstSession && firstSession.cwd) || '',
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
      // v2.10.1：世界任务也写入 owner/taskScope；显式 scope 与正文冲突时只提示，不自动扩展。
      const explicitWorldScope = String(
        payload.taskScope ||
          payload.scopeText ||
          (payload.scope && !['workspace', 'global', 'group'].includes(payload.scope) ? payload.scope : '') ||
          ''
      ).trim()
      const worldTaskScope = normalizeTaskScope(explicitWorldScope, text)
      const worldScopeWarning = explicitWorldScope ? detectScopeExpansion(explicitWorldScope, text).join('；') : ''
      if (createdGroup) {
        try {
          const memberIds = [...new Set(assigned.map((item) => item.id))]
          // v2.9.1：维护者 protected/service，不担任组长/成员；组长优先从普通成员里选。
          autoCoordinatorId = memberIds.find((sessionId) => !isMaintainerSession(sessionId)) || memberIds[0]
          const assignees = memberIds.filter(
            (sessionId) => sessionId !== autoCoordinatorId && !isMaintainerSession(sessionId)
          )
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
              owner: autoCoordinatorId,
              ownerRole: 'coordinator',
              taskScope: worldTaskScope,
              ...(worldScopeWarning ? { scopeWarning: worldScopeWarning } : {}),
              worldTask: true,
              // task-6：世界任务也自动构建默认 5 阶段任务清单。
              steps: defaultTaskSteps(),
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
        // 维护者（protected/service）不进入这个体系：不待命、不挂任务角色。
        if (createdGroup && autoGroupTask && item.id !== autoCoordinatorId && !isMaintainerSession(item.id)) {
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
            taskScope: worldTaskScope,
            ...(worldScopeWarning ? { scopeWarning: worldScopeWarning } : {}),
            hiddenFromChat: true,
            skipDedupe: true,
            ...(createdGroup && autoGroupTask && item.id === autoCoordinatorId ? { taskId: autoGroupTask.id, taskRole: 'coordinator' } : {})
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
                `【范围锁】归属：${shortSid(autoCoordinatorId || item.id)} · 仅做 scope：${worldTaskScope}（${TASK_SCOPE_DISPATCH_TAIL}）`,
                worldScopeWarning ? `⚠ 范围提醒：${worldScopeWarning} —— 已超出 scope，需 owner 确认后再扩展。` : '',
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
                `【范围锁】归属：${shortSid(item.id)} · 仅做 scope：${worldTaskScope}（${TASK_SCOPE_DISPATCH_TAIL}）`,
                worldScopeWarning ? `⚠ 范围提醒：${worldScopeWarning} —— 已超出 scope，需 owner 确认后再扩展。` : '',
                isMaintainerSession(item.id)
                  ? '（维护者例外：本次是用户在正文里显式 @ 你，按例外处理；普通任务不会自动派给你，你也不会成为组长/成员；bug 请走「' +
                    BUGFIX_GROUP_NAME +
                    '」群。）'
                  : '',
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
        owner: autoCoordinatorId || '',
        taskScope: worldTaskScope,
        scopeWarning: worldScopeWarning,
        route: decision.route,
        router: { engine: decision.engine, reason: decision.reason },
        // v2.9.1：用户显式 @ 维护者的例外提示（普通自动路由不会命中维护者）。
        protectedException: assignedProtectedIds,
        protectedNotice
      }
    }
    if (action === 'session.revive') {
      // 历史会话在侧栏里没有可读标题时：恢复为 live（不跑回合）并改名，让它重新出现在会话列表。
      const sessionId = String(payload.sessionId || '').trim()
      const title = String(payload.title || '').trim().slice(0, 40)
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      let agent = liveAgentOf(sessionId)
      let resumed = false
      if (!agent) {
        // 会话已经 live（可能被别的写句柄占用）时不要再 resume，否则只会得到 already owned 警告。
        const known = await sessionLookOf(sessionId)
        if (known && known.live === true) {
          logger.info(`会话 ${shortSid(sessionId)} 已活跃，跳过恢复`)
          return { ok: true, sessionId, resumed: false, skipped: true, message: '会话已活跃，无需恢复' }
        }
        if (!ctx.agents || typeof ctx.agents.resume !== 'function') {
          return { ok: false, error: '宿主不提供 agents.resume' }
        }
        try {
          const selection = resolveDefaultSelection()
          const setup = buildAgentSetup({ selection })
          const handle = await ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: {},
            ...(setup ? { setup } : {})
          })
          agent = handle && handle.agent ? handle.agent : handle
          resumed = Boolean(agent)
        } catch (error) {
          const message = error && error.message ? error.message : String(error)
          if (isBenignResumeError(message)) {
            logger.info(`会话 ${shortSid(sessionId)} 跳过恢复：${message}`)
            return { ok: true, sessionId, resumed: false, skipped: true, message }
          }
          return { ok: false, error: `恢复会话失败：${message}` }
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
    if (action === 'ambient.act') {
      const targetSession = String((payload && payload.sessionId) || '').trim()
      const act = payload && payload.act && typeof payload.act === 'object' ? payload.act : {}
      const tool = String(act.tool || '').trim()
      const allowed = new Set(['session_ask', 'session_share', 'group_recruit', 'task_transfer'])
      if (!targetSession) return { ok: false, error: '缺少 sessionId' }
      if (!allowed.has(tool)) return { ok: false, error: '该内联动作未授权：' + tool }
      const text = String(act.text || act.message || '').trim().slice(0, 1200)
      if (!text) return { ok: false, error: '缺少动作内容' }
      const instruction = [
        '【星桥内联动作】用户已在本会话页点了「' + (act.label || tool) + '」。',
        '请直接调用工具 ' + tool + ' 完成下面这件事；不要先问用户，也不要改开子代理。',
        '参数/内容：',
        text
      ].join('\n')
      try { await ensureSessionLive(targetSession) } catch { /* 离线时 wake 会返回 not-live */ }
      const woke = wakeSession(targetSession, instruction, { requestId: act.requestId || '', source: 'ambient.act' })
      if (!woke.ok) return { ok: false, error: '当前会话不在线，无法 steer：' + (woke.reason || 'not-live') }
      return { ok: true, steered: true, sessionId: targetSession, tool }
    }
    if (action === 'inbox.ack') {
      const ids = Array.isArray(payload && payload.ids) ? payload.ids.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 100) : []
      const viewer = String((payload && payload.viewer) || 'panel').trim() || 'panel'
      const data = inboxAckStore.read()
      if (!data.acks[viewer] || typeof data.acks[viewer] !== 'object') data.acks[viewer] = {}
      const nowAck = Date.now()
      for (const id of ids) data.acks[viewer][id] = nowAck
      const cutoff = nowAck - 30 * 24 * 3600 * 1000
      for (const key of Object.keys(data.acks[viewer])) if (data.acks[viewer][key] < cutoff) delete data.acks[viewer][key]
      inboxAckStore.write(data)
      return { ok: true, viewer, acked: ids.length }
    }
    if (action === 'approval.approve') {
      const approvalRef = String((payload && payload.id) || '').trim()
      if (!approvalRef) return { ok: false, error: '缺少待复核 id' }
      const approvals = readApprovals()
      const target = approvals.find((item) => item && (item.id === approvalRef || item.id.startsWith(approvalRef)))
      if (!target) return { ok: false, error: '找不到待复核记录' }
      if (target.status !== 'pending') return { ok: false, error: '该记录已处理：' + target.status }
      target.status = 'approved'
      target.approvedAt = Date.now()
      target.approvedBy = 'panel'
      writeApprovals(approvals)
      const executed = await executeApprovedApproval(target)
      logger.info('世界任务复核被批准：' + target.id)
      return { ok: true, approval: target, executed }
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
    if (action === 'task.lines') {
      // 任务线（task-6）：读状态；可手动触发一次巡检/催办（面板自测/调试用，等价后台定时器的逻辑）。
      const now = toNumber(payload.now, Date.now())
      const scanReport =
        payload.scan === true
          ? runTaskLineWatch({ now, nudge: payload.nudge !== false, source: 'panel' })
          : null
      const stateNow = await stateForUi()
      // 测试/调试可传 now 按指定时间点派生任务线（否则用 state 的实时派生结果）。
      let taskLinesNow = stateNow.taskLines
      if (payload.now !== undefined) {
        const activeNow = store.readActive()
        taskLinesNow = buildTaskLines(activeNow, {
          now,
          sessionById: new Map((stateNow.sessions || []).map((session) => [session.id, session])),
          groupNames: groupNameMap(),
          groups: groupStore.read()
        })
      }
      return {
        ok: true,
        taskLines: taskLinesNow,
        stats: buildTaskLineStats(taskLinesNow),
        scan: scanReport
      }
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
      const maintainerId = maintainerStore.get()
      const titleById = new Map(sessions.map((session) => [session.id, session.title]))
      const sessionById = new Map(sessions.map((session) => [session.id, session]))
      const titleOf = (sessionId) => titleById.get(sessionId) || shortSid(sessionId)
      // 组任务的串行步骤（轻量记录）：步骤有先后依赖时，组长用 session_ask 的 dependsOn + step 排队。
      const taskSteps = normalizeTaskSteps(payload.steps)
      const stepLines = taskSteps.map((step) => `${step.i}. ${step.text}`)

      // v2.9.1 权限分级 / task-9 调整：
      // - 普通任务（task:true）仍然不得把维护者当组长/成员：只 @维护者 → 明确报错；混合 → 跳过并提示。
      // - 用户显式 @维护者但「不是 task:true」：允许作为对话/BUG 投递送达（修复"想 @维护者报 bug 被拒绝"）。
      const maintainerIdNow = maintainerStore.get()
      const bugfixChannel = isBugfixGroup(group)
      const explicitTaskRequest = payload.task === true || payload.mode === 'task'
      const explicitMentionIds = mentionAll ? [] : requested.filter((sessionId) => group.sessionIds.includes(sessionId))
      let protectedSkipped = []
      let protectedNotice = ''
      let bugfixDelivery = false
      let maintainerDialogue = false
      if (mentionAll && maintainerIdNow && targetIds.includes(maintainerIdNow)) {
        targetIds = targetIds.filter((sessionId) => sessionId !== maintainerIdNow)
        protectedSkipped = [maintainerIdNow]
        protectedNotice =
          '已按保护规则把维护者排除在 @所有人 之外：维护者 protected/service，不接普通任务、不当组长/成员。'
      }
      const targetProtectedIds = targetIds.filter((sessionId) => sessionId === maintainerIdNow)
      if (targetProtectedIds.length) {
        const remaining = targetIds.filter((sessionId) => sessionId !== maintainerIdNow)
        if (explicitTaskRequest) {
          // 普通任务：维护者不能当组长/成员（未完成/未派活）。
          if (!remaining.length) {
            return {
              ok: false,
              error: [
                '维护者「' +
                  titleOf(maintainerIdNow) +
                  '」是 protected/service 会话，group.post 不会把维护者指派为组长/成员（本次未派活、未唤醒）。',
                '',
                PROTECTED_TASK_ALTERNATIVES
              ].join('\n')
            }
          }
          protectedSkipped = targetProtectedIds.slice()
          targetIds = remaining
          protectedNotice =
            '已按保护规则跳过维护者 ' +
            targetProtectedIds.map((sessionId) => titleOf(sessionId)).join('、') +
            '：维护者不接普通任务，也不会担任组长/成员。'
        } else {
          // 用户显式 @维护者（非 task:true）：按「对话/BUG 投递」送达，不拒绝。
          maintainerDialogue = true
          // 只有明确的 bug/故障描述才走 BUG 投递；「请教一个问题」这类普通对话按用户直接对话处理。
          const looksLikeBugComplaint = /(bug|报错|异常|崩溃|闪退|卡死|卡住|无响应|不能用|没反应|坏了|故障|错误|失败|修复|修一下|修下|修好|缺陷|白屏|黑屏|报障|error|fail|crash|broken|\b(?:400|401|403|404|500|502|503)\b)/i.test(
            text
          )
          bugfixDelivery = bugfixChannel || looksLikeBugComplaint
          protectedNotice = bugfixDelivery
            ? '已把这条作为 BUG 报告投递给维护者（不是普通任务派活）；维护者只修 bug，不接普通任务。'
            : '维护者是 protected/service 会话，但本次是用户显式 @ 的直接对话，已直接送达（不是普通任务派活）。'
        }
      }

      // 显式任务模式（v2.9.4）：面板「发布任务」按钮显式声明 task:true / mode:'task'，
      // 不再靠 @ 人数猜意图——单人也能建任务，但必须明确指定组长（本群成员）。
      const explicitTask = payload.task === true || payload.mode === 'task'
      let explicitCoordinatorId = ''
      const explicitAssigneeIds = []
      if (explicitTask) {
        const wantedCoordinator = String(payload.coordinatorId || payload.coordinator || '').trim()
        if (!wantedCoordinator) {
          return { ok: false, error: '发布任务必须指定组长（coordinatorId），可选本群成员' }
        }
        const taskGroupSessions = group.sessionIds
          .map((sessionId) => sessionById.get(sessionId))
          .filter(Boolean)
        const resolution = resolveSessionRef(wantedCoordinator, taskGroupSessions)
        if (!resolution.ok) {
          return { ok: false, error: '组长必须是本群成员：' + resolution.error }
        }
        explicitCoordinatorId = resolution.session.id
        if (explicitCoordinatorId === maintainerId) {
          return { ok: false, error: '维护者是受保护账号，不能作为任务组长或执行人；请选群成员' }
        }
        // 成员多选优先（面板复选框）；没传时退回正文 @ 的人。组长自动包含、维护者永远排除。
        const rawAssignees = Array.isArray(payload.assigneeIds)
          ? payload.assigneeIds
          : Array.isArray(payload.memberIds)
            ? payload.memberIds
            : targetIds
        for (const ref of rawAssignees) {
          const id = typeof ref === 'string' ? ref.trim() : ''
          if (!id) continue
          const resolved = group.sessionIds.includes(id)
            ? { ok: true, session: sessionById.get(id) }
            : resolveSessionRef(id, taskGroupSessions)
          if (!resolved.ok || !resolved.session) continue
          const sessionId = resolved.session.id
          if (sessionId === explicitCoordinatorId || sessionId === maintainerId) continue
          if (!explicitAssigneeIds.includes(sessionId)) explicitAssigneeIds.push(sessionId)
        }
        // 权限：面板（loopback，无 actorId）可发布；会话调用时只有群管理或维护者可发布。
        const actorId = String(payload.actorId || payload.actor || '').trim()
        if (actorId && actorId !== 'panel' && actorId !== group.managerSessionId && actorId !== maintainerId) {
          return { ok: false, error: '只有群管理、维护者或面板可以发布任务' }
        }
        // 显式任务以「组长 + 勾选成员」为准，正文里顺手打的 @ 不再额外扩员。
      }
      // 自动多人任务（保持旧行为）：@ 两人及以上才建任务；维护者不算普通执行人。
      // 注意：这里只收窄「任务」的目标，普通聊天仍按原 @ 名单投递，不能把维护者从聊天里弄丢。
      const taskTargetIds = explicitTask
        ? [explicitCoordinatorId, ...explicitAssigneeIds]
        : targetIds.filter((sessionId) => sessionId !== maintainerId)

      // 群任务：一个任务只能有一个组长；成员只交组长、不直接向用户汇报，避免“人人都是组长”。
      if (explicitTask || taskTargetIds.length >= 2) {
        targetIds = taskTargetIds
        let coordinatorId = targetIds[0]
        const availabilityOfId = (sessionId) => {
          const session = sessionById.get(sessionId)
          return session && session.availability === 'busy' ? 'busy' : 'idle'
        }
        if (explicitTask) {
          coordinatorId = explicitCoordinatorId
        } else {
          let bestScore = -1
          try {
            const profiles = listProfilesOf(boardDir)
            for (const sessionId of targetIds) {
              const profile = profiles[sessionId]
              const score = (profile ? scoreProfileForText(text, profile) : 0) + officeForSession(sessionId).officeLevel / 10
              if (score > bestScore) {
                bestScore = score
                coordinatorId = sessionId
              }
            }
          } catch {
            /* 无申报时用第一个成员当组长 */
          }
          // 用户可在面板里显式指定组长；指定的人必须在本次 @ 的成员里（显式选择即使忙也尊重）。
          const requestedCoordinator = typeof payload.coordinatorId === 'string' ? payload.coordinatorId.trim() : ''
          const coordinatorExplicit = Boolean(requestedCoordinator && targetIds.includes(requestedCoordinator))
          if (coordinatorExplicit) {
            coordinatorId = requestedCoordinator
            bestScore = Number.POSITIVE_INFINITY
          }
          // 空闲看板（v2.9.0）：未显式指定时优先挑空闲组长（避免把新任务压给还有 open request 的老人）。
          if (!coordinatorExplicit) {
            const idleTarget = targetIds.find((sessionId) => availabilityOfId(sessionId) === 'idle')
            if (idleTarget) coordinatorId = idleTarget
          }
          // 优先选一个「在线」的组长；都在线则用评分最高者，全离线则保留评分最高者（任务排队）。
          try {
            const liveIds = new Set(liveRootSessions().map((item) => item.id))
            if (!liveIds.has(coordinatorId)) {
              const liveIdleTarget = targetIds.find(
                (sessionId) => liveIds.has(sessionId) && availabilityOfId(sessionId) === 'idle'
              )
              const liveTarget = liveIdleTarget || targetIds.find((sessionId) => liveIds.has(sessionId))
              if (liveTarget) coordinatorId = liveTarget
            }
          } catch {
            /* ignore */
          }
        }
        const coordinatorBusy = availabilityOfId(coordinatorId) === 'busy'
        const assigneeBusyIds = targetIds.filter((sessionId) => sessionId !== coordinatorId && availabilityOfId(sessionId) === 'busy')
        const assigneeIds = targetIds.filter((sessionId) => sessionId !== coordinatorId)
        // v2.10.1：任务范围 + 24h 重复任务合并（同群，命中不再建第二个任务/群）。
        const explicitGroupScope = String(
          payload.taskScope ||
            payload.scopeText ||
            (payload.scope && !['workspace', 'global', 'group'].includes(payload.scope) ? payload.scope : '') ||
            ''
        ).trim()
        const groupTaskScope = normalizeTaskScope(explicitGroupScope, text)
        const groupScopeWarning = explicitGroupScope ? detectScopeExpansion(explicitGroupScope, text).join('；') : ''
        if (payload.allowDuplicate !== true && payload.forceNew !== true && !isExplicitNewRound(text)) {
          try {
            const dup = findDuplicateTaskEntry(store.readActive(), { text, groupId: group.id })
            if (dup) {
              const existingOwner = taskOwnerOf(dup.entry)
              const existingTaskId = dup.entry.kind === 'task' ? dup.entry.id : dup.entry.taskId || ''
              const existingCoordinator = dup.entry.coordinator || existingOwner
              logger.info(`群任务命中 24h 重复，已合并到 ${dup.entry.id}：${dup.reason}`)
              return {
                ok: true,
                duplicate: true,
                messageId: dup.entry.id,
                taskId: existingTaskId,
                owner: existingOwner,
                existing: {
                  id: dup.entry.id,
                  taskId: existingTaskId,
                  title: dup.entry.title || '',
                  owner: existingOwner,
                  taskScope: dup.entry.taskScope || '',
                  groupId: dup.entry.groupId || group.id,
                  kind: dup.entry.kind,
                  reason: dup.reason
                },
                task: {
                  id: existingTaskId || dup.entry.id,
                  coordinator: existingCoordinator
                    ? { id: existingCoordinator, title: titleOf(existingCoordinator), contactId: contactIdOf(existingCoordinator) }
                    : null,
                  assignees: (Array.isArray(dup.entry.assignees) ? dup.entry.assignees : []).map((sessionId) => ({
                    id: sessionId,
                    title: titleOf(sessionId),
                    contactId: contactIdOf(sessionId)
                  })),
                  status: dup.entry.taskStatus || 'assigned',
                  steps: Array.isArray(dup.entry.steps) ? dup.entry.steps : []
                },
                route: 'duplicate',
                woken: 0,
                requestIds: [],
                coordinatorBusy: false,
                busyAssignees: [],
                protectedSkipped,
                protectedNotice,
                dedupe: {
                  reason: dup.reason,
                  message: `24h 内同群已有同类任务，已返回 existing task id/owner，不再建第二个任务/群。`
                }
              }
            }
          } catch {
            /* 查重失败不影响建任务 */
          }
        }
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
            owner: coordinatorId,
            ownerRole: 'coordinator',
            taskScope: groupTaskScope,
            ...(groupScopeWarning ? { scopeWarning: groupScopeWarning } : {}),
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
          const message = assigneeSessions.length
            ? [
                `【群任务 · 你是唯一组长（用户指定）】群组「${group.name}」`,
                `任务：${text}`,
                `【归属】owner=你（${shortSid(coordinatorId)}）· 仅做 scope：${groupTaskScope}（${TASK_SCOPE_DISPATCH_TAIL}）`,
                groupScopeWarning ? `⚠ 范围提醒：${groupScopeWarning} —— 已超出 scope，需你确认后再扩展。` : '',
                `成员：${memberTitles || '(无)'}`,
                ...(assigneeSessions.length
                  ? [
                      '成员通讯录（派活用 session_ask 的 to=contactId，下方 contactId 可直接复制；也可用 session_directory group=群名 查询）：',
                      memberDirectoryText(assigneeSessions)
                    ]
                  : []),
                ...(coordinatorBusy
                  ? [`⚠ 你当前看板仍是 busy（还有未回答的请求/未完成的任务），本任务可能排队；如无法立即开始，请先在群里说明。`]
                  : []),
                ...(assigneeBusyIds.length
                  ? [`（提示：成员 ${assigneeBusyIds.map((sessionId) => titleOf(sessionId)).join('、')} 当前也在忙，派活可能排队。）`]
                  : []),
                ...(stepLines.length
                  ? [
                      `本次任务的步骤（有先后依赖时**串行**，不要一次全发）：`,
                      ...stepLines,
                      '串行做法：先发步骤 1（session_ask mode=task、step=1）；拿到它返回的 id 后，步骤 2 用 dependsOn=<步骤1的 id> + step=2 排队——前置没回复就不会唤醒人，回复后自动发出。'
                    ]
                  : []),
                '',
                '你的职责：',
                '1. 先规划分工；成员目前**还没有被唤醒**，只有你用 session_ask mode=task 派活后他们才会收到（派活会自动归属本任务，避免同一任务被重复执行；to 支持 contactId / 短 id / handle / 标题，不限完整 id）；',
                '2. 收集成员提交的内容；',
                `3. 最后用 session_share（kind=handoff、group=${group.name}、replyTo=${coordinatorRequest.entry.id}、files=…）向用户提交唯一汇总。`,
                '注意：成员不会直接向用户汇报；只有你是组长，不要让成员替你汇总，也不要重复成员已完成的工作。'
              ].join('\n')
            : [
                    `【群任务 · 你是本任务负责人（用户指定）】群组「${group.name}」`,
                    `任务：${text}`,
                    `【归属】owner=你（${shortSid(coordinatorId)}）· 仅做 scope：${groupTaskScope}（${TASK_SCOPE_DISPATCH_TAIL}）`,
                    groupScopeWarning ? `⚠ 范围提醒：${groupScopeWarning} —— 已超出 scope，需你确认后再扩展。` : '',
                    '',
                    '本任务没有其他成员，由你独立完成。',
                    '',
                    '你的职责：',
                    `1. 完成后用 session_share（kind=handoff、group=${group.name}、replyTo=${coordinatorRequest.entry.id}、files=…）向用户提交结果；`,
                    '2. 无法完成请在回复里说明原因，不要静默丢弃。'
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
            owner: coordinatorId,
            ownerRole: 'coordinator',
            taskScope: groupTaskScope,
            scopeWarning: groupScopeWarning,
            steps: taskSteps
          },
          taskScope: groupTaskScope,
          scopeWarning: groupScopeWarning,
          coordinatorBusy,
          busyAssignees: assigneeBusyIds.map((sessionId) => ({ id: sessionId, title: titleOf(sessionId) })),
          woken,
          requestIds,
          protectedSkipped,
          protectedNotice
        }
      }

      const messageTaskScope = normalizeTaskScope(payload.taskScope || payload.scopeText, text)
      const messageScopeWarning = detectScopeExpansion(messageTaskScope, text).join('；')
      // ---------------------------------------------------------------- @黏性对话 + 无人 @ 默认路由（task-9）
      // 用户 @ 谁 → 设 focusSessionId；没 @ → 沿用 focus；无 focus 回退群管理；无群管理按文本匹配负责人。
      let activeFocusId = String(group.focusSessionId || '')
      let focusValid = Boolean(activeFocusId) && group.sessionIds.includes(activeFocusId) && sessionById.has(activeFocusId)
      let autoTarget = null
      let autoSource = ''
      if (!mentionAll && explicitMentionIds.length) {
        activeFocusId = explicitMentionIds[0]
        focusValid = true
        autoSource = 'mention'
      } else if (!mentionAll) {
        if (focusValid) {
          targetIds = [activeFocusId]
          autoTarget = sessionById.get(activeFocusId) || null
          autoSource = 'focus'
        } else if (
          group.managerSessionId &&
          group.sessionIds.includes(group.managerSessionId) &&
          sessionById.has(group.managerSessionId)
        ) {
          targetIds = [group.managerSessionId]
          autoTarget = sessionById.get(group.managerSessionId) || null
          autoSource = 'manager'
        } else {
          const picked = pickMemberForText(
            text,
            group.sessionIds.map((sessionId) => sessionById.get(sessionId)).filter(Boolean)
          )
          if (picked) {
            targetIds = [picked.id]
            autoTarget = picked
            autoSource = 'matched'
          } else {
            targetIds = []
          }
        }
      }
      let focusUpdatedAtNow = 0
      if (autoSource === 'mention' && activeFocusId) {
        focusUpdatedAtNow = Date.now()
        try {
          mutateGroups((list) => {
            const target = list.find((item) => item.id === group.id)
            if (target) {
              target.focusSessionId = activeFocusId
              target.focusUpdatedAt = focusUpdatedAtNow
              target.updatedAt = focusUpdatedAtNow
            }
            return { ok: true }
          })
        } catch {
          /* focus 落盘失败不影响本条发送 */
        }
      } else if (focusValid) {
        focusUpdatedAtNow = toNumber(group.focusUpdatedAt, 0)
      }
      const focusSessionIdEffective = autoSource === 'mention' ? activeFocusId : focusValid ? activeFocusId : ''
      const autoSourceLabel =
        autoSource === 'focus'
          ? '沿用当前对话对象'
          : autoSource === 'manager'
            ? '无 @：回退群管理'
            : autoSource === 'matched'
              ? '无 @：按话题自动选中'
              : ''
      const note = addEntry(
        {
          title: text.slice(0, 20),
          text,
          kind: 'command',
          groupId: group.id,
          author: 'panel',
          origin: 'panel',
          tags: bugfixDelivery ? '@bug' : '@群消息',
          mentions: targetIds,
          taskScope: messageTaskScope,
          skipDedupe: true
        },
        'panel'
      )
      if (!note.ok) return { ok: false, error: note.reason || '发送失败' }

      const requests = []
      const woken = []
      for (const sessionId of targetIds) {
        const isDialogueTarget = Boolean(autoTarget && autoTarget.id === sessionId)
        const isMaintainerTarget = Boolean(maintainerDialogue && sessionId === maintainerIdNow)
        const isDialogue = isDialogueTarget || isMaintainerTarget
        const request = addEntry(
          {
            title: bugfixDelivery
              ? `BUG：${truncate(text, 18)}`
              : isDialogue
                ? `对话：${truncate(text, 18)}`
                : `@${shortSid(sessionId)} ${truncate(text, 18)}`,
            text,
            kind: 'request',
            groupId: group.id,
            author: 'panel',
            origin: 'panel',
            requestTo: [sessionId],
            hiddenFromChat: bugfixDelivery ? false : true,
            taskScope: messageTaskScope,
            ...(messageScopeWarning ? { scopeWarning: messageScopeWarning } : {}),
            ...(bugfixDelivery ? { tags: '@bug' } : isDialogue ? { tags: '@对话' } : {}),
            skipDedupe: true
          },
          'panel'
        )
        if (!request.ok) continue
        requests.push(request.entry.id)
        const message = bugfixDelivery
          ? [
              `【BUG 报告 · 用户在修bug群里投递（群组「${group.name}」）】`,
              text,
              '',
              `请按影响面处理；修好后用 session_share（kind=handoff、group=${group.name}、replyTo=${request.entry.id}、files=文件路径）回执。`,
              '（维护者 protected/service：这是 bug 投递，不是普通任务派活。）'
            ].join('\n')
          : isDialogue
            ? (isMaintainerTarget
                ? [
                    '【用户直接和你对话 · 不是普通任务】',
                    `群组「${group.name}」 · 用户显式 @ 了你（维护者 protected/service 例外）`,
                    text,
                    '',
                    '请直接回应用户：若是 bug 就按修复流程处理并回执；普通任务不要接（可引导到其他成员或修bug群）。不要默认当成本轮新任务。'
                  ]
                : [
                    '【用户在和你对话 · 请直接回应，不要默认当成新任务】',
                    `群组「${group.name}」 · ${autoSourceLabel || '对话对象：你'}`,
                    text,
                    '',
                    '这不是新的任务派活：不要建任务线、不要回复“请提供更多信息”式套话；直接回答/处理用户的话。若用户是在报 bug，按 bug 修复流程处理并回执。'
                  ]
              ).join('\n')
            : [
                `【群内工作安排 · 用户在群里 @ 你（群组「${group.name}」）】`,
                text,
                `【范围锁】归属：${shortSid(sessionId)} · 仅做 scope：${messageTaskScope}（${TASK_SCOPE_DISPATCH_TAIL}）`,
                messageScopeWarning ? `⚠ 范围提醒：${messageScopeWarning} —— 需 owner 确认后再扩展。` : '',
                '',
                `请开始处理。完成后用 session_share 汇报（kind=handoff、group=${group.name}、replyTo=${request.entry.id}、files=文件路径）；无法处理请说明原因。`
              ].filter(Boolean).join('\n')
        await ensureSessionLive(sessionId)
        const outcome = wakeSession(sessionId, message, { requestId: request.entry.id })
        if (outcome.ok) woken.push({ sessionId, title: titleById.get(sessionId) || shortSid(sessionId) })
      }
      logger.info(
        `群「${group.name}」面板发布消息 ${note.entry.id}，@ ${targetIds.length} 人，唤醒 ${woken.length} 人${bugfixDelivery ? '（BUG 投递）' : ''}${autoTarget ? `（自动对话对象 ${shortSid(autoTarget.id)} / ${autoSource}）` : ''}`
      )
      return {
        ok: true,
        messageId: note.entry.id,
        requestIds: requests,
        targets: targetIds.length,
        woken: woken.length,
        wokenTitles: woken.map((item) => item.title),
        bugfix: bugfixDelivery,
        protectedSkipped,
        protectedNotice,
        // task-9：@黏性对话信息 + 无人 @ 的自动路由结果（面板用来显示“正在和谁对话”）。
        focus: {
          sessionId: focusSessionIdEffective,
          updatedAt: focusUpdatedAtNow,
          source: autoSource
        },
        focusSessionId: focusSessionIdEffective,
        focusSource: autoSource,
        autoTarget: autoTarget
          ? {
              id: autoTarget.id,
              title: autoTarget.title || titleById.get(autoTarget.id) || shortSid(autoTarget.id),
              handle: identityOf(autoTarget.id, titleById.get(autoTarget.id)).handle,
              contactId: autoTarget.contactId || contactIdOf(autoTarget.id),
              source: autoSource
            }
          : null,
        autoMention: autoSource === 'mention' ? { id: activeFocusId, source: 'mention' } : null
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
    if (action === 'office.progress') {
      const wanted = String(payload.sessionId || payload.to || payload.id || '').trim()
      if (wanted) {
        let target = null
        try { const sessions = await buildSessionIndex(); const got = resolveSessionRef(wanted, sessions); if (got.ok) target = got.session } catch { /* ignore */ }
        if (!target) return { ok: false, error: '找不到会话：' + wanted }
        return { ok: true, progress: officeProgressOf(target.id), sessionId: target.id, title: target.title }
      }
      const rows = Object.keys(identityStore.read().sessions || {}).map((sessionId) => ({ sessionId, ...officeProgressOf(sessionId) })).sort((a, b) => b.officeLevel - a.officeLevel || b.merit - a.merit)
      return { ok: true, rows, rules: OFFICE_PROMOTION_RULES }
    }
    if (action === 'office.promote') {
      if (!(actor.kind === 'panel' || isMaintainerSession(actor.sessionId))) return { ok: false, error: '只有面板/维护者可以审批晋升' }
      const wanted = String(payload.sessionId || payload.to || payload.id || '').trim()
      let target = null
      try { const sessions = await buildSessionIndex(); const got = resolveSessionRef(wanted, sessions); if (got.ok) target = got.session } catch { /* ignore */ }
      if (!target) return { ok: false, error: '找不到会话：' + wanted }
      const current = officeForSession(target.id)
      const rule = OFFICE_PROMOTION_RULES.find((item) => item.from === current.office) || null
      const officeName = String(payload.office || (rule && rule.to) || '').trim()
      const hit = officeStore.catalog().find((item) => item.name === officeName || item.id === officeName)
      if (!hit) return { ok: false, error: '未知官职：' + officeName, catalog: officeStore.catalog() }
      const saved = officeStore.set(target.id, { office: hit.name, officeId: hit.id, level: hit.level, grantedBy: actor.kind === 'panel' ? 'panel' : actor.sessionId, note: String(payload.reason || payload.note || '晋升审批').slice(0, 200), promotionHistory: [...((officeStore.get(target.id) && officeStore.get(target.id).promotionHistory) || []), { from: current.office, to: hit.name, at: Date.now(), merit: officeMeritOf(target.id).merit }] })
      return { ok: true, promoted: true, sessionId: target.id, title: target.title, office: saved }
    }
    if (action === 'office.assign' || action === 'office.revoke' || action === 'office.list' || action === 'office.user.set') {
      const catalog = officeStore.catalog()
      if (action === 'office.list') {
        return { ok: true, user: officeStore.read().user, sessions: officeStore.read().sessions, catalog }
      }
      const wantedOffice = String(payload.office || payload.rank || payload.title || '').trim()
      const hit = catalog.find((item) => item.name === wantedOffice || item.id === wantedOffice)
      if (action === 'office.user.set') {
        if (!hit) return { ok: false, error: '未知官职：' + wantedOffice, catalog }
        const user = officeStore.setUser({ office: hit.name, officeId: hit.id, level: hit.level, grantedBy: actor && actor.id ? actor.id : 'panel', note: String(payload.note || '').slice(0, 200) })
        return { ok: true, user, catalog }
      }
      const wantedRef = String(payload.sessionId || payload.to || payload.id || '').trim()
      if (!wantedRef) return { ok: false, error: '缺少会话' }
      let target = null
      try {
        const sessions = await buildSessionIndex()
        const resolution = resolveSessionRef(wantedRef, sessions)
        if (resolution.ok) target = resolution.session
      } catch { /* ignore */ }
      if (!target) return { ok: false, error: '找不到会话：' + wantedRef }
      if (action === 'office.revoke') {
        officeStore.remove(target.id)
        return { ok: true, revoked: true, sessionId: target.id, title: target.title || shortSid(target.id), office: null }
      }
      if (!hit) return { ok: false, error: '未知官职：' + wantedOffice, catalog }
      const saved = officeStore.set(target.id, { office: hit.name, officeId: hit.id, level: hit.level, grantedBy: actor && actor.id ? actor.id : 'panel', note: String(payload.note || '').slice(0, 200) })
      return { ok: true, sessionId: target.id, title: target.title || shortSid(target.id), office: saved, catalog }
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
      maintainerStore.set(sessionId, {
        handle,
        avatar,
        // v2.9.1：维护者默认 protected/service（最高保护级别，不接普通任务）。
        protected: true,
        service: true,
        protectionLevel: 'maintainer'
      })
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
      return {
        ok: true,
        sessionId,
        handle,
        avatar,
        role: '维护者',
        protectionLevel: 'maintainer',
        protected: true,
        service: true,
        grants: (await buildSessionIndex()).length - 1,
        hint: '维护者已设为 protected/service（普通路由/group.post/session_ask 都不会再派普通任务）。建议接着执行 bugfix.ensure 创建/复用「' + BUGFIX_GROUP_NAME + '」群，作为维护者的 bug 任务池。'
      }
    }
    if (action === 'maintainer.get') {
      const sessionId = maintainerStore.get()
      const identity = sessionId ? identityOf(sessionId, identityTitleOf(sessionId)) : null
      return {
        ok: true,
        sessionId,
        identity,
        protectionLevel: sessionId ? 'maintainer' : '',
        protected: Boolean(sessionId),
        service: Boolean(sessionId)
      }
    }
    if (action === 'bugfix.ensure') {
      const ensured = await ensureBugfixGroup({ kickoff: true })
      if (!ensured.ok) return { ok: false, error: ensured.error }
      return { ...ensured, bugfix: { groupId: ensured.groupId, name: ensured.name, managerSessionId: ensured.managerSessionId } }
    }
    if (action === 'bugfix.report') {
      let source = 'panel'
      if (typeof payload.sessionId === 'string' && payload.sessionId.trim()) source = payload.sessionId.trim()
      const result = await reportBugToMaintainer({
        title: payload.title,
        text: payload.text,
        files: payload.files,
        author: source,
        workspace: payload.workspace || '',
        origin: source === 'panel' ? 'panel' : 'tool'
      })
      return result
    }
    if (action === 'bugfix.list') {
      const bugfixNow = bugfixGroupOf(groupStore.read())
      if (!bugfixNow) return { ok: true, groupId: '', name: BUGFIX_GROUP_NAME, reports: [] }
      const reports = store
        .readActive()
        .filter((entry) => entry.groupId === bugfixNow.id && entry.kind === 'request' && !entry.hiddenFromChat)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, 30)
        .map((entry) => ({
          id: entry.id,
          title: entry.title,
          text: String(entry.text || '').slice(0, 300),
          status: entry.status === 'answered' || entry.answeredBy ? 'fixed' : 'open',
          author: entry.author,
          ts: entry.ts,
          files: Array.isArray(entry.files) ? entry.files : []
        }))
      return { ok: true, groupId: bugfixNow.id, name: bugfixNow.name, reports }
    }
    if (action === 'task.pause' || action === 'session.pause' || action === 'task.resume' || action === 'session.resume') {
      const reason = String(payload.reason || payload.note || '用户明确暂停').replace(/\s+/g, ' ').trim().slice(0, 200)
      const resolving = action.startsWith('task')
      const ref = String(payload.taskId || payload.requestId || payload.sessionId || payload.id || '').trim()
      if (!ref) return { ok: false, error: '缺少要暂停的任务/请求/会话' }
      if (action === 'session.resume' || action === 'task.resume') {
        if (resolving) {
          pauseStore.remove('tasks', ref); pauseStore.remove('requests', ref)
        } else pauseStore.remove('sessions', ref)
        return { ok: true, resumed: true, id: ref }
      }
      if (action === 'session.pause') {
        let target = null
        try { const sessions = await buildSessionIndex(); const got = resolveSessionRef(ref, sessions); if (got.ok) target = got.session } catch { /* ignore */ }
        if (!target) return { ok: false, error: '找不到会话：' + ref }
        const saved = pauseStore.set('sessions', target.id, { reason, title: target.title || shortSid(target.id) })
        return { ok: true, paused: true, kind: 'session', id: target.id, title: target.title, reason: saved.reason }
      }
      const entry = findBoardEntry(ref)
      if (!entry) return { ok: false, error: '找不到任务/请求：' + ref }
      const saved = pauseStore.set(entry.kind === 'request' ? 'requests' : 'tasks', entry.id, { reason, title: entry.title || entry.id, kind: entry.kind })
      return { ok: true, paused: true, kind: entry.kind, id: entry.id, title: entry.title, reason: saved.reason }
    }
    if (action === 'session.compact') {
      if (!(actor.kind === 'panel' || isMaintainerSession(actor.sessionId))) return { ok: false, error: '只有面板/维护者可以压缩上下文' }
      const wanted = String(payload.sessionId || payload.to || payload.id || '').trim()
      if (!wanted) return { ok: false, error: '缺少 sessionId' }
      let target = null
      try { const sessions = await buildSessionIndex(); const got = resolveSessionRef(wanted, sessions); if (got.ok) target = got.session } catch { /* ignore */ }
      if (!target) return { ok: false, error: '找不到会话：' + wanted }
      const agent = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(target.id) : undefined
      if (!agent) return { ok: false, error: '目标会话当前不 live，先恢复后再压缩' }
      if (agent.status !== 'idle') return { ok: false, error: '目标会话正在运行（status=' + agent.status + '），需等 idle 才可手动压缩' }
      let compaction = injectedCompaction
      if (!compaction) { try { compaction = agent.ctx && agent.ctx.get ? agent.ctx.get('compaction') : null } catch { /* ignore */ } }
      if (!compaction) { try { compaction = agent.ctx && agent.ctx.compaction ? agent.ctx.compaction : null } catch { /* ignore */ } }
      if (!compaction || typeof compaction.compactNow !== 'function') return { ok: false, error: '宿主未提供 compaction.compactNow（agent scope 也没有）' }
      const controller = new AbortController()
      try {
        const result = await compaction.compactNow(agent, controller.signal, 'manual:' + Date.now().toString(36))
        if (!result) return { ok: true, compacted: false, sessionId: target.id, title: target.title, message: '没有可安全压缩的区间' }
        return { ok: true, compacted: true, sessionId: target.id, title: target.title, shadowedSeqs: result.shadowedSeqs ? result.shadowedSeqs.length : undefined, shadowedTokenCount: result.shadowedTokenCount }
      } catch (error) {
        logger.warn('手动上下文压缩失败：' + (error && error.message ? error.message : error))
        return { ok: false, error: '压缩失败：' + (error && error.message ? error.message : String(error)) }
      }
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
    if (action === 'presence.ping') {
      lastUserPresenceAt = Date.now()
      return { ok: true, ttlMs: USER_PRESENCE_TTL_MS }
    }
    if (action === 'activity.spark') {
      const wanted = String(payload.id || '').trim()
      const groups = groupStore.read()
      const group = groups.find((item) => item.id === wanted || item.id.startsWith(wanted))
      if (!group) return { ok: false, error: '找不到群组' }
      lastUserPresenceAt = Date.now()
      const result = await startSparkForGroup(group, { force: true })
      return result.skipped ? { ok: false, error: result.reason } : result
    }
    if (action === 'activity.tea') {
      const wanted = String(payload.id || '').trim()
      const groups = groupStore.read()
      const group = groups.find((item) => item.id === wanted || item.id.startsWith(wanted))
      if (!group) return { ok: false, error: '找不到群组' }
      lastUserPresenceAt = Date.now()
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
      const discussionEntry = addEntry(
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
      if (discussionEntry && discussionEntry.ok) watchDiscussionReply({ group, topic, targets, sinceTs: discussionEntry.entry.ts || Date.now() })
      const contextLines = discussionContextOf(group.id, 4)
      const message = [
        '【讨论 · 用户发起（不是任务）】',
        topic,
        '',
        ...(contextLines.length ? ['最近群里聊到：', ...contextLines, ''] : []),
        '讨论不是每人各发一段观点：先看最近讨论，接着某一句赞同/反驳/补充，再 @ 一个具体成员继续。2 句话以内，直接 session_share（kind=chat、group=' + group.name + '；想点名接话加 to=<成员>）发出来。这是闲聊，禁止直接干活/执行任务/读写文件；如果刚好发现 bug，可以用 session_share kind=bug 提一下，但不要顺手修。限时 2 分钟回应；到点没反应先警告，警告后 60 秒仍无闲聊或 bug 反馈将关闭对话。'
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
    if (action === 'group.focus') {
      // task-9：@黏性对话——设置/清除「当前对话对象」；传空 sessionId 表示结束对话。
      const wanted = String(payload.id || '').trim()
      const wantedSession = String(payload.sessionId || '').trim()
      const groupsNow = groupStore.read()
      const target = groupsNow.find((item) => item.id === wanted || (wanted && item.id.startsWith(wanted)))
      if (!target) return { ok: false, error: '找不到群组' }
      if (!wantedSession || wantedSession === 'panel' || wantedSession === '-') {
        const cleared = mutateGroups((list) => {
          const group = list.find((item) => item.id === target.id)
          if (!group) return { ok: false, error: '找不到群组' }
          group.focusSessionId = ''
          group.focusUpdatedAt = Date.now()
          group.updatedAt = Date.now()
          return { ok: true, groupId: group.id }
        })
        if (!cleared.ok) return cleared
        return { ok: true, groupId: target.id, focusSessionId: '', focus: null, cleared: true }
      }
      const sessions = await buildSessionIndex()
      const session = sessions.find((item) => item.id === wantedSession)
      if (!session || !target.sessionIds.includes(session.id)) {
        return { ok: false, error: '只能把本群成员设为对话对象；请传完整 sessionId 或先经 session_directory 解析' }
      }
      const focusUpdatedAt = Date.now()
      const result = mutateGroups((list) => {
        const group = list.find((item) => item.id === target.id)
        if (!group) return { ok: false, error: '找不到群组' }
        group.focusSessionId = session.id
        group.focusUpdatedAt = focusUpdatedAt
        group.updatedAt = focusUpdatedAt
        return { ok: true, groupId: group.id }
      })
      if (!result.ok) return result
      return {
        ok: true,
        groupId: target.id,
        focusSessionId: session.id,
        focusUpdatedAt,
        focus: {
          id: session.id,
          title: session.title || shortSid(session.id),
          handle: identityOf(session.id, session.title).handle,
          contactId: session.contactId || contactIdOf(session.id),
          protected: session.protected === true
        }
      }
    }
    if (action === 'group.update' || action === 'group.rename') {
      const wanted = String(payload.id || '').trim()
      const autoName = action === 'group.rename' && payload.auto === true
      const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 40) : ''
      const hasGoal = typeof payload.goal === 'string'
      const goal = hasGoal ? payload.goal.trim().slice(0, 300) : ''
      if (action === 'group.rename' && !name && !autoName) {
        return { ok: false, error: '群名不能为空（也可传 auto=true 按群目标自动生成可读群名）' }
      }
      if (action === 'group.update' && !name && !hasGoal) return { ok: false, error: '没有要更新的字段' }
      const groupsNow = groupStore.read()
      const target = groupsNow.find((item) => item.id === wanted || item.id.startsWith(wanted))
      if (!target) return { ok: false, error: '找不到群组' }
      // auto=true（v2.9.0）：按群目标/工作区重新生成可读群名，用于修复历史遗留的半句群名。
      let nextName = name
      if (autoName) {
        const sessionsNow = await buildSessionIndex()
        const firstMember = sessionsNow.find((session) => session.id === target.sessionIds[0])
        nextName = generateGroupName(target.goal || target.name || '协作群', {
          workspace: target.workspace || (firstMember && firstMember.cwd) || ''
        })
      }
      let previousName = ''
      const result = mutateGroups((groups) => {
        const group = groups.find((item) => item.id === target.id)
        if (!group) return { ok: false, error: '找不到群组' }
        previousName = group.name
        if (nextName) group.name = nextName
        if (hasGoal) group.goal = goal
        group.updatedAt = Date.now()
        return { ok: true, groupId: group.id }
      })
      if (result.ok) {
        // 群管理会话的标题由群名派生（buildSessionIndex 每次按最新群名生成），改名后标题自动保持可读。
        if (target.managerSessionId) titleCache.delete(target.managerSessionId)
        logger.info(`群组改名：${previousName || target.name} → ${nextName || target.name}（id=${target.id}）`)
        return { ok: true, groupId: target.id, name: nextName || target.name, previousName: previousName || target.name }
      }
      return result
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
      // task-9：被移出群的成员如果正是当前对话对象，顺带清除 focus，避免后续消息发给不在群里的人。
      if (action === 'group.remove' && result.ok && affectedGroup && removedSessionIds.length) {
        try {
          const groupsNow = groupStore.read()
          const targetGroup = groupsNow.find((item) => item.id === affectedGroup.id)
          if (targetGroup && targetGroup.focusSessionId && removedSessionIds.includes(targetGroup.focusSessionId)) {
            mutateGroups((list) => {
              const group = list.find((item) => item.id === affectedGroup.id)
              if (group) {
                group.focusSessionId = ''
                group.focusUpdatedAt = Date.now()
                group.updatedAt = Date.now()
              }
              return { ok: true }
            })
            affectedGroup.focusCleared = true
          }
        } catch {
          /* focus 清理失败不影响移除成员 */
        }
      }
      return result
    }
    if (action === 'group.recruit') {
      // 面板/组长请求世界路由招募：优先空闲现有成员；需要新建时走复核（approveAutoCreate）。
      const groups = groupStore.read()
      const ref = String(payload.group || payload.id || '').trim()
      let group = null
      if (ref) {
        group =
          groups.find((item) => item.id === ref || item.id.startsWith(ref) || item.name === ref) ||
          groupStore.find(ref, '') ||
          null
        if (!group) {
          return { ok: false, error: '找不到群组「' + ref + '」。当前群组：' + (groups.map((item) => item.name).join('、') || '（无）') }
        }
      } else if (groups.length === 1) {
        group = groups[0]
      } else {
        return {
          ok: false,
          error: groups.length
            ? '请用 group= 指定群组（当前有 ' + groups.length + ' 个群：' + groups.map((item) => item.name).join('、') + '）'
            : '当前还没有群组。'
        }
      }
      const text = String(payload.text || payload.need || '').trim().slice(0, 800)
      if (!text) return { ok: false, error: '招募需求不能为空（text/need）' }
      return recruitMembers({
        group,
        text,
        count: payload.count,
        mode: payload.mode,
        skills: payload.skills,
        requesterId: 'panel',
        requesterLabel: '用户面板',
        origin: 'panel',
        approved: payload.approved === true,
        approvalId: String(payload.approvalId || '')
      })
    }
    if (action === 'session.urgent') {
      // 面板加急：用户可以直接对任意会话加急（权限最高），同样受限频保护。
      const toRef = String(payload.to || '').trim()
      if (!toRef) return { ok: false, error: '缺少目标会话 to（contactId / 短 id / handle / 标题 / 完整 id）' }
      const text = String(payload.text || '').trim().slice(0, 800)
      if (!text) return { ok: false, error: '加急内容不能为空' }
      let group = null
      const groupRef = String(payload.group || payload.groupId || '').trim()
      if (groupRef) {
        group = groupStore.read().find(
          (item) => item.id === groupRef || item.id.startsWith(groupRef) || item.name === groupRef
        ) || null
        if (!group) return { ok: false, error: '找不到群组「' + groupRef + '」' }
      }
      const sessionsNow = await buildSessionIndex()
      const outcome = resolveSessionRef(toRef, sessionsNow)
      if (!outcome.ok) {
        return {
          ok: false,
          error: outcome.ambiguous
            ? 'to=「' + toRef + '」指向不唯一，请改用 contactId 或完整 id。' + (outcome.error ? '\n' + outcome.error : '')
            : '找不到目标会话「' + toRef + '」。',
          candidates: outcome.candidates || []
        }
      }
      return sendUrgentSession({
        fromId: 'panel',
        target: outcome.session,
        text,
        group,
        origin: 'panel'
      })
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

  let ambientStateCache = { at: 0, state: null }
  const handleAmbientRoute = async (req, res) => {
    try {
      if (req.method !== 'GET') return jsonOut(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isLoopbackCaller(req)) return jsonOut(res, 403, { ok: false, error: 'forbidden' })
      const url = new URL(String(req.url || ''), 'http://127.0.0.1')
      const sessionId = String(url.searchParams.get('sessionId') || '').trim()
      if (!sessionId) return jsonOut(res, 400, { ok: false, error: 'missing-sessionId' })
      if (!ambientStateCache.state || Date.now() - ambientStateCache.at > 2000) {
        ambientStateCache = { at: Date.now(), state: await stateForUi() }
      }
      jsonOut(res, 200, buildAmbientFromState(ambientStateCache.state, sessionId))
    } catch (error) {
      jsonOut(res, 500, { ok: false, error: 'ambient-failed', detail: error && error.message ? error.message : String(error) })
    }
  }

  const handleComputerPriorityRoute = async (req, res) => {
    try {
      if (req.method !== 'GET') return jsonOut(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isLoopbackCaller(req)) return jsonOut(res, 403, { ok: false, error: 'forbidden' })
      const url = new URL(String(req.url || ''), 'http://127.0.0.1')
      const owner = String(url.searchParams.get('owner') || url.searchParams.get('sessionId') || '').trim()
      if (!owner) return jsonOut(res, 400, { ok: false, error: 'missing-owner' })
      const office = officeForSession(owner)
      const rep = reputationOf(owner)
      const merit = officeMeritOf(owner)
      const priority = Number(office.officeLevel || 10) * 10000 + Math.max(0, Number(rep.points || 0))
      jsonOut(res, 200, { ok: true, owner, office: office.office, level: office.officeLevel, points: Number(rep.points || 0), merit: merit.merit, priority })
    } catch (error) {
      jsonOut(res, 500, { ok: false, error: 'priority-failed', detail: error && error.message ? error.message : String(error) })
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
  let ambientPromptBySession = new Map()
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
      const result = await executeCommand(command, { actor: { kind: 'panel' } })
      if (!result || result.ok !== true) {
        // 失败也带回可读细节（如 retryAfterMs / candidates / idleFound），前端能做提示与重试。
        const detail = result && typeof result === 'object' ? result : {}
        return jsonOut(res, 400, {
          ...detail,
          ok: false,
          error: (result && result.error) || 'command-failed',
          state: await stateForUi()
        })
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
          () => webServer.register({ kind: 'exact', path: '/api/session-bridge/computer/priority', handler: handleComputerPriorityRoute }),
          'session-bridge: GET /api/session-bridge/computer/priority'
        )
        ctx.effect(
          () => webServer.register({ kind: 'exact', path: '/api/session-bridge/ambient', handler: handleAmbientRoute }),
          'session-bridge: GET /api/session-bridge/ambient'
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
      // 冷启动时 webServer 可能尚未就绪；注册失败会继续重试，先记 info，2 分钟仍失败才 warn。
      if (webServerAttempts === 1 || webServerAttempts % 20 === 0) {
        logger.info(`注册看板 HTTP API 暂不可用（第 ${webServerAttempts} 次）：${error && error.message ? error.message : error}`)
      }
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
    // 自愈成功属于预期恢复，不是故障：记 info，避免巡检长期把它当警告。
    if (created) logger.info('工作区自愈：从会话存储恢复了 ' + created + ' 个工作区、挂回 ' + attached + ' 个会话')
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
      if (!userPresent()) return
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
      if (!userPresent()) return
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
      const promotedNow = evaluateOfficePromotions()
      if (promotedNow.length) fixes.push('军功晋升：' + promotedNow.map((item) => shortSid(item.sessionId) + '→' + item.office).join('、'))
    } catch (error) { logger.warn('军功晋升巡检失败：' + (error && error.message ? error.message : error)) }
    // 修复「活着但没挂 preset」的会话：核心工具在 preset 上，漏挂载就只剩宿主面工具。
    try {
      const repairedPresets = await Promise.race([
        repairPresetForLiveSessions('health'),
        new Promise((resolve) => setTimeout(() => resolve([]), 5000))
      ])
      if (repairedPresets.length > 0) fixes.push(`为 ${repairedPresets.length} 个 live 会话补挂 agent preset（核心工具恢复）`)
    } catch (error) {
      logger.warn('preset 修复失败：' + (error && error.message ? error.message : error))
    }
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
            // v2.9.1：维护者 protected/service，不作为普通群的群管理兜底（保持观察身份）。
            const firstMember =
              group.sessionIds.find((sessionId) => !isMaintainerSession(sessionId)) || group.sessionIds[0]
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
        const existed = liveAgentOf(managerId)
        const resumed = existed ? { agent: existed, skipped: false } : await resumeSessionForLive(managerId)
        // 会话已活跃（可能被别的写句柄占用）时跳过恢复，不算故障。
        if (!resumed.agent && !resumed.skipped) {
          issues.push('群「' + group.name + '」的群管理离线且恢复失败')
          continue
        }
        if (!existed && resumed.agent) fixes.push('恢复群管理 ' + shortSid(managerId) + ' 上线')
      }
      // 维护者在线 + 全局唤醒授权
      const maintainerId = maintainerStore.get()
      if (!maintainerId) issues.push('尚未设置维护者会话')
      else {
        const existed = liveAgentOf(maintainerId)
        const resumed = existed ? { agent: existed, skipped: false } : await resumeSessionForLive(maintainerId)
        if (!resumed.agent && !resumed.skipped) issues.push('维护者会话离线且恢复失败')
        else if (!existed && resumed.agent) fixes.push('恢复维护者会话上线')
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
          if (pauseStore.isPaused('tasks', task.id) || pauseStore.isPaused('sessions', task.coordinator || task.owner || '')) continue
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
              entry.status !== 'canceled' &&
              !entry.answeredBy &&
              (entry.ts || 0) > Date.now() - 48 * 3600 * 1000 &&
              !pauseStore.isPaused('requests', entry.id) &&
              Array.isArray(entry.requestTo)
          )
          .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        let retried = 0
        for (const request of recentRequests) {
          if (retried >= 3) break
          for (const targetId of request.requestTo) {
            if (retried >= 3) break
            if (pauseStore.isPaused('sessions', targetId)) continue
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
      // 日志近期警告：只看时间窗口（最近 24h）内的显式 [warn]/[error]，不再按末 300 行统计历史 warn。
      try {
        const logFile = path.join(boardDir, 'session-bridge.log')
        if (fs.existsSync(logFile)) {
          const since = Date.now() - HEALTH_LOG_WINDOW_MS
          const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/)
          let warnings = 0
          for (const line of lines) {
            const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+\[(?:warn|error)\]/.exec(line)
            if (!match) continue
            const ts = Date.parse(match[1])
            if (Number.isFinite(ts) && ts >= since) warnings += 1
          }
          if (warnings > HEALTH_LOG_WARN_THRESHOLD) {
            issues.push('近期日志警告偏多（' + warnings + ' 条 / 最近 ' + HEALTH_LOG_WINDOW_MS / 3600000 + 'h）')
          }
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
  // 插件加载/热更新后尽早补挂一次（8s 时 agent 已就绪；25s 兜住宿主加载更慢的场合）。
  for (const presetRepairDelay of [8000, 25000]) {
    const presetRepairTimer = setTimeout(() => { void repairPresetForLiveSessions('load').catch(() => {}) }, presetRepairDelay)
    presetRepairTimer.unref?.()
  }

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
