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
    /** Title of the dot that lights while our mic is really sending (push-to-talk or voice gate open). */
    transmitting: 'Transmitting',
    notTransmitting: 'Not transmitting',
  },
  /** The voice panel's quick menus (docs/plans/devices.md, "Voice panel"). */
  options: {
    audio: 'Audio options',
    video: 'Video options',
    inputDevice: 'Input device',
    outputDevice: 'Output device',
    camera: 'Camera',
    quality: 'Video quality',
    /** The system default device (always the first choice). */
    default: 'Default',
    /** A device whose name the browser hides until access is allowed; `{n}` counts from 1. */
    microphoneN: 'Microphone {n}',
    speakerN: 'Speaker {n}',
    cameraN: 'Camera {n}',
    /** The saved device while the browser lists no devices yet (no permission). */
    savedDevice: 'Saved device',
    /** The saved device is not plugged in (the default is used meanwhile). */
    missingDevice: 'Disconnected device',
    allowAccess: 'Allow access',
    settings: 'Voice & video settings',
  },
  /** Push-to-talk mode in the voice panel. */
  ptt: {
    button: 'Push to talk',
    /** `{key}` is a key or mouse button name (voice.keys). */
    hint: 'Hold {key} to talk',
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
