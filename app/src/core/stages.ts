// Decode TBH stage keys into human-readable map names.
//
//   3205 -> Hell 2-5      (difficulty 3, act 2, stage 5)
//   2309 -> Nightmare 3-9 (difficulty 2, act 3, stage 9)
//
// Ported from tbh_xp/stages.py.

const DIFFICULTIES: Record<number, string> = {
  1: "Normal",
  2: "Nightmare",
  3: "Hell",
  4: "Torment",
};

export function stageName(key: number): string {
  const k = Math.trunc(Number(key));
  if (!Number.isFinite(k) || k <= 0) return "?";
  const difficulty = Math.floor(k / 1000);
  const act = Math.floor(k / 100) % 10;
  const stage = k % 100;
  const diff = DIFFICULTIES[difficulty] ?? `D${difficulty}`;
  return `${diff} ${act}-${stage}`;
}
