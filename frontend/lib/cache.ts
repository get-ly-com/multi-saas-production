import { api } from '@/lib/api';

// One GET shared by everyone who asks for it within a short time. The Today page,
// the setup checklist and the command palette all read the same lists, so each is
// fetched once. Failures are never kept, so the next ask tries again.
const kept = new Map<string, { at: number; value: Promise<any> }>();

export const cachedGet = (path: string, maxAgeMs = 30_000) => {
  const hit = kept.get(path);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;
  const value = api.get(path).catch((err) => {
    kept.delete(path);
    throw err;
  });
  kept.set(path, { at: Date.now(), value });
  return value;
};

export const forget = (prefix = '') => {
  for (const key of Array.from(kept.keys())) if (key.startsWith(prefix)) kept.delete(key);
};
