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
});
