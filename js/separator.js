/**
 * separator.js — 音軌分離（純前端）
 *
 * 使用 demucs-web（HTDemucs, 4 軌）+ onnxruntime-web。
 *   - 優先 WebGPU；不支援時退回單執行緒 WASM（不需 SharedArrayBuffer，
 *     因此可直接部署在 GitHub Pages，無需 COOP/COEP headers）。
 *   - 172MB 模型以 Cache Storage 快取，第二次起免再下載。
 *
 * 對外：new StemSeparator(callbacks).separate(audioBuffer44100)
 *   回傳 { drums, bass, other, vocals }，每軌 { left, right }（44100Hz）。
 */
import { DemucsProcessor, CONSTANTS } from "../vendor/demucs-web/index.js";

const ORT_VERSION = "1.27.0";
const ORT_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.webgpu.bundle.min.mjs`;
const ORT_WASM_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const MODEL_URL = CONSTANTS.DEFAULT_MODEL_URL;
const MODEL_CACHE = "demucs-model-v1";

export const TRACK_LABELS = {
  drums: "鼓",
  bass: "貝斯",
  other: "其他",
  vocals: "人聲",
};

export class StemSeparator {
  /**
   * @param {object} cb
   * @param {(loaded:number,total:number)=>void} [cb.onDownloadProgress]
   * @param {(progress:number,seg:number,total:number)=>void} [cb.onProgress]
   * @param {(phase:string,msg:string)=>void} [cb.onLog]
   * @param {(backend:string)=>void} [cb.onBackend]
   */
  constructor(cb = {}) {
    this.cb = cb;
    this.ort = null;
    this.processor = null;
    this.backend = null;
    this._ready = false;
  }

  get sampleRate() {
    return CONSTANTS.SAMPLE_RATE; // 44100
  }

  log(phase, msg) {
    this.cb.onLog?.(phase, msg);
  }

  /** 偵測可用後端。 */
  async _pickBackend() {
    if ("gpu" in navigator && navigator.gpu) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) return "webgpu";
      } catch (_) {}
    }
    return "wasm";
  }

  /** 動態載入並設定 ONNX Runtime。 */
  async _initOrt() {
    if (this.ort) return this.ort;
    this.log("init", "載入 ONNX Runtime…");
    const mod = await import(/* @vite-ignore */ ORT_URL);
    // 不同打包可能把 API 放在 default 或命名匯出
    const ort = mod && mod.InferenceSession ? mod : (mod.default || mod);

    ort.env.wasm.wasmPaths = ORT_WASM_BASE;
    ort.env.wasm.simd = true;
    // 沒有跨來源隔離時只能單執行緒（避免依賴 SharedArrayBuffer）
    ort.env.wasm.numThreads = self.crossOriginIsolated
      ? Math.min(navigator.hardwareConcurrency || 4, 4)
      : 1;

    this.backend = await this._pickBackend();
    this.cb.onBackend?.(this.backend);
    this.log("init", `運算後端：${this.backend.toUpperCase()}`);

    this.ort = ort;
    return ort;
  }

  /** 取得模型 ArrayBuffer（優先快取）。 */
  async _getModelBuffer() {
    let cache = null;
    try {
      cache = await caches.open(MODEL_CACHE);
      const hit = await cache.match(MODEL_URL);
      if (hit) {
        this.log("model", "使用快取的模型");
        const total = Number(hit.headers.get("Content-Length")) || 0;
        if (total) this.cb.onDownloadProgress?.(total, total);
        return await hit.arrayBuffer();
      }
    } catch (_) {
      // Cache API 不可用（例如非 https）— 改為直接下載
    }

    this.log("model", "下載模型（約 172MB，首次較久）…");
    const resp = await fetch(MODEL_URL);
    if (!resp.ok) throw new Error(`模型下載失敗：HTTP ${resp.status}`);

    const total = Number(resp.headers.get("Content-Length")) || 0;
    const reader = resp.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      this.cb.onDownloadProgress?.(loaded, total);
    }
    const bytes = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.length; }

    if (cache) {
      try {
        await cache.put(MODEL_URL, new Response(bytes, {
          headers: { "Content-Length": String(loaded), "Content-Type": "application/octet-stream" },
        }));
      } catch (_) {}
    }
    return bytes.buffer;
  }

  /** 載入 ORT 與模型（可重複呼叫，僅執行一次）。 */
  async ensureReady() {
    if (this._ready) return;
    const ort = await this._initOrt();

    this.processor = new DemucsProcessor({
      ort,
      onProgress: ({ progress, currentSegment, totalSegments }) =>
        this.cb.onProgress?.(progress, currentSegment, totalSegments),
      onLog: (phase, msg) => this.log(phase, msg),
      // WASM 後端記憶體較吃緊時的保守設定
      sessionOptions:
        this.backend === "wasm"
          ? { enableCpuMemArena: false, enableMemPattern: false }
          : {},
    });

    const buffer = await this._getModelBuffer();
    this.log("model", "建立推論工作階段…");
    await this.processor.loadModel(buffer);
    this._ready = true;
    this.log("model", "模型就緒");
  }

  /**
   * 分離音軌。
   * @param {AudioBuffer} audioBuffer 取樣率須為 44100
   * @returns {Promise<{drums,bass,other,vocals}>}
   */
  async separate(audioBuffer) {
    await this.ensureReady();
    const left = audioBuffer.getChannelData(0);
    const right =
      audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;
    this.log("separate", "開始分離…");
    const result = await this.processor.separate(left, right);
    this.log("separate", "分離完成");
    return result;
  }
}
