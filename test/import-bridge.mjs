/**
 * v0.10.1 B0-C（task-81）· 导入桥 + VCS 视图 · 离线验收套件（QA）
 *
 * 覆盖 Lead/PM 验收要求：
 *   [A] 解析/预览：三样本（海城麻鹰 v2/v1、万界倒爷分镜 MD）解析必要字段；预览只读不写盘；
 *   [B] 应用：v2 落盘 shot 字段 light/ambientSound/dialogue + groups sidecar；JSON 导出 storyboardGroups；
 *   [C] VCS 视图：确定性输出、可用 parser 回读（镜数/台词/光影/现场声/资产占位符无损）；
 *   [D] 覆盖：无 overwrite → conflict；overwrite 后成功；无分组输入不触碰既有 sidecar；
 *   [E] 事务回滚：构造分镜 MD 写失败 → storyboard/groups 恢复原内容；
 *   [F] 只读：三样本源文件/真实项目只读 hash 前后不变；非法输入 → invalid-args；
 *   [G] 契约：工具 34 / METHODS 69（task-110 media-read +1） 不变；EXPORT_FORMATS 只增 vcs；README 含用法。
 *
 * 版本自适应：v0.10.0 及更早安装副本无 lib/import-bridge.js → 整个套件 SKIP（exit 0，不红）。
 * 运行：node test/import-bridge.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const importBridgePath = path.join(pluginRoot, 'lib', 'import-bridge.js')

let passed = 0
let failed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) { passed += 1 } else {
    failed += 1
    failures.push(`${label}${detail ? ' -> ' + detail : ''}`)
    console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`)
  }
}
function group(name) { console.log('\n' + name) }
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const fileExists = (file) => fs.access(file).then(() => true, () => false)
async function treeHash(target) {
  const hash = createHash('sha256')
  let count = 0
  async function walk(current, rel) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      const relPath = path.join(rel, entry.name)
      if (entry.isDirectory()) await walk(full, relPath)
      else if (entry.isFile()) { hash.update(`${relPath}|`); hash.update(await fs.readFile(full)); count += 1 }
    }
  }
  await walk(target, '')
  return { hash: hash.digest('hex'), count }
}

/* ------------------------------------------------------ [0] 能力探测（版本自适应） */
group('[0] 能力探测（版本自适应）')
if (!(await fileExists(importBridgePath))) {
  console.log('  结果：0 passed, 0 failed（SKIP：当前工件无 lib/import-bridge.js（v0.10.1 前安装包），导入桥套件跳过）')
  process.exit(0)
}
const bridge = await import(pathToFileURL(importBridgePath).href)
const store = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'store.js')).href)
const exporter = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'exporter.js')).href)
const hostSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const toolsSrc = await fs.readFile(path.join(pluginRoot, 'lib', 'tools.js'), 'utf8')
const readmeSrc = await fs.readFile(path.join(pluginRoot, 'README.md'), 'utf8').catch(() => '')
const methodsBlock = hostSrc.slice(hostSrc.indexOf('const METHODS = ['), hostSrc.indexOf(']', hostSrc.indexOf('const METHODS = [')))
const methods = new Set([...methodsBlock.matchAll(/'([a-z][a-z0-9-]+)'/g)].map((match) => match[1]))
const toolsModule = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'tools.js')).href)
const toolNames = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES : [...toolsSrc.matchAll(/name: '(drama_[a-z_]+)'/g)].map((match) => match[1])
check('lib/import-bridge.js 存在且导出 parseShotPromptMarkdown/previewImport/applyImport', typeof bridge.parseShotPromptMarkdown === 'function' && typeof bridge.previewImport === 'function' && typeof bridge.applyImport === 'function')
check('EXPORT_FORMATS 只增 vcs（markdown/json/csv 仍在）', Array.isArray(exporter.EXPORT_FORMATS) && ['markdown', 'json', 'csv', 'vcs'].every((format) => exporter.EXPORT_FORMATS.includes(format)), JSON.stringify(exporter.EXPORT_FORMATS))
check('exporter.buildVcsView 可用', typeof exporter.buildVcsView === 'function')
check('METHODS 含 import-preview/import-apply（且总数 68 不变）', methods.has('import-preview') && methods.has('import-apply') && methods.size === 69, String(methods.size))
check('工具面 34 不变且含 drama_import_script', toolNames.length === 34 && toolNames.includes('drama_import_script'), String(toolNames.length))
check('README 含 shot-prompt / vcs 用法说明', /shot-prompt/.test(readmeSrc) && /vcs|VCS/.test(readmeSrc))

const TITLE = 'import-bridge-test'
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-bridge-'))
const projectDir = path.join(workspace, 'AI短剧', TITLE)
const storyboardPath = path.join(projectDir, '.aidrama', 'storyboard', '第001集.md.json')
const groupsPath = path.join(projectDir, '.aidrama', 'storyboard-groups', '第001集.md.json')
const storyboardMdPath = path.join(projectDir, '分镜', '第001集.分镜.md')
await store.createProject(workspace, TITLE)
await store.writeEpisode(workspace, TITLE, 1, '# 第001集 分镜提示词\n\n## 场景 1：内景 - 当铺 - 夜\n\n赵铁：还钱。\n林越：三天后。\n')

/* 合成草帽式镜头块样本（不依赖外部文件，保证可移植） */
const SYNTHETIC_V2 = `# 第001集 分镜提示词

## 全组情绪总控
情绪曲线：压抑 → 警觉 → 爆发
强度：70/100
禁止第二种天气。

镜头01｜00:00-00:06｜近景｜推
画面：赵铁把假当票拍在柜台上，雨气从门缝涌进来。
光影：灯下光斑随人影移动，冷白顶光压住眉骨。
现场声：雨打窗、门轴吱呀。
台词：赵铁：三年前的账，今天到期。
生图提示词：{{Asset_CHR001_赵铁}}，近景，雨夜当铺，冷光。

镜头02｜00:06-00:11｜中景｜固定
画面：林越抬眼，手指按住当票背面。
光影：柜台侧光，暗部占画面三分之二。
现场声：雨声渐弱，衣料摩擦。
台词：林越：这张当票，是假的。
`
const SYNTHETIC_NO_GROUP = `# 第001集 分镜提示词

镜头01｜00:06｜近景｜推
画面：赵铁拍桌。
光影：顶光。
现场声：雨声。
台词：赵铁：还钱。
`
const SYNTHETIC_TABLE = `# 第001集 分镜表

| 镜号 | 景别 | 运镜 | 画面描述 | 台词 | 音效 | 时长(秒) | 提示词 |
|---|---|---|---|---|---|---|---|
| 1 | 近景 | 推 | 赵铁拍桌 | 赵铁：还钱。 | 雨声 | 6 | 近景，冷光 |
| 2 | 中景 | 固定 | 林越抬眼 | 林越：假的。 | 雨声 | 5 | 中景，侧光 |
`

/* ------------------------------------------------------ [A] 解析 + 预览只读 */
group('[A] 解析 + 预览只读（不写盘）')
const parsed = bridge.parseShotPromptMarkdown(SYNTHETIC_V2, { episode: 1 })
check('A1 解析合成草帽块：2 镜 + 1 分组', parsed.shots.length === 2 && parsed.groups.length === 1, JSON.stringify({ shots: parsed.shots.length, groups: parsed.groups.length }))
check('A2 字段解析：景别/运镜/时长', parsed.shots[0].shotSize === '近景' && parsed.shots[0].cameraMove === '推' && parsed.shots[0].durationSec === 6, JSON.stringify({ size: parsed.shots[0].shotSize, move: parsed.shots[0].cameraMove, dur: parsed.shots[0].durationSec }))
check('A3 light/ambientSound/dialogue 全提取（覆盖率 100%）', parsed.coverage.light === 100 && parsed.coverage.ambientSound === 100 && parsed.coverage.dialogue === 100, JSON.stringify(parsed.coverage))
check('A4 资产占位符识别（{{Asset_*}} 原样保留）', parsed.stats.assets === 1 && /Asset_CHR001_赵铁/.test(parsed.shots[0].imagePrompt || ''), JSON.stringify({ assets: parsed.stats.assets, prompt: parsed.shots[0].imagePrompt }))
check('A5 分组映射：全组情绪总控 → groups[0]（含 notes/镜号）', parsed.groups[0].name === '全组情绪总控' && parsed.groups[0].shotNumbers.length === 2 && /情绪曲线/.test(parsed.groups[0].notes || ''), JSON.stringify(parsed.groups[0]).slice(0, 200))
const tableParsed = bridge.parseShotPromptMarkdown(SYNTHETIC_TABLE, { episode: 1 })
check('A6 表格型分镜表解析：2 镜/景别/时长', tableParsed.format === 'table' && tableParsed.shots.length === 2 && tableParsed.shots[1].shotSize === '中景' && tableParsed.shots[0].durationSec === 6, JSON.stringify({ format: tableParsed.format, shots: tableParsed.shots.length }))
const beforePreview = await treeHash(projectDir)
const previewV2 = await bridge.previewImport(workspace, TITLE, { text: SYNTHETIC_V2, episode: 1 })
const previewNoGroup = await bridge.previewImport(workspace, TITLE, { text: SYNTHETIC_NO_GROUP, episode: 1 })
const afterPreview = await treeHash(projectDir)
check('A7 预览只读：项目目录 hash 前后一致（无 storyboard/sidecar 生成）', beforePreview.hash === afterPreview.hash && beforePreview.count === afterPreview.count, JSON.stringify({ before: beforePreview.count, after: afterPreview.count }))
check('A8 preview 形状：shots/groups/diff/conflicts/canApply', Array.isArray(previewV2.shots) && Array.isArray(previewV2.groups) && previewV2.diff && Array.isArray(previewV2.conflicts) && previewV2.canApply === true, JSON.stringify(Object.keys(previewV2)))
check('A9 无分组样本：groups=[]（不虚构分组）', previewNoGroup.groups.length === 0 && previewNoGroup.shots.length === 1)

/* ------------------------------------------------------ [B] 应用 + JSON 导出 */
group('[B] 应用导入（写盘 + sidecar + JSON 导出）')
const applied = await bridge.applyImport(workspace, TITLE, { text: SYNTHETIC_V2, episode: 1 })
const diskShots = JSON.parse(await fs.readFile(storyboardPath, 'utf8'))
check('B1 应用成功：2 镜落盘', applied.shots === 2 && diskShots.length === 2, JSON.stringify({ applied: applied.shots, disk: diskShots.length }))
check('B2 落盘字段：light/ambientSound/dialogue/naturalLanguagePrompt 齐备', diskShots.every((shot) => shot.light && shot.ambientSound) && diskShots[0].dialogue.includes('赵铁') && Boolean(diskShots[0].naturalLanguagePrompt), JSON.stringify(diskShots[0]).slice(0, 240))
check('B3 groups sidecar 已写入（groupsSaved=true）', applied.groupsSaved === true && applied.groups === 1 && (await fileExists(groupsPath)), JSON.stringify({ groups: applied.groups }))
const jsonExport = await exporter.exportProject(workspace, TITLE, 'json')
const jsonObj = JSON.parse(await fs.readFile(jsonExport.file, 'utf8'))
check('B4 JSON 导出 add-only 顶层 storyboardGroups（仅存在时）', Array.isArray(jsonObj.storyboardGroups?.['1']) && jsonObj.storyboardGroups['1'].length === 1, JSON.stringify(jsonObj.storyboardGroups && Object.keys(jsonObj.storyboardGroups)))

/* ------------------------------------------------------ [C] VCS 视图确定性 + 往返 */
group('[C] VCS 视图：确定性 + 回读往返（镜数/台词/光影/现场声/资产占位符）')
const vcs1 = await exporter.buildVcsView(workspace, TITLE)
const vcs2 = await exporter.buildVcsView(workspace, TITLE)
const assetCount = (text) => (String(text).match(/\{\{Asset_[A-Za-z]+[0-9]+_[^{}]*\}\}/g) || []).length
check('C1 VCS 视图确定性：两次输出字节一致', vcs1 === vcs2 && vcs1.length > 0, `bytes=${vcs1.length}`)
check('C2 VCS 视图含镜号与分组章节', /镜头0?1/.test(vcs1) && /分组情绪总控|全组情绪总控/.test(vcs1), vcs1.slice(0, 120))
const vcsExport1 = await exporter.exportProject(workspace, TITLE, 'vcs')
const vcsBytes1 = await fs.readFile(vcsExport1.file, 'utf8')
const vcsExport2 = await exporter.exportProject(workspace, TITLE, 'vcs')
const vcsBytes2 = await fs.readFile(vcsExport2.file, 'utf8')
check('C3 exportProject(vcs) 落盘文件确定性（两次一致）', vcsBytes1 === vcsBytes2 && vcsExport1.file.endsWith('-VCS视图.md'), path.basename(vcsExport1.file))
const roundtrip = bridge.parseShotPromptMarkdown(vcsBytes1, { episode: 1 })
// VCS 视图同时含原始文本段与规范化镜块，parser 可能识别重复镜号；按镜号去重后与磁盘比对
const roundtripByNumber = new Map()
for (const shot of roundtrip.shots) if (!roundtripByNumber.has(String(shot.shotNumber))) roundtripByNumber.set(String(shot.shotNumber), shot)
check('C4 VCS 回读：按镜号去重后镜数不变', roundtripByNumber.size === diskShots.length, JSON.stringify({ unique: roundtripByNumber.size, parsed: roundtrip.shots.length, disk: diskShots.length }))
let dialogueEq = 0, lightEq = 0, ambientEq = 0
for (const source of diskShots) {
  const target = roundtripByNumber.get(String(source.shotNumber))
  if (!target) continue
  if ((source.dialogue || '') === (target.dialogue || '')) dialogueEq += 1
  if ((source.light || '') === (target.light || '')) lightEq += 1
  if ((source.ambientSound || '') === (target.ambientSound || '')) ambientEq += 1
}
check('C5 VCS 往返：台词/光影/现场声逐镜无损', dialogueEq === diskShots.length && lightEq === diskShots.length && ambientEq === diskShots.length, JSON.stringify({ dialogueEq, lightEq, ambientEq, total: diskShots.length }))
check('C6 VCS 往返：资产占位符数量保留（与磁盘一致且 ≥1）', assetCount(vcsBytes1) === assetCount(JSON.stringify(diskShots)) && assetCount(vcsBytes1) >= 1 && /Asset_CHR001_赵铁/.test(vcsBytes1), JSON.stringify({ vcs: assetCount(vcsBytes1), disk: assetCount(JSON.stringify(diskShots)) }))

/* ------------------------------------------------------ [D] 覆盖语义 */
group('[D] 覆盖：无 overwrite → conflict；overwrite 成功；无分组不触碰既有 sidecar')
let conflictError = null
try {
  await bridge.applyImport(workspace, TITLE, { text: SYNTHETIC_V2, episode: 1 })
} catch (error) { conflictError = error }
check('D1 已有分镜且无 overwrite → conflict（拒绝覆盖）', conflictError && conflictError.code === 'conflict', conflictError && String(conflictError.message).slice(0, 120))
const groupsHashBefore = sha256(await fs.readFile(groupsPath))
await bridge.applyImport(workspace, TITLE, { text: SYNTHETIC_NO_GROUP, episode: 1, overwrite: true })
const diskNoGroup = JSON.parse(await fs.readFile(storyboardPath, 'utf8'))
const groupsHashAfter = sha256(await fs.readFile(groupsPath))
check('D2 overwrite=true 后覆盖成功（1 镜）', diskNoGroup.length === 1, String(diskNoGroup.length))
check('D3 无分组输入不触碰既有 sidecar（hash 不变）', groupsHashBefore === groupsHashAfter, JSON.stringify({ before: groupsHashBefore.slice(0, 12), after: groupsHashAfter.slice(0, 12) }))

/* ------------------------------------------------------ [E] 事务回滚（构造分镜 MD 写失败） */
group('[E] 事务回滚：分镜 MD 写失败 → storyboard/groups 恢复')
await bridge.applyImport(workspace, TITLE, { text: SYNTHETIC_V2, episode: 1, overwrite: true })
const rollbackBefore = { storyboard: sha256(await fs.readFile(storyboardPath)), groups: sha256(await fs.readFile(groupsPath)) }
const storyboardDir = path.join(projectDir, '分镜')
const storyboardDirBackup = path.join(projectDir, '分镜_backup_for_test')
await fs.rename(storyboardDir, storyboardDirBackup)
await fs.writeFile(storyboardDir, 'block-md-write', 'utf8')
let rollbackError = null
try {
  await bridge.applyImport(workspace, TITLE, { text: SYNTHETIC_V2, episode: 1, overwrite: true })
} catch (error) { rollbackError = error }
await fs.rm(storyboardDir, { force: true })
await fs.rename(storyboardDirBackup, storyboardDir)
check('E1 构造 MD 写失败 → 应用抛错（不静默成功）', Boolean(rollbackError), rollbackError && String(rollbackError.message).slice(0, 100))
check('E2 回滚后 storyboard JSON 恢复原内容（hash 一致）', sha256(await fs.readFile(storyboardPath)) === rollbackBefore.storyboard)
check('E3 回滚后 groups sidecar 恢复原内容（hash 一致）', sha256(await fs.readFile(groupsPath)) === rollbackBefore.groups)

/* ------------------------------------------------------ [F] 只读样本 + 非法输入 */
group('[F] 只读样本 hash 不变 + 非法输入 invalid-args')
const SAMPLE_FILES = {
  maYingV2: process.env.DSH_AI_DRAMA_SAMPLE_MAYING_V2 || '',
  maYingV1: process.env.DSH_AI_DRAMA_SAMPLE_MAYING_V1 || '',
  wanJieMd: process.env.DSH_AI_DRAMA_SAMPLE_WANJIE_MD || '',
}
const SAMPLES_AVAILABLE = {}
for (const [key, file] of Object.entries(SAMPLE_FILES)) SAMPLES_AVAILABLE[key] = await fileExists(file)
const sampleHashesBefore = {}
for (const [key, file] of Object.entries(SAMPLE_FILES)) if (SAMPLES_AVAILABLE[key]) sampleHashesBefore[key] = sha256(await fs.readFile(file))
if (SAMPLES_AVAILABLE.maYingV2) {
  const realV2 = bridge.parseShotPromptMarkdown(await fs.readFile(SAMPLE_FILES.maYingV2, 'utf8'), { episode: 1 })
  check('F1 真实样本 海城麻鹰 v2：6 镜/1 分组/时长·光影·现场声 100%', realV2.shots.length === 6 && realV2.groups.length === 1 && realV2.coverage.durationSec === 100 && realV2.coverage.light === 100 && realV2.coverage.ambientSound === 100, JSON.stringify(realV2.coverage))
}
if (SAMPLES_AVAILABLE.maYingV1) {
  const realV1 = bridge.parseShotPromptMarkdown(await fs.readFile(SAMPLE_FILES.maYingV1, 'utf8'), { episode: 1 })
  check('F2 真实样本 海城麻鹰 v1：4 镜/无分组/全局段保留 importedGlobalSections', realV1.shots.length === 4 && realV1.groups.length === 0 && Array.isArray(realV1.shots[0].importedGlobalSections) && realV1.shots[0].importedGlobalSections.length >= 3, JSON.stringify({ shots: realV1.shots.length, global: realV1.shots[0].importedGlobalSections && realV1.shots[0].importedGlobalSections.length }))
}
if (SAMPLES_AVAILABLE.wanJieMd) {
  const realWj = bridge.parseShotPromptMarkdown(await fs.readFile(SAMPLE_FILES.wanJieMd, 'utf8'), { episode: 1 })
  check('F3 真实样本 万界倒爷分镜 MD：19 镜/关键字段 100%/资产占位符 ≥27', realWj.shots.length === 19 && realWj.coverage.description === 100 && realWj.coverage.dialogue === 100 && realWj.stats.assets >= 27, JSON.stringify({ shots: realWj.shots.length, assets: realWj.stats.assets }))
}
for (const [key, file] of Object.entries(SAMPLE_FILES)) if (SAMPLES_AVAILABLE[key]) check(`F4 只读样本 ${key} hash 前后不变`, sha256(await fs.readFile(file)) === sampleHashesBefore[key])
const invalidCases = [
  ['空内容', () => bridge.parseShotPromptMarkdown('', { episode: 1 })],
  ['无任何镜头', () => bridge.parseShotPromptMarkdown('# 空文件\n\n没有镜头块', { episode: 1 })],
  ['非字符串', () => bridge.parseShotPromptMarkdown(42, { episode: 1 })],
]
let invalidOk = 0
const invalidDetails = []
for (const [label, run] of invalidCases) {
  try { run(); invalidDetails.push(label + ':未抛错') } catch (error) {
    if (error.code === 'invalid-args' || /为空|未从 MD|不是字符串/.test(String(error.message))) invalidOk += 1
    else invalidDetails.push(label + ':' + error.code + '/' + String(error.message).slice(0, 60))
  }
}
check('F5 非法输入 → invalid-args（空内容/无镜头/类型错误）', invalidOk === invalidCases.length, JSON.stringify(invalidDetails))

/* ------------------------------------------------------ [G] 契约 + 清理 */
group('[G] 契约与清理')
check('G1 METHODS 69（task-110 media-read +1） 且新增 import-preview/import-apply 为 only-add', methods.size === 69 && methods.has('import-preview') && methods.has('import-apply'))
check('G2 工具面 34 不变（无新增工具）', toolNames.length === 34, String(toolNames.length))
check('G3 EXPORT_FORMATS = markdown/json/csv/vcs（旧格式不变）', JSON.stringify(exporter.EXPORT_FORMATS) === JSON.stringify(['markdown', 'json', 'csv', 'vcs']), JSON.stringify(exporter.EXPORT_FORMATS))
await fs.rm(workspace, { recursive: true, force: true })
check('G4 测试临时工作区已清理', !(await fileExists(workspace)))

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
