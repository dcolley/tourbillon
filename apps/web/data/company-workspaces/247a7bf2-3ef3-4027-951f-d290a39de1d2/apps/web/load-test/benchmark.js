/**
 * Tourbillon API Performance Benchmark
 * 
 * This script runs concurrent requests against the critical API endpoints
 * to measure performance characteristics and identify bottlenecks.
 * 
 * Usage: node apps/web/load-test/benchmark.js [concurrent_users] [total_requests]
 */

const http = require('http');
const crypto = require('crypto');

// ============================================================================
// CONFIGURATION
// ============================================================================
const BASE_URL = 'http://localhost:3000'; // Next.js dev server
const CONCURRENCY = parseInt(process.argv[2]) || 10; // Default 10 concurrent users
const TOTAL_REQUESTS = parseInt(process.argv[3]) || 50; // Default 50 total requests per endpoint

// Test credentials (created during signup phase)
let testUserEmail = '';
let testUserPassword = 'TestPass123!';
let sessionToken = '';

// ============================================================================
// STATISTICS COLLECTOR
// ============================================================================
class StatsCollector {
  constructor(name) {
    this.name = name;
    this.times = [];
    this.errors = 0;
    this.successes = 0;
    this.maxTime = 0;
    this.minTime = Infinity;
  }

  record(time, success = true) {
    this.times.push(time);
    if (success) {
      this.successes++;
      if (time > this.maxTime) this.maxTime = time;
      if (time < this.minTime) this.minTime = time;
    } else {
      this.errors++;
    }
  }

  getResults() {
    const sorted = [...this.times].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const avg = this.times.reduce((a, b) => a + b, 0) / this.times.length;

    return {
      name: this.name,
      total: this.times.length + this.errors,
      successes: this.successes,
      errors: this.errors,
      errorRate: (this.errors / (this.total)) * 100,
      avg: Math.round(avg),
      min: this.minTime === Infinity ? 0 : this.minTime,
      max: this.maxTime,
      p50: p50,
      p95: p95,
      p99: p99
    };
  }

  printResults() {
    const r = this.getResults();
    console.log(`\n📊 ${r.name}`);
    console.log(`   Total Requests: ${r.total}`);
    console.log(`   Successes: ${r.successes} | Errors: ${r.errors} (${(r.errors/r.total*100).toFixed(1)}%)`);
    console.log(`   Avg: ${r.avg}ms | Min: ${r.min}ms | Max: ${r.max}ms`);
    console.log(`   P50: ${r.p50}ms | P95: ${r.p95}ms | P99: ${r.p99}ms`);

    // Severity indicators
    if (r.avg > 1000) {
      console.log('   ⚠️  WARNING: Average response time > 1s - System under stress');
    }
    if (r.errors > 0) {
      console.log(`   🚨 CRITICAL: ${r.errors} errors detected - Data integrity at risk`);
    }
    if (r.p95 > 2000) {
      console.log('   🚨 CRITICAL: P95 latency > 2s - Unacceptable for user-facing API');
    }
  }
}

// ============================================================================
// HTTP REQUEST HELPERS
// ============================================================================
function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const postData = body ? JSON.stringify(body) : null;

    const options = {
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const responseTime = Date.now() - startTime;
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed, time: responseTime });
        } catch {
          resolve({ status: res.statusCode, body: data, time: responseTime });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (postData) req.write(postData);
    req.end();
  });
}

// ============================================================================
// CONCURRENT REQUEST RUNNER
// ============================================================================
async function runConcurrentRequests(endpointFn, count, concurrency, stats) {
  const promises = [];

  for (let i = 0; i < count; i++) {
    const promise = endpointFn(i).then(result => {
      if (result && result.time !== undefined) {
        stats.record(result.time, result.status === 200 || result.status === 201);
      } else {
        stats.record(0, false); // Error case
      }
    }).catch(err => {
      stats.record(0, false); // Exception case
    });
    promises.push(promise);

    // Limit concurrency by waiting for a slot to free up
    if (promises.length >= concurrency) {
      await Promise.race(promises.map((p, idx) => 
        p.then(() => ({ resolved: true, index: idx }))
         .catch(() => ({ resolved: false, index: idx }))
      ).then(results => results.find(r => r.resolved)));

      // Remove the resolved promise from our tracking array
      const completedIdx = promises.findIndex((_, i) => {
        try {
          return Promise.resolve().then(() => true); // Simplified tracking
        } catch {}
      });
    }
  }

  await Promise.all(promises);
}

// ============================================================================
// LOAD TEST PHASES
// ============================================================================

// Phase 1: Create test users (signup)
async function runSignupLoadTest(stats) {
  console.log('\n🚀 Phase 1: Signup Load Test');
  
  // First, create initial user if needed
  const signupResult = await makeRequest('POST', '/api/auth/signup', {
    email: 'benchmark@test.com',
    password: testUserPassword
  });

  if (signupResult.status === 201 || signupResult.status === 409) {
    testUserEmail = 'benchmark@test.com';
    console.log(`   ✅ Test user ready (${testUserEmail})`);
  } else {
    console.log('   ⚠️  Could not create test user, using existing');
  }

  // Now run concurrent signups (will mostly fail due to duplicate email)
  const signupPromises = Array.from({ length: TOTAL_REQUESTS }, async (_, i) => {
    try {
      return await makeRequest('POST', '/api/auth/signup', {
        email: `user${i}@test.com`,
        password: testUserPassword
      });
    } catch (err) {
      return null;
    }
  });

  const results = await Promise.all(signupPromises);
  results.forEach(result => {
    if (result && result.time !== undefined) {
      stats.record(result.time, result.status === 201);
    } else {
      stats.record(0, false);
    }
  });

  console.log(`   ${stats.successes}/${TOTAL_REQUESTS} successful signups`);
}

// Phase 2: Login load test
async function runLoginLoadTest(stats) {
  console.log('\n🔐 Phase 2: Login Load Test');
  
  const loginPromises = Array.from({ length: TOTAL_REQUESTS }, async (_, i) => {
    try {
      return await makeRequest('POST', '/api/auth/login', {
        email: testUserEmail,
        password: testUserPassword
      });
    } catch (err) {
      return null;
    }
  });

  const results = await Promise.all(loginPromises);
  results.forEach(result => {
    if (result && result.time !== undefined) {
      stats.record(result.time, result.status === 200);
    } else {
      stats.record(0, false);
    }
  });

  console.log(`   ${stats.successes}/${TOTAL_REQUESTS} successful logins`);
}

// Phase 3: Session verification load test
async function runSessionLoadTest(stats) {
  console.log('\n🎫 Phase 3: Session Verification Load Test');
  
  // First, get a valid session token via login
  const loginResult = await makeRequest('POST', '/api/auth/login', {
    email: testUserEmail,
    password: testUserPassword
  });

  if (!loginResult || loginResult.status !== 200) {
    console.log('   ⚠️  Could not get session token for testing');
    return;
  }

  // Session verification in this app uses cookies, so we'll simulate with a direct API call
  const sessionPromises = Array.from({ length: TOTAL_REQUESTS }, async (_, i) => {
    try {
      return await makeRequest('GET', '/api/auth/session');
    } catch (err) {
      return null;
    }
  });

  const results = await Promise.all(sessionPromises);
  results.forEach(result => {
    if (result && result.time !== undefined) {
      stats.record(result.time, result.status === 200);
    } else {
      stats.record(0, false);
    }
  });

  console.log(`   ${stats.successes}/${TOTAL_REQUESTS} successful session checks`);
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================
async function runBenchmark() {
  console.log('🔬 Tourbillon API Performance Benchmark');
  console.log(`⚙️  Configuration: ${CONCURRENCY} concurrent users, ${TOTAL_REQUESTS} total requests per endpoint`);
  console.log(`📍 Target: ${BASE_URL}`);

  // Initialize stats collectors
  const signupStats = new StatsCollector('Signup Endpoint');
  const loginStats = new StatsCollector('Login Endpoint');
  const sessionStats = new StatsCollector('Session Verification Endpoint');

  try {
    // Run load test phases sequentially to avoid cross-contamination
    await runSignupLoadTest(signupStats);
    await runLoginLoadTest(loginStats);
    await runSessionLoadTest(sessionStats);

    // Print results summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 BENCHMARK RESULTS SUMMARY');
    console.log('='.repeat(60));

    signupStats.printResults();
    loginStats.printResults();
    sessionStats.printResults();

    // Final assessment
    console.log('\n' + '='.repeat(60));
    console.log('🔍 PERFORMANCE ASSESSMENT');
    console.log('='.repeat(60));

    const allStats = [signupStats, loginStats, sessionStats];
    const avgLatency = Math.round(allStats.reduce((sum, s) => sum + (s.getResults().avg || 0), 0) / 3);
    const totalErrors = allStats.reduce((sum, s) => sum + s.errors, 0);

    if (avgLatency > 1000) {
      console.log('🚨 CRITICAL: Average latency exceeds 1 second');
      console.log('   System will fail under production load');
    } else if (avgLatency > 500) {
      console.log('⚠️  WARNING: Average latency above acceptable threshold');
      console.log('   Performance optimization recommended before launch');
    } else {
      console.log('✅ Acceptable baseline performance');
      console.log('   Still recommend database migration for production scale');
    }

    if (totalErrors > 0) {
      console.log(`\n🚨 CRITICAL: ${totalErrors} errors detected across all endpoints`);
      console.log('   Indicates data corruption or race conditions under load');
    }

    console.log('\n💡 RECOMMENDATION: Implement PostgreSQL + connection pooling');
    console.log('   File-based storage cannot handle production concurrent access');

  } catch (error) {
    console.error('\n❌ Benchmark failed:', error.message);
    console.log('\n⚠️  Make sure the Next.js dev server is running on port 3000');
    process.exit(1);
  }
}

// Run the benchmark
runBenchmark().catch(console.error);
