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
import { atomicWrite } from './store.js'
import { extractAssetIds } from './assets.js'
import { STYLE_DIMENSIONS, STYLE_DIMENSION_LABELS } from './style-dna.js'
import { runDeterministicChecks } from './checks.js'

export const EXPORT_FORMATS = ['markdown', 'json', 'csv', 'vcs']

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
    .map((id) => ({ id, name: assetById.get(id).name || '', type: assetById.get(id).type || '', refs: assetRefs.get(id).slice() }))
  const scenes = [...sceneRefs.keys()]
    .filter((id) => sceneById.has(id))
    .sort()
    .map((id) => {
      const scene = sceneById.get(id)
      return { id, name: scene.name || '', space: scene.space || {}, refs: sceneRefs.get(id).slice() }
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
      storyboard: await store.getStoryboard(root, title, episode.order),
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
export async function checkExportTarget(outDir) {
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
  const exportDir = path.join(projectPath, '导出')
  await checkExportTarget(exportDir)
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
  await atomicWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  return { file: manifestFile, relative: path.relative(projectPath, manifestFile), manifest }
}

const FORMAT_SUFFIX = { markdown: '-全本.md', json: '.json', csv: '-分镜表.csv', vcs: '-VCS视图.md' }

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
  const targets = (manifest.files || []).filter((item) => suffix ? String(item.path).endsWith(suffix) : true)
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

export async function exportProject(root, title, format = 'markdown') {
  if (!EXPORT_FORMATS.includes(format)) throw new Error(`不支持的导出格式：${format}`)
  const dir = store.projectDir(root, title)
  if (!(await store.isDirectory(dir))) throw new Error(`短剧《${title}》不存在`)
  const outDir = path.join(dir, '导出')
  // 写盘目标检查（P1-D/T10）：目录/可写性/空间，避免写一半或写错位置
  await checkExportTarget(outDir)
  const stem = safeFileStem(title)

  let file
  let bytes
  if (format === 'markdown') {
    const content = await buildMarkdown(root, title)
    file = path.join(outDir, `${stem}-全本.md`)
    await atomicWrite(file, content)
    bytes = Buffer.byteLength(content, 'utf8')
  } else if (format === 'json') {
    const content = JSON.stringify(await buildJson(root, title), null, 2) + '\n'
    file = path.join(outDir, `${stem}.json`)
    await atomicWrite(file, content)
    bytes = Buffer.byteLength(content, 'utf8')
  } else if (format === 'csv') {
    const content = await buildStoryboardCsv(root, title)
    file = path.join(outDir, `${stem}-分镜表.csv`)
    await atomicWrite(file, '\ufeff' + content) // BOM：便于 Excel 正确识别中文
    bytes = Buffer.byteLength(content, 'utf8')
  } else {
    // v0.10.1（task-81）：VCS/草帽兼容视图（add-only；确定性输出）
    const content = await buildVcsView(root, title)
    file = path.join(outDir, `${stem}-VCS视图.md`)
    await atomicWrite(file, content)
    bytes = Buffer.byteLength(content, 'utf8')
  }

  // 写后校验链：sha256 清单 → 复算 → 确定性检查摘要（不阻断；strict 由工具层决定）
  const manifest = await buildExportManifest(root, title)
  const verify = await verifyExport(root, title, format)
  const checks = await runDeterministicChecks(root, { title })
  return {
    format,
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
  for (const format of EXPORT_FORMATS) {
    results.push(await exportProject(root, title, format))
  }
  return results
}
