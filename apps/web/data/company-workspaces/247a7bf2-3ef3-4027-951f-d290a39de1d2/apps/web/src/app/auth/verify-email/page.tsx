'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function VerifyEmailPage() {
  const [email] = useState(() => {
    // Try to get email from sessionStorage (set during signup)
    if (typeof window !== 'undefined') {
      const userData = sessionStorage.getItem('userOnboarding');
      if (userData) {
        try {
          return JSON.parse(userData).email;
        } catch {
          return '';
        }
      }
    }
    return '';
  });
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(60);
  
  const router = useRouter();

  // Handle countdown timer for resend button
  useEffect(() => {
    if (resendCooldown <= 0) return;
    
    const timer = setInterval(() => {
      setResendCooldown(prev => prev - 1);
    }, 1000);
    
    return () => clearInterval(timer);
  }, [resendCooldown]);

  const handleEmailVerification = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      // In production, this would verify the token from email link
      // For now, we'll simulate verification and redirect to onboarding flow
      
      const userData = sessionStorage.getItem('userOnboarding');
      if (!userData) {
        setError('No user data found. Please sign up again.');
        setLoading(false);
        return;
      }

      // Simulate successful verification after a delay
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      setSuccess(true);
      sessionStorage.removeItem('userOnboarding');
      
      // Redirect to onboarding dashboard or first goal creation
      setTimeout(() => {
        router.push('/dashboard'); // or /onboarding/first-goal depending on flow
      }, 2000);
    } catch (err) {
      setError('Verification failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleResendEmail = async () => {
    if (resendCooldown > 0) return;
    
    setLoading(true);
    setResendCooldown(60); // Reset cooldown
    
    try {
      // In production, this would trigger a resend email API call
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      alert('Verification email resent! Please check your inbox.');
    } catch (err) {
      setError('Failed to resend email. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-100 px-4">
      {/* Background decoration */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-blue-200 rounded-full mix-blend-multiply filter blur-xl opacity-30 animate-pulse"></div>
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-purple-200 rounded-full mix-blend-multiply filter blur-xl opacity-30 animate-pulse" style={{ animationDelay: '2s' }}></div>
      </div>

      <div className="relative max-w-md w-full">
        {/* Logo */}
        <div className="text-center mb-8">
          <Link href="/" className="inline-block">
            <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
              Tourbillon
            </h1>
          </Link>
        </div>

        {/* Main Card */}
        <div className="bg-white rounded-2xl shadow-xl border border-gray-100 p-8">
          {success ? (
            /* Success State */
            <>
              <div className="text-center mb-6">
                <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h2 className="text-xl font-semibold text-gray-900 mb-2">Email Verified!</h2>
                <p className="text-gray-600">Setting up your workspace...</p>
              </div>

              {/* Loading animation */}
              <div className="flex justify-center">
                <svg className="animate-spin h-8 w-8 text-blue-600" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                </svg>
              </div>

              <p className="text-center text-sm text-gray-500 mt-4">Redirecting to your dashboard...</p>
            </>
          ) : (
            /* Verify Email State */
            <>
              {/* Header */}
              <div className="flex items-center justify-between mb-6">
                <button 
                  onClick={() => router.push('/auth/signup')}
                  className="text-gray-500 hover:text-gray-700 transition-colors"
                >
                  ← Back
                </button>
                <h2 className="text-lg font-semibold text-gray-900">Verify Your Email</h2>
                <div></div>
              </div>

              {/* Icon */}
              <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-6">
                <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>

              {/* Instructions */}
              <div className="text-center mb-6">
                <p className="text-gray-700 mb-2">
                  We've sent a verification link to:
                </p>
                <p className="font-medium text-blue-600">{email}</p>
              </div>

              {/* Main Content */}
              {error && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  {error}
                </div>
              )}

              <form onSubmit={handleEmailVerification} className="space-y-4">
                {/* Manual verification code input */}
                <div>
                  <label htmlFor="verificationCode" className="block text-sm font-medium text-gray-700 mb-1">
                    Enter Verification Code (Optional)
                  </label>
                  <input
                    id="verificationCode"
                    type="text"
                    placeholder="Enter 6-digit code from email"
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none text-center tracking-widest font-mono"
                  />
                </div>

                {/* Submit Button */}
                <button
                  type="submit"
                  disabled={loading}
                  className={`w-full px-4 py-3 rounded-lg font-medium transition-all duration-200 ${
                    loading 
                      ? 'bg-blue-400 cursor-not-allowed' 
                      : 'bg-blue-600 hover:bg-blue-700 text-white'
                  }`}
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                      </svg>
                      Verifying...
                    </span>
                  ) : (
                    'Verify Email'
                  )}
                </button>
              </form>

              {/* Resend Email */}
              <div className="mt-6 text-center">
                <p className="text-sm text-gray-500 mb-2">Didn't receive the email?</p>
                
                {resendCooldown > 0 ? (
                  <button
                    disabled
                    className="px-4 py-2 bg-gray-100 text-gray-400 rounded-lg cursor-not-allowed font-medium"
                  >
                    Resend in {resendCooldown}s
                  </button>
                ) : (
                  <button
                    onClick={handleResendEmail}
                    disabled={loading}
                    className="px-4 py-2 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-lg font-medium transition-colors"
                  >
                    {loading ? 'Sending...' : 'Send Again'}
                  </button>
                )}
              </div>

              {/* Help Link */}
              <p className="text-center text-sm text-gray-500 mt-6">
                Having trouble?{' '}
                <Link href="/support" className="font-medium text-blue-600 hover:text-blue-700">
                  Contact support
                </Link>
              </p>

              {/* Skip for now (optional) */}
              <div className="mt-4 pt-4 border-t border-gray-100">
                <button
                  onClick={() => router.push('/dashboard')}
                  className="w-full px-4 py-2 text-sm text-gray-500 hover:text-gray-700 font-medium transition-colors"
                >
                  Skip verification for now →
                </button>
              </div>

              {/* Footer */}
              <div className="mt-6 pt-4 border-t border-gray-100">
                <p className="text-xs text-center text-gray-400">
                  We'll never share your email with anyone else.{' '}
                  <Link href="/privacy" className="underline hover:text-gray-600">Privacy Policy</Link>
                </p>
              </div>
            </>
          )}
        </div>

        {/* Trust badges */}
        <div className="mt-8 flex items-center justify-center gap-6 text-sm text-gray-500">
          <span className="flex items-center gap-1">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd"/>
            </svg>
            Secure
          </span>
        </div>
      </div>
    </div>
  );
}
