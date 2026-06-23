/**
 * app.js — 主控制器
 * 串接 AudioEngine、Waveform 與 UI：檔案載入、傳輸控制、
 * 速度/音高、AB 循環、波形互動與鍵盤快捷鍵。
 */
import { AudioEngine } from "./player.js";
import { Waveform } from "./waveform.js";

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
};

const engine = new AudioEngine();
const waveform = new Waveform(els.waveCanvas, els.overlayCanvas, els.waveWrap);

// AB 點（秒），null 表示未設定
let pointA = null;
let pointB = null;

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

  try {
    const buffer = await engine.loadFile(file);
    waveform.setBuffer(buffer);

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
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// 初始 UI
updateSpeedUI();
updatePitchUI();
