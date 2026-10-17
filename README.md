# AI 短剧工作区 · `dsh-plugin-ai-drama`

[![test](https://github.com/HengryLiang/dsh-plugin-ai-drama/actions/workflows/ci.yml/badge.svg)](https://github.com/HengryLiang/dsh-plugin-ai-drama/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-6f42c1)](https://github.com/topics/dsh-plugin)

> DeepSeek Harness（DSH）插件：把 AI 短剧的 **立项 → 总纲 → 人物 → 世界观 → 剧本 → 分镜 → 导出** 收进侧栏工作区，
> 并附带「短剧模式」Agent 预设——**34 个 `drama_*` 工具**、**9 个随包技能**、`/drama` 斜杠命令，
> 以及与 LibTV / NeoWoW 画布 CLI 对接的生成编排适配层。

> English: An AI short-drama workspace plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
> It ships a sidebar + main-panel workspace for the full short-drama pipeline, a dedicated `drama` agent preset
> with 34 agent tools and 9 bundled skills, a `/drama` slash command, and an adapter layer that drives external
> canvas CLIs (LibTV / NeoWoW) for image / video / voice generation. UI and docs are in Chinese.

---

## 它解决什么问题

写一部短剧，真正麻烦的不是「让模型写一段」，而是**让几十集内容彼此一致、可查、可交付**：
人物设定散在聊天记录里、伏笔写完就忘、分镜表和剧本对不上、改一集要翻十处、导出还要手工拼。

这个插件把短剧创作当成一个有状态的项目来做：

- **单一事实源**：结构化数据落在 `.aidrama/*.json`，`.md` 由它渲染，避免「两边同时改」的双写冲突；
- **落盘可恢复**：所有写入走「临时文件 → rename」原子替换，覆盖前留 `history/` 快照；
- **确定性检查**：一致性检查（人物/时间线/场景/道具等 7 类规则）不依赖模型，随时可跑；
- **生成物先入草稿区**：AI 产出先进草稿，用户采纳后才进正式稿；
- **生成编排不内建生成能力**：出图/出视频/出配音交给外部画布 CLI，插件只做适配、编排、回流与预算护栏。

## 能力一览

| 模块 | 能力 |
|---|---|
| 工作区 | 侧栏「AI 短剧」入口 + 中央面板（14 个页签），不遮蔽内置工作区浏览器，可与其它工作区插件共存 |
| 项目 | 新建 / 打开 / 重命名 / 删除；固定中文目录结构；全文检索；目录树子节点展开折叠并持久化 |
| 内容 | 剧集契约、分集总纲、人物设定卡、世界观、分集剧本、分镜表、本剧记忆（伏笔/已用桥段/时间线/待回收） |
| AI 能力 | 34 个 `drama_*` Agent 工具（仅在「短剧模式」会话注册）；检索增强；一致性检查；草稿区与采纳/丢弃 |
| 预设 | 「短剧模式」Agent 预设：短剧编剧/制片/分镜导演/合规顾问人格，**移除 shell 类工具**（工具白名单） |
| 技能 | 9 个随包技能：立项、总纲、人物、剧本、分镜、导演/镜头语言、润色、审读、导出 |
| 命令 | `/drama`（项目 / 进度 / 检查 / 草稿 / 导出 / 定稿 / 大纲 / 人物 / 世界观 / 剧本 / 分镜 / 润色） |
| 交付 | 导出 Markdown 全本 / JSON 结构化包 / CSV 拍摄用分镜表（UTF-8 with BOM）；定稿快照与回滚 |
| 生成（可选） | LibTV（主选）/ NeoWoW（备选）CLI 适配：规划 → 提交 → 收敛三段式；预算台账与闸门；产物回流登记 sha256 |

## 安装

要求：

- **DeepSeek Harness ≥ `0.2.0-rc.2`**（`engines.dsh` 会校验；桌面端与 npm 版 `dsh` 均可）
- **Node.js `^22.19.0 || ^24.0.0`**
- Web 界面（插件含客户端半，需要 `dsh web` / 桌面端的 Web 面）

插件是**纯 JavaScript、无构建步骤**（不需要 `prepare` / `allowBuilds`），三种安装方式任选。

### 方式一：直接从 GitHub 安装（推荐）

```sh
dsh plugin --profile <profile> add github:HengryLiang/dsh-plugin-ai-drama#v0.6.3
```

`<profile>` 换成你的 profile 名（`dsh web` 对应 `web`，桌面端通常是 `desktop`）。首次使用 `dsh plugin` 会自动创建 profile。

### 方式二：从 GitHub Release 的预打包 tarball 安装

```sh
curl -L -o dsh-plugin-ai-drama.tgz \
  https://github.com/HengryLiang/dsh-plugin-ai-drama/releases/latest/download/dsh-plugin-ai-drama.tgz
dsh plugin --profile <profile> add ./dsh-plugin-ai-drama.tgz
```

### 方式三：本地开发目录

```sh
git clone https://github.com/HengryLiang/dsh-plugin-ai-drama.git
dsh plugin --profile <profile> add ./dsh-plugin-ai-drama
```

### 验证安装

```sh
dsh --profile <profile> --dump-config    # 应出现 "# == dsh-plugin-ai-drama" 层
```

重启 DSH（或桌面端）后，侧栏出现 **「AI 短剧」** 图标；新建会话时预设选择器里出现 **「短剧模式」**。

> 卸载：`dsh plugin --profile <profile> remove dsh-plugin-ai-drama`。卸载**不会删除**你工作区里的 `AI短剧/` 数据。

## 快速开始

1. 重启后新建一个会话，在预设选择器里选 **「短剧模式」**；
2. 点侧栏「AI 短剧」→ 新建项目，输入剧名（会生成固定目录结构）；
3. 用对话驱动，或直接敲斜杠命令：

```text
/drama 大纲 都市悬疑，12 集，每集 90 秒，强钩子
/drama 人物 补全主角与反派，给出形象提示词
/drama 进度                  # 看当前阶段与关键事实
/drama 检查                  # 跑一致性检查，直接返回问题清单
/drama 草稿                  # 查看待处理的 AI 草稿
/drama 导出 csv              # 导出拍摄用分镜表
/drama 定稿 3                # 冻结第 3 集剧本与分镜为快照，可回滚
```

4. 在面板里可以逐页编辑：总纲 / 人物 / 世界观 / 剧本 / 分镜 / 记忆 / 草稿 / 定稿 / 账本 / 导出等。

## 「短剧模式」预设

预设以 Cordis YAML 声明（`presets/drama.patch.yml`），基于 DSH 随包标准预设改写：

- persona 换成短剧编剧 / 制片 / 分镜导演 / 合规顾问；
- **去掉 shell 命令类工具**（工具白名单）；
- 收敛子代理编排组，工具面聚焦创作；
- 追加隔离服务插件 `dsh-plugin-ai-drama/preset`：在该预设作用域内标记 `dramaMode`，
  主插件据此**只对处于短剧模式的 Agent** 注册 `drama_*` 工具，预设计未启用时工具不出现，切走自动回收。

预设同时通过 `@deepseek-ai/dsh-skill-filesystem` 的 `bundledSkillDir` 随包挂载 `skills/`，
所以「短剧模式」会话里 9 个技能自动可用。

## `drama_*` 工具（34 个）

| 分组 | 工具 |
|---|---|
| 项目 | `drama_list_projects` / `drama_create_project` / `drama_get_project` |
| 写入 | `drama_save_contract` / `drama_save_outline` / `drama_save_characters` / `drama_save_world` / `drama_read_episode` |
| 检索与上下文 | `drama_search_context` / `drama_get_progress` / `drama_save_memory` |
| 台词与素材 | `drama_get_dialogue` / `drama_export_voice_script` / `drama_list_assets` / `drama_add_asset` |
| 定稿与账本 | `drama_finalize_episode` / `drama_list_finalized` / `drama_get_ledger` |
| 导入与草稿 | `drama_import_script` / `drama_save_draft` / `drama_list_drafts` / `drama_resolve_draft` |
| 质检与导出 | `drama_check_consistency` / `drama_export` |
| 生成编排（阶段二） | 规划 / 提交 / 收敛 / 预算 / 绑定相关工具（`lib/tools.js`） |

工具全部是**确定性实现**（读写文件、结构化校验、检索、渲染），生成类操作交给 Agent 调用模型，
插件只负责把结果安全落盘。

## 随包技能（9 个）

`drama-setup`（立项）、`drama-outline`（总纲）、`drama-characters`（人物）、`drama-episode`（剧本）、
`drama-storyboard`（分镜）、`drama-director`（导演 / 镜头语言）、`drama-polish`（润色）、
`drama-review`（审读）、`drama-export`（导出）。

## 斜杠命令 `/drama`

| 输入 | 行为 |
|---|---|
| `/drama` | 用法 + 当前工作区项目与进度 |
| `/drama 项目` | 列出短剧项目 |
| `/drama 进度 [剧名]` | 阶段与关键事实 |
| `/drama 检查 [剧名]` | 一致性检查，直接返回问题清单 |
| `/drama 草稿 [剧名]` | 待处理草稿 |
| `/drama 导出 <markdown\|json\|csv> [剧名]` | 导出交付物 |
| `/drama 定稿 <集数> [剧名]` | 定稿某一集 |
| `/drama 大纲\|人物\|世界观\|剧本\|分镜\|润色 [要求]` | 交给 Agent 生成（会产生一次模型回复） |

两条纪律：**只在「短剧模式」会话生效**（其它会话返回明确错误）；**确定性操作不产生模型轮次**。

## 数据落盘

在会话工作区下：

```text
<工作区>/AI短剧/
  <短剧名>/
    剧集契约.md                 ← 由 .aidrama/contract.json 渲染
    总纲/分集大纲.md            ← 由 .aidrama/outline.json 渲染
    人物/人物设定卡.md          ← 由 .aidrama/characters.json 渲染
    分集剧本/第001集.md         ← 剧本正文（可直接编辑）
    分镜/第001集.分镜.md        ← 由 .aidrama/storyboard/ 渲染
    构想/ 世界观/ 台词与音效/ 素材/ 草稿区/ 定稿/ 账本/ 本剧记忆/ 导出/
    .aidrama/                   ← 机读源数据 + history/ 历史快照
  共享资料/                     ← 跨项目共享资料
```

结构化数据以 `.aidrama/*.json` 为唯一事实源；可见的 `.md` 由它渲染，**不存在双写**。
所有写入原子替换，覆盖前留 `history/` 快照（保留最近 20 份）。

## 生成能力对接（可选）

插件**不内建**图片 / 视频 / 配音生成，而是适配外部画布 CLI：

| | LibTV（主选） | NeoWoW（备选） |
|---|---|---|
| 形态 | 本地 CLI `libtv` 子进程 | 本地 CLI `neowow` 子进程 |
| 登录 | CLI 内完成 | API Key |
| 能力 | 画布 / 节点 / 上传 / 生成 / 下载 | 画布 / 节点 / 生成 / 轮询 |

统一接口 `available(ctx)` / `catalog(kind)` / `estimate(input)`，业务代码不认具体平台；
主选不可用时自动降级到备选。

生成编排拆成三段（避免长任务把一次请求挂住）：

1. **规划** `planEpisode()`：由分镜确定性构造逐镜提示词，不产生副作用；
2. **提交** `submitBatch()`：可部分失败，单镜失败不影响其余；
3. **收敛** `collectBatch()`：可反复调用，直到产物全部回流到 `素材/生成/` 并登记 sha256、来源、任务 id。

护栏：

- **预算台账** `.aidrama/budget.json` + 闸门，同一任务只计费一次；
- **上游冲突保护**：绑定检查 + 写入前指纹 + 写入后漂移判定；
- **双主防护**：以项目分镜为唯一事实源，按镜号对账画布节点，只报告差异、不自动改画布；
- **不假装**：账号状态来自 CLI 实测，产物状态必须见到真实文件。

## 架构

```text
dsh-plugin-ai-drama/
  package.json            # dsh.manifestVersion / dsh.bundle.patch[2] / dsh.client
  cordis.patch.yml        # 把主插件插入组合树
  index.js                # 宿主半：68 个 POST /api/ai-drama/<method> 路由 + 工具白名单挂载 + /drama
  preset.js               # 预设伴生入口：provide('dramaMode') + 挂载随包技能
  presets/drama.patch.yml # 「短剧模式」Agent 预设声明
  lib/store.js            # 项目仓储：原子写入、快照、结构化文档、检索、条目管理
  lib/drafts.js           # 草稿区：生成物先入库，采纳后进正式稿
  lib/consistency.js      # 一致性检查（确定性规则）
  lib/retrieval.js        # 本地词法检索（中文单字 + 二元组 + BM25 风格打分）
  lib/tools.js            # drama_* Agent 工具
  lib/backends/           # LibTV / NeoWoW CLI 适配层
  lib/generation.js       # 任务台账 / 预算台账与闸门 / 产物回流
  lib/guard.js            # 上游冲突保护与双主防护
  lib/orchestrator.js     # 生成编排：规划 → 提交 → 收敛
  lib/exporter.js         # 导出 Markdown / JSON / CSV
  skills/drama-*/SKILL.md # 9 个随包技能
  client.js               # 客户端半：侧栏入口 + 14 页签面板
  test/                   # 21 个测试套件，纯 Node 运行，无外部依赖
```

宿主半提供 `POST /api/ai-drama/<method>` 精确路由（请求头 `x-ai-drama-request: 1`），
客户端半只用浏览器模块表提供的 React，不引入额外运行时依赖。

## 开发与测试

```sh
node --check index.js && node --check client.js && node --check preset.js
npm test          # 21 个套件
```

测试全部是纯 Node 脚本，使用假 CLI / 假 React，**不需要 API Key、不消耗任何生成积分**。
其中「旧数据不变性」类断言在没有本地样例数据时会自动 SKIP，不影响公共 CI。

CI：GitHub Actions 上跑 Node 22 / 24 × Windows / Ubuntu 组合（见 `.github/workflows/ci.yml`）。

## 兼容性

- DSH `0.2.0-rc.2` 及以上（`0.2.x` 线）；
- Node.js `^22.19.0 || ^24.0.0`；
- 宿主半跨平台；主要开发/验证环境为 Windows 11 + Node 24（macOS / Linux 欢迎反馈）。

## 已知边界（刻意保留的「不」）

- **不按任务覆盖模型参数**：DSH 工具契约没有按调用覆盖模型参数的入口，本插件不提供看似生效、实则无效的配置项；
- **不内建生成能力**：不做模型接入与推理资源管理；
- **不猜测价格**：外部平台只给文字计价规则时如实返回原文；
- **不自动改外部画布**：对账只报告差异，写画布由用户确认。

## 许可

[MIT](LICENSE) © 2026 `HengryLiang`
