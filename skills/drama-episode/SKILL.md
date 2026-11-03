---
name: drama-episode
description: 撰写单集剧本：以场次为单元，含场景标题、动作描述、角色、对白、旁白、转场。用于按大纲生成某一集，或按用户意见重写某一集。
disable-model-invocation: false
user-invocable: true
---
# 分集剧本（Drama Episode）

## 前置

1. `drama_get_project` 读回契约、大纲、人物卡。
2. 确认要写第几集。**一次只写一集**，写完交给用户看，不要连着闷头写十集。

## 格式

```markdown
# 第001集 集标题

## 场景 1：内景 - 当铺 - 夜

动作：林越被按在柜台上，刀锋贴着他脖子。

林越：这钱，我三天还你。

赵铁：三天？我明天就来收尸。

转场：切至
```

- 场景标题固定写法：`内景/外景 - 地点 - 时间`
- 动作只写镜头能拍到的（可拍性），不写心理活动
- 对白行格式严格为 `角色名：台词`，冒号用全角
- 单集场景 2~4 个，单行台词不超过 20 字

## 硬约束

1. 台词中的角色名必须在人物卡中存在。
2. 场景数与总时长要对得上契约；写完用 `drama_check_consistency` 看 storyboard-overrun 之类的提示。
3. 不写无法拍摄的内容（大场面、复杂特效），除非用户明确要求。

## v0.16.40 P0 新流程（文本适配；工具调用/参数不变）

1. **集下拉 + 三模式**：剧本页先定集；「文档/分段/审核」三模式切换（`aria-pressed` 记住上次模式）；分段模式按场景/关键画面出段（建议 3–8 段/集，一段不跨场，可后续编辑）。
2. **分段与段状态**：段存 analysis overlay（`segments[]`）；段六态由面板工作流标记（pending_storyboard→approved），**执行事实以任务/素材为准**；拆分为 maxN+1、禁 -a/-b。
3. **审核工作流**：批注/处置（open/fixed_in_draft/accepted_known_issue/rejected）+ 通过门槛 + 锁定记录存 `构想/审核/<集>.review.json`。
4. **导演 VSC（可拍性）**：剧本页 VSC 模式六区块（资产剥离/拍摄分析/镜头目的/情绪节拍/关键画面/构图建议）写入 `构想/导演剖析/<集>.analysis.json`；stale 提示不自动迁移。
5. **写入边界**：正文仍走 `drama_write_content(kind=episode)` 正式稿写入；**不写** `.aidrama`/旧 MD/JSON；overlay 容量 ≤2MB/单条 ≤4KB。

## 交付

`drama_write_content`（`kind: "episode"`，`order` 为集数，`content` 为剧本正文）写入正式稿。

## 写入稳健性（2026-10-20 补充）

- 剧本正文用**一个长字符串 + `\n` 换行转义**，不要手写多层嵌套 JSON 对象。
- 一次只交一集；若模型层报 `tool input is invalid JSON`，先查是否已落盘（正式稿/审计），再拆小重发。
