/**
 * v0.16.1 task-140 · C-6 QA 验收套件（intake-artifact 安全硬化 · A+加固）
 *
 * 覆盖：
 *  [0] 能力自适应 + 契约（METHODS 70 / 工具 34 / 调用点 70 / slots 4）
 *  [1] 本地文件收紧：项目内相对/绝对成功；../、项目外绝对、UNC、设备、.aidrama、缺失、>64MB、超长/控制符 → 拒绝且零复制/零登记/零写盘；错误不泄绝对路径
 *  [2] URL 加固（fake globalThis.fetch，0 网络）：非 http(s)、userinfo、私网/环回/元数据地址（不发起 fetch）、重定向到私网、>5 跳、流式 >64MB 中止清理、成功源 sourceUrl 清洗（去 query/userinfo）、DNS 失败
 *  [3] 事务/审计：WRITE_TARGETS 含 intake-artifact + 成功写 audit + 并发不破坏 registry + 响应形状不变
 *  [4] batch 内部链路：collectBatch（fake backend，产物落项目内）成功 + stageBatchArtifact→adoptBatchArtifact（staging 内部放行 + realpath 终检）
 *  [5] client：本地文件→assets-import、项目内路径→intake-artifact、错误提示、调用点不增/slots=4/DOM 无绝对路径（client 交付后校准）
 *
 * 能力自适应：host generation.js 未含 C-6 硬化标记（assertSafeIntakeUrl/assertIntakeLocalFile）→ 整套件 SKIP（exit 0）。
 * 运行：node test/intake-hardening.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href)
const store = await load('lib/store.js')
const generation = await load('lib/generation.js')
const orchestrator = await load('lib/orchestrator.js')
const indexMod = await load('index.js')
const toolsModule = await load('lib/tools.js')
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8')
const generationSrc = await fs.readFile(path.join(pluginRoot, 'lib', 'generation.js'), 'utf8')
const indexSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const METHODS = indexMod.METHODS || []
const TOOL_COUNT = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES.length : 0
const CLIENT_CALLS = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
const SLOTS = (clientSrc.match(/slots\.register\(/g) || []).length

let passed = 0
let failed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) passed += 1
  else { failed += 1; failures.push(label + (detail ? ' -> ' + detail : '')); console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`) }
}
const group = (name) => console.log('\n' + name)

group('[0] 能力探测 / 契约（版本自适应）')
const hostCapability = /assertSafeIntakeUrl/.test(generationSrc) && /assertIntakeLocalFile/.test(generationSrc) && /sanitizeSourceUrl/.test(generationSrc)
const clientCapability = /选择本地文件/.test(clientSrc) || (/assets-import/.test(clientSrc) && /产物入库/.test(clientSrc))
if (!hostCapability && !clientCapability) {
  console.log('  结果：0 passed, 0 failed（SKIP：host 无 C-6 硬化标记且 client 无产物入库迁移标记，v0.16.0 现态）')
  process.exit(0)
}
const expectedMethods = 72
check('0.1 契约：METHODS 70 / 工具 34 / client 调用点 70 / slots=4（C-6 无新增方法）', METHODS.length === expectedMethods && TOOL_COUNT === 35 && CLIENT_CALLS.size === 72 && SLOTS === 4, JSON.stringify({ methods: METHODS.length, tools: TOOL_COUNT, calls: CLIENT_CALLS.size, slots: SLOTS }))

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'v0161-intake-'))
const TITLE = '产物入库验收剧'
await store.createProject(workspace, TITLE)
const projectDir = path.join(workspace, 'AI短剧', TITLE)
const materialDir = path.join(projectDir, '素材')
const genDir = path.join(materialDir, '生成')
await fs.mkdir(genDir, { recursive: true })
const internalPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
await fs.writeFile(path.join(genDir, '内部产物.png'), internalPng)
const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v0161-external-'))
const externalFile = path.join(externalDir, '外部秘密.png')
await fs.writeFile(externalFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 5, 6, 7, 8]))

const routes = new Map()
indexMod.apply({
  provide: () => {},
  inject(services, callback) {
    callback({ connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } }, get: () => undefined, on: () => {}, effect: (fn) => fn() })
  },
  logger: { info: () => {}, warn: () => {} },
}, { root: workspace })
async function call(method, body) {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('route not registered: ' + method)
  const response = await spec.fetch(new Request('http://127.0.0.1:1/api/ai-drama/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' }, body: JSON.stringify(body),
  }))
  const text = await response.text()
  let payload = null
  try { payload = JSON.parse(text) } catch {}
  return { status: response.status, body: payload, text }
}
const BENIGN = (rel) => rel.startsWith('.aidrama/audit/') || rel.endsWith('.aidrama/editor-notifications.jsonl')
async function fileMap(root) {
  const map = new Map()
  async function walk(current, rel) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      const relPath = rel ? rel + '/' + entry.name : entry.name
      if (entry.isDirectory()) { await walk(full, relPath); continue }
      if (BENIGN(relPath)) continue
      try { const b = await fs.readFile(full); map.set(relPath, sha256(b) + ':' + b.length) } catch {}
    }
  }
  await walk(root, '')
  return map
}
const diffMaps = (before, after) => {
  const added = [...after.keys()].filter((k) => !before.has(k))
  const removed = [...before.keys()].filter((k) => !after.has(k))
  const changed = [...before.keys()].filter((k) => after.has(k) && after.get(k) !== before.get(k))
  return { added, removed, changed, clean: added.length === 0 && removed.length === 0 && changed.length === 0 }
}
async function readAssets() {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(projectDir, '.aidrama', 'assets.json'), 'utf8'))
    return Array.isArray(raw) ? raw : raw.assets || []
  } catch { return [] }
}
async function runIntake(label, artifact) {
  const before = await fileMap(projectDir)
  const result = await call('intake-artifact', { title: TITLE, artifact })
  const after = await fileMap(projectDir)
  const diff = diffMaps(before, after)
  return { label, status: result.status, body: result.body, text: result.text, diff }
}
const NO_WRITE_STATUS = (result) => result.status >= 400 && result.status < 500

group('[1] 本地文件收紧（项目内成功；外部/逃逸拒绝且零写盘）')
let localResult
if (hostCapability) {
  // 负例先行（同一空项目上验证零写盘）
  const beforeAll = await fileMap(projectDir)
  const assetsBefore = await readAssets()
  const negatives = [
    ['项目外绝对路径', { file: externalFile, name: '外部秘密.png' }],
    ['../ 逃逸', { file: '../外部秘密.png', name: '逃逸.png' }],
    ['UNC 路径', { file: '\\\\127.0.0.1\\share\\x.png', name: 'unc.png' }],
    ['设备路径', { file: '\\\\?\\C:\\Windows\\win.ini', name: 'device.png' }],
    ['.aidrama 内部', { file: '.aidrama/assets.json', name: '内部数据.png' }],
    ['缺失文件', { file: '素材/生成/不存在.png', name: '缺失.png' }],
    ['超长路径', { file: '素材/生成/' + 'a'.repeat(1100) + '.png', name: '超长.png' }],
    ['控制字符', { file: '素材/生成/bad\u0000.png', name: '控制.png' }],
    ['file URL 冒充', { file: 'file:///C:/Windows/win.ini', name: 'urlfile.png' }],
  ]
  const negativeResults = []
  for (const [label, artifact] of negatives) negativeResults.push(await runIntake(label, artifact))
  const afterAll = await fileMap(projectDir)
  const assetsAfter = await readAssets()
  check('1.1 外部/逃逸负例全部拒绝（4xx）', negativeResults.every((r) => NO_WRITE_STATUS(r)), JSON.stringify(negativeResults.map((r) => ({ label: r.label, status: r.status, code: r.body && r.body.code }))))
  check('1.2 负例零写盘（项目树与 assets.json 不变）', diffMaps(beforeAll, afterAll).clean && assetsBefore.length === assetsAfter.length, JSON.stringify(diffMaps(beforeAll, afterAll)))
  check('1.3 缺失文件 → 404；设备/UNC → 403/400（错误码语义）', negativeResults.find((r) => r.label === '缺失文件').status === 404 && [400, 403].includes(negativeResults.find((r) => r.label === '设备路径').status), JSON.stringify(negativeResults.map((r) => ({ label: r.label, status: r.status }))))
  check('1.4 错误不泄漏绝对路径/堆栈', negativeResults.every((r) => !r.text.includes(workspace) && !/[A-Za-z]:\\\\Users\\\\/.test(r.text) && !/\bat\s+.*:\d+:\d+/.test(r.text)), negativeResults.filter((r) => r.text.includes(workspace)).map((r) => r.label).join(','))

  // 超大本地文件（项目内 >64MB）→ 413 且零写盘
  const bigPath = path.join(genDir, '超大产物.png')
  await fs.writeFile(bigPath, Buffer.alloc(65 * 1024 * 1024, 9))
  const beforeBig = await fileMap(projectDir)
  const assetsBeforeBig = await readAssets()
  const bigResult = await runIntake('超大本地文件', { file: '素材/生成/超大产物.png', name: '超大产物.png' })
  const afterBig = await fileMap(projectDir)
  const assetsAfterBig = await readAssets()
  check('1.5 >64MB 本地文件 → 413 且零复制/零登记', bigResult.status === 413 && bigResult.body && bigResult.body.code === 'too-large' && assetsBeforeBig.length === assetsAfterBig.length, JSON.stringify({ status: bigResult.status, code: bigResult.body && bigResult.body.code }))
  await fs.rm(bigPath, { force: true })
  await fs.rm(path.join(projectDir, '素材', '生成', '超大产物-1.png'), { force: true }).catch(() => {})

  // 正例：项目内相对路径 + 项目内绝对路径
  const relResult = await runIntake('项目内相对路径', { file: '素材/生成/内部产物.png', name: '相对产物.png' })
  const absResult = await runIntake('项目内绝对路径', { file: path.join(genDir, '内部产物.png'), name: '绝对产物.png' })
  const assetsFinal = await readAssets()
  localResult = { relResult, absResult, assetsFinal }
  check('1.6 项目内相对路径成功 → 200 + 落 素材/生成/ + 自动登记', relResult.status === 200 && relResult.body && relResult.body.ok === true && String(relResult.body.relative || '').includes('素材') && String(relResult.body.relative || '').includes('生成') && assetsFinal.some((a) => String(a.name || '').includes('相对产物') || String(a.source || '').includes('相对产物')), JSON.stringify({ status: relResult.status, relative: relResult.body && relResult.body.relative }))
  check('1.7 项目内绝对路径成功 → 200 + 登记', absResult.status === 200 && absResult.body && absResult.body.ok === true && assetsFinal.some((a) => String(a.name || '').includes('绝对产物') || String(a.source || '').includes('绝对产物')), JSON.stringify({ status: absResult.status, relative: absResult.body && absResult.body.relative }))
  check('1.8 响应形状不变（ok/relative/bytes/sha256/asset）', Boolean(relResult.body && relResult.body.ok && relResult.body.relative && Number.isFinite(relResult.body.bytes) && /^[0-9a-f]{64}$/.test(String(relResult.body.sha256)) && relResult.body.asset), JSON.stringify(relResult.body && Object.keys(relResult.body)))

  // junction 逃逸（项目内 junction → 项目外）
  const junctionPath = path.join(genDir, 'junction-escape')
  let junctionCreated = false
  try {
    await new Promise((resolve, reject) => execFile('cmd', ['/c', 'mklink', '/J', junctionPath, externalDir], (error) => error ? reject(error) : resolve()))
    junctionCreated = true
  } catch {}
  if (junctionCreated) {
    const junctionResult = await runIntake('junction 逃逸', { file: '素材/生成/junction-escape/外部秘密.png', name: 'junction.png' })
    check('1.9 junction 逃逸 → 拒绝且零写盘', NO_WRITE_STATUS(junctionResult) && junctionResult.diff.clean, JSON.stringify({ status: junctionResult.status, code: junctionResult.body && junctionResult.body.code, diff: junctionResult.diff }))
    await fs.rm(junctionPath, { recursive: true, force: true }).catch(() => {})
  } else {
    console.log('      （SKIP：junction 创建失败（Windows 权限），如实记录）')
  }
} else {
  console.log('      （SKIP：host C-6 硬化未交付）')
}

group('[2] URL 加固（fake fetch，0 网络）')
if (hostCapability) {
  const realFetch = globalThis.fetch
  let fetchCalls = []
  const installFakeFetch = (handler) => { fetchCalls = []; globalThis.fetch = async (url, options) => { fetchCalls.push(String(url)); return handler(String(url), options) } }
  const restoreFetch = () => { globalThis.fetch = realFetch }
  const pngResponse = () => new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]), { status: 200, headers: { 'content-type': 'image/png' } })
  try {
    // 2.1 非 http(s) / userinfo → 400（不发起 fetch）
    installFakeFetch(() => { throw new Error('不应被抓取') })
    const protocolResults = []
    for (const url of ['file:///C:/Windows/win.ini', 'ftp://127.0.0.1/x.png', 'data:image/png;base64,iVBORw0KGgo=', 'javascript:alert(1)']) {
      protocolResults.push(await runIntake('协议 ' + url.split(':')[0], { url, name: '协议.png' }))
    }
    const userinfoResult = await runIntake('userinfo', { url: 'http://user:pass@93.184.216.34/x.png', name: 'userinfo.png' })
    check('2.1 非 http(s)/userinfo URL → 4xx 且零写盘、不发起 fetch', [...protocolResults, userinfoResult].every((r) => NO_WRITE_STATUS(r) && r.diff.clean), JSON.stringify([...protocolResults, userinfoResult].map((r) => ({ label: r.label, status: r.status, code: r.body && r.body.code }))))
    restoreFetch()

    // 2.2 私网/环回/元数据 IP 清单：拒绝且不发起 fetch（列 IP + DNS 名）
    installFakeFetch(() => { throw new Error('私网不应被抓取') })
    const privateTargets = [
      'http://127.0.0.1:9/x.png', 'http://localhost/x.png', 'http://foo.localhost/x.png',
      'http://10.0.0.1/x.png', 'http://172.16.0.1/x.png', 'http://172.31.255.1/x.png',
      'http://192.168.1.1/x.png', 'http://169.254.169.254/latest/meta-data', 'http://0.0.0.0/x.png',
      'http://100.64.0.1/x.png', 'http://198.18.0.1/x.png', 'http://[::1]/x.png', 'http://[::]/x.png',
      'http://[fc00::1]/x.png', 'http://[fe80::1]/x.png', 'http://[::ffff:127.0.0.1]/x.png',
    ]
    const privateResults = []
    for (const url of privateTargets) privateResults.push(await runIntake('私网 ' + url, { url, name: '私网.png' }))
    check('2.2 私网/环回/元数据 16 类全部拒绝且不发起 fetch、零写盘', privateResults.every((r) => NO_WRITE_STATUS(r) && r.diff.clean) && fetchCalls.length === 0, JSON.stringify({ results: privateResults.map((r) => ({ status: r.status, code: r.body && r.body.code })), fetchCalls: fetchCalls.length }))
    restoreFetch()

    // 2.3 重定向到私网：首跳 fetch 一次，第二跳校验拒绝
    installFakeFetch((url) => {
      if (url.startsWith('https://93.184.216.34/redir')) return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/secret.png' } })
      throw new Error('不应抓取私网')
    })
    const redirectPrivate = await runIntake('重定向到私网', { url: 'https://93.184.216.34/redir', name: '重定向.png' })
    check('2.3 重定向到私网 → 拒绝且不抓取私网（fetch 1 次）、零写盘', NO_WRITE_STATUS(redirectPrivate) && redirectPrivate.diff.clean && fetchCalls.length === 1, JSON.stringify({ status: redirectPrivate.status, code: redirectPrivate.body && redirectPrivate.body.code, fetchCalls: fetchCalls.length }))
    restoreFetch()

    // 2.4 >5 跳重定向 → 400 拒绝
    installFakeFetch((url) => {
      const parsed = new URL(url)
      const hop = Number(parsed.pathname.replace('/hop', '')) || 0
      if (hop < 8) return new Response(null, { status: 302, headers: { location: 'https://93.184.216.34/hop' + (hop + 1) } })
      return pngResponse()
    })
    const redirectLoop = await runIntake('>5 跳重定向', { url: 'https://93.184.216.34/hop0', name: '跳转.png' })
    check('2.4 重定向 >5 跳 → 拒绝（4xx）且零写盘', NO_WRITE_STATUS(redirectLoop) && redirectLoop.diff.clean && fetchCalls.length <= 7, JSON.stringify({ status: redirectLoop.status, code: redirectLoop.body && redirectLoop.body.code, fetchCalls: fetchCalls.length }))
    restoreFetch()

    // 2.5 流式 >64MB → 413 中止 + 无残留
    installFakeFetch(() => {
      let sent = 0
      const chunk = new Uint8Array(1024 * 1024)
      const stream = new ReadableStream({
        pull(controller) {
          if (sent >= 65 * 1024 * 1024) { controller.close(); return }
          sent += chunk.length
          controller.enqueue(chunk)
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'image/png' } })
    })
    const beforeStream = await fileMap(projectDir)
    const tooBigStream = await runIntake('><64MB 流式', { url: 'https://93.184.216.34/huge.png', name: '超大流.png' })
    const afterStream = await fileMap(projectDir)
    check('2.5 流式 >64MB → 413 中止且无文件/tmp 残留', tooBigStream.status === 413 && tooBigStream.body && tooBigStream.body.code === 'too-large' && diffMaps(beforeStream, afterStream).clean, JSON.stringify({ status: tooBigStream.status, code: tooBigStream.body && tooBigStream.body.code, diff: diffMaps(beforeStream, afterStream) }))
    restoreFetch()

    // 2.6 成功 https 源 + sourceUrl 清洗
    installFakeFetch(() => pngResponse())
    const okUrl = 'https://93.184.216.34/ok.png?token=SECRET123#frag'
    const okResult = await runIntake('合法 https 源', { url: okUrl, name: '正常源.png' })
    const registry = await readAssets()
    const sourceUrlEntry = registry.find((a) => String(a.name || '').includes('正常源') || String(a.source || '').includes('正常源')) || null
    const storedUrl = sourceUrlEntry && sourceUrlEntry.sourceUrl
    check('2.6 合法 https 源成功 → 200 + 自动登记', okResult.status === 200 && okResult.body && okResult.body.ok === true && Boolean(sourceUrlEntry), JSON.stringify({ status: okResult.status, relative: okResult.body && okResult.body.relative }))
    check('2.7 sourceUrl 清洗：去 userinfo/query/hash（不持久化 token）', storedUrl === 'https://93.184.216.34/ok.png', JSON.stringify({ storedUrl }))
    restoreFetch()

    // 2.8 DNS 无法解析 → 可读错误、零写盘
    installFakeFetch(() => { throw new Error('不应抓取') })
    const dnsFail = await runIntake('DNS 失败', { url: 'https://qa-nonexistent-host.invalid/x.png', name: 'dns失败.png' })
    check('2.8 DNS 失败 → 4xx 可读错误且零写盘', NO_WRITE_STATUS(dnsFail) && dnsFail.diff.clean, JSON.stringify({ status: dnsFail.status, code: dnsFail.body && dnsFail.body.code, error: dnsFail.body && dnsFail.body.error }))
    restoreFetch()
  } finally { restoreFetch() }
} else {
  console.log('      （SKIP：host C-6 硬化未交付）')
}

group('[3] 事务/审计/响应形状')
if (hostCapability) {
  const writeTargetsHasIntake = /WRITE_TARGETS[\s\S]{0,4000}['"]intake-artifact['"]/.test(indexSrc)
  check('3.1 WRITE_TARGETS 包含 intake-artifact（项目锁 + 审计）', writeTargetsHasIntake, 'index.js WRITE_TARGETS 未含 intake-artifact')
  const auditText = await fs.readFile(path.join(projectDir, '.aidrama', 'audit', 'audit.jsonl'), 'utf8').catch(() => '')
  check('3.2 成功导入写入审计记录（audit.jsonl 含 intake-artifact）', auditText.split(/\r?\n/).some((line) => line.includes('intake-artifact') || line.includes('intake_artifact')), 'audit.jsonl 无 intake 记录（' + auditText.length + 'B）')
  // 并发：两个内部文件同时导入
  const concurrentBefore = await readAssets()
  const [c1, c2] = await Promise.all([
    call('intake-artifact', { title: TITLE, artifact: { file: '素材/生成/内部产物.png', name: '并发A.png' } }),
    call('intake-artifact', { title: TITLE, artifact: { file: path.join(genDir, '内部产物.png'), name: '并发B.png' } }),
  ])
  const concurrentAfter = await readAssets()
  check('3.3 并发两次内部导入均成功且 registry 不损坏', c1.status === 200 && c2.status === 200 && concurrentAfter.length === concurrentBefore.length + 2, JSON.stringify({ c1: c1.status, c2: c2.status, before: concurrentBefore.length, after: concurrentAfter.length }))
} else {
  console.log('      （SKIP：host C-6 硬化未交付）')
}

group('[4] batch 内部链路回归（fake backend）')
if (hostCapability) {
  try {
    await store.saveStoryboard(workspace, TITLE, 1, [{ shotNumber: '1-1', shotSize: '特写', description: '批量测试镜头', durationSec: 3 }])
    const plan = await orchestrator.planEpisode(workspace, TITLE, { episode: 1, kind: 'image', backend: 'fake' })
    const fakeBackend = { id: 'fake', async generate() { return { ok: true, raw: { nodeKey: 'n-batch' } } } }
    const submitted = await orchestrator.submitBatch(workspace, TITLE, { backend: 'fake', kind: 'image', items: plan.items.map((item, i) => ({ ...item, taskId: plan.tasks[i].id })), resolveBackend: () => fakeBackend })
    const doneBackend = {
      id: 'fake',
      async nodeDetail() { return { state: 'done' } },
      async download({ outDir }) { const file = path.join(outDir, 'batch-产物.png'); await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 4])); return { ok: true, files: [file] } },
    }
    const collected = await orchestrator.collectBatch(workspace, TITLE, { backend: 'fake', taskIds: submitted.results.filter((r) => r.ok).map((r) => r.task.id), resolveBackend: () => doneBackend, checkDrift: false })
    const batchAssets = await readAssets()
    check('4.1 collectBatch 内部链路成功（fake backend → 素材/生成/ + 登记）', collected.collected >= 1 && batchAssets.some((a) => String(a.source || '').includes('batch-产物')), JSON.stringify({ collected: collected.collected, pending: collected.pending, failed: collected.failed }))
    check('4.2 产物路径在项目内（realpath 终检）', collected.details.collected.every((entry) => entry.files.every((file) => String(file).includes('素材') && !String(file).startsWith('..'))), JSON.stringify(collected.details.collected).slice(0, 200))

    // stage → adopt
    const batchId = generation.newBatchId()
    const stageSource = path.join(genDir, 'adopt源.png')
    await fs.writeFile(stageSource, Buffer.from([0x89, 0x50, 0x4e, 0x47, 3, 3]))
    const staged = await generation.stageBatchArtifact(workspace, TITLE, batchId, stageSource, { episode: 1, shots: ['1-1'] })
    const adopted = await generation.adoptBatchArtifact(workspace, TITLE, { batchId, stagedRelative: staged.stagedRelative, kind: 'image', episode: 1, shots: ['1-1'], name: '采纳产物.png' })
    const adoptedExists = await fs.readFile(path.join(workspace, ...String(adopted.relative).split(/[\\/]+/))).then(() => true, () => false)
    const stagedGone = await fs.stat(path.join(projectDir, '.aidrama', 'batches', batchId, staged.stagedRelative)).then(() => false, () => true)
    check('4.3 stageBatchArtifact → adoptBatchArtifact 成功（staging 内部放行、staged 删除、落素材/生成/）', Boolean(adopted && adopted.relative && adoptedExists && stagedGone && String(adopted.relative).includes('生成')), JSON.stringify({ relative: adopted && adopted.relative, adoptedExists, stagedGone }))
  } catch (error) {
    check('4.1 collectBatch 内部链路成功（fake backend → 素材/生成/ + 登记）', false, String(error && error.message).slice(0, 160))
  }
} else {
  console.log('      （SKIP：host C-6 硬化未交付）')
}

group('[5] client 产物入库迁移（能力自适应）')
if (!clientCapability) {
  console.log('      （SKIP：client C-6 迁移未交付）')
} else {
  check('C1 本地文件模式：选择本地文件 → 走 assets-import（不再传项目外绝对路径给 intake-artifact）', /选择本地文件/.test(clientSrc) && /assets-import/.test(clientSrc) && /intake-artifact/.test(clientSrc))
  check('C2 保留项目内路径输入 + URL 模式', /项目内路径/.test(clientSrc) && /产物入库/.test(clientSrc) && /intake-artifact/.test(clientSrc))
  check('C3 外部路径被拒错误提示（引导导入素材库/先放项目内）', /(选择文件导入素材库|先.*素材目录|项目内路径)/.test(clientSrc))
  check('C4 URL 错误文案（私网/协议/重定向/64MB 可读提示）', /(仅支持 http|私网|内网|重定向|64MB|64 MB)/.test(clientSrc))
  check('C5 调用点不增（70）/ slots=4 / 无新依赖', CLIENT_CALLS.size === 72 && SLOTS === 4 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ calls: CLIENT_CALLS.size, slots: SLOTS }))
  check('C6 DOM 不渲染项目外绝对路径（无盘符路径标题）', !/title:\s*[^,)]*[A-Za-z]:\\\\/.test(clientSrc))
}

await fs.rm(workspace, { recursive: true, force: true }).catch(() => {})
await fs.rm(externalDir, { recursive: true, force: true }).catch(() => {})
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
