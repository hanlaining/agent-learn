export const BENCHMARK_VARIANTS = ["baseline", "no-wal", "no-recovery", "no-lease"] as const;
export type BenchmarkVariant = typeof BENCHMARK_VARIANTS[number];

export const SCENARIO_CATEGORIES = [
  "crash-recovery",
  "parent-child",
  "duplicate-delivery",
  "side-effect-safety",
  "completion-quality",
] as const;
export type ScenarioCategory = typeof SCENARIO_CATEGORIES[number];

export type CrashPoint = "none" | "after-model" | "after-tool" | "parent-waiting";

export interface GateFixture {
  schemaVersion: "gate-fixture-v1";
  name: "GATE-30" | "GATE-100";
  caseCount: 30 | 100;
  seed: number;
  generatorVersion: "gate-generator-v1";
  categoryAllocation: Record<ScenarioCategory, number>;
  variants: BenchmarkVariant[];
  pricing: {
    currency: "USD";
    inputPerMillionTokens: number;
    outputPerMillionTokens: number;
    note: string;
  };
}

export interface BenchmarkScenario {
  caseId: string;
  caseIndex: number;
  seed: number;
  category: ScenarioCategory;
  crashPoint: CrashPoint;
  childCount: number;
  duplicateDeliveries: number;
  contended: boolean;
  sideEffectful: boolean;
  evidenceRequired: number;
  inputTokensPerModelCall: number;
  outputTokensPerModelCall: number;
  baseLatencyMs: number;
}

export interface VariantPolicy {
  variant: BenchmarkVariant;
  wal: boolean;
  recovery: boolean;
  lease: boolean;
}

export interface BenchmarkCaseResult {
  caseId: string;
  caseIndex: number;
  scenarioSeed: number;
  category: ScenarioCategory;
  variant: BenchmarkVariant;
  taskSuccess: boolean;
  recoveryAttempted: boolean;
  recoverySuccess: boolean | null;
  modelCalls: number;
  duplicateModelCalls: number;
  toolEffects: number;
  duplicateToolEffects: number;
  unknownOutcome: boolean;
  evidenceRequired: number;
  evidenceProduced: number;
  evidenceCompleteness: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costEstimateUsd: number;
  failureCodes: string[];
  trace: string[];
}

export interface RateMetric {
  count: number;
  total: number;
  rate: number;
}

export interface BenchmarkSummary {
  variant: BenchmarkVariant;
  cases: number;
  taskSuccess: RateMetric;
  recoverySuccess: RateMetric;
  duplicateModelCalls: number;
  duplicateToolEffects: number;
  unknownOutcomeRate: RateMetric;
  evidenceCompleteness: number;
  latencyMs: {
    kind: "deterministic-simulated";
    p50: number;
    p95: number;
  };
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  costEstimateUsd: number;
}

export interface BenchmarkReport {
  schemaVersion: "gate-benchmark-result-v1";
  benchmark: "GATE-30" | "GATE-100";
  fixtureSeed: number;
  generatorVersion: "gate-generator-v1";
  deterministic: true;
  shard: {
    index: number;
    total: number;
  };
  variants: BenchmarkVariant[];
  pricing: GateFixture["pricing"];
  methodology: {
    provider: "deterministic-mock";
    latency: "logical simulated milliseconds; not wall-clock production latency";
    cost: "token count multiplied by fixture-pinned comparison rates; not a provider bill";
  };
  summaries: BenchmarkSummary[];
  cases: BenchmarkCaseResult[];
}
