/**
 * D-10 回归门禁：34 个 drama_* 工具定义的 `parameters` + `output.schema`
 * 必须全部通过 **DSH 运行时** `@deepseek-ai/dsh-tools` 的 `assertSupportedJsonSchema()`。
 *
 * ## 为什么要有这条门禁（D-10 / 2026-10-17）
 * ai-drama 0.3.3 引入 TOOL_OUTPUTS/assetItem 重构时，`assetItem.sha256` 写成
 * `schemaObj({}, ['sha256'])` → `{type:'object', properties:{}, required:['sha256']}`，
 * `required` 里的名字不在 `properties` 中。DSH `dsh-tools` 的 `registry.register()`
 * 第一步就是 `assertSupportedJsonSchema(output.schema)`，对它抛
 * `JsonSchemaError: ... required names "sha256" which is not in properties`；
 * 主插件 `index.js` 逐工具 try/catch 把错误静默吞掉（仅 0 注册时才落
 * `drama-attach-diagnostic.json`）→ 运行期工具面 32/34（缺 `drama_list_assets` /
 * `drama_add_asset`），且所有短剧会话（含 GUI 普通会话）都受影响。
 * 本门禁在离线阶段直接调用**同一个运行时校验器**，把「schema 非法 → 注册被拒 →
 * 工具静默消失」这一整类回归挡在发布前。
 *
 * ## 运行
 *   node test/schema-guard.mjs
 *
 * ## 运行时校验器解析优先级
 *   1. `DSH_TOOLS_ENTRY=<...>/dsh-tools/lib/index.js`（显式覆盖，CI/异机推荐）
 *   2. 裸导入 `@deepseek-ai/dsh-tools`（测试文件位于已安装插件/profile 依赖链内时）
 *   3. 从 profile 的 package.json 解析（`DSH_PROFILE_DIR` / `DSH_HOME` / `~/.dsh`）
 *   4. 本机全局 npm 安装的 `@deepseek-ai/dsh` 内嵌 `dsh-tools`
 * 解析不到时显式 SKIP（退出码 0，不误报失败，与其它套件的 SKIP 约定一致）。
 *
 * 期望：`validated=34 / rejectedCount=0`；当前 D-10 未修复时应为 `rejectedCount=2`
 * （`drama_list_assets`、`drama_add_asset` 的 output.schema），修复后转 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const EXPECTED_TOOL_COUNT = 34

let passed = 0
let failed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) {
    passed += 1
  } else {
    failed += 1
    failures.push(`${label}${detail ? ' -> ' + detail : ''}`)
    console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`)
  }
}

/**
 * 解析 DSH 运行时校验器（assertSupportedJsonSchema）。
 * @returns {Promise<{ fn: ((schema: object) => void) | null, via: string | null, attempts: string[] }>}
 */
async function loadRuntimeValidator() {
  const attempts = []
  const importEntry = async (entry, via) => {
    try {
      const mod = await import(pathToFileURL(entry).href)
      if (typeof mod.assertSupportedJsonSchema === 'function') {
        return { fn: mod.assertSupportedJsonSchema, via: `${via}（${entry}）` }
      }
      attempts.push(`${via}: 模块无 assertSupportedJsonSchema 导出`)
    } catch (error) {
      attempts.push(`${via}: ${error?.code ?? error?.message ?? String(error)}`)
    }
    return null
  }

  // 1) 环境变量显式覆盖
  if (process.env.DSH_TOOLS_ENTRY) {
    const hit = await importEntry(process.env.DSH_TOOLS_ENTRY, 'DSH_TOOLS_ENTRY')
    if (hit) return { ...hit, attempts }
  }

  // 2) 裸导入
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod.assertSupportedJsonSchema === 'function') {
      return { fn: mod.assertSupportedJsonSchema, via: '裸导入 @deepseek-ai/dsh-tools', attempts }
    }
    attempts.push('裸导入: 模块无 assertSupportedJsonSchema 导出')
  } catch (error) {
    attempts.push(`裸导入: ${error?.code ?? error?.message ?? String(error)}`)
  }

  // 3) 从 profile 的 package.json 解析（DSH_PROFILE_DIR > DSH_HOME/profiles/<profile> > ~/.dsh）
  const profileBases = []
  const profileDir = (process.env.DSH_PROFILE_DIR || '').trim()
  if (profileDir) profileBases.push(path.join(profileDir, 'package.json'))
  const dshHome = (process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh')
  const profileName = (process.env.DSH_PROFILE || 'desktop').trim() || 'desktop'
  profileBases.push(path.join(dshHome, 'profiles', profileName, 'package.json'))
  for (const base of profileBases) {
    if (!fs.existsSync(path.dirname(base))) continue
    try {
      const req = createRequire(base)
      const entry = req.resolve('@deepseek-ai/dsh-tools')
      const hit = await importEntry(entry, `require.resolve(${base})`)
      if (hit) return { ...hit, attempts }
    } catch (error) {
      attempts.push(`require.resolve(${base}): ${error?.code ?? error?.message ?? String(error)}`)
    }
  }

  // 4) 本机全局 npm 安装的 dsh 内嵌包（保守兜底）
  const globalCandidates = [
    process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
      : null,
  ].filter(Boolean)
  for (const candidate of globalCandidates) {
    if (!fs.existsSync(candidate)) continue
    const hit = await importEntry(candidate, '全局 npm 安装')
    if (hit) return { ...hit, attempts }
  }

  return { fn: null, via: null, attempts }
}

const runtime = await loadRuntimeValidator()
if (!runtime.fn) {
  console.log('\n[SKIP] 无法解析 DSH 运行时 @deepseek-ai/dsh-tools 的 assertSupportedJsonSchema：')
  for (const attempt of runtime.attempts) console.log(`  - ${attempt}`)
  console.log('  可显式指定：DSH_TOOLS_ENTRY=<.../dsh-tools/lib/index.js> node test/schema-guard.mjs')
  console.log('\n结果：0 passed, 0 failed（SKIP：运行时校验器不可解析，属环境限制、非产品失败）')
  process.exit(0)
}

const { createToolDefs, DRAMA_TOOL_NAMES, TOOL_OUTPUTS } = await import(
  pathToFileURL(path.join(pluginRoot, 'lib', 'tools.js')).href
)
const defs = createToolDefs(
  { rootOf: () => path.join(os.tmpdir(), 'aidrama-schema-guard'), backendOf: () => null },
  { testTools: false },
)

/* ------------------------------------------------------------ [0] 来源 */
console.log('\n[0] 运行时校验器来源')
console.log(`  via: ${runtime.via}`)
check('运行时校验器已加载', typeof runtime.fn === 'function')

/* ------------------------------------------------- [1] 工具定义完整性 */
console.log('\n[1] 工具定义完整性（34 个生产工具）')
check('createToolDefs 返回 34 个工具', defs.length === EXPECTED_TOOL_COUNT, `实际 ${defs.length}`)
check('DRAMA_TOOL_NAMES 长度 = 34', DRAMA_TOOL_NAMES.length === EXPECTED_TOOL_COUNT, `实际 ${DRAMA_TOOL_NAMES.length}`)
const defNames = defs.map((def) => def.name)
const expectedNames = [...DRAMA_TOOL_NAMES].sort()
const actualNames = [...defNames].sort()
check(
  '定义名与 DRAMA_TOOL_NAMES 集合一致（顺序可不同，不允许重复/遗漏）',
  defNames.length === DRAMA_TOOL_NAMES.length
    && new Set(defNames).size === defNames.length
    && actualNames.length === expectedNames.length
    && expectedNames.every((name, index) => actualNames[index] === name),
  `defs=${defNames.join(',')}`,
)
check(
  'D-10 两个素材工具定义存在（drama_list_assets / drama_add_asset）',
  defNames.includes('drama_list_assets') && defNames.includes('drama_add_asset'),
)
const missingOutputs = DRAMA_TOOL_NAMES.filter((name) => !TOOL_OUTPUTS[name])
check('TOOL_OUTPUTS 覆盖全部 34 个工具（不依赖 genericOutput 兜底）', missingOutputs.length === 0, `缺 ${missingOutputs.join(',')}`)

/* --------------------------------- [2] parameters + output.schema 逐个校验 */
console.log('\n[2] parameters + output.schema 逐个调用 assertSupportedJsonSchema')
const rejectedTools = new Map()
let parameterRejected = 0
let outputRejected = 0
for (const def of defs) {
  try {
    runtime.fn(def.parameters)
    check(`${def.name}.parameters`, true)
  } catch (error) {
    parameterRejected += 1
    rejectedTools.set(def.name, `${def.name}.parameters: ${error?.message ?? error}`)
    check(`${def.name}.parameters`, false, error?.message ?? String(error))
  }

  if (!def.output || typeof def.output !== 'object' || !def.output.schema) {
    outputRejected += 1
    rejectedTools.set(def.name, `${def.name}.output.schema: 缺少 output.schema`)
    check(`${def.name}.output.schema`, false, '缺少 output.schema')
  } else {
    try {
      runtime.fn(def.output.schema)
      check(`${def.name}.output.schema`, true)
    } catch (error) {
      outputRejected += 1
      rejectedTools.set(def.name, `${def.name}.output.schema: ${error?.message ?? error}`)
      check(`${def.name}.output.schema`, false, error?.message ?? String(error))
    }
  }

  check(
    `${def.name}.output.render`,
    Boolean(def.output && typeof def.output.render === 'function'),
    'output.render 不是函数',
  )
}

/* ------------------------------------------------------------- [3] 汇总 */
const rejectedCount = rejectedTools.size
console.log('\n[3] 汇总')
console.log(`  validated=${defs.length} parametersRejected=${parameterRejected} outputRejected=${outputRejected} rejectedCount=${rejectedCount}`)
if (rejectedCount > 0) {
  console.log('  被 DSH 拒绝的工具（真机上会静默缺失 → 运行期工具面 < 34）：')
  for (const detail of rejectedTools.values()) console.log(`    · ${detail}`)
  console.log('  修复方向：让全部 output.schema/parameters 通过 assertSupportedJsonSchema（D-10：assetItem.sha256 应为字符串 schema）。')
}
check('rejectedCount = 0（34 个工具均可被 DSH registry.register 接受）', rejectedCount === 0, [...rejectedTools.keys()].join(','))

console.log(`\n结果：${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
