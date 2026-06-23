/**
 * Waveform — 波形繪製與互動
 *
 * 兩層 canvas：
 *   base    — 波形 + AB 區段陰影（只在載入 / 變更區段 / resize 時重畫）
 *   overlay — 播放游標（每幀重畫）
 *
 * 對外提供 pixelToTime / timeToPixel 供 app 處理點擊與拖曳。
 */
export class Waveform {
  constructor(baseCanvas, overlayCanvas, container) {
    this.base = baseCanvas;
    this.overlay = overlayCanvas;
    this.container = container;
    this.baseCtx = baseCanvas.getContext("2d");
    this.overlayCtx = overlayCanvas.getContext("2d");

    this.peaks = null; // Float32 上下峰值對
    this.duration = 0;
    this.dpr = window.devicePixelRatio || 1;

    // 區段（顯示用，來自 app）
    this.region = null; // { start, end } 秒，或 null
    this.tempRegion = null; // 拖曳中的暫時區段

    this._styles = getComputedStyle(document.documentElement);

    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(container);
  }

  _color(name) {
    return this._styles.getPropertyValue(name).trim();
  }

  setBuffer(audioBuffer) {
    this.audioBuffer = audioBuffer;
    this.duration = audioBuffer.duration;
    this._computePeaks(audioBuffer);
    this.resize();
  }

  /** 把音訊資料壓縮成每個像素一組 min/max 峰值。 */
  _computePeaks(audioBuffer) {
    const width = Math.max(1, Math.floor(this.container.clientWidth));
    const channels = audioBuffer.numberOfChannels;
    const len = audioBuffer.length;
    const samplesPerPixel = Math.max(1, Math.floor(len / width));

    const mins = new Float32Array(width);
    const maxs = new Float32Array(width);

    // 混合所有聲道
    const data = [];
    for (let c = 0; c < channels; c++) data.push(audioBuffer.getChannelData(c));

    for (let x = 0; x < width; x++) {
      const start = x * samplesPerPixel;
      const end = Math.min(start + samplesPerPixel, len);
      let min = 1.0, max = -1.0;
      for (let i = start; i < end; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += data[c][i];
        const v = sum / channels;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      mins[x] = min;
      maxs[x] = max;
    }
    this.peaks = { mins, maxs, width };
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    if (rect.width === 0) return;
    this.dpr = window.devicePixelRatio || 1;

    for (const cv of [this.base, this.overlay]) {
      cv.width = Math.floor(rect.width * this.dpr);
      cv.height = Math.floor(rect.height * this.dpr);
    }
    // 視窗寬度變了，峰值需要重算才精準
    if (this.audioBuffer) this._computePeaks(this.audioBuffer);
    this.drawBase();
  }

  // app 在 setBuffer 時會把 buffer 存進來供 resize 重算
  set audioBuffer(buf) { this._audioBuffer = buf; }
  get audioBuffer() { return this._audioBuffer; }

  drawBase() {
    const ctx = this.baseCtx;
    const w = this.base.width;
    const h = this.base.height;
    ctx.clearRect(0, 0, w, h);
    if (!this.peaks) return;

    const mid = h / 2;
    const region = this.tempRegion || this.region;

    // 區段陰影
    if (region && this.duration > 0) {
      const x1 = (region.start / this.duration) * w;
      const x2 = (region.end / this.duration) * w;
      ctx.fillStyle = this._color("--region");
      ctx.fillRect(x1, 0, x2 - x1, h);
      ctx.strokeStyle = this._color("--region-edge");
      ctx.lineWidth = 1 * this.dpr;
      ctx.beginPath();
      ctx.moveTo(x1, 0); ctx.lineTo(x1, h);
      ctx.moveTo(x2, 0); ctx.lineTo(x2, h);
      ctx.stroke();
    }

    // 波形
    const { mins, maxs, width } = this.peaks;
    const scaleX = w / width;
    const waveColor = this._color("--wave");
    ctx.fillStyle = waveColor;
    for (let x = 0; x < width; x++) {
      const xPos = x * scaleX;
      const yMax = mid - maxs[x] * mid * 0.95;
      const yMin = mid - mins[x] * mid * 0.95;
      const barH = Math.max(1 * this.dpr, yMin - yMax);
      ctx.fillRect(xPos, yMax, Math.max(1, scaleX), barH);
    }

    // 中線
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid); ctx.lineTo(w, mid);
    ctx.stroke();
  }

  /** 每幀更新游標與已播放著色。 */
  drawPlayhead(position) {
    const ctx = this.overlayCtx;
    const w = this.overlay.width;
    const h = this.overlay.height;
    ctx.clearRect(0, 0, w, h);
    if (!this.peaks || this.duration <= 0) return;

    const px = (position / this.duration) * w;

    // 已播放部分疊一層高亮（只重畫波形的左半，成本可接受）
    const mid = h / 2;
    const { mins, maxs, width } = this.peaks;
    const scaleX = w / width;
    ctx.fillStyle = this._color("--wave-played");
    const limit = Math.min(width, Math.ceil(px / scaleX));
    for (let x = 0; x < limit; x++) {
      const xPos = x * scaleX;
      const yMax = mid - maxs[x] * mid * 0.95;
      const yMin = mid - mins[x] * mid * 0.95;
      const barH = Math.max(1 * this.dpr, yMin - yMax);
      ctx.fillRect(xPos, yMax, Math.max(1, scaleX), barH);
    }

    // 游標線
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2 * this.dpr;
    ctx.beginPath();
    ctx.moveTo(px, 0); ctx.lineTo(px, h);
    ctx.stroke();
  }

  /** 螢幕 X（相對 container）轉時間（秒）。 */
  pixelToTime(clientX) {
    const rect = this.container.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * this.duration;
  }

  setRegion(region) {
    this.region = region;
    this.tempRegion = null;
    this.drawBase();
  }

  setTempRegion(region) {
    this.tempRegion = region;
    this.drawBase();
  }
}
