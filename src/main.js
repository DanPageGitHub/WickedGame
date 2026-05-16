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
  startButton: document.querySelector("#start-button"),
  startupOverlay: document.querySelector("#startup-overlay"),
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
let isStarting = false;
let mediaReadyPromise = null;
let startRequested = false;

const setStatus = (message, type = "info") => {
  elements.status.textContent = message;
  elements.status.dataset.type = type;
};

const hideStartupOverlay = () => {
  elements.app.classList.add("startup-dismissed");

  if (!elements.startupOverlay) {
    return;
  }

  elements.startupOverlay.dataset.state = "hidden";
  elements.startupOverlay.hidden = true;
  elements.startupOverlay.setAttribute("aria-hidden", "true");
  elements.startupOverlay.remove();
  elements.startupOverlay = null;
};

const setStartupOverlayState = (state, title, subtitle) => {
  if (!elements.startupOverlay) {
    return;
  }

  elements.app.classList.remove("startup-dismissed");
  elements.startupOverlay.dataset.state = state;
  elements.startupOverlay.hidden = false;
  elements.startupOverlay.setAttribute("aria-hidden", "false");
  document.querySelector("#startup-overlay-text").textContent = title;
  document.querySelector("#startup-overlay-subtext").textContent = subtitle;
};

const startPlayback = async () => {
  if (isRunning) {
    setStatus("Running. Hold keys to perform.");
    return true;
  }

  if (isStarting) {
    return false;
  }

  isStarting = true;
  startRequested = true;

  try {
    setStartupOverlayState("loading", "Warming up...", "One mo.");
    setStatus("Loading media...");
    await mediaReadyPromise;

    setStatus("Starting playback...");
    await Promise.all([audioEngine.start(), videoEngine.start()]);

    isRunning = true;
    isPaused = false;
    elements.startButton.textContent = "Pause";
    hideStartupOverlay();
    setStatus("Running. Hold keys to perform.");
    return true;
  } catch (error) {
    console.error(error);
    setStatus("Click or press Space to start.", "error");
    startRequested = false;
    setStartupOverlayState("ready", "Click to wake it up", "Press Space if you prefer.");
    return false;
  } finally {
    isStarting = false;
  }
};

const controls = createControls({
  config: APP_CONFIG,
  events,
  elements,
  onStart: startPlayback,
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
    elements.startButton.textContent = "Pause";
    setStatus("Running. Hold keys to perform.");
    return;
  }

  await Promise.all([audioEngine.suspend(), videoEngine.pause()]);
  isPaused = true;
  elements.startButton.textContent = "Play";
  setStatus("Paused.");
});

const boot = async () => {
  setStartupOverlayState("loading", "Warming up...", "One mo.");
  setStatus("Loading media...");
  mediaReadyPromise = Promise.all([audioEngine.load(setStatus), videoEngine.load(setStatus)]);
  await mediaReadyPromise;

  if (isRunning || isStarting || startRequested) {
    return;
  }

  elements.startButton.textContent = "Play";
  setStartupOverlayState("ready", "Click to wake it up", "Press Space if you prefer.");
  setStatus("Click or press Space to start.");
};

elements.startupOverlay.addEventListener("click", startPlayback);
boot();
