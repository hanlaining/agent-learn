import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runProcessChaosHarness } from "../src/process-chaos-harness.js";
import {
  PROCESS_CHAOS_REPORT_SCHEMA_VERSION,
  PROCESS_CHAOS_REPRO_COMMAND,
  processChaosReproCommand,
  validateProcessChaosReport,
} from "../src/process-chaos-schema.js";

test("Team Workflow Return 窄范围 E3 报告通过运行时校验和 JSON Schema", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "god-agent-process-chaos-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const seed = "rra-02-seed-1";
  const caseDirectory = path.join(directory, `process-chaos-${seed}`);
  const report = await runProcessChaosHarness(directory, seed);
  validateProcessChaosReport(report);

  const jsonSchema = JSON.parse(await readFile(
    path.resolve("research/runtime-e2e-benchmarks/schema/process-chaos-report.schema.json"),
    "utf8",
  )) as Record<string, unknown>;
  assert.deepEqual(collectJsonSchemaErrors(report, jsonSchema, jsonSchema), []);
  assert.equal(report.schemaVersion, PROCESS_CHAOS_REPORT_SCHEMA_VERSION);
  assert.equal(report.reproCommand, processChaosReproCommand(seed));
  assert.equal(report.statePath, "runtime-state.json");
  assert.equal(report.rawReportPath, "process-chaos-report.json");
  assert.deepEqual(report.experiment, {
    id: "team-workflow-return-narrow-e3-v1",
    scope: "Team Workflow Return",
    evidenceLevel: "narrow-E3",
    formalFaultWindowCount: 1,
    gate40CompletedWindows: 1,
    gate40TotalWindows: 40,
    completeE3Matrix: false,
    completeGate40: false,
    exactlyOnceClaimed: false,
    productionReadyClaimed: false,
  });
  assert.equal(report.windows.filter((item) => item.countsTowardGate40).length, 1);
  assert.equal(report.environment.provider.realApiCalls, false);
  assert.equal(report.environment.provider.credentialsRead, false);
  assert.equal(report.evidence.fakeProvider.finalDeliveryRequestsBeforeKill, 1);
  assert.equal(report.evidence.fakeProvider.finalDeliveryRequestsAfterRecovery, 1);
  assert.equal(
    Object.values(report.evidence.fakeProvider.requestsByStage).reduce((sum, count) => sum + count, 0),
    report.evidence.fakeProvider.totalRequests,
  );
  assert.equal(report.pidTransitions.every((item) => item.changed), true);
  assert.equal(report.pidTransitions.every((item) => !isProcessAlive(item.previousPid) && !isProcessAlive(item.successorPid)), true);
  await assert.rejects(access(path.join(caseDirectory, ".transient")));
  await access(path.join(caseDirectory, report.statePath));
  assert.deepEqual(JSON.parse(await readFile(path.join(caseDirectory, report.rawReportPath), "utf8")), report);

  const overclaim = structuredClone(report);
  overclaim.experiment.completeGate40 = true as false;
  assert.throws(() => validateProcessChaosReport(overclaim), /schema violation: experiment/u);
  const falseProviderCount = structuredClone(report);
  falseProviderCount.evidence.fakeProvider.totalRequests += 1;
  assert.throws(() => validateProcessChaosReport(falseProviderCount), /schema violation: evidence/u);

  const extraFieldMutations: Array<(value: Record<string, unknown>) => void> = [
    (value) => { value.unexpected = true; },
    (value) => { (value.experiment as Record<string, unknown>).unexpected = true; },
    (value) => {
      const environment = value.environment as Record<string, unknown>;
      (environment.provider as Record<string, unknown>).unexpected = true;
    },
    (value) => { (value.environment as Record<string, unknown>).unexpected = true; },
    (value) => {
      const transitions = value.pidTransitions as Array<Record<string, unknown>>;
      transitions[0]!.unexpected = true;
    },
    (value) => {
      const windows = value.windows as Array<Record<string, unknown>>;
      windows[1]!.unexpected = true;
    },
    (value) => {
      const evidence = value.evidence as Record<string, unknown>;
      (evidence.fakeProvider as Record<string, unknown>).unexpected = true;
    },
    (value) => { (value.evidence as Record<string, unknown>).unexpected = true; },
    (value) => {
      const evidence = value.evidence as Record<string, unknown>;
      (evidence.providerRequestsByStage as Record<string, unknown>).unexpected = 1;
    },
  ];
  for (const mutate of extraFieldMutations) {
    const invalid = structuredClone(report) as unknown as Record<string, unknown>;
    mutate(invalid);
    assert.throws(() => validateProcessChaosReport(invalid), /schema violation/u);
    assert.notDeepEqual(collectJsonSchemaErrors(invalid, jsonSchema, jsonSchema), []);
  }

  const unsafePaths = [
    { field: "statePath", value: path.resolve(caseDirectory, "runtime-state.json") },
    { field: "rawReportPath", value: "../process-chaos-report.json" },
    { field: "rawReportPath", value: "nested\\process-chaos-report.json" },
  ] as const;
  for (const unsafe of unsafePaths) {
    const invalid = structuredClone(report) as unknown as Record<string, unknown>;
    invalid[unsafe.field] = unsafe.value;
    assert.throws(() => validateProcessChaosReport(invalid), /schema violation: artifact-paths/u);
    assert.notDeepEqual(collectJsonSchemaErrors(invalid, jsonSchema, jsonSchema), []);
  }
});

test("Process Chaos CLI 失败返回非零并输出稳定复现命令", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "god-agent-process-chaos-cli-"));
  try {
    const result = await runChild([
      "--import", "tsx",
      "research/runtime-e2e-benchmarks/src/process-chaos-cli.ts",
      "--seed", "unsafe seed",
      "--output", directory,
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^\[process-chaos\] FAIL$/mu);
    assert.match(result.stderr, /Team Workflow Return narrow E3 \(1\/40\)/u);
    assert.match(result.stderr, /not complete E3, GATE-40, exactly-once, or production readiness/u);
    assert.match(result.stderr, /reproduce: npm exec -- tsx research\/runtime-e2e-benchmarks\/src\/process-chaos-cli\.ts/u);
    assert.match(result.stderr, new RegExp(escapeRegExp(`template: ${PROCESS_CHAOS_REPRO_COMMAND}`), "u"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function runChild(arguments_: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, arguments_, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stdout, stderr };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function collectJsonSchemaErrors(
  value: unknown,
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
  location = "$",
): string[] {
  if (typeof schema.$ref === "string") {
    const target = resolveLocalRef(root, schema.$ref);
    return target === undefined ? [`${location}: unresolved ${schema.$ref}`] : collectJsonSchemaErrors(value, target, root, location);
  }
  const errors: string[] = [];
  if ("const" in schema && !deepEqual(value, schema.const)) errors.push(`${location}: const`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(value, item))) errors.push(`${location}: enum`);
  if (typeof schema.type === "string" && !matchesType(value, schema.type)) errors.push(`${location}: type`);
  if (errors.length > 0) return errors;

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${location}: minLength`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${location}: pattern`);
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(value))) errors.push(`${location}: date-time`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${location}: minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${location}: maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${location}: minItems`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${location}: maxItems`);
    if (isRecord(schema.items)) {
      value.forEach((item, index) => errors.push(...collectJsonSchemaErrors(item, schema.items as Record<string, unknown>, root, `${location}[${index}]`)));
    }
    if (isRecord(schema.contains)) {
      const matches = value.filter((item, index) => collectJsonSchemaErrors(item, schema.contains as Record<string, unknown>, root, `${location}[${index}]`).length === 0).length;
      if (typeof schema.minContains === "number" && matches < schema.minContains) errors.push(`${location}: minContains`);
      if (typeof schema.maxContains === "number" && matches > schema.maxContains) errors.push(`${location}: maxContains`);
    }
  }
  if (isRecord(value)) {
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) if (!(key in value)) errors.push(`${location}.${key}: required`);
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (isRecord(propertySchema)) errors.push(...collectJsonSchemaErrors(item, propertySchema, root, `${location}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${location}.${key}: additionalProperty`);
    }
  }
  return errors;
}

function resolveLocalRef(root: Record<string, unknown>, reference: string): Record<string, unknown> | undefined {
  if (!reference.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const segment of reference.slice(2).split("/")) {
    if (!isRecord(current)) return undefined;
    current = current[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return isRecord(current) ? current : undefined;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "object") return isRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  return true;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
