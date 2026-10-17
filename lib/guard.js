/**
 * 阶段二 · 上游冲突保护与双主防护（FR-G08 / FR-G12）
 *
 * 要防的是什么（来自 neowow 官方技能的明确警告）：
 *   「网页端开着同一画布时先别动它——网页端刷新会用旧快照全量覆盖后端、物理删除 CLI 写入。」
 *
 * 能做什么、不能做什么，必须说清楚：
 *   - **不能**可靠检测"别人正开着网页端"——平台没有给出这种信号。
 *   - **能**做三件确定的事：
 *       1. 绑定检查：生成前确认当前项目目录绑定了哪张画布，避免写错画布；
 *       2. 写入前指纹：记录画布节点集合，作为"我们写之前的样子"；
 *       3. 漂移检测：写入后再取一次指纹，若我们自己创建的节点消失，判定为被上游覆盖。
 *   - 因此策略是：**事前提示 + 事中留证 + 事后可判定**，而不是假装能拦住。
 *
 * FR-G12 双主防护：剧本与分镜的**唯一事实源是本插件的项目数据**，画布是派生产物。
 * 对账时以分镜为准，报告"画布上多了什么、少了什么"，避免有人反过来拿画布当母本改稿。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import * as store from './store.js'

const GUARD_FILE = 'canvas-guard.json'

/** 各后端的绑定文件位置（相对项目目录）。 */
export const BINDING_FILES = {
  libtv: path.join('.libtv', 'project.json'),
  neowow: path.join('.neowow', 'project.json'),
}

/** 写入前必须让用户知道的事——无法程序化检测，所以每次都提示。 */
export const UPSTREAM_WARNING =
  '外部画布网页端若正开着同一张画布，其刷新会用旧快照全量覆盖后端、删除 CLI 写入的节点。提交前请先关闭该画布的网页端。'

function guardPath(root, title) {
  return path.join(store.projectDir(root, title), '.aidrama', GUARD_FILE)
}

async function readGuard(root, title) {
  try {
    return JSON.parse(await fs.readFile(guardPath(root, title), 'utf8'))
  } catch {
    return {}
  }
}

async function writeGuard(root, title, value) {
  await store.atomicWrite(guardPath(root, title), JSON.stringify(value, null, 2) + '\n')
}

/* ------------------------------------------------------------ 绑定检查 */

/**
 * 检查项目目录是否绑定了画布。未绑定时给出可执行的下一步，而不是让生成默默写错地方。
 */
export async function checkBinding(root, title, backendId = 'libtv') {
  const projectPath = store.projectDir(root, title)
  const relative = BINDING_FILES[backendId]
  if (!relative) {
    return { ok: false, backend: backendId, reason: 'unsupported-backend', detail: `后端 ${backendId} 没有已知的绑定文件约定` }
  }
  const file = path.join(projectPath, relative)
  let binding = null
  try {
    binding = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return {
      ok: false,
      backend: backendId,
      reason: 'not-bound',
      detail: `项目目录尚未绑定画布（缺 ${relative}）。先选定一张画布再生成，否则写入会落到错误的位置。`,
      bindingFile: file,
      fix: backendId === 'libtv'
        ? `在项目目录执行：libtv project use <画布UUID>`
        : `在项目目录执行：neowow project use <sessionId>`,
    }
  }
  const uuid = binding.projectUuid || binding.sessionId || null
  if (!uuid) {
    return { ok: false, backend: backendId, reason: 'binding-empty', detail: `绑定文件存在但没有画布标识：${file}`, bindingFile: file }
  }
  return { ok: true, backend: backendId, uuid, bindingFile: file, binding }
}

/* ------------------------------------------------------------ 指纹与漂移 */

/** 取一次画布指纹（节点集合）。取不到时返回 ok=false，不假装有指纹。 */
export async function snapshotCanvas(backend, options = {}) {
  if (!backend || typeof backend.listNodes !== 'function') {
    return { ok: false, reason: 'unsupported', detail: '该后端不支持读取节点列表' }
  }
  try {
    const nodes = await backend.listNodes(options)
    return {
      ok: true,
      at: new Date().toISOString(),
      count: nodes.length,
      keys: nodes.map((n) => n.key).sort(),
      names: nodes.map((n) => n.name),
    }
  } catch (error) {
    return { ok: false, reason: 'read-failed', detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 比较两次指纹。`expectedNew` 是我们本次写入期望出现的节点名；
 * 若它们不在 after 里，判定为被上游覆盖。
 */
export function compareSnapshots(before, after, expectedNew = []) {
  if (!before || !before.ok || !after || !after.ok) {
    return { comparable: false, reason: 'snapshot-unavailable', drifted: false }
  }
  const beforeKeys = new Set(before.keys)
  const afterKeys = new Set(after.keys)
  const added = after.keys.filter((k) => !beforeKeys.has(k))
  const removed = before.keys.filter((k) => !afterKeys.has(k))

  const afterNames = new Set(after.names || [])
  const missingExpected = (expectedNew || []).filter((n) => !afterNames.has(n))

  return {
    comparable: true,
    added,
    removed,
    missingExpected,
    // 我们自己写入的节点不见了 → 被上游覆盖的强信号
    drifted: missingExpected.length > 0,
    detail: missingExpected.length
      ? `以下节点在写入后消失：${missingExpected.join('、')}——很可能是外部画布网页端刷新用旧快照覆盖了`
      : null,
  }
}

/** 写入前留证。 */
export async function beginGuard(root, title, { backend, backendId, cwd }) {
  const binding = await checkBinding(root, title, backendId)
  const snapshot = binding.ok ? await snapshotCanvas(backend, { cwd }) : { ok: false, reason: 'not-bound' }
  const guard = await readGuard(root, title)
  guard[backendId] = { before: snapshot, expectedNew: [], binding, begunAt: new Date().toISOString() }
  await writeGuard(root, title, guard)
  return { binding, snapshot, warning: UPSTREAM_WARNING }
}

/** 提交时登记"我们期望出现的节点名"。 */
export async function expectNodes(root, title, backendId, names = []) {
  const guard = await readGuard(root, title)
  const entry = guard[backendId] || {}
  entry.expectedNew = [...new Set([...(entry.expectedNew || []), ...names.filter(Boolean)])]
  guard[backendId] = entry
  await writeGuard(root, title, guard)
  return entry.expectedNew
}

/** 写入后对账：取新指纹并与 before 比较。 */
export async function endGuard(root, title, { backend, backendId, cwd }) {
  const guard = await readGuard(root, title)
  const entry = guard[backendId] || {}
  const after = await snapshotCanvas(backend, { cwd })
  const verdict = compareSnapshots(entry.before, after, entry.expectedNew || [])
  guard[backendId] = { ...entry, after, verdict, endedAt: new Date().toISOString() }
  await writeGuard(root, title, guard)
  return { before: entry.before || null, after, verdict, warning: verdict.drifted ? UPSTREAM_WARNING : null }
}

/** 读取上次对账结论（供界面展示）。 */
export async function readGuardState(root, title) {
  return readGuard(root, title)
}

/* ------------------------------------------------------------ 双主防护 */

/**
 * FR-G12：以项目数据为唯一事实源，对账分镜表与画布节点。
 * 报告"画布上多了什么、少了什么"，但不自动改画布——改画布是用户的决定。
 */
export async function reconcile(root, title, { backend, episode, cwd }) {
  const shots = await store.getStoryboard(root, title, episode)
  const shotNumbers = shots.map((s) => String(s.shotNumber || '').trim()).filter(Boolean)

  const snapshot = await snapshotCanvas(backend, { cwd })
  if (!snapshot.ok) {
    return {
      ok: false,
      reason: snapshot.reason,
      detail: snapshot.detail || '读不到画布节点，无法对账',
      storyboardShots: shotNumbers.length,
    }
  }

  const canvasNames = snapshot.names.map((n) => String(n))
  // 节点名按 E###-<镜号> 约定命名（见 orchestrator.buildShotPrompt 的 namePrefix）
  const prefix = `E${String(Number(episode)).padStart(3, '0')}-`
  const canvasShots = canvasNames
    .filter((n) => n.startsWith(prefix))
    .map((n) => n.slice(prefix.length))

  const canvasSet = new Set(canvasShots)
  const shotSet = new Set(shotNumbers)
  const missingOnCanvas = shotNumbers.filter((s) => !canvasSet.has(s))
  const extraOnCanvas = canvasShots.filter((s) => !shotSet.has(s))

  return {
    ok: true,
    episode: Number(episode),
    sourceOfTruth: 'storyboard',
    detail: '剧本与分镜以本插件项目数据为准，画布是派生产物；对账只报告差异，不自动改画布',
    totalNodes: snapshot.count,
    storyboardShots: shotNumbers.length,
    canvasShots: canvasShots.length,
    missingOnCanvas,
    extraOnCanvas,
    consistent: missingOnCanvas.length === 0 && extraOnCanvas.length === 0,
  }
}
