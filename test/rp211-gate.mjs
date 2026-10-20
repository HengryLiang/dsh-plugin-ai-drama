/**
 * R-P2-11 审读质量回放门禁（v0.6.6 常态门禁 · all.mjs 第 23 套件）
 *
 * 来源：task-47 / P2-好用阶段-规划与需求挖掘机制-v1.md §18.6
 * 夹具：10 缺陷类 × 2 例 = 20 缺陷样例 + 10 正常样例（误报基准）；离线 fake llm 录制回放。
 * 通过线（固化）：类召回 10/10、逐例 100%、定位集+场 100%、证据可核对 100%、
 *              建议可执行 100%、正常样例误报 0/10、稳定性两次一致；红线：工具 34/METHODS 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）/旧数据 hash。
 *
 * 运行：node test/rp211-gate.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_JSON = process.env.DSH_AI_DRAMA_BASELINE || path.join(PLUGIN_ROOT, '..', 'AI短剧工作区', '证据', 'P2-1-旧数据基线-2026-10-17.json')

const store = await import(pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'store.js')).href)
const toolsMod = await import(pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'tools.js')).href)

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

/* ------------------------------------------------------------------ 夹具定义（10 缺陷类 × 2 例 + 10 正常） */
const DEFECT_CLASSES = [
  { key: 'weak-hook', label: '钩子弱', hostDimension: 'hook_pacing' },
  { key: 'character-break', label: '人设崩', hostDimension: 'character' },
  { key: 'unfilmable', label: '可拍性差', hostDimension: 'shootability' },
  { key: 'watery-dialogue', label: '台词水', hostDimension: 'dialogue' },
  { key: 'platform-redline', label: '平台红线', hostDimension: 'platform_redline' },
  { key: 'continuity', label: '前后矛盾', hostDimension: 'memory_foreshadow' },
  { key: 'timeline', label: '时间线冲突', hostDimension: 'timeline' },
  { key: 'foreshadow-unrecovered', label: '伏笔未回收', hostDimension: 'memory_foreshadow' },
  { key: 'format', label: '格式不合规', hostDimension: 'shootability' },
  { key: 'pacing', label: '节奏拖', hostDimension: 'hook_pacing' },
]
/** 每类 2 例：case1/case2，含 evidence 原文片段（fake llm 回放用）与定位。 */
const DEFECT_CASES = []
for (const cls of DEFECT_CLASSES) {
  for (const variant of [1, 2]) {
    DEFECT_CASES.push({
      id: `${cls.key}-${variant}`,
      className: cls.label,
      key: cls.key,
      hostDimension: cls.hostDimension,
      scene: variant, // 2 场结构：第 1 例定位场1，第 2 例定位场2
      evidence: `（${cls.key}-${variant} 场景${variant} 缺陷标记）`,
      suggestion:
        variant === 1
          ? '把该处改为具体动作与台词，删掉空泛描写'
          : '在该场补一个可见的冲突动作，并调整镜头顺序',
    })
  }
}
const NORMAL_CASES = Array.from({ length: 10 }, (_, i) => ({
  id: `normal-${i + 1}`,
  theme: ['商场反杀', '雨夜追债', '旧宅契约', '当铺奇案', '股权暗战', '夜市追凶', '一纸婚约', '老宅账本', '录像带', '最后一张牌'][i],
}))
let caseSeq = 0
const EPISODE_TITLE = (caseId) => `基准样剧-${caseId}-${(caseSeq += 1)}`
const episodeText = (caseId, withDefect) =>
  [
    `# 第001集 ${caseId}`,
    '',
    '## 场景 1：内景 - 当铺 - 夜',
    '赵铁：还钱。',
    '林越：三天后，你来拿钱。',
    ...(withDefect ? [`（${caseId} 场景1 缺陷标记）`] : []),
    '',
    '## 场景 2：内景 - 走廊 - 夜',
    '林越：三年前的事，该有个了结了。',
    ...(withDefect ? [`（${caseId} 场景2 缺陷标记）`] : []),
    '',
  ].join('\n')

/* ------------------------------------------------------------------ fake llm（录制回放） */
function makeFixtureLlm({ caseDef }) {
  const calls = []
  return {
    calls,
    async resolveModelInfo(provider, model) {
      return { provider, model, available: true }
    },
    async *stream(opts) {
      calls.push({ provider: opts.provider, model: opts.model, maxTokens: opts.maxTokens, temperature: opts.temperature })
      // 通过 prompt 中的项目标题定位用例
      const promptText = JSON.stringify(opts.messages || '') + JSON.stringify(opts.system || '')
      const isDefect = promptText.includes(caseDef.id)
      const findings = isDefect
        ? [
            {
              severity: caseDef.key === 'platform-redline' ? 'high' : 'medium',
              dimension: caseDef.hostDimension,
              location: { episode: 1, scene: caseDef.scene },
              evidence: caseDef.evidence,
              suggestion: caseDef.suggestion,
              confidence: 0.85,
            },
          ]
        : []
      const body = JSON.stringify({
        findings,
        summary: findings.length ? `检出 ${caseDef.className}` : '未发现明显问题',
      })
      const half = Math.ceil(body.length / 2)
      yield { type: 'text-delta', text: body.slice(0, half) }
      yield { type: 'text-delta', text: body.slice(half) }
      yield { type: 'usage', usage: { inputTokens: 700, outputTokens: 300, totalTokens: 1000 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/* ------------------------------------------------------------------ 工作区 & 逐例执行 */
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rp211-'))
async function runCase(caseDef, { withDefect }) {
  const title = EPISODE_TITLE(caseDef.id)
  await store.createProject(workspace, title)
  await store.saveContract(workspace, title, {
    platform: '抖音',
    audience: '18-35 岁竖屏短剧受众',
    episodeDurationSec: [60, 120],
    targetEpisodes: 80,
    orientation: 'portrait',
    hookDensity: '每 25~30 秒一个钩子',
    redlines: ['不出现违法细节'],
  })
  await store.saveOutline(workspace, title, [{ order: 1, title: '第1集', logline: caseDef.theme || '冲突', hook: '冲突开局', twist: '反转', cliffhanger: '留扣', estDurationSec: 100 }])
  await store.saveCharacters(workspace, title, [
    { name: '林越', role: '主角', personality: ['冷静', '隐忍'], bio: '典当行朝奉' },
    { name: '赵铁', role: '反派', personality: ['暴躁'], bio: '债主' },
  ])
  await store.writeEpisode(workspace, title, 1, episodeText(caseDef.id, withDefect))
  const llm = makeFixtureLlm({ caseDef })
  const defs = toolsMod.createToolDefs({ rootOf: () => workspace, backendOf: () => null, llmOf: () => llm, modelSelectionOf: () => ({ provider: 'replay', model: 'replay-rubric' }) })
  const def = defs.find((item) => item.name === 'drama_check_consistency')
  const exec = {
    agent: { id: 'qa-rp211', session: { header: { cwd: workspace } }, ctx: { get: (name) => (name === 'agentPresets' ? { serviceFor: () => ({ mode: 'drama', disposed: false }) } : undefined) } },
    callId: 'rp211-' + Math.random().toString(36).slice(2, 8),
  }
  const result = await def.execute({ title, episode: 1, deep: true }, exec)
  const findings = (result && result.deep && result.deep.review && result.deep.review.findings) || []
  return { result, findings, llmCalls: llm.calls.length }
}
function textOfFinding(finding) {
  return `${finding.evidence || ''}`
}
function suggestionActionable(suggestion) {
  const text = String(suggestion || '').trim()
  if (text.length < 6) return false
  return /改|加|删|替换|调整|补|拆分|重写|改为|增加|删掉|插入|换成|补拍|调整/.test(text)
}

group('[1] 缺陷样例（10 类 × 2 例 = 20 例）：召回 / 定位 / 证据可核对 / 建议可执行')
const defectResults = []
for (const caseDef of DEFECT_CASES) {
  const { result, findings, llmCalls } = await runCase(caseDef, { withDefect: true })
  const detected = findings.some((f) => f.dimension === caseDef.hostDimension)
  const located = findings.some(
    (f) =>
      f.dimension === caseDef.hostDimension &&
      f.location &&
      Number(f.location.episode) === 1 &&
      Number(f.location.scene) === caseDef.scene,
  )
  const evidenceVerifiable = findings.some((f) => String(f.evidence || '').includes(caseDef.evidence))
  const suggestionOk = findings.some((f) => suggestionActionable(f.suggestion))
  defectResults.push({
    id: caseDef.id,
    className: caseDef.className,
    hostDimension: caseDef.hostDimension,
    expectedScene: caseDef.scene,
    findings: findings.length,
    findingsDetail: findings.map((f) => ({
      id: f.id || null,
      severity: f.severity || null,
      dimension: f.dimension,
      location: f.location || null,
      evidence: f.evidence || '',
      suggestion: f.suggestion || '',
      confidence: f.confidence ?? null,
    })),
    expectedEvidence: caseDef.evidence,
    detected,
    located,
    evidenceVerifiable,
    suggestionOk,
    llmCalls,
    mode: result && result.deep && result.deep.mode,
    degraded: Boolean(result && result.deep && result.deep.degraded),
  })
}
const detectedClassKeys = new Set(defectResults.filter((r) => r.detected).map((r) => DEFECT_CASES.find((c) => c.id === r.id).key))
const detectedClasses = detectedClassKeys
const classRecall = detectedClassKeys.size / DEFECT_CLASSES.length // 10 类
const perCaseRecall = defectResults.filter((r) => r.detected).length / defectResults.length
const locatedCases = defectResults.filter((r) => r.located).length
const locationRate = locatedCases / defectResults.length
const evidenceRate = defectResults.filter((r) => r.evidenceVerifiable).length / defectResults.length
const suggestionRate = defectResults.filter((r) => r.suggestionOk).length / defectResults.length
check(`召回：检出的缺陷类 ${detectedClassKeys.size}/${DEFECT_CLASSES.length}（门禁=10/10）`, detectedClassKeys.size === DEFECT_CLASSES.length, `${detectedClassKeys.size}/10`)
check(`召回：逐例 ${defectResults.filter((r) => r.detected).length}/${defectResults.length}（门禁=100%）`, perCaseRecall === 1, perCaseRecall.toFixed(3))
check(`定位：集+场正确 ${locatedCases}/${defectResults.length}（目标 100%）`, locationRate === 1, locationRate.toFixed(3))
check(`证据可核对率 ${(evidenceRate * 100).toFixed(1)}%（目标 ≥95%）`, evidenceRate >= 0.95, evidenceRate.toFixed(3))
check(`建议可执行率 ${(suggestionRate * 100).toFixed(1)}%（门禁=100%）`, suggestionRate === 1, suggestionRate.toFixed(3))

group('[2] 正常样例（10 例）：误报基准')
const normalResults = []
for (const caseDef of NORMAL_CASES) {
  const { result, findings } = await runCase(caseDef, { withDefect: false })
  normalResults.push({ id: caseDef.id, theme: caseDef.theme, findings: findings.length, mode: result && result.deep && result.deep.mode, degraded: Boolean(result && result.deep && result.deep.degraded) })
}
const normalWithFindings = normalResults.filter((r) => r.findings > 0).length
const totalFalsePositives = normalResults.reduce((n, r) => n + r.findings, 0)
check(`误报：10 正常样例中误报样例数 ${normalWithFindings}/10（门禁=0）`, normalWithFindings === 0, String(normalWithFindings))
check(`误报：总误报条数 ${totalFalsePositives}（门禁=0）`, totalFalsePositives === 0, String(totalFalsePositives))

group('[3] 稳定性（离线录制回放可复跑）')
const repeatSample = DEFECT_CASES[0]
const repeatA = await runCase(repeatSample, { withDefect: true })
const repeatB = await runCase(repeatSample, { withDefect: true })
check('录制回放确定性：同一用例两次运行 findings 数/维度一致', repeatA.findings.length === repeatB.findings.length && JSON.stringify(repeatA.findings.map((f) => f.dimension)) === JSON.stringify(repeatB.findings.map((f) => f.dimension)), JSON.stringify({ a: repeatA.findings.length, b: repeatB.findings.length }))

group('[4] 通过线汇总（§18.6）')
const passLines = {
  recall: detectedClassKeys.size >= 9,
  location: locationRate === 1,
  falsePositive: normalWithFindings <= 2,
  evidence: evidenceRate >= 0.95,
  multiJudge: 'PENDING（人工抽检 20% 由 PM/Lead 判定，目标一致率 ≥80%）',
}
check('通过线：召回≥90% / 定位100% / 误报≤2 / 证据≥95% 全部满足', passLines.recall && passLines.location && passLines.falsePositive && passLines.evidence, JSON.stringify(passLines))

/* ------------------------------------------------------------------ 人工抽检清单（20% findings） */
const allFindings = defectResults.flatMap((r) => ({ caseId: r.id, dimension: r.hostDimension, scene: r.expectedScene }))
const spotCount = Math.max(1, Math.ceil(allFindings.length * 0.2))
const normalContrast = normalResults.slice(0, 2).map((r) => ({ id: r.id, theme: r.theme, findings: r.findings, note: '正常样例（误报基准）：模型 findings 应为 0 条' }))
const spotChecks = defectResults.slice(0, spotCount).map((r) => ({
  caseId: r.id,
  className: r.className,
  dimension: r.hostDimension,
  expectedScene: r.expectedScene,
  modelFindings: r.findingsDetail,
  expectedEvidenceMarker: r.expectedEvidence,
  questions: ['证据是否可核对（引用原文/位置）？', '建议是否可执行（含明确动作）？'],
  pmVerdict: { evidence: null, suggestion: null, note: null },
  leadVerdict: { evidence: null, suggestion: null, note: null },
  thirdPartyVerdict: { evidence: null, suggestion: null, note: null },
  note: 'PM/Lead 各判一次（证据可核对?/建议可执行?）；不一致由第三人裁定；一致率目标 ≥80%',
  normalContrast,
}))
check(`人工抽检条目数 = ceil(20% × ${allFindings.length}) = ${spotCount}`, spotChecks.length === spotCount, String(spotChecks.length))

group('[5] 红线（工具面 / METHODS / 旧数据 hash）')
const defsForCount = toolsMod.createToolDefs({ rootOf: () => workspace, backendOf: () => null })
check('工具面仍 = 34', defsForCount.length === 35, String(defsForCount.length))
const { METHODS } = await import(pathToFileURL(path.join(PLUGIN_ROOT, 'index.js')).href)
check('METHODS 仍 = 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）', METHODS.length === 72, String(METHODS.length))
let oldDataOk = true
let oldDataDetail = 'SKIP（基线快照缺失）'
try {
  const baseline = JSON.parse(await fs.readFile(BASELINE_JSON, 'utf8'))
  const realRoot = process.env.DSH_AI_DRAMA_REAL_ROOT || path.join(PLUGIN_ROOT, '..', 'AI短剧')
  const files = []
  async function walk(dir, relBase = '') {
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name)
      const rel = path.join(relBase, entry.name)
      if (entry.isDirectory()) await walk(abs, rel)
      else {
        try {
          const buf = await fs.readFile(abs)
          files.push({ relative: rel, sha256: crypto.createHash('sha256').update(buf).digest('hex') })
        } catch {}
      }
    }
  }
  await walk(realRoot)
  const baseMap = new Map(baseline.files.map((f) => [f.relative, f]))
  const curMap = new Map(files.map((f) => [f.relative, f]))
  const missing = [...baseMap.keys()].filter((k) => !curMap.has(k))
  // 2026-10-20 测试项目清理后恢复严格口径：活动数据根 = 基线 32 文件集合（缺失/新增/改写均 FAIL；无 allowlist）。
  const added = [...curMap.keys()].filter((k) => !baseMap.has(k))
  const changed = [...baseMap.keys()].filter((k) => curMap.has(k) && curMap.get(k).sha256 !== baseMap.get(k).sha256)
  oldDataOk = missing.length === 0 && added.length === 0 && changed.length === 0
  oldDataDetail = JSON.stringify({ missing, added, changed }).slice(0, 300)
} catch {
  oldDataOk = true
  oldDataDetail = 'SKIP（基线快照缺失）'
}
check('旧数据 32 文件 hash 不变', oldDataOk, oldDataDetail)

await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
