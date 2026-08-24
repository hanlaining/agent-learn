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

/** God-Agent v3：先原稿与 Mock，再由用户确认，最后默认三 Chat 并行工程。 */
export const SOFTWARE_PRODUCT_DELIVERY_V3_TEMPLATE: WorkflowTemplate = {
  id: "software_product_delivery",
  version: "v3",
  supportedExecutionKinds: ["software_product_delivery"],
  stages: [
    { id: "product_design", role: "product_design", dependsOn: [], allowedTools: ["list_files", "read_file", "read_skill", "publish_shared_result"], outputContract: "stage-result.v1", reviewPolicy: "deterministic", retryPolicy: { maxBusinessAttempts: 2, maxFormatRepairs: 1 } },
    { id: "mock_preview", role: "mock_preview", dependsOn: ["product_design"], allowedTools: ["list_files", "read_file", "read_skill", "publish_shared_result"], outputContract: "stage-result.v1", reviewPolicy: "deterministic", retryPolicy: { maxBusinessAttempts: 2, maxFormatRepairs: 1 } },
    { id: "user_design_confirmation", role: "orchestrator", dependsOn: ["mock_preview"], allowedTools: [], outputContract: "stage-result.v1", reviewPolicy: "none", retryPolicy: { maxBusinessAttempts: 1, maxFormatRepairs: 1 } },
    { id: "frontend_engineering", role: "frontend_engineering", dependsOn: ["user_design_confirmation"], allowedTools: ["list_files", "read_file", "read_skill", "write_file", "run_command", "publish_shared_result"], outputContract: "stage-result.v1", reviewPolicy: "conditional", retryPolicy: { maxBusinessAttempts: 2, maxFormatRepairs: 1 } },
    { id: "backend_engineering", role: "backend_engineering", dependsOn: ["user_design_confirmation"], allowedTools: ["list_files", "read_file", "read_skill", "write_file", "run_command", "publish_shared_result"], outputContract: "stage-result.v1", reviewPolicy: "conditional", retryPolicy: { maxBusinessAttempts: 2, maxFormatRepairs: 1 } },
    { id: "integration_quality", role: "integration_quality", dependsOn: ["user_design_confirmation"], allowedTools: ["list_files", "read_file", "read_skill", "run_command", "publish_shared_result"], outputContract: "stage-result.v1", reviewPolicy: "independent", retryPolicy: { maxBusinessAttempts: 2, maxFormatRepairs: 1 } },
    { id: "integration_review", role: "software_team_lead", dependsOn: ["frontend_engineering", "backend_engineering", "integration_quality"], allowedTools: ["read_shared_board", "publish_shared_result"], outputContract: "stage-result.v1", reviewPolicy: "conditional", retryPolicy: { maxBusinessAttempts: 2, maxFormatRepairs: 1 } },
    { id: "quality_review", role: "quality_role", dependsOn: ["integration_review"], allowedTools: ["list_files", "read_file", "run_command", "read_shared_board", "publish_shared_result"], outputContract: "stage-result.v1", reviewPolicy: "independent", retryPolicy: { maxBusinessAttempts: 2, maxFormatRepairs: 1 } },
    { id: "lead_acceptance", role: "software_team_lead", dependsOn: ["quality_review"], allowedTools: ["read_shared_board", "publish_shared_result"], outputContract: "stage-result.v1", reviewPolicy: "none", retryPolicy: { maxBusinessAttempts: 2, maxFormatRepairs: 1 } },
    { id: "return_god", role: "orchestrator", dependsOn: ["lead_acceptance"], allowedTools: [], outputContract: "stage-result.v1", reviewPolicy: "none", retryPolicy: { maxBusinessAttempts: 2, maxFormatRepairs: 1 } },
  ],
  finalDeliveryPolicy: { role: "orchestrator", exactlyOnce: true },
};
