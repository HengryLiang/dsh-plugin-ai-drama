/**
 * v0.11.0（task-94 / 2-3）：资产质量门禁 evaluator（纯函数，无 I/O、无时间戳、确定性）。
 *
 * 规则定义单一源：`presets/rules/assets.json`（经 lib/criteria-rules.js 加载，无 JS 镜像）。
 * - 全部 severity='warn'、category='criteria'、skipIfMissing=true、不阻断 strict；
 * - 无资产卡（cards=0）→ 6 条全 SKIP（灰度，旧项目零噪声）；
 * - 资产门禁绝不产生 FAIL（failed 只来自结构项）。
 */
import {
  isValidAssetId,
  normalizeAssetId,
  normalizeAssetStatus,
  parseAssetPlaceholders,
  splitAssetId,
  matchAssetIdsInText,
} from './assets.js'

export const ASSET_JUDGE_IDS = ['AST-01', 'AST-02', 'AST-03', 'AST-04', 'AST-05', 'AST-06', 'AST-07']

function judgeOf(ruleSet, id) {
  const judges = ruleSet && Array.isArray(ruleSet.assetJudges) ? ruleSet.assetJudges : []
  return judges.find((judge) => judge.id === id) || null
}

function baseResult(judge, { ok, skipped = false, detail = '', where = '资产卡' }) {
  return {
    id: judge.id,
    label: judge.name,
    category: 'criteria',
    severity: 'warn',
    ok: Boolean(ok),
    skipped: Boolean(skipped),
    detail: String(detail || ''),
    where,
    code: judge.code || '',
  }
}

function skippedResult(judge, detail = '无资产卡，跳过（灰度）') {
  return baseResult(judge, { ok: true, skipped: true, detail })
}

function cardIdOf(card, index) {
  const id = normalizeAssetId(card && card.id)
  return id || `第 ${index + 1} 张卡`
}

/** AST-01 必填字段：id/type/name 缺失（手改 JSON 场景）。 */
export function evaluateAssetRequired({ cards, ruleSet }) {
  const judge = judgeOf(ruleSet, 'AST-01')
  if (!judge) return null
  if (!cards.length) return skippedResult(judge)
  const violations = []
  cards.forEach((card, index) => {
    const id = normalizeAssetId(card && card.id)
    const missing = []
    if (!id) missing.push('id')
    if (!String(card && card.type ? card.type : '').trim()) missing.push('type')
    if (!String(card && card.name ? card.name : '').trim()) missing.push('name')
    if (missing.length) violations.push(`${cardIdOf(card, index)} 缺 ${missing.join('/')}`)
  })
  return baseResult(judge, {
    ok: violations.length === 0,
    detail: violations.length ? `资产必填字段：${violations.slice(0, 5).join('；')}` : '资产卡 id/type/name 均完整',
  })
}

/** AST-02 编号非法：id 格式 / type 与前缀不一致 / type 枚举。 */
export function evaluateAssetIdFormat({ cards, ruleSet }) {
  const judge = judgeOf(ruleSet, 'AST-02')
  if (!judge) return null
  if (!cards.length) return skippedResult(judge)
  const violations = []
  for (const card of cards) {
    const id = normalizeAssetId(card && card.id)
    if (!id) continue // AST-01 负责
    if (!isValidAssetId(id)) {
      violations.push(`${id}（编号格式非法）`)
      continue
    }
    const parts = splitAssetId(id)
    const type = String(card && card.type ? card.type : '').trim().toUpperCase()
    if (type && parts && type !== parts.prefix) violations.push(`${id}（type=${type} 与前缀 ${parts.prefix} 不一致）`)
  }
  return baseResult(judge, {
    ok: violations.length === 0,
    detail: violations.length ? `资产编号非法：${violations.slice(0, 5).join('；')}` : '资产编号与 type 均合法',
  })
}

/** AST-03 重复 ID。 */
export function evaluateAssetDuplicateId({ cards, ruleSet }) {
  const judge = judgeOf(ruleSet, 'AST-03')
  if (!judge) return null
  if (!cards.length) return skippedResult(judge)
  const counts = new Map()
  for (const card of cards) {
    const id = normalizeAssetId(card && card.id)
    if (!id) continue
    counts.set(id, (counts.get(id) || 0) + 1)
  }
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1)
  return baseResult(judge, {
    ok: duplicates.length === 0,
    detail: duplicates.length ? `重复 ID：${duplicates.slice(0, 5).map(([id, count]) => `${id}×${count}`).join('、')}` : '资产编号无重复',
  })
}

/** AST-04 重复 name（同类型、只比较 name，不含 aliases）。 */
export function evaluateAssetDuplicateName({ cards, ruleSet }) {
  const judge = judgeOf(ruleSet, 'AST-04')
  if (!judge) return null
  if (!cards.length) return skippedResult(judge)
  const buckets = new Map()
  for (const card of cards) {
    const id = normalizeAssetId(card && card.id)
    const name = String(card && card.name ? card.name : '').trim()
    const type = String(card && card.type ? card.type : '').trim().toUpperCase()
    if (!id || !name) continue
    const key = `${type}::${name}`
    const bucket = buckets.get(key) || { type, name, ids: [] }
    bucket.ids.push(id)
    buckets.set(key, bucket)
  }
  const duplicates = [...buckets.values()].filter((bucket) => bucket.ids.length > 1)
  return baseResult(judge, {
    ok: duplicates.length === 0,
    detail: duplicates.length
      ? `重复名称：${duplicates.slice(0, 5).map((bucket) => `${bucket.name}（${bucket.ids.join('、')}）`).join('；')}`
      : '同类型资产名称唯一',
  })
}

/** AST-05 孤儿引用：分镜文本/占位符/原生 ID（subject/groupId）引用了不存在的资产卡。 */
export function evaluateAssetOrphanReference({ cards, shotsByEpisode = [], ruleSet }) {
  const judge = judgeOf(ruleSet, 'AST-05')
  if (!judge) return null
  if (!cards.length) return skippedResult(judge, '无资产卡，跳过（灰度）')
  const known = new Set(cards.map((card) => normalizeAssetId(card && card.id)).filter(Boolean))
  const violations = []
  for (const item of Array.isArray(shotsByEpisode) ? shotsByEpisode : []) {
    for (const shot of Array.isArray(item.shots) ? item.shots : []) {
      const texts = [
        shot && shot.description,
        shot && shot.naturalLanguagePrompt,
        shot && shot.imagePrompt,
        shot && shot.videoPrompt,
        shot && shot.subject,
        shot && shot.groupId,
      ]
      const missing = new Set()
      for (const text of texts) {
        const source = String(text == null ? '' : text)
        for (const token of parseAssetPlaceholders(source)) {
          if (token.valid && !known.has(token.id)) missing.add(token.id)
        }
        for (const id of matchAssetIdsInText(source)) {
          if (!known.has(id)) missing.add(id)
        }
      }
      if (missing.size) {
        violations.push(`第 ${item.order} 集·${shot.shotNumber || '?'}：${[...missing].slice(0, 4).join('、')}`)
      }
    }
  }
  return baseResult(judge, {
    ok: violations.length === 0,
    detail: violations.length ? `孤儿引用：${violations.slice(0, 5).join('；')}` : '分镜引用的资产卡均存在',
    where: violations.length ? '分镜' : '资产卡',
  })
}

/** AST-06 variant 一致性：variantOf 缺失/指向不存在/指向变体/类型不一致；变体编号必须有基础卡。 */
export function evaluateAssetVariantConsistency({ cards, ruleSet }) {
  const judge = judgeOf(ruleSet, 'AST-06')
  if (!judge) return null
  if (!cards.length) return skippedResult(judge)
  const byId = new Map(cards.map((card) => [normalizeAssetId(card && card.id), card]).filter(([id]) => Boolean(id)))
  const violations = []
  for (const card of cards) {
    const id = normalizeAssetId(card && card.id)
    if (!id) continue
    const parts = splitAssetId(id)
    if (!parts) continue // AST-02 负责
    const variantOf = card && card.variantOf ? normalizeAssetId(card.variantOf) : ''
    if (parts.variant) {
      if (!variantOf) {
        violations.push(`${id}（变体缺少 variantOf）`)
        continue
      }
      const baseParts = splitAssetId(variantOf)
      if (!baseParts || baseParts.variant) {
        violations.push(`${id}（variantOf 不是基础编号：${variantOf}）`)
        continue
      }
      if (baseParts.baseId !== parts.baseId) {
        violations.push(`${id}（variantOf ${variantOf} 与变体基础编号 ${parts.baseId} 不一致）`)
        continue
      }
      const baseCard = byId.get(variantOf)
      if (!baseCard) {
        violations.push(`${id}（variantOf 引用的基础卡不存在：${variantOf}）`)
        continue
      }
      if (String(baseCard.type || '').toUpperCase() !== parts.prefix) {
        violations.push(`${id}（基础卡 ${variantOf} 类型 ${baseCard.type} 与变体前缀 ${parts.prefix} 不一致）`)
      }
    } else if (variantOf) {
      violations.push(`${id}（基础编号不应带 variantOf=${variantOf}）`)
    }
  }
  return baseResult(judge, {
    ok: violations.length === 0,
    detail: violations.length ? `variant 一致性：${violations.slice(0, 5).join('；')}` : 'variant 归属一致',
  })
}

/** AST-07 资产审核未完成（C3/E16；WARN 不阻断）：统计非 final 的卡（无 review 的旧卡计为未完成）。
 *  - 无卡（cards.length===0）→ 返回 null（不产生条目；旧项目检查输出不变）；
 *  - 有卡 → WARN，ok=全部 final；severity 由 rules JSON 单一源定义（severityDefault=warn）。 */
export function evaluateAssetReviewIncomplete({ cards, ruleSet }) {
  const judge = judgeOf(ruleSet, 'AST-07')
  if (!judge) return null
  if (!Array.isArray(cards) || cards.length === 0) return null
  const incomplete = []
  cards.forEach((card, index) => {
    const review = card && card.review && typeof card.review === 'object' ? card.review : null
    if (!review || review.status !== 'final') incomplete.push(cardIdOf(card, index))
  })
  return baseResult(judge, {
    ok: incomplete.length === 0,
    detail: incomplete.length
      ? `资产审核未完成：${incomplete.length} 张卡未定稿（${incomplete.slice(0, 5).join('、')}${incomplete.length > 5 ? ' 等' : ''}）`
      : '全部资产已定稿',
  })
}

const EVALUATORS = {
  'AST-01': evaluateAssetRequired,
  'AST-02': evaluateAssetIdFormat,
  'AST-03': evaluateAssetDuplicateId,
  'AST-04': evaluateAssetDuplicateName,
  'AST-05': evaluateAssetOrphanReference,
  'AST-06': evaluateAssetVariantConsistency,
  'AST-07': evaluateAssetReviewIncomplete,
}

/**
 * 运行 6 条资产门禁（顺序固定 AST-01…AST-06）。
 * @param {{cards?:Array, shotsByEpisode?:Array, ruleSet?:object}} input
 * @returns {Array} judge 结果（category=criteria / severity=warn；无资产卡时全 skipped）
 */
export function runAssetGates({ cards = [], shotsByEpisode = [], ruleSet = null } = {}) {
  return ASSET_JUDGE_IDS.map((id) => EVALUATORS[id]({ cards, shotsByEpisode, ruleSet })).filter(Boolean)
}
