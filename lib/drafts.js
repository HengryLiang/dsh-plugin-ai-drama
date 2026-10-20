/**
 * 草稿区：AI 生成物一律先落草稿，用户采纳后才进正式目录（FR-B09 / FR-C09）。
 *
 * 存放：<项目>/.aidrama/drafts/<id>.json
 * 状态：pending（待处理）→ accepted（已采纳）/ discarded（已丢弃，可恢复）
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { atomicWrite } from './store.js'
import { assertSafeTitle } from './names.js'

const DRAFTS = 'drafts'
const MAX_DRAFTS = 500

export const DRAFT_KINDS = ['contract', 'outline', 'characters', 'episode', 'storyboard', 'file', 'batch-artifact']

function draftsDir(dir) {
  return path.join(dir, '.aidrama', DRAFTS)
}

function draftPath(dir, id) {
  return path.join(draftsDir(dir), `${id}.json`)
}

function newId() {
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 只允许 ASCII 安全字符的草稿 id，避免路径注入。 */
export function assertSafeDraftId(id) {
  if (typeof id !== 'string' || !/^d-[a-z0-9]+-[a-z0-9]+$/.test(id)) throw new Error('草稿 id 不合法')
  return id
}

async function readDraft(dir, id) {
  try {
    return JSON.parse(await fs.readFile(draftPath(dir, id), 'utf8'))
  } catch {
    throw new Error(`草稿不存在：${id}`)
  }
}

async function writeDraft(dir, draft) {
  await atomicWrite(draftPath(dir, draft.id), JSON.stringify(draft, null, 2) + '\n')
  return draft
}

export async function createDraft(projectDirPath, input) {
  const kind = String(input.kind || '')
  if (!DRAFT_KINDS.includes(kind)) throw new Error(`草稿类型不合法：${kind || '(空)'}`)
  if (!input.content) throw new Error('草稿内容不能为空')
  if (kind === 'episode' || kind === 'storyboard') {
    const order = Number(input.order)
    if (!Number.isFinite(order) || order < 1 || order > 9999) throw new Error('草稿集数需在 1~9999 之间')
  }
  if (kind === 'batch-artifact') {
    // P2-7（v0.7.1）：批量生成产物草稿 —— 内容为 JSON 元数据（批次/暂存路径/采纳目标），采纳时才拷入正式素材目录。
    let parsed = null
    try {
      parsed = JSON.parse(String(input.content || ''))
    } catch {
      throw new Error('批量产物草稿的 content 必须是 JSON 元数据')
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.batchId || !parsed.stagedRelative) {
      throw new Error('批量产物草稿需包含 batchId 与 stagedRelative')
    }
    if (!/^b-[a-z0-9][a-z0-9._-]{0,80}$/i.test(String(parsed.batchId))) throw new Error('批量产物草稿的 batchId 不合法')
  }

  const draft = {
    id: newId(),
    kind,
    title: String(input.title || '').slice(0, 120),
    order: input.order == null ? null : Number(input.order),
    path: input.path ? String(input.path).slice(0, 200) : null,
    content: typeof input.content === 'string' ? input.content : JSON.stringify(input.content),
    note: String(input.note || '').slice(0, 500),
    origin: {
      preset: String((input.origin && input.origin.preset) || 'unknown').slice(0, 40),
      model: String((input.origin && input.origin.model) || '').slice(0, 60),
      toolName: String((input.origin && input.origin.toolName) || '').slice(0, 60),
      callId: String((input.origin && input.origin.callId) || '').slice(0, 60),
      at: new Date().toISOString(),
    },
    status: 'pending',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  }

  await writeDraft(projectDirPath, draft)
  await enforceLimit(projectDirPath)
  return draft
}

async function enforceLimit(dir) {
  const all = await listDrafts(dir, { includeResolved: true })
  const resolved = all.filter((d) => d.status !== 'pending')
  if (resolved.length <= MAX_DRAFTS) return
  for (const stale of resolved.slice(0, resolved.length - MAX_DRAFTS)) {
    await fs.rm(draftPath(dir, stale.id), { force: true })
  }
}

export async function listDrafts(projectDirPath, options = {}) {
  let files = []
  try {
    files = await fs.readdir(draftsDir(projectDirPath))
  } catch {
    return []
  }
  const drafts = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      drafts.push(JSON.parse(await fs.readFile(path.join(draftsDir(projectDirPath), file), 'utf8')))
    } catch {
      /* 跳过损坏草稿 */
    }
  }
  const filtered = options.includeResolved ? drafts : drafts.filter((d) => d.status === 'pending')
  filtered.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return filtered
}

export async function getDraft(projectDirPath, id) {
  return readDraft(projectDirPath, assertSafeDraftId(id))
}

export async function resolveDraft(projectDirPath, id, status) {
  const draft = await readDraft(projectDirPath, assertSafeDraftId(id))
  if (draft.status !== 'pending') throw new Error(`草稿已处理过（当前状态：${draft.status}）`)
  if (!['accepted', 'discarded'].includes(status)) throw new Error('状态只能是 accepted 或 discarded')
  draft.status = status
  draft.resolvedAt = new Date().toISOString()
  return writeDraft(projectDirPath, draft)
}

export async function pendingCount(projectDirPath) {
  return (await listDrafts(projectDirPath)).length
}

/* ---------------------------------------------------------------- P1-B 扩展 */
/*
 * P1-B（FR-B09 / 契约 H-1）：在单条 resolveDraft 之外补齐
 *   - restoreDraft：把已丢弃（discarded）的草稿恢复为 pending，重新出现在草稿区；
 *   - resolveMany ：批量处理，逐条结果、单条失败不影响其余（不整体抛错）。
 * 说明：本模块不反向依赖 index.js / tools.js 的「落地到正式稿」逻辑，
 * 采纳（accept）的落地回调由调用方注入 options.apply(draft)。
 */

/** 恢复一条已丢弃的草稿：discarded → pending（内容未动，只改状态）。 */
export async function restoreDraft(projectDirPath, id) {
  const draft = await readDraft(projectDirPath, assertSafeDraftId(id))
  if (draft.status !== 'discarded') {
    throw new Error(`草稿当前状态是 ${draft.status}，只有已丢弃的草稿可以恢复`)
  }
  draft.status = 'pending'
  draft.resolvedAt = null
  draft.restoredAt = new Date().toISOString()
  return writeDraft(projectDirPath, draft)
}

/**
 * 批量处理草稿。
 * @param {string} projectDirPath 项目目录
 * @param {string[]} ids 草稿 id 列表
 * @param {'accept'|'discard'|'restore'} action
 * @param {{ apply?: (draft: object) => Promise<{applied?: string}> }} [options]
 *        accept 时必须提供 apply：由调用方把草稿内容写入正式稿（含 JSON 校验）。
 * @returns {Promise<Array<{id:string, action:string, ok:boolean, status?:string, applied?:string, error?:{code?:string, reason:string}}>>}
 */
export async function resolveMany(projectDirPath, ids, action, options = {}) {
  const apply = typeof options.apply === 'function' ? options.apply : null
  const results = []
  for (const rawId of Array.isArray(ids) ? ids : []) {
    const id = String(rawId || '').trim()
    if (!id) {
      results.push({ id: String(rawId ?? ''), action, ok: false, error: { code: 'invalid-args', reason: '草稿 id 不能为空' } })
      continue
    }
    try {
      if (action === 'restore') {
        const draft = await restoreDraft(projectDirPath, id)
        results.push({ id, action, ok: true, status: 'restored', draftStatus: draft.status })
        continue
      }
      if (action === 'accept') {
        const draft = await readDraft(projectDirPath, assertSafeDraftId(id))
        if (draft.status !== 'pending') throw new Error(`草稿已处理过（当前状态：${draft.status}），只有 pending 草稿可以采纳`)
        if (!apply) throw new Error('缺少 apply 回调，无法采纳草稿')
        const applied = await apply(draft)
        const resolved = await resolveDraft(projectDirPath, id, 'accepted')
        results.push({ id, action, ok: true, status: resolved.status, applied: applied && applied.applied })
        continue
      }
      const resolved = await resolveDraft(projectDirPath, id, action === 'discard' ? 'discarded' : action)
      results.push({ id, action, ok: true, status: resolved.status })
    } catch (error) {
      results.push({ id, action, ok: false, error: { reason: error instanceof Error ? error.message : String(error) } })
    }
  }
  return results
}

/** 汇总批量结果 → counts（H-1 冻结形状：accepted/discarded/restored/failed）。 */
export function countDraftResults(results) {
  const counts = { accepted: 0, discarded: 0, restored: 0, failed: 0 }
  for (const item of Array.isArray(results) ? results : []) {
    if (!item || item.ok !== true) {
      counts.failed += 1
      continue
    }
    if (item.status === 'accepted') counts.accepted += 1
    else if (item.status === 'discarded') counts.discarded += 1
    else if (item.status === 'restored') counts.restored += 1
    else counts.failed += 1
  }
  return counts
}
