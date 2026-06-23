/**
 * separator.js — 音軌分離（純前端）
 *
 * 支援兩種模型：
 *   4s  — timcsy/demucs-web 的 htdemucs（4 軌：鼓/貝斯/其他/人聲）
 *          透過 demucs-web 的 DemucsProcessor（JS 端做 STFT）。
 *   6s  — StemSplitio/htdemucs_6s（6 軌：＋吉他/鋼琴），單一圖模型，
 *          STFT 已包進模型，JS 端只需切段 + overlap-add。
 *
 * 後端：優先 WebGPU，否則單執行緒 WASM（免 SharedArrayBuffer，
 * 可直接部署在 GitHub Pages）。模型以 Cache Storage 快取。
 */
import { DemucsProcessor, CONSTANTS } from "../vendor/demucs-web/index.js?v=2";

const ORT_VERSION = "1.27.0";
const ORT_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.webgpu.bundle.min.mjs`;
const ORT_WASM_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

export const TRACK_LABELS = {
  drums: "鼓",
  bass: "貝斯",
  other: "其他",
  vocals: "人聲",
  guitar: "吉他",
  piano: "鋼琴",
};

export const TRACK_ICONS = {
  drums: "🥁",
  bass: "🎸",
  other: "🎶",
  vocals: "🎤",
  guitar: "🎼",
  piano: "🎹",
};

export const MODELS = {
  "4s": {
    label: "4 軌（鼓 / 貝斯 / 其他 / 人聲）· 較快",
    url: CONSTANTS.DEFAULT_MODEL_URL,
    cache: "demucs-4s-v1",
    kind: "demucs-web",
    tracks: ["drums", "bass", "other", "vocals"],
    sizeMB: 172,
  },
  "6s": {
    label: "6 軌（＋吉他 / 鋼琴）· 較慢、較吃資源",
    url: "https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx",
    cache: "demucs-6s-fp16-v1",
    kind: "single",
    tracks: ["drums", "bass", "other", "vocals", "guitar", "piano"],
    sizeMB: 136,
  },
};

const SEGMENT = 343980; // 7.8s @ 44100，兩種模型相同
const SEGMENT_OVERLAP = 0.25;

export class StemSeparator {
  constructor(cb = {}, modelKey = "4s") {
    this.cb = cb;
    this.model = MODELS[modelKey] || MODELS["4s"];
    this.ort = null;
    this.processor = null; // 4s 用
    this.session = null; // 6s 用
    this.backend = null;
    this._ready = false;
  }

  get sampleRate() {
    return CONSTANTS.SAMPLE_RATE; // 44100
  }

  get tracks() {
    return this.model.tracks;
  }

  log(phase, msg) {
    this.cb.onLog?.(phase, msg);
  }

  async _pickBackend() {
    if ("gpu" in navigator && navigator.gpu) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) return "webgpu";
      } catch (_) {}
    }
    return "wasm";
  }

  async _initOrt() {
    if (this.ort) return this.ort;
    this.log("init", "載入 ONNX Runtime…");
    const mod = await import(/* @vite-ignore */ ORT_URL);
    const ort = mod && mod.InferenceSession ? mod : (mod.default || mod);

    ort.env.wasm.wasmPaths = ORT_WASM_BASE;
    ort.env.wasm.simd = true;
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
    const url = this.model.url;
    let cache = null;
    try {
      cache = await caches.open(this.model.cache);
      const hit = await cache.match(url);
      if (hit) {
        this.log("model", "使用快取的模型");
        const total = Number(hit.headers.get("Content-Length")) || 0;
        if (total) this.cb.onDownloadProgress?.(total, total);
        return await hit.arrayBuffer();
      }
    } catch (_) {}

    this.log("model", `下載模型（約 ${this.model.sizeMB}MB，首次較久）…`);
    const resp = await fetch(url);
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
        await cache.put(url, new Response(bytes, {
          headers: { "Content-Length": String(loaded), "Content-Type": "application/octet-stream" },
        }));
      } catch (_) {}
    }
    return bytes.buffer;
  }

  async ensureReady() {
    if (this._ready) return;
    const ort = await this._initOrt();
    const buffer = await this._getModelBuffer();
    this.log("model", "建立推論工作階段…");

    if (this.model.kind === "demucs-web") {
      this.processor = new DemucsProcessor({
        ort,
        onProgress: ({ progress, currentSegment, totalSegments }) =>
          this.cb.onProgress?.(progress, currentSegment, totalSegments),
        onLog: (phase, msg) => this.log(phase, msg),
        sessionOptions:
          this.backend === "wasm"
            ? { enableCpuMemArena: false, enableMemPattern: false }
            : {},
      });
      await this.processor.loadModel(buffer);
    } else {
      // 此單一圖模型的 iSTFT(ConstantOfShape) 目前無法在 onnxruntime-web 的
      // WebGPU EP 建立 session，因此固定用 WASM（較慢但相容）。
      this.backend = "wasm";
      this.cb.onBackend?.("wasm");
      this.log("model", "此模型使用 WASM 運算（較慢，請耐心等候）");
      this.session = await ort.InferenceSession.create(buffer, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
    }

    this._ready = true;
    this.log("model", "模型就緒");
  }

  /**
   * 分離音軌。audioBuffer 取樣率須為 44100。
   * @returns {Promise<Object>} 以軌道名為 key，每軌 { left, right }
   */
  async separate(audioBuffer) {
    await this.ensureReady();
    const left = audioBuffer.getChannelData(0);
    const right =
      audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;

    this.log("separate", "開始分離…");
    let result;
    if (this.model.kind === "demucs-web") {
      result = await this.processor.separate(left, right);
    } else {
      result = await this._separateSingleGraph(left, right);
    }
    this.log("separate", "分離完成");
    return result;
  }

  /** 單一圖模型的切段 + overlap-add 推論。 */
  async _separateSingleGraph(left, right) {
    const ort = this.ort;
    const L = SEGMENT;
    const stride = Math.floor(L * (1 - SEGMENT_OVERLAP));
    const tracks = this.model.tracks;
    const total = left.length;
    const numSeg = Math.floor(Math.max(0, total - 1) / stride) + 1;

    const outs = tracks.map(() => ({
      left: new Float32Array(total),
      right: new Float32Array(total),
    }));
    const weights = new Float32Array(total);

    const inName = this.session.inputNames[0];
    const outName = this.session.outputNames[0];

    let segIdx = 0;
    for (let start = 0; start < total; start += stride) {
      const end = Math.min(start + L, total);
      const segLen = end - start;

      const data = new Float32Array(2 * L);
      for (let i = 0; i < segLen; i++) {
        data[i] = left[start + i];
        data[L + i] = right[start + i];
      }

      const tensor = new ort.Tensor("float32", data, [1, 2, L]);
      const res = await this.session.run({ [inName]: tensor });
      const od = res[outName].data; // [1, tracks, 2, L]

      // 三角窗（淡入淡出）做 overlap-add
      const win = new Float32Array(segLen);
      const half = stride * 0.5;
      for (let i = 0; i < segLen; i++) {
        const fi = Math.min(i / half, 1);
        const fo = Math.min((segLen - i) / half, 1);
        win[i] = Math.max(1e-4, Math.min(fi, fo));
      }

      for (let s = 0; s < tracks.length; s++) {
        const baseL = (s * 2 + 0) * L;
        const baseR = (s * 2 + 1) * L;
        const oL = outs[s].left;
        const oR = outs[s].right;
        for (let i = 0; i < segLen && start + i < total; i++) {
          oL[start + i] += od[baseL + i] * win[i];
          oR[start + i] += od[baseR + i] * win[i];
        }
      }
      for (let i = 0; i < segLen && start + i < total; i++) {
        weights[start + i] += win[i];
      }

      segIdx++;
      this.cb.onProgress?.(Math.min(segIdx / numSeg, 1), segIdx, numSeg);
      // 讓出主執行緒，UI 才能更新進度
      await new Promise((r) => setTimeout(r, 0));
    }

    for (let s = 0; s < tracks.length; s++) {
      const oL = outs[s].left;
      const oR = outs[s].right;
      for (let i = 0; i < total; i++) {
        if (weights[i] > 0) {
          oL[i] /= weights[i];
          oR[i] /= weights[i];
        }
      }
    }

    const result = {};
    tracks.forEach((name, idx) => (result[name] = outs[idx]));
    return result;
  }
}
