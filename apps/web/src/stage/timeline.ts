// A small seekable timeline on the Web Animations API. Every tween is an Animation held paused and
// driven by one clock, so seeking, scrubbing and speed changes are exact and need no library.

type Track = (t: number) => void;

export class Timeline {
  private anims: Animation[] = [];
  private tracks: Track[] = [];
  readonly labels: [string, number][] = [];
  duration = 0;
  time = 0;
  rate = 1;
  playing = false;
  onTick?: (t: number) => void;
  onEnd?: () => void;
  private last = 0;
  private frame = 0;

  /** Tween from the element's own style to the last keyframe. Values hold after the end. */
  to(el: Element | null | undefined, frames: Keyframe[], at: number, dur: number, easing = "cubic-bezier(.3,.7,.3,1)"): this {
    if (!el) return this;
    const a = el.animate(frames, { duration: Math.max(1, dur * 1000), delay: at * 1000, fill: "forwards", easing });
    a.pause();
    a.currentTime = this.time * 1000;
    this.anims.push(a);
    this.duration = Math.max(this.duration, at + dur);
    return this;
  }

  /** Anything that is not a style: text, counters, classes. Called with the current time on every frame and seek. */
  track(fn: Track, until = 0): this {
    this.tracks.push(fn);
    this.duration = Math.max(this.duration, until);
    fn(this.time);
    return this;
  }

  label(name: string, at: number): this {
    this.labels.push([name, at]);
    return this;
  }

  seek(t: number): void {
    this.time = Math.min(Math.max(t, 0), this.duration);
    for (const a of this.anims) a.currentTime = this.time * 1000;
    for (const f of this.tracks) f(this.time);
    this.onTick?.(this.time);
  }

  play(): void {
    if (this.playing) return;
    if (this.time >= this.duration) this.seek(0);
    this.playing = true;
    this.last = performance.now();
    const step = (now: number) => {
      if (!this.playing) return;
      const t = this.time + ((now - this.last) / 1000) * this.rate;
      this.last = now;
      if (t >= this.duration) {
        this.seek(this.duration);
        this.playing = false;
        this.onEnd?.();
        return;
      }
      this.seek(t);
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.frame);
    this.onTick?.(this.time);
  }

  destroy(): void {
    this.pause();
    for (const a of this.anims) a.cancel();
    this.anims = [];
    this.tracks = [];
  }
}

/** Linear interpolation of a value over a span, clamped. */
export const span = (t: number, at: number, dur: number) => (dur <= 0 ? (t >= at ? 1 : 0) : Math.min(Math.max((t - at) / dur, 0), 1));
