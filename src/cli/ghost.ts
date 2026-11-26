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

export function renderGhost({
  seed,
  width,
  time,
}: {
  seed: number;
  width: number;
  time: number;
}): readonly [string, string] {
  const variation = ((seed >>> 0) % 97) / 97;
  const seconds = time / 1000;
  const phase = (seconds / (28 + variation * 8)) % 1;
  const comet = pulse(phase, 0.21, 0.14);
  const liquid = pulse(phase, 0.46, 0.26);
  const split = pulse(phase, 0.51, 0.16);
  const mist = pulse(phase, 0.81, 0.13);
  const travel = seconds / (6 + variation * 3) + variation;
  const center = (width * 2 - 1) / 2 + Math.max(0, width - 15) * Math.sin(travel);
  const y = 3.05 + 0.23 * Math.sin(seconds * 1.5);
  const spread = split * (6 + Math.sin(seconds * 2));
  const radius = 3.15 + liquid * 3.15 - split * 1.05;
  const height = 2.85 - liquid * 1.35 + split * 1.55;
  const hem = (1 - split) * (1 - liquid);
  const flare = 2.7 + 0.45 * Math.sin(seconds * 2);
  const tail = center - Math.cos(travel) * comet * 10;
  const blink = seconds % (4 + variation) < 0.16 && seconds > 1;
  const faceCenters = split > 0.62 ? [center - spread, center + spread] : [center];
  const body = (x: number, row: number, cx: number, cy: number, rx: number, ry: number) => {
    const distance = ((x - cx) / rx) ** 2 + ((row - cy) / ry) ** 2;
    return Math.max(0, 1 - distance / 2) ** 2;
  };
  function renderRow(offset: number): string {
    let row = '';
    for (let column = 0; column < width; column++) {
      let bits = 0;
      for (const [dy, masks] of dots.entries()) {
        for (const [dx, mask] of masks.entries()) {
          const x = column * 2 + dx;
          const py = offset + dy;
          const lean = hem * (py - y) * 0.26;
          const field =
            (body(x + lean, py, center - spread, y, radius, height) +
              body(x + lean, py, center + spread, y, radius, height) +
              comet * body(x, py, tail, y + 1, 5, 1.5) +
              hem * 0.94 * body(x, py, center - 0.25, y + 2.25, 3.3, 1.5) +
              hem * body(x, py, center - flare - 0.65, y + 2.9, 1.85, 1.75) +
              hem * 0.94 * body(x, py, center + flare, y + 2.65, 1.7, 1.65)) *
            (1 - mist);
          const vapor =
            mist *
            (body(x, py, center - 8 * mist, y - 2 * mist, 2, 1.5) +
              body(x, py, center + 7 * mist, y + 2 * mist, 2.5, 1.5));
          const eye =
            !blink &&
            mist < 0.4 &&
            py === Math.round(y) &&
            faceCenters.some((cx) => Math.abs(x - Math.round(cx)) === (split > 0.62 ? 1 : 2));
          if (!eye && field + vapor > 0.56) bits |= mask;
        }
      }
      row += bits ? String.fromCodePoint(0x2800 + bits) : ' ';
    }
    return row.trimEnd();
  }
  return [renderRow(0), renderRow(4)];
}
