import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasPerformance } from '../src/services/punctuality.js';

// The fixture keeps the selected scene in module state, so every case
// starts from a fresh module.
let mock;

beforeEach(async () => {
  vi.resetModules();
  mock = await import('../src/services/mockBoard.js');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const STATION = { id: 'BE.NMBS.008813003', name: 'Bruxelles-Central' };
const numbers = (board) => board.departures.map((d) => d.trainNumber);

describe('scenario resolution', () => {
  it('maps the original switch to the full board', () => {
    expect(mock.resolveScenario('1')).toBe('full');
  });

  it('keeps every named scene', () => {
    for (const name of mock.MOCK_SCENARIOS) expect(mock.resolveScenario(name)).toBe(name);
    expect(mock.MOCK_SCENARIOS).toEqual(expect.arrayContaining([
      'full', 'notices', 'performance', 'loading', 'empty', 'offline', 'overnight',
    ]));
  });

  it('falls back to the full board for anything unknown', () => {
    expect(mock.resolveScenario('nope')).toBe('full');
    expect(mock.resolveScenario('')).toBe('full');
    expect(mock.resolveScenario('__proto__')).toBe('full');
  });
});

describe('determinism', () => {
  it('builds the same board whatever the clock says, without randomness', async () => {
    const random = vi.spyOn(Math, 'random');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T08:00:00Z'));
    const first = await mock.getMockLiveboard(STATION);
    vi.setSystemTime(new Date('2031-06-15T20:37:00Z'));
    const second = await mock.getMockLiveboard(STATION);
    expect(second.departures.map((d) => d.id)).toEqual(first.departures.map((d) => d.id));
    expect(mock.mockNow().toISOString()).toBe('2026-09-23T16:00:00.000Z');
    expect(random).not.toHaveBeenCalled();
  });

  it('crosses midnight in the overnight scene', async () => {
    mock.selectMockScenario('overnight');
    expect(mock.mockNow().toISOString()).toBe('2026-09-23T21:40:00.000Z');
    const board = await mock.getMockLiveboard(STATION);
    const [train] = board.departures;
    const route = await mock.getMockRoute(train.vehicleId, STATION);
    const day = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/Brussels' });
    expect(day(route[0].time)).toBe('2026-09-23');
    expect(day(route.at(-1).time)).toBe('2026-09-24');
    const times = route.map((s) => s.time.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe('board scenes', () => {
  it('covers left, cancelled, changed-platform and extra rows on the full board', async () => {
    const { departures } = await mock.getMockLiveboard(STATION);
    expect(departures.some((d) => d.left)).toBe(true);
    expect(departures.some((d) => d.cancelled)).toBe(true);
    expect(departures.some((d) => d.platformChanged)).toBe(true);
    expect(departures.some((d) => d.extra)).toBe(true);
    expect(departures.some((d) => d.platform === null)).toBe(true);
  });

  it('draws arrivals from the same scene', async () => {
    const arrivals = await mock.getMockLiveboard(STATION, 'arrivals');
    expect(arrivals.departures.every((d) => d.arrival)).toBe(true);
    expect(numbers(arrivals)).toContain('2514');       // terminates here
    expect(numbers(arrivals)).not.toContain('5125');   // starts here
  });

  it('has an empty and a few-row board', async () => {
    mock.selectMockScenario('empty');
    expect((await mock.getMockLiveboard(STATION)).departures).toEqual([]);
    mock.selectMockScenario('few');
    expect((await mock.getMockLiveboard(STATION)).departures.length).toBeGreaterThan(0);
    expect((await mock.getMockLiveboard(STATION)).departures.length).toBeLessThan(5);
  });

  it('fails the liveboard like a network error in the offline scene', async () => {
    mock.selectMockScenario('offline');
    await expect(mock.getMockLiveboard(STATION)).rejects.toThrow();
  });

  it('carries a localised alert only in the notices scene', async () => {
    expect((await mock.getMockLiveboard(STATION)).alerts).toEqual([]);
    mock.selectMockScenario('notices');
    const nl = await mock.getMockLiveboard(STATION, 'departures', 'nl');
    const de = await mock.getMockLiveboard(STATION, 'departures', 'de');
    expect(nl.alerts).toHaveLength(1);
    expect(nl.alerts[0]).not.toBe(de.alerts[0]);
  });
});

describe('disturbances', () => {
  it('surfaces only disturbances in the notices scene, per language', async () => {
    expect(await mock.getMockDisturbances('en')).toEqual([]);
    mock.selectMockScenario('notices');
    const en = await mock.getMockDisturbances('en');
    const fr = await mock.getMockDisturbances('fr');
    expect(en).toHaveLength(2);
    expect(en.every((n) => n.type === 'disturbance' && n.time && n.link)).toBe(true);
    expect(en[0].title).not.toBe(fr[0].title);
    expect(en[1].text.split('\n\n').length).toBeGreaterThan(2);
  });

  it('keeps edge-case fixtures in the production shape', async () => {
    const { normalizeDisturbances } = await import('../src/services/irail.js');
    const run = (key) => normalizeDisturbances(mock.disturbanceResponse(mock.DISTURBANCE_FIXTURES[key]('en')));
    expect(run('none')).toEqual([]);
    expect(run('one')).toHaveLength(1);
    expect(run('many')).toHaveLength(2);
    expect(run('plannedOnly')).toEqual([]);
    expect(run('mixed')).toHaveLength(2);
    const edges = run('edges');
    expect(edges.map((n) => n.title)).toEqual(['No time given', 'Bad time', 'Bad link']);
    expect(edges[0].time).toBeNull();
    expect(edges[1].time).toBeNull();
    expect(edges[1].link).toBe('http://www.belgianrail.be/');
    expect(edges[2].link).toBeNull();
  });
});

describe('performance scene', () => {
  const open = async (number) => {
    mock.selectMockScenario('performance');
    const { departures } = await mock.getMockLiveboard(STATION);
    const d = departures.find((x) => x.trainNumber === number);
    const route = await mock.getMockRoute(d.vehicleId, STATION);
    const performance = await mock.getMockPerformance(number);
    const occupancy = route?.find((s) => s.id === STATION.id)?.occupancy ?? null;
    return {
      perf: hasPerformance(performance), map: Boolean(route), occupancy, performance,
    };
  };

  it.each([
    ['1832', true, true, null],      // Performance + Map
    ['9412', true, false, null],     // Performance only
    ['2134', false, true, null],     // Map only
    ['14', false, false, null],      // neither: no footer
    ['4287', true, true, 'low'],     // occupancy + Performance + Map
    ['3311', true, true, null],      // collecting + Map
    ['4521', true, false, null],     // stale, no Map
  ])('train %s', async (number, perf, map, occupancy) => {
    const result = await open(number);
    expect(result.perf).toBe(perf);
    expect(result.map).toBe(map);
    expect(result.occupancy).toBe(occupancy);
  });

  it('gives each footer case its intended state', async () => {
    expect((await open('3311')).performance.state).toBe('collecting');
    expect((await open('4521')).performance).toEqual({ state: 'stale' });
    expect((await open('2134')).performance).toEqual({ state: 'none' });
    expect((await open('1832')).performance).toMatchObject({ state: 'ok', p90Sec: null });
    expect((await open('4287')).performance).toMatchObject({ state: 'ok', p90Sec: 660 });
    expect((await open('1852')).performance).toMatchObject({ state: 'ok', enough: false, samples: 4 });
    expect((await open('9412')).performance.medianSec).toBeLessThan(0);
  });
});

describe('loading scene', () => {
  it('resolves the two trains in opposite orders, on fixed delays', async () => {
    vi.useFakeTimers();
    mock.selectMockScenario('loading');
    const order = [];
    const track = (label, promise) => promise.then(() => order.push(label));
    track('perf-1832', mock.getMockPerformance('1832'));
    track('route-1832', mock.getMockRoute('BE.NMBS.IC1832', STATION));
    track('perf-4287', mock.getMockPerformance('4287'));
    track('route-4287', mock.getMockRoute('BE.NMBS.S104287', STATION));
    await vi.advanceTimersByTimeAsync(2000);
    expect(order.indexOf('perf-1832')).toBeLessThan(order.indexOf('route-1832'));
    expect(order.indexOf('route-4287')).toBeLessThan(order.indexOf('perf-4287'));
  });
});
