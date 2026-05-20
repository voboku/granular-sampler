"use strict";

const state = {
  audioContext: null,
  buffer: null,
  mono: null,
  fileName: "",
  slices: [],
  hover: -1,
  pinned: -1,
  waveHover: -1,
  selected: -1,
  source: null,
  gain: null,
  grainInterval: 0,
  grainStopTimer: 0,
  grainSources: new Set(),
  grainVoice: 0,
  freezeOffset: null,
  outputGain: null,
  outputFilter: null,
  outputCompressor: null,
  audioElement: null,
  audioStopTimer: 0,
  audioUrl: "",
  audioUnlocked: false,
  mediaRecorder: null,
  recordingChunks: [],
  recordingInput: null,
  recordingLength: 0,
  recordingMaxLength: 0,
  recordingProcessor: null,
  recordingSilence: null,
  recordingSource: null,
  recordingStream: null,
  recordingStartedAt: 0,
  lastRecordingBlob: null,
  lastRecordingName: "",
  lastRecordingUrl: "",
  playingId: -1,
  playbackStartedAt: 0,
  playbackSliceIndex: -1,
  animationFrame: 0,
  mapPulseTimer: 0,
  mapBounds: { left: 0, top: 0, width: 1, height: 1 },
  mapSize: { width: 1, height: 1 },
  traces: [],
  lastTriggerAt: 0,
  lastTriggerIndex: -1,
  mapView: { zoom: 1, panX: 0, panY: 0 },
  touchGesture: {
    lastTapAt: 0,
    lastCenter: null,
    lastDistance: 0,
    longPressTimer: 0,
    longPressIndex: -1,
    pinching: false,
  },
};

const $ = (id) => document.getElementById(id);

const els = {
  fileInput: $("fileInput"),
  recordButton: $("recordButton"),
  saveButton: $("saveButton"),
  analyzeButton: $("analyzeButton"),
  stopButton: $("stopButton"),
  fileName: $("fileName"),
  statusText: $("statusText"),
  targetCount: $("targetCount"),
  targetCountValue: $("targetCountValue"),
  granularMode: $("granularMode"),
  macroAmount: $("macroAmount"),
  macroAmountValue: $("macroAmountValue"),
  stretchAmount: $("stretchAmount"),
  stretchAmountValue: $("stretchAmountValue"),
  scanAmount: $("scanAmount"),
  scanAmountValue: $("scanAmountValue"),
  pitchSpread: $("pitchSpread"),
  pitchSpreadValue: $("pitchSpreadValue"),
  freezeMode: $("freezeMode"),
  toneAmount: $("toneAmount"),
  toneAmountValue: $("toneAmountValue"),
  loopSlice: $("loopSlice"),
  durationStat: $("durationStat"),
  chopStat: $("chopStat"),
  infoChops: $("infoChops"),
  infoDuration: $("infoDuration"),
  infoMode: $("infoMode"),
  waveCanvas: $("waveCanvas"),
  mapCanvas: $("mapCanvas"),
};
els.fileButton = document.querySelector(".file-button");

function getAudioContext() {
  if (!state.audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("Web Audio is not available in this browser.");
    }
    state.audioContext = new AudioContextClass();
  }
  return state.audioContext;
}

async function unlockAudio() {
  const ctx = getAudioContext();
  if (ctx.state === "suspended" || ctx.state === "interrupted") {
    try {
      await ctx.resume();
    } catch {
      // iOS may reject resume outside a direct gesture; the next touch will retry.
    }
  }
  if (!state.audioUnlocked && ctx.state === "running") {
    try {
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      gain.gain.value = 0.0001;
      source.connect(gain).connect(ctx.destination);
      source.start(0);
      state.audioUnlocked = true;
    } catch {
      // A failed silent primer is harmless; real playback will still attempt to resume.
    }
  }
}

function primeAudioNow() {
  let ctx;
  try {
    ctx = getAudioContext();
  } catch {
    return;
  }
  try {
    ctx.resume?.();
  } catch {
    // iOS will retry from the next direct gesture.
  }
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 220;
    gain.gain.setValueAtTime(0.0008, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.035);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.04);
    state.audioUnlocked = true;
  } catch {
    // Primer failure is non-fatal.
  }
}

function isIOS() {
  return /iPad|iPhone|iPod/u.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function setStatus(text) {
  els.statusText.textContent = text;
}

function updateInfo() {
  const total = Number(els.targetCount.value);
  if (els.infoChops) els.infoChops.textContent = `${state.slices.length} / ${total}`;
  if (els.infoDuration) els.infoDuration.textContent = state.buffer ? formatTime(state.buffer.duration) : "--";
  if (els.infoMode) els.infoMode.textContent = els.granularMode.checked ? "Granular" : "Normal";
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  const minutes = Math.floor(seconds / 60);
  const secs = seconds - minutes * 60;
  return minutes ? `${minutes}:${secs.toFixed(2).padStart(5, "0")}` : `${secs.toFixed(3)}s`;
}

function themeColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function mixToMono(buffer) {
  const out = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i += 1) {
      out[i] += data[i] / buffer.numberOfChannels;
    }
  }
  return out;
}

async function loadFile(file) {
  stopPlayback();
  const ctx = getAudioContext();
  const data = await file.arrayBuffer();
  const decodeData = data.slice(0);
  const buffer = await ctx.decodeAudioData(decodeData);
  state.buffer = buffer;
  state.mono = mixToMono(buffer);
  state.fileName = file.name;
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.audioUrl = URL.createObjectURL(file);
  state.audioElement = new Audio(state.audioUrl);
  state.audioElement.preload = "auto";
  state.audioElement.playsInline = true;
  state.slices = [];
  state.hover = -1;
  state.pinned = -1;
  state.waveHover = -1;
  state.selected = -1;
  els.fileName.textContent = file.name;
  els.durationStat.textContent = formatTime(buffer.duration);
  els.chopStat.textContent = "0";
  els.analyzeButton.disabled = false;
  els.stopButton.disabled = false;
  setStatus("Ready");
  updateInfo();
  drawAll();
  startMapPulse();
}

async function startRecording() {
  const ctx = getAudioContext();
  await unlockAudio();
  try {
    const input = ctx.createGain();
    const processor = ctx.createScriptProcessor(4096, 2, 1);
    const silence = ctx.createGain();
    silence.gain.value = 0;
    state.recordingChunks = [];
    state.recordingLength = 0;
    state.recordingMaxLength = ctx.sampleRate * 90;
    state.recordingInput = input;
    state.recordingProcessor = processor;
    state.recordingSilence = silence;
    state.recordingStartedAt = performance.now();
    state.mediaRecorder = { state: "recording" };
    processor.onaudioprocess = (event) => {
      if (!state.mediaRecorder || state.mediaRecorder.state !== "recording") return;
      const frames = event.inputBuffer.length;
      const remaining = state.recordingMaxLength - state.recordingLength;
      if (remaining <= 0) {
        window.setTimeout(stopRecording, 0);
        return;
      }
      const writeFrames = Math.min(frames, remaining);
      const mixed = new Float32Array(writeFrames);
      const channels = Math.max(1, event.inputBuffer.numberOfChannels);
      for (let channel = 0; channel < channels; channel += 1) {
        const data = event.inputBuffer.getChannelData(channel);
        for (let i = 0; i < writeFrames; i += 1) mixed[i] += data[i] / channels;
      }
      state.recordingChunks.push(mixed);
      state.recordingLength += writeFrames;
      if (state.recordingLength >= state.recordingMaxLength) window.setTimeout(stopRecording, 0);
    };
    input.connect(processor);
    processor.connect(silence);
    silence.connect(ctx.destination);
    connectOutputRecorder();
    els.recordButton.textContent = "Stop Rec";
    els.recordButton.classList.add("is-recording");
    setStatus("Output Rec");
  } catch (error) {
    console.error(error);
    setStatus("Record error");
    stopRecordingStream();
  }
}

function isOutputRecording() {
  return Boolean(state.mediaRecorder && state.mediaRecorder.state === "recording");
}

function connectOutputRecorder() {
  if (!isOutputRecording() || !state.outputCompressor || !state.recordingInput) return;
  try {
    state.outputCompressor.connect(state.recordingInput);
  } catch {
    // The recorder may already be connected to this output chain.
  }
}

function stopRecording() {
  if (!state.mediaRecorder) return;
  state.mediaRecorder.state = "inactive";
  els.recordButton.textContent = "Record";
  els.recordButton.classList.remove("is-recording");
  setStatus("Saving");
  handleRecordingStop();
}

function stopRecordingStream() {
  try {
    state.recordingInput?.disconnect();
    state.recordingProcessor?.disconnect();
    state.recordingSource?.disconnect();
    state.recordingSilence?.disconnect();
  } catch {
    // Recording nodes may already be disconnected.
  }
  state.recordingInput = null;
  state.recordingProcessor = null;
  state.recordingSource = null;
  state.recordingSilence = null;
  if (state.recordingStream) {
    for (const track of state.recordingStream.getTracks()) track.stop();
  }
  state.recordingStream = null;
}

async function handleRecordingStop() {
  const chunks = state.recordingChunks;
  const length = state.recordingLength;
  state.mediaRecorder = null;
  state.recordingChunks = [];
  state.recordingLength = 0;
  state.recordingMaxLength = 0;
  stopRecordingStream();
  if (!chunks.length || !length) {
    setStatus("No sound");
    return;
  }
  const seconds = Math.max(0.1, (performance.now() - state.recordingStartedAt) / 1000);
  const samples = await flattenAudioChunksAsync(chunks, length);
  const blob = await encodeWavAsync(samples, getAudioContext().sampleRate);
  const name = `recording-${Date.now()}.wav`;
  try {
    const file = new File([blob], name, { type: "audio/wav" });
    storeRecordingForSave(blob, name);
    await loadFile(file);
    setStatus(`Recorded ${formatTime(seconds)}`);
  } catch (error) {
    console.error(error);
    setStatus("Record error");
  }
}

function storeRecordingForSave(blob, name) {
  if (state.lastRecordingUrl) URL.revokeObjectURL(state.lastRecordingUrl);
  state.lastRecordingBlob = blob;
  state.lastRecordingName = name;
  state.lastRecordingUrl = URL.createObjectURL(blob);
  els.saveButton.disabled = false;
}

async function saveLastRecording() {
  if (!state.lastRecordingBlob || !state.lastRecordingUrl) {
    setStatus("No recording");
    return;
  }
  const name = state.lastRecordingName || "recording.wav";
  const file = new File([state.lastRecordingBlob], name, { type: "audio/wav" });
  if (window.showSaveFilePicker) {
    try {
      setStatus("Choose file");
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [
          {
            description: "WAV audio",
            accept: { "audio/wav": [".wav"] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(state.lastRecordingBlob);
      await writable.close();
      setStatus("Saved");
      return;
    } catch (error) {
      if (error?.name !== "AbortError") console.error(error);
    }
  }
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      setStatus("Shared");
      return;
    } catch (error) {
      if (error?.name !== "AbortError") console.error(error);
    }
  }
  const link = document.createElement("a");
  link.href = state.lastRecordingUrl;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setStatus("Saving");
  window.setTimeout(() => {
    if (document.visibilityState === "visible") {
      window.open(state.lastRecordingUrl, "_blank", "noopener");
      setStatus("Opened");
    }
  }, 350);
}

async function flattenAudioChunksAsync(chunks, length) {
  const output = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
    if (offset % 262144 < chunk.length) await frame();
  }
  return output;
}

async function encodeWavAsync(samples, sampleRate) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    offset += 2;
    if (i > 0 && i % 131072 === 0) await frame();
  }
  return new Blob([view], { type: "audio/wav" });
}

function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function rms(data, start, end) {
  let sum = 0;
  const length = Math.max(1, end - start);
  for (let i = start; i < end; i += 1) sum += data[i] * data[i];
  return Math.sqrt(sum / length);
}

function peak(data, start, end) {
  let max = 0;
  for (let i = start; i < end; i += 1) max = Math.max(max, Math.abs(data[i]));
  return max;
}

function zeroCrossingRate(data, start, end) {
  let crossings = 0;
  let prev = data[start] >= 0;
  for (let i = start + 1; i < end; i += 1) {
    const sign = data[i] >= 0;
    if (sign !== prev) crossings += 1;
    prev = sign;
  }
  return crossings / Math.max(1, end - start);
}

function spectralFeatures(data, start, end, sampleRate) {
  const length = Math.max(1, end - start);
  const maxReads = 2048;
  const step = Math.max(1, Math.floor(length / maxReads));
  let low = 0;
  let high = 0;
  let rough = 0;
  let crossings = 0;
  let reads = 0;
  let prev = data[start] || 0;
  let prevDelta = 0;
  let prevSign = prev >= 0;

  for (let i = start + step; i < end; i += step) {
    const sample = data[i] || 0;
    const delta = sample - prev;
    low += Math.abs(sample);
    high += Math.abs(delta);
    rough += Math.abs(delta - prevDelta);
    const sign = sample >= 0;
    if (sign !== prevSign) crossings += 1;
    prevSign = sign;
    prev = sample;
    prevDelta = delta;
    reads += 1;
  }

  const highRatio = high / Math.max(low + high, 1e-9);
  const crossingRatio = crossings / Math.max(1, reads);
  const roughRatio = rough / Math.max(high + rough, 1e-9);
  const nyquist = sampleRate / 2;
  const centroid = Math.min(nyquist, nyquist * (0.08 + highRatio * 0.62 + crossingRatio * 0.3));
  const rolloff = Math.min(nyquist, centroid * (1.45 + roughRatio));
  const flatness = Math.max(0, Math.min(1, highRatio * 0.65 + roughRatio * 0.35));
  return { centroid, rolloff, flatness };
}

function percentile(values, pct) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * pct)));
  return sorted[index] || 0;
}

function makeOnsetSlices(target, sensitivity, minSliceMs) {
  const data = state.mono;
  const sr = state.buffer.sampleRate;
  const frame = 1024;
  const hop = 512;
  const minGap = Math.max(1, Math.floor((minSliceMs / 1000) * sr));
  const energies = [];
  for (let i = 0; i + frame < data.length; i += hop) {
    energies.push(rms(data, i, i + frame));
  }

  const novelty = [];
  for (let i = 1; i < energies.length; i += 1) {
    novelty.push(Math.max(0, energies[i] - energies[i - 1]));
  }

  const pct = 0.995 - (sensitivity / 100) * 0.23;
  const threshold = percentile(novelty, pct);
  const candidates = [];
  for (let i = 1; i < novelty.length - 1; i += 1) {
    if (novelty[i] >= threshold && novelty[i] > novelty[i - 1] && novelty[i] >= novelty[i + 1]) {
      candidates.push({ sample: i * hop, score: novelty[i] });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const cuts = [0, data.length];
  for (const hit of candidates) {
    if (cuts.length >= target + 1) break;
    if (cuts.every((cut) => Math.abs(cut - hit.sample) >= minGap)) cuts.push(hit.sample);
  }

  cuts.sort((a, b) => a - b);
  while (cuts.length < target + 1) {
    let widestIndex = 0;
    let widest = 0;
    for (let i = 0; i < cuts.length - 1; i += 1) {
      const gap = cuts[i + 1] - cuts[i];
      if (gap > widest) {
        widest = gap;
        widestIndex = i;
      }
    }
    if (widest <= 2) break;
    cuts.splice(widestIndex + 1, 0, Math.floor((cuts[widestIndex] + cuts[widestIndex + 1]) / 2));
  }

  return cuts.slice(0, target + 1).sort((a, b) => a - b).flatMap((cut, i, arr) => {
    if (i >= arr.length - 1) return [];
    return [{ start: cut, end: Math.max(cut + 1, arr[i + 1]) }];
  });
}

function standardize(matrix) {
  const cols = matrix[0].length;
  const mean = Array(cols).fill(0);
  const sd = Array(cols).fill(0);
  for (const row of matrix) row.forEach((v, i) => (mean[i] += v));
  mean.forEach((_, i) => (mean[i] /= matrix.length));
  for (const row of matrix) row.forEach((v, i) => (sd[i] += (v - mean[i]) ** 2));
  sd.forEach((_, i) => (sd[i] = Math.sqrt(sd[i] / matrix.length) || 1));
  return matrix.map((row) => row.map((v, i) => (v - mean[i]) / sd[i]));
}

function covariance(matrix) {
  const cols = matrix[0].length;
  const cov = Array.from({ length: cols }, () => Array(cols).fill(0));
  for (const row of matrix) {
    for (let i = 0; i < cols; i += 1) {
      for (let j = 0; j < cols; j += 1) cov[i][j] += row[i] * row[j];
    }
  }
  for (let i = 0; i < cols; i += 1) {
    for (let j = 0; j < cols; j += 1) cov[i][j] /= Math.max(1, matrix.length - 1);
  }
  return cov;
}

function powerVector(cov, avoid = null) {
  let v = Array(cov.length).fill(0).map((_, i) => (i === 0 ? 1 : 0.25 / (i + 1)));
  for (let iter = 0; iter < 40; iter += 1) {
    const next = v.map((_, i) => cov[i].reduce((sum, val, j) => sum + val * v[j], 0));
    if (avoid) {
      const dot = next.reduce((sum, val, i) => sum + val * avoid[i], 0);
      next.forEach((_, i) => (next[i] -= dot * avoid[i]));
    }
    const norm = Math.sqrt(next.reduce((sum, val) => sum + val * val, 0)) || 1;
    v = next.map((val) => val / norm);
  }
  return v;
}

function embedSlices(slices) {
  const features = slices.map((s) => [
    Math.log10(s.rms + 1e-5),
    Math.log10(s.peak + 1e-5),
    Math.log10(s.centroid + 1),
    Math.log10(s.rolloff + 1),
    s.zcr * 100,
    s.flatness,
    Math.log10(s.duration + 0.001),
  ]);
  const normalized = standardize(features);
  const cov = covariance(normalized);
  const pc1 = powerVector(cov);
  const pc2 = powerVector(cov, pc1);
  const points = normalized.map((row) => ({
    x: row.reduce((sum, val, i) => sum + val * pc1[i], 0),
    y: row.reduce((sum, val, i) => sum + val * pc2[i], 0),
  }));
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  points.forEach((p, i) => {
    const jitter = ((i * 9301 + 49297) % 233280) / 233280 - 0.5;
    const density = Math.min(1, slices.length / 1000);
    const x = (p.x - minX) / Math.max(1e-9, maxX - minX);
    const y = 1 - (p.y - minY) / Math.max(1e-9, maxY - minY);
    const spread = 1 + density * 0.22;
    slices[i].x = 0.5 + (x - 0.5) * spread + jitter * (0.022 + density * 0.026);
    slices[i].y = 0.5 + (y - 0.5) * spread + jitter * (0.022 + density * 0.026);
  });
  spreadPoints(slices);
}

function spreadPoints(slices) {
  if (slices.length < 2) return;
  const limit = Math.min(slices.length, 1000);
  const density = Math.min(1, slices.length / 1000);
  const minDist = 0.014 + density * 0.01;
  const passes = Math.round(10 + density * 12);
  for (let pass = 0; pass < passes; pass += 1) {
    for (let i = 0; i < limit; i += 1) {
      for (let j = i + 1; j < limit; j += 1) {
        const a = slices[i];
        const b = slices[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist >= minDist) continue;
        if (dist < 0.0001) {
          dx = ((i % 7) - 3) * 0.001;
          dy = ((j % 7) - 3) * 0.001;
          dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
        }
        const push = ((minDist - dist) / dist) * (0.18 + density * 0.12);
        a.x -= dx * push;
        a.y -= dy * push;
        b.x += dx * push;
        b.y += dy * push;
      }
    }
  }
  for (const slice of slices) {
    slice.x = softLimit(slice.x);
    slice.y = softLimit(slice.y);
  }
}

function softLimit(value) {
  return 0.5 + Math.tanh((value - 0.5) * 1.55) / 2.1;
}

async function analyze() {
  if (!state.buffer || !state.mono) return;
  stopPlayback();
  const target = Number(els.targetCount.value);
  const sensitivity = 58;
  const minSliceMs = 45;
  els.analyzeButton.disabled = true;
  setStatus("Chopping");
  await frame();

  const raw = makeOnsetSlices(target, sensitivity, minSliceMs);
  const sr = state.buffer.sampleRate;
  const slices = [];
  const total = raw.length;

  for (let i = 0; i < total; i += 1) {
    if (i % 40 === 0) {
      setStatus(`Mapping ${i}/${total}`);
      await frame();
    }
    const start = raw[i].start;
    const end = raw[i].end;
    const spec = spectralFeatures(state.mono, start, end, sr);
    const item = {
      id: i + 1,
      start,
      end,
      startSec: start / sr,
      duration: (end - start) / sr,
      rms: rms(state.mono, start, end),
      peak: peak(state.mono, start, end),
      zcr: zeroCrossingRate(state.mono, start, end),
      ...spec,
    };
    item.color = colorFor(item);
    slices.push(item);
  }

  const audibleSlices = filterAudibleSlices(slices);
  embedSlices(audibleSlices);
  state.slices = audibleSlices;
  state.selected = audibleSlices.length ? 0 : -1;
  state.pinned = -1;
  els.chopStat.textContent = String(audibleSlices.length);
  els.analyzeButton.disabled = false;
  setStatus(`${audibleSlices.length} chops`);
  updateInfo();
  drawAll();
}

function frame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function colorFor(slice) {
  return themeColor("--point");
}

function filterAudibleSlices(slices) {
  if (!slices.length) return [];
  const rmsValues = slices.map((slice) => slice.rms);
  const peakValues = slices.map((slice) => slice.peak);
  const rmsGate = Math.max(0.0015, percentile(rmsValues, 0.12) * 0.72);
  const peakGate = Math.max(0.008, percentile(peakValues, 0.1) * 0.68);
  const audible = slices.filter((slice) => slice.rms >= rmsGate || slice.peak >= peakGate);
  if (audible.length) {
    audible.forEach((slice, index) => {
      slice.id = index + 1;
    });
    return audible;
  }
  return slices.filter((slice) => slice.peak > 0.001).map((slice, index) => {
    slice.id = index + 1;
    return slice;
  });
}

function drawAll() {
  drawWaveform();
  safeDrawMap();
}

function startMapPulse() {
  if (state.mapPulseTimer) return;
  const tick = () => {
    if (state.slices.length) safeDrawMap();
    state.mapPulseTimer = window.setTimeout(tick, isIOS() ? 260 : 190);
  };
  state.mapPulseTimer = window.setTimeout(tick, 190);
}

function safeDrawMap() {
  try {
    drawMap();
  } catch (error) {
    console.error(error);
  }
}

function drawWaveform() {
  const { ctx, width, height } = resizeCanvas(els.waveCanvas);
  ctx.clearRect(0, 0, width, height);
  if (!state.mono) return;

  const waveTop = 8;
  const waveBottom = height - 8;
  const waveHeight = Math.max(24, waveBottom - waveTop);
  const mid = height * 0.5;
  const amp = waveHeight * 0.46;
  const activeIndex = getWaveActiveIndex();
  const activeSlice = state.slices[activeIndex];

  ctx.strokeStyle = themeColor("--line");
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid + 0.5);
  ctx.lineTo(width, mid + 0.5);
  ctx.stroke();

  const samplesPerPixel = Math.max(1, Math.floor(state.mono.length / width));
  ctx.strokeStyle = themeColor("--wave");
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < width; x += 1) {
    const start = Math.floor(x * samplesPerPixel);
    const end = Math.min(state.mono.length, start + samplesPerPixel);
    let min = 1;
    let max = -1;
    for (let i = start; i < end; i += 1) {
      min = Math.min(min, state.mono[i]);
      max = Math.max(max, state.mono[i]);
    }
    ctx.moveTo(x, mid + min * amp);
    ctx.lineTo(x, mid + max * amp);
  }
  ctx.stroke();

  if (activeSlice) {
    const x = getPlayheadX(activeSlice, width);
    ctx.strokeStyle = themeColor("--playhead");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, waveTop);
    ctx.lineTo(x + 0.5, waveBottom);
    ctx.stroke();

    ctx.fillStyle = themeColor("--playhead");
    ctx.beginPath();
    ctx.arc(x, waveTop, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function sampleToWaveX(sample, width) {
  return (sample / Math.max(1, state.mono.length)) * width;
}

function getWaveActiveIndex() {
  if (state.playbackSliceIndex >= 0) return state.playbackSliceIndex;
  return -1;
}

function getPlayheadX(slice, width) {
  if (isIOS() && state.audioElement && state.playingId === slice.id && !els.granularMode.checked) {
    const progress = slice.duration > 0 ? clamp((state.audioElement.currentTime - slice.startSec) / slice.duration, 0, 1) : 0;
    const sample = slice.start + (slice.end - slice.start) * progress;
    return sampleToWaveX(sample, width);
  }
  if (state.playbackSliceIndex < 0 || state.playingId !== slice.id || !state.audioContext) {
    return sampleToWaveX(slice.start, width);
  }
  const elapsed = Math.max(0, state.audioContext.currentTime - state.playbackStartedAt);
  const progress = slice.duration > 0 ? (elapsed % slice.duration) / slice.duration : 0;
  const sample = slice.start + (slice.end - slice.start) * progress;
  return sampleToWaveX(sample, width);
}

function drawMap() {
  const { ctx, width, height } = resizeCanvas(els.mapCanvas);
  ctx.clearRect(0, 0, width, height);
  const bleed = Math.max(28, Math.min(width, height) * 0.06);
  state.mapBounds = { left: -bleed, top: -bleed, width: width + bleed * 2, height: height + bleed * 2 };
  state.mapSize = { width, height };

  if (!state.slices.length) {
    return;
  }

  const now = performance.now();
  drawMapGround(ctx, width, height, now);
  drawTraces(ctx, now);
  for (const slice of state.slices) {
    const p = pointToCanvas(slice);
    if (p.x < -12 || p.x > width + 12 || p.y < -12 || p.y > height + 12) continue;
    drawPoint(ctx, slice, false, now);
  }
  const hover = state.slices[state.hover];
  if (hover) drawPoint(ctx, hover, true, now);
  const playing = state.slices[state.playbackSliceIndex];
  if (playing && state.playbackSliceIndex !== state.hover) drawPoint(ctx, playing, true, now);
  const pinned = state.slices[state.pinned];
  if (pinned && state.pinned !== state.hover && state.pinned !== state.playbackSliceIndex) drawPoint(ctx, pinned, true, now, true);
}

function drawMapGround(ctx, width, height, now) {
  const count = Math.min(7, Math.max(3, Math.round(state.slices.length / 170)));
  ctx.save();
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.24;
  ctx.strokeStyle = themeColor("--line");
  for (let i = 0; i < count; i += 1) {
    const seed = (i + 1) * 37;
    const cx = width * (0.18 + ((seed * 17) % 61) / 100);
    const cy = height * (0.18 + ((seed * 29) % 58) / 100);
    const rx = width * (0.1 + ((seed * 7) % 19) / 100);
    const ry = height * (0.08 + ((seed * 11) % 18) / 100);
    const drift = Math.sin(now * 0.00011 + i) * 3;
    drawOrganicLoop(ctx, cx + drift, cy - drift * 0.6, rx, ry, i * 0.9);
  }

  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = themeColor("--glow");
  for (let i = 0; i < 4; i += 1) {
    const cx = width * (0.24 + i * 0.16);
    const cy = height * (0.34 + Math.sin(i * 1.7) * 0.18);
    drawOrganicLoop(ctx, cx, cy, width * 0.24, height * 0.12, i * 1.4);
  }
  ctx.restore();
}

function drawOrganicLoop(ctx, cx, cy, rx, ry, phase) {
  const steps = 96;
  ctx.beginPath();
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    const warp = 1 + Math.sin(t * 3 + phase) * 0.07 + Math.cos(t * 5 - phase) * 0.035;
    const x = cx + Math.cos(t) * rx * warp;
    const y = cy + Math.sin(t) * ry * (1 + Math.cos(t * 2 + phase) * 0.06);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawTraces(ctx, now) {
  const keep = [];
  for (const trace of state.traces) {
    const age = now - trace.startedAt;
    if (age > 1400) continue;
    const slice = state.slices[trace.index];
    if (!slice) continue;
    const p = pointToCanvas(slice);
    const progress = age / 1400;
    const radius = 10 + progress * 34;
    ctx.strokeStyle = themeColor("--glow");
    ctx.globalAlpha = (1 - progress) * 0.58;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    keep.push(trace);
  }
  ctx.globalAlpha = 1;
  state.traces = keep;
}

function drawPoint(ctx, slice, active, now = performance.now(), pinned = state.pinned === slice.id - 1) {
  const breath = clusterBreath(slice, now);
  const p = livingPoint(slice, pointToCanvas(slice), breath, active);
  const viewBoost = isIOS() ? Math.min(0.9, state.mapView.zoom * 0.1) : 0;
  let radius = ((isIOS() ? 2.15 : 1.9) + viewBoost + Math.min(1.3, slice.rms * 8)) * breath.radius;
  if (!active && state.hover >= 0) {
    const h = pointToCanvas(state.slices[state.hover]);
    const dist = Math.hypot(p.x - h.x, p.y - h.y);
    if (dist < 54) radius += (1 - dist / 54) * 0.7;
  }
  ctx.globalAlpha = active ? 1 : breath.opacity;
  ctx.fillStyle = slice.color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  if (active) {
    ctx.fillStyle = themeColor("--point-hover");
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius + 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = themeColor("--playhead");
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x - 13, p.y);
    ctx.lineTo(p.x - 7, p.y);
    ctx.moveTo(p.x + 7, p.y);
    ctx.lineTo(p.x + 13, p.y);
    ctx.moveTo(p.x, p.y - 13);
    ctx.lineTo(p.x, p.y - 7);
    ctx.moveTo(p.x, p.y + 7);
    ctx.lineTo(p.x, p.y + 13);
    ctx.stroke();
    if (pinned) {
      ctx.strokeStyle = themeColor("--text-soft");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - radius - 15);
      ctx.lineTo(p.x + radius + 9, p.y);
      ctx.lineTo(p.x, p.y + radius + 15);
      ctx.lineTo(p.x - radius - 9, p.y);
      ctx.closePath();
      ctx.stroke();
    }
  }
}

function clusterBreath(slice, now) {
  const clusterPhase =
    Math.floor(slice.x * 7) * 0.73 +
    Math.floor(slice.y * 6) * 0.91 +
    Math.log10(slice.centroid + 1) * 0.32 +
    Math.log10(slice.duration + 1.01) * 0.41;
  const localPhase = slice.id * 0.013;
  const shared = Math.sin(now * 0.00062 + clusterPhase);
  const local = Math.sin(now * 0.00047 + clusterPhase + localPhase);
  const active = state.playbackSliceIndex === slice.id - 1 || state.hover === slice.id - 1;
  const amount = active ? 1.45 : 1;
  return {
    offsetX: (shared * 0.24 + local * 0.06) * amount,
    offsetY: (Math.cos(now * 0.00053 + clusterPhase) * 0.24 + local * 0.05) * amount,
    opacity: clamp(0.92 + shared * 0.055, 0.82, 1),
    radius: 1 + shared * 0.055 * amount,
  };
}

function livingPoint(slice, point, breath, active) {
  const response = nearbyResponse(slice, point);
  const responseAmount = active ? 0.35 : 1;
  return {
    x: point.x + breath.offsetX + response.x * responseAmount,
    y: point.y + breath.offsetY + response.y * responseAmount,
  };
}

function nearbyResponse(slice, point) {
  if (state.hover < 0 || state.hover === slice.id - 1) return { x: 0, y: 0 };
  const active = state.slices[state.hover];
  if (!active) return { x: 0, y: 0 };
  const activePoint = pointToCanvas(active);
  const dx = point.x - activePoint.x;
  const dy = point.y - activePoint.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= 0.001 || dist > 62) return { x: 0, y: 0 };
  const amount = (1 - dist / 62) * 0.38;
  return {
    x: (dx / dist) * amount,
    y: (dy / dist) * amount,
  };
}

function pointToCanvas(slice) {
  const b = state.mapBounds;
  const rawX = b.left + slice.x * b.width;
  const rawY = b.top + slice.y * b.height;
  if (!isIOS()) {
    return { x: rawX, y: rawY };
  }
  const centerX = state.mapSize.width * 0.5;
  const centerY = state.mapSize.height * 0.5;
  const view = state.mapView;
  return {
    x: centerX + (rawX - centerX) * view.zoom + view.panX,
    y: centerY + (rawY - centerY) * view.zoom + view.panY,
  };
}

function canvasToLocal(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function nearestSlice(pos, radius = 13) {
  let best = -1;
  const touchRadius = isIOS() ? Math.max(radius, 26) : radius;
  let bestDist = touchRadius * touchRadius;
  for (let i = 0; i < state.slices.length; i += 1) {
    const p = pointToCanvas(state.slices[i]);
    const dist = (p.x - pos.x) ** 2 + (p.y - pos.y) ** 2;
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

function clampMapView() {
  const rect = els.mapCanvas.getBoundingClientRect();
  const view = state.mapView;
  view.zoom = clamp(view.zoom, 1, 10);
  const maxX = rect.width * (view.zoom - 1) * 0.72;
  const maxY = rect.height * (view.zoom - 1) * 0.72;
  view.panX = clamp(view.panX, -maxX, maxX);
  view.panY = clamp(view.panY, -maxY, maxY);
}

function resetMapView() {
  state.mapView.zoom = 1;
  state.mapView.panX = 0;
  state.mapView.panY = 0;
  safeDrawMap();
}

function showTouchedSlice(index) {
  const slice = state.slices[index];
  if (!slice) {
    restoreStatus();
    return;
  }
  setStatus(`#${slice.id} ${formatTime(slice.startSec)} ${formatTime(slice.duration)}`);
}

function restoreStatus() {
  if (state.pinned >= 0 && state.slices[state.pinned]) {
    const slice = state.slices[state.pinned];
    setStatus(`Pinned #${slice.id}`);
    return;
  }
  if (state.slices.length) {
    setStatus(`${state.slices.length} chops`);
  } else if (state.buffer) {
    setStatus("Ready");
  } else {
    setStatus("");
  }
}

function togglePinnedSlice(index, play = true) {
  if (index < 0 || !state.slices[index]) return;
  if (state.pinned === index) {
    state.pinned = -1;
    restoreStatus();
    safeDrawMap();
    return;
  }
  state.pinned = index;
  state.selected = index;
  if (play) maybePlaySlice(index, true);
  setStatus(`Pinned #${state.slices[index].id}`);
  safeDrawMap();
}

function clearPinnedSlice() {
  state.pinned = -1;
  restoreStatus();
  safeDrawMap();
}

function getGranularParams() {
  const macro = Number(els.macroAmount.value) / 100;
  const stretch = Number(els.stretchAmount.value) / 100;
  const scan = Number(els.scanAmount.value) / 100;
  const pitch = Number(els.pitchSpread.value) / 100;
  const tone = Number(els.toneAmount.value) / 100;
  const freeze = els.freezeMode.checked ? 1 : 0;
  const transform = clamp(macro * 0.78 + stretch * 0.28 + freeze * 0.26, 0, 1);
  const grainDuration = lerp(0.16, 2.8, Math.pow(transform, 0.72));
  const overlap = lerp(3.2, 13.5, clamp(macro * 0.58 + stretch * 0.5 + freeze * 0.34, 0, 1));
  const interval = clamp(grainDuration / overlap, 0.038, 0.34);
  const scanSpeed = lerp(0.22, 0.028, stretch) * lerp(0.35, 4.8, scan) * lerp(1, 1.75, macro) * (freeze ? 0.015 : 1);
  const scanRate = lerp(0.045, 0.42, scan) * lerp(0.9, 1.6, macro) * (freeze ? 0.1 : 1);
  const scanDepth = lerp(0.08, 0.96, scan) * lerp(0.85, 1.55, macro);
  const cloudWidth = lerp(0.018, 0.42, clamp(macro * 0.58 + pitch * 0.48 + freeze * 0.42, 0, 1));
  const filterHz = lerp(900, 7600, tone) * lerp(1, 0.5, macro) * (freeze ? 0.62 : 1);
  const grainGain = lerp(0.32, 0.13, clamp(overlap / 13.5, 0, 1));
  return {
    cloudWidth,
    filterHz: clamp(filterHz, 650, 8500),
    grainDuration,
    grainGain,
    interval,
    macro,
    pitchSpread: pitch,
    scanDepth,
    scanRate,
    scanSpeed,
    stretch,
    tone,
  };
}

function createOutputChain(ctx) {
  if (state.outputGain && state.outputFilter && state.outputCompressor) {
    return { input: state.outputGain };
  }
  const input = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const compressor = ctx.createDynamicsCompressor();
  input.gain.setValueAtTime(0.0001, ctx.currentTime);
  input.gain.exponentialRampToValueAtTime(1.05, ctx.currentTime + 0.035);
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(5200, ctx.currentTime);
  filter.Q.setValueAtTime(0.42, ctx.currentTime);
  compressor.threshold.setValueAtTime(-13, ctx.currentTime);
  compressor.knee.setValueAtTime(20, ctx.currentTime);
  compressor.ratio.setValueAtTime(3.8, ctx.currentTime);
  compressor.attack.setValueAtTime(0.012, ctx.currentTime);
  compressor.release.setValueAtTime(0.16, ctx.currentTime);
  input.connect(filter).connect(compressor).connect(ctx.destination);
  state.outputGain = input;
  state.outputFilter = filter;
  state.outputCompressor = compressor;
  connectOutputRecorder();
  return { input };
}

function updateOutputTone(ctx, params) {
  if (!state.outputFilter || !state.outputGain) return;
  const now = ctx.currentTime;
  state.outputFilter.frequency.cancelScheduledValues(now);
  state.outputFilter.frequency.setTargetAtTime(params.filterHz, now, 0.09);
  state.outputFilter.Q.setTargetAtTime(0.38 + params.tone * 0.28, now, 0.09);
  state.outputGain.gain.setTargetAtTime(1.08, now, 0.04);
}

function choosePitchRatio(voice, spread) {
  if (spread < 0.08) return 1;
  const sets = [
    [1],
    [1, 2 / 3, 1.5],
    [1, 2 / 3, 1.5, 0.5, 2],
    [1, 0.5, 2, 2 / 3, 1.5, 0.25, 3],
  ];
  const set = spread < 0.3 ? sets[1] : spread < 0.72 ? sets[2] : sets[3];
  const centerWeight = spread < 0.55 && voice % 2 === 0;
  if (centerWeight) return 1;
  return set[voice % set.length];
}

function lerp(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothValue(current, target, amount) {
  return current + (target - current) * amount;
}

async function playHtmlAudioSlice(slice) {
  const audio = state.audioElement;
  if (!audio) return false;
  try {
    if (state.audioStopTimer) {
      clearTimeout(state.audioStopTimer);
      state.audioStopTimer = 0;
    }
    audio.pause();
    audio.currentTime = slice.startSec;
    audio.volume = 0.95;
    audio.loop = false;
    const sliceEnd = slice.startSec + Math.max(0.01, slice.duration);
    audio.ontimeupdate = () => {
      if (!state.audioElement || state.playingId !== slice.id) return;
      if (audio.currentTime >= sliceEnd) {
        if (els.loopSlice.checked) {
          audio.currentTime = slice.startSec;
          audio.play().catch(() => setStatus("Tap again"));
        } else {
          audio.pause();
          audio.ontimeupdate = null;
          state.playingId = -1;
          state.playbackSliceIndex = -1;
          drawAll();
        }
      }
    };
    await audio.play();
    return true;
  } catch {
    setStatus("Tap again");
    return false;
  }
}

async function playSlice(index) {
  const slice = state.slices[index];
  if (!slice || !state.buffer) return;
  primeAudioNow();
  const ctx = getAudioContext();
  try {
    ctx.resume?.();
  } catch {
    // The next direct touch will retry.
  }
  stopPlayback();
  state.selected = index;
  addTrace(index);
  if (els.granularMode.checked) {
    if (ctx.state !== "running") await unlockAudio();
    if (ctx.state !== "running") {
      setStatus("Tap again");
      return;
    }
    startGranularSlice(index, ctx);
    return;
  }
  if (isIOS() && !isOutputRecording()) {
    const didPlay = await playHtmlAudioSlice(slice);
    if (didPlay) {
      state.playingId = slice.id;
      state.playbackSliceIndex = index;
      state.playbackStartedAt = state.audioContext?.currentTime || performance.now() / 1000;
      startPlaybackAnimation();
      drawAll();
      return;
    }
  }
  if (ctx.state !== "running") await unlockAudio();
  if (ctx.state !== "running") {
    setStatus("Tap again");
    return;
  }
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  const output = createOutputChain(ctx);
  gain.gain.value = 0.78;
  source.buffer = state.buffer;
  source.loop = els.loopSlice.checked;
  if (source.loop) {
    source.loopStart = slice.startSec;
    source.loopEnd = slice.startSec + Math.max(0.01, slice.duration);
  }
  source.connect(gain).connect(output.input);
  source.start(0, slice.startSec, source.loop ? undefined : Math.max(0.01, slice.duration));
  source.onended = () => {
    if (state.source === source) {
      state.source = null;
      state.playingId = -1;
      state.playbackSliceIndex = -1;
      if (state.animationFrame) {
        cancelAnimationFrame(state.animationFrame);
        state.animationFrame = 0;
      }
      drawAll();
    }
  };
  state.source = source;
  state.gain = gain;
  state.playingId = slice.id;
  state.playbackSliceIndex = index;
  state.playbackStartedAt = ctx.currentTime;
  startPlaybackAnimation();
  drawAll();
}

function addTrace(index) {
  if (index < 0) return;
  state.traces.push({ index, startedAt: performance.now() });
  if (state.traces.length > 18) state.traces.splice(0, state.traces.length - 18);
}

function startGranularSlice(index, ctx) {
  const slice = state.slices[index];
  const output = createOutputChain(ctx);
  const params = getGranularParams();
  const grainDuration = params.grainDuration;
  const playable = Math.max(0.01, slice.duration - grainDuration * 0.55);
  const startedAt = ctx.currentTime;
  const sliceKey = `${index}:${slice.start}:${slice.end}`;
  if (state.freezeOffset === null || state.playbackSliceIndex !== index || state.freezeKey !== sliceKey) {
    state.freezeOffset = playable * 0.45;
    state.freezeKey = sliceKey;
  }

  state.playingId = slice.id;
  state.playbackSliceIndex = index;
  state.playbackStartedAt = startedAt;

  const trigger = () => {
    if (!state.buffer || state.playbackSliceIndex !== index) return;
    const latest = getGranularParams();
    const now = ctx.currentTime;
    const elapsed = now - startedAt;
    const motion = Math.sin(elapsed * latest.scanRate * Math.PI * 2) * latest.scanDepth * playable;
    const drift = elapsed * latest.scanSpeed;
    const center = els.freezeMode.checked
      ? state.freezeOffset
      : (playable * 0.08 + drift + playable * 0.5 + motion) % playable;
    if (els.freezeMode.checked) {
      state.freezeOffset = smoothValue(state.freezeOffset, center, 0.025);
    }
    const voice = state.grainVoice++;
    const lane = ((voice % 7) - 3) / 3;
    const offset = clamp(center + lane * latest.cloudWidth * playable, 0, playable);
    const ratio = choosePitchRatio(voice, latest.pitchSpread);
    const duration = latest.grainDuration;
    const attack = Math.min(0.08, duration * 0.28);
    const release = Math.min(0.12, duration * 0.36);
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = state.buffer;
    source.playbackRate.setValueAtTime(ratio, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(latest.grainGain, now + attack);
    gain.gain.setTargetAtTime(0.0001, now + Math.max(attack, duration - release), release * 0.35);
    source.connect(gain).connect(output.input);
    source.start(now, slice.startSec + offset, duration);
    source.onended = () => state.grainSources.delete(source);
    state.grainSources.add(source);
    updateOutputTone(ctx, latest);
  };

  trigger();
  const schedule = () => {
    if (state.playbackSliceIndex !== index) return;
    trigger();
    state.grainInterval = window.setTimeout(schedule, getGranularParams().interval * 1000);
  };
  state.grainInterval = window.setTimeout(schedule, getGranularParams().interval * 1000);
  if (!els.loopSlice.checked) {
    const life = slice.duration * (1 + params.stretch * 7 + params.macro * 5);
    state.grainStopTimer = window.setTimeout(stopPlayback, Math.max(grainDuration * 1800, life * 1000));
  }
  startPlaybackAnimation();
  drawAll();
}

function stopPlayback() {
  const ctx = state.audioContext;
  const stopAt = ctx ? ctx.currentTime + 0.045 : 0;
  if (state.audioStopTimer) {
    clearTimeout(state.audioStopTimer);
    state.audioStopTimer = 0;
  }
  if (state.audioElement) {
    try {
      state.audioElement.pause();
      state.audioElement.ontimeupdate = null;
    } catch {
      // Audio element may not be ready yet.
    }
  }
  if (state.outputGain && ctx) {
    try {
      state.outputGain.gain.cancelScheduledValues(ctx.currentTime);
      state.outputGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.018);
    } catch {
      // Output may already be disconnected.
    }
  }
  const oldOutputGain = state.outputGain;
  const oldOutputFilter = state.outputFilter;
  const oldOutputCompressor = state.outputCompressor;
  state.outputGain = null;
  state.outputFilter = null;
  state.outputCompressor = null;
  if (state.source) {
    try {
      state.source.stop(stopAt);
    } catch {
      // Source may already be stopped.
    }
  }
  if (state.grainInterval) {
    clearTimeout(state.grainInterval);
    state.grainInterval = 0;
  }
  if (state.grainStopTimer) {
    clearTimeout(state.grainStopTimer);
    state.grainStopTimer = 0;
  }
  for (const source of state.grainSources) {
    try {
      source.stop(stopAt);
    } catch {
      // Grain may already be stopped.
    }
  }
  state.grainSources.clear();
  window.setTimeout(() => {
    try {
      oldOutputGain?.disconnect();
      oldOutputFilter?.disconnect();
      oldOutputCompressor?.disconnect();
    } catch {
      // Nodes may already be disconnected.
    }
  }, 80);
  state.source = null;
  state.gain = null;
  state.playingId = -1;
  state.playbackSliceIndex = -1;
  if (state.animationFrame) {
    cancelAnimationFrame(state.animationFrame);
    state.animationFrame = 0;
  }
  drawAll();
}

function startPlaybackAnimation() {
  if (state.animationFrame) return;
  const tick = () => {
    state.animationFrame = 0;
    const htmlAudioPlaying = state.audioElement && !state.audioElement.paused;
    if (!state.source && !state.grainInterval && !htmlAudioPlaying) return;
    drawWaveform();
    state.animationFrame = requestAnimationFrame(tick);
  };
  state.animationFrame = requestAnimationFrame(tick);
}

els.fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  setStatus("Loading");
  try {
    await unlockAudio();
    await loadFile(file);
  } catch (error) {
    console.error(error);
    setStatus("Error");
  }
});

for (const target of [els.fileInput, els.fileButton].filter(Boolean)) {
  target.addEventListener("pointerdown", primeAudioNow);
  target.addEventListener("touchstart", primeAudioNow, { passive: true });
  target.addEventListener("touchend", primeAudioNow, { passive: true });
  target.addEventListener("click", primeAudioNow);
}

els.recordButton.addEventListener("click", async () => {
  primeAudioNow();
  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    stopRecording();
    return;
  }
  await startRecording();
});

els.saveButton.addEventListener("click", () => {
  saveLastRecording();
});

els.analyzeButton.addEventListener("click", async () => {
  await unlockAudio();
  analyze();
});
els.stopButton.addEventListener("click", () => {
  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") stopRecording();
  clearPinnedSlice();
  stopPlayback();
});

for (const [input, output] of [
  [els.targetCount, els.targetCountValue],
  [els.macroAmount, els.macroAmountValue],
  [els.stretchAmount, els.stretchAmountValue],
  [els.scanAmount, els.scanAmountValue],
  [els.pitchSpread, els.pitchSpreadValue],
  [els.toneAmount, els.toneAmountValue],
]) {
  input.addEventListener("input", () => {
    output.textContent = input.value;
    updateInfo();
  });
}

els.granularMode.addEventListener("change", updateInfo);

async function handleMapPointer(event, force = false) {
  if (isIOS() && event.pointerType === "touch") return;
  event.preventDefault();
  primeAudioNow();
  await unlockAudio();
  const pos = canvasToLocal(els.mapCanvas, event);
  const index = nearestSlice(pos);
  if (force || index !== state.hover) {
    state.hover = index;
    safeDrawMap();
    if (index >= 0 && (force || state.pinned < 0)) maybePlaySlice(index, force);
    if (index < 0 && state.pinned < 0 && !els.loopSlice.checked) stopPlayback();
    showTouchedSlice(index);
  }
  return index;
}

function maybePlaySlice(index, force = false) {
  const now = performance.now();
  const gap = isIOS() ? 105 : 55;
  if (!force && index === state.lastTriggerIndex && now - state.lastTriggerAt < gap) return;
  if (!force && now - state.lastTriggerAt < gap) return;
  state.lastTriggerIndex = index;
  state.lastTriggerAt = now;
  playSlice(index);
}

els.mapCanvas.addEventListener("pointerdown", async (event) => {
  els.mapCanvas.setPointerCapture?.(event.pointerId);
  const index = await handleMapPointer(event, true);
  if (!isIOS() && event.pointerType !== "touch" && index >= 0) togglePinnedSlice(index, false);
});

els.mapCanvas.addEventListener("pointermove", (event) => {
  handleMapPointer(event);
});

els.mapCanvas.addEventListener("pointerleave", () => {
  state.hover = -1;
  if (state.pinned < 0 && !els.loopSlice.checked) {
    stopPlayback();
  }
  restoreStatus();
  safeDrawMap();
});

function touchPoint(touch) {
  const rect = els.mapCanvas.getBoundingClientRect();
  return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
}

function touchCenter(touches) {
  const a = touchPoint(touches[0]);
  const b = touchPoint(touches[1]);
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

function touchDistance(touches) {
  const a = touchPoint(touches[0]);
  const b = touchPoint(touches[1]);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clearLongPressTimer() {
  if (state.touchGesture.longPressTimer) {
    clearTimeout(state.touchGesture.longPressTimer);
    state.touchGesture.longPressTimer = 0;
  }
  state.touchGesture.longPressIndex = -1;
}

function scheduleLongPressPin(index) {
  clearLongPressTimer();
  if (index < 0) return;
  state.touchGesture.longPressIndex = index;
  state.touchGesture.longPressTimer = window.setTimeout(() => {
    const target = state.touchGesture.longPressIndex;
    clearLongPressTimer();
    if (target >= 0) togglePinnedSlice(target, true);
  }, 540);
}

function handleIOSMapTouch(event) {
  if (!isIOS()) return;
  primeAudioNow();
  const touches = event.touches;
  if (touches.length >= 2) {
    clearLongPressTimer();
    event.preventDefault();
    const center = touchCenter(touches);
    const distance = Math.max(1, touchDistance(touches));
    const gesture = state.touchGesture;
    if (!gesture.pinching || !gesture.lastCenter) {
      gesture.pinching = true;
      gesture.lastCenter = center;
      gesture.lastDistance = distance;
      return;
    }
    const rect = els.mapCanvas.getBoundingClientRect();
    const view = state.mapView;
    const oldZoom = view.zoom;
    const pinchRatio = distance / Math.max(1, gesture.lastDistance);
    const zoomFactor = Math.pow(pinchRatio, 1.75);
    const nextZoom = clamp(oldZoom * zoomFactor, 1, 10);
    const anchorX = center.x - rect.width * 0.5 - view.panX;
    const anchorY = center.y - rect.height * 0.5 - view.panY;
    view.panX += center.x - gesture.lastCenter.x - anchorX * (nextZoom / oldZoom - 1);
    view.panY += center.y - gesture.lastCenter.y - anchorY * (nextZoom / oldZoom - 1);
    view.zoom = nextZoom;
    gesture.lastCenter = center;
    gesture.lastDistance = distance;
    clampMapView();
    safeDrawMap();
    return;
  }

  if (touches.length === 1) {
    const gesture = state.touchGesture;
    gesture.pinching = false;
    gesture.lastCenter = null;
    gesture.lastDistance = 0;
    const now = performance.now();
    if (event.type === "touchstart" && now - gesture.lastTapAt < 280) {
      event.preventDefault();
      gesture.lastTapAt = 0;
      clearLongPressTimer();
      resetMapView();
      return;
    }
    if (event.type === "touchstart") gesture.lastTapAt = now;
    const pos = touchPoint(touches[0]);
    const index = nearestSlice(pos, 24);
    if (index < 0) {
      clearLongPressTimer();
      return;
    }
    event.preventDefault();
    if (event.type === "touchstart") scheduleLongPressPin(index);
    if (event.type === "touchmove" && index !== gesture.longPressIndex) clearLongPressTimer();
    if (index !== state.hover || event.type === "touchstart") {
      state.hover = index;
      safeDrawMap();
      if (state.pinned < 0 || index === state.pinned) maybePlaySlice(index, event.type === "touchstart");
      showTouchedSlice(index);
    }
  }
}

els.mapCanvas.addEventListener("touchstart", handleIOSMapTouch, { passive: false });
els.mapCanvas.addEventListener("touchmove", handleIOSMapTouch, { passive: false });
els.mapCanvas.addEventListener("touchend", (event) => {
  if (!isIOS()) return;
  clearLongPressTimer();
  if (event.touches.length < 2) {
    state.touchGesture.pinching = false;
    state.touchGesture.lastCenter = null;
    state.touchGesture.lastDistance = 0;
  }
}, { passive: false });
els.mapCanvas.addEventListener("touchcancel", (event) => {
  if (!isIOS()) return;
  clearLongPressTimer();
  state.touchGesture.pinching = false;
  state.touchGesture.lastCenter = null;
  state.touchGesture.lastDistance = 0;
}, { passive: false });

window.addEventListener("touchstart", unlockAudio, { passive: true });
window.addEventListener("touchend", unlockAudio, { passive: true });
window.addEventListener("pointerdown", unlockAudio);
window.addEventListener("touchstart", primeAudioNow, { passive: true });
window.addEventListener("touchend", primeAudioNow, { passive: true });
window.addEventListener("pointerdown", primeAudioNow);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    unlockAudio();
  }
});

window.addEventListener("resize", drawAll);
updateInfo();
drawAll();
