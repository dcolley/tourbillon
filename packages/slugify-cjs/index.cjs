'use strict';

/**
 * CJS shim for @sindresorhus/slugify.
 *
 * @mastra/core's Rolldown CJS build does `__toESM(require(...), 1)`, which sets
 * `default` to the entire module.exports object. Pure-ESM slugify returns a
 * namespace `{ default: fn }`, so `.default` is not callable. Exporting the
 * function as module.exports makes node-mode interop work.
 */

const slugifyLib = require('slugify');

function slugify(string, options = {}) {
  if (typeof string !== 'string') {
    throw new TypeError(`Expected a string, got \`${typeof string}\``);
  }

  const separator = options.separator ?? '-';
  const lowercase = options.lowercase !== false;

  return slugifyLib(string, {
    replacement: separator === '' ? '' : separator,
    lower: lowercase,
    strict: true,
    trim: true,
  });
}

function slugifyWithCounter() {
  const counts = new Map();
  return (string, options) => {
    const base = slugify(string, options);
    const next = (counts.get(base) ?? 0) + 1;
    counts.set(base, next);
    return next === 1 ? base : `${base}-${next}`;
  };
}

module.exports = slugify;
module.exports.default = slugify;
module.exports.slugifyWithCounter = slugifyWithCounter;
