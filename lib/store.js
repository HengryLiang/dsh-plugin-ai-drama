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

import { assertSafeFileName, assertSafeRelPath, assertSafeTitle } from './names.js'
import * as assetCards from './assets.js'
import * as scenes from './scenes.js'
import * as styleDna from './style-dna.js'

export const ROOT_DIRNAME = 'AI短剧'
export const META_DIR = '.aidrama'
export const CONTRACT_FILE = '剧集契约.md'
export const SHARED_DIRNAME = '共享资料'

export const PROJECT_DIRS = [
  '构想',
  '总纲',
  '人物',
  '世界观',
  '分集剧本',
  '分镜',
  '台词与音效',
  '素材',
  '草稿区',
  '定稿',
  '账本',
  '本剧记忆',
  '导出',
]

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

/** 原子写入：先写临时文件再 rename，中途崩溃不会留下半截文件（FR-E02）。 */
export async function atomicWrite(file, content) {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`)
  await fs.writeFile(tmp, content, 'utf8')
  await renameWithRetry(tmp, file)
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

export function metaDir(dir) {
  return path.join(dir, META_DIR)
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

export async function createProject(root, rawTitle) {
  const title = assertSafeTitle(rawTitle)
  const dir = projectDir(root, title)
  if (await isDirectory(dir)) throw new Error(`短剧《${title}》已存在`)

  await fs.mkdir(dir, { recursive: true })
  for (const sub of PROJECT_DIRS) {
    await fs.mkdir(path.join(dir, sub), { recursive: true })
  }
  await fs.mkdir(metaDir(dir), { recursive: true })

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
  const historyDir = path.join(metaDir(dir), 'history')
  await fs.mkdir(historyDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await fs.copyFile(source, path.join(historyDir, `${key}.${stamp}.json`))
  const files = (await fs.readdir(historyDir)).filter((f) => f.startsWith(`${key}.`)).sort()
  for (const stale of files.slice(0, Math.max(0, files.length - HISTORY_LIMIT))) {
    await fs.rm(path.join(historyDir, stale), { force: true })
  }
}

async function writeJsonDoc(dir, key, value) {
  await snapshot(dir, key)
  await atomicWrite(path.join(metaDir(dir), `${key}.json`), JSON.stringify(value, null, 2) + '\n')
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
  return [
    `# ${contract.title} · 剧集契约`,
    '',
    '> 本文件由「AI 短剧」工作区生成，源数据为 `.aidrama/contract.json`；',
    '> 直接改这里不会生效——请在插件面板中编辑。',
    '',
    '| 字段 | 值 |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${String(v ?? '').replace(/\|/g, '\\|')} |`),
    '',
    `> 最后更新：${contract.updatedAt || ''}`,
    '',
  ].join('\n')
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

  await writeJsonDoc(dir, 'contract', next)
  await atomicWrite(path.join(dir, CONTRACT_FILE), renderContract(next))
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
  await atomicWrite(path.join(dir, '总纲', '分集大纲.md'), renderOutline(assertSafeTitle(title), normalized))
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
  await atomicWrite(path.join(dir, '人物', '人物设定卡.md'), md)
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
  await atomicWrite(file, text)
  return { order: Number(order), bytes: Buffer.byteLength(text, 'utf8') }
}

/* ---------------------------------------------------------------- 分镜 */

const SHOT_SIZES = ['远景', '全景', '中景', '近景', '特写', '大特写']

/** 分镜的规范字段顺序与默认值：读取旧数据时补默认值，并保证序列化 key 顺序稳定（定稿快照哈希依赖它）。 */
const SHOT_DEFAULTS = {
  shotNumber: '',
  shotSize: '中景',
  cameraMove: '',
  description: '',
  dialogue: '',
  sfx: '',
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
]
const SHOT_TRANSITIONS = ['hard-cut', 'match-cut', 'whip-pan', 'one-take']
const SHOT_RESERVED_KEYS = [...SHOT_KNOWN_KEYS, ...SHOT_OPTIONAL_KEYS]
const SHOT_TEXT_LIMITS = { light: 500, ambientSound: 300, naturalLanguagePrompt: 3000, lens: 40, subject: 60, groupId: 20, sceneRef: 10 }

/** v0.10.0：可选字段单一事实源（导出/渲染/QA 共用；只读常量）。 */
export const SHOT_OPTIONAL_FIELDS = [...SHOT_OPTIONAL_KEYS]

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
  for (const key of ['light', 'ambientSound', 'naturalLanguagePrompt', 'lens', 'subject', 'groupId']) {
    if (shot[key] == null) continue
    if (typeof shot[key] !== 'string') throw invalidArgsError(`${where}.${key} 必须是字符串`)
    const text = shot[key].trim().slice(0, SHOT_TEXT_LIMITS[key])
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
  // 固定为 SHOT_OPTIONAL_KEYS 顺序输出（保证序列化确定性）
  return Object.fromEntries(SHOT_OPTIONAL_KEYS.filter((key) => Object.hasOwn(optional, key)).map((key) => [key, optional[key]]))
}

export async function getStoryboard(root, title, order) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const shots = await readJson(path.join(metaDir(dir), 'storyboard', `${episodeFileName(order)}.json`), [])
  // H-3：videoPrompt 是后加字段，旧数据没有它 —— 读取时即按规范顺序补默认值，
  // 既保证读取形状稳定，也保证「定稿快照 JSON ↔ 回滚后重写 JSON」的字节级确定性。
  return Array.isArray(shots) ? shots.map((shot) => ({ ...SHOT_DEFAULTS, ...shot })) : []
}


/** 归一镜头数组（v0.10.0 0-4a/0-4b）：已知字段 + 可选字段 + 未知字段保留。 */
function normalizeShots(shots, order) {
  if (!Array.isArray(shots)) throw new Error('分镜必须是镜头数组')
  if (shots.length > 500) throw new Error('单集镜头数量过多（上限 500）')
  return shots.map((shot, index) => {
    if (!shot || typeof shot !== 'object') throw new Error(`第 ${index + 1} 个镜头格式不正确`)
    const durationSec = Number(shot.durationSec)
    const known = {
      shotNumber: String(shot.shotNumber ?? `${Math.round(Number(order))}-${index + 1}`).slice(0, 20),
      shotSize: SHOT_SIZES.includes(shot.shotSize) ? shot.shotSize : '中景',
      cameraMove: String(shot.cameraMove ?? '').slice(0, 60),
      description: String(shot.description ?? '').slice(0, 1000),
      dialogue: String(shot.dialogue ?? '').slice(0, 1000),
      sfx: String(shot.sfx ?? '').slice(0, 200),
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec) : 0,
      imagePrompt: String(shot.imagePrompt ?? '').slice(0, 1000),
      // H-3（FR-E04 视频分镜）：视频运镜/成片提示词，只增字段不影响旧数据。
      videoPrompt: String(shot.videoPrompt ?? '').slice(0, 1000),
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
  const hasOptional = normalized.some((shot) => SHOT_OPTIONAL_KEYS.some((key) => key !== 'sceneRef' && Object.hasOwn(shot, key)))
  const baseHeaders = ['镜号', '景别', '运镜', '画面描述', '台词', '音效', '时长(秒)', '提示词', '视频提示词']
  const extraHeaders = ['情绪', '光影', '现场声', '禁令', '起止姿态', '衔接', '自然语言段', '焦段', '主体', '分组']
  const headers = hasOptional ? [...baseHeaders, ...extraHeaders] : baseHeaders
  const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const renderShot = (shot) => {
    const base = [shot.shotNumber, shot.shotSize, shot.cameraMove, shot.description, shot.dialogue, shot.sfx, shot.durationSec, shot.imagePrompt, shot.videoPrompt]
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
  const normalized = normalizeShots(shots, order)
  // 保持与 v0.9.x 相同的快照 key（历史版本只在同时存在对应文件时才留档，旧行为不改）
  await snapshot(dir, `storyboard-${episodeFileName(order)}`)
  await writeTextFile(path.join(metaDir(dir), 'storyboard', `${episodeFileName(order)}.json`), JSON.stringify(normalized, null, 2) + '\n')
  await writeTextFile(path.join(dir, '分镜', `${episodeFileName(order).replace('.md', '')}.分镜.md`), renderStoryboardMarkdown(title, order, normalized, null))
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
  const normalized = normalizeShots(shots, order)
  const storyboardFile = path.join(metaDir(dir), 'storyboard', `${episodeFileName(order)}.json`)
  const markdownFile = path.join(dir, '分镜', `${episodeFileName(order).replace('.md', '')}.分镜.md`)
  const backups = new Map()
  for (const file of [storyboardFile, markdownFile]) backups.set(file, await readFileOrNull(file))
  try {
    await snapshot(dir, `storyboard-${episodeFileName(order)}`)
    await writeTextFile(storyboardFile, JSON.stringify(normalized, null, 2) + '\n')
    await writeTextFile(markdownFile, renderStoryboardMarkdown(title, order, normalized, null))
  } catch (error) {
    for (const [file, content] of backups) await restoreFile(file, content)
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

/**
 * v0.11.2（task-98 / 2-4 E7）：storyboard 读取响应（只读，不写盘）。
 * - 返回 { shots }；**仅当 sidecar 存在且可解析时**追加 groups（数组）；
 * - 组数 >100 时追加 `groupsTruncated:true`（顶层、仅截断时出现）；
 * - 无 sidecar / sidecar 损坏 → 不输出 groups、不报错（旧输出逐字节不变）。
 */
export async function getStoryboardReadView(root, title, order) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const shots = await getStoryboard(root, title, order)
  const groups = await getStoryboardGroups(root, title, order)
  if (!Array.isArray(groups)) return { shots }
  const { groups: groupView, truncated } = buildStoryboardGroupsView(groups)
  return truncated ? { shots, groups: groupView, groupsTruncated: true } : { shots, groups: groupView }
}

/** 保存分镜分组（独立写；[] 清空/删除 sidecar）。 */
export async function saveStoryboardGroups(root, title, order, groups) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const shots = await getStoryboard(root, title, order)
  const normalized = normalizeStoryboardGroups(groups, shots.map((shot) => String(shot.shotNumber || '').trim()).filter(Boolean), `第 ${order} 集分组`)
  const file = storyboardGroupsFile(dir, order)
  if (!normalized.length) {
    await fs.rm(file, { force: true })
    return []
  }
  await writeTextFile(file, JSON.stringify(wrapStoryboardGroups(order, normalized), null, 2) + '\n')
  return normalized
}

/** 删除分镜分组 sidecar。 */
export async function deleteStoryboardGroups(root, title, order) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  await fs.rm(storyboardGroupsFile(dir, order), { force: true })
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
  const normalizedShots = normalizeShots(shots, order)
  const shotNumbers = normalizedShots.map((shot) => String(shot.shotNumber || '').trim()).filter(Boolean)
  const normalizedGroups = normalizeStoryboardGroups(groups, shotNumbers, `第 ${order} 集分组`)
  const storyboardFile = path.join(metaDir(dir), 'storyboard', `${episodeFileName(order)}.json`)
  const markdownFile = path.join(dir, '分镜', `${episodeFileName(order).replace('.md', '')}.分镜.md`)
  const groupsFile = storyboardGroupsFile(dir, order)
  const backups = new Map()
  for (const file of [storyboardFile, markdownFile, groupsFile]) backups.set(file, await readFileOrNull(file))
  try {
    if (normalizedGroups.length) await writeTextFile(groupsFile, JSON.stringify(wrapStoryboardGroups(order, normalizedGroups), null, 2) + '\n')
    else await fs.rm(groupsFile, { force: true })
    await writeTextFile(storyboardFile, JSON.stringify(normalizedShots, null, 2) + '\n')
    await writeTextFile(markdownFile, renderStoryboardMarkdown(title, order, normalizedShots, normalizedGroups))
  } catch (error) {
    for (const [file, content] of backups) await restoreFile(file, content)
    throw error
  }
  return { shots: normalizedShots, groups: normalizedGroups }
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
  await atomicWrite(path.join(dir, '本剧记忆', '本剧记忆.md'), md)
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

export const WORLD_KINDS = ['地点', '组织', '规则', '道具', '时间线']

export async function getWorld(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  return readJsonDoc(dir, 'world', [])
}

export async function saveWorld(root, title, entries) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  if (!Array.isArray(entries)) throw new Error('世界观必须是条目数组')
  if (entries.length > 500) throw new Error('世界观条目过多（上限 500）')

  const seen = new Set()
  const normalized = entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`第 ${index + 1} 条设定格式不正确`)
    const name = String(entry.name || '').trim()
    if (!name) throw new Error(`第 ${index + 1} 条设定缺少名称`)
    let id = String(entry.id || '').trim() || `w-${index + 1}-${Date.now().toString(36)}`
    if (seen.has(id)) id = `${id}-${index}`
    seen.add(id)
    return {
      id,
      kind: WORLD_KINDS.includes(entry.kind) ? entry.kind : '地点',
      name: name.slice(0, 60),
      detail: String(entry.detail || '').slice(0, 2000),
    }
  })

  const dup = new Set()
  for (const entry of normalized) {
    const key = `${entry.kind}:${entry.name}`
    if (dup.has(key)) throw new Error(`同类型下名称重复：${entry.kind} · ${entry.name}`)
    dup.add(key)
  }

  await writeJsonDoc(dir, 'world', normalized)

  const groups = WORLD_KINDS.map((kind) => [kind, normalized.filter((e) => e.kind === kind)]).filter(([, list]) => list.length)
  const md = [
    `# ${assertSafeTitle(title)} · 世界观设定`,
    '',
    '> 由「AI 短剧」工作区生成，源数据 `.aidrama/world.json`。',
    '',
    ...(groups.length
      ? groups.flatMap(([kind, list]) => [
          `## ${kind}`,
          '',
          ...list.flatMap((e) => [`### ${e.name}`, '', e.detail || '_（暂无说明）_', '']),
        ])
      : ['_（暂无设定）_', '']),
  ].join('\n')
  await atomicWrite(path.join(dir, '世界观', '世界观.md'), md)
  return normalized
}

/* -------------------------------------------------------------- 共享资料 */

export function sharedDir(root) {
  return path.join(projectsBase(root), SHARED_DIRNAME)
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
  const target = path.join(base, safe)
  if (!target.startsWith(base)) throw new Error('路径越界')
  if (typeof text !== 'string') throw new Error('内容必须是文本')
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

export async function getSettings(root) {
  const stored = await readJson(path.join(projectsBase(root), META_DIR, 'settings.json'), {})
  const defaults = emptySettings()
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return defaults
  return { ...defaults, ...stored }
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

  await atomicWrite(path.join(projectsBase(root), META_DIR, 'settings.json'), JSON.stringify(next, null, 2) + '\n')
  return next
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
    const file = path.join(dir, '台词与音效', `配音稿-第${String(ep).padStart(3, '0')}集.md`)
    await atomicWrite(file, md)
    written.push({ episode: ep, file, lines: items.length })
  }
  return { written, total: written.reduce((sum, w) => sum + w.lines, 0) }
}

/* ---------------------------------------------------------------- 素材库 */

const ASSET_KINDS = ['image', 'audio', 'video', 'doc', 'other']
const HASH_LIMIT = 32 * 1024 * 1024

function kindOfFile(file) {
  const ext = path.extname(file).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'].includes(ext)) return 'image'
  if (['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'].includes(ext)) return 'audio'
  if (['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(ext)) return 'video'
  if (['.md', '.txt', '.json', '.csv', '.pdf', '.docx'].includes(ext)) return 'doc'
  return 'other'
}

export async function getAssets(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  return readJsonDoc(dir, 'assets', [])
}

/**
 * 登记一个外部素材：**只记路径与校验信息，不把大文件复制进项目**（FR-B08）。
 * 超过 HASH_LIMIT 的文件跳过哈希计算。
 */
export async function addAsset(root, title, input) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const source = String((input && input.source) || '').trim()
  if (!source) throw new Error('缺少素材路径')

  let stat
  try {
    stat = await fs.stat(source)
  } catch {
    throw new Error(`找不到文件：${source}`)
  }
  if (!stat.isFile()) throw new Error('素材必须是文件（暂不支持登记目录）')

  const assets = await readJsonDoc(dir, 'assets', [])
  if (assets.some((a) => a.source === source)) throw new Error('该文件已登记过')
  if (assets.length >= 500) throw new Error('素材数量过多（上限 500）')

  let sha256 = null
  if (stat.size <= HASH_LIMIT) {
    try {
      const buffer = await fs.readFile(source)
      sha256 = createHash('sha256').update(buffer).digest('hex')
    } catch {
      sha256 = null
    }
  }

  const asset = {
    id: `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: String((input && input.name) || path.basename(source)).slice(0, 120),
    kind: ASSET_KINDS.includes(input && input.kind) ? input.kind : kindOfFile(source),
    source,
    bytes: stat.size,
    mtime: stat.mtimeMs,
    sha256,
    note: String((input && input.note) || '').slice(0, 500),
    linkedShots: Array.isArray(input && input.linkedShots) ? input.linkedShots.map((x) => String(x).slice(0, 40)).slice(0, 50) : [],
    addedAt: new Date().toISOString(),
  }

  assets.push(asset)
  await writeJsonDoc(dir, 'assets', assets)
  await renderAssets(dir, title, assets)
  return asset
}

export async function removeAsset(root, title, id) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const assets = await readJsonDoc(dir, 'assets', [])
  const next = assets.filter((a) => a.id !== id)
  if (next.length === assets.length) throw new Error(`素材不存在：${id}`)
  await writeJsonDoc(dir, 'assets', next)
  await renderAssets(dir, title, next)
  return { id, removed: true }
}

async function renderAssets(dir, title, assets) {
  const md = [
    `# ${assertSafeTitle(title)} · 素材清单`,
    '',
    '> 由「AI 短剧」工作区生成，源数据 `.aidrama/assets.json`。',
    '> 只登记路径与校验信息，**不复制原始文件**。',
    '',
    '| 名称 | 类型 | 大小 | 关联镜头 | 路径 |',
    '|---|---|---|---|---|',
    ...assets.map(
      (a) =>
        `| ${a.name} | ${a.kind} | ${(a.bytes / 1024).toFixed(1)} KB | ${a.linkedShots.join('、') || '—'} | ${a.source.replace(/\|/g, '\\|')} |`,
    ),
    '',
    `> 共 ${assets.length} 个素材`,
    '',
  ].join('\n')
  await atomicWrite(path.join(dir, '素材', '素材清单.md'), md)
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
    await atomicWrite(file, text)
    files.push(`${stem}.md`)
  }
  if (shots.length) {
    await atomicWrite(path.join(dir, '定稿', `${stem}.分镜.md`), await readFinalizedStoryboardMd(dir, title, n))
    await atomicWrite(path.join(dir, '定稿', `${stem}.分镜.json`), JSON.stringify(shots, null, 2) + '\n')
    files.push(`${stem}.分镜.md`, `${stem}.分镜.json`)
    // v0.10.0（0-4b）：分组 sidecar 一并进入定稿快照（无分组时行为与旧版一致）
    const groups = await getStoryboardGroups(root, title, n)
    if (Array.isArray(groups) && groups.length) {
      await atomicWrite(path.join(dir, '定稿', `${stem}.分组.json`), JSON.stringify(groups, null, 2) + '\n')
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
    await writeTextFile(path.join(dir, '分镜', `${episodeFileName(n).replace('.md', '')}.分镜.md`), renderStoryboardMarkdown(title, n, currentShots, currentGroups))
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
  await atomicWrite(path.join(dir, '定稿', '定稿记录.md'), md)
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
  await atomicWrite(path.join(dir, '账本', '账本.md'), md)
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
  const from = projectDir(root, title)
  if (!(await isDirectory(from))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const safeNew = assertSafeTitle(newTitle)
  const to = projectDir(root, safeNew)
  if (from === to) return { from: assertSafeTitle(title), to: safeNew }
  if (await isDirectory(to)) throw new Error(`短剧《${safeNew}》已存在`)
  await renameWithRetry(from, to)

  // saveContract 会刻意保留原 title，因此这里直接改源数据并重新渲染
  const contract = await readJsonDoc(to, 'contract', emptyContract(safeNew))
  const next = { ...contract, title: safeNew, updatedAt: new Date().toISOString() }
  await writeJsonDoc(to, 'contract', next)
  await atomicWrite(path.join(to, CONTRACT_FILE), renderContract(next))
  return { from: assertSafeTitle(title), to: safeNew }
}

export async function deleteProject(root, title) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  await fs.rm(dir, { recursive: true, force: true })
  return { title: assertSafeTitle(title), deleted: true }
}

/* ------------------------------------------------------------ 条目管理 */

export async function createEntry(root, title, relPath, kind) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const safe = assertSafeRelPath(relPath)
  const target = path.join(dir, safe)
  if (!target.startsWith(dir)) throw new Error('路径越界')
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
  const target = path.join(dir, safe)
  if (!target.startsWith(dir)) throw new Error('路径越界')
  if (typeof content !== 'string') throw new Error('文件内容必须是文本')
  await atomicWrite(target, content)
  return { path: safe, bytes: Buffer.byteLength(content, 'utf8') }
}

export async function renameEntry(root, title, relPath, newName) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const safe = assertSafeRelPath(relPath)
  if (safe.includes('/')) throw new Error('目前只支持重命名项目根下的一级节点')
  const from = path.join(dir, safe)
  if (!(await pathExists(from))) throw new Error(`不存在：${safe}`)
  const name = assertSafeFileName(newName)
  if (name === safe) return { from: safe, to: name }
  const to = path.join(dir, name)
  if (await pathExists(to)) throw new Error(`已存在：${name}`)
  await renameWithRetry(from, to)
  return { from: safe, to: name }
}

export async function deleteEntry(root, title, relPath) {
  const dir = projectDir(root, title)
  if (!(await isDirectory(dir))) throw new Error(`短剧《${assertSafeTitle(title)}》不存在`)
  const safe = assertSafeRelPath(relPath)
  if (safe.includes('/')) throw new Error('目前只支持删除项目根下的一级节点')
  const target = path.join(dir, safe)
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
  const errors = assetCards.validateAssetCard(card, { existingCards: existing })
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
  await atomicWrite(assetCardsFile(dir), `${JSON.stringify(assetCards.buildAssetIndex(nextCards), null, 2)}\n`)
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
  await atomicWrite(scenesFile(dir), `${JSON.stringify(scenes.buildSceneIndex(nextScenes), null, 2)}\n`)
  return card
}

/* ------------------------------------- 五维风格 DNA（v0.11.1 / 2-2 一期，add-only） */

/** 风格 DNA 权威存储：`.aidrama/style.json`（剧集级、单文件、无时间戳）。 */
export const STYLE_DNA_RELATIVE = 'style.json'

function styleDnaFile(dir) {
  return path.join(metaDir(dir), 'style.json')
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
  const doc = styleDna.buildStyleDoc(dna)
  await atomicWrite(styleDnaFile(dir), `${JSON.stringify(doc, null, 2)}\n`)
  return doc.style
}
