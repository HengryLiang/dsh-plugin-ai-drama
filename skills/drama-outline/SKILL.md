---
name: drama-outline
description: 生成或改写分集大纲：每集给出标题、一句话梗概、开场钩子、中段反转、结尾悬念与预计时长。用于总纲从零生成、扩集、或按用户意见重排。
disable-model-invocation: false
user-invocable: true
---
# 分集大纲（Drama Outline）

## 前置

先 `drama_get_project` 读回剧集契约与现有人物。大纲必须能对上契约里的目标集数与单集时长。

## 每集必须回答的六件事

| 字段 | 要求 |
|---|---|
| 集数 | 从 1 连续编号，不留缺口 |
| 标题 | 一集一个「爽点/悬念」式标题，不要文学化散文 |
| 一句话梗概 | 谁、想要什么、被什么挡住 |
| 开场钩子 | 前 3 秒画面＋前 10 秒冲突，具体到动作 |
| 中段反转 | 预期被打破的那一下 |
| 结尾悬念 | 逼下一集的理由 |
| 预计时长 | 秒，落在契约区间内 |

## 硬约束

1. **钩子与反转不得跨集重复**——重复会被 `drama_check_consistency` 判为 duplicate-beat。
2. 单集场景数控制在 2~4 个，优先室内、少角色。
3. 大纲只排事件与情绪曲线，不要写成剧本台词。

## 交付

用 `drama_save_draft`（`kind: "outline"`，`content` 为大纲数组的 JSON 字符串）写入草稿区，
再调 `drama_check_consistency` 自检并把问题清单一并报给用户。**不要直接调 `drama_save_outline` 覆盖正式稿。**
