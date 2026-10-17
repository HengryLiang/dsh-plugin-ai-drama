# 参与贡献

欢迎 issue 与 PR。改动前请先跑测试：

```sh
npm test
```

## 约定

- 这是 DeepSeek Harness（DSH）插件：宿主半入口是 `index.js`，客户端半是 `client.js`（`window.__ModuleLoader__` 格式），
  Agent 预设伴生入口是 `preset.js`；`package.json` 的 `dsh` 字段声明 bundle 与 client。
- 不要手写用户 profile 里的 `package.json` / `cordis.patch.yml`——安装统一走 `dsh plugin add`。
- 数据写入必须走 `lib/store.js` 的原子写入与快照机制，不要直接 `fs.writeFile` 覆盖正式稿。
- 结构化数据以 `.aidrama/*.json` 为唯一事实源，`.md` 一律由它渲染。
- 测试是纯 Node 脚本（假 CLI / 假 React），新增能力请补对应套件，并保证 `npm test` 全绿。
- 不要提交任何凭据、`.aidrama/` 运行数据、`AI短剧/` 用户数据或 `*.tgz` 产物。

## 提交信息

用一句话说明改动与动机即可；涉及 DSH 契约变更时，请在 PR 描述里附上 `dsh --dump-config` 的相关层与验证方式。
