/**
 * P1-M / T4 运行期上下文注入自测：状态卡纯函数 + systemPrompt.context 注册 + 写后反馈 / 切项目同步。
 * 来源：host-dev task-14：
 *   lib/context-card.js → { buildDramaContextCard, summarizeWriteFeedback, MAX_CONTEXT_CHARS, CONTEXT_BLOCK_TITLE }
 *   index.js → 为短剧模式主 Agent 注册 systemPrompt.context（name=drama-runtime-context），
 *              `agents-status.attach.contextAgents` 可观测；工具执行后异步刷新（写后反馈 / 切项目同步）。
 *
 * 兼容策略：v0.4.0 安装工件早于 task-14 源码（无 lib/context-card.js）→ 显式 SKIP。
 *
 * 运行：node test/context-card.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')

let cardMod = null
try {
  cardMod = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'context-card.js')).href)
} catch {
  cardMod = null
}
if (!cardMod || typeof cardMod.buildDramaContextCard !== 'function') {
  console.log('\n结果：0 passed, 0 failed（SKIP：当前工件未包含 T4 上下文注入 lib/context-card.js —— v0.4.0 安装工件早于 task-14 源码；本套件在下一检查点工件上生效）')
  process.exit(0)
}

const { buildDramaContextCard, summarizeWriteFeedback, MAX_CONTEXT_CHARS, CONTEXT_BLOCK_TITLE } = cardMod
const store = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'store.js')).href)
const { apply } = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(50)
  }
  return false
}

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-ctx-'))

/* ------------------------------------------------------------------ [1] */
console.log('\n[1] 常量与无项目状态卡')
check('MAX_CONTEXT_CHARS = 8000', MAX_CONTEXT_CHARS === 8000, String(MAX_CONTEXT_CHARS))
check('块标题 = 短剧上下文', CONTEXT_BLOCK_TITLE === '短剧上下文', String(CONTEXT_BLOCK_TITLE))
const emptyCard = buildDramaContextCard({})
// v0.16.0 A-S1：无项目文案中性化（不催促建项、不点名建项工具）。删旧增新：原 1 条 → 2 条更强断言。
check('无项目卡含标题/中性未创建提示（A-S1：未打开/未创建，不暗示主动建项）', emptyCard.startsWith(`## ${CONTEXT_BLOCK_TITLE}`) && emptyCard.includes('未打开/未创建'), emptyCard.slice(0, 160))
check('无项目卡不点名建项工具且提示需用户明确说明（A-S1：无 drama_create_project）', !emptyCard.includes('drama_create_project') && emptyCard.includes('如用户需要新建，请明确说明'), emptyCard.slice(0, 200))
check('无项目卡 ≤8K', emptyCard.length <= MAX_CONTEXT_CHARS, String(emptyCard.length))

/* ------------------------------------------------------------------ [2] */
console.log('\n[2] 全量状态卡内容（AC-07 要求字段）')
const fullCard = buildDramaContextCard({
  title: '上下文样剧',
  progress: { stage: 'storyboard', facts: { outlineCount: 2, characterCount: 2, episodeCount: 2 } },
  contract: { platform: '抖音', audience: '下沉市场', episodeDurationSec: [60, 120], targetEpisodes: 80, orientation: 'portrait', hookDensity: '每 25 秒一个钩子', redlines: '无血腥' },
  outline: [
    { order: 1, title: '刀在颈侧', logline: '倒爷被逼债' },
    { order: 2, title: '第一桶金', logline: '倒卖灵药' },
  ],
  characters: [
    { name: '林越', role: '主角' },
    { name: '赵铁', role: '反派' },
  ],
  episodes: [{ order: 1 }, { order: 2 }],
  storyboards: { 1: 3, 2: 3 },
  memory: [
    { kind: '伏笔', content: '幕后黑手是师门叛徒', status: 'open' },
    { kind: '已用桥段', content: '刀在颈侧反杀', status: 'resolved' },
    { kind: '时间线', content: '故事起于雨夜', status: 'open' },
  ],
})
check('含当前项目与阶段', fullCard.includes('当前项目：《上下文样剧》') && fullCard.includes('分镜就绪'), fullCard.slice(0, 200))
check('含契约摘要（平台/时长/集数/画幅/红线）', fullCard.includes('契约：平台 抖音') && fullCard.includes('单集 60~120 秒') && fullCard.includes('目标 80 集') && fullCard.includes('竖屏') && fullCard.includes('红线 无血腥'))
check('含人物索引', fullCard.includes('人物索引（2 人）') && fullCard.includes('林越（主角）') && fullCard.includes('赵铁（反派）'))
check('含总纲/前情提要', fullCard.includes('总纲：共 2 集') && fullCard.includes('前情提要'))
check('含分集/分镜统计', fullCard.includes('分集：已有剧本 2 集') && fullCard.includes('分镜 6 镜'))
check('含本剧记忆与待回收伏笔', fullCard.includes('本剧记忆：3 条') && fullCard.includes('伏笔 1') && fullCard.includes('待回收伏笔'))
check('全量卡 ≤8K', fullCard.length <= MAX_CONTEXT_CHARS, String(fullCard.length))

/* ------------------------------------------------------------------ [3] */
console.log('\n[3] 超长输入截断（≤ MAX_CONTEXT_CHARS）')
const huge = buildDramaContextCard({
  title: '超长样剧',
  contract: { platform: '抖音', redlines: '红'.repeat(2000) },
  characters: Array.from({ length: 200 }, (_, i) => ({ name: `角色${i}`, role: '配角' })),
  outline: Array.from({ length: 200 }, (_, i) => ({ order: i + 1, title: `第${i + 1}集标题`, logline: '梗'.repeat(120) })),
  memory: Array.from({ length: 300 }, () => ({ kind: '伏笔', content: '伏'.repeat(80), status: 'open' })),
  lastWrite: { summary: '写'.repeat(500), at: '2026-10-17T05:00:00.000Z' },
})
check('超长输入被截断到 ≤8K', huge.length <= MAX_CONTEXT_CHARS, String(huge.length))
check('超长输入给出截断标记', huge.includes('（已截断）') || huge.length <= MAX_CONTEXT_CHARS, huge.slice(-40))

/* ------------------------------------------------------------------ [4] */
console.log('\n[4] 写后反馈纯函数 summarizeWriteFeedback')
check('契约写入反馈', summarizeWriteFeedback('drama_save_contract', { title: 'x' }, { ok: true }).includes('剧集契约'))
check('大纲写入反馈', summarizeWriteFeedback('drama_save_outline', { title: 'x', rows: [{}, {}] }, { ok: true }).includes('分集大纲'))
check('定稿反馈含集数/镜头/版本', (() => {
  const text = summarizeWriteFeedback('drama_finalize_episode', { order: 1 }, { ok: true, version: 2, shots: 3 })
  return text.includes('定稿') && text.includes('第 1 集') && text.includes('3 镜') && text.includes('v2')
})(), summarizeWriteFeedback('drama_finalize_episode', { order: 1 }, { ok: true, version: 2, shots: 3 }))
check('素材登记反馈含字节数', summarizeWriteFeedback('drama_add_asset', {}, { ok: true, bytes: 1234 }).includes('1234 字节'))
check('未知工具回退为工具名标签', summarizeWriteFeedback('drama_unknown_x', {}, { ok: true }).includes('drama_unknown_x'))

/* ------------------------------------------------------------------ [5] */
console.log('\n[5] 运行期注册：systemPrompt.context + agents-status.contextAgents')
const TITLE_A = '上下文样剧'
const TITLE_B = '上下文二剧'
await store.createProject(workspace, TITLE_A)
await store.saveContract(workspace, TITLE_A, { platform: '抖音', episodeDurationSec: [60, 120], targetEpisodes: 80, redlines: '无血腥' })
await store.saveCharacters(workspace, TITLE_A, [{ name: '林越', role: '主角' }, { name: '赵铁', role: '反派' }])
await store.saveOutline(workspace, TITLE_A, [{ order: 1, title: '刀在颈侧', logline: '倒爷被逼债' }])
await store.writeEpisode(workspace, TITLE_A, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：这钱，我三天还你。\n')
await store.createProject(workspace, TITLE_B)
await store.saveContract(workspace, TITLE_B, { platform: '快手', redlines: '无暴力' })

const routes = new Map()
const provided = {}
const contextSpecs = []
const registeredTools = new Map()
const warnings = []
const state = { agents: [] }

function makeAgent(id, opts = {}) {
  const toolsRegistry = {
    register(definition) {
      registeredTools.set(definition.name, definition)
      return () => registeredTools.delete(definition.name)
    },
    // 治理 fail-closed 会在子 Agent 上调用 restrict；这里提供 no-op 避免测试触发诊断文件落盘。
    restrict() {
      return () => {}
    },
  }
  return {
    id,
    session: { header: { cwd: workspace, ...(opts.subagent ? { origin: 'subagent' } : {}) } },
    followup: () => {},
    ctx: {
      get(name) {
        if (name === 'agentPresets') return { serviceFor: () => (opts.noDrama ? undefined : { mode: 'drama', disposed: false }) }
        if (name === 'tools') return toolsRegistry
        if (name === 'systemPrompt') {
          if (opts.noSystemPrompt) return undefined
          return {
            context(spec) {
              contextSpecs.push(spec)
              return () => {}
            },
          }
        }
        return undefined
      },
    },
  }
}
const agents = { list: () => state.agents }
const ctx = {
  provide: (name, value) => {
    provided[name] = value
  },
  inject(_services, callback) {
    callback({
      connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } },
      agents,
      commands: { register: () => () => {} },
      get: (name) => (name === 'agents' ? agents : provided[name]),
      on: () => {},
      effect: (fn) => fn(),
    })
  },
  logger: { info: () => {}, warn: (m) => warnings.push(String(m)) },
}
const mainAgent = makeAgent('ctx-main')
const plainAgent = makeAgent('ctx-plain', { noDrama: true })
const subAgent = makeAgent('ctx-sub', { subagent: true })
state.agents = [mainAgent, plainAgent, subAgent]
apply(ctx, { root: workspace })
await sleep(100)

check('短剧主 Agent 注册了 1 个 systemPrompt.context', contextSpecs.length === 1, String(contextSpecs.length))
check('context name=drama-runtime-context / order=250', contextSpecs[0] && contextSpecs[0].name === 'drama-runtime-context' && contextSpecs[0].order === 250, JSON.stringify({ name: contextSpecs[0] && contextSpecs[0].name, order: contextSpecs[0] && contextSpecs[0].order }))
check('context.text 是同步函数（provider 可同步读缓存）', contextSpecs[0] && typeof contextSpecs[0].text === 'function')
const apiSpec = routes.get('/api/ai-drama/agents-status')
let agentsStatus = null
if (apiSpec) {
  const response = await apiSpec.fetch(new Request('http://127.0.0.1:1/api/ai-drama/agents-status', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' }, body: '{}' }))
  agentsStatus = await response.json()
}
check('agents-status.attach.contextAgents 含短剧主 Agent', Boolean(agentsStatus) && Array.isArray(agentsStatus.attach.contextAgents) && agentsStatus.attach.contextAgents.includes('ctx-main'), JSON.stringify(agentsStatus && agentsStatus.attach.contextAgents))
check('非短剧/子 Agent 不注册 context', !agentsStatus || !agentsStatus.attach.contextAgents.includes('ctx-plain'))

const readContext = () => (contextSpecs[0] && typeof contextSpecs[0].text === 'function' ? String(contextSpecs[0].text() || '') : '')
check('上下文快照最终就绪（含 短剧上下文 块）', await waitFor(() => readContext().includes(`## ${CONTEXT_BLOCK_TITLE}`)), readContext().slice(0, 120))
// 初始快照可能自动选中任一项目；显式用带 title 的读工具切到 A 后再断言 A 的字段。
const getProjectTool = registeredTools.get('drama_get_project')
check('已注册 drama_get_project', Boolean(getProjectTool))
await getProjectTool.execute({ title: TITLE_A }, { agent: mainAgent })
check('切换 A 后上下文含当前项目 A', await waitFor(() => readContext().includes(`当前项目：《${TITLE_A}》`)), readContext().slice(0, 160))
const contextA = readContext()
check('上下文含契约/人物/总纲/记忆字段', contextA.includes('契约：') && contextA.includes('人物索引') && contextA.includes('总纲') && contextA.includes('本剧记忆'), contextA.slice(0, 240))
check('上下文含 A 的人物索引（林越）', contextA.includes('林越'), contextA.slice(0, 240))
check('上下文 ≤8K', contextA.length <= MAX_CONTEXT_CHARS, String(contextA.length))

/* ------------------------------------------------------------------ [6] */
console.log('\n[6] 写后反馈：写工具执行后下一轮上下文出现「最近写入」')
const saveContractTool = registeredTools.get('drama_save_contract')
check('短剧主 Agent 已注册 drama_save_contract', Boolean(saveContractTool))
const writeResult = await saveContractTool.execute({ title: TITLE_A, contract: { platform: '抖音', targetEpisodes: 80, redlines: '无血腥' } }, { agent: mainAgent })
check('写工具执行成功', writeResult && writeResult.ok === true, JSON.stringify(writeResult).slice(0, 120))
check('写后反馈出现在上下文', await waitFor(() => readContext().includes('最近写入（写后反馈）')), readContext().slice(-240))
check('写后反馈包含契约写入摘要', readContext().includes('剧集契约') || readContext().includes('最近写入'))

/* ------------------------------------------------------------------ [7] */
console.log('\n[7] 切项目：带 title 的读工具调用后，下一轮上下文同步到新项目')
await getProjectTool.execute({ title: TITLE_B }, { agent: mainAgent })
check('切项目后上下文显示新项目名', await waitFor(() => readContext().includes(`当前项目：《${TITLE_B}》`)), readContext().slice(0, 160))
const contextB = readContext()
check('切项目后上下文不再含旧项目名', !contextB.includes(TITLE_A), contextB.slice(0, 200))
check('切项目后契约同步（快手）', contextB.includes('快手'), contextB.slice(0, 240))

await fs.rm(workspace, { recursive: true, force: true })
// 清理本测试可能触发的诊断文件（仅当内容属于本测试 Agent；不误删他人产物）
{
  const diagnosticFile = path.join(pluginRoot, 'drama-attach-diagnostic.json')
  const dump = await fs.readFile(diagnosticFile, 'utf8').catch(() => null)
  if (dump && (dump.includes('ctx-main') || dump.includes('ctx-sub') || dump.includes('ctx-plain'))) {
    await fs.rm(diagnosticFile, { force: true }).catch(() => {})
  }
}
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
