---
description: "Create a specification document for a feature or task"
targets: ["*"]
---

# Create Specification

Create a specification document for a feature or task in the Effect library.

## Instructions

1. **Read `AGENTS.md`** for project rules and conventions
2. **Read `.specs/README.md`** for specification structure guidelines
3. **Review existing specs** in `.specs/` for format examples
4. **Review existing patterns** in `.patterns/` for development guidelines

## User Request

$ARGUMENTS

## Output Requirements

Create a specification file at `.specs/<SPEC_NAME>.md` where `<SPEC_NAME>` is a descriptive SCREAMING_SNAKE_CASE name derived from the feature.

## Specification Structure

The spec should include these sections as appropriate:

### 1. Title and Overview

- Clear title describing the feature
- Brief overview of what this spec covers
- Status indicator (e.g., `Status: DRAFT`, `Status: IN_PROGRESS`, `Status: COMPLETED`)

### 2. Problem Statement / Motivation

- Why this feature is needed
- What problem it solves
- Current limitations or pain points

### 3. Design Decisions (if applicable)

Use a table format for key decisions:

| Decision       | Choice      | Rationale       |
| -------------- | ----------- | --------------- |
| **Decision 1** | Choice made | Why this choice |

### 4. Implementation Phases

Granular, step-by-step tasks for autonomous agents. Each phase should have:

- **Goal**: What this phase accomplishes
- **Files to create/modify**: Explicit file paths
- **Tasks**: Checkbox list of specific tasks (use `- [ ]` format with numbered IDs like `**1.1**`)
- **Verification**: How to verify the phase is complete (e.g., `pnpm check` passes)

Tasks should be:

- Ordered by dependency
- Atomic (one logical change per task)
- Include specific commands to run

### 5. Technical Details

- Data models / type definitions (use TypeScript code blocks)
- API definitions (if applicable)
- Code examples showing expected patterns

### 6. Testing Requirements

- Unit tests needed
- Integration tests needed
- Property-based tests (if applicable)

### 7. Final Verification

- Commands to run: `pnpm lint-fix`, `pnpm check`, `pnpm test`, `pnpm docgen`

## Task Format Example

```markdown
### Phase 1: Domain Model

**Goal**: Create the domain types and schemas.

**Files to create/modify**:

- `packages/effect/src/MyFeature.ts` (new)

**Tasks**:

- [ ] **1.1** Create `MyFeatureId` branded type using `Schema.String.pipe(Schema.brand("MyFeatureId"))`
- [ ] **1.2** Create `MyFeature` class extending `Schema.Class` with fields...
- [ ] **1.3** Export from module
- [ ] **1.4** Run `pnpm codegen` to update barrel files
- [ ] **1.5** Run `pnpm check` to verify no type errors

**Verification**: `pnpm check` passes
```

## Guidelines

- **Be specific**: Include exact file paths, function names, type definitions
- **Be actionable**: Tasks should be completable by an autonomous agent
- **Follow Effect patterns**: Reference `.patterns/` docs for conventions
- **Include code examples**: Show expected implementation patterns
- **Keep tasks atomic**: One task = one logical change
- **Order by dependency**: Earlier tasks should not depend on later ones

## After Creating the Spec

1. Run `pnpm lint-fix` to format the file
2. Inform the user of the spec location
3. Ask if they want to proceed with implementation
