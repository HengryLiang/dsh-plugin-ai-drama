/**
 * RC-47 / v0.16.168（add-only）：资产图生成后台调度器。
 *
 * 不依赖 client 面板存活；host 单 interval 轮询 sidecar 在途任务：
 *   submit/status 入队 → nodeDetail 轮询 → done 自动 collect 到 `素材/短剧资产/<类型卡>/`
 *   → sidecar done/artifacts + workerState/autoBound → 自动绑定 card.media（final 跳过；幂等）。
 * - 重启恢复：start() 立即扫描全部 workspace 的 sidecar；status/资产接口调用时 enqueueProject 再入队。
 * - 空转停摆：无任务时 tick 直接返回；有任务才扫描/轮询。
 * - dispose 由 index 调 stop() 清 interval；单任务异常捕获并标记 failed。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import * as assetCards from './assets.js'
import * as assetGeneration from './asset-generation.js'
import * as assetGenerate from './asset-generate.js'
import * as store from './store.js'

export const ASSET_SCHEDULER_INTERVAL_MS = 8000
export const ASSET_SCHEDULER_MAX_TASK_AGE_MS = 30 * 60 * 1000
export const ASSET_SCHEDULER_MAX_ERROR_ATTEMPTS = 3

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function ageOf(task, now) {
  const timestamp = Date.parse(task && task.createdAt ? task.createdAt : '')
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : 0
}

/**
 * @param {{getRoots:()=>Promise<string[]>|string[], registry:object, logger?:object,
 *   intervalMs?:number, maxTaskAgeMs?:number, now?:()=>number, setIntervalFn?:Function, clearIntervalFn?:Function}} options
 */
export function createAssetGenerationScheduler(options = {}) {
  const getRoots = typeof options.getRoots === 'function' ? options.getRoots : async () => []
  const registry = options.registry
  const logger = options.logger || {}
  const intervalMs = Number.isFinite(Number(options.intervalMs)) && Number(options.intervalMs) >= 1000
    ? Number(options.intervalMs) : ASSET_SCHEDULER_INTERVAL_MS
  const maxTaskAgeMs = Number.isFinite(Number(options.maxTaskAgeMs)) && Number(options.maxTaskAgeMs) > 0
    ? Number(options.maxTaskAgeMs) : ASSET_SCHEDULER_MAX_TASK_AGE_MS
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const setIntervalFn = typeof options.setIntervalFn === 'function' ? options.setIntervalFn : setInterval
  const clearIntervalFn = typeof options.clearIntervalFn === 'function' ? options.clearIntervalFn : clearInterval

  let timer = null
  let stopped = false
  let ticking = false
  let idle = true
  const queue = new Map()
  const errorAttempts = new Map()

  const log = (level, message) => {
    try { logger[level]?.(`[ai-drama][asset-scheduler] ${message}`) } catch { /* logger 失败不影响调度 */ }
  }

  const keyOf = (root, title, taskId) => `${root}\u0000${title}\u0000${taskId}`

  function enqueue(entry) {
    if (!entry || typeof entry.root !== 'string' || !entry.root || typeof entry.title !== 'string' || !entry.title) return false
    const taskId = String(entry.taskId == null ? '' : entry.taskId).trim()
    if (!taskId) return false
    queue.set(keyOf(entry.root, entry.title, taskId), { root: entry.root, title: entry.title, taskId })
    idle = false
    return true
  }

  /** status/资产接口被调用时：把该项目 in-flight（及 done 未绑定）任务重新入队。 */
  async function enqueueProject(root, title) {
    if (typeof root !== 'string' || !root || typeof title !== 'string' || !title) return 0
    let doc
    try {
      doc = await assetGeneration.readGenerationDoc(root, title)
    } catch {
      return 0
    }
    let count = 0
    for (const task of doc.tasks) {
      const inFlight = task.status === 'submitted' || task.status === 'pending'
      const doneUnbound = task.status === 'done' && Array.isArray(task.artifacts) && task.artifacts.length && !task.autoBind
      if (!inFlight && !doneUnbound) continue
      if (enqueue({ root, title, taskId: task.id })) count += 1
    }
    if (count) idle = false
    return count
  }

  async function updateWorker(root, title, taskId, patch) {
    try {
      return await assetGeneration.updateGenerationTask(root, title, taskId, patch)
    } catch (error) {
      log('warn', `worker 状态写入失败 ${taskId}: ${errorText(error)}`)
      return null
    }
  }

  async function markAutoBind(root, title, taskId, status, patch = {}) {
    return updateWorker(root, title, taskId, {
      autoBind: {
        status,
        at: new Date().toISOString(),
        ...(patch.error ? { error: String(patch.error).slice(0, 500) } : {}),
      },
      workerState: patch.workerState || (status === 'done' ? 'bound' : 'failed'),
      autoBound: status === 'done',
      ...(patch.reason ? { reason: String(patch.reason).slice(0, 120) } : {}),
    })
  }

  async function validateArtifact(projectDir, artifact) {
    const relPath = artifact && typeof artifact.relPath === 'string' ? artifact.relPath : ''
    if (!relPath || relPath.includes('..') || path.isAbsolute(relPath)) return { ok: false, error: 'artifact.relPath 非法' }
    const abs = path.join(projectDir, ...relPath.split('/'))
    const stat = await fs.stat(abs).catch(() => null)
    if (!stat || !stat.isFile() || stat.size <= 0) return { ok: false, error: 'artifact 文件不存在' }
    if (Number.isFinite(Number(artifact.bytes)) && Number(artifact.bytes) !== stat.size) return { ok: false, error: 'artifact bytes 不一致' }
    if (typeof artifact.sha256 === 'string' && artifact.sha256) {
      const buffer = await fs.readFile(abs)
      const hash = createHash('sha256').update(buffer).digest('hex')
      if (hash !== artifact.sha256.toLowerCase()) return { ok: false, error: 'artifact sha256 不一致' }
    }
    return { ok: true }
  }

  async function bindCardMedia(root, title, task, artifact) {
    const projectDir = store.projectDir(root, title)
    const checked = await validateArtifact(projectDir, artifact)
    if (!checked.ok) {
      await markAutoBind(root, title, task.id, 'failed', { workerState: 'failed', error: checked.error, reason: 'artifact-invalid' })
      return false
    }
    const assetId = String(task.assetId || '').toUpperCase()
    const cards = await store.getAssetCards(root, title)
    const card = (Array.isArray(cards) ? cards : []).find((item) => String(item.id) === assetId) || null
    if (!card) {
      await markAutoBind(root, title, task.id, 'failed', { workerState: 'failed', error: `资产卡不存在：${assetId}`, reason: 'card-missing' })
      return false
    }
    const review = assetCards.normalizeReview(card.review)
    if (review && review.status === 'final') {
      await markAutoBind(root, title, task.id, 'skipped-final', { workerState: 'failed', error: 'asset-locked', reason: 'asset-locked' })
      return true
    }
﻿    const media = assetCards.normalizeAssetMedia(card.media) || {}
    const states = Array.isArray(media.states) ? media.states : []
    let nextMedia
    if (states.length) {
      const wantedStateId = typeof task.stateId === 'string' ? assetCards.normalizeMediaStateId(task.stateId) : ''
      const defaultStateId = (typeof media.defaultStateId === 'string' && states.some((state) => state.id === media.defaultStateId))
        ? media.defaultStateId
        : (states.find((state) => state.id === 'default') || states.find((state) => state.name === '默认') || states[0]).id
      // v0.16.194（P0-②）：task.stateId 优先；缺失→default；**不再回退 active**；显式但已不存在→失败不静默。
      const targetState = wantedStateId ? states.find((state) => state.id === wantedStateId) : states.find((state) => state.id === defaultStateId)
      if (!targetState) {
        await markAutoBind(root, title, task.id, 'failed', { workerState: 'failed', error: `目标状态不存在：${wantedStateId || defaultStateId}`, reason: 'state-missing' })
        return false
      }
      const activeStateId = media.activeStateId || states[0].id
      const allImages = states.flatMap((state) => Array.isArray(state.images) ? state.images : [])
      if (allImages.includes(artifact.relPath)) {
        await markAutoBind(root, title, task.id, 'done', { workerState: 'bound' })
        return true
      }
      const targetImages = Array.isArray(targetState.images) ? targetState.images.slice() : []
      if (targetImages.length >= assetCards.MEDIA_IMAGE_MAX) {
        await markAutoBind(root, title, task.id, 'failed', { workerState: 'failed', error: `资产图已达上限 ${assetCards.MEDIA_IMAGE_MAX} 张`, reason: 'media-full' })
        return false
      }
      const nextState = {
        ...targetState,
        images: [...targetImages, artifact.relPath],
        thumbnail: targetState.thumbnail || artifact.relPath,
      }
      const nextStates = states.map((state) => state.id === targetState.id ? nextState : state)
      nextMedia = assetCards.normalizeAssetMedia({ ...media, activeStateId, states: nextStates })
      if (!nextMedia) {
        await markAutoBind(root, title, task.id, 'failed', { workerState: 'failed', error: '状态媒体归一失败', reason: 'media-invalid' })
        return false
      }
    } else {
      // 194 旧单状态卡：显式 task.stateId 只允许 default；其余值不猜。
      if (typeof task.stateId === 'string' && assetCards.normalizeMediaStateId(task.stateId) && assetCards.normalizeMediaStateId(task.stateId) !== 'default') {
        await markAutoBind(root, title, task.id, 'failed', { workerState: 'failed', error: `目标状态不存在：${task.stateId}`, reason: 'state-missing' })
        return false
      }
      const images = Array.isArray(media.images) ? media.images.slice() : []
      if (images.includes(artifact.relPath)) {
        await markAutoBind(root, title, task.id, 'done', { workerState: 'bound' })
        return true
      }
      if (images.length >= assetCards.MEDIA_IMAGE_MAX) {
        await markAutoBind(root, title, task.id, 'failed', { workerState: 'failed', error: `资产图已达上限 ${assetCards.MEDIA_IMAGE_MAX} 张`, reason: 'media-full' })
        return false
      }
      nextMedia = {
        images: [...images, artifact.relPath],
        thumbnail: media.thumbnail || artifact.relPath,
        ...(Array.isArray(media.audio) && media.audio.length ? { audio: media.audio } : {}),
      }
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await store.readCardsDoc(root, title, 'asset')
      if (!current.doc || !current.hash) {
        await markAutoBind(root, title, task.id, 'failed', { workerState: 'failed', error: '资产卡文件不存在', reason: 'cards-missing' })
        return false
      }
      try {
        await store.applyAssetFieldEdit(root, title, {
          card: { id: assetId, media: nextMedia },
          expectedHash: current.hash,
        })
        await markAutoBind(root, title, task.id, 'done', { workerState: 'bound' })
        return true
      } catch (error) {
        const code = error && typeof error.code === 'string' ? error.code : ''
        if (code === 'asset-locked') {
          await markAutoBind(root, title, task.id, 'skipped-final', { workerState: 'failed', error: 'asset-locked', reason: 'asset-locked' })
          return true
        }
        if (code === 'conflict' && attempt === 0) continue // 并发写冲突：重读 hash 再试一次
        await markAutoBind(root, title, task.id, 'failed', { workerState: 'failed', error: errorText(error), reason: 'bind-failed' })
        return false
      }
    }
    return false
  }

  async function collectAndBind(root, title, task) {
    if (ageOf(task, now()) > maxTaskAgeMs) {
      await updateWorker(root, title, task.id, {
        status: 'failed',
        workerState: 'timeout',
        autoBound: false,
        error: `后台取回超时（>${Math.round(maxTaskAgeMs / 60000)} 分钟）`,
        reason: 'timeout',
      })
      return
    }
    await updateWorker(root, title, task.id, { workerState: 'downloading' })
    let result
    try {
      result = await assetGenerate.runAssetGenerate({
        root,
        input: { title, taskId: task.id, action: 'collect' },
        registry,
      })
    } catch (error) {
      log('warn', `collect 异常 ${title}/${task.id}: ${errorText(error)}`)
      await updateWorker(root, title, task.id, { workerState: 'failed', autoBound: false, error: errorText(error), reason: 'worker-error' })
      return
    }
    if (result && result.status === 'done' && result.artifact) {
      errorAttempts.delete(keyOf(root, title, task.id))
      await bindCardMedia(root, title, task, result.artifact)
      return
    }
    if (result && result.status === 'done' && (!result.artifact || !result.artifact.relPath)) {
      await updateWorker(root, title, task.id, { status: 'failed', workerState: 'failed', autoBound: false, error: 'done 但无 artifact', reason: 'artifact-missing' })
      return
    }
    if (result && result.status === 'pending') {
      await updateWorker(root, title, task.id, { workerState: 'polling' })
      return
    }
    if (result && result.status === 'failed') {
      await updateWorker(root, title, task.id, { workerState: 'failed', autoBound: false, ...(result.reason ? { reason: String(result.reason).slice(0, 120) } : {}) })
      return
    }
    if (result && result.status === 'error') {
      const key = keyOf(root, title, task.id)
      const attempts = (errorAttempts.get(key) || 0) + 1
      errorAttempts.set(key, attempts)
      if (attempts >= ASSET_SCHEDULER_MAX_ERROR_ATTEMPTS) {
        await updateWorker(root, title, task.id, {
          status: 'failed',
          workerState: 'failed',
          autoBound: false,
          error: `后台取回失败：${result.reason || '未知错误'}`,
          reason: 'collect-error',
        })
        errorAttempts.delete(key)
      } else {
        await updateWorker(root, title, task.id, { workerState: 'polling' })
      }
      return
    }
  }

  async function processTask(root, title, task) {
    if (!task || !task.id) return false
    if (task.status === 'submitted' || task.status === 'pending') {
      await collectAndBind(root, title, task)
      return true
    }
    if (task.status === 'done' && Array.isArray(task.artifacts) && task.artifacts.length && !task.autoBind) {
      // 崩溃恢复：collect 已写 done/artifacts 但尚未自动绑定。
      await bindCardMedia(root, title, task, task.artifacts[0])
      return true
    }
    return false
  }

  async function processProject(root, title) {
    let doc
    try {
      doc = await assetGeneration.readGenerationDoc(root, title)
    } catch (error) {
      log('warn', `读取 sidecar 失败 ${title}: ${errorText(error)}`)
      return 0
    }
    let count = 0
    for (const task of doc.tasks) {
      try {
        if (await processTask(root, title, task)) count += 1
      } catch (error) {
        log('warn', `处理任务失败 ${title}/${task.id}: ${errorText(error)}`)
        await updateWorker(root, title, task.id, { workerState: 'failed', autoBound: false, error: errorText(error), reason: 'worker-error' }).catch(() => {})
      }
    }
    return count
  }

  async function tick(force = false) {
    if (stopped || ticking || (idle && force !== true)) return { skipped: true, reason: stopped ? 'stopped' : (ticking ? 'busy' : 'idle') }
    if (force === true) idle = false
    ticking = true
    let scanned = 0
    let work = 0
    try {
      let roots = []
      try { roots = await getRoots() } catch (error) { log('warn', `解析 workspace 失败：${errorText(error)}`) }
      for (const root of Array.isArray(roots) ? roots : []) {
        if (typeof root !== 'string' || !root) continue
        let projects = []
        try { projects = await store.listProjects(root) } catch (error) { log('warn', `列出项目失败：${errorText(error)}`); continue }
        for (const project of projects) {
          if (!project || typeof project.title !== 'string' || !project.title) continue
          scanned += 1
          work += await processProject(root, project.title)
        }
      }
      const queued = [...queue.values()]
      queue.clear()
      for (const entry of queued) {
        try {
          const task = await assetGeneration.findGenerationTask(entry.root, entry.title, entry.taskId)
          if (task) {
            work += (await processTask(entry.root, entry.title, task)) ? 1 : 0
          }
        } catch (error) {
          log('warn', `队列任务失败 ${entry.taskId}: ${errorText(error)}`)
        }
      }
      // 无 in-flight/未绑定任务且队列清空 → 停摆（interval 保留但 tick 直接返回）。
      if (work === 0 && queue.size === 0) idle = true
      return { skipped: false, scanned, work }
    } finally {
      ticking = false
    }
  }

  function start() {
    if (stopped || timer) return
    stopped = false
    idle = false
    timer = setIntervalFn(() => { void tick() }, intervalMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
    void tick()
  }

  function stop() {
    stopped = true
    if (timer) {
      try { clearIntervalFn(timer) } catch { /* ignore */ }
      timer = null
    }
  }

  return { enqueue, enqueueProject, tick, start, stop, isStopped: () => stopped, isIdle: () => idle }
}
