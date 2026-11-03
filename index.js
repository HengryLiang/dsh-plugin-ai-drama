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
import { fileURLToPath } from 'node:url'

import * as store from './lib/store.js'
import { buildBundledSkillInventory } from './lib/skill-managed.js'
import { assertSafeRelPath } from './lib/names.js'
import * as drafts from './lib/drafts.js'
import { checkConsistency } from './lib/consistency.js'
import { searchContext } from './lib/retrieval.js'
import { EXPORT_FORMATS, exportProject, isExportFormat } from './lib/exporter.js'
import { listBackups, previewRestore, restoreBackup } from './lib/backup.js'
import { createToolDefs, classifyToolFailure, DRAMA_TEST_TOOL_NAMES, DRAMA_TOOL_NAMES } from './lib/tools.js'
import * as txn from './lib/txn.js'
import { buildDramaContextCard, summarizeWriteFeedback } from './lib/context-card.js'
import { resolveCurrentProject } from './lib/context-project.js'
import { listDataSources } from './lib/sources.js'
import * as flowState from './lib/flow-state.js'
import * as styleDna from './lib/style-dna.js'
import * as styleInjection from './lib/style-injection.js'
import * as assetReview from './lib/assets.js'
import * as assetExtract from './lib/asset-extract.js'
import * as assetMigration from './lib/asset-migration.js'
import * as assetMedia from './lib/asset-media.js'
import * as assetGenerate from './lib/asset-generate.js'
import { createAssetGenerationScheduler } from './lib/asset-scheduler.js'
import * as audit from './lib/audit.js'
import { createBackendRegistry } from './lib/backends/index.js'
import * as generation from './lib/generation.js'
import * as orchestrator from './lib/orchestrator.js'
import * as guard from './lib/guard.js'
import * as importBridge from './lib/import-bridge.js'
import * as media from './lib/media.js'
import * as audioBindings from './lib/audio-bindings.js'
import * as importAssets from './lib/import-assets.js'

export const name = 'ai-drama'

/** 需要 `connection` 服务（Fetch 路由注册表）存在后才注册路由。 */
export const inject = ['connection']

/**
 * v0.16.156：apply() 内的运行期上下文刷新桥。
 * dispatch() 为模块级函数，settings-save 路由通过此桥刷新对应 Agent 的 context 卡（不新增 API）。
 */
let runtimeContextBridge = null

/** 只判断桥中是否有该 Agent 的 context 状态（不触碰 systemPrompt）。 */
function contextByAgentHas(bridge, agent) {
  return Boolean(bridge && bridge.contextByAgent && agent && agent.id && typeof bridge.contextByAgent.has === 'function' && bridge.contextByAgent.has(agent.id))
}

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
/** v0.16.63（D-0034 残留）：host 兜底 inventory 扫描插件自带 skills/。 */
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = path.join(PLUGIN_DIR, 'skills')

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
  'style-save',
  'dialogue-get',
  'voice-script-export',
  'assets-get',
  'assets-add',
  'assets-remove',
  'asset-save',
  'asset-extract',
  // v0.16.24（Phase1 / H-11）：角色卡对标音色手动绑定写入口（METHODS 73→74）
  'asset-audio-save',
  // RC-26（v0.16.132，Lead 批准）：旧项目资产卡图片自动迁移（METHODS 77→78；read 方法不自动写）
  'asset-cards-migrate',
  // RC-30（v0.16.136，Lead 批准方案 A）：宿主直连画布单资产生图（METHODS 78→79；工具面不变）
  'asset-generate',
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
  // v0.16.38（M8 阶段2，用户批准 METHODS 74→75）：备份恢复 apply；不注册 Agent 工具。
  'backup-restore',
  'agents-status',
  // v0.15.1（task-110，H 契约，Lead 批准）：本地图片只读通道；68→69，工具面仍 34。
  'media-read',
  // v0.16.96（D-0042，Lead 批准 A 方案）：站位图上传（add-only）；METHODS 76→77，工具面仍 35。
  'media-upload',
  // v0.15.11（task-134 / IMP-H，E13，Lead 批准）：一键导入素材；69→70，工具面仍 34。
  'assets-import',
  // v0.16.59（Skill 管理 P0 / H-12r1，Lead 批准）：只读内置技能清单；METHODS 75→76，工具面仍 35。
  'skills-inventory',
]

/* ------------------------------------------------------------------ 工具 */

/** 项目内文件的「格式化集数」文件名片段：第001集。 */
function episodeStem(order) {
  const n = Math.round(Number(order))
  return Number.isFinite(n) && n > 0 ? `第${String(n).padStart(3, '0')}集` : '第000集'
}

/** R-24（v0.16.35）：assets-get add-only 分页/projection 白名单版本与纯函数。 */
const R24_PROJECTION_WHITELIST_VERSION = 1
const R24_ASSET_FIELDS = Object.freeze([
  'id', 'name', 'kind', 'source', 'bytes', 'mtime', 'sha256', 'note', 'linkedShots', 'addedAt',
  'assetCategory', 'origin', 'backend', 'model', 'sourceUrl', 'taskId', 'episode', 'downloadedAt', 'importedFrom',
])
const R24_CARD_FIELDS = Object.freeze([
  'id', 'type', 'name', 'variantOf', 'aliases', 'status', 'version', 'fields', 'relations', 'prompts',
  'media', 'history', 'review', 'importedFrom', 'extractedFrom',
])

/** 解析并严格校验 assets-get 的 R-24 add-only 参数；无分页/projection 时 active=false。 */
function normalizeAssetsGetPage(input) {
  let collection = 'assets'
  if (Object.hasOwn(input, 'collection')) {
    if (input.collection !== 'assets' && input.collection !== 'cards') {
      throw new Error('collection 必须是 assets 或 cards')
    }
    collection = input.collection
  }
  const hasLimit = Object.hasOwn(input, 'limit')
  const hasOffset = Object.hasOwn(input, 'offset')
  const hasPage = hasLimit || hasOffset
  const hasFields = Object.hasOwn(input, 'fields')
  const hasOmit = Object.hasOwn(input, 'omit')
  const hasProjection = hasFields || hasOmit
  if (!hasPage && !hasProjection) return { active: false, collection, hasPage: false, projection: null }
  if (hasFields && hasOmit) throw new Error('fields 与 omit 不能同时提供')
  const limit = hasPage ? (hasLimit ? input.limit : 50) : null
  const offset = hasPage ? (hasOffset ? input.offset : 0) : 0
  if (hasPage) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit 必须是 1..1000 的整数')
    if (!Number.isInteger(offset) || offset < 0 || offset > 10_000_000) throw new Error('offset 必须是 0..10000000 的整数')
  }
  const allowed = collection === 'cards' ? R24_CARD_FIELDS : R24_ASSET_FIELDS
  const allowedSet = new Set(allowed)
  const normalizeFields = (value, label) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error(`${label} 必须是 1..32 项的字符串数组`)
    const seen = new Set()
    const out = []
    for (const field of value) {
      if (typeof field !== 'string' || !field || !allowedSet.has(field)) throw new Error(`${label} 含未知字段：${String(field)}`)
      if (seen.has(field)) continue
      seen.add(field)
      out.push(field)
    }
    return out
  }
  const projection = hasProjection
    ? (hasFields ? { mode: 'fields', fields: normalizeFields(input.fields, 'fields') } : { mode: 'omit', fields: normalizeFields(input.omit, 'omit') })
    : null
  return { active: true, collection, hasPage, limit, offset, projection }
}

function projectR24Entries(entries, projection) {
  if (!projection || !Array.isArray(entries)) return entries
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
    if (projection.mode === 'fields') {
      const out = {}
      for (const field of projection.fields) if (Object.hasOwn(entry, field)) out[field] = entry[field]
      return out
    }
    const omit = new Set(projection.fields)
    const out = {}
    for (const key of Object.keys(entry)) if (!omit.has(key)) out[key] = entry[key]
    return out
  })
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
    // v0.16.39（task-233）：groupIdEdits 也写 groups sidecar（双向同步）。
    ...((input.groups !== undefined || input.groupIdEdits !== undefined) ? [`.aidrama/storyboard-groups/${episodeStem(input.order)}.md.json`] : []),
  ],
  'memory-save': () => ['本剧记忆/本剧记忆.md', '.aidrama/memory.json'],
  'world-save': () => ['世界观/世界观.md', '.aidrama/world.json'],
  // C2（E15/H-7）：视觉圣经定向/冻结写入口；目标固定 style.json，复用项目事务（锁/审计/operationId 幂等）
  'style-save': () => ['.aidrama/style.json'],
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
  // v0.16.20（C1）：分类写同步渲染 素材/素材清单.md → 目标与登记一致（txn/审计 targets 含 md、前后 hash）。
  'assets-add': () => ['.aidrama/assets.json', '素材/素材清单.md'],
  'assets-remove': () => ['.aidrama/assets.json', '素材/素材清单.md'],
  // C3（E16/H-8）：资产/场景卡审核写入口；按 kind 只写目标文件，双文件静态登记（审计前后 hash）
  'asset-save': () => ['.aidrama/assets/cards.json', '.aidrama/scenes/cards.json'],
  // C4a（E16/H-8 A）：资产剥离 apply 只写 assets/cards.json；preview 只读不进事务
  'asset-extract': (input) => (input && input.mode === 'apply' ? ['.aidrama/assets/cards.json'] : null),
  // v0.16.24（Phase1 / H-11）：对标音色绑定 sidecar（只写新文件；旧数据零写回）
  'asset-audio-save': () => ['.aidrama/assets/voice-bindings.json'],
  // v0.15.11（task-134 / IMP-H）：一键导入写素材文件 + 登记；包项目事务与审计。
  // v0.16.8（task-151 / I5-1）：source 模式卡片/场景/风格目标文件按入参条件加入同一事务（锁+审计）。
  'assets-import': (input) => {
    // v0.16.13（M1-a-H）：导入历史纳入同一项目事务（锁/审计覆盖）。
    // v0.16.15（M1-b-H）：模板保存/删除只写模板文件；审计/锁覆盖该目标。
    // v0.16.29（TPL-H / M6）：模板配方包导入只写模板文件（全有或全无单次写；txn/锁/审计覆盖）。
    if (input && input.templatePackBase64 !== undefined) {
      return ['.aidrama/import-templates.json']
    }
    if (input && (input.saveTemplate !== undefined || input.deleteTemplate !== undefined || input.overwriteTemplate !== undefined)) {
      return ['.aidrama/import-templates.json']
    }
    const targets = ['.aidrama/assets.json', '素材/素材清单.md', '.aidrama/import-history.json']
    if (input && input.sourceCardIds !== undefined) targets.push('.aidrama/assets/cards.json')
    if (input && input.sourceSceneIds !== undefined) targets.push('.aidrama/scenes/cards.json')
    if (input && input.copyStyleDNA === true) targets.push('.aidrama/style.json')
    return targets
  },
  // v0.16.1（task-138 / C-6）：产物回流写素材文件 + 登记/任务；包项目事务与审计（锁+审计）。
  'intake-artifact': () => ['.aidrama/assets.json', '素材/素材清单.md', '.aidrama/tasks.json'],
  // v0.16.96（D-0042）：站位图上传目标（audit/lock；精确路径按 episode/shotKey/filename 推导）
  'media-upload': (input) => {
    // RC-29（v0.16.135 add-only）：资产图接受 → 目标文件名/去重由 route 内部 runProjectTxn 动态决定。
    if (input && input.purpose === 'asset') return null
    // RC-24（v0.16.121 add-only）：项目封面 → 固定 素材/封面/cover.<ext>（移除时列出全部候选变体）。
    if (input && input.purpose === 'cover') {
      return ['素材/封面/cover.png', '素材/封面/cover.jpg', '素材/封面/cover.jpeg', '素材/封面/cover.webp']
    }
    const episode = Number(input && (input.episode ?? input.order))
    if (!Number.isInteger(episode) || episode < 1 || episode > 9999) return null
    const rawKey = String((input && (input.shotKey ?? input.shotNumber ?? input.shotId)) || '').trim()
    const match = /(\d+)\s*$/u.exec(rawKey)
    if (!match) return null
    const shot = Number(match[1])
    if (!Number.isSafeInteger(shot) || shot < 1) return null
    const filename = String((input && input.filename) || '')
    const filenameExt = path.extname(filename).toLowerCase()
    const ext = ['.png', '.jpg', '.jpeg', '.webp'].includes(filenameExt)
      ? filenameExt
      : (input && input.mime === 'image/png' ? '.png' : input && input.mime === 'image/jpeg' ? '.jpg' : input && input.mime === 'image/webp' ? '.webp' : '.png')
    return [`素材/站位图/${episodeStem(episode)}/EP${episode}-Shot${shot}${ext}`]
  },
  'budget-set': () => ['.aidrama/budget.json', '账本/消耗台账.md'],
  // RC-26（v0.16.132 add-only）：配音稿导出迁到 导出/（单集可精确给出 target；全量导出动态文件由 store 内部 guard 写）。
  'voice-script-export': (input) => {
    const order = Number(input && input.order)
    if (!Number.isInteger(order) || order < 1 || order > 9999) return null
    return [`导出/配音稿-第${String(order).padStart(3, '0')}集.md`]
  },
  // v0.16.10（task-157 / M2）：账本默认纯读；仅在 renderFile:true 时显式写文件并进入事务/审计。
  'ledger-get': (input) => (input && input.renderFile === true ? ['账本/账本.md'] : null),
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
  // v0.16.38（M8 阶段2）：恢复 targets 依赖 manifest，route 内部 runProjectTxn 动态传入；不包外层事务。
  'backup-restore': () => null,
  // RC-26（v0.16.132）：资产卡图片迁移 targets 依赖扫描计划，route 内部 runProjectTxn 动态传入。
  'asset-cards-migrate': () => null,
  // RC-30（v0.16.136）：submit 写任务 sidecar；status 只读；collect 目标文件动态由 route 内部事务传入。
  'asset-generate': (input) => (input && String(input.action || 'submit') === 'submit' ? ['.aidrama/asset-generation.json'] : null),
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

/** v0.15.11（task-134 / IMP-H）：assets-import 请求体上限 70MB（50MB 文件 base64 约 66.7M 字符 + JSON 余量）。 */
const IMPORT_REQUEST_MAX_BYTES = 70 * 1024 * 1024
/** v0.16.96（D-0042）：media-upload 请求体上限 12MB（8MB 图片 base64 约 10.7M 字符 + JSON 余量）。 */
const MEDIA_UPLOAD_REQUEST_MAX_BYTES = 12 * 1024 * 1024

function requestTooLargeError() {
  const error = new Error('请求体过大（上限约 70MB）')
  error.code = 'too-large'
  return error
}

/** 受限读取：Content-Length 预检 + 流式累计上限（仅 assets-import 使用；其它方法保持原路径）。 */
async function readTextCapped(request, maxBytes) {
  const lengthHeader = request.headers.get('content-length')
  if (lengthHeader && Number(lengthHeader) > maxBytes) throw requestTooLargeError()
  if (request.body) {
    const reader = request.body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value ? value.byteLength : 0
      if (total > maxBytes) {
        try { await reader.cancel() } catch { /* ignore */ }
        throw requestTooLargeError()
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw requestTooLargeError()
  return text
}

async function readRequest(request, options = {}) {
  const text = options && options.maxBytes ? await readTextCapped(request, options.maxBytes) : await request.text()
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
      // P2-7（v0.7.1）：批量生成产物草稿采纳 —— 图片/音频等拷入 素材/生成；video 由 intakeArtifact 落 素材/视频/S01-EP<集>。
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

async function dispatch(method, input, root, scope, context = {}) {
  switch (method) {
    case 'ping':
      return { ok: true, name, version: VERSION, contentWriteSupported: true }

    case 'status': {
      const base = store.projectsBase(root)
      const exists = await store.isDirectory(base)
      const projects = exists ? await store.listProjects(root) : []
      // RC-24（v0.16.121 add-only）：封面能力标记（旧客户端忽略）。
      // RC-26（v0.16.132 add-only）：资产库 v2 / 旧项目自动迁移能力标记（旧客户端忽略）。
      // RC-29（v0.16.135 add-only）：资产图写回 / 评估写入门控标记（旧客户端忽略）。
      // RC-30（v0.16.136 add-only）：宿主直连资产生图能力标记（旧客户端忽略）。
      // RC-32（v0.16.138 add-only / Q9）：asset-generate status/collect 支持按 assetId 取最新任务（旧宿主缺省→client 可降级）。
      return {
        ok: true,
        version: VERSION,
        root: base,
        exists,
        projectCount: projects.length,
        coverSupported: true,
        contentWriteSupported: true,
        assetLibraryV2Supported: true,
        assetCardsMigrateSupported: true,
        assetMediaWriteSupported: true,
        assetEvaluationSupported: true,
        assetGenerateSupported: true,
        assetGenerateLatestSupported: true,
        // RC-48 / v0.16.170（add-only）：host 后台取回 worker 能力标记（client 读插件 status 门控；
        // 旧版只在 asset-generate 响应内，导致误报「宿主版本过旧」）。asset-generate 响应通道保持。
        assetGenerateHostWorkerSupported: true,
        // v0.16.208（D-0092 视频）：add-only 能力标记；视频仅 LibTV 后端，neowow 不声明支持。
        videoGenSupported: true,
        videoBackends: ['libtv'],
      }
    }

    case 'shelf': {
      // RC-24（v0.16.121 add-only）：有封面文件的项目附加 coverPath/coverUpdatedAt；无封面项目字节不变。
      const listed = await store.listProjects(root)
      const projects = []
      for (const project of listed) {
        const cover = await store.projectCoverInfo(project.path)
        projects.push(cover ? { ...project, ...cover } : project)
      }
      return { ok: true, root: store.projectsBase(root), projects }
    }

    case 'create-project': {
      const project = await store.createProject(root, input.title)
      // RC-22（v0.16.100）：面板创建 → client 传 sessionId，host 用 agents 服务解析会话头（best-effort，失败不阻断）
      const transportSessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
      if (transportSessionId && project && project.title) {
        try {
          const agents = safeGet(scope, 'agents')
          const agent = agents && typeof agents.get === 'function' ? agents.get(transportSessionId) : undefined
          const header = agent && agent.session && agent.session.header
          const sessionId = header && typeof header.id === 'string' ? header.id.trim() : ''
          if (sessionId) {
            await store.bindProjectSession(root, project.title, {
              sessionId,
              cwd: typeof header.cwd === 'string' ? header.cwd : '',
              preset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
              source: 'created',
            })
          }
        } catch {
          /* best-effort：绑定失败不阻断创建 */
        }
      }
      return { ok: true, project }
    }

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
      // v0.15.10（task-131 / C-5 / V1）：写前 realpath 包含校验（junction/symlink 逃逸 → forbidden）
      const file = await store.assertProjectWriteTarget(dir, rel)
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
      // v0.16.10（task-157 / M2）：直接 append 走 guard（`.aidrama` junction/symlink 拒绝）。
      await store.guardedProjectAppend(dir, '.aidrama/editor-notifications.jsonl', `${JSON.stringify(record)}\n`)
      return { ok: true, path: rel, action: record.action, notifiedAt: record.at }
    }

    case 'storyboard-get': {
      // v0.16.39（client 并发保护 add-only）：includeHashes 默认不传 → 旧响应字节不变。
      if (input.includeHashes !== undefined && typeof input.includeHashes !== 'boolean') {
        return fail(400, 'invalid-args', 'includeHashes 必须是布尔值')
      }
      return { ok: true, ...(await store.getStoryboardReadView(root, input.title, input.order, { includeHashes: input.includeHashes === true })) }
    }

    case 'storyboard-save': {
      // v0.16.39（task-233）：add-only 单镜 groupId 编辑；与 shots/groups 互斥。
      if (input.groupIdEdits !== undefined) {
        if (input.shots !== undefined || input.groups !== undefined) {
          return fail(400, 'invalid-args', 'groupIdEdits 不能与 shots/groups 同时提供')
        }
        if (!Number.isInteger(Number(input.order)) || Number(input.order) < 1) {
          return fail(400, 'invalid-args', 'groupIdEdits 需要正整数 order')
        }
        if (!input.expectedHash || typeof input.expectedHash !== 'object' || Array.isArray(input.expectedHash)) {
          return fail(400, 'invalid-args', 'groupIdEdits 需要 expectedHash 对象（建议覆盖 storyboard+groups）')
        }
        try {
          const saved = await store.editStoryboardGroupIds(root, input.title, input.order, input.groupIdEdits)
          return { ok: true, ...saved, hashes: await store.readStoryboardHashes(root, input.title, input.order) }
        } catch (error) {
          if (error && error.code === 'group-inconsistent') {
            return reply(409, { ok: false, code: 'group-inconsistent', error: error.message })
          }
          if (error && error.code === 'invalid-args') return fail(400, 'invalid-args', error.message)
          throw error
        }
      }
      // v0.10.0（0-4b）：可选 groups（add-only）；不传=旧行为，传 [] = 清空 sidecar。
      if (input.groups !== undefined) {
        const saved = await store.saveStoryboardWithGroups(root, input.title, input.order, input.shots, input.groups)
        return { ok: true, shots: saved.shots, groups: saved.groups, groupsSaved: saved.groups.length > 0, hashes: await store.readStoryboardHashes(root, input.title, input.order) }
      }
      // v0.16.95（P0 写面 add-only）：普通 shots 走事务保存（JSON+MD 失败回滚），并返回新 hashes。
      const shots = await store.saveStoryboardTransactional(root, input.title, input.order, input.shots)
      return { ok: true, shots, hashes: await store.readStoryboardHashes(root, input.title, input.order) }
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

    case 'world-get': {
      // RC-84（v0.16.279）：v3 doc + v1 兼容 world 数组；v1/v2 只读适配不写盘。
      const compat = await store.readWorldCompat(root, input.title)
      return {
        ok: true,
        schemaVersion: 3,
        doc: compat.doc,
        world: compat.world,
        secondaryDefaults: store.WORLD_SUBTABS,
        migrated: compat.migrated === true,
        ...(compat.migration ? { migration: compat.migration } : {}),
      }
    }

    case 'world-save': {
      // RC-84：doc(v3) 或 legacy world 数组均写 v3（整表覆盖）；返回同 world-get 形状。
      const saved = await store.saveWorldCompat(root, input.title, input)
      return {
        ok: true,
        schemaVersion: 3,
        doc: saved.doc,
        world: saved.world,
        secondaryDefaults: store.WORLD_SUBTABS,
        migrated: saved.migrated === true,
      }
    }

    case 'style-save': {
      // C2（E15/H-7）：视觉圣经定向/冻结写入口（METHODS 70→71；无 path 入参；expectedHash 方法内处理，不交 txn object 分支）
      if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 64 * 1024) {
        throw styleDna.styleError('invalid-args', 'style-save 请求体超过 64KB')
      }
      // client api() 在已选数据源时会向所有 METHOD 注入传输字段 cwd/sessionId（P2-1 多数据源）；
      // 传输字段不计入 style-save 业务 schema（未知业务键仍严格 400），工作区解析仍用外层 input.cwd。
      const { cwd: _transportCwd, sessionId: _transportSessionId, ...businessInput } = input
      const parsed = styleDna.parseStyleSaveInput(businessInput)
      const current = await store.readStyleDoc(root, input.title)
      const currentState = styleDna.normalizeStyleState(current.doc && current.doc.state)
      const status = current.doc ? currentState.status : 'draft'
      const currentHash = current.hash
      // directed 微调必须带 expectedHash（缺失 → 409 conflict，非 400；见需求 §3.3/Lead 条件③）
      if (parsed.action === 'save' && status === 'directed' && !parsed.expectedHash) {
        return reply(409, {
          ok: false,
          code: 'conflict',
          error: '已定向状态微调必须提供 expectedHash（并发保护）',
          currentHash,
          next: '预期续作：刷新后以最新 state.hash 重试',
        })
      }
      if (parsed.expectedHash && parsed.expectedHash !== currentHash) {
        return reply(409, {
          ok: false,
          code: 'conflict',
          error: 'style.json 已被其他写入修改（expectedHash 不符）',
          currentHash: currentHash || null,
          next: '预期续作：刷新后以最新 state.hash 重试',
        })
      }
      const plan = styleDna.planStyleAction({ current, parsed, actor: 'panel' })
      const saved = plan.changed ? await store.writeStyleDoc(root, input.title, plan.doc) : null
      const doc = saved ? saved.doc : plan.doc || current.doc || { schemaVersion: 1, style: styleDna.normalizeStyleDNA(null), state: styleDna.buildDefaultStyleState() }
      const state = styleDna.normalizeStyleState(doc.state)
      const hash = saved ? saved.hash : currentHash
      const referenceExtras = {}
      if (Object.hasOwn(doc, 'references')) referenceExtras.references = styleDna.normalizeStyleReferences(doc.references)
      if (Object.hasOwn(doc, 'referenceFilms')) referenceExtras.referenceFilms = styleDna.normalizeStyleReferenceFilms(doc.referenceFilms)
      if (Object.hasOwn(doc, 'directorStyles')) referenceExtras.directorStyles = styleDna.normalizeStyleDirectorStyles(doc.directorStyles)
      return {
        ok: true,
        path: '.aidrama/style.json',
        style: styleDna.normalizeStyleDNA(doc.style),
        state: styleDna.styleResponseState(state, hash),
        hash: hash || null,
        bytes: saved ? saved.bytes : Buffer.byteLength(current.text || '', 'utf8'),
        ...referenceExtras,
      }
    }

    case 'dialogue-get':
      return { ok: true, ...(await store.getDialogue(root, input.title)) }

    case 'voice-script-export':
      return { ok: true, ...(await store.exportVoiceScript(root, input.title, input.order)) }

    case 'assets-get': {
      // v0.15.1（task-107）：add-only cards（资产卡 media 读侧；旧 assets 字段不变）
      // v0.16.10（task-157 / M3）：registryOk/registryWarning add-only；损坏时只读降级（不写盘）。
      // v0.16.35（R-24）：add-only 分页/projection；默认无参分支零改动。
      // RC-47：资产接口被调用时把该项目 in-flight 任务重新入队（懒恢复；不阻塞读）。
      try {
        const schedulerHost = scope ? safeGet(scope, 'aiDramaHost') : undefined
        if (schedulerHost && schedulerHost.assetScheduler && typeof input?.title === 'string' && input.title.trim()) {
          void schedulerHost.assetScheduler.enqueueProject(root, input.title.trim())
        }
      } catch { /* 入队失败不影响只读 */ }
      let pageOptions
      try {
        pageOptions = normalizeAssetsGetPage(input)
      } catch (error) {
        return fail(400, 'invalid-args', error instanceof Error ? error.message : '分页参数非法')
      }
      const assetsState = await store.readAssetsState(root, input.title)
      const assets = assetsState.assets
      const cards = (await store.getAssetCards(root, input.title)).map((card) => assetReview.deriveAssetMediaReadView(card))
      // v0.15.3（task-114 / 迭代3 VB-H）：add-only scenes/styleDNA（E 类；仅存在数据时出现；损坏视为无）
      let scenes = []
      try {
        scenes = await store.getScenes(root, input.title)
      } catch {
        scenes = []
      }
      let styleDoc = null
      try {
        styleDoc = await store.readStyleDoc(root, input.title)
      } catch {
        styleDoc = null
      }
      const styleDNA = styleDoc && styleDoc.doc ? styleDna.normalizeStyleDoc(styleDoc.doc).style : null
      const style = styleDNA && typeof styleDNA === 'object'
        ? Object.fromEntries(
            styleDna.STYLE_DIMENSIONS.map((dimension) => {
              const value = styleDNA[dimension]
              return [dimension, String(value == null ? '' : value)]
            }),
          )
        : null
      const hasStyle = style !== null && Object.values(style).some((value) => value.trim())
      // C2（E15，add-only）：仅当 style.json 存在 state 时返回 styleDirection（旧项目/旧文件不出现该键）
      const styleDirection = styleDoc && styleDoc.doc && styleDoc.doc.state && typeof styleDoc.doc.state === 'object' && !Array.isArray(styleDoc.doc.state)
        ? styleDna.styleDirectionFromState(styleDoc.doc.state, styleDoc.hash)
        : null
      // C2b（E16 add-only）：仅 style.json 已冻结且五维非空时返回只读风格章节；非 frozen/旧项目不出现该键、响应字节不变
      const stylePrompt = styleInjection.stylePromptFor(styleDoc)
      const styleExtras = styleDoc && styleDoc.doc ? styleDna.styleExtrasForRead(styleDoc.doc) : {}
      // C3（E16/H-8）：可选 includeReviewHashes:true 时返回 cardsHash/scenesHash（供 client 传 asset-save.expectedHash）；
      // 缺省/ false 时响应逐字节不变（旧客户端/旧项目兼容）；仅在对应卡文件存在时出现。
      if (input.includeReviewHashes !== undefined && typeof input.includeReviewHashes !== 'boolean') {
        return fail(400, 'invalid-args', 'includeReviewHashes 必须是布尔值')
      }
      let cardsHash = null
      let scenesHash = null
      if (input.includeReviewHashes === true) {
        try { cardsHash = (await store.readCardsDoc(root, input.title, 'asset')).hash } catch { cardsHash = null }
        try { scenesHash = (await store.readCardsDoc(root, input.title, 'scene')).hash } catch { scenesHash = null }
      }
      // v0.15.9（task-128 / D2C-H，E12 add-only）：scanMaterials?:boolean 默认 false；true 追加扫描结果
      if (input.scanMaterials !== undefined && typeof input.scanMaterials !== 'boolean') {
        return fail(400, 'invalid-args', 'scanMaterials 必须是布尔值')
      }
      // v0.16.13（M1-a-H）：可选 includeImportHistory:true（add-only；缺省不读文件、响应字节不变）。
      if (input.includeImportHistory !== undefined && typeof input.includeImportHistory !== 'boolean') {
        return fail(400, 'invalid-args', 'includeImportHistory 必须是布尔值')
      }
      let importHistoryExtra = {}
      if (input.includeImportHistory === true) {
        const importHistoryState = await importAssets.readImportHistory(root, input.title)
        importHistoryExtra = {
          // 文件按“新在前”存储；响应按“旧→新”返回，client 侧 slice(-50).reverse() 后展示新在前。
          importHistory: [...importHistoryState.entries].reverse(),
          ...(importHistoryState.corrupted ? { importHistoryCorrupted: true } : {}),
        }
      }
      // v0.16.15（M1-b-H）：可选 includeImportTemplates:true（add-only；缺省不读文件、响应字节不变）。
      if (input.includeImportTemplates !== undefined && typeof input.includeImportTemplates !== 'boolean') {
        return fail(400, 'invalid-args', 'includeImportTemplates 必须是布尔值')
      }
      let importTemplatesExtra = {}
      if (input.includeImportTemplates === true) {
        const importTemplatesState = await importAssets.readImportTemplates(root, input.title)
        importTemplatesExtra = {
          importTemplates: Array.isArray(importTemplatesState.templates) ? importTemplatesState.templates : [],
          ...(importTemplatesState.corrupted ? { importTemplatesCorrupted: true } : {}),
          ...(importTemplatesState.error ? { importTemplatesError: { code: importTemplatesState.error.code, message: importTemplatesState.error.message } } : {}),
        }
      }
      // v0.16.19（N1-H）：可选 includeAssetsHash:true（add-only；缺省不读文件、响应字节不变）。
      // 返回 assetsHash = `.aidrama/assets.json` 当前字节 sha256（不存在 → null），同时作为新宿主稳定能力 marker。
      if (input.includeAssetsHash !== undefined && typeof input.includeAssetsHash !== 'boolean') {
        return fail(400, 'invalid-args', 'includeAssetsHash 必须是布尔值')
      }
      let assetsHashExtra = {}
      if (input.includeAssetsHash === true) {
        let assetsHash = null
        try {
          assetsHash = (await store.readAssetsRegistryDoc(root, input.title)).hash
        } catch {
          assetsHash = null
        }
        assetsHashExtra = { assetsHash }
      }
      // v0.16.19（N1-H）：可选 includeAssetCategory:true → 稳定能力 marker `assetCategorySupported:true`
      // （add-only；缺省/false 不出现 → 默认响应逐字节不变；旧宿主忽略入参 → 无键，client 据此门控）。
      if (input.includeAssetCategory !== undefined && typeof input.includeAssetCategory !== 'boolean') {
        return fail(400, 'invalid-args', 'includeAssetCategory 必须是布尔值')
      }
      const assetCategoryExtra = input.includeAssetCategory === true ? { assetCategorySupported: true } : {}
      // v0.16.24（Phase1 / E17a+E17b，E 类 add-only）：缺省/false 响应逐字节不变
      if (input.includeProjectAudio !== undefined && typeof input.includeProjectAudio !== 'boolean') {
        return fail(400, 'invalid-args', 'includeProjectAudio 必须是布尔值')
      }
      if (input.includeAudioBindings !== undefined && typeof input.includeAudioBindings !== 'boolean') {
        return fail(400, 'invalid-args', 'includeAudioBindings 必须是布尔值')
      }
      let projectAudioExtra = {}
      if (input.includeProjectAudio === true) {
        try {
          const scan = await audioBindings.scanProjectAudio(root, input.title, { depth: 4, limit: 500 })
          projectAudioExtra = {
            projectAudioSupported: true,
            projectAudio: scan.files,
            projectAudioTotal: scan.total,
            projectAudioTruncated: scan.truncated,
          }
        } catch {
          projectAudioExtra = { projectAudioSupported: true, projectAudio: [], projectAudioTotal: 0, projectAudioTruncated: false }
        }
      }
      let audioBindingsExtra = {}
      if (input.includeAudioBindings === true) {
        try {
          const described = await audioBindings.describeBindings(root, input.title)
          audioBindingsExtra = {
            audioBindingsSupported: true,
            audioBindingsHash: described.hash,
            ...(described.entries.length ? { audioBindings: described.entries } : {}),
          }
        } catch {
          // 文件损坏/不可读 → 只读降级（不写盘、不报错误码）
          audioBindingsExtra = { audioBindingsSupported: true, audioBindingsHash: null }
        }
      }
      if (input.includeSchemaMeta !== undefined && typeof input.includeSchemaMeta !== 'boolean') {
        return fail(400, 'invalid-args', 'includeSchemaMeta 必须是布尔值')
      }
      let schemaMetaExtra = {}
      if (input.includeSchemaMeta === true) {
        let metaState
        try {
          metaState = await store.readRegistryMeta(root, input.title)
        } catch {
          metaState = { source: 'default', schemas: { ...store.DATA_SCHEMA_VERSIONS } }
        }
        let assetCardsSchemaVersion = 1
        let sceneCardsSchemaVersion = 1
        try {
          const assetDoc = await store.readCardsDoc(root, input.title, 'asset')
          if (assetDoc && assetDoc.doc && Number.isInteger(assetDoc.doc.schemaVersion) && assetDoc.doc.schemaVersion >= 1) assetCardsSchemaVersion = assetDoc.doc.schemaVersion
        } catch { /* 卡文件损坏/缺失 → 默认 v1；不改变 assets-get 既有行为 */ }
        try {
          const sceneDoc = await store.readCardsDoc(root, input.title, 'scene')
          if (sceneDoc && sceneDoc.doc && Number.isInteger(sceneDoc.doc.schemaVersion) && sceneDoc.doc.schemaVersion >= 1) sceneCardsSchemaVersion = sceneDoc.doc.schemaVersion
        } catch { /* 同上 */ }
        schemaMetaExtra = {
          registrySchemaVersion: Number.isInteger(metaState.schemas?.assetsRegistry) ? metaState.schemas.assetsRegistry : 1,
          assetCardsSchemaVersion,
          sceneCardsSchemaVersion,
          schemaMetaSource: metaState.source || 'default',
          ...(assetsState.registryOk === false && assetsState.registryDamage ? { registryDamage: assetsState.registryDamage } : {}),
        }
      }
      // v0.16.17（M4-c-H）：项目数据目录存在性 —— 纯 lstat 一次；缺失/非目录/symlink/junction/异常保守 false，仅 false 时输出。
      let dataDirPresent = true
      try {
        const dataDirStat = await fs.lstat(path.join(store.projectDir(root, input.title), '.aidrama'))
        dataDirPresent = dataDirStat.isDirectory() && !dataDirStat.isSymbolicLink()
      } catch {
        dataDirPresent = false
      }
      let responseAssets = assets
      let responseCards = cards
      let pageExtra = {}
      if (pageOptions.active) {
        const target = pageOptions.collection === 'cards' ? cards : assets
        if (pageOptions.hasPage) {
          const total = target.length
          const paged = target.slice(pageOptions.offset, pageOptions.offset + pageOptions.limit)
          const projected = projectR24Entries(paged, pageOptions.projection)
          if (pageOptions.collection === 'cards') responseCards = projected
          else responseAssets = projected
          const hasMore = pageOptions.offset + pageOptions.limit < total
          pageExtra = {
            page: {
              total,
              limit: pageOptions.limit,
              offset: pageOptions.offset,
              hasMore,
              nextOffset: hasMore ? pageOptions.offset + pageOptions.limit : null,
            },
          }
        } else {
          const projected = projectR24Entries(target, pageOptions.projection)
          if (pageOptions.collection === 'cards') responseCards = projected
          else responseAssets = projected
        }
      }
      const result = {
        ok: true,
        assets: responseAssets,
        cards: responseCards,
        registryOk: assetsState.registryOk,
        ...(assetsState.registryWarning ? { registryWarning: assetsState.registryWarning } : {}),
        ...importHistoryExtra,
        ...importTemplatesExtra,
        ...assetsHashExtra,
        ...assetCategoryExtra,
        ...projectAudioExtra,
        ...audioBindingsExtra,
        ...schemaMetaExtra,
        ...(dataDirPresent ? {} : { dataDirPresent: false }),
        ...(Array.isArray(scenes) && scenes.length ? { scenes } : {}),
        ...(hasStyle ? { styleDNA: style } : {}),
        ...(styleDirection ? { styleDirection } : {}),
        ...(stylePrompt ? { stylePrompt } : {}),
        ...styleExtras,
        ...(cardsHash ? { cardsHash } : {}),
        ...(scenesHash ? { scenesHash } : {}),
        ...pageExtra,
      }
      if (input.scanMaterials === true) {
        let scan
        try {
          scan = await store.scanMaterials(root, input.title, { limit: 1000 })
        } catch {
          scan = { files: [], total: 0, truncated: false, registryOk: false, unverified: true }
        }
        return {
          ...result,
          unregisteredFiles: scan.files,
          unregisteredTotal: scan.total,
          truncated: scan.truncated,
          ...(scan.unverified ? { unverified: true } : {}),
        }
      }
      return result
    }

    case 'asset-save': {
      // C3（E16/H-8）：资产/场景卡审核写入口（METHODS 71→72；transport cwd/sessionId 先剔除）
      const { cwd: _transportCwd, sessionId: _transportSessionId, ...businessInput } = input
      if (Buffer.byteLength(JSON.stringify(businessInput), 'utf8') > 64 * 1024) {
        throw assetReview.reviewError('too-large', 'asset-save 请求体超过 64KB')
      }
      const parsed = assetReview.parseAssetSaveInput(businessInput)
      if (parsed.mode === 'fields') {
        const saved = await store.applyAssetFieldEdit(root, input.title, {
          card: parsed.card,
          expectedHash: parsed.expectedHash,
          expectedVersion: parsed.expectedVersion,
        })
        return { ok: true, ...saved }
      }
      const saved = await store.applyAssetReview(root, input.title, {
        kind: parsed.kind,
        id: parsed.id,
        action: parsed.action,
        prompt: parsed.prompt,
        reason: parsed.reason,
        expectedHash: parsed.expectedHash,
        expectedReviewVersion: parsed.expectedReviewVersion,
        actor: 'panel',
      })
      return { ok: true, ...saved }
    }

    case 'asset-cards-migrate': {
      // RC-26（v0.16.132，Lead 批准）：旧项目资产卡图片迁移（METHODS 77→78）。
      // dryRun 默认 true（零写）；实际写路径：plan（只读）→ runProjectTxn(动态 targets) → copy + 一次原子写 cards.json。
      const dryRun = input.dryRun === undefined ? true : input.dryRun
      if (typeof dryRun !== 'boolean') return fail(400, 'invalid-args', 'dryRun 必须是布尔值')
      const rewriteRefs = input.rewriteRefs === undefined ? true : input.rewriteRefs
      if (typeof rewriteRefs !== 'boolean') return fail(400, 'invalid-args', 'rewriteRefs 必须是布尔值')
      let limit
      if (input.limit !== undefined) {
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > assetMigration.MIGRATION_MAX_LIMIT) {
          return fail(400, 'invalid-args', `limit 必须是 1..${assetMigration.MIGRATION_MAX_LIMIT} 的整数`)
        }
        limit = input.limit
      }
      const plan = await assetMigration.planAssetCardMediaMigration(root, input.title, { rewriteRefs, ...(limit === undefined ? {} : { limit }) })
      if (dryRun) return { ok: true, dryRun: true, ...plan.report }
      const applied = await txn.runProjectTxn(root, input.title, {
        action: 'asset-cards-migrate',
        actor: 'panel',
        targets: plan.targets,
      }, async () => assetMigration.applyAssetCardMediaMigration(root, input.title, plan))
      return { ok: true, dryRun: false, ...applied }
    }

    case 'asset-generate': {
      // RC-30（v0.16.136，Lead 批准方案 A）：宿主直连画布单资产生图（METHODS 78→79）。
      // submit 外层 txn 由 WRITE_TARGETS 提供；status 只读；collect 下载动态文件由 lib 内部 txn 写入/审计。
      const host = scope ? safeGet(scope, 'aiDramaHost') : undefined
      try {
        const result = await assetGenerate.runAssetGenerate({ root, input, registry: host && host.backends })
        // RC-47：submit 入队；status 调用时把该项目 in-flight 任务重新入队（懒恢复，不阻塞响应）。
        const action = String(input && input.action == null ? 'submit' : input.action).trim()
        const title = typeof input?.title === 'string' ? input.title.trim() : ''
        if (host && host.assetScheduler && title) {
          if (result && result.status === 'submitted' && result.taskId) {
            host.assetScheduler.enqueue({ root, title, taskId: result.taskId })
          } else if (action === 'status') {
            void host.assetScheduler.enqueueProject(root, title)
          }
        }
        return result
      } catch (error) {
        const code = error && typeof error.code === 'string' ? error.code : ''
        const message = error instanceof Error ? error.message : '资产直连生成失败'
        if (code === 'asset-locked') {
          return reply(423, { ok: false, code: 'asset-locked', error: message, review: error.review || null, currentHash: error.currentHash || null, expectedHash: error.expectedHash || null })
        }
        if (code === 'canvas-unbound') {
          return reply(400, { ok: false, code: 'canvas-unbound', error: message, backend: error.backend || null, reason: error.reason || null, detail: error.detail || null, fix: error.fix || null })
        }
        if (code === 'backend-unavailable') {
          return reply(502, { ok: false, code: 'backend-unavailable', error: message, backend: error.backend || null, detail: error.detail || null })
        }
        if (code === 'upstream-unavailable') {
          return reply(502, { ok: false, code: 'upstream-unavailable', error: message, backend: error.backend || null, nodeName: error.nodeName || null })
        }
        if (code === 'conflict') {
          return reply(409, { ok: false, code: 'conflict', error: message, currentHash: error.currentHash || null, ...(error.currentVersion !== undefined ? { currentVersion: error.currentVersion } : {}) })
        }
        if (code === 'not-found') return fail(404, 'not-found', message)
        if (code === 'invalid-args') return fail(400, 'invalid-args', message)
        throw error
      }
    }

    case 'asset-extract': {
      // C4a（E16/H-8 A）：资产剥离（METHODS 72→73）；transport cwd/sessionId 先剔除；body ≤64KB
      const { cwd: _transportCwd, sessionId: _transportSessionId, ...businessInput } = input
      if (Buffer.byteLength(JSON.stringify(businessInput), 'utf8') > 64 * 1024) {
        throw assetExtract.extractError('too-large', 'asset-extract 请求体超过 64KB')
      }
      const parsed = assetExtract.parseAssetExtractInput(businessInput)
      const result = await assetExtract.runAssetExtract(root, parsed)
      return { ok: true, ...result }
    }

    case 'asset-audio-save': {
      // v0.16.24（Phase1 / H-11）：角色卡对标音色手动绑定（METHODS 73→74；transport cwd/sessionId 先剔除；body ≤64KB）
      const { cwd: _transportCwd, sessionId: _transportSessionId, ...businessInput } = input
      if (Buffer.byteLength(JSON.stringify(businessInput), 'utf8') > 64 * 1024) {
        throw audioBindings.bindingsError('too-large', 'asset-audio-save 请求体超过 64KB')
      }
      const saved = await audioBindings.saveBindings(root, input.title, businessInput)
      return { ok: true, ...saved }
    }

    case 'assets-add': {
      // v0.16.10（task-157 / M3）：repairRegistry:true + 无 source → 仅重建登记（客户端修复按钮）。
      // v0.16.19（N1-H）：add-only 分类写通道 —— 单条 `{id, assetCategory}` / 批量 `{categoryUpdates}`（均无 source）。
      // R-01b/R-25（v0.16.34 add-only）：normalizeSources / writeSchemaMeta / dryRun；默认路径完全不变。
      const hasSource = (input.asset && input.asset.source != null) || input.source != null
      for (const key of ['normalizeSources', 'writeSchemaMeta', 'dryRun']) {
        if (input[key] !== undefined && typeof input[key] !== 'boolean') {
          return fail(400, 'invalid-args', `${key} 必须是布尔值`)
        }
      }
      const normalizeSources = input.normalizeSources === true
      const writeSchemaMeta = input.writeSchemaMeta === true
      const dryRun = input.dryRun === true
      if (store.isAssetCategoryUpdateInput(input)) {
        if (hasSource || input.repairRegistry === true || normalizeSources || writeSchemaMeta || dryRun) {
          return fail(400, 'invalid-args', 'assets-add 分类更新不能与 source / repairRegistry / normalizeSources / writeSchemaMeta / dryRun 同时提供')
        }
        const result = await store.setAssetCategories(root, input.title, input)
        return { ok: true, ...result }
      }
      if (normalizeSources || writeSchemaMeta) {
        if (hasSource) return fail(400, 'invalid-args', 'normalizeSources/writeSchemaMeta 不能与 source 同时提供')
        const extra = { ok: true, dryRun }
        if (normalizeSources) {
          if (input.repairRegistry === true && dryRun) {
            // dryRun 与 repair 组合：损坏时不写/不备份，直接返回既有 409 语义。
            const state = await store.readAssetsState(root, input.title)
            if (state.registryOk !== true) {
              return fail(409, 'registry-corrupt', '素材登记损坏；dryRun 下不执行 repair（会备份/写盘），请去掉 repairRegistry 或先正式 repair')
            }
          } else if (input.repairRegistry === true) {
            const readiness = await store.ensureRegistryReady(root, input.title, { repairRegistry: true })
            if (readiness.registryRepaired) {
              extra.registryRepaired = true
              extra.rebuiltCount = readiness.rebuiltCount
              extra.backup = readiness.backup || null
            }
          }
          const normalized = await store.normalizeRegistrySources(root, input.title, { dryRun })
          Object.assign(extra, {
            registryNormalized: true,
            normalizedCount: normalized.normalizedCount,
            alreadyRelativeCount: normalized.alreadyRelativeCount,
            total: normalized.total,
            wrote: normalized.wrote,
            backup: normalized.backup || extra.backup || null,
          })
        }
        if (writeSchemaMeta) {
          const written = await store.writeRegistryMeta(root, input.title, { dryRun })
          extra.schemaMetaWritten = written.wrote
          extra.schemaMeta = written.meta
        }
        return extra
      }
      if (input.repairRegistry === true && !hasSource) {
        const readiness = await store.ensureRegistryReady(root, input.title, { repairRegistry: true })
        return {
          ok: true,
          registryRepaired: Boolean(readiness.registryRepaired),
          rebuiltCount: readiness.registryRepaired ? readiness.rebuiltCount : 0,
          backup: readiness.backup || null,
          registryOk: true,
        }
      }
      const addInput = input.asset ? { ...input.asset } : { ...input }
      if (Object.hasOwn(input, 'assetCategory') && !Object.hasOwn(addInput, 'assetCategory')) addInput.assetCategory = input.assetCategory
      return { ok: true, asset: await store.addAsset(root, input.title, addInput, { repairRegistry: input.repairRegistry === true }) }
    }

    case 'assets-remove': {
      const result = await store.removeAsset(root, input.title, input.id)
      return { ok: true, removed: true, id: result.id }
    }

    // v0.15.11（task-134 / IMP-H，E13，Lead 批准）：一键导入素材（base64 → 项目内文件 + 自动登记）
    // v0.16.7（task-144 / C2-H，E13 add-only）：source 模式（从受管项目只读复制）；base64 模式响应不变
    case 'assets-import': {
      try {
        const imported = await importAssets.importAsset(root, input, {
          managedRoots: context.managedRoots || [{ path: root, sourceType: 'current' }],
        })
        return { ok: true, ...imported }
      } catch (error) {
        const code = error && typeof error.code === 'string' ? error.code : 'failed'
        const message = error instanceof Error ? error.message : '导入素材失败'
        if (code === 'registry-corrupt') {
          return reply(409, {
            ok: false,
            code: 'registry-corrupt',
            error: message,
            backup: (error && error.backup) || null,
            next: (error && error.next) || '可带 repairRegistry:true 重建后重试',
          })
        }
        if (code === 'conflict') {
          return reply(409, {
            ok: false,
            code: 'conflict',
            duplicate: Boolean(error && error.duplicate),
            error: message,
            existing: (error && error.existing) || null,
          })
        }
        if (code === 'template-exists') {
          return reply(409, {
            ok: false,
            code: 'template-exists',
            error: message,
            existingTemplate: (error && error.existingTemplate) || null,
            next: (error && error.next) || '如需覆盖请显式传 overwriteTemplate:true，或换一个名称',
          })
        }
        if (code === 'template-limit') {
          return reply(409, {
            ok: false,
            code: 'template-limit',
            error: message,
            limit: (error && error.limit) || 20,
            next: (error && error.next) || '请先删除一个旧模板后再保存',
          })
        }
        if (code === 'templates-corrupt') {
          return reply(409, {
            ok: false,
            code: 'templates-corrupt',
            error: message,
            next: (error && error.next) || '请检查或删除项目内 .aidrama/import-templates.json 后重试（不自动覆盖）',
          })
        }
        if (code === 'templates-save-failed' || code === 'templates-delete-failed' || code === 'templates-read-failed') {
          return reply(500, {
            ok: false,
            code,
            error: message,
            next: (error && error.next) || '请确认项目 .aidrama 可写/可读后重试',
          })
        }
        if (code === 'too-large') return fail(413, 'too-large', message)
        if (code === 'invalid-args') return fail(400, 'invalid-args', message)
        if (code === 'not-found') return fail(404, 'not-found', message)
        if (code === 'forbidden') return fail(403, 'forbidden', message)
        return fail(400, 'failed', message)
      }
    }

    // v0.15.1（task-110，H 类契约，Lead 批准）：本地图片只读通道（media-read，METHODS 68→69）
    case 'media-read': {
      try {
        // v0.16.95（P0 / N1b/N2 add-only）：mode:'stream' 返回短期票据 URL；action:'reveal' 调原生 opener。METHODS 不变。
        const hasMode = input.mode !== undefined
        const hasAction = input.action !== undefined
        if (hasMode || hasAction) {
          if (hasMode && hasAction) return fail(400, 'invalid-args', 'mode 与 action 不能同时提供')
          if (hasMode && input.mode !== 'stream') return fail(400, 'invalid-args', 'mode 仅支持 stream')
          if (hasAction && input.action !== 'reveal') return fail(400, 'invalid-args', 'action 仅支持 reveal')
          if (input.assetId != null) return fail(400, 'invalid-args', 'stream/reveal 仅支持项目内 path')
          let title = typeof input.title === 'string' ? input.title.trim() : ''
          if (!title) {
            const projects = await store.listProjects(root)
            if (projects.length === 1) title = projects[0].title
            else return fail(400, 'invalid-args', projects.length ? '工作区有多个短剧项目，请指定 title' : '工作区没有短剧项目，请先创建项目')
          }
          if (hasMode) {
            const hostGet = context && context.mediaStream && typeof context.mediaStream.getHostService === 'function'
              ? context.mediaStream.getHostService
              : () => undefined
            const webServer = hostGet('webServer')
            const connection = hostGet('connection')
            if (!webServer || typeof connection?.authenticatedUrl !== 'function' || !webServer.port) {
              return fail(501, 'unsupported', '当前宿主无浏览器 HTTP 服务，视频预览不可用（可打开文件夹）')
            }
            const ensureRoute = context && context.mediaStream && typeof context.mediaStream.ensureMediaStreamRoute === 'function'
              ? context.mediaStream.ensureMediaStreamRoute
              : () => false
            if (!ensureRoute()) return fail(501, 'unsupported', '视频流路由不可用（webServer 未注册）')
            const ticket = await media.issueMediaStreamTicket(root, title, { path: input.path })
            const protocol = String(webServer.protocol || 'http:').replace(/:$/u, '')
            const origin = `${protocol}://127.0.0.1:${webServer.port}`
            const url = connection.authenticatedUrl(`${origin}${media.MEDIA_STREAM_PATH}?ticket=${encodeURIComponent(ticket.token)}`)
            return { ok: true, stream: { url, token: ticket.token, mime: ticket.mime, size: ticket.size, name: ticket.name, expiresAt: ticket.expiresAt } }
          }
          const resolved = await media.resolveRevealMedia(root, title, { path: input.path })
          const hostGet = context && context.mediaStream && typeof context.mediaStream.getHostService === 'function'
            ? context.mediaStream.getHostService
            : () => undefined
          const sessionController = hostGet('sessionController')
          let revealed = false
          let reason = ''
          let openerError = ''
          if (sessionController && typeof sessionController.openWorkspacePath === 'function' &&
            (typeof sessionController.canOpenWorkspacePath !== 'function' || sessionController.canOpenWorkspacePath() !== false)) {
            // v0.16.267：Host 的 openWorkspacePath 需要 (request, signal)；缺 signal 会抛错 → 之前一律 opener-failed。
            const openerController = new AbortController()
            const openerTimer = setTimeout(() => { try { openerController.abort() } catch (error) { /* 忽略 */ } }, 8000)
            try {
              await sessionController.openWorkspacePath({ action: 'reveal', path: resolved.realTarget }, openerController.signal)
              revealed = true
            } catch (error) {
              reason = 'opener-failed'
              openerError = error && (error.message || error.code) ? String(error.message || error.code) : ''
            } finally {
              clearTimeout(openerTimer)
            }
          } else {
            reason = 'unsupported'
          }
          return revealed ? { ok: true, revealed: true } : { ok: true, revealed: false, path: resolved.path, reason, openerError }
        }
        return { ok: true, ...(await media.readMedia(root, input)) }
      } catch (error) {
        const code = error && typeof error.code === 'string' ? error.code : 'invalid-args'
        const status = code === 'forbidden' ? 403 : code === 'not-found' ? 404 : code === 'too-large' ? 413 : code === 'unsupported' ? 501 : 400
        return fail(status, code, error instanceof Error ? error.message : '读取图片失败')
      }
    }

    case 'media-upload': {
      // v0.16.96（D-0042）：站位图上传（add-only）；RC-24（v0.16.121 add-only）：项目封面 purpose:'cover'（remove:true 恢复默认）。
      // RC-29（v0.16.135 add-only）：purpose:'asset' 接受候选图 → 素材/短剧资产 + 原子绑定 card.media（内部 txn）。
      try {
        if (input && input.purpose === 'asset') return { ok: true, ...(await assetMedia.uploadAssetImage(root, input)) }
        if (input && input.purpose === 'cover') {
          if (input.remove === true) return { ok: true, removed: (await media.removeProjectCover(root, input)).removed }
          return { ok: true, ...(await media.uploadProjectCover(root, input)) }
        }
        return { ok: true, ...(await media.uploadStagingImage(root, input)) }
      } catch (error) {
        const code = error && typeof error.code === 'string' ? error.code : 'invalid-args'
        const message = error instanceof Error ? error.message : '上传图片失败'
        if (code === 'asset-locked') {
          return reply(423, { ok: false, code: 'asset-locked', error: message, review: error.review || null, currentHash: error.currentHash || null, expectedHash: error.expectedHash || null })
        }
        if (code === 'conflict') {
          return reply(409, { ok: false, code: 'conflict', error: message, currentHash: error.currentHash || null, ...(error.currentVersion !== undefined ? { currentVersion: error.currentVersion } : {}) })
        }
        const status = code === 'forbidden' ? 403
          : code === 'not-found' ? 404
            : code === 'exists' ? 409
              : code === 'too-large' ? 413
                : 400
        if (code === 'exists') return reply(409, { ok: false, code: 'exists', error: message, next: '客户端确认覆盖后带 overwrite:true 重试' })
        return fail(status, code, message)
      }
    }

    case 'finalized-list':
      return { ok: true, finalized: await store.getFinalized(root, input.title) }

    case 'finalize-episode':
      return { ok: true, finalized: await store.finalizeEpisode(root, input.title, input.order) }

    case 'finalized-restore':
      return { ok: true, restored: await store.restoreFinalized(root, input.title, input.order, input.version) }

    case 'ledger-get': {
      // v0.16.10（task-157 / M2）：默认纯读（getLedger 不写盘）；renderFile:true 才显式渲染落盘（txn+guard）。
      if (input.renderFile === true) {
        const ledger = await store.renderLedger(root, input.title)
        // 契约：相对项目路径（不泄绝对路径）。
        return { ok: true, rendered: true, file: '账本/账本.md', ledger }
      }
      return { ok: true, ledger: await store.getLedger(root, input.title) }
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
      const artifactInput = { ...(input.artifact || input) }
      if (input.repairRegistry !== undefined) artifactInput.repairRegistry = input.repairRegistry === true
      const r = await generation.intakeArtifact(root, input.title, artifactInput)
      return {
        ok: true,
        name: r.file,
        relative: r.relative,
        bytes: r.bytes,
        sha256: r.sha256,
        assetId: r.asset.id,
        asset: r.asset,
        ...(r.versions ? { versions: r.versions } : {}),
        ...(r.registryRepaired ? { registryRepaired: true, rebuiltCount: r.rebuiltCount, backup: r.backup || null } : {}),
      }
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
      // v0.15.10（task-131 / C-5 / V2）：HTTP 层不透传内部落点/执行目录，防项目外写；工具 schema 不暴露这些字段
      delete batch.outDir
      delete batch.cwd
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
      // v0.15.10（task-131 / C-5 / V2）：HTTP 层不透传内部落点/执行目录，防项目外写；工具 schema 不暴露这些字段
      delete batch.outDir
      delete batch.cwd
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

    case 'settings-save': {
      const saved = await store.saveSettings(root, input.settings)
      // v0.16.59（H-13r2 / S2）：保存后通知托管 provider invalidate → 下一次 Agent 步骤生效。
      try { pluginHost?.notifySkillConfigChanged?.({ root, settings: saved }) } catch { /* 通知失败不阻断保存 */ }
      // v0.16.156（P0-4）：面板 openProject 绑定后，按 transport sessionId 即时刷新对应 Agent 的上下文卡。
      // 拿不到 agent/上下文桥时降级：绑定已保存，下一轮工具调用仍会按会话绑定生效。
      try {
        const transportSessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
        if (transportSessionId && runtimeContextBridge && typeof runtimeContextBridge.refreshAgentContext === 'function') {
          const bindings = await store.readProjectSessions(root).catch(() => ({}))
          const candidates = Object.entries(bindings)
            .filter(([, entry]) => entry && String(entry.sessionId || '') === transportSessionId)
            .sort((a, b) => {
              const ta = Date.parse(a[1] && a[1].updatedAt) || Date.parse(a[1] && a[1].boundAt) || 0
              const tb = Date.parse(b[1] && b[1].updatedAt) || Date.parse(b[1] && b[1].boundAt) || 0
              return tb - ta
            })
          if (candidates.length) {
            const agents = safeGet(scope, 'agents')
            const agent = agents && typeof agents.get === 'function' ? agents.get(transportSessionId) : undefined
            if (agent && contextByAgentHas(runtimeContextBridge, agent)) {
              await runtimeContextBridge.refreshAgentContext(agent, candidates[0][0])
            }
          }
        }
      } catch { /* 刷新失败不阻断 settings-save */ }
      return { ok: true, settings: saved }
    }

    case 'skills-inventory': {
      // v0.16.59（H-12r1）：只读内置技能清单（无 sources）；provider 未就绪 → 降级 complete:false（不 5xx）。
      // v0.16.63（D-0034 残留）：preset inventory 优先（挂载时含 active/enforced）；未挂载/已 dispose → host 自带兜底。
      try {
        const inventory = await context?.pluginHost?.skillInventory?.({ cwd: root })
        if (inventory && typeof inventory === 'object') return { ok: true, inventory }
      } catch { /* preset 未挂载或作用域已 dispose → 走 host 兜底 */ }
      try {
        const settings = await store.getSettings(root)
        const inventory = await buildBundledSkillInventory({
          skillsDir: SKILLS_DIR,
          version: VERSION,
          config: settings ? settings.skillConfig ?? null : null,
        })
        if (inventory) return { ok: true, inventory }
      } catch { /* 兜底失败再落旧降级 */ }
      return {
        ok: true,
        inventory: {
          version: 4,
          complete: false,
          generatedAt: new Date().toISOString(),
          package: null,
          skills: [],
          active: { story: null, asset: null, script: null },
          recommended: { story: 'drama-episode', asset: 'drama-asset', script: 'drama-seedance-prompt' },
          mode: 'unavailable',
        },
      }
    }

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
      if (!isExportFormat(format)) throw new Error(`不支持的导出格式：${format}`)
      let backupOptions = {}
      if (format === 'backup') {
        for (const [key, label] of [['dryRun', 'dryRun'], ['includeMedia', 'includeMedia']]) {
          if (input[key] !== undefined && typeof input[key] !== 'boolean') return fail(400, 'invalid-args', `${label} 必须是布尔值`)
        }
        const action = input.backupAction === undefined ? 'create' : String(input.backupAction)
        if (!['create', 'verify'].includes(action)) return fail(400, 'invalid-args', 'backupAction 必须是 create/verify')
        if (input.backupDir !== undefined && typeof input.backupDir !== 'string') return fail(400, 'invalid-args', 'backupDir 必须是字符串')
        if (action === 'verify' && (!input.backupDir || !String(input.backupDir).trim())) return fail(400, 'invalid-args', 'verify 需要 backupDir')
        backupOptions = { dryRun: input.dryRun === true, includeMedia: input.includeMedia === true, backupAction: action, backupDir: input.backupDir }
      }
      // C4b：manifest 透传 manifestFormat/字段开关；旧四格式 options 无副作用
      let result
      try {
        result = await exportProject(root, input.title, format, {
          manifestFormat: input.manifestFormat,
          includeStyleChapter: input.includeStyleChapter,
          includeAssets: input.includeAssets,
          includeScenes: input.includeScenes,
          includeTasks: input.includeTasks,
          includeVoice: input.includeVoice,
          // C5：SRT 按集导出（episode 必填正整数；由 exporter 校验并映射 400/404）
          episode: input.episode,
          ...backupOptions,
        })
      } catch (error) {
        // v0.16.29（TPL-H / M6）：模板包导出的可读错误契约（其余格式/错误保持原路径）。
        const code = error && typeof error.code === 'string' ? error.code : ''
        const message = error instanceof Error ? error.message : '导出失败'
        if (code === 'template-pack-empty') return fail(400, 'template-pack-empty', message)
        if (code === 'templates-corrupt') {
          return reply(409, {
            ok: false,
            code: 'templates-corrupt',
            error: message,
            next: '请检查或删除项目内 .aidrama/import-templates.json 后重试（不自动覆盖）',
          })
        }
        if (code === 'forbidden') return fail(403, 'forbidden', message)
        if (code === 'not-found') return fail(404, 'not-found', message)
        if (code === 'templates-read-failed') {
          return reply(500, { ok: false, code: 'templates-read-failed', error: message, next: '请确认项目 .aidrama 可读后重试' })
        }
        throw error
      }
      if (format === 'backup') {
        if (result.verify) return { ok: true, export: { format: 'backup', verify: result.verify } }
        return {
          ok: true,
          export: {
            format: 'backup',
            file: result.file,
            bytes: result.bytes,
            relative: result.file ? path.relative(root, result.file) : null,
            backup: result.backup,
          },
        }
      }
      // 契约冻结：route 响应只保留既有字段；T10 的 manifest/checks/verify 摘要只出现在
      // Agent 工具结果与内部 API 中，不改变已冻结的 HTTP 形状。
      return {
        ok: true,
        export: { format: result.format, file: result.file, bytes: result.bytes, relative: path.relative(root, result.file) },
      }
    }

    case 'backup-restore': {
      // v0.16.38（M8 阶段2，用户批准 METHODS 75）：list/preview/restore；不注册 Agent 工具。
      const backupAction = input.backupAction === undefined ? 'preview' : String(input.backupAction)
      if (!['list', 'preview', 'restore'].includes(backupAction)) {
        return fail(400, 'invalid-args', 'backupAction 必须是 list/preview/restore')
      }
      for (const key of ['dryRun', 'confirm', 'includeMedia', 'summary', 'includeSummary']) {
        if (input[key] !== undefined && typeof input[key] !== 'boolean') return fail(400, 'invalid-args', `${key} 必须是布尔值`)
      }
      if (input.expectedPlanHash !== undefined && typeof input.expectedPlanHash !== 'string') {
        return fail(400, 'invalid-args', 'expectedPlanHash 必须是字符串')
      }
      if (backupAction === 'restore' && input.dryRun === false && !input.expectedPlanHash) {
        return fail(400, 'plan-required', 'restore 需要先 preview 并传 expectedPlanHash')
      }
      try {
        if (backupAction === 'list') {
          const listed = await listBackups(root, input.title, { limit: input.limit, offset: input.offset })
          return { ok: true, backupAction: 'list', ...listed }
        }
        if (backupAction === 'preview') {
          return await previewRestore(root, input.title, {
            backupDir: input.backupDir,
            conflict: input.conflict,
            includeMedia: input.includeMedia === true,
            summary: input.summary,
            includeSummary: input.includeSummary,
          })
        }
        const restored = await restoreBackup(root, input.title, {
          backupDir: input.backupDir,
          conflict: input.conflict,
          includeMedia: input.includeMedia === true,
          confirm: input.confirm === true,
          dryRun: input.dryRun === undefined ? true : input.dryRun,
          expectedPlanHash: input.expectedPlanHash,
          operationId: input.operationId,
          summary: input.summary,
          includeSummary: input.includeSummary,
        })
        return restored
      } catch (error) {
        const code = error && typeof error.code === 'string' ? error.code : 'failed'
        const message = error instanceof Error ? error.message : '恢复失败'
        const status = code === 'forbidden' ? 403
          : code === 'not-found' ? 404
            : code === 'plan-stale' || code === 'restore-conflict' || code === 'conflict' ? 409
              : code === 'invalid-args' || code === 'plan-required' || code === 'media-restore-not-enabled' ? 400
                : 500
        return reply(status, {
          ok: false,
          code,
          error: message,
          ...(error && error.currentPlanHash ? { currentPlanHash: error.currentPlanHash } : {}),
          ...(backupAction === 'restore' ? { rolledBack: error && error.rolledBack === true, preRestoreBackup: error && error.preRestoreBackup ? error.preRestoreBackup : null } : {}),
          ...(error && Array.isArray(error.conflicts) ? { conflicts: error.conflicts } : {}),
          ...(error && Array.isArray(error.missing) ? { missing: error.missing } : {}),
          ...(error && Array.isArray(error.unexpected) ? { unexpected: error.unexpected } : {}),
          ...(error && error.rollbackError ? { rollbackError: error.rollbackError } : {}),
        })
      }
    }

    default:
      return null
  }
}

/** v0.16.7（task-144 / C2-H）：受管项目根集合（与 sources-list 同源发现 + 当前工作区；realpath/去重/排序/≤20）。 */
async function resolveManagedWorkspaceRoots(scope, config, input, resolved) {
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
  let listed = { sources: [] }
  try {
    listed = await listDataSources({
      registry,
      agentsList,
      agentsAvailable,
      configRoot: config ? config.root : undefined,
      cwd: typeof input.cwd === 'string' ? input.cwd : '',
      limit: 200,
    })
  } catch {
    listed = { sources: [] }
  }
  const candidates = []
  for (const source of listed.sources || []) {
    if (source && typeof source.path === 'string') {
      candidates.push({ path: source.path, sourceType: source.sourceType === 'session' ? 'session' : 'workspace' })
    }
  }
  if (resolved && typeof resolved.cwd === 'string') candidates.push({ path: resolved.cwd, sourceType: 'current' })
  const seen = new Set()
  const roots = []
  for (const item of candidates) {
    if (roots.length >= 20) break
    if (!path.isAbsolute(item.path)) continue
    let real
    try {
      real = await fs.realpath(item.path)
    } catch {
      continue
    }
    if (!(await store.isDirectory(real))) continue
    const key = process.platform === 'win32' ? real.toLowerCase() : real
    if (seen.has(key)) continue
    seen.add(key)
    roots.push({ path: real, sourceType: item.sourceType })
  }
  roots.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return roots.slice(0, 20)
}

function createHandler(scope, config, pluginCtx, pluginHost) {
  const mediaStreamState = pluginHost && pluginHost.mediaStream ? pluginHost.mediaStream : { disposer: null, registered: false }
  const getHostService = (serviceName) => safeGet(scope, serviceName) || safeGet(pluginCtx, serviceName)
  // v0.16.95（N1b add-only）：webServer 原生 GET/HEAD 路由按需注册（headless/webServer 缺失时降级）。
  const ensureMediaStreamRoute = () => {
    if (mediaStreamState.registered) return true
    const webServer = getHostService('webServer')
    if (!webServer || typeof webServer.register !== 'function') return false
    try {
      mediaStreamState.disposer = webServer.register({
        kind: 'exact',
        path: media.MEDIA_STREAM_PATH,
        handler: media.createMediaStreamHandler(),
      })
      mediaStreamState.registered = true
      return true
    } catch {
      return false
    }
  }
  return async (request) => {
    if (request.method !== 'POST' || request.headers.get('x-ai-drama-request') !== '1') {
      return fail(403, 'forbidden', '请求来源不被允许')
    }
    // v0.16.24（Phase1/H-11）：method/input/resolved 提到 try 外声明——409 currentHash 补读需在 catch 中读取 resolved.cwd
    let method = ''
    let input = {}
    let resolved = null
    try {
      // v0.15.11（task-134 / IMP-H）：先取 method，仅 assets-import 走受限 body 读取（70MB 上限 → 413）
      method = new URL(request.url).pathname.slice(API_PATH.length)
      input = await readRequest(request, method === 'assets-import'
        ? { maxBytes: IMPORT_REQUEST_MAX_BYTES }
        : method === 'media-upload'
          ? { maxBytes: MEDIA_UPLOAD_REQUEST_MAX_BYTES }
          : undefined)
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

      resolved = await resolveWorkspaceRoot(scope, input, config)
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

      // v0.15.11（task-134 / IMP-H）：assets-import 项目不存在 → 404（先于写事务预检，保持契约错误码）
      if (method === 'assets-import' && typeof input.title === 'string' && input.title.trim()) {
        let targetDir = null
        try {
          targetDir = store.projectDir(resolved.cwd, input.title)
        } catch {
          targetDir = null
        }
        if (targetDir && !(await store.isDirectory(targetDir).catch(() => false))) {
          return fail(404, 'not-found', '短剧项目不存在')
        }
      }

      // v0.16.96（D-0042）：media-upload 项目不存在 → 404（先于写事务预检，保持契约错误码）。
      if (method === 'media-upload' && typeof input.title === 'string' && input.title.trim()) {
        let targetDir = null
        try {
          targetDir = store.projectDir(resolved.cwd, input.title)
        } catch {
          targetDir = null
        }
        if (targetDir && !(await store.isDirectory(targetDir).catch(() => false))) {
          return fail(404, 'not-found', '短剧项目不存在')
        }
      }

      // P1-K / T2：写路由统一包项目事务（项目锁 + 审计；可选 operationId 幂等 / expectedHash 乐观锁）。
      // H-5（PM 登记、Lead 追认）：不传新字段时行为与旧版完全一致。
      // v0.16.7（task-144 / C2-H）：source 模式 assets-import 计算受管项目根（只读发现；不影响其它方法）。
      const importedFromSourceMode = method === 'assets-import' && [
        'sourceProjectId', 'sourceAssetIds', 'sourceCardIds', 'sourceSceneIds', 'copyStyleDNA',
      ].some((key) => input[key] !== undefined)
      const managedRoots = importedFromSourceMode ? await resolveManagedWorkspaceRoots(scope, config, input, resolved) : null
      const dispatchContext = { config, managedRoots, pluginHost, mediaStream: { getHostService, ensureMediaStreamRoute } }
      const writeTargets = WRITE_TARGETS[method]
      const readOnlyDryRun = method === 'assets-add' && input.dryRun === true && (input.normalizeSources === true || input.writeSchemaMeta === true)
      const txnTitle = typeof input.title === 'string' ? input.title.trim() : ''
      const txnTargets = readOnlyDryRun ? null : (typeof writeTargets === 'function' ? writeTargets(input) : writeTargets)
      let value
      if (txnTargets && txnTitle) {
        value = await txn.runProjectTxn(
          resolved.cwd,
          txnTitle,
          {
            action: method,
            actor: method.startsWith('doc-') ? 'editor' : 'panel',
            targets: txnTargets,
            operationId: typeof input.operationId === 'string' ? input.operationId : '',
            // doc-save 自己处理 expectedHash（冲突响应需要带 currentHash，形状与 H-5 通用 conflict 不同）
            // v0.16.24（Phase1 / H-11）：asset-audio-save 的 expectedHash 为 string|null（E17b audioBindingsHash）→ 映射为 txn 对象
            // 非法类型不交给 txn（保持 400 invalid-args 而非 409）；合法值统一小写后比对。
            expectedHash: method === 'doc-save'
              ? undefined
              : method === 'asset-audio-save'
                ? (() => {
                    const raw = input.expectedHash
                    if (raw === undefined) return undefined
                    if (raw === null) return { '.aidrama/assets/voice-bindings.json': null }
                    if (typeof raw === 'string' && /^[0-9a-f]{64}$/i.test(raw.trim())) return { '.aidrama/assets/voice-bindings.json': raw.trim().toLowerCase() }
                    return undefined
                  })()
                : input.expectedHash && typeof input.expectedHash === 'object' ? input.expectedHash : undefined,
          },
          () => dispatch(method, input, resolved.cwd, scope, dispatchContext),
        )
      } else {
        value = await dispatch(method, input, resolved.cwd, scope, dispatchContext)
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
        // R-10：backup create/verify 都必须保持源 .aidrama 只读；不进入既有“导出→flow-state”路由副作用。
        const backupNoFlow = method === 'export-project' && input && input.format === 'backup'
        if (flowStep && !backupNoFlow) {
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
        let currentHash = error.currentHash || null
        let conflictHashes = null
        // v0.16.24（Phase1 / H-11）：txn.conflictError 不附 currentHash → 补读 sidecar 当前 hash（仅 H-11）
        if (!currentHash && method === 'asset-audio-save' && resolved && resolved.cwd && typeof input.title === 'string') {
          try {
            currentHash = (await audioBindings.readDoc(resolved.cwd, input.title)).hash
          } catch {
            currentHash = null
          }
        }
        // v0.16.95（P0 写面 add-only）：storyboard 409 回读 currentHash + hashes，供 client 载入最新/合并。
        if (method === 'storyboard-save' && resolved && resolved.cwd && typeof input.title === 'string') {
          try {
            conflictHashes = await store.readStoryboardHashes(resolved.cwd, input.title, input.order)
            if (!currentHash) currentHash = conflictHashes.storyboard || null
          } catch {
            conflictHashes = null
          }
        }
        return reply(409, { ok: false, code: 'conflict', error: `${message}${next}`, currentHash, ...(conflictHashes ? { hashes: conflictHashes } : {}), ...(error && error.currentVersion !== undefined ? { currentVersion: error.currentVersion } : {}) })
      }
      // v0.16.24（Phase1 / A3 裁定）：asset-audio-save 遇 registry 损坏 → 400 registry-corrupt 且不写盘（不沿用 assets-import 的 409 语义）
      if (error && error.code === 'registry-corrupt' && method === 'asset-audio-save') {
        return fail(400, 'registry-corrupt', message)
      }
      if (error && error.code === 'registry-corrupt') {
        return reply(409, {
          ok: false,
          code: 'registry-corrupt',
          error: message,
          backup: error.backup || null,
          registryWarning: error.registryWarning || null,
          next: error.next || '可带 repairRegistry:true 重建后重试',
        })
      }
      // v0.16.194（P0-③）：删除被镜头绑定的状态 → 409 state-in-use（附引用列表；零写）
      if (error && error.code === 'state-in-use') {
        const references = Array.isArray(error.references) ? error.references : []
        return reply(409, {
          ok: false,
          code: 'state-in-use',
          error: message,
          cardId: error.cardId || null,
          stateId: error.stateId || null,
          references,
          referencesCount: references.length,
        })
      }
      // P2-5（v0.6.6）：参数校验错误明确映射 invalid-args（如 settings.generationLimits 非法值）
      if (error && error.code === 'invalid-args') return fail(400, 'invalid-args', message)
      // v0.15.8（task-125 / EXT-H1）：素材登记限项目内的安全错误码映射（仅新增 code 分支，旧行为不变）
      if (error && error.code === 'forbidden') return fail(403, 'forbidden', message)
      if (error && error.code === 'not-found') return fail(404, 'not-found', message)
      // v0.15.11（task-134 / IMP-H）：请求体/文件体积超限 → 413（仅新增 code 分支）
      if (error && error.code === 'too-large') return fail(413, 'too-large', message)
      // C2（E15/H-7）：视觉圣经状态机错误 —— 非法迁移 409 state-conflict；冻结期写 423 style-locked（body 顶层带当前 state/hash）
      if (error && error.code === 'state-conflict') {
        return reply(409, { ok: false, code: 'state-conflict', error: message, state: error.state || null, review: error.review || null, currentHash: error.currentHash || null })
      }
      // C3（E16/H-8）：final 卡写锁定 423 asset-locked（body 顶层带 review/currentHash/expectedHash；不写盘）
      if (error && error.code === 'asset-locked') {
        return reply(423, { ok: false, code: 'asset-locked', error: message, review: error.review || null, currentHash: error.currentHash || null, expectedHash: error.expectedHash || null })
      }
      if (error && error.code === 'style-locked') {
        return reply(423, { ok: false, code: 'style-locked', error: message, state: error.state || null, currentHash: error.currentHash || null })
      }
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
      // v0.16.128：会话附件 → 风格参考；仅 service 可用时 drama_add_asset attachmentId 分支生效。
      attachmentsOf: () => getService('attachments'),
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
      const header = agent && agent.session && agent.session.header ? agent.session.header : null
      const sessionId = header && typeof header.id === 'string' ? header.id.trim() : ''
      const projects = await store.listProjects(root).catch(() => [])
      const bindings = await store.readProjectSessions(root).catch(() => ({}))
      // v0.16.156（P0-1）：显式 title > 会话绑定 > 唯一项目 > unbound；禁止 listProjects()[0] mtime 回退。
      const resolved = resolveCurrentProject({
        titleHint: typeof titleHint === 'string' ? titleHint.trim() : '',
        sessionId,
        projects,
        bindings,
      })
      if (!resolved.title) {
        state.project = ''
        state.text = buildDramaContextCard({
          source: resolved.source,
          sessionId,
          projectCount: resolved.projectCount,
          lastWrite: state.lastWrite,
        })
        return
      }
      const title = resolved.title
      const [progress, contract, outline, characters, memory, episodes] = await Promise.all([
        store.getProgress(root, title).catch(() => ({})),
        store.getContract(root, title).catch(() => ({})),
        store.getOutline(root, title).catch(() => []),
        store.getCharacters(root, title).catch(() => []),
        store.getMemory(root, title).catch(() => []),
        store.listEpisodes(root, title).catch(() => []),
      ])
      state.project = title
      state.text = buildDramaContextCard({
        title,
        source: resolved.source,
        sessionId,
        projectCount: resolved.projectCount,
        progress,
        contract,
        outline,
        characters,
        memory,
        episodes,
        activeWarnings: (await buildBundledSkillInventory({ skillsDir: SKILLS_DIR, version: VERSION, config: (await store.getSettings(root).catch(() => null))?.skillConfig ?? null }).catch(() => null))?.activeWarnings,
        lastWrite: state.lastWrite,
      })
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
      await refreshAgentContext(agent, titleHint)
      return
    }
    if (titleHint && titleHint !== state.project) await refreshAgentContext(agent, titleHint)
  }

  // v0.16.156：暴露给模块级 dispatch（settings-save 后即时刷新对应会话卡；不新增 API）。
  runtimeContextBridge = { refreshAgentContext, contextByAgent }

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
      drama_write_content: (args) => {
        const kind = args && args.kind
        if (kind === 'contract') return ['剧集契约.md', '.aidrama/contract.json']
        if (kind === 'outline') return ['总纲/分集大纲.md', '.aidrama/outline.json']
        if (kind === 'characters') return ['人物/人物设定卡.md', '.aidrama/characters.json']
        if (kind === 'episode') return ['分集剧本']
        if (kind === 'storyboard') return ['分镜', '.aidrama/storyboard']
        if (kind === 'file' && args && args.path) return [String(args.path)]
        return null
      },
      drama_finalize_episode: () => ['定稿/定稿记录.md', '.aidrama/finalized.json'],
      drama_import_script: (args) => (args && args.action === 'apply' ? ['分集剧本'] : null),
      drama_add_asset: () => ['.aidrama/assets.json', '素材/素材清单.md'],
      drama_asset_save: (args) => [args && args.kind === 'scene' ? '.aidrama/scenes/cards.json' : '.aidrama/assets/cards.json'],
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
  世界观: '世界观设定（8 大类：天地地理 / 时间历史 / 力量法则 / 种族物种 / 社会政体 / 文化信仰 / 资源物产 / 冲突矛盾；可加道具/服饰等 extension 标签）',
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
        '生成结果请先用 drama_write_content 写入正式稿；交付前用 drama_check_consistency 自检并把问题清单一并报给我。',
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
    // v0.16.95（N1b add-only）：media-stream 原生路由状态（按需注册/释放）。
    mediaStream: { disposer: null, registered: false },
    // v0.16.59（Skill 管理 P0）：预设托管 provider ↔ 主插件 的内部桥（非 HTTP 契约）。
    skillListeners: new Set(),
    skillInventory: null,
    setSkillInventory: (fn) => {
      host.skillInventory = typeof fn === 'function' ? fn : null
    },
    onSkillConfigChanged: (listener) => {
      if (typeof listener !== 'function') return () => {}
      host.skillListeners.add(listener)
      return () => { host.skillListeners.delete(listener) }
    },
    notifySkillConfigChanged: (payload) => {
      for (const listener of [...host.skillListeners]) {
        try { listener(payload) } catch { /* 单个监听器异常不影响保存 */ }
      }
    },
    getSkillConfig: async (cwd) => {
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null
      try { return await store.getSettings(cwd) } catch { return null }
    },
  }
  ctx.provide('aiDramaHost', host)

  // RC-47（v0.16.168）：host 后台取回 worker。单 interval；初始化立即扫 sidecar；
  // status/assets 接口会 enqueueProject 懒恢复；dispose 通过 effect 清理。测试/特殊上下文可 config 关闭。
  if (config.assetGenerationBackground !== false) {
    const pluginGet = (name) => {
      try {
        if (typeof ctx.get === 'function') return ctx.get(name)
      } catch { /* ignore */ }
      return undefined
    }
    const discoverRoots = async () => {
      const roots = new Set()
      if (typeof config.root === 'string' && path.isAbsolute(config.root)) roots.add(config.root)
      const registry = pluginGet('workspaceRegistry') || (ctx && ctx.workspaceRegistry)
      if (registry && typeof registry.list === 'function') {
        try {
          for (const record of await registry.list()) {
            if (record && typeof record.path === 'string' && path.isAbsolute(record.path)) roots.add(record.path)
          }
        } catch { /* workspaceRegistry 暂不可用：等 interval 再试 */ }
      }
      const agentsService = pluginGet('agents') || (ctx && ctx.agents)
      if (agentsService && typeof agentsService.list === 'function') {
        try {
          for (const agent of await agentsService.list()) {
            const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : undefined
            if (typeof cwd === 'string' && path.isAbsolute(cwd)) roots.add(cwd)
          }
        } catch { /* ignore */ }
      }
      return [...roots]
    }
    try {
      const scheduler = createAssetGenerationScheduler({
        getRoots: discoverRoots,
        registry: host.backends,
        logger: ctx.logger,
      })
      host.assetScheduler = scheduler
      scheduler.start()
      try {
        ctx.effect(() => () => scheduler.stop(), 'ai-drama: asset generation background worker')
      } catch { /* 无 effect 能力的测试上下文 */ }
    } catch (error) {
      ctx.logger?.warn?.(`[ai-drama] 后台取回调度器启动失败：${error instanceof Error ? error.message : error}`)
    }
  }

  ctx.inject(['connection'], (scope) => {
    const handler = createHandler(scope, config, ctx, host)
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

  // v0.16.95（N1b add-only）：释放按需注册的 media-stream 原生路由。
  try {
    ctx.effect(() => () => {
      const state = host.mediaStream
      if (!state || typeof state.disposer !== 'function') return
      try { state.disposer() } catch { /* 释放失败不影响卸载 */ }
      state.disposer = null
      state.registered = false
    }, 'ai-drama: media-stream route')
  } catch { /* 无 effect 能力的测试上下文忽略 */ }
}

export { METHODS, VERSION }

