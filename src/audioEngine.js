import * as Tone from "tone";

const FILTER_OPEN_FREQUENCY = 18000;
const FILTER_CLOSED_FREQUENCY = 900;
const VARIANT_FADE_SECONDS = 0.04;
const LONG_GRAIN_SIZE = 0.09;
const LONG_GRAIN_OVERLAP = 0.045;
const REPEAT_GRAIN_SIZE = 0.035;
const REPEAT_GRAIN_OVERLAP = 0.02;
const REPEAT_QUANTIZE = "4n";
const REPEAT_RELEASE_FADE = 0.03;
const REPEAT_ENGAGE_FADE = 0.01;
const BPM_EPSILON = 0.0001;
const LONG_GRAIN_MIN = 0.04;
const LONG_GRAIN_MAX = 0.11;
const LONG_OVERLAP_MIN = 0.018;
const LONG_OVERLAP_MAX = 0.065;
const REPEAT_GRAIN_MIN = 0.02;
const REPEAT_GRAIN_MAX = 0.05;
const REPEAT_OVERLAP_MIN = 0.012;
const REPEAT_OVERLAP_MAX = 0.03;

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
    this.repeatQuantizeTimeoutId = null;
    this.hasTempoChanged = false;
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
    this.breakTrackCleanPlayer = null;
    this.breakTrackPlayer = null;
    this.breakRepeatPlayer = null;
    this.breakTrackCleanGain = null;
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

    Object.values(this.stemPlayers).forEach(({ cleanPlayer, stretchPlayer }) => {
      cleanPlayer.start(startAt);
      stretchPlayer.start(startAt);
    });

    this.otherVariantBank.forEach(({ cleanPlayer, stretchPlayer }) => {
      cleanPlayer.start(startAt);
      stretchPlayer.start(startAt);
    });

    if (this.breakTrackPlayer) {
      this.breakTrackTimeline = {
        sourceOffsetSeconds: this.config.breakStartOffsetSeconds,
        lastAudioTime: startAt,
        playbackRate: this.#getBreakPlaybackRate()
      };
      this.breakTrackStartTime = startAt;
      this.breakTrackCleanPlayer.start(startAt, this.config.breakStartOffsetSeconds);
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
    this.hasTempoChanged ||= Math.abs(bpm - this.config.baseBpm) > BPM_EPSILON;

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
    this.#updateBreakTrackMode(Tone.now(), immediate || this.hasTempoChanged);
    this.#updateLongTrackMode(Tone.now(), immediate || this.hasTempoChanged);
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
    this.levelMeter = new Tone.Meter({ normalRange: true, smoothing: 0.82 });
    this.masterDryGain = new Tone.Gain(1).toDestination();
    this.masterDestroyWetGain = new Tone.Gain(0).toDestination();

    this.mixBus.connect(this.masterDryGain);
    this.mixBus.connect(this.masterCrusher);
    this.masterCrusher.connect(this.masterDestroyWetGain);
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
    this.breakTrackCleanGain = new Tone.Gain(1);
    this.breakTrackGain = new Tone.Gain(0);
    this.breakRepeatGain = new Tone.Gain(1);
    this.breaksDryGain = new Tone.Gain(1);
    this.breaksFilterWetGain = new Tone.Gain(0);

    this.vocalsChannel = new Tone.Channel().connect(this.mixBus);
    this.bassChannel = new Tone.Channel().connect(this.mixBus);
    this.otherChannel = new Tone.Channel().connect(this.mixBus);
    this.breaksChannel = new Tone.Channel().connect(this.mixBus);

    this.breaksDryGain.connect(this.breaksChannel);
    this.breaksFilter.connect(this.breaksFilterWetGain);
    this.breaksFilterWetGain.connect(this.breaksChannel);
    this.breakTrackCleanGain.connect(this.breaksDryGain);
    this.breakTrackCleanGain.connect(this.breaksFilter);
    this.breakTrackGain.connect(this.breaksDryGain);
    this.breakTrackGain.connect(this.breaksFilter);
    this.breakRepeatGain.connect(this.breaksDryGain);
    this.breakRepeatGain.connect(this.breaksFilter);
    this.vocalDelay.connect(this.vocalsChannel);
  }

  #createStemPlayers() {
    this.stemPlayers = {};

    this.stemPlayers.vocals = this.#createHybridLoop(this.config.media.stems.vocals, this.vocalDelay);
    this.stemPlayers.bass = this.#createHybridLoop(this.config.media.stems.bass, this.bassChannel);

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
      const loop = this.#createHybridLoop(variant.path, this.otherChannel, index === 0 ? 1 : 0);
      return { variant, ...loop };
    });

    this.#updateLongPlayerPlaybackRates();
  }

  #createBreakPlayers() {
    if (this.config.media.breakTrackPath) {
      this.breakTrackCleanPlayer = this.#createCleanLoopPlayer(this.config.media.breakTrackPath).connect(this.breakTrackCleanGain);
      this.breakTrackPlayer = this.#createLongPlayer(this.config.media.breakTrackPath).connect(this.breakTrackGain);
      this.breakRepeatPlayer = this.#createRepeatPlayer(this.config.media.breakTrackPath).connect(this.breakRepeatGain);
      this.breakRepeatGain.gain.value = 0;

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
        this.#queueBeatRepeat(active ? "8n" : null);
        break;
      case "repeat-16n":
        this.#queueBeatRepeat(active ? "16n" : null);
        break;
      case "repeat-32n":
        this.#queueBeatRepeat(active ? "32n" : null);
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
    const dryLevel = active ? 0 : 1;
    const wetLevel = active ? 1 : 0;

    this.breaksFilter.frequency.rampTo(targetFrequency, 0.05);
    this.breaksFilter.Q.rampTo(targetQ, 0.05);
    this.breaksDryGain.gain.rampTo(dryLevel, 0.03);
    this.breaksFilterWetGain.gain.rampTo(wetLevel, 0.03);
  }

  #setDestroyState(active) {
    this.masterCrusher.bits = active ? 4 : 8;
    this.masterDryGain.gain.rampTo(active ? 0.35 : 1, 0.05);
    this.masterDestroyWetGain.gain.rampTo(active ? 0.8 : 0, 0.05);
  }

  #setVocalThrowState(active) {
    this.vocalDelay.wet.rampTo(active ? 0.55 : 0, 0.05);
  }

  #setBeatRepeat(interval, activationTime = Tone.now()) {
    if (!this.started) {
      return;
    }

    if (this.repeatScheduleId !== null) {
      Tone.Transport.clear(this.repeatScheduleId);
      this.repeatScheduleId = null;
      this.activeRepeatInterval = null;
    }

    if (!interval) {
      if (this.breakTrackPlayer && this.breakRepeatPlayer) {
        this.#scheduleBreakTrackIdleState(activationTime, REPEAT_RELEASE_FADE);
        this.#scheduleGain(this.breakRepeatGain.gain, 0, activationTime, REPEAT_RELEASE_FADE);
        this.breakRepeatPlayer.stop(activationTime + REPEAT_RELEASE_FADE + 0.005);
      }
      return;
    }

    if (this.breakTrackPlayer && this.breakRepeatPlayer) {
      const intervalSeconds = Tone.Time(interval).toSeconds();
      const playbackRate = this.#getBreakPlaybackRate();
      const sourceDuration = Math.max(intervalSeconds * playbackRate, 0.04);
      const bufferDuration = this.breakRepeatPlayer.buffer.duration;
      const safeOffset = this.#getSafeRepeatOffset(
        this.#getBreakTrackSourceOffsetAt(activationTime),
        sourceDuration,
        bufferDuration
      );

      this.repeatSourceOffsetSeconds = safeOffset;
      this.breakRepeatPlayer.loop = true;
      this.breakRepeatPlayer.loopStart = safeOffset;
      this.breakRepeatPlayer.loopEnd = Math.min(safeOffset + sourceDuration, bufferDuration);
      this.breakRepeatPlayer.stop(activationTime);
      this.breakRepeatPlayer.start(activationTime, safeOffset);
      this.#scheduleGain(this.breakTrackCleanGain.gain, 0, activationTime, REPEAT_ENGAGE_FADE);
      this.#scheduleGain(this.breakTrackGain.gain, 0, activationTime, REPEAT_ENGAGE_FADE);
      this.#scheduleGain(this.breakRepeatGain.gain, 1, activationTime, REPEAT_ENGAGE_FADE);
      this.activeRepeatInterval = interval;
      this.#emitBeatRepeatHit("break-track", interval);
      this.repeatScheduleId = Tone.Transport.scheduleRepeat(
        () => {
          this.#emitBeatRepeatHit("break-track", interval);
        },
        interval,
        activationTime + intervalSeconds
      );
      return;
    }

    const triggerRepeatHit = (time) => {
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
    };

    this.activeRepeatInterval = interval;
    triggerRepeatHit(activationTime);
    this.repeatScheduleId = Tone.Transport.scheduleRepeat(
      triggerRepeatHit,
      interval,
      activationTime + Tone.Time(interval).toSeconds()
    );
  }

  #queueBeatRepeat(interval) {
    if (!this.started) {
      return;
    }

    if (this.repeatQuantizeTimeoutId !== null) {
      window.clearTimeout(this.repeatQuantizeTimeoutId);
      this.repeatQuantizeTimeoutId = null;
    }

    const quantizedTime = Tone.Transport.nextSubdivision(REPEAT_QUANTIZE) || Tone.now() + 0.01;
    const delayMs = Math.max((quantizedTime - Tone.now()) * 1000, 0);

    this.repeatQuantizeTimeoutId = window.setTimeout(() => {
      this.repeatQuantizeTimeoutId = null;
      this.#setBeatRepeat(interval, quantizedTime);
    }, delayMs);
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
    this.#queueBeatRepeat(null);
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
    this.repeatQuantizeTimeoutId = null;
    this.activeRepeatInterval = null;
    this.hasTempoChanged = false;
    this.repeatSourceOffsetSeconds = this.config.breakStartOffsetSeconds;
    this.breakTrackStartTime = null;
    this.breakTrackCleanGain.gain.value = 1;
    this.breakTrackGain.gain.value = 0;
    this.breakRepeatGain.gain.value = 0;

    if (this.breakRepeatPlayer) {
      this.breakRepeatPlayer.stop();
    }

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
    const { longGrainSize, longOverlap } = this.#getStretchSettings();

    if (this.breakTrackPlayer) {
      this.breakTrackPlayer.playbackRate = playbackRate;
      this.#applyStretchSettings(this.breakTrackPlayer, longGrainSize, longOverlap);
    }

    if (this.breakRepeatPlayer) {
      this.breakRepeatPlayer.playbackRate = playbackRate;
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
    const { longGrainSize, longOverlap } = this.#getStretchSettings();

    Object.values(this.stemPlayers).forEach(({ stretchPlayer }) => {
      stretchPlayer.playbackRate = playbackRate;
      this.#applyStretchSettings(stretchPlayer, longGrainSize, longOverlap);
    });

    this.otherVariantBank.forEach(({ stretchPlayer }) => {
      stretchPlayer.playbackRate = playbackRate;
      this.#applyStretchSettings(stretchPlayer, longGrainSize, longOverlap);
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

  #createLongPlayer(url) {
    return new Tone.GrainPlayer({
      url,
      loop: true,
      grainSize: LONG_GRAIN_SIZE,
      overlap: LONG_GRAIN_OVERLAP
    });
  }

  #createRepeatPlayer(url) {
    return new Tone.Player({
      url,
      loop: true
    });
  }

  #createHybridLoop(url, destination, initialOutput = 1) {
    const outputGain = new Tone.Gain(initialOutput).connect(destination);
    const cleanGain = new Tone.Gain(1).connect(outputGain);
    const stretchGain = new Tone.Gain(0).connect(outputGain);
    const cleanPlayer = this.#createCleanLoopPlayer(url).connect(cleanGain);
    const stretchPlayer = this.#createLongPlayer(url).connect(stretchGain);

    return {
      cleanPlayer,
      stretchPlayer,
      cleanGain,
      stretchGain,
      gain: outputGain
    };
  }

  #createCleanLoopPlayer(url) {
    return new Tone.Player({
      url,
      loop: true
    });
  }

  #emitBeatRepeatHit(breakId, interval) {
    this.events.emit("beat-repeat-hit", {
      breakId,
      interval
    });
  }

  #scheduleGain(param, target, time, fadeDuration) {
    const startValue = param.value;
    param.cancelScheduledValues(time);
    param.setValueAtTime(startValue, time);
    param.linearRampToValueAtTime(target, time + fadeDuration);
  }

  #getStretchSettings() {
    const ratio = Math.max(this.currentBpm / this.config.baseBpm, 0.25);
    const longGrainSize = this.#clamp(LONG_GRAIN_SIZE / ratio, LONG_GRAIN_MIN, LONG_GRAIN_MAX);
    const longOverlap = this.#clamp(longGrainSize * 0.58, LONG_OVERLAP_MIN, LONG_OVERLAP_MAX);
    const repeatGrainSize = this.#clamp(REPEAT_GRAIN_SIZE / Math.max(Math.sqrt(ratio), 0.5), REPEAT_GRAIN_MIN, REPEAT_GRAIN_MAX);
    const repeatOverlap = this.#clamp(repeatGrainSize * 0.58, REPEAT_OVERLAP_MIN, REPEAT_OVERLAP_MAX);

    return { longGrainSize, longOverlap, repeatGrainSize, repeatOverlap };
  }

  #applyStretchSettings(player, grainSize, overlap) {
    player.grainSize = grainSize;
    player.overlap = overlap;
  }

  #getSafeRepeatOffset(offset, sourceDuration, bufferDuration) {
    if (!bufferDuration || bufferDuration <= sourceDuration) {
      return 0;
    }

    return Math.min(Math.max(offset, 0), bufferDuration - sourceDuration);
  }

  #scheduleBreakTrackIdleState(time, fadeDuration) {
    const useClean = this.#shouldUseCleanBreakTrack();
    this.#scheduleGain(this.breakTrackCleanGain.gain, useClean ? 1 : 0, time, fadeDuration);
    this.#scheduleGain(this.breakTrackGain.gain, useClean ? 0 : 1, time, fadeDuration);
  }

  #updateBreakTrackMode(time = Tone.now(), immediate = false) {
    if (!this.breakTrackPlayer || !this.breakTrackCleanGain || this.activeRepeatInterval) {
      return;
    }

    if (immediate) {
      const useClean = this.#shouldUseCleanBreakTrack();
      this.breakTrackCleanGain.gain.value = useClean ? 1 : 0;
      this.breakTrackGain.gain.value = useClean ? 0 : 1;
      return;
    }

    this.#scheduleBreakTrackIdleState(time, 0.04);
  }

  #updateLongTrackMode(time = Tone.now(), immediate = false) {
    const useClean = this.#shouldUseCleanLongPlayback();

    Object.values(this.stemPlayers).forEach(({ cleanGain, stretchGain }) => {
      if (immediate) {
        cleanGain.gain.value = useClean ? 1 : 0;
        stretchGain.gain.value = useClean ? 0 : 1;
      } else {
        this.#scheduleGain(cleanGain.gain, useClean ? 1 : 0, time, 0.04);
        this.#scheduleGain(stretchGain.gain, useClean ? 0 : 1, time, 0.04);
      }
    });

    this.otherVariantBank.forEach(({ cleanGain, stretchGain }) => {
      if (immediate) {
        cleanGain.gain.value = useClean ? 1 : 0;
        stretchGain.gain.value = useClean ? 0 : 1;
      } else {
        this.#scheduleGain(cleanGain.gain, useClean ? 1 : 0, time, 0.04);
        this.#scheduleGain(stretchGain.gain, useClean ? 0 : 1, time, 0.04);
      }
    });
  }

  #shouldUseCleanBreakTrack() {
    return !this.hasTempoChanged && Math.abs(this.currentBpm - this.config.baseBpm) <= BPM_EPSILON;
  }

  #shouldUseCleanLongPlayback() {
    return !this.hasTempoChanged && Math.abs(this.currentBpm - this.config.baseBpm) <= BPM_EPSILON;
  }

  #clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
}
