'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface GoalFormData {
  title: string;
  description: string;
  category: string;
  targetDate: string;
}

export default function CreateGoalPage() {
  const [formData, setFormData] = useState<GoalFormData>({
    title: '',
    description: '',
    category: 'workflow-automation',
    targetDate: '',
  });
  
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState(1); // Step-based wizard (1-3)
  const router = useRouter();

  const categories = [
    { id: 'workflow-automation', label: 'Workflow Automation', icon: '⚡', description: 'Automate repetitive tasks and processes' },
    { id: 'reporting', label: 'Reporting & Analytics', icon: '📊', description: 'Generate reports and track metrics' },
    { id: 'team-collaboration', label: 'Team Collaboration', icon: '👥', description: 'Coordinate team efforts and projects' },
    { id: 'research', label: 'Research & Planning', icon: '🔍', description: 'Gather information and plan strategies' },
    { id: 'content-creation', label: 'Content Creation', icon: '✍️', description: 'Create and manage content workflows' },
    { id: 'customer-support', label: 'Customer Support', icon: '🎧', description: 'Streamline support ticket handling' },
  ];

  const suggestedPrompts = [
    "Automate our weekly report generation",
    "Build a customer feedback collection system", 
    "Set up daily standup summary automation",
    "Create a project status tracking workflow",
    "Generate monthly analytics reports automatically",
    "Streamline our team's task management process",
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.title.trim()) return;
    
    setLoading(true);

    try {
      // In production, this would POST to /api/goals endpoint
      const response = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: formData.title.trim(),
          description: formData.description.trim(),
          category: formData.category,
          targetDate: formData.targetDate || null,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        // Store goal ID for onboarding flow continuation
        sessionStorage.setItem('firstGoalId', data.goal.id);
        
        // Redirect to project creation under this goal
        router.push(`/dashboard/goal/${data.goal.id}/project-create`);
      } else {
        const error = await response.json();
        console.error('Failed to create goal:', error);
      }
    } catch (err) {
      console.error('Error creating goal:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div>
            <nav className="flex items-center space-x-2 text-sm text-gray-500 mb-1">
              <Link href="/dashboard" className="hover:text-blue-600 transition-colors">Dashboard</Link>
              <span>/</span>
              <span className="text-gray-900 font-medium">Create Goal</span>
            </nav>
          </div>
          
          {/* Progress indicator */}
          <div className="flex items-center space-x-2">
            {[1, 2, 3].map((s) => (
              <div key={s} className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                step === s ? 'bg-blue-600 text-white' : 
                step > s ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'
              }`}>
                {step > s ? '✓' : s}
              </div>
            ))}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-3xl mx-auto px-6 py-8">
        {/* Step 1: Choose Category & Prompt */}
        {step === 1 && (
          <>
            <div className="mb-8 text-center">
              <h1 className="text-2xl font-bold text-gray-900 mb-2">Create Your First Goal</h1>
              <p className="text-gray-600">What would you like to accomplish?</p>
            </div>

            {/* Category Selection */}
            <section className="mb-8">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Choose a category</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {categories.map((cat) => (
                  <button
                    key={cat.id}
                    onClick={() => setFormData(prev => ({ ...prev, category: cat.id }))}
                    className={`p-4 rounded-xl border-2 transition-all text-left ${
                      formData.category === cat.id 
                        ? 'border-blue-500 bg-blue-50' 
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-start space-x-3">
                      <span className="text-2xl">{cat.icon}</span>
                      <div>
                        <h4 className="font-semibold text-gray-900">{cat.label}</h4>
                        <p className="text-sm text-gray-600 mt-1">{cat.description}</p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>

            {/* Suggested Prompts */}
            <section className="mb-8">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Or get started with a suggestion</h3>
              <div className="space-y-2">
                {suggestedPrompts.map((prompt, idx) => (
                  <button
                    key={idx}
                    onClick={() => setFormData(prev => ({ ...prev, title: prompt }))}
                    className="w-full p-4 rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-all text-left"
                  >
                    <p className="text-gray-700">{prompt}</p>
                  </button>
                ))}
              </div>
            </section>

            {/* Continue Button */}
            <div className="flex justify-end">
              <button
                onClick={() => setStep(2)}
                className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
              >
                Continue →
              </button>
            </div>
          </>
        )}

        {/* Step 2: Enter Details */}
        {step === 2 && (
          <>
            <div className="mb-8">
              <h1 className="text-2xl font-bold text-gray-900 mb-2">Tell us more about your goal</h1>
              <p className="text-gray-600">Add details to help your agent understand what you need.</p>
            </div>

            {/* Title Field */}
            <section className="mb-8">
              <label htmlFor="goalTitle" className="block text-sm font-medium text-gray-700 mb-2">
                Goal Name *
              </label>
              <input
                id="goalTitle"
                type="text"
                value={formData.title}
                onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                placeholder="e.g., Automate weekly report generation"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none text-lg"
              />
            </section>

            {/* Description Field */}
            <section className="mb-8">
              <label htmlFor="goalDescription" className="block text-sm font-medium text-gray-700 mb-2">
                Description (Optional)
              </label>
              <textarea
                id="goalDescription"
                value={formData.description}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Describe what success looks like for this goal..."
                rows={4}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none resize-none"
              />
            </section>

            {/* Target Date */}
            <section className="mb-8">
              <label htmlFor="targetDate" className="block text-sm font-medium text-gray-700 mb-2">
                Target Date (Optional)
              </label>
              <input
                id="targetDate"
                type="date"
                value={formData.targetDate}
                onChange={(e) => setFormData(prev => ({ ...prev, targetDate: e.target.value }))}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
              />
            </section>

            {/* Navigation Buttons */}
            <div className="flex justify-between">
              <button
                onClick={() => setStep(1)}
                className="px-6 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium transition-colors"
              >
                ← Back
              </button>
              <button
                onClick={() => setStep(3)}
                disabled={!formData.title.trim()}
                className={`px-6 py-3 rounded-lg font-medium transition-colors ${
                  formData.title.trim() 
                    ? 'bg-blue-600 hover:bg-blue-700 text-white' 
                    : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                }`}
              >
                Continue →
              </button>
            </div>
          </>
        )}

        {/* Step 3: Review & Create */}
        {step === 3 && (
          <>
            <div className="mb-8">
              <h1 className="text-2xl font-bold text-gray-900 mb-2">Review your goal</h1>
              <p className="text-gray-600">Looks good? Let's create it!</p>
            </div>

            {/* Review Card */}
            <section className="mb-8 bg-white border border-gray-200 rounded-xl p-6">
              <div className="flex items-start space-x-4 mb-4">
                <span className="text-3xl">
                  {categories.find(c => c.id === formData.category)?.icon || '🎯'}
                </span>
                <div>
                  <h3 className="text-xl font-semibold text-gray-900">{formData.title}</h3>
                  <p className={`text-sm mt-1 ${
                    categories.find(c => c.id === formData.category) 
                      ? 'text-blue-600' 
                      : 'text-gray-500'
                  }`}>
                    {categories.find(c => c.id === formData.category)?.label || formData.category}
                  </p>
                </div>
              </div>

              {formData.description && (
                <p className="text-gray-700 mt-4">{formData.description}</p>
              )}

              {formData.targetDate && (
                <p className="text-sm text-gray-500 mt-3">Target: {new Date(formData.targetDate).toLocaleDateString()}</p>
              )}

              {/* What will happen section */}
              <div className="mt-6 pt-4 border-t border-gray-200">
                <h4 className="font-medium text-gray-900 mb-3">What happens next?</h4>
                <ul className="space-y-2 text-sm text-gray-700">
                  <li className="flex items-start space-x-2">
                    <span className="text-green-500 mt-1">✓</span>
                    <span>An AI agent will be assigned to help execute this goal</span>
                  </li>
                  <li className="flex items-start space-x-2">
                    <span className="text-green-500 mt-1">✓</span>
                    <span>You'll create your first project under this goal</span>
                  </li>
                  <li className="flex items-start space-x-2">
                    <span className="text-green-500 mt-1">✓</span>
                    <span>Your agent will start planning and executing tasks automatically</span>
                  </li>
                </ul>
              </div>
            </section>

            {/* Navigation Buttons */}
            <div className="flex justify-between">
              <button
                onClick={() => setStep(2)}
                className="px-6 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium transition-colors"
              >
                ← Back
              </button>
              <button
                onClick={handleSubmit}
                disabled={loading || !formData.title.trim()}
                className={`px-6 py-3 rounded-lg font-medium transition-colors ${
                  loading || !formData.title.trim()
                    ? 'bg-blue-400 text-white cursor-not-allowed' 
                    : 'bg-green-600 hover:bg-green-700 text-white'
                }`}
              >
                {loading ? (
                  <span className="flex items-center space-x-2">
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                    </svg>
                    <span>Creating Goal...</span>
                  </span>
                ) : (
                  '🎉 Create My First Goal'
                )}
              </button>
            </div>

            {/* Skip for now */}
            <div className="mt-6 pt-4 border-t border-gray-200 text-center">
              <p className="text-sm text-gray-500">
                Not ready to create a goal?{' '}
                <Link href="/dashboard" className="font-medium text-blue-600 hover:text-blue-700">
                  Go back to dashboard
                </Link>
              </p>
            </div>
          </>
        )}

        {/* Help Section */}
        <section className="mt-12 pt-8 border-t border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Need help getting started?</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Help Card 1 */}
            <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
              <h4 className="font-medium text-blue-900 mb-2">📚 Quick Start Guide</h4>
              <p className="text-sm text-blue-800">Learn the basics of creating and managing goals in our detailed guide.</p>
            </div>

            {/* Help Card 2 */}
            <div className="p-4 bg-green-50 rounded-lg border border-green-200">
              <h4 className="font-medium text-green-900 mb-2">💬 Live Chat</h4>
              <p className="text-sm text-green-800">Get real-time help from our support team if you have questions.</p>
            </div>

            {/* Help Card 3 */}
            <div className="p-4 bg-purple-50 rounded-lg border border-purple-200">
              <h4 className="font-medium text-purple-900 mb-2">🎥 Video Tutorials</h4>
              <p className="text-sm text-purple-800">Watch step-by-step tutorials on using Tourbillon effectively.</p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
