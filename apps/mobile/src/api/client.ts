import { API_BASE_URL } from './config';
import type { Company, Agent, Issue, ApiError } from '../types';

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
        credentials: 'include', // Important: send cookies
      });

      if (!response.ok) {
        const error = await response.json() as ApiError;
        throw new Error(error.error || `Request failed: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Network request failed');
    }
  }

  // Company APIs
  async listCompanies(): Promise<Company[]> {
    return this.request<Company[]>('/api/mobile/companies');
  }

  async selectCompany(companyId: string): Promise<void> {
    return this.request<void>(`/api/mobile/companies/${companyId}/select`, {
      method: 'POST',
    });
  }

  // Agent APIs
  async listAgents(companyId: string): Promise<Agent[]> {
    return this.request<Agent[]>(`/api/mobile/companies/${companyId}/agents`);
  }

  // Issue APIs
  async listIssues(companyId: string): Promise<Issue[]> {
    return this.request<Issue[]>(`/api/mobile/companies/${companyId}/issues`);
  }
}

export const apiClient = new ApiClient();
