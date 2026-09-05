/**
 * The public memory graph, served by the biorhythm server's `/memory-graph`
 * (see apps/biorhythm_server/src/publicApi.ts in bsky-affirmative-bot).
 *
 * The endpoint only ever returns impression labels and their aggregates — no
 * conversation text, no post URIs, no author identifiers. That is enforced on
 * the server (packages/database/src/botMemoryGraph.ts); nothing here can widen
 * it, and nothing here should try to.
 *
 * Like `botStatus.ts`, every function swallows its errors and returns an empty
 * graph. A backend that is down must leave the page standing.
 */

export type MemoryNodeKind = 'work' | 'word';
export type MemoryRelation = 'recommended' | 'liked' | 'discussed';

export interface MemoryNode {
  /** Case-folded label. Edges reference this. */
  id: string;
  label: string;
  /** Reading, when Bot-tan has learned how to say it out loud. */
  spokenForm: string | null;
  kind: MemoryNodeKind;
  relation: MemoryRelation;
  /** How many separate conversations this came up in. */
  occurrences: number;
  latestAt: string;
  /** Impression, 0–100. `null` means the scorer has not reached it yet. */
  salience: number | null;
  scoredCount: number;
}

export type MemoryEdge =
  | { source: string; target: string; type: 'cooccurrence'; weight: number }
  | { source: string; target: string; type: 'similarity'; similarity: number };

export interface MemoryGraph {
  generatedAt: string;
  windowDays: number;
  /** False when the server could not build embedding centroids. */
  similarityAvailable: boolean;
  nodes: MemoryNode[];
  edges: MemoryEdge[];
}

const MEMORY_GRAPH_API_URL =
  import.meta.env.PUBLIC_MEMORY_GRAPH_API_URL ?? 'https://bot-tan.suibari.com/memory-graph';

export const EMPTY_MEMORY_GRAPH: MemoryGraph = {
  generatedAt: '',
  windowDays: 0,
  similarityAvailable: false,
  nodes: [],
  edges: [],
};

const KINDS: MemoryNodeKind[] = ['work', 'word'];
const RELATIONS: MemoryRelation[] = ['recommended', 'liked', 'discussed'];

/**
 * Rebuild the payload field by field rather than trusting it.
 *
 * The server is the one that decides what is safe to publish, but the renderer
 * still has to survive a half-deployed one: a node without an `id` would sit in
 * the simulation forever as `NaN` coordinates and take the whole canvas with it.
 */
function parseNode(value: unknown): MemoryNode | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const label = typeof raw.label === 'string' ? raw.label : '';
  if (!id || !label) return null;

  const occurrences = Number(raw.occurrences);
  const salience = raw.salience === null || raw.salience === undefined ? null : Number(raw.salience);

  return {
    id,
    label,
    spokenForm: typeof raw.spokenForm === 'string' ? raw.spokenForm : null,
    kind: KINDS.includes(raw.kind as MemoryNodeKind) ? (raw.kind as MemoryNodeKind) : 'word',
    relation: RELATIONS.includes(raw.relation as MemoryRelation)
      ? (raw.relation as MemoryRelation)
      : 'discussed',
    occurrences: Number.isFinite(occurrences) ? occurrences : 0,
    latestAt: typeof raw.latestAt === 'string' ? raw.latestAt : '',
    salience: salience !== null && Number.isFinite(salience) ? salience : null,
    scoredCount: Number.isFinite(Number(raw.scoredCount)) ? Number(raw.scoredCount) : 0,
  };
}

function parseEdge(value: unknown, known: Set<string>): MemoryEdge | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const source = typeof raw.source === 'string' ? raw.source : '';
  const target = typeof raw.target === 'string' ? raw.target : '';
  // An edge to a node that never arrived would anchor the layout to nothing.
  if (!source || !target || source === target) return null;
  if (!known.has(source) || !known.has(target)) return null;

  if (raw.type === 'similarity') {
    const similarity = Number(raw.similarity);
    if (!Number.isFinite(similarity)) return null;
    return { source, target, type: 'similarity', similarity };
  }
  const weight = Number(raw.weight);
  return { source, target, type: 'cooccurrence', weight: Number.isFinite(weight) ? weight : 1 };
}

export function parseMemoryGraph(data: unknown): MemoryGraph {
  if (typeof data !== 'object' || data === null) return EMPTY_MEMORY_GRAPH;
  const raw = data as Record<string, unknown>;

  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : [])
    .map(parseNode)
    .filter((node): node is MemoryNode => node !== null);
  const known = new Set(nodes.map((node) => node.id));
  const edges = (Array.isArray(raw.edges) ? raw.edges : [])
    .map((edge) => parseEdge(edge, known))
    .filter((edge): edge is MemoryEdge => edge !== null);

  return {
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    windowDays: Number.isFinite(Number(raw.windowDays)) ? Number(raw.windowDays) : 0,
    similarityAvailable: raw.similarityAvailable === true,
    nodes,
    edges,
  };
}

export async function fetchMemoryGraph(): Promise<MemoryGraph> {
  try {
    const response = await fetch(MEMORY_GRAPH_API_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseMemoryGraph(await response.json());
  } catch (error) {
    console.error('Failed to fetch memory graph:', error);
    return EMPTY_MEMORY_GRAPH;
  }
}
