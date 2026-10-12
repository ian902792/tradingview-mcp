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
      },
      handler: (opts) => core.read({ id: opts.id, limit: opts.limit }),
    }],
  ]),
});
