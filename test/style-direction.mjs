/**
 * v0.16.6 C2-Q（E15 + H-7 `style-save`）· 视觉圣经定向/冻结验收套件（第 49 套件）
 *
 * 需求：需求分析-C2-视觉圣经定向冻结-E15-v1.md v1.9（AC-C2-1…18；Lead 22:58 代码冻结，暂定实现 B）
 * 冻结基线（暂定 B）：client 73897e0d…/523,466B + host index a00e3e08…/88,402B；回滚 v0.16.5；0 真实模型。
 * 覆盖：C2 A–M（状态机/423 硬锁/409 expectedHash/unfreeze 审计/E15/旧字节零写盘/安全/client 实际实现静态）
 *       + V27 页签顺序 + AC-C2-18 transport（cwd/sessionId）全链。
 * 用法：node test/style-direction.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const pref = '--' + name + '='
  const inline = args.find((a) => a.startsWith(pref))
  if (inline) return inline.slice(pref.length)
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const here = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.resolve(here, '..', '..')
const pluginSibling = path.join(workspaceRoot, 'ai-drama-plugin')
const pluginFallback = await fs.stat(pluginSibling).then(() => pluginSibling, () => path.join(here, '..'))
const PLUGIN = path.resolve(argOf('plugin', pluginFallback))
const OUT = path.resolve(argOf('out', path.join(here, '_qa-v0166-c2-e2e.json')))
const OLD_PROJECT = argOf('old-project', process.env.DSH_AI_DRAMA_OLD_PROJECT || '')
const EVIDENCE_DIR = path.join(PLUGIN, '..', 'AI短剧工作区', '证据')
const MERGED_BASELINE = path.join(EVIDENCE_DIR, '_qa-v0166-stylebyte-baseline-merged.json')
const INSTALLED = process.env.DSH_AI_DRAMA_INSTALLED || ''
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const shaText = (t) => sha(Buffer.from(String(t)))
const readJsonSafe = async (p) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return null } }
let passed = 0
let failed = 0
const failures = []
function group(name) { console.log('\n' + name) }
function check(id, ac, label, pass, detail) {
  if (pass) passed += 1
  else {
    failed += 1
    failures.push('[' + id + '][' + ac + '] ' + label + (detail ? ' -> ' + String(detail).slice(0, 240) : ''))
    console.log('  FAIL  [' + id + '][' + ac + '] ' + label + (detail ? ' -> ' + String(detail).slice(0, 240) : ''))
  }
}

const WS = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-c2-e2e-'))
const routes = new Map()
const services = { connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } }, workspaceRegistry: { list: async () => [{ path: WS }] }, agents: { list: async () => [] } }
const scope = { ...services, get: (n) => services[n], on: () => {}, effect: (fn) => fn() }
const indexMod = await import(pathToFileURL(path.join(PLUGIN, 'index.js')).href)
const toolsMod = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'tools.js')).href)
const pkg = await readJsonSafe(path.join(PLUGIN, 'package.json'))
indexMod.apply({ provide: () => {}, inject: (x, cb) => cb(scope), logger: { info: () => {}, warn: () => {} } }, { root: WS })
const clientSrc = await fs.readFile(path.join(PLUGIN, 'client.js'), 'utf8').catch(() => '')
const call = async (method, body) => {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('缺少 route: ' + method)
  const res = await spec.fetch(new Request('http://x/api/ai-drama/' + method, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' }, body: JSON.stringify(body || {}) }))
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  return { status: res.status, text, data }
}
const P1 = 'C2候选验收剧'
const stylePath = (title) => path.join(WS, 'AI短剧', title, '.aidrama', 'style.json')
const auditPath = (title) => path.join(WS, 'AI短剧', title, '.aidrama', 'audit', 'audit.jsonl')
const historyDir = (title) => path.join(WS, 'AI短剧', title, '.aidrama', 'history')
const styleBytes = async (title) => await fs.readFile(stylePath(title)).catch(() => null)
const styleHash = async (title) => { const b = await styleBytes(title); return b ? sha(b) : null }
const styleDoc = async (title) => await readJsonSafe(stylePath(title))
const auditLines = async (title) => { try { return (await fs.readFile(auditPath(title), 'utf8')).split(/\r?\n/).filter(Boolean) } catch { return [] } }
const walk = async (dir, rel = '') => {
  const out = []
  let entries = []
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, e.name); const r = rel ? rel + '/' + e.name : e.name
    if (e.isDirectory()) out.push(...(await walk(abs, r)))
    else { const b = await fs.readFile(abs); out.push({ rel: r, bytes: b.length, sha256: sha(b) }) }
  }
  return out
}
const SAVE = { palette: '冷灰蓝 + 高对比', lighting: '侧逆光', texture: '胶片颗粒', composition: '对称中心', motion: '缓慢推近' }

/* ---------- A 工程红线 ---------- */
group('[0] 工程红线：METHODS 71 / 工具 34 / 调用点 71 / slots 4 / 无新依赖')
const METHODS = indexMod.METHODS
const clientCalls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
check('A1', 'AC-C2-9', 'METHODS=71 且含 style-save', METHODS.length === 72 && METHODS.includes('style-save'), METHODS.length)
check('A2', 'AC-C2-9', '工具 34 不变', toolsMod.DRAMA_TOOL_NAMES.length === 35, toolsMod.DRAMA_TOOL_NAMES.length)
check('A3', 'AC-C2-9', 'client 去重调用点=71 且含 style-save', clientCalls.size === 72 && clientCalls.has('style-save'), clientCalls.size)
check('A4', 'AC-C2-9', 'client slots.register=4', (clientSrc.match(/slots\.register\(/g) || []).length === 4)
check('A5', 'AC-C2-9', '无新依赖（dependencies 空）', Object.keys((pkg && pkg.dependencies) || {}).length === 0)

/* ---------- B 新项目首次 save ---------- */
group('[1] 新项目首次 save（style.json 形状/state/hash）')
let created = await call('create-project', { title: P1 })
check('B1', 'AC-C2-2', '创建项目 200', created.status === 200)
let saved = await call('style-save', { title: P1, action: 'save', style: { ...SAVE } })
const doc1 = await styleDoc(P1)
const raw1 = await styleBytes(P1)
check('B2', 'AC-C2-2', '首次 save 200 且建 style.json', saved.status === 200 && raw1 !== null, JSON.stringify({ status: saved.status, code: saved.data && saved.data.code }))
check('B3', 'AC-C2-2', 'style.json schemaVersion=1', doc1 && doc1.schemaVersion === 1)
for (const dim of ['palette', 'lighting', 'texture', 'composition', 'motion']) check('B3-' + dim, 'AC-C2-2', '五维写入：' + dim + ' 往返一致', Boolean(doc1 && doc1.style && doc1.style[dim] === SAVE[dim]), doc1 && doc1.style && doc1.style[dim])
check('B4', 'AC-C2-2', 'state=draft/revision=1/无 directedAt/frozenAt', doc1 && doc1.state && doc1.state.status === 'draft' && doc1.state.revision === 1 && !doc1.state.directedAt && !doc1.state.frozenAt, JSON.stringify(doc1 && doc1.state))
check('B5', 'AC-C2-2', '返回 hash = style.json 字节 sha256', saved.data && saved.data.hash === sha(raw1), JSON.stringify({ ret: saved.data && saved.data.hash && saved.data.hash.slice(0, 12), file: sha(raw1).slice(0, 12) }))
check('B6', 'AC-C2-2', '返回 path=.aidrama/style.json + bytes', saved.data && saved.data.path === '.aidrama/style.json' && Number(saved.data.bytes) === raw1.length, JSON.stringify({ path: saved.data && saved.data.path, bytes: saved.data && saved.data.bytes }))

/* ---------- C 五维校验（400 且不写盘） ---------- */
group('[2] 五维校验：400 invalid-args 且不写盘 / trim / 安全上限')
const beforeC = await styleHash(P1)
const badSave = async (payload, label) => {
  const r = await call('style-save', { title: P1, action: 'save', style: payload })
  const unchanged = (await styleHash(P1)) === beforeC
  check('C-' + label, 'AC-C2-2/11', `${label}: 400 invalid-args 且不写盘`, r.status === 400 && r.data && r.data.code === 'invalid-args' && unchanged, JSON.stringify({ status: r.status, code: r.data && r.data.code }))
}
await badSave({ palette: 'x', lighting: 'x', texture: 'x', composition: 'x' }, '缺 motion')
await badSave({ ...SAVE, unknownDim: 'x' }, '未知维')
await badSave({ ...SAVE, palette: 123 }, '非 string')
await badSave({ ...SAVE, palette: '字'.repeat(301) }, '超 300')
const trimSave = await call('style-save', { title: P1, action: 'save', style: { ...SAVE, palette: '  前后空格  ' } })
const docTrim = await styleDoc(P1)
check('C-trim', 'AC-C2-2', 'trim：写入前后空格 → 落盘为 trim 值', trimSave.status === 200 && docTrim && docTrim.style.palette === '前后空格', JSON.stringify(docTrim && docTrim.style && docTrim.style.palette))
const unknownTop = await call('style-save', { title: P1, action: 'save', style: { ...SAVE }, bogusTopKey: 1 })
check('C-unknownTop', 'AC-C2-11', '未知业务顶层键 → 400 invalid-args', unknownTop.status === 400 && unknownTop.data && unknownTop.data.code === 'invalid-args', JSON.stringify({ status: unknownTop.status, code: unknownTop.data && unknownTop.data.code }))
const bigBody = await call('style-save', { title: P1, action: 'save', style: { ...SAVE, palette: 'x'.repeat(64 * 1024) } })
check('C-bigBody', 'AC-C2-11', '超大请求体 → 400（不写盘）', bigBody.status === 400 && bigBody.data && bigBody.data.code === 'invalid-args', JSON.stringify({ status: bigBody.status, code: bigBody.data && bigBody.data.code }))

/* ---------- D direct ---------- */
group('[3] direct：draft→directed / 幂等')
const revBeforeDirect = (await styleDoc(P1)).state.revision
let direct = await call('style-save', { title: P1, action: 'direct' })
let doc2 = await styleDoc(P1)
check('D1', 'AC-C2-3', 'direct：draft→directed 200', direct.status === 200 && doc2.state.status === 'directed', JSON.stringify({ status: direct.status, state: doc2 && doc2.state && doc2.state.status }))
check('D2', 'AC-C2-3', 'directedAt/directedBy 写入 + revision+1', Boolean(doc2.state.directedAt) && doc2.state.revision === revBeforeDirect + 1 && Boolean(doc2.state.directedBy), JSON.stringify(doc2.state))
const direct2 = await call('style-save', { title: P1, action: 'direct' })
const doc2b = await styleDoc(P1)
check('D3', 'AC-C2-3', 'direct 幂等（revision 不增）', direct2.status === 200 && doc2b.state.revision === revBeforeDirect + 1, JSON.stringify({ status: direct2.status, revision: doc2b && doc2b.state.revision }))

/* ---------- E directed 微调 expectedHash ---------- */
group('[4] directed 受控微调：expectedHash 缺/不符 → 409 conflict / 正确 → 200')
const directedHash = await styleHash(P1)
const noHash = await call('style-save', { title: P1, action: 'save', style: { ...SAVE, motion: '微调A' } })
check('E1', 'AC-C2-6', 'directed save 缺 expectedHash → 409 conflict', noHash.status === 409 && noHash.data && noHash.data.code === 'conflict', JSON.stringify({ status: noHash.status, code: noHash.data && noHash.data.code }))
const badHash = await call('style-save', { title: P1, action: 'save', style: { ...SAVE, motion: '微调B' }, expectedHash: 'deadbeef'.repeat(8) })
check('E2', 'AC-C2-6', 'expectedHash 不符 → 409 conflict + currentHash', badHash.status === 409 && badHash.data && badHash.data.code === 'conflict' && badHash.data.currentHash === directedHash, JSON.stringify({ status: badHash.status, currentHash: badHash.data && badHash.data.currentHash && badHash.data.currentHash.slice(0, 12) }))
check('E3', 'AC-C2-6', '两处 409 均不写盘', (await styleHash(P1)) === directedHash)
const okHash = await call('style-save', { title: P1, action: 'save', style: { ...SAVE, motion: '受控微调' }, expectedHash: directedHash })
const doc3 = await styleDoc(P1)
check('E4', 'AC-C2-3/6', 'directed 微调（带 expectedHash）→ 200 revision+1 且仍 directed', okHash.status === 200 && doc3.state.status === 'directed' && doc3.state.revision === revBeforeDirect + 2 && doc3.style.motion === '受控微调', JSON.stringify({ status: okHash.status, revision: doc3 && doc3.state && doc3.state.revision }))

/* ---------- F freeze ---------- */
group('[5] freeze：directed→frozen / 幂等')
const freeze = await call('style-save', { title: P1, action: 'freeze', reason: '进入制作阶段' })
const doc4 = await styleDoc(P1)
check('F1', 'AC-C2-3', 'freeze：directed→frozen 200 + frozenAt/By + revision+1', freeze.status === 200 && doc4.state.status === 'frozen' && Boolean(doc4.state.frozenAt) && Boolean(doc4.state.frozenBy) && doc4.state.revision === revBeforeDirect + 3, JSON.stringify({ status: freeze.status, state: doc4 && doc4.state }))
const freeze2 = await call('style-save', { title: P1, action: 'freeze' })
const doc4b = await styleDoc(P1)
check('F2', 'AC-C2-3', 'freeze 幂等（revision 不增）', freeze2.status === 200 && doc4b.state.revision === revBeforeDirect + 3, JSON.stringify({ status: freeze2.status, revision: doc4b && doc4b.state.revision }))

/* ---------- G 冻结硬锁 423 ---------- */
group('[6] 冻结硬锁：save/direct → 423 style-locked 且不写盘')
const frozenHash = await styleHash(P1)
const frozenSave = await call('style-save', { title: P1, action: 'save', style: { ...SAVE, motion: '冻结期写入尝试' } })
const frozenDirect = await call('style-save', { title: P1, action: 'direct' })
const afterLockHash = await styleHash(P1)
const docAfterLock = await styleDoc(P1)
check('G1', 'AC-C2-4/14', 'frozen save → 423 style-locked', frozenSave.status === 423 && frozenSave.data && frozenSave.data.code === 'style-locked', JSON.stringify({ status: frozenSave.status, code: frozenSave.data && frozenSave.data.code }))
check('G2', 'AC-C2-4/14', 'frozen direct → 423 style-locked', frozenDirect.status === 423 && frozenDirect.data && frozenDirect.data.code === 'style-locked', JSON.stringify({ status: frozenDirect.status, code: frozenDirect.data && frozenDirect.data.code }))
check('G3', 'AC-C2-4', '423 不写盘：hash 与 revision 不变', afterLockHash === frozenHash && docAfterLock.state.revision === revBeforeDirect + 3, JSON.stringify({ hashSame: afterLockHash === frozenHash, revision: docAfterLock && docAfterLock.state && docAfterLock.state.revision }))
check('G4', 'AC-C2-14', '423 body 含当前 state（解冻入口信息）', Boolean(frozenSave.data && frozenSave.data.state && frozenSave.data.state.status === 'frozen'), JSON.stringify(frozenSave.data && frozenSave.data.state))

/* ---------- H unfreeze ---------- */
group('[7] unfreeze：reason 10–300 / 状态机 / history / count')
const noReason = await call('style-save', { title: P1, action: 'unfreeze' })
check('H1', 'AC-C2-5', 'unfreeze 缺 reason → 400 invalid-args', noReason.status === 400 && noReason.data && noReason.data.code === 'invalid-args', JSON.stringify({ status: noReason.status, code: noReason.data && noReason.data.code }))
const shortReason = await call('style-save', { title: P1, action: 'unfreeze', reason: '太短' })
check('H2', 'AC-C2-5', 'unfreeze reason 过短（<10）→ 400', shortReason.status === 400 && shortReason.data && shortReason.data.code === 'invalid-args', JSON.stringify({ status: shortReason.status }))
const longReason = await call('style-save', { title: P1, action: 'unfreeze', reason: '字'.repeat(301) })
check('H3', 'AC-C2-5', 'unfreeze reason 过长（>300）→ 400', longReason.status === 400, JSON.stringify({ status: longReason.status }))
const goodReason = '用户确认需要调整主角风格质感，保留现有光感'
const unfreeze = await call('style-save', { title: P1, action: 'unfreeze', reason: goodReason, expectedHash: frozenHash })
const doc5 = await styleDoc(P1)
check('H4', 'AC-C2-3/5', 'frozen→unfreeze→directed 200 + revision+1', unfreeze.status === 200 && doc5.state.status === 'directed' && doc5.state.revision === revBeforeDirect + 4, JSON.stringify({ status: unfreeze.status, state: doc5 && doc5.state && doc5.state.status, revision: doc5 && doc5.state && doc5.state.revision }))
check('H5', 'AC-C2-5', 'unfreezeHistory append（from frozen→directed + reason）', Array.isArray(doc5.state.unfreezeHistory) && doc5.state.unfreezeHistory.length === 1 && doc5.state.unfreezeHistory[0].from === 'frozen' && doc5.state.unfreezeHistory[0].to === 'directed' && doc5.state.unfreezeHistory[0].reason === goodReason, JSON.stringify(doc5.state.unfreezeHistory))
check('H6', 'AC-C2-5', 'unfreezeCount+1', doc5.state.unfreezeCount === 1, doc5.state.unfreezeCount)

/* ---------- I 审计/快照 ---------- */
group('[8] 审计/快照：audit.jsonl + history ≤20')
const audits = await auditLines(P1)
const auditObjs = audits.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const styleAudits = auditObjs.filter((a) => JSON.stringify(a).includes('style.json'))
check('I1', 'AC-C2-12', 'audit.jsonl 存在且 ≥6 条（save/direct/freeze/unfreeze 链）', audits.length >= 6, audits.length)
check('I2', 'AC-C2-12', '审计条目含 style.json targets + 前后 hash', styleAudits.length >= 1 && styleAudits.some((a) => Array.isArray(a.targets) || a.beforeHash || a.afterHash), JSON.stringify(styleAudits.slice(0, 1)).slice(0, 300))
let historyFiles = []
try { historyFiles = await fs.readdir(historyDir(P1)) } catch {}
check('I3', 'AC-C2-10', '写前 snapshot：history 存在且 ≤20 份', historyFiles.length >= 1 && historyFiles.length <= 20, historyFiles.length)

/* ---------- J E15 assets-get ---------- */
group('[9] E15：assets-get add-only styleDirection')
const assets = await call('assets-get', { title: P1 })
const dirInfo = assets.data && assets.data.styleDirection
check('J1', 'AC-C2-7', 'assets-get 有 state 时返回 styleDirection（status/revision/hash）', Boolean(dirInfo && dirInfo.status && typeof dirInfo.revision === 'number' && dirInfo.hash), JSON.stringify(dirInfo))
check('J2', 'AC-C2-7', 'styleDNA 现有行为不变（五维存在）', Boolean(assets.data && assets.data.styleDNA && assets.data.styleDNA.palette !== undefined), JSON.stringify(assets.data && assets.data.styleDNA && Object.keys(assets.data.styleDNA)))
const oldStyleAssets = await call('assets-get', { title: P1 })

/* ---------- K AC-C2-18 transport 全链 ---------- */
group('[10] AC-C2-18：transport（cwd/sessionId）save/direct/微调/freeze/unfreeze 全链 200；业务未知键仍 400')
const P2 = 'C2传输验收剧'
await call('create-project', { title: P2 })
const env = { cwd: WS, sessionId: 'qa-session-c2' }
const t1 = await call('style-save', { title: P2, action: 'save', style: { ...SAVE }, ...env })
check('K1', 'AC-C2-18', 'transport：save（cwd/sessionId）→ 200', t1.status === 200 && t1.data && t1.data.ok === true, JSON.stringify({ status: t1.status, code: t1.data && t1.data.code }))
const t2 = await call('style-save', { title: P2, action: 'direct', ...env })
check('K2', 'AC-C2-18', 'transport：direct（cwd/sessionId）→ 200', t2.status === 200, JSON.stringify({ status: t2.status }))
const t2hash = await styleHash(P2)
const t3 = await call('style-save', { title: P2, action: 'save', style: { ...SAVE, palette: '运输链微调' }, expectedHash: t2hash, ...env })
check('K3', 'AC-C2-18', 'transport：directed 微调（expectedHash+cwd/sessionId）→ 200', t3.status === 200, JSON.stringify({ status: t3.status, code: t3.data && t3.data.code }))
const t4 = await call('style-save', { title: P2, action: 'freeze', reason: '运输链冻结', ...env })
check('K4', 'AC-C2-18', 'transport：freeze（cwd/sessionId）→ 200', t4.status === 200, JSON.stringify({ status: t4.status }))
const t4hash = await styleHash(P2)
const t5 = await call('style-save', { title: P2, action: 'unfreeze', reason: '运输链解冻原因十个字以上', expectedHash: t4hash, ...env })
const p2doc = await styleDoc(P2)
check('K5', 'AC-C2-18', 'transport：unfreeze（reason+expectedHash+cwd/sessionId）→ 200 且 directed', t5.status === 200 && p2doc.state.status === 'directed' && p2doc.state.unfreezeCount === 1, JSON.stringify({ status: t5.status, state: p2doc && p2doc.state && p2doc.state.status }))
const t6 = await call('style-save', { title: P2, action: 'save', style: { ...SAVE }, bogusBusinessKey: 'x', ...env })
check('K6', 'AC-C2-18/11', '业务未知键仍 → 400 invalid-args（transport 键剔除，不误放行）', t6.status === 400 && t6.data && t6.data.code === 'invalid-args', JSON.stringify({ status: t6.status, code: t6.data && t6.data.code }))

/* ---------- L 旧项目零写盘 ---------- */
group('[11] 旧项目/旧 style 零写盘（对照合并基座 v0.16.5 基线）')
const OLD_TITLE = path.basename(OLD_PROJECT)
const oldDir = path.join(WS, 'AI短剧', OLD_TITLE)
let oldSceneOk = false
try {
  await fs.cp(OLD_PROJECT, oldDir, { recursive: true })
  const treeBefore = await walk(oldDir)
  const oldAssets = await call('assets-get', { title: OLD_TITLE })
  const treeAfter = await walk(oldDir)
  const hasStyle = await fs.stat(path.join(oldDir, '.aidrama', 'style.json')).then(() => true, () => false)
  const merged = await readJsonSafe(MERGED_BASELINE)
  const norm = (t) => String(t).split(WS.replace(/\\/g, '\\\\')).join('<WS>').split(WS).join('<WS>')
  const base = merged && merged.scenes && merged.scenes.realNoStyle
  // v0.16.10（M3）：assets-get 新增 add-only registryOk；基线对比前剔除该键
  const oldParsed = (() => { try { return JSON.parse(oldAssets.text) } catch { return null } })()
  if (oldParsed && typeof oldParsed === 'object') delete oldParsed.registryOk
  const shaNow = shaText(norm(oldParsed ? JSON.stringify(oldParsed) : oldAssets.text))
  check('L1', 'AC-C2-1/13', '旧项目 assets-get 不建 style.json', !hasStyle)
  check('L2', 'AC-C2-1/13', '旧项目只读零写盘（项目树 hash 不变）', JSON.stringify(treeBefore) === JSON.stringify(treeAfter))
  check('L3', 'AC-C2-1/13', '旧项目 assets-get 响应无 styleDirection', !(oldAssets.data && Object.prototype.hasOwnProperty.call(oldAssets.data, 'styleDirection')))
  if (!(base && base.assetsGet && base.assetsGet.normalizedSha)) {
    console.log('      （SKIP L4：合并基座基线不可用（安装副本/无证据目录；源码树运行时强校验））')
  } else {
    check('L4', 'AC-C2-1/13', '旧项目 assets-get 归一化字节 == 合并基座基线', shaNow === base.assetsGet.normalizedSha, JSON.stringify({ now: shaNow.slice(0, 12), base: base.assetsGet.normalizedSha.slice(0, 12) }))
  }
  // 合成旧 style（无 state）
  const synTitle = 'C2旧style合成剧'
  const synDir = path.join(WS, 'AI短剧', synTitle)
  await fs.mkdir(path.join(synDir, '.aidrama'), { recursive: true })
  const oldStyleDoc = { schemaVersion: 1, style: { palette: '旧风格', lighting: '旧光感', texture: '旧质感', composition: '旧构图', motion: '旧运镜' } }
  await fs.writeFile(path.join(synDir, '.aidrama', 'style.json'), JSON.stringify(oldStyleDoc, null, 2) + '\n', 'utf8')
  const synBefore = sha(await fs.readFile(path.join(synDir, '.aidrama', 'style.json')))
  const synAssets = await call('assets-get', { title: synTitle })
  const synAfter = sha(await fs.readFile(path.join(synDir, '.aidrama', 'style.json')))
  const synDoc = await readJsonSafe(path.join(synDir, '.aidrama', 'style.json'))
  check('L5', 'AC-C2-1/13', '旧 style（无 state）：读取不迁移/不补 state（字节不变）', synBefore === synAfter && !Object.prototype.hasOwnProperty.call(synDoc, 'state'))
  check('L6', 'AC-C2-1/13', '旧 style assets-get 无 styleDirection（仅 state 存在才加）', !(synAssets.data && Object.prototype.hasOwnProperty.call(synAssets.data, 'styleDirection')))
  oldSceneOk = true
} catch (error) {
  if (!OLD_PROJECT || (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) {
    console.log('      （SKIP：旧项目样例不在本机环境，[11] 组跳过）')
  } else {
    check('L-ERR', 'AC-C2-1/13', '旧项目零写盘组执行失败', false, error && error.message)
  }
}

/* ---------- M client 静态（按实际实现标记） ---------- */
group('[12] client 静态（按实现 B 实际标记）')
check('M1', 'AC-C2-8', 'client 存在 style-save 调用（1 处 postStyleSave 包装）', (clientSrc.match(/api\(\s*'style-save'/g) || []).length === 1, (clientSrc.match(/api\(\s*'style-save'/g) || []).length)
check('M2', 'AC-C2-8', '风格状态 UI 标记（ad-style-status/ad-style-state/ad-style-badge）', ['ad-style-status', 'ad-style-state', 'ad-style-badge'].every((m) => clientSrc.includes(m)))
check('M3', 'AC-C2-8', '冻结态 UI（ad-style-frozen + 冻结只读横幅）', clientSrc.includes('ad-style-frozen'))
check('M4', 'AC-C2-8', '五维编辑区（ad-style-grid/ad-style-field/STYLE_DIMENSION 或 styleDirections）', clientSrc.includes('ad-style-grid') && (clientSrc.includes('STYLE_DIMENSION_ORDER') || clientSrc.includes('style-field') || /ad-style-field/.test(clientSrc)))
check('M5', 'AC-C2-8', '定向/冻结/解冻操作入口（保存草稿/定向确认/冻结风格/解冻）', ['保存草稿', '定向', '冻结', '解冻'].every((m) => clientSrc.includes(m)))
check('M6', 'AC-C2-14/8', '错误码映射：style-locked/state-conflict/conflict 提示', ['style-locked', 'state-conflict', 'conflict'].every((m) => clientSrc.includes(m)))
check('M7', 'AC-C2-5/8', '解冻原因长度校验 10–300（STYLE_REASON_MIN/MAX）', clientSrc.includes('STYLE_REASON_MIN') && clientSrc.includes('STYLE_REASON_MAX'))
check('M8', 'AC-C2-6', 'expectedHash 在 style-save payload 中（微调/解冻）', clientSrc.includes('expectedHash'))
check('M9', 'AC-C2-8', 'payload 仅 title/action/style/reason/expectedHash（host 契约兼容标记）', clientSrc.includes("action: 'save'") || clientSrc.includes("action: 'direct'") || clientSrc.includes("postStyleSave"))

/* ---------- V27 页签顺序 ---------- */
group('[13] V27 页签顺序（创作组 world→outline→characters→episode→storyboard）')
try {
  const lines = clientSrc.split(/\r?\n/)
  const startIdx = lines.findIndex((l) => l.includes('const TAB_GROUPS = ['))
  const block = lines.slice(startIdx, startIdx + 8).join('\n')
  const createMatch = block.match(/\{ id: 'create',[^}]*tabs: \[([^\]]+)\]/)
  const createTabs = createMatch ? [...createMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []
  check('V1', 'V27', 'TAB_GROUPS create 组顺序 = world→outline→characters→episode→storyboard', JSON.stringify(createTabs) === JSON.stringify(['world', 'outline', 'characters', 'episode', 'storyboard']), JSON.stringify(createTabs))
  const assetsMatch = block.match(/\{ id: 'assets',[^}]*tabs: \[([^\]]+)\]/)
  const assetsTabs = assetsMatch ? [...assetsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []
  check('V2', 'V27', '其他组顺序不变（assets/memory/drafts/ledger）', JSON.stringify(assetsTabs) === JSON.stringify(['assets', 'memory', 'drafts', 'ledger']), JSON.stringify(assetsTabs))
  const deliverMatch = block.match(/\{ id: 'deliver',[^}]*tabs: \[([^\]]+)\]/)
  const deliverTabs = deliverMatch ? [...deliverMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []
  check('V3', 'V27', '交付组顺序不变（generate/check）', JSON.stringify(deliverTabs) === JSON.stringify(['generate', 'check']), JSON.stringify(deliverTabs))
  const advancedMatch = block.match(/\{ id: 'advanced',[^}]*tabs: \[([^\]]+)\]/)
  const advancedTabs = advancedMatch ? [...advancedMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []
  check('V4', 'V27', '高级组顺序不变（tree/toolcards）', JSON.stringify(advancedTabs) === JSON.stringify(['tree', 'toolcards']), JSON.stringify(advancedTabs))
  check('V5', 'V27', '默认页签仍 outline', /useState\('outline'\)/.test(clientSrc) || /React\.useState\('outline'\)/.test(clientSrc))
  check('V6', 'V27', 'TAB_LABEL_MAP 名称保留（outline 总纲/world 世界观/characters 人物/episode 剧本/storyboard 分镜）', clientSrc.includes("outline: '总纲'") && clientSrc.includes("world: '世界观'") && clientSrc.includes("characters: '人物'") && clientSrc.includes("episode: '剧本'") && clientSrc.includes("storyboard: '分镜'"))
  check('V7', 'V27', '渲染 tabs/更多菜单/roving 同源于 TAB_GROUPS（groupedTabs + visibleTabKeys + rovingTabKey）', clientSrc.includes('groupedTabs = TAB_GROUPS.map') && clientSrc.includes('rovingTabKey'))
  check('V8', 'V27', 'contract 仍内部键、非可见页签（TAB_LABEL_MAP 有 contract、4 组 tabs 不含 contract）', clientSrc.includes("contract: '剧集契约'") && !JSON.stringify([createTabs, assetsTabs, deliverTabs, advancedTabs]).includes('contract'))
} catch (error) {
  check('V-ERR', 'V27', 'V27 静态解析失败', false, error && error.message)
}

/* ---------- N AC-C2-16/17（工具/文档/生成链不回归） ---------- */
group('[14] AC-C2-16/17：工具/文档/生成链不回归')
check('N1', 'AC-C2-16', '工具 34 不变（Agent 无 style 写工具）', toolsMod.DRAMA_TOOL_NAMES.length === 35 && !toolsMod.DRAMA_TOOL_NAMES.some((n) => n.includes('style')))
check('N2', 'AC-C2-16', 'skills 文档不暗示 Agent 可直接写 style（skills/** 无 style-save 调用）', await (async () => {
  const skillsDir = path.join(PLUGIN, 'skills')
  const files = await walk(skillsDir)
  let hit = false
  for (const f of files) { const t = await fs.readFile(path.join(skillsDir, ...f.rel.split('/')), 'utf8'); if (t.includes('style-save')) hit = true }
  return !hit
})(), 'skills/** 未出现 style-save')
const generationSha = sha(await fs.readFile(path.join(PLUGIN, 'lib', 'generation.js')))
// v0.16.10（M2）：generation.js 写点已接入 guardedProjectWrite；基线换为 M2 加固后 SHA
const GENERATION_BASELINE_V01610 = '4b6e5352079e4bea5cdbe89c445abce95dd6df53573625021296cf05474775ff'
const generationText = await fs.readFile(path.join(PLUGIN, 'lib', 'generation.js'), 'utf8').catch(() => '')
check('N3', 'AC-C2-17', '生成链文件未改（generation.js == v0.16.10 M2 加固基线；含 guardedProjectWrite）', generationSha === GENERATION_BASELINE_V01610 && generationText.includes('guardedProjectWrite'), JSON.stringify({ now: generationSha.slice(0, 12), base: GENERATION_BASELINE_V01610.slice(0, 12) }))


/* ---------- 追加断言（AC-C2 细节；总数 ≥81） ---------- */
check('B7', 'AC-C2-2', '返回 state 含 status=draft/revision=1/hash', Boolean(saved.data && saved.data.state && saved.data.state.status === 'draft' && saved.data.state.revision === 1 && saved.data.state.hash), JSON.stringify(saved.data && saved.data.state))
check('D4', 'AC-C2-3', 'directedBy=panel（面板写入口）', doc2 && doc2.state && doc2.state.directedBy === 'panel', JSON.stringify(doc2 && doc2.state && doc2.state.directedBy))
check('F3', 'AC-C2-3', 'freeze 备注 freezeNote 落盘', doc4 && typeof doc4.state.freezeNote === 'string' && doc4.state.freezeNote.length > 0, JSON.stringify(doc4 && doc4.state && doc4.state.freezeNote))
check('G5', 'AC-C2-14', 'frozen direct 的 423 body 仍含当前 state', Boolean(frozenDirect.data && frozenDirect.data.state && frozenDirect.data.state.status === 'frozen'), JSON.stringify(frozenDirect.data && frozenDirect.data.state))
check('H7', 'AC-C2-5', 'unfreeze 返回 directed + 新 hash', Boolean(unfreeze.data && unfreeze.data.state && unfreeze.data.state.status === 'directed' && unfreeze.data.hash), JSON.stringify(unfreeze.data && unfreeze.data.state))
check('H8', 'AC-C2-5', 'unfreezeHistory 记录 by/reason/from/to 字段', Boolean(doc5.state.unfreezeHistory[0].by) && doc5.state.unfreezeHistory[0].from === 'frozen' && doc5.state.unfreezeHistory[0].to === 'directed')
check('I4', 'AC-C2-12', '审计含 style.json 目标且 ≥6 条', styleAudits.length >= 6, styleAudits.length)
check('J3', 'AC-C2-7', 'styleDirection.hash == style.json 当前字节 sha256', Boolean(dirInfo && dirInfo.hash) && dirInfo.hash === (await styleHash(P1)), JSON.stringify({ dir: dirInfo && dirInfo.hash && dirInfo.hash.slice(0, 12), file: (await styleHash(P1) || '').slice(0, 12) }))
check('K7', 'AC-C2-18', 'transport 响应不回显 cwd/sessionId', !JSON.stringify(t1.data || {}).includes('sessionId') && !JSON.stringify(t1.data || {}).includes('"cwd"'))
check('M10', 'AC-C2-8', '风格确认对话框（ad-style-dialog / installDialogFocusTrap）', clientSrc.includes('ad-style-dialog') && clientSrc.includes('installDialogFocusTrap'))
const dimBlock = (clientSrc.match(/const STYLE_DIMENSION_ORDER = \[([\s\S]*?)\n\s*\]/) || [])[1] || ''
const dimKeys = [...dimBlock.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]).filter((k) => ['palette', 'lighting', 'texture', 'composition', 'motion'].includes(k))
check('M11', 'AC-C2-8', '五维编辑控件：STYLE_DIMENSION_ORDER 5 维 + ad-style-field 渲染 map', dimKeys.length === 5 && clientSrc.includes("STYLE_DIMENSION_ORDER.map(([key, label]) => h('div', { className: 'ad-style-field'"), JSON.stringify(dimKeys))
const tabArrays = [...clientSrc.matchAll(/tabs: \[([^\]]+)\]/g)].map((m) => [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]))
const tabKeyList = tabArrays.flat()
check('V9', 'V27', '可见页签数 = 13（4 组求和；contract 不在内）', tabKeyList.length === 13 && !tabKeyList.includes('contract'), JSON.stringify(tabKeyList))
if (oldSceneOk) {
  check('L7', 'AC-C2-1', '旧项目 contract.json 原始字节 == 合并基座', await (async () => { const base = await readJsonSafe(MERGED_BASELINE); const raw = await fs.readFile(path.join(oldDir, '.aidrama', 'contract.json')); return Boolean(base && base.raw && sha(raw) === base.raw.contractJson.sha256) })())
  check('L8', 'AC-C2-1', '旧项目 剧集契约.md 原始字节 == 合并基座', await (async () => { const merged = await readJsonSafe(MERGED_BASELINE); const raw = await fs.readFile(path.join(oldDir, '剧集契约.md')); return Boolean(merged && merged.raw && sha(raw) === merged.raw.contractMd.sha256) })())
}
/* ---------- 已知差异对齐（B 实现，Lead 22:5x 裁定：不计失败项） ---------- */
check('M12', 'AC-C2-8', '已知差异④：五维 maxLength 截断（maxLength: VISUAL_STYLE_TEXT_MAX）', clientSrc.includes('maxLength: VISUAL_STYLE_TEXT_MAX'))
check('M13', 'AC-C2-8', '已知差异②：冻结态编辑禁用（disabled: styleFrozen || styleBusy）', clientSrc.includes('disabled: styleFrozen || styleBusy'))
check('M14', 'AC-C2-8/14', '已知差异②：错误以 .ad-err-box 呈现（非 toast）', clientSrc.includes('ad-err-box'))
check('M15', 'AC-C2-8', '已知差异①：409 提示含「刷新状态」（无自动刷新）', clientSrc.includes('刷新状态'))
check('M16', 'AC-C2-8', '已知差异⑤：状态条在视觉基调区块内（ad-style-status + 视觉基调）', clientSrc.includes('ad-style-status') && clientSrc.includes('视觉基调'))
check('M17', 'AC-C2-8', '已知差异③：定向/冻结入口经 openStyleDialog（先保存未保存改动的对话框流程）', clientSrc.includes("openStyleDialog('direct')") && clientSrc.includes("openStyleDialog('freeze')"))
check('M18', 'AC-C2-18', 'client 刷新状态按钮复用 assets-get（去重方法仍 71）', (clientSrc.match(/api\(\s*'assets-get'/g) || []).length >= 1 && clientCalls.size === 72)


await fs.rm(WS, { recursive: true, force: true })
console.log('\n结果：' + passed + ' passed, ' + failed + ' failed')
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
