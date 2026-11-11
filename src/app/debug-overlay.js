// ?debug=1 overlay: frame rate, input/tracker status and each player's ControlState, plus the
// running activity's phase and the renderer's time scale. Plain DOM with inline styles (it is a
// developer tool, not part of the game's look) refreshed a few times per second.
// The backquote key (`) hides / shows it (it can cover buttons in the bottom-right corner).

export const DEBUG_TUNING = Object.freeze({ refreshMs: 200 });

const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '–');
const f0 = (v) => (Number.isFinite(v) ? Math.round(v).toString() : '–');

export class DebugOverlay {
  constructor(root = document.body) {
    this.el = document.createElement('pre');
    this.el.setAttribute('aria-hidden', 'true');
    Object.assign(this.el.style, {
      position: 'fixed', right: '8px', bottom: '8px', zIndex: '50', margin: '0', padding: '8px 10px',
      font: '12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace', color: '#e8fff6',
      background: 'rgba(10, 14, 28, 0.78)', borderRadius: '8px', pointerEvents: 'none', whiteSpace: 'pre',
      maxWidth: '46vw', overflow: 'hidden',
    });
    root.appendChild(this.el);
    this._onKey = (e) => { if (e.code === 'Backquote' && !e.repeat) this.el.hidden = !this.el.hidden; };
    window.addEventListener('keydown', this._onKey);
    this._last = 0;
    this._frames = 0;
    this._fpsT = 0;
    this.fps = 0;
  }

  /**
   * @param {number} now
   * @param {{status:object, players:Array<{control:object}>, activity:object|null, timeScale:number, screen:string|null, flow:string}} s
   */
  update(now, s) {
    this._frames++;
    if (now - this._fpsT >= 1000) { this.fps = (this._frames * 1000) / (now - this._fpsT || 1); this._frames = 0; this._fpsT = now; }
    if (this.el.hidden || now - this._last < DEBUG_TUNING.refreshMs) return;
    this._last = now;
    const st = s.status || {};
    const lines = [
      `fps ${f0(this.fps)}  screen ${s.screen || '–'}  flow ${s.flow}  timeScale ${f2(s.timeScale)}`,
      `input ${st.mode}/${st.phase}  cam ${f0(st.fps)} fps  detect ${f0(st.detectMs)} ms (p95 ${f0(st.detectMsP95)})  ${st.delegate || ''} ${st.model || ''}`,
      // PERF-01/02/03: where detection runs, how many people MediaPipe looks for, main-thread cost this frame
      `detector ${st.detector || '–'}  poses ${st.numPoses ?? '–'} (${st.poseMode || '–'}${st.searching ? ', searching' : ''})  main-thread detect ${f0(st.lastDetectMs)} ms`,
    ];
    // PERF-06: the pose pipeline (InputHub status.pipeline): camera / detection rates, per-stage latency, model, and
    // whether detection is starved (only that moves the model or the delegate) or just behind, and a switch under way
    const pl = st.pipeline;
    if (pl && pl.frames) {
      lines.push(`pipe cam ${f0(pl.cameraFps)} (seen ${f0(pl.camFps)}) det ${f0(pl.detFps)} (min ${f0(pl.detFpsMin)}) fps  cap→pose ${f0(pl.capToPose?.p50)}  pose→game ${f0(pl.poseToGame?.p50)}  cap→punch ${f0(pl.capToEvent?.p50)} ms  ${pl.modelPref}→${pl.model} ${pl.delegate || ''}${pl.starved ? '  STARVED' : pl.behind ? '  BEHIND' : ''}${pl.switching ? `  ${pl.switching.kind}→${pl.switching.to} ${pl.switching.phase}` : ''}`);
    }
    lines.push(`tracking ${JSON.stringify(st.tracking || [])}  presence ${JSON.stringify(st.presence || [])}${st.error ? `  ERROR ${st.error}` : ''}`);
    (s.players || []).forEach((p, i) => {
      const c = p?.control;
      if (!c) return;
      const hand = (h) => (h ? `${f2(h.x)},${f2(h.y)} r${f2(h.reach)}${h.punching ? '*' : ''}` : '–');
      lines.push(`P${i + 1} ${c.tracked ? 'tracked' : 'LOST'} conf ${f2(c.confidence)} guard ${c.guard}(${f2(c.guardAmount)}) lean ${f2(c.lean?.x)},${f2(c.lean?.y)},${f2(c.lean?.z)} act ${f2(c.activity)}`);
      lines.push(`   L ${hand(c.hands?.left)}   R ${hand(c.hands?.right)}`);
    });
    const a = s.activity;
    if (a?.kind === 'match') {
      lines.push(`match ${a.mode} ${a.phase}/${a.stage || '–'}${a.paused ? ' (PAUSED)' : ''} R${a.round} clock ${f0(a.clockMs / 1000)}s${a.clockVisible === false ? ' (hidden)' : ''}  hp ${f2(a.p1.hp)} / ${f2(a.p2.hp)} wedges  kd ${a.p1.knockdowns}/${a.p2.knockdowns}`);
      lines.push(`thrown ${a.stats.p1.thrown}/${a.stats.p2.thrown} landed ${a.stats.p1.landed}/${a.stats.p2.landed}  latency ${f0(a.latencyMs)} ms${a.slowmo ? `  SLOW-MO ${a.slowmo.dodger} ${a.slowmo.msLeft} ms` : ''}${a.result ? `  RESULT ${a.result.winner || 'draw'} ${a.result.method}` : ''}`);
      if (a.tutorial && a.tutorial.stage !== 'finished') lines.push(`tutorial ${a.tutorial.index + 1}/${a.tutorial.total} ${a.tutorial.step || '–'} ${a.tutorial.stage} ${f2(a.tutorial.progress01)}`);
      if (a.outro) lines.push(`outro ${a.outro.active ? 'playing' : 'done'}${a.outro.skipped ? ' (skipped)' : ''}`);
    } else if (a?.kind === 'training') {
      lines.push(`training ${a.activity} ${a.phase}${a.paused ? ' (PAUSED)' : ''} score ${a.score} left ${f0(a.timeLeftMs / 1000)}s turn ${a.turn != null ? a.turn + 1 : '–'}/${a.turns}`);
    }
    this.el.textContent = lines.join('\n');
  }

  dispose() { window.removeEventListener('keydown', this._onKey); this.el.remove(); }
}
