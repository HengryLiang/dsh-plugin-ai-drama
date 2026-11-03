---
name: drama-asset-analysis
description: 只读分析本集剧本，产出资产清单表（含建卡基本信息/外观与 visualNeed）并写侧车 JSON（不建卡/提示词/媒体/剧本；清单 md 由客户端生成）。
---

# 剧本资产分析（drama-asset-analysis v1.2）

> 触发：用户明确要求「资产分析 / 剧本资产分析」，或收到「【资产分析任务】」指令并点名本技能。  
> 定位：**只读分析层**。产出一份可展示、可导出的「资产清单表」，回答三件事：本集有哪些资产、每项的基本信息、哪些需要资产图。  
> 不负责制作：本技能**不建卡、不写提示词、不生成媒体**。建卡由用户显式点击「按清单建卡」后另发一次 Agent 指令（drama_asset_save create）；提示词由 drama-asset 制作层后续处理。

## 1. 输入（只读）

- 项目标题、集数（指令给出）。
- 本集剧本/分镜：用已有只读工具读取，如 `drama_read_episode`、`drama_get_project`；需要时 `drama_list_assets` 只读查看现有资产名/别名，用于 `reusable` 提示。
- 可选：已有资产卡名称/别名（只读，不修改）。

## 2. 硬禁止（违反即失败）

- **不建卡、不改卡**：不得调用 `drama_asset_save` 的 create/savePrompts/saveMedia 等写动作；
- 不写提示词、不生成/上传媒体（不调用 `media-upload`、`asset-save` 等写工具）；
- 不改剧本、不改 `.analysis.json`、不写 `.aidrama/`、不写 `导出/`；
- **允许的写**：用已有 `drama_write_content(kind='file')` 只写**本集分析侧车 JSON**；`素材/资产清单.md` 由客户端用既有 `doc-save` 从侧车/清单生成，本技能不写 md；
- 不覆盖其它集、不写其它项目文件；
- 失败时不要「顺手建卡/写文件」补救；直接报告失败。

## 3. 唯一输出：分析侧车 JSON + 资产清单.md

### 3.1 侧车 JSON

- 路径（固定）：`构想/导演剖析/第NNN集.assets.json`，NNN = 三位集数（如第 1 集 → `第001集.assets.json`）。
- 写入方式：`drama_write_content(kind:'file', path:'构想/导演剖析/第NNN集.assets.json', content: <JSON 字符串>)`。
- **只写这个文件**；不要写/覆盖同目录 `第NNN集.analysis.json`。
- 文件内容必须是单个 JSON 对象，`schema` 用 `drama.asset-analysis.v1.2`。

```json
{
  "schema": "drama.asset-analysis.v1.2",
  "projectTitle": "项目名",
  "episode": 1,
  "analyzedAt": "2026-10-30T05:00:00+08:00",
  "assets": [
    {
      "type": "PRP",
      "name": "父亲留下的旧怀表",
      "aliases": ["怀表"],
      "description": "父亲遗物；银色旧怀表，内侧刻父亲名字，需特写识别；跨集信物",
      "appearance": "银色金属表壳，磨损明显，内侧刻父亲名字；需特写可见",
      "visualNeed": "reference",
      "visualNeedReason": "剧情关键特写；跨集复现；外观独特需严格一致",
      "importance": "lead",
      "reusable": true,
      "evidence": [{"line": 18, "quote": "她打开怀表，内侧刻着父亲的名字。"}],
      "confidence": 0.94,
      "note": "第1集关键道具；第2集复用"
    }
  ],
  "warnings": [],
  "stats": {"CHR": 0, "SPC": 0, "PRP": 1, "SFX": 0, "textOnly": 0}
}
```

### 3.2 字段要求

| 字段 | 必填 | 说明 |
|---|---|---|
| type | 是 | `CHR/SPC/PRP/SFX`（仅这四类；其他类型不输出） |
| name | 是 | 规范名，去时间后缀、去多余空白；1–80 字；同 type 下唯一 |
| aliases | 否 | 别名/简称/称谓，去空去重，≤12 个 |
| **description** | **是** | **建卡基本信息/描述定位**：角色定位、场景功能、道具描述、跨集用途等；≤500 字；不写提示词 |
| appearance | 否（建议） | 外观要点：颜色/材质/形状/磨损/标志物等；≤300 字；不写生成提示词 |
| visualNeed | 是 | `reference`（需要资产图）或 `text-only`（文字/声音生成即可） |
| visualNeedReason | 是（PRP/SFX 必须） | 命中规则的简短理由，≤200 字；CHR/SPC 可写「角色定妆/场景空间需一致」 |
| importance | 是 | `lead/support/background`，只影响排序，不替代 visualNeed |
| reusable | 是 | 是否跨集/跨镜可复用 |
| evidence | 是 | ≥1 条本集可定位证据：`{"line": 行号, "quote": 原文}`；无证据不要编造 |
| confidence | 是 | 0–1；≥0.8 直接展示，0.6–0.8 待确认，<0.6 只提示、不进需制作计数 |
| note | 否 | 状态/变化/复用提示；不写提示词 |

- description 写法：角色=定位/身份/外形要点；场景=空间功能/材质/光位；道具=用途/外观/叙事意义；特效=视觉语言/触发条件。它用于资产库建卡，**不是生成提示词**。
- 去重键：`type + normalize(name)`（normalize=去空白+小写）；aliases/description/appearance 并入首次出现项；不同 type 不合并。
- 每类 ≤50 项、name ≤80 字；超限截断并在 `warnings` 说明。
- `stats` 可写各类计数与 `textOnly` 数量（可选，但建议给）。

### 3.3 人类可读清单（由客户端生成，本技能不写）

- 客户端会在分析/刷新后使用既有 `doc-read` + `doc-save` 把侧车/清单合并写入 `素材/资产清单.md`（项目级完整表格；无需新增 METHOD）。
- 本技能**不要**写 `素材/资产清单.md`、不要写其它 md/素材文件；只保证侧车 JSON 含完整 description/appearance/aliases/visualNeed/evidence。
- 客户端表格列：类型 / 名称 / 基本信息 / 是否需资产图 / 匹配状态。

## 4. visualNeed 判定规则（v1）

### 4.1 CHR / SPC

- **CHR 默认 reference**：角色需要定妆/外观一致性。
- **SPC 默认 reference**：场景空间/材质/光位需要一致性（过场/空镜后续再细化）。
- 除非明确只是背景提及、无需任何视觉一致性，才可 text-only；不确定时 reference + 低置信度。

### 4.2 PRP（道具）：命中任一即 reference

- 跨镜/跨集复现、需严格一致；
- 剧情关键 / 需要特写 / 承载叙事信息；
- 外观独特、非日常、品牌/IP、造型复杂；
- 需与人物/场景严格一致（佩戴、手持、互动特写）；
- 剧本给出明确可执行的视觉外观描述。

**普通常见物 → text-only**：碗、手机、钥匙、纸巾、零钱、普通信封、日常杯子等（无特写/无跨镜一致性要求）。

### 4.3 SFX（特效）：命中任一即 reference

- 复杂/非标准视觉特效：能量、法术、定制粒子、变形、风格化光效；
- 跨镜一致性 / 主视觉签名 / 需与角色/场景光效联动；
- 有明确视觉语言/风格要求，且必须由资产图承载。

**普通声音/环境效果 → text-only**：关门声、脚步声、雨、烟、火花、普通光晕、环境底噪等。

> 每项必须写 `visualNeedReason`（规则命中）；普通项不得滥用 reference；`importance` 只影响排序，不替代 visualNeed。

## 5. 执行步骤

1. 读取项目/本集剧本（只读）；记录每项资产首次出现的行号/原文。
2. 识别角色、场景、道具、特效（只列确实需要资产化的项；不要输出泛化词）。
3. 为每项写 `description` 建卡基本信息 + `appearance` 外观要点 + `visualNeed`/reason + `importance`/`reusable`/`confidence`。
4. 去重、合并 aliases/description/appearance、截断超限，生成 `warnings`/`stats`。
5. 写分析侧车：`构想/导演剖析/第NNN集.assets.json`（JSON）；核对返回 path。`素材/资产清单.md` 由客户端生成，本技能不写。）
6. 最终回复只给摘要：本集分析项数、各类数量、需制作（reference）数、文字可生成（text-only）数、warnings；**不贴整段 JSON、不建卡、不写其它文件**。

## 6. 失败/边界

- 侧车/清单写入失败：报告错误，**不得**改用写卡/写提示词/写其它文件，也不自动重试；由用户重试。
- 剧本缺失/为空：报告「无法分析：本集剧本未找到」，不要凭猜测编造。
- 已存在同集侧车：允许用最新分析覆盖**该侧车文件**；清单 md 由客户端合并，本技能不动。
- 不把分析结果写进其它素材清单/文件名（只 `素材/资产清单.md` 这个文件）。
- 本技能只做分析，不生成提示词/图片/视频/音频；提示词与媒体由用户显式「去制作」后交给 drama-asset 制作层。

## 7. 质量自检（写文件前）

- [ ] `schema`、`episode` 与指令一致；
- [ ] 每项有非空 `description`（基本信息）；每个 PRP/SFX 都有 `visualNeed` + `visualNeedReason`；普通项没有滥用 reference；
- [ ] 每项有 evidence≥1（line+quote），没有编造；
- [ ] 同 type+name 已去重；aliases/description/appearance 已合并；
- [ ] 没有调用任何写卡/提示词/媒体/剧本工具；
- [ ] 只写 `构想/导演剖析/第NNN集.assets.json` 一个文件；不写 md/其它文件。
