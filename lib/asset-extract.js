/**
 * C4a（A 阶段）：资产剥离 `asset-extract` —— 确定性规则解析剧本 + draft 卡创建（纯函数 + 写编排）。
 *
 * 契约：`需求/需求分析-C4a-资产剥离-asset-extract-v1.md` v1.1（Lead 已批 + 5 裁定）
 * - preview：只读解析 `分集剧本/第NNN集.md`（默认：有已定稿集→只解析定稿集，否则全部有文本集）；
 *   角色=对白前缀（排除旁白/画外音/VO/OS/字幕/标题等保留词）、场景=`## 场景…` 标题、道具=仅显式标记；
 *   与现有卡按 id/name/aliases 去重；证据 `{episodes:[{order,lineNo,line}],matchedBy}`；确定性排序；≤200。
 * - apply：服务端重校验/去重/分配 ID（以服务端为准）；expectedHash：cards.json 不存在→`''` 允许创建，
 *   存在→必须=当前 sha256（缺/空/不符→409 conflict+currentHash 零写）；创建 `status:'draft'` 卡 +
 *   add-only `extractedFrom:{sources:[相对路径…],episodes:[…],evidence?}`；单次 `store.writeCardsDoc`
 *   （snapshot 20 + guarded 原子写）；不写 style/scenes/review；失败零写。
 * - 不改 store.js（复用其既有导出：readCardsDoc/writeCardsDoc/listEpisodes/readEpisode/getFinalized/episodeFileName/isDirectory）。
 */
import { isAbsolute, normalize, sep } from 'node:path'

import * as store from './store.js'
import * as assetCards from './assets.js'

export const EXTRACT_TYPES = Object.freeze(['CHR', 'SPC', 'PRP'])
export const EXTRACT_MAX_CANDIDATES = 200
export const EXTRACT_SOURCE_DIR = '分集剧本'
export const EXTRACT_INPUT_KEYS = Object.freeze(['title', 'episodes', 'mode', 'candidates', 'expectedHash', 'operationId'])
export const EXTRACT_RESERVED_CHARACTERS = Object.freeze([
  '旁白',
  '画外音',
  '画外',
  'VO',
  'OS',
  '字幕',
  '标题',
  '动作',
  '转场',
  '画面',
  '场景',
  '音效',
  '镜头',
  '道具',
  '道具表',
  '物品',
  '装备',
])
const RESERVED = new Set(EXTRACT_RESERVED_CHARACTERS.map((item) => item.toUpperCase()))
const CHARACTER_PATTERN = /^([\u4e00-\u9fa5A-Za-z0-9_·]{1,20})\s*[：:]\s*(.+)$/
const SCENE_HEADING_PATTERN = /^##\s*场景\s*([0-9]+)?\s*[：:、.\-]?\s*(.+)$/
const PROP_PATTERNS = [/^(?:道具表|道具|物品|装备)\s*[：:]\s*(.+)$/, /^【道具】\s*(.+)$/]

/** 带 code 的业务错误（与宿主既有 invalid-args/conflict/not-found 风格一致）。 */
export function extractError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

const clipLine = (line) => String(line == null ? '' : line).trim().slice(0, 120)
const lineEvidence = (order, lineNo, line) => ({ order: Number(order), lineNo, line: clipLine(line) })
const TEXT_CHAR = /[\u4e00-\u9fa5A-Za-z0-9_·]/

function normalizeName(value, max = 120) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/[。；;，,、：:！!？?…\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, max)
}

function parseSceneHeading(raw) {
  const match = SCENE_HEADING_PATTERN.exec(raw)
  if (!match) return null
  const body = normalizeName(match[2])
  if (!body) return null
  const tokens = body
    .split(/\s*[-－—–]\s*/)
    .map((item) => item.trim())
    .filter(Boolean)
  let interior = ''
  let time = ''
  const rest = []
  for (const token of tokens) {
    if (!interior && ['内景', '外景', '内外景'].includes(token)) {
      interior = token
      continue
    }
    if (!time && /^(夜|日|晨|清晨|黄昏|傍晚|中午|午|凌晨|白天|夜晚|深夜)/.test(token)) {
      time = token
      continue
    }
    rest.push(token)
  }
  const location = rest.join('-')
  const name = [location, time].filter(Boolean).join('-') || body
  return { name, heading: raw.trim(), interior, location, time: time || '', body }
}

function splitPropNames(text) {
  return String(text == null ? '' : text)
    .split(/[、,，/；;]+/)
    .map((item) => normalizeName(item))
    .filter(Boolean)
}

/**
 * 解析一集剧本（纯函数、无 I/O）。规则见需求 §2/v1.1：
 * - 角色：对白行 `角色：台词`（排除保留词；名称 1–20）；
 * - 场景：`## 场景 N：...`（容错无空格/无冒号；解析内/外景、地点、时间）；
 * - 道具：仅显式 `道具：`/`道具:`/`道具表：`/`【道具】`；
 * - 其他“像候选但格式不符”的行跳过并计数（不猜）。
 * @returns {{characters:Array, scenes:Array, props:Array, skippedLines:number, propsSkipped:boolean}}
 */
export function parseEpisodeDoc(text, { order = 1 } = {}) {
  const rawText = typeof text === 'string' ? text : ''
  const lines = rawText.split(/\r?\n/)
  const characters = new Map()
  const scenes = []
  const props = new Map()
  let skippedLines = 0
  let explicitProps = 0
  lines.forEach((raw, index) => {
    const line = String(raw || '').trim()
    if (!line) return
    const lineNo = index + 1
    const scene = parseSceneHeading(line)
    if (scene) {
      scenes.push({ ...scene, evidence: [lineEvidence(order, lineNo, line)] })
      return
    }
    // 道具显式标记先于对白判定（避免“道具：…”被误当角色）
    let matchedProp = false
    for (const pattern of PROP_PATTERNS) {
      const match = pattern.exec(line)
      if (!match) continue
      matchedProp = true
      explicitProps += 1
      for (const name of splitPropNames(match[1])) {
        const entry = props.get(name) || { name, evidence: [] }
        entry.evidence.push(lineEvidence(order, lineNo, line))
        props.set(name, entry)
      }
      break
    }
    if (matchedProp) return
    const dialogue = CHARACTER_PATTERN.exec(line)
    if (dialogue) {
      const rawName = String(dialogue[1] || '').trim()
      const name = normalizeName(rawName, 20)
      const speech = String(dialogue[2] || '').trim()
      const invalidName = !name || name.length > 20 || !TEXT_CHAR.test(name) || RESERVED.has(name.toUpperCase()) || /^[\d_·]+$/.test(name)
      if (invalidName || !speech) {
        if (name && !RESERVED.has(name.toUpperCase())) skippedLines += 1
        return
      }
      const entry = characters.get(name) || { name, evidence: [] }
      entry.evidence.push(lineEvidence(order, lineNo, line))
      characters.set(name, entry)
      return
    }
    // 只有“疑似结构行”才算格式不符（普通散文/动作段落不计入 skippedLines，避免噪声）
    if (/^#+\s*场景/.test(line) || /^[^\s：:]{1,40}\s*[：:]\s*\S/.test(line)) skippedLines += 1
  })
  return {
    characters: [...characters.values()],
    scenes,
    props: [...props.values()],
    skippedLines,
    propsSkipped: explicitProps === 0,
  }
}

function candidateKey(type, name) {
  return `${type}:${normalizeName(name).toLowerCase()}`
}

function mergeEvidence(target, evidence = []) {
  const seen = new Set(target.evidence.map((item) => `${item.order}:${item.lineNo}`))
  for (const item of evidence) {
    const key = `${item.order}:${item.lineNo}`
    if (seen.has(key)) continue
    seen.add(key)
    target.evidence.push({ ...item })
  }
  target.evidence.sort((a, b) => a.order - b.order || a.lineNo - b.lineNo)
}

/**
 * 聚合多集解析结果为候选（去重/与现有卡去重/建议 ID/确定性排序/≤200）。
 * @param {Array<{order:number, parsed:object}>} episodes
 * @param {{existingCards?:Array}} [options]
 */
export function extractCandidates(episodes, { existingCards = [] } = {}) {
  const buckets = new Map()
  let skippedLines = 0
  let propsAny = false
  for (const item of Array.isArray(episodes) ? episodes : []) {
    const parsed = item && item.parsed ? item.parsed : null
    if (!parsed) continue
    skippedLines += Number(parsed.skippedLines) || 0
    if (!parsed.propsSkipped) propsAny = true
    for (const character of parsed.characters || []) {
      const key = candidateKey('CHR', character.name)
      const candidate = buckets.get(key) || { type: 'CHR', name: character.name, evidence: [], matchedBy: 'dialogue' }
      mergeEvidence(candidate, character.evidence)
      buckets.set(key, candidate)
    }
    for (const scene of parsed.scenes || []) {
      const key = candidateKey('SPC', scene.name)
      const candidate = buckets.get(key) || { type: 'SPC', name: scene.name, evidence: [], matchedBy: 'scene-heading', scene: { interior: scene.interior, location: scene.location, time: scene.time, heading: scene.heading } }
      mergeEvidence(candidate, scene.evidence)
      buckets.set(key, candidate)
    }
    for (const prop of parsed.props || []) {
      const key = candidateKey('PRP', prop.name)
      const candidate = buckets.get(key) || { type: 'PRP', name: prop.name, evidence: [], matchedBy: 'explicit-prop' }
      mergeEvidence(candidate, prop.evidence)
      buckets.set(key, candidate)
    }
  }
  const existing = Array.isArray(existingCards) ? existingCards : []
  const existingIds = new Set(existing.map((card) => String(card.id || '').toUpperCase()).filter(Boolean))
  const existingNames = new Set()
  const existingCardByKey = new Map()
  for (const card of existing) {
    const type = String(card.type || '').toUpperCase()
    if (!EXTRACT_TYPES.includes(type)) continue
    const cardId = String(card.id || '').toUpperCase()
    const nameKey = candidateKey(type, card.name)
    existingNames.add(nameKey)
    if (cardId && !existingCardByKey.has(nameKey)) existingCardByKey.set(nameKey, cardId)
    for (const alias of Array.isArray(card.aliases) ? card.aliases : []) {
      const aliasKey = candidateKey(type, alias)
      existingNames.add(aliasKey)
      if (cardId && !existingCardByKey.has(aliasKey)) existingCardByKey.set(aliasKey, cardId)
    }
  }
  const typeRank = { CHR: 0, SPC: 1, PRP: 2 }
  const candidates = [...buckets.values()].sort((a, b) => {
    const typeDiff = (typeRank[a.type] || 0) - (typeRank[b.type] || 0)
    if (typeDiff) return typeDiff
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  const allocated = new Set(existingIds)
  for (const candidate of candidates) {
    const key = candidateKey(candidate.type, candidate.name)
    if (existingNames.has(key)) {
      candidate.skipReason = 'duplicate-existing'
      const matchedCardId = existingCardByKey.get(key)
      if (matchedCardId) candidate.matchedCardId = matchedCardId
      continue
    }
    const suggestedId = assetCards.nextAssetId([...allocated], candidate.type)
    candidate.suggestedId = suggestedId
    allocated.add(suggestedId)
  }
  const limited = candidates.slice(0, EXTRACT_MAX_CANDIDATES)
  const summary = {
    total: limited.length,
    characters: limited.filter((item) => item.type === 'CHR').length,
    scenes: limited.filter((item) => item.type === 'SPC').length,
    props: limited.filter((item) => item.type === 'PRP').length,
    existingSkipped: limited.filter((item) => item.skipReason === 'duplicate-existing').length,
    skippedLines,
    propsSkipped: !propsAny,
    truncated: candidates.length > EXTRACT_MAX_CANDIDATES,
  }
  return { candidates: limited, summary }
}

function sanitizeEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out = {}
  if (typeof value.matchedBy === 'string' && value.matchedBy.trim()) out.matchedBy = value.matchedBy.trim().slice(0, 40)
  if (typeof value.line === 'string' && value.line.trim()) out.line = value.line.trim().slice(0, 120)
  const episodes = []
  for (const item of Array.isArray(value.episodes) ? value.episodes : []) {
    if (!item || typeof item !== 'object') continue
    const order = Number(item.order)
    if (!Number.isInteger(order) || order < 1) continue
    const entry = { order }
    const lineNo = Number(item.lineNo)
    if (Number.isInteger(lineNo) && lineNo > 0) entry.lineNo = lineNo
    const line = typeof item.line === 'string' ? item.line.trim().slice(0, 120) : ''
    if (line) entry.line = line
    episodes.push(entry)
  }
  if (episodes.length) out.episodes = episodes.sort((a, b) => a.order - b.order || (a.lineNo || 0) - (b.lineNo || 0))
  return Object.keys(out).length ? out : null
}

/** 校验并归一 `asset-extract` 业务入参（transport cwd/sessionId 由 index 先剔除）。 */
export function parseAssetExtractInput(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : null
  if (!raw) throw extractError('invalid-args', 'asset-extract 入参必须是对象')
  for (const key of Object.keys(raw)) {
    if (!EXTRACT_INPUT_KEYS.includes(key)) throw extractError('invalid-args', `asset-extract 不支持字段：${key}`)
  }
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title) throw extractError('invalid-args', '缺少 title')
  const mode = raw.mode === undefined ? '' : String(raw.mode)
  if (mode !== 'preview' && mode !== 'apply') throw extractError('invalid-args', "mode 必须是 'preview' 或 'apply'")
  let episodes = null
  if (raw.episodes !== undefined && raw.episodes !== null) {
    if (!Array.isArray(raw.episodes)) throw extractError('invalid-args', 'episodes 必须是集号数组')
    const set = new Set()
    for (const item of raw.episodes) {
      const order = Number(item)
      if (!Number.isInteger(order) || order < 1 || order > 9999) throw extractError('invalid-args', `episodes 集号非法：${item}`)
      set.add(order)
    }
    episodes = [...set].sort((a, b) => a - b)
  }
  let operationId = null
  if (raw.operationId !== undefined && raw.operationId !== null) {
    if (typeof raw.operationId !== 'string') throw extractError('invalid-args', 'operationId 必须是字符串')
    operationId = raw.operationId.trim().slice(0, 120) || null
  }
  if (mode === 'preview') {
    return { title, mode, episodes, operationId, candidates: null, expectedHash: null }
  }
  // apply
  if (!Array.isArray(raw.candidates)) throw extractError('invalid-args', 'apply 必须携带 candidates 数组')
  if (raw.candidates.length < 1) throw extractError('invalid-args', 'apply candidates 不能为空')
  if (raw.candidates.length > EXTRACT_MAX_CANDIDATES) throw extractError('invalid-args', `apply candidates 超过上限（${EXTRACT_MAX_CANDIDATES}）`)
  const candidates = raw.candidates.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw extractError('invalid-args', `candidates[${index}] 必须是对象`)
    const name = normalizeName(item.name)
    if (!name) throw extractError('invalid-args', `candidates[${index}] 缺少 name`)
    const type = String(item.type || '').toUpperCase()
    if (!EXTRACT_TYPES.includes(type)) throw extractError('invalid-args', `candidates[${index}] type 非法：${item.type}（只允许 ${EXTRACT_TYPES.join('/')}）`)
    const evidence = sanitizeEvidence(item.evidence)
    return { name, type, evidence }
  })
  if (typeof raw.expectedHash !== 'string') throw extractError('invalid-args', "apply 必须提供 expectedHash 字符串（cards.json 不存在时传 ''）")
  return { title, mode, episodes, operationId, candidates, expectedHash: raw.expectedHash.trim() }
}

/** 按请求读取剧集文本：指定集 > 已定稿集 > 全部有文本集；返回 scopeUsed。 */
export async function readExtractionEpisodes(root, title, requestedEpisodes = null) {
  const projectPath = store.projectDir(root, title)
  if (!(await store.isDirectory(projectPath))) throw extractError('not-found', `短剧《${title}》不存在`)
  let scopeUsed = 'requested'
  let orders = Array.isArray(requestedEpisodes) ? requestedEpisodes : []
  if (!orders.length) {
    const finalized = await store.getFinalized(root, title).catch(() => [])
    const finalizedOrders = finalized.map((item) => Number(item.order)).filter((order) => Number.isInteger(order) && order > 0)
    if (finalizedOrders.length) {
      scopeUsed = 'finalized'
      orders = [...new Set(finalizedOrders)].sort((a, b) => a - b)
    } else {
      scopeUsed = 'all'
      const listed = await store.listEpisodes(root, title).catch(() => [])
      orders = listed.map((item) => Number(item.order)).filter((order) => Number.isInteger(order) && order > 0)
    }
  } else {
    scopeUsed = 'requested'
  }
  const episodes = []
  for (const order of orders) {
    const { text } = await store.readEpisode(root, title, order)
    if (!String(text || '').trim()) continue
    episodes.push({ order, text })
  }
  return { scopeUsed, episodes }
}

/** 预览：只读；不建 cards.json、不写 style/scenes。 */
export async function previewExtraction(root, title, parsed, { existingCards = null } = {}) {
  const { scopeUsed, episodes } = await readExtractionEpisodes(root, title, parsed.episodes)
  let existing = existingCards
  if (!Array.isArray(existing)) {
    const current = await store.readCardsDoc(root, title, 'asset')
    existing = current.doc ? assetCards.normalizeAssetIndex(current.doc).assets : []
  }
  const parsedEpisodes = episodes.map((item) => ({ order: item.order, parsed: parseEpisodeDoc(item.text, { order: item.order }) }))
  const { candidates, summary } = extractCandidates(parsedEpisodes, { existingCards: existing })
  const merged = {
    scannedEpisodes: episodes.length,
    ...summary,
  }
  return {
    mode: 'preview',
    scopeUsed,
    summary: merged,
    candidates,
    ...(episodes.length === 0 ? { hint: '未发现可解析的剧本集（分集剧本目录为空或内容为空）' } : {}),
  }
}

function sourcesFromEvidence(evidence) {
  const sources = []
  for (const item of evidence && Array.isArray(evidence.episodes) ? evidence.episodes : []) {
    const order = Number(item.order)
    if (!Number.isInteger(order) || order < 1) continue
    sources.push(`${EXTRACT_SOURCE_DIR}/${store.episodeFileName(order)}`)
  }
  return [...new Set(sources)].sort()
}

function normalizeSourcesList(value) {
  const out = []
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== 'string') continue
    const raw = item.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    if (!raw || raw.length > 200) continue
    if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('/') || raw.split('/').includes('..')) continue
    out.push(raw)
  }
  return [...new Set(out)].sort()
}

/**
 * 应用：服务端重校验/去重/分配 ID；单次 writeCardsDoc 原子写；失败零写。
 * 返回 { mode:'apply', summary, candidates, hash }。
 */
export async function applyExtraction(root, title, parsed) {
  const projectPath = store.projectDir(root, title)
  if (!(await store.isDirectory(projectPath))) throw extractError('not-found', `短剧《${title}》不存在`)
  const current = await store.readCardsDoc(root, title, 'asset')
  const currentHash = current.hash
  if (currentHash === null) {
    if (parsed.expectedHash !== '') throw extractError('conflict', 'cards.json 不存在时 expectedHash 必须传空串（创建语义）', { currentHash: null })
  } else if (parsed.expectedHash !== currentHash) {
    throw extractError('conflict', 'cards.json 已被其他写入修改（expectedHash 不符）', { currentHash })
  }
  const existing = current.doc ? assetCards.normalizeAssetIndex(current.doc).assets : []
  const existingNames = new Set()
  for (const card of existing) {
    const type = String(card.type || '').toUpperCase()
    if (!EXTRACT_TYPES.includes(type)) continue
    existingNames.add(candidateKey(type, card.name))
    for (const alias of Array.isArray(card.aliases) ? card.aliases : []) existingNames.add(candidateKey(type, alias))
  }
  const ids = new Set(existing.map((card) => String(card.id || '').toUpperCase()).filter(Boolean))
  const sorted = parsed.candidates
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => {
      const typeRank = { CHR: 0, SPC: 1, PRP: 2 }
      const diff = (typeRank[a.type] || 0) - (typeRank[b.type] || 0)
      if (diff) return diff
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })
  const created = []
  let skippedDuplicates = 0
  for (const candidate of sorted) {
    const key = candidateKey(candidate.type, candidate.name)
    if (existingNames.has(key)) {
      skippedDuplicates += 1
      continue
    }
    const id = assetCards.nextAssetId([...ids], candidate.type)
    const evidence = candidate.evidence || null
    const sources = sourcesFromEvidence(evidence)
    const extractedFrom = normalizeSourcesList(sources).length
      ? { sources: normalizeSourcesList(sources), episodes: [...new Set((evidence.episodes || []).map((item) => Number(item.order)).filter((order) => Number.isInteger(order) && order > 0))].sort((a, b) => a - b), ...(evidence ? { evidence } : {}) }
      : null
    const card = assetCards.normalizeAssetCard({
      id,
      type: candidate.type,
      name: candidate.name,
      status: 'draft',
      ...(extractedFrom ? { extractedFrom } : {}),
    })
    const errors = assetCards.validateAssetCard(card, { existingCards: [...existing, ...created] })
    if (errors.length) throw extractError('invalid-args', `候选非法（${candidate.name}）：${errors.join('；')}`)
    ids.add(id)
    existingNames.add(key)
    created.push(card)
  }
  const result = {
    mode: 'apply',
    summary: { total: parsed.candidates.length, created: created.length, skippedDuplicates },
    candidates: created.map((card) => ({ id: card.id, name: card.name, type: card.type, status: card.status })),
  }
  if (!created.length) {
    return { ...result, hash: currentHash }
  }
  const nextCards = [...existing, ...created]
  const written = await store.writeCardsDoc(root, title, 'asset', nextCards)
  return { ...result, hash: written.hash }
}

/** index 入口：preview 只读 / apply 写（apply 由 index 包 txn 锁+审计+operationId 幂等）。 */
export async function runAssetExtract(root, parsed) {
  if (parsed.mode === 'preview') {
    const preview = await previewExtraction(root, parsed.title, parsed)
    return { ok: true, ...preview }
  }
  const applied = await applyExtraction(root, parsed.title, parsed)
  return { ok: true, ...applied }
}

export { normalizeSourcesList }
