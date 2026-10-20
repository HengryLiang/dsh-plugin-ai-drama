/**
 * 阶段二 · 生成任务台账、成本护栏与产物回流
 *
 * FR-G05 产物回流：生成物从远端 URL 下载或从本地拷入 `<项目>/素材/生成/`，
 *   **生成物是本项目自己的产出，要留在项目里**（断网后仍可用）；
 *   这与 FR-B08「外部引用素材只记路径、不复制大文件」是两回事，二者在素材库中以 origin 区分。
 * FR-G06 成本护栏：单次预估 + 项目预算上限 + 消耗台账，超预算直接拦截。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

import * as store from './store.js'

const GEN_DIR = '生成'
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 300_000
const MAX_TASKS = 1000
const TASK_STATUSES = ['planned', 'submitted', 'running', 'done', 'failed', 'cancelled']

/* --------------------------- P2-5 剩余（v0.6.7）：失败分类 / 退避重试 / operationId 幂等 */

/** 可重试错误特征：网络/超时/限流/服务 5xx（临时性故障）。 */
const RETRYABLE_MESSAGE_PATTERNS = [
  /econnreset|econnrefused|etimedout|enotfound|eai_again|epipe|socket hang up|fetch failed|network|connection/i,
  /timeout|timed out|超时|网络|连接|断线/i,
  /too many requests|rate limit|rate_limit|限流/i,
  /(^|\D)(429|500|502|503|504)(\D|$)/,
  /temporarily unavailable|service unavailable|bad gateway|gateway timeout|upstream (error|unavailable)|服务器(错误|不可用)|服务(暂不可用|不可用|异常)/i,
]
/** 不可重试错误特征：参数/预算/权限/资源不存在/4xx（重试只会重复失败）。 */
const FATAL_MESSAGE_PATTERNS = [
  /invalid|参数|校验|格式错误|不支持|unsupported|not implemented|权限|无权限|forbidden|unauthorized|认证|token 无效/i,
  /预算|budget|超过上限|超限|额度不足/i,
  /not found|模型不存在|资源不存在|(^|\D)(400|401|403|404|405|422)(\D|$)/,
  /approval|审批|被拒绝|denied/i,
]

/**
 * 分类一次生成失败（v0.6.7 ①）。
 * 未知错误按**不可重试**处理（保守；默认 maxAttempts=1 时行为与 v0.6.6 完全一致）。
 * @returns {{retryable:boolean, kind:'retryable'|'fatal', reason:string, status:number|null}}
 */
export function classifyGenerationError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const rawStatus = error && (error.status != null ? error.status : error.statusCode != null ? error.statusCode : error.httpStatus)
  const status = Number.isFinite(Number(rawStatus)) ? Number(rawStatus) : null
  if (status != null) {
    if (status === 429 || status >= 500) return { retryable: true, kind: 'retryable', reason: `http-${status}`, status }
    if (status >= 400) return { retryable: false, kind: 'fatal', reason: `http-${status}`, status }
  }
  for (const pattern of FATAL_MESSAGE_PATTERNS) {
    if (pattern.test(message)) return { retryable: false, kind: 'fatal', reason: 'fatal-error', status }
  }
  for (const pattern of RETRYABLE_MESSAGE_PATTERNS) {
    if (pattern.test(message)) return { retryable: true, kind: 'retryable', reason: 'transient-error', status }
  }
  return { retryable: false, kind: 'fatal', reason: 'unknown-error', status }
}

export const DEFAULT_GENERATION_RETRY = { maxAttempts: 1, baseDelayMs: 200, maxDelayMs: 2000 }

/** 读取可选重试配置（settings.generationRetry）；未配置 → maxAttempts=1（不重试，行为不变）。 */
export async function getGenerationRetry(root) {
  let raw = null
  try {
    raw = (await store.getSettings(root)).generationRetry
  } catch {
    raw = null
  }
  const config = { ...DEFAULT_GENERATION_RETRY }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const attempts = Number(raw.maxAttempts)
    if (Number.isFinite(attempts) && attempts >= 1 && attempts <= 5) config.maxAttempts = Math.floor(attempts)
    const base = Number(raw.baseDelayMs)
    if (Number.isFinite(base) && base >= 0 && base <= 10_000) config.baseDelayMs = Math.floor(base)
    const max = Number(raw.maxDelayMs)
    if (Number.isFinite(max) && max >= 0 && max <= 30_000) config.maxDelayMs = Math.max(config.baseDelayMs, Math.floor(max))
  }
  return config
}

function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 指数退避间隔（封顶 maxDelayMs）。 */
export function retryDelayMs(attempt, config = DEFAULT_GENERATION_RETRY) {
  const base = Math.max(0, Number(config.baseDelayMs) || 0)
  const max = Math.max(base, Number(config.maxDelayMs) || base)
  return Math.min(max, base * 2 ** Math.max(0, attempt - 1))
}

/** 供编排层使用：分类 + 退避等待（attempt 从 1 开始）。 */
export async function waitBeforeRetry(attempt, config) {
  await sleep(retryDelayMs(attempt, config))
}

/* ---------------------------------------------------------------- 工具 */

function readJson(file, fallback) {
  return fs.readFile(file, 'utf8').then(
    (text) => JSON.parse(text),
    () => fallback,
  )
}

async function writeJson(file, value) {
  await store.atomicWrite(file, JSON.stringify(value, null, 2) + '\n')
}

function meta(root, title) {
  const dir = store.projectDir(root, title)
  return { dir, file: (name) => path.join(dir, '.aidrama', name) }
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function safeSegment(name) {
  return String(name || 'artifact')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 100)
}

/* ------------------------------------------------------------ 任务台账 */

export async function listTasks(root, title, options = {}) {
  const { file } = meta(root, title)
  const tasks = await readJson(file('tasks.json'), [])
  const filtered = options.status ? tasks.filter((t) => t.status === options.status) : tasks
  return filtered.slice(-Number(options.limit || 200)).reverse()
}

export async function createTask(root, title, input) {
  const { dir, file } = meta(root, title)
  if (!(await store.isDirectory(dir))) throw new Error(`短剧《${title}》不存在`)
  const tasks = await readJson(file('tasks.json'), [])
  // v0.6.7 幂等：提供 operationId 时，同 operationId 已有任务 → 复用（不重复登记/生成）；省略=旧行为。
  const operationId = input.operationId ? String(input.operationId).trim().slice(0, 160) : ''
  if (operationId) {
    const existing = tasks.find((t) => t.operationId === operationId)
    if (existing) return { ...existing, idempotent: true }
  }
  if (tasks.length >= MAX_TASKS) tasks.splice(0, tasks.length - MAX_TASKS + 1)

  const kind = String(input.kind || '')
  if (!['image', 'video', 'audio'].includes(kind)) throw new Error('kind 只能是 image / video / audio')
  const backend = String(input.backend || '').trim()
  if (!backend) throw new Error('缺少 backend')

  const task = {
    id: newId('t'),
    backend,
    kind,
    episode: input.episode == null ? null : Number(input.episode),
    shots: Array.isArray(input.shots) ? input.shots.map((s) => String(s).slice(0, 40)).slice(0, 200) : [],
    model: String(input.model || '').slice(0, 80),
    prompt: String(input.prompt || '').slice(0, 2000),
    estimatePoints: Number.isFinite(Number(input.estimatePoints)) ? Number(input.estimatePoints) : null,
    actualPoints: null,
    externalId: input.externalId ? String(input.externalId).slice(0, 120) : null,
    status: 'planned',
    artifacts: [],
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  // 只在显式提供时落 operationId，保持默认 task 形状与 v0.6.6 一致。
  if (operationId) task.operationId = operationId
  tasks.push(task)
  await writeJson(file('tasks.json'), tasks)
  return task
}

export async function updateTask(root, title, id, patch = {}) {
  const { file } = meta(root, title)
  const tasks = await readJson(file('tasks.json'), [])
  const index = tasks.findIndex((t) => t.id === id)
  if (index < 0) throw new Error(`任务不存在：${id}`)
  const task = tasks[index]

  if (patch.status != null) {
    if (!TASK_STATUSES.includes(patch.status)) throw new Error(`未知任务状态：${patch.status}`)
    task.status = patch.status
  }
  if (patch.actualPoints != null) {
    const points = Number(patch.actualPoints)
    if (!Number.isFinite(points) || points < 0) throw new Error('actualPoints 必须是非负数')
    task.actualPoints = Math.round(points)
  }
  if (patch.externalId != null) task.externalId = String(patch.externalId).slice(0, 120)
  if (patch.error != null) task.error = String(patch.error).slice(0, 1000)
  task.updatedAt = new Date().toISOString()
  tasks[index] = task
  await writeJson(file('tasks.json'), tasks)

  // 任务结算时把消耗记进台账（FR-G06）
  if (patch.actualPoints != null || patch.status === 'done' || patch.status === 'failed') {
    await recordSpend(root, title, task)
  }
  return task
}

/* ------------------------------------------------------------ 预算台账 */

function emptyBudget() {
  return { limitPoints: null, spentPoints: 0, entries: [], updatedAt: null }
}

export async function getBudget(root, title) {
  const { file } = meta(root, title)
  const budget = await readJson(file('budget.json'), emptyBudget())
  return {
    ...budget,
    remainingPoints: budget.limitPoints == null ? null : Math.max(0, budget.limitPoints - budget.spentPoints),
  }
}

export async function setBudgetLimit(root, title, limitPoints) {
  const { file } = meta(root, title)
  const budget = await readJson(file('budget.json'), emptyBudget())
  if (limitPoints == null || limitPoints === '') {
    budget.limitPoints = null
  } else {
    const value = Number(limitPoints)
    if (!Number.isFinite(value) || value < 0) throw new Error('预算上限必须是非负数')
    budget.limitPoints = Math.round(value)
  }
  budget.updatedAt = new Date().toISOString()
  await writeJson(file('budget.json'), budget)
  await renderBudget(root, title, budget)
  return getBudget(root, title)
}

/** 记一笔消耗；同一 taskId 只记一次，避免重复结算。 */
async function recordSpend(root, title, task) {
  const { file } = meta(root, title)
  const budget = await readJson(file('budget.json'), emptyBudget())
  const points = Number(task.actualPoints ?? task.estimatePoints ?? 0)
  if (!points) return budget
  if (budget.entries.some((e) => e.taskId === task.id)) return budget

  budget.entries.push({
    taskId: task.id,
    backend: task.backend,
    kind: task.kind,
    model: task.model,
    episode: task.episode,
    points: Math.round(points),
    estimated: task.actualPoints == null,
    at: new Date().toISOString(),
  })
  budget.spentPoints += Math.round(points)
  budget.updatedAt = new Date().toISOString()
  await writeJson(file('budget.json'), budget)
  await renderBudget(root, title, budget)
  return budget
}

/**
 * 提交前的预算闸门：超上限直接拦（FR-G06）。
 *
 * v0.6.6 / P2-5：扩展为**三级闸门**（单次 perTask / 单集 perEpisode / 项目 project），
 * 默认未配置任何新上限时，返回结构与 v0.6.5 完全一致（`ok/limited/reason/detail/budget/wouldSpend`）。
 * 新上限来自 settings.generationLimits（可选，缺省 null=不限制）：
 *   { perTaskPoints?: number|null, perEpisodePoints?: number|null, perProjectPoints?: number|null }
 * 项目级优先沿用既有 budget.json 的 limitPoints；未设置时可用 perProjectPoints 覆盖。
 *
 * @param {string} root
 * @param {string} title
 * @param {number} estimatePoints 本次预计消耗（积分）
 * @param {{episode?:number, perUnitPoints?:number, kind?:string}} [options]
 */
export async function checkBudget(root, title, estimatePoints, options = {}) {
  const points = Number(estimatePoints) || 0
  const budget = await getBudget(root, title)
  const limits = await getGenerationLimits(root)
  const projectLimit = budget.limitPoints != null ? budget.limitPoints : limits.perProjectPoints
  const episodeNumber = options.episode == null ? null : Number(options.episode)
  const perUnit = Number(options.perUnitPoints)
  const taskLimit = limits.perTaskPoints
  const episodeLimit = limits.perEpisodePoints

  const levels = {
    task: { limit: taskLimit, planned: Number.isFinite(perUnit) ? perUnit : null, ok: true },
    episode: { limit: episodeLimit, episode: Number.isFinite(episodeNumber) ? episodeNumber : null, spent: null, planned: points, ok: true },
    project: { limit: projectLimit, spent: budget.spentPoints, planned: points, ok: true },
  }
  const violations = []

  // ① 单次闸门：单件预估超过单次上限即拒绝
  if (taskLimit != null && Number.isFinite(perUnit) && perUnit > taskLimit) {
    levels.task.ok = false
    violations.push({
      level: 'task',
      reason: 'over-task-budget',
      detail: `单次预计消耗 ${perUnit} 积分，超过单次上限 ${taskLimit}`,
    })
  }

  // ② 单集闸门：本集已消耗 + 本次预估
  if (episodeLimit != null && Number.isFinite(episodeNumber)) {
    const spentEpisode = budget.entries.filter((e) => Number(e.episode) === episodeNumber).reduce((sum, e) => sum + (Number(e.points) || 0), 0)
    const projectedEpisode = spentEpisode + points
    levels.episode.spent = spentEpisode
    levels.episode.projected = projectedEpisode
    if (projectedEpisode > episodeLimit) {
      levels.episode.ok = false
      violations.push({
        level: 'episode',
        reason: 'over-episode-budget',
        detail: `第 ${episodeNumber} 集已消耗 ${spentEpisode} 积分，本次预计 ${points}，单集上限 ${episodeLimit}，超出 ${projectedEpisode - episodeLimit}`,
      })
    }
  }

  // ③ 项目闸门（沿用 v0.6.5 语义与文案）
  if (projectLimit != null) {
    const projected = budget.spentPoints + points
    levels.project.projected = projected
    if (projected > projectLimit) {
      levels.project.ok = false
      violations.push({
        level: 'project',
        reason: 'over-budget',
        detail: `本次预计消耗 ${points} 积分，已消耗 ${budget.spentPoints}，预算上限 ${projectLimit}，超出 ${projected - projectLimit}`,
      })
    }
  }

  const limited = projectLimit != null || taskLimit != null || episodeLimit != null
  const projectedProject = budget.spentPoints + points
  const result = {
    ok: violations.length === 0,
    limited,
    budget,
    wouldSpend: points,
    levels,
  }
  if (violations.length) {
    result.reason = violations[0].reason
    result.detail = violations.map((v) => v.detail).join('；')
    result.violations = violations
  } else {
    result.reason = null
    result.detail = null
    if (projectLimit != null) result.remainingAfter = projectLimit - projectedProject
  }
  return result
}

/* ---------------------------------------- P2-5（v0.6.6）成本预估 + 三级预算闸门 */

/** 各生成类型的默认单件积分区间（仅在「调用方未给预估 + 台账无历史」时兜底，纯启发式）。 */
const DEFAULT_POINT_RANGES = { image: [1, 3], video: [5, 15], audio: [1, 3] }
/** 各生成类型的 token 预估系数（按提示词字符数启发式估算，明确标注 source='heuristic'）。 */
const TOKEN_ESTIMATE_COEFFS = { image: { base: 240, perChar: 1.0 }, video: { base: 640, perChar: 2.0 }, audio: { base: 160, perChar: 0.8 } }
const GENERATION_LIMIT_KEYS = ['perTaskPoints', 'perEpisodePoints', 'perProjectPoints']

/** 读取可选的三级生成预算上限（settings.generationLimits）；未配置/非法值 → null（不限制）。 */
export async function getGenerationLimits(root) {
  let raw = null
  try {
    raw = (await store.getSettings(root)).generationLimits
  } catch {
    raw = null
  }
  const limits = { perTaskPoints: null, perEpisodePoints: null, perProjectPoints: null }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of GENERATION_LIMIT_KEYS) {
      const value = Number(raw[key])
      if (Number.isFinite(value) && value >= 0) limits[key] = Math.round(value)
    }
  }
  return limits
}

/**
 * 生成前成本预估（P2-5 ①）：复用预算台账历史，给出预计 tokens / 积分区间，并附带三级预算闸门结果。
 * - 积分区间来源优先级：调用方 estimatePerUnitPoints → 台账同类历史均值±20% → 类型默认区间；
 * - tokens 为启发式区间（按提示词字符数），明确标注 source；
 * - 默认未配置任何上限时 gate.ok=true/limited=false，不改变 v0.6.5 行为。
 *
 * @param {{kind?:string, unitCount?:number, prompts?:string[], promptChars?:number, estimatePerUnitPoints?:number, episode?:number, backend?:string, model?:string}} [options]
 */
export async function estimateGenerationCost(root, title, options = {}) {
  const kind = ['image', 'video', 'audio'].includes(options.kind) ? options.kind : 'image'
  const prompts = Array.isArray(options.prompts) ? options.prompts.map((p) => String(p)) : []
  const unitCount = Math.max(0, Math.round(Number(options.unitCount != null ? options.unitCount : prompts.length || 0)))
  const promptChars = prompts.length
    ? Math.round(prompts.reduce((sum, p) => sum + p.length, 0) / prompts.length)
    : Math.max(0, Math.round(Number(options.promptChars) || 0))
  const budget = await getBudget(root, title)

  let source
  let unitMin
  let unitMax
  const explicit = Number(options.estimatePerUnitPoints)
  if (Number.isFinite(explicit) && explicit >= 0) {
    source = 'caller'
    unitMin = explicit
    unitMax = explicit
  } else {
    const history = budget.entries.filter((e) => e.kind === kind && Number(e.points) > 0)
    if (history.length) {
      const average = history.reduce((sum, e) => sum + Number(e.points), 0) / history.length
      unitMin = Math.max(1, Math.round(average * 0.8))
      unitMax = Math.max(unitMin, Math.round(average * 1.2))
      source = 'ledger'
    } else {
      const [lo, hi] = DEFAULT_POINT_RANGES[kind]
      unitMin = lo
      unitMax = hi
      source = 'default'
    }
  }

  const coefficient = TOKEN_ESTIMATE_COEFFS[kind]
  const promptBaseline = Math.max(promptChars, 20)
  const perUnitTokens = Math.max(1, Math.round(coefficient.base + coefficient.perChar * promptBaseline))
  const points = {
    unitMin: Math.round(unitMin),
    unitMax: Math.round(unitMax),
    totalMin: Math.round(unitMin * unitCount),
    totalMax: Math.round(unitMax * unitCount),
    source,
  }
  const tokens = {
    perUnit: perUnitTokens,
    totalMin: perUnitTokens * unitCount,
    totalMax: Math.round(perUnitTokens * 1.4) * unitCount,
    source: 'heuristic',
  }

  const gate = await checkBudget(root, title, points.totalMax, {
    episode: options.episode,
    perUnitPoints: unitMax,
    kind,
  })
  return {
    kind,
    backend: options.backend ? String(options.backend) : null,
    model: options.model ? String(options.model) : null,
    units: unitCount,
    promptChars,
    points,
    tokens,
    gate: {
      ok: gate.ok,
      limited: gate.limited,
      reason: gate.reason || null,
      detail: gate.detail || null,
      levels: gate.levels,
      wouldSpend: gate.wouldSpend,
      remainingAfter: gate.remainingAfter ?? null,
    },
    estimatedAt: new Date().toISOString(),
  }
}

async function renderBudget(root, title, budget) {
  const { dir } = meta(root, title)
  const remaining = budget.limitPoints == null ? '未设上限' : String(Math.max(0, budget.limitPoints - budget.spentPoints))
  const md = [
    `# ${title} · 消耗台账`,
    '',
    '> 由「AI 短剧」工作区记录（FR-G06）。积分以平台结算为准，预估记 `estimated: true`。',
    '',
    `- 预算上限：${budget.limitPoints == null ? '未设置' : budget.limitPoints + ' 积分'}`,
    `- 已消耗：${budget.spentPoints} 积分`,
    `- 剩余：${remaining}`,
    '',
    '| 时间 | 后端 | 类型 | 模型 | 集数 | 积分 | 来源 | 任务 |',
    '|---|---|---|---|---|---|---|---|',
    ...budget.entries.map(
      (e) =>
        `| ${e.at} | ${e.backend} | ${e.kind} | ${e.model || '—'} | ${e.episode ?? '—'} | ${e.points} | ${e.estimated ? '预估' : '实际'} | ${e.taskId} |`,
    ),
    '',
    `> 共 ${budget.entries.length} 笔`,
    '',
  ].join('\n')
  await store.atomicWrite(path.join(dir, '账本', '消耗台账.md'), md)
}

/* ------------------------------------------------------------ 产物回流 */

async function downloadTo(url, target) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared && declared > MAX_DOWNLOAD_BYTES) {
      throw new Error(`产物过大（${(declared / 1024 / 1024).toFixed(1)} MB），超过 ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB 上限`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('产物过大，已中止')
    await store.atomicWrite(target, buffer)
    return buffer.length
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把一份生成产物收进项目（FR-G05）。
 * 入参二选一：`url`（远端，下载）或 `file`（本地，拷入）。
 */
export async function intakeArtifact(root, title, input = {}) {
  const { dir, file } = meta(root, title)
  if (!(await store.isDirectory(dir))) throw new Error(`短剧《${title}》不存在`)

  const url = input.url ? String(input.url).trim() : ''
  const localFile = input.file ? String(input.file).trim() : ''
  if (!url && !localFile) throw new Error('需要提供 url 或 file')

  const rawName = input.name || (url ? path.basename(new URL(url).pathname) : path.basename(localFile)) || 'artifact'
  const ext = path.extname(rawName) || (input.kind === 'video' ? '.mp4' : input.kind === 'audio' ? '.mp3' : '.png')
  const base = safeSegment(path.basename(rawName, path.extname(rawName))) || 'artifact'
  const targetDir = path.join(dir, '素材', GEN_DIR)
  await fs.mkdir(targetDir, { recursive: true })

  // 同名自动加序号，不覆盖已有产物
  let fileName = base + ext
  let target = path.join(targetDir, fileName)
  let n = 1
  while (await fs.stat(target).then(() => true, () => false)) {
    fileName = `${base}-${n}${ext}`
    target = path.join(targetDir, fileName)
    n += 1
    if (n > 500) throw new Error('同名产物过多，请指定 name')
  }

  let bytes
  if (url) {
    bytes = await downloadTo(url, target)
  } else {
    const stat = await fs.stat(localFile).catch(() => null)
    if (!stat || !stat.isFile()) throw new Error(`找不到本地文件：${localFile}`)
    if (stat.size > MAX_DOWNLOAD_BYTES) throw new Error('产物过大，超过上限')
    const buffer = await fs.readFile(localFile)
    await store.atomicWrite(target, buffer)
    bytes = buffer.length
  }

  const sha256 = createHash('sha256').update(await fs.readFile(target)).digest('hex')
  const asset = await store.addAsset(root, title, {
    source: target,
    name: input.name || fileName,
    kind: input.kind || undefined,
    note: input.note || `生成产物（${input.backend || 'unknown'}${input.model ? ' · ' + input.model : ''}）`,
    linkedShots: input.shots || [],
  })

  // 记录产地（addAsset 只记路径与校验，这里补充生成溯源）
  const assets = await store.getAssets(root, title)
  const index = assets.findIndex((a) => a.id === asset.id)
  if (index >= 0) {
    assets[index] = {
      ...assets[index],
      origin: 'generated',
      backend: input.backend || null,
      model: input.model || null,
      sourceUrl: url || null,
      taskId: input.taskId || null,
      episode: input.episode == null ? null : Number(input.episode),
      bytes,
      sha256,
      downloadedAt: new Date().toISOString(),
    }
    const { file: metaFile } = meta(root, title)
    await writeJson(metaFile('assets.json'), assets)
  }

  if (input.taskId) {
    const tasks = await readJson(file('tasks.json'), [])
    const t = tasks.find((x) => x.id === input.taskId)
    if (t) {
      t.artifacts = [...(t.artifacts || []), { name: fileName, path: path.relative(dir, target), bytes, sha256, at: new Date().toISOString() }]
      t.updatedAt = new Date().toISOString()
      await writeJson(file('tasks.json'), tasks)
    }
  }

  return { asset, file: fileName, relative: path.relative(root, target), bytes, sha256 }
}

/* --------------------------------- P2-7（v0.7.1）多集批量：批次目录/溯源/草稿暂存与采纳 */

const BATCHES_SUBDIR = 'batches'

/** 批次 id：ASCII 安全，防路径注入。 */
export function assertSafeBatchId(batchId) {
  if (typeof batchId !== 'string' || !/^b-[a-z0-9][a-z0-9._-]{0,80}$/i.test(batchId)) {
    throw new Error('批量批次 id 不合法（需形如 b-xxxx，仅字母数字 . _ -）')
  }
  return batchId
}

export function newBatchId() {
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 批次路径：`.aidrama/batches/<batchId>/`（trace.json + staging/ 草稿暂存区，不随导出）。 */
export function batchPaths(root, title, batchId) {
  const id = assertSafeBatchId(batchId)
  const dir = path.join(store.projectDir(root, title), '.aidrama', BATCHES_SUBDIR, id)
  return { id, dir, traceFile: path.join(dir, 'trace.json'), stagingDir: path.join(dir, 'staging') }
}

/** 持久化批次溯源（逐集每步记录；原子写，可随时读取审计）。 */
export async function saveBatchTrace(root, title, trace) {
  const { id, traceFile } = batchPaths(root, title, trace.batchId)
  const next = { ...trace, batchId: id, updatedAt: new Date().toISOString() }
  await store.atomicWrite(traceFile, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

export async function getBatchTrace(root, title, batchId) {
  const { traceFile } = batchPaths(root, title, batchId)
  try {
    return JSON.parse(await fs.readFile(traceFile, 'utf8'))
  } catch {
    throw new Error(`批量批次不存在：${batchId}`)
  }
}

export async function listBatchTraces(root, title, options = {}) {
  const base = path.join(store.projectDir(root, title), '.aidrama', BATCHES_SUBDIR)
  let names = []
  try {
    names = await fs.readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  const traces = []
  for (const entry of names) {
    if (!entry.isDirectory()) continue
    try {
      traces.push(JSON.parse(await fs.readFile(path.join(base, entry.name, 'trace.json'), 'utf8')))
    } catch {
      /* 跳过不完整批次 */
    }
  }
  traces.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  return traces.slice(0, Number(options.limit || 20))
}

/** 把后端下载的产物先移入批次草稿暂存区（不直接进 素材/生成；采纳后才入正式目录）。 */
export async function stageBatchArtifact(root, title, batchId, sourceFile, metaInfo = {}) {
  const { id, dir, stagingDir } = batchPaths(root, title, batchId)
  const source = String(sourceFile || '')
  const stat = await fs.stat(source).catch(() => null)
  if (!stat || !stat.isFile()) throw new Error(`找不到待暂存的生成产物：${source}`)
  const episode = Number(metaInfo.episode)
  const shot = safeSegment(String(metaInfo.shotNumber || (Array.isArray(metaInfo.shots) ? metaInfo.shots[0] : '') || 'x'))
  const ext = path.extname(source) || '.bin'
  const folder = Number.isFinite(episode) && episode > 0 ? `E${String(Math.round(episode)).padStart(3, '0')}` : 'misc'
  const fileName = `${shot}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}${ext}`
  const target = path.join(stagingDir, folder, fileName)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.copyFile(source, target)
  const bytes = (await fs.stat(target)).size
  const sha256 = createHash('sha256').update(await fs.readFile(target)).digest('hex')
  return {
    batchId: id,
    stagedRelative: path.relative(dir, target).split(path.sep).join('/'),
    absolute: target,
    bytes,
    sha256,
    name: fileName,
  }
}

/**
 * 采纳一份批次暂存产物：拷入 `素材/生成/` + addAsset + 回写任务 artifacts，并更新批次溯源。
 * 由 `draft-resolve`（kind=batch-artifact）在用户采纳草稿时调用。
 */
export async function adoptBatchArtifact(root, title, input = {}) {
  const { id, dir } = batchPaths(root, title, input.batchId)
  const stagedRelative = String(input.stagedRelative || '')
  if (!stagedRelative) throw new Error('缺少待采纳的草稿产物路径（stagedRelative）')
  const source = path.resolve(dir, stagedRelative)
  if (!source.startsWith(path.resolve(dir) + path.sep)) throw new Error('草稿产物路径越界')
  const stat = await fs.stat(source).catch(() => null)
  if (!stat || !stat.isFile()) throw new Error(`草稿产物不存在或已被采纳：${input.stagedRelative}`)
  const result = await intakeArtifact(root, title, {
    file: source,
    kind: input.kind,
    episode: input.episode,
    shots: input.shots || [],
    taskId: input.taskId,
    backend: input.backend,
    model: input.model,
    name: input.name || path.basename(source),
    note: input.note || `批量生成产物（${id}）`,
  })
  await fs.rm(source, { force: true })
  // 溯源标记：同一 stagedRelative 只标记一次；草稿 id 可选记录
  try {
    const trace = await getBatchTrace(root, title, id)
    const artifact = (trace.artifacts || []).find((item) => item.stagedRelative === stagedRelative)
    if (artifact) {
      artifact.adopted = true
      artifact.adoptedAt = new Date().toISOString()
      artifact.assetId = result.asset.id
      artifact.formalRelative = result.relative
      artifact.draftId = artifact.draftId || input.draftId || null
    }
    await saveBatchTrace(root, title, trace)
  } catch {
    /* 溯源更新失败不影响采纳本身 */
  }
  return { ...result, batchId: id, stagedRelative }
}
