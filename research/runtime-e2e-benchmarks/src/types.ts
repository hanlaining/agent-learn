export const RUNTIME_E2E_VARIANTS = ["baseline", "no-wal", "no-recovery", "no-lease"] as const;
export type RuntimeE2eVariant = typeof RUNTIME_E2E_VARIANTS[number];

export const RUNTIME_E2E_FAMILIES = [
  "model-response-window",
  "tool-effect-window",
  "return-parent-feedback",
  "workflow-stage",
  "snapshot-reload",
  "multi-instance-lease",
] as const;
export type RuntimeE2eFamily = typeof RUNTIME_E2E_FAMILIES[number];

export interface RuntimeE2eFixture {
  schemaVersion: "runtime-e2e-fixture-v1";
  name: "Runtime-E2E-GATE-30" | "Runtime-E2E-GATE-100";
  caseCount: 30 | 100;
  seed: number;
  generatorVersion: "runtime-e2e-generator-v1";
  familyAllocation: Record<RuntimeE2eFamily, number>;
  checkpoints: Record<RuntimeE2eFamily, string[]>;
  variants: RuntimeE2eVariant[];
}

export interface RuntimeE2eScenario {
  caseId: string;
  caseIndex: number;
  scenarioSeed: number;
  family: RuntimeE2eFamily;
  checkpoint: string;
  ordinal: number;
}

export interface RuntimeE2eCaseResult {
  caseId: string;
  caseIndex: number;
  scenarioSeed: number;
  family: RuntimeE2eFamily;
  checkpoint: string;
  variant: RuntimeE2eVariant;
  taskSuccess: boolean;
  recoveryAttempted: boolean;
  recoverySuccess: boolean | null;
  snapshotReloaded: boolean;
  stateFileWrites: number;
  stateFileLoads: number;
  modelCalls: number;
  duplicateModelCalls: number;
  toolEffects: number;
  duplicateToolEffects: number;
  unknownOutcome: boolean;
  evidenceRequired: number;
  evidenceProduced: number;
  evidenceCompleteness: number;
  wallClockDurationMs: number;
  recoveryResult: string;
  productionClasses: string[];
  invariants: string[];
  failureCodes: string[];
}

export interface RuntimeE2eSummary {
  variant: RuntimeE2eVariant;
  cases: number;
  taskSuccess: { count: number; total: number; rate: number };
  recoverySuccess: { count: number; total: number; rate: number };
  duplicateModelCalls: number;
  duplicateToolEffects: number;
  unknownOutcome: { count: number; total: number; rate: number };
  evidenceCompleteness: number;
  wallClockMs: { kind: "measured-local-wall-clock"; total: number; p50: number; p95: number };
}

export interface RuntimeE2eReport {
  schemaVersion: "runtime-e2e-report-v1";
  benchmark: RuntimeE2eFixture["name"];
  fixtureSeed: number;
  generatorVersion: RuntimeE2eFixture["generatorVersion"];
  shard: { index: number; total: number };
  variants: RuntimeE2eVariant[];
  runStartedAt: string;
  implementation: {
    check: "production-runtime";
    persistence: "JsonFileRuntimePersistence";
    runtimeClasses: string[];
    protocolSimulatorUsed: false;
  };
  methodology: {
    provider: { kind: "deterministic-fake"; realApiCalls: false; credentialsRead: false };
    tool: { kind: "deterministic-fake"; effects: "local-temporary-journal" };
    latency: "measured local wall-clock; not production capacity";
    claims: "implementation correctness only; not real-provider or production-capacity evidence";
  };
  environment: { platform: string; arch: string; node: string; local: true };
  summaries: RuntimeE2eSummary[];
  cases: RuntimeE2eCaseResult[];
}
