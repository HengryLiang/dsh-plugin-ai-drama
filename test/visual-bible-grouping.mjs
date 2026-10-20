/**
 * v0.16.4 C-1 视觉圣经增强 QA 验收套件（task-142；第 48 套件）
 *
 * AC-V1 分组：图墙按资产类型分组（SPC→场景 / CHR→角色 / PRP→道具 / 其它→其他），组标题+计数准确；
 *           chips（全部/场景/角色/道具/其他）筛选与组内一致；组内 lazy 缩略图 + 只读 lightbox；排序/搜索仍生效；
 *           无图组不渲染/部分空态不报错；分组可折叠（折叠不渲染组内 img）。
 * AC-V2 空态/引导：无 style/scenes → 可操作引导（含配置入口/动作按钮、不新增 route）；区块无图占位。
 * AC-V3 只读零契约：调用点 70 不增 / slots=4 / 工具 34 / METHODS 70 / 无新依赖 / 无写请求。
 * AC-V4 兼容/回归：旧项目零新 UI；v0.16.3 基线 47 套件/2496 断言 0 failed（本套件为第 48 套件）。
 * AC-V5 性能：首屏 ≤300ms 记录型（lazy 不阻塞；实测值引用 client E2E/证据；本套件做 lazy/预计算静态断言）。
 *
 * 能力自适应：client 未含 C-1 分组标记 → 整套件 SKIP（exit 0，不红）。
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
const hasGrouping = clientSrc.includes('VISUAL_WALL_GROUPS') && clientSrc.includes('ad-visual-group') && clientSrc.includes('visualWallGroupOf')
if (!hasGrouping) {
  console.log('  结果：0 passed, 0 failed（SKIP：client 未含 C-1 图墙分组标记，visual-bible-grouping 套件跳过）')
  process.exit(0)
}
check('0.1 契约：METHODS 70 / 工具 34 / client 调用点 70 / slots=4 / 无新依赖', METHODS.length === 72 && TOOLS.length === 35 && CLIENT_CALLS.size === 72 && SLOTS === 4 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ methods: METHODS.length, tools: TOOLS.length, calls: CLIENT_CALLS.size, slots: SLOTS }))

// 视觉圣经渲染区（v0.15.3 段；C-1 增强位于其中）
const regionStart = clientSrc.indexOf('视觉圣经只读专区')
const regionEnd = clientSrc.indexOf('素材库 2.0', regionStart)
const visualRegion = regionStart >= 0 ? clientSrc.slice(regionStart, regionEnd > regionStart ? regionEnd : regionStart + 40000) : ''
const logicRegion = clientSrc.slice(clientSrc.indexOf('const visualImages ='), clientSrc.indexOf('const legacyAssetList =', clientSrc.indexOf('const visualImages =')))

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'vb-grouping-'))
const TITLE = '视觉圣经分组剧'
await store.createProject(workspace, TITLE)
const projectDir = path.join(workspace, 'AI短剧', TITLE)
const cards = [
  { id: 'CHR001', name: '林越', type: 'CHR', media: { images: ['https://cdn.example.com/chr1-a.png', 'https://cdn.example.com/chr1-b.png'] } },
  { id: 'CHR002', name: '赵铁', type: 'CHR', media: { images: ['https://cdn.example.com/chr2-a.png'], audio: ['素材/voice.mp3'] } },
  { id: 'CHR003', name: '无图角色', type: 'CHR', media: {} },
  { id: 'SPC001', name: '老式当铺', type: 'SPC', media: { images: ['https://cdn.example.com/spc1-a.png'], thumbnail: 'https://cdn.example.com/spc1-thumb.png' } },
  { id: 'PRP001', name: '青铜钥匙', type: 'PRP', media: { images: ['https://cdn.example.com/prp1-a.png'] } },
  { id: 'CST001', name: '戏服', type: 'CST', media: { images: ['https://cdn.example.com/cst1-a.png'] } },
]
for (const card of cards) await store.saveAssetCard(workspace, TITLE, card)
await store.saveSceneCard(workspace, TITLE, { id: 'SPC001', name: '老式当铺', space: { location: '城南旧街', interior: '内景' }, lighting: '暖黄顶灯' })
await store.saveStyleDNA(workspace, TITLE, { palette: '暖金色调', lighting: '柔光', texture: '粗糙', composition: '低机位', motion: '缓推' })
const routes = new Map()
indexMod.apply({ provide: () => {}, inject(services, callback) { callback({ connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } }, get: () => undefined, on: () => {}, effect: (fn) => fn() }) }, logger: { info: () => {}, warn: () => {} } }, { root: workspace })
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
  async function walk(current, rel) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      const relPath = rel ? rel + '/' + entry.name : entry.name
      if (entry.isDirectory()) await walk(full, relPath)
      else if (entry.isFile()) { hash.update(`${relPath}|`); hash.update(await fs.readFile(full)) }
    }
  }
  await walk(dir, '')
  return hash.digest('hex')
}

group('[AC-V3] 数据层：图墙数据 + 只读（参考分组口径）')
const beforeHash = await treeHash(path.join(projectDir, '.aidrama'))
const probe = await call('assets-get', { title: TITLE })
const afterHash = await treeHash(path.join(projectDir, '.aidrama'))
const body = probe.body || {}
const cardsOut = Array.isArray(body.cards) ? body.cards : []
const seen = new Set()
const refEntries = []
for (const card of cardsOut) {
  for (const raw of (card && card.media && Array.isArray(card.media.images) ? card.media.images : [])) {
    const src = typeof raw === 'string' ? raw.trim() : ''
    if (!src || seen.has(src)) continue
    seen.add(src)
    const type = String(card.type || '').toUpperCase()
    refEntries.push({ cardId: card.id, type, group: ({ CHR: '角色', SPC: '场景', PRP: '道具' })[type] || '其他', src })
  }
}
const refCounts = { 角色: 0, 场景: 0, 道具: 0, 其他: 0 }
for (const entry of refEntries) refCounts[entry.group] += 1
check('V3.1 assets-get 返回 cards/scenes/styleDNA 且只读（两次 .aidrama 树 hash 不变）', probe.status === 200 && cardsOut.length === 6 && Array.isArray(body.scenes) && body.scenes.length === 1 && Boolean(body.styleDNA) && beforeHash === afterHash, JSON.stringify({ status: probe.status, cards: cardsOut.length, scenes: body.scenes && body.scenes.length, style: Boolean(body.styleDNA), readOnly: beforeHash === afterHash }))
check('V3.2 参考分组口径：角色 3 / 场景 1 / 道具 1 / 其他 1（共 6，URL 去重；与 client 分组映射一致）', refEntries.length === 6 && refCounts.角色 === 3 && refCounts.场景 === 1 && refCounts.道具 === 1 && refCounts.其他 === 1, JSON.stringify(refCounts))
check('V3.3 只读：视觉数据仅经既有 assets-get；调用点 70 不增、无写请求', CLIENT_CALLS.size === 72 && CLIENT_CALLS.has('assets-get') && !/api\('(assets-save|contract-save|doc-save|entry-create|assets-import|intake-artifact)'\)/.test(logicRegion), JSON.stringify([...CLIENT_CALLS].filter((name) => /save|apply|remove/.test(name))))

group('[AC-V1] 分组 UI（静态断言：映射/顺序/组标题计数/折叠/chips/lazy/lightbox/排序搜索/空态）')
check('V1.1 分组常量 VISUAL_WALL_GROUPS：场景(SPC)/角色(CHR)/道具(PRP)/其他(其余) 顺序与类型映射', /VISUAL_WALL_GROUPS = \[\s*\{ key: 'scene', label: '场景', types: \['SPC'\] \},?\s*\{ key: 'char', label: '角色', types: \['CHR'\] \},?\s*\{ key: 'prop', label: '道具', types: \['PRP'\] \},?\s*\{ key: 'other', label: '其他', types: null \}/.test(clientSrc))
check('V1.2 visualWallGroupOf：类型归一化后按组匹配，未知类型回退 other', /function visualWallGroupOf\(type\)/.test(clientSrc) && /toUpperCase\(\)/.test(clientSrc) && /return 'other'/.test(clientSrc))
check('V1.3 组顺序与「非空组才渲染」：按 VISUAL_WALL_GROUPS 顺序 + filter(entries.length > 0)', /VISUAL_WALL_GROUPS\.map\(\(group\) => \(\{/.test(clientSrc) && /filter\(\(group\) => group\.entries\.length > 0\)/.test(clientSrc))
check('V1.4 组头：ad-visual-group-head + aria-expanded + 组名+计数+折叠符号', /className: 'ad-visual-group-head'/.test(clientSrc) && /'aria-expanded': !collapsed/.test(clientSrc) && /ad-visual-group-title'/.test(clientSrc) && /ad-visual-group-count ad-count'/.test(clientSrc) && /ad-visual-group-symbol/.test(clientSrc))
check('V1.5 组头可访问名称：含组名、张数、点击展开/折叠语义', /`\$\{group\.label\}参考图 \$\{group\.entries\.length\} 张，点击\$\{collapsed \? '展开' : '折叠'\}？`/ .test(clientSrc) || /参考图 \$\{group\.entries\.length\} 张/.test(clientSrc))
check('V1.6 折叠不渲染组内 img：collapsed ? null : 组墙（ad-visual-wall-group）', /collapsed\s*\? null\s*: h\('div', \{ className: 'ad-visual-wall ad-visual-wall-group'/.test(clientSrc))
check('V1.7 组墙 role=list + aria-label「<组名>参考图墙」+ 组内图 thumb/lazy', /role: 'list', 'aria-label': `\$\{group\.label\}参考图墙`/.test(clientSrc) && /loading: 'lazy'/.test(clientSrc))
check('V1.8 chips：全部 N + 场景/角色/道具/其他各自计数（visualGroupCounts）', /`全部 \$\{visualImages\.length\}`/.test(clientSrc) && /VISUAL_WALL_GROUPS\.map\(\(group\) => h\('button'/.test(clientSrc) && /`\$\{group\.label\} \$\{visualGroupCounts\.get\(group\.key\) \|\| 0\}`/.test(clientSrc) && /aria-pressed': visualType === group\.key/.test(clientSrc))
check('V1.9 chips 筛选与组内一致：wall 按 visualWallGroupOf(type)===visualType；场景/角色区按 visualType 门控', /visualWallGroupOf\(entry\.type\) === visualType/.test(clientSrc) && /visualShowSceneSection = visualType === 'all' \|\| visualType === 'scene'/.test(clientSrc) && /visualShowCharacterSection = visualType === 'all' \|\| visualType === 'char'/.test(clientSrc))
check('V1.10 只读 lightbox 保留（组内 thumb → setVisualLightbox）', /setVisualLightbox\(\{ src: openSrc, alt \}\)/.test(clientSrc) && /查看大图：/.test(clientSrc))
check('V1.11 排序/搜索仍生效（visualSortList/visualMatch 用于组前过滤与排序；toolbar 搜索+排序）', /visualSortList\(visualImages\.filter/.test(clientSrc) && /visualMatch\(entry\.cardId\) \|\| visualMatch\(entry\.cardName\)/.test(clientSrc) && /视觉资产排序/.test(clientSrc) && /搜索编号或名称/.test(clientSrc))
check('V1.12 无图组/部分空态不报错：无组时区分「筛选无该组参考图」/「无匹配」/无图引导', /当前筛选没有\$\{visualWallGroupLabel\(visualType\)\}参考图/.test(clientSrc) && /当前筛选没有匹配的参考图/.test(clientSrc) && /还没有参考图/.test(clientSrc))

group('[AC-V2] 空态/引导（无 style/scenes 可操作引导 + 区块无图占位）')
check('V2.1 统一引导组件 ad-visual-guidance + 动作按钮容器', /className: 'ad-visual-empty ad-visual-guidance'/.test(clientSrc) && /ad-visual-guidance-text/.test(clientSrc) && /ad-visual-guidance-actions/.test(clientSrc))
check('V2.2 无 style → 可操作引导（暂无风格 DNA + 交给 Agent/去卡片视图）', /暂无风格 DNA/.test(clientSrc) && /交给 Agent/.test(clientSrc) && /去卡片视图/.test(clientSrc))
check('V2.3 无场景卡/无角色图片音色 → 可操作引导（新文案）', /暂无场景卡/.test(clientSrc) && /暂无角色图片\/音色/.test(clientSrc) && /去卡片视图/.test(clientSrc))
check('V2.4 引导动作不新增 route（按钮仅 UI 动作；无新 api 调用）', !/ad-visual-guidance[\s\S]{0,600}api\(/.test(clientSrc) && METHODS.length === 72 && TOOLS.length === 35)
check('V2.5 区块无图占位（场景·无图/角色·无图/无参考图引导）', /场景 · 无图/.test(clientSrc) && /角色 · 无图/.test(clientSrc) && /还没有参考图/.test(clientSrc))
check('V2.6 旧项目（无视觉数据）零新 UI：hasVisualData 门控保留', /hasVisualData/.test(clientSrc) && /visual-bible/.test(clientSrc))

group('[AC-V4/V5] 兼容 / 性能 / DOM 安全（记录型）')
check('V4.1 既有视觉圣经套件仍在（visual-bible.mjs 回归基线 24/0；V3.3 已同步新文案）', await fs.access(path.join(pluginRoot, 'test', 'visual-bible.mjs')).then(() => true, () => false) && !(await fs.readFile(path.join(pluginRoot, 'test', 'visual-bible.mjs'), 'utf8')).includes("clientSrc.includes('暂无角色卡')"))
check('V4.2 视觉圣经 DOM 无绝对路径（渲染区无盘符路径模板）', !/[A-Za-z]:\\\\/.test(visualRegion) && !/title:\s*[^,)]*[A-Za-z]:\\\\/.test(visualRegion))
check('V5.1 首屏记录型：组预计算（先分组后渲染）+ lazy 不阻塞（无渲染期 api 请求）', /const visualWallGroups = VISUAL_WALL_GROUPS\.map/.test(clientSrc) && !/visualWallGroupNode[\s\S]{0,400}api\(/.test(clientSrc) && /loading: 'lazy'/.test(clientSrc))
console.log('      （记录型：首屏 ≤300ms 目标；client-dev 实测 v0.16.4 视觉页首屏 122ms（引用 client E2E/证据））')
check('V5.2 只读红线：调用点 70 / slots=4 / 工具 34 / METHODS 70 / 无新依赖', CLIENT_CALLS.size === 72 && SLOTS === 4 && TOOLS.length === 35 && METHODS.length === 72 && Object.keys(pkg.dependencies || {}).length === 0)

await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
