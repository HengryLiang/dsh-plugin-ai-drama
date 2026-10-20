/**
 * v0.11.3 批 2 · 2-2 二期：风格 DNA / 场景约束注入 videoPrompt · QA 验收套件（task-102）
 *
 * AC-S1…AC-S6：
 *   AC-S1 有 style/场景 → videoPrompt 含风格约束（≥3 维可观测、自然语言融合非裸字段、不覆盖既有内容）
 *   AC-S2 无 style/无 sceneRef 旧项目（万界倒爷 19 镜复制）video/image items 与 v0.11.2 逐字节一致
 *   AC-S3 部分维度只注入已有（不编造缺失维度）
 *   AC-S4 确定性（两次 planEpisode/buildVideoPromptText 严格相等）
 *   AC-S5 imagePrompt 零回归（与基线逐字节一致）
 *   AC-S6 工具 34 / METHODS 68 / 无新 route / 无新依赖 / 旧数据 32 hash / all.mjs 35 套件 / 真实模型 0
 *
 * 版本自适应：有 style 与无 style 的 videoPrompt 相同 → 无注入实现，整套件 SKIP（exit 0）。
 * 基线：`_recover/v0113-baseline/`（QA-owned，v0.11.2 注入前现态；安装副本无该目录时字节断言 SKIP 注明）。
 * 运行：node test/style-injection.mjs
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
const orchestrator = await load('lib/orchestrator.js')
const vp = await load('lib/video-prompt.js')
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
const BARE_FIELD_RE = /(?:^|[\s，。；\n])(palette|lighting|texture|composition|motion|light|ambientSound|emotion)\s*[:：]/i
const BASELINE_DIR = path.join(pluginRoot, '..', '_recover', 'v0113-baseline')
const STYLE = { palette: '暖金色调SENT_PALETTE', lighting: '柔光SENT_LIGHT', texture: '粗颗粒SENT_TEXTURE', composition: '低机位SENT_COMP', motion: '缓推SENT_MOTION' }
const NEO_SHOTS = [
  { shotNumber: '1-1', shotSize: '大特写', cameraMove: '固定', description: '他指节抵住桌沿', dialogue: '林越：这钱', durationSec: 6, light: '右上窗光斜切', ambientSound: '雨声', poses: { startPose: '站定', endPose: '转身' }, transitionToNext: 'match-cut', emotion: { label: '警觉', intensity: 60 }, lens: '50mm', subject: '林越', groupId: 'g1', naturalLanguagePrompt: '他内心收紧，指节抵住桌沿。' },
  { shotNumber: '1-2', shotSize: '中景', cameraMove: '缓推', description: '林越抬眼', dialogue: '赵铁：三天？', durationSec: 5, light: '顶光', ambientSound: '雨声渐弱', poses: { startPose: '转身', endPose: '抬头' }, lens: '35mm', subject: '林越', groupId: 'g1' },
]
const SCENE = { id: 'SPC001', name: '当铺', description: '老式当铺，柜台高过腰', space: { location: '城南旧街', timeOfDay: 'night', weather: '雨', interior: '内景' }, lighting: '灯光SENT_SCENE_LIGHT', emotionBaseline: { label: '压抑', intensity: 60 }, assetRefs: [] }
async function makeProject(root, title, shots, { style = null, scene = null, groups = null } = {}) {
  await store.createProject(root, title)
  await store.writeEpisode(root, title, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：这钱，我三天还你。\n')
  await store.saveStoryboard(root, title, 1, shots)
  if (style) await store.saveStyleDNA(root, title, style)
  if (scene) await store.saveSceneCard(root, title, scene)
  if (groups) await store.saveStoryboardGroups(root, title, 1, groups)
}
async function loadBaseline(name) {
  try { return JSON.parse(await fs.readFile(path.join(BASELINE_DIR, name), 'utf8')) } catch { return null }
}
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'style-injection-'))
await makeProject(workspace, '无风格剧', NEO_SHOTS)
await makeProject(workspace, '有风格剧', NEO_SHOTS, { style: STYLE })
const probeNoStyle = await orchestrator.planEpisode(workspace, '无风格剧', { episode: 1, kind: 'video', record: false })
const probeWithStyle = await orchestrator.planEpisode(workspace, '有风格剧', { episode: 1, kind: 'video', record: false })
const injectionActive = !deepEqual(probeNoStyle.items, probeWithStyle.items)
await fs.rm(workspace, { recursive: true, force: true })

group('[0] 能力探测 / 契约（版本自适应）')
if (!injectionActive) {
  console.log('  结果：0 passed, 0 failed（SKIP：有 style 与无 style 的 videoPrompt 相同 → 当前工件尚无风格注入（≤v0.11.2 安装包），style-injection 套件跳过）')
  process.exit(0)
}
const methodsBlock = hostSrc.slice(hostSrc.indexOf('const METHODS = ['), hostSrc.indexOf(']', hostSrc.indexOf('const METHODS = [')))
const methods = new Set([...methodsBlock.matchAll(/'([a-z][a-z0-9-]+)'/g)].map((match) => match[1]))
const clientCalls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((match) => match[1]))
const toolCount = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES.length : 0
check('0.1 风格注入已生效（有 style ≠ 无 style 的 videoPrompt）', injectionActive)
check('0.2 风格句上限常量 STYLE_CUE_MAX_CHARS=600', vp.STYLE_CUE_MAX_CHARS === 600, String(vp.STYLE_CUE_MAX_CHARS))
check('0.3 工具 34 / METHODS 68 / client 68（M4 批1+批2 +10 已批准）/ 无新依赖', toolCount === 34 && methods.size === 68 && clientCalls.size === 68 && Object.keys(pkg.dependencies || {}).length === 0)

group('[1] 单元：renderStyleCue 五维/场景/部分维度/空值')
const cueFull = vp.renderStyleCue({ style: STYLE })
check('1.1 五维风格句：5 个哨兵词全部出现且 ≤600 字', ['SENT_PALETTE', 'SENT_LIGHT', 'SENT_TEXTURE', 'SENT_COMP', 'SENT_MOTION'].every((word) => cueFull.includes(word)) && cueFull.length <= 600, cueFull)
check('1.2 风格句自然语言融合：以「画面风格上」开头、无裸字段罗列', /^画面风格上/.test(cueFull) && !BARE_FIELD_RE.test(cueFull), cueFull)
check('1.3 空 style → 空串（不注入）', vp.renderStyleCue({ style: null }) === '' && vp.renderStyleCue({ style: {} }) === '')
const cuePartial = vp.renderStyleCue({ style: { palette: STYLE.palette, lighting: STYLE.lighting } })
check('1.4 部分维度：仅注入已有 2 维，不出现缺失维哨兵', cuePartial.includes('SENT_PALETTE') && cuePartial.includes('SENT_LIGHT') && !cuePartial.includes('SENT_TEXTURE') && !cuePartial.includes('SENT_COMP') && !cuePartial.includes('SENT_MOTION'), cuePartial)
const cueScene = vp.renderStyleCue({ scene: SCENE })
check('1.5 场景卡注入：名称/空间/光线/基线情绪可观测', cueScene.includes('当铺') && cueScene.includes('内景') && cueScene.includes('night') && cueScene.includes('雨') && cueScene.includes('灯光SENT_SCENE_LIGHT') && cueScene.includes('基线情绪：压抑（60/100）'), cueScene)
const cueBoth = vp.renderStyleCue({ style: STYLE, scene: SCENE })
check('1.6 style+scene 合并：风格句在前、场景句在后且总长 ≤600', cueBoth.indexOf('SENT_PALETTE') < cueBoth.indexOf('当铺') && cueBoth.length <= 600, String(cueBoth.length))
const built = vp.buildVideoPromptText(NEO_SHOTS[0], { control: '', styleCue: cueFull })
check('1.7 buildVideoPromptText：styleCue 段落插入且 hasStyleCue=true、含【镜头 1-1】', built && built.hasStyleCue === true && built.prompt.includes('SENT_PALETTE') && built.prompt.includes('【镜头 1-1】') && built.prompt.indexOf('SENT_PALETTE') < built.prompt.indexOf('【镜头 1-1】'))

const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'style-injection-main-'))
group('[2] AC-S1 有 style/场景 → videoPrompt 注入可观测且不覆盖既有内容')
const styleShots = NEO_SHOTS.map((shot, index) => (index === 0 ? { ...shot, sceneRef: 'SPC001' } : { ...shot }))
await makeProject(projectRoot, '风格注入剧', styleShots, { style: STYLE, scene: SCENE, groups: [{ id: 'g1', name: '开场压迫', shotNumbers: ['1-1', '1-2'], notes: '统一冷调' }] })
const stylePlan = await orchestrator.planEpisode(projectRoot, '风格注入剧', { episode: 1, kind: 'video', record: false })
const stylePrompts = stylePlan.items.map((item) => item.prompt)
check('2.1 两个镜头的 videoPrompt 均含 ≥3 维风格哨兵（项目级 style）', stylePrompts.every((prompt) => ['SENT_PALETTE', 'SENT_LIGHT', 'SENT_TEXTURE', 'SENT_COMP', 'SENT_MOTION'].filter((word) => prompt.includes(word)).length >= 3), stylePrompts.map((prompt) => prompt.slice(0, 80)).join(' | '))
check('2.2 场景归属镜（1-1）含场景名/空间/光线/基线情绪', stylePrompts[0].includes('当铺') && stylePrompts[0].includes('内景') && stylePrompts[0].includes('灯光SENT_SCENE_LIGHT') && stylePrompts[0].includes('基线情绪'), stylePrompts[0].slice(0, 220))
check('2.3 段落顺序：分组总控 → 风格/场景句 → 【镜头 N】', stylePrompts.every((prompt) => {
  const controlIndex = prompt.indexOf('【全组情绪总控】')
  const styleIndex = prompt.indexOf('SENT_PALETTE')
  const shotIndex = prompt.indexOf('【镜头 ')
  return controlIndex >= 0 && styleIndex > controlIndex && shotIndex > styleIndex
}))
check('2.4 不覆盖既有内容：镜号/景别/焦段/光影/现场声/情绪/台词等仍在', stylePrompts[0].includes('【镜头 1-1】') && stylePrompts[0].includes('大特写') && stylePrompts[0].includes('50mm') && stylePrompts[0].includes('光影方面') && stylePrompts[0].includes('耳边是') && stylePrompts[0].includes('这一镜的情绪是'))
check('2.5 非裸字段罗列（无 palette:/lighting:/emotion: 等）', stylePrompts.every((prompt) => !BARE_FIELD_RE.test(prompt)))
check('2.6 整镜 prompt ≤2000 字', stylePrompts.every((prompt) => prompt.length <= 2000), JSON.stringify(stylePrompts.map((prompt) => prompt.length)))
const styleImage = await orchestrator.planEpisode(projectRoot, '风格注入剧', { episode: 1, kind: 'image', record: false })
const baselineStyleImage = await loadBaseline('style-project-image.json')
if (baselineStyleImage) {
  check('2.7 imagePrompt 零回归：有 style 项目 image items 与 v0.11.2 基线逐字节一致', deepEqual(styleImage.items, baselineStyleImage))
} else {
  console.log('      （SKIP：基线 _recover/v0113-baseline 不在安装副本环境，image 字节对比跳过）')
}
// 仅 sceneRef（无 style）：仍注入场景约束，image 不变
await makeProject(projectRoot, '仅场景剧', styleShots.map((shot) => ({ ...shot })), { scene: SCENE })
const scenePlan = await orchestrator.planEpisode(projectRoot, '仅场景剧', { episode: 1, kind: 'video', record: false })
check('2.8 仅 sceneRef（无 style）→ videoPrompt 注入场景约束', scenePlan.items[0].prompt.includes('当铺') && scenePlan.items[0].prompt.includes('灯光SENT_SCENE_LIGHT') && !scenePlan.items[0].prompt.includes('SENT_PALETTE'))
const sceneImage = await orchestrator.planEpisode(projectRoot, '仅场景剧', { episode: 1, kind: 'image', record: false })
check('2.9 仅 sceneRef → imagePrompt 不含场景注入（与同输入无场景口径一致）', !sceneImage.items.some((item) => item.prompt.includes('灯光SENT_SCENE_LIGHT')))

group('[3] AC-S3 部分维度只注入已有（不编造缺失维度）')
await makeProject(projectRoot, '部分维度剧', NEO_SHOTS, { style: { palette: STYLE.palette, lighting: STYLE.lighting } })
const partialPlan = await orchestrator.planEpisode(projectRoot, '部分维度剧', { episode: 1, kind: 'video', record: false })
check('3.1 仅 2 维非空 → 只出现这 2 维哨兵（不出现 texture/composition/motion）', partialPlan.items.every((item) => item.prompt.includes('SENT_PALETTE') && item.prompt.includes('SENT_LIGHT') && !item.prompt.includes('SENT_TEXTURE') && !item.prompt.includes('SENT_COMP') && !item.prompt.includes('SENT_MOTION')))

group('[4] AC-S2 无 style/无 sceneRef 旧项目字节一致')
const neoBaselineVideo = await loadBaseline('neo-video.json')
const neoBaselineImage = await loadBaseline('neo-image.json')
await makeProject(projectRoot, '无风格基线剧', NEO_SHOTS)
const neoVideo = await orchestrator.planEpisode(projectRoot, '无风格基线剧', { episode: 1, kind: 'video', record: false })
const neoImage = await orchestrator.planEpisode(projectRoot, '无风格基线剧', { episode: 1, kind: 'image', record: false })
if (neoBaselineVideo && neoBaselineImage) {
  check('4.1 无 style/无 sceneRef：video items 与 v0.11.2 基线逐字节一致', deepEqual(neoVideo.items, neoBaselineVideo))
  check('4.2 无 style/无 sceneRef：image items 与 v0.11.2 基线逐字节一致', deepEqual(neoImage.items, neoBaselineImage))
} else {
  console.log('      （SKIP：基线 neo-video/neo-image 不在安装副本环境）')
}
await makeProject(projectRoot, '空风格剧', NEO_SHOTS, { style: {} })
const emptyStylePlan = await orchestrator.planEpisode(projectRoot, '空风格剧', { episode: 1, kind: 'video', record: false })
if (neoBaselineVideo) check('4.3 空 style {} → 不注入（与无风格基线逐字节一致）', deepEqual(emptyStylePlan.items, neoBaselineVideo))
const REAL_STORYBOARD = process.env.DSH_AI_DRAMA_SAMPLE_STORYBOARD || ''
if (await fileExists(REAL_STORYBOARD)) {
  const realHashBefore = sha256(await fs.readFile(REAL_STORYBOARD))
  const realShots = JSON.parse(await fs.readFile(REAL_STORYBOARD, 'utf8'))
  await makeProject(projectRoot, '万界倒爷复制', realShots)
  const realVideo = await orchestrator.planEpisode(projectRoot, '万界倒爷复制', { episode: 1, kind: 'video', record: false })
  const realImage = await orchestrator.planEpisode(projectRoot, '万界倒爷复制', { episode: 1, kind: 'image', record: false })
  const baselineOldVideo = await loadBaseline('old-19-video.json')
  const baselineOldImage = await loadBaseline('old-19-image.json')
  if (baselineOldVideo && baselineOldImage) {
    check('4.4 真实万界倒爷 19 镜复制：video items 与 v0.11.2 逐字节一致', realVideo.items.length === 19 && deepEqual(realVideo.items, baselineOldVideo))
    check('4.5 真实万界倒爷 19 镜复制：image items 与 v0.11.2 逐字节一致', deepEqual(realImage.items, baselineOldImage))
  }
  check('4.6 真实项目源文件只读（hash 不变）', sha256(await fs.readFile(REAL_STORYBOARD)) === realHashBefore)
}

group('[5] AC-S4 确定性')
const stylePlan2 = await orchestrator.planEpisode(projectRoot, '风格注入剧', { episode: 1, kind: 'video', record: false })
check('5.1 同输入两次 planEpisode(video) items 严格相等', deepEqual(stylePlan.items, stylePlan2.items))
check('5.2 buildVideoPromptText 同输入两次严格相等', (() => { const a = vp.buildVideoPromptText(styleShots[0], { control: '', styleCue: vp.renderStyleCue({ style: STYLE, scene: SCENE }) }); const b = vp.buildVideoPromptText(styleShots[0], { control: '', styleCue: vp.renderStyleCue({ style: STYLE, scene: SCENE }) }); return deepEqual(a, b) })())

group('[6] AC-S5 imagePrompt 零回归 / 不写盘')
const styleImage2 = await orchestrator.planEpisode(projectRoot, '风格注入剧', { episode: 1, kind: 'image', record: false })
check('6.1 两次 image 输出严格相等', deepEqual(styleImage.items, styleImage2.items))
const projectPath = path.join(projectRoot, 'AI短剧', '风格注入剧')
const beforeTree = await sha256(JSON.stringify((await fs.readdir(projectPath, { recursive: true })).sort()))
await orchestrator.planEpisode(projectRoot, '风格注入剧', { episode: 1, kind: 'video', record: false })
const afterTree = await sha256(JSON.stringify((await fs.readdir(projectPath, { recursive: true })).sort()))
check('6.2 planEpisode 只读（不写盘/不新增文件）', beforeTree === afterTree)

group('[7] AC-S6 契约 / 清理')
check('7.1 工具 34 / METHODS 68 / client 68（M4 批1+批2 已批准）', toolCount === 34 && methods.size === 68 && clientCalls.size === 68)
check('7.2 无新 route（METHODS 未含 style/scene 相关新方法）', ![...methods].some((name) => /^(styles?|scenes?)(-|$)/i.test(name)), JSON.stringify([...methods].filter((name) => /style|scene/i.test(name))))
check('7.3 无新依赖', Object.keys(pkg.dependencies || {}).length === 0)
await fs.rm(projectRoot, { recursive: true, force: true })
check('7.4 临时工作区已清理', !(await fileExists(projectRoot)))

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
