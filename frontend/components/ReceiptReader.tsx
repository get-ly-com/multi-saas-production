import { useRef, useState } from 'react';
import Icon from '@/components/Icon';
import Skeleton from '@/components/Skeleton';
import { api, money } from '@/lib/api';
import useSubmit from '@/lib/useSubmit';

export type ReceiptFields = {
  vendor: string | null;
  date: string | null;
  total: number | null;
  currency: string | null;
  tax: number | null;
};

const amount = (value: number, currency: string | null) => {
  try {
    return currency ? money(value, currency) : String(value);
  } catch {
    return `${value} ${currency}`;
  }
};

const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// The picture is sent as text, which is a third bigger; this keeps the request well under the 2 MB limit
const MAX_SENT = 1_500_000;

const loadImage = (file: File) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That picture couldn’t be opened. Try a JPEG, PNG or WebP photo.'));
    };
    image.src = url;
  });

// Shrinks the photo on this device, so only a small JPEG is sent
const shrink = async (file: File) => {
  const image = await loadImage(file);
  let side = 1800;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const scale = Math.min(1, side / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) break;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', attempt < 3 ? 0.85 - attempt * 0.1 : 0.6).split(',')[1] || '';
    if (data && data.length <= MAX_SENT) return data;
    if (attempt >= 2) side = Math.round(side * 0.8);
  }
  throw new Error('That picture is too large to read. Try a smaller photo.');
};

// "Read receipt": a photo of a receipt fills in the form. Nothing is saved until the form is.
export default function ReceiptReader({ onRead }: { onRead: (fields: ReceiptFields, file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const { busy, run } = useSubmit();
  const [error, setError] = useState('');
  const [read, setRead] = useState<ReceiptFields | null>(null);

  const choose = (file: File | null | undefined) => {
    if (input.current) input.current.value = '';
    if (!file) return;
    setError('');
    setRead(null);
    if (!TYPES.includes(file.type)) {
      setError('Choose a JPEG, PNG or WebP photo of the receipt.');
      return;
    }
    run(async () => {
      try {
        const image = await shrink(file);
        const fields: ReceiptFields = await api.post('/api/analytics/assistant/receipt', { image });
        setRead(fields);
        onRead(fields, file);
      } catch (err: any) {
        setError(err.message);
      }
    });
  };

  return (
    <div style={{ margin: '0 0 12px', display: 'grid', gap: 8 }}>
      <input ref={input} type="file" accept={TYPES.join(',')} hidden onChange={(e) => choose(e.target.files?.[0])} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" className="always" disabled={busy} onClick={() => input.current?.click()} aria-busy={busy}>
          <Icon name={busy ? 'clock' : 'sparkle'} size={16} />
          {busy ? 'Reading receipt…' : 'Read receipt'}
        </button>
        {!read && !error && !busy && <span className="muted small">Take or choose a photo and we&apos;ll fill in what we can.</span>}
        {busy && <span style={{ flex: '1 1 160px', maxWidth: 240 }} aria-hidden="true"><Skeleton height={10} radius={999} /></span>}
      </div>
      {read && (
        <p className="notice" style={{ margin: 0 }}>
          Filled in from the receipt{read.vendor ? ` from ${read.vendor}` : ''}
          {read.total !== null ? `: ${amount(read.total, read.currency)}` : ''}
          {read.tax ? ` including ${amount(read.tax, read.currency)} tax` : ''}. Please check it before saving.
        </p>
      )}
      {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}
