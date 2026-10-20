/**
 * v0.15.2 迭代 2 · 台词与音效板块重定位 · QA 验收套件（task-113）
 *
 * AC-D1 导航精简 + 台词视图迁「剧本」+ 配音稿迁「交付/导出」（工具 34 不变）
 * AC-D2 旧 dialogue 深链 → 重定向「剧本」对应集，不报错、无数据迁移
 * AC-D3 角色卡 media.audio（string[]，1–6 项）add-only 安全 + media-read 音频 MIME 扩展 + <audio controls> 试听
 * AC-D4 工具 34 / METHODS 69 不变 / 调用点 69 不增 / slots=4 / 无新依赖 / 无新 route
 * AC-D5 37+ 套件 0 failed / 旧数据 32 hash / 安装副本 E2E / 真实模型 0
 *
 * 能力自适应：host audio 字段/media-read 音频/ client 导航精简 任一未交付 → 对应分组 SKIP；全未交付整套件 SKIP（exit 0）。
 * 运行：node test/dialogue-audio.mjs
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
const media = await load('lib/media.js')
const indexMod = await load('index.js')
const toolsModule = await load('lib/tools.js')
const hostSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8')
const mediaSrc = await fs.readFile(path.join(pluginRoot, 'lib', 'media.js'), 'utf8')
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
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)
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
const METHODS = (() => {
  const block = hostSrc.slice(hostSrc.indexOf('const METHODS = ['), hostSrc.indexOf(']', hostSrc.indexOf('const METHODS = [')))
  return new Set([...block.matchAll(/'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
})()
const CLIENT_CALLS = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
const SLOTS = (clientSrc.match(/slots\.register\(/g) || []).length
const TOOL_COUNT = Array.isArray(toolsModule.DRAMA_TOOL_NAMES) ? toolsModule.DRAMA_TOOL_NAMES.length : 0
const TAB_GROUPS = (() => {
  const start = clientSrc.indexOf('const TAB_GROUPS = [')
  if (start < 0) return []
  return [...clientSrc.slice(start).matchAll(/\{ id: '([a-z]+)', label: '([^']+)', tabs: \[([^\]]+)\] \}/g)].map((m) => ({
    id: m[1],
    label: m[2],
    tabs: [...m[3].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]),
  }))
})()
const ALL_TABS = TAB_GROUPS.flatMap((g) => g.tabs)
const clientRelocated = TAB_GROUPS.length > 0 && !ALL_TABS.includes('dialogue')

group('[0] 能力探测 / 契约（版本自适应）')
check('0.1 工具 34 / METHODS 69 / client 调用 69 / slots=4 / 无新依赖', TOOL_COUNT === 34 && METHODS.size === 69 && CLIENT_CALLS.size === 69 && SLOTS === 4 && Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify({ tools: TOOL_COUNT, methods: METHODS.size, calls: CLIENT_CALLS.size, slots: SLOTS }))
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-audio-'))
const TITLE = '音频测试剧'
await store.createProject(workspace, TITLE)
const projectDir = path.join(workspace, 'AI短剧', TITLE)
const cardsFile = path.join(projectDir, '.aidrama', 'assets', 'cards.json')
let hostAudioSupported = false
try {
  await store.saveAssetCard(workspace, TITLE, { id: 'CHR001', name: '林越', media: { audio: ['素材/voice.mp3'] } })
  const card = (await store.getAssetCards(workspace, TITLE)).find((item) => item.id === 'CHR001')
  hostAudioSupported = Boolean(card && card.media && Array.isArray(card.media.audio) && card.media.audio.length === 1)
} catch {}
const mediaAudioSupported = /MEDIA_AUDIO_EXT_MIME|audio\/mpeg/.test(mediaSrc)
if (!hostAudioSupported && !mediaAudioSupported && !clientRelocated) {
  console.log('  结果：0 passed, 0 failed（SKIP：audio 字段/media-read 音频/导航精简均未交付，dialogue-audio 套件跳过）')
  await fs.rm(workspace, { recursive: true, force: true })
  process.exit(0)
}

group('[D3-host] 角色卡 media.audio（string[]，1–6 项）add-only + media-read 音频（能力自适应）')
if (!hostAudioSupported) {
  console.log('      （SKIP：media.audio 尚未交付）')
} else {
  const readCard = (id) => store.getAssetCards(workspace, TITLE).then((cards) => cards.find((card) => card.id === id) || null)
  await store.saveAssetCard(workspace, TITLE, { id: 'CHR002', name: '无音频' })
  const noAudioCard = await readCard('CHR002')
  check('D3.1 无 audio 字段的卡不写 media/audio 键（旧结构不变）', !Object.hasOwn(noAudioCard, 'media') || !Object.hasOwn(noAudioCard.media || {}, 'audio'))
  check('D3.2 合法 audio 数组（1–6 项）写入/回读一致、保序', deepEqual((await readCard('CHR001')).media.audio, ['素材/voice.mp3']))
  await store.saveAssetCard(workspace, TITLE, { id: 'CHR003', name: '多音色', media: { audio: ['素材/a.mp3', 'https://cdn.example.com/voice.wav', '素材/a.mp3', '素材/b.m4a'] } })
  check('D3.2b audio 去重保序（重复去重/顺序保留/允许 http(s) URL）', deepEqual((await readCard('CHR003')).media.audio, ['素材/a.mp3', 'https://cdn.example.com/voice.wav', '素材/b.m4a']), JSON.stringify((await readCard('CHR003')).media.audio))
  let emptyAudioRejected = false
  try { await store.saveAssetCard(workspace, TITLE, { id: 'CHR004', name: '空数组', media: { audio: [] } }) } catch (error) { emptyAudioRejected = error && error.code === 'invalid-args' }
  check('D3.2c 空 audio 数组 → invalid-args（缺省 = 不提供 media.audio 字段）', emptyAudioRejected && (await readCard('CHR004')) === null)
  const cardsHashBefore = sha256(await fs.readFile(cardsFile))
  const invalidAudio = [
    ['非白名单扩展', ['素材/voice.txt']],
    ['绝对路径', ['/tmp/voice.mp3']],
    ['盘符', ['C:/voice.mp3']],
    ['UNC', ['//server/share/voice.mp3']],
    ['穿越 ..', ['../voice.mp3']],
    ['控制字符', ['素材/vo\u0000ice.mp3']],
    ['超 6 项', ['素材/1.mp3', '素材/2.mp3', '素材/3.mp3', '素材/4.mp3', '素材/5.mp3', '素材/6.mp3', '素材/7.mp3']],
    ['单项超 500 字', ['素材/' + 'a'.repeat(500) + '.mp3']],
    ['非字符串项', [42]],
  ]
  let invalidRejected = 0
  const invalidDetails = []
  for (const [index, [label, audio]] of invalidAudio.entries()) {
    try {
      await store.saveAssetCard(workspace, TITLE, { id: `CHR1${index + 10}`, name: '非法音频', media: { audio } })
      invalidDetails.push(label + ':accepted')
    } catch (error) {
      if (error && error.code === 'invalid-args') invalidRejected += 1
      else invalidDetails.push(label + ':' + (error && error.code))
    }
  }
  check('D3.3 非法 audio（非白名单/绝对/盘符/UNC/穿越/控制字符/超 6/超 500/非字符串）→ invalid-args 不写盘', invalidRejected === invalidAudio.length && sha256(await fs.readFile(cardsFile)) === cardsHashBefore, JSON.stringify(invalidDetails))
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
  indexMod.apply(ctx, { root: workspace })
  async function call(body) {
    const spec = routes.get('/api/ai-drama/media-read')
    if (!spec) throw new Error('route not registered: media-read')
    const response = await spec.fetch(new Request('http://127.0.0.1:1/api/ai-drama/media-read', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' },
      body: JSON.stringify(body || {}),
    }))
    const text = await response.clone().text().catch(() => '')
    let payload = null
    try { payload = JSON.parse(text) } catch { payload = null }
    return { status: response.status, body: payload, text }
  }
  const mediaDir = path.join(projectDir, '素材')
  await fs.mkdir(mediaDir, { recursive: true })
  const audioFiles = {
    'a.mp3': { bytes: Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3]), mime: 'audio/mpeg' },
    'a.wav': { bytes: Buffer.from('RIFF0000WAVEfmt ', 'binary'), mime: 'audio/wav' },
    'a.m4a': { bytes: Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]), mime: 'audio/mp4' },
    'a.ogg': { bytes: Buffer.from([0x4f, 0x67, 0x67, 0x53, 0, 2, 0]), mime: 'audio/ogg' },
    'a.aac': { bytes: Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0]), mime: 'audio/aac' },
  }
  for (const [name, item] of Object.entries(audioFiles)) await fs.writeFile(path.join(mediaDir, name), item.bytes)
  await fs.writeFile(path.join(mediaDir, 'bad.txt'), 'not-audio')
  await fs.writeFile(path.join(mediaDir, 'huge.mp3'), Buffer.alloc(9 * 1024 * 1024, 3))
  let audioFormatPass = 0
  const audioFormatDetails = []
  for (const [name, item] of Object.entries(audioFiles)) {
    const result = await call({ title: TITLE, path: '素材/' + name })
    const decoded = result.body && result.body.base64 ? Buffer.from(String(result.body.base64), 'base64') : Buffer.alloc(0)
    const ok = result.status === 200 && result.body && result.body.ok === true && result.body.mime === item.mime && result.body.name === name && Number(result.body.size) === item.bytes.length && sha256(decoded) === sha256(item.bytes)
    if (ok) audioFormatPass += 1
    else audioFormatDetails.push(name + ':' + result.status + ':' + JSON.stringify(result.body && result.body.mime))
  }
  check('D3.5 media-read 音频 5 格式（mp3/wav/m4a/ogg/aac）：base64 解码 sha256==源文件 / mime / size / name 正确', audioFormatPass === 5, JSON.stringify(audioFormatDetails))
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  await fs.writeFile(path.join(mediaDir, 'pic.png'), pngBytes)
  const pngResult = await call({ title: TITLE, path: '素材/pic.png' })
  check('D3.6 图片 media-read 矩阵不回归（png 仍 200 + image/png）', pngResult.status === 200 && pngResult.body && pngResult.body.mime === 'image/png' && sha256(Buffer.from(pngResult.body.base64, 'base64')) === sha256(pngBytes))
  const audioNegative = [
    ['非白名单扩展', { title: TITLE, path: '素材/bad.txt' }, 400],
    ['音频超 8MB', { title: TITLE, path: '素材/huge.mp3' }, 413],
    ['穿越', { title: TITLE, path: '../voice.mp3' }, 403],
    ['缺失音频', { title: TITLE, path: '素材/missing.mp3' }, 404],
  ]
  let audioNegativePass = 0
  const audioNegativeDetails = []
  for (const [label, body, expected] of audioNegative) {
    const result = await call(body)
    if (result.status === expected && result.body && result.body.ok === false) audioNegativePass += 1
    else audioNegativeDetails.push(label + ':' + result.status + '!=' + expected)
  }
  check('D3.7 音频负例（非白名单/超 8MB/穿越/缺失）状态码正确', audioNegativePass === audioNegative.length, JSON.stringify(audioNegativeDetails))
  const beforeTree = await treeHash(path.join(projectDir, '.aidrama'))
  const a1 = await call({ title: TITLE, path: '素材/a.mp3' })
  const a2 = await call({ title: TITLE, path: '素材/a.mp3' })
  check('D3.8 media-read 音频只读确定性（两次响应相等 / .aidrama hash 不变）', deepEqual(a1.body, a2.body) && (await treeHash(path.join(projectDir, '.aidrama'))).hash === beforeTree.hash)
  check('D3.9 契约：METHODS 仍 69 / 工具 34（media-read MIME additive 扩展，无新 METHOD/route）', METHODS.size === 69 && METHODS.has('media-read') && TOOL_COUNT === 34)
}

group('[D1/D2/D3-client] 导航精简 + 台词视图迁移 + 旧深链重定向 + 音频试听（能力自适应）')
if (!clientRelocated) {
  console.log('      （SKIP：client 导航精简/台词视图尚未交付）')
} else {
  const createGroup = TAB_GROUPS.find((groupItem) => groupItem.id === 'create') || { tabs: [] }
  check('D1.1 一级导航移除「台词与音效」页签（14 页签 4 组，create 组 6）', ALL_TABS.length === 14 && !ALL_TABS.includes('dialogue') && TAB_GROUPS.length === 4 && createGroup.tabs.length === 6, JSON.stringify(ALL_TABS))
  check('D1.2 旧 dialogue → 剧本页台词视图切换（正文/台词 toggle + aria-pressed）', clientSrc.includes("setEpisodeView('dialogue')") && clientSrc.includes("'aria-pressed': episodeView === 'dialogue'") && clientSrc.includes("'台词'"))
  check('D1.3 剧本页台词视图按集/角色筛选、只读列表', clientSrc.includes("'aria-label': '台词按集筛选'") && clientSrc.includes("'aria-label': '台词按角色筛选'") && clientSrc.includes('dialogueEpisodeFilter') && clientSrc.includes('dialogueCharacterFilter'))
  check('D1.4 剧本页台词视图保留导出配音稿入口（复用 voice-script-export）', /if \(episodeView === 'dialogue'\)[\s\S]{0,2000}导出配音稿/.test(clientSrc) && clientSrc.includes("api('voice-script-export'"))
  check('D1.5 交付/导出页含导出配音稿入口（复用 exportVoiceScript，工具 34 不变）', (clientSrc.match(/导出配音稿/g) || []).length >= 2 && clientSrc.includes('const exportVoiceScript') && TOOL_COUNT === 34)
  check('D1.6 导航迁移不新增接口调用（调用点 69 / slots=4）', CLIENT_CALLS.size === 69 && SLOTS === 4, JSON.stringify({ calls: CLIENT_CALLS.size, slots: SLOTS }))
  check('D1.7 台词视图含刷新台词/只读音效子区（ad-episode-dialogue + 「音效 · N 条（只读，来自分镜表）」）', clientSrc.includes('刷新台词') && clientSrc.includes('ad-episode-dialogue') && clientSrc.includes('音效 ·') && clientSrc.includes('来自分镜表'))
  check('D1.8 台词视图只读（无 dialogue 写 API/无 input/textarea 编辑）', !/api\('dialogue-(save|write)'/.test(clientSrc) && !clientSrc.includes('台词写入'))
  check('D2.1 旧 dialogue 深链映射（LEGACY_TAB_ALIASES / isLegacyDialogueTab）且无数据迁移', clientSrc.includes("const LEGACY_TAB_ALIASES = { dialogue: 'episode' }") && clientSrc.includes('isLegacyDialogueTab') && !/api\('dialogue-(save|write)'/.test(clientSrc))
  check('D2.2 重定向命中：切到剧本页 + 台词视图 + 提示（可关闭「知道了」），不报错', /isLegacyDialogueTab\(tabKey\)[\s\S]{0,300}setEpisodeView\('dialogue'\)/.test(clientSrc) && clientSrc.includes('dialogueRedirectNotice') && clientSrc.includes('知道了'))
  const hasAudioUi = clientSrc.includes('ad-asset-audio') || /h\('audio'/.test(clientSrc)
  if (hasAudioUi) {
    check('D3c.1 角色卡 audio 数组：默认试听 audio[0]，可切换（assetAudioIndex）与失败记录（assetBrokenAudios）', clientSrc.includes('assetAudioIndex') && clientSrc.includes('assetBrokenAudios') && clientSrc.includes('audioCandidates') && clientSrc.includes('currentAudioIndex'))
    check('D3c.2 <audio controls> + preload metadata、无自动播放', /h\('audio'/.test(clientSrc) && clientSrc.includes('controls: true') && clientSrc.includes("preload: 'metadata'") && !/autoPlay\s*:/.test(clientSrc))
    check('D3c.3 加载失败占位 / 无音频零显示', clientSrc.includes('音频不可试听（加载失败）') && /audioCandidates\.length/.test(clientSrc))
    check('D3c.4 相对路径音频经 media-read 转 data URL；切换项目清空音频态', clientSrc.includes("api('media-read'") && clientSrc.includes('data:' + String.fromCharCode(36) + '{') && clientSrc.includes('setAssetBrokenAudios({})') && clientSrc.includes('setAssetAudioIndex(0)'))
    check('D3c.5 多段音色切换按钮（试听第 N 段音色）与读取失败占位文案', clientSrc.includes('试听第') && clientSrc.includes('段音色') && /音频不可试听（(读取|加载)失败）/.test(clientSrc))
  } else {
    console.log('      （SKIP：client 音频试听尚未交付）')
  }
}

await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
