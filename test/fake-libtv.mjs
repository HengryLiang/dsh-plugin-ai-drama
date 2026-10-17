#!/usr/bin/env node
/**
 * 测试用的假 libtv CLI：按 FAKE_MODE 返回预置输出，不联网、不依赖真实账号。
 * 用法：FAKE_MODE=logged-in node fake-libtv.mjs account info
 */
const mode = process.env.FAKE_MODE || 'logged-in'
const argv = process.argv.slice(2)
const cmd = argv.join(' ')

function out(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
  process.exit(0)
}

function die(message) {
  process.stderr.write(`Error: ${message}\n`)
  process.exit(1)
}

if (cmd === '--version' || cmd === '-V') {
  process.stdout.write('9.9.9\n')
  process.exit(0)
}

if (cmd === 'account info') {
  if (mode === 'not-logged-in') die('未登录，请先执行 libtv login')
  if (mode === 'broken') die('凭据文件损坏 EPERM')
  out({
    user: { uuid: 'u-fake', id: 1, nickname: '测试账号' },
    activeAccount: {
      accountId: 2,
      accountName: '测试账号',
      memberAccount: mode === 'vip' ? { memberName: '豪华版VIP 连续包年', effective: true } : null,
    },
  })
}

if (cmd === 'model search -t image') {
  out({
    nodeType: 'image',
    query: null,
    matchKind: 'type-only',
    matches: [
      { modelKey: 'lib-image-2.5-s', modelName: 'Lib Image 2.5 Pro', description: '精准生成', estimatedTime: '30s', supportModality: 'image' },
      { modelKey: 'vip-image', modelName: 'VIP Image', vip: true, estimatedTime: '45s' },
    ],
  })
}

if (cmd === 'model search -t video') {
  out({
    nodeType: 'video',
    matchKind: 'type-only',
    matches: [
      { modelKey: 'star-video2.5', modelName: 'Seedance 2.5', vip: true, studio: true, estimatedTime: '2min', pricingRule: '按秒计价，此模型上传的参考视频时长计入总时长' },
      { modelKey: 'plain-video', modelName: 'Plain Video', estimatedTime: '1min' },
    ],
  })
}

if (cmd.startsWith('node create')) {
  if (mode === 'generate-fails') die('模型不可用')
  out({ ok: true, nodeKey: 'node-fake-1', name: argv[2] })
}

if (cmd.startsWith('download')) {
  if (mode === 'download-fails') die('节点无产物')
  process.stdout.write('已下载 1 个文件\n')
  process.exit(0)
}

die(`unknown command: ${cmd}`)
