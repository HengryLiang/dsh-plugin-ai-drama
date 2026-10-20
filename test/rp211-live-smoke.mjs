/**
 * R-P2-11 真实模型抽测（v0.6.6 起每版本 1 次 · 手动运行，不入 all.mjs）
 *
 * 用途：对 10 例缺陷（各类 1 例，真实模型 deep 审读）记录 findings/维度/定位/误报 + tokens/耗时，
 *       产出 `证据/R-P2-11-真实抽测-<版本>-<日期>.json`；与回放门禁（test/rp211-gate.mjs）互补，
 *       回放验证管线/rubric，本脚本验证真实模型质量。
 *
 * 用法：
 *   1) 准备夹具项目：node test/rp211-live-smoke.mjs --prepare --out _recover/rp211-live
 *      （创建 10 个缺陷项目，标题 `R11-<classKey>`，正文含证据标记；另写 MANIFEST.json 与下一轮提示）
 *   2) 运行真实模型：用 qa_drama_probe（cwd=<out>）指示 Agent 对每个 `R11-*` 项目调用
 *      drama_check_consistency {title, episode:1, deep:true}，并产出 findings JSON（输入 schema 见下）
 *   3) 评分：node test/rp211-live-smoke.mjs --score <findings.json> [--version v0.6.6]
 *
 * 输入 JSON schema（由 probe/人工整理）：
 *   { version, model, cases: [ { caseId, title, findings: [ { dimension, location:{episode,scene}, evidence, suggestion } ], tokens?, elapsedMs? } ] }
 * 评分：类召回（≥9/10 通过线）、逐例召回、定位集+场、证据可核对（evidence 含期望标记）、建议可执行、tokens/耗时记录。
 *
 * 注意：真实模型调用消耗 tokens（约 3.4 万/版）；运行前确认版本已安装并重启。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const EVIDENCE_DIR = path.join(pluginRoot, '..', 'AI短剧工作区', '证据')

const DEFECT_CLASSES = [
  { key: 'weak-hook', label: '钩子弱', dimension: 'hook_pacing' },
  { key: 'character-break', label: '人设崩', dimension: 'character' },
  { key: 'unfilmable', label: '可拍性差', dimension: 'shootability' },
  { key: 'watery-dialogue', label: '台词水', dimension: 'dialogue' },
  { key: 'platform-redline', label: '平台红线', dimension: 'platform_redline' },
  { key: 'continuity', label: '前后矛盾', dimension: 'memory_foreshadow' },
  { key: 'timeline', label: '时间线冲突', dimension: 'timeline' },
  { key: 'foreshadow-unrecovered', label: '伏笔未回收', dimension: 'memory_foreshadow' },
  { key: 'format', label: '格式不合规', dimension: 'shootability' },
  { key: 'pacing', label: '节奏拖', dimension: 'hook_pacing' },
]
const NORMAL_THEMES = ['商场反杀', '雨夜追债']

function evidenceMarker(caseId) {
  return `（${caseId} 场景1 缺陷标记）`
}
async function buildProject(root, store, title, { defect }) {
  await store.createProject(root, title)
  await store.saveContract(root, title, {
    platform: '抖音',
    audience: '18-35 岁竖屏短剧受众',
    episodeDurationSec: [60, 120],
    targetEpisodes: 80,
    orientation: 'portrait',
    hookDensity: '每 25~30 秒一个钩子',
    redlines: ['不出现违法细节'],
  })
  await store.saveOutline(root, title, [{ order: 1, title: '第1集', logline: defect ? '冲突' : '日常', hook: '冲突开局', twist: '反转', cliffhanger: '留扣', estDurationSec: 100 }])
  await store.saveCharacters(root, title, [
    { name: '林越', role: '主角', personality: ['冷静', '隐忍'], bio: '典当行朝奉' },
    { name: '赵铁', role: '反派', personality: ['暴躁'], bio: '债主' },
  ])
  await store.writeEpisode(
    root,
    title,
    1,
    [
      `# 第001集 ${title}`,
      '',
      '## 场景 1：内景 - 当铺 - 夜',
      '赵铁：还钱。',
      '林越：三天后，你来拿钱。',
      ...(defect ? [`${evidenceMarker(defect)}`] : []),
      '',
      '## 场景 2：内景 - 走廊 - 夜',
      '林越：三年前的事，该有个了结了。',
      '',
    ].join('\n'),
  )
}

function usage() {
  console.log('R-P2-11 真实模型抽测（手动运行）：')
  console.log('  准备夹具：node test/rp211-live-smoke.mjs --prepare --out _recover/rp211-live')
  console.log('  评分：    node test/rp211-live-smoke.mjs --score <findings.json> [--version v0.6.6]')
  console.log('（不入 all.mjs；真实模型 tokens 约 3.4 万/版，安装+重启后运行 1 次）')
}

/* ------------------------------------------------------------------ 模式 1：准备夹具 */
async function prepare(outDir) {
  const store = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'store.js')).href)
  const root = path.resolve(outDir)
  await fs.mkdir(path.join(root, 'AI短剧'), { recursive: true })
  const manifest = { at: new Date().toISOString(), kind: 'R-P2-11-live-smoke', cases: [] }
  for (const cls of DEFECT_CLASSES) {
    const title = `R11-${cls.key}`
    await buildProject(root, store, title, { defect: cls.key })
    manifest.cases.push({ caseId: `live-${cls.key}`, title, className: cls.label, expectedDimension: cls.dimension, expectedScene: 1, expectedEvidenceMarker: evidenceMarker(cls.key), defect: true })
  }
  for (const theme of NORMAL_THEMES) {
    const title = `R11-normal-${theme}`
    await buildProject(root, store, title, { defect: null })
    manifest.cases.push({ caseId: `live-normal-${theme}`, title, className: '正常样例', expectedDimension: null, expectedScene: null, expectedEvidenceMarker: null, defect: false })
  }
  await fs.writeFile(path.join(root, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log('已准备夹具：' + root)
  console.log('缺陷项目：' + DEFECT_CLASSES.map((c) => `R11-${c.key}`).join(' / '))
  console.log('正常项目：' + NORMAL_THEMES.map((t) => `R11-normal-${t}`).join(' / '))
  console.log('下一步：用 qa_drama_probe(cwd=' + root + ') 指示 Agent 对 10 个 R11-* 缺陷项目 + 2 个正常项目各调用 drama_check_consistency {title, episode:1, deep:true}，')
  console.log('        然后按本脚本头注释 schema 整理 findings JSON（或从会话日志提取），执行 --score 评分。')
  console.log('MANIFEST：' + path.join(root, 'MANIFEST.json'))
}

/* ------------------------------------------------------------------ 模式 2：评分真实模型结果 */
function suggestionActionable(suggestion) {
  const text = String(suggestion || '').trim()
  if (text.length < 6) return false
  return /改|加|删|替换|调整|补|拆分|重写|改为|增加|删掉|插入|换成|补拍|调整/.test(text)
}
/** Lead 建议的 v0.6.6 观察项：建议具体性（含具体对象/位置/镜头/台词 → specific；仅泛化动作 → generic）。 */
function suggestionSpecificity(suggestion) {
  const text = String(suggestion || '').trim()
  const specific = text.length >= 12 && /(第?\d+集|场\s*\d+|镜\s*\d+|镜头|特写|近景|中景|远景|台词|人物|角色|场景|画面|开场|结尾|具体动作|动作)/.test(text)
  return specific ? 'specific' : 'generic'
}
async function score(inputPath, version) {
  const input = JSON.parse(await fs.readFile(inputPath, 'utf8'))
  const cases = Array.isArray(input.cases) ? input.cases : []
  const defectExpected = new Map(DEFECT_CLASSES.map((c) => [c.key, c]))
  const results = []
  for (const item of cases) {
    const caseId = String(item.caseId || item.title || '')
    const expected = [...defectExpected.entries()].find(([key]) => caseId.includes(key) || key.includes(caseId))
    const isDefect = Boolean(expected)
    const findings = Array.isArray(item.findings) ? item.findings : []
    if (!isDefect) {
      results.push({ caseId, defect: false, findings: findings.length, falsePositive: findings.length > 0 })
      continue
    }
    const [, cls] = expected
    const detected = findings.some((f) => f && f.dimension === cls.dimension)
    const located = findings.some(
      (f) => f && f.dimension === cls.dimension && f.location && Number(f.location.episode) === 1 && Number(f.location.scene) === 1,
    )
    const evidenceVerifiable = findings.some((f) => {
      const evidence = String(f?.evidence || '').trim()
      if (!evidence) return false
      if (evidence.includes(evidenceMarker(cls.key)) || /缺陷标记/.test(evidence)) return true
      // 真实模型会引用自然原文/场景描述：与剧本正文做 ≥8 字符连续重叠判定
      const episodeText = String(item.episodeText || '')
      if (!episodeText) return false
      const normalized = evidence.replace(/\s+/g, '')
      const textNormalized = episodeText.replace(/\s+/g, '')
      const minOverlap = 8
      for (let i = 0; i + minOverlap <= normalized.length; i += 1) {
        if (textNormalized.includes(normalized.slice(i, i + minOverlap))) return true
      }
      return false
    })
    const suggestionOk = findings.some((f) => f && suggestionActionable(f.suggestion))
    const suggestionSpecific = findings.some((f) => f && suggestionSpecificity(f.suggestion) === 'specific')
    results.push({ caseId, title: item.title, defect: true, className: cls.label, expectedDimension: cls.dimension, findings: findings.length, detected, located, evidenceVerifiable, suggestionOk, suggestionSpecific, tokens: item.tokens ?? null, elapsedMs: item.elapsedMs ?? null })
  }
  const defectRows = results.filter((r) => r.defect)
  const normalRows = results.filter((r) => !r.defect)
  const detectedClasses = new Set(
    defectRows
      .map((r) => {
        const match = DEFECT_CLASSES.find((cls) => String(r.caseId).includes(cls.key))
        return match && r.detected ? match.key : null
      })
      .filter(Boolean),
  )
  const classRecall = detectedClasses.size / DEFECT_CLASSES.length
  const perCaseRecall = defectRows.length ? defectRows.filter((r) => r.detected).length / defectRows.length : 0
  const locationRate = defectRows.length ? defectRows.filter((r) => r.located).length / defectRows.length : 0
  const evidenceRate = defectRows.length ? defectRows.filter((r) => r.evidenceVerifiable).length / defectRows.length : 0
  const suggestionRate = defectRows.length ? defectRows.filter((r) => r.suggestionOk).length / defectRows.length : 0
  const suggestionSpecificRate = defectRows.length ? defectRows.filter((r) => r.suggestionSpecific).length / defectRows.length : 0
  const falsePositiveSamples = normalRows.filter((r) => r.findings > 0).length
  const pass = classRecall >= 0.9 && evidenceRate >= 0.95 && falsePositiveSamples <= 2
  const report = {
    at: new Date().toISOString(),
    kind: 'R-P2-11 真实模型抽测',
    version: version || input.version || 'unknown',
    model: input.model || null,
    inputPath: path.resolve(inputPath),
    cases: results,
    summary: {
      defectCases: defectRows.length,
      classRecall: `${detectedClasses.size}/${DEFECT_CLASSES.length}`,
      perCaseRecall: Number(perCaseRecall.toFixed(3)),
      locationRate: Number(locationRate.toFixed(3)),
      evidenceVerifiableRate: Number(evidenceRate.toFixed(3)),
      suggestionActionableRate: Number(suggestionRate.toFixed(3)),
      suggestionSpecificRate: Number(suggestionSpecificRate.toFixed(3)),
      normalSamplesWithFindings: falsePositiveSamples,
      totalTokens: results.reduce((n, r) => n + (Number(r.tokens) || 0), 0),
      totalElapsedMs: results.reduce((n, r) => n + (Number(r.elapsedMs) || 0), 0),
    },
    passLines: { recall90: classRecall >= 0.9, evidence95: evidenceRate >= 0.95, falsePositiveLe2: falsePositiveSamples <= 2 },
    pass,
    note: '真实模型抽测（非回放）；目标：类召回≥9/10、证据可核对≥95%、误报≤2/10（定位/建议为记录项）',
    promptRevision: [...new Set(cases.map((item) => item.promptRevision).filter(Boolean))].join(',') || null,
    observation: 'suggestionSpecificRate=「建议具体性」观察项（Lead 2026-10-18 要求；回放样例偏模板，真实模型应给含具体对象/位置/镜头/台词的建议）；不达标→v0.7.0 审读 prompt 优化输入',
  }
  const out = path.join(EVIDENCE_DIR, `R-P2-11-真实抽测-${report.version}-2026-10-18.json`)
  await fs.mkdir(EVIDENCE_DIR, { recursive: true })
  await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify(report.summary, null, 2))
  console.log('证据已写入：' + out + '（pass=' + pass + '）')
  process.exit(pass ? 0 : 1)
}

/* ------------------------------------------------------------------ 入口 */
const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const scoreIdx = args.indexOf('--score')
const versionIdx = args.indexOf('--version')
if (args.includes('--prepare')) {
  const outDir = outIdx >= 0 ? args[outIdx + 1] : null
  if (!outDir) {
    console.log('用法：node test/rp211-live-smoke.mjs --prepare --out _recover/rp211-live')
    process.exit(2)
  }
  await prepare(outDir)
} else if (scoreIdx >= 0) {
  const inputPath = args[scoreIdx + 1]
  if (!inputPath) {
    usage()
    process.exit(2)
  }
  await score(inputPath, versionIdx >= 0 ? args[versionIdx + 1] : null)
} else {
  console.log('\n结果：0 passed, 0 failed（SKIP：R-P2-11 真实模型抽测为手动运行，需安装 v0.6.6 后执行；见用法）')
  usage()
  process.exit(0)
}
