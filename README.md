# AI 短剧工作区 · `dsh-plugin-ai-drama`

[![test](https://github.com/HengryLiang/dsh-plugin-ai-drama/actions/workflows/ci.yml/badge.svg)](https://github.com/HengryLiang/dsh-plugin-ai-drama/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-6f42c1)](https://github.com/topics/dsh-plugin)

**交流与支持**：[联系作者（微信）](#联系与交流) · [赞助支持](#赞助支持) · [商业合作与定制](#商业合作与定制)

> DeepSeek Harness（DSH）插件：把 AI 短剧的 **立项 → 总纲 → 人物 → 世界观 → 剧本 → 分镜 → 生成 → 导出** 收进侧栏工作区，
> 并附带「短剧模式」Agent 预设——**33 个 `drama_*` 工具**、**19 个随包技能**、**79 个宿主路由**、**14 页签面板**，
> 以及与 LibTV / NeoWoW 画布 CLI 对接的生成编排适配层。

> English: An AI short-drama workspace plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
> Sidebar + main-panel workspace covering the full short-drama pipeline, a dedicated `drama` agent preset with
> 33 agent tools, 19 bundled skills, a `/drama` slash command, criteria/quality gates, an asset & style system,
> safe local media access, asset import / cross-project reuse / multi-round review, shot-prompt import / VCS export,
> and adapters that drive external canvas CLIs (LibTV / NeoWoW). UI and docs are in Chinese.

> 当前版本：**v0.16.281**（本地最新开发线同步构建）。个人使用免费；企业定制 / 专属支持见文末「商业合作与定制」。

---

## 它解决什么问题

写一部短剧，真正麻烦的不是「让模型写一段」，而是**让几十集内容彼此一致、可查、可交付**：
人物设定散在聊天记录里、伏笔写完就忘、分镜表和剧本对不上、改一集要翻十处、导出还要手工拼；
接上生成之后，又要管成本、管资产编号、管批量任务与失败重试。

这个插件把短剧创作当成一个有状态的项目来做：

- **单一事实源**：结构化数据落在 `.aidrama/*.json`，`.md` 由它渲染，避免「两边同时改」的双写冲突；
- **落盘可恢复**：所有写入走「临时文件 → rename」原子替换，覆盖前留 `history/` 快照；
- **写入口安全**：所有写路径统一校验（禁项目外/`..`/UNC/设备路径/控制字符），非法输入不写盘、错误不泄露绝对路径；
- **确定性判据**：一致性检查与创作质量判据（可观测性 / 景别接续 / 体态承接 / 光影 / 现场声等）不依赖模型，随时可跑；
- **生成物先入草稿区**：AI 产出先进草稿，用户采纳后才进正式稿；
- **生成编排不内建生成能力**：出图 / 出视频 / 出配音交给外部画布 CLI，插件只做适配、编排、回流、预算与门禁。

## 能力一览

| 模块 | 能力 |
|---|---|
| 工作区与导航 | 侧栏「AI 短剧」+ 中央面板 **14 页签 / 4 组**：创作（世界观 / 总纲 / 人物 / 剧本 / 分镜 / **视觉圣经**）、资料（素材库 / 记忆 / 草稿 / 账本）、交付（生成 / 检查导出）、高级（目录 / 工具卡）；窄窗「更多」收纳、键盘导航、页签关闭兜底 |
| 项目与工作台 | 新建 / 打开 / 重命名 / 删除；固定文件夹规范（v0.16.94）；**项目封面自定义**（`media-upload` cover）；目录树（展开折叠持久化）；全文检索；**多数据源**（工作区 / 会话 / 手动）；**项目 ↔ 会话绑定**；旧项目数据目录提示 |
| 内容·契约与设定 | 剧集契约 + **八大基本设定**（地理与空间 / 时间与历史 / 力量体系 / 种族与生态 / 社会与势力 / 资源与经济 / 文化与信仰 / 灵魂·生死·因果，add-only、各有上限）；**世界观 v3 三级标签**（分类 chips / 搜索 / 分组 / 二级页签 / 删除 → 未分级）；**总纲分类**（分集主从 / 搜索 / 时长 / 表格） |
| 内容·人物 / 剧本 / 分镜 | 人物设定卡（多状态卡 / 状态绑定 / 音色绑定）；分集剧本（台词视图、剧本页资产模块）；分镜可选字段 + **情绪总控分组 sidecar**；分镜删除（非阻塞）/ `groupIdEdits` 双向同步 / 结构化状态绑定 / 生成到状态；**拍摄组多镜 4–30s 技术校验 + Seedance 默认** |
| 台词与音效 | 台词并入「剧本」视图；配音稿导出；角色卡音频（`media.audio`）与 `<audio>` 多段试听；角色音色手动绑定；`audio-bindings` 声音绑定；旧 `dialogue` 深链自动重定向 |
| 素材库 | 素材登记**仅项目内**；`media-read` / `media-upload` 安全通道；扫描素材目录（分类过滤 / 惰性加载 / 批量登记）；**一键导入**（≤50MB/件、SHA 去重、同名 `(2)`、失败回滚）；**素材分类 19 类**（含载具 VEH）；按集目录 / 视频落点；导入历史；组合模板（保存 / 回填 / 删除）；**模板包导出 / 导入**（template-pack）；旧登记统一视图与迁移提示 |
| 资产体系 | **10 类资产编号**（CHR 角色 / SPC 场景 / PRP 道具 / SHT 镜头资产 / CST 服装 / **VEH 载具** / EXP 表情 / SFX 特效 / VOX 配音 / MUS 音乐，含变体后缀）；资产卡（图 / 音频 / 缩略图 / prompts / **多状态**）；`{{Asset_*}}` 占位符；资产剥离 / 生成 / 调度 / 迁移 / 绑定；分页与 Projection；资产详情 / 预览 / 大图 |
| 资产审核 | 资产多轮审核状态机（`asset-save`，轮次 ≤20、字段编辑模式、审核哈希）；场景卡审核；导出仅 `final` 状态带最终提示词 |
| 视觉圣经 | 独立页签；视觉基调 + 场景卡区 + 角色卡区（音频多段试听）+ 关键参考图墙（按资产类型分组 / chips / 搜索 / lazy / lightbox）；参考 / 分析 / 锁定共享；风格分析路径与失败容错（保留上次结果、**六维「其他」**）；风格**定向 / 冻结 / 解冻**（`style-save`：423 硬锁、409 expectedHash、解冻审计） |
| 质量与安全 | 判据机器化（`presets/rules/*.json` 单一源）；分级检查（pass / fail / warn / skipped）；评测门禁；资产门禁；**写路径安全矩阵**（`..` / 绝对项目外 / UNC / 设备路径 / 编码穿越 / `.aidrama` / 保留名 / symlink 全拒）；原子写 + 事务锁 + 幂等 + 审计；**备份 / 恢复**（create / verify / restore / dry-run / 回滚 / 对象级 summary） |
| 成本与生成编排 | 成本预估 + 三级闸门；`fast / standard / strong` 成本档位；预算台账（同一任务只计费一次）；多集批量（规划 → 提交 → 收敛）；幂等提交 / 断点 resume / 漂移检测；产物入库安全硬化（禁私网、重定向 ≤5 跳、流式 ≤64MB）；画布绑定 / 对账 / 状态；**宿主直连生图、自动取回 / 自动绑定、后台 worker 托管**；生成任务与素材回填追踪 |
| 技能与工具 | **33 个 `drama_*` Agent 工具**（仅「短剧模式」会话注册）；**19 个随包技能**；技能管理（校验 / active·disabled / inventory / 「Skill 管理」四 tab UI）；`/drama` 斜杠命令；「短剧模式」预设（短剧编剧 / 制片 / 分镜导演 / 合规顾问人格，移除 shell 类工具） |
| 导入导出与交付 | 剧本导入（预览 → 落盘）；**分镜提示词 MD 导入桥（`format=shot-prompt`）**；VCS 视图 / `drama-vsc-brief` 简报；导出 Markdown 全本 / JSON 结构化包 / CSV 分镜表 / **Manifest** / **SRT 字幕 / 剪辑清单 CSV**；定稿快照与回滚；账本（场景 / 内外景 / 镜头 / 时长 / 角色 / 地点 + 成本提示） |
| 宿主契约与兼容 | **79 个宿主路由**（`POST /api/ai-drama/<method>`，覆盖项目 / 内容 / 素材 / 资产 / 风格 / 备份 / 技能等）；`dsh.bundle` 双补丁 + `dsh.client`；DSH 0.2.x 线兼容；preset 模板变量白名单 + peer 范围门禁 |

> 口径：公开版 **v0.16.281**；33 个 Agent 工具 / 79 个宿主路由 / 19 个随包技能 / 14 页签。

## 安装

要求：

- **DeepSeek Harness ≥ `0.2.0-rc.2`**（`0.2.x` 线；已验证 0.2.0-rc.2 与 0.2.1-rc.2，见「Harness 兼容性」）
- **Node.js `^22.19.0 || ^24.0.0`**
- Web 界面（插件含客户端半，需要 `dsh web` / 桌面端的 Web 面）

插件是**纯 JavaScript、无构建步骤**（不需要 `prepare` / `allowBuilds`），三种安装方式任选。

### 方式一：直接从 GitHub 安装（推荐）

```sh
dsh plugin --profile <profile> add github:HengryLiang/dsh-plugin-ai-drama#v0.16.281
```

`<profile>` 换成你的 profile 名（`dsh web` 对应 `web`，桌面端通常是 `desktop`）。首次使用 `dsh plugin` 会自动创建 profile。

### 方式二：从 GitHub Release 的预打包 tarball 安装

```sh
curl -L -o dsh-plugin-ai-drama.tgz \
  https://github.com/HengryLiang/dsh-plugin-ai-drama/releases/download/v0.16.281/dsh-plugin-ai-drama-0.16.281.tgz
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

4. 面板 **14 个页签 / 4 组**：
   - **创作**：世界观（含八大基本设定）、总纲、人物、剧本、分镜、视觉圣经；
   - **资料**：素材库、本剧记忆、草稿、账本；
   - **交付**：生成、检查 / 导出；
   - **高级**：目录、工具卡片。

## 「短剧模式」预设

预设以 Cordis YAML 声明（`presets/drama.patch.yml`），基于 DSH 随包标准预设改写：

- persona 换成短剧编剧 / 制片 / 分镜导演 / 合规顾问；
- **去掉 shell 命令类工具**（工具白名单）；
- 收敛子代理编排组，工具面聚焦创作；
- 追加隔离服务插件 `dsh-plugin-ai-drama/preset`：在该预设作用域内标记 `dramaMode`，
  主插件据此**只对处于短剧模式的 Agent** 注册 `drama_*` 工具，预设未启用时工具不出现，切走自动回收。

预设同时通过 `@deepseek-ai/dsh-skill-filesystem` 的 `bundledSkillDir` 随包挂载 `skills/`，
所以「短剧模式」会话里 10 个技能自动可用。

> 模板变量只使用跨版本保守变量（`provider` / `model`），不使用 `cwd` 等段落局部变量（原因见「Harness 兼容性」）。

## `drama_*` 工具（33 个）

| 分组 | 工具 |
|---|---|
| 项目 | `drama_list_projects` / `drama_create_project` / `drama_get_project` |
| 文档写入 | `drama_save_contract`（含八大基本设定）/ `drama_save_outline` / `drama_save_characters` / `drama_save_world` / `drama_save_memory` / `drama_read_episode` |
| 进度与检索 | `drama_get_progress` / `drama_search_context` / `drama_get_ledger` |
| 台词与素材 | `drama_get_dialogue` / `drama_export_voice_script` / `drama_list_assets` / `drama_add_asset` / `drama_asset_save` |
| 内容写作 | `drama_write_content`（正文 / 草稿等内容写入） |
| 定稿 | `drama_finalize_episode` / `drama_list_finalized` |
| 导入 / 导出 / 质检 | `drama_import_script`（剧本、`format=shot-prompt` 分镜提示词）/ `drama_check_consistency` / `drama_export`（markdown / json / csv / vcs） |
| 生成编排 | `drama_budget` / `drama_bind_canvas` / `drama_canvas_status` / `drama_reconcile_canvas` / `drama_plan_generation` / `drama_record_generation` / `drama_intake_artifact` / `drama_plan_batch` / `drama_submit_batch` / `drama_collect_batch` |

工具全部是**确定性实现**（读写文件、结构化校验、检索、渲染、编排），生成类操作交给 Agent 调模型，
插件只负责把结果安全落盘。测试用工具（`drama_test_*`）只在 `DSH_AI_DRAMA_TEST_TOOLS=1` 时注册，生产工具面保持 33 个。

## 随包技能（19 个）

`drama-setup`（立项）、`drama-outline`（总纲）、`drama-characters`（人物）、`drama-episode`（剧本）、
`drama-script`（剧本写作）、`drama-storyboard`（分镜）、`drama-shot-prompt`（分镜提示词兜底）、
`drama-seedance-prompt`（Seedance 视频提示词）、`storyboard-seedance`（分镜 → Seedance 链路）、
`drama-director`（导演 / 镜头语言）、`drama-polish`（润色）、`drama-review`（审读）、`drama-export`（导出）、
`drama-music`（音乐 / 音频）、`drama-asset`（资产体系）、`drama-asset-analysis`（资产分析）、
`drama-visual-bible`（视觉圣经）、`drama-vsc-brief`（VSC 视图 / 交接简报）、`roundtable`（多角色圆桌）。

技能通过 `@deepseek-ai/dsh-skill-filesystem` 的 `bundledSkillDir` 随包发现，「短剧模式」会话内自动可用。

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

## 内容模型（add-only，旧项目字节级不变）

- **八大基本设定**（v0.16.3，`contract.json` 可选 8 字段，各有长度上限，缺省不落键）：
  地理与空间、时间与历史、力量体系、种族与生态、社会与势力、资源与经济、文化与信仰、灵魂/生死/因果；
  每字段在 `剧集契约.md` 按固定顺序渲染为条件段，context-card 摘要 ≤200 字/字段；
- **分镜可选字段**：情绪与强度、光影、现场声、禁令、起止体态、衔接、自然语言段、焦段、主体、分组；
  情绪总控分组存 `.aidrama/storyboard-groups/<集>.json` sidecar，与分镜同事务、定稿快照一并保留；
- **视觉圣经**：场景卡（`.aidrama/scenes/cards.json`，零相机锁合）、六维风格 DNA（色板 / 光感 / 质感 / 构图偏好 / 运镜节奏 / 其他；`.aidrama/style.json`）；
  风格支持 **定向 → 冻结 → 解冻** 状态机（`style-save`：423 硬锁、409 expectedHash 冲突检测、解冻审计）。

## 素材与媒体（v0.15.8 – v0.16.281）

- **登记仅项目内**：新登记只接受项目内路径；项目外绝对路径 / `..` / UNC / symlink 逃逸一律拒绝且不写盘；
  历史外部登记在迁移期只读兼容（客户端标注「外部路径（待迁移）」，并提供扫描/一键导入迁移路径）；
- **`media-read` 安全只读通道**（79 个宿主路由之一）：项目内相对路径、`realpath` 防 symlink 逃逸、
  图片/音频 MIME 白名单、≤8MB；错误码 `invalid-args | forbidden | not-found | too-large`，错误不泄露绝对路径；
- **扫描素材目录 + 批量登记**：递归扫描 `素材/`，排除隐藏文件 / `.aidrama` / 清单文件 / symlink，
  未登记列表上限 1000（`truncated` 标记），批量登记串行、失败汇总；
- **一键导入 `assets-import`**：按分类落 `素材/<分类>/`（素材分类 19 类），≤50MB/件，SHA256 去重（409 conflict 不写盘）、
  同名自动 `(2)`、登记失败删除文件回滚；**跨项目复用**（`sourceProjectId` + `sourceAssetIds[]`，源项目只读、
  逐项 imported/skipped/failed）与**跨对象复制**（资产卡 / 场景卡 / 风格 DNA，ID 冲突跳过或分配空闲编号）；
- **素材库 2.0 / 视觉圣经**：统一卡片视图、`assetId` 安全预览（data URL）、kind 筛选 / 搜索 / 排序 /
  自动刷新 / 文件缺失占位；图墙按资产类型分组（场景 / 角色 / 道具 / 其他）+ chips / 搜索 / lazy + lightbox；参考 / 分析 / 锁定共享；
- **产物入库安全硬化**：`intake-artifact` 本地文件仅项目内；远端 URL 仅 http(s)、禁本机/内网/元数据地址、
  重定向 ≤5 跳且每跳复核、流式 ≤64MB、`sourceUrl` 清洗去凭据；
- **写路径安全审计**：覆盖全部 HTTP / 工具写入口的路径负例矩阵（`..`、绝对项目外、UNC、设备路径、
  控制字符、`%2e%2e` 编码、`.aidrama`、保留名/尾随点空格、symlink 逃逸），非法输入零写盘。

## 资产多轮审核（v0.16.9）

- `asset-save` 维护资产卡审核状态机（rounds ≤ 20），默认响应不变、旧卡零写回；
- 支持按需返回审核哈希（`includeReviewHashes`）；场景卡同链路；
- 导出时仅 `final` 状态附带最终提示词；跨项目复制会重置审核状态并给出 warning。

## 导入桥与 VCS 视图

- **分镜提示词 MD 导入**：`drama_import_script` 的 `format=shot-prompt` 支持「草帽」式分镜提示词
  （`镜头NN｜时间码｜景别｜焦段` + `光影：` / `现场声：` / `台词：`）与分镜表 Markdown；
  固定 **preview（只读，不写盘）→ apply（事务写盘，失败回滚）**。未识别内容不会被静默丢弃。
- **VCS 视图导出**：`drama_export format=vcs` 输出「全组情绪总控 + 逐镜 VCS 块」，
  确定性渲染（同输入同字节，无时间戳），可被导入桥回读（往返断言）。

## 质量体系（判据 / 门禁 / 评测）

- 判据规则**单一事实源**：`presets/rules/*.json`（judges / thresholds / lexicon / assets），
  JS 侧与验收侧共用同一 loader，不在代码里维护规则镜像；
- 判据覆盖写作侧与结构侧；默认 **WARN、不阻断** strict，旧项目缺字段自动 SKIP，零噪声；
- 资产门禁、评测门禁同样默认只提示；导出 / 定稿不被误拦。

## 成本与生成编排

| | LibTV（主选） | NeoWoW（备选） |
|---|---|---|
| 形态 | 本地 CLI `libtv` 子进程（默认 `~/.libtv/libtv.exe`，可用 `LIBTV_CLI_PATH` 覆盖） | 本地 CLI `neowow` 子进程 |
| 登录 | CLI 内完成 | API Key |
| 能力 | 画布 / 节点 / 上传 / 生成 / 下载 | 画布 / 节点 / 生成 / 轮询 |

- **成本档位路由**：`settings.taskModels.<task>.costTier` 可选 `fast / standard / strong`；
- **成本预估 + 三级闸门**：任务级 / 批次级 / 预算级上限，超限拦截并说明；
- **预算台账** `.aidrama/budget.json`，同一任务只计费一次；
- **两阶段编排**：`planGeneration` → `submitBatch`（可部分失败、幂等）→ `collectBatch`
  （可反复调用直到全部产出；支持断点 resume 与漂移检测）；
- **护栏**：绑定检查 + 写入前指纹 + 写入后漂移判定；双主防护只报告差异、不自动改画布；
- **不假装**：账号状态来自 CLI 实测，产物状态必须见到真实文件。

## 数据落盘

```text
<工作区>/AI短剧/
  <短剧名>/
    AI短剧/剧集契约.md / 总纲/分集大纲.md / 人物/人物设定卡.md /
    分集剧本/第001集.md / 分镜/第001集.分镜.md
    构想/ 世界观/ 台词与音效/ 素材/ 草稿区/ 定稿/ 账本/ 本剧记忆/ 导出/
    .aidrama/                       ← 机读源数据 + history/ 历史快照
      contract.json  outline.json  characters.json  world.json  memory.json
      storyboard/  storyboard-groups/  finalized.json  drafts/
      budget.json  tasks.json  assets.json  assets/cards.json
      scenes/cards.json  style.json  reviews/  audit/
  共享资料/                         ← 跨项目共享资料
```

结构化数据以 `.aidrama/*.json` 为唯一事实源；可见的 `.md` 由它渲染，**不存在双写**。
所有写入原子替换，覆盖前留 `history/` 快照（保留最近 20 份）。

## 架构

```text
dsh-plugin-ai-drama/
  package.json            # dsh.manifestVersion / dsh.bundle.patch[2] / dsh.client
  cordis.patch.yml        # 把主插件插入组合树
  index.js                # 宿主半：79 个 POST /api/ai-drama/<method> 路由 + 工具白名单挂载 + /drama
  preset.js               # 预设伴生入口：provide('dramaMode') + 挂载随包技能
  presets/drama.patch.yml # 「短剧模式」Agent 预设声明
  presets/rules/*.json    # 判据 / 阈值 / 词表 / 资产规则（单一事实源）
  lib/store.js            # 项目仓储：原子写入、快照、结构化文档、检索、条目管理
  lib/media.js            # 本地图片 / 音频安全只读通道（路径与 MIME 白名单、≤8MB）
  lib/contract-world.js   # 八大基本设定（8 字段 schema / 校验 / MD 段 / context 摘要）
  lib/import-assets.js    # 素材导入 / 跨项目复用 / 跨对象复制
  lib/asset-*.js          # 资产绑定 / 抽取 / 生成 / 迁移 / 调度
  lib/skill-config.js, lib/skill-managed.js  # 技能配置与托管
  lib/tools.js            # 33 个 drama_* Agent 工具
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
  lib/generation.js       # 任务台账 / 预算台账与闸门 / 产物回流（URL/本地文件安全硬化）
  lib/guard.js            # 上游冲突保护与双主防护
  lib/orchestrator.js     # 生成编排：规划 → 提交 → 收敛
  lib/backends/           # LibTV / NeoWoW CLI 适配层
  lib/exporter.js         # 导出 Markdown / JSON / CSV / VCS
  skills/drama-*/SKILL.md # 19 个随包技能
  client.js               # 客户端半：侧栏入口 + 14 页签面板（4 组）
  test/public-smoke.mjs   # 公开仓库结构 smoke（CI 运行）
```

宿主半提供 `POST /api/ai-drama/<method>` 精确路由（请求头 `x-ai-drama-request: 1`），
客户端半只用浏览器模块表提供的 React，不引入额外运行时依赖。

## Harness 兼容性

**原则：插件不因 Harness 升级而失效；只有真实契约变化才允许不兼容，且必须被测试门禁提前发现。**

| 项 | 约定 |
|---|---|
| 已验证 Harness | **0.2.0-rc.2**（历史验收基线）、**0.2.1-rc.2**（兼容修复后实测） |
| preset 模板变量 | 只允许跨版本保守变量 `provider` / `model`；**不得使用 `cwd` 等段落局部变量** |
| peer 依赖 | 声明**允许升级的范围**（`>=0.2.0-rc.2 <0.3.0`），不锁死单个 rc 版本 |
| 升级 Harness 后 | 跑 `node test/all.mjs`（含 `preset-vars.mjs` 兼容套件）→ 在短剧模式发一条消息冒烟 → 记录版本与结果 |

## 开发与测试

```sh
npm run check   # node --check 三个入口
npm test        # 公开仓库结构 smoke（test/public-smoke.mjs，不依赖本机夹具）
```

公开仓库只携带**结构 smoke**：包契约、组合树引用、客户端 bundle、技能/规则完整性、
内部路径泄漏与运行时导出检查，可在任意机器与 CI 上运行
（GitHub Actions：Node 22 / 24 × Windows / Ubuntu）。

> 完整插件行为测试套件（167 个套件，含真实样例数据与历史基线夹具）在作者开发环境中运行，
> 依赖本机样例与证据目录，因此不随公开仓库分发。安装后的实际体验以你所在环境的运行结果为准。

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
- **媒体只读且仅项目内**：`media-read` 只读项目内文件，不写盘、不缓存、不接受绝对路径；
- **历史上传的外部登记**：迁移期只读兼容，新登记一律要求项目内路径。

## 联系与交流

使用问题、需求反馈、插件玩法交流，欢迎扫码添加作者微信（添加请备注「DSH 短剧」，方便通过）：

<img src="assets/wechat-contact.jpg" alt="作者微信：xi2xi-AIGC" width="220">

> 也可以直接在 GitHub 提 [Issue](https://github.com/HengryLiang/dsh-plugin-ai-drama/issues)，公开问题优先走 Issue，方便后来者检索。

## 赞助支持

如果这个插件对你有帮助，欢迎**自愿赞助**，支持后续维护、更新与文档完善：

<img src="assets/sponsor-wechat-pay.jpg" alt="微信支付赞助（自愿）" width="260">

- 赞助完全自愿，**不影响任何功能**，也不影响开源许可；
- 个人使用始终免费；不想赞助也完全可以正常用全部开源功能。

## 商业合作与定制

本项目采用「**开源免费 + 付费支持**」并行模式：

| 场景 | 说明 |
|---|---|
| 个人使用 | 免费，MIT 开源，保留版权与许可声明即可 |
| 团队 / 企业内部使用 | 免费，可自行部署与修改 |
| 企业商用定制 | 专属功能开发、私有化部署、与既有画布 / 资产库 / 工作流集成 |
| 技术支持 | 紧急排障、版本升级适配、专属答疑与响应保障 |

付费购买的是「**额外定制 + 响应保障**」，不是功能解锁——开源版本已经包含全部插件功能。
有需要可通过上方微信联系（备注「DSH 短剧合作」）。

## 许可

[MIT](LICENSE) © 2026 HengryLiang

开源免费与付费定制并行：个人与内部使用免费，商业定制 / 专属支持为可选的付费服务，不影响开源自许可。
