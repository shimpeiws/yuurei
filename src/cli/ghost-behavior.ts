export type GhostAction = 'quiet' | 'curl' | 'comet' | 'liquid' | 'split' | 'mist';

export interface GhostBeat {
  action: GhostAction;
  start: number;
  end: number;
}

const actions = [
  { action: 'curl', weight: 46, duration: [5, 9] },
  { action: 'comet', weight: 25, duration: [5, 8] },
  { action: 'liquid', weight: 15, duration: [6, 10] },
  { action: 'split', weight: 9, duration: [9, 15] },
  { action: 'mist', weight: 5, duration: [8, 14] },
] as const;

export function createGhostBehavior(seed: number) {
  let randomState = seed >>> 0;
  const random = () => {
    randomState = (randomState + 0x6d2b79f5) >>> 0;
    let bits = Math.imul(randomState ^ (randomState >>> 15), randomState | 1);
    bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
    return ((bits ^ (bits >>> 14)) >>> 0) / 0x100000000;
  };
  const quiet = (start: number): GhostBeat => {
    const rest = 0.5 + 0.5 * Math.sin(start / 105_000 + ((seed >>> 0) % 31));
    return { action: 'quiet', start, end: start + 1000 * (5 + 9 * rest + 28 * random()) };
  };
  let beat = quiet(0);
  let previous: GhostAction = 'quiet';
  return {
    sample(elapsedMs: number): GhostBeat {
      while (elapsedMs >= beat.end) {
        const start = beat.end;
        if (beat.action !== 'quiet') {
          previous = beat.action;
          beat = quiet(start);
          continue;
        }
        const weight = (choice: (typeof actions)[number]) =>
          choice.weight * (choice.action === previous ? 0.72 : 1);
        let draw = random() * actions.reduce((total, choice) => total + weight(choice), 0);
        const choice = actions.find((entry) => (draw -= weight(entry)) < 0) ?? actions[0];
        const [min, max] = choice.duration;
        beat = { action: choice.action, start, end: start + 1000 * (min + (max - min) * random()) };
      }
      return beat;
    },
  };
}
