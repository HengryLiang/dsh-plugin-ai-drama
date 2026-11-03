/**
 * v0.16.220 P0-A：资产事实源解析 + 资产段编译 + 缺失资产预检（纯函数，无 I/O/无时间戳）。
 *
 * 来源优先级（只读）：
 *   storyboard.shot.assetIds / assetStateBindings
 *   + .aidrama/assets/cards.json
 *   + .aidrama/assets.json（旧登记；仅回退/映射，失败显式 unmapped）
 *   analysis overlay 不参与。
 *
 * 输出契约（每资产）：{ id, name, type, stateId, stateName, refPath, status, stateUnbound, refIssue? }
 * - refPath 只允许项目相对路径 `素材/短剧资产/...`，越界/HTTP/空 → null + refIssue；
 * - status: resolved | missing_media | missing_card | unmapped。
 */
import { isValidAssetId, normalizeAssetId } from './assets.js'

export const ASSET_LIBRARY_RELATIVE = '素材/短剧资产'
export const ASSET_SEGMENT_MAX_CHARS = 2000
export const ASSET_SEGMENT_MAX_ITEMS = 12
export const ASSET_SEGMENT_HEADER = '【本镜资产】'

const ASSET_REL_PREFIX = `${ASSET_LIBRARY_RELATIVE}/`
const ASSET_TYPE_PREFIXES = ['CHR', 'SPC', 'PRP', 'SHT', 'CST', 'VEH', 'EXP', 'SFX', 'VOX', 'MUS']
const STATUS_LABELS = {
  resolved: '已解析',
  missing_media: '缺资产图',
  missing_card: '资产卡不存在',
  unmapped: '旧素材未映射',
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function slash(value) {
  return String(value == null ? '' : value).replace(/\\/g, '/')
}

/** 归一引用路径；只接受项目相对且位于 素材/短剧资产/ 下的安全路径。 */
export function normalizeAssetRefPath(value) {
  const raw = textOf(value)
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return { path: null, issue: 'not-local' }
  const normalized = slash(raw).replace(/\/+/g, '/')
  if (!normalized.startsWith(ASSET_REL_PREFIX)) return { path: null, issue: 'outside-assets-dir' }
  const segments = normalized.split('/')
  if (segments.some((part) => !part || part === '.' || part === '..')) return { path: null, issue: 'unsafe-path' }
  return { path: normalized, issue: null }
}

function typeOfId(id) {
  const normalized = normalizeAssetId(id)
  const match = normalized.match(/^([A-Z]+)/)
  return match && ASSET_TYPE_PREFIXES.includes(match[1]) ? match[1] : ''
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function stateListOf(card) {
  const media = card && card.media && typeof card.media === 'object' ? card.media : {}
  const states = asArray(media.states)
    .filter((state) => state && typeof state === 'object' && !Array.isArray(state))
    .map((state) => ({
      id: textOf(state.id),
      name: textOf(state.name) || '默认',
      images: asArray(state.images).map((item) => textOf(item)).filter(Boolean),
    }))
    .filter((state) => state.id)
  const images = asArray(media.images).map((item) => textOf(item)).filter(Boolean)
  return { media, states, images }
}

function pickRefPath(images) {
  for (const image of asArray(images)) {
    const checked = normalizeAssetRefPath(image)
    if (checked.path) return { refPath: checked.path, refIssue: null }
    if (checked.issue && checked.issue !== 'not-local') return { refPath: null, refIssue: checked.issue }
  }
  return { refPath: null, refIssue: null }
}

function legacyIndex(legacyAssets) {
  const map = new Map()
  for (const item of asArray(legacyAssets)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    for (const key of [item.id, item.assetId]) {
      const value = textOf(key)
      if (!value) continue
      if (!map.has(value)) map.set(value, item)
      const upper = value.toUpperCase()
      if (!map.has(upper)) map.set(upper, item)
    }
  }
  return map
}

function cardIndex(cards) {
  const map = new Map()
  for (const card of asArray(cards)) {
    if (!card || typeof card !== 'object') continue
    const id = normalizeAssetId(card.id)
    if (id) map.set(id, card)
  }
  return map
}

function bindingMapOf(shot) {
  const map = new Map()
  for (const binding of asArray(shot && shot.assetStateBindings)) {
    if (!binding || typeof binding !== 'object') continue
    const cardId = normalizeAssetId(binding.cardId)
    const stateId = textOf(binding.stateId)
    if (!cardId || !stateId) continue
    if (!map.has(cardId)) map.set(cardId, [])
    map.get(cardId).push(stateId)
  }
  return map
}

/**
 * 解析一镜的资产。
 * @param {object} shot
 * @param {{cards?:Array, legacyAssets?:Array}} options
 * @returns {Array<object>}
 */
export function resolveShotAssets(shot, options = {}) {
  const cards = asArray(options.cards)
  const legacyAssets = asArray(options.legacyAssets)
  const cardMap = cardIndex(cards)
  const legacyMap = legacyIndex(legacyAssets)
  const bindings = bindingMapOf(shot)
  const ids = []
  const seen = new Set()
  for (const raw of asArray(shot && shot.assetIds)) {
    const value = textOf(raw)
    if (!value) continue
    // 读侧旧 `cardId::stateId`：只取卡 ID；旧 binding 由 store 读归一补齐。
    const id = normalizeAssetId(value.split('::')[0])
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  // 旧数据可能只有 bindings 没有 assetIds：仅作为只读回退，不新增写字段。
  for (const id of bindings.keys()) {
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }

  return ids.map((requestedId) => {
    let card = cardMap.get(requestedId) || null
    let legacy = legacyMap.get(requestedId) || null
    let source = card ? 'card' : legacy ? 'legacy' : 'missing'
    if (!card && legacy) {
      // 旧 assets.json → 卡：只认显式映射字段，或 name 唯一匹配（不做模糊猜测）。
      const mappedId = normalizeAssetId(legacy.cardId || legacy.assetCardId || legacy.linkedCardId || legacy.mappedCardId)
      if (mappedId && cardMap.has(mappedId)) {
        card = cardMap.get(mappedId)
        source = 'legacy-map'
      } else {
        const legacyName = textOf(legacy.name)
        const matches = legacyName
          ? cards.filter((item) => String(item && item.name || '').trim() === legacyName)
          : []
        if (matches.length === 1 && matches[0] && cardMap.has(normalizeAssetId(matches[0].id))) {
          card = matches[0]
          source = 'legacy-name'
        }
      }
    }

    if (!card) {
      const id = requestedId
      return {
        id,
        name: textOf(legacy && legacy.name) || id,
        type: typeOfId(id) || textOf(legacy && legacy.kind).toUpperCase(),
        stateId: '',
        stateName: '',
        refPath: null,
        status: legacy ? 'unmapped' : 'missing_card',
        stateUnbound: false,
        refIssue: null,
        source,
      }
    }

    const id = normalizeAssetId(card.id) || requestedId
    const { media, states, images } = stateListOf(card)
    const cardBindings = bindings.get(id) || []
    const boundStateId = cardBindings[0] || ''
    const defaultState = states.find((state) => state.id === textOf(media.defaultStateId))
      || states.find((state) => state.id === 'default')
      || states[0]
      || null
    const boundState = boundStateId ? states.find((state) => state.id === boundStateId) || null : null
    const selectedState = boundState || defaultState || null
    const selectedImages = selectedState ? selectedState.images : images
    const { refPath, refIssue } = pickRefPath(selectedImages)
    // v0.16.220 AC：未显式绑定统一追加“（未显式绑定）”（不仅是多状态）；默认状态仍取 default/first。
    const stateUnbound = !boundStateId
    const stateMissing = Boolean(boundStateId && !boundState)
    const stateExists = !stateMissing
    const resolvedStatus = refPath ? (stateMissing ? 'missing_state' : 'resolved') : 'missing_media'
    const stateNameBase = selectedState ? selectedState.name : '默认'
    return {
      id,
      name: textOf(card.name) || id,
      type: String(card.type || typeOfId(id) || '').trim().toUpperCase(),
      stateId: selectedState ? selectedState.id : (selectedImages.length ? 'default' : ''),
      stateName: stateUnbound ? `${stateNameBase}（未显式绑定）` : stateNameBase,
      refPath,
      status: resolvedStatus,
      stateUnbound,
      stateBound: !stateUnbound,
      stateExists,
      stateMissing,
      refIssue: refIssue || (refPath ? null : 'no-image'),
      source,
      ...(cardBindings.length > 1 ? { boundStates: cardBindings.slice() } : {}),
    }
  })
}

export function resolveAssetsForShots(shots, options = {}) {
  const cards = asArray(options.cards)
  const legacyAssets = asArray(options.legacyAssets)
  return asArray(shots).map((shot) => resolveShotAssets(shot, { cards, legacyAssets }))
}

function assetLine(asset) {
  const id = textOf(asset && asset.id) || '?'
  const name = textOf(asset && asset.name) || id
  const state = textOf(asset && asset.stateName) || '—'
  const status = textOf(asset && asset.status)
  const ref = textOf(asset && asset.refPath)
  if ((status === 'resolved' || status === 'missing_state') && ref) return `${id} ${name}｜状态：${state}｜参考：${ref}`
  return `${id} ${name}｜状态：${state}｜参考：—（${STATUS_LABELS[status] || status || '未解析'}）`
}

/**
 * 编译固定资产段；无资产 → ''。格式（与 v0.16.219 核心格式对齐）：
 *   【本镜资产】
 *   CHR001 程砚｜状态：默认｜参考：素材/短剧资产/...
 * 资产段最多 12 条；≤maxChars 确定性截断：优先保留 ID/名称/状态，参考路径可截。
 */
export function compileAssetSegment(assets, options = {}) {
  const all = asArray(assets).filter((asset) => asset && textOf(asset.id))
  if (!all.length) return ''
  const list = all.slice(0, ASSET_SEGMENT_MAX_ITEMS)
  const maxChars = Math.max(0, Number.isFinite(Number(options.maxChars)) ? Math.round(Number(options.maxChars)) : ASSET_SEGMENT_MAX_CHARS)
  if (!maxChars) return ''

  const complete = [ASSET_SEGMENT_HEADER, ...list.map(assetLine)].join('\n')
  if (complete.length <= maxChars) return complete
  if (maxChars <= ASSET_SEGMENT_HEADER.length) return ASSET_SEGMENT_HEADER.slice(0, maxChars)

  const lines = [ASSET_SEGMENT_HEADER]
  let used = ASSET_SEGMENT_HEADER.length
  for (const asset of list) {
    const base = assetLine(asset)
    const separator = 1
    const prefix = base.slice(0, Math.max(0, base.indexOf('｜参考：') + 4))
    const clippedBase = base.length > prefix.length ? base : base
    if (used + separator + clippedBase.length <= maxChars) {
      lines.push(clippedBase)
      used += separator + clippedBase.length
      continue
    }
    const remain = maxChars - used - separator - prefix.length
    if (remain <= 0) break
    const ref = (asset.status === 'resolved' || asset.status === 'missing_state')
      ? textOf(asset.refPath)
      : '—（' + (STATUS_LABELS[asset.status] || asset.status || '未解析') + '）'
    const clipped = ref.length > remain ? `${ref.slice(0, Math.max(0, remain - 1))}…` : ref
    lines.push(prefix + clipped)
    used += separator + prefix.length + clipped.length
    break
  }
  return lines.join('\n').slice(0, maxChars)
}

/**
 * v0.16.264：按实际参考图顺序生成用户格式资产段（仅 references>0 使用）：
 *   【本镜资产】
 *   图片1 CHR001 程砚 | 状态：默认
 *   图片2 SPC004 程砚家一楼客厅
 * 场景卡（SPC/SCENE）无 state 时只写 id+名称；编号与上传/--left 顺序一致。
 */
export function compileReferenceAssetSegment(referenceAssets) {
  const list = asArray(referenceAssets).filter((asset) => asset && (textOf(asset.id) || textOf(asset.name)))
  if (!list.length) return ''
  const lines = [ASSET_SEGMENT_HEADER]
  list.forEach((asset, index) => {
    const id = textOf(asset.id) || '?'
    const name = textOf(asset.name) || id
    const type = textOf(asset.type).toUpperCase()
    const isScene = /^(SPC|SCENE)/.test(type)
    const stateName = textOf(asset.stateName).replace(/（未显式绑定）$/, '').trim()
    // v0.16.265：每行都带状态；场景/无 state 缺省「默认」，仍缺省用「—」
    const effectiveState = stateName || (isScene ? '默认' : '默认')
    const line = `图片${index + 1} ${id} ${name} | 状态：${effectiveState || '—'}`
    lines.push(line)
  })
  return lines.join('\n')
}

/** 把资产段追加到 prompt；无资产段时原样返回（旧字节不变）；最终 prompt ≤maxPromptChars。 */
export function appendAssetSegment(prompt, segment, options = {}) {
  const base = String(prompt == null ? '' : prompt)
  const text = textOf(segment)
  if (!text) return base
  const maxPromptChars = Math.max(0, Number.isFinite(Number(options.maxPromptChars)) ? Math.round(Number(options.maxPromptChars)) : ASSET_SEGMENT_MAX_CHARS)
  const bounded = text.length > ASSET_SEGMENT_MAX_CHARS ? text.slice(0, ASSET_SEGMENT_MAX_CHARS) : text
  if (maxPromptChars <= 0) return base
  const remain = Math.max(0, maxPromptChars - base.length - 1)
  if (!remain) return base
  const clipped = bounded.length > remain ? bounded.slice(0, Math.max(0, remain - 1)) + '…' : bounded
  return `${base}\n${clipped}`.slice(0, maxPromptChars)
}

/**
 * 缺资产预检（同步纯函数；refExists 可选注入，用于文件存在性 WARN）。
 * blockers 默认阻断 submit；warnings 放行（plan 同时列出）。
 */
export function assetPreflight(input = {}) {
  const warnings = []
  const blockers = []
  const assets = resolveShotAssets(input.shot, {
    cards: input.cards,
    legacyAssets: input.legacyAssets,
  })
  const shotNumber = textOf(input.shot && (input.shot.shotNumber || input.shot.shot))
  const refExists = typeof input.refExists === 'function' ? input.refExists : null
  for (const asset of assets) {
    const base = { shot: shotNumber, assetId: asset.id, name: asset.name, refPath: asset.refPath || '', status: asset.status }
    if (asset.status === 'missing_card') {
      blockers.push({ ...base, code: 'asset_missing_card', message: `资产卡不存在：${asset.id}` })
      continue
    }
    if (asset.status === 'unmapped') {
      warnings.push({ ...base, code: 'asset_unmapped', message: `旧素材无法映射到资产卡：${asset.id}` })
    }
    if (asset.status === 'missing_media' || !asset.refPath) {
      warnings.push({ ...base, code: 'asset_missing_media', message: `资产无可用参考图：${asset.id}` })
    }
    if (asset.stateUnbound) {
      warnings.push({ ...base, code: 'asset_state_binding_missing', message: `默认状态（未显式绑定）：${asset.id}` })
    }
    if (asset.stateMissing) {
      warnings.push({ ...base, code: 'asset_state_missing', message: `绑定状态不存在：${asset.id}::${asset.stateId}` })
    }
    if (asset.refIssue === 'outside-assets-dir' || asset.refIssue === 'unsafe-path') {
      blockers.push({ ...base, code: 'asset_ref_outside_assets', message: `参考图路径不在素材/短剧资产/：${asset.id}` })
    }
    if (asset.refPath && refExists && !refExists(asset.refPath)) {
      warnings.push({ ...base, code: 'asset_ref_missing', message: `参考图文件不存在：${asset.refPath}` })
    }
  }
  if (assets.length > ASSET_SEGMENT_MAX_ITEMS) {
    warnings.push({ shot: shotNumber, code: 'asset_segment_limit', message: `本镜资产 ${assets.length} 条，资产段仅保留前 ${ASSET_SEGMENT_MAX_ITEMS} 条` })
  }
  const segment = compileAssetSegment(assets)
  if (segment.length >= ASSET_SEGMENT_MAX_CHARS) {
    warnings.push({ shot: shotNumber, code: 'asset_segment_truncated', message: '资产段超过 2000 字，已确定性截断' })
  }
  return {
    assets,
    warnings,
    blockers,
    ok: blockers.length === 0,
  }
}
