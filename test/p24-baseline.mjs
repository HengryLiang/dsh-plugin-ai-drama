/**
 * P2-4 检索基线采集（task-38）—— 只执行统计，不改产品代码
 *
 * 输入：`_recover/fixtures/100ep/`（host task-37，固定种子 seed=20261018、311 文件/1.86MB）
 *       `_recover/fixtures/100ep/MANIFEST.json`（人物/地点/规则/台词/伏笔/桥段实例值）
 * 查询：PM 清单 Q01–Q10（P2-4 草案 §5，模板由 MANIFEST 实例化，不猜字符串）
 * 指标：top-1/top-5 召回、P95 时延、冷启动（全量扫描）耗时、单集增量后检索耗时、degraded 可观测、
 *       **结构性缺口**：collectDocs MAX_DOCS=400 硬上限 → 统计扫描文档数/被截断类别/未命中查询根因。
 *
 * 说明：本脚本是**基线统计**（对照 P2-4 目标），不把「未达目标」当作用例失败；只校验采集有效性。
 * 隔离：检索在临时副本运行（`%TEMP%\p24-baseline-*`），_recover 夹具与用户数据零改动（末尾复核）。
 *
 * 运行：node test/p24-baseline.mjs
 *   DSH_P24_WRITE_EVIDENCE=1 → 写 `AI短剧工作区/证据/P2-4-基线-2026-10-18.json`
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const RSS_START = process.memoryUsage().rss
const GATE = process.env.DSH_P24_GATE === '1'

function skip(message) {
  console.log(`\n结果：0 passed, 0 failed（SKIP：${message}）`)
  process.exit(0)
}

/* ------------------------------------------------------------------ 定位夹具 / MANIFEST */
const ROOT_CANDIDATES = [
  process.env.DSH_P24_FIXTURE,
  path.join(pluginRoot, '..', '_recover', 'fixtures', '100ep'),
].filter(Boolean)
let fixtureRoot = null
for (const candidate of ROOT_CANDIDATES) {
  try {
    if ((await fs.stat(candidate)).isDirectory()) {
      fixtureRoot = candidate
      break
    }
  } catch {}
}
if (!fixtureRoot) skip('100 集样例夹具未找到（host task-37 生成脚本未交付/未运行）')

async function findFile(dir, target, depth = 0) {
  if (depth > 4) return null
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) if (!e.isDirectory() && e.name === target) return path.join(dir, e.name)
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const found = await findFile(path.join(dir, e.name), target, depth + 1)
    if (found) return found
  }
  return null
}
const manifestPath = (await findFile(fixtureRoot, 'MANIFEST.json')) || path.join(fixtureRoot, 'MANIFEST.json')
let manifest
try {
  manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
} catch {
  skip(`MANIFEST.json 未找到或不可解析（期望 ${manifestPath}；qa 不得用猜测字符串替代）`)
}
const manifestDir = path.dirname(manifestPath)

/* ------------------------------------------------------------------ 定位工作区/项目 */
const wsCandidates = [path.join(manifestDir, 'AI短剧'), path.join(fixtureRoot, 'AI短剧'), manifestDir, fixtureRoot]
let fixtureWorkspace = null
for (const candidate of wsCandidates) {
  try {
    const entries = await fs.readdir(candidate, { withFileTypes: true })
    if (entries.some((e) => e.isDirectory() && !e.name.startsWith('.'))) {
      fixtureWorkspace = candidate
      break
    }
  } catch {}
}
if (!fixtureWorkspace) skip('100 集夹具中未找到项目目录（AI短剧/<项目>）')
const projectDirs = (await fs.readdir(fixtureWorkspace, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
const projectTitle = manifest.projectTitle || manifest.title || projectDirs[0]
if (!projectTitle || !projectDirs.includes(projectTitle)) skip(`MANIFEST 项目名无法匹配项目目录（候选：${JSON.stringify(projectDirs.slice(0, 5))}）`)

/* ------------------------------------------------------------------ 生成 10 组标注查询（不猜字符串） */
const pick = (list, i) => (Array.isArray(list) && list.length ? list[i % list.length] : null)
const characters = manifest.characters || []
const dialogues = manifest.dialogues || []
const plots = manifest.plots || []
const foreshadows = manifest.foreshadows || []
const worldRules = manifest.worldRules || manifest.worldview || []
const locations = manifest.locations || []
const missingManifestFields = [
  ['characters', characters.length],
  ['dialogues', dialogues.length],
  ['plots', plots.length],
  ['foreshadows', foreshadows.length],
  ['worldRules', worldRules.length],
  ['locations', locations.length],
].filter(([, n]) => !n).map(([k]) => k)
if (missingManifestFields.length) skip(`MANIFEST 实例值不足（缺 ${missingManifestFields.join('、')}）——qa 不得用猜测字符串替代（P2-4 草案 §5）`)

const c0 = pick(characters, 0)
const c1 = pick(characters, 1)
const c2 = pick(characters, 2)
const d0 = pick(dialogues, 0)
const entries = [
  { id: 'Q01', type: '人物·姓名', query: c0.name, expected: ['人物'], exact: true },
  { id: 'Q02', type: '人物·关系', query: `${c1.name} 与 ${c0.name} 的关系`, expected: ['人物', '总纲'], exact: false },
  { id: 'Q03', type: '台词·原句', query: d0.text || d0.line, expected: ['分集剧本'], exact: true },
  { id: 'Q04', type: '台词·角色口吻', query: `${c2.name} 的台词`, expected: ['分集剧本', '人物'], exact: false },
  { id: 'Q05', type: '桥段·事件', query: pick(plots, 0).title, expected: ['总纲', '分集剧本'], exact: false },
  { id: 'Q06', type: '桥段·反转', query: pick(plots, 1).title, expected: ['总纲'], exact: false },
  { id: 'Q07', type: '伏笔·物品', query: pick(foreshadows, 0).key, expected: ['本剧记忆'], exact: true },
  { id: 'Q08', type: '伏笔·未回收', query: `待回收：${pick(foreshadows, 1).key}`, expected: ['本剧记忆'], exact: false },
  { id: 'Q09', type: '世界观·规则', query: pick(worldRules, 0).title, expected: ['世界观'], exact: true },
  { id: 'Q10', type: '世界观·地点', query: pick(locations, 0).name, expected: ['世界观'], exact: true },
]
for (const q of entries) if (!q.query) skip(`查询 ${q.id} 模板实例化为空（MANIFEST 字段缺失）`)

/* ------------------------------------------------------------------ 临时副本（不污染夹具/用户数据） */
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'p24-baseline-'))
const tempWorkspace = path.join(tempRoot, 'AI短剧')
await fs.cp(fixtureWorkspace, tempWorkspace, { recursive: true })

/* ------------------------------------------------------------------ 插件 harness（源码树） */
const { apply, METHODS } = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
const store = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'store.js')).href)
const toolsMod = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'tools.js')).href)
const routes = new Map()
const ctx = {
  provide: () => {},
  inject(_services, callback) {
    callback({
      connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } },
      commands: { register: () => () => {} },
      agents: { list: () => [], roots: () => [] },
      workspaceRegistry: { list: async () => [{ path: tempRoot }] },
      get: (name) => (name === 'workspaceRegistry' ? { list: async () => [{ path: tempRoot }] } : name === 'agents' ? { list: () => [] } : undefined),
      on: () => {},
      effect: (fn) => fn(),
    })
  },
  logger: { info: () => {}, warn: () => {} },
}
apply(ctx, { root: tempRoot })
async function call(method, body) {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('route not registered: ' + method)
  const request = new Request('http://127.0.0.1:1/api/ai-drama/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' },
    body: JSON.stringify(body || {}),
  })
  const response = await spec.fetch(request)
  const payload = await response.json().catch(() => null)
  return { status: response.status, body: payload }
}
const hitPath = (hit) => String(hit.path || hit.relative || hit.file || hit.node || '').replace(/\\/g, '/')
const folderOf = (hit) => hitPath(hit).split('/')[0]

/* ------------------------------------------------------------------ 采集 10 组查询 */
const RSS_BEFORE_SEARCH = process.memoryUsage().rss
const rows = []
const responses = []
let top1 = 0
let top5 = 0
let degradedObserved = false
let scanned = 0
const coldStartAt = Date.now()
let coldMs = null
let first = true
for (const q of entries) {
  const started = Date.now()
  const res = await call('search-context', { title: projectTitle, query: q.query, topK: 5 })
  const elapsed = Date.now() - started
  if (first) {
    coldMs = Date.now() - coldStartAt
    first = false
  }
  const hits = (res.body && res.body.hits) || []
  responses.push((res && res.body) || {})
  if (Number(res.body && res.body.scanned) > 0) scanned = Number(res.body.scanned)
  if (res.body && res.body.degraded === true) degradedObserved = true
  const top1Hit = Boolean(hits[0] && q.expected.includes(folderOf(hits[0])))
  const top5Hit = hits.slice(0, 5).some((h) => q.expected.includes(folderOf(h)))
  if (top1Hit) top1 += 1
  if (top5Hit) top5 += 1
  rows.push({
    id: q.id,
    type: q.type,
    query: String(q.query).slice(0, 70),
    expectedFolders: q.expected,
    exact: q.exact,
    top1Hit,
    top5Hit,
    elapsedMs: elapsed,
    hitCount: hits.length,
    top3: hits.slice(0, 3).map(hitPath),
  })
}
// 预热复测（去冷启动），用于 P95
const warm = []
for (let round = 0; round < 3; round += 1) {
  for (const q of entries) {
    const started = Date.now()
    await call('search-context', { title: projectTitle, query: q.query, topK: 5 })
    warm.push(Date.now() - started)
  }
}
const sorted = [...warm].sort((a, b) => a - b)
const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] || 0
const p50 = sorted[Math.floor(sorted.length / 2)] || 0
// 单集增量：改动一集后重新检索（当前词法实现无持久索引，衡量扫描成本）
let incrementalMs = -1
try {
  const epDir = path.join(tempWorkspace, projectTitle, '分集剧本')
  const epFiles = (await fs.readdir(epDir)).filter((f) => f.endsWith('.md')).sort()
  const target = path.join(epDir, epFiles[0])
  const text = await fs.readFile(target, 'utf8')
  const started = Date.now()
  await fs.writeFile(target, text + '\n\n（增量测试标记）\n', 'utf8')
  await call('search-context', { title: projectTitle, query: entries[0].query, topK: 5 })
  incrementalMs = Date.now() - started
} catch {
  incrementalMs = -1
}

/* ------------------------------------------------------------------ 结构性缺口复核（MAX_DOCS） */
const MAX_DOCS = 400 // ai-drama-plugin/lib/retrieval.js collectDocs 上限
let inventory = null
try {
  const [contract, outline, charList, epList] = await Promise.all([
    store.getContract(tempRoot, projectTitle).catch(() => ({})),
    store.getOutline(tempRoot, projectTitle).catch(() => []),
    store.getCharacters(tempRoot, projectTitle).catch(() => []),
    store.listEpisodes(tempRoot, projectTitle).catch(() => []),
  ])
  let shotCount = 0
  const shotsPerEpisode = []
  for (const ep of epList) {
    const shots = await store.getStoryboard(tempRoot, projectTitle, ep.order).catch(() => [])
    shotsPerEpisode.push(shots.length)
    shotCount += shots.length
  }
  const freeTextFiles = []
  for (const dir of ['构想', '世界观', '本剧记忆', '台词与音效']) {
    const base = path.join(tempWorkspace, projectTitle, dir)
    let names = []
    try {
      names = (await fs.readdir(base)).filter((n) => /\.(md|txt)$/i.test(n))
    } catch {}
    for (const name of names) freeTextFiles.push(`${dir}/${name}`)
  }
  const structuredCount = 1 + outline.length + charList.length + epList.length + shotCount
  const freeTextCount = freeTextFiles.length
  const totalDocs = structuredCount + freeTextCount
  const scannedCount = Math.min(MAX_DOCS, totalDocs)
  const freeTextScanned = Math.max(0, Math.min(scannedCount - structuredCount, freeTextCount))
  let consumed = 1 + outline.length + charList.length
  let scannedEpisodes = 0
  let scannedShots = 0
  if (consumed < scannedCount) {
    for (const m of shotsPerEpisode) {
      const need = 1 + m
      if (consumed + need > scannedCount) break
      consumed += need
      scannedEpisodes += 1
      scannedShots += m
    }
  }
  inventory = {
    maxDocs: MAX_DOCS,
    contractDocs: 1,
    outlineDocs: outline.length,
    characterDocs: charList.length,
    episodeDocs: epList.length,
    shotDocs: shotCount,
    freeTextDocs: freeTextCount,
    freeTextFiles,
    structuredCount,
    totalDocs,
    scanned: scannedCount,
    truncatedDocs: totalDocs - scannedCount,
    freeTextScanned,
    freeTextSkipped: freeTextCount - freeTextScanned,
    scannedEpisodes,
    scannedShots,
    expectedEpisodes: epList.length,
    expectedShots: shotCount,
  }
} catch (error) {
  console.log('（结构性缺口复核失败：' + (error instanceof Error ? error.message : String(error)) + '）')
}

/* ------------------------------------------------------------------ 汇总 */
const total = entries.length
const missTop5 = rows.filter((r) => !r.top5Hit).map((r) => r.id)
const missTop1 = rows.filter((r) => !r.top1Hit).map((r) => r.id)
async function countFiles(dir) {
  let count = 0
  let list = []
  try {
    list = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of list) {
    if (e.isDirectory()) count += await countFiles(path.join(dir, e.name))
    else count += 1
  }
  return count
}
const stats = {
  projectTitle,
  fixtureRoot,
  manifestPath,
  manifestSeed: manifest.seed,
  manifestCounts: manifest.counts,
  fixtureFileCount: await countFiles(fixtureRoot),
  queries: total,
  top1Hit: top1,
  top5Hit: top5,
  top1Recall: `${top1}/${total}`,
  top5Recall: `${top5}/${total}`,
  missTop1,
  missTop5,
  coldMs,
  p50Ms: p50,
  p95Ms: p95,
  incrementalMs,
  degradedObserved,
  scannedDocs: scanned,
  inventory,
  methods: METHODS.length,
  rows,
}
console.log('\n[P2-4 基线采集] 现有词法检索 · 100 集样例（seed=' + manifest.seed + '）')
console.table(rows.map((r) => ({ id: r.id, type: r.type, top1: r.top1Hit, top5: r.top5Hit, ms: r.elapsedMs, hitCount: r.hitCount })))
console.log(JSON.stringify({ top1Recall: stats.top1Recall, top5Recall: stats.top5Recall, missTop5, coldMs, p50Ms: p50, p95Ms: p95, incrementalMs, degradedObserved, scannedDocs: scanned, inventory }, null, 2))

/* ------------------------------------------------------------------ 采集有效性校验（不把未达目标当失败） */
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
function target(label, met, detail) {
  console.log(`  ${met ? 'PASS' : 'MISS'}  ${label}${detail ? ' -> ' + detail : ''}`)
}
check('采集：10 组查询全部执行', rows.length === 10, String(rows.length))
check('采集：夹具文件结构完整（≥300 文件 + MANIFEST）', stats.fixtureFileCount >= 300 && Boolean(manifestPath), String(stats.fixtureFileCount))
check('采集：MANIFEST counts 与夹具一致（episodes=100/characters=20/worldRules=50/foreshadows=30/plots=100）', (() => {
  const c = manifest.counts || {}
  return c.episodes === 100 && c.characters === 20 && c.worldRules === 50 && c.foreshadows === 30 && c.plots === 100
})(), JSON.stringify(manifest.counts))
check('采集：degraded 状态可观测（布尔记录）', typeof stats.degradedObserved === 'boolean', String(stats.degradedObserved))
check('采集：可观测扫描文档数（scanned>0）', scanned > 0, String(scanned))
if (!GATE) check('缺口复核：MAX_DOCS=400 上限成立且总文档数 > 400', Boolean(inventory) && inventory.maxDocs === 400 && inventory.totalDocs > 400, JSON.stringify(inventory && { totalDocs: inventory.totalDocs, truncatedDocs: inventory.truncatedDocs }))
if (!GATE) check('缺口复核：自由文本目录（世界观/本剧记忆/构想/台词与音效）未被扫描', Boolean(inventory) && inventory.freeTextScanned === 0 && inventory.freeTextSkipped > 0, JSON.stringify(inventory && { freeTextScanned: inventory.freeTextScanned, freeTextSkipped: inventory.freeTextSkipped, files: inventory.freeTextFiles }))
if (!GATE) check('缺口复核：分集/分镜被截断（未扫描集数>0 或未扫描镜数>0）', Boolean(inventory) && (inventory.scannedEpisodes < inventory.expectedEpisodes || inventory.scannedShots < inventory.expectedShots), JSON.stringify(inventory && { scannedEpisodes: inventory.scannedEpisodes, expectedEpisodes: inventory.expectedEpisodes, scannedShots: inventory.scannedShots, expectedShots: inventory.expectedShots }))
// 目标对照（仅记录，不判失败——这是基线，不是验收门禁）
target(`AC-Q1 目标 top-1 ≥9/10（实际 ${top1}/10）`, top1 >= 9, stats.top1Recall)
target(`AC-Q1 目标 top-5 =10/10（实际 ${top5}/10）`, top5 >= 10, stats.top5Recall)
target(`AC-Q2 目标 P95 ≤300ms（实际 ${p95}ms）`, p95 <= 300, `${p95}ms`)
target(`AC-Q3 目标增量 ≤1s（实际 ${incrementalMs}ms）`, incrementalMs >= 0 && incrementalMs <= 1000, `${incrementalMs}ms`)
target(`AC-Q4 目标 degraded 可观测（实际 ${stats.degradedObserved}）`, typeof stats.degradedObserved === 'boolean')
// 用户数据零改动（复用 P2-1 基线）
const baselineCandidates = [
  process.env.DSH_AI_P163_BASELINE,
  path.join(pluginRoot, '..', 'AI短剧工作区', '证据', 'P2-1-旧数据基线-2026-10-17.json'),
]
let baselineText = null
for (const candidate of baselineCandidates.filter(Boolean)) {
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
    let list = []
    try {
      list = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name)
      const rel = path.join(relBase, e.name)
      if (e.isDirectory()) await walk(abs, rel)
      else {
        try {
          const buf = await fs.readFile(abs)
          files.push({ relative: rel, sha256: crypto.createHash('sha256').update(buf).digest('hex') })
        } catch {}
      }
    }
  }
  await walk(REAL_ROOT)
  const baseMap = new Map(baseline.files.map((f) => [f.relative, f]))
  const curMap = new Map(files.map((f) => [f.relative, f]))
  const missing = [...baseMap.keys()].filter((k) => !curMap.has(k))
  const added = [...curMap.keys()].filter((k) => !baseMap.has(k))
  const changed = [...baseMap.keys()].filter((k) => curMap.has(k) && curMap.get(k).sha256 !== baseMap.get(k).sha256)
  check('收尾：用户数据 32 文件 hash 不变（临时副本运行）', missing.length === 0 && added.length === 0 && changed.length === 0, JSON.stringify({ missing, added, changed }).slice(0, 300))
}

/* ------------------------------------------------------------------ v0.6.4 门禁（DSH_P24_GATE=1） */
let gate = null
if (GATE) {
  const rssAfter = process.memoryUsage().rss
  const rssDeltaMB = Math.max(0, (rssAfter - RSS_BEFORE_SEARCH) / (1024 * 1024))
  let scanMetaObj = null
  for (const body of responses) {
    if (body && body.scanMeta && typeof body.scanMeta === 'object') { scanMetaObj = body.scanMeta; break }
    if (body && body.scannedByType && typeof body.scannedByType === 'object') { scanMetaObj = { byType: body.scannedByType }; break }
  }
  const byType = (scanMetaObj && scanMetaObj.byType) || null
  const worldMemoryScanned = Boolean(byType && Number(byType.world) > 0 && Number(byType.memory) > 0)
  const hasScanned = responses.some((b) => b && Number.isFinite(Number(b.scanned)))
  const hasTruncated = responses.some((b) => b && Number.isFinite(Number(b.truncated)))
  const hasDegradedFlag = responses.some((b) => b && typeof b.degraded === 'boolean')
  const allTruncatedZero = responses.every((b) => b && Number(b.truncated) === 0)
  const allDegradedFalse = responses.every((b) => b && b.degraded === false)
  const worldMemoryIds = ['Q07', 'Q08', 'Q09', 'Q10']
  const worldMemoryHit = worldMemoryIds.every((id) => (rows.find((r) => r.id === id) || {}).top5Hit === true)
  const noErrors = responses.every((b) => b && b.ok !== false)
  const indexDirPath = path.join(tempWorkspace, projectTitle, '.aidrama', 'index')
  const indexDirBefore = await fs.stat(indexDirPath).then(() => true).catch(() => false)
  const indexFile = path.join(indexDirPath, 'retrieval-index.json')
  const indexExists = await fs.stat(indexFile).then(() => true).catch(() => false)
  const indexMeta = indexExists ? await fs.readFile(indexFile, 'utf8').then((s) => { try { return JSON.parse(s) } catch { return null } }).catch(() => null) : null
  const indexSchemaVersion = indexMeta && Number(indexMeta.schemaVersion)
  const indexDirAfter = await fs.stat(indexDirPath).then(() => true).catch(() => false)
  const indexRebuilt = indexMeta && indexMeta.index && typeof indexMeta.index.rebuilt === 'boolean' ? indexMeta.index.rebuilt : (indexMeta && typeof indexMeta.rebuilt === 'boolean' ? indexMeta.rebuilt : null)
  const defs = toolsMod.createToolDefs({ rootOf: () => tempRoot, backendOf: () => null })
  const pkgGate = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
  const gateChecks = []
  const gateCheck = (id, label, ok, detail) => {
    gateChecks.push({ id, label, ok: Boolean(ok), detail })
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${id}] ${label}${detail ? ' -> ' + detail : ''}`)
  }
  gateCheck('AC-S1', `top-1 召回 ${top1}/10 ≥ 9/10`, top1 >= 9, `${top1}/10`)
  gateCheck('AC-S1', `top-5 召回 ${top5}/10 = 10/10`, top5 >= 10, `${top5}/10`)
  gateCheck('AC-S2', 'world/memory 必扫：Q07–Q10 全部命中', worldMemoryHit, JSON.stringify(worldMemoryIds.map((id) => ({ id, hit: (rows.find((r) => r.id === id) || {}).top5Hit }))))
  gateCheck('AC-S2b', 'scanMeta.byType 暴露 world/memory 扫描计数且均 >0', worldMemoryScanned, byType ? JSON.stringify({ world: byType.world, memory: byType.memory, keys: Object.keys(byType) }).slice(0, 260) : '未暴露 scanMeta.byType')
  gateCheck('AC-S3', `检索 P95 ${p95}ms ≤ 300ms`, p95 <= 300, `${p95}ms`)
  gateCheck('AC-S3b', '增量索引后置（Q1 裁定；仅记录检索耗时）', true, `incrementalMs=${incrementalMs}`)
  gateCheck('AC-S4', '截断/降级可观测：顶层 scanned 计数存在', hasScanned, `scanned=${scanned}`)
  gateCheck('AC-S4b', '正常夹具：顶层 truncated=0 且 degraded=false', hasTruncated && hasDegradedFlag && allTruncatedZero && allDegradedFalse, JSON.stringify({ hasTruncated, hasDegradedFlag, allTruncatedZero, allDegradedFalse }))
  gateCheck('AC-S4c', 'scanMeta 可观测：quota/quotaExhausted 正常夹具为空、truncated=0', Boolean(scanMetaObj) && Array.isArray(scanMetaObj.quotaExhausted) && scanMetaObj.quotaExhausted.length === 0 && Number(scanMetaObj.truncated) === 0, scanMetaObj ? JSON.stringify({ quota: scanMetaObj.quota, quotaExhausted: scanMetaObj.quotaExhausted, truncated: scanMetaObj.truncated, degraded: scanMetaObj.degraded }) : 'no scanMeta')
  // AC-S5 口径（Lead 2026-10-18 校准，实测校准原则）：3 次连续复跑 median(RSS 增量) ≤50MB 且 max ≤55MB；
  // 单次运行时以 max 上限 55MB 作硬门禁（median 由 3 次复跑在证据层汇总计算）。
  gateCheck('AC-S5', `100 集加载后 RSS 增量 ${rssDeltaMB.toFixed(1)}MB ≤ 55MB（单次 max 上限；3 次 median≤50/max≤55 口径）`, rssDeltaMB <= 55, `${rssDeltaMB.toFixed(2)}MB（before=${(RSS_BEFORE_SEARCH / 1048576).toFixed(1)}MB, after=${(rssAfter / 1048576).toFixed(1)}MB）`)
  gateCheck('AC-S6', 'METHODS 仍 = 68', METHODS.length === 68, String(METHODS.length))
  gateCheck('AC-S6', '生产工具面仍 34', defs.length === 34, String(defs.length))
  gateCheck('AC-S6', '无新增外部依赖', !pkgGate.dependencies || Object.keys(pkgGate.dependencies).length === 0, JSON.stringify(pkgGate.dependencies || {}))
  gateCheck('AC-S7', '旧项目兼容：无索引时检索不报错（懒构建/回退）', noErrors, JSON.stringify({ indexDirBefore, indexDirAfter }))
  gateCheck('AC-S7b', '索引懒构建：.aidrama/index/retrieval-index.json 存在且 schemaVersion=1', indexExists && indexSchemaVersion === 1, JSON.stringify({ indexExists, indexSchemaVersion, rebuilt: indexRebuilt }))
  gateCheck('AC-S7c', '索引不随导出（manifest 无 .aidrama/index/retrieval-index 路径）', await (async () => {
    try {
      const exp = await call('export-project', { title: projectTitle, format: 'markdown' })
      if (exp.status !== 200) return false
      const exportDir = path.join(tempWorkspace, projectTitle, '导出')
      const names = await fs.readdir(exportDir).catch(() => [])
      const manifestName = names.find((n) => /manifest/.test(n))
      const txt = manifestName ? await fs.readFile(path.join(exportDir, manifestName), 'utf8').catch(() => '') : ''
      return !/aidrama|retrieval-index/i.test(txt)
    } catch {
      return false
    }
  })(), 'export-manifest-scan')
  // AC-S4d：配额耗尽场景（host 测试钩子 DSH_AI_DRAMA_RETRIEVAL_QUOTA；需在**全新无索引项目副本**上首次构建才会生效）
  const quotaEnvKey = 'DSH_AI_DRAMA_RETRIEVAL_QUOTA'
  const quotaTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'p24-quota-'))
  let quotaScenario = null
  let prevQuota = process.env[quotaEnvKey]
  try {
    await fs.cp(fixtureWorkspace, path.join(quotaTempRoot, 'AI短剧'), { recursive: true })
    process.env[quotaEnvKey] = JSON.stringify({ episodes: 5, shots: 10, freeText: 1 })
    const retrievalMod = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'retrieval.js')).href)
    const qb = await retrievalMod.searchContext(quotaTempRoot, projectTitle, entries[0].query, { topK: 5 })
    quotaScenario = {
      degraded: qb.degraded,
      degradeReason: qb.degradeReason,
      truncated: qb.truncated,
      quotaExhausted: qb.scanMeta && qb.scanMeta.quotaExhausted,
      byType: qb.scanMeta && qb.scanMeta.byType,
      quota: qb.scanMeta && qb.scanMeta.quota,
      scanned: qb.scanned,
    }
  } catch (error) {
    quotaScenario = { error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (prevQuota === undefined) delete process.env[quotaEnvKey]
    else process.env[quotaEnvKey] = prevQuota
    await fs.rm(quotaTempRoot, { recursive: true, force: true }).catch(() => {})
  }
  gateCheck('AC-S4d', '配额耗尽场景（全新项目副本+钩子配额）：degraded=true + scan-quota-exhausted + truncated>0 + quotaExhausted 非空', Boolean(quotaScenario && quotaScenario.degraded === true && /scan-quota-exhausted/.test(String(quotaScenario.degradeReason)) && Number(quotaScenario.truncated) > 0 && Array.isArray(quotaScenario.quotaExhausted) && quotaScenario.quotaExhausted.length > 0), JSON.stringify(quotaScenario).slice(0, 420))
  // AC-S7d/e/f：index.rebuilt 三态（first true / unchanged false / stale true）
  const firstScanIndex = (() => { for (const b of responses) { if (b && b.scanMeta && b.scanMeta.index) return b.scanMeta.index } return null })()
  const lastScanIndex = (() => { for (let i = responses.length - 1; i >= 0; i -= 1) { const b = responses[i]; if (b && b.scanMeta && b.scanMeta.index) return b.scanMeta.index } return null })()
  gateCheck('AC-S7d', '首次懒构建 scanMeta.index.rebuilt=true', Boolean(firstScanIndex && firstScanIndex.rebuilt === true), JSON.stringify(firstScanIndex))
  gateCheck('AC-S7e', '索引未变再检索 scanMeta.index.rebuilt=false', Boolean(lastScanIndex && lastScanIndex.rebuilt === false), JSON.stringify(lastScanIndex))
  let staleRebuilt = null
  try {
    const epDir2 = path.join(tempWorkspace, projectTitle, '分集剧本')
    const epFiles2 = (await fs.readdir(epDir2)).filter((f) => f.endsWith('.md')).sort()
    const tgt = path.join(epDir2, epFiles2[0])
    const txt = await fs.readFile(tgt, 'utf8')
    await fs.writeFile(tgt, txt + '\n\n（stale 重建测试）\n', 'utf8')
    const sres = await call('search-context', { title: projectTitle, query: entries[0].query, topK: 5 })
    staleRebuilt = sres.body && sres.body.scanMeta && sres.body.scanMeta.index ? sres.body.scanMeta.index.rebuilt : null
  } catch {}
  gateCheck('AC-S7f', '单集改动后 stale 重建 scanMeta.index.rebuilt=true', staleRebuilt === true, String(staleRebuilt))
  gate = {
    rssBeforeSearchBytes: RSS_BEFORE_SEARCH,
    rssAfterBytes: rssAfter,
    rssDeltaMB: Number(rssDeltaMB.toFixed(2)),
    scanMeta: scanMetaObj,
    byType,
    worldMemoryScanned,
    hasScanned,
    hasTruncated,
    hasDegradedFlag,
    allTruncatedZero,
    allDegradedFalse,
    worldMemoryHit,
    indexDirBefore,
    indexDirAfter,
    indexExists,
    indexSchemaVersion: indexMeta ? indexMeta.schemaVersion : null,
    indexRebuilt,
    quotaScenario,
    firstScanIndex,
    lastScanIndex,
    staleRebuilt,
    noErrors,
    checks: gateChecks,
    pass: gateChecks.every((c) => c.ok),
  }
}

const report = {
  at: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, retrieval: 'local-lexical (BM25-style)' },
  stats,
  assessment: {
    top1Met: top1 >= 9,
    top5Met: top5 >= 10,
    p95Met: p95 <= 300,
    incrementalMet: incrementalMs >= 0 && incrementalMs <= 1000,
    structuralGap: Boolean(inventory) && inventory.totalDocs > inventory.maxDocs,
    rootCause: 'retrieval.js collectDocs MAX_DOCS=400 平铺上限：结构化文档（契约/大纲/人物/分集/分镜）先占满 400，世界观/本剧记忆/构想/台词与音效等自由文本目录完全未扫描；100 集下大量分集/分镜也被截断',
  },
  checks: { passed, failed, failures },
  gate,
}
if (process.env.DSH_P24_WRITE_EVIDENCE === '1') {
  const localDate = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10) // Asia/Shanghai 本地日期
  const out = path.join(pluginRoot, '..', 'AI短剧工作区', '证据', GATE ? `P2-4-v0.6.4-复测-${localDate}.json` : `P2-4-基线-${localDate}.json`)
  await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n', 'utf8')
  console.log('证据已写入：' + out)
}
if (gate) {
  console.log(`\nv0.6.4 门禁：${gate.pass ? 'PASS' : 'FAIL'}（${gate.checks.filter((c) => c.ok).length}/${gate.checks.length} 项通过）`)
  for (const c of gate.checks.filter((x) => !x.ok)) console.log(`  - [${c.id}] ${c.label}${c.detail ? ' -> ' + c.detail : ''}`)
}
await fs.rm(tempRoot, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 && (!gate || gate.pass) ? 0 : 1)
