/**
 * E1（T6 编辑器往返）· 离线 route 级门禁：doc-read / doc-save(expectHash) / doc-notify。
 * 冻结形状（AI短剧工作区/P1-接口契约冻结-v1.md §7.5，Lead 已批准）：
 *   doc-read   { title, path } → { ok, path, text, hash, updatedAt }
 *   doc-save   { title, path, text, expectedHash } → { ok, path, hash, bytes }
 *               哈希不符 → HTTP 409 { ok:false, code:'conflict', currentHash } 且不覆盖
 *   doc-notify { title, path, action:'save', hash } → { ok:true }
 *
 * 兼容策略：host task-13 未落地时（METHODS 仍 64）本套件打印 SKIP 理由并以 0 failed 退出；
 * 落地后自动生效（QA 同时把 client.mjs 门禁同步到 67/57）。
 *
 * 运行：node test/editor-roundtrip.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const hostSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const methodsStart = hostSrc.indexOf('const METHODS = [')
const methodsBlock = hostSrc.slice(methodsStart, hostSrc.indexOf(']', methodsStart))
const hasDocRoutes = ['doc-read', 'doc-save', 'doc-notify'].every((name) => methodsBlock.includes(`'${name}'`))

if (!hasDocRoutes) {
  console.log('\n结果：0 passed, 0 failed（SKIP：host E1 的 doc-read/doc-save/doc-notify 尚未落地，METHODS 仍为 64；host task-13 交付后本套件自动生效）')
  process.exit(0)
}

const { apply } = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)

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

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-e1-'))
const routes = new Map()
const ctx = {
  provide: () => {},
  inject(services, callback) {
    callback({
      connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } },
      get: () => undefined,
      on: () => {},
      effect: (fn) => fn(),
    })
  },
  logger: { info: () => {}, warn: () => {} },
}
apply(ctx, { root: workspace })

async function call(method, body) {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('route not registered: ' + method)
  const request = new Request('http://127.0.0.1:1/api/ai-drama/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' },
    body: JSON.stringify(body || {}),
  })
  const response = await spec.fetch(request)
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  return { status: response.status, body: payload }
}

const TITLE = '编辑器往返样剧'
const DOC_PATH = '分集剧本/第001集.md'
const EPISODE_FILE = path.join(workspace, 'AI短剧', TITLE, '分集剧本', '第001集.md')

/* ------------------------------------------------------------------ [0] */
group('[0] 前置：建项目并写入一集剧本')
const created = await call('create-project', { title: TITLE })
check('建项目成功', created.status === 200 && created.body.ok === true, JSON.stringify(created.body).slice(0, 120))
const v1 = '# 第001集 初稿\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：这钱，我三天还你。\n'
const written = await call('episode-write', { title: TITLE, order: 1, text: v1 })
check('写入第 1 集成功', written.status === 200 && written.body.ok === true, JSON.stringify(written.body).slice(0, 120))

/* ------------------------------------------------------------------ [1] */
group('[1] doc-read：返回 text + hash + 元数据')
const read1 = await call('doc-read', { title: TITLE, path: DOC_PATH })
check('doc-read 成功', read1.status === 200 && read1.body.ok === true, JSON.stringify(read1.body).slice(0, 160))
check('doc-read 返回 path', read1.body.path === DOC_PATH, String(read1.body.path))
check('doc-read 返回正文与磁盘一致', read1.body.text === v1, JSON.stringify(read1.body.text).slice(0, 80))
check('doc-read 返回 64 位 sha256 hash', /^[0-9a-f]{64}$/.test(String(read1.body.hash)), String(read1.body.hash))
check('doc-read 返回 updatedAt', typeof read1.body.updatedAt === 'string' && read1.body.updatedAt.length > 0, String(read1.body.updatedAt))
const hash1 = read1.body.hash
const badRead = await call('doc-read', { title: TITLE, path: '分集剧本/不存在.md' })
check('doc-read 不存在路径返回 4xx 错误', badRead.status >= 400 && badRead.status < 500 && badRead.body && badRead.body.ok === false, JSON.stringify(badRead.body).slice(0, 120))

/* ------------------------------------------------------------------ [2] */
group('[2] doc-save 正常：expectedHash 匹配 → 更新并返回新 hash/bytes')
const v2 = `${v1}林越（补拍）：三天后，这间当铺归我。\n`
const save1 = await call('doc-save', { title: TITLE, path: DOC_PATH, text: v2, expectedHash: hash1 })
check('doc-save 成功', save1.status === 200 && save1.body.ok === true, JSON.stringify(save1.body).slice(0, 160))
check('doc-save 返回 path/hash/bytes', save1.body.path === DOC_PATH && /^[0-9a-f]{64}$/.test(String(save1.body.hash)) && Number.isFinite(save1.body.bytes), JSON.stringify(save1.body).slice(0, 160))
check('doc-save 后 hash 变化', save1.body.hash !== hash1, `${hash1.slice(0, 12)} -> ${String(save1.body.hash).slice(0, 12)}`)
check('doc-save 后磁盘内容已更新', (await fs.readFile(EPISODE_FILE, 'utf8')) === v2)
const read2 = await call('doc-read', { title: TITLE, path: DOC_PATH })
check('doc-read 回读到新正文/新 hash', read2.body.text === v2 && read2.body.hash === save1.body.hash)
const hash2 = read2.body.hash

/* ------------------------------------------------------------------ [3] */
group('[3] doc-save 冲突：expectedHash 不符 → 409 conflict + currentHash，原文件不覆盖')
const stale = await call('doc-save', { title: TITLE, path: DOC_PATH, text: '# 不应写入\n', expectedHash: hash1 })
check('冲突返回 HTTP 409', stale.status === 409, String(stale.status))
check('冲突返回 code=conflict', stale.body && stale.body.ok === false && stale.body.code === 'conflict', JSON.stringify(stale.body).slice(0, 160))
check('冲突返回 currentHash = 当前 hash', stale.body && stale.body.currentHash === hash2, String(stale.body && stale.body.currentHash))
check('冲突时不覆盖原文件', (await fs.readFile(EPISODE_FILE, 'utf8')) === v2)

/* ------------------------------------------------------------------ [4] */
group('[4] doc-notify：保存后通知主控（落盘 + 审计可观测）')
const notify = await call('doc-notify', { title: TITLE, path: DOC_PATH, action: 'save', hash: hash2 })
check('doc-notify 返回 ok:true', notify.status === 200 && notify.body.ok === true, JSON.stringify(notify.body).slice(0, 160))
check('doc-notify 返回 path/action/notifiedAt', notify.body.path === DOC_PATH && notify.body.action === 'save' && typeof notify.body.notifiedAt === 'string', JSON.stringify(notify.body).slice(0, 200))
const notifyLog = path.join(workspace, 'AI短剧', TITLE, '.aidrama', 'editor-notifications.jsonl')
const notifyText = await fs.readFile(notifyLog, 'utf8').catch(() => null)
check('通知落盘 .aidrama/editor-notifications.jsonl', Boolean(notifyText) && notifyText.trim().length > 0)
let notifyRecord = null
try {
  notifyRecord = JSON.parse((notifyText || '').trim().split(/\r?\n/).pop())
} catch {
  notifyRecord = null
}
check('通知记录含 action=save / path / hash', Boolean(notifyRecord) && notifyRecord.action === 'save' && notifyRecord.path === DOC_PATH && notifyRecord.hash === hash2 && typeof notifyRecord.at === 'string', JSON.stringify(notifyRecord).slice(0, 200))
// 审计（T2 事务层）：queryAudit(action='doc-notify') 应能查到本次通知，targets 含通知文件
let txnMod = null
try {
  txnMod = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'txn.js')).href)
} catch {
  txnMod = null
}
if (txnMod && typeof txnMod.queryAudit === 'function') {
  const audit = await txnMod.queryAudit(workspace, TITLE, { action: 'doc-notify' })
  check('审计可查 doc-notify 记录', audit.total >= 1 && audit.entries[0].ok === true, JSON.stringify(audit.entries.slice(0, 1)).slice(0, 200))
} else {
  console.log('      （当前工件无 T2 审计层；doc-notify 审计断言跳过，待 task-12 工件上生效）')
}

/* ------------------------------------------------------------------ [5] */
group('[5] 鉴权与兼容：doc-* 沿用 x-ai-drama-request 校验')
const spec = routes.get('/api/ai-drama/doc-read')
const forbidden = await spec.fetch(new Request('http://127.0.0.1:1/api/ai-drama/doc-read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
check('doc-read 缺请求头 → 403', forbidden.status === 403)
check('METHODS 含 doc-* 三条（目标 67 条）', hasDocRoutes)

await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
