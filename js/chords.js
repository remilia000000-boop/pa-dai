/**
 * chords.js — 離線自動和弦偵測（純前端 DSP）
 *
 * 流程：
 *   1. 下混單聲道 → 分幀（Hann 窗）
 *   2. 自帶 radix-2 FFT 取幅度頻譜
 *   3. 把頻率 bin 累加成 12 維 chroma（音高類別）
 *   4. 與 24 個大三/小三和弦模板做餘弦比對，取最相近者
 *   5. 中值濾波平滑 → 合併同名相鄰幀 → 去除過短片段
 *
 * 為估計演算法，複雜和弦（7th、轉位、加音）可能不準。
 */

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** in-place iterative radix-2 FFT（n 必須為 2 的次方）。 */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = re[b] * cwr - im[b] * cwi;
        const ti = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = ncwr;
      }
    }
  }
}

function medianFilter(arr, win) {
  const half = win >> 1;
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const counts = new Map();
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= arr.length) continue;
      const v = arr[j];
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    let best = arr[i], bestC = -1;
    for (const [v, c] of counts) {
      if (c > bestC) { bestC = c; best = v; }
    }
    out[i] = best;
  }
  return out;
}

function buildTemplates() {
  const templates = [];
  for (let r = 0; r < 12; r++) {
    const maj = new Float32Array(12);
    maj[r] = 1; maj[(r + 4) % 12] = 1; maj[(r + 7) % 12] = 1;
    templates.push({ name: NOTE_NAMES[r], vec: normalize(maj) });
    const min = new Float32Array(12);
    min[r] = 1; min[(r + 3) % 12] = 1; min[(r + 7) % 12] = 1;
    templates.push({ name: NOTE_NAMES[r] + "m", vec: normalize(min) });
  }
  return templates;
}

function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

/**
 * @param {AudioBuffer} audioBuffer
 * @param {{onProgress?:(p:number)=>void}} [opts]
 * @returns {Promise<Array<{start:number,end:number,label:string}>>}
 */
export async function detectChords(audioBuffer, opts = {}) {
  const { onProgress } = opts;
  const sr = audioBuffer.sampleRate;
  const N = audioBuffer.length;
  const ch = audioBuffer.numberOfChannels;

  // 下混單聲道
  const mono = new Float32Array(N);
  for (let c = 0; c < ch; c++) {
    const d = audioBuffer.getChannelData(c);
    for (let i = 0; i < N; i++) mono[i] += d[i] / ch;
  }

  const WIN = 8192;
  const HOP = 4096;
  const hann = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (WIN - 1)));

  const numFrames = Math.max(1, Math.floor((N - WIN) / HOP) + 1);
  const fmin = 55;   // ~A1
  const fmax = 4000; // 取基頻 + 低次泛音
  const re = new Float32Array(WIN);
  const im = new Float32Array(WIN);
  const templates = buildTemplates();
  const frameLabels = [];

  for (let fr = 0; fr < numFrames; fr++) {
    const start = fr * HOP;
    for (let i = 0; i < WIN; i++) {
      re[i] = mono[start + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im);

    const chroma = new Float32Array(12);
    for (let k = 1; k < WIN >> 1; k++) {
      const f = (k * sr) / WIN;
      if (f < fmin || f > fmax) continue;
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const midi = 69 + 12 * Math.log2(f / 440);
      let pc = Math.round(midi) % 12;
      if (pc < 0) pc += 12;
      chroma[pc] += mag;
    }

    // 比對模板
    let energy = 0;
    for (let i = 0; i < 12; i++) energy += chroma[i];
    if (energy < 1e-4) {
      frameLabels.push(-1);
    } else {
      const cn = normalize(chroma);
      let best = -1, bestScore = 0;
      for (let ti = 0; ti < templates.length; ti++) {
        const v = templates[ti].vec;
        let dot = 0;
        for (let i = 0; i < 12; i++) dot += cn[i] * v[i];
        if (dot > bestScore) { bestScore = dot; best = ti; }
      }
      frameLabels.push(bestScore > 0.55 ? best : -1);
    }

    if (fr % 32 === 0) {
      onProgress?.(fr / numFrames);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // 平滑
  const smoothed = medianFilter(frameLabels, 9);

  // 切段
  const frameDur = HOP / sr;
  let segs = [];
  let i = 0;
  while (i < smoothed.length) {
    const lab = smoothed[i];
    let j = i + 1;
    while (j < smoothed.length && smoothed[j] === lab) j++;
    segs.push({
      start: i * frameDur,
      end: Math.min(audioBuffer.duration, j * frameDur),
      idx: lab,
    });
    i = j;
  }

  // 合併過短片段（<0.45s）：併入較長的鄰居，再合併同名相鄰段
  segs = mergeShort(segs, 0.45);

  onProgress?.(1);
  return segs.map((s) => ({
    start: s.start,
    end: s.end,
    label: s.idx < 0 ? "N.C." : templates[s.idx].name,
  }));
}

function mergeShort(segs, minDur) {
  let changed = true;
  while (changed && segs.length > 1) {
    changed = false;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.end - s.start >= minDur) continue;
      // 併入較長的鄰居
      const prev = segs[i - 1];
      const next = segs[i + 1];
      let target = null;
      if (prev && next) target = (prev.end - prev.start) >= (next.end - next.start) ? prev : next;
      else target = prev || next;
      if (!target) continue;
      target.start = Math.min(target.start, s.start);
      target.end = Math.max(target.end, s.end);
      segs.splice(i, 1);
      changed = true;
      break;
    }
  }
  // 合併同名相鄰
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.idx === s.idx) last.end = s.end;
    else out.push({ ...s });
  }
  return out;
}
