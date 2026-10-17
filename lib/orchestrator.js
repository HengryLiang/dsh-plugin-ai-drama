/**
 * 阶段二 · 生成编排（FR-G02 分镜图 / FR-G03 分镜视频 / FR-G04 配音）
 *
 * 设计取舍：生成是**长任务**（图片数十秒、视频数分钟到二十分钟），
 * 所以编排拆成三段，任何一段都不长时间占用请求：
 *
 *   planEpisode()   读分镜 → 逐镜构造提示词与参数 → 预算闸门 → 落任务（不触发）
 *   submitBatch()   逐项调用后端触发 → 回写 externalId / 状态
 *   collectBatch()  查询状态 → 取产物 → 回流到 素材/生成/ → 结算
 *
 * 这样"提交"与"收敛"可以分属不同回合，符合外部画布的真实节奏（FR-G11）。
 */
import path from 'node:path'

import * as store from './store.js'
import * as generation from './generation.js'
import * as guard from './guard.js'

export const KIND_LABEL = { image: '分镜图', video: '分镜视频', audio: '配音' }

/** 短剧默认竖屏；分镜未指定画幅时用它（可在参数里覆盖）。 */
export const DEFAULT_RATIO = '9:16'

/**
 * 由分镜表的一行构造提示词与生成参数（确定性，可单测）。
 * 规则：分镜自带提示词就用它；否则按「景别 + 运镜 + 画面」拼一段，并带上出场角色。
 *
 * 字段名对齐分镜表的真实存储（见 store.js 的 shot 归一化）：
 *   shotNumber / shotSize / **cameraMove** / description / dialogue / sfx / durationSec / **imagePrompt**
 * 同时容忍常见别名，避免因为叫法不同而静默丢掉提示词或运镜。
 */
export function buildShotPrompt(shot, options = {}) {
  const s = shot || {}
  const shotNumber = String(s.shotNumber || s.shot || '').trim()
  if (!shotNumber) throw new Error('分镜缺少镜号')

  const explicit = String(s.imagePrompt || s.prompt || s.提示词 || '').trim()
  const parts = []
  if (explicit) {
    parts.push(explicit)
  } else {
    const size = String(s.shotSize || s.景别 || '').trim()
    const camera = String(s.cameraMove || s.camera || s.运镜 || '').trim()
    const description = String(s.description || s.画面 || '').trim()
    if (size) parts.push(size)
    if (camera) parts.push(camera)
    if (description) parts.push(description)
  }
  if (!parts.length) throw new Error(`镜 ${shotNumber} 既没有提示词也没有画面描述，无法生成`)

  const characters = Array.isArray(s.characters) ? s.characters.filter(Boolean) : []
  if (characters.length && !explicit) parts.push(`出场：${characters.join('、')}`)

  const style = options.style || s.style || ''
  if (style) parts.push(style)

  return {
    shotNumber,
    name: options.namePrefix ? `${options.namePrefix}-${shotNumber}` : shotNumber,
    prompt: parts.join('，'),
    params: {
      model: options.model || null,
      ratio: options.ratio || s.ratio || DEFAULT_RATIO,
      count: 1,
    },
  }
}

/** 从分镜表挑出要生成的镜。不传 shots 时取全部。 */
export function selectShots(shots, wanted) {
  const list = Array.isArray(shots) ? shots.slice() : []
  if (!wanted || !wanted.length) return list
  const wantedSet = new Set(wanted.map((s) => String(s).trim()))
  return list.filter((s) => wantedSet.has(String(s.shotNumber || s.shot || '').trim()))
}

/**
 * 规划一集的生成批次。**不触发任何生成**，只产出计划、预算判定与任务记录。
 * kind: image | video | audio
 */
export async function planEpisode(root, title, input = {}) {
  const episode = Number(input.episode)
  if (!Number.isFinite(episode) || episode < 1) throw new Error('需要指定集数')

  const kind = input.kind || 'image'
  if (!['image', 'video', 'audio'].includes(kind)) throw new Error('kind 只能是 image / video / audio')

  // 配音不需要分镜，直接用台词稿
  if (kind === 'audio') return planVoice(root, title, { ...input, episode, kind })

  const shots = await store.getStoryboard(root, title, episode)
  if (!shots.length) throw new Error(`第 ${episode} 集还没有分镜，先生成分镜表`)

  const chosen = selectShots(shots, input.shots)
  if (!chosen.length) throw new Error('选中的镜号在分镜表中不存在')

  const items = chosen.map((shot) => buildShotPrompt(shot, {
    model: input.model,
    ratio: input.ratio,
    style: input.style,
    namePrefix: `E${String(episode).padStart(3, '0')}`,
  }))

  const perUnit = Number(input.estimatePerUnitPoints)
  const estimatePoints = Number.isFinite(perUnit) ? perUnit * items.length : 0
  const gate = await generation.checkBudget(root, title, estimatePoints)

  const tasks = []
  if (input.record !== false) {
    for (const item of items) {
      tasks.push(await generation.createTask(root, title, {
        backend: input.backend,
        kind,
        episode,
        shots: [item.shotNumber],
        model: input.model,
        prompt: item.prompt,
        estimatePoints: Number.isFinite(perUnit) ? perUnit : null,
      }))
    }
  }

  return {
    episode,
    kind,
    label: KIND_LABEL[kind],
    backend: input.backend,
    model: input.model || null,
    count: items.length,
    items,
    tasks: tasks.map((t) => ({ id: t.id, shot: t.shots[0] })),
    estimatePoints,
    quota: { ok: gate.ok, limited: gate.limited, detail: gate.detail || null, budget: gate.budget },
    // FR-G08：事前提示（无法程序化检测外部网页端，所以每次都说）
    upstreamWarning: guard.UPSTREAM_WARNING,
  }
}

/** 配音规划：以台词稿的分集为准，逐集一条任务（不做逐句切分）。 */
async function planVoice(root, title, input) {
  const script = await store.exportVoiceScript(root, title, { episode: input.episode })
  const files = script.written || []
  if (!files.length) throw new Error(`第 ${input.episode} 集没有可配音的台词`)

  const items = files.map((f) => ({
    shotNumber: null,
    name: `E${String(input.episode).padStart(3, '0')}-VO`,
    prompt: f.relative || f,
    params: { model: input.model || null },
  }))

  const perUnit = Number(input.estimatePerUnitPoints)
  const estimatePoints = Number.isFinite(perUnit) ? perUnit * items.length : 0
  const gate = await generation.checkBudget(root, title, estimatePoints)

  const tasks = []
  if (input.record !== false) {
    for (const item of items) {
      tasks.push(await generation.createTask(root, title, {
        backend: input.backend,
        kind: 'audio',
        episode: input.episode,
        shots: [],
        model: input.model,
        prompt: item.prompt,
        estimatePoints: Number.isFinite(perUnit) ? perUnit : null,
      }))
    }
  }

  return {
    episode: input.episode,
    kind: 'audio',
    label: KIND_LABEL.audio,
    backend: input.backend,
    model: input.model || null,
    count: items.length,
    items,
    tasks: tasks.map((t) => ({ id: t.id })),
    estimatePoints,
    quota: { ok: gate.ok, limited: gate.limited, detail: gate.detail || null, budget: gate.budget },
    upstreamWarning: guard.UPSTREAM_WARNING,
  }
}

/**
 * 提交批次：逐项触发后端生成，成功则记 submitted + externalId，失败则记 failed + 原因。
 * 单镜失败不影响其余镜。
 */
export async function submitBatch(root, title, input = {}) {
  const backendId = input.backend
  const backend = input.resolveBackend ? input.resolveBackend(backendId) : null
  if (!backend) throw new Error(`未知后端：${backendId}`)

  const results = []
  for (const item of input.items || []) {
    const taskId = item.taskId
    try {
      const task = (await generation.listTasks(root, title, { limit: 1000 })).find((t) => t.id === taskId)
      const result = await backend.generate({
        name: item.name,
        kind: input.kind,
        prompt: item.prompt,
        model: input.model || (item.params && item.params.model),
        params: { ...(item.params || {}) },
        project: input.canvasUuid || undefined,
        cwd: input.cwd || store.projectDir(root, title),
      })
      const updated = await generation.updateTask(root, title, taskId, {
        status: 'submitted',
        externalId: (result.raw && (result.raw.nodeKey || result.raw.id)) || item.name,
      })
      results.push({ taskId, ok: true, node: item.name, task: updated })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const updated = await generation.updateTask(root, title, taskId, { status: 'failed', error: message }).catch(() => null)
      results.push({ taskId, ok: false, node: item.name, error: message, task: updated })
    }
  }
  return {
    submitted: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  }
}

/**
 * 收敛批次：对 submitted 的任务查询节点状态；已产出就取回并回流素材区。
 * 返回每项的最终状态，未完成的留在 pending。
 */
export async function collectBatch(root, title, input = {}) {
  const backendId = input.backend
  const backend = input.resolveBackend ? input.resolveBackend(backendId) : null
  if (!backend) throw new Error(`未知后端：${backendId}`)

  const cwd = input.cwd || store.projectDir(root, title)
  const taskIds = input.taskIds && input.taskIds.length ? new Set(input.taskIds) : null
  const tasks = (await generation.listTasks(root, title, { limit: 1000 })).filter(
    (t) => (t.status === 'submitted' || t.status === 'running') && (!taskIds || taskIds.has(t.id)),
  )

  const collected = []
  const pending = []
  const failed = []

  for (const task of tasks) {
    const nodeName = task.externalId || task.shots[0]
    try {
      const detail = backend.nodeDetail
        ? await backend.nodeDetail(nodeName, { cwd })
        : { state: 'unknown' }
      if (detail.state === 'failed') {
        const t = await generation.updateTask(root, title, task.id, { status: 'failed', error: detail.message || '平台报错' })
        failed.push({ taskId: task.id, error: t.error })
        continue
      }
      if (detail.state !== 'done') {
        pending.push({ taskId: task.id, state: detail.state })
        continue
      }
      // 已产出：取回本地再回流
      const outDir = path.join(store.projectDir(root, title), '素材', '生成')
      const download = await backend.download({ node: nodeName, outDir, cwd })
      const files = Array.isArray(download.files) && download.files.length ? download.files : []
      if (!files.length) {
        pending.push({ taskId: task.id, state: 'downloaded-none' })
        continue
      }
      const intaken = []
      for (const file of files) {
        intaken.push(await generation.intakeArtifact(root, title, {
          file,
          kind: task.kind,
          episode: task.episode,
          shots: task.shots,
          taskId: task.id,
          backend: task.backend,
          model: task.model,
        }))
      }
      await generation.updateTask(root, title, task.id, { status: 'done' })
      collected.push({ taskId: task.id, files: intaken.map((i) => i.relative) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pending.push({ taskId: task.id, state: 'error', error: message })
    }
  }

  return {
    collected: collected.length,
    pending: pending.length,
    failed: failed.length,
    details: { collected, pending, failed },
    budget: await generation.getBudget(root, title),
  }
}
