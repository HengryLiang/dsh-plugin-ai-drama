# AI 短剧工作区 · `dsh-plugin-ai-drama`

[![test](https://github.com/HengryLiang/dsh-plugin-ai-drama/actions/workflows/ci.yml/badge.svg)](https://github.com/HengryLiang/dsh-plugin-ai-drama/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-6f42c1)](https://github.com/topics/dsh-plugin)

> DeepSeek Harness（DSH）插件：把 AI 短剧的 **立项 → 总纲 → 人物 → 世界观 → 剧本 → 分镜 → 生成 → 导出** 收进侧栏工作区，
> 并附带「短剧模式」Agent 预设——**34 个 `drama_*` 工具**、**10 个随包技能**、**69 个宿主路由**、**14 页签面板**，
> 以及与 LibTV / NeoWoW 画布 CLI 对接的生成编排适配层。

> English: An AI short-drama workspace plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
> Sidebar + main-panel workspace covering the full short-drama pipeline, a dedicated `drama` agent preset with
> 34 agent tools, 10 bundled skills, a `/drama` slash command, criteria/quality gates, an asset & style system,
> a safe local media read channel, shot-prompt import / VCS export bridge, and adapters that drive external
> canvas CLIs (LibTV / NeoWoW). UI and docs are in Chinese.

---

## 它解决什么问题

写一部短剧，真正麻烦的不是「让模型写一段」，而是**让几十集内容彼此一致、可查、可交付**：
人物设定散在聊天记录里、伏笔写完就忘、分镜表和剧本对不上、改一集要翻十处、导出还要手工拼；
接上生成之后，又要管成本、管资产编号、管批量任务与失败重试。

这个插件把短剧创作当成一个有状态的项目来做：

- **单一事实源**：结构化数据落在 `.aidrama/*.json`，`.md` 由它渲染，避免「两边同时改」的双写冲突；
- **落盘可恢复**：所有写入走「临时文件 → rename」原子替换，覆盖前留 `history/` 快照；
- **确定性判据**：一致性检查与创作质量判据（可观测性 / 景别接续 / 体态承接 / 光影 / 现场声等）不依赖模型，随时可跑；
- **生成物先入草稿区**：AI 产出先进草稿，用户采纳后才进正式稿；
- **生成编排不内建生成能力**：出图 / 出视频 / 出配音交给外部画布 CLI，插件只做适配、编排、回流、预算与门禁。

## 能力一览

| 模块 | 能力 |
|---|---|
| 工作区 | 侧栏「AI 短剧」入口 + 中央面板（**14 页签 / 4 组**：创作、资料、交付、高级），不遮蔽内置工作区浏览器，可与其它工作区插件共存 |
| 项目 | 新建 / 打开 / 重命名 / 删除；固定中文目录结构；全文检索；目录树子节点展开折叠并持久化 |
| 内容 | 剧集契约、分集总纲、人物设定卡、世界观、分集剧本、分镜表、本剧记忆（伏笔/已用桥段/时间线/待回收） |
| 分镜增强 | 情绪与强度、光影、现场声、禁令、起止体态、衔接、自然语言段、焦段、主体、分组；**情绪总控分组 sidecar**（不改分镜数组形状） |
| 台词与音效 | 台词视图并入「剧本」、配音稿迁至「交付 / 导出」；角色卡音频（`media.audio`）与 `<audio>` 试听；旧 `dialogue` 深链自动重定向 |
| 素材与媒体 | **本地安全只读媒体通道**（`media-read`：项目内相对路径、realpath 校验、图片/音频 MIME 白名单、≤8MB）；资产卡图片 / 音频 / 缩略图（add-only）；**素材库 2.0** 统一卡片视图与自动刷新；**视觉圣经专区**（素材 / 场景 / 风格 / 角色 / 参考图墙） |
| AI 能力 | 34 个 `drama_*` Agent 工具（仅在「短剧模式」会话注册）；检索增强；一致性检查；草稿区与采纳/丢弃 |
| 质量体系 | 创作判据（写作侧 + 结构侧，默认 WARN 不阻断）、判据规则单一源 `presets/rules/*.json`、评测门禁、资产质量门禁 |
| 资产与风格 | 9 类资产编号（CHR/SPC/PRP/SHT/CST/EXP/SFX/VOX/MUS）、资产卡与 `{{Asset_*}}` 占位符、场景卡、五维风格 DNA、风格注入 |
| 成本与路由 | 成本预估 + 三级闸门；按任务选择 `fast / standard / strong` 成本档位；预算台账，同一任务只计费一次 |
| 批量生成 | 多集批量：规划 → 提交（可部分失败）→ 收敛；幂等提交、断点 resume、漂移检测 |
| 导入导出 | 剧本导入（预览 → 落盘）；**分镜提示词 MD 导入桥（`format=shot-prompt`）**；导出 Markdown / JSON / CSV / **VCS 视图**；导入导出互通 |
| 预设 | 「短剧模式」Agent 预设：短剧编剧/制片/分镜导演/合规顾问人格，**移除 shell 类工具**（工具白名单） |
| 技能 | 10 个随包技能：立项、总纲、人物、剧本、分镜、导演/镜头语言、润色、审读、导出、**分镜提示词兜底** |
| 命令 | `/drama`（项目 / 进度 / 检查 / 草稿 / 导出 / 定稿 / 大纲 / 人物 / 世界观 / 剧本 / 分镜 / 润色） |
| 交付 | 导出 Markdown 全本 / JSON 结构化包 / CSV 拍摄用分镜表（UTF-8 with BOM）/ VCS 视图；定稿快照与回滚 |

## 安装

要求：

- **DeepSeek Harness ≥ `0.2.0-rc.2`**（`0.2.x` 线；已验证 0.2.0-rc.2 与 0.2.1-rc.2，见「Harness 兼容性」）
- **Node.js `^22.19.0 || ^24.0.0`**
- Web 界面（插件含客户端半，需要 `dsh web` / 桌面端的 Web 面）

插件是**纯 JavaScript、无构建步骤**（不需要 `prepare` / `allowBuilds`），三种安装方式任选。

### 方式一：直接从 GitHub 安装（推荐）

```sh
dsh plugin --profile <profile> add github:HengryLiang/dsh-plugin-ai-drama#v0.15.7
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

4. 面板 14 个页签：创作（契约 / 总纲 / 人物 / 世界观 / 剧本 / 分镜）、资料（素材 / 记忆 / 草稿 / 账本）、
   交付（生成 / 检查）、高级（目录树 / 工具卡）。

## 「短剧模式」预设

预设以 Cordis YAML 声明（`presets/drama.patch.yml`），基于 DSH 随包标准预设改写：

- persona 换成短剧编剧 / 制片 / 分镜导演 / 合规顾问；
- **去掉 shell 命令类工具**（工具白名单）；
- 收敛子代理编排组，工具面聚焦创作；
- 追加隔离服务插件 `dsh-plugin-ai-drama/preset`：在该预设作用域内标记 `dramaMode`，
  主插件据此**只对处于短剧模式的 Agent** 注册 `drama_*` 工具，预设未启用时工具不出现，切走自动回收。

预设同时通过 `@deepseek-ai/dsh-skill-filesystem` 的 `bundledSkillDir` 随包挂载 `skills/`，
所以「短剧模式」会话里 10 个技能自动可用。

## `drama_*` 工具（34 个）

| 分组 | 工具 |
|---|---|
| 项目 | `drama_list_projects` / `drama_create_project` / `drama_get_project` |
| 文档写入 | `drama_save_contract` / `drama_save_outline` / `drama_save_characters` / `drama_save_world` / `drama_save_memory` / `drama_read_episode` |
| 进度与检索 | `drama_get_progress` / `drama_search_context` / `drama_get_ledger` |
| 台词与素材 | `drama_get_dialogue` / `drama_export_voice_script` / `drama_list_assets` / `drama_add_asset` |
| 草稿与定稿 | `drama_save_draft` / `drama_list_drafts` / `drama_resolve_draft` / `drama_finalize_episode` / `drama_list_finalized` |
| 导入 / 导出 / 质检 | `drama_import_script`（剧本、`format=shot-prompt` 分镜提示词）/ `drama_check_consistency` / `drama_export`（markdown / json / csv / vcs） |
| 生成编排 | `drama_budget` / `drama_bind_canvas` / `drama_canvas_status` / `drama_reconcile_canvas` / `drama_plan_generation` / `drama_record_generation` / `drama_intake_artifact` / `drama_plan_batch` / `drama_submit_batch` / `drama_collect_batch` |

工具全部是**确定性实现**（读写文件、结构化校验、检索、渲染、编排），生成类操作交给 Agent 调模型，
插件只负责把结果安全落盘。测试用工具（`drama_test_*`）只在 `DSH_AI_DRAMA_TEST_TOOLS=1` 时注册，生产工具面保持 34 个。

## 随包技能（10 个）

`drama-setup`（立项）、`drama-outline`（总纲）、`drama-characters`（人物）、`drama-episode`（剧本）、
`drama-storyboard`（分镜）、`drama-director`（导演 / 镜头语言）、`drama-polish`（润色）、
`drama-review`（审读）、`drama-export`（导出）、`drama-shot-prompt`（分镜提示词兜底写作）。

## 斜杠命令 `/drama`

| 输入 | 行为 |
|---|---|
| `/drama` | 用法 + 当前工作区项目与进度 |
| `/drama 项目` | 列出短剧项目 |
| `/drama 进度 [剧名]` | 阶段与关键事实 |
| `/drama 检查 [剧名]` | 一致性检查，直接返回问题清单 |
| `/drama 草稿 [剧名]` | 待处理草稿 |
| `/drama 导出 <markdown\|json\|csv\|vcs> [剧名]` | 导出交付物 |
| `/drama 定稿 <集数> [剧名]` | 定稿某一集 |
| `/drama 大纲\|人物\|世界观\|剧本\|分镜\|润色 [要求]` | 交给 Agent 生成（会产生一次模型回复） |

两条纪律：**只在「短剧模式」会话生效**（其它会话返回明确错误）；**确定性操作不产生模型轮次**。

## 分镜数据模型（add-only）

分镜 JSON 在原有必填字段之外，可选增加：`emotion`（情绪 + 强度）、`light`、`ambientSound`、
`constraints`、`poses`（起止体态）、`transitionToNext`、`naturalLanguagePrompt`、`lens`、`subject`、`groupId`。
不提供 / 空值不落盘，**旧项目字节级不变**。

情绪总控分组存 `.aidrama/storyboard-groups/<集>.json`（隐藏 sidecar，不新增可见节点），
与分镜同事务提交；定稿快照与回滚会一并保留 / 恢复。

## 素材与媒体（v0.15.1 – v0.15.4）

- **`media-read` 本地安全只读通道**（第 69 个宿主路由）：
  仅接受项目内相对路径（禁止绝对路径 / 盘符 / UNC / `..` 及其编码变体），
  `realpath` 校验防 symlink 逃逸，图片（png/jpg/jpeg/webp/gif）与音频（mp3/wav/m4a/ogg 等）MIME 白名单，
  单次读取 ≤ 8MB；错误码 `invalid-args | forbidden | not-found | too-large`，错误信息不泄露绝对路径；
- **资产卡媒体字段**：`media.images`（1–6 项）、`media.thumbnail`、`media.audio`（1–6 项），全部 add-only；
  旧项目无 `media` 键、字节级不变；
- **素材库 2.0**：旧登记与资产卡统一卡片视图（kind 筛选 / 搜索 / 排序 / 登记后自动刷新 / 文件缺失占位），
  图片经 `assetId` 预览为 data URL；视频/文档显示占位与信息（无缩略图）；
- **视觉圣经专区**（素材库内入口，不新增一级页签）：视觉基调 + 场景卡区 + 角色卡区（音频多段试听）+
  关键参考图墙（去重 / lazy 加载 / lightbox / 占位），旧项目零新 UI。

## 导入桥与 VCS 视图

- **分镜提示词 MD 导入**：`drama_import_script` 的 `format=shot-prompt` 支持「草帽」式分镜提示词
  （`镜头NN｜时间码｜景别｜焦段` + `光影：` / `现场声：` / `台词：`）与分镜表 Markdown；
  固定 **preview（只读，不写盘）→ apply（事务写盘，失败回滚）**。未识别内容不会被静默丢弃：
  归入 `naturalLanguagePrompt` / `description` 或进 `warnings` 与覆盖率统计。
- **VCS 视图导出**：`drama_export format=vcs` 输出「全组情绪总控 + 逐镜 VCS 块」，
  确定性渲染（同输入同字节，无时间戳），可被导入桥回读（往返断言）。

## 质量体系（判据 / 门禁 / 评测）

- 判据规则**单一事实源**：`presets/rules/*.json`（judges / thresholds / lexicon / assets），
  JS 侧与验收侧共用同一 loader，不在代码里维护规则镜像；
- 判据覆盖写作侧（提示词可观测性、正负表述、一镜一事）与结构侧（景别接续、体态承接、每镜光影、
  现场声、焦段纪律）；默认 **WARN、不阻断** strict，旧项目缺字段自动 SKIP，零噪声；
- 资产门禁、评测门禁同样默认只提示；导出 / 定稿不被误拦。

## 资产与风格

- **9 类资产编号**：`CHR` 角色 / `SPC` 场景 / `PRP` 道具 / `SHT` 镜头资产 / `CST` 服装 / `EXP` 表情 /
  `SFX` 特效 / `VOX` 配音 / `MUS` 音乐，基础编号 `<前缀><3 位序号>`，可选变体后缀 `_01`–`_99`；
- 资产卡存 `.aidrama/assets/cards.json`，提示词中用 `{{Asset_<ID>_<字段>}}` 占位符引用并做式样校验；
- 场景卡（`.aidrama/scenes/cards.json`）：空间 / 光线 / 资产引用 / 情绪基线，**零相机锁合**（不含镜头参数）；
- 风格 DNA（`.aidrama/style.json`）：色板 / 光感 / 质感 / 构图 / 运动五维，可注入到视频提示词。

## 成本与生成编排

| | LibTV（主选） | NeoWoW（备选） |
|---|---|---|
| 形态 | 本地 CLI `libtv` 子进程（默认 `~/.libtv/libtv.exe`，可用 `LIBTV_CLI_PATH` 覆盖） | 本地 CLI `neowow` 子进程 |
| 登录 | CLI 内完成 | API Key |
| 能力 | 画布 / 节点 / 上传 / 生成 / 下载 | 画布 / 节点 / 生成 / 轮询 |

- **成本档位路由**：`settings.taskModels.<task>.costTier` 可选 `fast / standard / strong`，
  可配 `costTierModels` 映射；映射不可用时回退 standard → 宿主默认模型，不报错；
- **成本预估 + 三级闸门**：任务级 / 批次级 / 预算级上限，超限拦截并说明；
- **预算台账** `.aidrama/budget.json`，同一任务只计费一次；
- **两阶段编排**：`planGeneration`（无副作用）→ `submitBatch`（可部分失败、幂等）→ `collectBatch`
  （可反复调用直到全部产出；支持断点 resume 与漂移检测）；
- **护栏**：绑定检查 + 写入前指纹 + 写入后漂移判定；以项目分镜为唯一事实源，双主防护只报告差异、不自动改画布；
- **不假装**：账号状态来自 CLI 实测，产物状态必须见到真实文件。

## 数据落盘

```text
<工作区>/AI短剧/
  <短剧名>/
    剧集契约.md / 总纲/分集大纲.md / 人物/人物设定卡.md /
    分集剧本/第001集.md / 分镜/第001集.分镜.md
    构想/ 世界观/ 台词与音效/ 素材/ 草稿区/ 定稿/ 账本/ 本剧记忆/ 导出/
    .aidrama/                       ← 机读源数据 + history/ 历史快照
      contract.json  outline.json  characters.json  world.json  memory.json
      storyboard/  storyboard-groups/  finalized.json  drafts/
      budget.json  tasks.json  assets/（legacy assets.json + cards.json）
      scenes/cards.json  style.json
  共享资料/                         ← 跨项目共享资料
```

结构化数据以 `.aidrama/*.json` 为唯一事实源；可见的 `.md` 由它渲染，**不存在双写**。
所有写入原子替换，覆盖前留 `history/` 快照（保留最近 20 份）。

## 架构

```text
dsh-plugin-ai-drama/
  package.json            # dsh.manifestVersion / dsh.bundle.patch[2] / dsh.client
  cordis.patch.yml        # 把主插件插入组合树
  index.js                # 宿主半：69 个 POST /api/ai-drama/<method> 路由（含 media-read）+ 工具白名单挂载 + /drama
  preset.js               # 预设伴生入口：provide('dramaMode') + 挂载随包技能
  presets/drama.patch.yml # 「短剧模式」Agent 预设声明
  presets/rules/*.json    # 判据 / 阈值 / 词表 / 资产规则（单一事实源）
  lib/store.js            # 项目仓储：原子写入、快照、结构化文档、检索、条目管理
  lib/media.js            # 本地图片 / 音频安全只读通道（路径与 MIME 白名单、≤8MB）
  lib/tools.js            # 34 个 drama_* Agent 工具
  lib/checks.js           # 确定性检查（分级 schema：pass/fail/warn/skipped）
  lib/consistency.js      # 一致性检查
  lib/retrieval.js        # 本地词法检索（中文单字 + 二元组 + BM25 风格打分）
  lib/import-bridge.js    # 分镜提示词 MD → 分镜 JSON 导入桥
  lib/video-prompt.js     # 草帽式 video prompt 渲染（确定性、限长）
  lib/criteria-rules.js   # 判据规则 loader（与 presets/rules 同源）
  lib/prompt-discipline.js / lib/shot-continuity.js  # 写作侧 / 结构侧判据
  lib/assets.js / lib/asset-gates.js                 # 资产编号 / 资产卡 / 资产门禁
  lib/scenes.js / lib/style-dna.js                   # 场景卡 / 风格 DNA
  lib/model-routing.js    # 成本档位路由（fast / standard / strong）
  lib/generation.js       # 任务台账 / 预算台账与闸门 / 产物回流
  lib/guard.js            # 上游冲突保护与双主防护
  lib/orchestrator.js     # 生成编排：规划 → 提交 → 收敛
  lib/backends/           # LibTV / NeoWoW CLI 适配层
  lib/exporter.js         # 导出 Markdown / JSON / CSV / VCS
  skills/drama-*/SKILL.md # 10 个随包技能
  client.js               # 客户端半：侧栏入口 + 14 页签面板（4 组）
  test/                   # 41 个测试套件，纯 Node 运行，无外部依赖
```

宿主半提供 `POST /api/ai-drama/<method>` 精确路由（请求头 `x-ai-drama-request: 1`），
客户端半只用浏览器模块表提供的 React，不引入额外运行时依赖。

## Harness 兼容性

**原则：插件不因 Harness 升级而失效；只有真实契约变化才允许不兼容，且必须被测试门禁提前发现。**

| 项 | 约定 |
|---|---|
| 已验证 Harness | **0.2.0-rc.2**（历史验收基线）、**0.2.1-rc.2**（兼容修复后实测） |
| preset 模板变量 | 只允许跨版本保守变量 `provider` / `model`；**不得使用 `cwd` 等段落局部变量**（0.2.1 起 persona 模板按该段已注册变量严格解析） |
| peer 依赖 | 声明**允许升级的范围**（`>=0.2.0-rc.2 <0.3.0`），不锁死单个 rc 版本 |
| 升级 Harness 后 | 跑 `node test/all.mjs`（含 `preset-vars.mjs` 兼容套件）→ 在短剧模式发一条消息冒烟 → 记录版本与结果 |

> 历史问题（已修）：v0.15.5 及以前，预设 persona suffix 沿用旧模板的 `{{cwd}}`，DSH 0.2.1-rc.2 下每轮报
> `unknown prompt variable "{{cwd}}"`。v0.15.6 起移除该变量（保留 `{{model}}`），v0.15.7 起加入静态门禁与 peer 范围放宽。

## 开发与测试

```sh
npm run check     # node --check 三个入口
npm test          # 41 个测试套件
```

测试全部是纯 Node 脚本，使用假 CLI / 假 React，**不需要 API Key、不消耗任何生成积分**。
依赖本机样例数据 / 夹具的套件在数据缺失时会自动 SKIP，不影响公共 CI。
CI：GitHub Actions 上跑 Node 22 / 24 × Windows / Ubuntu 组合（见 `.github/workflows/ci.yml`）。

## 兼容性

- DSH `0.2.0-rc.2` 及以上（`0.2.x` 线；已验证 `0.2.0-rc.2`、`0.2.1-rc.2`）；
- Node.js `^22.19.0 || ^24.0.0`；
- 宿主半跨平台；主要开发 / 验证环境为 Windows 11 + Node 24（macOS / Linux 欢迎反馈）。

## 已知边界（刻意保留的「不」）

- **不按任务覆盖模型参数**：DSH 工具契约没有按调用覆盖模型参数的入口；成本档位只做「选模型」路由，不改推理参数；
- **不内建生成能力**：不做模型接入与推理资源管理；
- **不猜测价格**：外部平台只给文字计价规则时如实返回原文；
- **不自动改外部画布**：对账只报告差异，写画布由用户确认；
- **判据默认不阻断**：默认 WARN，是否升级为 FAIL 由用户 / 评测门禁决定；
- **媒体只读**：`media-read` 只读项目内文件，不写盘、不缓存、不接受绝对路径。

## 许可

[MIT](LICENSE) © 2026 HengryLiang
