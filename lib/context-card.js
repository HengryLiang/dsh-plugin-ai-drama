/**
 * P1-M / T4：运行期上下文注入（状态卡）
 *
 * 设计：DSH 的 `systemPrompt.context()` 的 text 可以是**同步函数**，但短剧状态读取是异步的。
 * 因此这里只做「纯文本构建」——由 index.js 在后台异步刷新每 Agent 的状态快照，
 * provider 同步读取缓存文本。好处：
 *   - 注入确定、可离线断言（本模块纯函数，无 IO）；
 *   - 体积可控（≤ MAX_CONTEXT_CHARS，超长截断）；
 *   - 只在「短剧模式」主 Agent 作用域注册，与写作模式天然隔离（AC-09）。
 *
 * 注入内容（验收 AC-07）：当前项目与阶段、契约摘要、人物卡索引、前情提要、
 * 平台红线、项目记忆目录快照（伏笔/已用桥段/时间线/待回收）、以及最近一次写入的
 * 「写后反馈」（字数/镜头数等）。**不含**剧本全文，避免挤占上下文（目标 ≤8K 字符）。
 */

import { worldContractContextLines } from './contract-world.js'

export const MAX_CONTEXT_CHARS = 8000
export const CONTEXT_BLOCK_TITLE = '短剧上下文'

const MEMORY_KINDS = ['伏笔', '已用桥段', '时间线', '待回收']
const STAGE_LABELS = {
  project: '项目已建',
  outline: '大纲就绪',
  characters: '人物就绪',
  episode_script: '剧本就绪',
  storyboard: '分镜就绪',
  exported: '已导出',
}

const WRITE_LABELS = {
  drama_save_contract: '剧集契约',
  drama_save_outline: '分集大纲',
  drama_save_characters: '人物设定',
  drama_save_memory: '本剧记忆',
  drama_save_world: '世界观',
  drama_save_draft: '草稿',
  drama_resolve_draft: '草稿处理',
  drama_finalize_episode: '定稿',
  drama_import_script: '剧本导入',
  drama_add_asset: '素材登记',
  drama_budget: '预算',
  drama_plan_generation: '生成任务',
  drama_record_generation: '生成任务回写',
  drama_plan_batch: '生成批次规划',
  drama_submit_batch: '生成批次提交',
  drama_collect_batch: '生成批次收敛',
  drama_intake_artifact: '产物回流',
  drama_bind_canvas: '画布绑定',
}

const clip = (text, limit) => {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

const orDash = (value) => (value === null || value === undefined || value === '' ? '—' : String(value))

/** 把一次写工具的调用/结果压成一行「写后反馈」（纯函数，可单测）。 */
export function summarizeWriteFeedback(toolName, args = {}, result = {}) {
  const label = WRITE_LABELS[toolName] || String(toolName || '写操作')
  const order = args && args.order != null ? args.order : result && !Array.isArray(result) ? result.order : null
  const parts = [label]
  if (order != null && Number.isFinite(Number(order))) parts.push(`第 ${Number(order)} 集`)
  if (Array.isArray(result)) {
    // 例如 drama_save_storyboard 之外的分镜写入路径，工具可能直接返回镜头数组
    parts.push(`${result.length} 项`)
  } else if (result && typeof result === 'object') {
    if (Number.isFinite(Number(result.bytes))) parts.push(`${Number(result.bytes)} 字节`)
    if (Number.isFinite(Number(result.shots))) parts.push(`${Number(result.shots)} 镜`)
    if (Number.isFinite(Number(result.count))) parts.push(`${Number(result.count)} 项`)
    if (result.version != null) parts.push(`v${result.version}`)
    if (result.draftId) parts.push(`草稿 ${result.draftId}`)
    if (result.status) parts.push(`状态 ${result.status}`)
  }
  if (args && Array.isArray(args.shots) && args.shots.length) parts.push(`${args.shots.length} 镜`)
  else if (args && typeof args.text === 'string' && args.text.length && !(result && Number.isFinite(Number(result.bytes)))) {
    parts.push(`${args.text.length} 字符`)
  }
  return parts.join(' · ')
}

/**
 * 构建「短剧上下文」状态卡。
 * @param {{
 *   title?: string,
 *   progress?: {stage?:string, facts?:object, steps?:Array},
 *   contract?: object,
 *   outline?: Array,
 *   characters?: Array,
 *   memory?: Array,
 *   episodes?: Array<{order:number}>,
 *   storyboards?: Record<string, number>,
 *   lastWrite?: {tool?:string, summary?:string, at?:string}|null,
 * }} input
 * @returns {string} 注入文本（≤ MAX_CONTEXT_CHARS）
 */
export function buildDramaContextCard(input = {}) {
  const title = input.title ? String(input.title) : ''
  const contract = input.contract && typeof input.contract === 'object' ? input.contract : {}
  const outline = Array.isArray(input.outline) ? input.outline : []
  const characters = Array.isArray(input.characters) ? input.characters : []
  const memory = Array.isArray(input.memory) ? input.memory : []
  const episodes = Array.isArray(input.episodes) ? input.episodes : []
  const progress = input.progress && typeof input.progress === 'object' ? input.progress : {}
  const storyboards = input.storyboards && typeof input.storyboards === 'object' ? input.storyboards : {}
  const lastWrite = input.lastWrite && typeof input.lastWrite === 'object' ? input.lastWrite : null
  const facts = progress.facts && typeof progress.facts === 'object' ? progress.facts : {}

  const lines = []
  lines.push(`## ${CONTEXT_BLOCK_TITLE}`)
  lines.push('> 由「AI 短剧」工作区自动注入（P1-M/T4）：当前工作状态快照；有写入后会自动刷新，回答前无需重复读取。')
  lines.push('')

  if (!title) {
    lines.push('- 当前项目：未打开/未创建（不主动建项；如用户需要新建，请明确说明；可用 drama_list_projects 查看已有项目）。')
    return finish(lines)
  }

  const stageLabel = STAGE_LABELS[progress.stage] || progress.stage || '未知'
  lines.push(`- 当前项目：《${title}》 · 阶段：${stageLabel}`)

  const [minDur, maxDur] = Array.isArray(contract.episodeDurationSec) ? contract.episodeDurationSec : []
  lines.push(
    `- 契约：平台 ${orDash(contract.platform)} · 受众 ${orDash(contract.audience)} · 单集 ${orDash(minDur)}~${orDash(maxDur)} 秒 · 目标 ${orDash(contract.targetEpisodes)} 集 · 画幅 ${contract.orientation === 'landscape' ? '横屏' : contract.orientation === 'portrait' ? '竖屏' : '—'} · 钩子 ${orDash(contract.hookDensity)} · 红线 ${orDash(contract.redlines)}`,
  )
  // v0.16.2（C1 / E14）：世界约束 ≤200 字摘要（仅非空字段；全空返回空数组 → 旧卡文本逐字节不变）。
  lines.push(...worldContractContextLines(contract))

  if (characters.length) {
    const names = characters.slice(0, 10).map((card) => `${card && card.name ? card.name : '未具名'}${card && card.role ? `（${card.role}）` : ''}`)
    lines.push(`- 人物索引（${characters.length} 人）：${names.join('、')}${characters.length > 10 ? ' 等' : ''}`)
  } else {
    lines.push('- 人物索引：尚无人物设定卡（写剧本前建议先用 drama_save_characters 建立）。')
  }

  const outlineCount = outline.length || Number(facts.outlineCount) || 0
  if (outlineCount) {
    const recent = outline.slice(-2).map((row) => `第 ${orDash(row && row.order)} 集 ${clip(row && row.title, 20)}${row && row.logline ? `：${clip(row.logline, 60)}` : ''}`)
    lines.push(`- 总纲：共 ${outlineCount} 集${recent.length ? ` · 前情提要：${recent.join('；')}` : ''}`)
  } else {
    lines.push('- 总纲：尚未创建（可用 drama_save_outline 生成分集大纲）。')
  }

  const episodeCount = episodes.length || Number(facts.episodeCount) || 0
  if (episodeCount) {
    const orders = episodes.slice(0, 20).map((episode) => (episode && episode.order != null ? Number(episode.order) : null)).filter((n) => Number.isFinite(n))
    const storyboardCount = Object.values(storyboards).reduce((sum, count) => sum + (Number(count) || 0), 0)
    lines.push(`- 分集：已有剧本 ${episodeCount} 集${orders.length ? `（第 ${orders.join('、')} 集）` : ''}${storyboardCount ? ` · 分镜 ${storyboardCount} 镜` : ''}`)
  } else {
    lines.push('- 分集：尚无剧本。')
  }

  if (memory.length) {
    const counts = MEMORY_KINDS.map((kind) => [kind, memory.filter((item) => item && item.kind === kind).length]).filter(([, count]) => count)
    const openHooks = memory
      .filter((item) => item && item.status === 'open' && item.kind === '伏笔')
      .slice(0, 3)
      .map((item) => clip(item.content, 40))
    lines.push(`- 本剧记忆：${memory.length} 条（${counts.map(([kind, count]) => `${kind} ${count}`).join(' / ') || '无分类'}）${openHooks.length ? ` · 待回收伏笔：${openHooks.join('；')}` : ''}`)
  } else {
    lines.push('- 本剧记忆：尚无条目（重要情节后建议用 drama_save_memory 登记伏笔/时间线）。')
  }

  if (lastWrite && lastWrite.summary) {
    lines.push(`- 最近写入（写后反馈）：${clip(lastWrite.summary, 200)}${lastWrite.at ? `（${clip(lastWrite.at, 30)}）` : ''}`)
  }

  lines.push('')
  lines.push('- 操作约束：以上为实时快照，以磁盘与工具结果为准；生成内容先落草稿区、经用户采纳后再进正式稿。')
  return finish(lines)
}

function finish(lines) {
  const text = lines.filter((line) => line !== null && line !== undefined).join('\n')
  if (text.length <= MAX_CONTEXT_CHARS) return text
  return `${text.slice(0, MAX_CONTEXT_CHARS - 16)}\n…（已截断）`
}
