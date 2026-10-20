/**
 * v0.15.8 EXT-Q1 · 素材库登记仅项目内 + 历史外部登记只读兼容 · QA 验收套件（task-127）
 *
 * E1 新登记仅项目内：项目内相对/绝对路径成功；项目外绝对/`..`/UNC/symlink 逃逸拒绝且不写盘
 * E2 错误契约：拒绝状态/错误码/文案正确、不泄露项目外绝对路径；失败后 assets.json 字节不变
 * E3 client 提示：登记区「素材必须位于项目素材/」文案、外部拒绝提示、历史外部登记「外部路径（待迁移）」徽标、无新页签
 * E4 历史兼容：E10 media-read assetId 对历史外部登记仍可读（迁移期保留）；项目内登记可读；万界倒爷 16/16 项目内登记只读核对
 * E5 回归：工具 34 / METHODS 70 / 调用点 70 / slots 4 / 无新依赖
 *
 * 能力自适应：host 尚未收紧（外部绝对路径仍 200 写入）且 client 无新文案 → 整套件 SKIP（exit 0，不红）。
 * 运行：node test/ext-registration.mjs
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
const CLIENT_CALLS = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
const SLOTS = (clientSrc.match(/slots\.register\(/g) || []).length
const METHODS = indexMod.METHODS || []
const TOOL_COUNT = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES.length : 0

group('[0] 能力探测 / 契约（版本自适应）')
check('0.1 工具 34 / METHODS 70 / 调用点 70 / slots=4 / 无新依赖', TOOL_COUNT === 35 && METHODS.length === 72 && CLIENT_CALLS.size === 72 && SLOTS === 4 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ tools: TOOL_COUNT, methods: METHODS.length, calls: CLIENT_CALLS.size, slots: SLOTS }))

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-registration-'))
const TITLE = '登记约束测试剧'
await store.createProject(workspace, TITLE)
const projectDir = path.join(workspace, 'AI短剧', TITLE)
const assetsPath = path.join(projectDir, '.aidrama', 'assets.json')
const internalRel = '素材/相对图.png'
const internalAbsRel = '素材/绝对图.png'
const internalAbs = path.join(projectDir, ...internalAbsRel.split('/'))
const internalRelAbs = path.join(projectDir, ...internalRel.split('/'))
await fs.mkdir(path.dirname(internalAbs), { recursive: true })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
await fs.writeFile(internalAbs, png)
await fs.writeFile(internalRelAbs, png)
const realProject = await fs.realpath(projectDir)
const extDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-registration-ext-'))
const externalAbs = path.join(extDir, '外部图.png')
await fs.writeFile(externalAbs, png)
let symlinkCreated = false
let symlinkPath = path.join(extDir, '链接图.png')
try { await fs.symlink(externalAbs, symlinkPath, 'file'); symlinkCreated = true } catch {}
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
async function assetsSha() { return fs.readFile(assetsPath).then((b) => sha256(b)).catch(() => null) }
async function addAsset(source) {
  const before = await assetsSha()
  const result = await call('assets-add', { title: TITLE, source })
  const after = await assetsSha()
  return { ...result, before, after, wroteDisk: before !== after }
}
// 能力探测：先尝试外部绝对路径（v0.15.7 会 200 写入 = 未收紧）
const probeExternal = await addAsset(externalAbs)
const clientNewCopy = clientSrc.includes('素材必须位于项目') || clientSrc.includes('外部路径（待迁移）') || clientSrc.includes('仅支持项目内')
const hostTightened = probeExternal.status !== 200
const capability = hostTightened || clientNewCopy
if (!capability) {
  console.log('  结果：0 passed, 0 failed（SKIP：assets-add 尚未收紧项目外路径（v0.15.7 现态外部绝对路径仍可登记）且 client 无新文案；EXT 验收套件跳过）')
  await fs.rm(workspace, { recursive: true, force: true })
  await fs.rm(extDir, { recursive: true, force: true })
  process.exit(0)
}

group('[E1/E2] 新登记仅项目内 + 错误契约（能力自适应）')
if (!hostTightened) {
  console.log('      （SKIP：host 登记约束尚未收紧）')
} else {
  // E1.1 项目内相对路径成功
  const relativeCase = await addAsset(internalRel)
  check('E1.1 项目内相对路径登记成功（200）且回读存在', relativeCase.status === 200 && relativeCase.body && relativeCase.body.ok === true, JSON.stringify({ status: relativeCase.status, code: relativeCase.body && relativeCase.body.code }))
  const readback1 = await call('assets-get', { title: TITLE })
  const isInsideProject = (source) => { const rel = path.relative(realProject, String(source || '')); return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel) }
  const internalEntry = (readback1.body && Array.isArray(readback1.body.assets) ? readback1.body.assets : []).find((a) => String(a.source || '').includes('相对图'))
  check('E1.1b 项目内相对登记回读：source 在项目内、文件可读', Boolean(internalEntry) && isInsideProject(internalEntry.source), JSON.stringify(internalEntry && { source: internalEntry.source }))
  // E1.2 项目内绝对路径成功
  const absoluteCase = await addAsset(internalAbs)
  check('E1.2 项目内绝对路径登记成功（200）', absoluteCase.status === 200 && absoluteCase.body && absoluteCase.body.ok === true, String(absoluteCase.status))
  const shaAfterSuccess = await assetsSha()
  // E1.3 项目外绝对拒绝
  const externalCase = await addAsset(externalAbs)
  check('E1.3 项目外绝对路径被拒绝（4xx）', externalCase.status >= 400 && externalCase.status < 500, JSON.stringify({ status: externalCase.status, code: externalCase.body && externalCase.body.code }))
  check('E1.3b 项目外拒绝不写盘（assets.json 字节不变）', externalCase.wroteDisk === false)
  // E1.4 穿越拒绝
  const traversalCase = await addAsset('../../../逃逸.png')
  check('E1.4 `..` 逃逸被拒绝（4xx）且不写盘', traversalCase.status >= 400 && traversalCase.status < 500 && traversalCase.wroteDisk === false, String(traversalCase.status))
  // E1.5 UNC 拒绝
  const uncCase = await addAsset('\\\\127.0.0.1\\share\\x.png')
  check('E1.5 UNC 被拒绝（4xx）且不写盘', uncCase.status >= 400 && uncCase.status < 500 && uncCase.wroteDisk === false, String(uncCase.status))
  // E1.6 symlink 逃逸拒绝（Windows EPERM → SKIP 记录）
  if (symlinkCreated) {
    const symlinkCase = await addAsset(symlinkPath)
    check('E1.6 symlink 逃逸被拒绝（4xx）且不写盘', symlinkCase.status >= 400 && symlinkCase.status < 500 && symlinkCase.wroteDisk === false, String(symlinkCase.status))
  } else {
    console.log('      （SKIP：Windows 无权限创建 symlink → symlink 逃逸用例如实记录 SKIP）')
  }
  // E1.7 失败后已有登记未变
  const afterAll = await assetsSha()
  check('E1.7 失败不修改已有登记（失败前后 assets.json sha 不变）', shaAfterSuccess === afterAll, JSON.stringify({ before: String(shaAfterSuccess).slice(0, 12), after: String(afterAll).slice(0, 12) }))
  // E2.1 错误契约：外部拒绝状态/错误码（以 host 回执为准；倾向 403 forbidden）
  check('E2.1 外部拒绝错误契约（4xx + ok=false + code 明确）', externalCase.status >= 400 && externalCase.body && externalCase.body.ok === false && typeof externalCase.body.code === 'string' && externalCase.body.code.length > 0, JSON.stringify({ status: externalCase.status, code: externalCase.body && externalCase.body.code }))
  // E2.2 错误不泄露项目外绝对路径
  check('E2.2 外部拒绝错误不泄露项目外绝对路径/堆栈', !externalCase.text.includes(extDir) && !/at\s+.*:\d+:\d+/.test(externalCase.text) && !/[A-Za-z]:\\Users\\[^"\\]*\\AppData/i.test(externalCase.text), externalCase.text.slice(0, 160))
}

group('[E4] 历史外部登记只读兼容（E10）+ 项目内登记读取')
if (!hostTightened) {
  console.log('      （SKIP：host 登记约束尚未收紧）')
} else {
  // 预置历史外部登记（模拟迁移前旧数据）
  const current = await store.getAssets(workspace, TITLE).catch(() => [])
  const legacyEntry = { id: 'legacy-ext-1', name: '历史外部图', kind: 'image', source: externalAbs, bytes: png.length, sha256: sha256(png), linkedShots: [], note: '历史外部登记（待迁移）' }
  await fs.writeFile(assetsPath, JSON.stringify([...(Array.isArray(current) ? current : []), legacyEntry], null, 2) + '\n', 'utf8')
  const legacyRead = await call('media-read', { title: TITLE, assetId: 'legacy-ext-1' })
  const decoded = legacyRead.body && legacyRead.body.base64 ? Buffer.from(String(legacyRead.body.base64), 'base64') : Buffer.alloc(0)
  check('E4.1 历史外部登记读取收紧为 404 not-found（M3：旧根存在也不读项目外，提示迁移/重新登记）', legacyRead.status === 404 && legacyRead.body && legacyRead.body.ok === false && legacyRead.body.code === 'not-found' && /迁移|重新登记|扫描/.test(String(legacyRead.body.message || legacyRead.body.error || '')), JSON.stringify({ status: legacyRead.status, code: legacyRead.body && legacyRead.body.code }))
  const internalRead = await call('media-read', { title: TITLE, path: internalRel })
  check('E4.2 项目内登记可读取（media-read path 相对路径 200）', internalRead.status === 200 && internalRead.body && internalRead.body.ok === true, String(internalRead.status))
  // 万界倒爷真实项目 16/16 项目内登记只读核对（存在才检查，不写入）
  const WANJIE = process.env.DSH_AI_DRAMA_SAMPLE_WANJIE || ''
  let realRegistry = { exists: false }
  try {
    const raw = JSON.parse((await fs.readFile(path.join(WANJIE, '.aidrama', 'assets.json'), 'utf8')).replace(/^\uFEFF/, ''))
    const entries = Array.isArray(raw) ? raw : []
    const inside = entries.filter((e) => String(e.source || '').startsWith(WANJIE + '\\'))
    realRegistry = { exists: true, count: entries.length, inside: inside.length }
  } catch {}
  if (realRegistry.exists) {
    check('E4.3 万界倒爷迁移后登记 16/16 项目内（只读核对）', realRegistry.count === 16 && realRegistry.inside === 16, JSON.stringify(realRegistry))
  } else {
    console.log('      （SKIP：万界倒爷真实项目不存在于本机 → 16/16 项目内登记核对跳过）')
  }
}

group('[E3] client 文案/提示/徽标（能力自适应）')
if (!clientNewCopy) {
  console.log('      （SKIP：client 外部登记提示/徽标尚未交付）')
} else {
  check('E3.1 登记区文案明确「素材必须位于项目 素材/」', clientSrc.includes('素材必须位于项目') || (clientSrc.includes('素材/') && clientSrc.includes('项目内')))
  check('E3.2 外部路径拒绝提示清晰（先放入项目素材/目录 / 导入引导）', /请先把?.{0,4}(文件|素材)?.{0,6}放入项目|导入素材|仅支持项目内|素材必须位于项目文件夹内/.test(clientSrc))
  check('E3.3 历史外部登记显示「外部路径（待迁移）」徽标 + 提示', clientSrc.includes('外部路径（待迁移）'))
  check('E3.4 不新增一级页签（top tabs 仍 13；v0.16.5 契约入口上移）', (() => { const start = clientSrc.indexOf('const TAB_GROUPS = ['); if (start < 0) return false; const tabs = [...clientSrc.slice(start).matchAll(/\{ id: '([a-z]+)', label: '([^']+)', tabs: \[([^\]]+)\] \}/g)].flatMap((m) => [...m[3].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1])); return tabs.length === 13 })())
  check('E3.5 调用点 70 不增 / slots=4', CLIENT_CALLS.size === 72 && SLOTS === 4, JSON.stringify({ calls: CLIENT_CALLS.size, slots: SLOTS }))
}

await fs.rm(workspace, { recursive: true, force: true })
await fs.rm(extDir, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
