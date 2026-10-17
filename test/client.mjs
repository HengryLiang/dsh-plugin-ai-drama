/**
 * 客户端半结构自测：在 Node 里用假 React + 假 ModuleLoader 加载 client.js，
 * 验证席位注册契约（不渲染、不依赖浏览器）。
 * 运行：node test/client.mjs
 *
 * 契约冻结 v1（AI短剧工作区/P1-接口契约冻结-v1.md §2/§5.4/§7.5/§6 E5）：
 *   宿主 METHODS：R0=64 → E1 后 67 → **E5 后 68（+sources-list）**；
 *   客户端去重调用：R0=51 → C-4 后 54 → T7/E1 后 57 → **client B 接入 sources-list 后 58**。
 * 本文件按**被测工件实际能力**自动判定期望值（旧工件无 doc-* 与 sources-list 时仍能全绿），
 * 同时可用 `EXPECT_HOST_METHODS` / `EXPECT_CLIENT_CALLS` 环境变量显式覆盖；
 * host/client 的 E1 能力必须**一致**；E5 的 client 接入在 B 阶段完成（期间 agent-only 允许 +1）。
 * 契约新增/变更时同步更新本注释与下方目标值，并在 P1/P2 验收证据登记。
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** P1-A C-4：面板必须接上的三条一级节点路由（二级节点 P1 不放开，见契约冻结 §7.3）。 */
const C4_CLIENT_ROUTES = ['entry-create', 'entry-rename', 'entry-delete']
/** E1/T6：编辑器往返三条路由必须由客户端接入（契约冻结 §7.5）。 */
const E1_CLIENT_ROUTES = ['doc-read', 'doc-save', 'doc-notify']
/** E5/P2-1：多数据源枚举路由（契约冻结 §6 变更登记）。 */
const E5_EXTRA_ROUTE = 'sources-list'
const HOST_METHODS_WITH_E5 = 68
const HOST_METHODS_WITH_E1 = 67
const HOST_METHODS_LEGACY = 64
const CLIENT_CALLS_WITH_E5 = 58
const CLIENT_CALLS_WITH_E1 = 57
const CLIENT_CALLS_LEGACY = 54

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(bundle) {
      loaded = bundle
    },
  },
}

await import(pathToFileURL(path.join(here, '..', 'client.js')).href)

let passed = 0
let failed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) passed += 1
  else {
    failed += 1
    failures.push(`${label}${detail ? ' -> ' + detail : ''}`)
    console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`)
  }
}

console.log('\n[1] 模块装载契约')
check('调用 window.__ModuleLoader__.load', loaded !== null)
check('id 为包名', loaded.id === 'dsh-plugin-ai-drama', String(loaded.id))
check('提供 factory', typeof loaded.factory === 'function')

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

const moduleExports = loaded.factory((name) => {
  if (name === 'react') return ReactStub
  throw new Error('未声明的运行时依赖：' + name)
})

console.log('\n[2] 插件导出契约')
check('导出 apply', typeof moduleExports.apply === 'function')
check('inject 仅声明 slots', Array.isArray(moduleExports.inject) && moduleExports.inject.length === 1 && moduleExports.inject[0] === 'slots', JSON.stringify(moduleExports.inject))

console.log('\n[3] 席位注册')
const registrations = []
const injected = []
const ctx = {
  slots: {
    inject(name, callback) {
      injected.push(name)
      return callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
moduleExports.apply(ctx)

check('inject 了 sidebar.panellist', injected.includes('sidebar.panellist'), injected.join(','))
check('inject 了 main', injected.includes('main'))
check('恰好注册两次', registrations.length === 2, String(registrations.length))

const icon = registrations.find((r) => r.options.name === 'sidebar.panellist')
const panel = registrations.find((r) => r.options.name === 'main')

check('侧栏入口存在', Boolean(icon))
check('侧栏 id = ai-drama', icon && icon.options.id === 'ai-drama', icon && String(icon.options.id))
check('侧栏 order 为数字', icon && typeof icon.options.order === 'number')
check('侧栏 label = AI 短剧', icon && icon.options.label === 'AI 短剧', icon && String(icon.options.label))
check('入口组件是函数', icon && typeof icon.component === 'function')

check('中央面板存在', Boolean(panel))
check('面板 key = ai-drama（与入口 id 一致）', panel && panel.options.key === 'ai-drama', panel && String(panel.options.key))
check('面板组件是函数', panel && typeof panel.component === 'function')

console.log('\n[4] 不触碰其他插件占用的席位')
const names = registrations.map((r) => r.options.name)
check('未注册 sidebar.workspaces', !names.includes('sidebar.workspaces'))
check('注册名仅两个', names.length === 2)

console.log('\n[5] 客户端调用的路由都真实存在（前后端路由对齐 · 契约冻结 v1）')
{
  const fs = await import('node:fs')
  const clientSrc = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')
  const hostSrc = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8')

  const methodsStart = hostSrc.indexOf('const METHODS = [')
  const methodsBlock = hostSrc.slice(methodsStart, hostSrc.indexOf(']', methodsStart))
  const hostMethods = new Set([...methodsBlock.matchAll(/'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))

  const called = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
  const missing = [...called].filter((m) => !hostMethods.has(m))
  const agentOnly = [...hostMethods].filter((m) => !called.has(m))

  // 按被测工件实际能力判定期望值（旧工件 v0.4.0=64/54；E1 后=67/57；E5 后=68/58；env 可覆盖）。
  const hostHasE1 = E1_CLIENT_ROUTES.every((m) => hostMethods.has(m))
  const clientCallsE1 = E1_CLIENT_ROUTES.every((m) => called.has(m))
  const hostHasE5 = hostMethods.has(E5_EXTRA_ROUTE)
  const clientCallsE5 = called.has(E5_EXTRA_ROUTE)
  const CONTRACT_HOST_METHODS = Number(
    process.env.EXPECT_HOST_METHODS || (hostHasE5 ? HOST_METHODS_WITH_E5 : hostHasE1 ? HOST_METHODS_WITH_E1 : HOST_METHODS_LEGACY),
  )
  const CONTRACT_CLIENT_CALLS = Number(
    process.env.EXPECT_CLIENT_CALLS || (clientCallsE5 ? CLIENT_CALLS_WITH_E5 : clientCallsE1 ? CLIENT_CALLS_WITH_E1 : CLIENT_CALLS_LEGACY),
  )
  // E5 的 client 接入在 B 阶段（task-20）；期间仅 Agent 用方法数允许 +1（sources-list）。
  const CONTRACT_AGENT_ONLY_MAX = Number(
    process.env.EXPECT_AGENT_ONLY_MAX || (hostHasE5 ? (clientCallsE5 ? 10 : 11) : hostHasE1 ? 10 : 13),
  )

  check(`宿主 METHOD 数 = 契约值 ${CONTRACT_HOST_METHODS}${hostHasE5 ? '（含 E5）' : hostHasE1 ? '（含 E1）' : '（旧工件）'}`, hostMethods.size === CONTRACT_HOST_METHODS, String(hostMethods.size))
  check(`客户端去重调用数 ≥ 契约下限 ${CONTRACT_CLIENT_CALLS}`, called.size >= CONTRACT_CLIENT_CALLS, String(called.size))
  check('不存在宿主未注册的路由', missing.length === 0, missing.join(', '))
  check(`仅 Agent 用方法数 ≤ ${CONTRACT_AGENT_ONLY_MAX}`, agentOnly.length <= CONTRACT_AGENT_ONLY_MAX, String(agentOnly.length))
  check('P1-A C-4：面板已接一级节点 create/rename/delete', C4_CLIENT_ROUTES.every((m) => called.has(m)), C4_CLIENT_ROUTES.filter((m) => !called.has(m)).join(','))
  check('E1/T6：host/client 的 doc-* 能力一致', hostHasE1 === clientCallsE1, `host=${hostHasE1} client=${clientCallsE1}`)
  if (hostHasE1) {
    check('E1/T6：面板已接编辑器往返 doc-read/doc-save/doc-notify', E1_CLIENT_ROUTES.every((m) => called.has(m)), E1_CLIENT_ROUTES.filter((m) => !called.has(m)).join(','))
  } else {
    console.log('      （旧工件 v0.4.0 无 E1 doc-*：期望 64/54，E1 用例跳过；E1 落地工件上自动切 67/57）')
  }
  if (hostHasE5) {
    if (clientCallsE5) {
      check('P2-1 E5：面板已接 sources-list（B 阶段）', true, '')
    } else {
      console.log('      （P2-1 E5：host 已有 sources-list，client B 阶段（task-20）待接入；agent-only 允许 11，接入后自动切 68/58/10）')
    }
  }
  console.log(`      宿主 ${hostMethods.size} 条 / 客户端调用 ${called.size} 条 / 仅 Agent 用 ${agentOnly.length} 条`)
}

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
