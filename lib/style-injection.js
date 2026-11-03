/**
 * C2b（E16 add-only 读侧）：冻结风格只读注入纯函数（无 I/O、无时间戳、确定性）。
 *
 * 契约：`需求/需求分析-C2b-生成链风格注入-v1.md` v1.1（Lead 已批）
 * - 仅 `style.json state.status==='frozen'` 且六维至少一维非空时生成固定章节（v0.16.127：≤4000 字确定性截断）；
 * - 不写 style.json；旧 style 无 state 读为 draft（不注入）；directed/draft 不注入；
 * - 固定格式：标题 + 六维（palette→lighting→texture→composition→motion→other，仅非空）+ 只读说明；
 * - 供 orchestrator（image/video 生成提示词）与 index assets-get.stylePrompt 共用，保证四路一致。
 */
import { STYLE_DIMENSIONS, STYLE_DIMENSION_LABELS, normalizeStyleDoc, normalizeStyleState } from './style-dna.js'

/** 章节总长上限（字符；v0.16.127 由 600 调至 4000，超限截断并标注「（摘录）」）。 */
export const STYLE_CHAPTER_MAX_CHARS = 4000
/** 超限截断后缀（确定性；完整内容仍保留在 style.json）。 */
export const STYLE_CHAPTER_TRUNCATED_SUFFIX = '…（摘录）'
/** 注入来源标记（add-only 响应/计划元数据；仅 frozen 出现）。 */
export const STYLE_CHAPTER_SOURCE = 'frozen'
/** 只读说明行（固定文本；出现在章节末尾）。 */
export const STYLE_CHAPTER_NOTE = '（以上为项目视觉基准，生成时遵循；不得改写 style.json）'

/**
 * 生成固定「视觉风格基准」章节（纯函数；非 frozen / 全空 → null）。
 * @param {object|null} styleDNA 五维对象（或 {schemaVersion,style}）
 * @param {object|null} state style.json 内 state（缺失/非法按 draft 处理）
 * @returns {string|null}
 */
export function buildStyleChapter(styleDNA, state) {
  const normalizedState = normalizeStyleState(state)
  if (normalizedState.status !== 'frozen') return null
  const dna = normalizeStyleDoc(styleDNA && typeof styleDNA === 'object' ? styleDNA : {}).style
  const rows = []
  for (const dimension of STYLE_DIMENSIONS) {
    const label = STYLE_DIMENSION_LABELS[dimension]
    if (!label) continue
    const text = String(dna[dimension] == null ? '' : dna[dimension]).trim()
    if (text) rows.push(`${label}：${text}`)
  }
  if (!rows.length) return null
  const revision = Number.isInteger(normalizedState.revision) && normalizedState.revision > 0 ? normalizedState.revision : 0
  const chapter = [`【视觉风格基准（已冻结 · revision ${revision} · 只读）】`, ...rows, STYLE_CHAPTER_NOTE].join('\n')
  if (chapter.length <= STYLE_CHAPTER_MAX_CHARS) return chapter
  const headLength = Math.max(0, STYLE_CHAPTER_MAX_CHARS - STYLE_CHAPTER_TRUNCATED_SUFFIX.length)
  return chapter.slice(0, headLength) + STYLE_CHAPTER_TRUNCATED_SUFFIX
}

/**
 * 从 `store.readStyleDoc` 结果生成 `stylePrompt` / `styleInjection` 同构对象（Lead 已批形状）。
 * @param {{doc?:object, text?:string, hash?:string}|null} styleDoc
 * @returns {{source:'frozen', status:'frozen', revision:number, hash:string|null, chapter:string}|null}
 */
export function stylePromptFor(styleDoc) {
  const doc = styleDoc && typeof styleDoc === 'object' && styleDoc.doc && typeof styleDoc.doc === 'object' ? styleDoc.doc : null
  if (!doc) return null
  const state = normalizeStyleState(doc.state)
  const style = normalizeStyleDoc(doc).style
  const chapter = buildStyleChapter(style, state)
  if (!chapter) return null
  return {
    source: STYLE_CHAPTER_SOURCE,
    status: 'frozen',
    revision: state.revision,
    hash: typeof styleDoc.hash === 'string' && styleDoc.hash ? styleDoc.hash : null,
    chapter,
  }
}

/** 生成计划 add-only `styleInjection`（与 stylePrompt 同构；仅注入时出现）。 */
export function styleInjectionForPlan(styleDoc) {
  return stylePromptFor(styleDoc)
}
