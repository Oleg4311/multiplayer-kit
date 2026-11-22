import type { Rng } from './types.ts';

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Зерно для действия номер `seq`: партия воспроизводится из начального зерна и журнала, ничего про генератор хранить не нужно. */
export function seedFor(base: number, seq: number): number {
  let h = (base ^ Math.imul(seq + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}
