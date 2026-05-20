# Wicked Game

An interactive browser artwork built around a chopped video loop, stem-based audio playback, live performance controls, and timed text overlays. The project runs entirely client-side and is bundled with Vite for local development and GitHub Pages deployment.

## Stack at a glance

- Vite serves and builds the app as a static site.
- Tone.js powers the audio engine, transport clock, playback-rate changes, and live FX.
- Native browser video, canvas, and CSS drive the visual layer.
- A lightweight custom event bus coordinates audio, video, controls, and overlays without a framework.
- GitHub Actions builds the site and deploys `dist/` to GitHub Pages on pushes to `main` or `master`.

## How the project is structured

### App boot flow

The app starts in [src/main.js](D:/Users/Dan/Documents/Wicked%20Games%20-%20sync/src/main.js). It:

- grabs the DOM elements from `index.html`
- creates a shared event bus
- instantiates the `AudioEngine`, `VideoEngine`, and `FactsOverlay`
- wires up keyboard/UI controls
- preloads audio and video before enabling playback

Playback is gated behind a user interaction because browsers require that before starting Web Audio reliably. Once the user clicks or presses Space, both engines start together.

### Configuration

[src/config.js](D:/Users/Dan/Documents/Wicked%20Games%20-%20sync/src/config.js) is the central config file. It defines:

- the base BPM and tempo range
- the time signature
- media paths
- key mappings for live effects
- facts overlay timing

Asset URLs are built with `import.meta.env.BASE_URL`, which keeps local dev and GitHub Pages paths aligned.

### Audio engine

[src/audioEngine.js](D:/Users/Dan/Documents/Wicked%20Games%20-%20sync/src/audioEngine.js) is the most technical part of the project.

It builds a Tone.js graph with separate channels for:

- vocals
- bass
- the "other" stem
- breaks

It uses two playback strategies for long material:

- a clean looping `Tone.Player` when playback is still at the base tempo
- a stretched `Tone.GrainPlayer` when tempo has changed

That hybrid approach helps preserve quality at the original speed while still allowing tempo manipulation when the BPM slider moves.

For the break layer, the current config points at one long file:

- `public/media/breaks/break-track.wav`

The engine can also fall back to one-bar sample switching; the config already generates references for 101 numbered break files, so the project can support either:

- one continuous break track
- randomly selected bar-length break samples

Live audio effects are triggered by held keys and routed through the event bus:

- `1`, `2`, `3` queue beat repeats at different note divisions
- `Q` closes a low-pass break filter
- `W` engages a bitcrush-style destruction layer
- `E` throws vocals into a feedback delay

Tone.Transport acts as the timing backbone. It emits repeating bar events, tempo changes, and repeat hits that the rest of the experience can react to.

### Video engine

[src/videoEngine.js](D:/Users/Dan/Documents/Wicked%20Games%20-%20sync/src/videoEngine.js) keeps the video visually in sync with the audio state.

Key ideas:

- the `<video>` element is always muted and treated as a visual source only
- playback rate follows the audio tempo ratio
- bar events rotate through color palettes and trigger glitch pulses
- freeze/glitch effects are created by drawing video frames to a canvas, storing them as data URLs, and rapidly replaying them through an overlaid `<img>`

There are two freeze modes:

- manual freeze when `R` is held
- automatic accent freezes every fourth bar when the manual freeze is not active

Most of the final look comes from CSS custom properties that the video engine updates in real time.

### Controls and events

[src/controls.js](D:/Users/Dan/Documents/Wicked%20Games%20-%20sync/src/controls.js) handles keyboard input and the BPM slider.

Current controls:

- `Space`: play / pause
- `Tab`: show or hide the HUD
- `F`: toggle the facts overlay
- `1` / `2` / `3`: beat repeat sizes
- `Q`, `W`, `E`, `R`: held live effects

[src/events.js](D:/Users/Dan/Documents/Wicked%20Games%20-%20sync/src/events.js) provides a very small event bus wrapper around `EventTarget`. That keeps modules loosely coupled: controls emit intent, and engines subscribe to the events they care about.

### Facts overlay

[src/factsOverlay.js](D:/Users/Dan/Documents/Wicked%20Games%20-%20sync/src/factsOverlay.js) imports `wicked_game_facts.csv` as raw text, parses it, shuffles it deterministically with a seeded RNG, and reveals one fact per timed slot based on the current video time.

Because the overlay reads from video playback time instead of running its own timeline, it stays aligned with the media transport.

### Styling

[src/style.css](D:/Users/Dan/Documents/Wicked%20Games%20-%20sync/src/style.css) does more than presentation. It is part of the visual engine:

- CSS variables control glitch offsets, scaling, rotation, and palette shifts
- class toggles from the video engine trigger pulses and transitions
- layered gradients and blend modes create the artwork atmosphere

## Media pipeline

The app expects pre-rendered assets in `public/media/`:

- `video/ChoppedDownMosh.mp4`
- `stems/vocals.wav`
- `stems/bass.wav`
- `stems/other.wav`
- `breaks/break-track.wav`
- optional numbered break slices `break-001.wav` through `break-101.wav`

The code assumes the long-form assets are timeline-aligned from the same starting point. That is important because the tempo-shifted and effect layers are synchronized by shared transport timing rather than by dynamic analysis.

## Running it locally

```bash
npm install
npm run dev
```

Build for production with:

```bash
npm run build
```

Preview the production build with:

```bash
npm run preview
```

## Deployment

GitHub Pages deployment is handled by [deploy-pages.yml](D:/Users/Dan/Documents/Wicked%20Games%20-%20sync/.github/workflows/deploy-pages.yml).

On push to `main` or `master`, the workflow:

1. checks out the repository with LFS support enabled
2. installs Node 20 and dependencies
3. runs `npm run build`
4. uploads `dist/`
5. deploys the built site to GitHub Pages

## Brief roadmap

- Add a clearer asset prep guide for exporting aligned stems, breaks, and video.
- Expand the alternate `other` stem variant system so multiple arrangements can crossfade in performance.
- Add a lightweight diagnostics panel for media load state, current bar, and active effect status.
- Decide whether the long break track or the per-bar random break mode is the long-term default and simplify the config around that choice.
