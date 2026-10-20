/**
 * v0.10.2（task-86 / B1-A）：创作质量判据骨架（写作侧）。
 *
 * 本卡范围：**提供可运行判定函数 + 与 rules 同源**，但**不接入 runDeterministicChecks**
 * （task-88 再接入 8 条判据）；每条判定返回统一的 judge 结果对象，接入时直接映射为 check item。
 *
 * 判定结果形状（与 checks.js 分级 schema 对齐）：
 *   { id, label, category:'criteria', severity:'warn', ok, skipped, detail, where, code }
 * - skipIfMissing=true：所需输入字段整体缺失/为空 → skipped=true、ok=true（灰度，不误报旧项目）；
 * - 全部首批判据默认 severity='warn'（不阻断 strict）。
 */
import { loadRuleSet, findJudge } from './criteria-rules.js'

/** 本模块负责的判据（写作侧：提示词可观测性/正负表述/一镜一事）。 */
export const PROMPT_DISCIPLINE_JUDGE_IDS = ['PD-01', 'PD-06', 'PD-08']

function baseResult(judge, { ok, skipped = false, detail = '', where = '' }) {
  return {
    id: judge.id,
    label: judge.name,
    category: judge.category || 'criteria',
    severity: judge.severityDefault || 'warn',
    ok: Boolean(ok),
    skipped: Boolean(skipped),
    detail: String(detail || ''),
    where: String(where || ''),
    code: judge.code || '',
  }
}

/** 镜头文本拼接（description 优先，naturalLanguagePrompt 兜底/补充）。 */
export function shotTextOf(shot) {
  const parts = []
  if (shot && typeof shot.description === 'string' && shot.description.trim()) parts.push(shot.description.trim())
  if (shot && typeof shot.naturalLanguagePrompt === 'string' && shot.naturalLanguagePrompt.trim() && shot.naturalLanguagePrompt.trim() !== parts[0]) {
    parts.push(shot.naturalLanguagePrompt.trim())
  }
  return parts.join('\n')
}

function hasAnyText(shots) {
  return shots.some((shot) => shotTextOf(shot).length > 0)
}

/** PD-01 可观测性：命中修辞黑名单/模式 → WARN。 */
export function evaluateObservability({ shots, ruleSet }) {
  const judge = findJudge(ruleSet, 'PD-01')
  if (!judge) throw new Error('rules 缺少 PD-01 定义')
  if (!shots.length || !hasAnyText(shots)) return baseResult(judge, { ok: true, skipped: true, detail: '分镜文本缺失，跳过（存量灰度）', where: '分镜提示词' })
  const words = ruleSet.rhetoric?.words || []
  const patterns = (ruleSet.rhetoric?.patterns || []).map((item) => ({ ...item, regex: new RegExp(item.pattern) }))
  const violations = []
  for (const shot of shots) {
    const text = shotTextOf(shot)
    if (!text) continue
    const hits = []
    for (const word of words) if (text.includes(word)) hits.push(word)
    for (const item of patterns) if (item.regex.test(text)) hits.push(item.message)
    if (hits.length) violations.push({ shotNumber: shot.shotNumber || '?', hits })
  }
  const detail = violations.length
    ? violations.slice(0, 5).map((item) => `${item.shotNumber}：${item.hits.slice(0, 3).join('、')}${item.hits.length > 3 ? '…' : ''}`).join('；')
    : '未命中修辞黑名单'
  return baseResult(judge, { ok: violations.length === 0, detail, where: '分镜提示词' })
}

/** PD-06 正负打架：行为/时序语境出现负向词 → WARN（风格排除语境豁免）。 */
export function evaluatePositiveNegative({ shots, ruleSet }) {
  const judge = findJudge(ruleSet, 'PD-06')
  if (!judge) throw new Error('rules 缺少 PD-06 定义')
  if (!shots.length || !hasAnyText(shots)) return baseResult(judge, { ok: true, skipped: true, detail: '分镜文本缺失，跳过（存量灰度）', where: '分镜提示词' })
  const negative = ruleSet.positiveNegative?.negative || []
  const styleWords = ruleSet.positiveNegative?.styleContextKeywords || []
  const behaviorWords = ruleSet.positiveNegative?.behaviorContextKeywords || []
  const violations = []
  for (const shot of shots) {
    const text = shotTextOf(shot)
    if (!text) continue
    for (const sentence of text.split(/[。；\n]/)) {
      const line = sentence.trim()
      if (!line) continue
      const hasNegative = negative.some((word) => line.includes(word))
      if (!hasNegative) continue
      const isStyle = styleWords.some((word) => line.includes(word))
      const isBehavior = behaviorWords.some((word) => line.includes(word))
      if (isBehavior && !isStyle) violations.push({ shotNumber: shot.shotNumber || '?', sentence: line.slice(0, 60) })
    }
  }
  const detail = violations.length
    ? violations.slice(0, 5).map((item) => `${item.shotNumber}：${item.sentence}`).join('；')
    : '未发现行为/时序语境负向词'
  return baseResult(judge, { ok: violations.length === 0, detail, where: '分镜提示词' })
}

/** PD-08 一镜一事：单镜动作事件数 > 阈值 → WARN。 */
export function evaluateOneEventPerShot({ shots, ruleSet }) {
  const judge = findJudge(ruleSet, 'PD-08')
  if (!judge) throw new Error('rules 缺少 PD-08 定义')
  if (!shots.length || !hasAnyText(shots)) return baseResult(judge, { ok: true, skipped: true, detail: '分镜文本缺失，跳过（存量灰度）', where: '分镜提示词' })
  const verbs = ruleSet.thresholds?.eventVerbs || []
  const maxActions = Number(ruleSet.thresholds?.maxActionsPerShot) || 2
  const violations = []
  for (const shot of shots) {
    const text = shotTextOf(shot)
    if (!text) continue
    let count = 0
    for (const verb of verbs) {
      let index = 0
      while ((index = text.indexOf(verb, index)) !== -1) { count += 1; index += verb.length }
    }
    if (count > maxActions) violations.push({ shotNumber: shot.shotNumber || '?', count })
  }
  const detail = violations.length
    ? violations.slice(0, 5).map((item) => `${item.shotNumber}：约 ${item.count} 个动作事件（阈值 ${maxActions}）`).join('；')
    : `单镜动作事件均 ≤ ${maxActions}`
  return baseResult(judge, { ok: violations.length === 0, detail, where: '分镜提示词' })
}

const EVALUATORS = {
  'PD-01': evaluateObservability,
  'PD-06': evaluatePositiveNegative,
  'PD-08': evaluateOneEventPerShot,
}

/**
 * 运行本模块负责的判据（骨架入口；task-88 前不接入 runDeterministicChecks）。
 * @returns {Promise<Array>} judge 结果数组（顺序同 PROMPT_DISCIPLINE_JUDGE_IDS）
 */
export async function runPromptDisciplineChecks({ shots = [], ruleSet = null } = {}) {
  const rules = ruleSet || (await loadRuleSet())
  return PROMPT_DISCIPLINE_JUDGE_IDS.map((id) => EVALUATORS[id]({ shots, ruleSet: rules }))
}
