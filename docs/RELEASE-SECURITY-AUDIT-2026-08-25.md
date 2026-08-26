# Release / Security Fail-Closed Audit Record

日期：2026-08-25  
Worktree：`D:\练手\agent-learn-god-latest-audit`  
分支：`logo-refresh_hln`

## 本切片边界

仅覆盖发行就绪、安全扫描、SBOM、Runtime Doctor 与 Runtime State Recovery 的独占脚本/测试；未修改依赖、`package-lock.json`、覆盖率分母/阈值或共享执行总账，未读取或输出任何密钥，未 commit/push/PR。

## 新增 fail-closed 覆盖

- Release readiness：畸形版本、CI 命令缺失、敏感凭据文件名、官方审计高危与审计证据缺失。
- Runtime recovery：备份正向路径、篡改/额外文件/候选漂移、覆盖保护、代际与精确摘要回滚前置条件。
- SBOM：manifest 字段篡改、锁文件/依赖漂移、非法安装路径、工作区外路径与符号链接输入拒绝；输入文件必须为工作区内普通文件。
- Security：凭据不回显、路径穿越/绝对路径/目录拒绝、超大/二进制跳过、低熵误报抑制、符号链接拒绝。
- Doctor：Node/平台/文件/依赖/构建/临时目录故障失败关闭；仅 `OPENAI_BASE_URL`/`OPENAI_MODEL` 不得冒充真实 Provider 已配置。

新增断言超过 10 个。Windows 当前无创建符号链接权限，相关测试按测试框架标记 skip；实现仍保持符号链接 fail-closed。

## 验收命令与结果

| 命令 | 结果 |
|---|---|
| `npm run check` | PASS |
| `npm run test:release` | PASS（13 tests） |
| `npm run test:security` | PASS（6 pass，1 symlink skip） |
| `npm run test:sbom` | PASS（7 pass，1 symlink skip） |
| `npm run test:doctor` | PASS（6 tests） |
| `npm run security:scan` | PASS（590/591 candidate text files scanned） |
| `npm run sbom:generate` | PASS，生成 `.tmp/release/bom.cdx.json` |
| `npm run doctor -- --json` | PASS/READY；7 checks pass |
| `npm run evidence:verify` | BLOCKED：`README.md` evidence drift，缺少 `113/113` |
| `npm run release:check` | BLOCKED：官方依赖审计 `0 critical, 3 high`，以及 evidence drift |

官方依赖审计的 3 high 原样保留：`electron`（2 条 advisory）、`extract-zip`、`nanoid`。未修改依赖或锁文件以掩盖该阻断。

## 结论

当前发行结论：**BLOCKED / NO-GO**。Electron 构建产物存在仅证明本地结构检查通过，不等于真实 Provider、安装器、签名或生产批准已验证。Provider 相关检查只确认环境变量名称存在且不读取值；没有真实 Provider 调用证据。

## 2026-08-26 发行物证据门禁接入复验

本轮将既有 `scripts/release-artifact-gate.ts` 接入 `scripts/release-readiness.ts`。`release:check` 现在额外要求 `dist/release/release-artifact.json`，并逐项验证：

- 安装器为工作区内普通文件且 SHA-256 与清单一致；
- 时间戳 Authenticode receipt、证书主体、验证工具和候选引用一致；
- 独立执行者/干净 Windows 机器的安装、启动、卸载结果齐全；
- `N → N+1` 升级及回滚 receipt 声明状态完整性和 `rollbackVerified=true`；
- 长稳 receipt 至少 3600 秒、零失败、恢复已验证，并以 SHA-256 绑定原始证据。

缺少清单、任一 receipt、摘要漂移、候选漂移、路径越界或关键字段不完整均为阻断；此门禁不执行签名/安装，不把测试夹具或本地结构检查升级为生产证明。

### 本轮原始验收

| 命令 | 结果 |
|---|---|
| `npm run test:release` | PASS（13/13） |
| `npm run check` | PASS（TypeScript 无诊断） |
| `npm run release:check` | BLOCKED：官方依赖审计 3 high、README evidence drift 缺少 113/113、缺少 `dist/release/release-artifact.json` |

实际修改仅限：`scripts/release-readiness.ts`、`tests/release-readiness-test.ts`、`docs/RELEASE-CHECKLIST.md`、本审计文档。未修改依赖、锁文件、正式证据状态或生产声明；覆盖率分母/阈值未变化。

## 2026-08-26 供应链与数据完整性证据门禁增强

新增 `release-supply-chain-evidence` 检查，要求真实候选提供并绑定同一 `candidateRef` 的：

- CycloneDX 1.5 SBOM、组件计数和 SHA-256；
- `god-agent-security-scan-v1` 安全扫描 receipt，零 findings 且扫描文件数一致；
- `god-agent-data-integrity-v1` 数据完整性 receipt，状态摘要、备份/恢复、无数据丢失三项均为真。

所有证据必须是工作区内普通文件，索引和原始文件摘要一致；缺失、篡改、路径越界、候选漂移或未知字段均 fail-closed。门禁只验证候选证据一致性，不把本地构建、测试夹具、说明文档或手工 `passed` 升级为生产证明。执行字段和验收顺序见 `docs/release/RELEASE-SUPPLY-CHAIN-EVIDENCE-PROTOCOL.md`。

本轮原始结果：

| 命令 | 结果 |
|---|---|
| `npm run check` | PASS |
| `npm run test:release` | PASS（15/15） |
| `npm run test:security` | 待主控串行收口时运行 |
| `npm run test:sbom` | 待主控串行收口时运行 |
| `npm run release:check` | 预计仍 BLOCKED：真实发行物证据、官方 high 风险与 README evidence drift 尚未补齐 |

实际生产完整度不因本地门禁增强而上调；没有真实签名安装包、干净 Windows receipt、升级失败回滚、长稳和官方依赖风险处置时，仍为 `BLOCKED / NO-GO`。
