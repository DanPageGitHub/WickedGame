import { APP_CONFIG } from "./config.js";
import { createControls } from "./controls.js";
import { AudioEngine } from "./audioEngine.js";
import { createEventBus } from "./events.js";
import { FactsOverlay } from "./factsOverlay.js";
import "./style.css";
import { VideoEngine } from "./videoEngine.js";

const elements = {
  app: document.querySelector("#app"),
  video: document.querySelector("#main-video"),
  freezeFrame: document.querySelector("#freeze-frame"),
  factsOverlay: document.querySelector("#facts-overlay"),
  factsOverlayText: document.querySelector("#facts-overlay-text"),
  status: document.querySelector("#status"),
  tempoSlider: document.querySelector("#tempo-slider"),
  tempoValue: document.querySelector("#tempo-value"),
  keyHelp: document.querySelector("#key-help"),
  controlsHint: document.querySelector("#controls-hint")
};

const events = createEventBus();
const audioEngine = new AudioEngine(APP_CONFIG, events);
const videoEngine = new VideoEngine(APP_CONFIG, events, {
  app: elements.app,
  video: elements.video,
  freezeFrame: elements.freezeFrame
});
const factsOverlay = new FactsOverlay(APP_CONFIG, events, {
  video: elements.video,
  overlay: elements.factsOverlay,
  text: elements.factsOverlayText
});
let isRunning = false;
let isPaused = false;
let autoplayUnlockBound = false;

const setStatus = (message, type = "info") => {
  elements.status.textContent = message;
  elements.status.dataset.type = type;
};

const startPlayback = async () => {
  if (isRunning) {
    setStatus("Running. Hold keys to perform.");
    return true;
  }

  try {
    setStatus("Loading media...");
    await Promise.all([audioEngine.load(setStatus), videoEngine.load(setStatus)]);

    setStatus("Starting playback...");
    await Promise.all([audioEngine.start(), videoEngine.start()]);

    isRunning = true;
    isPaused = false;
    autoplayUnlockBound = false;
    setStatus("Running. Hold keys to perform.");
    return true;
  } catch (error) {
    console.error(error);
    setStatus("Tap or press Space for audio.", "error");
    return false;
  }
};

const controls = createControls({
  config: APP_CONFIG,
  events,
  elements,
  onTempoChange: (bpm) => {
    audioEngine.setTempo(bpm);
  }
});
factsOverlay.load();

events.on("tempo-change", ({ bpm }) => {
  elements.tempoSlider.value = String(Math.round(bpm));
  elements.tempoValue.textContent = `${Math.round(bpm)} BPM`;
});

events.on("transport-toggle", async () => {
  if (!isRunning) {
    await startPlayback();
    return;
  }

  if (isPaused) {
    await Promise.all([audioEngine.resume(), videoEngine.resume()]);
    isPaused = false;
    setStatus("Running. Hold keys to perform.");
    return;
  }

  await Promise.all([audioEngine.suspend(), videoEngine.pause()]);
  isPaused = true;
  setStatus("Paused.");
});

const bindAutoplayUnlock = () => {
  if (autoplayUnlockBound || isRunning) {
    return;
  }

  autoplayUnlockBound = true;
  const unlock = async () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
    autoplayUnlockBound = false;
    await startPlayback();
  };

  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
};

const boot = async () => {
  setStatus("Loading media...");
  await Promise.all([audioEngine.load(setStatus), videoEngine.load(setStatus)]);

  try {
    await videoEngine.start();
    setStatus("Video running. Tap or press Space for audio.");
  } catch (error) {
    console.warn(error);
    setStatus("Tap or press Space for playback.");
  }

  bindAutoplayUnlock();
};

boot();
