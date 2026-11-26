import type { GhostBeat } from './ghost-behavior.js';

const dots = [
  [1, 8],
  [2, 16],
  [4, 32],
  [64, 128],
] as const;

function pulse(phase: number, center: number, radius: number): number {
  const distance = Math.min(1, Math.abs(phase - center) / radius);
  return (1 + Math.cos(Math.PI * distance)) / 2;
}

function current(seed: number, time: number): number {
  const index = Math.floor(time);
  const value = (step: number) => {
    const hash = Math.imul(step ^ seed, 0x9e3779b1);
    return (((hash ^ (hash >>> 15)) >>> 0) / 0xffffffff) * 2 - 1;
  };
  const t = time - index;
  const ease = t ** 3 * (10 + t * (-15 + 6 * t));
  return value(index) * (1 - ease) + value(index + 1) * ease;
}

interface Silhouette {
  crown: number;
  shoulder: number;
  flare: number;
  sweep: number;
  fold: number;
}

const silhouettes = {
  sheet: { crown: 3.35, shoulder: 4.25, flare: 2.15, sweep: -1.25, fold: 0.43 },
  petal: { crown: 3.15, shoulder: 4.15, flare: 2.7, sweep: -0.65, fold: 0.64 },
  silk: { crown: 3.55, shoulder: 4.15, flare: 1.75, sweep: -2.1, fold: 0.52 },
} satisfies Record<string, Silhouette>;

const sheetHead = [
  '...####.....',
  '..######....',
  '.########...',
  '.########...',
  '.########...',
] as const;

const canonicalShapes = {
  reference: [...sheetHead, '##########..', '##########..', '.##..#..#...'],
  canonical: [...sheetHead, '##########..', '#########...', '.##..##.#...'],
  scallop: [...sheetHead, '##########..', '##########..', '##.###.##...'],
  rounded: [
    '...#####....',
    '..#######...',
    '.#########..',
    '###########.',
    '###########.',
    '.#########..',
    '..#######...',
    '...#####....',
  ],
} as const;

type CanonicalDesign = Exclude<keyof typeof canonicalShapes, 'rounded'>;

function bitmapField(rows: readonly string[]) {
  const points = Array.from({ length: 12 * 16 }, (_, i) => {
    const x = (i % 16) - 2;
    const y = Math.floor(i / 16) - 2;
    return { x, y, filled: rows[y]?.[x] === '#' };
  });
  const distances = points.map(({ x, y, filled }) => {
    let nearest = Infinity;
    for (const other of points) {
      if (other.filled !== filled) {
        nearest = Math.min(nearest, (x - other.x) ** 2 + (y - other.y) ** 2);
      }
    }
    return (Math.sqrt(nearest) - 0.5) * (filled ? -1 : 1);
  });

  return (x: number, y: number) => {
    const cx = Math.max(-2, Math.min(12.999, x));
    const cy = Math.max(-2, Math.min(8.999, y));
    const ix = Math.floor(cx);
    const iy = Math.floor(cy);
    const index = (iy + 2) * 16 + ix + 2;
    const mix = (a: number, b: number, t: number) => a + (b - a) * t;
    return (
      mix(
        mix(distances[index] ?? 2, distances[index + 1] ?? 2, cx - ix),
        mix(distances[index + 16] ?? 2, distances[index + 17] ?? 2, cx - ix),
        cy - iy,
      ) + Math.hypot(x - cx, y - cy)
    );
  };
}

const bitmapFields = {
  reference: bitmapField(canonicalShapes.reference),
  canonical: bitmapField(canonicalShapes.canonical),
  scallop: bitmapField(canonicalShapes.scallop),
  rounded: bitmapField(canonicalShapes.rounded),
};

interface Pose {
  x: number;
  y: number;
  bodyLag: number;
  hemLag: number;
  hemLift: number;
  breath: number;
  ripple: number;
  liquid: number;
  stretch: number;
  blink: number;
}

function contour(x: number, y: number, pose: Pose, shape: Silhouette): number {
  const row = y - pose.y;
  const skirt = Math.max(0, (row - 2.4) / 4.6);
  const follow = Math.min(1, Math.max(0, row / 6));
  const offset = pose.bodyLag * follow + (pose.hemLag - pose.bodyLag) * follow ** 3;
  const faceOffset = (Math.round(pose.x) - pose.x) * (1 - follow ** 2);
  const localX = x - pose.x - faceOffset - offset - shape.sweep * skirt ** 2;
  const crown = Math.sqrt(Math.max(0, 1 - ((row - 2.6) / 2.9) ** 2));
  const radius =
    (row < 2.6
      ? shape.crown * crown + (shape.shoulder - shape.crown) * crown ** 2
      : shape.shoulder + shape.flare * skirt ** 1.45) *
      pose.breath +
    pose.liquid * 4;
  const fold = Math.cos(localX * 0.85 + pose.ripple);
  const bottom = 7.05 - 0.045 * localX ** 2 + shape.fold * fold + pose.hemLift - pose.liquid * 1.6;
  const trailing = Math.max(0, -localX * pose.stretch) * skirt;
  return Math.max(-row - 0.2 - pose.liquid, row - bottom, Math.abs(localX) - radius - trailing);
}

export function renderGhost({
  seed,
  width,
  time,
  mode = 'full',
  design = 'canonical',
  beat,
}: {
  seed: number;
  width: number;
  time: number;
  mode?: 'full' | 'float' | 'still' | 'curl';
  design?: keyof typeof silhouettes | CanonicalDesign;
  beat?: GhostBeat;
}): readonly [string, string] {
  const legacy = design === 'sheet' || design === 'petal' || design === 'silk';
  const shape = legacy ? silhouettes[design] : silhouettes.sheet;
  const canonical = bitmapFields[legacy ? 'canonical' : design];
  const variation = ((seed >>> 0) % 97) / 97;
  const seconds = time / 1000;
  const phase = (seconds / (40 + variation * 8)) % 1;
  const progress = beat ? (time - beat.start) / (beat.end - beat.start) : phase;
  const action = beat?.action;
  const act = (name: GhostBeat['action'], peak: number, span: number) =>
    action === name ? pulse(progress, peak, span) : 0;
  const showcase = (peak: number, span: number) =>
    !beat && mode === 'full' ? pulse(phase, peak, span) : 0;
  const curl =
    mode === 'curl'
      ? pulse(seconds, 5, 3.5)
      : Math.max(
          showcase(0.32, 0.105),
          showcase(0.65, 0.075),
          act('curl', 0.5, 0.48),
          act('split', 0.15, 0.15),
          act('split', 0.85, 0.15),
        );
  const comet = Math.max(showcase(0.3, 0.09), act('comet', 0.52, 0.46));
  const liquid = Math.max(
    showcase(0.44, 0.16),
    act('liquid', 0.52, 0.45),
    act('split', 0.32, 0.25),
  );
  const split = Math.max(showcase(0.54, 0.115), act('split', 0.55, 0.32));
  const smoke = Math.max(showcase(0.77, 0.08), act('mist', 0.37, 0.36));
  const mist = Math.max(showcase(0.81, 0.07), act('mist', 0.59, 0.36));
  const morph = Math.max(
    showcase(0.43, 0.18),
    showcase(0.56, 0.15),
    showcase(0.78, 0.105),
    act('split', 0.52, 0.42),
    act('mist', 0.48, 0.46),
    liquid,
    smoke,
  );
  const mid = width - 0.5;
  const reach = Math.max(0, width - 19);
  const motion = (t: number) => {
    const angle =
      t / (8.8 + variation * 3) +
      variation +
      0.58 * current(seed, t / 17) +
      0.62 * current(seed + 101, t / 82);
    // Rounded dwell at either end of the excursion.
    const wave = Math.sin(angle);
    return mid + reach * (1.5 * wave - 0.5 * wave ** 3);
  };
  const bob = (t: number) => 0.62 * current(seed + 7, t / 3.9) + 0.28 * current(seed + 29, t / 7.1);
  const moving = mode !== 'still';
  const x = moving ? motion(seconds) : mid;
  const velocity = moving ? (motion(seconds + 0.25) - motion(seconds - 0.25)) / 0.5 : 0;
  const blinkPeriod = Math.floor(seconds / 15);
  const blinkAt = 7.5 + 5 * current(seed + 173, blinkPeriod);
  const gaze = moving ? Math.round(current(seed + 199, seconds / 19) * 0.74) : 0;
  const pose: Pose = {
    x,
    y: moving ? bob(seconds) : 0,
    bodyLag: moving ? motion(seconds - 0.22) - x : 0,
    hemLag: moving ? motion(seconds - 0.52) - x : 0,
    hemLift: moving
      ? bob(seconds - 0.48) - bob(seconds) + 0.29 * current(seed + 11, seconds / 1.8)
      : 0,
    breath: moving ? 1 + 0.038 * current(seed + 37, seconds / 2.4) : 1,
    ripple: moving ? 0.55 + 0.8 * current(seed + 53, seconds / 2.7) : 0.55,
    liquid,
    stretch: Math.tanh(velocity / 4) * (0.09 + comet * 0.53),
    blink: moving ? pulse(seconds % 15, blinkAt, 0.19) : 0,
  };
  const separation = split * (8.3 + 0.8 * Math.sin(seconds * 1.4));
  const scale = 1 - split * 0.29;
  const twins = [-1, 1].map((side): Pose => ({
    ...pose,
    x: pose.x + side * separation,
    y: pose.y + split * Math.sin(seconds * (side < 0 ? 1.7 : 2.1)) * 0.63,
  }));

  const faceX = Math.round(x);
  const faceY = Math.round(pose.y * 0.72);
  const faces = split > 0.55 ? twins : [pose];

  function sheetDistance(px: number, py: number): number {
    const depth = Math.min(1, Math.max(0, (py - faceY - 3) / 4));
    const lag = depth * (pose.bodyLag * 0.44 + depth * pose.hemLag * 0.63) * (1 - curl * 0.75);
    const wave = moving ? depth ** 2 * 0.35 * Math.cos((px - faceX) * 0.72 + pose.ripple) : 0;
    const spread = moving ? 0.11 * current(seed + 67, seconds / 3.3) : 0;
    const lx =
      (px - faceX - lag + depth * Math.tanh(velocity / 4) * comet * 5) /
        (1 + depth * (pose.breath - 1 + spread + comet * 0.48)) +
      5;
    const ly = py - faceY - depth * pose.hemLift * 0.55 - wave;
    const sheet = canonical(lx, ly);
    if (curl === 0) return sheet;
    return sheet * (1 - curl) + bitmapFields.rounded(lx, ly) * curl;
  }

  function pixel(px: number, py: number): boolean {
    if (!legacy && morph === 0 && mist === 0) {
      const eye =
        pose.blink < 0.7 &&
        (py === faceY + 2 || py === faceY + 3) &&
        (px === faceX + gaze - 2 || px === faceX + gaze + 1);
      return !eye && sheetDistance(px, py) <= 0;
    }
    const distances = twins.map((twin) => {
      const x = twin.x + (px - twin.x) / scale;
      const y = 2 + (py - 2) / (1 - split * 0.15);
      return contour(x, y, twin, shape);
    });
    const [a = Infinity, b = Infinity] = distances;
    const join = Math.max(0, 1 - Math.abs(a - b) / 2.4);
    const outline = Math.min(a, b) - split * 0.6 * join ** 2;
    const smokeShift = smoke * (py - 2) * Math.sin(seconds * 2);
    const cloud = Math.min(
      Math.hypot((px - x + smokeShift + mist * 8) / 2, (py - 2.2 - pose.y) / 1.3),
      Math.hypot((px - x - smokeShift - mist * 7) / 2.8, (py - 4.5 - pose.y) / 1.4),
    );
    const body =
      legacy || morph >= 1 ? outline : sheetDistance(px, py) * (1 - morph) + outline * morph;
    const signed = body * (1 - mist) + (cloud - 0.8) * mist + smoke * 0.25;
    if (signed > 0) return false;
    const eye =
      mist < 0.4 &&
      faces.some((face) => {
        const eyeCenter = Math.round(face.x) + (legacy ? 1 : gaze);
        const eyeRow = legacy ? Math.round(2.55 + face.y) : Math.round(face.y * 0.72) + 2;
        return (
          pose.blink < 0.7 &&
          (px === eyeCenter - 2 || px === eyeCenter + (legacy ? 2 : 1)) &&
          (py === eyeRow || py === eyeRow + 1)
        );
      });
    return !eye;
  }

  function renderRow(offset: number): string {
    let row = '';
    for (let column = 0; column < width; column++) {
      let bits = 0;
      // Pixels outside the creature's excursion cannot intersect any contour.
      if (Math.abs(column * 2 - x) < 30) {
        for (const [dy, masks] of dots.entries()) {
          for (const [dx, mask] of masks.entries()) {
            if (pixel(column * 2 + dx, offset + dy)) bits |= mask;
          }
        }
      }
      row += bits ? String.fromCodePoint(0x2800 + bits) : ' ';
    }
    return row.trimEnd();
  }
  return [renderRow(0), renderRow(4)];
}
