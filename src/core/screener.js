/**
 * Core screener logic (read-only).
 *
 * Reads a saved TradingView stock screen (https://<host>.tradingview.com/screener/<id>/) and runs it
 * through TradingView's own scan endpoint (https://scanner.tradingview.com/<market>/scan) using the
 * desktop app's authenticated session, so the rows and the data tier (real-time vs delayed) are the
 * ones the screener page itself shows. Nothing is written to TradingView and no tab is navigated:
 * both requests are fetch() calls made from inside an already-open TradingView page. The scan POST is
 * sent as text/plain so the browser does not issue a CORS preflight the scanner rejects.
 *
 * The saved screen is the page's `window.initData.screen_data` JSON; this module translates its
 * active filters into the scanner's `filter` list. Only the column/operation combinations listed
 * below are known to translate faithfully. An active filter this module cannot translate throws,
 * rather than being dropped, because a dropped filter would silently return the wrong list.
 */
import { evaluateAsync, safeString } from '../connection.js';

const SCREEN_ID = /^[A-Za-z0-9]{6,16}$/;
const SCAN_PATH = 'scan?label-product=screener-stock';
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;
// Scanner fields a caller may sort by instead of the saved screen's own sort.
const SORTABLE = new Set(['change', 'market_cap_basic', 'volume', 'close']);

// Scanner columns returned per row. `ticker-view` carries description/exchange and the data kind.
const COLUMNS = [
  'ticker-view', 'close', 'change', 'volume', 'relative_volume_10d_calc',
  'market_cap_basic', 'price_earnings_ttm', 'sector', 'currency',
];

// Universe of the "stock" screener: common/preferred stock, DRs and non-ETF/mutual funds, no pre-IPO.
const STOCK_UNIVERSE = {
  operator: 'and',
  operands: [
    {
      operation: {
        operator: 'or',
        operands: [
          { operation: { operator: 'and', operands: [
            { expression: { left: 'type', operation: 'equal', right: 'stock' } },
            { expression: { left: 'typespecs', operation: 'has', right: ['common'] } },
          ] } },
          { operation: { operator: 'and', operands: [
            { expression: { left: 'type', operation: 'equal', right: 'stock' } },
            { expression: { left: 'typespecs', operation: 'has', right: ['preferred'] } },
          ] } },
          { operation: { operator: 'and', operands: [
            { expression: { left: 'type', operation: 'equal', right: 'dr' } },
          ] } },
          { operation: { operator: 'and', operands: [
            { expression: { left: 'type', operation: 'equal', right: 'fund' } },
            { expression: { left: 'typespecs', operation: 'has_none_of', right: ['etf', 'mutual'] } },
          ] } },
        ],
      },
    },
    { expression: { left: 'typespecs', operation: 'has_none_of', right: ['pre-ipo'] } },
  ],
};

/** Saved-screen column (id + params) → scanner field, or null when not translatable. */
function fieldOf(column) {
  const { id, params = {} } = column || {};
  const daily = params.resolution === undefined || params.resolution === 'TimeResolution1D';
  switch (id) {
    case 'Price': return params.timebased === undefined ? 'close' : null;
    case 'Change': return daily ? 'change' : null;
    case 'MarketCap': return 'market_cap_basic';
    case 'PriceToEarnings': return 'price_earnings_ttm';
    case 'QuickRatio': return params.fiscalPeriod === 'fq' ? 'quick_ratio_fq' : null;
    case 'Ema': return daily && /^\d+$/.test(params.length) ? `EMA${params.length}` : null;
    case 'Ma': return daily && /^\d+$/.test(params.length) ? `SMA${params.length}` : null;
    case 'High': return params.timebased === 'Interval52Weeks' ? 'price_52_week_high' : null;
    default: return null;
  }
}

function describe(column) {
  return `${column?.id ?? '?'}${column?.params && Object.keys(column.params).length ? JSON.stringify(column.params) : ''}`;
}

function requireField(column) {
  const field = fieldOf(column);
  if (field === null) throw new Error(`Unsupported screener column: ${describe(column)}`);
  return field;
}

/** True when the saved filter has no value set (the screen UI keeps unused filters in the list). */
function isInactive(filter) {
  const right = filter.right ?? {};
  switch (filter.type) {
    case 'CheckboxGroup': return !Array.isArray(right.values) || right.values.length === 0;
    case 'RadioGroup':
    case 'Date': return right.value === null || right.value === undefined;
    case 'Condition':
      if (filter.operation?.type === 'between') return right.left == null && right.right == null;
      if (filter.target === 'value') return right.value === null || right.value === undefined;
      return false;
    default: return false;
  }
}

function translateFilter(filter) {
  if (filter.type !== 'Condition') {
    throw new Error(`Unsupported screener filter type: ${filter.type} (${describe(filter.left?.column)})`);
  }
  const left = requireField(filter.left.column);
  const op = filter.operation?.type;
  const right = filter.right ?? {};

  if (op === 'between') {
    if (right.left == null || right.right == null) {
      throw new Error(`Unsupported one-sided range on ${describe(filter.left.column)}`);
    }
    return { left, operation: 'in_range', right: [right.left, right.right] };
  }
  if (op === 'belowPercent') {
    // "within a..b % below the reference": offset_range_<a>_<b> → [1 - b/100, 1 - a/100] of the field.
    const range = /^offset_range_(\d+)_(\d+)$/.exec(filter.operation.params?.offsetRangeId ?? '');
    if (!range || filter.target !== 'High') {
      throw new Error(`Unsupported belowPercent filter on ${describe(filter.left.column)}`);
    }
    const reference = requireField(right.column);
    const [lo, hi] = [1 - Number(range[2]) / 100, 1 - Number(range[1]) / 100];
    return { left, operation: 'in_range%', right: [reference, round(lo), round(hi)] };
  }
  if (op === 'above' || op === 'below') {
    const operation = op === 'above' ? 'greater' : 'less';
    if (filter.target === 'value') {
      if (typeof right.value !== 'number') throw new Error(`Unsupported value on ${describe(filter.left.column)}`);
      return { left, operation, right: right.value };
    }
    return { left, operation, right: requireField(right.column) };
  }
  throw new Error(`Unsupported screener operation: ${op} (${describe(filter.left.column)})`);
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Saved screen (`screen_data`) → scanner request. Pure; throws on anything it cannot translate.
 */
export function buildScanRequest(screen, { limit = DEFAULT_LIMIT, sort, order } = {}) {
  if (screen?.screener_key !== 'stock') {
    throw new Error(`Unsupported screener_key: ${screen?.screener_key}`);
  }
  const markets = screen.market_settings?.markets;
  if (!Array.isArray(markets) || markets.length !== 1) {
    throw new Error('Only single-market screens are supported');
  }
  // A primary-listing-only screen adds a constraint this module does not translate; ignoring it would
  // return a wider list than the screen shows.
  if (screen.market_settings?.is_primary_listing === true) {
    throw new Error('Unsupported screen setting: primary listing only');
  }
  // The saved screen's own sort, unless the caller overrides it.
  if (sort !== undefined && !SORTABLE.has(sort)) {
    throw new Error(`Unsupported sort field: ${sort} (use one of ${[...SORTABLE].join(', ')})`);
  }
  if (order !== undefined && order !== 'asc' && order !== 'desc') {
    throw new Error(`Unsupported sort order: ${order} (use asc or desc)`);
  }
  const sortBy = sort ?? requireField(screen.sort_column);
  const ascending = sort !== undefined ? order === 'asc' : screen.sort_direction === 'asc';
  const filter = (screen.filters ?? []).filter((f) => !isInactive(f)).map(translateFilter);

  return {
    market: markets[0],
    body: {
      columns: COLUMNS,
      filter,
      ignore_unknown_fields: false,
      options: { lang: 'en' },
      range: [0, limit],
      sort: { sortBy, sortOrder: ascending ? 'asc' : 'desc' },
      markets,
      filter2: STOCK_UNIVERSE,
    },
  };
}

/** Extracts the `window.initData.screen_data` object from a screener page's HTML. */
export function parseScreenData(html) {
  const marker = 'window.initData.screen_data = ';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('screen_data not found in the screener page (is the screen id valid and shared with this account?)');
  const from = start + marker.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(html.slice(from, i + 1));
  }
  throw new Error('screen_data is not terminated');
}

/** One scanner row (`{ s, d }`) → flat object. `d` is aligned with COLUMNS. */
export function toRow(item) {
  const [view, close, change, volume, relVolume, marketCap, pe, sector, currency] = item.d;
  const kind = view?.kind ?? null;
  return {
    symbol: item.s,
    ticker: view?.name ?? item.s.split(':').pop(),
    exchange: view?.exchange ?? item.s.split(':')[0],
    name: view?.description ?? null,
    price: close ?? null,
    change_pct: change ?? null,
    volume: volume ?? null,
    rel_volume_10d: relVolume ?? null,
    market_cap: marketCap ?? null,
    pe: pe ?? null,
    sector: sector ?? null,
    currency: currency ?? null,
    delayed: kind === 'delay' || Number(view?.['kind-delay']) > 0,
  };
}

/**
 * Reads a saved screen and returns its current rows. Rows come in the screen's own sort order unless
 * `sort` (a scanner field, see SORTABLE) and `order` override it; the override is applied by the
 * scanner before `limit`, so a short limit still returns the true top rows by that field.
 */
export async function read({ id, limit, sort, order } = {}) {
  if (!SCREEN_ID.test(String(id ?? ''))) throw new Error('A screener id is required (the part after /screener/ in its URL)');
  const count = limit === undefined ? DEFAULT_LIMIT : Number(limit);
  if (!Number.isInteger(count) || count < 1 || count > MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }

  const page = await evaluateAsync(`
    (async () => {
      const r = await fetch('/screener/' + ${safeString(id)} + '/', { credentials: 'include' });
      return { status: r.status, html: r.status === 200 ? await r.text() : '' };
    })()
  `);
  if (!page || page.status !== 200) {
    throw new Error(`Could not load screener ${id} (HTTP ${page?.status ?? 'none'}); is TradingView logged in?`);
  }
  const screen = parseScreenData(page.html);
  const { market, body } = buildScanRequest(screen, { limit: count, sort, order });

  const scan = await evaluateAsync(`
    (async () => {
      const r = await fetch('https://scanner.tradingview.com/' + ${safeString(market)} + '/${SCAN_PATH}', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: ${safeString(JSON.stringify(body))},
      });
      return { status: r.status, text: await r.text() };
    })()
  `);
  if (!scan || scan.status !== 200) {
    throw new Error(`Scanner request failed (HTTP ${scan?.status ?? 'none'}): ${String(scan?.text ?? '').slice(0, 200)}`);
  }
  const data = JSON.parse(scan.text);
  const rows = (data.data ?? []).map(toRow);

  return {
    success: true,
    id,
    title: screen.title ?? null,
    screen_updated: screen.date_updated ?? null,
    as_of: new Date().toISOString(),
    market,
    sort: { field: body.sort.sortBy, order: body.sort.sortOrder },
    total_count: data.totalCount ?? rows.length,
    returned: rows.length,
    truncated: (data.totalCount ?? rows.length) > rows.length,
    rows,
  };
}
