/**
 * RC-26（v0.16.132）：资产库 v2 —— 旧项目资产卡图片自动迁移（`asset-cards-migrate`）。
 *
 * 口径（Lead 批准）：
 * - 扫描资产卡 `media.images[]` / `media.thumbnail` 的**项目内本地相对路径**；
 * - 复制到 `素材/短剧资产/<name>.<ext>`：sha256 去重（目标已有同 sha → reuse）；
 *   同名不同 sha → 加序号（`name-2.ext`…）；不删原图；幂等；per-file 失败收集可重试；
 * - 全部复制成功后**一次原子写** cards.json（version+1 + history「迁移资产图片」）；
 *   锁定卡（review.status==='final'）同样只做 media 路径规范化（不经面板锁校验，保留 review/prompts/fields）；
 * - `dryRun:true` 零写；`rewriteRefs:false` 仅拷贝不改卡；legacy `.aidrama/assets.json` 不迁移；
 * - 目标目录懒创建（guardedProjectWriteBinary/atomicWrite 自动 mkdir）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as store from './store.js'
import * as assetCards from './assets.js'

export const MIGRATION_DEFAULT_LIMIT = 200
export const MIGRATION_MAX_LIMIT = 2000
const MEDIA_READ_DISPLAY_MAX_BYTES = 8 * 1024 * 1024
const HASH_MAX_BYTES = 64 * 1024 * 1024
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i
/** media-read 当前白名单（可显示）；其它图片 ext 仍可拷贝但报告 displayable:false。 */
const MEDIA_READABLE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

function migrationError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  if (extra && typeof extra === 'object') Object.assign(error, extra)
  return error
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const isHttpRef = (text) => /^https?:\/\//i.test(text)

/** 仅接受项目内相对路径（禁 scheme/盘符/UNC/绝对/.. 段/空段/控制符）。 */
function normalizeLocalRef(raw) {
  const text = String(raw == null ? '' : raw).replace(/\\/g, '/').trim()
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return ''
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return ''
  if (text.startsWith('/')) return ''
  const segments = text.split('/')
  if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..')) return ''
  return text
}

/** 解析项目内相对文件（realpath 包含校验；symlink 目标必须仍在项目内）。 */
async function resolveProjectFile(realRoot, rel) {
  const abs = path.join(realRoot, ...rel.split('/'))
  let stat
  try { stat = await fs.lstat(abs) } catch { return null }
  if (stat.isSymbolicLink() || !stat.isFile()) return null
  let real
  try { real = await fs.realpath(abs) } catch { return null }
  const relative = path.relative(realRoot, real)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return { abs, real, stat }
}

function safeTargetBaseName(ref, sha) {
  const normalized = String(ref || '').replace(/\\/g, '/')
  let base = path.basename(normalized)
  const extMatch = IMAGE_EXT_RE.exec(base)
  let ext = extMatch ? extMatch[0].toLowerCase() : ''
  let stem = ext ? base.slice(0, base.length - ext.length) : base
  stem = stem
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 80)
  if (!stem) stem = `asset-${sha.slice(0, 8)}`
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`
  if (ext === '.jpeg') ext = '.jpg'
  return { stem, ext }
}

function clampLimit(value) {
  if (value === undefined || value === null) return MIGRATION_DEFAULT_LIMIT
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > MIGRATION_MAX_LIMIT) {
    throw migrationError('invalid-args', `limit 必须是 1..${MIGRATION_MAX_LIMIT} 的整数`)
  }
  return number
}

/** 读取目标目录已有文件索引：sha→相对路径、已占用文件名（小写）。目录不存在 → 空索引。 */
async function loadTargetIndex(realRoot) {
  const bySha = new Map()
  const names = new Set()
  const dirAbs = path.join(realRoot, ...store.ASSET_LIBRARY_DIR.split('/'))
  let entries
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true })
  } catch {
    return { bySha, names }
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const abs = path.join(dirAbs, entry.name)
    const stat = await fs.lstat(abs).catch(() => null)
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) continue
    names.add(entry.name.toLowerCase())
    if (stat.size > HASH_MAX_BYTES) continue
    try {
      const buffer = await fs.readFile(abs)
      bySha.set(sha256(buffer), `${store.ASSET_LIBRARY_DIR}/${entry.name}`)
    } catch { /* 单个不可读文件忽略（不阻塞迁移） */ }
  }
  return { bySha, names }
}

function nextAvailableName(stem, ext, names) {
  const base = `${stem}${ext}`
  if (!names.has(base.toLowerCase())) return base
  for (let index = 2; index <= 9999; index += 1) {
    const candidate = `${stem}-${index}${ext}`
    if (!names.has(candidate.toLowerCase())) return candidate
  }
  throw migrationError('invalid-args', `同名文件过多：${base}`)
}

/**
 * 规划迁移（只读；不写盘）。返回 plan（内部）与 report（对外）。
 * @param {{rewriteRefs?:boolean, limit?:number}} options
 */
export async function planAssetCardMediaMigration(root, title, options = {}) {
  const dir = store.projectDir(root, title)
  if (!(await store.isDirectory(dir))) throw migrationError('not-found', '短剧项目不存在')
  const realRoot = await fs.realpath(dir)
  const rewriteRefs = options.rewriteRefs !== false
  const limit = clampLimit(options.limit)
  const cardsDoc = await store.readCardsDoc(root, title, 'asset')
  const cards = cardsDoc && cardsDoc.doc ? assetCards.normalizeAssetIndex(cardsDoc.doc).assets : []
  const plan = {
    cardsHash: cardsDoc ? cardsDoc.hash : null,
    rewriteRefs,
    nextCards: [],
    copies: [],
    reused: [],
    skipped: [],
    failed: [],
    rewrittenRefs: 0,
    rewrittenCards: 0,
    scannedCards: 0,
    statesScanned: 0,
    stateRefsScanned: 0,
    stateRefsRewritten: 0,
    stateThumbnailsRewritten: 0,
    rootProjectionRefs: 0,
    rootFills: 0,
    ambiguousRootFills: 0,
    truncated: false,
    targets: [],
  }
  const target = await loadTargetIndex(realRoot)
  const bySha = new Map(target.bySha)
  const names = new Set(target.names)
  const refCache = new Map() // raw ref → { rel | null, sha? }
  let copyCount = 0

  for (const card of cards) {
    plan.scannedCards += 1
    const media = card && card.media && typeof card.media === 'object' && !Array.isArray(card.media) ? card.media : null
    if (!media) { plan.nextCards.push(card); continue }
    const nextMedia = { ...media }
    let changed = false

    /** 映射单个媒体引用；states 与根共用同一 refCache/去重/copy 限流。 */
    const mapRef = async (rawRef, context = {}) => {
      if (typeof rawRef !== 'string' || !rawRef.trim()) return { value: rawRef, changed: false }
      const text = rawRef.trim()
      if (isHttpRef(text)) return { value: text, changed: false }
      const rel = normalizeLocalRef(text)
      const stateTag = context.stateId ? { stateId: context.stateId } : {}
      if (!rel) {
        plan.failed.push({ assetId: card.id, ...stateTag, ref: text, reason: 'invalid-ref' })
        return { value: rawRef, changed: false }
      }
      if (rel === store.ASSET_LIBRARY_DIR || rel.startsWith(`${store.ASSET_LIBRARY_DIR}/`)) {
        const info = await resolveProjectFile(realRoot, rel)
        if (info) {
          plan.skipped.push({ assetId: card.id, ...stateTag, ref: text, reason: 'already-migrated', to: rel })
          return { value: rel, changed: false }
        }
        plan.failed.push({ assetId: card.id, ...stateTag, ref: text, reason: 'migrated-file-missing' })
        return { value: rawRef, changed: false }
      }
      if (refCache.has(text)) {
        const cached = refCache.get(text)
        if (cached && cached.rel) return { value: cached.rel, changed: true }
        plan.failed.push({ assetId: card.id, ...stateTag, ref: text, reason: (cached && cached.reason) || 'source-unavailable' })
        return { value: rawRef, changed: false }
      }
      if (copyCount >= limit) {
        plan.truncated = true
        plan.skipped.push({ assetId: card.id, ...stateTag, ref: text, reason: 'limit' })
        return { value: rawRef, changed: false }
      }
      const info = await resolveProjectFile(realRoot, rel)
      if (!info) {
        plan.failed.push({ assetId: card.id, ...stateTag, ref: text, reason: 'not-found' })
        refCache.set(text, { rel: null, reason: 'not-found' })
        return { value: rawRef, changed: false }
      }
      if (info.stat.size > HASH_MAX_BYTES) {
        plan.failed.push({ assetId: card.id, ...stateTag, ref: text, reason: 'too-large-to-hash', bytes: info.stat.size })
        refCache.set(text, { rel: null, reason: 'too-large-to-hash' })
        return { value: rawRef, changed: false }
      }
      const buffer = await fs.readFile(info.real)
      const sha = sha256(buffer)
      let targetRel = bySha.get(sha) || null
      if (targetRel) {
        plan.reused.push({ assetId: card.id, ...stateTag, ref: text, sha256: sha, to: targetRel })
      } else {
        const { stem, ext } = safeTargetBaseName(rel, sha)
        if (!ext || !IMAGE_EXT_RE.test(ext)) {
          plan.failed.push({ assetId: card.id, ...stateTag, ref: text, reason: 'unsupported-ext' })
          refCache.set(text, { rel: null, reason: 'unsupported-ext' })
          return { value: rawRef, changed: false }
        }
        const name = nextAvailableName(stem, ext, names)
        names.add(name.toLowerCase())
        targetRel = `${store.ASSET_LIBRARY_DIR}/${name}`
        bySha.set(sha, targetRel)
        const displayable = info.stat.size <= MEDIA_READ_DISPLAY_MAX_BYTES && MEDIA_READABLE_EXT.has(ext)
        plan.copies.push({
          assetId: card.id,
          ...stateTag,
          sourceAbs: info.real,
          sourceRef: rel,
          rel: targetRel,
          sha256: sha,
          bytes: info.stat.size,
          displayable,
        })
        copyCount += 1
      }
      refCache.set(text, { rel: targetRel, sha })
      return { value: targetRel, changed: true }
    }

    const applyMapped = (result, stateScoped = false) => {
      if (!result.changed) return false
      changed = true
      if (rewriteRefs) plan.rewrittenRefs += 1
      if (stateScoped) plan.stateRefsRewritten += 1
      return true
    }

    // 1) states 优先（唯一状态事实源；根字段只作兼容输入/输出）。
    const sourceStates = Array.isArray(media.states) ? media.states : []
    if (sourceStates.length) {
      plan.statesScanned += sourceStates.length
      const nextStates = []
      for (const state of sourceStates) {
        if (!state || typeof state !== 'object' || Array.isArray(state)) continue
        const stateId = typeof state.id === 'string' ? state.id : ''
        const nextState = { ...state }
        if (Array.isArray(state.images)) {
          const mapped = []
          for (const rawRef of state.images) {
            plan.stateRefsScanned += 1
            const result = await mapRef(rawRef, { stateId })
            applyMapped(result, true)
            mapped.push(result.value)
          }
          nextState.images = mapped
        }
        if (typeof state.thumbnail === 'string' && state.thumbnail.trim()) {
          const result = await mapRef(state.thumbnail, { stateId })
          if (applyMapped(result, true)) plan.stateThumbnailsRewritten += 1
          if (result.value !== state.thumbnail) nextState.thumbnail = result.value
        }
        nextStates.push(nextState)
      }
      nextMedia.states = nextStates
    }

    // 2) 根兼容字段映射（194 仍保留根；不覆盖 states 已有数据）。
    const mapRootField = async (field) => {
      const source = field === 'thumbnail' ? (typeof media.thumbnail === 'string' ? [media.thumbnail] : []) : (Array.isArray(media.images) ? media.images : [])
      const mapped = []
      for (const rawRef of source) {
        plan.rootProjectionRefs += 1
        const result = await mapRef(rawRef)
        applyMapped(result)
        mapped.push(result.value)
      }
      if (field === 'thumbnail') {
        if (mapped.length) nextMedia.thumbnail = mapped[0]
        else delete nextMedia.thumbnail
      } else if (Array.isArray(media.images)) {
        nextMedia.images = mapped
      }
    }
    await mapRootField('images')
    await mapRootField('thumbnail')

    // 3) 根补空（安全版）：仅当根图确实属于 active/default 投影时才补，绝不覆盖非空状态。
    if (Array.isArray(nextMedia.states) && nextMedia.states.length) {
      const states = nextMedia.states
      const activeId = typeof nextMedia.activeStateId === 'string' ? nextMedia.activeStateId.trim() : ''
      const defaultState = states.find((state) => state.id === 'default' || state.name === '默认') || null
      const activeState = activeId ? states.find((state) => state.id === activeId) || null : null
      const rootImages = Array.isArray(nextMedia.images) ? nextMedia.images : []
      const rootThumb = typeof nextMedia.thumbnail === 'string' ? nextMedia.thumbnail : ''
      const empty = (state) => !Array.isArray(state.images) || state.images.length === 0
      const fillTarget = !activeId ? (defaultState || states[0]) : (activeState && empty(activeState) ? activeState : null)
      if (fillTarget && empty(fillTarget) && rootImages.length) {
        fillTarget.images = rootImages.slice()
        if (rootThumb) fillTarget.thumbnail = rootThumb
        changed = true
        plan.rootFills += 1
      } else if (activeId && defaultState && activeState && defaultState.id !== activeState.id && empty(defaultState) && rootImages.length) {
        // active 非 default 时根图是 active 投影，不能硬塞 default；留待 195 的单一事实源处理。
        plan.ambiguousRootFills += 1
      }
    }

    if (changed && rewriteRefs) {
      plan.rewrittenCards += 1
      plan.nextCards.push({
        ...card,
        media: nextMedia,
        version: (Number.isInteger(card.version) ? card.version : 1) + 1,
        history: [...(Array.isArray(card.history) ? card.history : []), { version: (Number.isInteger(card.version) ? card.version : 1), change: '迁移资产图片' }],
      })
    } else {
      plan.nextCards.push(card)
    }
  }
  plan.nextCards = assetCards.sortAssetCards(plan.nextCards)
  if (rewriteRefs && plan.rewrittenCards > 0) plan.targets.push('.aidrama/assets/cards.json')
  for (const copy of plan.copies) plan.targets.push(copy.rel)
  plan.report = {
    scannedCards: plan.scannedCards,
    statesScanned: plan.statesScanned,
    stateRefsScanned: plan.stateRefsScanned,
    stateRefsRewritten: plan.stateRefsRewritten,
    stateThumbnailsRewritten: plan.stateThumbnailsRewritten,
    rootProjectionRefs: plan.rootProjectionRefs,
    rootFills: plan.rootFills,
    ambiguousRootFills: plan.ambiguousRootFills,
    copied: plan.copies.length,
    reused: plan.reused.length,
    skipped: plan.skipped.length,
    failed: plan.failed.length,
    rewritten: plan.rewrittenRefs,
    rewrittenCards: plan.rewrittenCards,
    cardsHash: plan.cardsHash,
    truncated: plan.truncated,
    rewriteRefs,
    files: {
      copied: plan.copies.map(({ assetId, stateId, sourceRef, rel, sha256: hash, bytes, displayable }) => ({ assetId, ...(stateId ? { stateId } : {}), from: sourceRef, to: rel, sha256: hash, bytes, displayable })),
      reused: plan.reused.slice(),
      skipped: plan.skipped.slice(),
      failed: plan.failed.slice(),
    },
  }
  return plan
}

/** 应用迁移（写文件 + 一次原子写 cards.json）；计划后 cards.json / 源文件变化 → conflict 拒绝。 */
export async function applyAssetCardMediaMigration(root, title, plan) {
  const dir = store.projectDir(root, title)
  if (!(await store.isDirectory(dir))) throw migrationError('not-found', '短剧项目不存在')
  const current = await store.readCardsDoc(root, title, 'asset')
  const currentHash = current ? current.hash : null
  if (currentHash !== plan.cardsHash) {
    throw migrationError('conflict', 'cards.json 已被其他写入修改（迁移计划过期，请重新规划）', { currentHash })
  }
  let copied = 0
  for (const copy of plan.copies) {
    const buffer = await fs.readFile(copy.sourceAbs).catch(() => null)
    if (!buffer || sha256(buffer) !== copy.sha256) {
      throw migrationError('conflict', `迁移源文件在计划后发生变化：${copy.sourceRef}`)
    }
    await store.guardedProjectWriteBinary(dir, copy.rel, buffer)
    copied += 1
  }
  let writtenHash = currentHash
  if (plan.rewriteRefs && plan.rewrittenCards > 0) {
    const written = await store.writeCardsDoc(root, title, 'asset', plan.nextCards)
    writtenHash = written.hash
  }
  return {
    copied,
    reused: plan.reused.length,
    skipped: plan.skipped.length,
    failed: plan.failed.length,
    rewritten: plan.rewrittenRefs,
    rewrittenCards: plan.rewrittenCards,
    statesScanned: plan.statesScanned,
    stateRefsRewritten: plan.stateRefsRewritten,
    stateThumbnailsRewritten: plan.stateThumbnailsRewritten,
    rootFills: plan.rootFills,
    ambiguousRootFills: plan.ambiguousRootFills,
    cardsHash: writtenHash,
    oldHash: currentHash,
    newHash: writtenHash,
    truncated: plan.truncated,
    files: {
      copied: plan.copies.map(({ assetId, stateId, sourceRef, rel, sha256: hash, bytes, displayable }) => ({ assetId, ...(stateId ? { stateId } : {}), from: sourceRef, to: rel, sha256: hash, bytes, displayable })),
      reused: plan.reused.slice(),
      skipped: plan.skipped.slice(),
      failed: plan.failed.slice(),
    },
  }
}

