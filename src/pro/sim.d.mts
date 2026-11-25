import type { TelemetrySnapshot } from './types';

export function createSimulator(opts?: { cores?: number; totalGB?: number }): {
  step(dt?: number): TelemetrySnapshot;
};
