'use client';

import { useEffect, useState, useRef } from 'react';

type AgentMail = {
  id: string;
  companyId: string;
  fromAgentId: string;
  toAgentId: string;
  body: string;
  inReplyTo: string | null;
  createdAt: string;
  fromAgent?: { id: string; name: string; urlKey: string };
  toAgent?: { id: string; name: string; urlKey: string };
};

type MailResponse = {
  mails: AgentMail[];
};

export function AgentMailTab({ agentId, companyId }: { agentId: string; companyId: string }) {
  const [mails, setMails] = useState<AgentMail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(true);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchMails = async () => {
    try {
      const response = await fetch(`/api/companies/${companyId}/agent-mail-client?agentId=${agentId}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data: MailResponse = await response.json();
      setMails(data.mails);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load mail');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = () => {
    setLoading(true);
    fetchMails();
  };

  useEffect(() => {
    fetchMails();

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(entry?.isIntersecting ?? false);
      },
      { threshold: 0 }
    );

    const element = document.getElementById('mail-tab-container');
    if (element) {
      observer.observe(element);
    }

    return () => {
      if (element) {
        observer.disconnect();
      }
    };
  }, [agentId, companyId]);

  useEffect(() => {
    if (isVisible) {
      pollIntervalRef.current = setInterval(() => {
        fetchMails();
      }, 5000);
    } else {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [isVisible, agentId, companyId]);

  if (loading && mails.length === 0) {
    return (
      <div id="mail-tab-container" className="border rounded-lg p-8 text-center">
        <p className="text-sm text-muted-foreground">Loading mail...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div id="mail-tab-container" className="border rounded-lg p-8 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          onClick={handleRefresh}
          className="mt-4 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Retry
        </button>
      </div>
    );
  }

  if (mails.length === 0) {
    return (
      <div id="mail-tab-container" className="border rounded-lg p-8 text-center">
        <p className="text-sm text-muted-foreground">No mail yet.</p>
      </div>
    );
  }

  return (
    <div id="mail-tab-container" className="border rounded-lg divide-y">
      <div className="p-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Agent Mail</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Recent sent and received messages
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>
      <div className="divide-y">
        {mails.map((mail) => {
          const isSent = mail.fromAgentId === agentId;
          const otherAgent = isSent ? mail.toAgent : mail.fromAgent;
          
          return (
            <div key={mail.id} className="p-4 space-y-2">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className={`font-medium ${isSent ? 'text-blue-600' : 'text-green-600'}`}>
                      {isSent ? 'To' : 'From'}
                    </span>
                    <span>{otherAgent?.name || 'Unknown'}</span>
                    <span className="text-muted-foreground/50">•</span>
                    <time dateTime={mail.createdAt}>
                      {new Date(mail.createdAt).toLocaleString()}
                    </time>
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{mail.body}</p>
                </div>
              </div>
              {mail.inReplyTo && (
                <p className="text-xs text-muted-foreground">
                  ↳ In reply to {mail.inReplyTo.slice(0, 8)}…
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
