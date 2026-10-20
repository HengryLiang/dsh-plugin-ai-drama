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
import { COST_TIERS, costTierOverrideOf, isCostTier } from './model-routing.js'

export const REVIEW_SCHEMA_VERSION = 1
/** P3-F/P3-F2（v0.8.0）：审读 prompt/rubric 版本号（写入报告 meta 便于前后对比与回放对应）。 */
export const AUDIT_PROMPT_VERSION = 'v0.8.0-f1'
/** P3-F2/P3-C/P3-C2：prompt 修订号（同版本内热修可区分；随 meta.promptRevision 只增字段写入）。 */
export const AUDIT_PROMPT_REVISION = 'f4'
/** P3-F2：模型审读输出长度约束（降低 tokens/延迟，避免长输出撞 45s 默认超时降级）。 */
export const MODEL_OUTPUT_LIMITS = { findings: 6, evidence: 60, suggestion: 80, summary: 60 }
/** P3-F2：默认预算 45s 下模型单次调用内部放宽到 55s（仍 ≤ MAX_AUDIT_TIMEOUT_MS=60s；显式更小 timeoutMs 优先）。 */
export const MODEL_AUDIT_INTERNAL_TIMEOUT_MS = 55000

/** P3-F2：模型调用实际超时上限；默认预算（≥45s）→ 55s，显式更小配置（如任务级 20s）保持原值。 */
export function auditModelCallTimeoutMs(budgets = {}) {
  const configured = Number(budgets.timeoutMs)
  const base = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_AUDIT_TIMEOUT_MS
  const effective = base >= DEFAULT_AUDIT_TIMEOUT_MS ? Math.max(base, MODEL_AUDIT_INTERNAL_TIMEOUT_MS) : base
  return Math.min(MAX_AUDIT_TIMEOUT_MS, Math.max(1000, Math.round(effective)))
}
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
  {
    key: 'hook_pacing',
    label: '钩子/节奏',
    guidance: '开场 3 秒/首镜无冲突无悬念、信息缺口不足、无效铺垫拖沓、集尾无扣 → 归此类；「人物言行违背人物卡」不得归此类。',
    checklist: ['前 3 秒/首镜是否有钩子（冲突/悬念/信息缺口）', '本集是否有反转或悬念推进', '是否存在无效铺垫/拖沓段落', '集尾是否留扣'],
  },
  {
    key: 'character',
    label: '人设一致性',
    guidance:
      '角色动作/决策/台词/称谓/关系违背人物卡（姓名/身份/性格 3 条/底线/禁忌/口头禅/目标/关系）→ 归此类；但若问题本质是平台红线/前后矛盾/伏笔/时间线，按本质归因（见归因正反例）。',
    checklist: [
      '角色动作/决策是否符合人物卡性格、底线与目标',
      '台词是否符合人物卡口吻/口头禅',
      '是否违背人物卡禁忌/底线（如该角色绝不低头、绝不说谎）',
      '人物关系/称谓是否与人物卡、前集一致',
      '是否出现人物卡外的角色或已死亡/离场角色',
    ],
  },
  {
    key: 'shootability',
    label: '可拍性',
    guidance: '画面无法实际拍摄（场景/道具/动作不明确、抽象描述、镜头时长不现实、缺关键镜头）→ 归此类。',
    checklist: ['分镜是否可实际拍摄（场景/道具/动作明确）', '是否有无法呈现的抽象描述', '镜头时长是否现实', '是否缺少关键镜头'],
  },
  {
    key: 'dialogue',
    label: '台词',
    guidance: '台词水词/重复信息/信息量低/难以表演 → 归此类；「台词违背人物口吻/人设」归 character。',
    checklist: ['是否有水词/重复信息', '台词是否信息量低或难以表演', '是否可被动作/画面替代'],
  },
  {
    key: 'platform_redline',
    label: '平台红线',
    guidance: '违规/敏感/擦边/暴力/迷信/格式残留（待补/占位/TODO/模板）等平台审核风险 → 归此类（不是 shootability/character）。',
    checklist: ['是否含违规/敏感内容', '是否触碰平台审核风险（擦边/暴力/迷信等）'],
  },
  {
    key: 'memory_foreshadow',
    label: '记忆/伏笔',
    guidance:
      '与前集/本剧记忆冲突、前后矛盾/连续性错误（事实/关系/设定/道具/伤势不一致）、伏笔未回收/未接线 → 归此类；**伏笔物件/旧案线索 + 集末无推进（对照大纲）→ 必须报 memory_foreshadow**。',
    checklist: ['是否与前集/本剧记忆冲突', '伏笔是否埋设/回收合理', '是否遗漏或埋设伏笔而集末无推进', '大纲 cliffhanger/记忆伏笔是否兑现'],
  },
  {
    key: 'timeline',
    label: '时间线',
    guidance:
      '时间顺序/因果矛盾、时间点/时间跨度/时序冲突（台词称「两年前借的钱」而后文称「上个月才借」；人物卡写「多年前已故」却出现「最近借款」；场景标注「同一夜」却写「次日清晨」、昼夜颠倒、先果后因、年龄/时间跨度矛盾）→ 归此类；非时间的事实/设定/关系矛盾才归 memory_foreshadow。',
    checklist: [
      '事件顺序/时间推进是否自洽',
      '支线与主线时间是否冲突',
      '时间词是否自相矛盾（同一事实出现两个时间点/时间跨度/年龄）',
      '昼夜/同一夜/次日等场景时间标注与剧情是否冲突',
    ],
  },
]
export const AUDIT_DIMENSION_KEYS = AUDIT_DIMENSIONS.map((item) => item.key)
export const AUDIT_DIMENSION_LABELS = Object.fromEntries(AUDIT_DIMENSIONS.map((item) => [item.key, item.label]))
export const AUDIT_SEVERITIES = ['high', 'medium', 'low']

const DIMENSION_ALIASES = {
  hook: 'hook_pacing',
  hook_pacing: 'hook_pacing',
  hook_weak: 'hook_pacing',
  opening_hook: 'hook_pacing',
  pacing: 'hook_pacing',
  钩子: 'hook_pacing',
  节奏: 'hook_pacing',
  钩子节奏: 'hook_pacing',
  钩子弱: 'hook_pacing',
  钩子不足: 'hook_pacing',
  开场弱: 'hook_pacing',
  节奏拖沓: 'hook_pacing',
  character: 'character',
  character_consistency: 'character',
  character_break: 'character',
  persona: 'character',
  persona_consistency: 'character',
  persona_break: 'character',
  人设: 'character',
  人设一致性: 'character',
  人设崩: 'character',
  人设崩塌: 'character',
  人物崩: 'character',
  人物崩坏: 'character',
  人物不一致: 'character',
  角色崩坏: 'character',
  shootability: 'shootability',
  shootable: 'shootability',
  可拍性: 'shootability',
  可拍性差: 'shootability',
  拍摄性: 'shootability',
  dialogue: 'dialogue',
  台词: 'dialogue',
  台词问题: 'dialogue',
  对白: 'dialogue',
  platform_redline: 'platform_redline',
  redline: 'platform_redline',
  platform: 'platform_redline',
  平台红线: 'platform_redline',
  红线: 'platform_redline',
  format: 'platform_redline',
  格式: 'platform_redline',
  格式不合规: 'platform_redline',
  残留: 'platform_redline',
  占位: 'platform_redline',
  memory_foreshadow: 'memory_foreshadow',
  memory_consistency: 'memory_foreshadow',
  continuity: 'memory_foreshadow',
  contradiction: 'memory_foreshadow',
  foreshadow_unrecovered: 'memory_foreshadow',
  memory: 'memory_foreshadow',
  foreshadow: 'memory_foreshadow',
  记忆: 'memory_foreshadow',
  伏笔: 'memory_foreshadow',
  记忆伏笔: 'memory_foreshadow',
  记忆一致性: 'memory_foreshadow',
  伏笔一致性: 'memory_foreshadow',
  连续性: 'memory_foreshadow',
  前后矛盾: 'memory_foreshadow',
  伏笔未回收: 'memory_foreshadow',
  timeline: 'timeline',
  timeline_conflict: 'timeline',
  时间线: 'timeline',
  时间顺序: 'timeline',
  时间: 'timeline',
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
/** P3-F（Q3）：人物卡结构化摘要注入（姓名/身份/性格3条/禁忌/口头禅/目标/关系），单卡 ≤2,000 字、整体 ≤3,200 字。 */
export const PERSONA_CARD_MAX_CHARS = 2000
const PERSONA_TOTAL_MAX_CHARS = 3200

function personaField(card, keys) {
  for (const key of keys) {
    const value = card && card[key]
    if (value == null || value === '') continue
    if (Array.isArray(value)) {
      const list = value.filter((item) => item != null && String(item).trim()).map((item) => String(item).trim())
      if (list.length) return list.join('、')
      continue
    }
    const text = String(value).trim()
    if (text) return text
  }
  return ''
}

function personaPersonality(card) {
  const raw = card && card.personality != null ? card.personality : card && card.description
  const list = Array.isArray(raw)
    ? raw.map((item) => String(item).trim()).filter(Boolean)
    : String(raw || '')
        .split(/[、,，;；|/]+/)
        .map((item) => item.trim())
        .filter(Boolean)
  return list.slice(0, 3)
}

/** 把人物卡压成结构化摘要（不整卡全文；供 prompt 人设一致性判据与 agent-mediated rubric 复用）。 */
export function buildPersonaCards(characters) {
  const list = Array.isArray(characters) ? characters.slice(0, 20) : []
  const lines = []
  for (const card of list) {
    if (!card || typeof card !== 'object') continue
    const name = String(card.name || '?').trim()
    const personality = personaPersonality(card)
    const relation =
      personaField(card, ['relation', 'relations', 'relationships', 'relationship', '与主角关系']) || '未填'
    const parts = [
      `姓名：${name}`,
      `身份：${String(card.role || '角色').trim()}${card.identity ? `·${truncate(String(card.identity), 40)}` : ''}`,
      `性格：${personality.length ? personality.join('、') : '未填'}`,
      `禁忌/底线：${personaField(card, ['taboo', 'taboos', 'boundary', 'boundaries', 'bottomLine', '底线', '禁忌']) || '未填'}`,
      `口头禅：${personaField(card, ['catchphrase', 'catchPhrases', 'voiceHint', '口头禅']) || '未填'}`,
      `目标：${personaField(card, ['goal', 'goals', 'motivation', '目标']) || '未填'}`,
      `关系：${truncate(relation, 120)}`,
      card.bio ? `背景：${truncate(String(card.bio), 120)}` : '',
    ].filter(Boolean)
    lines.push(truncate(parts.join('｜'), PERSONA_CARD_MAX_CHARS))
  }
  return truncate(lines.join('\n'), PERSONA_TOTAL_MAX_CHARS)
}

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
    characters: buildPersonaCards(characters),
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

/** 审读 rubric（agent-mediated 时给 Agent 的检查清单；P3-F 增加 guidance 判定要点与 promptVersion）。 */
export function buildRubric() {
  return AUDIT_DIMENSIONS.map((item) => ({ dimension: item.key, label: item.label, guidance: item.guidance, checklist: item.checklist }))
}

/** P3-F/P3-F2/P3-C：输出硬性约束（供 agent-mediated 请求与 schema 文档复用）。 */
export const AUDIT_OUTPUT_CONSTRAINTS = {
  location:
    'episode 恒等于待审集数；优先给集+场（scene 为 ≥1 整数，按正文「场景」序号），有分镜镜号则填 shot（如 "12-3"）。**跨场矛盾取「被违背事实发生的前文场次」**（如前后文事实冲突，取前文事实所在场）；单场问题取首次出现场。若确实判断不出场级：允许集级定位（scene=1）+ evidence 保留原文锚点，**不得因此丢弃 finding**；只有连集级/证据都无法给出时才不输出该条。',
  evidence: `必须逐字摘自「待审本集正文/本集分镜」的自然原文片段，长度 5–${MODEL_OUTPUT_LIMITS.evidence} 字；禁止概括/自造/拼接/模板标记，禁止引用人物卡内容。`,
  suggestion: `「动词 + 对象 + 具体改法」三要素，并写明定位（第X集 场Y / 镜号）与对象（角色/台词/镜头），总长 ≤${MODEL_OUTPUT_LIMITS.suggestion} 字；禁止「增强冲突/优化节奏/加钩子/提升观感」等泛化表述。`,
  severity:
    'high 仅限「与既定设定/事实/人物卡直接矛盾、平台违规、不可拍硬伤（无法拍摄/缺关键镜头）」；正常内容的结构性优化（开场更快、集尾加钩、台词更精炼、补镜头更丰富）默认 low 或不报，**禁止为凑数报 high**。',
  // P3-F2/P3-C：归因正反例——时间类矛盾与事实类矛盾互斥（修 timeline 被归 memory_foreshadow 的漏检）。
  attributionExamples: [
    '正文/分镜含「待补/占位/TODO/模板残留/格式错乱/不可拍格式」或敏感擦边/迷信/暴力/违规内容 → platform_redline（不是 shootability/character）。',
    '**时间类**矛盾：同一事实出现两个冲突时间点/跨度（如前文称「两年前借的」、后文账本写「上个月才借」；场景标注「同一夜」却出现「次日清晨」；先果后因、年龄/时间跨度矛盾）→ timeline（不是 memory_foreshadow/hook_pacing）。',
    '**非时间类**矛盾：人物关系/已发生事件/设定/道具/伤势前后不一致（如前文说二人素未谋面、后文却称多年旧识；道具前文完好无损、后文却有缺口）→ memory_foreshadow（不是 timeline/character/hook_pacing）。',
    '**伏笔未回收**：伏笔物件/旧案线索（如旧案卷宗）+ 集末无推进 → memory_foreshadow（≠ hook_pacing/shootability）。',
    '角色言行/决策/台词口吻违背人物卡（性格 3 条/底线/禁忌/口头禅/目标/关系）→ character（仅当问题本质是人物设定被违背时才归 character，不要因为「牵涉角色」就把上面 4 类归 character）。',
  ],
  attributionOrder:
    '归因优先级（按问题本质，不看涉及元素）：平台红线/格式残留 → platform_redline；**时间点/时间跨度/时序矛盾 → timeline 优先**；非时间的事实/设定/关系/记忆矛盾、伏笔未回收 → memory_foreshadow（伏笔≠hook_pacing 集尾无扣/拖沓）；人物设定违背 → character；台词水词 → dialogue；不可拍摄 → shootability；开场无钩子/拖沓 → hook_pacing。',
  mutex:
    '同一处问题最多保留 1 条 finding（取本质最严重维度）；人设崩类只在「本质是人物卡被违背」时归 character；若本质是平台红线/前后矛盾/伏笔/时间线，即使涉及角色也按本质归因（见归因示例）。',
}

/** 给 Agent 的两段式请求包（无 llm 服务时返回；Agent 判断后 saveReview 保存）。 */
export function buildAgentAuditRequest({ slices, deterministic, budgets, saveHint }) {
  return {
    mode: 'agent-mediated',
    promptVersion: AUDIT_PROMPT_VERSION,
    promptRevision: AUDIT_PROMPT_REVISION,
    episode: slices.episode,
    slices,
    rubric: buildRubric(),
    outputConstraints: AUDIT_OUTPUT_CONSTRAINTS,
    deterministic,
    budget: { tokens: budgets.tokens, timeoutMs: budgets.timeoutMs },
    saveHint:
      saveHint ||
      `请按 rubric 判断后调用 drama_check_consistency({ title, episode: ${slices.episode}, saveReview: { findings: [...], summary: "..." } }) 保存结构化报告。`,
    schema: reviewSchemaDoc(),
  }
}

/** 报告 schema 文字说明（供 Agent 产出合法结构；AC-R4；P3-F 只增可选 meta.promptVersion）。 */
export function reviewSchemaDoc() {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    findings: [
      {
        id: 'F1（可自动补）',
        severity: AUDIT_SEVERITIES.join('|'),
        dimension: AUDIT_DIMENSION_KEYS.join('|'),
        location: { episode: 'number（=待审集数）', scene: 'number（≥1；优先场级，判断不出可填 1 保底）', shot: '可选，镜号字符串/数字' },
        evidence: '5–60 字自然原文片段（必填，逐字摘自正文/分镜；可在原文检索到）',
        suggestion: '动词+对象+具体改法（必填，≤80 字，含定位/角色/台词/镜头；人设类须指出违背的人物卡条目）',
        confidence: '0~1',
        feedback: '可选 {verdict:"accepted|ignored|false-positive", note?}',
      },
    ],
    summary: '一句话总体结论',
    meta: {
      mode: 'agent-mediated|model|deterministic',
      model: '',
      promptVersion: `${AUDIT_PROMPT_VERSION}（只增可选字段，用于前后对比/回放对应）`,
      promptRevision: AUDIT_PROMPT_REVISION,
      tokens: { input: 0, output: 0, total: 0 },
      elapsedMs: 0,
    },
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
  if (!raw) return 'hook_pacing'
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_')
  const alias = DIMENSION_ALIASES[raw] || DIMENSION_ALIASES[normalized] || DIMENSION_ALIASES[normalized.replace(/_/g, '')]
  if (alias) return alias
  if (AUDIT_DIMENSION_KEYS.includes(normalized)) return normalized
  // P3-F：未知维度不再一律默认 hook_pacing（避免「人设崩」被归入钩子弱）——按关键词归类兜底。
  const rules = [
    { pattern: /格式|残留|占位|待补|模板|违规|敏感|擦边|暴力|迷信|红线|审核/, key: 'platform_redline' },
    { pattern: /连续|前后矛盾|矛盾|不一致|记忆冲突|伏笔|埋设|回收|前集/, key: 'memory_foreshadow' },
    { pattern: /时间|顺序|时间线/, key: 'timeline' },
    { pattern: /人设|人物|角色|性格|口吻|底线|禁忌|称谓|关系/, key: 'character' },
    { pattern: /钩子|节奏|开场|悬念|拖沓|反转|集尾|爽点/, key: 'hook_pacing' },
    { pattern: /可拍|拍摄|画面|镜头|道具|分镜|抽象/, key: 'shootability' },
    { pattern: /台词|对白|水词|信息量|表演/, key: 'dialogue' },
  ]
  for (const rule of rules) if (rule.pattern.test(raw)) return rule.key
  return 'hook_pacing'
}

function normalizeConfidence(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0.6
  return Math.min(1, Math.max(0, Math.round(num * 100) / 100))
}

/**
 * 归一 findings：裁剪/枚举纠正/去重/补 id；evidence 缺失的模型产出直接丢弃（AC-R3 误报控制）。
 * P3-F（v0.8.0）：evidence 归一为「5–80 字自然原文片段」形态（去引号/模板标记、保留原文子串，便于可核对）；
 * suggestion 缺少具体要素时补「第X集 场Y 镜Z」定位锚点（prompt 仍要求真实动作+对象，兜底仅保证可执行下限）。
 * P3-F2：支持 options.maxFindings/evidenceMax/suggestionMax（模型路径收紧到 findings≤6/evidence≤60/suggestion≤80）。
 * @param {Array} list
 * @param {number} episode
 * @param {{ keepWithoutEvidence?: boolean, maxFindings?: number, evidenceMax?: number, suggestionMax?: number }} options
 */
export function normalizeFindings(list, episode, options = {}) {
  if (!Array.isArray(list)) return []
  const maxFindings = Number.isFinite(Number(options.maxFindings)) && Number(options.maxFindings) > 0 ? Math.min(MAX_REVIEW_FINDINGS, Math.round(Number(options.maxFindings))) : MAX_REVIEW_FINDINGS
  const evidenceMax = Number(options.evidenceMax) > 0 ? Math.round(Number(options.evidenceMax)) : EVIDENCE_MAX_CHARS
  const suggestionMax = Number(options.suggestionMax) > 0 ? Math.round(Number(options.suggestionMax)) : 600
  const findings = []
  const seen = new Set()
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const evidence = sanitizeFindingEvidence(raw.evidence, evidenceMax)
    if (!evidence && !options.keepWithoutEvidence) continue
    const location = normalizeLocation(raw.location, episode)
    const dimension = normalizeDimension(raw.dimension)
    const suggestion = concreteSuggestionOf(raw.suggestion, location, dimension, suggestionMax)
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
    if (findings.length >= maxFindings) break
  }
  return findings
}

/** P3-F：evidence 归一（去包裹引号/模板标记/多余空白；默认 5–80 字区间以原文子串为限，便于原文检索核对）。 */
const EVIDENCE_MAX_CHARS = 80
const EVIDENCE_MIN_CHARS = 5
function sanitizeFindingEvidence(value, maxChars = EVIDENCE_MAX_CHARS) {
  let text = String(value == null ? '' : value).trim()
  if (!text) return ''
  text = text
    .replace(/^[\s"'“”‘’「」『』`]+/, '')
    .replace(/[\s"'“”‘’「」『』`]+$/, '')
    .replace(/【(?:缺陷标记|模板标记|TODO|待补)[^】]{0,20}】/g, '')
    .replace(/\[(?:缺陷标记|模板标记|TODO|待补)[^\]]{0,20}\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > maxChars) text = text.slice(0, maxChars).trim()
  return text
}

/** P3-F：建议具体性判定（动作 + 对象 + 定位三要素之一；沿用 QA live smoke 的口径）。 */
const SUGGESTION_CONCRETE_RE = /(第?\s*\d+\s*集|场\s*\d+|镜\s*\d+|镜头|特写|近景|中景|远景|全景|台词|人物|角色|场景|画面|开场|结尾|动作|道具|音效|旁白)/
function isConcreteSuggestion(text) {
  const value = String(text || '').trim()
  return value.length >= 12 && SUGGESTION_CONCRETE_RE.test(value)
}

function concreteSuggestionOf(value, location, dimension, maxChars = 600) {
  let text = String(value == null ? '' : value).trim()
  if (!text) text = '调整该处内容，使其符合上下文与人物卡。'
  if (!isConcreteSuggestion(text)) {
    const anchor = `定位：第${location.episode}集 场${location.scene}${location.shot ? ` 镜${location.shot}` : ''}`
    const hint =
      dimension === 'character'
        ? '；对照对应人物卡条目调整该角色动作/台词'
        : dimension === 'dialogue'
          ? '；按该角色口吻重写这句台词'
          : '；按该处画面/台词给出具体替换写法'
    text = `${anchor}，${text}${hint}`
  }
  return truncate(text, maxChars)
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

/** 解析并校验模型审读文本 → 报告（不落盘；P3-F2 模型路径收紧输出长度约束）。 */
export function parseModelReviewText(text, { episode, provider, model, tokens, elapsedMs, budget, modelInfo }) {
  const parsed = extractReviewJson(text)
  const findings = normalizeFindings(parsed.findings, episode, {
    maxFindings: MODEL_OUTPUT_LIMITS.findings,
    evidenceMax: MODEL_OUTPUT_LIMITS.evidence,
    suggestionMax: MODEL_OUTPUT_LIMITS.suggestion,
  })
  if (!findings.length) throw new Error('模型返回的 findings 为空或缺少 evidence')
  const report = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    ok: true,
    episode,
    generatedAt: new Date().toISOString(),
    degraded: false,
    degradeReason: null,
    findings,
    summary: truncate(String(parsed.summary || '').trim() || `共 ${findings.length} 条审读建议`, MODEL_OUTPUT_LIMITS.summary),
    meta: {
      mode: 'model',
      promptVersion: AUDIT_PROMPT_VERSION,
      promptRevision: AUDIT_PROMPT_REVISION,
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
      // P3-E（v0.9.2）：costTier 只增观测（未配置档位时完全不出现这些字段）
      ...(modelInfo && modelInfo.costTierRequested
        ? {
            costTier: typeof modelInfo.costTier === 'string' ? modelInfo.costTier : null,
            costTierRequested: String(modelInfo.costTierRequested),
            costTierFallback: Boolean(modelInfo.costTierFallback),
            costTierFallbackReason: modelInfo.costTierFallbackReason ? String(modelInfo.costTierFallbackReason).slice(0, 200) : null,
          }
        : {}),
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
    // P3-F（Q2/Q5）：prompt 版本（只增可选字段，用于前后对比与回放对应）
    if (review.meta.promptVersion !== undefined && typeof review.meta.promptVersion !== 'string') errors.push('meta.promptVersion 必须是字符串')
    // P3-F2：prompt 修订号（只增可选字段，同版本内区分热修）
    if (review.meta.promptRevision !== undefined && typeof review.meta.promptRevision !== 'string') errors.push('meta.promptRevision 必须是字符串')
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
    // P3-E（v0.9.2）：costTier 观测字段（只增、可选）
    if (review.meta.costTier !== undefined && review.meta.costTier !== null && typeof review.meta.costTier !== 'string') {
      errors.push('meta.costTier 必须是字符串或 null')
    }
    if (review.meta.costTierRequested !== undefined && review.meta.costTierRequested !== null && typeof review.meta.costTierRequested !== 'string') {
      errors.push('meta.costTierRequested 必须是字符串或 null')
    }
    if (review.meta.costTierFallback !== undefined && typeof review.meta.costTierFallback !== 'boolean') errors.push('meta.costTierFallback 必须是布尔值')
    if (
      review.meta.costTierFallbackReason !== undefined &&
      review.meta.costTierFallbackReason !== null &&
      typeof review.meta.costTierFallbackReason !== 'string'
    ) {
      errors.push('meta.costTierFallbackReason 必须是字符串或 null')
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
      promptVersion: AUDIT_PROMPT_VERSION,
      promptRevision: AUDIT_PROMPT_REVISION,
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
      // P3-E（v0.9.2）：降级也保留档位观测（仅配置档位时存在）
      ...(attemptedInfo.costTierRequested
        ? {
            costTier: typeof attemptedInfo.costTier === 'string' ? attemptedInfo.costTier : null,
            costTierRequested: String(attemptedInfo.costTierRequested),
            costTierFallback: Boolean(attemptedInfo.costTierFallback),
            costTierFallbackReason: attemptedInfo.costTierFallbackReason ? String(attemptedInfo.costTierFallbackReason).slice(0, 200) : null,
          }
        : {}),
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
      promptVersion: AUDIT_PROMPT_VERSION,
      promptRevision: AUDIT_PROMPT_REVISION,
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

/** P3-F/F2（v0.8.0）：审读 system prompt —— 本质归因（正反例）/ 定位容错 / 自然原文 evidence / 具体建议 / 长度约束。 */
export function buildSystemPrompt() {
  return [
    `你是资深短剧审读编辑（promptVersion=${AUDIT_PROMPT_VERSION}）。任务：对用户提供的单集内容做结构化审读，只输出一个 JSON 对象，不要输出任何其它文字。`,
    '',
    '## 审读维度（dimension 必须用下面的英文键；先判定问题本质，再选维度）',
    ...AUDIT_DIMENSIONS.map((item) => `- ${item.key}（${item.label}）：${item.guidance}`),
    '',
    '## 归因优先级与正反例（最重要，防维度归偏）',
    `- ${AUDIT_OUTPUT_CONSTRAINTS.attributionOrder}`,
    ...AUDIT_OUTPUT_CONSTRAINTS.attributionExamples.map((line, index) => `  ${index + 1}) ${line}`),
    `- ${AUDIT_OUTPUT_CONSTRAINTS.mutex}`,
    '- 人设一致性也要查，但只在「问题本质是人物设定被违背」时才报 character：逐个主要角色对照人物卡（姓名/身份/性格 3 条/底线/禁忌/口头禅/目标/关系）。',
    '',
    '## 硬性输出约束（违反则整条作废）',
    `1) 定位：${AUDIT_OUTPUT_CONSTRAINTS.location}`,
    `2) evidence：${AUDIT_OUTPUT_CONSTRAINTS.evidence}`,
    `3) suggestion：${AUDIT_OUTPUT_CONSTRAINTS.suggestion}`,
    '4) 人设一致性专项：dimension=character 时，suggestion 必须指出违背的人物卡条目（如「违背人物卡：林越-性格『冷静』」）并给出替代动作/台词写法。',
    `5) 长度：findings 最多 ${MODEL_OUTPUT_LIMITS.findings} 条；summary ≤${MODEL_OUTPUT_LIMITS.summary} 字；宁少勿多。`,
    `6) 严重度：${AUDIT_OUTPUT_CONSTRAINTS.severity}`,
    '7) 不确定的不要报（误报有预算限制）；evidence 无法在原文逐字找到的不要报。',
    '',
    '## 输出 JSON schema（只输出 JSON，不要 markdown/代码围栏/注释）',
    '{"findings":[{"severity":"high|medium|low","dimension":"上面英文键之一","location":{"episode":数字（=待审集数）,"scene":数字（≥1，优先场级；判断不出场级可填1）,"shot":"可选镜号"},"evidence":"5–60字自然原文片段","suggestion":"动词+对象+具体改法（含定位，≤80字）","confidence":0到1}],"summary":"≤60字一句话结论"}',
    `要求：输出 ${Math.min(3, MODEL_OUTPUT_LIMITS.findings)}~${MODEL_OUTPUT_LIMITS.findings} 条高质量问题，按严重度排序；输出完整闭合 JSON。`,
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
    slices.characters ? `## 人物卡（结构化摘要 = 人设一致性判据；姓名/身份/性格/禁忌·底线/口头禅/目标/关系）\n${slices.characters}` : '',
    slices.memory ? `## 本剧记忆/伏笔\n${slices.memory}` : '',
    slices.previousTail ? `## 上一集结尾（用于衔接/时间线/前后矛盾判断）\n${slices.previousTail}` : '',
    `## 待审第 ${slices.episode} 集正文（${slices.episodeTitle}）\n${slices.episodeText}`,
    slices.storyboard ? `## 本集分镜（镜号可用于 location.shot 与可拍性判断）\n${slices.storyboard}` : '（本集暂无分镜，可拍性维度只做剧本层面判断）',
    `## 确定性预检结果（已由规则发现，可参考但不要重复罗列）\n${deterministicText}`,
    '## 审读对象与硬性约束',
    `只审「待审第 ${slices.episode} 集正文」这一集。`,
    `- 归因：${AUDIT_OUTPUT_CONSTRAINTS.attributionOrder}`,
    '- 归因提醒：平台红线/格式残留、**时间类矛盾（timeline）**、非时间前后矛盾/伏笔未回收（memory_foreshadow），即使牵涉角色也**不要**归 character / hook_pacing / shootability。',
    `- 定位：${AUDIT_OUTPUT_CONSTRAINTS.location}`,
    `- evidence：${AUDIT_OUTPUT_CONSTRAINTS.evidence}`,
    `- suggestion：${AUDIT_OUTPUT_CONSTRAINTS.suggestion}`,
    `- severity：${AUDIT_OUTPUT_CONSTRAINTS.severity}`,
    '- 人设一致性照常检查：逐主要角色对照人物卡，言行/口吻/关系违背才报 character 并指出违背条目。',
    `- 长度：findings ≤${MODEL_OUTPUT_LIMITS.findings} 条、summary ≤${MODEL_OUTPUT_LIMITS.summary} 字；少而准优先。`,
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
  '\n\n---\n【修复要求】你上一次的输出不是合法 JSON（原因：%REASON%）。请重新输出：只输出一个合法 JSON 对象；不要 ``` 围栏、不要注释、不要尾逗号；字符串内不要出现未转义换行/制表符；findings 不超过 6 条、evidence 5–60 字、suggestion ≤80 字、summary 不超过 60 字；JSON 必须完整闭合。'

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
        // P3-E：costTier 只增观测（仅配置档位时存在）
        ...(target.costTierRequested
          ? {
              costTier: typeof target.costTier === 'string' ? target.costTier : null,
              costTierRequested: target.costTierRequested,
              costTierFallback: Boolean(target.costTierFallback),
              costTierFallbackReason: target.costTierFallbackReason || null,
            }
          : {}),
      }
    : null
  const attemptedBase = {
    model,
    provider,
    source: modelInfo?.source || 'agent-default',
    modelFallback: Boolean(modelInfo?.modelFallback),
    modelFallbackReason: modelInfo?.modelFallbackReason || null,
    ...(modelInfo && modelInfo.costTierRequested
      ? {
          costTier: modelInfo.costTier,
          costTierRequested: modelInfo.costTierRequested,
          costTierFallback: modelInfo.costTierFallback,
          costTierFallbackReason: modelInfo.costTierFallbackReason,
        }
      : {}),
  }
  if (!provider || !model) return { ok: false, degradeReason: 'no-default-model', attempted: attemptedBase }
  const runContext = context || createAuditRunContext(budgets)
  if (!runContext.startedAt) runContext.startedAt = Date.now()
  // P3-F2：默认预算 45s 下模型单次调用内部放宽到 55s（仍 ≤ MAX 60s）；报告 meta.budget.timeoutMs 保持契约值，
  // 显式更小 timeoutMs（如任务级 20s / AC-R6 的 1000ms）保持原值不延长。选择「延长 10s + 输出长度收紧」而非整轮重试，
  // 避免一次超时后重试把总耗时推过 60s 上限并翻倍 tokens。
  const callTimeoutCeiling = auditModelCallTimeoutMs(budgets)
  if (Number(budgets.timeoutMs) >= DEFAULT_AUDIT_TIMEOUT_MS) {
    runContext.deadline = Math.max(runContext.deadline, Math.min(runContext.startedAt + MAX_AUDIT_TIMEOUT_MS, runContext.startedAt + callTimeoutCeiling))
  }
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
      timeoutMs: Math.min(callTimeoutCeiling, Math.max(1000, remainingMs())),
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
  // P3-E（v0.9.2）：costTier 可选；未配置 = 旧行为逐字段一致（不产生 costTier* 字段）。
  const requestedCostTier = isCostTier(taskConfig.costTier) ? taskConfig.costTier : null
  const tierOverride = costTierOverrideOf(taskConfig)
  const candidates = []

  // fast/strong 有显式映射时优先探测；不可用则继续回退 standard 链。
  if (tierOverride && !tierOverride.missing) {
    candidates.push({
      provider: tierOverride.provider || defaultSelection?.provider || '',
      model: tierOverride.model,
      source: 'cost-tier',
      config: taskConfig,
      costTierCandidate: requestedCostTier,
    })
  }

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
    const resolved = {
      ...candidate,
      modelFallback: Boolean(fallbackReason),
      modelFallbackReason: fallbackReason || null,
    }
    delete resolved.costTierCandidate
    if (requestedCostTier) {
      const effectiveCostTier = candidate.costTierCandidate === requestedCostTier ? requestedCostTier : 'standard'
      const tierFallback = effectiveCostTier !== requestedCostTier
      resolved.costTier = effectiveCostTier
      resolved.costTierRequested = requestedCostTier
      resolved.costTierFallback = tierFallback
      resolved.costTierFallbackReason = tierFallback
        ? tierOverride && !tierOverride.missing
          ? 'tier-unavailable'
          : 'no-model-mapping'
        : null
    }
    return resolved
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
    // P3-E：回退重试时档位按 standard 记录并标记回退（仅原请求过档位时）
    ...(resolved && resolved.costTierRequested
      ? {
          costTier: 'standard',
          costTierRequested: resolved.costTierRequested,
          costTierFallback: true,
          costTierFallbackReason: 'model-fallback',
        }
      : {}),
  }
  const retry = await runModelAudit({ llm, model: retryModel, slices, deterministic, episode, budgets, context: runContext })
  if (retry.ok) return { outcome: retry, usedModel: retryModel }
  return { outcome: first, usedModel: resolved }
}
