/** The voice panel, voice channels and the video stage (English, the source of truth). */
export const voice = {
  // Voice panel buttons: e2e matches these names exactly.
  mute: 'Mute',
  unmute: 'Unmute',
  deafen: 'Deafen',
  undeafen: 'Undeafen',
  leave: 'Leave',
  camera: 'Camera',
  stopCamera: 'Stop camera',
  shareScreen: 'Share screen',
  stopSharing: 'Stop sharing',
  shareTabAudio: 'Share tab audio',
  enableAudio: 'Click to enable audio',
  panel: {
    label: 'Voice connection',
    /** The panel's channel name before the bootstrap has it. */
    fallbackChannel: 'Voice channel',
    connecting: 'Connecting…',
    connected: 'Voice connected',
    reconnecting: 'Reconnecting…',
  },
  channel: {
    join: 'Join {name}',
    /** The participant list under a voice channel. */
    participants: 'In {name}',
  },
  participant: {
    muted: 'Muted',
    deafened: 'Deafened',
    cameraOn: 'Camera on',
    live: 'LIVE',
    liveTitle: 'Sharing their screen',
    volume: 'Volume',
    volumeFor: 'Volume for {name}',
    /** `{percent}` is already a formatted number. */
    volumePercent: '{percent}%',
    disconnect: 'Disconnect',
  },
  stage: {
    label: 'Video',
    gridView: 'Grid view',
    focus: 'Focus {label}',
    you: 'You',
    screenTile: '{name} (screen)',
    unknownUser: 'Unknown user',
  },
  /** Notices (app notice) and page alerts from the voice controller. */
  messages: {
    joinFailed: "Couldn't join the voice channel. Try again.",
    joinTimedOut: 'The voice server took too long to answer. Try joining again.',
    micUnavailable: 'Microphone unavailable: check the browser permission. You joined muted.',
    dropped: 'You were disconnected from voice.',
    cameraBlocked: 'Camera is unavailable or blocked',
    screenBlocked: 'Screen share was cancelled or blocked',
    micLost: 'Microphone disconnected — using the default device.',
    cameraLost: 'Camera disconnected — using the default device.',
    outputLost: 'Output device disconnected — using the default device.',
    switchFailed: "Couldn't switch to that device.",
  },
  /** Key and mouse button names for the push-to-talk and shortcut bindings (voice/ptt.ts). */
  keys: {
    none: 'Not set',
    space: 'Space',
    /** A mouse button, numbered from 1 (`{n}` = 4 is the back button). */
    mouse: 'Mouse {n}',
    /** `{key}` is Shift, Ctrl, Alt or Meta. */
    left: 'Left {key}',
    right: 'Right {key}',
  },
  /** `voice:kicked` notices (CONTRACTS B.7b rule 4). */
  kicked: {
    admin: 'You were disconnected from voice by an admin.',
    channelDeleted: 'This voice channel was deleted.',
  },
} as const;
