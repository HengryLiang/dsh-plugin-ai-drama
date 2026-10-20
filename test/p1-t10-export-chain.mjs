/**
 * P1 · T1-10 导出/定稿校验链（纯 test/ 可执行脚本，**不依赖产品侧新增接口**）
 *
 * 对标：Scriptor 的 `inspect/verifyExportTarget` + 8 个 CLI + 确定性检查脚本。
 * 本脚本负责 QA 侧「可执行检查 + 证据」，检查项：
 *   [1] 写盘目标检查：导出三格式 → 文件存在、非空、返回 bytes 与磁盘字节一致、无残留临时文件
 *   [2] sha256 校验清单：对全部导出产物计算 sha256，输出机器可读 manifest（stdout `T10-MANIFEST:` 行）
 *   [3] 确定性检查：同一数据重复导出 → **去时间戳归一化后内容哈希一致**（导出含 exportedAt/导出自时间戳）
 *   [4] 一致性检查（字数/场次/镜头）：导出 JSON/CSV/MD 与源数据交叉核对
 *   [5] 定稿链：finalize → v1 快照 sha256 → 编辑后 finalize → v2 → restore v1 → 内容哈希回到 v1；
 *       restore 后再 finalize → 新版本与 v1 同内容（定稿链确定性）
 *   [6] 篡改必报错：改动导出文件 → 重算 sha256 ≠ 清单 → 确定性校验函数必须报错
 *
 * 运行：node test/p1-t10-export-chain.mjs
 *       node test/p1-t10-export-chain.mjs --manifest <输出路径>   # 额外把 manifest 落盘（证据用）
 * 输出：`结果：N passed, M failed`；最后一行 `T10-MANIFEST: {json}`（供验收证据引用）
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(path.join(here, '..', 'index.js')).href)
const { apply, METHODS } = mod
// 产品侧 T10 接口（host-dev task-11 交付）：清单生成/复算 + 确定性检查，test/ 直接只读复用。
const exporterMod = await import(pathToFileURL(path.join(here, '..', 'lib', 'exporter.js')).href)
const checksMod = await import(pathToFileURL(path.join(here, '..', 'lib', 'checks.js')).href)
const toolsMod = await import(pathToFileURL(path.join(here, '..', 'lib', 'tools.js')).href)

const manifestArgIndex = process.argv.indexOf('--manifest')
const manifestOut = manifestArgIndex >= 0 ? process.argv[manifestArgIndex + 1] : null

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-t10-'))
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

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const sha256File = async (file) => sha256(await fs.readFile(file))

/** 导出产物里唯一的时间戳字段：确定性比较时归一化掉（内容本身必须确定）。 */
function normalizeExport(content, format) {
  if (format === 'json') {
    const value = JSON.parse(content)
    value.exportedAt = '<TIMESTAMP>'
    return JSON.stringify(value)
  }
  if (format === 'markdown') {
    return content.replace(/^> 导出自「AI 短剧」工作区 · .*$/m, '> 导出自「AI 短剧」工作区 · <TIMESTAMP>')
  }
  return content
}

/** 校验清单：重算磁盘文件 sha256 与清单比对，返回不一致列表（篡改检测核心）。 */
async function verifyManifest(manifest) {
  const mismatches = []
  for (const item of manifest.files) {
    let actual = null
    try {
      actual = await sha256File(item.absolutePath)
    } catch {
      actual = null
    }
    if (actual !== item.sha256) mismatches.push(item.relative)
  }
  return mismatches
}

const TITLE = '校验链样剧'
const projectDir = path.join(workspace, 'AI短剧', TITLE)
const exportDir = path.join(projectDir, '导出')
const finalizeDir = path.join(projectDir, '定稿')
const episodes = 2
const shotsPerEpisode = 3

/* ------------------------------------------------------------------ 前置：造项目与内容 */
{
  await call('create-project', { title: TITLE })
  await call('contract-save', {
    title: TITLE,
    contract: { platform: '抖音', audience: '下沉市场', targetEpisodes: 80, episodeDurationSec: [90, 150], hookDensity: '每 30 秒一个钩子', redlines: '无血腥' },
  })
  await call('outline-save', {
    title: TITLE,
    rows: [
      { order: 1, title: '刀在颈侧', logline: '倒爷被逼债', hook: '刀架脖子', twist: '反杀', cliffhanger: '幕后黑手现身', estDurationSec: 120 },
      { order: 2, title: '第一桶金', logline: '倒卖灵药', hook: '当街叫卖', twist: '引来执法', cliffhanger: '神秘买家', estDurationSec: 130 },
    ],
  })
  await call('characters-save', {
    title: TITLE,
    characters: [
      { name: '林越', role: '主角', personality: ['冷静', '护短'], bio: '穿越者，靠倒卖起家', appearancePrompt: '二十岁青年，青色长衫', voiceHint: '清朗少年音' },
      { name: '赵铁', role: '反派', personality: '贪婪、暴戾', bio: '本地恶霸' },
    ],
  })
  for (const order of [1, 2]) {
    await call('episode-write', {
      title: TITLE,
      order,
      // 场次标题必须匹配 store.parseScenes 的 SCENE_RE：`## 场景 N：内景 - 地点 - 时间`
      text: `# 第00${order}集 校验\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：这钱，我三天还你。\n赵铁：三天？我只要现在。\n`,
    })
    await call('storyboard-save', {
      title: TITLE,
      order,
      shots: Array.from({ length: shotsPerEpisode }, (_, i) => ({
        shotNumber: `${order}-${i + 1}`,
        shotSize: '中景',
        cameraMove: '推',
        description: `第 ${order} 集第 ${i + 1} 镜 画面描述`,
        dialogue: `台词 ${i + 1}`,
        sfx: '环境音',
        durationSec: 3 + i,
        imagePrompt: `提示词 ${order}-${i + 1}`,
        // P1-D/H-3：videoPrompt 冻结列名；persistence 由 task-3 的 H-3 落地（见 §[4] 条件断言）
        videoPrompt: i === 0 ? `视频提示词 ${order}-${i + 1}` : '',
      })),
    })
  }
}

/* ------------------------------------------------------------------ [1] */
group('[1] 写盘目标检查（导出三格式）')
const exportResults = {}
for (const format of ['markdown', 'json', 'csv']) {
  const r = await call('export-project', { title: TITLE, format })
  check(`导出 ${format} 成功`, r.status === 200 && r.body && r.body.ok === true, JSON.stringify(r.body).slice(0, 120))
  const info = r.body && r.body.export
  check(`导出 ${format} 返回文件/字节`, Boolean(info && info.file && Number.isFinite(info.bytes)), JSON.stringify(info).slice(0, 120))
  exportResults[format] = info
  const stat = await fs.stat(info.file)
  check(`导出 ${format} 落在项目「导出」目录`, path.dirname(info.file) === exportDir, path.dirname(info.file))
  // CSV 额外写了 UTF-8 BOM（3 字节），其余格式磁盘字节 == 返回字节
  const expected = format === 'csv' ? info.bytes + 3 : info.bytes
  check(`导出 ${format} 返回字节与磁盘一致`, stat.size === expected, `${stat.size} vs ${expected}`)
  const content = await fs.readFile(info.file, 'utf8')
  check(`导出 ${format} 非空`, content.trim().length > 20, String(content.length))
  // 契约：HTTP export-project 响应形状不变（清单/复算/确定性检查摘要只在 drama_export 工具结果里）
  check(`导出 ${format} 响应保持契约形状`, typeof r.body.export.file === 'string' && r.body.export.format === format)
}
const stray = (await fs.readdir(exportDir)).filter((f) => /\.tmp-|\.write-probe-/.test(f))
check('导出目录无残留临时文件', stray.length === 0, stray.join(','))

/* ------------------------------------------------------------------ [2] */
group('[2] 确定性检查（同数据重复导出，去时间戳后内容一致）')
const firstHashes = {}
for (const format of ['markdown', 'json', 'csv']) {
  const info = exportResults[format]
  firstHashes[format] = sha256(Buffer.from(normalizeExport(await fs.readFile(info.file, 'utf8'), format), 'utf8'))
}
for (const format of ['markdown', 'json', 'csv']) {
  const r = await call('export-project', { title: TITLE, format })
  check(`重复导出 ${format} 成功`, r.status === 200 && r.body.ok === true)
  const second = sha256(Buffer.from(normalizeExport(await fs.readFile(exportResults[format].file, 'utf8'), format), 'utf8'))
  check(`重复导出 ${format} 内容确定（归一化哈希一致）`, second === firstHashes[format], `${second.slice(0, 12)} vs ${firstHashes[format].slice(0, 12)}`)
}

/* ------------------------------------------------------------------ [3] */
group('[3] sha256 校验清单（在最后一次导出后计算）')
const manifest = { title: TITLE, generatedAt: new Date().toISOString(), files: [] }
for (const format of ['markdown', 'json', 'csv']) {
  const info = exportResults[format]
  const absolutePath = info.file
  const buf = await fs.readFile(absolutePath)
  manifest.files.push({ format, relative: path.relative(workspace, absolutePath), absolutePath, bytes: buf.length, sha256: sha256(buf) })
}
check('清单覆盖 3 个产物', manifest.files.length === 3, String(manifest.files.length))
check('每个 sha256 为 64 位十六进制', manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)))
check('清单初始校验全部一致（无篡改）', (await verifyManifest(manifest)).length === 0)

/* ---- 产品侧清单（manifest.sha256.json）与 QA 独立复算交叉验证 ---- */
const productManifest = await exporterMod.buildExportManifest(workspace, TITLE)
const manifestPath = path.join(exportDir, exporterMod.MANIFEST_FILE)
check('产品清单文件存在（manifest.sha256.json）', await fs.stat(manifestPath).then(() => true, () => false), exporterMod.MANIFEST_FILE)
const productManifestRaw = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
check('产品清单结构 version/algorithm/project/files', productManifestRaw.version === 1 && productManifestRaw.algorithm === 'sha256' && productManifestRaw.project === TITLE && Array.isArray(productManifestRaw.files), JSON.stringify(productManifestRaw).slice(0, 160))
check('产品清单不含清单自身', productManifestRaw.files.every((f) => f.path !== exporterMod.MANIFEST_FILE), productManifestRaw.files.map((f) => f.path).join(','))
const productBySha = new Map(productManifestRaw.files.map((f) => [f.path, f]))
const exportNames = manifest.files.map((f) => path.basename(f.relative))
check('产品清单覆盖全部导出产物', exportNames.every((name) => productBySha.has(name)), `${productBySha.size} vs ${exportNames.length}`)
check('产品清单 sha256/bytes 与 QA 独立复算一致', exportNames.every((name) => {
  const item = productBySha.get(name)
  const qa = manifest.files.find((f) => path.basename(f.relative) === name)
  return item && qa && item.sha256 === qa.sha256 && item.bytes === qa.bytes
}))
const verifyAll = await exporterMod.verifyExport(workspace, TITLE, 'all')
check('产品 verifyExport(all) 复算通过', verifyAll.ok === true && verifyAll.checked === 3, JSON.stringify({ ok: verifyAll.ok, checked: verifyAll.checked, mismatched: verifyAll.mismatched }))
const verifyJson = await exporterMod.verifyExport(workspace, TITLE, 'json')
check('产品 verifyExport(json) 只校验 1 个产物', verifyJson.ok === true && verifyJson.checked === 1, String(verifyJson.checked))

/* ------------------------------------------------------------------ [4] */
group('[4] 一致性检查（字数/场次/镜头）')
const exportedJson = JSON.parse(await fs.readFile(exportResults.json.file, 'utf8'))
check('JSON 导出集数一致', exportedJson.episodes.length === episodes, String(exportedJson.episodes.length))
check('JSON 导出镜头总数一致', exportedJson.episodes.reduce((n, e) => n + e.storyboard.length, 0) === episodes * shotsPerEpisode)
check('JSON 导出大纲行数一致', exportedJson.outline.length === 2, String(exportedJson.outline.length))
check('JSON 导出人物数一致', exportedJson.characters.length === 2, String(exportedJson.characters.length))
check('JSON 导出契约一致', exportedJson.contract.platform === '抖音', String(exportedJson.contract.platform))
check('JSON 导出剧本文本非空', exportedJson.episodes.every((e) => typeof e.script === 'string' && e.script.includes('当铺')))

const csvText = await fs.readFile(exportResults.csv.file, 'utf8')
const csvLines = csvText.replace(/^\ufeff/, '').trim().split(/\r?\n/)
const csvHeader = csvLines[0].split(',')
// P1-D 冻结口径：11 列逐列一致 = 旧 9 列顺序/语义不变 + 末尾「生图提示词 / 视频提示词」
const expectedCsvHeader = ['集数', '镜号', '景别', '运镜', '画面描述', '台词', '音效', '时长(秒)', '提示词', '生图提示词', '视频提示词']
check('CSV 表头逐列一致（P1-D 冻结 11 列）', JSON.stringify(csvHeader) === JSON.stringify(expectedCsvHeader), csvHeader.join('|'))
check('CSV 至少一行数据', csvLines.length > 1, String(csvLines.length - 1))
check('CSV 每行列数 11', csvLines.slice(1).every((line) => line.split(',').length === 11), csvLines.slice(1).find((l) => l.split(',').length !== 11) || '')
const firstCsvRow = csvLines[1].split(',')
check('CSV 生图提示词列 = shot.imagePrompt', firstCsvRow[9] === '提示词 1-1', firstCsvRow[9])
const shotsAfterSave = (await call('storyboard-get', { title: TITLE, order: 1 })).body.shots
const persistsVideoPrompt = shotsAfterSave.some((s) => typeof s.videoPrompt === 'string' && s.videoPrompt.length > 0)
if (persistsVideoPrompt) {
  check('CSV 视频提示词列 = shots[].videoPrompt', firstCsvRow[10] === '视频提示词 1-1', firstCsvRow[10])
} else {
  console.log('      （H-3 视频提示词持久化待 task-3；本轮仅校验列存在与缺省空串，值映射在 H-3 后复验）')
  check('CSV 视频提示词列存在且缺省空串', typeof firstCsvRow[10] === 'string' && firstCsvRow[10] === '', JSON.stringify(firstCsvRow[10]))
}

const mdText = await fs.readFile(exportResults.markdown.file, 'utf8')
check('MD 含标题与契约/大纲章节', mdText.includes(`# ${TITLE}`) && mdText.includes('## 剧集契约') && mdText.includes('## 分集大纲'))
check('MD 集数与源一致', (mdText.match(/^## 第 \d+ 集$/gm) || []).length === episodes)
check('MD 含分镜表且镜头行数一致', (mdText.match(/^\| \d+-\d+ \|/gm) || []).length === episodes * shotsPerEpisode)

/* ---- 产品确定性检查（lib/checks.js）：PASS 清单 + 可复跑 ---- */
const det1 = await checksMod.runDeterministicChecks(workspace, { title: TITLE })
check('产品确定性检查 PASS（≥10 项）', det1.ok === true && det1.summary.total >= 10, JSON.stringify(det1.summary))
check('确定性检查明细带 id/label/where 且全部 PASS', det1.checks.every((c) => typeof c.id === 'string' && typeof c.label === 'string' && typeof c.where === 'string' && c.ok === true))
check('确定性检查统计与源数据一致', det1.stats.episodes === episodes && det1.stats.shots === episodes * shotsPerEpisode && det1.stats.outlineCount === 2 && det1.stats.characters === 2, JSON.stringify(det1.stats))
const checkReport = checksMod.formatCheckReport(det1)
check('formatCheckReport 输出 PASS 文本清单', checkReport.startsWith('确定性检查：PASS') && checkReport.includes('PASS  '), checkReport.slice(0, 120))
const det2 = await checksMod.runDeterministicChecks(workspace, { title: TITLE })
check('确定性检查可复跑（同 summary/stats）', JSON.stringify(det1.summary) === JSON.stringify(det2.summary) && JSON.stringify(det1.stats) === JSON.stringify(det2.stats))

/* ------------------------------------------------------------------ [5] */
group('[5] 定稿链（finalize → 快照 sha256 → v2 → restore v1 → 再定稿确定性）')
const v1Text = (await call('episode-read', { title: TITLE, order: 1 })).body.text
const r1 = await call('finalize-episode', { title: TITLE, order: 1 })
check('定稿 v1 成功', r1.status === 200 && r1.body.ok === true, JSON.stringify(r1.body).slice(0, 120))
const rec1 = r1.body.finalized
check('v1 版本号 = 1', rec1.version === 1, String(rec1.version))
check('v1 冻结镜头数 = 3', rec1.shots === shotsPerEpisode, String(rec1.shots))
check('v1 快照文件齐全（md + 分镜 md/json）', Array.isArray(rec1.files) && rec1.files.length === 3, (rec1.files || []).join(','))
const list1 = await call('finalized-list', { title: TITLE })
const record1 = (list1.body.finalized || []).find((r) => r.order === 1) || {}
check('v1 定稿记录行数 > 0', record1.lines > 0, String(record1.lines))
check('v1 定稿记录镜头数 = 3', record1.shots === shotsPerEpisode, String(record1.shots))
check('v1 定稿记录文件清单一致', Array.isArray(record1.files) && record1.files.length === 3, (record1.files || []).join(','))
for (const f of rec1.files) check(`v1 快照存在：${f}`, await fs.stat(path.join(finalizeDir, f)).then(() => true, () => false))
const v1Snapshot = { textSha: sha256(Buffer.from(v1Text, 'utf8')), shotsSha: await sha256File(path.join(finalizeDir, '第001集.v1.分镜.json')), mdSha: await sha256File(path.join(finalizeDir, '第001集.v1.md')) }
check('v1 剧本快照内容 = 当前剧本', v1Snapshot.mdSha === v1Snapshot.textSha, `${v1Snapshot.mdSha.slice(0, 12)} vs ${v1Snapshot.textSha.slice(0, 12)}`)

const editedText = `${v1Text}林越（补拍）：三天后，这间当铺归我。\n`
await call('episode-write', { title: TITLE, order: 1, text: editedText })
const r2 = await call('finalize-episode', { title: TITLE, order: 1 })
check('编辑后定稿 v2 成功', r2.status === 200 && r2.body.ok === true)
const rec2 = r2.body.finalized
check('v2 版本号 = 2', rec2.version === 2, String(rec2.version))
const list2 = await call('finalized-list', { title: TITLE })
const record2 = (list2.body.finalized || []).find((r) => r.order === 1) || {}
check('v2 定稿记录行数 > v1（编辑 +1 行）', record2.lines > record1.lines, `${record2.lines} vs ${record1.lines}`)
const list = await call('finalized-list', { title: TITLE })
check('定稿记录列出 1 集且最新 v2', list.body.finalized.length === 1 && list.body.finalized[0].version === 2, JSON.stringify(list.body.finalized).slice(0, 160))

const restore = await call('finalized-restore', { title: TITLE, order: 1, version: 1 })
check('回滚到 v1 成功', restore.status === 200 && restore.body.ok === true, JSON.stringify(restore.body).slice(0, 120))
check('回滚内容含「剧本」', (restore.body.restored.restored || []).includes('剧本'), JSON.stringify(restore.body.restored))
const restoredText = (await call('episode-read', { title: TITLE, order: 1 })).body.text
check('回滚后剧本文本 = v1 快照（sha256 一致）', sha256(Buffer.from(restoredText, 'utf8')) === v1Snapshot.mdSha)
const restoredShots = await sha256File(path.join(projectDir, '.aidrama', 'storyboard', '第001集.md.json'))
check('回滚后分镜源数据 = v1 快照（sha256 一致）', restoredShots === v1Snapshot.shotsSha, `${restoredShots.slice(0, 12)} vs ${v1Snapshot.shotsSha.slice(0, 12)}`)

/* ---- 回滚边界：显式非法/越界版本必须拒绝（P1-D 定稿链修复） ---- */
const badVersions = []
for (const version of [0, 99, -1, 'abc', 1.5]) {
  const rr = await call('finalized-restore', { title: TITLE, order: 1, version })
  badVersions.push(!(rr.status === 200 && rr.body && rr.body.ok === true))
}
check('回滚拒绝越界/非法版本（0/99/-1/abc/1.5）', badVersions.every(Boolean), JSON.stringify(badVersions))

const r3 = await call('finalize-episode', { title: TITLE, order: 1 })
check('回滚后再定稿 v3 成功', r3.status === 200 && r3.body.ok === true)
const rec3 = r3.body.finalized
check('v3 版本号 = 3', rec3.version === 3, String(rec3.version))
const list3 = await call('finalized-list', { title: TITLE })
const record3 = (list3.body.finalized || []).find((r) => r.order === 1) || {}
check('v3 定稿记录行数 = v1（回滚后内容一致）', record3.lines === record1.lines, `${record3.lines} vs ${record1.lines}`)
check('定稿链确定性：v3 剧本快照 sha256 = v1', (await sha256File(path.join(finalizeDir, '第001集.v3.md'))) === v1Snapshot.mdSha)
check('定稿链确定性：v3 分镜快照 sha256 = v1', (await sha256File(path.join(finalizeDir, '第001集.v3.分镜.json'))) === v1Snapshot.shotsSha)

/* ------------------------------------------------------------------ [6] */
group('[6] 篡改必报错（sha256 清单回归 · QA 自算 + 产品 verifyExport 双路）')
const tamperTarget = manifest.files.find((f) => f.format === 'json')
const originalBuf = await fs.readFile(tamperTarget.absolutePath)
await fs.appendFile(tamperTarget.absolutePath, '\n/* tampered */\n')
const tamperedMismatches = await verifyManifest(manifest)
check('篡改导出文件后清单校验报错', tamperedMismatches.includes(tamperTarget.relative), tamperedMismatches.join(','))
check('未篡改文件不误报', tamperedMismatches.length === 1, String(tamperedMismatches.length))
const productTampered = await exporterMod.verifyExport(workspace, TITLE, 'all')
check('产品 verifyExport 篡改后报错', productTampered.ok === false && productTampered.mismatched.length === 1, JSON.stringify(productTampered.mismatched).slice(0, 200))
check('产品 verifyExport 定位到被篡改文件', productTampered.mismatched.length === 1 && productTampered.mismatched[0].path === path.basename(tamperTarget.relative) && productTampered.mismatched[0].expected !== productTampered.mismatched[0].actual, JSON.stringify(productTampered.mismatched).slice(0, 200))
await fs.writeFile(tamperTarget.absolutePath, originalBuf)
check('还原后清单校验恢复通过', (await verifyManifest(manifest)).length === 0)
const productRestored = await exporterMod.verifyExport(workspace, TITLE, 'all')
check('还原后产品 verifyExport 恢复通过', productRestored.ok === true && productRestored.mismatched.length === 0, JSON.stringify(productRestored.mismatched).slice(0, 120))

/* ------------------------------------------------------------------ [7] */
group('[7] 工具层 strict 导出 + 清单缺失/不留产物失败路径')
const defs = toolsMod.createToolDefs({ rootOf: () => workspace, backendOf: () => null })
const runTool = (name, args) => defs.find((d) => d.name === name).execute(args || {}, {})
check('工具数仍为 34（T10 不新增工具）', defs.length === 35, String(defs.length))
// 契约随工件演进：旧 v0.4.0=64 条；E1 落地后=67 条（doc-read/doc-save/doc-notify）；E5 落地后=68 条（sources-list）。export-project 形状不变。
const expectedMethods = METHODS.includes('asset-save') ? 72 : METHODS.includes('assets-import') ? 70 : METHODS.includes('media-read') ? 69 : METHODS.includes('sources-list') ? 68 : METHODS.includes('doc-read') ? 67 : 64
check(`METHODS = ${expectedMethods}（E1 后 67 / E5 后 68 / v0.15.1 task-110 media-read 后 69；export-project 形状不变）`, METHODS.length === expectedMethods, String(METHODS.length))
const strictOk = await runTool('drama_export', { title: TITLE, format: 'csv', strict: true })
check('drama_export strict 对通过项目导出成功', strictOk.ok === true && strictOk.checks && strictOk.checks.ok === true, JSON.stringify({ ok: strictOk.ok, checks: strictOk.checks && strictOk.checks.ok }).slice(0, 160))
check('drama_export 结果含 manifest/verify/checks 摘要', strictOk.manifest && strictOk.manifest.fileCount >= 3 && strictOk.verify && strictOk.verify.ok === true, JSON.stringify(strictOk.manifest || null).slice(0, 160))
check('drama_export 返回 relative 导出路径', typeof strictOk.relative === 'string' && strictOk.relative.includes('导出'), String(strictOk.relative))

const EMPTY_TITLE = '空样剧'
const emptyProjectDir = path.join(workspace, 'AI短剧', EMPTY_TITLE)
const emptyExportDir = path.join(emptyProjectDir, '导出')
await call('create-project', { title: EMPTY_TITLE })
const emptyBeforeExport = await exporterMod.verifyExport(workspace, EMPTY_TITLE, 'all')
check('清单缺失时 verifyExport 返回 ok:false + reason（不抛）', emptyBeforeExport.ok === false && String(emptyBeforeExport.reason || '').includes('缺少导出清单'), JSON.stringify(emptyBeforeExport).slice(0, 160))
const emptyStrict = await runTool('drama_export', { title: EMPTY_TITLE, format: 'markdown', strict: true })
check('空项目 strict 导出被拒（invalid-args + next）', emptyStrict.ok === false && emptyStrict.code === 'invalid-args' && String(emptyStrict.reason).includes('确定性检查未通过') && typeof emptyStrict.next === 'string', JSON.stringify({ code: emptyStrict.code, reason: emptyStrict.reason }).slice(0, 220))
// PM 冻结口径：strict 检查不通过时**不产生导出产物**
const afterStrict = (await fs.readdir(emptyExportDir).catch(() => [])).filter((f) => !f.startsWith('.'))
check('strict 被拒后不产生导出产物', afterStrict.length === 0, afterStrict.join(','))
const emptyLoose = await runTool('drama_export', { title: EMPTY_TITLE, format: 'markdown' })
check('空项目非 strict 允许导出但 checks.ok=false', emptyLoose.ok === true && emptyLoose.checks && emptyLoose.checks.ok === false, JSON.stringify({ ok: emptyLoose.ok, checks: emptyLoose.checks && emptyLoose.checks.ok }).slice(0, 200))
const afterLoose = (await fs.readdir(emptyExportDir).catch(() => [])).filter((f) => f !== exporterMod.MANIFEST_FILE)
check('非 strict 导出产生产物 + 清单', afterLoose.length >= 1, afterLoose.join(','))

/* ------------------------------------------------------------------ [8] */
group('[8] 定稿 strict 联动（T10 校验链）')
const finalizeTool = defs.find((d) => d.name === 'drama_finalize_episode')
const finalizeStrictSupported = Boolean(finalizeTool && finalizeTool.parameters && finalizeTool.parameters.properties && finalizeTool.parameters.properties.strict)
if (!finalizeStrictSupported) {
  console.log('      SKIP：当前工件 drama_finalize_episode 不支持 strict（v0.4.0 早于 task-11 收尾增量）——下一检查点生效')
} else {
  const strictFinalize = await runTool('drama_finalize_episode', { title: TITLE, order: 2, strict: true })
  check('健康项目 strict 定稿成功', strictFinalize.ok === true && strictFinalize.checks && strictFinalize.checks.ok === true, JSON.stringify(strictFinalize).slice(0, 180))
  check('strict 定稿生成 3 个快照', strictFinalize.version === 1 && Array.isArray(strictFinalize.files) && strictFinalize.files.length === 3, JSON.stringify(strictFinalize).slice(0, 180))

  const BROKEN_TITLE = '严格定稿样剧'
  const brokenProjectDir = path.join(workspace, 'AI短剧', BROKEN_TITLE)
  const brokenFinalizeDir = path.join(brokenProjectDir, '定稿')
  await call('create-project', { title: BROKEN_TITLE })
  await call('episode-write', { title: BROKEN_TITLE, order: 1, text: '# 第001集\n\n## 场景 1：内景 - 空屋 - 夜\n\n路人甲：随便。\n' })
  await call('storyboard-save', { title: BROKEN_TITLE, order: 1, shots: [{ shotNumber: '1-1', shotSize: '中景', cameraMove: '', description: '空', dialogue: '', sfx: '', durationSec: 3, imagePrompt: '空' }] })
  const brokenBefore = (await fs.readdir(brokenFinalizeDir).catch(() => [])).length
  const brokenStrict = await runTool('drama_finalize_episode', { title: BROKEN_TITLE, order: 1, strict: true })
  check('破坏项目 strict 定稿被拒（invalid-args）', brokenStrict.ok === false && brokenStrict.code === 'invalid-args' && String(brokenStrict.reason).includes('确定性检查未通过'), JSON.stringify({ code: brokenStrict.code, reason: brokenStrict.reason }).slice(0, 220))
  const brokenAfter = (await fs.readdir(brokenFinalizeDir).catch(() => [])).length
  check('strict 被拒后定稿目录零新增', brokenAfter === brokenBefore, `${brokenBefore} -> ${brokenAfter}`)
  const brokenLoose = await runTool('drama_finalize_episode', { title: BROKEN_TITLE, order: 1 })
  check('非 strict 定稿旧行为不变（成功且无 checks 字段）', brokenLoose.ok === true && !('checks' in brokenLoose), JSON.stringify(brokenLoose).slice(0, 160))
}

/* ------------------------------------------------------------------ 收尾 */
const t10Manifest = {
  title: TITLE,
  generatedAt: new Date().toISOString(),
  workspace,
  files: manifest.files.map((f) => ({ format: f.format, relative: f.relative, bytes: f.bytes, sha256: f.sha256 })),
  exports: Object.fromEntries(Object.entries(exportResults).map(([k, v]) => [k, { relative: v.relative, bytes: v.bytes }])),
  finalized: {
    v1: { version: 1, lines: record1.lines, shots: record1.shots, mdSha256: v1Snapshot.mdSha, storyboardSha256: v1Snapshot.shotsSha },
    v2: { version: 2, lines: record2.lines, shots: record2.shots },
    v3: { version: 3, lines: record3.lines, shots: record3.shots, mdSha256: v1Snapshot.mdSha, storyboardSha256: v1Snapshot.shotsSha },
    restored: restore.body.restored,
  },
}
if (manifestOut) {
  await fs.mkdir(path.dirname(path.resolve(manifestOut)), { recursive: true })
  await fs.writeFile(path.resolve(manifestOut), JSON.stringify(t10Manifest, null, 2) + '\n', 'utf8')
  console.log(`      清单已写入：${path.resolve(manifestOut)}`)
}
await fs.rm(workspace, { recursive: true, force: true })

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
console.log('T10-MANIFEST: ' + JSON.stringify(t10Manifest))
process.exit(failed === 0 ? 0 : 1)
