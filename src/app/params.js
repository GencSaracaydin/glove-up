// URL parameters of the game (ARCHITECTURE.md §4 debug & test hooks). Pure: runs in Node.
//
//   ?input=keyboard|camera|replay|synthetic   input source (default: camera, or the saved setting)
//   ?debug=1     ControlState / fps overlay          ?fast=1   10 s rounds, short intros, outros and drills
//   ?seed=123    deterministic bouts and drills      ?rec=/r.json  pose recording for input=replay
//   ?video=/clip.mp4  a clip as the camera           ?calibrate=1  always calibrate
//   ?quality=low|high renderer quality               ?skip=match   start at a screen (skipTo target)
//   ?tutorial=0|1  first-bout tutorial never / always (default: a new boxer's first bout only)
//   ?detector=worker|main  where pose detection runs (default: a background worker, input/input-hub.js)

const INPUTS = ['keyboard', 'replay', 'synthetic', 'camera'];
const QUALITIES = ['high', 'low'];
const DETECTORS = ['worker', 'main'];
const OFF = ['0', 'false', 'no', 'off'];

/**
 * @param {string} [search]  location.search
 * @returns {{input:null|'keyboard'|'replay'|'synthetic'|'camera', debug:boolean, fast:boolean, seed:null|string,
 *            rec:null|string, video:null|string, calibrate:boolean, quality:'auto'|'high'|'low', skip:null|string,
 *            tutorial:null|boolean, detector:null|'worker'|'main'}}
 */
export function parseParams(search = '') {
  const q = new URLSearchParams(search);
  const flag = (k) => q.has(k) && !OFF.includes(String(q.get(k)).toLowerCase());
  const input = (q.get('input') || '').toLowerCase();
  const quality = (q.get('quality') || '').toLowerCase();
  const detector = (q.get('detector') || '').toLowerCase();
  return {
    input: INPUTS.includes(input) ? input : null,
    debug: flag('debug'),
    fast: flag('fast'),
    seed: q.has('seed') && q.get('seed') !== '' ? q.get('seed') : null,
    rec: q.get('rec') || null,
    video: q.get('video') || null,
    calibrate: flag('calibrate'),
    quality: QUALITIES.includes(quality) ? quality : 'auto',
    skip: q.get('skip') || null,
    tutorial: q.has('tutorial') ? flag('tutorial') : null,
    detector: DETECTORS.includes(detector) ? detector : null,
  };
}
