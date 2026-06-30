import Link from 'next/link';
import { redirect } from 'next/navigation';
import { db, agents } from '@tourbillon/db';
import { desc, eq } from 'drizzle-orm';
import { getActiveCompany } from '@/lib/company';
import { AgentValidationError, AGENT_ROLE_OPTIONS, createAgent } from '@/lib/agents';
import { AgentInstructionFields } from './agent-instruction-fields';

async function hireAgent(formData: FormData) {
  'use server';

  const reportsToId = formData.get('reportsToId') as string | null;
  let created;
  try {
    created = await createAgent({
      name: formData.get('name') as string,
      title: formData.get('title') as string,
      role: formData.get('role') as string,
      urlKey: (formData.get('urlKey') as string) || undefined,
      reportsToId: reportsToId || null,
      runtimeType: (formData.get('runtimeType') as 'agent' | 'harness') || 'agent',
      instructionsBundleSoulMd: (formData.get('instructionsBundleSoulMd') as string) || undefined,
      instructionsBundleAgentsMd: (formData.get('instructionsBundleAgentsMd') as string) || undefined,
    });
  } catch (err) {
    if (err instanceof AgentValidationError) {
      redirect(`/agent/new?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  redirect(`/agent/${created.urlKey}`);
}

export default async function NewAgentPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const company = await getActiveCompany();
  const existingAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.companyId, company.id))
    .orderBy(desc(agents.createdAt));
  const error = searchParams.error ? decodeURIComponent(searchParams.error) : null;

  return (
    <div className="p-6 max-w-lg space-y-6">
      <div>
        <Link href="/agent" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to agents
        </Link>
        <h1 className="text-2xl font-bold tracking-tight mt-2">Hire Agent</h1>
        <p className="text-muted-foreground">Add a new agent to your company roster.</p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <form action={hireAgent} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="name" className="text-sm font-medium">
            Name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            placeholder="Alex"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="title" className="text-sm font-medium">
            Title
          </label>
          <input
            id="title"
            name="title"
            type="text"
            required
            placeholder="Chief Technology Officer"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="role" className="text-sm font-medium">
            Role
          </label>
          <select
            id="role"
            name="role"
            required
            defaultValue="engineer"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {AGENT_ROLE_OPTIONS.map((role) => (
              <option key={role.value} value={role.value}>
                {role.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <span className="text-sm font-medium">Agent type</span>
          <div className="space-y-2 rounded-md border border-input p-3">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="runtimeType"
                value="agent"
                defaultChecked
                className="mt-1"
              />
              <span>
                <span className="text-sm font-medium">Agent</span>
                <span className="block text-xs text-muted-foreground">
                  Standard heartbeat agent with durable resume (recommended)
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="runtimeType"
                value="harness"
                className="mt-1"
              />
              <span>
                <span className="text-sm font-medium">Harness</span>
                <span className="block text-xs text-muted-foreground">
                  Mastra Code harness with file tools, sandbox, and observational memory
                </span>
              </span>
            </label>
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="urlKey" className="text-sm font-medium">
            Agent ID
          </label>
          <input
            id="urlKey"
            name="urlKey"
            type="text"
            placeholder="ben"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Short slug for the agent URL, e.g. <span className="font-mono">/agent/ben</span>.
            Auto-generated from name if blank.
          </p>
        </div>

        {existingAgents.length > 0 && (
          <div className="space-y-1.5">
            <label htmlFor="reportsToId" className="text-sm font-medium">
              Reports to
            </label>
            <select
              id="reportsToId"
              name="reportsToId"
              defaultValue=""
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">None</option>
              {existingAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} ({agent.title})
                </option>
              ))}
            </select>
          </div>
        )}

        <AgentInstructionFields />

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Hire Agent
          </button>
          <Link
            href="/agent"
            className="inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
