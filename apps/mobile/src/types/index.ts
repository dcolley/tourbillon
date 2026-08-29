export interface Company {
  id: string;
  name: string;
  issuePrefix: string;
  slug: string;
}

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  title: string;
  role: string;
  urlKey: string;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  parentId: string | null;
  goalId: string | null;
  assigneeAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiError {
  error: string;
}
