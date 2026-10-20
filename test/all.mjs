/**
 * 一键跑全部测试：node test/all.mjs
 * 任一子套件失败即非零退出，便于接入 CI。
 *
 * 显式 skip：环境变量 SKIP_SUITES=文件名1,文件名2（如 SKIP_SUITES=backends.mjs）。
 * skip 的套件在总览里打印 SKIP + 理由，不计入失败；用途是「已知不可用且已登记」的套件。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const suites = [
  ['宿主半功能', 'smoke.mjs'],
  ['客户端席位契约', 'client.mjs'],
  ['Agent 工具白名单', 'agent-tools.mjs'],
  ['写入防护（FR-E02/FR-G12）', 'guard.mjs'],
  ['生成编排（阶段二）', 'orchestrator.mjs'],
  ['阶段二后端适配层', 'backends.mjs'],
  ['工具失败契约（T1-②）', 'contract.mjs'],
  ['工具治理（T3 / P1-L）', 'governance.mjs'],
  ['检索强化（P1-C / FR-C08）', 'retrieval.mjs'],
  ['编辑器往返（E1 / T6）', 'editor-roundtrip.mjs'],
  ['写事务（T2 / P1-K）', 'transactions.mjs'],
  ['上下文注入（T4 / P1-M）', 'context-card.mjs'],
  ['作者裁决（T5 / P1-N）', 'approval.mjs'],
  ['导出/定稿校验链（T1-10）', 'p1-t10-export-chain.mjs'],
  ['工具 schema 门禁（D-10）', 'schema-guard.mjs'],
  ['多数据源（P2-1 / AC-S）', 'multi-source.mjs'],
  ['流程状态机（P2-2 / AC-F）', 'flow-state.mjs'],
  ['AI 审读（P2-3 / AC-R）', 'audit.mjs'],
  ['任务级模型参数（P2-6 / AC-M）', 'task-models.mjs'],
  ['审读鲁棒性（D-12 / v0.6.2）', 'audit-robust.mjs'],
  ['客户端增强池（v0.6.3）', 'client-polish.mjs'],
  ['宿主级输出契约（D-13 / v0.6.5）', 'tool-output-contract.mjs'],
  ['审读质量基准 R-P2-11（v0.6.6 门禁）', 'rp211-gate.mjs'],
  ['v0.6.6 验收（P2-5 成本预估+三级闸门）', 'v066-acceptance.mjs'],
  ['v0.6.7 验收（重试/resume/漂移）', 'v067-acceptance.mjs'],
  ['v0.7.1 验收（P2-7 多集批量）', 'v071-acceptance.mjs'],
  ['P3-C 评测门禁（v0.9.1）', 'p3c-gate.mjs'],
  ['v0.9.2 验收（P3-E 成本档位路由）', 'p3e-acceptance.mjs'],
  ['v0.10.1 导入桥（B0-C）', 'import-bridge.mjs'],
  ['v0.10.2 判据机器化（B1-QA）', 'criteria-checks.mjs'],
  ['v0.10.3 videoPrompt 接线（B2-QA）', 'video-prompt.mjs'],
  ['v0.11.0 资产体系（B2-1Q）', 'assets.mjs'],
  ['v0.11.1 场景卡/风格 DNA（B2-2Q）', 'scenes.mjs'],
  ['v0.11.2 groups 读侧（E7）', 'groups-read.mjs'],
  ['v0.11.3 风格注入（2-2 二期）', 'style-injection.mjs'],
  ['v0.11.4 互通导入导出（2-5）', 'import-export.mjs'],
  ['v0.15.1 素材媒体（迭代1）', 'asset-media.mjs'],
  ['v0.15.2 台词音效重定位（迭代2）', 'dialogue-audio.mjs'],
  ['v0.15.3 视觉圣经专区（迭代3）', 'visual-bible.mjs'],
  ['v0.15.4 素材库2.0 旧登记统一视图', 'legacy-media.mjs'],
  ['Harness 兼容性（preset 变量/peer 范围）', 'preset-vars.mjs'],
]
/** 显式 skip 理由（登记在此处，验收证据引用同一份清单）。 */
const SKIP_REASONS = {
  'p1-t10-export-chain.mjs': 'P1 验收扩展项；T1-10 脚本自身可独立运行',
  'contract.mjs': 'T1-② 失败契约；task-9 交付后纳入',
}
const skip = new Set(
  String(process.env.SKIP_SUITES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, file)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.stderr.on('data', (d) => {
      out += d.toString()
    })
    child.on('close', (code) => resolve({ code, out }))
  })
}

let failed = 0
let skipped = 0
let passedSuites = 0
const summary = []
for (const [label, file] of suites) {
  if (skip.has(file)) {
    skipped += 1
    summary.push({ label, file, skipped: true, reason: SKIP_REASONS[file] || '环境变量 SKIP_SUITES 显式跳过' })
    continue
  }
  const { code, out } = await run(file)
  const line = (out.split(/\r?\n/).find((l) => l.startsWith('结果：')) || '（无结果行）').trim()
  const failures = out
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('FAIL') || l.trim().startsWith('- '))
    .map((l) => l.trim())
  summary.push({ label, file, code, line, failures })
  if (code === 0) passedSuites += 1
  else failed += 1
}

console.log('\n================ 测试总览 ================')
for (const item of summary) {
  if (item.skipped) {
    console.log(`SKIP  ${item.label.padEnd(16, '　')} ${item.reason}`)
    continue
  }
  const mark = item.code === 0 ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${item.label.padEnd(16, '　')} ${item.line}`)
  for (const f of item.failures.slice(0, 8)) console.log(`        ${f}`)
}
console.log('==========================================')
console.log(`套件：${passedSuites} 通过 / ${failed} 失败 / ${skipped} 跳过`)
console.log(failed === 0 ? '全部通过' : `${failed} 个套件失败`)

process.exit(failed === 0 ? 0 : 1)
