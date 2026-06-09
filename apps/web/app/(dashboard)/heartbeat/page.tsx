import { redirect } from 'next/navigation';

export default async function HeartbeatsRedirectPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string; status?: string; page?: string }>;
}) {
  const resolved = await searchParams;
  const params = new URLSearchParams();
  if (resolved.agent) params.set('agent', resolved.agent);
  if (resolved.status) params.set('status', resolved.status);
  if (resolved.page) params.set('page', resolved.page);
  const qs = params.toString();
  redirect(`/jobs/heartbeat${qs ? `?${qs}` : ''}`);
}
