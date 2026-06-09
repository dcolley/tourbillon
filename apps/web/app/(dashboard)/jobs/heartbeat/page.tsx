import { HeartbeatListPage } from '../[queue]/heartbeat-list-page';

export default async function HeartbeatJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; state?: string; page?: string; agent?: string }>;
}) {
  const resolved = await searchParams;

  return (
    <HeartbeatListPage
      searchParams={{
        status: resolved.status ?? resolved.state,
        page: resolved.page,
        agent: resolved.agent,
      }}
    />
  );
}
