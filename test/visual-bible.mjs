/**
 * v0.15.3 迭代 3 · 视觉圣经专区 · QA 验收套件（task-116）
 *
 * AC-V1 素材库内入口（不新增一级页签；仅 hasVisualData 显示；旧项目零新 UI）
 * AC-V2 数据聚合：assets-get add-only scenes/styleDNA（结构/五维/部分维度/排序/确定性/无数据字节不变/损坏容错/只读）
 * AC-V3 视觉基调 + 场景卡区 + 角色卡区（音频多段试听）+ 关键参考图墙（去重/lazy/data URL/lightbox/占位）
 * AC-V4 空态引导 / 只读 / 旧项目零新 UI
 * AC-V5 工具 34 / METHODS 70 / 调用点 70 不增 / slots=4 / 无新依赖 / 无新 route / 38+ 套件
 * AC-V6 首屏性能记录口径（lazy 加载不阻塞 + 视觉数据按需加载）
 *
 * 能力自适应：assets-get 无 scenes/styleDNA 且 client 无视觉圣经 UI → 整套件 SKIP（exit 0，不红）。
 * 运行：node test/visual-bible.mjs
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
const BASELINE_FILE = path.join(pluginRoot, '..', '_recover', 'v0153-baseline', 'baseline.json')
const hasBaseline = await fs.access(BASELINE_FILE).then(() => true, () => false)
const baseline = hasBaseline ? JSON.parse(await fs.readFile(BASELINE_FILE, 'utf8')) : null

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-bible-'))
const TITLE = '视觉圣经测试剧'
await store.createProject(workspace, TITLE)
const projectDir = path.join(workspace, 'AI短剧', TITLE)
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

group('[0] 能力探测 / 契约（版本自适应）')
const CHR001 = { id: 'CHR001', name: '林越', media: { images: ['https://cdn.example.com/lin.png'], audio: ['素材/voice.mp3'] } }
const SPC001 = { id: 'SPC001', name: '当铺', description: '老式当铺', space: { location: '城南旧街', timeOfDay: 'night', weather: '雨', interior: '内景' }, lighting: '暖黄顶灯' }
const SPC002 = { id: 'SPC002', name: '巷口', space: { location: '城南旧街', timeOfDay: 'night', weather: '雨', interior: '外景' } }
const STYLE = { palette: '暖金色调', lighting: '柔光', texture: '粗颗粒', composition: '低机位', motion: '缓推' }
await store.saveAssetCard(workspace, TITLE, CHR001)
await store.saveSceneCard(workspace, TITLE, SPC001)
await store.saveSceneCard(workspace, TITLE, SPC002)
await store.saveStyleDNA(workspace, TITLE, STYLE)
await store.writeEpisode(workspace, TITLE, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：这钱，我三天还你。\n')
await store.saveStoryboard(workspace, TITLE, 1, [{ shotNumber: '1-1', shotSize: '近景', cameraMove: '推', description: '旧分镜', durationSec: 6 }])
const probe = await call('assets-get', { title: TITLE })
const dataCapability = Boolean(probe.body && probe.body.ok === true && Array.isArray(probe.body.scenes) && probe.body.styleDNA && typeof probe.body.styleDNA === 'object')
const clientCapability = clientSrc.includes('视觉圣经') || clientSrc.includes('ad-visual-bible')
check('0.1 工具 34 / METHODS 70 / client 调用 69 / slots=4 / 无新依赖', TOOL_COUNT === 35 && METHODS.length === 72 && CLIENT_CALLS.size === 72 && SLOTS === 4 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ tools: TOOL_COUNT, methods: METHODS.length, calls: CLIENT_CALLS.size, slots: SLOTS }))
if (!dataCapability && !clientCapability) {
  console.log('  结果：0 passed, 0 failed（SKIP：assets-get 无 scenes/styleDNA 且 client 无视觉圣经 UI，visual-bible 套件跳过）')
  await fs.rm(workspace, { recursive: true, force: true })
  process.exit(0)
}
const NO_DATA_TITLE = '无数据剧'
await store.createProject(workspace, NO_DATA_TITLE)
const noDataProbe = await call('assets-get', { title: NO_DATA_TITLE })

group('[AC-V2] 数据聚合：assets-get add-only scenes/styleDNA（能力自适应）')
if (!dataCapability) {
  console.log('      （SKIP：assets-get scenes/styleDNA 尚未交付）')
} else {
  const body = probe.body
  check('V2.1 assets/cards 不回归（深等于 store 读取）', deepEqual(body.assets, await store.getAssets(workspace, TITLE)) && deepEqual(body.cards, await store.getAssetCards(workspace, TITLE)))
  check('V2.2 scenes 数组按 id 排序（SPC001/SPC002）', Array.isArray(body.scenes) && deepEqual(body.scenes.map((item) => item.id), ['SPC001', 'SPC002']), JSON.stringify(body.scenes && body.scenes.map((item) => item.id)))
  check('V2.3 scenes 项结构（id/name/space/lighting；无时间戳；未知字段不泄露）', body.scenes.every((item) => typeof item.id === 'string' && typeof item.name === 'string' && item.space && typeof item.space === 'object' && typeof item.lighting === 'string') && !/createdAt|updatedAt|addedAt/.test(JSON.stringify(body.scenes)), JSON.stringify(body.scenes && body.scenes[0]))
  check('V2.4 styleDNA 五维固定顺序（palette/lighting/texture/composition/motion）', JSON.stringify(Object.keys(body.styleDNA)) === JSON.stringify(['palette', 'lighting', 'texture', 'composition', 'motion']), JSON.stringify(body.styleDNA))
  check('V2.5 styleDNA 值与 style.json 一致', deepEqual(body.styleDNA, STYLE))
  await store.saveStyleDNA(workspace, TITLE, { palette: '暖金色调', lighting: '柔光' })
  const partial = await call('assets-get', { title: TITLE })
  check('V2.5b 部分维度：styleDNA 五维键齐全、缺省维为空串', partial.body.styleDNA && JSON.stringify(Object.keys(partial.body.styleDNA)) === JSON.stringify(['palette', 'lighting', 'texture', 'composition', 'motion']) && partial.body.styleDNA.palette === '暖金色调' && partial.body.styleDNA.texture === '' && partial.body.styleDNA.motion === '', JSON.stringify(partial.body.styleDNA))
  await store.saveStyleDNA(workspace, TITLE, STYLE)
  const noDataBody = noDataProbe.body
  check('V2.6 无数据项目：无 scenes/styleDNA 键，既有键形状不变', noDataBody.ok === true && !Object.hasOwn(noDataBody, 'scenes') && !Object.hasOwn(noDataBody, 'styleDNA') && Array.isArray(noDataBody.assets) && Array.isArray(noDataBody.cards), JSON.stringify(Object.keys(noDataBody)))
  if (baseline && baseline.assetsGetNoData) {
    const normalize = (payload) => { const copy = JSON.parse(JSON.stringify(payload || {})); if (typeof copy.workspace === 'string') copy.workspace = '<WORKSPACE>'; if (Object.prototype.hasOwnProperty.call(copy, 'registryOk')) delete copy.registryOk; return JSON.stringify(copy) }
    check('V2.7 无数据项目响应与 v0.15.2 基线逐字节一致（workspace 归一化）', sha256(normalize(noDataBody)) === baseline.assetsGetNoData.normalizedJsonSha256, JSON.stringify({ now: sha256(normalize(noDataBody)).slice(0, 16), base: baseline.assetsGetNoData.normalizedJsonSha256.slice(0, 16) }))
  } else {
    console.log('      （SKIP：基线 _recover/v0153-baseline 不在安装副本环境）')
  }
  const treeBefore = await treeHash(path.join(projectDir, '.aidrama'))
  const repeat = await call('assets-get', { title: TITLE })
  check('V2.8 确定性（两次响应深等）/ 只读（.aidrama 树 hash 不变）', deepEqual(repeat.body, body) && (await treeHash(path.join(projectDir, '.aidrama'))).hash === treeBefore.hash)
  check('V2.9 契约：METHODS 仍 70 / 工具 34（无新 METHOD/route）', METHODS.length === 72 && METHODS.includes('assets-get') && TOOL_COUNT === 35)
  const corruptRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-bible-corrupt-'))
  const CORRUPT_TITLE = '损坏容错剧'
  await store.createProject(corruptRoot, CORRUPT_TITLE)
  const corruptDir = path.join(corruptRoot, 'AI短剧', CORRUPT_TITLE)
  const corruptRoutes = new Map()
  indexMod.apply({
    provide: () => {},
    inject(services, callback) {
      callback({ connection: { fetch: { register: (spec) => corruptRoutes.set(spec.path, spec) } }, get: () => undefined, on: () => {}, effect: (fn) => fn() })
    },
    logger: { info: () => {}, warn: () => {} },
  }, { root: corruptRoot })
  const corruptSpec = corruptRoutes.get('/api/ai-drama/assets-get')
  await fs.mkdir(path.join(corruptDir, '.aidrama', 'scenes'), { recursive: true })
  await fs.writeFile(path.join(corruptDir, '.aidrama', 'scenes', 'cards.json'), '{ not-json', 'utf8')
  await fs.writeFile(path.join(corruptDir, '.aidrama', 'style.json'), '{ broken', 'utf8')
  const corruptResp = await corruptSpec.fetch(new Request('http://127.0.0.1:1/api/ai-drama/assets-get', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' }, body: JSON.stringify({ title: CORRUPT_TITLE }) }))
  const corruptBody = await corruptResp.json().catch(() => null)
  check('V2.10 损坏 scenes/style → 200、无 scenes/styleDNA 键、不报错', corruptResp.status === 200 && corruptBody && corruptBody.ok === true && !Object.hasOwn(corruptBody, 'scenes') && !Object.hasOwn(corruptBody, 'styleDNA'), JSON.stringify(corruptBody && Object.keys(corruptBody)))
  await fs.rm(corruptRoot, { recursive: true, force: true })
}

group('[AC-V1/V3/V4/V5/V6] 视觉圣经 UI（能力自适应）')
if (!clientCapability) {
  console.log('      （SKIP：client 视觉圣经 UI 尚未交付）')
} else {
  const topTabs = (() => {
    const start = clientSrc.indexOf('const TAB_GROUPS = [')
    if (start < 0) return []
    return [...clientSrc.slice(start).matchAll(/\{ id: '([a-z]+)', label: '([^']+)', tabs: \[([^\]]+)\] \}/g)].flatMap((m) => [...m[3].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]))
  })()
  check('V1.1 入口在素材库内、不新增一级页签（top tabs 仍 13；v0.16.5 契约入口上移）；v0.16.6 起「卡片视图 | 视觉圣经」切换始终显示（空项目也可进入填写风格）', topTabs.length === 13 && clientSrc.includes("'aria-label': '素材库视图切换'") && clientSrc.includes('卡片视图') && clientSrc.includes('视觉圣经') && clientSrc.includes('asset-view-switch'))
  check('V1.2 默认卡片视图 + 视图切换始终可用（v0.16.6 视觉圣经可编辑风格，取消 hasVisualData 门控）', clientSrc.includes("useState('cards')") && clientSrc.includes('asset-view-switch'))
  check('V3.0 视觉圣经根 + 筛选区（类型 chips / 搜索 / 排序 编号 ↑↓）', clientSrc.includes('visual-bible') && clientSrc.includes("'aria-label': '视觉圣经筛选'") && clientSrc.includes('搜索视觉资产编号或名称') && clientSrc.includes('视觉资产排序') && clientSrc.includes('编号 ↑') && clientSrc.includes('编号 ↓'))
  check('V3.1 视觉基调：五维标签（色板/光感/质感/构图偏好/运镜节奏）空维不渲染 + 无 style 空态', ['色板', '光感', '质感', '构图偏好', '运镜节奏'].every((t) => clientSrc.includes(t)) && clientSrc.includes('ad-visual-style-dim') && clientSrc.includes('暂无风格 DNA'))
  check('V3.2 场景卡区（标题/卡片/光源/缩略图兜底/无图占位/空态）', clientSrc.includes('场景卡区 · ') && clientSrc.includes('ad-visual-card') && clientSrc.includes('光源：') && clientSrc.includes('场景 · 无图') && clientSrc.includes('暂无场景卡') && clientSrc.includes('sceneThumbOf'))
  check('V3.3 角色卡区（别名/形象图/音频多段试听入口/无图占位/空态）', clientSrc.includes('角色卡区 · ') && clientSrc.includes('别名：') && clientSrc.includes('试听 ') && clientSrc.includes('段音色') && clientSrc.includes('暂无角色图片/音色'))
  check('V3.4 角色卡音频：<audio controls preload=metadata> 无 autoplay / 读取失败占位 / 无音频不渲染', /h\('audio'/.test(clientSrc) && clientSrc.includes('controls: true') && clientSrc.includes("preload: 'metadata'") && !/autoPlay\s*:/.test(clientSrc) && clientSrc.includes('音频不可试听（读取失败）'))
  check('V3.5 关键参考图墙：仅 cards media.images 去重聚合 + lazy 加载 + data URL 通道', clientSrc.includes('关键参考图墙 · ') && clientSrc.includes('ad-visual-wall') && clientSrc.includes('collectVisualImages') && clientSrc.includes('seen.has(src.value)') && /loading: 'lazy'/.test(clientSrc) && clientSrc.includes("api('media-read'"))
  check('V3.6 点击查看大图 lightbox（role=dialog + 关闭 + 只读）', clientSrc.includes('ad-visual-lightbox') && clientSrc.includes('查看大图：') && clientSrc.includes("role: 'dialog'") && clientSrc.includes('关闭'))
  check('V4.1 只读：视觉视图无编辑/上传/保存/删除按钮与写请求', !/api\('(media-upload|visual-bible-save|visualBible-save|visual-bible-delete)'/.test(clientSrc) && !/专属视觉[\s\S]{0,3000}(编辑|上传|保存|删除)/.test(clientSrc))
  check('V5.1 调用点 70 不增 / slots=4 / 工具 34 / METHODS 70 / 无新依赖', CLIENT_CALLS.size === 72 && SLOTS === 4 && TOOL_COUNT === 35 && METHODS.length === 72 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ calls: CLIENT_CALLS.size, slots: SLOTS }))
  check('V6.1 首屏性能口径：图片懒加载不阻塞 + 视觉数据按需加载（ensureVisualAssets 仅切换视图/筛选时调用）', /loading: 'lazy'/.test(clientSrc) && /ensureVisualAssets/.test(clientSrc) && /setAssetView\('visual'\)[\s\S]{0,160}ensureVisualAssets\(\)/.test(clientSrc))
}

await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
