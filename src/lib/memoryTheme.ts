/**
 * Colours for the memory graph at `/memory`.
 *
 * The rest of the site is deliberately light-only — cream paper, hand-drawn
 * strokes (`color-scheme: light` in global.css). This page is the one exception:
 * it is a wireframe space you drop into, so it has its own dark surface and
 * its own validated palette. `dashboardTheme.ts` cannot be reused; every value
 * there was checked against paper.
 *
 * The two hues are checked as a set against THIS surface, all-pairs, because
 * any two nodes can end up adjacent in a force layout:
 *
 *   node scripts/validate_palette.js "#2a9db8,#d55181" \
 *     --mode dark --surface "#080c14" --pairs all
 *   → ALL CHECKS PASS (CVD ΔE 8.9 deutan, normal vision 26.4, both in the
 *     dark lightness band L 0.48–0.67, both ≥ 3:1 on the surface)
 *
 * Cyan echoes the site's `--color-sky`; the magenta is the documented dark
 * step for that hue family. Node shape carries the same distinction, so the
 * kinds are never told apart by colour alone.
 */

/** The surface every colour here was validated against. */
export const SURFACE = '#080c14';

/** Panels floating over the surface — HUD, legend, readout. */
export const PANEL = '#0e1622';

/**
 * The two kinds of thing Bot-tan remembers. Shape does the same job:
 * `work` is drawn as a polygon, `word` as a circle.
 */
export const KIND_COLORS = {
  work: '#2a9db8',
  word: '#d55181',
} as const;

/**
 * Edges are structure, not identity, so they stay one recessive hue and are
 * told apart by dash pattern: co-occurrence solid, similarity dashed.
 */
export const EDGE_COLOR = '#3f6d86';

/** Selection / hover. Reserved — never used for a node kind. */
export const HIGHLIGHT = '#f0c05a';

/** Text on the dark surface. 15.7:1 and 8.0:1 respectively. */
export const TEXT_PRIMARY = '#dce8f0';
export const TEXT_SECONDARY = '#93a8ba';

/** The wireframe grid and other pure context marks. */
export const GRID_COLOR = 'rgba(114, 173, 199, 0.13)';

/**
 * Freshness is drawn as opacity, not as a second hue — a memory from last week
 * and one from last spring are the same kind of thing, only one is dimmer.
 * Anything older than this is drawn at `FRESHNESS_MIN_ALPHA`.
 */
export const FRESHNESS_FULL_DAYS = 7;
export const FRESHNESS_FADE_DAYS = 180;
export const FRESHNESS_MIN_ALPHA = 0.28;
