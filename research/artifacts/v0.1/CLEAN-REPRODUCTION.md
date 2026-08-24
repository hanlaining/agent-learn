# God-Agent Research Artifact v0.1 同机干净副本复现记录

## 1. 记录性质与边界

- 复现类型：同一台参考机器上的干净源码副本复现。
- 源码来源：对 baseline Commit `05680a4ecf0f13f7b1b311363732d4922ad9af5b` 执行 `git archive` 后解包。
- 工作目录：`<clean-copy>`。
- 起点约束：副本不含 `.git/`，Model/Runtime 的 `results/` 没有旧载荷，Process 输出目录在执行前不存在。
- Provider：确定性 mock/Fake；真实 Provider 请求数为 0，未读取真实凭据。
- 科研边界：这是内部同机干净副本复现，不是外部第三方无指导复现，不构成 E4、跨主机或跨环境结论。

## 2. 参考环境

| 项目 | 记录值 |
|---|---|
| 操作系统 | Windows `win32` x64，release `10.0.26200` |
| Node.js | `v20.19.0` |
| npm | `10.8.2` |
| 依赖安装 | `npm ci` 成功，安装 101 个包 |
| Baseline Commit | `05680a4ecf0f13f7b1b311363732d4922ad9af5b` |

## 3. Frozen Artifact 基准

| 层级 | Manifest SHA-256 | Report SHA-256 | Manifest 文件数 | 公开范围 |
|---|---|---|---:|---|
| Model Check | `E9C427546A222E7C56D4A912A86E7ACB8876051E6BB26DD6ECCEE0024A4B2EA3` | `A120F84C3454F57B08DEFCD466BD88BA23D9DCB671DF6E67D0141E0EC475DE59` | 34 | `SCOPE.md`、report/CSV、失败 repro |
| Runtime Implementation Check | `F793FF5A9FEE01B3C46AABC3F3FC97865D15DAAACB49CDF205EF71F1B60BB7F2` | `8F16DA17F8571458127FD346BB43E743EE610724EFE6C103CC43DDDC711F2563` | 46 | `SCOPE.md`、report/CSV、失败 repro |
| Process Check | `6837D69593983D01C20D145B4B75204EAE3F4353EA67D7742DC0B7AB3A18384C` | `F11862C8CFA06581658B71922234E2ABAF29083D56535A426205F6E16296CA9C` | 3 | `SCOPE.md`、`process-chaos-report.json`、`runtime-leases.json`；不含 raw `runtime-state.json` |

三个 Frozen Manifest 均绑定同一 baseline Commit。Process 仍只覆盖 Team Workflow Return 的一个固定 seed 和一个真实进程故障窗口，即 1/40。

## 4. 执行步骤与结果

| 顺序 | 命令类别 | 结果 |
|---:|---|---|
| 1 | 环境与依赖 | `npm ci` 成功，安装 101 个包 |
| 2 | 静态检查 | `npm run check` 退出码 0 |
| 3 | Manifest 专项 | 9/9 通过 |
| 4 | Model GATE-30 | Runner 成功，Manifest create/verify 通过 |
| 5 | Runtime-E2E GATE-30 | Runner 成功，确定性检查通过，Manifest create/verify 通过 |
| 6 | Process 专项 | 2/2 通过，无残留 App Server 进程 |
| 7 | 窄范围 Process Runner | 真子进程强杀/恢复检查成功，公开安全子集完成 Manifest create/verify |

## 5. 与 Frozen Artifact 的比较

| 层级 | 比较方式 | 结果 | 解释边界 |
|---|---|---|---|
| Model Check | 对 `report.json` 计算 SHA-256 | Clean Report SHA 与 Frozen Report 完全相同：`A120F84C3454F57B08DEFCD466BD88BA23D9DCB671DF6E67D0141E0EC475DE59` | 支持固定 fixture 下的字节级重建，不外推真实 Provider |
| Runtime Implementation Check | 比较 `deterministicProjection` | Clean 与 Frozen 投影相同 | 报告中的运行时间等环境字段不要求字节相同；Provider/Tool 仍为 Fake |
| Process Check | 比较预注册语义投影 | Clean 与 Frozen 语义投影相同 | 只支持当前固定 seed 的 1/40；不证明完整 GATE-40 |

## 6. 失败与人工修正

### NEG-CLEAN-001：PowerShell 日期类型转换破坏 Manifest 时间参数

- 首次现象：Clean Process Manifest 创建被 canonical ISO 时间校验拒绝。
- 直接原因：复现辅助脚本使用 PowerShell `ConvertFrom-Json` 读取报告时，把 UTC ISO 字符串自动转换成了 `DateTime`；随后传参不再保持 Manifest CLI 要求的 canonical UTC ISO-8601 字符串。
- 人工修正：在传入 create CLI 前，显式调用 `ToUniversalTime()` 并格式化为带三位毫秒和 `Z` 的 canonical UTC ISO-8601 字符串。
- 修正结果：Clean Process Manifest create/verify 通过。
- 裁决：这是复现操作脚本的类型转换负结果，不是 Agent Runtime、Process 恢复协议或 Manifest 校验器缺陷。严格校验正确地拒绝了非规范输入。
- 可复现性影响：该人工修正必须保留在复现记录和后续脚本说明中，不能只记录修正后的成功结果。

## 7. 最终裁决

同机干净副本已从固定 baseline、无 `.git/`、无旧结果载荷的起点完成三层最小复现，并通过各自 Manifest verify。Model 使用 report 字节哈希比较，Runtime 使用确定性投影比较，Process 使用语义投影比较，三者均与 Frozen Artifact 对齐。

仍不能声称：

- 外部第三方已复现或达到 E4；
- Process GATE-40 或完整 E3 已完成；
- 端到端 exactly-once；
- 跨主机、跨 Windows/Node 版本或生产环境稳定；
- NEG-011 已定位或已修复。

本提交将本记录、Frozen Artifact 和持续文档形成 artifact Commit；提交后 Push 并更新 PR。外部第三方复现与统计重复实验继续作为后续工作。
