/**
 * v0.11.0（task-93 / 2-1）：资产编号体系与资产卡纯函数（无 I/O、无时间戳、确定性）。
 *
 * 编号规范（Lead 批准）：
 * - 10 类前缀：CHR 角色 / SPC 场景 / PRP 道具 / SHT 镜头资产 / CST 服装 / VEH 载具 / EXP 表情 / SFX 特效 / VOX 配音 / MUS 音乐；
 * - 基础编号 `<前缀><3–6 位序号>`（如 CHR001），可选变体后缀 `_01`–`_99`（如 CHR001_02）；
 * - 大小写不敏感，存储统一大写；占位符 `{{Asset_<ID>_<字段>}}`（如 {{Asset_CHR001_name}}）。
 *
 * 资产卡 schema（写入/读取统一经 normalizeAssetCard）：
 * { id, type, name, variantOf, aliases[], status, version, fields{}, relations{}, prompts{}, history[] }
 * - status canonical：draft | active | retired（读兼容 archived→retired，未知值→draft）；
 * - v1 **不含时间戳**（确定性）；history 条目仅 { version, change }，add-only。
 */
import path from 'node:path'

export const ASSET_PREFIXES = ['CHR', 'SPC', 'PRP', 'SHT', 'CST', 'VEH', 'EXP', 'SFX', 'VOX', 'MUS']

export const ASSET_TYPE_LABELS = {
  CHR: '角色',
  SPC: '场景',
  PRP: '道具',
  SHT: '镜头资产',
  CST: '服装',
  VEH: '载具',
  EXP: '表情',
  SFX: '特效',
  VOX: '配音',
  MUS: '音乐',
}

export const ASSET_STATUSES = ['draft', 'active', 'retired']

/** v0.15.1（task-107 / 迭代1 B2S-H）：资产卡 media 字段上限。 */
export const MEDIA_IMAGE_MAX = 6
export const MEDIA_STRING_MAX = 500

/** v0.15.2（task-111 / 迭代2 DLG-H2）：media.audio 上限与扩展名白名单。 */
export const MEDIA_AUDIO_MAX = 6
﻿const MEDIA_STATES_MAX = 20
const MEDIA_STATE_IMAGES_MAX = 6
const MEDIA_STATE_NAME_MAX = 40
const MEDIA_STATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
export const MEDIA_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg', '.aac']

function isHttpMediaUrl(value) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 取媒体引用的扩展名：http(s) URL 用 pathname（忽略 query）；相对路径用 extname；统一小写。 */
function mediaRefExtension(value) {
  const text = String(value == null ? '' : value).trim()
  if (isHttpMediaUrl(text)) {
    try {
      return path.extname(new URL(text).pathname).toLowerCase()
    } catch {
      return ''
    }
  }
  return path.extname(text).toLowerCase()
}

/** 项目内相对路径：禁 `/`/`\` 开头、盘符、UNC、`..` 段、空段、控制字符。 */
function isSafeRelativeMediaPath(value) {
  const text = String(value == null ? '' : value).trim()
  if (!text || /[\u0000-\u001f]/.test(text)) return false
  // 拒绝任何 URI scheme 形态（javascript:/data:/file:/https: 等）与盘符（C:\）
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return false
  if (/^[\\/]/.test(text)) return false
  const segments = text.split(/[\\/]+/)
  if (!segments.length || segments.some((segment) => !segment || segment === '..')) return false
  return true
}

/** 单条媒体引用是否合法：仅 http(s) URL 或项目内相对路径；≤500 字符。 */
export function isValidMediaRef(value) {
  const text = String(value == null ? '' : value).trim()
  if (!text || text.length > MEDIA_STRING_MAX) return false
  if (isHttpMediaUrl(text)) return true
  return isSafeRelativeMediaPath(text)
}

/** v0.15.2：单条音频引用是否合法（路径安全同上 + 音频扩展名白名单，大小写不敏感）。 */
export function isValidAudioMediaRef(value) {
  if (!isValidMediaRef(value)) return false
  return MEDIA_AUDIO_EXTENSIONS.includes(mediaRefExtension(value))
}

﻿function isValidStateId(value) {
  return typeof value === 'string' && MEDIA_STATE_ID_RE.test(value.trim())
}

function normalizeStateImages(value) {
  if (!Array.isArray(value)) return null
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (!isValidMediaRef(text) || out.includes(text)) continue
    out.push(text)
    if (out.length >= MEDIA_STATE_IMAGES_MAX) break
  }
  return out
}

export function normalizeMediaStates(value) {
  if (!Array.isArray(value)) return []
  const ids = new Set()
  const out = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!isValidStateId(id) || ids.has(id)) continue
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MEDIA_STATE_NAME_MAX) : ''
    if (!name) continue
    const images = normalizeStateImages(raw.images) || []
    const thumbnail = typeof raw.thumbnail === 'string' ? raw.thumbnail.trim() : ''
    const state = { id, name, images }
    if (thumbnail && images.includes(thumbnail)) state.thumbnail = thumbnail
    ids.add(id)
    out.push(state)
    if (out.length >= MEDIA_STATES_MAX) break
  }
  return out
}

export function isValidMediaStateId(value) {
  return isValidStateId(value)
}

export function normalizeMediaStateId(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return isValidStateId(text) ? text : ''
}

/** v0.16.195：选择 defaultStateId（显式 → 旧 active → id=default → name=默认 → 首状态）。 */
function chooseDefaultStateId(media, states) {
  if (!Array.isArray(states) || !states.length) return ''
  const requested = typeof media?.defaultStateId === 'string' ? media.defaultStateId.trim() : ''
  if (requested && states.some((state) => state.id === requested)) return requested
  const active = typeof media?.activeStateId === 'string' ? media.activeStateId.trim() : ''
  if (active && states.some((state) => state.id === active)) return active
  const byDefaultId = states.find((state) => state.id === 'default')
  if (byDefaultId) return byDefaultId.id
  const byDefaultName = states.find((state) => state.name === '默认')
  if (byDefaultName) return byDefaultName.id
  return states[0].id
}

/** phase1/195：状态删除/新增/改名/默认指针校验；id 稳定、顺序不自动重排。 */
export function validateMediaStateTransition(previousMedia, nextMedia) {
  const previous = normalizeAssetMedia(previousMedia)
  const next = normalizeAssetMedia(nextMedia)
  const prevStates = previous && Array.isArray(previous.states) ? previous.states : []
  const nextStates = next && Array.isArray(next.states) ? next.states : []
  if (!prevStates.length) return null
  if (!nextStates.length) return '至少保留 1 个状态，不能删除最后一个状态'
  const nextIds = new Set()
  for (const state of nextStates) {
    if (nextIds.has(state.id)) return `状态 id 重复：${state.id}`
    nextIds.add(state.id)
  }
  const prevIds = new Set(prevStates.map((state) => state.id))
  const prevDefaultId = previous && previous.defaultStateId ? previous.defaultStateId : (prevStates.find((state) => state.id === 'default') || prevStates[0]).id
  const rawNextDefault = nextMedia && typeof nextMedia.defaultStateId === 'string' ? nextMedia.defaultStateId.trim() : ''
  const nextDefaultExplicit = Boolean(nextMedia && nextMedia.__defaultStateIdExplicit === true)
  if (!nextIds.has(prevDefaultId) && !(nextDefaultExplicit && rawNextDefault && rawNextDefault !== prevDefaultId && nextIds.has(rawNextDefault))) {
    return '默认状态不可删除（请先把其他状态设为默认）'
  }
  if (nextDefaultExplicit && rawNextDefault && !nextIds.has(rawNextDefault)) return `defaultStateId 不存在：${rawNextDefault}`
  const prevSurvivors = prevStates.filter((state) => nextIds.has(state.id))
  const nextSurvivors = nextStates.filter((state) => prevIds.has(state.id))
  if (prevSurvivors.length !== nextSurvivors.length) return '状态删除/新增不完整'
  for (let index = 0; index < prevSurvivors.length; index += 1) {
    const prev = prevSurvivors[index]
    const current = nextSurvivors[index]
    if (!current || current.id !== prev.id) return '本版不允许重排状态'
    // v0.16.195：允许改名（id 稳定）；名称必须由 validateMediaInput 保证合法/唯一。
  }
  let seenNewState = false
  for (const state of nextStates) {
    if (prevIds.has(state.id)) {
      if (seenNewState) return '新增状态必须追加在末尾'
    } else {
      seenNewState = true
    }
  }
  if (rawNextDefault && !nextIds.has(rawNextDefault)) return `defaultStateId 不存在：${rawNextDefault}`
  return null
}

﻿/** RC-76：Agent saveStates 的纯状态操作（新增/改名/删除/默认指针），复用 media 归一规则。 */
export function buildMediaStateEdit(rawMedia, operations = {}) {
  const current = normalizeAssetMedia(rawMedia) || {}
  const legacyImages = Array.isArray(current.images) ? current.images.slice() : []
  const legacyThumb = typeof current.thumbnail === 'string' ? current.thumbnail : ''
  let states = Array.isArray(current.states) && current.states.length
    ? current.states.map((state) => ({ ...state, images: Array.isArray(state.images) ? state.images.slice() : [], ...(state.thumbnail ? { thumbnail: state.thumbnail } : {}) }))
    : [{ id: 'default', name: '默认', images: legacyImages, ...(legacyThumb && legacyImages.includes(legacyThumb) ? { thumbnail: legacyThumb } : {}) }]
  let defaultStateId = typeof current.defaultStateId === 'string' && current.defaultStateId ? current.defaultStateId : (states.find((state) => state.id === 'default') || states.find((state) => state.name === '默认') || states[0]).id
  const ids = new Set(states.map((state) => state.id))
  const names = new Set(states.map((state) => state.name))
  const list = (value, label) => {
    if (value === undefined) return []
    if (!Array.isArray(value)) throw reviewError('invalid-args', label + ' 必须是数组')
    return value
  }
  const cleanName = (value, label) => {
    if (typeof value !== 'string') throw reviewError('invalid-args', label + ' 必须是字符串')
    const text = value.trim()
    if (text.length < 1 || text.length > 24) throw reviewError('invalid-args', label + ' 长度必须为 1–24 字')
    return text
  }
  for (const raw of list(operations.addStates, 'addStates')) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw reviewError('invalid-args', 'addStates 项必须是 {id,name}')
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!isValidMediaStateId(id)) throw reviewError('invalid-args', 'addStates.id 非法：' + String(raw.id))
    if (ids.has(id)) throw reviewError('invalid-args', 'addStates.id 已存在：' + id)
    const name = cleanName(raw.name, 'addStates.name')
    if (names.has(name)) throw reviewError('invalid-args', 'addStates.name 已存在：' + name)
    states.push({ id, name, images: [] })
    ids.add(id)
    names.add(name)
  }
  if (states.length > MEDIA_STATES_MAX) throw reviewError('invalid-args', '状态数不能超过 ' + MEDIA_STATES_MAX)
  for (const raw of list(operations.renameStates, 'renameStates')) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw reviewError('invalid-args', 'renameStates 项必须是 {id,name}')
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    const state = states.find((item) => item.id === id)
    if (!state) throw reviewError('invalid-args', 'renameStates.id 不存在：' + String(raw.id))
    const name = cleanName(raw.name, 'renameStates.name')
    if (name !== state.name && names.has(name)) throw reviewError('invalid-args', 'renameStates.name 已存在：' + name)
    names.delete(state.name)
    names.add(name)
    state.name = name
  }
  // RC-76：显式 defaultStateId 先应用，再校验删除（允许「先切默认、再删原默认」同一次调用）。
  const requestedDefault = operations.defaultStateId === undefined ? '' : operations.defaultStateId
  if (requestedDefault !== '' && typeof requestedDefault !== 'string') throw reviewError('invalid-args', 'defaultStateId 必须是字符串')
  const explicitDefault = typeof requestedDefault === 'string' ? requestedDefault.trim() : ''
  if (explicitDefault) {
    if (!ids.has(explicitDefault)) throw reviewError('invalid-args', 'defaultStateId 不存在：' + explicitDefault)
    defaultStateId = explicitDefault
  }
  const deleted = list(operations.deleteStates, 'deleteStates')
  const deletedSeen = new Set()
  for (const raw of deleted) {
    if (typeof raw !== 'string' || !raw.trim()) throw reviewError('invalid-args', 'deleteStates 项必须是非空字符串')
    const id = raw.trim()
    if (!ids.has(id)) throw reviewError('invalid-args', 'deleteStates.id 不存在：' + id)
    if (deletedSeen.has(id)) throw reviewError('invalid-args', 'deleteStates.id 重复：' + id)
    deletedSeen.add(id)
    if (id === defaultStateId) throw reviewError('invalid-args', '默认状态不可删除；请先把其他状态设为默认')
    const removed = states.find((state) => state.id === id)
    states = states.filter((state) => state.id !== id)
    ids.delete(id)
    if (removed) names.delete(removed.name)
  }
  if (!states.length || states.length > MEDIA_STATES_MAX) throw reviewError('invalid-args', '至少保留 1 个状态且不超过 ' + MEDIA_STATES_MAX + ' 个')
  if (!ids.has(defaultStateId)) throw reviewError('invalid-args', '默认状态不存在：' + defaultStateId)
  const media = { ...current, states: states.map((state) => ({ id: state.id, name: state.name, images: state.images.slice(), ...(state.thumbnail ? { thumbnail: state.thumbnail } : {}) })), defaultStateId }
  if (explicitDefault) Object.defineProperty(media, '__defaultStateIdExplicit', { value: true, enumerable: false })
  return { media, defaultStateId, deletedStateIds: [...deletedSeen] }
}

/** 旧卡读视图派生默认状态（不写盘；只用于 API 读出）。 */
export function deriveAssetMediaReadView(card) {
  if (!card || typeof card !== 'object' || String(card.type || '').toUpperCase() !== 'CHR') return card
  if (!card.media || typeof card.media !== 'object' || Array.isArray(card.media)) return card
  const media = card.media
  if (Array.isArray(media.states) && media.states.length) return card
  const images = Array.isArray(media.images) ? media.images.filter((x) => typeof x === 'string' && isValidMediaRef(x)) : []
  const state = { id: 'default', name: '默认', images }
  if (typeof media.thumbnail === 'string' && isValidMediaRef(media.thumbnail) && images.includes(media.thumbnail.trim())) state.thumbnail = media.thumbnail.trim()
  return { ...card, media: { ...media, activeStateId: 'default', defaultStateId: 'default', states: [state] } }
}

export function parsePromptsByStateInput(value) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw reviewError('invalid-args', 'card.promptsByState 必须是对象')
  const entries = Object.entries(value)
  if (entries.length > MEDIA_STATES_MAX) throw reviewError('invalid-args', `promptsByState 最多 ${MEDIA_STATES_MAX} 个状态`)
  const out = {}
  for (const [stateId, prompts] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!isValidStateId(stateId)) throw reviewError('invalid-args', `promptsByState 状态 id 非法：${stateId}`)
    out[stateId] = parseAssetPromptsInput(prompts) || {}
  }
  return out
}

function normalizePromptsByState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out = {}
  for (const [stateId, prompts] of Object.entries(value)) {
    if (!isValidStateId(stateId) || !prompts || typeof prompts !== 'object' || Array.isArray(prompts)) continue
    const normalized = {}
    for (const [key, raw] of Object.entries(prompts)) {
      if (typeof raw !== 'string' || !raw.trim()) continue
      normalized[key] = raw.trim()
    }
    if (Object.keys(normalized).length) out[stateId] = normalized
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * v0.15.1/v0.15.2：media 写入校验（纯函数，返回错误字符串数组）。
 * - media 可为 null/undefined（不写字段）；
 * - 只允许 images(1–6 项字符串)/thumbnail(字符串)/audio(1–6 项字符串)；其它键 → 拒绝；
 * - 元素仅 http(s) URL 或项目相对路径（禁 .. 逃逸/盘符/UNC/空段/控制字符，≤500 字）；
 * - audio 扩展名白名单 mp3/wav/m4a/ogg/aac（大小写不敏感；URL 用 pathname 取扩展名）；
 * - 去重后 0/>6 项 → 拒绝；thumbnail 空串视为省略。
 * - 存储层只校验路径/扩展名/数量；文件大小 ≤8MB 由 media-read 读取时（too-large）执行。
 */
﻿export function validateMediaInput(media, options = {}) {
  const errors = []
  const allowMissingActiveState = Boolean(options && options.allowMissingActiveState === true)
  if (media == null) return errors
  if (typeof media !== 'object' || Array.isArray(media)) return ['media 必须是对象 { images?, thumbnail?, audio?, states?, activeStateId? }']
  const hasStates = Array.isArray(media.states) && media.states.length > 0
  for (const key of Object.keys(media).sort()) {
    if (!['images', 'thumbnail', 'audio', 'states', 'activeStateId', 'defaultStateId'].includes(key)) errors.push(`media 不支持字段：${key}（只允许 images/thumbnail/audio/states/activeStateId/defaultStateId）`)
  }
  if (media.images != null) {
    if (!Array.isArray(media.images)) errors.push('media.images 必须是字符串数组')
    else {
      if (media.images.length === 0 && !hasStates) errors.push('media.images 不能为空数组')
      const unique = []
      for (const item of media.images) {
        if (typeof item !== 'string') { errors.push('media.images 元素必须是字符串'); continue }
        const text = item.trim()
        if (!isValidMediaRef(text)) errors.push(`media.images 项非法：${item}（仅 http(s) URL 或项目相对路径；禁 .. 逃逸/盘符/UNC；≤${MEDIA_STRING_MAX} 字）`)
        else if (!unique.includes(text)) unique.push(text)
      }
      if (unique.length > MEDIA_IMAGE_MAX) errors.push(`media.images 去重后最多 ${MEDIA_IMAGE_MAX} 项（当前 ${unique.length}）`)
    }
  }
  if (media.thumbnail != null) {
    if (typeof media.thumbnail !== 'string') errors.push('media.thumbnail 必须是字符串')
    else if (media.thumbnail.trim() && !isValidMediaRef(media.thumbnail)) errors.push(`media.thumbnail 非法：${media.thumbnail}（仅 http(s) URL 或项目相对路径；禁 .. 逃逸/盘符/UNC；≤${MEDIA_STRING_MAX} 字）`)
  }
  if (media.audio != null) {
    if (!Array.isArray(media.audio)) errors.push('media.audio 必须是字符串数组')
    else {
      if (media.audio.length === 0) errors.push('media.audio 不能为空数组')
      const unique = []
      for (const item of media.audio) {
        if (typeof item !== 'string') { errors.push('media.audio 元素必须是字符串'); continue }
        const text = item.trim()
        if (!isValidAudioMediaRef(text)) errors.push(`media.audio 项非法：${item}（仅 mp3/wav/m4a/ogg/aac；http(s) URL 或项目相对路径；禁 .. 逃逸/盘符/UNC；≤${MEDIA_STRING_MAX} 字）`)
        else if (!unique.includes(text)) unique.push(text)
      }
      if (unique.length > MEDIA_AUDIO_MAX) errors.push(`media.audio 去重后最多 ${MEDIA_AUDIO_MAX} 项（当前 ${unique.length}）`)
    }
  }
  if (media.activeStateId != null) {
    if (typeof media.activeStateId !== 'string' || !media.activeStateId.trim()) errors.push('media.activeStateId 必须是非空字符串')
    else if (!hasStates) errors.push('media.activeStateId 需要同时提供 states')
  }
  // v0.16.194（P0-①，add-only）：为 195 预留的默认状态字段只做保留/校验，不改变 root/active 语义。
  if (media.defaultStateId != null) {
    if (typeof media.defaultStateId !== 'string' || !media.defaultStateId.trim()) errors.push('media.defaultStateId 必须是非空字符串')
    else if (!hasStates) errors.push('media.defaultStateId 需要同时提供 states')
    else if (!media.states.some((state) => state && String(state.id || '').trim() === media.defaultStateId.trim())) {
      errors.push(`media.defaultStateId 不存在：${media.defaultStateId}`)
    }
  }
  if (media.states != null) {
    if (!Array.isArray(media.states)) errors.push('media.states 必须是数组')
    else if (media.states.length === 0) errors.push('media.states 不能为空数组')
    else {
      if (media.states.length > MEDIA_STATES_MAX) errors.push(`media.states 最多 ${MEDIA_STATES_MAX} 个状态（当前 ${media.states.length}）`)
      const ids = new Set()
      const names = new Set()
      for (let index = 0; index < media.states.length; index += 1) {
        const state = media.states[index]
        if (!state || typeof state !== 'object' || Array.isArray(state)) { errors.push(`media.states[${index}] 必须是对象`); continue }
        for (const key of Object.keys(state).sort()) {
          if (!['id', 'name', 'images', 'thumbnail'].includes(key)) errors.push(`media.states[${index}] 不支持字段：${key}`)
        }
        const id = typeof state.id === 'string' ? state.id.trim() : ''
        if (!isValidStateId(id)) errors.push(`media.states[${index}].id 非法（1–40 位字母/数字/_/-，首字符必须字母或数字）`)
        else if (ids.has(id)) errors.push(`media.states 状态 id 重复：${id}`)
        else ids.add(id)
        const name = typeof state.name === 'string' ? state.name.trim() : ''
        if (!name || name.length > MEDIA_STATE_NAME_MAX) errors.push(`media.states[${index}].name 必须是 1–${MEDIA_STATE_NAME_MAX} 字`)
        else if (names.has(name)) errors.push(`media.states 状态 name 重复：${name}`)
        else names.add(name)
        if (!Array.isArray(state.images)) errors.push(`media.states[${index}].images 必须是字符串数组`)
        else {
          if (state.images.length > MEDIA_STATE_IMAGES_MAX) errors.push(`media.states[${index}].images 最多 ${MEDIA_STATE_IMAGES_MAX} 张`)
          const unique = []
          for (const item of state.images) {
            if (typeof item !== 'string') { errors.push(`media.states[${index}].images 元素必须是字符串`); continue }
            const text = item.trim()
            if (!isValidMediaRef(text)) errors.push(`media.states[${index}].images 项非法：${item}`)
            else if (!unique.includes(text)) unique.push(text)
          }
          if (state.thumbnail != null) {
            if (typeof state.thumbnail !== 'string') errors.push(`media.states[${index}].thumbnail 必须是字符串`)
            else if (state.thumbnail.trim()) {
              const thumb = state.thumbnail.trim()
              if (!isValidMediaRef(thumb)) errors.push(`media.states[${index}].thumbnail 非法：${thumb}`)
              else if (!unique.includes(thumb)) errors.push(`media.states[${index}].thumbnail 必须属于该状态 images`)
            }
          }
        }
      }
      if (!allowMissingActiveState && typeof media.activeStateId === 'string' && media.activeStateId.trim() && !ids.has(media.activeStateId.trim())) {
        errors.push(`media.activeStateId 不存在：${media.activeStateId}`)
      }
    }
  }
  return errors
}

/**
 * v0.15.1/v0.15.2：media 归一（读/写共用；读取脏数据时逐项跳过、不抛错）。
 * - images：字符串、合法、去重保序、最多 6 项；
 * - thumbnail：非空合法才保留；
 * - audio：字符串、合法音频扩展名、去重保序、最多 6 项；
 * - 键顺序固定 images → thumbnail → audio；无有效内容 → 返回 undefined（不输出字段）。
 */
﻿export function normalizeAssetMedia(media) {
  if (media == null || typeof media !== 'object' || Array.isArray(media)) return undefined
  const normalized = {}
  if (Array.isArray(media.images)) {
    const unique = []
    for (const item of media.images) {
      if (typeof item !== 'string') continue
      const text = item.trim()
      if (!isValidMediaRef(text) || unique.includes(text)) continue
      unique.push(text)
      if (unique.length >= MEDIA_IMAGE_MAX) break
    }
    if (unique.length) normalized.images = unique
  }
  if (typeof media.thumbnail === 'string') {
    const text = media.thumbnail.trim()
    if (isValidMediaRef(text)) normalized.thumbnail = text
  }
  if (Array.isArray(media.audio)) {
    const unique = []
    for (const item of media.audio) {
      if (typeof item !== 'string') continue
      const text = item.trim()
      if (!isValidAudioMediaRef(text) || unique.includes(text)) continue
      unique.push(text)
      if (unique.length >= MEDIA_AUDIO_MAX) break
    }
    if (unique.length) normalized.audio = unique
  }
  const states = normalizeMediaStates(media.states)
  if (states.length) {
    // v0.16.195：default 是卡级指针；root 是 default 读投影；active 只读别名（不落盘）。
    const defaultStateId = chooseDefaultStateId(media, states)
    const defaultState = states.find((state) => state.id === defaultStateId) || states[0]
    normalized.activeStateId = defaultState.id
    normalized.defaultStateId = defaultState.id
    if (defaultState.images.length) normalized.images = defaultState.images.slice()
    else { delete normalized.images; delete normalized.thumbnail }
    const thumbnail = defaultState.thumbnail || defaultState.images[0]
    if (thumbnail) normalized.thumbnail = thumbnail
    else delete normalized.thumbnail
    normalized.states = states
  }
  return Object.keys(normalized).length ? normalized : undefined
}

/** v0.16.195：canonical 存储 media（有 states 时不写 root/active；无 states 保持 legacy）。 */
export function normalizeAssetMediaForStorage(media) {
  const normalized = normalizeAssetMedia(media)
  if (!normalized) return undefined
  if (!Array.isArray(normalized.states) || !normalized.states.length) {
    // legacy 单状态卡：根 images/thumbnail 仍是事实源；不保留无意义的 active/default。
    const out = {}
    if (Array.isArray(normalized.images)) out.images = normalized.images
    if (typeof normalized.thumbnail === 'string') out.thumbnail = normalized.thumbnail
    if (Array.isArray(normalized.audio)) out.audio = normalized.audio
    return Object.keys(out).length ? out : undefined
  }
  const out = {
    defaultStateId: normalized.defaultStateId,
    states: normalized.states,
  }
  if (Array.isArray(normalized.audio)) out.audio = normalized.audio
  return out
}

/** 合法编号前缀 alternation（单一来源 `ASSET_PREFIXES`，避免多处硬编码漂移）。 */
const ASSET_ID_PREFIX_ALTERNATION = ASSET_PREFIXES.join('|')

/** 合法编号正则：前缀 + 3–6 位序号 + 可选 _01–_99 变体。 */
export const ASSET_ID_PATTERN = new RegExp(`^(${ASSET_ID_PREFIX_ALTERNATION})[0-9]{3,6}(?:_(?:0[1-9]|[1-9][0-9]))?$`)

/** 占位符 token：{{Asset_<ID>_<field>}}（字段可缺省）。 */
export const ASSET_PLACEHOLDER_PATTERN = /\{\{Asset_([^{}]+)\}\}/g

/** 编号归一：trim + 大写；非字符串返回 ''。 */
export function normalizeAssetId(input) {
  if (typeof input !== 'string') return ''
  return input.trim().toUpperCase()
}

/** 是否为合法编号（含变体；序号 001–999，变体 01–99）。 */
export function isValidAssetId(id) {
  const parts = splitAssetId(id)
  return Boolean(parts && parts.sequence >= 1)
}

/** 拆解编号：{ prefix, sequence, baseId, variant }；非法返回 null。 */
export function splitAssetId(id) {
  const normalized = normalizeAssetId(id)
  if (!ASSET_ID_PATTERN.test(normalized)) return null
  const [baseId, variant] = normalized.split('_')
  const prefix = baseId.slice(0, 3)
  const sequence = Number(baseId.slice(3))
  return { prefix, sequence, baseId, variant: variant || null }
}

/** 类型前缀是否合法。 */
export function isValidAssetPrefix(prefix) {
  return ASSET_PREFIXES.includes(String(prefix || '').toUpperCase())
}

/**
 * 生成下一个基础编号（不含变体）：同前缀已有基础编号最大序号 +1，从 001 起。
 * @param {string[]} existingIds 已存在编号（含变体也可）
 * @param {string} prefix
 */
export function nextAssetId(existingIds, prefix) {
  const normalizedPrefix = String(prefix || '').toUpperCase()
  if (!isValidAssetPrefix(normalizedPrefix)) throw new Error(`非法资产前缀：${prefix}`)
  let maxSequence = 0
  for (const id of Array.isArray(existingIds) ? existingIds : []) {
    const parts = splitAssetId(id)
    if (!parts || parts.prefix !== normalizedPrefix || parts.variant) continue
    if (parts.sequence > maxSequence) maxSequence = parts.sequence
  }
  const next = maxSequence + 1
  if (next > 999999) throw new Error(`前缀 ${normalizedPrefix} 的编号已用尽（3–6 位序号上限 999999）`)
  return `${normalizedPrefix}${String(next).padStart(3, '0')}`
}

/** 解析文本中的全部占位符（合法/非法均返回，供校验与渲染复用）。 */
export function parseAssetPlaceholders(text) {
  const source = String(text == null ? '' : text)
  const results = []
  ASSET_PLACEHOLDER_PATTERN.lastIndex = 0
  let match
  while ((match = ASSET_PLACEHOLDER_PATTERN.exec(source)) !== null) {
    const content = String(match[1] || '').trim()
    const raw = match[0]
    // content 形如 CHR001 或 CHR001_name 或 CHR001_02_name（ID 可带 2 位变体后缀）
    const idMatch = content.match(/^([A-Za-z]{3}[0-9]{3,6}(?:_[0-9]{2})?)(?:_([A-Za-z][A-Za-z0-9_-]*))?$/)
    if (!idMatch) {
      results.push({ raw, content, id: '', field: '', valid: false, reason: '占位符格式非法' })
      continue
    }
    const id = normalizeAssetId(idMatch[1])
    const field = idMatch[2] ? String(idMatch[2]) : ''
    if (!isValidAssetId(id)) {
      results.push({ raw, content, id, field, valid: false, reason: '资产编号非法' })
      continue
    }
    results.push({ raw, content, id, field, valid: true, reason: '' })
  }
  return results
}

/** 提取文本中合法引用的资产编号（去重、稳定顺序）。 */
export function extractAssetIds(text) {
  const ids = []
  for (const item of parseAssetPlaceholders(text)) {
    if (item.valid && !ids.includes(item.id)) ids.push(item.id)
  }
  return ids
}

/** 原生 subject/groupId 宽松匹配：出现合法资产编号即视为引用。 */
export function matchAssetIdsInText(text) {
  const source = String(text == null ? '' : text).toUpperCase()
  const ids = []
  for (const prefix of ASSET_PREFIXES) {
    const pattern = new RegExp(`${prefix}[0-9]{3,6}(?:_(?:0[1-9]|[1-9][0-9]))?`, 'g')
    let match
    while ((match = pattern.exec(source)) !== null) {
      const id = normalizeAssetId(match[0])
      if (isValidAssetId(id) && !ids.includes(id)) ids.push(id)
    }
  }
  return ids
}

/** status 归一：archived→retired；未知→draft。 */
export function normalizeAssetStatus(status) {
  const value = String(status || '').trim().toLowerCase()
  if (value === 'archived') return 'retired'
  return ASSET_STATUSES.includes(value) ? value : 'draft'
}

function normalizeStringArray(value, { upper = false } = {}) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value]
  const out = []
  for (const item of list) {
    const text = String(item == null ? '' : item).trim()
    if (!text) continue
    const normalized = upper ? text.toUpperCase() : text
    if (!out.includes(normalized)) out.push(normalized)
  }
  return out
}

function normalizePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const key of Object.keys(value).sort()) {
    const item = value[key]
    if (item === undefined || item === null) continue
    out[key] = typeof item === 'string' ? item.trim() : item
  }
  return out
}

/**
 * v0.16.8（task-151 / I5-1）：跨项目复制溯源字段（add-only）。
 * `{ project, sourceId, at, rootIndex?, rootType? }`；非法/缺失返回 null（不输出字段）。
 * 读取/写入归一都保留它，否则 saveAssetCard 的 normalize 会丢弃溯源。
 */
export function normalizeImportedFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const project = typeof value.project === 'string' ? value.project.trim().slice(0, 120) : ''
  const sourceId = typeof value.sourceId === 'string' ? value.sourceId.trim().slice(0, 120) : ''
  const at = typeof value.at === 'string' ? value.at.trim().slice(0, 40) : ''
  if (!project || !at) return null
  const out = { project, sourceId, at }
  if (Number.isInteger(value.rootIndex) && value.rootIndex >= 0) out.rootIndex = value.rootIndex
  if (typeof value.rootType === 'string' && value.rootType.trim()) out.rootType = value.rootType.trim().slice(0, 20)
  return out
}

/**
 * C4a（E16/H-8 A）：从剧本剥离来源 add-only：`{sources:[相对路径…],episodes:[集号…],evidence?}`。
 * - sources 去重升序；拒绝绝对路径/盘符/`..`/空；旧卡无字段不输出（字节不变）。
 */
export function normalizeExtractedFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const sources = []
  for (const item of Array.isArray(value.sources) ? value.sources : []) {
    if (typeof item !== 'string') continue
    const raw = item.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    if (!raw || raw.length > 200) continue
    if (/^[A-Za-z]:/.test(raw) || raw.startsWith('/') || raw.split('/').includes('..')) continue
    if (!sources.includes(raw)) sources.push(raw)
  }
  sources.sort()
  if (!sources.length) return null
  const episodes = []
  for (const item of Array.isArray(value.episodes) ? value.episodes : []) {
    const order = Number(item)
    if (Number.isInteger(order) && order > 0 && !episodes.includes(order)) episodes.push(order)
  }
  episodes.sort((a, b) => a - b)
  const out = { sources, episodes }
  const evidence = value.evidence && typeof value.evidence === 'object' && !Array.isArray(value.evidence) ? value.evidence : null
  if (evidence) {
    const matchedBy = typeof evidence.matchedBy === 'string' ? evidence.matchedBy.trim().slice(0, 40) : ''
    const lines = (Array.isArray(evidence.episodes) ? evidence.episodes : [])
      .filter((entry) => entry && typeof entry === 'object' && Number.isInteger(Number(entry.order)) && Number(entry.order) > 0)
      .map((entry) => {
        const outEntry = { order: Number(entry.order) }
        if (Number.isInteger(Number(entry.lineNo)) && Number(entry.lineNo) > 0) outEntry.lineNo = Number(entry.lineNo)
        if (typeof entry.line === 'string' && entry.line.trim()) outEntry.line = entry.line.trim().slice(0, 120)
        return outEntry
      })
    if (matchedBy || lines.length) out.evidence = { ...(matchedBy ? { matchedBy } : {}), ...(lines.length ? { episodes: lines } : {}) }
  }
  return out
}

/**
 * 资产卡归一（幂等、确定性；不含时间戳）。
 * - id 大写；type 由 id 前缀推导（输入 type 不一致时保留输入供校验报错，校验后写库用推导值）；
 * - status：archived→retired，未知→draft；
 * - version：正整数默认 1；history：仅保留 {version, change} 且按原顺序（add-only）。
 */
/* ====================================================================== *
 * C3（E16 + H-8 `asset-save`）· 资产/场景卡「多轮提示词 + 审核状态机」纯函数
 *
 * 契约：`需求/需求分析-C3-资产多轮审核-E16-v1.md` v1.1（Lead 已批）
 * - 状态机：draft → pending → rejected → draft → … → approved → final；reopen（final/approved → draft）。
 * - 卡顶层 add-only `review`；旧卡无 review → 读取不输出该键、不写回、字节不变。
 * - rounds ≤20（超出丢最旧、roundCount 累计）；时间戳仅 review 内 ISO；revision 每成功写 +1。
 * - 错误：400 invalid-args / 409 state-conflict / 409 conflict / 423 asset-locked（final 锁）。
 * ====================================================================== */

export const REVIEW_SCHEMA_VERSION = 1
export const REVIEW_STATUSES = Object.freeze(['draft', 'pending', 'rejected', 'approved', 'final'])
export const REVIEW_ACTIONS = Object.freeze(['saveDraft', 'submit', 'approve', 'reject', 'finalize', 'reopen'])
export const REVIEW_ROUND_LIMIT = 20
export const REVIEW_PROMPT_LIMIT = 2000
export const REVIEW_REASON_MIN = 4
export const REVIEW_REASON_MAX = 300
/** `asset-save` 允许的业务顶层键（transport cwd/sessionId 由 index 先剔除，不计入）。 */
export const ASSET_SAVE_INPUT_KEYS = Object.freeze([
  'title',
  'mode',
  'kind',
  'id',
  'card',
  'action',
  'prompt',
  'reason',
  'expectedHash',
  'expectedReviewVersion',
  'expectedVersion',
  'operationId',
])

/** R-13（v0.16.36）：资产卡字段编辑 add-only 常量。 */
export const ASSET_FIELD_EDIT_MODE = 'fields'
export const ASSET_FIELD_NAME_MAX = 120
export const ASSET_FIELD_KEY_MAX = 40
export const ASSET_FIELD_VALUE_MAX = 500
export const ASSET_FIELD_COUNT_MAX = 64
export const ASSET_FIELD_TOTAL_BYTES_MAX = 32 * 1024
const ASSET_FIELD_KEY_RE = /^[\p{L}\p{N}_-]{1,40}$/u
const ASSET_FIELD_FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/* RC-26（v0.16.132）：资产卡 `prompts` add-only 写面（Agent savePrompts / asset-save fields 共用）。
 * - object；key 1–40 字（字母/数字/中文/_/-，≤20 键）；value 仅字符串（trim）≤2000 字；
 * - 总大小 ≤8KB；拒绝嵌套/数组/控制符；空串值剔除；空对象=清空。 */
export const ASSET_PROMPTS_MAX_KEYS = 20
export const ASSET_PROMPTS_KEY_MAX = 40
export const ASSET_PROMPTS_VALUE_MAX = 2000
export const ASSET_PROMPTS_TOTAL_BYTES_MAX = 8 * 1024
const ASSET_PROMPTS_KEY_RE = /^[\p{L}\p{N}_-]{1,40}$/u
const ASSET_PROMPTS_FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/** 严格校验/归一 card.prompts（纯函数；不写盘）。undefined=不提供；非法 → invalid-args。 */
export function parseAssetPromptsInput(value) {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw reviewError('invalid-args', 'card.prompts 必须是对象')
  const keys = Object.keys(value)
  if (keys.length > ASSET_PROMPTS_MAX_KEYS) throw reviewError('invalid-args', `card.prompts 最多 ${ASSET_PROMPTS_MAX_KEYS} 个键（当前 ${keys.length}）`)
  const out = {}
  for (const key of keys.sort()) {
    if (!ASSET_PROMPTS_KEY_RE.test(key) || ASSET_PROMPTS_FORBIDDEN_KEYS.has(key)) {
      throw reviewError('invalid-args', `card.prompts 键非法：${key}（1–${ASSET_PROMPTS_KEY_MAX} 字，仅字母/数字/中文/_/-）`)
    }
    const raw = value[key]
    if (raw === null || raw === undefined) continue
    if (typeof raw !== 'string') throw reviewError('invalid-args', `card.prompts.${key} 必须是字符串（不支持嵌套对象/数组）`)
    if (/[\u0000-\u001f]/u.test(raw)) throw reviewError('invalid-args', `card.prompts.${key} 含控制字符`)
    const text = raw.trim()
    if (text.length > ASSET_PROMPTS_VALUE_MAX) throw reviewError('invalid-args', `card.prompts.${key} 超长（${text.length} > ${ASSET_PROMPTS_VALUE_MAX}）`)
    if (text) out[key] = text
  }
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > ASSET_PROMPTS_TOTAL_BYTES_MAX) {
    throw reviewError('invalid-args', `card.prompts 总大小超过 ${ASSET_PROMPTS_TOTAL_BYTES_MAX} 字节`)
  }
  return out
}

/** 构造 asset-save 的 `mode:'fields'` 入参（纯校验；不写盘）。 */
export function parseAssetFieldEditInput(raw) {
  const allowed = new Set(['title', 'mode', 'kind', 'card', 'expectedHash', 'expectedVersion', 'operationId'])
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw reviewError('invalid-args', `asset-save mode=fields 不支持字段：${key}`)
  }
  const kindRaw = raw.kind === undefined ? 'asset' : String(raw.kind).trim().toLowerCase()
  if (kindRaw !== 'asset') throw reviewError('invalid-args', "mode=fields 仅支持 kind:'asset'（场景卡字段编辑本期不支持）")
  if (raw.card === undefined) throw reviewError('invalid-args', 'mode=fields 需要 card 对象')
  if (!raw.card || typeof raw.card !== 'object' || Array.isArray(raw.card)) throw reviewError('invalid-args', 'card 必须是对象')
  for (const key of Object.keys(raw.card)) {
    if (!['id', 'name', 'fields', 'prompts', 'promptsByState', 'media'].includes(key)) throw reviewError('invalid-args', `card 不支持字段：${key}`)
  }
  const id = normalizeAssetId(raw.card.id)
  if (!id) throw reviewError('invalid-args', 'card.id 必填')
  if (!isValidAssetId(id)) throw reviewError('invalid-args', `资产编号非法：${raw.card.id}`)
  let name
  if (raw.card.name !== undefined) {
    if (typeof raw.card.name !== 'string') throw reviewError('invalid-args', 'card.name 必须是字符串')
    name = raw.card.name.trim()
    if (name.length < 1 || name.length > ASSET_FIELD_NAME_MAX) {
      throw reviewError('invalid-args', `card.name 长度必须为 1–${ASSET_FIELD_NAME_MAX} 字（当前 ${name.length}）`)
    }
  }
  let fields
  if (raw.card.fields !== undefined) {
    if (!raw.card.fields || typeof raw.card.fields !== 'object' || Array.isArray(raw.card.fields)) {
      throw reviewError('invalid-args', 'card.fields 必须是扁平对象')
    }
    const keys = Object.keys(raw.card.fields)
    if (keys.length > ASSET_FIELD_COUNT_MAX) throw reviewError('invalid-args', `card.fields 最多 ${ASSET_FIELD_COUNT_MAX} 组`)
    fields = {}
    for (const key of keys) {
      if (!ASSET_FIELD_KEY_RE.test(key) || ASSET_FIELD_FORBIDDEN_KEYS.has(key)) {
        throw reviewError('invalid-args', `card.fields 键非法：${key}（1–${ASSET_FIELD_KEY_MAX} 字，仅字母/数字/中文/_/-）`)
      }
      const value = raw.card.fields[key]
      if (value === null) { fields[key] = null; continue }
      if (typeof value === 'string') {
        const text = value.trim()
        if (text.length > ASSET_FIELD_VALUE_MAX) throw reviewError('invalid-args', `card.fields.${key} 超长（${text.length} > ${ASSET_FIELD_VALUE_MAX}）`)
        fields[key] = text
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw reviewError('invalid-args', `card.fields.${key} 必须是有限数字`)
        fields[key] = value
      } else if (typeof value === 'boolean') {
        fields[key] = value
      } else {
        throw reviewError('invalid-args', `card.fields.${key} 必须是字符串/数字/布尔/null（不支持数组/对象）`)
      }
    }
    if (Buffer.byteLength(JSON.stringify(fields), 'utf8') > ASSET_FIELD_TOTAL_BYTES_MAX) {
      throw reviewError('invalid-args', `card.fields 总大小超过 ${ASSET_FIELD_TOTAL_BYTES_MAX} 字节`)
    }
  }
  const prompts = parseAssetPromptsInput(raw.card.prompts)
  const promptsByState = parsePromptsByStateInput(raw.card.promptsByState)
  // RC-29（v0.16.135 add-only）：card.media 显式编辑（复用 media 校验；null=清空）。
  let media
  if (raw.card.media !== undefined) {
    if (raw.card.media !== null) {
      const mediaErrors = validateMediaInput(raw.card.media, { allowMissingActiveState: true })
      if (mediaErrors.length) throw reviewError('invalid-args', mediaErrors.join('；'))
      media = normalizeAssetMedia(raw.card.media)
      // RC-58：保留请求的 activeStateId 供 store 判断「删 active 回退默认 / 未知 id」。
      const requestedActive = raw.card.media && typeof raw.card.media.activeStateId === 'string' ? raw.card.media.activeStateId.trim() : ''
      if (media && requestedActive) media.activeStateId = requestedActive
      // v0.16.195：记录 defaultStateId 是否由请求显式提供；旧 active 推导值不能用于删除默认状态。
      if (media) Object.defineProperty(media, '__defaultStateIdExplicit', { value: raw.card.media && raw.card.media.defaultStateId !== undefined, enumerable: false })
    } else {
      media = null
    }
  }
  if (name === undefined && fields === undefined && prompts === undefined && promptsByState === undefined && media === undefined) throw reviewError('invalid-args', 'card.name / card.fields / card.prompts / card.promptsByState / card.media 至少提供一个')
  if (typeof raw.expectedHash !== 'string') throw reviewError('invalid-args', 'expectedHash 必须是字符串（目标 cards.json 当前字节 sha256）')
  const expectedHash = raw.expectedHash.trim()
  let expectedVersion = null
  if (raw.expectedVersion !== undefined && raw.expectedVersion !== null) {
    if (!Number.isInteger(raw.expectedVersion) || raw.expectedVersion < 0) {
      throw reviewError('invalid-args', 'expectedVersion 必须是非负整数')
    }
    expectedVersion = raw.expectedVersion
  }
  let operationId = null
  if (raw.operationId !== undefined && raw.operationId !== null) {
    if (typeof raw.operationId !== 'string') throw reviewError('invalid-args', 'operationId 必须是字符串')
    operationId = raw.operationId.trim().slice(0, 120) || null
  }
  return { mode: ASSET_FIELD_EDIT_MODE, kind: 'asset', card: { id, ...(name !== undefined ? { name } : {}), ...(fields !== undefined ? { fields } : {}), ...(prompts !== undefined ? { prompts } : {}), ...(promptsByState !== undefined ? { promptsByState } : {}), ...(media !== undefined ? { media } : {}) }, expectedHash, expectedVersion, operationId }
}

const isoText = (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 40) : null)
const intAtLeast = (value, fallback = 0) => {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback
}

/** 构造默认 review（首次写卡时创建；旧卡无 review 只读视为默认但不落盘）。 */
export function buildDefaultReview(overrides = {}) {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    status: 'draft',
    revision: 0,
    roundCount: 0,
    round: 0,
    promptVersion: 0,
    currentPrompt: '',
    rounds: [],
    reopenCount: 0,
    ...overrides,
  }
}

/** 单轮快照归一（rounds 项）。 */
function normalizeRound(entry, index) {
  const raw = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}
  const status = ['pending', 'rejected', 'approved'].includes(raw.status) ? raw.status : 'pending'
  const round = Number.isFinite(Number(raw.round)) && Number(raw.round) > 0 ? Math.floor(Number(raw.round)) : index + 1
  const roundOut = {
    round,
    prompt: String(raw.prompt == null ? '' : raw.prompt).trim().slice(0, REVIEW_PROMPT_LIMIT),
    promptVersion: intAtLeast(raw.promptVersion, 0),
    status,
    submittedAt: isoText(raw.submittedAt) || '',
    reviewer: typeof raw.reviewer === 'string' && raw.reviewer.trim() ? raw.reviewer.trim().slice(0, 40) : 'panel',
  }
  const reviewedAt = isoText(raw.reviewedAt)
  if (reviewedAt) roundOut.reviewedAt = reviewedAt
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, REVIEW_REASON_MAX) : ''
  if (reason) roundOut.reason = reason
  return roundOut
}

/** 容错归一 review（读取/写入前）；不是对象 → null（旧卡无 review 不输出）。 */
export function normalizeReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value
  const status = REVIEW_STATUSES.includes(raw.status) ? raw.status : 'draft'
  const rounds = (Array.isArray(raw.rounds) ? raw.rounds : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry, index) => normalizeRound(entry, index))
    .slice(-REVIEW_ROUND_LIMIT)
  const review = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    status,
    revision: intAtLeast(raw.revision, 0),
    roundCount: intAtLeast(raw.roundCount, 0),
    round: rounds.length,
    promptVersion: intAtLeast(raw.promptVersion, 0),
    currentPrompt: String(raw.currentPrompt == null ? '' : raw.currentPrompt).trim().slice(0, REVIEW_PROMPT_LIMIT),
    rounds,
    reopenCount: intAtLeast(raw.reopenCount, 0),
  }
  const approvedAt = isoText(raw.approvedAt)
  const approvedBy = isoText(raw.approvedBy)
  const finalizedAt = isoText(raw.finalizedAt)
  const finalizedBy = isoText(raw.finalizedBy)
  const finalPrompt = typeof raw.finalPrompt === 'string' ? raw.finalPrompt.trim().slice(0, REVIEW_PROMPT_LIMIT) : ''
  if (approvedAt) review.approvedAt = approvedAt
  if (approvedBy) review.approvedBy = approvedBy
  if (finalizedAt) review.finalizedAt = finalizedAt
  if (finalizedBy) review.finalizedBy = finalizedBy
  if (finalPrompt) review.finalPrompt = finalPrompt
  return review
}

/** 构造带 code 的错误（与宿主既有 invalid-args/conflict 风格一致；可带 review/currentHash 等）。 */
export function reviewError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

/** `asset-save` 入参形状校验（transport 已剔除；未知业务键仍 400）。 */
export function parseAssetSaveInput(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : null
  if (!raw) throw reviewError('invalid-args', 'asset-save 入参必须是对象')
  for (const key of Object.keys(raw)) {
    if (!ASSET_SAVE_INPUT_KEYS.includes(key)) throw reviewError('invalid-args', `asset-save 不支持字段：${key}`)
  }
  const mode = raw.mode === undefined ? 'review' : raw.mode
  if (mode === ASSET_FIELD_EDIT_MODE) return parseAssetFieldEditInput(raw)
  if (mode !== 'review') throw reviewError('invalid-args', `mode 非法：${String(raw.mode)}（仅支持 fields）`)
  if (Object.hasOwn(raw, 'card') || Object.hasOwn(raw, 'expectedVersion')) {
    throw reviewError('invalid-args', 'card/expectedVersion 仅支持 mode=fields')
  }
  const kind = raw.kind === undefined ? '' : String(raw.kind).trim().toLowerCase()
  if (kind !== 'asset' && kind !== 'scene') throw reviewError('invalid-args', "kind 必须是 'asset' 或 'scene'")
  const idRaw = typeof raw.id === 'string' ? raw.id.trim().toUpperCase() : ''
  if (!idRaw) throw reviewError('invalid-args', '缺少 id')
  if (kind === 'scene' && !/^SPC[0-9]{3}$/.test(idRaw)) throw reviewError('invalid-args', `场景卡编号非法：${raw.id}（应为 SPCxxx）`)
  if (kind === 'asset' && !ASSET_ID_PATTERN.test(idRaw)) {
    throw reviewError('invalid-args', `资产编号非法：${raw.id}`)
  }
  const action = raw.action === undefined ? 'saveDraft' : raw.action
  if (!REVIEW_ACTIONS.includes(action)) throw reviewError('invalid-args', `action 非法：${String(raw.action)}`)
  let prompt = null
  if (action === 'saveDraft') {
    if (typeof raw.prompt !== 'string') throw reviewError('invalid-args', 'saveDraft 需要 prompt 字符串')
    prompt = raw.prompt.trim()
    if (prompt.length < 1 || prompt.length > REVIEW_PROMPT_LIMIT) {
      throw reviewError('invalid-args', `prompt 长度必须为 1–${REVIEW_PROMPT_LIMIT} 字（当前 ${prompt.length}）`)
    }
  } else if (raw.prompt !== undefined) {
    throw reviewError('invalid-args', `action=${action} 不允许传 prompt`)
  }
  let reason = null
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== 'string') throw reviewError('invalid-args', 'reason 必须是字符串')
    reason = raw.reason.trim()
    if (reason.length > REVIEW_REASON_MAX) throw reviewError('invalid-args', `reason 超长（${reason.length} > ${REVIEW_REASON_MAX}）`)
  }
  if ((action === 'reject' || action === 'reopen') && (!reason || reason.length < REVIEW_REASON_MIN)) {
    throw reviewError('invalid-args', `${action} 必须填写原因（${REVIEW_REASON_MIN}–${REVIEW_REASON_MAX} 字）`)
  }
  if ((action === 'saveDraft' || action === 'submit') && reason !== null) {
    throw reviewError('invalid-args', `action=${action} 不允许传 reason`)
  }
  if (typeof raw.expectedHash !== 'string') throw reviewError('invalid-args', 'expectedHash 必须是字符串（目标 cards.json 当前字节 sha256；文件不存在传空串）')
  const expectedHash = raw.expectedHash.trim()
  let expectedReviewVersion = null
  if (raw.expectedReviewVersion !== undefined && raw.expectedReviewVersion !== null) {
    if (!Number.isInteger(raw.expectedReviewVersion) || raw.expectedReviewVersion < 0) {
      throw reviewError('invalid-args', 'expectedReviewVersion 必须是非负整数')
    }
    expectedReviewVersion = raw.expectedReviewVersion
  }
  let operationId = null
  if (raw.operationId !== undefined && raw.operationId !== null) {
    if (typeof raw.operationId !== 'string') throw reviewError('invalid-args', 'operationId 必须是字符串')
    operationId = raw.operationId.trim().slice(0, 120) || null
  }
  return { mode: 'review', kind, id: idRaw, action, prompt, reason, expectedHash, expectedReviewVersion, operationId }
}

/** 状态机纯函数：返回下一版 review（不写盘；hash/并发校验由调用方在调用前完成）。 */
export function planReviewAction({ review = null, action, prompt = null, reason = null, actor = 'panel', now = new Date().toISOString() }) {
  const current = normalizeReview(review) || buildDefaultReview()
  const next = normalizeReview(current)
  const status = next.status

  // final 硬锁：saveDraft/submit/approve/reject/finalize 一律 423；仅 reopen 允许（解除锁定）
  if (status === 'final' && ['saveDraft', 'submit', 'approve', 'reject', 'finalize'].includes(action)) {
    throw reviewError('asset-locked', '资产已定稿锁定，需先重打开', { review: next })
  }

  const bumpRevision = () => {
    next.revision = current.revision + 1
  }

  switch (action) {
    case 'saveDraft': {
      if (status === 'pending') throw reviewError('state-conflict', '待审核状态不可编辑（请先通过/驳回）', { review: next })
      if (status === 'approved') throw reviewError('state-conflict', '已通过状态需先重打开才能编辑', { review: next })
      // draft / rejected → 写 currentPrompt；rejected 自动回 draft
      next.currentPrompt = prompt
      next.promptVersion = current.promptVersion + 1
      next.status = 'draft'
      bumpRevision()
      return next
    }
    case 'submit': {
      if (status !== 'draft' && status !== 'rejected') {
        throw reviewError('state-conflict', `当前状态（${status}）不允许提交审核`, { review: next })
      }
      if (!next.currentPrompt) throw reviewError('invalid-args', '提交审核前必须先填写提示词', { review: next })
      const roundNumber = current.roundCount + 1
      next.roundCount = roundNumber
      next.rounds = [
        ...current.rounds,
        {
          round: roundNumber,
          prompt: next.currentPrompt,
          promptVersion: current.promptVersion,
          status: 'pending',
          submittedAt: now,
          reviewer: actor,
        },
      ].slice(-REVIEW_ROUND_LIMIT)
      next.round = next.rounds.length
      next.status = 'pending'
      bumpRevision()
      return next
    }
    case 'approve': {
      if (status !== 'pending') throw reviewError('state-conflict', `当前状态（${status}）不可通过（需 pending）`, { review: next })
      next.status = 'approved'
      next.approvedAt = now
      next.approvedBy = actor
      next.rounds = current.rounds.map((entry, index) =>
        index === current.rounds.length - 1 ? { ...entry, status: 'approved', reviewer: actor, reviewedAt: now } : entry,
      )
      next.round = next.rounds.length
      bumpRevision()
      return next
    }
    case 'reject': {
      if (status !== 'pending') throw reviewError('state-conflict', `当前状态（${status}）不可驳回（需 pending）`, { review: next })
      next.status = 'rejected'
      next.rounds = current.rounds.map((entry, index) =>
        index === current.rounds.length - 1
          ? { ...entry, status: 'rejected', reviewer: actor, reviewedAt: now, reason }
          : entry,
      )
      next.round = next.rounds.length
      bumpRevision()
      return next
    }
    case 'finalize': {
      if (status !== 'approved') throw reviewError('state-conflict', `当前状态（${status}）不可定稿（需 approved）`, { review: next })
      if (!next.currentPrompt) throw reviewError('invalid-args', '定稿要求当前提示词非空', { review: next })
      next.status = 'final'
      next.finalPrompt = next.currentPrompt
      next.finalizedAt = now
      next.finalizedBy = actor
      bumpRevision()
      return next
    }
    case 'reopen': {
      if (status !== 'final' && status !== 'approved') {
        throw reviewError('state-conflict', `当前状态（${status}）不可重打开（需 final/approved）`, { review: next })
      }
      next.status = 'draft'
      next.reopenCount = current.reopenCount + 1
      next.reopenReason = reason
      next.reopenedAt = now
      next.reopenedBy = actor
      bumpRevision()
      return next
    }
    default:
      throw reviewError('invalid-args', `未知 action：${String(action)}`)
  }
}


export function normalizeAssetCard(input, options = {}) {
  const storage = options && options.storage === true
  const raw = input && typeof input === 'object' ? input : {}
  const id = normalizeAssetId(raw.id)
  const parts = splitAssetId(id)
  const declaredType = String(raw.type || '').trim().toUpperCase()
  const type = declaredType || (parts ? parts.prefix : '')
  const versionRaw = Number(raw.version)
  const version = Number.isFinite(versionRaw) && versionRaw >= 1 ? Math.floor(versionRaw) : 1
  const history = Array.isArray(raw.history)
    ? raw.history
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          version: Number.isFinite(Number(item.version)) ? Math.max(1, Math.floor(Number(item.version))) : 1,
          change: String(item.change == null ? '' : item.change).trim().slice(0, 200),
        }))
    : []
  const media = storage ? normalizeAssetMediaForStorage(raw.media) : normalizeAssetMedia(raw.media)
  let promptsByState = normalizePromptsByState(raw.promptsByState)
  let prompts = normalizePlainObject(raw.prompts)
  if (media && Array.isArray(media.states) && media.states.length) {
    const defaultStateId = media.defaultStateId || media.states[0].id
    if (storage) {
      // 根 prompts 只做旧写兼容：首次 canonical 写入映射到 default 状态。
      if (Object.keys(prompts).length && !(promptsByState && promptsByState[defaultStateId])) {
        promptsByState = { ...(promptsByState || {}), [defaultStateId]: prompts }
      }
      prompts = {}
    } else if (promptsByState && promptsByState[defaultStateId]) {
      // 读视图：根 prompts 是 default 状态的只读别名。
      prompts = { ...promptsByState[defaultStateId] }
    }
  }
  const importedFrom = normalizeImportedFrom(raw.importedFrom)
  const review = normalizeReview(raw.review)
  const extractedFrom = normalizeExtractedFrom(raw.extractedFrom)
  const includePrompts = !storage || !(media && Array.isArray(media.states) && media.states.length)
  return {
    id,
    type,
    name: String(raw.name == null ? '' : raw.name).trim().slice(0, 120),
    variantOf: raw.variantOf ? normalizeAssetId(raw.variantOf) : null,
    aliases: normalizeStringArray(raw.aliases),
    status: normalizeAssetStatus(raw.status),
    version,
    fields: normalizePlainObject(raw.fields),
    relations: normalizePlainObject(raw.relations),
    ...(includePrompts ? { prompts } : {}),
    ...(promptsByState ? { promptsByState } : {}),
    // v0.15.1（task-107）：media add-only（仅有效内容时输出；旧卡无 media 输出字节不变）
    ...(media ? { media } : {}),
    history,
    // C3（E16/H-8）：审核状态 add-only（旧卡无 review → 输出字节不变）
    ...(review ? { review } : {}),
    // v0.16.8（task-151 / I5-1）：跨项目复制溯源 add-only（旧卡无字段 → 输出字节不变）
    ...(importedFrom ? { importedFrom } : {}),
    // C4a（E16/H-8 A）：从剧本剥离来源 add-only（旧卡无字段 → 输出字节不变）
    ...(extractedFrom ? { extractedFrom } : {}),
  }
}

/**
 * 校验归一后的资产卡（纯函数，返回错误字符串数组；空数组=通过）。
 * variantOf 存在性/aliases 同类型唯一需结合已有卡（由 store/调用方传 existingCards）。
 */
export function validateAssetCard(card, { existingCards = [], rawInput = null } = {}) {
  const errors = []
  const raw = card && typeof card === 'object' ? card : {}
  // v0.15.1：若传入原始输入，校验 media 原始值（归一后的坏值会被过滤，不能只校验归一结果）
  if (rawInput && typeof rawInput === 'object' && Object.hasOwn(rawInput, 'media')) {
    errors.push(...validateMediaInput(rawInput.media))
  }
  const id = normalizeAssetId(raw.id)
  if (!id) errors.push('资产卡缺少 id')
  else if (!isValidAssetId(id)) errors.push(`资产编号非法：${raw.id}（应为 10 类前缀 + 3–6 位序号，可选 _01–_99 变体）`)
  const parts = splitAssetId(id)
  if (parts && raw.type && String(raw.type).toUpperCase() !== parts.prefix) {
    errors.push(`type=${raw.type} 与编号前缀 ${parts.prefix} 不一致`)
  }
  if (!parts && raw.type && !isValidAssetPrefix(raw.type)) errors.push(`type 非法：${raw.type}`)
  // v0.16.195：v1 仅 CHR 支持多状态；旧/外部非 CHR states 读取容错，但新写拒绝。
  if (String(raw.type || '').toUpperCase() !== 'CHR' && raw.media && Array.isArray(raw.media.states) && raw.media.states.length) {
    errors.push('v1 仅 CHR 支持 media.states（非 CHR 新写拒绝）')
  }
  if (raw.media && Array.isArray(raw.media.states)) {
    const stateNames = new Set()
    for (const state of raw.media.states) {
      const name = state && typeof state.name === 'string' ? state.name.trim() : ''
      if (!name) continue
      if (stateNames.has(name)) errors.push(`media.states 状态 name 重复：${name}`)
      else stateNames.add(name)
    }
  }
  if (!String(raw.name || '').trim()) errors.push('资产卡缺少 name')
  if (!ASSET_STATUSES.includes(raw.status)) errors.push(`status 非法：${raw.status}`)
  if (raw.variantOf) {
    if (!isValidAssetId(raw.variantOf)) errors.push(`variantOf 非法：${raw.variantOf}`)
    else {
      const base = splitAssetId(raw.variantOf)
      if (base && base.variant) errors.push(`variantOf 必须是基础编号（不含变体）：${raw.variantOf}`)
      if (normalizeAssetId(raw.variantOf) === id) errors.push('variantOf 不能引用自身')
      const accepted = Array.isArray(existingCards) ? existingCards : []
      if (accepted.length && !accepted.some((item) => normalizeAssetId(item.id) === normalizeAssetId(raw.variantOf))) {
        errors.push(`variantOf 引用的基础资产不存在：${raw.variantOf}`)
      }
    }
  }
  // aliases 同类型唯一（跨卡）
  const accepted = Array.isArray(existingCards) ? existingCards : []
  const aliases = Array.isArray(raw.aliases) ? raw.aliases : []
  for (const other of accepted) {
    if (!other || normalizeAssetId(other.id) === id) continue
    if (String(other.type || '').toUpperCase() !== String(raw.type || '').toUpperCase()) continue
    const otherAliases = Array.isArray(other.aliases) ? other.aliases : []
    for (const alias of aliases) {
      if (otherAliases.some((item) => String(item).trim().toLowerCase() === String(alias).trim().toLowerCase())) {
        errors.push(`aliases 与同类型资产 ${other.id} 重复：${alias}`)
      }
    }
  }
  return errors
}

/** 按 id 稳定排序（确定性输出）。 */
export function sortAssetCards(cards) {
  return (Array.isArray(cards) ? cards.slice() : []).sort((a, b) => String(a.id).localeCompare(String(b.id), 'en'))
}

/** 构造权威索引对象（v1 无时间戳；assets 按 id 稳定排序）。 */
export function buildAssetIndex(cards) {
  return { schemaVersion: 1, assets: sortAssetCards(cards.map((card) => normalizeAssetCard(card))) }
}

/** v0.16.195：canonical 存储索引（有 states 的卡 schemaVersion=2；其余保持 1，兼容旧测试/旧卡）。 */
export function buildAssetStorageIndex(cards) {
  const assets = sortAssetCards(cards.map((card) => normalizeAssetCard(card, { storage: true })))
  const hasStateCard = assets.some((card) => card && card.media && Array.isArray(card.media.states) && card.media.states.length > 0)
  return { schemaVersion: hasStateCard ? 2 : 1, assets }
}

/** 读取兼容：接受 {schemaVersion,assets} 或裸数组；归一+排序。 */
export function normalizeAssetIndex(data) {
  const list = Array.isArray(data) ? data : data && Array.isArray(data.assets) ? data.assets : []
  return buildAssetIndex(list)
}

/**
 * 引用校验（2-1 纯函数；结果供 task-94 checks 接入为 WARN）：
 * - 占位符格式非法 → asset-placeholder-invalid；
 * - 占位符/原生文本引用资产卡不存在 → asset-reference-missing；
 * @param {{cards?:Array, texts?:string[]}} input
 */
export function checkAssetReferences({ cards = [], texts = [] } = {}) {
  const known = new Set((Array.isArray(cards) ? cards : []).map((card) => normalizeAssetId(card && card.id)).filter(Boolean))
  const warnings = []
  for (const text of Array.isArray(texts) ? texts : []) {
    for (const item of parseAssetPlaceholders(text)) {
      if (!item.valid) {
        warnings.push({ code: 'asset-placeholder-invalid', assetId: item.id, message: `占位符格式非法：${item.raw}` })
        continue
      }
      if (!known.has(item.id)) {
        warnings.push({ code: 'asset-reference-missing', assetId: item.id, message: `引用了不存在的资产卡：${item.id}` })
      }
    }
  }
  return { ok: warnings.length === 0, warnings }
}

