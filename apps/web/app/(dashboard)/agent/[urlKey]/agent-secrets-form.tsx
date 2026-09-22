'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Trash2, Plus, Eye, EyeOff, AlertTriangle } from 'lucide-react';

interface AgentSecretsFormProps {
  agentId: string;
  urlKey: string;
  existingKeys: string[];
}

/**
 * AC-B1.1: Per-agent secrets/environment variables UI.
 * Values are write-only after save (never redisplayed).
 */
export function AgentSecretsForm({
  agentId,
  urlKey,
  existingKeys,
}: AgentSecretsFormProps) {
  const router = useRouter();
  const [secrets, setSecrets] = useState<{ key: string; value: string }[]>([
    { key: '', value: '' },
  ]);
  const [keysToDelete, setKeysToDelete] = useState<string[]>([]);
  const [showValues, setShowValues] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  const addSecretRow = () => {
    setSecrets([...secrets, { key: '', value: '' }]);
  };

  const updateSecret = (index: number, field: 'key' | 'value', value: string) => {
    const updated = [...secrets];
    updated[index] = { ...updated[index], [field]: value };
    setSecrets(updated);
  };

  const removeSecretRow = (index: number) => {
    const updated = secrets.filter((_, i) => i !== index);
    setSecrets(updated.length > 0 ? updated : [{ key: '', value: '' }]);
  };

  const toggleDeleteExisting = (key: string) => {
    setKeysToDelete((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const toggleShowValue = (index: number) => {
    setShowValues((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  const handleSave = async () => {
    setLoading(true);
    setMessage(null);

    try {
      // Filter out empty secrets
      const validSecrets = secrets.filter(
        (s) => s.key.trim() && s.value.trim()
      );

      if (validSecrets.length > 0) {
        const secretsObj = validSecrets.reduce(
          (acc, s) => {
            acc[s.key.trim()] = s.value.trim();
            return acc;
          },
          {} as Record<string, string>
        );

        const response = await fetch(`/api/agents/${urlKey}/secrets`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secrets: secretsObj, replace: false }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to update secrets');
        }
      }

      // Delete marked secrets
      if (keysToDelete.length > 0) {
        const response = await fetch(`/api/agents/${urlKey}/secrets`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys: keysToDelete }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to delete secrets');
        }
      }

      setMessage({
        type: 'success',
        text: 'Secrets updated successfully. Changes will take effect on next agent wake.',
      });
      setSecrets([{ key: '', value: '' }]);
      setKeysToDelete([]);
      setShowValues({});
      
      // Refresh the page to get updated keys
      router.refresh();
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to update secrets',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-semibold">Agent Secrets</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Environment variables injected into code-execution sandbox. Values are write-only
              after save.
            </p>
          </div>

          <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-md">
            <div className="flex gap-2">
              <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 mt-0.5" />
              <div className="text-sm text-yellow-800 dark:text-yellow-200">
                <strong>AC-B1.2: Security Notice</strong>
                <br />
                Secrets are injected into the agent&apos;s code execution environment but never appear
                in prompts, observability logs, or issue comments. Key names follow environment
                variable naming rules (letters, numbers, underscores; must start with letter or
                underscore).
              </div>
            </div>
          </div>

          {message && (
            <div
              className={`p-4 rounded-md ${
                message.type === 'error'
                  ? 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200'
                  : 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-800 dark:text-green-200'
              }`}
            >
              {message.text}
            </div>
          )}

          {/* Existing secrets */}
          {existingKeys.length > 0 && (
            <div className="space-y-2">
              <Label>Existing Secrets (keys only)</Label>
              <div className="space-y-2">
                {existingKeys.map((key) => (
                  <div
                    key={key}
                    className="flex items-center justify-between p-3 border rounded-md bg-muted/50"
                  >
                    <div className="flex items-center gap-2">
                      <code className="text-sm">{key}</code>
                      <span className="text-xs text-muted-foreground">
                        (value hidden - write-only)
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant={keysToDelete.includes(key) ? 'destructive' : 'ghost'}
                      size="sm"
                      onClick={() => toggleDeleteExisting(key)}
                    >
                      <Trash2 className="h-4 w-4" />
                      {keysToDelete.includes(key) ? 'Marked for deletion' : 'Delete'}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* New secrets */}
          <div className="space-y-2">
            <Label>Add New Secrets</Label>
            <div className="space-y-3">
              {secrets.map((secret, index) => (
                <div key={index} className="flex items-end gap-2">
                  <div className="flex-1">
                    <Label htmlFor={`key-${index}`} className="text-xs">
                      Key
                    </Label>
                    <Input
                      id={`key-${index}`}
                      placeholder="TEST_EMAIL"
                      value={secret.key}
                      onChange={(e) => updateSecret(index, 'key', e.target.value)}
                      className="font-mono text-sm"
                    />
                  </div>
                  <div className="flex-1">
                    <Label htmlFor={`value-${index}`} className="text-xs">
                      Value
                    </Label>
                    <div className="relative">
                      <Input
                        id={`value-${index}`}
                        type={showValues[index] ? 'text' : 'password'}
                        placeholder="••••••••"
                        value={secret.value}
                        onChange={(e) => updateSecret(index, 'value', e.target.value)}
                        className="pr-10 font-mono text-sm"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-0 top-0 h-full px-3"
                        onClick={() => toggleShowValue(index)}
                      >
                        {showValues[index] ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeSecretRow(index)}
                    disabled={secrets.length === 1}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addSecretRow}
              className="w-full"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Secret
            </Button>
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setSecrets([{ key: '', value: '' }]);
                setKeysToDelete([]);
                setMessage(null);
              }}
              disabled={loading}
            >
              Reset
            </Button>
            <Button onClick={handleSave} disabled={loading}>
              {loading ? 'Saving...' : 'Save Secrets'}
            </Button>
          </div>

          <div className="text-xs text-muted-foreground border-t pt-4">
            <p>
              <strong>AC-B1.4: Usage in smoke tests:</strong> Secrets are available as environment
              variables in code execution. For example, <code>process.env.TEST_EMAIL</code> in
              Node.js or <code>$TEST_EMAIL</code> in bash scripts.
            </p>
            <p className="mt-2">
              Fallback: If agent secrets are not configured, test scripts can source from host file{' '}
              <code>~/.env.test-auth</code> as a backward-compatible option.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
