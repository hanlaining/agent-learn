import type { RequirementExecutionKind } from "../../requirements/requirement.js";

export interface WorkflowStageTemplate {
  id: string;
  role: string;
  dependsOn: string[];
  allowedTools: string[];
  outputContract: string;
  reviewPolicy: "deterministic" | "independent" | "conditional" | "none";
  retryPolicy: { maxBusinessAttempts: number; maxFormatRepairs: 1 };
}

export interface WorkflowTemplate {
  id: string;
  version: string;
  supportedExecutionKinds: RequirementExecutionKind[];
  stages: WorkflowStageTemplate[];
  finalDeliveryPolicy: { role: string; exactlyOnce: true };
}

export class WorkflowTemplateRegistry {
  private readonly templates = new Map<string, WorkflowTemplate>();

  register(template: WorkflowTemplate): void {
    validateWorkflowTemplate(template);
    const key = `${template.id}@${template.version}`;
    if (this.templates.has(key)) throw new Error(`Workflow template already exists: ${key}`);
    this.templates.set(key, structuredClone(template));
  }

  resolve(id: string, version: string): WorkflowTemplate {
    const template = this.templates.get(`${id}@${version}`);
    if (template === undefined) throw new Error(`Workflow template is unavailable: ${id}@${version}`);
    return structuredClone(template);
  }

  requireForExecution(kind: RequirementExecutionKind, id: string, version: string, jobAllowedTools: string[]): WorkflowTemplate {
    const template = this.resolve(id, version);
    if (!template.supportedExecutionKinds.includes(kind)) throw new Error(`Workflow does not support ${kind}`);
    for (const stage of template.stages) {
      if (!stage.allowedTools.every((tool) => capabilityIncludes(jobAllowedTools, tool))) {
        throw new Error(`Workflow stage widens Job permissions: ${stage.id}`);
      }
    }
    return template;
  }
}

export function validateWorkflowTemplate(template: WorkflowTemplate): void {
  if (!template.id || !template.version || template.stages.length === 0) throw new Error("Invalid workflow template");
  const ids = new Set(template.stages.map((stage) => stage.id));
  if (ids.size !== template.stages.length) throw new Error("Workflow stage IDs must be unique");
  for (const stage of template.stages) {
    if (stage.retryPolicy.maxFormatRepairs !== 1 || stage.retryPolicy.maxBusinessAttempts < 1 || stage.retryPolicy.maxBusinessAttempts > 2) {
      throw new Error(`Invalid retry policy: ${stage.id}`);
    }
    if (stage.dependsOn.some((dependency) => !ids.has(dependency))) throw new Error(`Unknown workflow dependency: ${stage.id}`);
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const byId = new Map(template.stages.map((stage) => [stage.id, stage]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("Workflow DAG cycle detected");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
}

function capabilityIncludes(snapshot: string[], tool: string): boolean {
  return snapshot.includes("*") && !snapshot.includes(`!${tool}`) || snapshot.includes(tool);
}
