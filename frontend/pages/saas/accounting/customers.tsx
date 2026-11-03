import AppShell from '@/components/AppShell';
import PartyList from '@/components/PartyList';

export default function Customers() {
  return (
    <AppShell>
      <PartyList title="Customers" noun="customer" path="/api/accounting/customers" balanceLabel="Owes you" statementPath="/saas/accounting/statements" />
    </AppShell>
  );
}
