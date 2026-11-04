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

const CWD = process.cwd()
const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-bridge-test-'))
const receiptPath = path.join(boardDir, '.plugin-loaded.json')

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
  assert.deepEqual([...toolByName.keys()].sort(), ['group_member', 'group_rule', 'group_skill', 'session_ask', 'session_board', 'session_discuss', 'session_identity', 'session_like', 'session_nudge', 'session_profile', 'session_share'])
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
  assert.deepEqual(properties.kind.enum, ['note', 'handoff', 'lesson', 'decision', 'chat'])
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
    'status'
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
  assert.match(result, /session-bridge v2\.6\.0/)
  assert.match(result, /工具：session_share, session_ask, session_nudge, group_rule, session_like, session_discuss, session_identity, group_member, group_skill, session_profile, session_board/)
  assert.match(result, /看板 API=是/)
  assert.ok(!/失败=(session_share|session_board)/.test(result), '不应有注册失败的工具')
})

await check('子会话可只读查看经验板（list / status）', async () => {
  const status = String(await board.execute({ action: 'status' }, { agent: subAgent }))
  assert.match(status, /session-bridge v2\.6\.0/)
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
})

await check('GET state 返回规则/群组/会话/送达结构', async () => {
  const { res, json } = await callState()
  assert.equal(res.out.status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.version, '2.6.0')
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
  assert.equal(receipt.version, '2.6.0')
  assert.deepEqual(receipt.tools.slice().sort(), ['group_member', 'group_rule', 'group_skill', 'session_ask', 'session_board', 'session_discuss', 'session_identity', 'session_like', 'session_nudge', 'session_profile', 'session_share'])
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
    (item) => item.hiddenFromChat === true && item.channel === 'world' && item.requestTo.includes(rootAgent.id)
  )
  assert.ok(hidden, '应为被派成员创建世界定向 request')
  assert.equal(captured.followups.length, 1, '应唤醒匹配成员')
  assert.equal(captured.followups[0].sessionId, rootAgent.id)
})

await check('world.post：无申报匹配时走新建会话（桩环境无 agents.create → 可读降级）', async () => {
  const world = await callCommand({ action: 'world.post', payload: { text: 'zzzz-no-match-qqqq 的任务' } })
  assert.equal(world.json.ok, true, JSON.stringify(world.json))
  assert.ok(world.json.createError, '桩环境应返回新建会话失败原因，而不是抛错')
})

await check('世界任务：正文 @ 直接派给指定成员', async () => {
  captured.followups.length = 0
  const result = await callCommand({
    action: 'world.post',
    payload: { text: '@论文写作-第一篇 帮我检查一下这段说明' }
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

// ---------------------------------------------------------------- 收尾
fs.rmSync(targetedDir, { recursive: true, force: true })
fs.rmSync(boardDir, { recursive: true, force: true })
console.log('')
if (failures.length) {
  console.error(`FAILED ${failures.length} 项：`)
  for (const failure of failures) console.error(' - ' + failure)
  process.exitCode = 1
} else {
  console.log('ALL PASS')
}
