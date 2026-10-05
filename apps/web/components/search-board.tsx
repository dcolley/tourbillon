'use client';

import { useState, useCallback } from 'react';
import { Search } from 'lucide-react';
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

interface SearchHit {
  type: 'issue' | 'comment' | 'document';
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

export function SearchBoard({ companyId }: SearchBoardProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  }, [query, companyId]);

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

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'issue':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300';
      case 'comment':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300';
      case 'document':
        return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300';
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
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300';
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Search className="h-4 w-4" />
          <span className="hidden md:inline">Search</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-hidden p-0">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Search Company</DialogTitle>
          <DialogDescription>
            Search across issues, comments, and documents
          </DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-4">
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
          {error && (
            <div className="mt-2 text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
        </div>
        <div className="max-h-[50vh] overflow-y-auto border-t">
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
