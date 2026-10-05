'use client';

import { useState, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useRouter } from 'next/navigation';
import type { IssueStatus } from '@tourbillon/db';

interface SearchHit {
  type: 'issue' | 'comment' | 'document' | 'approval';
  id: string;
  issueId?: string;
  identifier?: string;
  title: string;
  snippet: string;
  status?: string;
  updatedAt: string;
  href?: string;
}

interface SearchBoardProps {
  companyId: string;
}

type SearchType = 'issue' | 'comment' | 'document' | 'approval';

const ALL_TYPES: SearchType[] = ['issue', 'comment', 'document', 'approval'];
const ISSUE_STATUSES: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'];

export function SearchBoard({ companyId }: SearchBoardProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<Set<SearchType>>(new Set(ALL_TYPES));
  const [selectedStatus, setSelectedStatus] = useState<IssueStatus | null>(null);
  const router = useRouter();

  const handleSearch = useCallback(async () => {
    if (!query.trim()) {
      setError('Search query cannot be empty');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ q: query });
      
      // Add type filters
      if (selectedTypes.size > 0 && selectedTypes.size < ALL_TYPES.length) {
        params.append('types', Array.from(selectedTypes).join(','));
      }
      
      // Add status filter (only when Issue is selected)
      if (selectedTypes.has('issue') && selectedStatus) {
        params.append('status', selectedStatus);
      }
      
      const response = await fetch(`/api/companies/${companyId}/search?${params.toString()}`, {
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Search failed' }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data = await response.json();
      setResults(data.results || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query, companyId, selectedTypes, selectedStatus]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const handleResultClick = (hit: SearchHit) => {
    if (hit.href) {
      router.push(hit.href);
      setOpen(false);
    }
  };

  const toggleType = (type: SearchType) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'issue':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300';
      case 'comment':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300';
      case 'document':
        return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300';
      case 'approval':
        return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'done':
        return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300';
      case 'in_progress':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300';
      case 'blocked':
        return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300';
      case 'in_review':
        return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300';
      case 'approved':
        return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300';
      case 'rejected':
        return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300';
    }
  };

  const showStatusFilter = selectedTypes.has('issue');

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={(props) => (
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            {...props}
          >
            <Search className="h-4 w-4" />
            <span className="hidden md:inline">Search</span>
          </Button>
        )}
      />
      <DialogContent className="max-h-[80vh] w-[95vw] max-w-[1100px] sm:max-w-[1100px] overflow-hidden p-0 md:w-[80vw]">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Search Company</DialogTitle>
          <DialogDescription>
            Search across issues, comments, documents, and approvals
          </DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-4 space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="Enter search query..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading}
              className="flex-1"
            />
            <Button onClick={handleSearch} disabled={loading || !query.trim()}>
              {loading ? 'Searching...' : 'Search'}
            </Button>
          </div>
          
          {/* Type filter chips */}
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {ALL_TYPES.map((type) => (
                <Badge
                  key={type}
                  variant={selectedTypes.has(type) ? 'default' : 'outline'}
                  className="cursor-pointer select-none capitalize"
                  onClick={() => toggleType(type)}
                >
                  {type}
                  {selectedTypes.has(type) && (
                    <X className="ml-1 h-3 w-3" />
                  )}
                </Badge>
              ))}
            </div>
            
            {/* Issue status filter */}
            {showStatusFilter && (
              <div className="flex flex-wrap gap-2 pt-2 border-t">
                <span className="text-sm text-muted-foreground self-center">Issue status:</span>
                <Badge
                  variant={selectedStatus === null ? 'default' : 'outline'}
                  className="cursor-pointer select-none"
                  onClick={() => setSelectedStatus(null)}
                >
                  All
                  {selectedStatus === null && (
                    <X className="ml-1 h-3 w-3" />
                  )}
                </Badge>
                {ISSUE_STATUSES.map((status) => (
                  <Badge
                    key={status}
                    variant={selectedStatus === status ? 'default' : 'outline'}
                    className="cursor-pointer select-none"
                    onClick={() => setSelectedStatus(status === selectedStatus ? null : status)}
                  >
                    {status.replace('_', ' ')}
                    {selectedStatus === status && (
                      <X className="ml-1 h-3 w-3" />
                    )}
                  </Badge>
                ))}
              </div>
            )}
          </div>
          
          {error && (
            <div className="text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
        </div>
        <div className="max-h-[55vh] overflow-y-auto border-t">
          {results.length === 0 && !loading && query && !error && (
            <div className="px-6 py-8 text-center text-sm text-muted-foreground">
              No results found for "{query}"
            </div>
          )}
          {results.length > 0 && (
            <div className="divide-y">
              {results.map((hit) => (
                <button
                  key={`${hit.type}-${hit.id}`}
                  onClick={() => handleResultClick(hit)}
                  className="flex w-full flex-col gap-2 px-6 py-4 text-left transition-colors hover:bg-accent"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className={getTypeColor(hit.type)}>
                      {hit.type}
                    </Badge>
                    {hit.identifier && (
                      <span className="text-sm font-mono text-muted-foreground">
                        {hit.identifier}
                      </span>
                    )}
                    {hit.status && (
                      <Badge variant="outline" className={getStatusColor(hit.status)}>
                        {hit.status}
                      </Badge>
                    )}
                  </div>
                  <div className="font-medium">{hit.title}</div>
                  <div className="text-sm text-muted-foreground line-clamp-2">
                    {hit.snippet}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Updated: {new Date(hit.updatedAt).toLocaleString()}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
