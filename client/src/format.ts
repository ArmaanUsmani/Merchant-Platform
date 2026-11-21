export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} sec`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} hr` : `${Math.round(h / 24)} days`;
}
export const percent = (x: number) => `${Math.round(x * 100)}%`;
