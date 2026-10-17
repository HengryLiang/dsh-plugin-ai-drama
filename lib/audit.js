/**
 * P2-3：AI 审读宿主半（v0.6.0，B 方案：扩展 `drama_check_consistency` 的 `deep:true` 参数）
 *
 * 技术路线（task-26 Lead 强制确认项）：**直连宿主 `llm` 服务为主 + agent-mediated 两段式/确定性降级兜底**。
 *   - `ctx.get('llm')`（optional）→ `llm.stream(GenerateOptions)` 流式调用宿主默认模型
 *     （默认路由来自 `ctx.get('agentDefaultModel').currentSelection()`），零新增外部依赖、零硬编码模型。
 *   - 无 `llm` 服务 / 无默认模型 / 抛错 / 流中断 / 超时 / 超预算 / JSON 非法 → **不报错**，
 *     `degraded:true` + 确定性检查结果（AC-R6），默认不阻断定稿/导出（AC-R7）。
 *   - agent-mediated 两段式：`deep:true` 在无模型时返回「待审切片 + rubric + 确定性预检 + saveHint」，
 *     Agent 判断后调用 `drama_check_consistency({title, episode, saveReview:{findings,summary,meta?}})` 保存。
 *
 * 结果持久化：`<项目>/.aidrama/reviews/<episode>-<ts>.json`（原子写），并原子更新 `.aidrama/reviews/latest.json`
 *   （E6.1：doc-read 只读该精确路径；doc-save 不扩；不随导出）。
 *
 * 预算（Q2）：单集 tokens ≤ 60k、耗时 ≤ 60s；工具层默认 timeout 45s 给收尾留余量，可由工具参数覆盖。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import * as store from './store.js'
import { checkConsistency } from './consistency.js'

export const REVIEW_SCHEMA_VERSION = 1
export const REVIEWS_DIR = '.aidrama/reviews'
export const LATEST_REVIEW_RELATIVE = `${REVIEWS_DIR}/latest.json`
export const LATEST_REVIEW_PATH = LATEST_REVIEW_RELATIVE

export const DEFAULT_AUDIT_TOKEN_BUDGET = 60000
export const DEFAULT_AUDIT_TIMEOUT_MS = 45000
export const MAX_AUDIT_TIMEOUT_MS = 60000
export const DEFAULT_AUDIT_OUTPUT_TOKENS = 4000
export const MAX_AUDIT_OUTPUT_TOKENS = 16000
export const DEFAULT_AUDIT_TEMPERATURE = 0.2
export const MAX_REVIEW_FINDINGS = 50

/** Q4 七维度（键 → 中文标签；client 按同一映射展示）。 */
export const AUDIT_DIMENSIONS = [
  { key: 'hook_pacing', label: '钩子/节奏', checklist: ['前 3 秒/首镜是否有钩子', '本集是否有反转或悬念推进', '是否存在无效铺垫/拖沓段落', '集尾是否留扣'] },
  { key: 'character', label: '人设一致性', checklist: ['角色行为是否符合人物卡动机/性格', '称谓/关系是否前后矛盾', '是否出现人物卡外的角色'] },
  { key: 'shootability', label: '可拍性', checklist: ['分镜是否可实际拍摄（场景/道具/动作明确）', '是否有无法呈现的抽象描述', '镜头时长是否现实', '是否缺少关键镜头'] },
  { key: 'dialogue', label: '台词', checklist: ['是否有水词/重复信息', '台词是否符合人物口吻', '是否信息量低或难以表演'] },
  { key: 'platform_redline', label: '平台红线', checklist: ['是否含违规/敏感内容', '是否触碰平台审核风险（擦边/暴力/迷信等）'] },
  { key: 'memory_foreshadow', label: '记忆/伏笔', checklist: ['是否与前集/本剧记忆冲突', '伏笔是否埋设/回收合理', '是否遗漏已埋伏笔'] },
  { key: 'timeline', label: '时间线', checklist: ['事件顺序/时间推进是否自洽', '支线与主线时间是否冲突'] },
]
export const AUDIT_DIMENSION_KEYS = AUDIT_DIMENSIONS.map((item) => item.key)
export const AUDIT_DIMENSION_LABELS = Object.fromEntries(AUDIT_DIMENSIONS.map((item) => [item.key, item.label]))
export const AUDIT_SEVERITIES = ['high', 'medium', 'low']

const DIMENSION_ALIASES = {
  hook: 'hook_pacing',
  hook_pacing: 'hook_pacing',
  pacing: 'hook_pacing',
  钩子: 'hook_pacing',
  节奏: 'hook_pacing',
  钩子节奏: 'hook_pacing',
  character: 'character',
  人设: 'character',
  人设一致性: 'character',
  shootability: 'shootability',
  可拍性: 'shootability',
  dialogue: 'dialogue',
  台词: 'dialogue',
  platform_redline: 'platform_redline',
  redline: 'platform_redline',
  平台红线: 'platform_redline',
  红线: 'platform_redline',
  memory_foreshadow: 'memory_foreshadow',
  memory: 'memory_foreshadow',
  foreshadow: 'memory_foreshadow',
  记忆: 'memory_foreshadow',
  伏笔: 'memory_foreshadow',
  记忆伏笔: 'memory_foreshadow',
  timeline: 'timeline',
  时间线: 'timeline',
}
const SEVERITY_ALIASES = {
  high: 'high',
  medium: 'medium',
  low: 'low',
  高: 'high',
  中: 'medium',
  低: 'low',
  error: 'high',
  warn: 'medium',
  warning: 'medium',
  info: 'low',
}
const REVIEW_READ_RE = /^\.aidrama\/reviews\/latest\.json$/i

/** E6.1：doc-read 白名单只读内部路径判定（其他 `.aidrama/*` 仍拒绝；doc-save 不扩）。 */
export function normalizeReviewReadPath(relPath) {
  const raw = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim()
  return REVIEW_READ_RE.test(raw) ? LATEST_REVIEW_PATH : null
}

export function isAuditSupportedEpisode(episode) {
  const order = Number(episode)
  return Number.isFinite(order) && Number.isInteger(order) && order >= 1 && order <= 9999
}

function normalizeEpisode(episode) {
  const order = Number(episode)
  if (!isAuditSupportedEpisode(order)) throw new Error('episode 必须是 1~9999 的整数（Q7：先单集审读）')
  return order
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.round(num)))
}

export function resolveAuditBudgets(options = {}) {
  const temperature = Number(options.temperature)
  return {
    tokens: clampNumber(options.maxTokens, 1000, DEFAULT_AUDIT_TOKEN_BUDGET, DEFAULT_AUDIT_TOKEN_BUDGET),
    timeoutMs: clampNumber(options.timeoutMs, 1000, MAX_AUDIT_TIMEOUT_MS, DEFAULT_AUDIT_TIMEOUT_MS),
    outputTokens: clampNumber(options.outputTokens, 256, MAX_AUDIT_OUTPUT_TOKENS, DEFAULT_AUDIT_OUTPUT_TOKENS),
    // P2-6（Q4）：任务级 temperature 0~2，非法值回落默认 0.2（设置层已严格校验，此处为二次保险）
    temperature: Number.isFinite(temperature) && temperature >= 0 && temperature <= 2 ? Math.round(temperature * 100) / 100 : DEFAULT_AUDIT_TEMPERATURE,
  }
}

/** 粗估 tokens（CJK 约 1 字 ≈ 0.6~0.7 token；保守按 1.6 字符/token 估）。 */
export function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 1.6))
}

/**
 * D-12/P2-6：一次审读的共享运行上下文（跨「首次/重试/回退模型」统一约束超时与 token 预算，
 * 保证 AC-R5 语义不变：单次审读总 tokens ≤ budget、总耗时 ≤ timeoutMs）。
 */
export function createAuditRunContext(budgets) {
  const timeoutMs = Math.min(budgets.timeoutMs, MAX_AUDIT_TIMEOUT_MS)
  return {
    deadline: Date.now() + timeoutMs,
    tokenBudget: budgets.tokens,
    tokensUsed: 0,
    totals: { input: 0, output: 0, total: 0 },
    calls: 0,
    retried: false,
  }
}

function truncate(text, maxChars) {
  const value = String(text || '')
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 20))}\n…（已截断）`
}

/** 构建待审切片（确定性输入，agent-mediated 与模型调用共用；按预算裁剪）。 */
export async function buildAuditSlices(root, title, episode) {
  const order = normalizeEpisode(orderSafe(episode))
  const [contract, outline, characters, memory, episodes] = await Promise.all([
    store.getContract(root, title).catch(() => ({})),
    store.getOutline(root, title).catch(() => []),
    store.getCharacters(root, title).catch(() => []),
    store.getMemory(root, title).catch(() => ({})),
    store.listEpisodes(root, title).catch(() => []),
  ])
  const episodeMeta = episodes.find((item) => Number(item.order) === order)
  if (!episodeMeta) throw new Error(`第 ${order} 集不存在（请先写剧本）`)
  const episodeText = (await store.readEpisode(root, title, order).catch(() => null))?.text || ''
  if (!episodeText.trim()) throw new Error(`第 ${order} 集正文为空，无法审读`)
  const shots = await store.getStoryboard(root, title, order).catch(() => [])
  let previousTail = ''
  if (order > 1) {
    const previous = await store.readEpisode(root, title, order - 1).catch(() => null)
    previousTail = truncate(previous?.text || '', 1500)
  }
  const slices = {
    episode: order,
    episodeTitle: episodeMeta.title || `第${String(order).padStart(3, '0')}集`,
    contract: truncate(
      [
        `平台：${contract.platform || '未填'}`,
        `受众：${contract.audience || '未填'}`,
        `单集时长：${Array.isArray(contract.episodeDurationSec) ? contract.episodeDurationSec.join('~') : '?'} 秒`,
        `画幅：${contract.orientation || '未填'}`,
        `钩子密度：${contract.hookDensity || '未填'}`,
        contract.logline ? `一句话卖点：${contract.logline}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      2000,
    ),
    outline: outline
      .slice(0, 12)
      .map((row) => `第${row.order ?? '?'}集《${row.title || ''}》：${truncate(row.logline || '', 160)}；反转：${truncate(row.twist || '', 80)}`)
      .join('\n'),
    characters: characters
      .slice(0, 20)
      .map((item) => `${item.name || '?'}（${item.role || '角色'}）：${truncate(item.personality || item.description || '', 120)}；形象：${truncate(item.appearancePrompt || '', 80)}`)
      .join('\n'),
    memory: truncate(
      [memory.summary ? `本剧记忆：${memory.summary}` : '', memory.foreshadows ? `伏笔：${JSON.stringify(memory.foreshadows).slice(0, 1200)}` : '']
        .filter(Boolean)
        .join('\n'),
      3000,
    ),
    previousTail,
    episodeText: truncate(episodeText, 24000),
    storyboard: shots
      .slice(0, 60)
      .map(
        (shot) =>
          `${shot.shotNumber || '?'} ${shot.shotSize || ''} ${shot.cameraMove || ''}｜${truncate(shot.description || '', 120)}｜台词：${truncate(shot.dialogue || '', 80)}｜${shot.durationSec ?? '?'}s`,
      )
      .join('\n'),
  }
  const estimated = estimateTokens(JSON.stringify(slices))
  return { order, slices, estimatedInputTokens: estimated }
}

function orderSafe(value) {
  return value
}

/** 审读 rubric（agent-mediated 时给 Agent 的检查清单）。 */
export function buildRubric() {
  return AUDIT_DIMENSIONS.map((item) => ({ dimension: item.key, label: item.label, checklist: item.checklist }))
}

/** 给 Agent 的两段式请求包（无 llm 服务时返回；Agent 判断后 saveReview 保存）。 */
export function buildAgentAuditRequest({ slices, deterministic, budgets, saveHint }) {
  return {
    mode: 'agent-mediated',
    episode: slices.episode,
    slices,
    rubric: buildRubric(),
    deterministic,
    budget: { tokens: budgets.tokens, timeoutMs: budgets.timeoutMs },
    saveHint:
      saveHint ||
      `请按 rubric 判断后调用 drama_check_consistency({ title, episode: ${slices.episode}, saveReview: { findings: [...], summary: "..." } }) 保存结构化报告。`,
    schema: reviewSchemaDoc(),
  }
}

/** 报告 schema 文字说明（供 Agent 产出合法结构；AC-R4）。 */
export function reviewSchemaDoc() {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    findings: [
      {
        id: 'F1（可自动补）',
        severity: AUDIT_SEVERITIES.join('|'),
        dimension: AUDIT_DIMENSION_KEYS.join('|'),
        location: { episode: 'number', scene: 'number（≥1）', shot: '可选，镜号字符串/数字' },
        evidence: '原文片段或位置（必填）',
        suggestion: '可执行改法（必填）',
        confidence: '0~1',
        feedback: '可选 {verdict:"accepted|ignored|false-positive", note?}',
      },
    ],
    summary: '一句话总体结论',
    meta: { mode: 'agent-mediated|model|deterministic', model: '', tokens: { input: 0, output: 0, total: 0 }, elapsedMs: 0 },
  }
}

function normalizeLocation(raw, episode) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const location = { episode: normalizeInt(source.episode, episode, 1, 9999) }
  location.scene = normalizeInt(source.scene, 1, 1, 9999)
  if (source.shot !== undefined && source.shot !== null && String(source.shot).trim()) {
    location.shot = String(source.shot).trim().slice(0, 40)
  }
  return location
}

function normalizeInt(value, fallback, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.round(num)))
}

function normalizeSeverity(value) {
  const key = String(value || '')
    .trim()
    .toLowerCase()
  return SEVERITY_ALIASES[key] || SEVERITY_ALIASES[String(value || '').trim()] || 'medium'
}

function normalizeDimension(value) {
  const raw = String(value || '').trim()
  return DIMENSION_ALIASES[raw] || DIMENSION_ALIASES[raw.toLowerCase()] || 'hook_pacing'
}

function normalizeConfidence(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0.6
  return Math.min(1, Math.max(0, Math.round(num * 100) / 100))
}

/**
 * 归一 findings：裁剪/枚举纠正/去重/补 id；evidence 缺失的模型产出直接丢弃（AC-R3 误报控制）。
 * @param {Array} list
 * @param {number} episode
 * @param {{ keepWithoutEvidence?: boolean }} options
 */
export function normalizeFindings(list, episode, options = {}) {
  if (!Array.isArray(list)) return []
  const findings = []
  const seen = new Set()
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const evidence = String(raw.evidence || '').trim()
    if (!evidence && !options.keepWithoutEvidence) continue
    const location = normalizeLocation(raw.location, episode)
    const dimension = normalizeDimension(raw.dimension)
    const suggestion = String(raw.suggestion || '').trim() || '请结合上下文人工复核该处。'
    const key = `${dimension}|${location.episode}|${location.scene}|${location.shot || ''}|${truncate(evidence, 80)}`
    if (seen.has(key)) continue
    seen.add(key)
    const finding = {
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 20) : `F${findings.length + 1}`,
      severity: normalizeSeverity(raw.severity),
      dimension,
      location,
      evidence: truncate(evidence || '（未提供证据）', 600),
      suggestion: truncate(suggestion, 600),
      confidence: normalizeConfidence(raw.confidence),
      feedback: {},
    }
    if (raw.feedback && typeof raw.feedback === 'object') {
      const verdict = String(raw.feedback.verdict || '')
      if (['accepted', 'ignored', 'false-positive'].includes(verdict)) {
        finding.feedback = { verdict, ...(raw.feedback.note ? { note: String(raw.feedback.note).slice(0, 200) } : {}) }
      }
    }
    findings.push(finding)
    if (findings.length >= MAX_REVIEW_FINDINGS) break
  }
  return findings
}

/* ------------------- D-12：模型输出 JSON 容错修复（容错解析 + 截断补全） ------------------- */

function stripJsonFences(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim()
  return raw.trim()
}

/** 修复字符串内未转义的控制字符（换行/回车/制表等），保留其余内容。 */
function escapeControlCharsInStrings(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (const char of String(text)) {
    const code = char.charCodeAt(0)
    if (!inString) {
      out += char
      if (char === '"') inString = true
      continue
    }
    if (escaped) {
      out += char
      escaped = false
      continue
    }
    if (char === '\\') {
      out += char
      escaped = true
      continue
    }
    if (char === '"') {
      out += char
      inString = false
      continue
    }
    if (code < 0x20) {
      if (char === '\n') out += '\\n'
      else if (char === '\r') out += '\\r'
      else if (char === '\t') out += '\\t'
      else out += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    out += char
  }
  return out
}

/** 去尾逗号（`,]` / `,}`）。 */
function removeTrailingCommas(text) {
  return String(text).replace(/,\s*([}\]])/g, '$1')
}

/** 单引号 → 双引号（保守：仅处理 JSON 场景常见的键/字符串包裹）。 */
function convertSingleQuotes(text) {
  const source = String(text)
  if (!source.includes("'")) return source
  return source.replace(/'([^'"\n]*)'/g, '"$1"')
}

/** 截断补全：补齐未闭合的字符串与 [] {} 栈（模型 max-tokens 截断时最常见）。 */
function closeTruncatedJson(text) {
  const source = String(text)
  let inString = false
  let escaped = false
  const stack = []
  for (const char of source) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '[' || char === '{') stack.push(char)
    else if (char === ']' || char === '}') stack.pop()
  }
  let out = source
  if (inString) out += '"'
  while (stack.length) out += stack.pop() === '{' ? '}' : ']'
  return out
}

/** 截断兜底候选：从末尾逐个 '}' 处截断并补齐括号，最多尝试 40 个。 */
function salvageTruncatedCandidates(base) {
  const candidates = []
  const positions = []
  for (let index = base.length - 1; index >= 0 && positions.length < 40; index -= 1) {
    if (base[index] === '}') positions.push(index)
  }
  for (const position of positions) {
    try {
      candidates.push(closeTruncatedJson(base.slice(0, position + 1)))
    } catch {
      /* ignore */
    }
  }
  return candidates
}

/**
 * D-12：findings 数组截断兜底 —— 取「最后一个完整 finding 对象」之前的片段，
 * 重新包裹为 `{findings:[...],"summary":""}`（应对模型 max-tokens 截断在后续字段）。
 */
function salvageFindingsArray(base) {
  const keyIndex = base.indexOf('"findings"')
  if (keyIndex < 0) return null
  const arrayStart = base.indexOf('[', keyIndex)
  if (arrayStart < 0) return null
  const objectEnds = []
  let inString = false
  let escaped = false
  let depth = 0
  for (let index = arrayStart + 1; index < base.length; index += 1) {
    const char = base[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      if (depth > 0) {
        depth -= 1
        if (depth === 0) objectEnds.push(index)
      }
    }
  }
  for (let index = objectEnds.length - 1; index >= 0; index -= 1) {
    const candidate = `${base.slice(0, objectEnds[index] + 1)}],"summary":""}`
    try {
      const data = JSON.parse(candidate)
      if (data && Array.isArray(data.findings) && data.findings.length > 0) return { data, stage: 'salvage-findings' }
    } catch {
      /* try earlier complete finding */
    }
  }
  return null
}

/**
 * D-12：容错解析模型输出 → JSON 对象。
 * 依次尝试：去围栏原始 / 控制字符转义 / 去尾逗号 / 单引号转换 / 组合 / 截断补全 / 截断兜底。
 * @returns {{ok:true, data:object, stage:string}|{ok:false, error:string, snippet:string}}
 */
export function repairModelJsonText(text) {
  const raw = String(text || '')
  const snippet = raw.slice(0, 500)
  const stripped = stripJsonFences(raw)
  const start = stripped.indexOf('{')
  if (start < 0) return { ok: false, error: '模型未返回 JSON 对象', snippet }
  const end = stripped.lastIndexOf('}')
  const base = end > start ? stripped.slice(start, end + 1) : stripped.slice(start)
  const escaped = escapeControlCharsInStrings(base)
  const noTrailing = removeTrailingCommas(escaped)
  const candidates = [
    { stage: 'raw', value: base },
    { stage: 'escape-control', value: escaped },
    { stage: 'trailing-comma', value: noTrailing },
    { stage: 'single-quote', value: convertSingleQuotes(noTrailing) },
  ]
  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate.value)
      if (data && typeof data === 'object') return { ok: true, data, stage: candidate.stage }
    } catch {
      /* try next */
    }
  }
  // 截断补全（模型 max-tokens 截断）：先补闭合符，再 salvage findings 数组，最后逐个 '}' 截断兜底
  const closed = closeTruncatedJson(noTrailing)
  try {
    const data = JSON.parse(closed)
    if (data && typeof data === 'object') return { ok: true, data, stage: 'close-truncated' }
  } catch {
    /* ignore */
  }
  const salvagedFindings = salvageFindingsArray(noTrailing)
  if (salvagedFindings) return { ok: true, data: salvagedFindings.data, stage: salvagedFindings.stage }
  for (const candidate of salvageTruncatedCandidates(noTrailing)) {
    try {
      const data = JSON.parse(candidate)
      if (data && typeof data === 'object') return { ok: true, data, stage: 'salvage-truncated' }
    } catch {
      /* try next */
    }
  }
  const firstError = (() => {
    try {
      JSON.parse(candidates[0].value)
      return ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })()
  return { ok: false, error: firstError || '无法解析为 JSON', snippet }
}

/** 从模型文本提取 JSON（容忍围栏/杂文/控制字符/尾逗号/单引号/截断）。 */
export function extractReviewJson(text) {
  const repaired = repairModelJsonText(text)
  if (!repaired.ok) throw new Error(repaired.error || '模型未返回可解析的 JSON 对象')
  return repaired.data
}

/** 解析并校验模型审读文本 → 报告（不落盘）。 */
export function parseModelReviewText(text, { episode, provider, model, tokens, elapsedMs, budget, modelInfo }) {
  const parsed = extractReviewJson(text)
  const findings = normalizeFindings(parsed.findings, episode)
  if (!findings.length) throw new Error('模型返回的 findings 为空或缺少 evidence')
  const report = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    ok: true,
    episode,
    generatedAt: new Date().toISOString(),
    degraded: false,
    degradeReason: null,
    findings,
    summary: truncate(String(parsed.summary || '').trim() || `共 ${findings.length} 条审读建议`, 500),
    meta: {
      mode: 'model',
      model: model || '',
      provider: provider || '',
      tokens: tokens || { input: 0, output: 0, total: 0 },
      elapsedMs: Number(elapsedMs) || 0,
      budget: budget || { tokens: DEFAULT_AUDIT_TOKEN_BUDGET, timeoutMs: DEFAULT_AUDIT_TIMEOUT_MS },
      degraded: false,
      degradeReason: null,
      // P2-6（Q2/Q3）：实际使用的模型来源与回退标记
      modelSource: modelInfo && typeof modelInfo.source === 'string' ? modelInfo.source : 'agent-default',
      modelFallback: Boolean(modelInfo && modelInfo.modelFallback),
      modelFallbackReason:
        modelInfo && modelInfo.modelFallbackReason ? String(modelInfo.modelFallbackReason).slice(0, 200) : null,
      // D-12：是否发生过 JSON 修复重试 / 原始输出片段（仅诊断用）
      modelRetried: Boolean(modelInfo && modelInfo.modelRetried),
      rawModelOutputSnippet: modelInfo && modelInfo.rawModelOutputSnippet ? String(modelInfo.rawModelOutputSnippet).slice(0, 500) : null,
    },
    file: null,
    feedback: {},
  }
  const schema = assertReviewSchema(report)
  if (!schema.ok) {
    const error = new Error(`模型审读结果未通过 schema 校验：${schema.errors.slice(0, 3).join('；')}`)
    error.code = 'invalid-args'
    throw error
  }
  return report
}

/** AC-R4：报告 schema 校验（不抛错，返回 {ok, errors}）。 */
export function assertReviewSchema(review) {
  const errors = []
  if (!review || typeof review !== 'object') return { ok: false, errors: ['报告不是对象'] }
  if (review.schemaVersion !== REVIEW_SCHEMA_VERSION) errors.push('schemaVersion 必须为 1')
  if (!isAuditSupportedEpisode(review.episode)) errors.push('episode 必须是 1~9999 整数')
  if (typeof review.degraded !== 'boolean') errors.push('degraded 必须是布尔值')
  if (!Array.isArray(review.findings)) errors.push('findings 必须是数组')
  else if (review.findings.length > MAX_REVIEW_FINDINGS) errors.push(`findings 超过 ${MAX_REVIEW_FINDINGS} 条`)
  else {
    for (const [index, finding] of review.findings.entries()) {
      const where = `findings[${index}]`
      if (!finding || typeof finding !== 'object') {
        errors.push(`${where} 不是对象`)
        continue
      }
      if (typeof finding.id !== 'string' || !finding.id) errors.push(`${where}.id 缺失`)
      if (!AUDIT_SEVERITIES.includes(finding.severity)) errors.push(`${where}.severity 不合法`)
      if (!AUDIT_DIMENSION_KEYS.includes(finding.dimension)) errors.push(`${where}.dimension 不合法`)
      if (!finding.location || !isAuditSupportedEpisode(finding.location.episode)) errors.push(`${where}.location.episode 不合法`)
      else if (!Number.isInteger(finding.location.scene) || finding.location.scene < 1) errors.push(`${where}.location.scene 必须是 ≥1 整数`)
      else if (finding.location.shot !== undefined && typeof finding.location.shot !== 'string') errors.push(`${where}.location.shot 必须是字符串`)
      if (typeof finding.evidence !== 'string' || !finding.evidence.trim()) errors.push(`${where}.evidence 缺失`)
      if (typeof finding.suggestion !== 'string' || !finding.suggestion.trim()) errors.push(`${where}.suggestion 缺失`)
      if (typeof finding.confidence !== 'number' || finding.confidence < 0 || finding.confidence > 1) errors.push(`${where}.confidence 必须在 0~1`)
    }
  }
  if (typeof review.summary !== 'string') errors.push('summary 必须是字符串')
  if (!review.meta || typeof review.meta !== 'object' || typeof review.meta.degraded !== 'boolean') errors.push('meta.degraded 必须是布尔值')
  else {
    if (!review.meta.tokens || typeof review.meta.tokens !== 'object') errors.push('meta.tokens 必须是对象')
    if (typeof review.meta.elapsedMs !== 'number') errors.push('meta.elapsedMs 必须是数字')
    if (review.meta.model !== undefined && typeof review.meta.model !== 'string') errors.push('meta.model 必须是字符串')
    // P2-6：任务级模型参数的可选元数据（只增字段）
    if (review.meta.modelSource !== undefined && typeof review.meta.modelSource !== 'string') errors.push('meta.modelSource 必须是字符串')
    if (review.meta.modelFallback !== undefined && typeof review.meta.modelFallback !== 'boolean') errors.push('meta.modelFallback 必须是布尔值')
    if (
      review.meta.modelFallbackReason !== undefined &&
      review.meta.modelFallbackReason !== null &&
      typeof review.meta.modelFallbackReason !== 'string'
    ) {
      errors.push('meta.modelFallbackReason 必须是字符串或 null')
    }
    // D-12：降级可观测性字段（只增、可选）
    if (review.meta.modelRetried !== undefined && typeof review.meta.modelRetried !== 'boolean') errors.push('meta.modelRetried 必须是布尔值')
    if (
      review.meta.rawModelOutputSnippet !== undefined &&
      review.meta.rawModelOutputSnippet !== null &&
      typeof review.meta.rawModelOutputSnippet !== 'string'
    ) {
      errors.push('meta.rawModelOutputSnippet 必须是字符串或 null')
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 降级报告（AC-R6）：确定性结果 + degraded 标记，不抛错。
 * D-12：保留可观测性 —— attempted 记录「实际尝试的模型/provider/来源/回退信息」，
 *        rawSnippet 记录模型原始输出片段（≤500 字符，仅存报告文件供诊断）。
 */
export function buildDegradedReview({ episode, deterministic, degradeReason, budgets, attempted, rawSnippet }) {
  const attemptedInfo = attempted && typeof attempted === 'object' ? attempted : {}
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    ok: true,
    episode,
    generatedAt: new Date().toISOString(),
    degraded: true,
    degradeReason: String(degradeReason || 'audit-unavailable').slice(0, 200),
    findings: [],
    summary: '模型审读不可用，已降级为确定性检查；请参考 report.issues 处理硬规则问题。',
    meta: {
      mode: 'deterministic',
      // 降级也保留实际尝试的模型（不再清空，P2-6 运行期证据可观测）
      model: typeof attemptedInfo.model === 'string' ? attemptedInfo.model : '',
      provider: typeof attemptedInfo.provider === 'string' ? attemptedInfo.provider : '',
      tokens: {
        input: Number(attemptedInfo.tokens?.input) || 0,
        output: Number(attemptedInfo.tokens?.output) || 0,
        total: Number(attemptedInfo.tokens?.total) || 0,
      },
      elapsedMs: Number(attemptedInfo.elapsedMs) || 0,
      budget: { tokens: budgets.tokens, timeoutMs: budgets.timeoutMs },
      degraded: true,
      degradeReason: String(degradeReason || 'audit-unavailable').slice(0, 200),
      modelSource: typeof attemptedInfo.source === 'string' ? attemptedInfo.source : 'none',
      modelFallback: Boolean(attemptedInfo.modelFallback),
      modelFallbackReason: attemptedInfo.modelFallbackReason || null,
      modelRetried: Boolean(attemptedInfo.retried),
      rawModelOutputSnippet: rawSnippet ? String(rawSnippet).slice(0, 500) : null,
    },
    deterministic: deterministic || null,
    file: null,
    feedback: {},
  }
}

function reviewFileName(episode, now = new Date()) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  return `${episode}-${stamp}.json`
}

/** 报告目录（项目内 `.aidrama/reviews`）。 */
export function reviewsDir(root, title) {
  return path.join(store.projectDir(root, title), '.aidrama', 'reviews')
}

/** 原子保存报告 + 原子更新 latest.json（E6.1）。 */
export async function saveReview(root, title, review) {
  const schema = assertReviewSchema(review)
  if (!schema.ok) {
    const error = new Error(`审读报告 schema 校验失败：${schema.errors.slice(0, 3).join('；')}`)
    error.code = 'invalid-args'
    throw error
  }
  const dir = reviewsDir(root, title)
  await fs.mkdir(dir, { recursive: true })
  const baseName = reviewFileName(review.episode)
  let fileName = baseName
  for (let index = 2; index <= 20; index += 1) {
    try {
      await fs.access(path.join(dir, fileName))
      fileName = baseName.replace(/\.json$/, `-${index}.json`)
    } catch {
      break
    }
  }
  const fileRelative = `reviews/${fileName}`
  const payload = { ...review, file: fileRelative }
  const text = `${JSON.stringify(payload, null, 2)}\n`
  await store.atomicWrite(path.join(dir, fileName), text)
  await store.atomicWrite(path.join(dir, 'latest.json'), text)
  return { file: fileRelative, latestPath: LATEST_REVIEW_PATH, text, review: payload }
}

/** doc-read E6.1：读取 latest.json（不存在返回 null；损坏返回 null 由调用方 404/提示）。 */
export async function readLatestReview(root, title) {
  try {
    const file = path.join(reviewsDir(root, title), 'latest.json')
    const text = await fs.readFile(file, 'utf8')
    const stat = await fs.stat(file)
    JSON.parse(text)
    return { text, updatedAt: stat.mtime.toISOString(), bytes: Buffer.byteLength(text, 'utf8') }
  } catch {
    return null
  }
}

/** Agent-mediated 保存入口：`saveReview` 参数 → 结构化报告 → 落盘。 */
export function normalizeSaveReviewInput(input, { episode }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('saveReview 必须是对象')
  if (!Array.isArray(input.findings)) throw new Error('saveReview.findings 必须是数组')
  if (input.findings.length > MAX_REVIEW_FINDINGS) throw new Error(`saveReview.findings 超过 ${MAX_REVIEW_FINDINGS} 条`)
  const findings = normalizeFindings(input.findings, episode, { keepWithoutEvidence: true })
  const review = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    ok: true,
    episode,
    generatedAt: new Date().toISOString(),
    degraded: false,
    degradeReason: null,
    findings,
    summary: truncate(String(input.summary || '').trim() || `共 ${findings.length} 条审读建议`, 500),
    meta: {
      mode: 'agent-mediated',
      model: typeof input.meta?.model === 'string' ? input.meta.model.slice(0, 120) : '',
      provider: typeof input.meta?.provider === 'string' ? input.meta.provider.slice(0, 80) : '',
      tokens: {
        input: normalizeInt(input.meta?.tokens?.input, 0, 0, 1e9),
        output: normalizeInt(input.meta?.tokens?.output, 0, 0, 1e9),
        total: normalizeInt(input.meta?.tokens?.total, 0, 0, 1e9),
      },
      elapsedMs: normalizeInt(input.meta?.elapsedMs, 0, 0, 3_600_000),
      budget: {
        tokens: DEFAULT_AUDIT_TOKEN_BUDGET,
        timeoutMs: DEFAULT_AUDIT_TIMEOUT_MS,
      },
      degraded: false,
      degradeReason: null,
    },
    file: null,
    feedback: input.feedback && typeof input.feedback === 'object' ? input.feedback : {},
  }
  const schema = assertReviewSchema(review)
  if (!schema.ok) {
    const error = new Error(`saveReview 未通过 schema 校验：${schema.errors.slice(0, 3).join('；')}`)
    error.code = 'invalid-args'
    throw error
  }
  return review
}

/* ------------------------------------------------------------------ 模型调用 */

function buildSystemPrompt() {
  return [
    '你是资深短剧审读编辑。任务：对用户提供的单集内容做结构化审读，只输出一个 JSON 对象，不要输出任何其它文字。',
    '审读维度（dimension 必须用英文键）：',
    ...AUDIT_DIMENSIONS.map((item) => `- ${item.key}（${item.label}）：${item.checklist.join('；')}`),
    '输出 JSON schema：',
    '{"findings":[{"severity":"high|medium|low","dimension":"上面英文键之一","location":{"episode":数字,"scene":数字（≥1）,"shot":"可选镜号"},"evidence":"原文片段或位置（必填）","suggestion":"可执行改法（必填）","confidence":0到1}],"summary":"一句话总体结论"}',
    '要求：① 每条 finding 必须有 evidence（原文片段/位置）；② 不确定的不要报（误报有预算限制）；③ 不要输出 markdown / 代码围栏；④ 目标 3~12 条高质量问题，按严重度排序。',
  ].join('\n')
}

function buildUserPrompt({ slices, deterministic }) {
  const issues = (deterministic && deterministic.issues) || []
  const deterministicText = issues.length
    ? issues
        .slice(0, 30)
        .map((item) => `- [${item.severity}] ${item.message}${item.where ? `（${item.where}）` : ''}`)
        .join('\n')
    : '（无确定性规则问题）'
  return [
    `## 项目契约\n${slices.contract}`,
    slices.outline ? `## 分集大纲\n${slices.outline}` : '',
    slices.characters ? `## 人物卡\n${slices.characters}` : '',
    slices.memory ? `## 本剧记忆/伏笔\n${slices.memory}` : '',
    slices.previousTail ? `## 上一集结尾（用于衔接/时间线判断）\n${slices.previousTail}` : '',
    `## 待审第 ${slices.episode} 集正文（${slices.episodeTitle}）\n${slices.episodeText}`,
    slices.storyboard ? `## 本集分镜\n${slices.storyboard}` : '（本集暂无分镜，可拍性维度只做剧本层面判断）',
    `## 确定性预检结果（已由规则发现，可参考但不要重复罗列）\n${deterministicText}`,
    '## 审读对象\n只审「待审第 N 集正文」这一集；location.episode 固定为该集集数，scene 用正文中的场景序号。',
    '请输出 JSON。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** D-12：单次模型流式调用（受剩余超时约束；返回文本/用量/finish；失败不抛错）。 */
async function collectModelStream({ llm, provider, model, system, messages, maxTokens, temperature, timeoutMs }) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      controller.abort(new Error('audit-timeout'))
    } catch {
      /* ignore */
    }
  }, Math.max(500, timeoutMs))
  const startedAt = Date.now()
  let text = ''
  let usage = null
  let finish = null
  try {
    const stream = llm.stream({ provider, model, system, messages, maxTokens, temperature, signal: controller.signal })
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') {
        text += chunk.text || ''
        if (estimateTokens(text) > maxTokens * 2) {
          try {
            controller.abort(new Error('output-too-long'))
          } catch {
            /* ignore */
          }
          break
        }
      } else if (chunk.type === 'usage') {
        usage = chunk.usage || null
      } else if (chunk.type === 'finish') {
        finish = chunk.reason || null
      }
    }
  } catch (error) {
    const reason = timedOut ? 'audit-timeout' : `model-call-failed: ${error instanceof Error ? error.message : String(error)}`
    return { ok: false, reason: reason.slice(0, 200) }
  } finally {
    clearTimeout(timer)
    if (!controller.signal.aborted) {
      try {
        controller.abort(new Error('audit-finished'))
      } catch {
        /* ignore */
      }
    }
  }
  const elapsedMs = Math.max(0, Date.now() - startedAt)
  if (timedOut) return { ok: false, reason: 'audit-timeout' }
  if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
    return { ok: false, reason: `model-call-failed: ${finish.failure?.message || finish.kind}`.slice(0, 200) }
  }
  const inputTokens =
    usage && Number.isFinite(usage.inputTokens)
      ? usage.inputTokens
      : estimateTokens(system || '') + estimateTokens((messages || []).map((message) => JSON.stringify(message)).join('\n'))
  const outputTokens = usage && Number.isFinite(usage.outputTokens) ? usage.outputTokens : estimateTokens(text)
  const total = usage && Number.isFinite(usage.totalTokens) ? usage.totalTokens : inputTokens + outputTokens
  return {
    ok: true,
    text,
    elapsedMs,
    finish,
    tokens: { input: inputTokens, output: outputTokens, total: Math.max(total, inputTokens + outputTokens) },
  }
}

const REPAIR_INSTRUCTION =
  '\n\n---\n【修复要求】你上一次的输出不是合法 JSON（原因：%REASON%）。请重新输出：只输出一个合法 JSON 对象；不要 ``` 围栏、不要注释、不要尾逗号；字符串内不要出现未转义换行/制表符；findings 控制在 8 条以内，summary 不超过 80 字；JSON 必须完整闭合。'

/**
 * 直连宿主模型审读。
 * D-12：容错 JSON 修复（围栏/未转义控制字符/尾逗号/单引号/截断补全）；仍失败则**向模型重试一次**
 * （附「只输出合法 JSON」修复提示），再失败才降级；降级返回 attempted 模型信息与 rawSnippet 便于诊断。
 * @param {{ llm?: object, selection?: object, slices: object, deterministic: object, episode: number, budgets: object, context?: object }} deps
 * @returns {Promise<{ok:true, review:object}|{ok:false, degradeReason:string, attempted:object, rawSnippet?:string}>}
 */
export async function runModelAudit({ llm, selection, model: resolvedModel, slices, deterministic, episode, budgets, context }) {
  if (!llm || typeof llm.stream !== 'function') return { ok: false, degradeReason: 'llm-service-unavailable', attempted: {} }
  // P2-6（Q2）：优先使用回退链解析出的模型（taskModels → settings.defaultModel → agentDefaultModel），
  // 缺省（未配置/旧调用）沿用 selection，行为与 v0.6.0 完全一致。
  const target =
    resolvedModel && typeof resolvedModel === 'object' && typeof resolvedModel.model === 'string' && resolvedModel.model
      ? resolvedModel
      : selection
  const provider = target && typeof target.provider === 'string' ? target.provider : ''
  const model = target && typeof target.model === 'string' ? target.model : ''
  const modelInfo = target
    ? {
        source: typeof target.source === 'string' ? target.source : 'agent-default',
        modelFallback: Boolean(target.modelFallback),
        modelFallbackReason: target.modelFallbackReason || null,
      }
    : null
  const attemptedBase = {
    model,
    provider,
    source: modelInfo?.source || 'agent-default',
    modelFallback: Boolean(modelInfo?.modelFallback),
    modelFallbackReason: modelInfo?.modelFallbackReason || null,
  }
  if (!provider || !model) return { ok: false, degradeReason: 'no-default-model', attempted: attemptedBase }
  const runContext = context || createAuditRunContext(budgets)
  if (!runContext.startedAt) runContext.startedAt = Date.now()
  const remainingMs = () => Math.max(0, runContext.deadline - Date.now())
  const remainingTokens = () => Math.max(0, runContext.tokenBudget - runContext.tokensUsed)
  const system = buildSystemPrompt()
  const user = buildUserPrompt({ slices, deterministic })
  const baseInputTokens = estimateTokens(system) + estimateTokens(user)
  if (baseInputTokens > remainingTokens()) {
    return { ok: false, degradeReason: 'token-budget-exceeded', attempted: { ...attemptedBase, retried: false, tokens: runContext.totals } }
  }
  let aggregate = { input: 0, output: 0, total: 0 }
  let lastReason = ''
  let lastSnippet = ''
  let retried = false
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt === 2) {
      if (remainingMs() < 2000 || remainingTokens() < baseInputTokens + 256) break
      retried = true
      runContext.retried = true
    }
    const attemptUser = attempt === 1 ? user : `${user}${REPAIR_INSTRUCTION.replace('%REASON%', (lastReason || '未知').slice(0, 120))}`
    const attemptInputTokens = estimateTokens(system) + estimateTokens(attemptUser)
    const outputCap = Math.max(256, Math.min(budgets.outputTokens, remainingTokens() - attemptInputTokens))
    const collected = await collectModelStream({
      llm,
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: attemptUser }] }],
      maxTokens: outputCap,
      temperature: budgets.temperature,
      timeoutMs: Math.min(budgets.timeoutMs, Math.max(1000, remainingMs())),
    })
    if (!collected.ok) {
      // D-12：传输/超时类失败不重试同模型（直接交给上层回退模型或降级），只有「有输出但格式坏」才重试。
      lastReason = collected.reason
      break
    }
    runContext.calls += 1
    runContext.tokensUsed += collected.tokens.total
    aggregate = {
      input: aggregate.input + collected.tokens.input,
      output: aggregate.output + collected.tokens.output,
      total: aggregate.total + collected.tokens.total,
    }
    runContext.totals = aggregate
    if (!collected.text.trim()) {
      lastReason = collected.finish && collected.finish.kind === 'max-tokens' ? 'empty-model-output(finish=max-tokens)' : 'empty-model-output'
      lastSnippet = collected.text || ''
      if (attempt === 1 && remainingMs() >= 2000 && remainingTokens() >= baseInputTokens + 256) continue
      break
    }
    if (aggregate.total > runContext.tokenBudget) {
      lastReason = 'token-budget-exceeded'
      break
    }
    lastSnippet = collected.text
    try {
      const review = parseModelReviewText(collected.text, {
        episode,
        provider,
        model,
        tokens: aggregate,
        elapsedMs: Math.max(0, Date.now() - runContext.startedAt),
        budget: { tokens: budgets.tokens, timeoutMs: budgets.timeoutMs },
        modelInfo: { ...modelInfo, modelRetried: retried, rawModelOutputSnippet: null },
      })
      return { ok: true, review }
    } catch (error) {
      lastReason = `invalid-model-output: ${error instanceof Error ? error.message : String(error)}`
      if (attempt === 1 && remainingMs() >= 2000 && remainingTokens() >= baseInputTokens + 256) continue
      break
    }
  }
  return {
    ok: false,
    degradeReason: (lastReason || 'invalid-model-output').slice(0, 200),
    attempted: { ...attemptedBase, retried, tokens: aggregate, elapsedMs: Math.max(0, Date.now() - runContext.startedAt) },
    rawSnippet: String(lastSnippet || '').slice(0, 500),
  }
}

/* ------------------------------------------- P2-6：任务级模型解析与回退 */

/** 解析 `provider/model` 或纯 model 名称。 */
export function parseModelSpec(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  if (raw.includes('/')) {
    const [provider, ...rest] = raw.split('/')
    const model = rest.join('/').trim()
    if (provider.trim() && model) return { provider: provider.trim(), model }
    return null
  }
  return { provider: '', model: raw }
}

/**
 * P2-6（Q2/Q3）：按回退链解析审读实际使用的模型。
 * `settings.taskModels[task] → settings.defaultModel → agentDefaultModel.currentSelection()`；
 * 配置的模型做**运行时探测**（`llm.resolveModelInfo`），不可用则继续回退并标记 `modelFallback:true`。
 * 不报错；无任何可用候选时返回 null（工具层走既有 degraded 兜底）。
 * @returns {Promise<{provider:string, model:string, source:'task-model'|'settings-default'|'agent-default', config:object, modelFallback:boolean, modelFallbackReason:string|null}|null>}
 */
export async function resolveAuditModel({ settings, defaultSelection, llm, task = 'audit' } = {}) {
  const safeSettings = settings && typeof settings === 'object' ? settings : {}
  const taskConfigSource = safeSettings.taskModels && typeof safeSettings.taskModels === 'object' ? safeSettings.taskModels[task] : undefined
  const taskConfig = taskConfigSource && typeof taskConfigSource === 'object' ? taskConfigSource : {}
  const candidates = []

  if (typeof taskConfig.model === 'string' && taskConfig.model.trim()) {
    candidates.push({
      provider: typeof taskConfig.provider === 'string' && taskConfig.provider ? taskConfig.provider : defaultSelection?.provider || '',
      model: taskConfig.model.trim(),
      source: 'task-model',
      config: taskConfig,
    })
  }
  const parsedDefault = parseModelSpec(safeSettings.defaultModel)
  if (parsedDefault) {
    candidates.push({
      provider: parsedDefault.provider || (defaultSelection && typeof defaultSelection.provider === 'string' ? defaultSelection.provider : ''),
      model: parsedDefault.model,
      source: 'settings-default',
      config: taskConfig,
    })
  }
  if (defaultSelection && typeof defaultSelection.provider === 'string' && typeof defaultSelection.model === 'string' && defaultSelection.provider && defaultSelection.model) {
    candidates.push({ provider: defaultSelection.provider, model: defaultSelection.model, source: 'agent-default', config: taskConfig })
  }
  if (!candidates.length) return null

  let fallbackReason = ''
  for (const candidate of candidates) {
    if (candidate.source !== 'agent-default' && llm && typeof llm.resolveModelInfo === 'function') {
      try {
        await llm.resolveModelInfo(candidate.provider, candidate.model)
      } catch (error) {
        fallbackReason = `配置模型不可用（${candidate.provider ? `${candidate.provider}/` : ''}${candidate.model}）：${
          error instanceof Error ? error.message : String(error)
        }`.slice(0, 200)
        continue
      }
    }
    return {
      ...candidate,
      modelFallback: Boolean(fallbackReason),
      modelFallbackReason: fallbackReason || null,
    }
  }
  return null
}

/**
 * P2-6（Q3）：先按解析出的模型审读；若失败且存在宿主默认模型，则回退重试一次并标记 modelFallback。
 * 不抛错；最终失败仍返回原失败原因（工具层走 degraded 兜底）。
 */
export async function runAuditWithFallback({ llm, resolved, fallbackModel, slices, deterministic, episode, budgets, context }) {
  const runContext = context || createAuditRunContext(budgets)
  const first = await runModelAudit({ llm, model: resolved, slices, deterministic, episode, budgets, context: runContext })
  if (first.ok) return { outcome: first, usedModel: resolved }
  const budgetLeft = runContext.deadline - Date.now() > 2000 && runContext.tokenBudget - runContext.tokensUsed > 2000
  const canRetry =
    budgetLeft &&
    fallbackModel &&
    typeof fallbackModel.provider === 'string' &&
    fallbackModel.provider &&
    typeof fallbackModel.model === 'string' &&
    fallbackModel.model &&
    !(resolved && resolved.source === 'agent-default')
  if (!canRetry) return { outcome: first, usedModel: resolved }
  const retryModel = {
    provider: fallbackModel.provider,
    model: fallbackModel.model,
    source: 'agent-default',
    config: resolved?.config || {},
    modelFallback: true,
    modelFallbackReason: `配置模型失败（${first.degradeReason}），已回退宿主默认模型`,
  }
  const retry = await runModelAudit({ llm, model: retryModel, slices, deterministic, episode, budgets, context: runContext })
  if (retry.ok) return { outcome: retry, usedModel: retryModel }
  return { outcome: first, usedModel: resolved }
}
