/**
 * `drama_*` Agent 工具定义（FR-C01~C09 / FR-D03）。
 *
 * 这些工具只在**处于「短剧模式」预设的 Agent** 上注册（由 index.js 判定），
 * 因此非短剧会话看不到它们——这就是 PRD 所说的「工具白名单」。
 */
import path from 'node:path'

import * as store from './store.js'
import * as generation from './generation.js'
import * as orchestrator from './orchestrator.js'
import * as guard from './guard.js'
import * as drafts from './drafts.js'
import { checkConsistency } from './consistency.js'
import * as audit from './audit.js'
import { searchContext } from './retrieval.js'
import { EXPORT_FORMATS, exportProject } from './exporter.js'
import { runDeterministicChecks } from './checks.js'
import * as approval from './approval.js'
import * as flowState from './flow-state.js'

/* ======================================================================
 * P1-A：工具失败契约（T1-②）
 *
 * 背景：v0.3.2 之前工具失败靠 `throw new Error(...)`，模型只能看到一段自然语言，
 * 无法据此决定「能不能重试、怎么重试」。本段在 **execute 包装层** 统一归一为：
 *
 *     { ok: false, code, reason, next }
 *
 * - code：稳定失败码（见 TOOL_FAILURE_CODES，≥8 类），供客户端渲染失败卡片、
 *   Agent 决定下一步、QA 做断言；成功结果不返回 code/next。
 * - reason：人读原因（尽量保留底层原文，便于排查）。
 * - next：下一步建议（可执行的一句话，不同 code 有默认值，可按场景覆盖）。
 * - 成功结果保持原结构不变，只保证 `ok: true`。
 *
 * 归一只发生在「工具执行出口」一处（withToolContract），34 个工具的业务代码
 * 不需要逐个改；新增工具自动获得该契约。
 * ====================================================================== */

export const TOOL_FAILURE_CODES = Object.freeze({
  'not-found': {
    label: '目标不存在',
    next: '先用列表/读取类工具核对项目名、集数、草稿 id 或任务 id，再重试。',
  },
  'invalid-args': {
    label: '参数不合法',
    next: '按 reason 指出的位置修正参数后重试；必填参数不要留空。',
  },
  conflict: {
    label: '状态冲突',
    next: '先读取最新状态（列表/详情）再决定是否重试；不要用相同参数反复重试。',
  },
  permission: {
    label: '权限或操作范围不允许',
    next: '只能操作当前短剧项目目录内允许的节点；必需目录/文件不可删除，二级节点改名/删除 P1 不开放。',
  },
  'budget-exceeded': {
    label: '超出预算上限',
    next: '与用户确认，或用 drama_budget（action=set）调整上限后再提交；不要直接重试。',
  },
  'upstream-unavailable': {
    label: '外部后端不可用',
    next: '检查 libtv / neowow CLI 登录态与画布绑定；必要时切换备用后端。',
  },
  'io-error': {
    label: '读写失败',
    next: '检查文件是否被占用、磁盘空间是否充足，稍后重试一次；不要反复写同一文件。',
  },
  timeout: {
    label: '操作超时',
    next: '稍后重试；长任务改用分批提交 + 收敛（submit_batch / collect_batch），不要一次等到底。',
  },
  aborted: {
    label: '操作被取消或超时',
    next: '等待用户明确批准后重试；被用户取消的高危操作不要自动重试。',
  },
  'approval-stale': {
    label: '审批已过期或不匹配',
    next: '重新向用户申请批准（不要复用旧批准或伪造审批指纹）。',
  },
  unsupported: {
    label: '不支持的操作',
    next: '换用受支持的格式/类型/后端；或如实告知用户该能力尚未实现。',
  },
  unknown: {
    label: '未知错误',
    next: '把 reason 原文告知用户；不要用相同参数反复重试。',
  },
})

/** 旧代码里把「伪错误码」塞在 reason 里的分支（如预算闸门的 over-budget）。 */
const LEGACY_REASON_CODES = {
  'over-budget': 'budget-exceeded',
  'no-backends': 'upstream-unavailable',
  'no-backend': 'upstream-unavailable',
  'no-catalog': 'upstream-unavailable',
  'no-bind': 'upstream-unavailable',
}

/** 中文错误文本 → 失败码；顺序敏感：先具体（预算/IO/超时/上游），再笼统（参数/未知）。 */
const FAILURE_RULES = [
  ['budget-exceeded', /预算|积分.{0,10}上限|超出.{0,10}上限|over-budget/i],
  ['io-error', /EPERM|EBUSY|EACCES|ENOSPC|EISDIR|EROFS|磁盘|写入失败|读取失败|rename|atomicWrite/i],
  ['timeout', /超时|timeout|timed out|aborted|abort/i],
  ['upstream-unavailable', /后端不可用|后端不提供|cl[i]?\s|未登录|未绑定|画布|上游|network|fetch failed|ECONN|ENOTFOUND/i],
  ['permission', /越界|不允许|禁止|没有权限|权限|不能删除|必需|只支持|不可删除/i],
  ['not-found', /不存在|找不到|未找到|还没有|没有有效工作范围|无法定位|已删除/i],
  ['conflict', /已存在|已处理|已登记|重复|冲突|已被|不能覆盖|已经存在/i],
  ['unsupported', /不支持|暂不支持|尚未实现|未文档化/i],
  ['invalid-args', /必须|需要|需在|请指定|请写明|不能为空|为空|不合法|非法|格式不正确|缺少|未提供|过长|超过|须|无效|不能包含|不能使用|只能是/i],
]

/** 结构化失败异常：业务代码想显式指定失败码时 throw 它（可选，非必需）。 */
export class ToolFailure extends Error {
  constructor(code, reason, next) {
    super(reason || (TOOL_FAILURE_CODES[code] && TOOL_FAILURE_CODES[code].label) || '工具执行失败')
    this.name = 'ToolFailure'
    this.code = code in TOOL_FAILURE_CODES ? code : 'unknown'
    this.reason = String(reason || this.message)
    this.next = next || TOOL_FAILURE_CODES[this.code].next
  }
}

/** 构造统一失败结果（给工具内部主动返回失败时用）。 */
export function toolFailure(code, reason, next) {
  const safeCode = code in TOOL_FAILURE_CODES ? code : 'unknown'
  return {
    ok: false,
    code: safeCode,
    reason: String(reason || TOOL_FAILURE_CODES[safeCode].label),
    next: String(next || TOOL_FAILURE_CODES[safeCode].next),
  }
}

/** 任意 catch 到的错误 → { code, reason, next }（分类器，纯函数，可离线断言）。 */
export function classifyToolFailure(error) {
  if (error instanceof ToolFailure) {
    return { code: error.code, reason: error.reason, next: error.next }
  }
  const message = error instanceof Error ? error.message : String(error)
  const rawCode = error && typeof error.code === 'string' ? error.code : ''
  if (rawCode in TOOL_FAILURE_CODES) {
    return { code: rawCode, reason: message || TOOL_FAILURE_CODES[rawCode].label, next: TOOL_FAILURE_CODES[rawCode].next }
  }
  // Node 系统错误（EPERM/EBUSY/ENOSPC…）统一归 IO
  if (/^E[A-Z]{2,}$/.test(rawCode)) {
    return { code: 'io-error', reason: message || `系统错误：${rawCode}`, next: TOOL_FAILURE_CODES['io-error'].next }
  }
  for (const [code, pattern] of FAILURE_RULES) {
    if (pattern.test(message)) return { code, reason: message || TOOL_FAILURE_CODES[code].label, next: TOOL_FAILURE_CODES[code].next }
  }
  return { code: 'unknown', reason: message || TOOL_FAILURE_CODES.unknown.label, next: TOOL_FAILURE_CODES.unknown.next }
}

/** 成功结果只补 ok；失败结果归一成 { ok:false, code, reason, next }（保留附加字段）。 */
export function normalizeToolResult(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: true, value }
  if (value.ok !== false) return value.ok === true ? value : { ...value, ok: true }

  const declared =
    (typeof value.code === 'string' && value.code in TOOL_FAILURE_CODES ? value.code : '') ||
    LEGACY_REASON_CODES[String(value.reason || '')] ||
    ''
  // reason 优先取可读的中文文本（detail/error/message/reason 顺序），再交给分类器。
  const candidates = [value.detail, value.error, value.message, value.reason]
  const text = candidates.find((item) => typeof item === 'string' && /[\u4e00-\u9fa5]/.test(item)) ||
    candidates.find((item) => typeof item === 'string' && item.trim()) ||
    '操作未完成'
  const synthetic = Object.assign(new Error(text), declared ? { code: declared } : {})
  const failure = classifyToolFailure(synthetic)
  return {
    ...value,
    ok: false,
    code: failure.code,
    reason: failure.reason,
    next: typeof value.next === 'string' && value.next ? value.next : failure.next,
  }
}

/** execute 统一包装：成功原样返回，异常/主动失败都归一为失败码。 */
export function withToolContract(_name, execute) {
  return async (args, exec) => {
    try {
      return normalizeToolResult(await execute(args, exec))
    } catch (error) {
      const failure = classifyToolFailure(error)
      return { ok: false, code: failure.code, reason: failure.reason, next: failure.next }
    }
  }
}

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })

const TITLE = str('短剧名称（项目名）。省略时若当前工作区只有一个短剧则自动选用。')

async function resolveTitle(root, args) {
  const want = args && typeof args.title === 'string' ? args.title.trim() : ''
  if (want) return want
  const projects = await store.listProjects(root)
  if (projects.length === 1) return projects[0].title
  if (!projects.length) throw new Error('当前工作区还没有短剧项目，请先调用 drama_create_project')
  throw new Error(`当前工作区有 ${projects.length} 个短剧，请在参数中明确 title`)
}

function summarize(project) {
  return {
    title: project.title,
    path: project.path,
    episodeCount: project.episodeCount,
  }
}

/** 采纳草稿：把内容落到正式目录。 */
async function applyDraft(root, title, draft) {
  switch (draft.kind) {
    case 'contract':
      return { applied: 'contract', result: await store.saveContract(root, title, JSON.parse(draft.content)) }
    case 'outline':
      return { applied: 'outline', result: await store.saveOutline(root, title, JSON.parse(draft.content)) }
    case 'characters':
      return { applied: 'characters', result: await store.saveCharacters(root, title, JSON.parse(draft.content)) }
    case 'episode':
      return { applied: 'episode', result: await store.writeEpisode(root, title, draft.order, draft.content) }
    case 'storyboard':
      return { applied: 'storyboard', result: await store.saveStoryboard(root, title, draft.order, JSON.parse(draft.content)) }
    case 'file': {
      if (!draft.path) throw new Error('草稿缺少目标路径')
      return { applied: 'file', result: await store.writeEntryFile(root, title, draft.path, draft.content) }
    }
    default:
      throw new Error(`未知草稿类型：${draft.kind}`)
  }
}

export function createToolDefs(deps, options = {}) {
  const rootOf = deps.rootOf

  /** 取阶段二后端（LibTV / neowow）。未就绪时给出可读错误，不静默失败。 */
  const backendFor = (_exec, id) => {
    const backend = deps.backendOf ? deps.backendOf(id) : null
    if (!backend) throw new Error(`后端不可用：${id}（可能是插件未完成装配，或该后端未安装）`)
    return backend
  }

  /** 从工具执行上下文取宿主服务（如 userQuestions）。 */
  const agentServiceOf = (exec, serviceName) => {
    const agent = exec && exec.agent
    const agentCtx = agent && agent.ctx
    if (!agentCtx) return undefined
    try {
      if (typeof agentCtx.get === 'function') return agentCtx.get(serviceName)
    } catch {
      return undefined
    }
    return agentCtx[serviceName]
  }

  /**
   * P1-N / T5：高危操作前向用户申请结构化批准（E2：复用 userQuestions 工具通道，不新增 route）。
   * 返回 `{ approval }`（批准，含指纹）或 `{ failure }`（P1-A 失败契约形状，直接 return）。
   */
  const requestToolApproval = async (exec, meta) => {
    const result = await approval.requestApproval({
      userQuestions: agentServiceOf(exec, 'userQuestions'),
      agent: exec && exec.agent,
      signal: exec && exec.signal,
      callId: exec && exec.callId,
      ...meta,
    })
    if (result.ok) {
      return {
        approval: {
          kind: meta.kind,
          approved: true,
          fingerprint: result.token.fingerprint,
          issuedAt: result.token.issuedAt,
          expiresAt: result.token.expiresAt,
        },
      }
    }
    return { failure: approval.approvalFailureOf(result) }
  }

  const defs = [
    {
      name: 'drama_list_projects',
      description: '列出当前工作区下的全部短剧项目（名称、路径、已有分集数）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async (_args, exec) => {
        const root = rootOf(exec)
        const projects = await store.listProjects(root)
        return { ok: true, projects: projects.map(summarize) }
      },
    },
    {
      name: 'drama_create_project',
      description: '新建一个短剧项目，并生成固定的创作目录结构（剧集契约、总纲、人物、分集剧本、分镜等 14 个一级节点）。',
      parameters: {
        type: 'object',
        properties: { title: str('短剧名称，例如：万界倒爷：先发育再屠神') },
        required: ['title'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const project = await store.createProject(root, args.title)
        return { ok: true, project: summarize(project) }
      },
    },
    {
      name: 'drama_get_project',
      description: '读取一个短剧项目的当前状态：剧集契约、分集大纲、人物设定卡、已有分集与待处理草稿数。写剧本前应先调用它获取上下文。',
      parameters: {
        type: 'object',
        properties: { title: TITLE },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const [contract, outline, characters, episodes] = await Promise.all([
          store.getContract(root, title),
          store.getOutline(root, title),
          store.getCharacters(root, title),
          store.listEpisodes(root, title),
        ])
        return {
          ok: true,
          title,
          contract,
          outline,
          characters,
          episodes: episodes.map((e) => e.order),
          pendingDrafts: await drafts.pendingCount(store.projectDir(root, title)),
        }
      },
    },
    {
      name: 'drama_save_contract',
      description: '保存剧集契约（平台、受众、单集时长、目标集数、画幅、钩子密度、审核红线）。这是后续所有生成的强约束输入。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          contract: {
            type: 'object',
            description: '要写入的契约字段（可只传需要修改的字段）',
            properties: {
              platform: str('投放平台'),
              audience: str('目标受众'),
              episodeDurationSec: { type: 'array', items: num('秒'), description: '[下限, 上限]' },
              targetEpisodes: num('目标集数'),
              orientation: { type: 'string', enum: ['portrait', 'landscape'] },
              hookDensity: str('钩子密度要求'),
              redlines: str('审核红线'),
            },
            additionalProperties: false,
          },
        },
        required: ['contract'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        return { ok: true, contract: await store.saveContract(root, title, args.contract) }
      },
    },
    {
      name: 'drama_save_outline',
      description: '保存分集大纲（整表覆盖）。每集含：集数、标题、一句话梗概、开场钩子、中段反转、结尾悬念、预计时长。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          rows: {
            type: 'array',
            description: '分集大纲数组，整表覆盖',
            items: {
              type: 'object',
              properties: {
                order: num('集数，从 1 开始'),
                title: str('本集标题'),
                logline: str('一句话梗概'),
                hook: str('开场钩子'),
                twist: str('中段反转'),
                cliffhanger: str('结尾悬念'),
                estDurationSec: num('预计时长（秒）'),
              },
              required: ['order'],
              additionalProperties: false,
            },
          },
        },
        required: ['rows'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const rows = await store.saveOutline(root, title, args.rows)
        return { ok: true, count: rows.length, rows }
      },
    },
    {
      name: 'drama_save_characters',
      description: '保存人物设定卡（整表覆盖）。每张卡含：姓名、身份、性格关键词、小传、形象提示词、音色。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          characters: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: str('角色姓名'),
                role: { type: 'string', enum: ['主角', '反派', '配角', '龙套'] },
                personality: { type: 'array', items: str('性格关键词') },
                bio: str('小传'),
                appearancePrompt: str('形象提示词，用于生图一致性'),
                voiceHint: str('音色描述'),
              },
              required: ['name'],
              additionalProperties: false,
            },
          },
        },
        required: ['characters'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const characters = await store.saveCharacters(root, title, args.characters)
        return { ok: true, count: characters.length }
      },
    },
    {
      name: 'drama_read_episode',
      description: '读取某一集的剧本正文。',
      parameters: {
        type: 'object',
        properties: { title: TITLE, order: num('集数') },
        required: ['order'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        return { ok: true, title, ...(await store.readEpisode(root, title, args.order)) }
      },
    },
    {
      name: 'drama_save_draft',
      description:
        '把生成结果写入草稿区（不直接改正式稿）。用户采纳后才进入正式目录。生成剧本/大纲/人物/分镜后应调用本工具保存，而不是直接写入正式文件。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          kind: { type: 'string', enum: ['contract', 'outline', 'characters', 'episode', 'storyboard', 'file'] },
          order: num('当 kind 为 episode / storyboard 时必填：集数'),
          path: str('当 kind 为 file 时必填：项目内相对路径，例如 构想/灵感.md'),
          content: str('草稿内容。episode/file 为正文文本；其余为对应结构的 JSON 字符串'),
          note: str('给用户看的一句话说明'),
        },
        required: ['kind', 'content'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const dir = store.projectDir(root, title)
        const draft = await drafts.createDraft(dir, {
          kind: args.kind,
          order: args.order,
          path: args.path,
          content: args.content,
          note: args.note,
          origin: {
            preset: 'drama',
            toolName: 'drama_save_draft',
            callId: exec && exec.callId,
            model: exec && exec.model,
          },
        })
        return { ok: true, draftId: draft.id, status: draft.status, hint: '请在「AI 短剧」面板的草稿区中采纳' }
      },
    },
    {
      name: 'drama_list_drafts',
      description: '列出草稿区中待处理的生成结果。',
      parameters: {
        type: 'object',
        properties: { title: TITLE, includeResolved: { type: 'boolean', description: '是否包含已处理草稿' } },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const list = await drafts.listDrafts(store.projectDir(root, title), { includeResolved: Boolean(args.includeResolved) })
        return {
          ok: true,
          drafts: list.map((d) => ({ id: d.id, kind: d.kind, title: d.title, order: d.order, status: d.status, note: d.note, createdAt: d.createdAt })),
        }
      },
    },
    {
      name: 'drama_resolve_draft',
      description:
        '采纳（accept）/丢弃（discard）/恢复（restore）草稿。accept 会把内容写入正式目录并留痕；discard 只改状态、可恢复；restore 把已丢弃草稿放回草稿区。支持单条（id）与批量（ids），批量逐条返回结果。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          id: str('单条草稿 id（与 ids 二选一，ids 优先）'),
          ids: { type: 'array', items: { type: 'string' }, description: '批量草稿 id 列表' },
          action: { type: 'string', enum: ['accept', 'discard', 'restore'] },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const dir = store.projectDir(root, title)
        if (!['accept', 'discard', 'restore'].includes(args.action)) throw new Error('action 只能是 accept、discard 或 restore')
        const batchIds = Array.isArray(args.ids) ? args.ids.map((id) => String(id || '').trim()).filter(Boolean) : []
        const legacy = batchIds.length === 0
        const targets = legacy ? [String(args.id || '').trim()].filter(Boolean) : batchIds
        if (!targets.length) throw new Error('需要提供 id 或 ids')

        // T5 高危①：批量采纳草稿（≥2 条）→ 必须先获用户批准
        let approvalInfo = null
        if (args.action === 'accept' && targets.length > 1) {
          const gate = await requestToolApproval(exec, {
            kind: 'batch-accept-drafts',
            title,
            summary: `将批量采纳 ${targets.length} 条草稿并写入正式成稿，是否批准？`,
            detail: '采纳会覆盖对应正式目录内容（覆盖前保留历史快照）；建议逐条确认内容后再批量采纳。',
            payload: { title, ids: targets, action: 'accept' },
          })
          if (gate.failure) return gate.failure
          approvalInfo = gate.approval
        }

        let legacyApplied = null
        const apply = async (draft) => {
          const applied = await applyDraft(root, title, draft)
          legacyApplied = applied
          return applied
        }
        const rawResults = await drafts.resolveMany(dir, targets, args.action, { apply })
        const results = rawResults.map((item) => {
          if (item.ok) return item
          const failure = classifyToolFailure(new Error((item.error && item.error.reason) || '草稿处理失败'))
          return { ...item, error: { code: failure.code, reason: failure.reason, next: failure.next } }
        })
        const counts = drafts.countDraftResults(results)
        if (legacy) {
          const only = results[0]
          if (!only || only.ok !== true) throw new Error((only && only.error && only.error.reason) || '草稿处理失败')
          if (args.action === 'accept') return { ok: true, status: only.status, ...(legacyApplied || {}), results, counts }
          if (args.action === 'restore') return { ok: true, status: 'restored', draftStatus: only.draftStatus || 'pending', results, counts }
          return { ok: true, status: only.status, results, counts }
        }
        return { ok: true, ...(approvalInfo ? { approval: approvalInfo } : {}), results, counts }
      },
    },
    {
      name: 'drama_search_context',
      description:
        '在当前短剧项目内检索相关设定与桥段（人物、大纲、剧本、分镜、构想、世界观、本剧记忆），返回最相关的片段。写新内容前先检索，可显著降低人物 OOC 与设定冲突。本地词法检索，无需外部服务。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          query: str('检索问题或关键词，例如：林越 与 赵铁 的关系'),
          topK: num('返回条数，默认 5，上限 20'),
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        return { ok: true, title, ...(await searchContext(root, title, args.query, { topK: args.topK })) }
      },
    },
    {
      name: 'drama_get_progress',
      description:
        '查看短剧的创作进度与关键事实：当前处于哪个阶段（项目→大纲→人物→剧本→分镜→已导出）、各阶段是否就绪、集数/角色数/记忆条目等统计。开始新一轮创作前先调用它判断该做哪一步。',
      parameters: {
        type: 'object',
        properties: { title: TITLE },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        return { ok: true, title, ...(await store.getProgress(root, title)) }
      },
    },
    {
      name: 'drama_save_memory',
      description:
        '保存本剧记忆（整表覆盖）：伏笔、已用桥段、时间线、待回收线索。写过重要情节后应登记，供后续生成避免重复与冲突。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          memory: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: str('条目 id，可省略（自动生成）'),
                kind: { type: 'string', enum: ['伏笔', '已用桥段', '时间线', '待回收'] },
                content: str('一句话说明这条记忆'),
                episode: num('关联集数，可省略'),
                status: { type: 'string', enum: ['open', 'resolved'] },
              },
              required: ['content'],
              additionalProperties: false,
            },
          },
        },
        required: ['memory'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const memory = await store.saveMemory(root, title, args.memory)
        return { ok: true, count: memory.length }
      },
    },
    {
      name: 'drama_save_world',
      description:
        '保存世界观设定（整表覆盖）：地点、组织、规则、道具、时间线。写分集剧本或分镜前应先把相关设定登记好，后续生成与一致性检查都会引用。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          world: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: str('条目 id，可省略'),
                kind: { type: 'string', enum: ['地点', '组织', '规则', '道具', '时间线'] },
                name: str('设定名称'),
                detail: str('说明'),
              },
              required: ['name'],
              additionalProperties: false,
            },
          },
        },
        required: ['world'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const world = await store.saveWorld(root, title, args.world)
        return { ok: true, count: world.length }
      },
    },
    {
      name: 'drama_get_dialogue',
      description:
        '汇总全剧台词：按角色归集（每人多少句、出现在哪几集），并列出逐句台词与分镜音效。润色台词、检查角色戏份、准备配音前调用。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          character: str('只看某个角色的台词（可选）'),
        },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const data = await store.getDialogue(root, title)
        const filter = args.character ? String(args.character).trim() : ''
        const lines = filter ? data.lines.filter((l) => l.character === filter) : data.lines
        return {
          ok: true,
          title,
          byCharacter: data.byCharacter,
          lineCount: lines.length,
          lines: lines.slice(0, 300),
          sfx: data.sfx.slice(0, 200),
          truncated: lines.length > 300,
        }
      },
    },
    {
      name: 'drama_export_voice_script',
      description: '导出配音稿：按集生成「场次 / 角色 / 台词」表格，写到项目 台词与音效/ 目录，可直接交给配音。',
      parameters: {
        type: 'object',
        properties: { title: TITLE, order: num('只导出某一集；省略则导出全部有台词的集') },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const result = await store.exportVoiceScript(root, title, args.order)
        return { ok: true, ...result, note: '产物在项目「台词与音效/」目录下' }
      },
    },
    {
      name: 'drama_list_assets',
      description: '列出项目已登记的素材（分镜图、视频片段、配音、参考文档等）。这些只是路径引用，原始文件不在项目内。',
      parameters: {
        type: 'object',
        properties: { title: TITLE },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const assets = await store.getAssets(root, title)
        return { ok: true, count: assets.length, assets: assets.map(assetForOutput) }
      },
    },
    {
      name: 'drama_add_asset',
      description:
        '登记一个外部素材（生成好的分镜图 / 视频片段 / 配音等）：只记录路径与校验信息，不复制原始文件。可关联镜头号，便于回溯。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          source: str('素材文件的绝对路径'),
          name: str('显示名，省略则用文件名'),
          kind: { type: 'string', enum: ['image', 'audio', 'video', 'doc', 'other'] },
          note: str('说明'),
          linkedShots: { type: 'array', items: str('镜号，例如 1-3'), description: '关联的镜头号' },
        },
        required: ['source'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const asset = await store.addAsset(root, title, args)
        return { ok: true, asset: assetForOutput(asset) }
      },
    },
    {
      name: 'drama_finalize_episode',
      description:
        '把某一集定稿：冻结当前剧本与分镜成一份带版本号的快照，写入项目「定稿/」目录；也可用 restoreVersion 回滚到历史定稿（高危，需用户批准）。可多次定稿形成版本序列。定稿前应先 drama_check_consistency；strict=true 时确定性检查不通过会拒绝定稿（T10 校验链联动）。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          order: num('要定稿（或回滚）的集数'),
          strict: { type: 'boolean', description: '为 true 时先跑确定性检查，不通过则拒绝定稿并给出定位（默认 false）' },
          restoreVersion: num('回滚到某个已定稿版本号（需用户批准；省略=正常定稿）'),
        },
        required: ['order'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        // T5 高危④：定稿回滚会覆盖当前剧本/分镜 → 必须先获用户批准
        if (args.restoreVersion != null) {
          const gate = await requestToolApproval(exec, {
            kind: 'restore-finalized-version',
            title,
            summary: `将把「${title}」第 ${args.order} 集回滚到已定稿 v${args.restoreVersion}，当前剧本与分镜会被覆盖，是否批准？`,
            detail: '回滚前当前内容会有历史快照；如需恢复到回滚前状态，可再次定稿新版本。',
            payload: { title, order: Number(args.order), version: Number(args.restoreVersion) },
          })
          if (gate.failure) return gate.failure
          const restored = await store.restoreFinalized(root, title, args.order, args.restoreVersion)
          return { ok: true, ...restored, approval: gate.approval }
        }
        // T10：定稿侧校验联动——strict 时先检查、不过不落任何快照（与导出 strict 语义一致）。
        if (args.strict) {
          const pre = await runDeterministicChecks(root, { title })
          if (!pre.ok) {
            const failed = pre.checks.filter((item) => !item.ok)
            return toolFailure(
              'invalid-args',
              `确定性检查未通过，已拒绝定稿（${failed.map((item) => `${item.label}${item.detail ? `：${item.detail}` : ''}`).join('；') || '见 checks'}）`,
              '先修复检查项（可用 drama_check_consistency 定位），或去掉 strict 只定稿后人工复核。',
            )
          }
          const result = await store.finalizeEpisode(root, title, args.order)
          return { ok: true, ...result, checks: { ok: pre.ok, summary: pre.summary } }
        }
        return { ok: true, ...(await store.finalizeEpisode(root, title, args.order)) }
      },
    },
    {
      name: 'drama_list_finalized',
      description: '列出各集已定稿的版本（版本号、定稿时间、行数、镜头数、快照文件）。',
      parameters: {
        type: 'object',
        properties: { title: TITLE },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const finalized = await store.getFinalized(root, title)
        return { ok: true, count: finalized.length, finalized }
      },
    },
    {
      name: 'drama_get_ledger',
      description:
        '生成项目账本：按集统计场景数、内外景、镜头数、时长、出场角色与地点，并给出成本提示（外景比例、角色数、地点数、单集镜头量）。制片与成本评估用。',
      parameters: {
        type: 'object',
        properties: { title: TITLE },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const ledger = await store.renderLedger(root, title)
        return { ok: true, totals: ledger.totals, warnings: ledger.warnings, perEpisode: ledger.perEpisode }
      },
    },
    {
      name: 'drama_import_script',
      description:
        '导入已有剧本文本：按「# 第N集」切分集数、按「## 场景」识别场次，写入 分集剧本/ 目录。默认只预览不落盘（preview），确认后再用 apply 落盘；已存在的集默认跳过。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          text: str('要导入的剧本文本'),
          action: { type: 'string', enum: ['preview', 'apply'], description: 'preview 只解析返回结构，apply 才写盘' },
          overwrite: { type: 'boolean', description: 'apply 时是否覆盖已存在的集，默认 false' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        if ((args.action || 'preview') === 'preview') {
          const parsed = store.splitScript(args.text, {})
          return {
            ok: true,
            action: 'preview',
            stats: parsed.stats,
            episodes: parsed.episodes.map((e) => ({ order: e.order, title: e.title, scenes: e.scenes, lines: e.lines, characters: e.characters })),
          }
        }
        const title = await resolveTitle(root, args)
        let approvalInfo = null
        // T5 高危①：导入覆盖已有集 → 必须先获用户批准
        if (args.overwrite === true) {
          const gate = await requestToolApproval(exec, {
            kind: 'import-overwrite-episodes',
            title,
            summary: `导入会覆盖「${title}」中已存在的分集剧本，是否批准？`,
            detail: '覆盖前会保留历史快照，但正式剧本文件将被替换；已存在的集默认跳过，overwrite=true 才覆盖。',
            payload: { title, overwrite: true, textLength: String(args.text || '').length },
          })
          if (gate.failure) return gate.failure
          approvalInfo = gate.approval
        }
        const result = await store.importScript(root, title, args.text, { overwrite: args.overwrite })
        return { ok: true, action: 'apply', ...(approvalInfo ? { approval: approvalInfo } : {}), ...result }
      },
    },
    {
      name: 'drama_plan_generation',
      description:
        '提交生成前的规划与预算闸门：登记一条生成任务并检查项目预算。返回 allowed=false 说明会超预算，必须先与用户确认或调整预算，不要直接提交。LibTV 与 neowow 都通过各自的 CLI 触发，生成前先用 drama_budget 看余额。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          backend: { type: 'string', enum: ['libtv', 'neowow'], description: '主选 libtv，不可用时用 neowow' },
          kind: { type: 'string', enum: ['image', 'video', 'audio'] },
          episode: num('集数'),
          shots: { type: 'array', items: str('镜号'), description: '本次覆盖的镜号' },
          model: str('模型名（LibTV 用 modelName，neowow 用 model_name）'),
          prompt: str('提示词'),
          estimatePoints: num('预估积分（neowow 图片可用目录矩阵本地推算；LibTV 只给文字计价规则）'),
        },
        required: ['backend', 'kind'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const gate = await generation.checkBudget(root, title, args.estimatePoints || 0)
        if (!gate.ok) {
          return { ok: false, allowed: false, reason: gate.reason, detail: gate.detail, budget: gate.budget }
        }
        const task = await generation.createTask(root, title, args)
        return { ok: true, allowed: true, task, budget: gate.budget, remainingAfter: gate.remainingAfter ?? null }
      },
    },
    {
      name: 'drama_record_generation',
      description:
        '回写生成任务结果：状态（submitted/running/done/failed/cancelled）、平台侧 id、实际消耗积分、错误信息。done/failed 时把消耗记进台账，同一任务只记一次。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          id: str('任务 id（drama_plan_generation 返回）'),
          status: { type: 'string', enum: ['planned', 'submitted', 'running', 'done', 'failed', 'cancelled'] },
          externalId: str('平台侧任务/节点 id'),
          actualPoints: num('实际消耗积分'),
          error: str('失败原因'),
        },
        required: ['id'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const task = await generation.updateTask(root, title, args.id, {
          status: args.status,
          externalId: args.externalId,
          actualPoints: args.actualPoints,
          error: args.error,
        })
        return { ok: true, task, budget: await generation.getBudget(root, title) }
      },
    },
    {
      name: 'drama_intake_artifact',
      description:
        '把生成产物收进项目（FR-G05）：远端 URL 会下载、本地文件会拷入，统一落到「素材/生成/」并登记 sha256、来源 URL、后端、模型、任务 id 与关联镜号。生成完成后必须调用，否则产物只在平台侧、断网即失。LibTV 用 libtv download 取到本地后再传 file。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          url: str('远端产物地址（与 file 二选一）'),
          file: str('本地产物绝对路径（与 url 二选一）'),
          kind: { type: 'string', enum: ['image', 'video', 'audio', 'doc', 'other'] },
          name: str('显示名，省略则用文件名'),
          episode: num('所属集数'),
          shots: { type: 'array', items: str('镜号') },
          taskId: str('对应任务 id'),
          backend: str('产出后端'),
          model: str('产出模型'),
          note: str('说明'),
        },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const result = await generation.intakeArtifact(root, title, args)
        return { ok: true, file: result.relative, bytes: result.bytes, sha256: result.sha256, assetId: result.asset.id }
      },
    },
    {
      name: 'drama_budget',
      description: '查看或设置项目生成预算。action=get 返回上限/已消耗/剩余与最近消耗；action=set 需要 limitPoints（传 null 取消上限）。任何生成前都应先看预算。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          action: { type: 'string', enum: ['get', 'set'] },
          limitPoints: num('预算上限（action=set 时使用）'),
        },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        if ((args.action || 'get') === 'set') {
          return { ok: true, budget: await generation.setBudgetLimit(root, title, args.limitPoints) }
        }
        const budget = await generation.getBudget(root, title)
        return { ok: true, budget: { ...budget, entries: budget.entries.slice(-10) } }
      },
    },
    {
      name: 'drama_plan_batch',
      description:
        '按集规划一次生成批次（FR-G02 分镜图 / FR-G03 分镜视频 / FR-G04 配音）：读分镜表，逐镜构造提示词与参数，跑预算闸门并登记任务。**只规划不触发**——确认无误后再调 drama_submit_batch。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          episode: num('集数'),
          kind: { type: 'string', enum: ['image', 'video', 'audio'] },
          backend: { type: 'string', enum: ['libtv', 'neowow'] },
          model: str('模型名（LibTV 用 modelName）'),
          shots: { type: 'array', items: str('镜号'), description: '只生成这些镜；省略则整集' },
          ratio: str('画幅，默认 9:16'),
          style: str('追加到每条提示词的风格描述'),
          estimatePerUnitPoints: num('单镜预估积分，用于预算闸门'),
        },
        required: ['episode', 'kind', 'backend'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        return { ok: true, plan: await orchestrator.planEpisode(root, title, args) }
      },
    },
    {
      name: 'drama_submit_batch',
      description: '把 drama_plan_batch 产出的批次真正提交到后端触发。逐镜提交，单镜失败不影响其余；返回每镜的提交结果。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          backend: { type: 'string', enum: ['libtv', 'neowow'] },
          kind: { type: 'string', enum: ['image', 'video', 'audio'] },
          model: str('模型名'),
          items: {
            type: 'array',
            description: 'plan.items 原样传入，每项需含 taskId / name / prompt / params',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['backend', 'kind', 'items'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        // T5 高危③：生成批次提交会真实计费 → 必须先获用户批准
        const gate = await requestToolApproval(exec, {
          kind: 'submit-generation-batch',
          title,
          summary: `将提交「${title}」的 ${Array.isArray(args.items) ? args.items.length : 0} 项生成任务到 ${args.backend || '后端'}，可能产生真实费用，是否批准？`,
          detail: `项目：${title} · 类型：${args.kind || 'image'} · 模型：${args.model || '默认'} · 提交前请确认预算与画布网页端已关闭。`,
          payload: {
            title,
            backend: args.backend || '',
            kind: args.kind || '',
            model: args.model || '',
            taskIds: (Array.isArray(args.items) ? args.items : []).map((item) => (item && item.taskId ? String(item.taskId) : '')).filter(Boolean),
          },
        })
        if (gate.failure) return gate.failure
        const resolve = (id) => backendFor(exec, id)
        return { ok: true, approval: gate.approval, ...(await orchestrator.submitBatch(root, title, { ...args, resolveBackend: resolve })) }
      },
    },
    {
      name: 'drama_collect_batch',
      description:
        '收敛已提交的批次：查询每个节点状态，已产出的取回本地并回流到「素材/生成/」（登记 sha256 与溯源），然后结算任务。未完成的留在 pending，可稍后再调。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          backend: { type: 'string', enum: ['libtv', 'neowow'] },
          taskIds: { type: 'array', items: str('任务 id'), description: '只收敛这些任务；省略则收敛全部在途任务' },
        },
        required: ['backend'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const resolve = (id) => backendFor(exec, id)
        return { ok: true, ...(await orchestrator.collectBatch(root, title, { ...args, resolveBackend: resolve })) }
      },
    },
    {
      name: 'drama_canvas_status',
      description:
        '查看外部画布对接状态（FR-G08）：项目目录绑定的是哪张画布、可选的画布列表、当前画布节点指纹。**提交生成前应先看这个**——未绑定画布就生成会把节点写到错误的位置。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          backend: { type: 'string', enum: ['libtv', 'neowow'] },
        },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const backendId = args.backend || 'libtv'
        const backend = backendFor(exec, backendId)
        const cwd = store.projectDir(root, title)
        const binding = await guard.checkBinding(root, title, backendId)
        const snapshot = binding.ok && backend ? await guard.snapshotCanvas(backend, { cwd }) : null
        let canvases = null
        if (backend && typeof backend.listCanvases === 'function') {
          canvases = await backend.listCanvases({ cwd }).catch(() => null)
        }
        return { ok: true, backend: backendId, binding, snapshot, canvases, upstreamWarning: guard.UPSTREAM_WARNING }
      },
    },
    {
      name: 'drama_bind_canvas',
      description: '把当前短剧项目目录绑定到一张外部画布（绑定后该项目下的生成都会落到这张画布）。绑定前先用 drama_canvas_status 看候选列表。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          backend: { type: 'string', enum: ['libtv', 'neowow'] },
          uuid: str('画布 UUID（LibTV 为 projectUuid，neowow 为 sessionId）'),
        },
        required: ['uuid'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const backendId = args.backend || 'libtv'
        const backend = backendFor(exec, backendId)
        if (!backend || typeof backend.bindCanvas !== 'function') throw new Error(`后端 ${backendId} 不支持画布绑定`)
        const cwd = store.projectDir(root, title)
        const result = await backend.bindCanvas({ uuid: args.uuid, cwd })
        return { ok: true, ...result, binding: await guard.checkBinding(root, title, backendId) }
      },
    },
    {
      name: 'drama_reconcile_canvas',
      description:
        '双主防护对账（FR-G12）：以项目分镜为唯一事实源，比对画布上按 E###-镜号 命名的节点，报告画布少了哪些镜、多了哪些节点。只报告差异，不自动改画布。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          episode: num('集数'),
          backend: { type: 'string', enum: ['libtv', 'neowow'] },
        },
        required: ['episode'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const backendId = args.backend || 'libtv'
        const backend = backendFor(exec, backendId)
        if (!backend) throw new Error(`后端不可用：${backendId}`)
        const cwd = store.projectDir(root, title)
        return { ok: true, ...(await guard.reconcile(root, title, { backend, episode: args.episode, cwd })) }
      },
    },
    {
      name: 'drama_check_consistency',
      description:
        '对短剧项目做一致性检查：契约完整性、集数一致性、剧本说话人是否在人物卡中、分镜时长是否超契约、镜号重复、分集缺口、重复桥段。deep=true 时追加**AI 审读**（单集，七维度：钩子/节奏、人设、可拍性、台词、平台红线、记忆/伏笔、时间线）：直连宿主默认模型，模型不可用/超预算/超时/输出非法时自动降级为确定性结果并标记 degraded（不报错、默认不阻断定稿/导出）。无模型环境下 deep 会返回「待审切片+rubric+确定性预检」，Agent 判断后用 saveReview 参数保存结构化报告。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          deep: { type: 'boolean', description: '为 true 时对指定单集做 AI 审读（默认 false，行为与旧版一致）' },
          episode: { type: 'integer', description: 'deep/saveReview 时的单集集数（1~9999，Q7：先单集审读）' },
          maxTokens: { type: 'integer', description: '本次审读 token 预算（1000~60000，默认 60000）' },
          timeoutMs: { type: 'integer', description: '本次审读超时毫秒（1000~60000，默认 45000）' },
          saveReview: {
            type: 'object',
            description:
              'Agent-mediated 保存结构化审读报告：{findings:[{severity,dimension,location{episode,scene,shot?},evidence,suggestion,confidence,feedback?}],summary?,meta?,feedback?}（落 .aidrama/reviews/ 并更新 latest.json）',
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        const report = await checkConsistency(root, title)
        const wantsSave = Boolean(args.saveReview && typeof args.saveReview === 'object')
        const wantsDeep = args.deep === true
        // 默认（不传新参数）：与 0.5.1 完全一致
        if (!wantsSave && !wantsDeep) return { ok: true, ...report }
        const episode = Number(args.episode)
        if (!audit.isAuditSupportedEpisode(episode)) {
          throw new Error('deep=true 或 saveReview 时必须提供 episode（1~9999 的单集集数，Q7 先单集）')
        }
        if (wantsSave) {
          const review = audit.normalizeSaveReviewInput(args.saveReview, { episode })
          const saved = await audit.saveReview(root, title, review)
          return { ok: true, saved: true, path: saved.file, review: saved.review, report }
        }
        // deep=true
        const settings = await store.getSettings(root).catch(() => ({}))
        const llm = typeof deps.llmOf === 'function' ? deps.llmOf(exec) : null
        const selection = typeof deps.modelSelectionOf === 'function' ? deps.modelSelectionOf(exec) : null
        // P2-6（Q2/Q3）：任务级模型回退链 —— taskModels.audit → settings.defaultModel → agentDefaultModel
        const resolved = llm ? await audit.resolveAuditModel({ settings, defaultSelection: selection, llm, task: 'audit' }) : null
        const taskConfig = (resolved && resolved.config) || {}
        // Q4：工具显式参数优先于任务级配置；任务级 maxTokens/temperature 不得突破全局上限（resolveAuditBudgets 内钳制）
        const budgets = audit.resolveAuditBudgets({
          maxTokens: args.maxTokens != null ? args.maxTokens : taskConfig.maxTokens,
          timeoutMs: args.timeoutMs != null ? args.timeoutMs : taskConfig.timeoutMs,
          temperature: taskConfig.temperature,
        })
        const slices = await audit.buildAuditSlices(root, title, episode)
        if (!llm || typeof llm.stream !== 'function') {
          // 兜底 A：无模型服务 → agent-mediated 两段式（不报错）
          const request = audit.buildAgentAuditRequest({ slices: slices.slices, deterministic: report, budgets })
          return {
            ok: true,
            report,
            deep: {
              mode: 'agent-mediated',
              degraded: true,
              degradeReason: 'llm-service-unavailable',
              auditRequest: request,
              saveHint: request.saveHint,
            },
          }
        }
        // 主路径：直连宿主模型（P2-6 Q3：配置模型失败时自动回退宿主默认并标记 modelFallback）
        // D-12：共享运行上下文（首次/重试/回退共用同一 token 与超时预算，AC-R5 语义不变）
        const auditContext = audit.createAuditRunContext(budgets)
        const attempt = resolved
          ? await audit.runAuditWithFallback({
              llm,
              resolved,
              fallbackModel: selection,
              slices: slices.slices,
              deterministic: report,
              episode,
              budgets,
              context: auditContext,
            })
          : { outcome: { ok: false, degradeReason: 'no-default-model' }, usedModel: null }
        const outcome = attempt.outcome
        const usedModel = attempt.usedModel
        if (outcome.ok) {
          const saved = await audit.saveReview(root, title, outcome.review)
          return {
            ok: true,
            report,
            deep: {
              mode: 'model',
              degraded: false,
              degradeReason: null,
              review: saved.review,
              savedPath: saved.file,
              saveHint: '',
              // P2-6：实际使用模型与来源（供 Agent/面板/测试直接读取）
              model: saved.review.meta.model,
              provider: saved.review.meta.provider,
              modelSource: saved.review.meta.modelSource,
              modelFallback: saved.review.meta.modelFallback,
              modelFallbackReason: saved.review.meta.modelFallbackReason,
              modelRetried: Boolean(saved.review.meta.modelRetried),
            },
          }
        }
        // 兜底 B：模型失败/超时/超预算/坏 JSON → 降级确定性结果（AC-R6，不报错不阻断）
        // D-12：降级报告保留实际尝试的模型/provider/来源 + 原始输出片段（可观测性/诊断）
        const degradedReview = audit.buildDegradedReview({
          episode,
          deterministic: report,
          degradeReason: outcome.degradeReason,
          budgets,
          attempted: outcome.attempted,
          rawSnippet: outcome.rawSnippet,
        })
        let savedPath = null
        try {
          savedPath = (await audit.saveReview(root, title, degradedReview)).file
        } catch {
          savedPath = null
        }
        const request = audit.buildAgentAuditRequest({ slices: slices.slices, deterministic: report, budgets })
        return {
          ok: true,
          report,
          deep: {
            mode: 'deterministic',
            degraded: true,
            degradeReason: outcome.degradeReason,
            auditRequest: request,
            saveHint: request.saveHint,
            review: degradedReview,
            savedPath,
            // P2-6：配置模型信息（降级时仍可诊断用了哪个配置/是否回退过）
            model: resolved ? resolved.model : '',
            provider: resolved ? resolved.provider : '',
            modelSource: resolved ? resolved.source : 'none',
            modelFallback: Boolean(resolved && resolved.modelFallback),
            modelFallbackReason: resolved ? resolved.modelFallbackReason : null,
            // D-12：降级可观测性（实际尝试模型 + 是否 JSON 修复重试 + 原始输出片段）
            modelRetried: Boolean(outcome.attempted && outcome.attempted.retried),
            rawModelOutputSnippet: degradedReview.meta.rawModelOutputSnippet || null,
          },
        }
      },
    },
    {
      name: 'drama_export',
      description:
        '导出短剧项目：markdown（全本）、json（结构化包）、csv（拍摄用分镜表，含生图/视频提示词列）。产物写入项目 导出/ 目录，并生成 sha256 校验清单（manifest.sha256.json）与确定性检查摘要。strict=true 时检查不通过会拒绝导出。',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE,
          format: { type: 'string', enum: EXPORT_FORMATS },
          strict: { type: 'boolean', description: '为 true 时确定性检查不通过则拒绝导出（默认 false，只附检查摘要）' },
        },
        required: ['format'],
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const root = rootOf(exec)
        const title = await resolveTitle(root, args)
        // strict 闸门必须在写盘之前：检查不通过时返回 invalid-args 且**不产生任何导出产物**（D-05）。
        if (args.strict) {
          const pre = await runDeterministicChecks(root, { title })
          if (!pre.ok) {
            const failed = pre.checks.filter((item) => !item.ok)
            return toolFailure(
              'invalid-args',
              `确定性检查未通过，已拒绝导出（${failed.map((item) => item.label || item.id).join('、') || '见 checks'}）`,
              '先修复检查项（可用 drama_check_consistency 定位），或去掉 strict 只导出后人工复核。',
            )
          }
        }
        const result = await exportProject(root, title, args.format)
        return { ok: true, ...result, relative: path.relative(root, result.file) }
      },
    },
  ]

  // T3（P1-L）：测试用途工具只在显式环境变量开启时注册（生产环境工具面保持 34 个）。
  if (options.testTools === true) defs.push(...createTestToolDefs())

  /* ------------------------------------------------- P2-2（Q1/Q4）flow-state */
  /** 内容写工具 → flow-state 步骤（宿主自动同步，避免面板状态漂移）。 */
  const FLOW_TOOL_STEPS = {
    drama_save_contract: () => 'outline',
    drama_save_outline: () => 'outline',
    drama_save_characters: () => 'characters',
    drama_import_script: (args) => (args && args.action === 'apply' ? 'episode_script' : ''),
    drama_resolve_draft: (_args, result) => {
      if (!result || !Array.isArray(result.results)) return ''
      const applied = result.results.map((item) => item && item.applied).filter(Boolean)
      if (applied.includes('episode')) return 'episode_script'
      if (applied.includes('storyboard')) return 'storyboard'
      if (applied.includes('outline')) return 'outline'
      if (applied.includes('characters')) return 'characters'
      return ''
    },
    drama_export: () => 'exported',
  }
  /** AC-F3：强制模式下写该步内容要求上一步已确认（宽松模式放行）。 */
  const FLOW_TOOL_STRICT_STEPS = {
    drama_save_contract: 'outline',
    drama_save_outline: 'outline',
    drama_save_characters: 'characters',
    drama_import_script: 'episode_script',
    drama_export: 'exported',
  }
  const flowTitleFor = async (root, args) => {
    const want = args && typeof args.title === 'string' ? args.title.trim() : ''
    if (want) return want
    const projects = await store.listProjects(root).catch(() => [])
    return projects.length === 1 ? projects[0].title : ''
  }
  /** 工具执行包装：强制门禁 + 写后 flow-state 同步（失败不影响工具业务结果）。 */
  const withFlowState = (toolName, execute) => {
    const stepFn = FLOW_TOOL_STEPS[toolName]
    const strictStep = FLOW_TOOL_STRICT_STEPS[toolName]
    const isCreate = toolName === 'drama_create_project'
    if (!stepFn && !strictStep && !isCreate) return execute
    return async (args, exec) => {
      let root = null
      let title = ''
      try {
        root = rootOf(exec)
        title = await flowTitleFor(root, args)
      } catch {
        root = null
      }
      if (root && title && strictStep) {
        try {
          await flowState.assertStepAllowed(root, title, strictStep)
        } catch (error) {
          if (error && error.code === 'conflict') {
            return { ok: false, code: 'conflict', reason: error.message, next: typeof error.next === 'string' ? error.next : '' }
          }
          throw error
        }
      }
      const result = await execute(args, exec)
      try {
        if (root && isCreate && result && result.ok !== false && result.project && result.project.title) {
          await flowState.initFlowState(root, result.project.title)
        } else if (root && title && stepFn && result && result.ok !== false) {
          const step = stepFn(args || {}, result)
          if (step) {
            const actor = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : 'agent'
            await flowState.syncAfterContentWrite(root, title, { step, actor })
          }
        }
      } catch {
        /* flow-state 同步失败不影响工具业务结果 */
      }
      return result
    }
  }

  // P1-4：把集中维护的输出契约挂到每个工具定义上。
  // index.js 的 outputFor() 仍然保留兜底，即使某个工具漏挂 output，注册也不会抛错。
  // P1-A：execute 统一套失败契约（成功返回结构零改动，仅异常/ok:false 归一为 {code,reason,next}）。
  // P2-2：内容写工具再套一层 flow-state（强制门禁 + 写后同步）。
  return defs.map((def) => ({
    ...def,
    output: def.output || TOOL_OUTPUTS[def.name] || genericOutput(),
    execute: withFlowState(def.name, withToolContract(def.name, def.execute)),
  }))
}

export const DRAMA_TOOL_NAMES = [
  'drama_list_projects',
  'drama_create_project',
  'drama_get_project',
  'drama_save_contract',
  'drama_save_outline',
  'drama_save_characters',
  'drama_read_episode',
  'drama_search_context',
  'drama_get_progress',
  'drama_save_memory',
  'drama_save_world',
  'drama_get_dialogue',
  'drama_export_voice_script',
  'drama_list_assets',
  'drama_add_asset',
  'drama_finalize_episode',
  'drama_list_finalized',
  'drama_get_ledger',
  'drama_import_script',
  'drama_plan_batch',
  'drama_submit_batch',
  'drama_collect_batch',
  'drama_canvas_status',
  'drama_bind_canvas',
  'drama_reconcile_canvas',
  'drama_plan_generation',
  'drama_record_generation',
  'drama_intake_artifact',
  'drama_budget',
  'drama_save_draft',
  'drama_list_drafts',
  'drama_resolve_draft',
  'drama_check_consistency',
  'drama_export',
]

/**
 * T3（P1-L）测试用途工具：仅当 `DSH_AI_DRAMA_TEST_TOOLS=1` 时由 index.js 传入 testTools:true 注册；
 * **不进入 DRAMA_TOOL_NAMES 生产名单**（生产工具面保持 34 个），也不进预设工具白名单。
 */
export const DRAMA_TEST_TOOL_NAMES = ['drama_test_echo', 'drama_test_failure']

function createTestToolDefs() {
  return [
    {
      name: 'drama_test_echo',
      description: '【测试工具】回显传入参数，用于验证工具挂载与结果渲染；仅在 DSH_AI_DRAMA_TEST_TOOLS=1 时注册。',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '回显文本' },
          payload: { type: 'object', additionalProperties: true, description: '任意结构，原样回显' },
        },
        additionalProperties: false,
      },
      execute: async (args) => ({ ok: true, echo: args || {}, testTools: true }),
    },
    {
      name: 'drama_test_failure',
      description: '【测试工具】按指定失败码返回失败结果，用于验证统一失败契约；仅在 DSH_AI_DRAMA_TEST_TOOLS=1 时注册。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '失败码，默认 invalid-args（取值见 TOOL_FAILURE_CODES）' },
          reason: { type: 'string', description: '失败原因文本' },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        throw new ToolFailure(args && args.code ? String(args.code) : 'invalid-args', (args && args.reason) || '测试失败（契约断言用）')
      },
    },
  ]
}

/* ======================================================================
 * P1-4：工具输出契约（output.schema + output.render）
 *
 * 实现方式说明：
 *   - 采用「集中映射表」：TOOL_OUTPUTS 按工具名维护 schema 与 render，
 *     由 createToolDefs() 统一挂到工具定义上；不逐个改动 34 个工具对象，
 *     少动既有 execute 逻辑，降低回归风险。
 *   - index.js 的 outputFor() 继续作为兜底（漏挂时注册仍不会抛错）。
 *   - render(args, value) 只返回 ContentBlock[]（text 块），统一输出人读中文摘要，
 *     不再把整坨 JSON 原样倒给用户/模型。
 *   - schema 描述工具的真实返回结构；render 对缺字段、异常形态一律降级，
 *     保证「不抛错、不空块」。
 * ====================================================================== */

const OUTPUT_LABELS = {
  ok: '结果', path: '路径', file: '文件', title: '项目', name: '名称', project: '项目',
  projects: '项目', episode: '集数', episodeNo: '集数', order: '集数', count: '数量', total: '总数',
  items: '条目', entries: '条目', error: '错误', code: '代码', reason: '原因', message: '说明',
  hint: '提示', warning: '提示', warnings: '提示', status: '状态', stage: '阶段', budget: '预算',
  backend: '后端', model: '模型', taskId: '任务', tasks: '任务列表', createdAt: '创建时间',
  updatedAt: '更新时间', kind: '类型', shots: '镜头', scenes: '场景', durationSec: '时长(秒)',
  characters: '角色', locations: '地点', text: '正文', rows: '行', format: '格式', bytes: '字节',
  relative: '相对路径', draftId: '草稿', prompt: '提示词', points: '积分', remaining: '剩余',
  contract: '剧集契约', outline: '总纲', drafts: '草稿', assets: '素材', finalized: '定稿',
  summary: '汇总', issues: '问题', steps: '步骤', facts: '统计', hits: '命中', scanned: '扫描',
  degraded: '降级', method: '检索方式', applied: '落地类型', allowed: '是否放行', detail: '明细',
  planned: '计划', submitted: '已提交', failed: '失败', collected: '已取回', pending: '待定',
  binding: '画布绑定', snapshot: '画布快照', canvases: '候选画布', upstreamWarning: '上游提示',
  limitPoints: '预算上限', spentPoints: '已消耗', remainingPoints: '剩余积分', totals: '合计',
  perEpisode: '分集统计', charactersCount: '角色数', locationsCount: '地点数', byCharacter: '按角色',
  lineCount: '台词数', sfx: '音效', truncated: '已截断', linkedShots: '关联镜头', sha256: '校验',
  source: '来源', version: '版本', finalizedAt: '定稿时间', files: '快照文件', written: '已写出',
  skipped: '已跳过', stats: '统计', episodes: '分集', plan: '计划', quota: '预算闸门', results: '逐项结果',
  missingOnCanvas: '画布缺失', extraOnCanvas: '画布多余', consistent: '是否一致', sourceOfTruth: '事实源',
  storyboardShots: '分镜镜头数', canvasShots: '画布镜头数', totalNodes: '画布节点数', fix: '修复',
  severity: '级别', where: '位置', checkedAt: '检查时间', perUnit: '单镜预估', estimatePoints: '预估积分',
  artifact: '产物', assetId: '素材 id', node: '节点',
}

/** 单值 → 一行可读文本（对象/数组递归压平，超长截断）。 */
function readable(value, limit = 160) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'string') {
    const oneLine = value.replace(/\s+/g, ' ').trim()
    if (!oneLine) return '—'
    return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (!value.length) return '—'
    return readable(value.map((item) => readable(item, 40)).join('、'), limit)
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    if (!keys.length) return '—'
    return readable(keys.map((key) => `${labelOf(key)} ${readable(value[key], 40)}`).join('；'), limit)
  }
  return String(value)
}

const labelOf = (key) => OUTPUT_LABELS[key] || key
const textBlock = (text) => [{ type: 'text', text: String(text == null ? '' : text) }]
const lineOf = (labelText, value) => `${labelText}：${readable(value)}`
const bulletOf = (value) => `· ${readable(value, 220)}`

/** 列表 → 多行「·」条目；空列表给一句明确说明，而不是空块。 */
function linesOf(list, mapper, emptyText = '（空）', limit = 12) {
  const items = Array.isArray(list) ? list : []
  if (!items.length) return [emptyText]
  const lines = items.slice(0, limit).map((item, index) => bulletOf(mapper(item, index)))
  if (items.length > limit) lines.push(`…共 ${items.length} 项`)
  return lines
}

/** 统一出口：段落/行（可嵌套数组）→ 单个 text 块。 */
function renderText(sections) {
  const flat = []
  const push = (value) => {
    if (value === null || value === undefined || value === '') return
    if (Array.isArray(value)) {
      for (const item of value) push(item)
      return
    }
    flat.push(String(value))
  }
  push(sections)
  return textBlock(flat.join('\n'))
}

/** ok=false 的统一失败摘要（带失败码与下一步建议）。 */
function failureText(value) {
  const reason = value && (value.reason || value.detail || value.error || value.message)
  const code = value && value.code ? `[${value.code}] ` : ''
  const next = value && value.next ? `\n下一步：${readable(value.next, 300)}` : ''
  return reason ? `失败：${code}${readable(reason, 400)}${next}` : '失败：操作未完成（未返回原因）'
}

/** 通用兜底渲染：任意返回值 → 中文键值摘要；不抛错、不空块。 */
function fallbackText(value) {
  if (value === undefined) return '（无返回值）'
  if (value === null) return '（空）'
  if (typeof value !== 'object') return readable(value, 1000)
  if (Array.isArray(value)) {
    return value.length ? linesOf(value, (item) => readable(item, 200)).join('\n') : '（空列表）'
  }
  const lines = []
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue
    lines.push(lineOf(labelOf(key), raw))
  }
  return lines.length ? lines.join('\n') : '（无返回值）'
}

/** 统一包装：任何 render 都不抛错，且必然返回非空 text 块数组。 */
function safeRender(fn) {
  return (_args, value) => {
    try {
      const blocks = fn(value)
      const list = Array.isArray(blocks)
        ? blocks.filter((block) => block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
        : []
      return list.length ? list : textBlock(fallbackText(value))
    } catch {
      return textBlock(fallbackText(value))
    }
  }
}

/* --------------------------------------------------------- schema 小工具 */

const schemaStr = { type: 'string' }
const schemaNum = { type: 'number' }
const schemaBool = { type: 'boolean' }
const schemaArr = (items = {}) => ({ type: 'array', items })
const schemaObj = (properties = {}, required) => ({ type: 'object', properties, ...(required ? { required } : {}) })
const openObject = () => ({ type: 'object', additionalProperties: true })

/** 生成一个 output 定义：schema 自动带 ok + 失败码字段，render 走安全包装。 */
const out = (properties = {}, render, required = ['ok']) => ({
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: '是否成功' },
      code: { type: 'string', description: '失败类别（成功时不返回；取值见 TOOL_FAILURE_CODES）' },
      reason: { type: 'string', description: '失败原因（成功时不返回）' },
      next: { type: 'string', description: '失败后的下一步建议（成功时不返回）' },
      ...properties,
    },
    required,
  },
  render: safeRender(render),
})

/** 兜底 output：理论上不会用到（TOOL_OUTPUTS 覆盖全部 34 个工具）。 */
function genericOutput() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: safeRender((value) => textBlock(fallbackText(value))),
  }
}

/* ------------------------------------------------------- 常用结构片段 */

const projectItem = schemaObj(
  { title: schemaStr, path: schemaStr, updatedAt: schemaNum, episodeCount: schemaNum },
  ['title'],
)
const contractSchema = openObject()
const outlineRow = schemaObj(
  {
    order: schemaNum,
    title: schemaStr,
    logline: schemaStr,
    hook: schemaStr,
    twist: schemaStr,
    cliffhanger: schemaStr,
    estDurationSec: schemaNum,
  },
  ['order'],
)
const draftItem = schemaObj(
  {
    id: schemaStr,
    kind: schemaStr,
    title: schemaStr,
    order: schemaNum,
    status: schemaStr,
    note: schemaStr,
    createdAt: schemaStr,
  },
  ['id'],
)
const assetItem = schemaObj(
  {
    id: schemaStr,
    name: schemaStr,
    kind: schemaStr,
    source: schemaStr,
    bytes: schemaNum,
    // D-10（0.4.2）：原为 schemaObj(空 properties, ['sha256']) → 生成 required:['sha256'] 但 properties:{}
    // 的非法 JSON Schema，被 DSH `assertSupportedJsonSchema` 拒绝 → drama_list_assets /
    // drama_add_asset 静默注册失败（32/34）。sha256 实际是十六进制字符串（未计算时为空串，
    // 见下面的 assetForOutput：历史数据里的 null 在输出边界归一为空串，保持 output.schema 契约）。
    sha256: schemaStr,
    linkedShots: schemaArr(schemaStr),
    note: schemaStr,
  },
  ['id'],
)
/**
 * 把素材对象投影成 output.schema 契约形状：sha256 必须是字符串。
 * store 中 sha256 可能为 null（文件 > HASH_LIMIT 或读取失败时未计算，见 store.addAsset），
 * 而 DSH 会对每个成功工具结果按 output.schema 校验（不通过抛 ToolOutputError），
 * 因此在工具输出边界把 null 归一为 ''（渲染层仍显示「未计算」）。
 * @param {object} asset store 中的素材对象
 * @returns {object} 满足 assetItem schema 的素材对象
 */
const assetForOutput = (asset) => (asset && typeof asset === 'object' ? { ...asset, sha256: typeof asset.sha256 === 'string' ? asset.sha256 : '' } : asset)
const taskItem = openObject()

/* ------------------------------------------------------------- 小渲染器 */

/** 契约摘要：平台 / 受众 / 单集时长 / 目标集数 / 画幅 / 钩子密度 / 红线。 */
function contractLines(contract) {
  const c = contract || {}
  const duration = Array.isArray(c.episodeDurationSec) ? c.episodeDurationSec.filter((v) => v != null).join(' ~ ') : '—'
  return [
    lineOf('平台', c.platform || '—'),
    lineOf('受众', c.audience || '—'),
    `单集时长：${duration ? `${duration} 秒` : '—'}`,
    lineOf('目标集数', c.targetEpisodes || '—'),
    `画幅：${c.orientation === 'landscape' ? '横屏' : c.orientation === 'portrait' ? '竖屏' : '—'}`,
    lineOf('钩子密度', c.hookDensity || '—'),
    lineOf('审核红线', c.redlines || '—'),
  ]
}

/** 预算摘要：上限 / 已消耗 / 剩余。 */
function budgetLineOf(budget) {
  const b = budget || {}
  const limit = b.limitPoints == null ? '未设上限' : `${b.limitPoints} 积分`
  const spent = Number(b.spentPoints) || 0
  const remaining = b.remainingPoints == null ? '—' : `${b.remainingPoints} 积分`
  return `预算：上限 ${limit} / 已消耗 ${spent} 积分 / 剩余 ${remaining}`
}

/** 画布绑定摘要。 */
function bindingLines(binding) {
  const b = binding || {}
  if (b.ok) return [`画布绑定：已绑定（${b.backend || '后端'} · ${b.uuid || '未记录 uuid'}）`]
  const lines = [`画布绑定：未绑定或不可用 —— ${readable(b.detail || b.reason || '未知原因', 300)}`]
  if (b.fix) lines.push(`修复：${readable(b.fix, 200)}`)
  return lines
}

const KIND_TEXT = { image: '分镜图', video: '分镜视频', audio: '配音' }

/* --------------------------------------------------------------- 契约表 */

export const TOOL_OUTPUTS = {
  drama_list_projects: out(
    {
      count: schemaNum,
      projects: schemaArr(projectItem),
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const projects = (value && value.projects) || []
      return renderText([
        `短剧项目：共 ${projects.length} 个`,
        ...linesOf(
          projects,
          (project) => `《${project.title || '未命名'}》 —— 分集剧本 ${project.episodeCount || 0} 集（${project.path || '—'}）`,
          '当前工作区还没有短剧项目，可用 drama_create_project 新建。',
        ),
      ])
    },
  ),

  drama_create_project: out(
    {
      project: projectItem,
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const project = (value && value.project) || value || {}
      return renderText([
        `已新建短剧《${project.title || '未命名'}》`,
        lineOf('数据目录', project.path),
        '已生成 14 个一级节点（契约 / 总纲 / 人物 / 剧本 / 分镜 / 记忆 / 素材 / 草稿区 / 定稿 / 账本 / 导出 等）',
        '下一步：drama_save_contract 写剧集契约 → drama_save_outline 写分集大纲。',
      ])
    },
  ),

  drama_get_project: out(
    {
      title: schemaStr,
      contract: contractSchema,
      outline: schemaArr(outlineRow),
      characters: schemaArr(openObject()),
      episodes: schemaArr(schemaNum),
      pendingDrafts: schemaNum,
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const title = (value && value.title) || '当前短剧'
      const outline = (value && value.outline) || []
      const characters = (value && value.characters) || []
      const episodes = (value && value.episodes) || []
      return renderText([
        `《${title}》`,
        ...contractLines(value && value.contract),
        `总纲：${outline.length} 集`,
        `人物：${characters.length} 人${characters.length ? `（${characters.slice(0, 8).map((card) => card && card.name).filter(Boolean).join('、')}）` : ''}`,
        `分集剧本：${episodes.length} 集${episodes.length ? `（第 ${episodes.slice(0, 10).join('、')} 集）` : ''}`,
        `待处理草稿：${Number(value && value.pendingDrafts) || 0} 条`,
      ])
    },
  ),

  drama_save_contract: out(
    {
      contract: contractSchema,
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const contract = (value && value.contract) || {}
      return renderText([
        `已保存剧集契约：${contract.title || (value && value.title) || '当前短剧'}`,
        ...contractLines(contract),
        '该契约是后续大纲/剧本/分镜生成的强约束输入。',
      ])
    },
  ),

  drama_save_outline: out(
    {
      count: schemaNum,
      rows: schemaArr(outlineRow),
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const rows = (value && value.rows) || []
      const count = Number(value && value.count) || rows.length
      const lines = [`已保存分集大纲：共 ${count} 集`]
      if (rows.length) {
        lines.push(...rows.slice(0, 10).map((row) => `· 第 ${row.order} 集${row.title ? `《${row.title}》` : ''} —— ${readable(row.logline || row.hook || '—', 80)}`))
        if (rows.length > 10) lines.push(`…共 ${rows.length} 集`)
      }
      return renderText(lines)
    },
  ),

  drama_save_characters: out({ count: schemaNum }, (value) => {
    if (value && value.ok === false) return renderText(failureText(value))
    return renderText([
      `已保存人物设定：共 ${Number(value && value.count) || 0} 人`,
      '主角记得补形象提示词（appearancePrompt），否则后续生图一致性会受影响；可用 drama_check_consistency 自查。',
    ])
  }),

  drama_read_episode: out(
    {
      title: schemaStr,
      order: schemaNum,
      text: schemaStr,
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const title = (value && value.title) || '当前短剧'
      const order = Number(value && value.order) || 0
      const text = String((value && value.text) || '')
      if (!text.trim()) {
        return renderText([`《${title}》第 ${order || '?'} 集还没有正文`, '可先用 drama_save_draft 生成草稿，或 drama_import_script 导入已有剧本。'])
      }
      const body = text.length > 4000 ? `${text.slice(0, 4000)}\n…（正文共 ${text.length} 字符，已截断）` : text
      return renderText([`《${title}》第 ${order || '?'} 集 —— 正文 ${text.split(/\r?\n/).length} 行 / ${text.length} 字符`, '', body])
    },
  ),

  drama_save_draft: out(
    {
      draftId: schemaStr,
      status: schemaStr,
      hint: schemaStr,
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      return renderText([
        `草稿已写入草稿区：${value.draftId || '—'}（状态：${value.status || 'pending'}）`,
        value.hint || '请在「AI 短剧」面板的草稿区采纳；采纳前不会改动正式稿。',
      ])
    },
  ),

  drama_list_drafts: out({ drafts: schemaArr(draftItem) }, (value) => {
    if (value && value.ok === false) return renderText(failureText(value))
    const drafts = (value && value.drafts) || []
    return renderText([
      `待处理草稿：${drafts.length} 条`,
      ...linesOf(
        drafts,
        (draft) =>
          `[${draft.kind || draft.type || '未知类型'}${draft.order ? ` 第 ${draft.order} 集` : ''}] ${draft.title || draft.note || draft.id || '未命名'}（${draft.status || 'pending'}）`,
        '草稿区为空，没有待采纳的生成结果。',
      ),
    ])
  }),

  drama_resolve_draft: out(
    {
      status: schemaStr,
      applied: schemaStr,
      result: openObject(),
      draftStatus: schemaStr,
      results: schemaArr(
        schemaObj({
          id: schemaStr,
          action: schemaStr,
          ok: schemaBool,
          status: schemaStr,
          applied: schemaStr,
          error: schemaObj({ code: schemaStr, reason: schemaStr, next: schemaStr }),
        }),
      ),
      counts: openObject(),
      approval: openObject(),
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const results = Array.isArray(value.results) ? value.results : []
      const counts = value.counts || {}
      const isBatch = results.length > 1 || (value.status == null && results.length === 1)
      if (isBatch) {
        const total = (counts.accepted || 0) + (counts.discarded || 0) + (counts.restored || 0) + (counts.failed || 0)
        const lines = [
          `草稿批量处理：成功 ${total - (counts.failed || 0)} / 失败 ${counts.failed || 0}（采纳 ${counts.accepted || 0} · 丢弃 ${counts.discarded || 0} · 恢复 ${counts.restored || 0}）`,
        ]
        for (const item of results.slice(0, 20)) {
          lines.push(item.ok ? `· ${item.id || '—'}：${item.status || '已处理'}${item.applied ? `（${item.applied}）` : ''}` : `· ${item.id || '—'}：失败 —— ${readable((item.error && item.error.reason) || '未知原因', 200)}`)
        }
        if (results.length > 20) lines.push(`…共 ${results.length} 条`)
        return renderText(lines)
      }
      const status = value.status || '—'
      if (status === 'accepted') {
        const applied = { contract: '剧集契约', outline: '分集大纲', characters: '人物设定卡', episode: '分集剧本', storyboard: '分镜表', file: '项目文件' }[value.applied] || value.applied || '正式稿'
        return renderText([`草稿已采纳，内容已写入：${applied}`, '已留痕，可在面板历史中追溯。'])
      }
      if (status === 'discarded') return renderText(['草稿已丢弃（只改状态，可在面板草稿区恢复）'])
      if (status === 'restored') return renderText(['草稿已恢复：重新回到草稿区（状态 pending），可再次采纳或丢弃。'])
      return renderText([`草稿状态已更新：${status}`])
    },
  ),

  drama_search_context: out(
    {
      title: schemaStr,
      query: schemaStr,
      hits: schemaArr(
        schemaObj({ path: schemaStr, score: schemaNum, matched: schemaArr(schemaStr), excerpt: schemaStr }, ['path']),
      ),
      scanned: schemaNum,
      degraded: schemaBool,
      degradeReason: schemaStr,
      method: schemaStr,
      enabled: schemaBool,
      topK: schemaNum,
      reason: schemaStr,
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const hits = (value && value.hits) || []
      const method = (value && value.method) || 'local-lexical'
      const lines = []
      if (value.enabled === false) {
        lines.push('检索已在设置中关闭（settings.retrievalEnabled=false），未执行检索；写入正文前请手动核对设定。')
      } else {
        lines.push(`检索「${value.query || '—'}」：命中 ${hits.length} 条（扫描 ${Number(value.scanned) || 0} 篇文档，方式：${method}${value.degraded ? '，已降级' : ''}）`)
        if (value.degraded && value.degradeReason) lines.push(`降级原因：${readable(value.degradeReason, 300)}`)
      }
      if (!hits.length && value.enabled !== false) lines.push('没有命中相关设定；可换更具体的人物名/地点/桥段关键词再试。')
      for (const hit of hits.slice(0, 8)) {
        lines.push(`· ${hit.path || '—'}（相关度 ${hit.score ?? '—'}）`)
        lines.push(`  ${readable(hit.excerpt || '—', 200)}`)
      }
      if (hits.length > 8) lines.push(`…共 ${hits.length} 条命中`)
      return renderText(lines)
    },
  ),

  drama_get_progress: out(
    {
      title: schemaStr,
      stage: schemaStr,
      steps: schemaArr(schemaObj({ key: schemaStr, label: schemaStr, done: schemaBool }, ['key'])),
      facts: openObject(),
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const steps = (value && value.steps) || []
      const facts = (value && value.facts) || {}
      const current = steps.find((step) => step.key === (value && value.stage))
      return renderText([
        `《${(value && value.title) || '当前短剧'}》当前阶段：${current ? current.label : (value && value.stage) || '未知'}`,
        `步骤：${steps.map((step) => `${step.done ? '✓' : '·'} ${step.label || step.key}`).join('  ') || '—'}`,
        `统计：大纲 ${facts.outlineCount ?? 0} 集 / 人物 ${facts.characterCount ?? 0} 人 / 剧本 ${facts.episodeCount ?? 0} 集 / 分镜 ${facts.storyboardCount ?? 0} 集`,
        `本剧记忆 ${facts.memoryCount ?? 0} 条（未回收 ${facts.openMemoryCount ?? 0}） · 已导出 ${facts.exportCount ?? 0} 次 · 目标集数 ${facts.targetEpisodes ?? 0}`,
      ])
    },
  ),

  drama_save_memory: out({ count: schemaNum }, (value) => {
    if (value && value.ok === false) return renderText(failureText(value))
    return renderText([
      `已保存本剧记忆：共 ${Number(value && value.count) || 0} 条`,
      '覆盖伏笔 / 已用桥段 / 时间线 / 待回收四类；生成新内容前先读，可避免重复桥段与设定冲突。',
    ])
  }),

  drama_save_world: out({ count: schemaNum }, (value) => {
    if (value && value.ok === false) return renderText(failureText(value))
    return renderText([`已保存世界观设定：共 ${Number(value && value.count) || 0} 条（地点 / 组织 / 规则 / 道具 / 时间线）`])
  }),

  drama_get_dialogue: out(
    {
      title: schemaStr,
      byCharacter: schemaArr(schemaObj({ character: schemaStr, count: schemaNum, episodes: schemaArr(schemaNum) }, ['character'])),
      lineCount: schemaNum,
      lines: schemaArr(schemaObj({ episode: schemaNum, scene: schemaStr, character: schemaStr, text: schemaStr })),
      sfx: schemaArr(openObject()),
      truncated: schemaBool,
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const byCharacter = (value && value.byCharacter) || []
      const sfx = (value && value.sfx) || []
      return renderText([
        `《${(value && value.title) || '当前短剧'}》台词汇总：${Number(value && value.lineCount) || 0} 句 / 角色 ${byCharacter.length} 人${value && value.truncated ? '（结果已截断）' : ''}`,
        ...linesOf(
          byCharacter,
          (row) => `${row.character || '未具名'}：${row.count ?? 0} 句（第 ${Array.isArray(row.episodes) ? row.episodes.join('、') : '—'} 集）`,
          '还没有抽取到台词——剧本里请用「角色：台词」的格式书写。',
          15,
        ),
        `分镜音效：${sfx.length} 条`,
      ])
    },
  ),

  drama_export_voice_script: out(
    {
      written: schemaArr(schemaObj({ episode: schemaNum, file: schemaStr, lines: schemaNum })),
      total: schemaNum,
      note: schemaStr,
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const written = (value && value.written) || []
      return renderText([
        `配音稿已生成：共 ${Number(value && value.total) || 0} 句 / ${written.length} 集`,
        ...linesOf(written, (file) => `第 ${file.episode ?? '?'} 集：${file.lines ?? 0} 句 → ${file.file || '—'}`, '没有可导出的台词。'),
        value.note || '产物在项目「台词与音效/」目录下。',
      ])
    },
  ),

  drama_list_assets: out(
    {
      count: schemaNum,
      assets: schemaArr(assetItem),
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const assets = (value && value.assets) || []
      return renderText([
        `素材：共 ${assets.length} 个`,
        ...linesOf(
          assets,
          (asset) =>
            `${asset.name || '未命名'}（${asset.kind || 'other'}，${((Number(asset.bytes) || 0) / 1024).toFixed(1)} KB）${Array.isArray(asset.linkedShots) && asset.linkedShots.length ? ` 关联镜头：${asset.linkedShots.join('、')}` : ''}`,
          '素材库为空；生成产物可用 drama_intake_artifact 收进项目。',
        ),
      ])
    },
  ),

  drama_add_asset: out({ asset: assetItem }, (value) => {
    if (value && value.ok === false) return renderText(failureText(value))
    const asset = (value && value.asset) || value || {}
    return renderText([
      `已登记素材：${asset.name || '未命名'}（${asset.kind || 'other'}，${((Number(asset.bytes) || 0) / 1024).toFixed(1)} KB）`,
      lineOf('来源路径', asset.source),
      lineOf('sha256', asset.sha256 ? `${asset.sha256.slice(0, 16)}…` : '（未计算）'),
      Array.isArray(asset.linkedShots) && asset.linkedShots.length ? `关联镜头：${asset.linkedShots.join('、')}` : '未关联镜头。',
      '只登记路径与校验信息，未复制原始文件（FR-B08）。',
    ])
  }),

  drama_finalize_episode: out(
    {
      order: schemaNum,
      version: schemaNum,
      finalizedAt: schemaStr,
      shots: schemaNum,
      files: schemaArr(schemaStr),
      restored: schemaArr(schemaStr),
      checks: openObject(),
      approval: openObject(),
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const files = (value && value.files) || []
      if (Array.isArray(value && value.restored)) {
        return renderText([
          `第 ${value.order ?? '?'} 集已回滚到定稿 v${value.version ?? '?'}（${value.restored.join('、') || '内容'}）`,
          value.approval ? `用户已批准（审批指纹 ${String(value.approval.fingerprint || '').slice(0, 16)}…）` : '',
          '回滚前内容可在「定稿」历史中找回；如需恢复到回滚前状态，可再次定稿新版本。',
        ])
      }
      return renderText([
        `第 ${value.order ?? '?'} 集已定稿 v${value.version ?? '?'}（镜头 ${value.shots ?? 0} 个）`,
        lineOf('定稿时间', value.finalizedAt),
        ...linesOf(files, (file) => file, '（本次没有生成快照文件）'),
        value.checks && value.checks.summary ? `确定性检查：通过（${value.checks.summary.passed}/${value.checks.summary.total} 项）` : '',
        '需要回滚时可在面板「定稿」页选择历史版本。',
      ])
    },
  ),

  drama_list_finalized: out(
    {
      count: schemaNum,
      finalized: schemaArr(
        schemaObj({ order: schemaNum, version: schemaNum, finalizedAt: schemaStr, lines: schemaNum, shots: schemaNum, files: schemaArr(schemaStr) }),
      ),
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const finalized = (value && value.finalized) || []
      return renderText([
        `已定稿：共 ${finalized.length} 集`,
        ...linesOf(
          finalized,
          (item) => `第 ${item.order ?? '?'} 集 v${item.version ?? '?'} —— ${item.finalizedAt || '—'}（${item.shots ?? 0} 镜 / ${item.lines ?? 0} 行）`,
          '还没有定稿记录；可用 drama_finalize_episode 冻结某一集。',
        ),
      ])
    },
  ),

  drama_get_ledger: out(
    {
      totals: openObject(),
      warnings: schemaArr(schemaStr),
      perEpisode: schemaArr(openObject()),
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const totals = (value && value.totals) || {}
      const warnings = (value && value.warnings) || []
      const perEpisode = (value && value.perEpisode) || []
      return renderText([
        '项目账本（由剧本与分镜推导）',
        `合计：${totals.episodes ?? 0} 集 / ${totals.scenes ?? 0} 场 / ${totals.shots ?? 0} 镜 / ${totals.durationSec ?? 0} 秒（约 ${((Number(totals.durationSec) || 0) / 60).toFixed(1)} 分钟）`,
        `角色 ${(totals.characters || []).length} 人 · 地点 ${(totals.locations || []).length} 处`,
        ...linesOf(
          perEpisode,
          (row) =>
            `第 ${row.order ?? '?'} 集：场景 ${row.scenes ?? 0}（内 ${row.interiorScenes ?? 0} / 外 ${row.exteriorScenes ?? 0}） · 镜头 ${row.shots ?? 0} · ${row.durationSec ?? 0} 秒`,
          '还没有可分集的剧本。',
          10,
        ),
        warnings.length ? `成本提示：\n${warnings.map((warning) => `· ${readable(warning, 200)}`).join('\n')}` : '成本提示：未发现明显风险。',
      ])
    },
  ),

  drama_import_script: out(
    {
      action: schemaStr,
      stats: openObject(),
      episodes: schemaArr(openObject()),
      written: schemaArr(openObject()),
      skipped: schemaArr(schemaNum),
      approval: openObject(),
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      if (value && value.action === 'preview') {
        const stats = value.stats || {}
        const episodes = value.episodes || []
        return renderText([
          `导入预览：${stats.episodes ?? episodes.length} 集 / ${stats.scenes ?? 0} 场 / 人物 ${stats.characters ?? 0} 人 / ${stats.lines ?? 0} 行`,
          ...linesOf(episodes, (episode) => `第 ${episode.order ?? '?'} 集${episode.title ? `《${episode.title}》` : ''}：${episode.scenes ?? 0} 场 / ${episode.lines ?? 0} 行 / 角色 ${(episode.characters || []).length} 人`, '未识别出任何剧集。', 10),
          '预览不写盘；确认后用 action=apply 落盘。',
        ])
      }
      const written = (value && value.written) || []
      const skipped = (value && value.skipped) || []
      return renderText([
        `已导入：写出 ${written.length} 集${skipped.length ? `，跳过 ${skipped.length} 集（已存在，第 ${skipped.join('、')} 集）` : ''}`,
        ...linesOf(written, (episode) => `第 ${episode.order ?? '?'} 集：${episode.scenes ?? 0} 场 / ${episode.lines ?? 0} 行`, '（没有写出任何分集）'),
      ])
    },
  ),

  drama_plan_generation: out(
    {
      allowed: schemaBool,
      task: taskItem,
      budget: openObject(),
      reason: schemaStr,
      detail: schemaStr,
      remainingAfter: schemaNum,
    },
    (value) => {
      if (value && value.ok === false) {
        return renderText([
          `预算闸门拦截：${readable(value.detail || value.reason || '超出预算上限', 400)}`,
          budgetLineOf(value.budget),
          '不要直接提交；先与用户确认或调整预算上限（drama_budget action=set）。',
        ])
      }
      const task = (value && value.task) || {}
      return renderText([
        `已登记生成任务：${task.id || '—'}（${KIND_TEXT[task.kind] || task.kind || '生成'} · ${task.backend || '—'}${task.model ? ` · ${task.model}` : ''}）`,
        `集数：${task.episode ?? '—'} · 镜号：${(task.shots || []).join('、') || '—'} · 预估积分：${task.estimatePoints ?? '—'}`,
        budgetLineOf(value.budget),
        value.remainingAfter != null ? `本次之后剩余：${value.remainingAfter} 积分` : '',
        '状态 planned（仅登记，未触发）；确认后再执行实际生成。',
      ])
    },
  ),

  drama_record_generation: out(
    {
      task: taskItem,
      budget: openObject(),
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const task = (value && value.task) || {}
      return renderText([
        `任务已更新：${task.id || '—'} → ${task.status || '—'}`,
        task.actualPoints != null ? `实际消耗：${task.actualPoints} 积分（同一任务只记账一次）` : '',
        task.error ? `失败原因：${readable(task.error, 300)}` : '',
        budgetLineOf(value.budget),
      ])
    },
  ),

  drama_intake_artifact: out(
    {
      file: schemaStr,
      bytes: schemaNum,
      sha256: schemaStr,
      assetId: schemaStr,
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      return renderText([
        `产物已收进项目：${value.file || '—'}（${((Number(value.bytes) || 0) / 1024).toFixed(1)} KB）`,
        lineOf('sha256', value.sha256 ? `${value.sha256.slice(0, 24)}…` : '—'),
        lineOf('素材 id', value.assetId),
        '断网后仍可用；已登记来源与关联镜头。',
      ])
    },
  ),

  drama_budget: out({ budget: openObject() }, (value) => {
    if (value && value.ok === false) return renderText(failureText(value))
    const budget = (value && value.budget) || {}
    const entries = Array.isArray(budget.entries) ? budget.entries : []
    return renderText([
      budgetLineOf(budget),
      ...linesOf(
        entries.slice(-10).reverse(),
        (entry) => `${entry.at || '—'} · ${entry.backend || '—'} ${KIND_TEXT[entry.kind] || entry.kind || ''} · ${entry.points ?? 0} 积分${entry.estimated ? '（预估）' : ''} · ${entry.taskId || ''}`,
        '还没有消耗记录。',
        10,
      ),
    ])
  }),

  drama_plan_batch: out({ plan: openObject() }, (value) => {
    if (value && value.ok === false) return renderText(failureText(value))
    const plan = (value && value.plan) || {}
    const items = plan.items || []
    const tasks = plan.tasks || []
    const quota = plan.quota || {}
    const lines = [
      `第 ${plan.episode ?? '?'} 集 ${plan.label || KIND_TEXT[plan.kind] || plan.kind || '生成'} 批次规划：${plan.count ?? items.length} 项（后端 ${plan.backend || '—'}${plan.model ? ` · ${plan.model}` : ''}）`,
      `预估积分：${plan.estimatePoints ?? 0}；预算闸门：${quota.ok ? (quota.limited ? '通过（已设上限）' : '通过（未设上限）') : `拦截 —— ${readable(quota.detail || '超预算', 200)}`}`,
      ...linesOf(items, (item) => `${item.name || item.shotNumber || '—'}：${readable(item.prompt || '—', 120)}`, '（没有可规划的镜头）', 8),
      `已登记任务：${tasks.length} 条`,
      plan.upstreamWarning ? `上游提示：${readable(plan.upstreamWarning, 300)}` : '',
      '本步只规划不触发；确认后用 drama_submit_batch 提交。',
    ]
    return renderText(lines)
  }),

  drama_submit_batch: out(
    {
      submitted: schemaNum,
      failed: schemaNum,
      results: schemaArr(openObject()),
      approval: openObject(),
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const results = (value && value.results) || []
      return renderText([
        `批次提交：成功 ${value.submitted ?? 0} / 失败 ${value.failed ?? 0}`,
        ...linesOf(
          results,
          (result) => `${result.node || result.taskId || '—'}：${result.ok ? '已提交' : `失败 —— ${readable(result.error || '未知原因', 160)}`}`,
          '（没有提交任何项）',
        ),
        '之后用 drama_collect_batch 收敛取产物；单镜失败不影响其余。',
      ])
    },
  ),

  drama_collect_batch: out(
    {
      collected: schemaNum,
      pending: schemaNum,
      failed: schemaNum,
      details: openObject(),
      budget: openObject(),
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const details = (value && value.details) || {}
      const collected = details.collected || []
      return renderText([
        `批次收敛：取回 ${value.collected ?? 0} / 待定 ${value.pending ?? 0} / 失败 ${value.failed ?? 0}`,
        ...linesOf(
          collected,
          (item) => `${item.taskId || '—'}：${Array.isArray(item.files) ? item.files.join('、') : '—'}`,
          '（本次没有取回产物；未完成的会留在 pending，可稍后再调）',
        ),
        ...linesOf(details.pending || [], (item) => `${item.taskId || '—'}：${readable(item.state || item.error || '未完成', 160)}`, '', 6),
        budgetLineOf(value.budget),
      ])
    },
  ),

  drama_canvas_status: out(
    {
      backend: schemaStr,
      binding: openObject(),
      snapshot: openObject(),
      canvases: schemaArr(openObject()),
      upstreamWarning: schemaStr,
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const snapshot = (value && value.snapshot) || {}
      const canvases = (value && value.canvases) || []
      const lines = [
        `外部画布对接（后端：${value.backend || 'libtv'}）`,
        ...bindingLines(value.binding),
        snapshot.ok ? `画布快照：${snapshot.count ?? 0} 个节点（${snapshot.at || '—'}）` : `画布快照：不可用 —— ${readable(snapshot.detail || snapshot.reason || '未知原因', 200)}`,
        Array.isArray(canvases) ? `候选画布：${canvases.length} 个${canvases.length ? `（${canvases.slice(0, 5).map((item) => item.name || item.uuid || item.id).filter(Boolean).join('、')}）` : ''}` : '',
        value.upstreamWarning ? `上游提示：${readable(value.upstreamWarning, 300)}` : '',
      ]
      return renderText(lines)
    },
  ),

  drama_bind_canvas: out(
    {
      uuid: schemaStr,
      cwd: schemaStr,
      binding: openObject(),
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      return renderText([
        `已绑定外部画布：${value.uuid || '—'}（后端 ${value.backend || value.binding?.backend || 'libtv'}）`,
        lineOf('项目目录', value.cwd || value.binding?.bindingFile || '—'),
        ...bindingLines(value.binding),
      ])
    },
  ),

  drama_reconcile_canvas: out(
    {
      episode: schemaNum,
      sourceOfTruth: schemaStr,
      detail: schemaStr,
      totalNodes: schemaNum,
      storyboardShots: schemaNum,
      canvasShots: schemaNum,
      missingOnCanvas: schemaArr(schemaStr),
      extraOnCanvas: schemaArr(schemaStr),
      consistent: schemaBool,
    },
    (value) => {
      if (value && value.ok === false) {
        return renderText([
          `画布对账失败：${readable(value.detail || value.reason || '未知原因', 300)}`,
          `分镜镜头数：${value.storyboardShots ?? '—'}`,
        ])
      }
      const missing = (value && value.missingOnCanvas) || []
      const extra = (value && value.extraOnCanvas) || []
      return renderText([
        `第 ${value.episode ?? '?'} 集双主对账（事实源：${value.sourceOfTruth || 'storyboard'}）`,
        `分镜镜头 ${value.storyboardShots ?? 0} 个 / 画布镜头 ${value.canvasShots ?? 0} 个（画布节点共 ${value.totalNodes ?? 0} 个）`,
        missing.length ? `画布缺失：${missing.join('、')}` : '画布缺失：无',
        extra.length ? `画布多余：${extra.join('、')}` : '画布多余：无',
        value.consistent ? '结论：分镜与画布一致 ✓' : '结论：存在差异（只报告，不自动改画布）',
        value.detail ? readable(value.detail, 300) : '',
      ])
    },
  ),

  drama_check_consistency: out(
    {
      title: schemaStr,
      issues: schemaArr(schemaObj({ severity: schemaStr, code: schemaStr, message: schemaStr, where: schemaStr }, ['severity'])),
      summary: openObject(),
      checkedAt: schemaStr,
      // P2-3 deep=true / saveReview 的增量字段（默认调用时不存在，旧渲染不变）
      saved: schemaBool,
      path: schemaStr,
      review: openObject(),
      deep: openObject(),
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const issues = (value && value.issues) || []
      const summary = (value && value.summary) || {}
      const lines = [
        `一致性检查：error ${summary.error ?? 0} / warn ${summary.warn ?? 0} / info ${summary.info ?? 0}（共 ${summary.total ?? issues.length} 项）`,
      ]
      if (!issues.length) {
        lines.push('未发现问题 ✓')
      } else {
        for (const issue of issues.slice(0, 15)) {
          lines.push(`· [${issue.severity || 'info'}] ${readable(issue.message || '—', 200)}${issue.where ? `（${issue.where}）` : ''}`)
        }
        if (issues.length > 15) lines.push(`…共 ${issues.length} 项；完整清单见面板「审读」页。`)
      }
      // P2-3：AI 审读 / 保存报告摘要
      const deep = value && value.deep
      if (value && value.saved === true && value.review) {
        const review = value.review
        lines.push('', `已保存审读报告：第 ${review.episode} 集（${value.path || ''}）`)
        lines.push(`结论：${readable(review.summary || '—', 200)}`)
      } else if (deep) {
        const mode = deep.mode === 'model' ? 'AI 审读' : deep.mode === 'agent-mediated' ? '待 Agent 判断（两段式）' : '确定性降级'
        const state = deep.degraded ? '降级（不阻断）' : '成功'
        lines.push('', `AI 审读：${mode} / ${state}${deep.degradeReason ? `（原因：${deep.degradeReason}）` : ''}`)
        const review = deep.review
        if (review && Array.isArray(review.findings)) {
          lines.push(`结论：${readable(review.summary || '—', 200)}`)
          for (const finding of review.findings.slice(0, 10)) {
            const location = `${finding.location?.episode ?? '?'}-${finding.location?.scene ?? '?'}`
            lines.push(`· [${finding.severity}] ${finding.dimension} @${location}：${readable(finding.evidence, 120)} → ${readable(finding.suggestion, 120)}`)
          }
          if (review.findings.length > 10) lines.push(`…共 ${review.findings.length} 条；完整清单见 .aidrama/reviews/latest.json`)
        }
        if (deep.savedPath) lines.push(`报告已落盘：${deep.savedPath}`)
        if (deep.saveHint) lines.push(`下一步：${readable(deep.saveHint, 300)}`)
      }
      return renderText(lines)
    },
  ),

  drama_export: out(
    {
      format: schemaStr,
      file: schemaStr,
      bytes: schemaNum,
      relative: schemaStr,
      manifest: openObject(),
      verify: openObject(),
      checks: openObject(),
    },
    (value) => {
      if (value && value.ok === false) return renderText(failureText(value))
      const format = value.format === 'markdown' ? 'Markdown 全本' : value.format === 'json' ? 'JSON 结构化包' : value.format === 'csv' ? 'CSV 拍摄用分镜表（UTF-8 BOM）' : value.format || '—'
      const lines = [
        `已导出：${format}`,
        lineOf('产物路径', value.relative || value.file),
        lineOf('文件大小', `${((Number(value.bytes) || 0) / 1024).toFixed(1)} KB`),
      ]
      const checks = value.checks || {}
      const summary = checks.summary || {}
      if (checks.ok === true) lines.push(`确定性检查：通过（${summary.passed ?? '—'}/${summary.total ?? '—'} 项）`)
      else if (checks.ok === false) lines.push(`确定性检查：未通过（${summary.failed ?? 0} 项）—— ${(checks.failed || []).map((item) => item.label || item.id).slice(0, 6).join('、')}`)
      if (value.manifest && (value.manifest.relative || value.manifest.file)) lines.push(lineOf('校验清单', value.manifest.relative || value.manifest.file))
      if (value.verify) lines.push(`清单复算：${value.verify.ok ? '一致' : '存在差异'}（${value.verify.checked ?? 0} 个产物）`)
      return renderText(lines)
    },
  ),

  /* ---- T3 测试工具（仅测试环境注册） ---- */
  drama_test_echo: out({ echo: openObject(), testTools: schemaBool }, (value) => {
    if (value && value.ok === false) return renderText(failureText(value))
    const echo = (value && value.echo) || {}
    return renderText([
      '测试工具已挂载并执行成功（说明 DSH_AI_DRAMA_TEST_TOOLS=1 生效）',
      lineOf('回显', echo),
    ])
  }),

  drama_test_failure: out({}, (value) => {
    if (value && value.ok === false) return renderText(failureText(value))
    return renderText(['测试工具未按预期失败'])
  }),
}
