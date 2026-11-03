/**
 * 短剧项目仓储。
 *
 * 目录约定（需求文档 §5.2）：
 *   <工作区>/AI短剧/<短剧名>/      可见的一级节点（人读）
 *   <工作区>/AI短剧/<短剧名>/.aidrama/   结构化源数据 + 历史快照（机读）
 *
 * 单一事实源原则：结构化数据以 .aidrama/*.json 为准，可见的 .md 一律由它渲染生成，
 * 因此不存在「两边同时改」的双写冲突（需求文档 §5.2）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { normalizeCostTier, normalizeCostTierModels } from './model-routing.js'
import { normalizeSkillConfig } from './skill-config.js'

import { assertSafeFileName, assertSafeRelPath, assertSafeTitle, hasEncodedPathTraversal } from './names.js'
import * as assetCards from './assets.js'
import * as scenes from './scenes.js'
import * as styleDna from './style-dna.js'
import { normalizeWorldContractFields, worldContractMarkdownLines } from './contract-world.js'

export const ROOT_DIRNAME = 'AI短剧'
export const META_DIR = '.aidrama'
export const CONTRACT_FILE = '剧集契约.md'
export const SHARED_DIRNAME = '共享资料'
/** RC-26（v0.16.132）：资产库 v2 资产图片目录（懒创建；media-read 可读；素材扫描排除）。 */
export const ASSET_LIBRARY_DIR = '素材/短剧资产'
/** v0.16.186：生成视频按集目录根（S<季2位>-EP<集>）。 */
export const VIDEO_DIR = '素材/视频'

/**
 * v0.16.186：按集视频目录（相对项目根）。
 * S<季2位>-EP<集>：集 01–99 两位、≥100 自然三位；默认季 01。
 */
export function episodeVideoRel(episode, options = {}) {
  const n = Number(episode)
  if (!Number.isInteger(n) || n < 1 || n > 9999) {
    const error = new Error('集号必须是 1~9999 的整数')
    error.code = 'invalid-args'
    throw error
  }
  const season = options && options.season != null ? Number(options.season) : 1
  if (!Number.isInteger(season) || season < 1 || season > 99) {
    const error = new Error('季号必须是 1~99 的整数')
    error.code = 'invalid-args'
    throw error
  }
  return `${VIDEO_DIR}/S${String(season).padStart(2, '0')}-EP${String(n).padStart(2, '0')}`
}

/** v0.16.186：幂等创建某集视频目录（guarded mkdir；旧项目不预建、不迁移）。 */
export async function ensureEpisodeVideoDir(root, title, episode, options = {}) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) {
    const error = new Error(`短剧《${assertSafeTitle(title)}》不存在`)
    error.code = 'not-found'
    throw error
  }
  const rel = episodeVideoRel(episode, options)
  return guardedProjectMkdir(dir, rel)
}

export const PROJECT_DIRS = [
  '构想',
  '总纲',
  '人物',
  '世界观',
  '分集剧本',
  '分镜',
  '素材',
  '草稿区',
  '定稿',
  '账本',
  '本剧记忆',
  '导出',
]

/** v0.16.186：新建项目 P0 子目录（19 个 = v0.16.142 的 17 + 素材/视频 + 默认 S01-EP01；P1/P2 不预建）。 */
export const PROJECT_P0_SUBDIRS = Object.freeze([
  '构想/导演剖析',
  '构想/审核',
  '.aidrama/storyboard',
  '.aidrama/storyboard-groups',
  '.aidrama/drafts',
  '.aidrama/history',
  '.aidrama/audit',
  '.aidrama/assets',
  '.aidrama/reviews',
  '素材/短剧资产',
  '素材/短剧资产/人物卡',
  '素材/短剧资产/场景卡',
  '素材/短剧资产/道具卡',
  '素材/短剧资产/特效卡',
  '素材/短剧资产/载具卡',
  '素材/短剧资产/服装卡',
  '素材/短剧资产/其他',
  '素材/视频',
  '素材/视频/S01-EP01',
])

/** v0.16.94：项目绝对路径上限（字符数；Windows 长路径风险保护）。 */
export const MAX_PROJECT_PATH_CHARS = 240

const HISTORY_LIMIT = 20
const SEARCH_LIMIT = 60
const SEARCH_SCAN_LIMIT = 400

/* ------------------------------------------------------------ 基础文件操作 */

export async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * Windows 上 `fs.rename` 可能因杀软、索引器或编辑器短暂持有句柄而抛 EPERM/EBUSY/EACCES。
 * 这类错误是瞬时的，短退避重试即可；其它错误立即抛出，不掩盖真实问题。
 *
 * 这不只是测试抖动：`atomicWrite` 的临时文件→正式文件走的正是 rename，
 * 不重试的话**每一次写盘都可能偶发失败**（系统负载高时可稳定复现）。
 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

async function renameWithRetry(from, to, attempts = 6) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      lastError = error
      if (!RENAME_RETRY_CODES.has(error && error.code)) throw error
      await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt))
    }
  }
  throw lastError
}

/**
 * 原子写入：先写临时文件再 rename，中途崩溃不会留下半截文件（FR-E02）。
 * v0.16.31（R-23 / TOCTOU 收口，Lead 2026-10-22 批）：
 * - canonical 父目录捕获 + 临时文件句柄 fstat/sync 复核；
 * - pre-rename 复核父目录 realpath 未变（junction/symlink 替换会使 realpath 变化）；
 * - post-rename 复核最终文件仍位于 canonical 父目录；
 * - 失败复用既有 cleanTempFiles 清理临时文件并抛 forbidden（403），不新增 fs 写原语。
 * 残余风险（已登记）：pre-check→rename 之间仍有微秒级窗口，JS/Windows 无原子目录句柄 rename，
 * 不承诺完全消除；R-23 只收口原子写主路径（append/rm/copyFile/mkdir 等登记为残余窗口）。
 */
export async function atomicWrite(file, content, options = {}) {
  const dir = path.dirname(file)
  let canonicalDir = ''
  try {
    await fs.mkdir(dir, { recursive: true })
    canonicalDir = await fs.realpath(dir)
  } catch {
    throw assetPathError('forbidden', '写入目标父目录不可读（写入期间被替换），已拒绝')
  }
  const expectedRoot = options && typeof options.root === 'string' && options.root ? options.root : null
  // R-23：父目录在 guard 后被替换为 junction 时，realpath 会指向项目外 → 按 guard 捕获的项目根拒绝
  if (expectedRoot && canonicalDir !== expectedRoot && !isPathInside(expectedRoot, canonicalDir)) {
    throw assetPathError('forbidden', '写入目标父目录越出项目目录（写入期间被替换），已拒绝')
  }
  const baseName = path.basename(file)
  const tmp = path.join(canonicalDir, `.${baseName}.tmp-${process.pid}-${Date.now()}`)
  try {
    await fs.writeFile(tmp, content, 'utf8')
    // 1) 临时文件句柄复核（只读原语；不新增写点）：必须是普通文件，尽力落盘
    let handle
    try {
      handle = await fs.open(tmp, 'r+')
    } catch {
      throw assetPathError('forbidden', '写入临时文件不可复核（写入期间被替换），已拒绝')
    }
    try {
      let stat
      try {
        stat = await handle.stat()
      } catch {
        throw assetPathError('forbidden', '写入临时文件不可复核（写入期间被替换），已拒绝')
      }
      if (!stat.isFile()) throw assetPathError('forbidden', '写入临时文件校验失败，已拒绝')
      await handle.sync().catch(() => {})
    } finally {
      await handle.close().catch(() => {})
    }
    // 2) pre-rename：父目录 canonical 稳定性复核
    let parentNow = ''
    try {
      parentNow = await fs.realpath(dir)
    } catch {
      throw assetPathError('forbidden', '写入目标父目录不可读（写入期间被替换），已拒绝')
    }
    if (parentNow !== canonicalDir) throw assetPathError('forbidden', '写入目标父目录在写入期间被替换，已拒绝')
    // 3) rename 恒在 canonical 目录内进行
    await renameWithRetry(tmp, path.join(canonicalDir, baseName))
    // 4) post-rename：最终 realpath 必须仍在 canonical 父目录内
    let realFile = ''
    try {
      realFile = await fs.realpath(path.join(canonicalDir, baseName))
    } catch {
      throw assetPathError('forbidden', '写入目标不可校验（已拒绝）')
    }
    if (path.dirname(realFile) !== canonicalDir) throw assetPathError('forbidden', '写入目标在写入期间越出项目目录，已拒绝')
  } catch (error) {
    // R-23-QA（v0.16.31 修复）：换靶后 dir 可能已指向 decoy，temp 实际创建在原始 canonicalDir（项目内）→ 清理 canonicalDir
    await cleanTempFiles(canonicalDir).catch(() => {})
    // 换靶/删除竞争产生的文件系统错误统一归为 forbidden（对外契约保持 403/400）
    if (error && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBUSY', 'EBADF', 'EISDIR'].includes(String(error.code))) {
      throw assetPathError('forbidden', '写入目标在写入期间被替换/不可写，已拒绝')
    }
    throw error
  }
}

/** 清理上次崩溃残留的临时文件。 */
export async function cleanTempFiles(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (entry.isFile() && /\.tmp-\d+-\d+$/.test(entry.name)) {
      try {
        await fs.rm(path.join(dir, entry.name), { force: true })
        removed += 1
      } catch {
        /* 忽略 */
      }
    }
  }
  return removed
}

/* -------------------------------------------------------------- 项目定位 */

export function projectsBase(root) {
  return path.join(root, ROOT_DIRNAME)
}

export function projectDir(root, title) {
  return path.join(projectsBase(root), assertSafeTitle(title))
}

/** 工作区共享资料目录（`共享资料/`；listShared/readShared/writeShared 的根）。 */
export function sharedDir(root) {
  return path.join(root, SHARED_DIRNAME)
}

export function metaDir(dir) {
  return path.join(dir, META_DIR)
}

/**
 * v0.16.94：内部/可测试的标准布局 helper（不对外暴露为 API/METHOD/工具）。
 * - 只建缺失项，不覆盖任何已有文件/目录内容；
 * - 支持 `ensureProjectLayout(dir)` 与测试用 `ensureProjectLayout(root, title)`；
 * - P0 = 13 顶层目录 + `.aidrama/` + 9 个 P0 子目录；不建 P1/P2、不写种子。
 */
export async function ensureProjectLayout(rootOrDir, maybeTitle) {
  const dir = maybeTitle === undefined
    ? path.resolve(String(rootOrDir))
    : projectDir(rootOrDir, maybeTitle)
  await fs.mkdir(dir, { recursive: true })
  for (const sub of PROJECT_DIRS) {
    await fs.mkdir(path.join(dir, sub), { recursive: true })
  }
  await fs.mkdir(metaDir(dir), { recursive: true })
  for (const sub of PROJECT_P0_SUBDIRS) {
    await fs.mkdir(path.join(dir, sub), { recursive: true })
  }
  return { dir, dirs: [...PROJECT_DIRS], p0Subdirs: [...PROJECT_P0_SUBDIRS] }
}

/* ------------------------------------------------------------------ 项目 */

function emptyContract(title) {
  return {
    title,
    platform: '',
    audience: '',
    episodeDurationSec: [60, 180],
    targetEpisodes: 0,
    orientation: 'portrait',
    hookDensity: '',
    redlines: '',
    updatedAt: new Date().toISOString(),
  }
}

export async function projectSummary(title, dir) {
  let updatedAt = 0
  try {
    updatedAt = (await fs.stat(dir)).mtimeMs
  } catch {
    /* 忽略 */
  }
  let episodeCount = 0
  try {
    episodeCount = (await fs.readdir(path.join(dir, '分集剧本'))).filter((f) => f.endsWith('.md')).length
  } catch {
    /* 忽略 */
  }
  return { title, path: dir, updatedAt, episodeCount }
}

/* RC-24（v0.16.121 add-only）：项目封面只读探测（素材/封面/cover.<ext>；shelf 派生字段用）。
 * 不写盘、不缓存；多扩展名变体取 mtime 最新者（上传清理失败时兜底）。 */
export async function projectCoverInfo(dir) {
  const variants = ['.png', '.jpg', '.jpeg', '.webp']
  let best = null
  for (const ext of variants) {
    let stat
    try {
      stat = await fs.stat(path.join(dir, '素材', '封面', `cover${ext}`))
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    if (!best || stat.mtimeMs > best.coverUpdatedAt) {
      best = { coverPath: `素材/封面/cover${ext}`, coverUpdatedAt: stat.mtimeMs }
    }
  }
  return best
}

export async function listProjects(root) {
  const base = projectsBase(root)
  let entries
  try {
    entries = await fs.readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  const projects = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === SHARED_DIRNAME || entry.name === META_DIR) continue
    projects.push(await projectSummary(entry.name, path.join(base, entry.name)))
  }
  projects.sort((a, b) => b.updatedAt - a.updatedAt)
  return projects
}

export async function createProject(root, rawTitle, options = {}) {
  const title = assertSafeTitle(rawTitle)
  if (hasEncodedPathTraversal(title)) {
    const error = new Error('短剧名称包含编码后的非法字符（不允许 .. 跳转/分隔符）')
    error.code = 'invalid-args'
    throw error
  }
  const dir = projectDir(root, title)
  if (path.resolve(dir).length > MAX_PROJECT_PATH_CHARS) {
    throw new Error(`项目路径过长（上限 ${MAX_PROJECT_PATH_CHARS} 字符）`)
  }
  const testOptions = options && typeof options === 'object' ? options : {}

  // v0.16.10（M2）/ v0.16.94（R2）：项目父目录 `AI短剧/` 是基准目录，可 recursive 确保，不纳入回滚。
  const base = projectsBase(root)
  let baseStat = null
  try { baseStat = await fs.lstat(base) } catch (error) { if (!error || error.code !== 'ENOENT') throw new Error('项目根目录不可读') }
  if (!baseStat) {
    await fs.mkdir(base, { recursive: true })
    baseStat = await fs.lstat(base)
  }
  if (baseStat.isSymbolicLink()) throw assetPathError('forbidden', '项目根目录是符号链接/junction，已拒绝写入')
  if (!baseStat.isDirectory()) throw assetPathError('not-found', '项目根目录不是目录')
  let realBase
  let realRoot
  try { realBase = await fs.realpath(base) } catch { throw assetPathError('not-found', '项目根目录不可读') }
  try { realRoot = await fs.realpath(root) } catch { throw assetPathError('not-found', '工作区目录不可读') }
  if (!alsoInsideWorkspace(realRoot, realBase)) throw assetPathError('forbidden', '项目根目录越出工作区')

  // v0.16.94（R4）：同名文件/目录均视为已存在；0 写入。
  let existing = null
  try { existing = await fs.lstat(dir) } catch (error) { if (!error || error.code !== 'ENOENT') throw new Error('项目路径不可读') }
  if (existing) throw new Error(`短剧《${title}》已存在`)

  // v0.16.94（R2）：项目根用非 recursive mkdir 独占创建，确保“本次创建”语义。
  let createdRoot = false
  try {
    try {
      await fs.mkdir(dir)
      createdRoot = true
    } catch (error) {
      if (error && error.code === 'EEXIST') throw new Error(`短剧《${title}》已存在`)
      throw error
    }

    await ensureProjectLayout(dir)
    if (testOptions.__testFailAfterLayout) throw new Error('injected createProject failure after layout')
    // 用设置面板里的默认值预填契约（FR-F01）
    const settings = await getSettings(root)
    await saveContract(root, title, {
      ...emptyContract(title),
      platform: settings.defaultPlatform || '',
      episodeDurationSec: settings.defaultEpisodeDurationSec,
      orientation: settings.defaultOrientation,
      targetEpisodes: settings.defaultTargetEpisodes,
    })
    return projectSummary(title, dir)
  } catch (error) {
    // v0.16.94（D3）：只清理本次创建的项目根；绝不删除 pre-existing；清理失败不掩盖原始错误。
    if (createdRoot) {
      if (testOptions.__testFailCleanup) {
        error.cleanupError = new Error('injected cleanup failure')
        error.residualPath = dir
      } else {
        try {
          await fs.rm(dir, { recursive: true, force: true })
        } catch (cleanupError) {
          error.cleanupError = cleanupError
          error.residualPath = dir
        }
      }
    }
    throw error
  }
}

/** 把内部 .aidrama 也纳入树，但排在固定节点之后（便于前端只读展示）。 */
export async function readTree(root, rawTitle) {
  const title = assertSafeTitle(rawTitle)
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${title}》不存在`)
  const nodes = [{ kind: 'file', name: CONTRACT_FILE }]
  for (const sub of PROJECT_DIRS) {
    let children = []
    try {
      const entries = await fs.readdir(path.join(dir, sub), { withFileTypes: true })
      children = entries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({ kind: e.isDirectory() ? 'dir' : 'file', name: e.name }))
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'zh') : a.kind === 'dir' ? -1 : 1))
        .slice(0, 500)
    } catch {
      /* 忽略 */
    }
    nodes.push({ kind: 'dir', name: sub, count: children.length, children })
  }
  const metaExists = await isDirectory(metaDir(dir))
  return { title, path: dir, nodes, metaDir: metaExists ? META_DIR : null }
}

/* -------------------------------------------------------- 结构化文档读写 */

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 覆盖前留一份历史快照，保留最近 HISTORY_LIMIT 份（FR-B10 的轻量实现）。 */
async function snapshot(dir, key) {
  const source = path.join(metaDir(dir), `${key}.json`)
  if (!(await pathExists(source))) return
  const historyRel = `.aidrama/history/${key}.${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  const historyTarget = await assertProjectWriteTarget(dir, historyRel)
  await fs.mkdir(path.dirname(historyTarget), { recursive: true })
  await fs.copyFile(source, historyTarget)
  const historyDir = path.dirname(historyTarget)
  const files = (await fs.readdir(historyDir)).filter((f) => f.startsWith(`${key}.`)).sort()
  for (const stale of files.slice(0, Math.max(0, files.length - HISTORY_LIMIT))) {
    const staleTarget = await assertProjectWriteTarget(dir, `.aidrama/history/${stale}`)
    await fs.rm(staleTarget, { force: true })
  }
}

async function writeJsonDoc(dir, key, value) {
  await snapshot(dir, key)
  await guardedMetaWrite(dir, `${key}.json`, JSON.stringify(value, null, 2) + '\n')
}

async function readJsonDoc(dir, key, fallback) {
  return readJson(path.join(metaDir(dir), `${key}.json`), fallback)
}

/* -------------------------------------------------------------- 剧集契约 */

function renderContract(contract) {
  const rows = [
    ['平台', contract.platform],
    ['受众', contract.audience],
    ['单集时长（秒）', `${contract.episodeDurationSec?.[0] ?? ''} ~ ${contract.episodeDurationSec?.[1] ?? ''}`],
    ['目标集数', contract.targetEpisodes || ''],
    ['画幅', contract.orientation === 'landscape' ? '横屏' : '竖屏'],
    ['钩子密度', contract.hookDensity],
    ['审核红线', contract.redlines],
  ]
  const lines = [
    `# ${contract.title} · 剧集契约`,
    '',
    '> 本文件由「AI 短剧」工作区生成，源数据为 `.aidrama/contract.json`；',
    '> 直接改这里不会生效——请在插件面板中编辑。',
    '',
    '| 字段 | 值 |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${String(v ?? '').replace(/\|/g, '\\|')} |`),
    '',
  ]
  // v0.16.2（C1 / E14）：八大基本设定条件段（全空返回空数组 → 旧项目 MD 逐字节不变）。
  const worldLines = worldContractMarkdownLines(contract)
  if (worldLines.length) lines.push(...worldLines)
  lines.push(`> 最后更新：${contract.updatedAt || ''}`, '')
  return lines.join('\n')
}

export async function getContract(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  return readJsonDoc(dir, 'contract', emptyContract(assertSafeTitle(title)))
}

export async function saveContract(root, title, patch) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const current = await readJsonDoc(dir, 'contract', emptyContract(assertSafeTitle(title)))
  const next = { ...current, ...(patch || {}), title: current.title, updatedAt: new Date().toISOString() }

  if (next.episodeDurationSec != null) {
    const [a, b] = Array.isArray(next.episodeDurationSec) ? next.episodeDurationSec : []
    const min = Number(a)
    const max = Number(b)
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) {
      throw new Error('单集时长需要两个正整数，且上限不小于下限')
    }
    next.episodeDurationSec = [Math.round(min), Math.round(max)]
  }
  if (next.targetEpisodes != null) {
    const count = Number(next.targetEpisodes)
    if (!Number.isFinite(count) || count < 0 || count > 2000) throw new Error('目标集数需在 0~2000 之间')
    next.targetEpisodes = Math.round(count)
  }
  if (next.orientation != null && !['portrait', 'landscape'].includes(next.orientation)) {
    throw new Error('画幅只能是竖屏或横屏')
  }

  // v0.16.2（C1 / E14）：八大基本设定 add-only 8 字段 save 链归一（仅 patch 显式提交的键）。
  // 清空语义：显式 key 且 trim 后为空串 → 删除该键；非空 → 存 trim 值；key 缺失 → 保留 current 值。
  normalizeWorldContractFields(next, patch)

  await writeJsonDoc(dir, 'contract', next)
  await writeProjectFile(dir, path.join(dir, CONTRACT_FILE), renderContract(next))
  return next
}

/* ---------------------------------------------------------------- 总纲 */

const OUTLINE_COLUMNS = [
  ['order', '集数'],
  ['title', '标题'],
  ['logline', '一句话梗概'],
  ['hook', '开场钩子'],
  ['twist', '中段反转'],
  ['cliffhanger', '结尾悬念'],
  ['estDurationSec', '预计时长(秒)'],
]

function renderOutline(title, rows) {
  return [
    `# ${title} · 分集大纲`,
    '',
    '> 由「AI 短剧」工作区生成，源数据 `.aidrama/outline.json`。',
    '',
    `| ${OUTLINE_COLUMNS.map(([, label]) => label).join(' | ')} |`,
    `|${OUTLINE_COLUMNS.map(() => '---').join('|')}|`,
    ...rows.map(
      (row) =>
        `| ${OUTLINE_COLUMNS.map(([key]) => String(row[key] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`,
    ),
    '',
    `> 共 ${rows.length} 集`,
    '',
  ].join('\n')
}

export async function getOutline(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  return readJsonDoc(dir, 'outline', [])
}

export async function saveOutline(root, title, rows) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  if (!Array.isArray(rows)) throw new Error('总纲必须是分集数组')
  if (rows.length > 2000) throw new Error('分集数量过多（上限 2000）')

  const normalized = rows.map((row, index) => {
    if (!row || typeof row !== 'object') throw new Error(`第 ${index + 1} 行格式不正确`)
    const order = Number(row.order)
    const estDurationSec = Number(row.estDurationSec)
    return {
      order: Number.isFinite(order) && order > 0 ? Math.round(order) : index + 1,
      title: String(row.title ?? '').slice(0, 120),
      logline: String(row.logline ?? '').slice(0, 500),
      hook: String(row.hook ?? '').slice(0, 300),
      twist: String(row.twist ?? '').slice(0, 300),
      cliffhanger: String(row.cliffhanger ?? '').slice(0, 300),
      estDurationSec: Number.isFinite(estDurationSec) && estDurationSec > 0 ? Math.round(estDurationSec) : 0,
    }
  })

  await writeJsonDoc(dir, 'outline', normalized)
  await writeProjectFile(dir, path.join(dir, '总纲', '分集大纲.md'), renderOutline(assertSafeTitle(title), normalized))
  return normalized
}

/* ---------------------------------------------------------------- 人物 */

export async function getCharacters(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  return readJsonDoc(dir, 'characters', [])
}

export async function saveCharacters(root, title, cards) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  if (!Array.isArray(cards)) throw new Error('人物必须是角色数组')
  if (cards.length > 300) throw new Error('角色数量过多（上限 300）')

  const roles = ['主角', '反派', '配角', '龙套']
  const normalized = cards.map((card, index) => {
    if (!card || typeof card !== 'object') throw new Error(`第 ${index + 1} 个角色格式不正确`)
    const name = String(card.name ?? '').trim()
    if (!name) throw new Error(`第 ${index + 1} 个角色缺少姓名`)
    const personality = Array.isArray(card.personality)
      ? card.personality.map((x) => String(x).trim()).filter(Boolean).slice(0, 20)
      : String(card.personality ?? '')
          .split(/[、,，\s]+/)
          .filter(Boolean)
          .slice(0, 20)
    return {
      id: String(card.id || `ch-${index + 1}-${Date.now().toString(36)}`),
      name: name.slice(0, 40),
      role: roles.includes(card.role) ? card.role : '配角',
      personality,
      bio: String(card.bio ?? '').slice(0, 2000),
      appearancePrompt: String(card.appearancePrompt ?? '').slice(0, 1000),
      voiceHint: String(card.voiceHint ?? '').slice(0, 200),
    }
  })

  const seen = new Set()
  for (const card of normalized) {
    if (seen.has(card.name)) throw new Error(`角色姓名重复：${card.name}`)
    seen.add(card.name)
  }

  await writeJsonDoc(dir, 'characters', normalized)

  const md = [
    `# ${assertSafeTitle(title)} · 人物设定卡`,
    '',
    '> 由「AI 短剧」工作区生成，源数据 `.aidrama/characters.json`。',
    '',
    ...(normalized.length
      ? normalized.flatMap((card) => [
          `## ${card.name}（${card.role}）`,
          '',
          `- **性格**：${card.personality.join('、') || '—'}`,
          `- **形象提示词**：${card.appearancePrompt || '—'}`,
          `- **音色**：${card.voiceHint || '—'}`,
          '',
          card.bio ? `${card.bio}` : '_（暂无小传）_',
          '',
        ])
      : ['_（暂无角色）_', '']),
  ].join('\n')
  await writeProjectFile(dir, path.join(dir, '人物', '人物设定卡.md'), md)
  return normalized
}

/* ---------------------------------------------------------------- 剧本 */

export function episodeFileName(order) {
  const n = Number(order)
  if (!Number.isFinite(n) || n < 1 || n > 9999) throw new Error('集数需在 1~9999 之间')
  return `第${String(Math.round(n)).padStart(3, '0')}集.md`
}

export async function listEpisodes(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  let files = []
  try {
    files = await fs.readdir(path.join(dir, '分集剧本'))
  } catch {
    /* 忽略 */
  }
  return files
    .filter((f) => /^第\d+集\.md$/.test(f))
    .map((f) => ({ order: Number(f.match(/^第(\d+)集/)[1]), file: f }))
    .sort((a, b) => a.order - b.order)
}

export async function readEpisode(root, title, order) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const file = path.join(dir, '分集剧本', episodeFileName(order))
  try {
    return { order: Number(order), text: await fs.readFile(file, 'utf8') }
  } catch {
    return { order: Number(order), text: '' }
  }
}

export async function writeEpisode(root, title, order, text) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  if (typeof text !== 'string') throw new Error('剧本内容必须是文本')
  if (text.length > 400000) throw new Error('单集内容过长')
  const file = path.join(dir, '分集剧本', episodeFileName(order))
  await snapshot(dir, `episode-${episodeFileName(order)}`)
  await writeProjectFile(dir, file, text)
  return { order: Number(order), bytes: Buffer.byteLength(text, 'utf8') }
}

/* ---------------------------------------------------------------- 分镜 */

// v0.16.218：缺字段/空串不再默认中景；旧数据实际出现过的「大远景/空镜」保留旧归一（中景），其余非法值 400。
const SHOT_SIZES = ['远景', '全景', '中景', '近景', '特写', '大特写']
const LEGACY_INVALID_SHOT_SIZES = new Set(['大远景', '空镜'])

/** 分镜的规范字段顺序与默认值：读取旧数据时补默认值，并保证序列化 key 顺序稳定（定稿快照哈希依赖它）。 */
const SHOT_DEFAULTS = {
  shotNumber: '',
  // v0.16.218（D-0098）：未定义景别为空串，不再默认「中景」。
  shotSize: '',
  cameraMove: '',
  description: '',
  dialogue: '',
  sfx: '',
  // v0.16.218：读旧数据缺省补 0（旧字节兼容）；新写入未定义用 null；不再默认 3。
  durationSec: 0,
  imagePrompt: '',
  videoPrompt: '',
}

/** 已知字段（= v0.10.0 之前 saveStoryboard 白名单，顺序即序列化顺序）。 */
const SHOT_KNOWN_KEYS = Object.keys(SHOT_DEFAULTS)

/**
 * v0.10.0（0-4a）：分镜可选扩展字段（add-only）。
 * - 全部可选：未提供/空值不写入 → 旧项目输出字节级不变；
 * - 序列化顺序固定为下方数组顺序（已知 9 字段之后、未知字段之前）；
 * - 非法值抛 invalid-args（HTTP 400），不静默丢弃。
 */
const SHOT_OPTIONAL_KEYS = [
  'emotion',
  'light',
  'ambientSound',
  'constraints',
  'poses',
  'transitionToNext',
  'naturalLanguagePrompt',
  'lens',
  'subject',
  'groupId',
  'sceneRef',
  'scriptExcerpt',
  'stagingImage',
  'assetIds',
  'assetStateBindings',
]
const SHOT_TRANSITIONS = ['hard-cut', 'match-cut', 'whip-pan', 'one-take']
const SHOT_RESERVED_KEYS = [...SHOT_KNOWN_KEYS, ...SHOT_OPTIONAL_KEYS]
const SHOT_TEXT_LIMITS = { light: 500, ambientSound: 300, naturalLanguagePrompt: 3000, lens: 40, subject: 60, groupId: 20, sceneRef: 10, scriptExcerpt: 2000 }

/** v0.10.0：可选字段单一事实源（导出/渲染/QA 共用；只读常量）。 */
export const SHOT_OPTIONAL_FIELDS = [...SHOT_OPTIONAL_KEYS]

/** v0.16.194（P0-③）：分镜资产状态绑定上限/解析。 */
const ASSET_STATE_BINDINGS_MAX = 200

/** 旧 `cardId::stateId` 合成项 → {cardId,stateId}；非法返回 null。 */
function parseLegacyAssetStateId(value) {
  const text = String(value == null ? '' : value).trim()
  const separator = text.indexOf('::')
  if (separator <= 0) return null
  const cardId = assetCards.normalizeAssetId(text.slice(0, separator))
  const stateId = assetCards.normalizeMediaStateId(text.slice(separator + 2))
  if (!cardId || !stateId || !assetCards.isValidAssetId(cardId)) return null
  return { cardId, stateId }
}

/** v0.16.204：归一 `shot.assetStateBindings`（形状/引用 assetIds/同卡+状态唯一；state 存在性由保存前异步校验）。 */
function normalizeAssetStateBindingsInput(value, assetIds, where) {
  if (value == null) return []
  if (!Array.isArray(value)) throw invalidArgsError(`${where}.assetStateBindings 必须是对象数组（≤${ASSET_STATE_BINDINGS_MAX}）`)
  if (value.length > ASSET_STATE_BINDINGS_MAX) throw invalidArgsError(`${where}.assetStateBindings 过多（上限 ${ASSET_STATE_BINDINGS_MAX} 条）`)
  const known = new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => assetCards.normalizeAssetId(id)).filter(Boolean))
  const seen = new Set()
  const bindings = []
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index]
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalidArgsError(`${where}.assetStateBindings[${index}] 必须是对象 { cardId, stateId }`)
    for (const key of Object.keys(item).sort()) {
      if (!['cardId', 'stateId'].includes(key)) throw invalidArgsError(`${where}.assetStateBindings[${index}] 不支持字段：${key}`)
    }
    const cardId = assetCards.normalizeAssetId(item.cardId)
    if (!assetCards.isValidAssetId(cardId)) throw invalidArgsError(`${where}.assetStateBindings[${index}].cardId 非法：${item.cardId}`)
    const stateId = assetCards.normalizeMediaStateId(item.stateId)
    if (!stateId) throw invalidArgsError(`${where}.assetStateBindings[${index}].stateId 非法（1–40 位字母/数字/_/-）`)
    if (!known.has(cardId)) throw invalidArgsError(`${where}.assetStateBindings 的 cardId 必须属于 assetIds：${cardId}`)
    const pairKey = `${cardId}\u0001${stateId}`
    if (seen.has(pairKey)) throw invalidArgsError(`${where}.assetStateBindings 同一 cardId+stateId 不能重复：${cardId}::${stateId}`)
    seen.add(pairKey)
    bindings.push({ cardId, stateId })
  }
  return bindings
}

/** 归一 v0.10.0 分镜可选字段；只返回非空值（缺省/空 → 省略，保证旧项目字节不变）。 */
function normalizeShotOptional(shot, where) {
  const optional = {}
  if (shot.emotion != null) {
    if (typeof shot.emotion !== 'object' || Array.isArray(shot.emotion)) {
      throw invalidArgsError(`${where}.emotion 必须是对象 { label, intensity }`)
    }
    const label = typeof shot.emotion.label === 'string' ? shot.emotion.label.trim().slice(0, 40) : ''
    const intensity = Number(shot.emotion.intensity)
    if (!label) throw invalidArgsError(`${where}.emotion.label 必须是非空字符串（≤40 字）`)
    if (!Number.isFinite(intensity) || intensity < 0 || intensity > 100) {
      throw invalidArgsError(`${where}.emotion.intensity 必须是 0~100 的数字`)
    }
    optional.emotion = { label, intensity: Math.round(intensity) }
  }
  for (const key of ['light', 'ambientSound', 'naturalLanguagePrompt', 'lens', 'subject', 'groupId', 'scriptExcerpt']) {
    if (shot[key] == null) continue
    if (typeof shot[key] !== 'string') throw invalidArgsError(`${where}.${key} 必须是字符串`)
    const raw = shot[key].trim()
    // v0.16.95（P0 写面）：scriptExcerpt 超限 → 400（不静默截断；其余既有字段保持旧截断语义）。
    if (key === 'scriptExcerpt' && raw.length > SHOT_TEXT_LIMITS[key]) {
      throw invalidArgsError(`${where}.${key} 过长（上限 ${SHOT_TEXT_LIMITS[key]} 字）`)
    }
    const text = raw.slice(0, SHOT_TEXT_LIMITS[key])
    if (text) optional[key] = text
  }
  if (shot.constraints != null) {
    if (!Array.isArray(shot.constraints)) throw invalidArgsError(`${where}.constraints 必须是字符串数组（≤8 条）`)
    const constraints = shot.constraints
      .map((item) => String(item ?? '').trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 8)
    if (constraints.length) optional.constraints = constraints
  }
  if (shot.poses != null) {
    if (typeof shot.poses !== 'object' || Array.isArray(shot.poses)) {
      throw invalidArgsError(`${where}.poses 必须是对象 { startPose, endPose }`)
    }
    const startPose = String(shot.poses.startPose ?? '').trim().slice(0, 300)
    const endPose = String(shot.poses.endPose ?? '').trim().slice(0, 300)
    if (startPose || endPose) optional.poses = { startPose, endPose }
  }
  if (shot.transitionToNext != null && shot.transitionToNext !== '') {
    if (typeof shot.transitionToNext !== 'string' || !SHOT_TRANSITIONS.includes(shot.transitionToNext)) {
      throw invalidArgsError(`${where}.transitionToNext 只能是 ${SHOT_TRANSITIONS.join(' / ')}`)
    }
    optional.transitionToNext = shot.transitionToNext
  }
  // v0.11.1（2-2 一期）：shot.sceneRef add-only 可选字段（仅 SPCxxx 基号，无变体；空值省略）
  if (shot.sceneRef != null && shot.sceneRef !== '') {
    if (typeof shot.sceneRef !== 'string') throw invalidArgsError(`${where}.sceneRef 必须是字符串`)
    const ref = shot.sceneRef.trim().toUpperCase()
    if (ref) {
      if (!scenes.isValidSceneId(ref)) throw invalidArgsError(`${where}.sceneRef 非法：${shot.sceneRef}（应为 SPC+3 位序号，如 SPC001）`)
      optional.sceneRef = ref
    }
  }
  // v0.16.96（D-0042 add-only）：站位图绑定路径（仅路径字符串；文件由 media-upload 原子写入；md 不渲染）。
  if (shot.stagingImage != null) {
    if (typeof shot.stagingImage !== 'string') throw invalidArgsError(`${where}.stagingImage 必须是字符串`)
    const text = shot.stagingImage.trim().replace(/\\/g, '/')
    if (text) {
      if (text.length > 500) throw invalidArgsError(`${where}.stagingImage 过长（上限 500 字符）`)
      if (/[\u0000-\u001f\u007f]/u.test(text)) throw invalidArgsError(`${where}.stagingImage 含控制字符`)
      if (!text.startsWith('素材/站位图/')) throw invalidArgsError(`${where}.stagingImage 必须是 素材/站位图/ 下的项目相对路径`)
      const segments = text.split('/')
      if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw invalidArgsError(`${where}.stagingImage 路径非法`)
      const ext = path.extname(text).toLowerCase()
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw invalidArgsError(`${where}.stagingImage 仅支持 png/jpg/jpeg/webp`)
      optional.stagingImage = text
    }
  }
  // v0.16.105（D-0046 add-only）：每镜素材绑定（assets.json 素材 ID；md 不渲染）。
  // 缺省不写（旧项目字节不变）；显式 [] 保留以表达「用户清空」；去重保序；不校验 ID 是否存在。
  // v0.16.194（P0-③）：assetIds 只存卡 id；旧 `cardId::stateId` 写入时拆为 base + assetStateBindings。
  const legacyBindings = []
  if (shot.assetIds != null) {
    if (!Array.isArray(shot.assetIds)) throw invalidArgsError(`${where}.assetIds 必须是字符串数组（≤200 条）`)
    if (shot.assetIds.length > 200) throw invalidArgsError(`${where}.assetIds 过多（上限 200 条）`)
    if (!shot.assetIds.length) {
      optional.assetIds = []
    } else {
      const seen = new Set()
      const ids = []
      for (const item of shot.assetIds) {
        if (typeof item !== 'string') throw invalidArgsError(`${where}.assetIds 元素必须是字符串`)
        const text = item.trim()
        if (!text) throw invalidArgsError(`${where}.assetIds 元素不能为空`)
        if (text.length > 120) throw invalidArgsError(`${where}.assetIds 元素过长（上限 120 字符）`)
        if (/[\u0000-\u001f\u007f]/u.test(text)) throw invalidArgsError(`${where}.assetIds 元素含控制字符`)
        const legacy = parseLegacyAssetStateId(text)
        if (text.includes('::') && !legacy) throw invalidArgsError(`${where}.assetIds 旧状态引用非法：${item}`)
        const id = legacy ? legacy.cardId : text
        if (legacy) legacyBindings.push(legacy)
        if (seen.has(id)) continue
        seen.add(id)
        ids.push(id)
      }
      optional.assetIds = ids
    }
  }
  // v0.16.194（P0-③）：卡×状态绑定；未选状态=缺省；仅 CHR 卡由保存前 existence 校验控制。
  // v0.16.204（D-0092）：同卡可并存多个状态；同 cardId+stateId 唯一。legacy `::` 与显式跨来源同 pair 去重（不 400）。
  const explicitBindings = normalizeAssetStateBindingsInput(shot.assetStateBindings, optional.assetIds || [], where)
  const mergedBindings = []
  const mergedPairs = new Set()
  for (const binding of [...legacyBindings, ...explicitBindings]) {
    const pairKey = `${binding.cardId}\u0001${binding.stateId}`
    if (mergedPairs.has(pairKey)) continue
    mergedPairs.add(pairKey)
    mergedBindings.push(binding)
  }
  if (mergedBindings.length) {
    if (!Array.isArray(optional.assetIds) || !optional.assetIds.length) throw invalidArgsError(`${where}.assetStateBindings 需要同时提供 assetIds`)
    optional.assetStateBindings = mergedBindings
  }
  // 固定为 SHOT_OPTIONAL_KEYS 顺序输出（保证序列化确定性）
  return Object.fromEntries(SHOT_OPTIONAL_KEYS.filter((key) => Object.hasOwn(optional, key)).map((key) => [key, optional[key]]))
}

/** v0.16.194（P0-③）：读视图把旧 `cardId::stateId` 拆成 base assetIds + bindings（只读，不写盘）。 */
function normalizeReadShotStateBindings(shot) {
  if (!shot || typeof shot !== 'object' || Array.isArray(shot)) return shot
  const rawIds = Array.isArray(shot.assetIds) ? shot.assetIds : []
  const explicit = Array.isArray(shot.assetStateBindings)
    ? shot.assetStateBindings.filter((item) => item && typeof item === 'object' && !Array.isArray(item) && typeof item.cardId === 'string' && typeof item.stateId === 'string').map((item) => ({ cardId: assetCards.normalizeAssetId(item.cardId), stateId: assetCards.normalizeMediaStateId(item.stateId) })).filter((item) => item.cardId && item.stateId)
    : []
  const bindings = []
  const seenPairs = new Set()
  const ids = []
  const seenIds = new Set()
  let changed = false
  // v0.16.204：读视图同 cardId+stateId 去重；同卡不同 state 保留。
  for (const binding of explicit) {
    const pairKey = `${binding.cardId}\u0001${binding.stateId}`
    if (seenPairs.has(pairKey)) { changed = true; continue }
    seenPairs.add(pairKey)
    bindings.push(binding)
  }
  for (const raw of rawIds) {
    if (typeof raw !== 'string') continue
    const text = raw.trim()
    if (!text) continue
    const legacy = parseLegacyAssetStateId(text)
    if (legacy) {
      changed = true
      const pairKey = `${legacy.cardId}\u0001${legacy.stateId}`
      if (!seenPairs.has(pairKey)) { seenPairs.add(pairKey); bindings.push(legacy) }
      if (!seenIds.has(legacy.cardId)) { seenIds.add(legacy.cardId); ids.push(legacy.cardId) }
      continue
    }
    if (!seenIds.has(text)) { seenIds.add(text); ids.push(text) }
  }
  if (!changed) return shot
  return {
    ...shot,
    assetIds: ids,
    ...(bindings.length ? { assetStateBindings: bindings } : {}),
  }
}

export async function getStoryboard(root, title, order) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const shots = await readJson(path.join(metaDir(dir), 'storyboard', `${episodeFileName(order)}.json`), [])
  // H-3：videoPrompt 是后加字段，旧数据没有它 —— 读取时即按规范顺序补默认值，
  // 既保证读取形状稳定，也保证「定稿快照 JSON ↔ 回滚后重写 JSON」的字节级确定性。
  return Array.isArray(shots) ? shots.map((shot) => normalizeReadShotStateBindings(mapLegacyShotSizeForRead({ ...SHOT_DEFAULTS, ...shot }))) : []
}


/**
 * v0.16.194（P0-③）：保存前校验 assetStateBindings 的 card/state 真实存在（异步；零写前抛 invalid-args）。
 * 旧 `::` 已在 normalizeShotOptional 拆为 base+binding，这里同样覆盖。
 */
async function validateShotStateBindingsExist(root, title, shots) {
  const pairs = []
  for (const shot of Array.isArray(shots) ? shots : []) {
    const bindings = Array.isArray(shot && shot.assetStateBindings) ? shot.assetStateBindings : []
    for (const binding of bindings) {
      if (binding && typeof binding.cardId === 'string' && typeof binding.stateId === 'string') pairs.push(binding)
    }
  }
  if (!pairs.length) return
  const cards = await getAssetCards(root, title)
  const map = new Map((Array.isArray(cards) ? cards : []).map((card) => [String(card.id || '').toUpperCase(), card]))
  for (const binding of pairs) {
    const card = map.get(String(binding.cardId || '').toUpperCase()) || null
    if (!card) throw invalidArgsError(`assetStateBindings 引用的资产不存在：${binding.cardId}`)
    const states = card.media && Array.isArray(card.media.states) ? card.media.states : []
    if (!states.some((state) => String(state.id || '') === String(binding.stateId || ''))) {
      throw invalidArgsError(`assetStateBindings 引用的状态不存在：${binding.cardId}::${binding.stateId}`)
    }
  }
}

/** v0.16.218（D-0098）：景别未定义/空串合法；旧库大远景/空镜保留旧归一（中景）；其余显式非法值 400。 */
function normalizeShotSizeValue(value, where) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw invalidArgsError(`${where}.shotSize 必须是字符串（可为空）`)
  const text = value.trim()
  if (!text) return ''
  if (SHOT_SIZES.includes(text)) return text
  if (LEGACY_INVALID_SHOT_SIZES.has(text)) return text
  throw invalidArgsError(`${where}.shotSize 非法：${text}（允许空或 ${SHOT_SIZES.join('/')}；旧值大远景/空镜按原值保留）`)
}

/** 读视图：旧值大远景/空镜映射中景（仅展示，不写盘）。 */
function mapLegacyShotSizeForRead(shot) {
  if (!shot || typeof shot !== 'object') return shot
  if (!LEGACY_INVALID_SHOT_SIZES.has(String(shot.shotSize || '').trim())) return shot
  return { ...shot, shotSize: '中景' }
}

/** 保存时保留磁盘既有旧值，避免「读到映射值后再保存」把大远景/空镜自动改写为中景。 */
async function preserveLegacyShotSizes(dir, order, normalizedShots) {
  let rawShots = []
  try {
    rawShots = await readJson(path.join(metaDir(dir), 'storyboard', `${episodeFileName(order)}.json`), [])
  } catch {
    rawShots = []
  }
  const legacyByShot = new Map()
  for (const shot of Array.isArray(rawShots) ? rawShots : []) {
    const shotNumber = String(shot && shot.shotNumber || '').trim()
    const shotSize = String(shot && shot.shotSize || '').trim()
    if (shotNumber && LEGACY_INVALID_SHOT_SIZES.has(shotSize)) legacyByShot.set(shotNumber, shotSize)
  }
  if (!legacyByShot.size) return normalizedShots
  return normalizedShots.map((shot) => {
    const legacy = legacyByShot.get(String(shot.shotNumber || '').trim())
    if (!legacy || shot.shotSize !== '中景') return shot
    return { ...shot, shotSize: legacy }
  })
}

/** v0.16.246（D-0100）：插件不再对镜头时长做技术硬限制（用户口径：时长由脚本提示词承载）。
 * - 允许 null（未定义）与任意整数 0–600（含历史 3 秒等存量值）；
 * - 拒绝负数/小数/非数字（400），避免脏数据；
 * - 不默认填充，不改写既有值。 */
function normalizeShotDurationValue(value, where) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalidArgsError(`${where}.durationSec 必须是 null 或整数秒`)
  }
  if (value < 0 || value > 600) throw invalidArgsError(`${where}.durationSec 必须在 0–600 秒之间`)
  return value
}

/** 归一镜头数组（v0.10.0 0-4a/0-4b）：已知字段 + 可选字段 + 未知字段保留。 */
function normalizeShots(shots, order) {
  if (!Array.isArray(shots)) throw new Error('分镜必须是镜头数组')
  if (shots.length > 500) throw new Error('单集镜头数量过多（上限 500）')
  return shots.map((shot, index) => {
    if (!shot || typeof shot !== 'object') throw new Error(`第 ${index + 1} 个镜头格式不正确`)
    const where = `第 ${index + 1} 个镜头`
    const known = {
      shotNumber: String(shot.shotNumber ?? `${Math.round(Number(order))}-${index + 1}`).slice(0, 20),
      shotSize: normalizeShotSizeValue(shot.shotSize, where),
      cameraMove: String(shot.cameraMove ?? '').slice(0, 60),
      description: String(shot.description ?? '').slice(0, 4000),
      dialogue: String(shot.dialogue ?? '').slice(0, 4000),
      sfx: String(shot.sfx ?? '').slice(0, 200),
      durationSec: normalizeShotDurationValue(shot.durationSec, where),
      imagePrompt: String(shot.imagePrompt ?? '').slice(0, 20000),
      // H-3（FR-E04 视频分镜）：视频运镜/成片提示词，只增字段不影响旧数据。
      videoPrompt: String(shot.videoPrompt ?? '').slice(0, 20000),
    }
    // v0.10.0（0-4a）：可选扩展字段（非空才写入）+ v0.10.0（task-83）：未知字段保留。
    // 旧数据（仅已知字段且无新增可选值）直接返回 known → 输出字节级不变。
    const optional = normalizeShotOptional(shot, `第 ${index + 1} 个镜头`)
    const unknownEntries = Object.keys(shot)
      .filter((key) => !SHOT_RESERVED_KEYS.includes(key))
      .sort()
      .map((key) => [key, shot[key]])
      .filter(([, value]) => value !== undefined)
    if (!Object.keys(optional).length && !unknownEntries.length) return known
    return Object.fromEntries([...Object.entries(known), ...Object.entries(optional), ...unknownEntries])
  })
}

/** 分镜 Markdown 渲染（已知字段字节级兼容旧版；有可选字段时追加列；有分组时追加分组章节）。 */
function renderStoryboardMarkdown(title, order, normalized, groups = null) {
  // v0.11.1：sceneRef 不参与分镜表列渲染（add-only 存储字段，导出互通留 2-5），旧格式字节不变
  const hasOptional = normalized.some((shot) => SHOT_OPTIONAL_KEYS.some((key) => key !== 'sceneRef' && key !== 'scriptExcerpt' && key !== 'stagingImage' && key !== 'assetIds' && key !== 'assetStateBindings' && Object.hasOwn(shot, key)))
  const baseHeaders = ['镜号', '景别', '运镜', '画面描述', '台词', '音效', '时长(秒)', '提示词', '视频提示词']
  const extraHeaders = ['情绪', '光影', '现场声', '禁令', '起止姿态', '衔接', '自然语言段', '焦段', '主体', '分组']
  const headers = hasOptional ? [...baseHeaders, ...extraHeaders] : baseHeaders
  const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const renderShot = (shot) => {
    // v0.16.218：未定义（null）时长在 md 表显示空；旧显式 0 保留原数字，不伪造。
    const durationCell = shot.durationSec == null ? '' : shot.durationSec
    const base = [shot.shotNumber, shot.shotSize, shot.cameraMove, shot.description, shot.dialogue, shot.sfx, durationCell, shot.imagePrompt, shot.videoPrompt]
    if (!hasOptional) return base
    const emotion = shot.emotion ? `${shot.emotion.label} ${shot.emotion.intensity}/100` : ''
    const poses = shot.poses ? `${shot.poses.startPose} → ${shot.poses.endPose}` : ''
    const constraints = Array.isArray(shot.constraints) ? shot.constraints.join('；') : ''
    return [...base, emotion, shot.light || '', shot.ambientSound || '', constraints, poses, shot.transitionToNext || '', shot.naturalLanguagePrompt || '', shot.lens || '', shot.subject || '', shot.groupId || '']
  }
  const lines = [
    `# ${assertSafeTitle(title)} · ${episodeFileName(order).replace('.md', '')} 分镜表`,
    '',
    '> 由「AI 短剧」工作区生成，源数据 `.aidrama/storyboard/`。',
    '',
  ]
  if (Array.isArray(groups) && groups.length) {
    lines.push('## 分组情绪总控', '')
    for (const group of groups) {
      const emotionParts = []
      if (group.emotion?.curve?.length) emotionParts.push(`情绪曲线：${group.emotion.curve.join('→')}`)
      if (group.emotion?.intensity != null) emotionParts.push(`强度 ${group.emotion.intensity}/100`)
      lines.push(`### ${group.id}${group.name ? ` ${group.name}` : ''}`)
      lines.push(`- 镜号：${(group.shotNumbers || []).join('、') || '—'}`)
      if (group.durationTargetSec != null) lines.push(`- 目标时长：${group.durationTargetSec} 秒`)
      if (emotionParts.length) lines.push(`- ${emotionParts.join('；')}`)
      if (group.notes) lines.push(`- 备注：${group.notes}`)
      lines.push('')
    }
  }
  lines.push(
    hasOptional
      ? `| ${headers.join(' | ')} |`
      : '| 镜号 | 景别 | 运镜 | 画面描述 | 台词 | 音效 | 时长(秒) | 提示词 | 视频提示词 |',
    hasOptional
      ? `|${headers.map(() => '---').join('|')}|`
      : '|---|---|---|---|---|---|---|---|---|',
    ...normalized.map((shot) => `| ${renderShot(shot).map(cell).join(' | ')} |`),
    '',
    `> 共 ${normalized.length} 个镜头，合计 ${normalized.reduce((sum, s) => sum + s.durationSec, 0)} 秒`,
    '',
  )
  // v0.16.95（P0 写面 add-only）：剧本摘录独立章节（不进表格列；无字段时旧 md 字节不变）。
  const excerptShots = normalized.filter((shot) => String(shot.scriptExcerpt ?? '').trim())
  if (excerptShots.length) {
    lines.push('## 剧本摘录', '', '| 镜号 | 剧本原文摘录 |', '|---|---|')
    for (const shot of excerptShots) lines.push(`| ${cell(shot.shotNumber)} | ${cell(shot.scriptExcerpt)} |`)
    lines.push('')
  }
  return lines.join('\n')
}

async function writeTextFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await atomicWrite(file, content)
}

async function readFileOrNull(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function restoreFile(file, content) {
  if (content == null) {
    await fs.rm(file, { recursive: true, force: true })
    return
  }
  await writeTextFile(file, content)
}

export async function saveStoryboard(root, title, order, shots) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const normalized = await preserveLegacyShotSizes(dir, order, normalizeShots(shots, order))
  await validateShotStateBindingsExist(root, title, normalized)
  // 保持与 v0.9.x 相同的快照 key（历史版本只在同时存在对应文件时才留档，旧行为不改）
  await snapshot(dir, `storyboard-${episodeFileName(order)}`)
  await writeProjectFile(dir, path.join(metaDir(dir), 'storyboard', `${episodeFileName(order)}.json`), JSON.stringify(normalized, null, 2) + '\n')
  await writeProjectFile(dir, path.join(dir, '分镜', `${episodeFileName(order).replace('.md', '')}.分镜.md`), renderStoryboardMarkdown(title, order, normalized, null))
  return normalized
}

/* ------------------------------------- 分镜分组（v0.10.0 0-4b，add-only sidecar） */

/**
 * v0.10.1（task-81）：分镜单文件（storyboard JSON + 分镜 Markdown）事务保存。
 * 供导入桥使用：无分组输入时保持 sidecar 不变，但写失败必须回滚（与 saveStoryboardWithGroups 对齐）。
 */
export async function saveStoryboardTransactional(root, title, order, shots) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const normalized = await preserveLegacyShotSizes(dir, order, normalizeShots(shots, order))
  await validateShotStateBindingsExist(root, title, normalized)
  const storyboardFile = path.join(metaDir(dir), 'storyboard', `${episodeFileName(order)}.json`)
  const markdownFile = path.join(dir, '分镜', `${episodeFileName(order).replace('.md', '')}.分镜.md`)
  const backups = new Map()
  for (const file of [storyboardFile, markdownFile]) backups.set(file, await readFileOrNull(file))
  try {
    await snapshot(dir, `storyboard-${episodeFileName(order)}`)
    await writeProjectFile(dir, storyboardFile, JSON.stringify(normalized, null, 2) + '\n')
    await writeProjectFile(dir, markdownFile, renderStoryboardMarkdown(title, order, normalized, null))
  } catch (error) {
    // 回滚尽力而为：单个文件恢复失败（如父目录被替换/不可写）不应阻止其它文件恢复；
    // 原始错误始终向上抛出，不因回滚失败而被吞掉或替换。
    for (const [file, content] of backups) {
      try {
        await restoreFile(file, content)
      } catch {
        /* 尽力恢复其它文件 */
      }
    }
    throw error
  }
  return normalized
}

/** 分组 sidecar 路径：`.aidrama/storyboard-groups/<集>.json`（PM/Lead 裁定：不新增顶层节点）。 */
function storyboardGroupsFile(dir, order) {
  return path.join(metaDir(dir), 'storyboard-groups', `${episodeFileName(order)}.json`)
}

/**
 * 归一分组数组；`[]` = 清空。
 * @param {Array} groups 分组数组
 * @param {string[]} shotNumbers 本集现有镜号（用于关联校验）
 * @param {string} where 错误定位前缀
 */
function normalizeStoryboardGroups(groups, shotNumbers, where) {
  if (!Array.isArray(groups)) throw invalidArgsError(`${where} 必须是数组（[] 表示清空）`)
  if (groups.length > 50) throw invalidArgsError(`${where} 分组数量过多（上限 50）`)
  const shotSet = new Set(shotNumbers)
  const usedShots = new Map()
  const usedIds = new Set()
  return groups.map((group, index) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw invalidArgsError(`${where}[${index}] 必须是对象`)
    const id = typeof group.id === 'string' ? group.id.trim().slice(0, 20) : ''
    if (!id) throw invalidArgsError(`${where}[${index}].id 必填（非空字符串，≤20 字）`)
    if (usedIds.has(id)) throw invalidArgsError(`${where} 分组 id 重复：${id}`)
    usedIds.add(id)
    const normalized = { id }
    if (group.name != null) {
      if (typeof group.name !== 'string') throw invalidArgsError(`${where}[${index}].name 必须是字符串`)
      const name = group.name.trim().slice(0, 60)
      if (name) normalized.name = name
    }
    const list = []
    if (group.shotNumbers != null) {
      if (!Array.isArray(group.shotNumbers)) throw invalidArgsError(`${where}[${index}].shotNumbers 必须是镜号数组`)
      for (const rawShot of group.shotNumbers) {
        if (typeof rawShot !== 'string' || !rawShot.trim()) throw invalidArgsError(`${where}[${index}].shotNumbers 只能是字符串镜号`)
        const shotNumber = rawShot.trim().slice(0, 20)
        if (!shotSet.has(shotNumber)) throw invalidArgsError(`${where}[${index}].shotNumbers 引用了不存在的镜号：${shotNumber}`)
        if (usedShots.has(shotNumber)) throw invalidArgsError(`${where} 同一镜只能属于一个分组：${shotNumber}（已在 ${usedShots.get(shotNumber)}）`)
        usedShots.set(shotNumber, id)
        list.push(shotNumber)
      }
    }
    normalized.shotNumbers = list
    if (group.emotion != null) {
      if (typeof group.emotion !== 'object' || Array.isArray(group.emotion)) throw invalidArgsError(`${where}[${index}].emotion 必须是对象`)
      const emotion = {}
      if (group.emotion.curve != null) {
        if (!Array.isArray(group.emotion.curve) || group.emotion.curve.length > 6) throw invalidArgsError(`${where}[${index}].emotion.curve 必须是字符串数组（≤6）`)
        const curve = group.emotion.curve.map((item) => String(item ?? '').trim().slice(0, 20)).filter(Boolean)
        if (curve.length) emotion.curve = curve
      }
      if (group.emotion.intensity != null) {
        const intensity = Number(group.emotion.intensity)
        if (!Number.isFinite(intensity) || intensity < 0 || intensity > 100) throw invalidArgsError(`${where}[${index}].emotion.intensity 必须是 0~100 的数字`)
        emotion.intensity = Math.round(intensity)
      }
      if (Object.keys(emotion).length) normalized.emotion = emotion
    }
    if (group.durationTargetSec != null) {
      const duration = Number(group.durationTargetSec)
      if (!Number.isFinite(duration) || duration <= 0 || duration > 600) throw invalidArgsError(`${where}[${index}].durationTargetSec 必须是 1~600 的数字`)
      normalized.durationTargetSec = Math.round(duration)
    }
    if (group.notes != null) {
      if (typeof group.notes !== 'string') throw invalidArgsError(`${where}[${index}].notes 必须是字符串`)
      const notes = group.notes.trim().slice(0, 500)
      if (notes) normalized.notes = notes
    }
    // 未知字段保留（只增，排序追加；便于后续扩展）
    const unknown = Object.keys(group)
      .filter((key) => !['id', 'name', 'shotNumbers', 'emotion', 'durationTargetSec', 'notes'].includes(key))
      .sort()
      .map((key) => [key, group[key]])
      .filter(([, value]) => value !== undefined)
    if (unknown.length) Object.assign(normalized, Object.fromEntries(unknown))
    return normalized
  })
}

function wrapStoryboardGroups(order, groups) {
  return { schemaVersion: 1, episode: Number(order), updatedAt: new Date().toISOString(), groups }
}

/** 读取分镜分组 sidecar；不存在/损坏 → null（旧项目兼容，不阻断）。 */
export async function getStoryboardGroups(root, title, order) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const raw = await readFileOrNull(storyboardGroupsFile(dir, order))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    const groups = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.groups) ? parsed.groups : null
    return Array.isArray(groups) ? groups : null
  } catch {
    return null
  }
}

/** v0.11.2（task-98 / 2-4 E7）：读侧 groups 映射上限（组数）与单组 groupPrompt 字数上限。 */
export const GROUPS_READ_LIMIT = 100
export const GROUP_PROMPT_READ_LIMIT = 2000

/**
 * v0.11.2（task-98 / 2-4 E7）：sidecar groups → 读侧响应映射（纯函数、确定性、无时间戳）。
 * 输出 [{ groupId, name, emotionCue, shotNumbers[], groupPrompt? }]
 * - 顺序 = sidecar 数组顺序（不排序）；组数 >100 → 截断前 100 并返回 truncated=true；
 * - emotionCue = emotion.curve.join('→') +（有 intensity 时 `（n/100）`）；name/emotionCue 缺省 ''；
 * - groupPrompt = notes（非空才输出，≤2000 字确定性截断）；durationTargetSec 等其它字段不输出。
 */
export function buildStoryboardGroupsView(groups) {
  const list = Array.isArray(groups) ? groups : []
  const truncated = list.length > GROUPS_READ_LIMIT
  const view = list.slice(0, GROUPS_READ_LIMIT).map((group) => {
    const source = group && typeof group === 'object' ? group : {}
    const curve = Array.isArray(source.emotion?.curve)
      ? source.emotion.curve.map((item) => String(item ?? '').trim()).filter(Boolean)
      : []
    const intensity = Number(source.emotion?.intensity)
    const emotionCue = curve.length
      ? `${curve.join('→')}${Number.isFinite(intensity) ? `（${Math.round(intensity)}/100）` : ''}`
      : ''
    const item = {
      groupId: typeof source.id === 'string' ? source.id : '',
      name: typeof source.name === 'string' ? source.name : '',
      emotionCue,
      shotNumbers: Array.isArray(source.shotNumbers) ? source.shotNumbers.slice() : [],
    }
    const notes = typeof source.notes === 'string' ? source.notes.trim() : ''
    if (notes) item.groupPrompt = notes.slice(0, GROUP_PROMPT_READ_LIMIT)
    return item
  })
  return { groups: view, truncated }
}

/** v0.16.95（P0 写面 add-only）：读取分镜/分组当前 sha256 与 expectedHash（仅显式请求/保存后返回）。 */
export async function readStoryboardHashes(root, title, order) {
  const dir = projectDir(root, title)
  const episode = episodeFileName(order)
  const storyboardRel = `.aidrama/storyboard/${episode}.json`
  const groupsRel = `.aidrama/storyboard-groups/${episode}.json`
  const readHash = async (abs) => {
    const buffer = await readFileOrNull(abs)
    return buffer === null ? null : createHash('sha256').update(buffer).digest('hex')
  }
  const storyboardHash = await readHash(path.join(metaDir(dir), 'storyboard', `${episode}.json`))
  const groupsHash = await readHash(storyboardGroupsFile(dir, order))
  const expectedHash = {}
  if (storyboardHash) expectedHash[storyboardRel] = storyboardHash
  if (groupsHash) expectedHash[groupsRel] = groupsHash
  return { storyboard: storyboardHash, groups: groupsHash, expectedHash }
}

/**
 * v0.11.2（task-98 / 2-4 E7）：storyboard 读取响应（只读，不写盘）。
 * - 返回 { shots }；**仅当 sidecar 存在且可解析时**追加 groups（数组）；
 * - 组数 >100 时追加 `groupsTruncated:true`（顶层、仅截断时出现）；
 * - 无 sidecar / sidecar 损坏 → 不输出 groups、不报错（旧输出逐字节不变）。
 * - v0.16.39（client 并发保护 add-only）：options.includeHashes=true → 追加 hashes（只读）。
 */
export async function getStoryboardReadView(root, title, order, options = {}) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const shots = await getStoryboard(root, title, order)
  const groups = await getStoryboardGroups(root, title, order)
  const bindingPairs = []
  for (const shot of shots) {
    if (!Array.isArray(shot.assetStateBindings)) continue
    for (const binding of shot.assetStateBindings) {
      if (binding && typeof binding.cardId === 'string' && typeof binding.stateId === 'string') bindingPairs.push(binding)
    }
  }
  let bindingWarnings = []
  if (bindingPairs.length) {
    const cards = await getAssetCards(root, title).catch(() => [])
    const map = new Map((Array.isArray(cards) ? cards : []).map((card) => [String(card.id || '').toUpperCase(), card]))
    for (const binding of bindingPairs) {
      const card = map.get(String(binding.cardId || '').toUpperCase()) || null
      if (!card) {
        bindingWarnings.push({ code: 'card-missing', cardId: binding.cardId, stateId: binding.stateId })
        continue
      }
      const states = card.media && Array.isArray(card.media.states) ? card.media.states : []
      if (!states.some((state) => String(state.id || '') === String(binding.stateId || ''))) {
        bindingWarnings.push({ code: 'state-missing', cardId: binding.cardId, stateId: binding.stateId })
      }
    }
  }
  const view = !Array.isArray(groups)
    ? { shots }
    : (() => {
        const { groups: groupView, truncated } = buildStoryboardGroupsView(groups)
        return truncated ? { shots, groups: groupView, groupsTruncated: true } : { shots, groups: groupView }
      })()
  if (bindingWarnings.length) view.assetStateBindingWarnings = bindingWarnings
  if (options && options.includeHashes === true) {
    view.hashes = await readStoryboardHashes(root, title, order)
  }
  return view
}

/** 保存分镜分组（独立写；[] 清空/删除 sidecar）。 */
export async function saveStoryboardGroups(root, title, order, groups) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const shots = await getStoryboard(root, title, order)
  const normalized = normalizeStoryboardGroups(groups, shots.map((shot) => String(shot.shotNumber || '').trim()).filter(Boolean), `第 ${order} 集分组`)
  const file = storyboardGroupsFile(dir, order)
  if (!normalized.length) {
    await rmProjectFile(dir, file)
    return []
  }
  await writeProjectFile(dir, file, JSON.stringify(wrapStoryboardGroups(order, normalized), null, 2) + '\n')
  return normalized
}

/** 删除分镜分组 sidecar。 */
export async function deleteStoryboardGroups(root, title, order) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  await rmProjectFile(dir, storyboardGroupsFile(dir, order))
}

/**
 * v0.10.0（0-4b）：storyboard JSON + groups sidecar 双文件事务保存。
 * - 先整体校验（非法值不会产生任何写入）；
 * - 写失败回滚两侧文件与分镜 Markdown（恢复调用前内容）；
 * - groups=[] 表示清空 sidecar；旧项目（无 sidecar）行为与 saveStoryboard 一致。
 */
export async function saveStoryboardWithGroups(root, title, order, shots, groups) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const normalizedShots = await preserveLegacyShotSizes(dir, order, normalizeShots(shots, order))
  await validateShotStateBindingsExist(root, title, normalizedShots)
  const shotNumbers = normalizedShots.map((shot) => String(shot.shotNumber || '').trim()).filter(Boolean)
  const normalizedGroups = normalizeStoryboardGroups(groups, shotNumbers, `第 ${order} 集分组`)
  const storyboardFile = path.join(metaDir(dir), 'storyboard', `${episodeFileName(order)}.json`)
  const markdownFile = path.join(dir, '分镜', `${episodeFileName(order).replace('.md', '')}.分镜.md`)
  const groupsFile = storyboardGroupsFile(dir, order)
  const backups = new Map()
  for (const file of [storyboardFile, markdownFile, groupsFile]) backups.set(file, await readFileOrNull(file))
  try {
    if (normalizedGroups.length) await writeProjectFile(dir, groupsFile, JSON.stringify(wrapStoryboardGroups(order, normalizedGroups), null, 2) + '\n')
    else await rmProjectFile(dir, groupsFile)
    await writeProjectFile(dir, storyboardFile, JSON.stringify(normalizedShots, null, 2) + '\n')
    await writeProjectFile(dir, markdownFile, renderStoryboardMarkdown(title, order, normalizedShots, normalizedGroups))
  } catch (error) {
    // 回滚尽力而为：单个文件恢复失败（如父目录被替换/不可写）不应阻止其它文件恢复；
    // 原始错误始终向上抛出，不因回滚失败而被吞掉或替换。
    for (const [file, content] of backups) {
      try {
        await restoreFile(file, content)
      } catch {
        /* 尽力恢复其它文件 */
      }
    }
    throw error
  }
  return { shots: normalizedShots, groups: normalizedGroups }
}

/**
 * v0.16.39（task-233）：分镜单镜 groupId 编辑（add-only；与 shots/groups 互斥由 route 保证）。
 * - target group 必须存在；空串/null = 清除；groupId >20 不允许（新路径不静默截断）；
 * - 双向同步 shot.groupId ↔ groups[].shotNumbers；
 * - 仅编辑涉及的 shot 做旧数据一致性检查；不一致 → group-inconsistent（零写）；
 * - 复用 saveStoryboardWithGroups 三文件原子写/回滚。
 */
export async function editStoryboardGroupIds(root, title, order, edits) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > 500) throw invalidArgsError('groupIdEdits 必须是 1..500 项的数组')
  const shots = await getStoryboard(root, title, order)
  const rawGroups = (await getStoryboardGroups(root, title, order)) || []
  if (!Array.isArray(rawGroups)) throw invalidArgsError('分镜分组数据不合法')
  const groups = rawGroups.map((group) => ({ ...group, shotNumbers: Array.isArray(group.shotNumbers) ? group.shotNumbers.slice() : [] }))
  const groupMap = new Map(groups.map((group) => [String(group.id), group]))
  const shotMap = new Map(shots.map((shot) => [String(shot.shotNumber || '').trim(), shot]))
  const seen = new Set()
  const planned = []
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw invalidArgsError('groupIdEdits 项必须是对象')
    for (const key of Object.keys(edit)) if (!['shotNumber', 'groupId'].includes(key)) throw invalidArgsError(`groupIdEdits 项不支持字段：${key}`)
    const shotNumber = typeof edit.shotNumber === 'string' ? edit.shotNumber.trim() : ''
    if (!shotNumber || shotNumber.length > 20) throw invalidArgsError('groupIdEdits.shotNumber 必须是 1..20 字字符串')
    if (seen.has(shotNumber)) throw invalidArgsError(`groupIdEdits 重复镜号：${shotNumber}`)
    seen.add(shotNumber)
    const shot = shotMap.get(shotNumber)
    if (!shot) throw invalidArgsError(`groupIdEdits 引用了不存在的镜号：${shotNumber}`)
    let groupId = ''
    if (edit.groupId !== null && edit.groupId !== undefined) {
      if (typeof edit.groupId !== 'string') throw invalidArgsError(`groupIdEdits[${shotNumber}].groupId 必须是字符串或 null`)
      groupId = edit.groupId.trim()
      if (groupId.length > 20) throw invalidArgsError(`groupIdEdits[${shotNumber}].groupId 超长（${groupId.length} > 20）`)
    }
    if (groupId && !groupMap.has(groupId)) throw invalidArgsError(`groupIdEdits 引用了不存在的分组：${groupId}`)
    const members = groups.filter((group) => group.shotNumbers.includes(shotNumber))
    if (members.length > 1) throw Object.assign(new Error(`镜号 ${shotNumber} 同时属于多个分组`), { code: 'group-inconsistent' })
    const member = members[0] ? String(members[0].id) : ''
    const shotGroup = typeof shot.groupId === 'string' ? shot.groupId.trim() : ''
    if (shotGroup !== member) throw Object.assign(new Error(`镜号 ${shotNumber} 的 shot.groupId 与分组归属不一致`), { code: 'group-inconsistent' })
    planned.push({ shotNumber, shot, from: member, to: groupId })
  }
  const changes = []
  for (const item of planned) {
    if (item.from === item.to) continue
    for (const group of groups) group.shotNumbers = group.shotNumbers.filter((shotNumber) => shotNumber !== item.shotNumber)
    if (item.to) groupMap.get(item.to).shotNumbers.push(item.shotNumber)
    if (item.to) item.shot.groupId = item.to
    else delete item.shot.groupId
    changes.push({ shotNumber: item.shotNumber, from: item.from, to: item.to })
  }
  if (!changes.length) return { shots, groups: rawGroups, groupsSaved: rawGroups.length > 0, updated: 0, changes: [] }
  const saved = await saveStoryboardWithGroups(root, title, order, shots, groups)
  return { shots: saved.shots, groups: saved.groups, groupsSaved: saved.groups.length > 0, updated: changes.length, changes }
}

/* ---------------------------------------------------------------- 检索 */

export async function search(root, query, options = {}) {
  const text = String(query ?? '').trim()
  if (!text) return { query: text, hits: [], truncated: false }
  const lower = text.toLowerCase()
  const limit = Math.min(Number(options.limit) || SEARCH_LIMIT, SEARCH_LIMIT)

  const hits = []
  let scanned = 0
  let truncated = false

  async function walk(dir, rel) {
    if (hits.length >= limit || scanned >= SEARCH_SCAN_LIMIT) {
      truncated = true
      return
    }
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (hits.length >= limit || scanned >= SEARCH_SCAN_LIMIT) {
        truncated = true
        return
      }
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name === META_DIR) continue
        await walk(path.join(dir, entry.name), nextRel)
        continue
      }
      if (!/\.(md|txt)$/i.test(entry.name)) continue
      scanned += 1
      let content
      try {
        content = await fs.readFile(path.join(dir, entry.name), 'utf8')
      } catch {
        continue
      }
      const lines = content.split(/\r?\n/)
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].toLowerCase().includes(lower)) {
          hits.push({
            path: nextRel,
            line: i + 1,
            text: lines[i].trim().slice(0, 200),
          })
          if (hits.length >= limit) {
            truncated = true
            break
          }
        }
      }
    }
  }

  const base = projectsBase(root)
  let projects = []
  try {
    projects = (await fs.readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name !== SHARED_DIRNAME)
  } catch {
    /* 忽略 */
  }

  // 项目名命中优先返回
  for (const project of projects) {
    if (project.name.toLowerCase().includes(lower)) {
      hits.push({ path: project.name, line: 0, text: `（短剧名称命中）${project.name}`, title: project.name })
      if (hits.length >= limit) break
    }
  }
  for (const project of projects) {
    if (hits.length >= limit) {
      truncated = true
      break
    }
    await walk(path.join(base, project.name), project.name)
  }

  return { query: text, hits, truncated, scanned }
}

/* ---------------------------------------------------------------- 本剧记忆 */

export const MEMORY_KINDS = ['伏笔', '已用桥段', '时间线', '待回收']

export async function getMemory(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  return readJsonDoc(dir, 'memory', [])
}

export async function saveMemory(root, title, entries) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  if (!Array.isArray(entries)) throw new Error('本剧记忆必须是条目数组')
  if (entries.length > 500) throw new Error('记忆条目过多（上限 500）')

  const seenIds = new Set()
  const normalized = entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`第 ${index + 1} 条记忆格式不正确`)
    const content = String(entry.content || '').trim()
    if (!content) throw new Error(`第 ${index + 1} 条记忆内容不能为空`)
    let id = String(entry.id || '').trim() || `m-${index + 1}-${Date.now().toString(36)}`
    if (seenIds.has(id)) id = `${id}-${index}`
    seenIds.add(id)
    return {
      id,
      kind: MEMORY_KINDS.includes(entry.kind) ? entry.kind : '伏笔',
      content: content.slice(0, 1000),
      episode: Number.isFinite(Number(entry.episode)) && Number(entry.episode) > 0 ? Math.round(Number(entry.episode)) : null,
      status: entry.status === 'resolved' ? 'resolved' : 'open',
      createdAt: entry.createdAt || new Date().toISOString(),
    }
  })

  await writeJsonDoc(dir, 'memory', normalized)

  const title2 = assertSafeTitle(title)
  const groups = MEMORY_KINDS.map((kind) => [kind, normalized.filter((e) => e.kind === kind)]).filter(([, list]) => list.length)
  const md = [
    `# ${title2} · 本剧记忆`,
    '',
    '> 由「AI 短剧」工作区生成，源数据 `.aidrama/memory.json`。',
    '> 生成新内容前先读这里，可避免人物 OOC、设定冲突与桥段重复。',
    '',
    ...(groups.length
      ? groups.flatMap(([kind, list]) => [
          `## ${kind}`,
          '',
          ...list.map((e) => `- [${e.status === 'resolved' ? 'x' : ' '}] ${e.content}${e.episode ? `（第 ${e.episode} 集）` : ''}`),
          '',
        ])
      : ['_（暂无记忆条目）_', '']),
  ].join('\n')
  await writeProjectFile(dir, path.join(dir, '本剧记忆', '本剧记忆.md'), md)
  return normalized
}

/* ------------------------------------------------------------ 创作进度 */

const STAGES = [
  ['project', '项目已建'],
  ['outline', '大纲就绪'],
  ['characters', '人物就绪'],
  ['episode_script', '剧本就绪'],
  ['storyboard', '分镜就绪'],
  ['exported', '已导出'],
]

/** 由既有数据推导创作进度（FR-D05 状态机的确定性部分）。 */
export async function getProgress(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)

  const [contract, outline, characters, episodes] = await Promise.all([
    getContract(root, title),
    getOutline(root, title),
    getCharacters(root, title),
    listEpisodes(root, title),
  ])
  const memory = await readJsonDoc(dir, 'memory', [])

  let storyboards = 0
  for (const episode of episodes) {
    if ((await getStoryboard(root, title, episode.order)).length) storyboards += 1
  }
  let exported = 0
  try {
    exported = (await fs.readdir(path.join(dir, '导出'))).length
  } catch {
    exported = 0
  }

  const done = {
    project: true,
    outline: outline.length > 0,
    characters: characters.length > 0,
    episode_script: episodes.length > 0,
    storyboard: storyboards > 0,
    exported: exported > 0,
  }

  let stage = 'project'
  for (const [key] of STAGES) if (done[key]) stage = key

  return {
    stage,
    steps: STAGES.map(([key, label]) => ({ key, label, done: Boolean(done[key]) })),
    facts: {
      targetEpisodes: contract.targetEpisodes || 0,
      outlineCount: outline.length,
      characterCount: characters.length,
      episodeCount: episodes.length,
      storyboardCount: storyboards,
      memoryCount: memory.length,
      openMemoryCount: memory.filter((m) => m.status === 'open').length,
      exportCount: exported,
    },
  }
}

/* ---------------------------------------------------------------- 世界观 */

/** v0.16.82：世界观 8 大类（固定顺序）+ 每级默认二级页签（Lead 批固定顺序）+ 其他兜底。 */
export const WORLD_KINDS = ['天地地理', '时间历史', '力量法则', '种族物种', '社会政体', '文化信仰', '资源物产', '冲突矛盾']
export const WORLD_SUBTABS = Object.freeze({
  天地地理: Object.freeze(['地点', '区域', '气候', '地貌']),
  时间历史: Object.freeze(['年表', '历史事件', '时代', '时间规则']),
  力量法则: Object.freeze(['力量体系', '等级', '代价', '禁忌']),
  种族物种: Object.freeze(['种族', '生态', '种族关系']),
  社会政体: Object.freeze(['势力', '阵营', '政体制度']),
  文化信仰: Object.freeze(['信仰', '习俗', '禁忌', '节日']),
  资源物产: Object.freeze(['道具', '服饰', '建筑', '饮食', '语言', '货币', '材料']),
  冲突矛盾: Object.freeze(['冲突', '矛盾', '伏笔', '反派']),
})
/** @deprecated v0.16.82：旧全局 extension 枚举 → 默认表并集别名（仅兼容引用；新代码用 WORLD_SUBTABS）。 */
export const WORLD_EXTENSIONS = Object.freeze([...new Set(Object.values(WORLD_SUBTABS).flat())])
export const WORLD_KIND_OTHER = '其他'
const WORLD_KIND_LEGACY = Object.freeze({ 地点: '天地地理', 组织: '社会政体', 规则: '力量法则', 时间线: '时间历史' })
/** v0.16.79：契约 8 字段 → 8 大类总述（语义映射；第 8 项 soulDeath 语义不对应，迁入冲突矛盾并加人工调整提示）。 */
const WORLD_CONTRACT_SUMMARIES = Object.freeze([
  ['worldSpace', '天地地理'],
  ['worldTime', '时间历史'],
  ['powerSystem', '力量法则'],
  ['speciesEcology', '种族物种'],
  ['factions', '社会政体'],
  ['cultureBelief', '文化信仰'],
  ['resourceEconomy', '资源物产'],
  ['soulDeath', '冲突矛盾'],
])
const WORLD_SUMMARY_EXTENSION = '道具'
const WORLD_SOUL_DEATH_HINT = '（原契约第 8 项「灵魂/生死/因果」已迁入本类总述，语义不完全对应，请人工调整。）'

/** v0.16.82：二级页签名归一（自由文本；trim、控制字符清空、≤20 code points；基础/全部保留字→空）。 */
function normalizeWorldExtension(value) {
  let text = String(value == null ? '' : value).trim()
  if (!text) return ''
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  if (!text || text === '基础' || text === '全部') return ''
  return [...text].slice(0, 20).join('')
}

/** 归一 kind/extension：旧 5 类映射、道具→资源物产+extension=道具、空→首类、未知→其他。 */
function normalizeWorldKind(value, extensionValue) {
  const raw = String(value == null ? '' : value).trim()
  const extension = normalizeWorldExtension(extensionValue)
  if (!raw) return { kind: WORLD_KINDS[0], extension }
  if (raw === WORLD_SUMMARY_EXTENSION) return { kind: '资源物产', extension: WORLD_SUMMARY_EXTENSION }
  if (Object.prototype.hasOwnProperty.call(WORLD_KIND_LEGACY, raw)) return { kind: WORLD_KIND_LEGACY[raw], extension }
  if (WORLD_KINDS.includes(raw)) return { kind: raw, extension }
  return { kind: WORLD_KIND_OTHER, extension }
}

/* ---------------------------------------------------------------- 世界观 v2（RC-75 / v0.16.268） */

/* ---------------------------------------------------------------- 世界观 v3（RC-84 / v0.16.279） */

export const WORLD_SCHEMA_VERSION = 3
const WORLD_SUMMARY_MAX = 4000
const WORLD_NAME_MAX = 60
const WORLD_DETAIL_MAX = 2000
const WORLD_RULES_MAX = 200
const WORLD_ENTRIES_MAX = 500
const WORLD_ID_MAX = 120
const WORLD_LABEL_MAX = 20
const WORLD_LABELS_MAX = 100

function worldV3Error(message) {
  const error = new Error(message)
  error.code = 'invalid-args'
  return error
}

function isWorldDocV2(raw) {
  return Boolean(raw && typeof raw === 'object' && !Array.isArray(raw) &&
    (Number(raw.schemaVersion) === 2 || (Array.isArray(raw.categories) && raw.schemaVersion !== undefined && Number(raw.schemaVersion) !== 3)))
}

function isWorldDocV3(raw) {
  return Boolean(raw && typeof raw === 'object' && !Array.isArray(raw) &&
    (Number(raw.schemaVersion) === 3 || (Array.isArray(raw.categories) && raw.schemaVersion === undefined)))
}

function worldKindIndex(kind) {
  const index = WORLD_KINDS.indexOf(kind)
  return index >= 0 ? index : WORLD_KINDS.length
}

function normalizeRuleList(raw, kind, kindIndex) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw worldV3Error(`类别「${kind}」的 rules 必须是数组`)
  if (raw.length > WORLD_RULES_MAX) throw worldV3Error(`类别「${kind}」的 rules 超过 ${WORLD_RULES_MAX} 条`)
  const seen = new Set()
  const rules = []
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw worldV3Error(`类别「${kind}」规则第 ${index + 1} 条格式不正确`)
    for (const key of Object.keys(item)) {
      if (!['id', 'name', 'detail'].includes(key)) throw worldV3Error(`类别「${kind}」规则不支持字段：${key}`)
    }
    const name = String(item.name == null ? '' : item.name).trim()
    if (!name) throw worldV3Error(`类别「${kind}」规则第 ${index + 1} 条缺少 name`)
    if ([...name].length > WORLD_NAME_MAX) throw worldV3Error(`类别「${kind}」规则名超过 ${WORLD_NAME_MAX} 字`)
    if (seen.has(name)) throw worldV3Error(`类别「${kind}」规则名重复：${name}`)
    seen.add(name)
    const detail = String(item.detail == null ? '' : item.detail).trim()
    if (detail.length > WORLD_DETAIL_MAX) throw worldV3Error(`类别「${kind}」规则「${name}」说明超过 ${WORLD_DETAIL_MAX} 字`)
    const id = String(item.id == null ? '' : item.id).trim().slice(0, WORLD_ID_MAX) || `r-${kindIndex + 1}-${index + 1}`
    rules.push({ id, name, detail })
  })
  return rules
}

function normalizeTertiaryTags(raw, kind) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw worldV3Error(`类别「${kind}」的 tertiaryTags 必须是数组`)
  const seenExtensions = new Set()
  const tags = []
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw worldV3Error(`类别「${kind}」三级标签第 ${index + 1} 项格式不正确`)
    for (const key of Object.keys(item)) {
      if (!['extension', 'labels'].includes(key)) throw worldV3Error(`类别「${kind}」三级标签不支持字段：${key}`)
    }
    const extension = normalizeWorldExtension(item.extension)
    if (seenExtensions.has(extension)) throw worldV3Error(`类别「${kind}」三级标签 extension 重复：${extension || '（基础）'}`)
    seenExtensions.add(extension)
    if (!Array.isArray(item.labels)) throw worldV3Error(`类别「${kind}」三级标签 labels 必须是数组`)
    if (item.labels.length > WORLD_LABELS_MAX) throw worldV3Error(`类别「${kind}」三级标签超过 ${WORLD_LABELS_MAX} 个`)
    const labels = []
    for (const labelRaw of item.labels) {
      if (typeof labelRaw !== 'string') throw worldV3Error(`类别「${kind}」三级标签名必须是字符串`)
      const label = labelRaw.trim()
      if (!label) continue
      if ([...label].length > WORLD_LABEL_MAX) throw worldV3Error(`三级标签名超过 ${WORLD_LABEL_MAX} 字：${label}`)
      if (!labels.includes(label)) labels.push(label)
    }
    tags.push({ extension, labels })
  })
  return tags
}

function normalizeEntryList(raw, kind, kindIndex, totalBefore) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw worldV3Error(`类别「${kind}」的 entries 必须是数组`)
  if (totalBefore + raw.length > WORLD_ENTRIES_MAX) throw worldV3Error(`entries 总数超过 ${WORLD_ENTRIES_MAX}`)
  const seen = new Set()
  const entries = []
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw worldV3Error(`类别「${kind}」条目第 ${index + 1} 条格式不正确`)
    for (const key of Object.keys(item)) {
      if (!['id', 'name', 'detail', 'extension', 'tertiary'].includes(key)) throw worldV3Error(`类别「${kind}」条目不支持字段：${key}`)
    }
    const name = String(item.name == null ? '' : item.name).trim()
    if (!name) throw worldV3Error(`类别「${kind}」条目第 ${index + 1} 条缺少 name`)
    if ([...name].length > WORLD_NAME_MAX) throw worldV3Error(`类别「${kind}」条目名超过 ${WORLD_NAME_MAX} 字`)
    if (seen.has(name)) throw worldV3Error(`类别「${kind}」条目名重复：${name}`)
    seen.add(name)
    const detail = String(item.detail == null ? '' : item.detail).trim()
    if (detail.length > WORLD_DETAIL_MAX) throw worldV3Error(`类别「${kind}」条目「${name}」说明超过 ${WORLD_DETAIL_MAX} 字`)
    const id = String(item.id == null ? '' : item.id).trim().slice(0, WORLD_ID_MAX) || `w-${kindIndex + 1}-${index + 1}`
    const extension = normalizeWorldExtension(item.extension)
    const tertiary = String(item.tertiary == null ? '' : item.tertiary).trim()
    if ([...tertiary].length > WORLD_LABEL_MAX) throw worldV3Error(`条目「${name}」三级标签超过 ${WORLD_LABEL_MAX} 字`)
    entries.push({ id, name, detail, ...(extension ? { extension } : {}), ...(tertiary ? { tertiary } : {}) })
  })
  return entries
}

function registerEntryTertiary(category) {
  for (const entry of category.entries) {
    if (!entry.tertiary) continue
    const extension = entry.extension || ''
    let group = category.tertiaryTags.find((item) => item.extension === extension)
    if (!group) {
      group = { extension, labels: [] }
      category.tertiaryTags.push(group)
    }
    if (!group.labels.includes(entry.tertiary)) {
      if (group.labels.length >= WORLD_LABELS_MAX) throw worldV3Error(`类别「${category.kind}」三级标签超过 ${WORLD_LABELS_MAX} 个`)
      group.labels.push(entry.tertiary)
    }
  }
}

function normalizeWorldCategory(input, kind, kindIndex, totalBefore) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw worldV3Error(`类别「${kind}」必须是对象`)
  for (const key of Object.keys(input)) {
    if (!['kind', 'summary', 'rules', 'tertiaryTags', 'entries'].includes(key)) throw worldV3Error(`类别「${kind}」不支持字段：${key}`)
  }
  const summary = String(input.summary == null ? '' : input.summary).trim()
  if (summary.length > WORLD_SUMMARY_MAX) throw worldV3Error(`类别「${kind}」summary 超过 ${WORLD_SUMMARY_MAX} 字`)
  const rules = normalizeRuleList(input.rules, kind, kindIndex)
  const tertiaryTags = normalizeTertiaryTags(input.tertiaryTags, kind)
  const entries = normalizeEntryList(input.entries, kind, kindIndex, totalBefore)
  const category = { kind, summary, rules, tertiaryTags, entries }
  registerEntryTertiary(category)
  return category
}

/** v2 doc → v3 doc（只读适配）：tertiaryTags=[]、entries.tertiary 空；不丢 summary/rules/extension/entries。 */
export function worldDocV3FromV2(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw worldV3Error('v2 doc 必须是对象')
  if (!Array.isArray(input.categories)) throw worldV3Error('v2 doc categories 必须是数组')
  const categories = input.categories.map((category) => {
    if (!category || typeof category !== 'object') throw worldV3Error('v2 categories 项必须是对象')
    const entries = Array.isArray(category.entries)
      ? category.entries.map((entry) => ({ ...entry, tertiary: undefined }))
      : category.entries
    return { ...category, tertiaryTags: [], entries }
  })
  return normalizeWorldDocV3({ schemaVersion: 3, categories })
}

/** 归一/校验 v3 doc；v2 doc 自动只读转换；旧数组先 worldDocFromLegacy。 */
export function normalizeWorldDocV3(input) {
  if (Array.isArray(input)) return worldDocFromLegacy(input)
  if (!input || typeof input !== 'object') throw worldV3Error('世界观 doc 必须是对象')
  if (Number(input.schemaVersion) === 2) return worldDocV3FromV2(input)
  for (const key of Object.keys(input)) {
    if (!['schemaVersion', 'categories'].includes(key)) throw worldV3Error(`世界观 doc 不支持字段：${key}`)
  }
  if (input.schemaVersion !== undefined && Number(input.schemaVersion) !== 3) throw worldV3Error('schemaVersion 必须为 3')
  if (!Array.isArray(input.categories)) throw worldV3Error('categories 必须是数组')
  const byKind = new Map()
  for (const category of input.categories) {
    if (!category || typeof category !== 'object' || Array.isArray(category)) throw worldV3Error('categories 项必须是对象')
    const kind = String(category.kind == null ? '' : category.kind).trim()
    if (!WORLD_KINDS.includes(kind) && kind !== WORLD_KIND_OTHER) throw worldV3Error(`类别非法：${kind || '（空）'}`)
    if (byKind.has(kind)) throw worldV3Error(`类别重复：${kind}`)
    byKind.set(kind, category)
  }
  const categories = []
  let totalEntries = 0
  WORLD_KINDS.forEach((kind, index) => {
    const normalized = normalizeWorldCategory(byKind.get(kind) || {}, kind, index, totalEntries)
    totalEntries += normalized.entries.length
    categories.push(normalized)
  })
  const other = byKind.get(WORLD_KIND_OTHER)
  if (other) {
    const normalized = normalizeWorldCategory(other, WORLD_KIND_OTHER, WORLD_KINDS.length, totalEntries)
    totalEntries += normalized.entries.length
    if (normalized.summary || normalized.rules.length || normalized.entries.length) categories.push(normalized)
  }
  return { schemaVersion: 3, categories }
}

/** v1 扁平数组 → v3 doc；保留已有 tertiary（若有）并自动注册。 */
export function worldDocFromLegacy(entries) {
  const list = Array.isArray(entries) ? entries : []
  const categories = new Map()
  const summaryCounts = new Map()
  for (const kind of WORLD_KINDS) categories.set(kind, { kind, summary: '', rules: [], tertiaryTags: [], entries: [] })
  const other = { kind: WORLD_KIND_OTHER, summary: '', rules: [], tertiaryTags: [], entries: [] }
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const mapped = normalizeWorldKind(entry.kind, entry.extension)
    const category = mapped.kind === WORLD_KIND_OTHER ? other : categories.get(mapped.kind)
    if (!category) continue
    const role = String(entry.role || '').trim()
    const name = String(entry.name == null ? '' : entry.name).trim()
    const detail = String(entry.detail == null ? '' : entry.detail).trim()
    const tertiary = String(entry.tertiary == null ? '' : entry.tertiary).trim()
    if (role === 'summary') {
      if (!WORLD_KINDS.includes(mapped.kind)) {
        category.entries.push({ id: String(entry.id || ''), name: name || '总述', detail, ...(mapped.extension ? { extension: mapped.extension } : {}), ...(tertiary ? { tertiary } : {}) })
        continue
      }
      const count = (summaryCounts.get(mapped.kind) || 0) + 1
      summaryCounts.set(mapped.kind, count)
      if (count === 1 && detail) { category.summary = detail; continue }
      if (!detail) continue
      category.entries.push({ id: String(entry.id || ''), name: `总述（迁移 ${count}）`, detail, ...(mapped.extension ? { extension: mapped.extension } : {}), ...(tertiary ? { tertiary } : {}) })
      continue
    }
    if (role === 'rule') {
      category.rules.push({ id: String(entry.id || ''), name, detail })
      continue
    }
    category.entries.push({ id: String(entry.id || ''), name, detail, ...(mapped.extension ? { extension: mapped.extension } : {}), ...(tertiary ? { tertiary } : {}) })
  }
  const doc = { schemaVersion: 3, categories: [...categories.values()] }
  if (other.summary || other.rules.length || other.entries.length) doc.categories.push(other)
  return normalizeWorldDocV3(doc)
}

/** v3 doc → v1 兼容数组（summary/role、rules/role、entries 含 tertiary add-only）。 */
export function worldDocToLegacy(doc) {
  const normalized = isWorldDocV2(doc) ? worldDocV3FromV2(doc) : normalizeWorldDocV3(doc)
  const out = []
  normalized.categories.forEach((category, index) => {
    if (category.summary) out.push({ id: `w-summary-${index + 1}`, kind: category.kind, name: '总述', detail: category.summary, role: 'summary' })
    for (const rule of category.rules) out.push({ id: rule.id, kind: category.kind, name: rule.name, detail: rule.detail, role: 'rule' })
    for (const entry of category.entries) out.push({ id: entry.id, kind: category.kind, name: entry.name, detail: entry.detail, ...(entry.extension ? { extension: entry.extension } : {}), ...(entry.tertiary ? { tertiary: entry.tertiary } : {}) })
  })
  return out
}

async function readWorldRaw(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  return { dir, raw: await readJsonDoc(dir, 'world', []) }
}

export async function readWorldDoc(root, title) {
  const { raw } = await readWorldRaw(root, title)
  if (isWorldDocV3(raw)) return normalizeWorldDocV3(raw)
  if (isWorldDocV2(raw)) return worldDocV3FromV2(raw)
  return worldDocFromLegacy(await getWorld(root, title))
}

/** world-get：v3 原样；v2/v1 只读适配为 v3；不写盘。 */
export async function readWorldCompat(root, title) {
  const { raw } = await readWorldRaw(root, title)
  if (isWorldDocV3(raw)) {
    const doc = normalizeWorldDocV3(raw)
    return { doc, world: worldDocToLegacy(doc), migrated: false, migration: null }
  }
  if (isWorldDocV2(raw)) {
    const doc = worldDocV3FromV2(raw)
    return { doc, world: worldDocToLegacy(doc), migrated: true, migration: null }
  }
  const world = await getWorld(root, title)
  const doc = worldDocFromLegacy(world)
  return { doc, world, migrated: true, migration: world && world.migration ? world.migration : null }
}

export async function saveWorldDoc(root, title, input) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const doc = normalizeWorldDocV3(input && input.doc ? input.doc : input)
  await writeJsonDoc(dir, 'world', doc)
  const md = renderWorldMarkdown(title, doc)
  await writeProjectFile(dir, path.join(dir, '世界观', '世界观.md'), md)
  return { doc, world: worldDocToLegacy(doc) }
}

export async function saveWorldCompat(root, title, input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  if (source.doc !== undefined) {
    const saved = await saveWorldDoc(root, title, source.doc)
    return { ...saved, migrated: false }
  }
  if (Array.isArray(source.world)) {
    const saved = await saveWorldDoc(root, title, worldDocFromLegacy(source.world))
    return { ...saved, migrated: true }
  }
  throw worldV3Error('world-save 需要 doc（v3）或 world（v1 数组）')
}

export async function getWorld(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const raw = await readJsonDoc(dir, 'world', [])
  if (isWorldDocV3(raw)) return worldDocToLegacy(normalizeWorldDocV3(raw))
  if (isWorldDocV2(raw)) return worldDocToLegacy(worldDocV3FromV2(raw))
  const list = Array.isArray(raw) ? raw : []
  let worldFileExists = true
  try { await fs.access(path.join(metaDir(dir), 'world.json')) } catch { worldFileExists = false }
  const entries = []
  const summaryKinds = new Set()
  let mappedCount = 0
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const rawKind = String(entry.kind == null ? '' : entry.kind).trim()
    if (rawKind === WORLD_SUMMARY_EXTENSION || Object.prototype.hasOwnProperty.call(WORLD_KIND_LEGACY, rawKind)) mappedCount += 1
    const mapped = normalizeWorldKind(entry.kind, entry.extension)
    const role = String(entry.role || '').trim()
    const next = {
      id: String(entry.id || ''),
      kind: mapped.kind,
      name: String(entry.name || '').slice(0, 60),
      detail: String(entry.detail || '').slice(0, 2000),
    }
    if (mapped.extension) next.extension = mapped.extension
    if (role === 'summary' && WORLD_KINDS.includes(next.kind)) {
      next.name = next.name || '总述'
      next.role = 'summary'
      delete next.extension
      summaryKinds.add(next.kind)
    } else if (role === 'rule') {
      next.role = 'rule'
    } else if (entry.tertiary) {
      next.tertiary = String(entry.tertiary).trim()
    }
    entries.push(next)
  }
  let contract = null
  try { contract = await getContract(root, title) } catch { contract = null }
  if (contract && typeof contract === 'object' && (!worldFileExists || mappedCount > 0)) {
    for (const [field, kind] of WORLD_CONTRACT_SUMMARIES) {
      if (summaryKinds.has(kind)) continue
      const text = typeof contract[field] === 'string' ? contract[field].trim() : ''
      if (!text) continue
      const detail = field === 'soulDeath' ? `${WORLD_SOUL_DEATH_HINT}\n\n${text}` : text
      entries.push({ id: `__contract_summary__${WORLD_KINDS.indexOf(kind) + 1}`, kind, name: '总述', detail: detail.slice(0, 2000), role: 'summary', fromContract: true })
    }
  }
  const syntheticCount = entries.filter((entry) => entry.fromContract === true).length
  if (syntheticCount > 0 || mappedCount > 0) {
    Object.defineProperty(entries, 'migration', { value: { summaries: syntheticCount, items: mappedCount, mapped: mappedCount > 0 }, enumerable: false, configurable: true })
  }
  return entries
}

/** v3 渲染：一级 → 总述 → 规则 → 二级 → 三级（未分级置后）→ 条目；空省略。 */
export function renderWorldMarkdown(title, input) {
  const doc = isWorldDocV2(input) ? worldDocV3FromV2(input) : isWorldDocV3(input) ? normalizeWorldDocV3(input) : worldDocFromLegacy(Array.isArray(input) ? input : [])
  const lines = [`# ${assertSafeTitle(title)} · 世界观设定`, '', '> 由「AI 短剧」工作区生成，源数据 `.aidrama/world.json`。', '']
  let rendered = false
  for (const category of doc.categories) {
    if (!category.summary && !category.rules.length && !category.entries.length) continue
    rendered = true
    lines.push(`## ${category.kind}`, '')
    if (category.summary) lines.push('### 总述', '', category.summary, '')
    if (category.rules.length) {
      lines.push('### 底层设定规则', '')
      for (const rule of category.rules) lines.push(`- **${rule.name}**：${rule.detail || '_（暂无说明）_'}`)
      lines.push('')
    }
    if (!category.entries.length) continue
    lines.push('### 二级条目', '')
    const groups = new Map()
    for (const entry of category.entries) {
      const key = entry.extension || ''
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(entry)
    }
    const defaults = WORLD_SUBTABS[category.kind] || []
    const used = [...groups.keys()]
    const ordered = [
      ...(used.includes('') ? [''] : []),
      ...defaults.filter((name) => used.includes(name)),
      ...used.filter((name) => name && !defaults.includes(name)).sort((a, b) => a.localeCompare(b, 'zh')),
    ]
    for (const extension of ordered) {
      const entries = groups.get(extension) || []
      if (!entries.length) continue
      if (groups.size > 1 || extension) lines.push(`#### ${extension || '基础'}`, '')
      const tagGroup = category.tertiaryTags.find((item) => item.extension === extension)
      const labels = tagGroup ? tagGroup.labels : []
      const labeled = labels.filter((label) => entries.some((entry) => entry.tertiary === label))
      const unclassified = entries.filter((entry) => !entry.tertiary)
      if (labeled.length) {
        for (const label of labeled) {
          lines.push(`##### ${label}`, '')
          for (const entry of entries.filter((item) => item.tertiary === label)) lines.push(`- **${entry.name}**：${entry.detail || '_（暂无说明）_'}`)
          lines.push('')
        }
        if (unclassified.length) {
          lines.push('##### 未分级', '')
          for (const entry of unclassified) lines.push(`- **${entry.name}**：${entry.detail || '_（暂无说明）_'}`)
          lines.push('')
        }
      } else {
        for (const entry of entries) lines.push(`- **${entry.name}**：${entry.detail || '_（暂无说明）_'}`)
        lines.push('')
      }
    }
  }
  if (!rendered) lines.push('_（暂无设定）_', '')
  return lines.join('\n')
}

export async function saveWorld(root, title, entries) {
  const saved = await saveWorldCompat(root, title, { world: entries })
  return saved.world
}


export async function listShared(root, relPath) {
  const base = sharedDir(root)
  const safe = relPath ? assertSafeRelPath(relPath) : ''
  const target = safe ? path.join(base, safe) : base
  if (!target.startsWith(base)) throw new Error('路径越界')
  let entries = []
  try {
    entries = await fs.readdir(target, { withFileTypes: true })
  } catch {
    return { path: safe, entries: [] }
  }
  return {
    path: safe,
    entries: entries
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'zh') : a.kind === 'dir' ? -1 : 1)),
  }
}

export async function readShared(root, relPath) {
  const base = sharedDir(root)
  const safe = assertSafeRelPath(relPath)
  const target = path.join(base, safe)
  if (!target.startsWith(base)) throw new Error('路径越界')
  try {
    return { path: safe, text: await fs.readFile(target, 'utf8') }
  } catch {
    return { path: safe, text: '' }
  }
}

export async function writeShared(root, relPath, text) {
  const base = sharedDir(root)
  const safe = assertSafeRelPath(relPath)
  if (typeof text !== 'string') throw new Error('内容必须是文本')
  await fs.mkdir(base, { recursive: true })
  // v0.15.10（C-5）：共享区真实目录必须在工作区根内，且写目标经同一 realpath 包含校验（V1）
  let realRoot
  try {
    realRoot = await fs.realpath(root)
  } catch {
    realRoot = path.resolve(root)
  }
  let realBase
  try {
    realBase = await fs.realpath(base)
  } catch {
    throw assetPathError('not-found', '共享目录不可读')
  }
  if (realBase !== realRoot && !isPathInside(realRoot, realBase)) throw assetPathError('forbidden', '共享目录越出工作区')
  const target = await assertProjectWriteTarget(realBase, safe)
  await atomicWrite(target, text)
  return { path: safe, bytes: Buffer.byteLength(text, 'utf8') }
}

/* ------------------------------------------------------------------ 设置 */

function emptySettings() {
  return {
    defaultPlatform: '',
    defaultEpisodeDurationSec: [60, 180],
    defaultOrientation: 'portrait',
    defaultTargetEpisodes: 0,
    retrievalTopK: 5,
    // H-2（P1-G，只增字段）：旧 settings.json 没有这些键，读取时统一补默认值。
    defaultModel: '',
    promptTemplates: {},
    retrievalEnabled: true,
    storageLocation: '',
    // P2-2（Q1，只增字段）：创作流程强制门禁开关（settings.strictMode），默认 false = 宽松模式。
    strictMode: false,
    // P2-6（Q1/Q2，只增字段）：任务级模型参数（v0.6.1 仅 audit 被消费，其余任务键预留原样保存）。
    taskModels: {},
    updatedAt: null,
  }
}

/** P2-6：taskModels 允许的任务类型键（v0.6.1 仅 audit 被消费，其余键保存但不消费）。 */
export const TASK_MODEL_KEYS = ['audit', 'review', 'outline', 'characters', 'episode', 'storyboard']

/** RC-29（v0.16.135 add-only）：项目默认画布工具枚举（settings.canvasBackend；缺省=自动 activeBackend）。 */
export const CANVAS_BACKENDS = Object.freeze(['libtv', 'neowow'])

/** v0.16.252：settings.videoParams 的 AC 枚举（与 client 控件、LibTV schema 同口径）。 */
export const VIDEO_PARAM_RATIOS = Object.freeze(['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'])
export const VIDEO_PARAM_RESOLUTIONS = Object.freeze(['480p', '720p', '1080p'])
// v0.16.260（D-0107）：LibTV 视频模型 modelKey 白名单（与 client 下拉一致）
export const VIDEO_PARAM_MODELS = Object.freeze(['star-video2.5', 'star-video2.5-draft', 'star-video2', 'wanx3.0', 'kling-v4', 'MiniMax-Hailuo-H3', 'minimax-h3-hs'])
/** v0.16.261：视频生成模式（client 参数面板持久化）。 */
export const VIDEO_PARAM_MODES = Object.freeze(['mixed2video', 'singleImage2video', 'text2video'])
export const VIDEO_PARAM_SOUNDS = Object.freeze(['on', 'off'])
export const VIDEO_PARAM_DURATION_MIN = 4
export const VIDEO_PARAM_DURATION_MAX = 30

/**
 * v0.16.252：settings.videoParams 写前严格校验（AC P1-C）。
 * - object；仅允许已知键；ratio/resolution 枚举、duration 整数 4–30、enableSound on/off（兼容 boolean）、count===1；
 * - 非法 → invalid-args；本函数只做纯校验/归一，不写盘。
 */
export function normalizeVideoParamsForSettings(value) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw invalidArgsError('settings.videoParams 必须是对象')
  // v0.16.260（D-0107）：model add-only
  const allowedKeys = ['ratio', 'resolution', 'duration', 'enableSound', 'count', 'model', 'mode']
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) throw invalidArgsError(`settings.videoParams 含未知字段：${key}`)
  }
  const out = {}
  if (value.ratio !== undefined) {
    if (typeof value.ratio !== 'string' || !VIDEO_PARAM_RATIOS.includes(value.ratio.trim())) {
      throw invalidArgsError(`settings.videoParams.ratio 非法：${String(value.ratio)}（允许 ${VIDEO_PARAM_RATIOS.join('/')}）`)
    }
    out.ratio = value.ratio.trim()
  }
  if (value.resolution !== undefined) {
    if (typeof value.resolution !== 'string' || !VIDEO_PARAM_RESOLUTIONS.includes(value.resolution.trim())) {
      throw invalidArgsError(`settings.videoParams.resolution 非法：${String(value.resolution)}（允许 480p/720p/1080p）`)
    }
    out.resolution = value.resolution.trim()
  }
  if (value.duration !== undefined) {
    if (typeof value.duration !== 'number' || !Number.isInteger(value.duration) || value.duration < VIDEO_PARAM_DURATION_MIN || value.duration > VIDEO_PARAM_DURATION_MAX) {
      throw invalidArgsError(`settings.videoParams.duration 非法：${String(value.duration)}（需 ${VIDEO_PARAM_DURATION_MIN}–${VIDEO_PARAM_DURATION_MAX} 秒整数）`)
    }
    out.duration = value.duration
  }
  if (value.enableSound !== undefined) {
    if (value.enableSound === true || value.enableSound === 'on') out.enableSound = 'on'
    else if (value.enableSound === false || value.enableSound === 'off') out.enableSound = 'off'
    else throw invalidArgsError(`settings.videoParams.enableSound 非法：${String(value.enableSound)}（允许 on/off 或 boolean）`)
  }
  if (value.count !== undefined) {
    if (value.count !== 1) throw invalidArgsError(`settings.videoParams.count 非法：${String(value.count)}（本版固定 1）`)
    out.count = 1
  }
  if (value.model !== undefined) {
    const modelKey = typeof value.model === 'string' ? value.model.trim() : ''
    if (!modelKey || !VIDEO_PARAM_MODELS.includes(modelKey)) throw invalidArgsError(`settings.videoParams.model 非法：${String(value.model)}（允许 ${VIDEO_PARAM_MODELS.join('/')}）`)
    out.model = modelKey
  }
  if (value.mode !== undefined) {
    const mode = typeof value.mode === 'string' ? value.mode.trim() : ''
    if (!VIDEO_PARAM_MODES.includes(mode)) throw invalidArgsError(`settings.videoParams.mode 非法：${String(value.mode)}（允许 ${VIDEO_PARAM_MODES.join('/')}）`)
    out.mode = mode
  }
  return out
}

export async function getSettings(root) {
  const stored = await readJson(path.join(projectsBase(root), META_DIR, 'settings.json'), {})
  const defaults = emptySettings()
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return defaults
  const merged = { ...defaults, ...stored }
  // v0.16.59（H-13r2）：旧字段 sources/preferred/defaults 忽略；v4 形状在读取时归一化（不写盘）。
  if (Object.prototype.hasOwnProperty.call(merged, 'skillConfig') && merged.skillConfig != null) {
    try { merged.skillConfig = normalizeSkillConfig(merged.skillConfig) } catch { delete merged.skillConfig }
  }
  return merged
}

/** H-2 提示词模板的约定键（未知键原样保留，便于 P2 扩展）。 */
export const PROMPT_TEMPLATE_KEYS = ['outline', 'episode', 'storyboard', 'review', 'polish']

function normalizePromptTemplates(value) {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('提示词模板必须是对象（键 → 模板文本）')
  const normalized = {}
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== 'string') throw new Error(`提示词模板「${rawKey}」必须是字符串`)
    const key = String(rawKey).trim().slice(0, 40)
    if (!key) continue
    normalized[key] = rawValue.slice(0, 4000)
    if (Object.keys(normalized).length >= 50) break
  }
  return normalized
}

export async function saveSettings(root, patch) {
  const current = await getSettings(root)
  const next = { ...current, ...(patch || {}), updatedAt: new Date().toISOString() }
  const [min, max] = Array.isArray(next.defaultEpisodeDurationSec) ? next.defaultEpisodeDurationSec : []
  const lo = Number(min)
  const hi = Number(max)
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo) throw new Error('默认单集时长需要两个正整数，且上限不小于下限')
  next.defaultEpisodeDurationSec = [Math.round(lo), Math.round(hi)]
  const target = Number(next.defaultTargetEpisodes)
  if (!Number.isFinite(target) || target < 0 || target > 2000) throw new Error('默认目标集数需在 0~2000 之间')
  next.defaultTargetEpisodes = Math.round(target)
  if (!['portrait', 'landscape'].includes(next.defaultOrientation)) throw new Error('默认画幅只能是竖屏或横屏')
  const topK = Number(next.retrievalTopK)
  if (!Number.isFinite(topK) || topK < 1 || topK > 20) throw new Error('检索条数需在 1~20 之间')
  next.retrievalTopK = Math.round(topK)

  /* ---- H-2 新增四字段：缺省用默认值，非法值明确报错（旧 payload 不传即保持默认） ---- */
  next.defaultModel = next.defaultModel == null ? '' : String(next.defaultModel).trim()
  if (next.defaultModel.length > 120) throw new Error('默认模型名过长（上限 120 字）')
  next.promptTemplates = normalizePromptTemplates(next.promptTemplates)
  if (next.retrievalEnabled == null) next.retrievalEnabled = true
  if (typeof next.retrievalEnabled !== 'boolean') throw new Error('检索开关必须是布尔值（true/false）')
  next.storageLocation = next.storageLocation == null ? '' : String(next.storageLocation).trim()
  if (next.storageLocation.length > 500) throw new Error('存储位置过长（上限 500 字）')
  if (next.storageLocation.includes('\u0000')) throw new Error('存储位置不能包含空字符')

  /* ---- P2-2（Q1）：强制门禁开关（布尔，默认 false 宽松） ---- */
  if (next.strictMode == null) next.strictMode = false
  if (typeof next.strictMode !== 'boolean') throw new Error('强制门禁开关必须是布尔值（true/false）')

  /* ---- P2-6（Q1/Q2/Q4）：任务级模型参数（只增字段；非法值按字段报错，缺省安全默认） ---- */
  next.taskModels = normalizeTaskModels(next.taskModels)

  /* ---- P2-5（v0.6.6）：可选的三级生成预算上限（settings.generationLimits，未配置=不限制） ---- */
  if (Object.prototype.hasOwnProperty.call(next, 'generationLimits')) {
    // 显式保存/清空时保留空对象 {}（读取侧按「全部 null=不限制」处理），保证 settings 形状稳定；
    // 从未配置过该项目时，字段保持缺省（不改变旧 settings 形状）。
    next.generationLimits = normalizeGenerationLimits(next.generationLimits) || {}
  }

  /* ---- P2-5 剩余（v0.6.7）：可选生成重试配置（settings.generationRetry，未配置=maxAttempts=1 不重试） ---- */
  if (Object.prototype.hasOwnProperty.call(next, 'generationRetry')) {
    next.generationRetry = normalizeGenerationRetry(next.generationRetry) || {}
  }

  /* ---- v0.16.59（Skill 管理 P0 / H-13r2）：skillConfig v4 严格校验（缺省不写盘，旧字段丢弃） ---- */
  if (Object.prototype.hasOwnProperty.call(next, 'skillConfig') && next.skillConfig != null) {
    next.skillConfig = normalizeSkillConfig(next.skillConfig)
  }

  /* ---- RC-22（v0.16.100）：项目默认会话绑定 map（add-only；patch 无该键时旧 settings 字节不变） ---- */
  if (Object.prototype.hasOwnProperty.call(next, 'projectSessions')) {
    next.projectSessions = normalizeProjectSessions(next.projectSessions)
  }

  /* ---- RC-29（v0.16.135 add-only）：项目默认画布工具 settings.canvasBackend（缺省 absent=自动 activeBackend）。 ---- */
  if (Object.prototype.hasOwnProperty.call(next, 'canvasBackend')) {
    const rawCanvasBackend = next.canvasBackend
    if (rawCanvasBackend === undefined || rawCanvasBackend === null || rawCanvasBackend === '') {
      delete next.canvasBackend
    } else if (typeof rawCanvasBackend !== 'string') {
      const invalid = new Error('画布工具必须是 libtv 或 neowow')
      invalid.code = 'invalid-args'
      throw invalid
    } else {
      const canvasBackend = rawCanvasBackend.trim()
      if (!CANVAS_BACKENDS.includes(canvasBackend)) {
        const invalid = new Error(`画布工具非法：${rawCanvasBackend}（仅 libtv/neowow）`)
        invalid.code = 'invalid-args'
        throw invalid
      }
      next.canvasBackend = canvasBackend
    }
  }

  /* ---- v0.16.252（P1-C）：settings.videoParams 写前 AC 校验；非法 invalid-args 且零写盘。 ---- */
  if (Object.prototype.hasOwnProperty.call(next, 'videoParams')) {
    const normalizedVideoParams = normalizeVideoParamsForSettings(next.videoParams)
    if (normalizedVideoParams == null) delete next.videoParams
    else next.videoParams = normalizedVideoParams
  }

  // v0.16.10（M2）：workspace 级 settings 写目标 guard（base + .aidrama junction 拒绝）。
  const settingsBase = path.join(projectsBase(root), META_DIR, 'settings.json')
  let realBase
  try {
    realBase = await fs.realpath(path.dirname(path.dirname(settingsBase)))
  } catch {
    realBase = null
  }
  if (realBase) {
    let realRoot
    try { realRoot = await fs.realpath(root) } catch { realRoot = null }
    if (realRoot && alsoInsideWorkspace(realRoot, realBase)) {
      const settingsTarget = await assertProjectWriteTarget(realBase, `${META_DIR}/settings.json`)
      await atomicWrite(settingsTarget, JSON.stringify(next, null, 2) + '\n')
      return next
    }
  }
  await atomicWrite(settingsBase, JSON.stringify(next, null, 2) + '\n')
  return next
}

/* ====================================================================== *
 * RC-22（v0.16.100）：项目默认会话绑定 `settings.projectSessions`（add-only）
 * - 形状：{ [项目标题]: {sessionId,title,cwd,preset,source:'created'|'manual',boundAt,updatedAt} }
 * - 写侧严格校验（≤50/未知键/类型/长度/枚举 → invalid-args 0 写盘）；读侧缺键=空、不写盘；
 * - `emptySettings()` 不加默认键 → 旧 settings-get 响应逐字节不变；
 * - 创建时 best-effort 写 source='created'；rename 迁移 key / delete 清理 key（失败不阻断主流程）。
 * ====================================================================== */
export const PROJECT_SESSIONS_MAX = 50
const PROJECT_SESSION_FIELDS = ['sessionId', 'title', 'cwd', 'preset', 'source', 'boundAt', 'updatedAt']

function assertProjectSessionText(value, label, max) {
  if (typeof value !== 'string') throw invalidArgsError(`${label} 必须是字符串`)
  const text = value.trim()
  if (text.length > max) throw invalidArgsError(`${label} 过长（上限 ${max} 字）`)
  if (/[\u0000-\u001f\u007f]/.test(text)) throw invalidArgsError(`${label} 含控制字符`)
  return text
}

/** RC-22：settings.projectSessions 严格归一（仅 saveSettings 写入侧调用；旧 settings 无键=不写盘）。 */
export function normalizeProjectSessions(value) {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw invalidArgsError('projectSessions 必须是对象（项目标题 → 默认会话绑定）')
  const entries = Object.entries(value)
  if (entries.length > PROJECT_SESSIONS_MAX) throw invalidArgsError(`projectSessions 最多 ${PROJECT_SESSIONS_MAX} 项（当前 ${entries.length}）`)
  const normalized = {}
  for (const [rawTitle, rawEntry] of entries) {
    let projectTitle
    try {
      projectTitle = assertSafeTitle(rawTitle)
    } catch {
      throw invalidArgsError(`projectSessions 项目标题非法：${rawTitle}`)
    }
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) throw invalidArgsError(`projectSessions「${projectTitle}」必须是对象`)
    const unknown = Object.keys(rawEntry).find((key) => !PROJECT_SESSION_FIELDS.includes(key))
    if (unknown) throw invalidArgsError(`projectSessions「${projectTitle}」含未知字段：${unknown}`)
    const sessionId = assertProjectSessionText(rawEntry.sessionId, 'sessionId', 120)
    if (!sessionId) throw invalidArgsError(`projectSessions「${projectTitle}」缺少 sessionId`)
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw invalidArgsError(`projectSessions「${projectTitle}」sessionId 非法（仅字母数字 _-）`)
    const cwd = rawEntry.cwd == null ? '' : assertProjectSessionText(rawEntry.cwd, 'cwd', 500)
    if (cwd && !path.isAbsolute(cwd)) throw invalidArgsError(`projectSessions「${projectTitle}」cwd 必须是绝对路径`)
    const source = rawEntry.source == null ? 'manual' : String(rawEntry.source)
    if (!['created', 'manual'].includes(source)) throw invalidArgsError(`projectSessions「${projectTitle}」source 非法（created/manual）`)
    normalized[projectTitle] = {
      sessionId,
      title: rawEntry.title == null ? '' : assertProjectSessionText(rawEntry.title, 'title', 200),
      cwd,
      preset: rawEntry.preset == null ? '' : assertProjectSessionText(rawEntry.preset, 'preset', 80),
      source,
      boundAt: rawEntry.boundAt == null ? '' : assertProjectSessionText(rawEntry.boundAt, 'boundAt', 40),
      updatedAt: rawEntry.updatedAt == null ? '' : assertProjectSessionText(rawEntry.updatedAt, 'updatedAt', 40),
    }
  }
  return normalized
}

/** RC-22：读取当前绑定 map（缺键/类型坏 → {}；不写盘）。 */
export async function readProjectSessions(root) {
  const settings = await getSettings(root)
  const value = settings && settings.projectSessions
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {}
}

/** RC-22：best-effort 写入/更新一条项目默认会话绑定（创建时 source='created'；title 留空由 client 解析）。 */
export async function bindProjectSession(root, title, binding = {}) {
  const projectTitle = assertSafeTitle(title)
  const sessionId = typeof binding.sessionId === 'string' ? binding.sessionId.trim() : ''
  if (!sessionId) return { bound: false, reason: 'no-session' }
  const current = await readProjectSessions(root)
  const now = new Date().toISOString()
  current[projectTitle] = {
    sessionId,
    title: typeof binding.title === 'string' ? binding.title : '',
    cwd: typeof binding.cwd === 'string' ? binding.cwd : '',
    preset: typeof binding.preset === 'string' ? binding.preset : '',
    source: binding.source === 'created' ? 'created' : 'manual',
    boundAt: now,
    updatedAt: now,
  }
  await saveSettings(root, { projectSessions: current })
  return { bound: true, title: projectTitle, sessionId }
}

/** RC-22：rename 后 best-effort 迁移绑定 key（旧→新；冲突/异常不迁移，不阻断 rename）。 */
export async function migrateProjectSessionKey(root, fromTitle, toTitle) {
  try {
    const from = assertSafeTitle(fromTitle)
    const to = assertSafeTitle(toTitle)
    if (from === to) return { migrated: false }
    const current = await readProjectSessions(root)
    if (!Object.prototype.hasOwnProperty.call(current, from) || Object.prototype.hasOwnProperty.call(current, to)) return { migrated: false }
    const next = { ...current }
    next[to] = { ...next[from], updatedAt: new Date().toISOString() }
    delete next[from]
    await saveSettings(root, { projectSessions: next })
    return { migrated: true }
  } catch {
    return { migrated: false }
  }
}

/** RC-22：delete 后 best-effort 清理绑定 key（异常不阻断 delete）。 */
export async function removeProjectSessionKey(root, title) {
  try {
    const projectTitle = assertSafeTitle(title)
    const current = await readProjectSessions(root)
    if (!Object.prototype.hasOwnProperty.call(current, projectTitle)) return { removed: false }
    const next = { ...current }
    delete next[projectTitle]
    await saveSettings(root, { projectSessions: next })
    return { removed: true }
  } catch {
    return { removed: false }
  }
}

/**
 * P2-5（v0.6.6）：归一 settings.generationLimits（三级生成预算上限）。
 * - 缺省/null → null（表示清空/未配置；调用方通常删除该字段保持旧 settings 形状）
 * - 必须是对象；仅允许 perTaskPoints / perEpisodePoints / perProjectPoints 三个键
 * - 每档：null/undefined/'' → 不设；否则必须是非负、整数、≤ 10,000,000 的数字
 * - 非法值 → 抛 invalid-args（route 映射 400），不静默持久化
 */
const GENERATION_LIMIT_FIELDS = ['perTaskPoints', 'perEpisodePoints', 'perProjectPoints']
const GENERATION_LIMIT_MAX = 10_000_000

function invalidArgsError(message) {
  const error = new Error(message)
  error.code = 'invalid-args'
  return error
}

export function normalizeGenerationLimits(value) {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw invalidArgsError('generationLimits 必须是对象（三级上限：perTaskPoints / perEpisodePoints / perProjectPoints）')
  const unknown = Object.keys(value).find((key) => !GENERATION_LIMIT_FIELDS.includes(key))
  if (unknown) throw invalidArgsError(`generationLimits.${unknown} 是未知字段（可选：${GENERATION_LIMIT_FIELDS.join(' / ')}）`)
  const normalized = {}
  for (const key of GENERATION_LIMIT_FIELDS) {
    const raw = value[key]
    if (raw == null || raw === '') continue
    const number = Number(raw)
    if (typeof raw === 'boolean' || !Number.isFinite(number)) throw invalidArgsError(`generationLimits.${key} 必须是非负数字（null=不限制）`)
    if (number < 0 || !Number.isInteger(number) || number > GENERATION_LIMIT_MAX) {
      throw invalidArgsError(`generationLimits.${key} 必须是 0~${GENERATION_LIMIT_MAX} 的整数（null=不限制）`)
    }
    normalized[key] = number
  }
  return normalized
}

/**
 * P2-5 剩余（v0.6.7）：归一 settings.generationRetry（生成失败重试配置）。
 * - 缺省/null → null（清空，等同不重试）
 * - 允许键：maxAttempts(1~5 整数) / baseDelayMs(0~10000 整数) / maxDelayMs(0~30000 整数，≥baseDelayMs)
 * - 非法值 → invalid-args（route 映射 400），不静默持久化
 */
const GENERATION_RETRY_FIELDS = ['maxAttempts', 'baseDelayMs', 'maxDelayMs']

export function normalizeGenerationRetry(value) {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw invalidArgsError('generationRetry 必须是对象（maxAttempts / baseDelayMs / maxDelayMs）')
  const unknown = Object.keys(value).find((key) => !GENERATION_RETRY_FIELDS.includes(key))
  if (unknown) throw invalidArgsError(`generationRetry.${unknown} 是未知字段（可选：${GENERATION_RETRY_FIELDS.join(' / ')}）`)
  const normalized = {}
  if (value.maxAttempts != null && value.maxAttempts !== '') {
    const attempts = Number(value.maxAttempts)
    if (typeof value.maxAttempts === 'boolean' || !Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
      throw invalidArgsError('generationRetry.maxAttempts 必须是 1~5 的整数（默认 1=不重试）')
    }
    normalized.maxAttempts = attempts
  }
  for (const key of ['baseDelayMs', 'maxDelayMs']) {
    if (value[key] == null || value[key] === '') continue
    const delay = Number(value[key])
    if (typeof value[key] === 'boolean' || !Number.isInteger(delay) || delay < 0 || delay > 30_000) {
      throw invalidArgsError(`generationRetry.${key} 必须是 0~30000 的整数（毫秒）`)
    }
    normalized[key] = delay
  }
  if (normalized.baseDelayMs != null && normalized.maxDelayMs != null && normalized.maxDelayMs < normalized.baseDelayMs) {
    throw invalidArgsError('generationRetry.maxDelayMs 不能小于 baseDelayMs')
  }
  return normalized
}

/**
 * P2-6：归一 settings.taskModels。
 * - 缺省 → {}（旧 settings 兼容 AC-M3）
 * - 允许键：audit|review|outline|characters|episode|storyboard（v0.6.1 仅 audit 被消费，其余原样保存）
 * - 字段：provider? string / model 必填非空 / temperature? 0~2 / maxTokens? 1~60000 / timeoutMs? 1000~60000
 * - 非法值 → 明确报错（invalid-args 语义），不崩溃；maxTokens 不得突破全局上限 60000
 */
export function normalizeTaskModels(value) {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('taskModels 必须是对象（任务类型 → 模型配置）')
  const normalized = {}
  for (const [rawKey, rawConfig] of Object.entries(value)) {
    const task = String(rawKey).trim()
    if (!TASK_MODEL_KEYS.includes(task)) {
      throw new Error(`taskModels 未知任务类型：${rawKey}（可选：${TASK_MODEL_KEYS.join(' / ')}）`)
    }
    if (rawConfig == null) continue
    if (typeof rawConfig !== 'object' || Array.isArray(rawConfig)) throw new Error(`taskModels.${task} 必须是对象`)
    const config = {}
    if (rawConfig.provider != null) {
      const provider = String(rawConfig.provider).trim()
      if (provider.length > 80) throw new Error(`taskModels.${task}.provider 过长（上限 80 字）`)
      if (provider) config.provider = provider
    }
    // P3-E（v0.9.2）：成本档位（只增字段；未配置行为不变）。
    // costTier 可选 enum；costTierModels 可选映射覆盖（只 fast/strong，standard 走默认链）。
    const costTier = normalizeCostTier(rawConfig.costTier)
    const costTierModels = normalizeCostTierModels(rawConfig.costTierModels)
    if (costTierModels && !costTier) throw invalidArgsError(`taskModels.${task}.costTierModels 需同时配置 costTier`)
    const hasModel = rawConfig.model != null && typeof rawConfig.model === 'string' && rawConfig.model.trim()
    if (!hasModel && !costTier) {
      throw new Error(`taskModels.${task}.model 必填（非空字符串）`)
    }
    if (hasModel) config.model = rawConfig.model.trim().slice(0, 120)
    if (costTier) config.costTier = costTier
    if (costTierModels) config.costTierModels = costTierModels
    if (rawConfig.temperature != null) {
      const temperature = Number(rawConfig.temperature)
      if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
        throw new Error(`taskModels.${task}.temperature 必须是 0~2 的数字`)
      }
      config.temperature = Math.round(temperature * 100) / 100
    }
    if (rawConfig.maxTokens != null) {
      const maxTokens = Number(rawConfig.maxTokens)
      if (!Number.isFinite(maxTokens) || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 60000) {
        throw new Error(`taskModels.${task}.maxTokens 必须是 1~60000 的整数（不得突破全局上限 60000）`)
      }
      config.maxTokens = maxTokens
    }
    if (rawConfig.timeoutMs != null) {
      const timeoutMs = Number(rawConfig.timeoutMs)
      if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
        throw new Error(`taskModels.${task}.timeoutMs 必须是 1000~60000 的整数`)
      }
      config.timeoutMs = timeoutMs
    }
    if (Object.keys(config).length) normalized[task] = config
  }
  return normalized
}

/* ------------------------------------------------------------ 台词与音效 */

const DIALOGUE_RE = /^\s*([\u4e00-\u9fa5A-Za-z0-9_·]{1,12})\s*[：:]\s*(\S.*)$/

/** 从全部分集剧本里抽取台词，并按角色归集；音效从分镜表汇总（FR-B07）。 */
export async function getDialogue(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)

  const episodes = await listEpisodes(root, title)
  const lines = []
  const sfx = []

  for (const episode of episodes) {
    const { text } = await readEpisode(root, title, episode.order)
    let scene = ''
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (/^##\s*场景/.test(line)) {
        scene = line.replace(/^##\s*/, '')
        continue
      }
      const match = line.match(DIALOGUE_RE)
      if (!match) continue
      const character = match[1]
      const content = match[2].trim()
      if (!content) continue
      // 排除「动作：…」「转场：…」这类非台词行
      if (['动作', '转场', '旁白', '画面', '场景', '音效'].includes(character)) continue
      lines.push({ episode: episode.order, scene, character, text: content })
    }

    for (const shot of await getStoryboard(root, title, episode.order)) {
      if (shot.sfx) sfx.push({ episode: episode.order, shotNumber: shot.shotNumber, sfx: shot.sfx })
    }
  }

  const byCharacter = new Map()
  for (const line of lines) {
    if (!byCharacter.has(line.character)) byCharacter.set(line.character, { character: line.character, count: 0, episodes: new Set() })
    const bucket = byCharacter.get(line.character)
    bucket.count += 1
    bucket.episodes.add(line.episode)
  }

  return {
    lines,
    byCharacter: [...byCharacter.values()]
      .map((b) => ({ character: b.character, count: b.count, episodes: [...b.episodes].sort((a, c) => a - c) }))
      .sort((a, b) => b.count - a.count),
    sfx,
    episodeCount: episodes.length,
  }
}

/** 生成可交付的配音稿：每集一份，按场次列出角色与台词（FR-B07）。 */
export async function exportVoiceScript(root, title, order) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const data = await getDialogue(root, title)
  const targets = order == null ? [...new Set(data.lines.map((l) => l.episode))] : [Number(order)]
  const written = []

  for (const ep of targets) {
    const items = data.lines.filter((l) => l.episode === ep)
    if (!items.length) continue
    const md = [
      `# 第 ${String(ep).padStart(3, '0')} 集 · 配音稿`,
      '',
      '> 由「AI 短剧」工作区从分集剧本自动抽取（FR-B07）。',
      '',
      '| 场次 | 角色 | 台词 |',
      '|---|---|---|',
      ...items.map((l) => `| ${l.scene || ''} | ${l.character} | ${l.text.replace(/\|/g, '\\|')} |`),
      '',
      `> 共 ${items.length} 句`,
      '',
    ].join('\n')
    // RC-26（v0.16.132）：配音稿导出迁到 `导出/`；旧项目旧路径文件保留可读（exporter 回退）。
    const file = path.join(dir, '导出', `配音稿-第${String(ep).padStart(3, '0')}集.md`)
    await writeProjectFile(dir, file, md)
    written.push({ episode: ep, file, lines: items.length })
  }
  return { written, total: written.reduce((sum, w) => sum + w.lines, 0) }
}

/* ---------------------------------------------------------------- 素材库 */

const ASSET_KINDS = ['image', 'audio', 'video', 'doc', 'other']
const HASH_LIMIT = 32 * 1024 * 1024

/* ====================================================================== *
 * v0.16.19（N1-H）：已登记素材分类 `assetCategory`（add-only）
 * - 字段：`.aidrama/assets.json` 条目 add-only `assetCategory`（中文枚举存储；无字段=未分类）；
 * - 读侧：normalizeRegistryEntry 用 `...entry` 原样保留（零改动，旧数据字节不变）；
 * - 写侧：仅 `assets-add` add-only 分类分支 / 登记时携带 / 导入携带，旧数据不迁移不写回；
 * - 写入严格校验（非枚举/控制符/未知 id/重复 id → invalid-args，0 写盘），全有或全无。
 * - v0.16.32（C5b）：枚举 11→19 —— 视频专用（角色表演/场景空镜/道具特写/特效转场）+
 *   文档专用（剧本/设定/参考资料/素材说明）；**B1：host 单一联合枚举、不跨 kind 强校验**，
 *   按 kind 分区（图片11 / 视频4+其他 / 文档4+其他）由 client 负责；旧数据/清单字节不变。
 * ====================================================================== */
export const ASSET_CATEGORIES = Object.freeze([
  '角色', '场景', '道具', '服装', '载具', '特效', '其他', '表情', '分镜', '配音', '音乐',
  '角色表演', '场景空镜', '道具特写', '特效转场',
  '剧本', '设定', '参考资料', '风格参考', '素材说明',
])
export const ASSET_CATEGORY_UPDATES_MAX = 500
const ASSET_CATEGORY_WRITE_KEYS = new Set(['title', 'id', 'assetCategory', 'categoryUpdates', 'expectedHash', 'operationId', 'cwd', 'sessionId'])
const ASSET_CATEGORY_ID_MAX = 120

/** 读取侧宽松归一（client/派生建议用；不写回）：非字符串/非枚举 → ''（未分类）。 */
export function normalizeAssetCategory(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return ASSET_CATEGORIES.includes(text) ? text : ''
}

/** 写入侧严格校验：undefined/null=不写；''=清除（未分类）；其它非枚举/非字符串 → invalid-args。 */
export function assertAssetCategoryWrite(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw assetPathError('invalid-args', 'assetCategory 必须是字符串（空串=清除分类）')
  const text = value.trim()
  if (!text) return ''
  if (!ASSET_CATEGORIES.includes(text)) {
    throw assetPathError('invalid-args', `assetCategory 非法：${value}（可选：${ASSET_CATEGORIES.join('、')}；空串=清除分类）`)
  }
  return text
}

/** 分类更新目标 id 严格校验（登记 id 为任意短字符串，按精确匹配；仅做长度/控制符防御）。 */
function assertAssetEntryId(value) {
  if (typeof value !== 'string') throw assetPathError('invalid-args', 'id 必须是非空字符串')
  const id = value.trim()
  if (!id) throw assetPathError('invalid-args', 'id 必须是非空字符串')
  if (id.length > ASSET_CATEGORY_ID_MAX) throw assetPathError('invalid-args', `id 过长（上限 ${ASSET_CATEGORY_ID_MAX} 字符）`)
  if (/[\u0000-\u001f\u007f]/.test(id)) throw assetPathError('invalid-args', 'id 含控制字符')
  return id
}

/** v0.16.19（N1-H）：assets-add 的 add-only 分类更新形态判定（index 分支与 WRITE_TARGETS 共用口径）。 */
export function isAssetCategoryUpdateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  if (Object.hasOwn(input, 'categoryUpdates')) return true
  return Object.hasOwn(input, 'assetCategory') && Object.hasOwn(input, 'id')
}

function kindOfFile(file) {
  const ext = path.extname(file).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'].includes(ext)) return 'image'
  if (['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'].includes(ext)) return 'audio'
  if (['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(ext)) return 'video'
  if (['.md', '.txt', '.json', '.csv', '.pdf', '.docx'].includes(ext)) return 'doc'
  return 'other'
}

/** v0.16.10（task-157 / M3）：素材登记文件路径。 */
function assetsRegistryFile(dir) {
  return path.join(metaDir(dir), 'assets.json')
}

function registryWarningOf(code, message) {
  return { code, message }
}

/** R-25：旁路元数据（不改变 assets.json 裸数组/cards 形态）。 */
export const REGISTRY_META_RELATIVE = 'registry-meta.json'
export const REGISTRY_META_SCHEMA_VERSION = 1
export const REGISTRY_META_KIND = 'drama-registry-meta'
export const DATA_SCHEMA_VERSIONS = Object.freeze({ assetsRegistry: 1, assetCards: 1, sceneCards: 1 })

/** R-25：只读旁路元数据；缺失/损坏/非整数版本 → 默认 v1，不抛/不写。 */
export async function readRegistryMeta(root, title) {
  const dir = projectDir(root, title)
  const fallback = () => ({
    source: 'default',
    schemaVersion: REGISTRY_META_SCHEMA_VERSION,
    schemas: { ...DATA_SCHEMA_VERSIONS },
    updatedAt: null,
    meta: null,
  })
  if (!(await isDirectory(dir))) return fallback()
  let text
  try {
    text = await fs.readFile(path.join(metaDir(dir), REGISTRY_META_RELATIVE), 'utf8')
  } catch (error) {
    return fallback()
  }
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return fallback()
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.kind !== REGISTRY_META_KIND) return fallback()
  if (!Number.isInteger(doc.schemaVersion) || doc.schemaVersion < 1) return fallback()
  if (!doc.schemas || typeof doc.schemas !== 'object' || Array.isArray(doc.schemas)) return fallback()
  const schemas = {}
  for (const key of Object.keys(DATA_SCHEMA_VERSIONS)) {
    const value = doc.schemas[key]
    schemas[key] = Number.isInteger(value) && value >= 1 ? value : DATA_SCHEMA_VERSIONS[key]
  }
  return {
    source: 'sidecar',
    schemaVersion: doc.schemaVersion,
    schemas,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : null,
    meta: doc,
  }
}

/** R-25：显式写旁路元数据（guardedMetaWrite；dryRun 零写）。 */
export async function writeRegistryMeta(root, title, options = {}) {
  const dryRun = options && options.dryRun === true
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw assetPathError('not-found', `短剧《${assertSafeTitle(title)}》不存在`)
  const meta = {
    kind: REGISTRY_META_KIND,
    schemaVersion: REGISTRY_META_SCHEMA_VERSION,
    schemas: { ...DATA_SCHEMA_VERSIONS },
    updatedAt: new Date().toISOString(),
  }
  if (!dryRun) {
    await guardedMetaWrite(dir, REGISTRY_META_RELATIVE, `${JSON.stringify(meta, null, 2)}\n`)
  }
  return { wrote: !dryRun, dryRun, relative: `.aidrama/${REGISTRY_META_RELATIVE}`, meta }
}

/** 半损坏条目归一（只保留可展示/可写入的最小安全形状；不写回）。 */
function normalizeRegistryEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  if (typeof entry.source !== 'string' || !entry.source.trim()) return null
  const source = entry.source.trim()
  // v0.16.10（M3）：保留 add-only 字段（origin/backend/model/sourceUrl/taskId/episode/downloadedAt/importedFrom 等），
  // 仅对核心字段做防御式归一；不丢 C6/C2/I5-1 写入的溯源数据。
  return {
    ...entry,
    id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `a-recovered-${Math.random().toString(36).slice(2, 8)}`,
    name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 120) : path.basename(source),
    kind: typeof entry.kind === 'string' && entry.kind ? entry.kind : kindOfFile(source),
    source,
    bytes: Number.isFinite(Number(entry.bytes)) ? Number(entry.bytes) : 0,
    mtime: Number.isFinite(Number(entry.mtime)) ? Number(entry.mtime) : 0,
    sha256: typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.sha256) ? entry.sha256.toLowerCase() : null,
    note: typeof entry.note === 'string' ? entry.note.slice(0, 500) : '',
    linkedShots: Array.isArray(entry.linkedShots) ? entry.linkedShots.map((item) => String(item).slice(0, 40)).slice(0, 50) : [],
    addedAt: typeof entry.addedAt === 'string' && entry.addedAt ? entry.addedAt : new Date().toISOString(),
  }
}

/**
 * v0.16.10（task-157 / M3）：素材登记状态（只读，不写盘）。
 * - 缺文件 → registryOk:true（新项目正常）；
 * - 非法 JSON / 顶层非数组 → registryOk:false + registryWarning{code:'registry-corrupt'}，assets:[]（只读降级）；
 * - 半损坏数组 → 过滤无效条目 + registryOk:false + registryWarning{code:'registry-partial'}；
 * - 正常 → registryOk:true。
 */
export async function readAssetsState(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  let text
  try {
    text = await fs.readFile(assetsRegistryFile(dir), 'utf8')
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { assets: [], registryOk: true, registryWarning: null, registryDamage: null }
    }
    return {
      assets: [],
      registryOk: false,
      registryWarning: registryWarningOf('registry-corrupt', '素材登记文件不可读；已降级只读'),
      registryDamage: { kind: 'unreadable', detectedAt: new Date().toISOString(), recoverable: false },
    }
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return {
      assets: [],
      registryOk: false,
      registryWarning: registryWarningOf('registry-corrupt', '素材登记文件损坏（不是合法 JSON）；已降级只读'),
      registryDamage: { kind: 'corrupt', detectedAt: new Date().toISOString(), recoverable: true },
    }
  }
  if (!Array.isArray(data)) {
    return {
      assets: [],
      registryOk: false,
      registryWarning: registryWarningOf('registry-corrupt', '素材登记文件结构非法（应为数组）；已降级只读'),
      registryDamage: { kind: 'corrupt', detectedAt: new Date().toISOString(), recoverable: true },
    }
  }
  const assets = []
  let invalid = 0
  for (const entry of data) {
    const normalized = normalizeRegistryEntry(entry)
    if (normalized) assets.push(normalized)
    else invalid += 1
  }
  if (invalid > 0) {
    return {
      assets,
      registryOk: false,
      registryWarning: registryWarningOf('registry-partial', `素材登记有 ${invalid} 条无效记录；已过滤并降级只读`),
      registryDamage: { kind: 'partial', detectedAt: new Date().toISOString(), recoverable: true, invalidCount: invalid },
    }
  }
  return { assets, registryOk: true, registryWarning: null, registryDamage: null }
}

export async function getAssets(root, title) {
  const state = await readAssetsState(root, title)
  return state.assets
}

/**
 * v0.16.19（N1-H）：读取 assets.json 原始字节 + sha256（只读，不解析/不写盘；不存在 → 全 null）。
 * 供 `assets-get includeAssetsHash:true` 与分类写通道 expectedHash 同口径使用（文件字节 sha256）。
 */
export async function readAssetsRegistryDoc(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  let text
  try {
    text = await fs.readFile(assetsRegistryFile(dir), 'utf8')
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { text: null, hash: null, bytes: 0 }
    return { text: null, hash: null, bytes: 0 }
  }
  return {
    text,
    hash: createHash('sha256').update(text, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(text, 'utf8'),
  }
}

/** v0.16.10（M3）：损坏登记原始字节备份到 .aidrama/backup/assets.<stamp>.json（字节等价；不剪枝）。 */
async function backupAssetsRegistry(dir) {
  const source = assetsRegistryFile(dir)
  let raw
  try {
    raw = await fs.readFile(source)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    throw assetPathError('failed', '素材登记备份失败')
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const relative = `.aidrama/backup/assets.${stamp}.json`
  const target = await assertProjectWriteTarget(dir, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, raw)
  return { relative }
}

/** v0.16.10（M3）：按 素材/ 全量扫描重建登记（sha256 上限 50MB）。 */
const REBUILD_HASH_LIMIT = 50 * 1024 * 1024

/**
 * R-01（v0.16.33）：扫描/repair 目标的写前 canonical 复核。
 * - 只接受当前项目 realRoot 内的普通文件；
 * - 返回项目内相对 canonical source（`素材/...`，`/` 分隔）；
 * - 外部/越界/绝对盘符/UNC/`..`/`.aidrama`/symlink/junction/非普通文件一律 fail-closed（403，
 *   错误文案不泄漏项目外绝对路径）。**仅供 rebuild 显式 repair 写侧使用**；不改读侧 M3。
 */
function sameComparablePath(a, b) {
  const left = process.platform === 'win32' ? a.toLowerCase() : a
  const right = process.platform === 'win32' ? b.toLowerCase() : b
  return left === right
}

async function canonicalMaterialSource(realRoot, realTarget) {
  if (typeof realTarget !== 'string' || !realTarget.trim()) throw assetPathError('invalid-args', '素材源路径非法')
  const root = path.resolve(realRoot)
  const target = path.resolve(realTarget)
  if (path.parse(target).root.toLowerCase() !== path.parse(root).root.toLowerCase()) {
    throw assetPathError('forbidden', '素材源 canonical 校验失败')
  }
  let targetReal
  try {
    targetReal = await fs.realpath(target)
  } catch {
    throw assetPathError('not-found', '素材源不存在')
  }
  if (!isPathInside(root, targetReal)) throw assetPathError('forbidden', '素材源 canonical 校验失败')
  const relative = path.relative(root, targetReal)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw assetPathError('forbidden', '素材源 canonical 校验失败')
  }
  const normalized = relative.split(path.sep).join('/')
  const segments = normalized.split('/')
  if (segments.length < 2 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw assetPathError('forbidden', '素材源 canonical 校验失败')
  }
  if (segments[0] !== '素材') throw assetPathError('forbidden', '素材源 canonical 校验失败')
  if (segments.some((segment) => segment.toLowerCase() === '.aidrama')) {
    throw assetPathError('forbidden', '素材源 canonical 校验失败')
  }
  let current = root
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index])
    let stat
    try {
      stat = await fs.lstat(current)
    } catch {
      throw assetPathError('not-found', '素材源不存在')
    }
    if (stat.isSymbolicLink()) throw assetPathError('forbidden', '素材源 canonical 校验失败')
    if (index < segments.length - 1) {
      if (!stat.isDirectory()) throw assetPathError('not-found', '素材源父路径不是目录')
    } else if (!stat.isFile()) {
      throw assetPathError('forbidden', '素材源不是普通文件')
    }
    let realCurrent
    try {
      realCurrent = await fs.realpath(current)
    } catch {
      throw assetPathError('not-found', '素材源不可读')
    }
    if (!isPathInside(root, realCurrent)) throw assetPathError('forbidden', '素材源 canonical 校验失败')
  }
  const finalReal = await fs.realpath(current)
  if (!sameComparablePath(finalReal, targetReal)) throw assetPathError('forbidden', '素材源 canonical 校验失败')
  return normalized
}

async function rebuildAssetsRegistry(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  let realRoot
  try {
    realRoot = await fs.realpath(dir)
  } catch {
    throw assetPathError('not-found', '短剧项目不可读')
  }
  const materialDir = path.join(realRoot, '素材')
  const materialStat = await fs.stat(materialDir).catch(() => null)
  const found = []
  async function walk(current, depth) {
    if (depth > 64) return
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry || !entry.name || entry.name.startsWith('.')) continue
      if (entry.name === '素材清单.md') continue
      const full = path.join(current, entry.name)
      const stat = await fs.lstat(full).catch(() => null)
      if (!stat) continue
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) { await walk(full, depth + 1); continue }
      if (!stat.isFile()) continue
      const realTarget = await fs.realpath(full).catch(() => null)
      if (!realTarget || !isPathInside(realRoot, realTarget)) continue
      found.push({ realTarget, stat })
    }
  }
  if (materialStat && materialStat.isDirectory()) await walk(materialDir, 0)
  const assets = []
  for (const item of found) {
    // R-01：repair/rebuild 只写项目内相对 canonical source；失败 fail-closed（不写 registry）。
    const source = await canonicalMaterialSource(realRoot, item.realTarget)
    let sha256 = null
    if (item.stat.size <= REBUILD_HASH_LIMIT) {
      try { sha256 = createHash('sha256').update(await fs.readFile(item.realTarget)).digest('hex') } catch { sha256 = null }
    }
    assets.push({
      id: `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: path.basename(item.realTarget).slice(0, 120),
      kind: kindOfFile(item.realTarget),
      source,
      bytes: item.stat.size,
      mtime: item.stat.mtimeMs,
      sha256,
      note: '自动重建',
      linkedShots: [],
      addedAt: new Date().toISOString(),
    })
  }
  await guardedMetaWrite(dir, 'assets.json', JSON.stringify(assets, null, 2) + '\n')
  await renderAssets(dir, title, assets)
  return { assets, rebuiltCount: assets.length }
}

/**
 * R-01b：健康 registry 旧绝对 source 的显式归一化（add-only normalizeSources）。
 * - 只在显式调用；默认路径不调用；
 * - 所有条目先 canonical 校验（全有或全无），任一失败 fail-closed，不写；
 * - 有变化才备份原 registry 字节，再 guarded 写；dry-run 零写；
 * - 只改 source 字段，其余字段/顺序保留。
 */
export async function normalizeRegistrySources(root, title, options = {}) {
  const dryRun = options && options.dryRun === true
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw assetPathError('not-found', `短剧《${assertSafeTitle(title)}》不存在`)
  const state = await readAssetsState(root, title)
  if (state.registryOk !== true) {
    const error = assetPathError('registry-corrupt', '素材登记文件损坏；请先修复后再归一化')
    error.registryOk = false
    error.registryWarning = state.registryWarning
    error.registryDamage = state.registryDamage
    error.next = '带 repairRegistry:true 先重建，或修复该文件后重试'
    throw error
  }
  let realRoot
  try {
    realRoot = await fs.realpath(dir)
  } catch {
    throw assetPathError('not-found', '短剧项目不可读')
  }
  const doc = await readAssetsRegistryDoc(root, title)
  if (!doc.text) return { normalizedCount: 0, alreadyRelativeCount: 0, total: 0, wrote: false, backup: null, dryRun }
  let rows
  try {
    rows = JSON.parse(doc.text)
  } catch {
    throw assetPathError('registry-corrupt', '素材登记文件损坏（不是合法 JSON）')
  }
  if (!Array.isArray(rows)) throw assetPathError('registry-corrupt', '素材登记文件结构非法（应为数组）')
  const nextRows = []
  let normalizedCount = 0
  let alreadyRelativeCount = 0
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.source !== 'string' || !row.source.trim()) {
      throw assetPathError('invalid-args', '素材登记条目 source 非法')
    }
    const rawSource = row.source.trim()
    const target = path.isAbsolute(rawSource) ? rawSource : path.resolve(realRoot, rawSource)
    const canonical = await canonicalMaterialSource(realRoot, target)
    if (canonical === rawSource) alreadyRelativeCount += 1
    else normalizedCount += 1
    nextRows.push({ ...row, source: canonical })
  }
  if (normalizedCount === 0) {
    return { normalizedCount: 0, alreadyRelativeCount, total: rows.length, wrote: false, backup: null, dryRun }
  }
  if (dryRun) {
    return { normalizedCount, alreadyRelativeCount, total: rows.length, wrote: false, backup: null, dryRun: true }
  }
  const backup = await backupAssetsRegistry(dir)
  if (!backup) throw assetPathError('failed', '素材登记备份失败')
  await guardedMetaWrite(dir, 'assets.json', `${JSON.stringify(nextRows, null, 2)}\n`)
  try { await writeRegistryMeta(root, title) } catch { /* meta 旁路写失败不吞掉 registry 主写入 */ }
  return { normalizedCount, alreadyRelativeCount, total: rows.length, wrote: true, backup: backup.relative, dryRun: false }
}

/**
 * v0.16.10（M3）：写前登记闸门。
 * - 登记正常 → 直接返回；
 * - 损坏 → 先做原始字节备份；未显式 repairRegistry → 抛 registry-corrupt（带相对备份路径）；
 * - repairRegistry:true → 备份后按素材扫描重建，再返回（调用方继续本次写入）。
 */
export async function ensureRegistryReady(root, title, options = {}) {
  const state = await readAssetsState(root, title)
  if (state.registryOk) return { ...state, registryRepaired: false, backup: null }
  const dir = projectDir(root, title)
  const backup = await backupAssetsRegistry(dir)
  if (options && options.repairRegistry === true) {
    const repaired = await rebuildAssetsRegistry(root, title)
    // R-25：显式 repair 成功后落旁路 schema meta（best-effort；失败不改变 repair 主结果）。
    try { await writeRegistryMeta(root, title) } catch { /* 旁路元数据失败不阻断 repair */ }
    return {
      assets: repaired.assets,
      registryOk: true,
      registryWarning: state.registryWarning,
      registryRepaired: true,
      rebuiltCount: repaired.rebuiltCount,
      backup: backup ? backup.relative : null,
    }
  }
  const error = assetPathError('registry-corrupt', '素材登记文件损坏；已暂停写入（可带 repairRegistry:true 重建后重试）')
  error.registryOk = false
  error.registryWarning = state.registryWarning
  error.backup = backup ? backup.relative : null
  error.next = '请先备份/修复 .aidrama/assets.json，或带 repairRegistry:true 由宿主按 素材/ 重建'
  throw error
}

/** v0.16.10（M3）：扫描 素材/ 下普通文件（不跟随 symlink/junction；只读）。 */
async function walkMaterialFiles(realRoot, visitor) {
  const materialDir = path.join(realRoot, '素材')
  const materialStat = await fs.stat(materialDir).catch(() => null)
  async function walk(current, depth) {
    if (depth > 64) return
    // v0.16.96（D-0042）：站位图为辅助素材，不登记 assets；素材扫描排除 素材/站位图。
    // RC-24（v0.16.121）：项目封面同为辅助素材，素材扫描排除 素材/封面。
    // RC-26（v0.16.132）：资产库 v2 资产图片由资产卡权威管理，素材扫描排除 素材/短剧资产。
    const relDir = path.relative(realRoot, current).split(path.sep).join('/')
    if (relDir === '素材/站位图' || relDir.startsWith('素材/站位图/')) return
    if (relDir === '素材/封面' || relDir.startsWith('素材/封面/')) return
    if (relDir === ASSET_LIBRARY_DIR || relDir.startsWith(`${ASSET_LIBRARY_DIR}/`)) return
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
      const stat = await fs.lstat(full).catch(() => null)
      if (!stat) continue
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) { await walk(full, depth + 1); continue }
      if (!stat.isFile()) continue
      const realTarget = await fs.realpath(full).catch(() => null)
      if (!realTarget || !isPathInside(realRoot, realTarget)) continue
      await visitor({ full, realTarget, stat, relative: path.relative(realRoot, full).split(path.sep).join('/') })
    }
  }
  if (materialStat && materialStat.isDirectory()) await walk(materialDir, 0)
}

const MATERIAL_SCAN_LIMIT = 1000
const MATERIAL_KIND_EXTENSIONS = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
  video: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'],
  doc: ['md', 'txt', 'json', 'pdf', 'doc', 'docx', 'csv'],
  audio: ['mp3', 'wav', 'm4a', 'ogg', 'aac'],
}

function materialKindGuess(extension) {
  const ext = String(extension || '').replace(/^\./, '').toLowerCase()
  if (!ext) return 'other'
  for (const [kind, extensions] of Object.entries(MATERIAL_KIND_EXTENSIONS)) {
    if (extensions.includes(ext)) return kind
  }
  return 'other'
}

function comparableMaterialPath(value) {
  const resolved = path.resolve(String(value))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** 已登记项目内 source 的 canonical 路径集合 + sha256 集合。 */
async function registeredMaterialIndex(assets, realRoot) {
  const paths = new Set()
  const shas = new Set()
  for (const entry of Array.isArray(assets) ? assets : []) {
    if (entry && typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.sha256)) shas.add(entry.sha256.toLowerCase())
    const source = entry && typeof entry.source === 'string' ? entry.source.trim() : ''
    if (!source) continue
    let candidate
    if (/^[A-Za-z]:[\\/]/.test(source)) candidate = path.resolve(source)
    else if (/^[\\/]{2}/.test(source) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)) continue
    else candidate = path.resolve(realRoot, source)
    const real = await fs.realpath(candidate).catch(() => null)
    if (real && isPathInside(realRoot, real)) paths.add(comparableMaterialPath(real))
  }
  return { paths, shas }
}

export async function scanMaterials(root, title, options = {}) {
  const requestedLimit = Number.isInteger(options && options.limit) && options.limit > 0 ? options.limit : MATERIAL_SCAN_LIMIT
  const limit = Math.min(requestedLimit, MATERIAL_SCAN_LIMIT)
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  let realRoot
  try { realRoot = await fs.realpath(dir) } catch { throw new Error(`短剧《${assertSafeTitle(title)}》不存在`) }
  const state = await readAssetsState(root, title)
  if (!state.registryOk) {
    return {
      files: [], total: 0, truncated: false,
      registryOk: false,
      registryWarning: state.registryWarning,
      unverified: true,
    }
  }
  const registered = await registeredMaterialIndex(state.assets, realRoot)
  const files = []
  await walkMaterialFiles(realRoot, async (item) => {
    if (registered.paths.has(comparableMaterialPath(item.realTarget))) return
    const extension = path.extname(item.full).toLowerCase()
    let sha256 = null
    if (item.stat.size <= HASH_LIMIT) {
      try { sha256 = createHash('sha256').update(await fs.readFile(item.realTarget)).digest('hex') } catch { sha256 = null }
    }
    if (sha256 && registered.shas.has(sha256)) return
    files.push({ path: item.relative, size: item.stat.size, ext: extension, kindGuess: materialKindGuess(extension), sha256 })
  })
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const total = files.length
  const truncated = total > limit
  return { files: files.slice(0, limit), total, truncated, registryOk: true }
}


/* v0.15.8（task-125 / EXT-H1）：素材登记来源必须位于当前项目根目录内（用户原则）。
 * 安全链（Lead 批准）：source 非空/长度/控制字符 → 禁 URI scheme/UNC/设备路径 → 规范化+禁 .. 段/空段 →
 * 解析候选（项目内相对/项目内绝对）→ 字符串级项目内检查 → realpath(项目根)+realpath(候选) 双向包含
 * （symlink 解析到项目外 → forbidden；项目内 symlink 允许）→ 最终 realTarget 必须是普通文件 →
 * 返回 canonical realTarget（项目内绝对规范路径）与 stat。错误码 invalid-args/forbidden/not-found，
 * 错误文本不泄漏项目外绝对路径。 */
function assetPathError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function alsoInsideWorkspace(root, target) {
  return target === root || isPathInside(root, target)
}

function isPathInside(root, target) {
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const normalizedTarget = process.platform === 'win32' ? target.toLowerCase() : target
  const relative = path.relative(normalizedRoot, normalizedTarget)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * v0.15.10（task-131 / C-5）：写前路径包含校验（防 junction/symlink 写逃逸，V1）。
 * 以真实根（realpath(dir)）为边界，逐级检查目标路径：已存在的祖先/目标本身不能是 symlink/junction，
 * 且 realpath 必须在根内；遇到不存在的层级即认为后续由安全根内创建（不再深入探测）。
 * 通过时返回基于真实根的规范目标路径；越界 → forbidden，父目录不可读/目标父级非目录 → not-found。
 */
export async function assertProjectWriteTarget(dir, safeRelPath) {
  const resolved = await resolveProjectWriteTarget(dir, safeRelPath)
  return resolved.target
}

/** R-23（v0.16.31）：guard 同时返回 canonical 项目根，供 atomicWrite 在写入期间复核父目录未被替换。 */
async function resolveProjectWriteTarget(dir, safeRelPath) {
  const relative = String(safeRelPath == null ? '' : safeRelPath)
  if (!relative) throw assetPathError('invalid-args', '缺少写入路径')
  // v0.16.10（M2）：写根本身必须是真实目录（项目根 junction/symlink 一律拒绝）。
  let rootStat
  try {
    rootStat = await fs.lstat(dir)
  } catch {
    throw assetPathError('not-found', '项目目录不存在')
  }
  if (rootStat.isSymbolicLink()) throw assetPathError('forbidden', '写入根是符号链接/junction，已拒绝')
  if (!rootStat.isDirectory()) throw assetPathError('not-found', '写入根不是目录')
  let realDir
  try {
    realDir = await fs.realpath(dir)
  } catch {
    throw assetPathError('not-found', '项目目录不存在')
  }
  const segments = relative.split('/')
  let current = realDir
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index])
    let stat
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { target: path.join(realDir, ...segments), root: realDir }
      throw assetPathError('not-found', '写入路径不可读')
    }
    if (stat.isSymbolicLink()) throw assetPathError('forbidden', '写入路径包含符号链接，已拒绝')
    let realCurrent
    try {
      realCurrent = await fs.realpath(current)
    } catch {
      throw assetPathError('not-found', '写入路径不可读')
    }
    if (!isPathInside(realDir, realCurrent)) throw assetPathError('forbidden', '写入路径越出项目目录')
    if (index < segments.length - 1 && !stat.isDirectory()) throw assetPathError('not-found', '写入目标父路径不是目录')
  }
  return { target: path.join(realDir, ...segments), root: realDir }
}

/**
 * v0.16.10（task-157 / M2）：项目写根校验（项目根 junction/symlink 一律拒绝）。
 * - 工作区根 / `AI短剧` 基础目录 realpath + 包含校验；
 * - 项目目录 lstat 必须是真实目录（junction/symlink → forbidden）；
 * - realpath 必须仍在 `AI短剧` 基础目录内；
 * - 返回项目真实目录；错误码 not-found/forbidden，消息不含绝对路径。
 */
export async function assertProjectWriteRoot(root, title) {
  const safeTitle = assertSafeTitle(title)
  let realRoot
  try {
    realRoot = await fs.realpath(root)
  } catch {
    throw assetPathError('not-found', '工作区目录不可读')
  }
  const base = projectsBase(root)
  let realBase
  try {
    realBase = await fs.realpath(base)
  } catch {
    throw assetPathError('not-found', '短剧项目根目录不存在')
  }
  if (realBase !== realRoot && !isPathInside(realRoot, realBase)) throw assetPathError('forbidden', '项目根目录越出工作区')
  const projectPath = path.join(base, safeTitle)
  let stat
  try {
    stat = await fs.lstat(projectPath)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) throw assetPathError('not-found', `短剧《${safeTitle}》不存在`)
    throw assetPathError('not-found', '项目目录不可读')
  }
  if (stat.isSymbolicLink()) throw assetPathError('forbidden', '项目目录是符号链接/junction，已拒绝写入')
  if (!stat.isDirectory()) throw assetPathError('forbidden', '项目路径不是目录')
  let realProject
  try {
    realProject = await fs.realpath(projectPath)
  } catch {
    throw assetPathError('not-found', '项目目录不可读')
  }
  if (!isPathInside(realBase, realProject)) throw assetPathError('forbidden', '项目目录越出项目根目录')
  return realProject
}

/** v0.16.10（M2）：工作区内相对路径写目标校验（如 workspace `.aidrama/settings.json`）。 */
export async function assertWorkspaceWriteTarget(root, safeRelPath) {
  let realRoot
  try {
    realRoot = await fs.realpath(root)
  } catch {
    throw assetPathError('not-found', '工作区目录不可读')
  }
  const rel = String(safeRelPath == null ? '' : safeRelPath).replace(/\\/g, '/')
  const target = await assertProjectWriteTarget(realRoot, rel)
  return target
}

/** v0.16.10（M2）：项目内相对路径 guard 写（逐段 lstat/realpath；返回真实目标路径）。 */
export async function guardedProjectWrite(dir, safeRelPath, content) {
  const resolved = await resolveProjectWriteTarget(dir, String(safeRelPath == null ? '' : safeRelPath).replace(/\\/g, '/'))
  await atomicWrite(resolved.target, content, { root: resolved.root })
  return resolved.target
}

/** v0.16.10（M2）：项目 `.aidrama/<metaRel>` guard 写（防止 `.aidrama` junction 逃逸）。 */
export async function guardedMetaWrite(dir, metaRel, content) {
  return guardedProjectWrite(dir, `.aidrama/${String(metaRel == null ? '' : metaRel).replace(/\\/g, '/')}`, content)
}

/** v0.16.10（M2）：项目内相对路径 guard 追加（doc-notify 等）。 */
export async function guardedProjectAppend(dir, safeRelPath, text) {
  const target = await assertProjectWriteTarget(dir, String(safeRelPath == null ? '' : safeRelPath).replace(/\\/g, '/'))
  await fs.appendFile(target, text, 'utf8')
  return target
}

/** R-22：项目内 mkdir（先 guard 目标路径，再创建；用于 D 组内部写点收口）。 */
export async function guardedProjectMkdir(dir, safeRelPath) {
  const target = await assertProjectWriteTarget(dir, String(safeRelPath == null ? '' : safeRelPath).replace(/\\/g, '/'))
  await fs.mkdir(target, { recursive: true })
  return target
}

/** R-22：项目内二进制写入（先 guard 目标路径；保留 atomicWrite 语义）。 */
export async function guardedProjectWriteBinary(dir, safeRelPath, buffer) {
  const resolved = await resolveProjectWriteTarget(dir, String(safeRelPath == null ? '' : safeRelPath).replace(/\\/g, '/'))
  await atomicWrite(resolved.target, buffer, { root: resolved.root })
  return resolved.target
}

/** R-22：项目内删除（先 guard 目标路径；用于 D 组回滚/暂存清理）。 */
export async function guardedProjectRemove(dir, safeRelPath) {
  const target = await assertProjectWriteTarget(dir, String(safeRelPath == null ? '' : safeRelPath).replace(/\\/g, '/'))
  await fs.rm(target, { recursive: true, force: true })
  return target
}

/** v0.16.10（M2）：把绝对项目内文件路径换算成相对路径并 guard 写。 */
async function writeProjectFile(dir, file, content) {
  const rel = path.relative(dir, file)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw assetPathError('forbidden', '写入路径越出项目目录')
  return guardedProjectWrite(dir, rel.split(path.sep).join('/'), content)
}

/** v0.16.10（M2）：guard 删除项目内文件（父链 junction 拒绝）。 */
async function rmProjectFile(dir, file) {
  const rel = path.relative(dir, file)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw assetPathError('forbidden', '删除路径越出项目目录')
  const target = await assertProjectWriteTarget(dir, rel.split(path.sep).join('/'))
  await fs.rm(target, { recursive: true, force: true })
}

/** v0.15.10（C-5 补丁）：相对项目根的路径中是否含内部数据目录段（大小写不敏感）。 */
function hasInternalDataSegment(relativePath) {
  return String(relativePath == null ? '' : relativePath)
    .split(/[\\/]+/)
    .some((segment) => segment.trim().toLowerCase() === '.aidrama')
}

async function resolveProjectAssetSource(dir, rawSource) {
  if (typeof rawSource !== 'string') throw assetPathError('invalid-args', '素材路径非法（仅支持项目内相对或项目内绝对路径）')
  const source = rawSource.trim()
  if (!source) throw assetPathError('invalid-args', '缺少素材路径')
  if (source.length > 1000) throw assetPathError('invalid-args', '素材路径过长（上限 1000 字符）')
  if (/[\u0000-\u001f\u007f]/.test(source)) throw assetPathError('invalid-args', '素材路径含控制字符')
  // UNC / Windows 设备路径（\\?\ / \\.\ / 双斜杠开头）一律拒绝（避免网络/设备读取）
  if (/^[\\/]{2}/.test(source)) throw assetPathError('forbidden', '素材必须位于当前短剧项目目录内')
  const isDriveAbsolute = /^[A-Za-z]:[\\/]/.test(source)
  // 非盘符 URI scheme（file:/http:/javascript: 等）拒绝；盘符路径进入项目内校验
  if (!isDriveAbsolute && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)) throw assetPathError('invalid-args', '素材路径非法（仅支持本地文件路径）')
  const normalizedSeparators = source.replace(/\\/g, '/')
  if (!isDriveAbsolute && normalizedSeparators.startsWith('/')) throw assetPathError('invalid-args', '素材路径非法（仅支持项目内相对或项目内绝对路径）')
  const segments = normalizedSeparators.split('/')
  if (segments.some((segment) => segment === '..')) throw assetPathError('invalid-args', '素材路径非法（不允许 .. 跳转）')
  if (segments.some((segment) => segment === '')) throw assetPathError('invalid-args', '素材路径非法（不允许空路径段）')
  // v0.15.10（C-5 / V6）：编码后的 traversal/分隔符/内部目录同样拒绝（不解码落盘）
  if (segments.some((segment) => hasEncodedPathTraversal(segment))) throw assetPathError('invalid-args', '素材路径非法（不允许编码后的 .. 跳转/分隔符）')
  let realRoot
  try {
    realRoot = await fs.realpath(dir)
  } catch {
    throw assetPathError('not-found', `短剧《${assertSafeTitle(path.basename(dir))}》不存在`)
  }
  const candidate = isDriveAbsolute ? path.resolve(source) : path.resolve(realRoot, source)
  // 盘符跳转直接拒绝（不同盘根必然在项目外）；其余以 realpath 终检为准（避免 8.3 短路径/大小写误报）
  if (path.parse(candidate).root.toLowerCase() !== path.parse(realRoot).root.toLowerCase()) {
    throw assetPathError('forbidden', '素材必须位于当前短剧项目目录内')
  }
  // v0.15.10（C-5 补丁）：来源（相对/绝对）不得指向内部数据目录 .aidrama（大小写不敏感）
  if (hasInternalDataSegment(path.relative(realRoot, candidate))) {
    throw assetPathError('forbidden', '素材不能引用内部数据目录（.aidrama）')
  }
  let realTarget
  try {
    realTarget = await fs.realpath(candidate)
  } catch {
    throw assetPathError('not-found', '找不到素材文件')
  }
  if (!isPathInside(realRoot, realTarget)) throw assetPathError('forbidden', '素材必须位于当前短剧项目目录内')
  // realpath 终检：真实目标路径段同样不得为 .aidrama（覆盖大小写变体/符号链接解析后落点）
  if (hasInternalDataSegment(path.relative(realRoot, realTarget))) {
    throw assetPathError('forbidden', '素材不能引用内部数据目录（.aidrama）')
  }
  let stat
  try {
    stat = await fs.stat(realTarget)
  } catch {
    throw assetPathError('not-found', '找不到素材文件')
  }
  if (!stat.isFile()) throw assetPathError('not-found', '素材必须是文件（暂不支持登记目录）')
  return { source: realTarget, stat }
}

/**
 * 登记一个素材：**来源必须在当前项目根目录内，只记路径与校验信息，不复制大文件**（FR-B08）。
 * v0.15.8（task-125）：项目外来源拒绝；规范化为项目内绝对规范路径后存储；历史登记不清除/不改写。
 * v0.15.11（task-134）：可选 `options.sha256` 内部可信哈希（仅一键导入路径使用，必须 64hex 小写；
 * 不暴露为 HTTP 公共入参）；不传时行为完全不变。超过 HASH_LIMIT 的文件跳过哈希计算。
 */
export async function addAsset(root, title, input, options = {}) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw assetPathError('not-found', `短剧《${assertSafeTitle(title)}》不存在`)
  // v0.16.10（task-157 / M3）：写前登记闸门（损坏 → 备份 + 默认拒写 / 显式 repairRegistry 重建）。
  const readiness = await ensureRegistryReady(root, title, { repairRegistry: options && options.repairRegistry === true })
  const resolved = await resolveProjectAssetSource(dir, input && input.source)
  const source = resolved.source
  const rawInputSource = typeof (input && input.source) === 'string' ? input.source.trim() : ''
  const inputIsRelative = Boolean(rawInputSource) && !/^[A-Za-z]:[\\/]/.test(rawInputSource) && !path.isAbsolute(rawInputSource)
  const storedSource = options && options.relativeSource && inputIsRelative
    ? rawInputSource.replace(/\\/g, '/')
    : resolved.source
  const stat = resolved.stat
  const assets = readiness.assets
  const comparableSource = process.platform === 'win32' ? source.toLowerCase() : source
  const duplicate = assets.some((existing) => {
    if (!existing || typeof existing.source !== 'string') return false
    const existingSource = /^[A-Za-z]:[\\/]/.test(existing.source)
      ? path.resolve(existing.source)
      : path.resolve(dir, existing.source)
    const existingComparable = process.platform === 'win32' ? existingSource.toLowerCase() : existingSource
    return existingComparable === comparableSource
  })
  if (duplicate) throw new Error('该文件已登记过')
  // 技术保护值：防止单项目登记文件无限膨胀；不是业务上限（用户要求所有资产类型不设数量上限）。
  if (assets.length >= 10000) throw new Error('素材登记数量达到技术保护值（10000，非业务上限）')

  let sha256 = null
  const trustedSha256 = options && typeof options.sha256 === 'string' ? options.sha256 : ''
  if (trustedSha256) {
    if (!/^[0-9a-f]{64}$/.test(trustedSha256)) throw assetPathError('invalid-args', 'sha256 参数非法（需 64 位小写十六进制）')
    sha256 = trustedSha256
  } else if (stat.size <= HASH_LIMIT) {
    try {
      const buffer = await fs.readFile(source)
      sha256 = createHash('sha256').update(buffer).digest('hex')
    } catch {
      sha256 = null
    }
  }

  const assetCategory = assertAssetCategoryWrite(input && input.assetCategory)
  const asset = {
    id: `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: String((input && input.name) || path.basename(storedSource)).slice(0, 120),
    kind: ASSET_KINDS.includes(input && input.kind) ? input.kind : kindOfFile(storedSource),
    source: storedSource,
    bytes: stat.size,
    mtime: stat.mtimeMs,
    sha256,
    note: String((input && input.note) || '').slice(0, 500),
    linkedShots: Array.isArray(input && input.linkedShots) ? input.linkedShots.map((x) => String(x).slice(0, 40)).slice(0, 50) : [],
    addedAt: new Date().toISOString(),
    ...(assetCategory ? { assetCategory } : {}),
  }

  assets.push(asset)
  await writeJsonDoc(dir, 'assets', assets)
  await renderAssets(dir, title, assets)
  return asset
}

export async function removeAsset(root, title, id) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const readiness = await ensureRegistryReady(root, title, { repairRegistry: false })
  const assets = readiness.assets
  const next = assets.filter((a) => a.id !== id)
  if (next.length === assets.length) throw new Error(`素材不存在：${id}`)
  await writeJsonDoc(dir, 'assets', next)
  await renderAssets(dir, title, next)
  return { id, removed: true }
}

/**
 * v0.16.19（N1-H）：`assets-add` add-only 分类写通道（单条 `{id,assetCategory}` / 批量 `{categoryUpdates}`）。
 * 契约（Lead 裁定 P1/P6）：
 * - 全有或全无：所有 id 先校验存在，任一不存在 → invalid-args（0 写盘）；重复 id → invalid-args；
 * - `assetCategory:''` = 删除字段（未分类）；与现值相同 → 不产生字面变化（changed 只计实际改动）；
 * - `expectedHash`（可选，assets.json 当前字节 sha256）不符 → conflict + currentHash（0 写盘）；
 * - 损坏/半损坏登记 → ensureRegistryReady 抛 registry-corrupt（带原始字节备份，0 写盘）；
 * - 只写 `.aidrama/assets.json`（快照 + 原子写；不渲染 素材清单.md）；无实际变化时不写盘；
 * - 返回 `{ kind:'asset-category', updated, count, changed, wrote, hash, bytes }`（hash/bytes 为写后文件字节）。
 */
export async function setAssetCategories(root, title, input = {}) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const payload = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  for (const key of Object.keys(payload)) {
    if (!ASSET_CATEGORY_WRITE_KEYS.has(key)) throw assetPathError('invalid-args', `assets-add 分类更新不支持字段：${key}`)
  }
  const hasBatch = Object.hasOwn(payload, 'categoryUpdates')
  const hasSingle = Object.hasOwn(payload, 'assetCategory') && Object.hasOwn(payload, 'id')
  if (hasBatch && hasSingle) throw assetPathError('invalid-args', '单条 id/assetCategory 与 categoryUpdates 不能同时提供')
  let updates
  if (hasBatch) {
    const raw = payload.categoryUpdates
    if (!Array.isArray(raw) || raw.length === 0) throw assetPathError('invalid-args', 'categoryUpdates 必须是非空数组')
    if (raw.length > ASSET_CATEGORY_UPDATES_MAX) {
      throw assetPathError('invalid-args', `categoryUpdates 单次最多 ${ASSET_CATEGORY_UPDATES_MAX} 条（当前 ${raw.length}）`)
    }
    updates = raw.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw assetPathError('invalid-args', `categoryUpdates[${index}] 必须是对象 { id, assetCategory }`)
      }
      const extra = Object.keys(item).find((key) => key !== 'id' && key !== 'assetCategory')
      if (extra) throw assetPathError('invalid-args', `categoryUpdates[${index}] 不支持字段：${extra}`)
      if (!Object.hasOwn(item, 'assetCategory')) {
        throw assetPathError('invalid-args', `categoryUpdates[${index}].assetCategory 缺失（空串=清除分类）`)
      }
      return { id: assertAssetEntryId(item.id), assetCategory: assertAssetCategoryWrite(item.assetCategory) }
    })
  } else {
    if (!hasSingle) throw assetPathError('invalid-args', '分类更新需要 { id, assetCategory } 或 { categoryUpdates }')
    updates = [{ id: assertAssetEntryId(payload.id), assetCategory: assertAssetCategoryWrite(payload.assetCategory) }]
  }
  const seen = new Set()
  for (const update of updates) {
    if (seen.has(update.id)) throw assetPathError('invalid-args', `分类更新重复 id：${update.id}`)
    seen.add(update.id)
  }
  let expectedHash = ''
  if (Object.hasOwn(payload, 'expectedHash') && payload.expectedHash !== undefined) {
    if (typeof payload.expectedHash !== 'string') throw assetPathError('invalid-args', 'expectedHash 必须是字符串（assets.json 字节 sha256）')
    expectedHash = payload.expectedHash.trim().toLowerCase()
    if (expectedHash && !/^[0-9a-f]{64}$/.test(expectedHash)) throw assetPathError('invalid-args', 'expectedHash 必须是 64 位十六进制 sha256')
  }
  // 写前登记闸门：损坏/半损坏 → registry-corrupt（已备份）；返回归一后的可写状态。
  const readiness = await ensureRegistryReady(root, title, { repairRegistry: false })
  const doc = await readAssetsRegistryDoc(root, title)
  if (!doc.text || !doc.hash) throw assetPathError('not-found', '素材登记文件不存在')
  if (expectedHash && expectedHash !== doc.hash) {
    const error = new Error('素材登记文件已被其他写入修改（expectedHash 不符）')
    error.code = 'conflict'
    error.currentHash = doc.hash
    error.next = '重新读取最新 assets.json 后再提交'
    throw error
  }
  let rows
  try {
    rows = JSON.parse(doc.text)
  } catch {
    throw assetPathError('invalid-args', '素材登记文件损坏（不是合法 JSON）')
  }
  if (!Array.isArray(rows)) throw assetPathError('invalid-args', '素材登记文件结构非法（应为数组）')
  const positionById = new Map()
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return
    if (typeof row.id !== 'string' || !row.id) return
    if (!positionById.has(row.id)) positionById.set(row.id, index)
  })
  const unknownIds = updates.filter((update) => !positionById.has(update.id)).map((update) => update.id)
  if (unknownIds.length) {
    const error = assetPathError('invalid-args', `素材不存在：${unknownIds.join('、')}`)
    error.unknownIds = unknownIds
    throw error
  }
  let changed = 0
  const updated = []
  for (const update of updates) {
    const row = rows[positionById.get(update.id)]
    if (update.assetCategory === '') {
      if (Object.hasOwn(row, 'assetCategory')) {
        delete row.assetCategory
        changed += 1
      }
      updated.push({ id: update.id, assetCategory: null })
    } else if (row.assetCategory !== update.assetCategory) {
      row.assetCategory = update.assetCategory
      changed += 1
      updated.push({ id: update.id, assetCategory: update.assetCategory })
    } else {
      updated.push({ id: update.id, assetCategory: update.assetCategory })
    }
  }
  const nextText = `${JSON.stringify(rows, null, 2)}\n`
  let wrote = false
  if (changed > 0) {
    await writeJsonDoc(dir, 'assets', rows)
    // v0.16.20（C1）：分类写后同步渲染 素材清单.md（有分类才出现「分类」列；事务/审计 targets 由 index WRITE_TARGETS 覆盖）。
    const categoryById = new Map(updates.map((update) => [update.id, update.assetCategory]))
    const rendered = (Array.isArray(readiness.assets) ? readiness.assets : []).map((entry) => {
      const id = entry && typeof entry.id === 'string' ? entry.id : ''
      if (!categoryById.has(id)) return entry
      const value = categoryById.get(id)
      const next = { ...entry }
      if (value) next.assetCategory = value
      else delete next.assetCategory
      return next
    })
    await renderAssets(dir, title, rendered)
    wrote = true
  }
  const final = wrote ? { hash: createHash('sha256').update(nextText, 'utf8').digest('hex'), bytes: Buffer.byteLength(nextText, 'utf8') } : { hash: doc.hash, bytes: doc.bytes }
  return { kind: 'asset-category', updated, count: updated.length, changed, wrote, hash: final.hash, bytes: final.bytes }
}

/**
 * v0.16.19（N1-H）/ v0.16.20（C1）：素材清单.md 渲染。
 * - v0.16.20（Q3 裁定）：仅当存在枚举内有效 assetCategory 时追加「分类」列
 *   （顺序 名称|类型|分类|大小|关联镜头|路径；未分类=`—`；`|` 转义）；
 * - 无分类项目输出与 v0.16.19 **逐字节一致**（旧项目字节不变，不迁移不回填）。
 */
async function renderAssets(dir, title, assets) {
  const list = Array.isArray(assets) ? assets : []
  const categoryOf = (entry) => normalizeAssetCategory(entry && entry.assetCategory)
  const hasCategory = list.some((entry) => Boolean(categoryOf(entry)))
  const header = hasCategory
    ? '| 名称 | 类型 | 分类 | 大小 | 关联镜头 | 路径 |'
    : '| 名称 | 类型 | 大小 | 关联镜头 | 路径 |'
  const separator = hasCategory ? '|---|---|---|---|---|---|' : '|---|---|---|---|---|'
  const md = [
    `# ${assertSafeTitle(title)} · 素材清单`,
    '',
    '> 由「AI 短剧」工作区生成，源数据 `.aidrama/assets.json`。',
    '> 只登记路径与校验信息，**不复制原始文件**。',
    '',
    header,
    separator,
    ...list.map((a) => {
      const name = String(a.name == null ? '' : a.name)
      const kind = String(a.kind == null ? '' : a.kind)
      const size = `${(a.bytes / 1024).toFixed(1)} KB`
      const shots = (Array.isArray(a.linkedShots) ? a.linkedShots : []).join('、') || '—'
      const source = String(a.source == null ? '' : a.source).replace(/\|/g, '\\|')
      if (!hasCategory) return `| ${name} | ${kind} | ${size} | ${shots} | ${source} |`
      const category = String(categoryOf(a) || '—').replace(/\|/g, '\\|')
      return `| ${name} | ${kind} | ${category} | ${size} | ${shots} | ${source} |`
    }),
    '',
    `> 共 ${list.length} 个素材`,
    '',
  ].join('\n')
  await writeProjectFile(dir, path.join(dir, '素材', '素材清单.md'), md)
}

/* ------------------------------------------------------------ 定稿流程 */

function finalizedFileName(order, version) {
  return `第${String(Math.round(Number(order))).padStart(3, '0')}集.v${version}`
}

export async function getFinalized(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const records = await readJsonDoc(dir, 'finalized', {})
  return Object.entries(records)
    .map(([order, record]) => ({ order: Number(order), ...record }))
    .sort((a, b) => a.order - b.order)
}

/**
 * 定稿某一集：把当前的剧本与分镜**冻结**成一份带版本号的快照（FR-B10）。
 * 分镜同时存 .md（人读）与 .json（可无损回滚）。
 */
export async function finalizeEpisode(root, title, order) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const n = Number(order)
  const { text } = await readEpisode(root, title, n)
  const shots = await getStoryboard(root, title, n)
  if (!text.trim() && !shots.length) throw new Error(`第 ${n} 集还没有剧本或分镜，无法定稿`)

  const records = await readJsonDoc(dir, 'finalized', {})
  const version = ((records[String(n)] && records[String(n)].version) || 0) + 1
  const stem = finalizedFileName(n, version)

  const files = []
  if (text.trim()) {
    const file = path.join(dir, '定稿', `${stem}.md`)
    await writeProjectFile(dir, file, text)
    files.push(`${stem}.md`)
  }
  if (shots.length) {
    await writeProjectFile(dir, path.join(dir, '定稿', `${stem}.分镜.md`), await readFinalizedStoryboardMd(dir, title, n))
    await writeProjectFile(dir, path.join(dir, '定稿', `${stem}.分镜.json`), JSON.stringify(shots, null, 2) + '\n')
    files.push(`${stem}.分镜.md`, `${stem}.分镜.json`)
    // v0.10.0（0-4b）：分组 sidecar 一并进入定稿快照（无分组时行为与旧版一致）
    const groups = await getStoryboardGroups(root, title, n)
    if (Array.isArray(groups) && groups.length) {
      await writeProjectFile(dir, path.join(dir, '定稿', `${stem}.分组.json`), JSON.stringify(groups, null, 2) + '\n')
      files.push(`${stem}.分组.json`)
    }
  }

  records[String(n)] = { version, finalizedAt: new Date().toISOString(), lines: text ? text.split(/\r?\n/).length : 0, shots: shots.length, files }
  await writeJsonDoc(dir, 'finalized', records)
  await renderFinalized(dir, title, records)
  return { order: n, version, finalizedAt: records[String(n)].finalizedAt, shots: shots.length, files }
}

/** 读取已渲染的分镜 Markdown，作为定稿快照的人读副本。 */
async function readFinalizedStoryboardMd(dir, title, order) {
  const file = path.join(dir, '分镜', `${episodeFileName(order).replace('.md', '')}.分镜.md`)
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return `# ${title} · 第 ${order} 集 分镜表\n\n_（定稿时未生成分镜 Markdown）_\n`
  }
}

/** 回滚到某个定稿版本（FR-B10）。 */
export async function restoreFinalized(root, title, order, version) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const n = Number(order)
  const records = await readJsonDoc(dir, 'finalized', {})
  const record = records[String(n)]
  if (!record) throw new Error(`第 ${n} 集还没有定稿记录`)
  // 越界版本必须被拒：显式传了 version 就严格校验；只有省略/空值才回退到最新版本。
  const requested = version == null || version === '' ? null : Number(version)
  if (requested !== null && (!Number.isInteger(requested) || requested < 1 || requested > record.version)) {
    throw new Error(`第 ${n} 集没有 v${version} 版本（当前最新 v${record.version}）`)
  }
  const v = requested ?? record.version
  const stem = finalizedFileName(n, v)

  const restored = []
  const scriptFile = path.join(dir, '定稿', `${stem}.md`)
  if (await pathExists(scriptFile)) {
    const text = await fs.readFile(scriptFile, 'utf8')
    await writeEpisode(root, title, n, text)
    restored.push('剧本')
  }
  const shotsFile = path.join(dir, '定稿', `${stem}.分镜.json`)
  if (await pathExists(shotsFile)) {
    const shots = JSON.parse(await fs.readFile(shotsFile, 'utf8'))
    await saveStoryboard(root, title, n, shots)
    restored.push('分镜')
  }
  // v0.10.0（0-4b）：分组 sidecar 回滚（须在分镜恢复之后，镜号关联校验才成立）
  const groupsFile = path.join(dir, '定稿', `${stem}.分组.json`)
  if (await pathExists(groupsFile)) {
    const groups = JSON.parse(await fs.readFile(groupsFile, 'utf8'))
    await saveStoryboardGroups(root, title, n, groups)
    restored.push('分组')
  }
  // 回滚后重渲染分镜 Markdown（saveStoryboard 渲染时不含分组章节；此处按恢复后的分组补齐）
  if (restored.includes('分镜') || restored.includes('分组')) {
    const currentShots = await getStoryboard(root, title, n)
    const currentGroups = await getStoryboardGroups(root, title, n)
    await writeProjectFile(dir, path.join(dir, '分镜', `${episodeFileName(n).replace('.md', '')}.分镜.md`), renderStoryboardMarkdown(title, n, currentShots, currentGroups))
  }
  if (!restored.length) throw new Error(`v${v} 没有可回滚的内容`)
  return { order: n, version: v, restored }
}

async function renderFinalized(dir, title, records) {
  const rows = Object.entries(records).sort((a, b) => Number(a[0]) - Number(b[0]))
  const md = [
    `# ${assertSafeTitle(title)} · 定稿记录`,
    '',
    '> 由「AI 短剧」工作区生成（FR-B10）。每定稿一次生成一个版本，可回滚。',
    '',
    '| 集数 | 最新版本 | 定稿时间 | 行数 | 镜头数 | 快照文件 |',
    '|---|---|---|---|---|---|',
    ...rows.map(([order, r]) =>
      `| 第 ${order} 集 | v${r.version} | ${r.finalizedAt} | ${r.lines} | ${r.shots} | ${(r.files || []).join('<br>')} |`),
    '',
    `> 共 ${rows.length} 集已定稿`,
    '',
  ].join('\n')
  await writeProjectFile(dir, path.join(dir, '定稿', '定稿记录.md'), md)
}

/* ---------------------------------------------------------------- 账本 */

const SCENE_RE = /^##\s*场景\s*\d*\s*[：:]\s*(.*)$/

/** 解析剧本里的场次：场次标题、内外景、地点、时间。 */
export function parseScenes(text) {
  const scenes = []
  let current = null
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    const match = line.match(SCENE_RE)
    if (match) {
      const slug = match[1].trim() || '未命名场次'
      const parts = slug.split(/\s*[-－—]\s*/)
      current = {
        slug,
        interior: /^内景/.test(parts[0] || ''),
        location: (parts[1] || parts[0] || '').trim(),
        time: (parts[2] || '').trim(),
        characters: new Set(),
      }
      scenes.push(current)
      continue
    }
    const dialogue = line.match(DIALOGUE_RE)
    if (dialogue && current) {
      const who = dialogue[1]
      if (!['动作', '转场', '旁白', '画面', '场景', '音效'].includes(who)) current.characters.add(who)
    }
  }
  return scenes.map((s) => ({ ...s, characters: [...s.characters] }))
}

/**
 * 账本（FR-B11）：按集统计场景/镜头/时长/出场角色/内外景，并给出成本提示。
 * 全部由既有数据推导，不新增源数据。
 */
export async function getLedger(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)

  const episodes = await listEpisodes(root, title)
  const contract = await getContract(root, title)
  const perEpisode = []
  const allCharacters = new Set()
  const allLocations = new Set()

  for (const episode of episodes) {
    const { text } = await readEpisode(root, title, episode.order)
    const scenes = parseScenes(text)
    const shots = await getStoryboard(root, title, episode.order)
    const durationSec = shots.reduce((sum, s) => sum + (Number(s.durationSec) || 0), 0)
    const characters = new Set(scenes.flatMap((s) => s.characters))
    const locations = new Set(scenes.map((s) => s.location).filter(Boolean))
    for (const c of characters) allCharacters.add(c)
    for (const l of locations) allLocations.add(l)
    perEpisode.push({
      order: episode.order,
      scenes: scenes.length,
      shots: shots.length,
      durationSec,
      interiorScenes: scenes.filter((s) => s.interior).length,
      exteriorScenes: scenes.filter((s) => !s.interior).length,
      characters: [...characters],
      locations: [...locations],
    })
  }

  const totals = {
    episodes: perEpisode.length,
    scenes: perEpisode.reduce((s, e) => s + e.scenes, 0),
    shots: perEpisode.reduce((s, e) => s + e.shots, 0),
    durationSec: perEpisode.reduce((s, e) => s + e.durationSec, 0),
    characters: [...allCharacters],
    locations: [...allLocations],
  }

  // 成本提示：短剧生产的现实约束
  const warnings = []
  const [minDur, maxDur] = contract.episodeDurationSec || [0, 0]
  const withShots = perEpisode.filter((e) => e.shots > 0)
  for (const e of withShots) {
    if (maxDur && e.durationSec > maxDur) warnings.push(`第 ${e.order} 集时长 ${e.durationSec}s 超出契约上限 ${maxDur}s`)
  }
  const exteriorRatio = totals.scenes ? perEpisode.reduce((s, e) => s + e.exteriorScenes, 0) / totals.scenes : 0
  if (exteriorRatio > 0.6) warnings.push(`外景占比 ${(exteriorRatio * 100).toFixed(0)}%，置景与转场成本偏高`)
  if (totals.characters.length > 8) warnings.push(`出场角色 ${totals.characters.length} 人，演员与服化道成本偏高`)
  if (totals.locations.size > 12) warnings.push(`地点 ${totals.locations.size} 处，转场成本偏高`)
  if (withShots.length && withShots.some((e) => e.shots > 60)) warnings.push('存在单集镜头数超过 60 的集，拍摄与剪辑工作量偏大')
  if (minDur && withShots.length && withShots.every((e) => e.durationSec < minDur)) {
    warnings.push(`所有已分镜集的时长都低于契约下限 ${minDur}s`)
  }

  return { title: assertSafeTitle(title), perEpisode, totals, warnings }
}

/** 把账本渲染成人读的 Markdown。 */
export async function renderLedger(root, title) {
  const dir = projectDir(root, title)
  const ledger = await getLedger(root, title)
  const md = [
    `# ${ledger.title} · 账本`,
    '',
    '> 由「AI 短剧」工作区从剧本与分镜推导（FR-B11），不新增源数据。',
    '',
    '## 分集统计',
    '',
    '| 集数 | 场景 | 内景 | 外景 | 镜头 | 时长(秒) | 出场角色 | 地点 |',
    '|---|---|---|---|---|---|---|---|',
    ...ledger.perEpisode.map((e) =>
      `| ${e.order} | ${e.scenes} | ${e.interiorScenes} | ${e.exteriorScenes} | ${e.shots} | ${e.durationSec} | ${e.characters.join('、') || '—'} | ${e.locations.join('、') || '—'} |`),
    '',
    '## 合计',
    '',
    `- 集数：${ledger.totals.episodes}`,
    `- 场景：${ledger.totals.scenes}`,
    `- 镜头：${ledger.totals.shots}`,
    `- 总时长：${ledger.totals.durationSec} 秒（约 ${(ledger.totals.durationSec / 60).toFixed(1)} 分钟）`,
    `- 角色：${ledger.totals.characters.length} 人（${ledger.totals.characters.join('、') || '—'}）`,
    `- 地点：${ledger.totals.locations.length} 处（${ledger.totals.locations.join('、') || '—'}）`,
    '',
    '## 成本提示',
    '',
    ...(ledger.warnings.length ? ledger.warnings.map((w) => `- ${w}`) : ['_（未发现明显成本风险）_']),
    '',
  ].join('\n')
  await writeProjectFile(dir, path.join(dir, '账本', '账本.md'), md)
  return { ...ledger, file: path.join(dir, '账本', '账本.md') }
}

/* ---------------------------------------------------------------- 导入 */

/**
 * 把已有文本切分为"集 → 场"结构（FR-E05）。纯确定性切分，可先预览再落盘。
 * 识别 `# 第N集 标题` 作为分集；识别 `## 场景 …` 作为场次；都没有则整篇当作第 1 集单场。
 */
export function splitScript(text, options = {}) {
  const source = String(text || '')
  if (!source.trim()) throw new Error('导入内容为空')
  const episodeRe = /^#\s*第\s*(\d+)\s*集\s*(.*)$/gm
  const marks = []
  let match
  while ((match = episodeRe.exec(source)) !== null) {
    marks.push({ order: Number(match[1]), title: match[2].trim(), index: match.index, headerLength: match[0].length })
  }

  const chunks = []
  if (!marks.length) {
    chunks.push({ order: 1, title: options.defaultTitle || '', body: source })
  } else {
    const preamble = source.slice(0, marks[0].index).trim()
    if (preamble) chunks.push({ order: 0, title: '(前言)', body: preamble })
    for (let i = 0; i < marks.length; i += 1) {
      const start = marks[i].index + marks[i].headerLength
      const end = i + 1 < marks.length ? marks[i + 1].index : source.length
      chunks.push({ order: marks[i].order, title: marks[i].title, body: source.slice(start, end).trim() })
    }
  }

  const seen = new Set()
  const episodes = []
  for (const chunk of chunks) {
    if (chunk.order === 0) continue
    let order = chunk.order
    while (seen.has(order)) order += 1
    seen.add(order)
    const scenes = parseScenes(chunk.body)
    episodes.push({
      order,
      title: chunk.title,
      scenes: scenes.length,
      characters: [...new Set(scenes.flatMap((s) => s.characters))],
      lines: chunk.body.split(/\r?\n/).length,
      body: chunk.body,
    })
  }
  if (!episodes.length) throw new Error('未能从内容中识别出任何剧集')
  return {
    episodes,
    stats: {
      episodes: episodes.length,
      scenes: episodes.reduce((s, e) => s + e.scenes, 0),
      characters: [...new Set(episodes.flatMap((e) => e.characters))].length,
      lines: episodes.reduce((s, e) => s + e.lines, 0),
    },
  }
}

/** 落盘导入结果；overwrite 为 false 时跳过已存在的集。 */
export async function importScript(root, title, text, options = {}) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const { episodes, stats } = splitScript(text, options)
  const overwrite = options.overwrite === true
  const existing = new Set((await listEpisodes(root, title)).map((e) => e.order))
  const written = []
  const skipped = []

  for (const episode of episodes) {
    if (existing.has(episode.order) && !overwrite) {
      skipped.push(episode.order)
      continue
    }
    const header = episode.title ? `# 第${String(episode.order).padStart(3, '0')}集 ${episode.title}` : `# 第${String(episode.order).padStart(3, '0')}集`
    await writeEpisode(root, title, episode.order, `${header}\n\n${episode.body}\n`)
    written.push({ order: episode.order, scenes: episode.scenes, lines: episode.lines })
  }
  return { stats, written, skipped }
}

/* ------------------------------------------------------------ 项目生命周期 */

export async function renameProject(root, title, newTitle) {
  const preDir = projectDir(root, title)
  if (!(await isDirectory(preDir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const from = await assertProjectWriteRoot(root, title)
  const safeNew = assertSafeTitle(newTitle)
  const to = projectDir(root, safeNew)
  if (from === (await fs.realpath(projectDir(root, title)).catch(() => from)) && safeNew === assertSafeTitle(title)) {
    return { from: assertSafeTitle(title), to: safeNew }
  }
  let toStat = null
  try { toStat = await fs.lstat(to) } catch (error) { if (!error || error.code !== 'ENOENT') throw new Error('目标项目路径不可读') }
  if (toStat) throw new Error(`短剧《${safeNew}》已存在`)
  await renameWithRetry(from, to)

  // saveContract 会刻意保留原 title，因此这里直接改源数据并重新渲染
  const contract = await readJsonDoc(to, 'contract', emptyContract(safeNew))
  const next = { ...contract, title: safeNew, updatedAt: new Date().toISOString() }
  await writeJsonDoc(to, 'contract', next)
  await writeProjectFile(to, path.join(to, CONTRACT_FILE), renderContract(next))
  // RC-22（v0.16.100）：best-effort 迁移项目默认会话绑定 key（失败不阻断 rename）
  await migrateProjectSessionKey(root, title, safeNew)
  return { from: assertSafeTitle(title), to: safeNew }
}

export async function deleteProject(root, title) {
  const preDir = projectDir(root, title)
  if (!(await isDirectory(preDir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  // v0.16.10（M2）：项目根 junction/symlink 一律拒绝（避免递归删除跟随到项目外）。
  const realDir = await assertProjectWriteRoot(root, title)
  await fs.rm(realDir, { recursive: true, force: true })
  // RC-22（v0.16.100）：best-effort 清理项目默认会话绑定 key（失败不阻断 delete）
  await removeProjectSessionKey(root, title)
  return { title: assertSafeTitle(title), deleted: true }
}

/* ------------------------------------------------------------ 条目管理 */

export async function createEntry(root, title, relPath, kind) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const safe = assertSafeRelPath(relPath)
  // v0.15.10（C-5）：写前 realpath 包含校验（junction/symlink 逃逸 → forbidden）
  const target = await assertProjectWriteTarget(dir, safe)
  if (await pathExists(target)) throw new Error(`已存在：${safe}`)
  if (kind === 'dir') {
    await fs.mkdir(target, { recursive: true })
  } else {
    await atomicWrite(target, '')
  }
  return { path: safe, kind: kind === 'dir' ? 'dir' : 'file' }
}

export async function writeEntryFile(root, title, relPath, content) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const safe = assertSafeRelPath(relPath)
  // v0.15.10（C-5）：写前 realpath 包含校验（junction/symlink 逃逸 → forbidden）
  const target = await assertProjectWriteTarget(dir, safe)
  if (typeof content !== 'string') throw new Error('文件内容必须是文本')
  await atomicWrite(target, content)
  return { path: safe, bytes: Buffer.byteLength(content, 'utf8') }
}

export async function renameEntry(root, title, relPath, newName) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const safe = assertSafeRelPath(relPath)
  if (safe.includes('/')) throw new Error('目前只支持重命名项目根下的一级节点')
  const fromStat = await fs.lstat(path.join(dir, safe)).catch(() => null)
  if (!fromStat) throw new Error(`不存在：${safe}`)
  if (fromStat.isSymbolicLink()) throw assetPathError('forbidden', '源节点是符号链接/junction，已拒绝')
  const name = assertSafeFileName(newName)
  if (name === safe) return { from: safe, to: name }
  const to = await assertProjectWriteTarget(dir, name)
  if (await pathExists(to)) throw new Error(`已存在：${name}`)
  await renameWithRetry(path.join(dir, safe), to)
  return { from: safe, to: name }
}

export async function deleteEntry(root, title, relPath) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const safe = assertSafeRelPath(relPath)
  if (safe.includes('/')) throw new Error('目前只支持删除项目根下的一级节点')
  const target = await assertProjectWriteTarget(dir, safe)
  const targetStat = await fs.lstat(target).catch(() => null)
  if (targetStat && targetStat.isSymbolicLink()) throw assetPathError('forbidden', '目标节点是符号链接/junction，已拒绝删除')
  if (safe === CONTRACT_FILE) throw new Error('剧集契约是必需文件，不能删除')
  if (['分集剧本', '分镜', '人物', '总纲'].includes(safe)) throw new Error(`${safe} 是工作区必需目录，不能删除`)
  if (!(await pathExists(target))) throw new Error(`不存在：${safe}`)
  await fs.rm(target, { recursive: true, force: true })
  return { path: safe }
}

/* ------------------------------------------------ 资产卡（v0.11.0 / 2-1，add-only） */

/** 资产卡权威存储：`.aidrama/assets/cards.json`（单文件、原子写、v1 无时间戳）。 */
export const ASSET_CARDS_RELATIVE = 'assets/cards.json'

function assetCardsFile(dir) {
  return path.join(metaDir(dir), 'assets', 'cards.json')
}

/**
 * 读取资产卡（只读；旧项目无 `.aidrama/assets/` → 返回空数组，**不建目录、不写文件、不报错**）。
 * 返回归一后的卡（status: archived→retired、未知→draft；按 id 稳定排序）。
 */
export async function getAssetCards(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  let text
  try {
    text = await fs.readFile(assetCardsFile(dir), 'utf8')
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return []
    throw error
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    const invalid = new Error('资产卡文件损坏（不是合法 JSON）：.aidrama/assets/cards.json')
    invalid.code = 'invalid-args'
    throw invalid
  }
  return assetCards.normalizeAssetIndex(data).assets
}

/** 按编号读单张资产卡；不存在返回 null。 */
export async function getAssetCard(root, title, id) {
  const normalized = assetCards.normalizeAssetId(id)
  const cards = await getAssetCards(root, title)
  return cards.find((card) => card.id === normalized) || null
}

/** 下一个可用基础编号（按前缀；不写盘）。 */
export async function nextAssetCardId(root, title, prefix) {
  const cards = await getAssetCards(root, title)
  return assetCards.nextAssetId(cards.map((card) => card.id), prefix)
}

/**
 * 写入/更新资产卡（原子写；首写自动建 `.aidrama/assets/`；同 id → 更新而非新增）。
 * - version 递增、history add-only 追加旧版本+变更摘要；
 * - 写时校验：status 枚举（archived 兼容读入）、id/type/name、variantOf 引用已存在基础 ID、aliases 同类型唯一；
 * - 失败一律抛 invalid-args 且不写盘；v1 无时间戳（确定性）。
 */
export async function saveAssetCard(root, title, input, options = {}) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const raw = input && typeof input === 'object' ? input : {}
  const rawStatus = raw.status == null ? '' : String(raw.status).trim().toLowerCase()
  if (rawStatus && !assetCards.ASSET_STATUSES.includes(rawStatus) && rawStatus !== 'archived') {
    const invalid = new Error(`status 非法：${raw.status}（只能是 draft/active/retired）`)
    invalid.code = 'invalid-args'
    throw invalid
  }
  const existing = await getAssetCards(root, title)
  const createCard = assetCards.normalizeAssetCard(raw)
  const existingCard = existing.find((item) => item.id === createCard.id) || null
  const update = options && options.update === true
  if (existingCard && !update) {
    const invalid = new Error(`资产编号已存在：${createCard.id}（更新请带 options.update=true）`)
    invalid.code = 'invalid-args'
    throw invalid
  }
  if (!existingCard && update) {
    const invalid = new Error(`资产不存在，无法更新：${createCard.id}`)
    invalid.code = 'invalid-args'
    throw invalid
  }
  // 更新：未提供的字段沿用旧卡（避免误清空）；version/history 由存储层维护
  const card = existingCard
    ? assetCards.normalizeAssetCard({ ...existingCard, ...raw, version: existingCard.version })
    : createCard
  const expectedVersion = Number(raw.expectedVersion)
  if (update && Number.isFinite(expectedVersion) && expectedVersion !== existingCard.version) {
    const invalid = new Error(`版本不一致：期望 v${expectedVersion}，当前 v${existingCard.version}`)
    invalid.code = 'invalid-args'
    throw invalid
  }
  // v0.15.1（task-107）：media 写时校验原始输入（未提供=沿用旧 media；null=清空）
  const mediaRawInput = existingCard ? { ...existingCard, ...raw } : raw
  const errors = assetCards.validateAssetCard(card, { existingCards: existing, rawInput: mediaRawInput })
  if (errors.length) {
    const invalid = new Error(errors.join('；'))
    invalid.code = 'invalid-args'
    throw invalid
  }
  if (card.variantOf && !existing.some((item) => item.id === card.variantOf)) {
    const invalid = new Error(`variantOf 引用的基础资产不存在：${card.variantOf}`)
    invalid.code = 'invalid-args'
    throw invalid
  }
  const change = String(raw.change != null ? raw.change : raw.note != null ? raw.note : existingCard ? '更新资产卡' : '创建资产卡')
    .trim()
    .slice(0, 200)
  let next
  if (existingCard) {
    next = {
      ...card,
      version: existingCard.version + 1,
      history: [...existingCard.history, { version: existingCard.version, change }],
    }
  } else {
    next = { ...card, version: 1, history: [] }
  }
  const nextCards = assetCards.sortAssetCards([...existing.filter((item) => item.id !== next.id), next])
  await guardedMetaWrite(dir, 'assets/cards.json', `${JSON.stringify(assetCards.buildAssetIndex(nextCards), null, 2)}\n`)
  return next
}

/* ------------------------------------- 场景卡（v0.11.1 / 2-2 一期，add-only） */

/** 场景卡权威存储：`.aidrama/scenes/cards.json`（单文件、原子写、无时间戳、按 id 排序）。 */
export const SCENES_RELATIVE = 'scenes/cards.json'

function scenesFile(dir) {
  return path.join(metaDir(dir), 'scenes', 'cards.json')
}

/** 读取场景卡（只读；旧项目无 `.aidrama/scenes/` → []，不建目录/不写文件/不报错）。 */
export async function getScenes(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  let text
  try {
    text = await fs.readFile(scenesFile(dir), 'utf8')
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return []
    throw error
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    const invalid = new Error('场景卡文件损坏（不是合法 JSON）：.aidrama/scenes/cards.json')
    invalid.code = 'invalid-args'
    throw invalid
  }
  return scenes.normalizeSceneIndex(data).scenes
}

/** 按编号读单张场景卡；不存在返回 null。 */
export async function getScene(root, title, id) {
  const normalized = scenes.normalizeSceneId(id)
  const list = await getScenes(root, title)
  return list.find((scene) => scene.id === normalized) || null
}

/** 下一个可用场景编号（不写盘）。 */
export async function nextSceneCardId(root, title) {
  const list = await getScenes(root, title)
  return scenes.nextSceneId(list.map((scene) => scene.id))
}

/**
 * 写入/更新场景卡：原子写、首写建目录、重复 ID 创建拒绝（`options.update=true` 才更新）、无时间戳。
 * - **零相机锁合**：禁字段（camera/cameraMove/lens/shotSize/framing/shotNumber/transitionToNext/poses）出现 → invalid-args；
 * - 失败一律 invalid-args 且不写盘；按 id 排序输出。
 */
export async function saveSceneCard(root, title, input, options = {}) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const raw = input && typeof input === 'object' ? input : {}
  const errors = scenes.validateSceneCard(raw)
  if (errors.length) {
    const invalid = new Error(errors.join('；'))
    invalid.code = 'invalid-args'
    throw invalid
  }
  const existing = await getScenes(root, title)
  const card = scenes.normalizeSceneCard(raw)
  const existingCard = existing.find((scene) => scene.id === card.id) || null
  const update = options && options.update === true
  if (existingCard && !update) {
    const invalid = new Error(`场景编号已存在：${card.id}（更新请带 options.update=true）`)
    invalid.code = 'invalid-args'
    throw invalid
  }
  if (!existingCard && update) {
    const invalid = new Error(`场景不存在，无法更新：${card.id}`)
    invalid.code = 'invalid-args'
    throw invalid
  }
  const nextScenes = scenes.sortScenes([...existing.filter((scene) => scene.id !== card.id), card])
  await guardedMetaWrite(dir, 'scenes/cards.json', `${JSON.stringify(scenes.buildSceneIndex(nextScenes), null, 2)}\n`)
  return card
}

/* ====================================================================== *
 * C3（E16 + H-8 `asset-save`）：资产/场景卡多轮审核写入口
 * - readCardsDoc：读取目标 cards.json 原始文本 + sha256（不存在 → 全 null；损坏 → invalid-args）
 * - writeCardsDoc：snapshot 20（`.aidrama/history/assets-cards.<ts>.json` / `scenes-cards.*`）+ 原子写
 * - applyAssetReview：expectedHash/expectedReviewVersion/状态机统一写实现（供 index asset-save 与 Agent 工具复用）
 * ====================================================================== */

/** 读取资产/场景卡文件原始快照（不建文件/不写盘；损坏 → invalid-args）。 */
export async function readCardsDoc(root, title, kind) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const file = kind === 'scene' ? scenesFile(dir) : assetCardsFile(dir)
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { doc: null, text: null, hash: null }
    throw error
  }
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    const invalid = new Error(`卡文件损坏（不是合法 JSON）：${kind === 'scene' ? '.aidrama/scenes/cards.json' : '.aidrama/assets/cards.json'}`)
    invalid.code = 'invalid-args'
    throw invalid
  }
  return { doc, text, hash: createHash('sha256').update(text, 'utf8').digest('hex') }
}

/** 卡文件历史快照（保留最近 HISTORY_LIMIT 份；命名扁平化避免 history 子目录）。 */
async function snapshotCardsDoc(dir, kind) {
  const file = kind === 'scene' ? scenesFile(dir) : assetCardsFile(dir)
  if (!(await pathExists(file))) return
  const prefix = kind === 'scene' ? 'scenes-cards' : 'assets-cards'
  // v0.16.10（M2）：history 写目标 guard（.aidrama junction 拒绝）。
  const historyDir = await assertProjectWriteTarget(dir, '.aidrama/history')
  await fs.mkdir(historyDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const historyTarget = await assertProjectWriteTarget(dir, `.aidrama/history/${prefix}.${stamp}.json`)
  await fs.copyFile(file, historyTarget)
  const files = (await fs.readdir(historyDir)).filter((name) => name.startsWith(`${prefix}.`)).sort()
  for (const stale of files.slice(0, Math.max(0, files.length - HISTORY_LIMIT))) {
    const staleTarget = await assertProjectWriteTarget(dir, `.aidrama/history/${stale}`)
    await fs.rm(staleTarget, { force: true })
  }
}

/** 写卡文件（snapshot 20 + 原子写；未知顶层字段由各卡 normalize 白名单保留）。 */
export async function writeCardsDoc(root, title, kind, nextCards) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const file = kind === 'scene' ? scenesFile(dir) : assetCardsFile(dir)
  await snapshotCardsDoc(dir, kind)
  const indexData = kind === 'scene' ? scenes.buildSceneIndex(nextCards) : assetCards.buildAssetStorageIndex(nextCards)
  const text = `${JSON.stringify(indexData, null, 2)}\n`
  await guardedMetaWrite(dir, kind === 'scene' ? 'scenes/cards.json' : 'assets/cards.json', text)
  return {
    doc: JSON.parse(text),
    text,
    hash: createHash('sha256').update(text, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(text, 'utf8'),
  }
}

/** v0.16.194（P0-③）：扫描全部集分镜的 assetStateBindings + 旧 `::`，返回状态引用列表。 */
async function findStateReferences(root, title, cardId, stateId) {
  const targetCardId = String(cardId || '').toUpperCase()
  const targetStateId = assetCards.normalizeMediaStateId(stateId)
  const references = []
  const episodes = await listEpisodes(root, title).catch(() => [])
  for (const episode of Array.isArray(episodes) ? episodes : []) {
    const shots = await getStoryboard(root, title, episode.order).catch(() => [])
    for (let index = 0; index < shots.length; index += 1) {
      const shot = shots[index]
      const pairs = []
      for (const binding of Array.isArray(shot.assetStateBindings) ? shot.assetStateBindings : []) {
        if (binding && String(binding.cardId || '').toUpperCase() === targetCardId && String(binding.stateId || '') === targetStateId) pairs.push(binding)
      }
      for (const raw of Array.isArray(shot.assetIds) ? shot.assetIds : []) {
        const legacy = parseLegacyAssetStateId(raw)
        if (legacy && legacy.cardId === targetCardId && legacy.stateId === targetStateId) pairs.push(legacy)
      }
      if (pairs.length) {
        references.push({
          episode: episode.order,
          shotIndex: index + 1,
          shotNumber: String(shot.shotNumber || ''),
          count: pairs.length,
        })
      }
    }
  }
  return references
}

/**
 * R-13：资产卡 name/fields 显式字段编辑（asset-save add-only mode=fields）。
 * - expectedHash 必填并严格比对；expectedVersion 可选；final 卡 423；
 * - 合并 fields：未提供键保留，null 删除；name/fields 无实际变化 → wrote:false，不 snapshot/不写；
 * - 成功 version+1 + history，经 writeCardsDoc（snapshot + guardedMetaWrite）原子写。
 */
export async function applyAssetFieldEdit(root, title, input = {}) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const current = await readCardsDoc(root, title, 'asset')
  if (!current.doc || !current.hash) throw assetCards.reviewError('not-found', '资产卡文件不存在')
  const existing = assetCards.normalizeAssetIndex(current.doc).assets
  const normalizedId = assetCards.normalizeAssetId(input.card && input.card.id)
  const card = existing.find((item) => String(item.id) === String(normalizedId)) || null
  if (!card) throw assetCards.reviewError('not-found', `卡不存在：${normalizedId}（assets/cards.json）`)
  const review = assetCards.normalizeReview(card.review)
  if (review && review.status === 'final') {
    throw assetCards.reviewError('asset-locked', '资产已定稿锁定，需先重打开才能编辑字段', { review, currentHash: current.hash })
  }
  const expectedHash = typeof input.expectedHash === 'string' ? input.expectedHash.trim() : ''
  // RC-76：Agent 直改可省略 expectedHash；空串/未传 → 采用本次读到的 latest；显式传值仍严格比对。
  if (expectedHash && expectedHash !== current.hash) {
    throw assetCards.reviewError('conflict', 'cards.json 已被其他写入修改（expectedHash 不符）', { currentHash: current.hash })
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== null && Number(input.expectedVersion) !== card.version) {
    throw assetCards.reviewError('conflict', `资产版本不一致（期望 ${input.expectedVersion}，当前 ${card.version}）`, { currentHash: current.hash, currentVersion: card.version })
  }
  const patch = input.card || {}
  let nextName = card.name
  let nextFields = card.fields && typeof card.fields === 'object' && !Array.isArray(card.fields) ? { ...card.fields } : {}
  let nextPrompts = card.prompts && typeof card.prompts === 'object' && !Array.isArray(card.prompts) ? { ...card.prompts } : {}
  let nextPromptsByState = card.promptsByState && typeof card.promptsByState === 'object' && !Array.isArray(card.promptsByState) ? { ...card.promptsByState } : undefined
  let nextMedia = card.media ? assetCards.normalizeAssetMedia(card.media) : undefined
  const changedFields = []
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string') throw assetCards.reviewError('invalid-args', 'card.name 必须是字符串')
    const name = patch.name.trim()
    if (name.length < 1 || name.length > assetCards.ASSET_FIELD_NAME_MAX) {
      throw assetCards.reviewError('invalid-args', `card.name 长度必须为 1–${assetCards.ASSET_FIELD_NAME_MAX} 字`)
    }
    if (name !== card.name) { nextName = name; changedFields.push('name') }
  }
  if (patch.fields !== undefined) {
    if (!patch.fields || typeof patch.fields !== 'object' || Array.isArray(patch.fields)) {
      throw assetCards.reviewError('invalid-args', 'card.fields 必须是扁平对象')
    }
    for (const [key, value] of Object.entries(patch.fields)) {
      if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw assetCards.reviewError('invalid-args', `card.fields 键非法：${key}`)
      }
      if (value === null) delete nextFields[key]
      else if (typeof value === 'string') {
        const text = value.trim()
        if (text.length > assetCards.ASSET_FIELD_VALUE_MAX) throw assetCards.reviewError('invalid-args', `card.fields.${key} 超长`)
        nextFields[key] = text
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw assetCards.reviewError('invalid-args', `card.fields.${key} 必须是有限数字`)
        nextFields[key] = value
      } else if (typeof value === 'boolean') nextFields[key] = value
      else throw assetCards.reviewError('invalid-args', `card.fields.${key} 必须是字符串/数字/布尔/null`)
    }
    const keys = Object.keys(nextFields)
    if (keys.length > assetCards.ASSET_FIELD_COUNT_MAX) throw assetCards.reviewError('invalid-args', `合并后 fields 超过 ${assetCards.ASSET_FIELD_COUNT_MAX} 组`)
    if (Buffer.byteLength(JSON.stringify(nextFields), 'utf8') > assetCards.ASSET_FIELD_TOTAL_BYTES_MAX) {
      throw assetCards.reviewError('invalid-args', `合并后 fields 超过 ${assetCards.ASSET_FIELD_TOTAL_BYTES_MAX} 字节`)
    }
    if (JSON.stringify(nextFields) !== JSON.stringify(card.fields || {})) changedFields.push('fields')
  }
  // RC-26（v0.16.132 add-only）：card.prompts 显式编辑（整体替换；严格校验；锁定卡由上方 final 锁拒绝）。
  if (patch.prompts !== undefined) {
    const validated = assetCards.parseAssetPromptsInput(patch.prompts)
    const nextPromptsValue = validated || {}
    if (JSON.stringify(nextPromptsValue) !== JSON.stringify(card.prompts || {})) {
      nextPrompts = nextPromptsValue
      changedFields.push('prompts')
    }
  }
  // RC-29（v0.16.135 add-only）：card.media 显式编辑（复用 media 校验；null=清空；final 锁由上方拒绝）。
  if (patch.media !== undefined) {
    if (patch.media !== null) {
      const mediaErrors = assetCards.validateMediaInput(patch.media, { allowMissingActiveState: true })
      if (mediaErrors.length) throw assetCards.reviewError('invalid-args', mediaErrors.join('；'))
      if (String(card.type || '').toUpperCase() !== 'CHR' && Array.isArray(patch.media.states) && patch.media.states.length) {
        throw assetCards.reviewError('invalid-args', 'v1 仅 CHR 支持 media.states（非 CHR 新写拒绝）')
      }
      const transitionError = assetCards.validateMediaStateTransition(card.media, patch.media)
      if (transitionError) throw assetCards.reviewError('invalid-args', transitionError)
      // v0.16.194（P0-③）：删除状态前扫描全部集镜头绑定；有引用 → 409 state-in-use，零写。
      const previousStates = card.media && Array.isArray(card.media.states) ? card.media.states : []
      const nextStateIds = new Set((Array.isArray(patch.media.states) ? patch.media.states : []).map((state) => String(state && state.id || '').trim()).filter(Boolean))
      for (const previousState of previousStates) {
        const stateId = String(previousState && previousState.id || '').trim()
        if (!stateId || nextStateIds.has(stateId)) continue
        const references = await findStateReferences(root, title, normalizedId, stateId)
        if (references.length) {
          throw assetCards.reviewError('state-in-use', `状态「${previousState.name || stateId}」被 ${references.length} 个镜头引用，请先改绑/解除引用后再删除`, {
            cardId: normalizedId,
            stateId,
            references,
          })
        }
      }
      const explicitDefault = patch.media.__defaultStateIdExplicit === true
      const mediaForNormalize = { ...patch.media }
      // v0.16.195：旧 active 不得隐式改默认；非显式 defaultStateId 时沿用卡当前 default。
      delete mediaForNormalize.activeStateId
      if (!explicitDefault) {
        const previousDefault = card.media && typeof card.media.defaultStateId === 'string' ? card.media.defaultStateId : ''
        const nextStateIds = new Set((Array.isArray(patch.media.states) ? patch.media.states : []).map((state) => String(state && state.id || '').trim()).filter(Boolean))
        if (previousDefault && nextStateIds.has(previousDefault)) mediaForNormalize.defaultStateId = previousDefault
        else delete mediaForNormalize.defaultStateId
      }
      nextMedia = assetCards.normalizeAssetMedia(mediaForNormalize)
    } else {
      if (card.media && Array.isArray(card.media.states) && card.media.states.length) throw assetCards.reviewError('invalid-args', '本版只允许新增状态，不能清空含状态的媒体')
      nextMedia = undefined
    }
    if (JSON.stringify(nextMedia || null) !== JSON.stringify(card.media || null)) changedFields.push('media')
  }
  // RC-58：删除状态时清掉该状态的 promptsByState，避免悬空引用。
  if (patch.media !== undefined && nextPromptsByState && nextMedia && Array.isArray(nextMedia.states)) {
    const liveStateIds = new Set(nextMedia.states.map((state) => state.id))
    const cleaned = Object.fromEntries(Object.entries(nextPromptsByState).filter(([stateId]) => liveStateIds.has(stateId)))
    if (JSON.stringify(cleaned) !== JSON.stringify(nextPromptsByState)) {
      nextPromptsByState = Object.keys(cleaned).length ? cleaned : undefined
      if (!changedFields.includes('promptsByState')) changedFields.push('promptsByState')
    }
  }
  // RC-46 phase1：每状态提示词按状态 id 整体替换；null=清空 promptsByState。
  if (patch.promptsByState !== undefined) {
    const validated = assetCards.parsePromptsByStateInput(patch.promptsByState)
    const nextValue = validated === null || validated === undefined ? undefined : validated
    const states = nextMedia && Array.isArray(nextMedia.states) ? nextMedia.states : []
    const stateIds = new Set(states.map((state) => state.id))
    for (const stateId of Object.keys(nextValue || {})) {
      if (!stateIds.has(stateId) && !(stateId === 'default' && !states.length)) throw assetCards.reviewError('invalid-args', `promptsByState 引用了不存在的状态：${stateId}`)
    }
    if (JSON.stringify(nextValue || null) !== JSON.stringify(card.promptsByState || null)) {
      nextPromptsByState = nextValue
      changedFields.push('promptsByState')
    }
  }
  if (changedFields.length === 0) {
    return {
      kind: 'asset', id: normalizedId, path: '.aidrama/assets/cards.json',
      name: card.name, fields: card.fields || {}, prompts: card.prompts || {}, ...(card.promptsByState ? { promptsByState: card.promptsByState } : {}), media: card.media,
      version: card.version, changedFields, wrote: false, hash: current.hash, bytes: Buffer.byteLength(current.text, 'utf8'),
    }
  }
  const nextCard = {
    ...card,
    name: nextName,
    fields: nextFields,
    prompts: nextPrompts,
    ...(nextPromptsByState ? { promptsByState: nextPromptsByState } : {}),
    version: card.version + 1,
    history: [...(Array.isArray(card.history) ? card.history : []), { version: card.version, change: changedFields.length === 1 && changedFields[0] === 'media' ? '更新媒体' : '编辑字段' }],
  }
  if (nextMedia === undefined) delete nextCard.media
  else nextCard.media = nextMedia
  if (nextPromptsByState) nextCard.promptsByState = nextPromptsByState
  else delete nextCard.promptsByState
  const nextCards = assetCards.sortAssetCards([...existing.filter((item) => String(item.id) !== String(normalizedId)), nextCard])
  const written = await writeCardsDoc(root, title, 'asset', nextCards)
  const writtenCard = assetCards.normalizeAssetIndex(written.doc).assets.find((item) => String(item.id) === String(normalizedId)) || nextCard
  return {
    kind: 'asset', id: normalizedId, path: '.aidrama/assets/cards.json',
    name: writtenCard.name, fields: writtenCard.fields, prompts: writtenCard.prompts, ...(writtenCard.promptsByState ? { promptsByState: writtenCard.promptsByState } : {}), media: writtenCard.media,
    version: writtenCard.version, changedFields, wrote: true, hash: written.hash, bytes: written.bytes,
  }
}

/**
 * RC-26（v0.16.132 add-only）：Agent 写回资产卡 prompts（savePrompts）。
 * - final 锁定卡拒绝（asset-locked；不写盘）；expectedVersion 冲突 → conflict；
 * - prompts 严格校验（parseAssetPromptsInput）；整体替换；version+1 + history「更新提示词」；
 * - 原子写 cards.json（writeCardsDoc：snapshot + guardedMetaWrite）。
 */
export async function saveAssetPrompts(root, title, input = {}) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const normalizedId = assetCards.normalizeAssetId(input.id)
  if (!normalizedId) throw assetCards.reviewError('invalid-args', 'id 必填')
  if (!assetCards.isValidAssetId(normalizedId)) throw assetCards.reviewError('invalid-args', `资产编号非法：${input.id}`)
  const current = await readCardsDoc(root, title, 'asset')
  if (!current.doc || !current.hash) throw assetCards.reviewError('not-found', '资产卡文件不存在')
  const existing = assetCards.normalizeAssetIndex(current.doc).assets
  const card = existing.find((item) => String(item.id) === String(normalizedId)) || null
  if (!card) throw assetCards.reviewError('not-found', `卡不存在：${normalizedId}（assets/cards.json）`)
  const review = assetCards.normalizeReview(card.review)
  if (review && review.status === 'final') {
    throw assetCards.reviewError('asset-locked', '资产已定稿锁定，需先在面板重打开/解锁后再保存提示词', { review, currentHash: current.hash })
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== null && Number(input.expectedVersion) !== card.version) {
    throw assetCards.reviewError('conflict', `资产版本不一致（期望 ${input.expectedVersion}，当前 ${card.version}）`, { currentHash: current.hash, currentVersion: card.version })
  }
  let stateId = null
  if (input.stateId !== undefined && input.stateId !== null) {
    stateId = assetCards.normalizeMediaStateId(input.stateId)
    if (!stateId) throw assetCards.reviewError('invalid-args', 'stateId 非法（1–40 位字母/数字/_/-）')
  }
  const prompts = assetCards.parseAssetPromptsInput(input.prompts) || {}
  let nextPrompts = card.prompts || {}
  let nextPromptsByState = card.promptsByState
  let nextMedia = card.media ? assetCards.normalizeAssetMedia(card.media) : undefined
  // v0.16.195：有 states 时无 stateId 写 default（含 defaultStateId 指针），不再写根 prompts。
  if (!stateId && nextMedia && Array.isArray(nextMedia.states) && nextMedia.states.length) stateId = nextMedia.defaultStateId
  if (stateId) {
    let states = nextMedia && Array.isArray(nextMedia.states) ? nextMedia.states : []
    if (!states.some((state) => state.id === stateId)) {
      if (stateId === 'default' && !states.length) {
        const rootImages = nextMedia && Array.isArray(nextMedia.images) ? nextMedia.images : []
        const rootThumb = nextMedia && typeof nextMedia.thumbnail === 'string' ? nextMedia.thumbnail : ''
        const defaultState = { id: 'default', name: '默认', images: rootImages }
        if (rootThumb && rootImages.includes(rootThumb)) defaultState.thumbnail = rootThumb
        nextMedia = assetCards.normalizeAssetMedia({ ...(nextMedia || {}), defaultStateId: 'default', states: [defaultState] })
        states = nextMedia && Array.isArray(nextMedia.states) ? nextMedia.states : []
      } else {
        throw assetCards.reviewError('invalid-args', `状态不存在：${stateId}（只允许在已有状态上写提示词）`)
      }
    }
    const map = { ...(nextPromptsByState && typeof nextPromptsByState === 'object' ? nextPromptsByState : {}) }
    if (Object.keys(prompts).length) map[stateId] = prompts
    else delete map[stateId]
    nextPromptsByState = Object.keys(map).length ? map : undefined
    // 有状态卡：根 prompts 只是读别名，不写第二份。
    nextPrompts = nextMedia && Array.isArray(nextMedia.states) && nextMedia.states.length ? {} : nextPrompts
  } else {
    nextPrompts = prompts
  }
  const nextCard = {
    ...card,
    prompts: nextPrompts,
    ...(nextPromptsByState ? { promptsByState: nextPromptsByState } : {}),
    ...(nextMedia ? { media: nextMedia } : {}),
    version: card.version + 1,
    history: [...(Array.isArray(card.history) ? card.history : []), { version: card.version, change: stateId ? `更新状态提示词（${stateId}）` : '更新提示词' }],
  }
  const nextCards = assetCards.sortAssetCards([...existing.filter((item) => String(item.id) !== String(normalizedId)), nextCard])
  const written = await writeCardsDoc(root, title, 'asset', nextCards)
  const writtenCard = assetCards.normalizeAssetIndex(written.doc).assets.find((item) => String(item.id) === String(normalizedId)) || nextCard
  return {
    ok: true,
    kind: 'asset',
    id: normalizedId,
    path: 'assets/cards.json',
    ...(stateId ? { stateId } : {}),
    prompts: writtenCard.prompts,
    ...(writtenCard.promptsByState ? { promptsByState: writtenCard.promptsByState } : {}),
    version: writtenCard.version,
    hash: written.hash,
    bytes: written.bytes,
  }
}

/**
 * RC-29（v0.16.135 add-only）：Agent 写回资产卡 media（saveMedia）。
 * - final 锁定卡拒绝（asset-locked；不写盘）；expectedVersion 冲突 → conflict；
 * - media 严格校验（validateMediaInput/normalizeAssetMedia）；version+1 + history「更新媒体」；
 * - 原子写 cards.json（writeCardsDoc：snapshot + guardedMetaWrite）。
 */
export async function saveAssetMedia(root, title, input = {}) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const normalizedId = assetCards.normalizeAssetId(input.id)
  if (!normalizedId) throw assetCards.reviewError('invalid-args', 'id 必填')
  if (!assetCards.isValidAssetId(normalizedId)) throw assetCards.reviewError('invalid-args', `资产编号非法：${input.id}`)
  const current = await readCardsDoc(root, title, 'asset')
  if (!current.doc || !current.hash) throw assetCards.reviewError('not-found', '资产卡文件不存在')
  const existing = assetCards.normalizeAssetIndex(current.doc).assets
  const card = existing.find((item) => String(item.id) === String(normalizedId)) || null
  if (!card) throw assetCards.reviewError('not-found', `卡不存在：${normalizedId}（assets/cards.json）`)
  const review = assetCards.normalizeReview(card.review)
  if (review && review.status === 'final') {
    throw assetCards.reviewError('asset-locked', '资产已定稿锁定，需先重打开才能更新媒体', { review, currentHash: current.hash })
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== null && Number(input.expectedVersion) !== card.version) {
    throw assetCards.reviewError('conflict', `资产版本不一致（期望 ${input.expectedVersion}，当前 ${card.version}）`, { currentHash: current.hash, currentVersion: card.version })
  }
  let stateId = null
  if (input.stateId !== undefined && input.stateId !== null) {
    stateId = assetCards.normalizeMediaStateId(input.stateId)
    if (!stateId) throw assetCards.reviewError('invalid-args', 'stateId 非法（1–40 位字母/数字/_/-）')
  }
  let media
  const currentMedia = assetCards.normalizeAssetMedia(card.media) || {}
  const currentStates = Array.isArray(currentMedia.states) ? currentMedia.states : []
  if (String(card.type || '').toUpperCase() !== 'CHR' && (stateId || currentStates.length)) {
    throw assetCards.reviewError('invalid-args', 'v1 仅 CHR 支持状态媒体（非 CHR 新写拒绝）')
  }
  // v0.16.195：已有 states 且未指定 stateId → 旧根媒体写入映射到 default 状态（不是 active）。
  if (!stateId && currentStates.length && input.media && Array.isArray(input.media.states) && input.media.states.length) {
    const mediaErrors = assetCards.validateMediaInput({ ...input.media, defaultStateId: input.media.defaultStateId || currentMedia.defaultStateId }, { allowMissingActiveState: true })
    if (mediaErrors.length) throw assetCards.reviewError('invalid-args', mediaErrors.join('；'))
    media = assetCards.normalizeAssetMedia({ ...input.media, defaultStateId: input.media.defaultStateId || currentMedia.defaultStateId })
    if (!media) throw assetCards.reviewError('invalid-args', '状态媒体归一失败')
  } else if (!stateId && currentStates.length) {
    stateId = currentMedia.defaultStateId || currentStates[0].id
    const target = currentStates.find((state) => state.id === stateId)
    if (!target) throw assetCards.reviewError('invalid-args', `默认状态不存在：${stateId}`)
    if (!input.media || typeof input.media !== 'object' || Array.isArray(input.media)) throw assetCards.reviewError('invalid-args', 'media 必须是对象')
    if (input.media.states !== undefined) throw assetCards.reviewError('invalid-args', '无 stateId 时 media 仅支持 images/thumbnail/audio（兼容根写）')
    if (input.media.images === undefined && input.media.thumbnail === undefined && input.media.audio === undefined) throw assetCards.reviewError('invalid-args', 'media 需要 images/thumbnail/audio')
    const nextState = { ...target }
    if (input.media.images !== undefined) nextState.images = input.media.images
    if (input.media.thumbnail !== undefined) nextState.thumbnail = input.media.thumbnail
    if (!Array.isArray(nextState.images)) nextState.images = []
    if (nextState.thumbnail && !nextState.images.includes(nextState.thumbnail)) delete nextState.thumbnail
    const nextStates = currentStates.map((state) => state.id === stateId ? nextState : state)
    media = assetCards.normalizeAssetMedia({ ...currentMedia, defaultStateId: stateId, states: nextStates })
    if (!media) throw assetCards.reviewError('invalid-args', '状态媒体归一失败')
  } else if (stateId) {
    if (!input.media || typeof input.media !== 'object' || Array.isArray(input.media)) throw assetCards.reviewError('invalid-args', 'stateId 模式需要 media 对象')
    if (input.media.states !== undefined || input.media.audio !== undefined) throw assetCards.reviewError('invalid-args', 'stateId 模式下 media 仅支持 images/thumbnail')
    const target = currentStates.find((state) => state.id === stateId)
    if (!target) throw assetCards.reviewError('invalid-args', `状态不存在：${stateId}`)
    if (input.media.images === undefined && input.media.thumbnail === undefined) throw assetCards.reviewError('invalid-args', 'stateId 模式下需要 images 或 thumbnail')
    const nextState = { ...target }
    if (input.media.images !== undefined) nextState.images = input.media.images
    if (input.media.thumbnail !== undefined) nextState.thumbnail = input.media.thumbnail
    const nextStates = currentStates.map((state) => state.id === stateId ? nextState : state)
    media = assetCards.normalizeAssetMedia({ ...currentMedia, defaultStateId: currentMedia.defaultStateId, states: nextStates })
    if (!media) throw assetCards.reviewError('invalid-args', '状态媒体归一失败')
  } else {
    const mediaErrors = assetCards.validateMediaInput(input.media)
    if (mediaErrors.length) throw assetCards.reviewError('invalid-args', mediaErrors.join('；'))
    media = assetCards.normalizeAssetMedia(input.media)
    if (!media) throw assetCards.reviewError('invalid-args', 'media 不能为空（需 images/thumbnail/audio/states 至少一项）')
  }
  const transitionError = assetCards.validateMediaStateTransition(card.media, media)
  if (transitionError && !stateId) throw assetCards.reviewError('invalid-args', transitionError)
  const nextCard = {
    ...card,
    media,
    version: card.version + 1,
    history: [...(Array.isArray(card.history) ? card.history : []), { version: card.version, change: '更新媒体' }],
  }
  const nextCards = assetCards.sortAssetCards([...existing.filter((item) => String(item.id) !== String(normalizedId)), nextCard])
  const written = await writeCardsDoc(root, title, 'asset', nextCards)
  const writtenCard = assetCards.normalizeAssetIndex(written.doc).assets.find((item) => String(item.id) === String(normalizedId)) || nextCard
  return {
    ok: true,
    kind: 'asset',
    id: normalizedId,
    path: 'assets/cards.json',
    ...(stateId ? { stateId } : {}),
    media: writtenCard.media,
    version: writtenCard.version,
    hash: written.hash,
    bytes: written.bytes,
  }
}

/**
 * 资产/场景卡审核状态机写实现（唯一写入口；index `asset-save` 与 Agent 工具共用）。
 * @param {{kind:'asset'|'scene', id:string, action:string, prompt?:string|null, reason?:string|null,
 *   expectedHash:string, expectedReviewVersion?:number|null, actor?:string, now?:string}} input
 * - expectedHash === '' → 目标文件必须不存在（创建）；否则必须等于当前字节 sha256（不符 conflict + currentHash）。
 * - 返回 { kind, id, path, review, hash, bytes }；失败抛带 code 的错误（不写盘）。
 */
export async function applyAssetReview(root, title, input = {}) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const kind = input.kind === 'scene' ? 'scene' : input.kind === 'asset' ? 'asset' : ''
  if (!kind) throw assetCards.reviewError('invalid-args', "kind 必须是 'asset' 或 'scene'")
  const current = await readCardsDoc(root, title, kind)
  const currentHash = current.hash
  const expectedHash = typeof input.expectedHash === 'string' ? input.expectedHash.trim() : ''
  const existing = kind === 'scene' ? scenes.normalizeSceneIndex(current.doc).scenes : assetCards.normalizeAssetIndex(current.doc).assets
  const normalizedId = kind === 'scene' ? scenes.normalizeSceneId(input.id) : assetCards.normalizeAssetId(input.id)
  const card = existing.find((item) => String(item.id) === String(normalizedId)) || null
  if (!card) {
    // C3 不新建卡：无 cards 文件或卡 id 不存在 → 404（不建文件、不写盘；expectedHash 不用于创建）
    throw assetCards.reviewError('not-found', `卡不存在：${normalizedId}（${kind === 'scene' ? 'scenes/cards.json' : 'assets/cards.json'}）`)
  }
  if (expectedHash !== currentHash) {
    throw assetCards.reviewError('conflict', 'cards.json 已被其他写入修改（expectedHash 不符）', { currentHash })
  }
  const currentReview = assetCards.normalizeReview(card.review)
  if (input.expectedReviewVersion !== undefined && input.expectedReviewVersion !== null) {
    const expectedVersion = Number(input.expectedReviewVersion)
    const actualVersion = currentReview ? currentReview.revision : 0
    if (expectedVersion !== actualVersion) {
      throw assetCards.reviewError('conflict', `review 版本不一致（期望 ${expectedVersion}，当前 ${actualVersion}）`, { currentHash })
    }
  }
  const review = (() => {
    try {
      return assetCards.planReviewAction({
        review: currentReview,
        action: input.action,
        prompt: input.prompt === undefined ? null : input.prompt,
        reason: input.reason === undefined ? null : input.reason,
        actor: input.actor || 'panel',
        now: input.now || new Date().toISOString(),
      })
    } catch (error) {
      if (error && typeof error === 'object') {
        error.currentHash = currentHash
        error.expectedHash = expectedHash
        if (!error.review) error.review = currentReview
      }
      throw error
    }
  })()
  const nextCards = existing.map((item) => (String(item.id) === String(normalizedId) ? { ...item, review } : item))
  const written = await writeCardsDoc(root, title, kind, nextCards)
  return {
    kind,
    id: normalizedId,
    path: kind === 'scene' ? '.aidrama/scenes/cards.json' : '.aidrama/assets/cards.json',
    review: assetCards.normalizeReview(review),
    hash: written.hash,
    bytes: written.bytes,
  }
}


/**
 * v0.16.103（D-0038）：Agent 新建资产卡（仅 asset；draft）。
 * - 复用既有 cards 读/写路径（readCardsDoc/writeCardsDoc：snapshot 20 + 原子写）与 hash 语义；
 * - expectedHash（可选）严格比对当前 cards.json hash（不符 → conflict + currentHash）；
 * - 同 type+name（trim/大小写不敏感）幂等返回 created:false（不写盘/snapshot）；
 * - id 省略 → nextAssetId 自动分配；type 白名单/name 1–120/编号前缀一致性校验；
 * - 不新增 METHOD/route/写点；返回 { ok, kind, id, type, name, path, hash, bytes, created }。
 */
export async function createAssetCard(root, title, input = {}) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const kind = input.kind == null ? 'asset' : String(input.kind)
  if (kind !== 'asset') throw assetCards.reviewError('invalid-args', "create 仅支持 kind='asset'")
  const current = await readCardsDoc(root, title, 'asset')
  const currentHash = current.hash
  if (input.expectedHash !== undefined && input.expectedHash !== null) {
    const expected = String(input.expectedHash).trim()
    const actual = currentHash || ''
    if (expected !== actual) {
      throw assetCards.reviewError('conflict', 'cards.json 已被其他写入修改（expectedHash 不符）', { currentHash })
    }
  }
  const existing = current.doc ? assetCards.normalizeAssetIndex(current.doc).assets : []
  const type = String(input.type == null ? '' : input.type).trim().toUpperCase()
  if (!assetCards.isValidAssetPrefix(type)) {
    throw assetCards.reviewError('invalid-args', `type 非法：${type || '（空）'}（允许 ${assetCards.ASSET_PREFIXES.join('/')}）`)
  }
  const name = String(input.name == null ? '' : input.name).trim()
  if (!name) throw assetCards.reviewError('invalid-args', 'name 必填')
  if (name.length > 120) throw assetCards.reviewError('invalid-args', 'name 长度必须为 1–120 字')
  const nameKey = name.toLowerCase()
  const duplicate = existing.find((card) => String(card.type || '').toUpperCase() === type && String(card.name || '').trim().toLowerCase() === nameKey)
  if (duplicate) {
    return {
      ok: true,
      created: false,
      existing: true,
      kind: 'asset',
      id: String(duplicate.id || ''),
      type: String(duplicate.type || type),
      name: String(duplicate.name || name),
      path: '.aidrama/assets/cards.json',
      hash: currentHash || '',
      bytes: current.bytes || 0,
    }
  }
  let id = input.id == null ? '' : String(input.id).trim().toUpperCase()
  if (id) {
    id = assetCards.normalizeAssetId(id)
    if (!assetCards.isValidAssetId(id)) throw assetCards.reviewError('invalid-args', `id 非法：${input.id}`)
    const parts = assetCards.splitAssetId(id)
    if (parts && parts.prefix !== type) throw assetCards.reviewError('invalid-args', `type=${type} 与编号前缀 ${parts.prefix} 不一致`)
    if (existing.some((card) => assetCards.normalizeAssetId(card.id) === id)) {
      throw assetCards.reviewError('conflict', `资产编号已存在：${id}`, { currentHash })
    }
  } else {
    id = assetCards.nextAssetId(existing.map((card) => card.id), type)
  }
  const card = assetCards.normalizeAssetCard({
    id,
    type,
    name,
    status: 'draft',
    ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
    ...(input.fields !== undefined ? { fields: input.fields } : {}),
  })
  const errors = assetCards.validateAssetCard(card, { existingCards: existing })
  if (errors.length) throw assetCards.reviewError('invalid-args', errors.join('；'))
  const written = await writeCardsDoc(root, title, 'asset', [...existing, card])
  return {
    ok: true,
    created: true,
    kind: 'asset',
    id: card.id,
    type: card.type,
    name: card.name,
    path: '.aidrama/assets/cards.json',
    hash: written.hash,
    bytes: written.bytes,
  }
}


/* ------------------------------------- 五维风格 DNA（v0.11.1 / 2-2 一期，add-only） */

/** 风格 DNA 权威存储：`.aidrama/style.json`（剧集级、单文件、无时间戳）。 */
export const STYLE_DNA_RELATIVE = 'style.json'

function styleDnaFile(dir) {
  return path.join(metaDir(dir), 'style.json')
}

/* ------------------------- C2（E15/H-7 style-save）----------------------------- */

/** 读取 style.json 原始快照（`{doc,text,hash}`；无文件 → 全 null；损坏 → invalid-args）。只读，不迁移/不建文件。 */
export async function readStyleDoc(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  let text
  try {
    text = await fs.readFile(styleDnaFile(dir), 'utf8')
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { doc: null, text: null, hash: null }
    throw error
  }
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    const invalid = new Error('风格 DNA 文件损坏（不是合法 JSON）：.aidrama/style.json')
    invalid.code = 'invalid-args'
    throw invalid
  }
  return { doc, text, hash: createHash('sha256').update(text, 'utf8').digest('hex') }
}

/**
 * 写入 style.json（唯一写实现）：写前 snapshot('style')（历史 20 份）+ 原子写；
 * 必须由调用方传入「已合并未知顶层字段/state」的完整 doc（避免 buildStyleDoc 重建丢字段）。
 */
export async function writeStyleDoc(root, title, doc) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  await snapshot(dir, 'style')
  const text = `${JSON.stringify(doc, null, 2)}\n`
  await guardedMetaWrite(dir, 'style.json', text)
  return {
    doc,
    style: styleDna.normalizeStyleDNA(doc.style),
    state: styleDna.normalizeStyleState(doc.state),
    text,
    hash: createHash('sha256').update(text, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(text, 'utf8'),
  }
}

/** E15：仅当 style.json 存在 state 时返回 styleDirection（状态机只读投影 + 当前字节 hash）。 */
export async function getStyleDirection(root, title) {
  const current = await readStyleDoc(root, title)
  if (!current.doc) return null
  const state = current.doc.state
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null
  return styleDna.styleDirectionFromState(state, current.hash)
}

/** 读取风格 DNA（只读；无文件 → null，不建文件/不报错）。 */
export async function getStyleDNA(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  let text
  try {
    text = await fs.readFile(styleDnaFile(dir), 'utf8')
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    throw error
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    const invalid = new Error('风格 DNA 文件损坏（不是合法 JSON）：.aidrama/style.json')
    invalid.code = 'invalid-args'
    throw invalid
  }
  return styleDna.normalizeStyleDoc(data).style
}

/**
 * 保存风格 DNA（原子写；首写建目录；无时间戳；不注入生成——本卡只存储/读取）。
 * - 写时五维之外字段拒绝（invalid-args）；每维 ≤300 字；
 * - 支持传入五维对象或 { schemaVersion, style }。
 */
export async function saveStyleDNA(root, title, input) {
  // C2（E15/H-7）：旧 saveStyleDNA 兼容层 —— 保留未知顶层字段与 state，统一经 writeStyleDoc 落盘（唯一写实现）；
  // 注意：生产写入口是 `style-save` 路由（含状态机/423/expectedHash），本函数仅保留给内部/历史调用。
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const raw = input && typeof input === 'object' ? input : {}
  const dna = raw.style && typeof raw.style === 'object' && !Array.isArray(raw.style) ? raw.style : raw
  const errors = styleDna.validateStyleDNA(dna)
  if (errors.length) {
    const invalid = new Error(errors.join('；'))
    invalid.code = 'invalid-args'
    throw invalid
  }
  let currentDoc = null
  try {
    currentDoc = (await readStyleDoc(root, title)).doc
  } catch {
    currentDoc = null
  }
  const nextDoc = { ...(currentDoc || {}), schemaVersion: 1, style: styleDna.normalizeStyleDNA(dna) }
  if (currentDoc && currentDoc.state) nextDoc.state = currentDoc.state
  const saved = await writeStyleDoc(root, title, nextDoc)
  return saved.style
}
