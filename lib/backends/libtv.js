/**
 * 阶段二 · 后端适配层：LibTV（主选后端，本地 CLI 通道）
 *
 * 架构更正（2026-10-16）：本插件最初按「LibTV 只有 Remote MCP、必须过 OAuth」设计，
 * 实测发现 **LibTV 有官方 CLI（libtv）**，本机已安装并已登录，能力覆盖
 * login / account / workspace / project(画布) / node / group / upload / download / image / script / model。
 * 因此主选后端与备选后端**形态一致**（都是本地子进程），不再需要 MCP 桥接，
 * 也不再需要为插件单独做 OAuth 授权。MCP 通道作为可选路径保留在文档里。
 *
 * 事实来源（均为 CLI 实际输出，非推测）：
 *   - `libtv --version` → 1.1.3
 *   - `libtv account info` → user.nickname 小小AIGC / memberAccount.memberName 豪华版VIP 连续包年
 *   - `libtv model search -t image` → {nodeType, query, matchKind, matches[20]}
 *   - `libtv model search -t video` → matches[34]，含 vip / pricingRule（**文字规则，非数字单价**）
 *   - `libtv node create <名> -t <类型> --prompt … -s model=<模型名> -r` → 新建并触发生成
 *   - `libtv download -n <节点> -o <目录> [--without-ai-watermark]` → 单节点直存文件（服务 FR-G05）
 *
 * 绑定语义：多数子命令默认读**当前目录**的 `.libtv/project.json`（`project use` 写入画布 UUID），
 * 所以适配器必须支持 `cwd`——每个短剧项目绑定自己的画布，互不干扰。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const execFileAsync = promisify(execFile)

export const BACKEND_ID = 'libtv'

/** 官方建议：长视频生成可能跑到 20 分钟量级，超时对齐 1200 秒（FR-G11）。 */
export const DEFAULT_TIMEOUT_MS = 1_200_000
const QUICK_TIMEOUT_MS = 90_000
const MAX_BUFFER = 32 * 1024 * 1024

/** 本机默认安装位置（来自 libtv-cli 技能的本机部署备注）。 */
export const DEFAULT_ENTRY = process.env.LIBTV_CLI_PATH || path.join(os.homedir(), '.libtv', 'libtv.exe')

/** 模型目录支持的节点类型。 */
export const CATALOG_TYPES = ['image', 'video', 'audio', 'text', 'script', 'storyboard']

export function parseCliError(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const line = lines.find((l) => /error|错误|失败|未登录|not logged|unauthor/i.test(l)) || lines[0] || ''
  return line.slice(0, 400) || '未知错误'
}

/** 列出目录下的文件名（目录不存在时返回空数组）。 */
async function listDir(dir) {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

/** 把 `model search` 的 matches 规范化成统一模型描述（原样保留平台字段）。 */
export function normalizeModels(payload) {
  const matches = payload && Array.isArray(payload.matches) ? payload.matches : []
  return matches.map((m) => ({
    modelKey: m.modelKey,
    modelName: m.modelName,
    aliasName: m.aliasName || null,
    description: m.description || '',
    vip: Boolean(m.vip),
    studio: Boolean(m.studio),
    estimatedTime: m.estimatedTime || null,
    // 平台给的是**文字计价规则**（如「按秒计价，参考视频时长计入总时长」），不是数字单价
    pricingRule: m.pricingRule || null,
    supportModality: m.supportModality || null,
  }))
}

/**
 * 把 `libtv node <名>` 的输出规范化为统一的节点状态。
 * CLI 的返回形状未在文档中固定，因此这里**容错解析**：认不出就返回 unknown，绝不猜成 done。
 * RC-32（v0.16.138）：真实 LibTV 输出落在 `data.url[]` + `data.taskInfo.{status,loading,progressPercent}`
 * （status: 1=进行中 / 2=成功 / 3=失败），旧版仅认 `resultData/urls/...`，导致已出图仍判 pending。
 */
function collectHttpUrls(value, out, depth = 0) {
  if (typeof value === 'string') {
    const text = value.trim()
    if (/^https?:\/\//i.test(text)) out.push(text)
    return
  }
  if (value == null || depth > 2) return
  if (Array.isArray(value)) {
    for (const item of value) collectHttpUrls(item, out, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  for (const key of ['url', 'urls', 'resultData', 'results', 'output', 'outputs', 'imgUrl', 'imageUrl', 'images', 'videos', 'audios', 'files', 'src', 'href']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) collectHttpUrls(value[key], out, depth + 1)
  }
}

export function normalizeNodeDetail(payload) {
  if (!payload) return { state: 'missing' }
  const nodes = Array.isArray(payload)
    ? payload
    : payload.nodes || payload.matches || payload.list || payload.items || [payload]
  const node = Array.isArray(nodes) && nodes.length ? nodes[0] : null
  if (!node || typeof node !== 'object') return { state: 'missing' }

  const data = node.data || {}
  const taskInfo = data.taskInfo && typeof data.taskInfo === 'object' && !Array.isArray(data.taskInfo)
    ? data.taskInfo
    : (node.taskInfo && typeof node.taskInfo === 'object' ? node.taskInfo : {})
  const urls = []
  for (const key of ['url', 'urls', 'resultData', 'results', 'output', 'outputs', 'imgUrl', 'imageUrl', 'images', 'videos', 'audios', 'files']) {
    collectHttpUrls(data[key], urls)
  }
  for (const key of ['url', 'urls', 'output', 'imgUrl', 'imageUrl']) collectHttpUrls(node[key], urls)
  const uniqueUrls = [...new Set(urls)]

  const statusValue = data.status ?? data.state ?? node.status ?? taskInfo.status ?? ''
  const status = typeof statusValue === 'string' ? statusValue.trim().toUpperCase() : String(statusValue)
  const numericStatusRaw = taskInfo.status != null ? taskInfo.status : (data.status != null ? data.status : node.status)
  const numericStatus = numericStatusRaw != null && Number.isFinite(Number(numericStatusRaw)) ? Number(numericStatusRaw) : null
  const loading = taskInfo.loading === true || data.loading === true
  const progressRaw = taskInfo.progressPercent != null ? taskInfo.progressPercent : data.progressPercent
  const progressPercent = progressRaw != null && Number.isFinite(Number(progressRaw)) ? Number(progressRaw) : null
  const message = taskInfo.errorMessage || taskInfo.error || data.errorMessage || data.error || node.errorMessage || null
  const successFlag = data.success === true || data.ok === true || taskInfo.success === true
  const failureFlag = data.success === false || data.ok === false || data.failed === true || taskInfo.failed === true

  let state = 'pending'
  if (failureFlag || numericStatus === 3 || /FAIL|ERROR|失败|CANCEL/.test(status)) state = 'failed'
  else if (loading) state = 'pending'
  else if (uniqueUrls.length) state = 'done'
  else if (successFlag) state = 'done'
  else if (numericStatus === 2) state = 'done'
  else if (/SUCCESS|DONE|FINISH|COMPLETE|完成/.test(status)) state = 'done'
  else if (/PENDING|RUNNING|GENERAT|QUEUED|排队|生成中/.test(status) || numericStatus === 0 || numericStatus === 1) state = 'pending'

  return {
    state,
    status: status || (numericStatus !== null ? String(numericStatus) : null),
    urls: uniqueUrls,
    taskId: data.taskId || taskInfo.taskId || node.taskId || null,
    nodeKey: node.nodeKey || node.id || node.uuid || null,
    message,
    ...(progressPercent !== null ? { progressPercent } : {}),
    ...(numericStatus !== null ? { taskStatus: numericStatus } : {}),
    ...(loading ? { loading: true } : {}),
  }
}

/**
 * 规范化画布列表（`libtv project list` → { projectMetaList: [...] }）。
 */
export function normalizeCanvasList(payload) {
  const list = payload && Array.isArray(payload.projectMetaList) ? payload.projectMetaList : []
  return list.map((p) => ({
    uuid: p.uuid,
    id: p.id ?? null,
    name: p.name || '(未命名画布)',
    visibility: p.visibility ?? null,
    ownerId: p.ownerId ?? null,
  }))
}

/**
 * 规范化节点列表。CLI 未固化该输出形状，因此**容错**：认不出就返回空数组，
 * 由调用方按"未知"处理，绝不臆造节点。
 */
export function normalizeNodeList(payload) {
  if (!payload) return []
  const raw = Array.isArray(payload)
    ? payload
    : payload.nodes || payload.nodeList || payload.list || payload.items || payload.childNodes || []
  if (!Array.isArray(raw)) return []
  return raw
    .map((n) => {
      if (typeof n === 'string') return { key: n, name: n }
      if (!n || typeof n !== 'object') return null
      const key = n.nodeKey || n.id || n.uuid || n.name || null
      if (!key) return null
      return { key: String(key), name: String(n.name || n.nodeName || n.title || key), type: n.type || n.nodeType || null }
    })
    .filter(Boolean)
}

/** v0.16.226 P0-A2：LibTV -s/-u 值序列化（对象/数组 JSON）。 */
function serializeCliValue(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try { return JSON.stringify(value) } catch { return String(value) }
}

/** v0.16.260：LibTV CLI 的 `-s model` 需要**显示名（modelName）**，这里把 modelKey 映射过去。 */
const LIBTV_VIDEO_MODEL_NAME_BY_KEY = Object.freeze({
  'star-video2.5': 'Seedance 2.5',
  'star-video2.5-draft': 'Seedance 2.5（样片模式）',
  'star-video2': 'Seedance 2.0 VIP',
  'wanx3.0': 'Wan 3.0',
  'kling-v4': 'Kling 4.0',
  'MiniMax-Hailuo-H3': 'Minimax H3',
  'minimax-h3-hs': 'H3-Highspeed',
})

function libtvModelArgName(model) {
  const raw = String(model == null ? '' : model).trim()
  if (!raw) return ''
  return LIBTV_VIDEO_MODEL_NAME_BY_KEY[raw] || raw
}

/** v0.16.251：LibTV video schema 的实际 `-s` 键/值（来自 `libtv model star-video2.5`）。 */
export const LIBTV_VIDEO_PARAM_SPEC = Object.freeze({
  ratio: Object.freeze({ key: 'ratio', allowed: Object.freeze(['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9']), aliases: Object.freeze({ auto: 'adaptive' }) }),
  resolution: Object.freeze({ key: 'resolution', allowed: Object.freeze(['480p', '720p', '1080p']) }),
  duration: Object.freeze({ key: 'duration', min: 4, max: 30 }),
  enableSound: Object.freeze({ key: 'enableSound', values: Object.freeze({ true: 'on', false: 'off' }) }),
})

function invalidVideoParam(field, detail) {
  const error = new Error(`LibTV 视频参数 ${field} 非法${detail ? '：' + detail : ''}`)
  error.code = 'invalid-args'
  return error
}

/**
 * v0.16.251：把调用方视频参数映射为 LibTV CLI 实际 `-s` 键值。
 * 仅处理显式提供的参数；缺省不传。返回 `{ params, mapped }`：
 * - params 为未被消费的其它参数（继续走通用 -s）
 * - mapped 为已校验的 LibTV 键值
 */
export function normalizeLibtvVideoParams(params) {
  const input = params && typeof params === 'object' && !Array.isArray(params) ? params : {}
  const rest = { ...input }
  const mapped = {}
  const take = (name) => {
    if (!Object.prototype.hasOwnProperty.call(rest, name)) return false
    if (rest[name] === undefined) {
      delete rest[name]
      return false
    }
    const value = rest[name]
    delete rest[name]
    return { value }
  }
  const ratio = take('ratio')
  if (ratio) {
    const raw = typeof ratio.value === 'string' ? ratio.value.trim() : ''
    if (!raw) throw invalidVideoParam('ratio')
    const normalized = LIBTV_VIDEO_PARAM_SPEC.ratio.aliases[raw] || raw
    if (!LIBTV_VIDEO_PARAM_SPEC.ratio.allowed.includes(normalized)) {
      throw invalidVideoParam('ratio', `${raw}（允许 auto/${LIBTV_VIDEO_PARAM_SPEC.ratio.allowed.join('/')}）`)
    }
    mapped.ratio = normalized
  }
  const resolution = take('resolution')
  if (resolution) {
    const raw = typeof resolution.value === 'string' ? resolution.value.trim().toLowerCase() : ''
    if (!LIBTV_VIDEO_PARAM_SPEC.resolution.allowed.includes(raw)) {
      throw invalidVideoParam('resolution', `${String(resolution.value)}（允许 480P/720P/1080P）`)
    }
    mapped.resolution = raw
  }
  const duration = take('duration')
  if (duration) {
    const value = duration.value
    if (typeof value !== 'number' || !Number.isInteger(value) || value < LIBTV_VIDEO_PARAM_SPEC.duration.min || value > LIBTV_VIDEO_PARAM_SPEC.duration.max) {
      throw invalidVideoParam('duration', `${String(value)}（需 ${LIBTV_VIDEO_PARAM_SPEC.duration.min}–${LIBTV_VIDEO_PARAM_SPEC.duration.max} 秒整数）`)
    }
    mapped.duration = value
  }
  const enableSound = take('enableSound')
  if (enableSound) {
    const value = enableSound.value
    if (value === true || value === 'on') mapped.enableSound = 'on'
    else if (value === false || value === 'off') mapped.enableSound = 'off'
    else throw invalidVideoParam('enableSound', '必须是 true/false 或 on/off')
  }
  const count = take('count')
  if (count) {
    const value = count.value
    if (typeof value !== 'number' || value !== 1) {
      throw invalidVideoParam('count', `${String(value)}（本版固定 1；多份下一版）`)
    }
    // count=1 保持旧 args（通用 -s count=1），不纳入本版映射表。
    rest.count = value
  }
  return { params: rest, mapped }
}

/** v0.16.261：视频参考模式（与 client/canvas 同口径）。 */
export const LIBTV_VIDEO_MODES = Object.freeze(['mixed2video', 'singleImage2video', 'text2video'])
function normalizeLibtvVideoMode(mode) {
  if (mode == null || mode === '') return null
  const value = String(mode).trim()
  if (!LIBTV_VIDEO_MODES.includes(value)) {
    const error = new Error(`视频生成模式非法：${value}（允许 ${LIBTV_VIDEO_MODES.join('/')}）`)
    error.code = 'invalid-args'
    throw error
  }
  return value
}

/** 从 CLI 返回容错提取节点 key。 */
function nodeKeyOf(payload) {
  if (!payload || typeof payload !== 'object') return null
  const candidates = [
    payload.nodeKey,
    payload.newNodeKey,
    payload.id,
    payload.uuid,
    payload.reactFlowNode && payload.reactFlowNode.id,
    payload.node && payload.node.nodeKey,
    payload.node && payload.node.id,
    Array.isArray(payload.nodes) && payload.nodes[0] && (payload.nodes[0].nodeKey || payload.nodes[0].id),
    Array.isArray(payload.matches) && payload.matches[0] && (payload.matches[0].nodeKey || payload.matches[0].id),
  ]
  const found = candidates.find((item) => typeof item === 'string' && item.trim())
  return found ? String(found) : null
}

export function createLibtvBackend(config = {}) {
  const entry = config.entry || DEFAULT_ENTRY
  // 真实部署下 entry 是 libtv.exe，直接用；测试或脚本形态入口可指定 nodeBin 以脚本方式运行
  const nodeBin = config.nodeBin || null
  const extraEnv = config.env && typeof config.env === 'object' ? config.env : null
  let catalogCache = null

  async function exists() {
    // 允许直接给命令名（PATH 解析）或绝对路径
    if (!path.isAbsolute(entry)) return true
    try {
      await fs.access(entry)
      return true
    } catch {
      return false
    }
  }

  async function runCli(args, options = {}) {
    const timeout = options.timeoutMs ?? QUICK_TIMEOUT_MS
    const file = nodeBin || entry
    const argv = nodeBin ? [entry, ...args] : args
    try {
      const { stdout, stderr } = await execFileAsync(file, argv, {
        timeout,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        cwd: options.cwd || config.cwd || process.cwd(),
        ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
      })
      return { ok: true, stdout: stdout || '', stderr: stderr || '' }
    } catch (error) {
      return {
        ok: false,
        stdout: error && error.stdout ? error.stdout : '',
        stderr: error && error.stderr ? error.stderr : '',
        killed: Boolean(error && error.killed),
      }
    }
  }

  function parseJson(result) {
    const text = String(result.stdout || '').trim()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      const line = text.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'))
      if (!line) return null
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    }
  }

  return {
    id: BACKEND_ID,
    kind: 'cli',
    label: 'LibTV（画布 CLI）',
    priority: 1,
    entry,

    async available() {
      if (!(await exists())) {
        return { ok: false, reason: 'cli-missing', detail: `未找到 libtv CLI：${entry}` }
      }
      const result = await runCli(['account', 'info'], { timeoutMs: QUICK_TIMEOUT_MS })
      const data = parseJson(result)
      if (!data || !data.user) {
        return { ok: false, reason: 'not-logged-in', detail: parseCliError(result.stderr || result.stdout), entry }
      }
      const member = (data.activeAccount && data.activeAccount.memberAccount) || {}
      const vip = Boolean(member.effective)
      return {
        ok: true,
        loggedIn: true,
        entry,
        nickname: data.user.nickname,
        accountName: data.activeAccount ? data.activeAccount.accountName : null,
        membership: member.memberName || null,
        vip,
        detail: `${data.user.nickname}${member.memberName ? '（' + member.memberName + '）' : ''}`,
        capabilities: { catalog: true, estimateImage: false, estimateVideo: false, generate: true, download: true, upload: true, createNodeNoRun: true, updateNode: true, listNodes: true, runNode: true },
      }
    },

    /** 模型目录：libtv model search -t <type>。无需额外权限，登录即可。 */
    async catalog(kind = 'image', options = {}) {
      const type = CATALOG_TYPES.includes(kind) ? kind : 'image'
      if (catalogCache && !options.refresh && catalogCache[type]) return catalogCache[type]
      const result = await runCli(['model', 'search', '-t', type], { timeoutMs: QUICK_TIMEOUT_MS })
      const data = parseJson(result)
      if (!data) throw new Error(`读取 LibTV ${type} 模型目录失败：${parseCliError(result.stderr || result.stdout)}`)
      const models = normalizeModels(data)
      catalogCache = catalogCache || {}
      catalogCache[type] = models
      return models
    },

    /**
     * LibTV 的模型目录只给**文字计价规则**（pricingRule）与预计耗时，没有数字单价，
     * 因此不产出积分数值——把平台原文如实返回，定价判断留给用户。
     */
    async estimate(input) {
      const kind = input.kind || 'image'
      let models
      try {
        models = await this.catalog(kind)
      } catch (error) {
        return { ok: false, reason: 'catalog-failed', detail: error instanceof Error ? error.message : String(error) }
      }
      const model = models.find((m) => m.modelKey === input.model || m.modelName === input.model)
      if (!model) return { ok: false, reason: 'model-not-found', detail: `目录中没有模型 ${input.model || '(未指定)'}` }
      return {
        ok: false,
        reason: 'textual-pricing',
        detail: model.pricingRule || '该模型未提供计价规则文本',
        model: model.modelKey,
        modelName: model.modelName,
        estimatedTime: model.estimatedTime,
        vip: model.vip,
        note: 'LibTV 目录不提供数字单价，插件不本地推算；请按平台计价规则与实际账单判断',
      }
    },

    /** 生成：新建节点并触发生成（FR-G02/G03/G04 的原语）。 */
    async generate(input) {
      const kind = input.kind || 'image'
      let mode = normalizeLibtvVideoMode(input.mode)
      const explicitMode = Boolean(mode)
      let references = kind === 'video' && Array.isArray(input.references)
        ? input.references.filter((file) => typeof file === 'string' && path.isAbsolute(file)).slice(0, 30)
        : []
      const referenceWarnings = []
      if (kind === 'video') {
        if (!mode) mode = references.length === 0 ? 'text2video' : (references.length === 1 ? 'singleImage2video' : 'mixed2video')
        if (mode === 'text2video') references = []
        else if (mode === 'singleImage2video') {
          if (references.length > 1) referenceWarnings.push({ code: 'reference_trimmed_single', message: '图生视频仅使用第 1 张参考图' })
          references = references.slice(0, 1)
        }
      }
      const uploaded = []
      const cleanup = async () => {
        if (typeof this.deleteNode !== 'function') return
        for (const row of uploaded) await this.deleteNode({ name: row.nodeKey || row.nodeName, project: input.project, cwd: input.cwd }).catch(() => {})
      }
      try {
        for (let index = 0; index < references.length; index += 1) {
          const file = references[index]
          const stat = await fs.stat(file).catch(() => null)
          if (!stat || !stat.isFile()) {
            referenceWarnings.push({ code: 'reference_missing', path: file, message: `参考图文件不存在：${file}` })
            continue
          }
          const uploadedNode = await this.upload({
            name: `${input.name}-ref-${index + 1}`,
            file,
            kind: 'image',
            project: input.project,
            cwd: input.cwd,
          })
          uploaded.push({ nodeName: uploadedNode.node, nodeKey: uploadedNode.nodeKey })
        }
      } catch (error) {
        await cleanup()
        throw error
      }
      if (kind === 'video') {
        if (mode === 'singleImage2video' && uploaded.length === 0) {
          await cleanup()
          const error = new Error('图生视频需要至少 1 张已绑定且存在的资产参考图；请先绑定资产/补图')
          error.code = 'invalid-args'
          throw error
        }
        if (mode === 'mixed2video' && uploaded.length === 0) {
          mode = 'text2video'
          referenceWarnings.push({ code: 'reference_fallback_text', message: '全能参考未找到可用参考图，已回退文生视频' })
        }
      }
      const args = ['node', 'create', input.name, '-t', input.kind, '-r']
      if (input.prompt) args.push('--prompt', input.prompt)
      const modelArgName = libtvModelArgName(input.model)
      if (modelArgName) args.push('-s', `model=${modelArgName}`)
      // v0.16.251：video 参数按 LibTV schema 映射为实际 -s 键值；非法 → invalid-args，零 CLI 调用。
      const normalized = input.kind === 'video'
        ? normalizeLibtvVideoParams(input.params)
        : { params: input.params || {}, mapped: {} }
      // v0.16.263：model 已单独推 -s，先从 params/mapped 删除，避免 `--set` key 重复
      delete (normalized.params || {}).model
      delete (normalized.mapped || {}).model
      if (kind === 'video' && mode && (uploaded.length > 0 || explicitMode)) {
        delete normalized.params.modeType
        args.push('-s', `modeType=${mode}`)
      }
      for (const [k, v] of Object.entries(normalized.mapped)) args.push('-s', `${k}=${v}`)
      for (const [k, v] of Object.entries(normalized.params)) args.push('-s', `${k}=${v}`)
      for (const left of Array.isArray(input.left) ? input.left : (input.left ? [input.left] : [])) args.push('--left', left)
      for (const row of uploaded) args.push('--left', row.nodeKey || row.nodeName)
      for (const [k, v] of Object.entries(input.meta || {})) args.push('-u', `${k}=${serializeCliValue(v)}`)
      if (input.project) args.push('-p', input.project)
      try {
        const result = await runCli(args, { timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS, cwd: input.cwd })
        const data = parseJson(result)
        if (!result.ok && !data) throw new Error(`LibTV 生成失败：${parseCliError(result.stderr || result.stdout)}`)
        return { ok: true, raw: data, node: input.name, mode, effectiveMode: kind === 'video' ? mode : null, referenceCount: uploaded.length, references: uploaded, ...(referenceWarnings.length ? { referenceWarnings } : {}) }
      } catch (error) {
        await cleanup()
        throw error
      }
    },

    /** v0.16.220 P0-B：上传本地参考图/媒体为资源节点（不带 -r，不触发生成）。 */
    async upload(input) {
      const name = String(input && input.name || '').trim()
      const file = String(input && input.file || '').trim()
      if (!name) throw new Error('LibTV upload 需要资源节点名')
      if (!file || !path.isAbsolute(file)) throw new Error('LibTV upload 需要项目内绝对文件路径')
      const args = ['upload', name, '-f', file]
      if (input.kind) args.push('-t', input.kind)
      if (input.project) args.push('-p', input.project)
      const result = await runCli(args, { timeoutMs: input.timeoutMs ?? QUICK_TIMEOUT_MS, cwd: input.cwd })
      const data = parseJson(result)
      if (!result.ok && !data) throw new Error(`LibTV 上传失败：${parseCliError(result.stderr || result.stdout)}`)
      return { ok: true, raw: data, node: name, nodeKey: nodeKeyOf(data) || name }
    },

    /** v0.16.261：清理失败上传产生的临时节点（内部方法，非新 API/METHOD）。 */
    async deleteNode(input = {}) {
      const name = String(input.name || '').trim()
      if (!name) return { ok: false, reason: 'name-required' }
      const args = ['node', 'delete', name]
      if (input.project) args.push('-p', input.project)
      const result = await runCli(args, { timeoutMs: input.timeoutMs ?? QUICK_TIMEOUT_MS, cwd: input.cwd })
      const data = parseJson(result)
      if (!result.ok && !data) throw new Error(`LibTV 删除节点失败：${parseCliError(result.stderr || result.stdout)}`)
      return { ok: true, raw: data, node: name }
    },

    /** v0.16.220 P0-B：只读查询单节点（返回 raw，供 metadata/边校验）。 */
    async nodeGet(node, options = {}) {
      const args = ['node', String(node || '')]
      if (options.project) args.push('-p', options.project)
      const result = await runCli(args, { timeoutMs: options.timeoutMs ?? QUICK_TIMEOUT_MS, cwd: options.cwd })
      const data = parseJson(result)
      if (!data) throw new Error(`读取节点失败：${parseCliError(result.stderr || result.stdout)}`)
      return { ok: true, raw: data, node: String(node || ''), nodeKey: nodeKeyOf(data) || null }
    },

    /** v0.16.220 P0-B：建节点/连线/写 prompt+metadata，但**不带 -r**（dry-run 零积分）。 */
    async createNodeNoRun(input) {
      const name = String(input && input.name || '').trim()
      if (!name) throw new Error('LibTV createNodeNoRun 需要节点名')
      const args = ['node', 'create', name, '-t', input.kind || 'image']
      if (input.prompt) args.push('--prompt', input.prompt)
      const modelArgName = libtvModelArgName(input.model)
      if (modelArgName) args.push('-s', `model=${modelArgName}`)
      // v0.16.263：modeType 单独推一次（调用方显式值优先），避免与 createParams 重复
      if (input.params && input.params.modeType) args.push('-s', `modeType=${String(input.params.modeType)}`)
      const createParams = { ...(input.params || {}) }
      delete createParams.model
      delete createParams.modeType
      const lefts = Array.isArray(input.left) ? input.left : (input.left ? [input.left] : [])
      // LibTV 校验：video 节点连接图片输入时不能保持 text2video；dry-run 自动切 image2video。
      // v0.16.263：调用方显式传 modeType（singleImage2video/mixed2video）时不再默认覆盖为 image2video
      if ((input.kind || 'image') === 'video' && lefts.length && !(input.params && input.params.modeType)) args.push('-s', 'modeType=image2video')
      for (const [k, v] of Object.entries(createParams)) args.push('-s', `${k}=${v}`)
      // CLI 不允许 --left 与 --left-add 同用：单边用 --left，多边全部用 --left-add。
      if (lefts.length === 1) { if (lefts[0]) args.push('--left', String(lefts[0])) }
      else for (const left of lefts) if (left) args.push('--left-add', String(left))
      for (const [k, v] of Object.entries(input.meta || {})) args.push('-u', `${k}=${serializeCliValue(v)}`)
      if (input.project) args.push('-p', input.project)
      const result = await runCli(args, { timeoutMs: input.timeoutMs ?? QUICK_TIMEOUT_MS, cwd: input.cwd })
      const data = parseJson(result)
      if (!result.ok && !data) throw new Error(`LibTV 建节点失败：${parseCliError(result.stderr || result.stdout)}`)
      return { ok: true, raw: data, node: name, nodeKey: nodeKeyOf(data) || name }
    },

    /** v0.16.220 P0-B：幂等更新已有节点（prompt/--left 确保/ -u metadata；不触发 -r）。 */
    async updateNode(input) {
      const name = String(input && input.name || '').trim()
      if (!name) throw new Error('LibTV updateNode 需要节点名')
      const args = ['node', name]
      if (input.prompt) args.push('--prompt', input.prompt)
      const params = { ...(input.params || {}) }
      const modelInput = Object.prototype.hasOwnProperty.call(params, 'model') ? params.model : input.model
      delete params.model
      if (modelInput != null && typeof modelInput !== 'string') {
        const error = new Error('LibTV updateNode model 必须是字符串（modelKey 或模型名）')
        error.code = 'invalid-args'
        throw error
      }
      const modelArgName = libtvModelArgName(modelInput)
      if (modelArgName) args.push('-s', `model=${modelArgName}`)
      const seenSetKeys = new Set(['model'])
      for (const [k, v] of Object.entries(params)) {
        if (seenSetKeys.has(k)) continue
        seenSetKeys.add(k)
        args.push('-s', `${k}=${v}`)
      }
      const lefts = Array.isArray(input.left) ? input.left : (input.left ? [input.left] : [])
      // CLI 不允许 --left 与 --left-add 同用：单边用 --left，多边全部用 --left-add（ensure/追加由 CLI 去重）。
      if (lefts.length === 1) { if (lefts[0]) args.push('--left', String(lefts[0])) }
      else for (const left of lefts) if (left) args.push('--left-add', String(left))
      for (const [k, v] of Object.entries(input.meta || {})) args.push('-u', `${k}=${serializeCliValue(v)}`)
      if (input.project) args.push('-p', input.project)
      const result = await runCli(args, { timeoutMs: input.timeoutMs ?? QUICK_TIMEOUT_MS, cwd: input.cwd })
      const data = parseJson(result)
      if (!result.ok && !data) throw new Error(`LibTV 更新节点失败：${parseCliError(result.stderr || result.stdout)}`)
      return { ok: true, raw: data, node: name, nodeKey: nodeKeyOf(data) || null }
    },


    /** v0.16.233：在已建/已连边的节点上触发真实生成（`node <名> --run`，同步等待终端）。 */
    async runNode(input = {}) {
      const name = String(input && input.name || '').trim()
      if (!name) throw new Error('LibTV runNode 需要节点名')
      const project = String(input && input.project || '').trim()
      if (!project) throw new Error('LibTV runNode 需要画布 UUID')
      const args = ['node', name, '--run', '-p', project]
      const result = await runCli(args, { timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS, cwd: input.cwd })
      const data = parseJson(result)
      if (!result.ok && !data) throw new Error(`LibTV 生成失败：${parseCliError(result.stderr || result.stdout)}`)
      return { ok: true, raw: data, node: name, nodeKey: nodeKeyOf(data) || null }
    },

    /** 画布列表（无需绑定即可读）。FR-G08 的选画布入口。 */
    async listCanvases(options = {}) {
      const result = await runCli(['project', 'list'], { timeoutMs: QUICK_TIMEOUT_MS, cwd: options.cwd })
      const data = parseJson(result)
      if (!data) throw new Error(`读取画布列表失败：${parseCliError(result.stderr || result.stdout)}`)
      return normalizeCanvasList(data)
    },

    /** 把某个目录绑定到画布（写 `.libtv/project.json`）。 */
    async bindCanvas(input) {
      if (!input || !input.uuid) throw new Error('需要画布 UUID')
      const result = await runCli(['project', 'use', input.uuid], { timeoutMs: QUICK_TIMEOUT_MS, cwd: input.cwd })
      if (!result.ok) throw new Error(`绑定画布失败：${parseCliError(result.stderr || result.stdout)}`)
      return { ok: true, uuid: input.uuid, cwd: input.cwd }
    },

    /** 列出画布上的节点（需要绑定）。FR-G08 的指纹来源。 */
    async listNodes(options = {}) {
      const args = ['node', 'list']
      if (options.project) args.push('-p', options.project)
      const result = await runCli(args, { timeoutMs: QUICK_TIMEOUT_MS, cwd: options.cwd })
      const data = parseJson(result)
      if (!data) {
        if (!result.ok) throw new Error(parseCliError(result.stderr || result.stdout))
        return []
      }
      return normalizeNodeList(data)
    },

    /** 查询节点状态（`libtv node <名>` 不带写参即列出匹配项）。 */
    async nodeDetail(node, options = {}) {
      const args = ['node', node]
      if (options.project) args.push('-p', options.project)
      const result = await runCli(args, { timeoutMs: options.timeoutMs ?? QUICK_TIMEOUT_MS, cwd: options.cwd })
      const data = parseJson(result)
      if (!data) {
        if (!result.ok) return { state: 'unknown', message: parseCliError(result.stderr || result.stdout) }
        return { state: 'missing' }
      }
      return normalizeNodeDetail(data)
    },

    /** 取产物到本地（FR-G05）。单节点图片/视频/音频直存文件；返回新增的文件列表。 */
    async download(input) {
      const args = ['download', '-n', input.node, '-o', input.outDir]
      if (input.project) args.push('-p', input.project)
      if (input.withoutWatermark) args.push('--without-ai-watermark')

      // 用前后目录差集判断新增了哪些文件，比解析 stdout 稳定
      const before = await listDir(input.outDir)
      const result = await runCli(args, { timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS, cwd: input.cwd })
      if (!result.ok) throw new Error(`LibTV 下载失败：${parseCliError(result.stderr || result.stdout)}`)
      const after = await listDir(input.outDir)
      const files = after.filter((f) => !before.includes(f)).map((f) => path.join(input.outDir, f))
      return { ok: true, files, stdout: String(result.stdout || '').trim() }
    },

    runCli,
    parseJson,
  }
}

