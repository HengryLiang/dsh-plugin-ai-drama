/**
 * P1-A（T1-②）· 工具失败契约自测：统一失败码 + execute 包装 + output.schema 对齐。
 * 来源：host-dev task-9 的离线断言脚本（QA 收编为 test/ 发布门禁，路径改为相对 import）。
 *
 * 契约（lib/tools.js）：
 *   - `TOOL_FAILURE_CODES` ≥ 8 类，每类含 label + next（下一步建议）
 *   - 34 个工具 execute 统一包装 withToolContract：失败返回 `{ ok:false, code, reason, next }`，**不再 throw**
 *   - 成功结构保持不变（仅保证 ok:true）
 *   - output.schema 含 code/reason/next；失败也能渲染成中文失败摘要
 *
 * 运行：node test/contract.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(path.join(here, '..', 'lib', 'tools.js')).href)
const {
  createToolDefs,
  TOOL_FAILURE_CODES,
  ToolFailure,
  toolFailure,
  classifyToolFailure,
  normalizeToolResult,
  withToolContract,
} = mod

let passed = 0
let failed = 0
const failures = []
const check = (label, condition, detail) => {
  if (condition) passed += 1
  else {
    failed += 1
    failures.push(`${label}${detail ? ' -> ' + detail : ''}`)
    console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`)
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-contract-'))
const defs = createToolDefs({ rootOf: () => root, backendOf: () => null })
const tool = (name) => defs.find((def) => def.name === name)
const run = async (name, args) => tool(name).execute(args || {}, {})

console.log('\n[1] 失败码表（≥8 类，每类 label + next）')
check(`失败码 ${Object.keys(TOOL_FAILURE_CODES).length} 类 ≥ 8`, Object.keys(TOOL_FAILURE_CODES).length >= 8, String(Object.keys(TOOL_FAILURE_CODES).length))
check('每类都有 label 与 next', Object.values(TOOL_FAILURE_CODES).every((item) => typeof item.label === 'string' && item.label && typeof item.next === 'string' && item.next.length > 8))
for (const code of ['not-found', 'invalid-args', 'conflict', 'permission', 'budget-exceeded', 'upstream-unavailable', 'io-error', 'timeout', 'unsupported', 'unknown']) {
  check(`失败码包含 ${code}`, Boolean(TOOL_FAILURE_CODES[code]))
}

console.log('\n[2] 真实工具失败场景（execute 出口归一，不 throw）')
let r = await run('drama_create_project', { title: '   ' })
check('invalid-args ← 空剧名', r.ok === false && r.code === 'invalid-args' && typeof r.next === 'string', JSON.stringify({ code: r.code, reason: r.reason }))

r = await run('drama_create_project', { title: '契约测试剧' })
check('成功结果保持原结构（ok:true、无 code）', r.ok === true && !('code' in r) && r.project && r.project.title === '契约测试剧', JSON.stringify(r).slice(0, 120))

r = await run('drama_create_project', { title: '契约测试剧' })
check('conflict ← 项目已存在', r.ok === false && r.code === 'conflict', JSON.stringify({ code: r.code, reason: r.reason }))

r = await run('drama_resolve_draft', { title: '契约测试剧', id: 'd-abc123-deadbeef', action: 'accept' })
check('not-found ← 草稿不存在', r.ok === false && r.code === 'not-found', JSON.stringify({ code: r.code, reason: r.reason }))

r = await run('drama_finalize_episode', { title: '契约测试剧', order: 1 })
check('not-found ← 无内容可定稿', r.ok === false && r.code === 'not-found', JSON.stringify({ code: r.code, reason: r.reason }))

r = await run('drama_save_outline', { title: '契约测试剧', rows: 'oops' })
check('invalid-args ← 总纲不是数组', r.ok === false && r.code === 'invalid-args', JSON.stringify({ code: r.code, reason: r.reason }))

r = await run('drama_add_asset', { title: '契约测试剧', source: path.join(root, 'no-such-asset-xyz.png') })
check('not-found ← 素材文件不存在', r.ok === false && r.code === 'not-found', JSON.stringify({ code: r.code, reason: r.reason }))

r = await run('drama_budget', { title: '契约测试剧', action: 'set', limitPoints: 0 })
check('预算上限设置成功', r.ok === true && r.budget && r.budget.limitPoints === 0, JSON.stringify(r).slice(0, 120))
r = await run('drama_plan_generation', { title: '契约测试剧', backend: 'libtv', kind: 'image', episode: 1, estimatePoints: 10 })
check('budget-exceeded ← 预算闸门拦截', r.ok === false && r.code === 'budget-exceeded' && r.allowed === false && typeof r.next === 'string', JSON.stringify({ code: r.code, allowed: r.allowed }))

r = await run('drama_canvas_status', { title: '契约测试剧', backend: 'libtv' })
check('upstream-unavailable ← 后端不可用', r.ok === false && r.code === 'upstream-unavailable', JSON.stringify({ code: r.code, reason: r.reason }))

const assetFile = path.join(root, 'asset.png')
await fs.writeFile(assetFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
r = await run('drama_add_asset', { title: '契约测试剧', source: assetFile })
check('素材首次登记成功', r.ok === true, JSON.stringify(r).slice(0, 100))
r = await run('drama_add_asset', { title: '契约测试剧', source: assetFile })
check('conflict ← 素材重复登记', r.ok === false && r.code === 'conflict', JSON.stringify({ code: r.code, reason: r.reason }))

r = await run('drama_list_projects', {})
check('成功路径：list_projects 结构不变', r.ok === true && Array.isArray(r.projects) && !('code' in r), JSON.stringify(r).slice(0, 120))

console.log('\n[3] 分类器场景（每类至少 1 个）')
const classify = (error) => classifyToolFailure(error)
check('permission ← 路径越界', classify(new Error('目标路径越界，不允许写入项目目录之外'))?.code === 'permission')
check('io-error ← EPERM', classify(Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }))?.code === 'io-error')
check('timeout ← 超时', classify(new Error('外部画布请求超时 timed out'))?.code === 'timeout')
check('unsupported ← 不支持类型', classify(new Error('不支持的文件类型：svg'))?.code === 'unsupported')
check('unknown ← 未归类', classify(new Error('某种未知的内部错误'))?.code === 'unknown')
check('ToolFailure 显式码', classify(new ToolFailure('permission', '二级节点改名 P1 不开放'))?.code === 'permission')
check('toolFailure() 结构', (() => { const f = toolFailure('conflict', '重复'); return f.ok === false && f.code === 'conflict' && f.next.length > 0 })())
const wrapped = withToolContract('demo', async () => { throw new ToolFailure('permission', '仅允许一级节点') })
const wrappedResult = await wrapped({}, {})
check('withToolContract 捕获 ToolFailure', wrappedResult.ok === false && wrappedResult.code === 'permission' && wrappedResult.next.length > 0, JSON.stringify(wrappedResult))
check('normalizeToolResult(ok:false) 归一', (() => { const n = normalizeToolResult({ ok: false, allowed: false, reason: 'over-budget', detail: '本次预计消耗 10 积分，已消耗 0，预算上限 0' }); return n.ok === false && n.code === 'budget-exceeded' && n.allowed === false && typeof n.next === 'string' })())

console.log('\n[4] output.schema 与失败结构对齐（34/34）')
const missingFailureFields = defs.filter((def) => {
  const props = def.output && def.output.schema && def.output.schema.properties
  return !(props && props.ok && props.code && props.reason && props.next)
})
check('34/34 output.schema 含 code/reason/next', missingFailureFields.length === 0, missingFailureFields.map((def) => def.name).join(','))
check('失败结果也能渲染成中文失败摘要', (() => {
  const blocks = tool('drama_save_contract').output.render({}, { ok: false, code: 'invalid-args', reason: '单集时长需要两个正整数', next: '修正参数后重试。' })
  return Array.isArray(blocks) && blocks.length && blocks[0].type === 'text' && blocks[0].text.includes('[invalid-args]') && blocks[0].text.includes('下一步')
})())

console.log('\n[5] 全量 execute 契约化（34/34 不抛异常、结构可判定）')
const executed = []
for (const def of defs) {
  let result = null
  let threw = null
  try {
    result = await def.execute({}, {})
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  const okShape = threw === null && result && typeof result === 'object' && typeof result.ok === 'boolean'
  const failShape = !okShape ? false : result.ok === true ? !('code' in result) : typeof result.code === 'string' && Boolean(TOOL_FAILURE_CODES[result.code]) && typeof result.next === 'string'
  if (!okShape || !failShape) executed.push(`${def.name}: ${threw ? 'throw ' + threw : JSON.stringify(result).slice(0, 80)}`)
}
check('34/34 空参数 execute 不抛异常且满足失败契约', executed.length === 0, executed.join(' | '))
check('空参数下成功/失败均可判定', defs.length === 34, String(defs.length))

await fs.rm(root, { recursive: true, force: true })
console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
