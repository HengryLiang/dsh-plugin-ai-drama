/**
 * 阶段二 · 生成编排自测（FR-G02 / FR-G03 / FR-G04）
 * 全部用假后端与临时工作区，不联网、不消耗积分。
 * 运行：node test/orchestrator.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = (rel) => import(pathToFileURL(path.join(here, '..', 'lib', rel)).href)
const store = await load('store.js')
const generation = await load('generation.js')
const orchestrator = await load('orchestrator.js')
const exporter = await load('exporter.js')

let passed = 0
let failed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) passed += 1
  else {
    failed += 1
    failures.push(`${label}${detail ? ' -> ' + detail : ''}`)
    console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`)
  }
}
function group(name) {
  console.log('\n' + name)
}

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-orch-'))
const TITLE = '编排测试剧'
await store.createProject(workspace, TITLE)
await store.saveStoryboard(workspace, TITLE, 1, [
  { shotNumber: '1-1', shotSize: '特写', cameraMove: '推', description: '刀锋贴颈', sfx: '金属摩擦', durationSec: 3, imagePrompt: '雨夜，刀锋贴颈，冷光' },
  { shotNumber: '1-2', shotSize: '中景', cameraMove: '摇', description: '林越被按在柜台上', durationSec: 4 },
  { shotNumber: '1-3', shotSize: '远景', description: '巷口雨幕', durationSec: 5 },
])
await store.writeEpisode(workspace, TITLE, 1, [
  '# 第001集', '',
  '## 场景 1：内景 - 当铺 - 夜', '',
  '林越：这钱我三天还你。', '',
  '赵铁：三天？我明天来收尸。', '',
].join('\n'))

/* ------------------------------------------------------------------ [1] */
group('[1] 逐镜提示词构造')
// 分镜表真实字段名是 imagePrompt / cameraMove（见 store.js 的 shot 归一化）
const p1 = orchestrator.buildShotPrompt({ shotNumber: '1-1', imagePrompt: '雨夜，刀锋贴颈' })
check('自带提示词优先（imagePrompt）', p1.prompt === '雨夜，刀锋贴颈', p1.prompt)
check('兼容 prompt 别名', orchestrator.buildShotPrompt({ shotNumber: '1-1', prompt: 'x' }).prompt === 'x')
check('默认竖屏 9:16', p1.params.ratio === '9:16', p1.params.ratio)
check('单张 count=1', p1.params.count === 1)

const p2 = orchestrator.buildShotPrompt({ shotNumber: '1-2', shotSize: '中景', cameraMove: '摇', description: '林越被按在柜台上' })
check('无提示词时按景别+运镜+画面拼', p2.prompt === '中景，摇，林越被按在柜台上', p2.prompt)
check('兼容 camera 别名', orchestrator.buildShotPrompt({ shotNumber: '1-2', shotSize: '中景', camera: '推', description: 'x' }).prompt === '中景，推，x')

const p3 = orchestrator.buildShotPrompt({ shotNumber: '1-3', shotSize: '远景' }, { style: '港片质感', ratio: '16:9' })
check('追加风格', p3.prompt.includes('港片质感'), p3.prompt)
check('可覆盖画幅', p3.params.ratio === '16:9')

const p4 = orchestrator.buildShotPrompt({ shotNumber: '1-4', shotSize: '特写', characters: ['林越', '赵铁'] })
check('自动带出场角色', p4.prompt.includes('出场：林越、赵铁'), p4.prompt)

check('缺镜号抛错', (() => {
  try { orchestrator.buildShotPrompt({}); return false } catch { return true }
})())
check('既无提示词也无画面时抛错', (() => {
  try { orchestrator.buildShotPrompt({ shotNumber: '9-9' }); return false } catch { return true }
})())
check('名称前缀生效', orchestrator.buildShotPrompt({ shotNumber: '1-1', prompt: 'x' }, { namePrefix: 'E001' }).name === 'E001-1-1')

/* ------------------------------------------------------------------ [2] */
group('[2] 选镜')
const shots = [
  { shotNumber: '1-1' },
  { shotNumber: '1-2' },
  { shotNumber: '1-3' },
]
check('不传则全选', orchestrator.selectShots(shots, null).length === 3)
check('按镜号筛选', orchestrator.selectShots(shots, ['1-2']).length === 1)
check('多镜筛选', orchestrator.selectShots(shots, ['1-1', '1-3']).length === 2)
check('空数组视为全选', orchestrator.selectShots(shots, []).length === 3)
check('不存在的镜号筛掉', orchestrator.selectShots(shots, ['9-9']).length === 0)

/* ------------------------------------------------------------------ [3] */
group('[3] 批次规划（只规划不触发）')
const plan = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'image', backend: 'libtv', model: 'Lib Image 2.5 Pro' })
check('规划整集 3 镜', plan.count === 3 && plan.items.length === 3, String(plan.count))
check('逐镜构造提示词', plan.items[1].prompt === '中景，摇，林越被按在柜台上', plan.items[1].prompt)
check('登记了 3 条任务', plan.tasks.length === 3)
check('任务与镜号对应', plan.tasks[0].shot === '1-1', plan.tasks[0].shot)
check('预算未设上限时放行', plan.quota.ok === true && plan.quota.limited === false, JSON.stringify(plan.quota).slice(0, 120))
check('标签可读', plan.label === '分镜图', plan.label)

const planShot = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'image', backend: 'libtv', shots: ['1-2'] })
check('只规划指定镜', planShot.count === 1 && planShot.items[0].shotNumber === '1-2')

const none = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'image', backend: 'libtv', record: false })
check('record=false 时不落任务', none.tasks.length === 0 && none.count === 3)

check('没有分镜的集报错', await (async () => {
  try { await orchestrator.planEpisode(workspace, TITLE, { episode: 9, kind: 'image', backend: 'libtv' }); return false } catch { return true }
})())
check('缺集数报错', await (async () => {
  try { await orchestrator.planEpisode(workspace, TITLE, { kind: 'image', backend: 'libtv' }); return false } catch { return true }
})())
check('非法 kind 报错', await (async () => {
  try { await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'sticker', backend: 'libtv' }); return false } catch { return true }
})())

/* ------------------------------------------------------------------ [4] */
group('[4] 预算闸门')
await generation.setBudgetLimit(workspace, TITLE, 100)
const gated = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'image', backend: 'libtv', estimatePerUnitPoints: 50 })
check('超预算时闸门关闭', gated.quota.ok === false, JSON.stringify(gated.quota).slice(0, 140))
check('闸门说明指出超出', String(gated.quota.detail).includes('超出'), gated.quota.detail)
check('仍产出计划供用户判断', gated.count === 3)
await generation.setBudgetLimit(workspace, TITLE, null)

/* ------------------------------------------------------------------ [5] */
group('[5] 提交批次（单镜失败不影响其余）')
const planSub = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'image', backend: 'fake' })
const calls = []
const fakeBackend = {
  id: 'fake',
  async generate(input) {
    calls.push(input)
    if (input.name.endsWith('1-2')) throw new Error('模型不可用')
    return { ok: true, raw: { nodeKey: 'n-' + input.name } }
  },
}
const submitted = await orchestrator.submitBatch(workspace, TITLE, {
  backend: 'fake',
  kind: 'image',
  items: planSub.items.map((it, i) => ({ ...it, taskId: planSub.tasks[i].id })),
  resolveBackend: () => fakeBackend,
})
check('三镜都发起了调用', calls.length === 3, String(calls.length))
check('成功 2 失败 1', submitted.submitted === 2 && submitted.failed === 1, JSON.stringify({ s: submitted.submitted, f: submitted.failed }))
const failItem = submitted.results.find((r) => !r.ok)
check('失败项带原因', String(failItem.error).includes('模型不可用'), failItem.error)
check('失败任务状态为 failed', failItem.task.status === 'failed')
const okItem = submitted.results.find((r) => r.ok)
check('成功任务状态为 submitted', okItem.task.status === 'submitted')
check('记录了平台节点 id', okItem.task.externalId === 'n-' + okItem.node, okItem.task.externalId)

check('未知后端报错', await (async () => {
  try { await orchestrator.submitBatch(workspace, TITLE, { backend: 'x', items: [], resolveBackend: () => null }); return false } catch { return true }
})())

/* ------------------------------------------------------------------ [6] */
group('[6] 收敛批次')
// 逐任务收敛，避免受"当前哪些任务在途"的影响
const submittedTasks = (await generation.listTasks(workspace, TITLE, { limit: 1000 })).filter((t) => t.status === 'submitted')
check('在途任务数为 2（1-2 提交时已失败）', submittedTasks.length === 2, String(submittedTasks.length))
const targetTask = submittedTasks[0]
const otherTask = submittedTasks[1]

const outDir = path.join(store.projectDir(workspace, TITLE), '素材', '生成')
await fs.mkdir(outDir, { recursive: true })
const artifact = 'E001-1-1.png'

const pendingBackend = {
  id: 'fake',
  async nodeDetail() { return { state: 'pending' } },
  async download() { return { ok: true, files: [] } },
}
const collected0 = await orchestrator.collectBatch(workspace, TITLE, { backend: 'fake', taskIds: [targetTask.id], resolveBackend: () => pendingBackend })
check('未产出时留在 pending', collected0.collected === 0 && collected0.pending === 1, JSON.stringify({ c: collected0.collected, p: collected0.pending }))
check('未产出时不改动任务状态', (await generation.listTasks(workspace, TITLE, { limit: 1000 })).find((t) => t.id === targetTask.id).status === 'submitted')

const doneBackend = {
  id: 'fake',
  async nodeDetail() { return { state: 'done', urls: ['https://example.invalid/a.png'] } },
  async download({ outDir: dir }) {
    await fs.writeFile(path.join(dir, artifact), Buffer.from('fake-png'))
    return { ok: true, files: [path.join(dir, artifact)] }
  },
}
const collected1 = await orchestrator.collectBatch(workspace, TITLE, { backend: 'fake', taskIds: [targetTask.id], resolveBackend: () => doneBackend })
check('已产出时收敛成功', collected1.collected === 1, JSON.stringify(collected1.details).slice(0, 160))
check('产物落到素材/生成/', collected1.details.collected[0].files[0].includes('素材'), collected1.details.collected[0].files[0])
check('另一任务不受影响', (await generation.listTasks(workspace, TITLE, { limit: 1000 })).find((t) => t.id === otherTask.id).status === 'submitted')

const tasksAfter = await generation.listTasks(workspace, TITLE, { limit: 1000 })
const doneTask = tasksAfter.find((t) => t.id === targetTask.id)
check('任务被标记完成', doneTask.status === 'done', doneTask.status)
check('任务记录了产物', doneTask.artifacts.length === 1, JSON.stringify(doneTask.artifacts).slice(0, 120))

const assets = await store.getAssets(workspace, TITLE)
check('产物进入素材库', assets.length === 1, String(assets.length))
check('标记为生成物', assets[0].origin === 'generated', assets[0].origin)
check('带上关联镜号与任务', assets[0].taskId === doneTask.id, JSON.stringify({ t: assets[0].taskId, s: assets[0].linkedShots }))
check('关联到该任务的镜号', assets[0].linkedShots.join(',') === doneTask.shots.join(','), JSON.stringify(assets[0].linkedShots))

const failedBackend = {
  id: 'fake',
  async nodeDetail() { return { state: 'failed', message: '内容不合规' } },
  async download() { return { ok: true, files: [] } },
}
const collectedF = await orchestrator.collectBatch(workspace, TITLE, { backend: 'fake', taskIds: [otherTask.id], resolveBackend: () => failedBackend })
check('平台报错时标记失败', collectedF.failed === 1, JSON.stringify(collectedF.details).slice(0, 160))
check('失败原因被记录', String(collectedF.details.failed[0].error).includes('内容不合规'), collectedF.details.failed[0].error)
check('返回当前预算', typeof collectedF.budget.spentPoints === 'number')

/* ------------------------------------------------------------------ [7] */
group('[7] v0.10.0 未知字段保留 + typed 可选字段（task-83/84 + 0-4a，版本自适应）')
// 版本自适应（双工件：源码 0-4a / rc2 task-83 / v0.9.2 旧工件）：
//   ① 未知字段保留能力：写一条含自定义字段的镜 → 回读判断是否保留（动态探测，不依赖版本号）；
//   ② typed 可选字段能力：store 是否导出 SHOT_OPTIONAL_FIELDS（0-4a 起）。
const TYPED_SHOT_FIELDS = Array.isArray(store.SHOT_OPTIONAL_FIELDS) ? store.SHOT_OPTIONAL_FIELDS : []
const hasTypedShotFields = TYPED_SHOT_FIELDS.length > 0
const capabilityTitle = '能力探测剧'
await store.createProject(workspace, capabilityTitle)
let supportsUnknownMerge = false
try {
  await store.saveStoryboard(workspace, capabilityTitle, 1, [{ shotNumber: '1-1', shotSize: '近景', description: '探针', durationSec: 6, capabilityProbe: 'keep-me' }])
  const probeRaw = JSON.parse(await fs.readFile(path.join(workspace, 'AI短剧', capabilityTitle, '.aidrama', 'storyboard', '第001集.md.json'), 'utf8'))
  const probeShots = Array.isArray(probeRaw) ? probeRaw : probeRaw.shots
  supportsUnknownMerge = Boolean(probeShots[0] && Object.prototype.hasOwnProperty.call(probeShots[0], 'capabilityProbe'))
} catch {
  supportsUnknownMerge = false
}
console.log('      版本自适应：未知字段保留 = ' + (supportsUnknownMerge ? '支持' : '不支持（旧工件，task-83 断言 SKIP）') + '；typed 可选字段 = ' + (hasTypedShotFields ? TYPED_SHOT_FIELDS.length + ' 个' : '无（旧工件，typed 断言 SKIP）'))

if (supportsUnknownMerge) {
  const unknownTitle = '未知字段保留剧'
  await store.createProject(workspace, unknownTitle)
  // valid emotion 形状对两版兼容：typed 版 emotion={label,intensity}；task-83 版按任意未知字段原样保留
  const unknownShotFields = {
    emotion: { label: '压迫', intensity: 40 },
    light: '灯下光斑随人影移动',
    poses: { startPose: '站立·左手持簪', endPose: '转身·空手' },
    customKey: { nested: ['keep-me'], count: 2 },
    ambientSound: '雨打窗、门轴吱呀',
  }
  await store.saveStoryboard(workspace, unknownTitle, 1, [
    { shotNumber: '1-1', shotSize: '近景', cameraMove: '推', description: '赵铁拍桌', durationSec: 6, ...unknownShotFields },
    { shotNumber: '1-2', shotSize: '中景', description: '林越抬眼', durationSec: 5 },
  ])
  const unknownDiskPath = path.join(workspace, 'AI短剧', unknownTitle, '.aidrama', 'storyboard', '第001集.md.json')
  const readUnknownDisk = async () => {
    const raw = JSON.parse(await fs.readFile(unknownDiskPath, 'utf8'))
    return Array.isArray(raw) ? raw : raw.shots
  }
  const diskUnknown1 = await readUnknownDisk()
  check('task-83：保存后磁盘保留 per-shot 字段（emotion/light/poses/customKey/ambientSound）', ['emotion', 'light', 'poses', 'customKey', 'ambientSound'].every((key) => Object.prototype.hasOwnProperty.call(diskUnknown1[0], key)), JSON.stringify(Object.keys(diskUnknown1[0])))
  check('task-83：字段嵌套对象/数组原样保留（两版一致）', JSON.stringify(diskUnknown1[0].emotion) === JSON.stringify(unknownShotFields.emotion) && JSON.stringify(diskUnknown1[0].customKey) === JSON.stringify(unknownShotFields.customKey) && JSON.stringify(diskUnknown1[0].poses) === JSON.stringify(unknownShotFields.poses), JSON.stringify({ emotion: diskUnknown1[0].emotion, customKey: diskUnknown1[0].customKey }).slice(0, 240))
  check('task-83：已知字段正常归一化（description/durationSec）', diskUnknown1[0].description === '赵铁拍桌' && diskUnknown1[0].durationSec === 6, JSON.stringify({ d: diskUnknown1[0].description, dur: diskUnknown1[0].durationSec }))
  const unknownEdited = diskUnknown1.map((shot, index) => (index === 0 ? { ...shot, description: '赵铁拍桌（改）' } : { ...shot }))
  await store.saveStoryboard(workspace, unknownTitle, 1, unknownEdited)
  const diskUnknown2 = await readUnknownDisk()
  check('task-83：读→改已知字段→写 后未知/typed 字段仍保留', diskUnknown2[0].description === '赵铁拍桌（改）' && JSON.stringify(diskUnknown2[0].emotion) === JSON.stringify(unknownShotFields.emotion) && JSON.stringify(diskUnknown2[0].poses) === JSON.stringify(unknownShotFields.poses) && JSON.stringify(diskUnknown2[0].customKey) === JSON.stringify(unknownShotFields.customKey), JSON.stringify(diskUnknown2[0]).slice(0, 260))
  const memoryUnknown = await store.getStoryboard(workspace, unknownTitle, 1)
  check('task-83：getStoryboard 回读同样保留字段', JSON.stringify(memoryUnknown[0].emotion) === JSON.stringify(unknownShotFields.emotion) && JSON.stringify(memoryUnknown[0].light) === JSON.stringify(unknownShotFields.light), JSON.stringify(memoryUnknown[0]).slice(0, 220))
  await store.saveStoryboard(workspace, unknownTitle, 1, [{ shotNumber: '1-1', shotSize: '近景', description: '边界', durationSec: 6, customEmpty: {}, customArr: [] }])
  const diskUnknown3 = await readUnknownDisk()
  check('task-83：未知字段空对象/空数组原样保留（不删除、不转义）', JSON.stringify(diskUnknown3[0].customEmpty) === '{}' && Array.isArray(diskUnknown3[0].customArr) && diskUnknown3[0].customArr.length === 0, JSON.stringify(diskUnknown3[0]))
  check('task-83：无未知字段的旧分镜保存不产生垃圾键', !Object.prototype.hasOwnProperty.call(diskUnknown3[0], 'customKey') && !Object.prototype.hasOwnProperty.call(diskUnknown3[0], 'emotion'), JSON.stringify(Object.keys(diskUnknown3[0])))
} else {
  console.log('      （SKIP：当前工件不支持未知字段保留（如 v0.9.2 安装副本），task-83 相关断言跳过；源码树/rc2 自动生效）')
}

if (hasTypedShotFields) {
  // 0-4a typed 可选字段：合法 10 字段读写 + 空值省略 + 7 类非法→invalid-args
  const typedTitle = 'typed字段剧'
  await store.createProject(workspace, typedTitle)
  const typedShot = {
    shotNumber: '1-1', shotSize: '特写', cameraMove: '推', description: 'typed 字段', durationSec: 6,
    emotion: { label: '压迫', intensity: 40 }, light: '灯下光斑随人影移动', ambientSound: '雨打窗、门轴吱呀',
    constraints: ['不出现血腥', '不出现真实品牌'], poses: { startPose: '站立', endPose: '转身' },
    transitionToNext: 'match-cut', naturalLanguagePrompt: '镜头从手部推到面部', lens: '85mm', subject: '林越', groupId: 'G1', sceneRef: 'SPC001',
  }
  await store.saveStoryboard(workspace, typedTitle, 1, [typedShot, { shotNumber: '1-2', shotSize: '中景', description: '普通', durationSec: 5 }])
  const typedRaw = JSON.parse(await fs.readFile(path.join(workspace, 'AI短剧', typedTitle, '.aidrama', 'storyboard', '第001集.md.json'), 'utf8'))
  const typedShots = Array.isArray(typedRaw) ? typedRaw : typedRaw.shots
  const typedFirst = typedShots[0]
  check('0-4a：11 个 typed 可选字段全部写入磁盘（含 sceneRef）', TYPED_SHOT_FIELDS.length === 11 && TYPED_SHOT_FIELDS.includes('sceneRef') && TYPED_SHOT_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(typedFirst, field)), JSON.stringify(Object.keys(typedFirst)))
  check('0-4a：emotion={label,intensity} 归一化正确', typedFirst.emotion && typedFirst.emotion.label === '压迫' && typedFirst.emotion.intensity === 40, JSON.stringify(typedFirst.emotion))
  check('0-4a：poses/constraints/transitionToNext/lens/subject/groupId 值正确', typedFirst.poses.startPose === '站立' && typedFirst.poses.endPose === '转身' && typedFirst.constraints.join('|') === '不出现血腥|不出现真实品牌' && typedFirst.transitionToNext === 'match-cut' && typedFirst.lens === '85mm' && typedFirst.subject === '林越' && typedFirst.groupId === 'G1', JSON.stringify({ poses: typedFirst.poses, constraints: typedFirst.constraints, transition: typedFirst.transitionToNext, lens: typedFirst.lens, subject: typedFirst.subject, groupId: typedFirst.groupId }).slice(0, 260))
  await store.saveStoryboard(workspace, typedTitle, 1, [{ shotNumber: '1-1', shotSize: '近景', description: '空值', durationSec: 6, emotion: null, light: '   ', constraints: [], poses: { startPose: '', endPose: '' }, transitionToNext: '' }])
  const emptyRaw = JSON.parse(await fs.readFile(path.join(workspace, 'AI短剧', typedTitle, '.aidrama', 'storyboard', '第001集.md.json'), 'utf8'))
  const emptyShots = Array.isArray(emptyRaw) ? emptyRaw : emptyRaw.shots
  check('0-4a：typed 字段空值/未提供不写入（emotion/light/constraints/poses/transitionToNext 省略）', ['emotion', 'light', 'constraints', 'poses', 'transitionToNext'].every((field) => !Object.prototype.hasOwnProperty.call(emptyShots[0], field)), JSON.stringify(Object.keys(emptyShots[0])))
  const invalidCases = [
    ['emotion 缺 label', { emotion: { label: '', intensity: 10 } }],
    ['emotion.intensity 越界', { emotion: { label: '压迫', intensity: 150 } }],
    ['transitionToNext 非枚举', { transitionToNext: 'fade' }],
    ['constraints 非数组', { constraints: '不是数组' }],
    ['poses 非对象', { poses: '不是对象' }],
    ['emotion 非对象', { emotion: 42 }],
    ['groupId 非字符串', { groupId: 42 }],
    ['sceneRef 非法', { sceneRef: 'SPC1' }],
  ]
  let invalidPass = 0
  const invalidDetails = []
  for (const [label, patch] of invalidCases) {
    try {
      await store.saveStoryboard(workspace, typedTitle, 1, [{ shotNumber: '1-1', shotSize: '近景', description: '非法', durationSec: 6, ...patch }])
      invalidDetails.push(label + ':未抛错')
    } catch (error) {
      const code = error && error.code
      const message = String(error && error.message)
      if (code === 'invalid-args' || /invalid|必须|只能是|必须是|上限|不超过/.test(message)) { invalidPass += 1 } else { invalidDetails.push(label + ':' + code + '/' + message.slice(0, 60)) }
    }
  }
  check('0-4a：非法 typed 值（含 sceneRef）→ invalid-args（不静默吞掉）', invalidPass === invalidCases.length, JSON.stringify(invalidDetails))
} else {
  console.log('      （SKIP：当前工件无 0-4a typed 可选字段（如 rc2 安装包/v0.9.2），typed 断言跳过；源码树自动生效）')
}

/* ------------------------------------------------------------------ [8] */
group('[8] v0.10.0 0-4a 导出 add-only + 0-4b groups sidecar（版本自适应）')
const hasGroupsApi = typeof store.saveStoryboardWithGroups === 'function' && typeof store.getStoryboardGroups === 'function'
const hasCsvBuilder = typeof exporter.buildStoryboardCsv === 'function'
const OPTIONAL_HEADERS = ['情绪', '光影', '现场声', '禁令', '起止姿态', '衔接', '自然语言段', '焦段', '主体', '分组']
const typedTitle2 = '导出addonly剧'
await store.createProject(workspace, typedTitle2)
const typedShotsExport = [
  { shotNumber: '1-1', shotSize: '近景', cameraMove: '推', description: '赵铁拍桌', dialogue: '赵铁：还钱。', durationSec: 6, emotion: { label: '压迫', intensity: 40 }, light: '灯下光斑', ambientSound: '雨声', groupId: 'g1' },
  { shotNumber: '1-2', shotSize: '中景', description: '林越抬眼', durationSec: 5 },
]
await store.saveStoryboard(workspace, typedTitle2, 1, typedShotsExport)
await store.writeEpisode(workspace, typedTitle2, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n赵铁：还钱。\n林越：三天后你来拿钱。\n')
if (hasCsvBuilder) {
  const typedCsv = await exporter.buildStoryboardCsv(workspace, typedTitle2)
  const typedHeader = String(typedCsv).split(/\r?\n/)[0].split(',')
  if (hasTypedShotFields) {
    check('0-4a 导出：CSV 表头 21 列不变（sceneRef 不参与导出列，可选列固定 10）', typedHeader.length === 21, String(typedHeader.length))
    check('0-4a 导出：CSV 含可选列（情绪/光影/现场声/分组等）', OPTIONAL_HEADERS.every((header) => typedHeader.includes(header)), JSON.stringify(typedHeader))
  } else {
    console.log('      （SKIP：旧工件无 typed 可选字段，导出 add-only 列断言跳过）')
  }
} else {
  console.log('      （SKIP：exporter.buildStoryboardCsv 不可用）')
}
if (hasGroupsApi) {
  const groupsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-groups-'))
  const groupsTitle = '分组sidecar剧'
  await store.createProject(groupsRoot, groupsTitle)
  await store.saveStoryboard(groupsRoot, groupsTitle, 1, [
    { shotNumber: '1-1', shotSize: '中景', shotSize: '中景', cameraMove: '固定', description: '甲', durationSec: 5, groupId: 'g1' },
    { shotNumber: '1-2', shotSize: '近景', cameraMove: '拉', description: '乙', durationSec: 4, groupId: 'g1' },
    { shotNumber: '1-3', shotSize: '全景', description: '丙', durationSec: 6, groupId: 'g2' },
  ])
  const groupsFile = path.join(groupsRoot, 'AI短剧', groupsTitle, '.aidrama', 'storyboard-groups', '第001集.md.json')
  const storyboardFile = path.join(groupsRoot, 'AI短剧', groupsTitle, '.aidrama', 'storyboard', '第001集.md.json')
  const groupsData = [
    { id: 'g1', name: '开场压迫', shotNumbers: ['1-1', '1-2'], emotion: { curve: ['压抑', '警觉'], intensity: 70 }, durationTargetSec: 9, notes: '不允许第二种天气' },
    { id: 'g2', name: '转折', shotNumbers: ['1-3'], durationTargetSec: 6 },
  ]
  check('0-4b：初始无 sidecar → getStoryboardGroups 返回 null（旧项目兼容）', (await store.getStoryboardGroups(groupsRoot, groupsTitle, 1)) === null)
  const savedGroups = await store.saveStoryboardGroups(groupsRoot, groupsTitle, 1, groupsData)
  check('0-4b：保存分组返回归一结果（2 组/情绪强度 70）', Array.isArray(savedGroups) && savedGroups.length === 2 && savedGroups[0].emotion.intensity === 70, JSON.stringify(savedGroups).slice(0, 200))
  const diskGroups = JSON.parse(await fs.readFile(groupsFile, 'utf8'))
  check('0-4b：sidecar 落盘 .aidrama/storyboard-groups/<集>.json（schemaVersion/episode/groups）', diskGroups.schemaVersion === 1 && diskGroups.episode === 1 && Array.isArray(diskGroups.groups) && diskGroups.groups.length === 2, JSON.stringify(Object.keys(diskGroups)))
  const readBackGroups = await store.getStoryboardGroups(groupsRoot, groupsTitle, 1)
  check('0-4b：回读分组内容一致', Array.isArray(readBackGroups) && readBackGroups[0].name === '开场压迫' && readBackGroups[0].shotNumbers.join(',') === '1-1,1-2', JSON.stringify(readBackGroups && readBackGroups[0]).slice(0, 200))
  check('0-4b：[] 清空分组 → sidecar 删除', JSON.stringify(await store.saveStoryboardGroups(groupsRoot, groupsTitle, 1, [])) === '[]' && !(await fs.access(groupsFile).then(() => true, () => false)))
  await store.deleteStoryboardGroups(groupsRoot, groupsTitle, 1)
  check('0-4b：deleteStoryboardGroups 删除 sidecar', !(await fs.access(groupsFile).then(() => true, () => false)))
  // 校验先于写入：非法分组不产生任何写入（storyboard 文件 hash 不变）
  await store.saveStoryboard(groupsRoot, groupsTitle, 1, [
    { shotNumber: '1-1', shotSize: '中景', cameraMove: '固定', description: '甲', durationSec: 5 },
    { shotNumber: '1-2', shotSize: '近景', cameraMove: '拉', description: '乙', durationSec: 4 },
  ])
  const beforeHash = createHash('sha256').update(await fs.readFile(storyboardFile)).digest('hex')
  const invalidGroupCases = [
    ['groups 非数组', { not: 'array' }],
    ['id 缺失', [{}]],
    ['id 重复', [{ id: 'g1', shotNumbers: [] }, { id: 'g1', shotNumbers: [] }]],
    ['引用不存在镜号', [{ id: 'g9', shotNumbers: ['9-9'] }]],
    ['同一镜属于两组', [{ id: 'g1', shotNumbers: ['1-1'] }, { id: 'g2', shotNumbers: ['1-1'] }]],
    ['emotion.intensity 越界', [{ id: 'g1', shotNumbers: [], emotion: { intensity: 101 } }]],
  ]
  let invalidGroupsOk = 0
  const invalidGroupDetails = []
  for (const [label, groups] of invalidGroupCases) {
    try {
      await store.saveStoryboardWithGroups(groupsRoot, groupsTitle, 1, [
        { shotNumber: '1-1', shotSize: '中景', cameraMove: '固定', description: '甲', durationSec: 5 },
        { shotNumber: '1-2', shotSize: '近景', cameraMove: '拉', description: '乙', durationSec: 4 },
      ], groups)
      invalidGroupDetails.push(label + ':未抛错')
    } catch (error) {
      const code = error && error.code
      const message = String(error && error.message)
      if (code === 'invalid-args' || /invalid|必须|只能是|必须是/.test(message)) invalidGroupsOk += 1
      else invalidGroupDetails.push(label + ':' + code + '/' + message.slice(0, 60))
    }
  }
  const afterHash = createHash('sha256').update(await fs.readFile(storyboardFile)).digest('hex')
  check('0-4b：6 类非法分组 → invalid-args（校验先于写入）', invalidGroupsOk === invalidGroupCases.length, JSON.stringify(invalidGroupDetails))
  check('0-4b：非法分组无副作用（storyboard 文件 hash 不变、无 sidecar 残留）', beforeHash === afterHash && !(await fs.access(groupsFile).then(() => true, () => false)), JSON.stringify({ before: beforeHash.slice(0, 12), after: afterHash.slice(0, 12) }))
  // 双文件事务保存 + 导出 add-only
  await store.writeEpisode(groupsRoot, groupsTitle, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：这钱，我三天还你。\n')
  const combined = await store.saveStoryboardWithGroups(groupsRoot, groupsTitle, 1, [
    { shotNumber: '1-1', shotSize: '中景', cameraMove: '固定', description: '甲', durationSec: 5, groupId: 'g1' },
    { shotNumber: '1-2', shotSize: '近景', cameraMove: '拉', description: '乙', durationSec: 4, groupId: 'g1' },
    { shotNumber: '1-3', shotSize: '全景', description: '丙', durationSec: 6, groupId: 'g2' },
  ], groupsData)
  check('0-4b：双文件事务保存返回 shots+groups', combined.shots.length === 3 && combined.groups.length === 2, JSON.stringify({ shots: combined.shots.length, groups: combined.groups.length }))
  const savedMd = await fs.readFile(path.join(groupsRoot, 'AI短剧', groupsTitle, '分镜', '第001集.分镜.md'), 'utf8')
  check('0-4b：分镜 MD 含「分组情绪总控」章节与分组信息', savedMd.includes('分组情绪总控') && savedMd.includes('开场压迫') && savedMd.includes('情绪曲线'), String(savedMd.length))
  try {
    const exportedGroupsJson = await exporter.exportProject(groupsRoot, groupsTitle, 'json')
    const exportedJsonText = await fs.readFile(exportedGroupsJson.file, 'utf8')
    const exportedJson = JSON.parse(exportedJsonText)
    check('0-4b：JSON 导出 add-only 顶层 storyboardGroups（仅存在时）', Boolean(exportedJson.storyboardGroups && exportedJson.storyboardGroups['1'] && exportedJson.storyboardGroups['1'].length === 2), JSON.stringify(exportedJson.storyboardGroups && Object.keys(exportedJson.storyboardGroups)))
    const exportedGroupsMd = await exporter.exportProject(groupsRoot, groupsTitle, 'markdown')
    const exportedMdText = await fs.readFile(exportedGroupsMd.file, 'utf8')
    check('0-4b：Markdown 全本导出含分组章节', exportedMdText.includes('分组情绪总控') && exportedMdText.includes('开场压迫'), String(exportedMdText.length))
  } catch (error) {
    console.log('      （SKIP：导出 sidecar 断言异常——' + String(error && error.message).slice(0, 80) + '）')
  }
  await fs.rm(groupsRoot, { recursive: true, force: true })
} else {
  console.log('      （SKIP：当前工件无 0-4b groups API（旧工件），groups sidecar 断言跳过）')
}

await fs.rm(workspace, { recursive: true, force: true })

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
