'use client';

import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { cn } from '@/lib/utils';
import { inputClassName } from '@/components/ui/input';

export type PasswordInputProps = Omit<React.ComponentProps<'input'>, 'type'> & {
  /** Classes for the wrapper (e.g. `flex-1` when the input sits in a flex row). */
  wrapperClassName?: string;
};

export type PasswordInputViewProps = PasswordInputProps & {
  visible: boolean;
  onToggleVisible: () => void;
};

/**
 * Stateless markup for PasswordInput: the input plus an eye-icon toggle button.
 * The button is a real `type="button"` (never submits the form), labelled for screen readers and
 * reflecting state with aria-pressed. All other props (including `ref`) go to the input. The value
 * is never read, logged or stored here.
 */
export function PasswordInputView({
  visible,
  onToggleVisible,
  wrapperClassName,
  className,
  disabled,
  ...props
}: PasswordInputViewProps) {
  return (
    <div data-slot="password-input" className={cn('relative w-full', wrapperClassName)}>
      <input
        {...props}
        type={visible ? 'text' : 'password'}
        disabled={disabled}
        data-slot="input"
        className={cn(className ?? inputClassName, 'pr-9')}
      />
      <button
        type="button"
        onClick={onToggleVisible}
        disabled={disabled}
        aria-label={visible ? 'Hide secret' : 'Show secret'}
        aria-pressed={visible}
        aria-controls={props.id}
        title={visible ? 'Hide secret' : 'Show secret'}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
      >
        {visible ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
      </button>
    </div>
  );
}

/**
 * Secret input with a show/hide toggle. Hidden by default; visibility is local UI state only
 * (not persisted). Drop-in for `<input type="password" …>`: pass the usual input props and ref.
 */
export function PasswordInput(props: PasswordInputProps) {
  const [visible, setVisible] = React.useState(false);
  const onToggleVisible = React.useCallback(() => setVisible((v) => !v), []);
  return <PasswordInputView {...props} visible={visible} onToggleVisible={onToggleVisible} />;
}
