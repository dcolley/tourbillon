# User Stories: Editable Agent Title in Edit Mode

## Overview

This document describes the user story and acceptance criteria for fixing the missing agent **title** field in edit mode. This is a bugfix story — the field exists in create mode but is hidden/locked in edit mode, preventing agents from being renamed after hire.

## Context

**Bug Report**: Derek (TEST Demo company) observed that the agent list shows incorrect titles for hired agents. The title field is present and editable during agent creation but is missing or locked in the edit UI, making it impossible to update an agent's title after hire.

**Example**: The `TestSuper` agent (`test-super` urlKey) still shows the default title "Engineer" on the TEST Demo roster, even though it should be titled "TestSuper" or "QA Agent" to reflect its specialized testing role.

**Root Cause**: The edit-agent UI does not expose the same title field that is available in create-agent mode.

**Related Issue (Out of Scope)**: The `test-super` skill is not assignable via the `SKILL_CATALOG` UI — this is a separate issue and is **not** addressed by this story.

---

## User Story: US-ET1

### Edit Agent Title After Hire (P0)

**As a** company operator (PM, Ops, or Derek managing the TEST Demo company),

**I want to** edit an existing agent's **title** in the same edit UI used for other agent fields,

**So that** the roster list shows the correct role/title after hire (not stuck on the create-time default).

---

### Acceptance Criteria

- [ ] **AC-ET1.1: Field Visibility**  
  The edit-agent UI exposes the same **title** field as the create-agent UI. The field is visible, editable, and uses the same label and validation rules as create mode.

- [ ] **AC-ET1.2: Persistence**  
  Saving the edit form persists the new title to the agent record using the same database field and API endpoint used during agent creation.

- [ ] **AC-ET1.3: Roster Display**  
  After saving, the agent roster and Demo agent list immediately show the updated title. If the application already refreshes lists on save, no additional page reload is required. Otherwise, a full page reload is acceptable if documented.

- [ ] **AC-ET1.4: Create Mode Unchanged**  
  The create-agent flow is unchanged. The title field remains present and functions exactly as it does today.

- [ ] **AC-ET1.5: Title-Only Edit**  
  Editing the title does **not** require changes to `urlKey`, agent ID, or any other identity fields. A title-only edit is sufficient to update the displayed name.

---

### Quality Gates (Test ACCEPT/HOLD)

| Gate | ACCEPT Condition | HOLD Condition |
|------|-----------------|----------------|
| **Edit title field present** | Edit form shows an editable title field, prefilled with the agent's current title value | Field is missing, read-only with no path to change, or only present in create mode |
| **Persist + roster update** | Saving the form updates the stored title; the agent list immediately shows the new title | Save operation does not persist the change, or the list still shows the old title after save |
| **Create mode unchanged** | Create-agent flow still has a working title field with the same behavior as before | Title field is broken or missing in create mode |

---

### Out of Scope

The following items are explicitly **out of scope** for this story:

- **SKILL_CATALOG**: Assigning the `test-super` skill via the skill catalog UI (separate bug)
- **Persona/Instructions**: Changing the agent's persona, SOUL.md, or instruction bundles to rename the agent
- **Bulk Rename**: Renaming multiple agents at once
- **Permissions**: Changes to who can edit agents (if you can already edit an agent, you can edit its title)
- **Mobile Companion**: Mobile UI is out of scope unless the same edit form is shared between web and mobile (web Demo agent list is the acceptance bar)

---

## Implementation Notes for Dev

### Current State (Observed)

- **Create mode**: Title field is present, editable, and works correctly.
- **Edit mode**: Title field is hidden or locked — no UI control to change it.
- **Database**: Agent title is stored in the `agents` table (likely `title` or `name` column; confirm in schema).
- **API**: Existing agent update endpoint should already support the title field (confirm in `PATCH /api/agents/:id`).

### Proposed Fix

1. **UI Change**: Add the title input field to the edit-agent form (same component as create mode, or equivalent).
2. **Validation**: Ensure the same validation rules (max length, allowed characters, required/optional) apply in edit mode.
3. **API**: Verify that the agent update API accepts and persists the `title` field. If not, update the API schema.
4. **Testing**: Manual test with the `test-super` agent:
   - Edit `test-super` agent in TEST Demo company
   - Change title from "Engineer" to "TestSuper"
   - Save and verify the roster shows "TestSuper"

### Files Likely to Change

- **UI**: Agent edit form component (e.g., `apps/web/app/dashboard/agents/[agentId]/edit/page.tsx` or similar)
- **API**: Agent update route (e.g., `apps/web/app/api/agents/[id]/route.ts`)
- **Schema**: Possibly `packages/db/src/schema/agents.ts` if title field is missing (unlikely — should already exist)

### Validation Rules (Match Create Mode)

- **Required**: Yes (title should not be empty)
- **Max Length**: Likely 100-200 characters (confirm with create-mode validation)
- **Allowed Characters**: Alphanumeric, spaces, hyphens, underscores (confirm with create-mode validation)

---

## Test Scenario: TestSuper Agent

**Precondition**: The `test-super` agent exists in the TEST Demo company with title "Engineer".

**Test Steps**:

1. Navigate to `/dashboard/agents/test-super` (or agent detail page).
2. Click "Edit" to enter edit mode.
3. Verify the title field is visible and editable (prefilled with "Engineer").
4. Change the title to "TestSuper".
5. Click "Save".
6. Navigate to the agent roster or Demo agent list.
7. Verify the agent is now listed as "TestSuper" (not "Engineer").

**Expected Result**: The agent title is updated and displayed correctly in the roster.

**Actual Result (Before Fix)**: The title field is missing or locked in edit mode, so the title cannot be changed.

---

## Acceptance Test Checklist

- [ ] **AC-ET1.1**: Title field is visible and editable in edit mode
- [ ] **AC-ET1.2**: Saving the edit form persists the new title
- [ ] **AC-ET1.3**: Agent roster shows the updated title after save
- [ ] **AC-ET1.4**: Create-agent flow is unchanged (title field still works)
- [ ] **AC-ET1.5**: Title-only edit does not require urlKey or ID changes

---

## References

- **Bug Reporter**: Derek (TEST Demo company operator)
- **Affected Agent**: `TestSuper` (`test-super` urlKey)
- **Current Title**: "Engineer" (incorrect)
- **Desired Title**: "TestSuper" or "QA Agent"
- **Related Docs**: `docs/test-super-agent-setup.md`, `AGENTS.md` (agent identity section)
