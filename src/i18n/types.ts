export const LOCALES = ['ja', 'en', 'sv'] as const;
export type Lang = (typeof LOCALES)[number];

/** Bot-tan's utility-AI states, as emitted by the biorhythm server. */
export const STATUSES = ['Sleep', 'WakeUp', 'Study', 'FreeTime', 'Relax'] as const;
export type Status = (typeof STATUSES)[number];

/** The four things the liveness strip watches, each an aggregate of probes. */
export const HEALTH_TILES = ['jetstream', 'botServer', 'localLlm', 'gemini'] as const;
export type HealthTileId = (typeof HEALTH_TILES)[number];

export const HEALTH_STATES = ['ok', 'stale', 'down', 'unknown', 'unconfigured'] as const;
export type HealthStateId = (typeof HEALTH_STATES)[number];

/**
 * Interaction types the timeline marks. Kept in step with TIMELINE_EVENT_TYPES
 * in the biorhythm server's publicApi.ts.
 */
export const TIMELINE_EVENTS = [
  'fortune',
  'cheer',
  'analysis',
  'dj',
  'anniversary',
  'answer',
  'recap',
] as const;

export interface ProfileRow {
  label: string;
  value: string;
}

export interface CharacterCopy {
  /** Heading emoji, e.g. 🦋 */
  emoji: string;
  name: string;
  /** One-line epithet shown under the name. */
  tagline: string;
  profileHeading: string;
  profile: ProfileRow[];
  personalityHeading: string;
  /** Rendered as separate paragraphs. */
  personality: string[];
  imageAlt: string;
}

export type LinkId =
  | 'nagi'
  | 'bluesky'
  | 'room'
  | 'labeler'
  | 'discord'
  | 'diary'
  | 'youtube'
  | 'patreon'
  | 'fanbox'
  | 'github';

export interface LinkCopy {
  /** Selects the artwork in Links.astro; not shown to the reader. */
  id: LinkId;
  /** Fallback mark for links with no artwork. */
  emoji: string;
  title: string;
  description: string;
  href: string;
}

export interface Dictionary {
  meta: {
    title: string;
    description: string;
    ogAlt: string;
  };

  nav: {
    about: string;
    dashboard: string;
    friends: string;
    links: string;
    /** Label of the *other* language, used on the toggle button. */
    switchTo: string;
    skipToContent: string;
  };

  hero: {
    /** Rendered as separate lines inside a blockquote. */
    catch: string[];
    subtitle: string;
    scrollHint: string;
    imageAlt: string;
    cta: string;
  };

  about: {
    heading: string;
    lead: string;
    character: CharacterCopy;
    /** Extra "did you know" notes rendered as taped-on sticky notes. */
    notes: { emoji: string; text: string }[];
    snsHeading: string;
  };

  dashboard: {
    heading: string;
    statsHeading: string;
    lead: string;
    liveLabel: string;
    jstLabel: string;
    connection: {
      connecting: string;
      open: string;
      closed: string;
      error: string;
    };
    mood: {
      heading: string;
      nextLabel: string;
      statusLabels: Record<Status, string>;
      statusHeading: string;
    };
    energy: {
      label: string;
      /** Screen-reader description of the meter, e.g. "Energy: 62%". */
      aria: string;
    };
    health: {
      heading: string;
      tiles: Record<HealthTileId, string>;
      states: Record<HealthStateId, string>;
      /** Toggle that reveals the per-probe breakdown. */
      detailLabel: string;
      lastOkLabel: string;
    };
    timeline: {
      heading: string;
      /** Legend/axis furniture. */
      energyLabel: string;
      nowLabel: string;
      empty: string;
      error: string;
      previousDay: string;
      nextDay: string;
      today: string;
      /** Accessible name for the segment buttons: "{time}, {status}". */
      segmentAria: string;
      tableLabel: string;
      tableHeaders: { time: string; status: string; mood: string; energy: string };
      eventLabels: Record<string, string>;
    };
    common: {
      aiRequests: string;
      aiErrorRate: string;
      rateLimitHour: string;
      rateLimitDay: string;
      rateUsage: string;
    };
    bsky: {
      heading: string;
      currentFollowers: string;
      likes: string;
      affirmations: string;
      affirmedUsers: string;
      fortune: string;
      cheer: string;
      analysis: string;
      dj: string;
      anniversary: string;
      answer: string;
    };
    nagi: {
      heading: string;
      totalUsers: string;
      totalReactions: string;
      totalPosts: string;
      totalChannels: string;
    };
    /** Previous calendar day's increase, shown under a current total. */
    previousDayIncrease: string;
    charts: {
      followerHistory: string;
      followerHistoryX: string;
      followerHistoryY: string;
      nagiUserHistory: string;
      nagiUserHistoryY: string;
      nagiActivityHistory: string;
      nagiActivityReactions: string;
      nagiActivityPosts: string;
      nagiChannelHistory: string;
      nagiChannelHistoryY: string;
      langBreakdown: string;
      langCount: string;
      /** Bucket label for the long tail of minor languages. */
      langOther: string;
      empty: string;
    };
    topPost: {
      heading: string;
      commentLabel: string;
      empty: string;
      error: string;
      networkLabels: { bsky: string; nagi: string };
    };
    learnedThings: {
      heading: string;
      empty: string;
      /** Accessible label for a tag link. Supports the {label} placeholder. */
      searchLabel: string;
    };
    /** Shown when the WebSocket never connects. */
    offline: string;
  };

  friends: {
    heading: string;
    lead: string;
    characters: CharacterCopy[];
    morpho: {
      emoji: string;
      name: string;
      text: string;
    };
  };

  links: {
    heading: string;
    lead: string;
    primary: LinkCopy[];
    secondaryHeading: string;
    secondary: LinkCopy[];
  };

  footer: {
    madeBy: string;
    authorName: string;
    authorHref: string;
    specialThanksTitle: string;
    translationProofreading: string;
    supporters: string;
    backToTop: string;
  };
}
