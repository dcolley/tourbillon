import { LOGO_GEOMETRY, logoPaths } from '@/lib/gear-path';

type LogoProps = {
  size?: number;
  className?: string;
};

export function Logo({ size = 32, className }: LogoProps) {
  const { outer, inner } = logoPaths();
  const { outer: outerColor, inner: innerColor } = LOGO_GEOMETRY.colors;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      fill="none"
      className={className}
      aria-hidden
    >
      <path d={outer} fill={outerColor} />
      <path d={inner} fill={innerColor} fillRule="evenodd" />
    </svg>
  );
}
