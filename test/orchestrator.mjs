/**
 * 阶段二 · 生成编排自测（FR-G02 / FR-G03 / FR-G04）
 * 全部用假后端与临时工作区，不联网、不消耗积分。
 * 运行：node test/orchestrator.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = (rel) => import(pathToFileURL(path.join(here, '..', 'lib', rel)).href)
const store = await load('store.js')
const generation = await load('generation.js')
const orchestrator = await load('orchestrator.js')

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

await fs.rm(workspace, { recursive: true, force: true })

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
