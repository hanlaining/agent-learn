# God-Agent 独立安全与生产发行智囊复核

> 日期：2026-08-24（Asia/Shanghai）  
> 对象：`D:\练手\agent-learn-god-latest-audit` 当前共享工作树  
> 边界：未修改 package、lockfile、依赖、README、CI、PPT 或 Git；本轮新增本机可复验的依赖风险硬门。  
> 规则：critical/high 不能被接受、隐藏或降级为 warning；权威审计不可用时必须失败关闭。

## 1. 最终裁决

**生产发行成熟度：68/100，`No-Go / BLOCKED`。**

当前工程原型已有 113/113 测试发现、699 项主测试中 698 pass + 1 个权限条件 skip、0 fail，并有 Electron、Doctor、安全扫描、确定性 SBOM 和 V2/V3 兼容证据。本轮进一步把官方 npm audit 接入 `release:check`：即使其余 11 项全绿，3 个 high 仍会独立使发行门禁失败。

门禁变严格提高的是证据可信度，不是把未修漏洞变成已完成能力。因此评分保持 68，不因新增检查虚增。

| 维度 | 权重 | 当前分 | 判断 |
|---|---:|---:|---|
| Electron、IPC 与网页安全边界 | 25 | 21 | Electron 74/74；沙箱、权限、Preview 和输入边界较扎实 |
| 供应链、Secret 与 SBOM | 20 | 10 | Secret 0 命中、SBOM 169/169 许可证字段；3 high 仍未修 |
| 测试、CI 与候选证明链 | 20 | 15 | 本地稳定证据恢复；无远端同 SHA、签名 provenance 与独立复验 |
| 安装、签名与普通用户交付 | 20 | 10 | 仍只有源码构建目录；无安装器、签名、时间戳和干净机 |
| 升级、回滚、恢复与长稳 | 15 | 12 | WAL/Lease/Unknown Outcome 较成熟；缺升级回滚、断电、备份恢复与长稳 |
| **合计** | **100** | **68** | **低于 95，禁止生产发行** |

## 2. 当前稳定证据

| 项目 | 结果 | 能证明 | 不能证明 |
|---|---|---|---|
| TypeScript | 通过 | 当前类型边界闭合 | 生产稳定性 |
| 测试发现 | 113/113 | 正式测试均被 scripts 覆盖 | 所有环境均通过 |
| 主测试 | 699：698 pass、1 条件 skip、0 fail | 最新稳定候选主测试绿色 | 可靠性概率或远端 CI |
| 覆盖 | 25,896/28,576 = 90.6215%；loaded 114/122 | 超过当前 90.25%/93% 门槛 | 达到 95% 覆盖 |
| V3 / V2 兼容 | V3 4/4；V2 核心与恢复 26/26 | V3 流程和旧 V2 恢复语义可同时工作 | 真人现场、长稳或外部复现 |
| Process Chaos / GATE-40 | 17/17；local 40/40 | 本地候选功能 pilot 可运行 | formal Verified；当前仍为 0 |
| Electron | 74/74 | Electron 专项绿色 | 安装后普通用户环境 |
| Doctor | 7/7 | 当前 Windows/Node 20/依赖/构建目录可用 | Key 有效、跨机器或生产可用 |
| Secret 扫描 | 539/540 文件候选，0 高置信凭据 | 当前文件系统候选未命中内置规则 | Git 历史、SAST、依赖漏洞 |
| SBOM | CycloneDX 1.5；169 组件；license evidence 169/169 | lockfile 可确定性生成供应链清单 | 法务批准或无漏洞 |
| Release 判定器专项 | 8/8 | clean/high/unavailable/漂移/Secret 等正反例通过 | 当前生产可发行 |
| Release 端到端 | 11 pass、1 blocking | 其余结构门已绿，3 high 独立阻断 | production-ready |

## 3. 本轮真实增量：权威依赖风险硬门

`scripts/dependency-risk-gate.ts` 会：

1. 明确调用 `https://registry.npmjs.org/` 的 `npm audit --json`；
2. 解析 critical/high 计数和对应 package/advisory；
3. critical 或 high 非零时返回 BLOCKED 和非零退出码；
4. 网络、npm、超时、无效 JSON、缺字段或计数/明细矛盾时失败关闭；
5. 只输出包名、严重度和允许的公开 advisory URL，不回显环境凭据；
6. 不提供“接受风险”“忽略 high”或降低阈值的入口。

`release-readiness.ts` 新增独立 `dependency-risk` 检查。测试可注入审计报告验证判定逻辑；默认真实运行始终访问权威源，测试注入不冒充生产审计。

当前真实结果：

- Dependency risk gate：BLOCKED；
- Registry：`https://registry.npmjs.org/`；
- Unresolved：0 critical、3 high；
- Electron：GHSA-9f4c-93c8-jc8g，并保留 GHSA-r4w5-6pfg-jxp5 关联信息；
- extract-zip：GHSA-jmr9-qjv8-65gv；
- nanoid：GHSA-2v37-7h3g-55p8。

当前端到端发行输出为 11 pass、0 warning、1 blocking；唯一 blocking 是 3 high。这关闭了此前“文档知道有 3 high，但 local release 仍显示 READY”的证据漏洞。

## 4. SBOM 与边界

当前 SBOM 为 169 个组件、许可证字段 169/169。确定性清单能追踪 package/lockfile/依赖图漂移；它不替代漏洞审计、许可证人工审查、制品签名或构建 provenance。

必须保留：

- SBOM 完整 ≠ 0 漏洞；
- 0 Secret 命中 ≠ 无安全缺陷；
- Doctor 7/7 ≠ 干净机安装通过；
- 其余 11 项通过 ≠ 可以接受 3 high；
- local 40/40 ≠ formal Verified。

## 5. 生产 95+ 硬门

### P0：任一未完成都保持 No-Go

1. 经授权升级并清零 Electron、extract-zip、nanoid 的 3 high，权威硬门返回 0 critical / 0 high；
2. 依赖变化后重跑 699 项主测试、覆盖、Electron、Process Chaos、安全、SBOM、Doctor 和 release；
3. 生成可离开源码目录安装、卸载和冷启动的 Windows 制品；
4. 完成 Authenticode、RFC 3161 时间戳和签名验证；
5. 在干净标准权限 Windows 机器由第二执行者完成安装、首次启动、冷启动与卸载；
6. 远端同 SHA CI 保存日志、SBOM、安装器、哈希与 provenance。

### P1：95 分前仍不可缺

1. `N -> N+1 -> N` 迁移、升级中断、磁盘不足、文件占用与回滚失败；
2. 备份校验、损坏隔离、断电语义、RTO/RPO 与正式长稳；
3. 真实 Provider 的鉴权、限流、取消、费用、查询和 unknown 语义；
4. 安全、运维、发行责任人的同候选批准与撤回演练。

## 6. Go / No-Go

- V2/V3 本地兼容专项：**Go**；
- 本地安全扫描与 SBOM：**Go，但只在各自声明范围内**；
- 当前依赖风险：**No-Go（3 high）**；
- 当前生产发行：**No-Go / BLOCKED（68/100）**。

准确对外口径：

> 最新 God-Agent 已有 113/113 测试发现、698 pass + 1 条件 skip、90.6215% 源码行覆盖、V3 4/4、V2 恢复兼容 26/26、Electron 74/74、Doctor 7/7、Secret 扫描 0 命中和 169 组件 SBOM。发行门禁现在会实时访问官方 npm registry，并因 Electron、extract-zip、nanoid 的 3 个 high 强制 BLOCKED；签名安装、升级回滚、长稳、干净机与真实 Provider 也尚未完成，因此不能生产发行。
