/**
 * v0.10.3（task-89）：videoPrompt 草帽式渲染 helper。
 *
 * 纯函数、确定性（无时间戳/随机/顺序依赖）；**仅被 orchestrator.buildShotPrompt 的 video 分支调用**；
 * 不读文件、不改 imagePrompt、不改旧输出。
 *
 * 设计约束（Lead 批准）：
 * - 单镜「全组情绪总控段」≤ CONTROL_MAX_CHARS（300）；
 * - 整镜 prompt ≤ PROMPT_MAX_CHARS（2000），超限确定性截断（尾部 `…`）；
 * - 禁止裸字段罗列（`light:` / `ambientSound:` / `emotion:` 等），一律自然语句；
 * - 无任何 v0.10.0 可选字段的镜返回 null → 调用方回退现状 buildShotPrompt（字节兼容）。
 */

/** 单镜总控段上限（字符）。 */
export const CONTROL_MAX_CHARS = 300
/** 整镜 prompt 上限（字符）。 */
export const PROMPT_MAX_CHARS = 2000

/** 触发草帽式分支的可选字段（与 store.SHOT_OPTIONAL_FIELDS 对齐；此处独立列出避免 store 循环依赖）。 */
export const VIDEO_PROMPT_FIELDS = [
  'emotion',
  'light',
  'ambientSound',
  'constraints',
  'poses',
  'transitionToNext',
  'naturalLanguagePrompt',
  'lens',
  'subject',
  'groupId',
]

function clip(value, max) {
  const text = String(value == null ? '' : value).trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** 确定性截断（超长补 `…`，不改变短文本）。 */
export function truncateDeterministic(text, max = PROMPT_MAX_CHARS) {
  return clip(text, max)
}

/** 镜头是否含任一 v0.10.0 可选字段（非空）。 */
export function shotHasVideoFields(shot) {
  const s = shot && typeof shot === 'object' ? shot : {}
  return VIDEO_PROMPT_FIELDS.some((field) => {
    const value = s[field]
    if (value == null) return false
    if (typeof value === 'string') return value.trim().length > 0
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === 'object') return Object.keys(value).length > 0
    return true
  })
}

function emotionText(emotion) {
  if (!emotion || typeof emotion !== 'object') return ''
  const label = typeof emotion.label === 'string' ? emotion.label.trim() : ''
  const intensity = Number(emotion.intensity)
  if (!label) return ''
  return Number.isFinite(intensity) ? `${label}（强度 ${Math.round(intensity)}/100）` : label
}

/**
 * 渲染「全组情绪总控」段（≤300 字符）。
 * 来源优先级：groups sidecar（notes/emotion/名称）→ 首镜 emotion；都没有 → ''（不添加）。
 * @param {{groups?:Array, firstEmotion?:object}} input
 * @returns {string} 形如 `【全组情绪总控】…` 或 ''
 */
export function renderGroupEmotionControl({ groups = [], firstEmotion = null } = {}) {
  const list = Array.isArray(groups) ? groups.filter((group) => group && typeof group === 'object') : []
  const parts = []
  if (list.length) {
    const primary = list[0]
    const curve = Array.isArray(primary.emotion?.curve) ? primary.emotion.curve.filter((item) => String(item || '').trim()) : []
    const intensity = Number(primary.emotion?.intensity)
    if (curve.length) parts.push(`情绪弧线：${curve.map((item) => String(item).trim()).join('→')}`)
    if (Number.isFinite(intensity)) parts.push(`情绪强度：${Math.round(intensity)}/100`)
    const notes = typeof primary.notes === 'string' ? primary.notes.trim() : ''
    if (notes) parts.push(`整体要求：${notes}`)
    if (!curve.length && !notes && primary.name) parts.push(`整体基调：${primary.name}`)
    if (list.length > 1) parts.push(`分组：${list.map((group) => group.name || group.id || '未命名').slice(0, 6).join('、')}`)
    if (!parts.length) parts.push('按分镜顺序推进，保持情绪连续。')
  } else {
    const emotion = emotionText(firstEmotion)
    if (!emotion) return ''
    parts.push(`整体情绪：${emotion}`)
  }
  const body = parts.map((part) => String(part).replace(/[。；;]+$/g, '')).filter(Boolean).join('；')
  return truncateDeterministic(`【全组情绪总控】${body}。`, CONTROL_MAX_CHARS)
}

function pushSentence(parts, sentence, sourceValue, base) {
  const text = String(sentence || '').trim()
  if (!text) return
  const source = String(sourceValue == null ? '' : sourceValue).trim()
  if (source && base.includes(source)) return
  parts.push(text.endsWith('。') ? text : `${text}。`)
}

/**
 * 渲染单镜自然语言可拍摄段（不含总控段；不含【镜头】前缀）。
 * 字段自然融入句子，禁止 `light:` 之类裸字段罗列。
 * @param {object} shot
 * @param {{baseText?:string}} [options]
 * @returns {string}
 */
export function renderNaturalLanguageShot(shot, options = {}) {
  const s = shot && typeof shot === 'object' ? shot : {}
  const baseText = String(options.baseText || s.naturalLanguagePrompt || s.description || '').trim()
  const size = String(s.shotSize || '').trim()
  const lens = String(s.lens || '').trim()
  const camera = String(s.cameraMove || '').trim()
  const subject = String(s.subject || '').trim()

  const leadParts = []
  if (size) leadParts.push(size)
  if (lens) leadParts.push(lens)
  const lead = leadParts.join('，')
  const paragraphs = []
  if (lead) paragraphs.push(`${lead}${subject ? `，主体是${subject}` : ''}：${baseText || '（本镜按分镜表执行）'}`)
  else if (baseText) paragraphs.push(baseText)
  const parts = paragraphs.length ? [paragraphs.join('')] : []

  pushSentence(parts, camera ? `镜头${camera}` : '', camera, baseText)
  pushSentence(parts, s.light ? `光影方面，${String(s.light).trim()}` : '', s.light, baseText)
  pushSentence(parts, s.ambientSound ? `耳边是${String(s.ambientSound).trim()}` : '', s.ambientSound, baseText)
  const poses = s.poses && typeof s.poses === 'object' ? s.poses : null
  if (poses) {
    const startPose = String(poses.startPose || '').trim()
    const endPose = String(poses.endPose || '').trim()
    const poseText = [startPose ? `起势${startPose}` : '', endPose ? `收势${endPose}` : ''].filter(Boolean).join('，')
    if (poseText) pushSentence(parts, poseText, `${startPose}${endPose}`, baseText)
  }
  const transition = String(s.transitionToNext || '').trim()
  if (transition) pushSentence(parts, `与下一镜以 ${transition} 相接`, transition, baseText)
  const emotion = emotionText(s.emotion)
  if (emotion) pushSentence(parts, `这一镜的情绪是${emotion}`, s.emotion?.label || '', baseText)
  if (Array.isArray(s.constraints) && s.constraints.length) {
    pushSentence(parts, `本镜需避免：${s.constraints.map((item) => String(item || '').trim()).filter(Boolean).join('、')}`, s.constraints.join(''), baseText)
  }
  return parts.join('')
}

/** 风格/场景约束句总长上限（v0.11.3 task-101；字符）。 */
export const STYLE_CUE_MAX_CHARS = 600

function stripEndPunct(value) {
  return String(value == null ? '' : value).trim().replace(/[。；;，,、\s]+$/g, '')
}

/**
 * v0.11.3（task-101 / 2-2 二期）：五维风格 DNA + 场景卡 → 自然语言约束句（纯函数、确定性、≤600 字）。
 * - 五维按 palette→lighting→texture→composition→motion 固定顺序，仅注入非空维度（不伪造）；
 * - 场景卡注入 名称/空间（内景·时间·天气）/描述/光线条件/情绪基线；仅非空字段；
 * - 全部为空 → ''（调用方不注入，字节兼容）；禁英文裸字段罗列。
 * @param {{style?:object|null, scene?:object|null}} input
 * @returns {string}
 */
export function renderStyleCue({ style = null, scene = null } = {}) {
  const sentences = []
  const dna = style && typeof style === 'object' ? style : {}
  const dimensions = []
  for (const dimension of ['palette', 'lighting', 'texture', 'composition', 'motion']) {
    const text = stripEndPunct(dna[dimension])
    if (text) dimensions.push(text)
  }
  if (dimensions.length) sentences.push(`画面风格上，${dimensions.join('；')}。`)
  if (scene && typeof scene === 'object') {
    const parts = []
    const space = scene.space && typeof scene.space === 'object' ? scene.space : {}
    const spaceBits = [space.interior, space.timeOfDay, space.weather].map((item) => String(item || '').trim()).filter(Boolean)
    const name = String(scene.name || '').trim()
    const description = stripEndPunct(scene.description)
    const lead = [name, spaceBits.length ? `（${spaceBits.join('，')}）` : ''].join('')
    if (lead) parts.push(`${lead ? `场景设定为${lead}` : ''}${description ? `：${description}` : ''}`)
    else if (description) parts.push(`场景：${description}`)
    const lighting = stripEndPunct(scene.lighting)
    if (lighting) parts.push(`光线条件：${lighting}`)
    const baseline = scene.emotionBaseline && typeof scene.emotionBaseline === 'object' ? scene.emotionBaseline : null
    const baselineLabel = baseline ? String(baseline.label || '').trim() : ''
    if (baselineLabel) {
      const intensity = Number(baseline.intensity)
      parts.push(`基线情绪：${baselineLabel}${Number.isFinite(intensity) ? `（${Math.round(intensity)}/100）` : ''}`)
    }
    if (parts.length) sentences.push(`${parts.join('；')}。`)
  }
  if (!sentences.length) return ''
  return truncateDeterministic(sentences.join(''), STYLE_CUE_MAX_CHARS)
}

/**
 * 构造草帽式 video prompt（总控段 + 风格/场景约束句 + 本镜自然语言段；≤2000 字符确定性截断）。
 * - 若镜头无任何可选字段 **且** 无总控段/styleCue → 返回 null（调用方回退现状输出，字节兼容）；
 * - v0.11.3 新增 styleCue：仅非空时插入（无 style/scene 时输出与 v0.11.2 逐字节一致）。
 * @param {object} shot
 * @param {{control?:string, styleCue?:string, maxChars?:number}} [options]
 * @returns {{prompt:string, hasControl:boolean, hasStyleCue:boolean}|null}
 */
export function buildVideoPromptText(shot, options = {}) {
  const control = String(options.control || '').trim()
  const styleCue = String(options.styleCue || '').trim()
  const hasFields = shotHasVideoFields(shot)
  if (!hasFields && !control && !styleCue) return null
  const shotNumber = String((shot && shot.shotNumber) || '').trim() || '?'
  const natural = renderNaturalLanguageShot(shot)
  const body = natural || String((shot && shot.description) || '').trim() || '（本镜按分镜表执行）'
  const sections = []
  if (control) sections.push(control)
  if (styleCue) sections.push(styleCue)
  sections.push(`【镜头 ${shotNumber}】${body}`)
  return {
    prompt: truncateDeterministic(sections.join('\n'), Number(options.maxChars) || PROMPT_MAX_CHARS),
    hasControl: Boolean(control),
    hasStyleCue: Boolean(styleCue),
  }
}

/**
 * 按镜头取「该镜所属分组」的总控段（Lead 口径强化：单镜粒度）。
 * - 优先按 groupId 或 groups[].shotNumbers 关联匹配分组 → 只用该分组渲染；
 * - 该镜无分组归属 → 回退首镜 emotion；
 * - 都没有 → ''（不加总控）。
 */
export function renderControlForShot(shot, { groups = [], firstEmotion = null } = {}) {
  const s = shot && typeof shot === 'object' ? shot : {}
  const shotNumber = String(s.shotNumber || '').trim()
  const list = Array.isArray(groups) ? groups.filter((group) => group && typeof group === 'object') : []
  const matched = list.find((group) => {
    if (s.groupId && group.id === s.groupId) return true
    return Boolean(shotNumber) && Array.isArray(group.shotNumbers) && group.shotNumbers.includes(shotNumber)
  })
  if (matched) return renderGroupEmotionControl({ groups: [matched], firstEmotion: null })
  if (firstEmotion) return renderGroupEmotionControl({ groups: [], firstEmotion })
  return ''
}

/** 检测文本是否含裸字段罗列形态（供自测/QA 复用）。 */
export function containsBareFieldListing(text) {
  return /(?:^|[\s，,；;。\n])(?:light|ambientSound|poses?|emotion|transitionToNext|lens|subject|groupId)[：:]/i.test(String(text || ''))
}
