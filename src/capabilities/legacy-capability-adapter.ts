import type { AgentProfile } from "../agents/agent-profile.js";
import type { AgentJob, AgentTask } from "../agents/agent-runtime.js";
import { isRequirementConfirmed, type Requirement } from "../requirements/requirement.js";
import type { CapabilityNameSet } from "./capability-grant.js";
import { createValidatedCapabilityGrant, isSafeRelativeCapabilityPath, type ValidatedCapabilityGrant } from "./capability-grant-validation.js";

export interface LegacyCapabilityProjectionInput {
  profile: AgentProfile;
  threadId: string;
  turnId?: string;
  job?: AgentJob;
  task?: AgentTask;
  requirement?: Requirement;
  runId?: string;
  issuedAt: string;
}

export function projectLegacyCapabilityGrant(input: LegacyCapabilityProjectionInput): ValidatedCapabilityGrant {
  const tools = intersectLegacyLists(input.profile.allowedTools, input.job?.configSnapshot.allowedTools);
  const skills = intersectLegacyLists(input.profile.allowedSkills, input.job?.configSnapshot.allowedSkills);
  const rawAllowedPaths = input.task?.scope.allowedPaths ?? [];
  const rawDeniedPaths = input.task?.scope.deniedPaths ?? [];
  const invalidDeniedPath = rawDeniedPaths.some((path) => !isSafeRelativeCapabilityPath(path));
  const allowedPaths = invalidDeniedPath ? [] : rawAllowedPaths.filter(isSafeRelativeCapabilityPath);
  const deniedPaths = invalidDeniedPath ? ["*"] : rawDeniedPaths.filter(isSafeRelativeCapabilityPath);
  const requirement = input.requirement;
  const confirmation = requirement !== undefined && isRequirementConfirmed(requirement)
    ? { requirementId: requirement.id, revision: requirement.confirmedRevision!, contentHash: requirement.confirmedContentHash! }
    : undefined;
  return createValidatedCapabilityGrant({
    schemaVersion: 1,
    authority: {
      sourceKind: "legacy",
      sourceId: `legacy:${input.profile.id}:${input.job?.id ?? "no-job"}:${input.task?.id ?? "no-task"}`,
      sourceRevision: [input.profile.id, input.job?.attempt ?? 0, input.task?.attempt ?? 0, requirement?.revision ?? 0].join(":"),
      issuedAt: input.issuedAt,
    },
    subject: {
      threadId: input.threadId,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(requirement === undefined ? {} : { requirementId: requirement.id, requirementRevision: requirement.revision }),
      ...(input.job === undefined ? {} : { jobId: input.job.id, jobAttempt: input.job.attempt }),
      ...(input.task === undefined ? {} : { taskId: input.task.id, taskAttempt: input.task.attempt }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
    },
    tools,
    skills,
    mcp: [],
    workspaces: [{
      namespace: "legacy-workspace",
      pathSemantics: rawAllowedPaths.length === 0 ? "unexpressed" : "expressed",
      paths: { allow: allowedPaths, deny: deniedPaths },
      operations: { allow: [], deny: [] },
    }],
    credentials: { allow: [], deny: [] },
    terminal: { recipes: [], network: "none", process: "none" },
    maxSideEffectClass: "none",
    quotas: {
      maxToolInvocations: 0,
      maxModelInvocations: 0,
      maxWallClockMs: 0,
      maxConcurrentProcesses: 0,
      maxOutputBytes: 0,
    },
    ...(confirmation === undefined ? {} : { confirmation }),
    compatibility: "legacy_projected",
  });
}

function intersectLegacyLists(profileValues: readonly string[], jobValues?: readonly string[]): CapabilityNameSet {
  const profile = splitLegacyList(profileValues);
  if (jobValues === undefined) return profile;
  const job = splitLegacyList(jobValues);
  const deny = [...new Set([...profile.deny, ...job.deny])].sort();
  const explicit = [profile.allow, job.allow].filter((values) => !values.includes("*"));
  const allow = explicit.length === 0
    ? ["*"]
    : explicit[0]!.filter((name) => explicit.slice(1).every((values) => values.includes(name)));
  return { allow: [...new Set(allow.filter((name) => !deny.includes(name)))].sort(), deny };
}

function splitLegacyList(values: readonly string[]): CapabilityNameSet {
  return {
    allow: [...new Set(values.filter((value) => !value.startsWith("!")))].sort(),
    deny: [...new Set(values.filter((value) => value.startsWith("!") && value.length > 1).map((value) => value.slice(1)))].sort(),
  };
}
