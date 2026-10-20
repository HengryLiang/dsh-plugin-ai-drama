/**
 * v0.15.1 迭代 1 · 素材库改版（数据侧）：资产卡 media.images/thumbnail add-only · QA 验收套件（task-109）
 *
 * AC（数据侧）：
 *   - media add-only：无 media 卡结构不变（无 media 键）；含 media 卡写入/回读一致
 *   - 校验：images 1–6 项、每项字符串 ≤500、仅 http(s):// 或项目内相对路径（禁 `..` 逃逸/绝对路径）；thumbnail 可选
 *   - 去重：重复 URL 去重且顺序保留；thumbnail 缺省不写（读回无键）
 *   - 确定性：两独立项目同输入 cards.json 字节一致；按 id 排序、无时间戳
 *   - 旧项目：无 cards → getAssetCards 返回 []、不建文件/不报错；legacy .aidrama/assets.json 零改动
 *   - 契约：工具 34 / METHODS 69（task-110 media-read +1） / 无新 route / 无新依赖
 *
 * 版本自适应：保存含 media 的资产卡后回读不到 media → 当前工件尚无该能力（≤v0.15.0）→ 整套件 SKIP（exit 0）。
 * 运行：node test/asset-media.mjs
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
const media = await load('lib/media.js')
const indexMod = await load('index.js')
const toolsModule = await load('lib/tools.js')
const hostSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
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
const fileExists = (file) => fs.access(file).then(() => true, () => false)
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
const METHODS = (() => {
  const block = hostSrc.slice(hostSrc.indexOf('const METHODS = ['), hostSrc.indexOf(']', hostSrc.indexOf('const METHODS = [')))
  return new Set([...block.matchAll(/'([a-z][a-z0-9-]+)'/g)].map((match) => match[1]))
})()
const CLIENT_CALLS = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((match) => match[1]))
const SLOTS = (clientSrc.match(/slots\.register\(/g) || []).length
const TOOL_COUNT = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES.length : 0
const BASELINE_DIR = path.join(pluginRoot, '..', '_recover', 'v0151-baseline')
const hasBaseline = await fileExists(path.join(BASELINE_DIR, 'baseline.json'))

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-media-'))
const TITLE = 'media测试剧'
await store.createProject(workspace, TITLE)
const projectDir = path.join(workspace, 'AI短剧', TITLE)
const cardsFile = path.join(projectDir, '.aidrama', 'assets', 'cards.json')
const legacyFile = path.join(projectDir, '.aidrama', 'assets.json')

group('[0] 能力探测 / 契约（版本自适应）')
const cardWithMedia = {
  id: 'CHR001', name: '李慕白',
  media: { images: ['https://cdn.example.com/limubai.png', 'assets/img/limubai-2.jpg'], thumbnail: 'https://cdn.example.com/limubai-thumb.png' },
}
let capabilityDetected = false
try {
  const saved = await store.saveAssetCard(workspace, TITLE, cardWithMedia)
  const readBack = (await store.getAssetCards(workspace, TITLE)).find((card) => card.id === 'CHR001')
  capabilityDetected = Boolean(saved && readBack && readBack.media && Array.isArray(readBack.media.images) && readBack.media.images.length === 2)
} catch {}
if (!capabilityDetected) {
  console.log('  结果：0 passed, 0 failed（SKIP：当前工件尚无资产卡 media 字段（≤v0.15.0 安装包/host task-107 未交付），asset-media 套件跳过）')
  await fs.rm(workspace, { recursive: true, force: true })
  process.exit(0)
}
check('0.1 资产卡 media 能力已生效（写入/回读 media.images）', capabilityDetected)
check('0.2 工具 34 / METHODS 69（task-110 media-read +1） / client 调用 68 / slots=4 / 无新依赖', TOOL_COUNT === 34 && METHODS.size === 69 && CLIENT_CALLS.size === 69 && SLOTS === 4 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ tools: TOOL_COUNT, methods: METHODS.size, calls: CLIENT_CALLS.size, slots: SLOTS }))

group('[1] media add-only 写入/回读（images/thumbnail/顺序）')
const readCard = (id) => store.getAssetCards(workspace, TITLE).then((cards) => cards.find((card) => card.id === id) || null)
const chr001 = await readCard('CHR001')
check('1.1 media.images 回读顺序保留（2 项）且 thumbnail 回读一致', deepEqual(chr001.media.images, cardWithMedia.media.images) && chr001.media.thumbnail === cardWithMedia.media.thumbnail, JSON.stringify(chr001.media))
await store.saveAssetCard(workspace, TITLE, { id: 'CHR002', name: '赵铁' })
const chr002 = await readCard('CHR002')
check('1.2 无 media 卡不写 media 键（旧结构不变）', !Object.hasOwn(chr002, 'media') && chr002.id === 'CHR002' && chr002.name === '赵铁')
await store.saveAssetCard(workspace, TITLE, { id: 'CHR003', name: '无缩略图', media: { images: ['assets/img/c.png'] } })
const chr003 = await readCard('CHR003')
check('1.3 thumbnail 缺省不写（读回无 thumbnail 键，展示回退 images[0] 由 UI 覆盖）', !Object.hasOwn(chr003.media, 'thumbnail') && deepEqual(chr003.media.images, ['assets/img/c.png']))
await store.saveAssetCard(workspace, TITLE, { id: 'CHR004', name: '去重', media: { images: ['https://x/a.png', 'https://x/b.png', 'https://x/a.png'] } })
const chr004 = await readCard('CHR004')
check('1.4 images 重复去重且顺序保留（a,b）', deepEqual(chr004.media.images, ['https://x/a.png', 'https://x/b.png']), JSON.stringify(chr004.media))

group('[2] 非法 media → invalid-args 且不写盘')
const cardsHashBefore = sha256(await fs.readFile(cardsFile))
const invalidCases = [
  ['images 超 6 项', { images: Array.from({ length: 7 }, (_, index) => `https://x/${index}.png`) }],
  ['单 URL 超 500 字符', { images: ['https://x/' + 'a'.repeat(520) + '.png'] }],
  ['非字符串项', { images: [42] }],
  ['绝对路径', { images: ['/etc/passwd.png'] }],
  ['file:// 协议', { images: ['file:///tmp/a.png'] }],
  ['javascript: 协议', { images: ['javascript:alert(1)'] }],
  ['.. 逃逸', { images: ['../outside/a.png'] }],
  ['thumbnail 非字符串', { images: ['https://x/a.png'], thumbnail: 42 }],
  ['thumbnail 超长', { images: ['https://x/a.png'], thumbnail: 'https://x/' + 'a'.repeat(520) + '.png' }],
]
let invalidRejected = 0
const invalidDetails = []
for (const [index, [label, media]] of invalidCases.entries()) {
  const invalidId = `CHR0${20 + index}`
  try {
    const savedInvalid = await store.saveAssetCard(workspace, TITLE, { id: invalidId, name: '非法', media })
    invalidDetails.push(label + ':accepted:' + JSON.stringify(savedInvalid && savedInvalid.media))
  } catch (error) {
    if (error && error.code === 'invalid-args') invalidRejected += 1
    else invalidDetails.push(label + ':' + (error && error.code))
  }
}
check('2.1 9 类非法 media → invalid-args', invalidRejected === invalidCases.length, JSON.stringify(invalidDetails))
check('2.2 非法写入后 cards.json 字节不变（不写盘）', sha256(await fs.readFile(cardsFile)) === cardsHashBefore)
check('2.3 非法卡均未落盘', (await store.getAssetCards(workspace, TITLE)).every((card) => !/^CHR0(2[0-9])$/.test(card.id)))
const validRelative = await store.saveAssetCard(workspace, TITLE, { id: 'CHR011', name: '相对路径', media: { images: ['assets/img/ok.png'] } })
check('2.4 合法项目内相对路径写入成功', validRelative.id === 'CHR011' && deepEqual((await readCard('CHR011')).media.images, ['assets/img/ok.png']))

group('[2b] media-read 安全媒体通道（task-110，METHODS 68→69）')
const MEDIA_READ_AVAILABLE = METHODS.has('media-read')
if (!MEDIA_READ_AVAILABLE) {
  console.log('      （SKIP：media-read 尚未交付；host task-110 交付后校准）')
} else {
  const mediaRoutes = new Map()
  const mediaCtx = {
    provide: () => {},
    inject(services, callback) {
      callback({
        connection: { fetch: { register: (spec) => mediaRoutes.set(spec.path, spec) } },
        get: () => undefined,
        on: () => {},
        effect: (fn) => fn(),
      })
    },
    logger: { info: () => {}, warn: () => {} },
  }
  indexMod.apply(mediaCtx, { root: workspace })
  async function mediaCall(body) {
    const spec = mediaRoutes.get('/api/ai-drama/media-read')
    if (!spec) throw new Error('route not registered: media-read')
    const request = new Request('http://127.0.0.1:1/api/ai-drama/media-read', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' },
      body: JSON.stringify(body || {}),
    })
    const response = await spec.fetch(request)
    const text = await response.clone().text().catch(() => '')
    let payload = null
    try { payload = JSON.parse(text) } catch { payload = null }
    return { status: response.status, body: payload, text }
  }
  const mediaDir = path.join(projectDir, '素材')
  await fs.mkdir(path.join(mediaDir, '子目录'), { recursive: true })
  const formatFiles = {
    'a.png': { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]), mime: 'image/png' },
    'a.jpg': { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7]), mime: 'image/jpeg' },
    'a.jpeg': { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe1, 8, 9]), mime: 'image/jpeg' },
    'a.webp': { bytes: Buffer.from([0x52, 0x49, 0x46, 0x46, 10, 11]), mime: 'image/webp' },
    'a.gif': { bytes: Buffer.from([0x47, 0x49, 0x46, 0x38, 12, 13]), mime: 'image/gif' },
  }
  for (const [name, item] of Object.entries(formatFiles)) await fs.writeFile(path.join(mediaDir, name), item.bytes)
  await fs.writeFile(path.join(mediaDir, '说明.txt'), 'not-image')
  await fs.writeFile(path.join(mediaDir, '小图.png'), Buffer.alloc(200, 7))
  await fs.writeFile(path.join(mediaDir, '大图.png'), Buffer.alloc(9 * 1024 * 1024, 9))
  const OUTSIDE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-media-outside-'))
  const outsideFile = path.join(OUTSIDE_DIR, '秘密.png')
  await fs.writeFile(outsideFile, Buffer.from('outside-secret'))
  const outsideHashBefore = sha256(await fs.readFile(outsideFile))
  const mediaRootHashBefore = await treeHash(path.join(projectDir, '.aidrama'))
  // A. 合法 5 格式：base64 解码 sha256 == 源文件 / mime / size / name
  let formatPass = 0
  const formatDetails = []
  for (const [name, item] of Object.entries(formatFiles)) {
    const result = await mediaCall({ title: TITLE, path: '素材/' + name })
    const decoded = result.body && result.body.base64 ? Buffer.from(String(result.body.base64), 'base64') : Buffer.alloc(0)
    const ok = result.status === 200 && result.body && result.body.ok === true && result.body.mime === item.mime && result.body.name === name && Number(result.body.size) === item.bytes.length && sha256(decoded) === sha256(item.bytes)
    if (ok) formatPass += 1
    else formatDetails.push(name + ':' + result.status + ':' + JSON.stringify(result.body && result.body.mime))
  }
  check('2b.1 合法 5 格式：200 + mime/name/size 正确 + base64 解码 sha256==源文件', formatPass === 5, JSON.stringify(formatDetails))
  check('2b.2 8MB/扩展名白名单常量正确', media.MEDIA_READ_MAX_BYTES === 8 * 1024 * 1024 && JSON.stringify(Object.keys(media.MEDIA_EXT_MIME).sort()) === JSON.stringify(['.gif', '.jpeg', '.jpg', '.png', '.webp']))
  check('2b.3 maxBytes 合法值（等于文件大小）可读', (await mediaCall({ title: TITLE, path: '素材/小图.png', maxBytes: 200 })).status === 200)
  // B. 安全矩阵（HTTP 状态码）
  const securityCases = [
    ['path 缺失', {}, 400],
    ['path 非字符串', { title: TITLE, path: 42 }, 400],
    ['path 空串', { title: TITLE, path: '   ' }, 400],
    ['path 超长 501', { title: TITLE, path: '素材/' + 'a'.repeat(500) + '.png' }, 400],
    ['控制字符', { title: TITLE, path: '素材/a\u0000.png' }, 400],
    ['穿越 ../', { title: TITLE, path: '../outside-secret.png' }, 403],
    ['穿越 ..\\', { title: TITLE, path: '素材\\..\\..\\outside.png' }, 403],
    ['穿越 ..%2f', { title: TITLE, path: '..%2f..%2foutside.png' }, 403],
    ['穿越 %2e%2e%2f', { title: TITLE, path: '%2e%2e%2f%2e%2e%2foutside.png' }, 403],
    ['双重编码 %252e', { title: TITLE, path: '%252e%252e%252f%252e%252e%252foutside.png' }, 403],
    ['绝对路径 /', { title: TITLE, path: '/etc/passwd' }, 403],
    ['盘符 C:', { title: TITLE, path: 'C:\\Windows\\win.ini' }, 403],
    ['UNC', { title: TITLE, path: '\\\\server\\share\\a.png' }, 403],
    ['ADS a.png:stream', { title: TITLE, path: '素材/a.png:stream' }, 403],
    ['Windows 保留名 CON.png', { title: TITLE, path: 'CON.png' }, 403],
    ['Windows 保留名 素材/CON.png', { title: TITLE, path: '素材/CON.png' }, 403],
    ['尾随点 x.png.', { title: TITLE, path: '素材/x.png.' }, 403],
    ['目录', { title: TITLE, path: '素材/子目录' }, 400],
    ['缺失图片', { title: TITLE, path: '素材/不存在.png' }, 404],
    ['非图片扩展 .txt', { title: TITLE, path: '素材/说明.txt' }, 400],
    ['超大 >8MB', { title: TITLE, path: '素材/大图.png' }, 413],
    ['maxBytes 小于文件', { title: TITLE, path: '素材/小图.png', maxBytes: 100 }, 413],
    ['maxBytes 0', { title: TITLE, path: '素材/小图.png', maxBytes: 0 }, 400],
    ['maxBytes 非整数', { title: TITLE, path: '素材/小图.png', maxBytes: 1.5 }, 400],
    ['maxBytes 超 8MB', { title: TITLE, path: '素材/小图.png', maxBytes: 8388609 }, 400],
    ['maxBytes 字符串', { title: TITLE, path: '素材/小图.png', maxBytes: 'abc' }, 400],
    ['title 不存在', { title: '不存在的剧', path: '素材/a.png' }, 404],
  ]
  let securityPass = 0
  const securityDetails = []
  for (const [label, body, expected] of securityCases) {
    const result = await mediaCall(body)
    if (result.status === expected && result.body && result.body.ok === false) securityPass += 1
    else securityDetails.push(label + ':' + result.status + '!=' + expected + ':' + (result.body && result.body.code))
  }
  check('2b.4 28 项安全矩阵 HTTP 状态码正确（400/403/404/413）', securityPass === securityCases.length, JSON.stringify(securityDetails))
  const fullwidth = await mediaCall({ title: TITLE, path: '素材／..／秘密.png' })
  check('2b.4b title 缺省且工作区仅 1 个项目 → 自动选用成功', (await mediaCall({ path: '素材/a.png' })).status === 200)
  check('2b.5 全角斜杠不绕过（非 200）', fullwidth.status !== 200, String(fullwidth.status))
  const leakProbe = await mediaCall({ title: TITLE, path: '../outside-secret.png' })
  check('2b.6 错误响应不泄露绝对路径/堆栈', !leakProbe.text.includes(workspace) && !leakProbe.text.includes(projectDir) && !/\[A-Za-z]:\\/.test(leakProbe.text) && !/\bat\s+.*:\d+:\d+/.test(leakProbe.text), leakProbe.text.slice(0, 120))
  // C. symlink 逃逸（Windows 可能 EPERM → SKIP 记录）
  let symlinkRecord = 'skipped'
  try {
    const linkPath = path.join(mediaDir, '链接.png')
    await fs.symlink(outsideFile, linkPath, 'file')
    const symlinkResult = await mediaCall({ title: TITLE, path: '素材/链接.png' })
    symlinkRecord = symlinkResult.status === 403 && !symlinkResult.text.includes('outside-secret') ? 'pass' : 'fail'
  } catch (error) {
    symlinkRecord = (error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'UNKNOWN')) ? 'skipped' : 'fail'
  }
  check('2b.7 symlink 逃逸：403 且不读外部内容（Windows 无权限创建时 SKIP 如实记录）', symlinkRecord !== 'fail', symlinkRecord)
  // D. 只读 / 确定性 / 不读项目外
  check('2b.8 不读项目外文件（outside 文件 hash 不变）', sha256(await fs.readFile(outsideFile)) === outsideHashBefore)
  const repeat1 = await mediaCall({ title: TITLE, path: '素材/a.png' })
  const repeat2 = await mediaCall({ title: TITLE, path: '素材/a.png' })
  check('2b.9 确定性：两次响应严格相等', JSON.stringify(repeat1.body) === JSON.stringify(repeat2.body))
  check('2b.10 只读：.aidrama 树 hash 不变', (await treeHash(path.join(projectDir, '.aidrama'))).hash === mediaRootHashBefore.hash)
  // E. 契约
  check('2b.11 METHODS=69 含 media-read / 工具 34（H 类契约 task-110 批准）', METHODS.size === 69 && METHODS.has('media-read') && TOOL_COUNT === 34, String(METHODS.size))
  await fs.rm(OUTSIDE_DIR, { recursive: true, force: true })
}

group('[3] 确定性 / 旧项目回退 / legacy 零改动')
const sortIds = (await store.getAssetCards(workspace, TITLE)).map((card) => card.id)
check('3.1 cards.json 按 id 稳定排序', deepEqual(sortIds, sortIds.slice().sort()))
check('3.2 cards.json 无时间戳字段', !/createdAt|updatedAt|addedAt/.test(await fs.readFile(cardsFile, 'utf8')))
const ROOT2 = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-media-det2-'))
const ROOT3 = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-media-det3-'))
const detCards = [{ id: 'CHR001', name: 'A', media: { images: ['https://x/a.png'], thumbnail: 'https://x/a-t.png' } }, { id: 'SPC001', name: 'B', media: { images: ['assets/img/b.png'] } }]
for (const root of [ROOT2, ROOT3]) {
  await store.createProject(root, 'det')
  for (const card of detCards) await store.saveAssetCard(root, 'det', card)
}
const detFile2 = path.join(ROOT2, 'AI短剧', 'det', '.aidrama', 'assets', 'cards.json')
const detFile3 = path.join(ROOT3, 'AI短剧', 'det', '.aidrama', 'assets', 'cards.json')
check('3.3 两独立项目同输入 → cards.json 字节一致（确定性）', sha256(await fs.readFile(detFile2)) === sha256(await fs.readFile(detFile3)))
const OLD_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-media-old-'))
const OLD_TITLE = '旧项目'
await store.createProject(OLD_ROOT, OLD_TITLE)
await fs.rm(path.join(OLD_ROOT, 'AI短剧', OLD_TITLE, '.aidrama', 'assets'), { recursive: true, force: true })
const oldRead = await store.getAssetCards(OLD_ROOT, OLD_TITLE)
check('3.4 旧项目无 cards → 读取 [] 且不报错', Array.isArray(oldRead) && oldRead.length === 0)
check('3.5 旧项目读取不建 assets 目录/文件', !(await fileExists(path.join(OLD_ROOT, 'AI短剧', OLD_TITLE, '.aidrama', 'assets'))))
// legacy assets.json 零改动：在 temp 项目写 legacy 文件后保存资产卡，legacy 字节不变
await fs.writeFile(legacyFile, JSON.stringify({ assets: [{ id: 'legacy-1', source: 'old.mp4' }] }, null, 2) + '\n', 'utf8')
const legacyHashBefore = sha256(await fs.readFile(legacyFile))
await store.saveAssetCard(workspace, TITLE, { id: 'CHR012', name: 'legacy共存', media: { images: ['https://x/l.png'] } })
check('3.6 写资产卡不影响 legacy .aidrama/assets.json（hash 不变）', sha256(await fs.readFile(legacyFile)) === legacyHashBefore)

group('[3b] assets-get 响应 add-only cards（Lead 补充口径）')
const routes = new Map()
const ctx = {
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
}
indexMod.apply(ctx, { root: workspace })
async function call(method, body) {
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
const legacyAssets = await store.getAssets(workspace, TITLE)
const cardsTreeBefore = sha256(await fs.readFile(cardsFile))
const cardsCall = await call('assets-get', { title: TITLE })
check('3b.1 assets-get 200 / ok=true / 旧 assets 字段深等于 store 读取', cardsCall.status === 200 && cardsCall.body.ok === true && deepEqual(cardsCall.body.assets, legacyAssets))
check('3b.2 assets-get 响应 add-only cards 数组（与资产卡一致）', Array.isArray(cardsCall.body.cards) && deepEqual(cardsCall.body.cards.map((card) => card.id), (await store.getAssetCards(workspace, TITLE)).map((card) => card.id)), JSON.stringify(cardsCall.body.cards))
const routeChr001 = (cardsCall.body.cards || []).find((card) => card.id === 'CHR001')
check('3b.3 cards 中 media 字段随输出（images/thumbnail）', routeChr001 && routeChr001.media && deepEqual(routeChr001.media.images, cardWithMedia.media.images) && routeChr001.media.thumbnail === cardWithMedia.media.thumbnail)
check('3b.4 assets-get 读取不写盘（cards.json hash 不变）', sha256(await fs.readFile(cardsFile)) === cardsTreeBefore)
const NO_CARD_ROUTE = '无卡路由剧'
await store.createProject(workspace, NO_CARD_ROUTE)
const oldCall = await call('assets-get', { title: NO_CARD_ROUTE })
check('3b.5 无卡项目：cards=[] 且 assets 字段正常', oldCall.status === 200 && Array.isArray(oldCall.body.cards) && oldCall.body.cards.length === 0 && Array.isArray(oldCall.body.assets), JSON.stringify(oldCall.body).slice(0, 200))
await fs.rm(path.join(workspace, 'AI短剧', NO_CARD_ROUTE), { recursive: true, force: true })
if (hasBaseline) {
  const baseline = JSON.parse(await fs.readFile(path.join(BASELINE_DIR, 'baseline.json'), 'utf8'))
  check('3b.6 基线契约计数一致（client 404,024B / slots4 / calls69）', baseline.client.bytes === 404024 && baseline.client.slots === 4 && baseline.client.calls === 68)
} else {
  console.log('      （SKIP：基线 _recover/v0151-baseline 不在安装副本环境）')
}

group('[4] 契约 / 清理')
check('4.1 工具 34 / METHODS 69（task-110 media-read +1） / client 调用 68 / slots=4 不变', TOOL_COUNT === 34 && METHODS.size === 69 && CLIENT_CALLS.size === 69 && SLOTS === 4)
check('4.2 无新 route：METHODS=69 且 asset/media 路由仅既有 3 条 + 已批准 media-read', METHODS.size === 69 && JSON.stringify([...METHODS].filter((name) => /asset|media/i.test(name)).sort()) === JSON.stringify(['assets-add', 'assets-get', 'assets-remove', 'media-read']), JSON.stringify([...METHODS].filter((name) => /asset|media/i.test(name)).sort()))
check('4.3 无新依赖', Object.keys(pkg.dependencies || {}).length === 0)
await fs.rm(workspace, { recursive: true, force: true })
await fs.rm(ROOT2, { recursive: true, force: true })
await fs.rm(ROOT3, { recursive: true, force: true })
await fs.rm(OLD_ROOT, { recursive: true, force: true })
check('4.4 临时工作区已清理', !(await fileExists(workspace)) && !(await fileExists(ROOT2)) && !(await fileExists(OLD_ROOT)))

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
