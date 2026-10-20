/**
 * v0.16.9 C3-Q（E16 + H-8 `asset-save`）· 资产多轮审核验收套件（第 52 套件）
 *
 * 需求：需求分析-C3-资产多轮审核-E16-v1.md v1.7（AC-C3-1…24）；Lead 2026-10-21 代码冻结（回滚 v0.16.8）。
 * 冻结基线：client e36e520e…/613,238B + index 63a357ae…/94,279B（METHODS 72）；工具 35；0 真实模型。
 * 覆盖：工程契约/旧项目·旧卡零写回/默认响应不变/includeReviewHashes/asset-save 状态机/
 *      rounds≤20/场景卡/审计/工具层 permission/AST-07/导出·复制静态/旧数据 32 hash/client 静态。
 * 用法：node test/asset-review.mjs
 */
import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argOf = (name, fallback = '') => {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const resolvePlugin = (candidates) => {
  for (const candidate of candidates) if (candidate && existsSync(path.join(candidate, 'index.js'))) return path.resolve(candidate)
  return path.resolve(candidates[candidates.length - 1])
}
const PLUGIN = resolvePlugin([
  argOf('plugin'),
  path.join(HERE, '..'),
  path.join(HERE, '..', '..', 'ai-drama-plugin'),
])
const BASELINE = resolvePlugin([
  argOf('baseline'),
  path.join(HERE, '..', '_recover', 'pack-0.16.8', 'ai-drama-plugin'),
])
if (!existsSync(path.join(BASELINE, 'index.js'))) {
  console.log('\n结果：0 passed, 0 failed（SKIP：v0.16.8 基线包不在本机环境（安装副本/源码树外））')
  process.exit(0)
}
const EXPECT_METHODS = Number(argOf('expect-methods', '') || process.env.DSH_AI_DRAMA_EXPECT_METHODS || '72')
const REAL_ROOT = process.env.DSH_AI_DRAMA_REAL_ROOT || path.join(PLUGIN, '..', 'AI短剧')
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const readTextOf = async (file) => {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}
const results = []
let passed = 0
let failed = 0
const check = (id, label, ok, detail) => {
  const row = { id, label, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail).slice(0, 900) }
  results.push(row)
  if (row.ok) {
    passed += 1
    console.log(`  PASS  [${id}] ${label}${row.detail ? ` -> ${row.detail}` : ''}`)
  } else {
    failed += 1
    console.log(`  FAIL  [${id}] ${label}${row.detail ? ` -> ${row.detail}` : ''}`)
  }
}
const group = (name) => console.log(`\n${name}`)
const load = (root, rel) => import(pathToFileURL(path.join(root, rel)).href)

/* ---------------------------------------------------------------- 模块 */
const indexMod = await load(PLUGIN, 'index.js')
const toolsMod = await load(PLUGIN, 'lib/tools.js')
const store = await load(PLUGIN, 'lib/store.js')
const assetsMod = await load(PLUGIN, 'lib/assets.js')
const gatesMod = await load(PLUGIN, 'lib/asset-gates.js')
const pkg = JSON.parse(await fs.readFile(path.join(PLUGIN, 'package.json'), 'utf8'))
const baselineIndex = await load(BASELINE, 'index.js')
const baselineMethods = baselineIndex.METHODS
const clientSrc = await fs.readFile(path.join(PLUGIN, 'client.js'), 'utf8').catch(() => '')

function makeHarness(indexModule, rootDir) {
  const routes = new Map()
  const ctx = {
    provide: () => {},
    inject(_services, callback) {
      callback({
        connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } },
        commands: { register: () => () => {} },
        agents: { list: () => [], roots: () => [] },
        workspaceRegistry: { list: async () => [{ path: rootDir }] },
        get: (name) => (name === 'workspaceRegistry' ? { list: async () => [{ path: rootDir }] } : name === 'agents' ? { list: () => [] } : undefined),
        on: () => {},
        effect: (fn) => fn(),
      })
    },
    logger: { info: () => {}, warn: () => {} },
  }
  indexModule.apply(ctx, { root: rootDir })
  return async (method, body) => {
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
}

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'v0169-c3-'))
const BASE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'v0169-c3-base-'))
const call = makeHarness(indexMod, ROOT)
const baseCall = makeHarness(baselineIndex, BASE_ROOT)
const projectDirOf = (root, title) => path.join(root, 'AI短剧', title)
const metaDirOf = (root, title) => path.join(projectDirOf(root, title), '.aidrama')
const cardsPath = (root, title, kind) => path.join(metaDirOf(root, title), kind === 'scene' ? 'scenes' : 'assets', 'cards.json')
const readCards = async (root, title, kind) => {
  const text = await readTextOf(cardsPath(root, title, kind))
  try {
    return { text, doc: text ? JSON.parse(text) : null }
  } catch {
    return { text, doc: null }
  }
}
const writeCards = async (root, title, kind, doc) => {
  await fs.mkdir(path.dirname(cardsPath(root, title, kind)), { recursive: true })
  await fs.writeFile(cardsPath(root, title, kind), `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}
const stripWorkspace = (body) => {
  if (!body || typeof body !== 'object') return body
  const copy = { ...body }
  delete copy.workspace
  delete copy.workspaceSource
  // v0.16.10（M3）：assets-get add-only registryOk；与旧基线对比时剔除
  delete copy.registryOk
  return copy
}
const cardReview = (doc, index = 0) => (doc && Array.isArray(doc.assets) ? doc.assets[index].review : undefined)
const HASH0 = ''

/* ================================================================== [A] 工程契约 */
group('[A] 工程契约（METHODS 71→72 / 工具 34→35 / AST-07 单一源）')
check('A1', `METHODS = ${EXPECT_METHODS}（唯一 +asset-save）`, indexMod.METHODS.length === EXPECT_METHODS, `${indexMod.METHODS.length}（按新基座可用 --expect-methods=${indexMod.METHODS.length}）`)
check('A2', 'METHODS 相对基线仅 +asset-save（位置在 assets-remove 后）', (() => {
  const current = indexMod.METHODS
  const added = current.filter((name) => !baselineMethods.includes(name))
  const removed = baselineMethods.filter((name) => !current.includes(name))
  return added.length === 1 && added[0] === 'asset-save' && removed.length === 0 && current.indexOf('asset-save') === current.indexOf('assets-remove') + 1
})(), `baseline=${baselineMethods.length}`)
check('A3', '工具 35（仅 +drama_asset_save）', toolsMod.DRAMA_TOOL_NAMES.length === 35 && toolsMod.DRAMA_TOOL_NAMES.includes('drama_asset_save'), `${toolsMod.DRAMA_TOOL_NAMES.length}`)
check('A4', '无新依赖', Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify(pkg.dependencies || {}))
check('A5', 'AST-07 已注册 asset-gates（ids 7 条）', gatesMod.ASSET_JUDGE_IDS.includes('AST-07') && gatesMod.ASSET_JUDGE_IDS.length === 7, JSON.stringify(gatesMod.ASSET_JUDGE_IDS))
const criteriaRules = await load(PLUGIN, 'lib/criteria-rules.js')
const ruleSet = await criteriaRules.loadRuleSet({ refresh: true }).catch(() => null)
check('A6', 'rules/assets.json 含 AST-07（单一源；7 条 judge）', Boolean(ruleSet && Array.isArray(ruleSet.assetJudges) && ruleSet.assetJudges.length === 7 && ruleSet.assetJudges.some((judge) => judge.id === 'AST-07')), JSON.stringify(ruleSet && ruleSet.assetJudges && ruleSet.assetJudges.map((j) => j.id)))
check('A7', '工具 schema 存在（drama_asset_save 定义）', (() => {
  const source = toolsMod.createToolDefs
  return typeof source === 'function' && toolsMod.DRAMA_TOOL_NAMES.includes('drama_asset_save')
})(), '')
check('A8', 'client.js 存在（不硬绑 SHA；C3-C 并行会改）', clientSrc.length > 1000, `${clientSrc.length}B`)

/* ================================================================== [B] 旧项目零影响 */
group('[B] 旧项目/旧卡零写回 + 默认响应不变 + AST-07 不改变旧项目检查输出')
const T_OLD = 'C3-旧项目'
await call('create-project', { title: T_OLD })
await baseCall('create-project', { title: T_OLD })
const noCards = await call('assets-get', { title: T_OLD })
const baseNoCards = await baseCall('assets-get', { title: T_OLD })
check('B1', '无卡项目 assets-get 默认响应与基线逐字段一致（无 hash/review 键）', JSON.stringify(stripWorkspace(noCards.body)) === JSON.stringify(stripWorkspace(baseNoCards.body)), JSON.stringify(Object.keys(noCards.body || {})).slice(0, 200))
check('B2', '读取不建 cards 目录/文件', !(await readTextOf(cardsPath(ROOT, T_OLD, 'asset'))) && !(await readTextOf(cardsPath(ROOT, T_OLD, 'scene'))), '')
const noCardsHash = await call('assets-get', { title: T_OLD, includeReviewHashes: true })
check('B3', 'includeReviewHashes:true + 无卡文件 → 不返回 cardsHash/scenesHash', !Object.hasOwn(noCardsHash.body || {}, 'cardsHash') && !Object.hasOwn(noCardsHash.body || {}, 'scenesHash'), JSON.stringify(Object.keys(noCardsHash.body || {})).slice(0, 200))
const oldChecks = await call('consistency-check', { title: T_OLD, deep: false })
const baseOldChecks = await baseCall('consistency-check', { title: T_OLD, deep: false })
check('B4', '无卡项目 consistency-check：输出不含 AST-07（旧项目检查输出结构不变）', !JSON.stringify(oldChecks.body || {}).includes('AST-07') && !JSON.stringify(baseOldChecks.body || {}).includes('AST-07') && oldChecks.status === 200 && baseOldChecks.status === 200, JSON.stringify(Object.keys(oldChecks.body || {})).slice(0, 200))
const gatesEmpty = gatesMod.runAssetGates({ cards: [], shotsByEpisode: [], ruleSet })
check('B5', 'AST-07 evaluator：无卡返回 null（runAssetGates 仍 6 条）', gatesEmpty.length === 6 && !gatesEmpty.some((item) => item.id === 'AST-07'), String(gatesEmpty.length))

/* ================================================================== [C] 既有卡 saveDraft / hash 读侧（C3 不新建卡：卡由剥离/导入创建） */
group('[C] asset-save saveDraft（既有卡）+ review 读侧 + cardsHash')
const T_MAIN = 'C3-主剧'
await call('create-project', { title: T_MAIN })
await store.saveAssetCard(ROOT, T_MAIN, { id: 'CHR001', type: 'CHR', name: '白衣剑客', status: 'draft' })
const mainBefore = await readCards(ROOT, T_MAIN, 'asset')
const mainHash0 = sha256(Buffer.from(mainBefore.text, 'utf8'))
const created = await call('asset-save', { title: T_MAIN, kind: 'asset', id: 'CHR001', action: 'saveDraft', prompt: '白衣剑客，冷峻', expectedHash: mainHash0 })
const mainDoc = await readCards(ROOT, T_MAIN, 'asset')
check('C1', '既有卡 saveDraft → 200（draft/revision1/promptVersion1）', created.status === 200 && created.body && created.body.review && created.body.review.status === 'draft' && created.body.review.revision === 1 && created.body.review.promptVersion === 1 && created.body.review.currentPrompt === '白衣剑客，冷峻', JSON.stringify(created.body && created.body.review).slice(0, 300))
check('C2', '响应 hash = 写后 cards.json sha256；bytes 一致', created.body && created.body.hash === sha256(Buffer.from(mainDoc.text, 'utf8')) && created.body.bytes === Buffer.byteLength(mainDoc.text, 'utf8'), JSON.stringify({ hash: created.body && created.body.hash, file: sha256(Buffer.from(mainDoc.text, 'utf8')) }).slice(0, 200))
check('C3', 'target 文件只写 assets（scenes 未建）', Boolean(mainDoc.text) && !(await readTextOf(cardsPath(ROOT, T_MAIN, 'scene'))), '')
const withHash = await call('assets-get', { title: T_MAIN, includeReviewHashes: true })
check('C4', 'includeReviewHashes:true → cardsHash = 当前 cards.json sha256', withHash.body.cardsHash === sha256(Buffer.from(mainDoc.text, 'utf8')), JSON.stringify(withHash.body && withHash.body.cardsHash))
const assetsWithReview = await call('assets-get', { title: T_MAIN })
check('C5', 'assets-get.cards[i].review add-only 返回（旧卡无 review 不输出）', assetsWithReview.body.cards[0].review && assetsWithReview.body.cards[0].review.status === 'draft', JSON.stringify(assetsWithReview.body.cards[0].review).slice(0, 200))
check('C6', 'cardsHash 与 asset-save.expectedHash 同口径（可直接用于下一写）', withHash.body.cardsHash === created.body.hash, `${withHash.body.cardsHash}`)

/* ================================================================== [D] 旧卡零写回 */
group('[D] 旧卡（无 review）读取零写回 + 首写补 review + 未知字段保留')
const T_LEGACY = 'C3-旧卡剧'
await call('create-project', { title: T_LEGACY })
const legacyDoc = { schemaVersion: 1, assets: [{ id: 'CHR007', type: 'CHR', name: '旧角色', version: 2, fields: { keep: 'yes' }, prompts: { image: '旧提示词' }, history: [] }] }
await writeCards(ROOT, T_LEGACY, 'asset', legacyDoc)
await baseCall('create-project', { title: T_LEGACY })
await writeCards(BASE_ROOT, T_LEGACY, 'asset', legacyDoc)
const legacyBytes = (await readCards(ROOT, T_LEGACY, 'asset')).text
const legacyAssets = await call('assets-get', { title: T_LEGACY })
const baseLegacyAssets = await baseCall('assets-get', { title: T_LEGACY })
check('D1', '旧卡 assets-get 默认响应与基线逐字段一致（无 review 键/hash）', JSON.stringify(stripWorkspace(legacyAssets.body)) === JSON.stringify(stripWorkspace(baseLegacyAssets.body)) && !Object.hasOwn(legacyAssets.body.cards[0], 'review'), '')
check('D2', '旧卡读取后字节不变', (await readCards(ROOT, T_LEGACY, 'asset')).text === legacyBytes, '')
const legacyHashRes = await call('assets-get', { title: T_LEGACY, includeReviewHashes: true })
check('D3', '旧卡 + includeReviewHashes:true → cardsHash = 文件 sha256（默认调用不出现）', legacyHashRes.body.cardsHash === sha256(Buffer.from(legacyBytes, 'utf8')) && !Object.hasOwn(legacyAssets.body, 'cardsHash'), '')
const legacySaved = await call('asset-save', { title: T_LEGACY, kind: 'asset', id: 'CHR007', action: 'saveDraft', prompt: '更新后的提示词', expectedHash: legacyHashRes.body.cardsHash })
const legacyDocAfter = (await readCards(ROOT, T_LEGACY, 'asset')).doc
check('D4', '旧卡首写 saveDraft → 200，补 review 且未知字段/旧版本保留', legacySaved.status === 200 && cardReview(legacyDocAfter).status === 'draft' && legacyDocAfter.assets[0].version === 2 && legacyDocAfter.assets[0].fields.keep === 'yes' && legacyDocAfter.assets[0].prompts.image === '旧提示词', JSON.stringify(legacyDocAfter.assets[0]).slice(0, 320))

/* ================================================================== [E] 参数/负例 */
group('[E] 参数/负例（400/404/409/transport）')
const hashNow = async (root, title, kind) => sha256(Buffer.from((await readCards(root, title, kind)).text || '', 'utf8'))
let negativeOk = 0
const negativeCases = [
  ['未知业务键', { kind: 'asset', id: 'CHR001', action: 'saveDraft', prompt: 'x', expectedHash: '', bogus: 1 }, 400, 'invalid-args'],
  ['kind 非法', { kind: 'foo', id: 'CHR001', action: 'saveDraft', prompt: 'x', expectedHash: '' }, 400, 'invalid-args'],
  ['kind=asset 但 id 非法', { kind: 'asset', id: 'XXX', action: 'saveDraft', prompt: 'x', expectedHash: '' }, 400, 'invalid-args'],
  ['action 非法', { kind: 'asset', id: 'CHR001', action: 'lock', expectedHash: '' }, 400, 'invalid-args'],
  ['saveDraft 缺 prompt', { kind: 'asset', id: 'CHR001', action: 'saveDraft', expectedHash: '' }, 400, 'invalid-args'],
]
for (const [label, body, status, code] of negativeCases) {
  const res = await call('asset-save', { title: T_MAIN, ...body })
  if (res.status === status && res.body && res.body.code === code) negativeOk += 1
  else console.log(`      （${label} 返回 ${res.status}/${res.body && res.body.code}）`)
}
check('E1', '5 类入参负例 → 400 invalid-args', negativeOk === negativeCases.length, `${negativeOk}/${negativeCases.length}`)
const wrongHash = await call('asset-save', { title: T_MAIN, kind: 'asset', id: 'CHR001', action: 'saveDraft', prompt: 'x', expectedHash: '0'.repeat(64) })
check('E2', 'expectedHash 不符 → 409 conflict + currentHash（不写盘）', wrongHash.status === 409 && wrongHash.body.code === 'conflict' && wrongHash.body.currentHash === created.body.hash, JSON.stringify({ status: wrongHash.status, currentHash: wrongHash.body && wrongHash.body.currentHash }).slice(0, 200))
const emptyWhenExists = await call('asset-save', { title: T_MAIN, kind: 'asset', id: 'CHR001', action: 'saveDraft', prompt: 'x', expectedHash: '' })
check('E3', '文件存在 + expectedHash:"" → 409 conflict（不写盘）', emptyWhenExists.status === 409 && emptyWhenExists.body.code === 'conflict', '')
await call('create-project', { title: 'C3-无文件剧' })
const nonEmptyWhenAbsent = await call('asset-save', { title: 'C3-无文件剧', kind: 'asset', id: 'CHR001', action: 'saveDraft', prompt: 'x', expectedHash: '0'.repeat(64) })
check('E4', '无文件/无卡 + （任意）expectedHash → 404 not-found（不建文件、不写盘）', nonEmptyWhenAbsent.status === 404 && nonEmptyWhenAbsent.body.code === 'not-found' && !(await readTextOf(cardsPath(ROOT, 'C3-无文件剧', 'asset'))), JSON.stringify(nonEmptyWhenAbsent.body).slice(0, 200))
await call('create-project', { title: 'C3-无文件剧2' })
const absentCard = await call('asset-save', { title: 'C3-无文件剧2', kind: 'asset', id: 'CHR001', action: 'saveDraft', prompt: 'x', expectedHash: '' })
check('E4b', '无卡文件 + expectedHash:"" → 404 not-found（expectedHash 不用于创建）', absentCard.status === 404 && absentCard.body.code === 'not-found' && !(await readTextOf(cardsPath(ROOT, 'C3-无文件剧2', 'asset'))), `${absentCard.status}/${absentCard.body && absentCard.body.code}`)
const missingCard = await call('asset-save', { title: T_MAIN, kind: 'asset', id: 'CHR999', action: 'saveDraft', prompt: 'x', expectedHash: await hashNow(ROOT, T_MAIN, 'asset') })
check('E5', '卡不存在 → 404 not-found', missingCard.status === 404 && missingCard.body.code === 'not-found', '')
const transport = await call('asset-save', { title: T_MAIN, kind: 'asset', id: 'CHR001', action: 'saveDraft', prompt: '带 transport 的提示词', expectedHash: created.body.hash, cwd: ROOT, sessionId: 'sess-c3' })
check('E6', 'transport cwd/sessionId 被剔除 → 200（业务未知键仍 400）', transport.status === 200 && transport.body.ok === true, JSON.stringify({ status: transport.status, code: transport.body && transport.body.code }).slice(0, 200))
const promptTooLong = await call('asset-save', { title: T_MAIN, kind: 'asset', id: 'CHR001', action: 'saveDraft', prompt: '甲'.repeat(2001), expectedHash: transport.body.hash })
check('E7', 'prompt >2000 → 400 invalid-args', promptTooLong.status === 400 && promptTooLong.body.code === 'invalid-args', '')
const rejectNoReason = await call('asset-save', { title: T_MAIN, kind: 'asset', id: 'CHR001', action: 'reject', expectedHash: transport.body.hash })
check('E8', 'reject 缺 reason → 400 invalid-args（pending 前也先 400）', rejectNoReason.status === 400 && rejectNoReason.body.code === 'invalid-args', '')

/* ================================================================== [F] 状态机主链 + 423 + reopen */
group('[F] 状态机：draft→pending→rejected→draft→pending→approved→final→423→reopen')
const T_CHAIN = 'C3-链路剧'
await call('create-project', { title: T_CHAIN })
await store.saveAssetCard(ROOT, T_CHAIN, { id: 'CHR002', type: 'CHR', name: '待审角色', status: 'draft' })
let cur = await call('asset-save', { title: T_CHAIN, kind: 'asset', id: 'CHR002', action: 'saveDraft', prompt: '第一版提示词', expectedHash: sha256(Buffer.from((await readCards(ROOT, T_CHAIN, 'asset')).text, 'utf8')) })
const step = async (body) => {
  const res = await call('asset-save', { title: T_CHAIN, kind: 'asset', id: 'CHR002', ...body, expectedHash: await hashNow(ROOT, T_CHAIN, 'asset') })
  return res
}
const submit1 = await step({ action: 'submit' })
check('F1', 'submit → pending，roundCount=1，rounds[0] pending', submit1.status === 200 && submit1.body.review.status === 'pending' && submit1.body.review.roundCount === 1 && submit1.body.review.rounds.length === 1 && submit1.body.review.rounds[0].status === 'pending', JSON.stringify(submit1.body && submit1.body.review).slice(0, 300))
const reject1 = await step({ action: 'reject', reason: '提示词不符合角色设定' })
check('F2', 'reject（reason 必填）→ rejected，rounds[-1] rejected + reason', reject1.status === 200 && reject1.body.review.status === 'rejected' && reject1.body.review.rounds.at(-1).status === 'rejected' && reject1.body.review.rounds.at(-1).reason === '提示词不符合角色设定', '')
const editAfterReject = await step({ action: 'saveDraft', prompt: '第二版提示词' })
check('F3', 'rejected 下 saveDraft → 自动回 draft，promptVersion+1，rounds 保留', editAfterReject.status === 200 && editAfterReject.body.review.status === 'draft' && editAfterReject.body.review.promptVersion === 2 && editAfterReject.body.review.rounds.length === 1, '')
const submit2 = await step({ action: 'submit' })
check('F4', '再 submit → pending，roundCount=2', submit2.status === 200 && submit2.body.review.roundCount === 2 && submit2.body.review.rounds.length === 2, '')
const approve = await step({ action: 'approve' })
check('F5', 'approve → approved + approvedAt/By，最后一轮 approved', approve.status === 200 && approve.body.review.status === 'approved' && approve.body.review.approvedBy === 'panel' && approve.body.review.rounds.at(-1).status === 'approved', JSON.stringify(approve.body && approve.body.review).slice(0, 300))
const finalize = await step({ action: 'finalize' })
check('F6', 'finalize → final + finalPrompt=currentPrompt + finalizedAt/By', finalize.status === 200 && finalize.body.review.status === 'final' && finalize.body.review.finalPrompt === '第二版提示词' && finalize.body.review.finalizedBy === 'panel', '')
const beforeLockText = (await readCards(ROOT, T_CHAIN, 'asset')).text
const lockedDoc = JSON.parse(beforeLockText)
const lockedReview = lockedDoc.assets.find((card) => card.id === 'CHR002').review
const lockedSave = await call('asset-save', { title: T_CHAIN, kind: 'asset', id: 'CHR002', action: 'saveDraft', prompt: '锁后尝试', expectedHash: sha256(Buffer.from(beforeLockText, 'utf8')) })
check('F7', 'final 写 saveDraft → 423 asset-locked（body 顶层 review/currentHash/expectedHash）', lockedSave.status === 423 && lockedSave.body.code === 'asset-locked' && lockedSave.body.review && lockedSave.body.review.status === 'final' && typeof lockedSave.body.currentHash === 'string', JSON.stringify({ status: lockedSave.status, code: lockedSave.body && lockedSave.body.code, review: lockedSave.body && lockedSave.body.review && lockedSave.body.review.status }).slice(0, 220))
check('F8', '423 不写盘（hash/revision/round 不变）', (await readCards(ROOT, T_CHAIN, 'asset')).text === beforeLockText && lockedReview.revision === finalize.body.review.revision, `${lockedReview.revision}/${finalize.body.review.revision}`)
const finalizeAgain = await step({ action: 'finalize' })
check('F9', 'final 下 finalize → 423 asset-locked（非 409）', finalizeAgain.status === 423 && finalizeAgain.body.code === 'asset-locked', `${finalizeAgain.status}/${finalizeAgain.body && finalizeAgain.body.code}`)
const reopenShort = await step({ action: 'reopen', reason: '短' })
check('F10', 'reopen reason 过短 → 400 invalid-args', reopenShort.status === 400 && reopenShort.body.code === 'invalid-args', '')
const reopen = await step({ action: 'reopen', reason: '需要补拍新造型' })
check('F11', 'reopen → draft，reopenCount+1，rounds/finalPrompt 历史保留', reopen.status === 200 && reopen.body.review.status === 'draft' && reopen.body.review.reopenCount === 1 && reopen.body.review.rounds.length === 2 && reopen.body.review.finalPrompt === '第二版提示词', JSON.stringify(reopen.body && reopen.body.review).slice(0, 320))
const editAfterReopen = await step({ action: 'saveDraft', prompt: '第三版提示词' })
check('F12', 'reopen 后可继续编辑（promptVersion+1）', editAfterReopen.status === 200 && editAfterReopen.body.review.status === 'draft' && editAfterReopen.body.review.promptVersion === 3, '')
const badTransition = await step({ action: 'approve' })
check('F13', 'draft 下 approve → 409 state-conflict（带 review）', badTransition.status === 409 && badTransition.body.code === 'state-conflict' && badTransition.body.review && badTransition.body.review.status === 'draft', `${badTransition.status}/${badTransition.body && badTransition.body.code}`)

/* ================================================================== [G] rounds 上限（纯函数） */
group('[G] rounds ≤20（丢最旧、roundCount 累计）')
const rounds20 = Array.from({ length: 20 }, (_, index) => ({ round: index + 1, prompt: `p${index}`, promptVersion: index, status: 'approved', submittedAt: 'T' }))
const cappedReview = assetsMod.normalizeReview({ status: 'draft', roundCount: 20, round: 20, promptVersion: 20, currentPrompt: 'p19', rounds: rounds20, unfreezeCount: 0 })
const planned = assetsMod.planReviewAction({ review: { ...cappedReview, status: 'draft' }, action: 'submit', now: 'T2' })
check('G1', 'submit 后 rounds 保留最新 20、roundCount=21', planned.rounds.length === 20 && planned.roundCount === 21 && planned.rounds.at(-1).round === 21 && planned.rounds[0].round === 2, `len=${planned.rounds.length}, count=${planned.roundCount}`)

/* ================================================================== [H] 场景卡同链 */
group('[H] 场景卡（scenes/cards.json）同链 + 零相机锁')
const T_SCENE = 'C3-场景剧'
await call('create-project', { title: T_SCENE })
await writeCards(ROOT, T_SCENE, 'scene', { schemaVersion: 1, scenes: [{ id: 'SPC001', name: '雨夜长街', description: '旧场景', space: { location: '长街', interior: '外景' }, lighting: '冷光', assetRefs: [], notes: '' }] })
const sceneHashRes = await call('assets-get', { title: T_SCENE, includeReviewHashes: true })
check('H1', '场景卡 + includeReviewHashes:true → scenesHash = 文件 sha256', sceneHashRes.body.scenesHash === sha256(Buffer.from((await readCards(ROOT, T_SCENE, 'scene')).text, 'utf8')), JSON.stringify(sceneHashRes.body && sceneHashRes.body.scenesHash))
const sceneSave = await call('asset-save', { title: T_SCENE, kind: 'scene', id: 'SPC001', action: 'saveDraft', prompt: '雨夜长街，霓虹倒影', expectedHash: sceneHashRes.body.scenesHash })
const sceneDocAfter = (await readCards(ROOT, T_SCENE, 'scene')).doc
check('H2', '场景 saveDraft → 200，review 写入 scenes/cards.json', sceneSave.status === 200 && sceneDocAfter.scenes[0].review.status === 'draft', JSON.stringify(sceneDocAfter.scenes[0].review).slice(0, 200))
check('H3', '零相机锁不被 review 破坏（无镜头参数字段）', !Object.hasOwn(sceneDocAfter.scenes[0], 'camera') && !Object.hasOwn(sceneDocAfter.scenes[0].review, 'camera') && sceneDocAfter.scenes[0].name === '雨夜长街', '')
const sceneSubmit = await call('asset-save', { title: T_SCENE, kind: 'scene', id: 'SPC001', action: 'submit', expectedHash: sha256(Buffer.from((await readCards(ROOT, T_SCENE, 'scene')).text, 'utf8')) })
check('H4', '场景 submit → pending（roundCount=1）', sceneSubmit.status === 200 && sceneSubmit.body.review.status === 'pending' && sceneSubmit.body.review.roundCount === 1, '')

/* ================================================================== [I] 审计/快照/工具 */
group('[I] 审计 / history 快照 / Agent 工具 permission')
const auditText = (await readTextOf(path.join(metaDirOf(ROOT, T_CHAIN), 'audit', 'audit.jsonl'))) || ''
const auditLines = auditText.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
const reviewAudits = auditLines.filter((entry) => entry && entry.action === 'asset-save')
check('I1', '审计含 asset-save（actor=panel、targets cards.json 前后 hash）', reviewAudits.length >= 6 && reviewAudits.every((entry) => entry.actor === 'panel' && Array.isArray(entry.targets) && entry.targets.some((target) => String(target.path || '').includes('cards.json'))), JSON.stringify(reviewAudits.slice(-1)).slice(0, 320))
check('I2', '审计含前后 hash 变化（写动作）', reviewAudits.some((entry) => entry.targets.some((target) => target.beforeHash && target.afterHash && target.beforeHash !== target.afterHash)), '')
const historyFiles = (await fs.readdir(path.join(metaDirOf(ROOT, T_CHAIN), 'history')).catch(() => [])).filter((name) => name.startsWith('assets-cards.'))
check('I3', 'history 快照 assets-cards.* 存在且 ≤20', historyFiles.length > 0 && historyFiles.length <= 20, `${historyFiles.length} 份`)
check('I4', '工具层：drama_asset_save 非 saveDraft → 失败码 permission', await (async () => {
  try {
    const defs = toolsMod.createToolDefs({ rootOf: () => ROOT, backendOf: () => null, llmOf: () => null, modelSelectionOf: () => ({}) })
    const tool = defs.find((item) => item.name === 'drama_asset_save')
    if (!tool) return false
    const result = await tool.execute({ title: T_CHAIN, kind: 'asset', id: 'CHR002', action: 'submit' }, { agent: { session: { header: { cwd: ROOT } } } })
    return Boolean(result && result.ok === false && (result.code === 'permission' || result.category === 'permission'))
  } catch (error) {
    return Boolean(error && (error.name === 'ToolFailure' || error.code === 'permission'))
  }
})(), '')
check('I5', '工具层：drama_asset_save schema 仅 saveDraft + required kind/id/prompt', await (async () => {
  try {
    const defs = toolsMod.createToolDefs({ rootOf: () => ROOT, backendOf: () => null, llmOf: () => null, modelSelectionOf: () => ({}) })
    const tool = defs.find((item) => item.name === 'drama_asset_save')
    return Boolean(tool && tool.parameters && tool.parameters.additionalProperties === false && JSON.stringify(tool.parameters.properties.action.enum) === JSON.stringify(['saveDraft']) && JSON.stringify(tool.parameters.required) === JSON.stringify(['kind', 'id', 'prompt']))
  } catch {
    return false
  }
})(), '')

/* ================================================================== [J] AST-07 有卡 */
group('[J] AST-07 有卡 → WARN 不阻断')
const gatesLegacy = gatesMod.runAssetGates({ cards: [{ id: 'CHR007', type: 'CHR', name: '旧角色' }], shotsByEpisode: [], ruleSet })
const gatesFinal = gatesMod.runAssetGates({ cards: [{ id: 'CHR007', type: 'CHR', name: '旧角色', review: { status: 'final' } }], shotsByEpisode: [], ruleSet })
check('J1', '有卡（无 review）→ 出现 AST-07 WARN（ok=false，severity=warn）', gatesLegacy.length === 7 && gatesLegacy.some((item) => item.id === 'AST-07' && item.severity === 'warn' && item.ok === false), JSON.stringify(gatesLegacy.find((item) => item.id === 'AST-07')))
check('J2', '全部 final → AST-07 pass（仍 WARN 级，不产生 FAIL）', gatesFinal.find((item) => item.id === 'AST-07') && gatesFinal.find((item) => item.id === 'AST-07').ok === true, '')
const rules = JSON.parse(await fs.readFile(path.join(PLUGIN, 'presets/rules/assets.json'), 'utf8'))
check('J3', 'rules JSON：AST-07 已入 severity.warn（单一源）', rules.severity.warn.includes('AST-07') && rules.judges.filter((judge) => judge.id === 'AST-07').length === 1, JSON.stringify(rules.severity.warn))

/* ================================================================== [K] 导出/复制接线 + 红线 */
group('[K] 导出/复制接线（静态）+ 旧数据 32 hash 红线')
const exporterSrc = await fs.readFile(path.join(PLUGIN, 'lib', 'exporter.js'), 'utf8')
const importSrc = await fs.readFile(path.join(PLUGIN, 'lib', 'import-assets.js'), 'utf8')
check('K1', '导出接线：reviewStatus + finalPrompt（仅 final）', /reviewStatus: review\.status/.test(exporterSrc) && /review\.status === 'final'/.test(exporterSrc) && (exporterSrc.match(/finalPrompt: review\.finalPrompt/g) || []).length >= 2, '')
check('K2', '复制接线：review-reset warning + 源无 review 不新增', /code: 'review-reset'/.test(importSrc) && /resetReviewForCopy\(sourceCard\.review/.test(importSrc) && /resetReviewForCopy\(scene\.review/.test(importSrc), '')
let oldDataText = null
for (const candidate of [path.join(PLUGIN, '..', 'AI短剧工作区', '证据', 'P2-1-旧数据基线-2026-10-17.json')]) {
  oldDataText = await readTextOf(candidate)
  if (oldDataText) break
}
if (!oldDataText) {
  console.log('      （SKIP：旧数据基线未找到）')
} else {
  const baseline = JSON.parse(oldDataText)
  const files = []
  async function walkReal(dir, relBase = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name)
      const rel = path.join(relBase, entry.name)
      if (entry.isDirectory()) await walkReal(abs, rel)
      else {
        const buffer = await fs.readFile(abs).catch(() => null)
        if (buffer) files.push({ relative: rel, sha256: sha256(buffer) })
      }
    }
  }
  await walkReal(REAL_ROOT)
  const baseMap = new Map(baseline.files.map((item) => [item.relative, item]))
  const currentMap = new Map(files.map((item) => [item.relative, item]))
  const changed = [...baseMap.keys()].filter((key) => currentMap.has(key) && currentMap.get(key).sha256 !== baseMap.get(key).sha256)
  check('K3', `旧数据 ${baseline.files.length} 文件 hash 不变`, changed.length === 0, JSON.stringify(changed).slice(0, 200))
}

/* ================================================================== 汇总 */

/* ---------------------------------------------------------------- 客户端静态（C3-C） */
group('[L] client 静态（C3-C 审核工作台）')
check('L1', 'client 使用 includeReviewHashes:true（assets-get）', /includeReviewHashes:\s*true/.test(clientSrc))
check('L2', 'asset-save 调用仅 1 处', (clientSrc.match(/api\(\s*'asset-save'/g) || []).length === 1, String((clientSrc.match(/api\(\s*'asset-save'/g) || []).length))
check('L3', 'client 去重调用点 = 72', (() => { const calls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1])); return calls.size === 72 })(), '')
check('L4', '审核工作台标记（审核工作台/待审/驳回/重打开/提交审核）', ['审核工作台', '待审', '驳回', '重打开', '提交审核'].every((m) => clientSrc.includes(m)))
check('L5', '423 asset-locked 与 409 提示接线', clientSrc.includes('asset-locked') && clientSrc.includes('state-conflict'))
check('L6', 'final 冻结态写控件禁用标记', /styleFrozen|assetFrozen|reviewFrozen|disabled:.*final/.test(clientSrc))
check('L7', '工具 35（不新增其他工具）', toolsMod.DRAMA_TOOL_NAMES.length === 35 && toolsMod.DRAMA_TOOL_NAMES.includes('drama_asset_save'), String(toolsMod.DRAMA_TOOL_NAMES.length))

await fs.rm(ROOT, { recursive: true, force: true })
await fs.rm(BASE_ROOT, { recursive: true, force: true }).catch(() => {})
console.log('\n结果：' + passed + ' passed, ' + failed + ' failed')
if (failed) {
  console.log('失败项：')
  for (const row of results.filter((item) => !item.ok)) console.log('  - [' + row.id + '] ' + row.label + (row.detail ? ' -> ' + row.detail : ''))
}
process.exit(failed === 0 ? 0 : 1)
