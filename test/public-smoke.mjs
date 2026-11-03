/**
 * 公开仓库结构 smoke 测试（不依赖作者本机夹具，可在任意机器 / CI 运行）。
 * 覆盖：包契约、入口语法、组合树引用、客户端 bundle id、随包技能与规则、内部路径泄漏、运行时导出。
 * 运行：node test/public-smoke.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

let passed = 0
let failed = 0
const failures = []
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}${detail ? ` -> ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`)
  }
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const exists = (rel) => fs.existsSync(path.join(root, rel))

console.log('\n[1] 包契约')
const pkg = JSON.parse(read('package.json'))
check('包名 dsh-plugin-ai-drama', pkg.name === 'dsh-plugin-ai-drama', pkg.name)
check('版本为 SemVer', /^\d+\.\d+\.\d+$/.test(String(pkg.version)), pkg.version)
check('license = MIT', pkg.license === 'MIT', String(pkg.license))
check('未声明 private', pkg.private !== true)
check('dsh.manifestVersion = 1', pkg.dsh && pkg.dsh.manifestVersion === 1)
check('dsh.bundle.patch 为数组', Array.isArray(pkg.dsh?.bundle?.patch) && pkg.dsh.bundle.patch.length >= 2, JSON.stringify(pkg.dsh?.bundle?.patch))
for (const patch of pkg.dsh?.bundle?.patch || []) {
  const rel = String(patch).replace(/^\.\//, '')
  check(`补丁文件存在：${rel}`, exists(rel))
}
check('客户端面 platform = web', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform))
check('client.inject 含布局与侧栏', Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length >= 2, JSON.stringify(pkg.dsh?.client?.inject))
check('Node engines 已声明', typeof pkg.engines?.node === 'string', String(pkg.engines?.node))
check('官方包走 peerDependencies', pkg.peerDependencies?.['@deepseek-ai/dsh-skill-filesystem'] !== undefined && Object.keys(pkg.dependencies || {}).length === 0)

console.log('\n[2] 入口与语法')
for (const entry of ['index.js', 'client.js', 'preset.js']) {
  check(`${entry} 存在`, exists(entry))
  const result = spawnSync(process.execPath, ['--check', entry], { cwd: root, encoding: 'utf8' })
  check(`${entry} 语法检查`, result.status === 0, (result.stderr || '').slice(0, 160))
}
const indexMod = await import(pathToFileURL(path.join(root, 'index.js')).href)
check('index 导出 apply 函数', typeof indexMod.apply === 'function')
check('index 导出 METHODS 数组', Array.isArray(indexMod.METHODS) && indexMod.METHODS.length >= 60, String(indexMod.METHODS?.length))
check('index 导出 inject 数组', Array.isArray(indexMod.inject))
const toolsMod = await import(pathToFileURL(path.join(root, 'lib', 'tools.js')).href)
check('工具清单非空且含核心工具', Array.isArray(toolsMod.DRAMA_TOOL_NAMES) && toolsMod.DRAMA_TOOL_NAMES.includes('drama_export') && toolsMod.DRAMA_TOOL_NAMES.includes('drama_check_consistency'), String(toolsMod.DRAMA_TOOL_NAMES?.length))

console.log('\n[3] 组合树引用')
const cordis = read('cordis.patch.yml')
check('cordis 补丁引用包名', cordis.includes(`'${pkg.name}'`), cordis.trim())
const preset = read('presets/drama.patch.yml')
check('预设引用 preset 入口', preset.includes(`'${pkg.name}/preset'`))
check('预设声明隔离服务 dramaMode', preset.includes('dramaMode: true'))
check('预设无 cwd 模板变量', !/\{\{\s*cwd\s*\}\}/.test(preset))
check('预设保留 model 模板变量', /\{\{\s*model\s*\}\}/.test(preset))
check('预设去掉 shell 类工具', !preset.includes('dsh-tool-pwsh') && !preset.includes('dsh-tool-bash'))

console.log('\n[4] 客户端 bundle')
const client = read('client.js')
check('客户端模块 id 为包名', client.includes(`id: '${pkg.name}'`))
check('客户端使用 __ModuleLoader__', client.includes('__ModuleLoader__'))
check('客户端无旧包名', !client.includes('@local/'))

console.log('\n[5] 随包技能与规则')
const skills = fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true }).filter((entry) => entry.isDirectory())
check('随包技能数量 >= 10', skills.length >= 10, String(skills.length))
let skillWithHeader = 0
for (const skill of skills) {
  const skillMd = path.join(root, 'skills', skill.name, 'SKILL.md')
  const text = fs.existsSync(skillMd) ? fs.readFileSync(skillMd, 'utf8') : ''
  if (text.startsWith('---') && text.includes(`name: ${skill.name}`)) skillWithHeader += 1
}
check('每个技能都有合法 SKILL.md 前置字段', skillWithHeader === skills.length, `${skillWithHeader}/${skills.length}`)
const rulesDir = path.join(root, 'presets', 'rules')
const rules = fs.existsSync(rulesDir) ? fs.readdirSync(rulesDir).filter((name) => name.endsWith('.json')) : []
check('判据规则文件 >= 5 且均为合法 JSON', rules.length >= 5 && rules.every((name) => {
  try { JSON.parse(fs.readFileSync(path.join(rulesDir, name), 'utf8')); return true } catch { return false }
}), String(rules.length))

console.log('\n[6] 内部路径 / 旧包名泄漏检查')
const needles = ['@local/dsh-ai-drama', '@Harness-workspace', 'aigc-workspace', 'C:\\\\Users\\\\Administrator', 'C:/Users/Administrator']
const offenders = []
const scanTargets = ['index.js', 'client.js', 'preset.js', 'cordis.patch.yml', 'package.json', 'README.md', 'CHANGELOG.md']
const walk = (relDir) => {
  for (const entry of fs.readdirSync(path.join(root, relDir), { withFileTypes: true })) {
    const rel = path.posix.join(relDir, entry.name)
    if (entry.isDirectory()) { walk(rel); continue }
    if (!/\.(js|mjs|json|yml|md)$/.test(entry.name)) continue
    scanTargets.push(rel)
  }
}
for (const dir of ['lib', 'presets', 'skills']) walk(dir)
for (const rel of scanTargets) {
  if (!exists(rel)) continue
  const text = read(rel)
  for (const needle of needles) if (text.includes(needle)) offenders.push(`${rel} :: ${needle}`)
}
check('产物中无内部路径 / 旧包名', offenders.length === 0, offenders.slice(0, 5).join('; '))

console.log('\n[7] 文档文件')
for (const doc of ['README.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md']) check(`${doc} 存在`, exists(doc))

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log(`  - ${item}`)
}
process.exit(failed === 0 ? 0 : 1)
