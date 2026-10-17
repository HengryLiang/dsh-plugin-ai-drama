/**
 * 确定性检查（P1-D / T10，FR-C07 的确定性部分）
 *
 * 设计约束（PM 冻结口径）：
 *   - 纯函数导出 `runDeterministicChecks(root, opts)`，供内部（drama_export / 导出结果摘要）
 *     与 QA（test/ 独立执行包装）复用；
 *   - **不新增 HTTP route、不新增工具名**（工具数保持 34）；
 *   - 不调用模型、零外部依赖：全部由项目既有数据确定性推导；
 *   - 输出 PASS/FAIL 清单（含 id/label/detail/where），可复跑、可定位。
 *
 * 检查项：
 *   契约时长有效 / 总纲非空 / 人物非空 / 分集非空 / 分集编号连续 /
 *   每集有场次 / 分镜必需字段完整 / 镜号无重复 / 分镜时长不超契约上限 / 说话人已登记。
 */
import * as store from './store.js'

/** 分镜必需字段（field, label）；durationSec 需要为正数，其余需要非空字符串。 */
const REQUIRED_SHOT_FIELDS = [
  ['shotNumber', '镜号'],
  ['shotSize', '景别'],
  ['cameraMove', '运镜'],
  ['description', '画面描述'],
  ['durationSec', '时长'],
]

const NON_DIALOGUE_LABELS = new Set(['动作', '转场', '旁白', '画面', '场景', '音效'])

/** 没有显式 title 时：工作区只有一个短剧则自动选用，否则要求指定（与工具层一致）。 */
async function resolveTitle(root) {
  const projects = await store.listProjects(root)
  if (projects.length === 1) return projects[0].title
  if (!projects.length) throw new Error('当前工作区还没有短剧项目')
  throw new Error(`当前工作区有 ${projects.length} 个短剧，请指定 title`)
}

/**
 * 跑一遍确定性检查。
 * @param {string} root 工作区根
 * @param {{ title?: string }} [options]
 * @returns {Promise<{ok:boolean, title:string, checks:Array, summary:{total:number,passed:number,failed:number}, stats:object, checkedAt:string}>}
 */
export async function runDeterministicChecks(root, options = {}) {
  const title = options.title ? String(options.title) : await resolveTitle(root)
  const dir = store.projectDir(root, title)
  if (!(await store.isDirectory(dir))) throw new Error(`短剧《${title}》不存在`)

  const checks = []
  const add = (id, label, ok, detail, where) => {
    checks.push({ id, label, ok: Boolean(ok), detail: String(detail || ''), where: String(where || '') })
  }

  /* ------------------------------------------------------------ 基础结构 */
  const contract = await store.getContract(root, title)
  const [minDur, maxDur] = Array.isArray(contract.episodeDurationSec) ? contract.episodeDurationSec : [0, 0]
  add(
    'contract-duration',
    '契约单集时长有效',
    Number(minDur) > 0 && Number(maxDur) >= Number(minDur),
    `单集时长 ${Number(minDur) || 0} ~ ${Number(maxDur) || 0} 秒`,
    '剧集契约',
  )

  const outline = await store.getOutline(root, title)
  add('outline-present', '总纲非空', outline.length > 0, `总纲 ${outline.length} 集`, '总纲')

  const characters = await store.getCharacters(root, title)
  add('characters-present', '人物设定非空', characters.length > 0, `人物 ${characters.length} 人`, '人物')

  const episodes = await store.listEpisodes(root, title)
  add('episodes-present', '分集剧本非空', episodes.length > 0, `剧本 ${episodes.length} 集`, '分集剧本')

  const orders = episodes.map((episode) => episode.order).sort((a, b) => a - b)
  const gaps = []
  for (let i = 1; i < orders.length; i += 1) {
    if (orders[i] !== orders[i - 1] + 1) gaps.push(`${orders[i - 1]}→${orders[i]}`)
  }
  add('episode-gap', '分集编号连续', gaps.length === 0, gaps.length ? `缺口：${gaps.join('、')}` : `编号连续（${orders.length} 集）`, '分集剧本')

  /* ------------------------------------------------------- 逐集：场次/分镜 */
  const names = new Set(characters.map((card) => card.name))
  const sceneProblems = []
  const shotFieldProblems = []
  const duplicateProblems = []
  const durationProblems = []
  const unknownSpeakers = new Set()
  let totalScenes = 0
  let totalShots = 0
  let totalChars = 0
  let totalDuration = 0

  for (const episode of episodes) {
    const { text } = await store.readEpisode(root, title, episode.order)
    totalChars += text.length

    const scenes = store.parseScenes(text)
    totalScenes += scenes.length
    if (!scenes.length) sceneProblems.push(`第 ${episode.order} 集`)

    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([\u4e00-\u9fa5A-Za-z0-9_·]{1,12})\s*[：:]\s*\S/)
      if (!match) continue
      const speaker = match[1].trim()
      if (NON_DIALOGUE_LABELS.has(speaker)) continue
      if (!names.has(speaker)) unknownSpeakers.add(`${speaker}（第 ${episode.order} 集）`)
    }

    const shots = await store.getStoryboard(root, title, episode.order)
    totalShots += shots.length

    const numbers = shots.map((shot) => String(shot.shotNumber || '').trim()).filter(Boolean)
    const duplicates = numbers.filter((number, index) => numbers.indexOf(number) !== index)
    if (duplicates.length) duplicateProblems.push(`第 ${episode.order} 集：${[...new Set(duplicates)].join('、')}`)

    for (const shot of shots) {
      const missing = REQUIRED_SHOT_FIELDS.filter(([key]) => {
        if (key === 'durationSec') return !(Number(shot[key]) > 0)
        return !String(shot[key] ?? '').trim()
      }).map(([, label]) => label)
      if (missing.length) shotFieldProblems.push(`第 ${episode.order} 集 ${shot.shotNumber || '?'} 缺 ${missing.join('/')}`)
    }

    const sum = shots.reduce((total, shot) => total + (Number(shot.durationSec) || 0), 0)
    totalDuration += sum
    if (shots.length && Number(maxDur) > 0 && sum > Number(maxDur)) {
      durationProblems.push(`第 ${episode.order} 集 ${sum} 秒 > 上限 ${Number(maxDur)} 秒`)
    }
  }

  add('scene-count', '每集都有场次', sceneProblems.length === 0, sceneProblems.length ? `无场次：${sceneProblems.join('、')}` : `共 ${totalScenes} 场`, '分集剧本')
  add('shot-fields', '分镜必需字段完整', shotFieldProblems.length === 0, shotFieldProblems.slice(0, 6).join('；') || `共 ${totalShots} 镜字段完整`, '分镜')
  add('shot-duplicate', '镜号无重复', duplicateProblems.length === 0, duplicateProblems.join('；') || '镜号无重复', '分镜')
  add('shot-duration', '分镜时长不超契约上限', durationProblems.length === 0, durationProblems.join('；') || `合计 ${totalDuration} 秒`, '分镜')
  add('speaker-known', '说话人已登记在人物卡', unknownSpeakers.size === 0, [...unknownSpeakers].slice(0, 8).join('、') || '全部已登记', '分集剧本')

  const failed = checks.filter((item) => !item.ok)
  return {
    ok: failed.length === 0,
    title,
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    stats: {
      episodes: episodes.length,
      scenes: totalScenes,
      shots: totalShots,
      characters: characters.length,
      outlineCount: outline.length,
      textChars: totalChars,
      durationSec: totalDuration,
    },
    checkedAt: new Date().toISOString(),
  }
}

/** 把检查结果渲染成「PASS/FAIL 清单」文本（qa/技能/CLI 可读）。 */
export function formatCheckReport(report) {
  const lines = [`确定性检查：${report.ok ? 'PASS' : 'FAIL'}（${report.summary.passed}/${report.summary.total} 项通过）`]
  for (const item of report.checks) {
    lines.push(`${item.ok ? 'PASS' : 'FAIL'}  ${item.id}  ${item.label}${item.ok ? '' : ` —— ${item.detail}${item.where ? `（${item.where}）` : ''}`}`)
  }
  return lines.join('\n')
}
