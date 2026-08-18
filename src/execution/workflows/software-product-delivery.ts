import type { WorkflowTemplate } from "./workflow-template.js";

export const SOFTWARE_PRODUCT_DELIVERY_TEMPLATE: WorkflowTemplate = {
  id: "software_product_delivery",
  version: "v2",
  supportedExecutionKinds: ["software_product_delivery"],
  stages: [
    { id: "product", role: "product_role", dependsOn: [], allowedTools: [], outputContract: "stage-result.v1", reviewPolicy: "deterministic", retryPolicy: { maxBusinessAttempts: 2, maxFormatRepairs: 1 } },
    { id: "engineering", role: "engineering_role", dependsOn: ["product"], allowedTools: ["list_files", "read_file", "write_file", "run_command"], outputContract: "stage-result.v1", reviewPolicy: "conditional", retryPolicy: { maxBusinessAttempts: 2, maxFormatRepairs: 1 } },
    { id: "quality", role: "quality_role", dependsOn: ["engineering"], allowedTools: ["list_files", "read_file", "run_command"], outputContract: "stage-result.v1", reviewPolicy: "independent", retryPolicy: { maxBusinessAttempts: 2, maxFormatRepairs: 1 } },
    { id: "lead", role: "software_team_lead", dependsOn: ["quality"], allowedTools: [], outputContract: "stage-result.v1", reviewPolicy: "none", retryPolicy: { maxBusinessAttempts: 2, maxFormatRepairs: 1 } },
  ],
  finalDeliveryPolicy: { role: "orchestrator", exactlyOnce: true },
};
