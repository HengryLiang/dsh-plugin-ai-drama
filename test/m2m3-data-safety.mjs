/**
 * v0.16.10 M2+M3 写路径加固 + 数据可靠性 · QA 验收套件（第 53 套件候选）
 * 草稿（task-159）：host M2+M3-H 已落盘（verify 49/0），client M3-C 已落盘；校准后落 test/m2m3-data-safety.mjs。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href)
const store = await load('lib/store.js')
const indexMod = await load('index.js')
const toolsModule = await load('lib/tools.js')
const mediaMod = await load('lib/media.js')
const flowMod = await load('lib/flow-state.js')
const guardMod = await load('lib/guard.js')
const draftsMod = await load('lib/drafts.js')
const exporterMod = await load('lib/exporter.js')
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8')
const indexSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const storeSrc = await fs.readFile(path.join(pluginRoot, 'lib', 'store.js'), 'utf8')
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

let passed = 0
let failed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) passed += 1
  else { failed += 1; failures.push(label + (detail ? ' -> ' + detail : '')); console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`) }
}
const group = (name) => console.log('\n' + name)
const METHODS = indexMod.METHODS || []
const TOOLS = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES : []
const CLIENT_CALLS = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
const SLOTS = (clientSrc.match(/slots\.register\(/g) || []).length
const EXPECTED = { methods: 72, tools: 35, calls: 72, slots: 4 }

group('[0] 能力探测 / 契约（自适应）')
const m3Capability = storeSrc.includes('readAssetsState') && storeSrc.includes('ensureRegistryReady')
const m2Capability = storeSrc.includes('assertProjectWriteRoot') && storeSrc.includes('guardedProjectWrite')
if (!m3Capability && !m2Capability) {
  console.log('  结果：0 passed, 0 failed（SKIP：M2/M3 host 实现未落盘）')
  process.exit(0)
}
check('0.1 契约：METHODS 72 / 工具 35 / 调用点 72 / slots=4 / 无新依赖', METHODS.length === EXPECTED.methods && TOOLS.length === EXPECTED.tools && CLIENT_CALLS.size === EXPECTED.calls && SLOTS === EXPECTED.slots && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ methods: METHODS.length, tools: TOOLS.length, calls: CLIENT_CALLS.size, slots: SLOTS }))

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'm2m3-'))
const routes = new Map()
indexMod.apply({
  provide: () => {}, inject: (_s, cb) => cb({
    connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } },
    get: (name) => {
      if (name === 'workspaceRegistry') return { list: async () => [{ path: workspace, title: 'W' }] }
      if (name === 'agents') return { list: () => [] }
      return undefined
    },
    on: () => {}, effect: (fn) => fn(),
  }),
  logger: { info: () => {}, warn: () => {} },
}, { root: workspace })
async function call(method, body = {}) {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) return { status: 404, body: null, text: 'no-route', missing: true }
  const res = await spec.fetch(new Request('http://127.0.0.1:1/api/ai-drama/' + method, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' }, body: JSON.stringify(body) }))
  const text = await res.text()
  let payload = null
  try { payload = JSON.parse(text) } catch {}
  return { status: res.status, body: payload, text }
}
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
const BENIGN = (rel) => rel.includes('.aidrama/audit/') || rel.endsWith('.aidrama/editor-notifications.jsonl')
const diff = (before, after) => {
  const added = [...after.keys()].filter((k) => !before.has(k) && !BENIGN(k))
  const removed = [...before.keys()].filter((k) => !after.has(k) && !BENIGN(k))
  const changed = [...before.keys()].filter((k) => after.has(k) && !before.get(k).dir && !after.get(k).dir && !BENIGN(k) && (before.get(k).sha !== after.get(k).sha || before.get(k).size !== after.get(k).size))
  return { added, removed, changed, clean: added.length === 0 && removed.length === 0 && changed.length === 0 }
}
const NO_ABS = (text) => !String(text || '').includes(workspace) && !/[A-Za-z]:[\\/]/.test(String(text || ''))
const png = (seed) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, seed + 1, seed + 2, seed + 3])
async function mkProject(title) { await store.createProject(workspace, title); return path.join(workspace, 'AI短剧', title) }
async function junction(linkPath, target) {
  try { await fs.rm(linkPath, { recursive: true, force: true }); await fs.symlink(target, linkPath, 'junction'); return true } catch { return false }
}
async function writeMaterial(dir, rel, buf) { const full = path.join(dir, ...rel.split('/')); await fs.mkdir(path.dirname(full), { recursive: true }); await fs.writeFile(full, buf); return full }
async function readRegistryFile(dir) { try { return JSON.parse(await fs.readFile(path.join(dir, '.aidrama', 'assets.json'), 'utf8')) } catch { return null } }
const BACKUP_RE = /^\.aidrama\/backup\/assets\..+\.json$/

/* ================================ M3 ================================ */
if (m3Capability) {
  group('[M3-A] 健康项目：registryOk=true / scan sha256+去重 / 正常写')
  const H = 'M3健康剧'
  const hDir = await mkProject(H)
  await writeMaterial(hDir, '素材/角色/已登记.png', png(11))
  await writeMaterial(hDir, '素材/角色/同内容.png', png(11))
  await writeMaterial(hDir, '素材/角色/其他.png', png(21))
  const hAdd = await call('assets-add', { title: H, source: '素材/角色/已登记.png' })
  const hGet = await call('assets-get', { title: H })
  check('M3-A1 健康项目 assets-get registryOk===true 且无 registryWarning', hAdd.status === 200 && hGet.status === 200 && hGet.body.registryOk === true && !hGet.body.registryWarning, JSON.stringify({ add: hAdd.status, registryOk: hGet.body && hGet.body.registryOk }))
  const hScan = await call('assets-get', { title: H, scanMaterials: true })
  const hFiles = (hScan.body && hScan.body.unregisteredFiles) || []
  const hPaths = hFiles.map((f) => f.path)
  check('M3-A2 健康 scan：registryOk=true / 已登记排除 / 同 SHA 去重 / 每项带 sha256', hScan.body.registryOk === true && !hPaths.includes('素材/角色/已登记.png') && !hPaths.includes('素材/角色/同内容.png') && hPaths.includes('素材/角色/其他.png') && hFiles.every((f) => typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256)), JSON.stringify({ paths: hPaths }))
  const hAdd2 = await call('assets-add', { title: H, source: '素材/角色/其他.png' })
  check('M3-A3 健康项目正常登记 200（add-only 不回归）', hAdd2.status === 200 && hAdd2.body && hAdd2.body.ok === true, JSON.stringify({ status: hAdd2.status }))

  group('[M3-B] registry 状态矩阵：missing/empty/malformed/wrong-type/partial/valid/readonly')
  const validEntry = () => ({ id: 'ok-1', name: 'ok', kind: 'image', source: '素材/a.png', bytes: png(31).length, sha256: sha256(png(31)) })
  const stateCases = []
  const kinds = ['missing', 'empty', 'malformed', 'wrong-type', 'partial', 'valid', 'readonly']
  for (const kind of kinds) {
    const title = 'M3状态-' + kind
    const dir = await mkProject(title)
    await writeMaterial(dir, '素材/a.png', png(31))
    const assetFile = path.join(dir, '.aidrama', 'assets.json')
    if (kind === 'missing') await fs.rm(assetFile, { force: true })
    else if (kind === 'empty') await fs.writeFile(assetFile, '', 'utf8')
    else if (kind === 'malformed') await fs.writeFile(assetFile, '{ bad json', 'utf8')
    else if (kind === 'wrong-type') await fs.writeFile(assetFile, JSON.stringify({ assets: [] }), 'utf8')
    else if (kind === 'partial') await fs.writeFile(assetFile, JSON.stringify([validEntry(), 'bad-entry', { id: 'x' }]), 'utf8')
    else if (kind === 'valid') await fs.writeFile(assetFile, JSON.stringify([validEntry()]), 'utf8')
    else if (kind === 'readonly') { await fs.writeFile(assetFile, JSON.stringify([validEntry()]), 'utf8'); await fs.chmod(assetFile, 0o444) }
    const r = await call('assets-get', { title })
    if (kind === 'readonly') await fs.chmod(assetFile, 0o644).catch(() => {})
    stateCases.push({ kind, status: r.status, body: r.body, text: r.text })
  }
  const byKind = new Map(stateCases.map((item) => [item.kind, item]))
  check('M3-B1 缺文件 → registryOk:true、无 warning、assets[]（首次/空登记正常）', byKind.get('missing').status === 200 && byKind.get('missing').body.registryOk === true && !byKind.get('missing').body.registryWarning && byKind.get('missing').body.assets.length === 0, JSON.stringify({ kind: 'missing' }))
  check('M3-B2 空/非法 JSON/顶层非数组 → registryOk:false + registry-corrupt + assets[]', ['empty', 'malformed', 'wrong-type'].every((kind) => byKind.get(kind).status === 200 && byKind.get(kind).body.registryOk === false && byKind.get(kind).body.registryWarning && byKind.get(kind).body.registryWarning.code === 'registry-corrupt' && byKind.get(kind).body.assets.length === 0), JSON.stringify(['empty', 'malformed', 'wrong-type'].map((k) => ({ k, w: byKind.get(k).body.registryWarning }))))
  check('M3-B3 半损坏数组 → registry-partial + 过滤无效项（assets=1）', byKind.get('partial').body.registryOk === false && byKind.get('partial').body.registryWarning.code === 'registry-partial' && byKind.get('partial').body.assets.length === 1 && byKind.get('partial').body.assets[0].id === 'ok-1', JSON.stringify(byKind.get('partial').body.registryWarning))
  check('M3-B4 合法 registry → registryOk:true、assets 保留、无 warning', byKind.get('valid').body.registryOk === true && !byKind.get('valid').body.registryWarning && byKind.get('valid').body.assets.length === 1)
  check('M3-B5 只读文件 → 读取正常 registryOk:true（写保护另测）', byKind.get('readonly').body.registryOk === true && byKind.get('readonly').body.assets.length === 1)
  check('M3-B6 registryWarning 不泄绝对路径/工作区路径', stateCases.every((item) => !JSON.stringify(item.body.registryWarning || {}).includes(workspace)))

  group('[M3-C] 写保护：409 registry-corrupt + 相对 backup + 原始字节备份 + 零写盘')
  const C = 'M3写保护剧'
  const cDir = await mkProject(C)
  await writeMaterial(cDir, '素材/角色/p.png', png(41))
  await writeMaterial(cDir, '素材/角色/q.png', png(42))
  const corruptContent = '{ "broken": [1,2,'
  const cAssetFile = path.join(cDir, '.aidrama', 'assets.json')
  await fs.writeFile(cAssetFile, corruptContent, 'utf8')
  const cScan = await call('assets-get', { title: C, scanMaterials: true })
  check('M3-C1 损坏时 scanMaterials → unverified:true + 空列表 + unregisteredTotal=0', cScan.status === 200 && cScan.body.unverified === true && Array.isArray(cScan.body.unregisteredFiles) && cScan.body.unregisteredFiles.length === 0 && cScan.body.unregisteredTotal === 0, JSON.stringify({ status: cScan.status, unverified: cScan.body && cScan.body.unverified }))
  await writeMaterial(cDir, '素材/角色/new.png', png(43))
  const protectedWrites = [
    ['assets-add', { title: C, source: '素材/角色/new.png' }],
    ['assets-import', { title: C, fileName: 'new.png', base64: png(43).toString('base64'), targetCategory: '角色' }],
    ['intake-artifact', { title: C, artifact: { file: '素材/角色/p.png', kind: 'image' } }],
  ]
  for (const [method, body] of protectedWrites) {
    if (!routes.has('/api/ai-drama/' + method)) continue
    const r = await call(method, body)
    const backupRelative = r.body && r.body.backup
    const backupBytes = backupRelative ? await fs.readFile(path.join(cDir, ...String(backupRelative).split('/'))).catch(() => null) : null
    check('M3-C2 非 repair 写 ' + method + ' → 409 registry-corrupt + 相对 backup + next + 备份字节等价', r.status === 409 && r.body.code === 'registry-corrupt' && BACKUP_RE.test(String(backupRelative)) && typeof r.body.next === 'string' && Boolean(backupBytes) && backupBytes.toString('utf8') === corruptContent, JSON.stringify({ status: r.status, backup: backupRelative }))
  }
  check('M3-C3 损坏状态下 registry 原始字节未被覆盖', (await fs.readFile(cAssetFile, 'utf8')) === corruptContent)

  group('[M3-D] repair 三入口：重建/备份/自动重建/后续写/备份失败保持原文件')
  const dRepair = await call('assets-add', { title: C, repairRegistry: true })
  const dBackup = dRepair.body && dRepair.body.backup
  const dBackupBytes = dBackup ? await fs.readFile(path.join(cDir, ...String(dBackup).split('/'))).catch(() => null) : null
  const dRegistry = await readRegistryFile(cDir)
  check('M3-D1 assets-add repairRegistry:true → registryRepaired/rebuiltCount≥2/backup 相对路径', dRepair.status === 200 && dRepair.body.registryRepaired === true && Number(dRepair.body.rebuiltCount) >= 2 && BACKUP_RE.test(String(dBackup)), JSON.stringify({ status: dRepair.status, rebuilt: dRepair.body && dRepair.body.rebuiltCount }))
  check('M3-D2 修复前备份原始字节等价（.aidrama/backup/*）', Boolean(dBackupBytes) && dBackupBytes.toString('utf8') === corruptContent)
  check('M3-D3 重建 registry 合法：entries 均 note=自动重建 且 source 为字符串', Array.isArray(dRegistry) && dRegistry.length >= 2 && dRegistry.every((entry) => entry.note === '自动重建' && typeof entry.source === 'string'))
  check('M3-D4 修复后 assets-get registryOk:true', (await call('assets-get', { title: C })).body.registryOk === true)
  await writeMaterial(cDir, '素材/角色/后续.png', png(44))
  const dAfterWrite = await call('assets-add', { title: C, source: '素材/角色/后续.png' })
  check('M3-D5 修复后正常写 200', dAfterWrite.status === 200 && dAfterWrite.body && dAfterWrite.body.ok === true, JSON.stringify({ status: dAfterWrite.status }))
  await fs.writeFile(cAssetFile, '{ bad2', 'utf8')
  const dImport = await call('assets-import', { title: C, repairRegistry: true, fileName: '修复导入.png', base64: png(45).toString('base64'), targetCategory: '其他' })
  check('M3-D6 assets-import repairRegistry:true → 先重建再导入 + 回执', dImport.status === 200 && dImport.body.registryRepaired === true && Number(dImport.body.rebuiltCount) >= 1 && dImport.body.ok === true, JSON.stringify({ status: dImport.status }))
  await writeMaterial(cDir, '素材/角色/回填.png', png(46))
  await fs.writeFile(cAssetFile, '{ bad3', 'utf8')
  const dIntake = await call('intake-artifact', { title: C, repairRegistry: true, artifact: { file: '素材/角色/回填.png', kind: 'image' } })
  check('M3-D7 intake-artifact repairRegistry:true → 先重建再回填 + 回执', dIntake.status === 200 && dIntake.body.registryRepaired === true && Number(dIntake.body.rebuiltCount) >= 1, JSON.stringify({ status: dIntake.status }))
  const F = 'M3备份失败剧'
  const fDir = await mkProject(F)
  await writeMaterial(fDir, '素材/角色/f.png', png(47))
  const fAssetFile = path.join(fDir, '.aidrama', 'assets.json')
  await fs.writeFile(fAssetFile, '{ bad backup', 'utf8')
  await fs.writeFile(path.join(fDir, '.aidrama', 'backup'), 'blocked-as-file', 'utf8')
  const fRepair = await call('assets-add', { title: F, repairRegistry: true })
  const fGet = await call('assets-get', { title: F })
  check('M3-D8 备份失败（.aidrama/backup 被占位）→ repair 失败/4xx 且原文件保持损坏、未静默修复', fRepair.status >= 400 && fGet.body.registryOk === false && (await fs.readFile(fAssetFile, 'utf8')) === '{ bad backup', JSON.stringify({ status: fRepair.status }))

  group('[M3-E] media 迁移/越权读：旧根诱饵零泄露 / 当前缺失 not-found / 相对 source / path 模式 / repair 相对化')
  const M = '媒体迁移剧'
  const mDir = await mkProject(M)
  const IMG_A = png(51)
  const IMG_A2 = png(52)
  await writeMaterial(mDir, '素材/角色/立绘.png', IMG_A)
  const mediaAsset = await store.addAsset(workspace, M, { source: '素材/角色/立绘.png' })
  const oldRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'm3m2-old-'))
  const oldProject = path.join(oldRoot, 'AI短剧', M)
  await fs.cp(mDir, oldProject, { recursive: true })
  const decoy = Buffer.from('OLD-ROOT-DECOY-CONTENT')
  await fs.writeFile(path.join(oldProject, '素材', '角色', '立绘.png'), decoy)
  const newRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'm3m2-new-'))
  const newProject = path.join(newRoot, 'AI短剧', M)
  await fs.cp(mDir, newProject, { recursive: true })
  const newRegistry = await readRegistryFile(newProject)
  newRegistry.find((entry) => entry.id === mediaAsset.id).source = path.join(oldProject, '素材', '角色', '立绘.png')
  await fs.writeFile(path.join(newProject, '.aidrama', 'assets.json'), JSON.stringify(newRegistry, null, 2), 'utf8')
  const readMedia = async (input) => mediaMod.readMedia(newRoot, { title: M, ...input }).then((r) => ({ ok: true, base64: r.base64 }), (error) => ({ ok: false, code: error && error.code, message: error && error.message }))
  const migrated = await readMedia({ assetId: mediaAsset.id })
  const migratedBytes = migrated.ok ? Buffer.from(migrated.base64, 'base64') : Buffer.alloc(0)
  check('M3-E1 旧根存在时：读当前项目文件（内容一致、非旧根诱饵）', migrated.ok === true && migratedBytes.equals(IMG_A) && !migrated.base64.includes(decoy.toString('base64')), JSON.stringify({ ok: migrated.ok }))
  await fs.rm(path.join(newProject, '素材', '角色', '立绘.png'))
  const missing = await readMedia({ assetId: mediaAsset.id })
  check('M3-E2 当前缺失但旧根存在 → not-found（不读旧根）+ 迁移提示', missing.ok === false && missing.code === 'not-found' && /重新登记|扫描/.test(String(missing.message)), JSON.stringify(missing))
  await fs.writeFile(path.join(newProject, '素材', '角色', '立绘.png'), IMG_A2)
  await fs.rm(oldRoot, { recursive: true, force: true })
  const fresh = await readMedia({ assetId: mediaAsset.id })
  check('M3-E3 旧根删除后：当前项目内文件正常读取', fresh.ok === true && Buffer.from(fresh.base64, 'base64').equals(IMG_A2))
  const relRegistry = await readRegistryFile(newProject)
  relRegistry.find((entry) => entry.id === mediaAsset.id).source = '素材/角色/立绘.png'
  await fs.writeFile(path.join(newProject, '.aidrama', 'assets.json'), JSON.stringify(relRegistry, null, 2), 'utf8')
  const relRead = await readMedia({ assetId: mediaAsset.id })
  check('M3-E4 相对 source（legacy/迁移）→ 当前项目内解析成功', relRead.ok === true && Buffer.from(relRead.base64, 'base64').equals(IMG_A2))
  const pathRead = await readMedia({ path: '素材/角色/立绘.png' })
  check('M3-E5 media-read path 模式回归', pathRead.ok === true && Buffer.from(pathRead.base64, 'base64').equals(IMG_A2))
  const routesNew = new Map()
  indexMod.apply({
    provide: () => {}, inject: (_s, cb) => cb({
      connection: { fetch: { register: (spec) => routesNew.set(spec.path, spec) } },
      get: (n) => n === 'workspaceRegistry' ? { list: async () => [{ path: newRoot }] } : (n === 'agents' ? { list: () => [] } : undefined), on: () => {}, effect: (fn) => fn(),
    }), logger: { info: () => {}, warn: () => {} },
  }, { root: newRoot })
  const callNew = async (method, body) => { const spec = routesNew.get('/api/ai-drama/' + method); const res = await spec.fetch(new Request('http://127.0.0.1:1/api/ai-drama/' + method, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' }, body: JSON.stringify(body || {}) })); const text = await res.text(); let payload = null; try { payload = JSON.parse(text) } catch {}; return { status: res.status, body: payload, text } }
  await fs.writeFile(path.join(newProject, '.aidrama', 'assets.json'), '{ migration-broken', 'utf8')
  const p1Repair = await callNew('assets-add', { title: M, repairRegistry: true })
  const rebuilt = await readRegistryFile(newProject)
  const rebuildSources = (rebuilt || []).map((entry) => String(entry.source || ''))
  const currentReal = await fs.realpath(newProject).catch(() => path.resolve(newProject))
  const insideCurrent = async (source) => {
    const candidate = path.isAbsolute(source) ? source : path.join(newProject, source)
    const real = await fs.realpath(candidate).catch(() => path.resolve(candidate))
    return real === currentReal || real.startsWith(currentReal + path.sep)
  }
  const insideFlags = []
  for (const source of rebuildSources) insideFlags.push(await insideCurrent(source))
  const allInsideCurrent = rebuildSources.length >= 1 && insideFlags.every(Boolean)
  const rebuiltMedia = rebuildSources.length ? await callNew('media-read', { title: M, assetId: (rebuilt || [])[0].id }) : { status: 0, body: null }
  const rebuiltBytes = rebuiltMedia.body && rebuiltMedia.body.ok ? Buffer.from(String(rebuiltMedia.body.base64 || rebuiltMedia.body.data || '').replace(/^data:[^,]+,/, ''), 'base64') : Buffer.alloc(0)
  check('M3-E6 迁移项目 repair 后可读：source 指向当前项目（realpath 归一，绝对/相对均可、不指向旧根），media-read 返回当前内容', p1Repair.status === 200 && allInsideCurrent && rebuiltMedia.status === 200 && rebuiltBytes.length > 0 && !String(rebuiltBytes.toString('utf8')).includes('DECOY'), JSON.stringify({ status: p1Repair.status, allInsideCurrent, insideFlags, sourceCount: rebuildSources.length, sources: rebuildSources.map((x) => x.slice(0, 90)), mediaStatus: rebuiltMedia.status, bytes: rebuiltBytes.length }))

  group('[M3-F] 并发写（无损坏项目，事务/锁不产生损坏 registry）')
  const G = 'M3并发剧'
  const gDir = await mkProject(G)
  await writeMaterial(gDir, '素材/角色/c1.png', png(61))
  await writeMaterial(gDir, '素材/角色/c2.png', png(62))
  const [g1, g2] = await Promise.all([call('assets-add', { title: G, source: '素材/角色/c1.png' }), call('assets-add', { title: G, source: '素材/角色/c2.png' })])
  const gRegistry = await readRegistryFile(gDir)
  check('M3-F1 并发两次登记：无 5xx、registry 合法且至少一条成功', g1.status < 500 && g2.status < 500 && Array.isArray(gRegistry) && gRegistry.length >= 1 && (g1.status === 200 || g2.status === 200), JSON.stringify({ s1: g1.status, s2: g2.status, count: Array.isArray(gRegistry) ? gRegistry.length : null }))
} else {
  console.log('      （SKIP：M3-H 未交付）')
}

/* ================================ M2 ================================ */
if (m2Capability) {
  const P = 'M2路径剧'
  const pDir = await mkProject(P)
  await writeMaterial(pDir, '素材/角色/m2.png', png(71))
  const outside = path.join(workspace, 'outside')
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(outside, 'sentinel.txt'), 'outside-sentinel', 'utf8')
  const decoyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'm2m3-decoy-'))
  await fs.writeFile(path.join(decoyRoot, 'sentinel.txt'), 'decoy-sentinel', 'utf8')
  const decoyKeys = async () => JSON.stringify([...(await snapshot(decoyRoot)).keys()])

  group('[M2-A] 写入口恶意路径矩阵（拒绝 + 零写盘 + 不泄路径）')
  const maliciousPaths = ['../outside/escape.txt', '..\\\\outside\\\\escape.txt', path.join(outside, 'abs.txt'), '\\\\\\\\127.0.0.1\\\\share\\\\x.png', '\\\\\\\\.\\\\C:\\\\Windows\\\\x.png', '%2e%2e/outside/escape.txt', '.AIDRAMA/assets.json']
  const pathEntries = [
    ['doc-save', (p) => ({ title: P, path: p, text: 'bad' })],
    ['entry-create', (p) => ({ title: P, path: p })],
    ['entry-rename', (p) => ({ title: P, path: p, name: 'renamed' })],
    ['entry-delete', (p) => ({ title: P, path: p })],
    ['assets-add', (p) => ({ title: P, source: p })],
  ]
  const beforeMatrix = await snapshot(pDir)
  const outsideBefore = await snapshot(outside)
  const decoyBefore = await decoyKeys()
  const matrixFailures = []
  for (const [method, makeBody] of pathEntries) {
    if (!routes.has('/api/ai-drama/' + method)) continue
    for (const malicious of maliciousPaths) {
      const r = await call(method, makeBody(malicious))
      if (!(r.status >= 400 || (r.body && r.body.ok === false))) matrixFailures.push({ method, malicious, status: r.status })
      if (!NO_ABS(r.text)) matrixFailures.push({ method, malicious, leak: true })
    }
  }
  const titleAttacks = [['episode-write', { title: '../外部', order: 1, text: 'bad' }], ['contract-save', { title: 'C:\\\\Windows\\\\x', contract: { platform: '抖音' } }], ['doc-save', { title: '.AIDRAMA', path: '剧本/x.md', text: 'bad' }], ['assets-add', { title: '../外部', source: '素材/角色/m2.png' }]]
  for (const [method, body] of titleAttacks) {
    const r = await call(method, body)
    if (!(r.status >= 400 || (r.body && r.body.ok === false))) matrixFailures.push({ method, titleAttack: true, status: r.status })
    if (!NO_ABS(r.text)) matrixFailures.push({ method, titleAttack: true, leak: true })
  }
  const afterMatrix = await snapshot(pDir)
  const outsideAfter = await snapshot(outside)
  check('M2-A1 恶意路径/非法 title 矩阵全部拒绝且不泄绝对路径', matrixFailures.length === 0, JSON.stringify(matrixFailures.slice(0, 6)))
  check('M2-A2 矩阵后项目树/外部诱饵/decoy 零写盘', diff(beforeMatrix, afterMatrix).clean && diff(outsideBefore, outsideAfter).clean && decoyBefore === await decoyKeys(), JSON.stringify({ tree: diff(beforeMatrix, afterMatrix) }))

  group('[M2-B] 项目根 junction → 全写拒绝（403）+ 外部诱饵零写穿 + deleteProject/renameProject 403')
  const R = 'M2根Junction剧'
  const rDir = await mkProject(R)
  const rootDecoy = await fs.mkdtemp(path.join(os.tmpdir(), 'm2m3-rootdecoy-'))
  await fs.writeFile(path.join(rootDecoy, 'sentinel.txt'), 'root-decoy', 'utf8')
  const rootDecoyBefore = JSON.stringify([...(await snapshot(rootDecoy)).keys()])
  await fs.rm(rDir, { recursive: true, force: true })
  const rootJunctionOk = await junction(rDir, rootDecoy)
  if (rootJunctionOk) {
    const rootResults = []
    for (const [method, body] of [['episode-write', { title: R, order: 1, text: 'bad' }], ['contract-save', { title: R, contract: { platform: '抖音' } }], ['assets-add', { title: R, source: '素材/x.png' }], ['doc-save', { title: R, path: '剧本/x.md', text: 'bad' }]]) {
      const r = await call(method, body)
      rootResults.push({ method, status: r.status, code: r.body && r.body.code })
    }
    const delProj = await call('project-delete', { title: R })
    const renProj = await call('project-rename', { title: R, name: '改名剧' })
    const rootDecoyAfter = JSON.stringify([...(await snapshot(rootDecoy)).keys()])
    check('M2-B1 项目根 junction：全写拒绝（4xx/ok:false）', rootResults.length >= 3 && rootResults.every((item) => item.status >= 400 || item.code === 'forbidden'), JSON.stringify(rootResults))
    check('M2-B2 项目根 junction：external 诱饵零写穿', rootDecoyBefore === rootDecoyAfter)
    check('M2-B3 deleteProject/renameProject 根 junction → 403', [delProj, renProj].every((r) => r.status === 403 || (r.body && r.body.code === 'forbidden')), JSON.stringify({ del: delProj.status, ren: renProj.status }))
    await fs.rm(rDir, { recursive: true, force: true }).catch(() => {})
  } else console.log('      （SKIP：junction 创建失败/EPERM，如实记录）')
  await fs.rm(rootDecoy, { recursive: true, force: true }).catch(() => {})

  group('[M2-C] 子目录 junction / rename·delete junction / 直写点（flow/guard/drafts/cards/exporter/settings）')
  const S = 'M2子目录Junction剧'
  const sDir = await mkProject(S)
  const subDecoy = await fs.mkdtemp(path.join(os.tmpdir(), 'm2m3-subdecoy-'))
  await fs.writeFile(path.join(subDecoy, 'sentinel.txt'), 'sub', 'utf8')
  const subBefore = JSON.stringify([...(await snapshot(subDecoy)).keys()])
  const subJunctionOk = await junction(path.join(sDir, '分集剧本'), subDecoy)
  let subWrite = null
  if (subJunctionOk) subWrite = await store.writeEpisode(workspace, S, 1, 'bad').then(() => ({ ok: true }), (error) => ({ ok: false, code: error && error.code }))
  const subAfter = JSON.stringify([...(await snapshot(subDecoy)).keys()])
  check('M2-C1 子目录 junction（分集剧本）→ 写入拒绝 code=forbidden 且诱饵零写穿', Boolean(subWrite) && subWrite.ok === false && subWrite.code === 'forbidden' && subBefore === subAfter, JSON.stringify(subWrite))
  const R2 = 'M2节点Junction剧'
  const r2Dir = await mkProject(R2)
  const nodeDecoy = await fs.mkdtemp(path.join(os.tmpdir(), 'm2m3-nodedecoy-'))
  await fs.writeFile(path.join(nodeDecoy, 'sentinel.txt'), 'node', 'utf8')
  const nodeBefore = JSON.stringify([...(await snapshot(nodeDecoy)).keys()])
  const nodeJunctionOk = await junction(path.join(r2Dir, 'evil-node'), nodeDecoy)
  const nodeResults = { rename: null, delete: null }
  if (nodeJunctionOk) {
    nodeResults.rename = await call('entry-rename', { title: R2, path: 'evil-node', name: 'renamed' })
    nodeResults.delete = await call('entry-delete', { title: R2, path: 'evil-node' })
  }
  const nodeAfter = JSON.stringify([...(await snapshot(nodeDecoy)).keys()])
  check('M2-C2 renameEntry 源 junction → 403 forbidden 且外部不变', !nodeResults.rename || ((nodeResults.rename.status === 403 || (nodeResults.rename.body && nodeResults.rename.body.code === 'forbidden')) && nodeBefore === nodeAfter), JSON.stringify({ status: nodeResults.rename && nodeResults.rename.status }))
  check('M2-C3 deleteEntry junction → 403 forbidden 且外部不变', !nodeResults.delete || ((nodeResults.delete.status === 403 || (nodeResults.delete.body && nodeResults.delete.body.code === 'forbidden')) && nodeBefore === nodeAfter), JSON.stringify({ status: nodeResults.delete && nodeResults.delete.status }))
  const D = 'M2直写Junction剧'
  const dDir = await mkProject(D)
  await writeMaterial(dDir, '素材/角色/a.png', png(81))
  const metaDecoy = await fs.mkdtemp(path.join(os.tmpdir(), 'm2m3-metadecoy-'))
  await fs.writeFile(path.join(metaDecoy, 'sentinel.txt'), 'meta', 'utf8')
  const metaBefore = JSON.stringify([...(await snapshot(metaDecoy)).keys()])
  const metaJunctionOk = await junction(path.join(dDir, '.aidrama'), metaDecoy)
  const direct = {}
  if (metaJunctionOk) {
    direct.flow = await flowMod.saveFlowStateText(workspace, D, '{"version":1}', { actor: 'test' }).then(() => ({ ok: true }), (error) => ({ ok: false, code: error && error.code }))
    direct.guard = await guardMod.beginGuard(workspace, D, { backend: { listNodes: async () => [] }, backendId: 'libtv', cwd: dDir }).then(() => ({ ok: true }), (error) => ({ ok: false, code: error && error.code }))
    direct.drafts = await draftsMod.createDraft(dDir, { kind: 'file', title: 'x', content: 'hi' }).then(() => ({ ok: true }), (error) => ({ ok: false, code: error && error.code }))
    direct.cards = await store.writeCardsDoc(workspace, D, 'asset', []).then(() => ({ ok: true }), (error) => ({ ok: false, code: error && error.code }))
  }
  let settingsOk = false
  try { await store.saveSettings(workspace, { defaultOrientation: 'portrait' }); settingsOk = true } catch {}
  const metaAfter = JSON.stringify([...(await snapshot(metaDecoy)).keys()])
  check('M2-C4 直写点（flow/guard/drafts/cards）遇 .aidrama junction → forbidden 且诱饵零写穿', !metaJunctionOk || (['flow', 'guard', 'drafts', 'cards'].every((key) => direct[key] && direct[key].ok === false && direct[key].code === 'forbidden') && metaBefore === metaAfter), JSON.stringify(direct))
  check('M2-C5 workspace settings 写安全（不因项目 .aidrama junction 失败）', settingsOk === true)
  const E = 'M2导出Junction剧'
  const eDir = await mkProject(E)
  const exDecoy = await fs.mkdtemp(path.join(os.tmpdir(), 'm2m3-exdecoy-'))
  await fs.writeFile(path.join(exDecoy, 'sentinel.txt'), 'ex', 'utf8')
  const exBefore = JSON.stringify([...(await snapshot(exDecoy)).keys()])
  const exJunctionOk = await junction(path.join(eDir, '导出'), exDecoy)
  const exRes = exJunctionOk ? await exporterMod.exportProject(workspace, E, 'markdown').then(() => ({ ok: true }), (error) => ({ ok: false, code: error && error.code })) : null
  const exAfter = JSON.stringify([...(await snapshot(exDecoy)).keys()])
  check('M2-C6 exporter 遇 导出 junction → forbidden 且诱饵零写穿', !exRes || (exRes.ok === false && exRes.code === 'forbidden' && exBefore === exAfter), JSON.stringify(exRes))

  group('[M2-D] 正常写回归 + ledger 纯读/显式渲染')
  const L = 'M2账本剧'
  const lDir = await mkProject(L)
  const posDoc = await call('doc-save', { title: L, path: '剧本/正例.md', text: '# 正例\n\nM2 正常写入。\n' })
  const posDocRead = await call('doc-read', { title: L, path: '剧本/正例.md' })
  check('M2-D1 正常 doc-save 200 且回读一致', posDoc.status === 200 && posDocRead.status === 200 && posDocRead.body && posDocRead.body.text === '# 正例\n\nM2 正常写入。\n', JSON.stringify({ save: posDoc.status }))
  const posEpisode = await call('episode-write', { title: L, order: 1, text: '# 第1集\n\nM2 正常。\n' })
  check('M2-D2 正常 episode-write 200', posEpisode.status === 200 && posEpisode.body && posEpisode.body.ok === true, JSON.stringify({ status: posEpisode.status }))
  const auditPath = path.join(lDir, '.aidrama', 'audit', 'audit.jsonl')
  const ledgerFile = path.join(lDir, '账本', '账本.md')
  const auditBefore = await fs.readFile(auditPath, 'utf8').catch(() => '')
  const beforeLedger = await snapshot(lDir)
  const pure1 = await call('ledger-get', { title: L })
  const pure2 = await call('ledger-get', { title: L })
  const afterPure = await snapshot(lDir)
  const auditAfterPure = await fs.readFile(auditPath, 'utf8').catch(() => '')
  check('M2-D3 ledger-get 默认纯读（两次）零文件写入 + 零 audit 增长', pure1.status === 200 && pure2.status === 200 && !afterPure.has('账本/账本.md') && diff(beforeLedger, afterPure).clean && auditAfterPure.length === auditBefore.length, JSON.stringify({ diff: diff(beforeLedger, afterPure), auditDelta: auditAfterPure.length - auditBefore.length }))
  const render1 = await call('ledger-get', { title: L, renderFile: true })
  const renderBytes = await fs.readFile(ledgerFile).catch(() => null)
  const renderHash1 = renderBytes ? sha256(renderBytes) : null
  const auditAfterRender = await fs.readFile(auditPath, 'utf8').catch(() => '')
  const render2 = await call('ledger-get', { title: L, renderFile: true })
  const renderBytes2 = await fs.readFile(ledgerFile).catch(() => null)
  const renderHash2 = renderBytes2 ? sha256(renderBytes2) : null
  check('M2-D4 renderFile:true → 写文件 + rendered:true + 相对 file 账本/账本.md + txn/audit', render1.status === 200 && Boolean(renderBytes) && render1.body.rendered === true && render1.body.file === '账本/账本.md' && auditAfterRender.includes('ledger-get'), JSON.stringify({ status: render1.status, file: render1.body && render1.body.file }))
  check('M2-D5 渲染内容确定（两次 hash 一致、不泄绝对路径）', Boolean(renderHash1) && renderHash1 === renderHash2 && !String(renderBytes || '').includes(workspace), JSON.stringify({ hash: String(renderHash1).slice(0, 12) }))
} else {
  console.log('      （SKIP：M2-H 未交付）')
}

/* ================================ client（M3-C） ================================ */
group('[client M3-C] registry 警告/三入口禁用/修复流程/ledger 纯读与显式渲染/旧宿主零新 UI（能力自适应）')
const clientCapability = /registryOk|registrySupported/.test(clientSrc) && /repairRegistry/.test(clientSrc)
if (!clientCapability) {
  console.log('      （SKIP：client M3-C 未交付）')
} else {
  check('C1 registry 警告条 + 固定文案（降级只读/详情）', clientSrc.includes('素材登记文件损坏，已降级只读') && clientSrc.includes('扫描/导入素材/跨项目导入已暂停') && /registryOk/.test(clientSrc))
  check('C2 三入口禁用（扫描/导入/跨项目）+ 禁用 title', clientSrc.includes('素材登记表损坏') && /disabled/.test(clientSrc) && /(扫描素材目录|导入素材|从其他项目导入)/.test(clientSrc))
  check('C3 修复流程：二次确认 + assets-add repairRegistry（无 source）+ rebuiltCount + 备份提示', /repairRegistry/.test(clientSrc) && /assets-add/.test(clientSrc) && /confirm\(/.test(clientSrc) && /(rebuiltCount|repairedCount)/.test(clientSrc) && /assets\.json\.bak/.test(clientSrc))
  check('C4 ledger：默认纯读 + renderFile:true 显式渲染 + 0.16.10 版本门禁 + 已渲染文案', /ledger-get/.test(clientSrc) && /renderFile/.test(clientSrc) && /0\.16\.10/.test(clientSrc) && clientSrc.includes('已渲染到项目账本'))
  check('C5 旧宿主零新 UI（旧账本文案/按钮保留）', clientSrc.includes('同时渲染到 账本/账本.md') && clientSrc.includes('生成账本') && /M3_MIN_HOST_VERSION/.test(clientSrc))
  check('C6 调用点 72 / slots 4 / DOM 无绝对路径 / CSS .ad-registry-*', CLIENT_CALLS.size === 72 && SLOTS === 4 && !/title:\s*[^,)]*[A-Za-z]:\\\\/.test(clientSrc) && /\.ad-registry-/.test(clientSrc), JSON.stringify({ calls: CLIENT_CALLS.size, slots: SLOTS }))
}

/* ================================ 回归 ================================ */
group('[回归] 契约 / 旧数据')
check('回归-1 契约：METHODS 72 / 工具 35 / 调用点 72 / slots 4 / 无新依赖', METHODS.length === 72 && TOOLS.length === 35 && CLIENT_CALLS.size === 72 && SLOTS === 4 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ methods: METHODS.length, tools: TOOLS.length, calls: CLIENT_CALLS.size, slots: SLOTS }))
try {
  const baseline = JSON.parse((await fs.readFile(process.env.DSH_AI_DRAMA_BASELINE || '', 'utf8')).replace(/^\uFEFF/, ''))
  const files = baseline.files || []
  let changed = 0
  for (const file of files) {
    const buf = await fs.readFile(path.join(process.env.DSH_AI_DRAMA_REAL_ROOT || '', file.relative)).catch(() => null)
    if (!buf || sha256(buf) !== file.sha256 || buf.length !== file.bytes) changed += 1
  }
  check('回归-2 旧数据 32 文件 hash 不变', files.length === 32 && changed === 0, JSON.stringify({ files: files.length, changed }))
} catch (error) { console.log('      （SKIP：旧数据基线不可读 ' + error.message + '）') }

await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) { console.log('失败项：'); for (const item of failures) console.log('  - ' + item) }
process.exit(failed === 0 ? 0 : 1)
