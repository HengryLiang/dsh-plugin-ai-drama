/**
 * v0.15.11（task-134 / IMP-H，E13 add-only）：一键导入素材 `assets-import` 的宿主实现。
 *
 * 契约（Lead 已批）：
 * - 入参 `{ title?, fileName, base64, targetCategory?, expectedSha256?, maxBytes? }`；
 * - fileName 仅 basename + 扩展名白名单（image/audio/video/doc 并集）；分类白名单 11 类，
 *   缺省 `导入_YYYYMMDD`；写入 `素材/<分类>/<fileName>`（分类目录不存在则创建）；
 * - 同名不覆盖：`name (2).ext`、`(3)`…；base64 严格校验（标准字符/4 倍数/末尾 `=`）；
 *   解码 ≤ min(maxBytes,50MB)（50MB 边界允许，+1 拒绝）；
 * - expectedSha256 不匹配 → invalid-args；SHA256 去重命中 → conflict + duplicate:true 不写；
 * - 写前 statfs 磁盘检查（不可用仅警告继续）；tmp→rename 原子写（失败清理）；
 *   写入后自动登记（登记失败删文件回滚）；
 * - 错误不泄漏绝对路径；只写项目内；无依赖；METHODS 69→70（工具面保持 34）。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import * as assetCards from './assets.js'
import * as names from './names.js'
import * as scenes from './scenes.js'
import * as store from './store.js'
import * as styleDna from './style-dna.js'

/** 单文件上限 50MB。 */
export const IMPORT_MAX_BYTES = 50 * 1024 * 1024
/** 磁盘检查保留余量（16MB）。 */
const DISK_MARGIN_BYTES = 16 * 1024 * 1024
/** 允许的素材扩展名（image/audio/video/doc 并集；小写带点）。 */
export const IMPORT_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.mp3', '.wav', '.m4a', '.ogg', '.aac',
  '.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v',
  '.md', '.txt', '.json', '.pdf', '.doc', '.docx', '.csv',
])
/** 分类白名单（缺省导入_YYYYMMDD）。 */
/** 分类白名单（缺省导入_YYYYMMDD；v0.16.1 追加「生成」→ 素材/生成/，供产物本地导入默认分类）。 */
export const IMPORT_CATEGORIES = ['角色', '场景', '道具', '服装', '表情', '特效', '音效', '配音', '音乐', '分镜', '其他', '生成']
/** 文件名长度上限。 */
export const IMPORT_FILE_NAME_MAX = 120
/** 同名自动编号上限。 */
const MAX_RENAME_ATTEMPTS = 500
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

function importError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

function defaultCategory() {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  return `导入_${stamp}`
}

/** 文件名校验（仅 basename；扩展名白名单；≤120；禁控制字符/保留名/隐藏名/素材清单.md/编码 traversal）。 */
export function assertImportFileName(fileName) {
  if (typeof fileName !== 'string') throw importError('invalid-args', 'fileName 必须是字符串')
  const value = fileName.trim()
  if (!value) throw importError('invalid-args', 'fileName 不能为空')
  if (value.length > IMPORT_FILE_NAME_MAX) throw importError('invalid-args', `fileName 过长（上限 ${IMPORT_FILE_NAME_MAX} 字符）`)
  if (/[\u0000-\u001f\u007f]/.test(value)) throw importError('invalid-args', 'fileName 含控制字符')
  if (/[\\/:*?"<>|]/.test(value)) throw importError('invalid-args', 'fileName 必须是纯文件名（不能包含路径分隔符等字符）')
  if (value.startsWith('.')) throw importError('invalid-args', 'fileName 不能以点开头（隐藏文件不参与素材扫描）')
  if (/[. ]$/.test(value)) throw importError('invalid-args', 'fileName 不能以点或空格结尾')
  if (value.toLowerCase() === '.aidrama') throw importError('forbidden', 'fileName 不能使用内部数据目录名')
  if (value.toLowerCase() === '素材清单.md') throw importError('invalid-args', '该文件名被系统生成文件保留')
  if (WINDOWS_RESERVED.test(value.split('.')[0])) throw importError('invalid-args', 'fileName 不能使用系统保留名')
  if (names.hasEncodedPathTraversal(value)) throw importError('invalid-args', 'fileName 包含编码后的非法字符')
  const extension = path.extname(value).toLowerCase()
  if (!IMPORT_EXTENSIONS.has(extension)) {
    throw importError('invalid-args', '不支持的素材类型（扩展名白名单：图片/音频/视频/文档）')
  }
  return value
}

function assertCategory(targetCategory) {
  if (targetCategory == null) return defaultCategory()
  if (typeof targetCategory !== 'string') throw importError('invalid-args', 'targetCategory 必须是字符串')
  const value = targetCategory.trim()
  if (!value) throw importError('invalid-args', 'targetCategory 不能为空')
  if (!IMPORT_CATEGORIES.includes(value)) throw importError('invalid-args', `targetCategory 不支持（仅限：${IMPORT_CATEGORIES.join('/')}）`)
  return value
}

function assertBase64(base64) {
  if (typeof base64 !== 'string') throw importError('invalid-args', 'base64 必须是字符串')
  if (!base64) throw importError('invalid-args', 'base64 不能为空')
  if (base64.length % 4 !== 0) throw importError('invalid-args', 'base64 长度必须是 4 的倍数')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw importError('invalid-args', 'base64 含非法字符（仅支持标准 base64）')
  return base64
}

function resolveLimit(input) {
  if (input.maxBytes == null) return IMPORT_MAX_BYTES
  const value = Number(input.maxBytes)
  if (!Number.isInteger(value) || value < 1 || value > IMPORT_MAX_BYTES) {
    throw importError('invalid-args', `maxBytes 必须是 1..${IMPORT_MAX_BYTES} 的整数`)
  }
  return value
}

function assertExpectedSha(expectedSha256) {
  if (expectedSha256 == null) return null
  if (typeof expectedSha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(expectedSha256.trim())) {
    throw importError('invalid-args', 'expectedSha256 必须是 64 位十六进制字符串')
  }
  return expectedSha256.trim().toLowerCase()
}

/** 解析目标项目：title 显式优先；缺省时工作区仅 1 个项目才自动选用。 */
async function resolveProjectTitle(root, title) {
  if (typeof title === 'string' && title.trim()) return names.assertSafeTitle(title.trim())
  const projects = await store.listProjects(root)
  if (projects.length === 1) return projects[0].title
  throw importError('invalid-args', projects.length ? '工作区有多个短剧项目，请指定 title' : '工作区没有短剧项目，请先创建项目')
}

/** 写前磁盘空间检查：statfs 不可用 → 仅警告继续；空间不足 → failed（400）。 */
async function assertDiskSpace(dir, bytes) {
  let stats
  try {
    stats = await fs.statfs(dir)
  } catch {
    return
  }
  try {
    const free = Number(stats.bavail) * Number(stats.bsize)
    if (Number.isFinite(free) && free < bytes + DISK_MARGIN_BYTES) {
      throw importError('failed', '磁盘剩余空间不足')
    }
  } catch (error) {
    if (error && error.code === 'failed') throw error
  }
}

function existingShaSet(assets) {
  const set = new Set()
  for (const asset of Array.isArray(assets) ? assets : []) {
    if (asset && typeof asset.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(asset.sha256)) set.add(asset.sha256.toLowerCase())
  }
  return set
}

/* ======================================================================
 * v0.16.7（task-144 / C2-H，E13 add-only）：跨项目复制 source 模式
 * - 入参 `{ title?, sourceProjectId, sourceAssetIds[], targetCategory? }`（与 base64/fileName 互斥）；
 * - sourceProjectId = 源项目 title，host 在「受管项目根」集合内解析 `<root>/AI短剧/<safeTitle>`；
 * - 源项目只读（仅 getAssets + stat/readFile），逐项复制到目标 `素材/<分类>/` + 自动登记；
 * - SHA 去重 → skipped duplicate（200 聚合，不 409）；同名 `(2)`；单文件 ≤50MB；逐项 imported/skipped/failed；
 * - 目标 txn/审计沿用 assets-import；note 写 `来源=<源项目名>` + add-only `importedFrom` 溯源（含 root 序号/类型，不落绝对路径）。
 * ====================================================================== */

function sourceHasInternalSegment(relativePath) {
  return String(relativePath == null ? '' : relativePath)
    .split(/[\\/]+/)
    .some((segment) => segment.trim().toLowerCase() === '.aidrama')
}

function sourcePathInside(root, target) {
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const normalizedTarget = process.platform === 'win32' ? target.toLowerCase() : target
  const relative = path.relative(normalizedRoot, normalizedTarget)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** 规范化受管项目根：realpath + 大小写不敏感去重 + 仅保留存在目录 + 稳定排序 + 上限 20。 */
async function normalizeManagedRoots(rawRoots, fallbackRoot) {
  const input = Array.isArray(rawRoots) && rawRoots.length ? rawRoots : [{ path: fallbackRoot, sourceType: 'current' }]
  const seen = new Set()
  const roots = []
  for (const item of input) {
    if (roots.length >= 20) break
    const rawPath = typeof item === 'string' ? item : (item && typeof item.path === 'string' ? item.path : '')
    const sourceType = typeof item === 'object' && item && typeof item.sourceType === 'string' ? item.sourceType : 'workspace'
    if (!rawPath || !path.isAbsolute(rawPath)) continue
    let real
    try {
      real = await fs.realpath(rawPath)
    } catch {
      continue
    }
    if (!(await store.isDirectory(real))) continue
    const key = process.platform === 'win32' ? real.toLowerCase() : real
    if (seen.has(key)) continue
    seen.add(key)
    roots.push({ path: real, sourceType })
  }
  roots.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return roots.slice(0, 20)
}

function assertSourceProjectTitle(sourceProjectId) {
  if (typeof sourceProjectId !== 'string') throw importError('invalid-args', 'sourceProjectId 必须是源项目名称（title）')
  try {
    return names.assertSafeTitle(sourceProjectId.trim())
  } catch {
    throw importError('invalid-args', 'sourceProjectId 不合法（必须是受管根内项目名称）')
  }
}

function assertSourceAssetIds(sourceAssetIds) {
  if (!Array.isArray(sourceAssetIds)) throw importError('invalid-args', 'sourceAssetIds 必须是数组')
  if (!sourceAssetIds.length) throw importError('invalid-args', 'sourceAssetIds 不能为空')
  const unique = []
  for (const item of sourceAssetIds) {
    if (typeof item !== 'string' || !item.trim()) throw importError('invalid-args', 'sourceAssetIds 元素必须是非空字符串')
    const value = item.trim()
    if (value.length > 120) throw importError('invalid-args', 'sourceAssetIds 元素过长（上限 120 字符）')
    if (/[\u0000-\u001f\u007f]/.test(value)) throw importError('invalid-args', 'sourceAssetIds 元素含控制字符')
    if (!unique.includes(value)) unique.push(value)
  }
  if (unique.length > 100) throw importError('invalid-args', '单次最多导入 100 个源素材')
  return unique
}

/** 校验源项目目录：`<root>/AI短剧/<title>`，逐组件 lstat 禁 symlink/junction；返回 canonical 目录。 */
async function resolveSourceProject(managedRoots, sourceTitle, targetProjectDir) {
  const candidates = []
  const targetReal = await fs.realpath(targetProjectDir).catch(() => targetProjectDir)
  for (const [rootIndex, entry] of managedRoots.entries()) {
    const base = store.projectsBase(entry.path)
    const candidate = path.join(base, sourceTitle)
    if (!(await store.isDirectory(candidate).catch(() => false))) continue
    // 逐组件 lstat（AI短剧/<title>）禁符号链接/junction
    let probe = entry.path
    let linked = false
    for (const segment of ['AI短剧', sourceTitle]) {
      probe = path.join(probe, segment)
      const stat = await fs.lstat(probe).catch(() => null)
      if (!stat || stat.isSymbolicLink()) {
        linked = true
        break
      }
    }
    if (linked) continue
    let realDir
    try {
      realDir = await fs.realpath(candidate)
    } catch {
      continue
    }
    if (!sourcePathInside(entry.path, realDir)) continue
    candidates.push({ rootIndex, root: entry.path, sourceType: entry.sourceType, sourceDir: candidate, realDir })
  }
  if (!candidates.length) throw importError('not-found', '源项目不存在或不在受管项目根内')
  if (candidates.length > 1) throw importError('invalid-args', '多个工作区存在同名项目，暂不支持跨工作区同名源项目')
  const picked = candidates[0]
  if (process.platform === 'win32' ? picked.realDir.toLowerCase() === targetReal.toLowerCase() : picked.realDir === targetReal) {
    throw importError('invalid-args', '源项目不能是当前目标项目')
  }
  return picked
}

/** 源 asset 记录 → 项目内真实文件（只读；项目外/历史外部/.aidrama/symlink 逃逸 → 拒绝且不读取）。 */
async function resolveSourceAssetFile(sourceProject, entry) {
  if (!entry || typeof entry.source !== 'string' || !entry.source.trim()) return { code: 'invalid-args', reason: '源素材缺少文件路径' }
  const raw = entry.source.trim()
  const isDriveAbsolute = /^[A-Za-z]:[\\/]/.test(raw)
  if (/^[\\/]{2}/.test(raw)) return { code: 'forbidden', reason: '源素材路径不可读取' }
  if (!isDriveAbsolute && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return { code: 'forbidden', reason: '源素材路径不可读取' }
  const candidate = isDriveAbsolute ? path.resolve(raw) : path.resolve(sourceProject.realDir, raw)
  let realFile
  try {
    realFile = await fs.realpath(candidate)
  } catch {
    return { code: 'not-found', reason: '源素材文件不存在' }
  }
  if (!sourcePathInside(sourceProject.realDir, realFile)) {
    return { code: 'forbidden', reason: '源素材不在源项目内（历史外部路径不支持）' }
  }
  const relative = path.relative(sourceProject.realDir, realFile)
  if (sourceHasInternalSegment(relative)) return { code: 'forbidden', reason: '源素材路径不可读取' }
  // 逐组件 lstat 拒绝符号链接/junction（含最终文件）
  let probe = sourceProject.realDir
  for (const segment of relative.split(path.sep)) {
    probe = path.join(probe, segment)
    const stat = await fs.lstat(probe).catch(() => null)
    if (!stat) return { code: 'not-found', reason: '源素材文件不存在' }
    if (stat.isSymbolicLink()) return { code: 'forbidden', reason: '源素材路径包含符号链接' }
  }
  let stat
  try {
    stat = await fs.stat(realFile)
  } catch {
    return { code: 'not-found', reason: '源素材文件不存在' }
  }
  if (!stat.isFile()) return { code: 'invalid-args', reason: '源素材不是普通文件' }
  if (stat.size > IMPORT_MAX_BYTES) return { code: 'too-large', reason: '源素材超过 50MB 上限' }
  const extension = path.extname(realFile).toLowerCase()
  if (!IMPORT_EXTENSIONS.has(extension)) return { code: 'invalid-args', reason: '源素材类型不在白名单' }
  let fileName
  try {
    fileName = assertImportFileName(path.basename(realFile))
  } catch {
    return { code: 'invalid-args', reason: '源素材文件名不合法' }
  }
  return { realFile, stat, fileName }
}

/** 从源文件项目内相对路径推导分类（素材/<分类>/... 且分类在白名单）；否则返回 null。 */
function deriveSourceCategory(sourceProjectRealDir, realFile) {
  const relative = path.relative(sourceProjectRealDir, realFile).split(path.sep)
  if (relative.length >= 3 && relative[0] === '素材' && IMPORT_CATEGORIES.includes(relative[1])) return relative[1]
  return null
}

/**
 * 把 buffer 写入目标项目 `素材/<分类>/<fileName>` 并自动登记（base64 与 source 模式共用）。
 * 行为与 v0.15.11 base64 路径完全一致（同名 (2)、statfs、tmp→rename、失败删文件回滚）。
 */
async function writeImportedBuffer({ root, title, projectDir, category, fileName, buffer, sha256, note, kind }) {
  const categoryDir = path.join(projectDir, '素材', category)
  const extension = path.extname(fileName)
  const stem = fileName.slice(0, fileName.length - extension.length)
  let targetFileName = fileName
  let targetPath = await store.assertProjectWriteTarget(projectDir, `素材/${category}/${targetFileName}`)
  for (let index = 2; index <= MAX_RENAME_ATTEMPTS; index += 1) {
    if (!(await fs.stat(targetPath).then(() => true, () => false))) break
    targetFileName = `${stem} (${index})${extension}`
    targetPath = await store.assertProjectWriteTarget(projectDir, `素材/${category}/${targetFileName}`)
    if (index === MAX_RENAME_ATTEMPTS) throw importError('failed', '同名文件过多，请重命名后重试')
  }
  await assertDiskSpace(projectDir, buffer.length)
  await fs.mkdir(categoryDir, { recursive: true })
  const tmpPath = path.join(categoryDir, `.ai-drama-import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`)
  let written = false
  try {
    await fs.writeFile(tmpPath, buffer)
    await fs.rename(tmpPath, targetPath)
    written = true
  } catch {
    await fs.rm(tmpPath, { force: true }).catch(() => {})
    throw importError('failed', '写入素材文件失败')
  }
  let asset
  try {
    asset = await store.addAsset(root, title, {
      source: targetPath,
      name: fileName,
      note,
      ...(kind ? { kind } : {}),
    }, { sha256 })
  } catch (error) {
    if (written) await fs.rm(targetPath, { force: true }).catch(() => {})
    const code = error && error.code === 'invalid-args' ? 'invalid-args' : 'failed'
    throw importError(code, '素材登记失败，已回滚删除写入文件')
  }
  const relativePath = path.relative(await fs.realpath(projectDir), targetPath).split(path.sep).join('/')
  return { asset, targetFileName, targetPath, relativePath, category }
}

/** 目标 assets.json 追加 add-only importedFrom 溯源（root 序号/类型，无绝对路径；失败不影响主结果）。 */
async function patchImportedFrom(targetRoot, targetTitle, assetId, provenance) {
  try {
    const assets = await store.getAssets(targetRoot, targetTitle)
    const index = (Array.isArray(assets) ? assets : []).findIndex((asset) => asset && asset.id === assetId)
    if (index < 0) return
    assets[index] = { ...assets[index], importedFrom: provenance }
    await store.guardedMetaWrite(store.projectDir(targetRoot, targetTitle), 'assets.json', `${JSON.stringify(assets, null, 2)}\n`)
  } catch {
    /* 溯源失败不影响已登记资产 */
  }
}

/** source 模式（跨项目复制）：200 聚合逐项 imported/skipped/failed；请求级非法才抛 4xx。 */
/* ======================================================================
 * v0.16.8（task-151 / I5-1）：跨项目资产卡 / 场景卡 / 风格 DNA 复制（source 模式 add-only）
 * - 卡片：字段完整复制（version/history 不复制，新卡 v1/history []）、媒体复制+登记（可关）、
 *   ID 冲突（同内容 skipped duplicate；不同内容默认 skipped id-exists；allowNewIdSuffix=true 才分配
 *   同前缀下一个空闲基础编号 + idMap）、引用重写（variantOf/relations 恰为 id / {{Asset_…}} 占位符）、
 *   卡片写入失败逐卡回滚其新增媒体文件与 registry 条目；
 * - 场景卡：同规则（assetRefs 同批重写/悬空丢弃+warning）；
 * - 风格：只复制五维草稿（绝不写 state/revision/unfreezeHistory）；目标无 style → 新建无 state；
 *   目标已有默认 fill-empty、overwriteStyle 才覆盖；目标 directed/frozen → failed style-directed/style-locked 不写；
 * - 响应嵌套 cards/scenes/style + 顶层 warnings[]（仅请求对应字段出现；asset-only 响应不变）。
 * ====================================================================== */

const SOURCE_CARD_MAX = 100
const SOURCE_SCENE_MAX = 100
const SOURCE_MEDIA_MAX = 300

function assertSourceIds(value, label, max) {
  if (value === undefined) return null
  if (!Array.isArray(value)) throw importError('invalid-args', `${label} 必须是数组`)
  if (!value.length) throw importError('invalid-args', `${label} 不能为空数组`)
  const unique = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) throw importError('invalid-args', `${label} 元素必须是非空字符串`)
    const text = item.trim()
    if (text.length > 120) throw importError('invalid-args', `${label} 元素过长（上限 120 字符）`)
    if (/[\u0000-\u001f\u007f]/.test(text)) throw importError('invalid-args', `${label} 元素含控制字符`)
    if (!unique.includes(text)) unique.push(text)
  }
  if (unique.length > max) throw importError('invalid-args', `${label} 单次最多 ${max} 项`)
  return unique
}

function assertSourceBoolean(value, label) {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw importError('invalid-args', `${label} 必须是布尔值`)
  return value
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** 同前缀下一个「空闲」基础编号（001 起；被 target/本批计划占用则跳过）。 */
function nextFreeBaseId(existingIds, prefix) {
  const used = new Set((Array.isArray(existingIds) ? existingIds : []).map((id) => assetCards.normalizeAssetId(id)))
  for (let sequence = 1; sequence <= 999; sequence += 1) {
    const candidate = `${prefix}${String(sequence).padStart(3, '0')}`
    if (!used.has(candidate)) return candidate
  }
  return null
}

/** 场景卡下一个空闲编号（SPC001 起）。 */
function nextFreeSceneId(existingIds) {
  const used = new Set((Array.isArray(existingIds) ? existingIds : []).map((id) => scenes.normalizeSceneId(id)))
  for (let sequence = 1; sequence <= 999; sequence += 1) {
    const candidate = `SPC${String(sequence).padStart(3, '0')}`
    if (!used.has(candidate)) return candidate
  }
  return null
}

/** 卡片业务内容哈希（排除 version/history/importedFrom；用于同 id 同内容判重）。 */
function cardContentHash(card) {
  const normalized = assetCards.normalizeAssetCard(card)
  delete normalized.version
  delete normalized.history
  delete normalized.importedFrom
  return hashJson(normalized)
}

/** 场景卡内容哈希（排除 importedFrom）。 */
function sceneContentHash(card) {
  const normalized = scenes.normalizeSceneCard(card)
  delete normalized.importedFrom
  return hashJson(normalized)
}

function isHttpMediaRef(value) {
  const text = String(value == null ? '' : value).trim()
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 目标 registry asset 的 source → 目标项目内相对路径；不在目标项目内返回 null。 */
async function targetRelativeForAsset(targetRealDir, asset) {
  if (!asset || typeof asset.source !== 'string' || !asset.source.trim()) return null
  let real
  try {
    real = await fs.realpath(asset.source.trim())
  } catch {
    return null
  }
  if (!sourcePathInside(targetRealDir, real)) return null
  const relative = path.relative(targetRealDir, real).split(path.sep).join('/')
  if (!relative || relative.startsWith('..')) return null
  return relative
}

function pushWarning(list, entry) {
  const key = `${entry.kind}|${entry.sourceId || ''}|${entry.code}|${entry.detail || ''}`
  if (!list.some((item) => `${item.kind}|${item.sourceId || ''}|${item.code}|${item.detail || ''}` === key)) list.push(entry)
}

/** 逐卡回滚「本次新增」媒体：删文件 + 移除 registry 条目（复用已有 asset 不在此列）。 */
async function rollbackCardMedia(root, title, state, writes) {
  for (const item of writes) {
    await fs.rm(item.targetPath, { force: true }).catch(() => {})
    try {
      await store.removeAsset(root, title, item.assetId)
    } catch {
      /* 已不存在则忽略 */
    }
  }
  if (!writes.length) return
  const removed = new Set(writes.map((item) => item.assetId))
  state.targetAssets = (Array.isArray(state.targetAssets) ? state.targetAssets : []).filter((asset) => !removed.has(asset.id))
  state.knownSha = existingShaSet(state.targetAssets)
  for (const item of writes) state.mediaBySha.delete(item.sha256)
}

/** 占位符/结构化引用重写：仅对恰为资产 id 的字符串/数组元素生效；无法映射且有目标同 id 时保留。 */
function rewriteRefValue(value, resolveRef, canKeep, warnRef) {
  if (typeof value === 'string') {
    const id = assetCards.normalizeAssetId(value)
    if (!assetCards.isValidAssetId(id)) return value
    const mapped = resolveRef(id)
    if (mapped) return mapped
    if (canKeep(id)) return value
    warnRef(id)
    return undefined
  }
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) {
      const next = rewriteRefValue(item, resolveRef, canKeep, warnRef)
      if (next !== undefined) out.push(next)
    }
    return out.length ? out : undefined
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      const next = rewriteRefValue(value[key], resolveRef, canKeep, warnRef)
      if (next !== undefined) out[key] = next
    }
    return Object.keys(out).length ? out : undefined
  }
  return value
}

/** `{{Asset_<ID>_<field>}}` 占位符重写（只替换 ID 段；无法映射不删除原文 + warning）。 */
function rewritePlaceholders(value, resolveRef, canKeep, warnRef) {
  if (typeof value === 'string') {
    return value.replace(/\{\{Asset_([^{}]+)\}\}/g, (raw, body) => {
      const match = String(body).match(/^([A-Z]{3}[0-9]{3}(?:_[0-9]{2})?)((?:_[^{}]*)?)$/)
      if (!match) return raw
      const id = match[1]
      const mapped = resolveRef(id)
      if (mapped) return `{{Asset_${mapped}${match[2] || ''}}}`
      if (canKeep(id)) return raw
      warnRef(id)
      return raw
    })
  }
  if (Array.isArray(value)) return value.map((item) => rewritePlaceholders(item, resolveRef, canKeep, warnRef))
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) out[key] = rewritePlaceholders(value[key], resolveRef, canKeep, warnRef)
    return out
  }
  return value
}

/** 媒体引用 → 目标项目路径（复制/复用/丢弃）；返回 {value} 或 null（丢弃并 warning）。 */
async function rewriteCardMediaRef(ctx, ref) {
  if (isHttpMediaRef(ref)) return { value: ref, external: true }
  const text = String(ref == null ? '' : ref).trim()
  if (!text) return null
  const candidate = path.resolve(ctx.sourceProject.realDir, text)
  let real
  try {
    real = await fs.realpath(candidate)
  } catch {
    pushWarning(ctx.warnings, { kind: 'card', sourceId: ctx.sourceCardId, code: 'media-dropped', detail: '媒体引用不可用（缺失/越界），已丢弃' })
    return null
  }
  if (!sourcePathInside(ctx.sourceProject.realDir, real) || sourceHasInternalSegment(path.relative(ctx.sourceProject.realDir, real))) {
    pushWarning(ctx.warnings, { kind: 'card', sourceId: ctx.sourceCardId, code: 'media-dropped', detail: '媒体引用不在源项目内，已丢弃' })
    return null
  }
  let relativeProbe = ctx.sourceProject.realDir
  for (const segment of path.relative(ctx.sourceProject.realDir, real).split(path.sep)) {
    relativeProbe = path.join(relativeProbe, segment)
    const lstat = await fs.lstat(relativeProbe).catch(() => null)
    if (!lstat || lstat.isSymbolicLink()) {
      pushWarning(ctx.warnings, { kind: 'card', sourceId: ctx.sourceCardId, code: 'media-dropped', detail: '媒体引用包含符号链接，已丢弃' })
      return null
    }
  }
  const stat = await fs.stat(real).catch(() => null)
  if (!stat || !stat.isFile()) {
    pushWarning(ctx.warnings, { kind: 'card', sourceId: ctx.sourceCardId, code: 'media-dropped', detail: '媒体引用不是普通文件，已丢弃' })
    return null
  }
  if (stat.size > IMPORT_MAX_BYTES) {
    pushWarning(ctx.warnings, { kind: 'card', sourceId: ctx.sourceCardId, code: 'media-dropped', detail: '媒体文件超过 50MB，已丢弃' })
    return null
  }
  let fileName
  try {
    fileName = assertImportFileName(path.basename(real))
  } catch {
    pushWarning(ctx.warnings, { kind: 'card', sourceId: ctx.sourceCardId, code: 'media-dropped', detail: '媒体类型不在白名单，已丢弃' })
    return null
  }
  const buffer = await fs.readFile(real).catch(() => null)
  if (!buffer) {
    pushWarning(ctx.warnings, { kind: 'card', sourceId: ctx.sourceCardId, code: 'media-dropped', detail: '媒体文件不可读取，已丢弃' })
    return null
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  // 目标已有同 SHA → 复用已有 asset 路径（不重复写）
  if (ctx.state.knownSha.has(sha256)) {
    const existing = (Array.isArray(ctx.state.targetAssets) ? ctx.state.targetAssets : []).find((asset) => asset && asset.sha256 === sha256) || null
    const relative = existing ? await targetRelativeForAsset(ctx.targetRealDir, existing) : null
    if (relative) {
      ctx.stats.skipped += 1
      return { value: relative, assetId: existing.id, reused: true }
    }
    pushWarning(ctx.warnings, { kind: 'card', sourceId: ctx.sourceCardId, code: 'media-dropped', detail: '目标已有同内容媒体但路径不可复用，已丢弃' })
    return null
  }
  const batchHit = ctx.state.mediaBySha.get(sha256)
  if (batchHit) {
    ctx.stats.skipped += 1
    return { value: batchHit.relativePath, assetId: batchHit.assetId, reused: true }
  }
  const category = ctx.explicitCategory || deriveSourceCategory(ctx.sourceProject.realDir, real) || defaultCategory()
  try {
    const written = await writeImportedBuffer({
      root: ctx.root,
      title: ctx.title,
      projectDir: ctx.projectDir,
      category,
      fileName,
      buffer,
      sha256,
      note: `来源=${ctx.sourceProjectId}（卡片媒体）`,
    })
    ctx.stats.copied += 1
    ctx.writes.push({ assetId: written.asset.id, targetPath: written.targetPath, sha256 })
    ctx.state.targetAssets = [...(Array.isArray(ctx.state.targetAssets) ? ctx.state.targetAssets : []), written.asset]
    ctx.state.knownSha.add(sha256)
    ctx.state.mediaBySha.set(sha256, { relativePath: written.relativePath, assetId: written.asset.id })
    return { value: written.relativePath, assetId: written.asset.id }
  } catch {
    pushWarning(ctx.warnings, { kind: 'card', sourceId: ctx.sourceCardId, code: 'media-dropped', detail: '媒体复制失败，已丢弃' })
    return null
  }
}

async function rewriteCardMedia(ctx, media) {
  if (media == null || typeof media !== 'object' || Array.isArray(media)) return { media: undefined }
  const out = {}
  if (Array.isArray(media.images)) {
    const images = []
    for (const ref of media.images) {
      const result = await rewriteCardMediaRef(ctx, ref)
      if (result) images.push(result.value)
    }
    if (images.length) out.images = images
  }
  if (typeof media.thumbnail === 'string' && media.thumbnail.trim()) {
    const result = await rewriteCardMediaRef(ctx, media.thumbnail)
    if (result) out.thumbnail = result.value
  }
  if (Array.isArray(media.audio)) {
    const audio = []
    for (const ref of media.audio) {
      const result = await rewriteCardMediaRef(ctx, ref)
      if (result) audio.push(result.value)
    }
    if (audio.length) out.audio = audio
  }
  return { media: Object.keys(out).length ? out : undefined }
}

/** 预扫描卡片媒体数量（项目内相对路径去重计数；>300 → 请求级 400，避免部分写）。 */
function countCardMediaRefs(cards) {
  const refs = new Set()
  for (const card of cards) {
    const media = card && card.media
    if (!media || typeof media !== 'object') continue
    for (const key of ['images', 'thumbnail', 'audio']) {
      const value = media[key]
      const list = Array.isArray(value) ? value : value == null ? [] : [value]
      for (const ref of list) {
        if (typeof ref !== 'string' || !ref.trim() || isHttpMediaRef(ref)) continue
        refs.add(ref.trim())
      }
    }
  }
  return refs.size
}

/** C3（E16/H-8）：跨项目复制时 review 重置为 draft（rounds/roundCount/reopenCount 清空、finalPrompt 不复制）。
 *  源卡无 review → 返回 null（不新增字段/无 warning，旧路径零影响）。 */
function resetReviewForCopy(sourceReview, warnings, sourceId, kind) {
  const review = assetCards.normalizeReview(sourceReview)
  if (!review) return null
  pushWarning(warnings, { kind: kind === 'scene' ? 'scene' : 'card', sourceId, code: 'review-reset', detail: '跨项目复制：审核状态重置为草稿（轮次清空、定稿提示词不复制）' })
  return {
    schemaVersion: 1,
    status: 'draft',
    revision: 0,
    roundCount: 0,
    round: 0,
    promptVersion: review.promptVersion,
    currentPrompt: review.currentPrompt,
    rounds: [],
    reopenCount: 0,
  }
}

async function copySourceCards({ root, title, projectDir, targetRealDir, sourceProject, sourceProjectId, sourceCardIds, explicitCategory, copyMedia, allowNewIdSuffix, warnings }) {
  const sourceCards = await store.getAssetCards(sourceProject.root, sourceProjectId)
  const sourceMap = new Map((Array.isArray(sourceCards) ? sourceCards : []).map((card) => [card.id, card]))
  const targetCards = await store.getAssetCards(root, title).catch(() => [])
  const targetMap = new Map((Array.isArray(targetCards) ? targetCards : []).map((card) => [card.id, card]))
  const targetIds = new Set(targetMap.keys())
  const plannedIds = new Set(targetMap.keys())
  const idMap = {}
  const plans = new Map()
  const targetCardsForMedia = [...(Array.isArray(targetCards) ? targetCards : [])]
  const state = { targetAssets: await store.getAssets(root, title).catch(() => []), knownSha: existingShaSet(await store.getAssets(root, title).catch(() => [])), mediaBySha: new Map() }
  const baseEntries = []
  const variantEntries = []
  for (const sourceCardId of sourceCardIds) {
    const card = sourceMap.get(sourceCardId) || null
    if (!card) {
      plans.set(sourceCardId, { action: 'failed', code: 'not-found', reason: '源资产卡不存在' })
      continue
    }
    const parts = assetCards.splitAssetId(card.id)
    if (parts && parts.variant) variantEntries.push({ sourceCardId, card })
    else baseEntries.push({ sourceCardId, card })
  }
  const allocateBaseId = (prefix) => {
    const id = nextFreeBaseId([...targetIds, ...plannedIds], prefix)
    if (!id) return null
    plannedIds.add(id)
    return id
  }
  const allocateVariantId = (card) => {
    const parts = assetCards.splitAssetId(card.id)
    const baseTargetId = idMap[parts.baseId] || (targetIds.has(parts.baseId) ? parts.baseId : null)
    if (!baseTargetId) {
      if (!targetIds.has(card.id) && !plannedIds.has(card.id)) {
        plannedIds.add(card.id)
        return card.id
      }
      return allocateBaseId(parts.prefix)
    }
    const candidate = `${baseTargetId}_${parts.variant}`
    if (!targetIds.has(candidate) && !plannedIds.has(candidate)) {
      plannedIds.add(candidate)
      return candidate
    }
    for (let index = 1; index <= 99; index += 1) {
      const next = `${baseTargetId}_${String(index).padStart(2, '0')}`
      if (!targetIds.has(next) && !plannedIds.has(next)) {
        plannedIds.add(next)
        return next
      }
    }
    return allocateBaseId(parts.prefix)
  }
  const decide = (entry, isVariant) => {
    const card = entry.card
    const target = targetMap.get(card.id) || null
    if (target) {
      if (cardContentHash(target) === cardContentHash(card)) {
        idMap[card.id] = card.id
        plans.set(entry.sourceCardId, { action: 'skipped', reason: 'duplicate', id: card.id })
        return
      }
      if (!allowNewIdSuffix) {
        idMap[card.id] = card.id
        plans.set(entry.sourceCardId, { action: 'skipped', reason: 'id-exists', id: card.id })
        pushWarning(warnings, { kind: 'card', sourceId: entry.sourceCardId, code: 'id-exists', detail: '目标已有不同内容的同 id 卡片，默认跳过（可显式开 allowNewIdSuffix）' })
        return
      }
      const newId = isVariant ? allocateVariantId(card) : allocateBaseId(assetCards.splitAssetId(card.id).prefix)
      if (!newId) {
        plans.set(entry.sourceCardId, { action: 'failed', code: 'failed', reason: '没有可用的新资产编号' })
        return
      }
      idMap[card.id] = newId
      plans.set(entry.sourceCardId, { action: 'copy', targetId: newId, card })
      return
    }
    idMap[card.id] = card.id
    plannedIds.add(card.id)
    plans.set(entry.sourceCardId, { action: 'copy', targetId: card.id, card })
  }
  for (const entry of baseEntries) decide(entry, false)
  for (const entry of variantEntries) decide(entry, true)
  const copyPlans = [...plans.values()].filter((plan) => plan.action === 'copy')
  const copyVersion = []
  for (const sourceCardId of sourceCardIds) {
    const plan = plans.get(sourceCardId)
    if (plan && plan.action === 'copy') copyVersion.push({ sourceCardId, plan })
  }
  // 媒体上限预扫描（只统计将要复制的卡片；项目内相对引用去重）
  if (copyMedia) {
    const mediaCount = countCardMediaRefs(copyVersion.map((item) => item.plan.card))
    if (mediaCount > SOURCE_MEDIA_MAX) throw importError('invalid-args', `单次最多复制 ${SOURCE_MEDIA_MAX} 个卡片媒体文件`)
  }
  // 引用解析：同批 idMap 优先 → 目标已有卡保留 → 否则丢弃
  const materializedIds = new Set(targetIds)
  const resolveRef = (id) => {
    if (idMap[id] !== undefined) return idMap[id]
    if (materializedIds.has(id)) return id
    return null
  }
  const canKeep = (id) => materializedIds.has(id)
  // 先写基础卡（variantOf 不为同批变体），再写变体卡，保证 variantOf 引用已落盘
  const ordered = copyVersion
    .slice()
    .sort((a, b) => {
      const av = assetCards.splitAssetId(a.plan.card.id)?.variant ? 1 : 0
      const bv = assetCards.splitAssetId(b.plan.card.id)?.variant ? 1 : 0
      return av - bv
    })
  const results = new Map()
  const importedCards = []
  const skippedCards = []
  const failedCards = []
  for (const [sourceCardId, plan] of plans.entries()) {
    if (plan.action === 'skipped') skippedCards.push({ sourceCardId, id: plan.id, reason: plan.reason })
    if (plan.action === 'failed') failedCards.push({ sourceCardId, code: plan.code, reason: plan.reason })
  }
  for (const { sourceCardId, plan } of ordered) {
    const sourceCard = plan.card
    const cardWarnings = []
    const mediaStats = { copied: 0, skipped: 0 }
    const mediaWrites = []
    let media = sourceCard.media
    if (copyMedia) {
      const rewritten = await rewriteCardMedia({
        root,
        title,
        projectDir,
        targetRealDir,
        sourceProject,
        sourceProjectId,
        sourceCardId,
        explicitCategory,
        warnings,
        state,
        stats: mediaStats,
        writes: mediaWrites,
      }, sourceCard.media)
      media = rewritten.media
    }
    const localWarnings = []
    const warnRef = (id) => pushWarning(localWarnings, { kind: 'card', sourceId: sourceCardId, code: 'reference-dropped', detail: `引用的资产 ${id} 在目标不存在，已丢弃` })
    const variantOfResolved = sourceCard.variantOf ? resolveRef(sourceCard.variantOf) : null
    if (sourceCard.variantOf && !variantOfResolved) {
      pushWarning(warnings, { kind: 'card', sourceId: sourceCardId, code: 'variant-base-dropped', detail: 'variantOf 基础卡目标不存在，已丢弃该引用' })
    }
    const relations = rewriteRefValue(sourceCard.relations, resolveRef, canKeep, warnRef)
    const fields = rewritePlaceholders(sourceCard.fields, resolveRef, canKeep, warnRef)
    const prompts = rewritePlaceholders(sourceCard.prompts, resolveRef, canKeep, warnRef)
    const payload = {
      id: plan.targetId,
      name: sourceCard.name,
      variantOf: variantOfResolved && variantOfResolved !== plan.targetId ? variantOfResolved : undefined,
      aliases: sourceCard.aliases,
      status: sourceCard.status,
      fields,
      relations,
      prompts,
      ...(media ? { media } : {}),
      ...(resetReviewForCopy(sourceCard.review, warnings, sourceCardId, 'asset') ? { review: resetReviewForCopy(sourceCard.review, warnings, sourceCardId, 'asset') } : {}),
      importedFrom: {
        project: sourceProjectId,
        sourceId: sourceCardId,
        at: new Date().toISOString(),
        rootIndex: sourceProject.rootIndex,
        rootType: sourceProject.sourceType,
      },
    }
    try {
      const saved = await store.saveAssetCard(root, title, payload)
      materializedIds.add(saved.id)
      for (const warning of localWarnings) pushWarning(warnings, warning)
      importedCards.push({
        sourceCardId,
        id: saved.id,
        name: saved.name,
        mediaCopied: mediaStats.copied,
        mediaSkipped: mediaStats.skipped,
      })
    } catch (error) {
      await rollbackCardMedia(root, title, state, mediaWrites)
      const code = error && error.code === 'invalid-args' ? 'invalid-args' : 'failed'
      failedCards.push({ sourceCardId, code, reason: error instanceof Error ? error.message : '资产卡写入失败' })
    }
  }
  // 按请求顺序输出
  const orderIndex = new Map(sourceCardIds.map((id, index) => [id, index]))
  const byOrder = (a, b) => (orderIndex.get(a.sourceCardId) ?? 0) - (orderIndex.get(b.sourceCardId) ?? 0)
  importedCards.sort(byOrder)
  skippedCards.sort(byOrder)
  failedCards.sort(byOrder)
  const section = {
    imported: importedCards,
    skipped: skippedCards,
    failed: failedCards,
  }
  const remapped = Object.fromEntries(Object.entries(idMap).filter(([sourceId, targetId]) => sourceId !== targetId))
  if (Object.keys(remapped).length) section.idMap = remapped
  return { section, refMap: idMap }
}

async function copySourceScenes({ root, title, sourceProject, sourceProjectId, sourceSceneIds, allowNewIdSuffix, warnings, cardRefMap = {} }) {
  const sourceScenes = await store.getScenes(sourceProject.root, sourceProjectId)
  const sourceMap = new Map((Array.isArray(sourceScenes) ? sourceScenes : []).map((scene) => [scene.id, scene]))
  const targetScenes = await store.getScenes(root, title).catch(() => [])
  const targetMap = new Map((Array.isArray(targetScenes) ? targetScenes : []).map((scene) => [scene.id, scene]))
  const targetIds = new Set(targetMap.keys())
  const plannedIds = new Set(targetMap.keys())
  const targetCards = new Map((await store.getAssetCards(root, title).catch(() => [])).map((card) => [card.id, card]))
  const idMap = {}
  const plans = new Map()
  for (const sourceSceneId of sourceSceneIds) {
    const scene = sourceMap.get(sourceSceneId) || null
    if (!scene) {
      plans.set(sourceSceneId, { action: 'failed', code: 'not-found', reason: '源场景卡不存在' })
      continue
    }
    const target = targetMap.get(scene.id) || null
    if (target) {
      if (sceneContentHash(target) === sceneContentHash(scene)) {
        idMap[scene.id] = scene.id
        plans.set(sourceSceneId, { action: 'skipped', reason: 'duplicate', id: scene.id })
        continue
      }
      if (!allowNewIdSuffix) {
        idMap[scene.id] = scene.id
        plans.set(sourceSceneId, { action: 'skipped', reason: 'id-exists', id: scene.id })
        pushWarning(warnings, { kind: 'scene', sourceId: sourceSceneId, code: 'id-exists', detail: '目标已有不同内容的同 id 场景卡，默认跳过（可显式开 allowNewIdSuffix）' })
        continue
      }
      const newId = nextFreeSceneId([...targetIds, ...plannedIds])
      if (!newId) {
        plans.set(sourceSceneId, { action: 'failed', code: 'failed', reason: '没有可用的新场景编号' })
        continue
      }
      plannedIds.add(newId)
      idMap[scene.id] = newId
      plans.set(sourceSceneId, { action: 'copy', targetId: newId, scene })
      continue
    }
    idMap[scene.id] = scene.id
    plannedIds.add(scene.id)
    plans.set(sourceSceneId, { action: 'copy', targetId: scene.id, scene })
  }
  const resolveRef = (id) => {
    const mapped = cardRefMap[id] !== undefined ? cardRefMap[id] : id
    return targetCards.has(mapped) ? mapped : null
  }
  const imported = []
  const skipped = []
  const failed = []
  for (const sourceSceneId of sourceSceneIds) {
    const plan = plans.get(sourceSceneId)
    if (!plan) continue
    if (plan.action === 'skipped') { skipped.push({ sourceSceneId, id: plan.id, reason: plan.reason }); continue }
    if (plan.action === 'failed') { failed.push({ sourceSceneId, code: plan.code, reason: plan.reason }); continue }
    const scene = plan.scene
    const assetRefs = []
    let mapped = 0
    let dropped = 0
    for (const ref of Array.isArray(scene.assetRefs) ? scene.assetRefs : []) {
      const resolved = resolveRef(ref)
      if (resolved) { assetRefs.push(resolved); if (resolved !== ref) mapped += 1; continue }
      dropped += 1
      pushWarning(warnings, { kind: 'scene', sourceId: sourceSceneId, code: 'asset-ref-dropped', detail: `引用的资产 ${ref} 在目标不存在，已从 assetRefs 移除` })
    }
    try {
      const saved = await store.saveSceneCard(root, title, {
        id: plan.targetId,
        name: scene.name,
        description: scene.description,
        space: scene.space,
        lighting: scene.lighting,
        assetRefs,
        emotionBaseline: scene.emotionBaseline,
        notes: scene.notes,
        ...(resetReviewForCopy(scene.review, warnings, sourceSceneId, 'scene') ? { review: resetReviewForCopy(scene.review, warnings, sourceSceneId, 'scene') } : {}),
        importedFrom: {
          project: sourceProjectId,
          sourceId: sourceSceneId,
          at: new Date().toISOString(),
          rootIndex: sourceProject.rootIndex,
          rootType: sourceProject.sourceType,
        },
      })
      targetCards.set(saved.id, saved)
      imported.push({ sourceSceneId, id: saved.id, name: saved.name, assetRefsMapped: mapped, assetRefsDropped: dropped })
    } catch (error) {
      const code = error && error.code === 'invalid-args' ? 'invalid-args' : 'failed'
      failed.push({ sourceSceneId, code, reason: error instanceof Error ? error.message : '场景卡写入失败' })
    }
  }
  const section = { imported, skipped, failed }
  const remapped = Object.fromEntries(Object.entries(idMap).filter(([sourceId, targetId]) => sourceId !== targetId))
  if (Object.keys(remapped).length) section.idMap = remapped
  return section
}

async function copySourceStyle({ root, title, sourceProject, sourceProjectId, overwriteStyle, warnings }) {
  const sourceSnapshot = await store.readStyleDoc(sourceProject.root, sourceProjectId)
  const sourceDNA = styleDna.normalizeStyleDNA(sourceSnapshot.doc && sourceSnapshot.doc.style ? sourceSnapshot.doc.style : sourceSnapshot.doc)
  const hasSource = styleDna.STYLE_DIMENSIONS.some((dimension) => sourceDNA[dimension] !== '')
  if (!hasSource) return { copied: false, merge: 'skip', copiedDims: [], dimensions: styleDna.normalizeStyleDNA(null) }
  const targetSnapshot = await store.readStyleDoc(root, title)
  if (targetSnapshot.doc) {
    const state = styleDna.normalizeStyleState(targetSnapshot.doc.state)
    if (state.status === 'frozen') {
      pushWarning(warnings, { kind: 'style', code: 'style-locked', detail: '目标风格已冻结，未写入' })
      return { copied: false, merge: 'skip', copiedDims: [], dimensions: styleDna.normalizeStyleDNA(targetSnapshot.doc.style), failed: { code: 'style-locked', reason: '目标风格已冻结，未写入' } }
    }
    if (state.status === 'directed') {
      pushWarning(warnings, { kind: 'style', code: 'style-directed', detail: '目标风格已定向，未写入（请先在视觉圣经处理）' })
      return { copied: false, merge: 'skip', copiedDims: [], dimensions: styleDna.normalizeStyleDNA(targetSnapshot.doc.style), failed: { code: 'style-directed', reason: '目标风格已定向，未写入' } }
    }
  }
  const targetDNA = styleDna.normalizeStyleDNA(targetSnapshot.doc && targetSnapshot.doc.style ? targetSnapshot.doc.style : targetSnapshot.doc)
  const merged = { ...targetDNA }
  const copiedDims = []
  for (const dimension of styleDna.STYLE_DIMENSIONS) {
    if (overwriteStyle) {
      if (merged[dimension] !== sourceDNA[dimension]) {
        merged[dimension] = sourceDNA[dimension]
        copiedDims.push(dimension)
      }
    } else if (!merged[dimension] && sourceDNA[dimension]) {
      merged[dimension] = sourceDNA[dimension]
      copiedDims.push(dimension)
    }
  }
  if (!copiedDims.length) {
    return { copied: false, merge: 'skip', copiedDims: [], dimensions: merged }
  }
  const importedFrom = {
    project: sourceProjectId,
    at: new Date().toISOString(),
    rootIndex: sourceProject.rootIndex,
    rootType: sourceProject.sourceType,
  }
  const nextDoc = targetSnapshot.doc
    ? { ...targetSnapshot.doc, schemaVersion: 1, style: merged, importedFrom }
    : { schemaVersion: 1, style: merged, importedFrom }
  await store.writeStyleDoc(root, title, nextDoc)
  return { copied: true, merge: overwriteStyle ? 'overwrite' : 'fill-empty', copiedDims, dimensions: merged }
}

async function importAssetsFromProject(root, input, options = {}) {
  const legacyFields = ['base64', 'fileName', 'expectedSha256', 'maxBytes'].filter((key) => input[key] !== undefined)
  if (legacyFields.length) throw importError('invalid-args', 'source 模式与 base64/fileName/expectedSha256/maxBytes 互斥')
  if (input.sourceProjectId === undefined) throw importError('invalid-args', 'source 模式需要 sourceProjectId（源项目名称）')
  const title = await resolveProjectTitle(root, input.title)
  const sourceProjectId = assertSourceProjectTitle(input.sourceProjectId)
  const sourceAssetIds = assertSourceIds(input.sourceAssetIds, 'sourceAssetIds', 100)
  const sourceCardIds = assertSourceIds(input.sourceCardIds, 'sourceCardIds', SOURCE_CARD_MAX)
  const sourceSceneIds = assertSourceIds(input.sourceSceneIds, 'sourceSceneIds', SOURCE_SCENE_MAX)
  const copyStyleDNA = assertSourceBoolean(input.copyStyleDNA, 'copyStyleDNA')
  const copyMedia = assertSourceBoolean(input.copyMedia === undefined ? true : input.copyMedia, 'copyMedia')
  const allowNewIdSuffix = assertSourceBoolean(input.allowNewIdSuffix, 'allowNewIdSuffix')
  const overwriteStyle = assertSourceBoolean(input.overwriteStyle, 'overwriteStyle')
  const explicitCategory = input.targetCategory == null ? null : assertCategory(input.targetCategory)
  if (!sourceAssetIds && !sourceCardIds && !sourceSceneIds && !copyStyleDNA) {
    throw importError('invalid-args', 'source 模式至少需要 sourceAssetIds / sourceCardIds / sourceSceneIds / copyStyleDNA 之一')
  }
  const projectDir = store.projectDir(root, title)
  if (!(await store.isDirectory(projectDir))) throw importError('not-found', '目标短剧项目不存在')
  const managedRoots = await normalizeManagedRoots(options.managedRoots, root)
  const targetRealDir = await fs.realpath(projectDir)
  const sourceProject = await resolveSourceProject(managedRoots, sourceProjectId, projectDir)
  // 媒体上限预扫描：请求级 400 必须发生在任何写之前（含卡片+素材混合请求）
  if (sourceCardIds && copyMedia) {
    const sourceCardsForCap = await store.getAssetCards(sourceProject.root, sourceProjectId)
    const sourceCardMapForCap = new Map((Array.isArray(sourceCardsForCap) ? sourceCardsForCap : []).map((card) => [card.id, card]))
    const targetCardsForCap = await store.getAssetCards(root, title).catch(() => [])
    const targetCardMapForCap = new Map((Array.isArray(targetCardsForCap) ? targetCardsForCap : []).map((card) => [card.id, card]))
    const potentialCards = sourceCardIds
      .map((sourceCardId) => sourceCardMapForCap.get(sourceCardId))
      .filter((card) => {
        if (!card) return false
        const target = targetCardMapForCap.get(card.id)
        return !(target && cardContentHash(target) === cardContentHash(card))
      })
    if (countCardMediaRefs(potentialCards) > SOURCE_MEDIA_MAX) {
      throw importError('invalid-args', `单次最多复制 ${SOURCE_MEDIA_MAX} 个卡片媒体文件`)
    }
  }
  const warnings = []
  const imported = []
  const skipped = []
  const failed = []
  if (sourceAssetIds) {
    let sourceAssets = []
    try {
      sourceAssets = await store.getAssets(sourceProject.root, sourceProjectId)
    } catch {
      sourceAssets = []
    }
    const sourceIndex = new Map()
    for (const asset of Array.isArray(sourceAssets) ? sourceAssets : []) {
      if (asset && typeof asset.id === 'string') sourceIndex.set(asset.id, asset)
    }
    let targetAssets = []
    try {
      targetAssets = await store.getAssets(root, title)
    } catch {
      targetAssets = []
    }
    const knownSha = existingShaSet(targetAssets)
    for (const sourceAssetId of sourceAssetIds) {
      const entry = sourceIndex.get(sourceAssetId) || null
      if (!entry) {
        failed.push({ sourceAssetId, code: 'not-found', reason: '源素材不存在' })
        continue
      }
      const resolved = await resolveSourceAssetFile(sourceProject, entry)
      if (resolved.code) {
        failed.push({ sourceAssetId, code: resolved.code, reason: resolved.reason })
        continue
      }
      let buffer
      try {
        buffer = await fs.readFile(resolved.realFile)
      } catch {
        failed.push({ sourceAssetId, code: 'not-found', reason: '源素材文件不可读取' })
        continue
      }
      if (buffer.length > IMPORT_MAX_BYTES) {
        failed.push({ sourceAssetId, code: 'too-large', reason: '源素材超过 50MB 上限' })
        continue
      }
      const sha256 = createHash('sha256').update(buffer).digest('hex')
      if (knownSha.has(sha256)) {
        const existing = (Array.isArray(targetAssets) ? targetAssets : []).find((asset) => asset && typeof asset.sha256 === 'string' && asset.sha256.toLowerCase() === sha256) || null
        skipped.push({ sourceAssetId, reason: 'duplicate', existing: existing ? { id: existing.id, name: existing.name } : null })
        continue
      }
      const category = explicitCategory || deriveSourceCategory(sourceProject.realDir, resolved.realFile) || defaultCategory()
      const kind = ['image', 'video', 'audio', 'doc', 'other'].includes(entry.kind) ? entry.kind : undefined
      try {
        const written = await writeImportedBuffer({
          root,
          title,
          projectDir,
          category,
          fileName: resolved.fileName,
          buffer,
          sha256,
          note: `来源=${sourceProjectId}`,
          kind,
        })
        knownSha.add(sha256)
        targetAssets = [...(Array.isArray(targetAssets) ? targetAssets : []), written.asset]
        imported.push({
          sourceAssetId,
          assetId: written.asset.id,
          name: written.targetFileName,
          path: written.relativePath,
          category,
          bytes: buffer.length,
          sha256,
        })
        await patchImportedFrom(root, title, written.asset.id, {
          project: sourceProjectId,
          assetId: sourceAssetId,
          at: new Date().toISOString(),
          rootIndex: sourceProject.rootIndex,
          rootType: sourceProject.sourceType,
        })
      } catch (error) {
        const code = error && ['invalid-args', 'forbidden', 'not-found', 'too-large', 'failed'].includes(error.code) ? error.code : 'failed'
        failed.push({ sourceAssetId, code, reason: error instanceof Error ? error.message : '复制失败' })
      }
    }
  }
  const result = {
    mode: 'source',
    sourceProjectId,
    imported,
    skipped,
    failed,
    importedTotal: imported.length,
    skippedTotal: skipped.length,
    failedTotal: failed.length,
  }
  let newCategory = false
  let cardRefMap = {}
  if (sourceCardIds) {
    newCategory = true
    result.cards = await copySourceCards({
      root,
      title,
      projectDir,
      targetRealDir,
      sourceProject,
      sourceProjectId,
      sourceCardIds,
      explicitCategory,
      copyMedia,
      allowNewIdSuffix,
      warnings,
    })
    cardRefMap = result.cards.refMap || {}
    result.cards = result.cards.section
  }
  if (sourceSceneIds) {
    newCategory = true
    result.scenes = await copySourceScenes({
      root,
      title,
      sourceProject,
      sourceProjectId,
      sourceSceneIds,
      allowNewIdSuffix,
      warnings,
      cardRefMap,
    })
  }
  if (copyStyleDNA) {
    newCategory = true
    result.style = await copySourceStyle({ root, title, sourceProject, sourceProjectId, overwriteStyle, warnings })
  }
  if (newCategory) result.warnings = warnings
  return result
}

/**
 * 导入素材入口：
 * - base64 模式（v0.15.11 原行为，响应字段/字节不变）：`{ title?, fileName, base64, targetCategory?, expectedSha256?, maxBytes? }`；
 * - source 模式（v0.16.7 C2-H add-only）：`{ title?, sourceProjectId, sourceAssetIds[], targetCategory? }` → 200 聚合逐项结果。
 * @param {string} root 目标工作区根
 * @param {object} input
 * @param {{managedRoots?: Array<{path:string,sourceType?:string}>}} options 受管项目根（仅 source 模式使用）
 */
export async function importAsset(root, input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw importError('invalid-args', '请求参数不合法')
  const hasSourceMode = ['sourceProjectId', 'sourceAssetIds', 'sourceCardIds', 'sourceSceneIds', 'copyStyleDNA'].some((key) => input[key] !== undefined)
  const targetTitle = await resolveProjectTitle(root, input.title)
  // v0.16.10（task-157 / M3）：写前登记闸门（损坏 → 备份 + 默认 409 / repairRegistry:true 重建）。
  const readiness = await store.ensureRegistryReady(root, targetTitle, { repairRegistry: input.repairRegistry === true })
  const repairExtra = readiness.registryRepaired
    ? { registryRepaired: true, rebuiltCount: readiness.rebuiltCount, backup: readiness.backup }
    : {}
  if (hasSourceMode) {
    const result = await importAssetsFromProject(root, { ...input, title: targetTitle }, options)
    return Object.keys(repairExtra).length ? { ...result, ...repairExtra } : result
  }
  if (input.base64 == null) throw importError('invalid-args', '缺少 base64 内容')
  const title = targetTitle
  const fileName = assertImportFileName(input.fileName)
  const category = assertCategory(input.targetCategory)
  const limit = resolveLimit(input)
  const base64 = assertBase64(input.base64)
  // 50MB 边界：字符数上限 = ceil(limit/3)*4；先做预校验，再 decode 后复验
  const maxChars = Math.ceil(limit / 3) * 4
  if (base64.length > maxChars) throw importError('too-large', `素材过大（解码后超过 ${limit} 字节上限）`)
  const buffer = Buffer.from(base64, 'base64')
  if (!buffer.length) throw importError('invalid-args', 'base64 解码结果为空')
  if (buffer.length > limit) throw importError('too-large', `素材过大（${buffer.length} 字节 > 上限 ${limit} 字节）`)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const expectedSha = assertExpectedSha(input.expectedSha256)
  if (expectedSha && expectedSha !== sha256) throw importError('invalid-args', 'expectedSha256 与实际内容不一致（文件可能损坏）')

  const projectDir = store.projectDir(root, title)
  if (!(await store.isDirectory(projectDir))) throw importError('not-found', '短剧项目不存在')
  // SHA256 去重：命中 → conflict（不写任何文件/不改登记）
  let assets = []
  try {
    assets = await store.getAssets(root, title)
  } catch {
    assets = []
  }
  const knownSha = existingShaSet(assets)
  if (knownSha.has(sha256)) {
    const existing = (Array.isArray(assets) ? assets : []).find((asset) => asset && typeof asset.sha256 === 'string' && asset.sha256.toLowerCase() === sha256) || null
    throw importError('conflict', '素材已存在（SHA256 重复，未写入）', {
      duplicate: true,
      existing: existing ? { id: existing.id, name: existing.name } : null,
    })
  }
  const written = await writeImportedBuffer({ root, title, projectDir, category, fileName, buffer, sha256, note: '一键导入' })
  const baseResult = {
    name: written.targetFileName,
    path: written.relativePath,
    category,
    bytes: buffer.length,
    sha256,
    deduped: false,
    asset: written.asset,
  }
  return Object.keys(repairExtra).length ? { ...baseResult, ...repairExtra } : baseResult
}

