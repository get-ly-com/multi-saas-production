import Link from 'next/link';

const APPS = [
  { name: 'Accounting', path: '/saas/accounting', emoji: '📊' },
  { name: 'CRM', path: '/saas/crm', emoji: '👥' },
  { name: 'Inventory', path: '/saas/inventory', emoji: '📦' },
  { name: 'Chatbot', path: '/saas/chatbot', emoji: '🤖' },
  { name: 'Video', path: '/saas/video', emoji: '📹' },
  { name: 'Scheduler', path: '/saas/scheduler', emoji: '📅' },
  { name: 'HR', path: '/saas/hr', emoji: '👔' },
  { name: 'Social Media', path: '/saas/social-media', emoji: '📱' },
  { name: 'Analytics', path: '/saas/analytics', emoji: '📈' },
  { name: 'Integration', path: '/saas/integration', emoji: '🔗' },
  { name: 'WebSocket', path: '/saas/websocket', emoji: '🔌' },
  { name: 'Worker', path: '/saas/worker', emoji: '⚙️' },
];

export default function Home() {
  return (
    <div style={{ padding: '40px', maxWidth: '1200px', margin: '0 auto' }}>
      <h1>🚀 Multi-SaaS Platform</h1>
      <p>13 Microservices. One Deploy. Zero Downtime.</p>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
        gap: '20px',
        marginTop: '30px'
      }}>
        {APPS.map((app) => (
          <Link href={app.path} key={app.path}>
            <a style={{
              padding: '20px',
              border: '1px solid #ddd',
              borderRadius: '8px',
              textDecoration: 'none',
              color: 'inherit',
              transition: 'all 0.2s'
            }}>
              <div style={{ fontSize: '40px', marginBottom: '10px' }}>{app.emoji}</div>
              <h3>{app.name}</h3>
            </a>
          </Link>
        ))}
      </div>

      <div style={{ marginTop: '50px', padding: '20px', backgroundColor: '#f0f0f0', borderRadius: '8px' }}>
        <h2>Status</h2>
        <p>✅ All 13 services deployed</p>
        <p>✅ Database: Multi-tenant Supabase</p>
        <p>✅ Infrastructure: Railway</p>
        <p>✅ Frontend: Vercel</p>
      </div>
    </div>
  );
}
