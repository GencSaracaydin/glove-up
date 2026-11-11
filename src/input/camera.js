// Camera access for Glove Up: opens the webcam (or a looping video clip acting as a fake
// camera) into an HTMLVideoElement that PoseTracker reads from.
//
// Every failure is turned into a CameraError with a stable `code` and a message written
// for players (what happened + how to fix it). ERR01: the camera-setup screen keeps the
// session in setup and shows `error.message` / `error.help` until the player can proceed.
// The help text names the screens' retry button, "Try again" (camera-setup, tracking-lost).
//
// A camera that stops mid-session (FLOWS-02): the track's 'ended' event calls onEnded(err); a
// track muted for longer than `mutedErrorMs` calls onInterrupted(err), and onInterrupted(null) when
// it delivers frames again. cam.isEnded() lets the input hub double-check the track every few frames.
//
// Frame rate (PERF-06): openCamera({frameRate: 60}) asks for 60 fps (a camera without a 60 fps mode
// still opens, at its own rate). cam.frameRate is the rate the track runs at, cam.maxFrameRate what the
// camera can do (track capabilities), and cam.setFrameRate(fps) changes it on the fly with
// applyConstraints (same resolution; lowering is a frame decimation in the browser, no camera restart).
//
// Pure module: no DOM access at import time (safe to import in Node).

/** Default capture constraints: VGA at 30 fps is plenty for pose tracking and cheap to process (the input hub asks for 60 when it can use it). */
export const CAMERA_DEFAULTS = Object.freeze({
  width: 640,
  height: 480,
  frameRate: 30,
  facingMode: 'user',
  /** How long to wait for the first decoded frame after the stream/file opened. */
  firstFrameTimeoutMs: 8000,
  /** A track muted (no frames) this long counts as a stopped camera until it unmutes. */
  mutedErrorMs: 2500,
});

/** Stable error codes (use these in UI logic, never the message text). */
export const CameraErrorCode = Object.freeze({
  INSECURE: 'insecure',               // page not served from https:// or localhost
  UNSUPPORTED: 'unsupported',         // no getUserMedia in this browser
  DENIED: 'denied',                   // NotAllowedError / SecurityError
  NOT_FOUND: 'not-found',             // NotFoundError: no camera
  BUSY: 'busy',                       // NotReadableError: used by another app
  OVERCONSTRAINED: 'overconstrained', // OverconstrainedError: selected camera can't do it
  ABORTED: 'aborted',                 // AbortError: hardware failed to start
  NO_FRAMES: 'no-frames',             // stream opened but no frame arrived in time
  VIDEO_FILE: 'video-file',           // clip could not be loaded / decoded
  UNKNOWN: 'unknown',
});

/** Player-facing titles per code (screens may show them above the message). */
export const CAMERA_ERROR_TITLES = Object.freeze({
  insecure: 'Camera needs a secure page',
  unsupported: 'This browser can’t use a camera',
  denied: 'Camera blocked',
  'not-found': 'No camera found',
  busy: 'Camera is busy',
  overconstrained: 'That camera can’t start',
  aborted: 'The camera stopped',
  'no-frames': 'The camera isn’t sending pictures',
  'video-file': 'The video clip can’t play',
  unknown: 'Camera problem',
});

/** The retry button's label on the camera-setup and tracking-lost screens. */
const RETRY = 'Try again';

/** An Error whose message is safe to show to players. `source` is always 'camera' (TrackerError has 'tracker'). */
export class CameraError extends Error {
  /**
   * @param {string} code    CameraErrorCode
   * @param {string} message one-sentence explanation for players
   * @param {string} help    what to do next
   * @param {unknown} [cause] the original DOMException / Error
   * @param {{title?:string}} [o]
   */
  constructor(code, message, help, cause, { title = '' } = {}) {
    super(message);
    this.name = 'CameraError';
    this.code = code;
    this.source = 'camera';
    this.title = title || CAMERA_ERROR_TITLES[code] || CAMERA_ERROR_TITLES.unknown;
    this.help = help;
    this.cause = cause;
  }
  /** Message + help in one string (for simple UIs and logs). */
  get fullMessage() { return this.help ? `${this.message} ${this.help}` : this.message; }
}

/** The camera stopped delivering video mid-session (track ended, or muted for too long). */
export function cameraStoppedError(cause) {
  return new CameraError(CameraErrorCode.ABORTED,
    'The camera stopped sending video (it may have been unplugged or taken by another app).',
    `Reconnect the camera or close the other app, then choose ${RETRY}.`, cause);
}

/**
 * Map any getUserMedia / playback failure to a readable CameraError.
 * @param {unknown} err
 * @returns {CameraError}
 */
export function describeCameraError(err) {
  if (err instanceof CameraError) return err;
  const name = (err && typeof err === 'object' && 'name' in err) ? String(err.name) : '';
  const raw = (err && typeof err === 'object' && 'message' in err) ? String(err.message) : String(err ?? '');
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError': {
      const bySystem = /system|os|denied by system/i.test(raw);
      return new CameraError(CameraErrorCode.DENIED,
        bySystem
          ? 'Your computer is blocking the browser from using the camera.'
          : 'Camera access was blocked for this page.',
        bySystem
          ? 'Open your system privacy settings (macOS: System Settings → Privacy & Security → Camera; Windows: Settings → Privacy → Camera), allow your browser, then restart the browser and choose Try again.'
          : 'Click the camera or lock icon at the left of the address bar, set Camera to "Allow", then reload the page. (Safari: Safari menu → Settings for This Website → Camera → Allow.)',
        err);
    }
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new CameraError(CameraErrorCode.NOT_FOUND,
        'No camera was found.',
        'Plug in a webcam (or switch on the built-in one), then choose Try again — or choose Use keyboard instead.',
        err);
    case 'NotReadableError':
    case 'TrackStartError':
      return new CameraError(CameraErrorCode.BUSY,
        'The camera is busy — another app or browser tab is using it.',
        'Close apps that might be using it (video calls, streaming or camera apps, other tabs with this game), then choose Try again.',
        err);
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return new CameraError(CameraErrorCode.OVERCONSTRAINED,
        'The selected camera could not start in a usable video format.',
        'Pick a different camera, or unplug and reconnect it, then choose Try again.',
        err);
    case 'NotSupportedError':
      return new CameraError(CameraErrorCode.UNSUPPORTED,
        'The browser refused to open the camera on this page.',
        'Allow the camera for this site (camera or lock icon in the address bar) and open the game directly, not inside another page — or play with the keyboard.',
        err);
    case 'AbortError':
      return new CameraError(CameraErrorCode.ABORTED,
        'The camera failed to start (it may have been unplugged or is not responding).',
        'Reconnect the camera, then choose Try again.',
        err);
    default:
      return new CameraError(CameraErrorCode.UNKNOWN,
        `The camera could not be started${raw ? ` (${raw})` : ''}.`,
        'Choose Try again, pick another camera, or choose Use keyboard instead.',
        err);
  }
}

/** @returns {MediaDevices|null} */
function mediaDevices() {
  return (typeof navigator !== 'undefined' && navigator.mediaDevices) ? navigator.mediaDevices : null;
}

/** Throws a readable CameraError when the page can't use cameras at all. */
function assertCameraCapable() {
  const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
  if (insecure) {
    throw new CameraError(CameraErrorCode.INSECURE,
      'Browsers only allow the camera on secure pages.',
      'Open the game from http://localhost (or 127.0.0.1) or over https:// instead of a plain network address.');
  }
  const md = mediaDevices();
  if (!md || typeof md.getUserMedia !== 'function') {
    throw new CameraError(CameraErrorCode.UNSUPPORTED,
      'This browser cannot use a camera here.',
      'Use a recent Chrome, Edge, Firefox or Safari, or play with the keyboard.');
  }
}

/**
 * List video input devices. Labels are empty until camera permission was granted once;
 * unnamed devices get "Camera 1", "Camera 2", …
 * @returns {Promise<Array<{deviceId:string, label:string, groupId:string}>>}
 */
export async function listCameras() {
  const md = mediaDevices();
  if (!md || typeof md.enumerateDevices !== 'function') return [];
  let devices = [];
  try { devices = await md.enumerateDevices(); } catch { return []; }
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}`, groupId: d.groupId || '' }));
}

/** @returns {HTMLVideoElement} */
function ensureVideo(video) {
  if (video) return video;
  if (typeof document === 'undefined') throw new Error('openCamera/openVideoFile need a DOM (pass {video})');
  return document.createElement('video');
}

/**
 * Resolve once the video has a decoded frame with real dimensions.
 * @param {HTMLVideoElement} video
 * @param {number} timeoutMs
 * @param {() => CameraError} onTimeout
 */
function waitForFirstFrame(video, timeoutMs, onTimeout) {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer = 0;
    const done = (fn, arg) => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', onData);
      video.removeEventListener('error', onErr);
      fn(arg);
    };
    const onData = () => { if (video.videoWidth > 0) done(resolve); };
    const onErr = () => done(reject, onTimeout());
    video.addEventListener('loadeddata', onData);
    video.addEventListener('error', onErr);
    timer = setTimeout(() => done(reject, onTimeout()), timeoutMs);
  });
}

/** Start playback; autoplay of muted inline video is allowed everywhere, but be tolerant. */
async function startPlayback(video) {
  try { await video.play(); } catch (e) {
    // NotAllowedError here means the autoplay policy blocked it (should not happen for muted
    // video). AbortError happens when srcObject is swapped mid-play. Both are recoverable:
    // the frame wait below decides whether we really have video.
    if (e && e.name !== 'AbortError' && e.name !== 'NotAllowedError') throw e;
  }
}

/**
 * Open a webcam into `video`. Tries the requested constraints first, then relaxes them
 * (drops the resolution/frame-rate wish, then the device choice) before giving up.
 * @param {{deviceId?:string, width?:number, height?:number, frameRate?:number, video?:HTMLVideoElement,
 *          onEnded?:(err:CameraError)=>void, onInterrupted?:(err:CameraError|null)=>void, mutedErrorMs?:number}} [opts]
 *          onEnded: the track ended (unplugged / taken / stopped elsewhere); onInterrupted(err): muted for
 *          longer than mutedErrorMs, onInterrupted(null): frames are back.
 * @returns {Promise<{video:HTMLVideoElement, stream:MediaStream, kind:'camera', deviceId:string, label:string,
 *          width:number, height:number, frameRate:number, maxFrameRate:number, setFrameRate:(fps:number)=>Promise<number>,
 *          stop:()=>void, isEnded:()=>boolean, endedError:()=>CameraError}>}
 */
export async function openCamera(opts = {}) {
  const { deviceId, width = CAMERA_DEFAULTS.width, height = CAMERA_DEFAULTS.height,
    frameRate = CAMERA_DEFAULTS.frameRate, onEnded, onInterrupted, mutedErrorMs = CAMERA_DEFAULTS.mutedErrorMs } = opts;
  assertCameraCapable();
  const video = ensureVideo(opts.video);
  const md = /** @type {MediaDevices} */ (mediaDevices());

  const wanted = {
    width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: frameRate, max: Math.max(60, frameRate) },
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: CAMERA_DEFAULTS.facingMode }),
  };
  const attempts = [
    wanted,
    deviceId ? { deviceId: { exact: deviceId } } : { facingMode: CAMERA_DEFAULTS.facingMode },
    true, // any camera at any resolution
  ];

  let stream = null;
  let lastErr = null;
  for (const constraints of attempts) {
    try {
      stream = await md.getUserMedia({ video: constraints, audio: false });
      break;
    } catch (e) {
      lastErr = e;
      const name = e && e.name;
      // Only format/device-choice problems are worth retrying with looser constraints.
      if (name !== 'OverconstrainedError' && name !== 'ConstraintNotSatisfiedError'
        && !(name === 'NotFoundError' && deviceId && constraints !== true)) break;
    }
  }
  if (!stream) throw describeCameraError(lastErr);

  const track = stream.getVideoTracks()[0];
  let stopped = false;
  let muteTimer = 0;
  let muteReported = false;
  let endedReported = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(muteTimer);
    for (const t of stream.getTracks()) { try { t.stop(); } catch { /* already stopped */ } }
    if (video.srcObject === stream) {
      try { video.pause(); } catch { /* ignore */ }
      video.srcObject = null;
    }
  };
  const ended = () => {
    if (stopped || endedReported) return;
    endedReported = true;
    clearTimeout(muteTimer);
    if (onEnded) onEnded(cameraStoppedError());
  };
  if (track && typeof track.addEventListener === 'function') {
    track.addEventListener('ended', ended);
    // muted = the track stays alive but no frames come (camera grabbed by another app, privacy
    // shutter, USB hiccup): report it once it lasts, and report the recovery when frames return
    const interrupted = onInterrupted || null;
    track.addEventListener('mute', () => {
      if (stopped || endedReported || !interrupted) return;
      clearTimeout(muteTimer);
      muteTimer = setTimeout(() => {
        if (stopped || endedReported || track.muted === false) return;
        muteReported = true;
        interrupted(cameraStoppedError());
      }, mutedErrorMs);
    });
    track.addEventListener('unmute', () => {
      clearTimeout(muteTimer);
      if (stopped || endedReported || !muteReported) return;
      muteReported = false;
      if (interrupted) interrupted(null);
    });
  }

  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = stream;
  try {
    await startPlayback(video);
    await waitForFirstFrame(video, CAMERA_DEFAULTS.firstFrameTimeoutMs, () => new CameraError(CameraErrorCode.NO_FRAMES,
      'The camera opened but no picture arrived.',
      'Check that the camera is not covered or switched off, then choose Try again or pick another camera.'));
  } catch (e) {
    stop();
    throw e instanceof CameraError ? e : describeCameraError(e);
  }

  const settings = trackSettings(track);
  const cam = {
    video, stream, kind: 'camera',
    deviceId: settings.deviceId || deviceId || '',
    label: (track && track.label) || 'Camera',
    width: video.videoWidth || settings.width || width,
    height: video.videoHeight || settings.height || height,
    frameRate: settings.frameRate || frameRate,
    /** The camera's highest frame rate (track capabilities; the current rate when the browser doesn't say). */
    maxFrameRate: maxFrameRateOf(track, settings.frameRate || frameRate),
    /**
     * Run the track at `fps` (PERF-06), keeping its picture: applyConstraints replaces every constraint, so the current
     * size goes along as the ideal. A camera that can only reach that rate in another mode (another size, which the
     * browser would crop or scale into this one — a different field of view) is put back as it was: the rate stays.
     * Resolves with the rate the track reports afterwards; never throws.
     * @param {number} fps
     * @returns {Promise<number>}
     */
    async setFrameRate(fps) {
      const want = Math.max(1, Math.min(120, Math.round(Number(fps) || 30)));
      if (stopped || !track || typeof track.applyConstraints !== 'function') return cam.frameRate;
      const s = trackSettings(track);
      const size = { width: { ideal: s.width || cam.width }, height: { ideal: s.height || cam.height } };
      const old = Number.isFinite(s.frameRate) && s.frameRate > 0 ? s.frameRate : cam.frameRate;
      try {
        await track.applyConstraints({ ...size, frameRate: { ideal: want, max: want } });
      } catch { /* the camera keeps its current rate */ }
      let after = trackSettings(track);
      const resized = Number.isFinite(s.width) && Number.isFinite(after.width) && Number.isFinite(s.height) && Number.isFinite(after.height)
        && (after.width !== s.width || after.height !== s.height);
      if (resized) {
        try { await track.applyConstraints({ ...size, frameRate: { ideal: old, max: Math.max(60, old) } }); } catch { /* as it is */ }
        after = trackSettings(track);
        cam.refusedFrameRate = want;
      }
      cam.frameRate = Number.isFinite(after.frameRate) && after.frameRate > 0 ? after.frameRate : (resized ? old : want);
      return cam.frameRate;
    },
    stop,
    /** The track ended without us stopping it (also when no 'ended' event was fired). */
    isEnded: () => !stopped && !!track && track.readyState === 'ended',
    /** The error to report for an ended track. */
    endedError: () => cameraStoppedError(),
  };
  return cam;
}

/** track.getSettings(), {} when the browser has none. */
function trackSettings(track) {
  try { return (track && typeof track.getSettings === 'function' && track.getSettings()) || {}; } catch { return {}; }
}

/** The highest frame rate the camera offers (capabilities.frameRate.max), else `fallback`. */
function maxFrameRateOf(track, fallback) {
  let caps = null;
  try { caps = track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : null; } catch { caps = null; }
  const max = caps && caps.frameRate && Number(caps.frameRate.max);
  return Number.isFinite(max) && max > 0 ? Math.max(max, fallback || 0) : fallback;
}

/**
 * Play a video clip (URL or File/Blob) in a loop as a fake camera — for testing gestures
 * without standing up, and for the dev lab's `?video=` parameter.
 * @param {string|Blob} urlOrFile
 * @param {{video?:HTMLVideoElement, loop?:boolean, playbackRate?:number}} [opts]
 * @returns {Promise<{video:HTMLVideoElement, stream:null, kind:'file', deviceId:string, label:string,
 *          width:number, height:number, frameRate:number, stop:()=>void}>}
 */
export async function openVideoFile(urlOrFile, opts = {}) {
  const { loop = true, playbackRate = 1 } = opts;
  const video = ensureVideo(opts.video);
  let objectUrl = null;
  let src = '';
  let label = 'video clip';
  if (typeof urlOrFile === 'string') {
    src = urlOrFile;
    label = urlOrFile.split('/').pop() || urlOrFile;
  } else if (urlOrFile && typeof Blob !== 'undefined' && urlOrFile instanceof Blob) {
    objectUrl = URL.createObjectURL(urlOrFile);
    src = objectUrl;
    label = /** @type {File} */ (urlOrFile).name || label;
  } else {
    throw new CameraError(CameraErrorCode.VIDEO_FILE, 'No video clip was given.', 'Pass a URL or a video File.');
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { video.pause(); } catch { /* ignore */ }
    video.removeAttribute('src');
    try { video.load(); } catch { /* ignore */ }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };

  video.srcObject = null;
  video.muted = true;
  video.playsInline = true;
  video.loop = loop;
  if (typeof urlOrFile === 'string' && /^https?:/i.test(src)
    && typeof location !== 'undefined' && !src.startsWith(location.origin)) {
    video.crossOrigin = 'anonymous'; // cross-origin clips must allow CORS or WebGL can't read them
  }
  video.src = src;
  video.playbackRate = playbackRate;
  try {
    await startPlayback(video);
    await waitForFirstFrame(video, CAMERA_DEFAULTS.firstFrameTimeoutMs, () => new CameraError(CameraErrorCode.VIDEO_FILE,
      `The video clip "${label}" could not be played.`,
      'Check the path (it must be served by the dev server) and that the browser can decode it (H.264 MP4 or WebM).'));
  } catch (e) {
    stop();
    throw e instanceof CameraError ? e : new CameraError(CameraErrorCode.VIDEO_FILE,
      `The video clip "${label}" could not be played.`, String(e && e.message || e), e);
  }
  return {
    video, stream: null, kind: 'file', deviceId: '', label,
    width: video.videoWidth, height: video.videoHeight, frameRate: 30, maxFrameRate: 30,
    stop,
  };
}
