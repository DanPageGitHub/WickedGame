function createBreakSamples(count) {
  return Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(3, "0");

    return {
      id: `break-${number}`,
      label: `Break ${number}`,
      path: `/media/breaks/break-${number}.wav`
    };
  });
}

export const APP_CONFIG = {
  baseBpm: 112,
  startBpm: 112,
  shortRampSeconds: 0.2,
  timeSignature: [4, 4],
  breakSourceBpm: 112,
  breakStartOffsetSeconds: 0,
  tempo: {
    min: 70,
    max: 250,
    step: 1
  },
  media: {
    videoPath: "/media/video/MoshedVersion.mp4",
    stems: {
      vocals: "/media/stems/vocals.wav",
      bass: "/media/stems/bass.wav",
      other: "/media/stems/other.wav"
    },
    // When you switch to one long break track, put its path here and the engine
    // will run it continuously instead of choosing a random one-bar break per bar.
    breakTrackPath: "/media/breaks/break-track.wav",
    // Add synced alternate versions here. They must be exported from the same timeline start.
    otherVariants: [
      {
        id: "og",
        label: "OG",
        path: "/media/stems/other.wav"
      }
    ],
    breakSamples: createBreakSamples(101)
  },
  controls: {
    heldKeys: {
      "1": {
        effectId: "repeat-8n",
        label: "Hold 1: 1/8 beat repeat"
      },
      "2": {
        effectId: "repeat-16n",
        label: "Hold 2: 1/16 beat repeat"
      },
      "3": {
        effectId: "repeat-32n",
        label: "Hold 3: 1/32 beat repeat"
      },
      q: {
        effectId: "filter",
        label: "Hold Q: break filter"
      },
      w: {
        effectId: "destroy",
        label: "Hold W: bitcrush/destruction"
      },
      e: {
        effectId: "vocal-throw",
        label: "Hold E: vocal delay throw"
      },
      r: {
        effectId: "video-freeze",
        label: "Hold R: video glitch/freeze"
      }
    }
  }
};
