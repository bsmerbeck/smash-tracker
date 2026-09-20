import type { ReactNode } from 'react';

export interface UnlocksNextMeter {
  sentence: string;
  have: number;
  need: number;
  countLabel: string;
}

export type UnlocksNextMeters =
  | readonly [UnlocksNextMeter]
  | readonly [UnlocksNextMeter, UnlocksNextMeter]
  | readonly [UnlocksNextMeter, UnlocksNextMeter, UnlocksNextMeter];

export interface UnlocksNextProps {
  chip: ReactNode;
  name: string;
  meters: UnlocksNextMeters;
}

// RED stub (#3770): types compile so the named target test fails on a real
// assertion, not a module-resolution error. GREEN implements this next.
export function UnlocksNext(props: UnlocksNextProps) {
  void props;
  return null;
}
