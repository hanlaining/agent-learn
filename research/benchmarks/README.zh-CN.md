# God-Agent GATE-30 / GATE-100 离线科研基准

## 1. 研究目标与诚实边界

本基准研究三个问题：运行时在故障后能否完成任务、能否避免重复模型调用与重复工具副作用、完成结论是否有足够证据。GATE-30 是普通开发机上的快速门禁；GATE-100 是固定 seed、可分片、可导出论文表格的正式离线基准。

当前实现是**协议级确定性故障注入基准**，用于比较 WAL、恢复和 lease 语义，不是对真实 Provider 或生产部署的端到端压测。模型由确定性 mock 替代；`latencyMs` 是逻辑模拟延迟；token 来自固定场景；成本是 token 乘 fixture 中锁定的比较费率，不是供应商账单。任何论文或汇报必须保留这些限定。

## 2. 实验设计

固定 fixture 把用例平均分成五类：

| 类别 | 注入与观测重点 |
|---|---|
| crash-recovery | 在模型结果或工具结果边界崩溃，检查 checkpoint 恢复 |
| parent-child | 父等待多个子任务时崩溃或竞争，检查聚合与重复执行 |
| duplicate-delivery | 同一输入重复投递 1–3 次，检查幂等去重 |
| side-effect-safety | 工具已产生副作用但确认前崩溃，检查重复效果和未知结果 |
| completion-quality | 需要 3–5 项证据，检查失败后的证据覆盖率 |

四个配置在完全相同的 case、seed 和费率上运行：

- `baseline`：WAL、恢复、lease 全部启用。
- `no-wal`：关闭持久调用/效果收据与 checkpoint 去重，保留恢复和 lease。
- `no-recovery`：保留 WAL 与 lease，但故障后不恢复。
- `no-lease`：保留 WAL 与恢复，但允许同一工作被并发 worker 执行。

这三项消融只改变保护机制，不改变 fixture。预注册的方向性假设是：无 WAL 会增加重放和未知副作用；无恢复会降低故障样本的恢复成功率与证据完整性；无 lease 会增加竞争造成的重复调用，并在副作用场景产生重复效果。实际数值必须由 runner 产生，不在文档中预填。

## 3. 指标定义

- `taskSuccess`：任务达到完成态、没有未知副作用、没有重复工具效果、证据完整度为 1 的 case 比例。
- `recoverySuccess`：仅在注入崩溃的 case 中，最终满足 `taskSuccess` 的比例。
- `duplicateModelCalls`：超过场景必要模型调用数的调用总数。
- `duplicateToolEffects`：同一逻辑副作用发生超过一次的总数；它不是普通 tool call 数。
- `unknownOutcomeRate`：无法确认副作用最终状态的 case 数 / 当前 case 总数。
- `evidenceCompleteness`：逐 case 的 `evidenceProduced / evidenceRequired` 的算术平均值。
- `p50/p95 latency`：确定性逻辑延迟的 nearest-rank 分位数，单位毫秒。
- `tokens/cost estimate`：包含重复调用在内的输入/输出 token 总数，以及 fixture 固定费率估算。

JSON 报告由 `schema/benchmark-result.schema.json` 描述，并在写盘前通过同版本运行时校验器。CSV 同时输出逐配置摘要和逐 case 数据。

## 4. 运行方法

在仓库根目录执行：

```powershell
npm run benchmark:gate30
npm run benchmark:gate100
```

两个命令默认先做字节级确定性复跑，再写入 `research/benchmarks/results/gate-*-seed-*`。GATE-100 可分片：

```powershell
npm run benchmark:gate100 -- --shard 1/4
npm run benchmark:gate100 -- --shard 2/4
npm run benchmark:gate100 -- --shard 3/4
npm run benchmark:gate100 -- --shard 4/4
```

分片规则为 `caseIndex % total == index - 1`，因此固定 shard 总数时不重不漏。正式论文表格建议同时保留一次未分片全量运行的 `summary.csv`；分片报告适合并行检查与复现单 case。

只运行一个消融或改输出目录：

```powershell
npm run benchmark:gate100 -- --variant no-wal --out D:\temp\gate-no-wal
```

每个失败 case 都会生成 `repro/<variant>-<caseId>.json`，包含 seed、case index、完整 trace、失败码和复跑命令。专项验收入口：

```powershell
npm run test:benchmarks
npm run check
```

## 5. 输出与论文使用

- `report.json`：完整机器可读报告。
- `summary.csv`：每个配置一行，适合论文主表。
- `cases.csv`：每个配置 × case 一行，适合置信区间、配对检验和误差分析。
- `repro/*.json`：所有失败样本的最小复现包。

比较消融时应使用配对分析，因为所有配置共享同一 case。当前 runner 给出描述统计，不自动宣称显著性；论文阶段可对 `cases.csv` 做 bootstrap 置信区间或 McNemar 配对检验，并记录脚本版本。

## 6. 威胁与局限

1. 确定性 mock 的可重复性很高，但没有覆盖真实网络抖动、Provider 限流、内容随机性和计费变化。
2. 逻辑延迟用于比较机制开销，不能外推为生产 p50/p95；真实延迟需另建受控在线实验。
3. 协议级状态机验证的是保护机制语义，不等于 Electron、App Server、持久化文件和真实工具的全链路证明。
4. 五类场景目前等权，可能不同于生产故障分布；报告总体均值时必须说明该权重。
5. 成本采用固定比较费率，只能用于配置间相对比较。
6. 当前没有自动统计置信区间，也没有多机器性能校准；正式论文需要补充独立统计分析。
7. 基准 fixture 与实现同仓库，存在针对基准优化的风险；应保留隐藏扩展集或由外部研究者新增 seed 复核。

## 7. 扩展约束

新增场景必须提高 `generatorVersion` 或新增 fixture schema，不能静默改变既有 GATE-30/GATE-100。真实 Provider 实验必须使用单独命令、显式授权与独立输出目录，不能覆盖本离线基线。
