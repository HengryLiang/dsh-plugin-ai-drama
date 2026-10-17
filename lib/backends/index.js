/**
 * 阶段二 · 后端注册表（FR-G01）
 *
 * 适配层只暴露统一接口，业务代码不认具体平台：
 *   available(ctx)  → 可用性与能力位
 *   catalog(kind)   → 模型目录（后端能力范围内）
 *   estimate(input) → 成本预估（拿不到就如实说不，不猜价）
 *
 * 主选 = LibTV（官方 CLI `libtv` 子进程，priority 1）；备选 = NeoWoW CLI（`neowow` 子进程，priority 2）。
 * 两者形态一致：都在本地起子进程调用官方 CLI，不使用 Remote MCP 通道（D-03 注释修正）。
 */
import { createLibtvBackend, BACKEND_ID as LIBTV_ID } from './libtv.js'
import { createNeowowBackend, BACKEND_ID as NEOWOW_ID } from './neowow.js'

export { LIBTV_ID, NEOWOW_ID }

export function createBackendRegistry(config = {}) {
  const backends = [
    createLibtvBackend(config.libtv || {}),
    createNeowowBackend(config.neowow || {}),
  ]

  function list() {
    return backends.slice().sort((a, b) => a.priority - b.priority)
  }

  function get(id) {
    return backends.find((b) => b.id === id)
  }

  /**
   * 依次探测各后端；返回按优先级排序的结果，并标出当前应当使用的后端。
   * LibTV 未配置时自动落到备选，不需要用户手动切换（FR-G01 的「主后端不可用时提示并可切备选」）。
   */
  async function probe(context = {}) {
    const results = []
    for (const backend of list()) {
      let value
      try {
        value = await backend.available(context)
      } catch (error) {
        value = { ok: false, reason: 'probe-failed', detail: error instanceof Error ? error.message : String(error) }
      }
      results.push({
        id: backend.id,
        label: backend.label,
        kind: backend.kind,
        priority: backend.priority,
        endpoint: backend.endpoint || null,
        ...value,
      })
    }
    const active = results.find((r) => r.ok) || null
    return {
      backends: results,
      activeBackend: active ? active.id : null,
      degraded: !results[0].ok,
      note: active
        ? active.id === LIBTV_ID
          ? '主选后端可用'
          : '主选（LibTV）不可用，已落到备选（neowow）'
        : '两个后端都不可用：LibTV 未配置、neowow 未登录或未安装',
    }
  }

  return { list, get, probe, ids: backends.map((b) => b.id) }
}
