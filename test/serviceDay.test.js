import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callsAt, previousServiceDay, serviceDay } from '../src/services/irail.js';

const STATION = 'BE.NMBS.008892007';
const OTHER = 'BE.NMBS.008821006';
const at = (iso) => new Date(iso);
const secs = (iso) => Math.floor(Date.parse(iso) / 1000);

describe('serviceDay', () => {
  it('uses the Brussels calendar date, not the UTC one', () => {
    // 22:30 UTC on 22 Sep is 00:30 on 23 Sep in Brussels (CEST).
    expect(serviceDay(at('2026-09-22T22:30:00Z'))).toMatchObject({
      key: '2026-09-23', requestDate: '230926',
    });
  });

  it('formats an ordinary daytime row as DDMMYY', () => {
    expect(serviceDay(at('2026-01-05T09:00:00Z'))).toMatchObject({
      key: '2026-01-05', requestDate: '050126',
    });
  });
});

describe('previousServiceDay', () => {
  const previous = (iso) => previousServiceDay(serviceDay(at(iso)));

  it.each([
    ['ordinary day', '2026-09-23T10:00:00Z', '2026-09-22', '220926'],
    ['month boundary', '2026-10-01T10:00:00Z', '2026-09-30', '300926'],
    ['year boundary', '2026-01-01T10:00:00Z', '2025-12-31', '311225'],
    ['leap day', '2028-03-01T10:00:00Z', '2028-02-29', '290228'],
    // The two nights that are not 24 hours long in Brussels.
    ['day after spring forward', '2026-03-29T22:30:00Z', '2026-03-29', '290326'],
    ['spring-forward day', '2026-03-29T01:30:00Z', '2026-03-28', '280326'],
    ['day after fall back', '2026-10-25T23:30:00Z', '2026-10-25', '251026'],
    ['fall-back day', '2026-10-25T00:30:00Z', '2026-10-24', '241026'],
  ])('%s', (_, iso, key, requestDate) => {
    const result = previous(iso);
    expect(result).toMatchObject({ key, requestDate });
    expect(result.number).toBe(serviceDay(at(iso)).number - 1);
  });

  it('checks that the DST fixtures fall on the Brussels day expected', () => {
    // 22:30 UTC on 29 Mar is already 00:30 on 30 Mar (CEST, +2).
    expect(serviceDay(at('2026-03-29T22:30:00Z')).key).toBe('2026-03-30');
    // 23:30 UTC on 25 Oct is 00:30 on 26 Oct (CET, +1).
    expect(serviceDay(at('2026-10-25T23:30:00Z')).key).toBe('2026-10-26');
  });
});

describe('callsAt', () => {
  const when = at('2026-09-22T22:05:00Z');
  const stop = (fields) => ({ id: STATION, time: null, departure: null, arrival: null, ...fields });

  it('accepts the station at the scheduled time', () => {
    expect(callsAt([stop({ time: when })], STATION, when)).toBe(true);
  });

  it('rejects the station at another time', () => {
    expect(callsAt([stop({ time: at('2026-09-23T22:05:00Z') })], STATION, when)).toBe(false);
  });

  it('rejects another station at the same time', () => {
    expect(callsAt([stop({ id: OTHER, time: when })], STATION, when)).toBe(false);
  });

  it.each([[null], [undefined], [[]]])('rejects %j stops', (stops) => {
    expect(callsAt(stops, STATION, when)).toBe(false);
  });

  it('rejects when no station id is known', () => {
    expect(callsAt([stop({ time: when })], '', when)).toBe(false);
  });

  it.each(['time', 'departure', 'arrival'])('matches on the scheduled %s field', (field) => {
    expect(callsAt([stop({ [field]: when })], STATION, when)).toBe(true);
  });
});

/* --- the shared journey flow ---------------------------------------
   getRoute()/getStops() through the real scheduler, with fetch answering
   per requested `date`. Journeys are cached at module level, so each case
   imports a fresh copy. Real timers: a fallback costs one 400 ms gap. */

describe('journey resolution around midnight', () => {
  let irail;
  let fetchMock;
  let journeys;

  const vehicleStop = (id, iso) => ({
    stationinfo: { id, name: id, standardname: id },
    time: String(secs(iso)),
  });
  const journey = (...stops) => ({ stops: { stop: stops } });

  const requestedDates = () => fetchMock.mock.calls
    .map(([url]) => new URL(url).searchParams.get('date'));

  beforeEach(async () => {
    journeys = {};
    fetchMock = vi.fn(async (url) => {
      const body = journeys[new URL(url).searchParams.get('date')];
      if (!body) return { ok: false, status: 404, statusText: 'Not Found' };
      return { ok: true, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    irail = await import('../src/services/irail.js');
  });

  afterEach(() => vi.unstubAllGlobals());

  // Row: 23 Sep 00:05 Brussels (22:05 UTC on 22 Sep).
  const ROW = at('2026-09-22T22:05:00Z');

  it('falls back to the previous service day for a train that set off before midnight', async () => {
    // 23 Sep's run of the same number: a 200, but a different day's train.
    journeys['230926'] = journey(
      vehicleStop(OTHER, '2026-09-23T21:42:00Z'),
      vehicleStop(STATION, '2026-09-23T22:05:00Z'));
    // 22 Sep's run, which left at 23:42 and calls here at 00:05.
    journeys['220926'] = journey(
      vehicleStop(OTHER, '2026-09-22T21:42:00Z'),
      vehicleStop(STATION, '2026-09-22T22:05:00Z'),
      vehicleStop('BE.NMBS.008891009', '2026-09-22T22:20:00Z'));

    const route = await irail.getRoute('BE.NMBS.IC1234', STATION, ROW);
    expect(route.map((s) => s.time.getTime())).toEqual([
      Date.parse('2026-09-22T21:42:00Z'),
      Date.parse('2026-09-22T22:05:00Z'),
      Date.parse('2026-09-22T22:20:00Z'),
    ]);
    expect(requestedDates()).toEqual(['230926', '220926']);

    // The board's "via" list is a view of the same entry: no new request.
    const stops = await irail.getStops('BE.NMBS.IC1234', STATION, ROW);
    expect(stops.status).toBe('ok');
    expect(stops.stops.map((s) => s.id)).toEqual(['BE.NMBS.008891009']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never accepts a wrong-day 200 when the fallback does not validate either', async () => {
    journeys['230926'] = journey(vehicleStop(STATION, '2026-09-23T22:05:00Z'));
    journeys['220926'] = journey(vehicleStop(STATION, '2026-09-22T22:10:00Z'));

    expect(await irail.getRoute('BE.NMBS.IC1234', STATION, ROW)).toBeNull();
    expect(await irail.getStops('BE.NMBS.IC1234', STATION, ROW))
      .toEqual({ status: 'unavailable', stops: null });
    expect(requestedDates()).toEqual(['230926', '220926']);
  });

  it('accepts a train that really starts after midnight with one request', async () => {
    const row = at('2026-09-22T22:35:00Z'); // 00:35 on 23 Sep
    journeys['230926'] = journey(
      vehicleStop(OTHER, '2026-09-22T22:20:00Z'),
      vehicleStop(STATION, '2026-09-22T22:35:00Z'));

    const route = await irail.getRoute('BE.NMBS.S1234', STATION, row);
    expect(route).toHaveLength(2);
    expect(requestedDates()).toEqual(['230926']);
  });

  it('accepts a daytime train with one request', async () => {
    const row = at('2026-09-23T12:05:00Z');
    journeys['230926'] = journey(
      vehicleStop(STATION, '2026-09-23T12:05:00Z'),
      vehicleStop(OTHER, '2026-09-23T12:40:00Z'));

    const stops = await irail.getStops('BE.NMBS.IC1234', STATION, row);
    expect(stops.status).toBe('ok');
    expect(stops.stops.map((s) => s.id)).toEqual([OTHER]);
    expect(requestedDates()).toEqual(['230926']);
  });

  it('rejects a daytime mismatch without probing the previous day', async () => {
    const row = at('2026-09-23T12:05:00Z');
    journeys['230926'] = journey(vehicleStop(STATION, '2026-09-23T13:05:00Z'));
    journeys['220926'] = journey(vehicleStop(STATION, '2026-09-23T12:05:00Z'));

    expect(await irail.getRoute('BE.NMBS.IC1234', STATION, row)).toBeNull();
    expect(requestedDates()).toEqual(['230926']);
  });

  it('treats a daytime 404 as unavailable with one request', async () => {
    const row = at('2026-09-23T12:05:00Z');
    expect(await irail.getStops('BE.NMBS.EUR9123', STATION, row))
      .toEqual({ status: 'unavailable', stops: null });
    expect(requestedDates()).toEqual(['230926']);
  });
});
