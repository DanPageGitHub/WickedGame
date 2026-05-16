export class VideoEngine {
  constructor(config, events, elements) {
    this.config = config;
    this.events = events;
    this.video = elements.video;
    this.freezeFrame = elements.freezeFrame;
    this.app = elements.app;

    this.loaded = false;
    this.eventsBound = false;
    this.classTimeouts = new Map();
    this.currentBpm = config.startBpm;
    this.barCount = 0;
    this.barPaletteIndex = -1;
    this.barPalettes = [
      ["#f26a4b", "#f4b860", "#f2df74"],
      ["#6d9df7", "#71d7c7", "#b9ef95"],
      ["#c35cff", "#ff7bac", "#ffd166"],
      ["#00b4d8", "#48cae4", "#90e0ef"],
      ["#ef476f", "#f78c6b", "#ffd166"],
      ["#7f5af0", "#2cb67d", "#ffd803"]
    ];
    this.freezeBuffer = [];
    this.freezeBufferSize = 6;
    this.freezeCaptureIntervalId = null;
    this.freezePlaybackIntervalId = null;
    this.freezeAutoStopTimeoutId = null;
    this.glitchShuffleIntervalId = null;
    this.freezePlaybackIndex = 0;
    this.freezeMode = null;
    this.motionPhase = 0;

    this.canvas = document.createElement("canvas");
    this.context = this.canvas.getContext("2d", { willReadFrequently: false });
  }

  async load(setStatus = () => {}) {
    if (this.loaded) {
      return;
    }

    setStatus("Loading video metadata...");
    this.video.muted = true;
    this.video.defaultMuted = true;
    this.video.volume = 0;

    await new Promise((resolve, reject) => {
      const handleLoaded = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error("Video failed to load. Check /public/media/video/main.mp4."));
      };
      const cleanup = () => {
        this.video.removeEventListener("loadedmetadata", handleLoaded);
        this.video.removeEventListener("error", handleError);
      };

      this.video.addEventListener("loadedmetadata", handleLoaded, { once: true });
      this.video.addEventListener("error", handleError, { once: true });
      this.video.src = this.config.media.videoPath;
      this.video.load();
    });

    document.documentElement.style.setProperty("--video-aspect", `${this.video.videoWidth / this.video.videoHeight}`);
    this.video.currentTime = 0;
    this.video.playbackRate = this.config.startBpm / this.config.baseBpm;
    this.#bindEventBus();
    this.loaded = true;
  }

  async start() {
    if (!this.loaded) {
      throw new Error("VideoEngine.start() called before load().");
    }

    this.video.muted = true;
    this.video.defaultMuted = true;
    this.video.volume = 0;
    this.video.currentTime = 0;
    await this.video.play();
  }

  setPlaybackRate(rate) {
    this.video.playbackRate = rate;
    document.documentElement.style.setProperty("--video-rate", `${rate}`);
    document.documentElement.style.setProperty("--beat-ms", `${Math.max((60 / (rate * this.config.baseBpm)) * 1000, 80)}ms`);
  }

  async pause() {
    this.video.pause();
  }

  async resume() {
    await this.video.play();
  }

  #bindEventBus() {
    if (this.eventsBound) {
      return;
    }

    this.events.on("tempo-change", ({ playbackRate }) => {
      this.currentBpm = playbackRate * this.config.baseBpm;
      this.setPlaybackRate(playbackRate);
    });

    this.events.on("amplitude-change", ({ level }) => {
      const amp = Math.max(0, Math.min(level, 1));
      const boosted = Math.pow(amp, 0.42);

      this.motionPhase += 0.12 + boosted * 0.22;

      const motionScale = 1 + boosted * 0.2;
      const motionRotate = Math.sin(this.motionPhase * 0.72) * boosted * 1.8;
      const motionBrightness = 1 + boosted * 0.16;
      const motionContrast = 1 + boosted * 0.34;
      const motionX = Math.sin(this.motionPhase * 1.18) * boosted * 34;
      const motionY = Math.cos(this.motionPhase * 1.63) * boosted * 20;
      const motionBlur = boosted * 0.65;
      const motionFlash = 0.08 + boosted * 0.22;

      document.documentElement.style.setProperty("--amp-scale", `${motionScale}`);
      document.documentElement.style.setProperty("--amp-rotate", `${motionRotate}deg`);
      document.documentElement.style.setProperty("--amp-brightness", `${motionBrightness}`);
      document.documentElement.style.setProperty("--amp-contrast", `${motionContrast}`);
      document.documentElement.style.setProperty("--amp-x", `${motionX}px`);
      document.documentElement.style.setProperty("--amp-y", `${motionY}px`);
      document.documentElement.style.setProperty("--amp-blur", `${motionBlur}px`);
      document.documentElement.style.setProperty("--amp-flash", `${motionFlash}`);
    });

    this.events.on("bar-cycle", () => {
      this.barCount += 1;
      this.#advanceBarColor();
      this.#randomizeGlitchProfile("bar");
      this.#flashClass("is-bar-cycle", this.#getBarDurationMs());
      this.#flashClass("is-bar-glitch", this.#getHalfBarDurationMs());

      if (this.barCount % 4 === 0 && !this.app.classList.contains("effect-video-freeze")) {
        this.#triggerAutoFreezeAccent();
      }
    });

    this.events.on("break-change", () => {
      this.#flashClass("is-break-pulse", 180);
    });

    this.events.on("beat-repeat-hit", () => {
      this.#flashClass("is-repeat-hit", 90);
    });

    this.events.on("other-variant-change", () => {
      this.#flashClass("is-other-shift", 220);
    });

    this.events.on("effect-hold", ({ effectId, active }) => {
      this.#setEffectClass(effectId, active);

      if (effectId === "video-freeze") {
        if (active) {
          this.#startFreezeSmear({
            mode: "manual",
            bufferSize: 6,
            captureDivisor: 4,
            playbackDivisor: 6
          });
        } else {
          this.#stopFreezeSmear();
        }
      }
    });

    this.events.on("clear-held-effects", () => {
      ["filter", "destroy", "vocal-throw", "video-freeze", "intensity", "repeat-8n", "repeat-16n", "repeat-32n"].forEach(
        (effectId) => {
          this.#setEffectClass(effectId, false);
        }
      );
      this.#stopFreezeSmear();
    });

    this.eventsBound = true;
  }

  #setEffectClass(effectId, active) {
    this.app.classList.toggle(`effect-${effectId}`, active);
  }

  #flashClass(className, duration) {
    window.clearTimeout(this.classTimeouts.get(className));
    this.app.classList.add(className);

    const timeoutId = window.setTimeout(() => {
      this.app.classList.remove(className);
    }, duration);

    this.classTimeouts.set(className, timeoutId);
  }

  #captureFreezeFrame() {
    if (!this.context || this.video.readyState < 2) {
      return null;
    }

    this.canvas.width = this.video.videoWidth;
    this.canvas.height = this.video.videoHeight;
    this.context.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    return this.canvas.toDataURL("image/png");
  }

  #startFreezeSmear({ mode, bufferSize, captureDivisor, playbackDivisor }) {
    this.#stopFreezeSmear();
    this.freezeMode = mode;
    this.freezeBufferSize = bufferSize;
    this.#randomizeGlitchProfile(mode === "manual" ? "freeze" : "auto");

    const firstFrame = this.#captureFreezeFrame();
    if (firstFrame) {
      this.freezeBuffer = [firstFrame];
      this.freezeFrame.src = firstFrame;
    }

    const beatMs = Math.max((60 / Math.max(this.currentBpm, 1)) * 1000, 80);
    const captureMs = Math.max(Math.round(beatMs / captureDivisor), 45);
    const playbackMs = Math.max(Math.round(beatMs / playbackDivisor), 35);

    this.freezeCaptureIntervalId = window.setInterval(() => {
      const frame = this.#captureFreezeFrame();
      if (!frame) {
        return;
      }

      this.freezeBuffer.push(frame);
      if (this.freezeBuffer.length > this.freezeBufferSize) {
        this.freezeBuffer.shift();
      }
    }, captureMs);

    this.freezePlaybackIntervalId = window.setInterval(() => {
      if (this.freezeBuffer.length === 0) {
        return;
      }

      this.freezePlaybackIndex = (this.freezePlaybackIndex + 1) % this.freezeBuffer.length;
      this.freezeFrame.src = this.freezeBuffer[this.freezePlaybackIndex];
    }, playbackMs);

    const shuffleMs = Math.max(Math.round(beatMs * (mode === "manual" ? 0.72 : 0.95)), 90);
    this.glitchShuffleIntervalId = window.setInterval(() => {
      this.#randomizeGlitchProfile(mode === "manual" ? "freeze" : "auto");
    }, shuffleMs);
  }

  #stopFreezeSmear() {
    if (this.freezeAutoStopTimeoutId !== null) {
      window.clearTimeout(this.freezeAutoStopTimeoutId);
      this.freezeAutoStopTimeoutId = null;
    }

    if (this.glitchShuffleIntervalId !== null) {
      window.clearInterval(this.glitchShuffleIntervalId);
      this.glitchShuffleIntervalId = null;
    }

    if (this.freezeCaptureIntervalId !== null) {
      window.clearInterval(this.freezeCaptureIntervalId);
      this.freezeCaptureIntervalId = null;
    }

    if (this.freezePlaybackIntervalId !== null) {
      window.clearInterval(this.freezePlaybackIntervalId);
      this.freezePlaybackIntervalId = null;
    }

    this.freezePlaybackIndex = 0;
    this.freezeBuffer = [];
    this.freezeMode = null;
    this.app.classList.remove("is-auto-freeze");
    this.freezeFrame.removeAttribute("src");
    this.#randomizeGlitchProfile("idle");
  }

  #triggerAutoFreezeAccent() {
    const duration = Math.max(Math.round(this.#getHalfBarDurationMs() * 0.92), 140);
    this.app.classList.add("is-auto-freeze");
    this.#startFreezeSmear({
      mode: "auto",
      bufferSize: 4,
      captureDivisor: 3,
      playbackDivisor: 4.5
    });

    this.freezeAutoStopTimeoutId = window.setTimeout(() => {
      if (this.freezeMode === "auto" && !this.app.classList.contains("effect-video-freeze")) {
        this.#stopFreezeSmear();
      }
    }, duration);
  }

  #advanceBarColor() {
    this.barPaletteIndex = (this.barPaletteIndex + 1) % this.barPalettes.length;
    const [colorA, colorB, colorC] = this.barPalettes[this.barPaletteIndex];
    document.documentElement.style.setProperty("--bar-color-a", colorA);
    document.documentElement.style.setProperty("--bar-color-b", colorB);
    document.documentElement.style.setProperty("--bar-color-c", colorC);
  }

  #getBarDurationMs() {
    const bpm = Math.max(this.currentBpm, 1);
    return Math.max(Math.round((240 / bpm) * 1000 * 0.98), 120);
  }

  #getHalfBarDurationMs() {
    return Math.max(Math.round(this.#getBarDurationMs() * 0.55), 120);
  }

  #randomizeGlitchProfile(mode) {
    const profileSets = {
      idle: [
        { x1: -8, y1: 3, x2: 6, y2: -5, x3: -4, y3: -2, x4: 10, y4: 4, s1: 1.01, s2: 1.018, s3: 1.012, s4: 1.016, r1: -0.25, r2: 0.22 },
        { x1: -6, y1: 2, x2: 5, y2: -4, x3: -3, y3: -1, x4: 8, y4: 3, s1: 1.008, s2: 1.014, s3: 1.01, s4: 1.014, r1: -0.18, r2: 0.18 }
      ],
      bar: [
        { x1: -24, y1: 9, x2: 18, y2: -14, x3: -11, y3: -4, x4: 26, y4: 10, s1: 1.016, s2: 1.042, s3: 1.022, s4: 1.034, r1: -0.7, r2: 0.55 },
        { x1: 20, y1: -6, x2: -28, y2: 12, x3: 14, y3: -12, x4: -18, y4: 7, s1: 1.012, s2: 1.038, s3: 1.028, s4: 1.02, r1: 0.62, r2: -0.48 },
        { x1: -32, y1: 4, x2: 12, y2: -18, x3: -15, y3: 6, x4: 22, y4: 13, s1: 1.02, s2: 1.048, s3: 1.03, s4: 1.036, r1: -0.82, r2: 0.4 },
        { x1: 10, y1: 14, x2: -20, y2: -8, x3: 18, y3: -14, x4: -30, y4: 5, s1: 1.014, s2: 1.04, s3: 1.026, s4: 1.032, r1: 0.45, r2: -0.7 }
      ],
      auto: [
        { x1: -18, y1: 5, x2: 12, y2: -10, x3: -8, y3: 3, x4: 16, y4: 7, s1: 1.012, s2: 1.028, s3: 1.018, s4: 1.022, r1: -0.38, r2: 0.3 },
        { x1: 14, y1: -4, x2: -16, y2: 8, x3: 10, y3: -7, x4: -14, y4: 6, s1: 1.01, s2: 1.026, s3: 1.02, s4: 1.018, r1: 0.34, r2: -0.28 },
        { x1: -10, y1: 9, x2: 18, y2: -6, x3: -6, y3: -5, x4: 12, y4: 10, s1: 1.014, s2: 1.024, s3: 1.018, s4: 1.02, r1: -0.24, r2: 0.36 }
      ],
      freeze: [
        { x1: -36, y1: 10, x2: 28, y2: -20, x3: -18, y3: -7, x4: 34, y4: 14, s1: 1.024, s2: 1.056, s3: 1.034, s4: 1.046, r1: -1.1, r2: 0.84 },
        { x1: 30, y1: -12, x2: -34, y2: 16, x3: 22, y3: -15, x4: -26, y4: 11, s1: 1.02, s2: 1.05, s3: 1.038, s4: 1.03, r1: 0.92, r2: -0.78 },
        { x1: -22, y1: 18, x2: 16, y2: -24, x3: -20, y3: 10, x4: 30, y4: -6, s1: 1.026, s2: 1.06, s3: 1.04, s4: 1.042, r1: -0.68, r2: 1.02 },
        { x1: 12, y1: -20, x2: -30, y2: 10, x3: 26, y3: -18, x4: -20, y4: 15, s1: 1.018, s2: 1.052, s3: 1.036, s4: 1.028, r1: 1.08, r2: -0.62 }
      ]
    };

    const profiles = profileSets[mode] ?? profileSets.idle;
    const profile = profiles[Math.floor(Math.random() * profiles.length)];
    const root = document.documentElement.style;

    root.setProperty("--glitch-x1", `${profile.x1}px`);
    root.setProperty("--glitch-y1", `${profile.y1}px`);
    root.setProperty("--glitch-x2", `${profile.x2}px`);
    root.setProperty("--glitch-y2", `${profile.y2}px`);
    root.setProperty("--glitch-x3", `${profile.x3}px`);
    root.setProperty("--glitch-y3", `${profile.y3}px`);
    root.setProperty("--glitch-x4", `${profile.x4}px`);
    root.setProperty("--glitch-y4", `${profile.y4}px`);
    root.setProperty("--glitch-s1", `${profile.s1}`);
    root.setProperty("--glitch-s2", `${profile.s2}`);
    root.setProperty("--glitch-s3", `${profile.s3}`);
    root.setProperty("--glitch-s4", `${profile.s4}`);
    root.setProperty("--glitch-r1", `${profile.r1}deg`);
    root.setProperty("--glitch-r2", `${profile.r2}deg`);
  }
}
