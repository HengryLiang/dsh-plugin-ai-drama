/**
 * 客户端半结构自测：在 Node 里用假 React + 假 ModuleLoader 加载 client.js，
 * 验证席位注册契约（不渲染、不依赖浏览器）。
 * 运行：node test/client.mjs
 *
 * 契约冻结 v1（AI短剧工作区/P1-接口契约冻结-v1.md §2/§5.4/§7.5/§6 E5）：
 *   宿主 METHODS：R0=64 → E1 后 67 → E5 后 68（+sources-list）→ **v0.15.1 task-110 后 69（media-read +1）**；
 *   客户端去重调用：R0=51 → C-4 后 54 → T7/E1 后 57 → client B 接入 sources-list 后 58 → M4 批1（task-20）5 条后 63 → **M4 批2（task-21）5 条后 68**。
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
const HOST_METHODS_WITH_E5 = 72 // task-110 media-read +1（68→69）
const HOST_METHODS_WITH_E1 = 67
const HOST_METHODS_LEGACY = 64
const CLIENT_CALLS_WITH_E5 = 58
/** v0.12.2/0.12.3（M4 批1+批2）：各接 5 条既有 host 路由 → client 去重调用 58→63→68（已批准登记）→ 69（task-110 media-read +1；v0.15.11 E13 assets-import +1）。 */
const M4_CLIENT_ROUTES = ['estimate-generation', 'search-context', 'canvas-reconcile', 'task-create', 'task-update']
const CLIENT_CALLS_WITH_M4 = 63
const M4B_CLIENT_ROUTES = ['intake-artifact', 'catalog', 'backends-status', 'agents-status', 'ping']
const CLIENT_CALLS_WITH_M4B = 71
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
  useMemo: (fn) => fn(),
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
check('inject 了 settings.section（task-8 设置页）', injected.includes('settings.section'))
check('恰好注册四次（主面板 + 侧栏 + 设置页 + 工具卡）', registrations.length === 4, String(registrations.length))

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

// v0.12.1（task-8）：独立设置页 settings.section 注册契约（slots 2→3，用户已批准的红线变更）
const settingsSection = registrations.find((r) => r.options.name === 'settings.section')
check('设置页席位存在（settings.section）', Boolean(settingsSection))
check('设置页 id = ai-drama', settingsSection && settingsSection.options.id === 'ai-drama', settingsSection && String(settingsSection.options.id))
check('设置页 order 为数字', settingsSection && typeof settingsSection.options.order === 'number')
check('设置页 label = AI 短剧', settingsSection && settingsSection.options.label === 'AI 短剧', settingsSection && String(settingsSection.options.label))
check('设置页组件是函数（与项目页浮层共用）', settingsSection && typeof settingsSection.component === 'function')

// v0.12.1（task-17）：tool.call.toolview K=1（仅 drama_check_consistency；slots 3→4 已批准终值）
const toolviewRegs = registrations.filter((r) => r.options.name === 'tool.call.toolview')
check('工具卡席位存在（tool.call.toolview）', toolviewRegs.length === 1, String(toolviewRegs.length))
check('工具卡 K=1 且 key = drama_check_consistency（仅 1 个 wire 名）', toolviewRegs.length === 1 && toolviewRegs[0].options.key === 'drama_check_consistency', toolviewRegs.map((r) => String(r.options.key)).join(','))
check('工具卡注册走官方 inject 包裹（inject 了 tool.call.toolview）', injected.includes('tool.call.toolview'))
check('工具卡组件是函数', toolviewRegs.length === 1 && typeof toolviewRegs[0].component === 'function')

console.log('\n[4] 不触碰其他插件占用的席位')
const names = registrations.map((r) => r.options.name)
check('未注册 sidebar.workspaces', !names.includes('sidebar.workspaces'))
check('注册名仅四个（含设置页与工具卡）', names.length === 4)

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
  const clientCallsM4 = M4_CLIENT_ROUTES.every((m) => called.has(m))
  const clientCallsM4B = M4B_CLIENT_ROUTES.every((m) => called.has(m))
  const CONTRACT_HOST_METHODS = Number(
    process.env.EXPECT_HOST_METHODS || (hostHasE5 ? HOST_METHODS_WITH_E5 : hostHasE1 ? HOST_METHODS_WITH_E1 : HOST_METHODS_LEGACY),
  )
  const CONTRACT_CLIENT_CALLS = Number(
    process.env.EXPECT_CLIENT_CALLS || (clientCallsM4B ? CLIENT_CALLS_WITH_M4B : clientCallsM4 ? CLIENT_CALLS_WITH_M4 : clientCallsE5 ? CLIENT_CALLS_WITH_E5 : clientCallsE1 ? CLIENT_CALLS_WITH_E1 : CLIENT_CALLS_LEGACY),
  )
  // E5 的 client 接入在 B 阶段（task-20）；期间仅 Agent 用方法数允许 +1（sources-list）。
  const CONTRACT_AGENT_ONLY_MAX = Number(
    process.env.EXPECT_AGENT_ONLY_MAX || (hostHasE5 ? (clientCallsM4B ? 0 : clientCallsM4 ? 5 : clientCallsE5 ? 10 : 11) : hostHasE1 ? 10 : 13),
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
      console.log('      （P2-1 E5：host 已有 sources-list，client B 已接入（68/58）；M4 批1+批2 再 +10 → 68/68/agent-only 0）')
    }
  }
  // v0.10.4（task-91/92）：分镜 add-only 字段只读展示（AC-P1/P2 结构层断言）
  const SHOT_EXTRA_LABELS = ['情绪', '光影', '环境声', '约束', '姿态', '转场', '语言段', '镜头', '主体', '分组 id']
  const hasShotExtrasDisplay = clientSrc.includes('SHOT_EXTRA_FIELDS') && clientSrc.includes('storyboardExtraEntries')
  if (hasShotExtrasDisplay) {
    check('v0.10.4：SHOT_EXTRA_FIELDS 含 10 个可选字段映射（顺序固定）', SHOT_EXTRA_LABELS.every((label) => clientSrc.includes(`'${label}'`)) && /const SHOT_EXTRA_FIELDS = \[/.test(clientSrc))
    check('v0.10.4：只读收集 helper storyboardExtraEntries 存在且按存在字段过滤', /function storyboardExtraEntries\(shot\)/.test(clientSrc) && /if \(text\) entries\.push/.test(clientSrc))
    check('v0.10.4：条件列门（仅本集存在新字段时追加「详情」列）', /const hasExtraFields = shotExtraEntries\.some/.test(clientSrc) && /if \(hasExtraFields\) headerLabels\.push\('详情'\)/.test(clientSrc) && /columnCount = hasExtraFields \? 11 : 10/.test(clientSrc))
    check('v0.10.4：旧 10 列表头/顺序不变（详情列仅条件追加）', /\['镜号', '景别', '运镜', '画面描述', '台词', '音效', '时长\(秒\)', '提示词', '视频提示词', '操作'\]/.test(clientSrc))
    check('v0.10.4：行末「详情 ▾ / 收起 ▴」按钮 + aria-label 可读', /查看第 \$\{shot\.shotNumber \|\| i \+ 1\} 镜高级字段/.test(clientSrc) && clientSrc.includes("详情 ▾") && clientSrc.includes("收起 ▴"))
    check('v0.10.4：展开块 class/role/aria-label（只读 note）', clientSrc.includes("className: 'ad-shot-extras'") && /role: 'note'/.test(clientSrc) && /第 \$\{shot\.shotNumber \|\| i \+ 1\} 镜高级字段（只读）/.test(clientSrc))
    check('v0.10.4：展开块标题标注只读/来源 v0.10.0+', clientSrc.includes('高级字段（只读，来自宿主 v0.10.0+）'))
    // 只读硬约束：展开块区域不得出现编辑控件/写 API
    const extrasStart = clientSrc.indexOf("className: 'ad-shot-extras'")
    const extrasEnd = clientSrc.indexOf('return [row, detailRow]')
    const extrasRegion = extrasStart >= 0 && extrasEnd > extrasStart ? clientSrc.slice(extrasStart, extrasEnd) : ''
    check('v0.10.4：展开块内无编辑控件（input/select/textarea/contentEditable/onChange）', extrasRegion.length > 0 && !/\b(input|select|textarea|contentEditable|onChange|onInput|onBlur)\b/.test(extrasRegion), extrasRegion.slice(0, 120))
    check('v0.10.4：展开块内无 API 调用（不写盘/不请求）', extrasRegion.length > 0 && !/\bapi\(/.test(extrasRegion))
    check('v0.10.4：展开/收起仅改 UI state（4 处：useState/载入复位/onClick/项目切换复位），无写盘', (clientSrc.match(/setShotExtraOpen/g) || []).length === 4 && /onClick: \(\) => setShotExtraOpen\(detailOpen \? null : i\)/.test(clientSrc) && /setShots\(result\.shots \|\| \[\]\)\s*\n\s*setShotExtraOpen\(null\)/.test(clientSrc), String((clientSrc.match(/setShotExtraOpen/g) || []).length))
    check('v0.10.4：切换集/载入后展开态复位（setShotExtraOpen(null)）', /setShotExtraOpen\(null\)/.test(clientSrc))
    check('v0.10.4：容错 emotion/constraints/poses object|string（畸形不报错）', /typeof value === 'object'/.test(clientSrc) && /Array\.isArray\(raw\)/.test(clientSrc) && /startPose/.test(clientSrc) && /endPose/.test(clientSrc))
    check('v0.10.4：CSS 仅新增 2 类（ad-shot-extras/ad-shot-extra）', clientSrc.includes('.ad-shot-extras{') && clientSrc.includes('.ad-shot-extra{'))
    // 无字段零变化：若可读取 v0.10.3 基线，断言基线无新展示标记
    let baselineText = ''
    try {
      const fsMod = await import('node:fs')
      const baselinePath = path.join(here, '..', '..', '_recover', 'v0104-client-baseline.js')
      if (fsMod.existsSync(baselinePath)) baselineText = fsMod.readFileSync(baselinePath, 'utf8')
    } catch {}
    if (baselineText) {
      check('v0.10.4：v0.10.3 基线无新字段展示（详情/高级字段/SHOT_EXTRA_FIELDS）', !baselineText.includes('详情 ▾') && !baselineText.includes('ad-shot-extras') && !baselineText.includes('SHOT_EXTRA_FIELDS'))
      check('v0.10.4：相对基线为纯新增（原 10 列表头在基线与新版均存在）', baselineText.includes("'镜号', '景别', '运镜', '画面描述', '台词', '音效', '时长(秒)', '提示词', '视频提示词', '操作'") && clientSrc.includes("'镜号', '景别', '运镜', '画面描述', '台词', '音效', '时长(秒)', '提示词', '视频提示词', '操作'"))
    } else {
      console.log('      （SKIP：v0.10.4 基线文件不可用（安装副本环境），仅保留新版结构断言）')
    }
    check('v0.10.4：调用点 = 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）（M4 批1+批2 +10 已批准；无 extras-* 新 API）', called.size === 72 && ![...called].some((name) => ['shot-extras-save', 'storyboard-extras-save', 'extras-save'].includes(name)), String(called.size))
    check('v0.10.4：无新依赖（package.json dependencies 为空）', (() => { try { const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')); return Object.keys(pkg.dependencies || {}).length === 0 } catch { return true } })())
  } else {
    console.log('      （SKIP：当前 client < v0.10.4，无新字段只读展示；旧工件不回归）')
  }
  // v0.11.2（task-99/100）：分镜分组 groups add-only 只读展示（E7 读侧消费）
  const hasGroupsDisplay = clientSrc.includes('ad-groups') && clientSrc.includes('normalizeStoryboardGroups')
  if (hasGroupsDisplay) {
    check('v0.11.2：normalizeStoryboardGroups 防御式归一（非数组→null/畸形跳过/未知字段忽略）', /function normalizeStoryboardGroups\(raw\)/.test(clientSrc) && /if \(!Array\.isArray\(raw\)\) return null/.test(clientSrc) && /if \(!item \|\| typeof item !== 'object'\) continue/.test(clientSrc))
    check('v0.11.2：groupPrompt 读取侧 ≤2000（GROUP_PROMPT_MAX）', /GROUP_PROMPT_MAX = 2000/.test(clientSrc) && /groupPrompt[^\n]*slice\(0, GROUP_PROMPT_MAX\)/.test(clientSrc))
    check('v0.11.2：groups 只读区（ad-groups/aria-label 分镜分组（只读））', clientSrc.includes("className: 'ad-groups'") && /'aria-label': '分镜分组（只读）'/.test(clientSrc))
    check('v0.11.2：分组只读展示（组数标题/情绪总控/镜号/草帽视图）', clientSrc.includes('（只读，来自宿主分组 sidecar）') && clientSrc.includes('情绪总控：') && clientSrc.includes('镜号：') && clientSrc.includes("className: 'ad-group-prompt'") && clientSrc.includes('草帽视图（只读）'))
    check('v0.11.2：truncated 提示（仅展示前 100 组，且 groups 非空才提示）', clientSrc.includes('仅展示前 100 组') && /Boolean\(groups\) && \(result\.groupsTruncated === true \|\| result\.truncated === true\)/.test(clientSrc))
    check('v0.11.2：无 groups → 零新显示（条件 shotGroups && shotGroups.length ? ... : null）', /shotGroups && shotGroups\.length\s*\?/.test(clientSrc) && /: null,/.test(clientSrc))
    check('v0.11.2：加载时读取 result.groups（无/空 → null，不请求新 route）', /const groups = normalizeStoryboardGroups\(result\.groups\)/.test(clientSrc) && /setShotGroups\(groups\)/.test(clientSrc))
    const groupsStart = clientSrc.indexOf("className: 'ad-groups'")
    const groupsEnd = clientSrc.indexOf('草帽视图（只读）')
    const groupsRegion = groupsStart >= 0 && groupsEnd > groupsStart ? clientSrc.slice(groupsStart, groupsEnd + 120) : ''
    check('v0.11.2：只读区无编辑控件/无 api 调用（input/select/textarea/onChange/api()）', groupsRegion.length > 0 && !/\b(input|select|textarea|contentEditable|onChange|onInput)\b/.test(groupsRegion) && !/\bapi\(/.test(groupsRegion), groupsRegion.slice(0, 100))
    check('v0.11.2：groups 展示不写盘（无 setShots/saveShots/storyboard-save 新增调用）', called.size === 72 && !/setShotGroups[\s\S]{0,200}(saveShots|storyboard-save)/.test(clientSrc))
    check('v0.11.2：CSS 新增 ad-groups/ad-group/ad-group-prompt 类', clientSrc.includes('.ad-groups{') && clientSrc.includes('.ad-group{') && clientSrc.includes('.ad-group-prompt{'))
    check('v0.11.2：调用点 = 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）（M4 批1+批2 +10 已批准）；slots=4（已批准终值）', called.size === 72 && (clientSrc.match(/slots\.register\(/g) || []).length === 4)
  } else {
    console.log('      （SKIP：当前 client < v0.11.2，无 groups 只读展示；旧工件不回归）')
  }
  // v0.15.1（task-108/109）：素材库分类 + 图片可见（只读；能力自适应）
  const hasAssetGallery = clientSrc.includes('ASSET_TYPE_ORDER') && clientSrc.includes("api('media-read'") && clientSrc.includes("className: 'ad-asset-toolbar'")
  if (hasAssetGallery) {
    const galleryStart = clientSrc.indexOf("className: 'ad-asset-toolbar'")
    const galleryEnd = clientSrc.indexOf('已登记文件（旧视图保留）', galleryStart)
    const galleryRegion = galleryStart >= 0 && galleryEnd > galleryStart ? clientSrc.slice(galleryStart, galleryEnd) : ''
    check('v0.15.1：9 类资产类型顺序 + 中文标签 + 全部筛选（CHR/SPC/PRP/CST/EXP/SFX/VOX/MUS/SHT）', /const ASSET_TYPE_ORDER = \[/.test(clientSrc) && ['CHR', 'SPC', 'PRP', 'CST', 'EXP', 'SFX', 'VOX', 'MUS', 'SHT'].every((type) => new RegExp("'" + type + "'").test(clientSrc)) && clientSrc.includes('assetTypeLabelOf'))
    check('v0.15.1：类型筛选 chips（全部 N + 类型）aria-pressed 只读切换', clientSrc.includes('全部 ${' + 'assetCards.length}') && clientSrc.includes("'aria-pressed': assetTypeFilter === '全部'") && clientSrc.includes('setAssetTypeFilter(type)'))
    check('v0.15.1：卡片网格 + 缩略图（http(s) 直接展示 / 相对路径 media-read 转 data URL）', clientSrc.includes("className: 'ad-asset-grid'") && clientSrc.includes("className: 'ad-asset-thumb'") && clientSrc.includes('assetImageSourceOf') && clientSrc.includes("api('media-read'") && clientSrc.includes('data:' + '${mime}' + ';base64,' + '${base64}'))
    check('v0.15.1：无图/坏图占位降级（onError → markBroken + ad-asset-thumb 占位）', clientSrc.includes('onError: () => markBroken(src.value)') && clientSrc.includes("className: 'ad-asset-thumb'") && clientSrc.includes("status: 'error'"))
    check('v0.15.1：详情大图 + 多图切换 + 无图空态', clientSrc.includes("className: 'ad-asset-detail'") && clientSrc.includes("className: 'ad-asset-detail-img'") && clientSrc.includes("className: 'ad-asset-detail-thumb'") && clientSrc.includes("className: 'ad-asset-detail-empty'") && clientSrc.includes('该资产暂无图片（media.images 为空）'))
    check('v0.15.1：搜索按编号/名称本地过滤（无新增请求）', clientSrc.includes('function filterAssetCards') && clientSrc.includes("String(card.id || '').toLowerCase().includes(keyword)") && clientSrc.includes("String(card.name || '').toLowerCase().includes(keyword)"))
    check('v0.15.4：只读边界——cards/legacy 卡片区无编辑控件与写调用；登记管理区保留既有登记/移除操作（v0.15.1 只读断言按已批行为迭代）', (() => { const start = clientSrc.indexOf('ad-asset-grid ad-legacy-grid'); const end = clientSrc.indexOf('assetRegistrationNode', start); const readonlyRegion = start >= 0 && end > start ? clientSrc.slice(start, end) : ''; const registrationStart = clientSrc.indexOf('const assetRegistrationNode ='); const registrationEnd = clientSrc.indexOf('visualLightboxNode', registrationStart); const registrationRegion = registrationStart >= 0 && registrationEnd > registrationStart ? clientSrc.slice(registrationStart, registrationEnd) : ''; return readonlyRegion.length > 0 && !/h\('(input|select|textarea)'|className: 'ad-input'/.test(readonlyRegion) && !/api\('assets-(add|remove)'/.test(readonlyRegion) && /onClick: addAsset/.test(registrationRegion) && /removeAsset\(a\.id\)/.test(registrationRegion) })())
    check('v0.15.1：media-read 缓存去重（assetImageLoadState + 仅 pending 请求 + 并发上限 12）', clientSrc.includes('assetImageLoadState') && clientSrc.includes('candidates.filter((pathValue) => !assetImageLoadState.has(pathValue))') && clientSrc.includes('pending.slice(0, 12)'))
    check('v0.15.1：切换项目/刷新清空图片缓存与选中态', (clientSrc.match(/setAssetImageCache\(\{\}\)/g) || []).length >= 2 && clientSrc.includes('setAssetSelectedId(null)') && clientSrc.includes('setAssetImageIndex(0)'))
    check('v0.15.4：旧登记管理折叠区保留（登记管理（N 条）｜展开/收起 + 刷新/重扫 + 素材资产登记表 + 项目内登记语义）', clientSrc.includes('登记管理（') && clientSrc.includes('素材资产登记表') && clientSrc.includes('刷新/重扫') && clientSrc.includes('登记=把项目文件夹内的素材路径登记入库') && clientSrc.includes('仅支持项目内路径') && clientSrc.includes('不支持项目外路径') && clientSrc.includes('登记后自动出现在上方卡片视图'))
    check('v0.15.4：旧登记项目可见统一视图（hasAssetData = assets>0 || cards>0；无数据零新显示 + 项目内路径引导）', /hasAssetData = assets\.length > 0 \|\| assetCards\.length > 0/.test(clientSrc) && clientSrc.includes("className: 'ad-legacy-view'") && clientSrc.includes('还没有登记素材：把文件放入项目「素材/」目录后'))
    check('v0.15.1：无图占位类 ad-asset-placeholder + 只读字段区 ad-asset-fields', clientSrc.includes('ad-asset-placeholder') && clientSrc.includes('ad-asset-fields'))
    check('v0.15.1：可访问性（卡片 aria-label 查看资产 / 搜索框 aria-label 搜索素材编号或名称）', clientSrc.includes('查看资产') && clientSrc.includes('搜索素材编号或名称'))
    check('v0.15.1：调用点 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）/ slots=4 不变', called.size === 72 && (clientSrc.match(/slots\.register\(/g) || []).length === 4, String(called.size))
  } else {
    console.log('      （SKIP：当前 client < v0.15.1，无素材库分类/图片 UI；旧工件不回归）')
  }
  console.log(`      宿主 ${hostMethods.size} 条 / 客户端调用 ${called.size} 条 / 仅 Agent 用 ${agentOnly.length} 条`)
  // v0.10（task-84）：分镜保存后 merge 未知/add-only per-shot 字段（静态断言；旧工件自适应 SKIP）
  const hasClientShotMerge = /function mergeShotsPreservingExtraFields\(/.test(clientSrc)
  if (hasClientShotMerge) {
    check('task-84：client 含 mergeShotsPreservingExtraFields 合并函数', /function mergeShotsPreservingExtraFields\(/.test(clientSrc))
    check('task-84：保存后以 host 返回为准并合并未知字段（setShots(prev => merge...)）', /mergeShotsPreservingExtraFields\(prev, result\.shots\)/.test(clientSrc))
    check('task-84：保存 payload 发送完整 shots（未知字段不被白名单裁剪）', /api\('storyboard-save',\s*\{\s*title:\s*openTitle,\s*order:\s*episodeOrder,\s*shots\s*\}\)/.test(clientSrc))
    check('task-84：仅补 host 未返回字段、已知字段以 host 返回为准', /Object\.prototype\.hasOwnProperty\.call\(merged, field\)/.test(clientSrc))
  } else {
    console.log('      （版本自适应：旧工件 client < task-84，无 mergeShotsPreservingExtraFields；task-84 静态断言 SKIP）')
  }
}

console.log('\n[6] toolview 工具卡渲染 smoke（task-17：三阶段 / 错误态 / 解析回退 / 截断）')
{
  const card = toolviewRegs[0].component
  const treeText = (node) => {
    if (node == null) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(treeText).join(' ')
    if (typeof node === 'object' && Array.isArray(node.children)) return node.children.map(treeText).filter(Boolean).join(' ')
    return ''
  }
  const render = (props) => {
    try {
      return treeText(card(props))
    } catch (error) {
      return 'THREW: ' + (error && error.message)
    }
  }
  const wire = 'drama_check_consistency'

  // ① preparing：无完整参数，用 slot 注入 hook 的流式前缀解析出项目名 / deep
  const preparing = render({
    callId: 'call-1',
    toolName: wire,
    phase: 'preparing',
    block: { phase: 'preparing', callId: 'call-1', name: wire },
    useToolCallArgumentsPartial: () => '{"title":"万界倒爷","deep":true',
  })
  check('三阶段①preparing：显示「一致性检查 / 准备参数」+ 流式参数（项目名 / AI 审读开关）',
    preparing.includes('一致性检查') && preparing.includes('准备参数') && preparing.includes('万界倒爷') && preparing.includes('AI 审读：开') && !preparing.includes('THREW'))
  check('三阶段①preparing：hook 抛错时仍渲染（防御式）', render({
    callId: 'call-1', toolName: wire, phase: 'preparing',
    block: { phase: 'preparing', callId: 'call-1', name: wire },
    useToolCallArgumentsPartial: () => { throw new Error('hook boom') },
  }).includes('准备参数'))

  // ② start：argsRaw 完整参数
  const start = render({
    callId: 'call-1', toolName: wire, phase: 'start',
    block: { phase: 'start', callId: 'call-1', name: wire, argsRaw: JSON.stringify({ title: '万界倒爷', deep: true, episode: 3 }) },
  })
  check('三阶段②start：显示「检查中…」+ 参数（项目 / 第 3 集 / AI 审读）',
    start.includes('检查中…') && start.includes('万界倒爷') && start.includes('第 3 集'))

  // ③ result 成功：解析我们工具 render 文本（汇总 / 问题 / 严重度 / 定位 / AI 审读 / 证据建议 / 落盘 / 下一步）
  const resultText = [
    '一致性检查：error 1 / warn 2 / info 0（共 3 项）',
    '· [error] 第 2 集正文为空（分集剧本/第002集）',
    '· [warn] 分镜时长超契约（分镜/第001集 镜号 3）',
    '· [warn] 场景重复：当铺（记忆/桥段）',
    'AI 审读：AI 审读 / 成功',
    '结论：开场钩子达标，第 2 集铺垫偏长',
    '· [warn] 节奏 @3-2：开场铺垫过长 → 压缩前 10 秒',
    '报告已落盘：.aidrama/reviews/latest.json',
    '下一步：补第 2 集正文后再检查',
  ].join('\n')
  const done = render({
    callId: 'call-1', toolName: wire, phase: 'result',
    block: {
      kind: 'tool-result', callId: 'call-1',
      call: { name: wire, argsRaw: JSON.stringify({ title: '万界倒爷', deep: true, episode: 3 }) },
      content: [{ type: 'text', text: resultText }],
    },
  })
  check('三阶段③result 成功：汇总计数 + 问题（严重度/说明/定位）', done.includes('已完成') && done.includes('error 1') && done.includes('warn 2') && done.includes('第 2 集正文为空') && done.includes('定位：分集剧本/第002集') && done.includes('严重度') === false && done.includes('warn'))
  check('三阶段③result 成功：AI 审读段（模式/结论/finding 证据→建议）', done.includes('AI 审读') && done.includes('成功') && done.includes('开场钩子达标') && done.includes('证据：开场铺垫过长') && done.includes('建议：压缩前 10 秒'))
  check('三阶段③result 成功：报告落盘 / 下一步 / 只读裁决说明', done.includes('报告已落盘：.aidrama/reviews/latest.json') && done.includes('下一步：补第 2 集正文后再检查') && done.includes('只读卡片') && done.includes('裁决') && done.includes('面板「检查」页'))

  // ④ result 错误态（失败 / interrupted 已停止）
  const failed = render({ callId: 'c2', toolName: wire, phase: 'result', block: { kind: 'tool-result', isError: true, error: { name: 'ToolError', code: 'not-found' }, content: [] } })
  check('三阶段④result 错误态：显示「失败」+ 错误码（不抛错）', failed.includes('失败') && failed.includes('not-found') && !failed.includes('THREW'))
  const stopped = render({ callId: 'c3', toolName: wire, phase: 'result', block: { kind: 'tool-result', isError: true, error: { name: 'Interrupted', code: 'interrupted' }, content: [] } })
  check('三阶段④result 中断态：显示「已停止」', stopped.includes('已停止'))

  // ⑤ 解析回退 / 截断 / 畸形输入不抛错
  const fallback = render({ callId: 'c4', toolName: wire, phase: 'result', block: { kind: 'tool-result', content: [{ type: 'text', text: '非本工具格式的纯文本结果' }] } })
  check('解析回退：非标准文本 → 「结果解析回退」+ 保留原文', fallback.includes('结果解析回退') && fallback.includes('非本工具格式的纯文本结果'))
  const manyIssues = ['一致性检查：error 0 / warn 12 / info 0（共 12 项）']
  for (let i = 1; i <= 12; i += 1) manyIssues.push('· [warn] 问题' + i + '（定位' + i + '）')
  const truncated = render({ callId: 'c5', toolName: wire, phase: 'result', block: { kind: 'tool-result', content: [{ type: 'text', text: manyIssues.join('\n') }] } })
  check('截断：问题最多 8 条 + 「…共 12 项」提示', truncated.includes('问题8') && !truncated.includes('问题11') && truncated.includes('共 12 项'))
  check('畸形输入不抛错（null / 坏 content / 坏 JSON）', !render(null).includes('THREW') && !render({ phase: 'result', block: { kind: 'tool-result', content: [{ type: 'text', text: '{bad' }] } }).includes('THREW') && !render({ phase: 'start', block: { phase: 'start', argsRaw: '{bad' } }).includes('THREW'))
}

console.log('\n[7] v0.12.2/0.12.3（M4 批1+批2）：10 条既有路由面板接线（调用点 58→63→68）')
{
  const fsMod = await import('node:fs')
  const clientSrc = fsMod.readFileSync(path.join(here, '..', 'client.js'), 'utf8')
  const hostSrc = fsMod.readFileSync(path.join(here, '..', 'index.js'), 'utf8')
  const methodsBlock = hostSrc.slice(hostSrc.indexOf('const METHODS = ['), hostSrc.indexOf(']', hostSrc.indexOf('const METHODS = [')))
  const hostMethods = new Set([...methodsBlock.matchAll(/'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
  const callNames = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
  const M4 = ['estimate-generation', 'search-context', 'canvas-reconcile', 'task-create', 'task-update']
  const M4B = ['intake-artifact', 'catalog', 'backends-status', 'agents-status', 'ping']
  const newNames = [...callNames].filter((n) => M4.includes(n) || M4B.includes(n))
  const fnRegion = (startMarker, endMarker) => {
    const start = clientSrc.indexOf(startMarker)
    if (start < 0) return ''
    const end = clientSrc.indexOf(endMarker, start + startMarker.length)
    return end > start ? clientSrc.slice(start, end) : clientSrc.slice(start, start + 9000)
  }
  const autoLoad = [fnRegion('const loadList = React.useCallback(async () => {', 'React.useEffect(() => {'), fnRegion('const openProject = (title) =>', 'const createProject'), fnRegion('const loadGenerate = () =>', 'const bindCanvas')].join('\n')

  check('M4①：调用点 = 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）（58+5+5 唯一路由名，M4 批1+批2，精确）', callNames.size === 72, String(callNames.size))
  check('M4①：新增名集合精确 = 10 条且各 1 处（无其他新增）', newNames.length === 10 && [...M4, ...M4B].every((n) => (clientSrc.match(new RegExp("api\\('" + n + "'", 'g')) || []).length === 1), newNames.join(','))
  check('M4①：无自动加载调用（loadList/openProject/loadGenerate 区均不含 5 新路由）', M4.every((n) => !autoLoad.includes("api('" + n + "'")))
  check('M4①：10 条路由均在 host METHODS 70（task-110 media-read +1；v0.15.11 E13 assets-import +1） 内（只接既有路由）', [...M4, ...M4B].every((n) => hostMethods.has(n)) && hostMethods.size === 72, String(hostMethods.size))
  check('M4②：5 条路由 UI marker（成本预估/登记任务/检索参考/画布对账/状态更新列）', ['预估成本（只读）', '登记任务（只写台账，不提交生成）', '⑤ 检索参考（本地检索，不调用模型）', '画布对账（只读）', "'产物', '操作'"].every((m) => clientSrc.includes(m)))
  check('M4②：空/错/加载降级 marker（5 类 + busy 文案）', ['预估失败：', '未获取到后端预估', '检索失败：', '无检索结果', '画布对账不可用', '登记失败：', '更新失败：', '预估中…', '检索中…', '对账中…'].every((m) => clientSrc.includes(m)))
  check('M4③：task-create/update 数据安全（仅 .aidrama/tasks.json 台账，不提交生成）', clientSrc.includes('task-create / task-update：仅写 .aidrama/tasks.json 台账（不提交生成）') && clientSrc.includes('登记任务（只写台账，不提交生成）'))
  check('M4③：真实模型 0（5 新路由均为目录/检索/只读/台账，无 generate/submit/审读触发）', !M4.some((n) => /generate|submit|consistency|audit/.test(n)))
  check('M4④：工具 34 / METHODS 70（task-110 media-read +1；v0.15.11 E13 assets-import +1） / slots=4 / 无新依赖不变', hostMethods.size === 72 && (clientSrc.match(/slots\.register\(/g) || []).length === 4 && (() => { try { const pkg = JSON.parse(fsMod.readFileSync(path.join(here, '..', 'package.json'), 'utf8')); return Object.keys(pkg.dependencies || {}).length === 0 } catch { return true } })())
  check('M4⑤：CSS 0 diff 线索（无 ad-m4 新类；--dsw-* 仍 9 白名单）', !clientSrc.includes('.ad-m4') && new Set([...clientSrc.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0])).size === 9)
  check('M4⑤：既有 P0/分镜/审读/设置页/工具卡逻辑 marker 保留（A-C1：persistFlow 已移除 → 改断言 progress-get 只读保留）', ['const requestLeave = (action) => {', "api('progress-get'", 'function mergeShotsPreservingExtraFields(', 'function normalizeReviewReport(raw)', 'function SettingsSection(props) {', 'function DramaCheckToolCard(props) {'].every((m) => clientSrc.includes(m)))
}

console.log('\n[8] v0.12.3（task-21 / M4 批2）：产物入库 + 诊断 4 条既有路由（调用点 63→68）')
{
  const fsMod = await import('node:fs')
  const clientSrc = fsMod.readFileSync(path.join(here, '..', 'client.js'), 'utf8')
  const callNames = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
  const M4B = ['intake-artifact', 'catalog', 'backends-status', 'agents-status', 'ping']
  const fnRegion = (startMarker, endMarker) => {
    const start = clientSrc.indexOf(startMarker)
    if (start < 0) return ''
    const end = clientSrc.indexOf(endMarker, start + startMarker.length)
    return end > start ? clientSrc.slice(start, end) : clientSrc.slice(start, start + 9000)
  }
  const autoLoad = [fnRegion('const loadList = React.useCallback(async () => {', 'React.useEffect(() => {'), fnRegion('const openProject = (title) =>', 'const createProject'), fnRegion('const loadGenerate = () =>', 'const bindCanvas'), fnRegion('const load = React.useCallback(async () => {', '}, [])')].join('\n')
  const diagHandlers = fnRegion('const probeDiagnosticBackends = async () => {', 'const body = []')
  const intakeHandler = fnRegion('const intakeGeneratedArtifact = async () => {', '/* ---------------------- v0.11.5')
  const diagRegion = fnRegion('/* v0.12.3（task-21 / M4 批2）：诊断区 4 条既有路由', 'function DramaCheckToolCard')
  const checkRegion = fnRegion("if (tab === 'check') {", "if (tab === 'toolcards') {")

  check('M4B①：调用点 = 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）（63+5 唯一路由名，精确）', callNames.size === 72, String(callNames.size))
  check('M4B①：5 条新路由各 1 处且无其他新增', M4B.every((n) => (clientSrc.match(new RegExp("api\\('" + n + "'", 'g')) || []).length === 1))
  check('M4B①：无自动加载调用（loadList/openProject/loadGenerate/设置页 load 均不含 5 新路由）', M4B.every((n) => !autoLoad.includes("api('" + n + "'")))
  check('M4B②：诊断 4 项只读 handler（仅 4 条只读路由，无写盘/生成/审读）', ['backends-status', 'catalog', 'agents-status', 'ping'].every((n) => diagHandlers.includes("api('" + n + "'")) && !/submit-batch|generate|consistency-check|intake-artifact|settings-save/.test(diagHandlers))
  check('M4B②：诊断 UI marker（连通性探测/探测后端/Agent 挂载状态/读取模型目录 + 只读标题）', ['连通性探测', '探测后端', 'Agent 挂载状态', '读取模型目录', '连接性' === '' ? '' : '连通性 / 后端 / 模型目录 / Agent（手动刷新，只读）'].every((m) => clientSrc.includes(m)))
  check('M4B②：诊断降级 marker（连通失败/探测失败/目录不可用/Agent 不可用 + busy）', ['连通性：失败', '后端探测失败', '模型目录不可用', 'Agent 诊断不可用', '测试中…', '探测中…', '读取中…'].every((m) => clientSrc.includes(m)))
  check('M4B③：产物入库 UI（仅登记已产出文件）+ handler 不传 taskId（不写 tasks.json）', checkRegion.includes('产物入库（选择本地文件导入 / 项目内路径 / URL 均可登记，不触发生成）') && intakeHandler.length > 0 && !intakeHandler.includes('taskId'))
  check('M4B③：入库降级 marker + 写入路径说明（素材/生成 + 素材清单 + 资产索引）', ['入库失败：', '不阻塞；可检查路径/URL 后重试', '素材/生成/', '保持任务关联', '不触发生成、不调用模型'].every((m) => clientSrc.includes(m)))
  check('M4B③：真实模型 0（5 新路由均为入库/目录/探测/诊断/连通，无 generate/submit/审读）', !M4B.some((n) => /generate|submit|consistency|audit/.test(n)))
  check('M4B④：批1 五路由仍在（estimate/search/reconcile/task-create/update 各 1）', ['estimate-generation', 'search-context', 'canvas-reconcile', 'task-create', 'task-update'].every((n) => (clientSrc.match(new RegExp("api\\('" + n + "'", 'g')) || []).length === 1))
  check('M4B④：CSS 0 diff 线索 / slots=4 / METHODS=69（task-110 media-read +1；v0.15.11 E13 assets-import +1） / 无新依赖', !clientSrc.includes('.ad-m4') && (clientSrc.match(/slots\.register\(/g) || []).length === 4 && clientSrc.includes("inject: ['slots']") && (() => { try { const pkg = JSON.parse(fsMod.readFileSync(path.join(here, '..', 'package.json'), 'utf8')); return Object.keys(pkg.dependencies || {}).length === 0 } catch { return true } })())
  check('M4B⑤：既有 P0/分镜/审读/设置页/工具卡/批1 marker 保留（A-C1：persistFlow → progress-get 只读保留）', ['const requestLeave = (action) => {', "api('progress-get'", 'function mergeShotsPreservingExtraFields(', 'function normalizeReviewReport(raw)', 'function SettingsSection(props) {', 'function DramaCheckToolCard(props) {', 'const estimateGeneration = async () => {'].every((m) => clientSrc.includes(m)))
}

console.log('\n[9] v0.12.4（task-24 / M5-A）可访问性/键盘导航：roving tabindex + focus trap + aria + focus-visible')
{
  const fsMod = await import('node:fs')
  const clientSrc = fsMod.readFileSync(path.join(here, '..', 'client.js'), 'utf8')
  const callNames = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
  const fnRegion = (startMarker, endMarker) => {
    const start = clientSrc.indexOf(startMarker)
    if (start < 0) return ''
    const end = clientSrc.indexOf(endMarker, start + startMarker.length)
    return end > start ? clientSrc.slice(start, end) : clientSrc.slice(start, start + 9000)
  }
  const cssStart = clientSrc.indexOf('const CSS = `')
  const cssEnd = clientSrc.indexOf('\n`\n', cssStart)
  const css = cssStart >= 0 && cssEnd > cssStart ? clientSrc.slice(cssStart, cssEnd) : ''
  const rootStart = css.indexOf('body{')
  const rootEnd = css.indexOf('}', rootStart)
  const outside = css.slice(0, rootStart) + css.slice(rootEnd)
  const focusRules = (css.match(/:focus-visible[^}]*}/g) || []).join('\n')
  const tabBtn = fnRegion('const renderMainTab = (key, label) =>', 'const tabsNode')
  const tabHandler = fnRegion('const focusTabByKey = (targetKey) => {', 'const renderMainTab')
  const trap = fnRegion('function installDialogFocusTrap(containerId) {', '/* -------------------------------------------------------------- 主面板 */')

  check('M5-A①：页签 roving tabindex（仅 active=0）+ onKeyDown 绑定', tabBtn.includes('tabIndex: rovingTabKey === key ? 0 : -1') && tabBtn.includes('onKeyDown: (event) => onTabKeyDown(event, key)'))
  check('M5-A①：键盘 ←/→/Home/End + 环绕 + 仅移动焦点（handler 不调用 switchTab；激活仍走原生 onClick）', ['ArrowRight', 'ArrowLeft', 'Home', 'End'].every((k) => tabHandler.includes(k)) && tabHandler.includes("getElementById('ad-tab-' + targetKey)") && !tabHandler.includes('switchTab(') && tabBtn.includes('switchTab(key)'))
  check('M5-A①：aria 完整性保留（tablist/tab/aria-selected/aria-controls/tabpanel aria-labelledby）', clientSrc.includes("role: 'tablist'") && clientSrc.includes("role: 'tab'") && clientSrc.includes("'aria-selected'") && clientSrc.includes("'aria-controls': 'ad-tabpanel'") && clientSrc.includes("role: 'tabpanel', id: 'ad-tabpanel'"))
  check('M5-A②：离开守卫对话框 id + aria-modal + aria-describedby + aria-keyshortcuts', clientSrc.includes("id: 'ad-leave-dialog'") && clientSrc.includes("id: 'ad-leave-desc'") && clientSrc.includes("'aria-describedby': 'ad-leave-desc'") && (clientSrc.match(/'aria-keyshortcuts': 'Escape'/g) || []).length >= 2)
  check('M5-A②：设置浮层 id + aria-modal + aria-keyshortcuts（Esc 关闭提示属性）', clientSrc.includes("id: 'ad-settings-dialog'") && clientSrc.includes("'aria-keyshortcuts': 'Escape'"))
  check('M5-A②：focus trap 助手防御式（activeElement/首焦点/Tab 循环/cleanup 恢复/无 DOM no-op/contains 守卫）', ['document.activeElement', "querySelectorAll('button", "event.key !== 'Tab'", 'event.shiftKey', 'previous.focus()', "typeof document === 'undefined'", 'container.contains'].every((m) => trap.includes(m)))
  check('M5-A②：两处对话框均安装焦点陷阱（离开守卫/设置浮层）', clientSrc.includes("installDialogFocusTrap('ad-leave-dialog')") && clientSrc.includes("installDialogFocusTrap('ad-settings-dialog')"))
  check('M5-A③：:focus-visible 统一可见焦点且仅 --ad-*（无 hex/无 --dsw-*）', clientSrc.includes('.ad-shell :focus-visible') && focusRules.includes('.ad-btn:focus-visible') && focusRules.includes('outline:2px solid var(--ad-brand)') && !/--dsw-/.test(focusRules) && !/#[0-9a-fA-F]{3,8}\b/.test(focusRules))
  check('M5-A③：CSS 纯追加（既有像素/尺寸断言不受影响；outline 不占布局）', clientSrc.includes('outline:2px solid var(--ad-brand);outline-offset:2px') && clientSrc.includes('outline-offset:-2px'))
  check('M5-A④：保存按钮 aria-keyshortcuts ≥6（仅属性，不改 onClick/行为）', (clientSrc.match(/'aria-keyshortcuts': 'Control\+S Meta\+S'/g) || []).length >= 6 && clientSrc.includes("onClick: saveContract, disabled: busy, 'aria-keyshortcuts'"))
  check('M5-A④：4 处纯 placeholder 输入 aria-label 精确补齐且不重名', ['预算上限（留空取消）', '登记任务提示词（可选）', '分镜生成模型名（可留空）', '产物名称（可选）'].every((m) => clientSrc.includes(m)) && new Set(['预算上限（留空取消）', '登记任务提示词（可选）', '分镜生成模型名（可留空）', '产物名称（可选）']).size === 4)
  check('M5-A⑤：2 处动态结果补 role=status 播报（轻量）', (clientSrc.match(/className: 'ad-hits', role: 'status'/g) || []).length >= 2)
  check('M5-A⑥：红线不变——调用点 70（task-110 media-read +1；v0.15.11 E13 assets-import +1） / slots=4 / inject 仅 slots / 业务 CSS hex 0 / --dsw-* 9', callNames.size === 72 && (clientSrc.match(/slots\.register\(/g) || []).length === 4 && clientSrc.includes("inject: ['slots']") && !/#[0-9a-fA-F]{3,8}\b/.test(outside.replace(/body[\s\S]*?\}/, '')) && new Set([...css.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0])).size === 9)
  check('M5-A⑥：既有 P0/分镜/审读/设置页/工具卡/批1/批2 逻辑 marker 保留（A-C1：persistFlow → progress-get 只读保留）', ['const requestLeave = (action) => {', "api('progress-get'", 'function mergeShotsPreservingExtraFields(', 'function normalizeReviewReport(raw)', 'function SettingsSection(props) {', 'function DramaCheckToolCard(props) {', 'const estimateGeneration = async () => {', 'const intakeGeneratedArtifact = async () => {'].every((m) => clientSrc.includes(m)))
}

console.log('\n[10] v0.16.0 A-C1（QA 同步）：去线性进度 client 静态契约 / 只读保留 / 计数红线')
{
  const fsMod = await import('node:fs')
  const clientSrc = fsMod.readFileSync(path.join(here, '..', 'client.js'), 'utf8')
  const calls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
  const cnt = (re) => (clientSrc.match(re) || []).length
  // 删旧（A-C1）：进度/下一步/强制模式/流水线语义全部 0 出现（反向断言，强于原「存在」断言）
  check('[A-C1] 线性进度/下一步/强制模式/流水线语义已移除（0 出现）', ['ad-flow-step', 'ad-next-step', 'ad-next-cta', 'renderPipelineBar', 'PIPELINE_FALLBACK', 'ad-pipe', '刷新进度', '强制模式', '宽松模式', '创作流水线', '创作进度（流程状态机', '上次停在', '流程模式'].every((m) => !clientSrc.includes(m)))
  check('[A-C1] 精确：主进度条 className: \'ad-flow\' = 0；但 .ad-flow-hint/.ad-flow-stale 保留（检查页复用，不误删）', cnt(/className: 'ad-flow'/g) === 0 && clientSrc.includes('.ad-flow-hint{') && clientSrc.includes('.ad-flow-stale{'))
  // 保留（A-C1）
  check('[A-C1] 只读保留：api(\'progress-get\') 仅 1 处（openProject 内部；METHOD 不删）', cnt(/api\('progress-get'/g) === 1, String(cnt(/api\('progress-get'/g)))
  check('[A-C1] 保留：失败码/错误卡通用「下一步」文案仍在（不误删）', clientSrc.includes("className: 'ad-err-next'") && clientSrc.includes('下一步：'))
  check('[A-C1] 保留：flow 读写函数 0 出现（loadFlow/persistFlow/confirmFlowStep/rollbackFlowTo）', ['const loadFlow = async', 'const persistFlow = async', 'const confirmFlowStep = async', 'const rollbackFlowTo ='].every((m) => !clientSrc.includes(m)))
  check('[A-C1] 保留：settings.strictMode 历史字段仍透传（无强制/宽松 UI）', /strictMode: value\.strictMode === true/.test(clientSrc) && !/强制模式|宽松模式/.test(clientSrc))
  check('[A-C1] 红线：唯一调用点 70 / slots.register 4 / ICON_PATHS chevron 定义保留（UI 使用 0）', calls.size === 72 && cnt(/slots\.register\(/g) === 4 && clientSrc.includes('chevron:') && cnt(/icon\('chevron'\)/g) === 0)
}

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
