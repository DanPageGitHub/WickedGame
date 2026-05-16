function normalizeKey(key) {
  if (key === " ") {
    return "space";
  }

  return key.toLowerCase();
}

export function createControls({ config, events, elements, onStart, onTempoChange }) {
  const heldKeyMap = config.controls.heldKeys;
  const activeKeys = new Set();
  const isRepeatKey = (key) => heldKeyMap[key]?.effectId.startsWith("repeat-");
  let controlsVisible = false;

  const keyHelpItems = Object.entries(heldKeyMap).map(([, value]) => value.label);
  keyHelpItems.push("Button: cycle synced Other variants");
  keyHelpItems.push("Space: pause / resume");
  keyHelpItems.push("Tab: show / hide controls");
  elements.keyHelp.innerHTML = keyHelpItems.map((item) => `<span>${item}</span>`).join("");

  elements.tempoSlider.min = String(config.tempo.min);
  elements.tempoSlider.max = String(config.tempo.max);
  elements.tempoSlider.step = String(config.tempo.step);
  elements.tempoSlider.value = String(config.startBpm);
  elements.tempoValue.textContent = `${config.startBpm} BPM`;
  elements.app.classList.add("hud-hidden");
  elements.controlsHint.classList.add("is-visible");
  window.setTimeout(() => {
    elements.controlsHint.classList.remove("is-visible");
  }, 5000);

  const emitEffect = (key, active) => {
    const mapping = heldKeyMap[key];

    if (!mapping) {
      return;
    }

    events.emit("effect-hold", {
      effectId: mapping.effectId,
      active
    });
  };

  const clearHeldKeys = () => {
    activeKeys.forEach((key) => {
      emitEffect(key, false);
    });
    activeKeys.clear();
    events.emit("clear-held-effects");
  };

  const handleKeyDown = (event) => {
    const key = normalizeKey(event.key);
    const mapping = heldKeyMap[key];

    if (key === "tab") {
      event.preventDefault();
      controlsVisible = !controlsVisible;
      elements.app.classList.toggle("hud-hidden", !controlsVisible);
      elements.controlsHint.classList.remove("is-visible");
      return;
    }

    if (key === "space") {
      event.preventDefault();

      if (event.repeat) {
        return;
      }

      events.emit("transport-toggle");
      return;
    }

    if (!mapping) {
      return;
    }

    event.preventDefault();

    if (event.repeat || activeKeys.has(key)) {
      return;
    }

    if (isRepeatKey(key)) {
      [...activeKeys]
        .filter((activeKey) => activeKey !== key && isRepeatKey(activeKey))
        .forEach((activeKey) => {
          activeKeys.delete(activeKey);
          emitEffect(activeKey, false);
        });
    }

    activeKeys.add(key);
    emitEffect(key, true);
  };

  const handleKeyUp = (event) => {
    const key = normalizeKey(event.key);

    if (!activeKeys.has(key)) {
      return;
    }

    event.preventDefault();
    activeKeys.delete(key);
    emitEffect(key, false);
  };

  const handleTempoInput = (event) => {
    const bpm = Number(event.target.value);
    elements.tempoValue.textContent = `${bpm} BPM`;
    onTempoChange(bpm);
  };

  const handleStart = async () => {
    elements.startButton.disabled = true;

    try {
      const keepDisabled = await onStart();

      if (!keepDisabled) {
        elements.startButton.disabled = false;
      }
    } catch (error) {
      elements.startButton.disabled = false;
      throw error;
    }
  };

  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);
  window.addEventListener("blur", clearHeldKeys);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearHeldKeys();
    }
  });

  elements.startButton.addEventListener("click", handleStart);
  elements.tempoSlider.addEventListener("input", handleTempoInput);
  elements.otherButton.addEventListener("click", () => {
    events.emit("other-cycle-request");
  });

  return {
    clearHeldKeys,
    setOtherVariantState({ activeLabel, count }) {
      elements.otherLabel.textContent = activeLabel;
      elements.otherButton.disabled = count < 2;
      elements.otherButton.title =
        count < 2
          ? "Add more synced other variants in src/config.js to enable switching."
          : "Cycle to the next synced Other variant.";
    }
  };
}
