/**
 * Agent 工具白名单（FR-D03）自测：
 * 只有处于「短剧模式」的 Agent 才拿到 drama_* 工具；预设切走后工具被回收。
 * 运行：node test/agent-tools.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { apply } = await import(pathToFileURL(path.join(here, '..', 'index.js')).href)
// 工具清单以 lib/tools.js 为准，避免版本演进后再出现「13/12/26」这类陈旧硬编码。
const { DRAMA_TOOL_NAMES } = await import(pathToFileURL(path.join(here, '..', 'lib', 'tools.js')).href)
const TOOL_COUNT = DRAMA_TOOL_NAMES.length
/** 只读工具（index.js PARALLEL_SAFE 白名单），必须声明可并行。 */
const READ_ONLY_TOOLS = [
  'drama_list_projects', 'drama_get_project', 'drama_get_progress', 'drama_list_drafts',
  'drama_list_assets', 'drama_list_finalized', 'drama_get_ledger', 'drama_get_dialogue',
  'drama_read_episode', 'drama_search_context', 'drama_canvas_status',
]

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

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-tools-'))

function makeHarness() {
  const registered = []
  const listeners = new Map()
  const state = { capability: { mode: 'drama', disposed: false } }
  const commandSpecs = []
  const followups = []

  const toolsRegistry = {
    register(spec) {
      registered.push(spec)
      return () => {
        const i = registered.indexOf(spec)
        if (i >= 0) registered.splice(i, 1)
      }
    },
  }

  const commandsRegistry = {
    register(spec) {
      commandSpecs.push(spec)
      return () => {
        const i = commandSpecs.indexOf(spec)
        if (i >= 0) commandSpecs.splice(i, 1)
      }
    },
  }

  function makeAgent(id, opts = {}) {
    return {
      id,
      session: { header: { cwd: workspace } },
      // 生成类子命令通过 agent.followup 投递消息，桩里必须收集起来
      followup: (message) => followups.push(message),
      ctx: {
        get(name) {
          if (name === 'agentPresets') {
            if (opts.noPresetRegistry) return undefined
            return { serviceFor: () => state.capability }
          }
          if (name === 'tools') return opts.noTools ? undefined : toolsRegistry
          return undefined
        },
      },
    }
  }

  const agents = { list: () => state.agents }
  const warnings = []
  const ctx = {
    provide: () => {},
    inject(_services, callback) {
      callback({
        connection: { fetch: { register: () => {} } },
        agents,
        // attachCommands(ctx) 会注入 ['commands'] 并调用 scope.commands.register(...)：
        // 缺这个桩时 [7] 会 TypeError 崩溃（恢复版缺了这段接线）。
        commands: commandsRegistry,
        get: (n) => (n === 'agents' ? agents : undefined),
        on: (event, fn) => listeners.set(event, fn),
        effect: (fn) => fn(),
      })
    },
    logger: { info: () => {}, warn: (m) => warnings.push(String(m)) },
  }

  return { registered, listeners, state, ctx, makeAgent, warnings, commandSpecs, followups }
}

/* ------------------------------------------------------------------ [1] */
console.log('\n[1] 处于短剧模式的 Agent 拿到全部 drama_* 工具')
{
  const h = makeHarness()
  h.state.agents = [h.makeAgent('a-drama')]
  apply(h.ctx, {})
  if (h.warnings.length) console.log('    warnings:', h.warnings.join(' | '))
  check('挂载过程无告警', h.warnings.length === 0, h.warnings.join(' | '))
  check(`注册了 ${TOOL_COUNT} 个工具`, h.registered.length === TOOL_COUNT, String(h.registered.length))
  check('全部以 drama_ 开头', h.registered.every((t) => t.name.startsWith('drama_')))
  check('每个工具带 description', h.registered.every((t) => typeof t.description === 'string' && t.description.length > 8))
  check('每个工具带 JSON Schema parameters', h.registered.every((t) => t.parameters && t.parameters.type === 'object'))
  check('每个工具带 execute', h.registered.every((t) => typeof t.execute === 'function'))
  // 2026-10-17 事故回归：ToolDefinition 缺 output 时 register 抛错且被事件调度吞掉
  check('每个工具都带 output.schema', h.registered.every((t) => t.output && t.output.schema && typeof t.output.schema === 'object'))
  check('每个工具都带 output.render', h.registered.every((t) => t.output && typeof t.output.render === 'function'))
  check('output.render 返回文本块数组（34/34）', (() => {
    const bad = []
    for (const t of h.registered) {
      try {
        const blocks = t.output.render({}, { ok: true, title: '冒烟', items: [], count: 0 })
        if (!Array.isArray(blocks) || !blocks.length || !blocks.every((b) => b && b.type === 'text' && typeof b.text === 'string')) bad.push(t.name)
      } catch (error) {
        bad.push(`${t.name}: ${error instanceof Error ? error.message : error}`)
      }
    }
    h.renderBad = bad
    return bad.length === 0
  })(), (h.renderBad || []).join(' | '))
  check('只读工具声明 isConcurrencySafe', READ_ONLY_TOOLS.every((name) => {
    const t = h.registered.find((x) => x.name === name)
    return Boolean(t && typeof t.isConcurrencySafe === 'function')
  }), READ_ONLY_TOOLS.filter((name) => !h.registered.some((x) => x.name === name && typeof x.isConcurrencySafe === 'function')).join(','))
  check('写工具默认独占（如 drama_save_draft 无 isConcurrencySafe）', (() => {
    const t = h.registered.find((x) => x.name === 'drama_save_draft')
    return Boolean(t) && t.isConcurrencySafe === undefined
  })())
}

/* ------------------------------------------------------------------ [2] */
console.log('\n[2] 非短剧模式的 Agent 拿不到工具')
{
  const h = makeHarness()
  h.state.agents = [h.makeAgent('a-standard')]
  h.state.capability = undefined
  apply(h.ctx, {})
  check('没有注册任何工具', h.registered.length === 0, String(h.registered.length))
}

/* ------------------------------------------------------------------ [3] */
console.log('\n[3] 预设切走时回收已注册的工具')
{
  const h = makeHarness()
  h.state.agents = [h.makeAgent('a-1')]
  apply(h.ctx, {})
  check('初始已注册', h.registered.length === TOOL_COUNT, String(h.registered.length))

  h.state.capability = undefined
  const fire = h.listeners.get('agent-preset/selected')
  check('监听了 agent-preset/selected', typeof fire === 'function')
  fire('a-1')
  check('切换后工具被回收', h.registered.length === 0, String(h.registered.length))

  h.state.capability = { mode: 'drama', disposed: false }
  fire('a-1')
  check('切回后重新注册', h.registered.length === TOOL_COUNT, String(h.registered.length))
}

/* ------------------------------------------------------------------ [4] */
console.log('\n[4] 能力被标记 disposed 时同样回收')
{
  const h = makeHarness()
  h.state.agents = [h.makeAgent('a-1')]
  apply(h.ctx, {})
  h.state.capability = { mode: 'drama', disposed: true }
  h.listeners.get('agent-preset/selected')('a-1')
  check('disposed 后回收', h.registered.length === 0, String(h.registered.length))
}

/* ------------------------------------------------------------------ [5] */
console.log('\n[5] 边界：缺少服务时不崩、不误注册')
{
  const h = makeHarness()
  h.state.agents = [h.makeAgent('a-no-preset-registry', { noPresetRegistry: true })]
  let threw = false
  try {
    apply(h.ctx, {})
  } catch {
    threw = true
  }
  check('缺少 agentPresets 不抛错', !threw)
  check('缺少 agentPresets 不注册工具', h.registered.length === 0)

  const h2 = makeHarness()
  h2.state.agents = [h2.makeAgent('a-no-tools', { noTools: true })]
  let threw2 = false
  try {
    apply(h2.ctx, {})
  } catch {
    threw2 = true
  }
  check('缺少 tools 服务不抛错', !threw2)
}

/* ------------------------------------------------------------------ [6] */
console.log('\n[6] 同名工具冲突：给两个模式各注册一次互不影响')
{
  const h = makeHarness()
  h.state.agents = [h.makeAgent('a-1'), h.makeAgent('a-2')]
  apply(h.ctx, {})
  check('两个 Agent 共注册 2 倍工具', h.registered.length === TOOL_COUNT * 2, String(h.registered.length))
  h.state.agents = [h.makeAgent('a-1')]
  h.listeners.get('agent-preset/selected')('a-1')
  check('重复扫描不重复注册', h.registered.length === TOOL_COUNT * 2, String(h.registered.length))
}

/* ------------------------------------------------------------------ [7] */
console.log('\n[7] 斜杠命令 /drama（FR-D06）')
{
  const h = makeHarness()
  h.state.agents = [h.makeAgent('a-1')]
  apply(h.ctx, {})
  check('注册了 1 条命令', h.commandSpecs.length === 1, String(h.commandSpecs.length))
  const spec = h.commandSpecs[0]
  check('命令名为 drama', spec && spec.name === 'drama', spec && spec.name)
  check('命令名符合语法（小写）', /^[a-z0-9_-]+$/.test(spec.name))
  check('带 description', typeof spec.description === 'string' && spec.description.length > 8)
  check('带 input.hint', spec.input && typeof spec.input.hint === 'string')
  check('handler 是函数', typeof spec.handler === 'function')

  const run = (rawInput, agent) => spec.handler({ agent: agent || h.state.agents[0], rawInput })

  // 非短剧模式必须拒绝
  h.state.capability = undefined
  const denied = await run('项目')
  check('非短剧模式被拒绝', denied.kind === 'error' && denied.text.includes('短剧模式'), JSON.stringify(denied))
  h.state.capability = { mode: 'drama', disposed: false }

  const usage = await run('')
  check('空输入显示用法', usage.kind === 'success' && usage.text.includes('/drama'), usage.text.slice(0, 60))

  const list = await run('项目')
  check('「项目」子命令可用', list.kind === 'success' && list.text.includes('还没有'), list.text)

  const badExport = await run('导出')
  check('缺格式时报错并给出用法', badExport.kind === 'error' && badExport.text.includes('markdown'), badExport.text)

  const badFinal = await run('定稿 abc')
  check('定稿参数非法时报错', badFinal.kind === 'error' && badFinal.text.includes('用法'), badFinal.text)

  const unknown = await run('乱写')
  check('未知子命令报错并附用法', unknown.kind === 'error' && unknown.text.includes('未知子命令') && unknown.text.includes('/drama 项目'))

  const gen = await run('大纲 要 80 集')
  check('生成类子命令返回成功', gen.kind === 'success', JSON.stringify(gen))
  check('生成类子命令确实投递了消息', h.followups.length === 1, String(h.followups.length))
  const delivered = JSON.stringify(h.followups[0])
  check('投递内容提到能力与草稿区', delivered.includes('分集大纲') && delivered.includes('drama_save_draft'), delivered.slice(0, 140))

  const gen2 = await run('润色 台词再口语一点')
  check('第二次生成命令也投递', h.followups.length === 2, String(h.followups.length))

  const noCwd = await run('项目', { ctx: { get: () => ({ serviceFor: () => ({ mode: 'drama' }) }) }, session: { header: {} } })
  check('无工作范围时给出可读错误', noCwd.kind === 'error', JSON.stringify(noCwd))
}

await fs.rm(workspace, { recursive: true, force: true })

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
