import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * Existing board decision form (POST /api/approvals/:id/decide, board-guarded), shared by the
 * approvals list and the approval details page.
 */
export function ApprovalDecisionForm({ approvalId }: { approvalId: string }) {
  return (
    <form action={`/api/approvals/${encodeURIComponent(approvalId)}/decide`} method="POST" className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={`approval-note-${approvalId}`}>Reason</Label>
        <Textarea
          id={`approval-note-${approvalId}`}
          name="note"
          rows={3}
          placeholder="Optional reason (posted to linked issues)"
          className="resize-y"
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" name="decision" value="approved" size="sm">
          Approve
        </Button>
        <Button type="submit" name="decision" value="rejected" size="sm" variant="destructive">
          Reject
        </Button>
      </div>
    </form>
  );
}
