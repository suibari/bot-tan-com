/**
 * Shape of the payload broadcast by the biorhythm server's WebSocket at
 * `/ws` (see apps/biorhythm_server/src/manager.ts in bsky-affirmative-bot).
 * Every field is optional here — the site must not break when the bot adds,
 * renames, or omits one.
 */

export type BotStatusName = 'Sleep' | 'WakeUp' | 'Study' | 'FreeTime' | 'Relax';

export interface DailyStats {
  followers?: number;
  likes?: number;
  affirmationCount?: number;
  uniqueAffirmationUserCount?: number;
  fortune?: number;
  cheer?: number;
  analysis?: number;
  dj?: number;
  anniversary?: number;
  answer?: number;
  /** クラウドLLM（Gemini）の呼び出し数。 */
  rpd?: number;
  rpdError?: number;
  /** ローカルLLM（Ollama）の呼び出し数。 */
  localRpd?: number;
  localRpdError?: number;
  /** Start of the current counting window, used to derive per-minute rates. */
  lastInitializedDate?: string;
  /** `[languageCode, count]` pairs. */
  lang?: [string, number][];
  /** AT URI of the post Bot-tan picked as today's recommendation. */
  topPost?: string;
  botComment?: string;
}

export interface TotalStats {
  followers?: number;
  likes?: number;
  affirmationCount?: number;
  reply?: number;
  analysis?: number;
  fortune?: number;
  cheer?: number;
  dj?: number;
  anniversary?: number;
}

/** Nagi-wide activity, counted straight out of the AppView's `nagi` schema. */
export interface NagiStats {
  totalUsers?: number;
  usersAddedYesterday?: number;
  totalReactions?: number;
  totalPosts?: number;
  totalChannels?: number;
}

export type HealthState = 'ok' | 'stale' | 'down' | 'unknown' | 'unconfigured';

/** One probe inside a tile — e.g. the Bluesky half of "Jetstream". */
export interface HealthPart {
  name: string;
  state: HealthState;
  lastOkAt?: string;
  lastError?: string;
}

export interface HealthTileStatus {
  state: HealthState;
  parts?: HealthPart[];
}

/** The four tiles the dashboard shows, each an aggregate of its parts. */
export type HealthTileId = 'jetstream' | 'botServer' | 'localLlm' | 'webSearch';

export type HealthSnapshot = Partial<Record<HealthTileId, HealthTileStatus>> & {
  checkedAt?: string;
};

export interface BotStatusPayload {
  /** 0-100. */
  energy?: number;
  mood?: string;
  mood_en?: string;
  status?: BotStatusName;
  nextStepTime?: string;
  utilities?: Partial<Record<BotStatusName, number>>;
  dailyStats?: DailyStats;
  totalStats?: TotalStats;
  bsky?: { currentFollowers?: number };
  nagi?: NagiStats;
  repoWritePoints?: {
    hour?: { used?: number; limit?: number; windowSeconds?: number };
    day?: { used?: number; limit?: number; windowSeconds?: number };
  };
  health?: HealthSnapshot | null;
  topPost?: TopPostPayload | null;
  memoryImpressions?: MemoryImpressionPayload[];
}

/** A recent public conversation topic, with an optional verified reading. */
export interface MemoryImpressionPayload {
  label: string;
  spokenForm?: string | null;
  occurredAt?: string;
}

/**
 * Today's pick. Bluesky posts arrive as a bare AT URI and are resolved against
 * the public AppView; Nagi posts cannot be, so the server sends the fields
 * needed to render them.
 */
export interface TopPostPayload {
  uri: string;
  comment?: string;
  network?: 'bsky' | 'nagi';
  text?: string;
  createdAt?: string;
  authorHandle?: string;
  authorDisplayName?: string;
  authorAvatarCid?: string;
  authorDid?: string;
  rkey?: string;
}

export interface FollowerPoint {
  date: string;
  count: number;
}

const WS_URL = import.meta.env.PUBLIC_BOT_WS_URL ?? 'wss://bot-tan.suibari.com/ws';
const FOLLOWER_API_URL =
  import.meta.env.PUBLIC_FOLLOWER_API_URL ??
  'https://bottan-measurement-worker.404-not-found-address.workers.dev/';

/**
 * Trends and the activity timeline are pulled over plain HTTP rather than the
 * socket: they are historical, so re-sending them on every status frame would
 * make each frame many times larger for data that changes once a day.
 */
const HISTORY_API_URL =
  import.meta.env.PUBLIC_HISTORY_API_URL ?? 'https://bot-tan.suibari.com/history';
const TIMELINE_API_URL =
  import.meta.env.PUBLIC_TIMELINE_API_URL ?? 'https://bot-tan.suibari.com/timeline';

/** In dev the biorhythm server usually runs locally without TLS. */
function resolveWsUrl(): string {
  if (import.meta.env.PROD) return WS_URL;
  return import.meta.env.PUBLIC_BOT_WS_URL ?? 'ws://localhost:3000/ws';
}

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'error';

export interface ConnectOptions {
  onMessage: (data: BotStatusPayload) => void;
  onStateChange: (state: ConnectionState) => void;
}

/**
 * Connects to the bot's status feed and keeps trying if the socket drops.
 * The original portfolio implementation gave up after the first disconnect;
 * this one backs off exponentially up to 30s and reconnects indefinitely.
 */
export function connectBotStatus({ onMessage, onStateChange }: ConnectOptions): () => void {
  let socket: WebSocket | null = null;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const open = () => {
    if (disposed) return;
    onStateChange('connecting');

    try {
      socket = new WebSocket(resolveWsUrl());
    } catch {
      onStateChange('error');
      scheduleRetry();
      return;
    }

    socket.onopen = () => {
      retries = 0;
      onStateChange('open');
    };

    socket.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data) as BotStatusPayload);
      } catch {
        // A malformed frame is not worth tearing the connection down for.
      }
    };

    socket.onerror = () => onStateChange('error');

    socket.onclose = () => {
      if (disposed) return;
      onStateChange('closed');
      scheduleRetry();
    };
  };

  const scheduleRetry = () => {
    if (disposed) return;
    clearTimeout(retryTimer);
    // Exponential backoff with jitter, so that a bot-server restart does not
    // bring every open tab back in lockstep.
    const base = Math.min(30_000, 2000 * 2 ** retries);
    const delay = base * (0.7 + Math.random() * 0.6);
    retries += 1;
    retryTimer = setTimeout(open, delay);
  };

  open();

  return () => {
    disposed = true;
    clearTimeout(retryTimer);
    socket?.close();
  };
}

/** Historical follower counts, from the Cloudflare measurement worker. */
export async function fetchFollowerHistory(): Promise<FollowerPoint[]> {
  try {
    const response = await fetch(FOLLOWER_API_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: unknown = await response.json();
    if (!Array.isArray(data)) return [];

    // The measurement worker can retain the timestamp even when its Bluesky
    // profile lookup fails. Do not hand those incomplete rows to Chart.js.
    return data.flatMap((point): FollowerPoint[] => {
      if (!point || typeof point !== 'object') return [];
      const { date, count } = point as Partial<FollowerPoint>;
      return typeof date === 'string' && typeof count === 'number' && Number.isFinite(count) ? [{ date, count }] : [];
    });
  } catch (error) {
    console.error('Failed to fetch follower history:', error);
    return [];
  }
}

/** One day's frozen counters, as stored by the nightly snapshot. */
export interface DailyMetricPoint {
  date: string;
  metrics?: {
    bsky?: Record<string, number>;
    nagi?: Record<string, number>;
    common?: Record<string, number>;
  };
}

export interface HistoryPayload {
  daily: DailyMetricPoint[];
  /** Nagi user counts, reconstructed from profile creation dates. */
  nagiUsers: { date: string; count: number }[];
  /** Nagi channel counts, reconstructed from channel creation dates. */
  nagiChannels: { date: string; count: number }[];
  /** Hourly reaction and post counts for the last 168 hours. */
  nagiHourly: { hour: string; reactions: number; posts: number }[];
}

/** Trend data for the sparklines and the two history charts. */
export async function fetchHistory(days = 90): Promise<HistoryPayload> {
  try {
    const endpoint = new URL(HISTORY_API_URL);
    endpoint.searchParams.set('days', String(days));

    const response = await fetch(endpoint);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as Partial<HistoryPayload>;
    return {
      daily: Array.isArray(data.daily) ? data.daily : [],
      nagiUsers: Array.isArray(data.nagiUsers) ? data.nagiUsers : [],
      nagiChannels: Array.isArray(data.nagiChannels) ? data.nagiChannels : [],
      nagiHourly: Array.isArray(data.nagiHourly) ? data.nagiHourly : [],
    };
  } catch (error) {
    console.error('Failed to fetch history:', error);
    return { daily: [], nagiUsers: [], nagiChannels: [], nagiHourly: [] };
  }
}

/** One stretch of the day Bot-tan spent in a single state. */
export interface TimelineSegment {
  start: string;
  end: string;
  status: BotStatusName;
  mood: string;
  moodEn: string;
  energy: number;
}

export interface TimelineEvent {
  at: string;
  type: string;
}

export interface TimelinePayload {
  date: string;
  segments: TimelineSegment[];
  events: TimelineEvent[];
}

/**
 * A single day of activity. `date` is a JST `YYYY-MM-DD`; the server refuses
 * anything older than a week, so the pager must not offer more than that.
 */
export async function fetchTimeline(date?: string): Promise<TimelinePayload | null> {
  try {
    const endpoint = new URL(TIMELINE_API_URL);
    if (date) endpoint.searchParams.set('date', date);

    const response = await fetch(endpoint);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as Partial<TimelinePayload>;
    return {
      date: data.date ?? date ?? '',
      segments: Array.isArray(data.segments) ? data.segments : [],
      events: Array.isArray(data.events) ? data.events : [],
    };
  } catch (error) {
    console.error('Failed to fetch timeline:', error);
    return null;
  }
}

export interface RecommendedPost {
  text: string;
  authorHandle: string;
  authorAvatar?: string;
  createdAt: string;
  url: string;
  network: 'bsky' | 'nagi';
}

const NAGI_APPVIEW_URL =
  import.meta.env.PUBLIC_NAGI_APPVIEW_URL ?? 'https://nagi-api.suibari.com';
const NAGI_WEB_URL = import.meta.env.PUBLIC_NAGI_WEB_URL ?? 'https://nagi.suibari.com';

/**
 * Turns today's pick into something renderable, whichever network it came from.
 *
 * Nagi posts arrive already populated — the AppView needs a service-auth JWT
 * for most reads and is not configured to accept this origin, so the biorhythm
 * server sends the fields along instead. Only the avatar is fetched directly,
 * as an `<img>`, which is not subject to CORS.
 */
export async function resolveTopPost(top: TopPostPayload): Promise<RecommendedPost | null> {
  if (top.network === 'nagi') {
    if (!top.authorDid || !top.rkey) return null;
    return {
      text: top.text ?? '',
      authorHandle: top.authorHandle ?? top.authorDisplayName ?? top.authorDid,
      authorAvatar: top.authorAvatarCid
        ? `${NAGI_APPVIEW_URL}/api/blob/${encodeURIComponent(top.authorDid)}/${encodeURIComponent(top.authorAvatarCid)}`
        : undefined,
      createdAt: top.createdAt ?? new Date().toISOString(),
      url: `${NAGI_WEB_URL}/thread/${encodeURIComponent(top.authorDid)}/${encodeURIComponent(top.rkey)}`,
      network: 'nagi',
    };
  }

  return fetchPost(top.uri);
}

/**
 * Resolves an AT URI to a displayable post via the public AppView.
 *
 * Deliberately a plain `fetch` rather than `@atproto/api` — this one endpoint
 * is all the site needs, and the SDK would add hundreds of kilobytes.
 */
export async function fetchPost(uri: string): Promise<RecommendedPost | null> {
  try {
    const endpoint = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts');
    endpoint.searchParams.set('uris', uri);

    const response = await fetch(endpoint);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as {
      posts?: {
        uri: string;
        author: { handle: string; avatar?: string };
        record?: { text?: string; createdAt?: string };
      }[];
    };

    const post = data.posts?.[0];
    if (!post) return null;

    const rkey = post.uri.split('/').pop();

    return {
      text: post.record?.text ?? '',
      authorHandle: post.author.handle,
      authorAvatar: post.author.avatar,
      createdAt: post.record?.createdAt ?? new Date().toISOString(),
      url: `https://bsky.app/profile/${post.author.handle}/post/${rkey}`,
      network: 'bsky',
    };
  } catch (error) {
    console.error('Failed to fetch post:', error);
    return null;
  }
}
