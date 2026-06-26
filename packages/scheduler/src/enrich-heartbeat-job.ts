import { db, agents } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import type { HeartbeatJobData } from '@tourbillon/shared';

export async function enrichHeartbeatJobData(data: HeartbeatJobData): Promise<HeartbeatJobData> {
  if (data.agentName) return data;

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, data.agentId),
    columns: { name: true },
  });

  if (!agent?.name) return data;
  return { ...data, agentName: agent.name };
}
