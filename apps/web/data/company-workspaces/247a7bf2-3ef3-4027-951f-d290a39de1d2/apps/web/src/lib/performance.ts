/**
 * Tourbillon Performance Tracking — TOUR-146
 * 
 * Middleware for tracking API response times and enforcing performance targets.
 * Provides timing utilities, target definitions, and monitoring integration hooks.
 */

// ============================================================================
// PERFORMANCE TARGETS (per endpoint category)
// ============================================================================

export interface PerformanceTarget {
  /** Maximum acceptable response time in milliseconds */
  maxMs: number;
  /** Category name for grouping related endpoints */
  category: string;
  /** Warning threshold (percentage of max — warn at 80% to give buffer) */
  warningThresholdPct?: number;
}

export const PERFORMANCE_TARGETS: Record<string, PerformanceTarget> = {
  dashboard: {
    maxMs: 200,
    category: 'dashboard',
    warningThresholdPct: 80, // Warn at 160ms
  },
  goalList: {
    maxMs: 500,
    category: 'goal-list',
    warningThresholdPct: 80, // Warn at 400ms
  },
  taskList: {
    maxMs: 300,
    category: 'task-list',
    warningThresholdPct: 80, // Warn at 240ms
  },
  auth: {
    maxMs: 1000,
    category: 'auth',
    warningThresholdPct: 90, // Warn at 900ms (auth involves hashing)
  },
  default: {
    maxMs: 2000,
    category: 'default',
    warningThresholdPct: 80, // Warn at 1600ms
  },
} as const;

export type PerformanceCategory = keyof typeof PERFORMANCE_TARGETS;

// ============================================================================
// TIMING UTILITIES
// ============================================================================

/**
 * Measure the duration of an async operation.
 */
export async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = performance.now ? performance.now() : Date.now();
  
  try {
    const result = await fn();
    const end = performance.now ? performance.now() : Date.now();
    
    return {
      result,
      durationMs: Math.round((end - start) * 100) / 100, // Round to 2 decimal places
    };
  } catch (error) {
    const end = performance.now ? performance.now() : Date.now();
    throw Object.assign(error, {
      durationMs: Math.round((end - start) * 100) / 100,
    });
  }
}

/**
 * Get timing headers for response.
 */
export function getTimingHeaders(durationMs: number, category: PerformanceCategory = 'default'): Record<string, string> {
  const target = PERFORMANCE_TARGETS[category];
  const isWithinTarget = durationMs <= target.maxMs;
  
  return {
    // Always include timing for monitoring
    'X-Response-Time': `${durationMs}ms`,
    'X-Performance-Target': `${target.category}: ${target.maxMs}ms`,
    
    // Flag if within performance target (helps with monitoring dashboards)
    'X-Within-Target': String(isWithinTarget),
  };
}

/**
 * Check if duration meets the performance target for a category.
 */
export function meetsPerformanceTarget(durationMs: number, category: PerformanceCategory = 'default'): boolean {
  const target = PERFORMANCE_TARGETS[category];
  return durationMs <= target.maxMs;
}

// ============================================================================
// PERFORMANCE TRACKING MIDDLEWARE
// ============================================================================

/**
 * Wrap an API handler with performance tracking.
 * Logs warnings if response time exceeds target threshold.
 */
export function createPerformanceTracker(category: PerformanceCategory) {
  const target = PERFORMANCE_TARGETS[category];
  
  return async <T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number; withinTarget: boolean }> {
    const start = performance.now ? performance.now() : Date.now();
    
    try {
      const result = await fn();
      const end = performance.now ? performance.now() : Date.now();
      const durationMs = Math.round((end - start) * 100) / 100;
      const withinTarget = durationMs <= target.maxMs;

      // Log warning if exceeding threshold (but not necessarily failing)
      const thresholdMs = Math.round(target.maxMs * (target.warningThresholdPct || 80) / 100);
      
      if (durationMs >= thresholdMs && !withinTarget) {
        console.warn(`⚠️  Performance target exceeded [${category}]: ${durationMs}ms > ${target.maxMs}ms`);
      } else if (durationMs >= thresholdMs) {
        // Within warning zone but still passing — log at debug level in dev
        if (process.env.NODE_ENV === 'development') {
          console.debug(`⏱️  Near performance target [${category}]: ${durationMs}ms / ${target.maxMs}ms`);
        }
      }

      return { result, durationMs, withinTarget };
    } catch (error) {
      const end = performance.now ? performance.now() : Date.now();
      throw Object.assign(error, {
        category,
        durationMs: Math.round((end - start) * 100) / 100,
      });
    }
  };
}

// ============================================================================
// RESPONSE TIME MONITORING INTEGRATION
// ============================================================================

interface PerformanceMetrics {
  endpoint: string;
  method: string;
  durationMs: number;
  category: PerformanceCategory;
  timestamp: Date;
}

/**
 * Track performance metrics (can be extended for Mixpanel/external monitoring).
 */
export function trackPerformanceMetric(metric: Omit<PerformanceMetrics, 'timestamp'>): void {
  const fullMetric: PerformanceMetrics = {
    ...metric,
    timestamp: new Date(),
  };

  // In production, this would send to an external monitoring service (Mixpanel, Datadog, etc.)
  // For now, log to console for development visibility
  
  if (!meetsPerformanceTarget(fullMetric.durationMs, fullMetric.category)) {
    console.error(`❌ PERFORMANCE FAILURE: [${fullMetric.method}] ${fullMetric.endpoint} took ${fullMetric.durationMs}ms (target: ${PERFORMANCE_TARGETS[fullMetric.category].maxMs}ms)`);
  }

  // Export for external monitoring hooks (TOUR-147)
  if (typeof window !== 'undefined' && process.env.NODE_ENV === 'production') {
    // Browser-side tracking could be added here
  } else if (process.env.NODE_ENV === 'development') {
    console.log(`📊 Performance: [${fullMetric.method}] ${fullMetric.endpoint} = ${fullMetric.durationMs}ms`);
  }
}
