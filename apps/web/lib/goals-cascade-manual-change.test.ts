import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, companies, goals, projects } from '@tourbillon/db';
import { updateGoal } from './goals';
import { updateProject } from './projects';
import { eq } from 'drizzle-orm';

/**
 * Integration test: Manual project status changes clear auto-pause marker
 * 
 * Acceptance criteria:
 * 1. Archive a goal → cascade pauses project, sets autoPausedByGoalId
 * 2. Manually resume that project → clears autoPausedByGoalId
 * 3. Manually pause it again
 * 4. Reactivate the goal → project stays paused (not auto-resumed)
 */

describe('Goal cascade: manual status change clears auto-pause marker', () => {
  let company: { id: string; name: string };
  let goal: { id: string; title: string; status: string };
  let project: { id: string; title: string; status: string; autoPausedByGoalId: string | null };

  beforeEach(async () => {
    const timestamp = Date.now();
    
    // Create test company
    [company] = await db
      .insert(companies)
      .values({
        name: `Test Company ${timestamp}`,
        slug: `test-${timestamp}`,
        issuePrefix: `TEST${timestamp}`,
      })
      .returning();

    // Create active goal
    [goal] = await db
      .insert(goals)
      .values({
        companyId: company.id,
        title: 'Test Goal',
        status: 'active',
      })
      .returning();

    // Create active project under the goal
    [project] = await db
      .insert(projects)
      .values({
        companyId: company.id,
        goalId: goal.id,
        title: 'Test Project',
        status: 'active',
      })
      .returning();
  });

  it('should not auto-resume project after manual status change', async () => {
    // Step 1: Archive goal → cascade pauses project and sets marker
    const archiveResult = await updateGoal(goal.id, { status: 'archived' }, company.id);
    
    assert.equal(archiveResult.goal.status, 'archived');
    assert.ok(archiveResult.cascadeInfo);
    assert.equal(archiveResult.cascadeInfo.projectsPaused, 1);
    assert.equal(archiveResult.cascadeInfo.projectsResumed, 0);

    // Verify project is auto-paused with marker
    const pausedProject = await db.query.projects.findFirst({
      where: eq(projects.id, project.id),
    });
    assert.ok(pausedProject);
    assert.equal(pausedProject.status, 'paused');
    assert.equal(pausedProject.autoPausedByGoalId, goal.id);

    // Step 2: Manually resume the project → clears marker
    const manuallyResumed = await updateProject(project.id, { status: 'active' }, company.id);
    
    assert.equal(manuallyResumed.status, 'active');
    assert.equal(manuallyResumed.autoPausedByGoalId, null);

    // Step 3: Manually pause it again
    const manuallyPaused = await updateProject(project.id, { status: 'paused' }, company.id);
    
    assert.equal(manuallyPaused.status, 'paused');
    assert.equal(manuallyPaused.autoPausedByGoalId, null);

    // Step 4: Reactivate goal → project should stay paused (not auto-resumed)
    const reactivateResult = await updateGoal(goal.id, { status: 'active' }, company.id);
    
    assert.equal(reactivateResult.goal.status, 'active');
    // No projects should be auto-resumed because the marker was cleared
    if (reactivateResult.cascadeInfo) {
      assert.equal(reactivateResult.cascadeInfo.projectsResumed, 0);
    }

    // Verify project is still paused
    const finalProject = await db.query.projects.findFirst({
      where: eq(projects.id, project.id),
    });
    assert.ok(finalProject);
    assert.equal(finalProject.status, 'paused');
    assert.equal(finalProject.autoPausedByGoalId, null);
  });

  it('should clear marker even when changing to the same status', async () => {
    // Archive goal → auto-pause project
    await updateGoal(goal.id, { status: 'archived' }, company.id);

    const pausedProject = await db.query.projects.findFirst({
      where: eq(projects.id, project.id),
    });
    assert.ok(pausedProject);
    assert.equal(pausedProject.autoPausedByGoalId, goal.id);

    // Manually set status to 'paused' again (same status) → should clear marker
    const updated = await updateProject(project.id, { status: 'paused' }, company.id);
    
    assert.equal(updated.status, 'paused');
    assert.equal(updated.autoPausedByGoalId, null);

    // Reactivate goal → should not resume
    const reactivateResult = await updateGoal(goal.id, { status: 'active' }, company.id);
    
    if (reactivateResult.cascadeInfo) {
      assert.equal(reactivateResult.cascadeInfo.projectsResumed, 0);
    }
  });

  it('should handle multiple projects with mixed manual changes', async () => {
    // Create two more projects
    const [project2] = await db
      .insert(projects)
      .values({
        companyId: company.id,
        goalId: goal.id,
        title: 'Test Project 2',
        status: 'active',
      })
      .returning();

    const [project3] = await db
      .insert(projects)
      .values({
        companyId: company.id,
        goalId: goal.id,
        title: 'Test Project 3',
        status: 'active',
      })
      .returning();

    // Archive goal → all 3 projects auto-paused
    const archiveResult = await updateGoal(goal.id, { status: 'archived' }, company.id);
    assert.equal(archiveResult.cascadeInfo?.projectsPaused, 3);

    // Manually change project1 (clear marker)
    await updateProject(project.id, { status: 'active' }, company.id);

    // Leave project2 with marker intact
    // Manually change project3 (clear marker)
    await updateProject(project3.id, { status: 'paused' }, company.id);

    // Reactivate goal → only project2 should auto-resume
    const reactivateResult = await updateGoal(goal.id, { status: 'active' }, company.id);
    
    assert.equal(reactivateResult.cascadeInfo?.projectsResumed, 1);

    // Verify final states
    const final1 = await db.query.projects.findFirst({ where: eq(projects.id, project.id) });
    const final2 = await db.query.projects.findFirst({ where: eq(projects.id, project2.id) });
    const final3 = await db.query.projects.findFirst({ where: eq(projects.id, project3.id) });

    assert.equal(final1?.status, 'active'); // manually resumed, stayed active
    assert.equal(final1?.autoPausedByGoalId, null);

    assert.equal(final2?.status, 'active'); // auto-resumed
    assert.equal(final2?.autoPausedByGoalId, null);

    assert.equal(final3?.status, 'paused'); // manually paused, stayed paused
    assert.equal(final3?.autoPausedByGoalId, null);
  });
});
