# God-Agent Research Artifact v0.1 第三方复现 SOP

> 状态：RRA-03 已完成审稿，等待总控冻结 Artifact
> 适用范围：Windows 本机、离线科研 Runner、确定性 Fake Provider
> 事实来源：当前仓库 `package.json`、科研 Runner 源码、D08/D09/D10
> 证据边界：协议级 Model Check、生产实现 Implementation Check、窄范围 Process Check 必须分别记录，不能相互替代

## 1. 复现目标与停止条件

本 SOP 让未参与开发的复核者从不含旧结果载荷的固定源码开始，依次运行：

1. 协议级 GATE-30 Model Check；
2. 生产实现 Runtime-E2E GATE-30 Implementation Check；
3. Team Workflow Return 的窄范围 Process Check；
4. 在 RRA-01 入口集成后创建并复核 Artifact Manifest。

任一步退出码非 0、预期文件缺失、Schema/运行时校验失败、结果目录在运行前已有载荷，或发现真实 Provider 请求，都应停止该步的“通过”判定，保留现有输出并填写第 10 节失败报告。不得删除失败用例或只归档成功结果。

当前 Process Check 只覆盖 Team Workflow Return 的一个固定 seed，科研矩阵口径为窄范围 **1/40**；**GATE-40 未完成**，剩余 39/40 不在本 Artifact v0.1 的证据范围内。

## 2. 三层检查的定义

| 层级 | 实际入口 | 检查对象 | 当前最高证据口径 | 不能外推到 |
|---|---|---|---|---|
| Model Check | `research/benchmarks/src/cli.ts` | 确定性协议参考状态机、固定 fixture、WAL/recovery/lease 消融 | E2：可重复自动化检查 | 生产类接线、真实文件/进程、真实 Provider、真实延迟 |
| Implementation Check | `research/runtime-e2e-benchmarks/src/cli.ts` | 生产 `AgentLoop`、Stores、Workflow、Lease 与真实 JSON 重载；Provider/Tool 仍为 Fake | E2：生产实现的本机集成检查 | 主机或进程级故障、真实外部 Tool、真实 Provider、容量 |
| Process Check | `research/runtime-e2e-benchmarks/src/process-chaos-cli.ts` | 真 App Server 子进程强杀、三代 PID、公共 RPC 与原始 JSON 恢复证据 | 窄范围 E3：1/40 | Dynamic 全边界、其余 39 个矩阵用例、跨主机与系统级唯一执行语义 |

证据等级沿用 D08：E0 为计划；E1 为源码或静态检查；E2 为可重复单元/集成测试；E3 为生产组装、本机真实文件或子进程检查；E4 还要求冻结版本、外部复核、重复实验和统计分析。本 Artifact v0.1 当前没有 E4 结论。

## 3. 参考环境与依赖

### 3.1 已验证参考配置

| 项目 | 参考值 | 说明 |
|---|---|---|
| 操作系统 | Windows NT `10.0.26200.0` x64 | 当前本机参考环境；尚无 Windows 多版本矩阵 |
| PowerShell | Windows PowerShell 或 PowerShell 7 | 下文命令使用 PowerShell 语法 |
| Node.js | `v20.19.0` | 当前仓库历史与本次复核使用的版本 |
| npm | `10.8.2` | 本次复核版本 |
| 依赖锁 | `package-lock.json` lockfile v3 | 必须用 `npm ci` 安装固定依赖 |

`package.json` 当前没有 `engines` 字段，因此不能把 Node/npm 的其他版本写成已经验证支持。若使用不同版本，必须把差异写入复现记录，结论只能标为“环境变体复核”。Process Check 还需要允许 Node 创建和强杀本机子进程、绑定 `127.0.0.1` 临时端口，并可写系统临时目录与指定输出目录。

### 3.2 Provider 与网络边界

- 三个科研 Runner 都不得调用真实模型 Provider，也不需要真实 Key。
- Model Check 使用确定性 mock。
- Implementation Check 使用确定性 Fake Provider 与临时 effect journal。
- Process Check 启动仅绑定 `127.0.0.1` 的 Fake Responses Server，并向子进程注入测试占位值；不读取用户真实 Key。
- `npm ci` 可能访问 npm 包注册表下载依赖；这是依赖安装网络，不是模型 Provider 调用。
- 不要在记录中粘贴环境变量、Token、Key、凭据或本机无关配置。

## 4. 固定源码与空结果起点

1. 获取总控冻结并校验过的源码包，解压到任意普通目录。路径不得依赖原作者机器。
2. D10 记录的集成候选为 `e65767f960967a21ab2191503363e53280d4ba62`，但最终 Artifact 必须由总控在集成时填写并确认最终冻结版本；复核者不能只凭本文把候选值当作最终版本。
3. 在源码根目录执行以下环境记录和依赖安装：

```powershell
node --version
npm --version
[System.Environment]::OSVersion.VersionString
npm ci
npm run check
```

4. 确认两个既有 `results/` 目录除仓库占位文件 `.gitignore` 外没有旧载荷，并确认本次 Process 输出目录尚不存在：

```powershell
$ModelResults = Join-Path (Get-Location) "research\benchmarks\results"
$RuntimeResults = Join-Path (Get-Location) "research\runtime-e2e-benchmarks\results"
$ProcessCase = Join-Path $RuntimeResults "process-chaos-gate40-seed-1"

$ModelOld = Get-ChildItem -LiteralPath $ModelResults -Force | Where-Object Name -ne ".gitignore"
$RuntimeOld = Get-ChildItem -LiteralPath $RuntimeResults -Force | Where-Object Name -ne ".gitignore"

if (@($ModelOld).Count -ne 0) { throw "Model results contains old payload" }
if (@($RuntimeOld).Count -ne 0) { throw "Runtime results contains old payload" }
if (Test-Path -LiteralPath $ProcessCase) { throw "Process output already exists" }
```

这一步只检查，不清理旧文件。若目录不满足条件，应换用一份干净源码，或先由 Artifact 管理者归档旧结果；不得覆盖来源不明的结果。

## 5. 命令、输入、输出与退出条件

预计耗时是参考机的保守区间，不是性能指标。实际开始/结束时间和墙钟耗时必须填写到第 9 节模板。

| 步骤 | 命令 | 输入 | 主要输出 | 成功退出条件 | 预计耗时 | Provider |
|---|---|---|---|---|---:|---|
| 静态检查 | `npm run check` | 当前源码、`tsconfig.json` | 控制台类型检查结果 | 退出码 0 | 10–60 秒 | 不使用 |
| Model Check 专项 | `npm run test:benchmarks` | GATE fixture、Runner 与 Schema | Node test 输出 | 退出码 0，所有专项测试通过 | 5–60 秒 | 确定性 mock |
| GATE-30 Model Check | `npm run benchmark:gate30` | `gate-30.json`，seed `20260818`，四个变体 | `report.json`、`summary.csv`、`cases.csv`、`repro/*.json` | 参数、两次字节级确定性检查、运行时 Schema、写盘全部成功且退出码 0 | 5–30 秒 | 确定性 mock |
| Runtime 专项 | `npm run test:runtime-e2e` | 生产类、fixture、临时 JSON、Process Harness | Node test 输出；测试自身使用系统临时目录 | 退出码 0，所有专项测试通过 | 1–3 分钟 | 确定性 Fake；Process 用本机 Fake Server |
| Runtime-E2E GATE-30 | `npm run benchmark:runtime-e2e:gate30` | `gate-30.json`，seed `20260819`，生产类与四个变体 | `report.json`、`summary.csv`、`cases.csv`、`repro/*.json` | 两次确定性结果投影一致、报告校验和写盘成功且退出码 0 | 15–90 秒 | 确定性 Fake，不读凭据 |
| Process 专项 | `npm exec -- tsx --test research/runtime-e2e-benchmarks/tests/process-chaos-gate-test.ts` | Harness、运行时校验器、JSON Schema、CLI 失败路径 | Node test 输出；测试使用并清理系统临时目录 | 正向真进程用例与负向 CLI 用例均通过且退出码 0 | 35–120 秒 | 本机 Fake Server，不读真实 Key |
| 窄范围 Process Check | `npm exec -- tsx research/runtime-e2e-benchmarks/src/process-chaos-cli.ts --seed gate40-seed-1 --output research/runtime-e2e-benchmarks/results` | 固定 seed、父输出目录、生产 App Server 入口、Fake Server、本机文件与 Lease | Harness 自动创建 `process-chaos-gate40-seed-1/`，其中包含 `process-chaos-report.json`、`runtime-state.json`、`runtime-leases.json`；`.transient/` 被清理 | 运行时 Schema、报告 JSON Schema 对应字段、恢复断言与清理全部成立并退出码 0 | 35–90 秒 | 本机 Fake Server，不读真实 Key |
| Manifest 专项 | `npx tsx --test research/reproducibility/tests/manifest-test.ts` | Manifest create/verify、路径与敏感信息防护 | Node test 输出；测试使用并清理系统临时目录 | 正向与篡改/缺失/多余/路径负例全部通过且退出码 0 | 5–60 秒 | 不使用 |

说明：Process Check 目前没有 `package.json` 脚本，上表使用 RRA-02 源码与报告 Schema 中共同锁定的 `npm exec -- tsx` 入口。

## 6. 从空目录执行最小复现

### 6.1 Model Check

```powershell
npm run test:benchmarks
npm run benchmark:gate30
$ModelExit = $LASTEXITCODE
$ModelExit
```

默认正式输出目录应为：

```text
research/benchmarks/results/gate-30-seed-20260818/
├─ report.json
├─ summary.csv
├─ cases.csv
└─ repro/*.json
```

`repro/` 中的失败样本是消融反例，不应因为 baseline 通过而删除。若 `$ModelExit` 非 0，停止本层通过判定并填写失败报告。

### 6.2 Implementation Check

```powershell
npm run test:runtime-e2e
npm run benchmark:runtime-e2e:gate30
$RuntimeExit = $LASTEXITCODE
$RuntimeExit
```

默认正式输出目录应为：

```text
research/runtime-e2e-benchmarks/results/gate-30-seed-20260819/
├─ report.json
├─ summary.csv
├─ cases.csv
└─ repro/*.json
```

该报告中的墙钟时间只证明本次本机执行发生过，不能当作真实 Provider 延迟或部署容量。`unknownOutcome` 也不能被静默改写成成功请求；它表示需要显式处置的不确定状态。

### 6.3 窄范围 Process Check

```powershell
npm exec -- tsx --test research/runtime-e2e-benchmarks/tests/process-chaos-gate-test.ts
npm exec -- tsx research/runtime-e2e-benchmarks/src/process-chaos-cli.ts --seed gate40-seed-1 --output research/runtime-e2e-benchmarks/results
$ProcessExit = $LASTEXITCODE
$ProcessExit
```

`--output` 的契约是父输出目录；Harness 根据 seed 自动创建 `process-chaos-<seed>`。因此本命令的实际产物目录是 `research/runtime-e2e-benchmarks/results/process-chaos-gate40-seed-1/`。本次文档校验曾把 seed 子目录误传给 `--output`，从而观察到双层同名目录；这属于命令误用，现已纠正，不作为 Runtime 缺陷。检查报告至少应显示：Schema 版本、环境与 Provider 声明、三代 PID 变化、一个计入矩阵的正式故障窗口、故障点确认、强杀、公共 RPC 与原始 JSON 恢复证据、最终 Job/Return 状态，以及杀进程前后 `return_god` 的 Fake Provider 请求计数均为 1。这个计数只约束该 seed 和该故障窗口，不能外推到其他提交边界。

运行后确认报告记录的 PID 已退出。若仍有子进程、输出目录不完整或退出码非 0，应按失败处理并保留目录。

## 7. 原始文件哈希与旧摘要限制

对本次新生成文件计算哈希：

```powershell
Get-FileHash -Algorithm SHA256 research/benchmarks/results/gate-30-seed-20260818/report.json
Get-FileHash -Algorithm SHA256 research/runtime-e2e-benchmarks/results/gate-30-seed-20260819/report.json
Get-FileHash -Algorithm SHA256 research/runtime-e2e-benchmarks/results/process-chaos-gate40-seed-1/process-chaos-report.json
```

当前仓库的旧摘要写有以下哈希：

- 协议 GATE-30：`A120F84C3454F57B08DEFCD466BD88BA23D9DCB671DF6E67D0141E0EC475DE59`；
- 协议 GATE-100：`31EC316155B4B06599A7E1712F35D1CD17C894C1F8DD8850E78243A43358DC72`；
- Runtime-E2E GATE-30：`152BB16FDF3CB27EDE9B4E542933C9A770198BDE29016DE3C95379BDAC5F14F4`。

但是旧运行对应的原始 JSON/CSV/repro 当前不在工作区，相关 `results/` 目录只有 `.gitignore`。因此这些字符串只能证明“摘要曾记录该哈希”，不能独立核验旧原始文件的内容与来源。新复跑即使得到相同哈希，也只是重建结果匹配，不能恢复旧文件的保管链。最终 Artifact 应保存新原始文件、环境记录和 Manifest，并明确区分旧摘要与新复跑。

## 8. Artifact Manifest 创建与验证

RRA-01 已提供真实入口：

```powershell
npx tsx --test research/reproducibility/tests/manifest-test.ts
npx tsx research/reproducibility/src/cli.ts create --root <artifact-root> --baseline-commit <40位小写冻结版本> --command "<本 Artifact 对应的真实运行命令>" --started-at <UTC开始时间> --finished-at <UTC结束时间> --provider deterministic-fake
npx tsx research/reproducibility/src/cli.ts verify --root <artifact-root>
```

尖括号字段必须用第 9 节记录中的真实值替换；它们不是可直接复制执行的默认值。时间必须是规范 UTC ISO-8601，例如 `2026-08-20T01:00:00.000Z`。`--provider` 只接受 `none` 或 `deterministic-fake`。CLI 在出错时返回 1。

Manifest Schema 只记录一个运行命令，因此推荐为 Model、Implementation 和 Process 三次运行分别建立空 Artifact 根目录，再各自 create 和 verify。Model/Implementation 复制各自完整原始输出与该次环境/失败记录；Process v0.1 公共根只复制 `process-chaos-report.json`、`runtime-leases.json`、命令、环境和限制记录，明确排除含本机绝对计划路径的 raw `runtime-state.json`。每个根目录的 `--command` 分别使用第 5 节的精确运行命令；不要把多条命令伪装成一条。

创建会递归收集除 Manifest 自身以外的文件，记录规范化相对路径、字节数、SHA-256 与内容类型，并写入冻结版本、Node/OS、起止时间和 Provider 声明。verify 会拒绝缺失、内容或字节数变化、内容类型变化、未登记多余文件、非规范序列化、目录穿越、绝对路径条目、重复路径与 Manifest 自包含。专项测试还覆盖高置信凭据内容和敏感文件名拒绝。

总控集成步骤：

1. 运行 Manifest 专项测试；
2. 把 Model/Implementation 的原始目录、环境记录、失败报告和相关 Claim 行复制到对应空根；Process 只复制公开安全子集并加入 raw state 排除/可重建/Claim 降级说明；
3. 用总控确认的 40 位小写冻结版本及真实起止时间运行 create；
4. 立即在原目录运行 verify；
5. 复制 Artifact，在复制件中分别做篡改、缺失和多余文件负向检查，确认 verify 非 0；
6. 保存负向检查日志，但不要把被修改的复制件作为最终包；
7. 在另一份干净只读复制包上再次 verify。

### 8.1 Process 报告相对路径验收

RRA-02 已将 Process 报告中的 `statePath` 固定为 `runtime-state.json`、`rawReportPath` 固定为 `process-chaos-report.json`；两者都相对于 Harness 自动创建的 case 目录解析。运行时校验器和 JSON Schema 同时约束这两个安全相对路径，拒绝绝对路径、反斜杠和点路径段。但报告字段安全不等于 raw state 内容安全：当前 `runtime-state.json` 仍含本机绝对计划路径。因此 v0.1 公共 Manifest **不得**递归纳入整个 seed 子目录，只纳入 `process-chaos-report.json`、`runtime-leases.json`、环境、命令和限制记录。raw state 可由相同 Runner 在复核机重建；因其未公开冻结，依赖 raw state 独立复查的 Claim 必须降级。本轮独立验收曾出现首次 1/2、立即复跑 2/2 的 fault point 等待超时；根因修复后员工连续四轮 2/2，总控独立复验又以 2/2 通过且无残留。首失败与全部复跑仍须归档，当前待 baseline/Artifact/同机干净副本最终冻结，不得写成跨环境普适稳定。

## 9. 干净环境复现记录模板

```text
复现记录 ID：
复核者：
开始时间（含时区）：
结束时间（含时区）：
源码包名称与 SHA-256：
总控确认的冻结版本：
工作目录（归档前需去除个人路径）：

环境：
- Windows 版本 / 架构：
- PowerShell 版本：
- Node 版本：
- npm 版本：
- package-lock.json SHA-256：
- 与参考环境的差异：

起点检查：
- Model results 旧载荷数：
- Runtime results 旧载荷数：
- Process 输出目录是否预先存在：
- 人工介入：

步骤记录（每条分别填写）：
- 检查层级：Model / Implementation / Process / Manifest
- 精确命令：
- 输入 fixture / seed / variant：
- 开始时间：
- 结束时间：
- 墙钟耗时：
- 退出码：
- stdout/stderr 保存位置：
- 原始输出目录：
- report.json SHA-256：
- 失败 repro 数量：
- Provider 类型：
- 真实 Provider 请求数：应为 0
- 人工介入与原因：

Manifest：
- create 命令与退出码：
- Manifest 路径与 SHA-256：
- verify 命令与退出码：
- 缺失/篡改负向检查退出码：

最终裁决：通过 / 部分通过 / 失败
可保留的 Claim ID：
必须降级或撤回的 Claim ID：
未解决异常：
复核者签名与时间：
```

## 10. 失败报告模板

```text
失败 ID：
关联复现记录 ID：
检查层级：Model / Implementation / Process / Manifest
关联 Claim ID：
发生时间（含时区）：
环境摘要：
精确命令：
输入 fixture / seed / variant：
预期退出条件：
实际退出码：
实际现象：
关键错误原文（去除敏感值）：
stdout/stderr 文件：
已生成 Artifact 与 SHA-256：
未生成的预期文件：
是否发现残留子进程：
清理或隔离动作：
真实 Provider 请求数：应为 0
复跑次数与每次结果：
人工介入：
对 Claim 的影响：保留 / 降级 / 撤回 / 待复核
初步原因（未知时明确写未知）：
下一步最小诊断：
报告者与时间：
```

## 11. 2026-08-20 RRA-03 临时复核记录

该记录用于保留本次审稿反例；输出位于系统临时目录，不属于最终冻结 Artifact。

| 步骤 | 结果 | 耗时 | 观察 |
|---|---:|---:|---|
| `npm run benchmark:gate30 -- --out <临时目录>` | 退出码 0 | 2.215 秒 | 新 `report.json` 的 SHA-256 为 `A120...DE59`，与旧摘要字符串相同；旧原始文件仍缺失 |
| `npm run benchmark:runtime-e2e:gate30 -- --out <临时目录-1>`（首次） | 退出码 1 | 15.106 秒 | 两次确定性结果投影不一致；正式报告未写出 |
| 同一 Runtime-E2E 命令（第二次） | 退出码 0 | 约 20.4 秒 | 同命令复跑通过并生成正式输出；该临时输出尚未进入冻结 Artifact |
| 当前源码 Process CLI，seed `rra03-20260820` | 退出码 0 | 34.581 秒 | 三代 PID 变化、两个内部观测窗口断言通过、`return_god=1`；仅作临时窄范围复核 |

上述 Runtime-E2E 首次失败是必须保留的已修复负结果。RRA-04 定位到真实根因：`mkdtemp` 生成的随机 `caseDirectory` 被 `SnapshotConflictError.message` 原样写入 `recoveryResult`，导致两次确定性投影只在绝对临时路径上不同，同时泄漏本机路径。

修复发生在 `executeRuntimeE2eScenario` 的异常记录源头：将 `caseDirectory` 的原生分隔符与正斜杠形式规范化为 `<case-directory>`。修复没有从 `deterministicProjection` 删除 `recoveryResult`，并继续保留 `snapshot_conflict`、`SnapshotConflict`、expected/found generation、`runtime-state.json`、`taskSuccess=false` 及全部安全和恢复指标。

修复后验证如下：

- RRA-04 执行 `npm run test:runtime-e2e`，10/10 通过；`npm run benchmark:runtime-e2e:gate30` 通过；`npm run check` 通过。
- 总控随后独立连续两次执行 `npm run benchmark:runtime-e2e:gate30`，均退出 0，且 `deterministicOutcomesVerified=true`。

因此该反例当前应表述为“曾发生、根因已定位并修复、当前参考环境连续复跑通过”；对应的 Runtime-E2E 路径问题已关闭。首次失败日志仍须与修复证据一同归档；最终冻结前 Artifact 可用性仍为 B，更广 Windows/Node 环境仍需按本 SOP 复核。外部第三方无指导复现仍未完成，属于 R4/E4 后续目标，不是本次 v0.1 PR 前置，也不得被同机干净源码副本复现替代声称。
