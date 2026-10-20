/**
 * P2-1 多数据源（AC-S1…S7）· 用例骨架
 *
 * 覆盖：
 *   [0] 工件能力探测：host `sources-list`（E5，METHODS 67→69（task-110 +1））是否已落地 → 未落地显式 SKIP
 *   [1] A/B 两临时夹具目录各建项目 → `sources-list` 枚举（sourceType / projectCount / 排序 / 去重）
 *   [2] 失效路径过滤（不存在的目录不进 sources）
 *   [3] `status` 带/不带 cwd 兼容（带 cwd 命中该源；不带回退旧行为不报错）
 *   [4] 契约回归：METHODS=69（task-110 media-read +1）、旧 67 条路由全在、无重复；client 调用数（E5 后）与 slots.register=4 红线（task-8 +1、task-17 +1，均已批准）
 *
 * 注：E5 契约（`AI短剧工作区/P1-接口契约冻结-v1.md` §6 变更登记）：
 *   `sources-list { cwd?, limit? }` → `{ ok:true, sources:[{ path, sourceType:'workspace'|'session'|'manual',
 *   projectCount, lastActiveAt?, label? }], degraded?: boolean }`；add-only、旧行为不变、METHODS 67→69（task-110 +1）。
 *
 * 运行：node test/multi-source.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const hostSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8')

const methodsStart = hostSrc.indexOf('const METHODS = [')
const methodsBlock = methodsStart >= 0 ? hostSrc.slice(methodsStart, hostSrc.indexOf(']', methodsStart)) : ''
const hostMethods = new Set([...methodsBlock.matchAll(/'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
const hasSourcesList = hostMethods.has('sources-list')

if (!hasSourcesList) {
  console.log('\n结果：0 passed, 0 failed（SKIP：host `sources-list`（E5）尚未落地，METHODS 仍为 ' + hostMethods.size + '；task-19 交付后本套件自动生效）')
  process.exit(0)
}

const mod = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
const { apply, METHODS } = mod

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

/* ------------------------------------------------------------------ 夹具 */
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-multisource-'))
const dirA = path.join(fixtureRoot, '工作区A')
const dirB = path.join(fixtureRoot, '工作区B')
const dirC = path.join(fixtureRoot, '会话工作区C')
const dirD = path.join(fixtureRoot, '普通会话目录D')
const dirE = path.join(fixtureRoot, '未登记目录E')
const dirGone = path.join(fixtureRoot, '已失效目录-不存在')
await fs.mkdir(dirA, { recursive: true })
await fs.mkdir(dirB, { recursive: true })
await fs.mkdir(path.join(dirC, 'AI短剧', '剧C'), { recursive: true })
await fs.mkdir(dirD, { recursive: true })
await fs.mkdir(dirE, { recursive: true })

const routes = new Map()
/** 可切换的 degraded 场景开关（验证 registry/agents 缺失或抛错时的兜底）。 */
const stubState = { registryOk: true, agentsOk: true }
const workspaceRegistryStub = {
  list: async () => {
    if (!stubState.registryOk) throw new Error('workspace-registry 不可用（模拟）')
    return [
      { path: dirA, label: '工作区A' },
      { path: dirB, label: '工作区B' },
      { path: dirGone, label: '已失效' },
      { path: dirA, label: '工作区A（重复）' },
    ]
  },
}
const dramaSessionAgent = {
  id: 'sess-drama',
  session: { header: { cwd: dirC, agentPreset: 'drama', updatedAt: '2026-10-17T13:00:00.000Z' } },
}
const plainSessionAgent = {
  id: 'sess-plain',
  session: { header: { cwd: dirD, agentPreset: 'standard' } },
}
const agentsStub = {
  list: () => {
    if (!stubState.agentsOk) throw new Error('agents 不可用（模拟）')
    return [dramaSessionAgent, plainSessionAgent]
  },
  roots: () => [],
}
const ctx = {
  provide: () => {},
  inject(_services, callback) {
    callback({
      connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } },
      commands: { register: () => () => {} },
      agents: agentsStub,
      workspaceRegistry: workspaceRegistryStub,
      get: (name) => {
        if (name === 'workspaceRegistry') return workspaceRegistryStub
        if (name === 'agents') return agentsStub
        return undefined
      },
      on: () => {},
      effect: (fn) => fn(),
    })
  },
  logger: { info: () => {}, warn: () => {} },
}
apply(ctx, { root: dirA })

async function call(method, body) {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('route not registered: ' + method)
  const request = new Request('http://127.0.0.1:1/api/ai-drama/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' },
    body: JSON.stringify(body || {}),
  })
  const response = await spec.fetch(request)
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  return { status: response.status, body: payload }
}

/* ------------------------------------------------------------------ [1] */
group('[1] A/B 两目录各建项目 → sources-list 枚举')
const createdA = await call('create-project', { title: '剧A', cwd: dirA })
const createdB = await call('create-project', { title: '剧B', cwd: dirB })
check('A 目录建项目成功', createdA.status === 200 && createdA.body.ok === true, JSON.stringify(createdA.body).slice(0, 120))
check('B 目录建项目成功', createdB.status === 200 && createdB.body.ok === true, JSON.stringify(createdB.body).slice(0, 120))
check('A 目录磁盘落盘 <A>/AI短剧/剧A', await fs.stat(path.join(dirA, 'AI短剧', '剧A')).then(() => true, () => false))
check('B 目录磁盘落盘 <B>/AI短剧/剧B', await fs.stat(path.join(dirB, 'AI短剧', '剧B')).then(() => true, () => false))

const listRes = await call('sources-list', { cwd: dirA })
check('sources-list 成功', listRes.status === 200 && listRes.body.ok === true, JSON.stringify(listRes.body).slice(0, 200))
const sources = Array.isArray(listRes.body.sources) ? listRes.body.sources : []
check('sources 为非空数组', sources.length > 0, String(sources.length))
const allowedTypes = ['workspace', 'session', 'manual']
check('每项含 path / sourceType / projectCount', sources.every((s) => typeof s.path === 'string' && allowedTypes.includes(s.sourceType) && Number.isFinite(s.projectCount)), JSON.stringify(sources).slice(0, 300))
const srcA = sources.find((s) => path.resolve(s.path) === path.resolve(dirA))
const srcB = sources.find((s) => path.resolve(s.path) === path.resolve(dirB))
check('A 源被枚举且 projectCount≥1', Boolean(srcA) && srcA.projectCount >= 1, JSON.stringify(srcA))
check('B 源被枚举且 projectCount≥1', Boolean(srcB) && srcB.projectCount >= 1, JSON.stringify(srcB))
check('sourceType 使用冻结枚举值（workspace|session|manual）', [...sources].every((s) => allowedTypes.includes(s.sourceType)))
check('sources 去重（path 唯一）', new Set(sources.map((s) => path.resolve(s.path))).size === sources.length, JSON.stringify(sources.map((s) => s.path)))
const withActive = sources.filter((s) => typeof s.lastActiveAt === 'string')
check('提供最近活跃字段时按降序排列', withActive.length <= 1 || withActive.every((s, i) => i === 0 || Date.parse(withActive[i - 1].lastActiveAt) >= Date.parse(s.lastActiveAt)), JSON.stringify(withActive.map((s) => s.lastActiveAt)))

/* ------------------------------------------------------------------ [1b] */
group('[1b] 默认源置顶 / 会话 cwd 源 / cwd=排序提示语义（host-dev 口径）')
check('默认源置顶 = registry 第一个有效目录（Q6）', Boolean(sources[0]) && path.resolve(sources[0].path) === path.resolve(dirA), JSON.stringify(sources[0]))
check('registry label 透传到源项（工作区A）', srcA && srcA.label === '工作区A', JSON.stringify(srcA && srcA.label))
const srcC = sources.find((s) => path.resolve(s.path) === path.resolve(dirC))
check('drama 会话 cwd 作为 session 源被枚举', Boolean(srcC) && srcC.sourceType === 'session', JSON.stringify(srcC))
check('session 源 projectCount = 1（剧C）', Boolean(srcC) && srcC.projectCount === 1, JSON.stringify(srcC && srcC.projectCount))
check('session 源 label 形如「会话 · <目录名>」', Boolean(srcC) && String(srcC.label || '').startsWith('会话 · '), String(srcC && srcC.label))
check('非 drama 会话 cwd 不被枚举', !sources.some((s) => path.resolve(s.path) === path.resolve(dirD)), JSON.stringify(sources.map((s) => s.path)))
const hintRes = await call('sources-list', { cwd: dirE })
check('cwd 仅为排序提示：未登记的现存目录不会被强制包含', hintRes.status === 200 && !hintRes.body.sources.some((s) => path.resolve(s.path) === path.resolve(dirE)), JSON.stringify(hintRes.body.sources && hintRes.body.sources.map((s) => s.path)).slice(0, 240))
check('cwd 提示不改变默认源置顶', Boolean(hintRes.body.sources && hintRes.body.sources[0]) && path.resolve(hintRes.body.sources[0].path) === path.resolve(dirA), JSON.stringify(hintRes.body.sources && hintRes.body.sources[0]))
const rankLeaked = sources.filter((s) => Object.prototype.hasOwnProperty.call(s, '_rank')).length
if (rankLeaked) console.log(`      （观察：${rankLeaked} 项含内部字段 _rank，契约未登记；已报 host-dev，不作为失败）`)

/* ------------------------------------------------------------------ [2] */
group('[2] 失效路径过滤')
check('不存在的目录不出现在 sources 中', !sources.some((s) => path.resolve(s.path) === path.resolve(dirGone)), JSON.stringify(sources.map((s) => s.path)))
const limited = await call('sources-list', { cwd: dirA, limit: 1 })
check('limit 生效（sources≤1）', limited.status === 200 && Array.isArray(limited.body.sources) && limited.body.sources.length <= 1, JSON.stringify(limited.body).slice(0, 120))

/* ------------------------------------------------------------------ [3] */
group('[3] status 带/不带 cwd 兼容')
const statusA = await call('status', { cwd: dirA })
check('status(cwd=A) 命中 A 源', statusA.status === 200 && path.resolve(String(statusA.body.workspace || '')) === path.resolve(dirA), JSON.stringify({ workspace: statusA.body.workspace, projectCount: statusA.body.projectCount }).slice(0, 160))
check('status(cwd=A) 项目数=1', statusA.body.projectCount === 1, String(statusA.body.projectCount))
const statusB = await call('status', { cwd: dirB })
check('status(cwd=B) 项目数=1', statusB.status === 200 && statusB.body.projectCount === 1, String(statusB.body.projectCount))
const statusLegacy = await call('status', {})
check('status 不带 cwd：旧行为兼容（200 + workspace 可解析）', statusLegacy.status === 200 && typeof statusLegacy.body.workspace === 'string' && statusLegacy.body.workspace.length > 0, JSON.stringify(statusLegacy.body).slice(0, 160))

/* ------------------------------------------------------------------ [4] */
group('[4] 契约回归（69 / 旧 67 全在 / 客户端调用 / slots 红线；task-110 media-read +1）')
check('METHODS = 69（task-110 media-read +1；含 sources-list）', METHODS.length === 69, String(METHODS.length))
const legacy67 = [...hostMethods].filter((m) => m !== 'sources-list' && m !== 'media-read')
check('旧 67 条路由全在（无删除；排除已批准 sources-list/media-read）', legacy67.length === 67, String(legacy67.length))
check('METHODS 无重复项', new Set(METHODS).size === METHODS.length, String(METHODS.length))
const clientCalls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
const clientHasSources = clientCalls.has('sources-list')
// client B 阶段（task-20）已接入 sources-list（v0.5.0）；旧工件（仅 host 有 sources-list 时）保持 SKIP 兼容。
if (clientHasSources) {
  check('P2-1 E5：client 已接入 sources-list（B 阶段）', true, '')
} else {
  console.log('      （SKIP：client B 阶段（task-20）尚未接入 sources-list —— 接入后本断言自动生效；host 侧 sources-list 已实测）')
}
const slotsRegisterCount = (clientSrc.match(/slots\.register\(/g) || []).length
check('client slots.register = 4（v0.12.1 已批准终值）', slotsRegisterCount === 4, String(slotsRegisterCount))

/* ------------------------------------------------------------------ [4b] */
group('[4b] client B 阶段面板集成（静态契约断言，AC-S1/S2/S3 代码级证据）')
check('client 统一注入当前源 cwd（currentSourceCwd → api 请求）', /currentSourceCwd/.test(clientSrc) && /request\.cwd\s*=/.test(clientSrc))
check('数据源选择器 + 来源标签映射（workspace/session/manual）', /SOURCE_TYPE_LABELS/.test(clientSrc) && /workspace/.test(clientSrc) && /session/.test(clientSrc) && /manual/.test(clientSrc))
check('切源重置视图（resetProjectView）', /resetProjectView\(/.test(clientSrc))
check('记住上次选择（localStorage ai-drama:source）', /ai-drama:source/.test(clientSrc))
check('旧宿主降级路径（sources-list 不可用时回落 useWorkspaces 枚举）', /sources-list/.test(clientSrc) && /useWorkspaces/.test(clientSrc))
check('面板状态行/选择器文案存在（数据源）', /数据源/.test(clientSrc))

/* ------------------------------------------------------------------ [5] */
group('[5] 旧数据不变性（真实工作区，只读；无数据时跳过）')
const REAL_ROOT = process.env.DSH_AI_DRAMA_REAL_ROOT || path.join(pluginRoot, '..', 'AI短剧')
// 基线快照路径：源码树 / 安装副本临时目录 / cwd 多候选；也可用 DSH_AI_DRAMA_BASELINE 显式指定。
const BASELINE_CANDIDATES = [
  process.env.DSH_AI_DRAMA_BASELINE,
  path.join(pluginRoot, '..', 'AI短剧工作区', '证据', 'P2-1-旧数据基线-2026-10-17.json'),
  path.join(process.cwd(), 'AI短剧工作区', '证据', 'P2-1-旧数据基线-2026-10-17.json'),
  path.join(process.cwd(), '..', 'AI短剧工作区', '证据', 'P2-1-旧数据基线-2026-10-17.json'),
].filter(Boolean)
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}
async function scanRealRoot(root) {
  const files = []
  async function walk(dir, relBase = '') {
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name)
      const rel = path.join(relBase, e.name)
      if (e.isDirectory()) await walk(abs, rel)
      else {
        try {
          const buf = await fs.readFile(abs)
          const st = await fs.stat(abs)
          files.push({ relative: rel, bytes: buf.length, sha256: sha256(buf), mtime: st.mtime.toISOString() })
        } catch {
          /* 忽略不可读文件（权限/占用） */
        }
      }
    }
  }
  await walk(root)
  return files
}
let baselinePath = ''
let baselineText = null
for (const candidate of BASELINE_CANDIDATES) {
  try {
    baselineText = await fs.readFile(candidate, 'utf8')
    baselinePath = candidate
    break
  } catch {
    baselineText = null
  }
}
const baseline = baselineText ? JSON.parse(baselineText) : null
if (!baseline) {
  console.log('      （SKIP：旧数据基线快照未找到 —— 安装副本隔离目录等场景；源码树/工作区内运行会自动比对）')
} else {
  check(`旧数据基线快照存在（${baselinePath}）`, true, '')
  const current = await scanRealRoot(REAL_ROOT)
  const baseMap = new Map((baseline.files || []).map((f) => [f.relative, f]))
  const curMap = new Map(current.map((f) => [f.relative, f]))
  // 2026-10-20 测试项目清理后恢复严格口径：活动数据根 = 基线 32 文件集合（缺失/新增/改写均 FAIL；无 allowlist）。
  const missing = [...baseMap.keys()].filter((k) => !curMap.has(k))
  const added = [...curMap.keys()].filter((k) => !baseMap.has(k))
  const changed = [...baseMap.keys()].filter(
    (k) => curMap.has(k) && (curMap.get(k).sha256 !== baseMap.get(k).sha256 || curMap.get(k).bytes !== baseMap.get(k).bytes),
  )
  check('旧数据文件无缺失 / 无新增 / 哈希不变（严格 32 文件）', missing.length === 0 && added.length === 0 && changed.length === 0, JSON.stringify({ missing, added, changed }).slice(0, 300))
  if (Array.isArray(baseline.files)) {
    check('旧数据文件数一致（严格 32 文件；无 allowlist 豁免）', current.length === baseline.files.length, current.length + '/' + baseline.files.length)
  }
}

await fs.rm(fixtureRoot, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
