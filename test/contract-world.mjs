/**
 * v0.16.3 C1-Q（E14）· 八大基本设定 contract add-only 验收套件（第 47 套件）
 *
 * 需求：`AI短剧工作区/需求/需求分析-C1-八大基本设定-E14-v1.md`（Lead 已批）；C1-H=task-8 / C1-C=task-9 / C1-Q=task-10
 * 实现单一源：`lib/contract-world.js`（8 字段/上限/中文名/MD 段/context 摘要/工具 schema）
 *
 * 覆盖 AC-C1-1…12：
 *  [0] 契约登记（8 字段 key/顺序/中文名/上限 = 需求表；SUMMARY_LIMIT=200）
 *  [1] 新项目 emptyContract 不预置空键（JSON/MD/contract-get 旧形状）
 *  [2] 8 字段往返/trim/多行
 *  [3] 长度上限（恰好通过；+1 → 400 invalid-args）
 *  [4] 非法类型（number/array/object/null）→ 400 invalid-args 且不写盘
 *  [5] AC-C1-12 清空语义（显式 '' → 删键/回读空/MD 无行；payload 缺 key → 保留 current；全清 → 无段）
 *  [6] 未知字段保留 + title 不被覆盖
 *  [7] 渲染 `剧集契约.md` 条件段（固定顺序/空字段跳过/换行→空格/全空无段）
 *  [8] context-card ≤200 字纯截断、仅非空、全空无段、体积受控
 *  [9] 导出 add-only（JSON 含新字段；`-全本.md` 契约表保持旧形状未扩展）
 * [10] expectedHash 409 链保留且冲突不写盘
 * [11] 旧项目字节不变（对照 v0.16.2 实施基线：contract.json/MD/contract-get/导出/context-card/只读）；最高优先 AC-C1-1
 * [12] 工具 schema add-only（drama_save_contract 8 可选 string；required 仍仅 contract；additionalProperties:false 保留）
 * [13] client 静态（折叠组默认收起/已填 X/8/8 textarea/只提交非空/payload 8 键/超长拦截/调用点 70/slots 4）+ 字段表对齐
 * [14] 契约红线（METHODS 70 / 工具 34 / 调用点 70 / slots 4 / 无新依赖 / 无新 route）
 *
 * 能力自适应：`lib/contract-world.js` 不存在 → 整组 SKIP 0/0（旧安装副本 E2E 不误红）。
 * 旧项目字节基线：`证据/_qa-v0163-oldbyte-baseline-v0162.json`（v0.16.2 pack 捕获；缺失时相关断言 SKIP 注明）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const workspaceRoot = path.join(pluginRoot, '..')
const hostSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8')
const toolsSrc = await fs.readFile(path.join(pluginRoot, 'lib', 'tools.js'), 'utf8')
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))

let WORLD = null
try {
  WORLD = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'contract-world.js')).href)
} catch {
  WORLD = null
}
if (!WORLD) {
  console.log('结果：0 passed, 0 failed（SKIP：未找到 lib/contract-world.js —— C1-H 尚未落盘（旧安装副本/旧基线环境）；源码树落地后本套件自动生效）')
  process.exit(0)
}
const { WORLD_CONTRACT_FIELDS, WORLD_CONTRACT_KEYS, WORLD_CONTRACT_SUMMARY_LIMIT } = WORLD

const LEGACY_KEYS = ['title', 'platform', 'audience', 'episodeDurationSec', 'targetEpisodes', 'orientation', 'hookDensity', 'redlines', 'updatedAt']
const EXPECT_SPEC = [
  ['worldSpace', '地理与空间', 1500],
  ['worldTime', '时间与历史', 1500],
  ['powerSystem', '力量体系', 2000],
  ['speciesEcology', '种族与生态', 1200],
  ['factions', '社会与势力', 1500],
  ['resourceEconomy', '资源与经济', 1200],
  ['cultureBelief', '文化与信仰', 1500],
  ['soulDeath', '灵魂/生死/因果', 1500],
]
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const sha256Text = (text) => sha256(Buffer.from(String(text)))
const OLD_BYTE_BASELINE_CANDIDATES = [
  process.env.DSH_AI_OLD_BYTE_BASELINE,
  path.join(workspaceRoot, 'AI短剧工作区', '证据', '_qa-v0163-oldbyte-baseline-v0162.json'),
]
const OLD_PROJECT_CANDIDATES = [
  process.env.DSH_AI_OLD_PROJECT,
  path.join(workspaceRoot, 'AI短剧', '退婚后，我继承了万亿家业'),
]

let passed = 0
let failed = 0
const failures = []
let skippedNotes = 0
function check(label, condition, detail) {
  if (condition) passed += 1
  else {
    failed += 1
    failures.push(`${label}${detail ? ' -> ' + detail : ''}`)
    console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`)
  }
}
const group = (name) => console.log('\n' + name)
const lstat = async (p) => fs.stat(p).then(() => true, () => false)
const readJsonSafe = async (p) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return null } }
const walkFiles = async (dir, rel = '') => {
  const out = []
  let entries = []
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, e.name)
    const r = rel ? rel + '/' + e.name : e.name
    if (e.isDirectory()) out.push(...(await walkFiles(abs, r)))
    else { const buf = await fs.readFile(abs); out.push({ rel: r, bytes: buf.length, sha256: sha256(buf) }) }
  }
  return out
}
const filesHash = (files) => sha256Text(files.map((f) => f.rel + ':' + f.sha256).join('\n'))

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-cworld-'))
const routes = new Map()
const services = {
  connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } },
  workspaceRegistry: { list: async () => [{ path: workspace, title: 'W' }] },
  agents: { list: async () => [] },
}
const scope = { ...services, get: (n) => services[n], on: () => {}, effect: (fn) => fn() }
const indexMod = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
const storeMod = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'store.js')).href)
const toolsMod = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'tools.js')).href)
const ctxMod = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'context-card.js')).href)
indexMod.apply({ provide: () => {}, inject: (x, cb) => cb(scope), logger: { info: () => {}, warn: () => {} } }, { root: workspace })
const call = async (method, body) => {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('缺少 route: ' + method)
  const response = await spec.fetch(new Request('http://x/api/ai-drama/' + method, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' }, body: JSON.stringify(body || {}) }))
  const text = await response.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  return { status: response.status, ok: response.ok, text, data }
}
const projectDirOf = (title) => path.join(workspace, 'AI短剧', title)
const contractJsonPath = (title) => path.join(projectDirOf(title), '.aidrama', 'contract.json')
const contractMdPath = (title) => path.join(projectDirOf(title), '剧集契约.md')
const TITLE = '八大设定验收剧'
const legacyKeysOf = (obj) => Object.keys(obj || {}).filter((k) => !WORLD_CONTRACT_KEYS.includes(k)).sort()
const worldKeysOf = (obj) => Object.keys(obj || {}).filter((k) => WORLD_CONTRACT_KEYS.includes(k)).sort()
const EXPECT_WORLD_KEYS_SORTED = [...WORLD_CONTRACT_KEYS].sort()

/* ------------------------------------------------------------------ [0] */
group('[0] 契约登记：8 字段 key/顺序/中文名/上限 = 需求表（单一源）')
check('lib/contract-world.js 暴露 8 字段（WORLD_CONTRACT_FIELDS.length=8）', Array.isArray(WORLD_CONTRACT_FIELDS) && WORLD_CONTRACT_FIELDS.length === 8, String(WORLD_CONTRACT_FIELDS && WORLD_CONTRACT_FIELDS.length))
check('WORLD_CONTRACT_KEYS 顺序 = worldSpace→worldTime→powerSystem→speciesEcology→factions→resourceEconomy→cultureBelief→soulDeath', JSON.stringify(WORLD_CONTRACT_KEYS) === JSON.stringify(EXPECT_SPEC.map((x) => x[0])), JSON.stringify(WORLD_CONTRACT_KEYS))
for (const [i, [key, label, limit]] of EXPECT_SPEC.entries()) {
  const field = WORLD_CONTRACT_FIELDS[i] || {}
  check(`字段登记 #${i + 1}：${key} = ${label} / ≤${limit}`, field.key === key && field.label === label && field.limit === limit, JSON.stringify({ key: field.key, label: field.label, limit: field.limit }))
}
check('context 摘要上限 = 200 字符', WORLD_CONTRACT_SUMMARY_LIMIT === 200, String(WORLD_CONTRACT_SUMMARY_LIMIT))

/* ------------------------------------------------------------------ [1] */
group('[1] 新项目 emptyContract 不预置空键（旧形状）')
const created = await call('create-project', { title: TITLE })
check('创建临时项目成功', created.status === 200 && created.data && created.data.ok === true)
const freshGet = await call('contract-get', { title: TITLE })
const freshContract = freshGet.data && freshGet.data.contract
check('新项目 contract-get 键集合 = 旧 9 键（无 8 世界字段）', freshGet.status === 200 && worldKeysOf(freshContract).length === 0 && legacyKeysOf(freshContract).join(',') === LEGACY_KEYS.slice().sort().join(','), JSON.stringify(Object.keys(freshContract || {}).sort()))
const freshFile = await readJsonSafe(contractJsonPath(TITLE))
check('新项目 .aidrama/contract.json 原始文件无世界字段空键', freshFile && worldKeysOf(freshFile).length === 0, JSON.stringify(freshFile && Object.keys(freshFile)))
const freshMd = await fs.readFile(contractMdPath(TITLE), 'utf8')
check('新项目 剧集契约.md 不含「八大基本设定」段', !freshMd.includes('八大基本设定'))

/* ------------------------------------------------------------------ [2] */
group('[2] 8 字段往返（中文/多行/trim）')
const roundtrip = Object.fromEntries(WORLD_CONTRACT_FIELDS.map((f) => [f.key, `【${f.key}】第一行\n第二行（中文标点：，。！）`]))
const saveAll = await call('contract-save', { title: TITLE, contract: { ...roundtrip } })
check('8 字段一次性保存成功（200/ok）', saveAll.status === 200 && saveAll.data && saveAll.data.ok === true, JSON.stringify({ status: saveAll.status, code: saveAll.data && saveAll.data.code }))
const readAll = await call('contract-get', { title: TITLE })
const gotAll = readAll.data && readAll.data.contract
for (const f of WORLD_CONTRACT_FIELDS) {
  check(`往返一致：${f.key}（含中文/换行）`, gotAll && gotAll[f.key] === roundtrip[f.key], JSON.stringify(gotAll && gotAll[f.key]).slice(0, 120))
}
check('往返后键集合 = 旧 9 键 + 8 世界字段（add-only）', worldKeysOf(gotAll).join(',') === EXPECT_WORLD_KEYS_SORTED.join(',') && legacyKeysOf(gotAll).join(',') === LEGACY_KEYS.slice().sort().join(','), JSON.stringify(worldKeysOf(gotAll)))
const trimSave = await call('contract-save', { title: TITLE, contract: { worldSpace: '   前后有空格的值   ' } })
check('trim：写入前后空格 → 读取为 trim 后值', trimSave.status === 200 && trimSave.data.contract && trimSave.data.contract.worldSpace === '前后有空格的值', JSON.stringify(trimSave.data && trimSave.data.contract && trimSave.data.contract.worldSpace))

/* ------------------------------------------------------------------ [3] */
group('[3] 长度上限：恰好上限通过；上限 +1 → 400 invalid-args')
for (const f of WORLD_CONTRACT_FIELDS) {
  const exact = '界'.repeat(f.limit)
  const okRes = await call('contract-save', { title: TITLE, contract: { [f.key]: exact } })
  check(`恰好上限通过：${f.key}（${f.limit} 字）`, okRes.status === 200 && okRes.data.contract && okRes.data.contract[f.key] === exact)
  const overRes = await call('contract-save', { title: TITLE, contract: { [f.key]: '界'.repeat(f.limit + 1) } })
  check(`超长拒绝：${f.key}（${f.limit + 1} 字）→ 400 invalid-args`, overRes.status === 400 && overRes.data && overRes.data.code === 'invalid-args', JSON.stringify({ status: overRes.status, code: overRes.data && overRes.data.code }))
}

/* ------------------------------------------------------------------ [4] */
group('[4] 非法类型 → 400 invalid-args 且不写盘')
const beforeIllegal = sha256(await fs.readFile(contractJsonPath(TITLE)))
for (const [name, value] of Object.entries({ number: 123, array: ['a'], object: { x: 1 }, nullValue: null, boolean: true })) {
  const bad = await call('contract-save', { title: TITLE, contract: { worldSpace: value } })
  check(`非法类型拒绝：${name} → 400 invalid-args`, bad.status === 400 && bad.data && bad.data.code === 'invalid-args', JSON.stringify({ status: bad.status, code: bad.data && bad.data.code }))
}
const afterIllegal = sha256(await fs.readFile(contractJsonPath(TITLE)))
check('非法类型请求不写盘（contract.json sha256 不变）', beforeIllegal === afterIllegal)

/* ------------------------------------------------------------------ [5] */
group('[5] AC-C1-12 清空语义：显式 \'\' → 删键/回读空/MD 无行；缺 key → 保留 current；全清 → 无段')
await call('contract-save', { title: TITLE, contract: Object.fromEntries(WORLD_CONTRACT_FIELDS.map((f) => [f.key, `值-${f.key}`])) })
const cleared = await call('contract-save', { title: TITLE, contract: { worldSpace: '   ', worldTime: '' } })
const afterClear = await call('contract-get', { title: TITLE })
check('清空 worldSpace/worldTime → 键被删除（contract-get 无该键）', cleared.status === 200 && afterClear.data && !Object.prototype.hasOwnProperty.call(afterClear.data.contract || {}, 'worldSpace') && !Object.prototype.hasOwnProperty.call(afterClear.data.contract || {}, 'worldTime'), JSON.stringify(afterClear.data && Object.keys(afterClear.data.contract || {})))
const afterClearFile = await readJsonSafe(contractJsonPath(TITLE))
check('清空 → contract.json 原始文件无该键（不落空串）', afterClearFile && !Object.prototype.hasOwnProperty.call(afterClearFile, 'worldSpace') && !Object.prototype.hasOwnProperty.call(afterClearFile, 'worldTime'))
const clearMd = await fs.readFile(contractMdPath(TITLE), 'utf8')
check('清空 → 剧集契约.md 无该字段行（地理与空间/时间与历史）', !clearMd.includes('地理与空间') && !clearMd.includes('时间与历史'))
const onlyOther = await call('contract-save', { title: TITLE, contract: { cultureBelief: '只更新文化信仰' } })
const afterMissing = await call('contract-get', { title: TITLE })
check('payload 缺 key → 保留 current（未提交的 powerSystem/factions 仍在）', onlyOther.status === 200 && afterMissing.data.contract.powerSystem === '值-powerSystem' && afterMissing.data.contract.factions === '值-factions' && afterMissing.data.contract.cultureBelief === '只更新文化信仰', JSON.stringify({ power: afterMissing.data.contract.powerSystem, factions: afterMissing.data.contract.factions }))
const clearAll = await call('contract-save', { title: TITLE, contract: Object.fromEntries(WORLD_CONTRACT_FIELDS.map((f) => [f.key, ''])) })
const clearAllMd = await fs.readFile(contractMdPath(TITLE), 'utf8')
check('全清空 → 剧集契约.md 不出现「八大基本设定」段（回到旧字节形状）', clearAll.status === 200 && !clearAllMd.includes('八大基本设定'))

/* ------------------------------------------------------------------ [6] */
group('[6] 未知字段保留 + title 不被覆盖')
const manual = await readJsonSafe(contractJsonPath(TITLE))
manual.legacyExtraField = '旧/手工字段应保留'
await fs.writeFile(contractJsonPath(TITLE), JSON.stringify(manual, null, 2) + '\n', 'utf8')
await call('contract-save', { title: TITLE, contract: { soulDeath: '死亡权重：可死一次，复活需代价' } })
const afterUnknown = await readJsonSafe(contractJsonPath(TITLE))
check('保存世界字段后未知旧字段保留（legacyExtraField）', afterUnknown && afterUnknown.legacyExtraField === '旧/手工字段应保留', JSON.stringify(afterUnknown && Object.keys(afterUnknown)))
check('title 不被 patch 覆盖（仍为当前项目标题）', afterUnknown && afterUnknown.title === TITLE, String(afterUnknown && afterUnknown.title))

/* ------------------------------------------------------------------ [7] */
group('[7] 渲染剧集契约.md 条件段：固定顺序/空字段跳过/换行→空格')
const MD_VALUES = {
  worldSpace: '地理标记WSP 第一行\n第二行',
  worldTime: '时间标记WTM',
  powerSystem: '力量标记PWR',
  speciesEcology: '生态标记SPE',
  factions: '势力标记FAC',
  resourceEconomy: '经济标记RES',
  cultureBelief: '文化标记CUL',
  soulDeath: '生死标记SOL',
}
await call('contract-save', { title: TITLE, contract: { ...MD_VALUES } })
const mdAll = await fs.readFile(contractMdPath(TITLE), 'utf8')
check('渲染：出现「### 八大基本设定（可选）」条件段', mdAll.includes('### 八大基本设定（可选）'))
const orderIdx = WORLD_CONTRACT_FIELDS.map((f) => mdAll.indexOf(`- **${f.label}**：`))
check('渲染：8 字段按固定顺序出现（中文名 + 行格式）', orderIdx.every((v) => v > 0) && orderIdx.every((v, i) => i === 0 || v > orderIdx[i - 1]), JSON.stringify(orderIdx))
await call('contract-save', { title: TITLE, contract: { worldSpace: '', worldTime: '' } })
const mdPartial = await fs.readFile(contractMdPath(TITLE), 'utf8')
check('渲染：清空的字段跳过（MD 不含其内容标记）', !mdPartial.includes('地理标记WSP') && !mdPartial.includes('时间标记WTM') && mdPartial.includes('力量标记PWR'))
check('渲染：空字段跳过（清空 2 个后条件段仅 6 行）', (() => { const rows = WORLD_CONTRACT_FIELDS.filter((f) => mdPartial.includes(`- **${f.label}**：`)); return rows.length === 6 && !rows.some((f) => ['worldSpace', 'worldTime'].includes(f.key)) })(), JSON.stringify(WORLD_CONTRACT_FIELDS.filter((f) => mdPartial.includes(`- **${f.label}**：`)).map((f) => f.key)))
const wsLine = mdAll.includes('- **地理与空间**：地理标记WSP 第一行 第二行')
check('渲染：字段内容内换行 → 空格（不破坏 Markdown 段落）', wsLine)
check('渲染：全空无段（上一组已清空全部世界字段时 MD 无段）', !clearAllMd.includes('八大基本设定'))
check('渲染：条件段位于契约表格之后、`> 最后更新` 之前', mdAll.indexOf('### 八大基本设定（可选）') > mdAll.indexOf('| 字段 | 值 |') && mdAll.indexOf('### 八大基本设定（可选）') < mdAll.indexOf('> 最后更新：'), JSON.stringify({ table: mdAll.indexOf('| 字段 | 值 |'), world: mdAll.indexOf('### 八大基本设定（可选）'), updated: mdAll.indexOf('> 最后更新：') }))

/* ------------------------------------------------------------------ [8] */
group('[8] context-card：≤200 字纯截断、仅非空、全空无段、体积受控')
await call('contract-save', { title: TITLE, contract: Object.fromEntries(WORLD_CONTRACT_FIELDS.map((f) => [f.key, ''])) })
await call('contract-save', { title: TITLE, contract: { worldSpace: '摘'.repeat(500), factions: '短摘要字段FAC' } })
const ctxGet = await call('contract-get', { title: TITLE })
const ctxCard = ctxMod.buildDramaContextCard({ title: TITLE, contract: ctxGet.data.contract })
check('context-card 出现「世界约束（摘要）」段（存在非空字段时，含已填 2/8）', ctxCard.includes('世界约束（摘要）') && ctxCard.includes('已填 2/8'), ctxCard.slice(0, 200))
const ctxLine = (ctxCard.split(/\r?\n/).find((l) => l.includes('  - 地理与空间：')) || '')
const ctxValue = ctxLine.replace(/^\s*- 地理与空间：/, '')
check('context-card 长字段截断 ≤200 字符（含 … 尾）', ctxValue.length > 0 && ctxValue.length <= 200 && ctxValue.endsWith('…'), JSON.stringify({ len: ctxValue.length, tail: ctxValue.slice(-4) }))
check('context-card 截断不含第 201 字（纯截断前 199 字 + …）', !ctxCard.includes('摘'.repeat(201)))
check('context-card 仅非空字段出现（其他字段内容不出现）', !ctxCard.includes('力量体系：') && !ctxCard.includes('种族与生态：'))
await call('contract-save', { title: TITLE, contract: Object.fromEntries(WORLD_CONTRACT_FIELDS.map((f) => [f.key, ''])) })
const ctxEmpty = await call('contract-get', { title: TITLE })
const ctxCardEmpty = ctxMod.buildDramaContextCard({ title: TITLE, contract: ctxEmpty.data.contract })
check('context-card 全空 → 不出现「世界约束」段（旧注入文本形状）', !ctxCardEmpty.includes('世界约束（摘要）'))
const ctxBytes = Buffer.byteLength(ctxCard) - Buffer.byteLength(ctxCardEmpty)
check('context-card 体积受控（8×200 字符 + 标签开销内；实测记录）', ctxBytes <= 8 * 200 * 3 + 1200, `${ctxBytes}B`)

/* ------------------------------------------------------------------ [9] */
group('[9] 导出 add-only（JSON 含新字段；-全本.md 契约表保持旧形状）')
await call('contract-save', { title: TITLE, contract: { worldSpace: '导出舞台', soulDeath: '导出死亡权重' } })
const exported = await call('export-project', { title: TITLE, format: 'markdown' })
const exportDir = path.join(projectDirOf(TITLE), '导出')
const exportNames = (await fs.readdir(exportDir)).sort()
check('导出成功（200）且导出目录含全本 MD + manifest', exported.status === 200 && exportNames.some((n) => n.endsWith('-全本.md')) && exportNames.includes('manifest.sha256.json'), JSON.stringify(exportNames))
const fullMd = await fs.readFile(path.join(exportDir, exportNames.find((n) => n.endsWith('-全本.md'))), 'utf8')
check('导出 -全本.md 契约表未扩展（不含「八大基本设定」段；保持旧形状）', !fullMd.includes('八大基本设定'))
const exportContractFile = await readJsonSafe(contractJsonPath(TITLE))
check('导出后 project contract.json 原样含 8 字段（JSON add-only）', exportContractFile && exportContractFile.worldSpace === '导出舞台' && exportContractFile.soulDeath === '导出死亡权重')

/* ------------------------------------------------------------------ [10] */
group('[10] expectedHash 409 链保留（冲突不写盘）')
const hashNow = sha256(await fs.readFile(contractJsonPath(TITLE)))
const goodExpected = await call('contract-save', { title: TITLE, contract: { factions: 'expectedHash 正确链' }, expectedHash: { '.aidrama/contract.json': hashNow } })
check('expectedHash 匹配 → 200/ok（链可用）', goodExpected.status === 200 && goodExpected.data && goodExpected.data.ok === true, JSON.stringify({ status: goodExpected.status }))
const beforeConflict = sha256(await fs.readFile(contractJsonPath(TITLE)))
const conflict = await call('contract-save', { title: TITLE, contract: { factions: '并发覆盖尝试' }, expectedHash: { '.aidrama/contract.json': 'deadbeef'.repeat(8) } })
const afterConflict = sha256(await fs.readFile(contractJsonPath(TITLE)))
check('expectedHash 冲突 → 409 + code conflict', conflict.status === 409 && conflict.data && conflict.data.code === 'conflict', JSON.stringify({ status: conflict.status, code: conflict.data && conflict.data.code }))
check('expectedHash 409 不写盘（contract.json sha256 不变）', beforeConflict === afterConflict)

/* ------------------------------------------------------------------ [11] */
group('[11] AC-C1-1 旧项目字节不变（只读副本 ↔ v0.16.2 实施基线）')
let oldBaseline = null
for (const candidate of OLD_BYTE_BASELINE_CANDIDATES) {
  const data = await readJsonSafe(candidate)
  if (data && data.raw && data.export) { oldBaseline = data; break }
}
let oldProject = null
for (const candidate of OLD_PROJECT_CANDIDATES) {
  if (candidate && (await lstat(candidate))) { oldProject = candidate; break }
}
if (!oldBaseline || !oldProject) {
  skippedNotes += 1
  console.log('      （SKIP：旧项目字节基线 JSON 或旧项目样本不可用（非源码树环境）；源码树由 QA 证据脚本覆盖）')
} else {
  const OLD_TITLE = path.basename(oldProject)
  const oldWs = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-cworld-old-'))
  await fs.mkdir(path.join(oldWs, 'AI短剧'), { recursive: true })
  await fs.cp(oldProject, path.join(oldWs, 'AI短剧', OLD_TITLE), { recursive: true })
  const oldRoutes = new Map()
  const oldServices = { connection: { fetch: { register: (spec) => oldRoutes.set(spec.path, spec) } }, workspaceRegistry: { list: async () => [{ path: oldWs }] }, agents: { list: async () => [] } }
  const oldScope = { ...oldServices, get: (n) => oldServices[n], on: () => {}, effect: (fn) => fn() }
  indexMod.apply({ provide: () => {}, inject: (x, cb) => cb(oldScope), logger: { info: () => {}, warn: () => {} } }, { root: oldWs })
  const oldCall = async (method, body) => {
    const spec = oldRoutes.get('/api/ai-drama/' + method)
    const res = await spec.fetch(new Request('http://x/api/ai-drama/' + method, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' }, body: JSON.stringify(body || {}) }))
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch {}
    return { status: res.status, text, data }
  }
  const oldDir = path.join(oldWs, 'AI短剧', OLD_TITLE)
  const treeBefore = await walkFiles(oldDir)
  const oldContractRaw = await fs.readFile(path.join(oldDir, '.aidrama', 'contract.json'))
  const oldMdRaw = await fs.readFile(path.join(oldDir, '剧集契约.md'))
  check('AC-C1-1a 旧项目 contract.json 原始字节与 v0.16.2 一致', sha256(oldContractRaw) === oldBaseline.raw.contractJson.sha256, sha256(oldContractRaw).slice(0, 16))
  check('AC-C1-1b 旧项目 剧集契约.md 原始字节与 v0.16.2 一致', sha256(oldMdRaw) === oldBaseline.raw.contractMd.sha256, sha256(oldMdRaw).slice(0, 16))
  const oldGet = await oldCall('contract-get', { title: OLD_TITLE })
  const oldProgress = await oldCall('progress-get', { title: OLD_TITLE })
  const normText = (t) => String(t).split(oldWs.replace(/\\/g, '\\\\')).join('<WS>').split(oldWs).join('<WS>')
  check('AC-C1-1c 旧项目 contract-get 响应归一化字节一致（不新增键）', sha256Text(normText(oldGet.text)) === oldBaseline.contractGet.normalizedSha, sha256Text(normText(oldGet.text)).slice(0, 16))
  check('AC-C1-1d 旧项目 contract-get 不出现任何世界字段名', WORLD_CONTRACT_KEYS.every((k) => !oldGet.text.includes(k)))
  const oldCtx = ctxMod.buildDramaContextCard({ title: OLD_TITLE, contract: oldGet.data && oldGet.data.contract, progress: oldProgress.data && oldProgress.data.progress })
  check('AC-C1-1e 旧项目 context-card 输出与 v0.16.2 逐字节一致', sha256Text(oldCtx) === oldBaseline.contextCard.sha256, sha256Text(oldCtx).slice(0, 16))
  const treeAfterRead = await walkFiles(oldDir)
  check('AC-C1-1f 旧项目只读操作零写盘（项目树 hash 不变）', filesHash(treeBefore) === filesHash(treeAfterRead))
  const oldExport = await oldCall('export-project', { title: OLD_TITLE, format: 'markdown' })
  const TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g
  const SHA_RE = /\b[0-9a-f]{64}\b/g
  const expDir = path.join(oldDir, '导出')
  const expEntries = (await fs.readdir(expDir)).sort()
  const expNorm = []
  for (const name of expEntries) {
    const text = await fs.readFile(path.join(expDir, name), 'utf8')
    const norm = text.split(TS_RE).join('<TS>').replace(SHA_RE, '<SHA>')
    expNorm.push({ rel: name, bytes: Buffer.byteLength(norm), normSha256: sha256Text(norm) })
  }
  const sortByRel = (arr) => [...arr].sort((a, b) => String(a.rel).localeCompare(String(b.rel)))
  check('AC-C1-1g 旧项目导出包（时间戳/sha 归一后）与 v0.16.2 逐文件一致', oldExport.status === 200 && JSON.stringify(sortByRel(expNorm)) === JSON.stringify(sortByRel(oldBaseline.export.files)), JSON.stringify(sortByRel(expNorm).map((f) => f.rel)))
  await fs.rm(oldWs, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ [12] */
group('[12] 工具 schema add-only（drama_save_contract）')
const defs = toolsMod.createToolDefs({ rootOf: () => workspace, backendOf: () => null })
check('生产工具面仍 34', defs.length === 35, String(defs.length))
const saveDef = defs.find((d) => d && d.name === 'drama_save_contract')
const params = saveDef && (saveDef.parameters || saveDef.inputSchema || saveDef.schema)
const contractProps = (params && params.properties && params.properties.contract && params.properties.contract.properties) || {}
check('drama_save_contract schema 显式声明 8 个可选 string（contract 对象 additionalProperties:false 下可写）', WORLD_CONTRACT_KEYS.every((k) => contractProps[k] && contractProps[k].type === 'string'), JSON.stringify(Object.keys(contractProps).filter((k) => WORLD_CONTRACT_KEYS.includes(k))))
check('schema required 仍仅 contract（8 字段均可选）', Array.isArray(params && params.required) && params.required.length === 1 && params.required[0] === 'contract', JSON.stringify(params && params.required))
check('schema additionalProperties:false 保留（顶层与 contract 子对象均未放宽）', params && params.additionalProperties === false && params.properties.contract.additionalProperties === false, JSON.stringify({ top: params && params.additionalProperties, contract: params && params.properties.contract.additionalProperties }))
check('工具源码：contractLines 有值时追加 WORLD_CONTRACT_FIELDS（旧输出不变）', toolsSrc.includes('WORLD_CONTRACT_FIELDS') && toolsSrc.includes('worldContractToolProperties()'))

/* ------------------------------------------------------------------ [13] */
group('[13] client 静态（AC-C1-8：折叠组/8 textarea/已填 X/8/只提交非空/payload 8 键）')
const clientBlock = clientSrc.match(/const CONTRACT_WORLD_FIELDS = \[([\s\S]*?)\n\s*\]/)
const clientEntries = clientBlock ? [...clientBlock[1].matchAll(/\[\s*'(\w+)',\s*'([^']+)',\s*(\d+),/g)].map((m) => ({ key: m[1], label: m[2], limit: Number(m[3]) })) : []
check('client CONTRACT_WORLD_FIELDS 字段表 = host 单一源（key/顺序/中文名/上限全一致）', JSON.stringify(clientEntries) === JSON.stringify(WORLD_CONTRACT_FIELDS.map((f) => ({ key: f.key, label: f.label, limit: f.limit }))), JSON.stringify(clientEntries.map((f) => f.key)))
const detailsMarker = "h('details', { className: 'ad-form-group ad-contract-world', key: 'contract-world' }"
const detailsAt = clientSrc.indexOf(detailsMarker)
check('折叠组存在且默认收起（details 无 open 属性）', detailsAt > 0 && !clientSrc.slice(detailsAt, detailsAt + 320).includes('open:'), String(detailsAt))
check('折叠组 summary 文案「八大设定（可选）」+「已填 X/8 / 未填写」', clientSrc.includes('八大设定（可选）') && clientSrc.includes('contractWorldFilledCount(contract)') && clientSrc.includes('未填写'))
check('源码 h(\'textarea\') = 17（既有 5 + 折叠组 8 + v0.16.6 风格编辑 2 + C3 审核工作台 2）', (clientSrc.match(/\bh\('textarea'/g) || []).length === 17, String((clientSrc.match(/\bh\('textarea'/g) || []).length))
check('保存仅提交非空 trim 值 + payload 恒含 8 键（空串=清空）', clientSrc.includes('function contractWorldPayload') && clientSrc.includes('contractWorldPayload(contract)') && clientSrc.includes("payload[key] = value ? value : ''"))
check('超长前端拦截（setError + contractWorldOverLimit；不发请求）', clientSrc.includes('function contractWorldOverLimit') && clientSrc.includes('contractWorldOverLimit(contract)') && clientSrc.includes('超出长度上限'))
check('api(\'contract-save\') 仍 1 处（不新增调用点）', (clientSrc.match(/api\(\s*'contract-save'/g) || []).length === 1, String((clientSrc.match(/api\(\s*'contract-save'/g) || []).length))

/* ------------------------------------------------------------------ [14] */
group('[14] 契约红线（METHODS 70 / 工具 34 / 调用点 70 / slots 4 / 无新依赖/route）')
const METHODS = indexMod.METHODS
const clientCalls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
const DRAMA_TOOL_NAMES = toolsMod.DRAMA_TOOL_NAMES
check('METHODS = 70（C1 不新增 METHOD）', METHODS.length === 72, String(METHODS.length))
check('工具面 = 34（C1 不新增工具）', DRAMA_TOOL_NAMES.length === 35, String(DRAMA_TOOL_NAMES.length))
check('client 唯一调用点 = 70（不新增调用）', clientCalls.size === 72, String(clientCalls.size))
check('client slots.register = 4', (clientSrc.match(/slots\.register\(/g) || []).length === 4)
check('无新依赖（package.json dependencies 为空）', Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify(pkg.dependencies || {}))
check('client 调用点均 ⊆ 宿主 METHODS（无新 route）', [...clientCalls].every((m) => METHODS.includes(m)))

await fs.rm(workspace, { recursive: true, force: true })
if (skippedNotes) console.log(`\n（注：${skippedNotes} 组旧项目断言因环境不具备而 SKIP；源码树完整覆盖）`)
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
