/**
 * exporters.js — 匯出工具
 *   - audioBufferToWav: AudioBuffer → 16-bit PCM WAV Blob
 *   - notesToMIDI:      音符序列 → SMF type-0 .mid Blob
 *   - downloadBlob:     觸發瀏覽器下載
 */

/** AudioBuffer → WAV (16-bit PCM) Blob。 */
export function audioBufferToWav(audioBuffer) {
  const numCh = audioBuffer.numberOfChannels;
  const sr = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = numFrames * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  let p = 0;
  const ws = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i)); };
  const u32 = (v) => { view.setUint32(p, v, true); p += 4; };
  const u16 = (v) => { view.setUint16(p, v, true); p += 2; };

  ws("RIFF"); u32(36 + dataSize); ws("WAVE");
  ws("fmt "); u32(16); u16(1); u16(numCh); u32(sr);
  u32(sr * blockAlign); u16(blockAlign); u16(16);
  ws("data"); u32(dataSize);

  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(audioBuffer.getChannelData(c));
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = chans[c][i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      p += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * 音符序列 → MIDI (SMF type-0) Blob。
 * @param {Array<{start:number,end:number,midi:number}>} notes 時間單位為秒
 * @param {{bpm?:number, ppq?:number}} [opts]
 */
export function notesToMIDI(notes, opts = {}) {
  const bpm = opts.bpm || 120;
  const ppq = opts.ppq || 480;
  const secToTick = (s) => Math.max(0, Math.round(s * (ppq * bpm) / 60));

  const events = [];
  for (const n of notes) {
    events.push({ tick: secToTick(n.start), on: true, midi: n.midi });
    events.push({ tick: secToTick(n.end), on: false, midi: n.midi });
  }
  // 同一 tick：先 note-off 再 note-on
  events.sort((a, b) => a.tick - b.tick || (a.on ? 1 : 0) - (b.on ? 1 : 0));

  const track = [];
  const pushVar = (v) => {
    const bytes = [v & 0x7f];
    v >>= 7;
    while (v > 0) { bytes.push((v & 0x7f) | 0x80); v >>= 7; }
    bytes.reverse();
    for (const b of bytes) track.push(b);
  };

  // tempo meta
  pushVar(0);
  track.push(0xff, 0x51, 0x03);
  const mpqn = Math.round(60000000 / bpm);
  track.push((mpqn >> 16) & 0xff, (mpqn >> 8) & 0xff, mpqn & 0xff);

  let last = 0;
  for (const e of events) {
    pushVar(e.tick - last);
    last = e.tick;
    if (e.on) track.push(0x90, e.midi & 0x7f, 90);
    else track.push(0x80, e.midi & 0x7f, 0);
  }
  // end of track
  pushVar(0);
  track.push(0xff, 0x2f, 0x00);

  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (ppq >> 8) & 0xff, ppq & 0xff];
  const tlen = track.length;
  const trkHeader = [0x4d, 0x54, 0x72, 0x6b, (tlen >> 24) & 0xff, (tlen >> 16) & 0xff, (tlen >> 8) & 0xff, tlen & 0xff];

  const bytes = new Uint8Array(header.length + trkHeader.length + tlen);
  bytes.set(header, 0);
  bytes.set(trkHeader, header.length);
  bytes.set(track, header.length + trkHeader.length);
  return new Blob([bytes], { type: "audio/midi" });
}

/** 觸發瀏覽器下載一個 Blob。 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
