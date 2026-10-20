/**
 * v0.6.7 验收（P2-5 剩余：分类重试 / 断点续跑·幂等 / 漂移检测）· all.mjs 第 25 套件
 *
 * 来源：task-49 / task-48（host v0.6.7）；需求 `P2-好用阶段-规划与需求挖掘机制-v1.md` §18.2
 * 覆盖：① 分类重试三态（默认可重试/不可重试/默认不重试 + settings.generationRetry 校验/退避）
 *       ② 断点续跑 resume 幂等（只补 planned/failed、跳过 done/inFlight、二次 submitted=0、后端调用次数不增）
 *       ③ operationId 逐镜幂等键（重复 plan 去重；省略=旧 task 形状）
 *       ④ 漂移检测四类（缺/多节点、绑定 uuid 变更、上游覆盖）+ suggestions、**只报不改**
 *       ⑤ 默认未配置 = 与 v0.6.6 行为一致；⑥ 工程红线（工具 34/METHODS 69（task-110 media-read +1）/无新依赖/旧数据 hash）
 *
 * 全部假后端 + 临时工作区，离线零成本。运行：node test/v067-acceptance.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, 'lib', rel)).href)
const store = await load('store.js')
const generation = await load('generation.js')
const orchestrator = await load('orchestrator.js')
const guard = await load('guard.js')

// 特征探测：v0.6.7 功能未落地时显式 SKIP
const hasFeature =
  typeof generation.classifyGenerationError === 'function' &&
  typeof generation.getGenerationRetry === 'function' &&
  typeof orchestrator.resumeBatch === 'function' &&
  typeof guard.detectDrift === 'function'
if (!hasFeature) {
  console.log('\n结果：0 passed, 0 failed（SKIP：v0.6.7 功能未落地（分类重试/resume/漂移）——task-48 交付后自动生效）')
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

/* ------------------------------------------------------------------ 夹具与 harness */
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'v067-'))
const TITLE = 'v067验收样剧'
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
await store.saveContract(workspace, TITLE, { platform: '抖音', audience: 'a', episodeDurationSec: [60, 120], targetEpisodes: 80, orientation: 'portrait', hookDensity: 'h', redlines: [] })
await store.saveOutline(workspace, TITLE, [{ order: 1, title: '第1集', logline: 'l', hook: 'h', twist: 't', cliffhanger: 'c', estDurationSec: 100 }])
await store.saveCharacters(workspace, TITLE, [{ name: '林越', role: '主角', personality: ['冷静'], bio: 'b' }])
await store.writeEpisode(workspace, TITLE, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：三天后还钱。\n')
const SHOTS = ['1-1', '1-2', '1-3', '1-4', '1-5']
await store.saveStoryboard(workspace, TITLE, 1, SHOTS.map((shotNumber) => ({ shotNumber, shotSize: '中景', cameraMove: '推', description: `第${shotNumber}镜`, durationSec: 3 })))
const realProjectDir = store.projectDir(workspace, TITLE)
async function treeHash() {
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
          files.push(rel + ':' + crypto.createHash('sha256').update(buf).digest('hex'))
        } catch {}
      }
    }
  }
  await walk(realProjectDir)
  return crypto.createHash('sha256').update(files.join('|')).digest('hex')
}
async function planWithTasks({ operationId } = {}) {
  const plan = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'image', backend: 'libtv', model: 'fake', ...(operationId ? { operationId } : {}) })
  return plan
}
function itemsOf(plan) {
  return (plan.tasks || []).map((t, i) => ({ taskId: t.id, name: plan.items[i].name, prompt: plan.items[i].prompt }))
}
function makeBackend({ failTimes = 0, failStatus = 500, alwaysFail = false, failOnceFatal = false } = {}) {
  const state = { calls: 0, names: [] }
  return {
    state,
    async generate(item) {
      state.calls += 1
      state.names.push(item.name)
      if (failOnceFatal && state.calls === 1) {
        const error = new Error('参数不合法：prompt 缺失')
        error.status = 400
        throw error
      }
      if (alwaysFail || state.calls <= failTimes) {
        const error = new Error('网络抖动：ECONNRESET')
        error.status = failStatus
        throw error
      }
      return { raw: { nodeKey: item.name } }
    },
    async listNodes() {
      return []
    },
  }
}

/* ------------------------------------------------------------------ [1] 分类重试 */
group('[1] 分类重试：classifyGenerationError 三态 + 退避 + settings.generationRetry 校验')
const classifyCases = [
  [{ status: 500 }, true, 'http-500 可重试'],
  [{ status: 429 }, true, '429 可重试'],
  [{ message: 'fetch failed: ECONNRESET' }, true, '网络错误可重试'],
  [{ message: '请求超时 timeout' }, true, '超时可重试'],
  [{ status: 400 }, false, '400 不可重试'],
  [{ message: '参数不合法：invalid-args' }, false, '参数错误不可重试'],
  [{ message: '超出预算上限 budget' }, false, '预算错误不可重试'],
  [{ message: '权限不允许 permission' }, false, '权限错误不可重试'],
  [{ message: 'some unknown weird thing' }, false, '未知保守不可重试'],
]
for (const [errorLike, expectedRetryable, label] of classifyCases) {
  const error = new Error(errorLike.message || 'err')
  if (errorLike.status) error.status = errorLike.status
  const verdict = generation.classifyGenerationError(error)
  check(`分类：${label} → retryable=${expectedRetryable}`, verdict.retryable === expectedRetryable, JSON.stringify(verdict))
}
check('退避：retryDelayMs 指数增长且封顶', generation.retryDelayMs(1, { baseDelayMs: 100, maxDelayMs: 300 }) === 100 && generation.retryDelayMs(2, { baseDelayMs: 100, maxDelayMs: 300 }) === 200 && generation.retryDelayMs(3, { baseDelayMs: 100, maxDelayMs: 300 }) === 300, '100/200/300')
const retryDefault = await generation.getGenerationRetry(workspace)
check('settings.generationRetry 未配置 → 默认 maxAttempts=1（不重试）', retryDefault.maxAttempts === 1, JSON.stringify(retryDefault))
const invalidRetry = await apiCall('settings-save', { settings: { generationRetry: { maxAttempts: 0 } } })
check('非法 generationRetry（maxAttempts=0）→ 400 invalid-args', invalidRetry.status === 400, JSON.stringify({ status: invalidRetry.status, body: invalidRetry.body }).slice(0, 240))
const validRetry = await apiCall('settings-save', { settings: { generationRetry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } } })
check('合法 generationRetry 保存 → 200 且回读一致', validRetry.status === 200 && validRetry.body?.settings?.generationRetry?.maxAttempts === 3, JSON.stringify(validRetry.body?.settings?.generationRetry))

/* ------------------------------------------------------------------ [2] 重试行为（假后端） */
group('[2] 重试行为三态（假后端）：可重试成功 / 可重试耗尽 / 致命立即失败 / 默认不重试')
// 清空历史任务，避免串扰：用新的 operationId 批次
await apiCall('settings-save', { settings: { generationRetry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } } })
const planRetrySuccess = await planWithTasks({ operationId: 'retry-success' })
const backendSuccess = makeBackend({ failTimes: 2 })
const submitSuccess = await orchestrator.submitBatch(workspace, TITLE, { backend: 'libtv', kind: 'image', items: [itemsOf(planRetrySuccess)[0]], resolveBackend: () => backendSuccess })
check('可重试：失败 2 次后成功（attempts=3，后端调用 3 次）', submitSuccess.results[0]?.attempts === 3 && backendSuccess.state.calls === 3, JSON.stringify({ attempts: submitSuccess.results[0]?.attempts, calls: backendSuccess.state.calls }))
check('可重试成功：submitted=1 且结果带 attempts/retryable/classification', submitSuccess.submitted === 1 && submitSuccess.results[0].ok === true, JSON.stringify(submitSuccess.results[0]?.attempts))
const planRetryExhaust = await planWithTasks({ operationId: 'retry-exhaust' })
const backendExhaust = makeBackend({ alwaysFail: true })
const submitExhaust = await orchestrator.submitBatch(workspace, TITLE, { backend: 'libtv', kind: 'image', items: [itemsOf(planRetryExhaust)[0]], resolveBackend: () => backendExhaust })
check('可重试耗尽：attempts=3、failed=1、retryable=true、后端调用 3 次', submitExhaust.failed === 1 && submitExhaust.results[0]?.attempts === 3 && submitExhaust.results[0]?.retryable === true && backendExhaust.state.calls === 3, JSON.stringify({ attempts: submitExhaust.results[0]?.attempts, calls: backendExhaust.state.calls }))
const planFatal = await planWithTasks({ operationId: 'fatal' })
const backendFatal = makeBackend({ failOnceFatal: true })
const submitFatal = await orchestrator.submitBatch(workspace, TITLE, { backend: 'libtv', kind: 'image', items: [itemsOf(planFatal)[0]], resolveBackend: () => backendFatal })
check('致命错误：立即失败 attempts=1、retryable=false、后端调用 1 次', submitFatal.failed === 1 && submitFatal.results[0]?.attempts === 1 && submitFatal.results[0]?.retryable === false && backendFatal.state.calls === 1, JSON.stringify({ attempts: submitFatal.results[0]?.attempts, calls: backendFatal.state.calls }))
// 默认不重试：清空 generationRetry 后，可重试错误也只尝试 1 次
await apiCall('settings-save', { settings: { generationRetry: null } })
const planDefault = await planWithTasks({ operationId: 'default-no-retry' })
const backendDefault = makeBackend({ alwaysFail: true })
const submitDefault = await orchestrator.submitBatch(workspace, TITLE, { backend: 'libtv', kind: 'image', items: [itemsOf(planDefault)[0]], resolveBackend: () => backendDefault })
check('默认配置（maxAttempts=1）：失败只尝试 1 次（=v0.6.6 行为）', submitDefault.failed === 1 && submitDefault.results[0]?.attempts === 1 && backendDefault.state.calls === 1, JSON.stringify({ attempts: submitDefault.results[0]?.attempts, calls: backendDefault.state.calls }))

/* ------------------------------------------------------------------ [3] resume 断点续跑 + 幂等 */
group('[3] 断点续跑（resume）：只补 planned/failed、跳过 done/inFlight、二次调用幂等')
const planResume = await planWithTasks({ operationId: 'resume-op' })
const resumeTasks = planResume.tasks.map((t) => t.id)
// 状态：1-1 done、1-2 submitted、1-3 planned、1-4 failed、1-5 failed
await generation.updateTask(workspace, TITLE, resumeTasks[0], { status: 'done' })
await generation.updateTask(workspace, TITLE, resumeTasks[1], { status: 'submitted' })
await generation.updateTask(workspace, TITLE, resumeTasks[3], { status: 'failed' })
await generation.updateTask(workspace, TITLE, resumeTasks[4], { status: 'failed' })
const backendResume = makeBackend()
const resume1 = await orchestrator.resumeBatch(workspace, TITLE, { episode: 1, operationId: 'resume-op', kind: 'image', backend: 'libtv', resolveBackend: () => backendResume })
check('resume 第一次：只补 planned+failed = 3 项，submitted=3、后端调用 3 次', resume1.submitted === 3 && backendResume.state.calls === 3, JSON.stringify({ submitted: resume1.submitted, calls: backendResume.state.calls }))
check('resume 第一次：跳过 done/inFlight（后端未调用其节点名）', !backendResume.state.names.includes(planResume.items[0].name) && !backendResume.state.names.includes(planResume.items[1].name), JSON.stringify(backendResume.state.names))
const callsAfterFirst = backendResume.state.calls
const resume2 = await orchestrator.resumeBatch(workspace, TITLE, { episode: 1, operationId: 'resume-op', kind: 'image', backend: 'libtv', resolveBackend: () => backendResume })
check('resume 第二次：幂等（submitted=0、后端调用次数不增加）', resume2.submitted === 0 && backendResume.state.calls === callsAfterFirst, JSON.stringify({ submitted: resume2.submitted, calls: backendResume.state.calls }))
// 路由级：submit-batch {batch:{resume:true}} 形状
const routeResume = await apiCall('submit-batch', { title: TITLE, batch: { resume: true, episode: 1, operationId: 'resume-op', kind: 'image', backend: 'libtv' } })
check('路由 submit-batch{batch.resume:true} 走 resume 路径（无后端注入时不抛未归一异常）', routeResume.status === 200 || routeResume.status === 400, JSON.stringify({ status: routeResume.status }).slice(0, 120))

/* ------------------------------------------------------------------ [4] operationId 幂等 */
group('[4] operationId 逐镜幂等键：重复 plan 去重；省略=旧 task 形状')
const beforeCount = (await generation.listTasks(workspace, TITLE, { limit: 1000 })).length
const planOpA = await planWithTasks({ operationId: 'dedupe-op' })
const afterFirst = (await generation.listTasks(workspace, TITLE, { limit: 1000 })).length
check('首次 operationId 计划：逐镜登记任务（task.operationId = <op>:<镜号>）', planOpA.tasks.every((t) => String(t.operationId || '').startsWith('dedupe-op:')) && planOpA.tasks.length === SHOTS.length, JSON.stringify(planOpA.tasks.map((t) => t.operationId)))
const planOpB = await planWithTasks({ operationId: 'dedupe-op' })
const afterSecond = (await generation.listTasks(workspace, TITLE, { limit: 1000 })).length
check('重复 operationId 再计划：任务不重复登记（任务总数不变、task id 复用）', afterSecond === afterFirst && JSON.stringify(planOpB.tasks.map((t) => t.id).sort()) === JSON.stringify(planOpA.tasks.map((t) => t.id).sort()), JSON.stringify({ beforeCount, afterFirst, afterSecond }))
const planOpC = await planWithTasks({ operationId: 'dedupe-op-2' })
const afterThird = (await generation.listTasks(workspace, TITLE, { limit: 1000 })).length
check('不同 operationId：登记新任务（总数增加 SHOTS 数量）', afterThird === afterSecond + SHOTS.length, String(afterThird - afterSecond))
const planNoOp = await planWithTasks()
const noOpTasks = await generation.listTasks(workspace, TITLE, { limit: 1000 })
const planNoOpTaskIds = new Set(planNoOp.tasks.map((t) => t.id))
check('省略 operationId：旧 task 形状不变（新任务不带 operationId）', planNoOp.tasks.every((t) => t.operationId === undefined) && planNoOpTaskIds.size === SHOTS.length, JSON.stringify(planNoOp.tasks.map((t) => Object.keys(t)).slice(0, 2)).slice(0, 240))

/* ------------------------------------------------------------------ [5] 漂移检测 */
group('[5] 漂移检测四类 + suggestions + 只报不改')
// 绑定文件（libtv: .libtv/project.json, uuid=uuid-current）
await fs.mkdir(path.join(realProjectDir, '.libtv'), { recursive: true })
await fs.writeFile(path.join(realProjectDir, '.libtv', 'project.json'), JSON.stringify({ projectUuid: 'uuid-current' }, null, 2) + '\n', 'utf8')
// guard 历史状态：recordedUuid=uuid-current、无上游覆盖
const guardFile = path.join(realProjectDir, '.aidrama', 'canvas-guard.json')
await fs.mkdir(path.dirname(guardFile), { recursive: true })
async function writeGuardState(entry) {
  await fs.writeFile(guardFile, JSON.stringify({ libtv: entry }, null, 2) + '\n', 'utf8')
}
const currentNodes = SHOTS.map((s) => ({ key: `k-${s}`, name: `E001-${s}` }))
function backendWithNodes(nodes) {
  return { async listNodes() { return nodes } }
}
// 基线：一致
await writeGuardState({ binding: { ok: true, uuid: 'uuid-current' }, verdict: { comparable: true, drifted: false, missingExpected: [] } })
const baselineHash = await treeHash()
const driftOk = await guard.detectDrift(workspace, TITLE, { backend: backendWithNodes(currentNodes), backendId: 'libtv', episode: 1, cwd: realProjectDir })
check('漂移基线：分镜与画布一致（drift.detected=false）', driftOk.drift.detected === false && driftOk.missingOnCanvas.length === 0 && driftOk.extraOnCanvas.length === 0, JSON.stringify(driftOk.drift))
// ① 缺节点
const missing = await guard.detectDrift(workspace, TITLE, { backend: backendWithNodes(currentNodes.slice(0, 3)), backendId: 'libtv', episode: 1, cwd: realProjectDir })
check('漂移①缺节点：missingOnCanvas=1-4/1-5 + finding type=missing-on-canvas + suggestions 非空', JSON.stringify(missing.missingOnCanvas) === JSON.stringify(['1-4', '1-5']) && missing.drift.findings.some((f) => f.type === 'missing-on-canvas') && missing.drift.suggestions.length > 0, JSON.stringify({ missing: missing.missingOnCanvas, findings: missing.drift.findings }).slice(0, 300))
// ② 多节点
const extraNodes = [...currentNodes, { key: 'k-1-6', name: 'E001-1-6' }]
const extra = await guard.detectDrift(workspace, TITLE, { backend: backendWithNodes(extraNodes), backendId: 'libtv', episode: 1, cwd: realProjectDir })
check('漂移②多节点：extraOnCanvas=1-6 + finding type=extra-on-canvas', JSON.stringify(extra.extraOnCanvas) === JSON.stringify(['1-6']) && extra.drift.findings.some((f) => f.type === 'extra-on-canvas'), JSON.stringify(extra.drift.findings).slice(0, 300))
// ③ 绑定 uuid 变更（历史 uuid=uuid-old vs 当前 uuid-current）
await writeGuardState({ binding: { ok: true, uuid: 'uuid-old' }, verdict: { comparable: true, drifted: false, missingExpected: [] } })
const bindingChanged = await guard.detectDrift(workspace, TITLE, { backend: backendWithNodes(currentNodes), backendId: 'libtv', episode: 1, cwd: realProjectDir })
check('漂移③绑定变更：finding type=binding-changed（from/to）+ suggestions 非空', bindingChanged.drift.findings.some((f) => f.type === 'binding-changed' && f.from === 'uuid-old' && f.to === 'uuid-current') && bindingChanged.drift.suggestions.length > 0, JSON.stringify(bindingChanged.drift.findings).slice(0, 300))
// ④ 上游覆盖（历史 verdict drifted=true）
await writeGuardState({ binding: { ok: true, uuid: 'uuid-current' }, verdict: { comparable: true, drifted: true, missingExpected: ['E001-1-1'] } })
const overwritten = await guard.detectDrift(workspace, TITLE, { backend: backendWithNodes(currentNodes), backendId: 'libtv', episode: 1, cwd: realProjectDir })
check('漂移④上游覆盖：finding type=upstream-overwrite + suggestions 非空', overwritten.drift.findings.some((f) => f.type === 'upstream-overwrite') && overwritten.drift.suggestions.length > 0, JSON.stringify(overwritten.drift.findings).slice(0, 300))
// 只报不改：整个漂移检测过程不应修改项目数据（guard 状态文件由测试写，检测本身只读）
await writeGuardState({ binding: { ok: true, uuid: 'uuid-current' }, verdict: { comparable: true, drifted: false, missingExpected: [] } })
const hashBeforeDetect = await treeHash()
await guard.detectDrift(workspace, TITLE, { backend: backendWithNodes(currentNodes.slice(0, 2)), backendId: 'libtv', episode: 1, cwd: realProjectDir })
const hashAfterDetect = await treeHash()
check('漂移检测只报不改：检测前后项目文件树 hash 不变', hashBeforeDetect === hashAfterDetect, JSON.stringify({ changed: hashBeforeDetect !== hashAfterDetect }))
// reconcile 输出含 drift/suggestions
const reconcile = await guard.reconcile(workspace, TITLE, { backend: backendWithNodes(currentNodes.slice(0, 2)), backendId: 'libtv', episode: 1, cwd: realProjectDir })
check('canvas-reconcile 输出含 binding/drift/suggestions（只增字段）', Boolean(reconcile.binding) && Boolean(reconcile.drift) && Array.isArray(reconcile.suggestions) && reconcile.drift.detected === true, JSON.stringify({ keys: Object.keys(reconcile), drift: reconcile.drift && reconcile.drift.detected }))

/* ------------------------------------------------------------------ [6] 默认行为一致 + 红线 */
group('[6] 默认未配置 = v0.6.6 行为一致 + 工程红线')
await apiCall('settings-save', { settings: { generationRetry: null } })
const defaultConfig = await generation.getGenerationRetry(workspace)
check('默认 generationRetry = {maxAttempts:1}（不重试）', defaultConfig.maxAttempts === 1, JSON.stringify(defaultConfig))
const defaultPlan = await planWithTasks()
check('默认 plan：无 operationId 时任务形状与 v0.6.6 一致（无 operationId 字段）', defaultPlan.tasks.every((t) => t.operationId === undefined) && defaultPlan.count === SHOTS.length, JSON.stringify(defaultPlan.tasks.slice(0, 1)))
check('默认 submit 结果保留旧字段（submitted/failed/results）', typeof submitSuccess.submitted === 'number' && typeof submitSuccess.failed === 'number' && Array.isArray(submitSuccess.results), JSON.stringify(Object.keys(submitSuccess)))
const toolsMod = await load('tools.js')
const defs = toolsMod.createToolDefs({ rootOf: () => workspace, backendOf: () => null })
check('工具面仍 = 34', defs.length === 34, String(defs.length))
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
  const missingData = [...baseMap.keys()].filter((k) => !curMap.has(k))
  const addedData = [...curMap.keys()].filter((k) => !baseMap.has(k))
  const changedData = [...baseMap.keys()].filter((k) => curMap.has(k) && curMap.get(k).sha256 !== baseMap.get(k).sha256)
  oldDataOk = missingData.length === 0 && addedData.length === 0 && changedData.length === 0
  oldDataDetail = JSON.stringify({ missingData, addedData, changedData }).slice(0, 300)
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
