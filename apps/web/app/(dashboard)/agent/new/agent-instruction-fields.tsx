'use client';

import { useEffect, useState } from 'react';
import { getRoleInstructionTemplate } from '@/lib/agent-instruction-templates';

export function AgentInstructionFields() {
  const [role, setRole] = useState('engineer');

  useEffect(() => {
    const roleSelect = document.querySelector<HTMLSelectElement>('select[name="role"]');
    if (!roleSelect) return;

    const sync = () => setRole(roleSelect.value);
    sync();
    roleSelect.addEventListener('change', sync);
    return () => roleSelect.removeEventListener('change', sync);
  }, []);

  const template = getRoleInstructionTemplate(role);

  return (
    <div className="space-y-4 border-t pt-4">
      <div>
        <h2 className="text-sm font-semibold">Instructions</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Optional. Injected into the agent system prompt on every heartbeat — before assigned skills.
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="instructionsBundleSoulMd" className="text-sm font-medium">
          SOUL.md
        </label>
        <p className="text-xs text-muted-foreground">Personality, values, and communication style.</p>
        <textarea
          id="instructionsBundleSoulMd"
          name="instructionsBundleSoulMd"
          rows={6}
          placeholder={template.soulMd}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="instructionsBundleAgentsMd" className="text-sm font-medium">
          AGENTS.md
        </label>
        <p className="text-xs text-muted-foreground">Role responsibilities, domain context, and constraints.</p>
        <textarea
          id="instructionsBundleAgentsMd"
          name="instructionsBundleAgentsMd"
          rows={6}
          placeholder={template.agentsMd}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
        />
      </div>

      <p className="text-xs text-muted-foreground">
        Placeholders update when you change Role. Leave blank to use skills only.
      </p>
    </div>
  );
}
