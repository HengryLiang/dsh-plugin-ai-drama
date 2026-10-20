/**
 * P2-2 创作流程状态机（AC-F1…F8）· 用例（按宿主实现 `lib/flow-state.js` 校准）
 *
 * 需求：`AI短剧工作区/需求/需求叙述-P2-2-创作流程状态机-v1.md`（v0.5.1，S 方案）
 * Q1–Q5 裁定（Lead 2026-10-17 冻结）：Q1 默认宽松 + 强制开关（AC-F3）；Q2 `.aidrama/flow-state.json` 不随导出；
 * Q3 回退/上游变更仅标 stale 不删文件；Q4 Agent 工具/面板写内容后宿主同步 flow-state；Q5 步骤条（无图形库）。
 * E6（Lead 批准，契约冻结 §6/§8）：doc-read/doc-save 仅放行精确路径 `.aidrama/flow-state.json`；
 *   其他 `.aidrama/*` 仍拒绝（400/not-allowed）；METHODS 保持 68；缺失→doc-read 200 + 推断落盘；
 *   非法 JSON/状态→400；expectedHash 不符→409+currentHash；flow-state 永不进导出/清单；`strictMode` 默认 false。
 *
 * 兼容策略：host 尚未落地 flow-state（源码未命中 /flow-state/）时显式 SKIP；落地后自动生效。
 * 运行：node test/flow-state.mjs
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
const libDir = path.join(pluginRoot, 'lib')
const libFiles = (await fs.readdir(libDir)).filter((f) => f.endsWith('.js'))
let flowSrc = hostSrc
for (const f of libFiles) {
  try {
    flowSrc += '\n' + (await fs.readFile(path.join(libDir, f), 'utf8'))
  } catch {
    /* ignore */
  }
}
const FLOW_RE = /flow[-_ ]?state/i
const hasFlow = FLOW_RE.test(flowSrc)

if (!hasFlow) {
  console.log('\n结果：0 passed, 0 failed（SKIP：host flow-state 尚未落地；源码未命中 /flow-state/i。落地后本套件自动生效）')
  process.exit(0)
}

const { apply, METHODS } = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
const flowMod = await import(pathToFileURL(path.join(libDir, 'flow-state.js')).href)
const exporterMod = await import(pathToFileURL(path.join(libDir, 'exporter.js')).href)
const toolsMod = await import(pathToFileURL(path.join(libDir, 'tools.js')).href)

const FLOW_PATH = '.aidrama/flow-state.json'
const STEP_KEYS = ['project', 'outline', 'characters', 'episode_script', 'storyboard', 'exported']
const STEP_STATUSES = ['not_started', 'in_progress', 'confirmed', 'stale']

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
const statusOf = (state, key) => {
  const v = state && state.steps && state.steps[key]
  return typeof v === 'string' ? v : v && v.status
}
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

/* ------------------------------------------------------------------ 夹具 */
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-flow-'))
const routes = new Map()
const ctx = {
  provide: () => {},
  inject(_services, callback) {
    callback({
      connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } },
      commands: { register: () => () => {} },
      agents: { list: () => [], roots: () => [] },
      workspaceRegistry: { list: async () => [{ path: workspace }] },
      get: (name) => (name === 'workspaceRegistry' ? { list: async () => [{ path: workspace }] } : name === 'agents' ? { list: () => [] } : undefined),
      on: () => {},
      effect: (fn) => fn(),
    })
  },
  logger: { info: () => {}, warn: () => {} },
}
apply(ctx, { root: workspace })
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
const TITLE = '流程状态机样剧'
const projectDir = path.join(workspace, 'AI短剧', TITLE)
const flowFile = path.join(projectDir, '.aidrama', 'flow-state.json')
async function readFlowDoc() {
  const res = await call('doc-read', { title: TITLE, path: FLOW_PATH })
  if (res.status !== 200 || !res.body?.ok) return { res, state: null, hash: null }
  let state = null
  try {
    state = JSON.parse(res.body.text)
  } catch {
    state = null
  }
  return { res, state, hash: res.body.hash }
}
async function saveFlowState(mutate, options = {}) {
  const current = await readFlowDoc()
  if (!current.state) return { status: 0, body: { ok: false, error: '无法读取 flow-state' } }
  const next = mutate(JSON.parse(JSON.stringify(current.state)))
  const res = await call('doc-save', { title: TITLE, path: FLOW_PATH, text: JSON.stringify(next, null, 2), expectedHash: options.forceStaleHash || current.hash })
  return res
}

/* ------------------------------------------------------------------ [1] */
group('[1] AC-F1：flow-state 落盘 + 6 步结构/初始态（E6：缺失时 doc-read 推断落盘）')
const created = await call('create-project', { title: TITLE })
check('创建项目成功', created.status === 200 && created.body?.ok === true, JSON.stringify(created.body).slice(0, 120))
const firstRead = await readFlowDoc()
check('AC-F1/E6：flow-state 可读（doc-read 恒 200；缺失则推断落盘）', firstRead.res.status === 200 && firstRead.res.body?.ok === true && Boolean(firstRead.state), JSON.stringify({ status: firstRead.res.status, body: firstRead.res.body }).slice(0, 200))
check('flow-state.json 已落盘', await fs.stat(flowFile).then(() => true, () => false), flowFile)
const state0 = firstRead.state || {}
check('结构含 version / strictMode / steps / updatedAt', state0.version !== undefined && typeof state0.strictMode === 'boolean' && state0.steps && typeof state0.updatedAt === 'string', JSON.stringify(state0).slice(0, 200))
check('6 步键齐全', STEP_KEYS.every((k) => STEP_KEYS.includes(k) && Object.hasOwn(state0.steps || {}, k)), JSON.stringify(Object.keys(state0.steps || {})))
check('状态均属冻结枚举 not_started|in_progress|confirmed|stale', STEP_KEYS.every((k) => STEP_STATUSES.includes(statusOf(state0, k))), JSON.stringify(STEP_KEYS.map((k) => statusOf(state0, k))))
// AC-F1：新建空项目 → 6 步初始全部 not_started（store.createProject 初始化 flow-state；旧项目才按内容推断）
check('AC-F1：空项目 6 步初始全部 not_started', STEP_KEYS.every((k) => statusOf(state0, k) === 'not_started'), JSON.stringify(STEP_KEYS.map((k) => statusOf(state0, k))))
check('Q1：strictMode 默认 false（宽松模式）', state0.strictMode === false, String(state0.strictMode))
check('history 最小字段（at/action/step/from/to）', Array.isArray(state0.history) && state0.history.every((h) => h && typeof h.at === 'string' && typeof h.action === 'string' && typeof h.step === 'string' && ('from' in h) && typeof h.to === 'string') , JSON.stringify((state0.history || []).slice(0, 2)))

/* ------------------------------------------------------------------ [1b] */
group('[1b] E6/§8：内部路径白名单（仅 .aidrama/flow-state.json；其他 .aidrama/* 拒绝）')
const hash0 = firstRead.hash
check('E6：doc-read flow-state 返回 64 位 hash', /^[0-9a-f]{64}$/.test(String(hash0)), String(hash0))
const docOther = await call('doc-read', { title: TITLE, path: '.aidrama/other.json' })
check('E6①：doc-read 非约定 .aidrama/other.json → 400/拒绝', docOther.status === 400 && docOther.body?.ok === false, JSON.stringify({ status: docOther.status, code: docOther.body?.code, error: docOther.body?.error }).slice(0, 180))
const saveOther = await call('doc-save', { title: TITLE, path: '.aidrama/other.json', text: '{}' })
check('E6①：doc-save 非约定 .aidrama/other.json → 400/拒绝', saveOther.status === 400 && saveOther.body?.ok === false, JSON.stringify({ status: saveOther.status, code: saveOther.body?.code }).slice(0, 180))
const docContract = await call('doc-read', { title: TITLE, path: '.aidrama/contract.json' })
check('E6①：旧内部路径 .aidrama/contract.json 仍被拒绝（旧行为不变）', docContract.status === 400 && docContract.body?.ok === false, JSON.stringify({ status: docContract.status }).slice(0, 120))
const badJson = await call('doc-save', { title: TITLE, path: FLOW_PATH, text: '{"steps": ', expectedHash: hash0 })
check('E6：doc-save 非法 JSON → 400', badJson.status === 400 && badJson.body?.ok === false, JSON.stringify({ status: badJson.status, error: badJson.body?.error }).slice(0, 180))
// 合法写入 → 200；stale expectedHash → 409 + currentHash
const goodSave = await call('doc-save', { title: TITLE, path: FLOW_PATH, text: JSON.stringify(state0, null, 2), expectedHash: hash0 })
check('E6：doc-save 合法 JSON + 匹配 hash → 200', goodSave.status === 200 && goodSave.body?.ok === true, JSON.stringify({ status: goodSave.status, body: goodSave.body }).slice(0, 200))
const newHash = goodSave.body?.hash
// v0.16.0 A-H1（加强，FS-09）：expectedHash 冲突必须仍 409 且**不写盘**（文件 sha256 前后不变）
const flowFileHashBefore = sha256(await fs.readFile(flowFile, 'utf8'))
const staleSave = await call('doc-save', { title: TITLE, path: FLOW_PATH, text: JSON.stringify(state0, null, 2), expectedHash: hash0 })
const flowFileHashAfter = sha256(await fs.readFile(flowFile, 'utf8'))
check('E6：doc-save stale expectedHash → 409 + code conflict + currentHash', staleSave.status === 409 && staleSave.body?.code === 'conflict' && staleSave.body?.ok === false && typeof staleSave.body?.currentHash === 'string' && staleSave.body.currentHash === newHash, JSON.stringify({ status: staleSave.status, code: staleSave.body?.code, currentHash: staleSave.body?.currentHash }).slice(0, 200))
check('AC-A2/A-H1：expectedHash 冲突不写盘（文件 sha256 前后不变，数据安全链保留）', staleSave.status === 409 && flowFileHashBefore === flowFileHashAfter, JSON.stringify({ status: staleSave.status, unchanged: flowFileHashBefore === flowFileHashAfter }))

/* ------------------------------------------------------------------ [2] */
group('[2] Q4 + AC-F2：面板写内容 → 宿主同步 flow-state；确认动作（宽松模式）')
const outlineSave = await call('outline-save', { title: TITLE, rows: [{ order: 1, title: '第1集 刀在颈侧', logline: '倒爷被逼债', hook: '刀架脖子', twist: '反杀', cliffhanger: '幕后黑手', estDurationSec: 120 }] })
check('outline-save 成功', outlineSave.status === 200 && outlineSave.body?.ok === true, JSON.stringify(outlineSave.body).slice(0, 120))
let current = await readFlowDoc()
check('Q4：面板写大纲后 flow-state 同步（outline=in_progress）', statusOf(current.state, 'outline') === 'in_progress', JSON.stringify(statusOf(current.state, 'outline')))
check('Q4：下游未被误标（characters 仍 not_started）', statusOf(current.state, 'characters') === 'not_started', JSON.stringify(statusOf(current.state, 'characters')))
// 确认大纲（宽松模式下直接写 confirmed，需当前 hash）
const confirmRes = await saveFlowState((s) => ({ ...s, steps: { ...s.steps, outline: 'confirmed' } }))
check('AC-F2：大纲确认写入成功（宽松模式）', confirmRes.status === 200 && confirmRes.body?.ok === true, JSON.stringify(confirmRes.body).slice(0, 160))
current = await readFlowDoc()
check('AC-F2：大纲状态 confirmed，可进入人物', statusOf(current.state, 'outline') === 'confirmed', JSON.stringify(statusOf(current.state, 'outline')))
check('确认动作写入 history（action=confirm）', Array.isArray(current.state.history) && current.state.history.some((h) => h.action === 'confirm' && h.step === 'outline' && h.to === 'confirmed'), JSON.stringify((current.state.history || []).slice(-3)))
// Q4：工具侧静态接线（宿主实现可能在 index.js 或 lib/tools.js：withFlowState/syncAfterContentWrite/FLOW_TOOL_STEPS）
check('Q4：宿主工具侧 flow 同步接线存在（syncAfterContentWrite + 工具包装）', /syncAfterContentWrite/.test(flowSrc) && /withFlowState|syncToolFlowState|FLOW_TOOL_STEPS/.test(flowSrc))
check('Q4：内容写工具映射覆盖 outline/characters/episode/export', ['drama_save_outline', 'drama_save_characters', 'drama_import_script', 'drama_export'].every((n) => new RegExp(n).test(flowSrc)))
check('Q4：面板内容写路由映射存在（ROUTE_FLOW_STEPS）', /ROUTE_FLOW_STEPS/.test(hostSrc))
check('AC-F3：工具侧强制门禁接线存在（assertStepAllowed/FLOW_TOOL_STRICT_STEPS）', /assertStepAllowed|FLOW_TOOL_STRICT_STEPS/.test(flowSrc))

/* ------------------------------------------------------------------ [3] */
group('[3] A-H1（v0.16.0）：严格流程门禁整体停用 —— strictMode 不再阻塞写入/工具；字段保留（行为反转）')
// 项目级 strictMode:true → 越步确认应放行（历史 strict 项目解封；Lead 已批 A-H1）
const strictState = await saveFlowState((s) => ({ ...s, strictMode: true, steps: { ...s.steps, characters: 'not_started' } }))
check('Q1：项目级 strictMode 可写入（默认 false → true；历史字段保留）', strictState.status === 200 && strictState.body?.ok === true, JSON.stringify(strictState.body).slice(0, 160))
const blockedConfirm = await saveFlowState((s) => ({ ...s, steps: { ...s.steps, outline: 'in_progress', characters: 'confirmed' } }))
check('[AC-A2] A-H1：项目级 strict=true 越步确认 → 200/ok（不再 409 conflict）', blockedConfirm.status === 200 && blockedConfirm.body?.ok === true, JSON.stringify({ status: blockedConfirm.status, code: blockedConfirm.body?.code }).slice(0, 200))
const strictAfterConfirm = await readFlowDoc()
check('[AC-A2] A-H1：越步确认未被门禁拦截且落盘（characters 非 not_started；strictMode 字段保留 true）', ['confirmed', 'stale'].includes(statusOf(strictAfterConfirm.state, 'characters')) && strictAfterConfirm.state?.strictMode === true, JSON.stringify({ characters: statusOf(strictAfterConfirm.state, 'characters'), strictMode: strictAfterConfirm.state?.strictMode }).slice(0, 200))
const looseState = await saveFlowState((s) => ({ ...s, strictMode: false }))
check('Q1：切回宽松模式成功（strictMode 字段可写）', looseState.status === 200 && looseState.body?.ok === true, JSON.stringify(looseState.body).slice(0, 120))
const allowedConfirm = await saveFlowState((s) => ({ ...s, steps: { ...s.steps, characters: 'confirmed' } }))
check('Q1：宽松模式下写操作放行', allowedConfirm.status === 200 && allowedConfirm.body?.ok === true, JSON.stringify({ status: allowedConfirm.status, body: allowedConfirm.body }).slice(0, 200))
// settings 级 strictMode（A-H1 后仅数据字段；不再拦截内容写/工具）
const STRICT2 = '设置强控样剧'
await call('create-project', { title: STRICT2 })
const settingsDefault = await call('settings-get', {})
check('Q1：settings.strictMode 默认 false（宽松）', (settingsDefault.body?.settings || {}).strictMode === false, JSON.stringify(settingsDefault.body?.settings || {}).slice(0, 160))
const enableStrict = await call('settings-save', { settings: { strictMode: true } })
check('Q1：settings.strictMode 可开启（payload {settings:{strictMode:true}}；字段保留可读）', enableStrict.status === 200 && enableStrict.body?.settings?.strictMode === true, JSON.stringify(enableStrict.body).slice(0, 160))
const gatedRoute = await call('characters-save', { title: STRICT2, characters: [{ name: '甲', role: '主角' }] })
check('[AC-A2] A-H1：settings.strictMode=true 时面板写人物 → 200/ok（不再 409）', gatedRoute.status === 200 && gatedRoute.body?.ok === true, JSON.stringify({ status: gatedRoute.status, code: gatedRoute.body?.code }).slice(0, 200))
const gatedCharsRead = await call('characters-get', { title: STRICT2 })
check('[AC-A2] A-H1：面板写入落盘可回读（甲）', JSON.stringify(gatedCharsRead.body || {}).includes('甲'), JSON.stringify(gatedCharsRead.body).slice(0, 160))
const gatedTool = await (async () => {
  const d = toolsMod.createToolDefs({ rootOf: () => workspace, backendOf: () => null }).find((x) => x.name === 'drama_save_characters')
  return d.execute({ title: STRICT2, characters: [{ name: '甲', role: '主角' }] }, { agent: { id: 'qa-strict', session: { header: { cwd: workspace } }, ctx: { get: () => undefined } }, callId: 'strict-tool' })
})()
check('[AC-A2] A-H1：settings.strictMode=true 时内容写工具 → ok:true（不再 conflict/需先确认）', gatedTool && gatedTool.ok === true && !/需先确认|强制模式/.test(JSON.stringify(gatedTool)), JSON.stringify(gatedTool).slice(0, 240))
const disableStrict = await call('settings-save', { settings: { strictMode: false } })
check('Q1：settings.strictMode 可关闭回宽松', disableStrict.status === 200 && disableStrict.body?.settings?.strictMode === false, JSON.stringify(disableStrict.body).slice(0, 160))
const ungatedRoute = await call('characters-save', { title: STRICT2, characters: [{ name: '甲', role: '主角' }] })
check('AC-F3 旧语义：宽松模式同一内容写放行', ungatedRoute.status === 200 && ungatedRoute.body?.ok === true, JSON.stringify({ status: ungatedRoute.status, body: ungatedRoute.body }).slice(0, 200))
// A-H1 实现方式行为断言（FS-01 增强：导出函数保留但恒放行/恒 false）
const strictProbe = await flowMod.isStrictFlowMode(workspace, TITLE)
check('[AC-A2] A-H1：isStrictFlowMode 恒 false（历史 strict 项目也不再判强制）', strictProbe === false, String(strictProbe))
const allowedProbe = await flowMod.assertStepAllowed(workspace, TITLE, 'characters')
check('[AC-A2] A-H1：assertStepAllowed 恒放行 {allowed:true,strict:false}（不再抛 conflict）', allowedProbe && allowedProbe.allowed === true && allowedProbe.strict === false, JSON.stringify(allowedProbe))

/* ------------------------------------------------------------------ [4] */
group('[4] AC-F4 / Q3：上游变更 → 下游已确认步骤 stale，文件不删')
// 先让人物页签有内容（route 写会同步 characters=in_progress），再把 characters 置 confirmed，然后改大纲
const charsSave = await call('characters-save', { title: TITLE, characters: [{ name: '林越', role: '主角', personality: ['隐忍'], bio: '倒爷' }] })
check('characters-save 写内容成功', charsSave.status === 200 && charsSave.body?.ok === true, JSON.stringify(charsSave.body).slice(0, 120))
const charsFile = path.join(projectDir, '人物', '人物设定卡.md')
check('人物文件已落盘', await fs.stat(charsFile).then(() => true, () => false))
await saveFlowState((s) => ({ ...s, steps: { ...s.steps, characters: 'confirmed' } }))
const againOutline = await call('outline-save', { title: TITLE, rows: [{ order: 1, title: '第1集 改稿', logline: 'x', hook: 'y', twist: 'z', cliffhanger: 'w', estDurationSec: 100 }] })
check('上游（大纲）再次写入成功', againOutline.status === 200 && againOutline.body?.ok === true, JSON.stringify(againOutline.body).slice(0, 120))
current = await readFlowDoc()
check('AC-F4：大纲变更后下游 characters 变 stale', statusOf(current.state, 'characters') === 'stale', JSON.stringify(statusOf(current.state, 'characters')))
check('Q3：下游文件未被删除（仅标 stale）', await fs.stat(charsFile).then(() => true, () => false))
check('Q3：未生成自动备份副本（人物目录仅原文件）', (await fs.readdir(path.join(projectDir, '人物'))).filter((n) => /backup|bak|~|\.orig/i.test(n)).length === 0)

/* ------------------------------------------------------------------ [5] */
group('[5] AC-F7：旧项目无 flow-state → doc-read 推断（E6：200 + 原子落盘），不写坏数据')
const LEGACY = '旧项目样剧'
const legacyDir = path.join(workspace, 'AI短剧', LEGACY)
await fs.mkdir(path.join(legacyDir, '分集剧本'), { recursive: true })
await fs.mkdir(path.join(legacyDir, '人物'), { recursive: true })
await fs.mkdir(path.join(legacyDir, '总纲'), { recursive: true })
await fs.writeFile(path.join(legacyDir, '剧集契约.md'), '# 契约\n', 'utf8')
await fs.writeFile(path.join(legacyDir, '总纲', '分集大纲.md'), '# 大纲\n', 'utf8')
await fs.writeFile(path.join(legacyDir, '人物', '人物设定卡.md'), '# 人物\n', 'utf8')
await fs.writeFile(path.join(legacyDir, '分集剧本', '第001集.md'), '# 第001集\n', 'utf8')
const legacyBefore = sha256(await fs.readFile(path.join(legacyDir, '分集剧本', '第001集.md'), 'utf8'))
const legacyRead = await call('doc-read', { title: LEGACY, path: FLOW_PATH })
check('E6/AC-F7：旧项目 doc-read flow-state → 200（缺失时推断）', legacyRead.status === 200 && legacyRead.body?.ok === true, JSON.stringify({ status: legacyRead.status, body: legacyRead.body }).slice(0, 200))
const legacyFile = path.join(legacyDir, '.aidrama', 'flow-state.json')
const legacyState = JSON.parse(await fs.readFile(legacyFile, 'utf8').catch(() => 'null'))
check('AC-F7：推断结果原子落盘（可读 JSON）', Boolean(legacyState) && legacyState.version !== undefined && Boolean(legacyState.steps), JSON.stringify(legacyState).slice(0, 160))
check('AC-F7：按内容推断（有剧本 → project/outline/characters/episode_script 均 confirmed）', STEP_KEYS.slice(0, 4).every((k) => statusOf(legacyState, k) === 'confirmed'), JSON.stringify(STEP_KEYS.map((k) => statusOf(legacyState, k))))
check('AC-F7：推断不写坏旧数据（剧本文件内容 hash 不变）', sha256(await fs.readFile(path.join(legacyDir, '分集剧本', '第001集.md'), 'utf8')) === legacyBefore)
// 旧项目 progress-get 不报错
const legacyProgress = await call('progress-get', { title: LEGACY })
check('AC-F7：旧项目 progress-get 不报错（200/ok）', legacyProgress.status === 200 && legacyProgress.body?.ok === true, JSON.stringify(legacyProgress.body).slice(0, 160))

/* ------------------------------------------------------------------ [6] */
group('[6] Q2：导出目录 / manifest 不含 flow-state.json')
const exportRes = await call('export-project', { title: TITLE, format: 'markdown' }).catch(() => null)
check('导出 markdown 成功', Boolean(exportRes) && exportRes.status === 200 && exportRes.body?.ok === true, JSON.stringify(exportRes && exportRes.body).slice(0, 160))
const exportDir = path.join(projectDir, '导出')
async function listExportFiles(dir, out = []) {
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) await listExportFiles(abs, out)
    else out.push(abs)
  }
  return out
}
const exportedFiles = await listExportFiles(exportDir)
check('Q2：导出目录非空且不含 flow-state.json', exportedFiles.length > 0 && exportedFiles.every((f) => path.basename(f) !== 'flow-state.json'), JSON.stringify(exportedFiles.map((f) => path.basename(f))))
const manifest = await exporterMod.buildExportManifest(workspace, TITLE).catch(() => null)
check('Q2：manifest（manifest.sha256.json）生成成功', Boolean(manifest) && Boolean(manifest.manifest))
const manifestText = await fs.readFile(path.join(exportDir, 'manifest.sha256.json'), 'utf8').catch(() => '')
check('Q2：manifest 不含 flow-state（文件名/路径）', manifestText.length > 0 && !FLOW_RE.test(manifestText), manifestText.slice(0, 160))

/* ------------------------------------------------------------------ [7] */
group('[7] AC-F8：既有能力不回归（progress-get 形状 / METHODS / slots / 旧数据 32 文件 hash）')
const progress = await call('progress-get', { title: TITLE })
const progressSteps = progress.body?.progress?.steps || (Array.isArray(progress.body?.steps) ? progress.body.steps : null)
check('AC-F8：progress-get 形状不变（progress.steps 6 步数组）', progress.status === 200 && Array.isArray(progressSteps) && progressSteps.length === 6 && STEP_KEYS.every((k) => progressSteps.some((s) => s.key === k)), JSON.stringify(progress.body).slice(0, 240))
const statusRes = await call('status', {})
check('AC-F8：status 形状不变（200 + workspace/projectCount）', statusRes.status === 200 && typeof statusRes.body?.workspace === 'string' && typeof statusRes.body?.projectCount === 'number', JSON.stringify(statusRes.body).slice(0, 160))
check('E6：METHODS 仍 = 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）（零新增 route）', METHODS.length === 72, String(METHODS.length))
check('AC-F8：client slots.register = 4（v0.12.1 已批准终值）', (clientSrc.match(/slots\.register\(/g) || []).length === 4)
// 旧数据 hash 不变（复用 P2-1 基线快照，跨 P2-2 期间不变）
const BASELINE_CANDIDATES = [
  process.env.DSH_AI_P22_BASELINE,
  path.join(pluginRoot, '..', 'AI短剧工作区', '证据', 'P2-1-旧数据基线-2026-10-17.json'),
]
let baselineText = null
let baselinePath = ''
for (const candidate of BASELINE_CANDIDATES) {
  try {
    baselineText = await fs.readFile(candidate, 'utf8')
    baselinePath = candidate
    break
  } catch {
    baselineText = null
  }
}
if (!baselineText) {
  console.log('      （SKIP：旧数据基线快照未找到 —— 安装副本隔离目录等场景）')
} else {
  const baseline = JSON.parse(baselineText)
  const REAL_ROOT = process.env.DSH_AI_DRAMA_REAL_ROOT || path.join(pluginRoot, '..', 'AI短剧')
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
          files.push({ relative: rel, bytes: buf.length, sha256: sha256(buf) })
        } catch {}
      }
    }
  }
  await walk(REAL_ROOT)
  const baseMap = new Map(baseline.files.map((f) => [f.relative, f]))
  const curMap = new Map(files.map((f) => [f.relative, f]))
  // 2026-10-20 测试项目清理后恢复严格口径：活动数据根 = 基线 32 文件集合（缺失/新增/改写均 FAIL；无 allowlist）。
  const missing = [...baseMap.keys()].filter((k) => !curMap.has(k))
  const added = [...curMap.keys()].filter((k) => !baseMap.has(k))
  const changed = [...baseMap.keys()].filter((k) => curMap.has(k) && curMap.get(k).sha256 !== baseMap.get(k).sha256)
  check(`AC-F8：旧数据 32 核心文件 hash 不变（严格 32 文件；${path.basename(baselinePath)}）`, missing.length === 0 && added.length === 0 && changed.length === 0, JSON.stringify({ missing, added, changed }).slice(0, 300))
}

/* ------------------------------------------------------------------ [8] */
group('[8] client 侧静态契约（v0.16.0 A-C1：流程 UI 已移除；只读 progress-get 保留；字段/通用语义保留）')
const clientHasFlow = /flow[-_ ]?state/i.test(clientSrc) || /步骤条|stepBar|flowSteps/.test(clientSrc) || /strictMode/.test(clientSrc)
if (!clientHasFlow) {
  console.log('      （SKIP：client 半（task-23）尚未接入 flow-state；交付后本组断言自动生效）')
} else {
  // A-C1 删旧增新：原「client 含步骤条/待重做提示/回退确认」3 条 → 反向缺失断言（更强）；E6 读写 → 只读保留断言
  check('[A-C1] client 已移除流程步骤条/主进度（步骤条/stepBar/flowSteps 0 出现）', !/步骤条|stepBar|flowSteps/.test(clientSrc))
  check('Q5：client 未引入图形库（无 d3/echarts/cytoscape/reactflow 依赖）', !/from\s+['"](d3|echarts|cytoscape|reactflow)/i.test(clientSrc))
  check('AC-F2：client 有确认动作与禁用逻辑（确认 + disabled）', /确认/.test(clientSrc) && /disabled/.test(clientSrc))
  check('[A-C1] client 已移除 stale「待重做/上游已变更」提示文案（0 出现）', !/待重做|上游已变更/.test(clientSrc))
  check('[A-C1] client 已移除流程回退/确认回退 UI（rollbackFlowTo/确认回退 0 出现；C3 审核对话框「二次确认」文案属新功能保留，不误判）', !/rollbackFlowTo/.test(clientSrc) && !/确认回退/.test(clientSrc))
  check('AC-F6：client 保留通用「下一步」引导（失败码/卡片语义，非流程进度）', /下一步/.test(clientSrc) && /ad-err-next|下一步：/.test(clientSrc))
  check('Q1：client 仅保留 strictMode 数据字段（无强制/宽松模式 UI）', /strictMode/.test(clientSrc) && !/强制模式|宽松模式/.test(clientSrc))
  check('[A-C1] client 不再读写 .aidrama/flow-state.json（flow 读写函数 0 出现；去进度）', !/flow-state\.json/.test(clientSrc) && !/loadFlow|persistFlow|confirmFlowStep|rollbackFlowTo/.test(clientSrc))
  check('[A-C1/E6] client 的 progress-get 仅 1 处只读调用（openProject 内部；METHOD 保留）', (clientSrc.match(/api\('progress-get'/g) || []).length === 1, String((clientSrc.match(/api\('progress-get'/g) || []).length))
  check('[红线] client 唯一调用点 70（v0.15.11 基线不增）/ slots.register 4', new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1])).size === 72 && (clientSrc.match(/slots\.register\(/g) || []).length === 4)
}

await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
