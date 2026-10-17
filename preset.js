/**
 * 「短剧模式」预设的伴生入口（`dsh-plugin-ai-drama/preset`）。
 *
 * 作用：在**处于短剧模式的 Agent 作用域内**标记一个隔离服务 `dramaMode`。
 * 主插件通过 `agentPresets.serviceFor(agent, 'dramaMode')` 判定该 Agent 是否处于本模式，
 * 命中才注册 `drama_*` 工具——这就是 PRD FR-D03 的「工具白名单」。
 *
 * 同时随包挂载 `skills/` 目录（FR-D09），预设在哪个会话被选中，技能就在哪个会话可用。
 */
import { fileURLToPath } from 'node:url'

import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'

export const name = 'ai-drama-preset'

/** `skills` 由预设里的 tool-skill 提供；`aiDramaHost` 由主插件提供。 */
export const inject = ['skills', 'aiDramaHost']

export function apply(ctx) {
  const capability = { mode: 'drama', disposed: false }
  ctx.provide('dramaMode', capability)

  // 只负责随包技能；默认技能根由预设里的 skill-filesystem 行提供，
  // 这里再注册一遍会让默认根被发现两次（见 docs：Agent预设-机制与规范.md）。
  ctx.plugin(skillFilesystem, {
    providerName: 'drama-bundled',
    includeDefaultRoots: false,
    bundledSkillDir: fileURLToPath(new URL('./skills/', import.meta.url)),
  })

  ctx.effect(() => {
    void ctx.aiDramaHost?.refresh?.()
    return () => {
      capability.disposed = true
      void ctx.aiDramaHost?.refresh?.()
    }
  })
}
