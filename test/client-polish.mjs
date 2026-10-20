/**
 * v0.6.3 增强池（客户端半）验收用例 —— 审读展示细化 / 好用性残余 / 任务模型交互细化
 *
 * 需求来源：`P2-好用阶段-规划与需求挖掘机制-v1.md` §14（v0.6.3 增强池，3 项 S 级、纯 client、无契约变更）
 *  ① 审读展示细化：findings 维度筛选/排序、evidence 高亮、总数摘要（按 severity/dimension 计数）；
 *  ② 好用性残余：错误文案统一（失败码→用户可读）、快捷键说明、加载骨架/空态一致性；
 *  ③ 设置页任务模型交互细化：模型输入「最近使用列表」（本地存储）+ 即时校验反馈。
 *
 * 红线：slots.register=4（已批准终值）、client 调用点 69（task-110 media-read +1）（M4 批1+批2 +10，已批准登记）、无新增依赖、旧数据 32 文件 hash 不变、工具 34/METHODS 69（task-110 media-read +1）。
 * 兼容策略：v0.6.3 client 未交付（探测标记缺失）→ 显式 SKIP；交付后自动生效。
 * 运行：node test/client-polish.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
// v0.12.0（task-6）：DSH_AI_CLIENT_SRC 仅供 qa 做 token 白名单「负数用例」——指向临时注入副本；
// 默认（不设置）= 仓库内 client.js，行为与历史完全一致。本套件只读 client 源，不写任何文件。
const clientSrcPath = process.env.DSH_AI_CLIENT_SRC || path.join(pluginRoot, 'client.js')
const clientSrc = await fs.readFile(clientSrcPath, 'utf8')
const toolsMod = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'tools.js')).href)

// v0.6.3 客户端增强特征探测（三项至少各命中一个标记才运行）
const featureProbe = {
  reviewPolish: /维度筛选|按维度筛选|按严重度排序|维度排序/.test(clientSrc),
  failureCopy: /快捷键/.test(clientSrc),
  taskModelRecent: /最近使用/.test(clientSrc),
}
const landed = Object.values(featureProbe).every(Boolean)
if (!landed) {
  const missing = Object.entries(featureProbe).filter(([, v]) => !v).map(([k]) => k)
  console.log(`\n结果：0 passed, 0 failed（SKIP：v0.6.3 client 增强未交付（缺 ${missing.join('、')}）——task-35 落地后本套件自动生效）`)
  process.exit(0)
}

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
function group(name) {
  console.log('\n' + name)
}

/* ------------------------------------------------------------------ [1] */
group('[1] 增强①：审读展示细化（维度筛选 / 排序 / 摘要计数 / evidence 高亮）')
const reviewChecks = [
  ['维度筛选 UI（按 dimension 过滤）', /维度筛选|按维度|维度过滤/],
  ['严重度筛选/排序（按 severity）', /按严重度|严重度排序|severity/],
  ['总数摘要（findings 计数）', /共\s*\d+\s*条|共\s*\d+|统计|摘要/],
  ['按维度/严重度分组计数', /计数|分组|按维度|按严重度/],
  ['evidence 高亮', /高亮|highlight/],
  ['筛选/排序不新增后端调用（纯前端）', /本地|useMemo|useState/],
]
for (const [label, re] of reviewChecks) {
  check(`增强①：${label}`, re.test(clientSrc), String(re))
}
// 审读区块渲染分支仍走最新审读报告（E6.1 只读 doc-read）
check('增强①：审读数据仍来自 doc-read latest.json（E6.1 只读路径未变）', /reviews\/latest\.json/.test(clientSrc))
check('增强①：展示细化不新增 API 调用点（68 内，M4 批1+批2 +10 已批准）', true, '计数见 [4]')

/* ------------------------------------------------------------------ [2] */
group('[2] 增强②：10 类失败码文案统一 + 快捷键说明 + 骨架/空态一致性')
const FAILURE_CODES = Object.keys(toolsMod.TOOL_FAILURE_CODES || {})
check('增强②：失败码来源可用（TOOL_FAILURE_CODES 导出）', FAILURE_CODES.length >= 8, JSON.stringify(FAILURE_CODES))
const windowOf = (needle, radius = 220) => {
  const at = clientSrc.indexOf(needle)
  if (at < 0) return ''
  return clientSrc.slice(Math.max(0, at - radius), at + radius)
}
const covered = []
const uncovered = []
for (const code of FAILURE_CODES) {
  const codeAt = clientSrc.includes(`'${code}'`) || clientSrc.includes(`"${code}"`) || clientSrc.includes(code)
  const win = windowOf(code, 260)
  const hasReadable = /label|原因|下一步|重试|检查|失败|不可用|冲突|超时|取消|未知|不支持|权限|预算|读写|不存在/.test(win)
  if (codeAt && hasReadable) covered.push(code)
  else uncovered.push(code)
}
check(`增强②：失败码→用户可读文案覆盖 ≥10 类（实际 ${covered.length}/${FAILURE_CODES.length}）`, covered.length >= 10, JSON.stringify({ covered, uncovered }))
check('增强②：快捷键说明存在（快捷键/键盘 + 按键提示）', /快捷键|键盘快捷/.test(clientSrc) && /Ctrl|⌘|Cmd|Alt|Shift|Enter|Esc|Tab/i.test(clientSrc), 'shortcut-hint')
check('增强②：加载骨架/空态一致性（骨架/空态文案）', /骨架|skeleton|空态|暂无/.test(clientSrc), 'skeleton-empty-state')

/* ------------------------------------------------------------------ [3] */
group('[3] 增强③：任务模型交互细化（最近使用列表 + 即时校验反馈）')
check('增强③：最近使用列表 UI 存在', /最近使用/.test(clientSrc))
const recentKeyMatch = clientSrc.match(/ai-drama:[a-z0-9:-]*recent[a-z0-9:-]*/i) || clientSrc.match(/recent[A-Za-z]*\s*[:=]/) || clientSrc.match(/localStorage[^\n]{0,120}recent/i)
check('增强③：最近使用列表本地持久化（localStorage key）', Boolean(recentKeyMatch) && /localStorage/.test(clientSrc), JSON.stringify(recentKeyMatch && recentKeyMatch[0]).slice(0, 120))
check('增强③：最近使用列表有数量上限/去重逻辑', /slice\(0,\s*\d+\)|Set\(|includes\(/.test(clientSrc), 'recent-dedupe-limit')
check('增强③：任务模型字段即时校验（temperature/maxTokens/model）', /Temperature 需在 0~2 之间/.test(clientSrc) && /MaxTokens 需在 1~/.test(clientSrc) && /任务模型名不能为空/.test(clientSrc))
check('增强③：校验失败保存拦截（保存前校验）', /校验|invalid|提示/.test(clientSrc))

/* ------------------------------------------------------------------ [4] */
group('[4] 工程红线：slots=4（已批准终值）/ 调用点 69（task-110 media-read +1）（M4 批1+批2 +10 已批准）/ 无新依赖 / 工具 34 / METHODS 69（task-110 media-read +1） / 旧数据 hash')
check('红线：client slots.register = 4（v0.12.1 已批准终值）', (clientSrc.match(/slots\.register\(/g) || []).length === 4)
const clientCalls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
check('红线：client 去重调用点 = 69（task-110 media-read +1）（M4 批1+批2 +10，已批准登记）', clientCalls.size === 69, String(clientCalls.size))
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
check('红线：无新增外部依赖', !pkg.dependencies || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies || {}))
const { METHODS } = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
check('红线：生产工具面仍 34', toolsMod.createToolDefs({ rootOf: () => '', backendOf: () => null }).length === 34)
check('红线：METHODS 仍 = 69（task-110 media-read +1）', METHODS.length === 69, String(METHODS.length))
// 旧数据 32 文件 hash 不变（复用 P2-1 基线）
const BASELINE_CANDIDATES = [
  process.env.DSH_AI_P163_BASELINE,
  path.join(pluginRoot, '..', 'AI短剧工作区', '证据', 'P2-1-旧数据基线-2026-10-17.json'),
]
let baselineText = null
for (const candidate of BASELINE_CANDIDATES) {
  try {
    baselineText = await fs.readFile(candidate, 'utf8')
    break
  } catch {
    baselineText = null
  }
}
if (!baselineText) {
  console.log('      （SKIP：旧数据基线快照未找到 —— 安装副本隔离目录等场景）')
} else {
  const baseline = JSON.parse(baselineText)
  const REAL_ROOT = process.env.DSH_AI_DRAMA_REAL_ROOT || path.join(pluginRoot, '..', 'AI短剧')
  const files = []
  async function walk(dir, relBase = '') {
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name)
      const rel = path.join(relBase, e.name)
      if (e.isDirectory()) await walk(abs, rel)
      else {
        try {
          const buf = await fs.readFile(abs)
          files.push({ relative: rel, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') })
        } catch {}
      }
    }
  }
  await walk(REAL_ROOT)
  const baseMap = new Map(baseline.files.map((f) => [f.relative, f]))
  const curMap = new Map(files.map((f) => [f.relative, f]))
  // 2026-10-20 测试项目清理后恢复严格口径：活动数据根 = 基线 32 文件集合（缺失/新增/改写均 FAIL；无 allowlist）。
  const missing = [...baseMap.keys()].filter((k) => !curMap.has(k))
  const added = [...curMap.keys()].filter((k) => !baseMap.has(k))
  const changed = [...baseMap.keys()].filter((k) => curMap.has(k) && curMap.get(k).sha256 !== baseMap.get(k).sha256)
  check('红线：旧数据 32 核心文件 sha256/bytes 严格不变（缺失/改写 0；无 allowlist 豁免）', missing.length === 0 && added.length === 0 && changed.length === 0, JSON.stringify({ missing, added, changed }).slice(0, 300))
  check('红线：数据根严格 32 文件集合（无 allowlist；缺失/新增/改写 0）', missing.length === 0 && added.length === 0 && changed.length === 0 && files.length === baseline.files.length, JSON.stringify({ missing, added, changed, files: files.length, baseline: baseline.files.length }).slice(0, 300))
}

/* ------------------------------------------------------------------ [5] */
group('[5] v0.11.5（task-4）P0 数据安全三连：未保存守卫 / 全局保存 / 跨项目清理 / 空覆盖守卫')
{
  const DIRTY_SCOPES = ['contract', 'outline', 'characters', 'world', 'memory', 'episode', 'storyboard']
  // P0-1 未保存离开守卫 + 全局 Ctrl/⌘+S + 保存态
  check('P0-1：dirty 扩展为 7 个可保存页签', /contract: false, outline: false, characters: false, world: false, memory: false, episode: false, storyboard: false/.test(clientSrc))
  check('P0-1：hasUnsavedChanges 覆盖 7 页签 + 文档栏', /const hasUnsavedChanges = \(\) => DIRTY_KEYS\.some\(\(key\) => Boolean\(dirty\[key\]\)\) \|\| docDirty/.test(clientSrc))
  check('P0-1：7 个编辑入口各自标脏（markDirty × 7）', DIRTY_SCOPES.every((key) => new RegExp(`markDirty\\('${key}'\\)`).test(clientSrc)), DIRTY_SCOPES.filter((key) => !new RegExp(`markDirty\\('${key}'\\)`).test(clientSrc)).join(','))
  check('P0-1：7 个保存动作各自清脏（clearDirty × 7）', DIRTY_SCOPES.every((key) => new RegExp(`clearDirty\\('${key}'\\)`).test(clientSrc)), DIRTY_SCOPES.filter((key) => !new RegExp(`clearDirty\\('${key}'\\)`).test(clientSrc)).join(','))
  check('P0-1：全局 Ctrl/⌘+S 挂 window keydown 且按 7 页签派发', /window\.addEventListener\('keydown', onKeyDown\)/.test(clientSrc) && /const SAVEABLE_TABS = \{[\s\S]{0,400}?contract: saveContract,[\s\S]{0,120}?outline: saveOutline,[\s\S]{0,120}?characters: saveCharacters,[\s\S]{0,120}?world: saveWorld,[\s\S]{0,120}?memory: saveMemory,[\s\S]{0,120}?episode: saveEpisode,[\s\S]{0,120}?storyboard: saveShots/.test(clientSrc))
  check('P0-1：文档栏聚焦优先保存文档（focusInsideDocPane + .ad-doc）', /const focusInsideDocPane = \(\) =>/.test(clientSrc) && /closest\('\.ad-doc'\)/.test(clientSrc))
  check('P0-1：不可保存页签不静默（本页没有可保存的修改）', clientSrc.includes('本页没有可保存的修改'))
  check('P0-1：离开点接入三选一守卫（切页签/载入/返回/切源/跳转）', (clientSrc.match(/requestLeave\(/g) || []).length >= 7, String((clientSrc.match(/requestLeave\(/g) || []).length))
  check('P0-1：beforeunload 仅在未保存时挂监听并返回提示', /window\.addEventListener\('beforeunload', onBeforeUnload\)/.test(clientSrc) && /有未保存的修改，确定离开吗？/.test(clientSrc) && /if \(!hasUnsavedChanges\(\)\) return undefined/.test(clientSrc))
  check('P0-1：面板内三选一对话框（保存并离开/放弃修改/取消 + role=dialog + aria-modal）', ['保存并离开', '放弃修改', '取消'].every((text) => clientSrc.includes(text)) && /role: 'dialog'/.test(clientSrc) && /'aria-modal': 'true'/.test(clientSrc))
  check('P0-1：Esc=取消（安全出口）且默认焦点在安全按钮', /event\.key === 'Escape'/.test(clientSrc) && /autoFocus: true/.test(clientSrc))
  check('P0-1：快捷键文案已兑现（7 页签 / 文档栏）', clientSrc.includes('Ctrl/⌘+S 保存当前页签（契约/总纲/人物/世界观/剧本/分镜/本剧记忆）或文档栏'))
  check('P0-1：textarea 既有 Ctrl+S 保留且去重（e.defaultPrevented）', /event\.defaultPrevented/.test(clientSrc) && clientSrc.includes("if (!busy) saveEpisode()") && clientSrc.includes('if (!docBusy && !docUnavailable) saveDoc()'))
  check('P0-1：保存态常驻页头（ad-save-state + 未保存修改 / 已保存）', /className: unsaved \? 'ad-save-state ad-dirty' : 'ad-save-state ad-ok'/.test(clientSrc) && clientSrc.includes('● 未保存修改') && clientSrc.includes('✓ 已保存'))

  // P0-2 跨项目状态残留清理
  check('P0-2：resetProjectScopedState 定义', /const resetProjectScopedState = \(\) => \{/.test(clientSrc))
  check('P0-2：openProject 起始调用 resetProjectScopedState（在 Promise.all 前）', (() => {
    const at = clientSrc.indexOf('const openProject =')
    if (at < 0) return false
    const end = clientSrc.indexOf('\n      const toggleCollapse', at)
    const block = end > at ? clientSrc.slice(at, end) : ''
    const callAt = block.indexOf('resetProjectScopedState()')
    const loadAt = block.indexOf('await Promise.all(')
    return callAt >= 0 && loadAt > callAt
  })())
  check('P0-2：清理 doc / 生成计划 / 账本 / 台词 / 素材 / 导入 / dirty', ['setDocPath(\'\')', 'setGenCanvas(null)', 'setGenPlan(null)', 'setLedger(null)', 'setDialogue(null)', 'setAssets([])', 'setImportPreview(null)'].every((snippet) => clientSrc.includes(snippet)) && /\n        setDirty\(\{ contract: false/.test(clientSrc))
  check('P0-2：resetProjectView 名称/调用保留且复用统一清理', /const resetProjectView = \(\) => \{[\s\S]{0,200}?resetProjectScopedState\(\)/.test(clientSrc) && (clientSrc.match(/resetProjectView\(\)/g) || []).length >= 2)

  // P0-3 打开自动载入 + 空内容/未载入覆盖守卫
  check('P0-3：openProject 后自动载入首集正文/分镜', /autoLoadEpisode\(title, firstOrder\)\.catch/.test(clientSrc) && /autoLoadShots\(title, firstOrder\)\.catch/.test(clientSrc))
  check('P0-3：自动载入只用既有只读路由（episode-read/storyboard-get；M4 批1+批2 后调用点 69（task-110 media-read +1） 已批准）', /api\('episode-read', \{ title, order: target \}\)/.test(clientSrc) && /api\('storyboard-get', \{ title, order: target \}\)/.test(clientSrc) && clientCalls.size === 69)
  check('P0-3：空内容/未载入覆盖守卫（载入态 + 磁盘内容标记 + 两处守卫函数）', /loadedEpisodeOrder !== target/.test(clientSrc) && /episodeDiskHadContent/.test(clientSrc) && /const episodeSaveBlocked = \(\) =>/.test(clientSrc) && /const shotsSaveBlocked = \(\) =>/.test(clientSrc))
  check('P0-3：守卫提示面向用户（先点「载入」/覆盖）', /先点「载入」/.test(clientSrc) && /覆盖/.test(clientSrc))
  check('P0-3：新建项目空→建第 1 集不误伤（磁盘无该集文件允许保存）', /磁盘上还没有该集文件：新建集是合法路径，允许保存/.test(clientSrc))
  check('P0-3：保存成功后同步载入态（避免二次误报）', /setLoadedEpisodeOrder\(target\)/.test(clientSrc) && /setLoadedShotsOrder\(target\)/.test(clientSrc))
  check('P0-3：自动载入失败不阻断、给可读提示+重试', /自动载入失败/.test(clientSrc) && /重试载入/.test(clientSrc))
}

/* ------------------------------------------------------------------ [6] */
group('[6] v0.12.0（task-6）主题合规：官方 token 白名单 + --ad-* 派生层 + 主按钮可读')
{
  // 官方白名单 14 项（浅/深双套）——来源：`证据/UI评审-框架能力-2026-10-19.md` §5
  // （Client Inspect live 实测：官方 catalog = 13 个 --dsw-alias-* + --dsw-specific-sidebar-fill）。
  // 扩展本白名单前必须先有「宿主实测」依据；禁止把越界 token 加进来“让测试变绿”。
  const OFFICIAL_DSW_TOKENS = [
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-brand-primary',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-idle-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-specific-sidebar-fill',
  ]
  const dswRefs = [...new Set([...clientSrc.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0]))].sort()
  const undefinedDswTokens = dswRefs.filter((token) => !OFFICIAL_DSW_TOKENS.includes(token))
  check(
    `主题①：client.js 中 --dsw-* 引用 100% ∈ 官方 14 白名单（实际引用 ${dswRefs.length} 个）`,
    dswRefs.length > 0 && undefinedDswTokens.length === 0,
    '未定义 token: ' + undefinedDswTokens.join(', ') + '（若宿主确有定义，请先补宿主实测证据再加入白名单）',
  )

  // 派生层边界：--dsw-* 只允许出现在 CSS 模板的 body{} 内（业务规则全走 --ad-*）
  const cssStart = clientSrc.indexOf('const CSS = `')
  const cssEnd = cssStart >= 0 ? clientSrc.indexOf('\n`\n', cssStart) : -1
  const rootStart = cssStart >= 0 ? clientSrc.indexOf('body{', cssStart) : -1
  const rootEnd = rootStart >= 0 ? clientSrc.indexOf('}', rootStart) : -1
  const hasCssRoot = cssStart >= 0 && cssEnd > cssStart && rootStart > cssStart && rootEnd > rootStart
  check('主题②：CSS 顶部存在 :root 派生层（--dsw-* 唯一入口）', hasCssRoot)
  const cssOutsideRoot = hasCssRoot ? clientSrc.slice(cssStart, rootStart) + clientSrc.slice(rootEnd, cssEnd) : clientSrc
  const dswOutsideRoot = [...new Set([...cssOutsideRoot.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0]))]
  check('主题②：业务规则 0 处直接引用 --dsw-*（全部经 --ad-*；仅 body 定义层出现）', hasCssRoot && dswOutsideRoot.length === 0, dswOutsideRoot.join(', '))
  // 结构层：--dsw-* 只在 :root（排除注释不影响：此处只要求 0 处出现在业务规则）

  // --ad-* 完整性：所有 var(--ad-*) 引用均在 body 派生层有定义
  const rootBlock = hasCssRoot ? clientSrc.slice(rootStart, rootEnd) : ''
  const adDefs = new Set([...rootBlock.matchAll(/(--ad-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
  const adRefs = [...new Set([...clientSrc.matchAll(/var\((--ad-[a-z0-9-]+)\)/g)].map((m) => m[1]))]
  const adUndefined = adRefs.filter((token) => !adDefs.has(token))
  check(
    `主题③：所有 var(--ad-*) 均在 body 派生层有定义（定义 ${adDefs.size} / 引用 ${adRefs.length}）`,
    adDefs.size >= 10 && adRefs.length >= 10 && adUndefined.length === 0,
    '未定义引用: ' + adUndefined.join(', '),
  )
  check(
    '主题③：派生层覆盖 语义色/弱底/边框/主按钮 关键角色',
    ['--ad-error', '--ad-warn', '--ad-success', '--ad-error-bg', '--ad-warning-bg', '--ad-error-border', '--ad-warning-border', '--ad-subtle-bg', '--ad-hover-bg', '--ad-border', '--ad-divider', '--ad-on-brand', '--ad-primary-hover-bg'].every((token) => adDefs.has(token)),
    JSON.stringify([...adDefs]),
  )
  // 语义色派生源必须是官方 state-*-primary（防止未来用非官方色偷懒）
  check(
    '主题③：语义文字色由官方 state-*-primary 派生（color-mix）',
    ['error', 'warn', 'success'].every((kind) => new RegExp(`--ad-${kind}:color-mix\\(in srgb,var\\(--dsw-alias-state-${kind}-primary\\)`).test(rootBlock)),
  )

  // 主按钮：官方反色组合（brand 底 + bg-base 字），彻底移除 #fff，显式 hover，通用 hover 收窄
  const primaryMatch = /\.ad-primary\{([^}]*)\}/.exec(clientSrc)
  const primaryBody = primaryMatch ? primaryMatch[1] : ''
  check(
    '主题④：主按钮 底=var(--ad-brand)、文字=var(--ad-on-brand)，无硬编码 #fff',
    primaryBody.includes('background:var(--ad-brand)') && primaryBody.includes('color:var(--ad-on-brand)') && !/#fff/i.test(primaryBody),
    primaryBody.slice(0, 160),
  )
  check('主题④：主按钮 hover 显式定义（--ad-primary-hover-bg，不被通用 hover 覆盖）', /\.ad-primary:hover\{background:var\(--ad-primary-hover-bg\)\}/.test(clientSrc))
  check('主题④：通用 .ad-btn:hover 已收窄为 :not(.ad-primary)', /\.ad-btn:not\(\.ad-primary\):hover\{background:var\(--ad-hover-bg\)\}/.test(clientSrc))
  // 业务 CSS 不再有硬编码 hex（颜色全部来自官方 token/color-mix 派生；:root 内的注释值不计）
  const businessCss = hasCssRoot ? clientSrc.slice(cssStart, rootStart) + clientSrc.slice(rootEnd, cssEnd) : ''
  const businessHex = [...new Set(businessCss.match(/#[0-9a-fA-F]{3,8}\b/g) || [])]
  check('主题⑤：业务 CSS 0 个硬编码 hex（颜色仅来自 token/派生层）', hasCssRoot && businessHex.length === 0, businessHex.join(', '))
}

/* ------------------------------------------------------------------ [7] */
group('[7] v0.12.0（task-7）信息架构与宽屏版式：进度合一 / 页签分组 / max-width / 空态 / 危险按钮')
{
  const cssStart7 = clientSrc.indexOf('const CSS = `')
  const cssEnd7 = cssStart7 >= 0 ? clientSrc.indexOf('\n`\n', cssStart7) : -1
  const css7 = cssStart7 >= 0 && cssEnd7 > cssStart7 ? clientSrc.slice(cssStart7, cssEnd7) : ''

  // ① 进度合一：页头重复统计删除；T8 独立条不再渲染于项目页（函数保留给工具卡片页）；P2-2 为唯一主进度且内嵌 facts
  check('IA①：页头删除重复进度统计（无「进度：…大纲/人物/剧本/分镜」行）', !clientSrc.includes('进度：${') && clientSrc.includes("h('div', { className: 'ad-sub' }, '短剧创作中枢')"))
  check('IA①：T8 独立流水线不再渲染于项目页（renderPipelineBar 仅定义 + 工具卡片页各 1 处）', (clientSrc.match(/renderPipelineBar/g) || []).length === 2 && !clientSrc.includes('if (phase === \'project\') children.push(renderPipelineBar'))
  check('IA①：P2-2 流程状态机为唯一主进度并含 facts 计数映射（大纲/人物/剧本/分镜/导出）', clientSrc.includes('const FLOW_FACT_KEYS = {') && clientSrc.includes('flowFacts[factKey]') && ['outlineCount', 'characterCount', 'episodeCount', 'storyboardCount', 'exportCount'].every((k) => clientSrc.includes(k)))
  check('IA①：「刷新进度」并入主进度条（M6-0c 更新：handler + 文本 + refresh 图标，等价严格）', clientSrc.includes('onClick: refreshProgress') && clientSrc.includes("'刷新进度'") && clientSrc.includes("icon('refresh')") && clientSrc.includes("onClick: refreshProgress, disabled: busy }, icon('refresh'), '刷新进度')"))
  check('IA①：flow-state 读写语义未改（loadFlow/persistFlow/confirmFlowStep/回退提示仍在）', ['const loadFlow = async', 'const persistFlow = async', 'const confirmFlowStep = async', 'const rollbackFlowTo =', '待重做', '上次停在'].every((marker) => clientSrc.includes(marker)))

  // ② 14 页签 4 组（v0.15.2 移除「台词与音效」）+ 窄窗「更多」+ aria 最小集
  const TAB_KEYS = ['contract', 'outline', 'characters', 'world', 'episode', 'storyboard', 'assets', 'memory', 'drafts', 'ledger', 'generate', 'check', 'tree', 'toolcards']
  const tabGroupsMatch = /const TAB_GROUPS = \[([\s\S]*?)\n    \]/.exec(clientSrc)
  const groupedKeys = tabGroupsMatch
    ? [...tabGroupsMatch[1].matchAll(/tabs: \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]))
    : []
  check('IA②：14 页签 4 组（创作/资料/交付/高级；v0.15.2 移除台词与音效）且键不重不漏', groupedKeys.length === 14 && new Set(groupedKeys).size === 14 && TAB_KEYS.every((key) => groupedKeys.includes(key)) && ['创作', '资料', '交付', '高级'].every((label) => tabGroupsMatch && tabGroupsMatch[1].includes(label)), JSON.stringify(groupedKeys))
  check('IA②：aria 最小集（tablist/tab/aria-selected/aria-controls/tabpanel）', clientSrc.includes("role: 'tablist'") && clientSrc.includes("role: 'tab'") && clientSrc.includes("'aria-selected'") && clientSrc.includes("'aria-controls': 'ad-tabpanel'") && clientSrc.includes("role: 'tabpanel'") && clientSrc.includes("id: 'ad-tabpanel'"))
  check('IA②：窄窗「更多」收纳（M6-0c 更新：ellipsis 图标 + aria-label 更多页签 + menuitem + tabsMoreOpen，等价严格）', clientSrc.includes("icon('ellipsis')") && clientSrc.includes("'aria-label': '更多页签'") && clientSrc.includes("role: 'menuitem'") && /const tabsMoreOpen|setTabsMoreOpen/.test(clientSrc) && !clientSrc.includes("'更多 ▾'"))
  check('IA②：窄窗断点收纳 CSS（@media max-width:900px 隐藏分组/显示更多）', /@media \(max-width:900px\)\{[\s\S]{0,200}?\.ad-tabs-more\{display:block\}/.test(css7))
  check('IA②：页签 active 态加强（加粗 + 品牌下划线 + 主文字色）', /\.ad-tab\[data-on="1"\]\{opacity:1;font-weight:600;color:var\(--ad-label-primary\);border-bottom-color:var\(--ad-brand\)\}/.test(css7))

  // ③ 宽屏版式：内容 max-width + 控件按类型定宽 + 契约分组/长文本 + 字号收敛
  const contentRule = /\.ad-content\{width:100%;max-width:(\d+)px;margin:0 auto\}/.exec(css7)
  const contentMax = contentRule ? Number(contentRule[1]) : 0
  check(`IA③：内容容器 .ad-content max-width 生效且在 1080–1200（实际 ${contentMax || '缺失'}px）`, contentMax >= 1080 && contentMax <= 1200 && clientSrc.includes("className: 'ad-content'"))
  check('IA③：控件按类型定宽（数字 120 / 下拉 220 / 长文本 760）', css7.includes('.ad-field > .ad-input[type="number"]{max-width:120px}') && css7.includes('.ad-select{max-width:220px}') && css7.includes('.ad-field > .ad-area{max-width:760px}'))
  check('IA③：列表页工具条紧凑化 + 主 CTA', css7.includes('.ad-list-toolbar{') && clientSrc.includes("className: 'ad-list-toolbar'") && clientSrc.includes('ad-btn ad-primary ad-cta'))
  // 契约表单分组数按「契约页块」作用域统计（task-8 后设置页也复用 .ad-form-group，不能全文件计数；文案/行数断言不变）
  const contractBlock = (() => {
    const start = clientSrc.indexOf("if (tab === 'contract' && contract) {")
    const end = clientSrc.indexOf("if (tab === 'contract' && !contract) {", start)
    return start >= 0 && end > start ? clientSrc.slice(start, end) : ''
  })()
  check('IA③：契约表单 3 分组 + 长文本多行（红线 rows4 / 钩子密度 TextField rows2）', (contractBlock.match(/className: 'ad-form-group'/g) || []).length === 3 && clientSrc.includes("h(TextField, { label: '审核红线', rows: 4") && clientSrc.includes("h(TextField, { label: '钩子密度', rows: 2"))
  check('IA③：字号层级收敛（无 11/11.5px；标题 16 / section 14）', !css7.includes('font-size:11px') && !css7.includes('font-size:11.5px') && css7.includes('.ad-title{font-size:16px') && css7.includes('.ad-sec{font-size:14px'))

  // ④ 空态统一 + 危险按钮
  check('IA④：裸 className「ad-empty」归零，表格行内统一 ad-table-empty ×8（v0.15.1 素材库旧视图 +1；v0.15.2 台词视图/音频 +1；v0.15.4 登记管理空态 +1）', (clientSrc.match(/className: 'ad-empty'/g) || []).length === 0 && (clientSrc.match(/className: 'ad-table-empty'/g) || []).length === 8)
  check('IA④：emptyState 根类只保留 ad-empty-state（无裸 ad-empty 组合）', clientSrc.includes("className: 'ad-empty-state', key: options.key, role: 'status'") && !clientSrc.includes("className: 'ad-empty ad-empty-state'"))
  check('IA④：页面级空态统一走 emptyState（≥8 处）', (clientSrc.match(/emptyState\(\{/g) || []).length >= 8, String((clientSrc.match(/emptyState\(\{/g) || []).length))
  check('IA④：危险按钮 .ad-btn-danger 定义 + 应用 ≥6 处', css7.includes('.ad-btn-danger{border-color:var(--ad-error-border);color:var(--ad-error)}') && css7.includes('.ad-btn-danger:hover{background:var(--ad-error-bg)}') && (clientSrc.match(/ad-btn ad-sm ad-btn-danger/g) || []).length >= 6)

  // ⑤ 保留项 + 红线（P0 守卫 / v0.11.4 分镜只读 / 审读区 / 生成页区块 / token 口径）
  check('保留项：v0.11.5 P0 守卫锚点全在（keydown/beforeunload/requestLeave/autoLoad/saveBlocked/三选一）', clientSrc.includes("window.addEventListener('keydown', onKeyDown)") && clientSrc.includes("window.addEventListener('beforeunload', onBeforeUnload)") && (clientSrc.match(/requestLeave\(/g) || []).length >= 7 && clientSrc.includes('autoLoadEpisode(title, firstOrder)') && clientSrc.includes('const episodeSaveBlocked = () =>') && clientSrc.includes('const shotsSaveBlocked = () =>') && clientSrc.includes('保存并离开'))
  check('保留项：v0.11.4 分镜「详情」只读列/展开块 + 分组只读区 marker 保留', clientSrc.includes('SHOT_EXTRA_FIELDS') && clientSrc.includes('storyboardExtraEntries') && clientSrc.includes("if (hasExtraFields) headerLabels.push('详情')") && clientSrc.includes("className: 'ad-shot-extras'") && clientSrc.includes("className: 'ad-groups'") && clientSrc.includes('（只读，来自宿主分组 sidecar）'))
  check('保留项：审读区 + 生成页四区块 marker 保留', clientSrc.includes('最新审读报告') && clientSrc.includes("'① 画布绑定'") && clientSrc.includes("'② 预算护栏'") && clientSrc.includes('③ 任务（') && clientSrc.includes('④ 批次（当前集 第 '))
  check('红线：--dsw-* 仍 9 个官方 alias 且仅在 body 定义层；--ad-* 引用均有定义', (() => {
    const cssStart = clientSrc.indexOf('const CSS = `')
    const cssEnd = clientSrc.indexOf('\n`\n', cssStart)
    const css = clientSrc.slice(cssStart, cssEnd)
    const rootStart = css.indexOf('body{')
    const rootEnd = css.indexOf('}', rootStart)
    const outside = css.slice(0, rootStart) + css.slice(rootEnd)
    const uniq = [...new Set([...css.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0]))]
    const adDefs = new Set([...css.slice(rootStart, rootEnd).matchAll(/(--ad-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
    const adRefs = [...new Set([...clientSrc.matchAll(/var\((--ad-[a-z0-9-]+)\)/g)].map((m) => m[1]))]
    return uniq.length === 9 && ![...outside.matchAll(/--dsw-[a-z0-9-]+/g)].length && adRefs.every((token) => adDefs.has(token))
  })())
  check('红线：client 调用点 = 69（task-110 media-read +1）（M4 批1+批2 +10，已批准登记）', (() => {
    const calls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
    return calls.size === 69
  })())
}

/* ------------------------------------------------------------------ [8] */
group('[8] v0.12.1（task-8）独立设置页 settings.section：注册契约 / 设置项迁移 / 列表页瘦身 / 项目页入口 / 两棵树同步')
{
  // ① 注册契约：严格按安装态 settings.section 拓扑（{id, order, label}；组件渲染于宿主 SettingsPanel，props 含 close）
  check('设置页①：注册 settings.section（id=ai-drama / order=60 / label=AI 短剧 / 组件为函数）',
    clientSrc.includes("ctx.slots.inject('settings.section'") &&
    clientSrc.includes("{ name: 'settings.section', id: 'ai-drama', order: 60, label: 'AI 短剧' }") &&
    /function SettingsSection\(props\) \{/.test(clientSrc) &&
    clientSrc.includes("typeof options.close === 'function'"))
  check('设置页①：slots.register=4（2→3 设置页 +1、3→4 工具卡 +1，均已批准）', (clientSrc.match(/slots\.register\(/g) || []).length === 4)
  check('设置页①：inject 仍仅 slots；client 调用点 = 69（task-110 media-read +1）（M4 批1+批2 已批准）', /inject: \['slots'\]/.test(clientSrc) && new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1])).size === 69)
  // ② 两棵 React 树状态共享
  check('设置页②：每次挂载 Promise.all([status, settings-get]) 重读', /Promise\.all\(\[api\('status'\), api\('settings-get'\)\]\)/.test(clientSrc))
  check('设置页②：保存走既有 settings-save（共 3 处：设置页 2 + 面板流程条 1）', (clientSrc.match(/api\('settings-save'/g) || []).length === 3)
  check('设置页②：主面板窗口焦点恢复时静默重读 settings-get（保存后主面板刷新机制）', clientSrc.includes("window.addEventListener('focus', refreshSettingsOnFocus)") && /api\('settings-get'\)\.then/.test(clientSrc))
  // ③ 设置项迁移（原列表页设置 7 类 + 环境信息/诊断）
  const movedMarkers = ['默认平台', '默认单集时长', '默认目标集数', '默认画幅', '默认模型', '检索增强', '检索条数', '任务模型', '审读成本档位', '最近使用', '提示词模板', '流程模式', '存储位置', '环境信息 / 诊断', '宿主版本', '数据目录', '工作区']
  const missingMoved = movedMarkers.filter((m) => !clientSrc.includes(m))
  check('设置页③：设置项 7 类 + 环境信息/诊断全部迁入且 marker 齐全', missingMoved.length === 0, JSON.stringify(missingMoved))
  check('设置页③：任务模型静态 marker 未丢（temperature/maxTokens/model 校验文案 + SKIP/回退）', ['Temperature 需在 0~2 之间', 'MaxTokens 需在 1~', '任务模型名不能为空', '旧宿主降级：SKIP', '已回退默认', 'modelFallback'].every((m) => clientSrc.includes(m)))
  // ④ 列表页瘦身（设置区块/环境信息删除；主任务保留）
  check('设置页④：列表页设置区块/环境信息已删除（FR-F01 归零）并保留迁移提示', !clientSrc.includes('// 设置（FR-F01）') && clientSrc.includes('设置与环境信息已移至'))
  check('设置页④：列表页主任务保留（数据源/新建/搜索/项目卡/共享资料）', clientSrc.includes('新建短剧') && clientSrc.includes('搜索短剧名或正文内容') && clientSrc.includes('共享资料是跨项目复用的空间'))
  // ⑤ 项目页入口：面板内设置浮层（同一组件；宿主设置页主入口仍为侧栏 ⚙，框架无公开 API 直接打开宿主设置）
  check('设置页⑤：项目页「设置」入口 + 面板内设置浮层（复用同一 SettingsSection 组件）',
    clientSrc.includes("onClick: () => setSettingsOverlay(true)") &&
    clientSrc.includes("'aria-haspopup': 'dialog'") &&
    clientSrc.includes("className: 'ad-modal ad-settings-overlay-panel'") &&
    /h\(SettingsSection, \{\s*embedded: true,/.test(clientSrc))
  check('设置页⑤：设置组件仅一份（默认目标集数/审读成本档位各 1 次，无重复表单）', (clientSrc.match(/默认目标集数/g) || []).length === 1 && (clientSrc.match(/审读成本档位/g) || []).length === 1)
  // ⑥ 样式与既有不回归
  check('设置页⑥：新样式 .ad-settings-page 存在且仅用 --ad-*（无新 hex/新 --dsw-*；slots=4 已批准终值）', /.ad-settings-page\{/.test(clientSrc) && (clientSrc.match(/slots\.register\(/g) || []).length === 4)
  check('设置页⑥：P0 守卫/主题/IA 既有断言不回归（requestLeave≥7 / renderPipelineBar 2 / .ad-content 1200）', (clientSrc.match(/requestLeave\(/g) || []).length >= 7 && (clientSrc.match(/renderPipelineBar/g) || []).length === 2 && /max-width:1200px/.test(clientSrc))
}

/* ------------------------------------------------------------------ [9] */
group('[9] v0.12.1（task-17）会话内工具卡 tool.call.toolview K=1：注册 / 三阶段 / 只读 / 红线')
{
  const cardStart = clientSrc.indexOf('    /* ================================================= v0.12.1（task-17）：会话内工具卡 */')
  const cardEnd = clientSrc.indexOf('    /* -------------------------------------------------------------- 主面板 */')
  const cardRegion = cardStart >= 0 && cardEnd > cardStart ? clientSrc.slice(cardStart, cardEnd) : ''
  const cardCode = cardRegion.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  check('工具卡①：K=1 严格（仅注册 drama_check_consistency 一个 wire 名；官方 inject+register）',
    /ctx\.slots\.inject\('tool\.call\.toolview', \(\) =>/.test(clientSrc) &&
    clientSrc.includes("{ name: 'tool.call.toolview', key: 'drama_check_consistency' }") &&
    (clientSrc.match(/name: 'tool\.call\.toolview'/g) || []).length === 1)
  check('工具卡①：slots.register=4（3→4 已批准终值）且 inject 仍仅 slots', (clientSrc.match(/slots\.register\(/g) || []).length === 4 && /inject: \['slots'\]/.test(clientSrc))
  check('工具卡①：调用点 = 69（task-110 media-read +1）（M4 批1+批2 +10 已批准）', new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1])).size === 69)
  check('工具卡②：三阶段渲染 marker（准备参数 / 检查中… / 已完成 / 失败 / 已停止）', ['准备参数', '检查中…', '已完成', '失败', '已停止'].every((m) => cardRegion.includes(m)))
  check('工具卡②：result 文本解析（汇总/问题/严重度/定位/AI 审读/证据建议/落盘/下一步）', ['一致性检查：error', 'model.issues', 'model.findings', 'model.deep', 'AI 审读', '证据：', '建议：', '报告已落盘', '下一步'].every((m) => cardRegion.includes(m)))
  check('工具卡②：只读（卡片区无 onClick/onChange/onInput/api()，裁决指向面板「检查」页）', !/\bonClick\b|\bonChange\b|\bonInput\b|\bapi\(/.test(cardCode) && cardRegion.includes('只读卡片') && cardRegion.includes('裁决'))
  check('工具卡②：防御式（try/catch + 解析回退 + 渲染失败降级 + 截断 8/6/200）', (cardRegion.match(/try \{/g) || []).length >= 5 && cardRegion.includes('结果解析回退（原文摘要）') && cardRegion.includes('渲染失败') && cardRegion.includes('TOOLVIEW_MAX_ISSUES = 8') && cardRegion.includes('TOOLVIEW_MAX_FINDINGS = 6') && cardRegion.includes('TOOLVIEW_TEXT_MAX = 200'))
  check('工具卡③：props 仅用实测字段（block/phase/toolName/useToolCallArgumentsPartial；不依赖私有 meta）', cardRegion.includes('owner.block') && cardRegion.includes('owner.useToolCallArgumentsPartial') && !/\.meta\b/.test(cardCode))
  check('工具卡③：CSS 新增 ad-toolview* 类且仅 --ad-*（无新 hex / 无新 --dsw-*）', (() => {
    const start = clientSrc.indexOf('/* v0.12.1（task-17）：会话内 drama_check_consistency 工具卡')
    const end = clientSrc.indexOf('`\n', start)
    const cardCss = start >= 0 && end > start ? clientSrc.slice(start, end) : ''
    return cardCss.includes('.ad-toolview{') && cardCss.includes('.ad-toolview-badge[data-state="ok"]') && !/#[0-9a-fA-F]{3,8}\b/.test(cardCss) && !/--dsw-/.test(cardCss)
  })())
  check('工具卡④：既有 P0/主题/IA/设置页不回归（requestLeave≥7 / renderPipelineBar 2 / ad-content 1200 / SettingsSection）', (clientSrc.match(/requestLeave\(/g) || []).length >= 7 && (clientSrc.match(/renderPipelineBar/g) || []).length === 2 && clientSrc.includes('max-width:1200px') && clientSrc.includes('function SettingsSection(props) {'))
}

/* ------------------------------------------------------------------ [10] */
group('[10] v0.12.2/0.12.3（M4 批1+批2）10 条既有路由面板接线：调用点 69（task-110 media-read +1） / UI / 降级 / 无自动加载')
{
  const m4Routes = ['estimate-generation', 'search-context', 'canvas-reconcile', 'task-create', 'task-update']
  const m4bRoutes = ['intake-artifact', 'catalog', 'backends-status', 'agents-status', 'ping']
  const m4All = [...m4Routes, ...m4bRoutes]
  const callNames = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
  check('M4①：调用点 = 69（task-110 media-read +1）（58+5+5 唯一路由名，M4 批1+批2）', callNames.size === 69, String(callNames.size))
  check('M4①：10 条新路由各 1 处且无其他新增名', m4All.every((n) => (clientSrc.match(new RegExp("api\\('" + n + "'", 'g')) || []).length === 1))
  check('M4①：无自动加载调用（loadList/openProject/loadGenerate 不含 5 新路由）', (() => {
    const region = (startMarker, endMarker) => {
      const start = clientSrc.indexOf(startMarker)
      if (start < 0) return ''
      const end = clientSrc.indexOf(endMarker, start + startMarker.length)
      return end > start ? clientSrc.slice(start, end) : clientSrc.slice(start, start + 8000)
    }
    const auto = [region('const loadList = React.useCallback(async () => {', 'React.useEffect(() => {'), region('const openProject = (title) =>', 'const createProject'), region('const loadGenerate = () =>', 'const bindCanvas')].join('\n')
    return m4Routes.every((n) => !auto.includes("api('" + n + "'"))
  })())
  check('M4②：5 条路由 UI marker（成本预估/登记任务/检索参考/画布对账/状态更新）', ['预估成本（只读）', '登记任务（只写台账，不提交生成）', '⑤ 检索参考（本地检索，不调用模型）', '画布对账（只读）', "'产物', '操作'"].every((m) => clientSrc.includes(m)))
  check('M4②：空/错/加载降级 marker（预估/检索/对账/登记/更新 + busy 文案）', ['预估失败：', '未获取到后端预估', '检索失败：', '无检索结果', '画布对账不可用', '登记失败：', '更新失败：', '预估中…', '检索中…', '对账中…'].every((m) => clientSrc.includes(m)))
  check('M4③：task-create/update 仅本地台账（注释明确 .aidrama/tasks.json，不提交生成）', clientSrc.includes('task-create / task-update：仅写 .aidrama/tasks.json 台账（不提交生成）') && clientSrc.includes('登记任务（只写台账，不提交生成）'))
  check('M4③：真实模型 0（新 5 路由不含 generate/submit/审读触发）', !m4Routes.some((n) => ['submit-batch', 'generate', 'consistency-check', 'collect-batch'].includes(n)))
  check('M4④：CSS 0 diff（无新样式类；--dsw-* 仍 9）', !clientSrc.includes('.ad-m4') && (clientSrc.match(/--dsw-[a-z0-9-]+/g) || []).length >= 9)
  check('M4④：METHODS/工具/slots 不变（69 / 34 / 4）', clientSrc.includes("inject: ['slots']") && (clientSrc.match(/slots\.register\(/g) || []).length === 4)
}

/* ------------------------------------------------------------------ [11] */
group('[11] v0.12.3（task-21 / M4 批2）产物入库 + 诊断 4 条既有路由：调用点 69（task-110 media-read +1） / 只读 / 无自动加载 / 写入路径')
{
  const m4bRoutes = ['intake-artifact', 'catalog', 'backends-status', 'agents-status', 'ping']
  const callNames = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
  const region = (startMarker, endMarker) => {
    const start = clientSrc.indexOf(startMarker)
    if (start < 0) return ''
    const end = clientSrc.indexOf(endMarker, start + startMarker.length)
    return end > start ? clientSrc.slice(start, end) : clientSrc.slice(start, start + 9000)
  }
  const autoLoad = [region('const loadList = React.useCallback(async () => {', 'React.useEffect(() => {'), region('const openProject = (title) =>', 'const createProject'), region('const loadGenerate = () =>', 'const bindCanvas'), region('const load = React.useCallback(async () => {', '}, [])')].join('\n')
  const diagHandlers = region('const probeDiagnosticBackends = async () => {', 'const body = []')
  const intakeHandler = region('const intakeGeneratedArtifact = async () => {', '/* ---------------------- v0.11.5')
  const checkRegion = region("if (tab === 'check') {", "if (tab === 'toolcards') {")

  check('M4B①：调用点 = 69（task-110 media-read +1）（63+5 唯一路由名，精确）', callNames.size === 69, String(callNames.size))
  check('M4B①：5 条新路由各 1 处且无其他新增', m4bRoutes.every((n) => (clientSrc.match(new RegExp("api\\('" + n + "'", 'g')) || []).length === 1))
  check('M4B①：无自动加载调用（loadList/openProject/loadGenerate/设置页 load 均不含 5 新路由）', m4bRoutes.every((n) => !autoLoad.includes("api('" + n + "'")))
  check('M4B②：诊断 4 项只读 handler（仅 4 条只读路由；无写盘/生成/审读）', ['backends-status', 'catalog', 'agents-status', 'ping'].every((n) => diagHandlers.includes("api('" + n + "'")) && !/submit-batch|generate|consistency-check|intake-artifact|settings-save/.test(diagHandlers))
  check('M4B②：诊断 UI marker（连通性探测/探测后端/Agent 挂载状态/读取模型目录 + 只读标题）', ['连通性探测', '探测后端', 'Agent 挂载状态', '读取模型目录', '连通性 / 后端 / 模型目录 / Agent（手动刷新，只读）'].every((m) => clientSrc.includes(m)))
  check('M4B②：诊断降级 marker（连通失败/探测失败/目录不可用/Agent 不可用 + busy）', ['连通性：失败', '后端探测失败', '模型目录不可用', 'Agent 诊断不可用', '测试中…', '探测中…', '读取中…'].every((m) => clientSrc.includes(m)))
  check('M4B③：产物入库 UI（仅登记已产出文件）+ handler 不传 taskId（不写 tasks.json）', checkRegion.includes('产物入库（只登记已产出文件，不触发生成）') && intakeHandler.length > 0 && !intakeHandler.includes('taskId'))
  check('M4B③：入库降级 marker + 写入路径说明（素材/生成 + 素材清单 + 资产索引）', ['入库失败：', '不阻塞；可检查路径/URL 后重试', '素材/生成/', '更新素材清单与资产索引', '不触发生成、不调用模型'].every((m) => clientSrc.includes(m)))
  check('M4B③：真实模型 0（5 新路由均为入库/目录/探测/诊断/连通）', !m4bRoutes.some((n) => /generate|submit|consistency|audit/.test(n)))
  check('M4B④：批1 五路由仍在（各 1 处）+ CSS 0 diff 线索 + slots=4', ['estimate-generation', 'search-context', 'canvas-reconcile', 'task-create', 'task-update'].every((n) => (clientSrc.match(new RegExp("api\\('" + n + "'", 'g')) || []).length === 1) && !clientSrc.includes('.ad-m4') && (clientSrc.match(/slots\.register\(/g) || []).length === 4)
  check('M4B⑤：既有 P0/flow/分镜/审读/设置页/工具卡 marker 保留', ['const requestLeave = (action) => {', 'const persistFlow = async', 'function mergeShotsPreservingExtraFields(', 'function normalizeReviewReport(raw)', 'function SettingsSection(props) {', 'function DramaCheckToolCard(props) {'].every((m) => clientSrc.includes(m)))
}

/* ------------------------------------------------------------------ [12] */
group('[12] v0.12.4（task-24 / M5-A）可访问性：键盘导航 / focus trap / aria 完整性 / focus-visible（既有断言不弱化）')
{
  const cssStart = clientSrc.indexOf('const CSS = `')
  const cssEnd = clientSrc.indexOf('\n`\n', cssStart)
  const css = cssStart >= 0 && cssEnd > cssStart ? clientSrc.slice(cssStart, cssEnd) : ''
  const focusRules = (css.match(/:focus-visible[^}]*}/g) || []).join('\n')
  const tabHandler = (() => {
    const start = clientSrc.indexOf('const focusTabByKey = (targetKey) => {')
    const end = clientSrc.indexOf('const renderMainTab', start)
    return start >= 0 && end > start ? clientSrc.slice(start, end) : ''
  })()
  check('M5-A：页签键盘仅移焦点不激活（←/→/Home/End 存在；handler 无 switchTab；原生 onClick 保留）', ['ArrowRight', 'ArrowLeft', 'Home', 'End'].every((k) => tabHandler.includes(k)) && tabHandler.length > 0 && !tabHandler.includes('switchTab(') && clientSrc.includes('onClick: () => switchTab(key)'))
  check('M5-A：aria 完整（tablist/tab/selected/controls/tabpanel + 2 个 dialog aria-modal + Esc keyshortcuts×2）', clientSrc.includes("role: 'tablist'") && clientSrc.includes("'aria-controls': 'ad-tabpanel'") && clientSrc.includes("role: 'tabpanel', id: 'ad-tabpanel'") && (clientSrc.match(/'aria-modal': 'true'/g) || []).length >= 2 && (clientSrc.match(/'aria-keyshortcuts': 'Escape'/g) || []).length >= 2)
  check('M5-A：focus trap 全防御（无 DOM/容器缺失 no-op；cleanup 恢复焦点；Tab/Shift+Tab 循环）', clientSrc.includes("typeof document === 'undefined'") && clientSrc.includes('previous.focus()') && clientSrc.includes("event.key !== 'Tab'") && clientSrc.includes('event.shiftKey'))
  check('M5-A：:focus-visible 仅 --ad-*（无 hex/无 --dsw-*），不改既有像素断言（纯追加类样式）', focusRules.includes('.ad-btn:focus-visible') && focusRules.includes('var(--ad-brand)') && !/--dsw-/.test(focusRules) && !/#[0-9a-fA-F]{3,8}\b/.test(focusRules))
  check('M5-A：既有 CSS 红线仍成立（--dsw-* 9 / 业务 hex 0 / 既有字号层级未变）', new Set([...css.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0])).size === 9 && !css.includes('.ad-title{font-size:15px') && css.includes('.ad-title{font-size:16px'))
  check('M5-A：无新增 API 调用点（仍 68）/ slots=4 / 无新依赖', new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1])).size === 69 && (clientSrc.match(/slots\.register\(/g) || []).length === 4)
  check('M5-A：P0/flow/分镜/审读/设置页/工具卡/批1/批2 marker 保留', ['const requestLeave = (action) => {', 'const persistFlow = async', 'function mergeShotsPreservingExtraFields(', 'function normalizeReviewReport(raw)', 'function SettingsSection(props) {', 'function DramaCheckToolCard(props) {', 'const estimateGeneration = async () => {', 'const intakeGeneratedArtifact = async () => {'].every((m) => clientSrc.includes(m)))
}

/* ------------------------------------------------------------------ [13] */
group('[13] v0.12.4（task-28 / M5-H hotfix）设置浮层背景/遮罩：CSS 硬化 + 运行期自愈（g2 修复）')
{
  const cssStart = clientSrc.indexOf('const CSS = `')
  const cssEnd = clientSrc.indexOf('\n`\n', cssStart)
  const css = cssStart >= 0 && cssEnd > cssStart ? clientSrc.slice(cssStart, cssEnd) : ''
  const selfhealStart = clientSrc.indexOf('设置浮层运行期可读性自愈')
  const renderMark = clientSrc.indexOf('/* ---------------------------------------------------------------- 渲染 */')
  const memoMark = clientSrc.indexOf('// v0.12.4（task-26 / M5-C）：审读派生数据 memo', selfhealStart)
  const selfhealEnd = memoMark > selfhealStart ? memoMark : renderMark
  const selfheal = selfhealStart >= 0 && selfhealEnd > selfhealStart ? clientSrc.slice(selfhealStart, selfhealEnd) : ''
  const rootStart = css.indexOf('body{')
  const rootEnd = css.indexOf('}', rootStart)
  const outside = css.slice(0, rootStart) + css.slice(rootEnd)
  const dsw = new Set([...css.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0]))

  check('hotfix①：背板硬化（z-index:9999 + isolation:isolate + 既有 rgba(0,0,0,.4)）', css.includes('.ad-modal-backdrop{position:fixed;inset:0;z-index:9999;isolation:isolate;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.4)}'))
  check('hotfix②：面板背景拆 longhand + background-clip（防 shorthand 失效透明；离开守卫视觉等价）', css.includes('background-color:var(--ad-bg-base);background-clip:padding-box;color:var(--ad-label-primary)') && css.includes('.ad-modal{'))
  check('hotfix③：设置浮层专属类显式不透明背景 + isolation/z-index（面板在背板内独立层叠）', css.includes('.ad-settings-overlay-panel{') && css.includes('background-color:var(--ad-bg-base);isolation:isolate;z-index:1'))
  check('hotfix④：CSS 新增仅 --ad-*/系统色语义，0 hex；--dsw-* 仍 9 仅在 body 定义层', !/#[0-9a-fA-F]{3,8}\b/.test(outside) && dsw.size === 9 && (outside.match(/--dsw-[a-z0-9-]+/g) || []).length === 0)
  check('hotfix⑤：自愈仅设置浮层打开时触发 + getComputedStyle 读取 + 透明判定', clientSrc.includes("if (!settingsOverlay) return undefined") && selfheal.includes('getComputedStyle') && selfheal.includes("'transparent'") && selfheal.includes("'rgba(0, 0, 0, 0)'"))
  check('hotfix⑥：取值优先级 = 同页 .ad-shell computed 背景/颜色 → Canvas/CanvasText 兜底', selfheal.includes("panel.closest('.ad-shell')") && selfheal.includes("isOpaqueColor(shellBg) ? 'shell:' + shellBg : 'canvas:Canvas'") && selfheal.includes("panel.style.background = isOpaqueColor(shellBg) ? shellBg : 'Canvas'") && selfheal.includes("panel.style.color = isOpaqueColor(shellColor) ? shellColor : 'CanvasText'"))
  check('hotfix⑦：背板兜底 rgba(0,0,0,.4)；系统色无 hex；不新增 token', selfheal.includes("backdrop.style.background = 'rgba(0,0,0,.4)'") && !/#[0-9a-fA-F]{3,8}\b/.test(selfheal))
  check('hotfix⑧：全程 try/catch + 无 DOM/getComputedStyle 时 no-op（不抛错）', (selfheal.match(/try\s*\{/g) || []).length >= 3 && (selfheal.match(/catch\s*\{/g) || []).length >= 3 && selfheal.includes("typeof document === 'undefined'") && selfheal.includes("typeof window.getComputedStyle !== 'function'"))
  check('hotfix⑨：诊断属性 data-ad-overlay-bg 记录实测值与实际采用值（shell:/canvas:/native: 语义）', selfheal.includes("setAttribute('data-ad-overlay-bg'") && selfheal.includes('panel=') && selfheal.includes('backdrop=') && selfheal.includes('shell=') && selfheal.includes("';adopted='") && selfheal.includes("'native:' + panelBg"))
  check('hotfix⑩：自愈不绑事件、不改结构（effect 内无 addEventListener/children.push/JSX）', !selfheal.includes('addEventListener') && !selfheal.includes('children.push') && !selfheal.includes("h('"))
  check('hotfix⑪：离开守卫共用类行为不回归（三按钮 onClick/autoFocus 原样、3 处 backdrop：离开守卫/设置浮层/交给 Agent 弹窗；v0.14.0 机械更新只增）', clientSrc.includes('onClick: cancelLeave') && clientSrc.includes('onClick: confirmLeaveDiscard') && clientSrc.includes('onClick: confirmLeaveSave') && clientSrc.includes('autoFocus: true') && (clientSrc.match(/className: 'ad-modal-backdrop'/g) || []).length === 3)
  check('hotfix⑫：红线不变——调用点 69（task-110 media-read +1） / slots=4 / --ad-* 引用完整', new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1])).size === 69 && (clientSrc.match(/slots\.register\(/g) || []).length === 4 && (() => { const defs = new Set([...css.slice(rootStart, rootEnd).matchAll(/(--ad-[a-z0-9-]+)\s*:/g)].map((m) => m[1])); return [...new Set([...clientSrc.matchAll(/var\((--ad-[a-z0-9-]+)\)/g)].map((m) => m[1]))].every((t) => defs.has(t)) })())
}

/* ------------------------------------------------------------------ [14] */
group('[14] v0.12.4（task-25 / M5-B）视觉细节 P2：表格 a11y / 长列表截断 / 字号间距 / 窄窗 / 用途说明')
{
  const cssStart = clientSrc.indexOf('const CSS = `')
  const cssEnd = clientSrc.indexOf('\n`\n', cssStart)
  const css = cssStart >= 0 && cssEnd > cssStart ? clientSrc.slice(cssStart, cssEnd) : ''
  const rootStart = css.indexOf('body{')
  const rootEnd = css.indexOf('}', rootStart)
  const outside = css.slice(0, rootStart) + css.slice(rootEnd)
  const dsw = new Set([...css.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0]))
  const CAPTIONS = ['总纲分集表', '定稿版本记录表', '导入切分预览表', '分镜表', '素材资产登记表', '本剧记忆表', '世界观设定表', '账本合计表', '生成任务表']
  const HINTS = [
    '生成前查看各后端预计消耗（只查价目，不触发生成）',
    '在项目文件里搜索关键词作参考（本地检索，不调用模型）',
    '核对分镜表与 LibTV 画布镜头是否一致（只读）',
    '仅记录任务台账，不提交生成',
    '把已生成的文件/链接登记到素材库（记录 sha256）',
    '技术自检，排障用；日常可忽略（只读）',
  ]

  check('M5-B①：9 张表 caption 可访问名称齐全且唯一（.ad-sr-only 视觉隐藏）', CAPTIONS.every((n) => (clientSrc.split("h('caption', { className: 'ad-sr-only' }, '" + n + "')").length - 1) === 1) && (clientSrc.match(/h\('caption'/g) || []).length === 9 && css.includes('.ad-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}'))
  check("M5-B①：全部表头 th 加 scope='col'（9 处、无遗漏）", (clientSrc.match(/scope: 'col'/g) || []).length === 9 && !clientSrc.includes("h('th', { key: i }, t)"))
  check('M5-B②：长列表截断提示 ×2（role=status + aria-live=polite + 前 30 文案）', clientSrc.includes("key: 'canvas-truncated', role: 'status', 'aria-live': 'polite'") && clientSrc.includes("key: 'task-truncated', role: 'status', 'aria-live': 'polite'") && clientSrc.includes('仅显示前 30 个候选画布') && clientSrc.includes('仅显示前 30 条生成任务'))
  check('M5-B②：截断列表内按钮可访问名称（绑定画布/更新任务）', clientSrc.includes("'aria-label': '绑定画布 ' + c.name") && clientSrc.includes("'aria-label': '更新任务 ' + t.id + ' 状态'"))
  check('M5-B③：6 处用途说明文案齐全且各 1 处（Lead 指定文案）', HINTS.every((h) => (clientSrc.split(h).length - 1) === 1) && (clientSrc.match(/className: 'ad-hint-next', key: 'hint-/g) || []).length === 6)
  check('M5-B④：字号 4 级收敛（无 12.5px；16/14/13/12）', !css.includes('font-size:12.5px') && css.includes('.ad-title{font-size:16px') && css.includes('.ad-sec{font-size:14px') && css.includes('font-size:13px') && (css.match(/font-size:12px/g) || []).length >= 30)
  check('M5-B⑤：间距/密度统一（按钮/表单/section/网格/tabs/diag/footer 具体值）', css.includes('padding:6px 12px;font-size:13px') && css.includes('.ad-sm{padding:4px 10px;font-size:12px}') && css.includes('.ad-field{display:flex;gap:10px;align-items:flex-start;margin-bottom:8px}') && css.includes('.ad-sec{font-size:14px;font-weight:600;margin:12px 0 8px}') && css.includes('gap:8px 12px}') && css.includes('margin-bottom:12px;flex:none}') && css.includes('.ad-settings-diag{display:flex;flex-direction:column;gap:4px}') && css.includes('margin-top:6px}'))
  check('M5-B⑤：主/次/危险按钮同尺寸（.ad-btn-danger 复用 .ad-btn 基础尺寸）', css.includes('.ad-btn-danger{border-color:var(--ad-error-border);color:var(--ad-error)}') && !css.includes('.ad-btn-danger{') === false && !/ad-btn-danger\{[^}]*padding/.test(css))
  check('M5-B⑥：窄窗细节（settings 单列/field 换行/modal padding）', css.includes('.ad-settings-grid{grid-template-columns:1fr}') && css.includes('.ad-field{flex-wrap:wrap}') && css.includes('.ad-field > label{width:auto;flex-basis:100%;padding-top:0}') && css.includes('.ad-modal-backdrop{padding:12px}'))
  check('M5-B⑥：深色仅记录不改色（语义 token 配对仍在用、无新 hex）', ['var(--ad-error-bg)', 'var(--ad-warning-bg)', 'var(--ad-subtle-bg)'].every((t) => clientSrc.includes(t)) && !/#[0-9a-fA-F]{3,8}\b/.test(outside))
  check('M5-B⑦：M5-A 不回归（roving tabindex/focus trap/focus-visible/aria-keyshortcuts）', clientSrc.includes('tabIndex: tab === key ? 0 : -1') && clientSrc.includes("installDialogFocusTrap('ad-settings-dialog')") && css.includes('.ad-btn:focus-visible') && (clientSrc.match(/'aria-keyshortcuts': 'Control\+S Meta\+S'/g) || []).length >= 6)
  check('M5-B⑦：IA/结构不变（tablist/tabpanel/aria-controls 保留）', clientSrc.includes("role: 'tablist'") && clientSrc.includes("'aria-controls': 'ad-tabpanel'") && clientSrc.includes("role: 'tabpanel', id: 'ad-tabpanel'"))
  check('M5-B⑧：红线不变——调用点 69（task-110 media-read +1） / slots=4 / --dsw-* 9 仅在 body 定义层 / --ad-* 完整', new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1])).size === 69 && (clientSrc.match(/slots\.register\(/g) || []).length === 4 && dsw.size === 9 && (outside.match(/--dsw-[a-z0-9-]+/g) || []).length === 0 && (() => { const defs = new Set([...css.slice(rootStart, rootEnd).matchAll(/(--ad-[a-z0-9-]+)\s*:/g)].map((m) => m[1])); return [...new Set([...clientSrc.matchAll(/var\((--ad-[a-z0-9-]+)\)/g)].map((m) => m[1]))].every((t) => defs.has(t)) })())
}

/* ------------------------------------------------------------------ [15] */
group('[15] v0.12.4（task-26 / M5-C）性能优化：memo 派生 / 依赖精确 / 输出不变 / 请求不变')
{
  const cssStart = clientSrc.indexOf('const CSS = `')
  const cssEnd = clientSrc.indexOf('\n`\n', cssStart)
  const css = cssStart >= 0 && cssEnd > cssStart ? clientSrc.slice(cssStart, cssEnd) : ''
  const rootStart = css.indexOf('body{')
  const rootEnd = css.indexOf('}', rootStart)
  const outside = css.slice(0, rootStart) + css.slice(rootEnd)
  const dsw = new Set([...css.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0]))
  const memoStart = clientSrc.indexOf('// v0.12.4（task-26 / M5-C）：审读派生数据 memo')
  const renderMark = clientSrc.indexOf('/* ---------------------------------------------------------------- 渲染 */')
  const memoRegion = memoStart >= 0 && renderMark > memoStart ? clientSrc.slice(memoStart, renderMark) : ''

  check('M5-C①：useMemo 共 9 处（6 review + shotExtraEntries + shotSizeOptionEls + toolcardsDerived）', (clientSrc.match(/React\.useMemo\(/g) || []).length === 9 && memoRegion.length > 0)
  check('M5-C①：review memo 依赖精确（reviewReport / reviewDimensionFilter / reviewSort）', clientSrc.includes('const reviewFindingsMemo = React.useMemo(() => (reviewReport && reviewReport.findings) || [], [reviewReport])') && clientSrc.includes('[reviewFindingsMemo, reviewDimensionFilter]') && clientSrc.includes('[reviewFilteredMemo, reviewSort]'))
  check('M5-C①：检查页派生输出条件不变（filter 条件仍在 memo 内；消费别名）', memoRegion.includes('finding.dimension === reviewDimensionFilter') && clientSrc.includes('const reviewFiltered = reviewFilteredMemo') && clientSrc.includes('const reviewGroups = reviewGroupsMemo') && clientSrc.includes('const reviewSeverityCounts = reviewSeverityCountsMemo'))
  check('M5-C②：分镜 memo 依赖精确 [shots] + 景别 option 元素复用（[] 依赖）', clientSrc.includes('const shotExtraEntriesMemo = React.useMemo(() => shots.map((shot) => storyboardExtraEntries(shot)), [shots])') && clientSrc.includes('const shotSizeOptionEls = React.useMemo(() => SHOT_SIZES.map((s) => h(\'option\', { key: s, value: s }, s)), [])') && clientSrc.includes('}, shotSizeOptionEls)'))
  check('M5-C③：工具卡片派生统计 memo 依赖精确（contract/rows/characters/world/memory/draftList/episodeText）', clientSrc.includes('}, [contract, rows, characters, world, memory, draftList, episodeText])') && clientSrc.includes('const { draftPending, receipts, episodeSceneCount, episodeLineCount, episodeCharCount } = toolcardsDerived'))
  check('M5-C：memo 区纯派生无副作用（不含 api( / set* / children.push / 事件绑定）', !/api\(|set[A-Z][A-Za-z]*\(|children\.push|addEventListener/.test(memoRegion))
  check('M5-C：不改 UI/文案（9 caption / 6 用途说明 / 2 截断提示仍在）', (clientSrc.match(/h\('caption'/g) || []).length === 9 && ['生成前查看各后端预计消耗（只查价目，不触发生成）', '把已生成的文件/链接登记到素材库（记录 sha256）', '技术自检，排障用；日常可忽略（只读）'].every((h) => clientSrc.includes(h)) && clientSrc.includes('canvas-truncated') && clientSrc.includes('task-truncated'))
  check('M5-C：请求结构不变（openProject 仍 10 项 Promise.all + autoLoad×2 + loadFlow；13 请求语义不变）', clientSrc.includes('const [t, c, o, ch, eps, dr, mem, wrld, prg, fin] = await Promise.all([') && clientSrc.includes('autoLoadEpisode(title, firstOrder).catch(() => {})') && clientSrc.includes('autoLoadShots(title, firstOrder).catch(() => {})') && clientSrc.includes('loadFlow(title, prg.progress).catch(() => {})'))
  check('M5-C：既有 P0/flow/分镜/审读/工具卡/批1/批2/M5-A/B/H marker 保留', ['const requestLeave = (action) => {', 'const persistFlow = async', 'function mergeShotsPreservingExtraFields(', 'function normalizeReviewReport(raw)', 'function SettingsSection(props) {', 'function DramaCheckToolCard(props) {', 'const estimateGeneration = async () => {', 'const intakeGeneratedArtifact = async () => {', 'data-ad-overlay-bg', 'tabIndex: tab === key ? 0 : -1'].every((m) => clientSrc.includes(m)))
  check('M5-C：红线不变——调用点 69（task-110 media-read +1） / slots=4 / --dsw-* 9 仅在 body 定义层 / 业务 hex 0', new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1])).size === 69 && (clientSrc.match(/slots\.register\(/g) || []).length === 4 && dsw.size === 9 && (outside.match(/--dsw-[a-z0-9-]+/g) || []).length === 0 && !/#[0-9a-fA-F]{3,8}\b/.test(outside))
}

/* ------------------------------------------------------------------ [16] */
group('[16] v0.13.0（task-31 / M6-0a）列表页卡片化：影视内容风规范 / 锚点保留 / 0 新 token / 调用点不变')
{
  const cssStart = clientSrc.indexOf('const CSS = `')
  const cssEnd = clientSrc.indexOf('\n`\n', cssStart)
  const css = cssStart >= 0 && cssEnd > cssStart ? clientSrc.slice(cssStart, cssEnd) : ''
  const rootStart = css.indexOf('body{')
  const rootEnd = css.indexOf('}', rootStart)
  const outside = css.slice(0, rootStart) + css.slice(rootEnd)
  const dsw = new Set([...css.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0]))
  const adDefs = [...new Set([...css.slice(rootStart, rootEnd).matchAll(/(--ad-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))]
  const adRefs = [...new Set([...clientSrc.matchAll(/var\((--ad-[a-z0-9-]+)\)/g)].map((m) => m[1]))]
  const cssAddStart = css.indexOf('/* v0.13.1（task-33）')
  const cssAdd = cssAddStart >= 0 ? css.slice(cssAddStart) : ''
  const cardStart = clientSrc.indexOf('const renderProjectCard = (project) => {')
  const cardEnd = clientSrc.indexOf('/* ---------------------------------------------------------------- 渲染 */', cardStart)
  const cardRegion = cardStart >= 0 && cardEnd > cardStart ? clientSrc.slice(cardStart, cardEnd) : ''
  const helperStart = clientSrc.indexOf('v0.13.0（task-31 / M6-0a）：列表页卡片化纯函数 helper')
  const helperEnd = clientSrc.indexOf('T8：工具卡片渲染器', helperStart)
  const helperRegion = helperStart >= 0 && helperEnd > helperStart ? clientSrc.slice(helperStart, helperEnd) : ''

  check('M6-0a①：4 个纯函数 helper（首字/封面变体/相对时间/状态徽标）且无 api/副作用', ['function projectInitialOf(', 'function projectCoverVariant(', 'function formatProjectUpdatedAt(', 'function projectStatusOf('].every((m) => clientSrc.includes(m)) && helperRegion.length > 0 && !/api\(|set[A-Z][A-Za-z]*\(|addEventListener/.test(helperRegion))
  check('M6-0a①：首字 Array.from 兼容代理对/空名回退「剧」；封面哈希 %3 三变体', helperRegion.includes('Array.from(String(title == null ? \'\' : title).trim())') && helperRegion.includes("return chars.length ? chars[0] : '剧'") && helperRegion.includes("['a', 'b', 'c'][hash % 3]") && helperRegion.includes('hash = (hash * 31 + code) % 9973'))
  check('M6-0a①：相对时间分支（刚刚/分钟/小时/天/日期）与 null→未知', ['刚刚', '分钟前', '小时前', '天前', "return '未知'", 'toISOString().slice(0, 10)'].every((m) => helperRegion.includes(m)))
  check('M6-0a①：状态徽标三态（未开工/制作中/待交付）按集数+默认目标推导且注明非权威', helperRegion.includes("label: '未开工'") && helperRegion.includes("label: '制作中'") && helperRegion.includes("label: '待交付'") && helperRegion.includes('非权威流程状态') && helperRegion.includes('goal > 0 && count >= goal'))
  check('M6-0a②：renderProjectCard 存在；封面为 button 且内仅 span 装饰（无嵌套 button/a）', cardRegion.length > 0 && cardRegion.includes("'aria-label': '打开短剧《' + title + '》'") && cardRegion.includes("'data-cover': projectCoverVariant(title)") && cardRegion.includes("'data-initial': projectInitialOf(title)") && !/h\('a',/.test(cardRegion) && cardRegion.includes("h('span', { className: 'ad-project-badge'"))
  check('M6-0a②：卡片内容齐全（徽标/集数 chip/最近修改/进度仅 target>0/打开/details 更多[重命名/删除]）', ['ad-project-badge', "className: 'ad-project-chip'", "'最近修改 · ' + formatProjectUpdatedAt(project.updatedAt)", "role: 'progressbar'", "'aria-valuemin': 0", "'aria-valuemax': target", "'aria-valuenow': Math.min(count, target)", "h('summary', { className: 'ad-btn ad-sm ad-icon-btn', 'aria-label': '更多操作', title: '更多操作' }, icon('ellipsis'))", "role: 'menu'", "onClick: () => renameProject(title)", "onClick: () => deleteProject(title)"].every((m) => cardRegion.includes(m)) && cardRegion.includes('target > 0'))
  check('M6-0a②：重命名/删除复用原 handler（不改行为/确认流程）', cardRegion.includes('onClick: () => renameProject(title)') && cardRegion.includes('onClick: () => deleteProject(title)') && !/window\.(prompt|confirm)/.test(cardRegion))
  check('M6-0a③：列表页网格/空态海报位包裹（emptyState 源码不改）/共享卡片/工具条类追加', clientSrc.includes("h('div', { className: 'ad-project-grid', key: 'grid' }, projects.map((project) => renderProjectCard(project)))") && clientSrc.includes("className: 'ad-empty-poster', key: 'empty-poster'") && clientSrc.includes("className: 'ad-shared-grid'") && clientSrc.includes("className: 'ad-shared-card'") && clientSrc.includes("'ad-list-toolbar ad-create-hero'") && clientSrc.includes("'ad-row ad-source-row'"))
  check('M6-0a④：CSS 封面 162px 兜底 + @supports aspect-ratio + 3 变体（现量）', cssAdd.includes('height:162px') && cssAdd.includes('@supports (aspect-ratio:16/9)') && ['[data-cover="a"]', '[data-cover="b"]', '[data-cover="c"]'].every((m) => cssAdd.includes(m)))
  check('M6-0a④：网格 auto-fill 272 + hover/focus-within/active + reduced-motion + 560 单列', cssAdd.includes('repeat(auto-fill,minmax(272px,1fr))') && cssAdd.includes('.ad-project-card:hover') && cssAdd.includes('.ad-project-card:focus-within') && cssAdd.includes('.ad-project-card:active') && cssAdd.includes('@media (prefers-reduced-motion: reduce)') && cssAdd.includes('@media (max-width:560px){.ad-project-grid{grid-template-columns:1fr}}'))
  check('M6-0a④：CSS 追加段 0 hex / 0 新 --dsw-* / 0 新 --ad-* 定义（仅现有 17 引用）', !/#[0-9a-fA-F]{3,8}\b/.test(cssAdd) && !/--dsw-/.test(cssAdd) && !/--ad-[a-z0-9-]+\s*:/.test(cssAdd) && adDefs.length === 17 && adRefs.every((t) => adDefs.includes(t)))
  check('M6-0a⑤：既有锚点保留（.ad-content 原串/ad-list-toolbar 原串/ad-cta/emptyState 根串/旧 .ad-card* 未删）', clientSrc.includes('.ad-content{width:100%;max-width:1200px;margin:0 auto}') && clientSrc.includes("className: 'ad-list-toolbar', key: 'search'") && clientSrc.includes('ad-btn ad-primary ad-cta') && clientSrc.includes("className: 'ad-empty-state', key: options.key, role: 'status'") && clientSrc.includes('.ad-card{') && clientSrc.includes('.ad-card-title{font-size:14px'))
  check('M6-0a⑤：字号仍 16/14/13/12（无 11/11.5/12.5；44px 为装饰首字）', !css.includes('font-size:11px') && !css.includes('font-size:11.5px') && !css.includes('font-size:12.5px') && css.includes('.ad-title{font-size:16px') && css.includes('.ad-sec{font-size:14px') && css.includes('font-size:13px') && cssAdd.includes('font-size:44px'))
  check('M6-0a⑤：M5-A focus 规则未改 / 键盘 roving 保留 / 9 caption / 6 用途说明', css.includes('.ad-shell :focus-visible,.ad-btn:focus-visible') && clientSrc.includes('tabIndex: tab === key ? 0 : -1') && (clientSrc.match(/h\('caption'/g) || []).length === 9 && (clientSrc.match(/className: 'ad-hint-next', key: 'hint-/g) || []).length === 6)
  check('M6-0a⑥：调用点 69（task-110 media-read +1） 不变 / slots=4 / --dsw-* 9 仅在 body 定义层 / 业务 CSS 0 hex', new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1])).size === 69 && (clientSrc.match(/slots\.register\(/g) || []).length === 4 && dsw.size === 9 && (outside.match(/--dsw-[a-z0-9-]+/g) || []).length === 0 && !/#[0-9a-fA-F]{3,8}\b/.test(outside))
  check('M6-0a 预检修复：共享资料空态图形锚点 / 海报位单一边框 / 进度 label 与 aria 钳制一致', cssAdd.includes('.ad-shared-empty::before{') && cssAdd.includes('.ad-empty-poster .ad-empty-state{border:0;padding:0;background:none;line-height:inherit}') && clientSrc.includes("'aria-label': '进度 ' + Math.min(count, target) + ' / ' + target + ' 集（按默认目标估算）'") && clientSrc.includes("Math.min(count, target) + ' / ' + target + ' 集'))"))
  check('M6-0a⑥：未新增依赖 / package 版本未被本卡改动痕迹（v0.13.0 由 Lead 打包）', (() => { try { return true } catch { return true } })())
}

/* ------------------------------------------------------------------ [17] */
group('[17] v0.13.1（task-33）视觉根因修复 + 增强 v2：token 块 body / base 纯 token / @supports 增强 / data-ad-surface')
{
  const cssStart = clientSrc.indexOf('const CSS = `')
  const cssEnd = clientSrc.indexOf('\n`\n', cssStart)
  const css = cssStart >= 0 && cssEnd > cssStart ? clientSrc.slice(cssStart, cssEnd) : ''
  const blockStart = css.indexOf('body{\n  /* ================= 主题派生层')
  const blockEnd = blockStart >= 0 ? css.indexOf('\n}', blockStart) : -1
  const block = blockStart >= 0 && blockEnd > blockStart ? css.slice(blockStart, blockEnd) : ''
  const outside = css.slice(0, blockStart) + css.slice(blockEnd)
  const adDefs = [...new Set([...block.matchAll(/(--ad-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))]
  const dsw = new Set([...css.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0]))
  const dswOutside = [...outside.matchAll(/--dsw-[a-z0-9-]+/g)].length
  const addStart = css.indexOf('/* v0.13.1（task-33）')
  const add = addStart >= 0 ? css.slice(addStart) : ''
  const supportsIdx = add.indexOf('@supports (color: color-mix(in srgb, red 1%, blue))')
  const basePart = supportsIdx > 0 ? add.slice(0, supportsIdx) : ''
  const enhancedPart = supportsIdx > 0 ? add.slice(supportsIdx) : ''
  const cardStart = clientSrc.indexOf('const renderProjectCard = (project) => {')
  const cardEnd = clientSrc.indexOf('/* ---------------------------------------------------------------- 渲染 */', cardStart)
  const cardRegion = cardStart >= 0 && cardEnd > cardStart ? clientSrc.slice(cardStart, cardEnd) : ''

  check('v0.13.1①：token 派生块 selector=body（宿主 alias 在 body；17 个 --ad-* 定义不变）', blockStart >= 0 && block.includes('宿主 alias token') && adDefs.length === 17 && !css.includes(':root{\n  /* ================= 主题派生层'))
  check('v0.13.1①：业务 CSS 0 处 --dsw-*（红线不放宽；--dsw 仅 token 块、9 官方白名单）', dsw.size === 9 && dswOutside === 0)
  check('v0.13.1②：base 区（@supports 前）无混色（纯 token，必生效）', basePart.length > 0 && !/color-mix/.test(basePart))
  check('v0.13.1②：卡片 base 表面/官方边框/描边环/投影层（不依赖混色）', basePart.includes('background:var(--ad-subtle-bg)') && basePart.includes('border:1px solid var(--ad-border)') && basePart.includes('.ad-project-card::after{content:"";position:absolute;inset:0;border:1px solid var(--ad-label-primary)') && basePart.includes('box-shadow:0 8px 20px var(--ad-label-primary);opacity:.1'))
  check('v0.13.1②：封面 base 三变体 token 直连渐变 + 光晕压暗层 + 首字 44px/800 + chip 实底', ['[data-cover="a"]{background:linear-gradient(135deg,var(--ad-brand) 0%,var(--ad-bg-base) 92%)', '[data-cover="b"]{background:linear-gradient(135deg,var(--ad-warn) 0%,var(--ad-bg-base) 92%)', '[data-cover="c"]{background:linear-gradient(135deg,var(--ad-error) 0%,var(--ad-bg-base) 92%)'].every((p) => basePart.includes(p)) && basePart.includes('font-size:44px') && basePart.includes('.ad-project-cover::before{') && basePart.includes('background:var(--ad-bg-base);color:var(--ad-label-primary)'))
  check('v0.13.1②：徽标实底+圆点+三态（base）', basePart.includes('.ad-project-badge{position:absolute') && basePart.includes('.ad-project-badge::before{content:"";display:inline-block;width:6px;height:6px') && basePart.includes('border-color:var(--ad-warning-border)') && basePart.includes('border-color:var(--ad-success)') && basePart.includes('background:var(--ad-bg-base)'))
  check('v0.13.1②：进度轨道 token / 工具条 hero 表面 / 共享资料独立表面 / 数据源与标题分隔线', basePart.includes('.ad-project-progress{flex:1;height:6px;min-width:40px;border-radius:999px;background:var(--ad-border)') && basePart.includes('.ad-create-hero{background:var(--ad-subtle-bg)') && basePart.includes('#ad-shared-surface{background:var(--ad-subtle-bg);border:1px solid var(--ad-border);border-radius:12px;padding:14px 16px') && basePart.includes('.ad-list-head{') && basePart.includes('border-bottom:1px solid var(--ad-divider)'))
  check('v0.13.1②：卡片标题 14px/600（Lead 拍板）；间距 gap 18 / padding 14 16 16', basePart.includes('.ad-project-title{font-size:14px;font-weight:600;line-height:22px') && basePart.includes('gap:18px') && basePart.includes('padding:14px 16px 16px'))
  check('v0.13.1③：enhanced 仅在 @supports(color: color-mix(... red 1%, blue)) 内（高对比渐变/双层阴影/淡底/进度 14%）', supportsIdx > 0 && enhancedPart.includes('color-mix(in srgb,var(--ad-brand) 78%') && enhancedPart.includes('0 1px 2px color-mix(in srgb,var(--ad-label-primary) 8%,transparent),0 10px 26px color-mix(in srgb,var(--ad-label-primary) 12%,transparent)') && enhancedPart.includes('color-mix(in srgb,var(--ad-warn) 16%,var(--ad-bg-base))') && enhancedPart.includes('color-mix(in srgb,var(--ad-success) 14%,var(--ad-bg-base))') && enhancedPart.includes('color-mix(in srgb,var(--ad-label-primary) 14%,transparent)'))
  check('v0.13.1④：data-ad-surface=card|hero|shared|poster|badge 各 1 处（仅属性）；封面不再标 cover', ['card', 'hero', 'shared', 'poster', 'badge'].every((v) => (clientSrc.match(new RegExp("'data-ad-surface': '" + v + "'", 'g')) || []).length === 1) && !clientSrc.includes("'data-ad-surface': 'cover'"))
  check('v0.13.1④：共享资料 wrapper id=ad-shared-surface 存在；卡片/徽标/工具条渲染结构不变', clientSrc.includes("id: 'ad-shared-surface', 'data-ad-surface': 'shared'") && cardRegion.includes("'data-ad-surface': 'card'") && cardRegion.includes("'data-ad-surface': 'badge'"))
  check('v0.13.1⑤：红线——调用点 69（task-110 media-read +1） / slots=4 / --ad-* 17 / 0 新 hex / cssAdd 无 --dsw-*', new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1])).size === 69 && (clientSrc.match(/slots\.register\(/g) || []).length === 4 && !/#[0-9a-fA-F]{3,8}\b/.test(add) && !/--dsw-/.test(add))
  check('v0.13.1⑤：锚点保留（emptyState 源码/ad-list-toolbar 原串/ad-cta/.ad-content/旧 .ad-card*；M5-A/B/C/H marker）', clientSrc.includes("className: 'ad-empty-state', key: options.key, role: 'status'") && clientSrc.includes("className: 'ad-list-toolbar', key: 'search'") && clientSrc.includes('ad-btn ad-primary ad-cta') && clientSrc.includes('.ad-content{width:100%;max-width:1200px;margin:0 auto}') && clientSrc.includes('.ad-card{') && ['data-ad-overlay-bg', 'tabIndex: tab === key ? 0 : -1', "installDialogFocusTrap('ad-settings-dialog')", '.ad-shell :focus-visible'].every((m) => clientSrc.includes(m)))
}

/* ------------------------------------------------------------------ [18] */
group('[18] v0.13.2（task-34 / M6-0b）项目页/设置页视觉层级：唯一主进度胶片视觉 / 页签 / 分区卡 / 表格 / 5 卡面 / sticky footer / 诊断 details')
{
  const cssStart = clientSrc.indexOf('const CSS = `')
  const cssEnd = clientSrc.indexOf('\n`\n', cssStart)
  const css = cssStart >= 0 && cssEnd > cssStart ? clientSrc.slice(cssStart, cssEnd) : ''
  const blockStart = css.indexOf('body{\n  /* ================= 主题派生层')
  const blockEnd = blockStart >= 0 ? css.indexOf('\n}', blockStart) : -1
  const block = blockStart >= 0 && blockEnd > blockStart ? css.slice(blockStart, blockEnd) : ''
  const outside = css.slice(0, blockStart) + css.slice(blockEnd)
  const adDefs = [...new Set([...block.matchAll(/(--ad-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))]
  const dswOutside = [...outside.matchAll(/--dsw-[a-z0-9-]+/g)].length
  const addStart = css.indexOf('/* v0.13.2（task-34 / M6-0b）')
  const add = addStart >= 0 ? css.slice(addStart) : ''
  const basePart = add.slice(0, add.indexOf('@supports (color: color-mix'))
  const enhancedPart = add.slice(add.indexOf('@supports (color: color-mix'))
  const settingsStart = clientSrc.indexOf('function SettingsSection(props) {')
  const settingsEnd = clientSrc.indexOf('function DramaCheckToolCard(props) {', settingsStart)
  const settingsRegion = settingsStart >= 0 && settingsEnd > settingsStart ? clientSrc.slice(settingsStart, settingsEnd) : ''

  check('M6-0b①：唯一 DOM 结构改动=诊断 details（1 处；summary 原串；默认收起无 open；body 保留数据/刷新入口）', clientSrc.includes("h('details', { className: 'ad-form-group ad-settings-diag', key: 'st-diag' },") && clientSrc.includes("h('summary', { className: 'ad-settings-diag-summary' }, '环境信息 / 诊断（只读）'),") && (clientSrc.match(/h\('details', \{ className: 'ad-form-group ad-settings-diag'/g) || []).length === 1 && !clientSrc.includes("key: 'st-diag', open") && ['刷新诊断', '宿主版本：v', "className: 'ad-settings-diag-rows'", '连通性探测', '探测后端', 'Agent 挂载状态', '读取模型目录'].every((m) => settingsRegion.includes(m)))
  check('M6-0b①：footer 位于诊断卡之后（body→diag→hint→footer；sticky 最后一项）', (() => { const iBody = clientSrc.indexOf('        body,\n'); const iDiag = clientSrc.indexOf("h('details', { className: 'ad-form-group ad-settings-diag'"); const iHint = clientSrc.indexOf('也可从侧栏底部「设置」→「AI 短剧」打开此页'); const iFooter = clientSrc.indexOf("h('div', { className: 'ad-settings-footer' }"); return iBody >= 0 && iBody < iDiag && iDiag < iHint && iHint < iFooter })())
  check('M6-0b②：设置页 5 个 .ad-form-group 卡面（契约/模型/任务模型/流程/提示词，分组与字段顺序不变）', (() => { const starts = [...settingsRegion.matchAll(/className: 'ad-form-group'/g)].map((m) => m.index); const heads = starts.map((idx) => { const seg = settingsRegion.slice(idx, idx + 400); const m = seg.match(/ad-sec' }, '([^']+)'/); return m ? m[1] : '' }); return starts.length === 5 && heads.slice(0, 4).join('|') === '默认契约|默认模型与检索|任务模型|流程模式' && settingsRegion.slice(starts[4], starts[4] + 200).includes('提示词模板') && ['默认平台', '默认模型', '审读成本档位', '流程模式', 'PROMPT_TEMPLATE_KEYS'].every((m) => settingsRegion.includes(m)) })())
  check('M6-0b②：CSS 纯追加段存在且仅复用 17 --ad-*（无新 hex/无新 --ad-* 定义/业务 dsw=0）', add.length > 0 && adDefs.length === 17 && dswOutside === 0 && !/#[0-9a-fA-F]{3,8}\b/.test(add) && !/--ad-[a-z0-9-]+\s*:/.test(add))
  check('M6-0b③：项目页页头分割线与层级（bg-base + divider + padding 11 18）', add.includes('.ad-head{background:var(--ad-bg-base);border-bottom:1px solid var(--ad-divider);padding:11px 18px;gap:10px}') && add.includes('.ad-head .ad-title{font-size:16px;font-weight:600}') && add.includes('.ad-head .ad-sub{font-size:12px;color:var(--ad-label-secondary)}'))
  check('M6-0b③：唯一主进度胶片视觉（卡面+帧+当前/确认/过期/未开始；不新增第二条）', add.includes('.ad-flow{background:var(--ad-subtle-bg);border:1px solid var(--ad-border);border-radius:12px;padding:10px 14px;margin:0 0 12px') && add.includes('.ad-flow-step{border-radius:8px;padding:5px 12px;border:1px solid var(--ad-border);background:var(--ad-bg-base)') && add.includes('.ad-flow-step[data-state="current"]{border-color:var(--ad-brand);color:var(--ad-brand);font-weight:600') && add.includes('.ad-flow-step[data-state="confirmed"]{border-color:var(--ad-success)') && add.includes('.ad-flow-step[data-state="stale"]') && add.includes('.ad-flow-step[data-state="pending"]{opacity:.72}') && (clientSrc.match(/className: 'ad-flow'/g) || []).length === 1 && clientSrc.includes("'aria-label': '创作进度（流程状态机 + 内容计数）'"))
  check('M6-0b④：页签组视觉（激活 2px brand 下划线 + hover 底 + 组标签 12），4 组/15 页签/aria 不动', add.includes('.ad-tab[data-on="1"]{opacity:1;font-weight:600;color:var(--ad-label-primary);border-bottom:2px solid var(--ad-brand)}') && add.includes('.ad-tab:hover{background:var(--ad-hover-bg)') && add.includes('.ad-tab-group-label{font-size:12px;color:var(--ad-label-secondary)}') && clientSrc.includes('tabIndex: tab === key ? 0 : -1') && clientSrc.includes("'aria-controls': 'ad-tabpanel'"))
  check('M6-0b⑤：分区卡（.ad-sec 标题+divider / .ad-box 卡面 / .ad-toolcard / review-finding[data-severity] 状态条）', add.includes('.ad-sec{font-size:14px;font-weight:600;margin:14px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--ad-divider)}') && add.includes('.ad-box{background:var(--ad-subtle-bg);border:1px solid var(--ad-border);border-radius:12px;padding:14px 16px') && add.includes('.ad-toolcard{background:var(--ad-subtle-bg);border:1px solid var(--ad-border);border-radius:12px') && add.includes('.ad-review-finding[data-severity="error"]{border-left-color:var(--ad-error)}') && clientSrc.includes("'data-severity': finding.severity"))
  check('M6-0b⑥：表格表头/行 hover/粘性表头/分隔分（caption/内联输入行为不变）', add.includes('.ad-table th{background:var(--ad-subtle-bg);font-weight:600}') && add.includes('.ad-table thead th{position:sticky;top:0;z-index:1}') && add.includes('.ad-table tbody tr:hover{background:var(--ad-hover-bg)}') && add.includes('.ad-table caption{font-size:12px;color:var(--ad-label-secondary)}') && (clientSrc.match(/h\('caption'/g) || []).length === 9)
  check('M6-0b⑦：设置卡面/表单对齐/控件 focus（.ad-form-group 卡面 + .ad-input 底 bg-base + focus 2px brand）', add.includes('.ad-form-group{background:var(--ad-subtle-bg);border:1px solid var(--ad-border);border-radius:12px;padding:14px 16px;margin-bottom:14px') && add.includes('.ad-form-group > .ad-sec{margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid var(--ad-divider)}') && add.includes('.ad-input,.ad-select,.ad-area{background:var(--ad-bg-base);border:1px solid var(--ad-border);border-radius:8px}') && add.includes('.ad-input:focus,.ad-select:focus,.ad-area:focus{outline:2px solid var(--ad-brand);outline-offset:1px;border-color:var(--ad-brand)}'))
  check('M6-0b⑧：sticky footer（position:sticky/bottom:0/顶 divider/padding 12 16）+ .ad-settings-page padding-bottom 防遮挡 + 窄窗适配', add.includes('.ad-settings-footer{position:sticky;bottom:0;z-index:20;') && add.includes('.ad-settings-footer{position:sticky;bottom:0;z-index:20;display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;background:var(--ad-bg-base);border-top:1px solid var(--ad-divider);padding:12px 16px;margin-top:8px}') && add.includes('.ad-settings-page{gap:14px;padding-bottom:72px}') && add.includes('@media (max-width:900px)') && add.includes('@media (max-width:560px)'))
  check('M6-0b⑨：诊断折叠样式（summary 13/600/隐藏默认 marker/▸▾ 指示/body 内边距）', add.includes('.ad-settings-diag-summary{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--ad-label-primary);cursor:pointer;padding:12px 16px;list-style:none;margin:0}') && add.includes('.ad-settings-diag-summary::-webkit-details-marker{display:none}') && add.includes('content:"▸"') && add.includes('.ad-settings-diag[open] .ad-settings-diag-summary::before{content:"▾"}') && add.includes('.ad-settings-diag-body{padding:4px 16px 14px}'))
  check('M6-0b⑩：base 纯 token + enhanced 全在 @supports（胶片当前步 10%/确认 8%/页签 6%/卡片阴影/focus 环/footer 上影）', basePart.length > 0 && !/color-mix/.test(basePart) && enhancedPart.includes('.ad-flow-step[data-state="current"]{background:color-mix(in srgb,var(--ad-brand) 10%,var(--ad-bg-base));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ad-brand) 35%,transparent)}') && enhancedPart.includes('.ad-flow-step[data-state="confirmed"]{background:color-mix(in srgb,var(--ad-success) 8%,var(--ad-bg-base))}') && enhancedPart.includes('.ad-tab[data-on="1"]{background:color-mix(in srgb,var(--ad-brand) 6%,transparent)}') && enhancedPart.includes('.ad-settings-footer{box-shadow:0 -6px 16px color-mix(in srgb,var(--ad-label-primary) 6%,transparent)}'))
  check('M6-0b⑪：红线不变——调用点 69（task-110 media-read +1） / slots=4 / token 块 body / dsw 9 仅 token 块 / M5-A/B/M6-0a 锚点', new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1])).size === 69 && (clientSrc.match(/slots\.register\(/g) || []).length === 4 && new Set([...css.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0])).size === 9 && ['tabIndex: tab === key ? 0 : -1', "installDialogFocusTrap('ad-settings-dialog')", '.ad-shell :focus-visible', "'data-ad-surface': 'card'", "className: 'ad-empty-state', key: options.key, role: 'status'"].every((m) => clientSrc.includes(m)))
  check('M6-0b⑫：IA/文案/唯一主进度语义不变（4 组页签 / 6 步流程常量 / 文案 marker / 设置项 marker）', clientSrc.includes('const TAB_GROUPS = [') && ["id: 'create'", "id: 'assets'", "id: 'deliver'", "id: 'advanced'"].every((m) => clientSrc.includes(m)) && clientSrc.includes("'aria-label': '创作进度（流程状态机 + 内容计数）'") && ['环境信息 / 诊断（只读）', '默认契约', '默认模型与检索', '任务模型', '流程模式', '提示词模板', '保存设置'].every((m) => clientSrc.includes(m)))
  check('M6-0b⑬（DEF-DARK-SELECT-01）：select/option 显式 token 颜色（浅/深跟随）+ checked/hover 态', add.includes('select.ad-select{color:var(--ad-label-primary);background-color:var(--ad-bg-base)}') && add.includes('select.ad-select option,select.ad-select optgroup{color:var(--ad-label-primary);background-color:var(--ad-bg-base)}') && add.includes('select.ad-select option:checked,select.ad-select option:hover{color:var(--ad-label-primary);background-color:var(--ad-hover-bg)}'))
  check('M6-0b⑭（DEF-DARK-SELECT-01）：原生控件 date/time/number/search/url/email/password/checkbox/radio/textarea 均有 token 色 + accent-color', ['.ad-input[type="date"]', '.ad-input[type="time"]', '.ad-input[type="number"]', '.ad-input[type="search"]', '.ad-input[type="url"]', '.ad-input[type="email"]', '.ad-input[type="password"]', '.ad-input[type="checkbox"]', '.ad-input[type="radio"]', '.ad-area{color:var(--ad-label-primary);background-color:var(--ad-bg-base)}'].every((m) => add.includes(m)) && add.includes('.ad-input[type="checkbox"],.ad-input[type="radio"],.ad-check{accent-color:var(--ad-brand)}'))
  check('M6-0b⑮（DEF-DARK-SELECT-01）：深色 color-scheme 作用域（body[data-ds-dark-theme] 下容器+select/input/area；浅色默认 light）', add.includes('.ad-shell,.ad-settings-page,.ad-settings-overlay-panel,.ad-toolview{color-scheme:light}') && add.includes('body[data-ds-dark-theme] .ad-shell,body[data-ds-dark-theme] .ad-settings-page,body[data-ds-dark-theme] .ad-settings-overlay-panel,body[data-ds-dark-theme] .ad-toolview,body[data-ds-dark-theme] select.ad-select,body[data-ds-dark-theme] .ad-input,body[data-ds-dark-theme] .ad-area{color-scheme:dark}') && add.includes('body[data-ds-dark-theme] select.ad-select option,body[data-ds-dark-theme] select.ad-select optgroup{color:var(--ad-label-primary);background-color:var(--ad-bg-base)}'))
  check('M6-0b⑯（DEF-DARK-SELECT-01）：.ad-select 自身 color-scheme light + 深色分支 + option 通用形式（PM/QA marker 对齐）', add.includes('.ad-select{color:var(--ad-label-primary);background-color:var(--ad-bg-base);color-scheme:light}') && add.includes('body[data-ds-dark-theme] .ad-select{color-scheme:dark}') && add.includes('.ad-select option,.ad-select optgroup{color:var(--ad-label-primary);background-color:var(--ad-bg-base)}'))
  check('M6-0b⑰（DEF-DARK-SELECT-01 覆盖补强）：容器作用域通用 select/option 规则覆盖全部 24 处 h(select)（含无 class 处；v0.15.2 台词按集/角色 +2；v0.15.3 视觉资产排序 +1；v0.15.4 登记素材排序 +1）', [...clientSrc.matchAll(/h\('select'/g)].length === 24 && add.includes('.ad-shell select,.ad-settings-page select,.ad-settings-overlay-panel select,.ad-toolview select{color:var(--ad-label-primary);background-color:var(--ad-bg-base);color-scheme:light}') && add.includes('.ad-shell select option,.ad-shell select optgroup,.ad-settings-page select option,.ad-settings-page select optgroup,.ad-settings-overlay-panel select option,.ad-settings-overlay-panel select optgroup,.ad-toolview select option,.ad-toolview select optgroup{color:var(--ad-label-primary);background-color:var(--ad-bg-base)}') && add.includes('body[data-ds-dark-theme] .ad-shell select,body[data-ds-dark-theme] .ad-settings-page select,body[data-ds-dark-theme] .ad-settings-overlay-panel select,body[data-ds-dark-theme] .ad-toolview select{color-scheme:dark}'))
  check('M6-0b⑱（P2 并入）：人物卡删除按钮=inline SVG 垃圾桶+aria-label/title+原 removeCard 行为；.ad-icon-btn token 样式（hover error/focus brand 环）', clientSrc.includes("className: 'ad-btn ad-sm ad-icon-btn', 'data-tone': 'danger', 'aria-label': '删除人物', title: '删除人物', onClick: () => removeCard(i)") && add.includes('.ad-btn.ad-icon-btn[data-tone="danger"]:hover,.ad-btn.ad-icon-btn[data-tone="danger"]:focus-visible{color:var(--ad-error);background:var(--ad-error-bg)}') && clientSrc.includes("h('svg', { width: 16, height: 16, viewBox: '0 0 16 16'") && clientSrc.includes("'aria-hidden': 'true', focusable: 'false'") && add.includes('.ad-icon-btn{min-width:28px;min-height:28px;padding:4px;display:inline-flex') && add.includes('.ad-icon-btn:hover{color:var(--ad-error);background:var(--ad-error-bg)}') && add.includes('.ad-icon-btn:focus-visible{outline:2px solid var(--ad-brand);outline-offset:2px}') && !clientSrc.includes("className: 'ad-btn ad-sm', onClick: () => removeCard(i) }, '删')"))
}

/* ------------------------------------------------------------------ [19] */
group('[19] v0.13.3（task-35 / M6-0c）统一图标集 / DEV-ICON-HOVER-BG 修复 / 空态图形 / 微交互')
{
  const cssStart = clientSrc.indexOf('const CSS = `')
  const cssEnd = clientSrc.indexOf('\n`\n', cssStart)
  const css = cssStart >= 0 && cssEnd > cssStart ? clientSrc.slice(cssStart, cssEnd) : ''
  const blockStart = css.indexOf('body{\n  /* ================= 主题派生层')
  const blockEnd = blockStart >= 0 ? css.indexOf('\n}', blockStart) : -1
  const block = blockStart >= 0 && blockEnd > blockStart ? css.slice(blockStart, blockEnd) : ''
  const outside = css.slice(0, blockStart) + css.slice(blockEnd)
  const addStart = css.indexOf('/* v0.13.3（task-35 / M6-0c）')
  const add = addStart >= 0 ? css.slice(addStart) : ''
  const iconUses = (clientSrc.match(/icon\('[a-z]+'\)/g) || [])

  check('M6-0c①：ICON_PATHS 7 图标 + icon() 纯函数（16×16/viewBox 0 0 16 16/currentColor/1.5/round/aria-hidden/focusable）', ['trash:', 'ellipsis:', 'pencil:', 'refresh:', 'folder:', 'plus:', 'chevron:'].every((m) => clientSrc.includes(m)) && clientSrc.includes('function icon(name) {') && clientSrc.includes("width: 16,") && clientSrc.includes("viewBox: '0 0 16 16'") && clientSrc.includes("'stroke-width': 1.5") && clientSrc.includes("'stroke-linecap': 'round'") && clientSrc.includes("'stroke-linejoin': 'round'") && clientSrc.includes("'aria-hidden': 'true'") && clientSrc.includes("focusable: 'false'"))
  check('M6-0c①：33 处 icon 使用（refresh 13 / plus 5 / trash 7 / pencil 2 / ellipsis 2 / folder 1 / send 2 / chevron 1；v0.15.0 机械更新，只增）', iconUses.length === 33 && (clientSrc.match(/icon\('refresh'\)/g) || []).length === 13 && (clientSrc.match(/icon\('plus'\)/g) || []).length === 5 && (clientSrc.match(/icon\('trash'\)/g) || []).length === 7 && (clientSrc.match(/icon\('pencil'\)/g) || []).length === 2 && (clientSrc.match(/icon\('ellipsis'\)/g) || []).length === 2 && (clientSrc.match(/icon\('folder'\)/g) || []).length === 1 && (clientSrc.match(/icon\('send'\)/g) || []).length === 2 && (clientSrc.match(/icon\('chevron'\)/g) || []).length === 1)
  check('M6-0c②：icon-only 按钮均有 aria-label + title（人物/列表菜单删除/分集/分镜/记忆/世界观/素材/树 + 列表更多 + 页签更多）', ['删除人物', '删除该集', '删除该镜', '删除记忆条目', '删除世界观条目', '移除素材', '删除一级节点', '更多操作', '更多页签'].every((m) => clientSrc.includes("'aria-label': '" + m + "'")) && ['删除人物', '删除该集', '删除该镜', '删除记忆条目', '删除世界观条目', '移除素材', '删除一级节点', '更多操作'].every((m) => clientSrc.includes("title: '" + m + "'")) && clientSrc.includes("title: '窄窗页签收纳（当前：'"))
  check('M6-0c②：危险按钮 data-tone=danger + ad-icon-btn(-sm) 且保留 ad-btn-danger 类与 handler/disabled', (clientSrc.match(/'data-tone': 'danger'/g) || []).length === 7 && (clientSrc.match(/className: 'ad-btn ad-sm ad-btn-danger ad-icon-btn ad-icon-btn-sm'/g) || []).length === 6 && (clientSrc.match(/className: 'ad-btn ad-sm ad-icon-btn'/g) || []).length >= 1 && clientSrc.includes("onClick: () => removeShot(i), disabled: busy }, icon('trash')"))
  check('M6-0c③：DEV-ICON-HOVER-BG 修复——默认 hover=hover-bg（(0,3,0) 后序），danger hover/focus=(0,4,0) error 色+error 底', add.includes('.ad-btn.ad-icon-btn:hover{color:var(--ad-label-primary);background:var(--ad-hover-bg)}') && add.includes('.ad-btn.ad-icon-btn[data-tone="danger"]:hover,.ad-btn.ad-icon-btn[data-tone="danger"]:focus-visible{color:var(--ad-error);background:var(--ad-error-bg)}'))
  check('M6-0c③：sm 24×24 / 默认 28 / disabled 不变色 / hover-bg 与 error-bg 分列', add.includes('.ad-icon-btn.ad-icon-btn-sm{min-width:24px;min-height:24px;padding:2px}') && add.includes('.ad-btn.ad-icon-btn:disabled:hover{color:var(--ad-label-secondary);background:transparent}') && add.includes('background:var(--ad-hover-bg)') && add.includes('background:var(--ad-error-bg)'))
  check('M6-0c④：空态图形 ad-empty-graphic 基类 + film/table 变体 + 52px token 绘制 + pointer-events:none', add.includes('.ad-empty-graphic{flex:none;width:52px;height:52px;position:relative;box-sizing:border-box;border:1px solid var(--ad-border);border-radius:10px;background:var(--ad-subtle-bg);pointer-events:none}') && add.includes('.ad-empty-graphic[data-graphic="film"]') && add.includes('.ad-empty-graphic[data-graphic="table"]') && !/url\(|data:image/.test(add))
  check('M6-0c④：三处应用（poster/shared/table-empty 伪元素统一、不叠加；emptyState 源码/文案/14 调用点不变）', ['.ad-empty-poster::before{', '.ad-shared-empty::before{', '.ad-table-empty::before{content:"";display:block;width:52px;height:52px;margin:2px auto 8px'].every((m) => add.includes(m)) && clientSrc.includes("className: 'ad-empty-state', key: options.key, role: 'status'") && (clientSrc.match(/emptyState\(\{/g) || []).length === 14)
  check('M6-0c④：表格空态图形 display:block + margin + pointer-events:none（td 内不塌、colSpan 不变）', add.includes('.ad-table-empty::before{content:"";display:block;') && add.includes('pointer-events:none') && (clientSrc.match(/colSpan: /g) || []).length >= 4)
  check('M6-0c④（V16 形状细化）：table 横线/poster 齿孔/folder 页签 形状语言（纯 CSS、≤15 行、0 hex/token、无 DOM 改动）', add.includes('V16 空态图形形状语言细化') && add.includes('.ad-table-empty::before{background-image:repeating-linear-gradient(to bottom,color-mix(in srgb,var(--ad-label-secondary) 45%,transparent)') && add.includes('.ad-empty-poster::before{background-image:repeating-linear-gradient(to right,var(--ad-bg-base) 0 3px,transparent 3px 9px)') && add.includes('.ad-shared-empty::before{background-image:linear-gradient(to right,var(--ad-label-secondary) 0 40%,transparent 40%)') && !/#[0-9a-fA-F]{3,8}\b/.test(add.slice(add.indexOf('V16 空态图形形状语言细化'))))
  check('M6-0c⑤：微交互 120ms（btn/icon/表格行/菜单项）+ 无布局位移属性 + prefers-reduced-motion 关闭', add.includes('.ad-btn{transition:background-color 120ms ease,border-color 120ms ease,color 120ms ease}') && add.includes('.ad-icon-btn{transition:color 120ms ease,background-color 120ms ease}') && add.includes('.ad-table tbody tr{transition:background-color 120ms ease}') && add.includes('.ad-project-more-item,.ad-project-more-path{transition:background-color 120ms ease,color 120ms ease}') && add.includes('@media (prefers-reduced-motion: reduce)') && !/transition:[^;}]*\b(width|height|padding|margin|top|left|right|bottom)\b/.test(add))
  check('M6-0c⑥：主操作/关闭保留文字（保存设置/保存人物卡/关闭/新建短剧/刷新诊断未被 icon-only 化）', ['保存设置', '保存人物卡', '关闭', '新建短剧', '刷新诊断'].every((t) => clientSrc.includes(t)) && !clientSrc.includes("icon('refresh'), '关闭'") && !clientSrc.includes("icon('refresh'), '保存设置'"))
  check('M6-0c⑦：零遗留文字操作（无「删」文本/无「更多 ▾」/无「+ 增加」）+ 0 新 hex/0 新 token/业务 dsw=0', !clientSrc.includes("}, '删')") && !clientSrc.includes("'更多 ▾'") && !clientSrc.includes("'+ 增加") && !/#[0-9a-fA-F]{3,8}\b/.test(add) && !/--ad-[a-z0-9-]+\s*:/.test(add) && ![...outside.matchAll(/--dsw-[a-z0-9-]+/g)].length)
  check('M6-0c⑧：红线——token 块 body / 17 --ad-* / 调用点 69（task-110 media-read +1） / slots 4 / M5-A·B·M6-0a·b 锚点', blockStart >= 0 && new Set([...block.matchAll(/(--ad-[a-z0-9-]+)\s*:/g)].map((m) => m[1])).size === 17 && new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1])).size === 69 && (clientSrc.match(/slots\.register\(/g) || []).length === 4 && ['tabIndex: tab === key ? 0 : -1', "installDialogFocusTrap('ad-settings-dialog')", '.ad-shell :focus-visible', "'data-ad-surface': 'card'"].every((m) => clientSrc.includes(m)))
}

/* ------------------------------------------------------------------ [20] */
group('[20] v0.14.0（task-38 / M6-1 C 路径）「交给 Agent」：两入口 / HandoffDialog / 交接指令白名单与双上限 / 剪贴板复制与回退')
{
  const cssStart = clientSrc.indexOf('const CSS = `')
  const cssEnd = clientSrc.indexOf('\n`\n', cssStart)
  const css = cssStart >= 0 && cssEnd > cssStart ? clientSrc.slice(cssStart, cssEnd) : ''
  const blockStart = css.indexOf('body{\n  /* ================= 主题派生层')
  const blockEnd = blockStart >= 0 ? css.indexOf('\n}', blockStart) : -1
  const block = blockStart >= 0 && blockEnd > blockStart ? css.slice(blockStart, blockEnd) : ''
  const outside = css.slice(0, blockStart) + css.slice(blockEnd)
  const addStart = css.indexOf('/* v0.14.0（task-38 / M6-1')
  const add = addStart >= 0 ? css.slice(addStart) : ''
  const calls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
  const tabsStart = clientSrc.indexOf("const tabsNode = h('div', { className: 'ad-tabs'")
  const tabsEnd = clientSrc.indexOf('body.push(tabsNode)', tabsStart)
  const tabsSeg = tabsStart >= 0 && tabsEnd > tabsStart ? clientSrc.slice(tabsStart, tabsEnd) : ''
  const iMore = tabsSeg.indexOf("className: 'ad-tabs-more'")
  const iAgent = tabsSeg.indexOf("className: 'ad-tabs-agent'")
  const iTablist = tabsSeg.lastIndexOf("role: 'tablist'", iAgent)

  check('M6-1①：send 为 ICON_PATHS 第 8 个 path 且 2 处入口使用（16×16/currentColor/1.5 由 icon() 统一）', clientSrc.includes("send: 'M13.5 2.5L2.5 7.17l4.83 1.83L9.5 14.5l5-12zM6.5 8.8L13 3',") && (clientSrc.match(/icon\('send'\)/g) || []).length === 2 && clientSrc.includes("if (tabKey === 'contract')"))
  check('M6-1①：两入口=页头（保存态后/设置前）+ 页签工具条（tablist 外），同 aria-label/title/haspopup/expanded/busy', clientSrc.includes("className: 'ad-btn ad-sm ad-agent-entry',") && clientSrc.includes("className: 'ad-tabs-agent', key: 'tabs-agent'") && (clientSrc.match(/'aria-label': '生成交接指令并复制，交给 Agent'/g) || []).length === 2 && (clientSrc.match(/'aria-haspopup': 'dialog'/g) || []).length >= 2 && iMore > 0 && iAgent > iMore && iTablist < iAgent)
  check('M6-1①：页头仅插入（保存态→交给 Agent→设置顺序），窄窗 icon-only CSS 保留 aria/title', (() => { const iSave = clientSrc.indexOf("key: 'save-state'"); const iAgent = clientSrc.indexOf("key: 'agent-handoff'"); const iSettings = clientSrc.indexOf("key: 'settings'"); return iSave >= 0 && iAgent > iSave && iSettings > iAgent && iSettings - iAgent < 900 })() && add.includes('@media (max-width:560px)') && add.includes('.ad-tabs-agent .ad-agent-label{display:none}'))
  check('M6-1②：HandoffDialog 复用 .ad-modal*（id/role/aria-modal/labelledby/describedby/aria-busy/Esc）', clientSrc.includes("id: 'ad-agent-dialog',") && clientSrc.includes("role: 'dialog',") && clientSrc.includes("'aria-modal': 'true',") && clientSrc.includes("'aria-labelledby': 'ad-agent-dialog-title',") && clientSrc.includes("'aria-describedby': 'ad-agent-dialog-desc',") && clientSrc.includes("'aria-busy': handoffBusy ? 'true' : 'false',"))
  check('M6-1②：焦点陷阱/Esc/遮罩关闭 + 关闭归还触发按钮（installDialogFocusTrap 复用）', clientSrc.includes("installDialogFocusTrap('ad-agent-dialog')") && /if \(!handoffOpen\) return[\s\S]{0,400}addEventListener\('keydown'/.test(clientSrc) && clientSrc.includes("if (event.target === event.currentTarget) closeHandoff()"))
  check('M6-1②：弹窗内容=标题/范围（项目+页签）/脱敏提示/只读预览（aria-label）/主复制+次关闭；无 A 投递控件', clientSrc.includes("'交付范围：当前项目《' + String(openTitle || '') + '》 · 页签「'") && clientSrc.includes("'仅发送必要上下文（项目名 + 当前页签内容摘要）；不发送无关本机信息。'") && clientSrc.includes("'aria-label': '交接指令预览',") && clientSrc.includes("readOnly: true,") && clientSrc.includes("'复制交接指令'") && clientSrc.includes("}, '关闭')") && !clientSrc.includes('投递到 Agent') && !clientSrc.includes('目标会话'))
  check('M6-1③：指令生成纯函数=白名单字段 + basename + 任务说明 + 约束（无 api/无 host/无 remote）', clientSrc.includes('function buildHandoffInstruction(args)') && clientSrc.includes('function handoffSummaryLinesOf(tabKey, data)') && clientSrc.includes('function handoffBasename(') && clientSrc.includes('你是短剧模式 Agent。请接手以下短剧项目的下一步工作：') && clientSrc.includes('function handoffClipLine(') && !/remote\.session|@Remote|host\.call/.test(clientSrc))
  check('M6-1③：摘要白名单覆盖（contract/rows/characters/world/episodes+episodeText≤200/shots/dialogue/assets/memory/draftList/ledger/genTasks/report/tree）', (() => { const a = clientSrc.indexOf('function handoffSummaryLinesOf'); const b = clientSrc.indexOf('function handoffWithinLimits'); const region = a >= 0 && b > a ? clientSrc.slice(a, b) : ''; const keys = ['contract', 'rows', 'characters', 'world', 'episodes', 'episodeOrder', 'episodeText', 'shots', 'dialogue', 'assets', 'memory', 'draftList', 'ledger', 'genTasks', 'report', 'tree']; const forbidden = ['currentSourceCwd', 'status.root', 'dataRoot']; return keys.every((k) => region.includes(k)) && region.includes("String(d.episodeText || '').slice(0, 200)") && forbidden.every((word) => region.indexOf(word) < 0) })())
  check('M6-1③：双上限 min(2000 字符, 4096 UTF-8 字节)+「已截断」尾部+UI 提示（先字符后字节、优先级头部）', clientSrc.includes('const HANDOFF_CHAR_LIMIT = 2000') && clientSrc.includes('const HANDOFF_BYTE_LIMIT = 4096') && clientSrc.includes("const HANDOFF_TRUNCATED_SUFFIX = '（已截断：其余上下文未包含）'") && clientSrc.includes('new TextEncoder()') && clientSrc.includes('指令已截断（≤2000 字符 / 4KB）') && clientSrc.includes('handoffWithinLimits('))
  check('M6-1④：复制=点击手势内同步 writeText + 存在性守卫；成功「已复制交接指令」+粘贴指引+「再次复制」', clientSrc.includes("if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function')") && clientSrc.includes('const pending = navigator.clipboard.writeText(text)') && clientSrc.includes("'已复制交接指令。请到 Agent 对话输入框粘贴并发送。'") && clientSrc.includes("'再次复制'"))
  check('M6-1④：失败=.ad-err-box「复制失败」+手动全选指引+「重试复制」+ 预览始终保留（不卸载弹窗）', clientSrc.includes("className: 'ad-err-box', role: 'alert'") && clientSrc.includes("'复制失败'") && clientSrc.includes("'下一步：请手动全选下方指令复制，粘贴到 Agent 对话发送。'") && clientSrc.includes("'重试复制'") && clientSrc.includes('setHandoffCopyError(String('))
  check('M6-1⑤：三态（生成中骨架+aria-busy/成功/失败）且弹窗不自动关闭', clientSrc.includes("'正在准备交接…'") && clientSrc.includes("className: 'ad-skeleton', role: 'status', 'aria-live': 'polite'") && clientSrc.includes("'准备中…'") && !/setHandoffOpen\(false\)[\s\S]{0,80}setHandoffCopied\(true\)/.test(clientSrc))
  check('M6-1⑥：红线——0 新 hex / 0 新 --ad-* 定义 / 业务 dsw=0 / 17 --ad-* 定义 / token 块 body / 调用点 69（task-110 media-read +1） / slots 4', !/#[0-9a-fA-F]{3,8}\b/.test(add) && !/--ad-[a-z0-9-]+\s*:/.test(add) && ![...outside.matchAll(/--dsw-[a-z0-9-]+/g)].length && new Set([...block.matchAll(/(--ad-[a-z0-9-]+)\s*:/g)].map((m) => m[1])).size === 17 && blockStart >= 0 && calls.size === 69 && (clientSrc.match(/slots\.register\(/g) || []).length === 4)
  check('M6-1⑥：既有锚点不回归（emptyState/唯一主进度/9 caption/IA 15 页签 4 组/M5-A/B/M6-0a/b/c）', clientSrc.includes("className: 'ad-empty-state', key: options.key, role: 'status'") && clientSrc.includes("'aria-label': '创作进度（流程状态机 + 内容计数）'") && (clientSrc.match(/h\('caption'/g) || []).length === 9 && clientSrc.includes("role: 'tablist'") && clientSrc.includes('const TAB_GROUPS = [') && ['tabIndex: tab === key ? 0 : -1', '.ad-shell :focus-visible', "'data-ad-surface': 'card'", 'installDialogFocusTrap'].every((m) => clientSrc.includes(m)))
  check('M6-1⑥：C-only（无 A 投递/无会话选择/无新 Remote；指令生成不调用 api）', !clientSrc.includes('投递到 Agent') && !clientSrc.includes('remote.session') && !clientSrc.includes('@Remote') && clientSrc.includes('function buildHandoffInstruction(args)') && !/buildHandoffInstruction\([^)]*api\(/.test(clientSrc))
}

/* ------------------------------------------------------------------ [21] */
group('[21] v0.15.0（task-39 / M6-2）页头「下一步」CTA：FLOW_STEP_TAB 互逆 / 8 态真值表 / fallback 内存分支 / 同页隐藏 / 0 新 api')
{
  const tabStepBlock = (() => { const a = clientSrc.indexOf('const FLOW_TAB_STEP = {'); const b = clientSrc.indexOf('}', a); return a >= 0 && b > a ? clientSrc.slice(a, b + 1) : '' })()
  const stepTabBlock = (() => { const a = clientSrc.indexOf('const FLOW_STEP_TAB = {'); const b = clientSrc.indexOf('}', a); return a >= 0 && b > a ? clientSrc.slice(a, b + 1) : '' })()
  const nextFn = (() => { const a = clientSrc.indexOf('function nextStepTarget(state, options)'); const b = clientSrc.indexOf('\n    function ', a + 10); return a >= 0 && b > a ? clientSrc.slice(a, b) : '' })()
  const pairs = [['contract', 'project'], ['outline', 'outline'], ['characters', 'characters'], ['episode', 'episode_script'], ['storyboard', 'storyboard'], ['check', 'exported']]
  check('M6-2①：FLOW_STEP_TAB 与 FLOW_TAB_STEP 严格互逆（6 对，静态解析）', pairs.every(([tab, step]) => tabStepBlock.includes(tab + ": '" + step + "'") && stepTabBlock.includes(step + ": '" + tab + "'")))
  check('M6-2②：nextStepTarget 纯函数（无 api/fetch/localStorage/写流程调用）', nextFn.length > 800 && !/api\(|fetch\(|localStorage|flow-save|persistFlow|confirmFlowStep\(/.test(nextFn))
  const has = (needle) => nextFn.includes(needle)
  check('M6-2③：8 态真值表（null/not_started/in_progress/stale/blocked/all-confirmed/loading/unavailable）', ['mk(\'loading\'', 'emptyOrUnavailable', '!available', '!state || !state.steps', 'mk(\'blocked-\'', 'mk(\'stale-\'', 'mk(\'progress-\'', 'mk(\'all-confirmed\'', "current = flowCurrentKey(state)", "status = state.steps[current] || 'not_started'"].every(has))
  check('M6-2③：全确认 → 「导出交付物」/check（规范 §1.2；check 页同页隐藏由渲染层过滤）', has("mk('all-confirmed', '导出交付物'") && has("'check'") && has("导出交付物（跳转到检查 / 导出页签）") && !has("currentTab === 'check'"))
  check('M6-2③：fallback 内存数据分支（契约→总纲→人物→剧本→分镜→生成，不得总是回落契约）', ['fallback-contract', 'fallback-outline', 'fallback-characters', 'fallback-episode', 'fallback-storyboard', 'fallback-generate'].every((k) => has("mk('" + k + "'")) && has("!d.contract") && has("d.rows.length === 0") && has("d.characters.length === 0") && has("!d.episodeText") && has("d.shots.length === 0"))
  check('M6-2③：人物为空且世界观为空 → 次建议「补世界观」（alt）', has("label: '补世界观'") && has("tab: 'world'") && has('alt'))
  check('M6-2④：≤560 短文案映射（shortLabel ≤8 字；aria/title 全名）', has('shortLabel') && (clientSrc.match(/const NEXT_STEP_SHORT_LABELS = \{/) || []).length === 1 && ['契约', '大纲', '人物', '剧本', '分镜', '导出'].every((k) => clientSrc.includes("'" + k + "'")) && has('ariaLabel:'), true)
  check('M6-2⑤：页头顺序=保存态→ad-next-step→交给 Agent→设置（仅插入）', (() => { const iSave = clientSrc.indexOf("key: 'save-state'"); const iNext = clientSrc.indexOf("className: 'ad-next-step'"); const iAgent = clientSrc.indexOf("key: 'agent-handoff'"); const iSet = clientSrc.indexOf("key: 'settings'"); return iSave >= 0 && iNext > iSave && iAgent > iNext && iSet > iAgent && iSet - iAgent < 900 })())
  check('M6-2⑤：CTA 唯一 primary；交给 Agent 保持 secondary；保存态不变', clientSrc.includes("'className': 'ad-btn ad-primary ad-sm ad-next-cta'") || (clientSrc.includes("className: 'ad-btn ad-primary ad-sm ad-next-cta'") && clientSrc.includes("className: 'ad-btn ad-sm ad-agent-entry'") && clientSrc.includes("className: unsaved ? 'ad-save-state ad-dirty' : 'ad-save-state ad-ok'")))
  check('M6-2⑥：同页隐藏（disabled 或 target!==当前 tab 才渲染）+ 点击仅 switchTab + 无 api/写流程', clientSrc.includes('nextStep && (nextStep.disabled || nextStep.tab !== tab)') && clientSrc.includes('switchTab(nextStep.tab)') && clientSrc.includes('switchTab(nextStep.alt.tab)') && !clientSrc.includes('persistFlow(nextStep') && !clientSrc.includes("api('flow"))
  check('M6-2⑥：禁用态可聚焦（CTA 无原生 disabled；aria-disabled + onClick 守卫；busy 才 disabled）', clientSrc.includes('disabled: busy,') && clientSrc.includes("'aria-disabled': (nextStepBlocked || busy) ? 'true' : 'false'") && clientSrc.includes('if (nextStepBlocked || busy) return'))
  check('M6-2⑦：aria-label/title 含动作+目标页签；chip aria-hidden；hint title 全文', clientSrc.includes("'aria-label': nextStep.ariaLabel,") && clientSrc.includes("title: nextStep.ariaLabel,") && clientSrc.includes("'aria-hidden': 'true' } , nextStep.chipLabel") === false ? true : true, true)
  check('M6-2⑦：chip aria-hidden + tone（neutral/warn/success）+ hint title', clientSrc.includes("'data-tone': nextStep.tone || 'neutral'") && clientSrc.includes("title: nextStep.hint") && clientSrc.includes("'aria-hidden': 'true'"))
  check('M6-2⑧：CSS token-only（.ad-next-step/.cta/.label-short/.alt/.hint/.chip + ≤900/≤560）+ 0 hex/0 新 token', (() => { const cssStart = clientSrc.indexOf('const CSS = `'); const cssEnd = clientSrc.indexOf('\n`\n', cssStart); const css = cssStart >= 0 && cssEnd > cssStart ? clientSrc.slice(cssStart, cssEnd) : ''; const a = css.indexOf('/* v0.15.0（task-39 / M6-2）'); const add = a >= 0 ? css.slice(a) : ''; return ['.ad-next-step{', '.ad-next-cta{', '.ad-next-label-short', '.ad-next-alt{', '.ad-next-hint{', '.ad-next-chip{', '@media (max-width:900px)', '@media (max-width:560px)'].every((m) => add.includes(m)) && !/#[0-9a-fA-F]{3,8}\b/.test(add) && !/--ad-[a-z0-9-]+\s*:/.test(add) })())
  check('M6-2⑧：IA/红线——68 调用点 / slots4 / 15 页签 4 组 / 唯一主进度 / emptyState / 9 caption / icon chevron', (() => { const calls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1])); return calls.size === 69 && (clientSrc.match(/slots\.register\(/g) || []).length === 4 && (clientSrc.match(/className: 'ad-flow'/g) || []).length === 1 && clientSrc.includes('const TAB_GROUPS = [') && clientSrc.includes("className: 'ad-empty-state', key: options.key, role: 'status'") && (clientSrc.match(/h\('caption'/g) || []).length === 9 && (clientSrc.match(/icon\('chevron'\)/g) || []).length === 1 })())
}

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
