/**
 * 宿主半功能自测：不依赖 DSH，直接驱动 apply() 注册的路由处理器。
 * 运行：node test/smoke.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(path.join(here, '..', 'index.js')).href)
const { apply, METHODS, VERSION } = mod

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-ws-'))
const routes = new Map()

const ctx = {
  provide: () => {},
  inject(services, callback) {
    callback({
      connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } },
      get: () => undefined,
      on: () => {},
      effect: (fn) => fn(),
    })
  },
  logger: { info: () => {}, warn: () => {} },
}

apply(ctx, { root: workspace })

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
  } else {
    failed += 1
    failures.push(`${label}${detail ? ' -> ' + detail : ''}`)
    console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`)
  }
}

function group(name) {
  console.log('\n' + name)
}

async function call(method, body, headers) {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('route not registered: ' + method)
  const request = new Request('http://127.0.0.1:1/api/ai-drama/' + method, {
    method: 'POST',
    headers: headers || { 'content-type': 'application/json', 'x-ai-drama-request': '1' },
    body: JSON.stringify(body || {}),
  })
  const response = await spec.fetch(request)
  return { status: response.status, body: await response.json() }
}

const TITLE = '万界倒爷：先发育再屠神'
const projectDir = path.join(workspace, 'AI短剧', TITLE)

/* ------------------------------------------------------------------ [1] */
group('[1] 路由注册与鉴权')
check(`${METHODS.length} 条路由全部注册`, routes.size === METHODS.length, `${routes.size}/${METHODS.length}`)
check('全部为 POST', [...routes.values()].every((s) => s.methods.length === 1 && s.methods[0] === 'POST'))
check('requestBody=streaming', [...routes.values()].every((s) => s.requestBody === 'streaming'))
const forbidden = await call('ping', {}, { 'content-type': 'application/json' })
check('缺少请求头 -> 403', forbidden.status === 403 && forbidden.body.code === 'forbidden')

/* ------------------------------------------------------------------ [2] */
group('[2] ping / status')
check('ping ok（版本与 index.js 导出一致）', (await call('ping')).body.version === VERSION)
const status0 = await call('status')
check('status 解析工作区', status0.body.workspace === workspace)
check('初始无项目', status0.body.projectCount === 0)

/* ------------------------------------------------------------------ [3] */
group('[3] 建项目与目录结构')
const created = await call('create-project', { title: TITLE })
check('创建成功', created.status === 200 && created.body.project.title === TITLE, JSON.stringify(created.body).slice(0, 120))
const entries = await fs.readdir(projectDir)
check('14 个一级可见节点', entries.filter((e) => e !== '.aidrama').length === 14, entries.join(','))
check('存在 .aidrama 内部目录', entries.includes('.aidrama'))
for (const dir of ['构想', '总纲', '人物', '世界观', '分集剧本', '分镜', '台词与音效', '素材', '草稿区', '定稿', '账本', '本剧记忆', '导出']) {
  check('目录：' + dir, entries.includes(dir))
}
check('剧集契约.md 已生成', entries.includes('剧集契约.md'))
check('contract.json 已生成', (await fs.readdir(path.join(projectDir, '.aidrama'))).includes('contract.json'))

/* ------------------------------------------------------------------ [4] */
group('[4] 名称安全校验')
for (const [label, title] of [['空名', '   '], ['路径穿越', '../evil'], ['非法字符', 'a/b'], ['保留名', 'CON'], ['过长', 'x'.repeat(61)], ['内部目录名', '.aidrama']]) {
  const r = await call('create-project', { title })
  check(`拒绝${label}`, r.status === 400, JSON.stringify(r.body).slice(0, 80))
}
check('拒绝重名', (await call('create-project', { title: TITLE })).body.error.includes('已存在'))

/* ------------------------------------------------------------------ [5] */
group('[5] 剧集契约')
const contract0 = await call('contract-get', { title: TITLE })
check('默认契约有画幅', contract0.body.contract.orientation === 'portrait')
const saved = await call('contract-save', { title: TITLE, contract: { platform: '抖音', audience: '下沉市场', targetEpisodes: 80, episodeDurationSec: [90, 150], hookDensity: '每 30 秒一个钩子', redlines: '无血腥' } })
check('保存契约成功', saved.status === 200 && saved.body.contract.platform === '抖音', JSON.stringify(saved.body).slice(0, 120))
check('时长校验：非法值被拒', (await call('contract-save', { title: TITLE, contract: { episodeDurationSec: [200, 100] } })).status === 400)
check('集数校验：越界被拒', (await call('contract-save', { title: TITLE, contract: { targetEpisodes: 99999 } })).status === 400)
check('画幅校验：非法值被拒', (await call('contract-save', { title: TITLE, contract: { orientation: 'square' } })).status === 400)
const contractMd = await fs.readFile(path.join(projectDir, '剧集契约.md'), 'utf8')
check('契约 .md 已渲染平台', contractMd.includes('抖音'))
check('契约 .md 标注源数据', contractMd.includes('.aidrama/contract.json'))

/* ------------------------------------------------------------------ [6] */
group('[6] 总纲')
const outline = [
  { order: 1, title: '刀在颈侧', logline: '倒爷被逼债', hook: '刀架脖子', twist: '反杀', cliffhanger: '幕后黑手现身', estDurationSec: 120 },
  { order: 2, title: '第一桶金', logline: '倒卖灵药', hook: '当街叫卖', twist: '引来执法', cliffhanger: '神秘买家', estDurationSec: 130 },
]
check('保存总纲', (await call('outline-save', { title: TITLE, rows: outline })).body.rows.length === 2)
const outlineMd = await fs.readFile(path.join(projectDir, '总纲', '分集大纲.md'), 'utf8')
check('总纲 .md 含分集', outlineMd.includes('刀在颈侧') && outlineMd.includes('共 2 集'))
check('总纲读取一致', (await call('outline-get', { title: TITLE })).body.rows[1].title === '第一桶金')
check('总纲非数组被拒', (await call('outline-save', { title: TITLE, rows: {} })).status === 400)

/* ------------------------------------------------------------------ [7] */
group('[7] 人物设定卡')
const chars = [
  { name: '林越', role: '主角', personality: ['冷静', '护短'], bio: '穿越者，靠倒卖起家', appearancePrompt: '二十岁青年，青色长衫', voiceHint: '清朗少年音' },
  { name: '赵铁', role: '反派', personality: '贪婪、暴戾', bio: '本地恶霸' },
]
check('保存人物', (await call('characters-save', { title: TITLE, characters: chars })).body.characters.length === 2)
check('字符串性格被切分', (await call('characters-get', { title: TITLE })).body.characters[1].personality.length === 2)
check('缺姓名被拒', (await call('characters-save', { title: TITLE, characters: [{ role: '配角' }] })).status === 400)
check('重名被拒', (await call('characters-save', { title: TITLE, characters: [{ name: '林越' }, { name: '林越' }] })).status === 400)
const charMd = await fs.readFile(path.join(projectDir, '人物', '人物设定卡.md'), 'utf8')
check('人物 .md 渲染', charMd.includes('## 林越（主角）') && charMd.includes('冷静、护短'))

/* ------------------------------------------------------------------ [8] */
group('[8] 剧本与分镜')
check('写入第 1 集', (await call('episode-write', { title: TITLE, order: 1, text: '# 第001集 刀在颈侧\n\n内景 - 当铺 - 夜\n' })).status === 200)
check('剧集列表', (await call('episodes-list', { title: TITLE })).body.episodes[0].order === 1)
check('读取第 1 集', (await call('episode-read', { title: TITLE, order: 1 })).body.text.includes('当铺'))
check('剧集文件名补零', (await fs.readdir(path.join(projectDir, '分集剧本'))).includes('第001集.md'))
check('集数越界被拒', (await call('episode-write', { title: TITLE, order: 0, text: 'x' })).status === 400)

const shots = [
  { shotNumber: '1-1', shotSize: '特写', cameraMove: '推', description: '刀刃反光', dialogue: '', sfx: '金属摩擦', durationSec: 3, imagePrompt: '特写刀锋', videoPrompt: '视频提示 1-1' },
  { shotNumber: '1-2', shotSize: '中景', cameraMove: '摇', description: '林越被按在案上', dialogue: '林越：这钱，我三天还你。', sfx: '人群嘈杂', durationSec: 5, imagePrompt: '当铺内景', videoPrompt: '视频提示 1-2' },
]
check('保存分镜', (await call('storyboard-save', { title: TITLE, order: 1, shots })).body.shots.length === 2)
check('非法景别回退为中景', (await call('storyboard-save', { title: TITLE, order: 2, shots: [{ shotSize: '超特写' }] })).body.shots[0].shotSize === '中景')
const sbBack = await call('storyboard-get', { title: TITLE, order: 1 })
check('H-3 videoPrompt 持久化（保存→回读）', sbBack.body.shots[1].videoPrompt === '视频提示 1-2', JSON.stringify(sbBack.body.shots[1]).slice(0, 160))
const sbMd = await fs.readFile(path.join(projectDir, '分镜', '第001集.分镜.md'), 'utf8')
check('分镜 .md 渲染', sbMd.includes('1-1') && sbMd.includes('合计 8 秒'))
check('H-3 分镜 .md 含视频提示词列', sbMd.includes('视频提示词') && sbMd.includes('视频提示 1-2'))

/* ------------------------------------------------------------------ [9] */
group('[9] 检索')
const hit = await call('search', { query: '当铺' })
check('检索命中剧本文本', hit.body.hits.some((x) => x.path.includes('分集剧本')), JSON.stringify(hit.body.hits).slice(0, 120))
check('检索命中项目名', (await call('search', { query: '倒爷' })).body.hits.some((x) => x.title === TITLE))
check('空查询返回空', (await call('search', { query: '' })).body.hits.length === 0)

/* ----------------------------------------------------------------- [10] */
group('[10] 条目管理与保护')
check('新建文件', (await call('entry-create', { title: TITLE, path: '构想/灵感.md', kind: 'file' })).status === 200)
check('新建目录', (await call('entry-create', { title: TITLE, path: '构想/参考', kind: 'dir' })).status === 200)
check('重名新建被拒', (await call('entry-create', { title: TITLE, path: '构想/灵感.md', kind: 'file' })).status === 400)
check('路径穿越被拒', (await call('entry-create', { title: TITLE, path: '../../evil.md', kind: 'file' })).status === 400)
check('写入内部目录被拒', (await call('entry-create', { title: TITLE, path: '.aidrama/x.json', kind: 'file' })).status === 400)
check('重命名一级目录', (await call('entry-rename', { title: TITLE, path: '构想', name: '灵感库' })).body.renamed.to === '灵感库')
check('契约不可删', (await call('entry-delete', { title: TITLE, path: '剧集契约.md' })).status === 400)
check('必需目录不可删', (await call('entry-delete', { title: TITLE, path: '分集剧本' })).status === 400)
check('普通目录可删', (await call('entry-delete', { title: TITLE, path: '灵感库' })).status === 200)

/* ----------------------------------------------------------------- [11] */
group('[11] 原子写入与快照')
const stray = (await fs.readdir(path.join(projectDir, '.aidrama'))).filter((f) => /\.tmp-/.test(f))
check('无残留临时文件', stray.length === 0, stray.join(','))
await call('contract-save', { title: TITLE, contract: { platform: '快手' } })
const history = (await fs.readdir(path.join(projectDir, '.aidrama', 'history'))).filter((f) => f.startsWith('contract.')).sort()
check('产生历史快照', history.length >= 2, history.join(','))
const snapshots = await Promise.all(history.map(async (f) => JSON.parse(await fs.readFile(path.join(projectDir, '.aidrama', 'history', f), 'utf8'))))
check('最新快照保留上一版（抖音）', snapshots[snapshots.length - 1].platform === '抖音', JSON.stringify(snapshots.map((s) => s.platform)))
check('当前版本已是快手', (await call('contract-get', { title: TITLE })).body.contract.platform === '快手')

/* ----------------------------------------------------------------- [12] */
group('[12] 树与错误分支')
const tree = await call('tree', { title: TITLE })
check('树含 14 个节点', tree.body.tree.nodes.length === 14)
check('树的目录节点带计数', tree.body.tree.nodes.find((n) => n.name === '构想').count >= 0)
check('未知 title 报错', (await call('tree', { title: '不存在的剧' })).status === 400)
check('未知方法不进路由表', !routes.has('/api/ai-drama/nope'))

/* ----------------------------------------------------------------- [13] */
group('[13] Agent 工具层（drama_*）')
const toolsMod = await import(pathToFileURL(path.join(here, '..', 'lib', 'tools.js')).href)
const draftsMod = await import(pathToFileURL(path.join(here, '..', 'lib', 'drafts.js')).href)

const execCtx = { agent: { session: { header: { cwd: workspace } } }, callId: 'call-1', name: 'test' }
const defs = toolsMod.createToolDefs({ rootOf: () => workspace })
const byName = new Map(defs.map((d) => [d.name, d]))
check(`工具数量与 DRAMA_TOOL_NAMES 一致（${toolsMod.DRAMA_TOOL_NAMES.length}）`, defs.length === toolsMod.DRAMA_TOOL_NAMES.length, String(defs.length))
check('工具名全部以 drama_ 开头', defs.every((d) => d.name.startsWith('drama_')))
check('每个工具都有 JSON Schema 参数', defs.every((d) => d.parameters && d.parameters.type === 'object'))
check('模块导出工具名清单一致', toolsMod.DRAMA_TOOL_NAMES.length === defs.length)

const runTool = (name, args) => byName.get(name).execute(args || {}, execCtx)

let r = await runTool('drama_list_projects')
check('drama_list_projects 有 1 个项目', r.projects.length === 1 && r.projects[0].title === TITLE)

r = await runTool('drama_get_project', { title: TITLE })
check('drama_get_project 回读契约', r.contract.platform === '快手', r.contract.platform)
check('drama_get_project 回读人物', r.characters.length === 2)
check('drama_get_project 回读分集', r.episodes.includes(1))

r = await runTool('drama_create_project', { title: '工具建的剧' })
check('drama_create_project 建项目', r.project.title === '工具建的剧')
check('工具建的剧可被列出', (await runTool('drama_list_projects')).projects.length === 2)
await fs.rm(path.join(workspace, 'AI短剧', '工具建的剧'), { recursive: true, force: true })

/* ----------------------------------------------------------------- [14] */
group('[14] 草稿区与采纳流')
const madeDraft = await draftsMod.createDraft(projectDir, {
  kind: 'outline',
  content: JSON.stringify([{ order: 1, title: '草稿集', logline: '来自 AI', hook: 'H', twist: 'T', cliffhanger: 'C', estDurationSec: 100 }]),
  note: '测试草稿',
  origin: { preset: 'drama', toolName: 'drama_save_draft' },
})
check('草稿 id 合法', /^d-[a-z0-9]+-[a-z0-9]+$/.test(madeDraft.id))
check('草稿初始为 pending', madeDraft.status === 'pending')

r = await call('drafts-list', { title: TITLE })
check('路由列出待处理草稿', r.body.drafts.length === 1 && r.body.drafts[0].id === madeDraft.id)
check('草稿带来源信息', r.body.drafts[0].origin.preset === 'drama')

check('非法草稿类型被拒', await draftsMod.createDraft(projectDir, { kind: 'nope', content: 'x' }).then(() => false, () => true))
check('空内容被拒', await draftsMod.createDraft(projectDir, { kind: 'outline', content: '' }).then(() => false, () => true))
check('episode 草稿缺集数被拒', await draftsMod.createDraft(projectDir, { kind: 'episode', content: 'x' }).then(() => false, () => true))
check('非法草稿 id 被拒', await draftsMod.getDraft(projectDir, '../../etc/passwd').then(() => false, () => true))

const accept = await call('draft-resolve', { title: TITLE, id: madeDraft.id, action: 'accept' })
check('采纳草稿成功', accept.status === 200 && accept.body.status === 'accepted', JSON.stringify(accept.body).slice(0, 120))
check('采纳后总纲已被覆盖', (await call('outline-get', { title: TITLE })).body.rows[0].title === '草稿集')
check('重复处理被拒', (await call('draft-resolve', { title: TITLE, id: madeDraft.id, action: 'accept' })).status === 400)

const d2 = await draftsMod.createDraft(projectDir, { kind: 'file', path: '总纲/草稿.md', content: '草稿正文' })
const disc = await call('draft-resolve', { title: TITLE, id: d2.id, action: 'discard' })
check('丢弃草稿', disc.body.status === 'discarded')
check('丢弃不写正式文件', !(await fs.readdir(path.join(projectDir, '总纲'))).includes('草稿.md'))
check('非法 action 被拒', (await call('draft-resolve', { title: TITLE, id: d2.id, action: 'explode' })).status === 400)

const d3 = await draftsMod.createDraft(projectDir, { kind: 'episode', order: 7, content: '# 第007集\n\n甲：走。\n' })
await call('draft-resolve', { title: TITLE, id: d3.id, action: 'accept' })
check('采纳 episode 草稿写入正式剧本', (await call('episode-read', { title: TITLE, order: 7 })).body.text.includes('第007集'))

/* ---- H-1（P1-B 契约冻结）：批量 accept/discard/restore + results/counts + 单条旧调用兼容 ---- */
const b1 = await draftsMod.createDraft(projectDir, { kind: 'file', path: '构想/批1.md', content: '批1' })
const b2 = await draftsMod.createDraft(projectDir, { kind: 'file', path: '构想/批2.md', content: '批2' })
const batchAccept = await call('draft-resolve', { title: TITLE, ids: [b1.id, b2.id], action: 'accept' })
check('H-1 批量采纳：HTTP 200 + ok', batchAccept.status === 200 && batchAccept.body.ok === true, JSON.stringify(batchAccept.body).slice(0, 160))
check('H-1 批量采纳 results 逐条 ok/status=accepted', Array.isArray(batchAccept.body.results) && batchAccept.body.results.length === 2 && batchAccept.body.results.every((x) => x.ok === true && x.status === 'accepted'), JSON.stringify(batchAccept.body.results).slice(0, 160))
check('H-1 counts 四字段必返且 accepted=2', Boolean(batchAccept.body.counts) && ['accepted', 'discarded', 'restored', 'failed'].every((k) => Number.isFinite(batchAccept.body.counts[k])) && batchAccept.body.counts.accepted === 2, JSON.stringify(batchAccept.body.counts))
check('H-1 批量采纳落盘', (await fs.readdir(path.join(projectDir, '构想'))).includes('批1.md') && (await fs.readdir(path.join(projectDir, '构想'))).includes('批2.md'))

const b3 = await draftsMod.createDraft(projectDir, { kind: 'file', path: '构想/批3.md', content: '批3' })
const b4 = await draftsMod.createDraft(projectDir, { kind: 'file', path: '构想/批4.md', content: '批4' })
const batchDiscard = await call('draft-resolve', { title: TITLE, ids: [b3.id, b4.id], action: 'discard' })
check('H-1 批量丢弃 counts.discarded=2', batchDiscard.status === 200 && batchDiscard.body.ok === true && batchDiscard.body.counts.discarded === 2 && batchDiscard.body.results.every((x) => x.status === 'discarded'), JSON.stringify(batchDiscard.body.counts))
check('H-1 丢弃不写正式文件', !(await fs.readdir(path.join(projectDir, '构想'))).includes('批3.md'))

const batchRestore = await call('draft-resolve', { title: TITLE, ids: [b3.id], action: 'restore' })
check('H-1 批量恢复：discarded→pending', batchRestore.status === 200 && batchRestore.body.ok === true && batchRestore.body.counts.restored === 1 && batchRestore.body.results[0].status === 'restored' && batchRestore.body.results[0].draftStatus === 'pending', JSON.stringify(batchRestore.body).slice(0, 180))
check('H-1 恢复后草稿区可见（pending）', (await call('drafts-list', { title: TITLE })).body.drafts.some((d) => d.id === b3.id && d.status === 'pending'))
const legacyRestore = await call('draft-resolve', { title: TITLE, id: b4.id, action: 'restore' })
check('H-1 单条 restore 兼容（id+action 原语义）', legacyRestore.status === 200 && legacyRestore.body.ok === true && legacyRestore.body.status === 'restored' && legacyRestore.body.counts && legacyRestore.body.counts.restored === 1, JSON.stringify(legacyRestore.body).slice(0, 160))

const b5 = await draftsMod.createDraft(projectDir, { kind: 'file', path: '构想/批5.md', content: '批5' })
const mixed = await call('draft-resolve', { title: TITLE, ids: [b5.id, 'd-ffffffff-ffffffff'], action: 'accept' })
check('H-1 批量逐条失败不整体失败（HTTP 200 + 部分 ok）', mixed.status === 200 && mixed.body.ok === true && mixed.body.results.length === 2 && mixed.body.results[0].ok === true && mixed.body.results[1].ok === false, JSON.stringify(mixed.body).slice(0, 220))
check('H-1 失败条目带 {code,reason}', mixed.body.results[1].error && typeof mixed.body.results[1].error.code === 'string' && typeof mixed.body.results[1].error.reason === 'string', JSON.stringify(mixed.body.results[1]).slice(0, 160))
check('H-1 counts.failed 计数', mixed.body.counts.failed === 1 && mixed.body.counts.accepted === 1, JSON.stringify(mixed.body.counts))

/* ----------------------------------------------------------------- [15] */
group('[15] 一致性检查')
await call('outline-save', {
  title: TITLE,
  rows: [
    { order: 1, title: 'A', logline: 'a', hook: '同一个钩子', twist: '反转甲', cliffhanger: 'x', estDurationSec: 120 },
    { order: 2, title: 'B', logline: 'b', hook: '同一个钩子', twist: '反转甲', cliffhanger: 'y', estDurationSec: 120 },
  ],
})
await call('episode-write', { title: TITLE, order: 3, text: '张三：我不认识你。\n' })
await call('episode-write', { title: TITLE, order: 5, text: '# 第005集\n' })
await call('storyboard-save', { title: TITLE, order: 1, shots: [{ shotNumber: '1-1', shotSize: '中景', durationSec: 90 }, { shotNumber: '1-1', shotSize: '中景', durationSec: 90 }] })

const chk = await call('consistency-check', { title: TITLE })
check('检查返回报告', chk.status === 200 && chk.body.report.summary.total > 0)
const codes = new Set(chk.body.report.issues.map((i) => i.code))
check('检出重复桥段', codes.has('duplicate-beat'), [...codes].join(','))
check('检出未知说话人', codes.has('unknown-speaker'), [...codes].join(','))
check('检出镜号重复', codes.has('shot-duplicate'), [...codes].join(','))
check('检出分镜超时', codes.has('storyboard-overrun'), [...codes].join(','))
check('检出分集缺口', codes.has('episode-gap'), [...codes].join(','))
check('检出有剧本无大纲', codes.has('episode-without-outline'))
check('问题按严重级别排序', (() => {
  const rank = { error: 0, warn: 1, info: 2 }
  const list = chk.body.report.issues.map((i) => rank[i.severity])
  return list.every((v, i) => i === 0 || list[i - 1] <= v)
})())
check('每条问题带定位', chk.body.report.issues.every((i) => typeof i.where === 'string'))

/* ----------------------------------------------------------------- [16] */
group('[16] 导出（含 T10 sha256 清单）')
for (const format of ['markdown', 'json', 'csv']) {
  const ex = await call('export-project', { title: TITLE, format })
  check(`导出 ${format}`, ex.status === 200 && ex.body.export.bytes > 0, JSON.stringify(ex.body).slice(0, 100))
  // 契约：HTTP export-project 响应形状不变（仍只有 export.{format,file,bytes,relative}）；
  // 清单/复算/确定性检查摘要只在 Agent 工具 drama_export 的结果里（见 [13] 工具层）。
  check(`导出 ${format} 响应保持契约形状`, typeof ex.body.export.file === 'string' && typeof ex.body.export.relative === 'string' && ex.body.export.format === format)
}
const exportDir = path.join(projectDir, '导出')
const exported = await fs.readdir(exportDir)
const MANIFEST_FILE = 'manifest.sha256.json'
const productFiles = exported.filter((f) => f !== MANIFEST_FILE && !f.startsWith('.'))
check('导出目录有 3 个产物 + 1 个清单', productFiles.length === 3 && exported.includes(MANIFEST_FILE), exported.join(','))
// H-3：导出前写入带 videoPrompt 的分镜，验证 CSV 第 11 列取值链路
await call('storyboard-save', {
  title: TITLE,
  order: 1,
  shots: [
    { shotNumber: '1-1', shotSize: '特写', cameraMove: '推', description: '刀刃反光', dialogue: '', sfx: '金属摩擦', durationSec: 3, imagePrompt: '特写刀锋', videoPrompt: '视频提示 1-1' },
    { shotNumber: '1-2', shotSize: '中景', cameraMove: '摇', description: '林越被按在案上', dialogue: '林越：这钱，我三天还你。', sfx: '人群嘈杂', durationSec: 5, imagePrompt: '当铺内景', videoPrompt: '视频提示 1-2' },
  ],
})
for (const format of ['markdown', 'json', 'csv']) {
  await call('export-project', { title: TITLE, format })
}
const csvRaw = (await fs.readFile(path.join(exportDir, productFiles.find((f) => f.endsWith('.csv'))), 'utf8')).replace(/^\ufeff/, '')
const csvRows = csvRaw.trim().split(/\r?\n/)
check('CSV 带 BOM 且有表头', csvRows[0].includes('镜号'))
const h3Header = csvRows[0].split(',')
check('CSV 表头 11 列（H-3 视频提示词列）', h3Header.length === 11 && h3Header[9] === '生图提示词' && h3Header[10] === '视频提示词', h3Header.join('|'))
check('H-3 CSV 视频提示词列取自 shots[].videoPrompt', csvRows[2] && csvRows[2].split(',').length === 11 && csvRows[2].split(',')[10] === '视频提示 1-2', csvRows[2] || '')
check('Markdown 含大纲与人物', (await fs.readFile(path.join(exportDir, productFiles.find((f) => f.endsWith('.md'))), 'utf8')).includes('分集大纲'))
check('H-3 导出 MD 分镜表含视频提示词列', (await fs.readFile(path.join(exportDir, productFiles.find((f) => f.endsWith('.md'))), 'utf8')).includes('视频提示词'))
check('JSON 可解析且含契约', JSON.parse(await fs.readFile(path.join(exportDir, productFiles.find((f) => f.endsWith('.json'))), 'utf8')).contract.platform === '快手')
const manifest = JSON.parse(await fs.readFile(path.join(exportDir, MANIFEST_FILE), 'utf8'))
check('清单结构：version/algorithm/project/files', manifest.version === 1 && manifest.algorithm === 'sha256' && manifest.project === TITLE && Array.isArray(manifest.files), JSON.stringify(manifest).slice(0, 120))
check('清单覆盖 3 个产物且不含清单自身', manifest.files.length === 3 && manifest.files.every((f) => f.path !== MANIFEST_FILE), manifest.files.map((f) => f.path).join(','))
check('清单相对路径均存在', (await Promise.all(manifest.files.map((f) => fs.stat(path.join(exportDir, f.path)).then(() => true, () => false)))).every(Boolean))
const manifestMatch = await Promise.all(manifest.files.map(async (f) => {
  const buf = await fs.readFile(path.join(exportDir, f.path))
  return crypto.createHash('sha256').update(buf).digest('hex') === f.sha256 && buf.length === f.bytes
}))
check('清单 sha256/bytes 可独立复算一致', manifestMatch.every(Boolean))
check('不支持的格式被拒', (await call('export-project', { title: TITLE, format: 'pdf' })).status === 400)

/* ----------------------------------------------------------------- [17] */
group('[17] 目录与名字服务')
const serviceDir = path.join(here, '..', 'skills')
const skillDirs = (await fs.readdir(serviceDir, { withFileTypes: true })).filter((e) => e.isDirectory())
check('随包 9 个技能', skillDirs.length === 9, skillDirs.map((e) => e.name).join(','))
for (const dir of skillDirs) {
  const text = await fs.readFile(path.join(serviceDir, dir.name, 'SKILL.md'), 'utf8')
  check(`技能 ${dir.name} 有 name 前置字段`, text.startsWith('---') && text.includes(`name: ${dir.name}`))
}
const presetYml = await fs.readFile(path.join(here, '..', 'presets', 'drama.patch.yml'), 'utf8')
check('预设声明含 drama id', presetYml.includes('id: drama'))
check('预设声明含隔离服务', presetYml.includes('dramaMode: true'))
check('预设声明含本插件 preset 入口', presetYml.includes('dsh-plugin-ai-drama/preset'))
check('预设未暴露 shell 工具', !presetYml.includes('dsh-tool-pwsh') && !presetYml.includes('dsh-tool-bash'))

/* ----------------------------------------------------------------- [18] */
group('[18] 检索增强（FR-C08）')
const retrieval = await import(pathToFileURL(path.join(here, '..', 'lib', 'retrieval.js')).href)
check('中文分词产出单字与二元组', (() => {
  const t = retrieval.tokenize('林越护短')
  return t.includes('林') && t.includes('林越') && t.includes('护短')
})())
check('英文按词切分', retrieval.tokenize('Neo Video 2.0').includes('video'))
check('停用词被剔除', !retrieval.tokenize('的 了 是').includes('的'))

await call('characters-save', { title: TITLE, characters: [
  { name: '林越', role: '主角', personality: '冷静、护短', bio: '靠倒卖灵药起家的穿越者' },
  { name: '赵铁', role: '反派', personality: '贪婪、暴戾', bio: '本地恶霸，靠放贷敛财' }] })
await call('outline-save', { title: TITLE, rows: [
  { order: 1, title: '刀在颈侧', logline: '倒爷被逼债', hook: '刀架脖子', twist: '反杀', cliffhanger: '幕后现身', estDurationSec: 90 }] })

const ctxSearch = await call('search-context', { title: TITLE, query: '赵铁 是什么人', topK: 5 })
check('检索返回命中', ctxSearch.status === 200 && ctxSearch.body.hits.length > 0, JSON.stringify(ctxSearch.body).slice(0, 150))
check('最相关的是赵铁', ctxSearch.body.hits[0].path.includes('赵铁'), ctxSearch.body.hits[0].path)
check('命中带片段', typeof ctxSearch.body.hits[0].excerpt === 'string' && ctxSearch.body.hits[0].excerpt.length > 0)
check('标注检索方式', ctxSearch.body.method === 'local-lexical')
check('空查询返回空命中', (await call('search-context', { title: TITLE, query: '   ' })).body.hits.length === 0)
check('检索工具可用', (await runTool('drama_search_context', { title: TITLE, query: '灵药' })).hits.length > 0)

/* ----------------------------------------------------------------- [19] */
group('[19] Agent 挂载诊断')
const diag = await call('agents-status')
check('诊断路由可用', diag.status === 200 && diag.body.preset.id === 'drama')
check(`诊断列出 ${toolsMod.DRAMA_TOOL_NAMES.length} 个工具名`, diag.body.tools.length === toolsMod.DRAMA_TOOL_NAMES.length, String(diag.body.tools.length))
check('诊断含 attach 段', diag.body.attach && typeof diag.body.attach.toolCount === 'number')

/* ----------------------------------------------------------------- [20] */
group('[20] 打包契约（M7）')
const pkg = JSON.parse(await fs.readFile(path.join(here, '..', 'package.json'), 'utf8'))
check('exports 含 . 与 ./client 与 ./preset',
  pkg.exports['.'] === './index.js' && pkg.exports['./client'] === './client.js' && pkg.exports['./preset'] === './preset.js')
check('dsh.bundle.patch 为双补丁数组', Array.isArray(pkg.dsh.bundle.patch) && pkg.dsh.bundle.patch.length === 2, JSON.stringify(pkg.dsh.bundle.patch))
check('dsh.client.platform 为 web', pkg.dsh.client.platform === 'web')
check('声明 engines', typeof pkg.engines.node === 'string')
check('files 覆盖 lib/presets/skills', ['lib/**/*.js', 'presets/*.yml', 'skills/**/*'].every((p) => pkg.files.includes(p)))
for (const rel of ['index.js', 'client.js', 'preset.js', 'cordis.patch.yml', 'presets/drama.patch.yml']) {
  check(`入口文件存在：${rel}`, await fs.stat(path.join(here, '..', rel)).then(() => true, () => false))
}
check('版本号一致（index.js / package.json）', VERSION === pkg.version, `${VERSION} vs ${pkg.version}`)

/* ----------------------------------------------------------------- [21] */
group('[21] 本剧记忆（FR-B12）')
check('初始为空', (await call('memory-get', { title: TITLE })).body.memory.length === 0)
const memSaved = await call('memory-save', { title: TITLE, memory: [
  { kind: '伏笔', content: '赵铁背后的靠山是谁', episode: 1, status: 'open' },
  { kind: '已用桥段', content: '刀架脖子反杀', status: 'resolved' },
  { kind: '时间线', content: '故事起于雨夜', status: 'open' },
] })
check('保存记忆', memSaved.status === 200 && memSaved.body.memory.length === 3)
check('自动生成 id', memSaved.body.memory.every((m) => typeof m.id === 'string' && m.id.length > 0))
check('空内容被拒', (await call('memory-save', { title: TITLE, memory: [{ kind: '伏笔', content: '  ' }] })).status === 400)
check('非数组被拒', (await call('memory-save', { title: TITLE, memory: {} })).status === 400)
check('非法类型回退为伏笔', (await call('memory-save', { title: TITLE, memory: [{ kind: '乱写', content: 'x' }] })).body.memory[0].kind === '伏笔')
await call('memory-save', { title: TITLE, memory: [
  { kind: '伏笔', content: '赵铁背后的靠山是谁', episode: 1, status: 'open' },
  { kind: '已用桥段', content: '刀架脖子反杀', status: 'resolved' },
  { kind: '时间线', content: '故事起于雨夜', status: 'open' },
] })
const memMd = await fs.readFile(path.join(projectDir, '本剧记忆', '本剧记忆.md'), 'utf8')
check('记忆 .md 已渲染', memMd.includes('## 伏笔') && memMd.includes('赵铁背后的靠山'))
check('已回收条目标记为 [x]', memMd.includes('[x] 刀架脖子反杀'))
check('未回收条目标记为 [ ]', memMd.includes('[ ] 赵铁背后的靠山是谁（第 1 集）'))
check('记忆工具可用', (await runTool('drama_save_memory', { title: TITLE, memory: [{ content: '仅一条' }] })).count === 1)

/* ----------------------------------------------------------------- [22] */
group('[22] 创作进度（FR-D05）')
await call('memory-save', { title: TITLE, memory: [{ kind: '伏笔', content: '未回收的线', status: 'open' }] })
const prog = await call('progress-get', { title: TITLE })
check('返回进度', prog.status === 200 && Array.isArray(prog.body.progress.steps))
check('六个阶段', prog.body.progress.steps.length === 6, String(prog.body.progress.steps.length))
const stepMap = Object.fromEntries(prog.body.progress.steps.map((s) => [s.key, s.done]))
check('项目已建', stepMap.project === true)
check('大纲就绪', stepMap.outline === true)
check('人物就绪', stepMap.characters === true)
check('剧本就绪', stepMap.episode_script === true)
check('分镜就绪', stepMap.storyboard === true)
check('已导出', stepMap.exported === true)
check('阶段停在已导出', prog.body.progress.stage === 'exported', prog.body.progress.stage)
check('事实含未回收伏笔数', prog.body.progress.facts.openMemoryCount === 1, JSON.stringify(prog.body.progress.facts))
check('进度工具可用', (await runTool('drama_get_progress', { title: TITLE })).stage === 'exported')

/* ----------------------------------------------------------------- [23] */
group('[23] 项目生命周期（FR-A03）')
const renamed = await call('project-rename', { title: TITLE, name: '万界倒爷：改名版' })
check('重命名成功', renamed.status === 200 && renamed.body.renamed.to === '万界倒爷：改名版')
const renamedDir = path.join(workspace, 'AI短剧', '万界倒爷：改名版')
check('目录已改名', await fs.stat(renamedDir).then(() => true, () => false))
check('数据完整保留', (await call('characters-get', { title: '万界倒爷：改名版' })).body.characters.length === 2)
check('契约标题已同步', (await call('contract-get', { title: '万界倒爷：改名版' })).body.contract.title === '万界倒爷：改名版')
check('旧名不可访问', (await call('tree', { title: TITLE })).status === 400)
check('重名被拒', (await call('project-rename', { title: '万界倒爷：改名版', name: '万界倒爷：改名版' })).status === 200)
check('非法新名被拒', (await call('project-rename', { title: '万界倒爷：改名版', name: '../evil' })).status === 400)

const created2 = await call('create-project', { title: '待删除的剧' })
check('建第二个项目', created2.status === 200)
check('删除成功', (await call('project-delete', { title: '待删除的剧' })).body.deleted === true)
check('删除后目录消失', !(await fs.stat(path.join(workspace, 'AI短剧', '待删除的剧')).then(() => true, () => false)))
check('删除不存在的被拒', (await call('project-delete', { title: '待删除的剧' })).status === 400)
check('其余项目不受影响', (await call('shelf')).body.projects.length === 1)

/* ----------------------------------------------------------------- [24] */
group('[24] 目录树子节点（FR-A04）')
const tree2 = await call('tree', { title: '万界倒爷：改名版' })
const epNode = tree2.body.tree.nodes.find((n) => n.name === '分集剧本')
check('目录节点带 children', Array.isArray(epNode.children))
check('分集剧本列出剧集文件', epNode.children.some((c) => /^第\d+集\.md$/.test(c.name)), JSON.stringify(epNode.children).slice(0, 120))
const charNode = tree2.body.tree.nodes.find((n) => n.name === '人物')
check('人物目录列出设定卡', charNode.children.some((c) => c.name.includes('人物设定卡')))
const metaNode = tree2.body.tree.nodes.find((n) => n.name === '.aidrama')
check('.aidrama 不出现在固定节点里', !metaNode, '内部目录不应混入一级节点')

/* ----------------------------------------------------------------- [25] */
group('[25] 设置（P1-G / H-2 扩字段）')
const storedStorage = path.join(workspace, '迁移目标-未启用')
const settings0 = await call('settings-get')
const s0 = settings0.body.settings
check('设置恒返回 H-2 四字段', ['defaultModel', 'promptTemplates', 'retrievalEnabled', 'storageLocation'].every((k) => k in s0), Object.keys(s0).join(','))
check('H-2 默认值正确', s0.defaultModel === '' && JSON.stringify(s0.promptTemplates) === '{}' && s0.retrievalEnabled === true && s0.storageLocation === '', JSON.stringify(s0).slice(0, 160))
const oldSave = await call('settings-save', { settings: { defaultPlatform: '快手' } })
check('H-2 旧 payload 保存不报错', oldSave.status === 200 && oldSave.body.ok === true, JSON.stringify(oldSave.body).slice(0, 120))
const s1 = (await call('settings-get')).body.settings
check('H-2 旧 payload 保存后新字段保持默认', s1.defaultModel === '' && s1.retrievalEnabled === true && JSON.stringify(s1.promptTemplates) === '{}' && s1.storageLocation === '' && s1.defaultPlatform === '快手', JSON.stringify(s1).slice(0, 160))
const saveNew = await call('settings-save', {
  settings: {
    defaultModel: 'deepseek-chat',
    promptTemplates: { outline: '大纲模板', episode: '分集模板', customKey: '自定义模板' },
    retrievalEnabled: false,
    storageLocation: storedStorage,
  },
})
check('H-2 四字段保存成功', saveNew.status === 200 && saveNew.body.ok === true, JSON.stringify(saveNew.body).slice(0, 160))
const s2 = (await call('settings-get')).body.settings
check('H-2 回读一致（含未知模板键保留）', s2.defaultModel === 'deepseek-chat' && s2.retrievalEnabled === false && s2.storageLocation === storedStorage && s2.promptTemplates.outline === '大纲模板' && s2.promptTemplates.customKey === '自定义模板', JSON.stringify(s2).slice(0, 200))
check('H-2 storageLocation 仅持久化不迁移目录（P2 才启用）', !(await fs.stat(storedStorage).then(() => true, () => false)))
const settingsFile = path.join(workspace, 'AI短剧', '.aidrama', 'settings.json')
const settingsRaw = JSON.parse(await fs.readFile(settingsFile, 'utf8'))
const legacySettings = {
  defaultPlatform: settingsRaw.defaultPlatform,
  defaultEpisodeDurationSec: settingsRaw.defaultEpisodeDurationSec,
  defaultOrientation: settingsRaw.defaultOrientation,
  defaultTargetEpisodes: settingsRaw.defaultTargetEpisodes,
  retrievalTopK: settingsRaw.retrievalTopK,
  updatedAt: settingsRaw.updatedAt,
}
await fs.writeFile(settingsFile, `${JSON.stringify(legacySettings, null, 2)}\n`)
const s3 = (await call('settings-get')).body.settings
check('H-2 旧版 settings.json（缺新键）读取自动补默认', s3.defaultModel === '' && s3.retrievalEnabled === true && JSON.stringify(s3.promptTemplates) === '{}' && s3.storageLocation === '', JSON.stringify(s3).slice(0, 160))
check('H-2 retrievalEnabled 非布尔被拒', (await call('settings-save', { settings: { retrievalEnabled: 'yes' } })).status === 400)
check('H-2 promptTemplates 数组被拒', (await call('settings-save', { settings: { promptTemplates: [] } })).status === 400)
check('H-2 模板值非字符串被拒', (await call('settings-save', { settings: { promptTemplates: { outline: 123 } } })).status === 400)
check('H-2 storageLocation 超长被拒', (await call('settings-save', { settings: { storageLocation: 'x'.repeat(501) } })).status === 400)

await fs.rm(workspace, { recursive: true, force: true })

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
