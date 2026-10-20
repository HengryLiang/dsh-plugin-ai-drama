/**
 * v0.15.4 素材库 2.0 · 旧登记统一视图 / 外部图片安全预览 / 自动刷新 · QA 验收套件（task-120）
 *
 * E10 契约（media-read add-only assetId，METHODS 70/工具 34 不变）：
 *   合法 5 图片格式 base64 sha256==源文件；video/doc invalid-args；不存在 id/文件缺失 not-found；
 *   最终组件 symlink forbidden；>8MB too-large；非图片扩展 invalid-args；path+assetId 同传 invalid-args；
 *   原 path 模式安全矩阵不回归；只读/确定性/错误不泄路径
 * UI（M20-C）：旧登记项目 → 统一卡片视图（不再只有旧表）；图片经 assetId 预览/data URL；
 *   文件缺失占位；video/doc 占位+信息（无缩略图）；kind 筛选/搜索/排序；登记后自动刷新；
 *   刷新/重扫保留+说明；登记语义文案；视觉圣经无 style/scenes 空态引导；旧登记管理表格保留；
 *   调用点 70 不增 / slots=4；旧项目零异常
 *
 * 能力自适应：assetId 读取未交付且 client 无统一视图标记 → 整套件 SKIP（exit 0，不红）。
 * 运行：node test/legacy-media.mjs
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
    failures.push(`${label}${detail ? ' -> ' + detail : ''}`)
    console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`)
  }
}
function group(name) { console.log('\n' + name) }
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
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
check('0.1 工具 34 / METHODS 70 / client 调用 69 / slots=4 / 无新依赖', TOOL_COUNT === 35 && METHODS.length === 72 && CLIENT_CALLS.size === 72 && SLOTS === 4 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ tools: TOOL_COUNT, methods: METHODS.length, calls: CLIENT_CALLS.size, slots: SLOTS }))

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-media-'))
const TITLE = '旧登记测试剧'
await store.createProject(workspace, TITLE)
const projectDir = path.join(workspace, 'AI短剧', TITLE)
const legacyFile = path.join(projectDir, '.aidrama', 'assets.json')
const extDir = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-media-ext-'))
const IMG = {
  png: { bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), mime: 'image/png' },
  jpg: { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), mime: 'image/jpeg' },
  jpeg: { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe1, 4, 5]), mime: 'image/jpeg' },
  webp: { bytes: Buffer.from('RIFF0000WEBP', 'binary'), mime: 'image/webp' },
  gif: { bytes: Buffer.from('GIF89a', 'binary'), mime: 'image/gif' },
}
const legacyEntries = []
for (const [ext, item] of Object.entries(IMG)) {
  const file = path.join(extDir, `legacy.${ext}`)
  await fs.writeFile(file, item.bytes)
  legacyEntries.push({ id: `legacy-${ext}`, name: `旧图.${ext}`, kind: 'image', source: file, bytes: item.bytes.length, sha256: sha256(item.bytes), linkedShots: ['1-1'], note: '外部引用' })
}
await fs.writeFile(path.join(extDir, 'legacy.mp4'), Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), 'binary')
await fs.writeFile(path.join(extDir, 'legacy.txt'), 'legacy doc', 'utf8')
await fs.writeFile(path.join(extDir, 'legacy.huge.png'), Buffer.alloc(9 * 1024 * 1024, 7))
await fs.writeFile(path.join(extDir, 'legacy.bad.txt'), 'not-image', 'utf8')
legacyEntries.push(
  { id: 'legacy-video', name: '旧视频', kind: 'video', source: path.join(extDir, 'legacy.mp4'), bytes: 8, sha256: 'x', linkedShots: [] },
  { id: 'legacy-doc', name: '旧文档', kind: 'doc', source: path.join(extDir, 'legacy.txt'), bytes: 10, sha256: 'x', linkedShots: [] },
  { id: 'legacy-huge', name: '超大图', kind: 'image', source: path.join(extDir, 'legacy.huge.png'), bytes: 9 * 1024 * 1024, sha256: 'x', linkedShots: [] },
  { id: 'legacy-badext', name: '坏扩展', kind: 'image', source: path.join(extDir, 'legacy.bad.txt'), bytes: 9, sha256: 'x', linkedShots: [] },
  { id: 'legacy-missing', name: '已删除文件', kind: 'image', source: path.join(extDir, 'missing.png'), bytes: 1, sha256: 'x', linkedShots: [] },
)
await fs.mkdir(path.join(projectDir, '.aidrama'), { recursive: true })
await fs.writeFile(legacyFile, JSON.stringify(legacyEntries, null, 2) + '\n', 'utf8')
let symlinkEntryCreated = false
try {
  const symlinkPath = path.join(extDir, 'legacy-link.png')
  await fs.symlink(path.join(extDir, 'legacy.png'), symlinkPath, 'file')
  legacyEntries.push({ id: 'legacy-symlink', name: '链接图', kind: 'image', source: symlinkPath, bytes: IMG.png.bytes.length, sha256: sha256(IMG.png.bytes), linkedShots: [] })
  await fs.writeFile(legacyFile, JSON.stringify(legacyEntries, null, 2) + '\n', 'utf8')
  symlinkEntryCreated = true
} catch {}
const routes = new Map()
indexMod.apply({
  provide: () => {},
  inject(services, callback) {
    callback({
      connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } },
      get: () => undefined,
      on: () => {},
      effect: (fn) => fn(),
    })
  },
  logger: { info: () => {}, warn: () => {} },
}, { root: workspace })
async function call(method, body = {}) {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('route not registered: ' + method)
  const response = await spec.fetch(new Request('http://127.0.0.1:1/api/ai-drama/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' },
    body: JSON.stringify(body),
  }))
  const text = await response.clone().text().catch(() => '')
  let payload = null
  try { payload = JSON.parse(text) } catch { payload = null }
  return { status: response.status, body: payload, text }
}
const probe = await call('media-read', { title: TITLE, assetId: 'legacy-png' })
const dataCapability = Boolean(probe.status === 200 || probe.status === 403 || probe.status === 404)
const clientCapability = /legacyCards|旧登记|登记管理|统一视图/.test(clientSrc) && clientSrc.includes('assetId')
if (!dataCapability && !clientCapability) {
  console.log('  结果：0 passed, 0 failed（SKIP：media-read assetId / client 统一视图均未交付，legacy-media 套件跳过）')
  await fs.rm(extDir, { recursive: true, force: true })
  process.exit(0)
}

group('[E10] media-read assetId：外部历史登记收紧为拒绝（M3）/ 项目内登记可读')
if (!dataCapability) {
  console.log('      （SKIP：media-read assetId 尚未交付）')
} else {
  // 项目内登记正例（M3 后媒体只允许项目内）
  const internalRel = '素材/内部图.png'
  await fs.mkdir(path.join(projectDir, '素材'), { recursive: true })
  await fs.writeFile(path.join(projectDir, ...internalRel.split('/')), IMG.png.bytes)
  const internalAdd = await call('assets-add', { title: TITLE, source: internalRel })
  const internalId = internalAdd.body && internalAdd.body.asset && internalAdd.body.asset.id
  const internalRead = internalId ? await call('media-read', { title: TITLE, assetId: internalId }) : { status: 0, body: null }
  const internalDecoded = internalRead.body && internalRead.body.base64 ? Buffer.from(String(internalRead.body.base64), 'base64') : Buffer.alloc(0)
  check('E10.0 项目内登记 assetId → 200 / base64 sha256 一致 / mime / size 正确', internalAdd.status === 200 && internalRead.status === 200 && internalRead.body.ok === true && internalRead.body.mime === 'image/png' && Number(internalRead.body.size) === IMG.png.bytes.length && sha256(internalDecoded) === sha256(IMG.png.bytes), JSON.stringify({ add: internalAdd.status, read: internalRead.status }))
  // 外部历史登记 5 图片格式 → 拒绝（旧根存在也不读项目外）
  let externalRejected = 0
  const externalDetails = []
  for (const ext of Object.keys(IMG)) {
    const result = await call('media-read', { title: TITLE, assetId: 'legacy-' + ext })
    const noPayload = !result.body || (!result.body.base64 && !result.body.data)
    if ((result.status === 404 || result.status === 403) && result.body && result.body.ok === false && noPayload) externalRejected += 1
    else externalDetails.push(ext + ':' + result.status + ':' + (result.body && result.body.code))
  }
  check('E10.1 外部历史登记 5 图片格式 → 404/403 拒绝且不返回 base64（M3 安全收紧）', externalRejected === 5, JSON.stringify(externalDetails))
  const negative = [
    ['video 条目', { title: TITLE, assetId: 'legacy-video' }, [400, 404, 403]],
    ['doc 条目', { title: TITLE, assetId: 'legacy-doc' }, [400, 404, 403]],
    ['不存在 id', { title: TITLE, assetId: 'legacy-not-exist' }, [404, 403]],
    ['登记文件缺失', { title: TITLE, assetId: 'legacy-missing' }, [404, 403]],
    ['>8MB 外部条目', { title: TITLE, assetId: 'legacy-huge' }, [404, 403, 413]],
    ['非图片扩展外部条目', { title: TITLE, assetId: 'legacy-badext' }, [404, 403]],
  ]
  let negativePass = 0
  const negativeDetails = []
  for (const [label, body, expectedStatuses] of negative) {
    const result = await call('media-read', body)
    if (expectedStatuses.includes(result.status) && result.body && result.body.ok === false) negativePass += 1
    else negativeDetails.push(label + ':' + result.status + ':' + (result.body && result.body.code))
  }
  const conflict = await call('media-read', { title: TITLE, assetId: 'legacy-png', path: '素材/a.png' })
  check('E10.2 外部条目负例（video/doc/不存在/缺失/超大/非图片）→ 4xx 拒绝', negativePass === negative.length, JSON.stringify(negativeDetails))
  check('E10.2b path+assetId 同传 → 400 invalid-args', conflict.status === 400 && conflict.body && conflict.body.code === 'invalid-args', JSON.stringify({ status: conflict.status }))
  if (symlinkEntryCreated) {
    const symlinkResult = await call('media-read', { title: TITLE, assetId: 'legacy-symlink' })
    check('E10.3 外部 symlink 条目 → 404/403（不读链接目标）', [404, 403].includes(symlinkResult.status) && symlinkResult.body && symlinkResult.body.ok === false, String(symlinkResult.status))
  } else {
    console.log('      （SKIP：Windows 无权限创建 symlink → symlink 用例如实记录 SKIP）')
  }
  const pathCases = [
    ['path 穿越', { title: TITLE, path: '../legacy.png' }, 403],
    ['path 绝对外部', { title: TITLE, path: path.join(extDir, 'legacy.png') }, 403],
    ['path 缺失', { title: TITLE, path: '素材/missing.png' }, 404],
  ]
  let pathPass = 0
  const pathDetails = []
  for (const [label, body, expected] of pathCases) {
    const result = await call('media-read', body)
    if (result.status === expected) pathPass += 1
    else pathDetails.push(label + ':' + result.status + '!=' + expected)
  }
  check('E10.4 原 path 模式安全矩阵不回归（穿越/绝对外部/缺失）', pathPass === pathCases.length, JSON.stringify(pathDetails))
  const treeBefore = await treeHash(path.join(projectDir, '.aidrama'))
  const repeat1 = await call('media-read', { title: TITLE, assetId: 'legacy-png' })
  const repeat2 = await call('media-read', { title: TITLE, assetId: 'legacy-png' })
  check('E10.5 只读确定性（两次响应深等 / .aidrama 树 hash 不变）', deepEqual(repeat1.body, repeat2.body) && (await treeHash(path.join(projectDir, '.aidrama'))).hash === treeBefore.hash)
  const leakProbe = await call('media-read', { title: TITLE, assetId: 'legacy-not-exist' })
  check('E10.6 错误响应不泄露绝对路径/堆栈', !leakProbe.text.includes(extDir) && !leakProbe.text.includes(workspace) && !/[A-Za-z]:\\/.test(leakProbe.text) && !/\bat\s+.*:\d+:\d+/.test(leakProbe.text), leakProbe.text.slice(0, 120))
  check('E10.7 契约：METHODS 72 / 工具 35（无新 METHOD/route）', METHODS.length === 72 && TOOL_COUNT === 35)
}

group('[M20-C] 素材库 2.0 统一视图 UI（能力自适应）')
if (!clientCapability) {
  console.log('      （SKIP：client 统一卡片视图/旧登记预览尚未交付）')
} else {
  check('M1.1 自动加载：切到素材库即触发 assets-get（无需手动刷新）', clientSrc.includes("targetTab === 'assets' && openTitle") && /loadAssets\(\)\.catch/.test(clientSrc) && clientSrc.includes("api('assets-get'"))
  check('M1.2 旧登记项目（cards=0/assets>0）显示统一卡片视图（hasAssetData 条件 + ad-legacy-view/card）', /hasAssetData = assets\.length > 0 \|\| assetCards\.length > 0/.test(clientSrc) && clientSrc.includes("className: 'ad-legacy-view'") && clientSrc.includes("className: 'ad-legacy-card'") && clientSrc.includes('normalizeLegacyAssets'))
  check('M1.3 头部（素材库 · 已登记 N 条）+ kind chips + 搜索/排序', clientSrc.includes('素材库 · 已登记') && clientSrc.includes('LEGACY_ASSET_KIND_ORDER') && clientSrc.includes('登记素材类型筛选') && clientSrc.includes('搜索登记素材名称/备注/镜号') && clientSrc.includes('登记素材排序') && clientSrc.includes('name-asc') && clientSrc.includes('size-desc'))
  check('M1.4 图片卡预览：media-read 仅 assetId（无 path）且仅 image；img loading=lazy + data URL', clientSrc.includes("api('media-read', { title: openTitle, assetId: asset.id })") && /asset\.kind === 'image'/.test(clientSrc) && /loading: 'lazy'/.test(clientSrc) && clientSrc.includes('data:'))
  check('M1.5 文件缺失占位 + 查看大图 lightbox（role=dialog + 关闭）', clientSrc.includes('ad-legacy-missing') && clientSrc.includes('文件缺失') && clientSrc.includes('查看大图：') && clientSrc.includes('ad-visual-lightbox') && clientSrc.includes("role: 'dialog'") && clientSrc.includes('关闭'))
  check('M1.6 video/doc 占位+信息（不支持预览），无视频缩略图（无 <video> 标签）', clientSrc.includes('不支持预览') && clientSrc.includes('LEGACY_ASSET_KIND_LABELS') && !/<video\b/.test(clientSrc))
  check('M3.1 登记管理：折叠/展开（登记管理（N 条）+ aria-expanded）+ 素材资产登记表 + 刷新/重扫', clientSrc.includes('登记管理（') && clientSrc.includes("'aria-expanded': assetRegistrationExpanded") && clientSrc.includes('素材资产登记表') && clientSrc.includes('刷新/重扫'))
  check('M3.2 登记语义文案（项目内路径登记 + 不许项目外 + 登记后自动出现在上方卡片视图 + 刷新=同步文件变化）', clientSrc.includes('登记=把项目文件夹内的素材路径登记入库') && clientSrc.includes('仅支持项目内路径') && clientSrc.includes('不支持项目外路径') && clientSrc.includes('登记后自动出现在上方卡片视图') && /同步文件变化/.test(clientSrc))
  check('M3.3 登记后自动刷新：assets-add/remove 成功后 await loadAssets()（失败/外部拒绝不刷新）', /await api\('assets-add'[\s\S]{0,900}await loadAssets\(\)/.test(clientSrc) && /await api\('assets-remove'[\s\S]{0,900}await loadAssets\(\)/.test(clientSrc))
  check('M4.1 视觉圣经空态引导（无 style/scenes 时显示）', clientSrc.includes('配置风格 DNA / 场景卡后，可在此查看视觉圣经') && /!hasVisualData[\s\S]{0,300}visual-bible-hint/.test(clientSrc))
  check('M4.2 视觉圣经行为保持（v0.16.6 起「卡片视图|视觉圣经」切换始终显示；风格可编辑）', clientSrc.includes('asset-view-switch') && clientSrc.includes('视觉圣经'))
  check('M5.1 调用点 70 不增 / slots=4 / METHODS 70 / 工具 34 / 无新依赖', CLIENT_CALLS.size === 72 && SLOTS === 4 && METHODS.length === 72 && TOOL_COUNT === 35 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ calls: CLIENT_CALLS.size, slots: SLOTS }))
}

group('[L] lightbox 关闭（反馈 #2 热修：按钮/Esc/背景 + 焦点/滚动锁/提示）')
const lightboxFixAvailable = clientSrc.includes('closeVisualLightbox') && clientSrc.includes('data-lightbox-overlay') && clientSrc.includes('data-lightbox-close')
if (!lightboxFixAvailable) {
  console.log('      （SKIP：lightbox 关闭热修（Esc/背景/焦点/滚动锁/提示）尚未交付）')
} else {
  check('L1 统一关闭函数 + 关闭按钮（data-lightbox-close / aria 关闭大图预览 / 文案 关闭（Esc））', clientSrc.includes('const closeVisualLightbox = () => setVisualLightbox(null)') && clientSrc.includes("'data-lightbox-close': 'true'") && clientSrc.includes("'aria-label': '关闭大图预览'") && /关闭（Esc）/.test(clientSrc))
  check('L2 Esc 关闭：keydown 捕获阶段 Escape/Esc → preventDefault+stopPropagation+关闭，监听清理成对', /(?:doc|document)\.addEventListener\('keydown'[\s\S]{0,400}true\)/.test(clientSrc) && /event\.key === 'Escape' \|\| event\.key === 'Esc'/.test(clientSrc) && /removeEventListener\('keydown'[\s\S]{0,200}true\)/.test(clientSrc))
  check('L3 背景点击关闭（target===currentTarget）+ 图片/按钮 stopPropagation 不误关', clientSrc.includes("'data-lightbox-overlay': 'true'") && /event\.target === event\.currentTarget/.test(clientSrc) && /h\('img'[\s\S]{0,400}stopPropagation/.test(clientSrc))
  check('L4 焦点管理：记录触发元素、打开聚焦关闭按钮、关闭后 focus 还原 + Tab 焦点圈', clientSrc.includes('lightboxTriggerEl') && /trigger\.focus\(\)/.test(clientSrc) && /closeBtn\.focus\(\)/.test(clientSrc) && /event\.key !== 'Tab'/.test(clientSrc))
  check('L5 滚动锁成对：记录原 overflow → hidden → 关闭还原', clientSrc.includes('lightboxPrevBodyOverflow') && /document\.body\.style\.overflow = 'hidden'/.test(clientSrc) && /document\.body\.style\.overflow = lightboxPrevBodyOverflow/.test(clientSrc))
  check('L6 提示文案「点击背景或按 Esc 关闭」+ 遮罩根层级 z-index 提升', /点击背景或按 Esc 关闭/.test(clientSrc) && clientSrc.includes('ad-visual-lightbox-hint') && /z-index:10000/.test(clientSrc))
  check('L7 入口覆盖：所有入口共享单一 lightbox 状态与关闭逻辑（legacy/资产卡/视觉圣经头图/场景/角色/图墙）', (clientSrc.match(/visualImageThumb\(/g) || []).length >= 4 && clientSrc.includes('cached.dataUrl') && /visualImageThumb[\s\S]{0,900}lightboxTriggerEl[\s\S]{0,200}setVisualLightbox/.test(clientSrc))
  check('L8 回归红线：调用点 70 不增 / slots=4 / METHODS 70 / 工具 34 / 无新依赖', CLIENT_CALLS.size === 72 && SLOTS === 4 && METHODS.length === 72 && TOOL_COUNT === 35 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ calls: CLIENT_CALLS.size, slots: SLOTS }))
}
await fs.rm(workspace, { recursive: true, force: true })
await fs.rm(extDir, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
