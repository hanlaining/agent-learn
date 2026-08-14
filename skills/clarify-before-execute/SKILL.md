---
name: clarify-before-execute
description: Clarify a substantial user requirement before implementation, consolidate it into one versioned requirement, generate acceptance-focused test cases and a Markdown execution plan, and wait for explicit user confirmation before using execution tools or subagents. Use for coding, file changes, commands, publishing, or other tasks where the user is still discussing scope or expects a confirm-before-execute workflow.
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
7. After Runtime confirms the exact revision and content hash, execute the plan. If subagents are enabled, use the fewest useful agents, wait for their Returns, verify evidence, request focused follow-up on the same workflow when needed, and then report the final result.

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
