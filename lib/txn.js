/**
 * P1-K / T2：写操作事务化（对标 Scriptor 书仓锁/事务/冲突/恢复）
 *
 * 解决三件事：
 *   1. **并发覆盖**：同一短剧项目的写操作串行化（进程内 FIFO 队列 + `.aidrama/.lock.json`
 *      跨进程文件锁；陈旧锁按 PID 存活 + TTL 自动接管，另提供 `recoverProjectIsolation()` 手工恢复）；
 *   2. **重试幂等**：写请求带 `operationId` 时，首次执行结果写入 `.aidrama/ops/<id>.json`；
 *      同 id 重放直接返回首次结果（`replayed: true`），不会重复写盘；
 *   3. **乐观并发控制**：请求可带 `expectedHash: { '<项目内相对路径>': '<sha256|null>' }`，
 *      与当前内容不符即返回冲突（失败码 `conflict` + 重试指引），不写坏数据。
 *
 * 另外每次事务都会追加一条**审计**到 `.aidrama/audit/audit.jsonl`：
 *   时间 / 操作 / actor（面板或 Agent）/ operationId / 目标文件及前后 sha256 / 成败原因。
 *
 * 设计约束：
 *   - 不改变既有 HTTP/工具语义：不带 `operationId`/`expectedHash` 时行为与旧版一致；
 *   - 事务是**可重入**的（AsyncLocalStorage）：事务内再调用其它写函数不会自己等自己；
 *   - 所有异常都带 `code`（`conflict` 等），与 P1-A 失败契约分类器对齐。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import * as store from './store.js'

export const LOCK_FILE = '.lock.json'
export const OPS_DIR = 'ops'
export const AUDIT_DIR = 'audit'
export const AUDIT_FILE = 'audit.jsonl'
/** 跨进程文件锁的陈旧阈值（毫秒）。 */
export const LOCK_TTL_MS = 30_000
/** 默认等待写锁的超时（毫秒）。 */
export const LOCK_WAIT_MS = 8_000
/** 单条 operation 缓存上限（字节），超过则不缓存结果但仍写审计（避免把大响应塞进项目）。 */
const MAX_OPERATION_BYTES = 512 * 1024

const txContext = new AsyncLocalStorage()
/** 进程内项目锁链：lockKey → 当前链尾 Promise。 */
const lockChains = new Map()

const sha256Of = (buffer) => createHash('sha256').update(buffer).digest('hex')

function conflictError(message, next, details) {
  const error = new Error(message)
  error.code = 'conflict'
  error.next = next || '重新读取最新内容后再提交；或稍后重试。'
  if (details !== undefined) error.details = details
  return error
}

function pathsOf(root, title) {
  const projectPath = store.projectDir(root, title)
  const metaDir = path.join(projectPath, '.aidrama')
  return {
    projectPath,
    metaDir,
    lockFile: path.join(metaDir, LOCK_FILE),
    opsDir: path.join(metaDir, OPS_DIR),
    auditDir: path.join(metaDir, AUDIT_DIR),
    auditFile: path.join(metaDir, AUDIT_DIR, AUDIT_FILE),
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 只在 operationId 合法时用作文件名，其它一律哈希（避免路径注入）。 */
function operationFileName(operationId) {
  const id = String(operationId || '').trim().slice(0, 120)
  if (/^[A-Za-z0-9_-]{1,80}$/.test(id)) return `${id}.json`
  return `op-${sha256Of(Buffer.from(id, 'utf8')).slice(0, 24)}.json`
}

/** 把 targets 归一化成相对路径数组（支持字符串数组 / {path} 数组 / expectedHash 对象键）。 */
function normalizeTargets(targets) {
  if (!targets) return []
  if (Array.isArray(targets)) {
    return targets
      .map((item) => (typeof item === 'string' ? item : item && item.path))
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.replace(/\\/g, '/'))
  }
  if (typeof targets === 'object') return Object.keys(targets).map((key) => key.replace(/\\/g, '/'))
  return []
}

/** 读取目标文件当前 sha256（不存在记 null，表示"应为空/不存在"）。 */
export async function readHashes(projectPath, targets) {
  const out = []
  for (const relPath of normalizeTargets(targets)) {
    let hash = null
    try {
      hash = sha256Of(await fs.readFile(path.join(projectPath, relPath)))
    } catch {
      hash = null
    }
    out.push({ path: relPath, hash })
  }
  return out
}

/**
 * expectedHash 乐观锁校验：显式传入的每个路径都必须与当前内容一致。
 * `expectedHash` 形如 `{ '分集剧本/第001集.md': '<sha256|null>' }`（null 表示期望文件不存在）。
 */
export async function checkExpectedHash(projectPath, expectedHash) {
  if (!expectedHash || typeof expectedHash !== 'object') return { checked: 0 }
  const entries = Array.isArray(expectedHash)
    ? expectedHash
    : Object.entries(expectedHash).map(([relPath, hash]) => ({ path: relPath, sha256: hash }))
  const mismatched = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const relPath = String(entry.path || '').replace(/\\/g, '/')
    if (!relPath) continue
    const wanted = entry.sha256 === undefined ? entry.hash : entry.sha256
    let actual = null
    try {
      actual = sha256Of(await fs.readFile(path.join(projectPath, relPath)))
    } catch {
      actual = null
    }
    const expectedValue = wanted === null || wanted === undefined || wanted === '' ? null : String(wanted)
    if (actual !== expectedValue) mismatched.push({ path: relPath, expected: expectedValue, actual })
  }
  if (mismatched.length) {
    throw conflictError(
      `目标文件已被其他写入修改（expectedHash 不符）：${mismatched.map((item) => item.path).join('、')}`,
      '重新读取最新内容后再提交；若确认要覆盖并发修改，可去掉 expectedHash 重试一次。',
      mismatched,
    )
  }
  return { checked: entries.length }
}

/* ------------------------------------------------------------ 写审计 */

async function appendAudit(metaDir, entry) {
  const auditDir = path.join(metaDir, AUDIT_DIR)
  await fs.mkdir(auditDir, { recursive: true })
  const line = `${JSON.stringify(entry)}\n`
  await fs.appendFile(path.join(auditDir, AUDIT_FILE), line, 'utf8')
  return entry
}

/** 查询写审计：按时间倒序返回最近条目，可按 operationId / action / actor 过滤。 */
export async function queryAudit(root, title, options = {}) {
  const { auditFile } = pathsOf(root, title)
  let text = ''
  try {
    text = await fs.readFile(auditFile, 'utf8')
  } catch {
    return { entries: [], total: 0 }
  }
  const all = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  let filtered = all
  if (options.operationId) filtered = filtered.filter((item) => item.operationId === options.operationId)
  if (options.action) filtered = filtered.filter((item) => item.action === options.action)
  if (options.actor) filtered = filtered.filter((item) => item.actor === options.actor)
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 500)
  return { entries: filtered.slice(-limit).reverse(), total: filtered.length }
}

/* ------------------------------------------------------ operationId 幂等 */

async function readOperation(metaDir, operationId) {
  return readJson(path.join(metaDir, OPS_DIR, operationFileName(operationId)), null)
}

async function writeOperation(metaDir, operationId, payload) {
  const record = { operationId, at: new Date().toISOString(), ...payload }
  let text
  try {
    text = JSON.stringify(record, null, 2)
  } catch {
    return { cached: false, reason: 'unserializable' }
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_OPERATION_BYTES) return { cached: false, reason: 'too-large' }
  const dir = path.join(metaDir, OPS_DIR)
  await fs.mkdir(dir, { recursive: true })
  await store.atomicWrite(path.join(dir, operationFileName(operationId)), `${text}\n`)
  return { cached: true }
}

/* -------------------------------------------------------------- 项目锁 */

/**
 * 获取项目写锁：进程内 FIFO 队列 + `.aidrama/.lock.json` 跨进程互斥。
 * 返回 `{ token, release() }`；失败抛 conflict（带重试指引）。
 */
export async function acquireProjectLock(root, title, options = {}) {
  const { projectPath, metaDir, lockFile } = pathsOf(root, title)
  if (!(await store.isDirectory(projectPath))) throw new Error(`短剧《${title}》不存在`)
  await fs.mkdir(metaDir, { recursive: true })
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : LOCK_WAIT_MS
  const lockKey = projectPath

  // 1) 进程内排队（Promise 链）
  const previous = lockChains.get(lockKey) || Promise.resolve()
  let releaseChain = null
  const ourGate = new Promise((resolve) => {
    releaseChain = resolve
  })
  lockChains.set(lockKey, previous.then(() => ourGate))
  const deadline = Date.now() + timeoutMs
  let timer = null
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const outcome = await Promise.race([previous.then(() => 'acquired'), timedOut])
  if (timer) clearTimeout(timer)
  if (outcome === 'timeout') {
    releaseChain()
    throw conflictError(`项目「${title}」写操作排队超时（${timeoutMs}ms）`, '等待当前写操作完成后再重试；若长期占用可调用恢复清理陈旧锁。')
  }

  // 2) 跨进程文件锁（`.aidrama/.lock.json`，wx 独占到创建）
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  let fileHandle = null
  try {
    for (;;) {
      try {
        fileHandle = await fs.open(lockFile, 'wx')
        await fileHandle.writeFile(JSON.stringify({ token, pid: process.pid, title, acquiredAt: new Date().toISOString() }), 'utf8')
        break
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error
        const existing = await readJson(lockFile, null)
        const acquiredAt = existing && existing.acquiredAt ? Date.parse(existing.acquiredAt) : Number.NaN
        const age = Number.isFinite(acquiredAt) ? Date.now() - acquiredAt : Number.POSITIVE_INFINITY
        const stale = !existing || !Number.isFinite(age) || age > LOCK_TTL_MS || !(await processAlive(existing.pid))
        if (stale) {
          await fs.rm(lockFile, { force: true })
          continue
        }
        if (Date.now() > deadline) {
          throw conflictError(
            `项目「${title}」正被其他进程写入（持有者 pid=${existing.pid}）`,
            '稍后重试；若确认对方已退出，可调用 recoverProjectIsolation 清理陈旧锁。',
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
  } catch (error) {
    releaseChain()
    throw error
  }

  let released = false
  return {
    token,
    release: async () => {
      if (released) return
      released = true
      try {
        await fileHandle?.close()
      } catch {
        /* 忽略 */
      }
      const current = await readJson(lockFile, null)
      if (!current || current.token === token) {
        try {
          await fs.rm(lockFile, { force: true })
        } catch {
          /* 忽略 */
        }
      }
      releaseChain()
    },
  }
}

/* -------------------------------------------------------------- 事务执行 */

/**
 * 在一个项目写事务里执行 fn。
 *
 * @param {string} root 工作区根
 * @param {string} title 短剧名
 * @param {{ action?: string, operationId?: string, expectedHash?: object, targets?: string[]|object, actor?: string, agentId?: string, timeoutMs?: number }} meta
 * @param {() => Promise<any>} fn 实际写操作
 * @returns {Promise<any>} fn 的返回值；operationId 重放时返回首次结果 + `replayed: true`
 */
export async function runProjectTxn(root, title, meta, fn) {
  const safeTitle = String(title || '').trim()
  if (!safeTitle) throw new Error('写事务缺少项目名')
  const { projectPath, metaDir } = pathsOf(root, safeTitle)
  if (!(await store.isDirectory(projectPath))) throw new Error(`短剧《${safeTitle}》不存在`)
  if (typeof fn !== 'function') throw new Error('写事务缺少执行函数')

  // 可重入：同一项目事务内的嵌套写不再排队（AsyncLocalStorage）
  const current = txContext.getStore()
  const lockKey = projectPath
  if (current && current.lockKey === lockKey) return fn()

  const action = String((meta && meta.action) || 'write').slice(0, 80)
  const actor = String((meta && (meta.actor || meta.agentId)) || 'unknown').slice(0, 120)
  const operationId = meta && typeof meta.operationId === 'string' ? meta.operationId.trim().slice(0, 120) : ''
  const targets = normalizeTargets(meta && (meta.targets || meta.expectedHash))

  // 幂等：已执行过的 operationId 直接返回首次结果（不写盘、不重复计账）
  if (operationId) {
    const cached = await readOperation(metaDir, operationId)
    if (cached) {
      return { ...(cached.result && typeof cached.result === 'object' ? cached.result : {}), replayed: true, operationId }
    }
  }

  const lock = await acquireProjectLock(root, safeTitle, { timeoutMs: meta && meta.timeoutMs })
  try {
    const before = await readHashes(projectPath, targets)
    let result
    let failure = null
    try {
      // 乐观锁：在任何写入之前校验 expectedHash（校验失败也进审计，保证"失败事务可审计"）
      await checkExpectedHash(projectPath, meta && meta.expectedHash)
      result = await txContext.run({ lockKey, depth: 1, title: safeTitle, operationId }, fn)
    } catch (error) {
      failure = error
      throw error
    } finally {
      const after = await readHashes(projectPath, targets)
      const auditTargets = before.map((item, index) => ({
        path: item.path,
        beforeHash: item.hash,
        afterHash: after[index] ? after[index].hash : null,
      }))
      await appendAudit(metaDir, {
        at: new Date().toISOString(),
        action,
        project: safeTitle,
        actor,
        operationId: operationId || null,
        ok: failure === null,
        error: failure === null ? null : failure instanceof Error ? failure.message : String(failure),
        errorCode: failure && typeof failure.code === 'string' ? failure.code : null,
        targets: auditTargets,
      }).catch(() => null)
      if (operationId && failure === null) {
        await writeOperation(metaDir, operationId, { action, actor, result }).catch(() => null)
      }
    }
    return result
  } finally {
    await lock.release()
  }
}

/* ------------------------------------------------------ 隔离恢复 */

/**
 * 隔离恢复：
 *   1) 清理陈旧写锁（持有者进程已退出或超过 TTL），并记一条 `lock-recovered` 审计；
 *   2) 清理上次崩溃残留的原子写临时文件（项目根 / .aidrama / 分镜 / 定稿 / 导出）。
 * 返回 `{ recovered, removedTempFiles, lock }`。
 */
export async function recoverProjectIsolation(root, title) {
  const { projectPath, metaDir, lockFile } = pathsOf(root, title)
  if (!(await store.isDirectory(projectPath))) throw new Error(`短剧《${title}》不存在`)
  let recovered = false
  let lock = await readJson(lockFile, null)
  if (lock) {
    const acquiredAt = lock.acquiredAt ? Date.parse(lock.acquiredAt) : Number.NaN
    const age = Number.isFinite(acquiredAt) ? Date.now() - acquiredAt : Number.POSITIVE_INFINITY
    const alive = await processAlive(lock.pid)
    if (!alive || age > LOCK_TTL_MS) {
      await fs.rm(lockFile, { force: true })
      recovered = true
      await appendAudit(metaDir, {
        at: new Date().toISOString(),
        action: 'lock-recovered',
        project: String(title),
        actor: 'recovery',
        operationId: null,
        ok: true,
        error: null,
        targets: [{ path: `.aidrama/${LOCK_FILE}`, beforeHash: null, afterHash: null }],
        recoveredLock: lock,
      }).catch(() => null)
    }
  }
  let removedTempFiles = 0
  const dirs = [
    projectPath,
    metaDir,
    path.join(metaDir, 'storyboard'),
    path.join(metaDir, 'history'),
    path.join(projectPath, '分镜'),
    path.join(projectPath, '定稿'),
    path.join(projectPath, '导出'),
    path.join(projectPath, '总纲'),
    path.join(projectPath, '人物'),
    path.join(projectPath, '分集剧本'),
  ]
  for (const dir of dirs) removedTempFiles += await store.cleanTempFiles(dir)
  return { recovered, removedTempFiles, lock: recovered ? lock : null }
}
