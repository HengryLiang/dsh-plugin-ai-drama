/**
 * 导出（FR-E03 / FR-E04）：Markdown 全本、JSON 结构化包、CSV 拍摄用分镜表。
 * 产物写入项目 导出/ 目录。
 *
 * P1-D / T10 校验链：
 *   - 写盘目标检查 checkExportTarget()：目录可创建/可写/剩余空间足够；
 *   - sha256 清单 buildExportManifest()：导出目录旁生成 `manifest.sha256.json`；
 *   - 复算入口 verifyExport()：离线/内部/QA 复用，篡改必报差异（不新增 HTTP route）；
 *   - 确定性检查 runDeterministicChecks() 在 lib/checks.js，导出结果内附摘要。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import * as store from './store.js'
import { atomicWrite } from './store.js'
import { runDeterministicChecks } from './checks.js'

export const EXPORT_FORMATS = ['markdown', 'json', 'csv']

/** 导出产物旁的 sha256 清单文件名（T10 冻结口径）。 */
export const MANIFEST_FILE = 'manifest.sha256.json'

/** 导出最小剩余空间：低于该值直接拒绝，避免写一半。 */
const MIN_FREE_BYTES = 10 * 1024 * 1024

const sha256Of = (buffer) => createHash('sha256').update(buffer).digest('hex')

function csvCell(value) {
  const text = String(value == null ? '' : value).replace(/\r?\n/g, ' ')
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function safeFileStem(title) {
  return String(title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
}

/** 拍摄用分镜表：一行一个镜头，含所有执行必需字段。
 * 列顺序保持旧版 9 列不变，末尾追加「生图提示词」「视频提示词」两列（P1-D 冻结口径，旧消费者兼容）。 */
export async function buildStoryboardCsv(root, title) {
  const header = ['集数', '镜号', '景别', '运镜', '画面描述', '台词', '音效', '时长(秒)', '提示词', '生图提示词', '视频提示词']
  const lines = [header.join(',')]
  const episodes = await store.listEpisodes(root, title)
  for (const episode of episodes) {
    const shots = await store.getStoryboard(root, title, episode.order)
    for (const shot of shots) {
      lines.push(
        [
          episode.order,
          shot.shotNumber,
          shot.shotSize,
          shot.cameraMove,
          shot.description,
          shot.dialogue,
          shot.sfx,
          shot.durationSec,
          shot.imagePrompt,
          shot.imagePrompt,
          shot.videoPrompt,
        ]
          .map(csvCell)
          .join(','),
      )
    }
  }
  return lines.join('\n') + '\n'
}

async function buildJson(root, title) {
  const contract = await store.getContract(root, title)
  const outline = await store.getOutline(root, title)
  const characters = await store.getCharacters(root, title)
  const episodes = await store.listEpisodes(root, title)
  const detail = []
  for (const episode of episodes) {
    const { text } = await store.readEpisode(root, title, episode.order)
    detail.push({
      order: episode.order,
      script: text,
      storyboard: await store.getStoryboard(root, title, episode.order),
    })
  }
  return {
    generator: 'dsh-ai-drama',
    version: 1,
    exportedAt: new Date().toISOString(),
    title,
    contract,
    outline,
    characters,
    episodes: detail,
  }
}

async function buildMarkdown(root, title) {
  const project = await buildJson(root, title)
  const parts = [`# ${title}`, '', `> 导出自「AI 短剧」工作区 · ${project.exportedAt}`, '']

  parts.push('## 剧集契约', '')
  parts.push('| 字段 | 值 |', '|---|---|')
  const c = project.contract
  parts.push(`| 平台 | ${c.platform || '—'} |`)
  parts.push(`| 受众 | ${c.audience || '—'} |`)
  parts.push(`| 单集时长 | ${(c.episodeDurationSec || []).join(' ~ ')} 秒 |`)
  parts.push(`| 目标集数 | ${c.targetEpisodes || '—'} |`)
  parts.push(`| 画幅 | ${c.orientation === 'landscape' ? '横屏' : '竖屏'} |`)
  parts.push(`| 钩子密度 | ${c.hookDensity || '—'} |`)
  parts.push(`| 审核红线 | ${c.redlines || '—'} |`, '')

  parts.push('## 分集大纲', '')
  parts.push('| 集数 | 标题 | 一句话梗概 | 开场钩子 | 中段反转 | 结尾悬念 | 时长(秒) |', '|---|---|---|---|---|---|---|')
  for (const row of project.outline) {
    parts.push(
      `| ${[row.order, row.title, row.logline, row.hook, row.twist, row.cliffhanger, row.estDurationSec]
        .map((v) => String(v == null ? '' : v).replace(/\|/g, '\\|'))
        .join(' | ')} |`,
    )
  }
  parts.push('')

  parts.push('## 人物设定', '')
  for (const card of project.characters) {
    parts.push(`### ${card.name}（${card.role}）`, '')
    parts.push(`- 性格：${(card.personality || []).join('、') || '—'}`)
    parts.push(`- 形象提示词：${card.appearancePrompt || '—'}`)
    parts.push(`- 音色：${card.voiceHint || '—'}`, '')
    if (card.bio) parts.push(card.bio, '')
  }

  for (const episode of project.episodes) {
    parts.push(`## 第 ${episode.order} 集`, '')
    if (episode.script) parts.push(episode.script.trim(), '')
    if (episode.storyboard.length) {
      parts.push('### 分镜表', '')
      parts.push('| 镜号 | 景别 | 运镜 | 画面描述 | 台词 | 音效 | 时长(秒) | 提示词 | 视频提示词 |', '|---|---|---|---|---|---|---|---|---|')
      for (const shot of episode.storyboard) {
        parts.push(
          `| ${[shot.shotNumber, shot.shotSize, shot.cameraMove, shot.description, shot.dialogue, shot.sfx, shot.durationSec, shot.imagePrompt, shot.videoPrompt]
            .map((v) => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\n/g, ' '))
            .join(' | ')} |`,
        )
      }
      parts.push('')
    }
  }

  return parts.join('\n')
}

/** 导出写盘目标检查（P1-D/T10）：目录可建、可写、剩余空间足够；失败抛出（工具契约归为 io-error）。 */
export async function checkExportTarget(outDir) {
  await fs.mkdir(outDir, { recursive: true })
  const probe = path.join(outDir, `.write-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
  try {
    await fs.writeFile(probe, 'ok', 'utf8')
  } catch (error) {
    throw new Error(`导出目录不可写：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await fs.rm(probe, { force: true })
  }
  // 剩余空间闸门：拿不到 statfs（老内核/特殊盘）时跳过，不误伤正常导出。
  try {
    const stat = await fs.statfs(outDir)
    const free = Number(stat.bavail) * Number(stat.bsize)
    if (Number.isFinite(free) && free > 0 && free < MIN_FREE_BYTES) {
      throw new Error(`导出目录所在磁盘剩余空间不足（${(free / 1024 / 1024).toFixed(1)} MB，至少需要 ${MIN_FREE_BYTES / 1024 / 1024} MB）`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('剩余空间不足')) throw error
  }
  return { ok: true, dir: outDir }
}

/**
 * 生成/刷新导出目录的 sha256 清单（T10 冻结口径）：
 *   `{ version:1, generatedAt, project, algorithm:'sha256', files:[{path,bytes,sha256}] }`
 * `path` 相对「导出/」目录，便于把产物目录整体拷走离线复算；清单自身不计入。
 */
export async function buildExportManifest(root, title) {
  const projectPath = store.projectDir(root, title)
  const exportDir = path.join(projectPath, '导出')
  await checkExportTarget(exportDir)
  let entries = []
  try {
    entries = await fs.readdir(exportDir, { withFileTypes: true })
  } catch {
    entries = []
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === MANIFEST_FILE || entry.name.startsWith('.write-probe-')) continue
    const file = path.join(exportDir, entry.name)
    const buffer = await fs.readFile(file)
    files.push({ path: entry.name, bytes: buffer.length, sha256: sha256Of(buffer) })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    project: title,
    algorithm: 'sha256',
    files,
  }
  const manifestFile = path.join(exportDir, MANIFEST_FILE)
  await atomicWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  return { file: manifestFile, relative: path.relative(projectPath, manifestFile), manifest }
}

const FORMAT_SUFFIX = { markdown: '-全本.md', json: '.json', csv: '-分镜表.csv' }

/**
 * 复算导出清单（不新增 HTTP route，供内部/QA/离线复用）：
 * 逐个文件重算 sha256 与 bytes，比对 manifest；缺失/被篡改都返回差异定位。
 * `format` 省略表示校验清单内全部产物。
 */
export async function verifyExport(root, title, format = 'all') {
  const projectPath = store.projectDir(root, title)
  const exportDir = path.join(projectPath, '导出')
  const manifestFile = path.join(exportDir, MANIFEST_FILE)
  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
  } catch {
    return { ok: false, reason: `缺少导出清单：${MANIFEST_FILE}`, manifestFile, checked: 0, mismatched: [], missing: [], files: [] }
  }
  const suffix = FORMAT_SUFFIX[format] || ''
  const targets = (manifest.files || []).filter((item) => suffix ? String(item.path).endsWith(suffix) : true)
  const results = []
  for (const item of targets) {
    const file = path.join(exportDir, item.path)
    let actual = null
    let bytes = null
    try {
      const buffer = await fs.readFile(file)
      actual = sha256Of(buffer)
      bytes = buffer.length
    } catch {
      actual = null
      bytes = null
    }
    results.push({
      path: item.path,
      ok: actual !== null && actual === item.sha256 && bytes === item.bytes,
      expected: item.sha256,
      actual,
      bytes: { expected: item.bytes, actual: bytes },
    })
  }
  const mismatched = results.filter((item) => !item.ok)
  return {
    ok: results.length > 0 && mismatched.length === 0,
    manifestFile,
    checked: results.length,
    mismatched,
    missing: results.filter((item) => item.actual === null).map((item) => item.path),
    files: results,
    checkedAt: new Date().toISOString(),
  }
}

export async function exportProject(root, title, format = 'markdown') {
  if (!EXPORT_FORMATS.includes(format)) throw new Error(`不支持的导出格式：${format}`)
  const dir = store.projectDir(root, title)
  if (!(await store.isDirectory(dir))) throw new Error(`短剧《${title}》不存在`)
  const outDir = path.join(dir, '导出')
  // 写盘目标检查（P1-D/T10）：目录/可写性/空间，避免写一半或写错位置
  await checkExportTarget(outDir)
  const stem = safeFileStem(title)

  let file
  let bytes
  if (format === 'markdown') {
    const content = await buildMarkdown(root, title)
    file = path.join(outDir, `${stem}-全本.md`)
    await atomicWrite(file, content)
    bytes = Buffer.byteLength(content, 'utf8')
  } else if (format === 'json') {
    const content = JSON.stringify(await buildJson(root, title), null, 2) + '\n'
    file = path.join(outDir, `${stem}.json`)
    await atomicWrite(file, content)
    bytes = Buffer.byteLength(content, 'utf8')
  } else {
    const content = await buildStoryboardCsv(root, title)
    file = path.join(outDir, `${stem}-分镜表.csv`)
    await atomicWrite(file, '\ufeff' + content) // BOM：便于 Excel 正确识别中文
    bytes = Buffer.byteLength(content, 'utf8')
  }

  // 写后校验链：sha256 清单 → 复算 → 确定性检查摘要（不阻断；strict 由工具层决定）
  const manifest = await buildExportManifest(root, title)
  const verify = await verifyExport(root, title, format)
  const checks = await runDeterministicChecks(root, { title })
  return {
    format,
    file,
    bytes,
    manifest: { file: manifest.file, relative: manifest.relative, fileCount: manifest.manifest.files.length },
    verify: { ok: verify.ok, checked: verify.checked },
    checks: {
      ok: checks.ok,
      summary: checks.summary,
      failed: checks.checks.filter((item) => !item.ok).map((item) => ({ id: item.id, label: item.label, detail: item.detail, where: item.where })),
    },
  }
}

export async function exportAll(root, title) {
  const results = []
  for (const format of EXPORT_FORMATS) {
    results.push(await exportProject(root, title, format))
  }
  return results
}
