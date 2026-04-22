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

/** First message from the engine. Binds the repoId for this connection. */
export interface AttachMessage {
  type: "attach";
  repoId: string;
  repoPath: string;
  repoName: string;
  mcpSocket: string;
  /** Path to the PTY bridge socket, if this engine exposes a chat terminal. */
  ptyBridgePath?: string;
  version: string;
}

/** Graceful disconnect — engine is going away cleanly. */
export interface DetachMessage {
  type: "detach";
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

export type FrontendToEngine =
  | StartWorkflowCommand
  | KillJobCommand
  | RemoveJobCommand
  | AnswerRecoveryCommand
  | GetJobDetailCommand
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
}
