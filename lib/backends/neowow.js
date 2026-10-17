/**
 * 阶段二 · 后端适配层：NeoWoW 画布 CLI（备选后端，本地子进程通道）
 *
 * 设计要点：
 * - CLI 以子进程方式驱动，成功时 stdout 为单行 JSON，失败为 stderr 一行
 *   `[neowow] <message> | errCode=… | http=…`（见技能包 SKILL.md 的输出契约）。
 * - **模型目录与图片价目表无需登录即可获取**，因此成本预估可以在未授权状态下工作。
 * - 视频没有本地价目（模型目录不含每秒单价），因此不猜价：拿不到就如实返回 null。
 * - 超时对齐官方建议（视频长任务），见 FR-G11。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

export const BACKEND_ID = 'neowow'

/** 官方 SKILL.md 把视频工具超时设为 1200 秒；这里对齐（FR-G11）。 */
export const DEFAULT_TIMEOUT_MS = 1_200_000
const QUICK_TIMEOUT_MS = 60_000
const MAX_BUFFER = 32 * 1024 * 1024

export function defaultEntry() {
  return path.join(os.homedir(), '.agents', 'skills', 'neowow-canvas', 'bin', 'neowow.mjs')
}

/** 解析 CLI 的致命错误行；解析不出来就原样返回首行。 */
export function parseCliError(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const line = lines.find((l) => l.includes('[neowow]')) || lines[0] || ''
  if (!line) return { message: '未知错误', code: null, http: null }
  const message = line.replace(/^\[neowow\]\s*/, '').split('|')[0].trim()
  const code = (line.match(/errCode=([^\s|]+)/) || [])[1] || null
  const http = (line.match(/http=([^\s|]+)/) || [])[1] || null
  return { message, code, http }
}

/**
 * 图片积分估算：单价 = `quality_size` 组合键 > `size` 键 > `points_cost_per_image` 兜底。
 * 这条优先级来自官方 `models image` 的 note 字段，不是我们自己定的。
 */
export function estimateImagePoints(model, options = {}) {
  if (!model) return null
  const size = String(options.size || '1K')
  const quality = options.quality ? String(options.quality) : null
  const count = Math.max(1, Math.round(Number(options.count) || 1))
  const config = model.size_pricing_config || {}
  const comboKey = quality ? `${quality}_${size.toLowerCase()}` : null

  let unit = null
  let basis = null
  if (comboKey && typeof config[comboKey] === 'number') {
    unit = config[comboKey]
    basis = comboKey
  } else if (typeof config[size] === 'number') {
    unit = config[size]
    basis = size
  } else if (typeof model.points_cost_per_image === 'number') {
    unit = model.points_cost_per_image
    basis = 'points_cost_per_image'
  }
  if (unit == null) return null
  return { unit, count, total: unit * count, basis, currency: 'points' }
}

export function createNeowowBackend(config = {}) {
  const entry = config.entry || defaultEntry()
  const nodeBin = config.nodeBin || process.execPath
  // 允许注入额外环境变量（例如 NEOWOW_API_KEY / NEOWOW_BASE / NEOWOW_CONFIG_DIR）
  const extraEnv = config.env && typeof config.env === 'object' ? config.env : null
  let catalogCache = null

  async function exists() {
    try {
      await fs.access(entry)
      return true
    } catch {
      return false
    }
  }

  async function runCli(args, options = {}) {
    const timeout = options.timeoutMs ?? QUICK_TIMEOUT_MS
    try {
      const { stdout, stderr } = await execFileAsync(nodeBin, [entry, ...args], {
        timeout,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        cwd: options.cwd,
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
      // 取最后一行 JSON（stderr 可能混入进度行）
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
    label: 'NeoWoW 画布（CLI）',
    priority: 2,

    async available() {
      if (!(await exists())) {
        return { ok: false, reason: 'cli-missing', detail: `未找到 neowow CLI：${entry}` }
      }
      const result = await runCli(['status'], { timeoutMs: QUICK_TIMEOUT_MS })
      const data = parseJson(result)
      if (!data) {
        const error = parseCliError(result.stderr)
        return { ok: false, reason: 'cli-error', detail: error.message }
      }
      return {
        ok: true,
        loggedIn: Boolean(data.loggedIn),
        build: data.build,
        base: data.base,
        keySource: data.keySource,
        boundSessionId: data.boundSessionId,
        detail: data.loggedIn ? '已登录' : '未登录（生成类操作需要 API Key）',
        // 未登录也能读模型目录与图片价目，因此成本预估不受影响
        capabilities: { catalog: true, estimateImage: true, estimateVideo: Boolean(data.loggedIn), generate: Boolean(data.loggedIn) },
      }
    },

    /** 模型目录（无需登录）。kind: image | video | voice */
    async catalog(kind = 'image', options = {}) {
      if (catalogCache && !options.refresh && catalogCache[kind]) return catalogCache[kind]
      const result = await runCli(['models', kind], { timeoutMs: QUICK_TIMEOUT_MS })
      const data = parseJson(result)
      if (!data) {
        const error = parseCliError(result.stderr)
        throw new Error(`读取 ${kind} 模型目录失败：${error.message}`)
      }
      const models = data.models || []
      catalogCache = catalogCache || {}
      catalogCache[kind] = models
      return models
    },

    async estimate(input) {
      const kind = input.kind || 'image'
      if (kind === 'image') {
        const models = await this.catalog('image')
        const model = models.find((m) => m.model_name === input.model)
        if (!model) return { ok: false, reason: 'model-not-found', detail: `目录中没有模型 ${input.model}` }
        const points = estimateImagePoints(model, input)
        if (!points) return { ok: false, reason: 'no-pricing', detail: '该模型未提供可用的积分矩阵' }
        return { ok: true, backend: BACKEND_ID, kind, model: input.model, points, note: '积分以官方 dry-run 的 estimate 为准，此处按目录矩阵本地推算' }
      }
      if (kind === 'video' || kind === 'audio') {
        // 视频/音频没有本地价目：不猜价，如实返回不可估算
        return {
          ok: false,
          reason: 'no-local-pricing',
          detail: '该类型没有本地价目表，需要登录后调用 dry-run 才能拿到官方 estimate',
          requiresLogin: true,
        }
      }
      return { ok: false, reason: 'unsupported-kind', detail: `不支持的类型：${kind}` }
    },

    runCli,
    parseJson,
    parseCliError,
    entry,
  }
}
