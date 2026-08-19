import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_E2E_FAMILIES,
  RUNTIME_E2E_VARIANTS,
  type RuntimeE2eFixture,
  type RuntimeE2eScenario,
} from "./types.js";

export async function loadRuntimeE2eFixture(gate: 30 | 100): Promise<RuntimeE2eFixture> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const value = JSON.parse(await readFile(path.join(root, "fixtures", `gate-${gate}.json`), "utf8")) as unknown;
  assertFixture(value, gate);
  return value;
}

export function generateRuntimeE2eScenarios(fixture: RuntimeE2eFixture): RuntimeE2eScenario[] {
  const scenarios: RuntimeE2eScenario[] = [];
  let caseIndex = 0;
  for (const family of RUNTIME_E2E_FAMILIES) {
    const checkpoints = fixture.checkpoints[family];
    for (let ordinal = 0; ordinal < fixture.familyAllocation[family]; ordinal += 1) {
      const checkpoint = checkpoints[ordinal % checkpoints.length]!;
      scenarios.push({
        caseId: `${family}-${String(ordinal + 1).padStart(3, "0")}`,
        caseIndex,
        scenarioSeed: mixSeed(fixture.seed, caseIndex),
        family,
        checkpoint,
        ordinal,
      });
      caseIndex += 1;
    }
  }
  if (scenarios.length !== fixture.caseCount) throw new Error("Runtime-E2E fixture allocation does not match caseCount");
  return scenarios;
}

function assertFixture(value: unknown, gate: 30 | 100): asserts value is RuntimeE2eFixture {
  if (!isRecord(value) || value.schemaVersion !== "runtime-e2e-fixture-v1" ||
    value.name !== `Runtime-E2E-GATE-${gate}` || value.caseCount !== gate ||
    value.generatorVersion !== "runtime-e2e-generator-v1" || !Number.isSafeInteger(value.seed) ||
    !isRecord(value.familyAllocation) || !isRecord(value.checkpoints) || !Array.isArray(value.variants)) {
    throw new Error("Invalid Runtime-E2E fixture");
  }
  for (const family of RUNTIME_E2E_FAMILIES) {
    if (!Number.isSafeInteger(value.familyAllocation[family]) || Number(value.familyAllocation[family]) <= 0 ||
      !Array.isArray(value.checkpoints[family]) || (value.checkpoints[family] as unknown[]).length === 0 ||
      (value.checkpoints[family] as unknown[]).some((item) => typeof item !== "string" || item.length === 0)) {
      throw new Error(`Invalid Runtime-E2E fixture family: ${family}`);
    }
  }
  if (value.variants.length !== RUNTIME_E2E_VARIANTS.length ||
    value.variants.some((item, index) => item !== RUNTIME_E2E_VARIANTS[index])) {
    throw new Error("Invalid Runtime-E2E fixture variants");
  }
}

function mixSeed(seed: number, index: number): number {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  return value >>> 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
