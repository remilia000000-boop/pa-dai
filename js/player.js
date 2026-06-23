/**
 * AudioEngine — 扒帶工具的播放核心
 *
 * 使用 Tone.js GrainPlayer（顆粒合成）達成：
 *   - 變速不變調：調整 playbackRate
 *   - 變調不變速：調整 detune（cents）
 *   - AB 循環：loop / loopStart / loopEnd
 *
 * GrainPlayer 本身沒有「目前播放位置」API，因此這裡以
 * Tone.now() 與起播時的位移自行推算，並處理循環的位置回繞。
 */
export class AudioEngine {
  constructor() {
    /** @type {Tone.GrainPlayer|null} */
    this.player = null;
    /** @type {AudioBuffer|null} 原始解碼緩衝（供波形繪製用） */
    this.audioBuffer = null;

    this.duration = 0;

    // 位置推算用
    this._startCtxTime = 0; // 起播當下的 Tone.now()
    this._startOffset = 0; // 起播時對應的音訊位置（秒）
    this._playing = false;

    // 參數
    this._speed = 1;
    this._semitones = 0;

    // 循環
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;

    // 播放自然結束時的回呼（由 app 設定）
    this.onEnded = null;

    // 輸出鏈：GrainPlayer → EQ → gain → limiter → destination
    this.limiter = null;
    this.outGain = null;
    this._volume = 1; // 使用者音量 0..1.5（折進 outGain，限幅器在後保護）

    // 頻段 EQ / 單頻段獨奏
    this.eqInput = null;
    this.dryGain = null;
    this.wetGain = null;
    this.hpf = null;
    this.lpf = null;
    this.eqSum = null;
    this._eqEnabled = false;
    this._eqLow = 20;
    this._eqHigh = 20000;
    this._eqDry = 0; // 0..1 混入原音比例

    // 頻譜分析
    this.analyser = null;
  }

  get isLoaded() {
    return !!this.player;
  }

  get isPlaying() {
    return this._playing;
  }

  /**
   * 解碼並載入音訊檔。
   * @param {File} file
   * @returns {Promise<AudioBuffer>}
   */
  async loadFile(file) {
    // 必須在使用者手勢中啟動 AudioContext
    await Tone.start();

    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await Tone.getContext().decodeAudioData(arrayBuffer);
    this._buildPlayer(audioBuffer, { resetLoop: true, resetPosition: true });
    return audioBuffer;
  }

  /**
   * 直接以既有的 AudioBuffer 載入（用於切換分離後的 stem 混音）。
   * @param {AudioBuffer} audioBuffer
   * @param {{preserve?:boolean}} [opts] preserve=true 時保留循環/位置/播放狀態
   */
  async loadAudioBuffer(audioBuffer, opts = {}) {
    await Tone.start();
    const preserve = !!opts.preserve;
    const prevPos = preserve ? this.getPosition() : 0;
    const wasPlaying = preserve ? this._playing : false;

    this._buildPlayer(audioBuffer, {
      resetLoop: !preserve,
      resetPosition: !preserve,
    });

    if (preserve) {
      // 夾在新長度範圍內
      this.loopStart = Math.min(this.loopStart, this.duration);
      this.loopEnd = Math.min(this.loopEnd, this.duration);
      this._applyLoopToPlayer();
      this._startOffset = Math.min(prevPos, this.duration);
      // 舊 player 已釋放，清掉殘留的播放旗標再決定是否續播
      this._playing = false;
      if (wasPlaying) this.play();
    }
    return audioBuffer;
  }

  /** 共用：以 AudioBuffer 建立 GrainPlayer 並套用目前參數。 */
  _buildPlayer(audioBuffer, { resetLoop, resetPosition }) {
    if (this.player) {
      try { this.player.stop(); } catch (_) {}
      this.player.dispose();
      this.player = null;
    }

    this.audioBuffer = audioBuffer;
    this.duration = audioBuffer.duration;

    // 持久的輸出鏈（只建立一次）：稍微降增益 + 限幅器，避免大聲段落爆音
    if (!this.limiter) {
      this.limiter = new Tone.Limiter(-1).toDestination();
      this.outGain = new Tone.Gain(0.85 * this._volume).connect(this.limiter);

      // 頻譜分析器（接在限幅器後，反映實際聽到的聲音）
      this.analyser = new Tone.Analyser("fft", 1024);
      this.analyser.smoothing = 0.7;
      this.limiter.connect(this.analyser);

      // EQ 鏈：eqInput 分成「乾路(dry)」與「頻段路(wet=HPF→LPF)」，再相加
      this.eqInput = new Tone.Gain(1);
      this.dryGain = new Tone.Gain(1); // 預設直通（EQ 關閉）
      this.wetGain = new Tone.Gain(0);
      this.hpf = new Tone.Filter({ type: "highpass", frequency: 20, rolloff: -48 });
      this.lpf = new Tone.Filter({ type: "lowpass", frequency: 20000, rolloff: -48 });
      this.eqSum = new Tone.Gain(1).connect(this.outGain);

      this.eqInput.connect(this.dryGain);
      this.dryGain.connect(this.eqSum);
      this.eqInput.connect(this.hpf);
      this.hpf.connect(this.lpf);
      this.lpf.connect(this.wetGain);
      this.wetGain.connect(this.eqSum);
    }

    const toneBuffer = new Tone.ToneAudioBuffer(audioBuffer);
    this.player = new Tone.GrainPlayer(toneBuffer).connect(this.eqInput);
    // 顆粒參數：grainSize 較大、overlap ≈ 一半，放慢時才不會把同一小段重播成卡頓
    this.player.grainSize = 0.2;
    this.player.overlap = 0.1;
    this.player.playbackRate = this._speed;
    this.player.detune = this._semitones * 100;

    if (resetPosition) {
      this._startOffset = 0;
      this._playing = false;
    }
    if (resetLoop) {
      this.loop = false;
      this.loopStart = 0;
      this.loopEnd = this.duration;
    }
    this._applyEq();
  }

  // ---------- 音量 ----------
  /** 設定音量（0..1.5，1=原始）。折進 outGain，限幅器在後保護不爆音。 */
  setVolume(v) {
    this._volume = Math.max(0, Math.min(1.5, v));
    if (this.outGain) this.outGain.gain.value = 0.85 * this._volume;
  }

  get volume() {
    return this._volume;
  }

  // ---------- 頻段 EQ / 單頻段獨奏 ----------
  _applyEq() {
    if (!this.eqInput) return;
    if (this._eqEnabled) {
      this.hpf.frequency.value = this._eqLow;
      this.lpf.frequency.value = this._eqHigh;
      this.wetGain.gain.value = 1;
      this.dryGain.gain.value = this._eqDry;
    } else {
      this.wetGain.gain.value = 0;
      this.dryGain.gain.value = 1;
    }
  }

  setEqEnabled(enabled) {
    this._eqEnabled = !!enabled;
    this._applyEq();
  }

  get eqEnabled() {
    return this._eqEnabled;
  }

  /** 設定通過頻段（Hz）。 */
  setEqBand(lowHz, highHz) {
    const lo = Math.max(20, Math.min(lowHz, highHz));
    const hi = Math.min(20000, Math.max(lowHz, highHz));
    this._eqLow = lo;
    this._eqHigh = Math.max(lo + 10, hi);
    this._applyEq();
  }

  /** 混入原音比例 0..1（0=完全只聽頻段，1=原音+頻段加強）。 */
  setEqDry(dry) {
    this._eqDry = Math.max(0, Math.min(1, dry));
    this._applyEq();
  }

  // ---------- 頻譜 ----------
  /** 取得 FFT 頻譜（dB 值的 Float32Array），未就緒回傳 null。 */
  getSpectrum() {
    return this.analyser ? this.analyser.getValue() : null;
  }

  /** 音訊內容(context)的取樣率，用於頻率軸換算。 */
  get contextSampleRate() {
    return Tone.getContext().sampleRate;
  }

  /** 取得目前播放位置（秒），已處理循環回繞。 */
  getPosition() {
    if (!this.player) return 0;
    let pos = this._startOffset;
    if (this._playing) {
      pos += (Tone.now() - this._startCtxTime) * this._speed;
    }

    if (this.loop && this.loopEnd > this.loopStart) {
      if (pos >= this.loopEnd) {
        const span = this.loopEnd - this.loopStart;
        pos = this.loopStart + ((pos - this.loopStart) % span);
      }
    } else if (pos > this.duration) {
      pos = this.duration;
    }
    return pos;
  }

  /** 偵測非循環播放是否已自然結束（由 app 的動畫迴圈呼叫）。 */
  checkEnded() {
    if (!this._playing || this.loop) return;
    const raw = this._startOffset + (Tone.now() - this._startCtxTime) * this._speed;
    if (raw >= this.duration) {
      this._playing = false;
      this._startOffset = this.duration;
      try { this.player.stop(); } catch (_) {}
      if (typeof this.onEnded === "function") this.onEnded();
    }
  }

  play() {
    if (!this.player || this._playing) return;

    let offset = this._startOffset;
    if (offset >= this.duration - 0.02) offset = 0; // 從頭播

    this._applyLoopToPlayer();

    if (this.loop && this.loopEnd > this.loopStart) {
      if (offset < this.loopStart || offset >= this.loopEnd) {
        offset = this.loopStart;
      }
    }

    this.player.start(undefined, offset);
    this._startCtxTime = Tone.now();
    this._startOffset = offset;
    this._playing = true;
  }

  pause() {
    if (!this.player || !this._playing) return;
    this._startOffset = this.getPosition();
    this._playing = false;
    try { this.player.stop(); } catch (_) {}
  }

  toggle() {
    if (this._playing) this.pause();
    else this.play();
  }

  /** 跳到指定時間（秒）。 */
  seek(time) {
    if (!this.player) return;
    time = Math.max(0, Math.min(time, this.duration));
    const wasPlaying = this._playing;
    if (wasPlaying) {
      try { this.player.stop(); } catch (_) {}
    }
    this._startOffset = time;
    if (wasPlaying) {
      this._applyLoopToPlayer();
      this.player.start(undefined, time);
      this._startCtxTime = Tone.now();
      this._playing = true;
    }
  }

  /** 相對跳轉（秒，可負）。 */
  skip(deltaSeconds) {
    this.seek(this.getPosition() + deltaSeconds);
  }

  stop() {
    if (!this.player) return;
    try { this.player.stop(); } catch (_) {}
    this._playing = false;
    this._startOffset = this.loop ? this.loopStart : 0;
  }

  /** 設定速度（不影響音高）。播放中即時生效並重設位置基準。 */
  setSpeed(rate) {
    if (this._playing) {
      this._startOffset = this.getPosition();
      this._startCtxTime = Tone.now();
    }
    this._speed = rate;
    if (this.player) this.player.playbackRate = rate;
  }

  get speed() { return this._speed; }

  /** 設定音高（半音，不影響速度）。 */
  setSemitones(semi) {
    this._semitones = semi;
    if (this.player) this.player.detune = semi * 100;
  }

  get semitones() { return this._semitones; }

  setLoopEnabled(enabled) {
    this.loop = enabled;
    this._applyLoopToPlayer();
  }

  setLoopRegion(a, b) {
    const start = Math.max(0, Math.min(a, b));
    const end = Math.min(this.duration, Math.max(a, b));
    this.loopStart = start;
    this.loopEnd = end;
    this._applyLoopToPlayer();
  }

  clearLoop() {
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = this.duration;
    this._applyLoopToPlayer();
  }

  _applyLoopToPlayer() {
    if (!this.player) return;
    const valid = this.loop && this.loopEnd > this.loopStart;
    this.player.loop = valid;
    if (valid) {
      this.player.loopStart = this.loopStart;
      this.player.loopEnd = this.loopEnd;
    }
  }
}
