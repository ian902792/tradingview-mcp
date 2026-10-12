import { register } from '../router.js';
import * as core from '../../core/screener.js';

register('screener', {
  description: 'Saved stock screener tools (read)',
  subcommands: new Map([
    ['read', {
      description: 'Run a saved screen and print its rows (read-only; id is the part after /screener/ in its URL)',
      options: {
        id: { type: 'string', description: 'Saved screen id, e.g. W6WUUg3c' },
        limit: { type: 'string', short: 'n', description: 'Max rows (1-500, default 200)' },
        sort: { type: 'string', description: "Sort by a scanner field instead of the screen's own sort: change, market_cap_basic, volume, close" },
        order: { type: 'string', description: 'With --sort: asc or desc (default desc)' },
      },
      handler: (opts) => core.read({ id: opts.id, limit: opts.limit, sort: opts.sort, order: opts.order }),
    }],
  ]),
});
