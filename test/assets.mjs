/**
 * v0.11.0 批 2 · 2-1 资产体系 + 2-3 资产质量门禁 · QA 验收套件（task-95）
 *
 * AC-A1…A10（2-1，host task-93 交付）：
 *   A1 编号规范（9 前缀/3 位/变体 _01–_99/大小写归一/非法拒绝/确定性）
 *   A2 资产卡 schema（必填 id/type/name、type 枚举、status canonical + 读归 archived→retired/未知→draft、无时间戳）
 *   A3 旧项目无 assets 只读回退（返回 []、不建目录/不写文件/不报错）+ legacy .aidrama/assets.json 零改动 + cards.json 单文件
 *   A4 重复 ID（含大小写归一）拒绝且不写盘；非法编号/非法 status 不写盘
 *   A5 占位符解析/原样保留/引用存在性（存在 PASS、缺失/非法 WARN）
 *   A6 subject/groupId 文本原生宽松匹配
 *   A7 version 递增 + history add-only（不覆盖旧记录/未提供字段沿用旧卡/expectedVersion 冲突）
 *   A8 确定性（两独立项目同输入 cards.json 字节一致；normalize 幂等；按 id 排序；v1 无时间戳）+ variantOf/aliases 约束
 *   A9 工具 34 / METHODS 68 / client 调用 68（M4 批1+批2 +10 已批准）/ 无新依赖
 *   A10 all.mjs 32 套件 0 failed（本套件为第 32 套件）+ 旧数据 32 hash（套件外复核）
 *
 * 版本自适应：无 `lib/assets.js`（≤v0.10.4 安装包）→ 整套件 SKIP（exit 0）。
 * 运行：node test/assets.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href)
const assetsPath = path.join(pluginRoot, 'lib', 'assets.js')
const assetsAvailable = await fs.access(assetsPath).then(() => true, () => false)

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

group('[0] 能力探测 / 契约（版本自适应）')
if (!assetsAvailable) {
  console.log('  结果：0 passed, 0 failed（SKIP：当前工件无 lib/assets.js（≤v0.10.4 安装包），assets 套件跳过）')
  process.exit(0)
}
const assets = await load('lib/assets.js')
const store = await load('lib/store.js')
const toolsModule = await load('lib/tools.js')
const hostSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8')
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
const methodsBlock = hostSrc.slice(hostSrc.indexOf('const METHODS = ['), hostSrc.indexOf(']', hostSrc.indexOf('const METHODS = [')))
const methods = new Set([...methodsBlock.matchAll(/'([a-z][a-z0-9-]+)'/g)].map((match) => match[1]))
const clientCalls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((match) => match[1]))
const toolCount = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES.length : 0
check('0.1 lib/assets.js 导出核心纯函数', ['ASSET_PREFIXES', 'ASSET_STATUSES', 'ASSET_ID_PATTERN', 'normalizeAssetId', 'isValidAssetId', 'splitAssetId', 'nextAssetId', 'parseAssetPlaceholders', 'extractAssetIds', 'matchAssetIdsInText', 'normalizeAssetCard', 'validateAssetCard', 'sortAssetCards', 'buildAssetIndex', 'normalizeAssetIndex', 'checkAssetReferences'].every((name) => name in assets))
check('0.2 9 类前缀齐全', JSON.stringify(assets.ASSET_PREFIXES) === JSON.stringify(['CHR', 'SPC', 'PRP', 'SHT', 'CST', 'EXP', 'SFX', 'VOX', 'MUS']))
check('0.3 canonical status = draft|active|retired', JSON.stringify(assets.ASSET_STATUSES) === JSON.stringify(['draft', 'active', 'retired']))
check('0.4 store 资产存储 API（getAssetCards/getAssetCard/nextAssetCardId/saveAssetCard）', ['getAssetCards', 'getAssetCard', 'nextAssetCardId', 'saveAssetCard'].every((name) => typeof store[name] === 'function'))
check('0.5 工具 34 / METHODS 68 / client 调用 68（M4 批1+批2 +10 已批准）/ 无新依赖', toolCount === 34 && methods.size === 68 && clientCalls.size === 68 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ tools: toolCount, methods: methods.size, clientCalls: clientCalls.size }))

group('[1] AC-A1 编号规范（9 前缀/3 位/变体/大小写/非法拒绝/确定性）')
const legalIds = ['CHR001', 'SPC999', 'PRP001', 'SHT001', 'CST001', 'EXP001', 'SFX001', 'VOX001', 'MUS001', 'CHR001_01', 'CHR001_99', 'chr001', 'Chr001', 'chr001_02']
check('A1.1 9 前缀 + 3 位序号 + 变体 _01/_99 全部合法（含大小写）', legalIds.every((id) => assets.isValidAssetId(id)), legalIds.filter((id) => !assets.isValidAssetId(id)).join(','))
const illegalIds = ['chr1', 'CHR1', 'CHR0001', 'CHR001_0', 'CHR001_00', 'CHR001_100', 'CHR001_2', 'XXX001', '', 'CHR-001', null, 42]
check('A1.2 非法编号全部拒绝（2/4 位、_00/_100/_1、坏前缀、空/非字符串）', illegalIds.every((id) => assets.isValidAssetId(id) === false), illegalIds.filter((id) => assets.isValidAssetId(id)).join(','))
check('A1.3 大小写不敏感 + 归一存储大写', assets.normalizeAssetId('chr001') === 'CHR001' && assets.normalizeAssetId('  Chr001  ') === 'CHR001' && assets.normalizeAssetId(42) === '')
const splitVariant = assets.splitAssetId('chr001_02')
check('A1.4 splitAssetId：prefix/sequence/baseId/variant 拆分正确', splitVariant && splitVariant.prefix === 'CHR' && splitVariant.sequence === 1 && splitVariant.baseId === 'CHR001' && splitVariant.variant === '02', JSON.stringify(splitVariant))
const splitBase = assets.splitAssetId('SPC003')
check('A1.5 基础编号 variant=null', splitBase && splitBase.variant === null && splitBase.sequence === 3, JSON.stringify(splitBase))
check('A1.6 nextAssetId：空/已有基础编号递增（变体不占序号）', assets.nextAssetId([], 'CHR') === 'CHR001' && assets.nextAssetId(['CHR001', 'CHR001_02', 'CHR002'], 'chr') === 'CHR003')
let nextInvalid = false
try { assets.nextAssetId([], 'XXX') } catch { nextInvalid = true }
check('A1.7 nextAssetId 非法前缀抛错', nextInvalid)

group('[2] AC-A2 资产卡 schema / status 归一 / 无时间戳')
const fullCard = {
  id: 'CHR001', type: 'CHR', name: '李慕白', variantOf: null, aliases: ['慕白'], status: 'active', version: 1,
  fields: { role: '主角', age: '25' }, relations: { relatedAssets: ['CHR002'], scenes: ['SPC001'] },
  prompts: { image: '白衫剑客', defaultPrompt: '水墨风' }, history: [{ version: 1, change: '初始' }],
}
const normalized = assets.normalizeAssetCard(fullCard)
check('A2.1 id 大写/type 保留/name 保留/可选字段归一', normalized.id === 'CHR001' && normalized.type === 'CHR' && normalized.name === '李慕白' && normalized.status === 'active' && normalized.version === 1 && JSON.stringify(normalized.aliases) === JSON.stringify(['慕白']))
check('A2.2 可选缺省：variantOf null/aliases []/fields {}/relations {}/prompts {}/history []', (() => { const b = assets.normalizeAssetCard({ id: 'SPC001', name: '当铺' }); return b.variantOf === null && Array.isArray(b.aliases) && b.aliases.length === 0 && JSON.stringify(b.fields) === '{}' && JSON.stringify(b.history) === '[]' })())
check('A2.3 type 缺省由编号前缀推导（SPC001 → SPC）', assets.normalizeAssetCard({ id: 'SPC001', name: '当铺' }).type === 'SPC')
check('A2.4 status 读归一：archived→retired / 未知→draft / 合法保留', assets.normalizeAssetCard({ ...fullCard, status: 'archived' }).status === 'retired' && assets.normalizeAssetCard({ ...fullCard, status: 'weird-value' }).status === 'draft' && assets.normalizeAssetCard({ ...fullCard, status: 'draft' }).status === 'draft')
check('A2.5 归一后无 createdAt/updatedAt 等时间戳字段', !/createdAt|updatedAt|addedAt/.test(JSON.stringify(normalized)))
check('A2.6 完整卡 validateAssetCard = []（无错误）', assets.validateAssetCard(normalized).length === 0, JSON.stringify(assets.validateAssetCard(normalized)))
check('A2.7 必填缺失（id/name）报错', assets.validateAssetCard(assets.normalizeAssetCard({ type: 'CHR' })).length >= 2)
check('A2.8 type 与编号前缀不一致报错', assets.validateAssetCard(assets.normalizeAssetCard({ id: 'CHR001', type: 'SPC', name: 'x' })).some((message) => message.includes('不一致')))
check('A2.9 history 仅保留 {version, change}（无时间戳字段）', (() => { const h = assets.normalizeAssetCard({ ...fullCard, history: [{ version: 1, change: 'a', at: '2026-01-01' }] }).history; return h.length === 1 && JSON.stringify(h[0]) === JSON.stringify({ version: 1, change: 'a' }) })())

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'assets-test-'))
const TITLE = 'assets测试剧'
const projectDir = path.join(workspace, 'AI短剧', TITLE)
const cardsFile = path.join(projectDir, '.aidrama', 'assets', 'cards.json')
const legacyFile = path.join(projectDir, '.aidrama', 'assets.json')
await store.createProject(workspace, TITLE)

group('[3] AC-A3 旧项目只读回退 / cards.json 单文件 / legacy 零改动')
const beforeRead = await treeHash(projectDir)
const emptyCards = await store.getAssetCards(workspace, TITLE)
const afterRead = await treeHash(projectDir)
check('A3.1 旧项目无 assets：读取返回 []（不报错）', Array.isArray(emptyCards) && emptyCards.length === 0)
check('A3.2 读取不建目录/不写文件（项目树 hash 前后一致）', beforeRead.hash === afterRead.hash && beforeRead.count === afterRead.count, JSON.stringify({ before: beforeRead.count, after: afterRead.count }))
check('A3.3 读取后 .aidrama/assets 目录不存在', !(await fileExists(path.join(projectDir, '.aidrama', 'assets'))))
await fs.writeFile(legacyFile, `${JSON.stringify([{ id: 'a-old', name: '旧素材', kind: 'image', source: 'x.png', bytes: 1, linkedShots: [] }], null, 2)}\n`, 'utf8')
const legacyBefore = sha256(await fs.readFile(legacyFile))
const savedFirst = await store.saveAssetCard(workspace, TITLE, { id: 'chr001', name: '李慕白', aliases: ['慕白'], status: 'active', fields: { role: '主角' }, prompts: { image: '白衫剑客' } })
check('A3.4 首次写入自动建 .aidrama/assets/cards.json（小写输入归一 CHR001）', (await fileExists(cardsFile)) && savedFirst.id === 'CHR001' && savedFirst.version === 1, JSON.stringify({ id: savedFirst.id }))
check('A3.5 legacy .aidrama/assets.json 零改动（hash 前后一致）', sha256(await fs.readFile(legacyFile)) === legacyBefore)
const cardsRaw = JSON.parse(await fs.readFile(cardsFile, 'utf8'))
check('A3.6 cards.json 单文件结构 {schemaVersion:1, assets:[]} 且无时间戳', cardsRaw.schemaVersion === 1 && Array.isArray(cardsRaw.assets) && cardsRaw.assets.length === 1 && !/createdAt|updatedAt|addedAt/.test(await fs.readFile(cardsFile, 'utf8')))
check('A3.7 cards.json 按 id 稳定排序（单卡/多卡均升序）', JSON.stringify(cardsRaw.assets.map((card) => card.id)) === JSON.stringify(['CHR001']))
check('A3.8 getAssetCard 按编号读取（大小写不敏感）', (await store.getAssetCard(workspace, TITLE, 'chr001')).id === 'CHR001' && (await store.getAssetCard(workspace, TITLE, 'SPC999')) === null)

group('[4] AC-A4 重复 ID / 非法输入拒绝且不写盘')
const cardsHashBeforeDup = sha256(await fs.readFile(cardsFile))
let dupError = null
try { await store.saveAssetCard(workspace, TITLE, { id: 'CHR001', name: '重复' }) } catch (error) { dupError = error }
check('A4.1 重复 ID（大小写归一后）→ invalid-args', dupError && dupError.code === 'invalid-args', dupError && dupError.message)
check('A4.2 重复 ID 拒绝后 cards.json 字节不变（不写盘）', sha256(await fs.readFile(cardsFile)) === cardsHashBeforeDup)
let badIdError = null
try { await store.saveAssetCard(workspace, TITLE, { id: 'XX001', name: '非法编号' }) } catch (error) { badIdError = error }
let badStatusError = null
try { await store.saveAssetCard(workspace, TITLE, { id: 'CHR009', name: '非法状态', status: 'weird' }) } catch (error) { badStatusError = error }
check('A4.3 非法编号 / 非法 status 写入 → invalid-args', badIdError && badIdError.code === 'invalid-args' && badStatusError && badStatusError.code === 'invalid-args')
check('A4.4 非法写入后 cards.json 仍只有 1 张卡（无副作用）', sha256(await fs.readFile(cardsFile)) === cardsHashBeforeDup)
const writableRetired = await store.saveAssetCard(workspace, TITLE, { id: 'spc001', name: '当铺', status: 'archived' })
check('A4.5 status 写兼容 archived → 归一 retired（不新增时间戳）', writableRetired.status === 'retired' && !/updatedAt/.test(await fs.readFile(cardsFile, 'utf8')))

group('[5] AC-A5 占位符解析 / 引用存在性')
const tokens = assets.parseAssetPlaceholders('{{Asset_CHR001_name}} 与 {{Asset_chr002_02_look}} 以及 {{Asset_bad}} {{Asset_SPC001}}')
check('A5.1 合法占位符（含变体/大小写/可缺字段）解析并归一', tokens.filter((item) => item.valid).length === 3 && tokens[0].id === 'CHR001' && tokens[1].id === 'CHR002_02' && tokens[1].field === 'look')
check('A5.2 非法占位符标记 valid=false（原样保留 raw）', tokens.some((item) => item.valid === false && item.raw === '{{Asset_bad}}'))
check('A5.3 占位符 raw 文本原样保留（不改写）', tokens.find((item) => item.id === 'CHR001').raw === '{{Asset_CHR001_name}}')
check('A5.4 extractAssetIds 仅取合法引用且去重', JSON.stringify(assets.extractAssetIds('{{Asset_CHR001_name}} {{Asset_CHR001_alias}} {{Asset_SPC001}}')) === JSON.stringify(['CHR001', 'SPC001']))
const refs = assets.checkAssetReferences({ cards: await store.getAssetCards(workspace, TITLE), texts: ['{{Asset_CHR001_name}}', '{{Asset_CHR999_name}}', '{{Asset_nope}}'] })
check('A5.5 引用校验：存在 PASS / 缺失与非法 → WARN 列表（不阻断）', refs.ok === false && refs.warnings.some((item) => item.code === 'asset-reference-missing' && item.assetId === 'CHR999') && refs.warnings.some((item) => item.code === 'asset-placeholder-invalid'), JSON.stringify(refs.warnings.slice(0, 2)))

group('[6] AC-A6 subject/groupId 文本宽松匹配')
check('A6.1 subject 含资产编号 → 提取（宽松）', JSON.stringify(assets.matchAssetIdsInText('李慕白（CHR001）站在柜台后')) === JSON.stringify(['CHR001']))
check('A6.2 groupId 含变体编号 → 提取', JSON.stringify(assets.matchAssetIdsInText('分组 CHR001_02')) === JSON.stringify(['CHR001_02']))
check('A6.3 无编号文本 → 空数组（不误报）', assets.matchAssetIdsInText('李慕白站在柜台后').length === 0)

group('[7] AC-A7 version 递增 + history add-only')
const v1Card = await store.getAssetCard(workspace, TITLE, 'CHR001')
const updated = await store.saveAssetCard(workspace, TITLE, { id: 'CHR001', name: '李慕白（青年）', status: 'retired', change: '补青年形态' }, { update: true })
const updated2 = await store.saveAssetCard(workspace, TITLE, { id: 'CHR001', name: '李慕白（终版）', change: '定稿' }, { update: true })
check('A7.1 version 1→2→3 递增', v1Card.version === 1 && updated.version === 2 && updated2.version === 3, JSON.stringify([v1Card.version, updated.version, updated2.version]))
check('A7.2 history add-only（旧条目不变、新条目追加）', JSON.stringify(updated.history) === JSON.stringify([{ version: 1, change: '补青年形态' }]) && updated2.history.length === 2 && JSON.stringify(updated2.history[0]) === JSON.stringify({ version: 1, change: '补青年形态' }), JSON.stringify(updated2.history))
check('A7.3 更新未提供字段沿用旧卡（fields/prompts 不丢）', updated2.fields.role === '主角' && updated2.prompts.image === '白衫剑客')
let staleError = null
try { await store.saveAssetCard(workspace, TITLE, { id: 'CHR001', name: 'x', expectedVersion: 1 }, { update: true }) } catch (error) { staleError = error }
check('A7.4 expectedVersion 不一致 → invalid-args', staleError && staleError.code === 'invalid-args')
let noUpdateError = null
try { await store.saveAssetCard(workspace, TITLE, { id: 'CHR999', name: '不存在', expectedVersion: 1 }, { update: true }) } catch (error) { noUpdateError = error }
check('A7.5 update=true 但卡不存在 → invalid-args', noUpdateError && noUpdateError.code === 'invalid-args')

group('[8] AC-A8 确定性 + variantOf/aliases 约束')
const ROOT2 = await fs.mkdtemp(path.join(os.tmpdir(), 'assets-det2-'))
const ROOT3 = await fs.mkdtemp(path.join(os.tmpdir(), 'assets-det3-'))
const deterministicCards = [
  { id: 'chr001', name: '李慕白', aliases: ['慕白'], status: 'active', fields: { role: '主角' } },
  { id: 'CHR002', name: '林越', aliases: [] },
  { id: 'spc001', name: '当铺', status: 'active' },
]
for (const root of [ROOT2, ROOT3]) {
  await store.createProject(root, TITLE)
  for (const card of deterministicCards) await store.saveAssetCard(root, TITLE, card)
}
const cards2 = await fs.readFile(path.join(ROOT2, 'AI短剧', TITLE, '.aidrama', 'assets', 'cards.json'))
const cards3 = await fs.readFile(path.join(ROOT3, 'AI短剧', TITLE, '.aidrama', 'assets', 'cards.json'))
check('A8.1 两个独立项目同输入 → cards.json 字节一致（确定性）', sha256(cards2) === sha256(cards3), `${sha256(cards2).slice(0, 12)} vs ${sha256(cards3).slice(0, 12)}`)
const loadedCards = await store.getAssetCards(workspace, TITLE)
check('A8.2 normalize 幂等（读取再归一后 buildAssetIndex 严格相等）', JSON.stringify(assets.buildAssetIndex(loadedCards)) === JSON.stringify(assets.buildAssetIndex(loadedCards.map((card) => assets.normalizeAssetCard(card)))))
check('A8.3 资产列表按 id 升序稳定', (() => { const ids = loadedCards.map((card) => card.id); return JSON.stringify(ids) === JSON.stringify([...ids].sort((a, b) => a.localeCompare(b, 'en'))) })())
let variantError = null
try { await store.saveAssetCard(workspace, TITLE, { id: 'CHR001_02', name: '变体', variantOf: 'CHR999' }) } catch (error) { variantError = error }
check('A8.4 variantOf 引用不存在基础 ID → invalid-args', variantError && variantError.code === 'invalid-args')
const variant = await store.saveAssetCard(workspace, TITLE, { id: 'chr001_02', name: '李慕白（少年）', variantOf: 'chr001', status: 'draft' })
check('A8.5 variantOf 引用已存在基础 ID 可写（归一 CHR001_02 / variantOf CHR001）', variant.id === 'CHR001_02' && variant.variantOf === 'CHR001')
let variantSelfError = null
try { await store.saveAssetCard(workspace, TITLE, { id: 'CHR001_03', name: '自引用', variantOf: 'CHR001_03' }) } catch (error) { variantSelfError = error }
check('A8.6 variantOf 自引用 → invalid-args', variantSelfError && variantSelfError.code === 'invalid-args')
let aliasError = null
try { await store.saveAssetCard(workspace, TITLE, { id: 'CHR003', name: '别名冲突', aliases: ['慕白'] }) } catch (error) { aliasError = error }
check('A8.7 aliases 同类型重复 → invalid-args', aliasError && aliasError.code === 'invalid-args')
const crossTypeAlias = await store.saveAssetCard(workspace, TITLE, { id: 'CST001', name: '白衫', aliases: ['慕白'] })
check('A8.8 aliases 跨类型允许（CST 与 CHR 同别名）', crossTypeAlias.id === 'CST001')
const nextId = await store.nextAssetCardId(workspace, TITLE, 'CHR')
await store.saveAssetCard(workspace, TITLE, { id: nextId, name: '林越' })
const nextId2 = await store.nextAssetCardId(workspace, TITLE, 'CHR')
check('A8.9 nextAssetCardId 基于现有基础编号递增（CHR002→CHR003，变体不占位）', nextId === 'CHR002' && nextId2 === 'CHR003', JSON.stringify({ nextId, nextId2 }))

group('[9] AC-A9/A10 契约 + 清理')
check('A9.1 工具 34 / METHODS 68 / client 68（M4 批1+批2 已批准）', toolCount === 34 && methods.size === 68 && clientCalls.size === 68)
check('A9.2 无新依赖', Object.keys(pkg.dependencies || {}).length === 0)
check('A9.3 无新增 asset-card route（仅既有 assets-get/add/remove 三个素材接口）', JSON.stringify([...methods].filter((name) => /asset/i.test(name)).sort()) === JSON.stringify(['assets-add', 'assets-get', 'assets-remove']), JSON.stringify([...methods].filter((name) => /asset/i.test(name))))
await fs.rm(workspace, { recursive: true, force: true })
await fs.rm(ROOT2, { recursive: true, force: true })
await fs.rm(ROOT3, { recursive: true, force: true })
check('A10.1 临时工作区已清理', !(await fileExists(workspace)) && !(await fileExists(ROOT2)) && !(await fileExists(ROOT3)))

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
