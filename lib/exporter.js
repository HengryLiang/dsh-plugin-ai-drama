/**
 * 导出（FR-E03 / FR-E04）：Markdown 全本、JSON 结构化包、CSV 拍摄用分镜表。
 * 产物写入项目 导出/ 目录。
 *
 * P1-D / T10 校验链：
 *   - 写盘目标检查 checkExportTarget()：目录可创建/可写/剩余空间足够；
 *   - sha256 清单 buildExportManifest()：导出目录旁生成 `manifest.sha256.json`；
 *   - 复算入口 verifyExport()：离线/内部/QA 复用，篡改必报差异（不新增 HTTP route）；
 *   - 确定性检查 runDeterministicChecks() 在 lib/checks.js，导出结果内附摘要。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import * as store from './store.js'
import { extractAssetIds } from './assets.js'
import { resolveShotAssets } from './asset-bindings.js'
import { STYLE_DIMENSIONS, STYLE_DIMENSION_LABELS } from './style-dna.js'
import { stylePromptFor as styleInjectionStylePromptFor } from './style-injection.js'
import { runDeterministicChecks } from './checks.js'
import * as backup from './backup.js'
import * as importAssets from './import-assets.js'

// v0.16.29（TPL-H / M6）：模板配方包（选择集引用；不含媒体/绝对路径/内容）。
export const TEMPLATE_PACK_KIND = 'ai-drama-template-pack'
export const TEMPLATE_PACK_SCHEMA_VERSION = 1
export const TEMPLATE_PACK_MAX_TEMPLATES = 20

export const EXPORT_FORMATS = ['markdown', 'json', 'csv', 'vcs', 'manifest', 'srt', 'edit-csv', 'template-pack']
export const BACKUP_FORMAT = 'backup'
export const EXPORT_FORMATS_EXTENDED = [...EXPORT_FORMATS, BACKUP_FORMAT]
export function isExportFormat(format) { return EXPORT_FORMATS.includes(format) || format === BACKUP_FORMAT }

/** 导出产物旁的 sha256 清单文件名（T10 冻结口径）。 */
export const MANIFEST_FILE = 'manifest.sha256.json'

/** 导出最小剩余空间：低于该值直接拒绝，避免写一半。 */
const MIN_FREE_BYTES = 10 * 1024 * 1024

const sha256Of = (buffer) => createHash('sha256').update(buffer).digest('hex')

function csvCell(value) {
  const text = String(value == null ? '' : value).replace(/\r?\n/g, ' ')
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function safeFileStem(title) {
  return String(title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
}

/** 拍摄用分镜表：一行一个镜头，含所有执行必需字段。
 * 列顺序保持旧版 11 列不变；v0.10.0（0-4a）起仅当项目存在可选扩展字段时，
 * 在末尾追加新列（旧项目/旧数据输出字节级不变，旧消费者按列数读取仍兼容前缀）。 */
const STORYBOARD_OPTIONAL_HEADERS = ['情绪', '光影', '现场声', '禁令', '起止姿态', '衔接', '自然语言段', '焦段', '主体', '分组']
/** 既有导出可选列（v0.10.0 10 字段；sceneRef 不参与分镜表导出，导出互通留 2-5，列数保持 21 稳定）。 */
const EXPORT_OPTIONAL_FIELDS = ['emotion', 'light', 'ambientSound', 'constraints', 'poses', 'transitionToNext', 'naturalLanguagePrompt', 'lens', 'subject', 'groupId']

function hasOptionalShotFields(shot) {
  return EXPORT_OPTIONAL_FIELDS.some((key) => Object.hasOwn(shot, key))
}

function optionalShotCells(shot) {
  const emotion = shot.emotion && typeof shot.emotion === 'object' ? `${shot.emotion.label ?? ''} ${shot.emotion.intensity ?? ''}/100` : ''
  const poses = shot.poses && typeof shot.poses === 'object' ? `${shot.poses.startPose ?? ''} → ${shot.poses.endPose ?? ''}` : ''
  const constraints = Array.isArray(shot.constraints) ? shot.constraints.join('；') : ''
  return [
    emotion,
    shot.light || '',
    shot.ambientSound || '',
    constraints,
    poses,
    shot.transitionToNext || '',
    shot.naturalLanguagePrompt || '',
    shot.lens || '',
    shot.subject || '',
    shot.groupId || '',
  ]
}

/** v0.11.4（task-103 / 2-5）互通导出：分镜中参与资产占位符校验的文本字段（与导入侧口径一致）。 */
const INTEROP_TEXT_FIELDS = ['description', 'naturalLanguagePrompt', 'imagePrompt', 'videoPrompt']

/** v0.16.194（P0-③）+ v0.16.226（P0-05）：导出分镜绑定/资产引用视图；无资产零影响。 */
async function resolveShotStateBindingViews(root, title, shots) {
  const withAssets = (Array.isArray(shots) ? shots : []).some((shot) => (Array.isArray(shot.assetIds) && shot.assetIds.length) || (Array.isArray(shot.assetStateBindings) && shot.assetStateBindings.length))
  if (!withAssets) return shots
  const [cards, legacyAssets] = await Promise.all([
    store.getAssetCards(root, title).catch(() => []),
    store.getAssets(root, title).catch(() => []),
  ])
  const map = new Map((Array.isArray(cards) ? cards : []).map((card) => [String(card.id || '').toUpperCase(), card]))
  return shots.map((shot) => {
    const resolved = resolveShotAssets(shot, { cards, legacyAssets })
    const assetRefPaths = {}
    for (const asset of resolved) {
      if (asset && asset.refPath) assetRefPaths[asset.id] = asset.refPath
    }
    const bindingView = Array.isArray(shot.assetStateBindings) && shot.assetStateBindings.length
      ? shot.assetStateBindings.map((binding) => {
        const card = map.get(String(binding.cardId || '').toUpperCase()) || null
        const states = card && card.media && Array.isArray(card.media.states) ? card.media.states : []
        const state = states.find((item) => String(item.id || '') === String(binding.stateId || '')) || null
        return {
          cardId: binding.cardId,
          stateId: binding.stateId,
          stateName: state ? String(state.name || '') : '',
          cardVersion: card ? Number(card.version) || 1 : null,
          ...(card && state ? {} : { missing: true }),
        }
      })
      : []
    return {
      ...shot,
      ...(Array.isArray(shot.assetIds) && shot.assetIds.length ? { assetIds: shot.assetIds.slice() } : {}),
      ...(bindingView.length ? { assetStateBindings: bindingView } : {}),
      ...(Object.keys(assetRefPaths).length ? { assetRefPaths } : {}),
    }
  })
}

/**
 * v0.11.4（task-103 / 2-5）：互通只读汇总（资产引用/场景关联/风格 DNA）。
 * - 仅统计「被分镜引用且卡存在」的数据；无此类数据 → null（导出不出现新区块，旧格式字节不变）；
 * - 排序：资产/场景按 id；引用按 集·镜 顺序；风格按固定五维顺序；无时间戳。
 */
export async function buildInteropView(root, title) {
  const [assetCards, sceneCards, styleDNA, episodes] = await Promise.all([
    store.getAssetCards(root, title).catch(() => []),
    store.getScenes(root, title).catch(() => []),
    store.getStyleDNA(root, title).catch(() => null),
    store.listEpisodes(root, title),
  ])
  const assetById = new Map((assetCards || []).map((card) => [card.id, card]))
  const sceneById = new Map((sceneCards || []).map((scene) => [scene.id, scene]))
  const assetRefs = new Map()
  const sceneRefs = new Map()
  for (const episode of episodes) {
    const shots = await store.getStoryboard(root, title, episode.order)
    for (const shot of shots) {
      const label = `第 ${episode.order} 集 ${shot.shotNumber || '?'}`
      for (const field of INTEROP_TEXT_FIELDS) {
        for (const id of extractAssetIds(shot[field])) {
          if (!assetRefs.has(id)) assetRefs.set(id, [])
          if (!assetRefs.get(id).includes(label)) assetRefs.get(id).push(label)
        }
      }
      const sceneRef = shot.sceneRef ? String(shot.sceneRef).trim().toUpperCase() : ''
      if (sceneRef) {
        if (!sceneRefs.has(sceneRef)) sceneRefs.set(sceneRef, [])
        if (!sceneRefs.get(sceneRef).includes(label)) sceneRefs.get(sceneRef).push(label)
      }
    }
  }
  const assets = [...assetRefs.keys()]
    .filter((id) => assetById.has(id))
    .sort()
    .map((id) => {
      const card = assetById.get(id)
      const review = card && card.review && typeof card.review === 'object' ? card.review : null
      return {
        id,
        name: card.name || '',
        type: card.type || '',
        refs: assetRefs.get(id).slice(),
        ...(review ? { reviewStatus: review.status } : {}),
        ...(review && review.status === 'final' && review.finalPrompt ? { finalPrompt: review.finalPrompt } : {}),
      }
    })
  const scenes = [...sceneRefs.keys()]
    .filter((id) => sceneById.has(id))
    .sort()
    .map((id) => {
      const scene = sceneById.get(id)
      const review = scene.review && typeof scene.review === 'object' ? scene.review : null
      return {
        id,
        name: scene.name || '',
        space: scene.space || {},
        refs: sceneRefs.get(id).slice(),
        ...(review ? { reviewStatus: review.status } : {}),
        ...(review && review.status === 'final' && review.finalPrompt ? { finalPrompt: review.finalPrompt } : {}),
      }
    })
  const styleEntries = {}
  if (styleDNA && typeof styleDNA === 'object') {
    for (const dimension of STYLE_DIMENSIONS) {
      const text = String(styleDNA[dimension] || '').trim()
      if (text) styleEntries[dimension] = text
    }
  }
  const style = Object.keys(styleEntries).length ? styleEntries : null
  if (!assets.length && !scenes.length && !style) return null
  return { assets, scenes, ...(style ? { styleDNA: style } : {}) }
}

/** 渲染互通的 Markdown 区块（VCS/Markdown 共用；仅在存在被引用数据时调用）。 */
export function renderInteropMarkdown(interop) {
  const parts = []
  if (Array.isArray(interop.assets) && interop.assets.length) {
    parts.push('## 资产引用', '')
    for (const asset of interop.assets) {
      parts.push(`- ${asset.id} ${asset.name}${asset.type ? `（${asset.type}）` : ''} — 引用：${asset.refs.join('、') || '—'}`)
    }
    parts.push('')
  }
  if ((Array.isArray(interop.scenes) && interop.scenes.length) || interop.styleDNA) {
    parts.push('## 场景与风格', '')
    if (Array.isArray(interop.scenes) && interop.scenes.length) {
      parts.push('### 场景卡关联', '')
      for (const scene of interop.scenes) {
        const space = [scene.space?.interior, scene.space?.timeOfDay, scene.space?.weather].map((item) => String(item || '').trim()).filter(Boolean).join('/')
        parts.push(`- ${scene.id} ${scene.name}${space ? `（${space}）` : ''} — 分镜：${scene.refs.join('、') || '—'}`)
      }
      parts.push('')
    }
    if (interop.styleDNA) {
      parts.push('### 风格 DNA', '')
      for (const dimension of STYLE_DIMENSIONS) {
        const text = interop.styleDNA[dimension]
        if (text) parts.push(`- ${STYLE_DIMENSION_LABELS[dimension]}：${String(text).replace(/\r?\n/g, ' ')}`)
      }
      parts.push('')
    }
  }
  return parts
}

export async function buildStoryboardCsv(root, title) {
  const header = ['集数', '镜号', '景别', '运镜', '画面描述', '台词', '音效', '时长(秒)', '提示词', '生图提示词', '视频提示词']
  const rows = []
  let hasOptional = false
  const episodes = await store.listEpisodes(root, title)
  for (const episode of episodes) {
    const shots = await store.getStoryboard(root, title, episode.order)
    for (const shot of shots) {
      if (hasOptionalShotFields(shot)) hasOptional = true
      const base = [episode.order, shot.shotNumber, shot.shotSize, shot.cameraMove, shot.description, shot.dialogue, shot.sfx, shot.durationSec, shot.imagePrompt, shot.imagePrompt, shot.videoPrompt]
      rows.push([...base, ...optionalShotCells(shot)])
    }
  }
  // 只有存在可选字段才追加列：旧项目导出逐字节不变
  const headers = hasOptional ? [...header, ...STORYBOARD_OPTIONAL_HEADERS] : header
  const lines = [headers.join(',')]
  for (const row of rows) lines.push(row.slice(0, headers.length).map(csvCell).join(','))
  return lines.join('\n') + '\n'
}

function formatClock(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0))
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

/**
 * v0.10.1（task-81）：VCS/草帽兼容视图（只读渲染；**确定性输出**：同输入同字节、不含时间戳）。
 * 结构：集标题 +（单集时）全组情绪总控 + 逐镜块（镜头NN｜时间码｜景别｜焦段 + 正文/提示词/台词/光影/现场声）。
 * 可被 import-bridge 的 parser 回读（往返断言：镜数/台词/光影/现场声/资产占位符）。
 */
export async function buildVcsView(root, title) {
  const episodes = await store.listEpisodes(root, title)
  const parts = [
    `# ${title} · VCS 视图`,
    '',
    '> 由「AI 短剧」工作区导出（只读视图，用于与草帽/VCS 工作流交换；源数据仍为 .aidrama/storyboard/）。',
    '',
  ]
  const singleEpisode = episodes.length <= 1
  for (const episode of episodes) {
    const shots = await store.getStoryboard(root, title, episode.order)
    const groups = await store.getStoryboardGroups(root, title, episode.order)
    parts.push(`## 第 ${episode.order} 集`, '')
    if (Array.isArray(groups) && groups.length) {
      parts.push(singleEpisode ? '## 全组情绪总控' : '### 分组情绪总控', '')
      if (groups[0].notes) parts.push(groups[0].notes, '')
      for (const group of groups) {
        const emotionParts = []
        if (group.emotion?.curve?.length) emotionParts.push(group.emotion.curve.join('→'))
        if (group.emotion?.intensity != null) emotionParts.push(`强度 ${group.emotion.intensity}/100`)
        const meta = [`镜号：${(group.shotNumbers || []).join('、') || '—'}`]
        if (group.durationTargetSec != null) meta.push(`目标时长：${group.durationTargetSec} 秒`)
        if (emotionParts.length) meta.push(emotionParts.join('；'))
        if (groups.length > 1) parts.push(`- **${group.id}${group.name ? ` ${group.name}` : ''}**：${meta.join('；')}`)
      }
      if (!singleEpisode) parts.push('')
    }
    let elapsed = 0
    for (const [index, shot] of shots.entries()) {
      const duration = Math.max(0, Math.round(Number(shot.durationSec) || 0))
      const headerParts = [`镜头${String(index + 1).padStart(2, '0')}`, `${formatClock(elapsed)}-${formatClock(elapsed + duration)}`, shot.shotSize || '中景']
      if (shot.lens) headerParts.push(shot.lens)
      parts.push(headerParts.join('｜'))
      elapsed += duration
      const description = String(shot.description || '').trim()
      if (description) parts.push(description)
      const imagePrompt = String(shot.imagePrompt || '').trim()
      if (imagePrompt) parts.push(`生图提示词：${imagePrompt.replace(/\r?\n/g, ' ')}`)
      const videoPrompt = String(shot.videoPrompt || '').trim()
      if (videoPrompt) parts.push(`视频提示词：${videoPrompt.replace(/\r?\n/g, ' ')}`)
      const prompt = String(shot.naturalLanguagePrompt || '').trim()
      if (prompt && !(description && prompt.startsWith(description.slice(0, 30)))) {
        parts.push(`提示词：${prompt.replace(/\r?\n/g, ' ')}`)
      }
      if (shot.dialogue) {
        for (const line of String(shot.dialogue).split(/\r?\n/).filter(Boolean)) parts.push(`台词：${line}`)
      }
      if (shot.light) parts.push(`光影：${String(shot.light).replace(/\r?\n/g, '；')}`)
      const sound = shot.ambientSound || shot.sfx
      if (sound) parts.push(`现场声：${String(sound).replace(/\r?\n/g, '；')}`)
      parts.push('')
    }
  }
  // v0.11.4（task-103 / 2-5）：有被引用资产/场景/风格时末尾 add-only 追加互通区块（无数据不出现）
  const interop = await buildInteropView(root, title)
  if (interop) parts.push(...renderInteropMarkdown(interop))
  return parts.join('\n')
}

async function buildJson(root, title) {
  const contract = await store.getContract(root, title)
  const outline = await store.getOutline(root, title)
  const characters = await store.getCharacters(root, title)
  const episodes = await store.listEpisodes(root, title)
  const detail = []
  const storyboardGroups = {}
  for (const episode of episodes) {
    const { text } = await store.readEpisode(root, title, episode.order)
    detail.push({
      order: episode.order,
      script: text,
      storyboard: await resolveShotStateBindingViews(root, title, await store.getStoryboard(root, title, episode.order)),
    })
    // v0.10.0（0-4b）：分组 sidecar add-only（仅存在时输出，旧导出形状不变）
    const groups = await store.getStoryboardGroups(root, title, episode.order)
    if (Array.isArray(groups) && groups.length) storyboardGroups[String(episode.order)] = groups
  }
  const interop = await buildInteropView(root, title)
  return {
    generator: 'dsh-ai-drama',
    version: 1,
    exportedAt: new Date().toISOString(),
    title,
    contract,
    outline,
    characters,
    episodes: detail,
    ...(Object.keys(storyboardGroups).length ? { storyboardGroups } : {}),
    // v0.11.4（task-103 / 2-5）：互通 add-only 键（仅在存在被引用数据时出现；旧导出形状不变）
    ...(interop
      ? {
          assets: interop.assets,
          scenes: interop.scenes,
          ...(interop.styleDNA ? { styleDNA: interop.styleDNA } : {}),
        }
      : {}),
  }
}

async function buildMarkdown(root, title) {
  const project = await buildJson(root, title)
  const parts = [`# ${title}`, '', `> 导出自「AI 短剧」工作区 · ${project.exportedAt}`, '']

  parts.push('## 剧集契约', '')
  parts.push('| 字段 | 值 |', '|---|---|')
  const c = project.contract
  parts.push(`| 平台 | ${c.platform || '—'} |`)
  parts.push(`| 受众 | ${c.audience || '—'} |`)
  parts.push(`| 单集时长 | ${(c.episodeDurationSec || []).join(' ~ ')} 秒 |`)
  parts.push(`| 目标集数 | ${c.targetEpisodes || '—'} |`)
  parts.push(`| 画幅 | ${c.orientation === 'landscape' ? '横屏' : '竖屏'} |`)
  parts.push(`| 钩子密度 | ${c.hookDensity || '—'} |`)
  parts.push(`| 审核红线 | ${c.redlines || '—'} |`, '')

  parts.push('## 分集大纲', '')
  parts.push('| 集数 | 标题 | 一句话梗概 | 开场钩子 | 中段反转 | 结尾悬念 | 时长(秒) |', '|---|---|---|---|---|---|---|')
  for (const row of project.outline) {
    parts.push(
      `| ${[row.order, row.title, row.logline, row.hook, row.twist, row.cliffhanger, row.estDurationSec]
        .map((v) => String(v == null ? '' : v).replace(/\|/g, '\\|'))
        .join(' | ')} |`,
    )
  }
  parts.push('')

  parts.push('## 人物设定', '')
  for (const card of project.characters) {
    parts.push(`### ${card.name}（${card.role}）`, '')
    parts.push(`- 性格：${(card.personality || []).join('、') || '—'}`)
    parts.push(`- 形象提示词：${card.appearancePrompt || '—'}`)
    parts.push(`- 音色：${card.voiceHint || '—'}`, '')
    if (card.bio) parts.push(card.bio, '')
  }

  const projectHasOptional = project.episodes.some((episode) => (episode.storyboard || []).some(hasOptionalShotFields))
  const storyboardBaseHeaders = ['镜号', '景别', '运镜', '画面描述', '台词', '音效', '时长(秒)', '提示词', '视频提示词']
  for (const episode of project.episodes) {
    parts.push(`## 第 ${episode.order} 集`, '')
    if (episode.script) parts.push(episode.script.trim(), '')
    // v0.10.0（0-4b）：分组情绪总控（仅存在时输出）
    const episodeGroups = project.storyboardGroups?.[String(episode.order)]
    if (Array.isArray(episodeGroups) && episodeGroups.length) {
      parts.push('### 分组情绪总控', '')
      for (const group of episodeGroups) {
        const emotionParts = []
        if (group.emotion?.curve?.length) emotionParts.push(`情绪曲线：${group.emotion.curve.join('→')}`)
        if (group.emotion?.intensity != null) emotionParts.push(`强度 ${group.emotion.intensity}/100`)
        const detailParts = [`镜号：${(group.shotNumbers || []).join('、') || '—'}`]
        if (group.durationTargetSec != null) detailParts.push(`目标时长：${group.durationTargetSec} 秒`)
        if (emotionParts.length) detailParts.push(emotionParts.join('；'))
        if (group.notes) detailParts.push(`备注：${group.notes}`)
        parts.push(`- **${group.id}${group.name ? ` ${group.name}` : ''}**：${detailParts.join('；')}`)
      }
      parts.push('')
    }
    if (episode.storyboard.length) {
      parts.push('### 分镜表', '')
      if (projectHasOptional) {
        const headers = [...storyboardBaseHeaders, ...STORYBOARD_OPTIONAL_HEADERS]
        parts.push(`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`)
        for (const shot of episode.storyboard) {
          const base = [shot.shotNumber, shot.shotSize, shot.cameraMove, shot.description, shot.dialogue, shot.sfx, shot.durationSec, shot.imagePrompt, shot.videoPrompt]
          parts.push(
            `| ${[...base, ...optionalShotCells(shot)].map((v) => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`,
          )
        }
      } else {
        parts.push('| 镜号 | 景别 | 运镜 | 画面描述 | 台词 | 音效 | 时长(秒) | 提示词 | 视频提示词 |', '|---|---|---|---|---|---|---|---|---|')
        for (const shot of episode.storyboard) {
          parts.push(
            `| ${[shot.shotNumber, shot.shotSize, shot.cameraMove, shot.description, shot.dialogue, shot.sfx, shot.durationSec, shot.imagePrompt, shot.videoPrompt]
              .map((v) => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\n/g, ' '))
              .join(' | ')} |`,
          )
        }
      }
      parts.push('')
    }
  }

  // v0.11.4（task-103 / 2-5）：末尾 add-only 互通区块（仅存在被引用数据时）
  const interop = { assets: project.assets || [], scenes: project.scenes || [], styleDNA: project.styleDNA || null }
  if (interop.assets.length || interop.scenes.length || interop.styleDNA) parts.push(...renderInteropMarkdown(interop))
  return parts.join('\n')
}

/** 导出写盘目标检查（P1-D/T10）：目录可建、可写、剩余空间足够；失败抛出（工具契约归为 io-error）。 */
/* ---------------------------------------------------------------- C4b 生成清单 Manifest */
/** C4b：生成清单子格式与开关（只影响 format='manifest'；旧四格式行为不变）。 */
export const MANIFEST_FORMATS = ['json', 'md', 'csv']
const MANIFEST_SUFFIX = '-生成清单'

function manifestInvalid(message) {
  const error = new Error(message)
  error.code = 'invalid-args'
  return error
}

/** 归一 manifest 选项：子格式非法/开关非 bool → invalid-args（HTTP 400）；默认值按需求 v1.1。 */
export function normalizeManifestOptions(options = {}) {
  const raw = options && typeof options === 'object' ? options : {}
  const format = raw.manifestFormat === undefined || raw.manifestFormat === null ? 'json' : String(raw.manifestFormat)
  if (!MANIFEST_FORMATS.includes(format)) throw manifestInvalid(`不支持的生成清单子格式：${format}（可选 json/md/csv）`)
  const flags = {}
  for (const key of ['includeStyleChapter', 'includeAssets', 'includeScenes', 'includeTasks', 'includeVoice']) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'boolean') throw manifestInvalid(`${key} 必须是布尔值`)
    flags[key] = raw[key]
  }
  return {
    format,
    includeStyleChapter: flags.includeStyleChapter !== false,
    includeAssets: flags.includeAssets !== false,
    includeScenes: flags.includeScenes !== false,
    includeTasks: flags.includeTasks === true,
    includeVoice: flags.includeVoice === true,
  }
}

function shotOptionalFields(shot) {
  const optional = {}
  for (const key of EXPORT_OPTIONAL_FIELDS) {
    const value = shot ? shot[key] : undefined
    if (value == null) continue
    if (typeof value === 'string') {
      const text = value.trim()
      if (text) optional[key] = value
      continue
    }
    if (Array.isArray(value)) {
      if (value.length) optional[key] = value
      continue
    }
    if (typeof value === 'object') {
      if (Object.keys(value).length) optional[key] = value
    }
  }
  return optional
}

function manifestShot(shot) {
  const videoPrompt = String(shot.videoPrompt || '').trim()
  const imagePrompt = String(shot.imagePrompt || '').trim()
  const natural = String(shot.naturalLanguagePrompt || '').trim()
  const description = String(shot.description || '').trim()
  const assetRefs = []
  for (const field of INTEROP_TEXT_FIELDS) {
    for (const id of extractAssetIds(shot[field])) if (!assetRefs.includes(id)) assetRefs.push(id)
  }
  assetRefs.sort()
  const dialogue = String(shot.dialogue || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const optional = shotOptionalFields(shot)
  const sceneRef = shot.sceneRef ? String(shot.sceneRef).trim().toUpperCase() : ''
  return {
    shotNumber: String(shot.shotNumber || ''),
    shotSize: String(shot.shotSize || ''),
    cameraMove: String(shot.cameraMove || ''),
    description: String(shot.description || ''),
    dialogue: String(shot.dialogue || ''),
    sfx: String(shot.sfx || ''),
    durationSec: Number.isFinite(Number(shot.durationSec)) ? Number(shot.durationSec) : 0,
    imagePrompt: String(shot.imagePrompt || ''),
    videoPrompt: String(shot.videoPrompt || ''),
    shotPrompt: videoPrompt || imagePrompt || natural || description,
    ...(sceneRef ? { sceneRef } : {}),
    ...(Array.isArray(shot.assetIds) && shot.assetIds.length ? { assetIds: shot.assetIds.slice() } : {}),
    ...(Array.isArray(shot.assetStateBindings) && shot.assetStateBindings.length ? { assetStateBindings: shot.assetStateBindings } : {}),
    ...(shot.assetRefPaths && typeof shot.assetRefPaths === 'object' && Object.keys(shot.assetRefPaths).length ? { assetRefPaths: shot.assetRefPaths } : {}),
    assetRefs,
    ...(Object.keys(optional).length ? { optional } : {}),
    ...(dialogue.length ? { dialogueLines: dialogue } : {}),
  }
}

async function manifestTasks(root, title) {
  const file = path.join(store.projectDir(root, title), '.aidrama', 'tasks.json')
  let data
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  return data
    .filter((item) => item && typeof item === 'object' && item.id)
    .map((item) => ({
      id: String(item.id),
      backend: String(item.backend || ''),
      kind: String(item.kind || ''),
      episode: item.episode == null ? null : Number(item.episode),
      model: String(item.model || ''),
      prompt: String(item.prompt || ''),
      status: String(item.status || ''),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

async function manifestVoiceScripts(root, title, episodes) {
  const projectPath = store.projectDir(root, title)
  const scripts = []
  for (const episode of episodes) {
    // RC-26（v0.16.132）：新导出在 `导出/`；旧项目旧文件（`台词与音效/`）回退可读，按集去重取先命中。
    const candidates = [
      `导出/配音稿-第${String(episode.order).padStart(3, '0')}集.md`,
      `台词与音效/配音稿-第${String(episode.order).padStart(3, '0')}集.md`,
    ]
    for (const relative of candidates) {
      try {
        const stat = await fs.stat(path.join(projectPath, relative))
        if (stat.isFile()) { scripts.push({ episode: episode.order, path: relative, bytes: stat.size }); break }
      } catch {
        /* 该路径无文件 → 尝试下一候选；都无则跳过（确定性：只列出实际存在文件） */
      }
    }
  }
  return scripts
}

/**
 * C4b：生成清单视图（唯一数据源；JSON/MD/CSV 三渲染共用）。确定性：无时间戳/无随机；固定排序。
 * style：非 frozen/无 style → null；frozen → {source,status,revision,hash}，chapter 仅在 includeStyleChapter:true 时包含。
 */
export async function buildManifestView(root, title, options = {}) {
  const opts = normalizeManifestOptions(options)
  const episodes = await store.listEpisodes(root, title)
  const episodeViews = []
  for (const episode of episodes) {
    const shots = await resolveShotStateBindingViews(root, title, await store.getStoryboard(root, title, episode.order))
    episodeViews.push({ order: episode.order, shots: shots.map((shot) => manifestShot(shot)) })
  }
  let style = null
  const styleDoc = await store.readStyleDoc(root, title).catch(() => null)
  const stylePrompt = styleInjectionStylePromptFor(styleDoc)
  if (stylePrompt) {
    style = {
      source: stylePrompt.source,
      status: stylePrompt.status,
      revision: stylePrompt.revision,
      hash: stylePrompt.hash,
      ...(opts.includeStyleChapter ? { chapter: stylePrompt.chapter } : {}),
    }
  }
  let assets = []
  let scenes = []
  if (opts.includeAssets || opts.includeScenes) {
    const interop = await buildInteropView(root, title)
    if (interop) {
      if (opts.includeAssets) assets = (interop.assets || []).map((item) => ({ ...item }))
      if (opts.includeScenes) scenes = (interop.scenes || []).map((item) => ({ ...item }))
    }
  }
  const dialogue = []
  for (const episode of episodeViews) {
    for (const shot of episode.shots) {
      if (!shot.dialogue) continue
      for (const line of String(shot.dialogue).split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
        dialogue.push({ episode: episode.order, shotNumber: shot.shotNumber, text: line })
      }
    }
  }
  const view = {
    schemaVersion: 1,
    kind: 'generation-manifest',
    project: { title },
    style,
    episodes: episodeViews,
    assets,
    scenes,
    dialogue,
    audio: opts.includeVoice ? { voiceScripts: await manifestVoiceScripts(root, title, episodes) } : null,
    tasks: opts.includeTasks ? await manifestTasks(root, title) : [],
    execution: null,
    meta: { source: 'export-project', deterministic: true },
  }
  return view
}

/** C4b：Markdown 人读版（与 JSON 同源；确定性；无 generatedAt）。 */
export function renderManifestMarkdown(view) {
  const parts = [`# ${view.project.title} · 生成清单`, '', '> 由「AI 短剧」工作区导出（确定性；无时间戳）', '']
  parts.push('## 风格', '')
  if (view.style) {
    parts.push(`- 状态：frozen · revision ${view.style.revision} · hash ${view.style.hash || '—'}`, '')
    parts.push('### 视觉风格基准（只读章节）', '', '```text', view.style.chapter, '```', '')
  } else {
    parts.push('- 状态：未冻结（无只读风格章节）', '')
  }
  for (const episode of view.episodes) {
    parts.push(`## 第 ${episode.order} 集`, '')
    if (!episode.shots.length) {
      parts.push('（无分镜）', '')
      continue
    }
    parts.push('| 镜号 | 景别 | 运镜 | 画面 | 台词 | 音效 | 时长(秒) | 最终 prompt | 场景引用 | 资产引用 |', '|---|---|---|---|---|---|---|---|---|---|')
    for (const shot of episode.shots) {
      const cells = [shot.shotNumber, shot.shotSize, shot.cameraMove, shot.description, shot.dialogue, shot.sfx, shot.durationSec, shot.shotPrompt, shot.sceneRef || '', shot.assetRefs.join('、')]
      parts.push(`| ${cells.map((value) => String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')).join(' | ')} |`)
    }
    parts.push('')
  }
  if (view.assets.length) {
    parts.push('## 资产 finalPrompt', '')
    for (const asset of view.assets) {
      parts.push(`- ${asset.id} ${asset.name}${asset.type ? `（${asset.type}）` : ''}${asset.reviewStatus ? ` · ${asset.reviewStatus}` : ''}${asset.finalPrompt ? `：${String(asset.finalPrompt).replace(/\r?\n/g, ' ')}` : ''}`)
    }
    parts.push('')
  }
  if (view.scenes.length) {
    parts.push('## 场景 finalPrompt', '')
    for (const scene of view.scenes) {
      parts.push(`- ${scene.id} ${scene.name}${scene.reviewStatus ? ` · ${scene.reviewStatus}` : ''}${scene.finalPrompt ? `：${String(scene.finalPrompt).replace(/\r?\n/g, ' ')}` : ''}`)
    }
    parts.push('')
  }
  if (view.tasks && view.tasks.length) {
    parts.push('## 生成任务', '')
    for (const task of view.tasks) parts.push(`- ${task.id} · ${task.kind} · ${task.backend} · 第${task.episode ?? '—'}集 · ${task.status}`)
    parts.push('')
  }
  if (view.audio && view.audio.voiceScripts.length) {
    parts.push('## 配音稿', '')
    for (const item of view.audio.voiceScripts) parts.push(`- 第 ${item.episode} 集：${item.path}`)
    parts.push('')
  }
  return parts.join('\n')
}

/** v0.16.226 P0-05：CSV 资产映射（仅含资产时出现；无资产旧 CSV 字节不变）。 */
function assetMapCellOf(shot) {
  const ids = Array.isArray(shot && shot.assetIds) ? shot.assetIds : []
  if (!ids.length) return ''
  const refs = shot && shot.assetRefPaths && typeof shot.assetRefPaths === 'object' ? shot.assetRefPaths : {}
  const bindings = new Map((Array.isArray(shot.assetStateBindings) ? shot.assetStateBindings : []).map((row) => [String(row.cardId || '').toUpperCase(), String(row.stateId || '')]))
  return ids.map((id) => {
    const key = String(id || '').toUpperCase()
    const state = bindings.get(key) || ''
    const ref = refs[id] || refs[key] || ''
    return `${id}${state ? `[${state}]` : ''}=${ref || '—'}`
  }).join(';')
}

/** C4b：CSV 一行一镜（UTF-8 BOM 由写路径统一添加，与旧分镜 CSV 一致）。 */
export function buildManifestCsv(view) {
  const hasAssetMap = (view.episodes || []).some((episode) => (episode.shots || []).some((shot) => Array.isArray(shot.assetIds) && shot.assetIds.length))
  const headers = ['集数', '镜号', '景别', '运镜', '画面描述', '台词', '音效', '时长(秒)', '最终prompt', '生图提示词', '视频提示词', '场景引用', '资产引用', '风格revision', ...(hasAssetMap ? ['assetMap'] : [])]
  const styleRevision = view.style ? view.style.revision : ''
  const lines = [headers.join(',')]
  for (const episode of view.episodes) {
    for (const shot of episode.shots) {
      const row = [episode.order, shot.shotNumber, shot.shotSize, shot.cameraMove, shot.description, shot.dialogue, shot.sfx, shot.durationSec, shot.shotPrompt, shot.imagePrompt, shot.videoPrompt, shot.sceneRef || '', Array.isArray(shot.assetRefs) ? shot.assetRefs.join('、') : '', styleRevision, ...(hasAssetMap ? [assetMapCellOf(shot)] : [])]
      lines.push(row.map(csvCell).join(','))
    }
  }
  return lines.join('\n') + '\n'
}

/* ---------------------------------------------------------------- C5 字幕 SRT + 剪辑清单 CSV */
/** C5：导出错误（沿用宿主 code → 400 invalid-args / 404 not-found）。 */
function srtError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** C5：SRT 时间码 HH:MM:SS,mmm（整数毫秒；确定性）。 */
export function formatSrtTimecode(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0))
  const hours = Math.floor(total / 3600000)
  const minutes = Math.floor((total % 3600000) / 60000)
  const seconds = Math.floor((total % 60000) / 1000)
  const millis = total % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`
}

/** C5：台词合并（多行去空白保留换行；空台词 → ''）。 */
export function mergedDialogueText(shot) {
  return String((shot && shot.dialogue) || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * C5：生效时长（秒）。durationSec>0 用原值；否则 max(2,min(15,ceil(chars/4)))，
 * chars=合并台词去空白后的 Unicode code point 数（空台词=0→2s）。
 */
export function effectiveShotDurationSec(shot) {
  const raw = Number(shot && shot.durationSec)
  if (Number.isFinite(raw) && raw > 0) return raw
  const text = mergedDialogueText(shot).replace(/\s/g, '')
  const chars = [...text].length
  return Math.max(2, Math.min(15, Math.ceil(chars / 4)))
}

/** C5：单集时间线（分镜原顺序累计；空台词镜也累计时间）。 */
export async function buildEpisodeTimeline(root, title, order) {
  const episode = Number(order)
  if (!Number.isInteger(episode) || episode < 1) throw srtError('invalid-args', 'srt 需要 episode（正整数）')
  const shots = await store.getStoryboard(root, title, episode)
  if (!Array.isArray(shots) || shots.length === 0) throw srtError('not-found', `第 ${episode} 集没有分镜，无法生成字幕`)
  let startMs = 0
  const timeline = []
  for (const shot of shots) {
    const durationSec = effectiveShotDurationSec(shot)
    const durationMs = Math.round(durationSec * 1000)
    const inMs = startMs
    const outMs = startMs + durationMs
    startMs = outMs
    timeline.push({ shot, dialogueText: mergedDialogueText(shot), durationSec, durationMs, inMs, outMs })
  }
  return { order: episode, timeline, totalMs: startMs }
}

/**
 * C5：单集 SRT（一镜一条 cue；空台词跳过 cue 但时间继续累计；无 BOM/无 timestamp；
 * cue 间空行、文件末尾换行；0 cue → 空串（空文件））。
 */
export async function buildSrt(root, title, options = {}) {
  const rawEpisode = options && options.episode
  const episodeNumber = Number(rawEpisode)
  if (rawEpisode === undefined || rawEpisode === null || String(rawEpisode).trim() === '' || !Number.isInteger(episodeNumber) || episodeNumber < 1) {
    throw srtError('invalid-args', 'srt 需要 episode（正整数）')
  }
  const { timeline } = await buildEpisodeTimeline(root, title, episodeNumber)
  const blocks = []
  let cue = 0
  for (const item of timeline) {
    if (!item.dialogueText) continue
    cue += 1
    blocks.push(`${cue}\n${formatSrtTimecode(item.inMs)} --> ${formatSrtTimecode(item.outMs)}\n${item.dialogueText}\n`)
  }
  return blocks.join('\n')
}

/** C5：CSV 单元格（一行一镜：换行归一为空格；含引号/逗号时整体加引号、引号双写）。 */
function editCsvCell(value) {
  const text = String(value == null ? '' : value).replace(/\r?\n/g, ' ')
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function shotAssetRefs(shot) {
  const refs = []
  for (const field of INTEROP_TEXT_FIELDS) for (const id of extractAssetIds(shot[field])) if (!refs.includes(id)) refs.push(id)
  return refs.slice().sort()
}

/**
 * C5：全本剪辑清单 CSV（一行一镜、固定 15 列、BOM 由写路径加；in/outTC 与 SRT 同源；
 * 行序 episode 升序 + shotNumber 数值升序（非数字稳定字符串序）。
 */
export async function buildEditCsv(root, title) {
  const header = ['episode', 'shotNumber', 'shotSize', 'cameraMove', 'durationSec', 'inTC', 'outTC', 'description', 'dialogue', 'sfx', 'sceneRef', 'assetRefs', 'subtitle', 'transitionToNext', 'videoPrompt']
  const episodes = await store.listEpisodes(root, title)
  const rows = []
  for (const episode of episodes) {
    let shots = []
    try {
      shots = await store.getStoryboard(root, title, episode.order)
    } catch {
      shots = []
    }
    if (!Array.isArray(shots)) shots = []
    let startMs = 0
    const timeline = shots.map((shot, index) => {
      const durationSec = effectiveShotDurationSec(shot)
      const durationMs = Math.round(durationSec * 1000)
      const inMs = startMs
      const outMs = startMs + durationMs
      startMs = outMs
      return { shot, durationSec, inMs, outMs, index }
    })
    const sortNumeric = (a, b) => {
      const na = Number(a.shot.shotNumber)
      const nb = Number(b.shot.shotNumber)
      const aNum = Number.isFinite(na) && String(a.shot.shotNumber || '').trim() !== ''
      const bNum = Number.isFinite(nb) && String(b.shot.shotNumber || '').trim() !== ''
      if (aNum && bNum && na !== nb) return na - nb
      if (aNum !== bNum) return aNum ? -1 : 1
      if (aNum && bNum && na === nb) return a.index - b.index
      const sa = String(a.shot.shotNumber || '')
      const sb = String(b.shot.shotNumber || '')
      return sa < sb ? -1 : sa > sb ? 1 : a.index - b.index
    }
    timeline.sort(sortNumeric)
    for (const item of timeline) {
      const shot = item.shot
      const dialogue = String(shot.dialogue || '')
      const subtitle = dialogue.trim()
      const durationText = Number.isFinite(Number(shot.durationSec)) && Number(shot.durationSec) > 0 ? Number(shot.durationSec) : item.durationSec
      rows.push([
        episode.order,
        String(shot.shotNumber || ''),
        String(shot.shotSize || ''),
        String(shot.cameraMove || ''),
        durationText,
        formatSrtTimecode(item.inMs),
        formatSrtTimecode(item.outMs),
        String(shot.description || ''),
        dialogue,
        String(shot.sfx || ''),
        shot.sceneRef ? String(shot.sceneRef).trim().toUpperCase() : '',
        shotAssetRefs(shot).join(';'),
        subtitle,
        String(shot.transitionToNext || ''),
        String(shot.videoPrompt || ''),
      ])
    }
  }
  const lines = [header.join(',')]
  for (const row of rows) lines.push(row.map(editCsvCell).join(','))
  return lines.join('\n') + '\n'
}

export async function checkExportTarget(outDir, projectPath = null) {
  if (projectPath) {
    const realProject = await fs.realpath(projectPath).catch(() => path.resolve(projectPath))
    const rel = path.relative(realProject, outDir)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('导出目录越出项目')
    outDir = await store.assertProjectWriteTarget(realProject, rel.split(path.sep).join('/'))
  }
  await fs.mkdir(outDir, { recursive: true })
  const probe = path.join(outDir, `.write-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
  try {
    await fs.writeFile(probe, 'ok', 'utf8')
  } catch (error) {
    throw new Error(`导出目录不可写：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await fs.rm(probe, { force: true })
  }
  // 剩余空间闸门：拿不到 statfs（老内核/特殊盘）时跳过，不误伤正常导出。
  try {
    const stat = await fs.statfs(outDir)
    const free = Number(stat.bavail) * Number(stat.bsize)
    if (Number.isFinite(free) && free > 0 && free < MIN_FREE_BYTES) {
      throw new Error(`导出目录所在磁盘剩余空间不足（${(free / 1024 / 1024).toFixed(1)} MB，至少需要 ${MIN_FREE_BYTES / 1024 / 1024} MB）`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('剩余空间不足')) throw error
  }
  return { ok: true, dir: outDir }
}

/**
 * 生成/刷新导出目录的 sha256 清单（T10 冻结口径）：
 *   `{ version:1, generatedAt, project, algorithm:'sha256', files:[{path,bytes,sha256}] }`
 * `path` 相对「导出/」目录，便于把产物目录整体拷走离线复算；清单自身不计入。
 */
export async function buildExportManifest(root, title) {
  const projectPath = store.projectDir(root, title)
  // v0.16.10（M2）：先 guard 导出目录（junction/symlink 拒绝），再做可写性/空间检查（避免 probe 写穿）。
  const safeExportDir = await store.assertProjectWriteTarget(projectPath, '导出')
  await checkExportTarget(safeExportDir, projectPath)
  const exportDir = path.join(projectPath, '导出')
  let entries = []
  try {
    entries = await fs.readdir(exportDir, { withFileTypes: true })
  } catch {
    entries = []
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === MANIFEST_FILE || entry.name.startsWith('.write-probe-')) continue
    const file = path.join(exportDir, entry.name)
    const buffer = await fs.readFile(file)
    files.push({ path: entry.name, bytes: buffer.length, sha256: sha256Of(buffer) })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    project: title,
    algorithm: 'sha256',
    files,
  }
  const manifestFile = path.join(exportDir, MANIFEST_FILE)
  await store.guardedProjectWrite(projectPath, `导出/${path.basename(manifestFile)}`, `${JSON.stringify(manifest, null, 2)}\n`)
  return { file: manifestFile, relative: path.relative(projectPath, manifestFile), manifest }
}

const FORMAT_SUFFIX = { markdown: '-全本.md', json: '.json', csv: '-分镜表.csv', vcs: '-VCS视图.md', manifest: '-生成清单', srt: '-字幕-第', 'edit-csv': '-剪辑清单.csv', 'template-pack': '-模板包.json' }

/**
 * 复算导出清单（不新增 HTTP route，供内部/QA/离线复用）：
 * 逐个文件重算 sha256 与 bytes，比对 manifest；缺失/被篡改都返回差异定位。
 * `format` 省略表示校验清单内全部产物。
 */
export async function verifyExport(root, title, format = 'all') {
  const projectPath = store.projectDir(root, title)
  const exportDir = path.join(projectPath, '导出')
  const manifestFile = path.join(exportDir, MANIFEST_FILE)
  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
  } catch {
    return { ok: false, reason: `缺少导出清单：${MANIFEST_FILE}`, manifestFile, checked: 0, mismatched: [], missing: [], files: [] }
  }
  const suffix = FORMAT_SUFFIX[format] || ''
  const targets = (manifest.files || []).filter((item) => format === 'manifest' ? /-生成清单\.(?:json|md|csv)$/.test(String(item.path)) : format === 'srt' ? /-字幕-第[0-9]+集\.srt$/.test(String(item.path)) : suffix ? String(item.path).endsWith(suffix) : true)
  const results = []
  for (const item of targets) {
    const file = path.join(exportDir, item.path)
    let actual = null
    let bytes = null
    try {
      const buffer = await fs.readFile(file)
      actual = sha256Of(buffer)
      bytes = buffer.length
    } catch {
      actual = null
      bytes = null
    }
    results.push({
      path: item.path,
      ok: actual !== null && actual === item.sha256 && bytes === item.bytes,
      expected: item.sha256,
      actual,
      bytes: { expected: item.bytes, actual: bytes },
    })
  }
  const mismatched = results.filter((item) => !item.ok)
  return {
    ok: results.length > 0 && mismatched.length === 0,
    manifestFile,
    checked: results.length,
    mismatched,
    missing: results.filter((item) => item.actual === null).map((item) => item.path),
    files: results,
    checkedAt: new Date().toISOString(),
  }
}

function templatePackError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

/**
 * v0.16.29（TPL-H / M6）：构建模板配方包（仅选择集引用；无媒体/绝对路径/内容）。
 * - 取当前项目 `.aidrama/import-templates.json` 全部模板（≤20）；
 * - 空包 → code `template-pack-empty`；模板文件损坏/超限 → `templates-corrupt`；
 * - checksum = sha256(JSON.stringify(templates))（紧凑序列化；导入侧强制校验）。
 */
export async function buildTemplatePack(root, title) {
  const state = await importAssets.readImportTemplates(root, title)
  if (state && state.error) {
    const code = String(state.error.code || '')
    if (code === 'forbidden') throw templatePackError('forbidden', state.error.message || '模板目录不可读')
    if (code === 'not-found') throw templatePackError('not-found', state.error.message || '短剧项目不存在')
    if (code === 'templates-corrupt') throw templatePackError('templates-corrupt', state.error.message || '模板文件损坏')
    throw templatePackError('templates-read-failed', state.error.message || '模板文件不可读')
  }
  if (state && state.corrupted) throw templatePackError('templates-corrupt', '模板文件存在无法识别的内容，已拒绝导出（请先修复或删除模板文件）')
  const templates = state && Array.isArray(state.templates) ? state.templates : []
  if (!templates.length) throw templatePackError('template-pack-empty', '当前项目暂无组合模板，无法导出模板包')
  if (templates.length > TEMPLATE_PACK_MAX_TEMPLATES) {
    throw templatePackError('templates-corrupt', `模板数量超过上限（${TEMPLATE_PACK_MAX_TEMPLATES}），已拒绝导出`)
  }
  const checksum = sha256Of(Buffer.from(JSON.stringify(templates), 'utf8'))
  return {
    kind: TEMPLATE_PACK_KIND,
    schemaVersion: TEMPLATE_PACK_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    sourceProject: String(title),
    templates,
    checksum,
  }
}

export async function exportProject(root, title, format = 'markdown', options = {}) {
  if (!isExportFormat(format)) throw new Error(`不支持的导出格式：${format}`)
  const manifestOptions = format === 'manifest' ? normalizeManifestOptions(options) : null
  const dir = store.projectDir(root, title)
  if (!(await store.isDirectory(dir))) throw new Error(`短剧《${title}》不存在`)
  if (format === 'backup') {
    if (options && options.backupAction === 'verify') return { format: 'backup', verify: await backup.verifyBackup(root, title, options.backupDir) }
    return await backup.createBackup(root, title, options)
  }
  // v0.16.10（M2）：先 guard 导出目录（junction/symlink 拒绝），再做可写性/空间检查。
  const safeOutDir = await store.assertProjectWriteTarget(dir, '导出')
  await checkExportTarget(safeOutDir, dir)
  // 对外路径保持项目原始路径（不暴露 realpath/8.3 展开）；写盘走 guard。
  const outDir = path.join(dir, '导出')
  const stem = safeFileStem(title)

  let file
  let bytes
  if (format === 'markdown') {
    const content = await buildMarkdown(root, title)
    file = path.join(outDir, `${stem}-全本.md`)
    await store.guardedProjectWrite(dir, `导出/${path.basename(file)}`, content)
    bytes = Buffer.byteLength(content, 'utf8')
  } else if (format === 'json') {
    const content = JSON.stringify(await buildJson(root, title), null, 2) + '\n'
    file = path.join(outDir, `${stem}.json`)
    await store.guardedProjectWrite(dir, `导出/${path.basename(file)}`, content)
    bytes = Buffer.byteLength(content, 'utf8')
  } else if (format === 'csv') {
    const content = await buildStoryboardCsv(root, title)
    file = path.join(outDir, `${stem}-分镜表.csv`)
    await store.guardedProjectWrite(dir, `导出/${path.basename(file)}`, '\ufeff' + content) // BOM：便于 Excel 正确识别中文
    bytes = Buffer.byteLength(content, 'utf8')
  } else if (format === 'srt') {
    // C5：按集字幕（episode 必填正整数；无该集/无分镜 → 404 零写；无 BOM）
    const content = await buildSrt(root, title, options)
    const episode = Number(options && options.episode)
    file = path.join(outDir, `${stem}-字幕-第${String(episode).padStart(3, '0')}集.srt`)
    await store.guardedProjectWrite(dir, `导出/${path.basename(file)}`, content)
    bytes = Buffer.byteLength(content, 'utf8')
  } else if (format === 'edit-csv') {
    // C5：全本剪辑清单 CSV（一行一镜；BOM 由写路径加）
    const content = await buildEditCsv(root, title)
    file = path.join(outDir, `${stem}-剪辑清单.csv`)
    await store.guardedProjectWrite(dir, `导出/${path.basename(file)}`, '\ufeff' + content)
    bytes = Buffer.byteLength(content, 'utf8')
  } else if (format === 'manifest') {
    // C4b：生成清单（JSON/MD/CSV 同源；确定性；无 generatedAt）
    const view = await buildManifestView(root, title, options)
    const sub = manifestOptions.format
    const content = sub === 'json' ? `${JSON.stringify(view, null, 2)}\n` : sub === 'md' ? renderManifestMarkdown(view) : buildManifestCsv(view)
    const ext = sub === 'json' ? 'json' : sub === 'md' ? 'md' : 'csv'
    file = path.join(outDir, `${stem}-生成清单.${ext}`)
    await store.guardedProjectWrite(dir, `导出/${path.basename(file)}`, sub === 'csv' ? '\ufeff' + content : content)
    bytes = Buffer.byteLength(content, 'utf8')
  } else if (format === 'template-pack') {
    // v0.16.29（TPL-H / M6）：模板配方包（JSON；无媒体/绝对路径）→ 导出/<剧>-模板包.json
    const pack = await buildTemplatePack(root, title)
    const content = `${JSON.stringify(pack, null, 2)}\n`
    file = path.join(outDir, `${stem}-模板包.json`)
    await store.guardedProjectWrite(dir, `导出/${path.basename(file)}`, content)
    bytes = Buffer.byteLength(content, 'utf8')
  } else {
    // v0.10.1（task-81）：VCS/草帽兼容视图（add-only；确定性输出）
    const content = await buildVcsView(root, title)
    file = path.join(outDir, `${stem}-VCS视图.md`)
    await store.guardedProjectWrite(dir, `导出/${path.basename(file)}`, content)
    bytes = Buffer.byteLength(content, 'utf8')
  }

  // 写后校验链：sha256 清单 → 复算 → 确定性检查摘要（不阻断；strict 由工具层决定）
  const manifest = await buildExportManifest(root, title)
  const verify = await verifyExport(root, title, format)
  const checks = await runDeterministicChecks(root, { title })
  return {
    format,
    ...(format === 'manifest' ? { manifestFormat: manifestOptions.format } : {}),
    file,
    bytes,
    manifest: { file: manifest.file, relative: manifest.relative, fileCount: manifest.manifest.files.length },
    verify: { ok: verify.ok, checked: verify.checked },
    checks: {
      ok: checks.ok,
      summary: checks.summary,
      // v0.10.2（B1-A）：failed 仅 FAIL（severity=fail）；WARN 只增到 warned（不阻断 strict）
      failed: checks.checks.filter((item) => item.severity === 'fail' && !item.ok).map((item) => ({ id: item.id, label: item.label, detail: item.detail, where: item.where })),
      warned: checks.checks.filter((item) => item.status === 'warn').map((item) => ({ id: item.id, label: item.label, detail: item.detail, where: item.where, code: item.code || '' })),
    },
  }
}

export async function exportAll(root, title) {
  const results = []
  // C4b：exportAll 保持旧四格式（manifest 仅显式 format 导出，避免无关行为变化）
  // C5：exportAll 仍只旧四格式（manifest/srt/edit-csv 仅显式 format 导出）
  for (const format of ['markdown', 'json', 'csv', 'vcs']) {
    results.push(await exportProject(root, title, format))
  }
  return results
}
