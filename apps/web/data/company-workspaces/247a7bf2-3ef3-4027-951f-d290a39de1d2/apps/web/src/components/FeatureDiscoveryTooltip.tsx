'use client';

import { useState } from 'react';
import OnboardingTooltip from './OnboardingTooltip';

interface FeatureCardProps {
  title: string;
  description: string;
  icon: string;
  tooltipSteps?: Array<{ id: string; title: string; content: string; position?: 'top' | 'bottom' | 'left' | 'right' }>;
}

// Reusable feature card with embedded discovery tooltips
export function FeatureDiscoveryCard({ title, description, icon, tooltipSteps = [] }: FeatureCardProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <>
      <div className="bg-white border border-gray-200 rounded-xl p-6 hover:shadow-md transition-shadow group relative">
        {/* Icon */}
        <div className="w-12 h-12 bg-blue-50 rounded-lg flex items-center justify-center text-2xl mb-4">
          {icon}
        </div>

        {/* Title and description */}
        <h3 className="text-lg font-semibold text-gray-900 mb-2">{title}</h3>
        <p className="text-sm text-gray-600 mb-4">{description}</p>

        {/* Discovery tooltip trigger button */}
        <button
          onClick={() => setShowTooltip(true)}
          className="inline-flex items-center px-3 py-1.5 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded-full text-xs font-medium transition-colors"
        >
          <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/>
          </svg>
          Learn More
        </button>

        {/* Hover highlight effect */}
        <div className="absolute inset-0 border-2 border-blue-500 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></div>
      </div>

      {/* Discovery tooltip overlay */}
      {showTooltip && (
        <OnboardingTooltip
          steps={tooltipSteps.length > 0 ? tooltipSteps : [
            { id: 'feature-tooltip', title: `${icon} ${title}`, content: description }
          ]}
          onComplete={() => setShowTooltip(false)}
          onSkip={() => setShowTooltip(false)}
        />
      )}
    </>
  );
}

// Feature discovery section for agents, goals, projects
export default function FeatureDiscoverySection() {
  const [showWelcomeModal, setShowWelcomeModal] = useState(true);

  // Agent feature tooltip steps
  const agentSteps = [
    { id: 'agent-1', title: '🤖 AI Agents', content: 'Tourbillon agents automatically plan and execute tasks. They can handle code generation, data analysis, report writing, and more.' },
    { id: 'agent-2', title: '⚡ Real-time Execution', content: 'Watch your agents work in real-time with live progress updates. You can intervene or provide feedback at any point.' },
  ];

  // Goal feature tooltip steps  
  const goalSteps = [
    { id: 'goal-1', title: '🎯 Strategic Goals', content: 'Define clear, measurable goals that drive your team forward. Each goal provides focus and direction for all projects.' },
    { id: 'goal-2', title: '📊 Progress Tracking', content: 'Track progress toward your goals automatically through project completion metrics and agent activity data.' },
  ];

  // Project feature tooltip steps
  const projectSteps = [
    { id: 'project-1', title: '📁 Organized Projects', content: 'Break down complex work into manageable projects with clear milestones, deadlines, and deliverables.' },
    { id: 'project-2', title: '👥 Collaboration Features', content: 'Invite team members to collaborate on projects. Share updates, assign tasks, and track collective progress.' },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white p-6">
      {/* Welcome Modal - Auto-triggered for first-time users */}
      {showWelcomeModal && (
        <OnboardingTooltip
          steps={[
            { id: 'welcome', title: '👋 Welcome to Tourbillon!', content: 'Your AI-powered productivity platform. Let us show you around.' },
            { id: 'setup', title: '🚀 Quick Setup', content: 'Create your first goal, connect integrations, and let agents handle the heavy lifting.' },
            { id: 'success', title: '🎉 You\'re Ready!', content: 'Start creating goals and projects. Your agents will help you achieve them faster than ever.' }
          ]}
          onComplete={() => setShowWelcomeModal(false)}
          onSkip={() => setShowWelcomeModal(false)}
        />
      )}

      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Explore Tourbillon</h1>
          <p className="text-lg text-gray-600">Discover the powerful features that make your work easier and faster.</p>
        </header>

        {/* Feature Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          {/* Agents Card */}
          <FeatureDiscoveryCard 
            title="AI Agents"
            description="Automate complex workflows with intelligent AI agents that plan, execute, and deliver results."
            icon="🤖"
            tooltipSteps={agentSteps}
          />

          {/* Goals Card */}
          <FeatureDiscoveryCard 
            title="Strategic Goals"
            description="Define clear objectives and track progress automatically through project completion metrics."
            icon="🎯"
            tooltipSteps={goalSteps}
          />

          {/* Projects Card */}
          <FeatureDiscoveryCard 
            title="Organized Projects"
            description="Break down work into manageable projects with milestones, deadlines, and collaboration features."
            icon="📁"
            tooltipSteps={projectSteps}
          />
        </div>

        {/* Additional Features Section */}
        <section className="mt-12">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">More Powerful Features</h2>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Integration Feature */}
            <FeatureDiscoveryCard 
              title="Integrations"
              description="Connect with Slack, GitHub, Notion and dozens of other tools you already use."
              icon="🔗"
              tooltipSteps={[{ id: 'integrations', title: '🔗 Integrations', content: 'Seamlessly connect your favorite tools to extend Tourbillon\'s capabilities.' }]}
            />

            {/* Analytics Feature */}
            <FeatureDiscoveryCard 
              title="Analytics Dashboard"
              description="Track performance metrics, agent activity, and project progress in real-time."
              icon="📊"
              tooltipSteps={[{ id: 'analytics', title: '📊 Analytics', content: 'Gain insights into your team\'s productivity and identify areas for improvement.' }]}
            />

            {/* Security Feature */}
            <FeatureDiscoveryCard 
              title="Enterprise Security"
              description="SOC 2 compliant with end-to-end encryption, role-based access controls, and audit logging."
              icon="🔒"
              tooltipSteps={[{ id: 'security', title: '🔒 Security', content: 'Your data is protected with enterprise-grade security measures.' }]}
            />

            {/* Support Feature */}
            <FeatureDiscoveryCard 
              title="24/7 Support"
              description="Get help whenever you need it. Our support team is always ready to assist."
              icon="💬"
              tooltipSteps={[{ id: 'support', title: '💬 24/7 Support', content: 'Our dedicated support team is available around the clock.' }]}
            />
          </div>

          {/* Call to Action */}
          <div className="mt-12 p-8 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl text-white">
            <h3 className="text-2xl font-bold mb-4">Ready to Get Started?</h3>
            <p className="text-lg opacity-90 mb-6">Create your first goal and let AI agents handle the heavy lifting.</p>
            
            <div className="flex flex-wrap gap-4">
              <button 
                onClick={() => setShowWelcomeModal(true)}
                className="px-6 py-3 bg-white text-blue-600 rounded-lg font-medium hover:bg-gray-100 transition-colors"
              >
                Start New Tour
              </button>
              
              <button className="px-6 py-3 bg-blue-700 border border-blue-500 text-white rounded-lg font-medium hover:bg-blue-800 transition-colors">
                Create First Goal →
              </button>
            </div>
          </div>
        </section>

        {/* Keyboard Shortcuts Section */}
        <section className="mt-12 pt-8 border-t border-gray-200">
          <h3 className="text-xl font-semibold text-gray-900 mb-4">Keyboard Shortcuts</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { shortcut: '⌘ + K', description: 'Quick search across all features' },
              { shortcut: '⌘ + N', description: 'Create new goal or project' },
              { shortcut: '⌘ + /', description: 'Toggle this help overlay' },
              { shortcut: '?', description: 'Show keyboard shortcuts list' },
            ].map((item, idx) => (
              <div key={idx} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <span className="text-sm text-gray-700">{item.description}</span>
                <kbd className="px-2 py-1 bg-white border border-gray-300 rounded text-xs font-mono text-gray-600">
                  {item.shortcut}
                </kbd>
              </div>
            ))}
          </div>
        </section>

        {/* Help Resources */}
        <section className="mt-8 pt-6 border-t border-gray-200">
          <h3 className="text-xl font-semibold text-gray-900 mb-4">Need More Help?</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[
              { icon: '📚', title: 'Documentation', description: 'Comprehensive guides and API references' },
              { icon: '💬', title: 'Live Chat', description: 'Get help from our support team in real-time' },
              { icon: '🎥', title: 'Video Tutorials', description: 'Step-by-step walkthroughs of key features' },
            ].map((resource, idx) => (
              <div key={idx} className="p-4 bg-gray-50 rounded-lg border border-gray-200 hover:bg-white hover:shadow-md transition-all cursor-pointer">
                <span className="text-2xl mb-2 block">{resource.icon}</span>
                <h4 className="font-medium text-gray-900 mb-1">{resource.title}</h4>
                <p className="text-sm text-gray-600">{resource.description}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
