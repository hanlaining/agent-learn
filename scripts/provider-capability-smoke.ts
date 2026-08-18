import {
  createFixtureTransport,
  loadProviderSmokeConfig,
  runProviderCapabilitySmoke,
} from "../src/llm/provider-capability-smoke.js";

const config = loadProviderSmokeConfig();
const transport = config.mode === "offline" ? createFixtureTransport() : undefined;
const report = await runProviderCapabilitySmoke({ config, ...(transport === undefined ? {} : { transport }) });

// 输出只包含已经脱敏的报告；API Key 永远不会进入 stdout。
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status === "blocked" || report.status === "failed") {
  process.exitCode = 2;
}
