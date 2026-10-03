/**
 * Guards module placement against the rules of the original editors.
 *
 * ypos is an absolute row and a drop pushes overlapped neighbours down, as
 * Nomad's `LayoutTool._move` does, so a patch arranged here opens the same way
 * in the original editor.
 */
import { resolveMove, resolveOverlaps, countOverlaps, MAX_GRID } from '../src/model/layout.ts';

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = '') {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  ok ? pass++ : fail++;
}

const show = (changes: Map<number, { x: number; y: number }>) =>
  [...changes].map(([k, c]) => `${k}:${c.x},${c.y}`).join(' ') || '(none)';

// A column: A rows 0-4, B rows 5-7, gap, C rows 12-15. D sits in column 1.
const column = () => [
  { key: 1, x: 0, y: 0, height: 5 },
  { key: 2, x: 0, y: 5, height: 3 },
  { key: 3, x: 0, y: 12, height: 4 },
  { key: 4, x: 1, y: 0, height: 6 },
];

process.stdout.write('\nDropping a module\n');
{
  const free = resolveMove(column(), 4, 0, 16);
  check('into free space: only it moves', show(free) === '4:0,16', show(free));

  const intoGap = resolveMove(column(), 4, 0, 8);
  check('into a gap too small for it: only what it lands on moves',
    show(intoGap) === '4:0,8 3:0,14', show(intoGap));

  const onto = resolveMove(column(), 4, 0, 4);
  // D (6 rows) lands on rows 4-9. A starts above the drop but its last row
  // runs into it, so — as LayoutTool does — it is pushed below, to 10; then B
  // goes below A (15) and C below B (18), each just clearing the one above.
  check('onto others: overlapped neighbours are pushed down in order',
    show(onto) === '4:0,4 1:0,10 2:0,15 3:0,18', show(onto));

  const gap = resolveMove(column(), 2, 1, 6);
  check('a gap the drop does not touch survives', show(gap) === '2:1,6', show(gap));

  const nowhere = resolveMove(column(), 2, 0, 5);
  check('dropped where it was: nothing to send', nowhere.size === 0, show(nowhere));

  const clamped = resolveMove(column(), 3, -2, -4);
  check('off the top-left edge clamps to the origin, and pushes what is there',
    show(clamped) === '3:0,0 1:0,4 2:0,9', show(clamped));

  const far = resolveMove(column(), 3, 0, 500);
  check('past the 7-bit limit clamps', far.get(3)?.y === MAX_GRID, show(far));
}

process.stdout.write('\nRepairing rank-written columns\n');
{
  const ranked = [
    { key: 1, x: 0, y: 0, height: 5 },
    { key: 2, x: 0, y: 1, height: 3 },
    { key: 3, x: 0, y: 2, height: 4 },
    { key: 4, x: 1, y: 0, height: 2 },
    { key: 5, x: 1, y: 20, height: 2 },
  ];
  check('overlaps counted', countOverlaps(ranked) === 3, `${countOverlaps(ranked)}`);
  const fixed = resolveOverlaps(ranked);
  check('stacked edge to edge in their order; column 1 left alone',
    show(fixed) === '2:0,5 3:0,8', show(fixed));
  const after = ranked.map((item) => ({ ...item, ...fixed.get(item.key) }));
  check('nothing overlaps afterwards', countOverlaps(after) === 0, '');
  check('a tidy patch needs no repair', resolveOverlaps(column()).size === 0, '');
}

process.stdout.write(`\n${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
