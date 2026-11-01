import AppShell from '@/components/AppShell';
import PartyList from '@/components/PartyList';

export default function Vendors() {
  return (
    <AppShell>
      <PartyList title="Vendors" noun="vendor" path="/api/accounting/vendors" balanceLabel="You owe" />
    </AppShell>
  );
}
