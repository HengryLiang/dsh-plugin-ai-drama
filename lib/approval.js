/**
 * P1-N / T5：结构化作者裁决（HITL）
 *
 * E2 已裁定（Lead）：**不新增 ask route**，复用宿主 `userQuestions` 服务（面板侧即
 * `ask_user_question` 工具通道）。本模块把「高危操作前向用户申请批准」标准化：
 *   1. 构造结构化问题（批准/拒绝，附操作摘要与 payload 指纹）；
 *   2. 调用 `userQuestions.ask` / `askTimed` 等待人类回答（支持取消/超时）；
 *   3. 返回**审批指纹 token**（sha256(kind+payload) + 过期时间）或**统一失败码**：
 *      - 用户拒绝 → `permission`
 *      - 用户取消 / 等待超时 / 通道中断 → `aborted`
 *   4. `verifyApprovalToken()` 供二次校验：伪造/不匹配 → `permission`，过期 → `approval-stale`。
 *
 * 4 类高危动作（在 lib/tools.js 中接线）：
 *   批量采纳草稿 / 导入覆盖已有集 / 生成批次提交（真实计费）/ 定稿回滚。
 */
import { createHash } from 'node:crypto'

/** 审批 token 有效期（毫秒）。 */
export const APPROVAL_TTL_MS = 5 * 60 * 1000
/** 默认等待用户回答的超时（毫秒）。 */
export const APPROVAL_TIMEOUT_MS = 2 * 60 * 1000
/** 批准选项文案（客户端按 selected 文案识别，也用 stable key 兜底）。 */
export const APPROVE_LABEL = '批准'
export const DECLINE_LABEL = '拒绝'

function stableJson(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

/** 审批指纹：sha256(kind + 规范化 payload)，用于防伪造/防复用。 */
export function approvalFingerprint(kind, payload) {
  return createHash('sha256').update(`${String(kind || '')}\n${stableJson(payload || {})}`, 'utf8').digest('hex')
}

/** 生成审批 token（成功后写进工具结果，供审计与二次校验）。 */
export function makeApprovalToken(kind, payload, options = {}) {
  const now = Number(options.now) || Date.now()
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : APPROVAL_TTL_MS
  return {
    kind: String(kind || ''),
    fingerprint: approvalFingerprint(kind, payload),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  }
}

/**
 * 校验审批 token：指纹不匹配/结构非法 → permission；过期 → approval-stale。
 * @returns {{ok:boolean, code?:'permission'|'approval-stale', reason?:string}}
 */
export function verifyApprovalToken(token, kind, payload, options = {}) {
  const now = Number(options.now) || Date.now()
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : APPROVAL_TTL_MS
  if (!token || typeof token !== 'object' || typeof token.fingerprint !== 'string') {
    return { ok: false, code: 'permission', reason: '缺少审批指纹：该操作必须先获得用户明确批准。' }
  }
  if (String(token.kind || '') !== String(kind || '')) {
    return { ok: false, code: 'permission', reason: `审批对象不匹配（期望 ${kind}，实际 ${token.kind || '空'}）。` }
  }
  if (approvalFingerprint(kind, payload) !== token.fingerprint) {
    return { ok: false, code: 'permission', reason: '审批指纹不匹配：内容在批准后被修改，或指纹被伪造，请重新申请批准。' }
  }
  const issuedAt = Date.parse(String(token.issuedAt || ''))
  const expiresAt = Date.parse(String(token.expiresAt || ''))
  const deadline = Number.isFinite(expiresAt) ? expiresAt : (Number.isFinite(issuedAt) ? issuedAt + ttlMs : Number.NaN)
  if (!Number.isFinite(deadline) || now > deadline) {
    return { ok: false, code: 'approval-stale', reason: '审批已过期：请重新向用户申请批准后再执行。' }
  }
  return { ok: true }
}

function failure(code, reason) {
  return { ok: false, approved: false, code, reason }
}

/**
 * 向用户申请一次结构化批准。
 *
 * @param {{
 *   userQuestions?: { ask?: Function, askTimed?: Function },
 *   agent?: object,
 *   signal?: AbortSignal,
 *   callId?: unknown,
 *   kind: string,
 *   title?: string,
 *   summary: string,
 *   detail?: string,
 *   payload?: object,
 *   timeoutMs?: number,
 * }} input
 * @returns {Promise<{ok:true, approved:true, token:object, answer?:object} | {ok:false, approved:false, code:'permission'|'aborted', reason:string}>}
 */
export async function requestApproval(input = {}) {
  const { userQuestions, agent, signal, callId } = input
  const kind = String(input.kind || 'high-risk-action')
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {}
  const questionId = 'approval'
  if (!userQuestions || (typeof userQuestions.ask !== 'function' && typeof userQuestions.askTimed !== 'function')) {
    return failure('permission', '裁决通道不可用（未接入 userQuestions）；高危操作已拒绝。')
  }
  const request = {
    questions: [
      {
        id: questionId,
        header: '操作确认',
        question: String(input.summary || `是否批准执行「${kind}」？`),
        ...(input.detail ? { detail: String(input.detail) } : {}),
        options: [
          { label: APPROVE_LABEL, description: '按上述内容执行一次' },
          { label: DECLINE_LABEL, description: '取消本次操作' },
        ],
      },
    ],
    ...(agent ? { agent } : {}),
    ...(signal ? { signal } : {}),
  }
  let answer
  try {
    const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : APPROVAL_TIMEOUT_MS
    if (typeof userQuestions.askTimed === 'function' && callId != null) {
      const result = await userQuestions.askTimed(request, callId, timeoutMs)
      if (result && result.pending === true) return failure('aborted', '等待用户批准超时，操作未执行。')
      answer = result
    } else {
      answer = await userQuestions.ask(request)
    }
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : ''
    if (code === 'ASK_ABORTED') return failure('aborted', '用户关闭/取消了裁决，操作未执行。')
    if (code === 'DELEGATED_CALLER' || code === 'CALLER_NOT_LIVE') {
      return failure('permission', `当前会话无法向用户发起裁决（${code}），高危操作已拒绝。`)
    }
    return failure('aborted', `裁决通道中断（${error instanceof Error ? error.message : String(error)}），操作未执行。`)
  }
  const items = answer && Array.isArray(answer.answers) ? answer.answers : []
  const item = items.find((entry) => entry && entry.id === questionId) || items[0] || {}
  const selected = Array.isArray(item.selected) ? item.selected.map(String) : []
  const approved = selected.includes(APPROVE_LABEL) || selected.includes('approve')
  const declined = selected.includes(DECLINE_LABEL) || selected.includes('decline')
  if (approved) return { ok: true, approved: true, token: makeApprovalToken(kind, payload), answer }
  return failure(declined ? 'permission' : 'aborted', declined ? '用户拒绝了该操作，未执行。' : '用户未批准该操作，未执行。')
}

/** 把审批结果转成工具失败对象（P1-A 失败契约形状）。 */
export function approvalFailureOf(result) {
  return {
    ok: false,
    code: result && result.code ? result.code : 'permission',
    reason: (result && result.reason) || '高危操作未获用户批准',
    next:
      result && result.code === 'permission'
        ? '不要重试同一操作；先询问用户需要调整什么，再重新申请批准。'
        : '等待用户批准超时或被取消；用户明确同意后重新发起。',
  }
}

/** 构造「待审批」摘要行（写进工具结果/日志，便于审计溯源）。 */
export function describeApproval(token) {
  if (!token || typeof token !== 'object') return ''
  return `审批 ${String(token.kind || '')} · 指纹 ${String(token.fingerprint || '').slice(0, 16)}… · 到期 ${token.expiresAt || ''}`
}
