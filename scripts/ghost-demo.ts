import { parseArgs } from 'node:util';
import { renderGhost } from '../src/cli/ghost.js';

const { values } = parseArgs({
  options: {
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
let frame = 0;
const timer = setInterval(() => {
  const rows = renderGhost({ seed, width, time: frame * 100 });
  const prefix = process.stdout.isTTY && frame > 0 ? '\x1b[2A' : '';
  process.stdout.write(
    prefix + rows.map((row) => (process.stdout.isTTY ? '\r\x1b[2K' + row : row)).join('\n') + '\n',
  );
  if (++frame >= seconds * 10) clearInterval(timer);
}, 100);
