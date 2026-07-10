'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

type Props = {
  children: ReactNode;
  onFallback: () => void;
};

type State = {
  hasError: boolean;
};

export class VisualEditorErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[VisualEditorErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 rounded-md border p-6 text-center">
          <p className="text-sm text-destructive">Visual editor failed to load.</p>
          <Button type="button" size="sm" variant="outline" onClick={this.props.onFallback}>
            Switch to Source
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
