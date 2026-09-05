// Ships as plain JS with no bundled types; it registers itself with Chart.js
// as a side effect and exposes nothing we call directly.
declare module 'chartjs-adapter-date-fns';

interface ImportMetaEnv {
  /** WebSocket endpoint of the bot's biorhythm server. */
  readonly PUBLIC_BOT_WS_URL?: string;
  /** HTTP endpoint returning the follower-count history. */
  readonly PUBLIC_FOLLOWER_API_URL?: string;
  /** Daily/trend history, served by the biorhythm server. */
  readonly PUBLIC_HISTORY_API_URL?: string;
  /** One day of activity segments and event markers. */
  readonly PUBLIC_TIMELINE_API_URL?: string;
  /** Nagi's AppView, used only for avatar blobs. */
  readonly PUBLIC_NAGI_APPVIEW_URL?: string;
  /** Nagi's web client, used only to build post permalinks. */
  readonly PUBLIC_NAGI_WEB_URL?: string;
  /** The public memory graph behind /memory. */
  readonly PUBLIC_MEMORY_GRAPH_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
