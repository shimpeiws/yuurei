import { createGhostBehavior } from '../src/cli/ghost-behavior.js';
import { parseArgs } from 'node:util';
import { renderGhost } from '../src/cli/ghost.js';

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'full' },
    seed: { type: 'string', default: '7' },
    width: { type: 'string', default: '40' },
    seconds: { type: 'string', default: '30' },
  },
});
const seed = Number(values.seed);
const width = Number(values.width);
const seconds = Number(values.seconds);
if (
  !Number.isInteger(seed) ||
  !Number.isInteger(width) ||
  width < 1 ||
  width > 160 ||
  !Number.isFinite(seconds) ||
  seconds <= 0
) {
  throw new Error('Expected an integer seed, width 1–160, and positive duration');
}
const mode = values.mode;
if (mode === 'compare') {
  for (const design of ['sheet', 'petal', 'silk', 'reference', 'canonical', 'scallop'] as const) {
    console.log(design);
    console.log(renderGhost({ seed, width, time: 0, mode: 'still', design }).join('\n'));
  }
  process.exit(0);
}
if (
  mode !== 'float' &&
  mode !== 'full' &&
  mode !== 'showcase' &&
  mode !== 'curl' &&
  mode !== 'autonomous'
) {
  throw new Error('Expected --mode=compare, float, curl, showcase, or autonomous');
}
const behavior = createGhostBehavior(seed);
const start = performance.now();
let frame = 0;
let drawn = false;
const timer = setInterval(() => {
  const time = mode === 'autonomous' ? performance.now() - start : frame * 100;
  const beat = mode === 'autonomous' ? behavior.sample(time) : undefined;
  const rows = renderGhost({
    seed,
    width: process.stdout.isTTY ? Math.max(1, Math.min(width, process.stdout.columns - 1)) : width,
    time,
    mode: mode === 'float' || mode === 'curl' ? mode : 'full',
    ...(beat ? { beat } : {}),
  });
  if (time >= seconds * 1000) {
    clearInterval(timer);
    return;
  }
  if (process.stdout.writableNeedDrain) {
    frame++;
    return;
  }
  const prefix = process.stdout.isTTY && drawn ? '\x1b[2A' : '';
  process.stdout.write(
    prefix + rows.map((row) => (process.stdout.isTTY ? '\r\x1b[2K' + row : row)).join('\n') + '\n',
  );
  drawn = true;
  if (++frame >= seconds * 10) clearInterval(timer);
}, 100);
