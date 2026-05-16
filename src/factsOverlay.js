import factsCsv from "../wicked_game_facts.csv?raw";

function parseCsv(csvText) {
  return csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index) => !(index === 0 && line.toLowerCase() === "fact"));
}

function createSeededRandom(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleFacts(facts, seed) {
  const random = createSeededRandom(seed);
  const shuffled = [...facts];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

function easeOutCubic(value) {
  return 1 - (1 - value) ** 3;
}

function easeInCubic(value) {
  return value ** 3;
}

export class FactsOverlay {
  constructor(config, events, elements) {
    this.config = config;
    this.events = events;
    this.video = elements.video;
    this.overlay = elements.overlay;
    this.text = elements.text;

    this.enabled = Boolean(config.factsOverlay.enabledByDefault);
    this.eventsBound = false;
    this.rafId = null;
    this.facts = shuffleFacts(parseCsv(factsCsv), config.factsOverlay.seed);
    this.lastFactIndex = -1;
    this.overlay.hidden = !this.enabled;
    this.overlay.setAttribute("aria-hidden", String(!this.enabled));
    this.text.style.maxWidth = `${config.factsOverlay.maxWidthPx}px`;
  }

  load() {
    this.#bindEvents();
    this.#updateVisibility();
    this.#updateFrame();
  }

  destroy() {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  #bindEvents() {
    if (this.eventsBound) {
      return;
    }

    this.events.on("facts-toggle", () => {
      this.enabled = !this.enabled;
      this.#updateVisibility();
      this.#updateFrame();
    });

    this.eventsBound = true;
  }

  #updateVisibility() {
    this.overlay.hidden = !this.enabled;
    this.overlay.setAttribute("aria-hidden", String(!this.enabled));
    this.overlay.classList.toggle("is-active", this.enabled);
  }

  #updateFrame() {
    if (this.enabled) {
      const slotSeconds = this.config.factsOverlay.slotSeconds;
      const fadeInSeconds = this.config.factsOverlay.fadeInSeconds;
      const holdSeconds = this.config.factsOverlay.holdSeconds;
      const fadeOutSeconds = this.config.factsOverlay.fadeOutSeconds;
      const maxFactTime = slotSeconds * this.facts.length;
      const currentTime = this.video.currentTime || 0;

      if (currentTime >= maxFactTime || this.facts.length === 0) {
        this.overlay.style.opacity = "0";
      } else {
        const factIndex = Math.floor(currentTime / slotSeconds);
        const fact = this.facts[factIndex];
        const slotPosition = currentTime % slotSeconds;
        let opacity = 1;

        if (slotPosition < fadeInSeconds) {
          opacity = easeOutCubic(slotPosition / fadeInSeconds);
        } else if (slotPosition >= fadeInSeconds + holdSeconds) {
          const fadeOutPosition = (slotPosition - fadeInSeconds - holdSeconds) / fadeOutSeconds;
          opacity = 1 - easeInCubic(Math.min(Math.max(fadeOutPosition, 0), 1));
        }

        if (factIndex !== this.lastFactIndex) {
          this.text.textContent = fact;
          this.lastFactIndex = factIndex;
        }

        this.overlay.style.opacity = `${Math.min(Math.max(opacity, 0), 1)}`;
      }
    } else {
      this.overlay.style.opacity = "0";
    }

    this.rafId = window.requestAnimationFrame(() => this.#updateFrame());
  }
}
