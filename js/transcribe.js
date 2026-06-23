/**
 * transcribe.js — 單音自動採譜（純前端 DSP）
 *
 * 流程：
 *   1. 下混單聲道 → 降取樣到 16kHz（加速、足夠涵蓋旋律音域）
 *   2. 分幀（Hann 窗）→ 以 FFT 計算自相關（ACF）
 *   3. 峰值挑選 + 拋物線內插求基頻 f0，並估計清晰度(clarity)
 *   4. f0 → MIDI，中值平滑，切成音符事件，去除過短音
 *
 * 僅適用「單音線條」（主旋律、貝斯、人聲）。多音/和弦無法準確採譜。
 */

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function midiToName(m) {
  return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

/** in-place radix-2 FFT（n 為 2 的次方）。 */
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
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cwr - im[b] * cwi;
        const ti = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = ncwr;
      }
    }
  }
}

function ifft(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
}

function resampleMono(mono, srcSr, dstSr) {
  if (dstSr >= srcSr) return { data: mono, sr: srcSr };
  const ratio = srcSr / dstSr;
  const n = Math.floor(mono.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = mono[i0] || 0;
    const b = mono[i0 + 1] !== undefined ? mono[i0 + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return { data: out, sr: dstSr };
}

function medianFillMidi(arr, win) {
  const half = win >> 1;
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const vals = [];
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= arr.length) continue;
      if (arr[j] != null) vals.push(arr[j]);
    }
    if (!vals.length) { out[i] = null; continue; }
    vals.sort((a, b) => a - b);
    out[i] = vals[vals.length >> 1];
  }
  return out;
}

/**
 * @param {AudioBuffer} audioBuffer
 * @param {{onProgress?:(p:number)=>void, fmin?:number, fmax?:number, clarity?:number}} [opts]
 * @returns {Promise<{notes:Array<{start,end,midi,name}>, minMidi:number, maxMidi:number}>}
 */
export async function detectNotes(audioBuffer, opts = {}) {
  const { onProgress } = opts;
  const fmin = opts.fmin || 65;    // ~C2
  const fmax = opts.fmax || 1200;  // ~D6
  const clarityThresh = opts.clarity || 0.8;

  const srcSr = audioBuffer.sampleRate;
  const N = audioBuffer.length;
  const ch = audioBuffer.numberOfChannels;
  const mono0 = new Float32Array(N);
  for (let c = 0; c < ch; c++) {
    const d = audioBuffer.getChannelData(c);
    for (let i = 0; i < N; i++) mono0[i] += d[i] / ch;
  }
  const { data: mono, sr } = resampleMono(mono0, srcSr, 16000);

  const WIN = 2048;
  const FFTN = 4096;
  const HOP = 512;
  const hann = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (WIN - 1)));

  const tauMin = Math.max(2, Math.floor(sr / fmax));
  const tauMax = Math.min(WIN - 1, Math.ceil(sr / fmin));
  const numFrames = Math.max(1, Math.floor((mono.length - WIN) / HOP) + 1);
  const frameDur = HOP / sr;

  const re = new Float32Array(FFTN);
  const im = new Float32Array(FFTN);
  const frameMidi = new Array(numFrames).fill(null);

  // 估一個能量門檻（避免把雜訊/靜音當成音）
  let globalEnergy = 0;
  for (let i = 0; i < mono.length; i += 17) globalEnergy += mono[i] * mono[i];
  const energyFloor = (globalEnergy / (mono.length / 17)) * WIN * 0.05;

  for (let fr = 0; fr < numFrames; fr++) {
    const start = fr * HOP;
    re.fill(0); im.fill(0);
    for (let i = 0; i < WIN; i++) re[i] = mono[start + i] * hann[i];

    fft(re, im);
    for (let k = 0; k < FFTN; k++) { re[k] = re[k] * re[k] + im[k] * im[k]; im[k] = 0; }
    ifft(re, im); // re = 自相關

    const acf0 = re[0];
    if (acf0 > energyFloor) {
      // 峰值挑選
      let globalMax = 0;
      for (let t = tauMin; t <= tauMax; t++) if (re[t] > globalMax) globalMax = re[t];
      const thr = 0.85 * globalMax;
      let tauPeak = -1;
      for (let t = tauMin + 1; t < tauMax; t++) {
        if (re[t] > re[t - 1] && re[t] >= re[t + 1] && re[t] >= thr) { tauPeak = t; break; }
      }
      if (tauPeak > 0) {
        // 拋物線內插
        const a = re[tauPeak - 1], b = re[tauPeak], c = re[tauPeak + 1];
        const denom = a - 2 * b + c;
        const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
        const tau = tauPeak + shift;
        const clarity = b / acf0;
        if (clarity >= clarityThresh) {
          const f0 = sr / tau;
          const midi = Math.round(69 + 12 * Math.log2(f0 / 440));
          if (midi >= 24 && midi <= 96) frameMidi[fr] = midi;
        }
      }
    }

    if (fr % 64 === 0) {
      onProgress?.(fr / numFrames);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // 平滑
  const smooth = medianFillMidi(frameMidi, 5);

  // 切音符（允許 <=1 幀的小空隙併入同音）
  const notes = [];
  let i = 0;
  while (i < smooth.length) {
    if (smooth[i] == null) { i++; continue; }
    const midi = smooth[i];
    let j = i + 1;
    while (j < smooth.length) {
      if (smooth[j] === midi) { j++; continue; }
      if (smooth[j] == null && j + 1 < smooth.length && smooth[j + 1] === midi) { j += 2; continue; }
      break;
    }
    notes.push({ start: i * frameDur, end: j * frameDur, midi });
    i = j;
  }

  // 去除過短音（<70ms）
  const minDur = 0.07;
  const filtered = notes.filter((n) => n.end - n.start >= minDur);

  let minMidi = 127, maxMidi = 0;
  for (const n of filtered) {
    n.end = Math.min(n.end, audioBuffer.duration);
    n.name = midiToName(n.midi);
    if (n.midi < minMidi) minMidi = n.midi;
    if (n.midi > maxMidi) maxMidi = n.midi;
  }
  if (!filtered.length) { minMidi = 60; maxMidi = 72; }

  onProgress?.(1);
  return { notes: filtered, minMidi, maxMidi };
}
