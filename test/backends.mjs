/**
 * 阶段二 · 后端适配层自测（FR-G01 / FR-G06 / FR-G11）
 * 用假的 neowow / libtv CLI，不联网、不需要凭据。
 * 运行：node test/backends.mjs
 *
 * 2026-10-17 重建说明：原测试第 [5][6] 节写的是「LibTV = Remote MCP」旧架构
 * （断言 endpoint / not-configured / setup 步骤），但适配层已在 2026-10-16 改为
 * **本地 CLI**（lib/backends/libtv.js 顶部注释），对应测试重写为假 CLI 驱动。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const fakeNeowow = path.join(here, 'fake-neowow.mjs')
const fakeLibtv = path.join(here, 'fake-libtv.mjs')
const neowowMod = await import(pathToFileURL(path.join(here, '..', 'lib', 'backends', 'neowow.js')).href)
const libtvMod = await import(pathToFileURL(path.join(here, '..', 'lib', 'backends', 'libtv.js')).href)
const registryMod = await import(pathToFileURL(path.join(here, '..', 'lib', 'backends', 'index.js')).href)

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

/** neowow 假 CLI 后端 */
function backend(env) {
  return neowowMod.createNeowowBackend({ entry: fakeNeowow, nodeBin: process.execPath, env: { ...process.env, ...env } })
}
/** libtv 假 CLI 后端（nodeBin 存在时以 `node <fake> ...` 方式运行） */
function libtvBackend(env) {
  return libtvMod.createLibtvBackend({ entry: fakeLibtv, nodeBin: process.execPath, env: { ...process.env, ...env } })
}

/* ------------------------------------------------------------------ [1] */
group('[1] 错误行解析')
check('解析 message/errCode/http', (() => {
  const e = neowowMod.parseCliError('[neowow] Token is missing | errCode=2001 | http=200')
  return e.message === 'Token is missing' && e.code === '2001' && e.http === '200'
})())
check('无 errCode 时也能解析', neowowMod.parseCliError('[neowow] 简单地失败了').message === '简单地失败了')
check('空输入不抛错', neowowMod.parseCliError('').message === '未知错误')
check('libtv 错误行解析返回首行', (() => {
  const line = libtvMod.parseCliError('Error: 未登录\n栈信息')
  return typeof line === 'string' && line.includes('未登录')
})())

/* ------------------------------------------------------------------ [2] */
group('[2] 图片积分估算优先级（组合键 > size 键 > 兜底）')
const models = [
  { model_name: 'combo-model', size_pricing_config: { low_1k: 7, medium_2k: 29 }, points_cost_per_image: 999 },
  { model_name: 'size-only-model', size_pricing_config: { '1K': 35, '2K': 50 }, points_cost_per_image: 999 },
  { model_name: 'flat-model', size_pricing_config: {}, points_cost_per_image: 42 },
]
const est = (m, o) => neowowMod.estimateImagePoints(m, o)
check('组合键命中（medium_2k）', est(models[0], { size: '2K', quality: 'medium' }).unit === 29)
check('组合键未命中时退回 size 键', est(models[1], { size: '2K', quality: 'medium' }).unit === 50 && est(models[1], { size: '2K', quality: 'medium' }).basis === '2K')
check('size 键命中（1K）', est(models[1], { size: '1K', quality: 'medium' }).unit === 35 && est(models[1], { size: '1K', quality: 'medium' }).basis === '1K')
check('都没有时用 points_cost_per_image 兜底', est(models[2], { size: '1K' }).unit === 42 && est(models[2], { size: '1K' }).basis === 'points_cost_per_image')
check('数量相乘', est(models[0], { size: '2K', quality: 'medium', count: 5 }).total === 145)
check('数量非法时按 1 计', est(models[0], { size: '2K', quality: 'medium', count: 0 }).count === 1)
check('无价目返回 null', est({ size_pricing_config: {} }, { size: '1K' }) === null)
check('无模型返回 null', est(null, {}) === null)

/* ------------------------------------------------------------------ [3] */
group('[3] 可用性探测（neowow）')
const availOut = await backend({ FAKE_MODE: 'logged-out' }).available()
check('未登录也视为可用（能读目录）', availOut.ok === true && availOut.loggedIn === false)
check('未登录时 generate=false', availOut.capabilities.generate === false)
check('未登录时 catalog 仍为 true', availOut.capabilities.catalog === true)
check('未登录时 estimateVideo=false', availOut.capabilities.estimateVideo === false)

const availIn = await backend({ FAKE_MODE: 'logged-in' }).available()
check('已登录时 generate=true', availIn.capabilities.generate === true && availIn.loggedIn === true)

const availBroken = await backend({ FAKE_MODE: 'broken' }).available()
check('CLI 报错时 ok=false', availBroken.ok === false && availBroken.reason === 'cli-error', JSON.stringify(availBroken))
check('错误详情已解析', availBroken.detail === '配置文件损坏', availBroken.detail)

const missing = neowowMod.createNeowowBackend({ entry: path.join(here, 'nope.mjs') })
const availMissing = await missing.available()
check('CLI 缺失时给出 cli-missing', availMissing.ok === false && availMissing.reason === 'cli-missing')

/* ------------------------------------------------------------------ [4] */
group('[4] 模型目录与预估（neowow）')
const b = backend({ FAKE_MODE: 'logged-in' })
const catalog = await b.catalog('image')
check('读取图片目录', catalog.length === 3, String(catalog.length))
check('目录被缓存（第二次同引用）', (await b.catalog('image')) === catalog)

const estCombo = await b.estimate({ kind: 'image', model: 'combo-model', size: '2K', quality: 'medium', count: 4 })
check('按模型名估算', estCombo.ok === true && estCombo.points.total === 116, JSON.stringify(estCombo))
check('估算带 basis 说明', estCombo.points.basis === 'medium_2k')
check('未知模型被拒', (await b.estimate({ kind: 'image', model: '不存在' })).reason === 'model-not-found')

const estVideo = await b.estimate({ kind: 'video', model: 'fake-video', durationSec: 10 })
check('视频不猜价', estVideo.ok === false && estVideo.reason === 'no-local-pricing')
check('视频估算标注需登录', estVideo.requiresLogin === true)
check('不支持的类型被拒', (await b.estimate({ kind: 'sticker' })).reason === 'unsupported-kind')

/* ------------------------------------------------------------------ [5] */
group('[5] LibTV（本地 CLI 后端，2026-10-16 架构）')
const lb = libtvBackend({ FAKE_MODE: 'logged-in' })
const tvAvail = await lb.available()
check('已登录时可用', tvAvail.ok === true && tvAvail.loggedIn === true, JSON.stringify(tvAvail).slice(0, 160))
check('读到昵称', tvAvail.nickname === '测试账号')
check('能力位：可生成/可读目录/不本地估图', tvAvail.capabilities.generate === true && tvAvail.capabilities.catalog === true && tvAvail.capabilities.estimateImage === false)
check('返回入口路径', typeof tvAvail.entry === 'string' && tvAvail.entry.endsWith('fake-libtv.mjs'))

const tvVip = await libtvBackend({ FAKE_MODE: 'vip' }).available()
check('VIP 会员被识别', tvVip.vip === true && String(tvVip.membership).includes('VIP'), JSON.stringify(tvVip.membership))

const tvOut = await libtvBackend({ FAKE_MODE: 'not-logged-in' }).available()
check('未登录时 ok=false/not-logged-in', tvOut.ok === false && tvOut.reason === 'not-logged-in', JSON.stringify(tvOut).slice(0, 160))
check('未登录详情含提示', String(tvOut.detail).includes('未登录'), String(tvOut.detail))
const tvBroken = await libtvBackend({ FAKE_MODE: 'broken' }).available()
check('凭据损坏也归类为不可用', tvBroken.ok === false && String(tvBroken.detail).includes('凭据文件损坏'), JSON.stringify(tvBroken).slice(0, 160))
const tvMissing = await libtvMod.createLibtvBackend({ entry: path.join(here, 'nope.mjs') }).available()
check('CLI 缺失时给出 cli-missing', tvMissing.ok === false && tvMissing.reason === 'cli-missing')

const tvCatalog = await lb.catalog('image')
check('读取图片模型目录', tvCatalog.length === 2, String(tvCatalog.length))
check('目录归一化字段', tvCatalog[0].modelKey === 'lib-image-2.5-s' && tvCatalog[0].modelName === 'Lib Image 2.5 Pro')
check('目录被缓存（第二次同引用）', (await lb.catalog('image')) === tvCatalog)
check('VIP 标记保留', tvCatalog.some((m) => m.vip === true) && tvCatalog.some((m) => m.vip === false))

const tvEstImage = await lb.estimate({ kind: 'image', model: 'lib-image-2.5-s' })
check('LibTV 不本地猜价（文字计价）', tvEstImage.ok === false && tvEstImage.reason === 'textual-pricing', JSON.stringify(tvEstImage).slice(0, 160))
check('文字计价带说明', typeof tvEstImage.note === 'string' && tvEstImage.note.includes('不本地推算'))
const tvEstVideo = await lb.estimate({ kind: 'video', model: 'star-video2.5' })
check('视频计价规则如实返回', tvEstVideo.ok === false && String(tvEstVideo.detail).includes('按秒计价'), JSON.stringify(tvEstVideo).slice(0, 160))
check('未知模型被拒', (await lb.estimate({ kind: 'image', model: '不存在' })).reason === 'model-not-found')

const tvGen = await lb.generate({ name: '镜头1', kind: 'image', prompt: '雨夜' })
check('生成返回节点名', tvGen.ok === true && tvGen.node === '镜头1', JSON.stringify(tvGen).slice(0, 160))
let genErr = null
try {
  await libtvBackend({ FAKE_MODE: 'generate-fails' }).generate({ name: '镜头2', kind: 'image' })
} catch (error) {
  genErr = error instanceof Error ? error.message : String(error)
}
check('生成失败抛可读错误', Boolean(genErr) && genErr.includes('模型不可用'), String(genErr))

const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-libtv-out-'))
const tvDl = await lb.download({ node: 'node-fake-1', outDir })
check('下载返回文件数组（假 CLI 不落盘）', tvDl.ok === true && Array.isArray(tvDl.files) && tvDl.files.length === 0, JSON.stringify(tvDl).slice(0, 160))
let dlErr = null
try {
  await libtvBackend({ FAKE_MODE: 'download-fails' }).download({ node: 'node-x', outDir })
} catch (error) {
  dlErr = error instanceof Error ? error.message : String(error)
}
check('下载失败抛可读错误', Boolean(dlErr) && dlErr.includes('节点无产物'), String(dlErr))
await fs.rm(outDir, { recursive: true, force: true })

/* 纯函数归一化：CLI 输出形状未在文档固定，全部容错解析 */
const normModels = libtvMod.normalizeModels({ matches: [{ modelKey: 'k1', modelName: 'M1', vip: 1, estimatedTime: '30s' }] })
check('normalizeModels 归一化', normModels.length === 1 && normModels[0].modelKey === 'k1' && normModels[0].vip === true)
check('normalizeModels 空输入', libtvMod.normalizeModels(null).length === 0)
const normDone = libtvMod.normalizeNodeDetail({ nodes: [{ nodeKey: 'n1', data: { status: 'SUCCESS', resultData: ['https://example.invalid/a.png'] } }] })
check('normalizeNodeDetail 识别完成', normDone.state === 'done' && normDone.urls.length === 1 && normDone.nodeKey === 'n1', JSON.stringify(normDone))
const normFailed = libtvMod.normalizeNodeDetail({ nodes: [{ data: { status: 'FAILED', errorMessage: '生成失败' } }] })
check('normalizeNodeDetail 识别失败', normFailed.state === 'failed' && normFailed.message === '生成失败', JSON.stringify(normFailed))
check('normalizeNodeDetail 空输入不猜状态', libtvMod.normalizeNodeDetail(null).state === 'missing')
const normCanvas = libtvMod.normalizeCanvasList({ projectMetaList: [{ uuid: 'u1', name: '画布A' }, { uuid: 'u2' }] })
check('normalizeCanvasList 归一化', normCanvas.length === 2 && normCanvas[0].name === '画布A' && normCanvas[1].name === '(未命名画布)')
const normNodes = libtvMod.normalizeNodeList({ nodes: [{ nodeKey: 'n1', name: '镜头1', type: 'image' }, 'raw-key'] })
check('normalizeNodeList 归一化', normNodes.length === 2 && normNodes[0].key === 'n1' && normNodes[1].key === 'raw-key')

/* ------------------------------------------------------------------ [6] */
group('[6] 后端注册表（主选 LibTV / 备选 neowow）')
const reg = registryMod.createBackendRegistry({
  libtv: { entry: fakeLibtv, nodeBin: process.execPath, env: { ...process.env, FAKE_MODE: 'not-logged-in' } },
  neowow: { entry: fakeNeowow, nodeBin: process.execPath, env: { ...process.env, FAKE_MODE: 'logged-in' } },
})
check('两个后端', reg.ids.length === 2 && reg.ids.includes('libtv') && reg.ids.includes('neowow'))
check('按优先级排序（LibTV 在前）', reg.list()[0].id === 'libtv' && reg.list()[1].id === 'neowow')
check('可按 id 取后端', reg.get('libtv') && reg.get('libtv').id === 'libtv')

const probe1 = await reg.probe({})
check('LibTV 不可用时落到备选', probe1.activeBackend === 'neowow', JSON.stringify(probe1).slice(0, 200))
check('标记为降级', probe1.degraded === true)
check('说明文字指出降级原因', probe1.note.includes('备选'), probe1.note)
check('探测结果带两个后端明细', Array.isArray(probe1.backends) && probe1.backends.length === 2)

const regMissing = registryMod.createBackendRegistry({
  libtv: { entry: path.join(here, 'nope.mjs') },
  neowow: { entry: path.join(here, 'nope.mjs') },
})
const probe2 = await regMissing.probe({})
check('都不可用时 activeBackend=null', probe2.activeBackend === null)
check('都不可用时 degraded=true', probe2.degraded === true)
check('都不可用时给出合并说明', probe2.note.includes('都不可用'), probe2.note)

/* ------------------------------------------------------------------ [7] */
group('[7] 超时配置与默认入口（FR-G11）')
check('neowow 默认超时对齐官方 1200 秒', neowowMod.DEFAULT_TIMEOUT_MS === 1_200_000, String(neowowMod.DEFAULT_TIMEOUT_MS))
check('libtv 默认超时对齐官方 1200 秒', libtvMod.DEFAULT_TIMEOUT_MS === 1_200_000, String(libtvMod.DEFAULT_TIMEOUT_MS))
check('neowow 缺省入口指向技能安装位置', neowowMod.defaultEntry().includes(path.join('.agents', 'skills', 'neowow-canvas')))
check('libtv 缺省入口指向官方 CLI', String(libtvMod.DEFAULT_ENTRY).includes('.libtv'))
check('libtv 模型目录类型含分镜', Array.isArray(libtvMod.CATALOG_TYPES) && libtvMod.CATALOG_TYPES.includes('storyboard'))

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
