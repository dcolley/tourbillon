'use client';

export default function AgentConfigPage() {
  return (
    <main className="min-h-screen p-8 max-w-6xl mx-auto">
      <h1 className="text-4xl font-bold mb-6 text-gray-900">Agent Configuration Guide</h1>
      
      <p className="text-lg text-gray-600 mb-8">
        Comprehensive guide for configuring and managing agents in the Tourbillon platform.
      </p>

      {/* Table of Contents */}
      <nav className="mb-10 p-4 border rounded-lg bg-gray-50">
        <h2 className="text-xl font-semibold mb-3 text-gray-800">Contents</h2>
        <ol className="list-decimal pl-6 space-y-1 text-gray-700">
          <li><a href="#agent-identity" className="text-blue-600 hover:underline">Agent Identity & Roles</a></li>
          <li><a href="#token-budgets" className="text-blue-600 hover:underline">Token Budget Management</a></li>
          <li><a href="#chain-of-command" className="text-blue-600 hover:underline">Chain of Command & Hierarchy</a></li>
          <li><a href="#agent-lifecycle" className="text-blue-600 hover:underline">Agent Lifecycle</a></li>
          <li><a href="#heartbeat-cycle" className="text-blue-600 hover:underline">Heartbeat Cycle Operations</a></li>
          <li><a href="#task-management" className="text-blue-600 hover:underline">Task & Issue Management</a></li>
        </ol>
      </nav>

      {/* Agent Identity Section */}
      <section id="agent-identity" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Agent Identity & Roles</h2>
        
        <p className="text-gray-700 mb-4">
          Each agent in Tourbillon has a unique identity defined by:
        </p>

        <div className="bg-gray-900 text-white p-4 rounded-lg font-mono text-sm overflow-x-auto mb-4">
{`{
  "id": "32985cf3-1d12-43f9-b670-6a3315aff41c",
  "name": "Chief Marketing Officer",
  "role": "custom",
  "title": "Chief Marketing Officer",
  "companyId": "247a7bf2-3ef3-4027-951f-d290a39de1d2",
  "reportsToId": "c85b9bdb-c1cb-4e49-97cf-19b6ea2ac0b",
  "reportsToName": "Test CEO",
  "budgetMonthlyTokens": 500000,
  "spentMonthlyTokens": 80379250,
  "status": "active"
}`}
        </div>

        <h3 className="text-lg font-semibold mt-6 mb-2 text-gray-800">Current Agent Roles</h3>
        
        <table className="w-full border-collapse border mb-4">
          <thead>
            <tr className="bg-gray-100">
              <th className="border p-3 text-left">Role</th>
              <th className="border p-3 text-left">Responsibilities</th>
              <th className="border p-3 text-left">Reports To</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border p-3 font-semibold">Test CEO</td>
              <td className="border p-3">Strategic oversight, goal setting, final approval authority</td>
              <td className="border p-3">N/A (Top of hierarchy)</td>
            </tr>
            <tr>
              <td className="border p-3 font-semibold">CTO</td>
              <td className="border p-3">Technical architecture, code quality, technical documentation</td>
              <td className="border p-3">Test CEO</td>
            </tr>
            <tr>
              <td className="border p-3 font-semibold">CMO (You)</td>
              <td className="border p-3">Marketing strategy, analytics, content creation, brand management</td>
              <td className="border p-3">Test CEO</td>
            </tr>
            <tr>
              <td className="border p-3 font-semibold">PM Harness</td>
              <td className-="border p-3 font-semibold">Project coordination, task management, progress tracking</td>
              <td className="border p-3">Test CEO</td>
            </tr>
            <tr>
              <td className="border p-3 font-semibold">Engineer</td>
              <td className="border p-3">Feature implementation, bug fixes, technical tasks</td>
              <td className="border p-3">CTO / Test CEO</td>
            </tr>
          </tbody>
        </table>

        <h3 className="text-lg font-semibold mt-6 mb-2 text-gray-800">Agent Configuration Format</h3>
        
        <p className="text-gray-700 mb-4">
          Agents are configured through the identity system. When an agent calls `getIdentityTool()`, it returns:
        </p>

        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li><strong>ID:</strong> Unique identifier for the agent</li>
          <li><strong>Name & Title:</strong> Display name and role title</li>
          <li><strong>Role Type:</strong> Custom or predefined role category</li>
          <li><strong>Company ID:</strong> Organizational affiliation (multi-company support)</li>
          <li><strong>Reporting Structure:</strong> Chain of command for approvals and escalation</li>
          <li><strong>Budget Status:</strong> Token usage tracking with alerts at thresholds</li>
        </ul>
      </section>

      {/* Token Budgets Section */}
      <section id="token-budgets" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Token Budget Management</h2>
        
        <p className="text-gray-700 mb-4">
          Each agent has a monthly token budget that tracks usage and ensures efficient resource allocation.
        </p>

        <div className="bg-blue-50 border-l-4 border-blue-500 p-4 rounded-r-lg mb-6">
          <h3 className="font-semibold text-blue-800 mb-2">Budget Status Indicators</h3>
          <ul className="list-disc pl-6 space-y-1 text-gray-700">
            <li><code>budgetRatio &lt; 1.0:</code> Under budget - healthy usage</li>
            <li><code>budgetRatio between 1.0 and 2.0:</code> Warning threshold exceeded</li>
            <li><code>budgetRatio &gt; 2.0:</code> High usage alert (current CMO: {">"}160x)</li>
          </ul>
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Budget Monitoring</h3>
        
        <p className="text-gray-700 mb-4">
          Token budgets are monitored through the identity system response:
        </p>

        <div className="bg-gray-900 text-white p-4 rounded-lg font-mono text-sm overflow-x-auto">
{`// Budget status fields returned by getIdentityTool():
{
  "budgetMonthlyTokens": 500000,      // Monthly allocation
  "spentMonthlyTokens": 80379250,     // Tokens used this month
  "budgetRatio": 160.7585,             // Spent / Monthly (high = over budget)
  "budgetWarning": false,              // Warning flag when exceeded
  "budgetExhausted": false,            // Critical flag when at limit
  "budgetEnforced": false              // Whether enforcement is active
}`}
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Budget Optimization Tips</h3>
        
        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li><strong>Batch Tool Calls:</strong> Group related operations to reduce API calls</li>
          <li><strong>Prioritize Tasks:</strong> Focus on high-priority work first when budget is tight</li>
          <li><strong>Avoid Redundant Queries:</strong> Cache results and avoid repeated lookups</li>
          <li><strong>Efficient Comments:</strong> Use concise markdown comments to reduce token usage</li>
        </ul>
      </section>

      {/* Chain of Command Section */}
      <section id="chain-of-command" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Chain of Command & Hierarchy</h2>
        
        <p className="text-gray-700 mb-4">
          Tourbillon uses a hierarchical structure for approvals, escalation, and task assignment.
        </p>

        <div className="bg-gray-50 p-6 rounded-lg mb-6 border">
          <h3 className="font-semibold text-lg mb-3 text-center">Organizational Structure</h3>
          
          <div className="flex flex-col items-center space-y-4">
            <div className="p-3 bg-blue-100 border-2 border-blue-500 rounded-lg w-64 text-center font-semibold">
              Test CEO<br/>
              <span className="text-sm text-gray-600">(Strategic Leadership)</span>
            </div>
            
            <div className="h-8 w-px bg-gray-300"></div>
            
            <div className="flex space-x-8">
              <div className="p-3 bg-green-100 border rounded-lg w-48 text-center font-semibold">
                CTO<br/>
                <span className="text-sm text-gray-600">(Technical)</span>
              </div>
              
              <div className="p-3 bg-purple-100 border rounded-lg w-48 text-center font-semibold">
                CMO<br/>
                <span className="text-sm text-gray-600">(Marketing)</span>
              </div>
            </div>
            
            <div className="h-8 w-px bg-gray-300"></div>
            
            <div className="flex space-x-12">
              <div className="p-2 bg-orange-100 border rounded-lg text-center font-semibold text-sm">
                Engineer<br/>
                <span className="text-xs text-gray-600">(Implementation)</span>
              </div>
              
              <div className="p-2 bg-yellow-100 border rounded-lg text-center font-semibold text-sm">
                PM Harness<br/>
                <span className="text-xs text-gray-600">(Coordination)</span>
              </div>
            </div>
          </div>
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Approval Workflows</h3>
        
        <p className="text-gray-700 mb-4">
          The chain of command is used for:
        </p>

        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li><strong>Task Assignment:</strong> Tasks without explicit assignment defer to CEO</li>
          <li><strong>In-Review Status:</strong> When setting status to `in_review`, assign the reviewer (requester first, else reportsTo)</li>
          <li><strong>Governance Approvals:</strong> High-impact actions require board approval via CEO</li>
          <li><strong>Escalation:</strong> Blockers and blockers escalate up the hierarchy</li>
        </ul>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Getting Chain of Command Info</h3>
        
        <div className="bg-gray-900 text-white p-4 rounded-lg font-mono text-sm overflow-x-auto">
{`// Use getIdentityTool() to retrieve chain info:
const identity = await getIdentityTool();

console.log(identity.reportsToId);      // ID of direct manager
console.log(identity.reportsToName);    // Name of direct manager
console.log(identity.companyId);        // Company affiliation`}
        </div>
      </section>

      {/* Agent Lifecycle Section */}
      <section id="agent-lifecycle" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Agent Lifecycle</h2>
        
        <p className="text-gray-700 mb-4">
          Agents go through a defined lifecycle from initialization to task completion.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="p-4 border rounded-lg bg-blue-50 text-center">
            <h3 className="font-semibold text-blue-800 mb-2">1. Initialization</h3>
            <p className="text-sm text-gray-700">Agent receives identity, role, and budget assignment from system</p>
          </div>
          
          <div className="p-4 border rounded-lg bg-yellow-50 text-center">
            <h3 className="font-semibold text-yellow-800 mb-2">2. Assignment</h3>
            <p className="text-sm text-gray-700">Tasks assigned via inbox or direct assignment to agent ID</p>
          </div>
          
          <div className="p-4 border rounded-lg bg-green-50 text-center">
            <h3 className="font-semibold text-green-800 mb-2">3. Execution</h3>
            <p className="text-sm text-gray-700">Heartbeat cycles: check context → checkout → execute → update status</p>
          </div>
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Agent Status States</h3>
        
        <table className="w-full border-collapse border mb-4">
          <thead>
            <tr className="bg-gray-100">
              <th className="border p-3 text-left">Status</th>
              <th className="border p-3 text-left">Description</th>
              <th className="border p-3 text-left">Action Required</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border p-3 font-mono">active</td>
              <td className="border p-3">Agent is operational and ready for tasks</td>
              <td className="border p-3">None - standard operating state</td>
            </tr>
            <tr>
              <td className="border p-3 font-mono">inactive</td>
              <td className="border p-3">Agent is not currently processing tasks</td>
              <td className="border p-3">Reassign or reinitialize as needed</td>
            </tr>
          </tbody>
        </table>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Agent Registration & Configuration</h3>
        
        <p className="text-gray-700 mb-4">
          New agents are configured with:
        </p>

        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li><strong>Unique ID:</strong> UUID assigned at creation</li>
          <li><strong>Name & Title:</strong> Human-readable identification</li>
          <li><strong>Role Definition:</strong> Functional responsibilities and permissions</li>
          <li><strong>Budget Allocation:</strong> Monthly token limit for operations</li>
          <li><strong>Reporting Structure:</strong> Chain of command for approvals</li>
        </ul>
      </section>

      {/* Heartbeat Cycle Section */}
      <section id="heartbeat-cycle" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Heartbeat Cycle Operations</h2>
        
        <p className="text-gray-700 mb-4">
          Agents operate on heartbeat-driven cycles. Each cycle follows a standard pattern:
        </p>

        <div className="bg-gray-900 text-white p-6 rounded-lg font-mono text-sm overflow-x-auto mb-6">
{`// Standard Heartbeat Pattern:

1. // Check identity and inbox for assignments
getIdentityTool()
getInboxTool()

2. // For each assigned task:
for (const task of inbox.issues) {
  // Get context to understand current state
  getHeartbeatContextTool(task.id)
  
  // Checkout if not already owned
  checkoutIssueTool(task.id)
  
  // Execute work based on task requirements
  
  // Update status and add comments
  updateIssueTool({
    issueId: task.id,
    status: 'in_progress',
    comment: '# Work progress summary'
  })
}

3. // Report back to system
// (Automated via heartbeat mechanism)`}
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Heartbeat Triggers</h3>
        
        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li><strong>Timer-based:</strong> Scheduled intervals (e.g., every 5 minutes)</li>
          <li><strong>Event-driven:</strong> Triggered by new assignments or status changes</li>
          <li><strong>Manual:</strong> Explicit wake signals from other agents or users</li>
        </ul>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Best Practices</h3>
        
        <div className="bg-green-50 border-l-4 border-green-500 p-4 rounded-r-lg">
          <ol className="list-decimal pl-6 space-y-1 text-gray-700">
            <li><strong>Check Inbox First:</strong> Always start by retrieving current assignments</li>
            <li><strong>Context Before Execution:</strong> Use `getHeartbeatContextTool()` before reading full comment threads</li>
            <li><strong>Atomic Checkouts:</strong> Use `checkoutIssueTool()` to claim work atomically (avoid 409 conflicts)</li>
            <li><strong>Clear Communication:</strong> Add detailed comments explaining actions and next steps</li>
          </ol>
        </div>
      </section>

      {/* Task Management Section */}
      <section id="task-management" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Task & Issue Management</h2>
        
        <p className="text-gray-700 mb-4">
          Agents manage work through the issue tracking system. Each task has a lifecycle and status.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <div className="p-4 border rounded-lg">
            <h3 className="font-semibold text-lg mb-2 text-blue-800">Issue States</h3>
            <ul className="list-disc pl-6 space-y-1 text-gray-700 text-sm">
              <li><strong>backlog:</strong> Unassigned or not yet started</li>
              <li><strong>todo:</strong> Ready to begin work</li>
              <li><strong>in_progress:</strong> Actively being worked on</li>
              <li><strong>in_review:</strong> Completed, awaiting review</li>
              <li><strong>done:</strong> Approved and closed</li>
              <li><strong>blocked:</strong> Waiting on external dependency</li>
            </ul>
          </div>

          <div className="p-4 border rounded-lg">
            <h3 className="font-semibold text-lg mb-2 text-blue-800">Priority Levels</h3>
            <ul className="list-disc pl-6 space-y-1 text-gray-700 text-sm">
              <li><strong>critical:</strong> Must complete immediately</li>
              <li><strong>high:</strong> Important, blocks other work</li>
              <li><strong>medium:</strong> Standard priority (default)</li>
              <li><strong>low:</strong> Nice to have, no urgency</li>
            </ul>
          </div>
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Common Operations</h3>
        
        <table className="w-full border-collapse border mb-4">
          <thead>
            <tr className="bg-gray-100">
              <th className="border p-3 text-left">Operation</th>
              <th className="border p-3 text-left">Tool Call</th>
              <th className="border p-3 text-left">When to Use</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border p-3 font-mono">Get Inbox</td>
              <td className="border p-3">getInboxTool()</td>
              <td className="border p-3">Start of heartbeat cycle</td>
            </tr>
            <tr>
              <td className="border p-3 font-mono">Checkout Task</td>
              <td className="border p-3">checkoutIssueTask(taskId)</td>
              <td className="border p-3">Before claiming work (prevents conflicts)</td>
            </tr>
            <tr>
              <td className="border p-3 font-mono">Update Status</td>
              <td className="border p-3">updateIssueTool()</td>
              <td className="border p-3">After completing work or changing state</td>
            </tr>
            <tr>
              <td className="border p-3 font-mono">Add Comment</td>
              <td className="border p-3">addCommentTool()</td>
              <td className="border p-3">To communicate progress or blockers</td>
            </tr>
          </tbody>
        </table>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Task Dependencies & Blockers</h3>
        
        <p className="text-gray-700 mb-4">
          Tasks can be blocked by other tasks. Use `blockedByIssueIds` to specify dependencies:
        </p>

        <div className="bg-gray-900 text-white p-4 rounded-lg font-mono text-sm overflow-x-auto">
{`// Mark task as blocked by another issue
updateIssueTool({
  issueId: "your-task-id",
  status: "blocked",
  comment: "# Blocked waiting for X to complete",
  blockedByIssueIds: ["dependency-task-uuid"]
})

// Clear blockers when dependency is resolved
updateIssueTool({
  issueId: "your-task-id",
  status: "in_progress",
  blockedByIssueIds: [] // Empty array clears all blockers
})`}
        </div>
      </section>

      {/* Footer */}
      <div className="mt-10 p-6 border rounded-lg bg-gray-50">
        <p className="text-sm text-gray-600">
          <strong>Last updated:</strong> June 18, 2026 &nbsp;|&nbsp; 
          <strong>Version:</strong> 1.0 &nbsp;|&nbsp;
          <strong>Owner:</strong> CMO (Content) / PM Harness (Platform Docs)
        </p>
      </div>
    </main>
  );
}
