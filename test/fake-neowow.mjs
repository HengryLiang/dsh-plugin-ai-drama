#!/usr/bin/env node
/**
 * 测试用的假 neowow CLI：按 FAKE_MODE 返回预置输出，不联网、不需要凭据。
 * 用法：FAKE_MODE=logged-in node fake-neowow.mjs status
 */
const mode = process.env.FAKE_MODE || 'logged-out'
const argv = process.argv.slice(2)
const cmd = argv.join(' ')

function out(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
  process.exit(0)
}

function die(message, code, http) {
  process.stderr.write(`[neowow] ${message} | errCode=${code} | http=${http}\n`)
  process.exit(1)
}

if (cmd === 'status') {
  if (mode === 'broken') die('配置文件损坏', 'CONFIG_BROKEN', '0')
  out({
    build: 'v9.9.9+fake',
    base: 'https://example.invalid',
    loggedIn: mode === 'logged-in',
    keySource: mode === 'logged-in' ? 'config' : null,
    boundSessionId: mode === 'logged-in' ? 'sess-fake-1' : null,
    projectBindingPath: '/tmp/fake/.neowow/project.json',
  })
}

if (cmd === 'models image') {
  if (mode === 'broken') die('未登录', '2001', '200')
  out({
    kind: 'image',
    count: 3,
    models: [
      {
        model_name: 'combo-model',
        size_pricing_config: { low_1k: 7, medium_2k: 29, high_2k: 116 },
        points_cost_per_image: 999,
      },
      {
        model_name: 'size-only-model',
        size_pricing_config: { '1K': 35, '2K': 50 },
        points_cost_per_image: 999,
      },
      { model_name: 'flat-model', size_pricing_config: {}, points_cost_per_image: 42 },
    ],
  })
}

if (cmd === 'models video') {
  out({
    kind: 'video',
    count: 1,
    models: [{ value: 'fake-video', name: 'Fake Video', durationRange: { min: 4, max: 30, step: 1 } }],
  })
}

if (cmd.startsWith('gen ')) {
  if (mode !== 'logged-in') die('Token is missing', '2001', '200')
  out({ kind: 'image', status: 'SUCCESS', resultData: ['https://example.invalid/a.png'] })
}

die(`unknown command: ${cmd}`, 'USAGE', '0')
