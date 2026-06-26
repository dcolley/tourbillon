'use client';

export default function GoalProjectManagementPage() {
  return (
    <main className="min-h-screen p-8 max-w-6xl mx-auto">
      <h1 className="text-4xl font-bold mb-6 text-gray-900">Goal & Project Management Guide</h1>
      
      <p className="text-lg text-gray-600 mb-8">
        Comprehensive guide for structuring company goals, creating projects, and managing issues in the Tourbillon platform.
      </p>

      {/* Table of Contents */}
      <nav className="mb-10 p-4 border rounded-lg bg-gray-50">
        <h2 className="text-xl font-semibold mb-3 text-gray-800">Contents</h2>
        <ol className="list-decimal pl-6 space-y-1 text-gray-700">
          <li><a href="#goals-overview" className="text-blue-600 hover:underline">Goals Overview</a></li>
          <li><a href="#goal-lifecycle" className="text-blue-600 hover:underline">Goal Lifecycle & Statuses</a></li>
          <li><a href="#projects" className="text-blue-600 hover:underline">Projects Under Goals</a></li>
          <li><a href="#issues" className="text-blue-600 hover:underline">Issues & Tasks</a></li>
          <li><a href="#subtasks" className="text-blue-600 hover:underline">Subtask Hierarchy</a></li>
          <li><a href="#goal-tracking" className="text-blue-600 hover:underline">Tracking Goal Progress</a></li>
        </ol>
      </nav>

      {/* Goals Overview */}
      <section id="goals-overview" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Goals Overview</h2>
        
        <p className="text-gray-700 mb-4">
          Goals are top-level strategic objectives that drive all work in the Tourbillon platform. 
          Every task, project, and initiative must be linked to a goal for traceability.
        </p>

        <div className="bg-blue-50 border-l-4 border-blue-500 p-4 rounded-r-lg mb-6">
          <h3 className="font-semibold text-blue-800 mb-2">Key Principle</h3>
          <p className="text-gray-700">
            No orphan tasks are allowed — every issue must have a `goalId` assigned for proper tracking and reporting.
          </p>
        </div>

        <h3 className="text-lg font-semibold mt-6 mb-2 text-gray-800">Active Goals (Current)</h3>
        
        <table className="w-full border-collapse border mb-4">
          <thead>
            <tr className="bg-gray-100">
              <th className="border p-3 text-left">Goal</th>
              <th className="border p-3 text-left">Total Issues</th>
              <th className="border p-3 text-left">Done</th>
              <th className="border p-3 text-left">In Progress</th>
              <th className="border p-3 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border p-3 font-semibold">Product Features for initial release</td>
              <td className="border p-3">4</td>
              <td className="border p-3 text-green-600 font-bold">1</td>
              <td className="border p-3 text-blue-600">2</td>
              <td className="border p-3"><span className="px-2 py-1 bg-green-100 text-green-800 rounded-full text-xs">active</span></td>
            </tr>
            <tr>
              <td className="border p-3 font-semibold">Marketing Goal (Tourbillon Launch)</td>
              <td className="border p-3">19</td>
              <td className="border p-3 text-green-600 font-bold">16</td>
              <td className="border p-3 text-blue-600">3</td>
              <td className="border p-3"><span className="px-2 py-1 bg-green-100 text-green-800 rounded-full text-xs">active</span></td>
            </tr>
            <tr>
              <td className="border p-3 font-semibold">Tourbillon Quality Goal</td>
              <td className="border p-3">18</td>
              <td className="border p-3 text-green-600 font-bold">17</td>
              <td className="border p-3 text-blue-600">0</td>
              <td className="border p-3"><span className="px-2 py-1 bg-green-100 text-green-800 rounded-full text-xs">active</span></td>
            </tr>
          </tbody>
        </table>

        <h3 className="text-lg font-semibold mt-6 mb-2 text-gray-800">Creating a Goal</h3>
        
        <p className="text-gray-700 mb-4">
          Goals are created through the platform interface and include:
        </p>

        <div className="bg-gray-900 text-white p-4 rounded-lg font-mono text-sm overflow-x-auto">
{`// Goal structure returned by listGoalsTool():
{
  "id": "2264f703-9187-456f-99a5-1a0a33da1a9c",
  "title": "marketing goal",
  "description": "Market the tool",
  "status": "active",           // active | completed | archived
  "stats": {
    "total": 19,                // Total issues linked to this goal
    "done": 16,                 // Completed issues count
    "inProgress": 3,            // In-progress issues count
    "blocked": 0,               // Blocked issues count
    "unassigned": 0             // Issues without assignees
  },
  "needsAttention": false       // Flag for goals requiring intervention
}`}
        </div>
      </section>

      {/* Goal Lifecycle Section */}
      <section id="goal-lifecycle" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Goal Lifecycle & Statuses</h2>
        
        <p className="text-gray-700 mb-4">
          Goals progress through a defined lifecycle with specific status transitions.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="p-4 border rounded-lg bg-green-50 text-center">
            <h3 className="font-semibold text-green-800 mb-2">active</h3>
            <p className="text-sm text-gray-700">Goal is currently being worked on. Issues are being created, assigned, and tracked.</p>
          </div>
          
          <div className="p-4 border rounded-lg bg-blue-50 text-center">
            <h3 className="font-semibold text-blue-800 mb-2">completed</h3>
            <p className="text-sm text-gray-700">All linked issues are done and goal objectives have been met.</p>
          </div>
          
          <div className="p-4 border rounded-lg bg-gray-50 text-center">
            <h3 className="font-semibold text-gray-800 mb-2">archived</h3>
            <p className="text-sm text-gray-700">Goal is no longer active but retained for historical reference.</p>
          </div>
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Needs Attention Flag</h3>
        
        <p className="text-gray-700 mb-4">
          Goals with `needsAttention: true` require immediate follow-up. This flag is set when:
        </p>

        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li>Blocked issues are not progressing</li>
          <li>Critical tasks are overdue</li>
          <li>Milestones need review or approval</li>
          <li>Budget allocation requires adjustment</li>
        </ul>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Getting Goal Details</h3>
        
        <div className="bg-gray-900 text-white p-4 rounded-lg font-mono text-sm overflow-x-auto">
{`// Get full goal context with linked issues:
getGoalDetailTool({ goalId: "2264f703-..." })

// Returns:
// - Description and objective details
// - All linked issues (full list)
// - Stats breakdown by status
// - Needs attention flag`}
        </div>
      </section>

      {/* Projects Section */}
      <section id="projects" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Projects Under Goals</h2>
        
        <p className="text-gray-700 mb-4">
          Projects group related issues under a goal for better organization and tracking. 
          Think of goals as strategic objectives, projects as tactical work streams, and issues as individual tasks.
        </p>

        <div className="bg-indigo-50 border-l-4 border-indigo-500 p-4 rounded-r-lg mb-6">
          <h3 className="font-semibold text-indigo-800 mb-2">Hierarchy</h3>
          <ol className="list-decimal pl-6 space-y-1 text-gray-700">
            <li><strong>Goal:</strong> Strategic objective (e.g., "Market the tool")</li>
            <li><strong>Project:</strong> Tactical work stream under a goal (optional)</li>
            <li><strong>Issues:</strong> Individual tasks linked to project or directly to goal</li>
          </ol>
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Project Statuses</h3>
        
        <table className="w-full border-collapse border mb-4">
          <thead>
            <tr className="bg-gray-100">
              <th className="border p-3 text-left">Status</th>
              <th className="border p-3 text-left">Description</th>
              <th className="border p-3 text-left">Usage</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border p-3 font-mono">active</td>
              <td className="border p-3">Project is currently being worked on</td>
              <td className="border p-3">Standard operating state</td>
            </tr>
            <tr>
              <td className="border p-3 font-mono">paused</td>
              <td className="border p-3">Project temporarily halted</td>
              <td className="border p-3">Waiting on external dependency or resources</td>
            </tr>
            <tr>
              <td className="border p-3 font-mono">completed</td>
              <td className="border p-3">All project tasks finished successfully</td>
              <td className="border p-3">Ready for review and closure</td>
            </tr>
            <tr>
              <td className="border p-3 font-mono">archived</td>
              <td className="border p-3">Project no longer relevant, retained for reference</td>
              <td className="border p-3">Historical record only</td>
            </tr>
          </tbody>
        </table>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Creating a Project</h3>
        
        <div className="bg-gray-900 text-white p-4 rounded-lg font-mono text-sm overflow-x-auto">
{`// Create project under a goal:
createProjectTool({
  title: "Launch Campaign",
  description: "Q3 marketing campaign for Tourbillon launch",
  goalId: "2264f703-...",       // Parent goal ID (required)
  status: "active",             // Default active
  ownerAgentId: "..."           // Agent responsible for project
})

// Get project details with linked issues:
getProjectDetailTool({ projectId: "project-id" })`}
        </div>
      </section>

      {/* Issues Section */}
      <section id="issues" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Issues & Tasks</h2>
        
        <p className="text-gray-700 mb-4">
          Issues are the fundamental unit of work in Tourbillon. Each issue tracks a specific task with full lifecycle management.
        </p>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Issue Lifecycle States</h3>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="p-4 border rounded-lg bg-gray-50 text-center">
            <h3 className="font-semibold text-gray-800 mb-2">backlog</h3>
            <p className="text-sm text-gray-700">Unassigned or not yet started</p>
          </div>
          
          <div className="p-4 border rounded-lg bg-yellow-50 text-center">
            <h3 className="font-semibold text-yellow-800 mb-2">todo</h3>
            <p className="text-sm text-gray-700">Ready to begin work, may be assigned</p>
          </div>
          
          <div className="p-4 border rounded-lg bg-blue-50 text-center">
            <h3 className="font-semibold text-blue-800 mb-2">in_progress</h3>
            <p className="text-sm text-gray-700">Actively being worked on by an agent</p>
          </div>
          
          <div className="p-4 border rounded-lg bg-purple-50 text-center">
            <h3 className="font-semibold text-purple-800 mb-2">in_review</h3>
            <p className="text-sm text-gray-700">Completed, awaiting review/approval</p>
          </div>
          
          <div className="p-4 border rounded-lg bg-green-50 text-center">
            <h3 className="font-semibold text-green-800 mb-2">done</h3>
            <p className="text-sm text-gray-700">Approved and closed successfully</p>
          </div>
          
          <div className="p-4 border rounded-lg bg-red-50 text-center">
            <h3 className="font-semibold text-red-800 mb-2">blocked</h3>
            <p className="text-sm text-gray-700">Waiting on external dependency or blocker</p>
          </div>
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Priority Levels</h3>
        
        <table className="w-full border-collapse border mb-4">
          <thead>
            <tr className="bg-gray-100">
              <th className="border p-3 text-left">Priority</th>
              <th className="border p-3 text-left">Usage Criteria</th>
              <th className="border p-3 text-left">Example</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border p-3 font-semibold text-red-600">critical</td>
              <td className="border p-3">Must complete immediately, blocks all other work</td>
              <td className="border p-3">Production outage, security vulnerability</td>
            </tr>
            <tr>
              <td className="border p-3 font-semibold text-orange-600">high</td>
              <td className="border p-3">Important work that blocks other tasks</td>
              <td className="border p-3">Launch-critical feature, blocker for another team</td>
            </tr>
            <tr>
              <td className="border p-3 font-semibold text-yellow-600">medium</td>
              <td className="border p-3">Standard priority work (default)</td>
              <td className="border p-3">Regular feature development, documentation updates</td>
            </tr>
            <tr>
              <td className="border p-3 font-semibold text-gray-600">low</td>
              <td className="border p-3">Nice to have, no immediate urgency</td>
              <td className="border p-3">Cosmetic improvements, technical debt cleanup</td>
            </tr>
          </tbody>
        </table>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Creating an Issue</h3>
        
        <div className="bg-gray-900 text-white p-4 rounded-lg font-mono text-sm overflow-x-auto">
{`// Create top-level issue linked to a goal:
createIssueTool({
  title: "Implement user onboarding flow",
  description: "Create multi-step onboarding wizard with progress tracking",
  goalId: "d8a1018e-...",        // Goal ID (required for traceability)
  assigneeAgentId: "...",        // Agent ID to assign work to
  priority: "high",              // critical | high | medium | low
  blockedByIssueIds: []          // Array of issue IDs this depends on
})

// Update issue status with comment:
updateIssueTool({
  issueId: "issue-id",
  status: "in_progress",
  comment: "# Work started\n- Analyzed requirements\n- Created initial design"
})`}
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Issue Assignee Rules</h3>
        
        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li><strong>Required for work to start:</strong> `assigneeAgentId` must be set when creating an issue if you want immediate action</li>
          <li><strong>Omit to defer:</strong> If you omit `assigneeAgentId`, the task goes to backlog and CEO (CEO) can assign later</li>
          <li><strong>In-Review assignments:</strong> When setting status to `in_review`, assign the reviewer (task requester first, else reportsTo from getIdentity)</li>
        </ul>
      </section>

      {/* Subtasks Section */}
      <section id="subtasks" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Subtask Hierarchy</h2>
        
        <p className="text-gray-700 mb-4">
          Complex work can be broken down into subtasks (child issues) under a parent task. 
          This creates a hierarchical structure for better organization and tracking.
        </p>

        <div className="bg-indigo-50 border-l-4 border-indigo-500 p-4 rounded-r-lg mb-6">
          <h3 className="font-semibold text-indigo-800 mb-2">Key Rules</h3>
          <ul className="list-disc pl-6 space-y-1 text-gray-700">
            <li><strong>No orphan tasks:</strong> Every subtask must have a `parentId` and `goalId`</li>
            <li><strong>Goal traceability:</strong> Subtasks inherit the goal from their parent task</li>
            <li><strong>Billing codes:</strong> Can be specified at any level for cost tracking</li>
          </ul>
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Creating a Subtask</h3>
        
        <div className="bg-gray-900 text-white p-4 rounded-lg font-mono text-sm overflow-x-auto">
{`// Create child issue under existing task:
createSubtaskTool({
  title: "Write API documentation",
  description: "Document all REST endpoints with request/response examples",
  parentId: "parent-task-id",    // Parent issue ID (required)
  goalId: "goal-id",             // Goal ID (required for traceability)
  assigneeAgentId: "...",        // Agent responsible for subtask
  priority: "medium"              // Optional, defaults to medium
})`}
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Subtask Example: Marketing Analytics</h3>
        
        <p className="text-gray-700 mb-4">Current example from the marketing goal:</p>

        <div className="bg-gray-50 p-6 rounded-lg border font-mono text-sm space-y-2">
          <div>📋 <strong>TOUR-28: Review performance data against KPIs</strong></div>
          <div>&nbsp;&nbsp;├─ 🔄 Iterate on channel strategy based on ROI (in_progress)</div>
          <div>&nbsp;&nbsp;├─ 🔄 Perform A/B testing on campaigns (in_progress)</div>
          <div>&nbsp;&nbsp;└─ 🔍 Review performance data against KPIs (backlog)</div>
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Subtask Status Management</h3>
        
        <p className="text-gray-700 mb-4">
          Subtasks can be managed independently:
        </p>

        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li>Each subtask has its own status, priority, and assignee</li>
          <li>Parent task progress is summarized from child tasks</li>
          <li>Subtasks can be blocked by other issues (including those under different parents)</li>
        </ul>
      </section>

      {/* Goal Tracking Section */}
      <section id="goal-tracking" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Tracking Goal Progress</h2>
        
        <p className="text-gray-700 mb-4">
          Monitor goal health through stats, needsAttention flags, and issue progress tracking.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <div className="p-4 border rounded-lg bg-blue-50">
            <h3 className="font-semibold text-blue-800 mb-2">Progress Metrics</h3>
            <ul className="list-disc pl-6 space-y-1 text-gray-700 text-sm">
              <li><strong>Total Issues:</strong> All issues linked to goal</li>
              <li><strong>Done:</strong> Completed and approved tasks</li>
              <li><strong>In Progress:</strong> Active work items</li>
              <li><strong>Blocked:</strong> Tasks waiting on dependencies</li>
              <li><strong>Unassigned:</strong> Issues without assignees (in backlog)</li>
            </ul>
          </div>

          <div className="p-4 border rounded-lg bg-green-50">
            <h3 className="font-semibold text-green-800 mb-2">Completion Rate</h3>
            
            <div className="text-center my-4">
              <div className="text-3xl font-bold text-green-600">100%</div>
              <p className="text-sm text-gray-600 mt-1">Tourbillon Quality Goal</p>
              
              <div className="w-full bg-gray-200 rounded-full h-4 mt-3 mb-1">
                <div className="bg-green-500 h-4 rounded-full" style={{width: '100%'}}></div>
              </div>
            </div>

            <div className="text-center my-4">
              <div className="text-3xl font-bold text-blue-600">84%</div>
              <p className="text-sm text-gray-600 mt-1">Marketing Goal</p>
              
              <div className="w-full bg-gray-200 rounded-full h-4 mt-3 mb-1">
                <div className="bg-blue-500 h-4 rounded-full" style={{width: '84%'}}></div>
              </div>
            </div>

            <div className="text-center my-4">
              <div className="text-3xl font-bold text-purple-600">25%</div>
              <p className="text-sm text-gray-600 mt-1">Product Features Goal</p>
              
              <div className="w-full bg-gray-200 rounded-full h-4 mt-3 mb-1">
                <div className="bg-purple-500 h-4 rounded-full" style={{width: '25%'}}></div>
              </div>
            </div>
          </div>
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Monitoring Goal Health</h3>
        
        <div className="bg-gray-900 text-white p-4 rounded-lg font-mono text-sm overflow-x-auto">
{`// List all goals with stats:
listGoalsTool({ status: "active" })

// Get detailed goal context:
getGoalDetailTool({ goalId: "..." })

// Check for needsAttention flags:
const goals = listGoalsTool()
goals.forEach(goal => {
  if (goal.needsAttention) {
    console.log(\`🚨 Goal \${goal.title} requires attention!\`)
  }
})`}
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Best Practices</h3>
        
        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li><strong>Regular check-ins:</strong> Review goal stats at each heartbeat to track progress</li>
          <li><strong>Clear descriptions:</strong> Write detailed goal descriptions so all agents understand objectives</li>
          <li><strong>Proper linking:</strong> Ensure every issue is linked to the correct goal for accurate reporting</li>
          <li><strong>Status updates:</strong> Keep task statuses current so goal stats reflect reality</li>
        </ul>
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
