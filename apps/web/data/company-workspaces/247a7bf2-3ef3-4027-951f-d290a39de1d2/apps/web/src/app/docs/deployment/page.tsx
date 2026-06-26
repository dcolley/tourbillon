'use client';

export default function DeploymentGuidePage() {
  return (
    <main className="min-h-screen p-8 max-w-6xl mx-auto">
      <h1 className="text-4xl font-bold mb-6 text-gray-900">Deployment Guide</h1>
      
      <p className="text-lg text-gray-600 mb-8">
        Complete guide for deploying the Tourbillon platform, including build processes, environment configuration, and production setup.
      </p>

      {/* Table of Contents */}
      <nav className="mb-10 p-4 border rounded-lg bg-gray-50">
        <h2 className="text-xl font-semibold mb-3 text-gray-800">Contents</h2>
        <ol className="list-decimal pl-6 space-y-1 text-gray-700">
          <li><a href="#overview" className="text-blue-600 hover:underline">Overview & Architecture</a></li>
          <li><a href="#prerequisites" className="text-blue-600 hover:underline">Prerequisites</a></li>
          <li><a href="#local-development" className="text-blue-600 hover:underline">Local Development Setup</a></li>
          <li><a href="#build-process" className="text-blue-600 hover:underline">Build Process</a></li>
          <li><a href="#environment-config" className="text-blue-600 hover:underline">Environment Configuration</a></li>
          <li><a href="#nextjs-deployment" className="text-blue-600 hover:underline">Next.js Deployment Options</a></li>
          <li><a href="#ga4-config" className="text-blue-600 hover:underline">GA4 Tracking Configuration</a></li>
          <li><a href="#deployment-checklist" className="text-blue-600 hover:underline">Deployment Checklist</a></li>
        </ol>
      </nav>

      {/* Overview Section */}
      <section id="overview" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Overview & Architecture</h2>
        
        <p className="text-gray-700 mb-4">
          Tourbillon is built on a Next.js application using the App Router pattern. The platform serves as both 
          an AI agent orchestration system and a documentation website for developers.
        </p>

        <div className="bg-gray-900 text-white p-6 rounded-lg mb-4">
          <h3 className="font-semibold mb-3">Project Structure</h3>
          <pre className="text-sm overflow-x-auto">{`tourbillon/
├── apps/web/                    # Next.js application (front-end)
│   ├── src/app/                 # App Router pages and layouts
│   │   ├── docs/                # Documentation pages
│   │   │   ├── api-reference/page.tsx
│   │   │   ├── agent-config/page.tsx
│   │   │   ├── goal-project-management/page.tsx
│   │   │   └── quality-guide/page.tsx
│   │   ├── page.tsx             # Homepage with download tracker
│   │   └── layout.tsx           # Root layout with GA4 provider
│   ├── src/components/          # React components
│   │   └── DownloadTracker.tsx  # Downloads component (GA4 tracking)
│   ├── src/gtag.ts              # Google Analytics 4 tracking functions
│   └── package.json             # Dependencies and scripts
├── resources/                   # Shared documentation files
│   ├── quality-guide.md         # Quality standards document
│   └── tracking-config.md       # GA4 configuration reference
└── package.json                 # Root workspace config`}</pre>
        </div>

        <h3 className="text-lg font-semibold mt-6 mb-2 text-gray-800">Key Technologies</h3>
        
        <table className="w-full border-collapse border mb-4">
          <thead>
            <tr className="bg-gray-100">
              <th className="border p-3 text-left">Component</th>
              <th className="border p-3 text-left">Technology</th>
              <th className="border p-3 text-left">Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border p-3 font-semibold">Frontend Framework</td>
              <td className="border p-3"><code>Next.js 14+</code></td>
              <td className="border p-3">Server-side rendering, App Router, static generation</td>
            </tr>
            <tr>
              <td className="border p-3 font-semibold">Build Tool</td>
              <td className="border p-3"><code>Turbopack</code></td>
              <td className="border p-3">Fast build and development server (Rust-based)</td>
            </tr>
            <tr>
              <td className="border p-3 font-semibold">Analytics</td>
              <td className="border p-3"><code>GA4 + gtag.js</code></td>
              <td className="border p-3">User tracking, event measurement, conversion monitoring</td>
            </tr>
            <tr>
              <td className="border p-3 font-semibold">Styling</td>
              <td className="border p-3"><code>Tailwind CSS</code></td>
              <td className="border p-3">Utility-first CSS framework for responsive design</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Prerequisites Section */}
      <section id="prerequisites" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Prerequisites</h2>
        
        <p className="text-gray-700 mb-4">Before deploying Tourbillon, ensure you have:</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <div className="p-4 border rounded-lg bg-blue-50">
            <h3 className="font-semibold text-blue-800 mb-2">Required Software</h3>
            <ul className="list-disc pl-6 space-y-1 text-gray-700">
              <li><strong>Node.js:</strong> v18.0 or higher (LTS recommended)</li>
              <li><strong>npm/pnpm/yarn:</strong> Package manager for dependency installation</li>
              <li><strong>Git:</strong> Version control for source code management</li>
            </ul>
          </div>

          <div className="p-4 border rounded-lg bg-green-50">
            <h3 className="font-semibold text-green-800 mb-2">Required Accounts</h3>
            <ul className="list-disc pl-6 space-y-1 text-gray-700">
              <li><strong>Google Analytics:</strong> GA4 account for tracking configuration</li>
              <li><strong>Vercel (recommended):</strong> One-click deployment platform</li>
              <li><strong>GitHub/GitLab:</strong> Source code repository hosting</li>
            </ul>
          </div>
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Node.js Installation</h3>
        
        <div className="bg-gray-900 text-white p-4 rounded-lg font-mono text-sm overflow-x-auto">
{`# Check Node.js version (need v18+)
node --version

# Install via nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
nvm use 20

# Verify installation
npm --version`}
        </div>
      </section>

      {/* Local Development Section */}
      <section id="local-development" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Local Development Setup</h2>
        
        <p className="text-gray-700 mb-4">Follow these steps to set up the Tourbillon application for local development:</p>

        <div className="bg-gray-50 p-6 rounded-lg border mb-6">
          <h3 className="font-semibold text-lg mb-4">Step-by-Step Setup</h3>
          
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-gray-500 mb-1">1. Clone the repository</p>
              <div className="bg-gray-900 text-white p-3 rounded-lg font-mono text-sm overflow-x-auto">
                <code>{`git clone https://github.com/tourbillon/tourbillon.git\ncd tourbillon/apps/web`}</code>
              </div>
            </div>

            <div>
              <p className="text-sm font-medium text-gray-500 mb-1">2. Install dependencies</p>
              <div className="bg-gray-900 text-white p-3 rounded-lg font-mono text-sm overflow-x-auto">
                <code>{`npm install`}</code>
              </div>
            </div>

            <div>
              <p className="text-sm font-medium text-gray-500 mb-1">3. Configure environment variables</p>
              <div className="bg-gray-900 text-white p-3 rounded-lg font-mono text-sm overflow-x-auto">
                <code>{`# Create .env.local file with required variables
cp .env.example .env.local

# Edit .env.local and add:
NEXT_PUBLIC_GA_MEASUREMENT_ID=G-YOURGA4IDHERE`}</code>
              </div>
            </div>

            <div>
              <p className="text-sm font-medium text-gray-500 mb-1">4. Start the development server</p>
              <div className="bg-gray-900 text-white p-3 rounded-lg font-mono text-sm overflow-x-auto">
                <code>{`npm run dev`}</code>
              </div>
            </div>

            <div>
              <p className="text-sm font-medium text-gray-500 mb-1">5. Access the application</p>
              <div className="bg-blue-50 p-3 rounded-lg border border-blue-200">
                <code>🌐 http://localhost:3000</code>
              </div>
            </div>
          </div>
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Available Scripts</h3>
        
        <table className="w-full border-collapse border mb-4">
          <thead>
            <tr className="bg-gray-100">
              <th className="border p-3 text-left">Command</th>
              <th className="border p-3 text-left">Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border p-3 font-mono"><code>npm run dev</code></td>
              <td className="border p-3">Start development server with Turbopack</td>
            </tr>
            <tr>
              <td className="border p-3 font-mono"><code>npm run build</code></td>
              <td className="border p-3">Create production build of the application</td>
            </tr>
            <tr>
              <td className="border p-3 font-mono"><code>npm start</code></td>
              <td className="border p-3">Run the production server after building</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Build Process Section */}
      <section id="build-process" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Build Process</h2>
        
        <p className="text-gray-700 mb-4">
          The production build optimizes the application for performance and generates static pages where possible.
        </p>

        <div className="bg-gray-900 text-white p-6 rounded-lg mb-6">
          <h3 className="font-semibold mb-3">Build Command</h3>
          <pre className="text-sm overflow-x-auto">{`# Navigate to app directory and build
cd apps/web
npm run build

# Build output:
# ✓ Compiled successfully
# ○  Static files generated for docs pages
# ▲ Server bundles created (for dynamic routes)
# ℹ Using Turbopack for faster compilation`}</pre>
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Static vs. Dynamic Pages</h3>
        
        <table className="w-full border-collapse border mb-4">
          <thead>
            <tr className="bg-gray-100">
              <th className="border p-3 text-left">Route Type</th>
              <th className="border p-3 text-left">Example</th>
              <th className="border p-3 text-left">Generation Method</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border p-3 font-semibold">Static (SSG)</td>
              <td className="border p-3"><code>/docs/api-reference</code></td>
              <td className="border p-3">Generated at build time, served from CDN</td>
            </tr>
            <tr>
              <td className="border p-3 font-semibold">Static (SSG)</td>
              <td className="border p-3"><code>/docs/quality-guide</code></td>
              <td className="border p-3">Generated at build time, served from CDN</td>
            </tr>
            <tr>
              <td className="border p-3 font-semibold">Dynamic (SSR)</td>
              <td className="border p-3"><code>/api/*</code></td>
              <td className="border p-3">Rendered on each request for API endpoints</td>
            </tr>
          </tbody>
        </table>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Build Optimization Tips</h3>
        
        <ul className="list-disc pl-6 space-y-2 text-gray-700">
          <li><strong>Image optimization:</strong> Next.js automatically optimizes images with automatic format selection (AVIF, WebP)</li>
          <li><code>Code splitting:</code> Each page loads only the JavaScript it needs</li>
          <li><strong>Caching:</strong> Static pages are cached at the CDN edge for fast global delivery</li>
        </ul>
      </section>

      {/* Environment Configuration Section */}
      <section id="environment-config" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Environment Configuration</h2>
        
        <p className="text-gray-700 mb-4">
          Tourbillon uses environment variables for configuration. Create a <code>.env.local</code> file in the app directory.
        </p>

        <div className="bg-gray-900 text-white p-6 rounded-lg font-mono text-sm overflow-x-auto mb-6">
{`# .env.local - Local development environment variables

# Google Analytics 4 Measurement ID (required for tracking)
NEXT_PUBLIC_GA_MEASUREMENT_ID=G-YOURMEASUREMENTIDHERE

# API configuration (for future backend integration)
NEXT_PUBLIC_API_URL=http://localhost:3001/api

# Feature flags
NEXT_PUBLIC_ENABLE_DEBUG=false`}
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Environment Variable Naming</h3>
        
        <p className="text-gray-700 mb-4">
          All client-accessible variables must be prefixed with <code>NEXT_PUBLIC_</code>:
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-green-50 border-l-4 border-green-500 p-4 rounded-r-lg">
            <h3 className="font-semibold text-green-800 mb-2">✅ Client-Side (NEXT_PUBLIC_)</h3>
            <ul className="list-disc pl-6 space-y-1 text-gray-700 text-sm">
              <li><code>NEXT_PUBLIC_GA_MEASUREMENT_ID</code></li>
              <li><code>NEXT_PUBLIC_API_URL</code></li>
              <li><code>NEXT_PUBLIC_ENABLE_DEBUG</code></li>
            </ul>
          </div>

          <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-r-lg">
            <h3 className="font-semibold text-red-800 mb-2">🔒 Server-Side Only</h3>
            <ul className="list-disc pl-6 space-y-1 text-gray-700 text-sm">
              <li><code>DATABASE_URL</code></li>
              <li><code>NEXTAUTH_SECRET</code></li>
              <li><code>STRIPE_API_KEY</code></li>
            </ul>
          </div>
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Accessing Environment Variables</h3>
        
        <div className="bg-blue-50 border-l-4 border-blue-500 p-4 rounded-r-lg">
          <p className="text-sm text-gray-700"><strong>Note:</strong> Only variables prefixed with <code>NEXT_PUBLIC_</code> are accessible in client-side code. Server-only variables can only be accessed in API routes and server components.</p>
        </div>

        <div className="bg-gray-900 text-white p-4 rounded-lg font-mono text-sm overflow-x-auto mt-4">
{`// Client component (accessible)
export function GAProvider() {
  const measurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  // This works because of NEXT_PUBLIC_ prefix
}

// API Route (both types accessible)
export async function GET(req: Request) {
  const secret = process.env.SECRET_KEY;     // Server-only ✅
  const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID; // Client variable also ✅
}`}</div>
      </section>

      {/* Next.js Deployment Section */}
      <section id="nextjs-deployment" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Next.js Deployment Options</h2>
        
        <p className="text-gray-700 mb-4">Tourbillon can be deployed to multiple platforms. Vercel is recommended for the easiest setup.</p>

        {/* Vercel */}
        <div className="mb-6 p-6 border rounded-lg bg-blue-50">
          <h3 className="text-xl font-semibold mb-3 text-blue-800">Vercel (Recommended)</h3>
          
          <p className="text-gray-700 mb-4">Vercel is built by the Next.js team and offers seamless deployment with automatic CI/CD.</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h4 className="font-semibold text-gray-800 mb-2">Deployment Steps</h4>
              <ol className="list-decimal pl-6 space-y-1 text-sm text-gray-700">
                <li>Create a Vercel account at vercel.com</li>
                <li>Connect your GitHub repository</li>
                <li>Select the <code>apps/web</code> directory as root</li>
                <li>Add environment variables in Vercel dashboard</li>
                <li>Deploy with one click</li>
              </ol>
            </div>

            <div>
              <h4 className="font-semibold text-gray-800 mb-2">CLI Deployment</h4>
              <pre className="bg-white p-3 rounded border text-sm overflow-x-auto">{`# Install Vercel CLI (if not installed)
npm i -g vercel

# Deploy from apps/web directory
cd apps/web
vercel

# Deploy to production
vercel --prod`}</pre>
            </div>
          </div>

          <h4 className="font-semibold mt-4 mb-2">Vercel Environment Variables Setup</h4>
          <p className="text-sm text-gray-700 mb-3">
            In your Vercel project settings, navigate to "Environment Variables" and add:
          </p>
          
          <table className="w-full border-collapse border text-sm bg-white rounded-lg">
            <thead>
              <tr className="bg-gray-100">
                <th className="border p-2 text-left">Variable</th>
                <th className="border p-2 text-left">Value</th>
                <th className="border p-2 text-left">Environment</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border p-2 font-mono">NEXT_PUBLIC_GA_MEASUREMENT_ID</td>
                <td className="border p-2">G-YOURGA4IDHERE</td>
                <td className="border p-2">All</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Docker */}
        <div className="mb-6 p-6 border rounded-lg bg-gray-50">
          <h3 className="text-xl font-semibold mb-3 text-gray-800">Docker Deployment</h3>
          
          <p className="text-gray-700 mb-4">For self-hosted deployments, use Docker to containerize the application.</p>

          <div className="bg-gray-900 text-white p-6 rounded-lg font-mono text-sm overflow-x-auto">
{`# Dockerfile for Next.js application
FROM node:20-alpine AS base
RUN npm install -g turbo

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Build the application
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && npm run build

# Production runner
FROM node:20-alpine AS runner
WORKDIR /app/apps/web
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/apps/web/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./.next/static

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]`}
          </div>

          <h4 className="font-semibold mt-4 mb-2">Build & Run Commands</h4>
          <pre className="bg-gray-800 text-white p-3 rounded-lg font-mono text-sm overflow-x-auto">{`# Build Docker image
docker build -t tourbillon .

# Run container
docker run -p 3000:3000 \
  -e NEXT_PUBLIC_GA_MEASUREMENT_ID=G-YOURGA4IDHERE \
  tourbillon

# Access at http://localhost:3000`}</pre>
        </div>

        {/* Manual/Traditional */}
        <div className="p-6 border rounded-lg bg-orange-50">
          <h3 className="text-xl font-semibold mb-3 text-orange-800">Manual Deployment</h3>
          
          <p className="text-gray-700 mb-4">For traditional hosting providers (AWS, DigitalOcean, etc.).</p>

          <div className="space-y-2 text-sm text-gray-700">
            <ol className="list-decimal pl-6 space-y-1">
              <li>SSH into your server</li>
              <li>Install Node.js (v18+)</li>
              <li>Clone repository and navigate to apps/web</li>
              <li>Run <code>npm install --production</code></li>
              <li>Create .env.production with environment variables</li>
              <li>Build: <code>npm run build</code></li>
              <li>Start server: <code>pm2 start npm --name "tourbillon" -- start</code></li>
            </ol>
          </div>

          <h4 className="font-semibold mt-4 mb-2">Nginx Configuration Example</h4>
          <pre className="bg-gray-800 text-white p-3 rounded-lg font-mono text-sm overflow-x-auto">{`server {
    listen 80;
    server_name tourbillon.io;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}`}</pre>
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Deployment Comparison</h3>
        
        <table className="w-full border-collapse border mb-4">
          <thead>
            <tr className="bg-gray-100">
              <th className="border p-3 text-left">Platform</th>
              <th className="border p-3 text-left">Ease of Setup</th>
              <th className="border p-3 text-left">Cost (Free Tier)</th>
              <th className="border p-3 text-left">Best For</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border p-3 font-semibold">Vercel</td>
              <td className="border p-3">⭐⭐⭐⭐⭐ (Easiest)</td>
              <td className="border p-3">Generous free tier</td>
              <td className="border p-3">Quick deployment, auto CI/CD</td>
            </tr>
            <tr>
              <td className="border p-3 font-semibold">Docker + Cloud</td>
              <td className="border p-3">⭐⭐⭐ (Moderate)</td>
              <td className="border p-3">Varies by provider</td>
              <td className="border p-3">Custom infrastructure, full control</td>
            </tr>
            <tr>
              <td className="border p-3 font-semibold">Traditional Hosting</td>
              <td className="border p-3">⭐⭐ (Manual)</td>
              <td className="border p-3">Low-cost VPS available</td>
              <td className="border p-3">Existing infrastructure, budget constraints</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* GA4 Configuration Section */}
      <section id="ga4-config" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">GA4 Tracking Configuration</h2>
        
        <p className="text-gray-700 mb-4">
          Tourbillon uses Google Analytics 4 for user behavior tracking. Configure your GA4 account before deployment.
        </p>

        <div className="bg-blue-50 border-l-4 border-blue-500 p-4 rounded-r-lg mb-6">
          <h3 className="font-semibold text-blue-800 mb-2">GA4 Setup Steps</h3>
          <ol className="list-decimal pl-6 space-y-1 text-gray-700">
            <li>Go to <a href="https://analytics.google.com" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">Google Analytics</a></li>
            <li>Create a new property (or use existing)</li>
            <li>Note your Measurement ID (format: G-XXXXXXXXXX)</li>
            <li>Add the Measurement ID to your environment variables as <code>NEXT_PUBLIC_GA_MEASUREMENT_ID</code></li>
          </ol>
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Implementation in Tourbillon</h3>
        
        <p className="text-gray-700 mb-4">The tracking is implemented in <code>apps/web/src/gtag.ts</code>:</p>

        <div className="bg-gray-900 text-white p-6 rounded-lg font-mono text-sm overflow-x-auto mb-4">
{`// apps/web/src/gtag.ts - GA4 Tracking Implementation

const GA_TRACKING_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

export const pageview = (url: string) => {
  window.gtag('config', GA_TRACKING_ID, {
    page_path: url,
  });
};

interface TrackSignUpParams {
  method_type?: 'email' | 'google' | 'github';
  page_location?: string;
}

export const trackSignUp = (params: TrackSignUpParams = {}) => {
  window.gtag('event', 'sign_up', params);
};

interface TrackDemoRequestedParams {
  product_type?: 'pro' | 'enterprise';
  user_source?: 'organic' | 'paid' | 'referral' | 'social';
}

export const trackDemoRequested = (params: TrackDemoRequestedParams = {}) => {
  window.gtag('event', 'demo_requested', params);
};

interface TrackDocumentDownloadParams {
  file_name?: string;
  file_extension?: string;
  file_type?: string;
}

export const trackDocumentDownload = (params: TrackDocumentDownloadParams = {}) => {
  window.gtag('event', 'document_download', params);
};`}
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Tracking Events Summary</h3>
        
        <table className="w-full border-collapse border mb-4">
          <thead>
            <tr className="bg-gray-100">
              <th className="border p-3 text-left">Event Name</th>
              <th className="border p-3 text-left">Trigger Point</th>
              <th className="border p-3 text-left">Parameters Tracked</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border p-3 font-mono"><code>page_view</code></td>
              <td className="border p-3">Every route change (automatic)</td>
              <td className="border p-3">Page path, title</td>
            </tr>
            <tr>
              <td className="border p-3 font-mono"><code>sign_up</code></td>
              <td className="border p-3">Form submission (email/Google/GitHub)</td>
              <td className="border p-3">Method type, page location</td>
            </tr>
            <tr>
              <td className="border p-3 font-mono"><code>demo_requested</code></td>
              <td className="border p-3">Demo form submission</td>
              <td className="border p-3">Product type, user source</td>
            </tr>
            <tr>
              <td className="border p-3 font-mono"><code>document_download</code></td>
              <td className="border p-3">File download link click</td>
              <td className="border p-3">File name, extension, type</td>
            </tr>
          </tbody>
        </table>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Testing Tracking</h3>
        
        <div className="bg-green-50 border-l-4 border-green-500 p-4 rounded-r-lg">
          <h4 className="font-semibold text-green-800 mb-2">Validation Checklist:</h4>
          <ol className="list-decimal pl-6 space-y-1 text-gray-700">
            <li>Navigate to the homepage and check GA4 DebugView for page_view event</li>
            <li>Fill out the sign-up form and verify sign_up event fires with correct method_type</li>
            <li>Click "Request Demo" and confirm demo_requested event appears in DebugView</li>
            <li>Download a resource file (when available) and check for document_download event</li>
          </ol>
        </div>

        <p className="text-sm text-gray-500 mt-4">
          Use the <a href="#" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">GA4 DebugView</a> for real-time validation during development and staging.
        </p>
      </section>

      {/* Deployment Checklist Section */}
      <section id="deployment-checklist" className="mb-10 p-6 border rounded-lg bg-white shadow-sm">
        <h2 className="text-2xl font-semibold mb-4 text-gray-800">Deployment Checklist</h2>
        
        <p className="text-gray-700 mb-4">Use this checklist to ensure a smooth deployment:</p>

        <div className="space-y-3">
          <h3 className="font-semibold text-lg text-gray-800">Pre-Deployment</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <label className="flex items-start p-3 border rounded-lg hover:bg-blue-50 cursor-pointer transition-colors">
              <input type="checkbox" className="mt-1 mr-2 h-4 w-4 text-blue-600 rounded" />
              <span className="text-sm text-gray-700"><strong>Environment Variables:</strong> GA_MEASUREMENT_ID configured in .env.local and deployment platform</span>
            </label>

            <label className="flex items-start p-3 border rounded-lg hover:bg-blue-50 cursor-pointer transition-colors">
              <input type="checkbox" className="mt-1 mr-2 h-4 w-4 text-blue-600 rounded" />
              <span className="text-sm text-gray-700"><strong>API Reference:</strong> All API docs pages created and accessible</span>
            </label>

            <label className="flex items-start p-3 border rounded-lg hover:bg-blue-50 cursor-pointer transition-colors">
              <input type="checkbox" className="mt-1 mr-2 h-4 w-4 text-blue-600 rounded" />
              <span className="text-sm text-gray-700"><strong>Documentation:</strong> Agent config, goal/project management guides completed</span>
            </label>

            <label className="flex items-start p-3 border rounded-lg hover:bg-blue-50 cursor-pointer transition-colors">
              <input type="checkbox" className="mt-1 mr-2 h-4 w-4 text-blue-600 rounded" />
              <span className="text-sm text-gray-700"><strong>GA4 Tracking:</strong> Events implemented and tested in staging</span>
            </label>

            <label className="flex items-start p-3 border rounded-lg hover:bg-blue-50 cursor-pointer transition-colors">
              <input type="checkbox" className="mt-1 mr-2 h-4 w-4 text-blue-600 rounded" />
              <span className="text-sm text-gray-700"><strong>Build Test:</strong> npm run build completes without errors</span>
            </label>

            <label className="flex items-start p-3 border rounded-lg hover:bg-blue-50 cursor-pointer transition-colors">
              <input type="checkbox" className="mt-1 mr-2 h-4 w-4 text-blue-600 rounded" />
              <span className="text-sm text-gray-700"><strong>Link Testing:</strong> All navigation links resolve correctly</span>
            </label>

            <label className="flex items-start p-3 border rounded-lg hover:bg-blue-50 cursor-pointer transition-colors">
              <input type="checkbox" className="mt-1 mr-2 h-4 w-4 text-blue-600 rounded" />
              <span className="text-sm text-gray-700"><strong>Responsive Design:</strong> Tested on mobile and desktop breakpoints</span>
            </label>

            <label className="flex items-start p-3 border rounded-lg hover:bg-blue-50 cursor-pointer transition-colors">
              <input type="checkbox" className="mt-1 mr-2 h-4 w-4 text-blue-600 rounded" />
              <span className="text-sm text-gray-700"><strong>Download Links:</strong> PDF links point to valid resources (or removed)</span>
            </label>
          </div>

          <h3 className="font-semibold text-lg text-gray-800">Post-Deployment</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <label className="flex items-start p-3 border rounded-lg hover:bg-green-50 cursor-pointer transition-colors">
              <input type="checkbox" className="mt-1 mr-2 h-4 w-4 text-blue-600 rounded" />
              <span className="text-sm text-gray-700"><strong>GA4 Validation:</strong> Confirm events firing in Google Analytics DebugView</span>
            </label>

            <label className="flex items-start p-3 border rounded-lg hover:bg-green-50 cursor-pointer transition-colors">
              <input type="checkbox" className="mt-1 mr-2 h-4 w-4 text-blue-600 rounded" />
              <span className="text-sm text-gray-700"><strong>Performance:</strong> Check Lighthouse scores for Core Web Vitals</span>
            </label>

            <label className="flex items-start p-3 border rounded-lg hover:bg-green-50 cursor-pointer transition-colors">
              <input type="checkbox" className="mt-1 mr-2 h-4 w-4 text-blue-600 rounded" />
              <span className="text-sm text-gray-700"><strong>SSL Certificate:</strong> HTTPS enabled and working</span>
            </label>

            <label className="flex items-start p-3 border rounded-lg hover:bg-green-50 cursor-pointer transition-colors">
              <input type="checkbox" className="mt-1 mr-2 h-4 w-4 text-blue-600 rounded" />
              <span className="text-sm text-gray-700"><strong>Custom Domain:</strong> DNS records configured for production domain</span>
            </label>

            <label className="flex items-start p-3 border rounded-lg hover:bg-green-50 cursor-pointer transition-colors">
              <input type="checkbox" className="mt-1 mr-2 h-4 w-4 text-blue-600 rounded" />
              <span className="text-sm text-gray-700"><strong>Error Monitoring:</strong> Set up error tracking (Sentry, LogRocket)</span>
            </label>

            <label className="flex items-start p-3 border rounded-lg hover:bg-green-50 cursor-pointer transition-colors">
              <input type="checkbox" className="mt-1 mr-2 h-4 w-4 text-blue-600 rounded" />
              <span className="text-sm text-gray-700"><strong>Announcement:</strong> Notify team and stakeholders of deployment</span>
            </label>
          </div>
        </div>

        <h3 className="text-lg font-semibold mt-4 mb-2 text-gray-800">Rollback Plan</h3>
        
        <p className="text-gray-700 mb-4">If issues are detected post-deployment:</p>

        <ol className="list-decimal pl-6 space-y-2 text-gray-700">
          <li><strong>Immediate rollback:</strong> Use deployment platform's "Revert" or "Previous Deployments" feature</li>
          <li><strong>Vercel example:</strong> Go to deployments → Select previous successful deployment → Click "Promote to Production"</li>
          <li><strong>Docker example:</strong> Redeploy the last known good image tag: <code>docker run -d --name tourbillon tourbillon:v1.0.0</code></li>
          <li><strong>Monitor rollback:</strong> Verify GA4 events are still firing after revert</li>
        </ol>

        <div className="mt-6 p-4 bg-yellow-50 border-l-4 border-yellow-500 rounded-r-lg">
          <p className="text-sm text-gray-700"><strong>Pro tip:</strong> Always deploy to a staging environment first and validate thoroughly before promoting to production.</p>
        </div>
      </section>

      {/* Footer */}
      <div className="mt-10 p-6 border rounded-lg bg-gray-50">
        <p className="text-sm text-gray-600">
          <strong>Last updated:</strong> June 18, 2026 &nbsp;|&nbsp; 
          <strong>Version:</strong> 1.0 &nbsp;|&nbsp;
          <strong>Owner:</strong> CMO (Content) / Engineer (Infrastructure)
        </p>
      </div>
    </main>
  );
}
