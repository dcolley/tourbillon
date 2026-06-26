'use client';

import Link from 'next/link';

export default function DocsIndexPage() {
  const docs = [
    {
      title: "Tourbillon API Reference",
      description: "Complete reference for Tourbillon's platform APIs, GA4 tracking events, and authentication flows.",
      path: "/docs/api-reference",
      icon: "📡",
      tags: ["API", "GA4", "Authentication"]
    },
    {
      title: "Agent Configuration Guide",
      description: "Comprehensive guide for configuring agents, token budgets, chain of command, and heartbeat operations.",
      path: "/docs/agent-config",
      icon: "🤖",
      tags: ["Agents", "Configuration", "Operations"]
    },
    {
      title: "Goal & Project Management Guide",
      description: "How to structure company goals, create projects, manage issues, and track progress in Tourbillon.",
      path: "/docs/goal-project-management",
      icon: "📋",
      tags: ["Goals", "Projects", "Issues"]
    },
    {
      title: "Deployment Guide",
      description: "Step-by-step guide for deploying Tourbillon including Vercel, Docker, and manual deployment options.",
      path: "/docs/deployment",
      icon: "🚀",
      tags: ["Deployment", "Vercel", "Docker"]
    },
    {
      title: "Quality Guide",
      description: "Quality standards and best practices for Tourbillon development, testing, and release processes.",
      path: "/docs/quality-guide",
      icon: "✅",
      tags: ["Quality", "Standards", "Best Practices"]
    }
  ];

  return (
    <main className="min-h-screen p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-12 text-center">
        <h1 className="text-5xl font-bold mb-4 text-gray-900">Tourbillon Documentation</h1>
        <p className="text-xl text-gray-600 max-w-2xl mx-auto">
          Comprehensive guides and references for the Tourbillon AI agent orchestration platform.
        </p>
      </div>

      {/* Quick Links */}
      <nav className="mb-12 p-4 border rounded-lg bg-blue-50 text-center">
        <h2 className="text-sm font-semibold text-blue-800 mb-2 uppercase tracking-wide">Quick Navigation</h2>
        <div className="flex flex-wrap justify-center gap-3">
          {docs.map((doc) => (
            <Link
              key={doc.path}
              href={doc.path}
              className="px-4 py-2 bg-white border rounded-lg text-sm font-medium text-gray-700 hover:text-blue-600 hover:border-blue-300 transition-colors"
            >
              {doc.icon} {doc.title.split(' ').slice(0, 2).join(' ')}
            </Link>
          ))}
        </div>
      </nav>

      {/* Documentation Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {docs.map((doc) => (
          <Link
            key={doc.path}
            href={doc.path}
            className="block p-6 border rounded-lg bg-white hover:border-blue-500 hover:shadow-md transition-all group"
          >
            <div className="flex items-start justify-between mb-3">
              <h2 className="text-xl font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
                {doc.icon} {doc.title}
              </h2>
              <span className="text-gray-400 group-hover:translate-x-1 transition-transform">→</span>
            </div>
            
            <p className="text-gray-600 mb-4 text-sm leading-relaxed">
              {doc.description}
            </p>

            <div className="flex flex-wrap gap-2">
              {doc.tags.map((tag) => (
                <span
                  key={tag}
                  className="px-2 py-1 bg-gray-100 text-gray-600 rounded text-xs font-medium"
                >
                  {tag}
                </span>
              ))}
            </div>

            <p className="text-sm text-blue-600 mt-4 font-medium group-hover:underline">
              Read guide →
            </p>
          </Link>
        ))}
      </div>

      {/* Getting Started Section */}
      <section className="mb-12 p-8 border rounded-lg bg-gradient-to-r from-blue-50 to-indigo-50">
        <h2 className="text-3xl font-bold mb-6 text-gray-900">Getting Started</h2>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="p-4 bg-white rounded-lg border shadow-sm">
            <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mb-3 text-xl">📖</div>
            <h3 className="font-semibold text-gray-900 mb-2">Read the Guides</h3>
            <p className="text-sm text-gray-600">
              Start with the Agent Configuration Guide to understand how Tourbillon agents work.
            </p>
          </div>

          <div className="p-4 bg-white rounded-lg border shadow-sm">
            <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center mb-3 text-xl">🔌</div>
            <h3 className="font-semibold text-gray-900 mb-2">Check the API</h3>
            <p className="text-sm text-gray-600">
              Review our API Reference for endpoint details, request formats, and authentication.
            </p>
          </div>

          <div className="p-4 bg-white rounded-lg border shadow-sm">
            <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center mb-3 text-xl">🚀</div>
            <h3 className="font-semibold text-gray-900 mb-2">Deploy Tourbillon</h3>
            <p className="text-sm text-gray-600">
              Follow our Deployment Guide to get your instance running on Vercel or Docker.
            </p>
          </div>
        </div>

        {/* Getting Started Steps */}
        <ol className="mt-8 space-y-4">
          {[
            { step: 1, title: "Set Up Your Environment", desc: "Install Node.js v18+ and configure your GA4 tracking ID" },
            { step: 2, title: "Explore the Documentation", desc: "Browse through agent configuration and API reference guides" },
            { step: 3, title: "Configure Goals & Projects", desc: "Set up your first goal with linked issues for team coordination" },
            { step: 4, title: "Deploy to Production", desc: "Use Vercel CLI or Docker to deploy your Tourbillon instance" },
          ].map(({ step, title, desc }) => (
            <li key={step} className="flex items-start gap-4">
              <span className="w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center font-semibold shrink-0">
                {step}
              </span>
              <div>
                <h4 className="font-semibold text-gray-900">{title}</h4>
                <p className="text-sm text-gray-600">{desc}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Community & Resources */}
      <section className="mb-12 p-8 border rounded-lg bg-white">
        <h2 className="text-3xl font-bold mb-6 text-gray-900">Community & Resources</h2>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="p-4 border rounded-lg bg-gray-50">
            <h3 className="font-semibold text-lg mb-2 text-gray-900">📚 Additional Resources</h3>
            <ul className="space-y-2 text-sm text-gray-700">
              <li><a href="#" className="text-blue-600 hover:underline">Tourbillon GitHub Repository</a></li>
              <li><a href="#" className="text-blue-600 hover:underline">Google Analytics Help Center</a></li>
              <li><a href="#" className="text-blue-600 hover:underline">Next.js Documentation</a></li>
              <li><a href="#" className="text-blue-600 hover:underline">Vercel Platform Guide</a></li>
            </ul>
          </div>

          <div className="p-4 border rounded-lg bg-gray-50">
            <h3 className="font-semibold text-lg mb-2 text-gray-900">💬 Get Help</h3>
            <ul className="space-y-2 text-sm text-gray-700">
              <li><a href="#" className="text-blue-600 hover:underline">Join the Tourbillon Community</a></li>
              <li><a href="#" className="text-blue-600 hover:underline">Report an Issue on GitHub</a></li>
              <li><a href="#" className="text-blue-600 hover:underline">Ask a Question in Discussions</a></li>
            </ul>
          </div>
        </div>
      </section>

      {/* Footer */}
      <div className="mt-12 p-8 border rounded-lg bg-gray-50 text-center">
        <h3 className="text-xl font-semibold mb-4 text-gray-900">Need More Help?</h3>
        <p className="text-gray-600 mb-6 max-w-lg mx-auto">
          If you can't find what you're looking for, check out our Quality Guide for best practices or reach out to the Tourbillon team.
        </p>
        
        <div className="flex justify-center gap-4">
          <Link href="/docs/quality-guide" className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors">
            Quality Guide →
          </Link>
          <a href="#" className="px-6 py-3 border border-gray-300 rounded-lg font-medium text-gray-700 hover:border-gray-400 transition-colors">
            Contact Support
          </a>
        </div>

        <p className="text-sm text-gray-500 mt-8">
          <strong>Last updated:</strong> June 18, 2026 &nbsp;|&nbsp; 
          <strong>Version:</strong> 1.0 &nbsp;|&nbsp;
          <strong>Maintained by:</strong> CMO (Content) / PM Harness (Platform Docs)
        </p>
      </div>
    </main>
  );
}
