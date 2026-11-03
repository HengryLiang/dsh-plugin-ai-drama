/**
 * R-10 / M8 阶段 1：项目备份目录包（E 类 add-only）
 *
 * 目标：备份 `.aidrama` 关键状态文件到项目 `导出/backup-<UTCstamp>/`，可选 `素材/` 媒体；
 * 生成自带 SHA/bytes manifest；支持 dry-run 与只读 verify（阶段 1 不恢复 apply）。
 *
 * 约束：仅项目内写、全部走 store guard；不新增 METHOD；旧导出格式不受影响；
 * 不读项目外、不跟随 symlink/junction；失败清理本次备份目录。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as store from './store.js'
import * as txn from './txn.js'

export const BACKUP_FORMAT = 'backup'
export const BACKUP_SCHEMA_VERSION = 1
export const BACKUP_KIND = 'drama-project-backup'
export const BACKUP_MANIFEST_FILE = 'manifest.json'

const MAX_MEDIA_FILES = 5000
const MAX_MEDIA_BYTES = 512 * 1024 * 1024

const STATE_FILES = [
  '.aidrama/contract.json',
  '.aidrama/outline.json',
  '.aidrama/characters.json',
  '.aidrama/memory.json',
  '.aidrama/world.json',
  '.aidrama/style.json',
  '.aidrama/finalized.json',
  '.aidrama/assets.json',
  '.aidrama/assets/cards.json',
  '.aidrama/scenes/cards.json',
  '.aidrama/import-history.json',
  '.aidrama/import-templates.json',
  '.aidrama/budget.json',
  '.aidrama/tasks.json',
  '.aidrama/flow-state.json',
  // RC-30（v0.16.136 add-only）：资产单图直连生成任务 sidecar 纳入 core 备份/恢复。
  '.aidrama/asset-generation.json',
]
const STATE_DIRS = [
  ['.aidrama/storyboard', /^[^/]+\.json$/],
  ['.aidrama/storyboard-groups', /^[^/]+\.json$/],
]
// RC-24（v0.16.121）：项目封面纳入 core 备份/恢复（独立于 includeMedia 的素材大目录；导出不改）。
const COVER_DIR = '素材/封面'
const COVER_FILE_RE = /^cover\.(?:png|jpg|jpeg|webp)$/i
// RC-26（v0.16.132）：资产库 v2 资产图片纳入 core 备份/恢复（白名单 + 上限；不走 includeMedia，restore 可写回）。
// RC-35（v0.16.141）：允许资产图落 `素材/短剧资产/<中文类型>/` 单层类型子目录（collect/H3 同口径）。
const ASSET_LIBRARY_DIR = '素材/短剧资产'
const ASSET_TYPE_DIR_NAMES = new Set(['人物卡', '场景卡', '道具卡', '特效卡', '载具卡', '服装卡', '其他'])
const ASSET_LIBRARY_FILE_RE = /\.(?:png|jpe?g|webp|gif|bmp|avif|mp3|wav|m4a|ogg|aac|mp4|mov|webm|mkv|avi|md|txt|json|csv|pdf|docx)$/i
const MAX_ASSET_LIBRARY_FILES = 2000
const MAX_ASSET_LIBRARY_BYTES = 512 * 1024 * 1024

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

function backupError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  if (extra && typeof extra === 'object') Object.assign(error, extra)
  return error
}

function assertBool(value, label) {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw backupError('invalid-args', `${label} 必须是布尔值`)
  return value
}

function safeRel(value, label) {
  const rel = String(value == null ? '' : value).replace(/\\/g, '/').trim()
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..') || /^[A-Za-z]:/.test(rel)) {
    throw backupError('forbidden', `${label} 不合法`)
  }
  return rel
}

function isInside(base, target) {
  const rel = path.relative(base, target)
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
}

async function assertProjectDir(root, title) {
  const dir = store.projectDir(root, title)
  if (!(await store.isDirectory(dir))) throw backupError('not-found', `短剧《${title}》不存在`)
  const real = await fs.realpath(dir).catch(() => null)
  if (!real) throw backupError('not-found', `短剧《${title}》不可读`)
  return { dir, real }
}

async function readRegularSource(projectReal, rel) {
  const abs = path.join(projectReal, ...rel.split('/'))
  const stat = await fs.lstat(abs).catch(() => null)
  if (!stat) return null
  if (stat.isSymbolicLink()) throw backupError('forbidden', `备份源包含符号链接/junction：${rel}`)
  if (!stat.isFile()) return null
  const real = await fs.realpath(abs).catch(() => null)
  if (!real || !isInside(projectReal, real)) throw backupError('forbidden', `备份源越出项目：${rel}`)
  return { abs, real, bytes: stat.size, sha256: sha256(await fs.readFile(abs)) }
}

async function listStateFiles(projectReal) {
  const files = []
  for (const rel of STATE_FILES) {
    try {
      const info = await readRegularSource(projectReal, rel)
      if (info) files.push({ source: rel, role: 'state', target: `state/${rel}`, bytes: info.bytes, sha256: info.sha256 })
    } catch (error) {
      if (error && error.code) throw error
      throw backupError('failed', `读取备份源失败：${rel}`)
    }
  }
  for (const [dirRel, pattern] of STATE_DIRS) {
    const dirAbs = path.join(projectReal, ...dirRel.split('/'))
    let dirStat
    try { dirStat = await fs.lstat(dirAbs) } catch { continue }
    if (dirStat.isSymbolicLink()) throw backupError('forbidden', `备份源目录是符号链接/junction：${dirRel}`)
    if (!dirStat.isDirectory()) continue
    const names = (await fs.readdir(dirAbs)).sort()
    for (const name of names) {
      if (!pattern.test(name)) continue
      const rel = `${dirRel}/${name}`
      const info = await readRegularSource(projectReal, rel)
      if (info) files.push({ source: rel, role: 'state', target: `state/${rel}`, bytes: info.bytes, sha256: info.sha256 })
    }
  }
  // RC-24（v0.16.121）：封面文件纳入 core state 备份（与 includeMedia 无关；固定前缀 + 严格文件名）。
  const coverDirAbs = path.join(projectReal, ...COVER_DIR.split('/'))
  const coverDirStat = await fs.lstat(coverDirAbs).catch(() => null)
  if (coverDirStat) {
    if (coverDirStat.isSymbolicLink()) throw backupError('forbidden', `备份源目录是符号链接/junction：${COVER_DIR}`)
    if (coverDirStat.isDirectory()) {
      for (const name of (await fs.readdir(coverDirAbs)).sort()) {
        if (!COVER_FILE_RE.test(name)) continue
        const rel = `${COVER_DIR}/${name}`
        const info = await readRegularSource(projectReal, rel)
        if (info) files.push({ source: rel, role: 'state', target: `state/${rel}`, bytes: info.bytes, sha256: info.sha256 })
      }
    }
  }
  // RC-26（v0.16.132）：资产库 v2 资产图片纳入 core state 备份（白名单 + ≤2000 文件 / ≤512MB；restore 可写回）。
  const assetDirAbs = path.join(projectReal, ...ASSET_LIBRARY_DIR.split('/'))
  const assetDirStat = await fs.lstat(assetDirAbs).catch(() => null)
  if (assetDirStat) {
    if (assetDirStat.isSymbolicLink()) throw backupError('forbidden', `备份源目录是符号链接/junction：${ASSET_LIBRARY_DIR}`)
    if (assetDirStat.isDirectory()) {
      let assetFiles = 0
      let assetBytes = 0
      const pushAssetFile = async (rel) => {
        const info = await readRegularSource(projectReal, rel)
        if (!info) return
        assetFiles += 1
        assetBytes += info.bytes
        if (assetFiles > MAX_ASSET_LIBRARY_FILES) throw backupError('invalid-args', `备份资产库文件超过上限 ${MAX_ASSET_LIBRARY_FILES}`)
        if (assetBytes > MAX_ASSET_LIBRARY_BYTES) throw backupError('invalid-args', `备份资产库超过上限 ${MAX_ASSET_LIBRARY_BYTES} 字节`)
        files.push({ source: rel, role: 'state', target: `state/${rel}`, bytes: info.bytes, sha256: info.sha256 })
      }
      for (const entry of (await fs.readdir(assetDirAbs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isFile()) {
          if (ASSET_LIBRARY_FILE_RE.test(entry.name)) await pushAssetFile(`${ASSET_LIBRARY_DIR}/${entry.name}`)
          continue
        }
        // RC-35：单层中文类型子目录（人物/场景/道具/特效/载具/服装/其他），不递归、不跟随符号链接。
        if (!entry.isDirectory() || !ASSET_TYPE_DIR_NAMES.has(entry.name)) continue
        const subAbs = path.join(assetDirAbs, entry.name)
        const subStat = await fs.lstat(subAbs)
        if (subStat.isSymbolicLink()) throw backupError('forbidden', `备份源目录是符号链接/junction：${ASSET_LIBRARY_DIR}/${entry.name}`)
        for (const sub of (await fs.readdir(subAbs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!sub.isFile() || !ASSET_LIBRARY_FILE_RE.test(sub.name)) continue
          await pushAssetFile(`${ASSET_LIBRARY_DIR}/${entry.name}/${sub.name}`)
        }
      }
    }
  }
  return files
}

async function listMediaFiles(projectReal, options = {}) {
  if (options.includeMedia !== true) return []
  const base = path.join(projectReal, '素材')
  let baseStat
  try { baseStat = await fs.lstat(base) } catch { return [] }
  if (baseStat.isSymbolicLink()) throw backupError('forbidden', '素材目录是符号链接/junction')
  if (!baseStat.isDirectory()) return []
  const files = []
  let totalBytes = 0
  async function walk(absDir, relDir) {
    // RC-24（v0.16.121）：封面已作为 core state 备份，避免 includeMedia 时重复。
    // RC-26（v0.16.132）：资产库 v2 资产图片已作为 core state 备份，避免 includeMedia 时重复。
    if (relDir === COVER_DIR || relDir === ASSET_LIBRARY_DIR) return
    const entries = await fs.readdir(absDir, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(absDir, entry.name)
      const rel = `${relDir}/${entry.name}`
      const stat = await fs.lstat(abs)
      if (stat.isSymbolicLink()) throw backupError('forbidden', `素材包含符号链接/junction：${rel}`)
      if (stat.isDirectory()) {
        await walk(abs, rel)
        continue
      }
      if (!stat.isFile()) continue
      if (files.length >= MAX_MEDIA_FILES) throw backupError('invalid-args', `备份媒体文件超过上限 ${MAX_MEDIA_FILES}`)
      totalBytes += stat.size
      if (totalBytes > MAX_MEDIA_BYTES) throw backupError('invalid-args', `备份媒体超过上限 ${MAX_MEDIA_BYTES} 字节`)
      files.push({ source: rel, role: 'media', target: `media/${rel}`, bytes: stat.size, sha256: sha256(await fs.readFile(abs)) })
    }
  }
  await walk(base, '素材')
  return files
}

function buildManifest(title, includeMedia, files) {
  const totals = files.reduce((acc, item) => {
    acc.files += 1
    acc.bytes += item.bytes
    if (item.role === 'media') {
      acc.mediaFiles += 1
      acc.mediaBytes += item.bytes
    }
    return acc
  }, { files: 0, bytes: 0, mediaFiles: 0, mediaBytes: 0 })
  return {
    kind: BACKUP_KIND,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    project: { title },
    options: { includeMedia: includeMedia === true },
    digestAlgorithm: 'sha256',
    files: files.map(({ target, ...item }) => ({ path: target, ...item })),
    totals,
  }
}

async function pathExistsABS(file) {
  try { await fs.lstat(file); return true } catch { return false }
}

export function backupDirName(date = new Date()) {
  return `backup-${date.toISOString().replace(/[:.]/g, '-')}`
}

/**
 * 创建备份目录包或 dry-run 计划。
 * @returns {{format:'backup',dryRun:boolean,file:string|null,bytes:number,backup:object}}
 */
export async function createBackup(root, title, options = {}) {
  const dryRun = assertBool(options.dryRun, 'dryRun') === true
  const includeMedia = assertBool(options.includeMedia, 'includeMedia') === true
  const { dir, real } = await assertProjectDir(root, title)
  // 先 guard 导出目录（junction/symlink 拒绝）；dry-run 也只做只读校验，不创建/probe。
  const safeExportReal = await store.assertProjectWriteTarget(real, '导出').catch((error) => { throw error })
  const exportReal = await fs.realpath(safeExportReal).catch(() => safeExportReal)
  const backupName = backupDirName()
  const backupAbs = path.join(exportReal, backupName)
  const backupRel = `导出/${backupName}`
  if (await pathExistsABS(backupAbs)) throw backupError('invalid-args', `备份目录已存在：${backupName}`)
  const state = await listStateFiles(real)
  const media = await listMediaFiles(real, { includeMedia })
  const files = [...state, ...media]
  const manifest = buildManifest(title, includeMedia, files)
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  const backup = {
    dir: backupRel,
    relative: backupRel,
    fileCount: files.length,
    mediaFileCount: media.length,
    totalBytes: files.reduce((sum, item) => sum + item.bytes, 0),
    dryRun,
    manifest: { schemaVersion: manifest.schemaVersion, fileCount: files.length, mediaFileCount: media.length, totalBytes: manifest.totals.bytes },
  }
  if (dryRun) return { format: BACKUP_FORMAT, dryRun: true, file: null, bytes: 0, backup }
  let created = false
  try {
    await store.guardedProjectMkdir(real, backupRel)
    created = true
    for (const item of files) {
      const source = path.join(real, ...item.source.split('/'))
      const buffer = await fs.readFile(source)
      if (sha256(buffer) !== item.sha256) throw backupError('failed', `备份源在写入前发生变化：${item.source}`)
      await store.guardedProjectWriteBinary(real, `${backupRel}/${item.target}`, buffer)
    }
    await store.guardedProjectWrite(real, `${backupRel}/${BACKUP_MANIFEST_FILE}`, manifestText)
    const manifestAbs = path.join(backupAbs, BACKUP_MANIFEST_FILE)
    return { format: BACKUP_FORMAT, dryRun: false, file: manifestAbs, bytes: Buffer.byteLength(manifestText, 'utf8'), backup }
  } catch (error) {
    if (created) await store.guardedProjectRemove(real, backupRel).catch(() => {})
    if (error && error.code) throw error
    throw backupError('failed', `备份失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || manifest.kind !== BACKUP_KIND || manifest.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw backupError('invalid-args', '备份 manifest 不合法（kind/schemaVersion）')
  }
  if (!Array.isArray(manifest.files)) throw backupError('invalid-args', '备份 manifest.files 必须是数组')
  if (!manifest.project || typeof manifest.project.title !== 'string') throw backupError('invalid-args', '备份 manifest.project.title 缺失')
  const seen = new Set()
  for (const item of manifest.files) {
    if (!item || typeof item !== 'object') throw backupError('invalid-args', '备份 manifest.files 条目不合法')
    const rel = safeRel(item.path, 'manifest.files.path')
    if (!rel.startsWith('state/') && !rel.startsWith('media/')) throw backupError('forbidden', '备份 manifest 文件路径不在 state/media 下')
    if (seen.has(rel)) throw backupError('invalid-args', `备份 manifest 重复路径：${rel}`)
    seen.add(rel)
    safeRel(item.source, 'manifest.files.source')
    if (!Number.isInteger(item.bytes) || item.bytes < 0) throw backupError('invalid-args', '备份 manifest bytes 不合法')
    if (!/^[0-9a-f]{64}$/.test(String(item.sha256 || ''))) throw backupError('invalid-args', '备份 manifest sha256 不合法')
  }
  return seen
}

/**
 * 只读校验备份；返回若恢复会处理哪些 state/source 及差异。绝不写盘。
 */
export async function verifyBackup(root, title, backupDir) {
  const name = String(backupDir == null ? '' : backupDir).trim()
  if (!/^backup-[A-Za-z0-9._-]+$/.test(name) || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw backupError('forbidden', 'backupDir 不合法')
  }
  const { real } = await assertProjectDir(root, title)
  const exportAbs = path.join(real, '导出')
  const exportStat = await fs.lstat(exportAbs).catch(() => null)
  if (!exportStat || exportStat.isSymbolicLink() || !exportStat.isDirectory()) throw backupError('not-found', '导出目录不存在')
  const backupAbs = path.join(exportAbs, name)
  const backupStat = await fs.lstat(backupAbs).catch(() => null)
  if (!backupStat || backupStat.isSymbolicLink() || !backupStat.isDirectory()) throw backupError('not-found', `备份目录不存在：${name}`)
  const backupReal = await fs.realpath(backupAbs)
  if (!isInside(await fs.realpath(exportAbs), backupReal)) throw backupError('forbidden', '备份目录越出导出目录')
  let manifest
  try { manifest = JSON.parse(await fs.readFile(path.join(backupReal, BACKUP_MANIFEST_FILE), 'utf8')) } catch (error) {
    if (error && error.code === 'ENOENT') throw backupError('not-found', '备份 manifest 不存在')
    throw backupError('invalid-args', '备份 manifest 不可读或不是合法 JSON')
  }
  const listed = validateManifest(manifest)
  const missing = []
  const unexpected = []
  const actualFiles = []
  async function walk(absDir, relDir = '') {
    const entries = await fs.readdir(absDir, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(absDir, entry.name)
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      const stat = await fs.lstat(abs)
      if (stat.isSymbolicLink()) throw backupError('forbidden', `备份包含符号链接/junction：${rel}`)
      if (stat.isDirectory()) await walk(abs, rel)
      else if (stat.isFile() && rel !== BACKUP_MANIFEST_FILE) actualFiles.push(rel)
    }
  }
  await walk(backupReal)
  for (const item of manifest.files) {
    const abs = path.join(backupReal, ...item.path.split('/'))
    const stat = await fs.lstat(abs).catch(() => null)
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      missing.push(item.path)
      continue
    }
    const buffer = await fs.readFile(abs)
    if (buffer.length !== item.bytes || sha256(buffer) !== item.sha256) missing.push(item.path)
  }
  for (const rel of actualFiles) if (!listed.has(rel)) unexpected.push(rel)
  const wouldRestore = manifest.files.filter((item) => item.role === 'state').map((item) => item.source)
  const conflicts = []
  for (const item of manifest.files) {
    const dest = path.join(real, ...item.source.split('/'))
    const stat = await fs.lstat(dest).catch(() => null)
    if (!stat) continue
    if (stat.isSymbolicLink() || !stat.isFile()) { conflicts.push({ source: item.source, reason: 'target-not-regular' }); continue }
    const current = await fs.readFile(dest)
    if (sha256(current) !== item.sha256) conflicts.push({ source: item.source, reason: 'target-modified', sha256: sha256(current) })
  }
  return {
    ok: missing.length === 0 && unexpected.length === 0,
    backupDir: name,
    manifest: { schemaVersion: manifest.schemaVersion, createdAt: manifest.createdAt, project: manifest.project, options: manifest.options },
    files: { count: manifest.files.length, mediaCount: manifest.files.filter((item) => item.role === 'media').length, totalBytes: manifest.files.reduce((sum, item) => sum + item.bytes, 0) },
    wouldRestore,
    conflicts,
    missing,
    unexpected,
    dryRunRestore: true,
  }
}

/* ============================== M8 阶段2：恢复 apply ============================== */

const RESTORE_ACTION = 'backup-restore'
const RESTORE_CONFLICTS = ['abort', 'overwrite', 'skip']
const RESTORE_PLAN_MODE = 'state'
const BACKUP_DIR_RE = /^backup-[A-Za-z0-9._-]+$/

function isAllowedStateSource(source) {
  if (STATE_FILES.includes(source)) return true
  // RC-24（v0.16.121）：core 备份/恢复允许 素材/封面/cover.<ext>（严格文件名白名单）。
  if (source.startsWith(`${COVER_DIR}/`)) return COVER_FILE_RE.test(source.slice(COVER_DIR.length + 1))
  // RC-26（v0.16.132）：core 备份/恢复允许 素材/短剧资产/<单层文件>。
  // RC-35（v0.16.141）：再允许 素材/短剧资产/<中文类型>/<单层文件>（类型目录固定白名单）。
  if (source.startsWith(`${ASSET_LIBRARY_DIR}/`)) {
    const parts = source.slice(ASSET_LIBRARY_DIR.length + 1).split('/')
    if (parts.length === 1) return ASSET_LIBRARY_FILE_RE.test(parts[0])
    if (parts.length === 2) return ASSET_TYPE_DIR_NAMES.has(parts[0]) && ASSET_LIBRARY_FILE_RE.test(parts[1])
    return false
  }
  return STATE_DIRS.some(([dirRel, pattern]) => {
    if (!source.startsWith(`${dirRel}/`)) return false
    const rest = source.slice(dirRel.length + 1)
    return !rest.includes('/') && pattern.test(rest)
  })
}

function normalizeBackupDirName(value) {
  const name = String(value == null ? '' : value).trim()
  if (!BACKUP_DIR_RE.test(name) || name === 'backup-' || name.includes('..')) {
    throw backupError('forbidden', 'backupDir 不合法')
  }
  return name
}

function sha256Text(text) {
  return sha256(Buffer.from(text, 'utf8'))
}

/** 只读读取/校验备份目录；返回可恢复 state 文件与当前目标状态。 */
async function inspectBackup(root, title, backupDir) {
  const name = normalizeBackupDirName(backupDir)
  const { real } = await assertProjectDir(root, title)
  const exportAbs = path.join(real, '导出')
  const exportStat = await fs.lstat(exportAbs).catch(() => null)
  if (!exportStat || exportStat.isSymbolicLink() || !exportStat.isDirectory()) throw backupError('not-found', '导出目录不存在')
  const backupAbs = path.join(exportAbs, name)
  const backupStat = await fs.lstat(backupAbs).catch(() => null)
  if (!backupStat || backupStat.isSymbolicLink() || !backupStat.isDirectory()) throw backupError('not-found', `备份目录不存在：${name}`)
  const backupReal = await fs.realpath(backupAbs)
  if (!isInside(await fs.realpath(exportAbs), backupReal)) throw backupError('forbidden', '备份目录越出导出目录')
  let manifestText
  try {
    manifestText = await fs.readFile(path.join(backupReal, BACKUP_MANIFEST_FILE), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') throw backupError('not-found', '备份 manifest 不存在')
    throw backupError('invalid-args', '备份 manifest 不可读')
  }
  if (Buffer.byteLength(manifestText, 'utf8') > 64 * 1024) throw backupError('invalid-args', '备份 manifest 过大（>64KB）')
  let manifest
  try { manifest = JSON.parse(manifestText) } catch { throw backupError('invalid-args', '备份 manifest 不是合法 JSON') }
  const listed = validateManifest(manifest)
  const actualFiles = []
  async function walk(dir, relDir = '') {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name); const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      const stat = await fs.lstat(abs)
      if (stat.isSymbolicLink()) throw backupError('forbidden', `备份包含符号链接/junction：${rel}`)
      if (stat.isDirectory()) await walk(abs, rel)
      else if (stat.isFile() && rel !== BACKUP_MANIFEST_FILE) actualFiles.push(rel)
    }
  }
  await walk(backupReal)
  const missing = []
  const unexpected = []
  const buffers = new Map()
  for (const item of manifest.files) {
    const abs = path.join(backupReal, ...item.path.split('/'))
    const stat = await fs.lstat(abs).catch(() => null)
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) { missing.push(item.path); continue }
    const buffer = await fs.readFile(abs)
    if (buffer.length !== item.bytes || sha256(buffer) !== item.sha256) missing.push(item.path)
    else buffers.set(item.path, buffer)
  }
  for (const rel of actualFiles) if (!listed.has(rel)) unexpected.push(rel)
  const stateEntries = manifest.files.filter((item) => item.role === 'state')
  for (const item of stateEntries) {
    if (item.path !== `state/${item.source}`) throw backupError('forbidden', '备份 state path/source 不匹配')
    if (!isAllowedStateSource(item.source)) throw backupError('forbidden', `备份 state source 不在 allowlist：${item.source}`)
  }
  const mediaEntries = manifest.files.filter((item) => item.role === 'media')
  const targets = []
  for (const item of stateEntries) {
    let targetAbs
    try {
      targetAbs = await store.assertProjectWriteTarget(real, item.source)
    } catch (error) {
      if (error && error.code === 'forbidden') throw backupError('forbidden', `恢复目标路径不安全：${item.source}`)
      throw error
    }
    const stat = await fs.lstat(targetAbs).catch(() => null)
    let targetState = 'missing'
    let targetSha256 = null
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isFile()) throw backupError('forbidden', `恢复目标是符号链接/非普通文件：${item.source}`)
      targetSha256 = sha256(await fs.readFile(targetAbs))
      targetState = targetSha256 === item.sha256 ? 'same' : 'different'
    }
    targets.push({ source: item.source, path: item.path, role: 'state', bytes: item.bytes, sha256: item.sha256, targetState, targetSha256 })
  }
  const manifestSha256 = sha256Text(manifestText)
  return { real, name, manifest, manifestText, manifestSha256, backupReal, buffers, missing, unexpected, targets, stateEntries, mediaEntries }
}

function buildPlan(inspected, options) {
  const conflict = options.conflict || 'abort'
  const mode = RESTORE_PLAN_MODE
  const wouldCreate = inspected.targets.filter((t) => t.targetState === 'missing').length
  const wouldOverwrite = inspected.targets.filter((t) => t.targetState === 'different').length
  const wouldSkip = inspected.targets.filter((t) => t.targetState === 'same').length
  const conflicts = inspected.targets.filter((t) => t.targetState === 'different').map((t) => ({ source: t.source, reason: 'target-modified', targetSha256: t.targetSha256 }))
  const planInput = {
    manifestSha256: inspected.manifestSha256,
    backupDir: inspected.name,
    mode,
    includeMedia: false,
    conflict,
    targets: inspected.targets.map((t) => ({ source: t.source, path: t.path, role: t.role, bytes: t.bytes, sha256: t.sha256, targetState: t.targetState, targetSha256: t.targetSha256 })),
  }
  const planHash = sha256Text(JSON.stringify(planInput))
  const plan = {
    mode,
    conflict,
    wouldRestore: wouldCreate + wouldOverwrite,
    wouldCreate,
    wouldOverwrite,
    wouldSkip,
    conflicts,
    missing: inspected.missing.slice(),
    unexpected: inspected.unexpected.slice(),
    preRestoreBackupPlanned: wouldCreate + wouldOverwrite > 0,
  }
  return { plan, planHash, planInput }
}

function restoreError(code, message, extra = {}) {
  return backupError(code, message, extra)
}

/** 只读列出当前项目导出/backup-* 备份。 */
export async function listBackups(root, title, options = {}) {
  const limit = options.limit === undefined ? 50 : Number(options.limit)
  const offset = options.offset === undefined ? 0 : Number(options.offset)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw backupError('invalid-args', 'limit 必须是 1..100 的整数')
  if (!Number.isInteger(offset) || offset < 0) throw backupError('invalid-args', 'offset 必须是非负整数')
  const { real } = await assertProjectDir(root, title)
  const exportAbs = path.join(real, '导出')
  const exportStat = await fs.lstat(exportAbs).catch(() => null)
  if (!exportStat || exportStat.isSymbolicLink() || !exportStat.isDirectory()) return { backups: [], total: 0, truncated: false }
  const names = (await fs.readdir(exportAbs, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^backup-[A-Za-z0-9._-]+$/.test(entry.name))
    .map((entry) => entry.name)
  const rows = []
  for (const name of names) {
    const abs = path.join(exportAbs, name)
    let row = { backupDir: name, createdAt: null, projectTitle: '', schemaVersion: null, fileCount: 0, mediaFileCount: 0, totalBytes: 0, manifestSha256: null, corrupt: false }
    try {
      const stat = await fs.lstat(abs)
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue
      const text = await fs.readFile(path.join(abs, BACKUP_MANIFEST_FILE), 'utf8')
      const manifest = JSON.parse(text)
      validateManifest(manifest)
      row = {
        ...row,
        createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null,
        projectTitle: manifest.project && typeof manifest.project.title === 'string' ? manifest.project.title : '',
        schemaVersion: manifest.schemaVersion,
        fileCount: manifest.files.length,
        mediaFileCount: manifest.files.filter((item) => item.role === 'media').length,
        totalBytes: manifest.files.reduce((sum, item) => sum + item.bytes, 0),
        manifestSha256: sha256Text(text),
      }
    } catch { row.corrupt = true }
    rows.push(row)
  }
  rows.sort((a, b) => String(b.createdAt || b.backupDir).localeCompare(String(a.createdAt || a.backupDir)))
  const total = rows.length
  return { backups: rows.slice(offset, offset + limit), total, truncated: offset + limit < total }
}

const SUMMARY_MAX_BYTES = 8 * 1024 * 1024
const SUMMARY_MAX_OBJECTS = 5000

function parseSummaryState(buffer) {
  if (!buffer) return { present: false, parseable: false, truncated: false, value: null }
  if (buffer.length > SUMMARY_MAX_BYTES) return { present: true, parseable: false, truncated: true, value: null }
  try {
    const value = JSON.parse(buffer.toString('utf8'))
    if (value === null || typeof value !== 'object') return { present: true, parseable: false, truncated: false, value: null }
    return { present: true, parseable: true, truncated: false, value }
  } catch {
    return { present: true, parseable: false, truncated: false, value: null }
  }
}

function summaryArray(parsed, keys) {
  if (!parsed.parseable) return null
  const value = parsed.value
  if (Array.isArray(value)) return value
  for (const key of keys) if (value && Array.isArray(value[key])) return value[key]
  return null
}

function summaryItemKey(item, index) {
  if (item && typeof item === 'object') {
    if (typeof item.id === 'string' || typeof item.id === 'number') return `id:${String(item.id)}`
    if (typeof item.name === 'string') return `name:${item.name}`
  }
  return `idx:${index}`
}

function summaryObjectDiff(backupArray, currentArray) {
  if (!Array.isArray(backupArray) || !Array.isArray(currentArray)) return null
  const backup = new Map(backupArray.slice(0, SUMMARY_MAX_OBJECTS).map((item, index) => [summaryItemKey(item, index), JSON.stringify(item)]))
  const current = new Map(currentArray.slice(0, SUMMARY_MAX_OBJECTS).map((item, index) => [summaryItemKey(item, index), JSON.stringify(item)]))
  let added = 0
  let removed = 0
  let changed = 0
  for (const [key, value] of backup) {
    if (!current.has(key)) added += 1
    else if (current.get(key) !== value) changed += 1
  }
  for (const key of current.keys()) if (!backup.has(key)) removed += 1
  return { added, removed, changed }
}

function summaryCardObject(backupParsed, currentParsed, keys, byType) {
  const backupArray = summaryArray(backupParsed, keys)
  const currentArray = summaryArray(currentParsed, keys)
  const backup = { present: backupParsed.present, parseable: backupParsed.parseable, total: backupArray ? backupArray.length : null }
  const current = { present: currentParsed.present, parseable: currentParsed.parseable, total: currentArray ? currentArray.length : null }
  if (byType && backupArray) {
    const counts = {}
    for (const item of backupArray.slice(0, SUMMARY_MAX_OBJECTS)) {
      const type = item && typeof item.type === 'string' && item.type.trim() ? item.type.trim().slice(0, 40) : 'OTHER'
      counts[type] = (counts[type] || 0) + 1
    }
    backup.byType = counts
  }
  if (byType && currentArray) {
    const counts = {}
    for (const item of currentArray.slice(0, SUMMARY_MAX_OBJECTS)) {
      const type = item && typeof item.type === 'string' && item.type.trim() ? item.type.trim().slice(0, 40) : 'OTHER'
      counts[type] = (counts[type] || 0) + 1
    }
    current.byType = counts
  }
  const diff = summaryObjectDiff(backupArray, currentArray)
  const truncated = Boolean((backupArray && backupArray.length > SUMMARY_MAX_OBJECTS) || (currentArray && currentArray.length > SUMMARY_MAX_OBJECTS) || backupParsed.truncated || currentParsed.truncated)
  return { backup, current, ...(diff ? { diff } : {}), truncated }
}

function summaryListObject(backupParsed, currentParsed, keys) {
  const backupArray = summaryArray(backupParsed, keys)
  const currentArray = summaryArray(currentParsed, keys)
  const backup = { present: backupParsed.present, parseable: backupParsed.parseable, total: backupArray ? backupArray.length : null }
  const current = { present: currentParsed.present, parseable: currentParsed.parseable, total: currentArray ? currentArray.length : null }
  const diff = summaryObjectDiff(backupArray, currentArray)
  const truncated = Boolean((backupArray && backupArray.length > SUMMARY_MAX_OBJECTS) || (currentArray && currentArray.length > SUMMARY_MAX_OBJECTS) || backupParsed.truncated || currentParsed.truncated)
  return { backup, current, ...(diff ? { diff } : {}), truncated }
}

function summaryFlowState(backupParsed, currentParsed) {
  const countSteps = (parsed) => parsed.parseable && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) && parsed.value.steps && typeof parsed.value.steps === 'object' && !Array.isArray(parsed.value.steps)
    ? Object.keys(parsed.value.steps).length
    : null
  const backup = { present: backupParsed.present, parseable: backupParsed.parseable, steps: countSteps(backupParsed) }
  const current = { present: currentParsed.present, parseable: currentParsed.parseable, steps: countSteps(currentParsed) }
  const changed = backupParsed.parseable && currentParsed.parseable
    ? JSON.stringify(backupParsed.value) !== JSON.stringify(currentParsed.value)
    : null
  const truncated = Boolean(backupParsed.truncated || currentParsed.truncated)
  return { backup, current, ...(changed === null ? {} : { changed }), truncated }
}

async function restoreSummaryIfEnabled(inspected, options) {
  const enabled = options.summary === true || options.includeSummary === true
  if (!enabled) return null
  const readSource = async (source) => {
    try {
      const abs = path.join(inspected.real, ...source.split('/'))
      const stat = await fs.lstat(abs).catch(() => null)
      if (!stat || stat.isSymbolicLink() || !stat.isFile()) return null
      return await fs.readFile(abs)
    } catch { return null }
  }
  const current = new Map()
  for (const source of ['.aidrama/assets/cards.json', '.aidrama/scenes/cards.json', '.aidrama/import-history.json', '.aidrama/import-templates.json', '.aidrama/flow-state.json']) {
    current.set(source, await readSource(source))
  }
  const backupBuffer = (source) => inspected.buffers.get(`state/${source}`) || null
  const assetCards = summaryCardObject(parseSummaryState(backupBuffer('.aidrama/assets/cards.json')), parseSummaryState(current.get('.aidrama/assets/cards.json')), ['assets', 'cards'], true)
  const sceneCards = summaryCardObject(parseSummaryState(backupBuffer('.aidrama/scenes/cards.json')), parseSummaryState(current.get('.aidrama/scenes/cards.json')), ['scenes', 'cards'], false)
  const history = summaryListObject(parseSummaryState(backupBuffer('.aidrama/import-history.json')), parseSummaryState(current.get('.aidrama/import-history.json')), ['history', 'entries'])
  const templates = summaryListObject(parseSummaryState(backupBuffer('.aidrama/import-templates.json')), parseSummaryState(current.get('.aidrama/import-templates.json')), ['templates'])
  const flowState = summaryFlowState(parseSummaryState(backupBuffer('.aidrama/flow-state.json')), parseSummaryState(current.get('.aidrama/flow-state.json')))
  return { version: 1, mode: 'state', objects: { assetCards, sceneCards, history, templates, flowState } }
}

/** 只读恢复预检 + planHash。 */
export async function previewRestore(root, title, options = {}) {
  if (options.includeMedia === true) throw restoreError('media-restore-not-enabled', '媒体恢复未开放（2b）')
  const conflict = options.conflict === undefined ? 'abort' : String(options.conflict)
  if (!RESTORE_CONFLICTS.includes(conflict)) throw backupError('invalid-args', `conflict 必须是 ${RESTORE_CONFLICTS.join('/')}`)
  const inspected = await inspectBackup(root, title, options.backupDir)
  const built = buildPlan(inspected, { conflict })
  const summary = await restoreSummaryIfEnabled(inspected, options)
  return {
    ok: true,
    backupAction: 'preview',
    dryRun: true,
    backupDir: inspected.name,
    manifestSha256: inspected.manifestSha256,
    planHash: built.planHash,
    plan: built.plan,
    files: { count: inspected.stateEntries.length, mediaCount: inspected.mediaEntries.length, totalBytes: inspected.stateEntries.reduce((sum, item) => sum + item.bytes, 0) },
    ...(summary ? { summary } : {}),
  }
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** 执行恢复（state-only）。内部 txn；失败逐项回滚。 */
export async function restoreBackup(root, title, options = {}) {
  const dryRun = options.dryRun === undefined ? true : options.dryRun
  if (typeof dryRun !== 'boolean') throw backupError('invalid-args', 'dryRun 必须是布尔值')
  if (options.includeMedia === true) throw restoreError('media-restore-not-enabled', 'media 恢复未开放（2b）')
  const conflict = options.conflict === undefined ? 'abort' : String(options.conflict)
  if (!RESTORE_CONFLICTS.includes(conflict)) throw backupError('invalid-args', `conflict 必须是 ${RESTORE_CONFLICTS.join('/')}`)
  const confirmed = options.confirm === true
  if ((conflict === 'overwrite' || conflict === 'skip') && !confirmed) throw backupError('invalid-args', `${conflict} 需要 confirm:true`)
  const inspected = await inspectBackup(root, title, options.backupDir)
  const built = buildPlan(inspected, { conflict })
  if (dryRun) {
    const summary = await restoreSummaryIfEnabled(inspected, options)
    return {
      ok: true, backupAction: 'preview', dryRun: true, backupDir: inspected.name,
      manifestSha256: inspected.manifestSha256, planHash: built.planHash, plan: built.plan,
      files: { count: inspected.stateEntries.length, mediaCount: inspected.mediaEntries.length, totalBytes: inspected.stateEntries.reduce((sum, item) => sum + item.bytes, 0) },
      ...(summary ? { summary } : {}),
      rolledBack: false, preRestoreBackup: null,
    }
  }
  if (options.expectedPlanHash !== built.planHash) {
    const error = backupError('plan-stale', '恢复计划已过期（计划与当前状态不一致），请重新 preview')
    error.currentPlanHash = built.planHash
    throw error
  }
  if (inspected.missing.length || inspected.unexpected.length) {
    throw restoreError('conflict', '备份文件缺失或存在多余文件，拒绝恢复', { missing: inspected.missing, unexpected: inspected.unexpected })
  }
  if (conflict === 'abort' && built.plan.conflicts.length) {
    throw restoreError('restore-conflict', '目标文件已被修改，abort 策略拒绝恢复', { conflicts: built.plan.conflicts })
  }
  const writeTargets = inspected.targets.filter((target) => {
    if (target.targetState === 'same') return false
    if (conflict === 'skip' && target.targetState === 'different') return false
    return true
  })
  if (!writeTargets.length) {
    return {
      ok: true, backupAction: 'restore', dryRun: false, backupDir: inspected.name, manifestSha256: inspected.manifestSha256,
      planHash: built.planHash, plan: built.plan, restored: 0, skipped: inspected.targets.length,
      conflicts: built.plan.conflicts, preRestoreBackup: null, rolledBack: false, auditAction: RESTORE_ACTION,
    }
  }
  const preBackup = await createBackup(root, title, { includeMedia: false })
  if (!preBackup || preBackup.dryRun) throw backupError('failed', '恢复前备份失败')
  const preRestoreBackup = preBackup.backup.relative
  const stamp = backupTimestamp()
  const stageRel = `.aidrama/restore-stage-${stamp}`
  const rollbackRel = `.aidrama/restore-rollback-${stamp}`
  const details = {
    backupDir: inspected.name,
    planHash: built.planHash,
    preRestoreBackup,
    conflict,
    dryRun: false,
    restoreCounts: { ...built.plan },
    rolledBack: false,
  }
  try {
    const result = await txn.runProjectTxn(root, title, {
      action: RESTORE_ACTION,
      targets: writeTargets.map((target) => target.source),
      actor: 'panel',
      operationId: options.operationId,
      details,
    }, async () => {
      await store.guardedProjectMkdir(inspected.real, stageRel)
      await store.guardedProjectMkdir(inspected.real, rollbackRel)
      const snapshots = []
      let applied = []
      try {
        for (const target of writeTargets) {
          const buffer = inspected.buffers.get(target.path)
          if (!buffer) throw backupError('failed', `备份文件不可读：${target.path}`)
          await store.guardedProjectWriteBinary(inspected.real, `${stageRel}/${target.source}`, buffer)
          const current = await fs.lstat(path.join(inspected.real, ...target.source.split('/'))).catch(() => null)
          if (current) {
            if (current.isSymbolicLink() || !current.isFile()) throw backupError('forbidden', `恢复目标是符号链接/非普通文件：${target.source}`)
            const old = await fs.readFile(path.join(inspected.real, ...target.source.split('/')))
            await store.guardedProjectWriteBinary(inspected.real, `${rollbackRel}/${target.source}`, old)
            snapshots.push({ source: target.source, existed: true, buffer: old })
          } else {
            snapshots.push({ source: target.source, existed: false })
          }
        }
        for (const target of writeTargets) {
          const buffer = inspected.buffers.get(target.path)
          await store.guardedProjectWriteBinary(inspected.real, target.source, buffer)
          applied.push(target.source)
        }
        await store.guardedProjectRemove(inspected.real, stageRel).catch(() => {})
        await store.guardedProjectRemove(inspected.real, rollbackRel).catch(() => {})
        return { restored: writeTargets.length, skipped: inspected.targets.length - writeTargets.length, conflicts: built.plan.conflicts }
      } catch (error) {
        let rolledBack = true
        for (const snapshot of snapshots) {
          try {
            if (snapshot.existed) {
              await store.guardedProjectWriteBinary(inspected.real, snapshot.source, snapshot.buffer)
            } else if (applied.includes(snapshot.source)) {
              await store.guardedProjectRemove(inspected.real, snapshot.source)
            }
          } catch { rolledBack = false }
        }
        await store.guardedProjectRemove(inspected.real, stageRel).catch(() => {})
        await store.guardedProjectRemove(inspected.real, rollbackRel).catch(() => {})
        details.rolledBack = rolledBack
        error.rolledBack = rolledBack
        error.preRestoreBackup = preRestoreBackup
        throw error
      }
    })
    return {
      ok: true, backupAction: 'restore', dryRun: false, backupDir: inspected.name,
      manifestSha256: inspected.manifestSha256, planHash: built.planHash,
      restored: result.restored, skipped: result.skipped, conflicts: result.conflicts,
      preRestoreBackup, rolledBack: false, auditAction: RESTORE_ACTION,
    }
  } catch (error) {
    if (error && error.rolledBack === undefined) {
      error.rolledBack = details.rolledBack
      error.preRestoreBackup = error.preRestoreBackup || preRestoreBackup
    }
    throw error
  }
}

