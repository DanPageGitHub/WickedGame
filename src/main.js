import { APP_CONFIG } from "./config.js";
import { createControls } from "./controls.js";
import { AudioEngine } from "./audioEngine.js";
import { createEventBus } from "./events.js";
import "./style.css";
import { VideoEngine } from "./videoEngine.js";

const elements = {
  app: document.querySelector("#app"),
  video: document.querySelector("#main-video"),
  freezeFrame: document.querySelector("#freeze-frame"),
  startButton: document.querySelector("#start-button"),
  status: document.querySelector("#status"),
  tempoSlider: document.querySelector("#tempo-slider"),
  tempoValue: document.querySelector("#tempo-value"),
  keyHelp: document.querySelector("#key-help"),
  otherButton: document.querySelector("#other-button"),
  otherLabel: document.querySelector("#other-label"),
  controlsHint: document.querySelector("#controls-hint")
};

const events = createEventBus();
const audioEngine = new AudioEngine(APP_CONFIG, events);
const videoEngine = new VideoEngine(APP_CONFIG, events, {
  app: elements.app,
  video: elements.video,
  freezeFrame: elements.freezeFrame
});
let isRunning = false;
let isPaused = false;
let amplitudeFrameId = null;

const setStatus = (message, type = "info") => {
  elements.status.textContent = message;
  elements.status.dataset.type = type;
};

const startAmplitudeLoop = () => {
  const tick = () => {
    if (isRunning && !isPaused) {
      events.emit("amplitude-change", {
        level: audioEngine.getVisualLevel()
      });
    } else {
      events.emit("amplitude-change", {
        level: 0
      });
    }

    amplitudeFrameId = window.requestAnimationFrame(tick);
  };

  if (amplitudeFrameId === null) {
    amplitudeFrameId = window.requestAnimationFrame(tick);
  }
};

const controls = createControls({
  config: APP_CONFIG,
  events,
  elements,
  onTempoChange: (bpm) => {
    audioEngine.setTempo(bpm);
  },
  onStart: async () => {
    if (isRunning) {
      setStatus("Running. Hold keys to perform.");
      return true;
    }

    try {
      setStatus("Unlocking audio context...");
      await Promise.all([audioEngine.load(setStatus), videoEngine.load(setStatus)]);

      setStatus("Starting playback...");
      await Promise.all([audioEngine.start(), videoEngine.start()]);

      isRunning = true;
      isPaused = false;
      startAmplitudeLoop();
      setStatus("Running. Hold keys to perform.");
      elements.startButton.textContent = "Running";
      return true;
    } catch (error) {
      console.error(error);
      setStatus(error.message, "error");
      return false;
    }
  }
});

controls.setOtherVariantState(audioEngine.getOtherVariantState());

events.on("other-variant-change", (state) => {
  controls.setOtherVariantState(state);
});

events.on("tempo-change", ({ bpm }) => {
  elements.tempoSlider.value = String(Math.round(bpm));
  elements.tempoValue.textContent = `${Math.round(bpm)} BPM`;
});

events.on("transport-toggle", async () => {
  if (!isRunning) {
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

setStatus("Ready. Add media files and press Start.");
