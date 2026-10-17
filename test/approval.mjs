/**
 * P1-N / T5 结构化作者裁决（HITL）自测：审批指纹 / 校验 / 通道语义 / 4 类高危动作接线。
 * 来源：host-dev task-15：
 *   lib/approval.js → approvalFingerprint / makeApprovalToken / verifyApprovalToken / requestApproval /
 *                     approvalFailureOf / describeApproval / APPROVE_LABEL / DECLINE_LABEL / TTL 常量
 *   lib/tools.js → 4 类高危动作前 requestToolApproval（批量采纳 / 导入覆盖 / 批次提交计费 / 定稿回滚）
 *
 * 兼容策略：v0.4.0 安装工件早于 task-15 源码（无 lib/approval.js）→ 显式 SKIP。
 *
 * 运行：node test/approval.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')

let approval = null
try {
  approval = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'approval.js')).href)
} catch {
  approval = null
}
if (!approval || typeof approval.requestApproval !== 'function') {
  console.log('\n结果：0 passed, 0 failed（SKIP：当前工件未包含 T5 裁决层 lib/approval.js —— v0.4.0 安装工件早于 task-15 源码；本套件在下一检查点工件上生效）')
  process.exit(0)
}

const {
  approvalFingerprint,
  makeApprovalToken,
  verifyApprovalToken,
  requestApproval,
  approvalFailureOf,
  describeApproval,
  APPROVE_LABEL,
  DECLINE_LABEL,
  APPROVAL_TTL_MS,
} = approval
const store = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'store.js')).href)
const drafts = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'drafts.js')).href)
const toolsMod = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'tools.js')).href)

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

/* ------------------------------------------------------------------ [1] */
group('[1] 审批指纹与 token')
const fpA = approvalFingerprint('batch-accept-drafts', { title: 'A', ids: ['d1', 'd2'] })
const fpA2 = approvalFingerprint('batch-accept-drafts', { ids: ['d1', 'd2'], title: 'A' })
const fpKind = approvalFingerprint('import-overwrite-episodes', { title: 'A', ids: ['d1', 'd2'] })
const fpPayload = approvalFingerprint('batch-accept-drafts', { title: 'A', ids: ['d3'] })
check('指纹为 64 位 sha256', /^[0-9a-f]{64}$/.test(fpA), String(fpA))
check('指纹对键顺序不敏感（稳定序列化）', fpA === fpA2)
check('指纹对 kind 敏感', fpA !== fpKind)
check('指纹对 payload 敏感', fpA !== fpPayload)
check('TTL 常量合理', APPROVAL_TTL_MS === 5 * 60 * 1000, String(APPROVAL_TTL_MS))
const token = makeApprovalToken('batch-accept-drafts', { title: 'A' })
check('token 结构 kind/fingerprint/issuedAt/expiresAt', token.kind === 'batch-accept-drafts' && /^[0-9a-f]{64}$/.test(token.fingerprint) && typeof token.issuedAt === 'string' && typeof token.expiresAt === 'string', JSON.stringify(token).slice(0, 160))
check('token 指纹与 approvalFingerprint 一致', token.fingerprint === approvalFingerprint('batch-accept-drafts', { title: 'A' }))

/* ------------------------------------------------------------------ [2] */
group('[2] verifyApprovalToken：有效 / 伪造 / 过期 / 结构非法')
check('有效 token 通过', verifyApprovalToken(token, 'batch-accept-drafts', { title: 'A' }).ok === true)
const verify = (t, kind, payload, opts) => verifyApprovalToken(t, kind, payload, opts)
check('缺 token → permission', verify(null, 'batch-accept-drafts', { title: 'A' }).code === 'permission')
check('kind 不匹配 → permission', verify(token, 'restore-finalized-version', { title: 'A' }).code === 'permission')
check('payload 被改 → permission', verify(token, 'batch-accept-drafts', { title: 'B' }).code === 'permission')
check('指纹被伪造 → permission', verify({ ...token, fingerprint: 'f'.repeat(64) }, 'batch-accept-drafts', { title: 'A' }).code === 'permission')
const expired = makeApprovalToken('batch-accept-drafts', { title: 'A' }, { now: Date.now() - APPROVAL_TTL_MS - 60_000 })
check('过期 token → approval-stale', verify(expired, 'batch-accept-drafts', { title: 'A' }).code === 'approval-stale', JSON.stringify(verify(expired, 'batch-accept-drafts', { title: 'A' })))
const staleShape = { kind: 'batch-accept-drafts', fingerprint: token.fingerprint, issuedAt: new Date(Date.now() - APPROVAL_TTL_MS - 60_000).toISOString() }
check('缺 expiresAt 时按 issuedAt+TTL 判过期', verify(staleShape, 'batch-accept-drafts', { title: 'A' }).code === 'approval-stale')
check('失败结果带 reason', typeof verify(token, 'restore-finalized-version', {}).reason === 'string' && verify(token, 'restore-finalized-version', {}).reason.length > 4)

/* ------------------------------------------------------------------ [3] */
group('[3] requestApproval 通道语义')
const okApprove = await requestApproval({ userQuestions: { ask: async () => ({ answers: [{ id: 'approval', selected: [APPROVE_LABEL] }] }) }, kind: 'batch-accept-drafts', summary: '批准？', payload: { title: 'A' } })
check('批准 → ok/approved/token', okApprove.ok === true && okApprove.approved === true && okApprove.token && okApprove.token.fingerprint === approvalFingerprint('batch-accept-drafts', { title: 'A' }), JSON.stringify(okApprove).slice(0, 160))
check('批准 token 可二次校验', verifyApprovalToken(okApprove.token, 'batch-accept-drafts', { title: 'A' }).ok === true)
const viaKey = await requestApproval({ userQuestions: { ask: async () => ({ answers: [{ id: 'approval', selected: ['approve'] }] }) }, kind: 'k', payload: {} })
check('approve 稳定键亦识别', viaKey.approved === true)
const declined = await requestApproval({ userQuestions: { ask: async () => ({ answers: [{ id: 'approval', selected: [DECLINE_LABEL] }] }) }, kind: 'k', payload: {} })
check('拒绝 → permission', declined.ok === false && declined.code === 'permission', JSON.stringify(declined).slice(0, 160))
const unanswered = await requestApproval({ userQuestions: { ask: async () => ({ answers: [] }) }, kind: 'k', payload: {} })
check('未选择 → aborted', unanswered.ok === false && unanswered.code === 'aborted', JSON.stringify(unanswered).slice(0, 160))
const noChannel = await requestApproval({ kind: 'k', payload: {} })
check('通道不可用 → permission（fail-closed）', noChannel.ok === false && noChannel.code === 'permission' && String(noChannel.reason).includes('裁决通道不可用'), JSON.stringify(noChannel).slice(0, 160))
const timedOut = await requestApproval({ userQuestions: { askTimed: async () => ({ pending: true }) }, callId: 'c1', kind: 'k', payload: {}, timeoutMs: 20 })
check('等待超时 → aborted', timedOut.ok === false && timedOut.code === 'aborted', JSON.stringify(timedOut).slice(0, 160))
const abortedByUser = await requestApproval({ userQuestions: { ask: async () => { const e = new Error('cancelled'); e.code = 'ASK_ABORTED'; throw e } }, kind: 'k', payload: {} })
check('用户取消（ASK_ABORTED）→ aborted', abortedByUser.code === 'aborted')
const delegated = await requestApproval({ userQuestions: { ask: async () => { const e = new Error('delegated'); e.code = 'DELEGATED_CALLER'; throw e } }, kind: 'k', payload: {} })
check('子会话无裁决权（DELEGATED_CALLER）→ permission', delegated.code === 'permission', JSON.stringify(delegated))
const boom = await requestApproval({ userQuestions: { ask: async () => { throw new Error('channel down') } }, kind: 'k', payload: {} })
check('通道异常 → aborted', boom.code === 'aborted', JSON.stringify(boom))
const askTimedApprove = await requestApproval({ userQuestions: { askTimed: async () => ({ answers: [{ id: 'approval', selected: [APPROVE_LABEL] }] }) }, callId: 'c2', kind: 'k', payload: {} })
check('askTimed 批准路径可用', askTimedApprove.approved === true)

/* ------------------------------------------------------------------ [4] */
group('[4] 失败对象/描述契约')
const failureShape = approvalFailureOf({ code: 'permission', reason: '用户拒绝' })
check('approvalFailureOf → 工具失败契约 {ok:false,code,reason,next}', failureShape.ok === false && failureShape.code === 'permission' && typeof failureShape.reason === 'string' && typeof failureShape.next === 'string', JSON.stringify(failureShape))
const failureAborted = approvalFailureOf({ code: 'aborted', reason: '超时' })
check('aborted 失败对象 next 文案不同', failureAborted.code === 'aborted' && failureAborted.next !== failureShape.next)
check('describeApproval 含 kind/指纹/到期', (() => {
  const text = describeApproval(token)
  return text.includes('batch-accept-drafts') && text.includes(token.fingerprint.slice(0, 16)) && text.includes(token.expiresAt)
})(), describeApproval(token))

/* ------------------------------------------------------------------ [5] */
group('[5] 4 类高危动作接线：无裁决通道 → permission；批准 → 结果带 approval.fingerprint')
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-approval-'))
const TITLE = '裁决样剧'
await store.createProject(workspace, TITLE)
await store.writeEpisode(workspace, TITLE, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：这钱，我三天还你。\n')
await store.saveOutline(workspace, TITLE, [{ order: 1, title: '刀在颈侧', logline: '倒爷被逼债', hook: '刀架脖子', twist: '反杀', cliffhanger: '幕后黑手', estDurationSec: 120 }])
await store.saveCharacters(workspace, TITLE, [{ name: '林越', role: '主角' }])
const projectDir = store.projectDir(workspace, TITLE)
const draft1 = await drafts.createDraft(projectDir, { kind: 'file', path: '构想/a.md', content: 'A' })
const draft2 = await drafts.createDraft(projectDir, { kind: 'file', path: '构想/b.md', content: 'B' })
const finalized = await store.finalizeEpisode(workspace, TITLE, 1)
check('前置：定稿 v1 就绪', finalized.version === 1, JSON.stringify(finalized).slice(0, 120))

const defs = toolsMod.createToolDefs({ rootOf: () => workspace, backendOf: () => null })
const tool = (name) => defs.find((d) => d.name === name)
const run = (name, args, exec) => tool(name).execute(args, exec)

function makeExec(opts = {}) {
  const asked = []
  const userQuestions = opts.noChannel
    ? undefined
    : {
        ask: async (request) => {
          asked.push(request)
          if (opts.mode === 'decline') return { answers: [{ id: 'approval', selected: [DECLINE_LABEL] }] }
          if (opts.mode === 'abort') {
            const e = new Error('cancelled')
            e.code = 'ASK_ABORTED'
            throw e
          }
          return { answers: [{ id: 'approval', selected: [APPROVE_LABEL] }] }
        },
        askTimed: async (request) => {
          asked.push(request)
          if (opts.mode === 'timeout') return { pending: true }
          if (opts.mode === 'decline') return { answers: [{ id: 'approval', selected: [DECLINE_LABEL] }] }
          if (opts.mode === 'abort') {
            const e = new Error('cancelled')
            e.code = 'ASK_ABORTED'
            throw e
          }
          return { answers: [{ id: 'approval', selected: [APPROVE_LABEL] }] }
        },
      }
  const agent = {
    id: 'approval-agent',
    session: { header: { cwd: workspace } },
    ctx: {
      get(name) {
        if (name === 'agentPresets') return { serviceFor: () => ({ mode: 'drama', disposed: false }) }
        if (name === 'userQuestions') return userQuestions
        return undefined
      },
    },
  }
  return { exec: { agent, callId: opts.callId || 'call-approval-1' }, asked }
}

const highRiskCases = [
  { name: '批量采纳草稿', tool: 'drama_resolve_draft', args: { title: TITLE, ids: [draft1.id, draft2.id], action: 'accept' }, kind: 'batch-accept-drafts' },
  { name: '导入覆盖已有集', tool: 'drama_import_script', args: { title: TITLE, action: 'apply', overwrite: true, text: '# 第001集\n\n## 场景 1：内景 - 新地点 - 夜\n\n林越：改。\n' }, kind: 'import-overwrite-episodes' },
  { name: '批次提交计费', tool: 'drama_submit_batch', args: { title: TITLE, backend: 'libtv', kind: 'image', items: [{ taskId: 't1', name: 'n1', prompt: 'p' }] }, kind: 'submit-generation-batch' },
  { name: '定稿回滚', tool: 'drama_finalize_episode', args: { title: TITLE, order: 1, restoreVersion: 1 }, kind: 'restore-finalized-version' },
]
const askedKinds = []
for (const item of highRiskCases) {
  const h = makeExec({ noChannel: true })
  const result = await run(item.tool, item.args, h.exec)
  check(`${item.name}：无裁决通道 → permission（fail-closed）`, result.ok === false && result.code === 'permission' && String(result.reason).includes('裁决'), JSON.stringify({ code: result.code, reason: result.reason }).slice(0, 180))
}
// 批准路径（逐项独立，仅验证「触发裁决 + 批准后结果带指纹」）
{
  const h = makeExec({})
  const r = await run('drama_resolve_draft', { title: TITLE, ids: [draft1.id, draft2.id], action: 'accept' }, h.exec)
  check('批量采纳批准 → ok + approval.fingerprint', r.ok === true && r.approval && /^[0-9a-f]{64}$/.test(String(r.approval.fingerprint)) && r.counts && r.counts.accepted === 2, JSON.stringify({ ok: r.ok, approval: r.approval, counts: r.counts }).slice(0, 200))
  check('批量采纳确实触发裁决', h.asked.length === 1 && JSON.stringify(h.asked[0]).includes('批量采纳'), String(h.asked.length))
  askedKinds.push('batch-accept-drafts')
}
{
  const h = makeExec({})
  const r = await run('drama_import_script', { title: TITLE, action: 'apply', overwrite: true, text: '# 第001集\n\n## 场景 1：内景 - 新地点 - 夜\n\n林越：改。\n' }, h.exec)
  check('导入覆盖批准 → ok + approval.fingerprint', r.ok === true && r.approval && /^[0-9a-f]{64}$/.test(String(r.approval.fingerprint)), JSON.stringify({ ok: r.ok, approval: r.approval }).slice(0, 200))
  askedKinds.push('import-overwrite-episodes')
}
{
  const h = makeExec({})
  const r = await run('drama_submit_batch', { title: TITLE, backend: 'libtv', kind: 'image', items: [{ taskId: 't2', name: 'n2', prompt: 'p' }] }, h.exec)
  check('批次提交触发裁决（批准后继续执行，结果非 permission）', h.asked.length === 1 && r.code !== 'permission', JSON.stringify({ asked: h.asked.length, code: r.code, ok: r.ok }).slice(0, 200))
  check('批次提交裁决问题含费用提示', JSON.stringify(h.asked[0] || {}).includes('费用'), JSON.stringify(h.asked[0] || {}).slice(0, 160))
  askedKinds.push('submit-generation-batch')
}
{
  const h = makeExec({})
  const r = await run('drama_finalize_episode', { title: TITLE, order: 1, restoreVersion: 1 }, h.exec)
  check('定稿回滚批准 → ok + approval.fingerprint', r.ok === true && r.approval && /^[0-9a-f]{64}$/.test(String(r.approval.fingerprint)) && Array.isArray(r.restored), JSON.stringify({ ok: r.ok, approval: r.approval, restored: r.restored }).slice(0, 200))
  askedKinds.push('restore-finalized-version')
}
check('4 类高危动作均触发裁决', askedKinds.length === 4, JSON.stringify(askedKinds))

// 拒绝 / 取消语义（工具级）
{
  const h2 = makeExec({ mode: 'decline' })
  const r2 = await run('drama_finalize_episode', { title: TITLE, order: 1, restoreVersion: 1 }, h2.exec)
  check('用户拒绝 → permission + 不执行回滚', r2.ok === false && r2.code === 'permission' && String(r2.reason).includes('拒绝'), JSON.stringify({ code: r2.code, reason: r2.reason }).slice(0, 160))
  const h3 = makeExec({ mode: 'timeout' })
  const r3 = await run('drama_resolve_draft', { title: TITLE, ids: [draft1.id, draft2.id], action: 'accept' }, h3.exec)
  check('裁决超时 → aborted', r3.ok === false && r3.code === 'aborted', JSON.stringify({ code: r3.code, reason: r3.reason }).slice(0, 160))
}

await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
