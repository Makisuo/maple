// Code-split chunk boundary: everything behind this import (the shared replay
// engine, rrweb) is loaded only when replay is enabled + sampled.
export { startReplaySession } from "@maple/browser-session/replay"
