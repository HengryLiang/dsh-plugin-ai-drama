/**
 * C1（E14）· 八大基本设定：`contract.json` **add-only** 8 字段的单一源
 *
 * 口径来源：`需求/需求分析-C1-八大基本设定-E14-v1.md`（Lead 已批；目标 v0.16.2 / 回滚 v0.16.1）
 *  - 8 个**可选顶层 string** 字段，顺序固定（与知识库/客户端一致）：
 *    worldSpace 地理与空间(1500) / worldTime 时间与历史(1500) / powerSystem 力量体系(2000) /
 *    speciesEcology 种族与生态(1200) / factions 社会与势力(1500) / resourceEconomy 资源与经济(1200) /
 *    cultureBelief 文化与信仰(1500) / soulDeath 灵魂/生死/因果(1500)
 *  - 保存语义（Lead 批正确认「清空语义」）：client 始终提交 8 个键——
 *      · patch 显式出现且 trim 后非空 → 存 trim 值；
 *      · patch 显式出现且 trim 后为 '' → **删除该键**（用户清空可删旧值）；
 *      · patch 未出现该键 → **保留 current 原值**（读不补默认、不预置空键）。
 *  - 非法类型（非 string）/超长 → `error.code='invalid-args'`（HTTP 400 invalid-args / 工具 code=invalid-args）。
 *  - 长度上限按 trim 后 `String.length` 计（与既有字段校验/客户端字数一致）。
 *  - 旧项目（无新字段）→ JSON/MD/导出/注入**逐字节不变**：渲染/注入 helper 在全空时返回 []。
 *
 * 本模块为纯函数（无 IO、无第三方依赖），供 `store.js`（保存归一/契约 MD 渲染）、
 * `tools.js`（工具入参 schema 与契约摘要渲染）、`context-card.js`（≤200 字摘要注入）共用，
 * 避免 key/label/上限在 3 处漂移。**不新增 METHOD/工具/route/依赖**。
 */

/** 8 字段固定顺序 + 中文名 + trim 后长度上限（需求 §4 / D2）。 */
export const WORLD_CONTRACT_FIELDS = Object.freeze([
  Object.freeze({ key: 'worldSpace', label: '地理与空间', limit: 1500 }),
  Object.freeze({ key: 'worldTime', label: '时间与历史', limit: 1500 }),
  Object.freeze({ key: 'powerSystem', label: '力量体系', limit: 2000 }),
  Object.freeze({ key: 'speciesEcology', label: '种族与生态', limit: 1200 }),
  Object.freeze({ key: 'factions', label: '社会与势力', limit: 1500 }),
  Object.freeze({ key: 'resourceEconomy', label: '资源与经济', limit: 1200 }),
  Object.freeze({ key: 'cultureBelief', label: '文化与信仰', limit: 1500 }),
  Object.freeze({ key: 'soulDeath', label: '灵魂/生死/因果', limit: 1500 }),
])

/** 8 字段 key 列表（固定顺序；供 schema/断言使用）。 */
export const WORLD_CONTRACT_KEYS = Object.freeze(WORLD_CONTRACT_FIELDS.map((field) => field.key))

/** context-card 每字段摘要上限（纯截断；总长仍 ≤ 该值）。 */
export const WORLD_CONTRACT_SUMMARY_LIMIT = 200

/** 构造带 `code='invalid-args'` 的校验错误（HTTP 外层映射 400 invalid-args；工具侧保留 code）。 */
export function invalidWorldContractArg(message) {
  const error = new Error(message)
  error.code = 'invalid-args'
  return error
}

/**
 * 归一 patch 中**显式出现**的 8 个世界字段（直接修改并返回 next；不新增未提交键）。
 * @param {object} next 已 spread 合并后的契约对象（会被就地修改）
 * @param {object} patch 客户端/工具提交的原始 patch
 * @returns {object} next
 */
export function normalizeWorldContractFields(next, patch) {
  const input = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  for (const { key, label, limit } of WORLD_CONTRACT_FIELDS) {
    if (!Object.hasOwn(input, key)) continue
    const raw = input[key]
    if (typeof raw !== 'string') {
      const kind = raw === null ? 'null' : Array.isArray(raw) ? '数组' : typeof raw
      throw invalidWorldContractArg(`八大基本设定「${label}」必须是字符串（当前 ${kind}）`)
    }
    const value = raw.trim()
    if (value.length > limit) {
      throw invalidWorldContractArg(`八大基本设定「${label}」超长：${value.length}/${limit} 字符（trim 后计）`)
    }
    if (value === '') {
      delete next[key]
      continue
    }
    next[key] = value
  }
  return next
}

/** 当前契约中「已填」（trim 后非空 string）的世界字段，按固定顺序。 */
export function filledWorldContractFields(contract) {
  const source = contract && typeof contract === 'object' ? contract : {}
  return WORLD_CONTRACT_FIELDS.filter(({ key }) => typeof source[key] === 'string' && source[key].trim() !== '')
}

const compactText = (value, limit) => {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text
}

/**
 * `剧集契约.md` 条件段行数组：任一世界字段非空时返回该段（固定顺序、空字段跳过）；
 * 全空返回 `[]` —— 调用方据此保持旧渲染**逐字节不变**。
 * 内容内换行 → 空格，保证「每字段一行」不破坏 Markdown 段落。
 */
export function worldContractMarkdownLines(contract) {
  const rows = filledWorldContractFields(contract)
  if (!rows.length) return []
  const lines = ['### 八大基本设定（可选）', '']
  for (const { key, label } of rows) {
    lines.push(`- **${label}**：${String(contract[key]).replace(/\r?\n/g, ' ').trim()}`)
  }
  lines.push('')
  return lines
}

/**
 * context-card「世界约束（摘要）」条件行数组：仅非空字段出现，每字段 ≤200 字符（纯截断，可「…」后缀）；
 * 全空返回 `[]` —— 调用方据此保持旧注入文本**逐字节不变**。
 */
export function worldContractContextLines(contract) {
  const rows = filledWorldContractFields(contract)
  if (!rows.length) return []
  const lines = [`- 世界约束（摘要）：已填 ${rows.length}/8`]
  for (const { key, label } of rows) lines.push(`  - ${label}：${compactText(contract[key], WORLD_CONTRACT_SUMMARY_LIMIT)}`)
  return lines
}

/** `drama_save_contract` 工具入参 schema 的 8 个可选 string 属性（add-only；避免 additionalProperties:false 拒绝）。 */
export function worldContractToolProperties() {
  const properties = {}
  for (const { key, label, limit } of WORLD_CONTRACT_FIELDS) {
    properties[key] = { type: 'string', description: `八大基本设定·${label}（可选；≤${limit} 字符，空串=未填/清空）` }
  }
  return properties
}
