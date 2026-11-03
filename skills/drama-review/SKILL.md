---
name: drama-review
description: 短剧一致性审读：结合确定性检查工具与人工判读，找出人物 OOC、设定冲突、时间线错误、重复桥段、时长越界。交付前必跑。
disable-model-invocation: false
user-invocable: true
---
# 一致性审读（Drama Review）

分两层：**工具层**负责确定性事实，**判读层**负责语义问题。

## 第一层：确定性检查

调用 `drama_check_consistency`，逐条处置返回的问题：

| code | 含义 | 处置 |
|---|---|---|
| `contract-*` | 契约缺字段 | 回 `drama-setup` 补齐 |
| `outline-count` | 总纲集数与契约不符 | 与用户确认以哪边为准 |
| `unknown-speaker` | 剧本说话人不在人物卡 | 改台词姓名，或补建角色卡 |
| `storyboard-overrun` / `-underrun` | 分镜时长越界 | 增删镜头或调整镜长 |
| `shot-duplicate` | 镜号重复 | 重排镜号 |
| `episode-gap` | 分集编号缺口 | 确认是漏写还是故意跳号 |
| `duplicate-beat` | 钩子或反转跨集重复 | 重写重复的那一集 |
| `episode-without-outline` | 有剧本无大纲 | 补总纲条目 |

**不允许**把工具报出的 error 级问题说成「问题不大」直接放过。

## 第二层：人工判读（工具查不出来的）

1. **人物 OOC**：把该角色全部台词串起来读，语气是否前后一致。
2. **时间线**：跨集的「昨天/三天后」是否对得上。
3. **伏笔回收**：本剧记忆里登记的未回收伏笔是否已经断线。
4. **信息差**：观众知道的和角色知道的，是否按设计推进。

## v0.16.40 P0 审核工作流（文本适配；工具调用/参数不变）

1. **四档处置**（annotation resolution 唯一枚举）：`open` / `fixed_in_draft` / `accepted_known_issue` / `rejected`；每条附 `resolvedBy/resolvedAt/note?`。
2. **通过门槛（AC-31）**：仅 `open` 状态的 blocker/major 阻断；`fixed_in_draft`/`accepted_known_issue`/`rejected` 不阻断；**blocker 无 accepted_known_issue 通道**（必须修复或驳回）。
3. **提交与记录**：面板通过必须人工点击，写 `review.approver` + `review.approvedAt`；锁定写 `lockedBy/lockedAt`，解锁写 `unlockLog[]`（PRD 名 `approver`，不新增 `approvedBy`）。
4. **位置**：审核记录存 `构想/审核/<集>.review.json`（overlay，不改旧 JSON/MD）；diff/跨版本不自动迁移。
5. **已知限制（A-24/LIM-1）**：episode accept 的 history 快照为 no-op，不要承诺「版本历史回滚」；P1 修复。

## 交付

输出问题清单，每条含：**严重级别 / 位置（集·场·镜）/ 问题 / 建议改法**。
改法要落到具体句子，不要写「建议优化节奏」这类空话。
