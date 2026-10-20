/**
 * v0.11.1（task-96 / 2-2 一期）：五维精简风格 DNA 纯函数（无 I/O、无时间戳、无注入）。
 *
 * 剧集级 `.aidrama/style.json`：
 *   { schemaVersion:1, style:{ palette, lighting, texture, composition, motion } }
 * - 每维 1–2 句、≤300 字；缺省维度为空串；
 * - 写时多余额外维度拒绝（invalid-args）；读时未知维度忽略（不报错）；
 * - **本卡只存储/读取，不参与生成/渲染注入**（二期）。
 */

export const STYLE_DIMENSIONS = ['palette', 'lighting', 'texture', 'composition', 'motion']

export const STYLE_DIMENSION_LABELS = {
  palette: '色板',
  lighting: '光感',
  texture: '质感',
  composition: '构图偏好',
  motion: '运镜节奏',
}

/** 单维长度上限（字符）。 */
export const STYLE_TEXT_LIMIT = 300

function normalizeDimensionText(value) {
  return String(value == null ? '' : value).trim().slice(0, STYLE_TEXT_LIMIT)
}

/** 归一五维 DNA：只保留五维、缺省为空串；忽略未知维度（读取/写入前均适用）。 */
export function normalizeStyleDNA(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const dna = {}
  for (const dimension of STYLE_DIMENSIONS) dna[dimension] = normalizeDimensionText(raw[dimension])
  return dna
}

/**
 * 写时校验（返回错误字符串数组）：
 * - 输入必须是对象；
 * - 出现五维之外字段 → 拒绝（写时多余额外维度拒绝）；
 * - 已提供维度必须是字符串且 ≤300 字（trim 后）。
 */
export function validateStyleDNA(input) {
  const errors = []
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : null
  if (!raw) return ['style DNA 必须是对象 { palette, lighting, texture, composition, motion }']
  for (const key of Object.keys(raw)) {
    if (!STYLE_DIMENSIONS.includes(key)) errors.push(`style DNA 不支持维度：${key}（只允许 ${STYLE_DIMENSIONS.join('/')}）`)
  }
  for (const dimension of STYLE_DIMENSIONS) {
    const value = raw[dimension]
    if (value == null) continue
    if (typeof value !== 'string') {
      errors.push(`style.${dimension} 必须是字符串`)
      continue
    }
    if (value.trim().length > STYLE_TEXT_LIMIT) errors.push(`style.${dimension} 超长（${value.trim().length} > ${STYLE_TEXT_LIMIT} 字）`)
  }
  return errors
}

/** 构造权威 style.json 对象（无时间戳；五维固定顺序）。 */
export function buildStyleDoc(dna) {
  return { schemaVersion: 1, style: normalizeStyleDNA(dna) }
}

/** 读取兼容：接受 {schemaVersion,style} 或裸五维对象（未知维度忽略）。 */
export function normalizeStyleDoc(data) {
  const raw = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const source = raw.style && typeof raw.style === 'object' ? raw.style : raw
  return buildStyleDoc(source)
}

/* ====================================================================== *
 * C2（E15 + H-7 `style-save`）· 视觉圣经「定向 / 冻结」状态机（纯函数，无 I/O）
 *
 * 契约：`需求/需求分析-C2-视觉圣经定向冻结-E15-v1.md`（Lead 已批，目标 v0.16.6）
 * - 状态机：draft（自由写）→ directed（受控微调：save 必带 expectedHash）→ frozen（硬锁：save/direct
 *   一律 423 style-locked）→ unfreeze（必填 reason 10–300 + expectedHash；回 directed，记 unfreezeHistory
 *   ≤20 条 + unfreezeCount）。
 * - `style.json` **add-only** 顶层 `state`；旧文件无 state → 读为 draft，**不写回/不建文件/不补默认**。
 * - 每成功写入 revision+1；direct/freeze 已目标态幂等（返回当前、revision 不增）。
 * - 错误码：400 `invalid-args`、409 `conflict`（expectedHash 不符 / directed save 缺 expectedHash）、
 *   409 `state-conflict`（非法迁移）、423 `style-locked`（冻结期写；body 需带当前 state）。
 * ====================================================================== */

export const STYLE_STATES = Object.freeze(['draft', 'directed', 'frozen'])
export const STYLE_ACTIONS = Object.freeze(['save', 'direct', 'freeze', 'unfreeze'])
export const STYLE_STATE_LABELS = Object.freeze({ draft: '草稿', directed: '已定向', frozen: '已冻结' })
/** `style.json` 内 unfreezeHistory 保留上限（超出丢最旧）。 */
export const STYLE_UNFREEZE_HISTORY_LIMIT = 20
/** 解冻原因长度（trim 后）。 */
export const STYLE_REASON_MIN = 10
export const STYLE_REASON_MAX = 300
/** `style-save` 允许的顶层键（其它一律 400，防夹带/schema 漂移）。 */
export const STYLE_INPUT_KEYS = Object.freeze(['title', 'action', 'style', 'reason', 'expectedHash', 'operationId'])
/** 200 响应中 state 的字段（不含 unfreezeHistory；hash 由调用方按当前字节补）。 */
export const STYLE_RESPONSE_STATE_KEYS = Object.freeze([
  'status',
  'revision',
  'directedAt',
  'directedBy',
  'frozenAt',
  'frozenBy',
  'freezeNote',
  'unfreezeCount',
])

/** 构造带 code 的错误（与宿主既有 invalid-args/conflict 风格一致；可携带 state/currentHash 等附加字段）。 */
export function styleError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

/** 新建/缺失时的默认 state（旧 style.json 无 state 只读视为该值，不写回）。 */
export function buildDefaultStyleState() {
  return {
    status: 'draft',
    revision: 1,
    directedAt: null,
    directedBy: null,
    frozenAt: null,
    frozenBy: null,
    freezeNote: '',
    unfreezeCount: 0,
    unfreezeHistory: [],
  }
}

/** 容错归一 state：缺失/非法字段 → 默认（draft/revision 1）；**只读用，不写回**。 */
export function normalizeStyleState(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const status = STYLE_STATES.includes(source.status) ? source.status : 'draft'
  const revision = Number.isInteger(source.revision) && source.revision > 0 ? source.revision : 1
  const textOrNull = (value) => (typeof value === 'string' && value ? value : null)
  const actorOrNull = (value) => (typeof value === 'string' && value ? value.slice(0, 80) : null)
  const freezeNote = typeof source.freezeNote === 'string' ? source.freezeNote.trim().slice(0, STYLE_REASON_MAX) : ''
  const historyRaw = Array.isArray(source.unfreezeHistory) ? source.unfreezeHistory : []
  const unfreezeHistory = historyRaw
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      at: typeof entry.at === 'string' && entry.at ? entry.at : '',
      by: actorOrNull(entry.by) || 'panel',
      reason: typeof entry.reason === 'string' ? entry.reason.trim().slice(0, STYLE_REASON_MAX) : '',
      from: 'frozen',
      to: 'directed',
    }))
    .slice(-STYLE_UNFREEZE_HISTORY_LIMIT)
  const unfreezeCount =
    Number.isInteger(source.unfreezeCount) && source.unfreezeCount >= 0 ? source.unfreezeCount : unfreezeHistory.length
  return {
    status,
    revision,
    directedAt: textOrNull(source.directedAt),
    directedBy: actorOrNull(source.directedBy),
    frozenAt: textOrNull(source.frozenAt),
    frozenBy: actorOrNull(source.frozenBy),
    freezeNote,
    unfreezeCount,
    unfreezeHistory,
  }
}

/** 200 响应 state：固定 8 键（不含 unfreezeHistory）+ hash（当前/写入后 style.json 字节 sha256）。 */
export function styleResponseState(state, hash = null) {
  const normalized = normalizeStyleState(state)
  const response = {}
  for (const key of STYLE_RESPONSE_STATE_KEYS) response[key] = normalized[key]
  response.hash = typeof hash === 'string' && hash ? hash : null
  return response
}

/** E15 `assets-get.styleDirection`（仅 state 存在时由宿主追加；字段为 §3.6 口径）。 */
export function styleDirectionFromState(state, hash = null) {
  const response = styleResponseState(state, hash)
  return {
    status: response.status,
    revision: response.revision,
    directedAt: response.directedAt,
    frozenAt: response.frozenAt,
    freezeNote: response.freezeNote,
    unfreezeCount: response.unfreezeCount,
    hash: response.hash,
  }
}

/** 一次 style-save 请求的归一解析（只做形状/类型/枚举校验；状态相关校验在 planStyleAction）。 */
export function parseStyleSaveInput(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : null
  if (!raw) throw styleError('invalid-args', 'style-save 入参必须是对象')
  for (const key of Object.keys(raw)) {
    if (!STYLE_INPUT_KEYS.includes(key)) throw styleError('invalid-args', `style-save 不支持字段：${key}`)
  }
  const action = raw.action === undefined ? 'save' : raw.action
  if (!STYLE_ACTIONS.includes(action)) {
    throw styleError('invalid-args', `style-save action 非法：${String(action)}（可选 ${STYLE_ACTIONS.join('/')}）`)
  }

  let style = null
  if (action === 'save') {
    const payload = raw.style
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw styleError('invalid-args', 'action=save 需要 style 五维对象（五维必须全量提交）')
    }
    for (const key of Object.keys(payload)) {
      if (!STYLE_DIMENSIONS.includes(key)) throw styleError('invalid-args', `style 不支持维度：${key}（只允许 ${STYLE_DIMENSIONS.join('/')}）`)
    }
    for (const dimension of STYLE_DIMENSIONS) {
      if (!Object.hasOwn(payload, dimension)) throw styleError('invalid-args', `style 缺少维度：${dimension}（五维必须全量提交）`)
      if (typeof payload[dimension] !== 'string') throw styleError('invalid-args', `style.${dimension} 必须是字符串`)
      if (payload[dimension].trim().length > STYLE_TEXT_LIMIT) {
        throw styleError('invalid-args', `style.${dimension} 超长（${payload[dimension].trim().length} > ${STYLE_TEXT_LIMIT} 字）`)
      }
    }
    style = normalizeStyleDNA(payload)
  } else if (raw.style !== undefined) {
    throw styleError('invalid-args', `action=${action} 不允许传 style`)
  }

  let reason = null
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== 'string') throw styleError('invalid-args', 'reason 必须是字符串')
    reason = raw.reason.trim()
    if (reason.length > STYLE_REASON_MAX) throw styleError('invalid-args', `reason 超长（${reason.length} > ${STYLE_REASON_MAX} 字）`)
  }
  if (action === 'unfreeze') {
    if (!reason || reason.length < STYLE_REASON_MIN) {
      throw styleError('invalid-args', `解冻必须填写原因（${STYLE_REASON_MIN}–${STYLE_REASON_MAX} 字；当前 ${reason ? reason.length : 0} 字）`)
    }
  } else if (reason !== null) {
    if (action !== 'freeze') throw styleError('invalid-args', `action=${action} 不允许传 reason`)
  }

  let expectedHash = null
  if (raw.expectedHash !== undefined && raw.expectedHash !== null) {
    if (typeof raw.expectedHash !== 'string') throw styleError('invalid-args', 'expectedHash 必须是字符串（style.json 当前字节 sha256）')
    expectedHash = raw.expectedHash.trim() || null
  }
  if (action === 'unfreeze' && !expectedHash) {
    throw styleError('invalid-args', '解冻必须提供 expectedHash（style.json 当前字节 sha256）')
  }

  let operationId = null
  if (raw.operationId !== undefined && raw.operationId !== null) {
    if (typeof raw.operationId !== 'string') throw styleError('invalid-args', 'operationId 必须是字符串')
    operationId = raw.operationId.trim().slice(0, 120) || null
  }

  return { action, style, reason, expectedHash, operationId }
}

const styleHasContent = (style) => STYLE_DIMENSIONS.some((dimension) => normalizeStyleDNA(style)[dimension] !== '')

/**
 * 状态机纯函数：给定当前 style.json 快照（`{doc, text, hash}` 或 null）与已解析请求，返回下一版 doc。
 * - 不写盘、不读盘；时间/操作者由调用方传入；expectedHash **比对**由调用方（index.js）在调用前完成，
 *   本函数只负责「required 缺失 → 409 conflict」与状态相关校验。
 * @returns {{doc: object, changed: boolean}}
 * @throws code=invalid-args|conflict|state-conflict|style-locked
 */
export function planStyleAction({ current = null, parsed, actor = 'panel', now = new Date().toISOString() }) {
  if (!parsed || typeof parsed !== 'object') throw styleError('invalid-args', 'planStyleAction 缺少 parsed 请求')
  const currentDoc = current && current.doc && typeof current.doc === 'object' && !Array.isArray(current.doc) ? current.doc : null
  const currentHash = current && typeof current.hash === 'string' ? current.hash : null
  const currentState = normalizeStyleState(currentDoc && currentDoc.state)
  const status = currentDoc ? currentState.status : 'draft'
  const action = parsed.action
  const currentStyle = normalizeStyleDNA(currentDoc && currentDoc.style ? currentDoc.style : currentDoc)
  const nextState = { ...currentState, unfreezeHistory: [...currentState.unfreezeHistory] }
  const revisionBump = () => {
    nextState.revision = currentState.revision + 1
  }
  const mergeDoc = (style) => ({
    ...(currentDoc || {}),
    schemaVersion: 1,
    style: normalizeStyleDNA(style),
    state: nextState,
  })

  // 冻结期硬锁：save / direct 一律 423，不写盘不改 revision（body 需带当前 state 供 client 显示解冻入口）
  if (status === 'frozen' && (action === 'save' || action === 'direct')) {
    throw styleError('style-locked', '风格已冻结，需先解冻才能修改', {
      currentHash,
      state: styleResponseState(currentState, currentHash),
    })
  }

  switch (action) {
    case 'save': {
      if (status === 'directed') {
        if (!parsed.expectedHash) {
          throw styleError('conflict', '已定向状态微调必须提供 expectedHash（并发保护）', { currentHash })
        }
        if (!styleHasContent(parsed.style)) {
          throw styleError('invalid-args', '已定向状态微调至少需要 1 维非空风格（全部清空请先解冻回草稿）')
        }
      }
      if (currentDoc) {
        // 已存在文件：保持当前状态（draft 或 directed），revision+1
        nextState.status = status === 'directed' ? 'directed' : 'draft'
        revisionBump()
      }
      // 无文件首写：创建 state 默认 draft / revision=1（不额外 +1）
      return { doc: mergeDoc(parsed.style), changed: true }
    }
    case 'direct': {
      if (status === 'directed') return { doc: currentDoc, changed: false }
      if (!styleHasContent(currentStyle)) throw styleError('invalid-args', '定向需要至少 1 维非空风格')
      nextState.status = 'directed'
      nextState.directedAt = now
      nextState.directedBy = actor
      revisionBump()
      return { doc: mergeDoc(currentStyle), changed: true }
    }
    case 'freeze': {
      if (status === 'frozen') return { doc: currentDoc, changed: false }
      if (status !== 'directed') throw styleError('state-conflict', '未定向的风格不能冻结（请先定向）', { currentHash, state: styleResponseState(currentState, currentHash) })
      nextState.status = 'frozen'
      nextState.frozenAt = now
      nextState.frozenBy = actor
      if (parsed.reason) nextState.freezeNote = parsed.reason
      revisionBump()
      return { doc: mergeDoc(currentStyle), changed: true }
    }
    case 'unfreeze': {
      if (status !== 'frozen') throw styleError('state-conflict', '仅已冻结的风格可以解冻', { currentHash, state: styleResponseState(currentState, currentHash) })
      nextState.status = 'directed'
      nextState.frozenAt = null
      nextState.frozenBy = null
      nextState.unfreezeCount = currentState.unfreezeCount + 1
      nextState.unfreezeHistory = [
        ...currentState.unfreezeHistory,
        { at: now, by: actor, reason: parsed.reason, from: 'frozen', to: 'directed' },
      ].slice(-STYLE_UNFREEZE_HISTORY_LIMIT)
      revisionBump()
      return { doc: mergeDoc(currentStyle), changed: true }
    }
    default:
      throw styleError('invalid-args', `未知 action：${String(action)}`)
  }
}
