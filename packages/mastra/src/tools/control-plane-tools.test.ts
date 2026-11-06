/**
 * #342 — the ISSUE side of the vocabulary.
 *
 * The concierge/board copy called issues "tasks" (getInbox returned "blocked tasks",
 * checkoutIssue checked out "a task"), which fed the tasks-vs-issues confusion. The
 * issue-side tool descriptions must speak ISSUE, and the inbox copy must point back at
 * the chat task list as the OTHER system. String pins only — no network, no DB.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkoutIssueTool,
  createSubtaskTool,
  getCommentsTool,
  getHeartbeatContextTool,
  getInboxTool,
} from './control-plane-tools';

const desc = (tool: { description?: string }) => tool.description ?? '';

describe('#342 issue-side tool copy speaks ISSUE, not task', () => {
  it('getInbox says these are company board ISSUES and points task questions at listMyTasks', () => {
    const d = desc(getInboxTool);
    assert.match(d, /company board ISSUES/);
    assert.match(d, /blocked issues assigned to you/);
    assert.match(d, /NOT your private chat/);
    assert.match(d, /"what is on the task list" use listMyTasks instead \(#342\)/);
  });

  it('checkoutIssue checks out an ISSUE and never calls it a task', () => {
    const d = desc(checkoutIssueTool);
    assert.match(d, /checkout an ISSUE \(a company board issue\)/);
    assert.match(d, /pick the next inbox issue/);
    assert.doesNotMatch(d, /\btasks?\b/, 'checkoutIssue must not call issues "tasks"');
  });

  it('getHeartbeatContext and getComments read an ISSUE, not a task', () => {
    assert.match(desc(getHeartbeatContextTool), /context for an ISSUE/);
    assert.doesNotMatch(desc(getHeartbeatContextTool), /\btasks?\b/i);
    assert.match(desc(getCommentsTool), /comments on an ISSUE/);
    assert.doesNotMatch(desc(getCommentsTool), /\btasks?\b/i);
  });

  it('createSubtask creates a child issue and forbids orphan ISSUES (not "orphan tasks")', () => {
    const d = desc(createSubtaskTool);
    assert.match(d, /Create a child issue/);
    assert.match(d, /no orphan issues allowed/);
    assert.doesNotMatch(d, /orphan tasks/);
  });
});
