/**
 * P1-K / T2 写操作事务化自测：项目锁 / operationId 幂等 / expectedHash 乐观锁 / 审计 / 隔离恢复。
 * 来源：host-dev task-12 交付的 `lib/txn.js`（`runProjectTxn` / `queryAudit` / `recoverProjectIsolation` 等）。
 *
 * 兼容策略：v0.4.0 安装工件早于 task-12 源码（无 lib/txn.js）→ 本套件打印 SKIP 理由并以 0 failed 退出。
 *
 * 运行：node test/transactions.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')

let txn = null
try {
  txn = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'txn.js')).href)
} catch {
  txn = null
}
const store = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'store.js')).href)

if (!txn || typeof txn.runProjectTxn !== 'function') {
  console.log('\n结果：0 passed, 0 failed（SKIP：当前工件未包含 T2 事务层 lib/txn.js —— v0.4.0 安装工件早于 task-12 源码；本套件在下一检查点工件上生效）')
  process.exit(0)
}

const { runProjectTxn, queryAudit, recoverProjectIsolation, readHashes, checkExpectedHash, LOCK_FILE, OPS_DIR, AUDIT_FILE } = txn

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

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-txn-'))
const TITLE = '事务样剧'
const EP_PATH = '分集剧本/第001集.md'
const projectPath = store.projectDir(workspace, TITLE)
const metaDir = path.join(projectPath, '.aidrama')
const abs = (rel) => path.join(projectPath, rel)
const shaOfFile = async (rel) => {
  try {
    return crypto.createHash('sha256').update(await fs.readFile(abs(rel))).digest('hex')
  } catch {
    return null
  }
}

await store.createProject(workspace, TITLE)
await store.writeEpisode(workspace, TITLE, 1, '# v1 初稿\n')

/* ------------------------------------------------------------------ [1] */
console.log('\n[1] 旧行为不变：不带 operationId/expectedHash 时正常执行并记审计')
let legacyCalls = 0
const legacy = await runProjectTxn(workspace, TITLE, { action: 'test-legacy', actor: 'qa' }, async () => {
  legacyCalls += 1
  await store.writeEpisode(workspace, TITLE, 1, '# v2 legacy\n')
  return { ok: true, value: 'legacy-result' }
})
check('legacy 结果透传', legacy && legacy.ok === true && legacy.value === 'legacy-result', JSON.stringify(legacy).slice(0, 120))
check('legacy 不标 replayed', legacy.replayed === undefined)
check('legacy fn 执行 1 次', legacyCalls === 1, String(legacyCalls))
const auditLegacy = await queryAudit(workspace, TITLE, { action: 'test-legacy' })
check('legacy 写审计条目', auditLegacy.total >= 1 && auditLegacy.entries[0].ok === true && auditLegacy.entries[0].actor === 'qa', JSON.stringify(auditLegacy.entries[0] || null).slice(0, 180))

/* ------------------------------------------------------------------ [2] */
console.log('\n[2] operationId 幂等：重放返回首次结果 + replayed:true，不重复写盘/计账')
const OP = 'op-qa-idem-001'
let idemCalls = 0
const first = await runProjectTxn(workspace, TITLE, { action: 'test-idem', operationId: OP, actor: 'agent:qa-1' }, async () => {
  idemCalls += 1
  await store.writeEpisode(workspace, TITLE, 1, '# v3 idem\n')
  return { ok: true, value: 'first-result', nonce: 42 }
})
const second = await runProjectTxn(workspace, TITLE, { action: 'test-idem', operationId: OP, actor: 'agent:qa-1' }, async () => {
  idemCalls += 1
  await store.writeEpisode(workspace, TITLE, 1, '# 不应重复写入\n')
  return { ok: true, value: 'second-result' }
})
check('首次执行返回首次结果', first.ok === true && first.value === 'first-result' && first.replayed === undefined, JSON.stringify(first))
check('重放返回 replayed:true + operationId', second.replayed === true && second.operationId === OP, JSON.stringify(second))
check('重放沿用首次结果', second.value === 'first-result' && second.nonce === 42, JSON.stringify(second))
check('重放不重复执行 fn', idemCalls === 1, String(idemCalls))
check('重放不覆盖文件（仍为首次写入内容）', (await fs.readFile(abs(EP_PATH), 'utf8')) === '# v3 idem\n')
check('ops 缓存文件存在', await fs.stat(path.join(metaDir, OPS_DIR, `${OP}.json`)).then(() => true, () => false))
const auditIdem = await queryAudit(workspace, TITLE, { operationId: OP })
check('重放不重复审计（operationId 过滤仅 1 条）', auditIdem.total === 1, String(auditIdem.total))

/* ------------------------------------------------------------------ [3] */
console.log('\n[3] expectedHash 乐观锁：匹配放行 / 不符 conflict 且不写盘')
const hashBefore = await shaOfFile(EP_PATH)
const hashOk = await runProjectTxn(workspace, TITLE, { action: 'test-hash', expectedHash: { [EP_PATH]: hashBefore }, targets: [EP_PATH] }, async () => {
  await store.writeEpisode(workspace, TITLE, 1, '# v4 hash-ok\n')
  return { ok: true }
})
const hashAfter = await shaOfFile(EP_PATH)
check('expectedHash 匹配 → 成功', hashOk.ok === true, JSON.stringify(hashOk))
check('写入后 hash 变化', hashAfter !== hashBefore, `${String(hashBefore).slice(0, 12)} -> ${String(hashAfter).slice(0, 12)}`)
let staleError = null
try {
  await runProjectTxn(workspace, TITLE, { action: 'test-hash', expectedHash: { [EP_PATH]: hashBefore }, targets: [EP_PATH] }, async () => {
    await store.writeEpisode(workspace, TITLE, 1, '# 不应写入（stale）\n')
    return { ok: true }
  })
} catch (error) {
  staleError = error
}
check('expectedHash 不符 → 抛 conflict', Boolean(staleError) && staleError.code === 'conflict', String(staleError && staleError.code))
check('conflict 带重试指引 next', Boolean(staleError) && typeof staleError.next === 'string' && staleError.next.length > 5)
check('conflict 带 details 定位', Boolean(staleError) && Array.isArray(staleError.details) && staleError.details[0] && staleError.details[0].path === EP_PATH, JSON.stringify(staleError && staleError.details).slice(0, 160))
check('冲突时不覆盖文件', (await fs.readFile(abs(EP_PATH), 'utf8')) === '# v4 hash-ok\n')
// D-08 修复后：expectedHash 预检失败也落审计（ok:false + errorCode=conflict）
const auditHash = await queryAudit(workspace, TITLE, { action: 'test-hash' })
const rejectedEntry = auditHash.entries.find((e) => e.ok === false)
check('expectedHash 冲突写「被拒绝」审计（ok:false + errorCode=conflict）', Boolean(rejectedEntry) && rejectedEntry.ok === false && rejectedEntry.errorCode === 'conflict', JSON.stringify(rejectedEntry || null).slice(0, 200))
check('被拒审计含 targets 与期望/当前 hash', Boolean(rejectedEntry) && Array.isArray(rejectedEntry.targets) && rejectedEntry.targets[0] && rejectedEntry.targets[0].path === EP_PATH, JSON.stringify((rejectedEntry && rejectedEntry.targets) || []).slice(0, 200))
// fn 执行失败的事务审计（成败原因 + targets 前后 sha256）
let fnFailError = null
try {
  await runProjectTxn(workspace, TITLE, { action: 'test-fail-fn', targets: [EP_PATH] }, async () => {
    await store.writeEpisode(workspace, TITLE, 1, '# partial 写入后失败\n')
    throw new Error('qa 故意失败')
  })
} catch (error) {
  fnFailError = error
}
check('fn 抛错透传', Boolean(fnFailError) && String(fnFailError.message).includes('qa 故意失败'))
const auditFail = await queryAudit(workspace, TITLE, { action: 'test-fail-fn' })
const failedEntry = auditFail.entries[0]
check('fn 失败事务写审计（ok:false + error）', Boolean(failedEntry) && failedEntry.ok === false && typeof failedEntry.error === 'string' && failedEntry.error.includes('qa 故意失败'), JSON.stringify(failedEntry || null).slice(0, 180))
check('审计 targets 带前后 sha256', Boolean(failedEntry) && Array.isArray(failedEntry.targets) && failedEntry.targets[0] && /^[0-9a-f]{64}$/.test(String(failedEntry.targets[0].beforeHash)) && /^[0-9a-f]{64}$/.test(String(failedEntry.targets[0].afterHash)) && failedEntry.targets[0].beforeHash !== failedEntry.targets[0].afterHash, JSON.stringify((failedEntry && failedEntry.targets) || []).slice(0, 200))

/* ------------------------------------------------------------------ [4] */
console.log('\n[4] 并发双写：同 expectedHash 下 1 成功 1 conflict，不互相覆盖')
const concurrentBase = await shaOfFile(EP_PATH)
const writeA = async () => runProjectTxn(workspace, TITLE, { action: 'test-concurrent', expectedHash: { [EP_PATH]: concurrentBase }, targets: [EP_PATH] }, async () => {
  await new Promise((r) => setTimeout(r, 30))
  await store.writeEpisode(workspace, TITLE, 1, '# winner-A\n')
  return { ok: true, winner: 'A' }
})
const writeB = async () => runProjectTxn(workspace, TITLE, { action: 'test-concurrent', expectedHash: { [EP_PATH]: concurrentBase }, targets: [EP_PATH] }, async () => {
  await new Promise((r) => setTimeout(r, 30))
  await store.writeEpisode(workspace, TITLE, 1, '# winner-B\n')
  return { ok: true, winner: 'B' }
})
const settled = await Promise.allSettled([writeA(), writeB()])
const fulfilled = settled.filter((s) => s.status === 'fulfilled')
const rejected = settled.filter((s) => s.status === 'rejected')
check('并发双写恰好 1 个成功', fulfilled.length === 1, `fulfilled=${fulfilled.length} rejected=${rejected.length}`)
check('并发双写另 1 个 conflict', rejected.length === 1 && rejected[0].reason && rejected[0].reason.code === 'conflict', String(rejected[0] && rejected[0].reason && rejected[0].reason.code))
const winnerContent = await fs.readFile(abs(EP_PATH), 'utf8')
check('最终文件只含一个赢家内容（未被覆盖成半截）', /^# winner-[AB]\n$/.test(winnerContent), JSON.stringify(winnerContent))
const auditCon = await queryAudit(workspace, TITLE, { action: 'test-concurrent' })
// D-08 修复后：输家 expectedHash 预检冲突也会写 ok:false 审计 → 1 成功 + 1 失败，共 2 条
check('并发审计 2 条（1 成功 1 失败）', auditCon.total === 2 && auditCon.entries.some((e) => e.ok === true) && auditCon.entries.some((e) => e.ok === false && e.errorCode === 'conflict'), JSON.stringify(auditCon.entries.map((e) => ({ ok: e.ok, code: e.errorCode }))))

/* ------------------------------------------------------------------ [5] */
console.log('\n[5] 可重入：事务内再调用写事务不会自锁')
const reentrant = await runProjectTxn(workspace, TITLE, { action: 'test-reentrant' }, async () => {
  const inner = await runProjectTxn(workspace, TITLE, { action: 'test-reentrant-inner' }, async () => {
    await store.writeEpisode(workspace, TITLE, 2, '# ep2 inner\n')
    return { ok: true, inner: true }
  })
  return { ok: true, inner }
})
check('可重入事务完成且内层结果透传', reentrant.ok === true && reentrant.inner && reentrant.inner.inner === true, JSON.stringify(reentrant).slice(0, 160))

/* ------------------------------------------------------------------ [6] */
console.log('\n[6] 隔离恢复：陈旧锁 + 崩溃残留临时文件')
await fs.mkdir(metaDir, { recursive: true })
await fs.writeFile(path.join(metaDir, LOCK_FILE), JSON.stringify({ token: 'stale-qa', pid: 999999, title: TITLE, acquiredAt: new Date(0).toISOString() }), 'utf8')
// 崩溃残留原子写临时文件命名：`.<basename>.tmp-<pid>-<ts>`（store.atomicWrite 约定）
const strayTemp = path.join(projectPath, '分集剧本', `.残留.md.tmp-999999-${Date.now()}`)
await fs.mkdir(path.dirname(strayTemp), { recursive: true })
await fs.writeFile(strayTemp, 'partial', 'utf8')
const recovery = await recoverProjectIsolation(workspace, TITLE)
check('识别并清理陈旧锁', recovery.recovered === true && recovery.lock && recovery.lock.token === 'stale-qa', JSON.stringify(recovery).slice(0, 160))
check('锁文件已删除', !(await fs.stat(path.join(metaDir, LOCK_FILE)).then(() => true, () => false)))
check('清理崩溃残留临时文件', recovery.removedTempFiles >= 1, String(recovery.removedTempFiles))
check('临时文件已删除', !(await fs.stat(strayTemp).then(() => true, () => false)))
const auditRecover = await queryAudit(workspace, TITLE, { action: 'lock-recovered' })
check('恢复动作写审计（lock-recovered）', auditRecover.total >= 1 && auditRecover.entries[0].actor === 'recovery', JSON.stringify(auditRecover.entries[0] || null).slice(0, 160))

/* ------------------------------------------------------------------ [7] */
console.log('\n[7] 事务后锁释放：可继续正常写入')
const afterRecover = await runProjectTxn(workspace, TITLE, { action: 'test-after-recover', expectedHash: { [EP_PATH]: await shaOfFile(EP_PATH) } }, async () => {
  await store.writeEpisode(workspace, TITLE, 1, '# v-final\n')
  return { ok: true }
})
check('恢复后写事务正常', afterRecover.ok === true)
check('锁文件在事务结束后不存在', !(await fs.stat(path.join(metaDir, LOCK_FILE)).then(() => true, () => false)))

/* ------------------------------------------------------------------ [8] */
console.log('\n[8] 工具层/路由层辅助纯函数')
const hashes = await readHashes(projectPath, [EP_PATH, '分集剧本/不存在.md'])
check('readHashes 返回 path+hash（不存在为 null）', hashes.length === 2 && /^[0-9a-f]{64}$/.test(hashes[0].hash) && hashes[1].hash === null, JSON.stringify(hashes))
const hashNow = await shaOfFile(EP_PATH)
const expectedOk = await checkExpectedHash(projectPath, { [EP_PATH]: hashNow })
check('checkExpectedHash 匹配返回 checked=1', expectedOk.checked === 1, JSON.stringify(expectedOk))
let mismatch = null
try {
  await checkExpectedHash(projectPath, { [EP_PATH]: 'f'.repeat(64) })
} catch (error) {
  mismatch = error
}
check('checkExpectedHash 不符抛 conflict', Boolean(mismatch) && mismatch.code === 'conflict' && Array.isArray(mismatch.details))
const auditFile = path.join(metaDir, 'audit', AUDIT_FILE)
check('审计文件落盘可读', await fs.stat(auditFile).then(() => true, () => false))

await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
