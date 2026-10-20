/**
 * 检索增强（FR-C08 → P2-4 / v0.6.4 重构，task-39）。
 *
 * 本地词法检索优先，外部嵌入可选（Q2：P1 只做词法；v0.7.0 再评估嵌入/重排）。
 *
 * v0.6.4 采集层重构（Lead 裁定 Q1–Q5）：
 *   ① 分层配额：contract/outline/characters 全文；world/memory/构想 等自由文本必扫；
 *      episodes/shots 改为结构化索引条目（locator + ≤200 字摘要 + 关键词倒排，不缓存全文）。
 *   ② 索引持久化：`.aidrama/index/retrieval-index.json`（schemaVersion + 内容签名，懒构建、stale 自动重建、
 *      不随导出）；旧项目无索引 → 首次检索懒构建，不报错。
 *   ③ 可观测：结果含 scanned / truncated / scanMeta（按类型计数、配额、是否重建）；
 *      配额耗尽 → degraded:true + degradeReason='scan-quota-exhausted'（不静默丢文档）。
 *   ④ 内存：索引仅保存「条目元数据 + 倒排 postings」，不保存分集/分镜全文；分集全文仅候选精排时按需读取。
 *
 * 兼容：searchContext 既有字段（hits/scanned/degraded/degradeReason/method/enabled/topK）不变，
 * 只新增 truncated / scanMeta；外部排序器注入路径（setRetrievalRanker）保持旧文档形态。
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import * as store from './store.js'

export const RETRIEVAL_INDEX_VERSION = 1
export const RETRIEVAL_INDEX_RELATIVE = '.aidrama/index/retrieval-index.json'

const INDEX_DIR = '.aidrama/index'
const INDEX_FILE = 'retrieval-index.json'
const MAX_CHARS_PER_DOC = 20000
const SUMMARY_CHARS = 200
const MAX_DOCS_LEGACY = 400 // 仅外部排序器兼容路径使用

/** v0.6.4 采集配额（可观测；超限 → truncated + degraded 标记）。 */
export const RETRIEVAL_QUOTA = {
  outline: 1500,
  characters: 400,
  freeText: 200,
  episodes: 500,
  shots: 6000,
}

/** 分集全文精排/读取预算（与采集配额分离，仅性能保护）。 */
const RESCORE_CANDIDATES = 25
const FULLTEXT_READ_BUDGET = 25

/** 排序权重（v0.6.4 调优：title 精确/包含、台词意图对分集加成）。 */
const WEIGHTS = {
  contract: 1.2,
  outline: 1.2,
  characters: 1.4,
  episode: 1.1,
  shot: 0.8,
  world: 2.4,
  memory: 2.4,
  idea: 1.4,
  dialogueVoice: 1.4,
}
const TITLE_EXACT_BONUS = 40
const TITLE_IN_QUERY_BONUS = 26
const DIALOGUE_INTENT_EPISODE_BONUS = 30
const DIALOGUE_INTENT_SHOT_BONUS = 6
const PHRASE_BONUS_UNIT = 4

/**
 * 测试钩子（AC-S4）：DSH_AI_DRAMA_RETRIEVAL_QUOTA（JSON）覆盖采集配额，
 * 例如 {"episodes":5,"shots":10,"freeText":1}；仅测试用，生产不设置即默认配额。
 */
export function effectiveRetrievalQuota() {
  const base = { ...RETRIEVAL_QUOTA }
  const raw = process.env.DSH_AI_DRAMA_RETRIEVAL_QUOTA
  if (!raw) return base
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of ['outline', 'characters', 'freeText', 'episodes', 'shots']) {
        const value = Number(parsed[key])
        if (Number.isFinite(value) && value >= 0) base[key] = Math.floor(value)
      }
    }
  } catch {
    /* 非法 JSON → 忽略 */
  }
  return base
}

/** 中文按字、英文数字按词切分；去停用词。 */
const STOPWORDS = new Set(['的', '了', '是', '在', '和', '与', '就', '都', '而', '及', '着', '或', '一个', '我们', '你们', '他们', 'the', 'a', 'an', 'of', 'to', 'and', 'is', 'are', 'in', 'on', 'for'])

export function tokenize(text) {
  const lower = String(text || '').toLowerCase()
  const tokens = []
  for (const chunk of lower.match(/[\u4e00-\u9fa5]+|[a-z0-9]+/g) || []) {
    if (/^[\u4e00-\u9fa5]+$/.test(chunk)) {
      if (chunk.length === 1) {
        if (!STOPWORDS.has(chunk)) tokens.push(chunk)
        continue
      }
      for (let i = 0; i < chunk.length; i += 1) {
        const ch = chunk[i]
        if (!STOPWORDS.has(ch)) tokens.push(ch)
        if (i + 1 < chunk.length) tokens.push(chunk.slice(i, i + 2))
      }
    } else if (!STOPWORDS.has(chunk)) {
      tokens.push(chunk)
    }
  }
  return tokens
}

function uniqueTokens(text) {
  return [...new Set(tokenize(text))]
}

function summarize(text, limit = SUMMARY_CHARS) {
  const flat = String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, Math.max(0, limit - 12))}…（截断）`
}

const FREETEXT_DIRS = [
  { dir: '世界观', type: 'world', label: '世界观' },
  { dir: '本剧记忆', type: 'memory', label: '本剧记忆' },
  { dir: '构想', type: 'idea', label: '构想' },
  { dir: '台词与音效', type: 'dialogueVoice', label: '台词与音效' },
]
const FREETEXT_TYPES = new Set(['world', 'memory', 'idea', 'dialogueVoice'])

/* ------------------------------------- v0.7.0 A 方案（纯词法增强）常量与小工具 */

/** 索引内部格式版本（对外 schemaVersion 仍为 1；format 变化触发重建，避免旧索引结构不兼容）。 */
const INDEX_FORMAT = 3
/** 字段加权：title/key/人物名/规则名命中 > 正文命中。 */
const TITLE_TOKEN_BONUS = 1.6
/** 同义词/近义扩展（A 方案 ①）：query 字符串命中 key → 追加同义 token（权重 0.85）。 */
const SYNONYM_GROUPS = [
  { key: /协议|约定|条款|合同/, expand: ['契约', '婚书', '约定', '合同', '条款'] },
  { key: /三年前|三年之约|旧事|往事/, expand: ['十年前', '旧账', '旧事', '往事'] },
  { key: /退婚|退亲|悔婚/, expand: ['退婚', '悔婚', '退亲'] },
  { key: /继承权|家产|遗产|继承/, expand: ['继承', '家产', '遗产'] },
  { key: /伏笔|待回收|埋设|回收/, expand: ['伏笔', '待回收', '埋设', '回收'] },
  { key: /关系|感情|恩怨/, expand: ['关系', '感情', '恩怨'] },
]
const SYNONYM_WEIGHT = 0.85

/** 查询意图识别（A 方案 ⑤：关键词规则，不调用模型）。 */
export function detectRetrievalIntent(question) {
  const text = String(question || '')
  if (/伏笔|待回收|回收|埋设/.test(text)) return 'memory'
  if (/台词|对白|原句|口吻|说：“|说:"/.test(text) || /[“”「」]/.test(text)) return 'dialogue'
  if (/关系|人物|角色|性格|人设/.test(text)) return 'character'
  if (/世界观|规则|旧规|禁令|戒律|地点|场景设定/.test(text)) return 'world'
  if (/桥段|反转|钩子|剧情|第\d+集|集数/.test(text)) return 'plot'
  if (/协议|约定|条款|合同|三年前|旧事|往事/.test(text)) return 'agreement'
  return 'general'
}

/** 查询 token 扩展：原 token 权重 1.0，同义 token 追加权重 0.85。 */
export function expandQueryTokens(question) {
  const text = String(question || '')
  const weights = new Map()
  for (const token of tokenize(text)) if (!weights.has(token)) weights.set(token, 1)
  const expanded = []
  for (const group of SYNONYM_GROUPS) {
    if (!group.key.test(text)) continue
    for (const term of group.expand) {
      for (const token of tokenize(term)) {
        if (!weights.has(token)) {
          weights.set(token, SYNONYM_WEIGHT)
          if (!expanded.includes(term)) expanded.push(term)
        }
      }
    }
  }
  return { tokens: weights, expanded }
}

/** 模板化文本识别（用于 S1：只按少量高频字命中的模板条目降权，命中覆盖高时不动）。 */
const TEMPLATE_PATTERNS = [
  /必须遵守这条旧规/,
  /违背者将被逐出/,
  /永不得再踏入/,
  /原以为.{0,8}是执刀的人/,
  /被逼到绝境/,
  /压得人喘不过气/,
  /门被推开，站在光里/,
  /镜头一转，刀柄却握在/,
  /细碎又潮湿的雨/,
]
function isTemplateLike(text) {
  const flat = String(text || '')
  return TEMPLATE_PATTERNS.some((pattern) => pattern.test(flat))
}

/**
 * 把聚合 markdown 文件按条目拆分（A 方案 ③：world/memory 每条一 entry）。
 * 支持 `### 标题` 小节（world）与 `- [ ] 条目` 列表（memory）；无结构时退化为单条目。
 */
export function splitMarkdownEntries(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n')
  const entries = []
  let current = null
  const push = () => {
    if (current && String(current.text || '').trim().length >= 2) entries.push(current)
    current = null
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const heading = line.match(/^(#{2,4})\s+(.+)$/)
    const bullet = line.match(/^[-*]\s+(?:\[[ xX]\]\s*)?(.+)$/)
    if (heading) {
      push()
      current = { title: heading[2].trim(), text: '' }
      continue
    }
    if (bullet) {
      push()
      current = { title: bullet[1].trim(), text: bullet[1].trim() }
      continue
    }
    if (!current) current = { title: '', text: '' }
    current.text += (current.text ? '\n' : '') + line
  }
  push()
  return entries
}

/** 从条目标题提取 key（如「伏笔·断玉佩：已回收…」→「断玉佩」）。 */
function entryKeyOf(title) {
  const flat = String(title || '').trim()
  if (!flat) return ''
  const marked = flat.match(/^[^·:：]{1,6}[·:：]\s*([^：:，,；;（(]{1,40})/)
  if (marked) return marked[1].trim()
  const head = flat.split(/[：:，,；;]/)[0].trim()
  return (head || flat).slice(0, 40)
}

/** 命中定位：明确集/场/镜 + 片段；world/memory 为条目级 locator+key。 */
function locationOf(entry) {
  if (!entry) return null
  const type = entry.type
  if (type === 'episode') return { kind: 'episode', episode: entry.episode == null ? null : Number(entry.episode), path: entry.path }
  if (type === 'shot') return { kind: 'shot', episode: Number(entry.episode), shotNumber: entry.shotNumber || null, path: entry.path }
  if (type === 'outline') return { kind: 'outline', episode: Number(entry.episode), path: entry.path }
  if (type === 'character') return { kind: 'character', name: entry.title || entry.path, path: entry.path }
  if (type === 'contract') return { kind: 'contract', path: entry.path }
  if (type === 'world' || type === 'memory' || type === 'idea' || type === 'dialogueVoice') {
    return { kind: 'entry', entryType: type, file: entry.path, key: entry.title || null, path: entry.path }
  }
  return { kind: 'document', path: entry.path }
}

function locatorText(entry) {
  const location = locationOf(entry)
  if (!location) return ''
  switch (location.kind) {
    case 'episode':
      return `第${location.episode}集（分集剧本）`
    case 'shot':
      return `第${location.episode}集 镜${location.shotNumber || '?'}（分镜）`
    case 'outline':
      return `总纲 第${location.episode}集`
    case 'character':
      return `人物「${location.name}」`
    case 'contract':
      return '剧集契约'
    case 'entry':
      return `${entry.path}${location.key ? `#${location.key}` : ''}`
    default:
      return entry.path || ''
  }
}

function isDialogueIntent(question) {
  return /[“”「」]/.test(question) || /台词/.test(question)
}

function hitsTitle(question, title) {
  const q = String(question || '').trim()
  const t = String(title || '').trim()
  if (!q || !t) return false
  return q === t
}
function containsTitle(question, title) {
  const t = String(title || '').trim()
  return t.length >= 2 && String(question || '').includes(t)
}

/* ---------------------------------------------------------------- 索引构建 */

async function statSig(file) {
  try {
    const stat = await fs.stat(file)
    return `${stat.size}:${Math.round(stat.mtimeMs)}`
  } catch {
    return 'missing'
  }
}

async function dirSig(base, kind) {
  let entries = []
  try {
    entries = await fs.readdir(base, { withFileTypes: true })
  } catch {
    return ''
  }
  const parts = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (kind === 'episode' && !/\.md$/i.test(entry.name)) continue
    if (kind === 'storyboard' && !/\.md$/i.test(entry.name)) continue
    if (kind === 'freeText' && !/\.(md|txt)$/i.test(entry.name)) continue
    parts.push(`${entry.name}:${await statSig(path.join(base, entry.name))}`)
  }
  return parts.sort().join('|')
}

/** 内容签名：判断索引是否 stale（只 stat，不读全文）。 */
async function collectSignature(root, title) {
  const dir = store.projectDir(root, title)
  const meta = {}
  for (const rel of ['剧集契约.md', '.aidrama/contract.json', '.aidrama/outline.json', '.aidrama/characters.json', '.aidrama/world.json', '.aidrama/memory.json']) {
    meta[rel] = await statSig(path.join(dir, rel))
  }
  meta.episodes = await dirSig(path.join(dir, '分集剧本'), 'episode')
  meta.storyboards = await dirSig(path.join(dir, '分镜'), 'storyboard')
  for (const item of FREETEXT_DIRS) meta[item.dir] = await dirSig(path.join(dir, item.dir), 'freeText')
  return crypto.createHash('sha256').update(JSON.stringify(meta)).digest('hex')
}

function createIndexBuilder() {
  const entries = []
  const postings = {}
  return {
    entries,
    postings,
    add(meta, text, options = {}) {
      const docIndex = entries.length
      const flat = String(text || '')
      const entry = {
        ...meta,
        summary: meta.summary || summarize(flat),
        templateLike: options.templateLike != null ? Boolean(options.templateLike) : isTemplateLike(flat),
      }
      if (meta.title) entry.titleTokens = uniqueTokens(meta.title)
      entries.push(entry)
      if (!flat) return docIndex
      let tokenList = [...new Set(tokenize(flat))]
      // P3-G（v0.8.0）：大体量文档只入二元词 token（单字 token 对召回贡献低、倒排引用量大），控内存。
      if (options.bigramOnly) tokenList = tokenList.filter((token) => token.length >= 2)
      const limited = Number.isFinite(Number(options.tokenLimit)) && Number(options.tokenLimit) > 0 ? tokenList.slice(0, Number(options.tokenLimit)) : tokenList
      for (const token of limited) {
        let list = postings[token]
        if (!list) {
          list = []
          postings[token] = list
        }
        list.push(docIndex)
      }
      return docIndex
    },
    finalize() {
      // P3-G：倒排落成紧凑字符串（token\u0001idx,idx,… 按行），运行时不常驻 20 万数字引用。
      const lines = []
      for (const [token, list] of Object.entries(postings)) lines.push(`${token}\u0001${list.join(',')}`)
      return { entries, postingsText: lines.join('\n') }
    },
  }
}

/**
 * 构建索引（懒构建入口）：结构化小文档存全文（小）；分集/分镜只存 locator+摘要+倒排 token；
 * 自由文本只记文件定位（检索时按需读取，不缓存）。
 */
export async function buildRetrievalIndex(root, title) {
  const dir = store.projectDir(root, title)
  const quota = effectiveRetrievalQuota()
  const signature = await collectSignature(root, title)
  const quotaExhausted = []
  const counts = { contract: 0, outline: 0, characters: 0, episodes: 0, shots: 0, world: 0, memory: 0, otherFreeText: 0 }
  const builder = createIndexBuilder()

  const contract = await store.getContract(root, title).catch(() => ({}))
  const outlineAll = await store.getOutline(root, title).catch(() => [])
  const charactersAll = await store.getCharacters(root, title).catch(() => [])
  const contractText = JSON.stringify(contract, null, 1)
  builder.add({ type: 'contract', path: '剧集契约', weight: WEIGHTS.contract, text: contractText.slice(0, MAX_CHARS_PER_DOC), summary: summarize(contractText) }, contractText)
  counts.contract = 1

  const outline = outlineAll.slice(0, quota.outline)
  if (outlineAll.length > outline.length) quotaExhausted.push({ type: 'outline', total: outlineAll.length, scanned: outline.length })
  for (const row of outline) {
    const text = [row.title, row.logline, row.hook, row.twist, row.cliffhanger].filter(Boolean).join(' ')
    builder.add({ type: 'outline', path: `总纲/第${row.order}集`, episode: Number(row.order), title: row.title || '', weight: WEIGHTS.outline }, text, { bigramOnly: true })
  }
  counts.outline = outline.length

  const characterCards = charactersAll.slice(0, quota.characters)
  if (charactersAll.length > characterCards.length) quotaExhausted.push({ type: 'characters', total: charactersAll.length, scanned: characterCards.length })
  for (const card of characterCards) {
    const text = [card.name, card.role, (card.personality || []).join(' '), card.bio, card.appearancePrompt].filter(Boolean).join(' ')
    builder.add({ type: 'character', path: `人物/${card.name}`, title: card.name, weight: WEIGHTS.characters }, text, { bigramOnly: true })
  }
  counts.characters = characterCards.length

  const episodesAll = await store.listEpisodes(root, title).catch(() => [])
  const episodes = episodesAll.slice(0, quota.episodes)
  if (episodesAll.length > episodes.length) quotaExhausted.push({ type: 'episodes', total: episodesAll.length, scanned: episodes.length })
  let shotsTotal = 0
  for (const episode of episodes) {
    const episodeText = (await store.readEpisode(root, title, episode.order).catch(() => ({ text: '' }))).text || ''
    builder.add(
      { type: 'episode', path: `分集剧本/第${episode.order}集`, episode: Number(episode.order), weight: WEIGHTS.episode, summary: summarize(episodeText, 160) },
      episodeText,
      { bigramOnly: true, tokenLimit: 700 },
    )
    counts.episodes += 1
    const shots = await store.getStoryboard(root, title, episode.order).catch(() => [])
    for (const shot of shots) {
      shotsTotal += 1
      if (counts.shots >= quota.shots) continue
      const text = [shot.description, shot.dialogue, shot.cameraMove, shot.sfx].filter(Boolean).join(' ')
      // 分镜量大（2000 条），索引 token 上限 24（关键词面），控制索引/内存；全文仍可在命中后按需读取
      builder.add({ type: 'shot', path: `分镜/第${episode.order}集/${shot.shotNumber}`, episode: Number(episode.order), shotNumber: String(shot.shotNumber || ''), weight: WEIGHTS.shot, summary: summarize(text, 120) }, text, { tokenLimit: 24, bigramOnly: true })
      counts.shots += 1
    }
  }
  if (shotsTotal > counts.shots) quotaExhausted.push({ type: 'shots', total: shotsTotal, scanned: counts.shots })

  // 自由文本：按条目拆分建索引（A 方案 ③：world/memory 每条一 entry，locator 含条目标题/key；不缓存全文）
  let freeTextFilesCount = 0
  const entryTypes = { world: 0, memory: 0, otherFreeText: 0 }
  for (const item of FREETEXT_DIRS) {
    let files = []
    try {
      files = (await fs.readdir(path.join(dir, item.dir), { withFileTypes: true })).filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
    } catch {
      files = []
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    let scannedFiles = 0
    for (const file of files) {
      if (freeTextFilesCount >= quota.freeText) break
      freeTextFilesCount += 1
      scannedFiles += 1
      const rel = `${item.dir}/${file.name}`
      let text = ''
      try {
        text = await fs.readFile(path.join(dir, item.dir, file.name), 'utf8')
      } catch {
        text = ''
      }
      const split = text ? splitMarkdownEntries(text) : []
      const entriesOfFile = split.length ? split : [{ title: '', text }]
      for (const piece of entriesOfFile) {
        const title = piece.title ? entryKeyOf(piece.title) || piece.title : ''
        const body = [piece.title, piece.text].filter(Boolean).join('\n')
        builder.add(
          {
            type: item.type,
            path: rel,
            title: title || null,
            weight: WEIGHTS[item.type] || 1.2,
            chars: body.length,
          },
          body,
          { templateLike: false },
        )
        if (item.type === 'world') entryTypes.world += 1
        else if (item.type === 'memory') entryTypes.memory += 1
        else entryTypes.otherFreeText += 1
      }
    }
    if (files.length > scannedFiles) quotaExhausted.push({ type: item.type, total: files.length, scanned: scannedFiles })
  }
  counts.world = entryTypes.world
  counts.memory = entryTypes.memory
  counts.otherFreeText = entryTypes.otherFreeText

  const { entries, postingsText } = builder.finalize()
  const index = {
    schemaVersion: RETRIEVAL_INDEX_VERSION,
    format: INDEX_FORMAT,
    signature,
    builtAt: new Date().toISOString(),
    title,
    entries,
    postingsText,
    counts,
    quota,
    quotaExhausted,
  }
  try {
    await fs.mkdir(path.join(dir, INDEX_DIR), { recursive: true })
    await store.atomicWrite(path.join(dir, INDEX_DIR, INDEX_FILE), `${JSON.stringify(index)}\n`)
  } catch {
    /* 索引写盘失败不阻断检索 */
  }
  return attachPostingsIndex(index)
}

/* ------------------------------------------------------------ 索引缓存/加载 */

const indexCache = new Map()
/** 索引内存缓存上限（LRU）：内存/配额场景会创建多个临时项目副本，避免全部常驻导致 RSS 超标。 */
const INDEX_CACHE_MAX = 3

export function resetRetrievalIndexCache() {
  indexCache.clear()
}

function rememberIndex(key, signature, index) {
  indexCache.delete(key)
  indexCache.set(key, { signature, index })
  while (indexCache.size > INDEX_CACHE_MAX) {
    const oldest = indexCache.keys().next().value
    indexCache.delete(oldest)
  }
}

/** P3-G：把紧凑倒排字符串解析成 token→[start,end] 偏移表（只存偏移，不常驻数字数组）。 */
function attachPostingsIndex(index) {
  if (index && index._postingsIndex instanceof Map) return index
  const map = new Map()
  const text = String((index && index.postingsText) || '')
  let start = 0
  while (start < text.length) {
    let end = text.indexOf('\n', start)
    if (end < 0) end = text.length
    const sep = text.indexOf('\u0001', start)
    if (sep >= 0 && sep < end) map.set(text.slice(start, sep), [sep + 1, end])
    start = end + 1
  }
  if (index) index._postingsIndex = map
  return index
}

function postingRange(index, token) {
  if (!(index._postingsIndex instanceof Map)) attachPostingsIndex(index)
  return index._postingsIndex.get(token) || null
}

/** 倒排文档数（不解析数组；数逗号即可）。 */
function postingCountOf(index, token) {
  const range = postingRange(index, token)
  if (!range) return 0
  const text = index.postingsText
  let count = range[1] > range[0] ? 1 : 0
  for (let i = range[0]; i < range[1]; i += 1) if (text.charCodeAt(i) === 44) count += 1
  return count
}

/** 解析单个 token 的倒排文档下标数组（仅在命中查询词时解析，随查询结束释放）。 */
function postingListOf(index, token) {
  const range = postingRange(index, token)
  if (!range) return null
  const raw = index.postingsText.slice(range[0], range[1])
  if (!raw) return []
  const parts = raw.split(',')
  const out = new Array(parts.length)
  for (let i = 0; i < parts.length; i += 1) out[i] = Number(parts[i])
  return out
}

/**
 * 懒加载索引：内存缓存命中 → 直接用；签名变化 → 重建；旧项目无索引 → 懒构建（不报错）。
 * rebuilt 语义：首次懒构建=true；索引未变（缓存/文件命中）=false；内容变更 stale 重建=true。
 * @returns {Promise<{index:object, rebuilt:boolean}>}
 */
export async function loadRetrievalIndex(root, title, options = {}) {
  const key = `${root}\u0000${title}`
  const signature = await collectSignature(root, title)
  const cached = indexCache.get(key)
  if (!options.force && cached && cached.signature === signature) {
    rememberIndex(key, signature, cached.index)
    return { index: cached.index, rebuilt: false }
  }
  if (!options.force) {
    try {
      const raw = await fs.readFile(path.join(store.projectDir(root, title), INDEX_DIR, INDEX_FILE), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && parsed.schemaVersion === RETRIEVAL_INDEX_VERSION && parsed.format === INDEX_FORMAT && parsed.signature === signature && parsed.postingsText && parsed.entries) {
        attachPostingsIndex(parsed)
        rememberIndex(key, signature, parsed)
        return { index: parsed, rebuilt: false }
      }
    } catch {
      /* 无索引/损坏/版本不符 → 重建 */
    }
  }
  const index = await buildRetrievalIndex(root, title)
  rememberIndex(key, index.signature, index)
  return { index, rebuilt: true }
}

/* ---------------------------------------------------------------- 词法工具 */

function excerptOf(text, matchedTokens) {
  const flat = String(text || '').replace(/\s+/g, ' ')
  if (!matchedTokens || !matchedTokens.length) return flat.slice(0, 160)
  let bestAt = -1
  for (const token of matchedTokens) {
    const at = flat.indexOf(token)
    if (at >= 0 && (bestAt < 0 || at < bestAt)) bestAt = at
  }
  if (bestAt < 0) return flat.slice(0, 160)
  const start = Math.max(0, bestAt - 60)
  return (start > 0 ? '…' : '') + flat.slice(start, start + 200)
}

function phraseCount(text, question) {
  const flat = String(text || '').toLowerCase()
  const needle = String(question || '').trim().toLowerCase()
  if (!needle || !flat) return 0
  let count = 0
  let at = flat.indexOf(needle)
  while (at >= 0 && count < 3) {
    count += 1
    at = flat.indexOf(needle, at + needle.length)
  }
  return count
}

/* --------------------------------------------------------------- 排序器抽象 */
let activeRanker = null

export function setRetrievalRanker(ranker) {
  if (ranker == null) {
    activeRanker = null
    return () => {}
  }
  if (typeof ranker !== 'function') throw new Error('检索排序器必须是一个函数')
  activeRanker = ranker
  return () => {
    if (activeRanker === ranker) activeRanker = null
  }
}

export function getRetrievalRanker() {
  return activeRanker
}

/** 兼容旧外部排序器：构建旧式全文字档（仅小项目/外部排序器路径使用，上限 400 保持旧契约）。 */
async function collectLegacyDocs(root, title) {
  const projectDirPath = store.projectDir(root, title)
  const docs = []
  const contract = await store.getContract(root, title)
  docs.push({ path: '剧集契约', weight: 1.6, text: JSON.stringify(contract, null, 1) })
  for (const row of await store.getOutline(root, title)) {
    docs.push({ path: `总纲/第${row.order}集`, weight: 1.4, text: [row.title, row.logline, row.hook, row.twist, row.cliffhanger].filter(Boolean).join(' ') })
  }
  for (const card of await store.getCharacters(root, title)) {
    docs.push({ path: `人物/${card.name}`, weight: 1.5, text: [card.name, card.role, (card.personality || []).join(' '), card.bio, card.appearancePrompt].filter(Boolean).join(' ') })
  }
  for (const episode of await store.listEpisodes(root, title)) {
    const { text } = await store.readEpisode(root, title, episode.order)
    if (text) docs.push({ path: `分集剧本/第${episode.order}集`, weight: 1.0, text: text.slice(0, MAX_CHARS_PER_DOC) })
    for (const shot of await store.getStoryboard(root, title, episode.order)) {
      docs.push({ path: `分镜/第${episode.order}集/${shot.shotNumber}`, weight: 0.8, text: [shot.description, shot.dialogue, shot.cameraMove].filter(Boolean).join(' ') })
    }
    if (docs.length >= MAX_DOCS_LEGACY) return docs.slice(0, MAX_DOCS_LEGACY)
  }
  for (const item of FREETEXT_DIRS) {
    const base = path.join(projectDirPath, item.dir)
    let entries = []
    try {
      entries = await fs.readdir(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(md|txt)$/i.test(entry.name)) continue
      try {
        const text = await fs.readFile(path.join(base, entry.name), 'utf8')
        docs.push({ path: `${item.dir}/${entry.name}`, weight: WEIGHTS[item.type], text: text.slice(0, MAX_CHARS_PER_DOC) })
      } catch {
        /* ignore */
      }
      if (docs.length >= MAX_DOCS_LEGACY) break
    }
  }
  return docs.slice(0, MAX_DOCS_LEGACY)
}

function normalizeRankedHits(ranked, docs, topK) {
  const byPath = new Map(docs.map((doc) => [doc.path, doc]))
  const hits = []
  for (const item of Array.isArray(ranked) ? ranked : []) {
    if (!item || typeof item !== 'object') continue
    const hitPath = typeof item.path === 'string' ? item.path : ''
    if (!hitPath) continue
    const doc = byPath.get(hitPath)
    const matched = Array.isArray(item.matched) ? item.matched.map(String) : []
    hits.push({
      path: hitPath,
      score: Number(Number(item.score).toFixed(3)) || 0,
      matched,
      excerpt: typeof item.excerpt === 'string' && item.excerpt ? item.excerpt : excerptOf(doc ? doc.text : '', matched),
    })
    if (hits.length >= topK) break
  }
  return hits
}

function scanMetaOf(index, { scanned, truncated, degraded, degradeReason, rebuilt }) {
  return {
    schemaVersion: RETRIEVAL_INDEX_VERSION,
    mode: 'indexed-lexical',
    total: index ? Object.values(index.counts || {}).reduce((sum, value) => sum + Number(value || 0), 0) : 0,
    scanned,
    truncated,
    byType: {
      contract: index?.counts?.contract || 0,
      outline: index?.counts?.outline || 0,
      characters: index?.counts?.characters || 0,
      episodes: index?.counts?.episodes || 0,
      shots: index?.counts?.shots || 0,
      world: index?.counts?.world || 0,
      memory: index?.counts?.memory || 0,
      otherFreeText: index?.counts?.otherFreeText || 0,
    },
    quota: index?.quota || RETRIEVAL_QUOTA,
    quotaExhausted: index?.quotaExhausted || [],
    degraded: Boolean(degraded),
    degradeReason: degradeReason || null,
    entryLevel: index?.counts
      ? {
          enabled: true,
          entries: { world: index.counts.world || 0, memory: index.counts.memory || 0, otherFreeText: index.counts.otherFreeText || 0 },
        }
      : null,
    index: { schemaVersion: RETRIEVAL_INDEX_VERSION, format: index?.format || INDEX_FORMAT, rebuilt: Boolean(rebuilt), path: RETRIEVAL_INDEX_RELATIVE },
  }
}

/* ---------------------------------------------------------------- 检索入口 */

export async function searchContext(root, title, query, options = {}) {
  const question = String(query == null ? '' : query)
  let settings = {}
  try {
    settings = (await store.getSettings(root)) || {}
  } catch {
    settings = {}
  }
  const enabled = options.enabled != null ? Boolean(options.enabled) : settings.retrievalEnabled !== false
  const wantedTopK = Number(options.topK) || Number(settings.retrievalTopK) || 5
  const topK = Math.min(Math.max(wantedTopK, 1), 20)

  if (!enabled) {
    return {
      query: question,
      hits: [],
      scanned: 0,
      truncated: 0,
      degraded: true,
      degradeReason: 'retrieval-disabled',
      method: 'disabled',
      enabled: false,
      topK,
      scanMeta: scanMetaOf(null, { scanned: 0, truncated: 0, degraded: true, degradeReason: 'retrieval-disabled', rebuilt: false }),
    }
  }

  const queryTokens = new Set(tokenize(question))

  // 外部排序器：保持旧文档形态（兼容既有注入契约/测试）
  if (activeRanker) {
    const docs = await collectLegacyDocs(root, title)
    if (!queryTokens.size) {
      return { query: question, hits: [], scanned: docs.length, truncated: 0, degraded: false, degradeReason: null, method: 'local-lexical', enabled: true, topK, reason: 'empty-query', scanMeta: scanMetaOf(null, { scanned: docs.length, truncated: 0, degraded: false, degradeReason: null, rebuilt: false }) }
    }
    try {
      const ranked = await activeRanker({ docs: docs.map((doc) => ({ path: doc.path, text: doc.text, weight: doc.weight })), query: question, tokens: [...queryTokens], topK })
      if (!Array.isArray(ranked)) throw new Error('排序器返回值必须是数组')
      return { query: question, hits: normalizeRankedHits(ranked, docs, topK), scanned: docs.length, truncated: 0, degraded: false, degradeReason: null, method: 'external-ranker', enabled: true, topK, scanMeta: scanMetaOf(null, { scanned: docs.length, truncated: 0, degraded: false, degradeReason: null, rebuilt: false }) }
    } catch (error) {
      const scores = new Map()
      const docCount = docs.length || 1
      const idfCache = new Map()
      for (const doc of docs) {
        let count = 0
        for (const token of queryTokens) {
          if (doc.text.includes(token)) count += 1
        }
        if (count) scores.set(doc.path, { doc, count })
      }
      const idfOf = (token) => {
        if (!idfCache.has(token)) {
          let df = 0
          for (const doc of docs) if (doc.text.includes(token)) df += 1
          idfCache.set(token, Math.log(1 + docCount / ((df || 1) + 0.5)))
        }
        return idfCache.get(token)
      }
      const lexHits = [...scores.values()]
        .map(({ doc, count }) => {
          const coverage = count / queryTokens.size
          const matched = [...queryTokens].filter((token) => doc.text.includes(token)).slice(0, 12)
          const sum = matched.reduce((acc, token) => acc + idfOf(token), 0)
          return { path: doc.path, score: Number(((sum + coverage * 2) * doc.weight).toFixed(3)), matched, excerpt: excerptOf(doc.text, matched) }
        })
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
      return { query: question, hits: lexHits, scanned: docs.length, truncated: 0, degraded: true, degradeReason: `ranker-failed: ${error instanceof Error ? error.message : String(error)}`, method: 'local-lexical', enabled: true, topK, scanMeta: scanMetaOf(null, { scanned: docs.length, truncated: 0, degraded: true, degradeReason: 'ranker-failed', rebuilt: false }) }
    }
  }

  // —— 主路径：懒加载索引（无索引 → 构建，不报错） ——
  const loaded = await loadRetrievalIndex(root, title)
  const index = loaded.index
  const entries = index.entries || []
  const counts = index.counts || {}
  const truncated = (index.quotaExhausted || []).reduce((sum, item) => sum + Math.max(0, Number(item.total ?? 0) - Number(item.scanned ?? 0)), 0)
  const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0)
  const dialogueIntent = isDialogueIntent(question)
  const intent = detectRetrievalIntent(question)
  const expansion = expandQueryTokens(question)
  const queryWeights = expansion.tokens
  const queryTokenList = [...queryWeights.keys()]
  const totalWeight = queryTokenList.reduce((sum, token) => sum + queryWeights.get(token), 0) || 1
  const entryLevel = {
    enabled: true,
    entries: total,
    types: { world: counts.world || 0, memory: counts.memory || 0, otherFreeText: counts.otherFreeText || 0 },
  }

  if (!queryWeights.size) {
    const degraded = Boolean((index.quotaExhausted || []).length)
    return {
      query: question,
      hits: [],
      scanned: total,
      truncated,
      degraded,
      degradeReason: degraded ? 'scan-quota-exhausted' : null,
      method: 'local-lexical',
      enabled: true,
      topK,
      reason: 'empty-query',
      intent,
      expandedTerms: expansion.expanded,
      entryLevel,
      scanMeta: scanMetaOf(index, { scanned: total, truncated, degraded, degradeReason: degraded ? 'scan-quota-exhausted' : null, rebuilt: loaded.rebuilt }),
    }
  }

  const docCount = entries.length || 1
  const idfCache = new Map()
  const idfOf = (token) => {
    if (!idfCache.has(token)) {
      const df = postingCountOf(index, token)
      idfCache.set(token, Math.log(1 + docCount / ((df || 1) + 0.5)))
    }
    return idfCache.get(token)
  }

  // 倒排打分：weightedMatched / sumIdf / matchedTokenCount per doc（无逐文档 Set 分配）
  const matchedWeight = new Map()
  const sumIdf = new Map()
  const matchedTokenCount = new Map()
  for (const token of queryTokenList) {
    const list = postingListOf(index, token)
    if (!Array.isArray(list) || !list.length) continue
    const weight = queryWeights.get(token)
    const idf = idfOf(token)
    for (const docIndex of list) {
      matchedWeight.set(docIndex, (matchedWeight.get(docIndex) || 0) + weight)
      sumIdf.set(docIndex, (sumIdf.get(docIndex) || 0) + idf * weight)
      matchedTokenCount.set(docIndex, (matchedTokenCount.get(docIndex) || 0) + 1)
    }
  }

  const intentBoostOf = (entry) => {
    const table = {
      memory: { memory: 1.5, world: 1.1, shot: 1.05 },
      dialogue: { episode: 1.15, shot: 1.1, dialogueVoice: 1.2 },
      character: { character: 1.25, outline: 1.05 },
      world: { world: 1.3 },
      plot: { outline: 1.15, episode: 1.1, shot: 1.05 },
      agreement: { memory: 1.6, shot: 1.2, episode: 1.1, world: 0.85, outline: 0.9 },
    }[intent]
    return (table && table[entry.type]) || 1
  }

  const titleMatchesOf = (entry) => {
    const titleTokens = Array.isArray(entry.titleTokens) ? entry.titleTokens : []
    if (!titleTokens.length) return 0
    let count = 0
    for (const token of titleTokens) if (queryWeights.has(token)) count += 1
    return count
  }

  const candidates = []
  const episodeStage1 = []
  for (const [docIndex, weight] of matchedWeight) {
    const entry = entries[docIndex]
    if (!entry) continue
    const coverage = weight / totalWeight
    let score = (sumIdf.get(docIndex) || 0) * (entry.weight || 1) * intentBoostOf(entry) + coverage * 2
    const titleMatches = titleMatchesOf(entry)
    if (titleMatches) score += titleMatches * TITLE_TOKEN_BONUS * (entry.weight || 1)
    if (entry.title) {
      if (hitsTitle(question, entry.title)) score += TITLE_EXACT_BONUS * (entry.weight || 1)
      else if (containsTitle(question, entry.title)) score += TITLE_IN_QUERY_BONUS * (entry.weight || 1)
    }
    if (entry.text) score += PHRASE_BONUS_UNIT * phraseCount(entry.text, question) * (entry.weight || 1)
    // S1 模板降权：模板化条目且命中覆盖低（仅少量高频字命中）时显著降权；覆盖高（标题/整句命中）不动
    if (entry.templateLike) {
      if (coverage < 0.35) score *= 0.35
      else if (coverage < 0.5) score *= 0.6
    }
    if (entry.type === 'episode') {
      episodeStage1.push({ docIndex, score })
      continue
    }
    if (entry.type === 'shot') score += (dialogueIntent ? DIALOGUE_INTENT_SHOT_BONUS : 0) * (entry.weight || 1)
    candidates.push({ entry, score, docIndex })
  }

  // 分集：索引分 → 候选精排（读全文，含同义扩展/字段加权/模板无关；台词意图加成）
  episodeStage1.sort((a, b) => b.score - a.score)
  const rescore = episodeStage1.slice(0, RESCORE_CANDIDATES)
  let readBudget = FULLTEXT_READ_BUDGET
  const tokenIdf = new Map(queryTokenList.map((token) => [token, idfOf(token)]))
  for (const item of rescore) {
    if (readBudget <= 0) break
    readBudget -= 1
    const entry = entries[item.docIndex]
    try {
      const { text } = await store.readEpisode(root, title, entry.episode)
      const matched = []
      let sum = 0
      let weight = 0
      for (const token of queryTokenList) {
        if (text.includes(token)) {
          matched.push(token)
          const tokenWeight = queryWeights.get(token)
          weight += tokenWeight
          sum += (tokenIdf.get(token) || 0) * tokenWeight
        }
      }
      if (!matched.length) {
        candidates.push({ entry, score: item.score, docIndex: item.docIndex })
        continue
      }
      const coverage = weight / totalWeight
      let score = sum * (WEIGHTS.episode || 1) * intentBoostOf(entry) + coverage * 2
      score += PHRASE_BONUS_UNIT * 2 * phraseCount(text, question) * (WEIGHTS.episode || 1)
      if (dialogueIntent) score += DIALOGUE_INTENT_EPISODE_BONUS
      candidates.push({ entry, score, docIndex: item.docIndex, fullText: text, tokens: matched })
    } catch {
      candidates.push({ entry, score: item.score, docIndex: item.docIndex })
    }
  }
  for (const item of episodeStage1.slice(RESCORE_CANDIDATES)) candidates.push({ entry: entries[item.docIndex], score: item.score, docIndex: item.docIndex })

  const hits = candidates
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((item) => {
      const matched = item.tokens
        ? item.tokens.slice(0, 12)
        : item.docIndex != null
          ? entryMatchedTokens(item.docIndex, queryTokenList, index)
          : []
      const text = item.fullText || item.entry.text || item.entry.summary || ''
      return {
        path: item.entry.path,
        score: Number(item.score.toFixed(3)),
        matched,
        excerpt: excerptOf(text, matched),
        locator: locatorText(item.entry),
        location: locationOf(item.entry),
      }
    })

  const quotaExhausted = Boolean((index.quotaExhausted || []).length)
  const degraded = quotaExhausted
  const degradeReason = quotaExhausted ? 'scan-quota-exhausted' : null
  return {
    query: question,
    hits,
    scanned: total,
    truncated,
    degraded,
    degradeReason,
    method: 'local-lexical',
    enabled: true,
    topK,
    intent,
    expandedTerms: expansion.expanded,
    entryLevel,
    scanMeta: scanMetaOf(index, { scanned: total, truncated, degraded, degradeReason, rebuilt: loaded.rebuilt }),
  }
}

function entryMatchedTokens(docIndex, queryTokens, index) {
  const matched = []
  for (const token of queryTokens) {
    const list = postingListOf(index, token)
    if (Array.isArray(list) && list.includes(docIndex)) matched.push(token)
    if (matched.length >= 12) break
  }
  return matched
}
