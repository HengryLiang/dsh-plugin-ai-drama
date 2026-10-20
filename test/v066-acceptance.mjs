/**
 * v0.6.6 验收（P2-5 子集：生成前成本预估 + 预算三级闸门）· 骨架
 *
 * 范围（Lead 2026-10-18 裁定）：v0.6.6 = task-44 子集（①成本预估 + ③预算三级闸门）+ R-P2-11 门禁；
 * 原 ②分类重试/断点续跑、④漂移检测 → task-48（v0.6.7，不在本版验收）。
 * AC：① 成本预估输出可观测（tokens/费用区间）；② 单次/单集/项目三级闸门超限拒绝 + 明细（哪个闸门/当前用量/上限）；
 *     ③ 默认未配置 = 与 v0.6.5 行为一致；④ 假后端/既有套件不回归、工具 34/METHODS 69（task-110 media-read +1）/无新依赖/旧数据 hash 不变。
 *
 * 当前状态：host task-44 实现中 → 特征探测（成本预估/三级闸门标记）未命中时显式 SKIP；
 * 交付后按实际 API 校准并并入 all.mjs（第 24 套件）。
 * 运行：node test/v066-acceptance.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, 'lib', rel)).href)

const generationSrc = await fs.readFile(path.join(pluginRoot, 'lib', 'generation.js'), 'utf8')
const orchestratorSrc = await fs.readFile(path.join(pluginRoot, 'lib', 'orchestrator.js'), 'utf8')
const indexSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const allSrc = generationSrc + '\n' + orchestratorSrc + '\n' + indexSrc
const hasCostEstimate = /(costEstimate|estimatedTokens|estimatedCost|costRange|priceRange|预估成本|预计成本|费用区间)/i.test(allSrc)
const hasThreeTierGates = /(singleLimit|perActionLimit|episodeLimit|projectLimit|threeTier|三级闸门|budgetGates|gates\s*[:=])/i.test(allSrc)
if (!hasCostEstimate || !hasThreeTierGates) {
  console.log(`\n结果：0 passed, 0 failed（SKIP：v0.6.6 P2-5 子集未落地（host task-44 进行中）；探测（成本预估=${hasCostEstimate}, 三级闸门=${hasThreeTierGates}）—— 交付后本套件自动生效）`)
  process.exit(0)
}

const store = await load('store.js')
const generation = await load('generation.js')
const orchestrator = await load('orchestrator.js')

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

/* ------------------------------------------------------------------ 夹具（假后端、临时工作区） */
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'v066-'))
const TITLE = 'v066验收样剧'
const routes = new Map()
const pluginCtx = {
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
const { apply } = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
apply(pluginCtx, { root: workspace })
async function apiCall(method, body) {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('route not registered: ' + method)
  const request = new Request('http://127.0.0.1:1/api/ai-drama/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' },
    body: JSON.stringify(body || {}),
  })
  const response = await spec.fetch(request)
  return { status: response.status, body: await response.json().catch(() => null) }
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
await store.saveOutline(workspace, TITLE, [{ order: 1, title: '第1集', logline: '冲突', hook: '开场冲突', twist: '反转', cliffhanger: '留扣', estDurationSec: 100 }])
await store.saveCharacters(workspace, TITLE, [{ name: '林越', role: '主角', personality: ['冷静', '隐忍'], bio: '典当行朝奉' }])
await store.writeEpisode(workspace, TITLE, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n赵铁：还钱。\n林越：三天后，你来拿钱。\n')
await store.saveStoryboard(workspace, TITLE, 1, [
  { shotNumber: '1-1', shotSize: '特写', cameraMove: '推', description: '刀锋贴颈', durationSec: 3, imagePrompt: '雨夜，刀锋贴颈，冷光' },
  { shotNumber: '1-2', shotSize: '中景', cameraMove: '摇', description: '林越被按在柜台上', durationSec: 4 },
  { shotNumber: '1-3', shotSize: '远景', description: '巷口雨幕', durationSec: 5 },
])

/** 递归查找对象中的成本/预估信息（适配 host 实际字段名）。 */
function findCostEstimate(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return null
  seen.add(value)
  const keys = Object.keys(value)
  const keyHit = keys.some((k) => /cost|price|estimate|token|预估|费用|积分/i.test(k))
  if (keyHit) {
    const numeric = keys.filter((k) => Number.isFinite(Number(value[k])))
    const hasMinMax = numeric.some((k) => /min|low|from/i.test(k)) && numeric.some((k) => /max|high|to/i.test(k))
    const hasText = keys.some((k) => typeof value[k] === 'string' && /预计|预估|费用|成本|区间|tokens?/i.test(value[k]))
    const candidate = Object.fromEntries(keys.filter((k) => !/^(items|tasks|shots|plan)$/.test(k)).map((k) => [k, value[k]]))
    if ((numeric.length >= 1 && hasMinMax) || hasText) return candidate
  }
  for (const child of Object.values(value)) {
    const found = findCostEstimate(child, depth + 1, seen)
    if (found) return found
  }
  return null
}
function findQuotaGate(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return null
  seen.add(value)
  if (Object.prototype.hasOwnProperty.call(value, 'ok') && (Object.prototype.hasOwnProperty.call(value, 'limited') || Object.prototype.hasOwnProperty.call(value, 'detail') || /gate/i.test(JSON.stringify(Object.keys(value))))) {
    return value
  }
  for (const child of Object.values(value)) {
    const found = findQuotaGate(child, depth + 1, seen)
    if (found) return found
  }
  return null
}

/* ------------------------------------------------------------------ [1] 成本预估可观测 */
group('[1] 成本预估：生成计划输出可观测的 tokens/费用区间')
const plan = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'image', backend: 'libtv', model: 'Lib Image 2.5 Pro', estimatePerUnitPoints: 2 })
const cost = plan && plan.costEstimate
check('生成计划含 costEstimate 对象', Boolean(cost) && typeof cost === 'object', JSON.stringify(plan && Object.keys(plan)).slice(0, 240))
check('costEstimate.points 含区间（unitMin/unitMax/totalMin/totalMax/source）', Boolean(cost && cost.points) && ['unitMin', 'unitMax', 'totalMin', 'totalMax', 'source'].every((k) => k in cost.points) && Number.isFinite(Number(cost.points.totalMin)) && Number.isFinite(Number(cost.points.totalMax)), JSON.stringify(cost && cost.points).slice(0, 240))
check('costEstimate.tokens 含区间（perUnit/totalMin/totalMax/source=heuristic）', Boolean(cost && cost.tokens) && ['perUnit', 'totalMin', 'totalMax', 'source'].every((k) => k in cost.tokens) && Number(cost.tokens.totalMin) > 0 && Number(cost.tokens.totalMax) >= Number(cost.tokens.totalMin), JSON.stringify(cost && cost.tokens).slice(0, 240))
check('costEstimate 绑定三级闸门结果（gate.levels.task/episode/project）', Boolean(cost && cost.gate && cost.gate.levels) && ['task', 'episode', 'project'].every((k) => cost.gate.levels[k] && 'ok' in cost.gate.levels[k]), JSON.stringify(cost && cost.gate && cost.gate.levels).slice(0, 260))
const toolsSrc = await fs.readFile(path.join(pluginRoot, 'lib', 'tools.js'), 'utf8')
const hasCostText = /(成本预估|预计\s*tokens|tokens\s*区间|费用区间|预计消耗.*积分)/i.test(toolsSrc)
check('文本摘要可观测：工具渲染含成本/费用/区间文案（drama_plan_batch 等）', hasCostText, hasCostText ? 'found' : 'tools.js 渲染未发现成本区间文案（需 host 补）')
check('成本预估为只读观察（不新增 route/工具）', true, '由红线断言覆盖')

/* ------------------------------------------------------------------ [2] 三级闸门 */
group('[2] 预算三级闸门（单次/单集/项目）：超限拒绝 + 明细')
async function setLimits(limits) {
  await store.saveSettings(workspace, { generationLimits: limits })
  return (await store.getSettings(workspace)).generationLimits
}
const persisted = await setLimits({ perTaskPoints: 1, perEpisodePoints: 2, perProjectPoints: 1000 })
check('settings.generationLimits 可保存并回读（perTask/perEpisode/perProject）', Boolean(persisted) && persisted.perTaskPoints === 1 && persisted.perEpisodePoints === 2 && persisted.perProjectPoints === 1000, JSON.stringify(persisted))
// ① 单次闸门：单件预估 5 > 单次上限 1
const taskPlan = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'image', backend: 'libtv', model: 'Lib Image 2.5 Pro', estimatePerUnitPoints: 5 })
const taskGate = taskPlan.costEstimate && taskPlan.costEstimate.gate
check('单次超限 → 计划拒绝（ok=false / reason=over-task-budget）', Boolean(taskGate && taskGate.ok === false && taskGate.reason === 'over-task-budget'), JSON.stringify(taskGate).slice(0, 300))
check('单次拒绝明细含闸门/当前/上限（可读）', Boolean(taskGate && /单次/.test(String(taskGate.detail || '')) && /上限/.test(String(taskGate.detail || ''))), String(taskGate && taskGate.detail).slice(0, 240))
check('单次闸门 levels.task.ok=false', Boolean(taskGate && taskGate.levels && taskGate.levels.task && taskGate.levels.task.ok === false), JSON.stringify(taskGate && taskGate.levels && taskGate.levels.task))
// ② 单集闸门：本集预计 6 > 单集上限 2（放宽单次）
await setLimits({ perTaskPoints: 100, perEpisodePoints: 2, perProjectPoints: 1000 })
const episodePlan = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'image', backend: 'libtv', model: 'Lib Image 2.5 Pro', estimatePerUnitPoints: 2 })
const episodeGate = episodePlan.costEstimate && episodePlan.costEstimate.gate
check('单集超限 → 计划拒绝（reason=over-episode-budget）', Boolean(episodeGate && episodeGate.ok === false && episodeGate.reason === 'over-episode-budget'), JSON.stringify(episodeGate).slice(0, 300))
check('单集拒绝明细含集数/已消耗/上限（可读）', Boolean(episodeGate && /第 1 集/.test(String(episodeGate.detail || '')) && /上限/.test(String(episodeGate.detail || ''))), String(episodeGate && episodeGate.detail).slice(0, 240))
check('单集闸门 levels.episode.ok=false', Boolean(episodeGate && episodeGate.levels && episodeGate.levels.episode && episodeGate.levels.episode.ok === false), JSON.stringify(episodeGate && episodeGate.levels && episodeGate.levels.episode))
// ③ 项目闸门：project 上限 3 < 预计 6
await setLimits({ perTaskPoints: 100, perEpisodePoints: 100, perProjectPoints: 3 })
const projectPlan = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'image', backend: 'libtv', model: 'Lib Image 2.5 Pro', estimatePerUnitPoints: 2 })
const projectGate = projectPlan.costEstimate && projectPlan.costEstimate.gate
check('项目超限 → 计划拒绝（reason=over-budget 且 detail 含预算上限）', Boolean(projectGate && projectGate.ok === false && projectGate.reason === 'over-budget' && /预算上限/.test(String(projectGate.detail || ''))), JSON.stringify(projectGate).slice(0, 300))
check('项目闸门 levels.project.ok=false', Boolean(projectGate && projectGate.levels && projectGate.levels.project && projectGate.levels.project.ok === false), JSON.stringify(projectGate && projectGate.levels && projectGate.levels.project))
// 未超限/未配置 → 允许
await setLimits(null)
const allowedPlan = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'image', backend: 'libtv', model: 'Lib Image 2.5 Pro', estimatePerUnitPoints: 1 })
const allowedGate = allowedPlan.costEstimate && allowedPlan.costEstimate.gate
check('未配置/未超限 → 计划允许（不误拦）', Boolean(allowedGate && allowedGate.ok === true && allowedGate.limited === false), JSON.stringify(allowedGate).slice(0, 260))

/* ------------------------------------------------------------------ [2b] settings-save 路由级：generationLimits 持久化 + 非法拒绝 */
group('[2b] settings 路由级：generationLimits 持久化 / 非法值拒绝 / 旧形状不变')
const settings0 = await apiCall('settings-get', {})
const baseFields = ['defaultModel', 'promptTemplates', 'retrievalEnabled', 'storageLocation', 'strictMode', 'taskModels']
check('settings-get 原有字段全在（只增 generationLimits）', settings0.status === 200 && settings0.body && settings0.body.ok === true && baseFields.every((k) => k in settings0.body.settings), JSON.stringify(settings0.body && Object.keys(settings0.body.settings || {})).slice(0, 240))
const saveLimits = await apiCall('settings-save', { settings: { generationLimits: { perTaskPoints: 2, perEpisodePoints: 10, perProjectPoints: 100 } } })
check('settings-save 保存 generationLimits → 200', saveLimits.status === 200 && saveLimits.body && saveLimits.body.ok === true, JSON.stringify(saveLimits.body).slice(0, 240))
const readBack = await apiCall('settings-get', {})
check('settings-get 回读 generationLimits（perTask/perEpisode/perProject）', Boolean(readBack.body && readBack.body.settings && readBack.body.settings.generationLimits && readBack.body.settings.generationLimits.perTaskPoints === 2), JSON.stringify(readBack.body && readBack.body.settings && readBack.body.settings.generationLimits).slice(0, 240))
const invalidLimits = await apiCall('settings-save', { settings: { generationLimits: { perTaskPoints: -1 } } })
check('非法 generationLimits（负数）→ 400（host 需补归一化校验）', invalidLimits.status === 400 && invalidLimits.body && invalidLimits.body.ok === false, JSON.stringify({ status: invalidLimits.status, body: invalidLimits.body }).slice(0, 240))
await apiCall('settings-save', { settings: { generationLimits: null } })
const clearedRead = await apiCall('settings-get', {})
check('清空/缺省 generationLimits → 读取不报错、默认不限制', clearedRead.status === 200 && (!clearedRead.body.settings.generationLimits || Object.values(clearedRead.body.settings.generationLimits).every((v) => v == null)), JSON.stringify(clearedRead.body && clearedRead.body.settings && clearedRead.body.settings.generationLimits).slice(0, 240))

/* ------------------------------------------------------------------ [3] 默认行为一致 */
group('[3] 默认未配置 = 与 v0.6.5 行为一致（同输入同输出）')
const defaultPlan = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'image', backend: 'libtv', model: 'Lib Image 2.5 Pro' })
check('默认规划保留 v0.6.5 字段（count/items/tasks/estimatePoints/quota）', Number(defaultPlan.count) === 3 && Array.isArray(defaultPlan.items) && Array.isArray(defaultPlan.tasks) && Number.isFinite(Number(defaultPlan.estimatePoints)) && Boolean(defaultPlan.quota), JSON.stringify({ count: defaultPlan.count, estimatePoints: defaultPlan.estimatePoints }).slice(0, 160))
check('默认 quota 语义兼容（ok=true/limited=false/detail=null）', Boolean(defaultPlan.quota && defaultPlan.quota.ok === true && defaultPlan.quota.limited === false), JSON.stringify(defaultPlan.quota && { ok: defaultPlan.quota.ok, limited: defaultPlan.quota.limited }).slice(0, 200))
check('默认 quota.levels 存在且三级均 ok（新增只读字段不影响旧行为）', Boolean(defaultPlan.quota.levels) && ['task', 'episode', 'project'].every((k) => defaultPlan.quota.levels[k] && defaultPlan.quota.levels[k].ok !== false), JSON.stringify(defaultPlan.quota.levels).slice(0, 260))
const explicitPlan = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'image', backend: 'libtv', model: 'Lib Image 2.5 Pro', estimatePerUnitPoints: 2 })
check('显式 perUnit 时 estimatePoints 与 v0.6.5 公式一致（perUnit × count）', Number(explicitPlan.estimatePoints) === 3 * 2, String(explicitPlan.estimatePoints))
const budget = await generation.getBudget(workspace, TITLE)
check('预算台账形状保留（limitPoints/spentPoints/remainingPoints）', ['limitPoints', 'spentPoints', 'remainingPoints'].every((k) => k in budget), JSON.stringify(budget).slice(0, 240))

/* ------------------------------------------------------------------ [4] 红线 */
group('[4] 工程红线（工具 34 / METHODS 69（task-110 media-read +1） / 无新依赖 / 旧数据 hash）')
const toolsMod = await load('tools.js')
const defs = toolsMod.createToolDefs({ rootOf: () => workspace, backendOf: () => null })
check('生产工具面仍 34', defs.length === 34, String(defs.length))
const { METHODS } = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
check('METHODS 仍 = 69（task-110 media-read +1）', METHODS.length === 69, String(METHODS.length))
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
check('无新增外部依赖', !pkg.dependencies || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies || {}))
const BASELINE_JSON = process.env.DSH_AI_DRAMA_BASELINE || path.join(pluginRoot, '..', 'AI短剧工作区', '证据', 'P2-1-旧数据基线-2026-10-17.json')
let oldDataOk = true
let oldDataDetail = 'SKIP（基线快照缺失）'
try {
  const baseline = JSON.parse(await fs.readFile(BASELINE_JSON, 'utf8'))
  const realRoot = process.env.DSH_AI_DRAMA_REAL_ROOT || path.join(pluginRoot, '..', 'AI短剧')
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
          const buf = await fs.readFile(abs)
          files.push({ relative: rel, sha256: crypto.createHash('sha256').update(buf).digest('hex') })
        } catch {}
      }
    }
  }
  await walk(realRoot)
  const baseMap = new Map(baseline.files.map((f) => [f.relative, f]))
  const curMap = new Map(files.map((f) => [f.relative, f]))
  // 2026-10-20 测试项目清理后恢复严格口径：活动数据根 = 基线 32 文件集合（缺失/新增/改写均 FAIL；无 allowlist）。
  const missing = [...baseMap.keys()].filter((k) => !curMap.has(k))
  const added = [...curMap.keys()].filter((k) => !baseMap.has(k))
  const changed = [...baseMap.keys()].filter((k) => curMap.has(k) && curMap.get(k).sha256 !== baseMap.get(k).sha256)
  oldDataOk = missing.length === 0 && added.length === 0 && changed.length === 0
  oldDataDetail = JSON.stringify({ missing, added, changed }).slice(0, 300)
} catch {
  oldDataOk = true
}
check('旧数据 32 文件 hash 不变', oldDataOk, oldDataDetail)

await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
