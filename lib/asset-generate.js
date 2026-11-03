/**
 * RC-30 / v0.16.136（新 METHOD `asset-generate`，METHODS 78→79）：
 * 宿主直连画布后端（lib / libtv.js / neowow.js 子进程）为单个资产提交/查询/收取 1 张参考图。
 *
 * 契约要点：
 * - 不依赖会话 shell/PTY；用 host.backends registry 的 adapter；
 * - 仅写 `.aidrama/asset-generation.json` 与 `素材/短剧资产/<中文类型>/` 成品图；**不写 cards.json**（自动绑定由 client 用 artifact 调既有 H1/H3）；
 * - 资产卡必须存在、非 final、有主提示词；画布必须已绑定；
 * - collect 下载到 `素材/短剧资产/<中文类型>/<assetId>-<ts>.<ext>`（magic/大小/sha256 校验），并返回 artifact 供自动绑定；
 * - 失败/在途返回明确 status（pending/failed/error），不静默；任务可恢复（taskId）。
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import * as assetCards from './assets.js'
import * as assetGeneration from './asset-generation.js'
import * as guard from './guard.js'
import * as store from './store.js'
import * as txn from './txn.js'

export const ASSET_GENERATE_BACKENDS = Object.freeze(['libtv', 'neowow'])
export const ASSET_GENERATE_MAX_BYTES = 64 * 1024 * 1024
export const ASSET_GENERATE_ACTIONS = Object.freeze(['submit', 'status', 'collect'])
// RC-35 / v0.16.141：collect 直接落 `素材/短剧资产/<中文类型>/`；目录类型按用户口径（非资产标签文案）。
const ASSET_MEDIA_ROOT = '素材/短剧资产'
const ASSET_TYPE_DIRS = Object.freeze({
  CHR: '人物卡',
  SPC: '场景卡',
  PRP: '道具卡',
  SFX: '特效卡',
  VEH: '载具卡',
  CST: '服装卡',
})
const ASSET_TYPE_DIR_OTHER = '其他'
const IMAGE_EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

function assetTypeInfoOf(card, assetId) {
  const match = String(assetId || '').toUpperCase().match(/^([A-Z]+)/)
  const type = String((card && card.type) || (match ? match[1] : '') || 'OTHER').toUpperCase()
  return { type, dir: ASSET_TYPE_DIRS[type] || ASSET_TYPE_DIR_OTHER }
}

/** v0.16.194（P0-②）：submit 目标状态解析；未传→default（不读 active），非法/不存在→invalid-args。 */
function resolveSubmitStateTarget(card, rawStateId) {
  if (rawStateId !== undefined && rawStateId !== null && typeof rawStateId !== 'string') {
    const error = new Error('stateId 必须是字符串')
    error.code = 'invalid-args'
    throw error
  }
  const media = assetCards.normalizeAssetMedia(card && card.media) || {}
  const states = Array.isArray(media.states) ? media.states : []
  const raw = rawStateId === undefined || rawStateId === null ? '' : String(rawStateId).trim()
  if (raw && !assetCards.normalizeMediaStateId(raw)) {
    const error = new Error('stateId 非法（1–40 位字母/数字/_/-）')
    error.code = 'invalid-args'
    throw error
  }
  if (!states.length) {
    if (raw && raw !== 'default') {
      const error = new Error(`该资产没有状态：${raw}（仅允许缺省/default）`)
      error.code = 'invalid-args'
      throw error
    }
    return { stateId: 'default', hasStates: false }
  }
  const requested = raw ? assetCards.normalizeMediaStateId(raw) : ''
  const defaultStateId = (typeof media.defaultStateId === 'string' && states.some((state) => state.id === media.defaultStateId))
    ? media.defaultStateId
    : (states.find((state) => state.id === 'default') || states.find((state) => state.name === '默认') || states[0]).id
  const target = requested ? states.find((state) => state.id === requested) : states.find((state) => state.id === defaultStateId)
  if (!target) {
    const error = new Error(requested ? `状态不存在：${requested}` : '资产默认状态不存在')
    error.code = 'invalid-args'
    throw error
  }
  return { stateId: target.id, hasStates: true }
}

async function findCardForTask(root, title, assetId) {
  const cards = await store.getAssetCards(root, title)
  return (Array.isArray(cards) ? cards : []).find((item) => String(item.id) === String(assetId)) || null
}

function artifactView(artifact, task, typeInfo) {
  if (!artifact || typeof artifact !== 'object') return artifact
  return {
    ...artifact,
    assetId: task.assetId,
    stateId: task.stateId || 'default',
    ...(task.stateId ? {} : { stateIdFromDefault: true }),
    assetType: typeInfo.type,
    assetTypeDir: typeInfo.dir,
    targetDir: `${ASSET_MEDIA_ROOT}/${typeInfo.dir}`,
  }
}

// RC-47：status 响应 add-only worker 视图（旧 sidecar 缺省推导，不写盘）。
function taskWorkerView(task) {
  const artifact = Array.isArray(task.artifacts) && task.artifacts.length ? task.artifacts[0] : null
  const autoBindStatus = task.autoBind && task.autoBind.status ? task.autoBind.status : ''
  let workerState = task.workerState || ''
  if (!workerState) {
    if (autoBindStatus === 'skipped-final' || task.reason === 'asset-locked') workerState = 'failed'
    else if (task.autoBound === true) workerState = 'bound'
    else if (task.status === 'submitted') workerState = 'pending'
    else if (task.status === 'pending') workerState = 'polling'
    else if (task.status === 'done') workerState = 'pending'
    else workerState = 'failed'
  }
  return {
    id: task.id,
    assetId: task.assetId,
    stateId: task.stateId || 'default',
    ...(task.stateId ? {} : { stateIdFromDefault: true }),
    nodeName: task.nodeName,
    status: task.status,
    workerState,
    autoBound: task.autoBound === true,
    ...(artifact ? { artifact } : {}),
    ...(task.reason ? { reason: task.reason } : {}),
    ...(task.error ? { error: task.error } : {}),
  }
}

function generationError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}


// RC-71：CHR 资产图比例硬约束（9:16 竖版）；参数名按后端可配置（LibTV CLI 用 -s k=v）。
export const ASSET_IMAGE_ASPECT_RATIO = '9:16'
export const ASSET_IMAGE_SIZE = '1024x1820'
export const ASSET_RATIO_DEVIATION_MAX = 0.05
// 按后端列出可用键；发送时按 ratio → aspect_ratio → size 优先取首个，并记录实际使用键。
export const ASSET_RATIO_PARAM_MAP = Object.freeze({
  libtv: Object.freeze({ ratio: ASSET_IMAGE_ASPECT_RATIO, aspect_ratio: ASSET_IMAGE_ASPECT_RATIO, size: ASSET_IMAGE_SIZE }),
  neowow: Object.freeze({ aspect_ratio: ASSET_IMAGE_ASPECT_RATIO, size: ASSET_IMAGE_SIZE }),
})
export const ASSET_RATIO_KEY_PRIORITY = Object.freeze(['ratio', 'aspect_ratio', 'size'])
export function assetRatioParamsFor(backendId) {
  const map = ASSET_RATIO_PARAM_MAP[backendId] || {}
  const key = ASSET_RATIO_KEY_PRIORITY.find((candidate) => map[candidate])
  return key ? { [key]: map[key] } : {}
}
export function backendSupportsRatioParams(backend) {
  if (!backend || typeof backend !== 'object') return false
  if (typeof backend.supportsRatioParams === 'boolean') return backend.supportsRatioParams
  if (backend.capabilities && typeof backend.capabilities.generateParams === 'boolean') return backend.capabilities.generateParams
  return typeof backend.generate === 'function'
}
export function hardenPromptForRatio(prompt) {
  const text = String(prompt == null ? '' : prompt).trimEnd()
  const suffix = ' [画幅硬约束] 整体画布 9:16 竖版：2 列 × 2 行，每格 9:16；禁止 16:9 / landscape / 横向四宫格 / 宽画布。'
  return text.includes('9:16') ? text : text + suffix
}
export function imageDimensionsOf(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null
  try {
    if (mime === 'image/png' || (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG')) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    if (mime === 'image/jpeg' || (buffer[0] === 0xff && buffer[1] === 0xd8)) {
      let index = 2
      while (index + 9 < buffer.length) {
        if (buffer[index] !== 0xff) { index += 1; continue }
        const marker = buffer[index + 1]
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { index += 2; continue }
        const length = buffer.readUInt16BE(index + 2)
        if (!length || index + 2 + length > buffer.length) break
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buffer.readUInt16BE(index + 7), height: buffer.readUInt16BE(index + 5) }
        }
        index += 2 + length
      }
      return null
    }
    if (mime === 'image/webp' || (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP')) {
      const chunk = buffer.toString('ascii', 12, 16)
      if (chunk === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
      if (chunk === 'VP8L') {
        const bits = buffer.readUInt32LE(21)
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
      }
      if (chunk === 'VP8 ') {
        return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
      }
    }
  } catch { /* 损坏图片按未知尺寸处理 */ }
  return null
}
export function checkChrAspectRatio(buffer, mime) {
  const size = imageDimensionsOf(buffer, mime)
  if (!size || !size.width || !size.height) return null
  const actual = size.width / size.height
  const target = 9 / 16
  const deviation = Math.abs(actual - target) / target
  return {
    width: size.width,
    height: size.height,
    aspectRatio: Number(actual.toFixed(4)),
    ratio: Number(actual.toFixed(4)),
    expectedAspectRatio: ASSET_IMAGE_ASPECT_RATIO,
    deviation: Number(deviation.toFixed(4)),
    ratioWarning: deviation > ASSET_RATIO_DEVIATION_MAX,
  }
}

function sniffImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return null
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return { mime: 'image/png', ext: '.png' }
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: '.webp' }
  }
  return null
}

function normalizeNodeName(raw, assetId) {
  const text = raw == null ? '' : String(raw).trim()
  if (!text) return `${assetId}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
  if (text.length > 120) throw generationError('invalid-args', 'nodeName 过长（上限 120 字符）')
  if (/[\u0000-\u001f\u007f/\\]/u.test(text)) throw generationError('invalid-args', 'nodeName 含控制字符或路径分隔符')
  return text
}

function normalizePrompt(raw, card) {
  const provided = raw != null
  const text = String(provided ? raw : (card && card.prompts ? card.prompts.PROMPT_MAIN : '') || '').trim()
  if (provided && typeof raw !== 'string') throw generationError('invalid-args', 'prompt 必须是字符串')
  if (!text) throw generationError('invalid-args', `资产卡缺少主提示词 PROMPT_MAIN；请先生成提示词或传 prompt（资产 ${card && card.id ? card.id : '—'}）`)
  if (text.length > 2000) throw generationError('invalid-args', 'prompt 过长（上限 2000 字）')
  return text
}

async function loadAssetCard(root, title, rawAssetId) {
  const assetId = assetCards.normalizeAssetId(rawAssetId)
  if (!assetId) throw generationError('invalid-args', 'assetId 必填')
  if (!assetCards.isValidAssetId(assetId)) throw generationError('invalid-args', `资产编号非法：${rawAssetId}`)
  const cards = await store.getAssetCards(root, title)
  const card = (Array.isArray(cards) ? cards : []).find((item) => String(item.id) === String(assetId)) || null
  if (!card) throw generationError('not-found', `资产卡不存在：${assetId}`)
  const review = assetCards.normalizeReview(card.review)
  if (review && review.status === 'final') {
    throw generationError('asset-locked', '资产已定稿锁定，需先重打开才能生成图片', { review, currentHash: null })
  }
  return { assetId, card }
}

async function resolveBackendForSubmit(root, registry, input) {
  if (!registry || typeof registry.get !== 'function') throw generationError('backend-unavailable', '后端注册表未就绪')
  const settings = await store.getSettings(root)
  const explicit = input && input.backend != null ? String(input.backend).trim() : ''
  let backendId = explicit || (settings && settings.canvasBackend ? String(settings.canvasBackend).trim() : '')
  if (backendId) {
    if (!ASSET_GENERATE_BACKENDS.includes(backendId)) throw generationError('invalid-args', `不支持的画布后端：${backendId}`)
    const backend = registry.get(backendId)
    if (!backend) throw generationError('backend-unavailable', `后端不可用：${backendId}`, { backend: backendId })
    return { backend, backendId }
  }
  let probe
  try {
    probe = await registry.probe({ toolNames: null })
  } catch (error) {
    throw generationError('backend-unavailable', `探测画布后端失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const active = probe && probe.activeBackend ? String(probe.activeBackend) : ''
  if (!active) throw generationError('backend-unavailable', '没有可用画布后端（LibTV 未登录 / NeoWoW 未登录）', { detail: probe && probe.note })
  const backend = registry.get(active)
  if (!backend) throw generationError('backend-unavailable', `后端不可用：${active}`, { backend: active })
  return { backend, backendId: active }
}

function resolveTaskBackend(registry, task) {
  if (!registry || typeof registry.get !== 'function') throw generationError('backend-unavailable', '后端注册表未就绪')
  const backend = registry.get(task.backend)
  if (!backend) throw generationError('backend-unavailable', `任务后端不可用：${task.backend}`, { backend: task.backend })
  return backend
}

async function assertCanvasBound(root, title, backendId) {
  const binding = await guard.checkBinding(root, title, backendId)
  if (!binding || binding.ok !== true) {
    throw generationError('canvas-unbound', `项目未绑定画布（${backendId}）；请先在生成页绑定画布`, {
      backend: backendId,
      reason: binding && binding.reason ? binding.reason : 'unbound',
      detail: binding && binding.detail ? binding.detail : '',
      fix: binding && binding.fix ? binding.fix : '',
    })
  }
  return binding
}

async function findTaskByInput(root, title, input) {
  const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : ''
  if (taskId) {
    const task = await assetGeneration.findGenerationTask(root, title, taskId)
    if (!task) throw generationError('not-found', `生成任务不存在：${taskId}`)
    return task
  }
  const nodeName = typeof input.nodeName === 'string' ? input.nodeName.trim() : ''
  if (nodeName) {
    const doc = await assetGeneration.readGenerationDoc(root, title)
    const task = doc.tasks.slice().reverse().find((item) => item.nodeName === nodeName) || null
    if (!task) throw generationError('not-found', `生成任务不存在（nodeName=${nodeName}）`)
    return task
  }
  // RC-32 / Q1（v0.16.138 add-only）：不带 taskId 时按 assetId 取 sidecar 中最新任务（createdAt 最新；同时间取后写入者）。
  const rawAssetId = input.assetId == null ? '' : String(input.assetId).trim()
  if (rawAssetId) {
    const assetId = assetCards.normalizeAssetId(rawAssetId)
    if (!assetId || !assetCards.isValidAssetId(assetId)) throw generationError('invalid-args', `资产编号非法：${rawAssetId}`)
    const doc = await assetGeneration.readGenerationDoc(root, title)
    const candidates = doc.tasks.filter((item) => String(item.assetId).toUpperCase() === assetId)
    if (!candidates.length) throw generationError('not-found', `资产 ${assetId} 尚无生成任务`)
    let latest = candidates[0]
    for (const task of candidates) {
      if (String(task.createdAt || '') >= String(latest.createdAt || '')) latest = task
    }
    return latest
  }
  throw generationError('invalid-args', 'status/collect 需要 taskId（或 assetId/nodeName）')
}

async function markTaskFailed(root, title, taskId, message, extra = {}) {
  try {
    return await txn.runProjectTxn(root, title, {
      action: 'asset-generate',
      actor: 'panel',
      targets: [assetGeneration.ASSET_GENERATION_PATH],
    }, async () => assetGeneration.updateGenerationTask(root, title, taskId, { status: 'failed', error: message, ...extra }))
  } catch {
    return null
  }
}

async function collectArtifact(root, title, task, backend, projectDir, card) {
  const typeInfo = assetTypeInfoOf(card, task.assetId)
  const targetDir = `${ASSET_MEDIA_ROOT}/${typeInfo.dir}`
  const outDir = path.join(projectDir, ...targetDir.split('/'))
  await store.guardedProjectMkdir(projectDir, targetDir)
  let download
  try {
    download = await backend.download({ node: task.nodeName, outDir, cwd: projectDir })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markTaskFailed(root, title, task.id, `下载失败：${message}`)
    return { ok: true, taskId: task.id, status: 'error', reason: `下载失败：${message}`, recoverable: true }
  }
  const files = Array.isArray(download && download.files) ? download.files : []
  let chosen = null
  for (const file of files) {
    if (typeof file !== 'string') continue
    const stat = await fs.stat(file).catch(() => null)
    if (!stat || !stat.isFile() || stat.size <= 0 || stat.size > ASSET_GENERATE_MAX_BYTES) continue
    const buffer = await fs.readFile(file).catch(() => null)
    if (!buffer) continue
    const sniffed = sniffImageMime(buffer)
    if (!sniffed) continue
    chosen = { file, buffer, sniffed, bytes: stat.size }
    break
  }
  if (!chosen) {
    const message = files.length ? '下载产物为空或不是支持的图片（png/jpg/webp）' : '后端未返回下载文件'
    await markTaskFailed(root, title, task.id, message)
    return { ok: true, taskId: task.id, status: 'error', reason: message, recoverable: true }
  }
  const sha256 = createHash('sha256').update(chosen.buffer).digest('hex')
  const ratioCheck = typeInfo.type === 'CHR' ? checkChrAspectRatio(chosen.buffer, chosen.sniffed.mime) : null
  const ratioActual = ratioCheck ? { width: ratioCheck.width, height: ratioCheck.height, ratio: ratioCheck.ratio, deviation: ratioCheck.deviation } : null
  const ratioRetryAttempt = Number.isInteger(task.ratioRetryAttempt) ? task.ratioRetryAttempt : 0
  const ratioParamSupported = task.ratioParamSupported === true
  const ratioParamsSent = task.ratioParamsSent && typeof task.ratioParamsSent === 'object' && !Array.isArray(task.ratioParamsSent) ? task.ratioParamsSent : {}
  const ratioFields = typeInfo.type === 'CHR' ? {
    ratioWarning: Boolean(ratioCheck && ratioCheck.ratioWarning),
    ratioActual,
    ...(ratioCheck ? {
      width: ratioCheck.width, height: ratioCheck.height, aspectRatio: ratioCheck.aspectRatio,
      expectedAspectRatio: ratioCheck.expectedAspectRatio, ratioDeviation: ratioCheck.deviation,
    } : {}),
    ratioRetryAttempt,
    ratioParamSupported,
    ratioParamsSent,
  } : {}
  const stamp = Date.now().toString(36)
  const targetRel = `${targetDir}/${task.assetId}-v${task.assetVersion}-${stamp}${chosen.sniffed.ext}`
  const targetAbs = path.join(projectDir, ...targetRel.split('/'))
  const chosenRel = path.relative(projectDir, chosen.file).split(path.sep).join('/')
  const chosenInside = chosenRel && !chosenRel.startsWith('..') && !path.isAbsolute(chosenRel)
  // RC-71：CHR 比例不符时自动重提一次（不新增 API；沿用 sidecar task 状态与现有轮询/取回链路）。
  if (ratioCheck && ratioCheck.ratioWarning && !(Number(task.ratioRetryAttempt) >= 1)) {
    const retryName = normalizeNodeName(undefined, task.assetId)
    try {
      await backend.generate({
        name: retryName, kind: 'image', prompt: task.prompt,
        model: task.model || undefined, cwd: projectDir,
        ...(task.ratioParamSupported === true ? { params: assetRatioParamsFor(task.backend) } : {}),
      })
      if (chosenInside) await store.guardedProjectRemove(projectDir, chosenRel).catch(() => null)
      await assetGeneration.updateGenerationTask(root, title, task.id, {
        status: 'submitted', nodeName: retryName, artifacts: [], error: null,
        ratioRetryAttempt: 1, ratioWarning: true, ratioActual,
        ratioParamSupported: task.ratioParamSupported === true, ratioParamsSent: task.ratioParamsSent || {},
      })
      return {
        ok: true, taskId: task.id, nodeName: retryName, backend: task.backend,
        status: 'pending', ratioWarning: true, ratioRetryScheduled: true,
        ratioActual, ratioParamSupported, ratioParamsSent,
        aspectRatio: ratioCheck.aspectRatio, expectedAspectRatio: ratioCheck.expectedAspectRatio,
      }
    } catch { /* 重提失败：保留本次结果并标 ratioWarning，客户端可手动重试 */ }
  }
  return await txn.runProjectTxn(root, title, {
    action: 'asset-generate',
    actor: 'panel',
    targets: [assetGeneration.ASSET_GENERATION_PATH, targetRel],
  }, async () => {
    let wroteTarget = false
    try {
      if (path.resolve(targetAbs) !== path.resolve(chosen.file)) {
        await store.guardedProjectWriteBinary(projectDir, targetRel, chosen.buffer)
        wroteTarget = true
      }
      const artifact = { relPath: targetRel, bytes: chosen.bytes, sha256, mime: chosen.sniffed.mime, ...ratioFields }
      const view = artifactView(artifact, task, typeInfo)
      const updated = await assetGeneration.updateGenerationTask(root, title, task.id, {
        status: 'done',
        artifacts: [...(Array.isArray(task.artifacts) ? task.artifacts : []), artifact],
        ...(typeInfo.type === 'CHR' ? { ratioWarning: Boolean(ratioCheck && ratioCheck.ratioWarning), ratioActual, ratioRetryAttempt: ratioCheck && ratioCheck.ratioWarning ? 1 : ratioRetryAttempt, ratioParamSupported, ratioParamsSent, ...(ratioCheck ? { imageWidth: ratioCheck.width, imageHeight: ratioCheck.height, aspectRatio: ratioCheck.aspectRatio } : {}) } : {}),
        error: null,
      })
      if (chosenInside && path.resolve(chosen.file) !== path.resolve(targetAbs)) {
        await store.guardedProjectRemove(projectDir, chosenRel).catch(() => null)
      }
      return {
        ok: true, taskId: task.id, nodeName: task.nodeName, backend: task.backend, status: 'done',
        candidate: view, artifact: view, task: updated,
        ...(typeInfo.type === 'CHR' ? { ratioWarning: Boolean(ratioCheck && ratioCheck.ratioWarning), ratioActual, ratioRetryAttempt: ratioCheck && ratioCheck.ratioWarning ? 1 : ratioRetryAttempt, ratioParamSupported, ratioParamsSent, ...(ratioCheck ? { aspectRatio: ratioCheck.aspectRatio, expectedAspectRatio: ratioCheck.expectedAspectRatio } : {}) } : {}),
        assetId: task.assetId, assetType: typeInfo.type, assetTypeDir: typeInfo.dir, targetDir,
      }
    } catch (error) {
      if (wroteTarget) await store.guardedProjectRemove(projectDir, targetRel).catch(() => null)
      throw error
    }
  })
}

/**
 * @param {{root:string, input:object, registry:object}} params
 */
export async function runAssetGenerate({ root, input = {}, registry } = {}) {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) throw generationError('invalid-args', 'title 必填')
  const action = input.action === undefined ? 'submit' : String(input.action).trim()
  if (!ASSET_GENERATE_ACTIONS.includes(action)) throw generationError('invalid-args', `action 非法：${action}（仅 submit/status/collect）`)
  let projectDir
  try {
    projectDir = store.projectDir(root, title)
  } catch {
    throw generationError('not-found', '短剧项目不存在')
  }
  if (!(await store.isDirectory(projectDir))) throw generationError('not-found', '短剧项目不存在')

  if (action === 'submit') {
    const { assetId, card } = await loadAssetCard(root, title, input.assetId)
    if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw generationError('invalid-args', 'expectedVersion 必须是正整数')
      if (Number(input.expectedVersion) !== card.version) {
        throw generationError('conflict', `资产版本不一致（期望 ${input.expectedVersion}，当前 ${card.version}）`, { currentVersion: card.version })
      }
    }
    const stateTarget = resolveSubmitStateTarget(card, input.stateId)
    const promptBase = normalizePrompt(input.prompt, card)
    const nodeName = normalizeNodeName(input.nodeName, assetId)
    const { backend, backendId } = await resolveBackendForSubmit(root, registry, input)
    await assertCanvasBound(root, title, backendId)
    const model = input.model == null ? null : String(input.model).trim().slice(0, 120)
    const typeInfo = assetTypeInfoOf(card, assetId)
    const ratioParamSupported = typeInfo.type === 'CHR' ? backendSupportsRatioParams(backend) : false
    const ratioParams = ratioParamSupported ? assetRatioParamsFor(backendId) : {}
    const prompt = typeInfo.type === 'CHR' && !ratioParamSupported ? hardenPromptForRatio(promptBase) : promptBase
    try {
      await backend.generate({ name: nodeName, kind: 'image', prompt, model: model || undefined, cwd: projectDir, ...(ratioParamSupported && Object.keys(ratioParams).length ? { params: ratioParams } : {}) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw generationError('upstream-unavailable', `画布提交失败：${message}`, { backend: backendId, nodeName })
    }
    const now = new Date().toISOString()
    const task = {
      id: assetGeneration.newGenerationTaskId(),
      assetId,
      assetVersion: card.version,
      stateId: stateTarget.stateId,
      backend: backendId,
      model: model || null,
      prompt,
      ...(typeInfo.type === 'CHR' ? { aspectRatio: ASSET_IMAGE_ASPECT_RATIO, ratioWarning: false, ratioParamSupported, ratioParamsSent: ratioParams, ratioRetryAttempt: 0 } : {}),
      nodeName,
      status: 'submitted',
      createdAt: now,
      updatedAt: now,
      artifacts: [],
      error: null,
    }
    await assetGeneration.addGenerationTask(root, title, task)
    return { ok: true, taskId: task.id, nodeName, backend: backendId, status: 'submitted', stateId: stateTarget.stateId, ...(typeInfo.type === 'CHR' ? { aspectRatio: ASSET_IMAGE_ASPECT_RATIO, ratioWarning: false, ratioParamSupported, ratioParamsSent: ratioParams, ratioRetryAttempt: 0 } : {}) }
  }

  const task = await findTaskByInput(root, title, input)
  const backend = resolveTaskBackend(registry, task)
  let detail
  try {
    detail = await backend.nodeDetail(task.nodeName, { cwd: projectDir })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: true, taskId: task.id, nodeName: task.nodeName, backend: task.backend, status: 'error', reason: message, recoverable: true }
  }
  const state = detail && typeof detail.state === 'string' ? detail.state : 'unknown'
  if (action === 'status') {
    return {
      ok: true,
      taskId: task.id,
      nodeName: task.nodeName,
      backend: task.backend,
      status: state,
      detail: { state, status: detail.status || null, urls: Array.isArray(detail.urls) ? detail.urls : [], message: detail.message || null },
      // RC-47 add-only：host 后台 worker 能力标记 + 任务 worker 视图（client 可只 loadAssets）。
      assetGenerateHostWorkerSupported: true,
      task: taskWorkerView(task),
    }
  }
  // collect
  if (state === 'failed') {
    const reason = detail.message || '画布节点失败'
    await markTaskFailed(root, title, task.id, reason)
    return { ok: true, taskId: task.id, nodeName: task.nodeName, backend: task.backend, status: 'failed', reason }
  }
  if (state !== 'done') {
    return { ok: true, taskId: task.id, nodeName: task.nodeName, backend: task.backend, status: state, detail: { state, status: detail.status || null, message: detail.message || null }, pending: true }
  }
  const card = await findCardForTask(root, title, task.assetId)
  const typeInfo = assetTypeInfoOf(card, task.assetId)
  const targetDir = `${ASSET_MEDIA_ROOT}/${typeInfo.dir}`
  if (task.status === 'done' && Array.isArray(task.artifacts) && task.artifacts.length) {
    const view = artifactView(task.artifacts[0], task, typeInfo)
    return {
      ok: true, taskId: task.id, nodeName: task.nodeName, backend: task.backend, status: 'done',
      candidate: view, artifact: view, reused: true,
      assetId: task.assetId, assetType: typeInfo.type, assetTypeDir: typeInfo.dir, targetDir,
    }
  }
  return collectArtifact(root, title, task, backend, projectDir, card)
}

