/**
 * RC-22（X 方案）：Agent 直接写正式稿（六类）；本轮只删用户可见草稿工具，内部 drafts API 保留。
 * 写前快照 + expectedHash + 失败回滚；不迁移/不归档 .aidrama/drafts。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as store from './store.js'

export const CONTENT_KINDS = ['contract', 'outline', 'characters', 'episode', 'storyboard', 'file']
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const HISTORY_LIMIT = 20

function contentError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

function primaryPaths(kind, order, relPath) {
  const episode = kind === 'episode' || kind === 'storyboard' ? store.episodeFileName(order) : null
  const stem = episode ? episode.replace(/\.md$/, '') : null
  return {
    primary: kind === 'contract' ? '.aidrama/contract.json'
      : kind === 'outline' ? '.aidrama/outline.json'
        : kind === 'characters' ? '.aidrama/characters.json'
          : kind === 'episode' ? `分集剧本/${episode}`
            : kind === 'storyboard' ? `.aidrama/storyboard/${episode}.json`
              : relPath,
    all: kind === 'contract' ? ['.aidrama/contract.json', '剧集契约.md']
      : kind === 'outline' ? ['.aidrama/outline.json', '总纲/分集大纲.md']
        : kind === 'characters' ? ['.aidrama/characters.json', '人物/人物设定卡.md']
          : kind === 'episode' ? [`分集剧本/${episode}`]
            : kind === 'storyboard' ? [`.aidrama/storyboard/${episode}.json`, `分镜/${stem}.分镜.md`]
              : [relPath],
  }
}

function parseInput(input = {}) {
  const kind = String(input.kind == null ? '' : input.kind).trim()
  if (!CONTENT_KINDS.includes(kind)) throw contentError('invalid-args', `kind 必须是 ${CONTENT_KINDS.join('/')}`)
  if (typeof input.content !== 'string' || !input.content.length) throw contentError('invalid-args', 'content 不能为空')
  if (input.content.length > 2 * 1024 * 1024) throw contentError('invalid-args', 'content 超过 2MB')
  let order = null
  if (kind === 'episode' || kind === 'storyboard') {
    order = Number(input.order)
    if (!Number.isInteger(order) || order < 1 || order > 9999) throw contentError('invalid-args', 'order 必须是 1..9999 的整数')
  } else if (input.order !== undefined && input.order !== null) {
    throw contentError('invalid-args', `${kind} 不接受 order`)
  }
  let relPath = ''
  if (kind === 'file') {
    if (typeof input.path !== 'string' || !input.path.trim()) throw contentError('invalid-args', 'file 需要 path')
    relPath = input.path.trim().replace(/\\/g, '/')
    if (relPath.startsWith('.aidrama/') || relPath === '.aidrama' || relPath.startsWith('导出/')) {
      throw contentError('forbidden', 'file 目标不允许 .aidrama/导出 系统目录')
    }
  }
  return { kind, content: input.content, order, path: relPath, expectedHash: typeof input.expectedHash === 'string' ? input.expectedHash.trim() : null }
}

function historyStamp() { return new Date().toISOString().replace(/[:.]/g, '-') }

async function snapshot(dir, kind, paths) {
  const rootRel = `.aidrama/history/content-${kind}.${historyStamp()}`
  const files = []
  for (const rel of paths) {
    let buffer = null
    try {
      const target = await store.assertProjectWriteTarget(dir, rel)
      const stat = await fs.lstat(target).catch(() => null)
      if (stat && stat.isFile() && !stat.isSymbolicLink()) buffer = await fs.readFile(target)
    } catch { buffer = null }
    files.push({ rel, buffer })
    if (buffer) await store.guardedProjectWriteBinary(dir, `${rootRel}/${rel}`, buffer)
  }
  const existing = await fs.readdir(path.join(dir, '.aidrama', 'history')).catch(() => [])
  const stale = existing.filter((name) => name.startsWith(`content-${kind}.`)).sort()
  for (const name of stale.slice(0, Math.max(0, stale.length - HISTORY_LIMIT))) {
    await store.guardedProjectRemove(dir, `.aidrama/history/${name}`).catch(() => {})
  }
  return { rootRel, files }
}

async function rollback(dir, snapshotData) {
  for (const item of snapshotData.files) {
    try {
      if (item.buffer) await store.guardedProjectWriteBinary(dir, item.rel, item.buffer)
      else await store.guardedProjectRemove(dir, item.rel)
    } catch { /* best effort */ }
  }
}

async function shaOfTarget(dir, rel) {
  try {
    const target = await store.assertProjectWriteTarget(dir, rel)
    const stat = await fs.lstat(target).catch(() => null)
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null
    return sha256(await fs.readFile(target))
  } catch { return null }
}

export async function writeContent(root, title, input = {}) {
  const parsed = parseInput(input)
  const dir = store.projectDir(root, title)
  if (!(await store.isDirectory(dir))) throw contentError('not-found', `短剧《${title}》不存在`)
  const paths = primaryPaths(parsed.kind, parsed.order, parsed.path)
  const currentHash = await shaOfTarget(dir, paths.primary)
  if (parsed.expectedHash && parsed.expectedHash !== currentHash) {
    throw contentError('conflict', '目标内容已被其他写入修改（expectedHash 不符）', { currentHash })
  }
  const snap = await snapshot(dir, parsed.kind, paths.all)
  let result
  try {
    if (parsed.kind === 'contract') result = await store.saveContract(root, title, JSON.parse(parsed.content))
    else if (parsed.kind === 'outline') result = await store.saveOutline(root, title, JSON.parse(parsed.content))
    else if (parsed.kind === 'characters') result = await store.saveCharacters(root, title, JSON.parse(parsed.content))
    else if (parsed.kind === 'episode') result = await store.writeEpisode(root, title, parsed.order, parsed.content)
    else if (parsed.kind === 'storyboard') result = await store.saveStoryboard(root, title, parsed.order, JSON.parse(parsed.content))
    else if (parsed.kind === 'file') result = await store.writeEntryFile(root, title, parsed.path, parsed.content)
    else throw contentError('invalid-args', `不支持的内容类型：${parsed.kind}`)
  } catch (error) {
    await rollback(dir, snap)
    throw error
  }
  return { kind: parsed.kind, applied: parsed.kind, historySnapshot: snap.rootRel, hash: await shaOfTarget(dir, paths.primary), result }
}
