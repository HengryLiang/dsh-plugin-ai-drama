/**
 * v0.11.0（task-93 / 2-1）：资产编号体系与资产卡纯函数（无 I/O、无时间戳、确定性）。
 *
 * 编号规范（Lead 批准）：
 * - 9 类前缀：CHR 角色 / SPC 场景 / PRP 道具 / SHT 镜头资产 / CST 服装 / EXP 表情 / SFX 特效 / VOX 配音 / MUS 音乐；
 * - 基础编号 `<前缀><3 位序号>`（如 CHR001），可选变体后缀 `_01`–`_99`（如 CHR001_02）；
 * - 大小写不敏感，存储统一大写；占位符 `{{Asset_<ID>_<字段>}}`（如 {{Asset_CHR001_name}}）。
 *
 * 资产卡 schema（写入/读取统一经 normalizeAssetCard）：
 * { id, type, name, variantOf, aliases[], status, version, fields{}, relations{}, prompts{}, history[] }
 * - status canonical：draft | active | retired（读兼容 archived→retired，未知值→draft）；
 * - v1 **不含时间戳**（确定性）；history 条目仅 { version, change }，add-only。
 */
import path from 'node:path'

export const ASSET_PREFIXES = ['CHR', 'SPC', 'PRP', 'SHT', 'CST', 'EXP', 'SFX', 'VOX', 'MUS']

export const ASSET_TYPE_LABELS = {
  CHR: '角色',
  SPC: '场景',
  PRP: '道具',
  SHT: '镜头资产',
  CST: '服装',
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

/**
 * v0.15.1/v0.15.2：media 写入校验（纯函数，返回错误字符串数组）。
 * - media 可为 null/undefined（不写字段）；
 * - 只允许 images(1–6 项字符串)/thumbnail(字符串)/audio(1–6 项字符串)；其它键 → 拒绝；
 * - 元素仅 http(s) URL 或项目相对路径（禁 .. 逃逸/盘符/UNC/空段/控制字符，≤500 字）；
 * - audio 扩展名白名单 mp3/wav/m4a/ogg/aac（大小写不敏感；URL 用 pathname 取扩展名）；
 * - 去重后 0/>6 项 → 拒绝；thumbnail 空串视为省略。
 * - 存储层只校验路径/扩展名/数量；文件大小 ≤8MB 由 media-read 读取时（too-large）执行。
 */
export function validateMediaInput(media) {
  const errors = []
  if (media == null) return errors
  if (typeof media !== 'object' || Array.isArray(media)) return ['media 必须是对象 { images?, thumbnail?, audio? }']
  for (const key of Object.keys(media).sort()) {
    if (!['images', 'thumbnail', 'audio'].includes(key)) errors.push(`media 不支持字段：${key}（只允许 images/thumbnail/audio）`)
  }
  if (media.images != null) {
    if (!Array.isArray(media.images)) errors.push('media.images 必须是字符串数组')
    else {
      if (media.images.length === 0) errors.push('media.images 不能为空数组')
      const unique = []
      for (const item of media.images) {
        if (typeof item !== 'string') {
          errors.push('media.images 元素必须是字符串')
          continue
        }
        const text = item.trim()
        if (!isValidMediaRef(text)) errors.push(`media.images 项非法：${item}（仅 http(s) URL 或项目相对路径；禁 .. 逃逸/盘符/UNC；≤${MEDIA_STRING_MAX} 字）`)
        else if (!unique.includes(text)) unique.push(text)
      }
      if (unique.length > MEDIA_IMAGE_MAX) errors.push(`media.images 去重后最多 ${MEDIA_IMAGE_MAX} 项（当前 ${unique.length}）`)
    }
  }
  if (media.thumbnail != null) {
    if (typeof media.thumbnail !== 'string') errors.push('media.thumbnail 必须是字符串')
    else if (media.thumbnail.trim() && !isValidMediaRef(media.thumbnail)) {
      errors.push(`media.thumbnail 非法：${media.thumbnail}（仅 http(s) URL 或项目相对路径；禁 .. 逃逸/盘符/UNC；≤${MEDIA_STRING_MAX} 字）`)
    }
  }
  if (media.audio != null) {
    if (!Array.isArray(media.audio)) errors.push('media.audio 必须是字符串数组')
    else {
      if (media.audio.length === 0) errors.push('media.audio 不能为空数组')
      const unique = []
      for (const item of media.audio) {
        if (typeof item !== 'string') {
          errors.push('media.audio 元素必须是字符串')
          continue
        }
        const text = item.trim()
        if (!isValidAudioMediaRef(text)) {
          errors.push(`media.audio 项非法：${item}（仅 mp3/wav/m4a/ogg/aac；http(s) URL 或项目相对路径；禁 .. 逃逸/盘符/UNC；≤${MEDIA_STRING_MAX} 字）`)
        } else if (!unique.includes(text)) unique.push(text)
      }
      if (unique.length > MEDIA_AUDIO_MAX) errors.push(`media.audio 去重后最多 ${MEDIA_AUDIO_MAX} 项（当前 ${unique.length}）`)
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
export function normalizeAssetMedia(media) {
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
  return Object.keys(normalized).length ? normalized : undefined
}

/** 合法编号正则：前缀 + 3 位序号 + 可选 _01–_99 变体。 */
export const ASSET_ID_PATTERN = /^(CHR|SPC|PRP|SHT|CST|EXP|SFX|VOX|MUS)[0-9]{3}(?:_(?:0[1-9]|[1-9][0-9]))?$/

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
  if (next > 999) throw new Error(`前缀 ${normalizedPrefix} 的编号已用尽（上限 999）`)
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
    const idMatch = content.match(/^([A-Za-z]{3}[0-9]{3}(?:_[0-9]{2})?)(?:_([A-Za-z][A-Za-z0-9_-]*))?$/)
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
    const pattern = new RegExp(`${prefix}[0-9]{3}(?:_(?:0[1-9]|[1-9][0-9]))?`, 'g')
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
 * 资产卡归一（幂等、确定性；不含时间戳）。
 * - id 大写；type 由 id 前缀推导（输入 type 不一致时保留输入供校验报错，校验后写库用推导值）；
 * - status：archived→retired，未知→draft；
 * - version：正整数默认 1；history：仅保留 {version, change} 且按原顺序（add-only）。
 */
export function normalizeAssetCard(input) {
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
  const media = normalizeAssetMedia(raw.media)
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
    prompts: normalizePlainObject(raw.prompts),
    // v0.15.1（task-107）：media add-only（仅有效内容时输出；旧卡无 media 输出字节不变）
    ...(media ? { media } : {}),
    history,
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
  else if (!isValidAssetId(id)) errors.push(`资产编号非法：${raw.id}（应为 9 类前缀 + 3 位序号，可选 _01–_99 变体）`)
  const parts = splitAssetId(id)
  if (parts && raw.type && String(raw.type).toUpperCase() !== parts.prefix) {
    errors.push(`type=${raw.type} 与编号前缀 ${parts.prefix} 不一致`)
  }
  if (!parts && raw.type && !isValidAssetPrefix(raw.type)) errors.push(`type 非法：${raw.type}`)
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
