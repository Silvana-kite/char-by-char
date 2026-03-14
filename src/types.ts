import * as vscode from "vscode";

export type SessionState = "running" | "paused" | "completed" | "cancelled";
export type SessionMode = "full-document" | "marker-script";

export type InsertionTarget =
  | { kind: "cursor" }
  | { kind: "marker"; marker: string };

export interface InsertAction {
  kind: "insert";
  label: string;
  target: InsertionTarget;
  sourceText: string;
  steps: string[];
  prepared: boolean;
  estimatedStepCount: number;
}

export interface SaveAction {
  kind: "save";
  label: string;
  marker: string;
}

export type TypingAction = InsertAction | SaveAction;

export interface TypingSession {
  id: string;
  mode: SessionMode;
  state: SessionState;
  sourceLabel: string;
  targetUri: string;
  targetViewColumn: vscode.ViewColumn | undefined;
  delayMs: number;
  actions: TypingAction[];
  actionIndex: number;
  stepIndex: number;
  expectedOffset: number;
  formatOnType: boolean;
  formatAfterFinish: boolean;
  totalSteps: number;
  completedSteps: number;
}
