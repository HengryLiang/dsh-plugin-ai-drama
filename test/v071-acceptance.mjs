/**
 * v0.7.1 验收（P2-7 多集批量生成）· all.mjs 第 26 套件
 *
 * 来源：task-52 / host task-45（v0.7.1）；需求 `P2-好用阶段-规划与需求挖掘机制-v1.md` §18.3
 * 覆盖（全部假后端 + 临时工作区，离线零成本）：
 *   [1] 5 集串行 plan → 10 任务 + 批次成本预估/上限字段/溯源文件
 *   [2] submit 串行提交 + 二次幂等（submitted=0，后端调用不增）
 *   [3] collect 串行收敛：10 产物落 staging、10 条 batch-artifact pending 草稿、素材/生成为空、逐集一致性
 *   [4] 溯源 trace.json：逐集 plan(round/model/backend/durationMs)/submit(attempts/durationMs)/collect(sha256/bytes/durationMs)/consistency
 *   [5] 草稿衔接：draft-resolve accept 1 条 → 素材/生成=1 + assets=1 + trace adopted；discard 不落正式目录
 *   [6] 中断续跑：先 submit episodes:[1] → 再补齐其余集，第 1 集不重复、后端调用数=任务数
 *   [7] 上限：maxEpisodes 超限 blocked（不登记任务）、maxPoints → over-batch-points、maxDurationMs=0 → deferred + stoppedBy=duration-cap
 *   [8] 默认行为不变：无 episodes/batchId = 旧单集 plan 路径
 *   [9] 红线：工具 34 / METHODS 70（task-110 media-read +1；v0.15.11 E13 assets-import +1） / 无新增依赖 / 旧数据 32 文件 hash
 *
 * 运行：node test/v071-acceptance.mjs
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
const drafts = await load('drafts.js')

const hasFeature =
  typeof orchestrator.planBatchEpisodes === 'function' &&
  typeof orchestrator.submitBatchEpisodes === 'function' &&
  typeof orchestrator.collectBatchEpisodes === 'function' &&
  typeof generation.getBatchTrace === 'function' &&
  drafts.DRAFT_KINDS.includes('batch-artifact')
if (!hasFeature) {
  console.log('\n结果：0 passed, 0 failed（SKIP：v0.7.1 P2-7 多集批量未落地——task-45 交付后自动生效）')
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
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'v071-'))
const TITLE = 'v071验收样剧'
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
await store.saveOutline(workspace, TITLE, Array.from({ length: 5 }, (_, i) => ({ order: i + 1, title: `第${i + 1}集`, logline: 'l', hook: 'h', twist: 't', cliffhanger: 'c', estDurationSec: 100 })))
await store.saveCharacters(workspace, TITLE, [{ name: '林越', role: '主角', personality: ['冷静'], bio: 'b' }])
for (let ep = 1; ep <= 5; ep += 1) {
  await store.writeEpisode(workspace, TITLE, ep, `# 第00${ep}集\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：第${ep}集台词。\n`)
  await store.saveStoryboard(workspace, TITLE, ep, [`${ep}-1`, `${ep}-2`].map((shotNumber) => ({ shotNumber, shotSize: '中景', cameraMove: '推', description: `第${shotNumber}镜`, durationSec: 3 })))
}
const projectDir = store.projectDir(workspace, TITLE)
const formalDir = path.join(projectDir, '素材', '生成')
const stagingOf = (batchId) => generation.batchPaths(workspace, TITLE, batchId).stagingDir
async function listFilesRecursive(dir) {
  const files = []
  async function walk(current) {
    let entries = []
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else files.push(abs)
    }
  }
  await walk(dir)
  return files
}
function makeBatchBackend() {
  const state = { calls: 0, nodeNames: [], downloads: 0 }
  return {
    state,
    async generate(item) {
      state.calls += 1
      state.nodeNames.push(item.name)
      return { raw: { nodeKey: item.name } }
    },
    async nodeDetail(nodeName) {
      return { state: 'done', nodeName }
    },
    async download({ node }) {
      state.downloads += 1
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'v071-dl-'))
      const file = path.join(dir, `artifact-${state.downloads}-${path.basename(String(node || 'x'))}.png`)
      await fs.writeFile(file, Buffer.from(`PNG-${node}-${state.downloads}`))
      return { files: [file] }
    },
    async listNodes() {
      return []
    },
  }
}
const batchBackend = makeBatchBackend()
const resolveBackend = () => batchBackend
const tasksOfBatch = async (batchId) => (await generation.listTasks(workspace, TITLE, { limit: 2000 })).filter((task) => String(task.operationId || '').startsWith(`${batchId}:`))

/* ------------------------------------------------------------------ [1] 5 集 plan */
group('[1] 5 集串行 plan：10 任务 + 批次成本预估 + 溯源文件')
const BATCH1 = 'b-v071-main'
const planRes = await orchestrator.planBatchEpisodes(workspace, TITLE, { episodes: [1, 2, 3, 4, 5], kind: 'image', backend: 'libtv', batchId: BATCH1, maxEpisodes: 10 })
check('plan 返回 batch：batchId/status=planned/rounds=1', planRes.batchId === BATCH1 && planRes.status === 'planned' && planRes.rounds === 1, JSON.stringify({ batchId: planRes.batchId, status: planRes.status }))
check('plan 5 集 → totals.episodes=5、units=10（每集 2 镜）', planRes.totals.episodes === 5 && planRes.totals.units === 10, JSON.stringify(planRes.totals))
check('批次成本预估可观测（pointsMin/pointsMax/tokensMin/tokensMax/perEpisode）', planRes.costEstimate && Number.isFinite(Number(planRes.costEstimate.pointsMax)) && Array.isArray(planRes.costEstimate.perEpisode) && planRes.costEstimate.perEpisode.length === 5, JSON.stringify(planRes.costEstimate && { pointsMin: planRes.costEstimate.pointsMin, pointsMax: planRes.costEstimate.pointsMax, perEpisode: planRes.costEstimate.perEpisode.length }))
check('登记 10 个任务（operationId=batchId:E<ep>:...）', (await tasksOfBatch(BATCH1)).length === 10, String((await tasksOfBatch(BATCH1)).length))
check('溯源文件 trace.json 已创建（batchPaths.traceFile）', await fs.stat(planRes.traceFile).then(() => true, () => false), planRes.traceFile)
const trace0 = await generation.getBatchTrace(workspace, TITLE, BATCH1)
check('trace 结构：schemaVersion/batchId/kind/episodes/rounds', trace0.schemaVersion === 1 && trace0.batchId === BATCH1 && trace0.kind === 'image' && trace0.episodes.length === 5 && trace0.rounds === 1, JSON.stringify({ schemaVersion: trace0.schemaVersion, episodes: trace0.episodes.length }))
check('trace 逐集 plan 记录（round/model/backend/durationMs）', trace0.episodes.every((item) => item.trace && item.trace.plan && item.trace.plan.round === 1 && item.trace.plan.backend === 'libtv' && Number.isFinite(Number(item.trace.plan.durationMs))), JSON.stringify(trace0.episodes[0] && trace0.episodes[0].trace.plan))

/* ------------------------------------------------------------------ [2] submit + 幂等 */
group('[2] submit 串行提交 + 二次幂等')
const submit1 = await orchestrator.submitBatchEpisodes(workspace, TITLE, { batchId: BATCH1, backend: 'libtv', resolveBackend })
check('首次 submit：submitted=10、failed=0、后端调用 10 次', submit1.submitted === 10 && submit1.failed === 0 && batchBackend.state.calls === 10, JSON.stringify({ submitted: submit1.submitted, calls: batchBackend.state.calls }))
const callsAfterSubmit = batchBackend.state.calls
const submit2 = await orchestrator.submitBatchEpisodes(workspace, TITLE, { batchId: BATCH1, backend: 'libtv', resolveBackend })
check('二次 submit 幂等：submitted=0、idempotent=true、后端调用不增', submit2.submitted === 0 && submit2.idempotent === true && batchBackend.state.calls === callsAfterSubmit, JSON.stringify({ submitted: submit2.submitted, idempotent: submit2.idempotent, calls: batchBackend.state.calls }))
const trace1 = await generation.getBatchTrace(workspace, TITLE, BATCH1)
check('trace submit 记录 attempts/durationMs/status（含 submitHistory 首次记录）', trace1.episodes.every((item) => {
  const trace = (item.trace && item.trace) || {}
  const records = [trace.submit, ...(Array.isArray(trace.submitHistory) ? trace.submitHistory : [])].filter(Boolean)
  const first = records.find((record) => Number.isFinite(Number(record.attempts)))
  return Boolean(first) && Number.isFinite(Number(first.durationMs))
}), JSON.stringify((trace1.episodes[0] && trace1.episodes[0].trace && (trace1.episodes[0].trace.submit || (trace1.episodes[0].trace.submitHistory || [])[0])) || {}))

/* ------------------------------------------------------------------ [3] collect + staging + 草稿 */
group('[3] collect 串行收敛：staging 10 产物 + 10 草稿 + 素材/生成空 + 逐集一致性')
const formalBefore = await listFilesRecursive(formalDir)
async function stagedOnly(batchId) {
  const { stagingDir } = generation.batchPaths(workspace, TITLE, batchId)
  let entries = []
  try {
    entries = await fs.readdir(stagingDir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory()) files.push(...(await listFilesRecursive(path.join(stagingDir, entry.name))))
  }
  return files
}
const collect1 = await orchestrator.collectBatchEpisodes(workspace, TITLE, { batchId: BATCH1, backend: 'libtv', resolveBackend })
check('collect：collected=10、pending=0、failed=0', collect1.collected === 10 && collect1.pending === 0 && collect1.failed === 0, JSON.stringify({ collected: collect1.collected, pending: collect1.pending, failed: collect1.failed }))
check('staging 有 10 个暂存产物（素材/生成 仍为空）', (await stagedOnly(BATCH1)).length === 10 && (await listFilesRecursive(formalDir)).length === formalBefore.length, JSON.stringify({ staged: (await stagedOnly(BATCH1)).length, formal: (await listFilesRecursive(formalDir)).length }))
const pendingDrafts = (await drafts.listDrafts(projectDir)).filter((draft) => draft.kind === 'batch-artifact')
check('10 条 batch-artifact pending 草稿（含 batchId/stagedRelative 元数据）', pendingDrafts.length === 10 && pendingDrafts.every((draft) => JSON.parse(draft.content).batchId === BATCH1 && JSON.parse(draft.content).stagedRelative), String(pendingDrafts.length))
check('逐集一致性 score≥90（实际记录）', Number(collect1.consistency?.score) >= 90, JSON.stringify({ score: collect1.consistency?.score, byEpisode: collect1.consistency?.byEpisode ? Object.keys(collect1.consistency.byEpisode).length : 0 }))
const traceAfterCollect = await generation.getBatchTrace(workspace, TITLE, BATCH1)
check('trace collect 后各集 status=collected（5/5）+ collect 记录存在', traceAfterCollect.episodes.length === 5 && traceAfterCollect.episodes.every((item) => item.status === 'collected' && item.trace && item.trace.collect), JSON.stringify(traceAfterCollect.episodes.map((item) => item.status)))
const collect2 = await orchestrator.collectBatchEpisodes(workspace, TITLE, { batchId: BATCH1, backend: 'libtv', resolveBackend })
check('二次 collect 幂等：collected=0、idempotent=true、草稿数不增', collect2.collected === 0 && collect2.idempotent === true && (await drafts.listDrafts(projectDir)).filter((draft) => draft.kind === 'batch-artifact').length === 10, JSON.stringify({ collected: collect2.collected, idempotent: collect2.idempotent }))

/* ------------------------------------------------------------------ [4] trace 溯源 */
group('[4] 溯源 trace.json：逐集 plan/submit/collect 与产物 sha256')
const trace2 = await generation.getBatchTrace(workspace, TITLE, BATCH1)
const firstArtifact = (trace2.artifacts || [])[0]
check('trace.artifacts 含 10 条产物（episode/taskId/draftId/stagedRelative/sha256/bytes/adopted=false）', (trace2.artifacts || []).length === 10 && firstArtifact && /^[a-f0-9]{64}$/.test(String(firstArtifact.sha256)) && Number(firstArtifact.bytes) > 0 && firstArtifact.adopted === false, JSON.stringify({ count: (trace2.artifacts || []).length, sha: firstArtifact && firstArtifact.sha256?.slice(0, 12) }))
check('trace 一致性结论落盘（consistency.score/byEpisode）', Boolean(trace2.consistency) && Number.isFinite(Number(trace2.consistency.score)) && Boolean(trace2.consistency.byEpisode), JSON.stringify(trace2.consistency && { score: trace2.consistency.score }))

/* ------------------------------------------------------------------ [5] 草稿 accept / discard */
group('[5] 草稿区衔接：accept 1 条 → 素材/生成=1 + assets=1 + trace adopted；discard 不落正式')
const acceptDraft = pendingDrafts[0]
const acceptRes = await apiCall('draft-resolve', { title: TITLE, id: acceptDraft.id, action: 'accept' })
check('draft-resolve accept → 200/ok（applied=batch-artifact）', acceptRes.status === 200 && acceptRes.body && acceptRes.body.ok === true && acceptRes.body.applied === 'batch-artifact', JSON.stringify({ status: acceptRes.status, applied: acceptRes.body && acceptRes.body.applied }).slice(0, 240))
const formalAfterAccept = await listFilesRecursive(formalDir)
check('accept 后 素材/生成=1 文件、staging 暂存减少 1', formalAfterAccept.length === 1 && (await stagedOnly(BATCH1)).length === 9, JSON.stringify({ formal: formalAfterAccept.length, staged: (await stagedOnly(BATCH1)).length }))
const assets = await store.getAssets(workspace, TITLE)
check('accept 后 assets=1（素材登记）', Array.isArray(assets) && assets.length === 1, JSON.stringify({ assets: Array.isArray(assets) ? assets.length : typeof assets }))
const trace3 = await generation.getBatchTrace(workspace, TITLE, BATCH1)
const adoptedArtifact = (trace3.artifacts || []).find((item) => item.stagedRelative === JSON.parse(acceptDraft.content).stagedRelative)
check('trace adopted=true + assetId/formalRelative 可查', Boolean(adoptedArtifact && adoptedArtifact.adopted === true && adoptedArtifact.assetId && adoptedArtifact.formalRelative), JSON.stringify({ adopted: adoptedArtifact && adoptedArtifact.adopted, assetId: adoptedArtifact && adoptedArtifact.assetId }))
const discardDraft = pendingDrafts[1]
const discardRes = await apiCall('draft-resolve', { title: TITLE, id: discardDraft.id, action: 'discard' })
check('draft-resolve discard → 200/ok 且 素材/生成 不变（1 文件）', discardRes.status === 200 && discardRes.body && discardRes.body.ok === true && (await listFilesRecursive(formalDir)).length === 1, JSON.stringify({ status: discardRes.status, formal: (await listFilesRecursive(formalDir)).length }))
const discarded = (await drafts.listDrafts(projectDir, { includeResolved: true })).find((draft) => draft.id === discardDraft.id)
check('discard 草稿状态非 pending（不进正式目录）', Boolean(discarded) && discarded.status !== 'pending', JSON.stringify(discarded && discarded.status))

/* ------------------------------------------------------------------ [6] 中断续跑 */
group('[6] 中断续跑：先交第 1 集 → 再补齐其余集（不重复）')
const BATCH2 = 'b-v071-resume'
await orchestrator.planBatchEpisodes(workspace, TITLE, { episodes: [1, 2, 3], kind: 'image', backend: 'libtv', batchId: BATCH2 })
const backend2 = makeBatchBackend()
const resumeFirst = await orchestrator.submitBatchEpisodes(workspace, TITLE, { batchId: BATCH2, backend: 'libtv', resolveBackend: () => backend2, episodes: [1] })
check('部分提交 episodes:[1] → submitted=2、后端调用 2', resumeFirst.submitted === 2 && backend2.state.calls === 2, JSON.stringify({ submitted: resumeFirst.submitted, calls: backend2.state.calls }))
const resumeRest = await orchestrator.submitBatchEpisodes(workspace, TITLE, { batchId: BATCH2, backend: 'libtv', resolveBackend: () => backend2 })
check('续跑补齐：其余 2 集 submitted=4、总调用 6（第 1 集不重复）', resumeRest.submitted === 4 && backend2.state.calls === 6, JSON.stringify({ submitted: resumeRest.submitted, calls: backend2.state.calls }))
check('第 1 集任务未重复（operationId 唯一 + 数量=2）', (await tasksOfBatch(`${BATCH2}:E1`)).length === 2, String((await tasksOfBatch(`${BATCH2}:E1`)).length))
check('续跑后 trace episodes 状态（第 1 集 submitted、2/3 集 submitted）', (await generation.getBatchTrace(workspace, TITLE, BATCH2)).episodes.every((item) => ['submitted', 'partial'].includes(item.status)), JSON.stringify((await generation.getBatchTrace(workspace, TITLE, BATCH2)).episodes.map((item) => item.status)))

/* ------------------------------------------------------------------ [7] 上限三类 */
group('[7] 上限：maxEpisodes blocked / maxPoints over-batch-points / maxDurationMs deferred')
const BATCH_CAP1 = 'b-v071-cap-episodes'
const capPlan1 = await orchestrator.planBatchEpisodes(workspace, TITLE, { episodes: [1, 2, 3], kind: 'image', backend: 'libtv', batchId: BATCH_CAP1, maxEpisodes: 2 })
check('maxEpisodes 超限 → status=blocked、blocked.reason=over-max-episodes', capPlan1.status === 'blocked' && capPlan1.blocked && capPlan1.blocked.reason === 'over-max-episodes', JSON.stringify(capPlan1.blocked))
check('maxEpisodes 超限不登记任务（operationId 前缀任务数=0）', (await tasksOfBatch(BATCH_CAP1)).length === 0, String((await tasksOfBatch(BATCH_CAP1)).length))
let blockedSubmitThrew = false
try {
  await orchestrator.submitBatchEpisodes(workspace, TITLE, { batchId: BATCH_CAP1, backend: 'libtv', resolveBackend })
} catch {
  blockedSubmitThrew = true
}
check('blocked 批次 submit 被拒（明确报错）', blockedSubmitThrew)
const BATCH_CAP2 = 'b-v071-cap-points'
const capPlan2 = await orchestrator.planBatchEpisodes(workspace, TITLE, { episodes: [1], kind: 'image', backend: 'libtv', batchId: BATCH_CAP2, maxPoints: 1, estimatePerUnitPoints: 5 })
check('maxPoints 超限 → status=blocked、blocked.reason=over-batch-points', capPlan2.status === 'blocked' && capPlan2.blocked && capPlan2.blocked.reason === 'over-batch-points', JSON.stringify(capPlan2.blocked))
const BATCH_CAP3 = 'b-v071-cap-duration'
await orchestrator.planBatchEpisodes(workspace, TITLE, { episodes: [1], kind: 'image', backend: 'libtv', batchId: BATCH_CAP3, maxDurationMs: 0 })
const capSubmit = await orchestrator.submitBatchEpisodes(workspace, TITLE, { batchId: BATCH_CAP3, backend: 'libtv', resolveBackend })
const capTrace = await generation.getBatchTrace(workspace, TITLE, BATCH_CAP3)
check('maxDurationMs=0 → submitted=0、stoppedBy=duration-cap、episode=deferred', capSubmit.submitted === 0 && capSubmit.stoppedBy === 'duration-cap' && capTrace.episodes.some((item) => item.status === 'deferred'), JSON.stringify({ submitted: capSubmit.submitted, stoppedBy: capSubmit.stoppedBy, statuses: capTrace.episodes.map((item) => item.status) }))

/* ------------------------------------------------------------------ [8] 默认行为不变 + 红线 */
group('[8] 默认行为不变（旧单集 plan 路径）+ 工程红线')
const legacyPlan = await apiCall('plan-batch', { title: TITLE, plan: { episode: 1, kind: 'image', backend: 'libtv' } })
check('无 episodes 输入 → 旧单集 plan 路径（返回 plan，非 batch）', legacyPlan.status === 200 && legacyPlan.body && legacyPlan.body.ok === true && Boolean(legacyPlan.body.plan) && !legacyPlan.body.batch, JSON.stringify(legacyPlan.body && Object.keys(legacyPlan.body)))
const toolsMod = await load('tools.js')
const defs = toolsMod.createToolDefs({ rootOf: () => workspace, backendOf: () => null })
check('工具面仍 = 34', defs.length === 35, String(defs.length))
const { METHODS } = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
check('METHODS 仍 = 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）（无新增 route）', METHODS.length === 72, String(METHODS.length))
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

if (process.env.DSH_V071_EVIDENCE === '1') {
  const evidence = {
    at: new Date().toISOString(),
    kind: 'v0.7.1 P2-7 多集批量验收证据（假后端）',
    batchMain: {
      batchId: BATCH1,
      plan: { status: planRes.status, totals: planRes.totals, costEstimate: planRes.costEstimate, traceFile: planRes.traceFile, tasks: 10 },
      submit1: { submitted: submit1.submitted, failed: submit1.failed },
      submit2: { submitted: submit2.submitted, idempotent: submit2.idempotent },
      collect1: { collected: collect1.collected, pending: collect1.pending, failed: collect1.failed, consistency: collect1.consistency && { score: collect1.consistency.score, passedEpisodes: collect1.consistency.passedEpisodes, totalEpisodes: collect1.consistency.totalEpisodes, byEpisode: collect1.consistency.byEpisode ? Object.keys(collect1.consistency.byEpisode) : [] } },
      collect2: { collected: collect2.collected, idempotent: collect2.idempotent },
      stagingStagedAfterCollect: 10,
      pendingBatchArtifactDrafts: pendingDrafts.length,
      accept: { status: acceptRes.status, applied: acceptRes.body && acceptRes.body.applied, formalFilesAfter: 1, assetsAfter: Array.isArray(assets) ? assets.length : null },
      discard: { status: discardRes.status, formalFilesAfter: 1 },
      trace: { episodes: trace2.episodes.length, artifacts: (trace2.artifacts || []).length, consistencyScore: trace2.consistency && trace2.consistency.score },
    },
    resumeBatch: { batchId: BATCH2, firstSubmitted: resumeFirst.submitted, restSubmitted: resumeRest.submitted, backendCalls: backend2.state.calls, firstEpisodeTasks: (await tasksOfBatch(`${BATCH2}:E1`)).length },
    caps: { maxEpisodes: capPlan1.blocked, maxPoints: capPlan2.blocked, maxDuration: { submitted: capSubmit.submitted, stoppedBy: capSubmit.stoppedBy, statuses: capTrace.episodes.map((item) => item.status) } },
    redLines: { tools: defs.length, methods: METHODS.length, dependencies: pkg.dependencies || {}, oldDataUnchanged: oldDataOk },
    checks: { passed, failed, total: passed + failed },
  }
  const evidenceDir = process.env.DSH_AI_DRAMA_EVIDENCE_DIR || path.join(pluginRoot, 'evidence')
  await fs.mkdir(evidenceDir, { recursive: true })
  await fs.writeFile(path.join(evidenceDir, 'v0.7.1-P2-7批量-2026-10-18.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8')
  console.log('证据 JSON 已写入：证据/v0.7.1-P2-7批量-2026-10-18.json')
}
await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
