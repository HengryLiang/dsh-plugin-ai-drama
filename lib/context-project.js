/**
 * v0.16.156：当前项目解析纯函数（无 IO/无副作用）。
 *
 * 修复：历史实现无显式 title 时回退 `listProjects()[0]`（目录 mtime 最新）→ 新建项目必中，
 * 与「会话→项目」绑定和面板当前项目错位。解析优先级固定为：
 *   titleHint（显式） > 会话绑定（同 sessionId，多绑定取 updatedAt 最新，且项目仍存在）
 *   > 工作区仅 1 个项目（unique） > unbound
 *
 * 注意：此处只解析 title/来源；读项目内容仍由 index.js 的 store 调用完成。
 */

const trim = (value) => (typeof value === 'string' ? value.trim() : '')

function projectTitleOf(row) {
  if (typeof row === 'string') return row.trim()
  if (row && typeof row.title === 'string') return row.title.trim()
  return ''
}

function timestampOf(value) {
  const text = trim(value)
  if (!text) return 0
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : 0
}

/**
 * @param {{
 *   titleHint?: string,
 *   sessionId?: string,
 *   projects?: Array<{title?: string}|string>,
 *   bindings?: Record<string, {sessionId?: string, updatedAt?: string, boundAt?: string, source?: string}>,
 * }} input
 * @returns {{title: string, source: 'explicit'|'session'|'unique'|'unbound', projectCount: number}}
 */
export function resolveCurrentProject(input = {}) {
  const titleHint = trim(input && input.titleHint)
  const sessionId = trim(input && input.sessionId)
  const projects = Array.isArray(input && input.projects) ? input.projects : []
  const bindings = input && input.bindings && typeof input.bindings === 'object' && !Array.isArray(input.bindings) ? input.bindings : {}
  const titles = [...new Set(projects.map(projectTitleOf).filter(Boolean))]
  const projectCount = titles.length

  // 1) 显式 title 最高优先（保留原 titleHint 行为；不因项目不存在而静默改选）。
  if (titleHint) return { title: titleHint, source: 'explicit', projectCount }

  // 2) 会话绑定：只认当前 sessionId；绑定项目必须仍在工作区；多条取 updatedAt 最新。
  if (sessionId) {
    const candidates = Object.entries(bindings)
      .filter(([title, entry]) => {
        const boundSession = trim(entry && entry.sessionId)
        if (boundSession !== sessionId) return false
        if (!titles.length) return true // 无项目清单时仍允许绑定（调用方负责内容读取失败降级）
        return titles.includes(title)
      })
      .sort((a, b) => {
        const ta = timestampOf(a[1] && a[1].updatedAt) || timestampOf(a[1] && a[1].boundAt)
        const tb = timestampOf(b[1] && b[1].updatedAt) || timestampOf(b[1] && b[1].boundAt)
        if (tb !== ta) return tb - ta
        return String(a[0]).localeCompare(String(b[0]))
      })
    if (candidates.length) return { title: candidates[0][0], source: 'session', projectCount }
  }

  // 3) 工作区仅 1 个项目：唯一可确定，允许自动选中；多项目绝不按 mtime/列表序猜测。
  if (titles.length === 1) return { title: titles[0], source: 'unique', projectCount }

  // 4) 未绑定：不选任何项目，卡片只给诊断/安全提示。
  return { title: '', source: 'unbound', projectCount }
}
