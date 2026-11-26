import { describe, expect, it } from 'vitest';
import { renderGhost } from './ghost.js';

describe('Wandering Ghost', () => {
  it('renders reproducible two-row Braille frames within the requested width', () => {
    for (const width of [40, 80]) {
      for (const seed of [7, 41]) {
        for (const time of [0, 6000, 15000, 24000, 60000]) {
          const input = { seed, width, time };
          const frame = renderGhost(input);
          expect(frame).toEqual(renderGhost(input));
          expect(frame).toHaveLength(2);
          for (const row of frame) {
            expect(row.length).toBeLessThanOrEqual(width);
            expect(row).toMatch(/^[ \u2801-\u28ff]*$/u);
          }
          expect(frame.join('')).toMatch(/[\u2801-\u28ff]/u);
        }
      }
    }
  });

  it('moves and changes silhouette during an excursion', () => {
    const frame = (time: number) => renderGhost({ seed: 7, width: 80, time });
    expect(frame(0)).not.toEqual(frame(6000));
    expect(frame(6000).map((row) => row.trimStart())).not.toEqual(
      frame(15000).map((row) => row.trimStart()),
    );
  });
  it('separates into two visible bodies and rejoins without resetting position', () => {
    const frame = (time: number) => renderGhost({ seed: 7, width: 40, time });
    expect(frame(22_000)[0].trim()).toMatch(/\S+ {2,}\S+/u);
    expect(frame(30_000)[0].trim()).toMatch(/^\S+$/u);
    const position = (time: number) => frame(time)[0].search(/\S/u);
    const cycleEnd = (40 + (7 / 97) * 8) * 1000;
    expect(Math.abs(position(cycleEnd + 50) - position(cycleEnd - 50))).toBeLessThan(2);
  });

  it('keeps the quiet floating demo free of mist throughout the excursion', () => {
    for (const time of [0, 10_000, 16_000, 25_000, 30_000]) {
      const [head, hem] = renderGhost({ seed: 7, width: 40, time, mode: 'float' });
      expect(head.trim()).toMatch(/^\S+$/u);
      expect(hem.trim()).toMatch(/[\u2801-\u28ff]{4}/u);
    }
  });
  it('preserves the reference silhouette, eyes and hem at terminal resolution', () => {
    expect(
      renderGhost({ seed: 7, width: 24, time: 0, mode: 'still', design: 'reference' }),
    ).toEqual(['          ⣴⢻⡟⣦', '         ⠰⣿⠿⡿⢿⠆']);
  });

  it('curls out of ordinary floating, then returns along the same trajectory', () => {
    const frame = (time: number, mode: 'curl' | 'float') =>
      renderGhost({ seed: 7, width: 40, time, mode });
    expect(frame(0, 'curl')).toEqual(frame(0, 'float'));
    expect(frame(5000, 'curl')).not.toEqual(frame(5000, 'float'));
    expect(frame(9000, 'curl')).toEqual(frame(9000, 'float'));
  });
});
