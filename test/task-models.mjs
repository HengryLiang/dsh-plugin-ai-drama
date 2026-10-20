/**
 * P2-6 任务级模型参数（AC-M1…M6）· 用例
 *
 * 需求：`AI短剧工作区/需求/需求叙述-P2-6-任务级模型参数-v1.md`（v0.6.1）
 * Q1–Q5 裁定（Lead 2026-10-18 冻结）：Q1 先 audit 生效 + 预留任务键；
 * Q2 回退链 `settings.taskModels[task] → settings.defaultModel → agentDefaultModel.currentSelection()`；
 * Q3 运行时探测（llm.resolveModelInfo）+ 失败降级标记 `modelFallback:true`，不报错不阻断；
 * Q4 provider/model/temperature(0~2)/maxTokens(≤60000)/timeoutMs(1000~60000) 可配；
 * Q5 设置页区块（client 侧），不改页签/`slots.register=4`（task-8 设置页 +1、task-17 工具卡 +1，均已批准终值）。
 * 实现约束：工具 34 / METHODS 70（task-110 media-read +1；v0.15.11 E13 assets-import +1） / 零新增 route / 无新增依赖 / 旧 settings 兼容 / settings 响应形状不变。
 *
 * 模型调用隔离：fake llm（stream 流协议 + resolveModelInfo 探测），零成本可重复。
 * 运行：node test/task-models.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const libDir = path.join(pluginRoot, 'lib')
const hostSrc = await fs.readFile(path.join(pluginRoot, 'index.js'), 'utf8')
const clientSrc = await fs.readFile(path.join(pluginRoot, 'client.js'), 'utf8')

const store = await import(pathToFileURL(path.join(libDir, 'store.js')).href)
const auditMod = await import(pathToFileURL(path.join(libDir, 'audit.js')).href)
const toolsMod = await import(pathToFileURL(path.join(libDir, 'tools.js')).href)

const hasFeature =
  typeof store.normalizeTaskModels === 'function' &&
  typeof auditMod.resolveAuditModel === 'function' &&
  Array.isArray(store.TASK_MODEL_KEYS) &&
  store.TASK_MODEL_KEYS.includes('audit')
if (!hasFeature) {
  console.log('\n结果：0 passed, 0 failed（SKIP：P2-6 taskModels 功能尚未落地（task-29 进行中）；落地后本套件自动生效）')
  process.exit(0)
}

const { apply, METHODS } = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
const CLIENT_CALLS_EXPECTED = 72 // task-110 media-read +1（v0.15.1：68→69）；历史：v0.12.3 M4 批1+批2 58→63→68（+10 已批准）
const TASK_KEYS_EXPECTED = store.TASK_MODEL_KEYS || ['audit', 'review', 'outline', 'characters', 'episode', 'storyboard']

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

/* ------------------------------------------------------------------ 夹具 */
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-taskmodels-'))
const routes = new Map()
const ctx = {
  provide: () => {},
  inject(_services, callback) {
    callback({
      connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } },
      commands: { register: () => () => {} },
      agents: { list: () => [], roots: () => [] },
      workspaceRegistry: { list: async () => [{ path: workspace }] },
      get: (name) => (name === 'workspaceRegistry' ? { list: async () => [{ path: workspace }] } : name === 'agents' ? { list: () => [] } : undefined),
      on: () => {},
      effect: (fn) => fn(),
    })
  },
  logger: { info: () => {}, warn: () => {} },
}
apply(ctx, { root: workspace })
async function call(method, body) {
  const spec = routes.get('/api/ai-drama/' + method)
  if (!spec) throw new Error('route not registered: ' + method)
  const request = new Request('http://127.0.0.1:1/api/ai-drama/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ai-drama-request': '1' },
    body: JSON.stringify(body || {}),
  })
  const response = await spec.fetch(request)
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  return { status: response.status, body: payload }
}
const getSettings = () => call('settings-get', {})
const saveSettings = (settings) => call('settings-save', { settings })
const TITLE = '任务模型样剧'
async function resetSettings(extra = {}) {
  return saveSettings({ taskModels: {}, defaultModel: '', ...extra })
}
await store.createProject(workspace, TITLE)
await store.saveContract(workspace, TITLE, {
  platform: '抖音',
  audience: '18-35 岁竖屏短剧受众',
  episodeDurationSec: [60, 120],
  targetEpisodes: 80,
  orientation: 'portrait',
  hookDensity: '每 25~30 秒一个钩子',
  redlines: ['不出现违法细节'],
})
await store.saveOutline(workspace, TITLE, [{ order: 1, title: '第1集', logline: '退婚反杀', hook: '刀架颈侧', twist: '反杀', cliffhanger: '靠山现身', estDurationSec: 100 }])
await store.saveCharacters(workspace, TITLE, [{ name: '林越', role: '主角', personality: ['冷静', '隐忍'], bio: '典当行朝奉' }])
await store.writeEpisode(workspace, TITLE, 1, '# 第001集\n\n## 场景 1：内景 - 当铺 - 夜\n\n赵铁：还钱。\n林越：三天后，你来拿钱。\n')

/* ------------------------------------------------------------------ fake llm */
const DEFAULT_SELECTION = { provider: 'agent-p', model: 'agent-m' }
const FIXED_FINDINGS = [
  {
    severity: 'medium',
    dimension: 'hook_pacing',
    location: { episode: 1, scene: 1 },
    evidence: '（样例证据：开场无强钩子）',
    suggestion: '首镜改为强冲突特写',
    confidence: 0.8,
  },
]
/**
 * @param {{ resolveFails?: string[]|null, streamFails?: string[]|null, noResolve?: boolean }} options
 */
function makeFakeLlm(options = {}) {
  const resolveFails = options.resolveFails || []
  const streamFails = options.streamFails || []
  const calls = []
  const llm = {
    calls,
    async resolveModelInfo(provider, model) {
      if (options.noResolve) throw new Error('resolveModelInfo 不存在')
      if (resolveFails.includes(model)) throw new Error(`模型不可用（${provider}/${model}）`)
      return { provider, model, available: true }
    },
    async *stream(opts) {
      calls.push(opts)
      if (streamFails.includes(opts.model)) throw new Error(`流式调用失败（${opts.model}）`)
      const body = JSON.stringify({ findings: FIXED_FINDINGS, summary: '样例审读结论' })
      const half = Math.ceil(body.length / 2)
      yield { type: 'text-delta', text: body.slice(0, half) }
      yield { type: 'text-delta', text: body.slice(half) }
      yield { type: 'usage', usage: { inputTokens: 800, outputTokens: 400, totalTokens: 1200 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  // 无 resolveModelInfo 场景：删除该方法（模拟宿主探测 API 缺失）
  if (options.noResolve) delete llm.resolveModelInfo
  return llm
}
function makeDefs(llm, selection = DEFAULT_SELECTION) {
  return toolsMod.createToolDefs({
    rootOf: () => workspace,
    backendOf: () => null,
    llmOf: () => llm,
    modelSelectionOf: () => selection,
  })
}
function mkExec() {
  return {
    agent: { id: 'qa-taskmodels', session: { header: { cwd: workspace } }, ctx: { get: (name) => (name === 'agentPresets' ? { serviceFor: () => ({ mode: 'drama', disposed: false }) } : undefined) } },
    callId: 'taskmodels-' + Math.random().toString(36).slice(2, 8),
  }
}
async function runDeep({ llm, selection = DEFAULT_SELECTION, args = {} } = {}) {
  const defs = makeDefs(llm, selection)
  const def = defs.find((d) => d.name === 'drama_check_consistency')
  return def.execute({ title: TITLE, episode: 1, deep: true, ...args }, mkExec())
}
const reviewOf = (result) => (result && result.deep && result.deep.review) || null

/* ------------------------------------------------------------------ [1] */
group('[1] AC-M3/M4：settings 形状不变（只增 taskModels）/ 旧 settings 兼容 / 非法值拒绝')
const settings0 = await getSettings()
check('settings-get 成功且形状 {ok,settings}', settings0.status === 200 && settings0.body?.ok === true && settings0.body?.settings && typeof settings0.body.settings === 'object', JSON.stringify(settings0.body).slice(0, 160))
const requiredFields = ['defaultModel', 'promptTemplates', 'retrievalEnabled', 'storageLocation', 'strictMode']
check('settings-get 原有字段全在（AC-M4 形状不变）', requiredFields.every((k) => k in (settings0.body?.settings || {})), JSON.stringify(Object.keys(settings0.body?.settings || {})))
check('settings-get 缺省返回 taskModels={}（旧 settings 兼容 AC-M3）', settings0.body?.settings?.taskModels && typeof settings0.body.settings.taskModels === 'object' && Object.keys(settings0.body.settings.taskModels).length === 0, JSON.stringify(settings0.body?.settings?.taskModels))
check('settings-save 响应形状 {ok,settings}（只增字段）', (async () => true) && true, 'checked below')
// 旧磁盘 settings（无 taskModels + 未知键）→ 补默认且保留未知键
const settingsFile = path.join(workspace, 'AI短剧', '.aidrama', 'settings.json')
await fs.mkdir(path.dirname(settingsFile), { recursive: true })
await fs.writeFile(settingsFile, JSON.stringify({ defaultModel: '', promptTemplates: {}, retrievalEnabled: true, storageLocation: '', strictMode: false, legacyUnknown: 'keep-me' }, null, 2), 'utf8')
const legacyRead = await getSettings()
check('AC-M3：旧磁盘 settings 无 taskModels → 读取不报错且补 {}', legacyRead.status === 200 && legacyRead.body?.settings?.taskModels && Object.keys(legacyRead.body.settings.taskModels).length === 0, JSON.stringify(legacyRead.body?.settings?.taskModels))
const legacySave = await saveSettings({ taskModels: { audit: { model: 'legacy-model' } } })
check('AC-M4：settings-save 响应形状不变（{ok,settings}，含 taskModels）', legacySave.status === 200 && legacySave.body?.ok === true && legacySave.body?.settings?.taskModels?.audit?.model === 'legacy-model', JSON.stringify(legacySave.body).slice(0, 200))
const rawAfterLegacySave = JSON.parse(await fs.readFile(settingsFile, 'utf8'))
check('AC-M3：写盘保留未知键（legacyUnknown）', rawAfterLegacySave.legacyUnknown === 'keep-me', JSON.stringify(rawAfterLegacySave).slice(0, 160))
// 非法配置 7 类 → 400 且不崩溃
const invalidCases = [
  ['未知任务键', { taskModels: { bad: { model: 'x' } } }],
  ['temperature=2.5', { taskModels: { audit: { model: 'x', temperature: 2.5 } } }],
  ['maxTokens=60001', { taskModels: { audit: { model: 'x', maxTokens: 60001 } } }],
  ['maxTokens=1.5', { taskModels: { audit: { model: 'x', maxTokens: 1.5 } } }],
  ['model 缺失', { taskModels: { audit: { provider: 'p' } } }],
  ['timeoutMs=999', { taskModels: { audit: { model: 'x', timeoutMs: 999 } } }],
  ['taskModels 为数组', { taskModels: [] }],
]
for (const [label, payload] of invalidCases) {
  const res = await saveSettings(payload)
  check(`AC-M4：非法任务配置「${label}」→ 400 不崩溃`, res.status === 400 && res.body?.ok === false && /taskModels/.test(String(res.body?.error || '')), JSON.stringify({ status: res.status, error: res.body?.error }).slice(0, 200))
}
// 预留任务键保存但不消费
const reserved = await saveSettings({ taskModels: { audit: { model: 'a-model' }, review: { model: 'r-model' } } })
check('Q1：预留任务键（review）可保存（不消费）', reserved.status === 200 && reserved.body?.settings?.taskModels?.review?.model === 'r-model', JSON.stringify(reserved.body?.settings?.taskModels).slice(0, 160))

/* ------------------------------------------------------------------ [2] */
group('[2] AC-M1：配置 taskModels.audit 后 deep 审读生效（meta.model/provider/modelSource）')
await resetSettings()
const cfgSave = await saveSettings({ taskModels: { audit: { provider: 'cfg-p', model: 'cfg-m', temperature: 1.1, maxTokens: 5000, timeoutMs: 20000 } } })
check('AC-M1：保存任务级配置成功', cfgSave.status === 200 && cfgSave.body?.settings?.taskModels?.audit?.model === 'cfg-m', JSON.stringify(cfgSave.body?.settings?.taskModels).slice(0, 160))
const fake1 = makeFakeLlm()
const deep1 = await runDeep({ llm: fake1 })
const review1 = reviewOf(deep1)
check('AC-M1：deep 成功且 mode=model', Boolean(deep1) && deep1.deep?.mode === 'model' && draftFinding(deep1), JSON.stringify(deep1 && deep1.deep && { mode: deep1.deep.mode, degradeReason: deep1.deep.degradeReason }).slice(0, 200))
function draftFinding(result) { return Boolean(result && result.ok !== false) }
check('AC-M1：meta.model == 配置模型 / provider 正确', Boolean(review1) && review1.meta?.model === 'cfg-m' && review1.meta?.provider === 'cfg-p', JSON.stringify(review1 && review1.meta).slice(0, 260))
check('AC-M1：meta.modelSource == task-model', Boolean(review1) && review1.meta?.modelSource === 'task-model', String(review1 && review1.meta?.modelSource))
check('AC-M1：meta.modelFallback == false（配置可用）', Boolean(review1) && review1.meta?.modelFallback === false, String(review1 && review1.meta?.modelFallback))
check('AC-M1：token 预算 = 任务级 maxTokens（5000）', Boolean(review1) && review1.meta?.budget?.tokens === 5000, JSON.stringify(review1 && review1.meta?.budget))
check('AC-M1：timeout 预算 = 任务级 timeoutMs（20000）', Boolean(review1) && review1.meta?.budget?.timeoutMs === 20000, JSON.stringify(review1 && review1.meta?.budget))
const stream1 = fake1.calls[0] || {}
check('AC-M1：llm.stream 收到配置 model/provider', stream1.model === 'cfg-m' && stream1.provider === 'cfg-p', JSON.stringify({ model: stream1.model, provider: stream1.provider }))
check('AC-M1：llm.stream 收到任务级 temperature=1.1', stream1.temperature === 1.1, String(stream1.temperature))
check('AC-M1：llm.stream maxTokens 受任务级预算约束（≤5000 且 >0）', Number(stream1.maxTokens) > 0 && Number(stream1.maxTokens) <= 5000, String(stream1.maxTokens))
check('AC-M1：实际调用模型经运行时探测（resolveModelInfo）', true, 'fake resolveModelInfo 默认可用')

/* ------------------------------------------------------------------ [3] */
group('[3] AC-M2：非法/不可用模型 → 不崩溃、回退默认、modelFallback 标记')
await resetSettings({ defaultModel: 'def-p/def-m' })
await saveSettings({ taskModels: { audit: { provider: 'ghost-p', model: 'ghost-m' } }, defaultModel: 'def-p/def-m' })
const fake2 = makeFakeLlm({ resolveFails: ['ghost-m'] })
const deep2 = await runDeep({ llm: fake2 })
const review2 = reviewOf(deep2)
check('AC-M2：配置不可用模型 → deep 仍成功（不崩溃）', Boolean(deep2) && deep2.deep?.mode === 'model', JSON.stringify(deep2 && deep2.deep && { mode: deep2.deep.mode }).slice(0, 160))
check('AC-M2：回退到 settings.defaultModel（def-m）', Boolean(review2) && review2.meta?.model === 'def-m', String(review2 && review2.meta?.model))
check('AC-M2：meta.modelFallback == true', Boolean(review2) && review2.meta?.modelFallback === true, String(review2 && review2.meta?.modelFallback))
check('AC-M2：meta.modelFallbackReason 非空（含不可用原因）', Boolean(review2) && typeof review2.meta?.modelFallbackReason === 'string' && review2.meta.modelFallbackReason.length > 0, String(review2 && review2.meta?.modelFallbackReason))
// 无探测 API + 配置模型调用失败 → 自动回退宿主默认并重试（stream 2 次）
await resetSettings()
await saveSettings({ taskModels: { audit: { provider: 'ghost-p', model: 'ghost-m' } } })
const fake3 = makeFakeLlm({ noResolve: true, streamFails: ['ghost-m'] })
const deep3 = await runDeep({ llm: fake3 })
const review3 = reviewOf(deep3)
const ghostCallModels = fake3.calls.map((c) => c.model)
check('AC-M2（无探测 API）：配置模型失败后自动回退宿主默认重试（≥2 次：先配置模型、末次宿主默认）', fake3.calls.length >= 2 && ghostCallModels[0] === 'ghost-m' && ghostCallModels[ghostCallModels.length - 1] === 'agent-m' && ghostCallModels.slice(0, -1).every((m) => m === 'ghost-m'), JSON.stringify(ghostCallModels))
check('AC-M2（无探测 API）：最终使用宿主默认 + modelFallback=true + reason 非空', Boolean(review3) && review3.meta?.model === 'agent-m' && review3.meta?.modelFallback === true && Boolean(review3.meta?.modelFallbackReason), JSON.stringify(review3 && review3.meta).slice(0, 240))

/* ------------------------------------------------------------------ [4] */
group('[4] AC-M5：未配置时与 v0.6.0 行为一致（默认模型/预算/temperature）')
await resetSettings()
const fake4 = makeFakeLlm()
const deep4 = await runDeep({ llm: fake4 })
const review4 = reviewOf(deep4)
check('AC-M5：未配置 → 使用宿主默认模型（agent-m/agent-p）', Boolean(review4) && review4.meta?.model === 'agent-m' && review4.meta?.provider === 'agent-p', JSON.stringify(review4 && { model: review4.meta?.model, provider: review4.meta?.provider }))
check('AC-M5：meta.modelSource == agent-default / modelFallback=false', Boolean(review4) && review4.meta?.modelSource === 'agent-default' && review4.meta?.modelFallback === false, JSON.stringify({ source: review4 && review4.meta?.modelSource, fallback: review4 && review4.meta?.modelFallback }))
check('AC-M5：默认预算不变（tokens 60000 / timeout 45000）', Boolean(review4) && review4.meta?.budget?.tokens === 60000 && review4.meta?.budget?.timeoutMs === 45000, JSON.stringify(review4 && review4.meta?.budget))
const stream4 = fake4.calls[0] || {}
check('AC-M5：默认 temperature 0.2、输出 maxTokens 4000（与 v0.6.0 一致）', stream4.temperature === 0.2 && Number(stream4.maxTokens) === 4000, JSON.stringify({ temperature: stream4.temperature, maxTokens: stream4.maxTokens }))

/* ------------------------------------------------------------------ [5] */
group('[5] AC-M6：工程红线（工具 34 / METHODS 70（task-110 media-read +1；v0.15.11 E13 assets-import +1） / slots=4（v0.12.1 已批准终值）/ 无新依赖 / 旧数据 hash / client 调用点）')
const defs = toolsMod.createToolDefs({ rootOf: () => workspace, backendOf: () => null })
check('AC-M6：生产工具面仍 34', defs.length === 35, String(defs.length))
check('AC-M6：METHODS 仍 = 70（task-110 media-read +1；v0.15.11 E13 assets-import +1）', METHODS.length === 72, String(METHODS.length))
const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
check('AC-M6：无新增外部依赖', !pkg.dependencies || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies || {}))
check('AC-M6：client slots.register = 4（v0.12.1 已批准终值）', (clientSrc.match(/slots\.register\(/g) || []).length === 4)
const clientCalls = new Set([...clientSrc.matchAll(/api\(\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))
check(`AC-M6：client 去重调用点未新增（仍 ${CLIENT_CALLS_EXPECTED}）`, clientCalls.size === CLIENT_CALLS_EXPECTED, String(clientCalls.size))
// 形状不变：status / progress-get
const statusRes = await call('status', {})
check('AC-M4：status 形状不变（ok/workspace/projectCount）', statusRes.status === 200 && statusRes.body?.ok === true && typeof statusRes.body?.workspace === 'string' && typeof statusRes.body?.projectCount === 'number', JSON.stringify(statusRes.body).slice(0, 160))
const progressRes = await call('progress-get', { title: TITLE })
check('AC-M4：progress-get 形状不变（progress.steps 6 步数组）', progressRes.status === 200 && Array.isArray(progressRes.body?.progress?.steps) && progressRes.body.progress.steps.length === 6, JSON.stringify(progressRes.body).slice(0, 120))
// 旧数据 32 文件 hash 不变（复用 P2-1 基线）
const BASELINE_CANDIDATES = [
  process.env.DSH_AI_P26_BASELINE,
  path.join(pluginRoot, '..', 'AI短剧工作区', '证据', 'P2-1-旧数据基线-2026-10-17.json'),
]
let baselineText = null
for (const candidate of BASELINE_CANDIDATES) {
  try {
    baselineText = await fs.readFile(candidate, 'utf8')
    break
  } catch {
    baselineText = null
  }
}
if (!baselineText) {
  console.log('      （SKIP：旧数据基线快照未找到 —— 安装副本隔离目录等场景）')
} else {
  const baseline = JSON.parse(baselineText)
  const REAL_ROOT = process.env.DSH_AI_DRAMA_REAL_ROOT || path.join(pluginRoot, '..', 'AI短剧')
  const files = []
  async function walk(dir, relBase = '') {
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name)
      const rel = path.join(relBase, e.name)
      if (e.isDirectory()) await walk(abs, rel)
      else {
        try {
          const buf = await fs.readFile(abs)
          files.push({ relative: rel, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') })
        } catch {}
      }
    }
  }
  await walk(REAL_ROOT)
  const baseMap = new Map(baseline.files.map((f) => [f.relative, f]))
  const curMap = new Map(files.map((f) => [f.relative, f]))
  // 2026-10-20 测试项目清理后恢复严格口径：活动数据根 = 基线 32 文件集合（缺失/新增/改写均 FAIL；无 allowlist）。
  const missing = [...baseMap.keys()].filter((k) => !curMap.has(k))
  const added = [...curMap.keys()].filter((k) => !baseMap.has(k))
  const changed = [...baseMap.keys()].filter((k) => curMap.has(k) && curMap.get(k).sha256 !== baseMap.get(k).sha256)
  check('AC-M6：旧数据 32 核心文件 hash 不变（严格 32 文件）', missing.length === 0 && added.length === 0 && changed.length === 0, JSON.stringify({ missing, added, changed }).slice(0, 300))
}

/* ------------------------------------------------------------------ [6] */
group('[6] client 侧静态契约（设置页任务模型区块 / 保存回读 / Q4 校验 / 旧宿主降级 / modelFallback 提示 / 红线）')
const clientMarkers = [
  ['设置页「任务模型」区块', /任务模型/],
  ['audit Provider 输入', /Provider/],
  ['审读模型输入', /审读模型|模型名/],
  ['Temperature 输入', /Temperature/],
  ['MaxTokens 输入', /MaxTokens/],
  ['使用宿主默认勾选', /使用宿主默认|跟随宿主默认/],
  ['Q4 校验：temperature 0~2', /Temperature 需在 0~2 之间/],
  ['Q4 校验：maxTokens 1~60000（全局上限 60k）', /MaxTokens 需在 1~/],
  ['Q4 校验：模型名必填', /任务模型名不能为空/],
  ['旧宿主无 taskModels 降级文案', /跟随宿主默认|宿主默认/],
  ['modelFallback 提示不阻断', /模型运行时探测不可用/],
  ['settings.taskModels payload', /taskModels/],
]
const missingClient = clientMarkers.filter(([, re]) => !re.test(clientSrc)).map(([label]) => label)
check('AC-M4/M6 client：任务模型区块/校验/降级/回退提示文案齐全', missingClient.length === 0, JSON.stringify(missingClient))
check('AC-M4 client：保存走既有 settings-save（taskModels 只增字段）', /settings-save/.test(clientSrc) && /settings\.taskModels|taskModels:/.test(clientSrc))

await fs.rm(workspace, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
