'use client';

import { useState, useEffect, useRef } from 'react';

interface TooltipStep {
  id: string;
  targetSelector: string;
  title: string;
  content: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

interface OnboardingTooltipProps {
  steps: TooltipStep[];
  onComplete: () => void;
  onSkip: () => void;
  currentStepIndex?: number;
}

export default function OnboardingTooltip({ 
  steps, 
  onComplete, 
  onSkip,
  currentStepIndex = 0
}: OnboardingTooltipProps) {
  const [activeStep, setActiveStep] = useState(currentStepIndex);
  const [isVisible, setIsVisible] = useState(true);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const targetElementRef = useRef<HTMLElement | null>(null);

  // Find the target element for the current step
  useEffect(() => {
    if (steps[activeStep]) {
      const target = document.querySelector(steps[activeStep].targetSelector);
      targetElementRef.current = target as HTMLElement;
      
      // Auto-dismiss after a timeout for steps without targets
      if (!target && activeStep < steps.length - 1) {
        setTimeout(() => {
          nextStep();
        }, 2000);
      }
    }
  }, [activeStep, steps]);

  const nextStep = () => {
    if (activeStep < steps.length - 1) {
      setActiveStep(prev => prev + 1);
    } else {
      completeOnboarding();
    }
  };

  const prevStep = () => {
    if (activeStep > 0) {
      setActiveStep(prev => prev - 1);
    }
  };

  const completeOnboarding = () => {
    setIsVisible(false);
    onComplete();
    
    // Remove tooltip from DOM after animation
    setTimeout(() => {
      if (tooltipRef.current?.parentElement) {
        tooltipRef.current.parentElement.remove();
      }
    }, 300);
  };

  const skipOnboarding = () => {
    setIsVisible(false);
    onSkip();
    
    setTimeout(() => {
      if (tooltipRef.current?.parentElement) {
        tooltipRef.current.parentElement.remove();
      }
    }, 300);
  };

  // Get position for the tooltip based on target element
  const getTooltipPosition = () => {
    if (!targetElementRef.current || !steps[activeStep]) return 'bottom';

    const target = targetElementRef.current;
    const rect = target.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    // Check if there's enough space at the specified position
    const preferredPosition: 'top' | 'bottom' | 'left' | 'right' = steps[activeStep].position || 'bottom';

    switch (preferredPosition) {
      case 'top':
        if (rect.top > 100) return 'bottom'; // Plenty of space below, so use top
        break;
      case 'bottom':
        if (viewportHeight - rect.bottom > 200) return 'bottom';
        break;
      case 'left':
        if (rect.left > 350) return 'right'; // Not enough room on left, use right
        break;
      case 'right':
        if (viewportWidth - rect.right > 350) return 'right';
        break;
    }

    return preferredPosition;
  };

  const position = getTooltipPosition();

  // Get position classes for the tooltip
  const getPositionClasses = () => {
    switch (position) {
      case 'top':
        return {
          container: `absolute bottom-full left-1/2 transform -translate-x-1/2 mb-4`,
          arrow: 'absolute top-full left-1/2 transform -translate-x-1/2 border-l-8 border-r-8 border-t-8 border-b-0 border-transparent border-t-white',
        };
      case 'bottom':
        return {
          container: `absolute top-full left-1/2 transform -translate-x-1/2 mt-4`,
          arrow: 'absolute bottom-full left-1/2 transform -translate-x-1/2 border-l-8 border-r-8 border-b-8 border-t-0 border-transparent border-b-white',
        };
      case 'left':
        return {
          container: `absolute right-full top-1/2 transform translate-y-[-50%] mr-4`,
          arrow: 'absolute left-full top-1/2 transform -translate-y-1/2 border-t-8 border-b-8 border-l-8 border-r-0 border-transparent border-l-white',
        };
      case 'right':
        return {
          container: `absolute left-full top-1/2 transform translate-y-[-50%] ml-4`,
          arrow: 'absolute right-full top-1/2 transform -translate-y-1/2 border-t-8 border-b-8 border-r-8 border-l-0 border-transparent border-r-white',
        };
      default:
        return {
          container: `absolute bottom-full left-1/2 transform -translate-x-1/2 mb-4`,
          arrow: 'absolute top-full left-1/2 transform -translate-x-1/2 border-l-8 border-r-8 border-t-8 border-b-0 border-transparent border-t-white',
        };
    }
  };

  // If no steps or already completed, don't render anything
  if (!steps.length || !isVisible) return null;

  const currentStep = steps[activeStep];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
        onClick={skipOnboarding}
      />

      {/* Tooltip Content - positioned near target or centered if no target */}
      {targetElementRef.current ? (
        <>
          {/* Dim other elements */}
          <div className="absolute inset-0 pointer-events-none">
            {/* This would normally highlight the target element with a cutout */}
            <style jsx>{`
              body > *:not([data-tooltip-ignore]):not(.tooltip-target) {
                filter: brightness(0.5);
              }
            `}</style>
          </div>

          {/* Tooltip positioned relative to target */}
          <div 
            ref={tooltipRef}
            className={`relative ${getPositionClasses().container}`}
            data-tooltip-ignore
          >
            <div className="bg-white rounded-xl shadow-2xl border border-gray-200 p-6 max-w-md">
              {/* Step indicator */}
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-medium text-gray-500">
                  Step {activeStep + 1} of {steps.length}
                </span>
                
                {/* Progress dots */}
                <div className="flex space-x-1">
                  {steps.map((_, index) => (
                    <div 
                      key={index}
                      className={`w-2 h-2 rounded-full ${
                        index === activeStep ? 'bg-blue-600' : 'bg-gray-300'
                      }`}
                    />
                  ))}
                </div>
              </div>

              {/* Title */}
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                {currentStep.title}
              </h3>

              {/* Content */}
              <p className="text-sm text-gray-600 mb-4">
                {currentStep.content}
              </p>

              {/* Actions */}
              <div className="flex items-center justify-between">
                <button
                  onClick={skipOnboarding}
                  className="text-sm text-gray-500 hover:text-gray-700 font-medium"
                >
                  Skip tour
                </button>

                <div className="flex space-x-2">
                  {activeStep > 0 && (
                    <button
                      onClick={prevStep}
                      className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium transition-colors"
                    >
                      ← Back
                    </button>
                  )}
                  
                  <button
                    onClick={nextStep}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
                  >
                    {activeStep === steps.length - 1 ? 'Finish' : 'Next →'}
                  </button>
                </div>
              </div>
            </div>

            {/* Arrow */}
            <div className={getPositionClasses().arrow}></div>
          </div>
        </>
      ) : (
        /* Centered tooltip if no target element found */
        <div 
          ref={tooltipRef}
          className="relative bg-white rounded-xl shadow-2xl border border-gray-200 p-6 max-w-md mx-auto"
        >
          {/* Step indicator */}
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium text-gray-500">
              Step {activeStep + 1} of {steps.length}
            </span>
            
            {/* Progress dots */}
            <div className="flex space-x-1">
              {steps.map((_, index) => (
                <div 
                  key={index}
                  className={`w-2 h-2 rounded-full ${
                    index === activeStep ? 'bg-blue-600' : 'bg-gray-300'
                  }`}
                />
              ))}
            </div>
          </div>

          {/* Title */}
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            {currentStep.title}
          </h3>

          {/* Content */}
          <p className="text-sm text-gray-600 mb-4">
            {currentStep.content}
          </p>

          {/* Actions */}
          <div className="flex items-center justify-between">
            <button
              onClick={skipOnboarding}
              className="text-sm text-gray-500 hover:text-gray-700 font-medium"
            >
              Skip tour
            </button>

            <div className="flex space-x-2">
              {activeStep > 0 && (
                <button
                  onClick={prevStep}
                  className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium transition-colors"
                >
                  ← Back
                </button>
              )}
              
              <button
                onClick={nextStep}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
              >
                {activeStep === steps.length - 1 ? 'Finish' : 'Next →'}
              </button>
            </div>
          </div>

          {/* Bottom arrow for centered tooltip */}
          <div className="absolute bottom-[-16px] left-1/2 transform -translate-x-1/2 border-l-8 border-r-8 border-b-8 border-t-0 border-transparent border-b-white"></div>
        </div>
      )}
    </div>
  );
}
