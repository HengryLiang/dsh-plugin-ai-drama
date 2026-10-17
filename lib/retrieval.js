/**
 * 检索增强（FR-C08）。
 *
 * 设计取舍：**本地词法检索优先，外部嵌入可选**。
 * 理由：PRD 把本项定为 P1，且明确要求「依赖可选组件缺失时自动降级，不阻断主流程」。
 * 因此这里实现零依赖的本地检索（中文按字切分 + 字段加权 + BM25 风格打分），
 * 效果对本场景（找回设定、桥段、人物）足够，且不引入外部服务与费用。
 * 若将来接入向量检索，只需替换 rank()，接口不变。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import * as store from './store.js'

const MAX_DOCS = 400
const MAX_CHARS_PER_DOC = 20000

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
      // 中文：单字 + 相邻二元组，兼顾召回与精度
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

/** 收集可检索文档：结构化数据权重更高，正文与设定居中，导出与草稿区排除。 */
async function collectDocs(root, title) {
  const projectDirPath = store.projectDir(root, title)
  const docs = []

  const contract = await store.getContract(root, title)
  docs.push({ path: '剧集契约', weight: 1.6, text: JSON.stringify(contract, null, 1) })

  for (const row of await store.getOutline(root, title)) {
    docs.push({
      path: `总纲/第${row.order}集`,
      weight: 1.4,
      text: [row.title, row.logline, row.hook, row.twist, row.cliffhanger].filter(Boolean).join(' '),
    })
  }

  for (const card of await store.getCharacters(root, title)) {
    docs.push({
      path: `人物/${card.name}`,
      weight: 1.5,
      text: [card.name, card.role, (card.personality || []).join(' '), card.bio, card.appearancePrompt].filter(Boolean).join(' '),
    })
  }

  for (const episode of await store.listEpisodes(root, title)) {
    const { text } = await store.readEpisode(root, title, episode.order)
    if (text) docs.push({ path: `分集剧本/第${episode.order}集`, weight: 1.0, text: text.slice(0, MAX_CHARS_PER_DOC) })
    for (const shot of await store.getStoryboard(root, title, episode.order)) {
      docs.push({
        path: `分镜/第${episode.order}集/${shot.shotNumber}`,
        weight: 0.8,
        text: [shot.description, shot.dialogue, shot.cameraMove].filter(Boolean).join(' '),
      })
    }
  }

  // 构想 / 世界观 / 本剧记忆 等自由文本目录
  for (const dir of ['构想', '世界观', '本剧记忆', '台词与音效']) {
    const base = path.join(projectDirPath, dir)
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
        docs.push({ path: `${dir}/${entry.name}`, weight: 1.2, text: text.slice(0, MAX_CHARS_PER_DOC) })
      } catch {
        /* 忽略 */
      }
      if (docs.length >= MAX_DOCS) break
    }
  }

  return docs.slice(0, MAX_DOCS)
}

function scoreDoc(doc, queryTokens, df) {
  const tokens = tokenize(doc.text)
  const tf = new Map()
  for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1)

  let score = 0
  const matched = new Set()
  for (const [token, count] of tf) {
    if (!queryTokens.has(token)) continue
    matched.add(token)
    // BM25 风格：饱和 TF × 稀有度 IDF
    const idf = Math.log(1 + 1 / (df.get(token) || 1))
    score += ((count * 2.2) / (count + 1.2)) * idf
  }
  if (!matched.size) return { score: 0, matched: [] }
  const coverage = matched.size / queryTokens.size
  return { score: (score * doc.weight) + coverage * 2, matched: [...matched] }
}

/* --------------------------------------------------------------- 排序器抽象 */
/*
 * P1-C（Q2 已决：P1 沿用自建词法）：把「排序」抽成可替换的一层 ——
 *   - 默认 lexicalRank 永远可用（零依赖，不阻断主流程）；
 *   - 将来接嵌入/重排时用 setRetrievalRanker() 注入实现即可；
 *   - 外部排序器缺失/抛错/返回不合法 → **自动降级**回词法，并在结果里带
 *     degraded=true + degradeReason，供工具/面板/QA 观测（不阻断）。
 */
let activeRanker = null

/** 注入可替换排序器；ranker({docs, query, tokens, topK}) → [{path, score, matched?, excerpt?}]（可 Promise）。 */
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

/** 本地词法排序（默认实现）：BM25 风格打分 + 字段权重。 */
function lexicalRank(docs, queryTokens) {
  const df = new Map()
  for (const doc of docs) {
    for (const token of new Set(tokenize(doc.text))) {
      if (queryTokens.has(token)) df.set(token, (df.get(token) || 0) + 1)
    }
  }
  return docs
    .map((doc) => {
      const { score, matched } = scoreDoc(doc, queryTokens, df)
      return { path: doc.path, score: Number(score.toFixed(3)), matched, excerpt: buildExcerpt(doc.text, matched) }
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
}

/** 外部排序器返回值归一化：只接受合法条目，缺 excerpt 时从文档补。 */
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
      excerpt: typeof item.excerpt === 'string' && item.excerpt ? item.excerpt : buildExcerpt(doc ? doc.text : '', matched),
    })
    if (hits.length >= topK) break
  }
  return hits
}

/** 取与 query 最相关的片段，用于注入上下文。 */
export async function searchContext(root, title, query, options = {}) {
  const question = String(query == null ? '' : query)
  // 读取设置（P1-G H-2）：retrievalEnabled 开关 + retrievalTopK 默认值；读不到设置时用内置默认，不阻断。
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
      degraded: true,
      degradeReason: 'retrieval-disabled',
      method: 'disabled',
      enabled: false,
      topK,
    }
  }

  const docs = await collectDocs(root, title)
  const queryTokens = new Set(tokenize(question))
  if (!queryTokens.size) {
    return { query: question, hits: [], scanned: docs.length, degraded: false, degradeReason: null, method: 'local-lexical', enabled: true, topK, reason: 'empty-query' }
  }

  if (activeRanker) {
    try {
      const ranked = await activeRanker({
        docs: docs.map((doc) => ({ path: doc.path, text: doc.text, weight: doc.weight })),
        query: question,
        tokens: [...queryTokens],
        topK,
      })
      if (!Array.isArray(ranked)) throw new Error('排序器返回值必须是数组')
      return {
        query: question,
        hits: normalizeRankedHits(ranked, docs, topK),
        scanned: docs.length,
        degraded: false,
        degradeReason: null,
        method: 'external-ranker',
        enabled: true,
        topK,
      }
    } catch (error) {
      // 外部排序器不可用 → 自动降级回本地词法（不阻断主流程），并留下可观测标记。
      return {
        query: question,
        hits: lexicalRank(docs, queryTokens).slice(0, topK),
        scanned: docs.length,
        degraded: true,
        degradeReason: `ranker-failed: ${error instanceof Error ? error.message : String(error)}`,
        method: 'local-lexical',
        enabled: true,
        topK,
      }
    }
  }

  return {
    query: question,
    hits: lexicalRank(docs, queryTokens).slice(0, topK),
    scanned: docs.length,
    degraded: false,
    degradeReason: null,
    method: 'local-lexical',
    enabled: true,
    topK,
  }
}

function buildExcerpt(text, matched) {
  if (!matched || !matched.length) return text.slice(0, 160)
  const flat = text.replace(/\s+/g, ' ')
  let bestAt = -1
  for (const token of matched) {
    const at = flat.indexOf(token)
    if (at >= 0 && (bestAt < 0 || at < bestAt)) bestAt = at
  }
  if (bestAt < 0) return flat.slice(0, 160)
  const start = Math.max(0, bestAt - 60)
  return (start > 0 ? '…' : '') + flat.slice(start, start + 200)
}
