/**
 * Shared TypeScript types and framing constants for engine ↔ frontend IPC.
 *
 * Transport: newline-delimited JSON over a Unix socket.
 *
 * Security note: `repoId` is only trusted in the initial `attach` message.
 * The frontend binds the repoId on attach and ignores any `repoId` field
 * in subsequent messages from that socket.
 */

import type { JobInfo } from "../tui/types.js";

// ---------------------------------------------------------------------------
// Engine → Frontend messages
// ---------------------------------------------------------------------------

/** LLM backend in use for chat and for claude-code job steps. */
export type ToolKind = "claude" | "gemini";

/** First message from the engine. Binds the repoId for this connection. */
export interface AttachMessage {
  type: "attach";
  repoId: string;
  repoPath: string;
  repoName: string;
  mcpSocket: string;
  /** Path to the PTY bridge socket, if this engine exposes a chat terminal. */
  ptyBridgePath?: string;
  /** Initial chat-tool for this engine's PTY. Absent when the engine has no chat. */
  chatTool?: ToolKind;
  /** Initial jobs-tool for this engine (SPARKFLOW_LLM). */
  jobTool?: ToolKind;
  /** Informational sparkflow package version (for display in error messages). */
  version: string;
  /** Wire-format version — must match the frontend's SPARKFLOW_PROTOCOL_VERSION. */
  protocolVersion: number;
}

/** Graceful disconnect — engine is going away cleanly. */
export interface DetachMessage {
  type: "detach";
}

/**
 * Positive acknowledgement from the frontend that an `attach` was accepted.
 * The engine uses this to distinguish a successful attach (followed by
 * silence) from a rejection (followed by an un-correlated error frame).
 * Without it, a post-attach protocol bug that produced an un-correlated
 * error would be indistinguishable from a rejection.
 */
export interface AttachAckMessage {
  type: "attachAck";
}

/** Full job state snapshot. The engine re-sends this on every state change. */
export interface JobSnapshotMessage {
  type: "jobSnapshot";
  jobs: JobInfo[];
}

export type EngineToFrontend =
  | AttachMessage
  | DetachMessage
  | JobSnapshotMessage
  | ResponseMessage
  | PongMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// Frontend → Engine messages (all have `id` for request/response correlation)
// ---------------------------------------------------------------------------

export interface StartWorkflowCommand {
  type: "startWorkflow";
  id: string;
  workflowPath: string;
  cwd?: string;
  plan?: string;
  planText?: string;
  slug?: string;
  description?: string;
}

export interface KillJobCommand {
  type: "killJob";
  id: string;
  jobId: string;
}

export interface RemoveJobCommand {
  type: "removeJob";
  id: string;
  jobId: string;
}

export interface AnswerRecoveryCommand {
  type: "answerRecovery";
  id: string;
  jobId: string;
  action: "retry" | "skip" | "abort";
  message?: string;
}

export interface GetJobDetailCommand {
  type: "getJobDetail";
  id: string;
  jobId: string;
}

export interface PingMessage {
  type: "ping";
  id: string;
}

/**
 * Switch the LLM backend used for subsequent claude-code job steps on this
 * engine. The chat PTY's tool is switched over the PTY bridge (via
 * `set_chat_tool`) — not through this IPC command.
 */
export interface SetJobToolCommand {
  type: "setJobTool";
  id: string;
  tool: ToolKind;
}

/**
 * Commands the frontend can issue to an engine. `AttachAckMessage` is a
 * protocol-level frame (handshake) the engine client filters internally,
 * so it is NOT part of this command union — engine-daemon's command
 * switch never sees it.
 */
export type FrontendToEngine =
  | StartWorkflowCommand
  | KillJobCommand
  | RemoveJobCommand
  | AnswerRecoveryCommand
  | GetJobDetailCommand
  | SetJobToolCommand
  | PingMessage;

// ---------------------------------------------------------------------------
// Response / error messages (engine → frontend, correlating a command by id)
// ---------------------------------------------------------------------------

export interface ResponseMessage {
  type: "response";
  id: string;
  payload: Record<string, unknown>;
}

/**
 * Error response. `id` correlates with a command id when the error is a
 * response to a specific request. Pre-attach errors (bad first message,
 * duplicate repoId, version mismatch) have no id.
 */
export interface ErrorMessage {
  type: "error";
  id?: string;
  error: string;
  code?: string;
  /** Populated on version_mismatch so the engine can render a useful message. */
  frontendVersion?: string;
  engineVersion?: string;
  /** Populated on version_mismatch for protocol mismatches. */
  frontendProtocolVersion?: number;
  engineProtocolVersion?: number;
}

export interface PongMessage {
  type: "pong";
  id: string;
}

// ---------------------------------------------------------------------------
// Shared repo info (used in HTTP /repos endpoint)
// ---------------------------------------------------------------------------

export interface RepoInfo {
  repoId: string;
  repoPath: string;
  repoName: string;
  mcpSocket: string;
  ptyBridgePath?: string;
  version: string;
  /** Current chat tool for this engine (if it owns a chat PTY). */
  chatTool?: ToolKind;
  /** Current jobs tool for this engine. */
  jobTool?: ToolKind;
}
