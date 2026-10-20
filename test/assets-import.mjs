/**
 * v0.15.11 IMP-Q · 一键导入素材（E13 `assets-import`）· QA 验收套件（task-136）
 *
 * E13 契约：METHODS 70→70（仅 +assets-import；工具 34 不变；client 调用点 70）
 *   成功：5 类文件 → 落 素材/<分类>/ + sha 正确 + 自动登记（assets.json/素材清单）+ 响应形状
 *   去重：同 SHA256 → 409 conflict + duplicate:true 不写盘；同名不同内容 → 自动 name (2).ext 不覆盖
 *   超大：解码 > min(maxBytes,50MB) → 413 且 tmp 零残留；expectedSha256 不符 → 拒绝
 *   非法 fileName/base64/扩展名/分类 → 400 零写盘；项目不存在 → 404；登记失败 → 删除文件回滚（registry 无脏数据）
 *   磁盘检查 statfs 不可用 → 降级警告不阻断；错误不泄绝对路径；原方法零回归
 * client：导入入口显隐/旧宿主隐藏、file input+拖拽、>50MB 不进队列、串行进度、成功/重复/失败汇总、自动刷新、调用点 70/slots 4
 *
 * 能力自适应：host 无 assets-import 且 client 无导入标记 → 整套件 SKIP（exit 0，不红）。
 * 运行：node test/assets-import.mjs
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
const importModule = await load('lib/import-assets.js').catch(() => null)
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8')
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
const BASELINE_FILE = path.join(pluginRoot, '..', '_recover', 'v01511-baseline', 'baseline.json')

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
const base64Of = (buf) => Buffer.from(buf).toString('base64')
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
const TOOL_COUNT = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES.length : 0
const CLIENT_CALLS = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
const SLOTS = (clientSrc.match(/slots\.register\(/g) || []).length

group('[0] 能力探测 / 契约（版本自适应）')
const hostCapability = METHODS.includes('assets-import')
const clientCapability = clientSrc.includes('assets-import') && (clientSrc.includes('导入素材') || clientSrc.includes('一键导入'))
if (!hostCapability && !clientCapability) {
  console.log('  结果：0 passed, 0 failed（SKIP：host 无 assets-import 且 client 无导入 UI 标记（v0.15.10 现态），assets-import 套件跳过）')
  process.exit(0)
}
// 契约：METHODS=70（≤v0.15.10 为 69）、工具 34、其它方法保留
let baseline = null
try { baseline = JSON.parse((await fs.readFile(BASELINE_FILE, 'utf8')).replace(/^\uFEFF/, '')) } catch {}
const expectedMethods = hostCapability ? 72 : 70
check('0.1 METHODS 70（v0.15.11 E13 +assets-import）/ 工具 34', METHODS.length === expectedMethods && TOOL_COUNT === 35, JSON.stringify({ methods: METHODS.length, expected: expectedMethods, tools: TOOL_COUNT }))
if (baseline && Array.isArray(baseline.methods)) {
  const baselineSet = new Set(baseline.methods)
  const missing = [...baselineSet].filter((m) => !METHODS.includes(m))
  const added = METHODS.filter((m) => !baselineSet.has(m))
  check('0.2 相对 v0.15.10 仅新增 assets-import + v0.16.6 style-save + v0.16.9 asset-save（旧方法零缺失；C2 已批准）', missing.length === 0 && added.length === 3 && added.includes('assets-import') && added.includes('style-save') && added.includes('asset-save'), JSON.stringify({ missing, added }))
} else {
  console.log('      （SKIP：无 v0.15.10 基线 methods 清单，跳过「仅 +1」对比）')
}

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'assets-import-'))
const TITLE = '导入验收剧'
await store.createProject(workspace, TITLE)
const projectDir = path.join(workspace, 'AI短剧', TITLE)
const material = path.join(projectDir, '素材')
const assetsPath = path.join(projectDir, '.aidrama', 'assets.json')
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
const BENIGN = (rel) => rel.includes('.aidrama/audit/') || rel.endsWith('.aidrama/editor-notifications.jsonl')
async function fileList(root) {
  const out = []
  async function walk(current, rel) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      const relPath = rel ? rel + '/' + entry.name : entry.name
      if (entry.isDirectory()) { out.push(relPath + '/'); await walk(full, relPath) }
      else out.push(relPath)
    }
  }
  await walk(root, '')
  return out.filter((item) => !BENIGN(item) && !/\.ai-drama-import-.*\.tmp$/.test(item))
}
async function tmpResidue(root) {
  const list = await fileList(root)
  return list.filter((item) => /\.ai-drama-import-.*\.tmp$/.test(item))
}
async function assetsEntryCount() {
  const list = await store.getAssets(workspace, TITLE).catch(() => [])
  return Array.isArray(list) ? list.length : -1
}

const IMG = {
  png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]),
  mp4: Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
  mp3: Buffer.from([0xff, 0xfb, 0x90, 0x64, 5, 6]),
  md: Buffer.from('# 导入文档\n\n内容正文。\n', 'utf8'),
}
const SUCCESS_CASES = [
  { fileName: '导入图.png', category: '角色', buffer: IMG.png, type: 'image' },
  { fileName: '导入图2.jpg', category: '场景', buffer: IMG.jpg, type: 'image' },
  { fileName: '导入片.mp4', category: '分镜', buffer: IMG.mp4, type: 'video' },
  { fileName: '导入音.mp3', category: '配音', buffer: IMG.mp3, type: 'audio' },
  { fileName: '导入文.md', category: '其他', buffer: IMG.md, type: 'doc' },
]

group('[E13] assets-import 数据契约（能力自适应）')
if (!hostCapability) {
  console.log('      （SKIP：host assets-import 尚未交付）')
} else {
  // E13.1 成功 5 类
  const successResults = []
  for (const item of SUCCESS_CASES) {
    const result = await call('assets-import', { title: TITLE, fileName: item.fileName, base64: base64Of(item.buffer), targetCategory: item.category })
    const body = result.body || {}
    const relPath = String(body.path || '')
    const abs = path.join(projectDir, ...relPath.split('/'))
    const onDisk = await fs.readFile(abs).then((b) => sha256(b), () => null)
    const registry = await store.getAssets(workspace, TITLE).catch(() => [])
    const registered = Boolean(relPath) && (Array.isArray(registry) ? registry : []).some((asset) => String(asset.source || '').endsWith(relPath.replace(/\//g, path.sep)))
    successResults.push({ item, status: result.status, body, onDisk, registered, relPath })
  }
  check('E13.1 成功导入 5 类文件（image/jpeg/video/audio/doc）→ 200 + 落 素材/<分类>/ + sha 一致 + 自动登记', successResults.every((entry) => entry.status === 200 && entry.body.ok === true && entry.onDisk === sha256(entry.item.buffer) && entry.registered && !path.isAbsolute(entry.relPath) && !entry.relPath.startsWith('..') && entry.relPath.startsWith('素材/' + entry.item.category + '/')), JSON.stringify(successResults.map((entry) => ({ name: entry.item.fileName, status: entry.status, path: entry.relPath, onDisk: Boolean(entry.onDisk), registered: entry.registered, keys: Object.keys(entry.body) }))))
  const responseKeys = successResults[0] && successResults[0].body ? Object.keys(successResults[0].body) : []
  check('E13.1b 成功响应形状（ok/path/bytes|size/sha256/asset/name/category）', responseKeys.includes('ok') && responseKeys.includes('path') && responseKeys.includes('sha256') && (responseKeys.includes('bytes') || responseKeys.includes('size')) && responseKeys.includes('asset'), JSON.stringify(responseKeys))
  const checklist = await fs.readFile(path.join(material, '素材清单.md'), 'utf8').catch(() => '')
  check('E13.1c 素材清单自动更新（含导入文件路径/文件名）', SUCCESS_CASES.every((item) => checklist.includes(item.fileName) || checklist.includes(item.fileName.replace(/\//g, '\\'))), checklist.slice(0, 120))
  // E13.2 分类白名单 11 类 + 默认分类
  const CATEGORIES = (importModule && Array.isArray(importModule.IMPORT_CATEGORIES)) ? importModule.IMPORT_CATEGORIES : ['角色', '场景', '道具', '服装', '表情', '特效', '音效', '配音', '音乐', '分镜', '其他']
  const categoryResults = []
  for (let i = 0; i < CATEGORIES.length; i += 1) {
    const buffer = Buffer.from(`分类内容-${i}-${CATEGORIES[i]}`)
    const result = await call('assets-import', { title: TITLE, fileName: `分类-${i}.txt`, base64: base64Of(buffer), targetCategory: CATEGORIES[i] })
    categoryResults.push({ category: CATEGORIES[i], status: result.status, path: result.body && result.body.path })
  }
  check('E13.2 targetCategory 白名单 11 类全部可导入且落对应目录', categoryResults.every((entry) => entry.status === 200 && String(entry.path).startsWith('素材/' + entry.category + '/')), JSON.stringify(categoryResults.filter((entry) => entry.status !== 200)))
  const defaultResult = await call('assets-import', { title: TITLE, fileName: '默认分类.txt', base64: base64Of(Buffer.from('默认分类内容')) })
  const today = new Date()
  const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
  check('E13.3 targetCategory 缺省 → 导入_YYYYMMDD', defaultResult.status === 200 && String(defaultResult.body.path).startsWith(`素材/导入_${stamp}/`), JSON.stringify({ status: defaultResult.status, path: defaultResult.body && defaultResult.body.path, expected: `素材/导入_${stamp}/` }))
  // E13.4 去重：同 SHA256 → 409 + duplicate:true 不写
  const beforeFiles = await fileList(material)
  const beforeCount = await assetsEntryCount()
  const dup = await call('assets-import', { title: TITLE, fileName: '重复图.png', base64: base64Of(IMG.png), targetCategory: '角色' })
  const afterFiles = await fileList(material)
  const afterCount = await assetsEntryCount()
  check('E13.4 同 SHA256 重复导入 → 409 conflict + duplicate:true 且不写盘/不新增登记', dup.status === 409 && dup.body && dup.body.ok === false && dup.body.code === 'conflict' && dup.body.duplicate === true && beforeFiles.length === afterFiles.length && beforeCount === afterCount, JSON.stringify({ status: dup.status, code: dup.body && dup.body.code, duplicate: dup.body && dup.body.duplicate, filesDelta: afterFiles.length - beforeFiles.length, registryDelta: afterCount - beforeCount }))
  check('E13.4b 重复响应不泄漏绝对路径', !dup.text.includes(workspace) && !/[A-Za-z]:\\\\Users\\\\/.test(dup.text))
  // E13.5 同名不同内容 → 自动 name (2).ext，不覆盖
  const originalFile = path.join(material, '角色', '导入图.png')
  const originalSha = sha256(await fs.readFile(originalFile))
  const renamedContent = Buffer.from('同名但不同内容')
  const renamed = await call('assets-import', { title: TITLE, fileName: '导入图.png', base64: base64Of(renamedContent), targetCategory: '角色' })
  const renamedPath = String((renamed.body && renamed.body.path) || '')
  const renamedDisk = await fs.readFile(path.join(projectDir, ...renamedPath.split('/'))).then((b) => sha256(b), () => null)
  check('E13.5 同名不同内容 → 自动改名不覆盖（name (2).ext）', renamed.status === 200 && /导入图 \(2\)\.png$/.test(renamedPath) && sha256(await fs.readFile(originalFile)) === originalSha && renamedDisk === sha256(renamedContent), JSON.stringify({ status: renamed.status, path: renamedPath }))
  // E13.6 expectedSha256 校验
  const newContent = Buffer.from('expected-sha 校验内容')
  const goodSha = sha256(newContent)
  const shaOk = await call('assets-import', { title: TITLE, fileName: 'sha正确.txt', base64: base64Of(newContent), targetCategory: '其他', expectedSha256: goodSha })
  const filesBeforeBadSha = await fileList(material)
  const shaBad = await call('assets-import', { title: TITLE, fileName: 'sha错误.txt', base64: base64Of(newContent), targetCategory: '其他', expectedSha256: '0'.repeat(64) })
  const filesAfterBadSha = await fileList(material)
  check('E13.6 expectedSha256 正确通过 / 不符拒绝且零写盘', shaOk.status === 200 && shaBad.status >= 400 && filesBeforeBadSha.length === filesAfterBadSha.length, JSON.stringify({ good: shaOk.status, bad: shaBad.status, code: shaBad.body && shaBad.body.code }))
  // E13.7 超大 → 413 且 tmp 零残留（用 maxBytes 模拟）
  const tooLargeContent = Buffer.alloc(4096, 7)
  const filesBeforeLarge = await fileList(material)
  const tooLarge = await call('assets-import', { title: TITLE, fileName: '超大.png', base64: base64Of(tooLargeContent), targetCategory: '特效', maxBytes: 1024 })
  const filesAfterLarge = await fileList(material)
  check('E13.7 超过 maxBytes → 413 too-large 且无文件/ tmp 残留', tooLarge.status === 413 && tooLarge.body && tooLarge.body.code === 'too-large' && filesBeforeLarge.length === filesAfterLarge.length, JSON.stringify({ status: tooLarge.status, code: tooLarge.body && tooLarge.body.code, filesDelta: filesAfterLarge.length - filesBeforeLarge.length }))
  check('E13.7b tmp 零残留（素材树无 .ai-drama-import-*.tmp）', (await tmpResidue(material)).length === 0, JSON.stringify(await tmpResidue(material)))
  // E13.8 非法输入矩阵 → 400 且零写盘
  const invalidCases = [
    ['fileName 含路径', { fileName: '../evil.png', base64: base64Of(Buffer.from('x')) }],
    ['fileName 含反斜杠路径', { fileName: 'a\\b.png', base64: base64Of(Buffer.from('x')) }],
    ['fileName 控制字符', { fileName: 'bad\u0000.png', base64: base64Of(Buffer.from('x')) }],
    ['fileName 保留名', { fileName: 'CON.png', base64: base64Of(Buffer.from('x')) }],
    ['fileName 隐藏名', { fileName: '.hidden.png', base64: base64Of(Buffer.from('x')) }],
    ['fileName 非白名单扩展名', { fileName: 'evil.exe', base64: base64Of(Buffer.from('x')) }],
    ['fileName 缺失', { base64: base64Of(Buffer.from('x')) }],
    ['base64 非法字符', { fileName: 'bad.png', base64: '@@@@' }],
    ['base64 长度非法', { fileName: 'bad2.png', base64: 'abc' }],
    ['base64 非字符串', { fileName: 'bad3.png', base64: 123 }],
    ['targetCategory 非法', { fileName: 'bad4.png', base64: base64Of(Buffer.from('x')), targetCategory: '../角色' }],
    ['targetCategory 不在白名单', { fileName: 'bad5.png', base64: base64Of(Buffer.from('x')), targetCategory: '风格资产' }],
    ['expectedSha256 格式非法', { fileName: 'bad6.png', base64: base64Of(Buffer.from('x')), expectedSha256: 'xyz' }],
    ['missing base64', { fileName: 'bad7.png' }],
  ]
  const invalidResults = []
  const filesBeforeInvalid = await fileList(material)
  const assetsBeforeInvalid = await fs.readFile(assetsPath).then((b) => sha256(b), () => null)
  for (const [label, body] of invalidCases) {
    const result = await call('assets-import', { title: TITLE, ...body })
    invalidResults.push({ label, status: result.status, code: result.body && result.body.code })
  }
  const filesAfterInvalid = await fileList(material)
  const assetsAfterInvalid = await fs.readFile(assetsPath).then((b) => sha256(b), () => null)
  check('E13.8 非法 fileNail/base64/category/expectedSha 全部 4xx', invalidResults.every((entry) => entry.status >= 400 && entry.status < 500), JSON.stringify(invalidResults.filter((entry) => !(entry.status >= 400 && entry.status < 500))))
  check('E13.8b 非法输入零写盘（文件树与 assets.json 字节不变）', filesBeforeInvalid.length === filesAfterInvalid.length && assetsBeforeInvalid === assetsAfterInvalid)
  // E13.9 项目不存在 → 404
  const notFound = await call('assets-import', { title: '不存在的剧', fileName: 'a.png', base64: base64Of(IMG.png) })
  check('E13.9 项目不存在 → 404 not-found', notFound.status === 404 && notFound.body && notFound.body.code === 'not-found', JSON.stringify({ status: notFound.status, code: notFound.body && notFound.body.code }))
  // E13.10 登记失败回滚（assets.json 变为目录 → addAsset 写入失败 → 删除已写文件）
  const ROLLBACK_TITLE = '导入回滚剧'
  await store.createProject(workspace, ROLLBACK_TITLE)
  const rollbackDir = path.join(workspace, 'AI短剧', ROLLBACK_TITLE)
  const rollbackAssets = path.join(rollbackDir, '.aidrama', 'assets.json')
  await fs.rm(rollbackAssets, { force: true })
  await fs.mkdir(rollbackAssets, { recursive: true })
  const rollbackBuffer = Buffer.from('回滚测试内容')
  const rollbackResult = await call('assets-import', { title: ROLLBACK_TITLE, fileName: '回滚.png', base64: base64Of(rollbackBuffer), targetCategory: '角色' })
  const rollbackFiles = await fileList(path.join(rollbackDir, '素材')).catch(() => [])
  const rollbackTmp = (await fileList(path.join(rollbackDir, '素材')).catch(() => [])).filter((item) => /\.ai-drama-import-.*\.tmp$/.test(item))
  check('E13.10 登记失败 → 已写文件删除回滚（registry 无脏数据/无半文件/tmp）', rollbackResult.status >= 400 && rollbackFiles.filter((item) => /回滚\.png$/.test(item)).length === 0 && rollbackTmp.length === 0, JSON.stringify({ status: rollbackResult.status, files: rollbackFiles, tmp: rollbackTmp }))
  // E13.11 磁盘检查降级静态 + 错误不泄路径 + 原方法回归
  const importSource = await fs.readFile(path.join(pluginRoot, 'lib', 'import-assets.js'), 'utf8').catch(() => '')
  check('E13.11 磁盘空间检查 statfs + 不可用降级不阻断（静态）', /statfs/.test(importSource) && /catch[\s\S]{0,200}return/.test(importSource))
  const regressions = []
  for (const method of ['ping', 'status', 'assets-get', 'shelf']) {
    const result = await call(method, method === 'ping' ? {} : { title: TITLE })
    regressions.push({ method, status: result.status })
  }
  check('E13.12 原方法零回归（ping/status/assets-get/shelf）', regressions.every((entry) => entry.status === 200), JSON.stringify(regressions))
  const leakProbe = await call('assets-import', { title: TITLE, fileName: '../leak.png', base64: base64Of(Buffer.from('x')) })
  check('E13.13 错误不泄漏绝对路径/堆栈', !leakProbe.text.includes(workspace) && !/[A-Za-z]:\\\\Users\\\\/.test(leakProbe.text) && !/\bat\s+.*:\d+:\d+/.test(leakProbe.text), leakProbe.text.slice(0, 160))
}

group('[UI] client 一键导入（能力自适应）')
if (!clientCapability) {
  console.log('      （SKIP：client 导入 UI 尚未交付）')
} else {
  check('C1 入口「导入素材」+ 能力探测显隐（status.version≥0.15.11 才显示；旧宿主零新显示）', clientSrc.includes('导入素材') && clientSrc.includes('IMPORT_MIN_HOST_VERSION') && clientSrc.includes('versionAtLeast') && /importSupported === true/.test(clientSrc))
  check('C2 面板/输入：region aria-label=导入素材 + 隐藏 file input multiple accept + 拖拽区 + 分类 select', clientSrc.includes("'aria-label': '导入素材'") && clientSrc.includes('ad-import-panel') && clientSrc.includes('ad-import-file-input') && /type:\s*'file'/.test(clientSrc) && /multiple:\s*true/.test(clientSrc) && /accept:\s*IMPORT_ACCEPT/.test(clientSrc) && clientSrc.includes('ad-import-drop') && clientSrc.includes("'aria-label': '导入分类'"))
  check('C3 边界：>50MB 不进队列 / 恰好 50MB 允许 / 非白名单不支持 / 单批 >20 提示', /50\s*\*\s*1024\s*\*\s*1024/.test(clientSrc) && clientSrc.includes('超过 50MB，不会导入') && clientSrc.includes('IMPORT_MAX_BATCH = 20') && /单批最多 \$\{IMPORT_MAX_BATCH\} 个/.test(clientSrc) && clientSrc.includes('不支持的类型'))
  check('C4 串行导入：按队列顺序 for 循环逐文件 await api(assets-import) + 进度「已处理 i/N」', /for \(let i = 0; i < targets\.length; i \+= 1\)/.test(clientSrc) && /const item = targets\[i\]/.test(clientSrc) && /await api\('assets-import'/.test(clientSrc) && /setImportProgress\(\{ done: i \+ 1, total: targets\.length \}\)/.test(clientSrc) && /导入中… 已处理 \$\{importProgress\.done\}/.test(clientSrc))
  check('C5 汇总：成功/已存在/失败 + 失败不中断 + 重试失败项 + 清空', /导入完成：成功 \$\{ok\}/.test(clientSrc) && clientSrc.includes('已存在') && clientSrc.includes('重试失败项') && clientSrc.includes('清空') && /\.ad-import-summary/.test(clientSrc))
  check('C6 完成后自动刷新（loadAssets({ scan: true }) 一次，卡片墙/扫描列表）', /loadAssets\(/.test(clientSrc) && /scanMaterials/.test(clientSrc))
  check('C7 重复/失败归类（409 conflict+duplicate→已存在；413→文件过大服务端拒绝）', clientSrc.includes('已存在（相同内容或同名文件）') && clientSrc.includes('文件过大') && /duplicate/.test(clientSrc))
  check('C8 调用点 70（仅 +assets-import）+ slots=4 + 工具 34/METHODS 70 + 无新依赖', CLIENT_CALLS.size === 72 && SLOTS === 4 && TOOL_COUNT === 35 && METHODS.length === 72 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ calls: CLIENT_CALLS.size, slots: SLOTS, methods: METHODS.length }))
  check('C9 DOM 不渲染外部绝对路径（列表仅 item.name/size/kindLabel；无 item.path/source 渲染）', (() => { const start = clientSrc.indexOf('importQueue.map'); const region = start >= 0 ? clientSrc.slice(start, start + 1200) : ''; return region.includes("className: 'ad-import-name', title: item.name") && !region.includes('item.path') && !region.includes('item.source') && !/[A-Za-z]:\\\\/.test(region) })())
}
await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
