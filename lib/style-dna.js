/**
 * v0.11.1（task-96 / 2-2 一期）：五维精简风格 DNA 纯函数（无 I/O、无时间戳、无注入）。
 *
 * 剧集级 `.aidrama/style.json`：
 *   { schemaVersion:1, style:{ palette, lighting, texture, composition, motion } }
 * - 每维 1–2 句、≤300 字；缺省维度为空串；
 * - 写时多余额外维度拒绝（invalid-args）；读时未知维度忽略（不报错）；
 * - **本卡只存储/读取，不参与生成/渲染注入**（二期）。
 */

export const STYLE_DIMENSIONS = ['palette', 'lighting', 'texture', 'composition', 'motion']

export const STYLE_DIMENSION_LABELS = {
  palette: '色板',
  lighting: '光感',
  texture: '质感',
  composition: '构图偏好',
  motion: '运镜节奏',
}

/** 单维长度上限（字符）。 */
export const STYLE_TEXT_LIMIT = 300

function normalizeDimensionText(value) {
  return String(value == null ? '' : value).trim().slice(0, STYLE_TEXT_LIMIT)
}

/** 归一五维 DNA：只保留五维、缺省为空串；忽略未知维度（读取/写入前均适用）。 */
export function normalizeStyleDNA(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const dna = {}
  for (const dimension of STYLE_DIMENSIONS) dna[dimension] = normalizeDimensionText(raw[dimension])
  return dna
}

/**
 * 写时校验（返回错误字符串数组）：
 * - 输入必须是对象；
 * - 出现五维之外字段 → 拒绝（写时多余额外维度拒绝）；
 * - 已提供维度必须是字符串且 ≤300 字（trim 后）。
 */
export function validateStyleDNA(input) {
  const errors = []
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : null
  if (!raw) return ['style DNA 必须是对象 { palette, lighting, texture, composition, motion }']
  for (const key of Object.keys(raw)) {
    if (!STYLE_DIMENSIONS.includes(key)) errors.push(`style DNA 不支持维度：${key}（只允许 ${STYLE_DIMENSIONS.join('/')}）`)
  }
  for (const dimension of STYLE_DIMENSIONS) {
    const value = raw[dimension]
    if (value == null) continue
    if (typeof value !== 'string') {
      errors.push(`style.${dimension} 必须是字符串`)
      continue
    }
    if (value.trim().length > STYLE_TEXT_LIMIT) errors.push(`style.${dimension} 超长（${value.trim().length} > ${STYLE_TEXT_LIMIT} 字）`)
  }
  return errors
}

/** 构造权威 style.json 对象（无时间戳；五维固定顺序）。 */
export function buildStyleDoc(dna) {
  return { schemaVersion: 1, style: normalizeStyleDNA(dna) }
}

/** 读取兼容：接受 {schemaVersion,style} 或裸五维对象（未知维度忽略）。 */
export function normalizeStyleDoc(data) {
  const raw = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const source = raw.style && typeof raw.style === 'object' ? raw.style : raw
  return buildStyleDoc(source)
}
