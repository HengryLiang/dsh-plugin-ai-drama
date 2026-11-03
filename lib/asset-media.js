/**
 * RC-29 / v0.16.135（add-only）：资产图“接受”写面（media-upload add-only purpose:'asset'）。
 *
 * 职责（H3）：
 * - 输入候选图（项目内 `素材/**` 相对路径 或 base64）；≤8MB；png/jpg/jpeg/webp magic bytes；
 * - 目标固定 `素材/短剧资产/<中文类型>/<assetId>-v<newVersion>-<ts>.<ext>`（服务端派生，不接受绝对路径/穿越/junction）；
 * - sha256 内容去重：同资产已存在同内容文件时复用，不重复写；
 * - 同一次项目事务内：复制文件 + 原子写 cards.json（images 追加≤6；首图=thumbnail；replace 可替换）；
 * - final 锁定卡 423（asset-locked），expectedVersion 冲突 409（conflict）；
 * - 不登记 legacy assets（卡片 media 为准；文件在短剧资产目录，core 备份覆盖）；不删原图。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import * as assetCards from './assets.js'
import * as store from './store.js'
import * as txn from './txn.js'

export const ASSET_MEDIA_DIR = '素材/短剧资产'
// RC-35 / v0.16.141：H3 手工接受与 collect 使用同一中文类型目录口径。
const ASSET_TYPE_DIRS = Object.freeze({ CHR: '人物卡', SPC: '场景卡', PRP: '道具卡', SFX: '特效卡', VEH: '载具卡', CST: '服装卡' })
const ASSET_TYPE_DIR_OTHER = '其他'
function assetTypeInfoOf(card, assetId) {
  const match = String(assetId || '').toUpperCase().match(/^([A-Z]+)/)
  const type = String((card && card.type) || (match ? match[1] : '') || 'OTHER').toUpperCase()
  return { type, dir: ASSET_TYPE_DIRS[type] || ASSET_TYPE_DIR_OTHER }
}
export const ASSET_MEDIA_MAX_BYTES = 8 * 1024 * 1024
export const ASSET_IMAGE_MAX = 6
const SOURCE_PREFIX = '素材/'
const IMAGE_EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

function uploadError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

function sniffImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return null
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return { mime: 'image/png', ext: '.png' }
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: '.webp' }
  }
  return null
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !value) throw uploadError('invalid-args', 'dataBase64 必须是非空 base64 字符串')
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw uploadError('invalid-args', 'base64 含非法字符或长度不是 4 的倍数')
  }
  const buffer = Buffer.from(value, 'base64')
  if (!buffer.length) throw uploadError('invalid-args', '上传内容为空')
  return buffer
}

function validateDeclaredType(input, sniffed) {
  const declaredMime = typeof input.mime === 'string' ? input.mime.trim().toLowerCase() : ''
  if (declaredMime && declaredMime !== sniffed.mime) throw uploadError('invalid-args', 'mime 与图片实际类型不一致')
  const filenameRaw = input.filename == null ? '' : String(input.filename).trim()
  if (!filenameRaw) return
  if (filenameRaw.length > 120) throw uploadError('invalid-args', 'filename 过长（上限 120 字符）')
  if (/[\\/:*?"<>|\u0000-\u001f]/u.test(filenameRaw)) throw uploadError('invalid-args', 'filename 含非法字符')
  const namedExt = path.extname(filenameRaw).toLowerCase()
  if (!IMAGE_EXT_MIME[namedExt]) throw uploadError('invalid-args', '仅支持 png/jpg/jpeg/webp 图片')
  const jpegOk = sniffed.mime === 'image/jpeg' && (namedExt === '.jpg' || namedExt === '.jpeg')
  if (!jpegOk && namedExt !== sniffed.ext) throw uploadError('invalid-args', 'filename 扩展名与图片实际类型不一致')
}

/** 读取项目内 `素材/**` 源文件；拒绝绝对路径/穿越/内部数据目录/父链 symlink/junction/超限。 */
async function readProjectSource(projectDir, rawSourcePath) {
  if (typeof rawSourcePath !== 'string' || !rawSourcePath.trim()) throw uploadError('invalid-args', 'sourcePath 不能为空')
  const text = rawSourcePath.trim()
  if (text.length > 1000) throw uploadError('invalid-args', 'sourcePath 过长（上限 1000 字符）')
  if (/[\u0000-\u001f\u007f]/u.test(text)) throw uploadError('invalid-args', 'sourcePath 含控制字符')
  if (/^[A-Za-z]:[\\/]/u.test(text) || /^[\\/]/u.test(text)) throw uploadError('invalid-args', 'sourcePath 必须是项目内相对路径')
  const normalized = text.replace(/\\/g, '/')
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '..' || segment === '.')) {
    throw uploadError('invalid-args', 'sourcePath 不允许空路径段或 .. 跳转')
  }
  if (!segments[0] || `${segments[0]}/` !== SOURCE_PREFIX || segments.length < 2 || segments[1].toLowerCase() === '.aidrama') {
    throw uploadError('invalid-args', 'sourcePath 必须位于项目「素材/」目录内')
  }
  const realProject = await fs.realpath(projectDir).catch(() => null)
  if (!realProject) throw uploadError('not-found', '短剧项目不存在')
  const candidate = path.resolve(realProject, ...segments)
  const relative = path.relative(realProject, candidate)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw uploadError('forbidden', 'sourcePath 越出项目目录')
  // 父链 symlink/junction 拒绝（含最终组件）
  let probe = realProject
  for (const segment of relative.split(path.sep)) {
    probe = path.join(probe, segment)
    const lstat = await fs.lstat(probe).catch(() => null)
    if (!lstat) throw uploadError('not-found', 'sourcePath 指向的文件不存在')
    if (lstat.isSymbolicLink()) throw uploadError('forbidden', 'sourcePath 路径包含符号链接，已拒绝')
  }
  let realFile
  try { realFile = await fs.realpath(candidate) } catch { throw uploadError('not-found', 'sourcePath 指向的文件不存在') }
  if (!isInside(realProject, realFile)) throw uploadError('forbidden', 'sourcePath 越出项目目录')
  const stat = await fs.stat(realFile).catch(() => null)
  if (!stat || !stat.isFile()) throw uploadError('invalid-args', 'sourcePath 必须是普通文件')
  if (stat.size > ASSET_MEDIA_MAX_BYTES) throw uploadError('too-large', `图片过大（${stat.size} 字节 > 上限 ${ASSET_MEDIA_MAX_BYTES} 字节）`)
  const buffer = await fs.readFile(realFile)
  return buffer
}

function isInside(rootReal, candidateReal) {
  const relative = path.relative(rootReal, candidateReal)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function findReusableAssetFile(projectDir, assetId, sha256, size, typeDir) {
  const dirAbs = path.join(projectDir, ...ASSET_MEDIA_DIR.split('/'), typeDir)
  let entries = []
  try { entries = await fs.readdir(dirAbs, { withFileTypes: true }) } catch { return null }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.startsWith(`${assetId}-v`)) continue
    const abs = path.join(dirAbs, entry.name)
    const stat = await fs.stat(abs).catch(() => null)
    if (!stat || stat.size !== size) continue
    const buffer = await fs.readFile(abs).catch(() => null)
    if (!buffer) continue
    const hash = createHash('sha256').update(buffer).digest('hex')
    if (hash === sha256) return `${ASSET_MEDIA_DIR}/${typeDir}/${entry.name}`
  }
  return null
}

/**
 * 接受一张候选图为资产卡图（media-upload purpose:'asset'）。
 * @param {string} root
 * @param {{title:string, purpose?:string, assetId:string, sourcePath?:string, bytes?:string, dataBase64?:string, base64?:string, mime?:string, filename?:string, replace?:boolean, expectedVersion?:number, operationId?:string}} input
 */
export async function uploadAssetImage(root, input = {}) {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) throw uploadError('invalid-args', 'title 必填')
  let projectDir
  try {
    projectDir = store.projectDir(root, title)
  } catch {
    throw uploadError('not-found', '短剧项目不存在')
  }
  if (!(await store.isDirectory(projectDir))) throw uploadError('not-found', '短剧项目不存在')

  const assetId = assetCards.normalizeAssetId(input.assetId)
  if (!assetId) throw uploadError('invalid-args', 'assetId 必填')
  if (!assetCards.isValidAssetId(assetId)) throw uploadError('invalid-args', `资产编号非法：${input.assetId}`)
  if (input.replace !== undefined && typeof input.replace !== 'boolean') throw uploadError('invalid-args', 'replace 必须是布尔值')
  let stateId = null
  if (input.stateId !== undefined && input.stateId !== null) {
    stateId = assetCards.normalizeMediaStateId(input.stateId)
    if (!stateId) throw uploadError('invalid-args', 'stateId 非法（1–40 位字母/数字/_/-）')
  }
  let expectedVersion
  if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw uploadError('invalid-args', 'expectedVersion 必须是正整数')
    expectedVersion = input.expectedVersion
  }

  const hasSource = input.sourcePath !== undefined && input.sourcePath !== null && input.sourcePath !== ''
  const bytesRaw = [input.bytes, input.dataBase64, input.base64].filter((value) => value != null && value !== '')
  if (hasSource && bytesRaw.length) throw uploadError('invalid-args', 'sourcePath 与 base64 只能提供其一')
  if (!hasSource && !bytesRaw.length) throw uploadError('invalid-args', '需要提供 sourcePath 或 dataBase64')
  if (bytesRaw.length > 1 && !bytesRaw.every((value) => value === bytesRaw[0])) {
    throw uploadError('invalid-args', 'bytes 与 dataBase64 不能同时提供不同内容')
  }
  let buffer
  if (hasSource) {
    buffer = await readProjectSource(projectDir, input.sourcePath)
  } else {
    buffer = decodeBase64(bytesRaw[0])
    if (buffer.length > ASSET_MEDIA_MAX_BYTES) throw uploadError('too-large', `图片过大（${buffer.length} 字节 > 上限 ${ASSET_MEDIA_MAX_BYTES} 字节）`)
  }
  const sniffed = sniffImageMime(buffer)
  if (!sniffed) throw uploadError('invalid-args', '仅支持 png/jpg/jpeg/webp 图片（magic bytes 校验失败）')
  validateDeclaredType(input, sniffed)
  const sha256 = createHash('sha256').update(buffer).digest('hex')

  const current = await store.readCardsDoc(root, title, 'asset')
  if (!current.doc || !current.hash) throw uploadError('not-found', '资产卡文件不存在')
  const existingCards = assetCards.normalizeAssetIndex(current.doc).assets
  const card = existingCards.find((item) => String(item.id) === String(assetId)) || null
  if (!card) throw uploadError('not-found', `卡不存在：${assetId}（assets/cards.json）`)
  const review = assetCards.normalizeReview(card.review)
  if (review && review.status === 'final') {
    throw uploadError('asset-locked', '资产已定稿锁定，需先重打开才能更新媒体', { review, currentHash: current.hash })
  }
  if (expectedVersion !== undefined && expectedVersion !== card.version) {
    throw uploadError('conflict', `资产版本不一致（期望 ${expectedVersion}，当前 ${card.version}）`, { currentHash: current.hash, currentVersion: card.version })
  }
  const typeInfo = assetTypeInfoOf(card, assetId)

  const reusedRel = await findReusableAssetFile(projectDir, assetId, sha256, buffer.length, typeInfo.dir)
  const nextVersion = card.version + 1
  const typeDirRel = `${ASSET_MEDIA_DIR}/${typeInfo.dir}`
  const targetRel = reusedRel || `${typeDirRel}/${assetId}-v${nextVersion}-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}${sniffed.ext}`
﻿  const currentMedia = assetCards.normalizeAssetMedia(card.media) || {}
  // v0.16.195：不传 stateId 时，旧单状态卡走根媒体；已有 states 的卡落 default 状态（不是 active）。
  if (!stateId && Array.isArray(currentMedia.states) && currentMedia.states.length) {
    stateId = currentMedia.defaultStateId || currentMedia.states[0].id
  }
  if (String(card.type || '').toUpperCase() !== 'CHR' && (stateId || (Array.isArray(currentMedia.states) && currentMedia.states.length))) {
    throw uploadError('invalid-args', 'v1 仅 CHR 支持状态媒体（非 CHR 新写拒绝）')
  }
  let nextMedia
  if (stateId) {
    const states = Array.isArray(currentMedia.states) ? currentMedia.states : []
    const targetState = states.find((state) => state.id === stateId)
    if (!targetState) throw uploadError('invalid-args', `状态不存在：${stateId}（本版只允许向已有状态上传）`)
    const stateImageList = Array.isArray(targetState.images) ? targetState.images.slice() : []
    let stateImages
    if (input.replace === true) stateImages = [targetRel]
    else {
      if (stateImageList.length >= ASSET_IMAGE_MAX && !stateImageList.includes(targetRel)) throw uploadError('invalid-args', `该状态媒体图已达上限 ${ASSET_IMAGE_MAX} 张；请先移除旧图或使用 replace`)
      stateImages = stateImageList.includes(targetRel) ? stateImageList.slice() : [...stateImageList, targetRel]
    }
    const nextState = { ...targetState, images: stateImages }
    if (input.replace === true) nextState.thumbnail = targetRel
    else if (!nextState.thumbnail) nextState.thumbnail = targetRel
    if (!stateImages.includes(nextState.thumbnail)) nextState.thumbnail = stateImages[0]
    const nextStates = states.map((state) => state.id === stateId ? nextState : state)
    nextMedia = assetCards.normalizeAssetMedia({ ...currentMedia, defaultStateId: currentMedia.defaultStateId, states: nextStates })
    if (!nextMedia) throw uploadError('invalid-args', '状态媒体归一失败')
  } else {
    const currentImages = Array.isArray(currentMedia.images) ? currentMedia.images : []
    let images
    if (input.replace === true) images = [targetRel]
    else {
      if (currentImages.length >= ASSET_IMAGE_MAX && !currentImages.includes(targetRel)) {
        throw uploadError('invalid-args', `媒体图已达上限 ${ASSET_IMAGE_MAX} 张；请先移除旧图或使用 replace`)
      }
      images = currentImages.includes(targetRel) ? currentImages.slice() : [...currentImages, targetRel]
    }
    nextMedia = {
      images,
      thumbnail: input.replace === true || !currentMedia.thumbnail ? targetRel : currentMedia.thumbnail,
      ...(Array.isArray(currentMedia.audio) && currentMedia.audio.length ? { audio: currentMedia.audio } : {}),
    }
  }
  // 生成/复用目标文件名在极端同秒并发下可能重复 → 事务内再由 guard 拒绝；此处仅做友好提示
  if (!reusedRel && await fs.stat(path.join(projectDir, ...targetRel.split('/'))).then(() => true, () => false)) {
    throw uploadError('conflict', '目标资产图已存在，请重试', { currentHash: current.hash })
  }

  return await txn.runProjectTxn(root, title, {
    action: 'media-upload',
    actor: 'panel',
    targets: [targetRel, '.aidrama/assets/cards.json'],
    operationId: typeof input.operationId === 'string' ? input.operationId : '',
  }, async () => {
    let wroteFile = false
    try {
      if (!reusedRel) {
        await store.guardedProjectMkdir(projectDir, typeDirRel)
        await store.guardedProjectWriteBinary(projectDir, targetRel, buffer)
        wroteFile = true
      }
      const saved = await store.saveAssetMedia(root, title, {
        id: assetId,
        media: nextMedia,
        expectedVersion: card.version,
      })
      return {
        ok: true,
        relPath: targetRel,
        path: targetRel,
        ...(stateId ? { stateId } : {}),
        bytes: buffer.length,
        mime: sniffed.mime,
        sha256,
        reused: Boolean(reusedRel),
        assetType: typeInfo.type,
        assetTypeDir: typeInfo.dir,
        targetDir: typeDirRel,
        media: saved.media,
        version: saved.version,
        hash: saved.hash,
      }
    } catch (error) {
      if (wroteFile) await store.guardedProjectRemove(projectDir, targetRel).catch(() => null)
      throw error
    }
  })
}

