/**
 * v0.16.220 P0-B：LibTV 资产参考节点接线（dry-run 优先；不触发生成）。
 *
 * 链路：
 *   shot resolved assets → listNodes 查/复用资源节点
 *   → 无则 libtv upload <确定名> -f <素材/短剧资产/...> -p <uuid>
 *   → 镜头节点 create/update（不带 -r） + --left 资产节点 + prompt 资产段 + {{Node "资源节点"}}
 *   → -u 写 metadata（assetIds/assetStateBindings/refPaths/shotKey/episode）。
 *
 * 约束：不新增 API/METHOD/文件；不写项目；只在画布上建/更新节点与边；不删既有节点。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { compileAssetSegment, compileReferenceAssetSegment, normalizeAssetRefPath } from './asset-bindings.js'

const ASSET_PREFIX_RE = /^CHR|SPC|PRP|SHT|CST|VEH|EXP|SFX|VOX|MUS/i
const SHOT_PREFIX_RE = /^E\d{3}-/

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function padEpisode(episode) {
  return String(Math.max(1, Number(episode) || 1)).padStart(3, '0')
}

function seasonOf(episode) {
  const numeric = Math.max(1, Number(episode) || 1)
  return Math.floor((numeric - 1) / 100) + 1
}

function episodeInSeason(episode) {
  const numeric = Math.max(1, Number(episode) || 1)
  return ((numeric - 1) % 100) + 1
}

export function canvasAssetNodeName(assetId, episode = 1, options = {}) {
  const id = String(assetId || '').trim().toUpperCase()
  const prefix = textOf(options.prefix)
  if (prefix) return `${prefix}${id}`
  const season = String(seasonOf(episode)).padStart(2, '0')
  const ep = String(episodeInSeason(episode)).padStart(2, '0')
  return `S${season}-EP${ep}-ASSET-${id}`
}

export function canvasShotNodeName(shotKey, options = {}) {
  const text = textOf(shotKey)
  const prefix = textOf(options.prefix)
  if (!text) return prefix ? `${prefix}E001-01` : 'E001-01'
  return prefix ? `${prefix}${text}` : text
}

function metadataValue(value) {
  if (typeof value === 'string') return value
  return JSON.stringify(value == null ? null : value)
}

function existingAssetNodeFor(nodes, assetId, canonical) {
  const id = String(assetId || '').toUpperCase()
  const candidates = (Array.isArray(nodes) ? nodes : [])
    .filter((node) => node && textOf(node.name))
    .filter((node) => {
      const name = textOf(node.name)
      return name === canonical || name === id || name.startsWith(`${id}-`) || name.startsWith(`${id}_`)
    })
    .sort((a, b) => {
      const an = textOf(a.name)
      const bn = textOf(b.name)
      const ac = an.includes('副本') ? 1 : 0
      const bc = bn.includes('副本') ? 1 : 0
      return ac - bc || an.localeCompare(bn) || String(a.key || '').localeCompare(String(b.key || ''))
    })
  return candidates[0] || null
}

function existingShotNodeFor(nodes, shotName) {
  const wanted = textOf(shotName)
  if (!wanted) return null
  return (Array.isArray(nodes) ? nodes : []).find((node) => node && textOf(node.name) === wanted) || null
}

function promptWithCanvasRefs(prompt, assets, references) {
  const base = String(prompt == null ? '' : prompt)
  const segment = compileAssetSegment(assets)
  const core = base.includes('【本镜资产】') ? '' : segment
  const refs = references
    .filter((row) => row && row.nodeName)
    .map((row) => `{{Node "${row.nodeName}"}}`)
    .join(' ')
  const parts = [base, core, refs ? `【画布参考节点】${refs}` : ''].filter(Boolean)
  return parts.join('\n')
}

/** v0.16.261：视频参考模式；默认全能参考。 */
export const CANVAS_VIDEO_MODES = Object.freeze(['mixed2video', 'singleImage2video', 'text2video'])
const CANVAS_VIDEO_REF_LIMIT = Object.freeze({ mixed2video: 30, singleImage2video: 1, text2video: 0 })

/** 按模式选择参考资产：人物/场景优先、按绑定顺序去重、限制张数。 */
export function selectCanvasReferenceAssets(assets, mode) {
  const requested = mode == null || mode === '' ? 'mixed2video' : String(mode).trim()
  if (!CANVAS_VIDEO_MODES.includes(requested)) {
    const error = new Error(`视频生成模式非法：${requested}（允许 ${CANVAS_VIDEO_MODES.join('/')}）`)
    error.code = 'invalid-args'
    throw error
  }
  const list = (Array.isArray(assets) ? assets : [])
    .filter((asset) => asset && asset.status === 'resolved' && asset.refPath && asset.id)
  const unique = []
  const seen = new Set()
  for (const asset of list) {
    const key = String(asset.id)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(asset)
  }
  const rank = (asset) => (['CHARACTER', 'SCENE', 'CHR', 'SPC'].includes(String(asset.type || '').toUpperCase()) ? 0 : 1)
  const ordered = unique.map((asset, index) => ({ asset, index })).sort((a, b) => rank(a.asset) - rank(b.asset) || a.index - b.index).map((row) => row.asset)
  const limit = CANVAS_VIDEO_REF_LIMIT[requested]
  if (requested === 'singleImage2video' && ordered.length === 0) {
    const error = new Error('图生视频需要至少 1 张已绑定且存在的资产参考图；请先绑定资产/补图')
    error.code = 'invalid-args'
    throw error
  }
  const selected = ordered.slice(0, limit)
  const actualMode = requested === 'mixed2video' && selected.length === 0 ? 'text2video' : requested
  return { mode: actualMode, assets: selected, requestedMode: requested, total: ordered.length }
}

/**
 * 把一镜 resolved assets 接到 LibTV 画布（dry-run：默认不带 -r）。
 * @param {object} input
 * @param {object} input.backend LibTV adapter（需 listNodes/upload/createNodeNoRun/updateNode）
 * @param {string} input.projectUuid
 * @param {string} input.cwd 项目目录（项目内路径解析）
 * @param {object} input.shot
 * @param {Array<object>} input.assets resolveShotAssets 输出（仅 resolved 生效）
 * @param {string} input.prompt 既有投递 prompt（可已含资产段）
 * @param {string} input.shotKey E###-镜号
 * @param {number} input.episode
 * @param {string} [input.kind='image']
 * @param {string} [input.model]
 * @param {object} [input.params]
 * @param {boolean} [input.dry=true]
 */
export async function attachCanvasAssets(input = {}) {
  const backend = input.backend
  if (!backend || typeof backend.listNodes !== 'function' || typeof backend.upload !== 'function' || typeof backend.createNodeNoRun !== 'function' || typeof backend.updateNode !== 'function') {
    throw new Error('LibTV backend 缺少资产接线能力（listNodes/upload/createNodeNoRun/updateNode）')
  }
  const projectUuid = textOf(input.projectUuid)
  if (!projectUuid) throw new Error('需要 LibTV 画布 UUID')
  const cwd = textOf(input.cwd)
  if (!cwd) throw new Error('需要项目目录 cwd')
  const shot = input.shot || {}
  const resourcePrefix = textOf(input.resourcePrefix)
  const shotPrefix = textOf(input.shotPrefix)
  const shotKey = canvasShotNodeName(input.shotKey || `E${padEpisode(input.episode)}-${shot.shotNumber || '01'}`, { prefix: shotPrefix })
  const episode = Math.max(1, Number(input.episode) || 1)
  const isVideo = (input.kind || 'image') === 'video'
  const sourceAssets = isVideo && Array.isArray(input.referenceAssets) && input.referenceAssets.length
    ? input.referenceAssets
    : input.assets
  const selection = isVideo
    ? selectCanvasReferenceAssets(sourceAssets, input.mode)
    : { mode: null, assets: (Array.isArray(sourceAssets) ? sourceAssets : []).filter((asset) => asset && asset.status === 'resolved' && asset.id), requestedMode: null }
  const assets = selection.assets
  const referenceWarnings = []
  if (isVideo && selection.requestedMode === 'mixed2video' && assets.length === 0) {
    referenceWarnings.push({ code: 'reference_fallback_text', message: '全能参考未找到可用参考图，已回退文生视频' })
  }
  if (isVideo && selection.requestedMode === 'singleImage2video' && selection.total > 1) {
    referenceWarnings.push({ code: 'reference_trimmed_single', message: '图生视频仅使用第 1 张参考图，已忽略多余参考' })
  }
  if (isVideo && selection.requestedMode === 'mixed2video' && selection.total > CANVAS_VIDEO_REF_LIMIT.mixed2video) {
    referenceWarnings.push({ code: 'reference_trimmed_max', message: `全能参考最多 ${CANVAS_VIDEO_REF_LIMIT.mixed2video} 张，已截断` })
  }
  const nodeParams = { ...(input.params || {}) }
  if (isVideo) nodeParams.modeType = selection.mode
  const nodes = await backend.listNodes({ project: projectUuid, cwd })
  const references = []
  const created = []
  const reused = []

  let nodeResult
  let shotNode = null
  let shotNodeCreated = false
  let prompt = ''
  let assetStateBindings = []
  let refPaths = {}
  const cleanupCreated = async () => {
    if (typeof backend.deleteNode !== 'function') return
    const names = created.map((row) => row.nodeKey || row.nodeName)
    if (shotNodeCreated) names.push(shotKey)
    for (const name of names) await backend.deleteNode({ name, project: projectUuid, cwd }).catch(() => {})
  }
  try {
    for (const asset of assets) {
      const canonical = canvasAssetNodeName(asset.id, episode, { prefix: resourcePrefix })
      const existing = existingAssetNodeFor(nodes, asset.id, canonical)
      if (existing) {
        references.push({ id: asset.id, nodeName: existing.name, nodeKey: existing.key || null, refPath: asset.refPath, reused: true })
        reused.push({ id: asset.id, nodeName: existing.name })
        continue
      }
      const checked = normalizeAssetRefPath(asset.refPath)
      if (!checked.path) throw new Error(`资产 ${asset.id} 参考路径不合法（须 素材/短剧资产/）：${asset.refPath || 'null'}`)
      const absolute = path.join(cwd, ...checked.path.split('/'))
      const stat = await fs.stat(absolute).catch(() => null)
      if (!stat || !stat.isFile()) throw new Error(`资产参考图不存在：${checked.path}`)
      const uploaded = await backend.upload({ name: canonical, file: absolute, kind: 'image', project: projectUuid, cwd })
      const nodeName = textOf(uploaded && (uploaded.nodeName || uploaded.node)) || canonical
      references.push({ id: asset.id, nodeName, nodeKey: uploaded && uploaded.nodeKey ? uploaded.nodeKey : null, refPath: checked.path, reused: false })
      created.push({ id: asset.id, nodeName, nodeKey: uploaded && uploaded.nodeKey ? uploaded.nodeKey : null })
    }

    prompt = promptWithCanvasRefs(input.prompt, isVideo ? [] : assets, references)
    if (isVideo && assets.length && !prompt.includes('【本镜资产】')) {
      const referenceSegment = compileReferenceAssetSegment(assets)
      if (referenceSegment) prompt = `${referenceSegment}\n${prompt}`
    }
    assetStateBindings = Array.isArray(shot.assetStateBindings) ? shot.assetStateBindings : []
    refPaths = Object.fromEntries(references.map((row) => [row.id, row.refPath]))
    const meta = {
      assetIds: metadataValue(references.map((row) => row.id)),
      assetStateBindings: metadataValue(assetStateBindings),
      refPaths: metadataValue(refPaths),
      shotKey,
      episode: metadataValue(episode),
    }
    shotNode = existingShotNodeFor(nodes, shotKey)
    if (shotNode) {
      nodeResult = await backend.updateNode({
        name: shotKey,
        prompt,
        params: nodeParams,
        left: references.map((row) => row.nodeKey || row.nodeName),
        meta,
        project: projectUuid,
        cwd,
      })
    } else {
      shotNodeCreated = true
      nodeResult = await backend.createNodeNoRun({
        name: shotKey,
        kind: input.kind || 'image',
        prompt,
        model: input.model || undefined,
        params: nodeParams,
        left: references.map((row) => row.nodeKey || row.nodeName),
        meta,
        project: projectUuid,
        cwd,
      })
    }
  } catch (error) {
    await cleanupCreated()
    throw error
  }

  // v0.16.233：run 路径需要稳定 nodeKey；updateNode/CLI 返回可能不含 key，回读一次补全。
  let nodeKey = nodeResult && nodeResult.nodeKey ? nodeResult.nodeKey : null
  if (!nodeKey && typeof backend.nodeGet === 'function') {
    const detail = await backend.nodeGet(shotKey, { project: projectUuid, cwd }).catch(() => null)
    nodeKey = detail && detail.nodeKey ? detail.nodeKey : null
  }

  return {
    ok: true,
    dry: input.dry !== false,
    projectUuid,
    shotKey,
    nodeKey,
    created: Boolean(!shotNode),
    reusedShotNode: Boolean(shotNode),
    prompt,
    references,
    referenceCount: references.length,
    mode: selection.mode || null,
    requestedMode: selection.requestedMode || null,
    referenceWarnings,
    createdAssets: created,
    reusedAssets: reused,
    metadata: { assetIds: references.map((row) => row.id), assetStateBindings, refPaths, shotKey, episode },
    raw: nodeResult && nodeResult.raw ? nodeResult.raw : null,
  }
}

export const CANVAS_ASSET_NODE_PREFIX = 'S'
export const CANVAS_ASSET_ID_RE = ASSET_PREFIX_RE
export const CANVAS_SHOT_PREFIX_RE = SHOT_PREFIX_RE
