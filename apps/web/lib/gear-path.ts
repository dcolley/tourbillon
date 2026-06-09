/**
 * SVG path generators for spur and ring gears (trapezoidal tooth profile).
 */

function polar(cx: number, cy: number, r: number, angleDeg: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/**
 * External spur gear — teeth point outward from pitch circle.
 */
export function spurGearPath(
  cx: number,
  cy: number,
  pitchR: number,
  teeth: number,
  toothWidthFactor = 0.42,
  rotationDeg = 0,
): string {
  const addendum = pitchR * 0.12;
  const dedendum = pitchR * 0.14;
  const outerR = pitchR + addendum;
  const rootR = pitchR - dedendum;
  const toothAngle = 360 / teeth;
  const toothWidth = toothAngle * toothWidthFactor;

  const parts: string[] = [];

  for (let i = 0; i < teeth; i++) {
    const base = i * toothAngle + rotationDeg;
    const [x1, y1] = polar(cx, cy, rootR, base - toothWidth / 2);
    const [x2, y2] = polar(cx, cy, outerR, base - toothWidth / 4);
    const [x3, y3] = polar(cx, cy, outerR, base + toothWidth / 4);
    const [x4, y4] = polar(cx, cy, rootR, base + toothWidth / 2);

    if (i === 0) {
      parts.push(`M ${x1} ${y1}`);
    } else {
      parts.push(`L ${x1} ${y1}`);
    }
    parts.push(`L ${x2} ${y2}`, `L ${x3} ${y3}`, `L ${x4} ${y4}`);
  }

  parts.push('Z');
  return parts.join(' ');
}

function circlePath(cx: number, cy: number, r: number): string {
  return `M ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} Z`;
}

/** Spur gear with a circular bore — use with fill-rule="evenodd". */
export function spurGearWithBorePath(
  cx: number,
  cy: number,
  pitchR: number,
  teeth: number,
  boreR: number,
  toothWidthFactor = 0.42,
  rotationDeg = 0,
): string {
  return `${spurGearPath(cx, cy, pitchR, teeth, toothWidthFactor, rotationDeg)} ${circlePath(cx, cy, boreR)}`;
}

/**
 * Ring gear — teeth point inward from the inner edge of the ring.
 */
export function ringGearPath(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  teeth: number,
  options?: {
    toothWidthFactor?: number;
    toothDepthFactor?: number;
    rimWidthFraction?: number;
    rotationDeg?: number;
  },
): string {
  const ringThickness = outerR - innerR;
  /** Solid outer lip — doubled from the original ~15% of ring thickness */
  const outerRimWidth = ringThickness * (options?.rimWidthFraction ?? 0.39);
  const toothRootR = outerR - outerRimWidth;
  const toothZone = toothRootR - innerR;
  const pitchR = (toothRootR + innerR) / 2;
  const addendum = toothZone * (options?.toothDepthFactor ?? 0.35);
  const toothTipR = pitchR - addendum;
  const toothAngle = 360 / teeth;
  const toothWidth = toothAngle * (options?.toothWidthFactor ?? 0.55);
  const rotationDeg = options?.rotationDeg ?? 0;

  const parts: string[] = [];

  // Outer circle (clockwise)
  parts.push(
    `M ${cx + outerR} ${cy}`,
    `A ${outerR} ${outerR} 0 1 1 ${cx - outerR} ${cy}`,
    `A ${outerR} ${outerR} 0 1 1 ${cx + outerR} ${cy}`,
  );

  // Inner toothed edge (counter-clockwise)
  for (let i = teeth - 1; i >= 0; i--) {
    const base = i * toothAngle + rotationDeg;
    const [x1, y1] = polar(cx, cy, toothRootR, base + toothWidth / 2);
    const [x2, y2] = polar(cx, cy, toothTipR, base + toothWidth / 4);
    const [x3, y3] = polar(cx, cy, toothTipR, base - toothWidth / 4);
    const [x4, y4] = polar(cx, cy, toothRootR, base - toothWidth / 2);

    if (i === teeth - 1) {
      parts.push(`M ${x1} ${y1}`);
    } else {
      parts.push(`L ${x1} ${y1}`);
    }
    parts.push(`L ${x2} ${y2}`, `L ${x3} ${y3}`, `L ${x4} ${y4}`);
  }

  parts.push('Z');
  return parts.join(' ');
}

/** Logo geometry constants (100×100 viewBox). */
export const LOGO_GEOMETRY = {
  cx: 50,
  cy: 50,
  outerR: 48,
  innerR: 30,
  outerTeeth: 24,
  outerToothWidthFactor: 0.38,
  outerToothDepthFactor: 0.28,
  outerRotation: 7.5,
  innerPitchR: 48 / Math.sqrt(6),
  innerTeeth: 8,
  innerToothWidthFactor: 0.55,
  /** Center bore as a fraction of inner pitch radius */
  innerBoreR: (48 / Math.sqrt(6)) * 0.52,
  /** Pinion center — bottom-right, meshing without overlap */
  innerCx: 61,
  innerCy: 58.5,
  innerRotation: 3,
  colors: {
    outer: '#6e56a3',
    inner: '#d4b8ff',
  },
} as const;

export function logoPaths() {
  const g = LOGO_GEOMETRY;
  return {
    outer: ringGearPath(g.cx, g.cy, g.outerR, g.innerR, g.outerTeeth, {
      toothWidthFactor: g.outerToothWidthFactor,
      toothDepthFactor: g.outerToothDepthFactor,
      rotationDeg: g.outerRotation,
    }),
    inner: spurGearWithBorePath(
      g.innerCx,
      g.innerCy,
      g.innerPitchR,
      g.innerTeeth,
      g.innerBoreR,
      g.innerToothWidthFactor,
      g.innerRotation,
    ),
  };
}

export function logoSvgMarkup(): string {
  const { outer, inner } = logoPaths();
  const { outer: outerColor, inner: innerColor } = LOGO_GEOMETRY.colors;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none">
  <path d="${outer}" fill="${outerColor}"/>
  <path d="${inner}" fill="${innerColor}" fill-rule="evenodd"/>
</svg>`;
}
