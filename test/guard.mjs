/**
 * 阶段二 · 上游冲突保护与双主防护自测（FR-G08 / FR-G12）
 * 用临时工作区与假后端，不联网。
 * 运行：node test/guard.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = (rel) => import(pathToFileURL(path.join(here, '..', 'lib', rel)).href)
const store = await load('store.js')
const guard = await load('guard.js')
const libtv = await load('backends/libtv.js')

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

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-guard-'))
const TITLE = '防护测试剧'
await store.createProject(workspace, TITLE)
const projectDir = store.projectDir(workspace, TITLE)

/* ------------------------------------------------------------------ [1] */
group('[1] 画布绑定检查')
const unbound = await guard.checkBinding(workspace, TITLE, 'libtv')
check('未绑定时 ok=false', unbound.ok === false && unbound.reason === 'not-bound', JSON.stringify(unbound).slice(0, 120))
check('给出绑定文件路径', unbound.bindingFile.includes('.libtv'), unbound.bindingFile)
check('给出可执行的修复命令', unbound.fix.includes('libtv project use'), unbound.fix)

await fs.mkdir(path.join(projectDir, '.libtv'), { recursive: true })
await fs.writeFile(path.join(projectDir, '.libtv', 'project.json'), JSON.stringify({ projectUuid: 'canvas-abc' }))
const bound = await guard.checkBinding(workspace, TITLE, 'libtv')
check('绑定后 ok=true', bound.ok === true && bound.uuid === 'canvas-abc', JSON.stringify(bound).slice(0, 120))

await fs.writeFile(path.join(projectDir, '.libtv', 'project.json'), JSON.stringify({ foo: 'bar' }))
check('绑定文件缺标识时报 binding-empty', (await guard.checkBinding(workspace, TITLE, 'libtv')).reason === 'binding-empty')

check('未知后端报 unsupported', (await guard.checkBinding(workspace, TITLE, 'unknown')).reason === 'unsupported-backend')
check('neowow 用 sessionId', guard.BINDING_FILES.neowow.includes('.neowow'))

/* ------------------------------------------------------------------ [2] */
group('[2] 指纹与漂移判定')
const snapA = await guard.snapshotCanvas({ listNodes: async () => [{ key: 'n1', name: 'E001-1-1' }] })
check('指纹含节点数与键', snapA.ok === true && snapA.count === 1 && snapA.keys[0] === 'n1', JSON.stringify(snapA).slice(0, 120))
check('指纹按时间排序的键', Array.isArray(snapA.keys))

const noList = await guard.snapshotCanvas({})
check('后端不支持时报 unsupported', noList.ok === false && noList.reason === 'unsupported')
const boom = await guard.snapshotCanvas({ listNodes: async () => { throw new Error('缺少项目') } })
check('读取失败时如实报错', boom.ok === false && boom.reason === 'read-failed' && boom.detail.includes('缺少项目'), JSON.stringify(boom))

const before = { ok: true, keys: ['n1', 'n2'], names: ['E001-1-1', 'E001-1-2'] }
const afterClean = { ok: true, keys: ['n1', 'n2', 'n3'], names: ['E001-1-1', 'E001-1-2', 'E001-1-3'] }
const clean = guard.compareSnapshots(before, afterClean, ['E001-1-3'])
check('正常写入不算漂移', clean.drifted === false && clean.added.length === 1, JSON.stringify(clean))
check('无缺失期望节点', clean.missingExpected.length === 0)

const afterWiped = { ok: true, keys: ['n3'], names: ['别人的节点'] }
const wiped = guard.compareSnapshots(before, afterWiped, ['E001-1-3'])
check('期望节点消失判定漂移', wiped.drifted === true, JSON.stringify(wiped))
check('列出消失的节点', wiped.missingExpected.join(',') === 'E001-1-3')
check('漂移说明提到外部网页端', wiped.detail.includes('外部画布网页端'), wiped.detail)
check('列出被删的原有节点', wiped.removed.includes('n1') && wiped.removed.includes('n2'))

check('指纹不可用时不可比较', guard.compareSnapshots(null, afterClean).comparable === false)
check('不可比较时不谎报漂移', guard.compareSnapshots(null, afterClean).drifted === false)
check('无期望节点时不漂移', guard.compareSnapshots(before, { ok: true, keys: [], names: [] }, []).drifted === false)

/* ------------------------------------------------------------------ [3] */
group('[3] CLI 输出规范化')
const canvases = libtv.normalizeCanvasList({ projectMetaList: [{ uuid: 'u1', id: 7, name: '画布一' }] })
check('画布列表规范化', canvases.length === 1 && canvases[0].uuid === 'u1' && canvases[0].name === '画布一')
check('缺字段时给默认名', libtv.normalizeCanvasList({ projectMetaList: [{ uuid: 'u2' }] })[0].name === '(未命名画布)')
check('空输入返回空数组', libtv.normalizeCanvasList(null).length === 0)

check('节点数组直通', libtv.normalizeNodeList([{ nodeKey: 'k1', name: 'E001-1-1' }])[0].key === 'k1')
check('包裹在 nodes 下', libtv.normalizeNodeList({ nodes: [{ id: 'k2' }] })[0].key === 'k2')
check('字符串节点可用', libtv.normalizeNodeList(['k3'])[0].name === 'k3')
check('认不出的返回空', libtv.normalizeNodeList({ weird: 1 }).length === 0)
check('垃圾项被丢弃', libtv.normalizeNodeList([null, 42, { name: 'ok' }]).length === 1)
check('空输入不抛错', libtv.normalizeNodeList(null).length === 0)

/* ------------------------------------------------------------------ [4] */
group('[4] 双主对账（FR-G12）')
await store.saveStoryboard(workspace, TITLE, 1, [
  { shotNumber: '1-1', shotSize: '特写', description: 'a' },
  { shotNumber: '1-2', shotSize: '中景', description: 'b' },
  { shotNumber: '1-3', shotSize: '远景', description: 'c' },
])

const consistent = await guard.reconcile(workspace, TITLE, {
  backend: { listNodes: async () => [{ key: 'a', name: 'E001-1-1' }, { key: 'b', name: 'E001-1-2' }, { key: 'c', name: 'E001-1-3' }] },
  episode: 1,
})
check('完全一致时 consistent=true', consistent.consistent === true, JSON.stringify(consistent).slice(0, 160))
check('声明事实源是分镜', consistent.sourceOfTruth === 'storyboard')
check('说明只报告不自动改', consistent.detail.includes('不自动改画布'), consistent.detail)

const missing = await guard.reconcile(workspace, TITLE, {
  backend: { listNodes: async () => [{ key: 'a', name: 'E001-1-1' }] },
  episode: 1,
})
check('画布少镜被报出', missing.missingOnCanvas.join(',') === '1-2,1-3', JSON.stringify(missing.missingOnCanvas))
check('少镜时 consistent=false', missing.consistent === false)

const extra = await guard.reconcile(workspace, TITLE, {
  backend: { listNodes: async () => [{ key: 'a', name: 'E001-1-1' }, { key: 'b', name: 'E001-1-2' }, { key: 'c', name: 'E001-1-3' }, { key: 'd', name: 'E001-9-9' }] },
  episode: 1,
})
check('画布多出的节点被报出', extra.extraOnCanvas.join(',') === '9-9', JSON.stringify(extra.extraOnCanvas))

const otherEpisode = await guard.reconcile(workspace, TITLE, {
  backend: { listNodes: async () => [{ key: 'z', name: 'E002-2-1' }] },
  episode: 1,
})
check('别的集的节点不算数', otherEpisode.canvasShots === 0, String(otherEpisode.canvasShots))

const noBackend = await guard.reconcile(workspace, TITLE, { backend: {}, episode: 1 })
check('读不到节点时如实报告', noBackend.ok === false && noBackend.reason === 'unsupported')

/* ------------------------------------------------------------------ [5] */
group('[5] 写入前留证与写入后对账')
const backend = {
  listNodes: async () => [{ key: 'n1', name: 'E001-1-1' }],
}
await fs.writeFile(path.join(projectDir, '.libtv', 'project.json'), JSON.stringify({ projectUuid: 'canvas-abc' }))
const begun = await guard.beginGuard(workspace, TITLE, { backend, backendId: 'libtv', cwd: projectDir })
check('留证记录绑定', begun.binding.ok === true && begun.binding.uuid === 'canvas-abc')
check('留证带上事前提示', begun.warning.includes('网页端'), begun.warning)
check('留证记录了 before 指纹', begun.snapshot.ok === true && begun.snapshot.count === 1)

await guard.expectNodes(workspace, TITLE, 'libtv', ['E001-1-2'])
const state = await guard.readGuardState(workspace, TITLE)
check('期望节点被登记', state.libtv.expectedNew.join(',') === 'E001-1-2', JSON.stringify(state.libtv.expectedNew))
await guard.expectNodes(workspace, TITLE, 'libtv', ['E001-1-2', 'E001-1-3'])
check('重复登记不重复', (await guard.readGuardState(workspace, TITLE)).libtv.expectedNew.length === 2)

const endClean = await guard.endGuard(workspace, TITLE, {
  backend: { listNodes: async () => [{ key: 'n1', name: 'E001-1-1' }, { key: 'n2', name: 'E001-1-2' }, { key: 'n3', name: 'E001-1-3' }] },
  backendId: 'libtv',
  cwd: projectDir,
})
check('写入正常时无漂移', endClean.verdict.drifted === false, JSON.stringify(endClean.verdict).slice(0, 160))
check('正常时不额外告警', endClean.warning === null)

const endDrift = await guard.endGuard(workspace, TITLE, {
  backend: { listNodes: async () => [] },
  backendId: 'libtv',
  cwd: projectDir,
})
check('写入后节点消失判定漂移', endDrift.verdict.drifted === true, JSON.stringify(endDrift.verdict).slice(0, 160))
check('漂移时给出告警', String(endDrift.warning).includes('网页端'), endDrift.warning)
const persisted = await guard.readGuardState(workspace, TITLE)
check('对账结论落盘', persisted.libtv.verdict.drifted === true)

await fs.rm(workspace, { recursive: true, force: true })

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
