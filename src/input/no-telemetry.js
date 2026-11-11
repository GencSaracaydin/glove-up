// MediaPipe's usage statistics, switched off (R5, RV-INPUT-05 / RV-RELEASE-01).
//
// @mediapipe/tasks-vision 1.1.1 gives every landmarker a usage logger with no option to turn it off: it
// queues an init event, latency figures and a closing summary, and POSTs them to
// https://odml.pa.googleapis.com/v1/log (protobuf, with an API key from the wasm) every 60 s and whenever
// the landmarker is closed (a GPU → CPU switch, a model switch, stopping the camera). Glove Up contacts no
// host but its own server, so the detection worker (pose-worker.js) and the main-thread tracker
// (pose-tracker.js, also the worker's fallback) install this guard at module scope, before any
// landmarker exists.
//
// How it works: the logger looks up the global `fetch` each time it sends. The guard answers that one
// host locally with an empty 204 and makes no network request. tasks-vision treats any status but 200 as
// a failed send: the logger sets its error flag, drops its queue and clears its 60 s timer, so each
// landmarker calls fetch at most once, and that call never leaves the page. Every other request passes
// through to the real fetch unchanged (same arguments, same `this`).
//
// Pure module: no side effect until blockMediapipeTelemetry() is called.

/** Hosts whose requests are answered locally (MediaPipe Tasks' usage logger). */
export const TELEMETRY_HOSTS = Object.freeze(['odml.pa.googleapis.com']);

/**
 * The host name a fetch() call would contact ('' if it can't be read).
 * @param {unknown} input  a URL string, a URL, a Request or anything with a `url`
 * @param {string} [base]  base for relative URLs (the page's or worker's location)
 */
export function fetchHost(input, base) {
  try {
    const href = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : String(input));
    return new URL(href, base || undefined).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Wrap `scope.fetch` so requests to TELEMETRY_HOSTS resolve to an empty 204 without a network request.
 * Idempotent (a second call on the same scope does nothing); a scope without fetch is left alone.
 * The installed function carries `__gloveGuard: true` and counts the requests it answered in `blocked`.
 * @param {object} [scope]  the global object: `self` in the worker, `globalThis` on the page
 * @returns {boolean} true if the guard is in place (now or from an earlier call)
 */
export function blockMediapipeTelemetry(scope = globalThis) {
  const orig = scope && scope.fetch;
  if (typeof orig !== 'function') return false;
  if (orig.__gloveGuard) return true;
  const guard = function fetch(input, init) {
    const host = fetchHost(input, scope.location && scope.location.href);
    if (TELEMETRY_HOSTS.includes(host)) {
      guard.blocked++;
      return Promise.resolve(new Response(null, { status: 204, statusText: 'No Content' }));
    }
    return orig.call(scope, input, init);
  };
  guard.__gloveGuard = true;
  guard.blocked = 0;
  scope.fetch = guard;
  return true;
}
