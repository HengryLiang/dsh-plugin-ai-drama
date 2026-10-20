/**
 * P3-E（v0.9.2）：成本档位（costTier）路由 —— 只增能力，未配置时调用方保持旧行为。
 *
 * 语义：
 *   - `settings.taskModels.<task>.costTier`：可选 enum `fast|standard|strong`（请求档位）。
 *   - `settings.taskModels.<task>.costTierModels`：可选映射覆盖（只增嵌套字段），
 *     `{ fast?: { provider?, model }, strong?: { provider?, model } }`；standard 由现有默认链承担。
 *   - fast/strong 无映射或映射不可用 → 回退 standard（taskModels 现有链）→ 宿主默认模型，不报错，
 *     由调用方在 meta 标记 `costTierFallback` + reason（`no-model-mapping` / `tier-unavailable`）。
 *   - 未配置 costTier = 与 v0.9.1 完全一致（不产生任何新 meta 字段）。
 */

export const COST_TIERS = ['fast', 'standard', 'strong']
export const COST_TIER_MAP_KEYS = ['fast', 'strong']

/** 参数校验错误（route 层映射 HTTP 400 invalid-args）。 */
export function costTierError(message) {
  const error = new Error(message)
  error.code = 'invalid-args'
  return error
}

export function isCostTier(value) {
  return typeof value === 'string' && COST_TIERS.includes(value)
}

/** 归一 costTier（可选）：null/'' → null；非法 → invalid-args。 */
export function normalizeCostTier(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw costTierError('taskModels.<task>.costTier 必须是 fast / standard / strong 之一')
  const tier = value.trim().toLowerCase()
  if (!isCostTier(tier)) throw costTierError('taskModels.<task>.costTier 必须是 fast / standard / strong 之一')
  return tier
}

/** 归一 costTierModels（可选）：仅 fast/strong；provider 可选字符串、model 必填字符串。 */
export function normalizeCostTierModels(value) {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw costTierError('taskModels.<task>.costTierModels 必须是对象（fast/strong → { provider?, model }）')
  }
  const normalized = {}
  for (const [rawKey, rawConfig] of Object.entries(value)) {
    const tier = String(rawKey).trim()
    if (!COST_TIER_MAP_KEYS.includes(tier)) {
      throw costTierError(`taskModels.<task>.costTierModels 只支持 fast / strong（standard 走默认链）：${rawKey}`)
    }
    if (rawConfig == null || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
      throw costTierError(`taskModels.<task>.costTierModels.${tier} 必须是对象（{ provider?, model }）`)
    }
    const config = {}
    if (rawConfig.provider != null) {
      if (typeof rawConfig.provider !== 'string') throw costTierError(`taskModels.<task>.costTierModels.${tier}.provider 必须是字符串`)
      const provider = rawConfig.provider.trim()
      if (provider.length > 80) throw costTierError(`taskModels.<task>.costTierModels.${tier}.provider 过长（上限 80 字）`)
      if (provider) config.provider = provider
    }
    if (typeof rawConfig.model !== 'string' || !rawConfig.model.trim()) {
      throw costTierError(`taskModels.<task>.costTierModels.${tier}.model 必填（非空字符串）`)
    }
    config.model = rawConfig.model.trim().slice(0, 120)
    normalized[tier] = config
  }
  return Object.keys(normalized).length ? normalized : null
}

/** 取档位覆盖候选（taskConfig 已归一；未配置/standard 返回 null）。 */
export function costTierOverrideOf(taskConfig) {
  const config = taskConfig && typeof taskConfig === 'object' ? taskConfig : {}
  const requested = isCostTier(config.costTier) ? config.costTier : null
  if (!requested || requested === 'standard') return null
  const map = config.costTierModels && typeof config.costTierModels === 'object' ? config.costTierModels : {}
  const override = map[requested]
  if (!override || typeof override !== 'object') return { requestedCostTier: requested, tier: requested, missing: true }
  if (typeof override.model !== 'string' || !override.model.trim()) return { requestedCostTier: requested, tier: requested, missing: true }
  return {
    requestedCostTier: requested,
    tier: requested,
    missing: false,
    model: override.model.trim(),
    provider: typeof override.provider === 'string' ? override.provider.trim() : '',
  }
}

/**
 * 生成侧档位解析（后端模型不做宿主 llm 探测）：
 * - 未配置 → 全 null（调用方保持旧行为，不产生 meta 字段）；
 * - standard → 现有 taskConfig.model（无则后端默认）；
 * - fast/strong → costTierModels[档位].model；无映射 → 回退 standard 并标记 `no-model-mapping`。
 * @returns {{requestedCostTier:string|null, costTier:string|null, costTierFallback:boolean, costTierFallbackReason:string|null, model:string}}
 */
export function resolveGenerationCostTier(settings, task = 'storyboard') {
  const taskConfig =
    settings && settings.taskModels && typeof settings.taskModels === 'object' && settings.taskModels[task] && typeof settings.taskModels[task] === 'object'
      ? settings.taskModels[task]
      : {}
  const requested = isCostTier(taskConfig.costTier) ? taskConfig.costTier : null
  const standardModel = typeof taskConfig.model === 'string' ? taskConfig.model.trim() : ''
  if (!requested) {
    return { requestedCostTier: null, costTier: null, costTierFallback: false, costTierFallbackReason: null, model: '' }
  }
  if (requested === 'standard') {
    return { requestedCostTier: 'standard', costTier: 'standard', costTierFallback: false, costTierFallbackReason: null, model: standardModel }
  }
  const override = costTierOverrideOf(taskConfig)
  const overrideModel = override && !override.missing && typeof override.model === 'string' ? override.model : ''
  if (overrideModel) {
    return { requestedCostTier: requested, costTier: requested, costTierFallback: false, costTierFallbackReason: null, model: overrideModel }
  }
  return {
    requestedCostTier: requested,
    costTier: 'standard',
    costTierFallback: true,
    costTierFallbackReason: override && override.missing ? 'no-model-mapping' : 'tier-unavailable',
    model: standardModel,
  }
}
