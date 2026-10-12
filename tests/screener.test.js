/**
 * Saved-screen translation tests — no TradingView connection needed.
 *
 * Run: node --test tests/screener.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScanRequest, parseScreenData, toRow } from '../src/core/screener.js';

const here = dirname(fileURLToPath(import.meta.url));
const screen = () => JSON.parse(readFileSync(join(here, 'fixtures', 'saved_screen_stock.json'), 'utf8'));

const key = (f) => JSON.stringify(f);

describe('buildScanRequest', () => {
  it('keeps exactly the active filters, in scanner form', () => {
    const { market, body } = buildScanRequest(screen());
    assert.equal(market, 'america');
    // The scan request TradingView's own screener page sends for this screen (captured live).
    const expected = [
      { left: 'close', operation: 'in_range%', right: ['price_52_week_high', 0.95, 1] },
      { left: 'change', operation: 'greater', right: 4 },
      { left: 'SMA120', operation: 'greater', right: 'SMA250' },
      { left: 'price_earnings_ttm', operation: 'in_range', right: [0, 500] },
      { left: 'close', operation: 'greater', right: 'EMA60' },
      { left: 'quick_ratio_fq', operation: 'greater', right: 1 },
      { left: 'SMA60', operation: 'greater', right: 'SMA120' },
    ];
    assert.deepEqual(body.filter.map(key).sort(), expected.map(key).sort());
    assert.deepEqual(body.sort, { sortBy: 'market_cap_basic', sortOrder: 'desc' });
    assert.deepEqual(body.range, [0, 200]);
  });

  it('turns an offset range into a fraction of the 52-week high', () => {
    const s = screen();
    const high = s.filters.find((f) => f.left.column.id === 'Price' && f.target === 'High');
    high.operation.params.offsetRangeId = 'offset_range_5_10';
    const { body } = buildScanRequest(s);
    assert.deepEqual(
      body.filter.find((f) => f.operation === 'in_range%').right,
      ['price_52_week_high', 0.9, 0.95],
    );
  });

  it('refuses an active filter it cannot translate instead of dropping it', () => {
    const s = screen();
    s.filters.find((f) => f.left.column.id === 'Sector').right.values = ['Finance'];
    assert.throws(() => buildScanRequest(s), /Unsupported screener filter type: CheckboxGroup \(Sector\)/);

    const t = screen();
    t.filters.find((f) => f.left.column.id === 'Beta').right.value = 1;
    assert.throws(() => buildScanRequest(t), /Unsupported screener column: Beta/);
  });

  it('refuses a non-daily Change column', () => {
    const s = screen();
    s.filters.find((f) => f.left.column.id === 'Change').left.column.params.resolution = 'TimeResolution1W';
    assert.throws(() => buildScanRequest(s), /Unsupported screener column: Change/);
  });

  it('refuses screens outside the single-market stock screener', () => {
    assert.throws(() => buildScanRequest({ ...screen(), screener_key: 'crypto' }), /screener_key/);
    const multi = screen();
    multi.market_settings.markets = ['america', 'canada'];
    assert.throws(() => buildScanRequest(multi), /single-market/);
  });

  it('refuses a primary-listing-only screen instead of returning a wider list', () => {
    const s = screen();
    s.market_settings.is_primary_listing = true;
    assert.throws(() => buildScanRequest(s), /primary listing/);
  });

  it('sorts by the scanner when asked, so a short limit keeps the true top rows', () => {
    const { body } = buildScanRequest(screen(), { limit: 10, sort: 'change' });
    assert.deepEqual(body.sort, { sortBy: 'change', sortOrder: 'desc' });
    assert.deepEqual(body.range, [0, 10]);
    assert.equal(buildScanRequest(screen(), { sort: 'change', order: 'asc' }).body.sort.sortOrder, 'asc');
    // Without an override the screen's own sort is kept.
    assert.deepEqual(buildScanRequest(screen()).body.sort, { sortBy: 'market_cap_basic', sortOrder: 'desc' });
    assert.throws(() => buildScanRequest(screen(), { sort: 'pe' }), /Unsupported sort field: pe/);
    assert.throws(() => buildScanRequest(screen(), { sort: 'change', order: 'up' }), /Unsupported sort order/);
  });
});

describe('buildScanRequest — Minervini trend template screen', () => {
  const minervini = () => JSON.parse(readFileSync(join(here, 'fixtures', 'saved_screen_minervini.json'), 'utf8'));

  it('sends the scan request TradingView\'s own screener page sends for the screen', () => {
    const { market, body } = buildScanRequest(minervini());
    assert.equal(market, 'america');
    // Captured live from the screener page (Network.requestWillBeSent) for "STL 美股 Mark Minervini".
    const expected = [
      { left: 'EMA50', operation: 'egreater', right: 'EMA150' },
      { left: 'close', operation: 'above%', right: ['price_52_week_low', 1.3] },
      { left: 'market_cap_basic', operation: 'egreater', right: 1000000000 },
      { left: 'EMA150', operation: 'egreater', right: 'EMA200' },
      { left: 'close', operation: 'egreater', right: 'EMA50' },
      { left: 'volume', operation: 'greater', right: 300000 },
      { left: 'Perf.3M', operation: 'greater', right: 20 },
      { left: 'close', operation: 'in_range%', right: ['price_52_week_high', 0.95, 1] },
      { left: 'Perf.6M', operation: 'greater', right: 30 },
    ];
    assert.deepEqual(body.filter.map(key).sort(), expected.map(key).sort());
    assert.deepEqual(body.sort, { sortBy: 'volume', sortOrder: 'asc' });
  });

  it('keeps the screen market for a Taiwan screen', () => {
    const s = minervini();
    s.market_settings.markets = ['taiwan'];
    assert.equal(buildScanRequest(s).market, 'taiwan');
    assert.deepEqual(buildScanRequest(s).body.markets, ['taiwan']);
  });

  it('refuses what it has not checked: a two-sided abovePercent, an upper-only range, an unchecked performance window', () => {
    const a = minervini();
    a.filters.find((f) => f.operation.type === 'abovePercent').operation.params.offsetRangeId = 'offset_range_30_50';
    assert.throws(() => buildScanRequest(a), /Unsupported abovePercent filter on Price/);

    const b = minervini();
    const cap = b.filters.find((f) => f.left.column.id === 'MarketCap');
    cap.right = { left: null, right: 5000000000 };
    assert.throws(() => buildScanRequest(b), /Unsupported one-sided range on MarketCap/);

    const c = minervini();
    c.filters.find((f) => f.left.column.id === 'Performance').left.column.params.interval = 'Interval1M';
    assert.throws(() => buildScanRequest(c), /Unsupported screener column: Performance/);
  });
});

describe('parseScreenData', () => {
  it('reads the object even when strings contain braces and quotes', () => {
    const data = { id: 'abc', title: 'a } "quoted" { title', filters: [] };
    const html = `<script>window.initData.screen_data = ${JSON.stringify(data)};window.x = {};</script>`;
    assert.deepEqual(parseScreenData(html), data);
  });

  it('throws when the page has no screen', () => {
    assert.throws(() => parseScreenData('<html></html>'), /screen_data not found/);
  });
});

describe('toRow', () => {
  it('flattens a scanner row and flags delayed data', () => {
    const view = { name: 'FIGS', description: 'FIGS, Inc.', exchange: 'NYSE', kind: 'delay', 'kind-delay': 900 };
    const row = toRow({ s: 'NYSE:FIGS', d: [view, 17.4, 10.5, 1200, 2.1, 2.9e9, 30, 'Health', 'USD'] });
    assert.deepEqual(row, {
      symbol: 'NYSE:FIGS', ticker: 'FIGS', exchange: 'NYSE', name: 'FIGS, Inc.', price: 17.4, change_pct: 10.5,
      volume: 1200, rel_volume_10d: 2.1, market_cap: 2.9e9, pe: 30, sector: 'Health', currency: 'USD', delayed: true,
    });
    const live = toRow({ s: 'NASDAQ:X', d: [{ name: 'X', kind: 'streaming' }, 1, 1, 1, null, null, null, null, 'USD'] });
    assert.equal(live.delayed, false);
    assert.equal(live.pe, null);
  });
});
