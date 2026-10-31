import { useRouter } from 'next/router';

const APPS = {
  chatbot: { emoji: '🤖', name: 'Chatbot' },
  video: { emoji: '📹', name: 'Video Conference' },
  scheduler: { emoji: '📅', name: 'Scheduler' },
  'social-media': { emoji: '📱', name: 'Social Media' },
  analytics: { emoji: '📈', name: 'Analytics' },
  integration: { emoji: '🔗', name: 'Integration' },
  websocket: { emoji: '🔌', name: 'WebSocket' },
  worker: { emoji: '⚙️', name: 'Worker Jobs' },
  hr: { emoji: '👔', name: 'HR System' },
};

export default function App() {
  const router = useRouter();
  const { app } = router.query;
  const appConfig = APPS[app as keyof typeof APPS];

  if (!appConfig) {
    return <div style={{ padding: '20px' }}>App not found</div>;
  }

  return (
    <div style={{ padding: '20px', maxWidth: '1000px', margin: '0 auto' }}>
      <h1>{appConfig.emoji} {appConfig.name}</h1>
      <p>Status: ✅ Running</p>
      <p>Tenant: {app}</p>
      <div style={{ marginTop: '20px', padding: '20px', backgroundColor: '#f0f0f0', borderRadius: '8px' }}>
        <h3>API Connection</h3>
        <p>Service is connected and responding to requests.</p>
      </div>
    </div>
  );
}
