/**
 * v0.10.2（task-86 / B1-A）：判据规则单一源加载器。
 *
 * 单一事实源：`presets/rules/*.json`（随包；`package.json.files` 含 `presets/rules/*.json`）。
 * - JS（lib/checks.js + lib/prompt-discipline.js + lib/shot-continuity.js）与 QA 共用本 loader，
 *   禁止在 JS 内维护规则镜像（避免双维护漂移）；
 * - 本模块只读取规则，不做业务判定；判定在 prompt-discipline.js / shot-continuity.js。
 * - 0 依赖、0 真实模型。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RULES_DIR_RELATIVE = 'presets/rules'
export const RULE_FILES = {
  judges: 'judges.json',
  assetJudges: 'assets.json',
  rhetoric: 'lexicon-rhetoric.json',
  positiveNegative: 'lexicon-positive-negative.json',
  lens: 'lexicon-lens.json',
  thresholds: 'thresholds.json',
}
export const RULE_FILE_NAMES = Object.values(RULE_FILES)
const RULES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', RULES_DIR_RELATIVE)

let cache = null

function rulesError(message) {
  const error = new Error(message)
  error.code = 'rules-invalid'
  return error
}

/** 读取单个规则文件（QA 同源断言/诊断用）。 */
export async function readRuleFile(name) {
  const file = path.join(RULES_DIR, name)
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    throw rulesError(`规则文件缺失：${RULES_DIR_RELATIVE}/${name}（请确认打包包含 presets/rules/）`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw rulesError(`规则文件不是合法 JSON：${RULES_DIR_RELATIVE}/${name}`)
  }
}

function assertSchema(file, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw rulesError(`${file} 必须是对象`)
  if (data.schemaVersion !== 1) throw rulesError(`${file}.schemaVersion 必须为 1`)
}

/** 校验 judges 定义完整性（新增必退休：lifecycle.retireCandidate 必填）。 */
export function validateJudgeSet(judgeSet) {
  if (!judgeSet || typeof judgeSet !== 'object') throw rulesError('judges.json 必须是对象')
  if (!Array.isArray(judgeSet.judges) || judgeSet.judges.length === 0) throw rulesError('judges.json.judges 必须是非空数组')
  const ids = new Set()
  for (const judge of judgeSet.judges) {
    const where = `judges.json:${judge && judge.id ? judge.id : '?'}`
    if (!judge || typeof judge !== 'object') throw rulesError(`${where} 必须是对象`)
    if (typeof judge.id !== 'string' || !judge.id) throw rulesError(`${where}.id 必填`)
    if (ids.has(judge.id)) throw rulesError(`${where}.id 重复`)
    ids.add(judge.id)
    if (typeof judge.name !== 'string' || !judge.name) throw rulesError(`${where}.name 必填`)
    if (!['fail', 'warn'].includes(judge.severityDefault)) throw rulesError(`${where}.severityDefault 必须是 fail|warn`)
    if (!['structure', 'criteria'].includes(judge.category)) throw rulesError(`${where}.category 必须是 structure|criteria`)
    if (!Array.isArray(judge.inputs) || !judge.inputs.length) throw rulesError(`${where}.inputs 必须是非空数组`)
    if (typeof judge.skipIfMissing !== 'boolean') throw rulesError(`${where}.skipIfMissing 必须是布尔值`)
    if (typeof judge.code !== 'string' || !judge.code) throw rulesError(`${where}.code 必填（稳定判据码）`)
    if (typeof judge.message !== 'string' || !judge.message) throw rulesError(`${where}.message 必填（可观测提示）`)
    if (!judge.lifecycle || typeof judge.lifecycle !== 'object') throw rulesError(`${where}.lifecycle 必填`)
    if (typeof judge.lifecycle.addedIn !== 'string' || !judge.lifecycle.addedIn) throw rulesError(`${where}.lifecycle.addedIn 必填`)
    if (typeof judge.lifecycle.retireCandidate !== 'string' || !judge.lifecycle.retireCandidate) {
      throw rulesError(`${where}.lifecycle.retireCandidate 必填（新增必退休）`)
    }
  }
  const severity = judgeSet.severity && typeof judgeSet.severity === 'object' ? judgeSet.severity : {}
  for (const level of ['fail', 'warn']) {
    if (!Array.isArray(severity[level])) throw rulesError(`judges.json.severity.${level} 必须是数组`)
    for (const id of severity[level]) if (!ids.has(id)) throw rulesError(`judges.json.severity.${level} 引用了未定义 judge：${id}`)
  }
  for (const id of ids) {
    const level = severity.fail?.includes(id) ? 'fail' : severity.warn?.includes(id) ? 'warn' : null
    if (!level) throw rulesError(`judges.json:${id} 未在 severity.fail/warn 中登记`)
  }
  if (typeof judgeSet.lexicons !== 'object') throw rulesError('judges.json.lexicons 必须是对象')
  return true
}

/**
 * 加载整套规则（带缓存）。
 * @param {{refresh?:boolean}} [options]
 * @returns {Promise<{dir:string, files:object, judges:Array, severity:object, lexicons:object, rhetoric:object, positiveNegative:object, lens:object, thresholds:object}>}
 */
export async function loadRuleSet(options = {}) {
  if (cache && options.refresh !== true) return cache
  const [judges, assetJudgeSet, rhetoric, positiveNegative, lens, thresholds] = await Promise.all([
    readRuleFile(RULE_FILES.judges),
    readRuleFile(RULE_FILES.assetJudges),
    readRuleFile(RULE_FILES.rhetoric),
    readRuleFile(RULE_FILES.positiveNegative),
    readRuleFile(RULE_FILES.lens),
    readRuleFile(RULE_FILES.thresholds),
  ])
  assertSchema(RULE_FILES.judges, judges)
  assertSchema(RULE_FILES.assetJudges, assetJudgeSet)
  assertSchema(RULE_FILES.rhetoric, rhetoric)
  assertSchema(RULE_FILES.positiveNegative, positiveNegative)
  assertSchema(RULE_FILES.lens, lens)
  assertSchema(RULE_FILES.thresholds, thresholds)
  validateJudgeSet(judges)
  validateJudgeSet(assetJudgeSet)
  cache = {
    dir: RULES_DIR,
    files: { ...RULE_FILES },
    judges: judges.judges,
    severity: judges.severity,
    lexicons: judges.lexicons,
    assetJudges: assetJudgeSet.judges,
    assetSeverity: assetJudgeSet.severity,
    rhetoric,
    positiveNegative,
    lens,
    thresholds,
  }
  return cache
}

/** 清空缓存（QA/热更新/测试用）。 */
export function resetRuleSetCache() {
  cache = null
}

/** 按 id 取 judge 定义。 */
export function findJudge(ruleSet, id) {
  return (ruleSet.judges || []).find((judge) => judge.id === id) || null
}

/** 按 id 取资产门禁 judge 定义（v0.11.0 2-3）。 */
export function findAssetJudge(ruleSet, id) {
  return (ruleSet.assetJudges || []).find((judge) => judge.id === id) || null
}
