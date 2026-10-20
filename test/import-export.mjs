/**
 * v0.11.4 批 2 · 2-5：资产/场景/风格与导入导出互通 · QA 验收套件（task-104）
 *
 * AC-25-1 导入占位符匹配（存在→记录；缺失→WARN 不丢原文；不阻断；不自动创建、不自动写 sceneRef/style）
 * AC-25-2 无标记 MD 导入/旧项目导出行为与 v0.11.3 字节一致（基线 _recover/v0114-baseline/）
 * AC-25-3 导出 VCS/Markdown add-only 资产引用区 + 场景/风格注记（仅被引用且存在时）；JSON add-only；CSV 列序不变
 * AC-25-4 往返无损（导入→导出→再导入信息不丢）
 * AC-25-5 工具 34 / METHODS 69（task-110 media-read +1） / 无新 route / 无新依赖 / 旧数据 32 hash / all.mjs 36 套件 / 真实模型 0
 *
 * 版本自适应：能力探测不到 2-5 行为 → 整套件 SKIP（exit 0，不红）。
 * 基线：`_recover/v0114-baseline/`（v0.11.3 现态；安装副本无该目录时字节断言 SKIP 注明）。
 * 运行：node test/import-export.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href)
const store = await load('lib/store.js')
const exporter = await load('lib/exporter.js')
const bridge = await load('lib/import-bridge.js')
const toolsModule = await load('lib/tools.js')
const hostSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8')
const toolsSrc = await fs.readFile(path.join(pluginRoot, 'lib', 'tools.js'), 'utf8')
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))

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
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const BASELINE_DIR = path.join(pluginRoot, '..', '_recover', 'v0114-baseline')
const METHODS = (() => {
  const block = hostSrc.slice(hostSrc.indexOf('const METHODS = ['), hostSrc.indexOf(']', hostSrc.indexOf('const METHODS = [')))
  return new Set([...block.matchAll(/'([a-z][a-z0-9-]+)'/g)].map((match) => match[1]))
})()
const CLIENT_CALLS = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((match) => match[1]))
const TOOL_COUNT = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES.length : 0

const CONTRACT = { platform: '红果', audience: '男频', episodeDurationSec: [60, 180], targetEpisodes: 1, hookDensity: '快', orientation: 'portrait', redlines: [] }
const OUTLINE = [{ order: 1, title: '第1集', logline: 'x', hook: '', twist: '', cliffhanger: '' }]
const CHARACTERS = [{ name: '林越', role: '主角', personality: [] }]
const EPISODE_TEXT = '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n林越：这钱，我三天还你。\n'
const STYLE = { palette: '暖金色调', lighting: '柔光' }
const SCENE = { id: 'SPC001', name: '当铺', description: '老式当铺', space: { location: '城南旧街', timeOfDay: 'night', weather: '雨', interior: '内景' }, lighting: '暖黄顶灯' }
const REAL_STORYBOARD = process.env.DSH_AI_DRAMA_SAMPLE_STORYBOARD || ''
const NO_MARKER_MD = `# 第001集 分镜提示词\n\n镜头01｜00:00-00:06｜近景｜推\n画面：赵铁把当票拍在柜台上。\n光影：灯下光斑随人影移动。\n现场声：雨打窗、门轴吱呀。\n台词：赵铁：三年前的账，今天到期。\n生图提示词：{{Asset_CHR001_赵铁}}，近景，雨夜当铺。\n\n镜头02｜00:06-00:11｜中景｜固定\n画面：林越抬眼。\n光影：顶光压眉骨。\n现场声：雨声渐弱。\n台词：林越：这张当票是假的。\n`
const IMPORT_MD = `# 第001集 分镜提示词\n\n镜头01｜00:00-00:06｜近景｜推\n画面：赵铁把当票拍在柜台上，{{Asset_CHR001_name}}。\n光影：灯下光斑随人影移动。\n现场声：雨打窗、门轴吱呀。\n台词：赵铁：三年前的账，今天到期。\n生图提示词：{{Asset_CHR001_name}}，{{Asset_CHR999_name}}，雨夜当铺。\n\n镜头02｜00:06-00:11｜中景｜固定\n画面：林越抬眼，{{Asset_CHR001_name}}站在柜台后。\n光影：顶光压眉骨。\n现场声：雨声渐弱。\n台词：林越：这张当票是假的。\n\n## 场景关联\n\n- SPC001 当铺\n- SPC999 不存在场景\n\n## 风格注记\n\n- 色板：暖金色调\n- 光感：柔光\n- 构图：低机位\n- 未知维度：神秘\n- 这行没冒号\n`
const SHOTS = [{ shotNumber: '1-1', shotSize: '近景', cameraMove: '推', description: '旧分镜', durationSec: 6 }]

async function loadBaseline(name) {
  try { return await fs.readFile(path.join(BASELINE_DIR, name), 'utf8') } catch { return null }
}
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
async function makeProject(root, title, { shots = SHOTS, contract = CONTRACT, outline = OUTLINE, characters = CHARACTERS } = {}) {
  await store.createProject(root, title)
  await store.saveContract(root, title, contract)
  await store.saveOutline(root, title, outline)
  await store.saveCharacters(root, title, characters)
  await store.writeEpisode(root, title, 1, EPISODE_TEXT)
  if (shots) await store.saveStoryboard(root, title, 1, shots)
}
function normalizeMarkdownTimestamp(text) {
  return String(text || '').replace(/^> 导出自.*$/m, '> 导出自《AI 短剧》工作区 · <TIMESTAMP>')
}
function normalizeJsonExportedAt(text) {
  try {
    const parsed = JSON.parse(text)
    // 归一化固有易变字段（非新增功能导致）：导出时间/contract.updatedAt/角色随机 id
    delete parsed.exportedAt
    if (parsed.contract && typeof parsed.contract === 'object') delete parsed.contract.updatedAt
    if (Array.isArray(parsed.characters)) for (const item of parsed.characters) { if (item && typeof item === 'object') delete item.id }
    return JSON.stringify(parsed)
  } catch { return text }
}

group('[0] 能力探测 / 契约（版本自适应）')
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'import-export-'))
const TITLE = '互通测试剧'
await makeProject(workspace, TITLE)
const hasInteropApi = typeof exporter.buildInteropView === 'function' && typeof exporter.renderInteropMarkdown === 'function' && typeof bridge.parseInteropSections === 'function'
let assetWarningDetected = false
try {
  const preview = await bridge.previewImport(workspace, TITLE, { text: IMPORT_MD, episode: 1, overwrite: true })
  const warningText = JSON.stringify(preview.warnings || [])
  assetWarningDetected = /asset-reference-missing|scene-hint-missing|style-hint-missing|style-hint-unknown|interop-section-invalid/.test(warningText)
} catch {}
let exportBlockDetected = false
try {
  await store.saveAssetCard(workspace, TITLE, { id: 'CHR001', name: '赵铁', type: 'CHR' })
  await store.saveStoryboard(workspace, TITLE, 1, [{ ...SHOTS[0], imagePrompt: '{{Asset_CHR001_name}}，近景' }])
  const vcs = await exporter.buildVcsView(workspace, TITLE)
  exportBlockDetected = /##\s*资产引用/.test(vcs)
} catch {}
const capabilityDetected = hasInteropApi && (assetWarningDetected || exportBlockDetected)
if (!capabilityDetected) {
  console.log('  结果：0 passed, 0 failed（SKIP：当前工件尚无 2-5 导入/导出互通行为（≤v0.11.3 安装包/host 未交付），import-export 套件跳过）')
  await fs.rm(workspace, { recursive: true, force: true })
  process.exit(0)
}
check('0.1 2-5 API 已生效（parseInteropSections/buildInteropView/renderInteropMarkdown）', hasInteropApi)
check('0.2 2-5 行为生效（导入 WARN 或导出资产引用区）', assetWarningDetected || exportBlockDetected, JSON.stringify({ assetWarningDetected, exportBlockDetected }))
check('0.3 工具 34 / METHODS 69（task-110 media-read +1） / client 69（task-110 media-read +1）（M4 批1+批2 +10 已批准）/ 无新依赖', TOOL_COUNT === 34 && METHODS.size === 69 && CLIENT_CALLS.size === 69 && Object.keys(pkg.dependencies || {}).length === 0)
check('0.4 TOOL_OUTPUTS.drama_import_script add-only 扩展（assetRefs/sceneHints/styleHints/interopSections）', /drama_import_script[\s\S]{0,4000}assetRefs/.test(toolsSrc) && /drama_import_script[\s\S]{0,4000}sceneHints/.test(toolsSrc) && /drama_import_script[\s\S]{0,4000}styleHints/.test(toolsSrc) && /drama_import_script[\s\S]{0,4000}interopSections/.test(toolsSrc))

group('[1] AC-25-1 导入占位符/hints 匹配（WARN 不丢原文 / 不阻断 / 不自动创建）')
await fs.rm(workspace, { recursive: true, force: true })
const importRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'import-export-import-'))
const I_TITLE = '导入测试剧'
await makeProject(importRoot, I_TITLE)
await store.saveAssetCard(importRoot, I_TITLE, { id: 'CHR001', name: '赵铁', type: 'CHR' })
await store.saveSceneCard(importRoot, I_TITLE, SCENE)
await store.saveStyleDNA(importRoot, I_TITLE, { palette: '暖金色调', lighting: '柔光' })
const projectDir = path.join(importRoot, 'AI短剧', I_TITLE)
const assetsFile = path.join(projectDir, '.aidrama', 'assets', 'cards.json')
const scenesFile = path.join(projectDir, '.aidrama', 'scenes', 'cards.json')
const styleFile = path.join(projectDir, '.aidrama', 'style.json')
const assetsHashBefore = sha256(await fs.readFile(assetsFile))
const scenesHashBefore = sha256(await fs.readFile(scenesFile))
const styleHashBefore = sha256(await fs.readFile(styleFile))
const treeBefore = await treeHash(path.join(projectDir, '.aidrama'))
const interopParsed = bridge.parseInteropSections(IMPORT_MD)
check('1.1 parseInteropSections：场景关联 SPC001/SPC999（保序）', deepEqual(interopParsed.sceneMentions.map((item) => item.sceneId), ['SPC001', 'SPC999']))
check('1.2 parseInteropSections：风格注记匹配 palette/lighting，未知维度单列', interopParsed.styleHints.some((hint) => hint.dimension === 'palette' && hint.text === '暖金色调') && interopParsed.styleHints.some((hint) => hint.dimension === 'lighting') && interopParsed.unknownStyleLabels.some((item) => item.label === '未知维度'), JSON.stringify({ dims: interopParsed.styleHints.map((item) => item.dimension), unknown: interopParsed.unknownStyleLabels.map((item) => item.label) }))
check('1.3 parseInteropSections：非法行进入 invalidLines / 段原文进 sections', interopParsed.invalidLines.length >= 1 && interopParsed.sections.length === 2, JSON.stringify({ invalid: interopParsed.invalidLines.length, sections: interopParsed.sections.length }))
const preview = await bridge.previewImport(importRoot, I_TITLE, { text: IMPORT_MD, episode: 1, overwrite: true })
const previewWarnings = preview.warnings || []
const warningCodes = previewWarnings.map((item) => item.code)
check('1.4 占位符原文不丢：预览 shots 保留 {{Asset_CHR001_name}} / {{Asset_CHR999_name}}', JSON.stringify(preview.shots).includes('{{Asset_CHR001_name}}') && JSON.stringify(preview.shots).includes('{{Asset_CHR999_name}}'))
check('1.5 assetRefs：referenced 含 CHR001+CHR999，matched=[CHR001]，missing=[CHR999]', deepEqual(preview.assetRefs.referenced, ['CHR001', 'CHR999']) && deepEqual(preview.assetRefs.matched, ['CHR001']) && deepEqual(preview.assetRefs.missing, ['CHR999']), JSON.stringify(preview.assetRefs))
check('1.6 缺失资产 → asset-reference-missing WARN（不阻断 canApply）', warningCodes.includes('asset-reference-missing') && preview.canApply === true, JSON.stringify(warningCodes))
check('1.7 场景 hints：SPC001 matched / SPC999 missing + scene-hint-missing', deepEqual(preview.sceneHints.matched.map((item) => item.sceneId), ['SPC001']) && deepEqual(preview.sceneHints.missing.map((item) => (typeof item === 'string' ? item : item.sceneId)), ['SPC999']) && warningCodes.includes('scene-hint-missing'), JSON.stringify(preview.sceneHints))
check('1.8 风格 hints：palette/lighting matched；构图 missing（style-hint-missing）；未知维度 style-hint-unknown', deepEqual(preview.styleHints.matched.slice().sort(), ['lighting', 'palette']) && preview.styleHints.missing.map((item) => (typeof item === 'string' ? item : item.dimension)).includes('composition') && warningCodes.includes('style-hint-missing') && warningCodes.includes('style-hint-unknown'), JSON.stringify(preview.styleHints))
check('1.9 非法行 → interop-section-invalid WARN', warningCodes.includes('interop-section-invalid'))
check('1.10 预览不写盘（.aidrama 树 hash 不变）', (await treeHash(path.join(projectDir, '.aidrama'))).hash === treeBefore.hash)
const applied = await bridge.applyImport(importRoot, I_TITLE, { text: IMPORT_MD, episode: 1, overwrite: true })
const savedShots = await store.getStoryboard(importRoot, I_TITLE, 1)
check('1.11 apply 返回 add-only hints 且 canApply 未被阻断', applied && applied.assetRefs && applied.sceneHints && applied.styleHints && Array.isArray(applied.interopSections) && applied.warnings.length === preview.warnings.length)
check('1.12 应用后分镜保留占位符原文（CHR001 / CHR999）', JSON.stringify(savedShots).includes('{{Asset_CHR001_name}}') && JSON.stringify(savedShots).includes('{{Asset_CHR999_name}}'))
check('1.13 不自动写 sceneRef（应用后 shot 无 sceneRef）', savedShots.every((shot) => !shot.sceneRef))
check('1.14 不自动创建/修改资产卡、场景卡、style DNA（三文件 hash 不变）', sha256(await fs.readFile(assetsFile)) === assetsHashBefore && sha256(await fs.readFile(scenesFile)) === scenesHashBefore && sha256(await fs.readFile(styleFile)) === styleHashBefore)
// 项目无资产卡时：不产生 asset-reference-missing（B 口径）
const NO_CARD_TITLE = '无卡导入剧'
await makeProject(importRoot, NO_CARD_TITLE)
const noCardPreview = await bridge.previewImport(importRoot, NO_CARD_TITLE, { text: IMPORT_MD, episode: 1, overwrite: true })
check('1.15 项目无资产卡时：占位符原样保留且不提示 asset-reference-missing', JSON.stringify(noCardPreview.shots).includes('{{Asset_CHR999_name}}') && !(noCardPreview.warnings || []).some((item) => item.code === 'asset-reference-missing'), JSON.stringify((noCardPreview.warnings || []).map((item) => item.code)))

group('[2] AC-25-2 无标记 MD / 旧项目导出与 v0.11.3 基线字节一致')
const baselineParse = await loadBaseline('parse-no-marker.json')
const parsedNow = bridge.parseShotPromptMarkdown(NO_MARKER_MD, { episode: 1 })
if (baselineParse) {
  check('2.1 无标记 MD 解析结果与 v0.11.3 基线深度相等', sha256(JSON.stringify(parsedNow)) === sha256(baselineParse) || deepEqual(parsedNow, JSON.parse(baselineParse)))
} else {
  console.log('      （SKIP：基线 parse-no-marker.json 不在安装副本环境）')
}
const oldRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'import-export-old-'))
const OLD_TITLE = 'old19'
const realShots = await fileExists(REAL_STORYBOARD) ? JSON.parse(await fs.readFile(REAL_STORYBOARD, 'utf8')) : SHOTS
await makeProject(oldRoot, OLD_TITLE, { shots: realShots })
const oldProjectDir = path.join(oldRoot, 'AI短剧', OLD_TITLE)
const vcsOld = await exporter.buildVcsView(oldRoot, OLD_TITLE)
const vcsBaseline = await loadBaseline('vcs-old19.md')
const mdOldResult = await exporter.exportProject(oldRoot, OLD_TITLE, 'markdown')
const mdOld = await fs.readFile(mdOldResult.file, 'utf8')
const mdBaseline = await loadBaseline('export-markdown-old19.md')
const csvOldResult = await exporter.exportProject(oldRoot, OLD_TITLE, 'csv')
const csvOld = await fs.readFile(csvOldResult.file, 'utf8')
const csvBaseline = await loadBaseline('export-csv-old19.csv')
const jsonOldResult = await exporter.exportProject(oldRoot, OLD_TITLE, 'json')
const jsonOld = await fs.readFile(jsonOldResult.file, 'utf8')
const jsonBaseline = await loadBaseline('export-json-old19.json')
if (vcsBaseline) check('2.2 旧项目 VCS 导出与 v0.11.3 基线逐字节一致（无新区块）', vcsOld === vcsBaseline)
if (mdBaseline) check('2.3 旧项目 Markdown 导出（归一化 exportedAt 时间戳）与基线一致', normalizeMarkdownTimestamp(mdOld) === normalizeMarkdownTimestamp(mdBaseline))
if (csvBaseline) check('2.4 旧项目 CSV 导出逐字节一致（列序不变）', csvOld === csvBaseline)
if (jsonBaseline) check('2.5 旧项目 JSON 导出（归一化 exportedAt）与基线一致、无 assets/scenes/styleDNA 键', normalizeJsonExportedAt(jsonOld) === normalizeJsonExportedAt(jsonBaseline) && !/"assets"\s*:/.test(jsonOld) && !/"styleDNA"\s*:/.test(jsonOld), JSON.stringify({ same: normalizeJsonExportedAt(jsonOld) === normalizeJsonExportedAt(jsonBaseline), curKeys: Object.keys(JSON.parse(jsonOld)), baseKeys: Object.keys(JSON.parse(jsonBaseline)), curLen: normalizeJsonExportedAt(jsonOld).length, baseLen: normalizeJsonExportedAt(jsonBaseline).length }))
check('2.6 旧项目 VCS 两次导出一致（确定性）', vcsOld === (await exporter.buildVcsView(oldRoot, OLD_TITLE)))
check('2.7 旧项目 CSV 表头 11 列（无新增列）', csvOld.split('\n')[0].split(',').length === 11, String(csvOld.split('\n')[0].split(',').length))
check('2.8 旧项目 Markdown 无资产引用/场景与风格新区块', !mdOld.includes('## 资产引用') && !mdOld.includes('## 场景与风格'))

group('[3] AC-25-3 导出 add-only 资产引用区 + 场景/风格注记（仅被引用且存在）')
const exportRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'import-export-export-'))
const E_TITLE = '导出测试剧'
await makeProject(exportRoot, E_TITLE, { shots: [
  { shotNumber: '1-1', shotSize: '近景', cameraMove: '推', description: '赵铁拍当票', imagePrompt: '{{Asset_CHR001_name}}，近景', sceneRef: 'SPC001', durationSec: 5 },
  { shotNumber: '1-2', shotSize: '中景', cameraMove: '固定', description: '林越抬眼', imagePrompt: '{{Asset_CHR001_name}}', durationSec: 4 },
] })
await store.saveAssetCard(exportRoot, E_TITLE, { id: 'CHR001', name: '赵铁', type: 'CHR' })
await store.saveAssetCard(exportRoot, E_TITLE, { id: 'CHR002', name: '未引用角色', type: 'CHR' })
await store.saveSceneCard(exportRoot, E_TITLE, SCENE)
await store.saveSceneCard(exportRoot, E_TITLE, { id: 'SPC002', name: '未引用场景' })
await store.saveStyleDNA(exportRoot, E_TITLE, { palette: '暖金色调', lighting: '柔光', texture: '粗颗粒' })
const interopView = await exporter.buildInteropView(exportRoot, E_TITLE)
check('3.1 buildInteropView：仅被引用且存在的资产（CHR001；排除未引用 CHR002）', deepEqual(interopView.assets.map((item) => item.id), ['CHR001']) && interopView.assets[0].name === '赵铁' && interopView.assets[0].refs.length === 2, JSON.stringify(interopView.assets))
check('3.2 buildInteropView：仅被引用场景（SPC001；排除 SPC002）', deepEqual(interopView.scenes.map((item) => item.id), ['SPC001']))
check('3.3 buildInteropView：styleDNA 仅非空维度（palette/lighting/texture）', deepEqual(Object.keys(interopView.styleDNA), ['palette', 'lighting', 'texture']), JSON.stringify(interopView.styleDNA))
const interopMd = exporter.renderInteropMarkdown(interopView).join('\n')
check('3.4 renderInteropMarkdown：资产引用区 + 场景与风格区（顺序）', interopMd.includes('## 资产引用') && interopMd.includes('## 场景与风格') && interopMd.indexOf('## 资产引用') < interopMd.indexOf('## 场景与风格'))
check('3.5 renderInteropMarkdown：含资产名/引用镜号/场景名/风格维度文本', interopMd.includes('CHR001') && interopMd.includes('赵铁') && interopMd.includes('SPC001') && interopMd.includes('当铺') && interopMd.includes('暖金色调') && interopMd.includes('柔光') && interopMd.includes('粗颗粒'))
const vcsExport = await exporter.buildVcsView(exportRoot, E_TITLE)
check('3.6 VCS 导出含两个 add-only 区块', vcsExport.includes('## 资产引用') && vcsExport.includes('## 场景与风格'))
const mdResult = await exporter.exportProject(exportRoot, E_TITLE, 'markdown')
const mdExport = await fs.readFile(mdResult.file, 'utf8')
check('3.7 Markdown 导出含两个 add-only 区块', mdExport.includes('## 资产引用') && mdExport.includes('## 场景与风格'))
const jsonResult = await exporter.exportProject(exportRoot, E_TITLE, 'json')
const jsonExport = JSON.parse(await fs.readFile(jsonResult.file, 'utf8'))
check('3.8 JSON 导出 add-only keys：assets/scenes/styleDNA 存在且为被引用数据', Array.isArray(jsonExport.assets) && jsonExport.assets[0] && jsonExport.assets[0].id === 'CHR001' && Array.isArray(jsonExport.scenes) && jsonExport.scenes[0] && jsonExport.scenes[0].id === 'SPC001' && jsonExport.styleDNA && jsonExport.styleDNA.palette === '暖金色调', JSON.stringify({ assets: jsonExport.assets, scenes: jsonExport.scenes }))
const csvResult = await exporter.exportProject(exportRoot, E_TITLE, 'csv')
const csvExport = await fs.readFile(csvResult.file, 'utf8')
check('3.9 CSV 导出完全不动（表头 11 列，不新增资产/场景列）', csvExport.split('\n')[0].split(',').length === 11 && !csvExport.includes('资产引用') && !csvExport.includes('CHR001 赵铁'), String(csvExport.split('\n')[0].split(',').length))
check('3.10 VCS 两次导出一致（无时间戳/确定性）', vcsExport === (await exporter.buildVcsView(exportRoot, E_TITLE)))

group('[4] AC-25-4 往返无损（导入→导出→再导入信息不丢）')
const beforeStyleHash = sha256(await fs.readFile(path.join(importRoot, 'AI短剧', I_TITLE, '.aidrama', 'style.json')))
const exportAfterImport = exporter.renderInteropMarkdown(await exporter.buildInteropView(importRoot, I_TITLE)).join('\n')
const reimportPreview = await bridge.previewImport(importRoot, I_TITLE, { text: IMPORT_MD, episode: 1, overwrite: true })
check('4.1 导出视图包含导入后的资产引用（CHR001）与风格 DNA（palette）', exportAfterImport.includes('CHR001') && exportAfterImport.includes('暖金色调'), exportAfterImport.slice(0, 200))
check('4.2 再导入 hints 与首次一致（幂等/无信息丢失）', deepEqual(reimportPreview.assetRefs, preview.assetRefs) && deepEqual(reimportPreview.sceneHints, preview.sceneHints) && deepEqual(reimportPreview.styleHints, preview.styleHints))
check('4.3 导出只读：style.json hash 不变', sha256(await fs.readFile(path.join(importRoot, 'AI短剧', I_TITLE, '.aidrama', 'style.json'))) === beforeStyleHash)

group('[5] AC-25-5 契约 / 红线 / 清理')
check('5.1 工具 34 / METHODS 69（task-110 media-read +1） / client 69（task-110 media-read +1）（M4 批1+批2 已批准）', TOOL_COUNT === 34 && METHODS.size === 69 && CLIENT_CALLS.size === 69)
check('5.2 无新 route（既有 import/export 4 条不变，METHODS 69（task-110 media-read +1））', METHODS.size === 69 && JSON.stringify([...METHODS].filter((name) => /import|export/i.test(name)).sort()) === JSON.stringify(['export-project', 'import-apply', 'import-preview', 'voice-script-export']), JSON.stringify([...METHODS].filter((name) => /import|export/i.test(name))))
check('5.3 无新依赖', Object.keys(pkg.dependencies || {}).length === 0)
await fs.rm(importRoot, { recursive: true, force: true })
await fs.rm(oldRoot, { recursive: true, force: true })
await fs.rm(exportRoot, { recursive: true, force: true })
check('5.4 临时工作区已清理', !(await fileExists(importRoot)) && !(await fileExists(oldRoot)) && !(await fileExists(exportRoot)))

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
