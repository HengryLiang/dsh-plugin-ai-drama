/**
 * v0.11.1（task-96 / 2-2 一期）：场景卡纯函数（无 I/O、无时间戳、确定性）。
 *
 * 场景卡 `.aidrama/scenes/cards.json`（单文件、schemaVersion、按 id 排序）：
 *   { id:'SPCxxx', name, description, space:{location,timeOfDay,weather,interior},
 *     lighting, assetRefs:[资产ID], emotionBaseline:{label,intensity}|null, notes }
 *
 * 铁律（Lead 批准）：
 * - **零相机锁合**：场景卡不得含任何镜头参数；出现显式禁字段集合
 *   camera/cameraMove/lens/shotSize/framing/shotNumber/transitionToNext/poses（不区分大小写）→ 校验拒绝；
 * - 编号仅 `SPCxxx` 基号（001–999），无变体；复用 2-1 资产编号体系；
 * - space.interior 枚举：内景|外景|内外景；
 * - 本模块不接入生成/渲染（二期）。
 */
import { isValidAssetId, normalizeAssetId, normalizeImportedFrom, normalizeReview } from './assets.js'

/** 场景编号：SPC + 3 位序号（001–999），无变体。 */
export const SCENE_ID_PATTERN = /^SPC[0-9]{3}$/

/** 零相机锁合：出现以下字段（不区分大小写）即拒绝写入/读取报错。 */
export const FORBIDDEN_CAMERA_KEYS = ['camera', 'cameramove', 'lens', 'shotsize', 'framing', 'shotnumber', 'transitiontonext', 'poses']

/** space.interior 枚举。 */
export const SCENE_INTERIORS = ['内景', '外景', '内外景']

const SCENE_LIMITS = { name: 120, description: 1000, lighting: 500, notes: 500, location: 120, timeOfDay: 40, weather: 40 }

export function normalizeSceneId(input) {
  if (typeof input !== 'string') return ''
  return input.trim().toUpperCase()
}

export function isValidSceneId(id) {
  const normalized = normalizeSceneId(id)
  if (!SCENE_ID_PATTERN.test(normalized)) return false
  return Number(normalized.slice(3)) >= 1
}

/** 生成下一个可用场景编号（SPC + 最大序号 +1，从 001 起）。 */
export function nextSceneId(existingIds) {
  let maxSequence = 0
  for (const id of Array.isArray(existingIds) ? existingIds : []) {
    const normalized = normalizeSceneId(id)
    if (!isValidSceneId(normalized)) continue
    const sequence = Number(normalized.slice(3))
    if (sequence > maxSequence) maxSequence = sequence
  }
  const next = maxSequence + 1
  if (next > 999) throw new Error('场景编号已用尽（上限 999）')
  return `SPC${String(next).padStart(3, '0')}`
}

/** 递归扫描禁字段（不区分大小写）：返回命中的路径列表。 */
export function findForbiddenCameraKeys(input, basePath = '') {
  const hits = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) return hits
  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = String(key).trim().toLowerCase()
    const path = basePath ? `${basePath}.${key}` : key
    if (FORBIDDEN_CAMERA_KEYS.includes(normalizedKey)) hits.push(path)
    if (value && typeof value === 'object' && !Array.isArray(value)) hits.push(...findForbiddenCameraKeys(value, path))
  }
  return hits
}

function clip(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max)
}

function normalizeSpace(space) {
  const raw = space && typeof space === 'object' && !Array.isArray(space) ? space : {}
  return {
    location: clip(raw.location, SCENE_LIMITS.location),
    timeOfDay: clip(raw.timeOfDay, SCENE_LIMITS.timeOfDay),
    weather: clip(raw.weather, SCENE_LIMITS.weather),
    interior: clip(raw.interior, 10),
  }
}

function normalizeEmotionBaseline(emotion) {
  if (!emotion || typeof emotion !== 'object' || Array.isArray(emotion)) return null
  const label = clip(emotion.label, 40)
  const intensity = Number(emotion.intensity)
  if (!label || !Number.isFinite(intensity) || intensity < 0 || intensity > 100) return null
  return { label, intensity: Math.round(intensity) }
}

/**
 * 场景卡归一（幂等、确定性；不含 version/history/时间戳）。
 * 未知顶层字段丢弃（写入前 validate 已拦截禁字段）。
 */
export function normalizeSceneCard(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const assetRefs = []
  for (const item of Array.isArray(raw.assetRefs) ? raw.assetRefs : []) {
    const id = normalizeAssetId(item)
    if (id && isValidAssetId(id) && !assetRefs.includes(id)) assetRefs.push(id)
  }
  const importedFrom = normalizeImportedFrom(raw.importedFrom)
  const review = normalizeReview(raw.review)
  return {
    id: normalizeSceneId(raw.id),
    name: clip(raw.name, SCENE_LIMITS.name),
    description: clip(raw.description, SCENE_LIMITS.description),
    space: normalizeSpace(raw.space),
    lighting: clip(raw.lighting, SCENE_LIMITS.lighting),
    assetRefs,
    emotionBaseline: normalizeEmotionBaseline(raw.emotionBaseline),
    notes: clip(raw.notes, SCENE_LIMITS.notes),
    // C3（E16/H-8）：审核状态 add-only（旧卡无 review → 输出字节不变）
    ...(review ? { review } : {}),
    // v0.16.8（task-151 / I5-1）：跨项目复制溯源 add-only（旧卡无字段 → 输出字节不变）
    ...(importedFrom ? { importedFrom } : {}),
  }
}

/**
 * 校验原始输入（写入/读取前）：返回错误字符串数组。
 * - 必填 id/name；id 格式；零相机锁合；space.interior 枚举；assetRefs 编号格式；emotionBaseline 结构。
 */
export function validateSceneCard(raw) {
  const errors = []
  const input = raw && typeof raw === 'object' ? raw : {}
  const forbidden = findForbiddenCameraKeys(input)
  if (forbidden.length) errors.push(`场景卡不得包含镜头参数（零相机锁合）：${forbidden.join('、')}`)
  const id = normalizeSceneId(input.id)
  if (!id) errors.push('场景卡缺少 id')
  else if (!isValidSceneId(id)) errors.push(`场景编号非法：${input.id}（应为 SPC+3 位序号，如 SPC001）`)
  if (!String(input.name == null ? '' : input.name).trim()) errors.push('场景卡缺少 name')
  const space = input.space && typeof input.space === 'object' && !Array.isArray(input.space) ? input.space : {}
  if (space.interior != null && String(space.interior).trim() && !SCENE_INTERIORS.includes(String(space.interior).trim())) {
    errors.push(`space.interior 非法：${space.interior}（只能是 ${SCENE_INTERIORS.join('/')}）`)
  }
  if (input.emotionBaseline != null) {
    const normalized = normalizeEmotionBaseline(input.emotionBaseline)
    if (!normalized) errors.push('emotionBaseline 必须是 { label:string, intensity:0~100 }')
  }
  const refs = Array.isArray(input.assetRefs) ? input.assetRefs : []
  for (const ref of refs) {
    const id = normalizeAssetId(ref)
    if (!isValidAssetId(id)) errors.push(`assetRefs 中的资产编号非法：${ref}`)
  }
  return errors
}

/** 按 id 稳定排序。 */
export function sortScenes(scenes) {
  return (Array.isArray(scenes) ? scenes.slice() : []).sort((a, b) => String(a.id).localeCompare(String(b.id), 'en'))
}

/** 构造权威索引对象（v1 无时间戳；scenes 按 id 排序）。 */
export function buildSceneIndex(scenes) {
  return { schemaVersion: 1, scenes: sortScenes(scenes.map((scene) => normalizeSceneCard(scene))) }
}

/** 读取兼容：接受 {schemaVersion,scenes} 或裸数组。 */
export function normalizeSceneIndex(data) {
  const list = Array.isArray(data) ? data : data && Array.isArray(data.scenes) ? data.scenes : []
  return buildSceneIndex(list)
}

/**
 * 引用校验（本卡仅 API，不接入 checks）：孤儿 sceneRef / 场景 assetRefs 缺失 → WARN 列表。
 * @param {{scenes?:Array, shotsByEpisode?:Array, assetIds?:string[]}} input
 */
export function checkSceneReferences({ scenes = [], shotsByEpisode = [], assetIds = null } = {}) {
  const knownScenes = new Set((Array.isArray(scenes) ? scenes : []).map((scene) => normalizeSceneId(scene && scene.id)).filter(Boolean))
  const knownAssets = Array.isArray(assetIds) ? new Set(assetIds.map((id) => normalizeAssetId(id)).filter(Boolean)) : null
  const warnings = []
  for (const item of Array.isArray(shotsByEpisode) ? shotsByEpisode : []) {
    for (const shot of Array.isArray(item.shots) ? item.shots : []) {
      const sceneRef = normalizeSceneId(shot && shot.sceneRef)
      if (sceneRef && !knownScenes.has(sceneRef)) {
        warnings.push({
          code: 'scene-reference-missing',
          sceneRef,
          episode: item.order,
          shotNumber: shot.shotNumber || '',
          message: `分镜 ${shot.shotNumber || '?'}（第 ${item.order} 集）引用不存在的场景卡：${sceneRef}`,
        })
      }
    }
  }
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    const sceneId = normalizeSceneId(scene && scene.id)
    for (const assetId of Array.isArray(scene && scene.assetRefs) ? scene.assetRefs : []) {
      const normalized = normalizeAssetId(assetId)
      if (knownAssets && !knownAssets.has(normalized)) {
        warnings.push({
          code: 'scene-asset-missing',
          sceneId,
          assetId: normalized,
          message: `场景卡 ${sceneId} 引用的资产不存在：${normalized}`,
        })
      }
    }
  }
  return { ok: warnings.length === 0, warnings }
}
