# God-Agent 考研复试高频追问与回答

> 使用场景：导师追问时先给 30 秒结论；导师继续追问，再展开 90 秒版本。  
> 2026-08-24 最新证据快照（覆盖下文历史数字）：test discovery `113/113`；主测试 `736`，其中 `735pass`、1 skip、0 fail；源码覆盖 `26146/28672 = 91.19%`，加载 `116/122`。  
> 最终正式口径：2026-08-24 当前工作树 test discovery `113/113`；主测试共 736，其中 735 pass、1 个 Windows symlink 权限条件 skip、0 fail。  
> 统一边界：当前正式 `src` 源码行覆盖 `26146/28672 = 91.19%`，源文件加载率 `116/122 = 95.082%`，coverage gate 为 `90.25/93`；GATE-40 candidate 40、local pilot 40 passed / 0 failed / 0 blocked、formal Verified 0、`complete=false`；Process Chaos `17/17`；Provider 离线 `liveCalls=0`；Release Readiness 为 11/12、`BLOCKED`，官方审计 0 critical / 3 high，production 仍 `blocked`；官方总账评分为 `93/90/69/47/68`，五项均未到 95。

## 先记住的回答结构

每个回答按“问题—机制—证据—限制—下一步”组织：

1. 先用一句话回答导师问的结论；
2. 再指出对应机制，而不是只报测试数；
3. 给出证据等级和当前数字；
4. 主动说不能推出什么；
5. 最后给出可执行的下一步。

## 1. 这个项目一句话是什么？

**30 秒回答**

God-Agent 是一个面向单机多 Agent 的可靠性研究原型。我关注的不是“模型能不能多回答几轮”，而是进程崩溃、Owner 切换、工具副作用结果未知时，怎样通过 WAL、Lease/Fencing、Return Receipt 和 `outcome_unknown`，避免重复执行和伪完成。当前主要证据是自动化 E2，另有 40 个本机真进程 local pilot 通过，但 formal Verified 仍为 0、`complete=false`，还不是生产系统。

**90 秒回答**

项目包含 Electron 桌面壳、多 Chat、多 Agent 和持久化 Runtime，但研究核心是可靠性语义。一次模型调用或工具调用可能已经在外部执行，进程却在写回本地状态前崩溃；如果恢复时简单重试，就可能重复扣费、重复发消息或重复写数据。我把调用身份、提交状态、Owner 租约、父子 Return 和人工裁决都建模为可持久化事实，再用故障注入检查它们。当前 test discovery 为 113/113；主测试共 736，其中 735 pass、1 个 Windows symlink 权限条件 skip、0 fail；`src` 行覆盖为 26146/28672，即 91.19%，加载率 116/122 = 95.082%，但这些只说明当前工作树的自动化质量。GATE-40 的 local pilot 为 40 passed、0 failed、0 blocked，formal Verified 仍为 0、`complete=false`；真实 Provider 调用为 0，production 仍 blocked，所以我把它定位成“可运行、可验证、边界清楚的研究原型”。

参考：`README.md`、`research/CLAIMS-EVIDENCE.zh-CN.md`。

## 2. 你解决的核心问题是什么？

**30 秒回答**

核心问题是“外部动作与本地提交之间不存在天然原子性”。失败后系统既不能盲目重放，也不能把没收到结果当成没执行。我的方案把已知成功、已知失败和结果未知分开，并要求完成结论必须有对应证据。

**90 秒回答**

本地数据库事务只能保护本地写入，无法回滚已经发给模型的请求或已经执行的外部工具。危险窗口发生在“外部动作已经发生、本地 Receipt 尚未持久化”之间。God-Agent 用稳定 Invocation ID 和 WAL 保存提交阶段；能查询的外部系统可以查询恢复，不能查询或没有幂等保证的副作用进入 `outcome_unknown`，默认停止自动重放并转人工裁决。同时，Completion Proof 不能把协议安全终止等同于业务完成。这个拆分让系统宁可明确暴露不确定，也不伪造成功。

参考：`research/metrics/METRIC-DICTIONARY-v2.zh-CN.md`、`research/SOP-WORK-PACKAGE-HANDOFF.zh-CN.md`。

## 3. 创新点在哪里？这些机制不是经典机制吗？

**30 秒回答**

WAL、Lease、Fencing、Outbox 都不是我发明的。我当前能主张的是：把这些经典机制按父子 Agent 的 Model、Tool、Return、Proof 边界组合成可检查的状态协议，并显式处理不可查询副作用和误完成。是否达到论文创新，需要相关工作检索、公平外部基线和正式实验，目前不能提前下结论。

**90 秒回答**

我把贡献分成三层。第一层是工程组合：稳定 Invocation ID、Model/Tool WAL、Job Lease/Fencing、Return claim/consume Receipt 和 Snapshot CAS。第二层是语义拆分：`protocolHandlingSuccess`、`businessCompletion`、`completionDecisionValidity`、`outcome_unknown` 和 retrospective false completion 不能混成一个成功率。第三层是证据方法：按故障窗口、seed、Oracle 和 Artifact 记录正负结果。但这些目前主要是项目内设计贡献，不等于学术新颖性已成立。缺少对 LangGraph、Temporal 等外部系统的同任务实测，也缺少第二执行者复现，所以复试中我会说“形成了可检验的研究假设”，而不是“已经证明创新”。

参考：`docs/God-Agent-科研项目/05-论文研究与发表路线.md`、`research/metrics/METRIC-DICTIONARY-v2.zh-CN.md`。

## 4. 为什么普通 Agent Loop 不够？

**30 秒回答**

普通 Loop 重点是“模型—工具—模型”能继续运行，但崩溃后还要回答：这次调用是否已经提交、工具是否产生副作用、谁有权写最终状态、父 Agent 是否消费过 Return。没有持久身份和状态协议，重启后很容易重复执行或误判完成。

**90 秒回答**

在正常路径里，一个循环看起来足够；在故障路径里，内存中的“正在执行”会随进程消失。God-Agent 把调用写成带稳定 ID 的 WAL 状态，把 Job 执行权绑定 Lease 和单调递增的 Fencing Token，把子 Agent Return 写入 Outbox 并由父 Agent以 Receipt 消费。恢复时根据持久事实推进，而不是根据“进程没回复”猜测。不可判定的外部副作用进入 unknown。这些机制增加了复杂度和写放大，所以后续还要用消融和开销指标证明它们在目标威胁模型下是否值得。

参考：`README.md`、`research/REPRODUCIBILITY.zh-CN.md`。

## 5. 你和 LangGraph 有什么区别？

**30 秒回答**

目前只能做概念层比较，不能声称性能或可靠性优于 LangGraph。God-Agent 的研究焦点是调用 WAL、Owner fencing、父子 Return Receipt 和不可查询副作用的 unknown 裁决；LangGraph 是需要纳入公平外部基线的同类编排/持久化框架。双方尚未在同一任务、预算、故障点和 Oracle 下实测。

**90 秒回答**

从项目定位看，LangGraph 更接近图式 Agent 编排与持久化执行生态；God-Agent 当前刻意把研究问题缩到故障窗口中的“谁能提交、外部动作是否可重放、父子结果是否只消费一次、完成是否有证据”。我不能只根据 API 或文档就说自己的方案更可靠。公平比较至少要冻结相同任务、Provider、Token/时间预算、checkpoint、故障注入时刻和业务 Oracle，并分别记录恢复成功、重复副作用、unknown、误完成和开销。目前这个外部基线没有实测，因此正确表述是“研究关注点和协议设计不同，优劣未验证”。

参考：`docs/God-Agent-95plus持续精进总账.md`、`research/paper/CLAIM-TABLE.json`。

## 6. 你和 Temporal 有什么区别？为什么不直接用 Temporal？

**30 秒回答**

Temporal 是成熟的 Durable Execution/Workflow 系统，God-Agent 不是它的替代品。我研究的是 Agent 调用与副作用语义怎样映射到 WAL、Fencing、Return 和 Proof。Temporal 能提供成熟工作流底座，但外部模型或工具是否真正执行仍需要 Activity 幂等、状态查询和业务补偿；当前也没有同条件实测，不能声称优于它。

**90 秒回答**

如果目标是生产落地，我会认真评估直接采用 Temporal 这类成熟系统；自研的价值主要是学习并把 Agent 特有的调用、父子协作和完成证明显式建模。Durable Execution 能重放工作流决策，但无法自动把一个不可查询、不可撤销的外部副作用变成 exactly-once。应用层仍要设计稳定操作 ID、幂等、查询、补偿或 unknown 处置。God-Agent 把这些边界放到研究中心。不过，尚未把相同 workload 和故障矩阵移植到 Temporal，因此只能陈述设计取向，不能陈述相对收益。

参考：`docs/God-Agent-科研项目/05-论文研究与发表路线.md`、`docs/RELEASE-CHECKLIST.md`。

## 7. 没有外部基线，你的结论有意义吗？

**30 秒回答**

有工程和方法价值，但结论上限有限。当前只能说明项目内机制在确定性 fixture 和窄范围真进程窗口中的行为，不能说明优于外部框架。外部基线是论文 95+ 的硬阻断项，不会用内部消融替代。

**90 秒回答**

内部消融能回答“同一实现中去掉 WAL 或 Lease 后，预注册指标是否按预期退化”，这对发现机制缺陷有价值；但它不能回答“比成熟框架更好”。外部比较要避免选择性调参：同任务、同输入、同 Provider、同预算、同故障窗口、同成功 Oracle，并披露各框架最合理的配置。当前尚未完成，因此论文比较性和外部有效性仍不足。我会把已有结果定位为 mechanism validation，而不是 superiority claim。

参考：`research/CLAIMS-EVIDENCE.zh-CN.md`、`research/paper/MANUSCRIPT-DRAFT.zh-CN.md`。

## 8. WAL 在这里具体记录什么？

**30 秒回答**

WAL 记录一次稳定 Invocation 从准备、提交、收到响应/结果到最终提交的持久事实。恢复逻辑依据状态决定复用已收到结果、查询外部状态或进入 unknown，而不是无条件重发。

**90 秒回答**

Model 和 Tool 都有稳定 Invocation ID。以模型为例，状态至少要区分 prepared、submitted、response received 和 committed；工具还要考虑 effect 已发生但 Receipt 未落盘。恢复时，如果响应已持久化，就不再调用 Provider；如果只知道请求已提交且 Provider 无法查询，就不能假设它没执行。WAL 解决的是“本地知道了什么”，不是把远端和本地变成一个事务，所以仍需要 Provider 能力矩阵、幂等键、查询或人工处置。

参考：`README.md`、`docs/provider-capability-smoke.md`。

## 9. 稳定 Invocation ID 就能保证幂等吗？

**30 秒回答**

不能。稳定 ID 只是关联重复尝试的前提；只有外部系统真正接受并按该 ID 去重，或提供可查询状态时，才可能形成端到端幂等。否则它只能帮助本地审计和阻止已知重复。

**90 秒回答**

本地稳定 ID 可以让 WAL、Receipt 和日志指向同一个逻辑动作，也能避免本地重复创建不同身份。但如果 Provider 忽略幂等键，或工具是不可查询副作用，那么两个网络请求仍可能都生效。因此我把“本地调用身份稳定”“Provider 支持幂等”“业务效果唯一”分开验证。当前 Provider smoke 是离线的，`liveCalls=0`，所以没有证据把稳定 ID 外推为真实 Provider exactly-once。

参考：`docs/provider-capability-smoke.md`、`research/metrics/METRIC-DICTIONARY-v2.zh-CN.md`。

## 10. Lease 已经互斥，为什么还需要 Fencing Token？

**30 秒回答**

因为 Lease 过期不等于旧 Owner 立即停止。网络暂停或事件循环阻塞后，旧 Owner 可能恢复并迟到提交；单调递增的 Fencing Token 让权威存储拒绝旧 epoch 的写入。

**90 秒回答**

Lease 解决“当前谁被认为有执行权”，Fencing 解决“旧执行者恢复后还能不能写”。接管者获得更大的 token，所有关键 commit boundary 必须携带 token 并由存储层比较。若只在调度层检查 Lease，而提交层不校验，旧 Owner 仍可能覆盖新状态。项目已有较强 E2 边界测试和一个窗口的真进程 pilot，但 GATE-40 的其余窗口尚未全部接线，因此不能说所有生产提交边界都完成 E3 验证。

参考：`research/rt95-closure/GATE40-WINDOWS.zh-CN.md`、`research/CLAIMS-EVIDENCE.zh-CN.md`。

## 11. `outcome_unknown` 是失败吗？为什么不直接重试？

**30 秒回答**

它不是普通失败，而是“系统无法从现有事实判断外部动作是否成功”。对不可查询、不可安全重放的副作用，自动重试可能制造重复效果，所以默认停下并要求查询、登记外部结果或人工裁决。

**90 秒回答**

`known_failure` 意味着有决定性证据表明动作失败，可以按策略重试；`outcome_unknown` 意味着证据不足。比如发款请求已经到达外部服务，但本地在保存响应前崩溃，此时再次发款可能重复扣款。系统必须根据 observability 和 replay policy 决定：可查询则查询，可幂等则按稳定 ID 重试，否则进入人工流程。安全暴露 unknown 可以算协议处理正确，但不能算业务完成，这也是指标词典把两者拆开的原因。

参考：`research/metrics/METRIC-DICTIONARY-v2.zh-CN.md`。

## 12. 你实现了 exactly-once 吗？

**30 秒回答**

没有。我只主张本地状态协议能减少已知重复、拒绝旧 Owner 提交并暴露未知结果。端到端 exactly-once 还取决于外部 Provider/工具的幂等、查询和事务能力，当前没有相应真实证据。

**90 秒回答**

Exactly-once 是端到端属性，不能由本地 WAL 或一次“调用计数为 1”的测试推出。God-Agent 的局部保证包括：同一 Invocation 使用稳定 ID、已收结果不盲目重放、旧 fencing token 被拒绝、Return 消费记录可审计。对于网络边界外的动作，如果服务端不支持幂等或状态查询，系统只能把不确定性显式化。因此复试中我会用“at-most-once attempt、可恢复本地提交、unknown 安全停止”等具体语义，不会说 exactly-once。

参考：`research/CLAIMS-EVIDENCE.zh-CN.md`、`docs/DEMO-复试三分钟演示.md`。

## 13. 父子 Agent 的 Return 为什么需要 Outbox/Receipt？

**30 秒回答**

子 Agent 完成和父 Agent 收到结果不是同一个原子动作。Return Outbox 保存“结果已准备”，Receipt 保存“父级已 claim/consume”，这样崩溃恢复后能区分未送达、待消费和已消费，避免丢失或重复推进。

**90 秒回答**

如果子 Agent 只通过内存回调返回，任一进程在回调前后崩溃都可能丢结果或重复触发父阶段。持久 Outbox 让结果先成为事实，父 Agent 再带身份 claim，并在消费后留下 Receipt。Lease/Fencing 约束谁能消费和提交。当前 GATE-40 已有 25 个 local pilot passed、0 failed，但仍有 15 个候选 case blocked，formal Verified 为 0、`complete=false`，因此不能把已接线窗口的结果外推到所有 Return 边界。

参考：`research/rt95-closure/GATE40-WINDOWS.zh-CN.md`。

## 14. Completion Proof 是为了解决什么？

**30 秒回答**

它防止把“流程走到终态”误判为“用户目标已经完成”。完成必须回到需求 criterion、最新 revision 和对应证据；缺片、过期、矛盾或 required+blocking unknown 都不能给出有效完成裁决。

**90 秒回答**

Agent 系统很容易把模型说“完成了”或状态机到达 completed 当成业务成功。Completion Proof 要绑定具体 criterion、requirement revision、Evidence digest 和 freshness，并区分在线裁决与事后 Oracle。这样可以测量 false completion，而不是只看传统 task success。当前 Schema、词典和测试为这一方向提供 E1/E2 证据，但正式真实任务实验和外部 Oracle 还没完成，所以我不会声称已经消除幻觉式完成。

参考：`research/metrics/METRIC-DICTIONARY-v2.zh-CN.md`、`research/SOP-WORK-PACKAGE-HANDOFF.zh-CN.md`。

## 15. GATE-40 到底完成了多少？

**30 秒回答**

候选矩阵是 8 个故障窗口乘 5 个 seed，共 40；当前 local pilot 为 40 passed、0 failed、0 blocked，formal Verified 为 0/40、`complete=false`。local pilot 仍不能升级成 formal verification。

**90 秒回答**

GATE-40 先定义八类故障窗口，例如模型响应到 WAL commit、工具效果到 Receipt、Return 与 Lease、stale Owner commit、Proof commit 等，每个窗口用 5 个固定 seed。当前八个窗口共 40 个 local pilot 通过、0 failed、0 blocked。formal Verified 为 0、`complete=false`，所以“pilot 40 passed”绝不等于“GATE-40 正式通过”。

参考：`research/rt95-closure/GATE40-WINDOWS.zh-CN.md`、`research/rt95-closure/preregistration.draft.example.json`。

## 16. 658 项主测试能证明系统可靠吗？

**30 秒回答**

不能。test discovery 106/106；主测试共 658，其中 657 pass、1 个 Windows symlink 权限条件 skip、0 fail。这只能说明对应版本和测试集合中的已运行断言通过，条件 skip 也必须保留；可靠性还取决于测试是否走生产路径、是否覆盖真进程和真实外部系统、是否有统计重复与独立复现。

**90 秒回答**

测试数量是回归信号，不是科研指标。我要同时报告测试发现、源码覆盖、条件 skip、证据等级和未测范围。当前自动化主体是 Fake Provider 的 E2；真进程 local pilot 为 25 passed、0 failed，但 15 个 case blocked、formal Verified 为 0、`complete=false`；真实 Provider `liveCalls=0`；外部独立复现未完成。因此不能把 658 写成项目能力分，也不能把 1 个条件 skip 说成 pass。它的价值是保证已定义不变量没有静默回归，而不是证明生产可靠性或外部普适性。

参考：`docs/God-Agent-95plus持续精进总账.md`、`research/CLAIMS-EVIDENCE.zh-CN.md`。

## 17. 覆盖率 90.7723% 怎么解释？为什么不是 95%？

**30 秒回答**

当前稳定 `src` 源码行覆盖是 26146/28672 = 91.19%；源文件加载率为 116/122 = 95.082%。coverage gate 仍是 90.25/93。加载率子门已经超过 95，但全仓物理行覆盖还差至少 1,093 行才达到 95%；高覆盖也不能替代故障语义和真实环境验证。

**90 秒回答**

早期总体覆盖口径混入测试文件，不能作为正式 source coverage。现在按 `src/**/*.ts` 冻结分母，分别报告精确行覆盖和加载到测试进程的源文件比例。当前稳定值是 26146/28672 = 91.19% 与 116/122 = 95.082%，当前 coverage gate 为 90.25/93，所以工程 95+ 仍不能通过。下一步应优先补关键 WAL、IPC、恢复、权限分支，而不是用无断言执行刷数字。即使两项都达到 95%，也只代表测试触达程度，不能推出生产质量 95%。

参考：`docs/COVERAGE.md`、`scripts/verify-source-coverage.ts`。

## 18. 你的统计方案是什么？

**30 秒回答**

当前已实现统计原语，但正式结果为 0。计划对成功率报告原始计数和 Wilson 95% 区间，对零失败报告单侧上界，对配对 arm 报绝对率差、率比和固定 seed bootstrap 区间；多重比较按预注册 family 使用 Holm 校正。

**90 秒回答**

实验单位按 fault window 与 seed 配对，同一 case 在 full 和消融 arm 之间比较，减少任务差异带来的噪声。二项成功率不用只报百分比，而是报告 numerator/denominator 与 Wilson 区间；“观察到零失败”也不等于失败率为零，要给零失败上界。配对效果报告绝对率差和率比，bootstrap 必须固定 seed 并保存输入。若预注册多个假设族，再使用 Holm–Bonferroni。现在这些只是通过测试的分析工具，Raw QA、冻结预注册和正式 Raw 尚未闭环，因此不能说有统计显著性。

参考：`research/rt95-closure/STATISTICS.zh-CN.md`、`research/paper/MANUSCRIPT-DRAFT.zh-CN.md`。

## 19. 为什么用配对设计和 bootstrap？

**30 秒回答**

配对设计让同一个故障窗口和 seed 在 full 与消融组间比较，减少场景差异；bootstrap 用来描述配对效应的不确定性。但它不是自动产生因果结论，样本量、独立性和预注册仍要单独满足。

**90 秒回答**

如果 full 和 no-WAL 使用不同任务，结果可能只是任务难度不同。按 `windowId + seed + caseId` 配对后，可以直接观察每一对是否从成功变失败、是否新增重复效果或 unknown。固定 seed bootstrap 保证分析可重放，但重采样单元必须与实验独立单位一致，不能把同一运行中的多条事件伪装成独立样本。当前虽有 25 个 local pilot passed、0 failed，但 15 个候选 case 仍 blocked，formal Verified 为 0、`complete=false`，所以不能靠 bootstrap 把 pilot 包装成充分正式样本。

参考：`research/rt95-closure/STATISTICS.zh-CN.md`。

## 20. Holm 校正已经证明结果显著了吗？

**30 秒回答**

没有。项目只实现并测试了 Holm–Bonferroni 原语；当前正式 Raw 和预注册 p-value family 尚未进入分析入口，报告固定 `significanceClaimed=false`。

**90 秒回答**

Holm 校正解决多个假设同时检验时的家族错误率问题，但前提是检验族、主要终点和分析规则在看结果前冻结。现在函数本身能正确排序和调整阈值，只是工具能力证据。没有 formal case、没有冻结预注册、没有输入 p-value，就不能说“应用了 Holm”或“显著优于”。这是区分“分析代码完成”和“科研结论完成”的例子。

参考：`research/rt95-closure/STATISTICS.zh-CN.md`。

## 21. 你的内部有效性威胁是什么？

**30 秒回答**

主要威胁包括故障注入时刻不准、测试时钟改变 Lease 语义、Oracle 与实现共享错误、Fake Provider 过于确定，以及失败后选择性重跑。应通过真进程注入、独立 Oracle、保留全部 Raw 和冻结重跑规则控制。

**90 秒回答**

如果 Harness 没在预注册边界真正强杀，实验名义上测崩溃，实际只测普通重启；如果 Oracle 复用同一段生产逻辑，双方可能一起错；如果只保留成功复跑，结果会有选择性报告。God-Agent 要保存 PID、kill 时刻、WAL/Lease 状态、调用计数、最终快照和失败 repro，并规定失败先保留现场。当前只有部分窗口形成 25 个已通过 local pilot、0 failed，另有 15 个候选 case blocked，formal Verified 为 0、`complete=false`，所以内部有效性尚未闭环。

参考：`research/rt95-closure/GATE40-WINDOWS.zh-CN.md`、`research/SOP-WORK-PACKAGE-HANDOFF.zh-CN.md`。

## 22. 构念有效性和外部有效性有哪些威胁？

**30 秒回答**

构念威胁是把协议安全、业务完成、unknown 和误完成混成一个成功率；外部威胁是当前主要使用固定 fixture、单机 Windows、Fake Provider 和作者团队复跑，不能推广到真实任务、其他机器或其他框架。

**90 秒回答**

构念上，“系统没有重复调用”不等于“用户目标完成”，安全停在 unknown 也不应算失败实现，所以词典把多个指标并排报告。外部上，确定性 fixture 有利于复现，却可能偏离真实 Agent 任务分布；单机 JSON 持久层不能代表分布式部署；Fake Provider 不代表网络限流、计费和服务端幂等；同一作者复跑不能代表第三方可复现。补救是正式真实任务、受预算 Provider/副作用实验、公平外部基线和非作者第二环境复现。

参考：`research/metrics/METRIC-DICTIONARY-v2.zh-CN.md`、`research/REPRODUCIBILITY.zh-CN.md`。

## 23. 现在能投入生产吗？

**30 秒回答**

不能。Release Readiness 当前为 11/12、`BLOCKED`；新版依赖风险门直接读取官方 npm audit，并因 3 个 high 拒绝本地 READY。production 同样 blocked，因为还缺签名安装器、升级回滚、长稳、真实 Provider和干净机器验收。

**90 秒回答**

本地检查可以验证类型、测试、构建、文档和部分安全门禁，但生产发行需要另一套证据链：冻结候选 SHA、安装/卸载、代码签名、状态迁移、回滚、Crash/日志/指标、长稳与容量、备份恢复、真实 Provider 能力、SBOM/NOTICE 和发布责任人。当前这些硬门槛没有全部完成，而且官方依赖审计仍有 3 个 high。因此当前连本地 Release 总门也是 BLOCKED，production 更不能写成 READY 或 production-grade。

参考：`docs/RELEASE-CHECKLIST.md`、`scripts/release-readiness.ts`。

## 24. 为什么有 3 个 high 还能说 local-ready？

**30 秒回答**

现在不能再说 local-ready。当前官方依赖审计发现 Electron、其 `extract-zip` 链和 `nanoid` 共 3 个 high；新版 dependency-risk 门将 high/critical 纳入本地 Release 合取门，因此真实结论是 11/12、BLOCKED，且生产仍 blocked。

**90 秒回答**

默认镜像不支持 npm audit API，不能把镜像报错当作“无漏洞”。切换官方 registry 后，运行时依赖审计为 0，但包含开发/构建链的完整审计仍有 3 个 high，修复建议涉及 Electron 和 lockfile 变更。依赖升级需要授权并做 Electron、构建和全量回归。在这之前，本地 readiness 只表示规定的本地检查可运行，不表示供应链已达到生产门槛。主动披露这个负结果比隐藏它更能说明我的证据意识。

参考：`docs/God-Agent-95plus持续精进总账.md`、`docs/RELEASE-CHECKLIST.md`。

## 25. 为什么没有真实 Provider 实验？

**30 秒回答**

因为真实调用涉及账号、费用、模型版本和数据边界，需要明确授权。当前所有可复核门禁保持离线，`liveCalls=0`；这保证不伪造费用或泄露凭据，但也构成科研和生产的明确阻断项。

**90 秒回答**

真实 Provider 不只是“有 Key 就跑”。需要冻结模型、区域、预算、请求上限、超时和日志脱敏，并验证幂等键、状态查询、取消、限流和未知结果语义。没有授权时强行调用既不安全，也无法形成合规证据。因此当前先用 Fake Provider 做确定性机制测试，并把真实调用缺口写进 Claim 边界。获得授权后应从最多少量无副作用 smoke 开始，再决定正式样本量，不能把离线结果回填为真实结果。

参考：`docs/provider-capability-smoke.md`、`docs/RELEASE-CHECKLIST.md`。

## 26. AI 在项目里参与了多少？你的个人贡献是什么？

**30 秒回答**

AI 深度参与了需求拆分、方案讨论、代码和测试草拟、文档润色与审计建议；我不把 AI 说成作者，也不把 AI 输出直接等同于我的原创。我的责任是定义研究问题和约束、选择方案、核对证据、运行验收、保留负结果并对最终提交负责。无法由日志证明的具体代码比例，我不会编数字。

**90 秒回答**

我把贡献拆成“决策责任”和“产出来源”。AI 可以生成候选实现和文字，但不能替我承担研究诚信、许可证和正确性责任。我需要明确需求、判断 WAL/Lease/Proof 的边界、选择接受或拒绝建议、检查代码与测试、执行门禁，并确保 Claim 不超过证据。若直接引用或改编第三方内容，要保留来源与许可证；AI 改写也不能免除引用。答辩时我会主动展示 AI 辅助声明，并对无法逐行归属的部分如实说“未做可靠百分比统计”。

参考：`docs/God-Agent-AI辅助与原创边界声明.md`、`原创借鉴与引用说明.md`。

## 27. 项目中最有价值的失败是什么？

**30 秒回答**

最有价值的是覆盖插桩放大时序后暴露 Lease TTL 夹具问题，以及 Process Harness 的故障点等待曾超时。这说明测试工具本身也会改变并发时序，失败不能被成功复跑覆盖，必须保存并解释。

**90 秒回答**

可靠性项目最危险的是只展示绿色结果。覆盖插桩让某个并发测试超过原 1 秒 TTL，暴露了夹具把“同进程 busy”与“Lease 过期”混在一起；修正后普通和覆盖模式都复验。Process Harness 也出现过持久化故障点等待超时，随后补充可观测性并保留负结果。此外历史上还有一次详情丢失的 flake，只能叫未复现，不能叫已修复。这些案例训练了我区分产品缺陷、Harness 缺陷和未知失败。

参考：`docs/God-Agent-95plus持续精进总账.md`、`research/CLAIMS-EVIDENCE.zh-CN.md`。

## 28. 离 95+ 还差什么？下一步先做什么？

**30 秒回答**

当前不能声称任一科研/论文/生产环节达到 95。优先顺序是补关键源码覆盖和干净环境门禁，接通 GATE-40 剩余 15 个 blocked case 并冻结预注册，再做正式统计、真实 Provider/副作用、公平外部基线和非作者复现，最后完成依赖修复、签名发行与升级回滚。

**90 秒回答**

工程侧连续两次保守源码行覆盖为 24425/26908 = 90.7723%，当前 coverage gate 为 90.25/93，要继续补关键恢复与权限分支，并在干净 Windows 环境验证。科研侧 GATE-40 是 candidate 40、local pilot 25 passed / 0 failed / 15 blocked、formal Verified 0、`complete=false`，需接通剩余 case、冻结输入摘要和停止规则，再运行 full/消融正式重复并生成 Raw/Manifest。论文侧补相关工作、LangGraph/Temporal 公平基线、威胁有效性和非作者方法审查。生产侧解决 3 个 high，补安装签名、升级回滚、长稳、真实 Provider 和支持手册。官方总账评分为 93/90/69/47/68，五项仍均未到 95。

参考：`docs/God-Agent-95plus持续精进总账.md`。

## 现场禁用表述

| 不要说 | 应该说 |
|---|---|
| “主测试结果可以直接换算成可靠性 95%” | “test discovery 113/113；主测试 736 总计为 735 pass、1 个 Windows symlink 权限条件 skip、0 fail；它们是回归证据，不是可靠性概率” |
| “GATE-40 已完成” | “candidate 40、local pilot 40 passed / 0 failed / 0 blocked、formal Verified 0、complete=false” |
| “真实模型已经验证” | “Provider offline，`liveCalls=0`” |
| “达到生产级” | “本地 Release 11/12、`BLOCKED`，production `blocked`” |
| “没有安全漏洞” | “Secret 扫描 0 高置信命中；官方依赖审计仍有 3 个 high” |
| “覆盖率接近满分” | “源码行 26146/28672 = 91.19%，加载率 116/122 = 95.082%；只有加载子门过 95，全仓行覆盖仍未达 95” |
| “比 LangGraph/Temporal 更可靠” | “尚无同条件外部基线，只能比较设计关注点” |
| “实现 exactly-once” | “提供局部去重、fencing 与 unknown 安全停止，不构成端到端 exactly-once” |
| “代码都是我手写的” | “AI 有实质辅助；我负责定义、取舍、复核、验收和最终责任” |

## 证据索引

- 项目定位与运行边界：`README.md`
- 三分钟演示：`docs/DEMO-复试三分钟演示.md`
- Claim—Evidence 矩阵：`research/CLAIMS-EVIDENCE.zh-CN.md`
- 指标定义：`research/metrics/METRIC-DICTIONARY-v2.zh-CN.md`
- GATE-40 候选矩阵：`research/rt95-closure/GATE40-WINDOWS.zh-CN.md`
- 统计方法与限制：`research/rt95-closure/STATISTICS.zh-CN.md`
- 覆盖率口径：`docs/COVERAGE.md`
- 发布阻断项：`docs/RELEASE-CHECKLIST.md`
- AI 与原创边界：`docs/God-Agent-AI辅助与原创边界声明.md`、`原创借鉴与引用说明.md`
> 2026-08-24 统一证据快照：113/113，736（735pass，1 skip，0fail），26146/28672（91.19%），116/122，17/17，40passed，0blocked，formalverified0，livecalls=0，11/12，3high。
