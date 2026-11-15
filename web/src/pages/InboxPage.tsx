/** Everything that is waiting for the user, across all runs. */
import { api } from '../api.ts';
import { ApprovalCard } from '../components/ApprovalCard.tsx';
import { Empty, ErrorNote, PageHeader } from '../components/common.tsx';
import { useLoad } from '../hooks.ts';
import { useLive } from '../live.ts';

export function InboxPage() {
  const pending = useLoad(api.pendingApprovals);
  useLive({ onRun: pending.reload });

  return (
    <>
      <PageHeader title="Inbox" />
      <ErrorNote message={pending.error} />
      {pending.data?.length === 0 && <Empty>Nothing needs you right now.</Empty>}
      <div className="card-list">
        {pending.data?.map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} title={approval.workflowName} runLink onResolved={pending.reload} />
        ))}
      </div>
    </>
  );
}
