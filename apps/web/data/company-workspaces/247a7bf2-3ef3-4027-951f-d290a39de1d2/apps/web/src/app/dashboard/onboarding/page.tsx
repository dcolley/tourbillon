'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Milestone {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  category: 'setup' | 'first-goal' | 'team' | 'advanced';
}

export default function OnboardingPage() {
  const [milestones, setMilestones] = useState<Milestone[]>([
    // Setup milestones
    { id: 'signup', title: 'Create Account', description: 'Sign up with email or social login', completed: true, category: 'setup' },
    { id: 'verify-email', title: 'Verify Email', description: 'Check your inbox for verification link', completed: false, category: 'setup' },
    { id: 'complete-profile', title: 'Complete Profile', description: 'Add your name and role', completed: false, category: 'setup' },
    
    // First goal milestones
    { id: 'create-goal', title: 'Create Your First Goal', description: 'Define what you want to accomplish', completed: false, category: 'first-goal' },
    { id: 'create-project', title: 'Create a Project', description: 'Set up your first project under the goal', completed: false, category: 'first-goal' },
    { id: 'assign-agent', title: 'Assign an Agent', description: 'Let AI help you get started', completed: false, category: 'first-goal' },
    
    // Team milestones
    { id: 'invite-team', title: 'Invite a Team Member', description: 'Collaborate with teammates', completed: false, category: 'team' },
    { id: 'first-collab', title: 'First Collaboration', description: 'Review your agent\'s work together', completed: false, category: 'team' },
    
    // Advanced milestones
    { id: 'explore-integrations', title: 'Connect Integrations', description: 'Link Slack, GitHub, or other tools', completed: false, category: 'advanced' },
    { id: 'create-template', title: 'Save a Template', description: 'Reuse project structures for future work', completed: false, category: 'advanced' },
  ]);

  const [activeSection, setActiveSection] = useState<string>('setup');

  // Load onboarding progress from localStorage
  useEffect(() => {
    const savedProgress = localStorage.getItem('onboarding-progress');
    if (savedProgress) {
      try {
        const completedIds = JSON.parse(savedProgress);
        setMilestones(prev => prev.map(m => ({
          ...m,
          completed: completedIds.includes(m.id),
        })));
      } catch (e) {
        console.error('Failed to parse onboarding progress:', e);
      }
    }
  }, []);

  const toggleMilestone = (id: string) => {
    setMilestones(prev => prev.map(m => {
      if (m.id === id) {
        const newCompleted = !m.completed;
        
        // Update localStorage
        const savedProgress = localStorage.getItem('onboarding-progress');
        let completedIds: string[] = [];
        if (savedProgress) {
          try {
            completedIds = JSON.parse(savedProgress);
          } catch (e) {
            completedIds = [];
          }
        }
        
        if (newCompleted && !completedIds.includes(id)) {
          completedIds.push(id);
        } else if (!newCompleted) {
          completedIds = completedIds.filter(cid => cid !== id);
        }
        
        localStorage.setItem('onboarding-progress', JSON.stringify(completedIds));
        
        return { ...m, completed: newCompleted };
      }
      return m;
    }));
  };

  const categories = [
    { id: 'setup', label: 'Setup', icon: '🚀', color: 'blue' },
    { id: 'first-goal', label: 'First Goal', icon: '🎯', color: 'green' },
    { id: 'team', label: 'Team Work', icon: '👥', color: 'purple' },
    { id: 'advanced', label: 'Advanced', icon: '⚡', color: 'orange' },
  ];

  const completedCount = milestones.filter(m => m.completed).length;
  const totalCount = milestones.length;
  const progressPercent = Math.round((completedCount / totalCount) * 100);

  // Get completion status for a category
  const getCategoryCompletion = (categoryId: string) => {
    const categoryMilestones = milestones.filter(m => m.category === categoryId);
    if (categoryMilestones.length === 0) return 0;
    
    const completedInCategory = categoryMilestones.filter(m => m.completed).length;
    return Math.round((completedInCategory / categoryMilestones.length) * 100);
  };

  // Get the next recommended action
  const getNextRecommendedAction = () => {
    for (const milestone of milestones) {
      if (!milestone.completed) {
        return milestone;
      }
    }
    return null;
  };

  const nextAction = getNextRecommendedAction();

  // Get color classes based on category
  const getCategoryColorClasses = (categoryId: string) => {
    switch (categoryId) {
      case 'setup': return { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-600', badge: 'bg-blue-100 text-blue-700' };
      case 'first-goal': return { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-600', badge: 'bg-green-100 text-green-700' };
      case 'team': return { bg: 'bg-purple-50', border: 'border-purple-200', text: 'text-purple-600', badge: 'bg-purple-100 text-purple-700' };
      case 'advanced': return { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-600', badge: 'bg-orange-100 text-orange-700' };
      default: return { bg: 'bg-gray-50', border: 'border-gray-200', text: 'text-gray-600', badge: 'bg-gray-100 text-gray-700' };
    }
  };

  // Render category milestones
  const renderCategoryMilestones = (categoryId: string) => {
    const colors = getCategoryColorClasses(categoryId);
    const progress = getCategoryCompletion(categoryId);
    
    return (
      <div key={categoryId} className={`mb-8 p-6 rounded-xl border ${colors.border} ${colors.bg}`}>
        {/* Category header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center space-x-2">
            <span>{categories.find(c => c.id === categoryId)?.icon}</span>
            <span>{categories.find(c => c.id === categoryId)?.label}</span>
          </h3>
          
          {/* Progress indicator */}
          <div className="flex items-center space-x-2">
            <span className={`text-sm font-medium ${colors.text}`}>
              {progress}% complete
            </span>
            <div className="w-20 bg-white rounded-full h-2 border border-gray-200">
              <div 
                className={`h-2 rounded-full transition-all duration-500 ${colors.text.replace('text-', 'bg-')}`}
                style={{ width: `${progress}%` }}
              ></div>
            </div>
          </div>
        </div>

        {/* Milestone list */}
        <div className="space-y-3">
          {milestones.filter(m => m.category === categoryId).map((milestone) => (
            <button
              key={milestone.id}
              onClick={() => toggleMilestone(milestone.id)}
              className={`w-full flex items-start space-x-3 p-4 rounded-lg border transition-all ${
                milestone.completed 
                  ? 'bg-white border-green-200' 
                  : 'border-gray-200 hover:border-blue-300 hover:bg-white'
              }`}
            >
              {/* Checkbox */}
              <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center border ${
                milestone.completed 
                  ? 'bg-green-500 border-green-500 text-white' 
                  : 'border-gray-300 bg-white'
              }`}>
                {milestone.completed && (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>

              {/* Content */}
              <div className="flex-1 text-left">
                <h4 className={`font-medium ${milestone.completed ? 'text-gray-900 line-through' : 'text-gray-900'}`}>
                  {milestone.title}
                </h4>
                <p className={`text-sm mt-1 ${milestone.completed ? 'text-gray-500' : 'text-gray-600'}`}>
                  {milestone.description}
                </p>
              </div>

              {/* Completion status */}
              {milestone.completed && (
                <span className="flex-shrink-0 px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium">
                  Done
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div>
            <nav className="flex items-center space-x-2 text-sm text-gray-500 mb-1">
              <Link href="/dashboard" className="hover:text-blue-600 transition-colors">Dashboard</Link>
              <span>/</span>
              <span className="text-gray-900 font-medium">Onboarding Progress</span>
            </nav>
          </div>
          
          {/* Overall progress */}
          <div className="flex items-center space-x-3">
            <span className={`text-sm font-medium ${progressPercent === 100 ? 'text-green-600' : 'text-gray-700'}`}>
              {completedCount}/{totalCount} complete
            </span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-6 py-8">
        {/* Progress Overview Card */}
        <section className="mb-10 bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
          <div className="flex flex-col md:flex-row items-center justify-between space-y-4 md:space-y-0">
            {/* Left side - Progress info */}
            <div className="text-center md:text-left">
              <h1 className="text-2xl font-bold text-gray-900 mb-1">Welcome to Tourbillon!</h1>
              <p className={`text-lg ${progressPercent === 100 ? 'text-green-600' : 'text-gray-600'}`}>
                {progressPercent === 100 
                  ? '🎉 You\'re all set! Start exploring advanced features.' 
                  : `Keep going — you're ${progressPercent}% of the way to activation.`}
              </p>
            </div>

            {/* Right side - Progress bar */}
            <div className="w-full md:w-64">
              <div className="flex items-center justify-between mb-2">
                <span className={`text-sm font-semibold ${progressPercent === 100 ? 'text-green-600' : 'text-blue-600'}`}>
                  {progressPercent}% Complete
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                <div 
                  className={`h-3 rounded-full transition-all duration-700 ${
                    progressPercent === 100 ? 'bg-green-500' : 'bg-blue-600'
                  }`}
                  style={{ width: `${progressPercent}%` }}
                ></div>
              </div>
            </div>
          </div>

          {/* Quick stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-6 border-t border-gray-100">
            <div className="text-center p-3 bg-blue-50 rounded-lg">
              <div className="text-2xl font-bold text-blue-600">{milestones.filter(m => m.category === 'setup').filter(m => m.completed).length}</div>
              <div className="text-sm text-gray-600 mt-1">Setup Done</div>
            </div>
            
            <div className="text-center p-3 bg-green-50 rounded-lg">
              <div className="text-2xl font-bold text-green-600">{milestones.filter(m => m.category === 'first-goal').filter(m => m.completed).length}</div>
              <div className="text-sm text-gray-600 mt-1">First Goal</div>
            </div>
            
            <div className="text-center p-3 bg-purple-50 rounded-lg">
              <div className="text-2xl font-bold text-purple-600">{milestones.filter(m => m.category === 'team').filter(m => m.completed).length}</div>
              <div className="text-sm text-gray-600 mt-1">Team Work</div>
            </div>
            
            <div className="text-center p-3 bg-orange-50 rounded-lg">
              <div className="text-2xl font-bold text-orange-600">{milestones.filter(m => m.category === 'advanced').filter(m => m.completed).length}</div>
              <div className="text-sm text-gray-600 mt-1">Advanced</div>
            </div>
          </div>

          {/* Next recommended action */}
          {nextAction && (
            <div className={`mt-6 p-4 rounded-lg border ${getCategoryColorClasses(nextAction.category).border} ${getCategoryColorClasses(nextAction.category).bg}`}>
              <h3 className="font-medium text-gray-900 mb-2">Next Recommended Action:</h3>
              <p className="text-sm text-gray-700">{nextAction.title}</p>
            </div>
          )}
        </section>

        {/* Category Progress Cards */}
        {categories.map(category => renderCategoryMilestones(category.id))}

        {/* Help Section */}
        <section className="mt-12 pt-8 border-t border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Need help?</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Help Card 1 */}
            <div className="p-4 bg-blue-50 rounded-lg border border-blue-200 hover:bg-blue-100 transition-colors cursor-pointer">
              <h4 className="font-medium text-blue-900 mb-2">📚 Quick Start Guide</h4>
              <p className="text-sm text-blue-800">Learn the basics of creating and managing goals in our detailed guide.</p>
            </div>

            {/* Help Card 2 */}
            <div className="p-4 bg-green-50 rounded-lg border border-green-200 hover:bg-green-100 transition-colors cursor-pointer">
              <h4 className="font-medium text-green-900 mb-2">💬 Live Chat</h4>
              <p className="text-sm text-green-800">Get real-time help from our support team if you have questions.</p>
            </div>

            {/* Help Card 3 */}
            <div className="p-4 bg-purple-50 rounded-lg border border-purple-200 hover:bg-purple-100 transition-colors cursor-pointer">
              <h4 className="font-medium text-purple-900 mb-2">🎥 Video Tutorials</h4>
              <p className="text-sm text-purple-800">Watch step-by-step tutorials on using Tourbillon effectively.</p>
            </div>
          </div>

          {/* Skip Onboarding */}
          {progressPercent === 100 && (
            <div className="mt-6 pt-4 border-t border-gray-200 text-center">
              <Link 
                href="/dashboard" 
                className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors inline-block"
              >
                Go to Dashboard →
              </Link>
            </div>
          )}

          {/* Continue with defaults */}
          {progressPercent < 100 && (
            <div className="mt-6 pt-4 border-t border-gray-200 text-center">
              <p className="text-sm text-gray-500">
                Not ready to complete all steps?{' '}
                <Link href="/dashboard" className="font-medium text-blue-600 hover:text-blue-700">
                  Go back to dashboard (you can always come back)
                </Link>
              </p>
            </div>
          )}
        </section>

        {/* Celebration Animation */}
        {progressPercent === 100 && (
          <div className="fixed inset-0 pointer-events-none flex items-center justify-center z-50">
            <div className="text-center">
              <div className="animate-bounce text-6xl mb-4">🎉</div>
              <p className="text-xl font-bold text-gray-900">Congratulations!</p>
              <p className="text-lg text-gray-600 mt-2">You've completed all onboarding tasks.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
