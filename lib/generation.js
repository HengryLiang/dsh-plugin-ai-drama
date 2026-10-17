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

/** 提交前的预算闸门：超上限直接拦（FR-G06）。 */
export async function checkBudget(root, title, estimatePoints) {
  const budget = await getBudget(root, title)
  const points = Number(estimatePoints) || 0
  if (budget.limitPoints == null) return { ok: true, limited: false, budget, wouldSpend: points }
  const projected = budget.spentPoints + points
  if (projected > budget.limitPoints) {
    return {
      ok: false,
      limited: true,
      reason: 'over-budget',
      detail: `本次预计消耗 ${points} 积分，已消耗 ${budget.spentPoints}，预算上限 ${budget.limitPoints}，超出 ${projected - budget.limitPoints}`,
      budget,
      wouldSpend: points,
    }
  }
  return { ok: true, limited: true, budget, wouldSpend: points, remainingAfter: budget.limitPoints - projected }
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
