# Goal 模式：三项 90+ 阻塞驱动执行框架

> 目标：科研证据闭环、论文就绪度、生产发行成熟度从 69/47/68 推进到真实可审计的 90+。  
> 原则：只有关闭评分阻塞的动作才算有效进展；本地测试、模板和说明文档只能证明工具准备度，不能自动增加正式分数。

## 1. 当前基线与真正阻塞

权威快照：`docs/evidence/current-evidence.json`。当前分数固定为：

| 线 | 当前 | 目标 | 缺口 | 关键阻塞 |
|---|---:|---:|---:|---|
| 科研证据闭环 | 69 | ≥90 | 21 | formal Provider/Raw、外部 baseline、独立复现、冻结候选、`evidence:verify` |
| 论文就绪度 | 47 | ≥90 | 43 | 正式 Claim 证据、首手引用核验、非作者审阅、作者批准 |
| 生产发行成熟度 | 68 | ≥90 | 22 | 3 个 high、真实发行 manifest、签名包、干净机、升级/回滚、3600 秒长稳 |

当前权威事实：Provider 为 `offline-deterministic-fake`、`liveCalls=0`、`formalVerified=0`、发行状态 `BLOCKED`。

## 2. 新的任务准入规则（防止无效工作）

每个新任务必须在开始前写明：

1. 它关闭哪个具体阻塞（文件、字段或门禁 ID）；
2. 关闭后预期使哪一项从 `NotVerified/Blocked` 变为可复评；
3. 外部责任人、原始证据和验收命令；
4. 失败时的停止条件。

以下工作默认禁止重复执行：

- 只增加本地 fixture、只增加模板、只重复已通过的专项测试；
- 修改 `current-evidence.json`、Verified Claim、覆盖率分母/阈值来制造通过；
- 用 Fake Provider、local pilot、作者自测或合成 receipt 代替正式证据。

## 3. 正确流程：证据先于评分

```text
冻结 candidate
  ↓
外部责任人提交原始证据包
  ↓
文件/身份/时间/SHA/路径门禁
  ↓
科研证据串行复核
  ↓
论文 Claim、图表、引用、非作者审阅串行复核
  ↓
发行签名、干净机、升级回滚、长稳串行复核
  ↓
全部门禁通过
  ↓
主控重新计算三项分数
```

任何一步失败，都保持原分数和 `NO-GO/BLOCKED`，转入对应责任人返工。

## 4. 三条线的唯一有效工作包

### A. 科研证据闭环（69 → 90+）

外部责任人必须提交：

- Frozen preregistration 与 SHA；
- 真实 Provider 授权、请求/响应 receipt、正式 Raw ledger；
- 公开 external baseline、版本、许可证、公平协议、逐 case Raw；
- 第二机器、隔离环境或非作者独立复现原件；
- 失败、超时、排除和 `outcome_unknown` 的完整账本。

放行条件：`formalVerified=1`、Provider 非 fake 且有 live receipt、external baseline=1、independent reproduction=1、`evidence:verify=PASS`。

### B. 论文就绪度（47 → 90+）

必须在科研证据冻结后完成：

- 每个核心 Claim 绑定 Evidence、Artifact、Locator、candidate digest 和统计来源；
- 一手引用逐条人工核验，补 DOI/HTTPS 与页码/章节；
- 非作者完成方法、统计、限制、伦理、复现和全文 R0/R1/R2 审阅；
- 关闭所有 P0/P1，完成作者最终批准；
- 结果、图表和正文只使用同一候选 Artifact。

放行条件：核心 Claim 100% 有正式证据、引用核验完成、`NotVerified/TODO=0`、非作者审阅签字、`test:paper`/`paper-consistency`/`paper-evidence`/`evidence:verify` 全部 PASS。

### C. 生产发行成熟度（68 → 90+）

必须提交：

- 3 个 high 的修复或正式风险接受；
- 同一 candidateRef 的 `release-artifact.json`、`release-supply-chain.json`、SBOM、安全扫描和数据完整性 receipt；
- Authenticode 签名安装包与时间戳验签；
- 无开发依赖/缓存的干净 Windows 安装、启动、核心任务、卸载和失败恢复记录；
- N→N+1 升级失败、N+1→N 回滚、数据完整性和再次升级记录；
- 3600 秒长稳、崩溃恢复、子进程退出和 lease 超时 receipt；
- 非作者发行复核与正式放行签字。

放行条件：`release:check=PASS`、无未处置 critical/high、真实签名包和全部实机 receipt 齐全。

## 5. 主控监督与复评

主控每个循环只做四件事：

1. 检查本轮是否新增真实原始证据；
2. 运行对应 fail-closed 门禁并保存原始输出；
3. 更新阻塞矩阵，不更新分数快照，直到三线门禁满足；
4. 只有完成一整条线的硬门槛，才重新统计该线分数。

复评统计：

```text
三项平均 = (科研证据 + 论文就绪度 + 生产发行成熟度) / 3
```

当前平均为 `(69 + 47 + 68) / 3 = 61.33/100`。Goal 不能因时间经过或测试次数增加而自动完成。

## 6. 下一步唯一动作

停止继续包装本地门禁，先向外部责任人发出三份提交包并收回原始材料：

- `docs/research/R-EVID-02-EXTERNAL-EVIDENCE-SUBMISSION.zh-CN.md`
- `docs/reviews/PAPER-NONAUTHOR-HANDOFF-CHECKLIST.zh-CN.md`
- `docs/release/RELEASE-EXTERNAL-EVIDENCE-SUBMISSION-PACKET.zh-CN.md`

材料未到位前，状态保持 `RETURN_FOR_REWORK / NO-GO / BLOCKED`；材料到位后再按科研→论文→发行顺序串行验收和重新统计。

### 6.1 当前执行闸门：真实 Provider 采样授权

Doctor 只确认环境变量名称存在，不能视为已授权或已调用。要进入正式采样，必须由授权人明确提供以下非密钥信息：

- `PROVIDER_SMOKE_LIVE=1` 的明确授权；
- Provider、model allowlist、`PROVIDER_SMOKE_OPERATIONS`；
- `PROVIDER_SMOKE_MAX_REQUESTS`、单次预算、总预算和超时；
- 预注册 `approvalId`、候选标识和允许的停止条件。

API key 只从运行环境读取，不写入日志、Markdown、Manifest 或回执正文。未获得上述授权前，不启动 live 调用，也不把 Doctor 的 READY 或环境变量名称计入科研分数。

### 6.2 冻结器与通用校验器已统一

本轮发现并修复了冻结器与通用校验器的口径冲突：旧 smoke draft 继续保持 1 可用/7 阻塞；全窗口权威候选仅允许作为完整的 frozen profile，并要求所有窗口绑定生产入口和 Harness。新增回归测试验证 8 窗口冻结候选可通过统一 Validator。该修复关闭“候选无法统一校验”的工程阻塞，但不改变 `formalVerified=0`，也不替代真实 Provider/Raw。
