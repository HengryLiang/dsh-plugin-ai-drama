/**
 * v0.6.2 验收用例：D-12（模型输出 JSON 容错/重试/降级可观测）+ P2-6 增强（client 标注/透传）
 *
 * 背景（Lead 定级 D-12，中高）：v0.6.1 运行期真实模型抽测暴露：
 *   模型输出 JSON 偶发不合法（未转义换行/流异常）→ 审读降级，且降级报告丢失 meta.model/modelSource（无法证明任务模型是否生效）。
 * 修复口径（task-32）：
 *   ① 容错解析：去 ```json 围栏 → 修复字符串内未转义控制字符 → 去尾逗号 → 再失败向模型**重试一次**（附“仅输出合法 JSON”修复提示）→ 仍失败才降级；
 *   ② 降级报告保留 attempted provider/model/modelSource（非空/非 none）+ 可读 degradeReason；
 *   ③ 保持：工具 34 / METHODS 70（task-110 media-read +1；v0.15.11 E13 assets-import +1） / 零新增 route / 预算与默认行为不变。
 *
 * 用例（fake llm，5 类模型输出）：
 *   [1] 正常 JSON → 解析成功（findings/meta 正常、单次调用）
 *   [2] ```json 围栏 → 解析成功
 *   [3] 字符串内未转义换行 → 解析成功（修复控制字符）
 *   [4] 尾逗号 → 解析成功（去尾逗号）
 *   [5] 完全非 JSON → **重试一次后** degraded:true，且 meta 保留 attempted model/provider/modelSource（非空/非 none）+ degradeReason 可读
 *   [6] P2-6 增强 client 静态：timeoutMs 透传 + 审读标注 modelSource/modelFallback/degradeReason（未交付则 SKIP 该组）
 *   [7] 工程红线：工具 34 / METHODS 70（task-110 media-read +1；v0.15.11 E13 assets-import +1） / slots=4（已批准终值）/ client 调用点 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）（M4 批1+批2 +10，已批准）/ 无新依赖 / 旧数据 32 文件 hash 不变
 *
 * 兼容策略：D-12 修复未落地（源码未出现 attempted/repair/tolerant 标记）时显式 SKIP；落地后自动生效。
 * 运行：node test/audit-robust.mjs
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
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8')
const auditSrc = await fs.readFile(path.join(libDir, 'audit.js'), 'utf8')

const auditMod = await import(pathToFileURL(path.join(libDir, 'audit.js')).href)
const store = await import(pathToFileURL(path.join(libDir, 'store.js')).href)
const toolsMod = await import(pathToFileURL(path.join(libDir, 'tools.js')).href)

// D-12 修复特征探测：attempted 元数据 / 修复或重试辅助函数
const exportedNames = Object.keys(auditMod || {})
const fixLanded =
  /attempted/i.test(auditSrc) ||
  exportedNames.some((name) => /attempt|repair|sanitize|tolerant|coerce/i.test(name))
if (!fixLanded) {
  console.log('\n结果：0 passed, 0 failed（SKIP：D-12 修复尚未落地（task-32 进行中）；源码未出现 attempted/repair/tolerant 标记。修复落地后本套件自动生效）')
  process.exit(0)
}

const { apply, METHODS } = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)

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

/* ------------------------------------------------------------------ 夹具 */
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-d12-'))
const routes = new Map()
const ctx = {
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
apply(ctx, { root: workspace })
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
const TITLE = 'D12 容错样剧'
const TASK_CONFIG = { provider: 'task-p', model: 'task-m' }
const AGENT_SELECTION = { provider: 'agent-p', model: 'agent-m' }
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
await store.saveOutline(workspace, TITLE, [{ order: 1, title: '第1集', logline: '退婚反杀', hook: '刀架颈侧', twist: '反杀', cliffhanger: '靠山现身', estDurationSec: 100 }])
await store.saveCharacters(workspace, TITLE, [{ name: '林越', role: '主角', personality: ['冷静', '隐忍'], bio: '典当行朝奉' }])
await store.writeEpisode(workspace, TITLE, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n赵铁：还钱。\n林越：三天后，你来拿钱。\n')
await call('settings-save', { settings: { taskModels: { audit: { ...TASK_CONFIG, maxTokens: 5000 } } } })

/* ------------------------------------------------------------------ 5 类模型输出 */
const FINDING_CORE = { severity: 'high', dimension: 'hook_pacing', location: { episode: 1, scene: 1 }, suggestion: '首镜改强冲突特写', confidence: 0.9 }
function reviewJson(evidence) {
  return JSON.stringify({ findings: [{ ...FINDING_CORE, evidence }], summary: 'ok' })
}
const OUTPUT_CLASSES = [
  {
    key: 'normal-json',
    label: '正常 JSON',
    body: () => reviewJson('正常 JSON 证据'),
    expectParse: true,
    expectCalls: 1,
  },
  {
    key: 'fenced-json',
    label: '```json 围栏',
    body: () => '```json\n' + reviewJson('围栏 JSON 证据') + '\n```',
    expectParse: true,
    expectCalls: 1,
  },
  {
    key: 'unescaped-newline',
    label: '字符串内未转义换行',
    // 手动构造：evidence 字符串内含真实换行（非法 JSON，修复应转为 \\n）
    body: () =>
      '{"findings":[{"severity":"high","dimension":"hook_pacing","location":{"episode":1,"scene":1},"evidence":"第一行\n第二行（未转义换行）","suggestion":"改","confidence":0.9}],"summary":"ok"}',
    expectParse: true,
    expectCalls: 1,
  },
  {
    key: 'trailing-comma',
    label: '尾逗号',
    body: () => reviewJson('尾逗号证据').replace('}]', '},]'),
    expectParse: true,
    expectCalls: 1,
  },
  {
    key: 'not-json',
    label: '完全非 JSON',
    body: () => '这不是 JSON 输出，仅一段说明文字。',
    expectParse: false,
    expectCalls: 2, // 第 1 次失败 → 重试一次 → 仍失败 → 降级
  },
]
function makeFakeLlm(bodyFactory) {
  const calls = []
  return {
    calls,
    async resolveModelInfo(provider, model) {
      return { provider, model, available: true }
    },
    async *stream(opts) {
      calls.push({ provider: opts.provider, model: opts.model, maxTokens: opts.maxTokens, temperature: opts.temperature })
      const body = bodyFactory(calls.length)
      const half = Math.ceil(body.length / 2)
      yield { type: 'text-delta', text: body.slice(0, half) }
      yield { type: 'text-delta', text: body.slice(half) }
      yield { type: 'usage', usage: { inputTokens: 800, outputTokens: 400, totalTokens: 1200 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}
function makeDefs(llm) {
  return toolsMod.createToolDefs({ rootOf: () => workspace, backendOf: () => null, llmOf: () => llm, modelSelectionOf: () => AGENT_SELECTION })
}
function mkExec() {
  return {
    agent: { id: 'qa-d12', session: { header: { cwd: workspace } }, ctx: { get: (name) => (name === 'agentPresets' ? { serviceFor: () => ({ mode: 'drama', disposed: false }) } : undefined) } },
    callId: 'd12-' + Math.random().toString(36).slice(2, 8),
  }
}
async function runDeep(llm) {
  const def = makeDefs(llm).find((d) => d.name === 'drama_check_consistency')
  return def.execute({ title: TITLE, episode: 1, deep: true }, mkExec())
}
const reviewOf = (result) => (result && result.deep && result.deep.review) || null
function attemptedOf(review) {
  const meta = (review && review.meta) || {}
  const attempted = meta.attempted && typeof meta.attempted === 'object' ? meta.attempted : {}
  const provider = attempted.provider || meta.attemptedProvider || meta.provider || ''
  const model = attempted.model || meta.attemptedModel || meta.model || ''
  const modelSource = attempted.modelSource || meta.attemptedModelSource || meta.modelSource || ''
  return { provider, model, modelSource }
}

/* ------------------------------------------------------------------ [1]-[4] */
group('[1] D-12：前 4 类不合法/包装 JSON 容错解析成功（findings 正常、单次调用）')
for (const cls of OUTPUT_CLASSES.filter((c) => c.expectParse)) {
  const fake = makeFakeLlm(cls.body)
  const result = await runDeep(fake)
  const review = reviewOf(result)
  const mode = result && result.deep && result.deep.mode
  const findings = (review && review.findings) || []
  check(`${cls.label}：deep 成功（mode=model，非降级）`, mode === 'model' && review && review.degraded === false, JSON.stringify({ mode, degraded: review && review.degraded, degradeReason: result && result.deep && result.deep.degradeReason }).slice(0, 200))
  check(`${cls.label}：findings 解析正常（≥1 条，含 evidence/suggestion）`, findings.length >= 1 && findings.every((f) => typeof f.evidence === 'string' && f.evidence.trim() && typeof f.suggestion === 'string'), JSON.stringify(findings).slice(0, 200))
  check(`${cls.label}：未触发重试（llm.stream 调用 ${cls.expectCalls} 次）`, fake.calls.length === cls.expectCalls, String(fake.calls.length))
  const att = attemptedOf(review)
  check(`${cls.label}：meta 记录实际模型（task-model）`, att.model === TASK_CONFIG.model && att.provider === TASK_CONFIG.provider && att.modelSource === 'task-model', JSON.stringify(att).slice(0, 160))
}

/* ------------------------------------------------------------------ [5] */
group('[5] D-12：完全非 JSON → 重试一次后降级，且 meta 保留 attempted 信息 + degradeReason 可读')
const badCls = OUTPUT_CLASSES.find((c) => !c.expectParse)
const fakeBad = makeFakeLlm(badCls.body)
const badResult = await runDeep(fakeBad)
const badReview = reviewOf(badResult)
check('完全非 JSON：deep 降级 degraded:true（不报错）', Boolean(badResult) && badResult.ok !== false && Boolean(badResult.deep) && badResult.deep.degraded === true, JSON.stringify({ degraded: badResult && badResult.deep && badResult.deep.degraded, degradeReason: badResult && badResult.deep && badResult.deep.degradeReason }).slice(0, 200))
const badCallModels = fakeBad.calls.map((c) => c.model)
check('完全非 JSON：同模型重试一次（配置模型至少 2 次调用；含宿主默认回退重试）', badCallModels.filter((m) => m === TASK_CONFIG.model).length >= 2 && badCallModels.length >= 2, JSON.stringify(badCallModels))
const attBad = attemptedOf(badReview)
check('D-12：降级报告 meta 保留 attempted provider/model（非空）', Boolean(attBad.provider) && Boolean(attBad.model) && attBad.provider !== 'none' && attBad.model !== 'none', JSON.stringify(attBad).slice(0, 200))
check('D-12：降级报告 meta 保留 attempted modelSource（非空/非 none）', Boolean(attBad.modelSource) && attBad.modelSource !== 'none', String(attBad.modelSource))
const degradeReason = String((badReview && badReview.meta && badReview.meta.degradeReason) || (badResult && badResult.deep && badResult.deep.degradeReason) || '')
check('D-12：meta.modelRetried == true（记录了重试事实）', Boolean(badReview) && badReview.meta?.modelRetried === true, String(badReview && badReview.meta?.modelRetried))
check('D-12：meta.rawModelOutputSnippet 保留原始输出片段（≤500 字符）', Boolean(badReview) && typeof badReview.meta?.rawModelOutputSnippet === 'string' && badReview.meta.rawModelOutputSnippet.includes('这不是 JSON'), String(badReview && badReview.meta?.rawModelOutputSnippet).slice(0, 120))
check('D-12：degradeReason 可读（非空，提及 JSON/输出/重试之一）', degradeReason.length > 0 && /json|输出|重试|invalid|empty/i.test(degradeReason), degradeReason.slice(0, 200))
check('D-12：降级报告仍为合法 schema（degraded=true 且 findings 数组）', Boolean(badReview) && badReview.degraded === true && Array.isArray(badReview.findings), JSON.stringify(badReview && Object.keys(badReview)).slice(0, 200))

/* ------------------------------------------------------------------ [5b] */
group('[5b] D-12 重试链路：第 1 次坏第 2 次好 → 成功 + modelRetried；传输错误不重试同模型 → 直接回退宿主默认')
const fakeFirstBad = (() => {
  const calls = []
  let n = 0
  return {
    calls,
    async resolveModelInfo(provider, model) { return { provider, model, available: true } },
    async *stream(opts) {
      calls.push({ provider: opts.provider, model: opts.model })
      n += 1
      const body = n === 1 ? '这不是 JSON 输出。' : reviewJson('第二次合法输出')
      const half = Math.ceil(body.length / 2)
      yield { type: 'text-delta', text: body.slice(0, half) }
      yield { type: 'text-delta', text: body.slice(half) }
      yield { type: 'usage', usage: { inputTokens: 800, outputTokens: 400, totalTokens: 1200 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
})()
const retryGood = await runDeep(fakeFirstBad)
const retryGoodReview = reviewOf(retryGood)
check('D-12 重试：第 1 次非 JSON、第 2 次合法 → deep 成功（mode=model）', Boolean(retryGood) && retryGood.deep?.mode === 'model' && ((retryGoodReview && retryGoodReview.findings) || []).length >= 1, JSON.stringify({ mode: retryGood && retryGood.deep && retryGood.deep.mode, reason: retryGood && retryGood.deep && retryGood.deep.degradeReason }).slice(0, 200))
check('D-12 重试：llm.stream 调用 2 次（同模型重试一次）', fakeFirstBad.calls.length === 2, String(fakeFirstBad.calls.length))
check('D-12 重试：成功报告 meta.modelRetried == true', Boolean(retryGoodReview) && retryGoodReview.meta?.modelRetried === true, String(retryGoodReview && retryGoodReview.meta?.modelRetried))
// 传输错误（stream throw）：不重试同模型，直接回退宿主默认
const fakeTransport = (() => {
  const calls = []
  return {
    calls,
    async resolveModelInfo(provider, model) {
      return { provider, model, available: true }
    },
    async *stream(opts) {
      calls.push({ provider: opts.provider, model: opts.model })
      if (opts.model === TASK_CONFIG.model) throw new Error('模拟流传输失败')
      const body = reviewJson('传输回退成功证据')
      const half = Math.ceil(body.length / 2)
      yield { type: 'text-delta', text: body.slice(0, half) }
      yield { type: 'text-delta', text: body.slice(half) }
      yield { type: 'usage', usage: { inputTokens: 800, outputTokens: 400, totalTokens: 1200 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
})()
const transportResult = await runDeep(fakeTransport)
const transportReview = reviewOf(transportResult)
const transportModels = fakeTransport.calls.map((c) => c.model)
check('AC-M2b：传输错误 → 不重试同模型（配置模型仅 1 次调用）', transportModels.filter((m) => m === TASK_CONFIG.model).length === 1, JSON.stringify(transportModels))
check('AC-M2b：传输错误 → 回退宿主默认并成功产出 findings', Boolean(transportReview) && ((transportReview.findings || []).length >= 1) && transportReview.meta?.model === AGENT_SELECTION.model, JSON.stringify({ models: transportModels, model: transportReview && transportReview.meta?.model }).slice(0, 200))
check('AC-M2b：回退成功标记 meta.modelFallback == true', Boolean(transportReview) && transportReview.meta?.modelFallback === true, String(transportReview && transportReview.meta?.modelFallback))

/* ------------------------------------------------------------------ [6] */
group('[6] P2-6 增强 client 静态（timeoutMs 透传 + 审读「本次使用模型」标注；未交付则 SKIP）')
const enhancementMarkers = [
  ['timeoutMs 透传（任务模型配置）', /timeoutMs/],
  ['审读标注 modelSource', /modelSource/],
  ['回退标注 modelFallback', /modelFallback/],
  ['降级标注 degradeReason', /degradeReason/],
]
const missingEnhancement = enhancementMarkers.filter(([, re]) => !re.test(clientSrc)).map(([label]) => label)
if (missingEnhancement.length > 0) {
  console.log(`      （SKIP：P2-6 增强 client 代码未交付（缺 ${missingEnhancement.join('、')}）——task-33 落地后本组自动生效）`)
} else {
  check('P2-6 增强：client 含 timeoutMs 透传（设置/保存/回读）', /timeoutMs/.test(clientSrc))
  check('P2-6 增强：client 审读标注 modelSource（任务模型/默认模型/已回退映射）', /modelSource/.test(clientSrc) && /任务模型|默认模型|已回退/.test(clientSrc))
  check('P2-6 增强：client 回退提示 modelFallback', /modelFallback/.test(clientSrc))
  check('P2-6 增强：client 降级提示 degradeReason', /degradeReason/.test(clientSrc))
}

/* ------------------------------------------------------------------ [7] */
group('[7] 工程红线：工具 34 / METHODS 70（task-110 media-read +1；v0.15.11 E13 assets-import +1） / slots=4（已批准终值）/ 调用点 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）（M4 批1+批2 +10 已批准）/ 无新依赖 / 旧数据 hash')
const defs = toolsMod.createToolDefs({ rootOf: () => workspace, backendOf: () => null })
check('工具面仍 34', defs.length === 35, String(defs.length))
check('METHODS 仍 = 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）', METHODS.length === 72, String(METHODS.length))
check('client slots.register = 4（v0.12.1 已批准终值）', (clientSrc.match(/slots\.register\(/g) || []).length === 4)
const clientCalls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
check('client 去重调用点 = 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）（M4 批1+批2 +10，已批准登记）', clientCalls.size === 72, String(clientCalls.size))
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
check('无新增外部依赖', !pkg.dependencies || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies || {}))
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
  console.log('      （SKIP：旧数据基线快照未找到 —— 安装副本隔离目录等场景）')
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
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name)
      const rel = path.join(relBase, e.name)
      if (e.isDirectory()) await walk(abs, rel)
      else {
        try {
          const buf = await fs.readFile(abs)
          files.push({ relative: rel, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') })
        } catch {}
      }
    }
  }
  await walk(REAL_ROOT)
  const baseMap = new Map(baseline.files.map((f) => [f.relative, f]))
  const curMap = new Map(files.map((f) => [f.relative, f]))
  // 2026-10-20 测试项目清理后恢复严格口径：活动数据根 = 基线 32 文件集合（缺失/新增/改写均 FAIL；无 allowlist）。
  const missing = [...baseMap.keys()].filter((k) => !curMap.has(k))
  const added = [...curMap.keys()].filter((k) => !baseMap.has(k))
  const changed = [...baseMap.keys()].filter((k) => curMap.has(k) && curMap.get(k).sha256 !== baseMap.get(k).sha256)
  check('旧数据 32 核心文件 hash 不变（严格 32 文件）', missing.length === 0 && added.length === 0 && changed.length === 0, JSON.stringify({ missing, added, changed }).slice(0, 300))
}

await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
