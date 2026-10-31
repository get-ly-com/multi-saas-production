import Link from 'next/link';

export default function ComingSoon() {
  return (
    <div className="auth">
      <h1>Coming soon</h1>
      <p>This product isn&apos;t available yet. Accounting, CRM and Inventory are ready to use.</p>
      <Link href="/saas/accounting">Open Accounting</Link>
    </div>
  );
}
