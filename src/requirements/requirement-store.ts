import type {
  Requirement,
  RequirementDraft,
  RequirementPlanArtifact,
  RequirementSnapshot,
  RequirementStatus,
} from "./requirement.js";
import { isRequirementConfirmed } from "./requirement.js";

export class RequirementStore {
  private sequence = 0;
  private readonly requirements = new Map<string, Requirement>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  static fromSnapshot(value: RequirementSnapshot | undefined): RequirementStore {
    const store = new RequirementStore();
    if (value === undefined) return store;
    if (value.version !== 1) throw new Error("Invalid requirement snapshot");
    store.sequence = value.sequence;
    value.requirements.forEach((item) => store.requirements.set(item.id, {
      ...structuredClone(item),
      executionKind: item.executionKind ?? "software_change",
      executionState: item.executionState ?? executionStateFromStatus(item.status),
    }));
    return store;
  }

  nextPlanIdentity(parentThreadId: string): { requirementId: string; revision: number } {
    const current = this.getActive(parentThreadId);
    return {
      requirementId: current?.id ?? `requirement-${this.sequence + 1}`,
      revision: (current?.revision ?? 0) + 1,
    };
  }

  prepare(
    parentThreadId: string,
    draft: RequirementDraft,
    planArtifact: RequirementPlanArtifact,
  ): Requirement {
    const current = this.getActive(parentThreadId);
    const timestamp = this.now();
    const requirement: Requirement = {
      ...structuredClone(draft),
      id: current?.id ?? this.id(),
      parentThreadId,
      revision: (current?.revision ?? 0) + 1,
      status: "planned",
      executionState: "not_started",
      planArtifact: structuredClone(planArtifact),
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.requirements.set(requirement.id, requirement);
    return structuredClone(requirement);
  }

  confirm(id: string, revision: number, contentHash: string): Requirement {
    const item = this.require(id);
    if (item.revision !== revision || item.planArtifact.contentHash !== contentHash) {
      throw new Error("Requirement plan changed; review the latest revision before confirming");
    }
    if (isRequirementConfirmed(item)) return structuredClone(item);
    item.status = "confirmed";
    item.executionState = "not_started";
    item.confirmedRevision = revision;
    item.confirmedContentHash = contentHash;
    item.confirmedAt = this.now();
    item.updatedAt = item.confirmedAt;
    return structuredClone(item);
  }

  attachJob(id: string, jobId: string): Requirement {
    const item = this.require(id);
    if (!isRequirementConfirmed(item)) throw new Error("Requirement is not confirmed");
    if (item.jobId !== undefined && item.jobId !== jobId) {
      throw new Error("Confirmed requirement is already attached to another Job");
    }
    item.jobId = jobId;
    item.status = "executing";
    item.executionState = "executing";
    item.updatedAt = this.now();
    return structuredClone(item);
  }

  setStatus(id: string, status: RequirementStatus): Requirement {
    const item = this.require(id);
    item.status = status;
    item.executionState = executionStateFromStatus(status);
    item.updatedAt = this.now();
    return structuredClone(item);
  }

  setExecutionState(id: string, state: import("./requirement.js").RequirementExecutionState): Requirement {
    const item = this.require(id);
    item.executionState = state;
    item.status = state === "not_started" ? "confirmed" : state;
    item.updatedAt = this.now();
    return structuredClone(item);
  }

  get(id: string): Requirement | undefined {
    const item = this.requirements.get(id);
    return item === undefined ? undefined : structuredClone(item);
  }

  getActive(parentThreadId: string): Requirement | undefined {
    const item = [...this.requirements.values()]
      .filter((candidate) => candidate.parentThreadId === parentThreadId && candidate.status !== "cancelled")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return item === undefined ? undefined : structuredClone(item);
  }

  list(parentThreadId?: string): Requirement[] {
    return [...this.requirements.values()]
      .filter((item) => parentThreadId === undefined || item.parentThreadId === parentThreadId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((item) => structuredClone(item));
  }

  exportSnapshot(): RequirementSnapshot {
    return { version: 1, sequence: this.sequence, requirements: this.list() };
  }

  private id(): string {
    this.sequence += 1;
    return `requirement-${this.sequence}`;
  }

  private require(id: string): Requirement {
    const item = this.requirements.get(id);
    if (item === undefined) throw new Error(`Requirement not found: ${id}`);
    return item;
  }
}

function executionStateFromStatus(status: RequirementStatus): import("./requirement.js").RequirementExecutionState {
  if (status === "executing") return "executing";
  if (status === "completed") return "completed";
  if (status === "failed_retryable") return "failed_retryable";
  if (status === "cancelled") return "cancelled";
  return "not_started";
}
