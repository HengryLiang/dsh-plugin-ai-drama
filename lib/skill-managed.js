/**
 * Skill 管理（全内置版）· 托管 provider 包装与 inventory 组装（纯函数，不直接依赖 DSH 包）。
 *
 * 用法（preset.js）：inner = `new FileSystemSkillProvider(ctx, control, { includeDefaultRoots:false,
 * customSkillDirs:[], bundledSkillDir: <插件 skills/>, watch:false })`，再交给
 * `createManagedProvider({ inner, readConfig, control })`；S2：`settings-save` 后 host 通知 →
 * `control.invalidate()` → 下一次 skill catalog 重新计算。
 *
 * 契约：P1 `§6.r` H-12r2（inventory 无 sources；含 package/categories/active/recommended；general 仅展示/启停）。
 */

import {
  normalizeSkillConfig,
  resolveSkillConfig,
  skillCategoryOf,
  SKILL_CATEGORIES,
  SKILL_CONFIG_VERSION,
} from './skill-config.js'
import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_PROVIDER_NAME = 'drama-managed'

/**
 * v0.16.249：脚本 skill 候选并列（shot-prompt/seedance + storyboard-seedance）；不设格式/模型默认。
 * disabled 仍由 filterSkillCandidates/get 生效。
 */
export const SCRIPT_CHAIN_SKILL_NAMES = Object.freeze([
  'drama-seedance-prompt',
  'drama-shot-prompt',
  'storyboard-seedance',
])

/** 脚本类强约束：脚本链三技能常显；其余脚本类只暴露当前 active。 */
export function filterScriptEnforced(candidates, config) {
  const list = Array.isArray(candidates) ? candidates : []
  const available = list.map((item) => item && item.name).filter((name) => typeof name === 'string')
  const resolved = resolveSkillConfig(config, available)
  const activeScript = resolved.effective.script
  return list.filter((item) => {
    if (!item || typeof item.name !== 'string') return false
    if (skillCategoryOf(item.name) !== 'script') return true
    return SCRIPT_CHAIN_SKILL_NAMES.includes(item.name) || item.name === activeScript
  })
}

/** 过滤掉 disabled 候选（disabled=清单内不可选/不可加载）。 */
export function filterSkillCandidates(candidates, config) {
  const list = Array.isArray(candidates) ? candidates : []
  const disabled = new Set((config && config.disabled) || [])
  if (disabled.size === 0) return list.slice()
  return list.filter((item) => item && typeof item.name === 'string' && !disabled.has(item.name))
}

/** 从 inner provider 的 list 结果中取候选数组（兼容数组 / {candidates, complete} 两种形状）。 */
export function candidatesOf(observation) {
  if (Array.isArray(observation)) return { candidates: observation, complete: true }
  if (observation && typeof observation === 'object' && Array.isArray(observation.candidates)) {
    return { candidates: observation.candidates, complete: observation.complete !== false }
  }
  return { candidates: [], complete: false }
}

/**
 * 托管 provider：`list()` 按当前 `skillConfig.disabled` 过滤；`get()` 二次拒绝 disabled。
 * `readConfig(options)` 由 preset.js 注入（读工作区 settings → skillConfig）。
 */
export function createManagedProvider({ inner, readConfig, control, name = DEFAULT_PROVIDER_NAME, enforceScriptActive = false }) {
  if (!inner || typeof inner.list !== 'function' || typeof inner.get !== 'function') {
    throw new TypeError('createManagedProvider: inner provider 必须实现 list/get')
  }
  const read = async (options) => {
    try {
      const raw = await readConfig(options)
      return normalizeSkillConfig(raw)
    } catch {
      return null
    }
  }
  /** 最近一次 list() 解析出的 active 脚本技能（get 与 list 必须使用同一判据）。 */
  let lastActiveScript = null
  const applyFilters = (candidates, config) => {
    const enabled = filterSkillCandidates(candidates, config)
    if (!enforceScriptActive) return enabled
    const available = enabled.map((item) => item && item.name).filter((name) => typeof name === 'string')
    lastActiveScript = resolveSkillConfig(config, available).effective.script
    return enabled.filter((item) => {
      if (!item || typeof item.name !== 'string') return false
      if (skillCategoryOf(item.name) !== 'script') return true
      return SCRIPT_CHAIN_SKILL_NAMES.includes(item.name) || item.name === lastActiveScript
    })
  }
  /** 托管 provider 注册名与 inner 候选 provider 不同（FileSystemSkillProvider=inner 名）→ 输出前 re-stamp。 */
  const reStampProvider = (item) => (item && item.provider !== name ? { ...item, provider: name } : item)
  return {
    name,
    async list(options = {}) {
      const config = await read(options)
      const observation = await inner.list(options)
      const { candidates, complete } = candidatesOf(observation)
      const filtered = applyFilters(candidates, config).map(reStampProvider)
      return complete ? filtered : { candidates: filtered, complete }
    },
    async get(candidate, options = {}) {
      const config = await read(options)
      if (!candidate || typeof candidate.name !== 'string') return undefined
      if (config && (config.disabled || []).includes(candidate.name)) return undefined
      if (enforceScriptActive && skillCategoryOf(candidate.name) === 'script' && !SCRIPT_CHAIN_SKILL_NAMES.includes(candidate.name)) {
        const active = lastActiveScript ?? resolveSkillConfig(config).effective.script
        if (active !== null && candidate.name !== active) return undefined
      }
      const skill = await inner.get(candidate, options)
      return skill && skill.provider !== name ? { ...skill, provider: name } : skill
    },
    /** 供 preset.js 在配置变更后调用（等价 control.invalidate）。 */
    invalidate() {
      try { control?.invalidate?.() } catch { /* 注册已注销时忽略 */ }
    },
  }
}

/**
 * 组装 `skills-inventory` 的 inventory 对象（H-12r1）。
 * @param {object} input
 * @param {{version:string, skillsCount:number, bytes:number}|null} input.packageInfo
 * @param {Array<{name:string, description?:string, path?:string, bytes?:number, category?:string|null, status?:string}>} input.rows
 * @param {unknown} input.config 原始/已归一化 skillConfig
 * @param {string} input.mode 'S2' | 'S1' | 'unavailable'
 * @param {boolean} input.complete
 * @param {string} [input.generatedAt]
 */
export function buildSkillsInventory({ packageInfo, rows, config, mode, complete, generatedAt, enforceScriptActive = false }) {
  const normalized = normalizeSkillConfig(config)
  const names = (rows || []).map((row) => row.name)
  const resolved = resolveSkillConfig(normalized, names)
  const disabled = new Set((normalized && normalized.disabled) || [])
  const metaOf = (id) => SKILL_CATEGORIES.find((item) => item.id === id) || null
  const skills = (rows || []).map((row) => {
    const category = row.category ?? skillCategoryOf(row.name)
    const meta = metaOf(category)
    return {
      name: row.name,
      description: row.description || '',
      category,
      activeEligible: Boolean(meta && meta.activeEligible !== false),
      status: disabled.has(row.name) ? '已停用' : (row.status || '可用'),
      bytes: Number.isFinite(row.bytes) ? row.bytes : 0,
      path: row.path,
      active: Object.values(resolved.effective).includes(row.name),
      enforced: enforceScriptActive && skillCategoryOf(row.name) === 'script',
    }
  })
  const activeWarnings = []
  for (const [category, configured] of Object.entries(resolved.active || {})) {
    if (!configured) continue
    if (!names.includes(configured) || disabled.has(configured)) {
      activeWarnings.push({ code: 'active-skill-missing', category, configured, effective: resolved.effective[category] || null })
    }
  }
  return {
    version: SKILL_CONFIG_VERSION,
    complete: complete !== false,
    generatedAt: generatedAt || new Date().toISOString(),
    package: packageInfo || null,
    categories: SKILL_CATEGORIES.map((item) => ({
      id: item.id,
      label: item.label,
      activeEligible: item.activeEligible !== false,
      recommended: item.recommended || null,
    })),
    skills,
    active: resolved.effective,
    activeWarnings,
    recommended: resolved.recommended,
    enforced: { story: false, asset: false, script: Boolean(enforceScriptActive) },
    disabled: [...disabled],
    mode: mode || 'S2',
  }
}

/**
 * host 侧兜底 inventory（v0.16.63，D-0034 残留）：不依赖 preset 挂载。
 * 扫描插件内置 `skills/<name>/SKILL.md` → rows/package，交给 `buildSkillsInventory` 组装；
 * 未挂载 preset 时 mode=host-fallback（active/disabled 来自 settings，脚本强约束 enforced:false）。
 * @param {{skillsDir:string, version:string, config?:unknown, mode?:string}} input
 * @returns {Promise<object|null>} 无技能/目录不可读 → null（调用方再落旧降级）
 */
export async function buildBundledSkillInventory({ skillsDir, version, config, mode = 'host-fallback' } = {}) {
  const rows = []
  let bytes = 0
  let entries = []
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true })
  } catch {
    entries = []
  }
  entries.sort((a, b) => String(a && a.name || '').localeCompare(String(b && b.name || '')))
  for (const entry of entries) {
    if (!entry || typeof entry.isDirectory !== 'function' || !entry.isDirectory()) continue
    const name = String(entry.name || '')
    if (!name) continue
    const skillPath = path.join(skillsDir, name, 'SKILL.md')
    let size = 0
    let description = ''
    try {
      const stat = await fs.stat(skillPath)
      if (!stat.isFile() || !stat.size) continue
      size = stat.size
      const text = await fs.readFile(skillPath, 'utf8')
      const matched = /^description:\s*(.+)$/m.exec(text)
      description = matched ? String(matched[1]).trim().slice(0, 200) : ''
    } catch {
      continue
    }
    bytes += size
    rows.push({ name, description, path: skillPath, bytes: size, category: skillCategoryOf(name), status: '可用' })
  }
  if (!rows.length) return null
  return buildSkillsInventory({
    packageInfo: { version: String(version || '0.0.0'), skillsCount: rows.length, bytes },
    rows,
    config: config ?? null,
    mode,
    complete: true,
    enforceScriptActive: false,
  })
}
