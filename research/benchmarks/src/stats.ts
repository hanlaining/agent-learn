import type { BenchmarkCaseResult, BenchmarkSummary, BenchmarkVariant, RateMetric } from "./types.js";

export function summarize(variant: BenchmarkVariant, cases: BenchmarkCaseResult[]): BenchmarkSummary {
  const recoveryCases = cases.filter((item) => item.recoveryAttempted);
  const unknownCount = cases.filter((item) => item.unknownOutcome).length;
  const input = sum(cases.map((item) => item.inputTokens));
  const output = sum(cases.map((item) => item.outputTokens));
  return {
    variant,
    cases: cases.length,
    taskSuccess: rate(cases.filter((item) => item.taskSuccess).length, cases.length),
    recoverySuccess: rate(recoveryCases.filter((item) => item.recoverySuccess === true).length, recoveryCases.length),
    duplicateModelCalls: sum(cases.map((item) => item.duplicateModelCalls)),
    duplicateToolEffects: sum(cases.map((item) => item.duplicateToolEffects)),
    unknownOutcomeRate: rate(unknownCount, cases.length),
    evidenceCompleteness: round(mean(cases.map((item) => item.evidenceCompleteness)), 6),
    latencyMs: {
      kind: "deterministic-simulated",
      p50: percentile(cases.map((item) => item.latencyMs), 0.5),
      p95: percentile(cases.map((item) => item.latencyMs), 0.95),
    },
    tokens: { input, output, total: input + output },
    costEstimateUsd: round(sum(cases.map((item) => item.costEstimateUsd)), 8),
  };
}

function rate(count: number, total: number): RateMetric {
  return { count, total, rate: total === 0 ? 0 : round(count / total, 6) };
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)] ?? 0;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
