import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anon) {
  // Don't throw — let the app render with a friendly empty state instead.
  // Console will hint at the cause.
  // eslint-disable-next-line no-console
  console.warn('[supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in env.');
}

export const supabase = createClient(url ?? '', anon ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'globe-music-auth',
  },
  realtime: {
    params: { eventsPerSecond: 5 },
  },
});

// ---- DB <-> UI mapping helpers ----------------------------------------------
// DB columns are snake_case; UI uses camelCase. Centralize the conversion so
// the rest of the app stays in one shape.

export function rowToPost(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id ?? null,
    isSeed: !!row.is_seed,
    handle: row.handle,
    lat: Number(row.lat),
    lng: Number(row.lng),
    city: row.city,
    hood: row.hood,
    trackName: row.track_name,
    artistName: row.artist_name,
    service: row.service,
    videoId: row.video_id ?? '',
    link: row.link ?? '',
    vibeNote: row.vibe_note ?? '',
    createdAt: row.created_at,
  };
}

export function postToRow(p, ownerId) {
  return {
    owner_id: ownerId ?? null,
    handle: p.handle,
    lat: p.lat,
    lng: p.lng,
    city: p.city,
    hood: p.hood,
    track_name: p.trackName,
    artist_name: p.artistName,
    service: p.service,
    video_id: p.videoId ?? '',
    link: p.link ?? '',
    vibe_note: p.vibeNote ?? '',
  };
}

// "hours ago" used by the UI — derived from created_at.
export function hoursAgo(createdAt) {
  if (!createdAt) return 0;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return 0;
  const diff = (Date.now() - t) / 1000 / 60 / 60;
  return Math.max(0, diff);
}
