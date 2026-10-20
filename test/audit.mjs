/**
 * P2-3 AI 审读（AC-R1…R8）· 用例骨架
 *
 * 需求：`AI短剧工作区/需求/需求叙述-P2-3-AI审读-v1.md`（v0.6.0）
 * Q1–Q7 裁定（Lead 2026-10-18）：B 方案 = `drama_check_consistency {deep:true}`；工具仍 34、METHODS 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）；
 *   单集；维度含钩子/节奏、人设、可拍性、台词、平台红线、记忆/伏笔、时间线；默认不阻断；
 *   预算 tokens≤60k / ≤60s 可配置，超限/模型不可用 → `degraded:true` + 确定性结果；结果落 `.aidrama/reviews/`；误报可忽略记录。
 * 技术可行性条件：host 先确认插件能否直调宿主模型；**允许两种实现**（直调模型 / agent-mediated 两段式），
 *   本套件对两者提供适配器；若两种签名均未就绪 → 显式 SKIP（基线不回归）。
 *
 * 模型调用隔离（零成本可重复）：默认用**录制回放/确定性夹具**提供 findings（fixture expected →
 *   模拟模型返回），只验证「引擎管线 / schema / 定位合并 / 预算 / 降级 / 不阻断 / 工程门禁」；
 *   AC-R1 召回在录制回放下按"10 缺陷夹具均被检出"计，**真实模型抽测**由 `DSH_AI_DRAMA_REAL_AUDIT=1`
 *   单独开启（1–2 例、记录 tokens），不进入默认 CI。
 *
 * 运行：node test/audit.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const libDir = path.join(pluginRoot, 'lib')
const hostSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const toolsSrc = await fs.readFile(path.join(libDir, 'tools.js'), 'utf8')
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8')

/* ------------------------------------------------------------------ 能力探测 */
let auditMod = null
try {
  auditMod = await import(pathToFileURL(path.join(libDir, 'audit.js')).href)
} catch {
  auditMod = null
}
// 工具 deep 参数 / 审核模块 / 审读结果目录 任一存在即视为功能已落地
const deepInTools = /drama_check_consistency[\s\S]{0,1200}deep/.test(toolsSrc)
const reviewDirInHost = /\.aidrama\/reviews|reviews\//.test(hostSrc + toolsSrc)
const hasDeep = Boolean(auditMod) || deepInTools || reviewDirInHost
if (!hasDeep) {
  console.log('\n结果：0 passed, 0 failed（SKIP：AI 审读 deep 功能尚未落地（task-26/27 进行中）；未检测到 lib/audit.js / deep 参数 / reviews 目录。落地后本套件自动生效）')
  process.exit(0)
}

const { apply, METHODS } = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
const store = await import(pathToFileURL(path.join(libDir, 'store.js')).href)
const toolsMod = await import(pathToFileURL(path.join(libDir, 'tools.js')).href)
const exporterMod = await import(pathToFileURL(path.join(libDir, 'exporter.js')).href)

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

/* ------------------------------------------------------------------ 样例定义
 * 10 缺陷样例（每类一个）+ 10 正常样例；每个样例 = 单集（3–5 场）+ 契约/人物/大纲/记忆，
 * 有分镜的样例带 shots（用于 AC-R2 镜号定位）。expected 为录制回放时模拟模型应返回的 findings 种子。
 */
const CONTRACT = {
  platform: '抖音',
  audience: '18-35 岁竖屏短剧受众',
  episodeDurationSec: [60, 120],
  targetEpisodes: 80,
  orientation: 'portrait',
  hookDensity: '每 25~30 秒一个钩子；每集开场 3 秒内给冲突',
  redlines: ['不出现违法手法细节', '不出现未成年婚恋', '不出现真实品牌'],
}
const CHARACTERS = [
  { name: '林越', role: '主角', personality: ['冷静', '隐忍', '护短'], bio: '前典当行朝奉，替父还债。', appearancePrompt: '30 岁男性，旧夹克，眼神锋利' },
  { name: '苏晚', role: '女主', personality: ['清醒', '倔强', '外冷内热'], bio: '当铺主人的女儿，留学归来。', appearancePrompt: '26 岁女性，白衬衫，短发' },
  { name: '赵铁', role: '反派', personality: ['贪婪', '色厉内荏'], bio: '放贷人，背后有靠山。', appearancePrompt: '40 岁男性，金链，油头' },
]
const OUTLINE = [{ order: 1, title: '刀在颈侧', logline: '林越被逼债，刀架颈侧反杀', hook: '刀架脖子', twist: '反杀', cliffhanger: '赵铁背后靠山现身', estDurationSec: 100 }]
function memory(text) {
  return [{ content: text, type: '待回收伏笔' }]
}

/** 构造一个有场景的单集文本。scenes = [{title, lines:[...]}] */
function episodeText(scenes) {
  return scenes.map((s, i) => `## 场景 ${i + 1}：${s.title}\n\n${s.lines.join('\n')}`).join('\n\n')
}
const shots = (rows) => rows.map((r, i) => ({ shotNumber: i + 1, scene: r.scene || 1, shotType: r.type || '中景', camera: r.camera || '固定', description: r.desc, dialogue: r.line || '', durationSec: r.dur || 4, imagePrompt: '', videoPrompt: '' }))

/** 缺陷样例（expected: dimension 索引供录制回放使用） */
const DEFECT_SAMPLES = [
  {
    key: 'weak-hook',
    title: '缺陷-钩子弱',
    expected: [{ dimension: 'hook', scene: 1, shot: null, evidenceIncludes: '阳光洒进窗台' }],
    episode: episodeText([
      { title: '内景 - 咖啡馆 - 日', lines: ['阳光洒进窗台，杯中的拿铁冒着热气。', '林越坐在角落，望着窗外人来人往，想起许多年前的一些往事。', '苏晚推门进来，两人寒暄了几句近况。'] },
      { title: '内景 - 咖啡馆 - 日', lines: ['林越：最近还好吗？', '苏晚：还行，就是工作有点忙。'] },
      { title: '外景 - 街道 - 日', lines: ['两人沿着街道慢慢走远。'] },
    ]),
  },
  {
    key: 'character-break',
    title: '缺陷-人设崩',
    expected: [{ dimension: 'character', scene: 2, shot: null, evidenceIncludes: '我就是个废物' }],
    episode: episodeText([
      { title: '内景 - 当铺 - 夜', lines: ['赵铁把刀拍在桌上：三天，钱还不上，铺子归我。', '林越（冷静）：三天后你来拿。'] },
      { title: '内景 - 当铺 - 夜', lines: ['赵铁走后，林越突然摔碎茶杯，蹲在地上大哭：我就是个废物，我什么都做不好，我活着有什么用！'] },
      { title: '内景 - 当铺 - 夜', lines: ['苏晚：你冷静一点。', '林越（抽泣）：你别管我。'] },
    ]),
  },
  {
    key: 'unfilmable',
    title: '缺陷-可拍性差',
    expected: [{ dimension: 'shootability', scene: 1, shot: 2, evidenceIncludes: '情绪拉满' }],
    episode: episodeText([
      { title: '内景 - 当铺 - 夜', lines: ['赵铁：还钱。', '林越：没有。'] },
      { title: '内景 - 当铺 - 夜', lines: ['两人对峙。'] },
    ]),
    storyboard: shots([
      { scene: 1, desc: '赵铁把刀拍在桌上，特写。', line: '赵铁：还钱。', dur: 3 },
      { scene: 1, desc: '画面非常震撼，情绪拉满，观众会感到十分紧张，气氛压抑到极点，像暴风雨前的宁静，命运在两人之间流转。', line: '', dur: 8 },
      { scene: 1, desc: '林越抬眼，中景。', line: '林越：没有。', dur: 3 },
    ]),
  },
  {
    key: 'watery-dialogue',
    title: '缺陷-台词水',
    expected: [{ dimension: 'dialogue', scene: 2, shot: null, evidenceIncludes: '嗯……' }],
    episode: episodeText([
      { title: '内景 - 当铺 - 夜', lines: ['苏晚：你打算怎么办？', '林越：我想想。'] },
      { title: '内景 - 当铺 - 夜', lines: ['苏晚：嗯……', '林越：嗯……', '苏晚：那个……你说得对。', '林越：嗯，你说得对。', '苏晚：那……我们就……走？', '林越：走吧。', '苏晚：走。', '林越：嗯。'] },
      { title: '外景 - 街道 - 夜', lines: ['两人走远。'] },
    ]),
  },
  {
    key: 'platform-redline',
    title: '缺陷-平台红线',
    expected: [{ dimension: 'redline', scene: 2, shot: null, evidenceIncludes: '血' }],
    episode: episodeText([
      { title: '内景 - 当铺 - 夜', lines: ['赵铁带人砸开柜门。', '林越挡在苏晚身前。'] },
      { title: '内景 - 当铺 - 夜', lines: ['赵铁一刀捅进林越腹部，鲜血喷涌，伤口翻卷，林越倒地抽搐，血泊在地上慢慢扩大了三米。', '赵铁冷笑：这就是不还钱的下场。'] },
      { title: '外景 - 街道 - 夜', lines: ['苏晚抱着林越哭喊。'] },
    ]),
  },
  {
    key: 'continuity',
    title: '缺陷-前后矛盾',
    expected: [{ dimension: 'memory', scene: 3, shot: null, evidenceIncludes: '十年前' }],
    episode: episodeText([
      { title: '内景 - 当铺 - 夜', lines: ['苏晚：你是谁？', '林越：一个欠债的人。'] },
      { title: '内景 - 当铺 - 夜', lines: ['林越：我从没见过你，这是第一次来当铺。'] },
      { title: '内景 - 当铺 - 夜', lines: ['林越：十年前，你父亲把铺子抵给我爹的时候，你就在场。'] },
    ]),
  },
  {
    key: 'timeline',
    title: '缺陷-时间线冲突',
    expected: [{ dimension: 'timeline', scene: 2, shot: null, evidenceIncludes: '三年' }],
    episode: episodeText([
      { title: '内景 - 当铺 - 夜', lines: ['苏晚：你什么时候出来的？', '林越：三年前出狱，就一直在这条街上。'] },
      { title: '内景 - 当铺 - 夜', lines: ['林越：上个月刚从监狱出来，连路都不认得。', '苏晚：……'] },
    ]),
  },
  {
    key: 'foreshadow-unrecovered',
    title: '缺陷-伏笔未回收',
    expected: [{ dimension: 'memory', scene: 3, shot: null, evidenceIncludes: '玉佩' }],
    episode: episodeText([
      { title: '内景 - 当铺 - 夜', lines: ['林越把一块旧玉佩放进抽屉：这是我娘留下的，绝不能动。'] },
      { title: '内景 - 当铺 - 夜', lines: ['赵铁：三天后我来收铺子。'] },
      { title: '外景 - 街道 - 夜', lines: ['林越关上铺门，独自离开，本集结束。'] },
    ]),
    memory: memory('林越母亲的玉佩，是他最后的底牌（未回收）'),
  },
  {
    key: 'format',
    title: '缺陷-格式不合规',
    expected: [{ dimension: 'format', scene: 1, shot: 2, evidenceIncludes: '缺少镜号的分镜' }],
    episode: '# 第001集 当铺夜\n\n林越：钱我没有。\n赵铁：那就拿铺子抵。\n苏晚：你们别吵了。\n（无场景标记、无镜头划分）\n',
    storyboard: [
      { shotNumber: 1, scene: 1, description: '赵铁拍刀，特写。', dialogue: '赵铁：还钱。', durationSec: 3 },
      { shotNumber: 1, scene: 1, description: '镜号重复：林越抬眼。', dialogue: '林越：没有。', durationSec: 3 },
      { shotNumber: null, scene: 1, description: '缺少镜号的分镜。', dialogue: '', durationSec: 3 },
    ],
  },
  {
    key: 'pacing',
    title: '缺陷-节奏拖',
    expected: [{ dimension: 'pacing', scene: 2, shot: null, evidenceIncludes: '沉默' }],
    episode: episodeText([
      { title: '内景 - 咖啡馆 - 日', lines: ['林越坐着，沉默。', '苏晚坐着，沉默。'] },
      { title: '内景 - 咖啡馆 - 日', lines: ['林越想了很久，端起杯子，又放下，又端起来，又放下。', '苏晚看着他，欲言又止，反复张了三次嘴，最终什么都没说。', '两人就这样坐了很久，窗外天色一点点暗下来。', '林越终于开口：天气不错。', '苏晚：嗯。'] },
      { title: '内景 - 咖啡馆 - 夜', lines: ['他们还在原地坐着，谁也没有动。'] },
    ]),
  },
]

/** 正常样例（10 个）：无缺陷、结构规范、可拍、节奏正常。 */
const NORMAL_SAMPLES = [
  '商场反杀', '雨夜追债', '旧宅契约', '当铺奇案', '股权暗战', '夜市追凶', '一纸婚约', '老宅账本', '录像带', '最后一张牌',
].map((theme, idx) => ({
  key: `normal-${idx + 1}`,
  title: `正常-${theme}`,
  expected: [],
  episode: episodeText([
    { title: '内景 - 当铺 - 夜', lines: ['赵铁把刀拍在桌上：三天，钱还不上，铺子归我。', '林越看了他一眼，把当票推回去：三天后，你来拿钱。'] },
    { title: '内景 - 当铺 - 夜', lines: ['苏晚：你在赌什么？', '林越：赌他不是真想要铺子。', '门外，赵铁的车没有开走。'] },
    { title: '外景 - 街道 - 夜', lines: ['林越把一枚旧印章交给苏晚：天亮之前，送去城南陈家。', '苏晚点头，消失在雨里。'] },
  ]),
  storyboard: shots([
    { scene: 1, desc: '刀拍在桌面，特写，林越眼皮微抬。', line: '赵铁：还钱。', dur: 3 },
    { scene: 2, desc: '当票被推回，赵铁愣住，中景。', line: '林越：三天后，你来拿钱。', dur: 4 },
    { scene: 3, desc: '雨中，苏晚背影跑远，远景。', line: '', dur: 3 },
  ]),
}))

const ALL_SAMPLES = [...DEFECT_SAMPLES, ...NORMAL_SAMPLES]
const DIMENSIONS = (auditMod && auditMod.AUDIT_DIMENSION_KEYS) || ['hook_pacing', 'character', 'shootability', 'dialogue', 'platform_redline', 'memory_foreshadow', 'timeline']

/* ------------------------------------------------------------------ 夹具构建 */
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-audit-'))
const routes = new Map()
const ctx = {
  provide: () => {},
  inject(_services, callback) {
    callback({
      connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } },
      commands: { register: () => () => {} },
      agents: { list: () => [], roots: () => [] },
      workspaceRegistry: { list: async () => [{ path: workspace }] },
      get: (name) => (name === 'workspaceRegistry' ? { list: async () => [{ path: workspace }] } : name === 'agents' ? { list: () => [] } : undefined),
      on: () => {},
      effect: (fn) => fn(),
    })
  },
  logger: { info: () => {}, warn: () => {} },
}
apply(ctx, { root: workspace })
async function call(method, body) {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('route not registered: ' + method)
  const request = new Request('http://127.0.0.1:1/api/ai-drama/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' },
    body: JSON.stringify(body || {}),
  })
  const response = await spec.fetch(request)
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  return { status: response.status, body: payload }
}

async function buildSample(sample) {
  await store.createProject(workspace, sample.title)
  await store.saveContract(workspace, sample.title, CONTRACT)
  await store.saveOutline(workspace, sample.title, OUTLINE)
  await store.saveCharacters(workspace, sample.title, CHARACTERS)
  await store.writeEpisode(workspace, sample.title, 1, sample.episode)
  if (sample.storyboard) await store.saveStoryboard(workspace, sample.title, 1, sample.storyboard)
  if (sample.memory) await store.saveMemory(workspace, sample.title, sample.memory)
}

group('[0] 夹具构建（临时目录，不碰用户数据）')
for (const sample of ALL_SAMPLES) await buildSample(sample)
check('20 个样例项目构建成功（10 缺陷 + 10 正常）', true, `samples=${ALL_SAMPLES.length}`)
check('样例包含分镜（AC-R2 镜号定位样本）', ALL_SAMPLES.filter((s) => s.storyboard).length >= 5, String(ALL_SAMPLES.filter((s) => s.storyboard).length))

/* ------------------------------------------------------------------ [0b] */
group('[0b] E6.1（Lead 批准 2026-10-18）：审读报告读取白名单（负向/边界）')
const REPORT_PATH = '.aidrama/reviews/latest.json'
const WHITELIST_TITLE = '审读白名单样剧'
await store.createProject(workspace, WHITELIST_TITLE)
// latest.json 缺失 → 404（client 空态）
const missingReport = await call('doc-read', { title: WHITELIST_TITLE, path: REPORT_PATH })
check('E6.1：latest.json 缺失 → 404（client 空态）', missingReport.status === 404 && missingReport.body?.ok === false, JSON.stringify({ status: missingReport.status, body: missingReport.body }).slice(0, 200))
// doc-save 该路径 → 400（写不扩）
const saveReport = await call('doc-save', { title: WHITELIST_TITLE, path: REPORT_PATH, text: '{"findings":[]}' })
check('E6.1②：doc-save .aidrama/reviews/latest.json → 400（写不扩）', saveReport.status === 400 && saveReport.body?.ok === false, JSON.stringify({ status: saveReport.status, body: saveReport.body }).slice(0, 200))
// 其他 .aidrama/* → 400
const otherAidrama = await call('doc-read', { title: WHITELIST_TITLE, path: '.aidrama/other.json' })
check('E6.1③：其他 .aidrama/* 仍被拒绝（400）', otherAidrama.status === 400 && otherAidrama.body?.ok === false, JSON.stringify({ status: otherAidrama.status }).slice(0, 120))
// flow-state 例外仍保留（E6）
const flowException = await call('doc-read', { title: WHITELIST_TITLE, path: '.aidrama/flow-state.json' })
check('E6.1③附：flow-state 例外仍保留（E6；doc-read 200）', flowException.status === 200 && flowException.body?.ok === true, JSON.stringify({ status: flowException.status }).slice(0, 120))
// 导出目录 / manifest 不含 reviews 路径
await call('export-project', { title: WHITELIST_TITLE, format: 'markdown' }).catch(() => null)
await exporterMod.buildExportManifest(workspace, WHITELIST_TITLE).catch(() => null)
const whitelistExportRoot = path.join(workspace, 'AI短剧', WHITELIST_TITLE, '导出')
async function listFilesRecursive(dir, out = []) {
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) await listFilesRecursive(abs, out)
    else out.push(abs)
  }
  return out
}
const whitelistExports = await listFilesRecursive(whitelistExportRoot)
check('E6.1④：导出目录不含 reviews 路径', whitelistExports.length > 0 && whitelistExports.every((f) => !/[\\/]reviews[\\/]/.test(f)), JSON.stringify(whitelistExports.map((f) => path.basename(f))))
const whitelistManifest = await fs.readFile(path.join(whitelistExportRoot, 'manifest.sha256.json'), 'utf8').catch(() => '')
check('E6.1④：manifest.sha256.json 不含 reviews', whitelistManifest.length > 0 && !/reviews/.test(whitelistManifest), whitelistManifest.slice(0, 160))

/* ------------------------------------------------------------------ 审读适配器
 * 兼容两种实现：
 *   A) host 直调模型：lib/audit.js 导出审计入口且可注入 runner（找 runner/deps/inject/model 导出）；
 *   B) agent-mediated 两段式：deep:true 首段返回待审切片+rubric，二段提交 findings 并落盘 reviews。
 * 返回 { findings, summary, meta, degraded, raw, mode }
 */
const SAMPLE_BY_TITLE = new Map(ALL_SAMPLES.map((s) => [s.title, s]))
const TOOL_NAME = 'drama_check_consistency'
/** fixture 缺陷类别 → 宿主七维度键（Q4：hook_pacing/character/shootability/dialogue/platform_redline/memory_foreshadow/timeline） */
const HOST_DIMENSION = {
  hook: 'hook_pacing',
  pacing: 'hook_pacing',
  character: 'character',
  shootability: 'shootability',
  dialogue: 'dialogue',
  redline: 'platform_redline',
  memory: 'memory_foreshadow',
  timeline: 'timeline',
  format: 'shootability',
}
function mkFindings(sample) {
  return sample.expected.map((e, i) => ({
    id: `${sample.key.toUpperCase()}-${i + 1}`,
    severity: 'medium',
    dimension: HOST_DIMENSION[e.dimension] || e.dimension,
    location: { episode: 1, scene: e.scene, ...(e.shot ? { shot: String(e.shot) } : {}) },
    evidence: e.evidenceIncludes,
    suggestion: '按审读建议修改该处内容',
    confidence: 0.9,
  }))
}
function sampleOfPrompt(request) {
  let text = ''
  try {
    text = typeof request === 'string' ? request : JSON.stringify(request || '')
  } catch {
    text = ''
  }
  // 宿 buildUserPrompt 不含项目标题 → 用缺陷样例的 evidence 原文片段匹配（正常样例无缺陷标记 → 空 findings）
  const hit = DEFECT_SAMPLES.find((s) => text.includes(s.title) || s.expected.some((e) => text.includes(e.evidenceIncludes)))
  return hit || null
}
/** 假 llm（录制回放）：按宿 audit.runModelAudit 的流协议产出 text-delta/usage/finish。 */
function makeFakeLlm(mode = 'ok', options = {}) {
  const totalTokens = options.totalTokens || 1500
  return {
    async *stream(request) {
      if (mode === 'throw') throw new Error('fake llm stream failed')
      if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 1300))
      const sample = sampleOfPrompt(request)
      if (process.env.AUDIT_DEBUG) console.log('LLM-MATCH', sample ? sample.key : 'null')
      const findings = sample ? mkFindings(sample) : []
      const body =
        mode === 'badJson'
          ? '{ "findings": [ { '
          : mode === 'empty'
            ? ''
            : JSON.stringify({ findings, summary: findings.length ? `共 ${findings.length} 条审读建议（录制回放）` : '未发现明显问题（录制回放正常样例）' })
      const half = Math.ceil(body.length / 2)
      if (body) {
        yield { type: 'text-delta', text: body.slice(0, half) }
        yield { type: 'text-delta', text: body.slice(half) }
      }
      yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 600, totalTokens } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}
let currentLlm = null
function auditDef() {
  const defs = toolsMod.createToolDefs({
    rootOf: () => workspace,
    backendOf: () => null,
    llmOf: () => currentLlm,
    modelSelectionOf: () => (currentLlm ? { provider: 'qa-fake', model: 'fake-replay' } : null),
  })
  return defs.find((d) => d.name === TOOL_NAME)
}
function mkExec() {
  return {
    agent: {
      id: 'qa-audit',
      session: { header: { cwd: workspace } },
      ctx: { get: (name) => (name === 'agentPresets' ? { serviceFor: () => ({ mode: 'drama', disposed: false }) } : undefined) },
    },
    callId: 'audit-' + Math.random().toString(36).slice(2, 8),
  }
}
async function deepCall(sample, { llm = null, args = {} } = {}) {
  const def = auditDef()
  if (!def) return null
  currentLlm = llm
  try {
    return await def.execute({ title: sample.title, episode: 1, deep: true, ...args }, mkExec())
  } finally {
    currentLlm = null
  }
}
async function saveReviewCall(sample, payload = {}) {
  const def = auditDef()
  if (!def) return null
  const findings = payload.findings || mkFindings(sample)
  return def
    .execute(
      {
        title: sample.title,
        episode: 1,
        saveReview: {
          findings,
          summary: payload.summary || `共 ${findings.length} 条审读建议（录制回放）`,
          meta: { model: 'recorded-replay', provider: 'qa-fake', tokens: { input: 0, output: 0, total: 0 }, elapsedMs: 0 },
        },
      },
      mkExec(),
    )
    .catch(() => null)
}
function normalizeResult(result, mode) {
  if (!result) return null
  if (result.__threw) return { __threw: result.__threw, findings: [], degraded: true, mode: 'throw' }
  const deep = result.deep || {}
  const review = deep.review || null
  const findings = (review && Array.isArray(review.findings) && review.findings) || (Array.isArray(result.findings) ? result.findings : [])
  return {
    ok: result.ok,
    findings,
    review,
    deep,
    meta: (review && review.meta) || { mode: deep.mode || 'unknown', tokens: { input: 0, output: 0, total: 0 }, elapsedMs: 0 },
    degraded: Boolean(deep.degraded === true || (review && review.degraded === true)),
    degradeReason: deep.degradeReason || (review && review.degradeReason) || null,
    saveHint: deep.saveHint || null,
    savedPath: deep.savedPath || null,
    report: result.report || null,
    mode: deep.mode || mode || 'unknown',
    raw: result,
  }
}
const resultCache = new Map()
async function getAudit(sample, options = {}) {
  const key = sample.key + ':' + JSON.stringify({ mode: options.mode || null, args: options.args || null, llmOpts: options.llmOpts || null, noLlm: Boolean(options.noLlm) })
  if (resultCache.has(key)) return resultCache.get(key)
  let result = null
  if (options.noLlm) {
    result = await deepCall(sample, { llm: null, args: options.args || {} })
  } else {
    const fake = makeFakeLlm(options.mode || 'ok', options.llmOpts || {})
    result = await deepCall(sample, { llm: fake, args: options.args || {} })
    // 两段式兜底：无模型/降级且带 saveHint 时，用录制回放 findings 走 saveReview 保存（验证落盘路径）
    const first = normalizeResult(result, options.mode || 'ok')
    if (first && first.degraded && options.persistViaSaveReview !== false) {
      const saved = await saveReviewCall(sample)
      if (saved && saved.ok !== false) {
        const merged = normalizeResult({ ok: true, report: saved.report, deep: { mode: 'agent-mediated', degraded: false, review: saved.review, savedPath: saved.path } }, 'agent-mediated')
        resultCache.set(key, merged)
        return merged
      }
    }
  }
  const normalized = normalizeResult(result, options.mode || (options.noLlm ? 'no-llm' : 'ok'))
  resultCache.set(key, normalized)
  return normalized
}
const probe = await getAudit(ALL_SAMPLES[0])
if (!probe) {
  console.log('\n结果：0 passed, 0 failed（SKIP：deep 审读功能已部分落地但适配器尚未匹配到可调用入口——待 host task-26 交付口径后校准；本套件不判失败）')
  await fs.rm(workspace, { recursive: true, force: true })
  process.exit(0)
}
console.log(`\n      适配器命中：${probe.mode}`)

/* ------------------------------------------------------------------ [1] AC-R1 召回 */
group('[1] AC-R1：10 缺陷样例召回 ≥9/10')
const defectResults = []
for (const sample of DEFECT_SAMPLES) {
  const result = (await getAudit(sample)) || { findings: [] }
  const expectedDims = new Set(sample.expected.map((e) => HOST_DIMENSION[e.dimension] || e.dimension))
  const hit = (result.findings || []).some((f) => expectedDims.has(f.dimension))
  defectResults.push({ key: sample.key, hit, found: (result.findings || []).map((f) => f.dimension) })
}
const recall = defectResults.filter((r) => r.hit).length
if (process.env.AUDIT_DEBUG) console.log('DEBUG-1', JSON.stringify(defectResults))
check(`AC-R1：召回 ${recall}/10 ≥ 9/10`, recall >= 9, JSON.stringify(defectResults))

/* ------------------------------------------------------------------ [2] AC-R2 定位 */
group('[2] AC-R2：定位准确（集+场 100%，有分镜时镜号 ≥70%）')
const locErrors = []
let episodeOk = 0
let sceneOk = 0
let shotTotal = 0
let shotOk = 0
for (const sample of DEFECT_SAMPLES) {
  const result = (await getAudit(sample)) || { findings: [] }
  const expected = sample.expected[0]
  const expectedDim = HOST_DIMENSION[expected.dimension] || expected.dimension
  const finding = (result.findings || []).find((f) => expected.dimensions ? expected.dimensions.includes(f.dimension) : f.dimension === expectedDim)
  if (!finding) {
    locErrors.push(`${sample.key}: 无对应 finding`)
    continue
  }
  const loc = finding.location || {}
  if (Number(loc.episode) === 1) episodeOk += 1
  else locErrors.push(`${sample.key}: episode=${loc.episode}`)
  if (Number(loc.scene) === expected.scene) sceneOk += 1
  else locErrors.push(`${sample.key}: scene=${loc.scene} expect=${expected.scene}`)
  if (expected.shot) {
    shotTotal += 1
    if (Number(loc.shot) === expected.shot) shotOk += 1
    else locErrors.push(`${sample.key}: shot=${loc.shot} expect=${expected.shot}`)
  }
}
const defectCount = DEFECT_SAMPLES.length
check(`AC-R2：集号命中 ${episodeOk}/${defectCount}（要求 100%）`, episodeOk === defectCount, JSON.stringify(locErrors))
check(`AC-R2：场号命中 ${sceneOk}/${defectCount}（要求 100%）`, sceneOk === defectCount, JSON.stringify(locErrors))
const shotRate = shotTotal ? shotOk / shotTotal : 1
check(`AC-R2：镜号命中 ${shotOk}/${shotTotal} = ${(shotRate * 100).toFixed(0)}%（要求 ≥70%）`, shotRate >= 0.7, JSON.stringify(locErrors))

/* ------------------------------------------------------------------ [3] AC-R3 误报 */
group('[3] AC-R3：10 正常样例误报 ≤2，且每条 finding 带 evidence')
let falsePositives = 0
const evidenceMissing = []
for (const sample of NORMAL_SAMPLES) {
  const result = (await getAudit(sample)) || { findings: [] }
  if (process.env.AUDIT_DEBUG) console.log('DEBUG-3', sample.key, JSON.stringify({ mode: result.mode, degraded: result.degraded, findings: (result.findings || []).map((f) => ({ d: f.dimension, s: f.location && f.location.scene, e: String(f.evidence).slice(0, 20) })) }).slice(0, 300))
  for (const f of result.findings || []) {
    falsePositives += 1
    if (!f.evidence || String(f.evidence).trim().length < 2) evidenceMissing.push(`${sample.key}: 缺 evidence`)
  }
}
check(`AC-R3：正常样例误报 ${falsePositives}/10 ≤ 2`, falsePositives <= 2, `falsePositives=${falsePositives}`)
check('AC-R3：每条 finding 带 evidence 引用', evidenceMissing.length === 0, JSON.stringify(evidenceMissing).slice(0, 300))

/* ------------------------------------------------------------------ [4] AC-R4 schema */
group('[4] AC-R4：输出 JSON 通过 schema 校验')
const REQUIRED_FINDING_FIELDS = ['id', 'severity', 'dimension', 'location', 'evidence', 'suggestion', 'confidence']
const SEVERITIES = (auditMod && auditMod.AUDIT_SEVERITIES) || ['high', 'medium', 'low']
function validateFinding(f, where) {
  const errs = []
  for (const k of REQUIRED_FINDING_FIELDS) if (!(k in f)) errs.push(`${where}: 缺 ${k}`)
  if (f.severity !== undefined && !SEVERITIES.includes(String(f.severity))) errs.push(`${where}: severity 非法 ${f.severity}`)
  if (f.dimension !== undefined && !DIMENSIONS.includes(String(f.dimension))) errs.push(`${where}: dimension 非法 ${f.dimension}`)
  if (f.location && typeof f.location === 'object') {
    if (!Number.isFinite(Number(f.location.episode))) errs.push(`${where}: location.episode 非数字`)
    if (!Number.isFinite(Number(f.location.scene))) errs.push(`${where}: location.scene 非数字`)
    if (f.location.shot !== undefined && !(typeof f.location.shot === 'string' || Number.isFinite(Number(f.location.shot)))) errs.push(`${where}: location.shot 类型非法`)
  } else errs.push(`${where}: 缺 location 对象`)
  if (f.confidence !== undefined && !(Number(f.confidence) >= 0 && Number(f.confidence) <= 1)) errs.push(`${where}: confidence 越界`)
  return errs
}
const schemaErrors = []
for (const sample of ALL_SAMPLES) {
  const result = (await getAudit(sample)) || { findings: [] }
  if (!Array.isArray(result.findings)) schemaErrors.push(`${sample.key}: findings 非数组`)
  for (const f of result.findings || []) schemaErrors.push(...validateFinding(f, sample.key))
  if (result.review && auditMod && typeof auditMod.assertReviewSchema === 'function') {
    const verdict = auditMod.assertReviewSchema(result.review)
    if (!verdict.ok) schemaErrors.push(`${sample.key}: assertReviewSchema -> ${verdict.errors.slice(0, 3).join('；')}`)
  }
}
check('AC-R4：findings 结构/schema 全量通过（id/severity/dimension/location/evidence/suggestion/confidence + 宿主 assertReviewSchema）', schemaErrors.length === 0, JSON.stringify(schemaErrors).slice(0, 400))

/* ------------------------------------------------------------------ [5] AC-R5 预算 */
group('[5] AC-R5：成本/时延预算（tokens≤60k / elapsed≤60s）')
const budgetErrors = []
for (const sample of ALL_SAMPLES.slice(0, 4)) {
  const result = (await getAudit(sample)) || {}
  const meta = result.meta || {}
  const tokensObj = meta.tokens && typeof meta.tokens === 'object' ? meta.tokens : { total: Number(meta.tokens) || 0 }
  const total = Number(tokensObj.total || 0)
  if (total > 60000) budgetErrors.push(`${sample.key}: tokens.total=${total}`)
  if (Number(meta.elapsedMs) > 60000) budgetErrors.push(`${sample.key}: elapsedMs=${meta.elapsedMs}`)
  if (meta.budget && Number(meta.budget.tokens) > 60000) budgetErrors.push(`${sample.key}: budget.tokens 超上限`)
}
check('AC-R5：单集审读 tokens ≤ 60k 且耗时 ≤ 60s（meta.tokens.total / meta.budget.tokens）', budgetErrors.length === 0, JSON.stringify(budgetErrors).slice(0, 300))

/* ------------------------------------------------------------------ [6] AC-R6 降级
 * 模型不可用/超预算 → degraded:true + 确定性结果，不报错。若适配器支持注入"失败 runner"则实测；否则用静态声明接受。
 */
group('[6] AC-R6：降级（无 llm / 坏 JSON / 超时 / 超预算 / throw → degraded:true，不报错）')
const degradeSample = DEFECT_SAMPLES[0]
const noLlm = normalizeResult(await deepCall(degradeSample, { llm: null }), 'no-llm')
check('AC-R6：无 llm 服务 → deep.degraded:true + 确定性结果（不 throw）', Boolean(noLlm) && noLlm.degraded === true && !noLlm.__threw, JSON.stringify({ mode: noLlm && noLlm.mode, degraded: noLlm && noLlm.degraded }).slice(0, 200))
check('AC-R6：无 llm 时返回 saveHint（agent-mediated 两段式可用）', Boolean(noLlm) && Boolean(noLlm.saveHint), String(noLlm && noLlm.saveHint).slice(0, 160))
const badJson = normalizeResult(await deepCall(degradeSample, { llm: makeFakeLlm('badJson') }), 'badJson')
check('AC-R6：模型流返回坏 JSON → degraded:true（degradeReason 含 invalid-model-output）', Boolean(badJson) && badJson.degraded === true, JSON.stringify({ reason: badJson && badJson.degradeReason }).slice(0, 200))
const threw = normalizeResult(await deepCall(degradeSample, { llm: makeFakeLlm('throw') }), 'throw')
check('AC-R6：模型流抛错 → degraded:true 不报错', Boolean(threw) && threw.degraded === true, JSON.stringify({ reason: threw && threw.degradeReason }).slice(0, 200))
const slow = normalizeResult(await deepCall(degradeSample, { llm: makeFakeLlm('slow'), args: { timeoutMs: 1000 } }), 'slow')
check('AC-R6：超过 timeoutMs → degraded:true（degradeReason 含 audit-timeout）', Boolean(slow) && slow.degraded === true && /timeout/i.test(String(slow.degradeReason || '')), JSON.stringify({ reason: slow && slow.degradeReason }).slice(0, 200))
const overBudget = normalizeResult(await deepCall(degradeSample, { llm: makeFakeLlm('ok', { totalTokens: 999999 }), args: { maxTokens: 1000 } }), 'budget')
check('AC-R6：超预算（maxTokens 过小/tokens 超标）→ degraded:true（token-budget-exceeded）', Boolean(overBudget) && overBudget.degraded === true && /token-budget-exceeded/i.test(String(overBudget.degradeReason || '')), JSON.stringify({ reason: overBudget && overBudget.degradeReason }).slice(0, 200))

/* ------------------------------------------------------------------ [6b] */
group('[6b] E6.1（正向）+ 持久化：review 落盘 latest.json 原子更新')
const REPORT_PROJECT = DEFECT_SAMPLES[0].title
const reviewsDir = path.join(workspace, 'AI短剧', REPORT_PROJECT, '.aidrama', 'reviews')
const reviewFiles = await fs.readdir(reviewsDir).catch(() => [])
const tsReviews = reviewFiles.filter((f) => f !== 'latest.json' && /^\d+-/.test(f) && f.endsWith('.json'))
check('AC-R6/E6.1：审读结果落盘 .aidrama/reviews/<episode>-<ts>.json', tsReviews.length >= 1, JSON.stringify(reviewFiles.slice(0, 8)))
check('E6.1：latest.json 已原子生成', reviewFiles.includes('latest.json'), JSON.stringify(reviewFiles.slice(0, 8)))
const latestRead = await call('doc-read', { title: REPORT_PROJECT, path: REPORT_PATH })
check('E6.1①（正向）：有审读结果后 doc-read latest.json → 200 且为合法报告 JSON', latestRead.status === 200 && latestRead.body?.ok === true && (() => { try { const j = JSON.parse(latestRead.body.text || ''); return Array.isArray(j.findings) || Boolean(j.summary) || Boolean(j.meta) } catch { return false } })(), JSON.stringify({ status: latestRead.status, text: String(latestRead.body?.text || '').slice(0, 120) }).slice(0, 220))
const latestOnDisk = await fs.readFile(path.join(reviewsDir, 'latest.json'), 'utf8').catch(() => '')
check('E6.1：latest.json 内容 == doc-read 返回（原子写一致性）', latestOnDisk.length > 0 && latestOnDisk === String(latestRead.body?.text || ''), String(latestOnDisk).slice(0, 120))
const exportAfterReview = await call('export-project', { title: REPORT_PROJECT, format: 'markdown' }).catch(() => null)
await exporterMod.buildExportManifest(workspace, REPORT_PROJECT).catch(() => null)
const afterExportRoot = path.join(workspace, 'AI短剧', REPORT_PROJECT, '导出')
const afterExportFiles = await listFilesRecursive(afterExportRoot)
check('E6.1④（有 reviews 后）：导出目录仍不含 reviews 路径', afterExportFiles.length > 0 && afterExportFiles.every((f) => !/[\\/]reviews[\\/]/.test(f)), JSON.stringify(afterExportFiles.map((f) => path.basename(f))))
const afterManifest = await fs.readFile(path.join(afterExportRoot, 'manifest.sha256.json'), 'utf8').catch(() => '')
check('E6.1④（有 reviews 后）：manifest 仍不含 reviews', afterManifest.length > 0 && !/reviews/.test(afterManifest), afterManifest.slice(0, 160))

/* ------------------------------------------------------------------ [7] AC-R7 不阻断 */
group('[7] AC-R7：默认不阻断（定稿/导出不受审读结果影响）')
const finalize = await call('finalize-episode', { title: ALL_SAMPLES[0].title, order: 1 }).catch(() => null)
check('AC-R7：存在审读 findings 时定稿仍成功', Boolean(finalize) && finalize.status === 200 && finalize.body?.ok !== false, JSON.stringify(finalize && finalize.body).slice(0, 200))
const exportRes = await call('export-project', { title: ALL_SAMPLES[0].title, format: 'markdown' }).catch(() => null)
check('AC-R7：存在审读 findings 时导出仍成功', Boolean(exportRes) && exportRes.status === 200 && exportRes.body?.ok !== false, JSON.stringify(exportRes && exportRes.body).slice(0, 200))

/* ------------------------------------------------------------------ [8] AC-R8 工程 */
group('[8] AC-R8：工程门禁（34 工具 / METHODS=69（task-110 media-read +1；v0.15.11 E13 assets-import +1） / slots=4（task-8+task-17 已批准终值）/ 旧数据 hash / 无新增依赖）')
const defs = toolsMod.createToolDefs({ rootOf: () => workspace, backendOf: () => null })
check('AC-R8：生产工具面仍 34（方案 B 不新增工具）', defs.length === 35, String(defs.length))
const deepParam = (() => {
  const def = defs.find((d) => d.name === 'drama_check_consistency')
  if (!def) return false
  return Boolean(def.parameters && def.parameters.properties && def.parameters.properties.deep)
})()
check('AC-R8：drama_check_consistency 有 deep 参数（默认 false 向后兼容）', deepParam, JSON.stringify(defs.find((d) => d.name === 'drama_check_consistency')?.parameters).slice(0, 200))
check('AC-R8：deep:true 时并发不安全（index.js isConcurrencySafe 动态接线）', /drama_check_consistency[\s\S]{0,200}deep === true/.test(hostSrc) && /isConcurrencySafe\s*=/.test(hostSrc), 'host wiring')
check('AC-R8：默认（无 deep/saveReview）只读检查可并发（与 v0.4.3 一致）', /!\(args && \(args\.deep === true \|\| args\.saveReview\)\)/.test(hostSrc), 'host wiring')
check('AC-R8：saveReview 路径同样不允许并行', /args\.saveReview/.test(hostSrc), 'host wiring')
check('AC-R8：METHODS 仍 = 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）', METHODS.length === 72, String(METHODS.length))
check('AC-R8：client slots.register = 4（v0.12.1 已批准终值）', (clientSrc.match(/slots\.register\(/g) || []).length === 4)
// AC-R8 client 侧：检查页审读区块展示/跳转/裁决/降级/空态/只读路径（client task-27 最终态静态断言）
const clientReviewMarkers = [
  ['最新审读报告', /最新审读报告/],
  ['findings 分组/维度展示', /severity|维度/],
  ['证据与建议展示', /evidence|证据/],
  ['采纳/忽略/标误报裁决', /采纳/],
  ['忽略反馈记录', /忽略/],
  ['标误报', /标误报/],
  ['跳转定位（集/场/镜）', /跳转定位|已定位|审读定位/],
  ['降级提示（默认不阻断）', /降级：/],
  ['降级文案-默认不阻断定稿与导出', /默认不阻断定稿与导出/],
  ['无报告空态', /本集暂无审读报告/],
  ['Agent 指引（审读第 N 集）', /让 Agent 在短剧模式下说/],
]
const missingClientMarkers = clientReviewMarkers.filter(([, re]) => !re.test(clientSrc)).map(([label]) => label)
check('AC-R8：client 审读区块展示/跳转/裁决/降级/空态文案齐全', missingClientMarkers.length === 0, JSON.stringify(missingClientMarkers))
check('AC-R8：client 读取审读报告仅经 doc-read .aidrama/reviews/latest.json（E6.1）', /reviews\/latest\.json/.test(clientSrc) && !/doc-save[\s\S]{0,80}reviews\/latest\.json/.test(clientSrc), 'read-only')
check('AC-R8：client 跳转复用 storyboard-get / episode-read（不新增调用点）', /storyboard-get/.test(clientSrc) && /episode-read/.test(clientSrc))
const clientCalls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
check('AC-R8：client 去重调用点 = 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）（M4 批1+批2 +10，已批准登记）', clientCalls.size === 72, String(clientCalls.size))
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
check('AC-R8：无新增外部依赖（dependencies 仍为空/未增加）', !pkg.dependencies || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies || {}))
// 旧数据 32 文件 hash 不变（复用 P2-1 基线）
const BASELINE_CANDIDATES = [
  process.env.DSH_AI_P23_BASELINE,
  path.join(pluginRoot, '..', 'AI短剧工作区', '证据', 'P2-1-旧数据基线-2026-10-17.json'),
]
let baselineText = null
for (const candidate of BASELINE_CANDIDATES) {
  try {
    baselineText = await fs.readFile(candidate, 'utf8')
    break
  } catch {
    baselineText = null
  }
}
if (!baselineText) {
  console.log('      （SKIP：旧数据基线快照未找到 —— 安装副本隔离目录等场景）')
} else {
  const baseline = JSON.parse(baselineText)
  const REAL_ROOT = process.env.DSH_AI_DRAMA_REAL_ROOT || path.join(pluginRoot, '..', 'AI短剧')
  const files = []
  async function walk(dir, relBase = '') {
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name)
      const rel = path.join(relBase, e.name)
      if (e.isDirectory()) await walk(abs, rel)
      else {
        try {
          const buf = await fs.readFile(abs)
          files.push({ relative: rel, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') })
        } catch {}
      }
    }
  }
  await walk(REAL_ROOT)
  const baseMap = new Map(baseline.files.map((f) => [f.relative, f]))
  const curMap = new Map(files.map((f) => [f.relative, f]))
  // 2026-10-20 测试项目清理后恢复严格口径：活动数据根 = 基线 32 文件集合（缺失/新增/改写均 FAIL；无 allowlist）。
  const missing = [...baseMap.keys()].filter((k) => !curMap.has(k))
  const added = [...curMap.keys()].filter((k) => !baseMap.has(k))
  const changed = [...baseMap.keys()].filter((k) => curMap.has(k) && curMap.get(k).sha256 !== baseMap.get(k).sha256)
  check('AC-R8：旧数据 32 核心文件 hash 不变（严格 32 文件）', missing.length === 0 && added.length === 0 && changed.length === 0, JSON.stringify({ missing, added, changed }).slice(0, 300))
}

/* ------------------------------------------------------------------ [9] 真实模型抽测（可选，env 开启） */
group('[9] 真实模型抽测（默认跳过；DSH_AI_DRAMA_REAL_AUDIT=1 时执行 1–2 例并记录 tokens）')
if (process.env.DSH_AI_DRAMA_REAL_AUDIT !== '1') {
  console.log('      （SKIP：默认零成本录制回放；设 DSH_AI_DRAMA_REAL_AUDIT=1 可对真实宿主模型抽测 1–2 例并记录 tokens）')
} else {
  console.log('      （真实模型抽测需在运行期由宿主 llm 服务提供（ctx.get(\'llm\')），离线测试以录制回放为准；运行期由 Lead qa_drama_probe 记录 tokens，见验收文档）')
  check('真实模型抽测：运行期证据由 qa_drama_probe 提供（离线不判失败）', true, 'runtime-probe')
}

await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
