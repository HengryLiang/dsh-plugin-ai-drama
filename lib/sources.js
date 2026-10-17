/**
 * P2-1 / E5：数据源枚举（多数据源宿主半）
 *
 * 契约（`P1-接口契约冻结-v1.md` §6 E5，Lead 已批准）：
 *   `sources-list` 请求 `{ cwd?, limit? }` →
 *   `{ ok:true, sources:[{ path, sourceType:'workspace'|'session'|'manual',
 *                          projectCount, lastActiveAt?, label? }], degraded?:boolean }`
 *
 * 枚举范围（Q1 裁定 union）：`workspaceRegistry` 工作区 ∪ 短剧模式会话 cwd ∪ 插件配置 root，
 * 去重、`isDirectory` 过滤、按「默认源置顶（Q6）→ 当前 cwd 匹配 → 最近活跃 → 项目数」排序。
 * 数据根定义沿用 `<source>/AI短剧`（`store.projectsBase`），projectCount = 该源下短剧项目数。
 *
 * 本模块纯 IO 无宿主 ctx 依赖，便于离线断言；index.js 只负责注入服务与响应包装。
 */
import path from 'node:path'

import * as store from './store.js'

export const SOURCE_TYPES = ['workspace', 'session', 'manual']
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
/** workspaceRegistry 记录里可能承载路径的字段（与 resolveWorkspaceRoot 保持一致）。 */
const PATH_KEYS = ['path', 'directory', 'dir', 'root', 'canonicalPath']
const TIME_KEYS = ['updatedAt', 'lastActiveAt', 'lastOpenedAt', 'createdAt']

function pathKey(target) {
  try {
    return path.resolve(String(target)).replace(/\\/g, '/').toLowerCase()
  } catch {
    return String(target)
  }
}

function baseLabel(target) {
  try {
    return path.basename(path.resolve(String(target))) || String(target)
  } catch {
    return String(target)
  }
}

function firstAbsolutePath(record) {
  if (!record || typeof record !== 'object') return ''
  for (const key of PATH_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && path.isAbsolute(value)) return value
  }
  return ''
}

function firstTime(record) {
  if (!record || typeof record !== 'object') return ''
  for (const key of TIME_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value && !Number.isNaN(Date.parse(value))) return value
  }
  return ''
}

function recordLabel(record) {
  if (!record || typeof record !== 'object') return ''
  for (const key of ['label', 'title', 'name']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 80)
  }
  return ''
}

/**
 * 枚举数据源。
 * @param {{
 *   registry?: { list?: Function },
 *   agentsList?: Array,
 *   agentsAvailable?: boolean,
 *   configRoot?: string,
 *   cwd?: string,
 *   limit?: number,
 * }} deps
 */
export async function listDataSources(deps = {}) {
  const errors = []
  const sources = new Map()

  const add = (rawPath, sourceType, extra = {}) => {
    if (typeof rawPath !== 'string' || !path.isAbsolute(rawPath)) return
    const key = pathKey(rawPath)
    const existing = sources.get(key)
    if (existing) {
      // 去重：工作区来源优先保留；补全 label / 最近活跃时间（取较新者）。
      if (!existing.label && extra.label) existing.label = extra.label
      if (extra.lastActiveAt && (!existing.lastActiveAt || Date.parse(extra.lastActiveAt) > Date.parse(existing.lastActiveAt))) {
        existing.lastActiveAt = extra.lastActiveAt
      }
      return
    }
    const item = {
      path: path.resolve(rawPath),
      sourceType: SOURCE_TYPES.includes(sourceType) ? sourceType : 'workspace',
      projectCount: 0,
    }
    const label = (extra.label || '').trim() || baseLabel(rawPath)
    if (label) item.label = label
    if (extra.lastActiveAt) item.lastActiveAt = extra.lastActiveAt
    sources.set(key, item)
  }

  /* 1) workspaceRegistry 工作区（Q6：旧目录来源 = 第一个有效注册工作区，置顶默认源） */
  let defaultWorkspaceKey = ''
  if (deps.registry && typeof deps.registry.list === 'function') {
    let records = []
    try {
      records = (await deps.registry.list()) || []
    } catch (error) {
      errors.push(`workspace-registry 读取失败：${error instanceof Error ? error.message : String(error)}`)
      records = []
    }
    for (const record of records) {
      const rawPath = firstAbsolutePath(record)
      if (!rawPath) continue
      // 默认源 = 第一个目录真实存在的注册工作区（与 0.4.3 resolveWorkspaceRoot 的回落顺序一致）
      if (!defaultWorkspaceKey && (await store.isDirectory(rawPath))) defaultWorkspaceKey = pathKey(rawPath)
      add(rawPath, 'workspace', { label: recordLabel(record), lastActiveAt: firstTime(record) })
    }
  } else {
    errors.push('workspace-registry 不可用')
  }

  /* 2) 短剧模式会话 cwd（Q5：会话建过的项目自动成为数据源） */
  if (!Array.isArray(deps.agentsList)) {
    if (deps.agentsAvailable === false) errors.push('agents 服务不可用，未能枚举短剧会话数据源')
  } else {
    for (const agent of deps.agentsList) {
      const session = agent && agent.session
      const header = session && session.header
      if (!header) continue
      // 只认「短剧模式」会话（预设 id = drama）
      if (header.agentPreset !== 'drama') continue
      const cwd = header.cwd
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) continue
      add(cwd, 'session', {
        label: `会话 · ${baseLabel(cwd)}`,
        lastActiveAt: firstTime(header) || firstTime(session),
      })
    }
  }

  /* 3) 插件配置 root（可选的第 4 级回落，类型按 workspace 呈现） */
  if (typeof deps.configRoot === 'string' && path.isAbsolute(deps.configRoot)) {
    add(deps.configRoot, 'workspace', { label: '插件配置 root' })
  }

  /* 过滤失效路径 + 统计项目数 */
  const cwdKey = typeof deps.cwd === 'string' && path.isAbsolute(deps.cwd) ? pathKey(deps.cwd) : ''
  const listed = []
  for (const item of sources.values()) {
    if (!(await store.isDirectory(item.path))) continue
    let projectCount = 0
    try {
      projectCount = (await store.listProjects(item.path)).length
    } catch {
      projectCount = 0
    }
    item.projectCount = projectCount
    // 排序权重（不暴露给客户端）：默认源置顶（Q6）→ 当前 cwd 匹配 → 最近活跃 → 项目数。
    listed.push({
      item,
      rank: pathKey(item.path) === defaultWorkspaceKey ? 3 : pathKey(item.path) === cwdKey ? 2 : 0,
    })
  }

  listed.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank
    const ta = a.item.lastActiveAt ? Date.parse(a.item.lastActiveAt) : 0
    const tb = b.item.lastActiveAt ? Date.parse(b.item.lastActiveAt) : 0
    if ((tb || 0) !== (ta || 0)) return (tb || 0) - (ta || 0)
    if (b.item.projectCount !== a.item.projectCount) return b.item.projectCount - a.item.projectCount
    return a.item.path.localeCompare(b.item.path)
  })

  const wanted = Number(deps.limit)
  const limit = Number.isFinite(wanted) && wanted > 0 ? Math.min(Math.round(wanted), MAX_LIMIT) : DEFAULT_LIMIT
  return {
    sources: listed.slice(0, limit).map((entry) => entry.item),
    degraded: errors.length > 0,
    ...(errors.length ? { reasons: errors.slice(0, 5) } : {}),
  }
}
