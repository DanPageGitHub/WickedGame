import * as Tone from "tone";

const FILTER_OPEN_FREQUENCY = 18000;
const FILTER_CLOSED_FREQUENCY = 900;
const VARIANT_FADE_SECONDS = 0.04;

export class AudioEngine {
  constructor(config, events) {
    this.config = config;
    this.events = events;

    this.loaded = false;
    this.started = false;
    this.eventsBound = false;

    this.currentBpm = config.startBpm;
    this.currentBreakId = null;
    this.currentOtherVariantIndex = 0;
    this.activeRepeatInterval = null;
    this.barScheduleId = null;
    this.repeatScheduleId = null;
    this.repeatSourceOffsetSeconds = config.breakStartOffsetSeconds;
    this.breakTrackStartTime = null;
    this.breakTrackTimeline = {
      sourceOffsetSeconds: config.breakStartOffsetSeconds,
      lastAudioTime: 0,
      playbackRate: config.startBpm / config.baseBpm
    };

    this.stemPlayers = {};
    this.otherVariantBank = [];
    this.breakPlayers = null;
    this.breakTrackPlayer = null;
    this.breakRepeatTap = null;
    this.breakTrackGain = null;
    this.breakRepeatGain = null;
  }

  async load(setStatus = () => {}) {
    if (this.loaded) {
      return;
    }

    setStatus("Preparing audio graph...");
    this.#createGraph();
    this.#bindEventBus();

    setStatus("Loading stems and break samples...");
    this.#createStemPlayers();
    this.#createOtherVariantPlayers();
    this.#createBreakPlayers();

    await Tone.loaded();

    this.loaded = true;
  }

  async start() {
    if (!this.loaded) {
      throw new Error("AudioEngine.start() called before load().");
    }

    await Tone.start();

    if (this.started) {
      return;
    }

    this.#resetTransport();
    this.#scheduleBarChanges();

    const startAt = Tone.now() + 0.05;

    Object.values(this.stemPlayers).forEach((player) => {
      player.start(startAt);
    });

    this.otherVariantBank.forEach(({ player }) => {
      player.start(startAt);
    });

    if (this.breakTrackPlayer) {
      this.breakTrackTimeline = {
        sourceOffsetSeconds: this.config.breakStartOffsetSeconds,
        lastAudioTime: startAt,
        playbackRate: this.#getBreakPlaybackRate()
      };
      this.breakTrackStartTime = startAt;
      this.breakTrackPlayer.start(startAt, this.config.breakStartOffsetSeconds);
    }

    Tone.Transport.start(startAt);
    this.started = true;

    this.setTempo(this.currentBpm, true);
    this.#setActiveOtherVariant(this.currentOtherVariantIndex, true);
    this.events.emit("other-variant-change", this.getOtherVariantState());
  }

  setTempo(bpm, immediate = false) {
    if (this.breakTrackPlayer) {
      this.#advanceBreakTrackTimeline(Tone.now());
    }

    this.currentBpm = bpm;

    if (immediate) {
      Tone.Transport.bpm.value = bpm;
    } else {
      Tone.Transport.bpm.rampTo(bpm, this.config.shortRampSeconds);
    }

    this.events.emit("tempo-change", {
      bpm,
      playbackRate: bpm / this.config.baseBpm
    });

    this.#updateLongPlayerPlaybackRates();
    this.#updateBreakPlaybackRates();
  }

  cycleOtherVariant() {
    if (this.otherVariantBank.length < 2) {
      return this.getOtherVariantState();
    }

    const nextIndex = (this.currentOtherVariantIndex + 1) % this.otherVariantBank.length;
    this.#setActiveOtherVariant(nextIndex);
    const state = this.getOtherVariantState();
    this.events.emit("other-variant-change", state);
    return state;
  }

  getOtherVariantState() {
    const fallbackVariants =
      this.config.media.otherVariants.length > 0
        ? this.config.media.otherVariants
        : [
            {
              id: "og",
              label: "OG",
              path: this.config.media.stems.other
            }
          ];
    const sourceVariants = this.otherVariantBank.length
      ? this.otherVariantBank.map(({ variant }) => variant)
      : fallbackVariants;
    const activeVariant = sourceVariants[this.currentOtherVariantIndex] ?? sourceVariants[0];

    return {
      activeIndex: this.currentOtherVariantIndex,
      activeId: activeVariant?.id ?? null,
      activeLabel: activeVariant?.label ?? "Unavailable",
      count: sourceVariants.length
    };
  }

  #createGraph() {
    this.mixBus = new Tone.Gain(1);
    this.masterCrusher = new Tone.BitCrusher({ bits: 8, wet: 0 });
    this.masterDrive = new Tone.Distortion({ distortion: 0.2, wet: 0 });
    this.masterLimiter = new Tone.Limiter(-1).toDestination();
    this.levelMeter = new Tone.Meter({ normalRange: true, smoothing: 0.82 });

    this.mixBus.chain(this.masterCrusher, this.masterDrive, this.masterLimiter);
    this.mixBus.connect(this.levelMeter);

    this.breaksFilter = new Tone.Filter({
      type: "lowpass",
      frequency: FILTER_OPEN_FREQUENCY,
      rolloff: -24,
      Q: 1
    });
    this.vocalDelay = new Tone.FeedbackDelay({
      delayTime: "8n",
      feedback: 0.35,
      wet: 0
    });
    this.breakTrackGain = new Tone.Gain(1);
    this.breakRepeatGain = new Tone.Gain(1);

    this.vocalsChannel = new Tone.Channel().connect(this.mixBus);
    this.bassChannel = new Tone.Channel().connect(this.mixBus);
    this.otherChannel = new Tone.Channel().connect(this.mixBus);
    this.breaksChannel = new Tone.Channel().connect(this.mixBus);

    this.breaksFilter.connect(this.breaksChannel);
    this.breakTrackGain.connect(this.breaksFilter);
    this.breakRepeatGain.connect(this.breaksFilter);
    this.vocalDelay.connect(this.vocalsChannel);
  }

  #createStemPlayers() {
    this.stemPlayers = {};

    this.stemPlayers.vocals = new Tone.Player({
      url: this.config.media.stems.vocals,
      loop: true,
      fadeIn: 0.01,
      fadeOut: 0.01
    }).connect(this.vocalDelay);

    this.stemPlayers.bass = new Tone.Player({
      url: this.config.media.stems.bass,
      loop: true,
      fadeIn: 0.01,
      fadeOut: 0.01
    }).connect(this.bassChannel);

    this.#updateLongPlayerPlaybackRates();
  }

  #createOtherVariantPlayers() {
    const variants =
      this.config.media.otherVariants.length > 0
        ? this.config.media.otherVariants
        : [
            {
              id: "og",
              label: "OG",
              path: this.config.media.stems.other
            }
          ];

    this.otherVariantBank = variants.map((variant, index) => {
      const player = new Tone.Player({
        url: variant.path,
        loop: true,
        fadeIn: 0.01,
        fadeOut: 0.01
      });
      const gain = new Tone.Gain(index === 0 ? 1 : 0).connect(this.otherChannel);

      player.connect(gain);

      return { variant, player, gain };
    });
  }

  #createBreakPlayers() {
    if (this.config.media.breakTrackPath) {
      this.breakTrackPlayer = new Tone.Player({
        url: this.config.media.breakTrackPath,
        loop: true,
        fadeIn: 0.01,
        fadeOut: 0.01
      }).connect(this.breakTrackGain);

      this.breakRepeatTap = new Tone.Player({
        url: this.config.media.breakTrackPath,
        loop: false,
        fadeIn: 0.005,
        fadeOut: 0.01
      }).connect(this.breakRepeatGain);

      this.#updateBreakPlaybackRates();
      return;
    }

    const urls = Object.fromEntries(
      this.config.media.breakSamples.map((sample) => [sample.id, sample.path])
    );

    this.breakPlayers = new Tone.Players({
      urls
    }).connect(this.breaksFilter);

    this.#updateBreakPlaybackRates();
  }

  #bindEventBus() {
    if (this.eventsBound) {
      return;
    }

    this.events.on("effect-hold", ({ effectId, active }) => {
      this.#handleEffectHold(effectId, active);
    });

    this.events.on("other-cycle-request", () => {
      this.cycleOtherVariant();
    });

    this.events.on("clear-held-effects", () => {
      this.#clearAllEffects();
    });

    this.eventsBound = true;
  }

  #handleEffectHold(effectId, active) {
    switch (effectId) {
      case "repeat-8n":
        this.#setBeatRepeat(active ? "8n" : null);
        break;
      case "repeat-16n":
        this.#setBeatRepeat(active ? "16n" : null);
        break;
      case "repeat-32n":
        this.#setBeatRepeat(active ? "32n" : null);
        break;
      case "filter":
        this.#setFilterState(active);
        break;
      case "destroy":
        this.#setDestroyState(active);
        break;
      case "vocal-throw":
        this.#setVocalThrowState(active);
        break;
      default:
        break;
    }
  }

  #setFilterState(active) {
    const targetFrequency = active ? FILTER_CLOSED_FREQUENCY : FILTER_OPEN_FREQUENCY;
    const targetQ = active ? 10 : 1;

    this.breaksFilter.frequency.rampTo(targetFrequency, 0.05);
    this.breaksFilter.Q.rampTo(targetQ, 0.05);
  }

  #setDestroyState(active) {
    this.masterCrusher.bits = active ? 4 : 8;
    this.masterCrusher.wet.rampTo(active ? 0.9 : 0, 0.05);
  }

  #setVocalThrowState(active) {
    this.vocalDelay.wet.rampTo(active ? 0.55 : 0, 0.05);
  }

  #setBeatRepeat(interval) {
    if (!this.started) {
      return;
    }

    if (this.repeatScheduleId !== null) {
      Tone.Transport.clear(this.repeatScheduleId);
      this.repeatScheduleId = null;
      this.activeRepeatInterval = null;
    }

    if (!interval) {
      if (this.breakTrackGain) {
        this.breakTrackGain.gain.rampTo(1, 0.01);
      }
      return;
    }

    if (this.breakTrackPlayer) {
      this.repeatSourceOffsetSeconds = this.#getBreakTrackSourceOffsetAt(Tone.now());
      this.breakTrackGain.gain.rampTo(0, 0.01);
    }

    this.activeRepeatInterval = interval;
    this.repeatScheduleId = Tone.Transport.scheduleRepeat((time) => {
      if (this.breakTrackPlayer && this.breakRepeatTap) {
        const intervalSeconds = Tone.Time(interval).toSeconds();
        const playbackRate = this.#getBreakPlaybackRate();
        const sourceDuration = Math.max(intervalSeconds * playbackRate * 0.95, 0.04);

        this.breakRepeatTap.start(time, this.repeatSourceOffsetSeconds, sourceDuration);
        this.events.emit("beat-repeat-hit", {
          breakId: "break-track",
          interval
        });
        return;
      }

      if (!this.currentBreakId) {
        return;
      }

      const repeatPlayer = this.breakPlayers.player(this.currentBreakId);
      const intervalSeconds = Tone.Time(interval).toSeconds();
      const playbackRate = this.#getBreakPlaybackRate();
      const sourceDuration = Math.max(intervalSeconds * playbackRate * 0.95, 0.04);

      repeatPlayer.start(time, this.config.breakStartOffsetSeconds, sourceDuration);
      this.events.emit("beat-repeat-hit", {
        breakId: this.currentBreakId,
        interval
      });
    }, interval);
  }

  #scheduleBarChanges() {
    if (this.barScheduleId !== null) {
      Tone.Transport.clear(this.barScheduleId);
    }

    this.barScheduleId = Tone.Transport.scheduleRepeat((time) => {
      this.events.emit("bar-cycle", { time });

      if (this.breakTrackPlayer) {
        return;
      }

      const nextBreak = this.#pickRandomBreakId();
      this.currentBreakId = nextBreak;
      this.breakPlayers
        .player(nextBreak)
        .start(time, this.config.breakStartOffsetSeconds);
      this.events.emit("break-change", {
        breakId: nextBreak
      });
    }, "1m", 0);
  }

  #pickRandomBreakId() {
    const breakIds = this.config.media.breakSamples.map((sample) => sample.id);
    const randomIndex = Math.floor(Math.random() * breakIds.length);
    return breakIds[randomIndex];
  }

  #setActiveOtherVariant(index, immediate = false) {
    if (index < 0 || index >= this.otherVariantBank.length) {
      return;
    }

    this.currentOtherVariantIndex = index;

    this.otherVariantBank.forEach(({ gain }, variantIndex) => {
      const target = variantIndex === index ? 1 : 0;

      if (immediate) {
        gain.gain.value = target;
      } else {
        gain.gain.rampTo(target, VARIANT_FADE_SECONDS);
      }
    });
  }

  #clearAllEffects() {
    this.#setBeatRepeat(null);
    this.#setFilterState(false);
    this.#setDestroyState(false);
    this.#setVocalThrowState(false);
  }

  #resetTransport() {
    Tone.Transport.stop();
    Tone.Transport.cancel();
    Tone.Transport.position = 0;
    Tone.Transport.bpm.value = this.currentBpm;
    Tone.Transport.timeSignature = this.config.timeSignature;
    this.currentBreakId = null;
    this.barScheduleId = null;
    this.repeatScheduleId = null;
    this.activeRepeatInterval = null;
    this.repeatSourceOffsetSeconds = this.config.breakStartOffsetSeconds;
    this.breakTrackStartTime = null;
    this.breakTrackTimeline = {
      sourceOffsetSeconds: this.config.breakStartOffsetSeconds,
      lastAudioTime: 0,
      playbackRate: this.#getBreakPlaybackRate()
    };
  }

  #getBreakPlaybackRate() {
    return this.currentBpm / this.config.baseBpm;
  }

  #updateBreakPlaybackRates() {
    const playbackRate = this.#getBreakPlaybackRate();

    if (this.breakTrackPlayer) {
      this.breakTrackPlayer.playbackRate = playbackRate;
    }

    if (this.breakRepeatTap) {
      this.breakRepeatTap.playbackRate = playbackRate;
    }

    if (!this.breakPlayers) {
      return;
    }

    this.config.media.breakSamples.forEach((sample) => {
      this.breakPlayers.player(sample.id).playbackRate = playbackRate;
    });
  }

  #updateLongPlayerPlaybackRates() {
    const playbackRate = this.currentBpm / this.config.baseBpm;

    Object.values(this.stemPlayers).forEach((player) => {
      player.playbackRate = playbackRate;
    });

    this.otherVariantBank.forEach(({ player }) => {
      player.playbackRate = playbackRate;
    });
  }

  #advanceBreakTrackTimeline(audioTime) {
    if (!this.breakTrackPlayer) {
      return;
    }

    const duration = this.breakTrackPlayer.buffer.duration;

    if (!duration) {
      return;
    }

    const elapsed = Math.max(0, audioTime - this.breakTrackTimeline.lastAudioTime);
    const advanced =
      this.breakTrackTimeline.sourceOffsetSeconds +
      elapsed * this.breakTrackTimeline.playbackRate;

    this.breakTrackTimeline = {
      sourceOffsetSeconds: ((advanced % duration) + duration) % duration,
      lastAudioTime: audioTime,
      playbackRate: this.#getBreakPlaybackRate()
    };
  }

  #getBreakTrackSourceOffsetAt(audioTime) {
    this.#advanceBreakTrackTimeline(audioTime);
    return this.breakTrackTimeline.sourceOffsetSeconds;
  }

  getVisualLevel() {
    const rawLevel = this.levelMeter?.getValue?.() ?? 0;
    return Number.isFinite(rawLevel) ? Math.max(0, Math.min(rawLevel, 1)) : 0;
  }

  async suspend() {
    await Tone.getContext().rawContext.suspend();
  }

  async resume() {
    await Tone.getContext().rawContext.resume();
  }
}
