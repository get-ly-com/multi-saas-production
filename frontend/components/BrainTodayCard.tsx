import Link from 'next/link';
import { useEffect, useState } from 'react';
import Icon from '@/components/Icon';
import { cachedGet } from '@/lib/cache';
import { plural } from '@/lib/format';
import s from '@/styles/brain.module.css';

// The small "Brain has N ideas for you" card on Today. Hidden when there is nothing waiting
// or the Brain can't be reached, so Today never shows a broken tile.
export default function BrainTodayCard() {
  const [waiting, setWaiting] = useState<number | null>(null);

  useEffect(() => {
    let current = true;
    cachedGet('/api/brain/proposals?status=open&limit=50')
      .then((rows) => current && setWaiting(Array.isArray(rows) ? rows.length : 0))
      .catch(() => current && setWaiting(0));
    return () => { current = false; };
  }, []);

  if (!waiting) return null;

  return (
    <Link href="/saas/brain" className={s.todayCard}>
      <span className={s.todayIcon} aria-hidden="true"><Icon name="brain" size={18} /></span>
      <span className={s.todayText}>
        <strong>Brain has {plural(waiting, 'idea')} for you</strong>
        <span>Based on your own numbers. Nothing happens until you approve.</span>
      </span>
      <Icon name="chevron-right" size={16} className={s.todayChevron} />
    </Link>
  );
}
