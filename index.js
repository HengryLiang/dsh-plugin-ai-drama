/**
 * AI 短剧工作区 —— 宿主半（Host half）
 *
 * 三项职责：
 *   1. 解析工作区目录；
 *   2. 把仓储能力暴露为精确 POST 路由 `/api/ai-drama/<method>`（面板用）；
 *   3. 对**处于「短剧模式」预设的 Agent** 注册 `drama_*` 工具（FR-D03 工具白名单）。
 *
 * 业务逻辑在 lib/ 下；渲染全部由客户端半 client.js 负责。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as store from './lib/store.js'
import { assertSafeRelPath } from './lib/names.js'
import * as drafts from './lib/drafts.js'
import { checkConsistency } from './lib/consistency.js'
import { searchContext } from './lib/retrieval.js'
import { EXPORT_FORMATS, exportProject } from './lib/exporter.js'
import { createToolDefs, classifyToolFailure, DRAMA_TEST_TOOL_NAMES, DRAMA_TOOL_NAMES } from './lib/tools.js'
import * as txn from './lib/txn.js'
import { buildDramaContextCard, summarizeWriteFeedback } from './lib/context-card.js'
import { listDataSources } from './lib/sources.js'
import * as flowState from './lib/flow-state.js'
import * as audit from './lib/audit.js'
import { createBackendRegistry } from './lib/backends/index.js'
import * as generation from './lib/generation.js'
import * as orchestrator from './lib/orchestrator.js'
import * as guard from './lib/guard.js'
import * as importBridge from './lib/import-bridge.js'
import * as media from './lib/media.js'

export const name = 'ai-drama'

/** 需要 `connection` 服务（Fetch 路由注册表）存在后才注册路由。 */
export const inject = ['connection']

/**
 * 版本号以包自身 `package.json` 为准（单点维护，避免出现 v0.3.2 安装却报 0.3.0 的旧问题）。
 * QA 把它作为发布门禁：`/api/ai-drama/ping` 的 `version` 必须等于 package.json 的 version。
 */
const VERSION = (() => {
  try {
    const { version } = createRequire(import.meta.url)('./package.json')
    return typeof version === 'string' && version.trim() ? version.trim() : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
const API_PATH = '/api/ai-drama/'
const DRAMA_PRESET_SERVICE = 'dramaMode'

const METHODS = [
  'ping',
  'status',
  // P2-1 / E5（多数据源，Lead 批准、契约 §6 登记）：add-only，旧 67 条行为不变。
  'sources-list',
  'shelf',
  'create-project',
  'tree',
  'search',
  'entry-create',
  'entry-rename',
  'entry-delete',
  'contract-get',
  'contract-save',
  'outline-get',
  'outline-save',
  'characters-get',
  'characters-save',
  'episodes-list',
  'episode-read',
  'episode-write',
  'doc-read',
  'doc-save',
  'doc-notify',
  'storyboard-get',
  'storyboard-save',
  'drafts-list',
  'draft-resolve',
  'memory-get',
  'memory-save',
  'world-get',
  'world-save',
  'dialogue-get',
  'voice-script-export',
  'assets-get',
  'assets-add',
  'assets-remove',
  'finalized-list',
  'finalize-episode',
  'finalized-restore',
  'ledger-get',
  'import-preview',
  'import-apply',
  'backends-status',
  'catalog',
  'estimate-generation',
  'tasks-list',
  'task-create',
  'task-update',
  'budget-get',
  'budget-set',
  'intake-artifact',
  'plan-batch',
  'submit-batch',
  'collect-batch',
  'canvas-status',
  'canvas-bind',
  'canvas-reconcile',
  'shared-list',
  'shared-read',
  'shared-write',
  'settings-get',
  'settings-save',
  'progress-get',
  'project-rename',
  'project-delete',
  'search-context',
  'consistency-check',
  'export-project',
  'agents-status',
  // v0.15.1（task-110，H 类契约，Lead 批准）：本地图片只读通道；68→69，工具面仍 34。
  'media-read',
]

/* ------------------------------------------------------------------ 工具 */

/** 项目内文件的「格式化集数」文件名片段：第001集。 */
function episodeStem(order) {
  const n = Math.round(Number(order))
  return Number.isFinite(n) && n > 0 ? `第${String(n).padStart(3, '0')}集` : '第000集'
}

/**
 * P1-K / T2：写路由 → 事务目标文件（用于项目锁与审计里的前后 sha256）。
 * 未列出的写方法不包事务（保持旧行为）；METHODS 清单不变。
 */
const WRITE_TARGETS = {
  'contract-save': () => ['剧集契约.md', '.aidrama/contract.json'],
  'outline-save': () => ['总纲/分集大纲.md', '.aidrama/outline.json'],
  'characters-save': () => ['人物/人物设定卡.md', '.aidrama/characters.json'],
  'episode-write': (input) => [`分集剧本/${episodeStem(input.order)}.md`],
  'storyboard-save': (input) => [
    `分镜/${episodeStem(input.order)}.分镜.md`,
    `.aidrama/storyboard/${episodeStem(input.order)}.md.json`,
    // v0.10.0（0-4b）：可选 groups sidecar（add-only；不传=旧行为）
    ...(input.groups !== undefined ? [`.aidrama/storyboard-groups/${episodeStem(input.order)}.md.json`] : []),
  ],
  'memory-save': () => ['本剧记忆/本剧记忆.md', '.aidrama/memory.json'],
  'world-save': () => ['世界观/世界观.md', '.aidrama/world.json'],
  'import-apply': (input) =>
    input.format === 'shot-prompt'
      ? [
          `分镜/${episodeStem(input.episode)}.分镜.md`,
          `.aidrama/storyboard/${episodeStem(input.episode)}.md.json`,
          `.aidrama/storyboard-groups/${episodeStem(input.episode)}.md.json`,
        ]
      : ['分集剧本'],
  'finalize-episode': () => ['定稿/定稿记录.md', '.aidrama/finalized.json'],
  'finalized-restore': (input) => [
    `分集剧本/${episodeStem(input.order)}.md`,
    `分镜/${episodeStem(input.order)}.分镜.md`,
    '.aidrama/finalized.json',
  ],
  'draft-resolve': () => ['.aidrama/drafts'],
  'assets-add': () => ['.aidrama/assets.json', '素材/素材清单.md'],
  'assets-remove': () => ['.aidrama/assets.json', '素材/素材清单.md'],
  'budget-set': () => ['.aidrama/budget.json', '账本/消耗台账.md'],
  'task-create': () => ['.aidrama/tasks.json'],
  'task-update': () => ['.aidrama/tasks.json'],
  // E1（T6 编辑器往返）：文档保存同属写操作，包事务与审计；非法路径交给 dispatch 报错。
  'doc-save': (input) => {
    try {
      return [docRelativePath(input.path)]
    } catch {
      return null
    }
  },
  'doc-notify': () => ['.aidrama/editor-notifications.jsonl'],
}

/**
 * P2-2 / Q4：内容写路由 → flow-state 步骤（面板侧；Agent 工具侧另见 attachAgentTools 的 TOOL_FLOW_STEPS）。
 * doc-save（含 flow-state 特例）由 flow 模块自行维护，不在此表。
 */
const ROUTE_FLOW_STEPS = {
  'contract-save': 'outline',
  'outline-save': 'outline',
  'characters-save': 'characters',
  'episode-write': 'episode_script',
  'storyboard-save': 'storyboard',
  'import-apply': 'episode_script',
  'export-project': 'exported',
}

/** 从 draft-resolve 响应推断本次采纳影响的步骤（批量逐条、只取主要落地类型）。 */
function deriveDraftFlowStepFromValue(value) {
  if (!value || !Array.isArray(value.results)) return ''
  const applied = value.results.map((item) => item && item.applied).filter(Boolean)
  if (applied.includes('episode')) return 'episode_script'
  if (applied.includes('storyboard')) return 'storyboard'
  if (applied.includes('outline')) return 'outline'
  if (applied.includes('characters')) return 'characters'
  return ''
}

/** E1：编辑器往返的文档路径（项目内相对路径；禁止越界与 .aidrama，仅放行 P2-2 的 flow-state 内部路径）。 */
function docRelativePath(relPath) {
  const raw = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim()
  if (raw === flowState.FLOW_INTERNAL_PATH) return flowState.FLOW_INTERNAL_PATH
  return assertSafeRelPath(raw)
}

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** 读取文档当前 sha256（不存在返回 null）。 */
async function readDocHash(file) {
  try {
    return sha256Hex(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

function reply(status, value) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

function fail(status, code, error) {
  return reply(status, { ok: false, code, error })
}

async function readRequest(request) {
  const text = await request.text()
  if (!text) return {}
  const value = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('请求格式不正确')
  }
  return value
}

function safeGet(scope, serviceName) {
  try {
    return scope.get(serviceName)
  } catch {
    return undefined
  }
}

/** 按 id 取阶段二后端（LibTV / neowow）。未就绪时返回 null，由调用方给出可读错误。 */
function backendFor(scope, id) {
  const host = scope ? safeGet(scope, 'aiDramaHost') : undefined
  return host && host.backends ? host.backends.get(id) : null
}

/* -------------------------------------------------------------- 工作区解析 */

async function resolveWorkspaceRoot(scope, input, config) {
  const fromClient = input.cwd
  if (typeof fromClient === 'string' && path.isAbsolute(fromClient) && (await store.isDirectory(fromClient))) {
    return { cwd: fromClient, source: 'client' }
  }

  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
  if (sessionId) {
    const agents = safeGet(scope, 'agents')
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : undefined
    if (typeof cwd === 'string' && path.isAbsolute(cwd)) return { cwd, source: 'session' }
  }

  const registry = safeGet(scope, 'workspaceRegistry')
  if (registry && typeof registry.list === 'function') {
    let records = []
    try {
      records = (await registry.list()) || []
    } catch {
      records = []
    }
    for (const record of records) {
      for (const key of ['path', 'directory', 'dir', 'root', 'canonicalPath']) {
        const value = record ? record[key] : undefined
        if (typeof value === 'string' && path.isAbsolute(value) && (await store.isDirectory(value))) {
          return { cwd: value, source: 'workspace-registry' }
        }
      }
    }
  }

  const configured = config ? config.root : undefined
  if (typeof configured === 'string' && path.isAbsolute(configured) && (await store.isDirectory(configured))) {
    return { cwd: configured, source: 'config' }
  }

  return { cwd: null, source: null }
}

/* ---------------------------------------------------------------- 采纳草稿 */

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
    case 'file':
      if (!draft.path) throw new Error('草稿缺少目标路径')
      return { applied: 'file', result: await store.writeEntryFile(root, title, draft.path, draft.content) }
    case 'batch-artifact': {
      // P2-7（v0.7.1）：批量生成产物草稿采纳 —— 才把批次暂存产物拷入 素材/生成 + 记资产。
      const meta = JSON.parse(draft.content)
      if (meta.draftKind && meta.draftKind !== 'batch-artifact') throw new Error('批量产物草稿元数据不匹配')
      const result = await generation.adoptBatchArtifact(root, title, { ...meta.target, batchId: meta.batchId, stagedRelative: meta.stagedRelative, draftId: draft.id })
      return { applied: 'batch-artifact', result }
    }
    default:
      throw new Error(`未知草稿类型：${draft.kind}`)
  }
}

/* ---------------------------------------------------------------- 路由分发 */

async function dispatch(method, input, root, scope) {
  switch (method) {
    case 'ping':
      return { ok: true, name, version: VERSION }

    case 'status': {
      const base = store.projectsBase(root)
      const exists = await store.isDirectory(base)
      const projects = exists ? await store.listProjects(root) : []
      return { ok: true, version: VERSION, root: base, exists, projectCount: projects.length }
    }

    case 'shelf':
      return { ok: true, root: store.projectsBase(root), projects: await store.listProjects(root) }

    case 'create-project':
      return { ok: true, project: await store.createProject(root, input.title) }

    case 'tree':
      return { ok: true, tree: await store.readTree(root, input.title) }

    case 'search':
      return { ok: true, ...(await store.search(root, input.query, { limit: input.limit })) }

    case 'entry-create':
      return { ok: true, entry: await store.createEntry(root, input.title, input.path, input.kind) }

    case 'entry-rename':
      return { ok: true, renamed: await store.renameEntry(root, input.title, input.path, input.name) }

    case 'entry-delete':
      return { ok: true, deleted: await store.deleteEntry(root, input.title, input.path) }

    case 'contract-get':
      return { ok: true, contract: await store.getContract(root, input.title) }

    case 'contract-save':
      return { ok: true, contract: await store.saveContract(root, input.title, input.contract) }

    case 'outline-get':
      return { ok: true, rows: await store.getOutline(root, input.title) }

    case 'outline-save':
      return { ok: true, rows: await store.saveOutline(root, input.title, input.rows) }

    case 'characters-get':
      return { ok: true, characters: await store.getCharacters(root, input.title) }

    case 'characters-save':
      return { ok: true, characters: await store.saveCharacters(root, input.title, input.characters) }

    case 'episodes-list':
      return { ok: true, episodes: await store.listEpisodes(root, input.title) }

    case 'episode-read':
      return { ok: true, ...(await store.readEpisode(root, input.title, input.order)) }

    case 'episode-write':
      return { ok: true, saved: await store.writeEpisode(root, input.title, input.order, input.text) }

    /* ---------------- E1（T6）：编辑器往返 doc-read / doc-save / doc-notify ---------------- */
    case 'doc-read': {
      const dir = store.projectDir(root, input.title)
      if (!(await store.isDirectory(dir))) throw new Error(`短剧《${input.title}》不存在`)
      // P2-3（E6.1）：审读报告只读特例（仅精确路径 `.aidrama/reviews/latest.json`；doc-save 不扩）。
      const reviewRel = audit.normalizeReviewReadPath(input.path)
      if (reviewRel) {
        const latest = await audit.readLatestReview(root, input.title)
        if (!latest) return fail(404, 'not-found', '暂无审读报告（可让 Agent 用 drama_check_consistency(deep=true) 审读本集）')
        return {
          ok: true,
          path: reviewRel,
          text: latest.text,
          hash: sha256Hex(latest.text),
          bytes: latest.bytes,
          updatedAt: latest.updatedAt,
        }
      }
      const rel = docRelativePath(input.path)
      // P2-2（E6）：flow-state 内部路径特例 —— 缺失时按内容推断并落盘，恒返回 200（AC-F7）
      if (rel === flowState.FLOW_INTERNAL_PATH) {
        const { state, text } = await flowState.readOrInferFlowState(root, input.title, { persist: true })
        return {
          ok: true,
          path: rel,
          text,
          hash: sha256Hex(text),
          bytes: Buffer.byteLength(text, 'utf8'),
          updatedAt: state.updatedAt,
        }
      }
      const file = path.join(dir, rel)
      let stat
      try {
        stat = await fs.stat(file)
      } catch {
        return fail(404, 'not-found', `文档不存在：${rel}`)
      }
      if (!stat.isFile()) return fail(400, 'invalid-args', `目标不是文件：${rel}`)
      const text = await fs.readFile(file, 'utf8')
      return {
        ok: true,
        path: rel,
        text,
        hash: sha256Hex(text),
        bytes: Buffer.byteLength(text, 'utf8'),
        updatedAt: stat.mtime.toISOString(),
      }
    }

    case 'doc-save': {
      const dir = store.projectDir(root, input.title)
      if (!(await store.isDirectory(dir))) throw new Error(`短剧《${input.title}》不存在`)
      const rel = docRelativePath(input.path)
      if (typeof input.text !== 'string') throw new Error('文档内容 text 必须是字符串')
      if (input.text.length > 4_000_000) throw new Error('文档内容过长（上限约 400 万字符）')
      // P2-2（E6）：flow-state 内部路径特例 —— 状态归一/迁移由宿主处理，保持一致性与下游 stale 传播。
      if (rel === flowState.FLOW_INTERNAL_PATH) {
        const current = await flowState.readOrInferFlowState(root, input.title, { persist: true })
        const currentHash = sha256Hex(current.text)
        if (input.expectedHash != null && String(input.expectedHash) !== currentHash) {
          return reply(409, {
            ok: false,
            code: 'conflict',
            error: `flow-state 已被其他写入修改（expectedHash 不符）：${rel}`,
            currentHash,
          })
        }
        const saved = await flowState.saveFlowStateText(root, input.title, input.text, { actor: 'editor' })
        return {
          ok: true,
          path: rel,
          hash: sha256Hex(saved.text),
          bytes: Buffer.byteLength(saved.text, 'utf8'),
          updatedAt: saved.state.updatedAt,
        }
      }
      const file = path.join(dir, rel)
      // E1 契约：expectedHash 不符 → HTTP 409 + code:'conflict' + currentHash（不回写任何内容）
      if (input.expectedHash != null) {
        const currentHash = await readDocHash(file)
        if (String(input.expectedHash) !== currentHash) {
          return reply(409, {
            ok: false,
            code: 'conflict',
            error: `文档已被其他写入修改（expectedHash 不符）：${rel}`,
            currentHash,
          })
        }
      }
      await store.atomicWrite(file, input.text)
      return {
        ok: true,
        path: rel,
        hash: sha256Hex(input.text),
        bytes: Buffer.byteLength(input.text, 'utf8'),
        updatedAt: new Date().toISOString(),
      }
    }

    case 'doc-notify': {
      const dir = store.projectDir(root, input.title)
      if (!(await store.isDirectory(dir))) throw new Error(`短剧《${input.title}》不存在`)
      const rel = docRelativePath(input.path)
      const record = {
        at: new Date().toISOString(),
        action: String(input.action || 'save').slice(0, 40),
        path: rel,
        hash: typeof input.hash === 'string' ? input.hash.slice(0, 128) : '',
      }
      const metaDir = path.join(dir, '.aidrama')
      await fs.mkdir(metaDir, { recursive: true })
      await fs.appendFile(path.join(metaDir, 'editor-notifications.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
      return { ok: true, path: rel, action: record.action, notifiedAt: record.at }
    }

    case 'storyboard-get':
      return { ok: true, ...(await store.getStoryboardReadView(root, input.title, input.order)) }

    case 'storyboard-save': {
      // v0.10.0（0-4b）：可选 groups（add-only）；不传=旧行为，传 [] = 清空 sidecar。
      if (input.groups !== undefined) {
        const saved = await store.saveStoryboardWithGroups(root, input.title, input.order, input.shots, input.groups)
        return { ok: true, shots: saved.shots, groups: saved.groups, groupsSaved: saved.groups.length > 0 }
      }
      return { ok: true, shots: await store.saveStoryboard(root, input.title, input.order, input.shots) }
    }

    case 'drafts-list': {
      const dir = store.projectDir(root, input.title)
      if (!(await store.isDirectory(dir))) throw new Error(`短剧《${input.title}》不存在`)
      return { ok: true, drafts: await drafts.listDrafts(dir, { includeResolved: Boolean(input.includeResolved) }) }
    }

    case 'draft-resolve': {
      const dir = store.projectDir(root, input.title)
      if (!(await store.isDirectory(dir))) throw new Error(`短剧《${input.title}》不存在`)
      const action = input.action
      if (!['accept', 'discard', 'restore'].includes(action)) throw new Error('action 只能是 accept、discard 或 restore')

      // H-1（契约冻结）：单条旧调用 `{ id, action }` 保留；批量新调用 `{ ids, action }`（ids 优先）。
      const batchIds = Array.isArray(input.ids) ? input.ids.map((id) => String(id || '').trim()).filter(Boolean) : []
      const legacy = batchIds.length === 0
      const targets = legacy ? [String(input.id || '').trim()].filter(Boolean) : batchIds
      if (!targets.length) throw new Error('需要提供 id 或 ids')

      // 单条旧响应里的 applied/result 键要原样保留，这里捕获 applyDraft 的完整返回值。
      let legacyApplied = null
      const apply = async (draft) => {
        const applied = await applyDraft(root, input.title, draft)
        legacyApplied = applied
        return applied
      }
      const rawResults = await drafts.resolveMany(dir, targets, action, { apply })
      const results = rawResults.map((item) => {
        if (item.ok) return item
        // 失败条目补统一失败码（与 task-9 工具失败契约一致：{ code, reason }），逐条失败不整体失败。
        const failure = classifyToolFailure(new Error((item.error && item.error.reason) || '草稿处理失败'))
        return { ...item, error: { code: failure.code, reason: failure.reason, next: failure.next } }
      })
      const counts = drafts.countDraftResults(results)

      // 单条旧调用：失败仍走 HTTP 400（旧语义）；批量才逐条失败、整体 200+ok:true。
      if (legacy) {
        const only = results[0]
        if (!only || only.ok !== true) throw new Error((only && only.error && only.error.reason) || '草稿处理失败')
        if (action === 'accept') return { ok: true, status: only.status, ...(legacyApplied || {}), results, counts }
        if (action === 'restore') return { ok: true, status: 'restored', draftStatus: only.draftStatus || 'pending', results, counts }
        return { ok: true, status: only.status, results, counts }
      }
      return { ok: true, results, counts }
    }

    case 'memory-get':
      return { ok: true, memory: await store.getMemory(root, input.title) }

    case 'memory-save':
      return { ok: true, memory: await store.saveMemory(root, input.title, input.memory) }

    case 'world-get':
      return { ok: true, world: await store.getWorld(root, input.title) }

    case 'world-save':
      return { ok: true, world: await store.saveWorld(root, input.title, input.world) }

    case 'dialogue-get':
      return { ok: true, ...(await store.getDialogue(root, input.title)) }

    case 'voice-script-export':
      return { ok: true, ...(await store.exportVoiceScript(root, input.title, input.order)) }

    case 'assets-get': {
      // v0.15.1（task-107）：add-only cards（资产卡 media 读侧；旧 assets 字段不变）
      const assets = await store.getAssets(root, input.title)
      const cards = await store.getAssetCards(root, input.title)
      // v0.15.3（task-114 / 迭代3 VB-H）：add-only scenes/styleDNA（E 类；仅存在数据时出现；损坏视为无）
      let scenes = []
      try {
        scenes = await store.getScenes(root, input.title)
      } catch {
        scenes = []
      }
      let styleDNA = null
      try {
        styleDNA = await store.getStyleDNA(root, input.title)
      } catch {
        styleDNA = null
      }
      const style = styleDNA && typeof styleDNA === 'object'
        ? Object.fromEntries(
            ['palette', 'lighting', 'texture', 'composition', 'motion'].map((dimension) => {
              const value = styleDNA[dimension]
              return [dimension, String(value == null ? '' : value)]
            }),
          )
        : null
      const hasStyle = style !== null && Object.values(style).some((value) => value.trim())
      return {
        ok: true,
        assets,
        cards,
        ...(Array.isArray(scenes) && scenes.length ? { scenes } : {}),
        ...(hasStyle ? { styleDNA: style } : {}),
      }
    }

    case 'assets-add':
      return { ok: true, asset: await store.addAsset(root, input.title, input.asset || input) }

    case 'assets-remove': {
      const result = await store.removeAsset(root, input.title, input.id)
      return { ok: true, removed: true, id: result.id }
    }

    // v0.15.1（task-110，H 类契约，Lead 批准）：本地图片只读通道（media-read，METHODS 68→69）
    case 'media-read': {
      try {
        return { ok: true, ...(await media.readMedia(root, input)) }
      } catch (error) {
        const code = error && typeof error.code === 'string' ? error.code : 'invalid-args'
        const status = code === 'forbidden' ? 403 : code === 'not-found' ? 404 : code === 'too-large' ? 413 : 400
        return fail(status, code, error instanceof Error ? error.message : '读取图片失败')
      }
    }

    case 'finalized-list':
      return { ok: true, finalized: await store.getFinalized(root, input.title) }

    case 'finalize-episode':
      return { ok: true, finalized: await store.finalizeEpisode(root, input.title, input.order) }

    case 'finalized-restore':
      return { ok: true, restored: await store.restoreFinalized(root, input.title, input.order, input.version) }

    case 'ledger-get': {
      const ledger = await store.renderLedger(root, input.title)
      return { ok: true, ledger, file: path.relative(root, ledger.file) }
    }

    case 'import-preview': {
      // v0.10.1（task-81）：分镜提示词 MD→JSON 预览（只读，不写盘）
      if (input.format === 'shot-prompt') {
        if (!input.title) return fail(400, 'invalid-args', 'shot-prompt 预览需要 title')
        const preview = await importBridge.previewImport(root, input.title, { text: input.text, episode: input.episode })
        return { ok: true, format: 'shot-prompt', ...preview }
      }
      return { ok: true, ...store.splitScript(input.text, { defaultTitle: input.defaultTitle }) }
    }

    case 'import-apply': {
      // v0.10.1（task-81）：分镜提示词 MD→JSON 应用（事务+回滚；覆盖已有分镜需 overwrite=true，工具层已审批）
      if (input.format === 'shot-prompt') {
        if (!input.title) return fail(400, 'invalid-args', 'shot-prompt 应用需要 title')
        const result = await importBridge.applyImport(root, input.title, { text: input.text, episode: input.episode, overwrite: input.overwrite })
        return { ok: true, format: 'shot-prompt', ...result }
      }
      return { ok: true, ...(await store.importScript(root, input.title, input.text, { overwrite: input.overwrite, defaultTitle: input.defaultTitle })) }
    }

    case 'backends-status': {
      const host = scope ? safeGet(scope, 'aiDramaHost') : undefined
      if (!host || !host.backends) return fail(500, 'no-backends', '后端注册表尚未就绪')
      return { ok: true, ...(await host.backends.probe({ toolNames: null })) }
    }

    case 'catalog': {
      const host = scope ? safeGet(scope, 'aiDramaHost') : undefined
      const backend = host && host.backends ? host.backends.get(input.backend || 'neowow') : null
      if (!backend || typeof backend.catalog !== 'function') return fail(400, 'no-catalog', '该后端不提供模型目录')
      const models = await backend.catalog(input.kind || 'image', { refresh: Boolean(input.refresh) })
      return { ok: true, backend: backend.id, kind: input.kind || 'image', count: models.length, models }
    }

    case 'estimate-generation': {
      const host = scope ? safeGet(scope, 'aiDramaHost') : undefined
      if (!host || !host.backends) return fail(500, 'no-backends', '后端注册表尚未就绪')
      const estimates = []
      for (const backend of host.backends.list()) {
        try {
          estimates.push({ backend: backend.id, label: backend.label, ...(await backend.estimate(input)) })
        } catch (error) {
          estimates.push({ backend: backend.id, label: backend.label, ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) })
        }
      }
      return { ok: true, request: input, estimates }
    }

    case 'tasks-list':
      return { ok: true, tasks: await generation.listTasks(root, input.title, { status: input.status, limit: input.limit }) }

    case 'task-create':
      return { ok: true, task: await generation.createTask(root, input.title, input.task || input) }

    case 'task-update':
      return {
        ok: true,
        task: await generation.updateTask(root, input.title, input.id, input.patch || {}),
        budget: await generation.getBudget(root, input.title),
      }

    case 'budget-get':
      return { ok: true, budget: await generation.getBudget(root, input.title) }

    case 'budget-set':
      return { ok: true, budget: await generation.setBudgetLimit(root, input.title, input.limitPoints) }

    case 'intake-artifact': {
      const r = await generation.intakeArtifact(root, input.title, input.artifact || input)
      return { ok: true, name: r.file, relative: r.relative, bytes: r.bytes, sha256: r.sha256, assetId: r.asset.id, asset: r.asset }
    }

    case 'plan-batch': {
      const planInput = input.plan || input
      // P2-7（v0.7.1）：additive 输入 plan.episodes[]（或 count+from）→ N 集串行批量规划；旧单集输入行为不变。
      if (Array.isArray(planInput.episodes) || Number(planInput.count || planInput.episodeCount) > 0) {
        return { ok: true, batch: await orchestrator.planBatchEpisodes(root, input.title, planInput) }
      }
      return { ok: true, plan: await orchestrator.planEpisode(root, input.title, planInput) }
    }

    case 'submit-batch': {
      const host = scope ? safeGet(scope, 'aiDramaHost') : undefined
      const resolve = (id) => (host && host.backends ? host.backends.get(id) : null)
      const batch = { ...(input.batch || {}), resolveBackend: resolve }
      // P2-7（v0.7.1）：batchId 已存在批次溯源时 → N 集串行提交（续跑幂等）；否则旧单批/续跑行为不变。
      if (batch.batchId) {
        const exists = await generation.getBatchTrace(root, input.title, String(batch.batchId)).then(() => true, () => false)
        if (exists) return { ok: true, ...(await orchestrator.submitBatchEpisodes(root, input.title, batch)) }
      }
      // v0.6.7：断点续跑（只补未成功任务；默认无 resume 字段=旧提交行为不变）
      if (batch.resume === true) return { ok: true, ...(await orchestrator.resumeBatch(root, input.title, batch)) }
      return { ok: true, ...(await orchestrator.submitBatch(root, input.title, batch)) }
    }

    case 'collect-batch': {
      const host = scope ? safeGet(scope, 'aiDramaHost') : undefined
      const resolve = (id) => (host && host.backends ? host.backends.get(id) : null)
      const batch = { ...(input.batch || {}), resolveBackend: resolve }
      // P2-7（v0.7.1）：batchId 批次存在 → N 集串行收敛（产物进草稿暂存 + 逐集一致性 + 溯源）；旧行为不变。
      if (batch.batchId) {
        const exists = await generation.getBatchTrace(root, input.title, String(batch.batchId)).then(() => true, () => false)
        if (exists) return { ok: true, ...(await orchestrator.collectBatchEpisodes(root, input.title, batch)) }
      }
      return { ok: true, ...(await orchestrator.collectBatch(root, input.title, batch)) }
    }

    case 'canvas-status': {
      const backendId = input.backend || 'libtv'
      const backend = scope ? backendFor(scope, backendId) : null
      const cwd = store.projectDir(root, input.title)
      const binding = await guard.checkBinding(root, input.title, backendId)
      const snapshot = binding.ok && backend ? await guard.snapshotCanvas(backend, { cwd }) : null
      let canvases = null
      let canvasesError = null
      if (backend && typeof backend.listCanvases === 'function') {
        try {
          canvases = await backend.listCanvases({ cwd })
        } catch (error) {
          canvasesError = error instanceof Error ? error.message : String(error)
        }
      }
      return {
        ok: true,
        backend: backendId,
        binding,
        snapshot,
        canvases,
        canvasesError,
        guard: await guard.readGuardState(root, input.title),
        upstreamWarning: guard.UPSTREAM_WARNING,
      }
    }

    case 'canvas-bind': {
      const backendId = input.backend || 'libtv'
      const backend = scope ? backendFor(scope, backendId) : null
      if (!backend || typeof backend.bindCanvas !== 'function') return fail(400, 'no-bind', `后端 ${backendId} 不支持画布绑定`)
      const cwd = store.projectDir(root, input.title)
      const result = await backend.bindCanvas({ uuid: input.uuid, cwd })
      const binding = await guard.checkBinding(root, input.title, backendId)
      return { ok: true, ...result, binding }
    }

    case 'canvas-reconcile': {
      const backendId = input.backend || 'libtv'
      const backend = scope ? backendFor(scope, backendId) : null
      if (!backend) return fail(400, 'no-backend', `后端不可用：${backendId}`)
      const cwd = store.projectDir(root, input.title)
      return { ok: true, ...(await guard.reconcile(root, input.title, { backend, episode: input.order ?? input.episode, cwd })) }
    }

    case 'shared-list':
      return { ok: true, ...(await store.listShared(root, input.path)) }

    case 'shared-read':
      return { ok: true, ...(await store.readShared(root, input.path)) }

    case 'shared-write':
      return { ok: true, written: await store.writeShared(root, input.path, input.text) }

    case 'settings-get':
      return { ok: true, settings: await store.getSettings(root) }

    case 'settings-save':
      return { ok: true, settings: await store.saveSettings(root, input.settings) }

    case 'progress-get':
      return { ok: true, progress: await store.getProgress(root, input.title) }

    case 'project-rename':
      return { ok: true, renamed: await store.renameProject(root, input.title, input.name) }

    case 'project-delete': {
      const result = await store.deleteProject(root, input.title)
      return { ok: true, deleted: true, title: result.title }
    }

    case 'search-context':
      return { ok: true, ...(await searchContext(root, input.title, input.query, { topK: input.topK })) }

    case 'consistency-check':
      return { ok: true, report: await checkConsistency(root, input.title) }

    case 'agents-status': {
      const host = scope ? safeGet(scope, 'aiDramaHost') : undefined
      const diag = host && typeof host.diagnostics === 'function' ? host.diagnostics() : null
      return {
        ok: true,
        preset: { id: 'drama', name: '短剧模式', service: DRAMA_PRESET_SERVICE },
        tools: DRAMA_TOOL_NAMES,
        attach: diag || { toolCount: DRAMA_TOOL_NAMES.length, attachedAgents: [], seenAgents: [], available: false },
      }
    }

    case 'export-project': {
      const format = input.format || 'markdown'
      if (!EXPORT_FORMATS.includes(format)) throw new Error(`不支持的导出格式：${format}`)
      const result = await exportProject(root, input.title, format)
      // 契约冻结：route 响应只保留既有字段；T10 的 manifest/checks/verify 摘要只出现在
      // Agent 工具结果与内部 API 中，不改变已冻结的 HTTP 形状。
      return {
        ok: true,
        export: { format: result.format, file: result.file, bytes: result.bytes, relative: path.relative(root, result.file) },
      }
    }

    default:
      return null
  }
}

function createHandler(scope, config, pluginCtx) {
  return async (request) => {
    if (request.method !== 'POST' || request.headers.get('x-ai-drama-request') !== '1') {
      return fail(403, 'forbidden', '请求来源不被允许')
    }
    try {
      const input = await readRequest(request)
      const method = new URL(request.url).pathname.slice(API_PATH.length)
      if (!METHODS.includes(method)) return fail(404, 'not-found', `未知方法：${method}`)

      if (method === 'ping') return reply(200, { ok: true, name, version: VERSION })

      // P2-1 / E5：数据源枚举不依赖单一工作区解析，先于 resolveWorkspaceRoot 返回。
      if (method === 'sources-list') {
        const registry = safeGet(scope, 'workspaceRegistry')
        const agentsService = safeGet(scope, 'agents')
        let agentsList = []
        let agentsAvailable = Boolean(agentsService)
        try {
          agentsList = agentsService && typeof agentsService.list === 'function' ? (agentsService.list() || []) : []
        } catch {
          agentsList = []
          agentsAvailable = false
        }
        const listed = await listDataSources({
          registry,
          agentsList,
          agentsAvailable,
          configRoot: config ? config.root : undefined,
          cwd: typeof input.cwd === 'string' ? input.cwd : '',
          limit: input.limit,
        })
        return reply(200, { ok: true, sources: listed.sources, degraded: listed.degraded })
      }

      const resolved = await resolveWorkspaceRoot(scope, input, config)
      if (!resolved.cwd) {
        return fail(409, 'no-workspace', '未能确定工作区目录。请在 DSH 中打开一个工作区后重试，或在插件配置中指定 root。')
      }

      // P2-2（Q1/AC-F3）：强制模式下内容写要求「上一步已确认」；宽松模式（默认）直接放行。
      {
        const preFlowStep = ROUTE_FLOW_STEPS[method] || ''
        const preFlowTitle = typeof input.title === 'string' ? input.title.trim() : ''
        if (preFlowStep && preFlowTitle) {
          try {
            await flowState.assertStepAllowed(resolved.cwd, preFlowTitle, preFlowStep)
          } catch (error) {
            if (error && error.code === 'conflict') {
              const next = typeof error.next === 'string' && error.next ? `（下一步：${error.next}）` : ''
              return fail(409, 'conflict', `${error instanceof Error ? error.message : '强制模式阻止该操作'}${next}`)
            }
            throw error
          }
        }
      }

      // P1-K / T2：写路由统一包项目事务（项目锁 + 审计；可选 operationId 幂等 / expectedHash 乐观锁）。
      // H-5（PM 登记、Lead 追认）：不传新字段时行为与旧版完全一致。
      const writeTargets = WRITE_TARGETS[method]
      const txnTitle = typeof input.title === 'string' ? input.title.trim() : ''
      let value
      if (writeTargets && txnTitle) {
        value = await txn.runProjectTxn(
          resolved.cwd,
          txnTitle,
          {
            action: method,
            actor: method.startsWith('doc-') ? 'editor' : 'panel',
            targets: writeTargets(input),
            operationId: typeof input.operationId === 'string' ? input.operationId : '',
            // doc-save 自己处理 expectedHash（冲突响应需要带 currentHash，形状与 H-5 通用 conflict 不同）
            expectedHash: method === 'doc-save' ? undefined : input.expectedHash && typeof input.expectedHash === 'object' ? input.expectedHash : undefined,
          },
          () => dispatch(method, input, resolved.cwd, scope),
        )
      } else {
        value = await dispatch(method, input, resolved.cwd, scope)
      }
      // dispatch 内部的 fail(...) 返回的是 Response，必须原样透传：
      // 早先这里直接 {...value} 会把 Response 展开成 {}，导致本该 400 的分支变成 200 空响应。
      if (value instanceof Response) return value
      // 编辑器保存通知（E1/T6）：落到宿主日志，主控侧/联调可直接观测；权威记录在
      // `.aidrama/editor-notifications.jsonl` 与写审计（queryAudit action=doc-notify）。
      if (method === 'doc-notify') {
        pluginCtx?.logger?.info?.(`[ai-drama] 编辑器保存通知：${String(input.path || '')}（${String(input.action || 'save')}）`)
      }
      // P2-2 / Q4：面板内容写路由成功后同步 flow-state（Agent 工具侧另有同步；doc-save(flow) 由 flow 模块自维护）
      if (value && value.ok !== false) {
        if (method === 'create-project' && value.project && value.project.title) {
          try {
            await flowState.initFlowState(resolved.cwd, value.project.title)
          } catch {
            /* 初始状态落盘失败不影响建项目响应 */
          }
        }
        const flowStep =
          method === 'draft-resolve' ? deriveDraftFlowStepFromValue(value) : ROUTE_FLOW_STEPS[method] || ''
        if (flowStep) {
          const flowTitle = txnTitle || (typeof input.title === 'string' ? input.title.trim() : '')
          try {
            await flowState.syncAfterContentWrite(resolved.cwd, flowTitle, {
              step: flowStep,
              actor: method.startsWith('doc-') ? 'editor' : 'panel',
            })
          } catch {
            /* flow-state 同步失败不影响主响应 */
          }
        }
      }
      if (!value) return fail(404, 'not-found', `未知方法：${method}`)
      return reply(200, { ...value, workspace: resolved.cwd, workspaceSource: resolved.source })
    } catch (error) {
      const message = error instanceof Error ? error.message : '短剧操作失败'
      // 事务层冲突（expectedHash / 写锁）单独映射 409 + conflict，并附可重试指引；
      // 其它参数/业务错误保持旧语义（HTTP 400 + code:'failed'），不改变既有行为。
      if (error && error.code === 'conflict') {
        const next = typeof error.next === 'string' && error.next ? `（下一步：${error.next}）` : ''
        return fail(409, 'conflict', `${message}${next}`)
      }
      // P2-5（v0.6.6）：参数校验错误明确映射 invalid-args（如 settings.generationLimits 非法值）
      if (error && error.code === 'invalid-args') return fail(400, 'invalid-args', message)
      return fail(400, 'failed', message)
    }
  }
}

/* -------------------------------------------------------- Agent 工具挂载 */

function agentCtxGet(agent, serviceName) {
  const agentCtx = agent && agent.ctx
  if (!agentCtx) return undefined
  try {
    if (typeof agentCtx.get === 'function') return agentCtx.get(serviceName)
  } catch {
    return undefined
  }
  return agentCtx[serviceName]
}

/** 当前 Agent 是否处于「短剧模式」——由预设里隔离的 dramaMode 服务标记。 */
function dramaCapabilityOf(agent) {
  try {
    const registry = agentCtxGet(agent, 'agentPresets')
    if (!agent || !registry || typeof registry.serviceFor !== 'function') return undefined
    const capability = registry.serviceFor(agent, DRAMA_PRESET_SERVICE)
    if (!capability || typeof capability !== 'object') return undefined
    if (capability.mode !== 'drama') return undefined
    if (capability.disposed === true) return undefined
    return capability
  } catch {
    return undefined
  }
}

/** T3（P1-L）：测试用途工具只在显式环境变量开启时注册（默认关闭，生产工具面保持 34 个）。 */
export function dramaTestToolsEnabled(env = process.env) {
  return Boolean(env && env.DSH_AI_DRAMA_TEST_TOOLS === '1')
}

/**
 * T3（P1-L）：判定主 Agent / 子 Agent。
 * 优先用 agents 服务的 roots()（最权威）；取不到时退回会话头的 origin 字段。
 */
export function isMainAgent(agent) {
  const registry = agentCtxGet(agent, 'agents')
  if (registry && typeof registry.get === 'function' && typeof registry.roots === 'function') {
    try {
      return registry.get(agent.id) === agent && registry.roots().includes(agent)
    } catch {
      return false
    }
  }
  return !(agent && agent.session && agent.session.header && agent.session.header.origin === 'subagent')
}

/**
 * T3（P1-L）工具治理决策（纯函数，qa 可离线断言）：
 *   - 非短剧模式 → none（不挂载、不限制）；
 *   - 短剧模式主 Agent → register（注册全部 drama_*，测试工具视环境变量）；
 *   - 短剧模式子 Agent → restrict（不注册，并用 tools.restrict 屏蔽全部 drama_*，fail-closed）。
 */
export function dramaToolGovernanceFor(agent, env = process.env) {
  const capability = dramaCapabilityOf(agent)
  if (!capability) return { mode: 'none', reason: 'not-drama-preset', names: [], deny: [] }
  const testTools = dramaTestToolsEnabled(env)
  const names = testTools ? [...DRAMA_TOOL_NAMES, ...DRAMA_TEST_TOOL_NAMES] : [...DRAMA_TOOL_NAMES]
  if (!isMainAgent(agent)) return { mode: 'restrict', reason: 'subagent-tool-governance', names: [], deny: names }
  return { mode: 'register', reason: 'main-agent', names, deny: [] }
}

/** 从工具执行上下文里取工作区目录（短剧项目都挂在它下面）。 */
function rootOf(exec) {
  const candidates = [exec && exec.agent, exec && exec.ctx && exec.ctx.agent, exec && exec.sessionContext && exec.sessionContext.agent]
  for (const agent of candidates) {
    const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : undefined
    if (typeof cwd === 'string' && path.isAbsolute(cwd)) return cwd
  }
  throw new Error('当前会话没有有效工作范围，无法定位短剧项目（请在 DSH 工作区中打开会话）')
}

function attachAgentTools(ctx, config, host) {
  const testToolsEnabled = dramaTestToolsEnabled()
  /** 宿主服务可选读取（P2-3：llm / agentDefaultModel 均为 optional，缺失即降级）。 */
  const getService = (serviceName) => {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined
    } catch {
      return undefined
    }
  }
  const defs = createToolDefs(
    {
      rootOf,
      backendOf: (id) => (host && host.backends ? host.backends.get(id) : null),
      // P2-3（task-26）：AI 审读测试注入缝 —— 生产环境返回宿主 llm 服务；QA 可用 fake llm 直接注入 createToolDefs。
      llmOf: () => getService('llm'),
      modelSelectionOf: () => {
        const service = getService('agentDefaultModel')
        try {
          const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null
          return selection && typeof selection === 'object' ? selection : null
        } catch {
          return null
        }
      },
    },
    { testTools: testToolsEnabled },
  )
  const offsByAgent = new Map()
  const restrictByAgent = new Map()
  const restrictFailures = []
  const seenAgents = new Set()
  let agentsRef

  /** 挂载/治理异常落盘到插件包内备查（不写用户工作区；正常时不生成该文件）。 */
  const writeAttachDiagnostic = (payload) => {
    void (async () => {
      try {
        const { writeFileSync } = await import('node:fs')
        const { fileURLToPath } = await import('node:url')
        const pkgDir = path.dirname(fileURLToPath(import.meta.url))
        writeFileSync(
          path.join(pkgDir, 'drama-attach-diagnostic.json'),
          `${JSON.stringify({ time: new Date().toISOString(), testToolsEnabled, seenAgents: [...seenAgents], ...payload }, null, 2)}\n`,
          'utf8',
        )
      } catch {
        /* 诊断落盘失败不影响主流程 */
      }
    })()
  }

  /**
   * 成功挂载时清理「本 Agent」遗留的挂载失败诊断（D-10 / 0.4.2）。
   *
   * 只删 agentId 匹配的记录：插件包根目录是共享路径，粗暴删除可能抹掉其它 Agent
   * （或并发测试进程）刚写入的失败证据，导致偶发误报/丢证据。
   * @param {string} agentId 当前成功挂载的 Agent id
   */
  const clearAttachDiagnostic = (agentId) => {
    void (async () => {
      try {
        const { readFile, rm } = await import('node:fs/promises')
        const { fileURLToPath } = await import('node:url')
        const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'drama-attach-diagnostic.json')
        let existing
        try {
          existing = JSON.parse(await readFile(file, 'utf8'))
        } catch {
          return
        }
        if (existing && existing.agentId === agentId) await rm(file, { force: true })
      } catch {
        /* 清理失败不影响主流程 */
      }
    })()
  }

  function detachRegistered(agentId) {
    const offs = offsByAgent.get(agentId)
    if (!offs) return
    for (const off of offs.reverse()) {
      try {
        off()
      } catch {
        /* 忽略 */
      }
    }
    offsByAgent.delete(agentId)
  }

  function detachRestrict(agentId) {
    const off = restrictByAgent.get(agentId)
    if (!off) return
    try {
      off()
    } catch {
      /* 忽略 */
    }
    restrictByAgent.delete(agentId)
  }

  function detach(agentId) {
    detachRegistered(agentId)
    detachRestrict(agentId)
    detachContext(agentId)
  }

  /* ------------------ P1-M / T4：运行期上下文注入（状态卡） ------------------ */
  /*
   * DSH 的 systemPrompt.context() 文本可以是同步函数，而短剧状态读取是异步的：
   * 这里为每个「短剧模式主 Agent」维护一份状态快照缓存，provider 同步返回缓存文本；
   * 工具调用后（尤其写操作）异步刷新，保证「切项目后下一轮同步」「写后反馈下一轮可见」。
   */
  const contextByAgent = new Map()
  const CONTEXT_NAME = 'drama-runtime-context'
  const CONTEXT_ORDER = 250

  function agentRootOf(agent) {
    const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : undefined
    return typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : null
  }

  /** 为短剧模式主 Agent 注册 systemPrompt.context 提供器（重复调用幂等）。 */
  function ensureAgentContext(agent) {
    const existing = contextByAgent.get(agent.id)
    if (existing) return existing
    const systemPrompt = agentCtxGet(agent, 'systemPrompt')
    if (!systemPrompt || typeof systemPrompt.context !== 'function') return null
    const state = { text: '', project: '', lastWrite: null, disposer: null, registeredAt: new Date().toISOString() }
    try {
      state.disposer = systemPrompt.context({
        name: CONTEXT_NAME,
        order: CONTEXT_ORDER,
        // 同步读到最近一次快照；@see refreshAgentContext
        text: () => contextByAgent.get(agent.id)?.text || '',
      })
    } catch {
      return null
    }
    contextByAgent.set(agent.id, state)
    return state
  }

  /** 异步刷新某 Agent 的上下文快照（状态卡，≤8K 字符；失败不影响主流程）。 */
  async function refreshAgentContext(agent, titleHint) {
    const state = contextByAgent.get(agent.id)
    if (!state) return
    const root = agentRootOf(agent)
    if (!root) return
    try {
      let title = String(titleHint || state.project || '')
      if (!title) {
        const projects = await store.listProjects(root).catch(() => [])
        title = projects.length ? projects[0].title : ''
      }
      if (!title) {
        state.project = ''
        state.text = buildDramaContextCard({ lastWrite: state.lastWrite })
        return
      }
      const [progress, contract, outline, characters, memory, episodes] = await Promise.all([
        store.getProgress(root, title).catch(() => ({})),
        store.getContract(root, title).catch(() => ({})),
        store.getOutline(root, title).catch(() => []),
        store.getCharacters(root, title).catch(() => []),
        store.getMemory(root, title).catch(() => []),
        store.listEpisodes(root, title).catch(() => []),
      ])
      state.project = title
      state.text = buildDramaContextCard({ title, progress, contract, outline, characters, memory, episodes, lastWrite: state.lastWrite })
    } catch {
      /* 上下文刷新失败不影响主流程 */
    }
  }

  /** 工具执行后：记录写后反馈 / 同步当前项目（供“写后反馈”“切项目后下一轮同步”）。 */
  async function recordToolContext(agent, toolName, args, result, isWrite) {
    if (!agent || !agent.id) return
    const state = contextByAgent.get(agent.id)
    if (!state) return
    const titleHint = args && typeof args.title === 'string' ? args.title.trim() : ''
    if (isWrite && result && result.ok !== false) {
      state.lastWrite = {
        tool: toolName,
        summary: summarizeWriteFeedback(toolName, args || {}, result),
        at: new Date().toISOString(),
      }
      await refreshAgentContext(agent, titleHint || state.project)
      return
    }
    if (titleHint && titleHint !== state.project) await refreshAgentContext(agent, titleHint)
  }

  function detachContext(agentId) {
    const state = contextByAgent.get(agentId)
    if (!state) return
    try {
      state.disposer?.()
    } catch {
      /* 忽略 */
    }
    contextByAgent.delete(agentId)
  }

  function installInto(agent) {
    if (!agent || !agent.id) return
    seenAgents.add(agent.id)
    const capability = dramaCapabilityOf(agent)
    if (!capability) {
      detach(agent.id)
      return
    }
    const registry = agentCtxGet(agent, 'tools')
    if (!registry) return

    /* T3：子 Agent 一律不注册 drama_*（写工具风险），改为在其作用域 restrict 掉全部工具名（fail-closed）。 */
    if (!isMainAgent(agent)) {
      detachRegistered(agent.id)
      if (restrictByAgent.has(agent.id)) return
      const deny = dramaToolGovernanceFor(agent).deny
      if (typeof registry.restrict !== 'function') {
        const failure = { agentId: String(agent.id), reason: 'tools.restrict 不可用', deny }
        restrictFailures.push(failure)
        host.lastRestrictError = failure.reason
        ctx.logger?.warn?.(`[ai-drama] 子代理工具治理失败（${agent.id}）：${failure.reason}`)
        writeAttachDiagnostic({ agentId: String(agent.id), registered: 0, total: defs.length, restrict: { applied: false, error: failure.reason, deny } })
        return
      }
      try {
        const offRestrict = registry.restrict({ deny })
        if (typeof offRestrict === 'function') restrictByAgent.set(agent.id, offRestrict)
        ctx.logger?.info?.(`[ai-drama] 已对子代理 Agent(${agent.id}) restrict ${deny.length} 个 drama_* 工具`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        restrictFailures.push({ agentId: String(agent.id), reason: message, deny })
        host.lastRestrictError = message
        ctx.logger?.warn?.(`[ai-drama] 子代理工具治理失败（${agent.id}）：${message}`)
        writeAttachDiagnostic({ agentId: String(agent.id), registered: 0, total: defs.length, restrict: { applied: false, error: message, deny } })
      }
      return
    }

    // 主 Agent：若之前被当作子 Agent 限制过，先解除限制再注册。
    detachRestrict(agent.id)
    if (offsByAgent.has(agent.id)) return
    if (typeof registry.register !== 'function') return

    const offs = []
    const failures = []
    // DSH 的 ToolDefinition 要求 output（schema + render）；lib/tools.js 的工具定义没有这一项，
    // 缺了它 registry.register() 会抛错，而挂载发生在 emit 事件里、错误会被调度吞掉 ——
    // 表现就是「短剧模式里技能可见、drama_* 工具却一个都不挂」（2026-10-17 定位）。
    /** 只读类工具：允许同一步内并行执行（DSH 对没有分类器的工具默认 exclusive）。 */
    const PARALLEL_SAFE = new Set([
      'drama_list_projects',
      'drama_get_project',
      'drama_get_progress',
      'drama_list_drafts',
      'drama_list_assets',
      'drama_list_finalized',
      'drama_get_ledger',
      'drama_get_dialogue',
      'drama_read_episode',
      'drama_search_context',
      'drama_canvas_status',
    ])

    /** 字段中文标签（只影响显示，不影响返回值）。 */
    const FIELD_LABELS = {
      ok: '结果', path: '路径', file: '文件', title: '项目', name: '名称', project: '项目',
      episode: '集数', episodeNo: '集数', count: '数量', total: '总数', items: '条目',
      entries: '条目', error: '错误', code: '代码', reason: '原因', message: '说明',
      warning: '提示', warnings: '提示', status: '状态', stage: '阶段', budget: '预算',
      backend: '后端', taskId: '任务', tasks: '任务列表', createdAt: '创建时间', updatedAt: '更新时间',
    }

    /** 把工具返回值渲染成人可读的中文摘要（而不是整坨 JSON）。 */
    const renderValue = (value, depth = 0) => {
      if (value === null || value === undefined) return '（空）'
      if (typeof value === 'string') return value.length > 1200 ? `${value.slice(0, 1200)}…` : value
      if (typeof value !== 'object') return String(value)
      if (Array.isArray(value)) {
        if (value.length === 0) return '（空列表）'
        const shown = value
          .slice(0, 10)
          .map((item) => `· ${typeof item === 'object' && item !== null ? renderValue(item, depth + 1) : String(item)}`)
        return shown.join('\n') + (value.length > 10 ? `\n…共 ${value.length} 项` : '')
      }
      const lines = []
      for (const [key, raw] of Object.entries(value)) {
        if (raw === undefined) continue
        const label = FIELD_LABELS[key] ?? key
        const rendered =
          typeof raw === 'object' && raw !== null
            ? depth >= 2
              ? JSON.stringify(raw)
              : renderValue(raw, depth + 1)
            : renderValue(raw, depth + 1)
        lines.push(`${label}：${rendered}`)
      }
      return lines.length ? lines.join('\n') : '（空）'
    }

    const outputFor = (tool) => {
      if (tool && tool.output) return tool.output
      return {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          let text
          try {
            text = renderValue(value)
          } catch {
            text = String(value)
          }
          text = String(text ?? '')
          if (text.length > 6000) text = `${text.slice(0, 6000)}\n…（已截断）`
          return [{ type: 'text', text }]
        },
      }
    }

    /** P1-K / T2：写工具 → 事务目标文件（项目锁 + 审计）；只读/无副作用工具不包事务。 */
    const WRITE_TOOL_TARGETS = {
      drama_save_contract: () => ['剧集契约.md', '.aidrama/contract.json'],
      drama_save_outline: () => ['总纲/分集大纲.md', '.aidrama/outline.json'],
      drama_save_characters: () => ['人物/人物设定卡.md', '.aidrama/characters.json'],
      drama_save_memory: () => ['本剧记忆/本剧记忆.md', '.aidrama/memory.json'],
      drama_save_world: () => ['世界观/世界观.md', '.aidrama/world.json'],
      drama_save_draft: () => ['.aidrama/drafts'],
      drama_resolve_draft: () => ['.aidrama/drafts'],
      drama_finalize_episode: () => ['定稿/定稿记录.md', '.aidrama/finalized.json'],
      drama_import_script: (args) => (args && args.action === 'apply' ? ['分集剧本'] : null),
      drama_add_asset: () => ['.aidrama/assets.json', '素材/素材清单.md'],
      drama_budget: (args) => (args && args.action === 'set' ? ['.aidrama/budget.json', '账本/消耗台账.md'] : null),
      drama_plan_generation: () => ['.aidrama/tasks.json'],
      drama_record_generation: () => ['.aidrama/tasks.json', '.aidrama/budget.json'],
      drama_plan_batch: () => ['.aidrama/tasks.json'],
      drama_submit_batch: () => ['.aidrama/tasks.json'],
      drama_collect_batch: () => ['.aidrama/tasks.json', '.aidrama/budget.json'],
      drama_intake_artifact: () => ['.aidrama/assets.json', '.aidrama/tasks.json'],
      drama_bind_canvas: () => ['.libtv/project.json', '.neowow/project.json'],
    }

    /** 写工具统一包项目事务；事务层错误归一到 P1-A 失败契约（不让错误落进事件调度）。
     *  同时（P1-M/T4）在工具执行后刷新上下文缓存：写操作 → 写后反馈；带 title 的读操作 → 同步当前项目。 */
    const wrapToolExecute = (tool) => {
      const targetFn = WRITE_TOOL_TARGETS[tool.name]
      const isWrite = typeof targetFn === 'function'
      const withContext = async (args, exec, result) => {
        try {
          await recordToolContext(exec && exec.agent, tool.name, args, result, isWrite)
        } catch {
          /* 上下文记录失败不影响工具结果 */
        }
        return result
      }
      if (!isWrite) {
        return async (args, exec) => {
          const result = await tool.execute(args, exec)
          return withContext(args, exec, result)
        }
      }
      return async (args, exec) => {
        const run = async () => {
          const result = await tool.execute(args, exec)
          return withContext(args, exec, result)
        }
        try {
          const root = rootOf(exec)
          let title = args && typeof args.title === 'string' ? args.title.trim() : ''
          if (!title) {
            const projects = await store.listProjects(root).catch(() => [])
            title = projects.length === 1 ? projects[0].title : ''
          }
          const targets = targetFn(args || {})
          if (!title || !targets) return run()
          const actor = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : 'agent'
          return await txn.runProjectTxn(root, title, { action: tool.name, actor, targets }, run)
        } catch (error) {
          if (error && error.code === 'conflict') {
            return { ok: false, code: 'conflict', reason: error.message, next: typeof error.next === 'string' ? error.next : '' }
          }
          return { ok: false, ...classifyToolFailure(error) }
        }
      }
    }

    for (const tool of defs) {
      try {
        const definition = {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          output: outputFor(tool),
          execute: wrapToolExecute(tool),
        }
        // P2-3：deep 审读/保存报告会跑模型或写盘（长耗时/副作用），不得并行；默认（只读检查）行为不变。
        if (PARALLEL_SAFE.has(tool.name)) {
          definition.isConcurrencySafe =
            tool.name === 'drama_check_consistency'
              ? (args) => !(args && (args.deep === true || args.saveReview))
              : () => true
        }
        const off = registry.register(definition)
        if (typeof off === 'function') offs.push(off)
      } catch (error) {
        failures.push(`${tool.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    host.lastAttachError = failures.length ? failures.join(' | ') : null
    if (offs.length === 0) {
      ctx.logger?.warn?.(`[ai-drama] drama_* 工具挂载失败（0/${defs.length}）：${host.lastAttachError || '未知原因'}`)
      // 挂载发生在事件回调里，宿主日志读不到；总失败时把原因落到插件包内备查（不写用户工作区）。
      writeAttachDiagnostic({ agentId: String(agent.id), registered: 0, total: defs.length, failures })
      return
    }
    // D-10（0.4.2）：partial 失败也必须可见 —— 此前只有 0/34 全失败才落诊断，
    // 导致「2 个工具 schema 非法被逐工具 catch 吞掉、工具面静默 32/34」潜伏到真机才发现。
    if (failures.length > 0) {
      ctx.logger?.warn?.(`[ai-drama] drama_* 工具部分挂载失败（${offs.length}/${defs.length}）：${host.lastAttachError}`)
      writeAttachDiagnostic({ agentId: String(agent.id), registered: offs.length, total: defs.length, failures })
    } else {
      clearAttachDiagnostic(String(agent.id))
    }
    offsByAgent.set(agent.id, offs)
    ctx.logger?.info?.(`[ai-drama] 已为短剧模式 Agent(${agent.id}) 注册 ${offs.length}/${defs.length} 个 drama_* 工具${host.lastAttachError ? `（部分失败：${host.lastAttachError}）` : ''}`)
    // P1-M / T4：注册「短剧上下文」注入，并按当前项目预热快照（下一轮 prompt 即可见）。
    if (ensureAgentContext(agent)) void refreshAgentContext(agent)
  }

  function scan() {
    const agents = agentsRef
    if (!agents || typeof agents.list !== 'function') return
    let list = []
    try {
      list = agents.list() || []
    } catch {
      list = []
    }
    for (const agent of list) installInto(agent)
  }

  ctx.inject(['agents'], (scope) => {
    agentsRef = scope.agents || safeGet(scope, 'agents')
    scan()
    scope.on?.('agent-preset/selected', () => scan())
    scope.on?.('agent/created', () => scan())
    scope.effect?.(() => () => {
      for (const id of [...offsByAgent.keys()]) detachRegistered(id)
      for (const id of [...restrictByAgent.keys()]) detachRestrict(id)
      for (const id of [...contextByAgent.keys()]) detachContext(id)
    })
    ctx.logger?.info?.('[ai-drama] 已接入 agents，开始按「短剧模式」预设挂载 drama_* 工具（子 Agent restrict）')
  })

  return {
    refresh: scan,
    diagnostics: () => ({
      available: Boolean(agentsRef),
      toolCount: defs.length,
      productionToolCount: DRAMA_TOOL_NAMES.length,
      testToolsEnabled,
      testToolNames: testToolsEnabled ? [...DRAMA_TEST_TOOL_NAMES] : [],
      attachedAgents: [...offsByAgent.keys()],
      restrictedAgents: [...restrictByAgent.keys()],
      contextAgents: [...contextByAgent.keys()],
      restrictFailures: restrictFailures.slice(-20),
      seenAgents: [...seenAgents],
    }),
  }
}

/* ---------------------------------------------------------------- 斜杠命令 */

const GENERATIVE = {
  大纲: '分集大纲（每集：标题 / 一句话梗概 / 开场钩子 / 中段反转 / 结尾悬念 / 预计时长）',
  人物: '人物设定卡（姓名 / 身份 / 性格关键词 / 小传 / 形象提示词 / 音色）',
  世界观: '世界观设定（地点 / 组织 / 规则 / 道具 / 时间线）',
  剧本: '指定集数的场次化剧本',
  分镜: '指定集数的分镜表（镜号 / 景别 / 运镜 / 画面 / 台词 / 音效 / 时长 / 提示词）',
  润色: '选中范围的台词润色（只改表达，不改剧情）',
}

const USAGE = [
  '/drama —— 显示用法与当前进度',
  '/drama 项目 —— 列出短剧项目',
  '/drama 进度 [剧名] —— 创作进度与关键事实',
  '/drama 检查 [剧名] —— 运行一致性检查',
  '/drama 草稿 [剧名] —— 列出待处理草稿',
  '/drama 导出 <markdown|json|csv> [剧名] —— 导出交付物',
  '/drama 定稿 <集数> [剧名] —— 定稿某一集',
  '/drama 大纲|人物|世界观|剧本|分镜|润色 [要求] —— 交给 Agent 生成（会产生一次模型回复）',
].join('\n')

/** 按项目名解析目标项目：显式优先，否则在只有一个项目时自动选中。 */
async function pickProject(root, name) {
  const wanted = String(name || '').trim()
  const projects = await store.listProjects(root)
  if (wanted) {
    const hit = projects.find((p) => p.title === wanted)
    if (!hit) throw new Error(`找不到短剧《${wanted}》（现有：${projects.map((p) => p.title).join('、') || '无'}）`)
    return hit.title
  }
  if (projects.length === 1) return projects[0].title
  if (!projects.length) throw new Error('当前工作区还没有短剧项目，先执行 /drama 项目 查看，或在面板中新建')
  throw new Error(`当前工作区有 ${projects.length} 个短剧，请写明剧名：${projects.map((p) => p.title).join('、')}`)
}

async function enqueuePrompt(agent, text) {
  let message
  try {
    const llm = await import('@deepseek-ai/dsh-llm')
    message = llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  } catch {
    message = { content: [{ type: 'text', text }], source: { kind: 'user' } }
  }
  agent.followup(message)
}

async function runDramaCommand(invocation, resolveRoot) {
  const agent = invocation && invocation.agent
  const raw = String((invocation && invocation.rawInput) || '').trim()
  const tokens = raw ? raw.split(/\s+/) : []
  const sub = tokens[0] || ''
  const rest = tokens.slice(1)

  // FR-D08：命令只对处于「短剧模式」的会话生效
  if (!agent || !dramaCapabilityOf(agent)) {
    return { kind: 'error', text: '「短剧模式」未启用。请在会话的预设选择器切到「短剧模式」后再使用 /drama。' }
  }

  let root
  try {
    root = resolveRoot(agent)
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : '当前会话没有有效工作范围' }
  }

  try {
    if (!sub) {
      const projects = await store.listProjects(root)
      const lines = [USAGE, '']
      if (projects.length) {
        const title = await pickProject(root, '').catch(() => null)
        lines.push(`当前工作区有 ${projects.length} 个短剧：${projects.map((p) => p.title).join('、')}`)
        if (title) {
          const progress = await store.getProgress(root, title)
          const label = (progress.steps.find((s) => s.key === progress.stage) || {}).label || progress.stage
          lines.push(`《${title}》进度：${label}（大纲 ${progress.facts.outlineCount} / 人物 ${progress.facts.characterCount} / 剧本 ${progress.facts.episodeCount} / 分镜 ${progress.facts.storyboardCount}）`)
        }
      } else {
        lines.push('当前工作区还没有短剧项目。')
      }
      return { kind: 'success', text: lines.join('\n') }
    }

    if (sub === '项目') {
      const projects = await store.listProjects(root)
      if (!projects.length) return { kind: 'success', text: '还没有短剧项目。' }
      return {
        kind: 'success',
        text: projects.map((p) => `· ${p.title} —— 分集剧本 ${p.episodeCount} 集`).join('\n'),
      }
    }

    if (sub === '进度') {
      const title = await pickProject(root, rest.join(' '))
      const progress = await store.getProgress(root, title)
      const steps = progress.steps.map((s) => `${s.done ? '✓' : '·'} ${s.label}`).join('  ')
      const f = progress.facts
      return {
        kind: 'success',
        text: [
          `《${title}》`,
          steps,
          `大纲 ${f.outlineCount} · 人物 ${f.characterCount} · 剧本 ${f.episodeCount} · 分镜 ${f.storyboardCount} · 记忆 ${f.memoryCount}（未回收 ${f.openMemoryCount}） · 导出 ${f.exportCount}`,
        ].join('\n'),
      }
    }

    if (sub === '检查') {
      const title = await pickProject(root, rest.join(' '))
      const report = await checkConsistency(root, title)
      if (!report.issues.length) return { kind: 'success', text: `《${title}》未发现问题。` }
      const head = report.issues.slice(0, 8).map((i) => `· [${i.severity}] ${i.message}`)
      if (report.issues.length > 8) head.push(`… 另有 ${report.issues.length - 8} 项`)
      return {
        kind: 'success',
        text: [`《${title}》：error ${report.summary.error} / warn ${report.summary.warn} / info ${report.summary.info}`, ...head].join('\n'),
      }
    }

    if (sub === '草稿') {
      const title = await pickProject(root, rest.join(' '))
      const list = await drafts.listDrafts(store.projectDir(root, title))
      if (!list.length) return { kind: 'success', text: `《${title}》草稿区为空。` }
      return {
        kind: 'success',
        text: [`《${title}》待处理草稿 ${list.length} 条：`, ...list.slice(0, 10).map((d) => `· [${d.kind}${d.order ? ' 第' + d.order + '集' : ''}] ${d.title || d.note || d.id}`)].join('\n'),
      }
    }

    if (sub === '导出') {
      const format = rest[0]
      if (!EXPORT_FORMATS.includes(format)) {
        return { kind: 'error', text: `用法：/drama 导出 <${EXPORT_FORMATS.join('|')}> [剧名]` }
      }
      const title = await pickProject(root, rest.slice(1).join(' '))
      const result = await exportProject(root, title, format)
      return { kind: 'success', text: `已导出 ${format}：${path.relative(root, result.file)}（${result.bytes} 字节）` }
    }

    if (sub === '定稿') {
      const order = Number(rest[0])
      if (!Number.isFinite(order) || order < 1) return { kind: 'error', text: '用法：/drama 定稿 <集数> [剧名]' }
      const title = await pickProject(root, rest.slice(1).join(' '))
      const result = await store.finalizeEpisode(root, title, order)
      return { kind: 'success', text: `《${title}》第 ${result.order} 集已定稿 v${result.version}（镜头 ${result.shots} 个）` }
    }

    if (GENERATIVE[sub]) {
      const title = await pickProject(root, rest[0] && !GENERATIVE[sub] ? rest[0] : '').catch(() => null)
      const ask = rest.join(' ')
      const text = [
        `请用「短剧模式」的 ${sub} 能力工作。`,
        title ? `目标短剧：《${title}》。` : '',
        `需要产出：${GENERATIVE[sub]}。`,
        ask ? `补充要求：${ask}` : '',
        '生成结果请先用 drama_save_draft 写入草稿区，再由我在面板中采纳；交付前用 drama_check_consistency 自检并把问题清单一并报给我。',
      ].filter(Boolean).join('\n')
      await enqueuePrompt(agent, text)
      return { kind: 'success', text: `已把「${sub}」请求交给 Agent${title ? `（《${title}》）` : ''}，稍候查看草稿区。` }
    }

    return { kind: 'error', text: `未知子命令「${sub}」。\n\n${USAGE}` }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : '短剧命令执行失败' }
  }
}

function attachCommands(ctx, host) {
  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'drama',
      description: 'AI 短剧工作区：项目 / 进度 / 检查 / 草稿 / 导出 / 定稿，以及交给 Agent 生成',
      input: { hint: '[项目|进度|检查|草稿|导出|定稿|大纲|人物|世界观|剧本|分镜|润色]' },
      handler: (invocation) => runDramaCommand(invocation, (agent) => rootOf({ agent })),
    })
    host.commandRegistered = true
    ctx.logger?.info?.('[ai-drama] 已注册斜杠命令 /drama')
  })
}

/* ------------------------------------------------------------ 预设注册表探针 */

/** 诊断用：读出 agentPresets 注册表当前认识的 preset，确认「短剧模式」是否登记成功。 */
function attachPresetProbe(ctx, host) {
  ctx.inject(['agentPresets'], (scope) => {
    const registry = scope.agentPresets || safeGet(scope, 'agentPresets')
    if (!registry) return
    host.presetProbe = () => {
      const out = { methods: [], ids: [], error: null, pending: false }
      for (const method of ['list', 'remoteExportList']) {
        if (typeof registry[method] !== 'function') continue
        out.methods.push(method)
        if (out.pending) continue
        try {
          const value = registry[method]()
          // list() 是异步的：同步拿到的只是 Promise，必须 await 后再读
          if (value && typeof value.then === 'function') {
            out.pending = true
            value
              .then((rows) => {
                const arr = Array.isArray(rows) ? rows : (rows && rows.presets) || []
                host.presetIds = arr.map((r) => (typeof r === 'string' ? r : r && r.id)).filter(Boolean)
                host.presetBroken = arr.filter((r) => r && (r.error || r.diagnostic || r.broken)).map((r) => r.id)
              })
              .catch((error) => {
                host.presetError = error instanceof Error ? error.message : String(error)
              })
          } else if (Array.isArray(value)) {
            out.ids = value.map((r) => (typeof r === 'string' ? r : r && r.id)).filter(Boolean)
          }
        } catch (error) {
          out.error = `${method}: ${error instanceof Error ? error.message : error}`
        }
      }
      if (host.presetIds) out.ids = host.presetIds
      if (host.presetBroken && host.presetBroken.length) out.broken = host.presetBroken
      if (host.presetError) out.error = host.presetError
      return out
    }
    ctx.logger?.info?.('[ai-drama] 预设注册表探针已就绪')
  })
}

/* ------------------------------------------------------------------ 装配 */

export function apply(ctx, config = {}) {
  const host = {
    refreshCount: 0,
    commandRegistered: false,
    backends: createBackendRegistry(config.backends || {}),
    refresh: () => {
      host.refreshCount += 1
    },
    diagnostics: () => ({
      available: false,
      toolCount: DRAMA_TOOL_NAMES.length,
      attachedAgents: [],
      seenAgents: [],
      refreshCount: host.refreshCount,
      command: { name: 'drama', registered: host.commandRegistered },
      presetProbe: host.presetProbe ? host.presetProbe() : null,
    }),
  }
  ctx.provide('aiDramaHost', host)

  ctx.inject(['connection'], (scope) => {
    const handler = createHandler(scope, config, ctx)
    for (const method of METHODS) {
      scope.connection.fetch.register({
        path: API_PATH + method,
        methods: ['POST'],
        requestBody: 'streaming',
        fetch: handler,
      })
    }
    ctx.logger?.info?.(`[ai-drama] 已注册 ${METHODS.length} 条路由：${API_PATH}<method>`)
  })

  try {
    const api = attachAgentTools(ctx, config, host)
    host.refresh = () => {
      host.refreshCount += 1
      api.refresh()
    }
    host.diagnostics = () => ({ ...api.diagnostics(), refreshCount: host.refreshCount, command: { name: 'drama', registered: host.commandRegistered }, presetProbe: host.presetProbe ? host.presetProbe() : null })
  } catch (error) {
    ctx.logger?.warn?.(`[ai-drama] Agent 工具挂载失败：${error instanceof Error ? error.message : error}`)
  }

  try {
    attachCommands(ctx, host)
  } catch (error) {
    ctx.logger?.warn?.(`[ai-drama] 斜杠命令注册失败：${error instanceof Error ? error.message : error}`)
  }

  try {
    attachPresetProbe(ctx, host)
  } catch (error) {
    ctx.logger?.warn?.(`[ai-drama] 预设探针挂载失败：${error instanceof Error ? error.message : error}`)
  }
}

export { METHODS, VERSION }
