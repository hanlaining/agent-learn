# Research Artifact Manifest v0.1

此入口只归档离线科研产物，不读取环境变量、凭据或真实 Provider。Manifest 必须位于 Artifact 根目录内，自身不会进入哈希列表；验证会拒绝缺失、篡改和任何未登记文件。

从仓库根目录创建：

```powershell
npx tsx research/reproducibility/src/cli.ts create --root research/example-artifact --baseline-commit e65767f960967a21ab2191503363e53280d4ba62 --command "npm run benchmark:gate30" --started-at 2026-08-20T01:00:00.000Z --finished-at 2026-08-20T01:05:00.000Z --provider deterministic-fake
```

验证：

```powershell
npx tsx research/reproducibility/src/cli.ts verify --root research/example-artifact
```

也可用 `--manifest metadata/artifact-manifest.json` 指定根目录内的相对 Manifest 路径。不要在 `--command` 中写绝对路径、环境变量赋值、Token、Key 或其他凭据。`--provider` 只接受 `none` 或 `deterministic-fake`，两者都明确声明没有真实 API 调用且没有读取凭据。

专项测试：

```powershell
npx tsx --test research/reproducibility/tests/manifest-test.ts
```
