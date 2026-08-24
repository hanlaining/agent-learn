---
name: clarify-before-execute
description: Clarify a substantial user requirement, save one versioned Markdown plan, and enforce separate requirement and design confirmations before engineering. For full product delivery, create a product draft and Mock first, then default to three parallel engineering Chats only after the user confirms the design.
---

# Clarify Before Execute

Keep one substantial requirement in the parent Chat. Do not create one Agent per user message.

## Workflow

1. Discuss the objective, scope, exclusions, constraints, deliverables, and acceptance criteria in the parent Chat.
2. Ask only questions that materially affect the result. Treat additions and corrections as revisions of the same requirement.
3. Do not modify files, execute commands, publish results, or create subagents while the current revision is unconfirmed.
4. When the requirement is sufficiently clear, call `prepare_requirement_plan` once with the consolidated requirement and concrete test cases.
5. Tell the user where the Markdown plan was saved and summarize the planned acceptance checks.
6. Wait for the user to click or explicitly choose “确认执行”. Do not interpret ordinary continuation text as confirmation.
7. After Runtime confirms the exact requirement revision and hash, branch by execution kind:
   - `analysis_only` / `software_change`: execute the confirmed plan under the normal permission gate.
   - `software_product_delivery`: start only the product-design and Mock stages. Requirement confirmation is not design confirmation.
8. For full product delivery, save a separate `设计稿与Mock.md`, expose the product draft and Mock preview to the user, and wait for explicit “确认设计”. Design feedback revises the same design Task and invalidates any older design confirmation.
9. Before design confirmation, do not create a writable engineering Task and do not grant `write_file` to product-design or Mock roles. The Runtime must reject engineering writes even if a prompt or persisted Task attempts to bypass this gate.
10. After design confirmation, default to exactly three parallel engineering Chats:
    - frontend: UI implementation within frontend file claims;
    - backend: API, data, and server implementation within backend file claims;
    - integration-quality: integration, tests, and build evidence without modifying frontend/backend business files.
11. Each engineering Chat returns its own changed files, tests, risks, and evidence. File claims must be disjoint and enforced by the Runtime, not only described in prompts.
12. Fan in only after all three Returns are available. The engineering lead integrates and reviews them; an independent quality Agent checks the result against the confirmed draft and Mock; then the lead Returns to God for exactly one final delivery.
13. A failed engineering Chat reuses its original Task and Chat with a new Attempt. Do not rerun the other two successful Chats.

## Requirement Quality

Before preparing the plan, make these fields concrete:

- `title`: a short name for the whole requirement.
- `objective`: the outcome the user expects.
- `scope`: behavior and surfaces that will change.
- `nonGoals`: explicitly excluded work.
- `constraints`: permissions, compatibility, UI, or process limits.
- `deliverables`: files or user-visible outcomes.
- `acceptanceCriteria`: observable success conditions.
- `testCases`: positive, negative, permission, recovery, and UI cases as applicable.

Use the plan template in `assets/requirement-plan-template.md` as the output structure. The Runtime writes the final file deterministically.

## Confirmation Boundary

Confirmation applies only to the displayed revision and plan hash. Any material requirement update invalidates the old confirmation and returns the workflow to clarification. One confirmed revision maps to one Job; follow-up and Return cycles stay inside that Job.

For `software_product_delivery`, design confirmation is a second independent boundary tied to the design artifact hash. Requirement confirmation permits design work only; only design confirmation permits the three writable engineering Chats.
