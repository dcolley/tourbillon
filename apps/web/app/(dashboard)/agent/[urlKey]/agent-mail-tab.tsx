import { db, agentMail, agents } from '@tourbillon/db';
import { eq, or, inArray, desc } from 'drizzle-orm';

export async function AgentMailTab({ agentId }: { agentId: string }) {
  const mails = await db
    .select()
    .from(agentMail)
    .where(or(eq(agentMail.fromAgentId, agentId), eq(agentMail.toAgentId, agentId)))
    .orderBy(desc(agentMail.createdAt))
    .limit(50);

  if (mails.length === 0) {
    return (
      <div className="border rounded-lg p-8 text-center">
        <p className="text-sm text-muted-foreground">No mail yet.</p>
      </div>
    );
  }

  // Fetch all relevant agents
  const agentIds = new Set<string>();
  for (const mail of mails) {
    agentIds.add(mail.fromAgentId);
    agentIds.add(mail.toAgentId);
  }
  const agentList = await db
    .select({ id: agents.id, name: agents.name, urlKey: agents.urlKey })
    .from(agents)
    .where(inArray(agents.id, Array.from(agentIds)));
  
  const agentMap = new Map(agentList.map(a => [a.id, a]));

  return (
    <div className="border rounded-lg divide-y">
      <div className="p-4">
        <h3 className="text-sm font-semibold">Agent Mail</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Recent sent and received messages
        </p>
      </div>
      <div className="divide-y">
        {mails.map((mail) => {
          const isSent = mail.fromAgentId === agentId;
          const otherAgentId = isSent ? mail.toAgentId : mail.fromAgentId;
          const otherAgent = agentMap.get(otherAgentId);
          
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
                    <time dateTime={mail.createdAt.toISOString()}>
                      {mail.createdAt.toLocaleString()}
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
