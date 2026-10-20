/**
 * Harness 兼容性门禁（v0.15.7）：preset 模板变量 + peer 依赖范围。
 *
 * 背景（2026-10-20 真实事故）：
 * - 用户把 DSH Desktop 从 0.2.0-rc.2 升级到 0.2.1-rc.2 后，短剧模式每轮失败：
 *   unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix",
 *   registered variables: provider, model。
 * - 根因：preset 的 persona suffix 沿用了旧版随包模板里的 {{cwd}}；0.2.1 起
 *   persona 模板按「该段落已注册变量」严格解析，桌面部署只注册 provider/model。
 * - 同时 package.json 的 peerDependencies 把 @deepseek-ai/dsh-skill-filesystem
 *   锁死为单一 rc 版本（0.2.0-rc.2），与「Harness 升级不因版本被锁死」的原则不符。
 *
 * 本套件的规则（保守、不依赖具体 DSH 版本）：
 * 1) presets/*.yml 里所有 {{...}} 模板变量 ⊆ {provider, model}（跨 0.2.0/0.2.1 均注册）；
 * 2) drama.patch.yml 不得再用 cwd 变量，必须保留 {{model}} 的短剧人设前缀；
 * 3) peerDependencies 不得锁死为单个预发布版本，必须声明允许升级的范围。
 *
 * 证据等级：静态代码/包元数据检查（A 级：本机文件实际读取），不涉及真实模型。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const presetDir = path.join(root, 'presets')

const results = []
let failed = 0
const check = (name, ok, detail) => {
  results.push({ name, ok, detail: detail || '' })
  if (!ok) failed++
}

/** 桌面部署 persona 段落里跨版本保守可用的变量（0.2.0-rc.2 与 0.2.1-rc.2 都注册）。 */
const CONSERVATIVE_VARS = new Set(['provider', 'model'])
const TOKEN_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g

const files = fs.existsSync(presetDir)
  ? fs.readdirSync(presetDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort()
  : []
check('C1 presets 目录存在且含 YAML 预设', files.length > 0, files.join(', '))

for (const file of files) {
  const text = fs.readFileSync(path.join(presetDir, file), 'utf8')
  const tokens = [...text.matchAll(TOKEN_RE)].map((m) => m[1])
  if (tokens.length === 0) continue
  const unknown = tokens.filter((t) => !CONSERVATIVE_VARS.has(t))
  check(`C2 ${file} 模板变量均跨版本已注册`, unknown.length === 0, `tokens=${tokens.join(',')} unknown=${unknown.join(',')}`)
}

const dramaPath = path.join(presetDir, 'drama.patch.yml')
check('C3 drama.patch.yml 存在', fs.existsSync(dramaPath), dramaPath)
if (fs.existsSync(dramaPath)) {
  const drama = fs.readFileSync(dramaPath, 'utf8')
  check('C4 drama.patch.yml 不再包含 cwd 模板变量', !/\{\{\s*cwd\s*\}\}/.test(drama), '旧 preset 曾在 persona suffix 使用 {{cwd}}，0.2.1-rc.2 会直接报错')
  check('C5 drama.patch.yml 保留 {{model}} 短剧人设前缀', /\{\{\s*model\s*\}\}/.test(drama), '')
  check('C6 drama.patch.yml 不再保留旧工作目录 suffix 行', !drama.includes('Your working directory is'), '')
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const peerRange = pkg.peerDependencies && pkg.peerDependencies['@deepseek-ai/dsh-skill-filesystem']
check('C7 声明 @deepseek-ai/dsh-skill-filesystem peer 依赖', typeof peerRange === 'string', String(peerRange))
check('C8 peer 依赖为允许升级的范围（非单一预发布锁定）', typeof peerRange === 'string' && /[<>=^~*]/.test(peerRange) && !/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(peerRange), String(peerRange))
check('C9 peer 范围覆盖 0.2.1-rc.2（当前用户 Harness 版本）', typeof peerRange === 'string' && /(>=|>)0\.2\.0-rc\.2/.test(peerRange) && !/<0\.2\.1/.test(peerRange), String(peerRange))
// v0.16.0 QA 同步（测试侧）：原 C10 用 `^0\.15\.(6|[7-9]|[1-9][0-9])` 只支持 0.15.x，v0.16.0 安装态会误报；
// 改为语义化版本数值比较（>=0.15.6，等价且更强），并保留 C7-C9 peer 范围断言。
const c10Parts = String(pkg.version).split(/[.-]/).map((x) => Number(x))
const c10AtLeast = (major, minor, patch) => {
  const [a, b, c] = c10Parts
  if (a !== major) return a > major
  if (b !== minor) return b > minor
  return c >= patch
}
check('C10 包版本已升到兼容修复版本（>=0.15.6）', c10AtLeast(0, 15, 6), pkg.version)

const summary = {
  suite: 'harness-compat(preset-vars)',
  dshVersions: ['0.2.0-rc.2 (historical baseline)', '0.2.1-rc.2 (2026-10-20 incident, fixed)'],
  ok: failed === 0,
  failed,
  checks: results.length,
  results,
}
const outDir = path.join(root, '_recover')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'verify-v0157-harness-compat.json'), JSON.stringify(summary, null, 2) + '\n')

console.log(`Harness 兼容性: ${results.length - failed}/${results.length} passed, ${failed} failed`)
for (const r of results) {
  if (!r.ok) console.log(`FAIL ${r.name} :: ${r.detail}`)
  else console.log(`PASS ${r.name}`)
}
process.exit(failed === 0 ? 0 : 1)
