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
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
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

/* ---------------------------------------------------------------------------
 * v0.16.95（P0 工作台 / N1b add-only）：视频只读流。
 * - 不新增 METHOD：media-read 增加 mode:'stream'，由 webServer 原生 GET/HEAD 路由承载；
 * - token 为进程内 HMAC 短期票据（TTL 120s），只绑定项目内视频文件；
 * - 安全链与 path 模式一致：assertSafeMediaPath + realpath 项目内 + 视频 MIME 白名单 + 512MB。
 * ------------------------------------------------------------------------- */
export const MEDIA_VIDEO_EXT_MIME = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4',
  '.ogv': 'video/ogg',
}

/** RC-74（add-only）：图片只读流 MIME 白名单（png/jpeg/webp）。 */
export const MEDIA_STREAM_IMAGE_EXT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}
export const MEDIA_STREAM_IMAGE_MAX_BYTES = 64 * 1024 * 1024

/** 视频流大小硬上限（512MB；仅 stream 模式，不影响既有 8MB 图片/音频读取）。 */
export const MEDIA_STREAM_MAX_BYTES = 512 * 1024 * 1024
export const MEDIA_STREAM_TICKET_TTL_MS = 120 * 1000
export const MEDIA_STREAM_IMAGE_TICKET_TTL_MS = 86400 * 1000
export const MEDIA_STREAM_IMAGE_CACHE_CONTROL = 'public, max-age=86400'
export const MEDIA_STREAM_PATH = '/api/ai-drama/media-stream'

/* ---------------------------------------------------------------------------
 * v0.16.96（D-0042，Lead 批准 A 方案）：人物站位图上传（add-only）。
 * - 每镜头一张；文件落 `素材/站位图/<第NNN集>/EP<order>-Shot<k>.<png|jpg|jpeg|webp>`；
 * - 不登记 assets/素材清单；server 生成路径；项目内 realpath/原子写；
 * - ≤8MB（与 media-read 一致）；类型按扩展名+magic bytes 双校验；已存在 → 409 exists（客户端确认后 overwrite:true）。
 * - 移除不在本方法：由 client 走 storyboard-save 清 stagingImage，文件可留孤儿（P0）。
 * ------------------------------------------------------------------------- */
export const MEDIA_UPLOAD_MAX_BYTES = 8 * 1024 * 1024
export const MEDIA_UPLOAD_EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
export const MEDIA_STAGING_DIR = '素材/站位图'

/* RC-24（v0.16.121 add-only）：项目封面目录/固定文件名（服务端派生；不登记 assets）。 */
export const MEDIA_COVER_DIR = '素材/封面'
export const MEDIA_COVER_EXTS = ['.png', '.jpg', '.jpeg', '.webp']

const MEDIA_STREAM_SECRET = randomBytes(32)
const MEDIA_STREAM_TICKET_VERSION = 1

function encodeTicketPart(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

function decodeTicketPart(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null
  try {
    const text = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4), 'base64')
    return text
  } catch {
    return null
  }
}

function signTicketPayload(payload) {
  const body = encodeTicketPart(JSON.stringify(payload))
  const mac = createHmac('sha256', MEDIA_STREAM_SECRET).update(body).digest()
  return `${body}.${encodeTicketPart(mac)}`
}

/** 校验并解析票据；无效/过期/篡改 → null。 */
export function verifyMediaStreamTicket(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4096) return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null
  const body = token.slice(0, dot)
  const macPart = token.slice(dot + 1)
  const mac = decodeTicketPart(macPart)
  if (!mac || mac.length !== 32) return null
  const expected = createHmac('sha256', MEDIA_STREAM_SECRET).update(body).digest()
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null
  const payloadBuffer = decodeTicketPart(body)
  if (!payloadBuffer) return null
  let payload
  try {
    payload = JSON.parse(payloadBuffer.toString('utf8'))
  } catch {
    return null
  }
  if (!payload || payload.v !== MEDIA_STREAM_TICKET_VERSION) return null
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= now) return null
  if (typeof payload.root !== 'string' || typeof payload.title !== 'string' || typeof payload.path !== 'string') return null
  if (typeof payload.mime !== 'string' || !Number.isFinite(payload.size) || payload.size < 1) return null
  return payload
}

/** 解析项目内视频文件（stream/reveal 共用；只读，不写盘）。 */
async function resolveProjectStreamMedia(root, title, rawPathValue, options = {}) {
  const projectRoot = store.projectDir(root, title)
  let realRoot
  try {
    realRoot = await fs.realpath(projectRoot)
  } catch {
    throw mediaError('not-found', '短剧项目不存在或不可读')
  }
  // v0.16.264：兼容 assets.json 旧绝对路径；仅当真实落在项目目录内时转为项目内相对路径。
  let rawPathValueNormalized = rawPathValue
  if (typeof rawPathValue === 'string') {
    const raw = rawPathValue.trim()
    const isAbsolute = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || /^[\\/]{2}/.test(raw)
    if (isAbsolute) {
      const absolute = path.resolve(raw)
      const realAbsolute = await fs.realpath(absolute).catch(() => absolute)
      const relative = path.relative(realRoot, realAbsolute)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw mediaError('forbidden', '非法的媒体路径')
      rawPathValueNormalized = relative.split(path.sep).join('/')
    }
  }
  const rawPath = assertSafeMediaPath(rawPathValueNormalized)
  const resolved = path.resolve(realRoot, rawPath)
  const relative = path.relative(realRoot, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw mediaError('forbidden', '非法的媒体路径')
  const requestedImageMime = MEDIA_STREAM_IMAGE_EXT_MIME[path.extname(resolved).toLowerCase()]
  const requestedVideoMime = MEDIA_VIDEO_EXT_MIME[path.extname(resolved).toLowerCase()]
  const requestedMime = requestedImageMime || requestedVideoMime
  if (!requestedMime) throw mediaError('invalid-args', '不支持的类型（视频 mp4/webm/m4v/ogv；图片 png/jpg/jpeg/webp）')
  let realTarget
  try {
    realTarget = await fs.realpath(resolved)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) throw mediaError('not-found', '视频文件不存在')
    throw mediaError('not-found', '视频文件不可读')
  }
  const relativeReal = path.relative(realRoot, realTarget)
  if (!relativeReal || relativeReal.startsWith('..') || path.isAbsolute(relativeReal)) throw mediaError('forbidden', '非法的媒体路径')
  const imageMime = MEDIA_STREAM_IMAGE_EXT_MIME[path.extname(realTarget).toLowerCase()]
  const videoMime = MEDIA_VIDEO_EXT_MIME[path.extname(realTarget).toLowerCase()]
  const mime = imageMime || videoMime
  const kind = imageMime ? 'image' : 'video'
  if (!mime) throw mediaError('invalid-args', '不支持的类型（视频 mp4/webm/m4v/ogv；图片 png/jpg/jpeg/webp）')
  let stat
  try {
    stat = await fs.stat(realTarget)
  } catch {
    throw mediaError('not-found', '视频文件不可读')
  }
  if (!stat.isFile()) throw mediaError('invalid-args', '目标不是文件')
  if (stat.size < 1) throw mediaError('invalid-args', kind === 'image' ? '图片文件为空' : '视频文件为空')
  const maxBytes = kind === 'image' ? MEDIA_STREAM_IMAGE_MAX_BYTES : MEDIA_STREAM_MAX_BYTES
  if (options.enforceMaxBytes !== false && stat.size > maxBytes) {
    throw mediaError('too-large', `${kind === 'image' ? '图片' : '视频'}过大（${stat.size} 字节 > 上限 ${maxBytes} 字节）`)
  }
  return { title, rawPath, realTarget, name: path.basename(realTarget), mime, kind, size: stat.size, mtimeMs: stat.mtimeMs }
}

/**
 * 签发 media-read mode:'stream' 的短期票据。
 * @returns {Promise<{name:string,mime:string,size:number,token:string,expiresAt:number}>}
 */
export async function issueMediaStreamTicket(root, title, input = {}, options = {}) {
  if (!title) throw mediaError('invalid-args', 'title 不能为空')
  const resolved = await resolveProjectStreamMedia(root, title, input.path)
  const defaultTtlMs = resolved.kind === 'image' ? MEDIA_STREAM_IMAGE_TICKET_TTL_MS : MEDIA_STREAM_TICKET_TTL_MS
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? Math.floor(options.ttlMs) : defaultTtlMs
  const exp = Date.now() + ttlMs
  const token = signTicketPayload({
    v: MEDIA_STREAM_TICKET_VERSION,
    root,
    title,
    path: resolved.rawPath,
    mime: resolved.mime,
    kind: resolved.kind,
    size: resolved.size,
    exp,
  })
  return { name: resolved.name, mime: resolved.mime, kind: resolved.kind, size: resolved.size, token, expiresAt: exp }
}

/** 按票据重新解析文件；文件被替换/大小变化/过期 → null（调用方 401）。 */
export async function resolveMediaStreamTicket(token, now = Date.now()) {
  const payload = verifyMediaStreamTicket(token, now)
  if (!payload) return null
  let resolved
  try {
    resolved = await resolveProjectStreamMedia(payload.root, payload.title, payload.path)
  } catch {
    return null
  }
  if (resolved.mime !== payload.mime || resolved.size !== payload.size) return null
  return resolved
}

/** media-read action:'reveal'：只校验并返回项目内真实路径；native opener 由 index 调用。 */
export async function resolveRevealMedia(root, title, input = {}) {
  if (!title) throw mediaError('invalid-args', 'title 不能为空')
  const resolved = await resolveProjectStreamMedia(root, title, input.path, { enforceMaxBytes: false })
  // v0.16.266：原生 opener 只吃绝对路径；stream 仍用相对 rawPath。
  const absolutePath = resolved.realTarget || path.resolve(store.projectDir(root, title), resolved.rawPath)
  return { name: resolved.name, path: absolutePath, realTarget: resolved.realTarget, mime: resolved.mime, size: resolved.size }
}

/** 解析单段 Range；返回 null（无 Range）或 { start,end } / { invalid:true }。 */
export function parseMediaStreamRange(header, size) {
  if (header == null || header === '') return null
  if (typeof header !== 'string') return { invalid: true }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (!match) return { invalid: true }
  const rawStart = match[1]
  const rawEnd = match[2]
  if (!rawStart && !rawEnd) return { invalid: true }
  if (!rawStart) {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true }
    const length = Math.min(suffix, size)
    return { start: size - length, end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return { invalid: true }
  let end = size - 1
  if (rawEnd) {
    end = Number(rawEnd)
    if (!Number.isSafeInteger(end) || end < start) return { invalid: true }
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

function mediaStreamEtag(resolved) {
  return '"' + Math.floor(resolved.mtimeMs).toString(16) + '-' + resolved.size.toString(16) + '"'
}

function mediaStreamLastModified(resolved) {
  return new Date(Math.floor(resolved.mtimeMs / 1000) * 1000).toUTCString()
}

function isImageStreamFresh(req, etag, lastModified) {
  const headers = req && req.headers ? req.headers : {}
  const ifNoneMatch = headers['if-none-match']
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.trim()) {
    const normalized = ifNoneMatch.split(',').map((part) => part.trim())
    if (normalized.includes('*') || normalized.includes(etag) || normalized.includes('W/' + etag)) return true
  }
  const ifModifiedSince = headers['if-modified-since']
  if (typeof ifModifiedSince === 'string' && ifModifiedSince.trim()) {
    const since = Date.parse(ifModifiedSince)
    const modified = Date.parse(lastModified)
    if (Number.isFinite(since) && Number.isFinite(modified) && modified <= since) return true
  }
  return false
}

function writeStreamError(res, status, code) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: false, code }))
  } catch {
    try { res.destroy() } catch { /* ignore */ }
  }
}

/**
 * webServer 原生 GET/HEAD 处理器（无 ctx 依赖，便于单测）。
 * 认证 token 由 media-read 返回的 authenticatedUrl 携带；本处理器只校验 ticket。
 */
export function createMediaStreamHandler() {
  return async function mediaStreamHandler(req, res) {
    try {
      const method = String(req.method || 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        try { res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }) ; res.end() } catch { /* ignore */ }
        return
      }
      let url
      try {
        url = new URL(String(req.url || '/'), 'http://127.0.0.1')
      } catch {
        writeStreamError(res, 400, 'invalid-args')
        return
      }
      const payload = verifyMediaStreamTicket(url.searchParams.get('ticket'))
      if (!payload) {
        writeStreamError(res, 401, 'invalid-ticket')
        return
      }
      let resolved
      try {
        resolved = await resolveProjectStreamMedia(payload.root, payload.title, payload.path)
      } catch (error) {
        const code = error && typeof error.code === 'string' ? error.code : 'invalid-args'
        const status = code === 'forbidden' ? 403 : code === 'not-found' ? 404 : code === 'too-large' ? 413 : code === 'invalid-args' ? 400 : 500
        writeStreamError(res, status, code)
        return
      }
      if (resolved.mime !== payload.mime || resolved.size !== payload.size) {
        writeStreamError(res, 401, 'invalid-ticket')
        return
      }
      const isImage = resolved.kind === 'image' || String(resolved.mime || '').startsWith('image/')
      const etag = isImage ? mediaStreamEtag(resolved) : null
      const lastModified = isImage ? mediaStreamLastModified(resolved) : null
      if (isImage && isImageStreamFresh(req, etag, lastModified)) {
        try {
          res.writeHead(304, { etag, 'last-modified': lastModified, 'cache-control': MEDIA_STREAM_IMAGE_CACHE_CONTROL })
          res.end()
        } catch { /* ignore */ }
        return
      }
      const range = parseMediaStreamRange(req.headers ? req.headers.range : null, resolved.size)
      if (range && range.invalid) {
        try {
          res.writeHead(416, { 'content-range': `bytes */${resolved.size}`, 'cache-control': 'no-store' })
          res.end()
        } catch { /* ignore */ }
        return
      }
      const start = range ? range.start : 0
      const end = range ? range.end : resolved.size - 1
      const headers = {
        'content-type': resolved.mime,
        'content-length': String(end - start + 1),
        'accept-ranges': 'bytes',
        'cache-control': isImage ? MEDIA_STREAM_IMAGE_CACHE_CONTROL : 'no-store',
        ...(isImage ? { etag, 'last-modified': lastModified } : {}),
      }
      if (range) headers['content-range'] = `bytes ${start}-${end}/${resolved.size}`
      res.writeHead(range ? 206 : 200, headers)
      if (method === 'HEAD') {
        res.end()
        return
      }
      const stream = createReadStream(resolved.realTarget, { start, end })
      stream.on('error', () => { try { res.destroy() } catch { /* ignore */ } })
      stream.pipe(res)
      if (req && typeof req.on === 'function') {
        req.on('close', () => { try { stream.destroy() } catch { /* ignore */ } })
      }
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : 'invalid-args'
      const status = code === 'forbidden' ? 403 : code === 'not-found' ? 404 : code === 'too-large' ? 413 : code === 'invalid-args' ? 400 : 500
      writeStreamError(res, status, code)
    }
  }
}


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
/** v0.16.24（H-11/A4 add-only）：导出 registry source 解析，供音频绑定写入路径复用（行为不变）。 */
export async function resolveRegistryMediaSource(root, title, source) {
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

/* ---------------------------------------------------------- v0.16.96 D-0042 上传 */

function uploadError(code, message) {
  return mediaError(code, message)
}

function lastNumericToken(value) {
  const match = /(\d+)\s*$/u.exec(String(value == null ? '' : value).trim())
  if (!match) return null
  const n = Number(match[1])
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function sniffImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return null
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return { mime: 'image/png', ext: '.png' }
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: '.webp' }
  }
  return null
}

function decodeUploadBase64(value) {
  if (typeof value !== 'string' || !value) throw uploadError('invalid-args', 'bytes/dataBase64 必须是非空 base64 字符串')
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw uploadError('invalid-args', 'base64 含非法字符或长度不是 4 的倍数')
  }
  const buffer = Buffer.from(value, 'base64')
  if (!buffer.length) throw uploadError('invalid-args', '上传内容为空')
  return buffer
}

/**
 * 上传一张人物站位图（每镜头一张）。
 * @param {string} root
 * @param {{title?:string, episode?:number|string, order?:number|string, shotNumber?:string, shotId?:string, shotKey?:string, filename?:string, mime?:string, bytes?:string, dataBase64?:string, overwrite?:boolean}} input
 * @returns {Promise<{relPath:string, path:string, bytes:number, mime:string, sha256:string}>}
 */
export async function uploadStagingImage(root, input = {}) {
  const title = await resolveProjectTitle(root, input.title)
  const episode = Number(input.episode ?? input.order)
  if (!Number.isInteger(episode) || episode < 1 || episode > 9999) throw uploadError('invalid-args', 'episode 必须是 1~9999 的整数')
  let projectDir
  try {
    projectDir = store.projectDir(root, title)
  } catch {
    throw uploadError('not-found', '短剧项目不存在')
  }
  if (!(await store.isDirectory(projectDir))) throw uploadError('not-found', '短剧项目不存在')

  let shots
  try {
    shots = await store.getStoryboard(root, title, episode)
  } catch {
    throw uploadError('not-found', '分镜不存在')
  }
  if (!Array.isArray(shots)) throw uploadError('not-found', '分镜不存在')
  const rawKey = String(input.shotNumber ?? input.shotId ?? input.shotKey ?? '').trim()
  if (!rawKey) throw uploadError('invalid-args', 'shotNumber/shotId/shotKey 不能为空')
  const canonical = /^EP(\d+)-Shot-?(\d+)$/iu.exec(rawKey)
  let shotIndex = -1
  let shot = null
  if (canonical) {
    const k = Number(canonical[2])
    shotIndex = shots.findIndex((item) => lastNumericToken(item && item.shotNumber) === k)
    if (shotIndex < 0 && k >= 1 && k <= shots.length) shotIndex = k - 1
  } else {
    shotIndex = shots.findIndex((item) => String(item && item.shotNumber == null ? '' : item.shotNumber).trim() === rawKey)
  }
  if (shotIndex < 0 || !shots[shotIndex]) throw uploadError('not-found', '镜头不存在（shotNumber/shotKey 未匹配当前分镜）')
  shot = shots[shotIndex]
  const shotK = lastNumericToken(shot.shotNumber) ?? (shotIndex + 1)

  const bytesRaw = [input.bytes, input.dataBase64, input.base64].filter((value) => value != null)
  if (!bytesRaw.length) throw uploadError('invalid-args', '缺少 bytes/dataBase64（base64 图片数据）')
  if (bytesRaw.length > 1 && !bytesRaw.every((value) => value === bytesRaw[0])) throw uploadError('invalid-args', 'bytes 与 dataBase64 不能同时提供不同内容')
  const buffer = decodeUploadBase64(bytesRaw[0])
  if (buffer.length > MEDIA_UPLOAD_MAX_BYTES) throw uploadError('too-large', `图片过大（${buffer.length} 字节 > 上限 ${MEDIA_UPLOAD_MAX_BYTES} 字节）`)
  const sniffed = sniffImageMime(buffer)
  if (!sniffed) throw uploadError('invalid-args', '仅支持 png/jpg/jpeg/webp 图片（magic bytes 校验失败）')

  const declaredMime = typeof input.mime === 'string' ? input.mime.trim().toLowerCase() : ''
  if (declaredMime && declaredMime !== sniffed.mime) throw uploadError('invalid-args', 'mime 与图片实际类型不一致')
  const filenameRaw = input.filename == null ? '' : String(input.filename).trim()
  let ext = sniffed.ext
  if (filenameRaw) {
    if (filenameRaw.length > 120) throw uploadError('invalid-args', 'filename 过长（上限 120 字符）')
    if (/[\\/:*?"<>|\u0000-\u001f]/u.test(filenameRaw)) throw uploadError('invalid-args', 'filename 含非法字符')
    const namedExt = path.extname(filenameRaw).toLowerCase()
    if (!MEDIA_UPLOAD_EXT_MIME[namedExt]) throw uploadError('invalid-args', '仅支持 png/jpg/jpeg/webp 图片')
    if (sniffed.mime === 'image/jpeg' && (namedExt === '.jpg' || namedExt === '.jpeg')) ext = namedExt
    else if (namedExt !== sniffed.ext) throw uploadError('invalid-args', 'filename 扩展名与图片实际类型不一致')
  }

  const relPath = `${MEDIA_STAGING_DIR}/第${String(episode).padStart(3, '0')}集/EP${episode}-Shot${shotK}${ext}`
  const absoluteTarget = path.join(projectDir, ...relPath.split('/'))
  let existing = null
  try {
    existing = await fs.stat(absoluteTarget)
  } catch {
    existing = null
  }
  if (existing && input.overwrite !== true) {
    throw uploadError('exists', '目标站位图已存在；确认覆盖后带 overwrite:true 重试')
  }
  await store.guardedProjectWriteBinary(projectDir, relPath, buffer)
  return {
    relPath,
    path: relPath,
    bytes: buffer.length,
    mime: sniffed.mime,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

/* ---------------------------------------------------------------------------
 * RC-24（v0.16.121，Lead 批准方案 A）：项目封面（media-upload add-only purpose:'cover'）。
 * - 固定路径 `素材/封面/cover.<png|jpg|webp>`；服务端派生，不接受客户端 path；
 * - ≤8MB；png/jpg/jpeg/webp（magic bytes）；mime/filename 可缺省但需与实际类型一致；
 * - guarded 原子写；替换时 best-effort 清理其它扩展名变体；
 * - 恢复默认 `remove:true` 幂等删除全部候选变体（不写 .aidrama、不登记 assets）。
 * ------------------------------------------------------------------------- */
function coverRelPath(ext) {
  return `${MEDIA_COVER_DIR}/cover${ext}`
}

/** 上传/替换项目封面；返回 { relPath, path, bytes, mime, sha256 }。 */
export async function uploadProjectCover(root, input = {}) {
  const title = await resolveProjectTitle(root, input.title)
  let projectDir
  try {
    projectDir = store.projectDir(root, title)
  } catch {
    throw uploadError('not-found', '短剧项目不存在')
  }
  if (!(await store.isDirectory(projectDir))) throw uploadError('not-found', '短剧项目不存在')
  const bytesRaw = [input.bytes, input.dataBase64, input.base64].filter((value) => value != null)
  if (!bytesRaw.length) throw uploadError('invalid-args', '缺少 bytes/dataBase64（base64 图片数据）')
  if (bytesRaw.length > 1 && !bytesRaw.every((value) => value === bytesRaw[0])) throw uploadError('invalid-args', 'bytes 与 dataBase64 不能同时提供不同内容')
  const buffer = decodeUploadBase64(bytesRaw[0])
  if (buffer.length > MEDIA_UPLOAD_MAX_BYTES) throw uploadError('too-large', `封面过大（${buffer.length} 字节 > 上限 ${MEDIA_UPLOAD_MAX_BYTES} 字节）`)
  const sniffed = sniffImageMime(buffer)
  if (!sniffed) throw uploadError('invalid-args', '封面仅支持 png/jpg/jpeg/webp 图片（magic bytes 校验失败）')
  const declaredMime = typeof input.mime === 'string' ? input.mime.trim().toLowerCase() : ''
  if (declaredMime && declaredMime !== sniffed.mime) throw uploadError('invalid-args', 'mime 与图片实际类型不一致')
  const filenameRaw = input.filename == null ? '' : String(input.filename).trim()
  if (filenameRaw) {
    if (filenameRaw.length > 120) throw uploadError('invalid-args', 'filename 过长（上限 120 字符）')
    if (/[\\/:*?"<>|\u0000-\u001f]/u.test(filenameRaw)) throw uploadError('invalid-args', 'filename 含非法字符')
    const namedExt = path.extname(filenameRaw).toLowerCase()
    if (!MEDIA_UPLOAD_EXT_MIME[namedExt]) throw uploadError('invalid-args', '封面仅支持 png/jpg/jpeg/webp 图片')
    if (!(sniffed.mime === 'image/jpeg' && (namedExt === '.jpg' || namedExt === '.jpeg')) && namedExt !== sniffed.ext) {
      throw uploadError('invalid-args', 'filename 扩展名与图片实际类型不一致')
    }
  }
  const relPath = coverRelPath(sniffed.ext)
  await store.guardedProjectWriteBinary(projectDir, relPath, buffer)
  for (const ext of MEDIA_COVER_EXTS) {
    if (ext === sniffed.ext) continue
    try { await store.guardedProjectRemove(projectDir, coverRelPath(ext)) } catch { /* best-effort 清理旧变体 */ }
  }
  return {
    relPath,
    path: relPath,
    bytes: buffer.length,
    mime: sniffed.mime,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

/** 恢复默认封面：幂等删除全部候选变体；返回 { removed:boolean }。 */
export async function removeProjectCover(root, input = {}) {
  const title = await resolveProjectTitle(root, input.title)
  let projectDir
  try {
    projectDir = store.projectDir(root, title)
  } catch {
    throw uploadError('not-found', '短剧项目不存在')
  }
  if (!(await store.isDirectory(projectDir))) throw uploadError('not-found', '短剧项目不存在')
  let removed = false
  for (const ext of MEDIA_COVER_EXTS) {
    const rel = coverRelPath(ext)
    const abs = path.join(projectDir, ...rel.split('/'))
    const stat = await fs.stat(abs).catch(() => null)
    if (!stat || !stat.isFile()) continue
    await store.guardedProjectRemove(projectDir, rel)
    removed = true
  }
  return { removed }
}
