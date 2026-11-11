// Test doubles for core/storage.js: a localStorage-like backend that can throw, hit a quota
// or hold corrupt JSON. Imported by the other storage-*.test.mjs files; the cases at the
// bottom check the fake itself so the failure tests can trust it.
import { test, assert } from '../harness.mjs';

/** QuotaExceededError like browsers throw from setItem. */
export function quotaError() {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError');
}
/** SecurityError like browsers throw when site data is blocked. */
export function securityError() {
  return new DOMException('Access is denied for this document.', 'SecurityError');
}

/**
 * @param {Object} [opts]
 * @param {(key:string, value:string) => boolean} [opts.failSet]  return true to throw quotaError
 * @param {(key:string) => boolean} [opts.failGet]                return true to throw securityError
 * @param {(key:string) => boolean} [opts.failRemove]
 * @param {number} [opts.quotaChars]   total stored characters allowed (keys + values)
 * @param {boolean} [opts.enumerable]  expose length/key() (default true)
 * @param {Record<string,string>} [opts.seed]
 */
export function makeBackend(opts = {}) {
  const map = new Map(Object.entries(opts.seed ?? {}));
  const calls = { get: [], set: [], remove: [] };
  const used = () => [...map].reduce((n, [k, v]) => n + k.length + v.length, 0);
  const b = {
    map,
    calls,
    opts,
    getItem(k) {
      calls.get.push(k);
      if (opts.failGet?.(k)) throw securityError();
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      calls.set.push(k);
      const s = String(v);
      if (opts.failSet?.(k, s)) throw quotaError();
      if (opts.quotaChars != null) {
        const prev = map.has(k) ? k.length + map.get(k).length : 0;
        if (used() - prev + k.length + s.length > opts.quotaChars) throw quotaError();
      }
      map.set(k, s);
    },
    removeItem(k) {
      calls.remove.push(k);
      if (opts.failRemove?.(k)) throw securityError();
      map.delete(k);
    },
  };
  if (opts.enumerable !== false) {
    Object.defineProperty(b, 'length', { get: () => map.size });
    b.key = (i) => [...map.keys()][i] ?? null;
  }
  return b;
}

/** A deterministic id generator + clock for tests. */
export function makeDeterministic() {
  let n = 0;
  let t = 1_700_000_000_000;
  return {
    idGen: (prefix) => `${prefix}_${++n}`,
    now: () => (t += 1000),
  };
}

/** A minimal MatchResult. */
export function matchResult(id, over = {}) {
  return {
    id, winner: 'p1', method: 'KO', endRound: 2, endClockMs: 83000, scorecards: [],
    stats: { p1: { thrown: 40, landed: 22, blocked: 5, dodged: 3, counters: 2, damageDealt: 100, knockdownsScored: 1 },
      p2: { thrown: 30, landed: 9, blocked: 8, dodged: 1, counters: 0, damageDealt: 40, knockdownsScored: 0 } },
    mode: 'single', opponentId: 'opp-1', ...over,
  };
}

/** A minimal TrainingResult. */
export function trainingResult(id, over = {}) {
  return { id, kind: 'bag', score: 120, medal: 'silver', details: {}, participantId: 'x', ...over };
}

test('storage fakes: backend honours quota, failSet and enumeration', () => {
  const b = makeBackend({ quotaChars: 20 });
  b.setItem('a', '123');
  assert.equal(b.getItem('a'), '123');
  assert.throws(() => b.setItem('b', 'x'.repeat(40)), (e) => e.name === 'QuotaExceededError');
  assert.equal(b.length, 1);
  assert.equal(b.key(0), 'a');
  const f = makeBackend({ failSet: (k) => k === 'no', failGet: (k) => k === 'hidden' });
  assert.throws(() => f.setItem('no', '1'), (e) => e.name === 'QuotaExceededError');
  assert.throws(() => f.getItem('hidden'), (e) => e.name === 'SecurityError');
  const ne = makeBackend({ enumerable: false });
  assert.equal(typeof ne.key, 'undefined');
});
