'use client';

import { useActionState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionResult } from '@/lib/action-result';
import { useActionToast } from '@/hooks/use-action-toast';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type ServerAction = (
  prev: ActionResult | null,
  formData: FormData,
) => Promise<ActionResult>;

function DefaultSubmitButton({
  label,
  pendingLabel,
  className,
}: {
  label: string;
  pendingLabel: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className={className} variant="outline">
      {pending ? pendingLabel : label}
    </Button>
  );
}

export function ActionForm({
  action,
  className,
  children,
  submitLabel = 'Save',
  pendingLabel = 'Saving…',
  showDefaultSubmit = false,
  submitClassName,
}: {
  action: ServerAction;
  className?: string;
  children: ReactNode;
  submitLabel?: string;
  pendingLabel?: string;
  /** When true, renders a default Save button at the end. */
  showDefaultSubmit?: boolean;
  submitClassName?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  useActionToast(state);

  return (
    <form action={formAction} className={cn(className)}>
      {children}
      {showDefaultSubmit ? (
        <DefaultSubmitButton
          label={submitLabel}
          pendingLabel={pendingLabel}
          className={submitClassName}
        />
      ) : null}
    </form>
  );
}

export function ActionSubmitButton({
  label = 'Save',
  pendingLabel = 'Saving…',
  className,
  variant = 'outline',
}: {
  label?: string;
  pendingLabel?: string;
  className?: string;
  variant?: 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'link';
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className={className} variant={variant}>
      {pending ? pendingLabel : label}
    </Button>
  );
}
