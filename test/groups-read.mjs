/**
 * v0.11.2 批 2 · 2-4 E7 读侧：storyboard 读取响应 add-only groups · QA 验收套件（task-100）
 *
 * AC（E7 契约登记）：
 *   A 无 sidecar → 响应无 groups/groupsTruncated，形状/字段顺序与 v0.11.1 一致（{ok,shots}）
 *   B 有 sidecar → groups 结构 [{groupId,name,emotionCue,shotNumbers[],groupPrompt?}]，顺序=sidecar 顺序，仅 5 字段
 *   C 组数 >100 → 前 100 + 顶层 groupsTruncated:true（只读不改文件；写入侧上限 50 不在本卡）
 *   D groupPrompt = notes（非空才出现，≤2000 确定性截断）
 *   E sidecar 损坏 → 无 groups、不报错；只读不写盘
 *   F 确定性（同输入两次响应严格相等）、项目目录 hash 不变、真实万界倒爷复制只读
 *   G METHODS 69（task-110 media-read +1） / 工具 34 / 无新依赖 / helper 缺省口径
 *
 * 版本自适应：无 getStoryboardReadView/buildStoryboardGroupsView（≤v0.11.1 安装包）→ 整套件 SKIP（exit 0）。
 * 运行：node test/groups-read.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href)

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
const store = await load('lib/store.js')
const toolsModule = await load('lib/tools.js')
const indexMod = await load('index.js')
const hostSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8')
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
const clientCalls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((match) => match[1]))
const toolCount = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES.length : 0
const methods = indexMod.METHODS || []
const hasReadView = typeof store.getStoryboardReadView === 'function' && typeof store.buildStoryboardGroupsView === 'function'
if (!hasReadView) {
  console.log('  结果：0 passed, 0 failed（SKIP：当前工件无 getStoryboardReadView/buildStoryboardGroupsView（≤v0.11.1 安装包），groups 读侧套件跳过）')
  process.exit(0)
}
check('0.1 store 新增只读 helper（buildStoryboardGroupsView/getStoryboardReadView）', hasReadView)
check('0.2 读侧上限常量 100 / groupPrompt 上限 2000', store.GROUPS_READ_LIMIT === 100 && store.GROUP_PROMPT_READ_LIMIT === 2000, JSON.stringify({ groups: store.GROUPS_READ_LIMIT, prompt: store.GROUP_PROMPT_READ_LIMIT }))
check('0.3 METHODS 69（task-110 media-read +1） 且含 storyboard-get（无新 route）', methods.length === 69 && methods.includes('storyboard-get'), String(methods.length))
check('0.4 工具 34 / client 调用 68（M4 批1+批2 +10 已批准）/ 无新依赖', toolCount === 34 && clientCalls.size === 69 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ tools: toolCount, clientCalls: clientCalls.size }))

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'groups-read-'))
const TITLE = 'groups读侧测试剧'
const projectDir = path.join(workspace, 'AI短剧', TITLE)
const groupsFile = path.join(projectDir, '.aidrama', 'storyboard-groups', '第001集.md.json')
const SHOTS = [
  { shotNumber: '1-1', shotSize: '中景', cameraMove: '固定', description: '对峙', dialogue: '林越：这钱', durationSec: 5 },
  { shotNumber: '1-2', shotSize: '近景', cameraMove: '推', description: '抬眼', durationSec: 4 },
  { shotNumber: '1-3', shotSize: '全景', cameraMove: '固定', description: '空镜', durationSec: 3 },
]
async function makeProject(title, shots = SHOTS) {
  await store.createProject(workspace, title)
  await store.writeEpisode(workspace, title, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：这钱，我三天还你。\n')
  await store.saveStoryboard(workspace, title, 1, shots)
}
// 真实 route harness（与 p1-t10 / host verify 一致）
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
  const payload = await response.json().catch(() => null)
  return { status: response.status, body: payload }
}

group('[A] 无 sidecar：旧输出不变（无 groups/groupsTruncated）')
const A_TITLE = '无sidecar剧'
await makeProject(A_TITLE)
const aCall = await call('storyboard-get', { title: A_TITLE, order: 1 })
const aExpectedShots = await store.getStoryboard(workspace, A_TITLE, 1)
check('A1 route 200 / body ok=true / 无 groups / 无 groupsTruncated', aCall.status === 200 && aCall.body.ok === true && !Object.hasOwn(aCall.body, 'groups') && !Object.hasOwn(aCall.body, 'groupsTruncated'))
check('A2 旧形状：ok/shots 键在前（字段顺序稳定）', JSON.stringify(Object.keys(aCall.body).slice(0, 2)) === JSON.stringify(['ok', 'shots']), Object.keys(aCall.body).join(','))
check('A3 shots 与 store 读取一致（旧字段值不变）', JSON.stringify(aCall.body.shots) === JSON.stringify(aExpectedShots))

group('[B] 多组 sidecar：结构 / 顺序 / 仅 5 字段')
const B_TITLE = '多组剧'
await makeProject(B_TITLE)
const sidecarGroups = [
  { id: 'g1', name: '开场压迫', shotNumbers: ['1-1', '1-2'], emotion: { curve: ['压抑', '警觉'], intensity: 70 }, notes: '自然日光与真实水面反光为基础；本组禁制：不出现第二只麻鹰。' },
  { id: 'g2', name: '转场余味', shotNumbers: ['1-3'], emotion: { curve: ['警觉', '松弛'], intensity: 40 } },
]
await store.saveStoryboardWithGroups(workspace, B_TITLE, 1, SHOTS, sidecarGroups)
const bCall = await call('storyboard-get', { title: B_TITLE, order: 1 })
const bView = bCall.body.groups
check('B1 groups 为纯数组且顺序 = sidecar 顺序', Array.isArray(bView) && bView.length === 2 && bView[0].groupId === 'g1' && bView[1].groupId === 'g2')
check('B2 g1：groupId/name/emotionCue/shotNumbers/groupPrompt 正确', bView[0].groupId === 'g1' && bView[0].name === '开场压迫' && bView[0].emotionCue === '压抑→警觉（70/100）' && JSON.stringify(bView[0].shotNumbers) === JSON.stringify(['1-1', '1-2']) && bView[0].groupPrompt === sidecarGroups[0].notes, JSON.stringify(bView[0]).slice(0, 220))
check('B3 g2：无 notes → 不出现 groupPrompt 键', !Object.hasOwn(bView[1], 'groupPrompt') && bView[1].emotionCue === '警觉→松弛（40/100）', JSON.stringify(bView[1]))
check('B4 仅输出约定 5 字段（无 durationTargetSec 等）', JSON.stringify(Object.keys(bView[0])) === JSON.stringify(['groupId', 'name', 'emotionCue', 'shotNumbers', 'groupPrompt']) && JSON.stringify(Object.keys(bView[1])) === JSON.stringify(['groupId', 'name', 'emotionCue', 'shotNumbers']), JSON.stringify(Object.keys(bView[0])))
check('B5 未截断：顶层无 groupsTruncated', !Object.hasOwn(bCall.body, 'groupsTruncated'))
check('B6 shotNumbers 顺序 = sidecar 数组顺序（不排序）', JSON.stringify(bView[0].shotNumbers) === JSON.stringify(sidecarGroups[0].shotNumbers))

group('[C] 组数 >100 → 截断前 100 + groupsTruncated:true（只读不改文件）')
const C_TITLE = '多组截断剧'
await makeProject(C_TITLE)
const manyGroups = Array.from({ length: 120 }, (_, index) => ({ id: `g${index + 1}`, name: `组${index + 1}`, shotNumbers: [] }))
await fs.mkdir(path.dirname(groupsFile.replace(TITLE, C_TITLE)), { recursive: true })
const cFile = path.join(projectDir.replace(TITLE, C_TITLE), '.aidrama', 'storyboard-groups', '第001集.md.json')
await fs.writeFile(cFile, `${JSON.stringify({ schemaVersion: 1, episode: 1, updatedAt: '2026-10-18T00:00:00.000Z', groups: manyGroups }, null, 2)}\n`, 'utf8')
const cHashBefore = sha256(await fs.readFile(cFile))
const cCall = await call('storyboard-get', { title: C_TITLE, order: 1 })
check('C1 groups 截断为 100 组（前 100）且 groupsTruncated=true', cCall.body.groups.length === 100 && cCall.body.groups[0].groupId === 'g1' && cCall.body.groups[99].groupId === 'g100' && cCall.body.groupsTruncated === true, JSON.stringify({ len: cCall.body.groups && cCall.body.groups.length }))
check('C2 截断为纯读取（sidecar 文件 hash 不变）', sha256(await fs.readFile(cFile)) === cHashBefore)

group('[D] groupPrompt = notes 兜底 ≤2000 确定性截断')
const D_TITLE = '长备注剧'
await makeProject(D_TITLE)
const dFile = path.join(projectDir.replace(TITLE, D_TITLE), '.aidrama', 'storyboard-groups', '第001集.md.json')
await fs.mkdir(path.dirname(dFile), { recursive: true })
await fs.writeFile(dFile, `${JSON.stringify({ schemaVersion: 1, episode: 1, updatedAt: '2026-10-18T00:00:00.000Z', groups: [{ id: 'g1', name: '超长', shotNumbers: ['1-1'], notes: '字'.repeat(3000) }] }, null, 2)}\n`, 'utf8')
const dCall = await call('storyboard-get', { title: D_TITLE, order: 1 })
check('D1 groupPrompt 截断到 2000 字（确定性）', dCall.body.groups[0].groupPrompt.length === 2000 && dCall.body.groups[0].groupPrompt === '字'.repeat(2000))

group('[E] sidecar 损坏 → 无 groups、不报错')
const E_TITLE = '损坏sidecar剧'
await makeProject(E_TITLE)
const eFile = path.join(projectDir.replace(TITLE, E_TITLE), '.aidrama', 'storyboard-groups', '第001集.md.json')
await fs.mkdir(path.dirname(eFile), { recursive: true })
await fs.writeFile(eFile, '{ not-json', 'utf8')
const eCall = await call('storyboard-get', { title: E_TITLE, order: 1 })
check('E1 损坏 sidecar → 200/无 groups/shots 正常', eCall.status === 200 && eCall.body.ok === true && !Object.hasOwn(eCall.body, 'groups') && Array.isArray(eCall.body.shots))

group('[F] 确定性 / 只读 / 真实万界倒爷复制')
const bCall2 = await call('storyboard-get', { title: B_TITLE, order: 1 })
check('F1 同输入两次响应严格相等（确定性）', JSON.stringify(bCall.body) === JSON.stringify(bCall2.body))
const beforeHash = await treeHash(projectDir.replace(TITLE, B_TITLE))
await call('storyboard-get', { title: B_TITLE, order: 1 })
const afterHash = await treeHash(projectDir.replace(TITLE, B_TITLE))
check('F2 route 读取不写盘（项目目录 hash 不变）', beforeHash.hash === afterHash.hash && beforeHash.count === afterHash.count)
const REAL_STORYBOARD = process.env.DSH_AI_DRAMA_SAMPLE_STORYBOARD || ''
if (await fileExists(REAL_STORYBOARD)) {
  const realHashBefore = sha256(await fs.readFile(REAL_STORYBOARD))
  const realShots = JSON.parse(await fs.readFile(REAL_STORYBOARD, 'utf8'))
  const F_TITLE = '万界倒爷复制'
  await makeProject(F_TITLE, realShots)
  const fCall = await call('storyboard-get', { title: F_TITLE, order: 1 })
  check('F3 真实万界倒爷 19 镜复制（无 sidecar）→ 无 groups / shots 一致', fCall.body.shots.length === 19 && !Object.hasOwn(fCall.body, 'groups'))
  check('F4 真实项目源文件只读（hash 不变）', sha256(await fs.readFile(REAL_STORYBOARD)) === realHashBefore)
} else {
  console.log('      （SKIP：真实项目 fixture 不存在）')
}

group('[G] helper 缺省口径 / 契约')
const helperView = store.buildStoryboardGroupsView([{ id: 'g1' }, { id: 'g2', name: 'N', emotion: { intensity: 55 } }])
check('G1 helper 缺省：name/emotionCue 输出空串、truncated=false', helperView.groups[0].name === '' && helperView.groups[0].emotionCue === '' && helperView.groups[1].emotionCue === '' && helperView.truncated === false, JSON.stringify(helperView))
check('G2 METHODS 69（task-110 media-read +1） / 工具 34 / client 69（task-110 media-read +1）（M4 批1+批2 已批准）/ 无新依赖', methods.length === 69 && toolCount === 34 && clientCalls.size === 69 && Object.keys(pkg.dependencies || {}).length === 0)

await fs.rm(workspace, { recursive: true, force: true })
check('G3 临时工作区已清理', !(await fileExists(workspace)))

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
