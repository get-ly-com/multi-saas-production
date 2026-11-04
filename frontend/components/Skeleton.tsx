import { CSSProperties } from 'react';

// Grey shapes that shimmer while something loads. Size them like the real content,
// so nothing jumps when it arrives. The shimmer stops for people who ask for less motion.
//   <Skeleton width={120} height={14} />
//   <SkeletonText lines={3} />
//   <SkeletonStats count={4} />
//   <SkeletonTable rows={6} columns={5} />

export default function Skeleton({ width = '100%', height = 14, radius, style, className }: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  style?: CSSProperties;
  className?: string;
}) {
  return <span className={`skeleton ${className || ''}`} aria-hidden="true" style={{ width, height, borderRadius: radius, ...style }} />;
}

export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton-text" aria-hidden="true">
      {Array.from({ length: lines }, (_, n) => <Skeleton key={n} width={n === lines - 1 ? '62%' : '100%'} />)}
    </div>
  );
}

export function SkeletonStats({ count = 4 }: { count?: number }) {
  return (
    <div className="stats" aria-hidden="true">
      {Array.from({ length: count }, (_, n) => (
        <div className="card" key={n}>
          <Skeleton width="45%" height={12} />
          <Skeleton width="70%" height={24} style={{ marginTop: 10 }} />
        </div>
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 6, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="card skeleton-table" aria-hidden="true">
      {Array.from({ length: rows + 1 }, (_, row) => (
        <div className="skeleton-row" key={row} style={{ gridTemplateColumns: `2fr repeat(${columns - 1}, 1fr)` }}>
          {Array.from({ length: columns }, (_, col) => (
            <Skeleton key={col} height={row === 0 ? 10 : 12} width={row === 0 ? '50%' : col === 0 ? '80%' : '60%'} />
          ))}
        </div>
      ))}
    </div>
  );
}

// The page while the account is first checked: what the real page will look like, greyed
export function SkeletonPage() {
  return (
    <div className="stack" role="status" aria-label="Loading">
      <div className="page-head">
        <div style={{ display: 'grid', gap: 8, width: '100%' }}>
          <Skeleton width={110} height={12} />
          <Skeleton width={260} height={26} />
        </div>
      </div>
      <SkeletonStats count={4} />
      <SkeletonTable rows={6} columns={5} />
    </div>
  );
}
