import { describe, expect, it } from 'vitest';
import { providersForDestination } from './cloud.js';

describe('backup destination policy', () => {
  it('maps one-destination schedules to one provider', () => {
    expect(providersForDestination('local')).toEqual(['local']);
    expect(providersForDestination('google_drive')).toEqual(['google_drive']);
  });

  it('creates both copies for redundant schedules', () => {
    expect(providersForDestination('both')).toEqual(['local', 'google_drive']);
  });
});
