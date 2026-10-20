/**
 * v0.15.1（task-110 / 迭代1）：本地图片安全只读通道 helper（无依赖、只读、不写盘、无缓存）。
 *
 * 安全约束（Lead 批准）：
 * - 仅允许项目内相对路径；禁止绝对路径/盘符/UNC/`..`（含百分号编码变体）/控制字符；
 * - Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）与 ADS（`a.png:stream`）、尾随空格/点 拒绝；
 * - `realpath` 校验后只读 realTarget（防 symlink 逃逸 / TOCTOU）；
 * - 扩展名白名单 png/jpg/jpeg/webp/gif；大小 ≤ min(maxBytes, 8MB)；
 * - 错误消息不含绝对路径/堆栈，错误码：invalid-args | forbidden | not-found | too-large。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import * as store from './store.js'

/** 单次读取最大字节数（8MB）。 */
export const MEDIA_READ_MAX_BYTES = 8 * 1024 * 1024

/** 允许的图片扩展名 → MIME（v0.15.1 既有导出，语义保持不变：仅图片；媒体白名单见 MEDIA_MIME_WHITELIST）。 */
export const MEDIA_EXT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** v0.15.2（task-111）：音频扩展名 → MIME（additive）。 */
export const MEDIA_AUDIO_EXT_MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
}

/** v0.15.2：media-read 完整 MIME 白名单（图片+音频，additive；METHODS 不变）。 */
export const MEDIA_MIME_WHITELIST = { ...MEDIA_EXT_MIME, ...MEDIA_AUDIO_EXT_MIME }

/** 路径长度上限。 */
export const MEDIA_PATH_MAX_CHARS = 500

function mediaError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** 逐层百分号解码（最多 3 层；用于校验编码穿越 `..%2f`/双重编码）。 */
function decodeVariants(raw) {
  const variants = [raw]
  let current = raw
  for (let round = 0; round < 3; round += 1) {
    if (!/%[0-9a-fA-F]{2}/.test(current)) break
    let next
    try {
      next = decodeURIComponent(current)
    } catch {
      break
    }
    if (next === current) break
    variants.push(next)
    current = next
  }
  return variants
}

const WINDOWS_RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/

/**
 * 校验媒体路径（安全链第 1 段）：返回 trim 后的原始相对路径（读取用原始值，不解码）。
 * @param {unknown} rawPath
 * @returns {string}
 */
export function assertSafeMediaPath(rawPath) {
  if (typeof rawPath !== 'string') throw mediaError('invalid-args', 'path 必须是字符串')
  const raw = rawPath.trim()
  if (!raw) throw mediaError('invalid-args', 'path 不能为空')
  if (raw.length > MEDIA_PATH_MAX_CHARS) throw mediaError('invalid-args', `path 过长（上限 ${MEDIA_PATH_MAX_CHARS} 字符）`)
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw mediaError('invalid-args', 'path 含控制字符')
  if (/[. ]$/.test(raw)) throw mediaError('forbidden', '非法的媒体路径')
  for (const variant of decodeVariants(raw)) {
    if (/[\u0000-\u001f\u007f]/.test(variant)) throw mediaError('invalid-args', 'path 含控制字符')
    // 任意 `:`（盘符/ADS/URI scheme）一律拒绝
    if (variant.includes(':')) throw mediaError('forbidden', '非法的媒体路径')
    if (/^[\\/]/.test(variant)) throw mediaError('forbidden', '非法的媒体路径')
    const segments = variant.split(/[\\/]+/)
    if (!segments.length) throw mediaError('forbidden', '非法的媒体路径')
    for (const segment of segments) {
      if (!segment || segment === '..' || /^[. ]+$/.test(segment)) throw mediaError('forbidden', '非法的媒体路径')
      const baseName = segment.split('.')[0].trim().toUpperCase()
      if (WINDOWS_RESERVED_RE.test(baseName)) throw mediaError('forbidden', '非法的媒体路径')
    }
  }
  return raw
}

/** 解析目标项目：title 显式优先；缺省时若工作区仅 1 个项目则自动选用，否则 invalid-args。 */
async function resolveProjectTitle(root, title) {
  if (typeof title === 'string' && title.trim()) return title.trim()
  const projects = await store.listProjects(root)
  if (projects.length === 1) return projects[0].title
  throw mediaError('invalid-args', projects.length ? '工作区有多个短剧项目，请指定 title' : '工作区没有短剧项目，请先创建项目')
}

/** 校验 maxBytes：省略=8MB；显式需 1..8MB 整数。 */
function resolveMaxBytes(maxBytes) {
  if (maxBytes == null) return MEDIA_READ_MAX_BYTES
  const value = Number(maxBytes)
  if (!Number.isInteger(value) || value < 1 || value > MEDIA_READ_MAX_BYTES) {
    throw mediaError('invalid-args', `maxBytes 必须是 1..${MEDIA_READ_MAX_BYTES} 的整数`)
  }
  return value
}

/** 读取项目内媒体（path 模式；v0.15.1/v0.15.2 既有逻辑与安全矩阵保持不变）。 */
async function readMediaByPath(root, title, input, maxBytes) {
  const rawPath = assertSafeMediaPath(input.path)
  const projectRoot = store.projectDir(root, title)
  let realRoot
  try {
    realRoot = await fs.realpath(projectRoot)
  } catch {
    throw mediaError('not-found', '短剧项目不存在或不可读')
  }
  const resolved = path.resolve(realRoot, rawPath)
  const relative = path.relative(realRoot, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw mediaError('forbidden', '非法的媒体路径')
  // 页面内请求名的扩展名也必须在白名单内（大小写不敏感；v0.15.2 起含音频）
  const requestedMime = MEDIA_MIME_WHITELIST[path.extname(resolved).toLowerCase()]
  if (!requestedMime) throw mediaError('invalid-args', '不支持的媒体类型（图片 png/jpg/jpeg/webp/gif；音频 mp3/wav/m4a/ogg/aac）')
  // realpath 校验（防 symlink 逃逸）；之后的读取只针对 realTarget（防 TOCTOU）
  let realTarget
  try {
    realTarget = await fs.realpath(resolved)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) throw mediaError('not-found', '媒体文件不存在')
    throw mediaError('not-found', '媒体文件不可读')
  }
  const relativeReal = path.relative(realRoot, realTarget)
  if (!relativeReal || relativeReal.startsWith('..') || path.isAbsolute(relativeReal)) throw mediaError('forbidden', '非法的媒体路径')
  const mime = MEDIA_MIME_WHITELIST[path.extname(realTarget).toLowerCase()]
  if (!mime) throw mediaError('invalid-args', '不支持的媒体类型（图片 png/jpg/jpeg/webp/gif；音频 mp3/wav/m4a/ogg/aac）')
  let stat
  try {
    stat = await fs.stat(realTarget)
  } catch {
    throw mediaError('not-found', '图片不可读')
  }
  if (!stat.isFile()) throw mediaError('invalid-args', '目标不是文件')
  if (stat.size > maxBytes) throw mediaError('too-large', `图片过大（${stat.size} 字节 > 上限 ${maxBytes} 字节）`)
  let buffer
  try {
    buffer = await fs.readFile(realTarget)
  } catch {
    throw mediaError('not-found', '图片不可读')
  }
  if (buffer.length > maxBytes) throw mediaError('too-large', `图片过大（${buffer.length} 字节 > 上限 ${maxBytes} 字节）`)
  return {
    name: path.basename(realTarget),
    mime,
    size: buffer.length,
    base64: buffer.toString('base64'),
  }
}

/**
 * v0.15.4（task-118 / M20-H，E10 add-only）：legacy 素材登记（`.aidrama/assets.json`）按 assetId 读取图片。
 * 安全边界（Lead 裁定修正）：**用户亲手登记的 registry 条目（id→source）即授权**；客户端从不传外部路径。
 * 安全链：assetId 格式 → 登记精确匹配 → kind=image → source 仅本地绝对盘符路径 → 图片扩展名白名单 →
 * lstat（最终组件 symlink 拒绝/非文件拒绝）→ ≤min(maxBytes,8MB) → open('r') + fstat 复核（TOCTOU 缓解）
 * → 只读句柄按预检 size 读取 → base64。**不做 realpath↔source 字符串比较**（8.3 短路径/大小写不可靠）；
 * 父目录 junction 不再拦截（登记条目本身即用户授权）。错误不泄漏绝对路径。
 */
/** v0.16.10（task-157 / M3）：项目内包含校验（大小写不敏感）。 */
function mediaIsInside(root, target) {
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const normalizedTarget = process.platform === 'win32' ? target.toLowerCase() : target
  const relative = path.relative(normalizedRoot, normalizedTarget)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** v0.16.10（M3）：项目内相对路径是否含内部数据目录段。 */
function mediaHasInternalSegment(relativePath) {
  return String(relativePath == null ? '' : relativePath)
    .split(/[\\/]+/)
    .some((segment) => segment.trim().toLowerCase() === '.aidrama')
}

/**
 * v0.16.10（task-157 / M3 P0）：registry.source → 当前项目内真实文件。
 * - 相对 source：按当前项目解析（legacy/迁移兼容），限项目内、禁 symlink 逃逸/内部数据目录；
 * - 绝对 source：当前项目内直接用；否则尝试按 素材/... 尾段映射到当前项目；
 * - 旧根存在也绝不读项目外；失败 not-found 明确提示重新登记/扫描；错误不泄绝对路径。
 */
async function resolveRegistryMediaSource(root, title, source) {
  const dir = store.projectDir(root, title)
  if (!(await store.isDirectory(dir))) throw mediaError('not-found', '短剧项目不存在')
  // v0.16.10（M2/M3）：项目根 junction/symlink 拒绝（避免读解析到项目外）。
  const rootStat = await fs.lstat(dir).catch(() => null)
  if (!rootStat) throw mediaError('not-found', '短剧项目不存在')
  if (rootStat.isSymbolicLink()) throw mediaError('forbidden', '短剧项目目录是符号链接/junction，已拒绝读取')
  let realRoot
  try { realRoot = await fs.realpath(dir) } catch { throw mediaError('not-found', '短剧项目不可读') }
  const text = String(source == null ? '' : source).trim()
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) throw mediaError('invalid-args', '素材登记路径非法')
  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(text)
  const isPosixAbsolute = text.startsWith('/') && !text.startsWith('//')
  const tryReal = async (candidate) => {
    let real
    try { real = await fs.realpath(candidate) } catch { return null }
    if (!mediaIsInside(realRoot, real)) return null
    if (mediaHasInternalSegment(path.relative(realRoot, real))) return null
    return real
  }
  if (!isWindowsAbsolute && !isPosixAbsolute) {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) throw mediaError('invalid-args', '素材登记路径非法')
    const segments = text.replace(/\\/g, '/').split('/')
    if (segments.some((segment) => segment === '..' || segment === '.')) throw mediaError('forbidden', '素材登记路径非法')
    const real = await tryReal(path.resolve(realRoot, text))
    if (real) return real
    throw mediaError('not-found', '素材文件不存在或已移动；请重新登记或扫描素材目录')
  }
  const current = await tryReal(path.resolve(text))
  if (current) return current
  const normalized = text.replace(/\\/g, '/').split('/')
  const materialIndex = normalized.lastIndexOf('素材')
  if (materialIndex >= 0) {
    const mapped = await tryReal(path.join(realRoot, ...normalized.slice(materialIndex)))
    if (mapped) return mapped
  }
  const aiIndex = normalized.lastIndexOf('AI短剧')
  if (aiIndex >= 0 && normalized[aiIndex + 1] === title) {
    const mapped = await tryReal(path.join(realRoot, ...normalized.slice(aiIndex + 2)))
    if (mapped) return mapped
  }
  throw mediaError('not-found', '素材路径指向项目外（可能项目迁移/备份恢复）；请重新登记或扫描素材目录')
}

async function readLegacyAssetMedia(root, title, input, maxBytes) {
  const assetIdRaw = input.assetId
  if (typeof assetIdRaw !== 'string') throw mediaError('invalid-args', 'assetId 必须是字符串')
  const assetId = assetIdRaw.trim()
  if (!assetId) throw mediaError('invalid-args', 'assetId 不能为空')
  if (assetId.length > 120) throw mediaError('invalid-args', 'assetId 过长（上限 120 字符）')
  if (/[\u0000-\u001f\u007f]/.test(assetId)) throw mediaError('invalid-args', 'assetId 含控制字符')
  // 损坏登记 JSON：store.readJson 容错为 [] → 按“素材不存在”安全失败（不崩溃）
  let assets = []
  try {
    assets = await store.getAssets(root, title)
  } catch {
    assets = []
  }
  const entry = (Array.isArray(assets) ? assets : []).find((asset) => asset && asset.id === assetId) || null
  if (!entry) throw mediaError('not-found', '素材不存在（assetId 未登记）')
  if (entry.kind !== 'image') throw mediaError('invalid-args', '仅支持图片素材（video/doc/other 不可读取）')
  const source = typeof entry.source === 'string' ? entry.source.trim() : ''
  if (!source || /[\u0000-\u001f\u007f]/.test(source)) throw mediaError('invalid-args', '素材登记路径非法')
  // v0.16.10（M3）：相对/迁移后绝对路径统一解析到当前项目内；绝不读项目外。
  const sourcePath = await resolveRegistryMediaSource(root, title, source)
  const extension = path.extname(sourcePath).toLowerCase()
  const mime = MEDIA_EXT_MIME[extension]
  if (!mime) throw mediaError('invalid-args', '不支持的图片类型（仅 png/jpg/jpeg/webp/gif）')
  let preStat
  try {
    preStat = await fs.lstat(sourcePath)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) throw mediaError('not-found', '素材文件不存在或已移动')
    throw mediaError('not-found', '素材文件不可读取')
  }
  if (preStat.isSymbolicLink()) throw mediaError('forbidden', '素材文件不可读取（符号链接）')
  if (!preStat.isFile()) throw mediaError('invalid-args', '素材目标不是文件')
  if (preStat.size > maxBytes) throw mediaError('too-large', `素材过大（${preStat.size} 字节 > 上限 ${maxBytes} 字节）`)
  // TOCTOU 缓解：以只读句柄打开，fstat 复核类型/大小后再按预检 size 读取；不做 realpath↔source 比较
  let handle
  try {
    handle = await fs.open(sourcePath, 'r')
  } catch {
    throw mediaError('not-found', '素材文件不可读取')
  }
  try {
    let openedStat
    try {
      openedStat = await handle.stat()
    } catch {
      throw mediaError('forbidden', '素材文件不可读取')
    }
    if (!openedStat.isFile()) throw mediaError('invalid-args', '素材目标不是文件')
    if (openedStat.size !== preStat.size) throw mediaError('forbidden', '素材文件不可读取')
    if (openedStat.size > maxBytes) throw mediaError('too-large', `素材过大（${openedStat.size} 字节 > 上限 ${maxBytes} 字节）`)
    const buffer = Buffer.alloc(preStat.size)
    let offset = 0
    while (offset < preStat.size) {
      const { bytesRead } = await handle.read(buffer, offset, preStat.size - offset, offset)
      if (!bytesRead) throw mediaError('forbidden', '素材文件不可读取')
      offset += bytesRead
    }
    return {
      name: path.basename(sourcePath),
      mime,
      size: preStat.size,
      base64: buffer.toString('base64'),
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * 读取媒体（只读、不写盘）。
 * - v0.15.1/v0.15.2：`path` 项目内相对路径模式（行为/安全矩阵不变）；
 * - v0.15.4（E10 add-only）：`assetId` legacy 素材登记模式；`path` 与 `assetId` 互斥。
 * @param {string} root 工作区根
 * @param {{title?:string, path?:string, assetId?:string, maxBytes?:number}} input
 * @returns {Promise<{name:string, mime:string, size:number, base64:string}>}
 */
export async function readMedia(root, input = {}) {
  const title = await resolveProjectTitle(root, input.title)
  const maxBytes = resolveMaxBytes(input.maxBytes)
  const hasPath = input.path != null
  const hasAssetId = input.assetId != null
  if (hasPath && hasAssetId) throw mediaError('invalid-args', 'path 与 assetId 不能同时提供')
  if (hasAssetId) return readLegacyAssetMedia(root, title, input, maxBytes)
  // 未提供 assetId → 保持原 path 模式（含 path 缺失时的既有 invalid-args 语义）
  return readMediaByPath(root, title, input, maxBytes)
}
