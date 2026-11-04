import Link from 'next/link';
import { PRODUCTS } from '@/lib/products';

export default function Home() {
  return (
    <div className="page">
      <div className="hero">
        <h1>Run your business from one place</h1>
        <p>Accounting, CRM, inventory, HR and more under a single login, with your company&apos;s data kept separate.</p>
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
