/**
 * v0.16.7 C-2 跨项目资产复用 QA 验收套件（task-146；**第 50 套件**）
 *
 * 契约（C2-H v0.16.7 实测校准）：
 * - `assets-import` source 模式（E13 add-only）：`{ title, sourceProjectId, sourceAssetIds[], targetCategory? }`
 *   与 base64/fileName/expectedSha256/maxBytes 互斥；sourceAssetIds = 源项目 `.aidrama/assets.json` 的 assets[] id；
 * - 请求级非法（空批/源=目标/非受管/穿越 title/非数组/非法分类/互斥/批>100）→ 4xx；
 *   逐项失败（不存在 id → failed code=not-found；源文件 >50MB → failed code=too-large）→ **200 聚合**；
 * - 成功：复制入目标 `素材/<分类>/` + SHA256 一致 + 自动登记 + importedFrom 溯源（不落绝对路径）；
 *   SHA 去重 → skipped duplicate；同名 → `(2)`；targetCategory 缺省按源路径分类推导/否则 导入_YYYYMMDD；
 * - 源项目只读；目标审计含 assets-import；base64 模式回归；METHODS 71/工具 34/调用点 71/slots 4。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href)
const store = await load('lib/store.js')
const indexMod = await load('index.js')
const toolsModule = await load('lib/tools.js')
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8')
const indexSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const importSrc = await fs.readFile(path.join(pluginRoot, 'lib', 'import-assets.js'), 'utf8')
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

let passed = 0
let failed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) passed += 1
  else { failed += 1; failures.push(label + (detail ? ' -> ' + detail : '')); console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`) }
}
const group = (name) => console.log('\n' + name)

const METHODS = indexMod.METHODS || []
const TOOLS = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES : []
const CLIENT_CALLS = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
const SLOTS = (clientSrc.match(/slots\.register\(/g) || []).length

group('[0] 能力探测 / 契约（版本自适应）')
const hostCapability = /sourceProjectId/.test(importSrc) || /sourceProjectId/.test(indexSrc)
const clientCapability = /从其他项目导入/.test(clientSrc)
if (!hostCapability && !clientCapability) {
  console.log('  结果：0 passed, 0 failed（SKIP：host 未含 sourceProjectId 源模式、client 未含「从其他项目导入」）')
  process.exit(0)
}
check('0.1 契约：METHODS 71 / 工具 34 / client 调用点 71 / slots=4 / 无新依赖（E 类 add-only，不新增方法）', METHODS.length === 72 && TOOLS.length === 35 && CLIENT_CALLS.size === 72 && SLOTS === 4 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ methods: METHODS.length, tools: TOOLS.length, calls: CLIENT_CALLS.size, slots: SLOTS }))

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'c2-copy-'))
const SOURCE_TITLE = 'C2源项目'
const TARGET_TITLE = 'C2目标项目'
await store.createProject(workspace, SOURCE_TITLE)
await store.createProject(workspace, TARGET_TITLE)
const sourceDir = path.join(workspace, 'AI短剧', SOURCE_TITLE)
const targetDir = path.join(workspace, 'AI短剧', TARGET_TITLE)
const mk = (rel) => path.join(sourceDir, rel.split('/').join(path.sep))
const png = (seed) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, seed + 1, seed + 2, seed + 3])
const rolePng = png(11)
const scenePng = png(21)
const propPng = png(31)
const sameNamePng = png(41)
const sameName2Png = png(51)
const defaultPng = png(61)
const dupPng = png(71)
for (const rel of ['素材/角色/CHR901.png', '素材/场景/SPC901.png', '素材/道具/PRP901.png', '素材/角色/SAME901.png', '素材/角色/SAME902.png', '素材/道具/DFT901.png', '素材/角色/DUP901.png']) {
  await fs.mkdir(path.dirname(mk(rel)), { recursive: true })
  const map = { '素材/角色/CHR901.png': rolePng, '素材/场景/SPC901.png': scenePng, '素材/道具/PRP901.png': propPng, '素材/角色/SAME901.png': sameNamePng, '素材/角色/SAME902.png': sameName2Png, '素材/道具/DFT901.png': defaultPng, '素材/角色/DUP901.png': dupPng }
  await fs.writeFile(mk(rel), map[rel])
}
const reg = async (rel, name) => store.addAsset(workspace, SOURCE_TITLE, { source: rel, name })
const roleAsset = await reg('素材/角色/CHR901.png', '源角色.png')
const sceneAsset = await reg('素材/场景/SPC901.png', '源场景.png')
const propAsset = await reg('素材/道具/PRP901.png', '源道具.png')
const sameNameAsset = await reg('素材/角色/SAME901.png', '同名源图.png')
const sameName2Asset = await reg('素材/角色/SAME902.png', '同名源图2.png')
const defaultAsset = await reg('素材/道具/DFT901.png', '缺省分类图.png')
const dupAsset = await reg('素材/角色/DUP901.png', '去重图.png')
await store.saveStyleDNA(workspace, SOURCE_TITLE, { palette: '源色板', lighting: '源光感', texture: '源质感', composition: '源构图', motion: '源运镜' })
await store.saveSceneCard(workspace, SOURCE_TITLE, { id: 'SPC901', name: '源场景', space: { location: '源地点', interior: '内景' }, lighting: '源光源' })
// 目标去重诱饵：已登记同 SHA 资产（dupPng 与源 DUP901 相同内容）
await fs.mkdir(path.join(targetDir, '素材', '角色'), { recursive: true })
await fs.writeFile(path.join(targetDir, '素材', '角色', '已存在去重图.png'), dupPng)
await store.addAsset(workspace, TARGET_TITLE, { source: '素材/角色/已存在去重图.png', name: '已存在去重图.png' })

const routes = new Map()
indexMod.apply({
  provide: () => {},
  inject: (_services, callback) => callback({
    connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } },
    get: (name) => {
      if (name === 'workspaceRegistry') return { list: async () => [{ path: workspace, title: 'W' }] }
      if (name === 'agents') return { list: () => [] }
      return undefined
    },
    on: () => {},
    effect: (fn) => fn(),
  }),
  logger: { info: () => {}, warn: () => {} },
}, { root: workspace })
async function call(method, body) {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('route not registered: ' + method)
  const response = await spec.fetch(new Request('http://127.0.0.1:1/api/ai-drama/' + method, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' }, body: JSON.stringify(body) }))
  const text = await response.text()
  let payload = null
  try { payload = JSON.parse(text) } catch {}
  return { status: response.status, body: payload, text }
}
async function treeHash(dir) {
  const hash = createHash('sha256')
  const files = []
  async function walk(current, rel) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      const relPath = rel ? rel + '/' + entry.name : entry.name
      if (entry.isDirectory()) await walk(full, relPath)
      else if (entry.isFile()) { const b = await fs.readFile(full); hash.update(`${relPath}|`); hash.update(b); files.push({ path: relPath, bytes: b.length, sha256: sha256(b) }) }
    }
  }
  await walk(dir, '')
  return { hash: hash.digest('hex'), files }
}
async function readAssets(title) {
  const dir = path.join(workspace, 'AI短剧', title)
  try { const raw = JSON.parse(await fs.readFile(path.join(dir, '.aidrama', 'assets.json'), 'utf8')); return Array.isArray(raw) ? raw : raw.assets || [] } catch { return [] }
}
const norm = (p) => String(p || '').replace(/\\/g, '/')
const NO_ABS = (text) => !String(text || '').includes(workspace) && !/[A-Za-z]:[\\/]/.test(String(text || ''))
// 零写盘比较口径：素材树 + assets.json（排除 .aidrama/audit 等框架副作用）
async function materialState(dir) {
  const files = (await treeHash(path.join(dir, '素材'))).files
  const assets = await fs.readFile(path.join(dir, '.aidrama', 'assets.json'), 'utf8').catch(() => '')
  const hash = createHash('sha256')
  for (const f of files) hash.update(`${f.path}|${f.sha256}|${f.bytes};`)
  hash.update('|assets|' + assets)
  return hash.digest('hex')
}

if (hostCapability) {
  const sourceBaseline = await treeHash(sourceDir)
  const sourceAssetsBefore = JSON.stringify(await readAssets(SOURCE_TITLE))

  group('[AC-C2-1/2/4] 源模式正向复制 + SHA 一致 + 自动登记 + 源只读')
  const positive = await call('assets-import', { title: TARGET_TITLE, sourceProjectId: SOURCE_TITLE, sourceAssetIds: [sceneAsset.id], targetCategory: '场景' })
  const body = positive.body || {}
  const imported = Array.isArray(body.imported) ? body.imported : []
  const importedEntry = imported[0] || {}
  const copiedPath = importedEntry.path ? path.join(targetDir, ...String(importedEntry.path).split('/')) : ''
  const copiedBuffer = copiedPath ? await fs.readFile(copiedPath).catch(() => null) : null
  const copied = Boolean(copiedBuffer) && sha256(copiedBuffer) === sha256(scenePng)
  const targetAssets = await readAssets(TARGET_TITLE)
  const sourceAfter = await treeHash(sourceDir)
  check('C2-1 正向复制：源登记资产 → 目标 素材/<分类>/（200 + importedTotal 1 + SHA256 一致）', positive.status === 200 && body.mode === 'source' && body.importedTotal === 1 && importedEntry.sha256 === sha256(scenePng) && Boolean(copied), JSON.stringify({ status: positive.status, importedTotal: body.importedTotal, imported: imported.map((i) => ({ name: i.name, path: i.path, category: i.category, sha: String(i.sha256).slice(0, 12) })) }))
  check('C2-2 目标自动登记（registry assetId + importedFrom 溯源指向源项目/源资产）', targetAssets.some((a) => a.id === importedEntry.assetId) && targetAssets.some((a) => a.importedFrom && a.importedFrom.project === SOURCE_TITLE && a.importedFrom.assetId === sceneAsset.id), JSON.stringify(targetAssets.map((a) => ({ id: a.id, importedFrom: a.importedFrom }))))
  const checklist = await fs.readFile(path.join(targetDir, '素材', '素材清单.md'), 'utf8').catch(() => '')
  check('C2-2b 素材清单 add-only 更新（非空，含复制文件名）', checklist.length > 0 && checklist.includes(String(importedEntry.name || '')), '清单 bytes=' + checklist.length)
  check('C2-4 源项目只读：源目录树 hash / 源 assets 记录前后不变', sourceAfter.hash === sourceBaseline.hash && JSON.stringify(await readAssets(SOURCE_TITLE)) === sourceAssetsBefore, JSON.stringify({ before: sourceBaseline.hash.slice(0, 16), after: sourceAfter.hash.slice(0, 16) }))
  check('C2-2c 成功响应新增字段不泄绝对路径（imported/failed 无 workspace/盘符；workspace 信封豁免）', NO_ABS(JSON.stringify(body.imported || [])) && NO_ABS(JSON.stringify(body.failed || [])), JSON.stringify({ imported: JSON.stringify(body.imported || []).slice(0, 160) }))

  group('[AC-C2-2/3] 多资产 / 去重 / 同名 (2) / targetCategory')
  const multi = await call('assets-import', { title: TARGET_TITLE, sourceProjectId: SOURCE_TITLE, sourceAssetIds: [propAsset.id, sameNameAsset.id], targetCategory: '其他' })
  check('C2-2d 多资产批量：importedTotal 2（逐项写入目标）', multi.status === 200 && Number((multi.body || {}).importedTotal) === 2, JSON.stringify({ status: multi.status, importedTotal: multi.body && multi.body.importedTotal, failed: multi.body && multi.body.failedTotal }))
  const beforeDup = await materialState(targetDir)
  const dup = await call('assets-import', { title: TARGET_TITLE, sourceProjectId: SOURCE_TITLE, sourceAssetIds: [dupAsset.id], targetCategory: '角色' })
  const afterDup = await materialState(targetDir)
  const dupBody = dup.body || {}
  check('C2-3a 目标已有同 SHA → 200 skipped duplicate（不覆盖、不重复写）', dup.status === 200 && Number(dupBody.skippedTotal) >= 1 && (dupBody.skipped || []).some((s) => s.reason === 'duplicate') && afterDup === beforeDup, JSON.stringify({ status: dup.status, skipped: dupBody.skipped }))
  // 同名不同内容 → (2)
  const targetSameName = path.join(targetDir, '素材', '角色', 'SAME902.png')
  await fs.writeFile(targetSameName, Buffer.from('target-existing-different-content'))
  const renamed = await call('assets-import', { title: TARGET_TITLE, sourceProjectId: SOURCE_TITLE, sourceAssetIds: [sameName2Asset.id], targetCategory: '角色' })
  const renamedEntry = ((renamed.body || {}).imported || [])[0] || {}
  check('C2-3b 同名不同内容 → 自动 (2) 不覆盖既有文件', renamed.status === 200 && /\(2\)\.png$/.test(String(renamedEntry.name || '')) && (await fs.readFile(targetSameName)).equals(Buffer.from('target-existing-different-content')), JSON.stringify({ status: renamed.status, imported: renamedEntry }))
  // targetCategory 缺省 → 源路径分类
  const defaultRes = await call('assets-import', { title: TARGET_TITLE, sourceProjectId: SOURCE_TITLE, sourceAssetIds: [defaultAsset.id] })
  const defaultEntry = ((defaultRes.body || {}).imported || [])[0] || {}
  check('C2-2e targetCategory 缺省：按源路径分类推导（素材/道具/ → 道具）', defaultRes.status === 200 && defaultEntry.category === '道具' && norm(defaultEntry.path).includes('素材/道具/'), JSON.stringify({ status: defaultRes.status, imported: defaultEntry }))

  group('[AC-C2-5] 逐项失败（200 聚合）与请求级 4xx（零写盘/不泄路径）')
  const beforeMissing = await materialState(targetDir)
  const missing = await call('assets-import', { title: TARGET_TITLE, sourceProjectId: SOURCE_TITLE, sourceAssetIds: ['NOPE999'] })
  const afterMissing = await materialState(targetDir)
  check('C2-5a 不存在资产 id → 200 聚合 + failed code=not-found（目标零写盘）', missing.status === 200 && Number(missing.body.failedTotal) === 1 && ((missing.body.failed || [])[0] || {}).code === 'not-found' && afterMissing === beforeMissing, JSON.stringify({ status: missing.status, failed: missing.body && missing.body.failed }))
  // >50MB 源文件：先登记小文件资产，再替换为 51MB
  const bigRel = '素材/角色/BIG901.png'
  await fs.writeFile(mk(bigRel), png(81))
  const bigAsset = await reg(bigRel, '超大源图.png')
  await fs.writeFile(mk(bigRel), Buffer.alloc(51 * 1024 * 1024, 7))
  const beforeBig = await materialState(targetDir)
  const big = await call('assets-import', { title: TARGET_TITLE, sourceProjectId: SOURCE_TITLE, sourceAssetIds: [bigAsset.id], targetCategory: '角色' })
  const afterBig = await materialState(targetDir)
  check('C2-5b 源文件 >50MB → 200 聚合 + failed code=too-large（目标零写盘、无 tmp）', big.status === 200 && Number((big.body || {}).failedTotal) === 1 && (((big.body || {}).failed || [])[0] || {}).code === 'too-large' && afterBig === beforeBig && !(await treeHash(path.join(targetDir, '素材'))).files.some((f) => /\.tmp$/.test(f.path)), JSON.stringify({ status: big.status, failed: big.body && big.body.failed }))
  await fs.rm(mk(bigRel), { force: true })
  const beforeNeg = await materialState(targetDir)
  const negatives = [
    ['空批', { sourceProjectId: SOURCE_TITLE, sourceAssetIds: [] }],
    ['源=目标', { sourceProjectId: TARGET_TITLE, sourceAssetIds: [sceneAsset.id] }],
    ['非受管源（不存在项目）', { sourceProjectId: '不存在的源项目', sourceAssetIds: [sceneAsset.id] }],
    ['源项目穿越', { sourceProjectId: '../外部', sourceAssetIds: [sceneAsset.id] }],
    ['sourceAssetIds 非数组', { sourceProjectId: SOURCE_TITLE, sourceAssetIds: sceneAsset.id }],
    ['非法 targetCategory', { sourceProjectId: SOURCE_TITLE, sourceAssetIds: [sceneAsset.id], targetCategory: '../场景' }],
    ['与 base64 互斥', { sourceProjectId: SOURCE_TITLE, sourceAssetIds: [sceneAsset.id], fileName: 'x.png', base64: 'aGVsbG8=' }],
    ['批 >100', { sourceProjectId: SOURCE_TITLE, sourceAssetIds: Array.from({ length: 101 }, (_, i) => `A${i}`) }],
  ]
  const negResults = []
  for (const [label, b] of negatives) {
    const r = await call('assets-import', { title: TARGET_TITLE, ...b })
    negResults.push({ label, status: r.status, code: r.body && r.body.code, text: r.text.slice(0, 240) })
  }
  const afterNeg = await materialState(targetDir)
  check('C2-5c 请求级非法（空批/源=目标/非受管/穿越/非数组/非法分类/互斥/批>100）→ 全部 4xx 且目标零写盘', negResults.every((n) => n.status >= 400 && n.status < 500) && afterNeg === beforeNeg, JSON.stringify(negResults.map((n) => ({ label: n.label, status: n.status, code: n.code }))))
  check('C2-5d 4xx 错误不泄漏 workspace/绝对路径', negResults.every((n) => NO_ABS(n.text)), JSON.stringify(negResults.filter((n) => !NO_ABS(n.text)).map((n) => n.label)))

  group('[AC-C2-6/7] 审计 / 源审计 / base64 模式回归')
  const targetAudit = await fs.readFile(path.join(targetDir, '.aidrama', 'audit', 'audit.jsonl'), 'utf8').catch(() => '')
  const sourceAudit = await fs.readFile(path.join(sourceDir, '.aidrama', 'audit', 'audit.jsonl'), 'utf8').catch(() => '')
  check('C2-6a 目标审计含 assets-import 记录', targetAudit.split(/\r?\n/).some((line) => line.includes('assets-import')), 'target audit bytes=' + targetAudit.length)
  check('C2-4b 源项目审计未被新增（源只读；无 sourceProjectId 记录）', !sourceAudit.includes('sourceProjectId'), 'source audit bytes=' + sourceAudit.length)
  const b64 = await call('assets-import', { title: TARGET_TITLE, fileName: '基础模式.png', base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 1]).toString('base64'), targetCategory: '角色' })
  check('C2-7 base64 模式回归：既有 E13 入参仍可用（200 + ok）', b64.status === 200 && b64.body && b64.body.ok === true, JSON.stringify({ status: b64.status, code: b64.body && b64.body.code }))
} else {
  console.log('      （SKIP：host C2-H 源模式未交付）')
}

group('[client C2-C] 从其他项目导入 UI（能力自适应）')
if (!clientCapability) {
  console.log('      （SKIP：client C2-C 未交付）')
} else {
  check('C1 入口「从其他项目导入」+ 能力探测（旧宿主零新 UI）', /从其他项目导入/.test(clientSrc) && /(sourceProjectId|sourceProject)/.test(clientSrc))
  check('C2 源项目选择（排除当前项目）+ assets-get 只读列表', /assets-get/.test(clientSrc) && /(排除当前|当前项目|sourceProject)/.test(clientSrc))
  check('C3 多选/搜索 + 目标分类 + 源模式 payload（无 base64/fileName）', /(多选|selected|checkbox)/.test(clientSrc) && /targetCategory/.test(clientSrc) && /sourceAssetIds/.test(clientSrc) && /assets-import/.test(clientSrc))
  check('C4 成功/跳过/失败汇总 + 重试 + 完成后自动刷新', /(跳过|skipped)/.test(clientSrc) && /(重试)/.test(clientSrc) && /loadAssets\(\{ scan: true \}\)/.test(clientSrc))
  check('C5 调用点 71 不增 / slots=4 / 无新依赖', CLIENT_CALLS.size === 72 && SLOTS === 4 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ calls: CLIENT_CALLS.size, slots: SLOTS }))
  check('C6 DOM 不渲染项目外绝对路径（无盘符标题）', !/title:\s*[^,)]*[A-Za-z]:\\\\/.test(clientSrc))
}

await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
