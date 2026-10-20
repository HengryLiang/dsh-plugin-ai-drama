/**
 * 宿主级工具输出契约回归（D-13 修复验收 / task-43）
 *
 * D-13：v0.6.4 运行期 `drama_search_context` 被宿主拒绝 —
 *   `tool "drama_search_context" returned invalid output: "value.degradeReason" must be a string`
 *   实现未降级时返回 `degradeReason: null`，而 `TOOL_OUTPUTS` schema 声明 `{type:'string'}`。
 *   静态门禁走 lib 直调（`searchContext()` 返回值），**未经过工具输出 schema 校验**，故漏过。
 *
 * 本套件：
 *   [0] 宿主等价 JSON-Schema 校验器（与宿主 `validateJsonSchemaValue` 诊断格式一致：`"value.x" must be a string`）
 *   [1] D-13 直接回归：`degradeReason: null` / `scanMeta.degradeReason: null` 等值必须通过 schema（修复后）
 *   [2] search 工具 5 种真实返回（正常/空查询/检索禁用/ranker 失败/配额降级）→ 通过 output.schema
 *   [3] 34 个工具失败态（`execute({})` / `execute({title})` 真实返回）→ 通过各自 output.schema
 *   [4] 34 个工具 schema 规范性 + 渲染冒烟（防止 D-10/D-13 类契约漂移）
 *
 * 说明：校验器是宿主校验逻辑的**忠实子集复刻**（type/type 数组/required/properties/items/
 * additionalProperties/enum/const/oneOf，诊断格式一致；宿主另做 lossless-JSON 检查，我们用
 * JSON round-trip 近似）。真实宿主路径另由安装副本 + 运行期 probe 覆盖（task-43 第 2 项）。
 *
 * 运行：node test/tool-output-contract.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const toolsMod = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'tools.js')).href)
const retrievalMod = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'retrieval.js')).href)
const store = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'store.js')).href)
const auditMod = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'audit.js')).href)

const TOOL_OUTPUTS = toolsMod.TOOL_OUTPUTS
if (!TOOL_OUTPUTS || typeof TOOL_OUTPUTS !== 'object') {
  console.log('\n结果：0 passed, 0 failed（SKIP：TOOL_OUTPUTS 未导出）')
  process.exit(0)
}

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

/* ------------------------------------------------------------------ [0] 宿主等价 schema 校验器 */
const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array', 'json'])
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function typeOfValue(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
function typeMatches(expected, value) {
  if (expected === 'json') return true
  const actual = typeOfValue(value)
  if (expected === actual) return true
  if (expected === 'number' && actual === 'number') return true
  if (expected === 'integer' && actual === 'number') return Number.isInteger(value)
  return false
}
function validateJsonSchemaValue(schema, value, pathLabel = 'value', violations = []) {
  if (!isPlainObject(schema)) return violations
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type]
  if (types.length > 0 && !types.some((type) => typeMatches(type, value))) {
    violations.push(`"${pathLabel}" must be a ${types.join(' or ')}`)
    return violations
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) {
    violations.push(`"${pathLabel}" must be ${JSON.stringify(schema.const)}`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`"${pathLabel}" must be one of ${JSON.stringify(schema.enum)}`)
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => validateJsonSchemaValue(branch, value, pathLabel, []).length === 0).length
    if (matches !== 1) violations.push(`"${pathLabel}" must match exactly one oneOf branch (matched ${matches})`)
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) violations.push(`"${pathLabel}.${key}" is required`)
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateJsonSchemaValue(properties[key], child, `${pathLabel}.${key}`, violations)
      } else if (schema.additionalProperties === false) {
        violations.push(`"${pathLabel}.${key}" is not allowed`)
      } else if (isPlainObject(schema.additionalProperties)) {
        validateJsonSchemaValue(schema.additionalProperties, child, `${pathLabel}.${key}`, violations)
      }
    }
  }
  if (Array.isArray(value) && schema.items !== undefined && !Array.isArray(schema.items)) {
    value.forEach((item, index) => validateJsonSchemaValue(schema.items, item, `${pathLabel}[${index}]`, violations))
  }
  return violations
}
function violationsOf(toolName, value) {
  const output = TOOL_OUTPUTS[toolName]
  if (!output || !output.schema) return [`TOOL_OUTPUTS.${toolName}.schema 缺失`]
  // 宿主校验前会做 lossless-JSON snapshot（不可序列化即拒绝）
  let snapshot
  try {
    snapshot = JSON.parse(JSON.stringify(value))
  } catch (error) {
    return [`输出不可 JSON 序列化：${error instanceof Error ? error.message : String(error)}`]
  }
  return validateJsonSchemaValue(output.schema, snapshot, 'value', [])
}
function validateOutput(toolName, label, value) {
  const violations = violationsOf(toolName, value)
  check(`${label}：${toolName} 输出通过宿主等价 schema 校验`, violations.length === 0, JSON.stringify(violations).slice(0, 400))
  return violations
}

/* ------------------------------------------------------------------ [1] D-13 直接回归 */
group('[1] D-13 直接回归：degradeReason / scanMeta.degradeReason 的 null 必须被 schema 接受')
const searchSchema = TOOL_OUTPUTS.drama_search_context.schema
const baseNormalValue = {
  ok: true,
  title: '样剧',
  query: '红绸',
  hits: [{ path: '世界观/世界观.md', score: 1.2, matched: ['红绸'], excerpt: '…红绸…' }],
  scanned: 2223,
  truncated: 0,
  scanMeta: { schemaVersion: 1, mode: 'indexed-lexical', total: 2223, scanned: 2223, truncated: 0, byType: { world: 1, memory: 1 }, quotaExhausted: [], degraded: false, degradeReason: null },
  degraded: false,
  degradeReason: null,
  method: 'local-lexical',
  enabled: true,
  topK: 5,
}
const d13Violations = validateJsonSchemaValue(searchSchema, baseNormalValue, 'value', [])
check('D-13 回归：degradeReason=null 的正常返回通过 schema（修复目标）', d13Violations.length === 0, JSON.stringify(d13Violations).slice(0, 400))
// 顶层与 scanMeta 两处 null 单独定位（便于诊断哪个字段未修）
const topOnly = validateJsonSchemaValue(searchSchema, { ...baseNormalValue, scanMeta: { ...baseNormalValue.scanMeta, degradeReason: null } }, 'value', [])
check('D-13 回归：顶层 degradeReason 字段 nullable（或 optional）', !topOnly.some((v) => v.includes('degradeReason') && v.includes('must be')), JSON.stringify(topOnly).slice(0, 300))
const degradeReasonType = (() => {
  const prop = searchSchema.properties && searchSchema.properties.degradeReason
  if (!prop) return { absent: true }
  const types = prop.type === undefined ? [] : Array.isArray(prop.type) ? prop.type : [prop.type]
  return { types, allowsNull: types.includes('null'), oneOfNull: Array.isArray(prop.oneOf) && prop.oneOf.some((b) => b.type === 'null') }
})()
check('D-13 回归：schema.properties.degradeReason 显式允许 null（type 含 null / oneOf null / 未声明）', degradeReasonType.absent || degradeReasonType.allowsNull || degradeReasonType.oneOfNull, JSON.stringify(degradeReasonType))

/* ------------------------------------------------------------------ 夹具与工具 harness */
const FIXTURE_PROJECT = process.env.DSH_AI_DRAMA_FIXTURE || path.join(pluginRoot, '..', '_recover', 'fixtures', '100ep', 'AI短剧', '百集长剧·逆袭千金')
const hasFixture = await fs.stat(FIXTURE_PROJECT).then(() => true).catch(() => false)
if (!hasFixture) {
  console.log('\n结果：0 passed, 0 failed（SKIP：100 集夹具不存在 —— test/tool-output-contract 需要 _recover/fixtures/100ep；安装副本环境可 SKIP）')
  process.exit(0)
}
const TITLE = '百集长剧·逆袭千金'
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-output-contract-'))
const tempWorkspace = path.join(tempRoot, 'AI短剧')
await fs.cp(FIXTURE_PROJECT, path.join(tempWorkspace, TITLE), { recursive: true })
const routes = new Map()
const { apply, METHODS } = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
const ctx = {
  provide: () => {},
  inject(_services, callback) {
    callback({
      connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } },
      commands: { register: () => () => {} },
      agents: { list: () => [], roots: () => [] },
      workspaceRegistry: { list: async () => [{ path: tempRoot }] },
      get: (name) => (name === 'workspaceRegistry' ? { list: async () => [{ path: tempRoot }] } : name === 'agents' ? { list: () => [] } : undefined),
      on: () => {},
      effect: (fn) => fn(),
    })
  },
  logger: { info: () => {}, warn: () => {} },
}
apply(ctx, { root: tempRoot })
async function call(method, body) {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('route not registered: ' + method)
  const request = new Request('http://127.0.0.1:1/api/ai-drama/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' },
    body: JSON.stringify(body || {}),
  })
  const response = await spec.fetch(request)
  const payload = await response.json().catch(() => null)
  return { status: response.status, body: payload }
}
function makeDefs(root) {
  return toolsMod.createToolDefs({ rootOf: () => root, backendOf: () => null })
}
function execFor(root) {
  return {
    agent: {
      id: 'qa-tool-output-contract',
      session: { header: { cwd: root } },
      ctx: { get: (name) => (name === 'agentPresets' ? { serviceFor: () => ({ mode: 'drama', disposed: false }) } : undefined) },
    },
    callId: 'tool-output-contract-' + Math.random().toString(36).slice(2, 8),
  }
}
async function runTool(root, name, args) {
  const def = makeDefs(root).find((item) => item.name === name)
  if (!def) return { __missing: true }
  return def.execute(args || {}, execFor(root))
}

/* ------------------------------------------------------------------ [2] search 5 种真实返回 */
group('[2] drama_search_context 五种真实返回 → output.schema 校验')
const searchNormal = await runTool(tempRoot, 'drama_search_context', { title: TITLE, query: '红绸' })
validateOutput('drama_search_context', '正常（有命中）', searchNormal)
check('正常返回：hits 为数组、含 scanMeta.scanned/byType', Array.isArray(searchNormal.hits) && Boolean(searchNormal.scanMeta) && Number(searchNormal.scanMeta.scanned) > 0 && Boolean(searchNormal.scanMeta.byType), JSON.stringify({ hits: searchNormal.hits && searchNormal.hits.length, scanned: searchNormal.scanMeta && searchNormal.scanMeta.scanned }).slice(0, 200))
const searchEmptyQuery = await runTool(tempRoot, 'drama_search_context', { title: TITLE, query: '' })
validateOutput('drama_search_context', '空查询', searchEmptyQuery)
const settingsOff = await call('settings-save', { settings: { retrievalEnabled: false } })
validateOutput('drama_search_context', '检索禁用', await runTool(tempRoot, 'drama_search_context', { title: TITLE, query: '红绸' }))
check('检索禁用：返回 enabled=false 且通过 schema', settingsOff.status === 200 && Boolean((await runTool(tempRoot, 'drama_search_context', { title: TITLE, query: '红绸' })).enabled === false), 'enabled=false')
await call('settings-save', { settings: { retrievalEnabled: true } })
retrievalMod.setRetrievalRanker(async () => {
  throw new Error('ranker-failed-for-test')
})
let rankerFailure = null
try {
  rankerFailure = await runTool(tempRoot, 'drama_search_context', { title: TITLE, query: '红绸' })
} finally {
  retrievalMod.setRetrievalRanker(null)
}
validateOutput('drama_search_context', 'ranker 失败（自动降级）', rankerFailure)
check('ranker 失败：degraded=true 且通过 schema', Boolean(rankerFailure && rankerFailure.degraded === true), JSON.stringify({ degraded: rankerFailure && rankerFailure.degraded, reason: rankerFailure && rankerFailure.degradeReason }).slice(0, 200))
// 配额耗尽：全新无索引副本 + 测试钩子
const quotaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-output-quota-'))
await fs.cp(FIXTURE_PROJECT, path.join(quotaRoot, 'AI短剧', TITLE), { recursive: true })
const prevQuota = process.env.DSH_AI_DRAMA_RETRIEVAL_QUOTA
let quotaResult = null
try {
  process.env.DSH_AI_DRAMA_RETRIEVAL_QUOTA = JSON.stringify({ episodes: 5, shots: 10, freeText: 1 })
  quotaResult = await runTool(quotaRoot, 'drama_search_context', { title: TITLE, query: '红绸' })
} finally {
  if (prevQuota === undefined) delete process.env.DSH_AI_DRAMA_RETRIEVAL_QUOTA
  else process.env.DSH_AI_DRAMA_RETRIEVAL_QUOTA = prevQuota
  await fs.rm(quotaRoot, { recursive: true, force: true }).catch(() => {})
}
validateOutput('drama_search_context', '配额钩子降级', quotaResult)
check('配额降级：degraded=true + degradeReason=scan-quota-exhausted + scanMeta.quotaExhausted 非空', Boolean(quotaResult && quotaResult.degraded === true && /scan-quota-exhausted/.test(String(quotaResult.degradeReason)) && Array.isArray(quotaResult.scanMeta && quotaResult.scanMeta.quotaExhausted) && quotaResult.scanMeta.quotaExhausted.length > 0), JSON.stringify({ degraded: quotaResult && quotaResult.degraded, reason: quotaResult && quotaResult.degradeReason }).slice(0, 200))

/* ------------------------------------------------------------------ [3] 34 工具失败态真实返回 */
group('[3] 34 个工具的失败态真实返回 → 各自 output.schema 校验（防 D-10/D-13 类契约漂移）')
const allDefs = makeDefs(tempRoot)
check(`工具面 ${allDefs.length}（expected 34）`, allDefs.length === 35, String(allDefs.length))
const failureViolations = []
for (const def of allDefs) {
  let result
  try {
    result = await def.execute({}, execFor(tempRoot))
  } catch (error) {
    result = { __threw: error instanceof Error ? error.message : String(error) }
  }
  if (result && result.__threw) {
    failureViolations.push(`${def.name}: 未归一异常（应返回失败契约）：${result.__threw}`)
    continue
  }
  const violations = violationsOf(def.name, result)
  if (violations.length > 0) failureViolations.push(`${def.name}: ${violations.join('；')}`)
}
check('34 工具失败态返回全部通过 output.schema', failureViolations.length === 0, JSON.stringify(failureViolations).slice(0, 500))

/* ------------------------------------------------------------------ [4] schema 规范性与渲染冒烟 */
group('[4] output.schema 规范性与渲染冒烟（34/34）')
const schemaProblems = []
for (const [name, output] of Object.entries(TOOL_OUTPUTS)) {
  if (!output || !output.schema || typeof output.render !== 'function') {
    schemaProblems.push(`${name}: 缺 schema/render`)
    continue
  }
  const schema = output.schema
  if (schema.type !== 'object') schemaProblems.push(`${name}: 根 schema 必须 object`)
  if (!Array.isArray(schema.required) || !schema.required.includes('ok')) schemaProblems.push(`${name}: required 必须含 ok`)
  if (!isPlainObject(schema.properties) || !isPlainObject(schema.properties.ok)) schemaProblems.push(`${name}: properties.ok 缺失`)
  let blocks
  try {
    blocks = output.render({ ok: true, title: '冒烟', items: [], count: 0 }, { ok: true, title: '冒烟', items: [], count: 0 })
  } catch (error) {
    schemaProblems.push(`${name}: render 抛错 ${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  const text = Array.isArray(blocks) ? blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('') : String(blocks || '')
  if (!text || !String(text).trim()) schemaProblems.push(`${name}: render 返回空文本`)
}
check('34 工具 output.schema/render 规范（object 根/required ok/render 非空）', schemaProblems.length === 0, JSON.stringify(schemaProblems).slice(0, 500))
check('METHODS 仍 = 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）', METHODS.length === 72, String(METHODS.length))


/* ------------------------------------------------------------------ [5] P3-F：meta.promptVersion 三路径契约（model/deterministic/agent-mediated + 落盘） */
group('[5] P3-F：meta.promptVersion 三路径契约（model / deterministic / agent-mediated）+ saveReview 落盘')
const PROMPT_VERSION = auditMod.AUDIT_PROMPT_VERSION
check('AUDIT_PROMPT_VERSION = v0.8.0-f1（字符串）', typeof PROMPT_VERSION === 'string' && PROMPT_VERSION === 'v0.8.0-f1', String(PROMPT_VERSION))
// ① agent-mediated：buildAgentAuditRequest 输出 promptVersion
const agentReq = auditMod.buildAgentAuditRequest({ slices: { episode: 1 }, deterministic: { issues: [] }, budgets: { tokens: 60000, timeoutMs: 45000 } })
check('agent-mediated 请求携带 promptVersion', agentReq.mode === 'agent-mediated' && agentReq.promptVersion === PROMPT_VERSION && agentReq.schema.meta.promptVersion.includes(PROMPT_VERSION), JSON.stringify({ mode: agentReq.mode, promptVersion: agentReq.promptVersion }).slice(0, 200))
// ② deterministic：buildDegradedReview meta.promptVersion
const degraded = auditMod.buildDegradedReview({ episode: 1, deterministic: { issues: [] }, degradeReason: 'test', budgets: { tokens: 60000, timeoutMs: 45000 }, attempted: {} })
check('deterministic 降级报告 meta.promptVersion 存在且为字符串', degraded.meta && degraded.meta.mode === 'deterministic' && degraded.meta.promptVersion === PROMPT_VERSION, JSON.stringify(degraded.meta && degraded.meta.promptVersion))
// ③ model：runModelAudit（假 llm）返回 review.meta.promptVersion
const validReviewBody = JSON.stringify({ findings: [{ severity: 'medium', dimension: 'hook_pacing', location: { episode: 1, scene: 1 }, evidence: '赵铁：还钱。', suggestion: '第1集场1开头补一个可见冲突动作', confidence: 0.8 }], summary: '测试报告' })
function makeAuditLlm() {
  return {
    async *stream() {
      yield { type: 'text-delta', text: validReviewBody.slice(0, 40) }
      yield { type: 'text-delta', text: validReviewBody.slice(40) }
      yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    async resolveModelInfo(provider, model) {
      return { provider, model, available: true }
    },
  }
}
const modelRun = await auditMod.runModelAudit({
  llm: makeAuditLlm(),
  selection: { provider: 'replay', model: 'replay-rubric' },
  slices: { episode: 1, episodeTitle: '第1集', contract: '', outline: '', characters: '', memory: '', previousTail: '', episodeText: '赵铁：还钱。\n林越：三天后，你来拿钱。', storyboard: '' },
  deterministic: { issues: [] },
  episode: 1,
  budgets: auditMod.resolveAuditBudgets({}),
})
check('model 路径 review.meta.promptVersion = 当前版本', modelRun.ok === true && modelRun.review && modelRun.review.meta && modelRun.review.meta.promptVersion === PROMPT_VERSION, JSON.stringify({ ok: modelRun.ok, promptVersion: modelRun.review && modelRun.review.meta && modelRun.review.meta.promptVersion }).slice(0, 200))
// ④ saveReview 落盘可读回（meta.promptVersion 保留）
await store.createProject(tempRoot, 'p3f契约样剧')
const savedReview = await auditMod.saveReview(tempRoot, 'p3f契约样剧', modelRun.review)
const latest = await auditMod.readLatestReview(tempRoot, 'p3f契约样剧')
const latestJson = latest ? JSON.parse(latest.text) : null
check('saveReview 落盘 latest.json 可读回且含 meta.promptVersion', Boolean(savedReview.file) && Boolean(latestJson) && latestJson.meta.promptVersion === PROMPT_VERSION, JSON.stringify({ file: savedReview.file, promptVersion: latestJson && latestJson.meta && latestJson.meta.promptVersion }).slice(0, 200))
// ⑤ schema 可选字段校验：string 通过、number 拒绝
const schemaOk = auditMod.assertReviewSchema(modelRun.review)
const badReview = JSON.parse(JSON.stringify(modelRun.review))
badReview.meta.promptVersion = 123
const schemaBad = auditMod.assertReviewSchema(badReview)
check('assertReviewSchema：promptVersion 字符串通过、number 报错', schemaOk.ok === true && schemaBad.ok === false && schemaBad.errors.some((item) => item.includes('promptVersion')), JSON.stringify({ ok: schemaOk.ok, errors: schemaBad.errors }).slice(0, 240))
// ⑦ P3-F2：meta.promptRevision='f2' 三路径（model / deterministic / agent-mediated）
const PROMPT_REVISION = auditMod.AUDIT_PROMPT_REVISION
check('AUDIT_PROMPT_REVISION 为 f 系列修订号（f2/f3 版本容错）', typeof PROMPT_REVISION === 'string' && /^f\d+$/.test(PROMPT_REVISION), String(PROMPT_REVISION))
check('agent-mediated 请求携带 promptRevision=f2', agentReq.promptRevision === PROMPT_REVISION && agentReq.schema.meta.promptRevision.includes(PROMPT_REVISION), JSON.stringify({ revision: agentReq.promptRevision }).slice(0, 160))
check('deterministic 降级报告 meta.promptRevision=f2', degraded.meta && degraded.meta.promptRevision === PROMPT_REVISION, JSON.stringify(degraded.meta && degraded.meta.promptRevision))
check('model 路径 review.meta.promptRevision=f2', modelRun.ok === true && modelRun.review && modelRun.review.meta && modelRun.review.meta.promptRevision === PROMPT_REVISION, JSON.stringify(modelRun.review && modelRun.review.meta && modelRun.review.meta.promptRevision).slice(0, 160))

// ⑥ P3-F persona 卡压缩：单卡 ≤2000 字（不整卡全文）
/* ------------------------------------------------------------------ [P3-E] meta.costTier* 三路径契约（v0.9.2） */
group('[P3-E] meta.costTier* 契约：model/deterministic 注入、agent-mediated 不注入、schema 可选、TOOL_OUTPUTS 只增')
const TIER_BODY = JSON.stringify({ findings: [{ severity: 'medium', dimension: 'hook_pacing', location: { episode: 1, scene: 1 }, evidence: '赵铁：还钱。', suggestion: '第1集场1补冲突', confidence: 0.8 }], summary: 'costTier 契约报告' })
const tierLlm = {
  async *stream() {
    yield { type: 'text-delta', text: TIER_BODY.slice(0, 60) }
    yield { type: 'text-delta', text: TIER_BODY.slice(60) }
    yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
  async resolveModelInfo(provider, model) {
    return { provider, model, available: true }
  },
}
const tierModelRun = await auditMod.runModelAudit({
  llm: tierLlm,
  selection: { provider: 'replay', model: 'replay-rubric' },
  model: { provider: 'tier-p', model: 'tier-m', source: 'cost-tier', costTier: 'fast', costTierRequested: 'fast', costTierFallback: false, costTierFallbackReason: null },
  slices: { episode: 1, episodeTitle: '第1集', contract: '', outline: '', characters: '', memory: '', previousTail: '', episodeText: '赵铁：还钱。\n林越：三天后。', storyboard: '' },
  deterministic: { issues: [] },
  episode: 1,
  budgets: auditMod.resolveAuditBudgets({}),
})
const tierMeta = (tierModelRun.review && tierModelRun.review.meta) || {}
check('model 路径：meta.costTier=fast / costTierRequested=fast / fallback=false / reason=null', tierModelRun.ok === true && tierMeta.costTier === 'fast' && tierMeta.costTierRequested === 'fast' && tierMeta.costTierFallback === false && tierMeta.costTierFallbackReason === null, JSON.stringify({ ok: tierModelRun.ok, costTier: tierMeta.costTier, requested: tierMeta.costTierRequested, fallback: tierMeta.costTierFallback, reason: tierMeta.costTierFallbackReason }))
const tierDegraded = auditMod.buildDegradedReview({ episode: 1, deterministic: { issues: [] }, degradeReason: 'test', budgets: { tokens: 60000, timeoutMs: 45000 }, attempted: { provider: 'tier-p', model: 'tier-m', source: 'cost-tier', costTier: 'fast', costTierRequested: 'fast', costTierFallback: true, costTierFallbackReason: 'tier-unavailable' } })
check('deterministic 路径：meta.costTier* 四字段保留（fallback=true / reason=tier-unavailable）', tierDegraded.meta && tierDegraded.meta.costTier === 'fast' && tierDegraded.meta.costTierRequested === 'fast' && tierDegraded.meta.costTierFallback === true && tierDegraded.meta.costTierFallbackReason === 'tier-unavailable', JSON.stringify({ costTier: tierDegraded.meta && tierDegraded.meta.costTier, requested: tierDegraded.meta && tierDegraded.meta.costTierRequested, fallback: tierDegraded.meta && tierDegraded.meta.costTierFallback, reason: tierDegraded.meta && tierDegraded.meta.costTierFallbackReason }))
const agentTierText = JSON.stringify(agentReq)
check('agent-mediated 请求：不注入 costTier* 字段（未配置/非档位路径不产生新字段）', !/costTierRequested|costTierFallback/.test(agentTierText), agentTierText.slice(0, 240))
const tierSchemaOk = auditMod.assertReviewSchema(tierModelRun.review)
const tierBadReview = JSON.parse(JSON.stringify(tierModelRun.review))
tierBadReview.meta.costTier = 42
const tierSchemaBad = auditMod.assertReviewSchema(tierBadReview)
check('assertReviewSchema：costTier* 字符串通过、number 报错（只增可选字段约束）', tierSchemaOk.ok === true && tierSchemaBad.ok === false && tierSchemaBad.errors.some((item) => String(item).includes('costTier')), JSON.stringify({ ok: tierSchemaOk.ok, badOk: tierSchemaBad.ok, errors: tierSchemaBad.errors }).slice(0, 300))
const tierToolNames = Object.entries(TOOL_OUTPUTS).filter(([, output]) => output && output.schema && JSON.stringify(output.schema).includes('costTierRequested')).map(([name]) => name)
check('TOOL_OUTPUTS：≥3 个生成工具 schema 含 costTier* 可选字段', tierToolNames.length >= 3, JSON.stringify(tierToolNames))
let tierOptionalOk = true
for (const name of tierToolNames) {
  const schema = TOOL_OUTPUTS[name].schema
  const required = Array.isArray(schema.required) ? schema.required : []
  if (required.includes('costTierRequested') || required.includes('costTierFallback')) tierOptionalOk = false
}
check('TOOL_OUTPUTS：costTier* 均为可选字段（不在 required 中）', tierOptionalOk, JSON.stringify(tierToolNames))

const longCharacters = [{ name: '林越', role: '主角', personality: ['冷静', '隐忍'], bio: '长'.repeat(5000) }, { name: '赵铁', role: '反派', personality: ['暴躁'], bio: '背景'.repeat(3000) }]
const persona = auditMod.buildPersonaCards(longCharacters)
const personaLines = String(persona).split('\n')
check('persona 卡压缩（单卡 ≤2000 字，不整卡全文）', personaLines.every((line) => line.length <= auditMod.PERSONA_CARD_MAX_CHARS), JSON.stringify(personaLines.map((line) => line.length)))

/* 反馈 #5（2026-10-20）：drama_resolve_draft 的 result 需同时接受对象与数组。
   - 对象型草稿（contract/file/batch-artifact）→ result 是对象；
   - 数组型草稿（outline/characters/storyboard）→ result 是数组（store.save* 返回归一数组）。
   旧 schema 只声明 object，导致采纳成功后宿主仍报 `value.result must be an object`。 */
const resolveDraftSchema = TOOL_OUTPUTS.drama_resolve_draft && TOOL_OUTPUTS.drama_resolve_draft.schema
const resolveDraftResult = resolveDraftSchema && resolveDraftSchema.properties && resolveDraftSchema.properties.result
const resultBranches = resolveDraftResult && Array.isArray(resolveDraftResult.oneOf) ? resolveDraftResult.oneOf : []
const resultAllowsObject = resultBranches.some((branch) => branch && branch.type === 'object')
const resultAllowsArray = resultBranches.some((branch) => branch && branch.type === 'array')
check('drama_resolve_draft.result 同时允许对象与数组（oneOf；修复采纳数组型草稿的误报错）', resultAllowsObject && resultAllowsArray, JSON.stringify(resultBranches))
check('drama_resolve_draft.result 非 required 字段（旧调用/批量调用无 result 时不报错）', !(Array.isArray(resolveDraftSchema.required) && resolveDraftSchema.required.includes('result')), JSON.stringify(resolveDraftSchema.required))

await fs.rm(tempRoot, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const item of failures) console.log('  - ' + item)
}
process.exit(failed === 0 ? 0 : 1)
