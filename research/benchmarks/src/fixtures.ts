import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deterministicInt, mixSeed } from "./random.js";
import {
  BENCHMARK_VARIANTS,
  SCENARIO_CATEGORIES,
  type BenchmarkScenario,
  type GateFixture,
  type ScenarioCategory,
} from "./types.js";

const BENCHMARK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function loadFixture(gate: 30 | 100, seedOverride?: number): Promise<GateFixture> {
  const filename = path.join(BENCHMARK_ROOT, "fixtures", `gate-${gate}.json`);
  const value: unknown = JSON.parse(await readFile(filename, "utf8"));
  assertFixture(value, gate);
  if (seedOverride === undefined) return value;
  if (!Number.isInteger(seedOverride) || seedOverride < 0) {
    throw new Error("Fixture seed override must be a non-negative integer");
  }
  return { ...value, seed: seedOverride };
}

export function generateScenarios(fixture: GateFixture): BenchmarkScenario[] {
  const categories = SCENARIO_CATEGORIES.flatMap((category) =>
    Array.from({ length: fixture.categoryAllocation[category] }, () => category));
  if (categories.length !== fixture.caseCount) throw new Error("Fixture category allocation does not match caseCount");
  return categories.map((category, index) => scenarioFor(fixture, category, index));
}

function scenarioFor(fixture: GateFixture, category: ScenarioCategory, index: number): BenchmarkScenario {
  const seed = mixSeed(fixture.seed, index);
  const ordinal = index + 1;
  const crashPoint = crashPointFor(category, ordinal);
  return {
    caseId: `gate-${fixture.caseCount}-${String(ordinal).padStart(3, "0")}`,
    caseIndex: index,
    seed,
    category,
    crashPoint,
    childCount: category === "parent-child" ? deterministicInt(seed >>> 3, 2, 5) : 1,
    duplicateDeliveries: category === "duplicate-delivery" ? deterministicInt(seed >>> 5, 1, 3) : 0,
    contended: category === "parent-child" || (category === "side-effect-safety" && ordinal % 2 === 0),
    sideEffectful: category === "side-effect-safety",
    evidenceRequired: category === "completion-quality" ? deterministicInt(seed >>> 7, 3, 5) : 2,
    inputTokensPerModelCall: deterministicInt(seed >>> 9, 220, 520),
    outputTokensPerModelCall: deterministicInt(seed >>> 11, 80, 240),
    baseLatencyMs: deterministicInt(seed >>> 13, 18, 55),
  };
}

function crashPointFor(category: ScenarioCategory, ordinal: number): BenchmarkScenario["crashPoint"] {
  if (category === "crash-recovery") return ordinal % 2 === 0 ? "after-tool" : "after-model";
  if (category === "parent-child") return "parent-waiting";
  if (category === "side-effect-safety") return "after-tool";
  if (category === "completion-quality" && ordinal % 2 === 0) return "after-model";
  return "none";
}

function assertFixture(value: unknown, gate: 30 | 100): asserts value is GateFixture {
  if (value === null || typeof value !== "object") throw new Error("Fixture must be an object");
  const fixture = value as Partial<GateFixture>;
  if (fixture.schemaVersion !== "gate-fixture-v1" || fixture.generatorVersion !== "gate-generator-v1") throw new Error("Unsupported fixture version");
  if (fixture.caseCount !== gate || fixture.name !== `GATE-${gate}`) throw new Error("Fixture gate identity mismatch");
  if (!Number.isInteger(fixture.seed)) throw new Error("Fixture seed must be an integer");
  if (fixture.categoryAllocation === undefined || SCENARIO_CATEGORIES.some((key) => !Number.isInteger(fixture.categoryAllocation?.[key]))) throw new Error("Invalid category allocation");
  if (!Array.isArray(fixture.variants) || fixture.variants.some((item) => !BENCHMARK_VARIANTS.includes(item))) throw new Error("Invalid variants");
  if (fixture.pricing?.currency !== "USD" || typeof fixture.pricing.inputPerMillionTokens !== "number" || typeof fixture.pricing.outputPerMillionTokens !== "number") throw new Error("Invalid pricing fixture");
}
