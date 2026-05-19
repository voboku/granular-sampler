"use strict";

const state = {
  audioContext: null,
  buffer: null,
  mono: null,
  fileName: "",
  slices: [],
  hover: -1,
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
  playingId: -1,
  playbackStartedAt: 0,
  playbackSliceIndex: -1,
  animationFrame: 0,
  mapBounds: { left: 0, top: 0, width: 1, height: 1 },
};

const $ = (id) => document.getElementById(id);

const els = {
  fileInput: $("fileInput"),
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

function getAudioContext() {
  if (!state.audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioContextClass();
  }
  return state.audioContext;
}

async function unlockAudio() {
  const ctx = getAudioContext();
  if (ctx.state === "suspended") {
    await ctx.resume();
  }
}

function setStatus(text) {
  els.statusText.textContent = text;
}

function updateInfo() {
  const total = Number(els.targetCount.value);
  els.infoChops.textContent = `${state.slices.length} / ${total}`;
  els.infoDuration.textContent = state.buffer ? formatTime(state.buffer.duration) : "--";
  els.infoMode.textContent = els.granularMode.checked ? "Granular" : "Normal";
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
  const buffer = await ctx.decodeAudioData(data);
  state.buffer = buffer;
  state.mono = mixToMono(buffer);
  state.fileName = file.name;
  state.slices = [];
  state.hover = -1;
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

  embedSlices(slices);
  state.slices = slices;
  state.selected = slices.length ? 0 : -1;
  els.chopStat.textContent = String(slices.length);
  els.analyzeButton.disabled = false;
  setStatus(`${slices.length} chops`);
  updateInfo();
  drawAll();
}

function frame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function colorFor(slice) {
  return slice.rms < 0.018 ? themeColor("--line") : themeColor("--point");
}

function drawAll() {
  drawWaveform();
  drawMap();
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

  if (!state.slices.length) {
    return;
  }

  for (const slice of state.slices) {
    drawPoint(ctx, slice, false);
  }
  const hover = state.slices[state.hover];
  if (hover) drawPoint(ctx, hover, true);
  const playing = state.slices[state.playbackSliceIndex];
  if (playing && state.playbackSliceIndex !== state.hover) drawPoint(ctx, playing, true);
}

function drawPoint(ctx, slice, active) {
  const p = pointToCanvas(slice);
  const radius = 1.8 + Math.min(1.5, slice.rms * 10);
  ctx.fillStyle = slice.color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.fill();
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
  }
}

function pointToCanvas(slice) {
  const b = state.mapBounds;
  return {
    x: b.left + slice.x * b.width,
    y: b.top + slice.y * b.height,
  };
}

function canvasToLocal(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function nearestSlice(pos, radius = 13) {
  let best = -1;
  let bestDist = radius * radius;
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

function showTouchedSlice(index) {
  const slice = state.slices[index];
  if (!slice) {
    restoreStatus();
    return;
  }
  setStatus(`#${slice.id} ${formatTime(slice.startSec)} ${formatTime(slice.duration)}`);
}

function restoreStatus() {
  if (state.slices.length) {
    setStatus(`${state.slices.length} chops`);
  } else if (state.buffer) {
    setStatus("Ready");
  } else {
    setStatus("");
  }
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
  const grainGain = lerp(0.2, 0.072, clamp(overlap / 13.5, 0, 1));
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
  input.gain.exponentialRampToValueAtTime(0.78, ctx.currentTime + 0.035);
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(5200, ctx.currentTime);
  filter.Q.setValueAtTime(0.42, ctx.currentTime);
  compressor.threshold.setValueAtTime(-18, ctx.currentTime);
  compressor.knee.setValueAtTime(18, ctx.currentTime);
  compressor.ratio.setValueAtTime(3, ctx.currentTime);
  compressor.attack.setValueAtTime(0.012, ctx.currentTime);
  compressor.release.setValueAtTime(0.16, ctx.currentTime);
  input.connect(filter).connect(compressor).connect(ctx.destination);
  state.outputGain = input;
  state.outputFilter = filter;
  state.outputCompressor = compressor;
  return { input };
}

function updateOutputTone(ctx, params) {
  if (!state.outputFilter || !state.outputGain) return;
  const now = ctx.currentTime;
  state.outputFilter.frequency.cancelScheduledValues(now);
  state.outputFilter.frequency.setTargetAtTime(params.filterHz, now, 0.09);
  state.outputFilter.Q.setTargetAtTime(0.38 + params.tone * 0.28, now, 0.09);
  state.outputGain.gain.setTargetAtTime(0.76, now, 0.04);
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

async function playSlice(index) {
  const slice = state.slices[index];
  if (!slice || !state.buffer) return;
  const ctx = getAudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  stopPlayback();
  state.selected = index;
  if (els.granularMode.checked) {
    startGranularSlice(index, ctx);
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
    if (!state.source && !state.grainInterval) return;
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

els.analyzeButton.addEventListener("click", async () => {
  await unlockAudio();
  analyze();
});
els.stopButton.addEventListener("click", stopPlayback);

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
  event.preventDefault();
  await unlockAudio();
  const pos = canvasToLocal(els.mapCanvas, event);
  const index = nearestSlice(pos);
  if (force || index !== state.hover) {
    state.hover = index;
    drawMap();
    if (index >= 0) playSlice(index);
    if (index < 0 && !els.loopSlice.checked) stopPlayback();
    showTouchedSlice(index);
  }
}

els.mapCanvas.addEventListener("pointerdown", (event) => {
  els.mapCanvas.setPointerCapture?.(event.pointerId);
  handleMapPointer(event, true);
});

els.mapCanvas.addEventListener("pointermove", (event) => {
  handleMapPointer(event);
});

els.mapCanvas.addEventListener("pointerleave", () => {
  state.hover = -1;
  if (!els.loopSlice.checked) {
    stopPlayback();
  }
  restoreStatus();
  drawMap();
});

window.addEventListener("touchstart", unlockAudio, { passive: true });
window.addEventListener("pointerdown", unlockAudio);

window.addEventListener("resize", drawAll);
updateInfo();
drawAll();
