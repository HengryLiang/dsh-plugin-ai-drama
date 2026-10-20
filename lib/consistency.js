/**
 * 一致性检查（FR-C07）：确定性规则，不依赖模型。
 *
 * 覆盖：契约完整性、集数一致性、角色引用、分镜时长、重复桥段、分集缺口。
 * 输出可定位到「集/镜号」的问题清单，供面板一键跳转与 Agent 工具消费。
 */
import * as store from './store.js'

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 }

function issue(severity, code, message, where) {
  return { severity, code, message, where: where || '' }
}

export async function checkConsistency(root, title) {
  const issues = []

  let contract
  let outline
  let characters
  let episodes
  try {
    contract = await store.getContract(root, title)
    outline = await store.getOutline(root, title)
    characters = await store.getCharacters(root, title)
    episodes = await store.listEpisodes(root, title)
  } catch (error) {
    return {
      title,
      issues: [issue('error', 'project-unreadable', error instanceof Error ? error.message : '项目不可读')],
      summary: { error: 1, warn: 0, info: 0, total: 1, warned: 0, skipped: 0 },
      checkedAt: new Date().toISOString(),
    }
  }

  /* ---------------------------------------------------------- 契约完整性 */
  if (!contract.platform) issues.push(issue('warn', 'contract-platform', '剧集契约未填写投放平台', '剧集契约'))
  if (!contract.audience) issues.push(issue('warn', 'contract-audience', '剧集契约未填写目标受众', '剧集契约'))
  if (!contract.hookDensity) issues.push(issue('info', 'contract-hook', '剧集契约未填写钩子密度要求', '剧集契约'))
  const [minDur, maxDur] = contract.episodeDurationSec || [0, 0]
  if (!minDur || !maxDur) issues.push(issue('error', 'contract-duration', '剧集契约的单集时长无效', '剧集契约'))

  /* ------------------------------------------------------------ 集数一致 */
  const outlineOrders = new Set(outline.map((row) => Number(row.order)))
  if (contract.targetEpisodes > 0 && outline.length > 0 && outline.length !== contract.targetEpisodes) {
    issues.push(
      issue(
        'warn',
        'outline-count',
        `总纲 ${outline.length} 集，与契约目标集数 ${contract.targetEpisodes} 不一致`,
        '总纲',
      ),
    )
  }
  for (const episode of episodes) {
    if (!outlineOrders.has(episode.order)) {
      issues.push(issue('warn', 'episode-without-outline', `第 ${episode.order} 集有剧本但总纲中无对应条目`, `分集剧本/第${String(episode.order).padStart(3, '0')}集.md`))
    }
  }
  for (const row of outline) {
    if (!episodes.some((e) => e.order === Number(row.order))) {
      issues.push(issue('info', 'outline-without-episode', `第 ${row.order} 集在总纲中但还没有剧本`, '总纲'))
    }
  }

  /* ------------------------------------------------------------ 人物设定 */
  const nameSet = new Set(characters.map((c) => c.name))
  if (!characters.length) issues.push(issue('warn', 'characters-empty', '还没有任何人物设定卡', '人物'))
  for (const card of characters) {
    if (!card.personality || card.personality.length === 0) {
      issues.push(issue('info', 'character-personality', `角色「${card.name}」未填写性格关键词`, `人物/${card.name}`))
    }
    if (card.role === '主角' && !card.appearancePrompt) {
      issues.push(issue('info', 'character-appearance', `主角「${card.name}」缺少形象提示词，会影响生图一致性`, `人物/${card.name}`))
    }
  }

  /* -------------------------------------------------- 剧本中的角色引用 */
  const referenced = new Map()
  const episodeTexts = new Map()
  for (const episode of episodes) {
    const { text } = await store.readEpisode(root, title, episode.order)
    episodeTexts.set(episode.order, text)
    // 台词行形如「角色：台词」
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([\u4e00-\u9fa5A-Za-z0-9_·]{1,12})\s*[：:]\s*\S/)
      if (!match) continue
      const name = match[1].trim()
      if (!referenced.has(name)) referenced.set(name, new Set())
      referenced.get(name).add(episode.order)
    }
  }
  for (const [name, orders] of referenced) {
    if (!nameSet.has(name)) {
      issues.push(
        issue('warn', 'unknown-speaker', `剧本中出现的说话人「${name}」不在人物设定卡中`, `第 ${[...orders].join('、')} 集`),
      )
    }
  }

  /* ------------------------------------------------------------ 分镜检查 */
  for (const episode of episodes) {
    const shots = await store.getStoryboard(root, title, episode.order)
    if (!shots.length) {
      issues.push(issue('info', 'storyboard-empty', `第 ${episode.order} 集还没有分镜`, `分镜/第${String(episode.order).padStart(3, '0')}集`))
      continue
    }
    const total = shots.reduce((sum, s) => sum + (Number(s.durationSec) || 0), 0)
    if (maxDur && total > maxDur) {
      issues.push(
        issue('warn', 'storyboard-overrun', `第 ${episode.order} 集分镜合计 ${total} 秒，超出契约上限 ${maxDur} 秒`, `分镜/第${String(episode.order).padStart(3, '0')}集`),
      )
    }
    if (minDur && total > 0 && total < minDur) {
      issues.push(
        issue('info', 'storyboard-underrun', `第 ${episode.order} 集分镜合计 ${total} 秒，低于契约下限 ${minDur} 秒`, `分镜/第${String(episode.order).padStart(3, '0')}集`),
      )
    }
    const numbers = shots.map((s) => s.shotNumber)
    const duplicates = numbers.filter((n, i) => numbers.indexOf(n) !== i)
    if (duplicates.length) {
      issues.push(issue('warn', 'shot-duplicate', `第 ${episode.order} 集镜号重复：${[...new Set(duplicates)].join('、')}`, `分镜/第${String(episode.order).padStart(3, '0')}集`))
    }
    for (const shot of shots) {
      if (!shot.description) {
        issues.push(issue('info', 'shot-no-description', `第 ${episode.order} 集 ${shot.shotNumber} 缺少画面描述`, `分镜/${shot.shotNumber}`))
      }
    }
  }

  /* -------------------------------------------------------- 分集序号缺口 */
  if (episodes.length > 1) {
    const orders = episodes.map((e) => e.order).sort((a, b) => a - b)
    for (let i = 1; i < orders.length; i += 1) {
      if (orders[i] !== orders[i - 1] + 1) {
        issues.push(issue('info', 'episode-gap', `分集编号存在缺口：第 ${orders[i - 1]} 集之后是第 ${orders[i]} 集`, '分集剧本'))
      }
    }
  }

  /* ------------------------------------------------------------ 重复桥段 */
  const seenHook = new Map()
  const seenTwist = new Map()
  for (const row of outline) {
    for (const [field, bucket, label] of [['hook', seenHook, '开场钩子'], ['twist', seenTwist, '中段反转']]) {
      const value = String(row[field] || '').trim()
      if (!value) continue
      if (bucket.has(value)) {
        issues.push(
          issue('warn', 'duplicate-beat', `第 ${bucket.get(value)} 集与第 ${row.order} 集的${label}完全相同：「${value.slice(0, 40)}」`, '总纲'),
        )
      } else {
        bucket.set(value, row.order)
      }
    }
  }

  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  const summary = {
    error: issues.filter((i) => i.severity === 'error').length,
    warn: issues.filter((i) => i.severity === 'warn').length,
    info: issues.filter((i) => i.severity === 'info').length,
    total: issues.length,
    // v0.10.2（B1-A）只增字段：与 checks 分级 schema 对齐（warned=warn 别名，skipped 固定 0）
    warned: issues.filter((i) => i.severity === 'warn').length,
    skipped: 0,
  }
  return { title, issues, summary, checkedAt: new Date().toISOString() }
}
