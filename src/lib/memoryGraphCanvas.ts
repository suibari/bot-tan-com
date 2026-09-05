/**
 * The wireframe space at `/memory`: a force layout of Bot-tan's memory,
 * drawn on a 2D canvas you can pan, zoom and pull apart with your hands.
 *
 * `d3-force` does the physics and nothing else — every mark here is hand-drawn
 * so the page can look like a schematic rather than a chart library's default.
 * The module holds no DOM beyond the canvas it is handed; the page component
 * owns the HUD, the readout and the list view.
 *
 * ## World space, not canvas space
 *
 * The layout lives in a world sized by how many memories there are, and the
 * canvas is a window onto it. That is what lets a phone show all 120 nodes at
 * a readable size — you move the window instead of shrinking the graph. Node
 * coordinates, hit tests and the physics are all in world units; strokes and
 * labels are drawn in screen units so the wireframe stays a hairline at every
 * zoom.
 *
 * ## Visual encoding
 *
 *   occurrences           → node radius, log-scaled
 *   impression (salience) → how solidly the node is filled; unscored nodes are
 *                           hollow with a dashed ring, so "not judged yet"
 *                           never reads as "judged boring"
 *   freshness (latestAt)  → opacity; old memories sink into the grid
 *   kind                  → shape (polygon / circle) AND hue, never hue alone
 *   co-occurrence edge    → solid, thickness by weight
 *   similarity edge       → dashed, opacity by similarity
 *
 * Radius deliberately carries *occurrences* rather than impression. Impression
 * is the more interesting number, but it arrives asynchronously and the whole
 * back catalogue is unscored: sizing by it made every node identical, and a
 * field of identical circles under uniform repulsion crystallises into a
 * lattice — the layout stopped saying anything at all. Occurrences is always
 * populated and spans three orders of magnitude, so it is what the size
 * channel can honestly carry.
 */
import type { MemoryEdge, MemoryGraph, MemoryNode } from './botMemoryGraph';
import {
  EDGE_COLOR,
  FRESHNESS_FADE_DAYS,
  FRESHNESS_FULL_DAYS,
  FRESHNESS_MIN_ALPHA,
  GRID_COLOR,
  HIGHLIGHT,
  KIND_COLORS,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
} from './memoryTheme';

type Simulation = import('d3-force').Simulation<SimNode, SimEdge>;

interface LabelCandidate {
  node: SimNode;
  isFocus: boolean;
  related: boolean;
  x: number;
  y: number;
}

interface SimNode extends MemoryNode {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  /** Drawn radius in world units, derived once per data update. */
  radius: number;
  /** 0–1, derived from `latestAt`. */
  freshness: number;
  /** When this node first appeared, for the arrival animation. */
  bornAt: number;
  /** How many edges touch this node. Drives how hard it is pulled inward. */
  degree: number;
  /** Label width in px at the base font size, measured once per payload. */
  labelWidth: number;
}

interface SimEdge {
  source: SimNode | string;
  target: SimNode | string;
  type: MemoryEdge['type'];
  /** Normalised 0–1 strength, whatever the edge type. */
  strength: number;
}

const MIN_RADIUS = 4;
const MAX_RADIUS = 20;
/** Where the radius scale tops out. Beyond this, more mentions look the same. */
const RADIUS_SATURATION = 200;

const LABEL_FONT = "'DotGothic16', monospace";
const LABEL_SIZE = 12;
const FOCUS_LABEL_SIZE = 13;

/* Reused so the hot draw loops never allocate a dash array per mark. */
const DASH_NONE: number[] = [];
const DASH_SIMILARITY = [3, 5];
const DASH_UNSCORED = [2, 3];

/**
 * How many labels to place in one frame.
 *
 * Placement is greedy with a collision test, so the cost grows with the square
 * of what has already been placed. Past this many the canvas is full anyway
 * and every further candidate is rejected — paying to discover that on every
 * frame is what took the frame rate down at a thousand nodes.
 */
const LABEL_BUDGET = 160;

/** New nodes flare for this long before settling into the wireframe. */
const ARRIVAL_MS = 2600;

/**
 * How much world each memory gets.
 *
 * Generous on purpose: the window can move, so there is no reason to crowd.
 * This is what decides whether the space reads as a constellation or a list.
 */
const WORLD_AREA_PER_NODE = 15_000;
const MIN_WORLD_SIDE = 620;

/*
 * Low enough that the whole world always fits on the first frame, however big
 * memory gets. The opening view is the overview, so the floor is set by what
 * `fit()` needs rather than by what stays comfortable to read.
 */
const MIN_SCALE = 0.1;
const MAX_SCALE = 2.6;
/** Below this much pointer travel, a press is a click and not a drag. */
const CLICK_SLOP = 4;

export interface MemoryGraphCounts {
  nodes: number;
  edges: number;
  /** Of those edges, how many are the embedding-similarity kind. */
  similarEdges: number;
}

export interface MemoryGraphView {
  /** Swap in a new payload, keeping the positions of nodes that survived. */
  update(graph: MemoryGraph): void;
  /** Restrict the drawing to labels matching this text. Empty clears it. */
  setFilter(query: string): void;
  /** The node picked by the list view, or null to clear. */
  select(id: string | null): void;
  /** Centre the window on a node without changing zoom. */
  focusOn(id: string): void;
  zoomBy(factor: number): void;
  /** Frame the whole world. */
  fit(): void;
  resize(): void;
  destroy(): void;
}

export interface MemoryGraphViewOptions {
  canvas: HTMLCanvasElement;
  /** Called whenever the hovered/selected node changes. */
  onSelect(node: MemoryNode | null): void;
  /** Called when the payload changes, so the HUD can report it. */
  onCountChange(counts: MemoryGraphCounts): void;
  /** True when the viewer asked for reduced motion. */
  reducedMotion: boolean;
}

/**
 * Newer memories are drawn brighter. The curve is flat for the first week —
 * everything from "the last few days" should look equally present — then
 * fades to a floor rather than to nothing, because a node you cannot see is
 * a node you cannot click.
 */
export function freshnessOf(latestAt: string, now: number): number {
  const at = Date.parse(latestAt);
  if (!Number.isFinite(at)) return FRESHNESS_MIN_ALPHA;
  const ageDays = Math.max(0, (now - at) / 86_400_000);
  if (ageDays <= FRESHNESS_FULL_DAYS) return 1;
  const span = FRESHNESS_FADE_DAYS - FRESHNESS_FULL_DAYS;
  const decayed = 1 - (ageDays - FRESHNESS_FULL_DAYS) / span;
  return Math.max(FRESHNESS_MIN_ALPHA, Math.min(1, decayed));
}

/**
 * How often a word came up drives the radius, on a log scale — the counts are
 * long-tailed (a handful of topics dominate everything else), and a linear
 * scale would leave the whole tail as identical dots.
 */
export function radiusOf(occurrences: number): number {
  const count = Math.max(0, occurrences);
  const t = Math.min(1, Math.log1p(count) / Math.log1p(RADIUS_SATURATION));
  return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * t;
}

/**
 * Impression is the fill. An unscored memory is drawn hollow, which is the
 * honest picture: nobody has judged it yet. Scored-but-low still gets a faint
 * wash, so "0" and "not looked at" stay visibly different.
 */
export function fillAlphaOf(salience: number | null): number {
  if (salience === null) return 0;
  return 0.1 + 0.55 * (Math.max(0, Math.min(100, salience)) / 100);
}

/** Both edge kinds collapse to one 0–1 number so the renderer has one rule. */
export function edgeStrength(edge: MemoryEdge): number {
  if (edge.type === 'similarity') {
    // Everything below the server's threshold is already gone, so stretch the
    // surviving band across the full range or every line looks identical.
    return Math.max(0, Math.min(1, (edge.similarity - 0.7) / 0.3));
  }
  return Math.max(0, Math.min(1, Math.log1p(edge.weight) / Math.log(8)));
}

function withAlpha(hex: string, alpha: number): string {
  const value = Math.max(0, Math.min(1, alpha));
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${value})`;
}

export async function createMemoryGraphView(
  options: MemoryGraphViewOptions,
): Promise<MemoryGraphView> {
  const { canvas, onSelect, onCountChange, reducedMotion } = options;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');

  // Lazy so the physics never lands on the visitor who only reads the list.
  const { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } =
    await import('d3-force');

  let nodes: SimNode[] = [];
  let edges: SimEdge[] = [];
  let byId = new Map<string, SimNode>();
  let selectedId: string | null = null;
  let hoverId: string | null = null;
  let filter = '';
  let neighbours = new Set<string>();

  /** Canvas size in CSS pixels. */
  let width = 0;
  let height = 0;
  /** The world the layout lives in, in world units. */
  let worldWidth = MIN_WORLD_SIDE;
  let worldHeight = MIN_WORLD_SIDE;
  /** The window onto the world: world × scale + translate = screen. */
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let framed = false;
  /**
   * Keep re-framing while the layout is still moving.
   *
   * Framing once on arrival would frame a cloud of random start positions. The
   * view instead follows the graph as it unfolds, so it is always whole, and
   * lets go the moment the reader takes over or the physics goes quiet.
   */
  let autoFit = false;

  let frame = 0;
  let disposed = false;
  /** Reused between frames so label ranking allocates nothing in the loop. */
  const labelQueue: LabelCandidate[] = [];

  const toScreenX = (x: number) => x * scale + tx;
  const toScreenY = (y: number) => y * scale + ty;
  const toWorldX = (x: number) => (x - tx) / scale;
  const toWorldY = (y: number) => (y - ty) / scale;

  /*
   * The forces are degree-aware, and that is the whole trick.
   *
   * A third of the graph has no edges at all — words Bot-tan has only ever
   * mentioned on their own. Under one uniform repulsion those loners spread
   * across the entire frame and squeeze the connected clusters into a corner,
   * which is how the space once ended up looking like a spreadsheet. So:
   * connected nodes are pulled to the middle and push hard enough to keep
   * their cluster open, while isolated ones are pulled weakly and push gently,
   * and settle as a diffuse field around the structure instead of competing
   * with it.
   */
  const centreStrength = (node: SimNode) => (node.degree > 0 ? 0.1 : 0.052);

  const simulation: Simulation = forceSimulation<SimNode, SimEdge>([])
    .force(
      'charge',
      forceManyBody<SimNode>()
        .strength((node) => (node.degree > 0 ? -260 : -110))
        .distanceMax(400),
    )
    .force('collide', forceCollide<SimNode>((node) => node.radius + 12))
    .force('x', forceX<SimNode>().strength(centreStrength))
    .force('y', forceY<SimNode>().strength((node) => centreStrength(node) * 1.15))
    .stop();

  /** The world grows with the graph so density stays constant as memory does. */
  function sizeWorld(count: number) {
    const aspect = height > 0 ? width / height : 1.4;
    const area = Math.max(count, 1) * WORLD_AREA_PER_NODE;
    worldWidth = Math.max(MIN_WORLD_SIDE, Math.sqrt(area * aspect));
    worldHeight = Math.max(MIN_WORLD_SIDE, area / worldWidth);
    simulation.force('center', forceCenter(worldWidth / 2, worldHeight / 2));
    simulation.force('x', forceX<SimNode>(worldWidth / 2).strength(centreStrength));
    simulation.force(
      'y',
      forceY<SimNode>(worldHeight / 2).strength((node) => centreStrength(node) * 1.15),
    );
  }

  /**
   * Keep the window over the world.
   *
   * When the world is bigger than the canvas, the edges of the world are the
   * limits of the pan — you can never scroll into empty space. When it is
   * smaller, it is simply centred, so a tiny graph does not sit in a corner.
   */
  function clampView() {
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
    const shownWidth = worldWidth * scale;
    const shownHeight = worldHeight * scale;
    tx = shownWidth <= width
      ? (width - shownWidth) / 2
      : Math.max(width - shownWidth, Math.min(0, tx));
    ty = shownHeight <= height
      ? (height - shownHeight) / 2
      : Math.max(height - shownHeight, Math.min(0, ty));
  }

  /** Any deliberate move hands the view over to the reader for good. */
  function releaseAutoFit() {
    autoFit = false;
  }

  /** Zoom about a point on screen, so what is under the pointer stays put. */
  function zoomAbout(screenX: number, screenY: number, factor: number) {
    releaseAutoFit();
    const worldX = toWorldX(screenX);
    const worldY = toWorldY(screenY);
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
    tx = screenX - worldX * scale;
    ty = screenY - worldY * scale;
    clampView();
  }

  /** Padding kept around the content when framing it, in screen px. */
  const FIT_PADDING = 26;

  /**
   * Frame the nodes — not the world.
   *
   * The world is sized for comfortable spacing when you are in among the
   * nodes, so it is always larger than the cloud that settles inside it.
   * Fitting the world left a third of the box empty and the graph off to one
   * side; fitting what is actually drawn is what "see everything" means.
   */
  function fit() {
    if (width === 0 || height === 0) return;
    if (nodes.length === 0) {
      scale = Math.min(width / worldWidth, height / worldHeight);
      clampView();
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      if (node.x - node.radius < minX) minX = node.x - node.radius;
      if (node.y - node.radius < minY) minY = node.y - node.radius;
      if (node.x + node.radius > maxX) maxX = node.x + node.radius;
      if (node.y + node.radius > maxY) maxY = node.y + node.radius;
    }
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    scale = Math.max(
      MIN_SCALE,
      Math.min(
        MAX_SCALE,
        Math.min((width - FIT_PADDING * 2) / spanX, (height - FIT_PADDING * 2) / spanY),
      ),
    );
    tx = width / 2 - ((minX + maxX) / 2) * scale;
    ty = height / 2 - ((minY + maxY) / 2) * scale;
    clampView();
  }

  /**
   * The opening view is the whole space.
   *
   * It used to open at 1:1 so the labels were readable straight away, which
   * meant landing somewhere inside a graph with no sense of its shape. Seeing
   * everything first and then choosing where to go is the better order — the
   * zoom buttons and the drag are right there.
   */
  function frameInitially() {
    fit();
    autoFit = true;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    // Hairlines have to survive the device pixel ratio, or the wireframe turns
    // into a smear on a phone.
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const previousWidth = width;
    const previousHeight = height;
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Hold the world point that was in the middle, so a rotation or a resize
    // does not throw the reader somewhere else entirely.
    if (previousWidth > 0 && previousHeight > 0) {
      tx += (width - previousWidth) / 2;
      ty += (height - previousHeight) / 2;
    }
    if (!framed && width > 0) {
      sizeWorld(nodes.length);
      frameInitially();
      framed = nodes.length > 0;
    }
    clampView();
    simulation.alpha(Math.max(simulation.alpha(), 0.2));
  }

  function recomputeNeighbours() {
    neighbours = new Set();
    const focus = hoverId ?? selectedId;
    if (!focus) return;
    for (const edge of edges) {
      const source = typeof edge.source === 'string' ? edge.source : edge.source.id;
      const target = typeof edge.target === 'string' ? edge.target : edge.target.id;
      if (source === focus) neighbours.add(target);
      if (target === focus) neighbours.add(source);
    }
  }

  function matchesFilter(node: SimNode): boolean {
    if (!filter) return true;
    return (
      node.label.toLowerCase().includes(filter) ||
      (node.spokenForm?.toLowerCase().includes(filter) ?? false)
    );
  }

  function update(graph: MemoryGraph) {
    const now = Date.now();
    const previous = byId;
    sizeWorld(graph.nodes.length);

    const next: SimNode[] = graph.nodes.map((node) => {
      const existing = previous.get(node.id);
      return {
        ...node,
        // Carry the old position over so a poll does not reshuffle the space.
        x: existing?.x ?? worldWidth / 2 + (Math.random() - 0.5) * worldWidth * 0.5,
        y: existing?.y ?? worldHeight / 2 + (Math.random() - 0.5) * worldHeight * 0.5,
        vx: existing?.vx ?? 0,
        vy: existing?.vy ?? 0,
        radius: radiusOf(node.occurrences),
        freshness: freshnessOf(node.latestAt, now),
        bornAt: existing?.bornAt ?? now,
        degree: 0,
        // Measured once here, not once per node per frame: `measureText` is
        // expensive and a label never changes width.
        labelWidth: 0,
      };
    });

    nodes = next;
    byId = new Map(nodes.map((node) => [node.id, node]));
    edges = graph.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      type: edge.type,
      strength: edgeStrength(edge),
    }));

    // The forces read `degree`, so it has to be right before the first tick.
    for (const edge of graph.edges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (source) source.degree++;
      if (target) target.degree++;
    }

    onCountChange({
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      similarEdges: graph.edges.filter((edge) => edge.type === 'similarity').length,
    });

    ctx!.font = `${LABEL_SIZE}px ${LABEL_FONT}`;
    for (const node of nodes) node.labelWidth = ctx!.measureText(node.label).width;

    simulation.nodes(nodes);
    simulation.force(
      'link',
      forceLink<SimNode, SimEdge>(edges)
        .id((node) => node.id)
        // Strong ties pull tighter; a similarity hint should not drag two
        // topics on top of each other the way a shared conversation does.
        .distance((edge) => (edge.type === 'cooccurrence' ? 62 : 120) - edge.strength * 22)
        .strength((edge) => (edge.type === 'cooccurrence' ? 0.75 : 0.2) * (0.4 + edge.strength)),
    );

    if (selectedId && !byId.has(selectedId)) select(null);
    recomputeNeighbours();
    if (!framed && width > 0 && nodes.length > 0) {
      frameInitially();
      framed = true;
    }
    simulation.alpha(previous.size === 0 ? 1 : 0.5).restart();
    if (reducedMotion) settleImmediately();
  }

  /**
   * With reduced motion the layout is solved in one go and then left alone —
   * the reader still gets the graph, just not the drift. Dragging still ticks,
   * because that is direct manipulation rather than ambient animation.
   */
  function settleImmediately() {
    for (let i = 0; i < 240; i++) simulation.tick();
    clampToWorld();
    simulation.alpha(0);
    // The frame taken before this ran was around the random start positions,
    // and the loop will not tick again to correct it. Re-frame here.
    if (autoFit) {
      fit();
      autoFit = false;
    }
  }

  /** Nothing may leave the world, or the pan limits would hide it forever. */
  function clampToWorld() {
    for (const node of nodes) {
      const margin = node.radius + 16;
      node.x = Math.max(margin, Math.min(worldWidth - margin, node.x));
      node.y = Math.max(margin, Math.min(worldHeight - margin, node.y));
    }
  }

  function select(id: string | null) {
    selectedId = id;
    recomputeNeighbours();
    onSelect(id ? (byId.get(id) ?? null) : null);
  }

  function focusOn(id: string) {
    const node = byId.get(id);
    if (!node) return;
    releaseAutoFit();
    tx = width / 2 - node.x * scale;
    ty = height / 2 - node.y * scale;
    clampView();
  }

  function setFilter(query: string) {
    filter = query.trim().toLowerCase();
  }

  /** Hit test in world units, with a screen-sized slop so small dots are catchable. */
  function nodeAt(screenX: number, screenY: number): SimNode | null {
    const worldX = toWorldX(screenX);
    const worldY = toWorldY(screenY);
    const slop = 12 / scale;
    let best: SimNode | null = null;
    let bestDistance = Infinity;
    for (const node of nodes) {
      const distance = Math.hypot(node.x - worldX, node.y - worldY);
      if (distance <= node.radius + slop && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  }

  function drawGrid() {
    const step = 44;
    // The grid moves with the world, so panning reads as motion over a map
    // rather than the nodes sliding across a static backdrop.
    const screenStep = step * scale;
    if (screenStep < 6) return;
    ctx!.save();
    ctx!.strokeStyle = GRID_COLOR;
    ctx!.lineWidth = 1;
    ctx!.beginPath();
    for (let x = tx % screenStep; x < width; x += screenStep) {
      ctx!.moveTo(Math.round(x) + 0.5, 0);
      ctx!.lineTo(Math.round(x) + 0.5, height);
    }
    for (let y = ty % screenStep; y < height; y += screenStep) {
      ctx!.moveTo(0, Math.round(y) + 0.5);
      ctx!.lineTo(width, Math.round(y) + 0.5);
    }
    ctx!.stroke();
    ctx!.restore();
  }

  /** A hollow hexagon for `work`, so kind survives a greyscale print. */
  function tracePolygon(x: number, y: number, radius: number) {
    ctx!.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 2;
      const px = x + radius * Math.cos(angle);
      const py = y + radius * Math.sin(angle);
      if (i === 0) ctx!.moveTo(px, py);
      else ctx!.lineTo(px, py);
    }
    ctx!.closePath();
  }

  /*
   * The draw loops below set canvas state directly instead of wrapping every
   * mark in save()/restore(). At a thousand nodes that was five thousand pairs
   * of calls per frame; each loop now leaves the context in a known state when
   * it is done, which is all the next one needs.
   */
  function drawEdges(focus: string | null) {
    for (const edge of edges) {
      const source = edge.source as SimNode;
      const target = edge.target as SimNode;
      if (!source?.id || !target?.id) continue;

      const touchesFocus = !focus || source.id === focus || target.id === focus;
      // A search that dims the nodes but leaves every line at full strength
      // reads as "nothing was filtered" — the wireframe is mostly lines.
      const touchesMatch = matchesFilter(source) || matchesFilter(target);
      const dimmed = (focus && !touchesFocus) || !touchesMatch;
      const freshness = Math.max(source.freshness, target.freshness);
      const alpha = (0.18 + edge.strength * 0.5) * freshness * (dimmed ? 0.15 : 1);

      ctx!.strokeStyle =
        focus && touchesFocus && !dimmed ? withAlpha(HIGHLIGHT, alpha) : withAlpha(EDGE_COLOR, alpha);
      ctx!.lineWidth = edge.type === 'cooccurrence' ? 0.8 + edge.strength * 2 : 0.8;
      // Similarity is a suggestion, not a record of something that happened.
      ctx!.setLineDash(edge.type === 'similarity' ? DASH_SIMILARITY : DASH_NONE);
      ctx!.beginPath();
      ctx!.moveTo(toScreenX(source.x), toScreenY(source.y));
      ctx!.lineTo(toScreenX(target.x), toScreenY(target.y));
      ctx!.stroke();
    }
    ctx!.setLineDash(DASH_NONE);
  }

  function drawNodes(focus: string | null, now: number) {
    for (const node of nodes) {
      const isFocus = node.id === focus;
      const related = neighbours.has(node.id);
      const matched = matchesFilter(node);
      const dimmed = (focus && !isFocus && !related) || !matched;

      const x = toScreenX(node.x);
      const y = toScreenY(node.y);
      const radius = node.radius * scale;
      // Cheap cull: at low zoom most of the world is off-window.
      if (x < -radius - 40 || x > width + radius + 40) continue;
      if (y < -radius - 40 || y > height + radius + 40) continue;

      const arrival = Math.min(1, (now - node.bornAt) / ARRIVAL_MS);
      const flare = 1 - arrival;
      const alpha = node.freshness * (dimmed ? 0.22 : 1);
      const color = isFocus ? HIGHLIGHT : KIND_COLORS[node.kind];

      ctx!.lineWidth = 1 + Math.min(2, Math.log1p(node.occurrences) * 0.7);
      ctx!.strokeStyle = withAlpha(color, alpha);
      // Unscored memories get a dashed outline: "not judged yet" must not read
      // as "judged and found dull".
      ctx!.setLineDash(node.salience === null ? DASH_UNSCORED : DASH_NONE);

      if (node.kind === 'work') tracePolygon(x, y, radius);
      else {
        ctx!.beginPath();
        ctx!.arc(x, y, radius, 0, Math.PI * 2);
      }
      ctx!.stroke();

      // The fill is the impression. Unscored nodes stay hollow.
      ctx!.fillStyle = withAlpha(color, alpha * fillAlphaOf(node.salience));
      ctx!.fill();

      // Newly remembered things pulse once as they arrive.
      if (flare > 0 && !reducedMotion) {
        ctx!.setLineDash(DASH_NONE);
        ctx!.strokeStyle = withAlpha(HIGHLIGHT, flare * 0.7);
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        ctx!.arc(x, y, radius + 6 + flare * 26, 0, Math.PI * 2);
        ctx!.stroke();
      }
    }
    ctx!.setLineDash(DASH_NONE);
  }

  /**
   * Labels, placed after every node is drawn.
   *
   * Nothing stops two nodes from settling a few pixels apart, so a label per
   * node turns into a wall of overlapping text — and the labels are long
   * (production has 25-character ones). Rather than trying to teach the physics
   * about text boxes, walk the nodes in priority order and drop any label whose
   * box would collide with one already placed. The biggest, most relevant words
   * win the space; the rest are a hover, a zoom, or the list view away.
   */
  function drawLabels(focus: string | null) {
    const placed: { left: number; right: number; top: number; bottom: number }[] = [];
    // Rank in one pass over a reused shape: focus, then its neighbours, then
    // size. Building three intermediate arrays per frame is affordable at a
    // hundred nodes and is not at a thousand.
    labelQueue.length = 0;
    for (const node of nodes) {
      const isFocus = node.id === focus;
      const related = neighbours.has(node.id);
      if (!isFocus && !related && focus) continue;
      if (!matchesFilter(node)) continue;
      // Off-window labels can never be placed, so they never enter the queue.
      const x = toScreenX(node.x);
      const y = toScreenY(node.y);
      if (x < -80 || x > width + 80 || y < -40 || y > height + 40) continue;
      labelQueue.push({ node, isFocus, related, x, y });
    }
    labelQueue.sort((a, b) => {
      const rank = (entry: LabelCandidate) => (entry.isFocus ? 2 : entry.related ? 1 : 0);
      return rank(b) - rank(a) || b.node.radius - a.node.radius;
    });

    ctx!.textAlign = 'center';
    ctx!.textBaseline = 'top';
    let font = '';

    for (const { node, isFocus, related, x, y } of labelQueue) {
      if (placed.length >= LABEL_BUDGET && !isFocus) break;

      const size = isFocus ? FOCUS_LABEL_SIZE : LABEL_SIZE;
      // Widths were measured at LABEL_SIZE; the focus label is drawn one step
      // larger, and its box is scaled to match rather than re-measured.
      const textWidth = node.labelWidth * (size / LABEL_SIZE);
      const half = textWidth / 2;
      // A label centred on a node near the edge of the window runs off it.
      // Slide it back inside; one wider than the window has nowhere to go.
      if (textWidth + 8 > width) continue;
      const labelX = Math.max(half + 4, Math.min(width - half - 4, x));
      const top = y + node.radius * scale + 5;
      const left = labelX - half - 3;
      const right = labelX + half + 3;
      const bottom = top + size + 2;

      let collides = false;
      for (const other of placed) {
        if (left < other.right && right > other.left && top - 2 < other.bottom && bottom > other.top) {
          collides = true;
          break;
        }
      }
      // The focus always gets its label, even if it has to sit on another.
      if (collides && !isFocus) continue;
      placed.push({ left, right, top: top - 2, bottom });

      const nextFont = `${size}px ${LABEL_FONT}`;
      if (nextFont !== font) {
        ctx!.font = nextFont;
        font = nextFont;
      }
      ctx!.fillStyle = withAlpha(
        isFocus ? TEXT_PRIMARY : TEXT_SECONDARY,
        focus && !isFocus && !related ? 0.3 : 1,
      );
      ctx!.fillText(node.label, labelX, top);
    }
  }

  function render() {
    const now = Date.now();
    const focus = hoverId ?? selectedId;
    ctx!.clearRect(0, 0, width, height);
    drawGrid();
    drawEdges(focus);
    drawNodes(focus, now);
    drawLabels(focus);
  }

  function loop() {
    if (disposed) return;
    const settling = simulation.alpha() > simulation.alphaMin();
    // A drag has to keep ticking even under reduced motion — the reader is the
    // one moving it, and a node that does not follow the finger reads as broken.
    if (settling && (!reducedMotion || dragNode)) {
      simulation.tick();
      clampToWorld();
      if (autoFit) {
        fit();
        // Let go once the layout has all but stopped, so the reader is not
        // fighting a view that keeps re-centring under them.
        if (simulation.alpha() <= 0.05) autoFit = false;
      }
    }
    render();
    frame = requestAnimationFrame(loop);
  }

  /* ---------------------------------------------------------------- input */

  const pointers = new Map<number, { x: number; y: number }>();
  let dragNode: SimNode | null = null;
  let panning = false;
  let panFrom = { x: 0, y: 0, tx: 0, ty: 0 };
  let pressTravel = 0;
  let pinchDistance = 0;

  function localPoint(event: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function handlePointerDown(event: PointerEvent) {
    const point = localPoint(event);
    pointers.set(event.pointerId, point);
    canvas.setPointerCapture(event.pointerId);

    if (pointers.size === 2) {
      // A second finger turns the gesture into a pinch; drop whatever the
      // first one was doing so the node is not dragged across the screen.
      releaseDrag();
      panning = false;
      const [a, b] = [...pointers.values()];
      pinchDistance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      return;
    }

    pressTravel = 0;
    releaseAutoFit();
    const found = nodeAt(point.x, point.y);
    if (found) {
      dragNode = found;
      dragNode.fx = found.x;
      dragNode.fy = found.y;
      /*
       * Keep the simulation warm so the neighbours follow the node being
       * pulled. `alpha` has to be raised explicitly, not just `alphaTarget`:
       * under reduced motion the layout was settled to exactly zero, the loop
       * only ticks above `alphaMin`, and a target alone never gets it there —
       * the node would stick to the pointer and nothing else would move.
       */
      simulation.alpha(Math.max(simulation.alpha(), 0.3)).alphaTarget(0.3).restart();
      canvas.style.cursor = 'grabbing';
    } else {
      panning = true;
      panFrom = { x: point.x, y: point.y, tx, ty };
      canvas.style.cursor = 'grabbing';
    }
  }

  function handlePointerMove(event: PointerEvent) {
    const point = localPoint(event);
    const previous = pointers.get(event.pointerId);
    if (previous) pointers.set(event.pointerId, point);

    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinchDistance > 0 && distance > 0) {
        zoomAbout((a!.x + b!.x) / 2, (a!.y + b!.y) / 2, distance / pinchDistance);
      }
      pinchDistance = distance;
      return;
    }

    if (previous) {
      pressTravel += Math.hypot(point.x - previous.x, point.y - previous.y);
    }

    if (dragNode) {
      dragNode.fx = toWorldX(point.x);
      dragNode.fy = toWorldY(point.y);
      return;
    }

    if (panning) {
      tx = panFrom.tx + (point.x - panFrom.x);
      ty = panFrom.ty + (point.y - panFrom.y);
      clampView();
      return;
    }

    const found = nodeAt(point.x, point.y);
    const id = found?.id ?? null;
    canvas.style.cursor = id ? 'pointer' : 'grab';
    if (id === hoverId) return;
    hoverId = id;
    recomputeNeighbours();
    onSelect(byId.get(hoverId ?? selectedId ?? '') ?? null);
  }

  function releaseDrag() {
    if (!dragNode) return;
    dragNode.fx = null;
    dragNode.fy = null;
    dragNode = null;
    simulation.alphaTarget(0);
  }

  function handlePointerUp(event: PointerEvent) {
    const point = pointers.get(event.pointerId);
    const wasDragging = dragNode;
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);

    // A press that barely moved is a click, whether it landed on a node or not.
    if (point && pressTravel < CLICK_SLOP) {
      const found = nodeAt(point.x, point.y);
      select(found && found.id !== selectedId ? found.id : null);
    }

    releaseDrag();
    panning = false;
    pinchDistance = 0;
    canvas.style.cursor = wasDragging ? 'pointer' : 'grab';
  }

  function handlePointerLeave() {
    if (dragNode || panning) return;
    hoverId = null;
    recomputeNeighbours();
    canvas.style.cursor = 'default';
    onSelect(selectedId ? (byId.get(selectedId) ?? null) : null);
  }

  /**
   * Plain wheel is left to the page.
   *
   * The canvas sits in the middle of a scrolling document; swallowing the wheel
   * would trap the reader inside it. Zoom is on the modifier, the pinch, and
   * the buttons — all three of which are deliberate.
   */
  function handleWheel(event: WheelEvent) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAbout(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.002));
  }

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(canvas);
  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', handlePointerUp);
  canvas.addEventListener('pointercancel', handlePointerUp);
  canvas.addEventListener('pointerleave', handlePointerLeave);
  canvas.addEventListener('wheel', handleWheel, { passive: false });

  resize();
  canvas.style.cursor = 'grab';
  loop();

  return {
    update,
    setFilter,
    select,
    focusOn,
    zoomBy(factor: number) {
      zoomAbout(width / 2, height / 2, factor);
    },
    fit() {
      releaseAutoFit();
      fit();
    },
    resize,
    destroy() {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      simulation.stop();
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerUp);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
      canvas.removeEventListener('wheel', handleWheel);
    },
  };
}
