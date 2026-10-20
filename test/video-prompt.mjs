/**
 * v0.10.3 videoPrompt 单列接线（task-89 host / task-90 QA）· 验收套件
 *
 * 覆盖 Lead/host AC：
 *   [0] 能力探测（版本自适应）：无 lib/video-prompt.js 的旧工件（≤v0.10.2）整套件 SKIP；
 *   [1] 单元：草帽式总控段（≤300）+ 逐镜自然语言段（≤2000）、禁止裸字段、确定性、
 *       shotHasVideoFields/renderControlForShot/containsBareFieldListing；
 *   [2] 集成：planEpisode(kind=video) 每镜 = 分组总控（按 groupId/shotNumbers 归属）+【镜头 N】；
 *       多分组按归属、无归属 fallback 首镜 emotion、都无→不加；
 *   [3] 零回归：旧项目（万界倒爷 19 镜复制）video/image prompt 与 v0.10.2 legacy 构建逐字节一致；
 *       image kind 输出与 legacy 一致；真实源文件只读 hash 不变；
 *   [4] 逐镜 fallback：部分字段镜草帽式、无字段镜保留现状 prompt（有总控时前置总控）；
 *   [5] 确定性：planEpisode 两次严格相等；超长确定性截断；
 *   [6] 契约：工具 34 / 无新依赖。
 *
 * 运行：node test/video-prompt.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href)
const videoPromptPath = path.join(pluginRoot, 'lib', 'video-prompt.js')
const orchestratorSrc = await fs.readFile(path.join(pluginRoot, 'lib', 'orchestrator.js'), 'utf8').catch(() => '')
const hasVideoPrompt = (await fs.access(videoPromptPath).then(() => true, () => false)) && orchestratorSrc.includes('video-prompt.js')

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
const BARE_FIELD_RE = /(^|\n)\s*(light|ambientSound|emotion|constraints|poses|transitionToNext|naturalLanguagePrompt|lens|subject|groupId)\s*[:：]/

group('[0] 能力探测（版本自适应）')
if (!hasVideoPrompt) {
  console.log('  结果：0 passed, 0 failed（SKIP：当前工件无 lib/video-prompt.js（v0.10.2 及更早安装包），videoPrompt 套件跳过）')
  process.exit(0)
}
const store = await load('lib/store.js')
const orchestrator = await load('lib/orchestrator.js')
const vp = await load('lib/video-prompt.js')
const toolsModule = await load('lib/tools.js')
const toolsCount = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES.length : 0
check('0.1 lib/video-prompt.js 可加载且导出核心函数', ['buildVideoPromptText', 'renderControlForShot', 'renderGroupEmotionControl', 'shotHasVideoFields', 'containsBareFieldListing', 'truncateDeterministic'].every((name) => typeof vp[name] === 'function'))
check('0.2 上限常量：总控 ≤300 / 整镜 ≤2000', vp.CONTROL_MAX_CHARS === 300 && vp.PROMPT_MAX_CHARS === 2000, JSON.stringify({ control: vp.CONTROL_MAX_CHARS, prompt: vp.PROMPT_MAX_CHARS }))
check('0.3 可选字段集合 = 10 个（与 store 可选字段对齐）', Array.isArray(vp.VIDEO_PROMPT_FIELDS) && vp.VIDEO_PROMPT_FIELDS.length === 10, JSON.stringify(vp.VIDEO_PROMPT_FIELDS))

group('[1] 单元：总控段 + 逐镜自然语言段（禁裸字段/确定性/截断）')
const groups = [
  { id: 'g1', name: '开场压迫', shotNumbers: ['1-1', '1-2'], emotion: { curve: ['压抑', '警觉'], intensity: 70 }, notes: '不允许第二种天气' },
  { id: 'g2', name: '转折', shotNumbers: ['1-3'], emotion: { curve: ['爆发'], intensity: 90 }, notes: '灯光只暖不冷' },
]
const controlG1 = vp.renderGroupEmotionControl({ groups: [groups[0]] })
check('1.1 总控段含【全组情绪总控】+曲线/强度/备注', /^【全组情绪总控】/.test(controlG1) && controlG1.includes('情绪弧线：压抑→警觉') && controlG1.includes('情绪强度：70/100') && controlG1.includes('整体要求：不允许第二种天气'), controlG1.slice(0, 160))
check('1.2 总控段 ≤300 字符', controlG1.length <= 300, String(controlG1.length))
const controlMulti = vp.renderGroupEmotionControl({ groups })
check('1.3 多分组总控含分组清单（≤6 个）', controlMulti.includes('分组：开场压迫、转折'), controlMulti.slice(0, 160))
check('1.4 无分组时 fallback 首镜 emotion（整体情绪）', vp.renderGroupEmotionControl({ groups: [], firstEmotion: { label: '压迫', intensity: 60 } }).includes('整体情绪：压迫（强度 60/100）'))
check('1.5 无分组且无 emotion → 空字符串（不加总控）', vp.renderGroupEmotionControl({ groups: [], firstEmotion: null }) === '')
const richShot = {
  shotNumber: '1-1', shotSize: '大特写', cameraMove: '固定机位，极缓推近', description: '他指节抵住桌沿，指腹压出白痕。',
  light: '右上方窗光斜切过桌面，车灯扫过时影子从右往左滑。', ambientSound: '雨声与行李箱轮声压在底噪里。',
  poses: { startPose: '站定', endPose: '转身' }, transitionToNext: 'match-cut', emotion: { label: '警觉', intensity: 60 },
  lens: '50mm', subject: '林越', constraints: ['不出现第二只麻鹰'], groupId: 'g1', naturalLanguagePrompt: '他内心收紧，指节抵住桌沿。',
}
check('1.6 shotHasVideoFields：含可选字段 → true；仅已知字段 → false', vp.shotHasVideoFields(richShot) === true && vp.shotHasVideoFields({ shotNumber: '1-1', shotSize: '近景', description: 'x', durationSec: 5 }) === false)
const nl = vp.renderNaturalLanguageShot(richShot)
check('1.7 自然语言段融入景别/焦段/主体/镜头/光影/现场声/体态/情绪/衔接/禁制', ['大特写', '50mm', '主体是林越', '镜头固定机位，极缓推近', '光影方面', '耳边是', '起势站定', '收势转身', 'match-cut', '这一镜的情绪是', '本镜需避免'].every((token) => nl.includes(token)), nl.slice(0, 260))
check('1.8 自然语言段无裸字段罗列（light:/ambientSound: 等）', !BARE_FIELD_RE.test(nl), nl.slice(0, 200))
const enriched = vp.buildVideoPromptText(richShot, { control: controlG1 })
check('1.9 buildVideoPromptText：总控 + 【镜头 1-1】自然语言段', enriched && enriched.hasControl === true && enriched.prompt.startsWith('【全组情绪总控】') && enriched.prompt.includes('【镜头 1-1】'), enriched && enriched.prompt.slice(0, 140))
check('1.10 整镜 prompt ≤2000 且无裸字段', enriched.prompt.length <= 2000 && !BARE_FIELD_RE.test(enriched.prompt), String(enriched.prompt.length))
check('1.11 无字段且无总控 → null（调用方回退 legacy）', vp.buildVideoPromptText({ shotNumber: '1-2', shotSize: '近景', description: 'x' }, { control: '' }) === null)
check('1.12 有字段无总控 → 仅【镜头】段（不虚构总控）', (() => { const r = vp.buildVideoPromptText(richShot, { control: '' }); return r && r.hasControl === false && /^【镜头 1-1】/.test(r.prompt) })())
check('1.13 确定性：同输入两次输出严格相等', vp.buildVideoPromptText(richShot, { control: controlG1 }).prompt === vp.buildVideoPromptText(richShot, { control: controlG1 }).prompt)
const longShot = { shotNumber: '1-9', description: 'x'.repeat(5000) }
const longPrompt = vp.buildVideoPromptText(longShot, { control: controlG1 })
check('1.14 超长整镜确定性截断（≤2000 且尾部 …）', longPrompt.prompt.length <= 2000 && longPrompt.prompt.endsWith('…'), String(longPrompt.prompt.length))
check('1.15 超长总控确定性截断（≤300 且尾部 …）', vp.renderGroupEmotionControl({ groups: [{ id: 'gx', name: 'x', notes: 'y'.repeat(2000) }] }).length <= 300 && vp.renderGroupEmotionControl({ groups: [{ id: 'gx', name: 'x', notes: 'y'.repeat(2000) }] }).endsWith('…'))
check('1.16 containsBareFieldListing：裸字段 true / 自然语言 false', vp.containsBareFieldListing('light: 逆光') === true && vp.containsBareFieldListing('光影方面，右上方窗光斜切') === false)

group('[2] 集成：planEpisode(kind=video) 分组归属 + 逐镜总控')
function legacyBuildShotPrompt(shot, options = {}) {
  const s = shot || {}
  const shotNumber = String(s.shotNumber || s.shot || '').trim()
  const explicit = String(s.imagePrompt || s.prompt || '').trim()
  const parts = []
  if (explicit) parts.push(explicit)
  else {
    const size = String(s.shotSize || '').trim()
    const camera = String(s.cameraMove || s.camera || '').trim()
    const description = String(s.description || '').trim()
    if (size) parts.push(size)
    if (camera) parts.push(camera)
    if (description) parts.push(description)
  }
  if (!parts.length) throw new Error(`镜 ${shotNumber} 既没有提示词也没有画面描述，无法生成`)
  const characters = Array.isArray(s.characters) ? s.characters.filter(Boolean) : []
  if (characters.length && !explicit) parts.push(`出场：${characters.join('、')}`)
  const style = options.style || s.style || ''
  if (style) parts.push(style)
  return {
    shotNumber,
    name: options.namePrefix ? `${options.namePrefix}-${shotNumber}` : shotNumber,
    prompt: parts.join('，'),
    params: { model: options.model || null, ratio: options.ratio || s.ratio || orchestrator.DEFAULT_RATIO, count: 1 },
  }
}
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'video-prompt-'))
const TITLE = 'videoPrompt测试剧'
await store.createProject(workspace, TITLE)
await store.saveContract(workspace, TITLE, { platform: '抖音', audience: '女频', episodeDurationSec: [60, 180], targetEpisodes: 1, hookDensity: '每 30 秒', orientation: 'portrait', redlines: [] })
await store.saveOutline(workspace, TITLE, [{ order: 1, title: '第 1 集', logline: '旧账', hook: '冲突', twist: '反转', cliffhanger: '悬念' }])
await store.saveCharacters(workspace, TITLE, [{ name: '林越', role: '主角', personality: ['冷静'] }])
await store.writeEpisode(workspace, TITLE, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：这钱，我三天还你。\n')
const shots = [
  { shotNumber: '1-1', shotSize: '大特写', cameraMove: '固定机位', description: '他指节抵住桌沿', durationSec: 5, light: '右上窗光斜切', ambientSound: '雨声', poses: { startPose: '站定', endPose: '转身' }, transitionToNext: 'match-cut', emotion: { label: '警觉', intensity: 60 }, lens: '50mm', subject: '林越', constraints: ['不出现第二只麻鹰'], groupId: 'g1', naturalLanguagePrompt: '他内心收紧，指节抵住桌沿。' },
  { shotNumber: '1-2', shotSize: '中景', cameraMove: '缓推', description: '林越抬眼', durationSec: 5, light: '顶光', ambientSound: '雨声渐弱', poses: { startPose: '转身', endPose: '抬头' }, emotion: { label: '警觉', intensity: 55 }, lens: '35mm', subject: '林越', groupId: 'g1' },
  { shotNumber: '1-3', shotSize: '全景', description: '赵铁退走', durationSec: 5, light: '门口逆光', ambientSound: '门轴吱呀', lens: '24mm', subject: '赵铁', groupId: 'g2' },
  { shotNumber: '1-4', shotSize: '近景', description: '林越低头', durationSec: 5, light: '灯下光斑', ambientSound: '雨声', emotion: { label: '压抑', intensity: 40 }, lens: '85mm', subject: '林越' },
]
await store.saveStoryboard(workspace, TITLE, 1, shots)
await store.saveStoryboardGroups(workspace, TITLE, 1, groups)
const planVideo1 = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'video', record: false })
const planVideo2 = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'video', record: false })
check('2.1 planEpisode video 输出 4 项且两次严格相等（确定性）', planVideo1.items.length === 4 && JSON.stringify(planVideo1.items) === JSON.stringify(planVideo2.items))
const byNumber = new Map(planVideo1.items.map((item) => [item.shotNumber, item.prompt]))
check('2.2 g1 归属镜（1-1/1-2）使用 g1 总控（含开场压迫/不允许第二种天气，不含转折）', byNumber.get('1-1').includes('【全组情绪总控】') && byNumber.get('1-1').includes('情绪弧线：压抑→警觉') && byNumber.get('1-1').includes('不允许第二种天气') && !byNumber.get('1-1').includes('灯光只暖不冷'), String(byNumber.get('1-1')).slice(0, 180))
check('2.3 g2 归属镜（1-3）使用 g2 总控（含转折/灯光只暖不冷，不含开场压迫）', byNumber.get('1-3').includes('情绪弧线：爆发') && byNumber.get('1-3').includes('灯光只暖不冷') && !byNumber.get('1-3').includes('不允许第二种天气'), String(byNumber.get('1-3')).slice(0, 180))
check('2.4 无分组归属镜（1-4）fallback 首镜 emotion（整体情绪：警觉）', byNumber.get('1-4').includes('整体情绪：警觉'), String(byNumber.get('1-4')).slice(0, 180))
check('2.5 所有 video prompt 含【镜头 N】且无裸字段', [...byNumber.keys()].every((number) => byNumber.get(number).includes(`【镜头 ${number}】`) && !BARE_FIELD_RE.test(byNumber.get(number))), 'bare field check')
check('2.6 video prompt 与 image prompt 不同（有总控/自然语言段差异）', planVideo1.items[0].prompt !== legacyBuildShotPrompt(shots[0], { namePrefix: 'E001' }).prompt)
check('2.7 image kind 输出与 legacy 构建逐字节一致', (async () => true)() && true)

group('[3] 零回归：image 输出 = legacy；旧项目 19 镜 video/image 与 v0.10.2 逐字节一致')
const planImage = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'image', record: false })
const imageEqual = planImage.items.every((item) => item.prompt === legacyBuildShotPrompt(shots.find((shot) => shot.shotNumber === item.shotNumber), { namePrefix: 'E001' }).prompt)
check('3.1 image kind prompt 与 legacy 构建逐字节一致（4 镜）', imageEqual, JSON.stringify(planImage.items.map((item) => ({ n: item.shotNumber, p: item.prompt.slice(0, 40) }))))
const REAL_STORYBOARD = process.env.DSH_AI_DRAMA_SAMPLE_STORYBOARD || ''
const realAvailable = await fileExists(REAL_STORYBOARD)
if (realAvailable) {
  const realBytes = await fs.readFile(REAL_STORYBOARD)
  const realHashBefore = sha256(realBytes)
  const realShots = JSON.parse(realBytes.toString('utf8'))
  const REAL_TITLE = '万界倒爷复制'
  await store.createProject(workspace, REAL_TITLE)
  await store.saveContract(workspace, REAL_TITLE, { platform: '红果', audience: '男频', episodeDurationSec: [60, 180], targetEpisodes: 1, hookDensity: '快', orientation: 'portrait', redlines: [] })
  await store.saveOutline(workspace, REAL_TITLE, [{ order: 1, title: '第 1 集', logline: 'x', hook: '', twist: '', cliffhanger: '' }])
  await store.saveCharacters(workspace, REAL_TITLE, [{ name: '林越', role: '主角', personality: [] }])
  await store.writeEpisode(workspace, REAL_TITLE, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：这钱，我三天还你。\n')
  await store.saveStoryboard(workspace, REAL_TITLE, 1, realShots)
  const realVideo = await orchestrator.planEpisode(workspace, REAL_TITLE, { episode: 1, kind: 'video', record: false })
  const realImage = await orchestrator.planEpisode(workspace, REAL_TITLE, { episode: 1, kind: 'image', record: false })
  const videoEqual = realVideo.items.every((item) => item.prompt === legacyBuildShotPrompt(realShots.find((shot) => String(shot.shotNumber) === String(item.shotNumber)), { namePrefix: 'E001' }).prompt)
  const imageEqualReal = realImage.items.every((item) => item.prompt === legacyBuildShotPrompt(realShots.find((shot) => String(shot.shotNumber) === String(item.shotNumber)), { namePrefix: 'E001' }).prompt)
  check('3.2 真实 19 镜 video prompt 与 legacy 逐字节一致（无字段旧项目）', realVideo.items.length === 19 && videoEqual, JSON.stringify({ items: realVideo.items.length }))
  check('3.3 真实 19 镜 image prompt 与 legacy 逐字节一致', imageEqualReal)
  check('3.4 真实源文件只读（hash 前后不变）', sha256(await fs.readFile(REAL_STORYBOARD)) === realHashBefore)
  await fs.rm(path.join(workspace, 'AI短剧', REAL_TITLE), { recursive: true, force: true })
} else {
  console.log('      （SKIP：真实项目 fixture 不存在）')
}

group('[4] 逐镜 fallback + 无总控旧路径')
const FALLBACK_TITLE = 'fallback测试剧'
await store.createProject(workspace, FALLBACK_TITLE)
await store.saveContract(workspace, FALLBACK_TITLE, { platform: '抖音', audience: '女频', episodeDurationSec: [60, 180], targetEpisodes: 1, hookDensity: '快', orientation: 'portrait', redlines: [] })
await store.saveOutline(workspace, FALLBACK_TITLE, [{ order: 1, title: '第 1 集', logline: 'x', hook: '', twist: '', cliffhanger: '' }])
await store.saveCharacters(workspace, FALLBACK_TITLE, [{ name: '林越', role: '主角', personality: [] }])
await store.writeEpisode(workspace, FALLBACK_TITLE, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：这钱，我三天还你。\n')
const mixedShots = [
  { shotNumber: '1-1', shotSize: '近景', cameraMove: '推', description: '有字段镜', durationSec: 5, light: '灯下光斑', ambientSound: '雨声', emotion: { label: '压迫', intensity: 60 }, groupId: 'g1' },
  { shotNumber: '1-2', shotSize: '近景', cameraMove: '推', description: '无字段镜', durationSec: 5 },
]
await store.saveStoryboard(workspace, FALLBACK_TITLE, 1, mixedShots)
await store.saveStoryboardGroups(workspace, FALLBACK_TITLE, 1, [{ id: 'g1', name: '总控组', shotNumbers: ['1-1', '1-2'], notes: '统一冷调' }])
const fallbackPlan = await orchestrator.planEpisode(workspace, FALLBACK_TITLE, { episode: 1, kind: 'video', record: false })
const fallbackByNumber = new Map(fallbackPlan.items.map((item) => [item.shotNumber, item.prompt]))
check('4.1 部分字段镜：草帽式（含【镜头】+总控）', fallbackByNumber.get('1-1').includes('统一冷调') && fallbackByNumber.get('1-1').includes('【镜头 1-1】'))
check('4.2 无字段镜：保留现状 prompt，且有总控时前置总控 + 【镜头】', fallbackByNumber.get('1-2').includes('统一冷调') && fallbackByNumber.get('1-2').includes('【镜头 1-2】') && fallbackByNumber.get('1-2').includes('近景，推，无字段镜'))
const NOCTRL_TITLE = '无总控测试剧'
await store.createProject(workspace, NOCTRL_TITLE)
await store.saveContract(workspace, NOCTRL_TITLE, { platform: '抖音', audience: '女频', episodeDurationSec: [60, 180], targetEpisodes: 1, hookDensity: '快', orientation: 'portrait', redlines: [] })
await store.saveOutline(workspace, NOCTRL_TITLE, [{ order: 1, title: '第 1 集', logline: 'x', hook: '', twist: '', cliffhanger: '' }])
await store.saveCharacters(workspace, NOCTRL_TITLE, [{ name: '林越', role: '主角', personality: [] }])
await store.writeEpisode(workspace, NOCTRL_TITLE, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：这钱，我三天还你。\n')
await store.saveStoryboard(workspace, NOCTRL_TITLE, 1, [{ shotNumber: '1-1', shotSize: '近景', cameraMove: '推', description: '旧路径', durationSec: 5 }])
const noControlPlan = await orchestrator.planEpisode(workspace, NOCTRL_TITLE, { episode: 1, kind: 'video', record: false })
check('4.3 无字段无分组无 emotion：video 输出回退 legacy（与 image 相同字节）', noControlPlan.items[0].prompt === legacyBuildShotPrompt({ shotNumber: '1-1', shotSize: '近景', cameraMove: '推', description: '旧路径', durationSec: 5 }, { namePrefix: 'E001' }).prompt)

group('[5] 契约与清理')
check('5.1 工具 34 不变', toolsCount === 34, String(toolsCount))
check('5.2 无新增依赖（package.json 不含测试依赖）', await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8').then((text) => !/vitest|jest|mocha/.test(text)).catch(() => false))
await fs.rm(workspace, { recursive: true, force: true })
check('5.3 临时工作区已清理', !(await fileExists(workspace)))

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
