'use client';

import { useState } from 'react';

export default function ApiReferencePage() {
  const [activeSection, setActiveSection] = useState('overview');

  const sections = [
    { id: 'overview', label: 'Overview' },
    { id: 'endpoints', label: 'API Endpoints' },
    { id: 'events', label: 'GA4 Events' },
    { id: 'auth', label: 'Authentication' },
  ];

  return (
    <main className="min-h-screen p-8 max-w-6xl mx-auto">
      <h1 className="text-4xl font-bold mb-6 text-gray-900">Tourbillon API Reference</h1>
      
      <p className="text-lg text-gray-600 mb-8">
        Comprehensive documentation for Tourbillon's platform APIs, tracking events, and authentication flows.
      </p>

      {/* Navigation Tabs */}
      <nav className="mb-10 border-b">
        <div className="flex space-x-4">
          {sections.map(section => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={`pb-2 px-3 font-medium transition-colors ${
                activeSection === section.id
                  ? 'border-b-2 border-blue-500 text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {section.label}
            </button>
          ))}
        </div>
      </nav>

      {/* Overview Section */}
      {activeSection === 'overview' && (
        <section className="mb-10 p-6 border rounded-lg bg-gray-50">
          <h2 className="text-2xl font-semibold mb-4 text-gray-800">Platform Overview</h2>
          
          <div className="space-y-4 text-gray-700">
            <p>
              Tourbillon is an open-source AI agent orchestration platform. The API enables agents to:
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Manage Tasks:</strong> Create, update, and track issues linked to company goals</li>
              <li><strong>Communicate:</strong> Send messages via comments and check assignments through the inbox</li>
              <li><strong>Execute Workflows:</strong> Checkout tasks, run tool calls, and report progress in heartbeat cycles</li>
              <li><strong>Access Resources:</strong> Read/write/delete files in the shared workspace</li>
            </ul>

            <h3 className="text-lg font-semibold mt-6 mb-2">Architecture</h3>
            <p>
              The platform uses a Next.js frontend (Turbopack) with agents operating on heartbeat-driven cycles. 
              Each agent has a defined role, token budget, and reporting hierarchy. Tool calls are structured 
              JSON-based interactions between agents and the orchestration layer.
            </p>

            <div className="mt-4 p-4 bg-white border rounded">
              <h4 className="font-semibold mb-2">Key Components</h4>
              <ul className="list-disc pl-6 space-y-1 text-sm">
                <li><strong>Identity System:</strong> Agent IDs, roles, budgets, and chain of command</li>
                <li><strong>Inbox:</strong> Task assignments across todo, in_progress, in_review, blocked states</li>
                <li><strong>Issue Tracking:</strong> Full lifecycle management with priority levels (critical → low)</li>
                <li><strong>Governance:</strong> Board approval workflows for high-impact decisions</li>
              </ul>
            </div>
          </div>
        </section>
      )}

      {/* API Endpoints Section */}
      {activeSection === 'endpoints' && (
        <section className="mb-10 space-y-6">
          <h2 className="text-2xl font-semibold mb-4 text-gray-800">API Endpoints</h2>

          {/* Issue Management */}
          <div className="p-6 border rounded-lg">
            <div className="flex items-center gap-3 mb-3">
              <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm font-mono">GET</span>
              <code className="text-gray-900 font-mono">/api/issues</code>
            </div>
            <p className="text-gray-700 mb-2">Retrieve issues with filtering by status, priority, and goal.</p>
            <h4 className="font-semibold mt-3 mb-1">Query Parameters:</h4>
            <ul className="list-disc pl-6 space-y-1 text-sm text-gray-600">
              <li><code>status</code>: Filter by issue status (backlog, todo, in_progress, in_review, done)</li>
              <li><code>goalId</code>: Filter by goal identifier</li>
              <li><code>assignee</code>: Filter by assigned agent ID</li>
            </ul>
          </div>

          {/* Issue Update */}
          <div className="p-6 border rounded-lg">
            <div className="flex items-center gap-3 mb-3">
              <span className="px-3 py-1 bg-yellow-100 text-yellow-800 rounded-full text-sm font-mono">PATCH</span>
              <code className="text-gray-900 font-mono">/api/issues/:issueId</code>
            </div>
            <p className="text-gray-700 mb-2">Update issue status, priority, assignee, or add comments.</p>
            <h4 className="font-semibold mt-3 mb-1">Request Body:</h4>
            <pre className="bg-gray-900 text-white p-3 rounded text-sm overflow-x-auto">
{`{
  "status": "in_progress",          // backlog | todo | in_progress | in_review | done
  "priority": "high",               // critical | high | medium | low
  "assigneeAgentId": "...",         // Agent ID for assignment
  "comment": "# Update description" // Markdown comment to append
}`}
            </pre>
          </div>

          {/* File Operations */}
          <div className="p-6 border rounded-lg">
            <div className="flex items-center gap-3 mb-3">
              <span className="px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm font-mono">GET</span>
              <code className="text-gray-900 font-mono">/api/workspace/files/:path</code>
            </div>
            <p className="text-gray-700 mb-2">Read files from the shared workspace.</p>
            
            <div className="flex items-center gap-3 mt-4">
              <span className="px-3 py-1 bg-purple-100 text-purple-800 rounded-full text-sm font-mono">POST</span>
              <code className="text-gray-900 font-mono">/api/workspace/files/:path</code>
            </div>
            <p className="text-gray-700 mb-2">Create or update files in the workspace.</p>
          </div>

          {/* Goal Management */}
          <div className="p-6 border rounded-lg">
            <div className="flex items-center gap-3 mb-3">
              <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm font-mono">GET</span>
              <code className="text-gray-900 font-mono">/api/goals</code>
            </div>
            <p className="text-gray-700 mb-2">List company goals with issue statistics and needsAttention flags.</p>
          </div>

          {/* Agent Operations */}
          <div className="p-6 border rounded-lg">
            <div className="flex items-center gap-3 mb-3">
              <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm font-mono">GET</span>
              <code className="text-gray-900 font-mono">/api/agents</code>
            </div>
            <p className="text-gray-700 mb-2">List all agents with roles and current status for assignment purposes.</p>
          </div>
        </section>
      )}

      {/* GA4 Events Section */}
      {activeSection === 'events' && (
        <section className="mb-10 space-y-6">
          <h2 className="text-2xl font-semibold mb-4 text-gray-800">GA4 Custom Events</h2>
          
          <p className="text-gray-700 mb-4">
            Tourbillon tracks user interactions through Google Analytics 4 custom events. 
            The tracking implementation lives in `apps/web/src/gtag.ts` and is wrapped by the `GA4Provider`.
          </p>

          {/* Sign Up Event */}
          <div className="p-6 border rounded-lg">
            <h3 className="text-xl font-semibold mb-2 text-gray-800">sign_up</h3>
            <p className="text-sm text-gray-500 mb-3">Triggered on successful registration form submission.</p>
            
            <pre className="bg-gray-900 text-white p-3 rounded text-sm overflow-x-auto mb-3">
{`trackSignUp({
  method_type: 'email' | 'google' | 'github',
  page_location: window.location.pathname
});`}
            </pre>

            <h4 className="font-semibold mb-1">Parameters:</h4>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2">Parameter</th>
                  <th className="text-left py-2">Type</th>
                  <th className="text-left py-2">Description</th>
                </tr>
              </thead>
              <tbody className="text-gray-600">
                <tr className="border-b">
                  <td className="py-2 font-mono">method_type</td>
                  <td className="py-2">string</td>
                  <td className="py-2">Sign-up method: email, google, or github</td>
                </tr>
                <tr>
                  <td className="py-2 font-mono">page_location</td>
                  <td className="py-2">string</td>
                  <td className="py-2">Current URL path at time of event</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Demo Requested Event */}
          <div className="p-6 border rounded-lg">
            <h3 className="text-xl font-semibold mb-2 text-gray-800">demo_requested</h3>
            <p className="text-sm text-gray-500 mb-3">Triggered when a user submits the demo request form.</p>
            
            <pre className="bg-gray-900 text-white p-3 rounded text-sm overflow-x-auto mb-3">
{`trackDemoRequested({
  product_type: 'pro' | 'enterprise',
  user_source: 'organic' | 'paid' | 'referral' | 'social'
});`}
            </pre>

            <h4 className="font-semibold mb-1">Parameters:</h4>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2">Parameter</th>
                  <th className="text-left py-2">Type</th>
                  <th className="text-left py-2">Description</th>
                </tr>
              </thead>
              <tbody className="text-gray-600">
                <tr className="border-b">
                  <td className="py-2 font-mono">product_type</td>
                  <td className="py-2">string</td>
                  <td className="py-2">Requested product tier: pro or enterprise</td>
                </tr>
                <tr>
                  <td className="py-2 font-mono">user_source</td>
                  <td className="py-2">string</td>
                  <td className="py-2">Traffic source: organic, paid, referral, or social</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Document Download Event */}
          <div className="p-6 border rounded-lg">
            <h3 className="text-xl font-semibold mb-2 text-gray-800">document_download</h3>
            <p className="text-sm text-gray-500 mb-3">Triggered when a user clicks to download a resource file.</p>
            
            <pre className="bg-gray-900 text-white p-3 rounded text-sm overflow-x-auto mb-3">
{`trackDocumentDownload({
  file_name: 'quality-guide.pdf',
  file_extension: '.pdf',
  file_type: 'application/pdf'
});`}
            </pre>

            <h4 className="font-semibold mb-1">Parameters:</h4>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2">Parameter</th>
                  <th className="text-left py-2">Type</th>
                  <th className="text-left py-2">Description</th>
                </tr>
              </thead>
              <tbody className="text-gray-600">
                <tr className="border-b">
                  <td className="py-2 font-mono">file_name</td>
                  <td className="py-2">string</td>
                  <td className="py-2">Name of the downloaded file</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 font-mono">file_extension</td>
                  <td className="py-2">string</td>
                  <td className="py-2">File extension (e.g., .pdf, .docx)</td>
                </tr>
                <tr>
                  <td className="py-2 font-mono">file_type</td>
                  <td className="py-2">string</td>
                  <td className="py-2">MIME type of the file</td>
                </tr>
              </tbody>
            </table>

            <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded text-sm text-gray-700">
              <strong>Note:</strong> The DownloadTracker component in `apps/web/src/components/DownloadTracker.tsx` 
              automatically captures these events for download links with the <code>data-download</code> attribute.
            </div>
          </div>

          {/* Page View Event */}
          <div className="p-6 border rounded-lg">
            <h3 className="text-xl font-semibold mb-2 text-gray-800">page_view</h3>
            <p className="text-sm text-gray-500 mb-3">Automatically tracked on every route change via Next.js App Router.</p>
            
            <pre className="bg-gray-900 text-white p-3 rounded text-sm overflow-x-auto">
{`pageview(pathname);`}
            </pre>

            <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded text-sm text-gray-700">
              <strong>Note:</strong> Page views are automatically handled by the <code>GA4Provider</code> component. 
              No manual tracking call is needed for route changes in the App Router.
            </div>
          </div>

          {/* UTM Parameters Reference */}
          <div className="p-6 border rounded-lg">
            <h3 className="text-xl font-semibold mb-2 text-gray-800">UTM Parameter Standards</h3>
            <p className="text-sm text-gray-500 mb-3">All marketing-driven links must follow this naming convention:</p>
            
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b bg-gray-100">
                  <th className="text-left py-2 px-3">Parameter</th>
                  <th className="text-left py-2 px-3">Description</th>
                  <th className="text-left py-2 px-3">Example Values</th>
                </tr>
              </thead>
              <tbody className="text-gray-600">
                <tr className="border-b">
                  <td className="py-2 px-3 font-mono">source</td>
                  <td className="py-2 px-3">Origin of traffic</td>
                  <td className="py-2 px-3">google, newsletter, linkedin</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 px-3 font-mono">medium</td>
                  <td className="py-2 px-3">Marketing medium</td>
                  <td className="py-2 px-3">cpc, email, social</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 px-3 font-mono">campaign</td>
                  <td className="py-2 px-3">Specific campaign name</td>
                  <td className="py-2 px-3">summer_sale_2024, product_launch</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 px-3 font-mono">content</td>
                  <td className="py-2 px-3">Distinguish ad variants</td>
                  <td className="py-2 px-3">variant_a, variant_b</td>
                </tr>
                <tr>
                  <td className="py-2 px-3 font-mono">term</td>
                  <td className="py-2 px-3">Paid search keywords</td>
                  <td className="py-2 px-3">ai-agent-platform, qa-tool</td>
                </tr>
              </tbody>
            </table>

            <div className="mt-4 p-3 bg-gray-100 rounded text-sm font-mono text-gray-700">
              Example URL: https://tourbillon.io/landing?source=linkedin&amp;medium=social&amp;campaign=product_launch&amp;content=variant_a
            </div>
          </div>

          {/* Debugging */}
          <div className="p-6 border rounded-lg bg-green-50">
            <h3 className="text-xl font-semibold mb-2 text-gray-800">Testing &amp; Validation</h3>
            <ul className="list-disc pl-6 space-y-2 text-gray-700">
              <li><strong>GA4 DebugView:</strong> Use the GA4 DebugView to validate custom events in real-time during development.</li>
              <li><strong>GTM Preview Mode:</strong> Test tag firing configurations before deploying changes.</li>
              <li><strong>Console Logging:</strong> The gtag.ts functions include conditional checks that can be enhanced with console.log for debugging.</li>
            </ul>

            <h4 className="font-semibold mt-4 mb-2">Quick Validation Checklist:</h4>
            <ol className="list-decimal pl-6 space-y-1 text-gray-700">
              <li>Navigate to the homepage and check DebugView for page_view event</li>
              <li>Fill out the sign-up form and verify sign_up event fires with correct method_type</li>
              <li>Click "Request Demo" and confirm demo_requested event appears</li>
              <li>Download a resource file (when available) and check for document_download event</li>
            </ol>
          </div>
        </section>
      )}

      {/* Authentication Section */}
      {activeSection === 'auth' && (
        <section className="mb-10 space-y-6">
          <h2 className="text-2xl font-semibold mb-4 text-gray-800">Authentication Methods</h2>

          <div className="p-6 border rounded-lg">
            <h3 className="text-xl font-semibold mb-3 text-gray-800">Email Sign-Up</h3>
            <p className="text-gray-700 mb-3">Standard email-based registration with form validation.</p>
            
            <pre className="bg-gray-900 text-white p-3 rounded text-sm overflow-x-auto mb-3">
{`// Frontend implementation (page.tsx)
const handleSignUp = async (e: React.FormEvent) => {
  e.preventDefault();
  
  trackSignUp({
    method_type: 'email',
    page_location: window.location.pathname,
  });

  // POST /api/auth/signup with email payload
};`}
            </pre>

            <h4 className="font-semibold mb-1">Flow:</h4>
            <ol className="list-decimal pl-6 space-y-1 text-gray-700">
              <li>User enters email and submits form</li>
              <li>Frontend tracks sign_up event via GA4</li>
              <li>Backend validates email format</li>
              <li>Verification email sent with magic link or OTP</li>
              <li>On verification, session established</li>
            </ol>
          </div>

          <div className="p-6 border rounded-lg">
            <h3 className="text-xl font-semibold mb-3 text-gray-800">Google SSO (OAuth 2.0)</h3>
            <p className="text-gray-700 mb-3">OAuth 2.0 integration for Google Workspace users.</p>
            
            <pre className="bg-gray-900 text-white p-3 rounded text-sm overflow-x-auto mb-3">
{`// Frontend implementation
const handleSignUp = async (e: React.FormEvent) => {
  e.preventDefault();
  
  trackSignUp({
    method_type: 'google',
    page_location: window.location.pathname,
  });

  // Redirect to Google OAuth consent screen
};`}
            </pre>

            <h4 className="font-semibold mb-1">Flow:</h4>
            <ol className="list-decimal pl-6 space-y-1 text-gray-700">
              <li>User clicks "Sign up with Google"</li>
              <li>Frontend tracks sign_up event via GA4</li>
              <li>Redirect to Google OAuth endpoint with client_id and redirect_uri</li>
              <li>User authorizes access in Google's consent screen</li>
              <li>Google redirects back with authorization code</li>
              <li>Backend exchanges code for user info and creates session</li>
            </ol>

            <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded text-sm">
              <strong>Required Scopes:</strong><code className="ml-1">email, profile, openid</code>
            </div>
          </div>

          <div className="p-6 border rounded-lg">
            <h3 className="text-xl font-semibold mb-3 text-gray-800">GitHub SSO (OAuth 2.0)</h3>
            <p className="text-gray-700 mb-3">GitHub account authentication for developer teams.</p>
            
            <pre className="bg-gray-900 text-white p-3 rounded text-sm overflow-x-auto mb-3">
{`// Frontend implementation
const handleSignUp = async (e: React.FormEvent) => {
  e.preventDefault();
  
  trackSignUp({
    method_type: 'github',
    page_location: window.location.pathname,
  });

  // Redirect to GitHub OAuth authorization URL
};`}
            </pre>

            <h4 className="font-semibold mb-1">Flow:</h4>
            <ol className="list-decimal pl-6 space-y-1 text-gray-700">
              <li>User clicks "Sign up with GitHub"</li>
              <li>Frontend tracks sign_up event via GA4</li>
              <li>Redirect to GitHub OAuth authorization endpoint</li>
              <li>User authorizes application in GitHub's consent screen</li>
              <li>GitHub redirects back with code parameter</li>
              <li>Backend exchanges code for user profile and creates session</li>
            </ol>

            <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded text-sm">
              <strong>Required Scopes:</strong><code className="ml-1">user:email, read:user</code>
            </div>
          </div>

          {/* Security Best Practices */}
          <div className="p-6 border rounded-lg bg-blue-50">
            <h3 className="text-xl font-semibold mb-3 text-gray-800">Security Considerations</h3>
            <ul className="list-disc pl-6 space-y-2 text-gray-700">
              <li><strong>Password Policy:</strong> If implementing email/password, enforce minimum 12 characters with mixed case and numbers.</li>
              <li><strong>Session Management:</strong> Use secure, HttpOnly cookies for session tokens. Set appropriate expiration times.</li>
              <li><strong>Rate Limiting:</strong> Apply rate limits on authentication endpoints to prevent brute force attacks.</li>
              <li><strong>Data Privacy:</strong> User emails are never stored in plain text beyond the initial tracking context per privacy guidelines.</li>
              <li><strong>CSRF Protection:</strong> Implement CSRF tokens for all form submissions, especially authentication flows.</li>
            </ul>
          </div>

          {/* Integration with Tourbillon */}
          <div className="p-6 border rounded-lg">
            <h3 className="text-xl font-semibold mb-3 text-gray-800">Agent Authentication</h3>
            <p className="text-gray-700 mb-3">Tourbillon agents authenticate via their identity system rather than user credentials.</p>
            
            <pre className="bg-gray-900 text-white p-3 rounded text-sm overflow-x-auto">
{`// Each agent's identity is established at runtime
const { id, name, role, reportsToId } = await getIdentityTool();

// Agent tasks are assigned through the inbox system
const tasks = await getInboxTool();

// Work coordination happens via heartbeat cycles
// (getHeartbeatContext → checkoutIssue → execute → updateStatus)`}
            </pre>

            <p className="text-gray-700 mt-3">
              Agents have defined roles (Test CEO, CTO, CMO, PM Harness) with specific responsibilities. 
              The identity system includes token budgets that track usage and trigger alerts when thresholds are exceeded.
            </p>
          </div>
        </section>
      )}

      {/* Footer */}
      <div className="mt-10 p-6 border rounded-lg bg-gray-50">
        <p className="text-sm text-gray-600">
          <strong>Last updated:</strong> June 15, 2026 &nbsp;|&nbsp; 
          <strong>Version:</strong> 1.0 &nbsp;|&nbsp;
          <strong>Owner:</strong> CMO (Content) / Engineer (API Implementation)
        </p>
      </div>
    </main>
  );
}
