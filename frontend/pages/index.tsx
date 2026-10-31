import Link from 'next/link';

const PRODUCTS = [
  { name: 'Accounting', path: '/saas/accounting', about: 'Send invoices, track what is owed and record expenses.' },
  { name: 'CRM', path: '/saas/crm', about: 'Keep your contacts in one place and move deals through a pipeline.' },
  { name: 'Inventory', path: '/saas/inventory', about: 'Track stock, see what is running low and keep a full history.' }
];

export default function Home() {
  return (
    <div className="page">
      <div className="hero">
        <h1>Run your business from one place</h1>
        <p>Accounting, CRM and inventory under a single login, with your company&apos;s data kept separate.</p>
        <Link href="/login" className="button primary">Sign in or create an account</Link>
      </div>
      <div className="products">
        {PRODUCTS.map(({ name, path, about }) => (
          <Link href={path} key={path} className="card">
            <h2>{name}</h2>
            <p>{about}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
