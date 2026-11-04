import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import Icon from '@/components/Icon';
import { CRM_SAVED, api, formatDate } from '@/lib/api';

const CHECK_EVERY = 60 * 1000;

export default function NotificationBell() {
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<{ unread: number; items: any[] }>({ unread: 0, items: [] });
  const [open, setOpen] = useState(false);

  // A failed check just leaves the last list showing
  const load = () => api.get('/api/crm/notifications').then(setData).catch(() => undefined);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, CHECK_EVERY);
    // A CRM save can set off a rule, so check straight away too
    window.addEventListener(CRM_SAVED, load);
    return () => {
      clearInterval(timer);
      window.removeEventListener(CRM_SAVED, load);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  // Saving sends CRM_SAVED, which reloads the list
  const markRead = (ids: string[] | null) => api.post('/api/crm/notifications/read', { ids }).catch(() => undefined);

  const choose = async (item: any) => {
    setOpen(false);
    if (!item.read_at) await markRead([item.id]);
    if (item.link) router.push(item.link);
  };

  return (
    <div className="bell" ref={box}>
      <button
        type="button"
        className="icon-button always"
        aria-label={data.unread > 0 ? `Alerts, ${data.unread} unread` : 'Alerts'}
        aria-expanded={open}
        title="Alerts"
        onClick={() => setOpen(!open)}
      >
        <Icon name="bell" />
        {data.unread > 0 && <span className="bell-count">{data.unread > 99 ? '99+' : data.unread}</span>}
      </button>
      {open && (
        <div className="bell-menu">
          <div className="bell-head">
            <strong>Alerts</strong>
            {data.unread > 0 && <button className="link always" onClick={() => markRead(null)}>Mark all read</button>}
          </div>
          {data.items.length === 0 && <p className="empty">You&apos;re all caught up. New alerts show up here.</p>}
          {data.items.map((item) => (
            <button key={item.id} className={`bell-item always ${item.read_at ? '' : 'unread'}`} onClick={() => choose(item)}>
              {item.title}
              <small>{[item.body, formatDate(item.created_at)].filter(Boolean).join(' · ')}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
