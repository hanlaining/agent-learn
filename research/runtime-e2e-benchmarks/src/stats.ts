import type { RuntimeE2eCaseResult, RuntimeE2eSummary, RuntimeE2eVariant } from "./types.js";

export function summarizeRuntimeE2e(
  variant: RuntimeE2eVariant,
  cases: RuntimeE2eCaseResult[],
): RuntimeE2eSummary {
  const recoveryCases = cases.filter((item) => item.recoveryAttempted);
  const durations = cases.map((item) => item.wallClockDurationMs).sort((a, b) => a - b);
  return {
    variant,
    cases: cases.length,
    taskSuccess: rate(cases.filter((item) => item.taskSuccess).length, cases.length),
    recoverySuccess: rate(recoveryCases.filter((item) => item.recoverySuccess === true).length, recoveryCases.length),
    duplicateModelCalls: sum(cases.map((item) => item.duplicateModelCalls)),
    duplicateToolEffects: sum(cases.map((item) => item.duplicateToolEffects)),
    unknownOutcome: rate(cases.filter((item) => item.unknownOutcome).length, cases.length),
    evidenceCompleteness: cases.length === 0 ? 1 : Number((sum(cases.map((item) => item.evidenceCompleteness)) / cases.length).toFixed(6)),
    wallClockMs: {
      kind: "measured-local-wall-clock",
      total: Number(sum(durations).toFixed(3)),
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
    },
  };
}

function rate(count: number, total: number): { count: number; total: number; rate: number } {
  return { count, total, rate: total === 0 ? 1 : Number((count / total).toFixed(6)) };
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1));
  return values[index]!;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
