/**
 * v0.10.2（task-86 / B1-A）：分镜连续性判据骨架（结构侧）。
 *
 * 本卡范围：提供可运行判定函数 + 与 rules 同源，但**不接入 runDeterministicChecks**
 * （task-88 再接入 8 条判据）。判定结果形状与 checks.js 分级 schema 对齐：
 *   { id, label, category:'criteria', severity:'warn', ok, skipped, detail, where, code }
 * - skipIfMissing=true：所需字段整体缺失 → skipped=true、ok=true（灰度，不误报旧项目）；
 * - 全部首批判据默认 severity='warn'（不阻断 strict）。
 */
import { loadRuleSet, findJudge } from './criteria-rules.js'

/** 本模块负责的判据（结构/连续性侧：景别接续/体态承接/每镜光影/现场声/焦段纪律）。 */
export const SHOT_CONTINUITY_JUDGE_IDS = ['PD-02', 'PD-03', 'PD-04', 'PD-05', 'PD-09']

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

function parseFocalMm(lens) {
  const match = String(lens || '').match(/([0-9]{1,3})\s*mm/i)
  return match ? Number(match[1]) : null
}

/** PD-02 景别接续：同主体相邻镜直接接相邻两级 → WARN（无 subject 字段时 skip 灰度）。 */
export function evaluateShotSizeContinuity({ shots, ruleSet }) {
  const judge = findJudge(ruleSet, 'PD-02')
  if (!judge) throw new Error('rules 缺少 PD-02 定义')
  const withSubject = shots.filter((shot) => typeof shot.subject === 'string' && shot.subject.trim())
  if (!withSubject.length) return baseResult(judge, { ok: true, skipped: true, detail: '分镜缺少 subject 字段，跳过（存量灰度）', where: '分镜' })
  const ladder = ruleSet.thresholds?.shotSizeLadder || {}
  const violations = []
  for (let index = 1; index < shots.length; index += 1) {
    const previous = shots[index - 1]
    const current = shots[index]
    if (!previous.subject || !current.subject || previous.subject !== current.subject) continue
    const before = ladder[previous.shotSize]
    const after = ladder[current.shotSize]
    if (typeof before !== 'number' || typeof after !== 'number') continue
    if (Math.abs(before - after) === 1) violations.push(`${current.shotNumber || '?'}：${previous.shotSize}→${current.shotSize}`)
  }
  return baseResult(judge, {
    ok: violations.length === 0,
    detail: violations.length ? `同主体相邻两级直切 ${violations.length} 处：${violations.slice(0, 5).join('；')}` : '景别接续未发现相邻两级硬接',
    where: '分镜',
  })
}

/** PD-03 体态承接：相邻镜 endPose ≠ next.startPose 且无过渡声明 → WARN（无 poses 时 skip）。 */
export function evaluatePoseContinuity({ shots, ruleSet }) {
  const judge = findJudge(ruleSet, 'PD-03')
  if (!judge) throw new Error('rules 缺少 PD-03 定义')
  const withPoses = shots.filter((shot) => shot.poses && typeof shot.poses === 'object')
  if (!withPoses.length) return baseResult(judge, { ok: true, skipped: true, detail: '分镜缺少 poses 字段，跳过（存量灰度）', where: '分镜' })
  const violations = []
  for (let index = 1; index < shots.length; index += 1) {
    const previous = shots[index - 1]
    const current = shots[index]
    const endPose = previous.poses?.endPose
    const startPose = current.poses?.startPose
    if (!endPose || !startPose) continue
    if (endPose.trim() === startPose.trim()) continue
    if (previous.transitionToNext || current.transitionToNext) continue
    violations.push(`${current.shotNumber || '?'}：${endPose} ≠ ${startPose}`)
  }
  return baseResult(judge, {
    ok: violations.length === 0,
    detail: violations.length ? `体态承接不连续 ${violations.length} 处：${violations.slice(0, 5).join('；')}` : '体态承接连续',
    where: '分镜',
  })
}

/** PD-04 每镜光影：有 light 字段的镜头中缺失/过短 → WARN（整体无 light 时 skip）。 */
export function evaluateLightPerShot({ shots, ruleSet }) {
  const judge = findJudge(ruleSet, 'PD-04')
  if (!judge) throw new Error('rules 缺少 PD-04 定义')
  const withLight = shots.filter((shot) => typeof shot.light === 'string' && shot.light.trim())
  if (!withLight.length) return baseResult(judge, { ok: true, skipped: true, detail: '分镜缺少 light 字段，跳过（存量灰度）', where: '分镜' })
  const minWords = Number(ruleSet.thresholds?.minLightWords) || 8
  const violations = []
  for (const shot of shots) {
    const light = String(shot.light || '').trim()
    if (!light) violations.push(`${shot.shotNumber || '?'}：缺少光影句`)
    else if (light.length < minWords) violations.push(`${shot.shotNumber || '?'}：光影句过短（${light.length} 字）`)
  }
  return baseResult(judge, {
    ok: violations.length === 0,
    detail: violations.length ? `光影缺失/过短 ${violations.length} 处：${violations.slice(0, 5).join('；')}` : '每镜光影句齐全',
    where: '分镜',
  })
}

/** PD-05 现场声：缺失 → WARN；含 BGM 类词 → WARN（整体无 ambientSound 时 skip）。 */
export function evaluateAmbientSound({ shots, ruleSet }) {
  const judge = findJudge(ruleSet, 'PD-05')
  if (!judge) throw new Error('rules 缺少 PD-05 定义')
  const withSound = shots.filter((shot) => typeof shot.ambientSound === 'string' && shot.ambientSound.trim())
  if (!withSound.length) return baseResult(judge, { ok: true, skipped: true, detail: '分镜缺少 ambientSound 字段，跳过（存量灰度）', where: '分镜' })
  const bgm = ruleSet.thresholds?.bgmLexicon || []
  const violations = []
  for (const shot of shots) {
    const sound = String(shot.ambientSound || '').trim()
    if (!sound) violations.push(`${shot.shotNumber || '?'}：缺少现场声`)
    else if (bgm.some((word) => sound.includes(word))) violations.push(`${shot.shotNumber || '?'}：现场声含 BGM/配乐词`)
  }
  return baseResult(judge, {
    ok: violations.length === 0,
    detail: violations.length ? `现场声问题 ${violations.length} 处：${violations.slice(0, 5).join('；')}` : '现场声合规',
    where: '分镜',
  })
}

/** PD-09 焦段纪律：焦段与景别不相容 → WARN（整体无 lens 时 skip）。 */
export function evaluateLensDiscipline({ shots, ruleSet }) {
  const judge = findJudge(ruleSet, 'PD-09')
  if (!judge) throw new Error('rules 缺少 PD-09 定义')
  const withLens = shots.filter((shot) => parseFocalMm(shot.lens) !== null)
  if (!withLens.length) return baseResult(judge, { ok: true, skipped: true, detail: '分镜缺少 lens 字段，跳过（存量灰度）', where: '分镜' })
  const rules = ruleSet.lens?.rules || []
  const violations = []
  for (const shot of withLens) {
    const focal = parseFocalMm(shot.lens)
    for (const rule of rules) {
      if (shot.shotSize !== rule.shotSize) continue
      if (rule.forbiddenLensMax != null && focal <= rule.forbiddenLensMax) violations.push(`${shot.shotNumber || '?'}：${shot.shotSize}×${focal}mm（${rule.message}）`)
      if (rule.forbiddenLensMin != null && focal >= rule.forbiddenLensMin) violations.push(`${shot.shotNumber || '?'}：${shot.shotSize}×${focal}mm（${rule.message}）`)
    }
  }
  return baseResult(judge, {
    ok: violations.length === 0,
    detail: violations.length ? `焦段/景别错配 ${violations.length} 处：${violations.slice(0, 5).join('；')}` : '焦段纪律合规',
    where: '分镜',
  })
}

const EVALUATORS = {
  'PD-02': evaluateShotSizeContinuity,
  'PD-03': evaluatePoseContinuity,
  'PD-04': evaluateLightPerShot,
  'PD-05': evaluateAmbientSound,
  'PD-09': evaluateLensDiscipline,
}

/**
 * 运行本模块负责的判据（骨架入口；task-88 前不接入 runDeterministicChecks）。
 * @returns {Promise<Array>} judge 结果数组（顺序同 SHOT_CONTINUITY_JUDGE_IDS）
 */
export async function runShotContinuityChecks({ shots = [], ruleSet = null } = {}) {
  const rules = ruleSet || (await loadRuleSet())
  return SHOT_CONTINUITY_JUDGE_IDS.map((id) => EVALUATORS[id]({ shots, ruleSet: rules }))
}
