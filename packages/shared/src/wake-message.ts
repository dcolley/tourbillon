import type { HeartbeatJobData, WakePayload } from './types';

const WAKE_COMMENTS_MAX_CHARS = 3000;

export function buildWakeMessage(data: HeartbeatJobData): string {
  const parts = [`Wake reason: ${data.wakeReason}`];
  if (data.taskId) parts.push(`Assigned task ID: ${data.taskId}`);
  if (data.wakePayloadJson) {
    try {
      const payload = JSON.parse(data.wakePayloadJson) as WakePayload;
      if (payload.issue) {
        parts.push(
          `Task: ${payload.issue.identifier} — ${payload.issue.title} (${payload.issue.status}, ${payload.issue.priority})`,
        );
      }
      if (payload.newComments?.length) {
        const commentLines: string[] = ['\nRecent issue comments:'];
        let chars = 0;
        for (const c of payload.newComments) {
          const line = `- [${c.createdAt}] ${c.authorName}: ${c.body}`;
          if (chars + line.length > WAKE_COMMENTS_MAX_CHARS) {
            commentLines.push('- … (truncated)');
            break;
          }
          commentLines.push(line);
          chars += line.length;
        }
        parts.push(commentLines.join('\n'));
      }
      if (payload.fallbackFetchNeeded) {
        parts.push(
          '\nFull comment history may be incomplete in this wake message. ' +
            'After checkout, call getComments without `after` for the full thread.',
        );
      }
    } catch {
      /* ignore malformed payload */
    }
  }
  parts.push('\nBegin your heartbeat procedure. Follow SKILL: Control Plane Operations exactly.');
  return parts.join('\n');
}
