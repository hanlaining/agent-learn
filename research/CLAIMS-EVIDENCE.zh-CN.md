# God-Agent Research Artifact v0.1 Claim–Evidence Matrix

> 状态：RRA-03 已完成审稿，等待总控冻结 Artifact
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
| CLM-M01 | 固定 seed 的协议级 GATE Runner 可生成四个变体的报告，并执行运行时 Schema 与确定性检查。 | 确定性 scenario generator、协议参考状态机、`validateBenchmarkReport`、字节级双跑比较 | `npm run test:benchmarks`；`npm run benchmark:gate30` | `research/benchmarks/results/gate-30-seed-20260818/{report.json,summary.csv,cases.csv,repro/**}` | E2 / B | 只验证协议模型；延迟是逻辑值，成本是固定比较费率，不代表真实系统。2026-08-20 临时复跑退出码 0。 |
| CLM-M02 | 在当前协议 fixture 中，移除 WAL、恢复或 lease 会出现预注册方向的退化。 | `baseline`、`no-wal`、`no-recovery`、`no-lease` 使用同一批配对 case；Runner 汇总重复调用、重复效果、恢复率和未知结果 | `npm run test:benchmarks` 中“消融方向性”测试；GATE-30/100 Runner | 对应 `report.json`、`cases.csv` 与所有失败 `repro/*.json` | E2 / GATE-30 为 B，旧 GATE-100 为 C | 当前只有描述统计；没有置信区间、显著性检验、外部系统基线或真实故障分布，不能外推因果强度与外部有效性。 |
| CLM-M03 | 协议 GATE-30 的新复跑可重建旧摘要所列报告哈希。 | 固定 fixture seed、确定性序列化 | `npm run benchmark:gate30`；`Get-FileHash -Algorithm SHA256 .../report.json` | 新复跑 `report.json` 与环境记录 | E2 / B | 2026-08-20 临时复跑得到 `A120...DE59`；这不恢复 2026-08-18 原始文件的保管链，也不证明旧 CSV/repro 就是同一批文件。 |
| CLM-I01 | Runtime-E2E Runner 直接实例化列明的生产 Runtime 类，并在 baseline 用例中重载真实 JSON 状态。 | `AgentLoop`、Stores、`WorkflowTeamCoordinator`、`JsonFileRuntimePersistence`、`PersistentRuntimeLeaseStore` 等生产接线；`protocolSimulatorUsed=false` 校验 | `npm run test:runtime-e2e`；`npm run benchmark:runtime-e2e:gate30` | `research/runtime-e2e-benchmarks/results/gate-30-seed-20260819/{report.json,summary.csv,cases.csv,repro/**}` | 机制 E2 / 旧报告 C、新复跑 B | 仍使用 Fake Provider 与 Fake Tool；不覆盖真进程故障、外部服务副作用或真实吞吐。旧摘要的原始报告缺失；RRA-04 修复后当前参考环境连续复跑通过，更广环境仍需干净环境复核。 |
| CLM-I02 | 历史摘要记录 Runtime-E2E baseline 在 30 条 fixture 上满足预注册的生产状态不变量。 | baseline 状态判定、真实 JSON 写入/重载、报告 Schema | `npm run test:runtime-e2e` 的 baseline 断言；Runtime-E2E GATE-30 | 原始 `report.json`、逐例 `cases.csv`、环境记录 | E2 / 旧报告 C、新复跑 B | 2026-08-19 摘要记录 30/30，但旧原始文件当前缺失；2026-08-20 首次同命令失败、第二次通过的负结果已由 RRA-04 定位并修复，总控随后连续两次复跑通过。新输出仍不能恢复旧来源链。 |
| CLM-I03 | Runtime-E2E 消融在当前 fixture 中通过真实接线变化产生方向性退化。 | `no-wal` 绕过 WAL、`no-recovery` 停用恢复入口、`no-lease` 绕过 Lease/Fencing | `npm run test:runtime-e2e` 的消融断言；Runtime-E2E GATE-30 | 四变体 `report.json`、`cases.csv`、失败 `repro/*.json` | 机制 E2 / 旧报告 C、新复跑 B | 只能说明当前 fixture 和接线；旧数字缺原始文件。路径导致的确定性反例已修复且当前参考环境连续复跑通过，但冻结前仍须保存新原始报告并完成干净环境复核。 |
| CLM-I04 | Snapshot 族的 `unknownOutcome` 表示系统安全暴露不确定状态，而不是请求完成。 | 启动恢复把 `submitted`/`executing` 状态标为需要显式处理，并阻止盲目重放 | `tests/runtime-e2e-gate-test.ts` baseline 与 Schema 断言；Runtime-E2E `cases.csv` | Snapshot 逐例记录、状态文件、失败/处置记录 | E2 / C | `unknownOutcome` 率不能与成功率混写，也不能被删除；真实不可查询外部副作用仍需单独实验。 |
| CLM-I05 | Runtime-E2E 曾出现间歇性确定性失败；该负结果的根因已定位并修复，当前参考环境连续复跑通过。 | `mkdtemp` 随机 `caseDirectory` 曾进入 `SnapshotConflictError.message` 和 `recoveryResult`；现于 `executeRuntimeE2eScenario` 异常记录源头将原生/正斜杠目录规范化为 `<case-directory>`，且 `deterministicProjection` 继续保留 `recoveryResult` | `npm run test:runtime-e2e`；`npm run benchmark:runtime-e2e:gate30`；异常规范化与固定失败 case 的连续三次投影测试 | 首次失败日志、RRA-04 修复测试、员工验证输出、总控连续两次通过输出、环境记录 | E2 已修复负结果 / B | 首次约 15.106 秒退出 1、第二次约 20.4 秒退出 0 的历史记录不得删除。修复保留 `snapshot_conflict`、`SnapshotConflict`、generation、`runtime-state.json`、`taskSuccess=false` 和全部安全/恢复指标；员工专项 10/10 与 GATE-30 通过，总控连续两次 GATE-30 均退出 0 且 `deterministicOutcomesVerified=true`。最终冻结前仍为 B，更广环境需干净环境复核。 |
| CLM-I06 | 全量主测试曾出现一次无法定位的 481/482，之后立即复跑和员工顺序三轮均为 482/482；当前只能表述为“未再次复现的未知 flake”。 | 无已确认机制或根因；仅有统一全量入口、完整 TAP 捕获、Process #387 与残留进程检查 | `npm test`；员工顺序三轮完整输出检查 | 首次 481/482 汇总、工具截断说明、立即 482/482、三轮完整 TAP 与耗时、exit code、Process #387、无残留记录 | E2 未解释负结果 / B | 首失败详情已丢失，不能臆造失败用例或根因，不能写成已修复。员工三轮耗时 20.989/21.327/23.675 秒，均 exit 0、482/482，完整 TAP 无 `not ok`/`error`/`stack`，Process #387 均 `ok`；本轮重复样本 0/3 失败。允许完整披露风险后进入 baseline，若再现必须重新打开门禁。 |
| CLM-P01 | 一个固定 seed 的 Team Workflow Return 进程实验可观察到真实 App Server PID 更换、文件/RPC 重载和最终恢复。 | `AppServerClient` 启动真子进程、`SIGKILL`、三代 PID、真实 JSON/Lease 文件、公共 RPC 与原始文件双重检查；运行时校验器与 JSON Schema 限定报告口径 | `npm exec -- tsx --test research/runtime-e2e-benchmarks/tests/process-chaos-gate-test.ts`；`npm exec -- tsx research/runtime-e2e-benchmarks/src/process-chaos-cli.ts --seed gate40-seed-1 --output research/runtime-e2e-benchmarks/results` | v0.1 公共包绑定 `process-chaos-report.json`、`runtime-leases.json`、运行日志、环境与限制记录；raw `runtime-state.json` 排除并由 Runner 在复核机重建 | 窄范围 E3 / B | 当前科研矩阵仅 1/40；GATE-40 未完成。raw state 因本机绝对计划路径未公开冻结，无法从公开包独立重查全部原始状态细节，Claim 相应降级；没有覆盖 Dynamic 双实例全部边界、跨主机、真实外部 Tool 或真实 Provider。 |
| CLM-P02 | 在该固定窗口与 seed 中，Fake Provider 的 `return_god` 请求计数为 1。 | Return delivery fault point、持久 Lease 等待、恢复后 consume、Fake Server 分阶段计数 | Process Harness 断言 `providerRequestsByStage.return_god === 1` | Process 报告中的 PID、window 与 request-count 字段 | 窄范围 E3 / B | 这是单一窗口的局部观测，不构成系统级唯一执行语义证明，也不能覆盖其余提交边界。 |
| CLM-P03 | Process Harness 不使用真实模型 Provider。 | 仅绑定 `127.0.0.1` 的 Fake Responses Server；子进程接收测试占位 Key 与本机 URL | Process CLI；Process Harness 测试 | Process 报告、命令记录、Provider 使用声明 | E3 运行条件 / B | 仍会使用本机 TCP 与子进程；“真实进程”不等于“真实 Provider”。不得归档用户环境变量值。 |
| CLM-P04 | Process Chaos 专项曾出现 fault point 持久化等待超时；根因已定位并修复，员工连续四轮 2/2、总控独立复验 2/2。 | 执行前预注册状态观察器；`fs.watch` 事件驱动加 250ms 低频读取兜底；Provider 等待绑定 `response.end` flush；45 秒 fault point/30 秒 response 窗口；超时携带事件、读取、最终状态和错误诊断 | Process Chaos 专项测试；`npm run check`；总控独立复验 | 首次 1/2、立即复跑 2/2、根因/代码差异、员工四轮 2/2、总控单轮 2/2、check 与无残留记录 | 窄范围 E3 已修复负结果 / B | 根因是过晚启动的 10ms 高频 8MB 状态解析与未 flush 的约 2MB 响应、Windows 原子写盘争用，导致 20 秒偶发超时。总控复验正向约 32.5 秒且无残留；不得删除首失败、不得写成跨 Windows/Node 普适稳定；仍待 baseline/Artifact/同机干净副本最终冻结。 |
| CLM-A01 | Manifest CLI 可检测 Artifact 文件缺失、篡改和未声明多余文件，并拒绝正文中的绝对本机路径与高置信 GitHub Token。 | RRA-01 `create`/`verify`、SHA-256、确定性排序、规范序列化、路径与敏感正文检查 | `npx tsx --test research/reproducibility/tests/manifest-test.ts`；`npx tsx research/reproducibility/src/cli.ts create ...`；同入口 `verify ...` | `artifact-manifest.json`、环境元数据、正负向 verify 日志 | E2 / B | 总控独立复验 9/9 通过；CLI 已存在，但最终三层原始输出尚未组成冻结包。Process 报告的两个文件路径字段已固定为安全相对路径，并由运行时校验器与 JSON Schema 约束；冻结包仍需最终 verify。 |
| CLM-A02 | 旧结果摘要中存在报告哈希字符串，但对应旧原始文件当前无法从工作区取得。 | 摘要 Markdown 与 `results/` 文件盘点 | 只读检查 `research/*/RESULTS.zh-CN.md` 和 `results/` | 两份旧摘要；当前目录清单 | E1 / C | 无法仅凭摘要复核旧 JSON/CSV/repro。协议 GATE-30 的新同哈希复跑只能算重建匹配，不能替代旧来源链。 |
| CLM-R01 | Research Artifact v0.1 已具备仓库内复现 SOP 与 Claim 审稿规则。 | 本 SOP、Claim Matrix、失败与干净环境模板 | 文档审查；逐条验证入口真实性 | `research/REPRODUCIBILITY.zh-CN.md`、本文 | E1 / B | 只有文档存在不等于复现完成；仍需 baseline Commit、公开原始输出、三层 Manifest 和同机干净源码副本记录。外部第三方复现仍未完成且不作为本次 PR 前置。 |
| CLM-R02 | 已有检查不调用真实模型 Provider。 | 三个 Runner 的 mock/Fake 接线、Runtime 报告字段与测试断言 | 三个最小复现入口及对应测试 | 各报告 methodology/Provider 字段、Process 使用声明、环境记录 | Model/Implementation 为 E2，Process 条件为窄范围 E3 / B-C | 结论仅限这些入口。依赖安装网络和本机 Fake HTTP 不属于真实模型调用，但必须分别记录。 |

## 3. 旧摘要与当前 Artifact 状态

| 记录 | 摘要中的 SHA-256 | 旧原始文件当前状态 | 当前可接受结论 |
|---|---|---|---|
| 协议 GATE-30 | `A120F84C3454F57B08DEFCD466BD88BA23D9DCB671DF6E67D0141E0EC475DE59` | 缺失 | 2026-08-20 新临时复跑得到相同报告哈希；旧运行来源链仍不可独立核验 |
| 协议 GATE-100 | `31EC316155B4B06599A7E1712F35D1CD17C894C1F8DD8850E78243A43358DC72` | 缺失 | 只能引用为旧摘要记录；本轮未重建 |
| Runtime-E2E GATE-30 | `152BB16FDF3CB27EDE9B4E542933C9A770198BDE29016DE3C95379BDAC5F14F4` | 缺失 | 只能引用为旧摘要记录；后续间歇性失败的根因已定位并修复，员工验证与总控连续复跑均通过，但这些新结果不能恢复旧来源链 |

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
- “GATE-40 未完成；baseline Commit、同机干净源码副本复现和冻结 Manifest 尚待总控集成验收。”
- “外部第三方无指导复现尚未完成，属于 R4/E4 后续目标，不是本次 PR 前置。”
- “旧摘要哈希对应的旧原始文件当前缺失；新复跑必须作为新的 Artifact 归档。”
- “全量测试曾有一次详情丢失的 481/482，之后四次连续 482/482；该 flake 未定位、未修复，作为显式风险进入 baseline。”

任何超出以上范围的结论，都必须先新增对应机制、测试、原始 Artifact、独立复核与统计证据，再更新本矩阵。
