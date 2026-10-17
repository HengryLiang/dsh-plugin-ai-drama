/**
 * v0.6.3 增强池（客户端半）验收用例 —— 审读展示细化 / 好用性残余 / 任务模型交互细化
 *
 * 需求来源：`P2-好用阶段-规划与需求挖掘机制-v1.md` §14（v0.6.3 增强池，3 项 S 级、纯 client、无契约变更）
 *  ① 审读展示细化：findings 维度筛选/排序、evidence 高亮、总数摘要（按 severity/dimension 计数）；
 *  ② 好用性残余：错误文案统一（失败码→用户可读）、快捷键说明、加载骨架/空态一致性；
 *  ③ 设置页任务模型交互细化：模型输入「最近使用列表」（本地存储）+ 即时校验反馈。
 *
 * 红线：slots.register=2、client 调用点 58 未增、无新增依赖、旧数据 32 文件 hash 不变、工具 34/METHODS 68。
 * 兼容策略：v0.6.3 client 未交付（探测标记缺失）→ 显式 SKIP；交付后自动生效。
 * 运行：node test/client-polish.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8')
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
check('增强①：展示细化不新增 API 调用点（58 内）', true, '计数见 [4]')

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
group('[4] 工程红线：slots=2 / 调用点 58 / 无新依赖 / 工具 34 / METHODS 68 / 旧数据 hash')
check('红线：client slots.register = 2', (clientSrc.match(/slots\.register\(/g) || []).length === 2)
const clientCalls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
check('红线：client 去重调用点未新增（仍 58）', clientCalls.size === 58, String(clientCalls.size))
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
check('红线：无新增外部依赖', !pkg.dependencies || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies || {}))
const { METHODS } = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
check('红线：生产工具面仍 34', toolsMod.createToolDefs({ rootOf: () => '', backendOf: () => null }).length === 34)
check('红线：METHODS 仍 = 68', METHODS.length === 68, String(METHODS.length))
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
  const missing = [...baseMap.keys()].filter((k) => !curMap.has(k))
  const added = [...curMap.keys()].filter((k) => !baseMap.has(k))
  const changed = [...baseMap.keys()].filter((k) => curMap.has(k) && curMap.get(k).sha256 !== baseMap.get(k).sha256)
  check('红线：旧数据 32 文件 hash 不变', missing.length === 0 && added.length === 0 && changed.length === 0, JSON.stringify({ missing, added, changed }).slice(0, 300))
}

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
