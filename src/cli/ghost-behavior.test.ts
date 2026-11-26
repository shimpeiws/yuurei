import { describe, expect, it } from 'vitest';
import { createGhostBehavior, type GhostBeat } from './ghost-behavior.js';
import { renderGhost } from './ghost.js';

function timeline(seed: number, hours: number): GhostBeat[] {
  const controller = createGhostBehavior(seed);
  const beats: GhostBeat[] = [];
  for (let time = 0; time < hours * 3_600_000;) {
    const beat = controller.sample(time);
    expect(beat.start).toBe(time);
    expect(beat.end - beat.start).toBeGreaterThanOrEqual(5000);
    expect(beat.end - beat.start).toBeLessThanOrEqual(42_001);
    beats.push(beat);
    time = beat.end;
  }
  return beats;
}

describe('autonomous ghost behavior', () => {
  it('reproduces behavior independently of the render cadence', () => {
    const sparse = createGhostBehavior(7);
    const dense = createGhostBehavior(7);
    for (let time = 0; time < 60_000; time += 100) dense.sample(time);
    expect(sparse.sample(60_000)).toEqual(dense.sample(60_000));
    expect(timeline(7, 1)).toEqual(timeline(7, 1));
    expect(timeline(7, 1)).not.toEqual(timeline(19, 1));
  });

  it('spends most of an eight-hour session quiet and recovers after every transformation', () => {
    const beats = timeline(101, 8);
    const quiet = beats.filter(({ action }) => action === 'quiet');
    const occupancy = quiet.reduce((total, beat) => total + beat.end - beat.start, 0) / 28_800_000;
    expect(occupancy).toBeGreaterThan(0.68);
    expect(occupancy).toBeLessThan(0.83);
    const changes = beats.filter(({ action }) => action !== 'quiet');
    expect(new Set(changes.map(({ action }) => action)).size).toBe(5);
    expect(Math.max(...quiet.map(({ end, start }) => end - start))).toBeGreaterThan(30_000);
    const mist = changes.filter(({ action }) => action === 'mist');
    const intervals = mist.slice(1).map(({ start }, i) => start - (mist[i]?.start ?? start));
    expect(Math.max(...intervals) - Math.min(...intervals)).toBeGreaterThan(240_000);
    for (const [index, beat] of beats.entries()) {
      if (beat.action !== 'quiet' && index < beats.length - 1) {
        expect(beats[index + 1]?.action).toBe('quiet');
      }
    }
  });

  it('blends every transformation from and back to the ordinary pose', () => {
    for (const action of ['curl', 'comet', 'liquid', 'split', 'mist'] as const) {
      for (const time of [1000, 11000]) {
        const input = { seed: 7, width: 40, time };
        expect(renderGhost({ ...input, beat: { action, start: 1000, end: 11000 } })).toEqual(
          renderGhost({ ...input, mode: 'float' }),
        );
      }
    }
  });
});
