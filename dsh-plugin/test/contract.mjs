/**
 * session-bridge 插件契约自测（离线，不需要 DSH 宿主）
 *
 * 覆盖 2026-11-03 事故的三类根因 + 基本功能：
 *  A. 工具 parameters 必须是标准 JSON Schema（曾被写成 defineTool DSL，provider 直接 400）
 *  B. systemPrompt.context/section 必须 interpolate:false，且注入文本必须逐 step 稳定
 *     （曾用相对时间 humanAge()，每跨一分钟就追加一整条运行时上下文快照）
 *  C. 只有主会话能拿到经验板/能发布（子智能体、teammate 必须被排除）
 *
 * 跑法：node test/contract.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CWD = process.cwd()
const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-bridge-test-'))
const receiptPath = path.join(boardDir, '.plugin-loaded.json')
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------- 桩宿主
const captured = { tools: [], sections: [], contexts: [], listeners: [], harnessLogs: [], routes: [], followups: [] }
const header = (extra = {}) => ({ cwd: CWD, ...extra })
const rootAgent = { id: 'session-aaaa0001', status: 'idle', session: { id: 'session-aaaa0001', header: header() } }
const otherAgent = {
  id: 'session-dddd0004',
  status: 'idle',
  session: { id: 'session-dddd0004', header: header({ cwd: 'C:\\work\\other-workspace' }) }
}
const nonMemberAgent = {
  id: 'session-eeee0005',
  status: 'idle',
  session: { id: 'session-eeee0005', header: header({ cwd: 'C:\\work\\third-workspace' }) }
}
const subAgent = {
  id: 'session-bbbb0002',
  status: 'running',
  session: { id: 'session-bbbb0002', header: header({ origin: 'subagent', parentSession: 'session-aaaa0001', delegationDepth: 1 }) }
}
const fakeWebServer = {
  register(route) {
    captured.routes.push(route)
    return () => {}
  }
}
// 群内请求会调用 Agent.followup() 唤醒目标会话；桩里只记录调用。
for (const agent of [rootAgent, otherAgent, nonMemberAgent, subAgent]) {
  agent.followup = function followup(message) {
    captured.followups.push({ sessionId: this.id, message })
  }
}
const TITLES = {
  'session-aaaa0001': '论文写作-第一篇',
  'session-dddd0004': '论文写作-第二篇',
  'session-eeee0005': '论文写作-第三篇'
}
const fakeSessionQuery = {
  async listSessions() {
    return [rootAgent, otherAgent, nonMemberAgent].map((agent) => ({
      header: agent.session.header,
      live: true,
      persisted: true,
      formatStatus: 'current'
    }))
  },
  async readTitleSnapshots(ids) {
    return ids.map((id) => ({
      sessionId: id,
      status: 'fulfilled',
      value: { session: { id }, ...(TITLES[id] ? { title: { title: TITLES[id] } } : {}) }
    }))
  }
}
const ctx = {
  tools: {
    register(definition) {
      captured.tools.push(definition)
      return () => {}
    }
  },
  systemPrompt: {
    section(options) {
      captured.sections.push(options)
      return () => {}
    },
    context(options) {
      captured.contexts.push(options)
      return () => {}
    }
  },
  agents: {
    roots: () => [rootAgent, otherAgent],
    list: () => [rootAgent, otherAgent, nonMemberAgent, subAgent],
    get: (id) => [rootAgent, otherAgent, nonMemberAgent, subAgent].find((agent) => agent.id === id)
  },
  sessions: {
    list: () => [rootAgent.session, otherAgent.session, nonMemberAgent.session]
  },
  get(name) {
    if (name === 'webServer') return fakeWebServer
    if (name === 'sessionQuery') return fakeSessionQuery
    return undefined
  },
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  on(name, listener) {
    captured.listeners.push({ name, listener })
    return () => {}
  },
  logger: {
    info: () => {},
    warn: (message) => captured.harnessLogs.push(['warn', String(message)]),
    error: (message) => captured.harnessLogs.push(['error', String(message)])
  }
}

// 预置一条看板条目（ts 固定，便于断言绝对时间戳）
const seededTs = new Date(2026, 10, 3, 9, 5, 0).getTime()
fs.writeFileSync(
  path.join(boardDir, 'board.jsonl'),
  JSON.stringify({
    op: 'add',
    id: 'n-seed0001',
    entry: {
      id: 'n-seed0001',
      kind: 'note',
      scope: 'workspace',
      workspace: CWD,
      author: 'session-cccc0003',
      title: '测试条目',
      text: '这是一条用于自测的经验内容',
      tags: ['test'],
      origin: 'tool',
      ts: seededTs,
      expiresAt: 0
    },
    ts: seededTs
  }) + '\n',
  'utf8'
)

// ---------------------------------------------------------------- 加载插件
const plugin = await import('../index.js')
const failures = []
const check = async (label, fn) => {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures.push(`${label}: ${error && error.message ? error.message : error}`)
    console.log(`  FAIL ${label} :: ${error && error.message ? error.message : error}`)
  }
}

console.log('== 基本形状')
await check('导出 name/inject/apply', () => {
  assert.equal(plugin.name, 'session-bridge')
  assert.deepEqual(plugin.inject, ['tools', 'systemPrompt', 'agents'])
  assert.equal(typeof plugin.apply, 'function')
})

plugin.apply(ctx, { boardDir, injectMode: 'broadcast' })

// ---------------------------------------------------------------- A. 工具 schema
console.log('== A. 工具 parameters 是标准 JSON Schema')
const toolByName = new Map(captured.tools.map((tool) => [tool.name, tool]))

const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'])
function assertJsonSchema(node, where) {
  assert.ok(node && typeof node === 'object' && !Array.isArray(node), `${where} 必须是对象`)
  if (node.type === undefined && node.oneOf === undefined && node.anyOf === undefined) {
    assert.fail(`${where} 缺少 type`)
  }
  if (node.enum !== undefined) {
    assert.ok(Array.isArray(node.enum) && node.enum.length > 0, `${where}.enum 必须是非空数组`)
  }
  if (node.minimum !== undefined) assert.ok(typeof node.minimum === 'number', `${where}.minimum 必须是数字`)
  if (node.maximum !== undefined) assert.ok(typeof node.maximum === 'number', `${where}.maximum 必须是数字`)
  if (node.description !== undefined) assert.ok(typeof node.description === 'string', `${where}.description 必须是字符串`)
  if (node.type === 'object') {
    assert.ok(node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties), `${where}.properties 必须是对象`)
    if (node.required !== undefined) {
      assert.ok(Array.isArray(node.required), `${where}.required 必须是字符串数组`)
      for (const key of node.required) {
        assert.equal(typeof key, 'string', `${where}.required 只能放字符串`)
        assert.ok(key in node.properties, `${where}.required 里的 ${key} 必须在 properties 中`)
      }
    }
    for (const [key, child] of Object.entries(node.properties)) assertJsonSchema(child, `${where}.properties.${key}`)
    return
  }
  assert.ok(SCALAR_TYPES.has(node.type), `${where}.type 不合法：${String(node.type)}`)
}

await check('恰好注册 session_share / session_board / session_ask', () => {
  assert.deepEqual([...toolByName.keys()].sort(), ['group_member', 'group_recruit', 'group_rule', 'group_skill', 'session_ask', 'session_board', 'session_directory', 'session_discuss', 'session_identity', 'session_interrupt', 'session_like', 'session_nudge', 'session_profile', 'session_retract', 'session_share', 'session_urgent'])
  assert.equal(captured.harnessLogs.filter(([level]) => level === 'error').length, 0, '注册阶段不应有 error 级日志')
})

for (const name of ['session_share', 'session_board', 'session_ask', 'session_profile', 'session_nudge', 'group_rule', 'session_like', 'session_discuss', 'session_identity', 'group_skill', 'group_member']) {
  check(`${name}.parameters 是对象根 JSON Schema`, () => {
    const tool = toolByName.get(name)
    assert.ok(tool, `缺少工具 ${name}`)
    const parameters = tool.parameters
    assert.equal(parameters.type, 'object', `${name}.parameters.type 必须是 object`)
    assert.ok(parameters.properties && typeof parameters.properties === 'object', `${name}.parameters.properties 缺失`)
    // 事故根因：DSL 把属性名写进根对象（title/text 与 JSON Schema 关键字 title 冲突）
    assert.equal(parameters.title, undefined, `${name}.parameters 根上不能有 title 键`)
    assert.equal(parameters.text, undefined, `${name}.parameters 根上不能有 text 键`)
    assert.equal(parameters.action, undefined, `${name}.parameters 根上不能有 action 键`)
    assertJsonSchema(parameters, `${name}.parameters`)
    // 序列化后不允许出现 DSL 形态的 "required":true
    assert.ok(!JSON.stringify(parameters).includes('"required":true'), `${name}.parameters 里仍有 DSL 的 required:true`)
  })
}

await check('session_share.parameters.required 是 ["title","text"]', () => {
  assert.deepEqual(toolByName.get('session_share').parameters.required, ['title', 'text'])
})

await check('session_share.kind/scope 用枚举约束', () => {
  const properties = toolByName.get('session_share').parameters.properties
  assert.deepEqual(properties.kind.enum, ['note', 'handoff', 'lesson', 'decision', 'chat', 'bug'])
  assert.deepEqual(properties.scope.enum, ['workspace', 'global'])
})

await check('session_board.action 用枚举约束', () => {
  assert.deepEqual(toolByName.get('session_board').parameters.properties.action.enum, [
    'list',
    'groups',
    'remove',
    'claim',
    'unclaim',
    'ack',
    'status',
    'bugfix'
  ])
})

await check('session_share.group 参数存在（可选）', () => {
  const properties = toolByName.get('session_share').parameters.properties
  assert.ok(properties.group && properties.group.type === 'string')
  assert.ok(!toolByName.get('session_share').parameters.required.includes('group'))
})

await check('两个工具都有 output.schema + render', () => {
  for (const name of ['session_share', 'session_board']) {
    const tool = toolByName.get(name)
    assert.equal(tool.output.schema.type, 'string')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
})

// ---------------------------------------------------------------- B. 上下文/说明段
console.log('== B. 上下文注册与文本稳定性')
const section = captured.sections.find((item) => item.name === 'session-bridge:instructions')
const context = captured.contexts.find((item) => item.name === 'session-bridge:board')

await check('说明段：order 650 · interpolate:false · 主会话可见 / 子会话为空', () => {
  assert.ok(section, '未注册 session-bridge:instructions')
  assert.equal(section.order, 650)
  assert.equal(section.interpolate, false, 'section 必须显式 interpolate:false')
  assert.match(String(section.text({ agent: rootAgent })), /跨会话经验桥/)
  assert.equal(String(section.text({ agent: subAgent })), '', '子会话不应注入说明段')
  assert.equal(String(section.text({ agent: undefined })), '')
})

await check('上下文：order 300 · required:true · interpolate:false', () => {
  assert.ok(context, '未注册 session-bridge:board')
  assert.equal(context.order, 300)
  assert.equal(context.required, true)
  assert.equal(context.interpolate, false, 'context 必须显式 interpolate:false（正文可能含 {{…}}）')
})

await check('上下文正文：有看板内容、绝对时间戳、无相对时间', () => {
  const text = String(context.text({ agent: rootAgent }))
  assert.match(text, /【跨会话共享经验板/)
  assert.match(text, /测试条目/)
  assert.match(text, /来自会话 cccc00/, '应显示发布者短 id')
  assert.ok(/（来自会话 [0-9a-z]+，\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text), '应使用绝对时间戳 YYYY-MM-DD HH:mm')
  for (const forbidden of ['刚刚', '分钟前', '小时前', '天前']) {
    assert.ok(!text.includes(forbidden), `上下文正文不应出现相对时间「${forbidden}」`)
  }
})

await check('上下文正文逐 step 稳定（Date.now 漂移不影响文本）', () => {
  const realNow = Date.now
  try {
    Date.now = () => seededTs
    const first = String(context.text({ agent: rootAgent }))
    Date.now = () => seededTs + 37 * 60 * 1000
    const second = String(context.text({ agent: rootAgent }))
    Date.now = () => seededTs + 5 * 3600 * 1000
    const third = String(context.text({ agent: rootAgent }))
    assert.equal(first, second, '同一份看板在不同时间点渲染出的文本必须一致（否则每步追加一条上下文快照）')
    assert.equal(second, third)
  } finally {
    Date.now = realNow
  }
})

await check('子会话拿不到经验板上下文', () => {
  assert.equal(String(context.text({ agent: subAgent })), '')
})

await check('没有条目时上下文返回空串（零注入）', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-bridge-empty-'))
  const localCtx = {
    ...ctx,
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {}, context: (options) => { localCtx.contextOptions = options; return () => {} } },
    agents: { roots: () => [rootAgent], get: () => rootAgent }
  }
  plugin.apply(localCtx, { boardDir: emptyDir, injectMode: 'broadcast', autoPrompt: false })
  assert.equal(String(localCtx.contextOptions.text({ agent: rootAgent })), '', '空看板应返回空串')
})

// ---------------------------------------------------------------- C. 工具执行
console.log('== C. 工具执行与主会话隔离')
const share = toolByName.get('session_share')
const board = toolByName.get('session_board')
const boardFile = path.join(boardDir, 'board.jsonl')
const lineCount = () => fs.readFileSync(boardFile, 'utf8').split('\n').filter(Boolean).length

await check('子会话调用 session_share 被拒绝且不写盘', async () => {
  const before = lineCount()
  const result = await share.execute({ title: '子会话测试' }, { agent: subAgent })
  assert.match(String(result), /子会话不直接向经验板发布/)
  assert.equal(lineCount(), before, '被拒绝时不应写看板')
})

await check('主会话发布成功', async () => {
  const result = await share.execute({ title: '契约自测条目', text: '自测正文', kind: 'lesson' }, { agent: rootAgent })
  assert.match(String(result), /已发布到跨会话经验板/)
  assert.equal(lineCount(), 2)
})

await check('查重生效（相同内容不重复发布）', async () => {
  const result = await share.execute({ title: '契约自测条目', text: '自测正文', kind: 'lesson' }, { agent: rootAgent })
  assert.match(String(result), /未重复发布/)
  assert.equal(lineCount(), 2)
})

await check('session_board status 报告版本与注册结果', async () => {
  const result = String(await board.execute({ action: 'status' }, { agent: rootAgent }))
  assert.match(result, /session-bridge v2\.9\.6/)
  assert.match(result, /工具：session_share, session_ask, session_nudge, session_retract, session_interrupt, group_rule, session_like, session_discuss, session_identity, group_member, session_directory, group_skill, session_profile, session_board, group_recruit, session_urgent/)
  assert.match(result, /通讯录：3 个主会话/)
  assert.match(result, /空闲看板：idle \d+ 个 · busy \d+ 个/)
  assert.match(result, /权限分级：维护者=未注册/)
  assert.match(result, /contactId=aaaa0001/)
  assert.match(result, /看板 API=是/)
  assert.ok(!/失败=(session_share|session_board)/.test(result), '不应有注册失败的工具')
})

await check('子会话可只读查看经验板（list / status）', async () => {
  const status = String(await board.execute({ action: 'status' }, { agent: subAgent }))
  assert.match(status, /session-bridge v2\.9\.6/)
  const listed = String(await board.execute({ action: 'list' }, { agent: subAgent }))
  assert.match(listed, /跨会话经验板/)
})

await check('子会话不能执行写操作（remove / claim）', async () => {
  const removed = String(await board.execute({ action: 'remove', id: 'n-seed0001' }, { agent: subAgent }))
  assert.match(removed, /子会话只能只读查看/)
  const claimed = String(await board.execute({ action: 'claim', id: 'n-seed0001' }, { agent: subAgent }))
  assert.match(claimed, /子会话只能只读查看/)
})

await check('session_board list 能看到自己发布的条目', async () => {
  const result = String(await board.execute({ action: 'list', includeOwn: true }, { agent: rootAgent }))
  assert.match(result, /契约自测条目/)
  assert.match(result, /测试条目/)
})

await check('session_board remove 删除条目', async () => {
  const listed = String(await board.execute({ action: 'list', includeOwn: true }, { agent: rootAgent }))
  const match = listed.match(/id=(n-[a-z0-9-]+)…/)
  assert.ok(match, '列表里应能解析出条目 id')
  await board.execute({ action: 'remove', id: match[1] }, { agent: rootAgent })
  const after = String(await board.execute({ action: 'list', includeOwn: true }, { agent: rootAgent }))
  assert.ok(!after.includes('契约自测条目'), '删除后不应再出现')
})

// ---------------------------------------------------------------- D. 群组 / 送达接受 / 看板 API
console.log('== D. 群组、送达接受与看板 HTTP API')

const fakeReq = ({ method = 'GET', headers = {}, body = '' } = {}) => {
  const listeners = {}
  const request = {
    method,
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:43129', ...headers },
    on(event, listener) {
      listeners[event] = listener
      return request
    },
    destroy() {}
  }
  setTimeout(() => {
    if (body && listeners.data) listeners.data(Buffer.from(body))
    if (listeners.end) listeners.end()
  }, 0)
  return request
}
const fakeRes = () => {
  const out = { status: 0, headers: {}, body: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers || {}
    },
    end(body) {
      out.body = body || ''
    }
  }
}
const routeHandler = (path) => captured.routes.find((route) => route.path === path)?.handler
const callState = async () => {
  const res = fakeRes()
  await routeHandler('/api/session-bridge/state')(fakeReq(), res)
  return { res, json: JSON.parse(res.out.body) }
}
const callCommand = async (command) => {
  const res = fakeRes()
  await routeHandler('/api/session-bridge/command')(
    fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-bridge-action': '1' },
      body: JSON.stringify(command)
    }),
    res
  )
  return { res, json: JSON.parse(res.out.body) }
}

await check('注册了看板 HTTP 路由与独立浮窗页', async () => {
  assert.ok(routeHandler('/api/session-bridge/state'), '缺少 GET /api/session-bridge/state')
  assert.ok(routeHandler('/api/session-bridge/command'), '缺少 POST /api/session-bridge/command')
  assert.ok(routeHandler('/session-bridge/app'), '缺少 GET /session-bridge/app')
  const appRes = { headers: {}, body: '', writeHead(code, headers) { this.code = code; this.headers = headers || {} }, end(text) { this.body = String(text || '') } }
  await routeHandler('/session-bridge/app')({ method: 'GET' }, appRes)
  assert.equal(appRes.code, 200)
  assert.match(appRes.body, /NEBULA/)
  assert.match(appRes.body, /空闲看板/)
  assert.match(appRes.body, /idleBoard/)
})

await check('GET state 返回规则/群组/会话/送达结构', async () => {
  const { res, json } = await callState()
  assert.equal(res.out.status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.version, '2.9.6')
  assert.ok(Array.isArray(json.rules) && json.rules.length >= 1)
  assert.ok(Array.isArray(json.groups))
  assert.ok(Array.isArray(json.sessions) && json.sessions.length >= 2)
  assert.equal(typeof json.deliveries, 'object')
  assert.ok(json.stats && json.stats.rules >= 1)
  assert.ok(typeof json.defaultWorkspace === 'string', 'state 应下发 defaultWorkspace 给面板兜底')
})

await check('智能成组：按共同话题跨工作目录返回建议（只含主会话）', async () => {
  const res = await callCommand({ action: 'group.suggest', payload: {} })
  assert.equal(res.json.ok, true)
  assert.ok(Array.isArray(res.json.suggestions), 'group.suggest 应返回 suggestions')
  assert.ok(res.json.suggestions.length >= 1, '标题共同关键词应给出建议')
  const suggestion = res.json.suggestions[0]
  assert.ok(suggestion.name && suggestion.reason)
  assert.equal(suggestion.kind, 'keyword', '不应再把「同一工作目录」当成成组依据')
  assert.match(String(suggestion.reason), /共同话题/, '建议应说明共同话题')
  assert.match(String(suggestion.reason), /跨 3 个工作目录/, '三个会话来自 3 个不同 cwd，应跨工作目录成组')
  assert.ok(Array.isArray(suggestion.sessionIds) && suggestion.sessionIds.length === 3)
  assert.ok(Array.isArray(suggestion.sessions) && suggestion.sessions[0].title)
  assert.ok(!suggestion.sessionIds.includes(subAgent.id), '子会话不应出现在成组建议里')
  assert.ok(suggestion.sessionIds.every((id) => [rootAgent.id, otherAgent.id, nonMemberAgent.id].includes(id)))
})

await check('POST 未带动作头被拒绝（CSRF 防护）', async () => {
  const res = fakeRes()
  await routeHandler('/api/session-bridge/command')(
    fakeReq({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    res
  )
  assert.equal(res.out.status, 403)
})

await check('面板命令：新建群组 + 加成员', async () => {
  const created = await callCommand({ action: 'group.create', payload: { name: '论文组', workspace: CWD, sessionIds: [rootAgent.id, otherAgent.id] } })
  assert.equal(created.json.ok, true, JSON.stringify(created.json))
  assert.ok(created.json.state.groups.some((group) => group.name === '论文组'))

  const added = await callCommand({ action: 'group.add', payload: { id: created.json.state.groups[0].id, sessionIds: [nonMemberAgent.id] } })
  assert.equal(added.json.ok, true)
  assert.ok(added.json.state.groups[0].sessionIds.includes(nonMemberAgent.id))
  await callCommand({ action: 'group.remove', payload: { id: created.json.state.groups[0].id, sessionIds: [nonMemberAgent.id] } })
})

await check('群组目标 + 带文件的交接进入「群组共享上下文」', async () => {
  const stateNow = await callState()
  const group = stateNow.json.groups.find((item) => item.name === '论文组')
  assert.ok(group, '缺少「论文组」')
  const updated = await callCommand({
    action: 'group.update',
    payload: { id: group.id, goal: '完成论文第 3 章（正文 + 图 + 参考文献）' }
  })
  assert.equal(updated.json.ok, true, JSON.stringify(updated.json))
  const withGoal = updated.json.state.groups.find((item) => item.id === group.id)
  assert.match(withGoal.goal, /完成论文第 3 章/)

  const shared = String(
    await share.execute(
      {
        title: '第 3 章交接',
        text: '正文初稿已在 output/ch3.docx，下一步补图；不要重写正文',
        kind: 'handoff',
        group: '论文组',
        files: 'output/ch3.docx, results/fig3.png'
      },
      { agent: rootAgent }
    )
  )
  assert.match(shared, /群组「论文组」/)
  const after = await callState()
  const handoff = after.json.rules.find((item) => item.title === '第 3 章交接')
  assert.ok(handoff, '交接条目应为群规矩')
  assert.equal(handoff.scope, 'group')
  assert.deepEqual(handoff.files, ['output/ch3.docx', 'results/fig3.png'])

  // 群成员（otherAgent）每一步的运行时上下文里应包含群组共享上下文：目标 + 交接 + 文件。
  const memberText = String(context.text({ agent: otherAgent }))
  assert.match(memberText, /群组共享上下文/)
  assert.match(memberText, /目标：完成论文第 3 章/)
  assert.match(memberText, /output\/ch3\.docx/)
  assert.match(memberText, /避免重复造轮子/)
  // 非成员看不到群共享上下文。
  const outsiderText = String(context.text({ agent: nonMemberAgent }))
  assert.ok(!outsiderText.includes('群组共享上下文'), '非群成员不应看到群共享上下文')
})

await check('群内请求：session_ask 唤醒目标会话，回复后通知请求方', async () => {
  const stateNow = await callState()
  const group = stateNow.json.groups.find((item) => item.name === '论文组')
  assert.ok(group, '缺少「论文组」')
  const askTool = toolByName.get('session_ask')
  captured.followups.length = 0
  // 默认禁止群发唤醒：不带 to 直接拒绝，且不唤醒任何人。
  const denied = String(
    await askTool.execute({ group: '论文组', text: '把第 3 章初稿发我，并说明还差什么' }, { agent: rootAgent })
  )
  assert.match(denied, /默认禁止群发唤醒/)
  assert.equal(captured.followups.length, 0, '未授权时不应唤醒任何人')
  // 未授权指定对象也拒绝。
  const unauthorized = String(
    await askTool.execute({ group: '论文组', text: '把初稿发我', to: otherAgent.id }, { agent: rootAgent })
  )
  assert.match(unauthorized, /没有唤醒权限/)
  assert.equal(captured.followups.length, 0)
  // 用户授权 rootAgent 可唤醒 otherAgent 后，指定 to 才能唤醒。
  await callCommand({ action: 'perm.grant', payload: { sessionId: rootAgent.id, targetId: otherAgent.id } })
  const ask = String(
    await askTool.execute({ group: '论文组', text: '把第 3 章初稿发我，并说明还差什么', to: otherAgent.id }, { agent: rootAgent })
  )
  assert.match(ask, /已向群组「论文组」发出探测/)
  assert.match(ask, /已唤醒 1 个在线会话/)
  assert.equal(captured.followups.length, 1, '应唤醒一个目标会话')
  assert.equal(captured.followups[0].sessionId, otherAgent.id)
  const probeMessage = String(captured.followups[0].message.content[0].text)
  assert.match(probeMessage, /群内请求/)
  assert.match(probeMessage, /请直接回答正文/, '探测消息要突出正文')
  const wokenSession = (await callState()).json.sessions.find((item) => item.id === otherAgent.id)
  assert.ok(wokenSession.style && wokenSession.persona, '首次唤醒应自动补全人格')
  assert.ok(!probeMessage.includes('replyTo='), '探测消息不应叮嘱复杂回复格式')

  const afterAsk = await callState()
  const request = afterAsk.json.rules.find((item) => item.kind === 'request')
  assert.ok(request, '看板应有 request 条目')
  assert.equal(request.status, 'open')
  assert.ok(request.mentions.index > -1 || request.mentions.length > 0, '请求应带 @ 名单便于界面显示')
  assert.deepEqual(request.requestTo, [otherAgent.id])

  captured.followups.length = 0
  const reply = String(
    await share.execute(
      {
        title: '第 3 章初稿位置',
        text: '初稿在 output/ch3.docx，图表还差 fig3',
        kind: 'handoff',
        group: '论文组',
        replyTo: request.id,
        files: 'output/ch3.docx'
      },
      { agent: otherAgent }
    )
  )
  assert.match(reply, /已回复请求/)
  assert.equal(captured.followups.length, 1, '回复后应唤醒请求方')
  assert.equal(captured.followups[0].sessionId, rootAgent.id)

  const afterReply = await callState()
  const answered = afterReply.json.rules.find((item) => item.id === request.id)
  assert.equal(answered.status, 'answered')
  assert.equal(answered.answeredBy, otherAgent.id)
  const replyEntry = afterReply.json.rules.find((item) => item.title === '第 3 章初稿位置')
  assert.equal(answered.replyId, replyEntry.id)
})

await check('group 参数发布：只有群成员能看到群规矩', async () => {
  const result = String(await share.execute({ title: '群规矩', text: '群内成员才看得到这条', group: '论文组' }, { agent: rootAgent }))
  assert.match(result, /群组「论文组」/)
  const memberText = String(context.text({ agent: otherAgent }))
  assert.match(memberText, /群规矩/, '群成员应看到群规矩')
  const outsiderText = String(context.text({ agent: nonMemberAgent }))
  assert.ok(!outsiderText.includes('群规矩'), '非群成员不应看到群规矩')
  const groupsOut = String(await board.execute({ action: 'groups' }, { agent: rootAgent }))
  assert.match(groupsOut, /论文组/)
})

await check('群聊 @成员发布工作：消息入群 + 只唤醒被 @ 的人', async () => {
  const stateNow = await callState()
  const group = stateNow.json.groups.find((item) => item.name === '论文组')
  assert.ok(group, '缺少「论文组」')
  captured.followups.length = 0
  const res = await callCommand({
    action: 'group.post',
    payload: { id: group.id, text: '@/@ 请把第 3 章图 3 重绘一下', mentionSessionIds: [otherAgent.id] }
  })
  assert.equal(res.json.ok, true, JSON.stringify(res.json))
  assert.equal(res.json.woken, 1, '只应唤醒被 @ 的会话')
  assert.equal(captured.followups.length, 1)
  assert.equal(captured.followups[0].sessionId, otherAgent.id)
  assert.match(String(captured.followups[0].message.content[0].text), /工作安排/)
  const rules = res.json.state.rules
  const note = rules.find((item) => item.hiddenFromChat !== true && item.mentions.includes(otherAgent.id))
  assert.ok(note, '群聊消息应记录 @ 名单')
  assert.equal(note.kind, 'command', '用户自己发的群消息应标记为命令，而不是经验')
  const hidden = rules.find(
    (item) => item.hiddenFromChat === true && item.kind === 'request' && item.requestTo.includes(otherAgent.id)
  )
  assert.ok(hidden, '应为被 @ 的成员创建定向 request（离线时下次运行也会收到）')

  captured.followups.length = 0
  const all = await callCommand({
    action: 'group.post',
    payload: { id: group.id, text: '@所有人 今晚前更新进度', mentionAll: true }
  })
  assert.equal(all.json.ok, true)
  // 多人 @ 走群任务：创建时只唤醒组长（1 人），成员等组长派活。
  assert.equal(all.json.woken, 1, '@所有人 创建任务时应只唤醒组长')
})

await check('群任务：只唤醒组长；组长派活时成员才被唤醒一次', async () => {
  const stateNow = await callState()
  const group = stateNow.json.groups.find((item) => item.name === '论文组')
  assert.ok(group, '缺少「论文组」')
  captured.followups.length = 0
  const res = await callCommand({
    action: 'group.post',
    payload: {
      id: group.id,
      text: '请大家审阅两篇论文后选组长给我总结',
      mentionAll: true,
      coordinatorId: otherAgent.id
    }
  })
  assert.equal(res.json.ok, true, JSON.stringify(res.json))
  assert.ok(res.json.task, '多人任务应返回 task 信息')
  const task = res.json.state.rules.find((item) => item.kind === 'task')
  assert.ok(task, '群聊应出现任务卡片')
  assert.equal(task.taskStatus, 'assigned')
  assert.ok(task.coordinator, '任务必须有唯一组长')
  assert.ok(task.assignees.length >= 1)
  assert.equal(res.json.task.coordinator.id, task.coordinator)
  assert.equal(task.coordinator, otherAgent.id, '面板指定的组长应生效')

  // 关键：任务创建时只唤醒组长，不直接唤醒成员（否则用户 @ + 组长再 @ = 执行两次）。
  assert.equal(captured.followups.length, 1, '创建任务时只应唤醒组长')
  assert.equal(captured.followups[0].sessionId, task.coordinator)
  assert.match(String(captured.followups[0].message.content[0].text), /唯一组长/)
  assert.match(String(captured.followups[0].message.content[0].text), /还没有被唤醒/)
  assert.ok(
    !(await callState()).json.rules.some(
      (item) => item.kind === 'request' && item.taskRole === 'member' && item.taskId === task.id
    ),
    '任务创建时不应给成员发 request（等组长派活）'
  )

  const granted = (await callState()).json.permissions[task.coordinator] || []
  assert.ok(granted.includes(task.assignees[0]), '应临时授权组长唤醒任务成员')

  // 组长派活：这次才唤醒成员，且请求自动归属任务。
  const askTool = toolByName.get('session_ask')
  captured.followups.length = 0
  const ask = String(
    await askTool.execute(
      { group: '论文组', text: '你负责第 2 节审阅，完成后把意见给我', to: task.assignees[0], mode: 'task' },
      { agent: otherAgent }
    )
  )
  assert.match(ask, /已向群组「论文组」发出任务分配/)
  assert.equal(captured.followups.length, 1, '组长派活时应唤醒成员一次')
  assert.equal(captured.followups[0].sessionId, task.assignees[0])
  const taskDispatchMessage = String(captured.followups[0].message.content[0].text)
  assert.match(taskDispatchMessage, /群任务/)
  assert.match(taskDispatchMessage, /replyTo=/, '任务分配才叮嘱如何回复')

  const memberRequest = (await callState()).json.rules.find(
    (item) => item.kind === 'request' && item.taskRole === 'member' && item.taskId === task.id
  )
  assert.ok(memberRequest, '组长派活应生成归属任务的成员 request')
  const delegating = (await callState()).json.rules.find((item) => item.id === task.id)
  assert.equal(delegating.taskStatus, 'delegating')

  captured.followups.length = 0
  const memberReply = String(
    await share.execute(
      {
        title: '成员审阅结果',
        text: '我审完第 2 节，发现 3 处问题',
        kind: 'handoff',
        group: '论文组',
        replyTo: memberRequest.id,
        files: 'report.md'
      },
      { agent: rootAgent }
    )
  )
  assert.match(memberReply, /组长已收到|已唤醒组长收集/)
  const collecting = (await callState()).json.rules.find((item) => item.id === task.id)
  assert.equal(collecting.taskStatus, 'collecting')
  assert.equal(captured.followups.length, 1, '成员提交后唤醒组长')

  // 成员提交过 ≠ 永久禁唤醒：下一轮修改任务必须还能派给他。
  captured.followups.length = 0
  const repeatAsk = String(
    await askTool.execute(
      { group: '论文组', text: '第二轮修改：按意见修改第 2 节', to: task.assignees[0], mode: 'task' },
      { agent: otherAgent }
    )
  )
  assert.match(repeatAsk, /已向群组「论文组」发出任务分配/)
  assert.equal(captured.followups.length, 1, '已提交过也应能接下一轮任务')
  const round2Request = (await callState()).json.rules.find(
    (item) =>
      item.kind === 'request' &&
      item.taskId === task.id &&
      item.taskRole === 'member' &&
      item.requestTo.includes(task.assignees[0]) &&
      item.status !== 'answered' &&
      !item.answeredBy
  )
  assert.ok(round2Request, '第二轮的请求应处于未回复状态')

  // 第二轮也要正常提交（否则群管理会因为「已有未回复分工」而不介入）。
  captured.followups.length = 0
  await share.execute(
    {
      title: '第二轮修改完成',
      text: '已按意见修改第 2 节与图 3',
      kind: 'handoff',
      group: '论文组',
      replyTo: round2Request.id
    },
    { agent: rootAgent }
  )
  assert.equal(captured.followups.length, 1, '第二轮提交应唤醒组长')

  const nudgeTool = toolByName.get('session_nudge')
  captured.followups.length = 0
  const nudgeOut = String(
    await nudgeTool.execute(
      { group: '论文组', to: task.assignees[0], text: '提醒：完成后记得交给组长' },
      { agent: otherAgent }
    )
  )
  assert.match(nudgeOut, /已插话/)
  assert.equal(captured.followups.length, 0, '插话不应唤醒')

  const coordinatorRequest = (await callState()).json.rules.find(
    (item) => item.kind === 'request' && item.taskRole === 'coordinator' && item.taskId === task.id
  )
  assert.ok(coordinatorRequest, '组长应有定向 request')

  // 设置群管理（AI）：复核后「需要修改」应自动交给群管理跟进。
  const managerSet = await callCommand({
    action: 'group.manager',
    payload: { id: group.id, managerId: rootAgent.id }
  })
  assert.equal(managerSet.json.ok, true, JSON.stringify(managerSet.json))
  const groupWithManager = managerSet.json.state.groups.find((item) => item.id === group.id)
  assert.equal(groupWithManager.managerSessionId, rootAgent.id)
  const managerGrants = managerSet.json.state.permissions[rootAgent.id] || []
  assert.ok(managerGrants.includes(otherAgent.id), '群管理应被授权唤醒群员')

  captured.followups.length = 0
  const finalReply = String(
    await share.execute(
      {
        title: '组长汇总',
        text: '复核结果：需要修改第 2 节与图 3，请按意见修改',
        kind: 'handoff',
        group: '论文组',
        replyTo: coordinatorRequest.id
      },
      { agent: otherAgent }
    )
  )
  assert.match(finalReply, /任务已标记为完成/)
  assert.match(finalReply, /已通知群管理/)
  assert.equal(captured.followups.length, 1, '应通知群管理')
  assert.equal(captured.followups[0].sessionId, rootAgent.id)
  assert.match(String(captured.followups[0].message.content[0].text), /群管理/)
  assert.match(String(captured.followups[0].message.content[0].text), /需要修改项|修改/)
  const done = (await callState()).json.rules.find((item) => item.id === task.id)
  assert.equal(done.taskStatus, 'done')

  // 群管理梳理规矩：只有群管理能写；聊天记录不算规矩，规矩单独 curated 层。
  const ruleTool = toolByName.get('group_rule')
  const deniedRule = String(
    await ruleTool.execute({ action: 'set', group: '论文组', title: '越权规矩', text: '不应允许' }, { agent: otherAgent })
  )
  assert.match(deniedRule, /只有本群的群管理/)
  const setRule = String(
    await ruleTool.execute(
      {
        action: 'set',
        group: '论文组',
        title: '复核结论沉淀',
        text: '每轮复核只保留最多 3 条稳定结论；聊天记录与单次催收不算规矩。'
      },
      { agent: rootAgent }
    )
  )
  assert.match(setRule, /已写入群「论文组」的规矩/)
  const stateAfterRule = await callState()
  const curatedGroup = stateAfterRule.json.groups.find((item) => item.id === group.id)
  assert.ok(Array.isArray(curatedGroup.curatedRules) && curatedGroup.curatedRules.length >= 1, '群状态应包含整理后的规矩')
  assert.ok(
    stateAfterRule.json.rules.some(
      (item) => item.curated === true && item.groupId === group.id && item.title === '复核结论沉淀'
    ),
    'curated 标记应写入规则条目'
  )
  const listRules = String(await ruleTool.execute({ action: 'list', group: '论文组' }, { agent: otherAgent }))
  assert.match(listRules, /复核结论沉淀/)

  // 不传 mode 时按正文意图自动判断：请人做具体工作 → 任务；问进度 → 探测。
  captured.followups.length = 0
  const autoTaskAsk = String(
    await askTool.execute(
      { group: '论文组', text: '请对最新版做最后一轮独立门禁，核验四项并回报', to: otherAgent.id },
      { agent: rootAgent }
    )
  )
  assert.match(autoTaskAsk, /发出任务分配/)
  assert.match(String(captured.followups[0].message.content[0].text), /replyTo=/)

  captured.followups.length = 0
  const autoProbeAsk = String(
    await askTool.execute(
      { group: '论文组', text: '现在进度到哪一步了？', to: otherAgent.id },
      { agent: rootAgent }
    )
  )
  assert.match(autoProbeAsk, /发出探测/)
  assert.ok(!String(captured.followups[0].message.content[0].text).includes('replyTo='))
})

await check('空闲看板：open request → busy，回答后回 idle（v2.9.0）', async () => {
  const stateNow = await callState()
  const rootRow = stateNow.json.sessions.find((session) => session.id === rootAgent.id)
  const otherRow = stateNow.json.sessions.find((session) => session.id === otherAgent.id)
  assert.ok(rootRow, 'state.sessions 应有 rootAgent')
  assert.equal(typeof rootRow.availability, 'string', 'state.sessions 应带 availability 字段')
  assert.equal(rootRow.availability, 'busy', '还有未回答的群管理 request，rootAgent 应为 busy')
  assert.ok(rootRow.openRequestCount >= 1, 'busy 时应记录 openRequestCount')
  assert.ok(rootRow.currentTask && rootRow.currentTask.title, 'busy 时应记录 currentTask')
  assert.equal(otherRow.availability, 'busy', 'otherAgent 也有未回答请求')
  // 回答（answer）所有发给 rootAgent 的 open request → 应该回到 idle。
  const openRequests = stateNow.json.rules.filter(
    (item) =>
      item.kind === 'request' &&
      item.status !== 'answered' &&
      !item.answeredBy &&
      Array.isArray(item.requestTo) &&
      item.requestTo.includes(rootAgent.id)
  )
  assert.ok(openRequests.length >= 1, '应能找到发给 rootAgent 的 open request')
  for (const request of openRequests) {
    const replied = String(
      await share.execute(
        {
          title: '收尾：' + request.title,
          text: '已按请求处理完毕，本会话回到空闲',
          kind: 'handoff',
          group: '论文组',
          replyTo: request.id
        },
        { agent: rootAgent }
      )
    )
    assert.match(replied, /已回复请求/)
  }
  const afterState = await callState()
  const rootAfter = afterState.json.sessions.find((session) => session.id === rootAgent.id)
  assert.equal(rootAfter.availability, 'idle', 'answer 后应回到 idle')
  assert.equal(rootAfter.openRequestCount, 0)
  assert.ok(rootAfter.lastSubmittedAt > 0, '应记录 lastSubmittedAt')
})

await check('积分与社交：任务积分、点赞、群讨论', async () => {
  const stateNow = await callState()
  const group = stateNow.json.groups.find((item) => item.name === '论文组')
  assert.ok(group, '缺少「论文组」')
  assert.ok(Array.isArray(stateNow.json.reputation), 'state 应包含积分榜')
  const otherRep = stateNow.json.reputation.find((item) => item.sessionId === otherAgent.id)
  assert.ok(otherRep && otherRep.points > 0, '完成任务/被点赞应有积分')

  const likeTool = toolByName.get('session_like')
  const beforePoints = (await callState()).json.reputation.find((item) => item.sessionId === otherAgent.id).points
  const likeOut = String(
    await likeTool.execute({ group: '论文组', to: otherAgent.id, text: '这轮很稳' }, { agent: rootAgent })
  )
  assert.match(likeOut, /点赞/)
  const afterPoints = (await callState()).json.reputation.find((item) => item.sessionId === otherAgent.id).points
  assert.equal(afterPoints, beforePoints + 2, '点赞应 +2 积分')
  const relationState = (await callState()).json.relations
  assert.ok(Array.isArray(relationState), 'state 应包含关系值')
  assert.ok(
    relationState.some(
      (pair) =>
        [pair.a, pair.b].includes(rootAgent.id) &&
        [pair.a, pair.b].includes(otherAgent.id) &&
        pair.score >= 2
    ),
    '点赞应建立关系值'
  )

  captured.followups.length = 0
  const discussion = await callCommand({
    action: 'group.discuss',
    payload: { id: group.id, topic: '大家聊聊这轮有什么经验' }
  })
  assert.equal(discussion.json.ok, true, JSON.stringify(discussion.json))
  assert.ok(discussion.json.woken >= 1, '讨论应唤醒群员')
  assert.ok(discussion.json.state.rules.some((item) => item.kind === 'chat' && /讨论/.test(item.title)))
  const discussMessage = String(captured.followups[0].message.content[0].text)
  assert.match(discussMessage, /讨论/)
  assert.ok(!discussMessage.includes('replyTo='), '讨论不是任务，不应带交付说明')

  // 成员要能真的发言：session_share kind=chat 必须合法并进入群聊。
  const chatShare = String(
    await share.execute({ title: '交流：我先说一句', text: '我觉得这轮可以互相点赞。', kind: 'chat', group: '论文组' }, { agent: otherAgent })
  )
  assert.match(chatShare, /已发布/)
  const chatEntry = (await callState()).json.rules.find((item) => item.kind === 'chat' && item.title === '交流：我先说一句')
  assert.ok(chatEntry, '交流消息应写入群聊')

  // 活跃度仪表盘 + 茶话会
  const activityState = (await callState()).json.activity
  assert.ok(Array.isArray(activityState), 'state 应包含活跃度')
  const groupActivity = activityState.find((item) => item.groupId === group.id)
  assert.ok(groupActivity && groupActivity.days.length === 7, '活跃度应有 7 天数据')
  const teaResult = await callCommand({ action: 'activity.tea', payload: { id: group.id } })
  assert.equal(teaResult.json.ok, true, JSON.stringify(teaResult.json))
  assert.ok(teaResult.json.topic, '茶话会应有话题')
  assert.ok(
    (await callState()).json.rules.some((item) => item.kind === 'chat' && /^茶话会：/.test(item.title)),
    '茶话会应写入群聊'
  )
  const sparkResult = await callCommand({ action: 'activity.spark', payload: { id: group.id } })
  assert.equal(sparkResult.json.ok, true, JSON.stringify(sparkResult.json))
  assert.ok(sparkResult.json.targetId, '自发表达应点到一位成员')

  // 身份：agent 可以给自己起 ID/头像，且同名自动去重。
  const identityTool = toolByName.get('session_identity')
  const cardOut = String(await identityTool.execute({ action: 'set', handle: '星星', avatar: '🦊' }, { agent: rootAgent }))
  assert.match(cardOut, /名片已更新/)
  const afterCard = (await callState()).json.sessions.find((item) => item.id === rootAgent.id)
  assert.equal(afterCard.handle, '星星')
  assert.equal(afterCard.avatar, '🦊')
  const skillsCard = String(
    await identityTool.execute(
      {
        action: 'set',
        handle: '星星',
        avatar: '🦊',
        role: '审稿人',
        skills: ['审稿', '写作'],
        style: '严谨',
        persona: '喜欢用数据说话，偶尔吐槽'
      },
      { agent: rootAgent }
    )
  )
  assert.match(skillsCard, /擅长/)
  const rootedSession = (await callState()).json.sessions.find((item) => item.id === rootAgent.id)
  assert.deepEqual(rootedSession.skills, ['审稿', '写作'])
  assert.equal(rootedSession.style, '严谨')
  assert.match(rootedSession.persona, /数据说话/)
  const duplicate = String(await identityTool.execute({ action: 'set', handle: '星星', avatar: '🐼' }, { agent: otherAgent }))
  assert.match(duplicate, /星星-2/, '重名 ID 应自动加后缀')
  const panelCard = await callCommand({
    action: 'identity.set',
    payload: { sessionId: otherAgent.id, handle: '月亮', avatar: '🌙', role: '审稿人' }
  })
  assert.equal(panelCard.json.ok, true, JSON.stringify(panelCard.json))
  const cardSession = (await callState()).json.sessions.find((item) => item.id === otherAgent.id)
  assert.equal(cardSession.handle, '月亮')
  assert.equal(cardSession.role, '审稿人')

  // 输入框内嵌 @：正文里的 @handle 自动识别为被点名成员（一句话拆任务）。
  const inlinePost = await callCommand({
    action: 'group.post',
    payload: { id: group.id, text: '这个你来做@月亮 你去做这个' }
  })
  assert.equal(inlinePost.json.ok, true, JSON.stringify(inlinePost.json))
  const inlineEntry = inlinePost.json.state.rules.find(
    (item) =>
      item.kind === 'command' &&
      /这个你来做@月亮/.test(String(item.text || '')) &&
      Array.isArray(item.mentions)
  )
  assert.ok(inlineEntry && inlineEntry.mentions.includes(otherAgent.id), '内嵌 @ 应解析出被点名成员')

  // 群管理沉淀 SKILL：自己就能落库，不需要工作区写权限。
  const skillTool = toolByName.get('group_skill')
  const deniedSkill = String(
    await skillTool.execute({ action: 'save', group: '论文组', name: '越权技能', content: '# x' }, { agent: otherAgent })
  )
  assert.match(deniedSkill, /只有本群的群管理/)
  const savedSkill = String(
    await skillTool.execute(
      { action: 'save', group: '论文组', name: '测试技能', description: '测试用', content: '# 测试技能\n- 第一步', writeProject: false },
      { agent: rootAgent }
    )
  )
  assert.match(savedSkill, /已沉淀 SKILL/)
  const skillsState = (await callState()).json.skills
  assert.ok(Array.isArray(skillsState) && skillsState.some((item) => item.name === '测试技能'), 'state 应包含技能库')
})

await check('送达追踪：看到规矩的会话被记录', async () => {
  const { json } = await callState()
  const groupRule = json.rules.find((rule) => rule.title === '群规矩')
  assert.ok(groupRule, '应有群规矩')
  const delivered = json.deliveries[groupRule.id] || []
  assert.ok(delivered.some((item) => item.sessionId === otherAgent.id && item.deliveredAt > 0), '群成员应有送达记录')
})

await check('面板新建工作区规矩：无 workspace 时自动兜底', async () => {
  const created = await callCommand({
    action: 'rule.create',
    payload: {
      title: '面板兜底规矩',
      text: '没有 workspace 也应能创建',
      kind: 'handoff',
      scope: 'workspace',
      files: 'output/a.docx, results/b.png'
    }
  })
  assert.equal(created.json.ok, true, JSON.stringify(created.json))
  const rule = created.json.state.rules.find((item) => item.title === '面板兜底规矩')
  assert.ok(rule, '应有新规矩')
  assert.ok(rule.workspace, '应在 host 侧自动补上 workspace')
  assert.deepEqual(rule.files, ['output/a.docx', 'results/b.png'], '面板发布应保留 files')
  await callCommand({ action: 'rule.remove', payload: { id: rule.id } })
})

await check('接受追踪：面板/ack 都记录 acceptedAt', async () => {
  const { json } = await callState()
  const rule = json.rules.find((item) => item.title === '群规矩')
  const accepted = await callCommand({ action: 'rule.accept', payload: { id: rule.id, sessionId: otherAgent.id } })
  assert.equal(accepted.json.ok, true)
  const after = accepted.json.state.deliveries[rule.id].find((item) => item.sessionId === otherAgent.id)
  assert.ok(after.acceptedAt > 0, '面板接受后应有 acceptedAt')

  // 再点一次 = 取消接受（accepted:false）
  const unaccepted = await callCommand({ action: 'rule.accept', payload: { id: rule.id, sessionId: otherAgent.id, accepted: false } })
  assert.equal(unaccepted.json.ok, true)
  const cleared = unaccepted.json.state.deliveries[rule.id].find((item) => item.sessionId === otherAgent.id)
  assert.equal(cleared.acceptedAt, 0, '取消接受后 acceptedAt 应清 0')

  const acked = String(await board.execute({ action: 'ack', id: rule.id }, { agent: rootAgent }))
  assert.match(acked, /已标记本会话/)
  const state2 = await callState()
  const rootRecord = (state2.json.deliveries[rule.id] || []).find((item) => item.sessionId === rootAgent.id)
  assert.ok(rootRecord && rootRecord.acceptedAt > 0, 'ack 后应有 acceptedAt')
})

await check('面板命令：删除规矩与群组', async () => {
  const state = await callState()
  const groupRule = state.json.rules.find((rule) => rule.title === '群规矩')
  const removed = await callCommand({ action: 'rule.remove', payload: { id: groupRule.id } })
  assert.equal(removed.json.ok, true)
  assert.ok(!removed.json.state.rules.some((rule) => rule.title === '群规矩'))
  const group = removed.json.state.groups.find((item) => item.name === '论文组')
  const deleted = await callCommand({ action: 'group.delete', payload: { id: group.id } })
  assert.equal(deleted.json.ok, true)
  assert.ok(!deleted.json.state.groups.some((item) => item.name === '论文组'))
})

await check('插件启动凭证写入正确（工具/注册/版本/API）', () => {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  assert.equal(receipt.version, '2.9.6')
  assert.deepEqual(receipt.tools.slice().sort(), ['group_member', 'group_recruit', 'group_rule', 'group_skill', 'session_ask', 'session_board', 'session_directory', 'session_discuss', 'session_identity', 'session_interrupt', 'session_like', 'session_nudge', 'session_profile', 'session_retract', 'session_share', 'session_urgent'])
  assert.deepEqual(receipt.failedTools, [])
  assert.equal(receipt.registration.section, true)
  assert.equal(receipt.registration.context, true)
  assert.equal(receipt.registration.api, true)
  assert.ok(receipt.panel && typeof receipt.panel.clientPresent === 'boolean')
})

await check('挂了 session/event 自动捕获监听', () => {
  assert.ok(captured.listeners.some((item) => item.name === 'session/event'))
})

await check('session_profile：申报更新 / 查询 / 目录', async () => {
  const profileTool = toolByName.get('session_profile')
  const updated = String(
    await profileTool.execute(
      {
        action: 'update',
        summary: '我在做论文第一篇：实验与数据图表',
        direction: '论文/实验',
        assets: 'output/ch1.docx, results/fig1.png',
        needs: '需要第二篇的仿真图'
      },
      { agent: rootAgent }
    )
  )
  assert.match(updated, /已更新本会话申报材料/)
  const show = String(await profileTool.execute({ action: 'show' }, { agent: rootAgent }))
  assert.match(show, /论文第一篇/)
  const directory = String(await profileTool.execute({ action: 'directory' }, { agent: otherAgent }))
  assert.match(directory, /论文第一篇/)

  const stateNow = await callState()
  assert.ok(stateNow.json.profiles[rootAgent.id], 'state 应包含申报材料')
  assert.match(stateNow.json.profiles[rootAgent.id].summary, /论文第一篇/)
  const sessionRow = stateNow.json.sessions.find((session) => session.id === rootAgent.id)
  assert.equal(sessionRow.hasProfile, true)
  assert.ok(stateNow.json.stats.profiles >= 1)
})

await check('新会话会主动询问是否注册经验桥', async () => {
  const listener = captured.listeners.find((item) => item.name === 'agent/created')
  assert.ok(listener, '应监听 agent/created')
  const fakeSessionId = 'session-newask0001'
  const fakeAgent = {
    id: fakeSessionId,
    status: 'idle',
    session: { id: fakeSessionId, header: { cwd: CWD, createdAt: Date.now() } },
    followup(message) {
      captured.followups.push({ sessionId: this.id, message })
    }
  }
  captured.followups.length = 0
  const originalGet = ctx.agents.get
  ctx.agents.get = (id) => (id === fakeSessionId ? fakeAgent : originalGet(id))
  try {
    listener.listener({ agent: fakeAgent })
    await new Promise((resolve) => setTimeout(resolve, 450))
  } finally {
    ctx.agents.get = originalGet
  }
  assert.equal(captured.followups.length, 1, '新会话应收到一条询问消息')
  assert.equal(captured.followups[0].sessionId, fakeSessionId)
  assert.match(String(captured.followups[0].message.content[0].text), /要不要把本会话注册到经验桥/)
})

console.log('== E. 世界聊天：按申报匹配成员 / 无匹配时新建')
await check('world.post：按申报匹配到成员并唤醒；请求带 @ 名单', async () => {
  captured.followups.length = 0
  const world = await callCommand({
    action: 'world.post',
    payload: { text: '论文 实验 数据 图表：把图 3 改成学术风格并导出' }
  })
  assert.equal(world.json.ok, true, JSON.stringify(world.json))
  assert.ok(Array.isArray(world.json.assigned) && world.json.assigned.length >= 1, '应匹配到已申报成员')
  assert.equal(world.json.assigned[0].id, rootAgent.id)
  assert.ok(world.json.messageId, '世界消息 id')
  const worldEntries = world.json.state.world
  assert.ok(worldEntries.some((entry) => entry.id === world.json.messageId), '世界聊天应有这条任务')
  assert.ok(worldEntries[0].mentions.length >= 1, '世界任务应带 @ 名单')
  const hidden = world.json.state.rules.find(
    (item) => item.hiddenFromChat === true && item.requestTo.includes(rootAgent.id)
  )
  assert.ok(hidden, '应为被派成员创建任务请求')
  assert.equal(captured.followups.length, 1, '应唤醒匹配成员')
  assert.equal(captured.followups[0].sessionId, rootAgent.id)
})

await check('世界任务自动创建前进入待复核，可驳回', async () => {
  const text = 'zzzz-approval-gate-' + Date.now() + ' 独立新任务'
  const first = await callCommand({ action: 'world.post', payload: { text } })
  assert.equal(first.json.ok, true, JSON.stringify(first.json))
  assert.equal(first.json.pendingApproval, true, '自动建会话前应进入待复核')
  const state = await callState()
  const pending = (state.json.approvals || []).find((item) => item.text === text)
  assert.ok(pending, 'state.approvals 应有待复核记录')
  assert.ok(pending.workspacePath !== undefined, '复核记录应带工作区字段')
  const rejected = await callCommand({ action: 'approval.reject', payload: { id: pending.id } })
  assert.equal(rejected.json.ok, true, JSON.stringify(rejected.json))
})

await check('world.post：无申报匹配时走新建会话（桩环境无 agents.create → 可读降级）', async () => {
  // 契约测试专门关闭复核闸门，验证原始创建失败路径
  await callCommand({ action: 'config.update', payload: { patch: { approveAutoCreate: false } } })
  const world = await callCommand({ action: 'world.post', payload: { text: 'zzzz-no-match-qqqq 的任务' } })
  assert.equal(world.json.ok, true, JSON.stringify(world.json))
  assert.ok(world.json.createError, '桩环境应返回新建会话失败原因，而不是抛错')
})

await check('世界任务：正文 @ 直接派给指定成员', async () => {
  captured.followups.length = 0
  const result = await callCommand({
    action: 'world.post',
    payload: { text: '@session-aaaa0001 帮我检查一下这段说明' }
  })
  assert.equal(result.json.ok, true, JSON.stringify(result.json))
  assert.equal(result.json.route, 'existing')
  assert.equal(result.json.router.engine, 'mentions')
  assert.ok(result.json.assigned.some((item) => item.id === rootAgent.id), '应派给被 @ 的成员')
  assert.ok(captured.followups.length >= 1, '应唤醒被 @ 的会话')
})

await check('世界路由：明确「全新」直接新建；world.route 只分析不执行', async () => {
  const forced = await callCommand({
    action: 'world.post',
    payload: { text: '全新：做一个完全独立的游戏原型，从零开始' }
  })
  assert.equal(forced.json.ok, true, JSON.stringify(forced.json))
  assert.equal(forced.json.forceNew, true, '“全新”应被识别')
  assert.equal(forced.json.route, 'new')
  assert.ok(forced.json.createError, '桩宿主没有 agents.create，应给出可读错误')

  const routeOnly = await callCommand({
    action: 'world.route',
    payload: { text: '论文实验数据图表' }
  })
  assert.equal(routeOnly.json.ok, true)
  assert.ok(routeOnly.json.decision, '应返回路由决策')
  assert.ok(['existing', 'new'].includes(routeOnly.json.decision.route))
})

await check('世界任务重复发送去重（20 秒内同文本）', async () => {
  const text = 'aaaa-bbbb-cccc 世界去重测试任务'
  const first = await callCommand({ action: 'world.post', payload: { text } })
  const second = await callCommand({ action: 'world.post', payload: { text } })
  assert.equal(first.json.ok, true)
  assert.equal(second.json.ok, true)
  assert.equal(second.json.duplicate, true, '第二次相同发送应被去重')
  assert.equal(second.json.messageId, first.json.messageId)
  const world = (await callState()).json.world.filter((entry) => entry.text === text)
  assert.equal(world.length, 1, '世界里只应出现一条')
})

console.log('== E. 定向注入（v0.7）：只注入与本人有关的互动')
const targetedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-bridge-targeted-'))
fs.writeFileSync(
  path.join(targetedDir, 'groups.json'),
  JSON.stringify(
    {
      version: 1,
      groups: [
        {
          id: 'g-target',
          name: '定向群',
          workspace: CWD,
          goal: '',
          sessionIds: [rootAgent.id, otherAgent.id],
          createdAt: 0,
          updatedAt: 0
        }
      ]
    },
    null,
    2
  ),
  'utf8'
)
const targetTs = Date.now()
fs.writeFileSync(
  path.join(targetedDir, 'board.jsonl'),
  JSON.stringify({
    op: 'add',
    id: 'n-target-req',
    entry: {
      id: 'n-target-req',
      kind: 'request',
      scope: 'group',
      groupId: 'g-target',
      workspace: CWD,
      author: otherAgent.id,
      title: '请提供第一篇数据',
      text: '把实验数据发我',
      files: [],
      requestTo: [rootAgent.id],
      status: 'open',
      ts: targetTs,
      expiresAt: 0
    },
    ts: targetTs
  }) +
    '\n' +
    JSON.stringify({
      op: 'add',
      id: 'n-target-nudge',
      entry: {
        id: 'n-target-nudge',
        kind: 'note',
        scope: 'group',
        groupId: 'g-target',
        workspace: CWD,
        author: otherAgent.id,
        title: '催收：成员提交',
        text: '请把结果交给组长',
        files: [],
        requestTo: [rootAgent.id],
        mentions: [rootAgent.id],
        hiddenFromChat: true,
        nudge: true,
        ts: targetTs,
        expiresAt: 0
      },
      ts: targetTs
    }) +
    '\n',
  'utf8'
)

const captured2 = { tools: [], sections: [], contexts: [], listeners: [] }
const ctx2 = {
  tools: {
    register(definition) {
      captured2.tools.push(definition)
      return () => {}
    }
  },
  systemPrompt: {
    section(options) {
      captured2.sections.push(options)
      return () => {}
    },
    context(options) {
      captured2.contexts.push(options)
      return () => {}
    }
  },
  agents: {
    roots: () => [rootAgent, otherAgent],
    list: () => [rootAgent, otherAgent, nonMemberAgent, subAgent],
    get: (id) => [rootAgent, otherAgent, nonMemberAgent, subAgent].find((agent) => agent.id === id)
  },
  sessions: { list: () => [rootAgent.session, otherAgent.session] },
  get(name) {
    if (name === 'sessionQuery') return fakeSessionQuery
    return undefined
  },
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  on() {
    return () => {}
  },
  logger: { info() {}, warn() {}, error() {} }
}
plugin.apply(ctx2, { boardDir: targetedDir, injectMode: 'targeted', autoPrompt: true })

await check('定向模式：未申报提示 + 只有被问到的成员收到互动', async () => {
  const provider = captured2.contexts.find((item) => item.name === 'session-bridge:board')
  assert.ok(provider, '应注册运行时上下文')
  const rootText = String(provider.text({ agent: rootAgent }))
  const otherText = String(provider.text({ agent: otherAgent }))
  assert.match(rootText, /未申报/, '未申报的会话应有提示')
  assert.match(rootText, /群内互动/)
  assert.match(rootText, /请提供第一篇数据/, '发给 rootAgent 的请求应注入')
  assert.match(rootText, /插话·催收/, '插话提醒也应注入（只给被提醒的人）')
  assert.ok(!otherText.includes('群内互动'), '没被问到的成员不应收到群互动注入')
  assert.match(otherText, /未申报/)
})

await check('定向模式：声明的会话不再注入；互动只注入一次', async () => {
  const provider = captured2.contexts.find((item) => item.name === 'session-bridge:board')
  const profileTool2 = captured2.tools.find((tool) => tool.name === 'session_profile')
  await profileTool2.execute({ action: 'skip' }, { agent: otherAgent })
  const otherText = String(provider.text({ agent: otherAgent }))
  assert.equal(otherText, '', '申报跳过后且无互动 → 零注入')
  const rootAgain = String(provider.text({ agent: rootAgent }))
  assert.ok(!rootAgain.includes('群内互动'), '同一请求只注入一次')
})

await check('面板设置：config.update 写入 settings.json 并立即生效', async () => {
  const res = await callCommand({
    action: 'config.update',
    payload: {
      patch: {
        router: { provider: 'test-provider', model: 'free-test-model' },
        askOnCreate: false,
        autoPrompt: false,
        injectMode: 'targeted'
      }
    }
  })
  assert.equal(res.json.ok, true, JSON.stringify(res.json))
  assert.equal(res.json.state.config.provider, 'test-provider')
  assert.equal(res.json.state.config.model, 'free-test-model')
  assert.equal(res.json.state.config.askOnCreate, false)
  const saved = JSON.parse(fs.readFileSync(path.join(boardDir, 'settings.json'), 'utf8'))
  assert.equal(saved.router.provider, 'test-provider')
  assert.equal(saved.router.model, 'free-test-model')
  assert.equal(saved.askOnCreate, false)
  assert.equal(saved.injectMode, 'targeted')
})

// ---------------------------------------------------------------- F. 通讯录与稳健会话引用解析（v2.8.1）
// 复现场景：组长拿到短 id「4f51e9」，实际会话是 session-4f51e99f-…；
// 旧版只支持「完整 id / startsWith / 标题包含」，所以 4f51e9 解析不到、只能退回给值班员。
console.log('== F. 通讯录与稳健会话引用解析（v2.8.1）')
const contactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-bridge-contacts-'))
const UUID_A = 'session-4f51e99f-91a8-4255-b3cf-e71e32323230'
const UUID_B = 'session-77aa1111-0000-4000-8000-aaaaaaaaaaaa'
const UUID_C = 'session-77aa2222-0000-4000-8000-bbbbbbbbbbbb'
const DIR_ROOT = 'session-b0b0b0b0'
const contactCaptured = { tools: [], sections: [], contexts: [], listeners: [], routes: [], followups: [] }
const contactAgent = (id) => ({
  id,
  status: 'idle',
  session: { id, header: { cwd: CWD, createdAt: 1 } },
  followup(message) {
    contactCaptured.followups.push({ sessionId: this.id, message })
  }
})
const dirRoot = contactAgent(DIR_ROOT)
const uuidAgentA = contactAgent(UUID_A)
const uuidAgentB = contactAgent(UUID_B)
const uuidAgentC = contactAgent(UUID_C)
const contactAgents = [dirRoot, uuidAgentA, uuidAgentB, uuidAgentC]
const contactTitles = {
  [DIR_ROOT]: '主编排会话',
  [UUID_A]: 'shoot_game 性能优化',
  [UUID_B]: '审稿任务-上',
  [UUID_C]: '审稿任务-下'
}
const fakeSessionQuery3 = {
  async listSessions() {
    return contactAgents.map((agent) => ({ header: agent.session.header, live: true, persisted: true, formatStatus: 'current' }))
  },
  async readTitleSnapshots(ids) {
    return ids.map((id) => ({
      sessionId: id,
      status: 'fulfilled',
      value: { session: { id }, ...(contactTitles[id] ? { title: { title: contactTitles[id] } } : {}) }
    }))
  }
}
fs.writeFileSync(
  path.join(contactDir, 'identities.json'),
  JSON.stringify(
    {
      sessions: {
        [DIR_ROOT]: { sessionId: DIR_ROOT, handle: '值班员', avatar: '🛰️' },
        [UUID_A]: { sessionId: UUID_A, handle: '远山', avatar: '🦊' },
        [UUID_B]: { sessionId: UUID_B, handle: '小北', avatar: '🐼' },
        [UUID_C]: { sessionId: UUID_C, handle: '小南', avatar: '🐯' }
      }
    },
    null,
    2
  ),
  'utf8'
)
fs.writeFileSync(
  path.join(contactDir, 'groups.json'),
  JSON.stringify(
    {
      version: 1,
      groups: [
        {
          id: 'g-dir',
          name: '性能组',
          workspace: CWD,
          goal: '性能优化交付',
          managerSessionId: DIR_ROOT,
          sessionIds: [DIR_ROOT, UUID_A, UUID_B, UUID_C],
          createdAt: 0,
          updatedAt: 0
        }
      ]
    },
    null,
    2
  ),
  'utf8'
)
fs.writeFileSync(
  path.join(contactDir, 'permissions.json'),
  JSON.stringify({ grants: { [DIR_ROOT]: [UUID_A, UUID_B, UUID_C] } }, null, 2),
  'utf8'
)
const fakeWebServer3 = {
  register(route) {
    contactCaptured.routes.push(route)
    return () => {}
  }
}
const ctx3 = {
  tools: {
    register(definition) {
      contactCaptured.tools.push(definition)
      return () => {}
    }
  },
  systemPrompt: {
    section(options) {
      contactCaptured.sections.push(options)
      return () => {}
    },
    context(options) {
      contactCaptured.contexts.push(options)
      return () => {}
    }
  },
  agents: {
    roots: () => contactAgents,
    list: () => contactAgents,
    get: (id) => contactAgents.find((agent) => agent.id === id)
  },
  sessions: { list: () => contactAgents.map((agent) => agent.session) },
  get(name) {
    if (name === 'sessionQuery') return fakeSessionQuery3
    if (name === 'webServer') return fakeWebServer3
    return undefined
  },
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  on() {
    return () => {}
  },
  logger: { info() {}, warn() {}, error() {} }
}
plugin.apply(ctx3, { boardDir: contactDir, injectMode: 'broadcast', autoPrompt: false })
const toolByName3 = new Map(contactCaptured.tools.map((tool) => [tool.name, tool]))
const routeHandler3 = (path) => contactCaptured.routes.find((route) => route.path === path)?.handler
const callState3 = async () => {
  const res = fakeRes()
  await routeHandler3('/api/session-bridge/state')(fakeReq(), res)
  return { res, json: JSON.parse(res.out.body) }
}
const callCommand3 = async (command) => {
  const res = fakeRes()
  await routeHandler3('/api/session-bridge/command')(
    fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-bridge-action': '1' },
      body: JSON.stringify(command)
    }),
    res
  )
  return { res, json: JSON.parse(res.out.body) }
}

await check('session_directory：通讯录字段齐全，支持 group/query 过滤', async () => {
  const dirTool = toolByName3.get('session_directory')
  assert.ok(dirTool, '缺少 session_directory 工具')
  const all = String(await dirTool.execute({}, { agent: dirRoot }))
  assert.match(all, /跨会话通讯录（4 个主会话）/)
  assert.ok(all.includes('contactId=4f51e99f'), '应包含 contactId')
  assert.ok(all.includes(`fullId=${UUID_A}`), '应包含完整 id')
  assert.match(all, /handle=远山/)
  assert.match(all, /title=shoot_game 性能优化/)
  assert.match(all, /live=yes/)
  assert.match(all, /status=idle/)
  assert.match(all, /群组=性能组/)
  assert.match(all, /worldEligible=yes/)
  assert.match(all, /cwd=/)
  const grouped = String(await dirTool.execute({ group: '性能组' }, { agent: dirRoot }))
  assert.match(grouped, /群「性能组」通讯录（4 个主会话）/)
  const queried = String(await dirTool.execute({ query: '4f51e9' }, { agent: dirRoot }))
  assert.ok(queried.includes('4f51e99f'))
  assert.ok(!queried.includes(UUID_B), 'query 应过滤掉不匹配的会话')
  const byHandle = String(await dirTool.execute({ query: '远山' }, { agent: dirRoot }))
  assert.ok(byHandle.includes('4f51e99f'), 'query 支持 handle')
})

await check('session_ask：短 id / contactId / 无前缀 id / handle / 标题 / 唯一后缀都能解析', async () => {
  const askTool3 = toolByName3.get('session_ask')
  assert.ok(askTool3, '缺少 session_ask')
  const refs = [
    '4f51e9', // 短 id（6 位压缩前缀，旧版这里解析失败）
    '4f51e99f', // contactId
    '4f51e99f-91a8-4255-b3cf-e71e32323230', // 无 session- 前缀的完整 id
    '远山', // handle
    'shoot_game 性能优化', // 标题
    '323230' // 唯一后缀
  ]
  for (const [index, ref] of refs.entries()) {
    contactCaptured.followups.length = 0
    const out = String(
      await askTool3.execute({ group: '性能组', text: `第 ${index + 1} 次询问（${ref}）现在进度如何？`, to: ref }, { agent: dirRoot })
    )
    assert.match(out, /已向群组「性能组」发出探测/, `${ref} 应解析成功：${out}`)
    assert.equal(contactCaptured.followups.length, 1, `${ref} 应唤醒一个会话`)
    assert.equal(contactCaptured.followups[0].sessionId, UUID_A, `${ref} 应解析到 4f51e99f…`)
  }
})

await check('session_ask：歧义输入返回候选且不唤醒', async () => {
  const askTool3 = toolByName3.get('session_ask')
  contactCaptured.followups.length = 0
  const out = String(await askTool3.execute({ group: '性能组', text: '现在进度如何？', to: '77aa' }, { agent: dirRoot }))
  assert.match(out, /指向不唯一/)
  assert.ok(out.includes('77aa1111'), '候选应包含 77aa1111')
  assert.ok(out.includes('77aa2222'), '候选应包含 77aa2222')
  assert.equal(contactCaptured.followups.length, 0, '歧义时不应唤醒任何会话')
})

await check('session_ask：任务派活回复带成员通讯录（contactId）', async () => {
  const askTool3 = toolByName3.get('session_ask')
  contactCaptured.followups.length = 0
  const out = String(
    await askTool3.execute({ group: '性能组', text: '请把压测数据补充到性能报告里', to: '4f51e99f', mode: 'task' }, { agent: dirRoot })
  )
  assert.match(out, /发出任务分配/)
  assert.match(out, /群成员通讯录/)
  assert.ok(out.includes('77aa1111'), '通讯录应含其他成员 contactId')
  assert.equal(contactCaptured.followups.length, 1)
  const message = String(contactCaptured.followups[0].message.content[0].text)
  assert.match(message, /replyTo=/, '任务分配才叮嘱如何回复')
})

await check('group_member：列表显示 contactId，可用 contactId/短 id 拉人，歧义不落盘', async () => {
  const memberTool = toolByName3.get('group_member')
  assert.ok(memberTool, '缺少 group_member')
  const listed = String(await memberTool.execute({ action: 'list', group: '性能组' }, { agent: dirRoot }))
  assert.match(listed, /contactId=4f51e99f/)
  assert.ok(listed.includes(`完整 id=${UUID_A}`))
  const removed = String(await memberTool.execute({ action: 'remove', group: '性能组', sessions: ['77aa11'] }, { agent: dirRoot }))
  assert.match(removed, /已移出/)
  let state = await callState3()
  let groupNow = state.json.groups.find((group) => group.id === 'g-dir')
  assert.ok(!groupNow.sessionIds.includes(UUID_B), '短 id 应能移出成员')
  const added = String(await memberTool.execute({ action: 'add', group: '性能组', sessions: ['77aa1111'] }, { agent: dirRoot }))
  assert.match(added, /已拉入/)
  state = await callState3()
  groupNow = state.json.groups.find((group) => group.id === 'g-dir')
  assert.ok(groupNow.sessionIds.includes(UUID_B), 'contactId 应能把成员加回')
  const ambiguous = String(await memberTool.execute({ action: 'remove', group: '性能组', sessions: ['77aa'] }, { agent: dirRoot }))
  assert.match(ambiguous, /解析失败/)
  assert.ok(ambiguous.includes('77aa1111') && ambiguous.includes('77aa2222'), '歧义应列出候选')
  state = await callState3()
  assert.equal(state.json.groups.find((group) => group.id === 'g-dir').sessionIds.length, 4, '歧义时群成员不应被改动')
})

await check('面板 group.add/remove 支持 contactId', async () => {
  const removed = await callCommand3({ action: 'group.remove', payload: { id: 'g-dir', sessionIds: [UUID_B] } })
  assert.equal(removed.json.ok, true, JSON.stringify(removed.json))
  const added = await callCommand3({ action: 'group.add', payload: { id: 'g-dir', sessionIds: ['77aa1111'] } })
  assert.equal(added.json.ok, true, JSON.stringify(added.json))
  assert.ok(added.json.state.groups.find((group) => group.id === 'g-dir').sessionIds.includes(UUID_B))
  const ambiguous = await callCommand3({ action: 'group.add', payload: { id: 'g-dir', sessionIds: ['77aa'] } })
  assert.equal(ambiguous.json.ok, false)
  assert.match(String(ambiguous.json.error), /解析失败/)
})

await check('世界任务正文 @ 支持 contactId/短 id；歧义返回候选', async () => {
  contactCaptured.followups.length = 0
  const ok = await callCommand3({ action: 'world.post', payload: { text: '@4f51e9 把性能分析整理成报告' } })
  assert.equal(ok.json.ok, true, JSON.stringify(ok.json))
  assert.equal(ok.json.router.engine, 'mentions')
  assert.ok(ok.json.assigned.some((item) => item.id === UUID_A), '应派给 4f51e99f…')
  assert.ok(contactCaptured.followups.some((item) => item.sessionId === UUID_A), '应唤醒被 @ 的会话')
  const ambiguous = await callCommand3({ action: 'world.post', payload: { text: '@77aa 处理一下这份报告' } })
  assert.equal(ambiguous.json.ok, false, JSON.stringify(ambiguous.json))
  assert.match(String(ambiguous.json.error), /指向不唯一/)
  assert.ok(String(ambiguous.json.error).includes('77aa1111') && String(ambiguous.json.error).includes('77aa2222'))
})

await check('群任务派活消息带成员通讯录（避免组长再猜短 id）', async () => {
  contactCaptured.followups.length = 0
  const res = await callCommand3({
    action: 'group.post',
    payload: { id: 'g-dir', text: '大家一起审阅性能报告并给出结论', mentionAll: true, coordinatorId: UUID_B }
  })
  assert.equal(res.json.ok, true, JSON.stringify(res.json))
  const coordinatorFollowup = contactCaptured.followups.find((item) => item.sessionId === UUID_B)
  assert.ok(coordinatorFollowup, '应唤醒组长')
  const message = String(coordinatorFollowup.message.content[0].text)
  assert.match(message, /成员通讯录/)
  assert.ok(message.includes('4f51e99f'), '通讯录应含成员 contactId')
  assert.match(message, /session_ask 的 to=contactId/)
})


// ---------------------------------------------------------------- G. 群名生成 + 空闲看板与路由避忙（v2.9.0）
console.log('== G. 群名生成/重命名 + 空闲看板 + 世界路由避忙（v2.9.0）')
const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-bridge-idle-'))
const G_ROOT = 'session-9a9a0000'
const G_DEV = 'session-9b9b1111-1111-4111-8111-111111111111'
const G_IDLE = 'session-9c9c2222-2222-4222-8222-222222222222'
const groupCaptured = { tools: [], routes: [], followups: [] }
const groupAgent = (id, cwd) => ({
  id,
  status: 'idle',
  session: { id, header: { cwd, createdAt: 1 } },
  followup(message) {
    groupCaptured.followups.push({ sessionId: this.id, message })
  }
})
const gRoot = groupAgent(G_ROOT, 'X:\\shoot_game')
const gDev = groupAgent(G_DEV, 'X:\\shoot_game')
const gIdle = groupAgent(G_IDLE, CWD)
const groupAgents = [gRoot, gDev, gIdle]
const groupTitles = { [G_ROOT]: '调度中心', [G_DEV]: 'shoot_game 开发', [G_IDLE]: '报告与审阅' }
const fakeSessionQueryG = {
  async listSessions() {
    return groupAgents.map((agent) => ({ header: agent.session.header, live: true, persisted: true, formatStatus: 'current' }))
  },
  async readTitleSnapshots(ids) {
    return ids.map((id) => ({
      sessionId: id,
      status: 'fulfilled',
      value: { session: { id }, ...(groupTitles[id] ? { title: { title: groupTitles[id] } } : {}) }
    }))
  }
}
fs.mkdirSync(path.join(groupDir, 'profiles'), { recursive: true })
fs.writeFileSync(
  path.join(groupDir, 'identities.json'),
  JSON.stringify(
    {
      sessions: {
        [G_ROOT]: { sessionId: G_ROOT, handle: '调度', avatar: '🛰️' },
        [G_DEV]: { sessionId: G_DEV, handle: '小工', avatar: '🦊' },
        [G_IDLE]: { sessionId: G_IDLE, handle: '小闲', avatar: '🐼' }
      }
    },
    null,
    2
  ),
  'utf8'
)
fs.writeFileSync(
  path.join(groupDir, 'profiles', G_DEV + '.json'),
  JSON.stringify({ sessionId: G_DEV, summary: '性能优化 招募协作 开发 压测', direction: 'shoot_game/性能', assets: ['x.js'], needs: '', declined: false }, null, 2),
  'utf8'
)
fs.writeFileSync(
  path.join(groupDir, 'profiles', G_IDLE + '.json'),
  JSON.stringify({ sessionId: G_IDLE, summary: '性能优化 审阅 写作 报告', direction: '论文/审阅', assets: ['report.md'], needs: '', declined: false }, null, 2),
  'utf8'
)
fs.writeFileSync(
  path.join(groupDir, 'reputation.json'),
  JSON.stringify(
    {
      sessions: {
        [G_DEV]: { sessionId: G_DEV, points: 50, successes: 3, failures: 0, closed: false, lastAt: 0 },
        [G_IDLE]: { sessionId: G_IDLE, points: 0, successes: 0, failures: 0, closed: false, lastAt: 0 },
        [G_ROOT]: { sessionId: G_ROOT, points: 10, successes: 1, failures: 0, closed: false, lastAt: 0 }
      },
      likes: {}
    },
    null,
    2
  ),
  'utf8'
)
fs.writeFileSync(
  path.join(groupDir, 'permissions.json'),
  JSON.stringify({ grants: { [G_ROOT]: [G_DEV, G_IDLE] } }, null, 2),
  'utf8'
)
const UGLY_GROUP_NAME = '协作：现在招募几位成员去给shootgame做三'
fs.writeFileSync(
  path.join(groupDir, 'groups.json'),
  JSON.stringify(
    {
      version: 1,
      groups: [
        {
          id: 'g-ugly',
          name: UGLY_GROUP_NAME,
          workspace: 'X:\\shoot_game',
          goal: '现在招募几位成员去给shootgame做三',
          managerSessionId: G_ROOT,
          sessionIds: [G_ROOT, G_DEV, G_IDLE],
          createdAt: 0,
          updatedAt: 0
        }
      ]
    },
    null,
    2
  ),
  'utf8'
)
const fakeWebServerG = {
  register(route) {
    groupCaptured.routes.push(route)
    return () => {}
  }
}
const ctxG = {
  tools: {
    register(definition) {
      groupCaptured.tools.push(definition)
      return () => {}
    }
  },
  systemPrompt: { section: () => () => {}, context: () => () => {} },
  agents: {
    roots: () => groupAgents,
    list: () => groupAgents,
    get: (id) => groupAgents.find((agent) => agent.id === id)
  },
  sessions: { list: () => groupAgents.map((agent) => agent.session) },
  get(name) {
    if (name === 'sessionQuery') return fakeSessionQueryG
    if (name === 'webServer') return fakeWebServerG
    return undefined
  },
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  on() {
    return () => {}
  },
  logger: { info() {}, warn() {}, error() {} }
}
plugin.apply(ctxG, { boardDir: groupDir, injectMode: 'broadcast', autoPrompt: false })
const toolByNameG = new Map(groupCaptured.tools.map((tool) => [tool.name, tool]))
const routeHandlerG = (path) => groupCaptured.routes.find((route) => route.path === path)?.handler
const callStateG = async () => {
  const res = fakeRes()
  await routeHandlerG('/api/session-bridge/state')(fakeReq(), res)
  return { res, json: JSON.parse(res.out.body) }
}
const callCommandG = async (command) => {
  const res = fakeRes()
  await routeHandlerG('/api/session-bridge/command')(
    fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-bridge-action': '1' },
      body: JSON.stringify(command)
    }),
    res
  )
  return { res, json: JSON.parse(res.out.body) }
}

await check('空闲看板：open request → busy；answer 后回 idle（v2.9.0）', async () => {
  let state = await callStateG()
  let devRow = state.json.sessions.find((session) => session.id === G_DEV)
  let idleRow = state.json.sessions.find((session) => session.id === G_IDLE)
  assert.ok(devRow && idleRow)
  assert.equal(devRow.availability, 'idle')
  assert.equal(devRow.openRequestCount, 0)
  assert.equal(idleRow.availability, 'idle')
  assert.equal(devRow.currentTask, null)
  // 发给 dev 的 open request → busy
  groupCaptured.followups.length = 0
  const asked = String(
    await toolByNameG.get('session_ask').execute({ group: 'g-ugly', text: '你现在进度如何？', to: '9b9b11' }, { agent: gRoot })
  )
  assert.match(asked, /已向群组/)
  state = await callStateG()
  devRow = state.json.sessions.find((session) => session.id === G_DEV)
  assert.equal(devRow.availability, 'busy', '有未回答 request 的会话应为 busy')
  assert.ok(devRow.currentTask && devRow.currentTask.title, 'busy 时应记录 currentTask')
  assert.ok(devRow.openRequestCount >= 1)
  const openRequest = state.json.rules.find(
    (item) => item.kind === 'request' && Array.isArray(item.requestTo) && item.requestTo.includes(G_DEV) && item.status !== 'answered'
  )
  assert.ok(openRequest, '应有一条发给 dev 的 open request')
  // answer → idle
  const replied = String(
    await toolByNameG.get('session_share').execute(
      { title: '进度回复', text: '已完成一半，稍后交付', kind: 'handoff', group: 'g-ugly', replyTo: openRequest.id },
      { agent: gDev }
    )
  )
  assert.match(replied, /已回复请求/)
  state = await callStateG()
  devRow = state.json.sessions.find((session) => session.id === G_DEV)
  assert.equal(devRow.availability, 'idle', 'answer 后应回到 idle')
  assert.equal(devRow.openRequestCount, 0)
  assert.ok(devRow.lastSubmittedAt > 0, '应记录 lastSubmittedAt')
})

await check('群名生成与重命名：丑样例自动改名 + 手动改名 + 群管理标题可读', async () => {
  const renamed = await callCommandG({ action: 'group.rename', payload: { id: 'g-ugly', auto: true } })
  assert.equal(renamed.json.ok, true, JSON.stringify(renamed.json))
  const groupRow = renamed.json.state.groups.find((group) => group.id === 'g-ugly')
  assert.ok(groupRow, '应能找到群组')
  assert.equal(renamed.json.previousName, UGLY_GROUP_NAME, '应返回旧群名')
  assert.match(groupRow.name, /shoot_game/, '自动群名应包含项目名 shoot_game：' + groupRow.name)
  assert.match(groupRow.name, /招募/, '自动群名应包含动作类型：' + groupRow.name)
  assert.ok(!groupRow.name.includes('协作：'), '不应再有「协作：+半句」：' + groupRow.name)
  assert.ok(groupRow.name.length <= 24, '群名不应过长：' + groupRow.name)
  // 群管理标题随群名派生，保持可读
  const managerRow = renamed.json.state.sessions.find((session) => session.id === G_ROOT)
  assert.equal(managerRow.title, '群管理：' + groupRow.name)
  // 手动改名
  const manual = await callCommandG({ action: 'group.rename', payload: { id: 'g-ugly', name: '性能联调组' } })
  assert.equal(manual.json.ok, true, JSON.stringify(manual.json))
  assert.equal(manual.json.state.groups.find((group) => group.id === 'g-ugly').name, '性能联调组')
  const empty = await callCommandG({ action: 'group.rename', payload: { id: 'g-ugly', name: '' } })
  assert.equal(empty.json.ok, false, '空群名应被拒绝')
})

await check('自动建群使用可读群名（不再「协作：+半句任务」）', async () => {
  groupCaptured.followups.length = 0
  const res = await callCommandG({
    action: 'world.post',
    payload: { text: '@9b9b11 现在招募几位成员去给shootgame做三，大家一起协作' }
  })
  assert.equal(res.json.ok, true, JSON.stringify(res.json))
  assert.ok(res.json.createdGroup && res.json.createdGroup.name, '世界任务应自动建群')
  assert.match(res.json.createdGroup.name, /shoot_game/, '自动群名应包含项目名：' + res.json.createdGroup.name)
  assert.match(res.json.createdGroup.name, /招募/, '自动群名应含动作类型：' + res.json.createdGroup.name)
  assert.ok(!res.json.createdGroup.name.includes('协作：'), '不应使用旧的半句群名：' + res.json.createdGroup.name)
  // 自动群任务的 coordinator 是 dev → dev 进入 busy
  const state = await callStateG()
  assert.equal(state.json.sessions.find((session) => session.id === G_DEV).availability, 'busy', '自动群任务组长应为 busy')
})

await check('group.post：默认优先空闲成员当组长；显式指定忙碌会提示', async () => {
  const before = await callStateG()
  assert.equal(before.json.sessions.find((session) => session.id === G_DEV).availability, 'busy')
  assert.equal(before.json.sessions.find((session) => session.id === G_IDLE).availability, 'idle')
  groupCaptured.followups.length = 0
  const res = await callCommandG({
    action: 'group.post',
    payload: { id: 'g-ugly', text: '性能优化 审阅 协作 报告整理', mentionSessionIds: [G_DEV, G_IDLE] }
  })
  assert.equal(res.json.ok, true, JSON.stringify(res.json))
  assert.ok(res.json.task, '多人任务应返回 task')
  assert.equal(res.json.task.coordinator.id, G_IDLE, '默认应优先选空闲成员当组长')
  assert.equal(res.json.coordinatorBusy, false)
  // 显式指定忙碌的 dev：尊重选择 + 提示可能排队
  groupCaptured.followups.length = 0
  const busyRes = await callCommandG({
    action: 'group.post',
    payload: { id: 'g-ugly', text: '性能优化 二次审阅', mentionSessionIds: [G_DEV, G_IDLE], coordinatorId: G_DEV }
  })
  assert.equal(busyRes.json.ok, true, JSON.stringify(busyRes.json))
  assert.equal(busyRes.json.task.coordinator.id, G_DEV, '显式指定的组长应生效（即使忙）')
  assert.equal(busyRes.json.coordinatorBusy, true, '应报告组长当前忙')
  const devMessage = groupCaptured.followups.find((item) => item.sessionId === G_DEV)
  assert.ok(devMessage, '应唤醒显式指定的组长')
  assert.match(String(devMessage.message.content[0].text), /busy|排队/)
})

await check('世界路由避忙：非显式匹配只派 idle；全忙走新建复核；显式 @ 尊重用户', async () => {
  // dev busy（自动群任务组长）+ idle 空闲（上一步被选为组长会变 busy？group.post 任务只唤醒组长，coordinator 也 busy）
  let state = await callStateG()
  const idleNow = state.json.sessions.find((session) => session.id === G_IDLE)
  assert.equal(idleNow.availability, 'busy', '上一步被指派为组长的成员应为 busy')
  // 让 dev 也 busy 之前先确认：两个候选都 busy 时，非显式匹配应改新建（复核）
  groupCaptured.followups.length = 0
  const busyText = '性能优化 审阅 协作 报告整理 第三轮'
  const pending = await callCommandG({ action: 'world.post', payload: { text: busyText } })
  assert.equal(pending.json.ok, true, JSON.stringify(pending.json))
  assert.equal(pending.json.pendingApproval, true, '全忙时应走新建会话（进入复核）')
  assert.equal(groupCaptured.followups.length, 0, '全忙改新建时不应唤醒忙碌成员')
  // 显式 @ 忙碌成员：尊重用户选择
  groupCaptured.followups.length = 0
  const explicit = await callCommandG({ action: 'world.post', payload: { text: '@9b9b11 性能压测 开发 检查' } })
  assert.equal(explicit.json.ok, true, JSON.stringify(explicit.json))
  assert.equal(explicit.json.router.engine, 'mentions')
  assert.ok(explicit.json.assigned.some((item) => item.id === G_DEV), '显式 @ 应派给忙碌的指定成员')
  assert.ok(groupCaptured.followups.some((item) => item.sessionId === G_DEV), '显式 @ 应唤醒该成员')
})

await check('世界路由：有 idle 匹配时跳过忙碌成员（改派空闲）', async () => {
  // 重置：让 dev busy、idle 空闲（回答 idle 的 open request；coordinator 请求被 answer 后任务也会完成）
  let state = await callStateG()
  const idleOpen = state.json.rules.filter(
    (item) => item.kind === 'request' && Array.isArray(item.requestTo) && item.requestTo.includes(G_IDLE) && item.status !== 'answered'
  )
  for (const request of idleOpen) {
    await toolByNameG.get('session_share').execute(
      { title: '空闲成员收尾', text: '已处理完毕', kind: 'handoff', group: request.groupId || 'g-ugly', replyTo: request.id },
      { agent: gIdle }
    )
  }
  state = await callStateG()
  assert.equal(state.json.sessions.find((session) => session.id === G_IDLE).availability, 'idle', 'idle 成员应回到空闲')
  assert.equal(state.json.sessions.find((session) => session.id === G_DEV).availability, 'busy', 'dev 仍应忙碌')
  // 非显式匹配：dev 分数/积分更高会先命中，但它是 busy → 应改派空闲的 idle
  groupCaptured.followups.length = 0
  const rerouted = await callCommandG({ action: 'world.post', payload: { text: '性能优化 审阅 协作 报告整理 第四轮' } })
  assert.equal(rerouted.json.ok, true, JSON.stringify(rerouted.json))
  assert.ok(Array.isArray(rerouted.json.assigned) && rerouted.json.assigned.length >= 1, '应派给空闲成员')
  assert.ok(rerouted.json.assigned.every((item) => item.id !== G_DEV), '忙碌的 dev 不应被派活')
  assert.ok(rerouted.json.assigned.some((item) => item.id === G_IDLE), '应改派给空闲成员')
})

// ---------------------------------------------------------------- H. 权限分级与修bug群（v2.9.1）
// 用户反馈：群组长把普通实现任务派给维护者「星桥值班员」，维护者被普通任务占用、修 bug 被阻塞。
// 期望：maintainer 默认 protected/service；普通世界路由 / group.post / session_ask / session_nudge
// 都不派普通任务；用户显式 @ 是例外且要给提示；维护者可一键创建/复用「星桥 · 修bug」群收 bug 报告。
console.log('== H. 权限分级与修bug群（v2.9.1）')
const permDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-bridge-perms-'))
const MAINTAINER = 'session-9a9a9a9a-0000-4000-8000-cccccccccccc'
const NORMAL_A = 'session-1a1a1a1a-0000-4000-8000-aaaaaaaaaaaa'
const NORMAL_B = 'session-2b2b2b2b-0000-4000-8000-bbbbbbbbbbbb'
const permCaptured = { tools: [], sections: [], contexts: [], listeners: [], routes: [], followups: [] }
const permAgent = (id) => ({
  id,
  status: 'idle',
  session: { id, header: { cwd: CWD, createdAt: 1 } },
  followup(message) {
    permCaptured.followups.push({ sessionId: this.id, message })
  }
})
const maintainerAgent = permAgent(MAINTAINER)
const normalAgentA = permAgent(NORMAL_A)
const normalAgentB = permAgent(NORMAL_B)
const permAgents = [maintainerAgent, normalAgentA, normalAgentB]
const permTitles = {
  [MAINTAINER]: '星桥值班员',
  [NORMAL_A]: '论文写作-第一篇',
  [NORMAL_B]: '论文写作-第二篇'
}
const fakeSessionQueryPerm = {
  async listSessions() {
    return permAgents.map((agent) => ({ header: agent.session.header, live: true, persisted: true, formatStatus: 'current' }))
  },
  async readTitleSnapshots(ids) {
    return ids.map((id) => ({
      sessionId: id,
      status: 'fulfilled',
      value: { session: { id }, ...(permTitles[id] ? { title: { title: permTitles[id] } } : {}) }
    }))
  }
}
fs.writeFileSync(
  path.join(permDir, 'identities.json'),
  JSON.stringify(
    {
      sessions: {
        [MAINTAINER]: { sessionId: MAINTAINER, handle: '值班员', avatar: '🛰️', role: '维护者' },
        [NORMAL_A]: { sessionId: NORMAL_A, handle: '远山', avatar: '🦊' },
        [NORMAL_B]: { sessionId: NORMAL_B, handle: '小北', avatar: '🐼' }
      }
    },
    null,
    2
  ),
  'utf8'
)
// 维护者注册（等价于面板 maintainer.set 的落盘结果）。
fs.writeFileSync(
  path.join(permDir, 'maintainer.json'),
  JSON.stringify(
    { sessionId: MAINTAINER, handle: '值班员', avatar: '🛰️', protected: true, service: true, protectionLevel: 'maintainer', updatedAt: 1 },
    null,
    2
  ),
  'utf8'
)
// 一个普通群：组长=远山；维护者保留观察成员位。
fs.writeFileSync(
  path.join(permDir, 'groups.json'),
  JSON.stringify(
    {
      version: 1,
      groups: [
        {
          id: 'g-normal',
          name: '论文组',
          kind: '',
          workspace: CWD,
          goal: '完成论文第 3 章',
          managerSessionId: NORMAL_A,
          sessionIds: [NORMAL_A, NORMAL_B, MAINTAINER],
          createdAt: 0,
          updatedAt: 0
        }
      ]
    },
    null,
    2
  ),
  'utf8'
)
// 远山可以唤醒小北；维护者默认不在可唤醒名单里（保护规则应在授权检查之前生效）。
fs.writeFileSync(
  path.join(permDir, 'permissions.json'),
  JSON.stringify({ grants: { [NORMAL_A]: [NORMAL_B], [NORMAL_B]: [NORMAL_A] } }, null, 2),
  'utf8'
)
const fakeWebServerPerm = {
  register(route) {
    permCaptured.routes.push(route)
    return () => {}
  }
}
const ctxPerm = {
  tools: {
    register(definition) {
      permCaptured.tools.push(definition)
      return () => {}
    }
  },
  systemPrompt: {
    section(options) {
      permCaptured.sections.push(options)
      return () => {}
    },
    context(options) {
      permCaptured.contexts.push(options)
      return () => {}
    }
  },
  agents: {
    roots: () => permAgents,
    list: () => permAgents,
    get: (id) => permAgents.find((agent) => agent.id === id)
  },
  sessions: { list: () => permAgents.map((agent) => agent.session) },
  get(name) {
    if (name === 'sessionQuery') return fakeSessionQueryPerm
    if (name === 'webServer') return fakeWebServerPerm
    return undefined
  },
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  on() {
    return () => {}
  },
  logger: { info() {}, warn() {}, error() {} }
}
plugin.apply(ctxPerm, { boardDir: permDir, injectMode: 'broadcast', autoPrompt: false })
const toolByNamePerm = new Map(permCaptured.tools.map((tool) => [tool.name, tool]))
const routeHandlerPerm = (path) => permCaptured.routes.find((route) => route.path === path)?.handler
const callStatePerm = async () => {
  const res = fakeRes()
  await routeHandlerPerm('/api/session-bridge/state')(fakeReq(), res)
  return { res, json: JSON.parse(res.out.body) }
}
const callCommandPerm = async (command) => {
  const res = fakeRes()
  await routeHandlerPerm('/api/session-bridge/command')(
    fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-bridge-action': '1' },
      body: JSON.stringify(command)
    }),
    res
  )
  return { res, json: JSON.parse(res.out.body) }
}
const maintainerFollowups = () => permCaptured.followups.filter((item) => item.sessionId === MAINTAINER)

await check('权限分级：通讯录/state 标记 protected/service 与角色', async () => {
  const profileTool = toolByNamePerm.get('session_profile')
  const updated = String(
    await profileTool.execute(
      { action: 'update', summary: 'ZQPROTECT 星桥维护者：负责修 bug、健康巡检与看板运维', direction: '维护/修bug/运维' },
      { agent: maintainerAgent }
    )
  )
  assert.match(updated, /已更新本会话申报/)
  const state = await callStatePerm()
  const maintainer = state.json.sessions.find((session) => session.id === MAINTAINER)
  assert.ok(maintainer, 'state.sessions 应包含维护者')
  assert.equal(maintainer.protected, true, '维护者应标记 protected')
  assert.equal(maintainer.service, true, '维护者应标记 service')
  assert.equal(maintainer.protectionLevel, 'maintainer')
  assert.equal(maintainer.worldEligible, false, '维护者不应参与普通世界任务自动路由')
  const managerA = state.json.sessions.find((session) => session.id === NORMAL_A)
  assert.equal(managerA.protectionLevel, 'group-manager', '群管理应标记 group-manager')
  assert.equal(managerA.protected, false)
  assert.equal(state.json.maintainer.protected, true, 'state.maintainer 应标记 protected')
  assert.equal(state.json.maintainer.protectionLevel, 'maintainer')
  assert.equal(state.json.capabilities.bugfixGroup, true)
  const dirTool = toolByNamePerm.get('session_directory')
  const directory = String(await dirTool.execute({}, { agent: normalAgentA }))
  assert.match(directory, /protected=yes/)
  assert.match(directory, /service=yes/)
  assert.match(directory, /角色=维护者（protected · service）/)
  assert.match(directory, /worldEligible=no/)
})

await check('世界任务自动路由排除维护者（即使申报关键词命中）', async () => {
  const preview = await callCommandPerm({
    action: 'world.route',
    payload: { text: 'ZQPROTECT 看下接口 500 报错，顺手把报告补一下' }
  })
  assert.equal(preview.json.ok, true, JSON.stringify(preview.json))
  assert.notEqual(preview.json.decision.sessionId, MAINTAINER, '自动路由不得命中维护者')
  assert.equal(preview.json.decision.route, 'new', '排除维护者后无匹配成员 → 应新建/待人工处理')
})

await check('用户显式 @ 维护者：例外放行 + 提示，且不建维护者组长群', async () => {
  permCaptured.followups.length = 0
  const res = await callCommandPerm({
    action: 'world.post',
    payload: { text: '@值班员 请看一下 ZQPROTECT 接口 500 的 bug，只在必要时修' }
  })
  assert.equal(res.json.ok, true, JSON.stringify(res.json))
  assert.equal(res.json.router.engine, 'mentions')
  assert.ok(res.json.assigned.some((item) => item.id === MAINTAINER), '显式 @ 应派给维护者')
  assert.ok(res.json.protectedException.includes(MAINTAINER), '响应应标记保护例外')
  assert.match(String(res.json.protectedNotice), /维护者/)
  assert.match(String(res.json.protectedNotice), /修bug/)
  assert.ok(!res.json.createdGroup, '维护者不应被自动建群当组长')
  const followup = maintainerFollowups()[0]
  assert.ok(followup, '应唤醒维护者')
  const message = String(followup.message.content[0].text)
  assert.match(message, /维护者例外/)
  assert.match(message, /修bug/)
})

await check('group.post：维护者不能被指派为组长/成员（报错或跳过并提示）', async () => {
  permCaptured.followups.length = 0
  // 只 @ 维护者 + 普通任务 → 明确报错，不唤醒
  const refused = await callCommandPerm({
    action: 'group.post',
    payload: { id: 'g-normal', text: '@值班员 请把接口重构实现一下', mentionSessionIds: [MAINTAINER] }
  })
  assert.equal(refused.json.ok, false, JSON.stringify(refused.json))
  assert.match(String(refused.json.error), /protected\/service/)
  assert.match(String(refused.json.error), /修bug/)
  assert.equal(maintainerFollowups().length, 0, '报错时不得唤醒维护者')

  // 维护者 + 普通成员一起 @ → 过滤维护者，任务照常派给普通成员
  const mixed = await callCommandPerm({
    action: 'group.post',
    payload: {
      id: 'g-normal',
      text: '@值班员 @远山 @小北 请一起把接口重构实现一下',
      mentionSessionIds: [MAINTAINER, NORMAL_A, NORMAL_B]
    }
  })
  assert.equal(mixed.json.ok, true, JSON.stringify(mixed.json))
  assert.ok(mixed.json.protectedSkipped.includes(MAINTAINER), '应报告被跳过的维护者')
  assert.ok(mixed.json.task, '其余成员应照常建群任务')
  assert.notEqual(mixed.json.task.coordinator.id, MAINTAINER)
  assert.ok(!mixed.json.task.assignees.some((item) => item.id === MAINTAINER), '维护者不能当成员')
  assert.equal(maintainerFollowups().length, 0, '维护者不应收到普通任务')

  // @所有人 也要排除维护者
  permCaptured.followups.length = 0
  const all = await callCommandPerm({
    action: 'group.post',
    payload: { id: 'g-normal', text: '大家一起把接口重构实现一下', mentionAll: true }
  })
  assert.equal(all.json.ok, true, JSON.stringify(all.json))
  assert.ok(all.json.protectedSkipped.includes(MAINTAINER))
  assert.equal(maintainerFollowups().length, 0)
})

await check('session_ask / session_nudge：拒绝把维护者当普通任务/催收目标', async () => {
  const askTool = toolByNamePerm.get('session_ask')
  const nudgeTool = toolByNamePerm.get('session_nudge')
  permCaptured.followups.length = 0
  const askTask = String(
    await askTool.execute({ group: '论文组', text: '请把接口重构实现完并交报告', to: '值班员', mode: 'task' }, { agent: normalAgentA })
  )
  assert.match(askTask, /protected\/service/)
  assert.match(askTask, /修bug/)
  assert.equal(maintainerFollowups().length, 0, 'session_ask 拒绝时不得唤醒维护者')
  const askProbe = String(
    await askTool.execute({ group: '论文组', text: '现在进度如何？', to: '值班员' }, { agent: normalAgentA })
  )
  assert.match(askProbe, /不接普通任务/)
  assert.equal(maintainerFollowups().length, 0)
  const nudge = String(
    await nudgeTool.execute({ group: '论文组', to: '值班员', text: '催一下进度' }, { agent: normalAgentA })
  )
  assert.match(nudge, /protected\/service/)
  assert.equal(maintainerFollowups().length, 0)
})

await check('bugfix.ensure：一键创建/复用「星桥 · 修bug」群，维护者为群管理', async () => {
  const created = await callCommandPerm({ action: 'bugfix.ensure', payload: {} })
  assert.equal(created.json.ok, true, JSON.stringify(created.json))
  assert.equal(created.json.created, true)
  assert.equal(created.json.name, '星桥 · 修bug')
  assert.equal(created.json.managerSessionId, MAINTAINER)
  const groupId = created.json.groupId
  let state = await callStatePerm()
  const bugfixGroup = state.json.groups.find((group) => group.id === groupId)
  assert.ok(bugfixGroup, 'state.groups 应包含修bug群')
  assert.equal(bugfixGroup.kind, 'bugfix')
  assert.equal(bugfixGroup.managerSessionId, MAINTAINER, '维护者应为群管理')
  assert.ok(bugfixGroup.sessionIds.includes(MAINTAINER))
  assert.ok(bugfixGroup.sessionIds.includes(NORMAL_A) && bugfixGroup.sessionIds.includes(NORMAL_B), '普通成员应入群')
  assert.equal(state.json.bugfix.exists, true)
  assert.equal(state.json.bugfix.groupId, groupId)

  // 复用：不重复建群
  const reused = await callCommandPerm({ action: 'bugfix.ensure', payload: {} })
  assert.equal(reused.json.ok, true, JSON.stringify(reused.json))
  assert.equal(reused.json.created, false)
  assert.equal(reused.json.reused, true)
  assert.equal(reused.json.groupId, groupId)
  state = await callStatePerm()
  assert.equal(state.json.groups.filter((group) => group.kind === 'bugfix').length, 1, '修bug群只能有一个')

  // 维护者也可以用自己的工具 action 创建/复用
  const boardTool = toolByNamePerm.get('session_board')
  const viaTool = String(await boardTool.execute({ action: 'bugfix' }, { agent: maintainerAgent }))
  assert.match(viaTool, /复用|创建/)
  assert.match(viaTool, /修bug群/)
})

await check('bug 报告进群：group.post / session_ask / session_share(kind=bug) 都能投递到维护者', async () => {
  let state = await callStatePerm()
  const bugfixGroup = state.json.groups.find((group) => group.kind === 'bugfix')
  assert.ok(bugfixGroup, '缺少修bug群')

  // 1) 修bug群里 @维护者 的 bug 报告 → 按 BUG 投递（不是普通任务）
  permCaptured.followups.length = 0
  const posted = await callCommandPerm({
    action: 'group.post',
    payload: { id: bugfixGroup.id, text: 'BUG：登录按钮点了没反应，控制台报 500', mentionSessionIds: [MAINTAINER] }
  })
  assert.equal(posted.json.ok, true, JSON.stringify(posted.json))
  assert.equal(posted.json.bugfix, true)
  const bugFollowup = maintainerFollowups()[0]
  assert.ok(bugFollowup, '应唤醒维护者处理 bug')
  const bugMessage = String(bugFollowup.message.content[0].text)
  assert.match(bugMessage, /BUG 报告/)
  assert.match(bugMessage, /不是普通任务派活/)

  // 2) 修bug群里 session_ask（探测/投递）→ 允许，按 BUG 处理
  permCaptured.followups.length = 0
  const askTool = toolByNamePerm.get('session_ask')
  const askOut = String(
    await askTool.execute(
      { group: '星桥 · 修bug', text: 'BUG：保存按钮再次报错，麻烦看一下', to: '值班员' },
      { agent: normalAgentA }
    )
  )
  assert.match(askOut, /BUG 报告|投递/)
  assert.equal(maintainerFollowups().length, 1, '修bug群里应唤醒维护者收 bug')

  // 3) session_share kind=bug → 自动进修bug群 + 通知维护者
  permCaptured.followups.length = 0
  const shareTool = toolByNamePerm.get('session_share')
  const shareOut = String(
    await shareTool.execute(
      { title: '保存按钮报错', text: '保存按钮点击后抛出 JavaScript 异常，偶发', kind: 'bug' },
      { agent: normalAgentB }
    )
  )
  assert.match(shareOut, /BUG/)
  assert.match(shareOut, /星桥 · 修bug/)
  assert.equal(maintainerFollowups().length, 1, 'kind=bug 应通知维护者')
  state = await callStatePerm()
  const bugEntry = state.json.rules.find(
    (entry) => entry.kind === 'bug' && entry.groupId === bugfixGroup.id && entry.title === '保存按钮报错'
  )
  assert.ok(bugEntry, 'BUG 条目应落在修bug群')

  // 4) bugfix.list 能看到开放的 bug 报告
  const listed = await callCommandPerm({ action: 'bugfix.list', payload: {} })
  assert.equal(listed.json.ok, true)
  assert.ok(listed.json.reports.length >= 2, 'bugfix.list 应列出 bug 报告')
  assert.ok(listed.json.reports.some((report) => report.status === 'open'))
})

await check('维护者保留群观察位，成员列表显示保护角色', async () => {
  const state = await callStatePerm()
  const normalGroup = state.json.groups.find((group) => group.id === 'g-normal')
  assert.ok(normalGroup.sessionIds.includes(MAINTAINER), '维护者保留普通群观察成员位')
  const memberTool = toolByNamePerm.get('group_member')
  const listText = String(await memberTool.execute({ action: 'list', group: '论文组' }, { agent: normalAgentA }))
  assert.match(listText, /角色=维护者（保护\/服务，仅观察，不接普通任务）/)
  assert.match(listText, /角色=群管理/)
  // 普通成员显示「成员」；若它刚好是未完成任务的组长则显示「组长（临时）」，两种都算普通角色展示。
  assert.match(listText, /角色=(成员|组长（临时）)/)
})

// ---------------------------------------------------------------- I. 健康巡检告警窗口 / 恢复跳过 / 标题空值（v2.9.6）
console.log('== I. 健康巡检告警窗口、恢复跳过与标题空值（v2.9.6）')
const healthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-bridge-health-'))
const healthLogs = []
const healthRoutes = []
const healthTools = []
const healthRenameCalls = []
const ghostId = 'session-gggg0007'
const ghostSession = { id: ghostId, header: header({ createdAt: Date.now() }) }
const healthWebServer = {
  register(route) {
    healthRoutes.push(route)
    return () => {}
  }
}
const healthTitles = {
  rename(session, title) {
    // 模拟真实宿主：读到 undefined.id 时抛异常（旧代码的 warn 来源）。
    if (!session || typeof session.id !== 'string') {
      throw new Error("Cannot read properties of undefined (reading 'id')")
    }
    healthRenameCalls.push({ sessionId: session.id, title })
    return { title }
  }
}
const healthCtx = {
  tools: {
    register(definition) {
      healthTools.push(definition)
      return () => {}
    }
  },
  systemPrompt: { section: () => () => {}, context: () => () => {} },
  agents: {
    roots: () => [rootAgent],
    list: () => [rootAgent],
    get: (id) => (id === rootAgent.id ? rootAgent : undefined),
    create: async () => ({ agent: {} }),
    resume: async () => {
      throw new Error(`session "${ghostId}" is already owned by an active write handle`)
    }
  },
  sessions: { list: () => [rootAgent.session, ghostSession] },
  get(name) {
    if (name === 'webServer') return healthWebServer
    if (name === 'sessionTitle') return healthTitles
    return undefined
  },
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  on() {
    return () => {}
  },
  logger: {
    info: (message) => healthLogs.push(['info', String(message)]),
    warn: (message) => healthLogs.push(['warn', String(message)]),
    error: (message) => healthLogs.push(['error', String(message)])
  }
}
plugin.apply(healthCtx, { boardDir: healthDir, injectMode: 'broadcast', autoPrompt: false })

const callHealthCommand = async (command) => {
  const handler = healthRoutes.find((route) => route.path === '/api/session-bridge/command')?.handler
  assert.ok(handler, '健康巡检实例缺少 command 路由')
  const res = fakeRes()
  await handler(
    fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-bridge-action': '1' },
      body: JSON.stringify(command)
    }),
    res
  )
  return { res, json: JSON.parse(res.out.body) }
}
const writeHealthLog = (entries) => {
  const text = entries
    .map(({ hoursAgo, level, message }) => `${new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString()} [${level}] ${message}`)
    .join('\n')
  fs.writeFileSync(path.join(healthDir, 'session-bridge.log'), text + '\n', 'utf8')
}
// 插件日志写 boardDir/session-bridge.log（不走 ctx.logger）；断言时按行增量读取。
const healthLogLines = () => {
  const file = path.join(healthDir, 'session-bridge.log')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
}
const hasHealthLog = (lines, level, pattern) =>
  lines.some((line) => line.includes('[' + level + ']') && pattern.test(line))
const oldNoise = Array.from({ length: 40 }, (_, index) => ({
  hoursAgo: 72,
  level: 'warn',
  message: '历史噪音 ' + index
}))

await check('健康巡检：日志警告只统计最近 24h（历史 warn 不再误报）', async () => {
  writeHealthLog([
    ...oldNoise,
    { hoursAgo: 2, level: 'warn', message: '近期噪音 A' },
    { hoursAgo: 1, level: 'warn', message: '近期噪音 B' },
    { hoursAgo: 1, level: 'error', message: '近期错误 C' }
  ])
  const { json } = await callHealthCommand({ action: 'health.check' })
  assert.equal(json.ok, true, JSON.stringify(json))
  assert.ok(
    !json.report.issues.some((issue) => String(issue).includes('近期日志警告偏多')),
    '最近 24h 只有 3 条，不应报「日志警告偏多」：' + JSON.stringify(json.report.issues)
  )
})

await check('健康巡检：最近 24h 超过阈值才告警，消息带时间窗口', async () => {
  writeHealthLog([
    ...oldNoise,
    ...Array.from({ length: 12 }, (_, index) => ({
      hoursAgo: 1,
      level: 'warn',
      message: '近期噪音 ' + index
    }))
  ])
  const { json } = await callHealthCommand({ action: 'health.check' })
  assert.equal(json.ok, true, JSON.stringify(json))
  const issue = json.report.issues.find((item) => String(item).includes('近期日志警告偏多'))
  assert.ok(issue, '最近 24h 12 条应触发告警：' + JSON.stringify(json.report.issues))
  assert.match(String(issue), /12 条 \/ 最近 24h/)
})

await check('会话恢复：已活跃会话跳过 resume 并记 info（不再 warn already owned）', async () => {
  const mark = healthLogLines().length
  const { json } = await callHealthCommand({
    action: 'session.revive',
    payload: { sessionId: ghostId, title: '不应触发改名' }
  })
  assert.equal(json.ok, true, JSON.stringify(json))
  assert.equal(json.skipped, true, '已活跃会话应返回 skipped')
  assert.equal(json.resumed, false)
  const fresh = healthLogLines().slice(mark)
  assert.ok(hasHealthLog(fresh, 'info', /已活跃，跳过恢复/), '应记录 info 跳过日志：' + JSON.stringify(fresh))
  assert.ok(!hasHealthLog(fresh, 'warn', /恢复会话/), '不应再把已活跃会话记成 warn：' + JSON.stringify(fresh))
  assert.equal(healthRenameCalls.length, 0, '跳过恢复时不应改名')
})

await check('会话恢复：already owned 竞态按预期路径跳过，不当错误', async () => {
  const mark = healthLogLines().length
  const raceId = 'session-wwww0008'
  healthCtx.agents.resume = async () => {
    throw new Error(`session "${raceId}" is already owned by an active write handle`)
  }
  const { json } = await callHealthCommand({ action: 'session.revive', payload: { sessionId: raceId } })
  assert.equal(json.ok, true, JSON.stringify(json))
  assert.equal(json.skipped, true)
  const fresh = healthLogLines().slice(mark)
  assert.ok(hasHealthLog(fresh, 'info', /already owned/), 'already owned 应记 info：' + JSON.stringify(fresh))
  assert.ok(!hasHealthLog(fresh, 'warn', /./), '不应产生 warn：' + JSON.stringify(fresh))
})

await check('新会话标题：宿主返回无 session 的 handle 时跳过并记 info（空值保护）', async () => {
  const created = await callHealthCommand({
    action: 'group.create',
    payload: { name: '标题空值测试组', workspace: healthDir, sessionIds: [rootAgent.id] }
  })
  assert.equal(created.json.ok, true, JSON.stringify(created.json))
  const groupId = created.json.groupId
  const mark = healthLogLines().length
  const titleMark = healthRenameCalls.length
  const { json } = await callHealthCommand({ action: 'group.manager', payload: { id: groupId, create: true } })
  assert.equal(json.ok, true, JSON.stringify(json))
  const fresh = healthLogLines().slice(mark)
  assert.equal(healthRenameCalls.length, titleMark, '没有 session.id 时不应调用 rename')
  assert.ok(hasHealthLog(fresh, 'info', /设置标题跳过/), '应记录 info 跳过日志：' + JSON.stringify(fresh))
  assert.ok(!hasHealthLog(fresh, 'warn', /设置标题失败/), '空值路径不应 warn：' + JSON.stringify(fresh))
})

// ---------------------------------------------------------------- J. 撤回 / 打断（v2.9.2）
// 用户诉求：一键撤回消息/任务、一键打断运行会话；权限矩阵正确、宿主不支持时明确降级（不假装成功）。
console.log('== J. 撤回与打断（v2.9.2）')
const retractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-bridge-retract-'))
const R_A = 'session-1111aaaa' // 普通成员 / 他群群管理
const R_B = 'session-2222bbbb' // 本群群管理
const R_C = 'session-3333cccc' // 维护者
const R_RUN = 'session-4444dddd' // 运行中，宿主提供 cancel
const R_NOCAP = 'session-5555eeee' // 运行中，宿主没有打断能力（模拟旧版 DSH）
const retractCaptured = { tools: [], sections: [], contexts: [], listeners: [], routes: [], followups: [], interrupts: [] }
const makeRetractAgent = (id, status) => ({
  id,
  status,
  session: { id, header: { cwd: CWD, createdAt: 1 } },
  followup(message) {
    retractCaptured.followups.push({ sessionId: this.id, message })
  },
  cancel(cause, options) {
    retractCaptured.interrupts.push({ sessionId: this.id, cause, options })
    this.status = 'idle'
  }
})
const retractA = makeRetractAgent(R_A, 'idle')
const retractB = makeRetractAgent(R_B, 'idle')
const retractC = makeRetractAgent(R_C, 'idle')
const retractRun = makeRetractAgent(R_RUN, 'running')
// 旧版宿主：Agent 只有 followup，没有 cancel/interrupt/abort/stop —— 必须明确降级。
const retractNoCap = {
  id: R_NOCAP,
  status: 'running',
  session: { id: R_NOCAP, header: { cwd: CWD, createdAt: 1 } },
  followup(message) {
    retractCaptured.followups.push({ sessionId: this.id, message })
  }
}
const retractAgents = [retractA, retractB, retractC, retractRun, retractNoCap]
const retractTitles = {
  [R_A]: '甲（普通成员）',
  [R_B]: '乙（群管理）',
  [R_C]: '丙（维护者）',
  [R_RUN]: '丁（运行中）',
  [R_NOCAP]: '戊（旧宿主）'
}
const fakeSessionQuery4 = {
  async listSessions() {
    return retractAgents.map((agent) => ({ header: agent.session.header, live: true, persisted: true, formatStatus: 'current' }))
  },
  async readTitleSnapshots(ids) {
    return ids.map((id) => ({
      sessionId: id,
      status: 'fulfilled',
      value: { session: { id }, ...(retractTitles[id] ? { title: { title: retractTitles[id] } } : {}) }
    }))
  }
}
fs.writeFileSync(
  path.join(retractDir, 'identities.json'),
  JSON.stringify(
    {
      sessions: {
        [R_A]: { sessionId: R_A, handle: '甲', avatar: '🦊' },
        [R_B]: { sessionId: R_B, handle: '乙', avatar: '🐼' },
        [R_C]: { sessionId: R_C, handle: '丙', avatar: '🛰️' },
        [R_RUN]: { sessionId: R_RUN, handle: '丁', avatar: '🐯' },
        [R_NOCAP]: { sessionId: R_NOCAP, handle: '戊', avatar: '🐸' }
      }
    },
    null,
    2
  ),
  'utf8'
)
fs.writeFileSync(path.join(retractDir, 'maintainer.json'), JSON.stringify({ sessionId: R_C, updatedAt: 1 }, null, 2), 'utf8')
const fakeWebServer4 = {
  register(route) {
    retractCaptured.routes.push(route)
    return () => {}
  }
}
const ctx4 = {
  tools: {
    register(definition) {
      retractCaptured.tools.push(definition)
      return () => {}
    }
  },
  systemPrompt: {
    section(options) {
      retractCaptured.sections.push(options)
      return () => {}
    },
    context(options) {
      retractCaptured.contexts.push(options)
      return () => {}
    }
  },
  agents: {
    roots: () => retractAgents,
    list: () => retractAgents,
    get: (id) => retractAgents.find((agent) => agent.id === id)
  },
  sessions: { list: () => retractAgents.map((agent) => agent.session) },
  get(name) {
    if (name === 'sessionQuery') return fakeSessionQuery4
    if (name === 'webServer') return fakeWebServer4
    return undefined
  },
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  on() {
    return () => {}
  },
  logger: { info() {}, warn() {}, error() {} }
}
plugin.apply(ctx4, { boardDir: retractDir, injectMode: 'targeted', autoPrompt: false })
const toolByName4 = new Map(retractCaptured.tools.map((tool) => [tool.name, tool]))
const routeHandler4 = (path) => retractCaptured.routes.find((route) => route.path === path)?.handler
const callState4 = async () => {
  const res = fakeRes()
  await routeHandler4('/api/session-bridge/state')(fakeReq(), res)
  return { res, json: JSON.parse(res.out.body) }
}
const callCommand4 = async (command) => {
  const res = fakeRes()
  await routeHandler4('/api/session-bridge/command')(
    fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-bridge-action': '1' },
      body: JSON.stringify(command)
    }),
    res
  )
  return { res, json: JSON.parse(res.out.body) }
}
let retractGroupId = ''
let otherGroupId = ''

await check('v2.9.2：state 暴露撤回/打断能力（探测到宿主 cancel）', async () => {
  const { json } = await callState4()
  assert.equal(json.version, '2.9.6')
  assert.equal(json.capabilities.retract, true)
  assert.equal(json.capabilities.interrupt, 'cancel', '应探测到宿主的 agent.cancel 能力')
  assert.ok(toolByName4.get('session_retract'), '缺少 session_retract 工具')
  assert.ok(toolByName4.get('session_interrupt'), '缺少 session_interrupt 工具')
})

await check('UI 静态检查：NEBULA 浮窗与侧栏都有「撤回」「打断」入口', async () => {
  const appHtml = fs.readFileSync(new URL('../app.html', import.meta.url), 'utf8')
  assert.match(appHtml, /data-retract/, 'NEBULA 应有撤回按钮')
  assert.match(appHtml, /data-interrupt/, 'NEBULA 群成员行应有打断按钮')
  assert.match(appHtml, /function retractEntry/, 'NEBULA 应有撤回处理函数')
  assert.match(appHtml, /function interruptSession/, 'NEBULA 应有打断处理函数')
  assert.match(appHtml, /entry\.retract/)
  assert.match(appHtml, /agent\.interrupt/)
  const clientJs = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(clientJs, /entry\.retract/, '侧栏应有撤回入口')
  assert.match(clientJs, /agent\.interrupt/, '侧栏应有打断入口')
  assert.match(clientJs, /'撤回'/)
  assert.match(clientJs, /'打断'/)
})

await check('准备群组：本群群管理 B / 他群群管理 A / 维护者 C', async () => {
  const created = await callCommand4({
    action: 'group.create',
    payload: { name: '撤回组', workspace: CWD, sessionIds: [R_A, R_B, R_C, R_RUN] }
  })
  assert.equal(created.json.ok, true, JSON.stringify(created.json))
  retractGroupId = created.json.state.groups.find((group) => group.name === '撤回组').id
  const manager = await callCommand4({ action: 'group.manager', payload: { id: retractGroupId, managerId: R_B } })
  assert.equal(manager.json.ok, true, JSON.stringify(manager.json))
  const other = await callCommand4({
    action: 'group.create',
    payload: { name: '他群', workspace: CWD, sessionIds: [R_A, R_C, R_NOCAP] }
  })
  assert.equal(other.json.ok, true, JSON.stringify(other.json))
  otherGroupId = other.json.state.groups.find((group) => group.name === '他群').id
  const otherManager = await callCommand4({ action: 'group.manager', payload: { id: otherGroupId, managerId: R_A } })
  assert.equal(otherManager.json.ok, true, JSON.stringify(otherManager.json))
  const state = await callState4()
  assert.equal(state.json.groups.find((group) => group.id === retractGroupId).managerSessionId, R_B)
  assert.equal(state.json.groups.find((group) => group.id === otherGroupId).managerSessionId, R_A)
  assert.equal(state.json.maintainer.sessionId, R_C)
})

await check('撤回世界消息：append remove + 关联未完成请求标 canceled', async () => {
  retractCaptured.followups.length = 0
  const posted = await callCommand4({ action: 'world.post', payload: { text: '@2222bbbb 补一份性能报告' } })
  assert.equal(posted.json.ok, true, JSON.stringify(posted.json))
  const stateAfter = await callState4()
  const worldMsg = stateAfter.json.world.find((entry) => String(entry.text).includes('补一份性能报告'))
  assert.ok(worldMsg, '应生成世界消息')
  const request = stateAfter.json.rules.find(
    (entry) =>
      entry.kind === 'request' &&
      Array.isArray(entry.requestTo) &&
      entry.requestTo.includes(R_B) &&
      String(entry.text).includes('补一份性能报告')
  )
  assert.ok(request, '应生成给 B 的未完成请求')
  const retracted = await callCommand4({ action: 'entry.retract', payload: { id: worldMsg.id, reason: '发错了' } })
  assert.equal(retracted.json.ok, true, JSON.stringify(retracted.json))
  assert.equal(retracted.json.kind, 'command')
  assert.ok(retracted.json.canceledRequests.includes(request.id), '关联请求应被取消')
  const after = await callState4()
  assert.ok(!after.json.world.some((entry) => entry.id === worldMsg.id), '世界消息应消失')
  const requestNow = after.json.rules.find((entry) => entry.id === request.id)
  assert.ok(requestNow, '关联请求保留审计记录')
  assert.equal(requestNow.status, 'canceled')
  // message.retract 是 entry.retract 的等价别名
  const alias = await callCommand4({ action: 'message.retract', payload: { id: 'no-such-entry-xyz' } })
  assert.equal(alias.json.ok, false)
  assert.match(String(alias.json.error), /找不到/)
})

await check('撤回群任务：taskStatus=canceled + 关联请求 canceled + 不误发完成奖励', async () => {
  retractCaptured.followups.length = 0
  const posted = await callCommand4({
    action: 'group.post',
    payload: {
      id: retractGroupId,
      text: '一起整理性能报告并给出结论',
      mentionSessionIds: [R_A, R_RUN],
      coordinatorId: R_A
    }
  })
  assert.equal(posted.json.ok, true, JSON.stringify(posted.json))
  const taskId = posted.json.task.id
  const requestId = posted.json.requestIds[0]
  assert.ok(taskId && requestId)
  const before = await callState4()
  assert.equal(before.json.rules.find((entry) => entry.id === taskId).taskStatus, 'assigned')
  const retracted = await callCommand4({ action: 'entry.retract', payload: { id: taskId, reason: '任务发错了' } })
  assert.equal(retracted.json.ok, true, JSON.stringify(retracted.json))
  assert.ok(retracted.json.canceledRequests.includes(requestId), '应取消关联请求')
  const after = await callState4()
  assert.ok(!after.json.rules.some((entry) => entry.id === taskId), '任务应从看板移除')
  const requestAfter = after.json.rules.find((entry) => entry.id === requestId)
  assert.ok(requestAfter, '关联请求保留审计记录')
  assert.equal(requestAfter.status, 'canceled')
  // 组长迟到的「任务完成」回复：不得结算积分、不得标记任务完成
  const pointsBefore = (after.json.reputation.find((item) => item.sessionId === R_A) || { points: 0 }).points
  const shareTool4 = toolByName4.get('session_share')
  const reply = String(
    await shareTool4.execute(
      { title: '任务完成', text: '【任务完成】报告已整理', kind: 'handoff', replyTo: requestId },
      { agent: retractA }
    )
  )
  assert.match(reply, /已撤回|不结算/, reply)
  const finalState = await callState4()
  const pointsAfter = (finalState.json.reputation.find((item) => item.sessionId === R_A) || { points: 0 }).points
  assert.equal(pointsAfter, pointsBefore, '撤回后不得误发完成奖励')
  assert.ok(!finalState.json.rules.some((entry) => entry.kind === 'task' && entry.id === taskId), '任务不应被回复重新标记完成')
})

await check('撤回待复核记录：approval 标 canceled + 隐藏卡片移除', async () => {
  const text = 'zzzz-retract-approval-' + Date.now() + ' 独立新任务'
  const posted = await callCommand4({ action: 'world.post', payload: { text } })
  assert.equal(posted.json.ok, true, JSON.stringify(posted.json))
  assert.equal(posted.json.pendingApproval, true, '自动建会话前应进入待复核')
  const approvalId = posted.json.approval.id
  const before = await callState4()
  assert.ok(before.json.approvals.some((item) => item.id === approvalId))
  assert.ok(before.json.rules.some((entry) => String(entry.title || '').startsWith('待复核')), '应有隐藏待复核卡片')
  const retracted = await callCommand4({ action: 'entry.retract', payload: { id: approvalId } })
  assert.equal(retracted.json.ok, true, JSON.stringify(retracted.json))
  assert.equal(retracted.json.kind, 'approval')
  const after = await callState4()
  assert.ok(!after.json.approvals.some((item) => item.id === approvalId), '待复核记录应消失')
  assert.ok(!after.json.rules.some((entry) => String(entry.title || '').startsWith('待复核')), '隐藏待复核卡片应移除')
})

await check('撤回权限矩阵：作者 / 群管理（本群） / 维护者 / 普通成员', async () => {
  const shareTool4 = toolByName4.get('session_share')
  const retractTool = toolByName4.get('session_retract')
  // ① 作者撤回自己未处理的群聊
  const shared = String(
    await shareTool4.execute({ title: '甲的群聊', text: '这条是甲发的，准备撤回', kind: 'chat', group: '撤回组' }, { agent: retractA })
  )
  assert.match(shared, /群组「撤回组」/)
  let state = await callState4()
  const ownChat = state.json.rules.find((entry) => entry.title === '甲的群聊' && entry.author === R_A)
  assert.ok(ownChat)
  let out = String(await retractTool.execute({ id: ownChat.id }, { agent: retractA }))
  assert.match(out, /已撤回/)
  state = await callState4()
  assert.ok(!state.json.rules.some((entry) => entry.id === ownChat.id), '作者应能撤回自己未处理的群聊')
  // ② 普通成员不能撤回他人的任务
  const posted = await callCommand4({
    action: 'group.post',
    payload: {
      id: retractGroupId,
      text: '普通成员不能撤回的群任务',
      mentionSessionIds: [R_A, R_RUN],
      coordinatorId: R_A
    }
  })
  assert.equal(posted.json.ok, true, JSON.stringify(posted.json))
  const taskId = posted.json.task.id
  out = String(await retractTool.execute({ id: taskId }, { agent: retractA }))
  assert.match(out, /没有权限撤回/)
  // ③ 本群群管理可以撤回本群任务
  out = String(await retractTool.execute({ id: taskId }, { agent: retractB }))
  assert.match(out, /已撤回/)
  // ④ 他群任务：本群群管理无权，维护者全量可以
  const otherPosted = await callCommand4({
    action: 'group.post',
    payload: {
      id: otherGroupId,
      text: '他群任务（B 无权撤回）',
      mentionSessionIds: [R_A, R_NOCAP],
      coordinatorId: R_A
    }
  })
  assert.equal(otherPosted.json.ok, true, JSON.stringify(otherPosted.json))
  const otherTaskId = otherPosted.json.task.id
  out = String(await retractTool.execute({ id: otherTaskId }, { agent: retractB }))
  assert.match(out, /没有权限撤回/)
  out = String(await retractTool.execute({ id: otherTaskId }, { agent: retractC }))
  assert.match(out, /已撤回/)
})

await check('打断：panel 对 running 会话调用宿主 cancel(keepInbox) 成功', async () => {
  retractCaptured.interrupts.length = 0
  retractRun.status = 'running'
  const res = await callCommand4({ action: 'agent.interrupt', payload: { sessionId: R_RUN, reason: '用户点了打断' } })
  assert.equal(res.json.ok, true, JSON.stringify(res.json))
  assert.equal(res.json.method, 'cancel')
  assert.equal(res.json.verified, true)
  assert.equal(retractCaptured.interrupts.length, 1)
  assert.equal(retractCaptured.interrupts[0].sessionId, R_RUN)
  assert.equal(retractCaptured.interrupts[0].options.keepInbox, true, '必须保留排队输入/历史')
  assert.equal(retractCaptured.interrupts[0].cause.kind, 'user')
})

await check('打断：idle 会话明确返回 not-running', async () => {
  const res = await callCommand4({ action: 'agent.interrupt', payload: { sessionId: R_A } })
  assert.equal(res.json.ok, false)
  assert.equal(res.json.code, 'not-running')
})

await check('打断：宿主没有 cancel/interrupt/abort/stop 时明确降级（不假装成功）', async () => {
  retractNoCap.status = 'running'
  const res = await callCommand4({ action: 'agent.interrupt', payload: { sessionId: R_NOCAP } })
  assert.equal(res.json.ok, false)
  assert.equal(res.json.code, 'unsupported')
  assert.match(String(res.json.error), /宿主不支持直接打断/)
  assert.ok(
    Array.isArray(res.json.alternatives) && res.json.alternatives.some((item) => /session_nudge/.test(item)),
    '应给出 session_nudge 等替代方案'
  )
})

await check('打断：contactId 也能解析到目标会话', async () => {
  retractCaptured.interrupts.length = 0
  retractRun.status = 'running'
  const res = await callCommand4({ action: 'agent.interrupt', payload: { sessionId: '4444dddd' } })
  assert.equal(res.json.ok, true, JSON.stringify(res.json))
  assert.equal(res.json.sessionId, R_RUN)
  assert.equal(retractCaptured.interrupts.length, 1)
})

await check('打断权限：普通成员不能打断他人 / 群管理只能打断本群 / 维护者全量', async () => {
  const tool = toolByName4.get('session_interrupt')
  // ① 普通成员 A 打断本群运行中的 RUN → 拒绝
  retractRun.status = 'running'
  retractCaptured.interrupts.length = 0
  let out = String(await tool.execute({ sessionId: R_RUN }, { agent: retractA }))
  assert.match(out, /没有打断权限/)
  assert.equal(retractCaptured.interrupts.length, 0, '无权限时不得调用宿主打断')
  // ② 本群群管理 B 打断本群 RUN → 成功
  out = String(await tool.execute({ sessionId: R_RUN }, { agent: retractB }))
  assert.match(out, /已打断/)
  assert.equal(retractCaptured.interrupts.length, 1)
  // ③ 群管理 B 打断他群成员 NOCAP → 拒绝（不是能力问题，是权限问题）
  retractNoCap.status = 'running'
  out = String(await tool.execute({ sessionId: R_NOCAP }, { agent: retractB }))
  assert.match(out, /没有打断权限/)
  // ④ 维护者 C 打断他群成员 NOCAP → 权限通过，但宿主没能力 → 明确降级
  out = String(await tool.execute({ sessionId: R_NOCAP }, { agent: retractC }))
  assert.match(out, /宿主不支持直接打断/)
  // ⑤ 群管理不能打断维护者
  retractC.status = 'running'
  retractCaptured.interrupts.length = 0
  out = String(await tool.execute({ sessionId: R_C }, { agent: retractB }))
  assert.match(out, /维护者会话不能被群管理/)
  assert.equal(retractCaptured.interrupts.length, 0)
  retractC.status = 'idle'
  // ⑥ 普通成员可以打断自己
  retractA.status = 'running'
  retractCaptured.interrupts.length = 0
  out = String(await tool.execute({ sessionId: R_A }, { agent: retractA }))
  assert.match(out, /已打断/)
  assert.equal(retractCaptured.interrupts.length, 1)
  retractA.status = 'idle'
})



await (async () => {
  // ---------------------------------------------------------------- K. 组长招募 + 加急插话（v2.9.3）
  // 需求：组长可请求世界路由招募/派新人（优先 idle、自动入组、新建走复核、尊重 protected）；
  // 加急消息 session.urgent（权限、idle/running 插话、无打断能力降级、限频、UI ⚡）。
  console.log('== K. 组长 ↔ 世界路由招募 + 加急插话（v2.9.3）')
  const recruitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-bridge-recruit-'))
  const G = {
    leader: 'session-9000lead',
    idleMember: 'session-9100idle',
    runner: 'session-9200run',
    runner2: 'session-9300run2',
    maintainer: 'session-9400maint',
    outsider: 'session-9500outsider'
  }
  const gAgentById = (id) => gAgents.find((agent) => agent.id === id)
  const gAgent = (id, status) => ({
    id,
    status,
    session: { id, header: { cwd: CWD, createdAt: 1 } }
  })
  const gAgents = [
    gAgent(G.leader, 'idle'),
    gAgent(G.idleMember, 'idle'),
    gAgent(G.runner, 'running'),
    gAgent(G.runner2, 'running'),
    gAgent(G.maintainer, 'idle'),
    gAgent(G.outsider, 'idle')
  ]
  // runner 提供打断能力（模拟 task-4 的 agent.interrupt）；runner2 没有 → 测降级。
  const gRunner = gAgentById(G.runner)
  gRunner.interrupt = function interrupt() {
    gCaptured.interrupts.push(this.id)
    this.status = 'idle'
  }
  for (const agent of gAgents) {
    agent.followup = function followup(message) {
      gCaptured.followups.push({ sessionId: this.id, message })
    }
  }
  const gTitles = {
    [G.leader]: '组长-远山',
    [G.idleMember]: '画图员-小北',
    [G.runner]: '跑图-小南',
    [G.runner2]: '跑图-小西',
    [G.maintainer]: '星桥值班员',
    [G.outsider]: '路过的-小白'
  }
  const fakeSessionQuery4 = {
    async listSessions() {
      return gAgents.map((agent) => ({
        header: agent.session.header,
        live: true,
        persisted: true,
        formatStatus: 'current'
      }))
    },
    async readTitleSnapshots(ids) {
      return ids.map((id) => ({
        sessionId: id,
        status: 'fulfilled',
        value: { session: { id }, ...(gTitles[id] ? { title: { title: gTitles[id] } } : {}) }
      }))
    }
  }
  const fakeWebServer4 = {
    register(route) {
      gCaptured.routes.push(route)
      return () => {}
    }
  }
  // 预置：群「招募组」（组长=leader）、维护者、以及 idleMember 的申报（worldEligible）。
  fs.writeFileSync(
    path.join(recruitDir, 'groups.json'),
    JSON.stringify(
      {
        version: 1,
        groups: [
          {
            id: 'g-recruit',
            name: '招募组',
            workspace: CWD,
            goal: '测试组长招募',
            managerSessionId: G.leader,
            sessionIds: [G.leader],
            createdAt: 0,
            updatedAt: 0
          }
        ]
      },
      null,
      2
    ),
    'utf8'
  )
  fs.writeFileSync(path.join(recruitDir, 'maintainer.json'), JSON.stringify({ sessionId: G.maintainer }, null, 2), 'utf8')
  fs.mkdirSync(path.join(recruitDir, 'profiles'), { recursive: true })
  fs.writeFileSync(
    path.join(recruitDir, 'profiles', G.idleMember + '.json'),
    JSON.stringify(
      {
        sessionId: G.idleMember,
        summary: '擅长把数据画成出版级图表',
        direction: '画图 / 数据可视化',
        assets: ['matplotlib'],
        needs: '',
        declined: false,
        updatedAt: 1
      },
      null,
      2
    ),
    'utf8'
  )
  const gCaptured = { tools: [], routes: [], followups: [], interrupts: [], logs: [], createdAgents: [] }
  const ctx4 = {
    tools: {
      register(definition) {
        gCaptured.tools.push(definition)
        return () => {}
      }
    },
    systemPrompt: {
      section() {
        return () => {}
      },
      context() {
        return () => {}
      }
    },
    agents: {
      roots: () => gAgents,
      list: () => gAgents,
      get: (id) => gAgentById(id),
      async create(options) {
        const id = options && options.sessionId ? options.sessionId : 'session-created-' + Date.now().toString(36)
        const agent = gAgent(id, 'idle')
        agent.followup = function followup(message) {
          gCaptured.followups.push({ sessionId: this.id, message })
        }
        gAgents.push(agent)
        gCaptured.createdAgents.push(id)
        return { agent, session: agent.session }
      }
    },
    sessions: { list: () => gAgents.map((agent) => agent.session) },
    get(name) {
      if (name === 'sessionQuery') return fakeSessionQuery4
      if (name === 'webServer') return fakeWebServer4
      return undefined
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on() {
      return () => {}
    },
    logger: {
      info() {},
      warn(message) {
        gCaptured.logs.push(['warn', String(message)])
      },
      error(message) {
        gCaptured.logs.push(['error', String(message)])
      }
    }
  }
  plugin.apply(ctx4, { boardDir: recruitDir, injectMode: 'broadcast', autoPrompt: false, askOnCreate: false })
  const toolByName4 = new Map(gCaptured.tools.map((tool) => [tool.name, tool]))
  const routeHandler4 = (routePath) => gCaptured.routes.find((route) => route.path === routePath)?.handler
  const callState4 = async () => {
    const res = fakeRes()
    await routeHandler4('/api/session-bridge/state')(fakeReq(), res)
    return { res, json: JSON.parse(res.out.body) }
  }
  const callCommand4 = async (command) => {
    const res = fakeRes()
    await routeHandler4('/api/session-bridge/command')(
      fakeReq({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-bridge-action': '1' },
        body: JSON.stringify(command)
      }),
      res
    )
    return { res, json: JSON.parse(res.out.body) }
  }

  await check('state.sessions 提供 availability/protected 字段（保护维护者）', async () => {
    const state = await callState4()
    const leader = state.json.sessions.find((session) => session.id === G.leader)
    const maintainer = state.json.sessions.find((session) => session.id === G.maintainer)
    const running = state.json.sessions.find((session) => session.id === G.runner2)
    assert.equal(leader.availability, 'idle')
    assert.equal(maintainer.protected, true, '维护者应标记 protected')
    assert.equal(running.availability, 'busy', 'running 会话应为 busy')
    assert.equal(state.json.config.urgentIntervalMs, 60000)
  })

  await check('group.recruit：普通成员无权请求招募', async () => {
    const recruitTool = toolByName4.get('group_recruit')
    assert.ok(recruitTool, '缺少 group_recruit 工具')
    const out = String(
      await recruitTool.execute({ group: '招募组', text: '需要一位画图成员' }, { agent: gAgentById(G.outsider) })
    )
    assert.match(out, /只有本群群管理|组长|维护者/, '普通成员应被拒绝：' + out)
  })

  await check('group.recruit：组长招到 idle 现有成员 → 自动入组 + 建任务 + 审计 + 唤醒', async () => {
    const recruitTool = toolByName4.get('group_recruit')
    gCaptured.followups.length = 0
    const out = String(
      await recruitTool.execute(
        { group: '招募组', text: '需要一位画图成员，负责把图表重绘', count: 1, mode: 'auto', skills: ['画图'] },
        { agent: gAgentById(G.leader) }
      )
    )
    assert.match(out, /招募成功/, out)
    assert.match(out, /画图员-小北/, '应选中 idle 现有成员：' + out)
    const state = await callState4()
    const group = state.json.groups.find((item) => item.id === 'g-recruit')
    assert.ok(group.sessionIds.includes(G.idleMember), '新成员应自动加入群组')
    const task = state.json.rules.find((entry) => entry.kind === 'task' && entry.groupId === 'g-recruit')
    assert.ok(task, '应创建招募任务')
    assert.equal(task.coordinator, G.leader, '组长应沿用发起人')
    assert.ok(task.assignees.includes(G.idleMember), '任务应指派给新成员')
    const audit = state.json.rules.find(
      (entry) => entry.kind === 'chat' && entry.groupId === 'g-recruit' && String(entry.title).indexOf('招募') >= 0
    )
    assert.ok(audit, '应写入招募审计（群聊）')
    assert.ok(String(audit.text).includes('新增成员'), '审计应说明路由结果')
    assert.ok(
      gCaptured.followups.some(
        (item) => item.sessionId === G.idleMember && String(item.message.content[0].text).includes('招募入组')
      ),
      '应唤醒新成员'
    )
  })

  await check('group.recruit：空闲成员不足/无匹配 → 进入新会话复核（不偷偷建会话）', async () => {
    const recruitTool = toolByName4.get('group_recruit')
    // 把剩余的普通候选都变忙：只剩维护者空闲（必须被排除）。
    gAgentById(G.outsider).status = 'running'
    const out = String(
      await recruitTool.execute({ group: '招募组', text: '再招一位新成员做数据', count: 1, mode: 'auto' }, { agent: gAgentById(G.leader) })
    )
    assert.match(out, /待复核/, out)
    const state = await callState4()
    const approval = (state.json.approvals || []).find(
      (item) => item.source === 'group.recruit' && item.groupId === 'g-recruit'
    )
    assert.ok(approval, '应写入待复核记录')
    assert.equal(approval.memberCount, 1)
    const group = state.json.groups.find((item) => item.id === 'g-recruit')
    assert.ok(!group.sessionIds.includes(G.maintainer), '维护者不得被招募')
    assert.ok(!group.sessionIds.includes(G.runner), '运行中成员不得被招募')
    assert.equal(gCaptured.createdAgents.length, 0, '复核通过前不得创建会话')
  })

  await check('group.recruit：复核通过后新建会话并自动入组（面板命令）', async () => {
    const stateBefore = await callState4()
    const approval = (stateBefore.json.approvals || []).find((item) => item.source === 'group.recruit')
    assert.ok(approval, '缺少待复核记录')
    const approved = await callCommand4({
      action: 'group.recruit',
      payload: {
        group: '招募组',
        text: '再招一位新成员做数据',
        count: 1,
        mode: 'auto',
        approved: true,
        approvalId: approval.id
      }
    })
    assert.equal(approved.json.ok, true, JSON.stringify(approved.json))
    assert.equal(approved.json.pendingApproval, undefined, '复核通过后不应再返回待复核')
    assert.equal((approved.json.added || []).length, 1)
    assert.equal(approved.json.added[0].source, 'new')
    assert.ok(gCaptured.createdAgents.length >= 1, '应新建会话')
    const group = approved.json.state.groups.find((item) => item.id === 'g-recruit')
    assert.ok(group.sessionIds.includes(approved.json.added[0].id), '新会话应自动入组')
  })

  await check('group.recruit：mode=existing 且无空闲时给可读错误', async () => {
    const result = await callCommand4({
      action: 'group.recruit',
      payload: { group: '招募组', text: '再来一位', count: 1, mode: 'existing' }
    })
    assert.equal(result.json.ok, false)
    assert.match(String(result.json.error), /没有空闲/, JSON.stringify(result.json))
  })

  await check('session.urgent：idle 目标立即唤醒并标注【加急】', async () => {
    gCaptured.followups.length = 0
    const result = await callCommand4({
      action: 'session.urgent',
      payload: { to: G.idleMember, text: '请立刻把图2改成 600dpi' }
    })
    assert.equal(result.json.ok, true, JSON.stringify(result.json))
    assert.equal(result.json.interrupted, false)
    assert.equal(result.json.degraded, false)
    assert.equal(result.json.target.id, G.idleMember)
    const state = await callState4()
    const urgentEntry = (state.json.world || []).find(
      (entry) => entry.urgent === true && String(entry.text).includes('600dpi')
    )
    assert.ok(urgentEntry, '世界消息应带 urgent 标记')
    assert.ok(urgentEntry.urgentTo.includes(G.idleMember))
    const followup = gCaptured.followups.find((item) => item.sessionId === G.idleMember)
    assert.ok(followup, '应唤醒目标会话')
    const message = String(followup.message.content[0].text)
    assert.ok(message.includes('【加急') && message.includes('600dpi'), '加急正文应送达：' + message)
  })

  await check('session.urgent：60 秒限频（同一发送者→同一目标）', async () => {
    const before = gCaptured.followups.filter((item) => item.sessionId === G.idleMember).length
    const limited = await callCommand4({
      action: 'session.urgent',
      payload: { to: G.idleMember, text: '再催一次' }
    })
    assert.equal(limited.json.ok, false, JSON.stringify(limited.json))
    assert.match(String(limited.json.error), /频繁/, String(limited.json.error))
    assert.ok(limited.json.retryAfterMs > 0, '应返回重试等待时间')
    const after = gCaptured.followups.filter((item) => item.sessionId === G.idleMember).length
    assert.equal(after, before, '限频期间不得再次唤醒')
  })

  await check('session.urgent：running + 有打断能力 → 先打断再插话', async () => {
    gCaptured.followups.length = 0
    gCaptured.interrupts.length = 0
    const result = await callCommand4({
      action: 'session.urgent',
      payload: { to: G.runner, text: '立刻停下当前任务，先交付图表' }
    })
    assert.equal(result.json.ok, true, JSON.stringify(result.json))
    assert.equal(result.json.interrupted, true, '应报告已打断')
    assert.equal(result.json.degraded, false)
    assert.deepEqual(gCaptured.interrupts, [G.runner], '应调用宿主打断能力')
    assert.ok(
      gCaptured.followups.some(
        (item) => item.sessionId === G.runner && String(item.message.content[0].text).includes('立刻停下当前任务')
      ),
      '打断后应立即注入加急消息'
    )
  })

  await check('session.urgent：running 无打断能力 → 明确降级为插话（不假装已打断）', async () => {
    gCaptured.followups.length = 0
    const result = await callCommand4({
      action: 'session.urgent',
      payload: { to: G.runner2, text: '这条需要插话提醒' }
    })
    assert.equal(result.json.ok, true, JSON.stringify(result.json))
    assert.equal(result.json.interrupted, false, '无能力时不得声称已打断')
    assert.equal(result.json.degraded, true, '应明确降级')
    assert.match(String(result.json.degradedReason), /不支持直接打断|退化/, String(result.json.degradedReason))
    assert.ok(
      gCaptured.followups.some(
        (item) => item.sessionId === G.runner2 && String(item.message.content[0].text).includes('这条需要插话提醒')
      ),
      '降级后仍应插话送达'
    )
  })

  await check('session.urgent：权限矩阵（普通成员拒绝 / 群管理本组可用 / 维护者可用）', async () => {
    const urgentTool = toolByName4.get('session_urgent')
    assert.ok(urgentTool, '缺少 session_urgent 工具')
    gAgentById(G.outsider).status = 'idle'
    const deniedMember = String(
      await urgentTool.execute({ to: G.leader, text: '普通成员越权加急' }, { agent: gAgentById(G.outsider) })
    )
    assert.match(deniedMember, /普通成员不能对他人加急|群管理/, '普通成员应被拒绝：' + deniedMember)
    const deniedOutsider = String(
      await urgentTool.execute({ to: G.outsider, text: '组长对组外加急' }, { agent: gAgentById(G.leader) })
    )
    assert.match(deniedOutsider, /不能对他人加急|群管理/, '群管理不能对组外加急：' + deniedOutsider)
    const managerOk = String(
      await urgentTool.execute(
        { group: '招募组', to: G.idleMember, text: '组长加急：请先交图' },
        { agent: gAgentById(G.leader) }
      )
    )
    assert.match(managerOk, /加急已送达/, '本组群管理加急应成功：' + managerOk)
    const maintainerOk = String(
      await urgentTool.execute({ to: G.outsider, text: '维护者加急：请回报状态' }, { agent: gAgentById(G.maintainer) })
    )
    assert.match(maintainerOk, /加急已送达/, '维护者加急应成功：' + maintainerOk)
  })

  await check('UI 静态：群聊 ⚡ 加急入口 + urgent 标记（app.html / client.js）', async () => {
    const appHtml = fs.readFileSync(path.join(PLUGIN_DIR, 'app.html'), 'utf8')
    const clientJs = fs.readFileSync(path.join(PLUGIN_DIR, 'client.js'), 'utf8')
    for (const needle of ['groupUrgent', 'session.urgent', '⚡ 加急', 'urgentMode']) {
      assert.ok(appHtml.includes(needle), 'app.html 缺少 ' + needle)
    }
    for (const needle of ['session.urgent', '⚡ 加急', 'urgent', 'bubbleUrgent']) {
      assert.ok(clientJs.includes(needle), 'client.js 缺少 ' + needle)
    }
    assert.ok(appHtml.includes('badge-urgent') || appHtml.includes('chip urgent'), 'app.html 应有加急标记样式')
  })
})()
// ---------------------------------------------------------------- L. 群任务显式发布（v2.9.4）
// 场景：面板群聊点「发布任务」→ group.post { task:true, coordinatorId, assigneeIds }。
// 旧版只在 @ 人数 >=2 时建任务，单人 @ 会退化成普通请求；讨论也不该触发任务。
console.log('== L. 群任务显式发布（v2.9.4）')

const taskCountOf = async () =>
  (await callState3()).json.rules.filter((item) => item.kind === 'task' && item.groupId === 'g-dir').length

await check('显式任务（单人）：task:true + 指定组长 → 任务卡 + 组长请求', async () => {
  contactCaptured.followups.length = 0
  const before = await taskCountOf()
  const res = await callCommand3({
    action: 'group.post',
    payload: { id: 'g-dir', text: '把性能报告整理成一页结论，今晚前给我', task: true, coordinatorId: UUID_A }
  })
  assert.equal(res.json.ok, true, JSON.stringify(res.json))
  assert.ok(res.json.task, '显式任务应返回 task')
  assert.equal(res.json.task.coordinator.id, UUID_A, '单人任务组长就是被指定的人')
  assert.deepEqual(res.json.task.assignees, [], '单人任务 assignees 必须为空')
  assert.equal(res.json.woken, 1, '只唤醒组长')
  assert.equal(contactCaptured.followups.length, 1)
  assert.equal(contactCaptured.followups[0].sessionId, UUID_A)
  assert.match(String(contactCaptured.followups[0].message.content[0].text), /本任务负责人/)
  const task = res.json.state.rules.find((item) => item.id === res.json.task.id)
  assert.ok(task && task.kind === 'task', '任务卡应写入看板')
  assert.equal(task.coordinator, UUID_A)
  assert.deepEqual(task.assignees, [])
  assert.equal(task.taskStatus, 'assigned')
  const request = res.json.state.rules.find(
    (item) => item.kind === 'request' && item.taskId === task.id && item.taskRole === 'coordinator'
  )
  assert.ok(request, '应创建组长请求')
  assert.deepEqual(request.requestTo, [UUID_A])
  assert.equal(request.hiddenFromChat, true, '组长请求不刷聊天流，由任务卡查看')
  assert.equal(await taskCountOf(), before + 1)
})

await check('显式任务（两人）：mode:task + 指定组长 + 成员多选', async () => {
  contactCaptured.followups.length = 0
  const res = await callCommand3({
    action: 'group.post',
    payload: {
      id: 'g-dir',
      text: '合并两份审稿意见，产出唯一修改清单',
      mode: 'task',
      coordinatorId: UUID_B,
      assigneeIds: [UUID_A, UUID_C]
    }
  })
  assert.equal(res.json.ok, true, JSON.stringify(res.json))
  assert.equal(res.json.task.coordinator.id, UUID_B)
  assert.deepEqual(res.json.task.assignees.map((item) => item.id).sort(), [UUID_A, UUID_C].sort())
  assert.equal(res.json.woken, 1, '创建任务只唤醒组长')
  assert.equal(contactCaptured.followups[0].sessionId, UUID_B)
  assert.match(String(contactCaptured.followups[0].message.content[0].text), /唯一组长/)
  const task = res.json.state.rules.find((item) => item.id === res.json.task.id)
  assert.equal(task.coordinator, UUID_B)
  assert.deepEqual([...task.assignees].sort(), [UUID_A, UUID_C].sort())
  const grants = res.json.state.permissions[UUID_B] || []
  assert.ok(grants.includes(UUID_A) && grants.includes(UUID_C), '组长应获得唤醒成员的临时授权')
})

await check('普通聊天 / 讨论不创建任务（保持旧行为）', async () => {
  const before = await taskCountOf()
  contactCaptured.followups.length = 0
  const chat = await callCommand3({
    action: 'group.post',
    payload: { id: 'g-dir', text: '今天先同步一下进度', mentionSessionIds: [UUID_A] }
  })
  assert.equal(chat.json.ok, true, JSON.stringify(chat.json))
  assert.equal(chat.json.task, undefined, '普通聊天不应返回 task')
  assert.equal(await taskCountOf(), before, '普通聊天不应新增任务卡')
  const discuss = await callCommand3({ action: 'group.discuss', payload: { id: 'g-dir', topic: '聊聊这周踩过的坑' } })
  assert.equal(discuss.json.ok, true, JSON.stringify(discuss.json))
  assert.equal(discuss.json.task, undefined, '讨论不创建任务')
  assert.equal(await taskCountOf(), before)
  assert.ok(
    discuss.json.state.rules.some((item) => item.kind === 'chat' && /讨论/.test(item.title)),
    '讨论仍应写入群聊'
  )
})

await check('显式任务缺少组长 / 组长不在群内 / 正文为空 → 报错且不落任务', async () => {
  const before = await taskCountOf()
  const missing = await callCommand3({
    action: 'group.post',
    payload: { id: 'g-dir', text: '没有组长的任务', task: true, assigneeIds: [UUID_A] }
  })
  assert.equal(missing.json.ok, false, JSON.stringify(missing.json))
  assert.match(String(missing.json.error), /组长/)
  const outsider = await callCommand3({
    action: 'group.post',
    payload: { id: 'g-dir', text: '组长不在本群', task: true, coordinatorId: 'session-not-in-this-group' }
  })
  assert.equal(outsider.json.ok, false, JSON.stringify(outsider.json))
  assert.match(String(outsider.json.error), /本群成员/)
  const emptyText = await callCommand3({
    action: 'group.post',
    payload: { id: 'g-dir', text: '   ', task: true, coordinatorId: UUID_A }
  })
  assert.equal(emptyText.json.ok, false, '空任务正文必须报错')
  // 普通成员（非群管理/维护者/面板）不能创建任务。
  const unauthorized = await callCommand3({
    action: 'group.post',
    payload: { id: 'g-dir', text: '普通成员越权发布', task: true, coordinatorId: UUID_B, actorId: UUID_A }
  })
  assert.equal(unauthorized.json.ok, false, '普通成员无权发布任务')
  assert.match(String(unauthorized.json.error), /只有群管理/)
  assert.equal(await taskCountOf(), before, '校验失败不应创建任务')
})

await check('群任务 UI：发布任务入口 / 组长选择 / 任务卡可见（静态检查）', () => {
  const candidates = [path.join(CWD, 'app.html'), path.join(CWD, 'dsh-plugin', 'app.html')]
  const appFile = candidates.find((file) => fs.existsSync(file))
  assert.ok(appFile, '找不到 app.html')
  const html = fs.readFileSync(appFile, 'utf8')
  assert.match(html, /id="taskBtn"/, '群输入区应有「发布任务」按钮')
  assert.match(html, /发布任务/, '按钮/弹窗文案应包含发布任务')
  assert.match(html, /id="taskModal"/, '应有发布任务弹窗')
  assert.match(html, /id="taskCoordinator"/, '弹窗应有组长下拉')
  assert.match(html, /id="taskMembers"/, '弹窗应有成员多选')
  assert.match(html, /function openTaskModal/, '应有打开任务弹窗的逻辑')
  assert.match(html, /function renderTaskCard/, '群聊应能渲染任务卡')
  assert.match(html, /data-task-detail/, '任务卡应可点开查看任务请求/状态')
  assert.match(html, /data-task-member/, '成员多选应有 checkbox')
  assert.ok(!/entry\.kind !== 'task'/.test(html), '群聊不应再过滤掉任务卡')
  assert.match(html, /entry\.kind === 'task'/, '群聊渲染应包含任务卡分支')
})

// ---------------------------------------------------------------- 收尾
fs.rmSync(targetedDir, { recursive: true, force: true })
fs.rmSync(contactDir, { recursive: true, force: true })
fs.rmSync(permDir, { recursive: true, force: true })
fs.rmSync(retractDir, { recursive: true, force: true })
fs.rmSync(healthDir, { recursive: true, force: true })
fs.rmSync(groupDir, { recursive: true, force: true })
fs.rmSync(boardDir, { recursive: true, force: true })
console.log('')
if (failures.length) {
  console.error(`FAILED ${failures.length} 项：`)
  for (const failure of failures) console.error(' - ' + failure)
  process.exitCode = 1
} else {
  console.log('ALL PASS')
}
