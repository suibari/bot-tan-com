/**
 * The wireframe space at `/memory`: a force layout of Bot-tan's memory,
 * drawn on a 2D canvas.
 *
 * `d3-force` does the physics and nothing else — every mark here is hand-drawn
 * so the page can look like a schematic rather than a chart library's default.
 * The module holds no DOM beyond the canvas it is handed; the page component
 * owns the HUD, the readout and the list view.
 *
 * Visual encoding:
 *
 *   impression (salience) → node radius; unscored nodes get a dashed ring so
 *                           "not judged yet" never reads as "judged boring"
 *   freshness (latestAt)  → opacity; old memories sink into the grid
 *   occurrences           → stroke weight
 *   kind                  → shape (polygon / circle) AND hue, never hue alone
 *   co-occurrence edge    → solid, thickness by weight
 *   similarity edge       → dashed, opacity by similarity
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

interface SimNode extends MemoryNode {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  /** Drawn radius, derived once per data update. */
  radius: number;
  /** 0–1, derived from `latestAt`. */
  freshness: number;
  /** Seconds since this node first appeared, for the arrival animation. */
  bornAt: number;
}

interface SimEdge {
  source: SimNode | string;
  target: SimNode | string;
  type: MemoryEdge['type'];
  /** Normalised 0–1 strength, whatever the edge type. */
  strength: number;
}

const MIN_RADIUS = 5;
const MAX_RADIUS = 17;
const LABEL_FONT = "'DotGothic16', monospace";

/** New nodes flare for this long before settling into the wireframe. */
const ARRIVAL_MS = 2600;

export interface MemoryGraphView {
  /** Swap in a new payload, keeping the positions of nodes that survived. */
  update(graph: MemoryGraph): void;
  /** Restrict the drawing to labels matching this text. Empty clears it. */
  setFilter(query: string): void;
  /** The node under the pointer, or the one picked by the list view. */
  select(id: string | null): void;
  resize(): void;
  destroy(): void;
}

export interface MemoryGraphViewOptions {
  canvas: HTMLCanvasElement;
  /** Called whenever the hovered/selected node changes. */
  onSelect(node: MemoryNode | null): void;
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
 * Impression drives the radius. Unscored nodes sit at the middle of the range
 * rather than the bottom: `null` means "not judged yet", and drawing those as
 * the smallest dots would quietly rank the whole back catalogue last.
 */
export function radiusOf(salience: number | null): number {
  const value = salience ?? 50;
  const clamped = Math.max(0, Math.min(100, value));
  return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * Math.sqrt(clamped / 100);
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

/** A hollow hexagon for `work`, so kind survives a greyscale print. */
function tracePolygon(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    const px = x + radius * Math.cos(angle);
    const py = y + radius * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

export async function createMemoryGraphView(
  options: MemoryGraphViewOptions,
): Promise<MemoryGraphView> {
  const { canvas, onSelect, reducedMotion } = options;
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
  let width = 0;
  let height = 0;
  let frame = 0;
  let disposed = false;

  const simulation: Simulation = forceSimulation<SimNode, SimEdge>([])
    .force('charge', forceManyBody<SimNode>().strength(-220).distanceMax(420))
    .force('collide', forceCollide<SimNode>((node) => node.radius + 14))
    .force('x', forceX<SimNode>().strength(0.045))
    .force('y', forceY<SimNode>().strength(0.055))
    .stop();

  function resize() {
    const rect = canvas.getBoundingClientRect();
    // Hairlines have to survive the device pixel ratio, or the wireframe turns
    // into a smear on a phone.
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    simulation.force('center', forceCenter(width / 2, height / 2));
    clampToFrame();
    simulation.alpha(Math.max(simulation.alpha(), 0.25));
    if (reducedMotion) settleImmediately();
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
    const next: SimNode[] = graph.nodes.map((node) => {
      const existing = previous.get(node.id);
      return {
        ...node,
        // Carry the old position over so a poll does not reshuffle the space.
        x: existing?.x ?? width / 2 + (Math.random() - 0.5) * 220,
        y: existing?.y ?? height / 2 + (Math.random() - 0.5) * 220,
        vx: existing?.vx ?? 0,
        vy: existing?.vy ?? 0,
        radius: radiusOf(node.salience),
        freshness: freshnessOf(node.latestAt, now),
        bornAt: existing?.bornAt ?? now,
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

    simulation.nodes(nodes);
    simulation.force(
      'link',
      forceLink<SimNode, SimEdge>(edges)
        .id((node) => node.id)
        // Strong ties pull tighter; a similarity hint should not drag two
        // topics on top of each other the way a shared conversation does.
        .distance((edge) => (edge.type === 'cooccurrence' ? 78 : 138) - edge.strength * 26)
        .strength((edge) => (edge.type === 'cooccurrence' ? 0.5 : 0.16) * (0.4 + edge.strength)),
    );

    if (selectedId && !byId.has(selectedId)) select(null);
    recomputeNeighbours();
    simulation.alpha(previous.size === 0 ? 1 : 0.5).restart();
    if (reducedMotion) settleImmediately();
  }

  /**
   * With reduced motion the layout is solved in one go and then left alone —
   * the reader still gets the graph, just not the drift.
   */
  function settleImmediately() {
    for (let i = 0; i < 220; i++) simulation.tick();
    clampToFrame();
    simulation.alpha(0);
  }

  function select(id: string | null) {
    selectedId = id;
    recomputeNeighbours();
    onSelect(id ? (byId.get(id) ?? null) : null);
  }

  function setFilter(query: string) {
    filter = query.trim().toLowerCase();
  }

  function nodeAt(x: number, y: number): SimNode | null {
    let best: SimNode | null = null;
    let bestDistance = Infinity;
    for (const node of nodes) {
      const dx = node.x - x;
      const dy = node.y - y;
      const distance = Math.hypot(dx, dy);
      // A generous hit target — the drawn dot is as small as 5px.
      if (distance <= node.radius + 12 && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  }

  function drawGrid() {
    const step = 44;
    ctx!.save();
    ctx!.strokeStyle = GRID_COLOR;
    ctx!.lineWidth = 1;
    ctx!.beginPath();
    for (let x = (width / 2) % step; x < width; x += step) {
      ctx!.moveTo(Math.round(x) + 0.5, 0);
      ctx!.lineTo(Math.round(x) + 0.5, height);
    }
    for (let y = (height / 2) % step; y < height; y += step) {
      ctx!.moveTo(0, Math.round(y) + 0.5);
      ctx!.lineTo(width, Math.round(y) + 0.5);
    }
    ctx!.stroke();
    ctx!.restore();
  }

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

      ctx!.save();
      ctx!.strokeStyle =
        focus && touchesFocus && !dimmed ? withAlpha(HIGHLIGHT, alpha) : withAlpha(EDGE_COLOR, alpha);
      ctx!.lineWidth = edge.type === 'cooccurrence' ? 0.8 + edge.strength * 2 : 0.8;
      // Similarity is a suggestion, not a record of something that happened.
      ctx!.setLineDash(edge.type === 'similarity' ? [3, 5] : []);
      ctx!.beginPath();
      ctx!.moveTo(source.x, source.y);
      ctx!.lineTo(target.x, target.y);
      ctx!.stroke();
      ctx!.restore();
    }
  }

  function drawNodes(focus: string | null, now: number) {
    for (const node of nodes) {
      const isFocus = node.id === focus;
      const related = neighbours.has(node.id);
      const matched = matchesFilter(node);
      const dimmed = (focus && !isFocus && !related) || !matched;

      const arrival = Math.min(1, (now - node.bornAt) / ARRIVAL_MS);
      const flare = 1 - arrival;
      const alpha = node.freshness * (dimmed ? 0.22 : 1);
      const color = isFocus ? HIGHLIGHT : KIND_COLORS[node.kind];

      ctx!.save();
      ctx!.lineWidth = 1 + Math.min(2, Math.log1p(node.occurrences) * 0.7);
      ctx!.strokeStyle = withAlpha(color, alpha);
      // Unscored memories get a dashed outline: "not judged yet" must not read
      // as "judged and found dull".
      ctx!.setLineDash(node.salience === null ? [2, 3] : []);

      if (node.kind === 'work') tracePolygon(ctx!, node.x, node.y, node.radius);
      else {
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      }
      ctx!.stroke();

      // A faint core so the dot still reads at the smallest radius.
      ctx!.fillStyle = withAlpha(color, alpha * 0.16);
      ctx!.fill();

      // Newly remembered things pulse once as they arrive.
      if (flare > 0 && !reducedMotion) {
        ctx!.setLineDash([]);
        ctx!.strokeStyle = withAlpha(HIGHLIGHT, flare * 0.7);
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, node.radius + 6 + flare * 26, 0, Math.PI * 2);
        ctx!.stroke();
      }
      ctx!.restore();

      // Labels only where they can be read: the focus, its neighbours, search
      // hits, and the memories that made the strongest impression.
      const labelled =
        isFocus ||
        related ||
        (Boolean(filter) && matched) ||
        (!focus && !filter && node.radius > MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * 0.55);
      if (!labelled) continue;

      ctx!.save();
      ctx!.font = `${isFocus ? 13 : 12}px ${LABEL_FONT}`;
      ctx!.textAlign = 'center';
      ctx!.textBaseline = 'top';
      ctx!.fillStyle = withAlpha(isFocus ? TEXT_PRIMARY : TEXT_SECONDARY, dimmed ? 0.3 : 1);
      ctx!.fillText(node.label, node.x, node.y + node.radius + 5);
      ctx!.restore();
    }
  }

  function render() {
    const now = Date.now();
    const focus = hoverId ?? selectedId;
    ctx!.clearRect(0, 0, width, height);
    drawGrid();
    drawEdges(focus);
    drawNodes(focus, now);
  }

  /**
   * Keep every node inside the frame.
   *
   * `forceCenter` only balances the centre of mass, so a cluster with few links
   * drifts off the edge and takes its label with it — on a phone that is a node
   * you can neither read nor tap. Clamping the position (and killing the
   * velocity that pushed it out) is what a wall would do.
   */
  function clampToFrame() {
    for (const node of nodes) {
      const margin = node.radius + 24;
      if (node.x < margin) {
        node.x = margin;
        node.vx = 0;
      } else if (node.x > width - margin) {
        node.x = width - margin;
        node.vx = 0;
      }
      // Room under the node for its label.
      if (node.y < margin) {
        node.y = margin;
        node.vy = 0;
      } else if (node.y > height - margin - 12) {
        node.y = height - margin - 12;
        node.vy = 0;
      }
    }
  }

  function loop() {
    if (disposed) return;
    if (!reducedMotion && simulation.alpha() > simulation.alphaMin()) {
      simulation.tick();
      clampToFrame();
    }
    render();
    frame = requestAnimationFrame(loop);
  }

  function pointerPosition(event: PointerEvent | MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function handlePointerMove(event: PointerEvent) {
    const { x, y } = pointerPosition(event);
    const found = nodeAt(x, y);
    const id = found?.id ?? null;
    if (id === hoverId) return;
    hoverId = id;
    recomputeNeighbours();
    canvas.style.cursor = id ? 'pointer' : 'default';
    onSelect(byId.get(hoverId ?? selectedId ?? '') ?? null);
  }

  function handlePointerLeave() {
    hoverId = null;
    recomputeNeighbours();
    canvas.style.cursor = 'default';
    onSelect(selectedId ? (byId.get(selectedId) ?? null) : null);
  }

  function handleClick(event: MouseEvent) {
    const { x, y } = pointerPosition(event);
    const found = nodeAt(x, y);
    select(found && found.id !== selectedId ? found.id : null);
  }

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(canvas);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerleave', handlePointerLeave);
  canvas.addEventListener('click', handleClick);

  resize();
  loop();

  return {
    update,
    setFilter,
    select,
    resize,
    destroy() {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      simulation.stop();
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
      canvas.removeEventListener('click', handleClick);
    },
  };
}
