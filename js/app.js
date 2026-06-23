/**
 * app.js — 主控制器
 * 串接 AudioEngine、Waveform 與 UI：檔案載入、傳輸控制、
 * 速度/音高、AB 循環、波形互動與鍵盤快捷鍵。
 */
import { AudioEngine } from "./player.js?v=8";
import { Waveform } from "./waveform.js?v=8";
import { StemSeparator, TRACK_LABELS, TRACK_ICONS } from "./separator.js?v=8";
import { detectChords } from "./chords.js?v=8";

const $ = (id) => document.getElementById(id);

// ---- DOM ----
const els = {
  dropzone: $("dropzone"),
  fileInput: $("fileInput"),
  pickBtn: $("pickBtn"),
  workspace: $("workspace"),
  trackName: $("trackName"),
  changeFileBtn: $("changeFileBtn"),
  waveWrap: $("waveWrap"),
  waveCanvas: $("waveCanvas"),
  overlayCanvas: $("overlayCanvas"),
  waveLoading: $("waveLoading"),
  curTime: $("curTime"),
  totalTime: $("totalTime"),
  rewindBtn: $("rewindBtn"),
  playBtn: $("playBtn"),
  loopBtn: $("loopBtn"),
  speed: $("speed"),
  speedVal: $("speedVal"),
  pitch: $("pitch"),
  pitchVal: $("pitchVal"),
  setABtn: $("setABtn"),
  aVal: $("aVal"),
  setBBtn: $("setBBtn"),
  bVal: $("bVal"),
  clearLoopBtn: $("clearLoopBtn"),
  helpBtn: $("helpBtn"),
  helpModal: $("helpModal"),
  closeHelpBtn: $("closeHelpBtn"),
  // 音軌分離
  sepPanel: $("sepPanel"),
  separateBtn: $("separateBtn"),
  sepProgress: $("sepProgress"),
  sepStageLabel: $("sepStageLabel"),
  sepBackend: $("sepBackend"),
  sepBar: $("sepBar"),
  sepLog: $("sepLog"),
  stemMixer: $("stemMixer"),
  stemToggles: $("stemToggles"),
  // 頻段 EQ
  eqToggle: $("eqToggle"),
  eqBody: $("eqBody"),
  eqLo: $("eqLo"),
  eqHi: $("eqHi"),
  eqLoVal: $("eqLoVal"),
  eqHiVal: $("eqHiVal"),
  eqDry: $("eqDry"),
  eqDryVal: $("eqDryVal"),
  spectrumCanvas: $("spectrumCanvas"),
  // 和弦偵測
  chordBtn: $("chordBtn"),
  chordProgress: $("chordProgress"),
  chordBar: $("chordBar"),
  chordLane: $("chordLane"),
  currentChord: $("currentChord"),
};

const engine = new AudioEngine();
const waveform = new Waveform(els.waveCanvas, els.overlayCanvas, els.waveWrap);

// AB 點（秒），null 表示未設定
let pointA = null;
let pointB = null;

// 音軌分離狀態
let currentFile = null; // 目前載入的檔案（供分離時以 44100 重新解碼）
let stems = null; // { drums, bass, other, vocals } @44100
let original44 = null; // 44100 的原曲 AudioBuffer（分離後作為「原曲」與切換基準）
let separator = null;
const enabledStems = new Set(); // 自訂混音中啟用的軌道
let currentTracks = []; // 目前模型分離出的軌道名稱

// 和弦偵測狀態
let analysisBuffer = null; // 載入時的原始解碼緩衝（供和弦分析）
let chordSegs = null; // [{start,end,label}]
let chordSegEls = []; // 對應的 DOM 元素
let lastChordIndex = -1;

// ---------- 工具 ----------
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const d = Math.floor((sec * 10) % 10);
  return `${m}:${String(s).padStart(2, "0")}.${d}`;
}

// ---------- 檔案載入 ----------
async function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith("audio/") && !/\.(mp3|wav|m4a|ogg|flac|aac|opus)$/i.test(file.name)) {
    alert("請選擇音訊檔（mp3 / wav / m4a / ogg / flac 等）");
    return;
  }

  els.dropzone.classList.add("hidden");
  els.workspace.classList.remove("hidden");
  els.waveLoading.classList.remove("hidden");
  els.trackName.textContent = file.name;
  currentFile = file;
  resetSeparationUI();
  resetChordUI();

  try {
    const buffer = await engine.loadFile(file);
    waveform.setBuffer(buffer);
    analysisBuffer = buffer;

    // 重設 AB
    pointA = null;
    pointB = null;
    updateLoopUI();

    els.totalTime.textContent = formatTime(engine.duration);
    els.curTime.textContent = formatTime(0);
    setPlayingUI(false);
    waveform.drawPlayhead(0);
  } catch (err) {
    console.error(err);
    alert("無法解碼這個音訊檔：" + (err && err.message ? err.message : err));
    els.workspace.classList.add("hidden");
    els.dropzone.classList.remove("hidden");
  } finally {
    els.waveLoading.classList.add("hidden");
  }
}

els.pickBtn.addEventListener("click", () => els.fileInput.click());
els.changeFileBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  handleFile(file);
  e.target.value = ""; // 允許重選同一檔
});

// 拖放
["dragenter", "dragover"].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("dragover");
  })
);
els.dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  handleFile(file);
});

// ---------- 傳輸控制 ----------
function setPlayingUI(playing) {
  els.playBtn.textContent = playing ? "⏸" : "▶";
}

els.playBtn.addEventListener("click", () => {
  if (!engine.isLoaded) return;
  engine.toggle();
  setPlayingUI(engine.isPlaying);
});

els.rewindBtn.addEventListener("click", () => {
  if (!engine.isLoaded) return;
  engine.seek(engine.loop ? engine.loopStart : 0);
});

engine.onEnded = () => setPlayingUI(false);

// ---------- 速度 / 音高 ----------
function updateSpeedUI() {
  els.speedVal.textContent = Math.round(engine.speed * 100) + "%";
  els.speed.value = String(engine.speed);
}
function updatePitchUI() {
  const s = engine.semitones;
  const sign = s > 0 ? "+" : s < 0 ? "" : "±";
  els.pitchVal.textContent = `${sign}${s} 半音`;
  els.pitch.value = String(s);
}

els.speed.addEventListener("input", () => {
  engine.setSpeed(parseFloat(els.speed.value));
  updateSpeedUI();
});
els.pitch.addEventListener("input", () => {
  engine.setSemitones(parseInt(els.pitch.value, 10));
  updatePitchUI();
});

document.querySelectorAll(".reset-link").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.reset === "speed") {
      engine.setSpeed(1);
      updateSpeedUI();
    } else {
      engine.setSemitones(0);
      updatePitchUI();
    }
  });
});

// ---------- AB 循環 ----------
function updateLoopUI() {
  els.aVal.textContent = "A " + (pointA == null ? "—" : formatTime(pointA));
  els.bVal.textContent = "B " + (pointB == null ? "—" : formatTime(pointB));

  const hasRegion = pointA != null && pointB != null && pointB > pointA;
  if (hasRegion) {
    engine.setLoopRegion(pointA, pointB);
    waveform.setRegion({ start: pointA, end: pointB });
  } else {
    waveform.setRegion(null);
    if (!hasRegion && engine.loop) {
      engine.setLoopEnabled(false);
    }
  }
  els.loopBtn.classList.toggle("active", engine.loop);
}

function toggleLoop() {
  if (pointA == null || pointB == null || pointB <= pointA) {
    // 沒有有效區段時，自動以「目前位置 → 結尾」或提示
    if (pointA == null) {
      alert("請先設定 A、B 點，或在波形上拖曳框選一段區間。");
      return;
    }
  }
  engine.setLoopEnabled(!engine.loop);
  els.loopBtn.classList.toggle("active", engine.loop);
}

els.loopBtn.addEventListener("click", toggleLoop);

els.setABtn.addEventListener("click", () => {
  pointA = engine.getPosition();
  if (pointB != null && pointB <= pointA) pointB = null;
  updateLoopUI();
});
els.setBBtn.addEventListener("click", () => {
  pointB = engine.getPosition();
  if (pointA != null && pointB <= pointA) pointA = null;
  updateLoopUI();
});
els.clearLoopBtn.addEventListener("click", () => {
  pointA = null;
  pointB = null;
  engine.clearLoop();
  updateLoopUI();
});

// ---------- 波形互動：點擊 seek / 拖曳框選 ----------
let dragState = null; // { startTime, moved }
const DRAG_THRESHOLD = 0.15; // 秒，小於視為點擊

els.overlayCanvas.parentElement.addEventListener("pointerdown", (e) => {
  if (!engine.isLoaded) return;
  els.waveWrap.setPointerCapture?.(e.pointerId);
  const t = waveform.pixelToTime(e.clientX);
  dragState = { startTime: t, moved: false };
});

els.waveWrap.addEventListener("pointermove", (e) => {
  if (!dragState || !engine.isLoaded) return;
  const t = waveform.pixelToTime(e.clientX);
  if (Math.abs(t - dragState.startTime) > DRAG_THRESHOLD) {
    dragState.moved = true;
    waveform.setTempRegion({
      start: Math.min(dragState.startTime, t),
      end: Math.max(dragState.startTime, t),
    });
  }
});

els.waveWrap.addEventListener("pointerup", (e) => {
  if (!dragState || !engine.isLoaded) return;
  const t = waveform.pixelToTime(e.clientX);

  if (dragState.moved) {
    // 完成框選 → 設為 AB 區段並開啟循環
    pointA = Math.min(dragState.startTime, t);
    pointB = Math.max(dragState.startTime, t);
    engine.setLoopEnabled(true);
    updateLoopUI();
  } else {
    // 視為點擊 → seek
    engine.seek(t);
    waveform.drawPlayhead(t);
    els.curTime.textContent = formatTime(t);
  }
  dragState = null;
});

els.waveWrap.addEventListener("pointercancel", () => {
  dragState = null;
  waveform.setTempRegion(null);
});

// ---------- 快捷鍵 ----------
window.addEventListener("keydown", (e) => {
  if (!engine.isLoaded) return;
  if (e.target.tagName === "INPUT" && e.target.type !== "range") return;

  switch (e.code) {
    case "Space":
      e.preventDefault();
      engine.toggle();
      setPlayingUI(engine.isPlaying);
      break;
    case "ArrowLeft":
      e.preventDefault();
      engine.skip(-5);
      break;
    case "ArrowRight":
      e.preventDefault();
      engine.skip(5);
      break;
    case "Home":
      e.preventDefault();
      engine.seek(engine.loop ? engine.loopStart : 0);
      break;
    case "ArrowUp":
      e.preventDefault();
      engine.setSpeed(Math.min(1.5, +(engine.speed + 0.05).toFixed(2)));
      updateSpeedUI();
      break;
    case "ArrowDown":
      e.preventDefault();
      engine.setSpeed(Math.max(0.25, +(engine.speed - 0.05).toFixed(2)));
      updateSpeedUI();
      break;
    case "KeyL":
      toggleLoop();
      break;
    case "KeyA":
      pointA = engine.getPosition();
      if (pointB != null && pointB <= pointA) pointB = null;
      updateLoopUI();
      break;
    case "KeyB":
      pointB = engine.getPosition();
      if (pointA != null && pointB <= pointA) pointA = null;
      updateLoopUI();
      break;
    case "BracketLeft":
      engine.setSemitones(Math.max(-12, engine.semitones - 1));
      updatePitchUI();
      break;
    case "BracketRight":
      engine.setSemitones(Math.min(12, engine.semitones + 1));
      updatePitchUI();
      break;
  }
});

// ---------- 說明彈窗 ----------
els.helpBtn.addEventListener("click", () => els.helpModal.classList.remove("hidden"));
els.closeHelpBtn.addEventListener("click", () => els.helpModal.classList.add("hidden"));
els.helpModal.addEventListener("click", (e) => {
  if (e.target === els.helpModal) els.helpModal.classList.add("hidden");
});

// ---------- 動畫迴圈：更新游標與時間 ----------
function tick() {
  if (engine.isLoaded) {
    engine.checkEnded();
    const pos = engine.getPosition();
    waveform.drawPlayhead(pos);
    els.curTime.textContent = formatTime(pos);
    if (!engine.isPlaying) setPlayingUI(false);
    spectrum.draw();
    updateCurrentChord(pos);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// 初始 UI
updateSpeedUI();
updatePitchUI();


// ============================================================
// 音軌分離
// ============================================================
let useOriginal = false; // 目前是否播放原曲（相對於自訂混音）

function setSepStage(text) { els.sepStageLabel.textContent = text; }
function setSepBar(pct) { els.sepBar.style.width = Math.max(0, Math.min(100, pct)) + "%"; }

function resetSeparationUI() {
  stems = null;
  original44 = null;
  separator = null;
  useOriginal = false;
  enabledStems.clear();
  currentTracks = [];
  els.stemToggles.innerHTML = "";
  els.separateBtn.disabled = false;
  els.separateBtn.textContent = "開始分離";
  els.separateBtn.classList.remove("hidden");
  els.sepProgress.classList.add("hidden");
  els.stemMixer.classList.add("hidden");
  els.sepBackend.textContent = "";
  setSepBar(0);
  els.sepLog.textContent = "";
  setSepStage("準備中…");
}

/** 依目前模型的軌道動態產生自訂混音按鈕。 */
function renderStemToggles() {
  els.stemToggles.innerHTML = "";
  for (const name of currentTracks) {
    const btn = document.createElement("button");
    btn.className = "stem-toggle";
    btn.dataset.stem = name;
    const icon = TRACK_ICONS[name] || "🎵";
    btn.textContent = `${icon} ${TRACK_LABELS[name] || name}`;
    els.stemToggles.appendChild(btn);
  }
}

/** 伴奏（去人聲）所對應的軌道。 */
function instTracks() {
  return currentTracks.filter((t) => t !== "vocals");
}

/** 以 44100Hz 解碼檔案（必要時重新取樣）。 */
async function decodeAt44100(file) {
  const arr = await file.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  let buf;
  try {
    const ac = new AC({ sampleRate: 44100 });
    buf = await ac.decodeAudioData(arr.slice(0));
    ac.close?.();
  } catch (_) {
    const ac = new AC();
    buf = await ac.decodeAudioData(arr.slice(0));
    ac.close?.();
  }
  if (buf.sampleRate === 44100) return buf;
  // 重新取樣到 44100
  const off = new OfflineAudioContext(
    buf.numberOfChannels,
    Math.ceil(buf.duration * 44100),
    44100
  );
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return await off.startRendering();
}

/** 把指定軌道相加成一個立體聲 AudioBuffer。 */
function buildMixBuffer(list) {
  const N = original44.length;
  const buf = new AudioBuffer({ length: N, numberOfChannels: 2, sampleRate: 44100 });
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  for (const name of list) {
    const s = stems[name];
    if (!s) continue;
    const n = Math.min(N, s.left.length);
    for (let i = 0; i < n; i++) {
      L[i] += s.left[i];
      R[i] += s.right[i];
    }
  }
  return buf;
}

/** 把新的緩衝載入引擎與波形，保留循環/位置/播放狀態。 */
async function swapBuffer(buf) {
  await engine.loadAudioBuffer(buf, { preserve: true });
  waveform.setBuffer(buf);
  if (pointA != null && pointB != null && pointB > pointA) {
    waveform.setRegion({ start: pointA, end: pointB });
  }
  setPlayingUI(engine.isPlaying);
}

async function applyMixFromStems() {
  useOriginal = false;
  const list = [...enabledStems];
  const buf = list.length ? buildMixBuffer(list) : new AudioBuffer({
    length: original44.length, numberOfChannels: 2, sampleRate: 44100,
  });
  await swapBuffer(buf);
  updateMixerUI();
}

async function loadOriginalMix() {
  useOriginal = true;
  enabledStems.clear();
  await swapBuffer(original44);
  updateMixerUI();
}

function setEq(set, arr) {
  return set.size === arr.length && arr.every((x) => set.has(x));
}

function updateMixerUI() {
  document.querySelectorAll(".preset").forEach((b) => {
    const p = b.dataset.preset;
    let active = false;
    if (p === "original") active = useOriginal;
    else if (p === "inst") active = !useOriginal && setEq(enabledStems, instTracks());
    else if (p === "vocals") active = !useOriginal && setEq(enabledStems, ["vocals"]);
    b.classList.toggle("active", active);
  });
  document.querySelectorAll(".stem-toggle").forEach((b) => {
    b.classList.toggle("on", !useOriginal && enabledStems.has(b.dataset.stem));
  });
}

async function runSeparation() {
  if (!currentFile) return;
  els.separateBtn.disabled = true;
  els.sepProgress.classList.remove("hidden");
  setSepStage("解碼音訊（44.1kHz）…");
  setSepBar(0);
  els.sepLog.textContent = "";

  try {
    original44 = await decodeAt44100(currentFile);

    separator = new StemSeparator({
      onBackend: (b) => { els.sepBackend.textContent = b.toUpperCase(); },
      onDownloadProgress: (loaded, total) => {
        setSepStage("下載 AI 模型…");
        if (total) setSepBar((loaded / total) * 100);
        const mb = (x) => (x / 1048576).toFixed(1);
        els.sepLog.textContent = total ? `${mb(loaded)} / ${mb(total)} MB` : `${mb(loaded)} MB`;
      },
      onProgress: (p, seg, tot) => {
        setSepStage("AI 分離中…");
        setSepBar(p * 100);
        els.sepLog.textContent = `區段 ${seg} / ${tot}`;
      },
      onLog: (phase, msg) => {
        if (phase === "init" || phase === "model") els.sepLog.textContent = msg;
      },
    });

    stems = await separator.separate(original44);
    currentTracks = separator.tracks.slice();
    renderStemToggles();

    // 切換引擎基準到 44100 原曲，之後各種混音切換才能完全對齊
    await engine.loadAudioBuffer(original44, { preserve: true });
    waveform.setBuffer(original44);
    if (pointA != null && pointB != null && pointB > pointA) {
      waveform.setRegion({ start: pointA, end: pointB });
    }

    setSepStage("完成！");
    setSepBar(100);
    els.sepProgress.classList.add("hidden");
    els.separateBtn.disabled = false;
    els.separateBtn.textContent = "重新分離";
    els.stemMixer.classList.remove("hidden");
    useOriginal = true;
    enabledStems.clear();
    updateMixerUI();
  } catch (err) {
    console.error(err);
    setSepStage("分離失敗");
    els.sepLog.textContent = (err && err.message) ? err.message : String(err);
    els.separateBtn.disabled = false;
  }
}

els.separateBtn.addEventListener("click", runSeparation);

document.querySelectorAll(".preset").forEach((b) =>
  b.addEventListener("click", async () => {
    if (!stems) return;
    const p = b.dataset.preset;
    if (p === "original") {
      await loadOriginalMix();
    } else if (p === "inst") {
      enabledStems.clear();
      instTracks().forEach((s) => enabledStems.add(s));
      await applyMixFromStems();
    } else if (p === "vocals") {
      enabledStems.clear();
      enabledStems.add("vocals");
      await applyMixFromStems();
    }
  })
);

// 自訂混音按鈕是動態產生的，用事件委派處理點擊
els.stemToggles.addEventListener("click", async (e) => {
  const b = e.target.closest(".stem-toggle");
  if (!b || !stems) return;
  const s = b.dataset.stem;
  if (useOriginal) {
    // 從原曲切到自訂：清空後只留這一軌
    useOriginal = false;
    enabledStems.clear();
    enabledStems.add(s);
  } else if (enabledStems.has(s)) {
    enabledStems.delete(s);
  } else {
    enabledStems.add(s);
  }
  await applyMixFromStems();
});


// ============================================================
// 頻段 EQ / 單頻段獨奏
// ============================================================
// 滑桿 0..1 對應 20Hz..20kHz（對數）
function sliderToFreq(x) {
  return 20 * Math.pow(1000, x);
}
function freqToSlider(f) {
  return Math.max(0, Math.min(1, Math.log(f / 20) / Math.log(1000)));
}
function formatFreq(f) {
  if (f >= 1000) {
    const k = f / 1000;
    return `${k >= 10 ? Math.round(k) : k.toFixed(1)} kHz`;
  }
  return `${Math.round(f)} Hz`;
}

function applyEqBandFromSliders() {
  const lo = sliderToFreq(parseFloat(els.eqLo.value));
  const hi = sliderToFreq(parseFloat(els.eqHi.value));
  engine.setEqBand(lo, hi);
  els.eqLoVal.textContent = formatFreq(Math.min(lo, hi));
  els.eqHiVal.textContent = formatFreq(Math.max(lo, hi));
}

function clearEqPresetHighlight() {
  document.querySelectorAll(".eq-preset").forEach((b) => b.classList.remove("active"));
}

function setEqEnabledUI(on) {
  engine.setEqEnabled(on);
  els.eqToggle.classList.toggle("active", on);
  els.eqToggle.textContent = on ? "停用" : "啟用";
  els.eqBody.classList.toggle("eq-off", !on);
}

els.eqToggle.addEventListener("click", () => {
  setEqEnabledUI(!engine.eqEnabled);
  if (engine.eqEnabled) applyEqBandFromSliders();
});

els.eqLo.addEventListener("input", () => {
  // 避免低頻越過高頻
  if (parseFloat(els.eqLo.value) > parseFloat(els.eqHi.value)) {
    els.eqHi.value = els.eqLo.value;
  }
  clearEqPresetHighlight();
  applyEqBandFromSliders();
});
els.eqHi.addEventListener("input", () => {
  if (parseFloat(els.eqHi.value) < parseFloat(els.eqLo.value)) {
    els.eqLo.value = els.eqHi.value;
  }
  clearEqPresetHighlight();
  applyEqBandFromSliders();
});
els.eqDry.addEventListener("input", () => {
  const pct = parseInt(els.eqDry.value, 10);
  engine.setEqDry(pct / 100);
  els.eqDryVal.textContent = pct + "%";
});

document.querySelectorAll(".eq-preset").forEach((b) =>
  b.addEventListener("click", () => {
    const lo = parseFloat(b.dataset.lo);
    const hi = parseFloat(b.dataset.hi);
    els.eqLo.value = String(freqToSlider(lo));
    els.eqHi.value = String(freqToSlider(hi));
    if (!engine.eqEnabled) setEqEnabledUI(true);
    applyEqBandFromSliders();
    clearEqPresetHighlight();
    b.classList.add("active");
  })
);


// ============================================================
// 即時頻譜分析器（對數頻率軸）
// ============================================================
const spectrum = (() => {
  const canvas = els.spectrumCanvas;
  const ctx = canvas.getContext("2d");
  const FMIN = 20;
  const FMAX = 20000;
  const DB_MIN = -100;
  const DB_MAX = -12;
  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue("--accent").trim() || "#5b8cff";
  const accent2 = styles.getPropertyValue("--accent-2").trim() || "#ffb454";
  let dpr = 1, W = 0, H = 0;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return false;
    const cw = Math.floor(w * dpr);
    const ch = Math.floor(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    W = canvas.width;
    H = canvas.height;
    return true;
  }

  function freqToX(f) {
    return (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * W;
  }

  function draw() {
    if (!resize()) return;
    ctx.clearRect(0, 0, W, H);

    // 頻率格線與標籤
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.font = `${11 * dpr}px -apple-system, sans-serif`;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = freqToX(f);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
      const label = f >= 1000 ? `${f / 1000}k` : `${f}`;
      ctx.fillText(label, x + 3 * dpr, H - 4 * dpr);
    }

    const data = engine.getSpectrum && engine.getSpectrum();
    if (!data || data.length === 0) return;

    const bins = data.length;
    const nyq = (engine.contextSampleRate || 44100) / 2;

    const grad = ctx.createLinearGradient(0, H, 0, 0);
    grad.addColorStop(0, accent);
    grad.addColorStop(1, accent2);
    ctx.fillStyle = grad;

    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x++) {
      const frac = x / W;
      const freq = FMIN * Math.pow(FMAX / FMIN, frac);
      let bin = Math.round((freq / nyq) * bins);
      if (bin < 0) bin = 0;
      else if (bin >= bins) bin = bins - 1;
      let db = data[bin];
      if (!isFinite(db)) db = DB_MIN;
      let norm = (db - DB_MIN) / (DB_MAX - DB_MIN);
      norm = norm < 0 ? 0 : norm > 1 ? 1 : norm;
      ctx.lineTo(x, H - norm * H);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  }

  return { draw };
})();


// ============================================================
// 自動和弦偵測
// ============================================================
function resetChordUI() {
  chordSegs = null;
  chordSegEls = [];
  lastChordIndex = -1;
  els.chordLane.innerHTML = "";
  els.chordLane.classList.add("hidden");
  els.chordProgress.classList.add("hidden");
  els.chordBar.style.width = "0%";
  els.currentChord.textContent = "—";
  els.chordBtn.disabled = false;
  els.chordBtn.textContent = "偵測和弦";
}

function renderChordLane() {
  els.chordLane.innerHTML = "";
  chordSegEls = [];
  if (!chordSegs || !chordSegs.length) return;
  const dur = engine.duration || analysisBuffer.duration;
  for (const seg of chordSegs) {
    const div = document.createElement("div");
    div.className = "chord-seg" + (seg.label === "N.C." ? " nc" : "");
    div.style.left = (seg.start / dur) * 100 + "%";
    div.style.width = Math.max(0, ((seg.end - seg.start) / dur) * 100) + "%";
    div.textContent = seg.label;
    div.title = `${seg.label}  (${formatTime(seg.start)})`;
    div.addEventListener("click", () => {
      engine.seek(seg.start);
      els.curTime.textContent = formatTime(seg.start);
    });
    els.chordLane.appendChild(div);
    chordSegEls.push(div);
  }
  els.chordLane.classList.remove("hidden");
}

function updateCurrentChord(pos) {
  if (!chordSegs || !chordSegs.length) return;
  let idx = -1;
  for (let i = 0; i < chordSegs.length; i++) {
    if (pos >= chordSegs[i].start && pos < chordSegs[i].end) { idx = i; break; }
  }
  if (idx === lastChordIndex) return;
  if (lastChordIndex >= 0 && chordSegEls[lastChordIndex]) {
    chordSegEls[lastChordIndex].classList.remove("active");
  }
  if (idx >= 0 && chordSegEls[idx]) {
    chordSegEls[idx].classList.add("active");
    els.currentChord.textContent = chordSegs[idx].label;
  }
  lastChordIndex = idx;
}

els.chordBtn.addEventListener("click", async () => {
  if (!analysisBuffer) return;
  els.chordBtn.disabled = true;
  els.chordBtn.textContent = "分析中…";
  els.chordProgress.classList.remove("hidden");
  els.chordBar.style.width = "0%";
  try {
    chordSegs = await detectChords(analysisBuffer, {
      onProgress: (p) => { els.chordBar.style.width = p * 100 + "%"; },
    });
    lastChordIndex = -1;
    renderChordLane();
    els.chordProgress.classList.add("hidden");
    els.chordBtn.textContent = "重新偵測";
    els.chordBtn.disabled = false;
  } catch (err) {
    console.error(err);
    els.chordBtn.textContent = "偵測失敗，重試";
    els.chordBtn.disabled = false;
    els.chordProgress.classList.add("hidden");
  }
});
