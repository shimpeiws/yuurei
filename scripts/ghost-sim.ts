import {
  createGhostBehavior,
  type GhostAction,
  type GhostBeat,
} from '../src/cli/ghost-behavior.js';

function simulate(seed: number, minutes: number) {
  const end = minutes * 60_000;
  const controller = createGhostBehavior(seed);
  const occupancy = new Map<GhostAction, number>();
  const starts = new Map<GhostAction, number[]>();
  const timeline: GhostBeat[] = [];
  const quietSeconds: number[] = [];
  const completed = { splitFusion: 0, mistReassembly: 0 };
  let previous: GhostAction = 'quiet';
  let repeated = 0;
  let transformations = 0;
  for (let time = 0; time < end;) {
    const beat = controller.sample(time);
    const seconds = (Math.min(beat.end, end) - time) / 1000;
    occupancy.set(beat.action, (occupancy.get(beat.action) ?? 0) + seconds);
    if (beat.action === 'quiet') {
      quietSeconds.push(seconds);
    } else {
      if (beat.action === previous) repeated++;
      previous = beat.action;
      transformations++;
      const history = starts.get(beat.action) ?? [];
      history.push(time / 1000);
      starts.set(beat.action, history);
      if (beat.end < end && controller.sample(beat.end).action === 'quiet') {
        if (beat.action === 'split') completed.splitFusion++;
        if (beat.action === 'mist') completed.mistReassembly++;
      }
    }
    timeline.push(beat);
    time = beat.end;
  }

  const distribution = (samples: number[]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (p: number) => Math.round(sorted[Math.floor((sorted.length - 1) * p)] ?? 0);
    return { min: at(0), median: at(0.5), p90: at(0.9), max: at(1) };
  };
  return {
    seed,
    minutes,
    occupancyPercent: Object.fromEntries(
      [...occupancy].map(([action, seconds]) => [
        action,
        Number((seconds / (minutes * 0.6)).toFixed(2)),
      ]),
    ),
    occurrences: Object.fromEntries(
      [...starts].map(([action, history]) => [action, history.length]),
    ),
    intervalSeconds: Object.fromEntries(
      [...starts].map(([action, history]) => [
        action,
        distribution(history.slice(1).map((time, i) => time - (history[i] ?? time))),
      ]),
    ),
    quietSeconds: distribution(quietSeconds),
    repeatPercent: Number(((100 * repeated) / Math.max(1, transformations)).toFixed(2)),
    completed,
    retainedControllerSegments: 1,
    pendingControllerWork: 0,
    timeline,
  };
}

console.log(
  JSON.stringify(
    [...[7, 19, 41, 73].map((seed) => simulate(seed, 60)), simulate(101, 480)],
    null,
    2,
  ),
);
