/**
 * v0.15.10 C-5 · 全部写入口路径安全负例矩阵 · QA 验收套件（task-132）
 *
 * 覆盖：HTTP 写入口（doc-save / episode-write / storyboard-save / contract|outline|characters|memory|world-save /
 *      entry-create|rename|delete / import-apply / draft-resolve / finalize-episode / finalized-restore /
 *      assets-add / export-project / doc-notify）+ 工具写入口（drama_add_asset）
 * 负例：`..`（/ \ 混合）、绝对项目外、UNC、设备路径、`/` 开头、控制字符/NUL、超长、`%2e%2e` 编码、`.aidrama`、
 *      保留名/尾随点空格；symlink/junction 逃逸（Windows EPERM → SKIP 记录）
 * 断言：非法输入被拒绝（4xx/ok:false）且**不写盘/不修改旧文件**（项目树/外部诱饵/既有文档 hash 不变）、错误不泄露绝对路径
 * 正例：项目内合法路径登记/文档保存/内容保存/导出成功且内容正确
 * 回归：METHODS 70 / 工具 34 / 调用点 70 / slots 4 / 无新依赖
 *
 * 运行：node test/path-audit.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href)
const store = await load('lib/store.js')
const indexMod = await load('index.js')
const toolsModule = await load('lib/tools.js')
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8')
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))

let passed = 0
let failed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) { passed += 1 } else {
    failed += 1
    failures.push(label + (detail ? ' -> ' + detail : ''))
    console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`)
  }
}
function group(name) { console.log('\n' + name) }
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const CLIENT_CALLS = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
const SLOTS = (clientSrc.match(/slots\.register\(/g) || []).length
const METHODS = indexMod.METHODS || []
const TOOL_COUNT = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES.length : 0

async function snapshot(root) {
  const out = new Map()
  async function walk(current, rel) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      const relPath = rel ? rel + '/' + entry.name : entry.name
      if (entry.isDirectory()) { out.set(relPath + '/', { dir: true }); await walk(full, relPath) }
      else if (entry.isFile()) { const buf = await fs.readFile(full); out.set(relPath, { dir: false, size: buf.length, sha: sha256(buf) }) }
    }
  }
  await walk(root, '')
  return out
}
const BENIGN_SUFFIXES = (rel) => {
  const marker = '.aidrama/audit/'
  const idx = rel.indexOf(marker)
  if (idx >= 0 && (idx === 0 || rel[idx - 1] === '/' || rel[idx - 1] === '\\')) return true
  return rel.endsWith('.aidrama/editor-notifications.jsonl') || rel === '.aidrama/editor-notifications.jsonl'
}
const diffSnapshots = (before, after) => {
  const added = [...after.keys()].filter((key) => !before.has(key) && !BENIGN_SUFFIXES(key))
  const removed = [...before.keys()].filter((key) => !after.has(key) && !BENIGN_SUFFIXES(key))
  const changed = [...before.keys()].filter((key) => after.has(key) && !before.has(key) === false && !before.get(key).dir && !after.get(key).dir && !BENIGN_SUFFIXES(key) && (before.get(key).sha !== after.get(key).sha || before.get(key).size !== after.get(key).size))
  return { added, removed, changed, clean: added.length === 0 && removed.length === 0 && changed.length === 0 }
}

group('[0] 能力探测 / 契约')
check('0.1 工具 34 / METHODS 70 / 调用点 70 / slots=4 / 无新依赖', TOOL_COUNT === 35 && METHODS.length === 72 && CLIENT_CALLS.size === 72 && SLOTS === 4 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ tools: TOOL_COUNT, methods: METHODS.length, calls: CLIENT_CALLS.size, slots: SLOTS }))

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'path-audit-'))
const TITLE = '路径审计剧'
await store.createProject(workspace, TITLE)
const projectDir = path.join(workspace, 'AI短剧', TITLE)
const escapeOut = path.join(workspace, 'escape-out')
const decoyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'path-audit-decoy-'))
await fs.mkdir(escapeOut, { recursive: true })
await fs.writeFile(path.join(escapeOut, 'sentinel.txt'), 'outside-sentinel', 'utf8')
await fs.writeFile(path.join(decoyRoot, 'sentinel.txt'), 'decoy-sentinel', 'utf8')
const escapeFile = path.join(escapeOut, 'escape.txt')
const decoyFile = path.join(decoyRoot, 'escape.txt')
// 项目内合法文件与既有文档
const existingDoc = path.join(projectDir, '剧本', '已有.md')
await fs.mkdir(path.dirname(existingDoc), { recursive: true })
await fs.writeFile(existingDoc, '# 既有文档\n\n内容不可被非法路径写坏。\n', 'utf8')
const existingDocHash = sha256(await fs.readFile(existingDoc))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
await fs.mkdir(path.join(projectDir, '素材'), { recursive: true })
await fs.writeFile(path.join(projectDir, '素材', '审计.png'), png)
const positivePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
await fs.writeFile(path.join(projectDir, '素材', '正例.png'), positivePng)

const routes = new Map()
indexMod.apply({
  provide: () => {},
  inject(services, callback) {
    callback({ connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } }, get: () => undefined, on: () => {}, effect: (fn) => fn() })
  },
  logger: { info: () => {}, warn: () => {} },
}, { root: workspace })
async function call(method, body = {}) {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('route not registered: ' + method)
  const response = await spec.fetch(new Request('http://127.0.0.1:1/api/ai-drama/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' }, body: JSON.stringify(body),
  }))
  const text = await response.clone().text().catch(() => '')
  let payload = null
  try { payload = JSON.parse(text) } catch { payload = null }
  return { status: response.status, body: payload, text }
}
const toolDefs = typeof toolsModule.createToolDefs === 'function' ? toolsModule.createToolDefs({ rootOf: () => workspace, backendOf: () => null }) : []
const tool = (name) => toolDefs.find((def) => def && def.name === name)

const MALICIOUS_PATHS = [
  ['../escape.txt', 'parent-relative'],
  ['..\\escape.txt', 'backslash-relative'],
  ['a/../../escape.txt', 'nested-traversal'],
  ['..\\..\\escape.txt', 'double-backslash'],
  [escapeFile, 'absolute-outside'],
  [decoyFile, 'absolute-decoy'],
  ['\\\\127.0.0.1\\share\\escape.txt', 'unc'],
  ['/escape.txt', 'slash-root'],
  ['C:\\Windows\\win.ini', 'absolute-drive'],
  ['\\\\?\\C:\\Windows\\win.ini', 'device-path'],
  ['a\u0000b.md', 'nul-control'],
  ['a\u001fb.md', 'control-char'],
  ['%2e%2e/escape.txt', 'encoded-dotdot'],
  ['..%2f..%2fescape.txt', 'encoded-slash'],
  ['A'.repeat(300) + '.md', 'overlong'],
  ['.aidrama/evil.json', 'internal-dir'],
  ['.AIDRAMA/assets.json', 'uppercase-internal'],
  ['.AiDrAmA/evil.json', 'mixedcase-internal'],
  ['CON', 'reserved-name'],
  ['trailing. ', 'trailing-dot-space'],
]
const MALICIOUS_TITLES = [
  ['../escape-title', 'parent-relative'],
  ['..\\escape-title', 'backslash-relative'],
  ['C:\\Windows', 'absolute-drive'],
  ['/escape', 'slash-root'],
  ['\\\\server\\share', 'unc'],
  ['bad\u0000title', 'nul-control'],
  ['bad\u001ftitle', 'control-char'],
  ['.aidrama', 'internal-dir'],
]
// 写入口定义：pathFields = 用户可控「落盘路径字段」；base = 合法最小请求体；titlePoison 是否测非法 title
const ENTRIES = [
  { method: 'doc-save', pathFields: ['path'], extra: ['file', 'output', 'target', 'dir'], base: { title: TITLE, path: '剧本/审计.md', text: '# 审计\n' } },
  { method: 'doc-notify', pathFields: ['path'], extra: ['file', 'output', 'target', 'dir'], base: { title: TITLE, path: '剧本/审计.md', action: 'save' } },
  { method: 'entry-create', pathFields: ['path'], extra: ['file', 'output', 'target', 'dir'], base: { title: TITLE, path: 'world/审计条目', kind: '地点' } },
  { method: 'entry-rename', pathFields: ['path'], extra: ['file', 'output', 'target', 'dir'], base: { title: TITLE, path: 'world/审计条目', name: '审计条目2' } },
  { method: 'entry-delete', pathFields: ['path'], extra: ['file', 'output', 'target', 'dir'], base: { title: TITLE, path: 'world/审计条目' } },
  { method: 'assets-add', pathFields: ['source'], extra: ['path', 'file', 'output', 'dir'], base: { title: TITLE, source: '素材/审计.png' } },
  { method: 'export-project', pathFields: [], extra: ['path', 'file', 'output', 'dir', 'source', 'target'], base: { title: TITLE, format: 'md' } },
  { method: 'episode-write', pathFields: [], extra: ['path', 'file', 'output', 'dir', 'source', 'target'], base: { title: TITLE, order: 1, text: '# 第1集\n\n审计内容。\n' } },
  { method: 'storyboard-save', pathFields: [], extra: ['path', 'file', 'output', 'dir', 'source', 'target'], base: { title: TITLE, order: 1, shots: [] } },
  { method: 'contract-save', pathFields: [], extra: ['path', 'file', 'output', 'dir', 'source', 'target'], base: { title: TITLE, contract: { platform: '抖音' } } },
  { method: 'outline-save', pathFields: [], extra: ['path', 'file', 'output', 'dir', 'source', 'target'], base: { title: TITLE, rows: [] } },
  { method: 'characters-save', pathFields: [], extra: ['path', 'file', 'output', 'dir', 'source', 'target'], base: { title: TITLE, characters: [] } },
  { method: 'memory-save', pathFields: [], extra: ['path', 'file', 'output', 'dir', 'source', 'target'], base: { title: TITLE, memory: [] } },
  { method: 'world-save', pathFields: [], extra: ['path', 'file', 'output', 'dir', 'source', 'target'], base: { title: TITLE, world: [] } },
  { method: 'import-apply', pathFields: [], extra: ['path', 'file', 'output', 'dir', 'source', 'target'], base: { title: TITLE, text: '' } },
  { method: 'draft-resolve', pathFields: [], extra: ['path', 'file', 'output', 'dir', 'source', 'target'], base: { title: TITLE, id: 'd-abc123-deadbeef', action: 'accept' } },
  { method: 'finalize-episode', pathFields: [], extra: ['path', 'file', 'output', 'dir', 'source', 'target'], base: { title: TITLE, order: 1 } },
  { method: 'finalized-restore', pathFields: [], extra: ['path', 'file', 'output', 'dir', 'source', 'target'], base: { title: TITLE, order: 1 } },
]

group('[A] 路径字段负例矩阵（项目树/外部诱饵/既有文档不变）')
// bootstrap：先合法登记一个素材，使 .aidrama/assets.json 真实存在（用于暴露 assets-add 大小写内部目录漏洞）
await call('assets-add', { title: TITLE, source: '素材/审计.png' })
const treeBeforeA = await snapshot(workspace)
const outsideBeforeA = await snapshot(escapeOut)
const decoyBeforeA = await snapshot(decoyRoot)
let pathMatrixCases = 0
const pathMatrixFailures = []
const matrixResults = []
for (const entry of ENTRIES) {
  if (!entry.pathFields.length) continue
  for (const [badPath, kind] of MALICIOUS_PATHS) {
    const body = { ...entry.base }
    for (const field of entry.pathFields) body[field] = badPath
    const before = await snapshot(workspace)
    const result = await call(entry.method, body)
    const after = await snapshot(workspace)
    pathMatrixCases += 1
    const rejected = result.status >= 400 || (result.body && result.body.ok === false)
    const treeClean = diffSnapshots(before, after).clean
    if (!rejected || !treeClean) pathMatrixFailures.push({ entry: entry.method, kind, status: result.status, code: result.body && result.body.code, treeClean })
    matrixResults.push({ entry: entry.method, kind, status: result.status, ok: result.body && result.body.ok, code: result.body && result.body.code, treeClean })
  }
}
check(`A1 路径字段负例 ${pathMatrixCases} 例全部拒绝且不写盘/不改旧文件`, pathMatrixFailures.length === 0, JSON.stringify(pathMatrixFailures.slice(0, 8)))
const treeAfterA = await snapshot(workspace)
const outsideAfterA = await snapshot(escapeOut)
const decoyAfterA = await snapshot(decoyRoot)
check('A2 全量负例后外部诱饵目录零变化（无越界写入）', diffSnapshots(outsideBeforeA, outsideAfterA).clean && diffSnapshots(decoyBeforeA, decoyAfterA).clean, JSON.stringify({ outside: diffSnapshots(outsideBeforeA, outsideAfterA), decoy: diffSnapshots(decoyBeforeA, decoyAfterA) }))
check('A3 全量负例后既有文档 hash 不变', sha256(await fs.readFile(existingDoc)) === existingDocHash)
check('A4 全量负例后项目内未被写入额外文件（A 组结束后树与开始一致）', diffSnapshots(treeBeforeA, treeAfterA).clean, JSON.stringify(diffSnapshots(treeBeforeA, treeAfterA)))
// A6：assets-add 大小写内部目录 + 真实存在的内部文件（.aidrama/qa-secret.json）→ 拒绝且零写盘
const internalSecret = path.join(projectDir, '.aidrama', 'qa-secret.json')
await fs.writeFile(internalSecret, '{"secret":true}', 'utf8')
const secretBefore = await snapshot(workspace)
const secretAdd = await call('assets-add', { title: TITLE, source: '.AIDRAMA/qa-secret.json' })
const secretAfter = await snapshot(workspace)
check('A6 assets-add 大小写内部目录（真实内部文件）→ 拒绝且零写盘', (secretAdd.status >= 400 || (secretAdd.body && secretAdd.body.ok === false)) && diffSnapshots(secretBefore, secretAfter).clean, JSON.stringify({ status: secretAdd.status, code: secretAdd.body && secretAdd.body.code, diff: diffSnapshots(secretBefore, secretAfter) }))
// 错误信息不泄露绝对路径
const leakProbe = await call('doc-save', { title: TITLE, path: escapeFile, text: 'x' })
check('A5 非法路径错误不泄露绝对路径/堆栈', !leakProbe.text.includes(escapeOut) && !leakProbe.text.includes(decoyRoot) && !/[A-Za-z]:\\\\Users\\\\/.test(leakProbe.text) && !/\bat\s+.*:\d+:\d+/.test(leakProbe.text), leakProbe.text.slice(0, 160))

group('[B] 非法 title 负例矩阵（全部写入口不写盘）')
const treeBeforeB = await snapshot(workspace)
const outsideBeforeB = await snapshot(escapeOut)
const titleFailures = []
let titleCases = 0
for (const entry of ENTRIES) {
  for (const [badTitle, kind] of MALICIOUS_TITLES) {
    const body = { ...entry.base, title: badTitle }
    const result = await call(entry.method, body)
    titleCases += 1
    const rejected = result.status >= 400 || (result.body && result.body.ok === false)
    if (!rejected) titleFailures.push({ entry: entry.method, kind, status: result.status })
  }
}
check(`B1 非法 title 负例 ${titleCases} 例全部拒绝（4xx/ok:false）`, titleFailures.length === 0, JSON.stringify(titleFailures.slice(0, 8)))
check('B2 非法 title 全量后项目树/外部诱饵零变化', diffSnapshots(treeBeforeB, await snapshot(workspace)).clean && diffSnapshots(outsideBeforeB, await snapshot(escapeOut)).clean)

group('[C] 额外路径字段（非该入口使用）不得造成越界写入')
const outsideBeforeC = await snapshot(escapeOut)
const decoyBeforeC = await snapshot(decoyRoot)
const extraFailures = []
for (const entry of ENTRIES) {
  for (const field of entry.extra) {
    for (const [badPath, kind] of [MALICIOUS_PATHS[0], MALICIOUS_PATHS[4], MALICIOUS_PATHS[6], MALICIOUS_PATHS[9]]) {
      const result = await call(entry.method, { ...entry.base, [field]: badPath })
      if (result.status >= 500) extraFailures.push({ entry: entry.method, field, kind, status: result.status })
    }
  }
}
check('C1 额外路径字段调用不产生 5xx 崩溃', extraFailures.length === 0, JSON.stringify(extraFailures.slice(0, 8)))
check('C2 额外路径字段全量后外部诱饵/诱饵目录零变化', diffSnapshots(outsideBeforeC, await snapshot(escapeOut)).clean && diffSnapshots(decoyBeforeC, await snapshot(decoyRoot)).clean)

group('[D] 工具写入口（drama_add_asset）路径负例')
if (!tool('drama_add_asset')) {
  console.log('      （SKIP：drama_add_asset 工具不存在）')
} else {
  const outsideBeforeD = await snapshot(escapeOut)
  const decoyBeforeD = await snapshot(decoyRoot)
  const toolFailures = []
  const toolPaths = [...MALICIOUS_PATHS, ['.AIDRAMA/qa-secret.json', 'uppercase-internal-real-file']]
  for (const [badPath, kind] of toolPaths) {
    const result = await tool('drama_add_asset').execute({ title: TITLE, source: badPath }, {})
    const rejected = !result || result.ok === false
    if (!rejected) toolFailures.push({ kind, result: result && { ok: result.ok, code: result.code } })
  }
  check('D1 drama_add_asset 路径负例全部拒绝（ok:false）', toolFailures.length === 0, JSON.stringify(toolFailures.slice(0, 8)))
  check('D2 工具负例后外部诱饵/诱饵目录零变化', diffSnapshots(outsideBeforeD, await snapshot(escapeOut)).clean && diffSnapshots(decoyBeforeD, await snapshot(decoyRoot)).clean)
}

group('[E] 正例：项目内合法路径/内容成功且正确')
const positiveDoc = '剧本/路径审计.md'
const savePos = await call('doc-save', { title: TITLE, path: positiveDoc, text: '# 正例\n\n合法文档内容。\n' })
const readPos = await call('doc-read', { title: TITLE, path: positiveDoc })
check('E1 doc-save 项目内合法路径 200 且内容回读一致', savePos.status === 200 && readPos.status === 200 && readPos.body && readPos.body.text === '# 正例\n\n合法文档内容。\n')
const validAccepts = await call('assets-add', { title: TITLE, source: '素材/正例.png' })
check('E2 assets-add 项目内合法素材 200', validAccepts.status === 200 && validAccepts.body && validAccepts.body.ok === true, JSON.stringify({ status: validAccepts.status, code: validAccepts.body && validAccepts.body.code }))
const contractSave = await call('contract-save', { title: TITLE, contract: { platform: '抖音', audience: '男频' } })
const contractGet = await call('contract-get', { title: TITLE })
check('E3 contract-save 合法内容成功且回读一致', contractSave.status === 200 && contractGet.status === 200 && contractGet.body && contractGet.body.contract && contractGet.body.contract.platform === '抖音')
const episodeWrite = await call('episode-write', { title: TITLE, order: 1, text: '# 第1集\n\n合法正文。\n' })
const episodeRead = await call('episode-read', { title: TITLE, order: 1 })
check('E4 episode-write 合法正文成功且回读一致', episodeWrite.status === 200 && episodeRead.status === 200 && episodeRead.body && String(episodeRead.body.text || '').includes('合法正文'))
const exportPos = await call('export-project', { title: TITLE, format: 'markdown' })
check('E5 export-project 导出成功且文件位于项目内', exportPos.status === 200 && exportPos.body && exportPos.body.export && !path.isAbsolute(String(exportPos.body.export.relative || '')) && !String(exportPos.body.export.relative || '').startsWith('..'), JSON.stringify(exportPos.body && exportPos.body.export))
const existingDocAfter = sha256(await fs.readFile(existingDoc))
check('E6 正例/负例后既有文档未被修改', existingDocAfter === existingDocHash)



group('[G] V2 batch 路径白名单 / V3 .aidrama 大小写（静态回归断言）')
const indexSource = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const namesSource = await fs.readFile(path.join(pluginRoot, 'lib', 'names.js'), 'utf8')
check('G1 V2：HTTP submit-batch/collect-batch 不透传 batch.outDir/cwd（白名单删除）', /delete\s+batch\.outDir/.test(indexSource) && /delete\s+batch\.cwd/.test(indexSource), JSON.stringify({ outDir: /delete\s+batch\.outDir/.test(indexSource), cwd: /delete\s+batch\.cwd/.test(indexSource) }))
check('G2 V3：.aidrama 保护大小写不敏感（isInternalDataName + toLowerCase）', /isInternalDataName/.test(namesSource) && /toLowerCase\(\)/.test(namesSource) && /assertSafeRelPath[\s\S]{0,2000}isInternalDataName/.test(namesSource), JSON.stringify({ helper: /isInternalDataName/.test(namesSource), lower: /toLowerCase\(\)/.test(namesSource) }))

group('[F] junction / symlink 逃逸（Windows 无权限创建 → SKIP 记录）')
const junctionPath = path.join(projectDir, '素材', '越界链接')
let junctionCreated = false
try {
  await execFileAsync('cmd', ['/c', 'mklink', '/J', junctionPath, escapeOut])
  junctionCreated = true
} catch { junctionCreated = false }
if (!junctionCreated) {
  console.log('      （SKIP：Windows 无权限创建 junction/symlink → 逃逸用例如实记录 SKIP）')
} else {
  const escapeBefore = await snapshot(escapeOut)
  const treeBefore = await snapshot(workspace)
  const junctionCases = [
    ['doc-save', { title: TITLE, path: '素材/越界链接/写穿.txt', text: 'x' }],
    ['assets-add', { title: TITLE, source: '素材/越界链接/sentinel.txt' }],
    ['entry-create', { title: TITLE, path: '素材/越界链接/越界条目', kind: '地点' }],
    ['entry-rename', { title: TITLE, path: '素材/越界链接/sentinel.txt', name: '改穿' }],
    ['entry-delete', { title: TITLE, path: '素材/越界链接/sentinel.txt' }],
  ]
  const junctionFailures = []
  for (const [method, body] of junctionCases) {
    const result = await call(method, body)
    const rejected = result.status >= 400 || (result.body && result.body.ok === false)
    if (!rejected) junctionFailures.push({ method, status: result.status, body: result.body })
  }
  check('F1 junction 逃逸路径全部拒绝（doc-save/assets-add/entry-*）', junctionFailures.length === 0, JSON.stringify(junctionFailures.slice(0, 4)))
  check('F2 junction 逃逸后外部诱饵目录零变化（无写穿）', diffSnapshots(escapeBefore, await snapshot(escapeOut)).clean, JSON.stringify(diffSnapshots(escapeBefore, await snapshot(escapeOut))))
  check('F3 junction 逃逸后项目树零变化（无写盘）', diffSnapshots(treeBefore, await snapshot(workspace)).clean, JSON.stringify(diffSnapshots(treeBefore, await snapshot(workspace))))
}
if (process.argv.includes('--dump')) {
  const dump = { at: new Date().toISOString(), version: pkg.version, passed, failed, failures, matrixResults, holes: matrixResults.filter((item) => item.status < 400 && item.ok !== false) }
  await fs.mkdir(path.join(pluginRoot, '..', '_recover', 'v0160-baseline'), { recursive: true })
  await fs.writeFile(path.join(pluginRoot, '..', '_recover', 'v0160-baseline', 'pre-fix-matrix.json'), JSON.stringify(dump, null, 2) + '\n', 'utf8')
  console.log('dump: _recover/v0160-baseline/pre-fix-matrix.json')
}

await fs.rm(workspace, { recursive: true, force: true })
await fs.rm(decoyRoot, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
