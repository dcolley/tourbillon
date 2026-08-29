import * as SecureStore from 'expo-secure-store';
import { API_BASE_URL } from './config';
import type { Company, Agent, Issue, ApiError } from '../types';

const SESSION_TOKEN_KEY = 'tourbillon_session_token';

interface SelectCompanyResponse {
  success: boolean;
  token: string;
  company: Company;
}

interface AgentsResponse {
  agents: Agent[];
}

interface IssuesResponse {
  filter: string;
  rows: Array<{
    issue: Issue;
    agent: { id: string; name: string; urlKey: string } | null;
  }>;
  total: number;
}

class ApiClient {
  private baseUrl: string;
  private sessionToken: string | null = null;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  async initialize(): Promise<void> {
    // Load session token from secure storage
    try {
      this.sessionToken = await SecureStore.getItemAsync(SESSION_TOKEN_KEY);
    } catch {
      this.sessionToken = null;
    }
  }

  private async request<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add session token header if available
    if (this.sessionToken) {
      headers['X-Company-Token'] = this.sessionToken;
    }
    
    // Merge with any additional headers
    if (options?.headers) {
      Object.assign(headers, options.headers);
    }
    
    try {
      const response = await fetch(url, {
        ...options,
        headers,
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

  async selectCompany(companyId: string): Promise<Company> {
    const response = await this.request<SelectCompanyResponse>(
      '/api/mobile/companies',
      {
        method: 'POST',
        body: JSON.stringify({ companyId }),
      }
    );

    // Store session token securely
    this.sessionToken = response.token;
    await SecureStore.setItemAsync(SESSION_TOKEN_KEY, response.token);

    return response.company;
  }

  async clearSession(): Promise<void> {
    this.sessionToken = null;
    await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
  }

  // Agent APIs (using existing route)
  async listAgents(): Promise<Agent[]> {
    const response = await this.request<AgentsResponse>('/api/chat/agents');
    return response.agents;
  }

  // Issue APIs (using existing route with active filter)
  async listIssues(): Promise<Issue[]> {
    const response = await this.request<IssuesResponse>('/api/issues/list?filter=active');
    return response.rows.map((row) => row.issue);
  }
}

export const apiClient = new ApiClient();
