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

const execFileAsync = promisify(execFile)

export const BACKEND_ID = 'libtv'

/** 官方建议：长视频生成可能跑到 20 分钟量级，超时对齐 1200 秒（FR-G11）。 */
export const DEFAULT_TIMEOUT_MS = 1_200_000
const QUICK_TIMEOUT_MS = 90_000
const MAX_BUFFER = 32 * 1024 * 1024

/** 本机默认安装位置（来自 libtv-cli 技能的本机部署备注）。 */
export const DEFAULT_ENTRY = 'C:\\Users\\Administrator\\.libtv\\libtv.exe'

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
 */
export function normalizeNodeDetail(payload) {
  if (!payload) return { state: 'missing' }
  const nodes = Array.isArray(payload)
    ? payload
    : payload.nodes || payload.matches || payload.list || payload.items || [payload]
  const node = Array.isArray(nodes) && nodes.length ? nodes[0] : null
  if (!node || typeof node !== 'object') return { state: 'missing' }

  const data = node.data || {}
  const urls = []
  for (const key of ['resultData', 'results', 'urls', 'outputs', 'images', 'videos', 'audios', 'files']) {
    const value = data[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && /^https?:/i.test(item)) urls.push(item)
        else if (item && typeof item === 'object' && typeof item.url === 'string') urls.push(item.url)
      }
    } else if (typeof value === 'string' && /^https?:/i.test(value)) {
      urls.push(value)
    }
  }

  const status = String(data.status || data.state || node.status || '').toUpperCase()
  let state = 'pending'
  if (/FAIL|ERROR|失败/.test(status)) state = 'failed'
  else if (urls.length) state = 'done'
  else if (/SUCCESS|DONE|FINISH|完成/.test(status)) state = urls.length ? 'done' : 'pending'

  return {
    state,
    status: status || null,
    urls,
    taskId: data.taskId || null,
    nodeKey: node.nodeKey || node.id || node.uuid || null,
    message: data.errorMessage || data.message || null,
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
        capabilities: { catalog: true, estimateImage: false, estimateVideo: false, generate: true, download: true },
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
      const args = ['node', 'create', input.name, '-t', input.kind, '-r']
      if (input.prompt) args.push('--prompt', input.prompt)
      if (input.model) args.push('-s', `model=${input.model}`)
      for (const [k, v] of Object.entries(input.params || {})) args.push('-s', `${k}=${v}`)
      if (input.project) args.push('-p', input.project)
      const result = await runCli(args, { timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS, cwd: input.cwd })
      const data = parseJson(result)
      if (!result.ok && !data) throw new Error(`LibTV 生成失败：${parseCliError(result.stderr || result.stdout)}`)
      return { ok: true, raw: data, node: input.name }
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
