/**
 * v0.10.2 判据机器化（批次 1）· checks 分级 + 8 条判据 · QA 断言套件（task-87）
 *
 * 目标（AC-B1-1…B1-5）：
 *   [0] 能力探测（版本自适应）：task-86 分级 schema/rules 骨架、task-88 8 判据接入后自动启用更强断言；
 *   [1] 基线回归（始终执行）：现有 10 项确定性检查语义不变（ok/summary/formatCheckReport/旧项目兼容）；
 *   [2] 分级 schema（task-86 后）：severity/status/skipped 字段、summary.warned/skipped、ok=无 FAIL、strict 不变；
 *   [3] rules 单一源（task-86 后）：presets/rules/*.json 结构/8 条 selection/lifecycle/词表可解析；
 *   [4] 8 条判据（task-88 后）：PD-01/02/03/04/05/06/08/09 正反例、全 WARN 不阻断、message 可读；
 *   [5] 灰度（task-88 后）：旧项目/缺字段 skip，不产生新 FAIL/WARN 噪声；
 *   [6] 真实项目 fixture（万界倒爷复制只读）：旧项目 checks 无新 FAIL、源文件 hash 不变；
 *   [7] 契约：工具 34 / METHODS 70（task-110 media-read +1；v0.15.11 E13 assets-import +1） 不变、无新依赖、旧数据 32 hash 不回归（由 audit-robust 套件覆盖）。
 *
 * 运行：node test/criteria-checks.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href)
const checks = await load('lib/checks.js')
const store = await load('lib/store.js')

let passed = 0
let failed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) { passed += 1 } else {
    failed += 1
    failures.push(`${label}${detail ? ' -> ' + detail : ''}`)
    console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`)
  }
}
function group(name) { console.log('\n' + name) }
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const fileExists = (file) => fs.access(file).then(() => true, () => false)

/* ------------------------------------------------------ [0] 能力探测（版本自适应） */
group('[0] 能力探测（版本自适应）')
const checksSrc = await fs.readFile(path.join(pluginRoot, 'lib', 'checks.js'), 'utf8')
const hostSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const methodsBlock = hostSrc.slice(hostSrc.indexOf('const METHODS = ['), hostSrc.indexOf(']', hostSrc.indexOf('const METHODS = [')))
const methodsCount = new Set([...methodsBlock.matchAll(/'([a-z][a-z0-9-]+)'/g)]).size
const toolsModule = await load('lib/tools.js')
const toolCount = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES.length : 0
const rulesDir = path.join(pluginRoot, 'presets', 'rules')
const judgesFile = path.join(rulesDir, 'judges.json')
const hasSeverity = /severity/.test(checksSrc)
const hasWarnSummary = /warned/.test(checksSrc)
const hasRules = await fileExists(judgesFile)
const hasDisciplineModules = (await fileExists(path.join(pluginRoot, 'lib', 'prompt-discipline.js'))) && (await fileExists(path.join(pluginRoot, 'lib', 'shot-continuity.js')))
const hasCriteriaLoader = await fileExists(path.join(pluginRoot, 'lib', 'criteria-rules.js'))
console.log(`      版本自适应：severity=${hasSeverity} warned=${hasWarnSummary} rules=${hasRules} discipline模块=${hasDisciplineModules} 规则加载器=${hasCriteriaLoader}`)
check('工具面 34 不变', toolCount === 35, String(toolCount))
check('METHODS 71（task-110 media-read +1；v0.15.11 E13 assets-import +1；v0.16.6 C2 style-save +1） 不变', methodsCount === 72, String(methodsCount))

/* ------------------------------------------------------ 临时工作区与夹具 */
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'criteria-checks-'))
const TITLE = '判据测试剧'
await store.createProject(workspace, TITLE)
await store.saveContract(workspace, TITLE, { platform: '抖音', audience: '18-35', episodeDurationSec: [60, 120], targetEpisodes: 80, orientation: 'portrait', hookDensity: '每 25~30 秒一个钩子', redlines: ['不出现违法细节'] })
await store.saveOutline(workspace, TITLE, [{ order: 1, title: '假当票对峙', logline: '赵铁拿假当票催债，林越当场验破', hook: '赵铁踹门', twist: '验出假票', cliffhanger: '三天期限', estDurationSec: 100 }])
await store.saveCharacters(workspace, TITLE, [{ name: '林越', role: '主角', personality: ['冷静'], bio: '当铺朝奉' }, { name: '赵铁', role: '反派', personality: ['暴躁'], bio: '放贷人' }])
const EPISODE_VALID = '# 第001集 假当票对峙\n\n## 场景 1：内景 - 当铺 - 夜\n\n赵铁：三年前的账，今天到期。\n林越：这张当票，是假的。\n'
await store.writeEpisode(workspace, TITLE, 1, EPISODE_VALID)
const BASE_SHOTS = [
  { shotNumber: '1-1', shotSize: '近景', cameraMove: '推', description: '赵铁把当票拍在柜台上', dialogue: '赵铁：三年前的账，今天到期。', durationSec: 6 },
  { shotNumber: '1-2', shotSize: '中景', cameraMove: '固定', description: '林越抬眼看向赵铁', dialogue: '林越：这张当票，是假的。', durationSec: 5 },
]
await store.saveStoryboard(workspace, TITLE, 1, BASE_SHOTS)

/* ------------------------------------------------------ [1] 基线回归（始终执行） */
group('[1] 基线回归：现有 10 项确定性检查语义不变')
const validReport = await checks.runDeterministicChecks(workspace, { title: TITLE })
check('runDeterministicChecks 返回 ok/title/checks/summary/stats', validReport && validReport.ok === true && Array.isArray(validReport.checks) && validReport.summary && validReport.stats, JSON.stringify(validReport && Object.keys(validReport)))
const integratedNow = validReport.checks.some((item) => typeof item.id === 'string' && /^PD-/.test(item.id))
if (integratedNow) {
  const expectedTotal = validReport.summary.total
  const expectedSkipped = expectedTotal - 10
  check(`基线（判据接入后）：旧项目 total=${expectedTotal} / passed=10 / skipped=${expectedSkipped} / warned=0 / failed=0 / ok=true`, expectedTotal >= 18 && validReport.summary.passed === 10 && validReport.summary.skipped === expectedSkipped && validReport.summary.warned === 0 && validReport.summary.failed === 0 && validReport.ok === true, JSON.stringify(validReport.summary))
} else {
  check('基线通过：summary.total ≥10 / failed=0 / passed=total', validReport.summary.total >= 10 && validReport.summary.failed === 0 && validReport.summary.passed === validReport.summary.total, JSON.stringify(validReport.summary))
}
check('既有 10 项 id 全部存在', ['contract-duration', 'outline-present', 'characters-present', 'episodes-present', 'episode-gap', 'scene-count', 'shot-fields', 'shot-duplicate', 'shot-duration', 'speaker-known'].every((id) => validReport.checks.some((item) => item.id === id)), JSON.stringify(validReport.checks.map((item) => item.id)))
check('每项 check 保留 id/label/ok/detail/where 旧字段', validReport.checks.every((item) => typeof item.id === 'string' && typeof item.label === 'string' && typeof item.ok === 'boolean' && 'detail' in item && 'where' in item))
const reportText = checks.formatCheckReport(validReport)
check('formatCheckReport 含 PASS 标题与逐项清单', /确定性检查：PASS/.test(reportText) && /PASS  contract-duration/.test(reportText), reportText.slice(0, 120))
// 失效用例：未知说话人 + 重复镜号 + 缺字段
await store.saveCharacters(workspace, TITLE, [{ name: '林越', role: '主角', personality: ['冷静'], bio: '当铺朝奉' }])
await store.writeEpisode(workspace, TITLE, 1, EPISODE_VALID + '沈知晚：这支簪子，我要活当。\n')
await store.saveStoryboard(workspace, TITLE, 1, [
  { shotNumber: '1-1', shotSize: '近景', cameraMove: '推', description: '赵铁把当票拍在柜台上', durationSec: 6 },
  { shotNumber: '1-1', shotSize: '中景', cameraMove: '固定', description: '', durationSec: 0 },
])
const invalidReport = await checks.runDeterministicChecks(workspace, { title: TITLE })
check('失效用例：ok=false 且 failed>0（分类语义）', invalidReport.ok === false && invalidReport.summary.failed > 0, JSON.stringify(invalidReport.summary))
check('失效用例：unknown speaker/重复镜号/缺字段被定位', invalidReport.checks.some((item) => item.id === 'speaker-known' && item.ok === false) && invalidReport.checks.some((item) => item.id === 'shot-duplicate' && item.ok === false) && invalidReport.checks.some((item) => item.id === 'shot-fields' && item.ok === false), JSON.stringify(invalidReport.checks.filter((item) => !item.ok).map((item) => item.id)))
check('formatCheckReport 失效用例含 FAIL 与明细', /确定性检查：FAIL/.test(checks.formatCheckReport(invalidReport)))
// 恢复有效夹具（后续真机/灰度用）
await store.saveCharacters(workspace, TITLE, [{ name: '林越', role: '主角', personality: ['冷静'], bio: '当铺朝奉' }, { name: '赵铁', role: '反派', personality: ['暴躁'], bio: '放贷人' }])
await store.writeEpisode(workspace, TITLE, 1, EPISODE_VALID)
await store.saveStoryboard(workspace, TITLE, 1, BASE_SHOTS)

/* ------------------------------------------------------ [2] 分级 schema（task-86 后） */
group('[2] 分级 schema（severity/summary.warned/skipped/ok=无 FAIL/strict 不变）')
if (hasSeverity || hasWarnSummary) {
  const report = await checks.runDeterministicChecks(workspace, { title: TITLE })
  check('2.1 每项 check 含 severity ∈ fail|warn', report.checks.every((item) => item.severity === 'fail' || item.severity === 'warn'), JSON.stringify(report.checks.slice(0, 3).map((item) => item.severity)))
  check('2.2 每项 check 含 status ∈ pass|fail|warn|skipped', report.checks.every((item) => ['pass', 'fail', 'warn', 'skipped'].includes(item.status)), JSON.stringify(report.checks.slice(0, 3).map((item) => item.status)))
  check('2.3 每项 check 含 skipped 布尔', report.checks.every((item) => typeof item.skipped === 'boolean'))
  check('2.4 summary 含 warned/skipped 数值', Number.isFinite(report.summary.warned) && Number.isFinite(report.summary.skipped), JSON.stringify(report.summary))
  check('2.5 ok = 无 FAIL（failed 计数仅 fail severity）', report.ok === (report.summary.failed === 0) && report.summary.failed === report.checks.filter((item) => item.status === 'fail').length, JSON.stringify(report.summary))
  check('2.6 strict.failOnWarn=false（WARN 不阻断）', !report.strict || report.strict.failOnWarn === false, JSON.stringify(report.strict))
  check('2.7 派生规则：skipped=true → status=skipped 且 ok=true', report.checks.filter((item) => item.skipped).every((item) => item.status === 'skipped' && item.ok === true))
  check('2.8 派生规则：ok=false & severity=fail → status=fail', report.checks.filter((item) => item.ok === false && item.severity === 'fail').every((item) => item.status === 'fail'))
  check('2.9 v0.11.0 总项数 24 = 结构 10 + 判据 8 + 资产门禁 6', report.summary.total === 24, String(report.summary.total))
  check('2.10 资产门禁项进入 checks（AST-01…06，无 assets 时全 SKIP）', ['AST-01', 'AST-02', 'AST-03', 'AST-04', 'AST-05', 'AST-06'].every((id) => report.checks.some((item) => item.id === id && item.skipped === true && item.ok === true)), JSON.stringify(report.checks.filter((item) => /^AST-/.test(item.id)).map((item) => ({ id: item.id, skipped: item.skipped }))))
} else {
  console.log('      （SKIP：当前工件为 v0.10.1 及更早，无 severity/summary.warned；task-86 落地后自动启用）')
}

/* ------------------------------------------------------ [3] rules 单一源（task-86 后） */
group('[3] rules/*.json 单一源（judges/lexicons/lifecycle）')
if (hasRules) {
  const judges = JSON.parse(await fs.readFile(judgesFile, 'utf8'))
  const judgeEntries = Array.isArray(judges) ? judges : judges.judges || judges.items || []
  const selected = ['PD-01', 'PD-02', 'PD-03', 'PD-04', 'PD-05', 'PD-06', 'PD-08', 'PD-09']
  const judgeIds = judgeEntries.map((entry) => entry.id || entry.code).filter(Boolean)
  check('3.1 judges.json 含 8 条入选判据', selected.every((code) => judgeIds.includes(code)), JSON.stringify(judgeIds))
  check('3.2 每条 judge 默认 WARN + skipIfMissing=true', judgeEntries.filter((entry) => selected.includes(entry.id || entry.code)).every((entry) => (entry.severityDefault === 'warn' || entry.severity === 'warn') && entry.skipIfMissing === true), JSON.stringify(judgeEntries.slice(0, 2)))
  check('3.3 每条 judge 带 lifecycle.retireCandidate（P0 治理）', judgeEntries.filter((entry) => selected.includes(entry.id || entry.code)).every((entry) => entry.lifecycle && 'retireCandidate' in entry.lifecycle), JSON.stringify(judgeEntries.slice(0, 2)))
  check('3.4 judges.json 含版本标记（schemaVersion/rulesVersion，只增）', Number.isFinite(judges.schemaVersion) || Boolean(judges.rulesVersion || judges.version), JSON.stringify({ schemaVersion: judges.schemaVersion, rulesVersion: judges.rulesVersion, version: judges.version }))
  const rulesFiles = (await fs.readdir(rulesDir)).filter((name) => name.endsWith('.json')).sort()
  check('3.5 rules 目录含词表/阈值文件（judges + lexicon/thresholds）', rulesFiles.includes('judges.json') && rulesFiles.some((name) => name.includes('lexicon') || name.includes('threshold')), JSON.stringify(rulesFiles))
  let lexiconsOk = true
  for (const name of rulesFiles) { try { JSON.parse(await fs.readFile(path.join(rulesDir, name), 'utf8')) } catch { lexiconsOk = false } }
  check('3.6 rules/*.json 全部可解析（单一源可被 JS/QA 共用）', lexiconsOk)
  if (hasCriteriaLoader) {
    const loader = await load('lib/criteria-rules.js')
    check('3.7 lib/criteria-rules.js 导出加载器（rules 单源入口）', Object.values(loader).some((value) => typeof value === 'function'))
  }
} else {
  console.log('      （SKIP：当前工件无 presets/rules/judges.json（task-86 落盘后自动启用））')
}

/* ------------------------------------------------------ [4A] 8 条判据模块级正反例（task-88 接入前预验证） */
group('[4A] 8 条判据模块级正反例（prompt-discipline / shot-continuity + rules 同源）')
const promptDisciplinePath = path.join(pluginRoot, 'lib', 'prompt-discipline.js')
const shotContinuityPath = path.join(pluginRoot, 'lib', 'shot-continuity.js')
const criteriaRulesPath = path.join(pluginRoot, 'lib', 'criteria-rules.js')
const hasJudgeModules = (await fileExists(promptDisciplinePath)) && (await fileExists(shotContinuityPath)) && hasRules
if (hasJudgeModules) {
  const { loadRuleSet, resetRuleSetCache, validateJudgeSet } = await load('lib/criteria-rules.js')
  resetRuleSetCache()
  const ruleSet = await loadRuleSet({ refresh: true })
  const promptDiscipline = await load('lib/prompt-discipline.js')
  const shotContinuity = await load('lib/shot-continuity.js')
  const judgeIds = [...promptDiscipline.PROMPT_DISCIPLINE_JUDGE_IDS, ...shotContinuity.SHOT_CONTINUITY_JUDGE_IDS]
  check('4A.1 模块覆盖全部 8 条入选判据（PD-01/02/03/04/05/06/08/09）', ['PD-01', 'PD-02', 'PD-03', 'PD-04', 'PD-05', 'PD-06', 'PD-08', 'PD-09'].every((id) => judgeIds.includes(id)), JSON.stringify(judgeIds))
  check('4A.2 rules loader 返回 6 个规则文件（+assetJudges/assetSeverity，AST-07 新增）（含 assets.json）+ 判据/词表/阈值/资产门禁（单一源）', ruleSet && ruleSet.files && Object.keys(ruleSet.files).length === 6 && Array.isArray(ruleSet.judges) && Array.isArray(ruleSet.assetJudges) && ruleSet.assetJudges.length === 7 && ruleSet.rhetoric && ruleSet.positiveNegative && ruleSet.lens && ruleSet.thresholds, JSON.stringify(ruleSet && Object.keys(ruleSet)))
  const shapeOk = (result, expectedId) => result && result.id === expectedId && result.category === 'criteria' && result.severity === 'warn' && typeof result.ok === 'boolean' && typeof result.skipped === 'boolean' && typeof result.detail === 'string' && typeof result.code === 'string' && result.code.length > 0
  // PD-01 可观测性
  const pd01Bad = promptDiscipline.evaluateObservability({ shots: [{ shotNumber: '1-1', description: '气氛压抑，情绪复杂' }], ruleSet })
  const pd01Good = promptDiscipline.evaluateObservability({ shots: [{ shotNumber: '1-1', description: '赵铁把当票拍在柜台上，纸张边角卷起' }], ruleSet })
  check('4A.3 PD-01 反例命中修辞黑名单 → ok=false（WARN 形状）', pd01Bad.ok === false && shapeOk(pd01Bad, 'PD-01'), JSON.stringify(pd01Bad).slice(0, 180))
  check('4A.4 PD-01 正例（具体画面）→ ok=true', pd01Good.ok === true && pd01Good.skipped === false, JSON.stringify(pd01Good).slice(0, 180))
  // PD-06 正负打架
  const pd06Bad = promptDiscipline.evaluatePositiveNegative({ shots: [{ shotNumber: '1-1', description: '他笑着说没有回头' }], ruleSet })
  const pd06Good = promptDiscipline.evaluatePositiveNegative({ shots: [{ shotNumber: '1-1', description: '画面风格不要出现冷色调' }], ruleSet })
  check('4A.5 PD-06 反例（行为语境+负向词）→ ok=false', pd06Bad.ok === false && shapeOk(pd06Bad, 'PD-06'), JSON.stringify(pd06Bad).slice(0, 180))
  check('4A.6 PD-06 正例（风格排除语境）→ ok=true', pd06Good.ok === true, JSON.stringify(pd06Good).slice(0, 180))
  // PD-08 一镜一事
  const pd08Bad = promptDiscipline.evaluateOneEventPerShot({ shots: [{ shotNumber: '1-1', description: '他转身，抬头，又坐下' }], ruleSet })
  const pd08Good = promptDiscipline.evaluateOneEventPerShot({ shots: [{ shotNumber: '1-1', description: '她站着不动' }], ruleSet })
  check('4A.7 PD-08 反例（动作事件 > 阈值）→ ok=false', pd08Bad.ok === false && shapeOk(pd08Bad, 'PD-08'), JSON.stringify(pd08Bad).slice(0, 180))
  check('4A.8 PD-08 正例（单动作）→ ok=true', pd08Good.ok === true)
  // PD-02 景别接续
  const pd02Bad = shotContinuity.evaluateShotSizeContinuity({ shots: [{ shotNumber: '1-1', shotSize: '中景', subject: '林越' }, { shotNumber: '1-2', shotSize: '近景', subject: '林越' }], ruleSet })
  const pd02Good = shotContinuity.evaluateShotSizeContinuity({ shots: [{ shotNumber: '1-1', shotSize: '全景', subject: '林越' }, { shotNumber: '1-2', shotSize: '近景', subject: '林越' }], ruleSet })
  check('4A.9 PD-02 反例（同主体相邻两级）→ ok=false', pd02Bad.ok === false && shapeOk(pd02Bad, 'PD-02'), JSON.stringify(pd02Bad).slice(0, 180))
  check('4A.10 PD-02 正例（跨级/换主体）→ ok=true', pd02Good.ok === true)
  // PD-03 体态承接
  const pd03Bad = shotContinuity.evaluatePoseContinuity({ shots: [{ shotNumber: '1-1', poses: { startPose: '站立', endPose: '转身' } }, { shotNumber: '1-2', poses: { startPose: '坐下', endPose: '抬头' } }], ruleSet })
  const pd03Good = shotContinuity.evaluatePoseContinuity({ shots: [{ shotNumber: '1-1', poses: { startPose: '站立', endPose: '转身' } }, { shotNumber: '1-2', poses: { startPose: '转身', endPose: '抬头' } }], ruleSet })
  check('4A.11 PD-03 反例（相邻镜体态不承接）→ ok=false', pd03Bad.ok === false && shapeOk(pd03Bad, 'PD-03'), JSON.stringify(pd03Bad).slice(0, 180))
  check('4A.12 PD-03 正例（体态承接）→ ok=true', pd03Good.ok === true)
  // PD-04 每镜光影
  const pd04Bad = shotContinuity.evaluateLightPerShot({ shots: [{ shotNumber: '1-1', light: '灯' }], ruleSet })
  const pd04Good = shotContinuity.evaluateLightPerShot({ shots: [{ shotNumber: '1-1', light: '灯下光斑随人影移动，冷白顶光压住眉骨' }], ruleSet })
  check('4A.13 PD-04 反例（光影句过短/缺失）→ ok=false', pd04Bad.ok === false && shapeOk(pd04Bad, 'PD-04'), JSON.stringify(pd04Bad).slice(0, 180))
  check('4A.14 PD-04 正例（每镜光影句充分）→ ok=true', pd04Good.ok === true)
  // PD-05 现场声
  const pd05Bad = shotContinuity.evaluateAmbientSound({ shots: [{ shotNumber: '1-1', ambientSound: 'BGM 主题曲渐强' }], ruleSet })
  const pd05Good = shotContinuity.evaluateAmbientSound({ shots: [{ shotNumber: '1-1', ambientSound: '雨打窗、门轴吱呀' }], ruleSet })
  check('4A.15 PD-05 反例（现场声写 BGM）→ ok=false', pd05Bad.ok === false && shapeOk(pd05Bad, 'PD-05'), JSON.stringify(pd05Bad).slice(0, 180))
  check('4A.16 PD-05 正例（画面内真实声源）→ ok=true', pd05Good.ok === true)
  // PD-09 焦段纪律
  const pd09Bad = shotContinuity.evaluateLensDiscipline({ shots: [{ shotNumber: '1-1', shotSize: '大特写', lens: '24mm' }, { shotNumber: '1-2', shotSize: '远景', lens: '135mm' }], ruleSet })
  const pd09Good = shotContinuity.evaluateLensDiscipline({ shots: [{ shotNumber: '1-1', shotSize: '大特写', lens: '85mm' }, { shotNumber: '1-2', shotSize: '远景', lens: '24mm' }], ruleSet })
  check('4A.17 PD-09 反例（广角大特写/长焦远景）→ ok=false', pd09Bad.ok === false && shapeOk(pd09Bad, 'PD-09'), JSON.stringify(pd09Bad).slice(0, 180))
  check('4A.18 PD-09 正例（焦段×景别相容）→ ok=true', pd09Good.ok === true)
  // 灰度 skip：缺字段 → skipped=true, ok=true（不误报）
  const grayContinuity = shotContinuity.runShotContinuityChecks({ shots: [{ shotNumber: '1-1', shotSize: '近景', description: '旧项目镜头' }], ruleSet })
  const grayResults = await grayContinuity
  check('4A.19 灰度：缺 poses/light/ambientSound/lens/subject → 连续类判据全部 skip（ok=true）', grayResults.every((item) => item.skipped === true && item.ok === true), JSON.stringify(grayResults.map((item) => ({ id: item.id, skipped: item.skipped }))))
  const grayPrompt = await promptDiscipline.runPromptDisciplineChecks({ shots: [{ shotNumber: '1-1', description: '' }], ruleSet })
  check('4A.20 灰度：提示词文本缺失 → 写作类判据 skip（ok=true）', grayPrompt.every((item) => item.skipped === true && item.ok === true), JSON.stringify(grayPrompt.map((item) => ({ id: item.id, skipped: item.skipped }))))
  // rules 同源行为验证（改词表/阈值 → 判定同步变化；只改内存副本，不写产品文件）
  const clonedRules = JSON.parse(JSON.stringify(ruleSet))
  clonedRules.rhetoric.words = [...clonedRules.rhetoric.words, '测试专用抽象词']
  const sourceShot = [{ shotNumber: '1-1', description: '画面出现测试专用抽象词' }]
  const sameSourceHit = promptDiscipline.evaluateObservability({ shots: sourceShot, ruleSet: clonedRules })
  check('4A.21 rules 同源：内存改词表 → 判定同步（不改产品文件）', sameSourceHit.ok === false && /测试专用抽象词/.test(sameSourceHit.detail), JSON.stringify(sameSourceHit).slice(0, 160))
  const clonedThresholds = JSON.parse(JSON.stringify(ruleSet))
  clonedThresholds.thresholds.maxActionsPerShot = 5
  const sameSourceThreshold = promptDiscipline.evaluateOneEventPerShot({ shots: [{ shotNumber: '1-1', description: '他转身，抬头，又坐下' }], ruleSet: clonedThresholds })
  check('4A.22 rules 同源：内存改阈值 → 判定同步（3 动作在阈值 5 下通过）', sameSourceThreshold.ok === true, JSON.stringify(sameSourceThreshold).slice(0, 160))
  let validateRejected = false
  try { validateJudgeSet({ judges: [{ id: 'PD-X', name: 'x', severityDefault: 'warn', category: 'criteria', inputs: ['x'], skipIfMissing: true, code: 'x', message: 'x', lifecycle: { addedIn: 'v0.10.2' } }], severity: { fail: [], warn: ['PD-X'] }, lexicons: {} }) } catch { validateRejected = true }
  check('4A.23 loader 校验：新增判据缺 lifecycle.retireCandidate → 拒绝（治理）', validateRejected)
} else {
  console.log('      （SKIP：判据模块/rules 尚未落盘（task-86 前），模块级正反例暂不执行）')
}

/* ------------------------------------------------------ [4B] AST-01…06 资产门禁（task-94） */
group('[4B] AST-01…06 资产质量门禁（正反例/全 WARN/灰度/rules 同源）')
const assetGatesPath = path.join(pluginRoot, 'lib', 'asset-gates.js')
if (hasRules && (await fileExists(assetGatesPath))) {
  const assetGatesMod = await load('lib/asset-gates.js')
  const criteriaLoader = await load('lib/criteria-rules.js')
  if (typeof criteriaLoader.resetRuleSetCache === 'function') criteriaLoader.resetRuleSetCache()
  const gateRuleSet = await criteriaLoader.loadRuleSet({ refresh: true })
  check('4B.1 AST_JUDGE_IDS = 7 条（AST-01…07）', JSON.stringify(assetGatesMod.ASSET_JUDGE_IDS) === JSON.stringify(['AST-01', 'AST-02', 'AST-03', 'AST-04', 'AST-05', 'AST-06', 'AST-07']))
  const assetJudgeEntries = Array.isArray(gateRuleSet.assetJudges) ? gateRuleSet.assetJudges : []
  check('4B.2 rules assets.json 7 条：全 WARN/category=criteria/skipIfMissing/retireCandidate', assetJudgeEntries.length === 7 && assetJudgeEntries.every((judge) => judge.severityDefault === 'warn' && judge.category === 'criteria' && judge.skipIfMissing === true && judge.lifecycle && judge.lifecycle.retireCandidate && judge.code && judge.message), JSON.stringify(assetJudgeEntries.map((judge) => ({ id: judge.id, code: judge.code, retire: judge.lifecycle && judge.lifecycle.retireCandidate }))))
  const positiveCards = [
    { id: 'CHR001', type: 'CHR', name: '李慕白', aliases: [] },
    { id: 'SPC001', type: 'SPC', name: '当铺' },
    { id: 'CHR001_02', type: 'CHR', name: '李慕白（少年）', variantOf: 'CHR001' },
  ]
  const positiveShots = [{ order: 1, shots: [{ shotNumber: '1-1', subject: 'CHR001', description: '李慕白（CHR001）站在{{Asset_SPC001_name}}' }] }]
  const positiveResults = assetGatesMod.runAssetGates({ cards: positiveCards, shotsByEpisode: positiveShots, ruleSet: gateRuleSet })
  check('4B.3 合规资产卡：7 条（AST-07 由 final review fixture 覆盖）全部 PASS（ok=true / 无 warn）', positiveResults.length === 7 && positiveResults.filter((item) => item.id !== 'AST-07').every((item) => item.ok === true && item.skipped === false && item.category === 'criteria' && item.severity === 'warn'), JSON.stringify(positiveResults.map((item) => ({ id: item.id, ok: item.ok }))))
  // 反例（逐条）
  const negativeCases = [
    ['AST-01 必填缺失', { cards: [{ name: '缺 id/type' }] }, 'AST-01'],
    ['AST-02 编号非法', { cards: [{ id: 'XX001', type: 'CHR', name: '坏编号' }, { id: 'CHR003', type: 'SPC', name: '类型不一致' }] }, 'AST-02'],
    ['AST-03 重复 ID', { cards: [{ id: 'CHR001', type: 'CHR', name: '甲' }, { id: 'CHR001', type: 'CHR', name: '乙' }] }, 'AST-03'],
    ['AST-04 重复 name', { cards: [{ id: 'CHR001', type: 'CHR', name: '李慕白' }, { id: 'CHR002', type: 'CHR', name: '李慕白' }] }, 'AST-04'],
    ['AST-05 孤儿引用', { cards: [{ id: 'CHR001', type: 'CHR', name: '李慕白' }], shotsByEpisode: [{ order: 1, shots: [{ shotNumber: '1-1', subject: 'CHR999', description: '{{Asset_CHR999_name}}' }] }] }, 'AST-05'],
    ['AST-06 variant 不一致', { cards: [{ id: 'CHR001', type: 'CHR', name: '李慕白' }, { id: 'CHR001_02', type: 'CHR', name: '少年', variantOf: 'CHR999' }] }, 'AST-06'],
  ]
  let negativePass = 0
  const negativeDetails = []
  for (const [label, input, expectedId] of negativeCases) {
    const results = assetGatesMod.runAssetGates({ ...input, ruleSet: gateRuleSet })
    const target = results.find((item) => item.id === expectedId)
    if (target && target.ok === false && target.severity === 'warn' && target.category === 'criteria' && target.status !== 'fail') negativePass += 1
    else negativeDetails.push(label + ':' + JSON.stringify(target && { ok: target.ok, status: target.status }))
  }
  check('4B.4 6 条反例分别命中对应 AST 判据（ok=false / severity=warn / 不 FAIL）', negativePass === negativeCases.length, JSON.stringify(negativeDetails))
  const grayGates = assetGatesMod.runAssetGates({ cards: [], shotsByEpisode: positiveShots, ruleSet: gateRuleSet })
  check('4B.5 无资产卡：6 条全 SKIP（ok=true / skipped=true / 零噪声）', grayGates.length === 6 && grayGates.every((item) => item.skipped === true && item.ok === true), JSON.stringify(grayGates.map((item) => ({ id: item.id, skipped: item.skipped }))))
  // rules 同源：内存移除 AST-03 定义 → 输出同步少一条（不写产品文件）
  const clonedGateRules = JSON.parse(JSON.stringify(gateRuleSet))
  clonedGateRules.assetJudges = clonedGateRules.assetJudges.filter((judge) => judge.id !== 'AST-03')
  const clonedResults = assetGatesMod.runAssetGates({ cards: positiveCards, shotsByEpisode: positiveShots, ruleSet: clonedGateRules })
  check('4B.6 rules 同源：内存移除 AST-03 定义 → 输出同步少一条（不改产品文件）', clonedResults.length === 6 && !clonedResults.some((item) => item.id === 'AST-03'), JSON.stringify(clonedResults.map((item) => item.id)))
  check('4B.7 AST 判据 shape：id/label/code/category/severity/warn 可读 message', positiveResults.every((item) => typeof item.id === 'string' && typeof item.label === 'string' && typeof item.code === 'string' && item.code.length > 0 && typeof item.detail === 'string' && item.detail.length > 0))
  // 集成：手改 cards.json 造 AST 违规 → 整体 checks 仍 ok=true（WARN 不进 failed）、WARN 不阻断导出
  const cardsDir = path.join(workspace, 'AI短剧', TITLE, '.aidrama', 'assets')
  const cardsFilePath = path.join(cardsDir, 'cards.json')
  let hasMalformedCards = false
  try {
    await fs.mkdir(cardsDir, { recursive: true })
    await fs.writeFile(cardsFilePath, JSON.stringify({ schemaVersion: 1, assets: [{ id: 'CHR001', type: 'CHR', name: '甲' }, { id: 'CHR001', type: 'CHR', name: '乙' }, { id: 'CHR001_02', type: 'CHR', name: '缺基础', variantOf: 'CHR999' }] }, null, 2) + '\n', 'utf8')
    hasMalformedCards = true
  } catch {}
  if (hasMalformedCards) {
    const astReport = await checks.runDeterministicChecks(workspace, { title: TITLE })
    const astWarnItems = astReport.checks.filter((item) => typeof item.id === 'string' && /^AST-/.test(item.id) && item.status === 'warn')
    check('4B.8 集成：手改 cards.json（重复 id/variant 无效）→ AST 违规为 WARN、ok 仍 true、failed=0', astWarnItems.length >= 1 && astReport.ok === true && astReport.summary.failed === 0 && astReport.summary.total === 25, JSON.stringify({ warned: astReport.summary.warned, failed: astReport.summary.failed, total: astReport.summary.total }))
    const exporterMod2 = await load('lib/exporter.js')
    const astExport = await exporterMod2.exportProject(workspace, TITLE, 'json')
    check('4B.9 AST WARN 不阻断导出（checks.ok=true / failed=0 / warned≥1）', astExport && astExport.checks && astExport.checks.ok === true && astExport.checks.failed.length === 0 && astExport.checks.warned.length >= 1, JSON.stringify(astExport && astExport.checks && { ok: astExport.checks.ok, failed: astExport.checks.failed.length, warned: astExport.checks.warned.length }))
    await fs.rm(cardsDir, { recursive: true, force: true })
  } else {
    console.log('      （SKIP：无法写入 cards.json 夹具）')
  }
} else {
  console.log('      （SKIP：task-94 资产门禁/rules 尚未落盘）')
}

/* ------------------------------------------------------ [4] 8 条判据（task-88 后） */
group('[4] 8 条判据正反例（全 WARN 不阻断、message 可读）')
let judgesIntegrated = false
if (hasSeverity && hasRules && hasDisciplineModules) {
  // 带新字段的分镜（触发判据候选）
  const judgeShots = [
    { shotNumber: '1-1', shotSize: '中景', cameraMove: '推', description: '赵铁把假当票拍在柜台上，气氛压抑，他笑着说没有回头。', dialogue: '赵铁：三年前的账，今天到期。', durationSec: 6, light: '灯下光斑随人影移动', ambientSound: '雨打窗、门轴吱呀', poses: { startPose: '站立', endPose: '转身' }, lens: '50mm', subject: '赵铁' },
    { shotNumber: '1-2', shotSize: '近景', cameraMove: '固定', description: '林越转身，抬头，又坐下，抬眼看赵铁。', dialogue: '林越：这张当票，是假的。', durationSec: 5, light: '顶光压眉骨', ambientSound: '雨声渐弱', poses: { startPose: '坐下', endPose: '抬头' }, lens: '85mm', subject: '赵铁' },
  ]
  await store.saveStoryboard(workspace, TITLE, 1, judgeShots)
  const judgeReport = await checks.runDeterministicChecks(workspace, { title: TITLE })
  const judgeItems = judgeReport.checks.filter((item) => typeof item.id === 'string' && /^PD-/.test(item.id))
  judgesIntegrated = judgeItems.length >= 1
  if (judgesIntegrated) {
    check('4.1 判据项进入 checks：8 条全部评估（无 skip）', judgeItems.length === 8 && judgeItems.every((item) => item.status !== 'skipped'), JSON.stringify(judgeItems.map((item) => ({ code: item.code, status: item.status }))))
  }
  if (judgesIntegrated) {
    check('4.2 判据全部 severity=warn/category=criteria（默认不阻断）', judgeItems.every((item) => item.severity === 'warn' && item.category === 'criteria'), JSON.stringify(judgeItems.map((item) => ({ id: item.id, severity: item.severity, category: item.category, status: item.status }))))
    check('4.2a 判据 id=PD-xx 且 status 与 ok 派生一致', judgeItems.every((item) => item.id === ({ 'prompt-observability': 'PD-01', 'shot-size-continuity': 'PD-02', 'pose-continuity': 'PD-03', 'light-per-shot': 'PD-04', 'ambient-sound': 'PD-05', 'positive-negative-conflict': 'PD-06', 'one-event-per-shot': 'PD-08', 'lens-discipline': 'PD-09' }[item.code] || item.id) && item.status === (item.ok ? 'pass' : 'warn')), JSON.stringify(judgeItems.map((item) => ({ id: item.id, code: item.code, status: item.status, ok: item.ok }))))
    check('4.2b 至少 1 条违规 → status=warn（可观测）', judgeItems.some((item) => item.status === 'warn'), JSON.stringify(judgeItems.map((item) => ({ code: item.code, status: item.status }))))
    check('4.2c WARN 项 ok=false 但不进 summary.failed', judgeItems.filter((item) => item.status === 'warn').every((item) => item.ok === false) && judgeReport.summary.failed === 0, JSON.stringify(judgeReport.summary))
    check('4.3 WARN 不改变 ok（ok 仍 = failed===0，且 judgeReport.ok=true）', judgeReport.ok === true && judgeReport.summary.failed === 0, JSON.stringify(judgeReport.summary))
    check('4.4 判据 message/detail 可读（非空中文/含判据名）', judgeItems.every((item) => String(item.detail || item.message || '').length > 0 && typeof item.label === 'string' && item.label.length > 0), JSON.stringify(judgeItems.slice(0, 2).map((item) => item.label)))
    check('4.5 summary.warned ≥ 判据 warn 数（可观测）', judgeReport.summary.warned >= judgeItems.filter((item) => item.status === 'warn').length, JSON.stringify(judgeReport.summary))
    const astItems = judgeReport.checks.filter((item) => typeof item.id === 'string' && /^AST-/.test(item.id))
    check('4.5b 无 assets 项目：AST 门禁 6 条全 SKIP、零新 WARN', astItems.length === 6 && astItems.every((item) => item.skipped === true && item.ok === true), JSON.stringify(astItems.map((item) => ({ id: item.id, skipped: item.skipped }))))
    const judgeReportText = checks.formatCheckReport(judgeReport)
    check('4.6 WARN 不改变 formatCheckReport 首 token（仍 PASS）', /^确定性检查：PASS/.test(judgeReportText) && /警告/.test(judgeReportText), judgeReportText.split('\n')[0])
    check('4.7 WARN 不阻断 strict：report.strict.ok=true / failOnWarn=false', judgeReport.strict && judgeReport.strict.ok === true && judgeReport.strict.failOnWarn === false, JSON.stringify(judgeReport.strict))
    const exporterMod = await load('lib/exporter.js')
    const warnExport = await exporterMod.exportProject(workspace, TITLE, 'json')
    check('4.8 含 WARN 项目导出成功（checks.ok=true / failed=0 / warned≥1）', warnExport && warnExport.checks && warnExport.checks.ok === true && warnExport.checks.failed.length === 0 && warnExport.checks.warned.length >= 1, JSON.stringify(warnExport && warnExport.checks && { ok: warnExport.checks.ok, failed: warnExport.checks.failed.length, warned: warnExport.checks.warned.length }))
    const toolsSrc2 = await fs.readFile(path.join(pluginRoot, 'lib', 'tools.js'), 'utf8')
    check('4.9 strict 阻断仅按 severity=fail（tools.js 静态：finalize/export strict 过滤 fail）', /severity === 'fail' && !item\.ok/.test(toolsSrc2) || /severity === 'fail' && !item\.ok/.test(toolsSrc2.replace(/\s+/g, ' ')), 'tools.js strict filter')
  } else {
    console.log('      （SKIP：8 条判据尚未接入 runDeterministicChecks（task-88 进行中），仅验证 schema/rules 骨架）')
  }
  await store.saveStoryboard(workspace, TITLE, 1, BASE_SHOTS)
} else {
  console.log('      （SKIP：8 条判据接入（task-88）尚未完成；先验证 schema/灰度/rules 骨架）')
}

/* ------------------------------------------------------ [5] 灰度 skip（task-88 后） */
group('[5] 灰度：旧项目/缺字段 skip，不产生新 FAIL/WARN 噪声')
if (hasSeverity && hasRules && judgesIntegrated) {
  const oldShots = [
    { shotNumber: '1-1', shotSize: '近景', cameraMove: '推', description: '赵铁把当票拍在柜台上', durationSec: 6 },
    { shotNumber: '1-2', shotSize: '中景', cameraMove: '固定', description: '林越抬眼看向赵铁', durationSec: 5 },
  ]
  await store.saveStoryboard(workspace, TITLE, 1, oldShots)
  const grayReport = await checks.runDeterministicChecks(workspace, { title: TITLE })
  const judgeItems = grayReport.checks.filter((item) => typeof item.id === 'string' && /^PD-/.test(item.id))
  check('5.1 旧项目/缺字段：判据项全部 skipped（不误报）', judgeItems.length === 8 && judgeItems.every((item) => item.skipped === true || item.status === 'skipped'), JSON.stringify(judgeItems.map((item) => ({ code: item.code, status: item.status }))))
  const grayTotal = grayReport.summary.total
  check(`5.1b 旧项目 summary：total=${grayTotal} / passed=10 / skipped=${grayTotal - 10} / warned=0 / failed=0`, grayTotal >= 18 && grayReport.summary.passed === 10 && grayReport.summary.skipped === grayTotal - 10 && grayReport.summary.warned === 0 && grayReport.summary.failed === 0, JSON.stringify(grayReport.summary))
  check('5.2 旧项目：无新增 FAIL（ok=true）', grayReport.ok === true && grayReport.summary.failed === 0, JSON.stringify(grayReport.summary))
  check('5.3 旧项目：无 WARN 噪声（warned=0 或全部 skip）', grayReport.summary.warned === 0 || judgeItems.every((item) => item.status === 'skipped'), JSON.stringify(grayReport.summary))
  const grayAssets = grayReport.checks.filter((item) => typeof item.id === 'string' && /^AST-/.test(item.id))
  check('5.4 旧项目无 assets：AST-01…06 全 SKIP（无资产卡零噪声）', grayAssets.length === 6 && grayAssets.every((item) => item.skipped === true && item.ok === true && item.category === 'criteria' && item.severity === 'warn'), JSON.stringify(grayAssets.map((item) => ({ id: item.id, skipped: item.skipped }))))
  await store.saveStoryboard(workspace, TITLE, 1, BASE_SHOTS)
} else {
  console.log('      （SKIP：task-86/88 未落地，灰度断言暂不执行）')
}

/* ------------------------------------------------------ [6] 真实项目 fixture（万界倒爷复制只读） */
group('[6] 真实项目 fixture：万界倒爷复制只读，旧项目无新 FAIL')
const REAL_STORYBOARD = process.env.DSH_AI_DRAMA_SAMPLE_STORYBOARD || ''
const realAvailable = await fileExists(REAL_STORYBOARD)
if (realAvailable) {
  const realBytes = await fs.readFile(REAL_STORYBOARD)
  const realHashBefore = sha256(realBytes)
  const realShots = JSON.parse(realBytes.toString('utf8'))
  const REAL_TITLE = '万界倒爷复制验证'
  await store.createProject(workspace, REAL_TITLE)
  // 优先沿用真实项目契约时长（万界倒爷实际 150s/集），避免合成契约造成 shot-duration 误报
  const REAL_CONTRACT = process.env.DSH_AI_DRAMA_SAMPLE_CONTRACT || ''
  let realContract = { platform: '红果', audience: '男频', episodeDurationSec: [60, 180], targetEpisodes: 80, orientation: 'portrait', hookDensity: '快速钩子', redlines: [] }
  if (await fileExists(REAL_CONTRACT)) {
    try {
      const parsedContract = JSON.parse(await fs.readFile(REAL_CONTRACT, 'utf8'))
      if (Array.isArray(parsedContract.episodeDurationSec) && parsedContract.episodeDurationSec.length === 2) realContract = { ...realContract, ...parsedContract }
    } catch {}
  }
  await store.saveContract(workspace, REAL_TITLE, realContract)
  await store.saveOutline(workspace, REAL_TITLE, [{ order: 1, title: '万界倒爷 第1集', logline: '复制只读验证', hook: '', twist: '', cliffhanger: '', estDurationSec: 150 }])
  await store.saveCharacters(workspace, REAL_TITLE, [{ name: '林越', role: '主角', personality: [], bio: '' }])
  await store.writeEpisode(workspace, REAL_TITLE, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：这钱，我三天还你。\n')
  await store.saveStoryboard(workspace, REAL_TITLE, 1, realShots)
  const realReport = await checks.runDeterministicChecks(workspace, { title: REAL_TITLE })
  const realJudgeItems = realReport.checks.filter((item) => typeof item.id === 'string' && /^PD-/.test(item.id))
  check('6.1 真实 19 镜复制：checks 无新 FAIL（ok=true）', realReport.ok === true && realReport.summary.failed === 0, JSON.stringify({ summary: realReport.summary, failed: realReport.checks.filter((item) => !item.ok).map((item) => item.id) }))
  if (realJudgeItems.length) check('6.1b 真实旧项目：8 判据全 skip、warned=0（零新 WARN）', realJudgeItems.length === 8 && realJudgeItems.every((item) => item.status === 'skipped') && realReport.summary.warned === 0, JSON.stringify(realJudgeItems.map((item) => ({ code: item.code, status: item.status }))))
  check('6.2 真实源文件只读（hash 前后不变）', sha256(await fs.readFile(REAL_STORYBOARD)) === realHashBefore)
  await fs.rm(path.join(workspace, 'AI短剧', REAL_TITLE), { recursive: true, force: true })
} else {
  console.log('      （SKIP：真实项目 fixture 不存在：' + REAL_STORYBOARD + '）')
}

/* ------------------------------------------------------ [7] 契约与清理 */
group('[7] 契约与清理')
check('7.1 工具 34 / METHODS 71（v0.16.6 C2 style-save +1） 不变', toolCount === 35 && methodsCount === 72, JSON.stringify({ tools: toolCount, methods: methodsCount }))
check('7.2 无新增依赖（package.json dependencies 不新增测试依赖）', await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8').then((text) => !/vitest|jest|mocha/.test(text)).catch(() => false))
await fs.rm(workspace, { recursive: true, force: true })
check('7.3 临时工作区已清理', !(await fileExists(workspace)))

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
