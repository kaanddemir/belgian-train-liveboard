import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// punctuality.js memoises shards per session, so every test gets a fresh
// module: nothing one case fetched can answer the next.
let perf;
let fetchMock;

const NOW = new Date('2026-09-23T10:00:00Z'); // Brussels day 2026-09-23
const TRAIN = '2117';                         // shard 21
const STATION = 'gent-sint-pieters';

const shard = (overrides = {}) => ({
  g: '2026-09-22',
  w: 30,
  a: '1'.repeat(30),
  t: { [TRAIN]: { [STATION]: { n: 25, med: 60, ot: 92, p90: 240 } } },
  ...overrides,
});

const serve = (body, { ok = true } = {}) => fetchMock.mockResolvedValue({
  ok,
  json: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)),
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  perf = await import('../src/services/punctuality.js');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('getPerformance', () => {
  it('evaluates a valid shard', async () => {
    serve(shard());
    const result = await perf.getPerformance(TRAIN, STATION);
    expect(result).toEqual({
      state: 'ok', windowDays: 30, throughDay: null, samples: 25, enough: true,
      medianSec: 60, onTimePct: 92, p90Sec: 240,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/generated\/performance\/21\.json$/);
  });

  it('refuses a shard whose window disagrees with its availability', async () => {
    // 30 days claimed, but only 20 of the last 30 are present.
    serve(shard({ a: '1'.repeat(20) + '0'.repeat(10) }));
    expect(await perf.getPerformance(TRAIN, STATION)).toEqual({ state: 'none' });
  });

  it.each([
    ['missing a', { a: undefined }],
    ['non-binary a', { a: '1'.repeat(29) + 'x' }],
    ['empty a', { a: '' }],
    ['missing t', { t: undefined }],
    ['non-object t', { t: 'nope' }],
    ['missing g', { g: undefined }],
    ['negative w', { w: -1 }],
  ])('returns none for %s', async (_, overrides) => {
    serve(shard(overrides));
    expect(await perf.getPerformance(TRAIN, STATION)).toEqual({ state: 'none' });
  });

  it('returns none on a 404', async () => {
    serve(null, { ok: false });
    expect(await perf.getPerformance(TRAIN, STATION)).toEqual({ state: 'none' });
  });

  it('returns none on unparseable JSON', async () => {
    serve(new SyntaxError('Unexpected token <'));
    expect(await perf.getPerformance(TRAIN, STATION)).toEqual({ state: 'none' });
  });

  it('returns none when the network fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await perf.getPerformance(TRAIN, STATION)).toEqual({ state: 'none' });
  });

  it('is stale when the newest day is more than seven days old', async () => {
    serve(shard({ g: '2026-09-15' })); // 8 days
    expect(await perf.getPerformance(TRAIN, STATION)).toEqual({ state: 'stale' });
  });

  it('is still ok at exactly seven days, naming the day it runs through', async () => {
    serve(shard({ g: '2026-09-16' }));
    const result = await perf.getPerformance(TRAIN, STATION);
    expect(result.state).toBe('ok');
    expect(result.throughDay).toBe('2026-09-16');
  });

  it('returns none for a newest day in the future', async () => {
    serve(shard({ g: '2026-09-24' }));
    expect(await perf.getPerformance(TRAIN, STATION)).toEqual({ state: 'none' });
  });

  it('reports collecting with the days held inside the last ten', async () => {
    serve(shard({ w: 0, a: '1111101' + '0'.repeat(23) }));
    expect(await perf.getPerformance(TRAIN, STATION)).toEqual({
      state: 'collecting', daysAvailable: 6, throughDay: null,
    });
  });

  it('keeps the window but withholds figures below ten samples', async () => {
    serve(shard({ t: { [TRAIN]: { [STATION]: { n: 7 } } } }));
    expect(await perf.getPerformance(TRAIN, STATION)).toEqual({
      state: 'ok', windowDays: 30, throughDay: null, samples: 7, enough: false,
      medianSec: null, onTimePct: null, p90Sec: null,
    });
  });

  it('reports zero samples for a train not seen at this station', async () => {
    serve(shard());
    const result = await perf.getPerformance(TRAIN, 'brugge');
    expect(result).toMatchObject({ state: 'ok', windowDays: 30, samples: 0, enough: false });
  });

  it('makes no request without a usable train number or station key', async () => {
    expect(await perf.getPerformance('', STATION)).toEqual({ state: 'none' });
    expect(await perf.getPerformance(TRAIN, '')).toEqual({ state: 'none' });
    expect(await perf.getPerformance('IC', STATION)).toEqual({ state: 'none' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('hasPerformance', () => {
  it.each([
    [{ state: 'ok', samples: 3 }, true],
    [{ state: 'ok', samples: 25 }, true],
    [{ state: 'collecting', daysAvailable: 4 }, true],
    [{ state: 'stale' }, true],
    [{ state: 'ok', samples: 0 }, false],
    [{ state: 'none' }, false],
    [null, false],
    [undefined, false],
  ])('%j -> %s', (result, expected) => {
    expect(perf.hasPerformance(result)).toBe(expected);
  });
});

describe('shardFor', () => {
  it.each([
    ['', null],
    ['   ', null],
    [null, null],
    [undefined, null],
    ['IC', null],
    ['-5', null],
    ['0', 0],
    ['2117', 21],
    ['99', 0],
  ])('%j -> %s', (input, expected) => {
    expect(perf.shardFor(input)).toBe(expected);
  });
});
