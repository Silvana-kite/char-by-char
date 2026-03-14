export const EXTENSION_CONFIGURATION_SECTION = "charByChar";

export const COMMANDS = {
  START: "char-by-char.startDemo",
  CLEAR: "char-by-char.clearActiveEditor",
  PAUSE: "char-by-char.pauseDemo",
  RESUME: "char-by-char.resumeDemo",
  CANCEL: "char-by-char.cancelDemo",
} as const;

export const CONTEXT_KEYS = {
  IS_RUNNING: "charByChar.isRunning",
  IS_PAUSED: "charByChar.isPaused",
} as const;

export const CONFIG_KEYS = {
  DEFAULT_DELAY_MS: "defaultDelayMs",
  CLEAR_BEFORE_START: "clearBeforeStart",
  FORMAT_SOURCE_BEFORE_TYPING: "formatSourceBeforeTyping",
  FORMAT_ON_TYPE: "formatOnType",
  FORMAT_AFTER_FINISH: "formatAfterFinish",
} as const;

export const STATUS_BAR_NAME = "char-by-char";
export const STATUS_BAR_PRIORITY = 1000;
export const STATUS_MESSAGE_TIMEOUT_MS = 3000;
export const PAUSE_POLL_INTERVAL_MS = 50;

export const ON_TYPE_FORMAT_TRIGGER_CHARACTERS = new Set([
  "\n",
  "}",
  "]",
  ")",
  ";",
  ">",
]);
