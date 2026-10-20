/**
 * P2-2：创作流程状态机（flow-state）宿主半
 *
 * 冻结口径（`需求叙述-P2-2-创作流程状态机-v1.md` §9，Lead 裁定 Q1–Q5）：
 *   - 文件：`<项目>/.aidrama/flow-state.json`，原子写；结构
 *     `{version, strictMode, steps:{project|outline|characters|episode_script|storyboard|exported:
 *       not_started|in_progress|confirmed|stale}, updatedAt, history:[{at,action,step,from,to,actor?}]}`
 *   - **Q1（历史口径）**：默认宽松（strictMode=false）；P2-2 时代 strictMode=true 曾强制「先确认上一步」。
 *   - **v0.16.0（A-H1，Lead 已批）**：强制流程门禁**整体停用** —— `settings.strictMode` 与项目内
 *     `flow-state.strictMode` 均被忽略、不再阻塞写入/工具；`strictMode` 字段保留（历史值原样读写），仅不再生效。
 *   - **Q2**：不随导出（`.aidrama` 隐藏目录，导出/清单天然不含）。
 *   - **Q3**：回退/上游变更只把下游 confirmed 标 `stale`，不删文件、不自动备份。
 *   - **Q4**：Agent 工具/面板写内容类操作后由宿主自动同步（本模块 `syncAfterContentWrite`）。
 *   - **Q5**：history 只落最小字段；不做结构图。
 *
 * 读写入口（零新增 route，见 `需求文档 §7 契约变更`）：
 *   - 读：`doc-read  {title, path:'.aidrama/flow-state.json'}` → 恒 200；缺失时按内容推断并落盘（AC-F7）。
 *   - 写：`doc-save  {title, path:'.aidrama/flow-state.json', text, expectedHash}`；
 *         非法 JSON/状态 → 400；expectedHash 过期 → 409 conflict + currentHash（E1 语义）。
 *   - 本模块只负责状态归一/推断/迁移与落盘，不依赖宿主 ctx，便于离线断言。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import * as store from './store.js'

/** 内部约定路径（doc-* 特例白名单，仅此一个）。 */
export const FLOW_INTERNAL_PATH = '.aidrama/flow-state.json'
export const FLOW_VERSION = 1

/** 6 步，与 progress-get 对齐。 */
export const FLOW_STEPS = ['project', 'outline', 'characters', 'episode_script', 'storyboard', 'exported']
export const FLOW_STEP_LABELS = {
  project: '建项目',
  outline: '大纲',
  characters: '人物',
  episode_script: '剧本',
  storyboard: '分镜',
  exported: '导出',
}
export const FLOW_STATES = ['not_started', 'in_progress', 'confirmed', 'stale']

/** history 保留上限（最小字段，避免文件膨胀）。 */
const MAX_HISTORY = 50
const MAX_TEXT_BYTES = 200 * 1024

const nowIso = () => new Date().toISOString()

function flowFile(root, title) {
  return path.join(store.projectDir(root, title), '.aidrama', 'flow-state.json')
}

/** 序列化为稳定的「展示/写入」文本（2 空格缩进 + 尾换行；doc-read 的 text/hash 都基于它）。 */
export function serializeFlowState(state) {
  const normalized = {
    version: FLOW_VERSION,
    strictMode: state.strictMode === true,
    steps: {},
    updatedAt: typeof state.updatedAt === 'string' && state.updatedAt ? state.updatedAt : nowIso(),
    history: Array.isArray(state.history) ? state.history : [],
  }
  for (const step of FLOW_STEPS) normalized.steps[step] = state.steps && state.steps[step] ? state.steps[step] : 'not_started'
  return `${JSON.stringify(normalized, null, 2)}\n`
}

function normalizeHistory(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    out.push({
      at: typeof entry.at === 'string' ? entry.at : nowIso(),
      action: typeof entry.action === 'string' ? entry.action.slice(0, 40) : 'update',
      step: FLOW_STEPS.includes(entry.step) ? entry.step : 'project',
      from: FLOW_STATES.includes(entry.from) ? entry.from : null,
      to: FLOW_STATES.includes(entry.to) ? entry.to : 'not_started',
      ...(typeof entry.actor === 'string' && entry.actor ? { actor: entry.actor.slice(0, 80) } : {}),
    })
  }
  return out.slice(-MAX_HISTORY)
}

/** 校验并归一「steps」对象（未知 step/状态一律报错，避免写坏数据）。 */
function normalizeSteps(raw, base = null) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const steps = {}
  for (const step of FLOW_STEPS) {
    const candidate = source[step]
    if (candidate === undefined) {
      steps[step] = base && base[step] ? base[step] : 'not_started'
      continue
    }
    const value = String(candidate)
    if (!FLOW_STATES.includes(value)) {
      throw new Error(`flow-state 步骤「${step}」状态不合法：${value}（可选：${FLOW_STATES.join(' / ')}）`)
    }
    steps[step] = value
  }
  return steps
}

/** 归一已经落盘的 state（读取用；非法即抛错，由 readOrInfer 触发「按内容修复」）。 */
function normalizeStoredState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('flow-state 格式不正确')
  return {
    version: FLOW_VERSION,
    strictMode: raw.strictMode === true,
    steps: normalizeSteps(raw.steps, null),
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : nowIso(),
    history: normalizeHistory(raw.history),
  }
}

function pushHistory(history, entry) {
  const list = Array.isArray(history) ? history.slice(-MAX_HISTORY) : []
  list.push({
    at: nowIso(),
    action: entry.action,
    step: entry.step,
    from: entry.from === undefined ? null : entry.from,
    to: entry.to,
    ...(entry.actor ? { actor: String(entry.actor).slice(0, 80) } : {}),
  })
  return list.slice(-MAX_HISTORY)
}

async function directoryHasFiles(target) {
  try {
    const entries = await fs.readdir(target)
    return entries.filter((name) => !name.startsWith('.')).length > 0
  } catch {
    return false
  }
}

/**
 * 按项目内容推断 6 步状态（AC-F7 旧项目兼容）。
 * 单调级联：已有剧本 → 前 4 步 confirmed；有分镜 → +storyboard；有导出产物 → 全部 confirmed。
 */
export async function inferFlowState(root, title) {
  const projectPath = store.projectDir(root, title)
  if (!(await store.isDirectory(projectPath))) throw new Error(`短剧《${title}》不存在`)
  const [outline, characters, episodes] = await Promise.all([
    store.getOutline(root, title).catch(() => []),
    store.getCharacters(root, title).catch(() => []),
    store.listEpisodes(root, title).catch(() => []),
  ])
  let hasStoryboardShots = false
  for (const episode of episodes.slice(0, 20)) {
    try {
      if ((await store.getStoryboard(root, title, episode.order)).length > 0) {
        hasStoryboardShots = true
        break
      }
    } catch {
      /* 忽略单集读取失败 */
    }
  }
  const hasExport = await directoryHasFiles(path.join(projectPath, '导出'))
  const achieved = [true, outline.length > 0, characters.length > 0, episodes.length > 0, hasStoryboardShots, hasExport]
  let maxLevel = 0
  for (let i = 0; i < achieved.length; i += 1) if (achieved[i]) maxLevel = i
  const steps = {}
  for (let i = 0; i < FLOW_STEPS.length; i += 1) steps[FLOW_STEPS[i]] = i <= maxLevel ? 'confirmed' : 'not_started'
  // project 步在项目存在时恒为 confirmed（AC-F1 的「当前步」= 其上第一个非 confirmed）
  steps.project = 'confirmed'
  return {
    version: FLOW_VERSION,
    strictMode: false,
    steps,
    updatedAt: nowIso(),
    history: [{ at: nowIso(), action: 'inferred', step: 'project', from: null, to: 'confirmed', actor: 'system' }],
  }
}

/**
 * 读取 flow-state；文件不存在/损坏时按内容推断（可选落盘修复，默认落盘）。
 * @returns {Promise<{state:object, text:string, persisted:boolean, repaired:boolean}>}
 */
export async function readOrInferFlowState(root, title, options = {}) {
  const persist = options.persist !== false
  const file = flowFile(root, title)
  let rawText = null
  try {
    rawText = await fs.readFile(file, 'utf8')
  } catch {
    rawText = null
  }
  if (rawText !== null) {
    try {
      const state = normalizeStoredState(JSON.parse(rawText))
      return { state, text: serializeFlowState(state), persisted: true, repaired: false }
    } catch {
      /* 损坏 → 按内容推断并修复 */
    }
  }
  const inferred = await inferFlowState(root, title)
  const text = serializeFlowState(inferred)
  if (persist) await store.guardedMetaWrite(store.projectDir(root, title), 'flow-state.json', text)
  return { state: inferred, text, persisted: Boolean(persist), repaired: rawText !== null }
}

/** 只读取（不推断、不落盘）；无文件/损坏返回 null。 */
export async function readFlowState(root, title) {
  try {
    const rawText = await fs.readFile(flowFile(root, title), 'utf8')
    return normalizeStoredState(JSON.parse(rawText))
  } catch {
    return null
  }
}

/** 计算一次写迁移：客户端提交 steps → 归一 + 回退/上游变更时下游 stale + history。 */
function computeTransitions(previous, input, actor, options = {}) {
  const steps = normalizeSteps(input && input.steps ? input.steps : input, previous.steps)
  // Q1（历史数据口径，A-H1 后仅存数据）：设置 strictMode 开启时覆盖为 true；关闭时允许客户端显式关闭项目级 strictMode。
  const strictRequested = input && input.strictMode !== undefined ? input.strictMode === true : previous.strictMode === true
  const strictMode = options.strictEnabled === true ? true : strictRequested
  let history = Array.isArray(previous.history) ? previous.history.slice(-MAX_HISTORY) : []

  // v0.16.0（A-H1）：原 Q1「强制模式下确认某步要求上一步已 confirmed」的越步 409 门禁块已删除。
  // 步序不再阻断；下游 stale 传播与 history 记录逻辑保持不变（见下方循环）。

  for (let i = 0; i < FLOW_STEPS.length; i += 1) {
    const step = FLOW_STEPS[i]
    const from = previous.steps[step]
    const to = steps[step]
    if (from === to) continue
    history = pushHistory(history, {
      action: from === 'confirmed' && to === 'in_progress' ? 'rollback' : to === 'confirmed' ? 'confirm' : 'update',
      step,
      from,
      to,
      actor,
    })
    // Q3：上游变更/回退 → 下游已确认步骤标 stale（不删文件、不备份）
    if (to === 'in_progress' || (from === 'confirmed' && to !== 'confirmed')) {
      for (let j = i + 1; j < FLOW_STEPS.length; j += 1) {
        const downstream = FLOW_STEPS[j]
        if (steps[downstream] === 'confirmed') {
          steps[downstream] = 'stale'
          history = pushHistory(history, { action: 'stale', step: downstream, from: 'confirmed', to: 'stale', actor })
        }
      }
    }
  }
  return {
    version: FLOW_VERSION,
    strictMode,
    steps,
    updatedAt: nowIso(),
    history: history.slice(-MAX_HISTORY),
  }
}

/**
 * 客户端写入口：`doc-save` 的 text → 归一/迁移/落盘。
 * @returns {Promise<{state:object, text:string}>} text 为规范化 JSON（client 以其 hash 作下一次 expectedHash）
 */
export async function saveFlowStateText(root, title, text, options = {}) {
  if (typeof text !== 'string') throw new Error('flow-state 内容必须是字符串')
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new Error('flow-state 内容过大')
  let input
  try {
    input = JSON.parse(text)
  } catch {
    throw new Error('flow-state 必须是合法 JSON 文本')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('flow-state 必须是 JSON 对象')
  const existing = await readOrInferFlowState(root, title, { persist: false })
  const actor = options.actor ? String(options.actor) : 'editor'
  // Q1（历史数据口径，A-H1 后仅用于 strictMode 数据字段归一，不再参与任何门禁判定）。
  let strictEnabled = false
  try {
    const settings = await store.getSettings(root)
    strictEnabled = settings && settings.strictMode === true
  } catch {
    strictEnabled = false
  }
  const next = computeTransitions(existing.state, input, actor, { strictEnabled })
  const outText = serializeFlowState(next)
  await store.guardedMetaWrite(store.projectDir(root, title), 'flow-state.json', outText)
  return { state: next, text: outText }
}

/**
 * Q4：Agent 工具/面板「内容写」成功后由宿主自动同步 flow-state。
 * 规则：受影响步 → in_progress（原 confirmed 视为被修改而降级），其下游 confirmed → stale。
 * @param {'project'|'outline'|'characters'|'episode_script'|'storyboard'|'exported'} step
 */
export async function syncAfterContentWrite(root, title, options = {}) {
  const step = String(options.step || '')
  if (!FLOW_STEPS.includes(step)) return null
  const existing = await readOrInferFlowState(root, title, { persist: true })
  const previous = existing.state
  const steps = { ...previous.steps }
  let history = Array.isArray(previous.history) ? previous.history.slice(-MAX_HISTORY) : []
  const actor = options.actor ? String(options.actor) : 'agent'

  const from = steps[step]
  if (from !== 'in_progress') {
    steps[step] = 'in_progress'
    history = pushHistory(history, {
      action: from === 'confirmed' ? 'content-changed' : 'in-progress',
      step,
      from,
      to: 'in_progress',
      actor,
    })
  }
  // 内容变更视为「上游变更」：下游已确认步骤 → stale
  const index = FLOW_STEPS.indexOf(step)
  for (let j = index + 1; j < FLOW_STEPS.length; j += 1) {
    const downstream = FLOW_STEPS[j]
    if (steps[downstream] === 'confirmed') {
      steps[downstream] = 'stale'
      history = pushHistory(history, { action: 'stale', step: downstream, from: 'confirmed', to: 'stale', actor })
    }
  }
  const next = {
    version: FLOW_VERSION,
    strictMode: previous.strictMode,
    steps,
    updatedAt: nowIso(),
    history: history.slice(-MAX_HISTORY),
  }
  await store.guardedMetaWrite(store.projectDir(root, title), 'flow-state.json', serializeFlowState(next))
  return next
}

/** 状态摘要（供日志/诊断；不进 progress-get 形状）。 */
export function summarizeFlowState(state) {
  if (!state || !state.steps) return ''
  const current = FLOW_STEPS.find((step) => state.steps[step] !== 'confirmed') || 'exported'
  return `${FLOW_STEP_LABELS[current] || current}=${state.steps[current]}（strict=${state.strictMode === true ? 'on' : 'off'}）`
}

/** 项目创建时落盘初始 flow-state（6 步全 not_started，AC-F1）；已存在则不覆盖（旧项目兼容）。 */
export async function initFlowState(root, title) {
  const file = flowFile(root, title)
  try {
    await fs.access(file)
    return null
  } catch {
    /* 不存在 → 创建初始态 */
  }
  const projectPath = store.projectDir(root, title)
  if (!(await store.isDirectory(projectPath))) throw new Error(`短剧《${title}》不存在`)
  const state = {
    version: FLOW_VERSION,
    strictMode: false,
    steps: Object.fromEntries(FLOW_STEPS.map((step) => [step, 'not_started'])),
    updatedAt: nowIso(),
    history: [],
  }
  await store.guardedMetaWrite(store.projectDir(root, title), 'flow-state.json', serializeFlowState(state))
  return state
}

/**
 * v0.16.0（A-H1）：强制流程门禁已整体停用 —— 恒返回 false。
 * 保留该导出仅为兼容旧调用方/诊断代码；`strictMode` 历史值仍可从 settings / flow-state.json 直接读取。
 */
export async function isStrictFlowMode(_root, _title) {
  return false
}

/**
 * v0.16.0（A-H1）：强制流程门禁已整体停用 —— 恒放行（保留导出与调用签名，调用点无需改动）。
 * 不再读取 `settings.strictMode` / `flow-state.strictMode`，也不抛 `code='conflict'`。
 * @returns {Promise<{allowed:true, strict:false}>}
 */
export async function assertStepAllowed(_root, _title, _step) {
  return { allowed: true, strict: false }
}
