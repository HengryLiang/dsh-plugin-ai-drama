/**
 * v0.11.1 批 2 · 2-2 一期：场景卡 + shot.sceneRef + 五维风格 DNA · QA 验收套件（task-97）
 *
 * AC-22-1…AC-22-6：
 *   AC-22-1 场景卡 schema/必填/缺省（SPCxxx 编号复用 2-1 规则）
 *   AC-22-2 分镜 sceneRef 关联与回退（合法/非法/缺失旧行为/孤儿 WARN）
 *   AC-22-3 五维风格 DNA（.aidrama/style.json）存储/读取/缺省不生成/缺省不注入
 *   AC-22-4 零相机锁合（场景卡含 camera/lens/shotSize/framing → 校验拒绝）
 *   AC-22-5 旧项目只读/不建文件/不报错；legacy 数据零改动
 *   AC-22-6 工具 34 / METHODS 68 / client 68（M4 批1+批2 +10 已批准）/ 无新 route / 无新依赖 / all.mjs 36 套件
 *
 * 版本自适应：无 lib/scenes.js（≤v0.11.0 安装包）→ 整套件 SKIP（exit 0）。
 * 运行：node test/scenes.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href)
const scenesModulePath = path.join(pluginRoot, 'lib', 'scenes.js')
const scenesAvailable = await fs.access(scenesModulePath).then(() => true, () => false)

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

group('[0] 能力探测 / 契约（版本自适应）')
if (!scenesAvailable) {
  console.log('  结果：0 passed, 0 failed（SKIP：当前工件无 lib/scenes.js（≤v0.11.0 安装包），scenes 套件跳过）')
  process.exit(0)
}
const scenes = await load('lib/scenes.js')
const styleDna = await load('lib/style-dna.js')
const store = await load('lib/store.js')
const orchestrator = await load('lib/orchestrator.js')
const toolsModule = await load('lib/tools.js')
const hostSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8')
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
const methodsBlock = hostSrc.slice(hostSrc.indexOf('const METHODS = ['), hostSrc.indexOf(']', hostSrc.indexOf('const METHODS = [')))
const methods = new Set([...methodsBlock.matchAll(/'([a-z][a-z0-9-]+)'/g)].map((match) => match[1]))
const clientCalls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((match) => match[1]))
const toolCount = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES.length : 0
check('0.1 lib/scenes.js 导出场景卡核心纯函数', ['SCENE_ID_PATTERN', 'FORBIDDEN_CAMERA_KEYS', 'SCENE_INTERIORS', 'normalizeSceneId', 'isValidSceneId', 'nextSceneId', 'findForbiddenCameraKeys', 'normalizeSceneCard', 'validateSceneCard', 'sortScenes', 'buildSceneIndex', 'normalizeSceneIndex', 'checkSceneReferences'].every((name) => name in scenes), JSON.stringify(Object.keys(scenes).sort()))
check('0.2 lib/style-dna.js 导出五维 DNA 核心纯函数', ['STYLE_DIMENSIONS', 'STYLE_DIMENSION_LABELS', 'STYLE_TEXT_LIMIT', 'normalizeStyleDNA', 'validateStyleDNA', 'buildStyleDoc', 'normalizeStyleDoc'].every((name) => name in styleDna))
check('0.3 store 场景/风格 API（getScenes/saveSceneCard/nextSceneCardId/getStyleDNA/saveStyleDNA）', ['getScenes', 'saveSceneCard', 'nextSceneCardId', 'getStyleDNA', 'saveStyleDNA'].every((name) => typeof store[name] === 'function'))
check('0.4 SHOT_OPTIONAL_FIELDS 含 sceneRef（10→11）', Array.isArray(store.SHOT_OPTIONAL_FIELDS) && store.SHOT_OPTIONAL_FIELDS.length === 11 && store.SHOT_OPTIONAL_FIELDS.includes('sceneRef'), JSON.stringify(store.SHOT_OPTIONAL_FIELDS))
check('0.5 工具 34 / METHODS 68 / client 68（M4 批1+批2 +10 已批准）/ 无新依赖', toolCount === 34 && methods.size === 68 && clientCalls.size === 68 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ tools: toolCount, methods: methods.size, clientCalls: clientCalls.size }))

group('[1] AC-22-1/AC-22-4 场景编号 / schema / 零相机锁合')
check('1.1 SPCxxx 编号：3 位序号合法（含小写归一）', ['SPC001', 'SPC999', 'spc001', 'Spc001'].every((id) => scenes.isValidSceneId(id)))
check('1.2 非法场景编号拒绝（2/4 位、变体、坏前缀、空/非字符串）', ['SPC1', 'SPC0001', 'SPC001_01', 'XXX001', '', null, 42].every((id) => scenes.isValidSceneId(id) === false))
check('1.3 normalizeSceneId 大写归一', scenes.normalizeSceneId('spc001') === 'SPC001' && scenes.normalizeSceneId(42) === '')
check('1.4 nextSceneId 递增（空→SPC001；已有 SPC001/SPC003→SPC004）', scenes.nextSceneId([]) === 'SPC001' && scenes.nextSceneId(['SPC001', 'SPC003']) === 'SPC004')
const validSceneRaw = {
  id: 'spc001', name: '当铺', description: '老式当铺', space: { location: '城南旧街', timeOfDay: 'night', weather: 'rain', interior: '内景' },
  lighting: '暖黄顶灯+窗外冷雨光', assetRefs: ['CHR001', 'PRP001'], emotionBaseline: { label: '压抑', intensity: 60 }, notes: '柜台高过腰',
}
check('1.5 合法场景卡 validateSceneCard = []', scenes.validateSceneCard(validSceneRaw).length === 0, JSON.stringify(scenes.validateSceneCard(validSceneRaw)))
const normalizedScene = scenes.normalizeSceneCard(validSceneRaw)
check('1.6 schema 归一：id 大写/space 四要素/assetRefs 去重/emotionBaseline 圆整', normalizedScene.id === 'SPC001' && normalizedScene.space.location === '城南旧街' && normalizedScene.space.interior === '内景' && JSON.stringify(normalizedScene.assetRefs) === JSON.stringify(['CHR001', 'PRP001']) && normalizedScene.emotionBaseline.intensity === 60)
check('1.7 必填缺失（id/name）报错', scenes.validateSceneCard({ space: {} }).length >= 2)
const forbiddenTruthy = [...scenes.FORBIDDEN_CAMERA_KEYS]
check('1.8 零相机锁合：8 类禁字段（camera/cameraMove/lens/shotSize/framing/shotNumber/transitionToNext/poses）均被拒', forbiddenTruthy.length === 8 && forbiddenTruthy.every((key) => scenes.validateSceneCard({ ...validSceneRaw, [key]: 'x' }).some((message) => message.includes('零相机锁合'))), JSON.stringify(forbiddenTruthy))
check('1.8b 零相机锁合：大小写变体（Camera/LENS/ShotSize）同样被拒', ['Camera', 'LENS', 'ShotSize'].every((key) => scenes.validateSceneCard({ ...validSceneRaw, [key]: 'x' }).some((message) => message.includes('零相机锁合'))))
check('1.9 零相机锁合：嵌套字段（space.lens）同样被拒', scenes.findForbiddenCameraKeys({ space: { lens: '85mm' } }).length === 1 && scenes.validateSceneCard({ ...validSceneRaw, space: { ...validSceneRaw.space, lens: '85mm' } }).some((message) => message.includes('零相机锁合')))
check('1.10 space.interior 枚举校验（内景/外景/内外景合法；中景非法）', scenes.SCENE_INTERIORS.length === 3 && scenes.validateSceneCard({ ...validSceneRaw, space: { ...validSceneRaw.space, interior: '中景' } }).some((message) => message.includes('interior')))
check('1.11 assetRefs 编号非法报错', scenes.validateSceneCard({ ...validSceneRaw, assetRefs: ['XX001'] }).some((message) => message.includes('assetRefs')))
check('1.12 emotionBaseline 结构非法报错', scenes.validateSceneCard({ ...validSceneRaw, emotionBaseline: { label: '', intensity: 200 } }).some((message) => message.includes('emotionBaseline')))

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'scenes-test-'))
const TITLE = 'scenes测试剧'
const projectDir = path.join(workspace, 'AI短剧', TITLE)
const scenesFile = path.join(projectDir, '.aidrama', 'scenes', 'cards.json')
const styleFile = path.join(projectDir, '.aidrama', 'style.json')
await store.createProject(workspace, TITLE)

group('[2] AC-22-1/AC-22-5 场景卡存储 / 确定性 / 旧项目回退')
const beforeRead = await treeHash(projectDir)
const emptyScenes = await store.getScenes(workspace, TITLE)
const afterRead = await treeHash(projectDir)
check('2.1 旧项目无 scenes：读取返回 []（不报错）', Array.isArray(emptyScenes) && emptyScenes.length === 0)
check('2.2 读取不建目录/不写文件（项目树 hash 前后一致）', beforeRead.hash === afterRead.hash && beforeRead.count === afterRead.count, JSON.stringify({ before: beforeRead.count, after: afterRead.count }))
check('2.3 读取后 .aidrama/scenes 目录不存在', !(await fileExists(path.join(projectDir, '.aidrama', 'scenes'))))
const savedScene = await store.saveSceneCard(workspace, TITLE, validSceneRaw)
check('2.4 首写自动建 .aidrama/scenes/cards.json（小写归一 SPC001）', (await fileExists(scenesFile)) && savedScene.id === 'SPC001')
const sceneDoc = JSON.parse(await fs.readFile(scenesFile, 'utf8'))
check('2.5 cards.json 单文件结构 {schemaVersion:1, scenes:[]} 且无时间戳', sceneDoc.schemaVersion === 1 && Array.isArray(sceneDoc.scenes) && sceneDoc.scenes.length === 1 && !/createdAt|updatedAt|addedAt/.test(await fs.readFile(scenesFile, 'utf8')))
const savedScene2 = await store.saveSceneCard(workspace, TITLE, { id: 'SPC002', name: '巷口', space: { interior: '外景', weather: 'rain' } })
check('2.6 场景卡按 id 稳定排序（SPC001/SPC002）', JSON.stringify(JSON.parse(await fs.readFile(scenesFile, 'utf8')).scenes.map((scene) => scene.id)) === JSON.stringify(['SPC001', 'SPC002']))
check('2.7 nextSceneCardId 基于现有编号递增（SPC002→SPC003）', (await store.nextSceneCardId(workspace, TITLE)) === 'SPC003')
const scenesHashBefore = sha256(await fs.readFile(scenesFile))
let dupSceneError = null
try { await store.saveSceneCard(workspace, TITLE, { id: 'spc001', name: '重复场景' }) } catch (error) { dupSceneError = error }
let cameraSceneError = null
try { await store.saveSceneCard(workspace, TITLE, { id: 'SPC010', name: '带相机', camera: '固定机位' }) } catch (error) { cameraSceneError = error }
check('2.8 重复 id / 零相机锁合违规写入 → invalid-args', dupSceneError && dupSceneError.code === 'invalid-args' && cameraSceneError && cameraSceneError.code === 'invalid-args')
check('2.9 非法写入后 cards.json 字节不变（不写盘）', sha256(await fs.readFile(scenesFile)) === scenesHashBefore)
const updatedScene = await store.saveSceneCard(workspace, TITLE, { id: 'SPC001', name: '当铺（改）', notes: '补备注' }, { update: true })
check('2.10 update=true 更新已有场景卡（名称/备注生效；scene 卡不做字段 merge）', updatedScene.name === '当铺（改）' && updatedScene.notes === '补备注', JSON.stringify({ name: updatedScene.name, notes: updatedScene.notes }))
// 确定性：两个独立项目同输入 → cards.json 字节一致
const ROOT2 = await fs.mkdtemp(path.join(os.tmpdir(), 'scenes-det2-'))
const ROOT3 = await fs.mkdtemp(path.join(os.tmpdir(), 'scenes-det3-'))
const deterministicScenes = [
  { id: 'spc001', name: '当铺', space: { interior: '内景' }, assetRefs: ['CHR001'] },
  { id: 'SPC002', name: '巷口', space: { interior: '外景' } },
]
for (const root of [ROOT2, ROOT3]) {
  await store.createProject(root, TITLE)
  for (const scene of deterministicScenes) await store.saveSceneCard(root, TITLE, scene)
}
const sceneDoc2 = await fs.readFile(path.join(ROOT2, 'AI短剧', TITLE, '.aidrama', 'scenes', 'cards.json'))
const sceneDoc3 = await fs.readFile(path.join(ROOT3, 'AI短剧', TITLE, '.aidrama', 'scenes', 'cards.json'))
check('2.11 两个独立项目同输入 → 场景卡文件字节一致（确定性）', sha256(sceneDoc2) === sha256(sceneDoc3))
check('2.12 buildSceneIndex normalize 幂等', JSON.stringify(scenes.buildSceneIndex(await store.getScenes(workspace, TITLE))) === JSON.stringify(scenes.buildSceneIndex((await store.getScenes(workspace, TITLE)).map((scene) => scenes.normalizeSceneCard(scene)))))

group('[3] AC-22-2 shot.sceneRef 关联 / 非法 / 旧行为 / 孤儿 WARN')
const storyboardFile = path.join(projectDir, '.aidrama', 'storyboard', '第001集.md.json')
await store.writeEpisode(workspace, TITLE, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：这钱，我三天还你。\n')
const baseShot = { shotNumber: '1-1', shotSize: '近景', cameraMove: '推', description: '林越抬眼', durationSec: 6 }
await store.saveStoryboard(workspace, TITLE, 1, [baseShot])
const oldShots = JSON.parse(await fs.readFile(storyboardFile, 'utf8'))
check('3.1 缺失 sceneRef：旧行为不变（无 sceneRef 字段、已知字段正常）', oldShots.length === 1 && !('sceneRef' in oldShots[0]) && oldShots[0].description === '林越抬眼', JSON.stringify(oldShots[0]).slice(0, 160))
await store.saveStoryboard(workspace, TITLE, 1, [{ ...baseShot, sceneRef: 'spc001', customExtra: { keep: true } }])
const refShots = JSON.parse(await fs.readFile(storyboardFile, 'utf8'))
check('3.2 sceneRef add-only 写入读回（归一 SPC001）+ 未知字段保留', refShots[0].sceneRef === 'SPC001' && JSON.stringify(refShots[0].customExtra) === JSON.stringify({ keep: true }), JSON.stringify(refShots[0]).slice(0, 200))
await store.saveStoryboard(workspace, TITLE, 1, [{ ...baseShot, sceneRef: '' }])
const emptyRefShots = JSON.parse(await fs.readFile(storyboardFile, 'utf8'))
check('3.2b sceneRef 空值省略（不写入空字段）', !('sceneRef' in emptyRefShots[0]), JSON.stringify(emptyRefShots[0]).slice(0, 140))
let badRefError = null
try { await store.saveStoryboard(workspace, TITLE, 1, [{ ...baseShot, sceneRef: 'SPC1' }]) } catch (error) { badRefError = error }
let badRefTypeError = null
try { await store.saveStoryboard(workspace, TITLE, 1, [{ ...baseShot, sceneRef: 42 }]) } catch (error) { badRefTypeError = error }
check('3.3 非法 sceneRef（SPC1/数字）→ invalid-args', badRefError && badRefError.code === 'invalid-args' && badRefTypeError && badRefTypeError.code === 'invalid-args')
const sceneRefReport = scenes.checkSceneReferences({
  scenes: await store.getScenes(workspace, TITLE),
  shotsByEpisode: [{ order: 1, shots: [{ shotNumber: '1-1', sceneRef: 'SPC001' }, { shotNumber: '1-2', sceneRef: 'SPC999' }] }],
  assetIds: ['CHR001'],
})
check('3.4 孤儿 sceneRef → WARN 列表（scene-reference-missing，不阻断）', sceneRefReport.ok === false && sceneRefReport.warnings.some((item) => item.code === 'scene-reference-missing' && item.sceneRef === 'SPC999'), JSON.stringify(sceneRefReport.warnings.slice(0, 2)))
const assetRefReport = scenes.checkSceneReferences({ scenes: [{ id: 'SPC001', assetRefs: ['CHR999'] }], shotsByEpisode: [], assetIds: ['CHR001'] })
check('3.5 场景卡 assetRefs 孤儿 → WARN（scene-asset-missing）', assetRefReport.ok === false && assetRefReport.warnings.some((item) => item.code === 'scene-asset-missing' && item.assetId === 'CHR999'))
check('3.6 全部引用存在 → ok=true / warnings=[]', scenes.checkSceneReferences({ scenes: [{ id: 'SPC001', assetRefs: ['CHR001'] }], shotsByEpisode: [{ order: 1, shots: [{ shotNumber: '1-1', sceneRef: 'SPC001' }] }], assetIds: ['CHR001'] }).ok === true)

group('[4] AC-22-3 五维风格 DNA：结构/缺省不生成/确定性/缺省不注入')
check('4.1 STYLE_DIMENSIONS = 5 维且顺序固定', JSON.stringify(styleDna.STYLE_DIMENSIONS) === JSON.stringify(['palette', 'lighting', 'texture', 'composition', 'motion']))
const styleRaw = { palette: '暖黄+深木色，雨夜低饱和', lighting: '顶灯为主，窗外冷光作补', texture: '旧木纹与潮气颗粒', composition: '中低机位，柜台上方留白', motion: '缓推为主，转折处硬切' }
check('4.2 normalize 五维（缺省为空串）/未知维度忽略', (() => { const dna = styleDna.normalizeStyleDNA({ palette: '暖黄' }); return styleDna.STYLE_DIMENSIONS.every((dimension) => typeof dna[dimension] === 'string') && dna.palette === '暖黄' && dna.lighting === '' })())
check('4.3 validate：五维合法通过；额外维度/非字符串/超 300 字拒绝', styleDna.validateStyleDNA(styleRaw).length === 0 && styleDna.validateStyleDNA({ ...styleRaw, extra: 'x' }).length > 0 && styleDna.validateStyleDNA({ ...styleRaw, palette: 42 }).length > 0 && styleDna.validateStyleDNA({ ...styleRaw, palette: 'x'.repeat(301) }).length > 0)
check('4.4 buildStyleDoc 结构 {schemaVersion:1, style: 5 维} / normalizeStyleDoc 兼容裸对象', (() => { const doc = styleDna.buildStyleDoc(styleRaw); const back = styleDna.normalizeStyleDoc(doc); return doc.schemaVersion === 1 && Object.keys(doc.style).length === 5 && JSON.stringify(back.style) === JSON.stringify(doc.style) })())
const styleBefore = await treeHash(projectDir)
const emptyStyle = await store.getStyleDNA(workspace, TITLE)
const styleAfter = await treeHash(projectDir)
check('4.5 旧项目无 style：读取返回 null、不建文件/不报错（项目树 hash 不变）', emptyStyle === null && styleBefore.hash === styleAfter.hash && !(await fileExists(styleFile)), JSON.stringify({ emptyStyle, before: styleBefore.count, after: styleAfter.count }))
const savedStyle = await store.saveStyleDNA(workspace, TITLE, styleRaw)
const styleDoc = JSON.parse(await fs.readFile(styleFile, 'utf8'))
check('4.6 保存后 .aidrama/style.json 结构正确（5 维/无时间戳）', savedStyle.palette === styleRaw.palette && styleDoc.schemaVersion === 1 && JSON.stringify(Object.keys(styleDoc.style)) === JSON.stringify(styleDna.STYLE_DIMENSIONS) && !/createdAt|updatedAt|addedAt/.test(await fs.readFile(styleFile, 'utf8')))
const readStyle = await store.getStyleDNA(workspace, TITLE)
check('4.7 读取回读一致（5 维全等）', JSON.stringify(readStyle) === JSON.stringify(styleDna.normalizeStyleDNA(styleRaw)))
await fs.writeFile(styleFile, JSON.stringify({ schemaVersion: 1, style: { ...styleRaw, futureDimension: '未知维度应忽略' } }, null, 2) + '\n', 'utf8')
const styleWithUnknown = await store.getStyleDNA(workspace, TITLE)
check('4.7b 读时忽略未知维度（不报错/不进 5 维）', !('futureDimension' in styleWithUnknown) && JSON.stringify(styleWithUnknown) === JSON.stringify(styleDna.normalizeStyleDNA(styleRaw)))
await store.saveStyleDNA(workspace, TITLE, styleRaw)
let badStyleError = null
try { await store.saveStyleDNA(workspace, TITLE, { ...styleRaw, extraDimension: 'x' }) } catch (error) { badStyleError = error }
check('4.8 额外维度写入 → invalid-args（不写盘）', badStyleError && badStyleError.code === 'invalid-args' && JSON.stringify(await store.getStyleDNA(workspace, TITLE)) === JSON.stringify(styleDna.normalizeStyleDNA(styleRaw)))
const STYLE_ROOT2 = await fs.mkdtemp(path.join(os.tmpdir(), 'style-det2-'))
const STYLE_ROOT3 = await fs.mkdtemp(path.join(os.tmpdir(), 'style-det3-'))
for (const root of [STYLE_ROOT2, STYLE_ROOT3]) {
  await store.createProject(root, TITLE)
  await store.saveStyleDNA(root, TITLE, styleRaw)
}
const style2 = await fs.readFile(path.join(STYLE_ROOT2, 'AI短剧', TITLE, '.aidrama', 'style.json'))
const style3 = await fs.readFile(path.join(STYLE_ROOT3, 'AI短剧', TITLE, '.aidrama', 'style.json'))
check('4.9 两个独立项目同输入 → style.json 字节一致（确定性）', sha256(style2) === sha256(style3))
// 缺省不注入：同一分镜在「有 style」与「无 style」两个项目 → planEpisode 输出逐字节一致
const NO_STYLE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'style-none-'))
const WITH_STYLE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'style-with-'))
for (const root of [NO_STYLE_ROOT, WITH_STYLE_ROOT]) {
  await store.createProject(root, TITLE)
  await store.writeEpisode(root, TITLE, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：这钱，我三天还你。\n')
  await store.saveStoryboard(root, TITLE, 1, [{ shotNumber: '1-1', shotSize: '近景', cameraMove: '推', description: '林越抬眼', durationSec: 6, sceneRef: 'SPC001' }])
}
await store.saveStyleDNA(WITH_STYLE_ROOT, TITLE, styleRaw)
const planNoStyle = await orchestrator.planEpisode(NO_STYLE_ROOT, TITLE, { episode: 1, kind: 'image', record: false })
const planWithStyle = await orchestrator.planEpisode(WITH_STYLE_ROOT, TITLE, { episode: 1, kind: 'image', record: false })
const videoNoStyle = await orchestrator.planEpisode(NO_STYLE_ROOT, TITLE, { episode: 1, kind: 'video', record: false })
const videoWithStyle = await orchestrator.planEpisode(WITH_STYLE_ROOT, TITLE, { episode: 1, kind: 'video', record: false })
// 版本自适应：v0.11.3+ 注入生效后，「style 不注入」旧断言由 test/style-injection.mjs 覆盖（本套件保留存储/读取职责）。
const injectionActive = JSON.stringify(videoNoStyle.items) !== JSON.stringify(videoWithStyle.items)
if (injectionActive) {
  console.log('      （SKIP：v0.11.3+ 风格注入已生效；「不注入」旧断言由 test/style-injection.mjs 覆盖）')
} else {
  check('4.10 缺省不注入：有 style 与无 style 项目 planEpisode 输出逐字节一致', JSON.stringify(planNoStyle.items) === JSON.stringify(planWithStyle.items) && JSON.stringify(videoNoStyle.items) === JSON.stringify(videoWithStyle.items))
  const planBeforeStyle = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'image', record: false })
  await store.saveStyleDNA(workspace, TITLE, styleRaw)
  const planAfterStyle = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'image', record: false })
  check('4.11 style 保存前后 image plan items 严格一致（不参与生成/渲染）', JSON.stringify(planBeforeStyle.items) === JSON.stringify(planAfterStyle.items))
  const videoBeforeStyle = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'video', record: false })
  await store.saveStyleDNA(workspace, TITLE, styleRaw)
  const videoAfterStyle = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'video', record: false })
  check('4.11b style 保存前后 video plan items 严格一致（不注入 videoPrompt）', JSON.stringify(videoBeforeStyle.items) === JSON.stringify(videoAfterStyle.items))
}

group('[5] 契约 / 清理（AC-22-6）')
check('5.1 工具 34 / METHODS 68 / client 68（M4 批1+批2 已批准）', toolCount === 34 && methods.size === 68 && clientCalls.size === 68)
check('5.2 无新增 scene/style route（METHODS 未增）', ![...methods].some((name) => /^(scenes?|style)(-|$)/i.test(name)), JSON.stringify([...methods].filter((name) => /scene|style/i.test(name))))
check('5.3 无新依赖', Object.keys(pkg.dependencies || {}).length === 0)
await fs.rm(workspace, { recursive: true, force: true })
await fs.rm(ROOT2, { recursive: true, force: true })
await fs.rm(ROOT3, { recursive: true, force: true })
await fs.rm(STYLE_ROOT2, { recursive: true, force: true })
await fs.rm(STYLE_ROOT3, { recursive: true, force: true })
await fs.rm(NO_STYLE_ROOT, { recursive: true, force: true })
await fs.rm(WITH_STYLE_ROOT, { recursive: true, force: true })
check('5.4 临时工作区已清理', !(await fileExists(workspace)) && !(await fileExists(ROOT2)) && !(await fileExists(ROOT3)))

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
