import { expect, test } from 'bun:test';
import { decideTier } from '../apps/web/src/lib/tier.js';

/**
 * The billing decision: the one place a mistake either gives an hour of work away
 * or charges for minutes the caller did not get.
 */
const base = {
  previewSeconds: 180,
  agentMaxMinutes: 60,
  minutes: 40,
  paidAgent: false,
  hasUser: false,
  canSpend: false,
};

test('an explicit preview is always a preview, even for someone who could pay', () => {
  expect(
    decideTier({ ...base, asked: 'preview', paidAgent: true, hasUser: true, canSpend: true }),
  ).toEqual({ tier: 'preview', refuse: null });
});

test('a recording shorter than the preview is the whole recording, free', () => {
  expect(decideTier({ ...base, asked: 'full', minutes: 3 })).toEqual({
    tier: 'full',
    refuse: null,
  });
  expect(decideTier({ ...base, asked: 'auto', minutes: 2 })).toEqual({
    tier: 'full',
    refuse: null,
  });
});

test('an account with the minutes gets the whole file', () => {
  expect(decideTier({ ...base, asked: 'auto', hasUser: true, canSpend: true })).toEqual({
    tier: 'full',
    refuse: null,
  });
});

test('an agent with a pass gets the whole file up to the per-call cap, and a 413 past it', () => {
  expect(decideTier({ ...base, asked: 'auto', paidAgent: true }).tier).toBe('full');
  const long = decideTier({ ...base, asked: 'auto', paidAgent: true, minutes: 61 });
  expect(long.refuse?.status).toBe(413);
});

test('asking for the whole file without paying is a 402, never a quiet preview', () => {
  const anon = decideTier({ ...base, asked: 'full' });
  expect(anon.refuse?.status).toBe(402);
  const broke = decideTier({ ...base, asked: 'full', hasUser: true, canSpend: false });
  expect(broke.refuse?.reason).toContain('not enough minutes');
});

test('a private instance transcribes every file in full for anyone', () => {
  expect(decideTier({ ...base, asked: 'full', freeForAll: true })).toEqual({
    tier: 'full',
    refuse: null,
  });
  expect(decideTier({ ...base, asked: 'preview', freeForAll: true }).tier).toBe('preview');
});

test('a browser asking for whatever it is entitled to gets the preview', () => {
  expect(decideTier({ ...base, asked: 'auto' })).toEqual({ tier: 'preview', refuse: null });
  expect(decideTier({ ...base, asked: 'auto', hasUser: true })).toEqual({
    tier: 'preview',
    refuse: null,
  });
});
