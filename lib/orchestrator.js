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
import fs from 'node:fs/promises'

import * as store from './store.js'
import * as generation from './generation.js'
import * as guard from './guard.js'
import * as drafts from './drafts.js'
import { checkConsistency } from './consistency.js'
import { PROMPT_MAX_CHARS, appendStyleChapter, buildVideoPromptText, composeStyleCue, renderControlForShot, renderStyleCue, shotHasVideoFields, truncateDeterministic } from './video-prompt.js'
import { styleInjectionForPlan } from './style-injection.js'
import { appendAssetSegment, assetPreflight, compileAssetSegment, compileReferenceAssetSegment, resolveShotAssets } from './asset-bindings.js'
import { attachCanvasAssets } from './canvas-assets.js'

export const KIND_LABEL = { image: '分镜图', video: '分镜视频', audio: '配音' }

/** 短剧默认竖屏；分镜未指定画幅时用它（可在参数里覆盖）。 */
export const DEFAULT_RATIO = '9:16'

/** v0.16.252：plan video 参数白名单（与 LibTV CLI schema 对齐；settings/store 同口径）。 */
export const PLAN_VIDEO_RATIOS = Object.freeze(['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'])
export const PLAN_VIDEO_RESOLUTIONS = Object.freeze(['480p', '720p', '1080p'])
export const PLAN_VIDEO_DURATION_MIN = 4
export const PLAN_VIDEO_DURATION_MAX = 30

function invalidPlanVideo(message) {
  const error = new Error(message)
  error.code = 'invalid-args'
  return error
}

/**
 * v0.16.252：校验并归一 plan video 参数。
 * - ratio：白名单；auto→adaptive；
 * - resolution：白名单，小写归一；
 * - duration：整数 4–30；
 * - enableSound：boolean 或 on/off → on/off；
 * - 仅显式提供才返回；非法抛 invalid-args（400）。
 */
export function normalizePlanVideoParams(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const out = {}
  if (source.ratio !== undefined && source.ratio !== null) {
    const raw = typeof source.ratio === 'string' ? source.ratio.trim().toLowerCase() : ''
    const ratio = raw === 'auto' ? 'adaptive' : raw
    if (!PLAN_VIDEO_RATIOS.includes(ratio)) throw invalidPlanVideo(`视频比例非法：${String(source.ratio)}（允许 ${PLAN_VIDEO_RATIOS.join('/')}）`)
    out.ratio = ratio
  }
  if (source.resolution !== undefined && source.resolution !== null) {
    const raw = typeof source.resolution === 'string' ? source.resolution.trim().toLowerCase() : ''
    if (!PLAN_VIDEO_RESOLUTIONS.includes(raw)) throw invalidPlanVideo(`视频清晰度非法：${String(source.resolution)}（允许 480P/720P/1080P）`)
    out.resolution = raw
  }
  if (source.duration !== undefined && source.duration !== null) {
    const duration = source.duration
    if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < PLAN_VIDEO_DURATION_MIN || duration > PLAN_VIDEO_DURATION_MAX) {
      throw invalidPlanVideo(`视频时长非法：${String(duration)}（需 ${PLAN_VIDEO_DURATION_MIN}–${PLAN_VIDEO_DURATION_MAX} 秒整数）`)
    }
    out.duration = duration
  }
  if (source.enableSound !== undefined && source.enableSound !== null) {
    if (source.enableSound === true || source.enableSound === 'on') out.enableSound = 'on'
    else if (source.enableSound === false || source.enableSound === 'off') out.enableSound = 'off'
    else throw invalidPlanVideo(`视频音频开关非法：${String(source.enableSound)}（允许 true/false/on/off）`)
  }
  return out
}

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
  // v0.16.265：video 分支以 shot.videoPrompt 为主体，只有它时不得提前抛错
  const videoPromptOnly = options.kind === 'video' && Boolean(String(s.videoPrompt || '').trim())
  if (!parts.length && !videoPromptOnly) throw new Error(`镜 ${shotNumber} 既没有提示词也没有画面描述，无法生成`)

  const characters = Array.isArray(s.characters) ? s.characters.filter(Boolean) : []
  if (characters.length && !explicit) parts.push(`出场：${characters.join('、')}`)

  const style = options.style || s.style || ''
  if (style) parts.push(style)

  const legacyPrompt = parts.join('，')
  // v0.16.226：P0-A 资产段（无资产段时 prompt 逐字节不变；duration 参数保持 225 语义）。
  const assetSegment = String(options.assetSegment == null ? '' : options.assetSegment).trim()
  const makeResult = (prompt) => {
    const videoParams = options.kind === 'video'
      ? normalizePlanVideoParams({ ratio: options.ratio, resolution: options.resolution, duration: options.duration, enableSound: options.enableSound })
      : null
    const params = {
      model: options.model || null,
      ratio: (videoParams && videoParams.ratio) || options.ratio || s.ratio || DEFAULT_RATIO,
      count: 1,
    }
    if (videoParams) {
      if (videoParams.resolution) params.resolution = videoParams.resolution
      if (videoParams.duration != null) params.duration = videoParams.duration
      if (videoParams.enableSound) params.enableSound = videoParams.enableSound
    }
    return {
      shotNumber,
      name: options.namePrefix ? `${options.namePrefix}-${shotNumber}` : shotNumber,
      prompt: assetSegment ? appendAssetSegment(prompt, assetSegment) : prompt,
      params,
    }
  }

  // v0.10.3（task-89）：仅 video 分支接草帽式 prompt；image/无字段旧项目走 legacy（字节零变化）
  // v0.11.3（task-101）：video 分支可再注入风格/场景约束句（styleCue 为空时不注入，字节与 v0.11.2 一致）
  if (options.kind === 'video') {
    const control = typeof options.videoControl === 'string' ? options.videoControl.trim() : ''
    const styleCue = typeof options.styleCue === 'string' ? options.styleCue.trim() : ''
    const maxChars = Number(options.maxPromptChars) || PROMPT_MAX_CHARS
    // v0.16.264：shot.videoPrompt 是最高优先主体；control/styleCue 仅作可选前后缀，不得替换主体。
    const videoPrompt = String(s.videoPrompt || '').trim()
    if (videoPrompt) {
      const body = truncateDeterministic(videoPrompt, maxChars)
      const head = [control, styleCue].filter(Boolean).join('\n')
      if (!head) return makeResult(body)
      const remain = Math.max(0, maxChars - body.length - 1)
      const suffix = remain > 20 ? truncateDeterministic(head, remain) : ''
      return makeResult(suffix ? `${body}\n${suffix}` : body)
    }
    if (shotHasVideoFields(s)) {
      const rendered = buildVideoPromptText(s, { control, styleCue, maxChars })
      if (rendered) return makeResult(rendered.prompt)
    } else if (control || styleCue) {
      // 缺字段镜：保留现状提示词原文，仅在其前追加总控段/风格约束句（逐镜 fallback 语义）
      const head = [control, styleCue].filter(Boolean).join('\n')
      return makeResult(truncateDeterministic(`${head}\n【镜头 ${shotNumber}】${legacyPrompt}`, maxChars))
    }
  }
  // C2b（E16）：image 分支在 legacy 文本末尾追加冻结风格章节（无章节不追加，旧字节不变）
  const styleChapter = typeof options.styleChapter === 'string' ? options.styleChapter.trim() : ''
  if (styleChapter) return makeResult(appendStyleChapter(legacyPrompt, styleChapter, Number(options.maxPromptChars) || PROMPT_MAX_CHARS))
  return makeResult(legacyPrompt)
}

/** 从分镜表挑出要生成的镜。不传 shots 时取全部。 */
export function selectShots(shots, wanted) {
  const list = Array.isArray(shots) ? shots.slice() : []
  if (!wanted || !wanted.length) return list
  const wantedSet = new Set(wanted.map((s) => String(s).trim()))
  return list.filter((s) => wantedSet.has(String(s.shotNumber || s.shot || '').trim()))
}

/* ------------------------------------------------ v0.16.226 P0-A 资产事实（只读） */

async function loadAssetFacts(root, title) {
  const [cards, legacyAssets] = await Promise.all([
    store.getAssetCards(root, title).catch(() => []),
    store.getAssets(root, title).catch(() => []),
  ])
  return { cards: Array.isArray(cards) ? cards : [], legacyAssets: Array.isArray(legacyAssets) ? legacyAssets : [] }
}

async function preflightShotAssets(root, title, shot, facts) {
  const result = assetPreflight({ shot, cards: facts.cards, legacyAssets: facts.legacyAssets })
  const project = store.projectDir(root, title)
  for (const asset of result.assets) {
    if (!asset.refPath) continue
    const target = path.join(project, ...String(asset.refPath).split('/'))
    const stat = await fs.stat(target).catch(() => null)
    if (!stat || !stat.isFile()) {
      result.warnings.push({
        shot: String(shot && (shot.shotNumber || shot.shot) || ''),
        assetId: asset.id,
        name: asset.name,
        refPath: asset.refPath,
        status: asset.status,
        code: 'asset_ref_missing',
        message: `参考图文件不存在：${asset.refPath}`,
      })
    }
  }
  return result
}

function hasShotAssetBinding(shot) {
  return Boolean(shot && ((Array.isArray(shot.assetIds) && shot.assetIds.length) || (Array.isArray(shot.assetStateBindings) && shot.assetStateBindings.length)))
}

/** v0.16.261：视频参考模式与参考图解析（本镜资产当前状态首图；去重；最多 30）。 */
export const VIDEO_REFERENCE_MODES = Object.freeze(['mixed2video', 'singleImage2video', 'text2video'])
export const VIDEO_REFERENCE_LIMITS = Object.freeze({ mixed2video: 30, singleImage2video: 1, text2video: 0 })
const VIDEO_REFERENCE_MODE_SET = new Set(VIDEO_REFERENCE_MODES)

function normalizeReferenceMode(mode) {
  const requested = mode == null || mode === '' ? 'mixed2video' : String(mode).trim()
  if (!VIDEO_REFERENCE_MODE_SET.has(requested)) {
    const error = new Error(`视频生成模式非法：${requested}（允许 ${VIDEO_REFERENCE_MODES.join('/')}）`)
    error.code = 'invalid-args'
    throw error
  }
  return requested
}

async function resolvePlanReferences(project, preflight, requestedMode) {
  const requested = normalizeReferenceMode(requestedMode)
  const warnings = []
  if (requested === 'text2video') return { mode: 'text2video', references: [], referenceAssets: [], referenceCount: 0, referenceLabels: [], referenceWarnings: warnings }
  const assets = (preflight && Array.isArray(preflight.assets) ? preflight.assets : [])
    .filter((asset) => asset && asset.status === 'resolved' && asset.refPath && asset.id)
  const unique = []
  const seen = new Set()
  for (const asset of assets) {
    if (seen.has(String(asset.id))) continue
    seen.add(String(asset.id))
    unique.push(asset)
  }
  const rank = (asset) => (['CHARACTER', 'SCENE', 'CHR', 'SPC'].includes(String(asset.type || '').toUpperCase()) ? 0 : 1)
  const ordered = unique.map((asset, index) => ({ asset, index })).sort((a, b) => rank(a.asset) - rank(b.asset) || a.index - b.index).map((row) => row.asset)
  const existing = []
  for (const asset of ordered) {
    const absolute = path.join(project, ...String(asset.refPath).split('/'))
    const stat = await fs.stat(absolute).catch(() => null)
    if (!stat || !stat.isFile()) {
      warnings.push({ code: 'asset_ref_missing', assetId: asset.id, name: asset.name, refPath: asset.refPath, message: `参考图文件不存在：${asset.refPath}` })
      continue
    }
    existing.push({ asset, absolute })
  }
  if (requested === 'singleImage2video' && existing.length === 0) {
    const error = new Error('图生视频需要至少 1 张已绑定且存在的资产参考图；请先绑定资产/补图')
    error.code = 'invalid-args'
    throw error
  }
  const limit = VIDEO_REFERENCE_LIMITS[requested]
  const selected = existing.slice(0, limit)
  if (requested === 'mixed2video' && selected.length === 0) {
    warnings.push({ code: 'reference_fallback_text', message: '本镜未绑定可用资产图，已自动回退文生视频' })
    return { mode: 'text2video', references: [], referenceAssets: [], referenceCount: 0, referenceLabels: [], referenceWarnings: warnings }
  }
  if (existing.length > limit) {
    warnings.push({ code: 'reference_trimmed_max', message: `${requested} 最多 ${limit} 张参考图，已截断` })
  }
  return {
    mode: requested,
    references: selected.map((row) => row.absolute),
    referenceAssets: selected.map((row) => ({ id: row.asset.id, name: row.asset.name, type: row.asset.type || '', stateName: row.asset.stateName || '', refPath: row.asset.refPath, path: row.absolute, status: 'resolved' })),
    referenceCount: selected.length,
    referenceLabels: selected.map((row) => row.asset.name),
    referenceWarnings: warnings,
  }
}

async function preflightTaskAssets(root, title, task, facts, storyboardCache) {
  if (!task || !Number.isFinite(Number(task.episode))) return null
  const episode = Number(task.episode)
  let shots = storyboardCache.get(episode)
  if (!shots) {
    shots = await store.getStoryboard(root, title, episode).catch(() => [])
    storyboardCache.set(episode, shots)
  }
  const wanted = String((Array.isArray(task.shots) && task.shots[0]) || '')
  const shot = wanted ? shots.find((item) => String(item.shotNumber || item.shot || '') === wanted) : null
  if (!shot || !hasShotAssetBinding(shot)) return null
  return preflightShotAssets(root, title, shot, facts)
}

/** v0.16.208：视频仅 LibTV；NeoWoW 当前无 generate 适配，明确拒绝而非静默降级。 */
function assertVideoBackendSupported(kind, backend) {
  if (kind === 'video' && String(backend || '').trim().toLowerCase() === 'neowow') {
    const error = new Error('视频生成仅支持 libtv 后端（neowow 暂不支持）')
    error.code = 'invalid-args'
    throw error
  }
}

/** v0.16.223：撤销视频时长提交拦截（插件不处理时长）。 */

/**
 * 规划一集的生成批次。**不触发任何生成**，只产出计划、预算判定与任务记录。
 * kind: image | video | audio
 */
export async function planEpisode(root, title, input = {}) {
  const episode = Number(input.episode)
  if (!Number.isFinite(episode) || episode < 1) throw new Error('需要指定集数')

  const kind = input.kind || 'image'
  if (!['image', 'video', 'audio'].includes(kind)) throw new Error('kind 只能是 image / video / audio')
  assertVideoBackendSupported(kind, input.backend)
  // v0.16.252：显式 video 参数统一校验/归一（4–30；ratio/resolution/enableSound 一并透传）。
  const videoParams = kind === 'video'
    ? normalizePlanVideoParams({ ratio: input.ratio, resolution: input.resolution, duration: input.duration, enableSound: input.enableSound })
    : {}

  // 配音不需要分镜，直接用台词稿
  if (kind === 'audio') return planVoice(root, title, { ...input, episode, kind })

  const shots = await store.getStoryboard(root, title, episode)
  if (!shots.length) throw new Error(`第 ${episode} 集还没有分镜，先生成分镜表`)

  const chosen = selectShots(shots, input.shots)
  if (!chosen.length) throw new Error('选中的镜号在分镜表中不存在')
  const shotByNumber = new Map(chosen.map((shot) => [String(shot.shotNumber || '').trim(), shot]))

  // v0.10.3（task-89）：video 时读取一次 groups sidecar + 首镜 emotion（空 sidecar 安全）；
  // image/audio 路径不读取、输出与 v0.10.2 完全一致。
  // C2b（E16）：**一次**只读 style.json → 仅 frozen+五维非空时生成固定章节（不写 style）；
  // image/video 都注入章节；video 保留场景卡约束句；非 frozen/旧项目不注入（字节不变）。
  const videoGroups = kind === 'video' ? await store.getStoryboardGroups(root, title, episode).catch(() => null) : null
  const firstEmotion = kind === 'video' ? (shots.find((shot) => shot.emotion && typeof shot.emotion === 'object')?.emotion || null) : null
  const styleDoc = await store.readStyleDoc(root, title).catch(() => null)
  const styleInjection = styleInjectionForPlan(styleDoc)
  const videoScenes = kind === 'video' ? await store.getScenes(root, title).catch(() => []) : []
  const videoSceneById = new Map((Array.isArray(videoScenes) ? videoScenes : []).map((scene) => [scene.id, scene]))
  const sceneCueFor = (shot) => {
    if (kind !== 'video') return ''
    const sceneRef = shot && shot.sceneRef ? String(shot.sceneRef).trim().toUpperCase() : ''
    const scene = sceneRef ? videoSceneById.get(sceneRef) || null : null
    return renderStyleCue({ style: null, scene })
  }
  const styleCueFor = (shot) =>
    kind === 'video' ? composeStyleCue({ chapter: styleInjection ? styleInjection.chapter : '', sceneCue: sceneCueFor(shot) }) : ''
  // v0.16.226 P0-A：仅当本批有资产绑定时读取资产事实并构造资产段/预检；无资产旧项目零新字段。
  const hasAnyShotAssets = chosen.some(hasShotAssetBinding)
  const assetFacts = hasAnyShotAssets ? await loadAssetFacts(root, title) : { cards: [], legacyAssets: [] }
  const shotPreflights = hasAnyShotAssets
    ? await Promise.all(chosen.map((shot) => preflightShotAssets(root, title, shot, assetFacts)))
    : []
  const projectRoot = store.projectDir(root, title)
  const referencePlans = kind === 'video'
    ? await Promise.all(chosen.map((shot, index) => resolvePlanReferences(projectRoot, hasAnyShotAssets ? shotPreflights[index] : null, input.mode)))
    : []
  const referenceWarnings = referencePlans.flatMap((plan) => plan.referenceWarnings || [])
  const items = chosen.map((shot, index) => {
    const preflight = hasAnyShotAssets ? shotPreflights[index] : null
    const referencePlan = kind === 'video' ? referencePlans[index] : null
    const segmentUsable = Boolean(preflight && preflight.assets.some((asset) => ['resolved', 'missing_media', 'missing_state'].includes(asset.status)))
    const referenceSegment = kind === 'video' && referencePlan && referencePlan.referenceCount > 0
      ? compileReferenceAssetSegment(referencePlan.referenceAssets)
      : ''
    const assetSegment = kind === 'image' && segmentUsable ? compileAssetSegment(preflight.assets) : ''
    const built = buildShotPrompt(shot, {
      model: input.model,
      ratio: input.ratio,
      style: input.style,
      namePrefix: `E${String(episode).padStart(3, '0')}`,
      ...(kind === 'video' ? { kind: 'video', ...videoParams, videoControl: renderControlForShot(shot, { groups: videoGroups || [], firstEmotion }), styleCue: styleCueFor(shot) } : {}),
      ...(kind === 'image' && styleInjection ? { styleChapter: styleInjection.chapter } : {}),
      ...(assetSegment ? { assetSegment } : {}),
    })
    // v0.16.265：资产段后置（主体 → 【本镜资产】），避免遮挡主体
    const builtWithPrompt = referenceSegment ? { ...built, prompt: `${built.prompt}\n${referenceSegment}` } : built
    const withReferences = referencePlan ? { ...builtWithPrompt, ...referencePlan, effectiveMode: referencePlan.mode } : builtWithPrompt
    if (!preflight) return withReferences
    return {
      ...withReferences,
      assetIds: Array.isArray(shot.assetIds) ? shot.assetIds.slice() : [],
      assets: preflight.assets,
      assetPreflight: { warnings: preflight.warnings, blockers: preflight.blockers },
    }
  })
  const assetWarnings = shotPreflights.flatMap((preflight) => preflight.warnings)
  const assetBlockers = shotPreflights.flatMap((preflight) => preflight.blockers)

  const perUnit = Number(input.estimatePerUnitPoints)
  const explicitPerUnit = Number.isFinite(perUnit)
  // P2-5（v0.6.6）① 生成前成本预估：复用预算台账，给出 tokens/积分区间 + ③ 三级预算闸门
  const costEstimate = await generation.estimateGenerationCost(root, title, {
    kind,
    unitCount: items.length,
    prompts: items.map((item) => item.prompt),
    estimatePerUnitPoints: explicitPerUnit ? perUnit : undefined,
    episode,
    backend: input.backend,
    model: input.model,
  })
  const estimatePoints = explicitPerUnit ? perUnit * items.length : 0
  const gate = costEstimate.gate
  const budget = await generation.getBudget(root, title)
  // v0.6.7：可选 operationId（提供时逐镜派生幂等键；省略=旧行为，不改变 task 形状）
  const batchOperationId = typeof input.operationId === 'string' && input.operationId.trim() ? input.operationId.trim().slice(0, 120) : ''

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
        ...(kind === 'video' ? { durationSec: shotByNumber.get(String(item.shotNumber || '').trim())?.durationSec ?? null } : {}),
        estimatePoints: Number.isFinite(perUnit) ? perUnit : null,
        ...(batchOperationId ? { operationId: `${batchOperationId}:${item.shotNumber}` } : {}),
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
    // v0.16.208：add-only 回填 taskId，修复 plan.items → submit-batch 的断链（旧字段不变）。
    items: items.map((item, index) => ({ ...item, ...(tasks[index] ? { taskId: tasks[index].id } : {}) })),
    tasks: tasks.map((t) => ({ id: t.id, shot: t.shots[0], ...(t.operationId ? { operationId: t.operationId } : {}) })),
    estimatePoints,
    costEstimate,
    quota: { ok: gate.ok, limited: gate.limited, detail: gate.detail || null, budget, levels: gate.levels },
    ...(batchOperationId ? { batchOperationId } : {}),
    ...(styleInjection ? { styleInjection } : {}),
    ...(kind === 'video' ? {
      referenceMode: referencePlans.length ? referencePlans[0].mode : 'text2video',
      effectiveMode: referencePlans.length ? referencePlans[0].mode : 'text2video',
      referenceCount: referencePlans.reduce((sum, plan) => sum + (plan.referenceCount || 0), 0),
      ...(referenceWarnings.length ? { referenceWarnings } : {}),
    } : {}),
    ...(hasAnyShotAssets || referenceWarnings.length ? {
      assetPreflight: { warnings: assetWarnings, blockers: assetBlockers },
      warnings: [...assetWarnings, ...referenceWarnings],
      blockers: assetBlockers,
    } : {}),
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
  const explicitPerUnit = Number.isFinite(perUnit)
  // P2-5（v0.6.6）① 成本预估 + ③ 三级预算闸门（配音按集一条任务，units=条数）
  const costEstimate = await generation.estimateGenerationCost(root, title, {
    kind: 'audio',
    unitCount: items.length,
    prompts: items.map((item) => item.prompt),
    estimatePerUnitPoints: explicitPerUnit ? perUnit : undefined,
    episode: input.episode,
    backend: input.backend,
    model: input.model,
  })
  const estimatePoints = explicitPerUnit ? perUnit * items.length : 0
  const gate = costEstimate.gate
  const budget = await generation.getBudget(root, title)
  const batchOperationId = typeof input.operationId === 'string' && input.operationId.trim() ? input.operationId.trim().slice(0, 120) : ''

  const tasks = []
  if (input.record !== false) {
    for (const [index, item] of items.entries()) {
      tasks.push(await generation.createTask(root, title, {
        backend: input.backend,
        kind: 'audio',
        episode: input.episode,
        shots: [],
        model: input.model,
        prompt: item.prompt,
        estimatePoints: Number.isFinite(perUnit) ? perUnit : null,
        ...(batchOperationId ? { operationId: `${batchOperationId}:VO:${index + 1}` } : {}),
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
    items: items.map((item, index) => ({ ...item, ...(tasks[index] ? { taskId: tasks[index].id } : {}) })),
    tasks: tasks.map((t) => ({ id: t.id, ...(t.operationId ? { operationId: t.operationId } : {}) })),
    estimatePoints,
    costEstimate,
    quota: { ok: gate.ok, limited: gate.limited, detail: gate.detail || null, budget, levels: gate.levels },
    ...(batchOperationId ? { batchOperationId } : {}),
    upstreamWarning: guard.UPSTREAM_WARNING,
  }
}

/**
 * 提交批次：逐项触发后端生成，成功则记 submitted + externalId，失败则记 failed + 原因。
 * 单镜失败不影响其余镜。
 *
 * v0.6.7（P2-5 剩余）：失败分类 + 可配置退避重试。
 * - 默认 settings.generationRetry 未配置 → maxAttempts=1（不重试，结果与 v0.6.6 一致）；
 * - 可重试错误（网络/超时/限流/5xx）按退避重试；不可重试（参数/预算/权限/4xx）立即失败；
 * - 结果仅新增 attempts/retryable/classification 字段（旧字段不变）。
 */
export async function submitBatch(root, title, input = {}) {
  const backendId = input.backend
  assertVideoBackendSupported(input.kind, backendId)
  const backend = input.resolveBackend ? input.resolveBackend(backendId) : null
  if (!backend) throw new Error(`未知后端：${backendId}`)

  const retryConfig = input.retry === false ? { ...generation.DEFAULT_GENERATION_RETRY } : await generation.getGenerationRetry(root)
  const maxAttempts = Math.max(1, Number(retryConfig.maxAttempts) || 1)
  const results = []
  // v0.16.226 P0-A：submit 前置资产预检；无资产旧项目不读取、不新增阻断。
  const assetFacts = await loadAssetFacts(root, title)
  const storyboardCache = new Map()

  for (const item of input.items || []) {
    const taskId = item.taskId
    let attempts = 0
    while (attempts < maxAttempts) {
      attempts += 1
      try {
        const task = (await generation.listTasks(root, title, { limit: 1000 })).find((t) => t.id === taskId)
        // v0.16.208：已成功/已在途任务跳过，避免重复提交扣费（add-only；旧任务未命中状态时行为不变）。
        if (task && (task.status === 'done' || task.status === 'submitted' || task.status === 'running')) {
          results.push({ taskId, ok: true, skipped: true, reused: true, node: task.externalId || item.name, task, attempts })
          break
        }
        if (typeof backend.generate !== 'function') {
          const message = `后端 ${backendId} 未实现生成能力（capabilities.generate=false）`
          const updated = await generation.updateTask(root, title, taskId, { status: 'failed', error: message }).catch(() => null)
          results.push({ taskId, ok: false, node: item.name, error: message, task: updated, attempts })
          break
        }
        const assetCheck = await preflightTaskAssets(root, title, task, assetFacts, storyboardCache)
        if (assetCheck && assetCheck.blockers.length && input.assetPreflight !== false) {
          const message = `资产预检阻断：${assetCheck.blockers.map((row) => row.message || row.code).join('；')}`
          const updated = await generation.updateTask(root, title, taskId, { status: 'failed', error: message }).catch(() => null)
          results.push({
            taskId,
            ok: false,
            node: item.name,
            error: message,
            task: updated,
            attempts,
            blockedByAssets: true,
            assetPreflight: { warnings: assetCheck.warnings, blockers: assetCheck.blockers },
          })
          break
        }
        if (input.canvasMode === 'dry') {
          // v0.16.226 P0-A2：dry 只做 upload/建节点/连线/写 prompt/metadata，不带 -r；不写任务状态。
          const projectUuid = input.canvasUuid || (await guard.checkBinding(root, title, backendId).catch(() => null))?.uuid
          if (!projectUuid) throw new Error('LibTV dry-run 需要画布 UUID 或已绑定画布')
          const episode = Number(task && task.episode)
          let shots = storyboardCache.get(episode)
          if (!shots) {
            shots = await store.getStoryboard(root, title, episode).catch(() => [])
            storyboardCache.set(episode, shots)
          }
          const wanted = String((task && Array.isArray(task.shots) && task.shots[0]) || '')
          const shot = shots.find((row) => String(row.shotNumber || row.shot || '') === wanted) || null
          if (!shot) throw new Error(`dry-run 找不到分镜：第 ${episode} 集 ${wanted}`)
          const dry = await attachCanvasAssets({
            backend,
            projectUuid,
            cwd: input.cwd || store.projectDir(root, title),
            shot,
            assets: assetCheck ? assetCheck.assets : resolveShotAssets(shot, assetFacts),
            prompt: item.prompt,
            shotKey: item.name,
            episode,
            kind: input.kind,
            model: input.model || (item.params && item.params.model) || (task && task.model) || undefined,
            params: { ...(item.params || {}) },
            mode: item.effectiveMode || item.mode,
            referenceAssets: Array.isArray(item.referenceAssets) ? item.referenceAssets : undefined,
            dry: true,
            ...(input.assetNodePrefix ? { resourcePrefix: input.assetNodePrefix, shotPrefix: input.assetNodePrefix } : {}),
          })
          results.push({
            taskId,
            ok: true,
            dry: true,
            node: dry.shotKey,
            nodeKey: dry.nodeKey || null,
            shotKey: dry.shotKey,
            canvas: dry,
            mode: dry.mode,
            effectiveMode: dry.mode,
            referenceCount: dry.referenceCount || 0,
            ...(dry.referenceWarnings && dry.referenceWarnings.length ? { referenceWarnings: dry.referenceWarnings } : {}),
            attempts,
            ...(assetCheck && (assetCheck.warnings.length || assetCheck.blockers.length)
              ? { assetPreflight: { warnings: assetCheck.warnings, blockers: assetCheck.blockers } }
              : {}),
          })
          break
        }
        // v0.16.233：LibTV 真实 run 路径——有可解析资产时，先挂资产节点/连边/写 prompt/metadata，再 node --run。
        // 资产 attach 不触发 -r；runNode 才扣费。失败不自动重试（防重复扣费）。
        const runnableAssets = assetCheck ? assetCheck.assets.filter((asset) => asset.status === 'resolved') : []
        const canRunCanvas = backendId === 'libtv'
          && runnableAssets.length > 0
          && typeof backend.upload === 'function'
          && typeof backend.createNodeNoRun === 'function'
          && typeof backend.updateNode === 'function'
          && typeof backend.runNode === 'function'
        if (canRunCanvas) {
          try {
            const projectUuid = input.canvasUuid || (await guard.checkBinding(root, title, backendId).catch(() => null))?.uuid
            if (!projectUuid) throw new Error('LibTV 生成需要画布 UUID 或已绑定画布')
            const episode = Number(task && task.episode)
            let shots = storyboardCache.get(episode)
            if (!shots) {
              shots = await store.getStoryboard(root, title, episode).catch(() => [])
              storyboardCache.set(episode, shots)
            }
            const wanted = String((task && Array.isArray(task.shots) && task.shots[0]) || '')
            const shot = shots.find((row) => String(row.shotNumber || row.shot || '') === wanted) || null
            if (!shot) throw new Error(`LibTV run 找不到分镜：第 ${episode} 集 ${wanted}`)
            const attached = await attachCanvasAssets({
              backend,
              projectUuid,
              cwd: input.cwd || store.projectDir(root, title),
              shot,
              assets: runnableAssets,
              prompt: item.prompt,
              shotKey: item.name,
              episode,
              kind: input.kind,
              model: input.model || (item.params && item.params.model) || (task && task.model) || undefined,
              params: { ...(item.params || {}) },
              mode: item.effectiveMode || item.mode,
              referenceAssets: Array.isArray(item.referenceAssets) ? item.referenceAssets : undefined,
              dry: false,
              ...(input.assetNodePrefix ? { resourcePrefix: input.assetNodePrefix, shotPrefix: input.assetNodePrefix } : {}),
            })
            const run = await backend.runNode({ name: attached.shotKey, project: projectUuid, cwd: input.cwd || store.projectDir(root, title) })
            const nodeKey = (run && run.nodeKey) || attached.nodeKey || attached.shotKey
            const updated = await generation.updateTask(root, title, taskId, {
              status: 'submitted',
              externalId: nodeKey,
              nodeKey,
              nodeName: attached.shotKey,
            }).catch(() => null)
            results.push({
              taskId,
              ok: true,
              node: attached.shotKey,
              nodeKey,
              shotKey: attached.shotKey,
              canvas: attached,
              run,
              mode: attached.mode,
              effectiveMode: attached.mode,
              referenceCount: attached.referenceCount || 0,
              ...(attached.referenceWarnings && attached.referenceWarnings.length ? { referenceWarnings: attached.referenceWarnings } : {}),
              task: updated,
              attempts,
              reused: false,
              ...(assetCheck && (assetCheck.warnings.length || assetCheck.blockers.length)
                ? { assetPreflight: { warnings: assetCheck.warnings, blockers: assetCheck.blockers } }
                : {}),
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const updated = await generation.updateTask(root, title, taskId, { status: 'failed', error: message }).catch(() => null)
            results.push({ taskId, ok: false, node: item.name, error: message, task: updated, attempts, assetRun: true, noRetry: true })
          }
          break
        }
        const result = await backend.generate({
          name: item.name,
          kind: input.kind,
          prompt: item.prompt,
          model: input.model || (item.params && item.params.model) || (task && task.model),
          params: { ...(item.params || {}) },
          references: Array.isArray(item.references) ? item.references : undefined,
          mode: item.effectiveMode || item.mode,
          project: input.canvasUuid || undefined,
          cwd: input.cwd || store.projectDir(root, title),
        })
        const updated = await generation.updateTask(root, title, taskId, {
          status: 'submitted',
          externalId: (result.raw && (result.raw.nodeKey || result.raw.id)) || item.name,
        })
        results.push({
          taskId,
          ok: true,
          node: item.name,
          task: updated,
          attempts,
          reused: false,
          ...(input.kind === 'video' ? {
            mode: result.effectiveMode || result.mode || item.effectiveMode || item.mode || null,
            effectiveMode: result.effectiveMode || result.mode || item.effectiveMode || item.mode || null,
            referenceCount: Number.isFinite(Number(result.referenceCount)) ? Number(result.referenceCount) : (Number(item.referenceCount) || 0),
            ...(result.referenceWarnings && result.referenceWarnings.length ? { referenceWarnings: result.referenceWarnings } : {}),
          } : {}),
          ...(assetCheck && (assetCheck.warnings.length || assetCheck.blockers.length)
            ? { assetPreflight: { warnings: assetCheck.warnings, blockers: assetCheck.blockers } }
            : {}),
        })
        break
      } catch (error) {
        const classification = generation.classifyGenerationError(error)
        const canRetry = classification.retryable && attempts < maxAttempts
        if (canRetry) {
          await generation.waitBeforeRetry(attempts, retryConfig)
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        const updated = await generation.updateTask(root, title, taskId, { status: 'failed', error: message }).catch(() => null)
        results.push({
          taskId,
          ok: false,
          node: item.name,
          error: message,
          task: updated,
          attempts,
          retryable: classification.retryable,
          classification,
        })
        break
      }
    }
  }

  return {
    submitted: results.filter((r) => r.ok && r.skipped !== true).length,
    failed: results.filter((r) => !r.ok).length,
    skipped: results.filter((r) => r.skipped === true).length,
    results,
  }
}

/**
 * 断点续跑（v0.6.7）：对指定集（可选限定 operationId 前缀）只在「未成功」的任务上续跑。
 * - 跳过 done（已成功产物不重复生成/回流）、submitted/running（已在平台在途，不重复提交）；
 * - 只对 planned/failed 重新提交；重复调用幂等（第二次返回 idempotent:true、submitted=0）。
 */
export async function resumeBatch(root, title, input = {}) {
  const episode = Number(input.episode)
  if (!Number.isFinite(episode) || episode < 1) throw new Error('需要指定集数')
  const operationIdPrefix = typeof input.operationId === 'string' && input.operationId.trim() ? input.operationId.trim() : ''
  const allTasks = await generation.listTasks(root, title, { limit: 1000 })
  const batch = allTasks.filter(
    (task) => Number(task.episode) === episode && (!operationIdPrefix || String(task.operationId || '').startsWith(operationIdPrefix)),
  )
  const done = batch.filter((task) => task.status === 'done')
  const inFlight = batch.filter((task) => task.status === 'submitted' || task.status === 'running')
  const pending = batch.filter((task) => task.status === 'planned' || task.status === 'failed')
  const kind = input.kind || (pending[0] && pending[0].kind) || 'image'

  let submitted = { submitted: 0, failed: 0, results: [] }
  if (pending.length) {
    const items = pending.map((task) => ({
      taskId: task.id,
      name: task.externalId || `E${String(episode).padStart(3, '0')}-${task.shots[0] || 'VO'}`,
      prompt: task.prompt,
      params: { model: task.model },
    }))
    submitted = await submitBatch(root, title, { ...input, backend: input.backend, kind, items })
  }

  return {
    resumed: true,
    episode,
    operationId: operationIdPrefix || null,
    pendingBefore: pending.length,
    skippedDone: done.length,
    skippedInFlight: inFlight.length,
    idempotent: pending.length === 0,
    ...submitted,
  }
}

/**
 * v0.16.208：视频产物名称 = E<集>-Shot<镜>-v<n>.mp4；n 由同集同镜已登记 video 资产数 + 1。
 * intakeArtifact 仍保留同名后缀保护（并发/重复 collect 不会覆盖）。
 */
async function nextVideoArtifactName(root, title, task) {
  const episode = Number.isFinite(Number(task && task.episode)) && Number(task.episode) >= 1 ? Number(task.episode) : 1
  const rawShot = Array.isArray(task && task.shots) && task.shots.length ? String(task.shots[0]).trim() : 'VO'
  const shot = rawShot.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 40) || 'VO'
  let assets = []
  try { assets = await store.getAssets(root, title) } catch { assets = [] }
  const sameShotVideos = (Array.isArray(assets) ? assets : []).filter((asset) => {
    if (!asset || String(asset.kind || '').toLowerCase() !== 'video') return false
    if (!Array.isArray(asset.linkedShots) || !asset.linkedShots.includes(rawShot)) return false
    return asset.episode == null || Number(asset.episode) === episode
  })
  const version = sameShotVideos.length + 1
  return `E${String(episode).padStart(3, '0')}-Shot${shot}-v${version}.mp4`
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
    const projectPath = store.projectDir(root, title)
    let videoTempDir = null
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
      // v0.16.186：video 任务先下载到 .aidrama 临时目录，再由 intakeArtifact 落 素材/视频/S01-EP<集>/；
      // 避免正式视频在 素材/生成/ 留重复副本；临时目录在采纳后清理。图片/音频/其他仍走 素材/生成/。
      if (task.kind === 'video' && !input.outDir) {
        const episode = task.episode == null ? 1 : task.episode
        await store.ensureEpisodeVideoDir(root, title, episode)
        const tempRel = `.aidrama/video-intake/${Date.now()}-${Math.random().toString(16).slice(2)}`
        videoTempDir = await store.guardedProjectMkdir(projectPath, tempRel)
      }
      // 已产出：取回本地再回流（P2-7：批量可指定 outDir 暂存目录 + artifactSink 自定义落点）
      const outDir = input.outDir || videoTempDir || path.join(projectPath, '素材', '生成')
      const download = await backend.download({ node: nodeName, outDir, cwd })
      const files = Array.isArray(download.files) && download.files.length ? download.files : []
      if (!files.length) {
        pending.push({ taskId: task.id, state: 'downloaded-none' })
        continue
      }
      const videoArtifactName = task.kind === 'video' ? await nextVideoArtifactName(root, title, task) : null
      const intaken = []
      for (const file of files) {
        if (typeof input.artifactSink === 'function') {
          intaken.push(await input.artifactSink({ file, task, episode: task.episode, taskId: task.id }))
          continue
        }
        // v0.16.1（task-138 / C-6）：内部可信链路（后端产物落在项目内/批次 staging）放行内部数据目录，外部路径仍拒绝
        intaken.push(await generation.intakeArtifact(root, title, {
          file,
          kind: task.kind,
          episode: task.episode,
          shots: task.shots,
          taskId: task.id,
          backend: task.backend,
          model: task.model,
          ...(videoArtifactName ? { name: videoArtifactName } : {}),
        }, { allowInternalDataDir: true }))
      }
      await generation.updateTask(root, title, task.id, { status: 'done' })
      collected.push({ taskId: task.id, files: intaken.map((i) => i.relative || i.stagedRelative) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pending.push({ taskId: task.id, state: 'error', error: message })
    } finally {
      if (videoTempDir) {
        try {
          await store.guardedProjectRemove(projectPath, `.aidrama/video-intake/${path.basename(videoTempDir)}`)
        } catch {
          /* 临时目录清理失败不阻断收敛 */
        }
      }
    }
  }

  const budget = await generation.getBudget(root, title)
  // v0.6.7：生成/采纳后可选画布漂移检测（只报不改；需要后端支持 listNodes + 指定 episode）
  let drift = null
  if (input.checkDrift !== false && Number.isFinite(Number(input.episode)) && typeof backend.listNodes === 'function') {
    try {
      drift = await guard.detectDrift(root, title, { backend, backendId: backendId, episode: Number(input.episode), cwd })
    } catch {
      drift = null
    }
  }
  return {
    collected: collected.length,
    pending: pending.length,
    failed: failed.length,
    details: { collected, pending, failed },
    budget,
    ...(drift ? { drift } : {}),
  }
}

/* ================================================================
 * P2-7（v0.7.1）多集批量生成：串行批量 / 批量溯源 / 逐集一致性 / 中断幂等续跑
 *
 * 设计：**严格串行**（逐集循环调用既有 planEpisode/submitBatch/collectBatch，绝不并行）；
 * 通过既有 route（plan-batch / submit-batch / collect-batch）的 additive 输入触发，**不新增 route/工具**；
 * 产物先落 `.aidrama/batches/<batchId>/staging/` 草稿区，用户经既有 draft-resolve 采纳后才进 素材/生成。
 * ================================================================ */

const BATCH_DEFAULTS = { maxEpisodes: 10, maxPoints: null, maxDurationMs: null }
const MAX_BATCH_EPISODES = 20

function clampInteger(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function normalizeBatchCaps(input = {}) {
  const caps = {
    maxEpisodes: clampInteger(input.maxEpisodes, 1, MAX_BATCH_EPISODES, BATCH_DEFAULTS.maxEpisodes),
    maxPoints: input.maxPoints == null || input.maxPoints === '' ? null : Math.max(0, Math.round(Number(input.maxPoints))),
    maxDurationMs: input.maxDurationMs == null || input.maxDurationMs === '' ? null : Math.max(0, Math.round(Number(input.maxDurationMs))),
  }
  if (caps.maxPoints != null && !Number.isFinite(Number(input.maxPoints))) throw new Error('maxPoints 必须是非负数字')
  if (caps.maxDurationMs != null && !Number.isFinite(Number(input.maxDurationMs))) throw new Error('maxDurationMs 必须是非负数字（毫秒）')
  return caps
}

/** 支持 `episodes:[1,2,3]` 或 `count+from`；返回去重升序集数。 */
export function normalizeBatchEpisodes(input = {}) {
  let list = []
  if (Array.isArray(input.episodes)) list = input.episodes.map((value) => Number(value))
  else if (Number(input.count || input.episodeCount) > 0) {
    const count = Math.round(Number(input.count || input.episodeCount))
    const from = Math.max(1, Math.round(Number(input.from || input.startEpisode || 1)))
    list = Array.from({ length: count }, (_, index) => from + index)
  } else if (Number(input.episode) > 0) list = [Number(input.episode)]
  const unique = [...new Set(list.filter((order) => Number.isFinite(order) && order >= 1 && order <= 9999).map((order) => Math.round(order)))]
  unique.sort((a, b) => a - b)
  return unique
}

function batchEpisodePrefix(batchId, episode) {
  return `${batchId}:E${episode}:`
}

/** 保留每次 submit/collect 的历史（幂等重跑不覆盖首次的真实耗时/attempts/产物，便于溯源审计）。 */
function pushSubmitTrace(episodeRecord, next) {
  const history = [...(((episodeRecord.trace && episodeRecord.trace.submitHistory) || [])), (episodeRecord.trace && episodeRecord.trace.submit) || null].filter(Boolean).slice(-20)
  episodeRecord.trace = { ...(episodeRecord.trace || {}), submitHistory: history, submit: next }
}

function pushCollectTrace(episodeRecord, next) {
  const history = [...(((episodeRecord.trace && episodeRecord.trace.collectHistory) || [])), (episodeRecord.trace && episodeRecord.trace.collect) || null].filter(Boolean).slice(-20)
  episodeRecord.trace = { ...(episodeRecord.trace || {}), collectHistory: history, collect: next }
}

function summarizeBatchConsistency(report, episodes) {
  const byEpisode = {}
  for (const episode of episodes) byEpisode[episode] = { errors: 0, warns: 0, infos: 0, issues: [] }
  const global = []
  for (const item of (report && report.issues) || []) {
    const where = String(item.where || '')
    const matchedEpisodes = Object.keys(byEpisode)
      .map((key) => Number(key))
      .filter((episode) => {
        const label = String(episode)
        const padded = String(episode).padStart(3, '0')
        return where.includes(`第 ${label} 集`) || where.includes(`第${label}集`) || where.includes(`E${padded}`) || where.includes(`第${padded}集`)
      })
    if (!matchedEpisodes.length) {
      global.push({ severity: item.severity, code: item.code, message: item.message, where })
      continue
    }
    for (const episode of matchedEpisodes) {
      const bucket = byEpisode[episode]
      if (item.severity === 'error') bucket.errors += 1
      else if (item.severity === 'warn') bucket.warns += 1
      else bucket.infos += 1
      bucket.issues.push({ severity: item.severity, code: item.code, message: item.message, where })
    }
  }
  const passedEpisodes = Object.keys(byEpisode).filter((key) => byEpisode[key].errors === 0 && byEpisode[key].warns === 0).length
  const totalEpisodes = Object.keys(byEpisode).length
  return {
    score: totalEpisodes ? Math.round((passedEpisodes / totalEpisodes) * 1000) / 10 : 100,
    passedEpisodes,
    totalEpisodes,
    byEpisode,
    global: { summary: (report && report.summary) || null, issues: global.slice(0, 30) },
    checkedAt: (report && report.checkedAt) || new Date().toISOString(),
  }
}

/**
 * 规划 N 集串行批量：先逐集预演成本/预算闸门（不触发、不必要不登记任务），
 * 校验批量级上限（集数/预估积分/项目预算）后，再逐集登记任务（operationId 幂等键）。
 * 超限 → status='blocked'（不登记任务）+ 明细；同 batchId 重复调用可续规划（不重复登记）。
 */
export async function planBatchEpisodes(root, title, input = {}) {
  const episodes = normalizeBatchEpisodes(input)
  if (!episodes.length) throw new Error('需要指定要批量生成的集数（episodes 数组，或 count+from）')
  const kind = input.kind || 'image'
  if (!['image', 'video', 'audio'].includes(kind)) throw new Error('kind 只能是 image / video / audio')
  if (!input.backend) throw new Error('缺少 backend')
  const caps = normalizeBatchCaps(input)
  const batchId = input.batchId ? generation.assertSafeBatchId(String(input.batchId)) : generation.newBatchId()
  const record = input.record !== false
  let previous = null
  try {
    previous = await generation.getBatchTrace(root, title, batchId)
  } catch {
    previous = null
  }
  const rounds = previous ? (Number(previous.rounds) || 1) + 1 : 1
  const now = new Date().toISOString()

  // ① 预演（record:false，不产生任务）：成本/闸门/逐集可规划性
  const previews = []
  for (const episode of episodes) {
    const startedAt = Date.now()
    try {
      const preview = await planEpisode(root, title, { ...input, episode, kind, record: false })
      previews.push({
        episode,
        status: 'previewed',
        count: preview.count,
        estimatePoints: preview.estimatePoints,
        costEstimate: preview.costEstimate,
        durationMs: Date.now() - startedAt,
      })
    } catch (error) {
      previews.push({ episode, status: 'blocked', error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt })
    }
  }
  const previewable = previews.filter((item) => item.status === 'previewed')
  const units = previewable.reduce((sum, item) => sum + (item.count || 0), 0)
  const pointsMin = previewable.reduce((sum, item) => sum + Number((item.costEstimate && item.costEstimate.points && item.costEstimate.points.totalMin) || 0), 0)
  const pointsMax = previewable.reduce((sum, item) => sum + Number((item.costEstimate && item.costEstimate.points && item.costEstimate.points.totalMax) || 0), 0)
  const tokensMin = previewable.reduce((sum, item) => sum + Number((item.costEstimate && item.costEstimate.tokens && item.costEstimate.tokens.totalMin) || 0), 0)
  const tokensMax = previewable.reduce((sum, item) => sum + Number((item.costEstimate && item.costEstimate.tokens && item.costEstimate.tokens.totalMax) || 0), 0)
  const costEstimate = { units, pointsMin, pointsMax, tokensMin, tokensMax, perEpisode: previews.map((item) => ({ episode: item.episode, count: item.count || 0, points: item.costEstimate ? item.costEstimate.points : null })) }

  let blocked = null
  if (episodes.length > caps.maxEpisodes) {
    blocked = { reason: 'over-max-episodes', detail: `请求 ${episodes.length} 集，超过批量集数上限 ${caps.maxEpisodes}` }
  } else if (caps.maxPoints != null && pointsMax > caps.maxPoints) {
    blocked = { reason: 'over-batch-points', detail: `批量预估积分 ${pointsMax}，超过批量上限 ${caps.maxPoints}` }
  } else if (!previewable.length) {
    blocked = { reason: 'no-previewable-episode', detail: '所有集都无法规划（缺分镜/台词等），请先补齐再批量生成' }
  } else {
    const projectGate = await generation.checkBudget(root, title, pointsMax)
    if (!projectGate.ok) blocked = { reason: projectGate.reason || 'over-budget', detail: projectGate.detail || '项目预算不足' }
  }

  const trace = {
    schemaVersion: 1,
    batchId,
    title,
    kind,
    backend: String(input.backend),
    model: input.model || null,
    input: { episodes, caps, shots: Array.isArray(input.shots) ? input.shots : null, estimatePerUnitPoints: input.estimatePerUnitPoints == null ? null : Number(input.estimatePerUnitPoints) },
    rounds,
    createdAt: (previous && previous.createdAt) || now,
    updatedAt: now,
    resumed: Boolean(previous),
    status: blocked ? 'blocked' : 'planned',
    blocked,
    costEstimate,
    episodes: [],
    tasks: { count: 0, byEpisode: {} },
    artifacts: [],
    consistency: null,
  }

  if (!blocked) {
    // ② 逐集串行登记任务（record:false 时不登记，仅给出计划）
    for (const episode of episodes) {
      const preview = previews.find((item) => item.episode === episode)
      if (!preview || preview.status !== 'previewed') {
        trace.episodes.push({ episode, status: 'blocked', error: preview ? preview.error : '无法规划', trace: { plan: { round: rounds, plannedAt: now, previewError: preview ? preview.error : null } } })
        continue
      }
      try {
        const plan = await planEpisode(root, title, {
          ...input,
          episode,
          kind,
          record,
          operationId: `${batchId}:E${episode}`,
        })
        const prior = previous && Array.isArray(previous.episodes) ? previous.episodes.find((item) => Number(item.episode) === episode) : null
        const tasks = plan.tasks.map((task) => ({ taskId: task.id, shot: task.shot, operationId: task.operationId || null }))
        trace.tasks.count += tasks.length
        trace.tasks.byEpisode[episode] = tasks.length
        const priorStatus = prior && ['submitted', 'collected', 'partial', 'failed', 'deferred'].includes(prior.status) ? prior.status : 'planned'
        trace.episodes.push({
          episode,
          status: priorStatus,
          count: plan.count,
          estimatePoints: plan.estimatePoints,
          costEstimate: plan.costEstimate,
          tasks,
          trace: {
            ...((prior && prior.trace) || {}),
            plan: {
              round: rounds,
              model: plan.model || input.model || null,
              backend: String(input.backend),
              startedAt: now,
              durationMs: preview.durationMs,
              costEstimate: plan.costEstimate,
            },
          },
        })
      } catch (error) {
        trace.episodes.push({ episode, status: 'blocked', error: error instanceof Error ? error.message : String(error), trace: { plan: { round: rounds, plannedAt: now } } })
      }
    }
    trace.tasks.count = trace.episodes.reduce((sum, item) => sum + ((item.tasks && item.tasks.length) || 0), 0)
  } else {
    trace.episodes = previews.map((item) => ({ episode: item.episode, status: 'blocked', count: item.count || 0, error: blocked.detail, trace: { plan: { round: rounds, startedAt: now, previewError: item.error || null } } }))
    trace.blocked = blocked
  }

  const saved = await generation.saveBatchTrace(root, title, trace)
  return {
    batchId,
    status: saved.status,
    resumed: saved.resumed,
    rounds,
    caps,
    blocked: saved.blocked,
    costEstimate: saved.costEstimate,
    episodes: saved.episodes.map((item) => ({ episode: item.episode, status: item.status, count: item.count || 0, estimatePoints: item.estimatePoints || 0, tasks: (item.tasks || []).length, error: item.error || null })),
    totals: { episodes: saved.episodes.length, units: saved.costEstimate.units, pointsMin: saved.costEstimate.pointsMin, pointsMax: saved.costEstimate.pointsMax, tokensMin: saved.costEstimate.tokensMin, tokensMax: saved.costEstimate.tokensMax },
    traceFile: generation.batchPaths(root, title, batchId).traceFile,
  }
}

/** 串行提交 N 集批次（只补 planned/failed；done/submitted/running 跳过 → 中断续跑幂等）。 */
export async function submitBatchEpisodes(root, title, input = {}) {
  const batchId = generation.assertSafeBatchId(String(input.batchId || ''))
  const trace = await generation.getBatchTrace(root, title, batchId)
  if (trace.status === 'blocked') throw new Error(`批量 ${batchId} 已因超限被拦截：${(trace.blocked && trace.blocked.detail) || '超限'}`)
  const backendId = input.backend || trace.backend
  const backend = input.resolveBackend ? input.resolveBackend(backendId) : null
  if (!backend) throw new Error(`未知后端：${backendId}`)
  const filterEpisodes = normalizeBatchEpisodes(input)
  const caps = (trace.input && trace.input.caps) || normalizeBatchCaps({})
  const startedAll = Date.now()
  let submitted = 0
  let failed = 0
  const nowIso = () => new Date().toISOString()

  for (const episodeRecord of trace.episodes) {
    const episode = Number(episodeRecord.episode)
    if (filterEpisodes.length && !filterEpisodes.includes(episode)) continue
    if (!['planned', 'submitted', 'partial', 'failed', 'deferred'].includes(episodeRecord.status)) continue
    if (caps.maxDurationMs != null && Date.now() - startedAll >= caps.maxDurationMs) {
      episodeRecord.status = 'deferred'
      pushSubmitTrace(episodeRecord, { status: 'deferred', reason: 'duration-cap', at: nowIso(), durationMs: Date.now() - startedAll })
      continue
    }
    const allTasks = await generation.listTasks(root, title, { limit: 1000 })
    const prefix = batchEpisodePrefix(batchId, episode)
    const tasks = allTasks.filter((task) => Number(task.episode) === episode && String(task.operationId || '').startsWith(prefix))
    const done = tasks.filter((task) => task.status === 'done').length
    const inFlight = tasks.filter((task) => task.status === 'submitted' || task.status === 'running').length
    const pending = tasks.filter((task) => task.status === 'planned' || task.status === 'failed')
    const startedAt = Date.now()
    if (!tasks.length) {
      pushSubmitTrace(episodeRecord, { status: 'no-tasks', at: nowIso(), durationMs: 0 })
      continue
    }
    if (!pending.length) {
      pushSubmitTrace(episodeRecord, { status: 'idempotent', startedAt: nowIso(), durationMs: 0, submitted: 0, failed: 0, skippedDone: done, skippedInFlight: inFlight })
      if (done === tasks.length) episodeRecord.status = 'collected'
      else if (inFlight > 0) episodeRecord.status = 'submitted'
      continue
    }
    const items = pending.map((task) => ({
      taskId: task.id,
      name: task.externalId || `E${String(episode).padStart(3, '0')}-${(task.shots && task.shots[0]) || 'VO'}`,
      prompt: task.prompt,
      params: { model: task.model },
    }))
    const result = await submitBatch(root, title, { ...input, backend: backendId, kind: episodeRecord.trace && episodeRecord.trace.plan ? trace.kind : trace.kind, items })
    submitted += result.submitted
    failed += result.failed
    const attempts = result.results.reduce((sum, item) => sum + (Number(item.attempts) || 1), 0)
    episodeRecord.status = result.failed ? (result.submitted ? 'partial' : 'failed') : 'submitted'
    pushSubmitTrace(episodeRecord, {
      status: episodeRecord.status,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: nowIso(),
      durationMs: Date.now() - startedAt,
      submitted: result.submitted,
      failed: result.failed,
      attempts,
      skippedDone: done,
      skippedInFlight: inFlight,
      next: result.failed ? '可再次调用 submit-batch 续跑（只补失败项）' : null,
    })
  }

  const anyDeferred = trace.episodes.some((item) => item.status === 'deferred')
  const anyFailed = trace.episodes.some((item) => item.status === 'failed' || item.status === 'partial')
  const allCollected = trace.episodes.length > 0 && trace.episodes.every((item) => item.status === 'collected')
  trace.status = allCollected ? 'collected' : anyFailed ? 'partial' : anyDeferred ? 'partial' : 'submitted'
  if (input.backend) trace.backend = String(input.backend)
  const saved = await generation.saveBatchTrace(root, title, trace)
  return {
    batchId,
    status: saved.status,
    submitted,
    failed,
    idempotent: submitted === 0 && failed === 0,
    stoppedBy: anyDeferred ? 'duration-cap' : null,
    episodes: saved.episodes.map((item) => ({ episode: item.episode, status: item.status, submit: item.trace ? item.trace.submit || null : null })),
    trace: saved,
  }
}

/**
 * 串行收敛 N 集批次：产物先落 `.aidrama/batches/<batchId>/staging/` 草稿区并生成 pending 草稿，
 * 用户经既有 draft-resolve 采纳后才进 `素材/生成/`；收敛后做逐集一致性检查并写溯源。
 */
export async function collectBatchEpisodes(root, title, input = {}) {
  const batchId = generation.assertSafeBatchId(String(input.batchId || ''))
  const trace = await generation.getBatchTrace(root, title, batchId)
  if (trace.status === 'blocked') throw new Error(`批量 ${batchId} 已因超限被拦截：${(trace.blocked && trace.blocked.detail) || '超限'}`)
  const backendId = input.backend || trace.backend
  const backend = input.resolveBackend ? input.resolveBackend(backendId) : null
  if (!backend) throw new Error(`未知后端：${backendId}`)
  const caps = (trace.input && trace.input.caps) || normalizeBatchCaps({})
  const filterEpisodes = normalizeBatchEpisodes(input)
  const { stagingDir } = generation.batchPaths(root, title, batchId)
  const projectDirPath = store.projectDir(root, title)
  await store.guardedProjectMkdir(projectDirPath, path.relative(projectDirPath, stagingDir).split(path.sep).join('/'))
  const startedAll = Date.now()
  let collected = 0
  let pending = 0
  let failed = 0
  const nowIso = () => new Date().toISOString()

  for (const episodeRecord of trace.episodes) {
    const episode = Number(episodeRecord.episode)
    if (filterEpisodes.length && !filterEpisodes.includes(episode)) continue
    if (!['submitted', 'partial', 'failed', 'collected'].includes(episodeRecord.status)) continue
    if (caps.maxDurationMs != null && Date.now() - startedAll >= caps.maxDurationMs) {
      pushCollectTrace(episodeRecord, { status: 'deferred', reason: 'duration-cap', at: nowIso() })
      continue
    }
    const allTasks = await generation.listTasks(root, title, { limit: 1000 })
    const prefix = batchEpisodePrefix(batchId, episode)
    const tasks = allTasks.filter((task) => Number(task.episode) === episode && String(task.operationId || '').startsWith(prefix))
    const collectable = tasks.filter((task) => task.status === 'submitted' || task.status === 'running')
    const startedAt = Date.now()
    if (!collectable.length) {
      pushCollectTrace(episodeRecord, { status: 'idempotent', at: nowIso(), durationMs: 0, collected: 0 })
      if (episodeRecord.status !== 'collected') episodeRecord.status = 'collected'
      continue
    }
    const stagedArtifacts = []
    const artifactSink = async ({ file, task }) => {
      const staged = await generation.stageBatchArtifact(root, title, batchId, file, {
        episode: Number(task.episode),
        shotNumber: (task.shots && task.shots[0]) || null,
        taskId: task.id,
        kind: task.kind,
      })
      const draft = await drafts.createDraft(projectDirPath, {
        kind: 'batch-artifact',
        title: `批量生成·第${task.episode}集·${(task.shots && task.shots[0]) || 'VO'}`,
        order: Number(task.episode),
        content: JSON.stringify({
          batchId,
          draftKind: 'batch-artifact',
          stagedRelative: staged.stagedRelative,
          bytes: staged.bytes,
          sha256: staged.sha256,
          target: {
            batchId,
            kind: task.kind,
            episode: Number(task.episode),
            shots: task.shots || [],
            backend: task.backend,
            model: task.model || null,
            taskId: task.id,
          },
        }),
        note: `批量 ${batchId} 生成产物（采纳后才入 素材/生成）`,
        origin: { model: task.model || '', toolName: 'collect-batch', callId: batchId },
      })
      trace.artifacts.push({
        episode: Number(task.episode),
        taskId: task.id,
        draftId: draft.id,
        stagedRelative: staged.stagedRelative,
        bytes: staged.bytes,
        sha256: staged.sha256,
        adopted: false,
        createdAt: nowIso(),
      })
      stagedArtifacts.push({ draftId: draft.id, stagedRelative: staged.stagedRelative, bytes: staged.bytes, sha256: staged.sha256, episode: Number(task.episode) })
      return { relative: staged.stagedRelative, staged: true, draftId: draft.id, bytes: staged.bytes, sha256: staged.sha256 }
    }
    const result = await collectBatch(root, title, {
      ...input,
      backend: backendId,
      outDir: stagingDir,
      artifactSink,
      taskIds: collectable.map((task) => task.id),
      episode,
      checkDrift: false,
    })
    collected += result.collected
    pending += result.pending
    failed += result.failed
    episodeRecord.status = result.failed > 0 ? 'partial' : result.collected > 0 ? 'collected' : 'submitted'
    pushCollectTrace(episodeRecord, {
      status: episodeRecord.status,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: nowIso(),
      durationMs: Date.now() - startedAt,
      collected: result.collected,
      pending: result.pending,
      failed: result.failed,
      artifacts: stagedArtifacts,
      idempotent: false,
    })
  }

  // 逐集一致性（确定性规则，复用 checkConsistency）
  let consistency = null
  try {
    const report = await checkConsistency(root, title)
    consistency = summarizeBatchConsistency(report, trace.episodes.map((item) => Number(item.episode)))
  } catch (error) {
    consistency = { score: 0, passedEpisodes: 0, totalEpisodes: trace.episodes.length, error: error instanceof Error ? error.message : String(error), byEpisode: {}, global: { issues: [] } }
  }
  trace.consistency = consistency
  const anyIncomplete = trace.episodes.some((item) => item.status === 'submitted' || item.status === 'partial' || item.status === 'failed')
  trace.status = anyIncomplete ? 'partial' : 'collected'
  const saved = await generation.saveBatchTrace(root, title, trace)
  return {
    batchId,
    status: saved.status,
    collected,
    pending,
    failed,
    idempotent: collected === 0 && pending === 0 && failed === 0,
    drafts: saved.artifacts.filter((item) => !item.adopted).map((item) => ({ draftId: item.draftId, episode: item.episode, stagedRelative: item.stagedRelative, bytes: item.bytes })),
    consistency: saved.consistency,
    episodes: saved.episodes.map((item) => ({ episode: item.episode, status: item.status, collect: item.trace ? item.trace.collect || null : null })),
    trace: saved,
    traceFile: generation.batchPaths(root, title, batchId).traceFile,
  }
}

