import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * Existing board decision form (POST /api/approvals/:id/decide, board-guarded), shared by the
 * approvals list and the approval details page. Reject needs a reason (it is the board's
 * feedback to the requesting agent): the textarea is `required`, and Approve skips that check
 * with `formNoValidate`. The decide route enforces the same rule server-side.
 */
export function ApprovalDecisionForm({ approvalId }: { approvalId: string }) {
  return (
    <form action={`/api/approvals/${approvalId}/decide`} method="POST" className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={`approval-note-${approvalId}`}>Reason (required to reject)</Label>
        <Textarea
          id={`approval-note-${approvalId}`}
          name="note"
          rows={3}
          required
          aria-describedby={`approval-note-help-${approvalId}`}
          placeholder="What should change? Required to reject; optional to approve."
          className="resize-y"
        />
        <p id={`approval-note-help-${approvalId}`} className="text-xs text-muted-foreground">
          To request changes, reject with a reason: the agent gets it as Board feedback, and it is
          posted to linked issues.
        </p>
      </div>
      <div className="flex gap-2">
        <Button type="submit" name="decision" value="approved" size="sm" formNoValidate>
          Approve
        </Button>
        <Button type="submit" name="decision" value="rejected" size="sm" variant="destructive">
          Reject with reason
        </Button>
      </div>
    </form>
  );
}
