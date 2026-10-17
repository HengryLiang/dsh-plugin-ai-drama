---
name: drama-export
description: 导出短剧项目交付物：Markdown 全本、JSON 结构化包、CSV 拍摄用分镜表。用于交付给拍摄/剪辑团队或归档。
disable-model-invocation: false
user-invocable: true
---
# 导出交付（Drama Export）

## 三种格式的用途

| 格式 | 产物 | 给谁 |
|---|---|---|
| `markdown` | `导出/<剧名>-全本.md` | 通读、评审、存档 |
| `json` | `导出/<剧名>.json` | 二次加工、迁移到其他工具 |
| `csv` | `导出/<剧名>-分镜表.csv` | 拍摄现场、剪辑对表 |

## 前置检查

导出前**必须先** `drama_check_consistency`。带着 error 级问题导出的交付物会直接把问题带到拍摄现场。

## 步骤

1. `drama_check_consistency` → 有问题先报告，并问用户是「先修再导」还是「带着问题导」。
2. `drama_export`（`format` 三选一，通常三个都导）。
3. 回报每个产物的**绝对路径**与字节数，并说明 CSV 是 UTF-8 with BOM（Excel 可直接打开）。

## 注意

- 导出目录在项目内 `导出/`，属于可见节点，用户可以自行取用。
- 不要修改源数据来完成「导出」，导出是只读操作。
