/**
 * Module placement on the patch grid, as the original editors do it.
 *
 * `xpos` is a column and `ypos` an absolute row: Nomad's `PBasicModuleMetrics`
 * maps them to the screen as `xpos * gridWidth` and `ypos * gridHeight`, and
 * snaps a drop to the nearest cell. Rows are 15px and columns 255px, the size
 * of every themed panel, so a module `height` units tall covers that many rows.
 * Gaps between modules are real and are kept.
 */

/** Largest value the 7-bit `xpos` / `ypos` fields can carry. */
export const MAX_GRID = 127;

export interface LayoutItem {
  key: number;
  x: number;
  y: number;
  /** Height in rows. */
  height: number;
}

export type Placement = Map<number, { x: number; y: number }>;

const clamp = (value: number) => Math.max(0, Math.min(MAX_GRID, Math.round(value)));

/**
 * Where everything ends up when one module is dropped at a cell.
 *
 * Follows `LayoutTool._move`: the dropped module takes its cell, and any module
 * in that column which is not wholly above it is pushed down, in `ypos` order,
 * just far enough to clear whatever now sits above it. Nothing else moves, so
 * gaps elsewhere in the column survive.
 *
 * Returns only the modules whose position changed.
 */
export function resolveMove(
  items: LayoutItem[],
  movedKey: number,
  targetX: number,
  targetY: number,
): Placement {
  const moved = items.find((item) => item.key === movedKey);
  const changes: Placement = new Map();
  if (!moved) return changes;

  const x = clamp(targetX);
  const y = clamp(targetY);
  if (x !== moved.x || y !== moved.y) changes.set(moved.key, { x, y });

  const below = items
    .filter((item) => item.key !== movedKey && item.x === x && item.y + item.height > y)
    .sort((a, b) => a.y - b.y);

  let bottom = y + moved.height;
  for (const item of below) {
    if (item.y >= bottom) continue;
    const pushed = clamp(bottom);
    changes.set(item.key, { x: item.x, y: pushed });
    bottom = pushed + item.height;
  }
  return changes;
}

/**
 * Pushes apart modules that already overlap, column by column, keeping their
 * order and every gap that is not an overlap.
 *
 * Patches whose positions were written as ranks within a column (0, 1, 2...)
 * by an earlier version of this editor overlap in the original; this repairs
 * them. Returns only the modules whose position changed.
 */
export function resolveOverlaps(items: LayoutItem[]): Placement {
  const changes: Placement = new Map();
  const columns = new Map<number, LayoutItem[]>();
  for (const item of items) {
    const column = columns.get(item.x) ?? [];
    column.push(item);
    columns.set(item.x, column);
  }

  for (const column of columns.values()) {
    column.sort((a, b) => a.y - b.y || a.key - b.key);
    let bottom = 0;
    for (const item of column) {
      const y = clamp(Math.max(item.y, bottom));
      if (y !== item.y) changes.set(item.key, { x: item.x, y });
      bottom = y + item.height;
    }
  }
  return changes;
}

/** Pairs of modules that share a cell. */
export function countOverlaps(items: LayoutItem[]): number {
  let overlaps = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (a.x === b.x && a.y < b.y + b.height && b.y < a.y + a.height) overlaps++;
    }
  }
  return overlaps;
}
