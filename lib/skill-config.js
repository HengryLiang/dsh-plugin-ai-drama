/**
 * Skill 管理（全内置版）纯函数：`settings.skillConfig` v4 形状/校验/active 解析。
 *
 * 契约：`P1-接口契约冻结-v1.md §6.r` H-13r2。
 * 设计约束（P0 方案 v1.3）：
 * - `active = { story, asset, script }` 每类至多 1 个"当前启用"技能（null=回退推荐默认）；
 * - `disabled[]` = 清单内不可选（不等于"同时启用集合"）；
 * - `perSkill?` 为 P1 预留，P0 只做浅校验与透传；
 * - 总大小 ≤4KB；未发布 → 无真实旧数据迁移；旧字段（sources/preferred/defaults）忽略。
 * 本文件不依赖 DSH 包，便于 `test/skill-management.mjs` 直接单测。
 */

export const SKILL_CONFIG_VERSION = 4
export const SKILL_CONFIG_MAX_BYTES = 4096
export const SKILL_CONFIG_MAX_DISABLED = 200
export const SKILL_NAME_MAX = 80

/** 4 类（剧本/资产/脚本/通用）；仅前三类参与 active 单选；通用类默认启用、可停用。 */
export const SKILL_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'story', label: '剧本', recommended: 'drama-episode', activeEligible: true }),
  Object.freeze({ id: 'asset', label: '资产', recommended: 'drama-asset', activeEligible: true }),
  Object.freeze({ id: 'script', label: '脚本', recommended: 'storyboard-seedance', activeEligible: true }),
  Object.freeze({ id: 'general', label: '通用', activeEligible: false }),
])
/** H-12r2：展示/inventory 用 4 类；**normalize/resolve 只遍历 ACTIVE_CATEGORY_IDS**，不得产生 active.general。 */
export const SKILL_CATEGORY_IDS = Object.freeze(SKILL_CATEGORIES.map((item) => item.id))
export const ACTIVE_CATEGORY_IDS = Object.freeze(['story', 'asset', 'script'])
export const RECOMMENDED_ACTIVE = Object.freeze(
  Object.fromEntries(SKILL_CATEGORIES.filter((item) => item.activeEligible !== false).map((item) => [item.id, item.recommended])),
)

/** 随包技能 → 分类（内容冻结后若有新增技能，仅需在此补一行）。 */
export const SKILL_CATEGORY_MAP = Object.freeze({
  'drama-setup': 'story',
  'drama-outline': 'story',
  'drama-characters': 'story',
  'drama-episode': 'story',
  'drama-polish': 'story',
  'drama-review': 'story',
  'drama-export': 'story',
  'drama-director': 'script',
  'drama-storyboard': 'script',
  'drama-shot-prompt': 'script',
  'drama-asset': 'asset',
  'drama-asset-analysis': 'asset',
  'drama-script': 'story',
  'drama-seedance-prompt': 'script',
  'roundtable': 'general',
  'drama-visual-bible': 'general',
  'drama-vsc-brief': 'general',
  'drama-music': 'general',
  'storyboard-seedance': 'script',
})

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 技能名归属分类；未知技能返回 null（其它/未归类）。 */
export function skillCategoryOf(name) {
  return Object.prototype.hasOwnProperty.call(SKILL_CATEGORY_MAP, name) ? SKILL_CATEGORY_MAP[name] : null
}

function normalizeName(value, field) {
  if (typeof value !== 'string') throw new TypeError(`skillConfig.${field} 必须是技能名或 null`)
  const name = value.trim()
  if (!name) throw new TypeError(`skillConfig.${field} 不能为空串（不用时请置 null）`)
  if (name.length > SKILL_NAME_MAX) throw new TypeError(`skillConfig.${field} 超过 ${SKILL_NAME_MAX} 字`)
  if (!KEBAB_RE.test(name)) throw new TypeError(`skillConfig.${field} 不是合法 kebab-case 技能名：${name}`)
  return name
}

/**
 * 归一化并严格校验 skillConfig v4。
 * @param {unknown} input 前端/旧 settings 中的原始值（可为 null/undefined → 不写盘由调用方决定）
 * @returns {{version:4, active:{story:string|null,asset:string|null,script:string|null}, disabled:string[], perSkill?:object}}
 * @throws {TypeError|Error} 非法输入（host 映射 400 invalid-args）
 */
export function normalizeSkillConfig(input) {
  if (input === null || input === undefined) return null
  if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('skillConfig 必须是对象')

  const activeRaw = input.active
  if (activeRaw !== undefined && activeRaw !== null && (typeof activeRaw !== 'object' || Array.isArray(activeRaw))) {
    throw new TypeError('skillConfig.active 必须是对象')
  }
  const active = {}
  for (const id of ACTIVE_CATEGORY_IDS) {
    const raw = activeRaw && Object.prototype.hasOwnProperty.call(activeRaw, id) ? activeRaw[id] : null
    active[id] = raw === null || raw === undefined ? null : normalizeName(raw, `active.${id}`)
  }

  const disabled = []
  if (input.disabled !== undefined && input.disabled !== null) {
    if (!Array.isArray(input.disabled)) throw new TypeError('skillConfig.disabled 必须是数组')
    if (input.disabled.length > SKILL_CONFIG_MAX_DISABLED) throw new Error(`skillConfig.disabled 超过 ${SKILL_CONFIG_MAX_DISABLED} 项`)
    const seen = new Set()
    for (const item of input.disabled) {
      const name = normalizeName(item, 'disabled[]')
      if (seen.has(name)) continue
      seen.add(name)
      disabled.push(name)
    }
  }

  const out = { version: SKILL_CONFIG_VERSION, active, disabled }
  if (input.perSkill !== undefined && input.perSkill !== null) {
    if (typeof input.perSkill !== 'object' || Array.isArray(input.perSkill)) throw new TypeError('skillConfig.perSkill 必须是对象（P1 预留）')
    out.perSkill = { ...input.perSkill }
  }
  const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8')
  if (bytes > SKILL_CONFIG_MAX_BYTES) throw new Error(`skillConfig 超限（${bytes}B > ${SKILL_CONFIG_MAX_BYTES}B）`)
  return out
}

/**
 * 解析"当前生效"：用户 active > 推荐默认 > 同类可用的第一个；跳过 disabled/不可用。
 * @param {ReturnType<typeof normalizeSkillConfig>} config 已归一化配置（可为 null）
 * @param {string[]|undefined} available 清单内技能名（undefined=不校验可用性，仅校验 disabled）
 * @returns {{recommended:Record<string,string>, effective:Record<string,string|null>, active:Record<string,string|null>}}
 */
export function resolveSkillConfig(config, available) {
  const disabled = new Set((config && config.disabled) || [])
  const availableSet = Array.isArray(available) ? new Set(available) : null
  const usable = (name, id) => {
    if (!name) return null
    if (disabled.has(name)) return null
    if (skillCategoryOf(name) !== id) return null
    if (availableSet !== null && !availableSet.has(name)) return null
    return name
  }
  const recommended = { ...RECOMMENDED_ACTIVE }
  const active = {}
  const effective = {}
  for (const id of ACTIVE_CATEGORY_IDS) {
    const wanted = config && config.active ? config.active[id] : null
    active[id] = wanted ?? null
    let chosen = usable(wanted, id) || usable(recommended[id], id)
    if (!chosen && availableSet !== null) {
      for (const name of availableSet) {
        if (skillCategoryOf(name) === id && usable(name, id)) { chosen = name; break }
      }
    }
    effective[id] = chosen
  }
  return { recommended, active, effective }
}

/** 判断某技能是否允许在清单中被"设为当前启用"（general/disabled/未知分类不可选）。 */
export function isSelectableSkill(name, config) {
  const category = skillCategoryOf(name)
  const meta = SKILL_CATEGORIES.find((item) => item.id === category)
  if (!meta || meta.activeEligible === false) return false
  const disabled = new Set((config && config.disabled) || [])
  return !disabled.has(name)
}
