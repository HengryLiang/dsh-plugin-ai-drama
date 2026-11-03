/**
 * v0.16.24（Phase1 / H-11 + E17a + E17b）：角色卡「对标音色」绑定数据通道。
 *
 * 职责（全部经 `store` 守卫/原子写；不新增裸 fs 写原语，除快照 copyFile 与扫描 lstat 只读）：
 * - 请求校验（H-11 `asset-audio-save` 入参；纯函数 + 无副作用）；
 * - 文档 schema v1 读写：`.aidrama/assets/voice-bindings.json`
 *   `{ schemaVersion: 1, bindings: { [key]: { kind:'card'|'asset', id, audio:string[], updatedAt } } }`
 * - A3 目标存在性（card→cards.json；asset→legacy registry；registry 损坏→registry-corrupt）；
 * - A4 音频引用归一（项目内相对路径 / legacy 音频资产 id → 项目内相对路径；失败 400 零写盘）；
 * - E17a 项目素材音频扫描（depth≤4 / ≤500 / 白名单 / 禁 symlink / 仅 stat）；
 * - E17b 绑定回读（playable/reason/resolvedPath，只读 stat）；
 * - 快照 `.aidrama/history/voice-bindings.<stamp>.json`（保留 20），清空最后一项删除 sidecar。
 *
 * 依赖方向（D1 定稿）：`audio-bindings.js → store.js + media.js`；store/media 均不 import 本模块（无环）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

import * as store from './store.js'
import * as media from './media.js'

export const SCHEMA_VERSION = 1
/** 相对 `.aidrama/` 的存储路径（WRITE_TARGETS 与快照命名共用）。 */
export const AUDIO_BINDINGS_RELATIVE = 'assets/voice-bindings.json'
/** 响应中的项目内路径（含 `.aidrama/` 前缀）。 */
export const AUDIO_BINDINGS_PATH = `.aidrama/${AUDIO_BINDINGS_RELATIVE}`
export const MAX_BINDINGS = 500
export const MAX_AUDIO_PER_BINDING = 6
export const MAX_KEY_CHARS = 120
export const MAX_AUDIO_REF_CHARS = 500
export const HISTORY_LIMIT = 20
export const AUDIO_BINDING_KINDS = Object.freeze(['card', 'asset'])
export const AUDIO_EXTENSIONS = Object.freeze(['.mp3', '.wav', '.m4a', '.ogg', '.aac'])

const INPUT_KEYS = new Set(['title', 'bindings', 'expectedHash', 'operationId'])
const BINDING_KEYS = new Set(['kind', 'id', 'audio'])
const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/
const ASSET_ID_PATTERN = /^a-[A-Za-z0-9_-]{1,110}$/
const HEX64_PATTERN = /^[0-9a-f]{64}$/i
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

export function bindingsError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bindingsError('invalid-args', `${label} 必须是对象`)
}

function normalizeIdText(raw, label) {
  if (typeof raw !== 'string') throw bindingsError('invalid-args', `${label} 必须是字符串`)
  const text = raw.trim()
  if (!text) throw bindingsError('invalid-args', `${label} 不能为空`)
  if (text.length > MAX_KEY_CHARS) throw bindingsError('invalid-args', `${label} 过长（上限 ${MAX_KEY_CHARS} 字符）`)
  if (/[\u0000-\u001f\u007f]/.test(text)) throw bindingsError('invalid-args', `${label} 含控制字符`)
  return text
}

/** 项目内相对音频路径语法校验（安全链复用 media.assertSafeMediaPath；不读盘）。 */
export function normalizeProjectAudioPath(raw) {
  let safe
  try {
    safe = media.assertSafeMediaPath(raw)
  } catch (error) {
    // H-11 契约错误码仅 400/404/409/413：路径语法/穿越类统一 invalid-args（400）
    throw bindingsError('invalid-args', error instanceof Error ? error.message : '音频路径非法')
  }
  const segments = safe.split(/[\\/]+/)
  if (segments.some((segment) => segment.trim().toLowerCase() === store.META_DIR)) {
    throw bindingsError('invalid-args', '不能绑定内部数据目录（.aidrama）中的文件')
  }
  const extension = path.extname(safe).toLowerCase()
  if (!AUDIO_EXTENSIONS.includes(extension)) {
    throw bindingsError('invalid-args', `不支持的音频类型：${path.basename(safe)}（仅 mp3/wav/m4a/ogg/aac）`)
  }
  return safe.replace(/\\/g, '/')
}

/** audio 项归一：项目内相对路径 或 legacy 音频资产 id（`a-…` / `asset:<id>`）。 */
export function classifyAudioRef(raw) {
  if (typeof raw !== 'string') throw bindingsError('invalid-args', 'audio 项必须是字符串')
  const text = raw.trim()
  if (!text) throw bindingsError('invalid-args', 'audio 项不能为空')
  if (text.length > MAX_AUDIO_REF_CHARS) throw bindingsError('invalid-args', `audio 项过长（上限 ${MAX_AUDIO_REF_CHARS} 字符）`)
  if (/[\u0000-\u001f\u007f]/.test(text)) throw bindingsError('invalid-args', 'audio 项含控制字符')
  if (text.startsWith('asset:')) {
    const assetId = text.slice('asset:'.length).trim()
    if (!ASSET_ID_PATTERN.test(assetId)) throw bindingsError('invalid-args', `audio 资产 id 非法：${text}`)
    return { kind: 'asset', assetId, raw: text }
  }
  if (ASSET_ID_PATTERN.test(text)) return { kind: 'asset', assetId: text, raw: text }
  return { kind: 'project', path: normalizeProjectAudioPath(text), raw: text }
}

export function normalizeAudioList(rawList, label = 'audio') {
  if (!Array.isArray(rawList)) throw bindingsError('invalid-args', `${label} 必须是数组（0–${MAX_AUDIO_PER_BINDING} 项）`)
  if (rawList.length > MAX_AUDIO_PER_BINDING) throw bindingsError('invalid-args', `${label} 最多 ${MAX_AUDIO_PER_BINDING} 项（当前 ${rawList.length}）`)
  const refs = []
  const seen = new Set()
  for (const item of rawList) {
    const ref = classifyAudioRef(item)
    const key = ref.kind === 'asset' ? `asset:${ref.assetId}` : ref.path
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return refs
}

export function normalizeExpectedHash(raw) {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'string') throw bindingsError('invalid-args', 'expectedHash 必须是字符串或 null')
  const text = raw.trim()
  if (!HEX64_PATTERN.test(text)) throw bindingsError('invalid-args', 'expectedHash 必须是 64 位 sha256 十六进制或 null')
  return text.toLowerCase()
}

/** H-11 请求校验（返回归一化结果；未知字段/非法值 → invalid-args）。 */
export function validateRequest(input) {
  assertPlainObject(input, '入参')
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key)) throw bindingsError('invalid-args', `asset-audio-save 不支持字段：${key}`)
  }
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || !input.title.trim()) throw bindingsError('invalid-args', 'title 必须是非空字符串')
  }
  if (!Array.isArray(input.bindings) || input.bindings.length === 0) {
    throw bindingsError('invalid-args', 'bindings 必须是非空数组')
  }
  if (input.bindings.length > MAX_BINDINGS) throw bindingsError('invalid-args', `bindings 单次最多 ${MAX_BINDINGS} 项`)
  const seen = new Set()
  const bindings = []
  for (const raw of input.bindings) {
    assertPlainObject(raw, 'bindings 项')
    for (const key of Object.keys(raw)) {
      if (!BINDING_KEYS.has(key)) throw bindingsError('invalid-args', `bindings 项不支持字段：${key}`)
    }
    if (!AUDIO_BINDING_KINDS.includes(raw.kind)) throw bindingsError('invalid-args', "bindings.kind 必须是 'card' 或 'asset'")
    const id = normalizeIdText(raw.id, 'bindings.id')
    if (!ID_PATTERN.test(id)) throw bindingsError('invalid-args', `bindings.id 非法：${id}`)
    const dedupeKey = `${raw.kind}:${id}`
    if (seen.has(dedupeKey)) throw bindingsError('invalid-args', `bindings 重复 key：${id}`)
    seen.add(dedupeKey)
    const audio = normalizeAudioList(raw.audio, `bindings[${id}].audio`)
    bindings.push({ kind: raw.kind, id, audio })
  }
  let operationId = ''
  if (input.operationId !== undefined) {
    if (typeof input.operationId !== 'string') throw bindingsError('invalid-args', 'operationId 必须是字符串')
    operationId = input.operationId.trim().slice(0, 120)
    if (/[\u0000-\u001f\u007f]/.test(operationId)) throw bindingsError('invalid-args', 'operationId 含控制字符')
  }
  return { bindings, expectedHash: normalizeExpectedHash(input.expectedHash), operationId }
}

/* ------------------------------------------------------------ 文档解析/序列化 */

function normalizeStoredAudioList(rawList) {
  if (!Array.isArray(rawList)) throw bindingsError('invalid-args', '绑定文件 audio 字段非法（应为数组）')
  if (rawList.length > MAX_AUDIO_PER_BINDING) throw bindingsError('invalid-args', '绑定文件 audio 项超过上限')
  const out = []
  const seen = new Set()
  for (const item of rawList) {
    if (typeof item !== 'string' || !item.trim()) throw bindingsError('invalid-args', '绑定文件 audio 项必须是字符串')
    const safe = normalizeProjectAudioPath(item)
    if (seen.has(safe)) continue
    seen.add(safe)
    out.push(safe)
  }
  return out
}

/** 解析并归一绑定文档（坏结构/未知字段/坏路径 → invalid-args；E17b 负责只读降级）。 */
export function parseDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw bindingsError('invalid-args', '绑定文件结构非法（应为对象）')
  if (doc.schemaVersion !== SCHEMA_VERSION) throw bindingsError('invalid-args', `绑定文件 schemaVersion 非法（应为 ${SCHEMA_VERSION}）`)
  assertPlainObject(doc.bindings, '绑定文件 bindings')
  const entries = []
  for (const [key, raw] of Object.entries(doc.bindings)) {
    assertPlainObject(raw, `绑定文件 bindings.${key}`)
    const extra = Object.keys(raw).find((field) => !['kind', 'id', 'audio', 'updatedAt'].includes(field))
    if (extra) throw bindingsError('invalid-args', `绑定文件 bindings.${key} 含未知字段：${extra}`)
    const id = normalizeIdText(raw.id, `绑定文件 bindings.${key}.id`)
    if (id !== key) throw bindingsError('invalid-args', `绑定文件 key 与 id 不一致：${key} / ${id}`)
    if (!AUDIO_BINDING_KINDS.includes(raw.kind)) throw bindingsError('invalid-args', `绑定文件 bindings.${key}.kind 非法`)
    const audio = normalizeStoredAudioList(raw.audio)
    if (!audio.length) throw bindingsError('invalid-args', `绑定文件 bindings.${key}.audio 为空（空绑定不应落盘）`)
    if (typeof raw.updatedAt !== 'string' || !raw.updatedAt.trim()) throw bindingsError('invalid-args', `绑定文件 bindings.${key}.updatedAt 非法`)
    entries.push({ kind: raw.kind, id, audio, updatedAt: raw.updatedAt.trim() })
  }
  return sortEntries(entries)
}

export function sortEntries(entries) {
  return (Array.isArray(entries) ? entries.slice() : []).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function serializeDoc(entries) {
  const bindings = {}
  for (const entry of sortEntries(entries)) {
    bindings[entry.id] = {
      kind: entry.kind,
      id: entry.id,
      audio: [...entry.audio],
      updatedAt: entry.updatedAt,
    }
  }
  return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, bindings }, null, 2)}\n`
}

/* ------------------------------------------------------------ 项目内文件/登记解析 */

function bindingsFile(dir) {
  return path.join(dir, store.META_DIR, 'assets', 'voice-bindings.json')
}

function projectPathOf(root, title) {
  return store.projectDir(root, title)
}

async function assertProjectDir(root, title) {
  const dir = projectPathOf(root, title)
  if (!(await store.isDirectory(dir))) throw bindingsError('not-found', `短剧《${title}》不存在`)
  return dir
}

/** 读 sidecar 原始字节 + sha（不存在 → 全 null；JSON 损坏 → invalid-args）。 */
export async function readDoc(root, title) {
  const dir = await assertProjectDir(root, title)
  const file = bindingsFile(dir)
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { doc: null, text: null, hash: null, bytes: 0 }
    throw bindingsError('not-found', '绑定文件不可读')
  }
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    throw bindingsError('invalid-args', '绑定文件损坏（不是合法 JSON）；未自动覆盖，请人工检查或删除后重试')
  }
  return { doc, text, hash: sha256(text), bytes: Buffer.byteLength(text, 'utf8') }
}

/** 读绑定（缺省 = 空；坏文件抛 invalid-args，由 E17b 只读降级）。 */
export async function readBindings(root, title) {
  const current = await readDoc(root, title)
  if (!current.text) return { entries: [], hash: null, bytes: 0, exists: false }
  const entries = parseDoc(current.doc)
  return { entries, hash: current.hash, bytes: current.bytes, exists: true }
}

/** A3：目标 key 存在性（card→cards.json；asset→legacy registry；registry 损坏→registry-corrupt）。 */
async function assertBindingTarget(root, title, binding) {
  if (binding.kind === 'card') {
    let cards = []
    try {
      cards = await store.getAssetCards(root, title)
    } catch (error) {
      if (error && error.code === 'invalid-args') throw bindingsError('invalid-args', `cards.json 损坏，无法校验目标卡：${binding.id}`)
      throw error
    }
    const normalized = String(binding.id).toUpperCase()
    if (!cards.some((card) => String(card && card.id ? card.id : '').toUpperCase() === normalized)) {
      throw bindingsError('not-found', `角色卡不存在：${binding.id}`)
    }
    return
  }
  const state = await store.readAssetsState(root, title)
  if (!state.registryOk) throw bindingsError('registry-corrupt', '素材登记文件损坏，无法校验目标资产；未写盘')
  if (!state.assets.some((asset) => asset && String(asset.id) === binding.id)) {
    throw bindingsError('not-found', `素材登记条目不存在：${binding.id}`)
  }
}

/** A4：legacy 音频资产 id → 项目内相对路径。 */
async function resolveAudioAssetRef(root, title, assetId) {
  const state = await store.readAssetsState(root, title)
  if (!state.registryOk) throw bindingsError('registry-corrupt', '素材登记文件损坏，无法解析音频引用；未写盘')
  const entry = state.assets.find((asset) => asset && String(asset.id) === assetId) || null
  if (!entry) throw bindingsError('invalid-args', `音频资产不存在：${assetId}`)
  if (entry.kind !== 'audio') throw bindingsError('invalid-args', `绑定引用不是音频资产：${assetId}`)
  const dir = projectPathOf(root, title)
  const realRoot = await fs.realpath(dir)
  let real
  try {
    real = await media.resolveRegistryMediaSource(root, title, entry.source)
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'invalid-args'
    // 需求口径：A4 解析失败统一 400（项目外/非音频/缺失）
    if (code === 'too-large') throw bindingsError('too-large', error.message)
    throw bindingsError('invalid-args', `音频资产不可用：${assetId}（${error instanceof Error ? error.message : '解析失败'}）`)
  }
  const relative = path.relative(realRoot, real)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw bindingsError('invalid-args', `音频资产不在项目内：${assetId}`)
  }
  const relPath = relative.split(path.sep).join('/')
  const extension = path.extname(relPath).toLowerCase()
  if (!AUDIO_EXTENSIONS.includes(extension)) throw bindingsError('invalid-args', `绑定引用不是音频文件：${assetId}`)
  const stat = await fs.lstat(real).catch(() => null)
  if (!stat) throw bindingsError('invalid-args', `音频资产文件不存在：${assetId}`)
  if (stat.isSymbolicLink()) throw bindingsError('invalid-args', `音频资产文件是符号链接/junction，已拒绝：${assetId}`)
  if (!stat.isFile()) throw bindingsError('invalid-args', `音频资产目标不是文件：${assetId}`)
  if (stat.size > media.MEDIA_READ_MAX_BYTES) throw bindingsError('too-large', `音频资产超过 ${media.MEDIA_READ_MAX_BYTES} 字节上限：${assetId}`)
  return relPath
}

/** A4：项目内相对路径 → 校验存在/类型/大小（realpath 防 symlink 逃逸），返回规范化相对路径。 */
export async function resolveProjectAudioPath(root, title, rawPath) {
  const safe = normalizeProjectAudioPath(rawPath)
  const dir = projectPathOf(root, title)
  const realRoot = await fs.realpath(dir)
  const resolved = path.resolve(realRoot, safe)
  const relative = path.relative(realRoot, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw bindingsError('invalid-args', '音频路径越出项目目录')
  let linkStat
  try {
    linkStat = await fs.lstat(resolved)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) throw bindingsError('not-found', `音频文件不存在：${safe}`)
    throw bindingsError('not-found', `音频文件不可读：${safe}`)
  }
  if (linkStat.isSymbolicLink()) throw bindingsError('invalid-args', `音频文件是符号链接/junction，已拒绝：${safe}`)
  if (!linkStat.isFile()) throw bindingsError('invalid-args', `音频目标不是文件：${safe}`)
  if (linkStat.size > media.MEDIA_READ_MAX_BYTES) throw bindingsError('too-large', `音频文件超过 ${media.MEDIA_READ_MAX_BYTES} 字节上限：${safe}`)
  let realTarget
  try {
    realTarget = await fs.realpath(resolved)
  } catch {
    throw bindingsError('not-found', `音频文件不可读：${safe}`)
  }
  const relativeReal = path.relative(realRoot, realTarget)
  if (!relativeReal || relativeReal.startsWith('..') || path.isAbsolute(relativeReal)) throw bindingsError('invalid-args', '音频路径越出项目目录（符号链接逃逸）')
  return relativeReal.split(path.sep).join('/')
}

/* ------------------------------------------------------------ 快照/写入 */

async function snapshotBindings(dir) {
  const file = bindingsFile(dir)
  try {
    await fs.access(file)
  } catch {
    return
  }
  const historyDir = await store.assertProjectWriteTarget(dir, `${store.META_DIR}/history`)
  await fs.mkdir(historyDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = await store.assertProjectWriteTarget(dir, `${store.META_DIR}/history/voice-bindings.${stamp}.json`)
  await fs.copyFile(file, target)
  const files = (await fs.readdir(historyDir)).filter((name) => name.startsWith('voice-bindings.')).sort()
  for (const stale of files.slice(0, Math.max(0, files.length - HISTORY_LIMIT))) {
    const staleTarget = await store.assertProjectWriteTarget(dir, `${store.META_DIR}/history/${stale}`)
    await fs.rm(staleTarget, { force: true })
  }
}

/**
 * H-11 写实现：批量 bindings；audio:[] 清除该 key；最后一项清除后删除 sidecar。
 * @param {{now?: string}} options 测试可注入固定时间（确定性）。
 * @returns {Promise<{path:string,hash:string|null,bytes:number,bindings:Array}>}
 */
export async function saveBindings(root, title, businessInput, options = {}) {
  const parsed = validateRequest(businessInput)
  const dir = await assertProjectDir(root, title)
  const now = typeof options.now === 'string' && options.now ? options.now : new Date().toISOString()
  const current = await readBindings(root, title)
  const map = new Map(current.entries.map((entry) => [entry.id, entry]))
  for (const binding of parsed.bindings) {
    // audio:[] = 清除该 key（目标卡/资产即使已不存在也允许清除，避免脏绑定无法恢复）
    if (!binding.audio.length) {
      map.delete(binding.id)
      continue
    }
    await assertBindingTarget(root, title, binding)
    const audio = []
    for (const ref of binding.audio) {
      if (ref.kind === 'asset') audio.push(await resolveAudioAssetRef(root, title, ref.assetId))
      else audio.push(await resolveProjectAudioPath(root, title, ref.path))
    }
    map.set(binding.id, { kind: binding.kind, id: binding.id, audio, updatedAt: now })
  }
  const entries = sortEntries([...map.values()])
  await snapshotBindings(dir)
  if (!entries.length) {
    if (current.exists) await store.guardedProjectRemove(dir, AUDIO_BINDINGS_PATH)
    return { path: AUDIO_BINDINGS_PATH, hash: null, bytes: 0, bindings: [] }
  }
  const text = serializeDoc(entries)
  await store.guardedMetaWrite(dir, AUDIO_BINDINGS_RELATIVE, text)
  return {
    path: AUDIO_BINDINGS_PATH,
    hash: sha256(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    bindings: entries.map((entry) => ({ ...entry, audio: [...entry.audio] })),
  }
}

/* ------------------------------------------------------------ E17a 扫描 */

/** 项目 `素材/` 递归音频扫描（depth≤4；≤500；白名单；禁 symlink；仅 stat，不读内容）。 */
export async function scanProjectAudio(root, title, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 500, 1), 500)
  const maxDepth = Math.min(Math.max(Number(options.depth) || 4, 1), 4)
  const dir = await assertProjectDir(root, title)
  const realRoot = await fs.realpath(dir)
  const base = path.join(realRoot, '素材')
  const found = []
  async function walk(current, depth) {
    if (depth > maxDepth) return
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry || !entry.name || entry.name.startsWith('.')) continue
      if (entry.name === '素材清单.md') continue
      const full = path.join(current, entry.name)
      let stat
      try {
        stat = await fs.lstat(full)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!stat.isFile()) continue
      const extension = path.extname(entry.name).toLowerCase()
      if (!AUDIO_EXTENSIONS.includes(extension)) continue
      found.push({ path: path.relative(realRoot, full).split(path.sep).join('/'), name: entry.name, bytes: stat.size })
    }
  }
  await walk(base, 1)
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const total = found.length
  return { files: found.slice(0, limit), total, truncated: total > limit }
}

/* ------------------------------------------------------------ E17b 回读 */

/** 回读绑定并逐条计算 playable/reason/resolvedPath（只读 stat；不读文件内容）。 */
export async function describeBindings(root, title) {
  const current = await readBindings(root, title)
  const entries = []
  for (const binding of current.entries) {
    let playable = true
    let reason = ''
    for (const audioPath of binding.audio) {
      try {
        await resolveProjectAudioPath(root, title, audioPath)
      } catch (error) {
        playable = false
        if (!reason) reason = error && typeof error.code === 'string' ? error.code : 'invalid-args'
      }
    }
    entries.push({
      kind: binding.kind,
      id: binding.id,
      audio: [...binding.audio],
      updatedAt: binding.updatedAt,
      playable,
      ...(playable ? { resolvedPath: binding.audio[0] } : {}),
      ...(playable ? {} : { reason }),
    })
  }
  return { entries, hash: current.hash, bytes: current.bytes }
}

/** 供测试/诊断：绑定文件项目内路径。 */
export function audioBindingsPathOf(root, title) {
  return path.join(projectPathOf(root, title), store.META_DIR, 'assets', 'voice-bindings.json')
}
