# God-Agent 发布检查清单

> 当前结论：**不具备生产发行资格**。本清单是发布硬门禁，不是“已完成证明”。任何必选项未勾选，结论都必须保持 `BLOCKED`。

## 1. 已验证范围与声明边界

- 当前已验证运行范围：Windows `win32`、Node.js `>=20 <21`。
- Electron 可构建、离线可靠性测试可运行，不等于安装包、升级链路或真实模型调用已验证。
- 不得把离线 Provider fixture、桌面壳启动、单机测试通过表述为真实 Provider、跨机器或生产负载验证。
- Linux、macOS、Node 21+、安装器、代码签名、自动更新、灾备恢复目前均不在已验证范围。

## 2. 发布候选冻结

- [ ] 为候选版本确定唯一版本号、源码提交 SHA 和负责人。
- [ ] 工作区无 `.env*`、凭据、私钥、账户配置、本机路径状态或临时文件进入候选清单。
- [ ] `package.json` 与 `package-lock.json` 无漂移，依赖安装使用锁定模式。
- [ ] 候选构建只从冻结源码和锁文件生成；记录 Node、npm、Windows 与 CPU 架构。
- [ ] 所有门禁在同一候选 SHA 上执行，失败后修改必须生成新候选并全量重跑。

## 3. 自动化门禁

在干净的 Windows 环境执行并保存完整输出、退出码和运行环境：

```powershell
npm ci
npm run check
npm run test:discovery
npm test
npm run test:w0-contracts
npm run test:electron
npm run test:benchmarks
npm run test:reproducibility
npm run test:runtime-e2e
npm run test:process-chaos
npm run electron:build
npm run security:scan
npm run release:check
npx --no-install tsx --test tests/runtime-doctor-test.ts tests/generate-sbom-test.ts
npx --no-install tsx scripts/runtime-doctor.ts --json
```

- [ ] 全部命令退出码为 0；不得跳过失败、重跑后只保留成功记录或缩小用例集合。
- [ ] `runtime-doctor` 的 `ready=true`，Node、平台、文件、依赖、构建和临时目录检查全部为 `pass`。
- [ ] Provider 未配置导致的 `warn` 只允许离线候选；若声称真实 Provider 可用，则该候选不得以警告放行。
- [ ] 源码覆盖率门禁、正式测试发现门禁与完整主测试均使用同一候选 SHA。

## 4. SBOM、许可证与供应链

```powershell
npx --no-install tsx scripts/generate-sbom.ts --output dist/release/god-agent.cdx.json
```

- [ ] 生成 CycloneDX 1.5 SBOM，并记录其 SHA-256。
- [ ] SBOM 中每个组件均有名称、版本、purl 和直接/传递关系；许可证只接受锁文件中的明确证据。
- [ ] 对“许可证缺失”的组件完成人工审查；SBOM 不猜许可证，也不替代法务审查。
- [ ] 审核 Electron/Chromium 及所有传递依赖的再分发义务，补齐适用的 `NOTICE`。
- [ ] 执行漏洞扫描、记录数据库更新时间、例外理由、负责人和到期日。
- [ ] 候选源码、锁文件、SBOM、构建产物和安装器分别计算 SHA-256 并加入发布清单。

## 5. 安装器与代码签名（当前未完成）

`npm run release:check` 会 fail-closed 检查 `dist/release/release-artifact.json` 及其四类 receipt；缺少任一项时输出 `release-artifact-evidence: BLOCKING`。该门禁只验证证据文件的一致性，不会把占位 JSON、Electron 构建目录或本地截图当作真实签名/安装验证。可验收的清单必须满足 `docs/RELEASE-ARTIFACT-EVIDENCE-PROTOCOL.md` 中的 schema、工作区内普通文件边界和 SHA-256 约束。

- [ ] 选择并实现 Windows 安装器方案，明确安装目录、开始菜单、卸载、静默安装和最小权限行为。
- [ ] 使用受控证书完成应用与安装器 Authenticode 签名；私钥不得进入仓库、日志或 CI 产物。
- [ ] 在全新 Windows 用户、标准权限账户和受支持架构上验证安装、首次启动、修复安装与卸载。
- [ ] 验证签名链、时间戳、发布者名称和 SmartScreen 体验；保存验证结果。
- [ ] 确认卸载是否保留 `%LOCALAPPDATA%\god-agent` 用户状态，并在 UI/文档中明确告知。

**现状：**仓库目前只有 Electron 构建命令，没有可验收的安装器、签名流水线或证书证据。因此本节是生产发布阻断项。

## 5A. 候选级 SBOM、安全扫描与数据完整性证据（新增硬门禁）

`release:check` 还会 fail-closed 检查 `dist/release/release-supply-chain.json`。该索引必须绑定同一 `candidateRef`，并以 SHA-256 指向三个真实普通文件：

索引还必须包含 `releaseArtifactSha256`，精确绑定同一候选的 `dist/release/release-artifact.json` 字节内容；替换安装包清单或任一 receipt 后必须重新生成索引。

- CycloneDX 1.5 SBOM（`god-agent.cdx.json`）：格式、版本和组件数必须匹配；不得猜测许可证。
- 安全扫描 receipt（`security-scan.json`）：`status=passed`、`findings=[]`、扫描文件数与索引一致；结果必须来自 `npm run security:scan`，不能用说明文字替代。
- 数据完整性 receipt（`data-integrity.json`）：`stateDigestVerified=true`、`backupRestoreVerified=true`、`noDataLoss=true`，并记录升级失败回滚后的状态摘要和原始日志定位。

执行协议与 JSON 模板见 [`docs/release/RELEASE-SUPPLY-CHAIN-EVIDENCE-PROTOCOL.md`](release/RELEASE-SUPPLY-CHAIN-EVIDENCE-PROTOCOL.md)。缺少任一文件、摘要漂移、路径越界、候选漂移、扫描发现或完整性失败均为 `BLOCKED`；本地构建目录、测试夹具或手工填写的“passed”不能放行。

验收命令：

```powershell
npm run check
npm run test:release
npm run test:security
npm run test:sbom
npm run release:check
```

## 6. 升级与回滚（当前未完成）

- [ ] 定义支持的 `N -> N+1` 状态格式迁移和不兼容版本策略。
- [ ] 在关闭所有 God-Agent 进程后，备份 `runtime-state.json`、`runtime-leases.json` 和 `outcome-unknown-resolutions.json`。
- [ ] 使用真实安装器完成 `N` 安装、产生状态、升级 `N+1`、继续任务、卸载/回装 `N`、恢复备份的全链演练。
- [ ] 分别覆盖升级成功、升级中断、磁盘不足、状态损坏与回滚失败；验证无重复副作用和无静默数据丢失。
- [ ] 发布包必须包含可获取的上一稳定版本、校验值、回滚负责人和停止条件。

**现状：**尚无已验证安装器和升级机制，也没有完整回滚演练证据。不得声称“支持无损升级/一键回滚”。

## 7. 长稳、容量与恢复（当前未完成）

长稳 receipt 必须由真实候选产生，`durationSeconds >= 3600`、`failureCount=0`、`recoveryVerified=true`，并以 `evidenceSha256` 绑定原始证据；测试夹具或手工填写字段不能通过门禁。

- [ ] 在测试前冻结持续时间、并发档位、工作负载、通过阈值和终止规则。
- [ ] 至少完成一次面向候选版本的长时间稳定性运行，监测内存、句柄、磁盘增长、延迟、失败率和恢复时间。
- [ ] 覆盖进程崩溃、强制终止、重启、租约过期、磁盘写失败和状态冲突；保存原始日志与状态快照。
- [ ] 使用非开发者机器执行安装后冷启动和持续运行，排除“仅源码工作区可用”。
- [ ] 缺陷修复后重跑完整预注册方案，保留首次失败和复跑证据。

**现状：**已有短时容量/混沌测试不能替代生产长稳。长稳与恢复目标仍是阻断项。

## 8. 真实 Provider（当前未完成）

- [ ] 获得明确的费用、账号、模型、区域和数据处理授权。
- [ ] 先运行离线 Provider fixture，再按 `docs/provider-capability-smoke.md` 的预算上限执行最小真实冒烟。
- [ ] 验证创建、超时、限流、重试、取消和不确定结果处置；不得把本地取消解释为 Provider 已取消。
- [ ] 日志和报告不含 Key、Authorization、完整用户内容或服务端敏感响应。
- [ ] 保存费用、请求数、模型版本和 Provider 条款证据，并记录不支持的能力。

**现状：**没有凭据和费用授权下只允许离线模式；真实 Provider 能力仍未完成。

## 9. 发布批准与交付

- [ ] 工程、科研证据、安全、运维和发布负责人分别签字；签字必须对应同一候选 SHA。
- [ ] 发布说明列出已知限制、状态数据位置、备份方式、故障入口和回滚条件。
- [ ] 安装器、签名、SBOM、校验清单、许可证/NOTICE、运维手册与证据索引一并交付。
- [ ] 发布后观察窗口、值班人、P0/P1 联系方式与停止发布权限已确定。

只有第 2 至第 9 节所有适用硬门禁均有可追溯证据时，才可把结论从 `BLOCKED` 改为 `READY`。
