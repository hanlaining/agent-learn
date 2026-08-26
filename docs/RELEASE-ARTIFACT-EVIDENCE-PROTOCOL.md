# 发行物、签名、干净机、升级回滚与长稳证据协议

## 目的与边界

本协议把“具备发行物证据”与“生产放行”严格分开。`scripts/release-artifact-gate.ts` 只校验由真实构建、签名、干净机器验收、升级/回滚演练及长稳运行产生的 receipt；它不会执行签名、不会调用 Provider，也不会把 Electron build、Doctor READY、离线 fixture 或 local pilot 解释为生产就绪。

任何必需证据缺失、摘要漂移、路径越界、签名字段不完整、独立执行身份缺失、升级回滚未验证或长稳时长不足，均必须 `BLOCKED`。

## 候选清单格式

候选文件默认位置：`dist/release/release-artifact.json`。必须包含：

- 唯一 `candidateRef`、ISO `createdAt`；
- 工作区内普通文件形式的安装包和 SHA-256；
- 时间戳 Authenticode 验签 receipt、证书主体和 receipt 路径；
- 独立执行者与干净机器标识、安装/启动/卸载结果；
- `N → N+1` 升级与回滚 receipt，且声明 `rollbackVerified=true`；
- 至少 3600 秒长稳运行的日志摘要和 SHA-256；
- 固定边界：`artifact-evidence-only-not-provider-not-production-approval`。

## 验证命令

```powershell
npx --no-install tsx --test tests/release-artifact-gate-cases.ts
npx --no-install tsx scripts/release-artifact-gate.ts
```

通过只表示上述发行物证据文件彼此一致。生产发行仍需同时满足 `release:check`、官方依赖风险门禁、security、SBOM、Doctor、Electron、科研证据和非作者复核；官方 high 漏洞、旧 evidence 数字、缺少真实签名包或缺少干净机证据时保持 `BLOCKED / NO-GO`。

## 当前状态

- 本地 fail-closed 协议测试：3/3 通过。
- 当前仓库没有真实签名安装包、干净 Windows receipt、升级/回滚实机 receipt 或长稳原始证据，因此不得创建虚假候选清单，不得宣称 READY。
- 当前 `release:check` 仍受官方依赖审计 3 个 high 与 README evidence drift 阻断。
