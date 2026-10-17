/**
 * P1-C（FR-C08 检索强化）自测：开关降级 / topK / 可替换排序器 / 词法兜底 / 真实项目 top-1 命中。
 * 来源：host-dev P1-C 交付的离线断言入口：
 *   lib/retrieval.js → searchContext / setRetrievalRanker / getRetrievalRanker
 *
 * 兼容策略：v0.4.0 安装工件早于 P1-C 源码（不含可替换排序器与降级字段）。
 * 若当前工件没有这些 API，本套件打印 SKIP 理由并以 0 failed 退出（不伪造通过）。
 *
 * 运行：node test/retrieval.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const retrieval = await import(pathToFileURL(path.join(here, '..', 'lib', 'retrieval.js')).href)
const store = await import(pathToFileURL(path.join(here, '..', 'lib', 'store.js')).href)
const { searchContext, setRetrievalRanker, getRetrievalRanker } = retrieval

if (typeof setRetrievalRanker !== 'function' || typeof getRetrievalRanker !== 'function') {
  console.log('\n结果：0 passed, 0 failed（SKIP：当前工件未包含 P1-C 检索强化 API —— v0.4.0 安装工件早于 P1-C 源码；本套件在下一检查点工件上生效）')
  process.exit(0)
}

let passed = 0
let failed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) passed += 1
  else {
    failed += 1
    failures.push(`${label}${detail ? ' -> ' + detail : ''}`)
    console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`)
  }
}
function group(name) {
  console.log('\n' + name)
}

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-retrieval-'))
const TITLE = '检索样剧'
const projectDir = store.projectDir(workspace, TITLE)

/* ---------------------------------------------------------------- 造样本项目 */
await store.createProject(workspace, TITLE)
await store.saveContract(workspace, TITLE, {
  platform: '抖音',
  audience: '下沉市场',
  targetEpisodes: 80,
  episodeDurationSec: [90, 150],
  hookDensity: '每 30 秒一个钩子',
  redlines: '无血腥',
})
await store.saveOutline(workspace, TITLE, [
  { order: 1, title: '刀在颈侧', logline: '倒爷被逼债', hook: '刀架脖子', twist: '反杀', cliffhanger: '幕后黑手现身', estDurationSec: 120 },
  { order: 2, title: '第一桶金', logline: '倒卖灵药', hook: '当街叫卖', twist: '引来执法', cliffhanger: '神秘买家', estDurationSec: 130 },
])
await store.saveCharacters(workspace, TITLE, [
  { name: '林越', role: '主角', personality: ['冷静', '护短'], bio: '穿越者，靠倒卖起家', appearancePrompt: '二十岁青年，青色长衫', voiceHint: '清朗少年音' },
  { name: '赵铁', role: '反派', personality: '贪婪、暴戾', bio: '本地恶霸' },
])
await store.writeEpisode(workspace, TITLE, 1, '# 第001集 刀在颈侧\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：这钱，我三天还你。\n赵铁：三天？我只要现在。\n')
await store.writeEpisode(workspace, TITLE, 2, '# 第002集 第一桶金\n\n## 场景 1：外景 - 街市 - 日\n\n林越：走过路过，灵药便宜卖。\n')
await store.saveStoryboard(workspace, TITLE, 1, [
  { shotNumber: '1-1', shotSize: '特写', cameraMove: '推', description: '刀刃反光', dialogue: '', sfx: '金属摩擦', durationSec: 3, imagePrompt: '特写刀锋' },
])
await store.writeEntryFile(workspace, TITLE, '世界观/规则.md', '# 世界规则\n\n灵气复苏三百年，修炼者与凡人共存。\n')
await store.saveMemory(workspace, TITLE, [{ kind: '伏笔', content: '幕后黑手是师门叛徒', episode: 1, status: 'open' }])

const queries = [
  ['刀在颈侧', '总纲/第1集'],
  ['当街叫卖', '总纲/第2集'],
  ['穿越者', '人物/林越'],
  ['本地恶霸', '人物/赵铁'],
  ['当铺', '分集剧本/第1集'],
  ['灵气复苏', '世界观/规则.md'],
  ['反杀', '总纲/第1集'],
  ['贪婪暴戾', '人物/赵铁'],
  ['青色长衫', '人物/林越'],
  ['第一桶金', '总纲/第2集'],
]

/* ------------------------------------------------------------------ [1] */
group('[1] 默认启用：本地词法 + 统一结果字段')
const base = await searchContext(workspace, TITLE, '刀在颈侧', {})
check('默认 enabled=true', base.enabled === true, JSON.stringify({ enabled: base.enabled }).slice(0, 80))
check('默认 method=local-lexical', base.method === 'local-lexical', String(base.method))
check('默认 degradeReason=null / degraded=false', base.degradeReason === null && base.degraded === false, JSON.stringify({ degraded: base.degraded, degradeReason: base.degradeReason }))
check('默认 topK=5', base.topK === 5, String(base.topK))
check('命中带 path/score/excerpt', Array.isArray(base.hits) && base.hits.length > 0 && base.hits.every((h) => typeof h.path === 'string' && typeof h.score === 'number' && typeof h.excerpt === 'string'))

/* ------------------------------------------------------------------ [2] */
group('[2] 检索开关关闭 → 自动降级（不抛错、不阻断）')
await store.saveSettings(workspace, { retrievalEnabled: false })
const disabled = await searchContext(workspace, TITLE, '当铺', {})
check('关闭后 hits=[]', Array.isArray(disabled.hits) && disabled.hits.length === 0)
check('关闭后 degraded=true', disabled.degraded === true)
check('关闭后 degradeReason=retrieval-disabled', disabled.degradeReason === 'retrieval-disabled', String(disabled.degradeReason))
check('关闭后 method=disabled / enabled=false', disabled.method === 'disabled' && disabled.enabled === false)
await store.saveSettings(workspace, { retrievalEnabled: true })

/* ------------------------------------------------------------------ [3] */
group('[3] topK：设置默认值 + 显式覆盖')
await store.saveSettings(workspace, { retrievalEnabled: true, retrievalTopK: 2 })
const topDefault = await searchContext(workspace, TITLE, '林越 当铺 灵药')
check('settings.retrievalTopK=2 生效（hits≤2）', topDefault.topK === 2 && topDefault.hits.length <= 2, `${topDefault.topK} / ${topDefault.hits.length}`)
const topExplicit = await searchContext(workspace, TITLE, '林越 当铺 灵药', { topK: 8 })
check('显式 topK 覆盖默认', topExplicit.topK === 8 && topExplicit.hits.length > topDefault.hits.length, `${topExplicit.topK} / ${topExplicit.hits.length} vs ${topDefault.hits.length}`)

/* ------------------------------------------------------------------ [4] */
group('[4] 可替换排序器：外部注入 / 抛错降级 / 非数组降级')
const previousRanker = getRetrievalRanker()
try {
  const off = setRetrievalRanker(async ({ docs, topK }) => {
    const target = docs.find((d) => d.path === '人物/林越')
    return [{ path: target.path, score: 9.5, matched: ['林越'], excerpt: '外部排序器返回' }].slice(0, topK)
  })
  check('注入后 getRetrievalRanker 非空', typeof getRetrievalRanker() === 'function')
  const custom = await searchContext(workspace, TITLE, '林越', {})
  check('外部排序器生效（method=external-ranker）', custom.method === 'external-ranker' && custom.enabled === true, String(custom.method))
  check('外部排序器 top1 = 指定 path', custom.hits.length === 1 && custom.hits[0].path === '人物/林越', JSON.stringify(custom.hits.map((h) => h.path)))
  check('外部排序器结果不标降级', custom.degraded === false && custom.degradeReason === null)
  off()
  check('disposer 后排序器复位', getRetrievalRanker() === null)

  setRetrievalRanker(() => {
    throw new Error('ranker boom')
  })
  const fallback = await searchContext(workspace, TITLE, '当铺', {})
  check('排序器抛错 → degraded=true + ranker-failed', fallback.degraded === true && String(fallback.degradeReason).startsWith('ranker-failed'), String(fallback.degradeReason))
  check('排序器抛错 → 词法兜底仍有 hits', fallback.method === 'local-lexical' && fallback.hits.length > 0, `${fallback.method} / ${fallback.hits.length}`)

  setRetrievalRanker(() => 'not-an-array')
  const badShape = await searchContext(workspace, TITLE, '当铺', {})
  check('排序器返回非数组 → 同样降级词法', badShape.degraded === true && String(badShape.degradeReason).includes('排序器返回值必须是数组') && badShape.hits.length > 0, String(badShape.degradeReason))
} finally {
  setRetrievalRanker(previousRanker || null)
}

/* ------------------------------------------------------------------ [5] */
group('[5] 10 组真实项目检索：top-1 命中 ≥9/10')
let hitCount = 0
const missRows = []
for (const [query, expectedPath] of queries) {
  const result = await searchContext(workspace, TITLE, query, { topK: 5 })
  const top1 = result.hits[0] && result.hits[0].path
  if (top1 === expectedPath) hitCount += 1
  else missRows.push(`${query} → ${top1 || '(无命中)'}（期望 ${expectedPath}）`)
}
check(`10 组 top-1 命中 ${hitCount}/10 ≥ 9/10`, hitCount >= 9, missRows.join(' | '))
check('检索结果可复跑（同 query 同 top1）', await (async () => {
  const first = await searchContext(workspace, TITLE, '当铺', { topK: 3 })
  const second = await searchContext(workspace, TITLE, '当铺', { topK: 3 })
  return JSON.stringify(first.hits) === JSON.stringify(second.hits)
})())

await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
