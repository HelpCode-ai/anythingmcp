/**
 * Human-like input on the real macOS cursor and keyboard, through the
 * `humanio` helper (native/humanio.swift). Movements follow a curved path
 * with a minimum-jerk speed profile, take longer for far or small targets
 * (Fitts's law), overshoot a little on long moves and settle back; typing has
 * an irregular rhythm with pauses between words.
 */
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '../native/humanio');

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Human {
  private proc: ChildProcessWithoutNullStreams;
  private lines: Interface;
  private waiters: ((line: string) => void)[] = [];

  constructor(private readonly speed = 1) {
    this.proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', (d) => process.stderr.write(`[humanio] ${d}`));
    this.lines = createInterface({ input: this.proc.stdout });
    this.lines.on('line', (l) => this.waiters.shift()?.(l));
  }

  private send(cmd: string): Promise<string> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.proc.stdin.write(`${cmd}\n`);
    });
  }

  async position(): Promise<{ x: number; y: number }> {
    const [x, y] = (await this.send('pos')).split(' ').map(Number);
    return { x, y };
  }

  /** Move to a point along a human path. `targetSize` is the target's smaller side in points. */
  async moveTo(x: number, y: number, targetSize = 40): Promise<void> {
    const from = await this.position();
    const dist = Math.hypot(x - from.x, y - from.y);
    if (dist < 2) return;
    // Fitts: ~250 ms + 140 ms per bit of difficulty, scaled by `speed`.
    const duration = (250 + 140 * Math.log2(dist / Math.max(targetSize, 8) + 1)) / this.speed;
    const overshoot = dist > 260 ? rand(0.02, 0.05) : 0;
    const dx = x - from.x;
    const dy = y - from.y;
    const end = { x: x + dx * overshoot, y: y + dy * overshoot };
    // Control points bowed to one side of the straight line.
    const bow = rand(0.08, 0.2) * (Math.random() < 0.5 ? -1 : 1);
    const nx = -dy / dist;
    const ny = dx / dist;
    const c1 = { x: from.x + dx * 0.3 + nx * dist * bow, y: from.y + dy * 0.3 + ny * dist * bow };
    const c2 = { x: from.x + dx * 0.75 + nx * dist * bow * 0.5, y: from.y + dy * 0.75 + ny * dist * bow * 0.5 };
    await this.path(from, c1, c2, end, duration);
    if (overshoot) {
      await sleep(rand(40, 90));
      const p = await this.position();
      await this.path(p, p, { x, y }, { x, y }, rand(110, 170) / this.speed);
    }
  }

  private async path(
    p0: { x: number; y: number },
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    p3: { x: number; y: number },
    duration: number,
  ): Promise<void> {
    const frame = 1000 / 120;
    const steps = Math.max(2, Math.round(duration / frame));
    const t0 = performance.now();
    for (let i = 1; i <= steps; i++) {
      const lin = i / steps;
      // Minimum-jerk profile: slow start, fast middle, slow landing.
      const t = 10 * lin ** 3 - 15 * lin ** 4 + 6 * lin ** 5;
      const u = 1 - t;
      const bx = u ** 3 * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t ** 3 * p3.x;
      const by = u ** 3 * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t ** 3 * p3.y;
      await this.send(`move ${bx.toFixed(1)} ${by.toFixed(1)}`);
      const due = t0 + i * frame;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
    }
  }

  /** Move to a box (a random point near its centre) and click it. */
  async clickBox(box: Box, opts: { dwell?: number } = {}): Promise<void> {
    const x = box.x + box.width * rand(0.4, 0.6);
    const y = box.y + box.height * rand(0.4, 0.6);
    await this.moveTo(x, y, Math.min(box.width, box.height));
    await sleep(opts.dwell ?? rand(120, 260));
    await this.click();
  }

  async click(): Promise<void> {
    await this.send('down');
    await sleep(rand(60, 110));
    await this.send('up');
  }

  /** Type like a person: 40-110 ms per key, longer after spaces and punctuation. */
  async type(text: string, wpmScale = 1): Promise<void> {
    for (const ch of text) {
      await this.send(`type ${ch === ' ' ? ' ' : ch}`);
      let d = rand(40, 110);
      if (ch === ' ') d += rand(20, 90);
      if (/[,.?!:]/.test(ch)) d += rand(80, 180);
      if (Math.random() < 0.03) d += rand(150, 350); // a short hesitation
      await sleep(d / (this.speed * wpmScale));
    }
  }

  /** Paste via the clipboard, as people do with long URLs and keys. */
  async paste(text: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const p = spawn('pbcopy');
      p.on('close', () => resolve());
      p.on('error', reject);
      p.stdin.end(text);
    });
    await sleep(rand(120, 220));
    await this.send('key cmd+v');
  }

  async key(combo: string): Promise<void> {
    await this.send(`key ${combo}`);
  }

  async pause(min: number, max = min): Promise<void> {
    await sleep(rand(min, max));
  }

  close(): void {
    this.proc.stdin.end();
  }
}
