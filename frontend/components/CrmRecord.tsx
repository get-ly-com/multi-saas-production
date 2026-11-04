import Link from 'next/link';
import { CSSProperties, Fragment, MouseEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FinishForm, LogForm, PlanForm, dueState, dueText, finishActivity, kindName, reopenActivity } from '@/components/ActivityForms';
import Drawer from '@/components/Drawer';
import EmailForm from '@/components/EmailForm';
import Icon from '@/components/Icon';
import { scoreBadge, scoreLabel, statusBadge, statusLabel } from '@/components/LeadForms';
import Skeleton from '@/components/Skeleton';
import { Tag, TagChips } from '@/components/Tags';
import { toast } from '@/components/Toast';
import { api, formatDate, money } from '@/lib/api';
import { whatsappLink, whatsappNumber } from '@/lib/whatsapp';
import styles from '@/styles/crm.module.css';

// Pieces the CRM pages share: record headers, the record drawer, the activity checklist and simple bars.

// ---------- Small helpers ----------

export const initials = (name?: string | null) => {
  const words = String(name || '').trim().split(/[\s\-_.,&/()]+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
};

// A plain click opens the drawer; Ctrl, Cmd, Shift or a middle click still follows the link
export const openInDrawer = (open: () => void) => (event: MouseEvent) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  open();
};

// Shapes the shared icon set doesn't have yet, drawn the same way (24px grid, stroke, currentColor)
const EXTRA: Record<string, string> = {
  phone: 'M5 4h3.5l1.8 4.4-2.3 1.4a11 11 0 0 0 6.2 6.2l1.4-2.3L20 15.5V19a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z',
  mail: 'M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM3.5 7l8.5 6 8.5-6',
  note: 'M5 20h4L19.5 9.5a2.1 2.1 0 0 0-3-3L6 17v3zM14.5 8.5l3 3',
  whatsapp: 'M4 20l1.3-3.9A8 8 0 1 1 8 18.8L4 20zM9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 .8a4 4 0 0 1-1.8-1.8l.8-1-1-2L9 9.5z',
  calendar: 'M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM4 10h16M8 3v4M16 3v4',
  stage: 'M4 12h12M12 6l6 6-6 6',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01'
};

export function CrmIcon({ name, size = 16, style }: { name: string; size?: number; style?: CSSProperties }) {
  if (!EXTRA[name]) return <Icon name={name} size={size} style={style} />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
      <path d={EXTRA[name]} />
    </svg>
  );
}

export const kindIcon = (kind: string) =>
  ({ call: 'phone', meeting: 'calendar', email: 'mail', task: 'check', note: 'note' } as Record<string, string>)[kind] || 'clock';

// Modals open above the drawer, so they sit in their own top layer
function Above({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready) return null;
  return createPortal(<div style={{ position: 'fixed', inset: 0, zIndex: 70 }}>{children}</div>, document.body);
}

// ---------- Record header ----------

export type Chip = { icon: string; label: ReactNode; href?: string; external?: boolean; title?: string };

export function FieldChip({ icon, label, href, external, title }: Chip) {
  const inner = <><CrmIcon name={icon} size={14} /><span>{label}</span></>;
  if (!href) return <span className={styles.fieldChip} title={title}>{inner}</span>;
  if (external) return <a className={styles.fieldChip} href={href} title={title} target="_blank" rel="noopener noreferrer">{inner}</a>;
  return <Link className={styles.fieldChip} href={href} title={title}>{inner}</Link>;
}

export function RecordHeader({ name, square, badge, line, chips = [], tags, actions }: {
  name: string; square?: boolean; badge?: ReactNode; line?: ReactNode; chips?: (Chip | false | null | undefined)[]; tags?: ReactNode; actions?: ReactNode;
}) {
  const shown = chips.filter(Boolean) as Chip[];
  return (
    <header className={styles.recordHead}>
      <div className={styles.identity}>
        <span className={`${styles.avatar} ${square ? styles.square : ''}`} aria-hidden="true">{initials(name)}</span>
        <div style={{ minWidth: 0 }}>
          <h1 className={styles.recordName}>{name}{badge}</h1>
          {line && <p className={styles.recordLine}>{line}</p>}
          {shown.length > 0 && <div className={styles.chips}>{shown.map((chip, n) => <FieldChip key={n} {...chip} />)}</div>}
          {tags && <div className={styles.headTags}>{tags}</div>}
        </div>
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  );
}

// ---------- Stat tile ----------

export function StatTile({ label, value, note, icon, tone, href }: {
  label: string; value: ReactNode; note?: ReactNode; icon?: string; tone?: 'good'; href?: string;
}) {
  const body = (
    <>
      {icon && <span className={`${styles.tileIcon} ${tone === 'good' ? styles.good : ''}`} aria-hidden="true"><CrmIcon name={icon} size={15} /></span>}
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className={styles.tileNote}>{note}</div>}
    </>
  );
  return href
    ? <Link href={href} className={`card stat-link ${styles.tile}`}>{body}</Link>
    : <div className={`card ${styles.tile}`}>{body}</div>;
}

// ---------- Bars ----------

export type Bar = { key: string; label: ReactNode; value: number; text: ReactNode; extra?: ReactNode; tone?: 'good' | 'danger'; title?: string };

// One horizontal bar per row, scaled to the largest value. The numbers sit beside the bars.
export function Bars({ rows, max }: { rows: Bar[]; max?: number }) {
  const top = max ?? Math.max(0, ...rows.map((row) => row.value));
  return (
    <ul className={styles.bars}>
      {rows.map((row) => {
        const part = top > 0 ? Math.max(0, row.value) / top : 0;
        const width = part > 0 ? Math.max(part * 100, 1.5) : 0;
        return (
          <li key={row.key} className={styles.barRow}>
            <span className={styles.barLabel} title={row.title}>{row.label}</span>
            <svg className={styles.barSvg} role="img" aria-label={row.title || String(row.key)}>
              <title>{row.title}</title>
              <rect className={styles.barTrack} x="0" y="2" width="100%" height="8" rx="4" />
              {width > 0 && <rect className={`${styles.barFill} ${row.tone ? styles[row.tone] : ''}`} x="0" y="2" width={`${width}%`} height="8" rx="4" />}
            </svg>
            <span className={styles.barValue}>{row.text}{row.extra && <small>{row.extra}</small>}</span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------- Activity checklist ----------

const linkedOf = (item: any): { href: string; name: string } | null => {
  if (item.deal) return { href: `/saas/crm/deal/${item.deal.id}`, name: item.deal.title };
  if (item.deal_id && item.deal_title) return { href: `/saas/crm/deal/${item.deal_id}`, name: item.deal_title };
  if (item.lead) return { href: `/saas/crm/lead/${item.lead.id}`, name: item.lead.name };
  if (item.lead_id && item.lead_name) return { href: `/saas/crm/lead/${item.lead_id}`, name: item.lead_name };
  if (item.contact) return { href: `/saas/crm/contact/${item.contact.id}`, name: item.contact.name };
  if (item.contact_id && item.contact_name) return { href: `/saas/crm/contact/${item.contact_id}`, name: item.contact_name };
  if (item.company) return { href: `/saas/crm/company/${item.company.id}`, name: item.company.name };
  return null;
};

const dueLabel = (item: any) => {
  const state = dueState(item);
  const time = item.due_time ? item.due_time.slice(0, 5) : '';
  if (state === 'overdue') return `Overdue, ${formatDate(item.due_on)}`;
  if (state === 'today') return time ? `Today ${time}` : 'Today';
  return dueText(item);
};

// Calls, meetings, emails and to-dos as a list to tick off. A tick marks it done straight away
// (with Undo); "Add notes" opens the full form to say how it went and plan the next step.
export function ActivityChecklist({ items, onChanged, ownerName, empty, onCleared }: {
  items: any[];
  onChanged: () => void;
  ownerName?: (id: string) => string;
  empty?: ReactNode;
  onCleared?: (from: Element | null) => void;
}) {
  const [checking, setChecking] = useState<string[]>([]);
  const [gone, setGone] = useState<string[]>([]);
  const [finishing, setFinishing] = useState<any>(null);
  const list = useRef<HTMLUListElement>(null);

  const visible = items.filter((item) => !gone.includes(item.id) && !item.done_at);

  const check = async (item: any) => {
    setChecking((ids) => [...ids, item.id]);
    try {
      // Let the tick draw before the row folds away
      await Promise.all([finishActivity(item.id), new Promise((resolve) => setTimeout(resolve, 520))]);
      setGone((ids) => {
        const next = [...ids, item.id];
        const left = items.filter((row) => !row.done_at && !next.includes(row.id)).length;
        if (left === 0) setTimeout(() => onCleared?.(list.current), 0);
        return next;
      });
      toast.success('Done', {
        detail: item.subject,
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              await reopenActivity(item.id);
              setGone((ids) => ids.filter((id) => id !== item.id));
              onChanged();
            } catch (err: any) {
              toast.error('Could not undo', { detail: err.message });
            }
          }
        }
      });
      onChanged();
    } catch (err: any) {
      toast.error('Could not mark it done', { detail: err.message });
    } finally {
      setChecking((ids) => ids.filter((id) => id !== item.id));
    }
  };

  if (!visible.length) return <>{empty}</>;

  return (
    <>
      <ul className={styles.checklist} ref={list}>
        {visible.map((item) => {
          const ticking = checking.includes(item.id);
          const linked = linkedOf(item);
          const state = dueState(item);
          const owner = ownerName && item.owner_id ? ownerName(item.owner_id) : '';
          return (
            <li key={item.id} className={`todo-row ${ticking ? 'is-checking' : ''}`}>
              <button type="button" className="todo-check always" aria-label={`Mark "${item.subject}" as done`} onClick={() => check(item)} disabled={ticking}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M7.5 12.5l3 3 6-6.5" /></svg>
              </button>
              <span className="todo-icon" aria-hidden="true"><CrmIcon name={kindIcon(item.kind)} size={16} /></span>
              <div className="todo-text">
                <strong>{item.subject}{item.automation_id && <span className="sr-only"> (automated)</span>}</strong>
                <span>
                  {kindName(item.kind)}
                  {linked && <> · <Link href={linked.href} className={styles.checkLinked}>{linked.name}</Link></>}
                  {owner && ` · ${owner}`}
                  {item.automation_id && ' · automated'}
                </span>
              </div>
              <span className="todo-meta">
                <span className={`chip ${styles.dueChip} ${styles[state] || ''}`}>{dueLabel(item)}</span>
                <button type="button" className="ghost small todo-go always" onClick={() => setFinishing(item)}>Add notes</button>
              </span>
            </li>
          );
        })}
      </ul>
      {finishing && (
        <FinishForm activity={finishing} onClose={() => setFinishing(null)} onSaved={async () => {
          const left = visible.filter(({ id }) => id !== finishing.id).length;
          toast.success('Done', { detail: finishing.subject });
          await onChanged();
          if (left === 0) onCleared?.(list.current);
        }} />
      )}
    </>
  );
}

export function ChecklistSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className={styles.checklist} aria-busy="true">
      {Array.from({ length: rows }, (_, n) => (
        <div className="todo-row" key={n}>
          <Skeleton width={22} height={22} radius={999} />
          <Skeleton width={30} height={30} radius={8} />
          <div style={{ flex: 1, display: 'grid', gap: 6 }}><Skeleton width="55%" height={13} /><Skeleton width="35%" height={11} /></div>
          <Skeleton width={70} height={18} radius={999} />
        </div>
      ))}
    </div>
  );
}

// ---------- Record drawer ----------

type Kind = 'deal' | 'contact' | 'lead';
const PATHS: Record<Kind, string> = { deal: 'deal', contact: 'contact', lead: 'lead' };

// Opens a deal, contact or lead over a list: what it is, what happens next, and quick actions.
export function RecordDrawer({ kind, record, onClose, onChanged, ownerName, tags = [] }: {
  kind: Kind;
  record: any | null;
  onClose: () => void;
  onChanged?: () => void;
  ownerName?: (id: string) => string;
  tags?: Tag[];
}) {
  // Keep the last record drawn while the drawer slides out
  const [row, setRow] = useState<any>(record);
  const [activities, setActivities] = useState<any[] | null>(null);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [form, setForm] = useState<'' | 'log' | 'task' | 'plan' | 'email'>('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (record) setRow(record);
  }, [record]);

  const id = row?.id;
  const links: Record<string, string> = id ? { [`${kind}_id`]: id } : {};

  const loadActivities = async (target: string = id) => {
    if (!target) return;
    try {
      const rows = await api.get(`/api/crm/activities?${kind}_id=${target}`);
      if (target === (record?.id || id)) setActivities(rows);
    } catch {
      setActivities([]);
    }
  };

  useEffect(() => {
    if (!record?.id) return;
    setActivities(null);
    setPhone(record.phone || '');
    setEmail(record.email || '');
    loadActivities(record.id);
    // A lead from a summary list has only a few fields, so fetch the rest
    if (kind === 'lead' && record.status === undefined) {
      api.get(`/api/crm/leads/${record.id}`)
        .then((full) => {
          setRow((current: any) => (current?.id === full?.id ? { ...current, ...full } : current));
          setPhone(full?.phone || '');
          setEmail(full?.email || '');
        })
        .catch(() => null);
    }
    // A deal has no phone of its own, so use its contact's
    if (kind === 'deal' && record.contact?.id) {
      api.get(`/api/crm/contacts/${record.contact.id}`)
        .then((contact) => { setPhone(contact?.phone || ''); setEmail(contact?.email || ''); })
        .catch(() => null);
    }
  }, [record?.id]);

  const changed = async () => {
    await loadActivities();
    onChanged?.();
  };

  const open = (activities || []).filter((item) => !item.done_at && item.kind !== 'note')
    .sort((a, b) => String(a.due_on || '9999').localeCompare(String(b.due_on || '9999')) || String(a.due_time || '').localeCompare(String(b.due_time || '')));
  const next = open[0];
  const recent = (activities || []).filter((item) => item.done_at || item.kind === 'note').slice(0, 3);

  const tick = async (item: any) => {
    setBusy(item.id);
    try {
      await finishActivity(item.id);
      toast.success('Done', {
        detail: item.subject,
        action: { label: 'Undo', onClick: () => reopenActivity(item.id).then(changed).catch((err) => toast.error('Could not undo', { detail: err.message })) }
      });
      await changed();
    } catch (err: any) {
      toast.error('Could not mark it done', { detail: err.message });
    } finally {
      setBusy('');
    }
  };

  const name = row ? (kind === 'deal' ? row.title : row.name) : '';
  const subtitle = !row ? '' : kind === 'deal'
    ? [row.company?.name, row.contact?.name].filter(Boolean).join(' · ') || 'Deal'
    : kind === 'contact'
      ? [row.job_title, row.company?.name].filter(Boolean).join(' at ') || 'Contact'
      : [row.job_title, row.company_name].filter(Boolean).join(' at ') || 'Lead';

  const facts: [string, ReactNode][] = !row ? [] : kind === 'deal' ? [
    ['Value', money(row.value)],
    ['Stage', row.stage ? <span className={`badge ${row.stage.kind}`}>{row.stage.name}</span> : '—'],
    ['Expected close', row.expected_close ? formatDate(row.expected_close) : 'Not set'],
    ['Contact', row.contact ? <Link href={`/saas/crm/contact/${row.contact.id}`}>{row.contact.name}</Link> : '—'],
    ['Company', row.company ? <Link href={`/saas/crm/company/${row.company.id}`}>{row.company.name}</Link> : '—'],
    ['Owner', ownerName ? ownerName(row.owner_id) : '—']
  ] : kind === 'contact' ? [
    ['Email', row.email ? <a href={`mailto:${row.email}`}>{row.email}</a> : '—'],
    ['Phone', row.phone ? <a href={`tel:${row.phone}`}>{row.phone}</a> : '—'],
    ['Company', row.company ? <Link href={`/saas/crm/company/${row.company.id}`}>{row.company.name}</Link> : '—'],
    ['Owner', ownerName ? ownerName(row.owner_id) : '—'],
    ['Added', formatDate(row.created_at)]
  ] : [
    ['Status', <span key="s" className={`badge ${statusBadge[row.status]}`}>{statusLabel[row.status]}</span>],
    ['Score', <span key="c">{row.score} <span className={`badge ${scoreBadge(row.score)}`}>{scoreLabel(row.score)}</span></span>],
    ['Email', row.email ? <a href={`mailto:${row.email}`}>{row.email}</a> : '—'],
    ['Phone', row.phone ? <a href={`tel:${row.phone}`}>{row.phone}</a> : '—'],
    ['Source', row.source || '—'],
    ['Owner', ownerName ? ownerName(row.owner_id) : '—']
  ];

  const canWhatsApp = !!whatsappNumber(phone);
  const firstName = kind === 'deal' ? (row?.contact?.name || '').split(' ')[0] : (name || '').split(' ')[0];

  return (
    <>
      <Drawer
        open={!!record}
        title={name}
        subtitle={subtitle}
        onClose={onClose}
        footer={id && (
          <>
            <button type="button" onClick={onClose}>Close</button>
            <Link href={`/saas/crm/${PATHS[kind]}/${id}`} className="button primary always">Open full page<Icon name="arrow-right" size={14} /></Link>
          </>
        )}
      >
        {row && (
          <>
            <section className={styles.section}>
              <div className={styles.drawerHead}>
                <span className={`${styles.avatar} ${styles.small}`} aria-hidden="true">{initials(name)}</span>
                <div style={{ minWidth: 0 }}>
                  {kind === 'deal' && <div className="stat-value" style={{ fontSize: 'var(--text-xl)' }}>{money(row.value)}</div>}
                  {kind !== 'deal' && <TagChips ids={row.tags} tags={tags} />}
                  {kind === 'deal' && row.tags?.length > 0 && <TagChips ids={row.tags} tags={tags} />}
                </div>
              </div>
            </section>

            <section className={styles.section} aria-labelledby="drawer-next">
              <h3 className={styles.sectionTitle} id="drawer-next">Next up</h3>
              {activities === null ? (
                <div className={styles.nextBox}><Skeleton width={28} height={28} radius={999} /><div><Skeleton width="60%" height={13} /><Skeleton width="40%" height={11} /></div></div>
              ) : next ? (
                <div className={styles.nextBox}>
                  <span className="todo-icon" aria-hidden="true"><CrmIcon name={kindIcon(next.kind)} size={16} /></span>
                  <div>
                    <strong>{next.subject}</strong>
                    <span className={dueState(next) === 'overdue' ? 'late small' : 'muted small'}>{kindName(next.kind)} · {dueLabel(next)}</span>
                  </div>
                  <button type="button" className="small" disabled={busy === next.id} onClick={() => tick(next)}>
                    <Icon name="check" size={14} />Done
                  </button>
                </div>
              ) : (
                <div className={styles.nextBox}>
                  <span className="todo-icon" aria-hidden="true"><Icon name="clock" size={16} /></span>
                  <div><strong>Nothing planned yet</strong><span className="muted small">A planned next step keeps things moving.</span></div>
                  <button type="button" className="small" onClick={() => setForm('plan')}>Plan one</button>
                </div>
              )}
              {open.length > 1 && <p className="muted small" style={{ margin: '6px 0 0' }}>{open.length - 1} more planned after this.</p>}
            </section>

            <section className={styles.section} aria-labelledby="drawer-quick">
              <h3 className={styles.sectionTitle} id="drawer-quick">Quick actions</h3>
              <div className={styles.quick}>
                <button type="button" onClick={() => setForm('log')}><CrmIcon name="note" />Log activity</button>
                <button type="button" onClick={() => setForm('task')}><Icon name="check" size={16} />Add task</button>
                {canWhatsApp && (
                  <a className="button always" href={whatsappLink(phone, firstName ? `Hi ${firstName}, ` : '')} target="_blank" rel="noopener noreferrer" title="Opens a WhatsApp chat with this number">
                    <CrmIcon name="whatsapp" />Send on WhatsApp
                  </a>
                )}
                {email && <button type="button" onClick={() => setForm('email')}><CrmIcon name="mail" />Send email</button>}
              </div>
            </section>

            <section className={styles.section} aria-labelledby="drawer-facts">
              <h3 className={styles.sectionTitle} id="drawer-facts">Details</h3>
              <dl className={styles.facts}>
                {facts.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}
              </dl>
            </section>

            {recent.length > 0 && (
              <section className={styles.section} aria-labelledby="drawer-recent">
                <h3 className={styles.sectionTitle} id="drawer-recent">Recent</h3>
                <ul className={styles.recent}>
                  {recent.map((item) => (
                    <li key={item.id}>
                      <span className={`${styles.feedIcon} ${styles.toneGood}`} style={{ width: 26, height: 26 }} aria-hidden="true"><CrmIcon name={kindIcon(item.kind)} size={13} /></span>
                      <div><strong>{item.subject}</strong><div className="muted">{kindName(item.kind)} · {formatDate(item.done_at || item.created_at)}</div></div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </Drawer>

      {form && id && (
        <Above>
          {form === 'log' && <LogForm links={links} onClose={() => setForm('')} onSaved={async () => { toast.success('Logged', { detail: `Added to ${name}` }); await changed(); }} />}
          {(form === 'task' || form === 'plan') && (
            <PlanForm links={links} kind={form === 'task' ? 'task' : 'call'} onClose={() => setForm('')}
              onSaved={async () => { toast.success(form === 'task' ? 'Task added' : 'Planned', { detail: `On ${name}` }); await changed(); }} />
          )}
          {form === 'email' && <EmailForm links={links} onClose={() => { setForm(''); changed(); }} />}
        </Above>
      )}
    </>
  );
}

// The shape of a record page while it loads
export function RecordSkeleton() {
  return (
    <div className="stack" role="status" aria-label="Loading">
      <div className={styles.recordHead}>
        <div className={styles.identity}>
          <Skeleton width={52} height={52} radius={999} />
          <div style={{ display: 'grid', gap: 8, flex: 1 }}>
            <Skeleton width={220} height={24} />
            <div style={{ display: 'flex', gap: 6 }}><Skeleton width={120} height={24} radius={999} /><Skeleton width={90} height={24} radius={999} /><Skeleton width={100} height={24} radius={999} /></div>
          </div>
        </div>
      </div>
      <div className="card"><Skeleton width={140} height={16} /><Skeleton width="100%" height={60} style={{ marginTop: 12 }} /></div>
      <div className="card"><Skeleton width={100} height={16} /><Skeleton width="80%" height={12} style={{ marginTop: 12 }} /><Skeleton width="60%" height={12} style={{ marginTop: 8 }} /></div>
    </div>
  );
}
