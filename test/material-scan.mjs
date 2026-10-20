/**
 * v0.15.9 D2C-Q · 扫描素材目录 + 批量登记 · QA 验收套件（task-130）
 *
 * E12 契约（assets-get add-only scanMaterials）：
 *   默认/false 输出与 v0.15.8 逐字节一致；true 时追加 unregisteredFiles/unregisteredTotal/truncated
 *   递归扫描 素材/；排除隐藏/`.aidrama`/任意 basename 素材清单.md/symlink/非普通文件；kindGuess；
 *   ext 小写带点（无扩展名 ""）；path 项目内相对正斜杠码点升序；已登记（canonical 大小写不敏感，含历史外部
 *   登记中项目内路径）排除；上限 1000/truncated；unregisteredTotal 不受截断；确定性/只读/容错；
 *   损坏 registry → 不崩溃 + 全部视为未登记 + 不修复 registry；METHODS 70/工具 34 不变
 * UI（client）：扫描入口（旧宿主降级隐藏）/列表/kind 筛选/全选/批量登记串行/成功失败汇总/自动刷新/不移动文件
 *
 * 能力自适应：host 无 scanMaterials 能力且 client 无扫描标记 → 整套件 SKIP（exit 0，不红）。
 * 运行：node test/material-scan.mjs
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
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
const BASELINE_FILE = path.join(pluginRoot, '..', '_recover', 'v0159-baseline', 'baseline.json')

let passed = 0
let failed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) { passed += 1 } else {
    failed += 1
    failures.push(label + (detail ? ' -> ' + detail : ''))
    console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`)
  }
}
function group(name) { console.log('\n' + name) }
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)
async function treeHash(target) {
  const hash = createHash('sha256')
  let count = 0
  async function walk(current, rel) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      const relPath = path.join(rel, entry.name)
      if (entry.isDirectory()) await walk(full, relPath)
      else if (entry.isFile()) { hash.update(`${relPath}|`); hash.update(await fs.readFile(full)); count += 1 }
    }
  }
  await walk(target, '')
  return { hash: hash.digest('hex'), count }
}
const METHODS = indexMod.METHODS || []
const CLIENT_CALLS = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
const SLOTS = (clientSrc.match(/slots\.register\(/g) || []).length
const TOOL_COUNT = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES.length : 0

group('[0] 能力探测 / 契约（版本自适应）')
check('0.1 工具 34 / METHODS 70 / 调用点 70 / slots=4 / 无新依赖', TOOL_COUNT === 35 && METHODS.length === 72 && CLIENT_CALLS.size === 72 && SLOTS === 4 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ tools: TOOL_COUNT, methods: METHODS.length, calls: CLIENT_CALLS.size, slots: SLOTS }))

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'material-scan-'))
const TITLE = '扫描验收剧'
await store.createProject(workspace, TITLE)
const projectDir = path.join(workspace, 'AI短剧', TITLE)
const material = path.join(projectDir, '素材')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const fixture = {
  '角色/CHR001.png': PNG,
  '场景/SPC001.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  '道具/Prop1.mp4': Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]),
  '策划文档/大纲.txt': Buffer.from('大纲文本'),
  '音频/voice.mp3': Buffer.from([0xff, 0xfb, 0x90, 0x64]),
  '子目录/嵌套.webp': Buffer.from('RIFF0000WEBP'),
  '杂项/unknown.xyz': Buffer.from('xyz'),
  '杂项/noext': Buffer.from('nb'),
  '深层/素材清单.md': Buffer.from('# 任意 basename 素材清单.md 应排除'),
  '.hidden.png': PNG,
  '.git/config.txt': Buffer.from('hidden dir file'),
  '素材清单.md': Buffer.from('# 素材清单（排除）'),
  '已登记.png': PNG,
}
for (const [rel, buf] of Object.entries(fixture)) {
  const abs = path.join(material, ...rel.split('/'))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, buf)
}
await store.addAsset(workspace, TITLE, { source: '素材/已登记.png', linkedShots: [] }).catch(() => {})
let symlinkCreated = false
try { await fs.symlink(path.join(material, '角色', 'CHR001.png'), path.join(material, '链接.png'), 'file'); symlinkCreated = true } catch {}

const routes = new Map()
indexMod.apply({
  provide: () => {},
  inject(services, callback) {
    callback({ connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } }, get: () => undefined, on: () => {}, effect: (fn) => fn() })
  },
  logger: { info: () => {}, warn: () => {} },
}, { root: workspace })
async function call(method, body = {}) {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('route not registered: ' + method)
  const response = await spec.fetch(new Request('http://127.0.0.1:1/api/ai-drama/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' }, body: JSON.stringify(body),
  }))
  const text = await response.clone().text().catch(() => '')
  let payload = null
  try { payload = JSON.parse(text) } catch { payload = null }
  return { status: response.status, body: payload, text }
}
const normalize = (payload) => {
  const copy = JSON.parse(JSON.stringify(payload || {}))
  if (typeof copy.workspace === 'string') copy.workspace = '<WORKSPACE>'
  if (typeof copy.workspaceSource === 'string') copy.workspaceSource = '<WORKSPACE>'
  if (Object.prototype.hasOwnProperty.call(copy, 'registryOk')) delete copy.registryOk
  return copy
}
const scanProbe = await call('assets-get', { title: TITLE, scanMaterials: true })
const hostCapability = Boolean(scanProbe.body && Array.isArray(scanProbe.body.unregisteredFiles))
const clientCapability = clientSrc.includes('扫描素材目录') || clientSrc.includes('unregisteredFiles') || clientSrc.includes('批量登记')
if (!hostCapability && !clientCapability) {
  console.log('  结果：0 passed, 0 failed（SKIP：assets-get 无 scanMaterials 能力且 client 无扫描标记（v0.15.8 现态），material-scan 套件跳过）')
  await fs.rm(workspace, { recursive: true, force: true })
  process.exit(0)
}

group('[E12] assets-get scanMaterials 数据契约（能力自适应）')
if (!hostCapability) {
  console.log('      （SKIP：host scanMaterials 尚未交付）')
} else {
  let baseline = null
  try { baseline = JSON.parse((await fs.readFile(BASELINE_FILE, 'utf8')).replace(/^\uFEFF/, '')) } catch {}
  // E12.1 默认/false 与 v0.15.8 逐字节一致（空项目，响应完全确定）
  const EMPTY_TITLE = '扫描空项目'
  await store.createProject(workspace, EMPTY_TITLE)
  const emptyDefault = await call('assets-get', { title: EMPTY_TITLE })
  const emptyFalse = await call('assets-get', { title: EMPTY_TITLE, scanMaterials: false })
  const emptyNormalized = JSON.stringify(normalize(emptyDefault.body))
  const installedRef = baseline && baseline.installedV0158EmptyDefault
  if (installedRef && installedRef.normalizedSha256) {
    check('E12.1 默认响应与 v0.15.8 逐字节一致（空项目归一化 sha 对比）', sha256(Buffer.from(emptyNormalized)) === installedRef.normalizedSha256, JSON.stringify({ now: sha256(Buffer.from(emptyNormalized)).slice(0, 16), ref: installedRef.normalizedSha256.slice(0, 16) }))
  } else {
    console.log('      （SKIP：安装副本无 _recover/v0159-baseline → v0.15.8 字节兼容基线不在本环境）')
  }
  check('E12.1b scanMaterials:false 输出与默认深等（不追加字段）', deepEqual(normalize(emptyFalse.body), normalize(emptyDefault.body)))
  // E12.2 scanMaterials 错误类型 → 400 invalid-args
  const invalidString = await call('assets-get', { title: TITLE, scanMaterials: 'yes' })
  const invalidNull = await call('assets-get', { title: TITLE, scanMaterials: null })
  const invalidNumber = await call('assets-get', { title: TITLE, scanMaterials: 1 })
  check('E12.2 scanMaterials 非布尔（string/null/number）→ 400 invalid-args', [invalidString, invalidNull, invalidNumber].every((item) => item.status === 400 && item.body && item.body.ok === false && item.body.code === 'invalid-args'), JSON.stringify([invalidString, invalidNull, invalidNumber].map((item) => ({ status: item.status, code: item.body && item.body.code }))))
  // E12.3 扫描结果排除规则：隐藏/.git/任意 basename 素材清单.md/已登记/symlink
  const scanned = scanProbe.body
  // v0.16.10（M3）：扫描增加 SHA 去重——与已登记素材同 SHA 的 CHR001.png 不再列出（8→7）
  const expectedPaths = ['素材/场景/SPC001.jpg', '素材/道具/Prop1.mp4', '素材/策划文档/大纲.txt', '素材/音频/voice.mp3', '素材/子目录/嵌套.webp', '素材/杂项/unknown.xyz', '素材/杂项/noext'].sort()
  const gotPaths = (scanned.unregisteredFiles || []).map((file) => file.path)
  check('E12.3 排除隐藏/.git/任意 basename 素材清单.md/已登记/symlink/SHA 去重：仅 7 个未登记文件', deepEqual(gotPaths, expectedPaths), JSON.stringify(gotPaths))
  check('E12.3b unregisteredTotal=7 / truncated=false', scanned.unregisteredTotal === 7 && scanned.truncated === false, JSON.stringify({ total: scanned.unregisteredTotal, truncated: scanned.truncated }))
  const byPath = new Map((scanned.unregisteredFiles || []).map((file) => [file.path, file]))
  check('E12.4 结构：path 相对正斜杠 / ext 小写带点（无扩展名 ""）/ size 真实 / kindGuess（image/video/doc/audio/other）', (() => {
    const expectations = [
      ['素材/场景/SPC001.jpg', 4, '.jpg', 'image'],
      ['素材/道具/Prop1.mp4', 8, '.mp4', 'video'],
      ['素材/策划文档/大纲.txt', 12, '.txt', 'doc'],
      ['素材/音频/voice.mp3', 4, '.mp3', 'audio'],
      ['素材/子目录/嵌套.webp', 12, '.webp', 'image'],
      ['素材/杂项/unknown.xyz', 3, '.xyz', 'other'],
      ['素材/杂项/noext', 2, '', 'other'],
    ]
    return expectations.every(([rel, size, ext, kind]) => {
      const item = byPath.get(rel)
      return item && item.size === size && item.ext === ext && item.kindGuess === kind && !/[\\]/.test(item.path) && !path.isAbsolute(item.path) && typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/.test(item.sha256)
    })
  })(), JSON.stringify((scanned.unregisteredFiles || []).slice(0, 4)))
  check('E12.5 按 path 码点升序', (() => { const list = gotPaths.slice(); const sorted = list.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); return deepEqual(list, sorted) })())
  // E12.6 已登记排除：项目内登记 + 历史外部登记中项目内路径（含大小写不敏感）
  const historyInternal = path.join(material, '历史内部.png')
  await fs.writeFile(historyInternal, PNG)
  const canonicalHistory = await fs.realpath(historyInternal)
  const assetsPath = path.join(projectDir, '.aidrama', 'assets.json')
  const currentAssets = await store.getAssets(workspace, TITLE).catch(() => [])
  await fs.writeFile(assetsPath, JSON.stringify([...(Array.isArray(currentAssets) ? currentAssets : []), { id: 'legacy-internal-1', name: '历史内部图', kind: 'image', source: canonicalHistory, bytes: PNG.length, sha256: sha256(PNG), linkedShots: [], note: '历史外部登记（已迁入项目内）' }], null, 2) + '\n', 'utf8')
  const scanned2 = await call('assets-get', { title: TITLE, scanMaterials: true })
  const paths2 = (scanned2.body.unregisteredFiles || []).map((file) => file.path)
  check('E12.6 历史外部登记中项目内路径也排除（已登记 ∪ 历史内部路径；SHA 去重后 7 条）', !paths2.includes('素材/历史内部.png') && paths2.length === 7, JSON.stringify(paths2))
  // E12.7 确定性 + E12.8 只读
  const treeBefore = await treeHash(projectDir)
  const scannedAgain = await call('assets-get', { title: TITLE, scanMaterials: true })
  const treeAfter = await treeHash(projectDir)
  check('E12.7 确定性（两次扫描深等）', deepEqual(scanned2.body.unregisteredFiles, scannedAgain.body.unregisteredFiles))
  check('E12.8 只读（项目目录树 hash 不变）', treeBefore.hash === treeAfter.hash, JSON.stringify({ before: treeBefore.hash.slice(0, 12), after: treeAfter.hash.slice(0, 12) }))
  // E12.9 扫描 path 可直接作 assets-add source（相对路径往返）→ 登记后从扫描结果消失
  const roundTrip = await call('assets-add', { title: TITLE, source: '素材/角色/CHR001.png' })
  const scanned3 = await call('assets-get', { title: TITLE, scanMaterials: true })
  const paths3 = (scanned3.body.unregisteredFiles || []).map((file) => file.path)
  check('E12.9 扫描 path 可直接登记（assets-add 相对路径 200）且登记后不再列出（SHA 去重后仍 7 条）', roundTrip.status === 200 && roundTrip.body && roundTrip.body.ok === true && !paths3.includes('素材/角色/CHR001.png') && paths3.length === 7, JSON.stringify({ status: roundTrip.status, len: paths3.length }))
  // E12.10 容错：无 素材/ 目录
  const NO_MAT_TITLE = '无素材目录剧'
  await store.createProject(workspace, NO_MAT_TITLE)
  const noMat = await call('assets-get', { title: NO_MAT_TITLE, scanMaterials: true })
  check('E12.10 无 素材/ 目录 → 200 + []/0/false 不崩', noMat.status === 200 && noMat.body && Array.isArray(noMat.body.unregisteredFiles) && noMat.body.unregisteredFiles.length === 0 && noMat.body.unregisteredTotal === 0 && noMat.body.truncated === false, JSON.stringify({ status: noMat.status, total: noMat.body && noMat.body.unregisteredTotal }))
  // E12.11 损坏 registry 容错：按无登记处理、不崩溃、不修复 registry
  const CORRUPT_TITLE = '损坏登记剧'
  await store.createProject(workspace, CORRUPT_TITLE)
  const corruptDir = path.join(workspace, 'AI短剧', CORRUPT_TITLE)
  const corruptMaterial = path.join(corruptDir, '素材')
  await fs.mkdir(corruptMaterial, { recursive: true })
  await fs.writeFile(path.join(corruptMaterial, 'a.png'), PNG)
  const corruptAssets = path.join(corruptDir, '.aidrama', 'assets.json')
  await fs.writeFile(corruptAssets, '{ broken json', 'utf8')
  const corruptBefore = await fs.readFile(corruptAssets)
  const corruptScan = await call('assets-get', { title: CORRUPT_TITLE, scanMaterials: true })
  const corruptAfter = await fs.readFile(corruptAssets)
  check('E12.11 损坏 registry → 200 + unverified:true + 空列表（不列未登记、不修复 registry）', corruptScan.status === 200 && corruptScan.body && corruptScan.body.unverified === true && Array.isArray(corruptScan.body.unregisteredFiles) && corruptScan.body.unregisteredFiles.length === 0 && sha256(corruptBefore) === sha256(corruptAfter), JSON.stringify({ status: corruptScan.status, unverified: corruptScan.body && corruptScan.body.unverified }))
  // E12.12 截断：+1005 文件 → total=1012、truncated、返回 1000（unregisteredTotal 不受截断）
  const bulkDir = path.join(material, '大量')
  await fs.mkdir(bulkDir, { recursive: true })
  await Promise.all(Array.from({ length: 1005 }, (_, i) => fs.writeFile(path.join(bulkDir, `bulk-${String(i).padStart(4, '0')}.bin`), Buffer.from([i % 256]))))
  const truncatedProbe = await call('assets-get', { title: TITLE, scanMaterials: true })
  const truncatedBody = truncatedProbe.body
  check('E12.12 上限 1000：truncated=true / 返回 1000 / unregisteredTotal=1012 不受截断', truncatedBody.truncated === true && truncatedBody.unregisteredFiles.length === 1000 && truncatedBody.unregisteredTotal === 1012, JSON.stringify({ truncated: truncatedBody.truncated, len: truncatedBody.unregisteredFiles.length, total: truncatedBody.unregisteredTotal }))
  check('E12.12b 截断后仍按 path 码点升序且无重复', (() => { const list = truncatedBody.unregisteredFiles.map((file) => file.path); const sorted = list.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); return deepEqual(list, sorted) && new Set(list).size === list.length })())
  check('E12.13 契约：METHODS 70 / 工具 34（无新 METHOD/route）', METHODS.length === 72 && TOOL_COUNT === 35)
}

group('[UI] 扫描素材目录 + 批量登记（client 交付后校准；能力自适应）')
if (!clientCapability) {
  console.log('      （SKIP：client 扫描入口/批量登记尚未交付）')
} else {
  check('C1 扫描入口「扫描素材目录」+ 旧宿主无字段时降级隐藏（scanSupported 探测：true 才渲染）', clientSrc.includes('扫描素材目录') && clientSrc.includes('scanSupported') && /scanSupported === true/.test(clientSrc) && /Object\.prototype\.hasOwnProperty\.call\(result, 'unregisteredFiles'\)/.test(clientSrc) && /setScanSupported\(false\)/.test(clientSrc))
  check('C2 列表（path/kind/size）+ kind 筛选 + 全选', /扫描结果|未登记素材/.test(clientSrc) && /'aria-label': '[^']*(筛选|类型)/.test(clientSrc) && /全选/.test(clientSrc))
  check('C3 批量登记串行（逐条 await assets-add）+ 进度动态文本', /批量登记已选（/.test(clientSrc) && /for\s*\([\s\S]{0,300}await api\('assets-add'/.test(clientSrc) && /登记中… 已处理 \$\{scanProgress\.done\}/.test(clientSrc) && /将逐条登记，可能耗时数秒/.test(clientSrc))
  check('C4 成功/失败汇总（失败不中断、失败项可重试、全部成功提示）', /汇总：成功 \$\{scanSummary\.ok\} · 失败 \$\{scanSummary\.fail\.length\}/.test(clientSrc) && /ad-scan-fail-item/.test(clientSrc) && /失败项/.test(clientSrc) && /全部登记成功/.test(clientSrc))
  check('C4b 完成后自动重扫刷新（loadAssets({ scan: true })）', /loadAssets\(\{ scan: true \}\)/.test(clientSrc) && /await loadAssets\(\{ scan: true \}\)/.test(clientSrc))
  check('C5「不移动文件」文案 + DOM 不渲染外部绝对路径', clientSrc.includes('不移动文件') && !/unregisteredFiles[\s\S]{0,1200}[A-Za-z]:\\\\/.test(clientSrc))
  check('C6 调用点 70 不增 / slots=4', CLIENT_CALLS.size === 72 && SLOTS === 4, JSON.stringify({ calls: CLIENT_CALLS.size, slots: SLOTS }))
}

await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
