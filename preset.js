/**
 * 「短剧模式」预设的伴生入口（`dsh-plugin-ai-drama/preset`）。
 *
 * 作用：
 * 1) 在处于短剧模式的 Agent 作用域内标记隔离服务 `dramaMode`（工具白名单判定用）；
 * 2) **全内置技能托管**（SPEC v1.4.3 / H-12r1 / H-13r2）：
 *    - 只挂载插件包内 `skills/`（bundled-only），不再读取任何外部目录；
 *    - 通过托管 provider 读工作区 `settings.skillConfig`：`disabled[]` 过滤候选、`active` 由
 *      inventory/context-card/移交目标消费（`active` 不隐藏同类其它技能，D-v3-1 假设）；
 *    - `settings-save` 后主插件通知 → `control.invalidate()` → 下一次 Agent 步骤按新配置生效（S2）；
 * 3) 向主插件 `aiDramaHost` 注册 `skills-inventory` 数据源（H-12r1）。
 *
 * 回退开关：预设行 config `skillManagement: false` 时退回旧 `drama-bundled` 静态 provider
 * （无 disabled/active 过滤，仅便于紧急回退）。
 */
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'

import { buildSkillsInventory } from './lib/skill-managed.js'
import { createManagedProvider } from './lib/skill-managed.js'
import { skillCategoryOf } from './lib/skill-config.js'

export const name = 'ai-drama-preset'

/** `skills` 由预设里的 tool-skill 提供；`aiDramaHost` 由主插件提供。 */
export const inject = ['skills', 'aiDramaHost']

/** 插件包内唯一技能目录（`import.meta.url` 确保换机/任意安装路径都正确）。 */
const SKILLS_DIR = fileURLToPath(new URL('./skills/', import.meta.url))
const require = createRequire(import.meta.url)

function readPackage() {
  try {
    const pkg = require('./package.json')
    return { version: typeof pkg.version === 'string' ? pkg.version : '0.0.0' }
  } catch {
    return { version: '0.0.0' }
  }
}

export function apply(ctx, config = {}) {
  const capability = { mode: 'drama', disposed: false }
  ctx.provide('dramaMode', capability)
  const skillManagement = config.skillManagement !== false
  const providerName = typeof config.providerName === 'string' && config.providerName ? config.providerName : 'drama-managed'

  const pkg = readPackage()
  let invalidate = () => {}
  let inner = null
  let inventory = null

  /** 从工作区 settings 读取并交给纯函数归一化；失败按"无配置"处理（不阻断技能发现）。 */
  const readConfig = async (options = {}) => {
    try {
      const settings = await ctx.aiDramaHost?.getSkillConfig?.(options.cwd)
      return settings && typeof settings === 'object' ? settings.skillConfig ?? null : null
    } catch {
      return null
    }
  }

  /** 只读扫描 bundled 候选 → inventory（H-12r1：package/skills/active/recommended，无 sources）。 */
  const buildInventory = async (options = {}) => {
    if (!inner || typeof inner.list !== 'function') {
      return buildSkillsInventory({ packageInfo: { version: pkg.version, skillsCount: 0, bytes: 0 }, rows: [], config: null, mode: skillManagement ? 'S2' : 'legacy', complete: false })
    }
    let observation
    try {
      observation = await inner.list({ cwd: options.cwd })
    } catch {
      return buildSkillsInventory({ packageInfo: { version: pkg.version, skillsCount: 0, bytes: 0 }, rows: [], config: null, mode: skillManagement ? 'S2' : 'legacy', complete: false })
    }
    const candidates = Array.isArray(observation) ? observation : observation && Array.isArray(observation.candidates) ? observation.candidates : []
    const complete = Array.isArray(observation) ? true : observation?.complete !== false
    const rows = []
    let bytes = 0
    for (const candidate of candidates) {
      let size = 0
      try {
        const stat = await fs.stat(candidate.path)
        if (stat.isFile()) size = stat.size
      } catch { /* 包内文件异常时按 0 计，status 仍按候选可用性 */ }
      bytes += size
      rows.push({
        name: candidate.name,
        description: candidate.description,
        path: candidate.path,
        bytes: size,
        category: skillCategoryOf(candidate.name),
        status: '可用',
      })
    }
    const settings = await ctx.aiDramaHost?.getSkillConfig?.(options.cwd).catch(() => null)
    return buildSkillsInventory({
      packageInfo: { version: pkg.version, skillsCount: rows.length, bytes },
      rows,
      config: settings ? settings.skillConfig ?? null : null,
      mode: skillManagement ? 'S2' : 'legacy',
      complete,
      enforceScriptActive: skillManagement,
    })
  }

  if (skillManagement) {
    // (c) 托管 provider：inner 只发现插件包 skills/；wrapper 按 disabled 过滤 + 提供 invalidate。
    ctx.skills.registerProvider((control) => {
      inner = new skillFilesystem.FileSystemSkillProvider(ctx, control, {
        providerName: 'drama-bundled-inner',
        includeDefaultRoots: false,
        customSkillDirs: [],
        bundledSkillDir: SKILLS_DIR,
        watch: false,
      })
      invalidate = () => {
        try { control.invalidate() } catch { /* 注册已注销 */ }
      }
      return createManagedProvider({ inner, control, readConfig, name: providerName, enforceScriptActive: true })
    })
  } else {
    // 紧急回退：旧静态 bundled provider（无 filtered/active，仅保证技能可见）。
    ctx.plugin(skillFilesystem, {
      providerName: 'drama-bundled',
      includeDefaultRoots: false,
      bundledSkillDir: SKILLS_DIR,
    })
  }

  // 向主插件注册 inventory 数据源（preset 在启动期装载；S2 下同一个闭包随配置变化）。
  try {
    ctx.aiDramaHost?.setSkillInventory?.((options = {}) => buildInventory(options))
  } catch { /* 主插件尚未提供时忽略（下次 refresh 不重试；降级由 host 处理） */ }
  const off = ctx.aiDramaHost?.onSkillConfigChanged?.(() => {
    try { invalidate() } catch { /* 忽略 */ }
  })

  ctx.effect(() => {
    void ctx.aiDramaHost?.refresh?.()
    return () => {
      capability.disposed = true
      try { off?.() } catch { /* 忽略 */ }
      void ctx.aiDramaHost?.refresh?.()
    }
  })
}
