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

    // 輸出鏈：GrainPlayer → gain → limiter → destination（防止爆音/硬截波）
    this.limiter = null;
    this.outGain = null;
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
      this.outGain = new Tone.Gain(0.85).connect(this.limiter);
    }

    const toneBuffer = new Tone.ToneAudioBuffer(audioBuffer);
    this.player = new Tone.GrainPlayer(toneBuffer).connect(this.outGain);
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
