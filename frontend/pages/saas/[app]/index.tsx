import Link from 'next/link';

export default function ComingSoon() {
  return (
    <div className="auth">
      <h1>Page not found</h1>
      <p>This page doesn&apos;t exist. Pick a product from the menu.</p>
      <Link href="/saas/accounting">Open Accounting</Link>
    </div>
  );
}
