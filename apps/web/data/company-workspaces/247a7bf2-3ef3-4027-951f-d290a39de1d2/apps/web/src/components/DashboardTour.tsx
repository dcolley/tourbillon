'use client';

import { useState, useEffect } from 'react';
import OnboardingTooltip from './OnboardingTooltip';

interface DashboardTourStep {
  id: string;
  targetSelector: string;
  title: string;
  content: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

export default function DashboardTour() {
  const [showTour, setShowTour] = useState(false);
  const [tourComplete, setTourComplete] = useState(false);

  // Check if user has completed tour before
  useEffect(() => {
    const hasCompletedTour = localStorage.getItem('dashboard-tour-completed');
    if (!hasCompletedTour) {
      setShowTour(true);
    }
  }, []);

  const dashboardSteps: DashboardTourStep[] = [
    {
      id: 'goals-panel',
      targetSelector: '#goals-panel',
      title: 'Goals Panel',
      content: 'This is where all your goals are displayed. Create new goals to organize your work and track progress.',
      position: 'bottom' as const,
    },
    {
      id: 'active-projects',
      targetSelector: '#active-projects',
      title: 'Active Projects',
      content: 'View all projects currently in progress. Click on any project to see detailed status and agent activity.',
      position: 'bottom' as const,
    },
    {
      id: 'agent-feed',
      targetSelector: '#agent-activity-feed',
      title: 'Agent Activity Feed',
      content: 'Real-time updates from your AI agents. Watch as they plan and execute tasks automatically.',
      position: 'bottom' as const,
    },
  ];

  const handleComplete = () => {
    setShowTour(false);
    setTourComplete(true);
    localStorage.setItem('dashboard-tour-completed', 'true');
  };

  const handleSkip = () => {
    setShowTour(false);
    localStorage.setItem('dashboard-tour-completed', 'true');
  };

  if (tourComplete) return null;

  return showTour ? (
    <OnboardingTooltip
      steps={dashboardSteps}
      onComplete={handleComplete}
      onSkip={handleSkip}
    />
  ) : null;
}
