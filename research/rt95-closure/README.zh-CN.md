# RT95 科研闭环：预注册门禁 v1

### 版本化公开 Artifact Release

`../reproducibility/src/artifact-release.ts` 复用 publishable sanitizer 的私有源摘要与公开派生 receipt，把源码、Draft 预注册、数据字典、公开派生、统计、表格、Manifest、License 和 CodeVerified Claim 收口到一个版本化 Release。示例 Release 明确是 `local-tooling-only`；它不生成 formal Raw，也不冻结本目录中的 Draft。

本目录提供科研预注册和分析合同的机器可读输入。当前所有文件仍是 Draft/candidate 或 pipeline contract，不关闭“输入已经冻结”，不证明实验已经执行，也不升级任何 RT95 账本状态。

## 文件

- `preregistration.schema.json`：结构 Schema；
- `preregistration.draft.example.json`：旧最小 Validator 使用的 smoke 基础 Draft；其中 1 available/7 blocked 不是当前实验口径；
- `gate40-authoritative-protocol.json`：当前唯一的 8 窗口×5 seed 候选权威源，固定 40/40 local pilot、formal 0；
- `preregistration.frozen.candidate.json`：依据上述权威协议物化的 8 窗口冻结候选，带 payload SHA；仅表示输入设计已冻结，仍未执行实验、未完成作者批准或独立审阅；
- `src/authoritative-preregistration.ts`：把 smoke 基础确定生成 8×5 候选并严格验证，不修改或伪造 Frozen 文件；
- `GATE40-WINDOWS.zh-CN.md`：由权威协议解释的窗口、入口、Oracle、Artifact 与本地/外部边界；
- `formal-research-packet.schema.json`：只能表达 preflight、不能表达 formal/external Verified 的 Packet Schema；
- `src/formal-research-packet.ts`：Frozen 绑定、160-case 计划、Raw append-only 哈希链和 Claim→Evidence 闭合 Validator；
- `src/persistent-run-ledger.ts`：exclusive-create 的逐事件文件账本，可在进程重启后重建并拒绝覆盖、篡改、删除、重排、重放和额外文件；
- `confirmatory-analysis-plan.draft.json` / `src/confirmatory-analysis.ts`：从逐条配对 Raw 确定生成 exact McNemar、配对区间与 Holm 输出的 Draft 入口；
- `scripts/validate-rt95-preregistration.ts`：跨字段语义、摘要、Provider 策略和 SHA-256 防篡改 Validator；
- `tests/rt95-preregistration-test.ts`：正反例。

## GATE-40 单一权威口径

权威协议将当前口径固定为 8 个稳定窗口 ID × 5 个固定 seed，共 40 个 window/seed case，当前 `runnable=40`、`localPassed=40`、`blocked=0`、`formalVerified=0`。Validator fail-closed 拒绝窗口缺失/乱序、seed 漂移、Oracle 漂移、接线路径漂移、伪 formal 和 claim boundary 外部化。

`preregistration.draft.example.json` 中 1 available/7 blocked 是为了旧脚本 Validator 的正反例保留的 smoke 基础，不得引用为当前状态。W02/W07/W08 虽可运行，但使用独立本地 helper，不是真实外部 Tool/系统；全部轨道仍是 Fake Provider。

## Formal research packet preflight

`formal-research-packet-v1` 把“可以开跑”与“已经得到结果”分离：

- 只接受 digest 可复验的 Frozen 预注册；
- 绑定非零 commit、source tree、lockfile、config 与 preregistration SHA-256；
- 强制 executor/reviewer 使用不同身份，但在实际签字前保持 `independentReviewCompleted=false`；
- 从 Frozen arm×window×seed 确定生成 160 条 case plan 和摘要；
- Provider 只记录预检策略，固定 `realApiCalls=0`、`credentialsRead=false`；
- Raw ledger 以 `previousEventSha256` 和 `eventSha256` 形成事件链，人工介入、失败、排除、中止、获准重跑及成功都只能追加；
- Claim Matrix 必须逐项覆盖 `CLAIM-TABLE.json` 的所有 Claim 和 requirement；本地 preflight 包不能升级 formal/external/publication Claim。

测试可从 smoke 基础与权威协议确定生成 8×5 候选，并证明冻结候选的 preflight 输入适配。该文件只证明输入已经按当前权威协议冻结；仓库仍没有正式 Raw、真实 Provider 调用或作者批准，因此仍固定 `formalVerified=false`。

持久 ledger 为每个序号使用不可覆盖事件文件，重启后从 header 与全部事件重建状态；能拒绝覆盖、事件内容篡改、中间删除、重排、重放、额外文件、未授权重跑、重复 active attempt 与提前 seal。它没有生成任何 formal Raw；若要抵抗攻击者同时删除账本尾部和所有同源锚点，仍需要仓库外可信时间戳、透明日志或独立 Reviewer 持有的 head digest。

## 生命周期

1. Draft 可以反复修改，但必须保持 `windowSetLifecycle=candidate-not-frozen`，且不能预填 Evidence 或 Reviewer 结论。
2. Freeze 时将窗口集生命周期一并改为 `frozen`，写入 canonical UTC 时间，并对除 `integrity.payloadSha256` 自身之外的完整文档计算 SHA-256。
3. Frozen 文档的任何事后修改都会触发 digest mismatch。
4. `frozen` 只表示实验输入冻结；`verification.status` 仍必须是 `NotVerified`。实验执行、Raw、Oracle、统计和独立 Reviewer 完成前，不得写 `Verified`。

验证旧 smoke 基础 Draft：

```powershell
npx tsx scripts/validate-rt95-preregistration.ts --file research/rt95-closure/preregistration.draft.example.json
```

输出 smoke 基础的待冻结摘要：

```powershell
npx tsx scripts/validate-rt95-preregistration.ts --file research/rt95-closure/preregistration.draft.example.json --print-digest
```

命令只验证旧 smoke 轨道，不代表当前 8×5 权威候选。当前冻结候选文件可用同一 Validator 检查；其 Freeze 仅是输入冻结，不等同实验执行或 Verified。正式研究仍需作者批准、真实 Provider、Raw、外部 baseline、独立复现和非作者审阅。

## RQ、样本量与确认性分析

- 活跃候选范围收敛为 RQ1 恢复可靠性和 RQ2 单变量消融；延迟/成本退出确认性 Claim，Raw v1 的 latency 只作描述，成本为未来工作。
- 每 arm 40 是 8×5 覆盖格。在 assumed rate 0.8 时，32/40 的 Wilson 95% 区间约为 `[0.6524,0.8950]`，最大单侧距离约 0.1476，因此 Draft 将名义精度改为 0.15，不再声称 0.08。
- `targetPower=0.8` 仍只是正式设计目标；40 格没有证明达到该 power。Freeze 前必须依据配对 discordance、窗口分层/聚类、缺失率、MEI 和 Holm family 重算样本量。
- 确认性 Draft 入口只从逐条 Raw 计算 p-value，拒绝人工注入 p-value、缺失比较和非配对 Raw。输出即使出现 `rejectedUnderDraftPlan=true` 也不能写成正式显著性。

## Claim 边界

通过 Validator 只能证明：预注册输入结构完整、ID 引用闭合、摘要匹配、Provider 策略 fail-closed；若为 Frozen，内容与冻结 digest 一致。

它不能证明：假设正确、样本量一定充分、实验已运行、真实 Provider 已授权、结果显著、GATE-40 完成、Research-95 或论文 E4 成立。

## 90+ 证据包机械验收

当真实 Provider、外部 baseline 和独立复现原件已经由相应责任人交付后，可使用仓库内的证据包模板与 fail-closed 审计器：

- 模板：`evidence-90-manifest.template.json`；
- 审计器：`src/evidence-90-gate.ts`；
- 详细执行合同：`docs/research/EVIDENCE-CLOSURE-90-EXECUTION.zh-CN.md`。

```powershell
npx tsx research/rt95-closure/src/evidence-90-gate.ts --root D:/path/to/evidence-package --json
```

审计器只读证据包，检查候选绑定（commit、源码、预注册与冻结 case plan 摘要）、状态、文件存在性、SHA-256、非符号链接、身份独立性、文件引用不重复、规范 UTC 时间和安全相对路径。任一缺项均返回退出码 2 和 `BLOCKED`；它不会调用 Provider、读取凭据、修改 `current-evidence.json` 或升级 Claim。没有真实外部原件时，科研证据分数仍保持 69/100。
