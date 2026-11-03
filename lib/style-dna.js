/**
 * v0.11.1（task-96 / 2-2 一期）：五维精简风格 DNA 纯函数（无 I/O、无时间戳、无注入）。
 *
 * 剧集级 `.aidrama/style.json`：
 *   { schemaVersion:1, style:{ palette, lighting, texture, composition, motion, other } }
 * - 六维文字（other 为「其他」补充）；缺省维度为空串；v0.16.127 取消 300 字上限；
 * - 写时多余额外维度拒绝（invalid-args）；读时未知维度忽略（不报错）；
 * - **本卡只存储/读取，不参与生成/渲染注入**（二期）。
 */

export const STYLE_DIMENSIONS = ['palette', 'lighting', 'texture', 'composition', 'motion', 'other']
/** v0.16.127：旧客户端仍只提交五维；other 可选（缺省保留），历史五维校验沿用。 */
export const STYLE_LEGACY_DIMENSIONS = ['palette', 'lighting', 'texture', 'composition', 'motion']

export const STYLE_DIMENSION_LABELS = {
  palette: '色板',
  lighting: '光感',
  texture: '质感',
  composition: '构图偏好',
  motion: '运镜节奏',
  other: '其他',
}

/** v0.16.127：取消单维 300 字产品上限；仅保留 style-save 64KB 请求体技术保护。 */

/* ------------------------------------------------------------------ *
 * v0.16.120 视觉圣经「风格分析与参考」· style.json 顶层 add-only 三组字段
 * ------------------------------------------------------------------ */
export const STYLE_REFERENCE_KEYS = Object.freeze(['references', 'referenceFilms', 'directorStyles'])
export const STYLE_REFERENCES_MAX = 50
export const STYLE_REFERENCE_ASSET_ID_MAX = 120
export const STYLE_REFERENCE_NOTE_MAX = 200
export const STYLE_REFERENCE_FILMS_MAX = 20
export const STYLE_REFERENCE_FILM_TITLE_MAX = 120
export const STYLE_REFERENCE_FILM_YEAR_MAX = 4
export const STYLE_REFERENCE_FILM_DIRECTOR_MAX = 80
export const STYLE_REFERENCE_FILM_NOTE_MAX = 200
export const STYLE_DIRECTOR_STYLES_MAX = 10
export const STYLE_DIRECTOR_NAME_MAX = 80
export const STYLE_DIRECTOR_NOTE_MAX = 300

function normalizeDimensionText(value) {
  return String(value == null ? '' : value).trim()
}

/** 归一六维 DNA：缺省维为空串；忽略未知维度（读取/写入前均适用）。 */
export function normalizeStyleDNA(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const dna = {}
  for (const dimension of STYLE_DIMENSIONS) dna[dimension] = normalizeDimensionText(raw[dimension])
  return dna
}

/**
 * 写时校验（返回错误字符串数组）：
 * - 输入必须是对象；
 * - 出现六维之外字段 → 拒绝（写时多余额外维度拒绝）；
 * - 已提供维度必须是字符串（v0.16.127 取消 300 字上限）。
 */
export function validateStyleDNA(input) {
  const errors = []
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : null
  if (!raw) return ['style DNA 必须是对象 { palette, lighting, texture, composition, motion, other }']
  for (const key of Object.keys(raw)) {
    if (!STYLE_DIMENSIONS.includes(key)) errors.push(`style DNA 不支持维度：${key}（只允许 ${STYLE_DIMENSIONS.join('/')}）`)
  }
  for (const dimension of STYLE_DIMENSIONS) {
    const value = raw[dimension]
    if (value == null) continue
    if (typeof value !== 'string') errors.push(`style.${dimension} 必须是字符串`)
  }
  return errors
}

/* ------------------------------------------------------------------ *
 * v0.16.120：三组参考字段的容错归一（读取/展示）与严格解析（写入）
 * ------------------------------------------------------------------ */
function styleText(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max)
}

function stylePlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 读取容错：缺省/非数组 → undefined；数组内非法项丢弃；保留空数组。 */
export function normalizeStyleReferences(input) {
  if (!Array.isArray(input)) return undefined
  const rows = []
  for (const item of input.slice(0, STYLE_REFERENCES_MAX)) {
    if (!stylePlainObject(item)) continue
    const assetId = styleText(item.assetId, STYLE_REFERENCE_ASSET_ID_MAX)
    if (!assetId) continue
    const order = Number.isInteger(item.order) && item.order >= 0 ? item.order : rows.length
    const row = {
      assetId,
      order,
      isCover: item.isCover === true,
      note: styleText(item.note, STYLE_REFERENCE_NOTE_MAX),
    }
    if (!rows.some((existing) => existing.assetId === assetId)) rows.push(row)
  }
  let coverSeen = false
  for (const row of rows) {
    if (row.isCover && coverSeen) row.isCover = false
    if (row.isCover) coverSeen = true
  }
  return rows
}

/** 读取容错：缺省/非数组 → undefined；保留空数组；年份非法降级为空。 */
export function normalizeStyleReferenceFilms(input) {
  if (!Array.isArray(input)) return undefined
  const rows = []
  for (const item of input.slice(0, STYLE_REFERENCE_FILMS_MAX)) {
    if (!stylePlainObject(item)) continue
    const title = styleText(item.title, STYLE_REFERENCE_FILM_TITLE_MAX)
    if (!title) continue
    const row = { title }
    const year = styleText(item.year, STYLE_REFERENCE_FILM_YEAR_MAX)
    if (/^\d{4}$/.test(year) && Number(year) >= 1888 && Number(year) <= 2100) row.year = year
    const director = styleText(item.director, STYLE_REFERENCE_FILM_DIRECTOR_MAX)
    if (director) row.director = director
    const note = styleText(item.note, STYLE_REFERENCE_FILM_NOTE_MAX)
    if (note) row.note = note
    const key = `${row.title}\u0000${row.year || ''}`
    if (!rows.some((existing) => `${existing.title}\u0000${existing.year || ''}` === key)) rows.push(row)
  }
  return rows
}

/** 读取容错：缺省/非数组 → undefined；保留空数组；director 去重（trim+lower）。 */
export function normalizeStyleDirectorStyles(input) {
  if (!Array.isArray(input)) return undefined
  const rows = []
  for (const item of input.slice(0, STYLE_DIRECTOR_STYLES_MAX)) {
    if (!stylePlainObject(item)) continue
    const director = styleText(item.director, STYLE_DIRECTOR_NAME_MAX)
    if (!director) continue
    if (rows.some((existing) => existing.director.toLowerCase() === director.toLowerCase())) continue
    const row = { director }
    const note = styleText(item.note, STYLE_DIRECTOR_NOTE_MAX)
    if (note) row.note = note
    rows.push(row)
  }
  return rows
}

/** 严格解析（写入侧）：省略 → undefined；空数组 = 清空；非法 → 400。 */
function parseStyleReferences(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw styleError('invalid-args', 'references 必须是数组（空数组=清空；省略=保留）')
  if (value.length > STYLE_REFERENCES_MAX) {
    throw styleError('invalid-args', `references 超限（${value.length} > ${STYLE_REFERENCES_MAX}）`)
  }
  const rows = []
  const ids = new Set()
  const orders = new Set()
  let covers = 0
  for (const item of value) {
    if (!stylePlainObject(item)) throw styleError('invalid-args', 'references 每项必须是对象')
    for (const key of Object.keys(item)) {
      if (!['assetId', 'order', 'isCover', 'note'].includes(key)) throw styleError('invalid-args', `references 不支持字段：${key}`)
    }
    const assetId = styleText(item.assetId, STYLE_REFERENCE_ASSET_ID_MAX + 1)
    if (!assetId) throw styleError('invalid-args', 'references.assetId 必填且不能为空')
    if (assetId.length > STYLE_REFERENCE_ASSET_ID_MAX) throw styleError('invalid-args', `references.assetId 超长（>${STYLE_REFERENCE_ASSET_ID_MAX}）`)
    if (ids.has(assetId)) throw styleError('invalid-args', `references.assetId 重复：${assetId}`)
    ids.add(assetId)
    if (!Number.isInteger(item.order) || item.order < 0) throw styleError('invalid-args', 'references.order 必须是 ≥0 的整数')
    if (orders.has(item.order)) throw styleError('invalid-args', `references.order 重复：${item.order}`)
    orders.add(item.order)
    if (item.isCover !== undefined && typeof item.isCover !== 'boolean') throw styleError('invalid-args', 'references.isCover 必须是布尔值')
    if (item.isCover === true) covers += 1
    if (item.note !== undefined) {
      if (typeof item.note !== 'string') throw styleError('invalid-args', 'references.note 必须是字符串')
      if (item.note.trim().length > STYLE_REFERENCE_NOTE_MAX) throw styleError('invalid-args', `references.note 超长（>${STYLE_REFERENCE_NOTE_MAX}）`)
    }
    const row = { assetId, order: item.order, isCover: item.isCover === true }
    if (item.note !== undefined) row.note = item.note.trim()
    rows.push(row)
  }
  if (covers > 1) throw styleError('invalid-args', 'references.isCover 最多 1 项')
  return rows
}

function parseStyleReferenceFilms(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw styleError('invalid-args', 'referenceFilms 必须是数组（空数组=清空；省略=保留）')
  if (value.length > STYLE_REFERENCE_FILMS_MAX) throw styleError('invalid-args', `referenceFilms 超限（${value.length} > ${STYLE_REFERENCE_FILMS_MAX}）`)
  const rows = []
  const seen = new Set()
  for (const item of value) {
    if (!stylePlainObject(item)) throw styleError('invalid-args', 'referenceFilms 每项必须是对象')
    for (const key of Object.keys(item)) {
      if (!['title', 'year', 'director', 'note'].includes(key)) throw styleError('invalid-args', `referenceFilms 不支持字段：${key}`)
    }
    if (typeof item.title !== 'string') throw styleError('invalid-args', 'referenceFilms.title 必须是字符串')
    const title = item.title.trim()
    if (!title) throw styleError('invalid-args', 'referenceFilms.title 必填且不能为空')
    if (title.length > STYLE_REFERENCE_FILM_TITLE_MAX) throw styleError('invalid-args', `referenceFilms.title 超长（>${STYLE_REFERENCE_FILM_TITLE_MAX}）`)
    let year
    if (item.year !== undefined) {
      if (typeof item.year !== 'string') throw styleError('invalid-args', 'referenceFilms.year 必须是字符串（4 位年份或空串）')
      const text = item.year.trim()
      if (text) {
        if (!/^\d{4}$/.test(text) || Number(text) < 1888 || Number(text) > 2100) throw styleError('invalid-args', 'referenceFilms.year 必须是 1888–2100 的 4 位年份')
        year = text
      }
    }
    let director
    if (item.director !== undefined) {
      if (typeof item.director !== 'string') throw styleError('invalid-args', 'referenceFilms.director 必须是字符串')
      if (item.director.trim().length > STYLE_REFERENCE_FILM_DIRECTOR_MAX) throw styleError('invalid-args', `referenceFilms.director 超长（>${STYLE_REFERENCE_FILM_DIRECTOR_MAX}）`)
      director = item.director.trim()
    }
    let note
    if (item.note !== undefined) {
      if (typeof item.note !== 'string') throw styleError('invalid-args', 'referenceFilms.note 必须是字符串')
      if (item.note.trim().length > STYLE_REFERENCE_FILM_NOTE_MAX) throw styleError('invalid-args', `referenceFilms.note 超长（>${STYLE_REFERENCE_FILM_NOTE_MAX}）`)
      note = item.note.trim()
    }
    const row = { title }
    if (year) row.year = year
    if (director) row.director = director
    if (note) row.note = note
    const key = `${row.title}\u0000${row.year || ''}`
    if (seen.has(key)) throw styleError('invalid-args', `referenceFilms 重复：${row.title}${row.year ? `（${row.year}）` : ''}`)
    seen.add(key)
    rows.push(row)
  }
  return rows
}

function parseStyleDirectorStyles(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw styleError('invalid-args', 'directorStyles 必须是数组（空数组=清空；省略=保留）')
  if (value.length > STYLE_DIRECTOR_STYLES_MAX) throw styleError('invalid-args', `directorStyles 超限（${value.length} > ${STYLE_DIRECTOR_STYLES_MAX}）`)
  const rows = []
  const seen = new Set()
  for (const item of value) {
    if (!stylePlainObject(item)) throw styleError('invalid-args', 'directorStyles 每项必须是对象')
    for (const key of Object.keys(item)) {
      if (!['director', 'note'].includes(key)) throw styleError('invalid-args', `directorStyles 不支持字段：${key}`)
    }
    if (typeof item.director !== 'string') throw styleError('invalid-args', 'directorStyles.director 必须是字符串')
    const director = item.director.trim()
    if (!director) throw styleError('invalid-args', 'directorStyles.director 必填且不能为空')
    if (director.length > STYLE_DIRECTOR_NAME_MAX) throw styleError('invalid-args', `directorStyles.director 超长（>${STYLE_DIRECTOR_NAME_MAX}）`)
    const key = director.toLowerCase()
    if (seen.has(key)) throw styleError('invalid-args', `directorStyles.director 重复：${director}`)
    seen.add(key)
    const row = { director }
    if (item.note !== undefined) {
      if (typeof item.note !== 'string') throw styleError('invalid-args', 'directorStyles.note 必须是字符串')
      if (item.note.trim().length > STYLE_DIRECTOR_NOTE_MAX) throw styleError('invalid-args', `directorStyles.note 超长（>${STYLE_DIRECTOR_NOTE_MAX}）`)
      row.note = item.note.trim()
    }
    rows.push(row)
  }
  return rows
}

function parseStyleReferenceInputs(raw) {
  return {
    references: parseStyleReferences(raw.references),
    referenceFilms: parseStyleReferenceFilms(raw.referenceFilms),
    directorStyles: parseStyleDirectorStyles(raw.directorStyles),
  }
}

/** style.json 三组字段的读侧输出（空数组/缺省不出现）。 */
export function styleExtrasForRead(doc) {
  const normalized = normalizeStyleDoc(doc)
  const extras = {}
  if (Array.isArray(normalized.references) && normalized.references.length) extras.styleReferences = normalized.references
  if (Array.isArray(normalized.referenceFilms) && normalized.referenceFilms.length) extras.styleReferenceFilms = normalized.referenceFilms
  if (Array.isArray(normalized.directorStyles) && normalized.directorStyles.length) extras.styleDirectorStyles = normalized.directorStyles
  return extras
}

/** 构造权威 style.json 对象（无时间戳；五维固定顺序；三组参考字段仅显式提供时输出）。 */
export function buildStyleDoc(dna, extras = undefined) {
  const doc = { schemaVersion: 1, style: normalizeStyleDNA(dna) }
  if (extras && typeof extras === 'object') {
    if (extras.references !== undefined) doc.references = normalizeStyleReferences(extras.references)
    if (extras.referenceFilms !== undefined) doc.referenceFilms = normalizeStyleReferenceFilms(extras.referenceFilms)
    if (extras.directorStyles !== undefined) doc.directorStyles = normalizeStyleDirectorStyles(extras.directorStyles)
  }
  return doc
}

/** 读取兼容：接受 {schemaVersion,style,...extras} 或裸五维对象（未知顶层忽略）。 */
export function normalizeStyleDoc(data) {
  const raw = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const source = raw.style && typeof raw.style === 'object' ? raw.style : raw
  const doc = buildStyleDoc(source)
  if (raw.references !== undefined) doc.references = normalizeStyleReferences(raw.references)
  if (raw.referenceFilms !== undefined) doc.referenceFilms = normalizeStyleReferenceFilms(raw.referenceFilms)
  if (raw.directorStyles !== undefined) doc.directorStyles = normalizeStyleDirectorStyles(raw.directorStyles)
  return doc
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
export const STYLE_INPUT_KEYS = Object.freeze(['title', 'action', 'style', 'reason', 'expectedHash', 'operationId', 'references', 'referenceFilms', 'directorStyles'])
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
  let otherProvided = false
  if (action === 'save') {
    const payload = raw.style
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw styleError('invalid-args', 'action=save 需要 style 六维对象（五维必须全量提交，other 可选）')
    }
    for (const key of Object.keys(payload)) {
      if (!STYLE_DIMENSIONS.includes(key)) throw styleError('invalid-args', `style 不支持维度：${key}（只允许 ${STYLE_DIMENSIONS.join('/')}）`)
    }
    // 旧客户端仍只提交五维；other 可选（缺省=保留当前值，显式空串=清空）。
    for (const dimension of STYLE_LEGACY_DIMENSIONS) {
      if (!Object.hasOwn(payload, dimension)) throw styleError('invalid-args', `style 缺少维度：${dimension}（五维必须全量提交）`)
    }
    for (const dimension of STYLE_DIMENSIONS) {
      if (!Object.hasOwn(payload, dimension)) continue
      if (typeof payload[dimension] !== 'string') throw styleError('invalid-args', `style.${dimension} 必须是字符串`)
    }
    otherProvided = Object.hasOwn(payload, 'other')
    style = normalizeStyleDNA(payload)
  } else if (raw.style !== undefined) {
    throw styleError('invalid-args', `action=${action} 不允许传 style`)
  }

  // v0.16.120：三组参考字段仅 save 允许；省略=保留、空数组=清空、非法 400。
  let references
  let referenceFilms
  let directorStyles
  if (action === 'save') {
    const extras = parseStyleReferenceInputs(raw)
    references = extras.references
    referenceFilms = extras.referenceFilms
    directorStyles = extras.directorStyles
  } else {
    for (const key of STYLE_REFERENCE_KEYS) {
      if (raw[key] !== undefined) throw styleError('invalid-args', `action=${action} 不允许传 ${key}`)
    }
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

  return { action, style, reason, expectedHash, operationId, references, referenceFilms, directorStyles, otherProvided }
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
  const preserveCurrentOther = (style) => {
    const next = normalizeStyleDNA(style)
    // v0.16.127：旧客户端五维 save（未提供 other）→ 保留当前 other；新客户端显式 other（含空串）→ 替换/清空。
    if (parsed.otherProvided !== true) next.other = currentStyle.other
    return next
  }
  const mergeDoc = (style) => {
    const effectiveStyle = preserveCurrentOther(style)
    return {
      ...(currentDoc || {}),
      schemaVersion: 1,
      style: effectiveStyle,
      ...(parsed.references !== undefined ? { references: parsed.references } : {}),
      ...(parsed.referenceFilms !== undefined ? { referenceFilms: parsed.referenceFilms } : {}),
      ...(parsed.directorStyles !== undefined ? { directorStyles: parsed.directorStyles } : {}),
      state: nextState,
    }
  }

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
        if (!styleHasContent(preserveCurrentOther(parsed.style))) {
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
