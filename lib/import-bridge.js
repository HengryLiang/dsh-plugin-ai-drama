/**
 * v0.10.1（task-81 / B0-C）：分镜提示词 MD → 分镜 JSON 导入桥。
 *
 * 设计约束（Lead/PM 终裁）：
 * - 字段口径以 `需求/设计-分镜数据模型-addonly-v1.md` v1.1 为单一事实源：
 *   PM 草案字段名做映射（dialogue[] → dialogue 字符串；prompt → description / naturalLanguagePrompt；
 *   order → shotNumber；camera → cameraMove/shotSize/lens），**不新增 schema 字段**；
 * - **预览（preview）纯只读**，不写盘；应用（apply）走 `store.saveStoryboardWithGroups` 事务 + 回滚，
 *   覆盖已有分镜必须 `overwrite:true`（由工具层复用审批通道）；
 * - 无分组输入时不触碰既有 `storyboard-groups` sidecar；
 * - 未识别内容不得静默丢弃：进入 `naturalLanguagePrompt` 兜底或 `warnings`/coverage 统计；
 * - 资产占位符 `{{Asset_*}}` 原样保留并校验式样；无外部依赖、0 真实模型。
 *
 * 支持的输入形态（只读样本驱动）：
 *  A. 「草帽」分镜提示词 MD：`## 全组情绪总控` + `镜头NN｜时间码｜景别｜内外景｜焦段` 块
 *     （块内正文=画面/自然语言段，`光影：`、`现场声：`、`台词：` 行）；
 *  B. 插件渲染的分镜表 MD：`| 镜号 | 景别 | 运镜 | 画面描述 | 台词 | 音效 | 时长(秒) | 提示词 | 视频提示词 |` 表格行；
 *  C. VCS 视图（本模块导出后回读）：块内 `台词：`/`光影：`/`现场声：` 标签行。
 *
 * 该模块被 index.js/tools.js 复用；不新增工具与路由。
 */
import * as store from './store.js'
import * as assetLib from './assets.js'
import * as scenesLib from './scenes.js'
import { STYLE_DIMENSIONS } from './style-dna.js'

/** 支持的导入格式（add-only，后续可扩展）。 */
export const IMPORT_FORMATS = ['shot-prompt']

const SHOT_SIZE_MAP = [
  [/大特写|ECU/i, '大特写'],
  [/特写|CU\b/i, '特写'],
  [/近景|MCU|中近/i, '近景'],
  [/中景|MS\b/i, '中景'],
  [/全景|WS\b/i, '全景'],
  [/远景|大远景|ELS|LS\b/i, '远景'],
]
const SHOT_NUMBER_RE = /^(?:镜头|镜|shot)\s*([0-9０-９]+)(?:[｜|]|$)/
const ASSET_RE = /\{\{Asset_[A-Za-z]+[0-9]+_[^{}]*\}\}/g
const ASSET_LOOSE_RE = /\{\{Asset_[^{}]*\}\}/g
const QUOTE_RE = /[「“"]([^」”"]{2,})[」”"]/g
const TABLE_HEADER_TOKENS = ['镜号', '景别', '运镜', '画面描述', '台词', '音效', '时长']
const GROUP_SECTION_RE = /^##\s*[【\[]?\s*(全组情绪总控|分组情绪总控)\s*[】\]]?\s*$/
const KNOWN_SECTION_PREFIXES = ['整体参考锁定', '统一连续性', '声音', '关键限制']

let shotSequence = 0
function nextShotNumber(episode) {
  shotSequence += 1
  return `${Math.max(1, Math.round(Number(episode) || 1))}-${shotSequence}`
}
function resetSequence() {
  shotSequence = 0
}
function importError(message) {
  const error = new Error(message)
  error.code = 'invalid-args'
  return error
}
function warn(warnings, code, message, shotNumber) {
  warnings.push({ code, message, ...(shotNumber ? { shotNumber } : {}) })
}
function clip(value, max) {
  return String(value ?? '').slice(0, max)
}

/** 解析「第NNN集」/「EPNN」/「镜」中的集数；失败返回 fallback。 */
export function parseEpisodeFromText(text, fallback = 1) {
  const match = String(text || '').match(/第\s*([0-9０-９]+)\s*集/) || String(text || '').match(/\bEP\s*([0-9]+)\b/i)
  if (match) return Number(match[1].replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)))
  return Math.max(1, Math.round(Number(fallback) || 1))
}

function mapShotSize(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  const direct = ['远景', '全景', '中景', '近景', '特写', '大特写'].find((size) => value.includes(size))
  if (direct) return direct
  for (const [re, mapped] of SHOT_SIZE_MAP) if (re.test(value)) return mapped
  return ''
}
function mapTransition(raw) {
  const value = String(raw || '').trim()
  if (/whip|甩/i.test(value)) return 'whip-pan'
  if (/match|匹配/i.test(value)) return 'match-cut'
  if (/one-take|一镜到底|一镜/i.test(value)) return 'one-take'
  if (/hard|硬切/i.test(value)) return 'hard-cut'
  return ''
}
function parseDuration(text) {
  const value = String(text || '')
  const range = value.match(/([0-9]{1,2}):([0-9]{2})\s*[-~—－至]\s*([0-9]{1,2}):([0-9]{2})/)
  if (range) {
    const start = Number(range[1]) * 60 + Number(range[2])
    const end = Number(range[3]) * 60 + Number(range[4])
    if (end > start) return end - start
  }
  const seconMatch = value.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:s|秒)/i)
  if (seconMatch) return Math.round(Number(seconMatch[1]))
  return null
}
function normalizeShotNumber(raw) {
  const match = String(raw || '').match(/(?:镜头|镜|shot)?\s*([0-9０-９]+)/i)
  const digits = match ? match[1].replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)) : ''
  return digits ? String(Number(digits)) : ''
}
function extractDialogue(text) {
  const lines = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    const labeled = line.match(/^(?:台词|对白)[：:]\s*(.+)$/)
    if (labeled) {
      lines.push(labeled[1].trim())
      continue
    }
    // 「角色（时间/语气）：台词」形式（草帽样本的写法）
    const roleLine = line.match(/^([^：:]{1,20})[（(]([^）)]{0,40})[）)][：:]\s*(.+)$/)
    if (roleLine && !/^(光影|现场声|画面|备注)/.test(line)) {
      lines.push(line)
      continue
    }
    if (/^[「“"]/.test(line) && /[」”"]$/.test(line)) lines.push(line.slice(1, -1))
  }
  if (lines.length) return clip(lines.join('\n'), 1000)
  // 兜底：正文内嵌引号台词（仅收录「说话/喊/问/答/开口/念/道」或冒号引导的引号，避免把主题句误判为台词）
  const quotes = []
  const source = String(text || '')
  let match
  QUOTE_RE.lastIndex = 0
  while ((match = QUOTE_RE.exec(source)) !== null) {
    const before = source.slice(Math.max(0, match.index - 24), match.index)
    if (/[：:]\s*$/.test(before) || /(说|喊|问|答|开口|念|道)[^。\n]{0,12}[：:]?\s*$/.test(before)) {
      quotes.push(match[1].trim())
    }
  }
  return clip(quotes.join('\n'), 1000)
}
function extractAssets(text) {
  const strict = [...String(text || '').matchAll(ASSET_RE)].map((match) => match[0])
  const loose = [...String(text || '').matchAll(ASSET_LOOSE_RE)].map((match) => match[0])
  ASSET_RE.lastIndex = 0
  const validator = /^\{\{Asset_[A-Za-z]+[0-9]+_[^{}]*\}\}$/
  const invalid = loose.filter((asset) => !validator.test(asset))
  return { assets: [...new Set(strict)], invalid: [...new Set(invalid)] }
}
function normalizeBlockFields({ rawBody, shot, warnings, stats, episode }) {
  const body = String(rawBody || '').trim()
  const lines = body.split(/\r?\n/)
  const lightLines = []
  const soundLines = []
  const dialogueLines = []
  const promptLines = []
  const imagePromptLines = []
  const videoPromptLines = []
  const restLines = []
  for (const line of lines) {
    const light = line.match(/^(?:光影|光线)[：:]\s*(.+)$/)
    const sound = line.match(/^(?:现场声|环境声|音效)[：:]\s*(.+)$/)
    const dialogue = line.match(/^(?:台词|对白)[：:]\s*(.+)$/)
    const imagePrompt = line.match(/^(?:生图提示词|图片提示词)[：:]\s*(.+)$/)
    const videoPrompt = line.match(/^视频提示词[：:]\s*(.+)$/)
    const prompt = line.match(/^(?:提示词|自然语言段|自然语言提示词)[：:]\s*(.+)$/)
    if (light) lightLines.push(light[1].trim())
    else if (sound) soundLines.push(sound[1].trim())
    else if (dialogue) dialogueLines.push(dialogue[1].trim())
    else if (imagePrompt) imagePromptLines.push(imagePrompt[1].trim())
    else if (videoPrompt) videoPromptLines.push(videoPrompt[1].trim())
    else if (prompt) promptLines.push(prompt[1].trim())
    else restLines.push(line)
  }
  const description = clip(restLines.join('\n').trim(), 1000)
  // v1 等样本把「光线：」写在正文行内（非独立行）→ 行内标签兜底提取（原文仍保留在 description 中）
  if (!lightLines.length) {
    const inlineLight = body.match(/(?:光线|光影)[：:]\s*([^。\n]{4,240})/)
    if (inlineLight) lightLines.push(inlineLight[1].trim())
  }
  if (!soundLines.length) {
    const inlineSound = body.match(/(?:现场声|环境声)[：:]\s*([^。\n]{2,240})/)
    if (inlineSound) soundLines.push(inlineSound[1].trim())
  }
  const naturalLanguagePrompt = clip(promptLines.length ? promptLines.join('\n') : body, 3000)
  if (imagePromptLines.length) shot.imagePrompt = clip(imagePromptLines.join(' '), 1000)
  if (videoPromptLines.length) shot.videoPrompt = clip(videoPromptLines.join(' '), 1000)
  if (description) stats.fields.description += 1
  if (naturalLanguagePrompt) stats.fields.naturalLanguagePrompt += 1
  shot.description = description
  shot.naturalLanguagePrompt = naturalLanguagePrompt
  if (lightLines.length) {
    shot.light = clip(lightLines.join('；'), 500)
    stats.fields.light += 1
  } else warn(warnings, 'light-missing', '未识别到「光影：」段落', shot.shotNumber)
  if (soundLines.length) {
    shot.ambientSound = clip(soundLines.join('；'), 300)
    stats.fields.ambientSound += 1
  } else warn(warnings, 'ambient-missing', '未识别到「现场声：」段落', shot.shotNumber)
  if (dialogueLines.length) {
    shot.dialogue = clip(dialogueLines.join('\n'), 1000)
    stats.fields.dialogue += 1
  } else {
    const extracted = extractDialogue(restLines.join('\n'))
    if (extracted) {
      shot.dialogue = extracted
      stats.fields.dialogue += 1
      warn(warnings, 'dialogue-inferred', '台词由正文引号推断（建议人工复核）', shot.shotNumber)
    }
  }
  const assets = extractAssets(body)
  if (assets.assets.length) stats.assets += assets.assets.length
  for (const invalid of assets.invalid) warn(warnings, 'asset-invalid', `资产占位符式样可疑（原样保留）：${invalid}`, shot.shotNumber)
  if (shot.shotNumber) stats.fields.shotNumber += 1
  if (shot.shotSize) stats.fields.shotSize += 1
  if (shot.durationSec > 0) stats.fields.durationSec += 1
  if (shot.lens) stats.fields.lens += 1
  if (shot.cameraMove) stats.fields.cameraMove += 1
  if (!shot.shotNumber) shot.shotNumber = nextShotNumber(episode)
  return shot
}

/** 解析「草帽式」镜头块（标题行 `镜头NN｜时间码｜景别｜内外景｜焦段` 或 `镜N`）。 */
function parseBlockStyle(text, { episode, warnings, stats }) {
  const lines = String(text || '').split(/\r?\n/)
  const blocks = []
  let current = null
  const pushCurrent = () => {
    if (current) blocks.push(current)
    current = null
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      if (current) current.body.push('')
      continue
    }
    if (/^#{1,6}\s/.test(line)) {
      if (!current) {
        const shotLike = line.match(/^(?:#{1,6}\s*)(?:镜头|镜)\s*([0-9０-９]+)/)
        if (shotLike) {
          pushCurrent()
          current = { header: line.replace(/^#{1,6}\s*/, ''), body: [] }
          continue
        }
      }
      pushCurrent()
      continue
    }
    const shotMatch = line.match(SHOT_NUMBER_RE)
    if (shotMatch) {
      pushCurrent()
      current = { header: line, body: [] }
      continue
    }
    if (current) current.body.push(raw)
  }
  pushCurrent()
  return blocks.map((block) => {
    const segments = block.header.split(/[｜|]/).map((item) => item.trim()).filter(Boolean)
    const shot = { shotNumber: '', shotSize: '', cameraMove: '', durationSec: 0 }
    for (const segment of segments) {
      if (/^(?:镜头|镜|shot)/i.test(segment)) continue
      if (/^[0-9]{1,2}:[0-9]{2}/.test(segment)) {
        const duration = parseDuration(segment)
        if (duration && !shot.durationSec) shot.durationSec = duration
        continue
      }
      if (/[0-9]+mm/i.test(segment)) {
        shot.lens = clip(segment.match(/([0-9]+mm)/i)[1], 40)
        const size = mapShotSize(segment)
        if (size && !shot.shotSize) shot.shotSize = size
        continue
      }
      if (/内外景|内景|外景|外\/内/.test(segment) && segment.length <= 6) continue
      const size = mapShotSize(segment)
      if (size && !shot.shotSize) {
        shot.shotSize = size
        continue
      }
      if (/运镜|固定|手持|推|拉|摇|移|跟|升降|环绕/.test(segment)) {
        shot.cameraMove = clip(shot.cameraMove ? `${shot.cameraMove}；${segment}` : segment, 60)
        continue
      }
      if (!shot.lens && /广角|长焦|中焦|标镜/.test(segment)) shot.lens = clip(segment, 40)
    }
    const headerShotNumber = block.header.match(/(?:镜头|镜|shot)\s*([0-9０-９]+)/i)
    if (headerShotNumber) shot.shotNumber = `${Math.max(1, Math.round(Number(episode) || 1))}-${normalizeShotNumber(headerShotNumber[1])}`
    return normalizeBlockFields({ rawBody: block.body.join('\n'), shot, warnings, stats, episode })
  })
}

/** 解析插件渲染的分镜表（Markdown 表格行）。 */
function parseTableStyle(text, { episode, warnings, stats }) {
  const lines = String(text || '').split(/\r?\n/)
  const headerIndex = lines.findIndex((line) => TABLE_HEADER_TOKENS.every((token) => line.includes(token)))
  if (headerIndex === -1) return []
  const headers = lines[headerIndex].split('|').map((cell) => cell.trim()).filter(Boolean)
  const indexOf = (name) => headers.findIndex((header) => header.includes(name))
  const idx = {
    shotNumber: indexOf('镜号'),
    shotSize: indexOf('景别'),
    cameraMove: indexOf('运镜'),
    description: indexOf('画面描述'),
    dialogue: indexOf('台词'),
    sfx: indexOf('音效'),
    durationSec: indexOf('时长'),
    imagePrompt: indexOf('提示词'),
    videoPrompt: indexOf('视频提示词'),
  }
  const shots = []
  for (const line of lines.slice(headerIndex + 1)) {
    if (!/^\|/.test(line.trim())) continue
    if (/^\|[\s:|-]+\|$/.test(line.trim())) continue
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (!cells.length) continue
    const pick = (key) => (idx[key] >= 0 ? cells[idx[key]] ?? '' : '')
    const shotNumberRaw = normalizeShotNumber(pick('shotNumber')) || String(shots.length + 1)
    const shot = {
      shotNumber: `${Math.max(1, Math.round(Number(episode) || 1))}-${shotNumberRaw}`,
      shotSize: mapShotSize(pick('shotSize')) || '中景',
      cameraMove: clip(pick('cameraMove'), 60),
      description: clip(pick('description'), 1000),
      dialogue: clip(pick('dialogue'), 1000),
      durationSec: Math.max(0, Math.round(Number(pick('durationSec')) || 0)),
    }
    const naturalLanguagePrompt = pick('videoPrompt') || pick('imagePrompt')
    if (naturalLanguagePrompt) shot.naturalLanguagePrompt = clip(naturalLanguagePrompt, 3000)
    // 资产占位符原样保留：生图/视频提示词列写入已知字段（不丢占位符）
    if (pick('imagePrompt')) shot.imagePrompt = clip(pick('imagePrompt'), 1000)
    if (pick('videoPrompt')) shot.videoPrompt = clip(pick('videoPrompt'), 1000)
    const sfx = clip(pick('sfx'), 200)
    if (sfx) {
      shot.sfx = sfx
      shot.ambientSound = clip(sfx, 300)
      stats.fields.ambientSound += 1
    }
    const assets = extractAssets([pick('description'), pick('imagePrompt'), pick('videoPrompt')].join('\n'))
    stats.assets += assets.assets.length
    for (const invalid of assets.invalid) warn(warnings, 'asset-invalid', `资产占位符式样可疑（原样保留）：${invalid}`, shot.shotNumber)
    if (shot.shotNumber) stats.fields.shotNumber += 1
    if (shot.shotSize) stats.fields.shotSize += 1
    if (shot.durationSec > 0) stats.fields.durationSec += 1
    if (shot.description) stats.fields.description += 1
    if (shot.dialogue) stats.fields.dialogue += 1
    if (shot.cameraMove) stats.fields.cameraMove += 1
    if (shot.naturalLanguagePrompt) stats.fields.naturalLanguagePrompt += 1
    if (!shot.dialogue) warn(warnings, 'dialogue-empty', '本镜台词为空（保留空字符串）', shot.shotNumber)
    shots.push(shot)
  }
  return shots
}

/** 解析「全组情绪总控」/【整体参考锁定】/【统一连续性】等全局段（映射到 groups 与 notes；全局段不静默丢）。 */
function parseGlobalSections(text, { episode, shots, warnings }) {
  const lines = String(text || '').split(/\r?\n/)
  const sections = []
  let current = null
  for (const raw of lines) {
    const line = raw.trim()
    const heading = line.match(/^##\s+(.+)$/)
    if (heading) {
      current = { title: heading[1].replace(/[【】\[\]]/g, '').trim(), lines: [] }
      sections.push(current)
      continue
    }
    if (current) current.lines.push(raw)
  }
  const cleanContent = (section) =>
    section.lines
      .map((line) => line.trim())
      .filter((line) => line && !/^-{3,}$/.test(line) && !/^\*{3,}$/.test(line))
      .join('\n')
      .trim()
  const emotionSection = sections.find((section) => /全组情绪总控|分组情绪总控/.test(section.title))
  const knownSections = sections
    .map((section) => ({ title: section.title, content: cleanContent(section) }))
    .filter((section) => KNOWN_SECTION_PREFIXES.includes(section.title) && section.content)
  const groups = []
  // 全局段原文统一另存到首个镜头未知字段（host 保留未知字段；无渲染/导出语义，仅防静默丢弃）
  if (knownSections.length && shots.length) {
    shots[0].importedGlobalSections = knownSections.map((section) => ({ title: section.title, content: clip(section.content, 2000) }))
    warn(warnings, 'global-sections-preserved', `已保留 ${knownSections.length} 个全局段到 importedGlobalSections（未知字段，无渲染语义）`)
  }
  if (emotionSection) {
    const full = cleanContent(emotionSection)
    const group = { id: 'g1', name: '全组情绪总控', shotNumbers: shots.map((shot) => shot.shotNumber) }
    const merged = knownSections.length
      ? clip(`${full}\n${knownSections.map((section) => `【${section.title}】${section.content}`).join('\n')}`, 500)
      : clip(full, 500)
    if (merged) group.notes = merged
    groups.push(group)
    if (full.length > 500) warn(warnings, 'group-notes-truncated', `全组情绪总控 ${full.length} 字，notes 截断至 500 字（完整全局段已存 importedGlobalSections）`)
  }
  return groups
}

/**
 * v0.11.4（task-103 / 2-5）：互通标记段（add-only）。
 * - 仅识别显式段：`## 场景关联` / `## 场景卡` 与 `## 风格注记` / `## 风格DNA` / `## 风格 DNA`；
 * - 普通 MD 无这些段 → 不产生任何 hints/warnings（v0.11.3 行为字节一致）；
 * - 未知/畸形行进入 invalidLines（不静默丢弃，原样进 interopSections 审计）。
 */
const INTEROP_SCENE_SECTION_RE = /^##\s*[【\[]?\s*(场景关联|场景卡)\s*[】\]]?\s*$/
const INTEROP_STYLE_SECTION_RE = /^##\s*[【\[]?\s*(风格注记|风格DNA|风格 DNA)\s*[】\]]?\s*$/
const STYLE_LABEL_TO_DIMENSION = {
  色板: 'palette',
  光感: 'lighting',
  质感: 'texture',
  构图: 'composition',
  构图偏好: 'composition',
  运镜: 'motion',
  运镜节奏: 'motion',
}

/** 解析互通标记段（纯函数；无标记时返回空结构）。 */
export function parseInteropSections(text) {
  const lines = String(text || '').split(/\r?\n/)
  const sections = []
  let current = null
  for (const raw of lines) {
    const line = raw.trim()
    const heading = line.match(/^##\s+(.+)$/)
    if (heading) {
      current = { title: heading[1].replace(/[【】\[\]]/g, '').trim(), lines: [] }
      if (INTEROP_SCENE_SECTION_RE.test(line) || INTEROP_STYLE_SECTION_RE.test(line)) sections.push(current)
      else current = null
      continue
    }
    if (current) current.lines.push(raw)
  }
  const sceneMentions = []
  const styleHints = []
  const invalidLines = []
  const unknownStyleLabels = []
  const rawSections = []
  for (const section of sections) {
    const isScene = INTEROP_SCENE_SECTION_RE.test(`## ${section.title}`)
    const isStyle = INTEROP_STYLE_SECTION_RE.test(`## ${section.title}`)
    const content = section.lines.map((line) => line.trim()).filter((line) => line && !/^-{3,}$/.test(line))
    rawSections.push({ title: section.title, content: clip(content.join('\n'), 2000) })
    for (const line of content) {
      const cleaned = line.replace(/^[-*]\s*/, '').trim()
      if (!cleaned) continue
      if (isScene) {
        const match = cleaned.match(/^(?:场景[：:]\s*)?(SPC[0-9]{3})\s*(.*)$/i)
        if (match && scenesLib.isValidSceneId(match[1])) {
          sceneMentions.push({ sceneId: match[1].toUpperCase(), name: match[2].trim() })
        } else {
          invalidLines.push({ section: section.title, line: cleaned })
        }
      } else if (isStyle) {
        const match = cleaned.match(/^([^：:]{1,10})[：:]\s*(.+)$/)
        if (!match) {
          invalidLines.push({ section: section.title, line: cleaned })
          continue
        }
        const label = match[1].trim()
        const dimension = STYLE_LABEL_TO_DIMENSION[label] || STYLE_LABEL_TO_DIMENSION[label.replace(/偏好|节奏/g, '')] || ''
        if (dimension) styleHints.push({ dimension, label, text: clip(match[2], 300) })
        else unknownStyleLabels.push({ label, text: clip(match[2], 300) })
      }
    }
  }
  const uniqueScenes = []
  for (const item of sceneMentions) if (!uniqueScenes.some((scene) => scene.sceneId === item.sceneId)) uniqueScenes.push(item)
  const styleByDimension = {}
  for (const item of styleHints) if (!styleByDimension[item.dimension]) styleByDimension[item.dimension] = item
  return {
    sceneMentions: uniqueScenes,
    styleHints: STYLE_DIMENSIONS.map((dimension) => styleByDimension[dimension]).filter(Boolean),
    unknownStyleLabels,
    invalidLines,
    sections: rawSections,
  }
}

/** v0.11.4：与项目既有资产卡/场景卡/style DNA 做只读匹配（不创建文件、不自动写 sceneRef/style）。 */
async function buildInteropHints(root, title, interop, shots, warnings) {
  const [assetCards, sceneCards, styleDNA] = await Promise.all([
    store.getAssetCards(root, title).catch(() => []),
    store.getScenes(root, title).catch(() => []),
    store.getStyleDNA(root, title).catch(() => null),
  ])
  const assetCardIds = new Set((assetCards || []).map((card) => card.id))
  const sceneCardById = new Map((sceneCards || []).map((scene) => [scene.id, scene]))
  const referenced = []
  for (const shot of shots) {
    for (const field of ['description', 'naturalLanguagePrompt', 'imagePrompt', 'videoPrompt']) {
      for (const id of assetLib.extractAssetIds(shot[field])) if (!referenced.includes(id)) referenced.push(id)
    }
  }
  const matchedAssets = referenced.filter((id) => assetCardIds.has(id))
  const missingAssets = referenced.filter((id) => !assetCardIds.has(id))
  // B 口径：仅当项目已启用资产体系（≥1 张卡）时提示缺失；占位符始终原样保留
  if (assetCardIds.size > 0 && missingAssets.length) {
    warn(warnings, 'asset-reference-missing', `引用了不存在的资产卡：${missingAssets.slice(0, 8).join('、')}（占位符原样保留；不自动建卡）`)
  }
  const matchedScenes = []
  const missingScenes = []
  for (const mention of interop.sceneMentions) {
    const card = sceneCardById.get(mention.sceneId)
    if (card) matchedScenes.push({ sceneId: mention.sceneId, name: card.name || mention.name })
    else {
      missingScenes.push(mention.sceneId)
      warn(warnings, 'scene-hint-missing', `场景关联标记未匹配到场景卡：${mention.sceneId}（不自动建卡）`)
    }
  }
  const matchedStyleDims = []
  const missingStyleDims = []
  for (const hint of interop.styleHints) {
    const existing = styleDNA && typeof styleDNA === 'object' ? String(styleDNA[hint.dimension] || '').trim() : ''
    if (existing) matchedStyleDims.push(hint.dimension)
    else {
      missingStyleDims.push(hint.dimension)
      warn(warnings, 'style-hint-missing', `风格注记未匹配到项目 style DNA 维度：${hint.dimension}（不自动写 style.json）`)
    }
  }
  if (interop.unknownStyleLabels.length) {
    warn(warnings, 'style-hint-unknown', `未知风格维度已忽略：${interop.unknownStyleLabels.map((item) => item.label).join('、')}`)
  }
  if (interop.invalidLines.length) {
    warn(warnings, 'interop-section-invalid', `互通标记段存在非法行（已保留原文到 interopSections）：${interop.invalidLines.slice(0, 5).map((item) => item.line).join('；')}`)
  }
  return {
    assetRefs: { referenced, matched: matchedAssets, missing: missingAssets },
    sceneHints: { matched: matchedScenes, missing: missingScenes },
    styleHints: { matched: matchedStyleDims, missing: missingStyleDims },
    interopSections: interop.sections,
  }
}

/**
 * 解析分镜提示词 MD（预览用；纯函数，不写盘）。
 * @returns {{episode:number, shots:object[], groups:object[], stats:object, warnings:object[], coverage:object, format:string}}
 */
export function parseShotPromptMarkdown(text, options = {}) {
  if (typeof text !== 'string' || !text.trim()) throw importError('分镜提示词 MD 内容为空')
  const warnings = []
  const episode = parseEpisodeFromText(text, options.episode ?? 1)
  const stats = {
    fields: { shotNumber: 0, shotSize: 0, cameraMove: 0, durationSec: 0, description: 0, dialogue: 0, light: 0, ambientSound: 0, naturalLanguagePrompt: 0, lens: 0 },
    assets: 0,
  }
  resetSequence()
  const isTable = TABLE_HEADER_TOKENS.every((token) => text.includes(token)) && /\|[^|\n]*镜号[^|\n]*\|/.test(text)
  const shots = isTable ? parseTableStyle(text, { episode, warnings, stats }) : parseBlockStyle(text, { episode, warnings, stats })
  if (!shots.length) throw importError('未从 MD 中解析到任何镜头（请检查格式：镜头块或分镜表格）')
  const groups = isTable ? [] : parseGlobalSections(text, { episode, shots, warnings })
  const total = shots.length
  const coverage = {}
  for (const [field, count] of Object.entries(stats.fields)) coverage[field] = total ? Math.round((count / total) * 1000) / 10 : 0
  coverage.assets = stats.assets
  return {
    episode,
    shots,
    groups,
    stats,
    warnings,
    coverage,
    format: isTable ? 'table' : 'shot-prompt-blocks',
  }
}

/**
 * 预览导入（只读，不写盘）：返回解析结果 + 与现状 diff/冲突 + 是否需覆盖确认。
 * @param {string} root 工作区根
 * @param {string} title 短剧名
 * @param {{text:string, episode?:number, overwrite?:boolean}} input
 */
export async function previewImport(root, title, input = {}) {
  const parsed = parseShotPromptMarkdown(input.text, { episode: input.episode })
  // v0.11.4（task-103 / 2-5）：互通标记段只读匹配（不创建文件、不自动写 sceneRef/style）
  const interopHints = await buildInteropHints(root, title, parseInteropSections(input.text), parsed.shots, parsed.warnings)
  const currentShots = await store.getStoryboard(root, title, parsed.episode)
  const currentGroups = await store.getStoryboardGroups(root, title, parsed.episode)
  const conflicts = []
  const currentNumbers = new Set(currentShots.map((shot) => String(shot.shotNumber || '').trim()).filter(Boolean))
  const incomingNumbers = new Set(parsed.shots.map((shot) => shot.shotNumber))
  let added = 0
  let updated = 0
  let unchanged = 0
  for (const shot of parsed.shots) {
    const existing = currentShots.find((item) => String(item.shotNumber || '').trim() === shot.shotNumber)
    if (!existing) added += 1
    else if (JSON.stringify(storeShape(existing)) === JSON.stringify(storeShape(shot))) unchanged += 1
    else updated += 1
  }
  const removed = [...currentNumbers].filter((number) => !incomingNumbers.has(number))
  if (removed.length) conflicts.push({ code: 'shots-removed', message: `导入后将有 ${removed.length} 个现有镜头不在新分镜中：${removed.slice(0, 8).join('、')}` })
  const requiresOverwrite = currentShots.length > 0
  if (requiresOverwrite && input.overwrite !== true) conflicts.push({ code: 'overwrite-required', message: `第 ${parsed.episode} 集已有 ${currentShots.length} 个镜头；应用导入需确认覆盖（overwrite=true）` })
  return {
    ...parsed,
    ...interopHints,
    current: { shots: currentShots.length, groups: Array.isArray(currentGroups) ? currentGroups.length : 0 },
    diff: { added, updated, unchanged, removed: removed.length, currentShots: currentShots.length, currentGroups: Array.isArray(currentGroups) ? currentGroups.length : 0 },
    conflicts,
    canApply: conflicts.length === 0,
    requiresOverwrite,
  }
}

function storeShape(shot) {
  // diff 仅比较产品语义字段（忽略 unknown/顺序），避免误报
  const keys = ['shotNumber', 'shotSize', 'cameraMove', 'description', 'dialogue', 'sfx', 'durationSec', 'imagePrompt', 'videoPrompt']
  const out = {}
  for (const key of keys) out[key] = String(shot[key] ?? '')
  for (const key of store.SHOT_OPTIONAL_FIELDS || []) if (shot[key] !== undefined) out[key] = shot[key]
  return out
}

/**
 * 应用导入（写盘；事务+回滚）。
 * - 覆盖已有分镜必须 overwrite:true（工具层负责先走审批）；
 * - 无分组输入时**不触碰**既有 storyboard-groups sidecar；
 * - 复用 store 双文件事务（storyboard+groups+分镜 MD 一起写，失败回滚）。
 */
export async function applyImport(root, title, input = {}) {
  const preview = await previewImport(root, title, input)
  if (preview.requiresOverwrite && input.overwrite !== true) {
    const error = new Error(`第 ${preview.episode} 集已有 ${preview.current.shots} 个镜头，导入将覆盖；需 overwrite=true 并在工具层获用户批准`)
    error.code = 'conflict'
    throw error
  }
  const { shots, groups, episode } = preview
  const interop = {
    assetRefs: preview.assetRefs,
    sceneHints: preview.sceneHints,
    styleHints: preview.styleHints,
    interopSections: preview.interopSections,
  }
  if (groups.length) {
    const saved = await store.saveStoryboardWithGroups(root, title, episode, shots, groups)
    return { episode, shots: saved.shots.length, groups: saved.groups.length, groupsSaved: saved.groups.length > 0, warnings: preview.warnings, coverage: preview.coverage, diff: preview.diff, ...interop }
  }
  // 无分组输入：只写分镜（事务+回滚），保持既有 sidecar 不变
  const saved = await store.saveStoryboardTransactional(root, title, episode, shots)
  return { episode, shots: saved.length, groups: preview.current.groups, groupsSaved: false, warnings: preview.warnings, coverage: preview.coverage, diff: preview.diff, ...interop }
}

