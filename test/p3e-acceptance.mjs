/**
 * v0.9.2 验收套件：P3-E 成本档位路由（costTier）· QA task-67 A 段
 *
 * 覆盖（假 LLM，0 真实模型）：
 *   [0] 能力检测：lib/model-routing.js + costTier 落地；未落地 → SKIP（旧版本基线不回归）
 *   [1] AC-E1：未配置 costTier = 与 v0.9.1 同输入同输出（显式基线：meta 不出现 costTier* 字段，
 *       findings/degraded/promptRevision/model/modelSource 与基线一致）
 *   [2] AC-E2：显式 costTierModels.fast/strong → 实际 provider/model 生效 + meta 四字段
 *       （costTier/costTierRequested/costTierFallback=false/costTierFallbackReason=null）；standard 走默认链
 *   [3] AC-E3：档位不可用（映射模型 resolveModelInfo 拒绝）→ tier-unavailable 回退；
 *       未配置映射 → no-model-mapping 回退；均不报错、不阻断、meta 标记
 *   [4] AC-E4：非法 costTier / costTierModels → settings-save HTTP 400 invalid-args（合法配置 200）
 *   [5] AC-E5：工程红线（工具 34/METHODS 68/无新依赖/旧数据 32 hash）+ client 静态标记
 *   [6] 契约：meta.costTier* 只增字段类型合法（src 侧 assertReviewSchema / 契约套件另行断言）
 *
 * 运行：node test/p3e-acceptance.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const libDir = path.join(pluginRoot, 'lib')
const hostSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8').catch(() => '')
const routingSrc = await fs.readFile(path.join(libDir, 'model-routing.js'), 'utf8').catch(() => '')

/* ------------------------------------------------------------------ [0] 能力检测 */
if (!routingSrc.includes('COST_TIERS') || !/costTier/.test(routingSrc)) {
  console.log('\n结果：0 passed, 0 failed（SKIP：P3-E costTier 尚未落地（lib/model-routing.js 缺失/未含 costTier）；落地后本套件自动生效）')
  process.exit(0)
}

const { apply, METHODS } = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
const store = await import(pathToFileURL(path.join(libDir, 'store.js')).href)
const toolsMod = await import(pathToFileURL(path.join(libDir, 'tools.js')).href)
const routing = await import(pathToFileURL(path.join(libDir, 'model-routing.js')).href)
const auditMod = await import(pathToFileURL(path.join(libDir, 'audit.js')).href)

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
const reviewOf = (result) => (result && result.deep && result.deep.review) || null
const metaOf = (result) => (reviewOf(result) && reviewOf(result).meta) || {}

/* ------------------------------------------------------------------ 夹具 */
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-p3e-'))
const TITLE = 'P3E 档位样剧'
const AGENT_SELECTION = { provider: 'agent-p', model: 'agent-m' }
const EPISODE = `# 第001集 档位样剧

## 场景 1：内景 - 当铺 - 夜

赵铁带着两个人踹开当铺的门，把一张泛黄的当票拍在柜台上。

赵铁：三年前的账，今天到期。
林越：账我认。可你这张当票，是假的。

林越把当票翻过来，凑近灯下，用指甲在背面轻轻一刮。

赵铁：你……
林越：三天后你来，把真当票带来。

赵铁转身掀帘出去。林越合上底册，锁好柜台。`
const VALID_FINDING = {
  severity: 'medium',
  dimension: 'hook_pacing',
  location: { episode: 1, scene: 1 },
  evidence: '赵铁带着两个人踹开当铺的门',
  suggestion: '第1集场1开场补强冲突特写',
  confidence: 0.8,
}

await store.createProject(workspace, TITLE)
await store.saveContract(workspace, TITLE, {
  platform: '抖音',
  audience: '18-35 岁竖屏短剧受众',
  episodeDurationSec: [60, 120],
  targetEpisodes: 80,
  orientation: 'portrait',
  hookDensity: '每 25~30 秒一个钩子',
  redlines: ['不出现违法细节'],
})
await store.saveOutline(workspace, TITLE, [{ order: 1, title: '第1集', logline: '林越识破假当票', hook: '赵铁踹门催债', twist: '假当票被识破', cliffhanger: '赵铁撂下三天期限', estDurationSec: 90 }])
await store.saveCharacters(workspace, TITLE, [
  { name: '林越', role: '主角', personality: ['冷静', '隐忍'], bio: '当铺朝奉' },
  { name: '赵铁', role: '反派', personality: ['暴躁'], bio: '放贷人' },
])
await store.writeEpisode(workspace, TITLE, 1, EPISODE)
await store.saveStoryboard(workspace, TITLE, 1, [
  { shotNumber: '1-1', shotSize: '近景', cameraMove: '推', description: '赵铁把当票拍在柜台上', dialogue: '赵铁：三年前的账，今天到期。', durationSec: 6 },
])

function makeFakeLlm(options = {}) {
  const calls = []
  const resolved = []
  const unavailable = new Set(options.unavailable || [])
  return {
    calls,
    resolved,
    async resolveModelInfo(provider, model) {
      resolved.push({ provider, model })
      if (unavailable.has(model)) throw new Error('模型不可用（QA 假 llm）')
      return { provider, model, available: true }
    },
    async *stream(opts) {
      calls.push({ provider: opts.provider, model: opts.model })
      const body = JSON.stringify({ findings: [VALID_FINDING], summary: '档位样剧输出' })
      const half = Math.ceil(body.length / 2)
      yield { type: 'text-delta', text: body.slice(0, half) }
      yield { type: 'text-delta', text: body.slice(half) }
      yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}
function auditDef(llm) {
  return toolsMod
    .createToolDefs({ rootOf: () => workspace, backendOf: () => null, llmOf: () => llm, modelSelectionOf: () => AGENT_SELECTION })
    .find((def) => def.name === 'drama_check_consistency')
}
function mkExec() {
  return {
    agent: { id: 'qa-p3e', session: { header: { cwd: workspace } }, ctx: { get: (name) => (name === 'agentPresets' ? { serviceFor: () => ({ mode: 'drama', disposed: false }) } : undefined) } },
    callId: 'p3e-' + Math.random().toString(36).slice(2, 8),
  }
}
async function runDeep(llm) {
  return auditDef(llm).execute({ title: TITLE, episode: 1, deep: true }, mkExec())
}
async function saveSettings(settings) {
  return store.saveSettings(workspace, settings)
}

/* 显式基线（v0.9.1 未配置 costTier 的抓取快照，见证据 P3-E-默认基线-v0.9.1-2026-10-18.json） */
const DEFAULT_META_KEYS = ['budget', 'degradeReason', 'degraded', 'elapsedMs', 'mode', 'model', 'modelFallback', 'modelFallbackReason', 'modelRetried', 'modelSource', 'promptRevision', 'promptVersion', 'provider', 'rawModelOutputSnippet', 'tokens']

/* ------------------------------------------------------------------ [1] AC-E1 */
group('[1] AC-E1：未配置 costTier = 与 v0.9.1 同输入同输出（显式基线）')
await saveSettings({ taskModels: {} })
const e1Llm = makeFakeLlm()
const e1Result = await runDeep(e1Llm)
const e1Review = reviewOf(e1Result)
const e1Meta = (e1Review && e1Review.meta) || {}
check('AC-E1：未配置 → deep 成功（非降级、findings 1 条）', Boolean(e1Review) && e1Review.degraded === false && (e1Review.findings || []).length === 1, JSON.stringify({ degraded: e1Review && e1Review.degraded, findings: (e1Review && e1Review.findings || []).length }).slice(0, 160))
check('AC-E1：未配置 → meta 不出现任何 costTier* 字段', !Object.keys(e1Meta).some((key) => key.startsWith('costTier')), JSON.stringify(Object.keys(e1Meta)))
const e1KeySet = Object.keys(e1Meta).sort()
check('AC-E1：meta 键集合与 v0.9.1 基线一致（无新增字段）', JSON.stringify(e1KeySet) === JSON.stringify(DEFAULT_META_KEYS), JSON.stringify(e1KeySet))
check('AC-E1：基线字段值一致（mode=model / model / provider / modelSource=agent-default / degraded=false）', e1Meta.mode === 'model' && e1Meta.model === 'agent-m' && e1Meta.provider === 'agent-p' && e1Meta.modelSource === 'agent-default' && e1Meta.degraded === false, JSON.stringify({ mode: e1Meta.mode, model: e1Meta.model, provider: e1Meta.provider, modelSource: e1Meta.modelSource, degraded: e1Meta.degraded }).slice(0, 200))
check('AC-E1：promptRevision 为 f 系列（f4）', typeof e1Meta.promptRevision === 'string' && /^f\d+$/.test(e1Meta.promptRevision), String(e1Meta.promptRevision))
check('AC-E1：实际模型调用仍为宿主默认（agent-p/agent-m）', e1Llm.calls.length === 1 && e1Llm.calls[0].model === 'agent-m' && e1Llm.calls[0].provider === 'agent-p', JSON.stringify(e1Llm.calls))

/* ------------------------------------------------------------------ [2] AC-E2 */
group('[2] AC-E2：显式 costTierModels.fast/strong → 解析生效 + meta 记录')
const FAST = { provider: 'fast-p', model: 'fast-m' }
await saveSettings({ taskModels: { audit: { costTier: 'fast', costTierModels: { fast: FAST } } } })
const fastLlm = makeFakeLlm()
const fastResult = await runDeep(fastLlm)
const fastMeta = metaOf(fastResult)
check('AC-E2：fast 档位实际调用 fast-p/fast-m', fastLlm.calls.some((call) => call.model === FAST.model && call.provider === FAST.provider), JSON.stringify(fastLlm.calls))
check('AC-E2：fast meta.costTier=fast / costTierRequested=fast / costTierFallback=false / reason=null', fastMeta.costTier === 'fast' && fastMeta.costTierRequested === 'fast' && fastMeta.costTierFallback === false && fastMeta.costTierFallbackReason === null, JSON.stringify({ costTier: fastMeta.costTier, requested: fastMeta.costTierRequested, fallback: fastMeta.costTierFallback, reason: fastMeta.costTierFallbackReason }))
check('AC-E2：fast 生效时 modelSource=cost-tier', fastMeta.modelSource === 'cost-tier', String(fastMeta.modelSource))
const STRONG = { provider: 'strong-p', model: 'strong-m' }
await saveSettings({ taskModels: { audit: { model: 'std-m', costTier: 'strong', costTierModels: { strong: STRONG } } } })
const strongLlm = makeFakeLlm()
const strongResult = await runDeep(strongLlm)
const strongMeta = metaOf(strongResult)
check('AC-E2：strong 档位实际调用 strong-p/strong-m（优先于 task 模型）', strongLlm.calls.some((call) => call.model === STRONG.model && call.provider === STRONG.provider), JSON.stringify(strongLlm.calls))
check('AC-E2：strong meta.costTier=strong / fallback=false', strongMeta.costTier === 'strong' && strongMeta.costTierRequested === 'strong' && strongMeta.costTierFallback === false, JSON.stringify({ costTier: strongMeta.costTier, requested: strongMeta.costTierRequested, fallback: strongMeta.costTierFallback }))
await saveSettings({ taskModels: { audit: { costTier: 'standard' } } })
const stdLlm = makeFakeLlm()
const stdResult = await runDeep(stdLlm)
const stdMeta = metaOf(stdResult)
check('AC-E2：standard 走默认链（调用宿主默认，无档位映射）', stdLlm.calls.length === 1 && stdLlm.calls[0].model === 'agent-m' && stdMeta.costTier === 'standard' && stdMeta.costTierFallback === false, JSON.stringify({ calls: stdLlm.calls, meta: { costTier: stdMeta.costTier, fallback: stdMeta.costTierFallback } }))
const pureTierSave = await saveSettings({ taskModels: { audit: { costTier: 'fast', costTierModels: { fast: FAST } } } })
check('AC-E2：仅档位+映射（无 model）可保存（model OR costTier 校验）', Boolean(pureTierSave && pureTierSave.taskModels && pureTierSave.taskModels.audit && pureTierSave.taskModels.audit.costTier === 'fast'), JSON.stringify(pureTierSave && pureTierSave.taskModels && pureTierSave.taskModels.audit))


/* [2b] 生成路径档位解析（resolveGenerationCostTier 单测；生成侧 meta 只增） */
group('[2b] AC-E2/E3（生成路径）：resolveGenerationCostTier 映射/回退/默认语义')
const genUnset = routing.resolveGenerationCostTier({ taskModels: {} }, 'storyboard')
check('生成路径：未配置 → 全 null（旧行为不变）', genUnset && genUnset.requestedCostTier === null && genUnset.costTier === null && genUnset.costTierFallback === false && genUnset.costTierFallbackReason === null && genUnset.model === '', JSON.stringify(genUnset))
const genFast = routing.resolveGenerationCostTier({ taskModels: { storyboard: { costTier: 'fast', costTierModels: { fast: { provider: 'fast-p', model: 'fast-m' } } } } }, 'storyboard')
check('生成路径：fast 有映射 → costTier=fast / model=fast-m / fallback=false', genFast && genFast.costTier === 'fast' && genFast.model === 'fast-m' && genFast.costTierFallback === false, JSON.stringify(genFast))
const genNoMap = routing.resolveGenerationCostTier({ taskModels: { storyboard: { costTier: 'strong' } } }, 'storyboard')
check('生成路径：strong 无映射 → 回退 standard + no-model-mapping', genNoMap && genNoMap.costTier === 'standard' && genNoMap.costTierFallback === true && genNoMap.costTierFallbackReason === 'no-model-mapping', JSON.stringify(genNoMap))
const genStd = routing.resolveGenerationCostTier({ taskModels: { storyboard: { model: 'std-m', costTier: 'standard' } } }, 'storyboard')
check('生成路径：standard → 现有 task model / fallback=false', genStd && genStd.costTier === 'standard' && genStd.model === 'std-m' && genStd.costTierFallback === false, JSON.stringify(genStd))
let normalizeRejected = false
try {
  routing.normalizeCostTier('turbo')
} catch (error) {
  normalizeRejected = error && error.code === 'invalid-args'
}
check('model-routing：normalizeCostTier 非法 → code=invalid-args', normalizeRejected)
const toolOutputs = toolsMod.TOOL_OUTPUTS || {}
const tierToolNames = Object.entries(toolOutputs).filter(([, output]) => output && output.schema && JSON.stringify(output.schema).includes('costTierRequested')).map(([name]) => name)
check('TOOL_OUTPUTS：≥3 个生成工具含 costTier* 可选字段', tierToolNames.length >= 3, JSON.stringify(tierToolNames))

/* ------------------------------------------------------------------ [3] AC-E3 */
group('[3] AC-E3：不可用/无映射 → 回退 standard + fallback 标记（不报错、不阻断）')
await saveSettings({ taskModels: { audit: { costTier: 'fast' } } })
const noMapLlm = makeFakeLlm()
const noMapResult = await runDeep(noMapLlm)
const noMapMeta = metaOf(noMapResult)
check('AC-E3：无映射 → 不报错、产出 findings（不阻断）', Boolean(reviewOf(noMapResult)) && (reviewOf(noMapResult).findings || []).length >= 1, JSON.stringify({ findings: (reviewOf(noMapResult) && reviewOf(noMapResult).findings || []).length }).slice(0, 120))
check('AC-E3：无映射 → costTier=standard / requested=fast / fallback=true / reason=no-model-mapping', noMapMeta.costTier === 'standard' && noMapMeta.costTierRequested === 'fast' && noMapMeta.costTierFallback === true && noMapMeta.costTierFallbackReason === 'no-model-mapping', JSON.stringify({ costTier: noMapMeta.costTier, requested: noMapMeta.costTierRequested, fallback: noMapMeta.costTierFallback, reason: noMapMeta.costTierFallbackReason }))
await saveSettings({ taskModels: { audit: { model: 'std-m', costTier: 'fast', costTierModels: { fast: FAST } }, } })
const unavailableLlm = makeFakeLlm({ unavailable: [FAST.model] })
const unavailableResult = await runDeep(unavailableLlm)
const unavailableMeta = metaOf(unavailableResult)
check('AC-E3：映射模型不可用 → 不报错、回退 std-m 产出 findings', Boolean(reviewOf(unavailableResult)) && (reviewOf(unavailableResult).findings || []).length >= 1 && unavailableMeta.model === 'std-m', JSON.stringify({ model: unavailableMeta.model, calls: unavailableLlm.calls }).slice(0, 220))
check('AC-E3：映射不可用 → costTier=standard / requested=fast / fallback=true / reason=tier-unavailable', unavailableMeta.costTier === 'standard' && unavailableMeta.costTierRequested === 'fast' && unavailableMeta.costTierFallback === true && unavailableMeta.costTierFallbackReason === 'tier-unavailable', JSON.stringify({ costTier: unavailableMeta.costTier, requested: unavailableMeta.costTierRequested, fallback: unavailableMeta.costTierFallback, reason: unavailableMeta.costTierFallbackReason }))
check('AC-E3：回退后仍有模型调用成功（stream 被调用）', unavailableLlm.calls.length >= 1, String(unavailableLlm.calls.length))

/* ------------------------------------------------------------------ [4] AC-E4 */
group('[4] AC-E4：非法 costTier / costTierModels → settings-save HTTP 400 invalid-args')
const routes = new Map()
const routeCtx = {
  provide: () => {},
  inject(_services, callback) {
    callback({
      connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } },
      commands: { register: () => () => {} },
      agents: { list: () => [], roots: () => [] },
      workspaceRegistry: { list: async () => [{ path: workspace }] },
      get: (name) => (name === 'workspaceRegistry' ? { list: async () => [{ path: workspace }] } : name === 'agents' ? { list: () => [] } : undefined),
      on: () => {},
      effect: (fn) => fn(),
    })
  },
  logger: { info: () => {}, warn: () => {} },
}
apply(routeCtx, { root: workspace })
async function call(method, body) {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('route not registered: ' + method)
  const request = new Request('http://127.0.0.1:1/api/ai-drama/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' },
    body: JSON.stringify(body || {}),
  })
  const response = await spec.fetch(request)
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  return { status: response.status, body: payload }
}
const invalidArgsResult = (result) => Boolean(result) && result.status === 400 && Boolean(result.body) && (result.body.code === 'invalid-args' || (result.body.error && result.body.error.code === 'invalid-args'))
const invalidTier = await call('settings-save', { settings: { taskModels: { audit: { costTier: 'turbo' } } } })
check('AC-E4：costTier=turbo → 400 invalid-args', invalidArgsResult(invalidTier), JSON.stringify(invalidTier).slice(0, 220))
const invalidMapKey = await call('settings-save', { settings: { taskModels: { audit: { costTier: 'fast', costTierModels: { standard: { model: 'x' } } } } } })
check('AC-E4：costTierModels 未知键 standard → 400 invalid-args', invalidArgsResult(invalidMapKey), JSON.stringify(invalidMapKey).slice(0, 220))
const invalidMapType = await call('settings-save', { settings: { taskModels: { audit: { costTier: 'fast', costTierModels: { fast: { provider: 'p' } } } } } })
check('AC-E4：costTierModels.fast 缺 model → 400 invalid-args', invalidArgsResult(invalidMapType), JSON.stringify(invalidMapType).slice(0, 220))
const missingTier = await call('settings-save', { settings: { taskModels: { audit: { costTierModels: { fast: { model: 'm' } } } } } })
check('AC-E4：costTierModels 无 costTier → 400 invalid-args', invalidArgsResult(missingTier), JSON.stringify(missingTier).slice(0, 220))
const validSave = await call('settings-save', { settings: { taskModels: { audit: { costTier: 'fast', costTierModels: { fast: { provider: 'fast-p', model: 'fast-m' } } } } } })
check('AC-E4：合法配置 → 200 保存成功', validSave.status === 200 && validSave.body && validSave.body.ok === true, JSON.stringify(validSave).slice(0, 220))
await saveSettings({ taskModels: {} })

/* ------------------------------------------------------------------ [5] AC-E5 */
group('[5] AC-E5：工程红线（工具 34/METHODS 68/无新依赖/旧数据 32 hash）+ client 静态标记')
const defs = toolsMod.createToolDefs({ rootOf: () => workspace, backendOf: () => null })
check('工具面仍 34', defs.length === 34, String(defs.length))
check('METHODS 仍 = 68', METHODS.length === 68, String(METHODS.length))
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
check('无新增外部依赖', !pkg.dependencies || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies || {}))
const clientCalls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((match) => match[1]))
check('client 去重调用点 = 68（M4 批1+批2 +10 已批准）', clientCalls.size === 68, String(clientCalls.size))
check('client slots.register = 4（v0.12.1 已批准终值）', (clientSrc.match(/slots\.register\(/g) || []).length === 4)
const clientMarkers = [
  ['成本档位下拉 aria-label', /['"]aria-label['"]\s*:\s*['"]审读成本档位['"]/],
  ['选项文案 fast/standard/strong', /fast · 低成本/],
  ['旧宿主 SKIP 门控', /旧宿主降级：SKIP/],
  ['报告 data-cost-tier 标记', /data-cost-tier/],
  ['回退提示文案', /已回退默认/],
]
const missingClient = clientMarkers.filter(([, re]) => !re.test(clientSrc)).map(([label]) => label)
if (!clientSrc || missingClient.length === clientMarkers.length) {
  console.log('      （SKIP：client costTier 增强未交付——host 半验收不受影响；client 交付后本组自动生效）')
} else {
  for (const [label, re] of clientMarkers) check('client 静态：' + label, re.test(clientSrc))
}
const BASELINE_CANDIDATES = [
  process.env.DSH_AI_D12_BASELINE,
  path.join(pluginRoot, '..', 'AI短剧工作区', '证据', 'P2-1-旧数据基线-2026-10-17.json'),
]
let baselineText = null
for (const candidate of BASELINE_CANDIDATES) {
  try {
    baselineText = await fs.readFile(candidate, 'utf8')
    break
  } catch {
    baselineText = null
  }
}
if (!baselineText) {
  console.log('      （SKIP：旧数据基线快照未找到——安装副本隔离目录等场景）')
} else {
  const baseline = JSON.parse(baselineText)
  const REAL_ROOT = process.env.DSH_AI_DRAMA_REAL_ROOT || path.join(pluginRoot, '..', 'AI短剧')
  const files = []
  async function walk(dir, relBase = '') {
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name)
      const rel = path.join(relBase, entry.name)
      if (entry.isDirectory()) await walk(abs, rel)
      else {
        try {
          const buffer = await fs.readFile(abs)
          files.push({ relative: rel, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') })
        } catch {}
      }
    }
  }
  await walk(REAL_ROOT)
  const baseMap = new Map(baseline.files.map((file) => [file.relative, file]))
  const curMap = new Map(files.map((file) => [file.relative, file]))
  // 2026-10-20 测试项目清理后恢复严格口径：活动数据根 = 基线 32 文件集合（缺失/新增/改写均 FAIL；无 allowlist）。
  const missing = [...baseMap.keys()].filter((key) => !curMap.has(key))
  const added = [...curMap.keys()].filter((key) => !baseMap.has(key))
  const changed = [...baseMap.keys()].filter((key) => curMap.has(key) && curMap.get(key).sha256 !== baseMap.get(key).sha256)
  check('旧数据 32 核心文件 hash 不变（严格 32 文件）', missing.length === 0 && added.length === 0 && changed.length === 0, JSON.stringify({ missing, added, changed }).slice(0, 300))
}

/* ------------------------------------------------------------------ [6] 契约（meta 只增字段类型） */
group('[6] 契约：meta.costTier* 只增字段类型合法（assertReviewSchema 兼容）')
const assertReviewSchema = auditMod.assertReviewSchema || null
const baseReview = e1Review ? JSON.parse(JSON.stringify(e1Review)) : null
let contractOk = true
let invalidRejected = false
if (!baseReview || typeof assertReviewSchema !== 'function') {
  console.log('      （SKIP：基线 review/assertReviewSchema 不可用——契约由 tool-output-contract.mjs 覆盖）')
} else {
  baseReview.meta = { ...baseReview.meta, costTier: 'fast', costTierRequested: 'fast', costTierFallback: false, costTierFallbackReason: null }
  const schemaOk = assertReviewSchema(baseReview)
  contractOk = Boolean(schemaOk && schemaOk.ok === true)
  const badReview = JSON.parse(JSON.stringify(baseReview))
  badReview.meta.costTier = 42
  const schemaBad = assertReviewSchema(badReview)
  invalidRejected = Boolean(schemaBad && schemaBad.ok === false && Array.isArray(schemaBad.errors) && schemaBad.errors.some((item) => String(item).includes('costTier')))
}
check('契约：带 costTier* meta 的 review 通过 schema 校验（只增合法）', contractOk)
check('契约：meta.costTier 非字符串被拒绝（类型约束保持）', invalidRejected)

/* ------------------------------------------------------------------ 汇总 */
await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const failure of failures) console.log('  - ' + failure)
}
process.exit(failed === 0 ? 0 : 1)
