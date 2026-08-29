// API configuration
// For development, you can set this to your local server
// For production, this should be configured via environment variables

const DEV_API_URL = 'http://localhost:3002';

// In a real production app, you would use:
// - Environment variables via app config
// - A user-configurable setting
// - Or a build-time configuration

export const API_BASE_URL = DEV_API_URL;

export const ENDPOINTS = {
  companies: {
    list: '/api/mobile/companies',
    select: (id: string) => `/api/mobile/companies/${id}/select`,
  },
  agents: {
    list: (companyId: string) => `/api/mobile/companies/${companyId}/agents`,
  },
  issues: {
    list: (companyId: string) => `/api/mobile/companies/${companyId}/issues`,
  },
} as const;
