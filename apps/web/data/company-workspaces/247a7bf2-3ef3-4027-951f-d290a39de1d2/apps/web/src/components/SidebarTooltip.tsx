'use client';

import { useState } from 'react';
import OnboardingTooltip from './OnboardingTooltip';

interface SidebarItemProps {
  label: string;
  icon: string;
  tooltipText: string;
}

// Reusable sidebar item with integrated tooltip
export function TooltipSidebarItem({ label, icon, tooltipText }: SidebarItemProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <>
      <button
        className="w-full flex items-center space-x-3 px-4 py-2 rounded-lg hover:bg-gray-100 transition-colors group"
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        <span className="text-xl">{icon}</span>
        <span className="font-medium text-gray-700">{label}</span>
        
        {/* Hover tooltip indicator */}
        <div className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
          <svg className="w-4 h-4 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/>
          </svg>
        </div>
      </button>

      {/* Tooltip overlay */}
      {showTooltip && (
        <div className="fixed z-50">
          <OnboardingTooltip
            steps={[{
              id: 'sidebar-tooltip',
              targetSelector: '', // Will be centered
              title: label,
              content: tooltipText,
            }]}
            onComplete={() => setShowTooltip(false)}
            onSkip={() => setShowTooltip(false)}
          />
        </div>
      )}
    </>
  );
}

// Complete sidebar with integrated tooltips for all items
export default function SidebarWithTooltips() {
  const [showFullTour, setShowFullTour] = useState(false);

  const sidebarItems: SidebarItemProps[] = [
    { label: 'Dashboard', icon: '📊', tooltipText: 'Your main hub — view all goals, active projects, and agent activity in one place.' },
    { label: 'Goals', icon: '🎯', tooltipText: 'Organize your work into strategic goals. Each goal can have multiple projects tracking progress.' },
    { label: 'Projects', icon: '📁', tooltipText: 'Break down goals into actionable projects with clear milestones and deadlines.' },
    { label: 'Tasks', icon: '✅', tooltipText: 'Individual tasks assigned to AI agents or team members for execution.' },
    { label: 'Agents', icon: '🤖', tooltipText: 'Manage your AI agents — configure prompts, tools, and automation rules.' },
    { label: 'Integrations', icon: '🔗', tooltipText: 'Connect external services like Slack, GitHub, Notion to extend functionality.' },
    { label: 'Developer Portal', icon: '💻', tooltipText: 'Access API documentation, manage keys, configure webhooks, and monitor usage analytics.' },
    { label: 'Settings', icon: '⚙️', tooltipText: 'Configure your account, team permissions, notification preferences, and billing.' },
  ];

  const fullTourSteps = sidebarItems.map(item => ({
    id: item.label.toLowerCase(),
    targetSelector: '', // Will be centered for simplicity in this example
    title: `${item.icon} ${item.label}`,
    content: item.tooltipText,
  }));

  return (
    <>
      {/* Sidebar container */}
      <div className="w-64 bg-white border-r border-gray-200 min-h-screen">
        <div className="p-4">
          <h1 className="text-xl font-bold text-blue-600 mb-6">Tourbillon</h1>
          
          {/* Navigation menu with tooltips */}
          <nav className="space-y-1">
            {sidebarItems.map((item) => (
              <TooltipSidebarItem key={item.label} {...item} />
            ))}
          </nav>

          {/* Trigger full tour button */}
          <button
            onClick={() => setShowFullTour(true)}
            className="mt-6 w-full px-4 py-2 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded-lg font-medium transition-colors"
          >
            🎯 Take Full Tour
          </button>
        </div>

        {/* User profile section */}
        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-gray-200">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white font-medium">
              JD
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">John Doe</p>
              <p className="text-xs text-gray-500">Free Plan</p>
            </div>
          </div>
        </div>
      </div>

      {/* Full sidebar tour overlay */}
      {showFullTour && (
        <OnboardingTooltip
          steps={fullTourSteps}
          onComplete={() => setShowFullTour(false)}
          onSkip={() => setShowFullTour(false)}
        />
      )}
    </>
  );
}
