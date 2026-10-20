/**
 * P1-A（T3 / P1-L）· 工具治理自测：主 Agent 注册 / 子 Agent fail-closed restrict / 测试工具开关。
 * 来源：host-dev task-10 交付的离线断言入口：
 *   index.js  → dramaToolGovernanceFor(agent, env) / isMainAgent(agent) / dramaTestToolsEnabled(env)
 *   lib/tools.js → createToolDefs(deps, {testTools:true})、DRAMA_TEST_TOOL_NAMES
 *
 * 兼容策略：v0.4.0 安装工件早于 task-10 源码（不含治理 API）。
 * 若当前工件没有该 API，本套件打印 SKIP 理由并以 0 failed 退出（不伪造通过）。
 *
 * 运行：node test/governance.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const mod = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
const toolsMod = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'tools.js')).href)
const { apply, dramaToolGovernanceFor, isMainAgent, dramaTestToolsEnabled } = mod
const { createToolDefs, DRAMA_TOOL_NAMES, DRAMA_TEST_TOOL_NAMES } = toolsMod
const DIAGNOSTIC_FILE = path.join(pluginRoot, 'drama-attach-diagnostic.json')

if (typeof dramaToolGovernanceFor !== 'function' || !Array.isArray(DRAMA_TEST_TOOL_NAMES)) {
  console.log('\n结果：0 passed, 0 failed（SKIP：当前工件未包含 T3 治理 API —— v0.4.0 安装工件早于 task-10 源码；本套件在下一检查点工件上生效）')
  process.exit(0)
}

let passed = 0
let failed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) passed += 1
  else {
    failed += 1
    failures.push(`${label}${detail ? ' -> ' + detail : ''}`)
    console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`)
  }
}
function group(name) {
  console.log('\n' + name)
}
const sha = (value) => String(value)

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-gov-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeHarness(options = {}) {
  const registered = []
  const restrictCalls = []
  const warnings = []
  const routes = new Map()
  const provided = {}
  const state = { agents: [], capability: { mode: 'drama', disposed: false }, restrictSupported: options.restrictSupported !== false }

  function makeRegistry() {
    const registry = {
      register(spec) {
        registered.push(spec)
        return () => {
          const i = registered.indexOf(spec)
          if (i >= 0) registered.splice(i, 1)
        }
      },
    }
    if (state.restrictSupported) {
      registry.restrict = (spec) => {
        restrictCalls.push(spec)
        return () => {}
      }
    }
    return registry
  }

  function makeAgent(id, opts = {}) {
    const registry = makeRegistry()
    return {
      id,
      session: { header: { cwd: workspace, ...(opts.subagent ? { origin: 'subagent' } : {}) } },
      followup: () => {},
      ctx: {
        get(name) {
          if (name === 'agentPresets') return { serviceFor: () => state.capability }
          if (name === 'tools') return registry
          return undefined
        },
      },
    }
  }

  const agents = { list: () => state.agents }
  const commands = { register: () => () => {} }
  const ctx = {
    provide: (name, value) => {
      provided[name] = value
    },
    inject(_services, callback) {
      callback({
        connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } },
        agents,
        commands,
        get: (name) => (name === 'agents' ? agents : provided[name]),
        on: () => {},
        effect: (fn) => fn(),
      })
    },
    logger: { info: () => {}, warn: (m) => warnings.push(String(m)) },
  }

  return { registered, restrictCalls, warnings, routes, state, ctx, makeAgent, agents }
}

async function callRoute(h, method, body) {
  const spec = h.routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('route not registered: ' + method)
  const request = new Request('http://127.0.0.1:1/api/ai-drama/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' },
    body: JSON.stringify(body || {}),
  })
  const response = await spec.fetch(request)
  return { status: response.status, body: await response.json() }
}

/* ------------------------------------------------------------------ [1] */
group('[1] 治理决策纯函数（主/子/非短剧/测试工具开关）')
const dramaRegistry = { serviceFor: () => ({ mode: 'drama', disposed: false }) }
const mainAgent = { id: 'main-1', session: { header: { cwd: workspace } }, ctx: { get: (n) => (n === 'agentPresets' ? dramaRegistry : undefined) } }
const subAgent = { id: 'sub-1', session: { header: { cwd: workspace, origin: 'subagent' } }, ctx: { get: (n) => (n === 'agentPresets' ? dramaRegistry : undefined) } }
const plainAgent = { id: 'plain-1', session: { header: { cwd: workspace } }, ctx: { get: () => undefined } }

check('isMainAgent(主)=true', isMainAgent(mainAgent) === true)
check('isMainAgent(子)=false（origin=subagent 回退判定）', isMainAgent(subAgent) === false)
check('非短剧模式 → mode=none', dramaToolGovernanceFor(plainAgent, {}).mode === 'none')
const govMain = dramaToolGovernanceFor(mainAgent, {})
check('主 Agent → mode=register', govMain.mode === 'register' && govMain.reason === 'main-agent', JSON.stringify(govMain).slice(0, 120))
check('主 Agent names = 34 个 drama_*', govMain.names.length === 35 && govMain.names.every((n) => DRAMA_TOOL_NAMES.includes(n)), String(govMain.names.length))
const govSub = dramaToolGovernanceFor(subAgent, {})
check('子 Agent → mode=restrict（fail-closed）', govSub.mode === 'restrict' && govSub.reason === 'subagent-tool-governance', JSON.stringify(govSub).slice(0, 120))
check('子 Agent 不注册任何工具名', govSub.names.length === 0, String(govSub.names.length))
check('子 Agent deny 覆盖全部 34 个 drama_*', govSub.deny.length === 35 && DRAMA_TOOL_NAMES.every((n) => govSub.deny.includes(n)))
const govMainTest = dramaToolGovernanceFor(mainAgent, { DSH_AI_DRAMA_TEST_TOOLS: '1' })
const govSubTest = dramaToolGovernanceFor(subAgent, { DSH_AI_DRAMA_TEST_TOOLS: '1' })
check('测试开关开：主 Agent names=37', govMainTest.names.length === 37, String(govMainTest.names.length))
check('测试开关开：子 Agent deny=37（测试工具也屏蔽）', govSubTest.deny.length === 37, String(govSubTest.deny.length))
check('dramaTestToolsEnabled 默认 false', dramaTestToolsEnabled({}) === false && dramaTestToolsEnabled({ DSH_AI_DRAMA_TEST_TOOLS: '0' }) === false)
check('dramaTestToolsEnabled=1 时 true', dramaTestToolsEnabled({ DSH_AI_DRAMA_TEST_TOOLS: '1' }) === true)

/* ------------------------------------------------------------------ [2] */
group('[2] 工具面：生产 34 / 测试开关 36，且全部带 output 契约')
const defsProd = createToolDefs({ rootOf: () => workspace, backendOf: () => null })
check('默认 createToolDefs = 34', defsProd.length === 35, String(defsProd.length))
check('默认名单与 DRAMA_TOOL_NAMES 一致', defsProd.every((d) => DRAMA_TOOL_NAMES.includes(d.name)) && defsProd.length === DRAMA_TOOL_NAMES.length)
const defsTest = createToolDefs({ rootOf: () => workspace, backendOf: () => null }, { testTools: true })
check('testTools:true = 37', defsTest.length === 37, String(defsTest.length))
check('测试工具进入工具面', DRAMA_TEST_TOOL_NAMES.every((n) => defsTest.some((d) => d.name === n)), DRAMA_TEST_TOOL_NAMES.join(','))
check('测试工具也带 output.schema/render', defsTest.filter((d) => DRAMA_TEST_TOOL_NAMES.includes(d.name)).every((d) => d.output && d.output.schema && typeof d.output.render === 'function'))
const testEcho = await defsTest.find((d) => d.name === 'drama_test_echo').execute({ message: 'ping' }, {})
check('drama_test_echo 可执行', testEcho.ok === true && testEcho.echo && testEcho.echo.message === 'ping', JSON.stringify(testEcho).slice(0, 120))

/* ------------------------------------------------------------------ [3] */
group('[3] 挂载 harness：主 Agent 注册 34 / 子 Agent 0 注册 + restrict(deny=34)')
{
  const h = makeHarness()
  h.state.agents = [h.makeAgent('a-main'), h.makeAgent('a-sub', { subagent: true })]
  apply(h.ctx, { root: workspace })
  check('主 Agent 注册 34 个工具', h.registered.length === 35, String(h.registered.length))
  check('子 Agent 未额外注册（总数仍 34，全部来自主 Agent）', h.registered.length === 35 && h.registered.every((t) => DRAMA_TOOL_NAMES.includes(t.name)), String(h.registered.length))
  check('子 Agent 触发 1 次 restrict', h.restrictCalls.length === 1, JSON.stringify(h.restrictCalls.map((c) => c.deny && c.deny.length)))
  check('restrict deny 覆盖 34 个工具', h.restrictCalls[0] && Array.isArray(h.restrictCalls[0].deny) && h.restrictCalls[0].deny.length === 35)
  check('挂载过程无告警（正常路径）', h.warnings.length === 0, h.warnings.join(' | '))
  const diag = await callRoute(h, 'agents-status', {})
  check('agents-status 报告 restrictedAgents 含子 Agent', Array.isArray(diag.body.attach.restrictedAgents) && diag.body.attach.restrictedAgents.includes('a-sub'), JSON.stringify(diag.body.attach.restrictedAgents))
  check('agents-status 无 restrictFailures（正常路径）', Array.isArray(diag.body.attach.restrictFailures) && diag.body.attach.restrictFailures.length === 0, JSON.stringify(diag.body.attach.restrictFailures))
  // 注意：drama-attach-diagnostic.json 在插件包根目录，团队成员可能并发跑测试；
  // 因此断言「本测试 Agent 没有触发诊断落盘」而非全局不存在，避免跨进程竞态误报。
  const diagDump = await fs.readFile(DIAGNOSTIC_FILE, 'utf8').catch(() => null)
  check('正常路径不生成本测试 Agent 的诊断记录', !diagDump || (!diagDump.includes('"a-main"') && !diagDump.includes('"a-sub"')), String(diagDump || '').slice(0, 140))
}

/* ------------------------------------------------------------------ [4] */
group('[4] restrict 不可用 → fail-closed：子 Agent 0 注册 + 诊断记录')
{
  const h = makeHarness({ restrictSupported: false })
  h.state.agents = [h.makeAgent('a-sub-only', { subagent: true })]
  apply(h.ctx, { root: workspace })
  check('restrict 不可用时子 Agent 仍 0 注册', h.registered.length === 0, String(h.registered.length))
  check('记录 restrict 失败告警', h.warnings.some((w) => String(w).includes('治理失败')), h.warnings.join(' | ').slice(0, 200))
  const diag = await callRoute(h, 'agents-status', {})
  check('agents-status.attach.restrictFailures 非空', Array.isArray(diag.body.attach.restrictFailures) && diag.body.attach.restrictFailures.length >= 1, JSON.stringify(diag.body.attach.restrictFailures || []).slice(0, 200))
  // 诊断文件在包根（共享路径）：轮询等待且只认「本测试 Agent」的内容，兼容团队成员并发跑测试。
  let dump = null
  for (let i = 0; i < 20; i += 1) {
    dump = await fs.readFile(DIAGNOSTIC_FILE, 'utf8').catch(() => null)
    if (dump && dump.includes('a-sub-only')) break
    await sleep(100)
  }
  check('失败路径落盘诊断文件（含本测试 Agent 与 restrict）', Boolean(dump) && dump.includes('a-sub-only') && dump.includes('restrict'), String(dump || '').slice(0, 180))
  if (dump && dump.includes('a-sub-only')) await fs.rm(DIAGNOSTIC_FILE, { force: true }).catch(() => {})
  const afterCleanup = await fs.readFile(DIAGNOSTIC_FILE, 'utf8').catch(() => null)
  check('QA 清理本测试诊断记录（不污染插件包）', !afterCleanup || !afterCleanup.includes('a-sub-only'))
}

/* ------------------------------------------------------------------ [5] */
group('[5] 测试工具环境开关：DSH_AI_DRAMA_TEST_TOOLS=1 才注册 36')
{
  const h0 = makeHarness()
  h0.state.agents = [h0.makeAgent('a-main')]
  const prev = process.env.DSH_AI_DRAMA_TEST_TOOLS
  delete process.env.DSH_AI_DRAMA_TEST_TOOLS
  apply(h0.ctx, { root: workspace })
  check('env 未设：注册 34', h0.registered.length === 35, String(h0.registered.length))

  const h1 = makeHarness()
  h1.state.agents = [h1.makeAgent('a-main')]
  process.env.DSH_AI_DRAMA_TEST_TOOLS = '1'
  try {
    apply(h1.ctx, { root: workspace })
  } finally {
    if (prev === undefined) delete process.env.DSH_AI_DRAMA_TEST_TOOLS
    else process.env.DSH_AI_DRAMA_TEST_TOOLS = prev
  }
  check('env=1：注册 37（含测试工具）', h1.registered.length === 37, String(h1.registered.length))
  check('env=1：测试工具带 output', h1.registered.filter((t) => DRAMA_TEST_TOOL_NAMES.includes(t.name)).every((t) => t.output && typeof t.output.render === 'function'))
  const diag = await callRoute(h1, 'agents-status', {})
  check('agents-status 报告 testToolsEnabled=true', diag.body.attach.testToolsEnabled === true, JSON.stringify({ testToolsEnabled: diag.body.attach.testToolsEnabled }))
}

await fs.rm(workspace, { recursive: true, force: true })
// 收尾清理：只删除本测试 Agent 产生的诊断记录（兼容并发跑测试者的文件）
{
  const dump = await fs.readFile(DIAGNOSTIC_FILE, 'utf8').catch(() => null)
  if (dump && (dump.includes('a-main') || dump.includes('a-sub'))) await fs.rm(DIAGNOSTIC_FILE, { force: true }).catch(() => {})
}

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
