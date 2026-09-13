import { readFileSync } from 'node:fs';
import { parsePdl2 } from '../src/pdl2/parser.ts';

for (const name of ['midi', 'patch']) {
  const src = readFileSync(new URL(`../public/data/${name}.pdl2`, import.meta.url), 'utf8');
  try {
    const g = parsePdl2(src);
    console.log(`${name}.pdl2  OK   start=${g.start}  rules=${g.rules.size}`);
  } catch (e) {
    console.log(`${name}.pdl2  FAIL ${(e as Error).message}`);
  }
}
