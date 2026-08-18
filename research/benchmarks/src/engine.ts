import type {
  BenchmarkCaseResult,
  BenchmarkScenario,
  BenchmarkVariant,
  GateFixture,
  VariantPolicy,
} from "./types.js";

export const POLICIES: Record<BenchmarkVariant, VariantPolicy> = {
  baseline: { variant: "baseline", wal: true, recovery: true, lease: true },
  "no-wal": { variant: "no-wal", wal: false, recovery: true, lease: true },
  "no-recovery": { variant: "no-recovery", wal: true, recovery: false, lease: true },
  "no-lease": { variant: "no-lease", wal: true, recovery: true, lease: false },
};

export function runScenario(
  scenario: BenchmarkScenario,
  variant: BenchmarkVariant,
  pricing: GateFixture["pricing"],
): BenchmarkCaseResult {
  const policy = POLICIES[variant];
  const trace: string[] = [
    `policy:wal=${policy.wal},recovery=${policy.recovery},lease=${policy.lease}`,
    `scenario:${scenario.category},crash=${scenario.crashPoint}`,
  ];
  const primaryModelUnits = scenario.category === "parent-child" ? scenario.childCount + 1 : 1;
  const workerCopies = !policy.lease && scenario.contended ? 2 : 1;
  let modelCalls = primaryModelUnits * workerCopies;
  let duplicateModelCalls = primaryModelUnits * (workerCopies - 1);
  let toolEffects = scenario.sideEffectful ? workerCopies : 0;
  let duplicateToolEffects = scenario.sideEffectful ? workerCopies - 1 : 0;

  if (workerCopies > 1) trace.push("lease-disabled:concurrent-worker-copy-executed");

  if (scenario.duplicateDeliveries > 0) {
    if (policy.wal) {
      trace.push(`wal:deduplicated-${scenario.duplicateDeliveries}-deliveries`);
    } else {
      const replayCalls = primaryModelUnits * workerCopies * scenario.duplicateDeliveries;
      modelCalls += replayCalls;
      duplicateModelCalls += replayCalls;
      trace.push(`wal-disabled:replayed-${scenario.duplicateDeliveries}-deliveries`);
    }
  }

  const recoveryAttempted = scenario.crashPoint !== "none";
  let completed = true;
  if (recoveryAttempted) {
    trace.push(`fault-injected:${scenario.crashPoint}`);
    if (!policy.recovery) {
      completed = false;
      trace.push("recovery-disabled:terminal-incomplete");
    } else if (!policy.wal) {
      if (scenario.crashPoint === "parent-waiting") {
        modelCalls += 1;
        duplicateModelCalls += 1;
        trace.push("wal-disabled:parent-synthesis-replayed");
      } else {
        modelCalls += workerCopies;
        duplicateModelCalls += workerCopies;
        trace.push("wal-disabled:model-invocation-replayed");
      }
      if (scenario.crashPoint === "after-tool" && scenario.sideEffectful) {
        toolEffects += workerCopies;
        duplicateToolEffects += workerCopies;
        trace.push("wal-disabled:side-effect-replayed");
      }
    } else {
      trace.push("wal:checkpoint-resumed-without-replay");
    }
  }

  const unknownOutcome = recoveryAttempted
    && scenario.crashPoint === "after-tool"
    && scenario.sideEffectful
    && (!policy.wal || !policy.recovery);
  if (unknownOutcome) trace.push("side-effect:outcome-unknown");

  let evidenceProduced = completed ? scenario.evidenceRequired : Math.max(0, scenario.evidenceRequired - 1 - (scenario.seed % scenario.evidenceRequired));
  if (unknownOutcome) evidenceProduced = Math.max(0, evidenceProduced - 1);
  const evidenceCompleteness = round(evidenceProduced / scenario.evidenceRequired, 6);
  const taskSuccess = completed && !unknownOutcome && duplicateToolEffects === 0 && evidenceCompleteness === 1;
  const recoverySuccess = recoveryAttempted ? taskSuccess : null;
  const failureCodes: string[] = [];
  if (!completed) failureCodes.push("recovery-disabled");
  if (duplicateToolEffects > 0) failureCodes.push("duplicate-tool-effect");
  if (unknownOutcome) failureCodes.push("unknown-side-effect-outcome");
  if (evidenceCompleteness < 1) failureCodes.push("incomplete-evidence");

  const inputTokens = modelCalls * scenario.inputTokensPerModelCall;
  const outputTokens = modelCalls * scenario.outputTokensPerModelCall;
  const costEstimateUsd = round(
    (inputTokens * pricing.inputPerMillionTokens + outputTokens * pricing.outputPerMillionTokens) / 1_000_000,
    8,
  );
  const latencyMs = scenario.baseLatencyMs
    + modelCalls * (14 + Math.ceil(scenario.outputTokensPerModelCall / 20))
    + toolEffects * 11
    + Math.max(0, scenario.childCount - 1) * 5
    + (recoveryAttempted ? policy.recovery ? 20 : 3 : 0);

  return {
    caseId: scenario.caseId,
    caseIndex: scenario.caseIndex,
    scenarioSeed: scenario.seed,
    category: scenario.category,
    variant,
    taskSuccess,
    recoveryAttempted,
    recoverySuccess,
    modelCalls,
    duplicateModelCalls,
    toolEffects,
    duplicateToolEffects,
    unknownOutcome,
    evidenceRequired: scenario.evidenceRequired,
    evidenceProduced,
    evidenceCompleteness,
    latencyMs,
    inputTokens,
    outputTokens,
    costEstimateUsd,
    failureCodes,
    trace,
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
