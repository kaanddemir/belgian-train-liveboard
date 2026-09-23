import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// irail.js keeps the last good list per language in memory, so every test
// gets a fresh module.
let irail;
let fetchMock;

const item = (fields = {}) => ({
  id: '0',
  title: 'Enghien - Grammont: disrupted traffic',
  description: 'Delays are possible.\n\nCause: damage to a level crossing.',
  type: 'disturbance',
  link: 'https://www.belgiantrain.be/en/notice',
  timestamp: '1790185370',
  richtext: 'Delays are possible.',
  descriptionLinks: { number: '0', descriptionLink: [] },
  ...fields,
});

const response = (items) => ({ version: '1.4', timestamp: '1790187382', disturbance: items });

const serve = (body, { ok = true, status = 200 } = {}) => fetchMock.mockResolvedValueOnce({
  ok,
  status,
  statusText: ok ? 'OK' : 'Error',
  json: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)),
});

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  irail = await import('../src/services/irail.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeDisturbances', () => {
  const normalize = (items) => irail.normalizeDisturbances(response(items));

  it('keeps a disturbance in the internal shape only', () => {
    const [notice] = normalize([item()]);
    expect(notice).toEqual({
      key: expect.any(String),
      type: 'disturbance',
      title: 'Enghien - Grammont: disrupted traffic',
      text: 'Delays are possible.\n\nCause: damage to a level crossing.',
      time: new Date(1790185370 * 1000),
      link: 'https://www.belgiantrain.be/en/notice',
    });
  });

  it('ignores planned works', () => {
    expect(normalize([item({ type: 'planned' })])).toEqual([]);
  });

  it('keeps only the disturbances from a mixed list', () => {
    const list = normalize([
      item({ type: 'planned', title: 'Works A' }),
      item({ title: 'Incident B' }),
      item({ type: 'planned', title: 'Works C' }),
    ]);
    expect(list.map((n) => n.title)).toEqual(['Incident B']);
  });

  it('reads a response without disturbances as an empty list', () => {
    expect(normalize([item({ type: 'planned' })])).toEqual([]);
    expect(irail.normalizeDisturbances({ version: '1.4', timestamp: '1', disturbance: [] })).toEqual([]);
    expect(irail.normalizeDisturbances({ version: '1.4', timestamp: '1' })).toEqual([]);
  });

  it('rejects a structurally unusable response', () => {
    expect(() => irail.normalizeDisturbances(null)).toThrow();
    expect(() => irail.normalizeDisturbances('<html>')).toThrow();
    expect(() => irail.normalizeDisturbances({ error: 'x' })).toThrow();
    expect(() => irail.normalizeDisturbances({ version: '1.4', disturbance: 'x' })).toThrow();
  });

  it('skips a malformed item and keeps the valid ones', () => {
    const list = normalize([item({ title: '' }), null, 'x', item({ title: 42 }), item()]);
    expect(list).toHaveLength(1);
  });

  it.each(['', '0', 'abc', undefined])('keeps an item with timestamp %j but no time', (timestamp) => {
    const [notice] = normalize([item({ timestamp })]);
    expect(notice.time).toBeNull();
  });

  it.each(['javascript:alert(1)', 'ftp://example.com/x', 'not a url', '', undefined])(
    'keeps an item with link %j but no link',
    (link) => {
      const [notice] = normalize([item({ link })]);
      expect(notice).toBeDefined();
      expect(notice.link).toBeNull();
    },
  );

  it('accepts http and https links', () => {
    const [a, b] = normalize([
      item({ title: 'A', link: 'http://www.belgianrail.be/jp/x?a=1&' }),
      item({ title: 'B', link: 'https://www.belgiantrain.be/nl/news/y' }),
    ]);
    expect(a.link).toBe('http://www.belgianrail.be/jp/x?a=1&');
    expect(b.link).toBe('https://www.belgiantrain.be/nl/news/y');
  });

  it('returns descriptions as plain, tidied text', () => {
    const [notice] = normalize([item({ description: '  <b>Line</b> one  \r\n\r\n\r\n\r\nTwo  ' })]);
    expect(notice.text).toBe('<b>Line</b> one\n\nTwo');
    const [empty] = normalize([item({ description: { html: true } })]);
    expect(empty.text).toBe('');
  });

  it('never keys on the positional id, and keeps same-title notices apart', () => {
    const list = normalize([
      item({ id: '0', title: 'Aarschot', timestamp: '1790080424' }),
      item({ id: '1', title: 'Aarschot', timestamp: '1790066855' }),
      item({ id: '2', title: 'Aarschot', timestamp: '1790066855' }),
    ]);
    expect(list).toHaveLength(3);
    expect(new Set(list.map((n) => n.key)).size).toBe(3);
    expect(list.some((n) => n.key === '0' || n.key === '1')).toBe(false);
  });
});

describe('getDisturbances', () => {
  it('fetches the language asked for and caches it', async () => {
    serve(response([item()]));
    const list = await irail.getDisturbances('fr');
    expect(list).toHaveLength(1);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toMatch(/\/disturbances$/);
    expect(url.searchParams.get('lang')).toBe('fr');
    expect(irail.peekDisturbances('fr')).toBe(list);
  });

  it('keeps the last good list when a refresh fails', async () => {
    serve(response([item()]));
    const good = await irail.getDisturbances('en');
    serve({}, { ok: false, status: 503 });
    await expect(irail.getDisturbances('en')).rejects.toThrow();
    serve(new SyntaxError('bad json'));
    await expect(irail.getDisturbances('en')).rejects.toThrow();
    serve({ nope: true });
    await expect(irail.getDisturbances('en')).rejects.toThrow();
    expect(irail.peekDisturbances('en')).toBe(good);
  });

  it('replaces the list with an empty one when the response says so', async () => {
    serve(response([item()]));
    await irail.getDisturbances('en');
    serve(response([item({ type: 'planned' })]));
    await irail.getDisturbances('en');
    expect(irail.peekDisturbances('en')).toEqual([]);
  });

  it('keeps each language separate', async () => {
    serve(response([item({ title: 'Verstoord verkeer' })]));
    await irail.getDisturbances('nl');
    expect(irail.peekDisturbances('de')).toBeNull();
    serve(response([]));
    await irail.getDisturbances('de');
    expect(irail.peekDisturbances('nl')[0].title).toBe('Verstoord verkeer');
    expect(irail.peekDisturbances('de')).toEqual([]);
  });
});
