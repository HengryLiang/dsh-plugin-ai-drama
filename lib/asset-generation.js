/**
 * RC-30 / v0.16.136（add-only）：资产单图生成任务 sidecar。
 * - `.aidrama/asset-generation.json`：`{ schemaVersion:1, tasks:[...] }`；
 * - 仅服务面板直连生成（asset-generate）；不写 cards.json（绑定仍由 asset-save / media-upload 负责）；
 * - 旧项目无文件 → 空任务；写侧 guardedMetaWrite（原子写）；任务保留最近 MAX_TASKS 条。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import * as store from './store.js'

export const ASSET_GENERATION_RELATIVE = 'asset-generation.json'
export const ASSET_GENERATION_PATH = '.aidrama/asset-generation.json'
export const ASSET_GENERATION_SCHEMA_VERSION = 1
export const ASSET_GENERATION_MAX_TASKS = 200
export const ASSET_GENERATION_STATUSES = Object.freeze(['submitted', 'pending', 'done', 'failed', 'cancelled'])
// RC-47：后台 worker 状态（add-only；旧 sidecar 缺省由 status 响应推导）。
export const ASSET_GENERATION_WORKER_STATES = Object.freeze(['pending', 'polling', 'downloading', 'bound', 'failed', 'timeout'])
const ASSET_GENERATION_AUTO_BIND_STATUSES = Object.freeze(['pending', 'done', 'skipped-final', 'failed'])

function normalizeWorkerState(value) {
  return ASSET_GENERATION_WORKER_STATES.includes(value) ? value : null
}

function normalizeAutoBind(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const status = ASSET_GENERATION_AUTO_BIND_STATUSES.includes(value.status) ? value.status : null
  if (!status) return null
  return {
    status,
    at: typeof value.at === 'string' ? value.at.slice(0, 40) : '',
    ...(value.error == null ? {} : { error: String(value.error).slice(0, 500) }),
  }
}

function generationFile(root, title) {
  return path.join(store.projectDir(root, title), '.aidrama', ASSET_GENERATION_RELATIVE)
}

function normalizeTask(raw) {
  const task = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const status = ASSET_GENERATION_STATUSES.includes(task.status) ? task.status : 'submitted'
  const artifacts = Array.isArray(task.artifacts)
    ? task.artifacts.filter((item) => item && typeof item === 'object').map((item) => ({
      relPath: String(item.relPath == null ? '' : item.relPath).slice(0, 500),
      bytes: Number.isFinite(Number(item.bytes)) ? Number(item.bytes) : null,
      sha256: typeof item.sha256 === 'string' ? item.sha256.slice(0, 64) : null,
      mime: typeof item.mime === 'string' ? item.mime.slice(0, 80) : null,
      ...(Number.isFinite(Number(item.width)) && Number.isFinite(Number(item.height)) ? { width: Number(item.width), height: Number(item.height) } : {}),
      ...(typeof item.aspectRatio === 'number' ? { aspectRatio: item.aspectRatio } : {}),
      ...(typeof item.expectedAspectRatio === 'string' ? { expectedAspectRatio: item.expectedAspectRatio } : {}),
      ...(typeof item.ratioDeviation === 'number' ? { ratioDeviation: item.ratioDeviation } : {}),
      ...(typeof item.ratioWarning === 'boolean' ? { ratioWarning: item.ratioWarning } : {}),
      ...(item.ratioActual && typeof item.ratioActual === 'object' && !Array.isArray(item.ratioActual) ? { ratioActual: { width: Number(item.ratioActual.width) || 0, height: Number(item.ratioActual.height) || 0, ratio: Number(item.ratioActual.ratio) || 0, deviation: Number(item.ratioActual.deviation) || 0 } } : {}),
      ...(typeof item.ratioParamSupported === 'boolean' ? { ratioParamSupported: item.ratioParamSupported } : {}),
      ...(item.ratioParamsSent && typeof item.ratioParamsSent === 'object' && !Array.isArray(item.ratioParamsSent) ? { ratioParamsSent: item.ratioParamsSent } : {}),
    })).filter((item) => item.relPath)
    : []
  return {
    id: String(task.id == null ? '' : task.id).slice(0, 120),
    assetId: String(task.assetId == null ? '' : task.assetId).slice(0, 120),
    // v0.16.194（P0-②）：生成目标状态；旧任务无该字段时保持缺省（读取/绑定按 default）。
    ...(typeof task.stateId === 'string' && task.stateId.trim() ? { stateId: task.stateId.trim().slice(0, 40) } : {}),
    assetVersion: Number.isInteger(Number(task.assetVersion)) ? Number(task.assetVersion) : null,
    backend: String(task.backend == null ? '' : task.backend).slice(0, 20),
    model: task.model == null ? null : String(task.model).slice(0, 120),
    prompt: String(task.prompt == null ? '' : task.prompt).slice(0, 2000),
    nodeName: String(task.nodeName == null ? '' : task.nodeName).slice(0, 120),
    status,
    createdAt: typeof task.createdAt === 'string' ? task.createdAt.slice(0, 40) : '',
    updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt.slice(0, 40) : '',
    artifacts,
    error: task.error == null ? null : String(task.error).slice(0, 1000),
    ...(typeof task.aspectRatio === 'string' ? { aspectRatio: task.aspectRatio } : {}),
    ...(Number.isInteger(task.ratioRetryAttempt) ? { ratioRetryAttempt: task.ratioRetryAttempt } : {}),
    ...(typeof task.ratioWarning === 'boolean' ? { ratioWarning: task.ratioWarning } : {}),
    ...(task.ratioActual && typeof task.ratioActual === 'object' && !Array.isArray(task.ratioActual) ? { ratioActual: task.ratioActual } : {}),
    ...(typeof task.ratioParamSupported === 'boolean' ? { ratioParamSupported: task.ratioParamSupported } : {}),
    ...(task.ratioParamsSent && typeof task.ratioParamsSent === 'object' && !Array.isArray(task.ratioParamsSent) ? { ratioParamsSent: task.ratioParamsSent } : {}),
    ...(Number.isFinite(Number(task.imageWidth)) ? { imageWidth: Number(task.imageWidth) } : {}),
    ...(Number.isFinite(Number(task.imageHeight)) ? { imageHeight: Number(task.imageHeight) } : {}), 
    // RC-47 add-only：后台 worker 进度/自动绑定标记（旧数据缺省）。
    ...(normalizeWorkerState(task.workerState) ? { workerState: normalizeWorkerState(task.workerState) } : {}),
    autoBound: task.autoBound === true,
    ...(task.reason == null || task.reason === '' ? {} : { reason: String(task.reason).slice(0, 120) }),
    ...(normalizeAutoBind(task.autoBind) ? { autoBind: normalizeAutoBind(task.autoBind) } : {}),
  }
}

export async function readGenerationDoc(root, title) {
  const dir = store.projectDir(root, title)
  if (!(await store.isDirectory(dir))) {
    const error = new Error(`短剧《${String(title || '').trim()}》不存在`)
    error.code = 'not-found'
    throw error
  }
  const file = generationFile(root, title)
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { schemaVersion: ASSET_GENERATION_SCHEMA_VERSION, tasks: [] }
    throw error
  }
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    const invalid = new Error('生成任务文件损坏（不是合法 JSON）：.aidrama/asset-generation.json')
    invalid.code = 'invalid-args'
    throw invalid
  }
  const tasks = (doc && Array.isArray(doc.tasks) ? doc.tasks : []).map(normalizeTask).filter((task) => task.id).slice(-ASSET_GENERATION_MAX_TASKS)
  return { schemaVersion: ASSET_GENERATION_SCHEMA_VERSION, tasks }
}

export async function writeGenerationDoc(root, title, tasks) {
  const dir = store.projectDir(root, title)
  if (!(await store.isDirectory(dir))) {
    const error = new Error(`短剧《${String(title || '').trim()}》不存在`)
    error.code = 'not-found'
    throw error
  }
  const normalized = (Array.isArray(tasks) ? tasks : []).map(normalizeTask).filter((task) => task.id).slice(-ASSET_GENERATION_MAX_TASKS)
  const text = `${JSON.stringify({ schemaVersion: ASSET_GENERATION_SCHEMA_VERSION, tasks: normalized }, null, 2)}\n`
  await store.guardedMetaWrite(dir, ASSET_GENERATION_RELATIVE, text)
  return { schemaVersion: ASSET_GENERATION_SCHEMA_VERSION, tasks: normalized, text }
}

export function newGenerationTaskId() {
  return `ag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export async function addGenerationTask(root, title, task) {
  const doc = await readGenerationDoc(root, title)
  const next = [...doc.tasks, normalizeTask(task)].slice(-ASSET_GENERATION_MAX_TASKS)
  await writeGenerationDoc(root, title, next)
  return normalizeTask(task)
}

export async function findGenerationTask(root, title, id) {
  const doc = await readGenerationDoc(root, title)
  const normalizedId = String(id == null ? '' : id).trim()
  if (!normalizedId) return null
  return doc.tasks.find((task) => task.id === normalizedId) || null
}

export async function updateGenerationTask(root, title, id, patch = {}) {
  const doc = await readGenerationDoc(root, title)
  const normalizedId = String(id == null ? '' : id).trim()
  const index = doc.tasks.findIndex((task) => task.id === normalizedId)
  if (index < 0) {
    const error = new Error(`生成任务不存在：${normalizedId}`)
    error.code = 'not-found'
    throw error
  }
  const nextTask = normalizeTask({
    ...doc.tasks[index],
    ...patch,
    id: doc.tasks[index].id,
    createdAt: doc.tasks[index].createdAt,
    updatedAt: new Date().toISOString(),
  })
  const next = doc.tasks.slice()
  next[index] = nextTask
  await writeGenerationDoc(root, title, next)
  return nextTask
}
