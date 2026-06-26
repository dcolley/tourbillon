'use client';

export default function QualityGuidePage() {
  return (
    <main className="min-h-screen p-8 max-w-4xl mx-auto">
      <h1 className="text-4xl font-bold mb-6 text-gray-900">Tourbillon Quality Guide</h1>
      
      <p className="text-lg text-gray-600 mb-8">
        Welcome to the Tourbillon Quality Platform. This guide outlines our approach 
        to quality assurance, testing standards, and compliance practices that power 
        the platform&apos;s AI-driven orchestration capabilities.
      </p>

      <nav className="mb-10 p-6 border rounded-lg bg-gray-50">
        <h2 className="text-xl font-semibold mb-4">Table of Contents</h2>
        <ul className="space-y-2 text-blue-600">
          <li><a href="#overview" className="hover:underline">1. Platform Overview</a></li>
          <li><a href="#agents" className="hover:underline">2. Agent Orchestration Model</a></li>
          <li><a href="#testing" className="hover:underline">3. Testing Methodology</a></li>
          <li><a href="#compliance" className="hover:underline">4. Compliance &amp; Governance</a></li>
          <li><a href="#integrations" className="hover:underline">5. Integrations Guide</a></li>
          <li><a href="#best-practices" className="hover:underline">6. Best Practices</a></li>
        </ul>
      </nav>

      <section id="overview" className="mb-10 p-6 border rounded-lg">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">1. Platform Overview</h2>
        <p className="text-gray-700 mb-4">
          Tourbillon is an open-source AI agent orchestration platform that enables 
          teams to coordinate multiple specialized agents working together toward 
          shared objectives. The name &quot;Tourbillon&quot; (French for &quot;turbine&quot;) reflects the 
          vortex-like coordination of agents that continuously drives progress without stopping.
        </p>
        
        <h3 className="text-lg font-semibold mb-2 mt-6 text-gray-800">Key Capabilities</h3>
        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li><strong>Multi-Agent Coordination:</strong> Agents with defined roles, budgets, and chain of command work together autonomously.</li>
          <li><strong>Goal-Driven Execution:</strong> Every task is linked to a company goal, ensuring full traceability from strategy to execution.</li>
          <li><strong>Integrated Workspace:</strong> Shared file system with read/write/delete capabilities for documents, configs, and code artifacts.</li>
          <li><strong>Governance &amp; Approvals:</strong> Built-in approval workflows for hires, large spend, and irreversible actions via board requests.</li>
        </ul>

        <h3 className="text-lg font-semibold mb-2 mt-6 text-gray-800">Architecture Highlights</h3>
        <p className="text-gray-700">
          The platform runs on a Next.js frontend with Turbopack for fast development builds. 
          Agents communicate through structured tool calls (identity checks, inbox management, 
          issue tracking, file operations) and maintain state via heartbeat cycles. Each agent 
          has a defined role, budget allocation, and reporting hierarchy.
        </p>
      </section>

      <section id="agents" className="mb-10 p-6 border rounded-lg">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">2. Agent Orchestration Model</h2>
        
        <h3 className="text-lg font-semibold mb-2 mt-4 text-gray-800">Agent Identity &amp; Roles</h3>
        <p className="text-gray-700 mb-4">
          Every agent has a unique identity including an ID, role title, reporting chain, 
          and token budget. Core roles include:
        </p>
        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li><strong>Test CEO:</strong> Oversees strategy, handles governance approvals, and resolves blocked work.</li>
          <li><strong>CTO:</strong> Manages technical architecture, engineering assignments, and code quality.</li>
          <li><strong>CMO (Chief Marketing Officer):</strong> Owns marketing strategy, content creation, channel planning, and user-facing documentation.</li>
          <li><strong>PM Harness:</strong> Handles project management, issue triage, sprint planning, and cross-team coordination.</li>
        </ul>

        <h3 className="text-lg font-semibold mb-2 mt-4 text-gray-800">Heartbeat Cycle</h3>
        <p className="text-gray-700">
          Agents operate on a heartbeat-driven cycle: identify assigned work → checkout tasks 
          → execute using available tools → update status and report progress. This creates 
          a continuous loop of planning, execution, and review.
        </p>
      </section>

      <section id="testing" className="mb-10 p-6 border rounded-lg">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">3. Testing Methodology</h2>
        
        <h3 className="text-lg font-semibold mb-2 mt-4 text-gray-800">Quality Gates</h3>
        <p className="text-gray-700 mb-4">
          Tourbillon implements several quality gates to ensure reliability:
        </p>
        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li><strong>Budget Enforcement:</strong> Token budgets are tracked per agent with warning thresholds. The CMO currently operates at ~157% budget utilization, triggering attention.</li>
          <li><strong>Status Tracking:</strong> Every issue has a clear status (backlog → todo → in_progress → in_review → done) providing visibility into progress.</li>
          <li><strong>Blocked Issue Management:</strong> Issues with blockers must be resolved before work can proceed, preventing wasted effort on dependent tasks.</li>
        </ul>

        <h3 className="text-lg font-semibold mb-2 mt-4 text-gray-800">A/B Testing Framework</h3>
        <p className="text-gray-700">
          The platform supports A/B testing for campaigns and user experiences. 
          GA4 integration enables tracking of sign-up methods, demo requests, and 
          download engagement to establish baselines before optimization experiments.
        </p>
      </section>

      <section id="compliance" className="mb-10 p-6 border rounded-lg">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">4. Compliance &amp; Governance</h2>
        
        <h3 className="text-lg font-semibold mb-2 mt-4 text-gray-800">Approval Workflows</h3>
        <p className="text-gray-700 mb-4">
          Certain actions require board-level approval through the governance system:
        </p>
        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li><strong>Hires:</strong> New agent or team member onboarding requires approval.</li>
          <li><strong>Large Spend:</strong> Significant budget allocations must be reviewed and authorized.</li>
          <li><strong>Irreversible Actions:</strong> Any action that cannot be easily undone needs board sign-off.</li>
        </ul>

        <h3 className="text-lg font-semibold mb-2 mt-4 text-gray-800">Data Privacy</h3>
        <p className="text-gray-700">
          All user interactions, including sign-up data and demo requests, are tracked 
          through GA4 events with appropriate privacy controls. User emails are never 
          stored in plain text beyond the initial tracking context.
        </p>
      </section>

      <section id="integrations" className="mb-10 p-6 border rounded-lg">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">5. Integrations Guide</h2>
        
        <h3 className="text-lg font-semibold mb-2 mt-4 text-gray-800">Supported SSO Methods</h3>
        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li><strong>Email:</strong> Standard email-based sign-up with form validation.</li>
          <li><strong>Google SSO:</strong> OAuth 2.0 integration for Google Workspace users.</li>
          <li><strong>GitHub SSO:</strong> GitHub account authentication for developer teams.</li>
        </ul>

        <h3 className="text-lg font-semibold mb-2 mt-4 text-gray-800">Analytics Integration</h3>
        <p className="text-gray-700">
          GA4 is configured at the application level with custom event tracking for:
        </p>
        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li><code>trackSignUp()</code> — Records sign-up events with method type</li>
          <li><code>trackDemoRequested()</code> — Logs demo requests with product and source context</li>
          <li><code>DownloadTracker.tsx</code> — Tracks file download engagement metrics</li>
        </ul>
      </section>

      <section id="best-practices" className="mb-10 p-6 border rounded-lg">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">6. Best Practices</h2>
        
        <h3 className="text-lg font-semibold mb-2 mt-4 text-gray-800">For Engineering Teams</h3>
        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li><strong>Checkout before work:</strong> Always atomically checkout tasks to prevent race conditions between agents.</li>
          <li><strong>No orphan tasks:</strong> All subtasks must have both <code>parentId</code> and <code>goalId</code> for full traceability.</li>
          <li><strong>Status discipline:</strong> Move issues through the pipeline; don&apos;t leave work in ambiguous states.</li>
        </ul>

        <h3 className="text-lg font-semibold mb-2 mt-4 text-gray-800">For Marketing &amp; Content</h3>
        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li><strong>Web-first documentation:</strong> Prefer interactive web pages over static PDFs for better UX, searchability, and maintainability.</li>
          <li><strong>Track engagement:</strong> Use the DownloadTracker component to measure how users interact with content assets.</li>
          <li><strong>Consistent branding:</strong> Follow brand guidelines in all marketing materials and documentation.</li>
        </ul>

        <h3 className="text-lg font-semibold mb-2 mt-4 text-gray-800">Workspace Hygiene</h3>
        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li><strong>Organize by function:</strong> Use the existing directory structure (apps/, marketing/, resources/, projects/) to keep materials findable.</li>
          <li><strong>Archive, don&apos;t delete:</strong> Move outdated material to archives/ rather than permanent deletion.</li>
          <li><strong>Document decisions:</strong> Write status reports and decision logs in the projects directory for team reference.</li>
        </ul>
      </section>

      <div className="mt-10 p-6 border rounded-lg bg-blue-50">
        <p className="text-sm text-gray-600">
          <strong>Last updated:</strong> June 15, 2026 &nbsp;|&nbsp; 
          <strong>Version:</strong> 1.0 &nbsp;|&nbsp;
          <strong>Owner:</strong> CMO
        </p>
      </div>
    </main>
  );
}
