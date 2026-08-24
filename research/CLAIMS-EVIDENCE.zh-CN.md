# God-Agent Research Artifact v0.1 Claim–Evidence Matrix

> 状态：baseline、三层 Frozen Artifact 与同机干净副本复现已完成；本提交即 artifact Commit，Push 与 PR 更新以外部页面为准
> 原则：每个 Claim 必须回到机制、测试、原始 Artifact、证据等级和限制；无法回到原始文件的数字不得作为冻结科研结论

## 1. 审稿口径

### 1.1 证据等级

| 等级 | 本矩阵采用的含义 |
|---|---|
| E0 | 想法、计划、尚未落地的集成项 |
| E1 | 源码或文档事实存在，或静态检查通过 |
| E2 | 单元/集成测试可重复执行并验证断言 |
| E3 | 生产组装、本机真实文件或真子进程的窄范围 E2E 检查 |
| E4 | 冻结版本、外部复核、重复实验与统计分析共同成立 |

### 1.2 Artifact 可用性

| 标记 | 含义 |
|---|---|
| A | 原始文件已进入冻结包，Manifest verify 通过 |
| B | 当前入口可生成，或仅有本机临时复跑；尚未进入冻结包 |
| C | 只有摘要/哈希字符串，旧原始文件缺失 |
| D | 计划或集成占位项，当前没有可执行证据 |

证据等级与可用性必须同时报告。例如，机制可能已有 E2 测试，但旧报告仍可能是 C；这不能被写成第三方已复核。

## 2. Claim–Evidence Matrix

| Claim ID | 当前允许的最小表述 | 机制 | 测试/复现入口 | 应绑定 Artifact | 等级 / 可用性 | 限制与当前裁决 |
|---|---|---|---|---|---|---|
| CLM-M01 | 固定 seed 的协议级 GATE Runner 可生成四个变体的报告，并执行运行时 Schema 与确定性检查。 | 确定性 scenario generator、协议参考状态机、`validateBenchmarkReport`、字节级双跑比较 | `npm run test:benchmarks`；`npm run benchmark:gate30` | Frozen Model Artifact：34 files，Manifest `E9C42754...4B2EA3` | E2 / A | 只验证协议模型；Clean Report SHA 与 Frozen Report `A120F84C...DE59` 相同，不代表真实系统。 |
| CLM-M02 | 在当前协议 fixture 中，移除 WAL、恢复或 lease 会出现预注册方向的退化。 | `baseline`、`no-wal`、`no-recovery`、`no-lease` 使用同一批配对 case；Runner 汇总重复调用、重复效果、恢复率和未知结果 | `npm run test:benchmarks` 中“消融方向性”测试；GATE-30/100 Runner | Frozen Model `report.json`、`cases.csv` 与失败 `repro/*.json` | E2 / GATE-30 为 A，旧 GATE-100 为 C | 当前只有描述统计；没有置信区间、显著性检验、外部系统基线或真实故障分布。 |
| CLM-M03 | 协议 GATE-30 的新复跑可重建旧摘要所列报告哈希。 | 固定 fixture seed、确定性序列化 | `npm run benchmark:gate30`；`Get-FileHash -Algorithm SHA256 .../report.json` | Frozen 与 Clean `report.json` | E2 / A | Frozen 与 Clean 均得到 `A120...DE59`；这不恢复 2026-08-18 旧文件的保管链。 |
| CLM-I01 | Runtime-E2E Runner 直接实例化列明的生产 Runtime 类，并在 baseline 用例中重载真实 JSON 状态。 | `AgentLoop`、Stores、`WorkflowTeamCoordinator`、`JsonFileRuntimePersistence`、`PersistentRuntimeLeaseStore` 等生产接线；`protocolSimulatorUsed=false` 校验 | `npm run test:runtime-e2e`；`npm run benchmark:runtime-e2e:gate30` | Frozen Runtime Artifact：46 files，Manifest `F793FF5A...0BB7F2` | 机制 E2 / 新复跑 A | Clean 与 Frozen deterministic projection 相同；仍使用 Fake Provider/Tool，不覆盖真实吞吐或外部副作用。 |
| CLM-I02 | 历史摘要记录 Runtime-E2E baseline 在 30 条 fixture 上满足预注册的生产状态不变量。 | baseline 状态判定、真实 JSON 写入/重载、报告 Schema | `npm run test:runtime-e2e` 的 baseline 断言；Runtime-E2E GATE-30 | Frozen Runtime `report.json`、逐例 `cases.csv` | E2 / 旧报告 C、新复跑 A | 旧原始文件缺失；新 Frozen/Clean 结果不能恢复旧来源链。 |
| CLM-I03 | Runtime-E2E 消融在当前 fixture 中通过真实接线变化产生方向性退化。 | `no-wal` 绕过 WAL、`no-recovery` 停用恢复入口、`no-lease` 绕过 Lease/Fencing | `npm run test:runtime-e2e` 的消融断言；Runtime-E2E GATE-30 | Frozen 四变体报告、cases 与失败 repro | 机制 E2 / 旧报告 C、新复跑 A | 只能说明当前 fixture 和接线；Clean 与 Frozen deterministic projection 相同。 |
| CLM-I04 | Snapshot 族的 `unknownOutcome` 表示系统安全暴露不确定状态，而不是请求完成。 | 启动恢复把 `submitted`/`executing` 状态标为需要显式处理，并阻止盲目重放 | `tests/runtime-e2e-gate-test.ts` baseline 与 Schema 断言；Runtime-E2E `cases.csv` | Snapshot 逐例记录、状态文件、失败/处置记录 | E2 / C | `unknownOutcome` 率不能与成功率混写，也不能被删除；真实不可查询外部副作用仍需单独实验。 |
| CLM-I05 | Runtime-E2E 曾出现间歇性确定性失败；该负结果的根因已定位并修复，当前参考环境连续复跑通过。 | `mkdtemp` 随机 `caseDirectory` 曾进入 `SnapshotConflictError.message` 和 `recoveryResult`；现于 `executeRuntimeE2eScenario` 异常记录源头将原生/正斜杠目录规范化为 `<case-directory>`，且 `deterministicProjection` 继续保留 `recoveryResult` | `npm run test:runtime-e2e`；`npm run benchmark:runtime-e2e:gate30`；异常规范化与固定失败 case 的连续三次投影测试 | 首次失败日志、RRA-04 修复测试、员工验证输出、总控连续两次通过输出、环境记录 | E2 已修复负结果 / B | 首次约 15.106 秒退出 1、第二次约 20.4 秒退出 0 的历史记录不得删除。修复保留 `snapshot_conflict`、`SnapshotConflict`、generation、`runtime-state.json`、`taskSuccess=false` 和全部安全/恢复指标；员工专项 10/10 与 GATE-30 通过，总控连续两次 GATE-30 均退出 0 且 `deterministicOutcomesVerified=true`。最终冻结前仍为 B，更广环境需干净环境复核。 |
| CLM-I06 | 全量主测试曾出现一次无法定位的 481/482，之后立即复跑和员工顺序三轮均为 482/482；当前只能表述为“未再次复现的未知 flake”。 | 无已确认机制或根因；仅有统一全量入口、完整 TAP 捕获、Process #387 与残留进程检查 | `npm test`；员工顺序三轮完整输出检查 | 首次 481/482 汇总、工具截断说明、立即 482/482、三轮完整 TAP 与耗时、exit code、Process #387、无残留记录 | E2 未解释负结果 / B | 首失败详情已丢失，不能臆造失败用例或根因，不能写成已修复。员工三轮耗时 20.989/21.327/23.675 秒，均 exit 0、482/482，完整 TAP 无 `not ok`/`error`/`stack`，Process #387 均 `ok`；本轮重复样本 0/3 失败。允许完整披露风险后进入 baseline，若再现必须重新打开门禁。 |
| CLM-P01 | 一个固定 seed 的 Team Workflow Return 进程实验可观察到真实 App Server PID 更换、文件/RPC 重载和最终恢复。 | `AppServerClient` 启动真子进程、`SIGKILL`、三代 PID、真实 JSON/Lease 文件、公共 RPC 与原始文件双重检查；运行时校验器与 JSON Schema 限定报告口径 | Process 专项与 Runner | Frozen Process Artifact：3 files，Manifest `6837D695...18384C`；raw state 排除 | 窄范围 E3 / A | Clean 与 Frozen 语义投影相同；仍仅 1/40。公开包不能独立重查 raw state 全部细节，不覆盖 Dynamic 全边界、跨主机或真实 Provider。 |
| CLM-P02 | 在该固定窗口与 seed 中，Fake Provider 的 `return_god` 请求计数为 1。 | Return delivery fault point、持久 Lease 等待、恢复后 consume、Fake Server 分阶段计数 | Process Harness 断言 `providerRequestsByStage.return_god === 1` | Frozen Process report | 窄范围 E3 / A | 单一窗口局部观测，不构成系统级唯一执行语义证明。 |
| CLM-P03 | Process Harness 不使用真实模型 Provider。 | 仅绑定 `127.0.0.1` 的 Fake Responses Server；子进程接收测试占位 Key 与本机 URL | Process CLI；Process Harness 测试 | Frozen Process report 与 Manifest Provider 声明 | E3 运行条件 / A | 仍使用本机 TCP 与子进程；“真实进程”不等于“真实 Provider”。 |
| CLM-P04 | Process Chaos 专项曾出现 fault point 持久化等待超时；根因已定位并修复。 | 预注册 `fs.watch` 观察、250ms 兜底、response flush 与增强诊断 | Process 专项、总控复验、Frozen/Clean 对比 | 首次失败、修复证据与 Frozen/Clean 语义投影 | 窄范围 E3 已修复负结果 / A | 员工四轮和总控单轮均 2/2，Frozen/Clean 语义投影相同；仍不得写成跨环境稳定。 |
| CLM-A01 | Manifest CLI 可检测 Artifact 文件缺失、篡改和未声明多余文件，并拒绝正文中的绝对本机路径与高置信 GitHub Token。 | RRA-01 `create`/`verify`、SHA-256、确定性排序、规范序列化、路径与敏感正文检查 | Manifest 9/9；三层 create/verify；Clean verify | 三个 Frozen `artifact-manifest.json` | E2 / A | 三层 Manifest 已绑定同一 baseline 并 verify。Clean Process 首次非 canonical 日期被正确拒绝，规范 UTC 后通过。 |
| CLM-A02 | 旧结果摘要中存在报告哈希字符串，但对应旧原始文件当前无法从工作区取得。 | 摘要 Markdown 与 `results/` 文件盘点 | 只读检查 `research/*/RESULTS.zh-CN.md` 和 `results/` | 两份旧摘要；当前目录清单 | E1 / C | 无法仅凭摘要复核旧 JSON/CSV/repro。协议 GATE-30 的新同哈希复跑只能算重建匹配，不能替代旧来源链。 |
| CLM-R01 | Research Artifact v0.1 已具备仓库内复现 SOP、Claim 审稿规则和同机干净副本记录。 | 本 SOP、Claim Matrix、Frozen Artifact、Clean Record | 文档审查；三层 verify；Clean 对比 | `research/artifacts/v0.1/` | E2 / B | baseline/Artifact/Clean 已完成，本提交即 artifact Commit。外部第三方复现未完成，不构成 E4。 |
| CLM-R02 | 已有检查不调用真实模型 Provider。 | 三个 Runner 的 mock/Fake 接线、报告与 Manifest Provider 声明 | 三个最小复现入口及对应测试 | 三层 Frozen Artifact 与 Clean Record | Model/Implementation 为 E2，Process 条件为窄范围 E3 / A | 结论仅限这些入口。`npm ci` 安装 101 packages 与本机 Fake HTTP 不属于真实模型调用。 |
| CLM-R03 | baseline 的同机干净源码副本可以重建三层可核对结果。 | `git archive` 干净起点、固定依赖、三层 Runner、Manifest verify、分层比较 | check、Manifest 9/9、Model/Runtime/Process Runner | `research/artifacts/v0.1/CLEAN-REPRODUCTION.md` | E2 / B | Model report SHA 相同，Runtime deterministic projection 相同，Process 语义投影相同。不是外部第三方、跨主机或 E4。 |
| CLM-R04 | Clean Process Manifest 曾因 PowerShell 日期类型转换被 canonical ISO 校验拒绝，规范 UTC 后通过。 | `ConvertFrom-Json` 的 `DateTime` 自动转换；显式 `ToUniversalTime()` 与 canonical 格式化 | Clean Manifest create/verify | Clean 复现记录中的首次失败与人工修正 | E2 操作负结果 / B | 属于复现辅助脚本问题，不是 Runtime 或 Manifest 校验器缺陷；不得删除首失败。 |

## 3. 旧摘要与当前 Artifact 状态

| 记录 | 摘要中的 SHA-256 | 旧原始文件当前状态 | 当前可接受结论 |
|---|---|---|---|
| 协议 GATE-30 | `A120F84C3454F57B08DEFCD466BD88BA23D9DCB671DF6E67D0141E0EC475DE59` | 旧原始文件缺失；新 Frozen/Clean 文件存在 | Frozen 与 Clean Report 得到相同哈希；旧运行来源链仍不可独立核验 |
| 协议 GATE-100 | `31EC316155B4B06599A7E1712F35D1CD17C894C1F8DD8850E78243A43358DC72` | 缺失 | 只能引用为旧摘要记录；本轮未重建 |
| Runtime-E2E GATE-30 | `152BB16FDF3CB27EDE9B4E542933C9A770198BDE29016DE3C95379BDAC5F14F4` | 旧原始文件缺失；新 Frozen/Clean 文件存在 | 新 Frozen Report SHA 为 `8F16...F2563`，Clean deterministic projection 相同；不能恢复旧来源链 |

最终冻结包应给“新复跑”分配新的运行 ID、环境记录和 Manifest 条目，不得把新文件回填成旧运行的原始文件。

## 4. Claim 接受与降级规则

一个 Claim 只有同时满足下列条件，才能进入最终摘要：

1. 机制与源码入口在冻结版本中存在；
2. 对应测试或复现命令在该版本中真实存在；
3. 命令退出码为 0，或 Claim 本身是已记录的失败反例；
4. 原始 Artifact 存在并通过 Schema/运行时校验；
5. RRA-01 集成后，Manifest verify 通过；
6. Provider 类型、环境、seed、变体、耗时和人工介入完整记录；
7. 限制文本与 Claim 一同呈现。

出现以下任一情况必须降级或撤回：

- 只剩摘要或哈希字符串，原始文件缺失；
- 确定性检查失败；
- 使用不同 seed/fixture 却沿用旧数字；
- Process 结果被外推到未测试的 39 个矩阵用例；
- `unknownOutcome`、失败 repro 或人工介入被删除；
- 使用真实 Provider 却仍标为离线 Fake；
- Manifest 缺失、验证失败或文件被篡改；
- 将本机墙钟结果解释为真实 Provider 性能、生产容量或外部普适性。
- 用后续复跑成功覆盖 NEG-011 首次未知失败，或在没有失败详情和根因时写成“已修复”。

## 5. 对外表述边界

推荐只使用以下口径：

- “协议级确定性故障注入基准可比较 WAL、恢复与 lease 机制。”
- “生产实现检查直接运行列明的 Runtime 类并重载真实 JSON，但 Provider 与 Tool 为 Fake。”
- “Team Workflow Return 完成了一个固定 seed 的窄范围 1/40 真进程检查。”
- “当前主要证据为 E2，另有一个严格限定范围的 E3 Process Check。”
- “GATE-40 未完成；baseline、Frozen Artifact 和同机干净源码副本复现已完成，本提交即 artifact Commit；Push/PR 状态以外部页面为准。”
- “外部第三方无指导复现尚未完成，属于 R4/E4 后续目标，不是本次 PR 前置。”
- “旧摘要哈希对应的旧原始文件当前缺失；新复跑必须作为新的 Artifact 归档。”
- “全量测试曾有一次详情丢失的 481/482，之后四次连续 482/482；该 flake 未定位、未修复，作为显式风险进入 baseline。”

任何超出以上范围的结论，都必须先新增对应机制、测试、原始 Artifact、独立复核与统计证据，再更新本矩阵。
