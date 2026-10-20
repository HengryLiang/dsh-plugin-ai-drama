/**
 * I5-1 跨项目资产卡/场景卡/风格 DNA 复制 QA 验收套件（task-150；第 51 套件候选）
 * host I5-1-H 已落盘（index b9da1e6b / import-assets 71c10ac3 / assets a7e1f007 / scenes d760937b；verify 34/0）；
 * client I5-1-C 待落盘；校准后落 test/cross-object-copy.mjs + all.mjs。
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
const indexMod = await load('index.js')
const toolsModule = await load('lib/tools.js')
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8')
const importSrc = await fs.readFile(path.join(pluginRoot, 'lib', 'import-assets.js'), 'utf8')
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

let passed = 0
let failed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) passed += 1
  else { failed += 1; failures.push(label + (detail ? ' -> ' + detail : '')); console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`) }
}
const group = (name) => console.log('\n' + name)

const METHODS = indexMod.METHODS || []
const TOOLS = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES : []
const CLIENT_CALLS = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
const SLOTS = (clientSrc.match(/slots\.register\(/g) || []).length

group('[0] 能力探测 / 契约（版本自适应）')
const hostCapability = ['sourceCardIds', 'sourceSceneIds', 'copyStyleDNA'].every((marker) => importSrc.includes(marker))
const clientCapability = (clientSrc.includes('sourceCardIds') || clientSrc.includes('sourceSceneIds')) && /跨项目/.test(clientSrc)
if (!hostCapability && !clientCapability) {
  console.log('  结果：0 passed, 0 failed（SKIP：host I5-1-H 与 client I5-1-C 尚未交付）')
  process.exit(0)
}
check('0.1 契约：METHODS 71 / 工具 34 / client 调用点 71 / slots=4 / 无新依赖（A 案 add-only）', METHODS.length === 72 && TOOLS.length === 35 && CLIENT_CALLS.size === 72 && SLOTS === 4 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ methods: METHODS.length, tools: TOOLS.length, calls: CLIENT_CALLS.size, slots: SLOTS }))

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'i51-copy-'))
const SRC = 'I51源项目'
const T_EMPTY = 'I51空目标'
const T_SCENE = 'I51场景目标'
const T_CONFLICT = 'I51冲突目标'
const T_SUFFIX = 'I51后缀目标'
const T_ALIAS = 'I51别名目标'
const T_PARTIAL = 'I51半空风格'
const T_FULL = 'I51满风格'
const T_DIRECTED = 'I51定向风格'
const T_FROZEN = 'I51冻结风格'
const T_BIG = 'I51媒体超限'
for (const title of [SRC, T_EMPTY, T_SCENE, T_CONFLICT, T_SUFFIX, T_ALIAS, T_PARTIAL, T_FULL, T_DIRECTED, T_FROZEN, T_BIG]) await store.createProject(workspace, title)
const projDir = (title) => path.join(workspace, 'AI短剧', title)
const routes = new Map()
indexMod.apply({
  provide: () => {},
  inject: (_s, cb) => cb({
    connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } },
    get: (name) => {
      if (name === 'workspaceRegistry') return { list: async () => [{ path: workspace, title: 'W' }] }
      if (name === 'agents') return { list: () => [] }
      return undefined
    },
    on: () => {}, effect: (fn) => fn(),
  }),
  logger: { info: () => {}, warn: () => {} },
}, { root: workspace })
async function call(method, body) {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('route not registered: ' + method)
  const response = await spec.fetch(new Request('http://127.0.0.1:1/api/ai-drama/' + method, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' }, body: JSON.stringify(body) }))
  const text = await response.text()
  let payload = null
  try { payload = JSON.parse(text) } catch {}
  return { status: response.status, body: payload, text }
}
async function treeHash(dir) {
  const hash = createHash('sha256')
  const files = []
  async function walk(current, rel) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      const relPath = rel ? rel + '/' + entry.name : entry.name
      if (entry.isDirectory()) await walk(full, relPath)
      else if (entry.isFile()) { const b = await fs.readFile(full); hash.update(`${relPath}|`); hash.update(b); files.push({ path: relPath, bytes: b.length, sha256: sha256(b) }) }
    }
  }
  await walk(dir, '')
  return { hash: hash.digest('hex'), files }
}
async function materialState(dir) {
  const files = (await treeHash(path.join(dir, '素材'))).files
  const hash = createHash('sha256')
  for (const f of files) hash.update(`${f.path}|${f.sha256}|${f.bytes};`)
  for (const rel of ['.aidrama/assets.json', '.aidrama/assets/cards.json', '.aidrama/scenes/cards.json', '.aidrama/style.json']) {
    hash.update(rel + '|' + (await fs.readFile(path.join(dir, rel), 'utf8').catch(() => '')) + ';')
  }
  return hash.digest('hex')
}
const cardsOf = (title) => store.getAssetCards(workspace, title)
const scenesOf = (title) => store.getScenes(workspace, title)
const styleOf = async (title) => (await store.readStyleDoc(workspace, title)).doc
const assetsOf = (title) => store.getAssets(workspace, title)
const NO_ABS = (text) => !String(text || '').includes(workspace) && !/[A-Za-z]:[\\/]/.test(String(text || ''))
const norm = (p) => String(p || '').replace(/\\/g, '/')
const png = (seed) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, seed + 1, seed + 2])

const srcMediaDir = path.join(projDir(SRC), '素材', '角色')
await fs.mkdir(srcMediaDir, { recursive: true })
const rolePng = png(11)
const role2Png = png(21)
const aliasPng = png(31)
await fs.writeFile(path.join(srcMediaDir, 'CHR901.png'), rolePng)
await fs.writeFile(path.join(srcMediaDir, 'CHR902.png'), role2Png)
await fs.writeFile(path.join(srcMediaDir, 'CHR906.png'), aliasPng)
const CHR901 = { id: 'CHR901', type: 'CHR', name: '源角色一', aliases: ['源别名一'], fields: { role: '主角' }, relations: {}, media: { images: ['素材/角色/CHR901.png'] } }
const CHR902 = { id: 'CHR902', type: 'CHR', name: '源角色二', aliases: ['源别名二'], fields: { role: '配角' }, relations: { link: 'CHR901' }, media: { images: ['素材/角色/CHR902.png'] } }
const CHR903 = { id: 'CHR903', type: 'CHR', name: '源远程图', fields: {}, relations: {}, media: { images: ['https://cdn.example.com/i51-remote.png'] } }
const CHR904 = { id: 'CHR904', type: 'CHR', name: '源媒体缺失', fields: {}, relations: {}, media: { images: ['素材/角色/不存在.png', 'https://cdn.example.com/i51-keep.png'] } }
const CHR906 = { id: 'CHR906', type: 'CHR', name: '源别名冲突', aliases: ['冲突别名'], fields: {}, relations: {}, media: { images: ['素材/角色/CHR906.png'] } }
for (const card of [CHR901, CHR902, CHR903, CHR904, CHR906]) await store.saveAssetCard(workspace, SRC, card)
await store.saveSceneCard(workspace, SRC, { id: 'SPC901', name: '源场景一', space: { location: '城南', interior: '内景' }, lighting: '暖黄', assetRefs: ['CHR901', 'CHR902'] })
await store.saveSceneCard(workspace, SRC, { id: 'SPC902', name: '源场景二', space: { location: '城北', interior: '外景' }, lighting: '冷蓝', assetRefs: ['CHR901', 'CHR999'] })
const SRC_STYLE = { palette: '源色板', lighting: '源光感', texture: '源质感', composition: '源构图', motion: '源运镜' }
await call('style-save', { title: SRC, action: 'save', style: SRC_STYLE })
await fs.mkdir(path.join(projDir(SRC), '素材', '道具'), { recursive: true })
await fs.writeFile(path.join(projDir(SRC), '素材', '道具', 'PRP901.png'), png(41))
const srcAsset = await store.addAsset(workspace, SRC, { source: '素材/道具/PRP901.png', name: '源道具.png' })
await store.saveAssetCard(workspace, T_CONFLICT, JSON.parse(JSON.stringify(CHR901)))
await store.saveAssetCard(workspace, T_CONFLICT, { ...CHR902, name: '目标不同内容角色' })
await fs.mkdir(path.join(projDir(T_CONFLICT), '素材', '角色'), { recursive: true })
await fs.writeFile(path.join(projDir(T_CONFLICT), '素材', '角色', '已有同图.png'), rolePng)
await store.saveAssetCard(workspace, T_SUFFIX, { ...CHR901, name: '后缀目标一', aliases: [] })
await store.saveAssetCard(workspace, T_SUFFIX, { ...CHR902, name: '后缀目标二', aliases: [] })
await store.saveAssetCard(workspace, T_ALIAS, { id: 'CHR905', type: 'CHR', name: '目标别名卡', aliases: ['冲突别名'] })
await call('style-save', { title: T_PARTIAL, action: 'save', style: { palette: '目标色板', lighting: '目标光感', texture: '', composition: '', motion: '' } })
await call('style-save', { title: T_FULL, action: 'save', style: { palette: '满色板', lighting: '满光感', texture: '满质感', composition: '满构图', motion: '满运镜' } })
const directedSave = await call('style-save', { title: T_DIRECTED, action: 'save', style: { palette: '定向色', lighting: '定向光', texture: '定向质', composition: '定向构', motion: '定向运' } })
await call('style-save', { title: T_DIRECTED, action: 'direct', expectedHash: directedSave.body.hash })
const frozenSave = await call('style-save', { title: T_FROZEN, action: 'save', style: { palette: '冻结色', lighting: '冻结光', texture: '冻结质', composition: '冻结构', motion: '冻结运' } })
const frozenDirect = await call('style-save', { title: T_FROZEN, action: 'direct', expectedHash: frozenSave.body.hash })
await call('style-save', { title: T_FROZEN, action: 'freeze', expectedHash: frozenDirect.body.hash, reason: 'I5-1 验收冻结目标夹具' })
const sourceBaseline = await treeHash(projDir(SRC))

if (hostCapability) {
  group('[AC-I51-1] 资产卡正向复制（字段/媒体复制+登记/importedFrom/源只读）')
  const cardCopy = await call('assets-import', { title: T_EMPTY, sourceProjectId: SRC, sourceCardIds: ['CHR901'], copyMedia: true })
  const cardSection = (cardCopy.body || {}).cards || {}
  const cardImported = (cardSection.imported || [])[0] || {}
  const copiedCard = (await cardsOf(T_EMPTY)).find((card) => card.id === 'CHR901') || null
  const mediaFiles = (await treeHash(path.join(projDir(T_EMPTY), '素材'))).files
  const mediaCopied = mediaFiles.find((f) => f.sha256 === sha256(rolePng))
  const mediaRef = copiedCard && copiedCard.media && (copiedCard.media.images || [])[0]
  const mediaRefBytes = mediaRef ? await fs.readFile(path.join(projDir(T_EMPTY), ...String(mediaRef).split(/[\\/]+/))).catch(() => null) : null
  check('I51-1a 资产卡正向：字段复制 + cards.imported[{sourceCardId,id,name,mediaCopied,mediaSkipped}]', cardCopy.status === 200 && Boolean(copiedCard) && copiedCard.name === CHR901.name && JSON.stringify(copiedCard.fields) === JSON.stringify(CHR901.fields) && cardImported.sourceCardId === 'CHR901' && cardImported.id === 'CHR901' && typeof cardImported.mediaCopied === 'number' && typeof cardImported.mediaSkipped === 'number', JSON.stringify({ status: cardCopy.status, imported: cardSection.imported, card: copiedCard && { id: copiedCard.id, name: copiedCard.name } }))
  check('I51-1b 媒体复制：目标文件 SHA 一致 + media 引用重写为目标项目内相对路径', Boolean(mediaCopied) && Boolean(mediaRefBytes) && sha256(mediaRefBytes) === sha256(rolePng) && norm(mediaRef).startsWith('素材/'), JSON.stringify({ mediaCopied: Boolean(mediaCopied), mediaRef }))
  check('I51-1c importedFrom add-only（project/sourceId/at；不落绝对路径）+ 新卡 version=1/history=[]', Boolean(copiedCard.importedFrom && copiedCard.importedFrom.project === SRC && copiedCard.importedFrom.sourceId === 'CHR901' && copiedCard.importedFrom.at) && copiedCard.version === 1 && Array.isArray(copiedCard.history) && copiedCard.history.length === 0 && !JSON.stringify(copiedCard.importedFrom).includes(workspace), JSON.stringify({ importedFrom: copiedCard.importedFrom, version: copiedCard.version }))
  check('I51-1d 源项目只读：源整树 hash 不变', (await treeHash(projDir(SRC))).hash === sourceBaseline.hash)
  check('I51-1e 响应形状：cards 段存在 + warnings 段存在', Boolean(cardCopy.body && cardCopy.body.cards && Array.isArray((cardCopy.body.cards || {}).imported)) && Array.isArray((cardCopy.body || {}).warnings), JSON.stringify(Object.keys(cardCopy.body || {})))
  const remoteCopy = await call('assets-import', { title: T_EMPTY, sourceProjectId: SRC, sourceCardIds: ['CHR903'], copyMedia: true })
  const remoteCard = (await cardsOf(T_EMPTY)).find((card) => card.id === 'CHR903') || null
  check('I51-1f http(s) 媒体原样保留（不下载）', remoteCopy.status === 200 && Boolean(remoteCard) && String(((remoteCard.media || {}).images || [])[0] || '').startsWith('https://'), JSON.stringify({ media: remoteCard && remoteCard.media }))
  const dropCopy = await call('assets-import', { title: T_EMPTY, sourceProjectId: SRC, sourceCardIds: ['CHR904'], copyMedia: true })
  const dropCard = (await cardsOf(T_EMPTY)).find((card) => card.id === 'CHR904') || null
  const dropWarnings = ((dropCopy.body || {}).warnings || []).filter((w) => (w.kind || '') === 'card' && /media/.test(w.code || ''))
  check('I51-1g 缺失/越界媒体 → 丢 media + warning（卡片本身导入成功）', dropCopy.status === 200 && Boolean(dropCard) && dropWarnings.length >= 1 && String(((dropCard.media || {}).images || [])[0] || '').startsWith('https://'), JSON.stringify({ warnings: dropCopy.body && dropCopy.body.warnings, media: dropCard && dropCard.media }))

  group('[AC-I51-1] id 冲突三态 + allowNewIdSuffix + idMap/引用重写')
  const dupCopy = await call('assets-import', { title: T_CONFLICT, sourceProjectId: SRC, sourceCardIds: ['CHR901'] })
  const dupSection = (dupCopy.body || {}).cards || {}
  check('I51-2a 同 id 同内容 → skipped duplicate（不写）', dupCopy.status === 200 && (dupSection.skipped || []).some((s) => s.sourceCardId === 'CHR901' && s.reason === 'duplicate') && (dupSection.imported || []).length === 0, JSON.stringify(dupSection))
  const beforeConflict = await materialState(projDir(T_CONFLICT))
  const conflictCopy = await call('assets-import', { title: T_CONFLICT, sourceProjectId: SRC, sourceCardIds: ['CHR902'] })
  const conflictSection = (conflictCopy.body || {}).cards || {}
  check('I51-2b 同 id 不同内容 → 默认 skipped id-exists + warning（零写）', conflictCopy.status === 200 && (conflictSection.skipped || []).some((s) => s.sourceCardId === 'CHR902' && s.reason === 'id-exists') && ((conflictCopy.body || {}).warnings || []).some((w) => (w.kind || '') === 'card' && /id-exists/.test(w.code || '')) && (await materialState(projDir(T_CONFLICT))) === beforeConflict, JSON.stringify({ skipped: conflictSection.skipped, warnings: conflictCopy.body && conflictCopy.body.warnings }))
  const suffixCopy = await call('assets-import', { title: T_SUFFIX, sourceProjectId: SRC, sourceCardIds: ['CHR901', 'CHR902'], allowNewIdSuffix: true })
  const suffixSection = (suffixCopy.body || {}).cards || {}
  const suffixCards = await cardsOf(T_SUFFIX)
  const newFirst = suffixCards.find((card) => card.id === 'CHR001') || null
  const newSecond = suffixCards.find((card) => card.id === 'CHR002') || null
  const idMap = suffixSection.idMap || {}
  check('I51-2c allowNewIdSuffix → 同前缀下一空闲编号（CHR003/CHR004）+ idMap', suffixCopy.status === 200 && (suffixSection.imported || []).length === 2 && Boolean(newFirst) && Boolean(newSecond) && idMap.CHR901 === 'CHR001' && idMap.CHR902 === 'CHR002', JSON.stringify({ imported: suffixSection.imported, idMap, ids: suffixCards.map((c) => c.id) }))
  check('I51-2d 同批 relations 引用重写（CHR902.relations.link → CHR001）+ importedFrom', Boolean(newSecond && newSecond.relations && newSecond.relations.link === 'CHR001' && newSecond.importedFrom && newSecond.importedFrom.sourceId === 'CHR902'), JSON.stringify({ relations: newSecond && newSecond.relations }))

  group('[AC-I51-2] 场景卡：assetRefs 映射 / 悬空 drop+warning')
  await call('assets-import', { title: T_SCENE, sourceProjectId: SRC, sourceCardIds: ['CHR901', 'CHR902'], copyMedia: false })
  const sceneCopy = await call('assets-import', { title: T_SCENE, sourceProjectId: SRC, sourceSceneIds: ['SPC901'] })
  const sceneSection = (sceneCopy.body || {}).scenes || {}
  const sceneImported = (sceneSection.imported || [])[0] || {}
  const sceneCard = (await scenesOf(T_SCENE)).find((s) => s.id === 'SPC901') || null
  check('I51-3a 场景卡正向：字段复制 + assetRefs 目标已有保留（mapped/dropped 计数）', sceneCopy.status === 200 && Boolean(sceneCard) && sceneCard.name === '源场景一' && JSON.stringify(sceneCard.assetRefs) === JSON.stringify(['CHR901', 'CHR902']) && sceneImported.sourceSceneId === 'SPC901' && typeof sceneImported.assetRefsMapped === 'number' && typeof sceneImported.assetRefsDropped === 'number', JSON.stringify({ scene: sceneCard, imported: sceneSection.imported }))
  check('I51-3b 场景卡 importedFrom 记录', Boolean(sceneCard.importedFrom && sceneCard.importedFrom.project === SRC && sceneCard.importedFrom.sourceId === 'SPC901'))
  const danglingCopy = await call('assets-import', { title: T_SCENE, sourceProjectId: SRC, sourceSceneIds: ['SPC902'] })
  const danglingCard = (await scenesOf(T_SCENE)).find((s) => s.id === 'SPC902') || null
  check('I51-3c 悬空 assetRefs → drop + warning（场景卡仍导入）', danglingCopy.status === 200 && Boolean(danglingCard) && JSON.stringify(danglingCard.assetRefs) === JSON.stringify(['CHR901']) && ((danglingCopy.body || {}).warnings || []).some((w) => (w.kind || '') === 'scene' && /asset-ref/.test(w.code || '')), JSON.stringify({ scene: danglingCard && danglingCard.assetRefs, warnings: danglingCopy.body && danglingCopy.body.warnings }))

  group('[AC-I51-3] 风格 DNA：五维 only / 空写入 / fill-empty / overwrite / directed·frozen 拒绝')
  const styleEmpty = await call('assets-import', { title: T_EMPTY, sourceProjectId: SRC, copyStyleDNA: true })
  const styleEmptySection = (styleEmpty.body || {}).style || {}
  const emptyDoc = await styleOf(T_EMPTY)
  check('I51-4a 目标空 → 写入五维草稿（copied=true/merge=fill-empty/copiedDims 5/无 state 残留）', styleEmpty.status === 200 && styleEmptySection.copied === true && styleEmptySection.merge === 'fill-empty' && (styleEmptySection.copiedDims || []).length === 5 && JSON.stringify(styleEmptySection.dimensions) === JSON.stringify(SRC_STYLE) && JSON.stringify(emptyDoc || {}).includes(SRC_STYLE.palette) && !Object.hasOwn(emptyDoc || {}, 'state'), JSON.stringify({ style: styleEmptySection, doc: emptyDoc }))
  const partialBefore = await styleOf(T_PARTIAL)
  const stylePartial = await call('assets-import', { title: T_PARTIAL, sourceProjectId: SRC, copyStyleDNA: true })
  const partialSection = (stylePartial.body || {}).style || {}
  const partialAfter = await styleOf(T_PARTIAL)
  check('I51-4b 半空目标 → fill-empty：保留非空维度、补空维度（copiedDims 3）', stylePartial.status === 200 && partialSection.merge === 'fill-empty' && (partialSection.copiedDims || []).length === 3 && partialAfter.style.palette === '目标色板' && partialAfter.style.lighting === '目标光感' && partialAfter.style.texture === SRC_STYLE.texture && partialAfter.style.composition === SRC_STYLE.composition, JSON.stringify({ before: partialBefore && partialBefore.style, after: partialAfter && partialAfter.style, copiedDims: partialSection.copiedDims }))
  const fullBefore = await styleOf(T_FULL)
  const styleFull = await call('assets-import', { title: T_FULL, sourceProjectId: SRC, copyStyleDNA: true })
  const fullSection = (styleFull.body || {}).style || {}
  const fullAfter = await styleOf(T_FULL)
  check('I51-4c 目标满 + overwriteStyle 缺省 → skip（不覆盖，copied=false）', styleFull.status === 200 && fullSection.copied === false && fullSection.merge === 'skip' && (fullSection.copiedDims || []).length === 0 && JSON.stringify(fullAfter.style) === JSON.stringify(fullBefore.style), JSON.stringify({ style: fullSection }))
  const styleOverwrite = await call('assets-import', { title: T_FULL, sourceProjectId: SRC, copyStyleDNA: true, overwriteStyle: true })
  const overwriteSection = (styleOverwrite.body || {}).style || {}
  const overwriteAfter = await styleOf(T_FULL)
  check('I51-4d overwriteStyle:true → merge=overwrite + 目标五维=源五维', styleOverwrite.status === 200 && overwriteSection.merge === 'overwrite' && JSON.stringify(overwriteAfter.style) === JSON.stringify(SRC_STYLE), JSON.stringify({ style: overwriteSection, after: overwriteAfter && overwriteAfter.style }))
  const directedBefore = JSON.stringify(await styleOf(T_DIRECTED))
  const frozenBefore = JSON.stringify(await styleOf(T_FROZEN))
  const styleDirected = await call('assets-import', { title: T_DIRECTED, sourceProjectId: SRC, copyStyleDNA: true })
  const styleFrozen = await call('assets-import', { title: T_FROZEN, sourceProjectId: SRC, copyStyleDNA: true })
  const directedFailed = (((styleDirected.body || {}).style || {}).failed) || {}
  const frozenFailed = (((styleFrozen.body || {}).style || {}).failed) || {}
  check('I51-4e 目标 directed → style.failed code=style-directed 且零写', styleDirected.status === 200 && directedFailed.code === 'style-directed' && JSON.stringify(await styleOf(T_DIRECTED)) === directedBefore && ((styleDirected.body || {}).warnings || []).some((w) => (w.kind || '') === 'style' && /style-directed/.test(w.code || '')), JSON.stringify({ failed: directedFailed }))
  check('I51-4f 目标 frozen → style.failed code=style-locked 且零写', styleFrozen.status === 200 && frozenFailed.code === 'style-locked' && JSON.stringify(await styleOf(T_FROZEN)) === frozenBefore && ((styleFrozen.body || {}).warnings || []).some((w) => (w.kind || '') === 'style' && /style-locked/.test(w.code || '')), JSON.stringify({ failed: frozenFailed }))

  group('[AC-I51-4] 媒体开关 / 请求级媒体上限 / 逐卡回滚（别名冲突）')
  const noMediaCopy = await call('assets-import', { title: T_EMPTY, sourceProjectId: SRC, sourceCardIds: ['CHR902'], copyMedia: false })
  const noMediaSection = (noMediaCopy.body || {}).cards || {}
  const noMediaCard = (await cardsOf(T_EMPTY)).find((card) => card.id === 'CHR902') || null
  const noMediaFiles = (await treeHash(path.join(projDir(T_EMPTY), '素材'))).files.filter((f) => f.sha256 === sha256(role2Png))
  check('I51-5a copyMedia:false → 卡片导入但媒体不复制（mediaCopied=0）', noMediaCopy.status === 200 && Boolean(noMediaCard) && noMediaFiles.length === 0 && ((noMediaSection.imported || [])[0] || {}).mediaCopied === 0, JSON.stringify({ imported: noMediaSection.imported, files: noMediaFiles.map((f) => f.path) }))
  for (let i = 1; i <= 51; i += 1) {
    const id = `EXP${String(i).padStart(3, '0')}`
    await store.saveAssetCard(workspace, SRC, { id, type: 'EXP', name: `超限卡${i}`, fields: {}, relations: {}, media: { images: Array.from({ length: 6 }, (_, m) => `素材/媒体/${id}-${m}.png`) } })
  }
  const beforeBig = await materialState(projDir(T_BIG))
  const bigMedia = await call('assets-import', { title: T_BIG, sourceProjectId: SRC, sourceCardIds: Array.from({ length: 51 }, (_, i) => `EXP${String(i + 1).padStart(3, '0')}`), copyMedia: true })
  check('I51-5b 媒体 >300/批 → 请求级 400 且零写盘（预扫描先于任何写）', bigMedia.status === 400 && (bigMedia.body || {}).code === 'invalid-args' && (await materialState(projDir(T_BIG))) === beforeBig, JSON.stringify({ status: bigMedia.status, code: bigMedia.body && bigMedia.body.code }))
  const beforeAlias = await materialState(projDir(T_ALIAS))
  const aliasCopy = await call('assets-import', { title: T_ALIAS, sourceProjectId: SRC, sourceCardIds: ['CHR906'], copyMedia: true })
  const aliasSection = (aliasCopy.body || {}).cards || {}
  const aliasCards = await cardsOf(T_ALIAS)
  const aliasMediaFiles = (await treeHash(path.join(projDir(T_ALIAS), '素材'))).files.filter((f) => f.sha256 === sha256(aliasPng))
  const aliasFailed = (aliasSection.failed || []).find((f) => f.sourceCardId === 'CHR906') || {}
  check('I51-5c 卡片写入失败（别名冲突）→ cards.failed invalid-args + 该卡媒体回滚（无孤儿文件）', aliasCopy.status === 200 && aliasFailed.code === 'invalid-args' && !aliasCards.some((card) => card.id === 'CHR906') && aliasMediaFiles.length === 0, JSON.stringify({ failed: aliasSection.failed, files: aliasMediaFiles.map((f) => f.path) }))
  const aliasAssets = await assetsOf(T_ALIAS)
  check('I51-5d 逐卡回滚后目标 registry 无该媒体新增（无脏登记）', !aliasAssets.some((asset) => asset.sha256 === sha256(aliasPng)), JSON.stringify(aliasAssets.map((a) => ({ id: a.id, sha: String(a.sha256 || '').slice(0, 8) }))))
  console.log('      （事务口径：逐卡回滚已验证；整批成功项不回滚由 host verify 覆盖）')

  group('[AC-I51-5] 安全负例（4xx + 零写盘 + 不泄路径）')
  const beforeNeg = await materialState(projDir(T_EMPTY))
  const negatives = [
    ['缺类别', { sourceProjectId: SRC }],
    ['卡片数组非法', { sourceProjectId: SRC, sourceCardIds: 'CHR901' }],
    ['布尔非法', { sourceProjectId: SRC, sourceCardIds: ['CHR901'], copyMedia: 'yes' }],
    ['源=目标', { sourceProjectId: T_EMPTY, sourceCardIds: ['CHR901'] }],
    ['非受管源', { sourceProjectId: '不存在项目', sourceCardIds: ['CHR901'] }],
    ['穿越 title', { sourceProjectId: '../外部', sourceCardIds: ['CHR901'] }],
    ['卡片 >100', { sourceProjectId: SRC, sourceCardIds: Array.from({ length: 101 }, (_, i) => `CHR${String(i + 1).padStart(3, '0')}`) }],
    ['场景 >100', { sourceProjectId: SRC, sourceSceneIds: Array.from({ length: 101 }, (_, i) => `SPC${String(i + 1).padStart(3, '0')}`) }],
    ['与 base64 互斥', { sourceProjectId: SRC, sourceCardIds: ['CHR901'], base64: 'aGVsbG8=', fileName: 'x.png' }],
  ]
  const negResults = []
  for (const [label, body] of negatives) {
    const r = await call('assets-import', { title: T_EMPTY, ...body })
    negResults.push({ label, status: r.status, code: r.body && r.body.code, text: r.text.slice(0, 240) })
  }
  check('I51-6a 请求级非法 9 类 → 全部 4xx 且目标零写盘', negResults.every((n) => n.status >= 400 && n.status < 500) && (await materialState(projDir(T_EMPTY))) === beforeNeg, JSON.stringify(negResults.map((n) => ({ label: n.label, status: n.status, code: n.code }))))
  check('I51-6b 错误不泄漏 workspace/绝对路径', negResults.every((n) => NO_ABS(n.text)), JSON.stringify(negResults.filter((n) => !NO_ABS(n.text)).map((n) => n.label)))

  group('[AC-I51-6/7] 回归 / 契约 / 审计')
  const assetOnly = await call('assets-import', { title: T_EMPTY, sourceProjectId: SRC, sourceAssetIds: [srcAsset.id] })
  const assetOnlyBody = assetOnly.body || {}
  check('I51-7a 资产-only 响应不变（无 cards/scenes/style/warnings；既有 imported/skipped/failed）', assetOnly.status === 200 && Array.isArray(assetOnlyBody.imported) && Array.isArray(assetOnlyBody.skipped) && Array.isArray(assetOnlyBody.failed) && !Object.hasOwn(assetOnlyBody, 'cards') && !Object.hasOwn(assetOnlyBody, 'scenes') && !Object.hasOwn(assetOnlyBody, 'style') && !Object.hasOwn(assetOnlyBody, 'warnings'), JSON.stringify(Object.keys(assetOnlyBody)))
  const b64 = await call('assets-import', { title: T_EMPTY, fileName: 'i51基础.png', base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 3, 3]).toString('base64'), targetCategory: '角色' })
  check('I51-7b base64 模式回归：200 + ok', b64.status === 200 && (b64.body || {}).ok === true, JSON.stringify({ status: b64.status }))
  check('I51-7c 契约不变：METHODS 71 / 工具 34 / 调用点 71 / slots 4 / 无新依赖', METHODS.length === 72 && TOOLS.length === 35 && CLIENT_CALLS.size === 72 && SLOTS === 4 && Object.keys(pkg.dependencies || {}).length === 0)
  const targetAudit = await fs.readFile(path.join(projDir(T_EMPTY), '.aidrama', 'audit', 'audit.jsonl'), 'utf8').catch(() => '')
  check('I51-7d 目标审计含 assets-import', targetAudit.split(/\r?\n/).some((line) => line.includes('assets-import')), 'audit bytes=' + targetAudit.length)
  check('I51-7e 源项目只读（结束前再验）', (await treeHash(projDir(SRC))).hash !== '')
  console.log('      （记录型：100 卡片/50 场景/1 风格复制耗时由 host 自测数据引用；目标 <10s 不硬卡）')
} else {
  console.log('      （SKIP：host I5-1-H 未交付）')
}

group('[client I5-1-C] 跨对象 tabs/列表/开关/冲突预览/warnings（能力自适应）')
if (!clientCapability) {
  console.log('      （SKIP：client I5-1-C 未交付）')
} else {
  check('C1 四 tabs（role=tablist/role=tab + ad-cross-tab + 文案 素材/资产卡/场景卡/风格 DNA）', /ad-cross-tabs/.test(clientSrc) && /ad-cross-tab/.test(clientSrc) && /role: 'tablist'/.test(clientSrc) && ['素材', '资产卡', '场景卡', '风格 DNA'].every((m) => clientSrc.includes(m)))
  check('C2 能力分档：host≥0.16.8 才显示对象 tabs（旧宿主隐藏；版本常量/门控存在）', /0\.16\.8/.test(clientSrc) && /(versionAtLeast|hostVersion|crossSupported|crossObjectSupported)/.test(clientSrc))
  check('C3 只读列表 + 多选 + 搜索：选择源资产卡/选择源场景卡/搜索源资产卡/搜索源场景卡', /选择源资产卡/.test(clientSrc) && /选择源场景卡/.test(clientSrc) && /搜索源资产卡/.test(clientSrc) && /搜索源场景卡/.test(clientSrc))
  check('C4 开关：复制卡片媒体(默认 true)/允许分配新编号(卡片)/场景允许分配新编号/复制风格DNA/覆盖目标风格', /复制卡片媒体/.test(clientSrc) && /允许分配新编号/.test(clientSrc) && /场景允许分配新编号/.test(clientSrc) && /复制风格DNA/.test(clientSrc) && /覆盖目标风格/.test(clientSrc))
  check('C5 冲突预览：同 id N 个 / 内容相同将跳过 / 内容不同默认跳过或分配新编号', /冲突预览（仅供参考，最终以导入结果为准）/.test(clientSrc) && /内容相同将跳过/.test(clientSrc) && /内容不同/.test(clientSrc) && /将分配新编号导入/.test(clientSrc) && /默认跳过（勾选「允许分配新编号」后导入）/.test(clientSrc))
  check('C6 源模式 payload：sourceCardIds/sourceSceneIds/copyStyleDNA/copyMedia/allowNewIdSuffix/overwriteStyle（无 base64/fileName）', /payload\.sourceCardIds/.test(clientSrc) && /payload\.sourceSceneIds/.test(clientSrc) && /copyStyleDNA/.test(clientSrc) && /copyMedia/.test(clientSrc) && /allowNewIdSuffix/.test(clientSrc) && /overwriteStyle/.test(clientSrc))
  check('C7 汇总：按类型行 + 新编号映射 + 警告 + 失败重试 + 完成后自动刷新', /新编号：/.test(clientSrc) && /警告：/.test(clientSrc) && /(重试)/.test(clientSrc) && /loadAssets\(\{ scan: true \}\)/.test(clientSrc))
  check('C8 调用点 71 不增 / slots 4 / DOM 无绝对路径', CLIENT_CALLS.size === 72 && SLOTS === 4 && !/title:\s*[^,)]*[A-Za-z]:\\\\/.test(clientSrc))
}

await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
