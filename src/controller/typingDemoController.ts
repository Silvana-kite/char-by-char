import * as path from "path";
import * as vscode from "vscode";
import {
  COMMANDS,
  CONFIG_KEYS,
  CONTEXT_KEYS,
  EXTENSION_CONFIGURATION_SECTION,
  PAUSE_POLL_INTERVAL_MS,
  STATUS_BAR_NAME,
  STATUS_BAR_PRIORITY,
  STATUS_MESSAGE_TIMEOUT_MS,
} from "../constants";
import {
  InsertAction,
  SessionMode,
  SessionState,
  TypingAction,
  TypingSession,
} from "../types";
import {
  getStoredTextLength,
  isDocumentWritable,
  restoreInsertionCursor,
} from "../utils/document";
import {
  formatTextForLanguage,
  ResolvedSourceText,
  resolveDocumentLanguageId,
  tryFormatDocument,
  tryFormatOnType,
  tryResolveFormattedSourceText,
} from "../utils/formatting";
import { buildPlaybackSteps } from "../utils/playback";
import { findMarkerMatch, parseMarkerSections } from "../utils/script";
import {
  normalizeSourceText,
  reindentMultilineText,
  sleep,
} from "../utils/text";

interface PlaybackPlan {
  mode: SessionMode;
  actions: TypingAction[];
  wasFormatted: boolean;
}

export class TypingDemoController {
  private session: TypingSession | null = null;
  private readonly statusBarItem: vscode.StatusBarItem;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      STATUS_BAR_PRIORITY,
    );
    this.statusBarItem.name = STATUS_BAR_NAME;

    this.context.subscriptions.push(this.statusBarItem);
    this.registerCommands();
    this.registerEditorWatchers();
    void this.syncUiState();
  }

  private registerCommands(): void {
    this.context.subscriptions.push(
      vscode.commands.registerCommand(COMMANDS.START, () => this.startDemo()),
      vscode.commands.registerCommand(COMMANDS.CLEAR, () =>
        this.clearActiveEditor(),
      ),
      vscode.commands.registerCommand(COMMANDS.PAUSE, () => this.pauseDemo()),
      vscode.commands.registerCommand(COMMANDS.RESUME, () => this.resumeDemo()),
      vscode.commands.registerCommand(COMMANDS.CANCEL, () => this.cancelDemo()),
    );
  }

  private registerEditorWatchers(): void {
    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(
        (editor: vscode.TextEditor | undefined) => {
          if (
            this.session
            && this.session.state === "running"
            && (!editor || !this.isTargetEditor(editor, this.session.targetUri))
          ) {
            void this.pauseSession(
              "Target editor lost focus. Playback paused automatically.",
            );
          }

          this.updateStatusBar();
        },
      ),
      vscode.workspace.onDidCloseTextDocument((document: vscode.TextDocument) => {
        if (
          !this.session
          || document.uri.toString() !== this.session.targetUri
        ) {
          return;
        }

        void this.finishSession(
          this.session,
          "cancelled",
          "Target editor was closed. Playback stopped.",
        );
      }),
    );
  }

  private async startDemo(): Promise<void> {
    if (this.session) {
      const restartChoice = await vscode.window.showWarningMessage(
        "A playback session is already running. Restart it?",
        "Restart",
        "Keep current session",
      );

      if (restartChoice !== "Restart") {
        return;
      }

      await this.finishSession(
        this.session,
        "cancelled",
        "Cancelled the current playback session.",
      );
    }

    const targetEditor = this.getWritableActiveEditor(true);
    if (!targetEditor) {
      return;
    }

    const sourceDocument = await this.pickSourceDocument();
    if (!sourceDocument) {
      return;
    }

    const configuration = this.getConfiguration();
    const playbackPlan = await this.resolvePlaybackPlan(
      sourceDocument,
      targetEditor,
      configuration,
    );
    if (!playbackPlan) {
      return;
    }

    const delayMs = await this.promptDelayMs();
    if (delayMs === null) {
      return;
    }

    const preparedEditor = playbackPlan.mode === "marker-script"
      ? this.prepareEditorForMarkerScript(targetEditor)
      : await this.prepareTargetEditor(targetEditor);
    if (!preparedEditor) {
      return;
    }

    const cursor = preparedEditor.selection.active;
    const session: TypingSession = {
      id: Date.now().toString(36),
      mode: playbackPlan.mode,
      state: "running",
      sourceLabel: path.basename(sourceDocument.uri.fsPath),
      targetUri: preparedEditor.document.uri.toString(),
      targetViewColumn: preparedEditor.viewColumn,
      delayMs,
      actions: playbackPlan.actions,
      actionIndex: 0,
      stepIndex: 0,
      expectedOffset: preparedEditor.document.offsetAt(cursor),
      formatOnType: configuration.get(CONFIG_KEYS.FORMAT_ON_TYPE, false)
        && !playbackPlan.wasFormatted,
      formatAfterFinish: configuration.get(
        CONFIG_KEYS.FORMAT_AFTER_FINISH,
        true,
      ),
      totalSteps: playbackPlan.actions.reduce((count, action) => {
        return count + (action.kind === "save" ? 1 : action.estimatedStepCount);
      }, 0),
      completedSteps: 0,
    };

    this.session = session;
    await this.syncUiState();
    this.flashStatusMessage(this.getStartStatusMessage(session, playbackPlan));

    void this.runSession(session);
  }

  private async resolvePlaybackPlan(
    sourceDocument: vscode.TextDocument,
    targetEditor: vscode.TextEditor,
    configuration: vscode.WorkspaceConfiguration,
  ): Promise<PlaybackPlan | null> {
    const rawSourceText = normalizeSourceText(sourceDocument.getText());
    const markerSections = parseMarkerSections(rawSourceText);

    if (markerSections) {
      const matchingSections = markerSections.filter((section) =>
        Boolean(findMarkerMatch(targetEditor.document, section.marker))
      );

      if (matchingSections.length > 0) {
        const missingMarkers = markerSections
          .filter((section) => !findMarkerMatch(targetEditor.document, section.marker))
          .map((section) => section.marker);

        if (missingMarkers.length > 0) {
          vscode.window.showErrorMessage(
            `Target editor is missing markers: ${missingMarkers.join(", ")}`,
          );
          return null;
        }

        let anySectionFormatted = false;
        const actions = markerSections.map((section) => {
          const normalizedSectionText = normalizeSourceText(section.text);
          if (normalizedSectionText.trim().length === 0) {
            return {
              kind: "save",
              label: section.marker,
              marker: section.marker,
            } as const;
          }

          const resolvedSection = this.resolveMarkerSourceText(
            normalizedSectionText,
            targetEditor,
            configuration,
          );
          anySectionFormatted = anySectionFormatted || resolvedSection.wasFormatted;
          const estimatedSteps = buildPlaybackSteps(
            resolvedSection.text,
            targetEditor.document.languageId,
          );

          return {
            kind: "insert",
            label: section.marker,
            target: {
              kind: "marker",
              marker: section.marker,
            },
            sourceText: resolvedSection.text,
            steps: [],
            prepared: false,
            estimatedStepCount: estimatedSteps.length,
          } as InsertAction;
        });

        return {
          mode: "marker-script",
          actions,
          wasFormatted: anySectionFormatted,
        };
      }
    }

    const sourceText = await this.resolveSourceText(
      sourceDocument,
      configuration,
    );
    const normalizedText = normalizeSourceText(sourceText.text);
    const steps = buildPlaybackSteps(
      normalizedText,
      resolveDocumentLanguageId(sourceDocument),
    );

    if (steps.length === 0) {
      vscode.window.showWarningMessage("The selected source file is empty.");
      return null;
    }

    return {
      mode: "full-document",
      actions: [
        {
          kind: "insert",
          label: path.basename(sourceDocument.uri.fsPath),
          target: { kind: "cursor" },
          sourceText: normalizedText,
          steps,
          prepared: true,
          estimatedStepCount: steps.length,
        },
      ],
      wasFormatted: sourceText.wasFormatted,
    };
  }

  private getStartStatusMessage(
    session: TypingSession,
    playbackPlan: PlaybackPlan,
  ): string {
    if (session.mode === "marker-script") {
      return `Started marker playback: ${session.sourceLabel}`;
    }

    return playbackPlan.wasFormatted
      ? `Started playback with structured formatting: ${session.sourceLabel}`
      : `Started playback: ${session.sourceLabel}`;
  }

  private resolveMarkerSourceText(
    rawText: string,
    targetEditor: vscode.TextEditor,
    configuration: vscode.WorkspaceConfiguration,
  ): ResolvedSourceText {
    const normalizedText = normalizeSourceText(rawText);
    const shouldFormatSource = configuration.get(
      CONFIG_KEYS.FORMAT_SOURCE_BEFORE_TYPING,
      true,
    );

    if (!shouldFormatSource) {
      return {
        text: normalizedText,
        wasFormatted: false,
      };
    }

    const formattedText = formatTextForLanguage(
      normalizedText,
      targetEditor.document.languageId,
      this.getIndentUnitForEditor(targetEditor),
    );

    if (formattedText === null || formattedText === normalizedText) {
      return {
        text: normalizedText,
        wasFormatted: false,
      };
    }

    return {
      text: formattedText,
      wasFormatted: true,
    };
  }

  private async resolveSourceText(
    sourceDocument: vscode.TextDocument,
    configuration: vscode.WorkspaceConfiguration,
  ): Promise<ResolvedSourceText> {
    const rawText = sourceDocument.getText();
    const shouldFormatSource = configuration.get(
      CONFIG_KEYS.FORMAT_SOURCE_BEFORE_TYPING,
      true,
    );

    if (!shouldFormatSource) {
      return {
        text: rawText,
        wasFormatted: false,
      };
    }

    const formattedSource = await tryResolveFormattedSourceText(sourceDocument);
    if (!formattedSource.wasFormatted) {
      return {
        text: rawText,
        wasFormatted: false,
      };
    }

    return formattedSource;
  }

  private async clearActiveEditor(): Promise<void> {
    const editor = this.getWritableActiveEditor(true);
    if (!editor) {
      return;
    }

    if (this.session && this.isTargetEditor(editor, this.session.targetUri)) {
      await this.finishSession(
        this.session,
        "cancelled",
        "Cancelled the current playback session.",
      );
    }

    await this.clearEditorText(editor);
  }

  private async pauseDemo(): Promise<void> {
    if (!this.session || this.session.state !== "running") {
      this.flashStatusMessage("No playback session is running.");
      return;
    }

    await this.pauseSession("Playback paused.");
  }

  private async resumeDemo(): Promise<void> {
    if (!this.session || this.session.state !== "paused") {
      this.flashStatusMessage("No paused playback session was found.");
      return;
    }

    const editor = await this.restoreTargetEditor(this.session);
    if (!editor) {
      vscode.window.showErrorMessage(
        "Could not restore the target editor for playback.",
      );
      return;
    }

    restoreInsertionCursor(editor, this.session.expectedOffset);
    this.session.state = "running";
    await this.syncUiState();
    this.flashStatusMessage("Playback resumed.");
  }

  private async cancelDemo(): Promise<void> {
    if (!this.session) {
      this.flashStatusMessage("No playback session to cancel.");
      return;
    }

    await this.finishSession(this.session, "cancelled", "Playback cancelled.");
  }

  private async runSession(session: TypingSession): Promise<void> {
    try {
      while (
        this.isCurrentSession(session)
        && session.actionIndex < session.actions.length
      ) {
        if (session.state === "paused") {
          const resumed = await this.waitWhilePaused(session);
          if (!resumed) {
            return;
          }

          continue;
        }

        const activeEditor = vscode.window.activeTextEditor;
        if (
          !activeEditor
          || !this.isTargetEditor(activeEditor, session.targetUri)
        ) {
          await this.pauseSession(
            "Target editor lost focus. Playback paused automatically.",
          );
          continue;
        }

        const action = session.actions[session.actionIndex];
        await this.runActionStep(activeEditor, session, action);
        this.updateStatusBar();

        if (session.actionIndex >= session.actions.length) {
          break;
        }

        const shouldContinue = await this.waitWithPause(session, session.delayMs);
        if (!shouldContinue) {
          return;
        }
      }

      if (!this.isCurrentSession(session)) {
        return;
      }

      await this.finishSession(
        session,
        "completed",
        `Playback finished after ${session.completedSteps} steps.`,
      );
    } catch (error) {
      if (!this.isCurrentSession(session)) {
        return;
      }

      const message = error instanceof Error ? error.message : "Unknown error";
      await this.finishSession(session, "cancelled", "Playback interrupted.");
      vscode.window.showErrorMessage(`Playback failed: ${message}`);
    }
  }

  private async runActionStep(
    editor: vscode.TextEditor,
    session: TypingSession,
    action: TypingAction,
  ): Promise<void> {
    if (action.kind === "save") {
      session.expectedOffset = await this.performSaveAction(editor, action.marker);
      session.completedSteps += 1;
      session.actionIndex += 1;
      return;
    }

    await this.prepareInsertAction(editor, session, action);
    restoreInsertionCursor(editor, session.expectedOffset);

    const step = action.steps[session.stepIndex];
    session.expectedOffset = await this.insertStep(
      editor,
      step,
      session.formatOnType,
    );
    session.stepIndex += 1;
    session.completedSteps += 1;

    if (session.stepIndex >= action.steps.length) {
      session.stepIndex = 0;
      session.actionIndex += 1;
    }
  }

  private async prepareInsertAction(
    editor: vscode.TextEditor,
    session: TypingSession,
    action: InsertAction,
  ): Promise<void> {
    if (session.stepIndex > 0 || action.prepared) {
      return;
    }

    if (action.target.kind === "cursor") {
      session.expectedOffset = editor.document.offsetAt(editor.selection.active);
      action.prepared = true;
      return;
    }

    const markerMatch = findMarkerMatch(editor.document, action.target.marker);
    if (!markerMatch) {
      throw new Error(`Marker not found: ${action.target.marker}`);
    }

    const preparedSourceText = reindentMultilineText(
      action.sourceText,
      markerMatch.baseIndent,
    );
    const preparedSteps = buildPlaybackSteps(
      preparedSourceText,
      editor.document.languageId,
    );
    const stepDelta = preparedSteps.length - action.estimatedStepCount;

    if (stepDelta !== 0) {
      session.totalSteps += stepDelta;
      action.estimatedStepCount = preparedSteps.length;
    }

    action.steps = preparedSteps;
    action.prepared = true;

    const selection = new vscode.Selection(
      markerMatch.range.start,
      markerMatch.range.end,
    );
    editor.selections = [selection];
    editor.selection = selection;
    editor.revealRange(
      markerMatch.range,
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
    session.expectedOffset = editor.document.offsetAt(markerMatch.range.start);
  }

  private async performSaveAction(
    editor: vscode.TextEditor,
    marker: string,
  ): Promise<number> {
    const markerMatch = findMarkerMatch(editor.document, marker);
    if (!markerMatch) {
      throw new Error(`Save marker not found: ${marker}`);
    }

    const nextOffset = await this.replaceRange(editor, markerMatch.range, "");
    const saved = await editor.document.save();
    if (!saved) {
      throw new Error(`Failed to save document: ${editor.document.fileName}`);
    }

    return nextOffset;
  }

  private async pauseSession(statusMessage: string): Promise<void> {
    if (!this.session || this.session.state !== "running") {
      return;
    }

    this.session.state = "paused";
    await this.syncUiState();
    this.flashStatusMessage(statusMessage);
  }

  private async finishSession(
    session: TypingSession,
    finalState: SessionState,
    statusMessage?: string,
  ): Promise<void> {
    if (!this.isCurrentSession(session)) {
      return;
    }

    session.state = finalState;
    await this.syncUiState();

    if (finalState === "completed" && session.formatAfterFinish) {
      await this.formatCompletedDocument(session);
    }

    this.session = null;
    await this.syncUiState();

    if (statusMessage) {
      this.flashStatusMessage(statusMessage);
    }
  }

  private async formatCompletedDocument(session: TypingSession): Promise<void> {
    const editor = await this.restoreTargetEditor(session);
    if (!editor) {
      return;
    }

    await tryFormatDocument(editor);
  }

  private prepareEditorForMarkerScript(
    editor: vscode.TextEditor,
  ): vscode.TextEditor {
    const cursor = editor.selection.active;
    const singleSelection = new vscode.Selection(cursor, cursor);
    editor.selections = [singleSelection];
    editor.selection = singleSelection;
    return editor;
  }

  private async prepareTargetEditor(
    editor: vscode.TextEditor,
  ): Promise<vscode.TextEditor | null> {
    const cursor = editor.selection.active;
    const singleSelection = new vscode.Selection(cursor, cursor);

    editor.selections = [singleSelection];
    editor.selection = singleSelection;

    if (editor.document.getText().length === 0) {
      return editor;
    }

    const clearBeforeStart = this.getConfiguration().get(
      CONFIG_KEYS.CLEAR_BEFORE_START,
      true,
    );
    if (clearBeforeStart) {
      const cleared = await this.clearEditorText(editor);
      return cleared ? editor : null;
    }

    const choice = await vscode.window.showWarningMessage(
      "The active editor already has content. Clear it before playback?",
      "Clear and start",
      "Append at cursor",
      "Cancel",
    );

    if (choice === "Clear and start") {
      const cleared = await this.clearEditorText(editor);
      return cleared ? editor : null;
    }

    if (choice === "Append at cursor") {
      return editor;
    }

    return null;
  }

  private async clearEditorText(editor: vscode.TextEditor): Promise<boolean> {
    const document = editor.document;
    const fullTextLength = document.getText().length;

    if (fullTextLength === 0) {
      restoreInsertionCursor(editor, 0);
      return true;
    }

    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      document.positionAt(fullTextLength),
    );
    const cleared = await editor.edit(
      (editBuilder: vscode.TextEditorEdit) => {
        editBuilder.delete(fullRange);
      },
      {
        undoStopBefore: true,
        undoStopAfter: true,
      },
    );

    if (!cleared) {
      vscode.window.showErrorMessage("Failed to clear the active editor.");
      return false;
    }

    restoreInsertionCursor(editor, 0);
    return true;
  }

  private async pickSourceDocument(): Promise<vscode.TextDocument | null> {
    const selectedUris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "Pick a source file for playback",
    });

    if (!selectedUris || selectedUris.length === 0) {
      return null;
    }

    try {
      return await vscode.workspace.openTextDocument(selectedUris[0]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      vscode.window.showErrorMessage(`Failed to read source file: ${message}`);
      return null;
    }
  }

  private async promptDelayMs(): Promise<number | null> {
    const defaultDelayMs = this.getConfiguration().get(
      CONFIG_KEYS.DEFAULT_DELAY_MS,
      120,
    );
    const value = await vscode.window.showInputBox({
      prompt: "Delay between playback steps, in milliseconds (50-500).",
      placeHolder: "For example: 120",
      value: String(defaultDelayMs),
      validateInput: (input: string) => {
        const parsed = Number.parseInt(input, 10);

        if (!Number.isFinite(parsed) || parsed < 50 || parsed > 500) {
          return "Enter an integer between 50 and 500.";
        }

        return null;
      },
    });

    if (typeof value !== "string") {
      return null;
    }

    return Number.parseInt(value, 10);
  }

  private getWritableActiveEditor(
    showErrorMessage: boolean,
  ): vscode.TextEditor | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      if (showErrorMessage) {
        vscode.window.showErrorMessage("Open a writable text editor first.");
      }

      return null;
    }

    if (!isDocumentWritable(editor.document)) {
      if (showErrorMessage) {
        vscode.window.showErrorMessage(
          "The active editor is read-only and cannot be used for playback.",
        );
      }

      return null;
    }

    return editor;
  }

  private async restoreTargetEditor(
    session: TypingSession,
  ): Promise<vscode.TextEditor | null> {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && this.isTargetEditor(activeEditor, session.targetUri)) {
      return activeEditor;
    }

    const visibleEditor = vscode.window.visibleTextEditors.find(
      (editor: vscode.TextEditor) =>
        this.isTargetEditor(editor, session.targetUri),
    );
    if (visibleEditor) {
      return vscode.window.showTextDocument(visibleEditor.document, {
        viewColumn: visibleEditor.viewColumn,
        preserveFocus: false,
        preview: false,
      });
    }

    try {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.parse(session.targetUri),
      );
      if (!isDocumentWritable(document)) {
        return null;
      }

      return vscode.window.showTextDocument(document, {
        viewColumn: session.targetViewColumn,
        preserveFocus: false,
        preview: false,
      });
    } catch {
      return null;
    }
  }

  private async insertStep(
    editor: vscode.TextEditor,
    step: string,
    formatOnType: boolean,
  ): Promise<number> {
    const nextOffset = await this.insertTextExactly(editor, step);
    if (!formatOnType) {
      return nextOffset;
    }

    const formattedOffset = await tryFormatOnType(editor, step);
    return typeof formattedOffset === "number" ? formattedOffset : nextOffset;
  }

  private async insertTextExactly(
    editor: vscode.TextEditor,
    text: string,
  ): Promise<number> {
    const insertStart = editor.selection.start;
    const insertRange = editor.selection.isEmpty
      ? null
      : new vscode.Range(editor.selection.start, editor.selection.end);
    const applied = await editor.edit(
      (editBuilder: vscode.TextEditorEdit) => {
        if (insertRange) {
          editBuilder.replace(insertRange, text);
          return;
        }

        editBuilder.insert(insertStart, text);
      },
      {
        undoStopBefore: false,
        undoStopAfter: false,
      },
    );

    if (!applied) {
      throw new Error("The editor rejected the text insertion request.");
    }

    const nextOffset =
      editor.document.offsetAt(insertStart)
      + getStoredTextLength(editor.document, text);
    restoreInsertionCursor(editor, nextOffset);
    return nextOffset;
  }

  private async replaceRange(
    editor: vscode.TextEditor,
    range: vscode.Range,
    text: string,
  ): Promise<number> {
    const start = range.start;
    const applied = await editor.edit(
      (editBuilder: vscode.TextEditorEdit) => {
        editBuilder.replace(range, text);
      },
      {
        undoStopBefore: false,
        undoStopAfter: false,
      },
    );

    if (!applied) {
      throw new Error("The editor rejected the replace request.");
    }

    const nextOffset =
      editor.document.offsetAt(start)
      + getStoredTextLength(editor.document, text);
    restoreInsertionCursor(editor, nextOffset);
    return nextOffset;
  }

  private async waitWhilePaused(session: TypingSession): Promise<boolean> {
    while (this.isCurrentSession(session) && session.state === "paused") {
      await sleep(PAUSE_POLL_INTERVAL_MS);
    }

    return this.isCurrentSession(session) && session.state === "running";
  }

  private async waitWithPause(
    session: TypingSession,
    totalDelayMs: number,
  ): Promise<boolean> {
    let remainingMs = totalDelayMs;

    while (remainingMs > 0) {
      if (!this.isCurrentSession(session)) {
        return false;
      }

      if (session.state === "paused") {
        const resumed = await this.waitWhilePaused(session);
        if (!resumed) {
          return false;
        }

        continue;
      }

      const currentSliceMs = Math.min(remainingMs, PAUSE_POLL_INTERVAL_MS);
      const startTime = Date.now();
      await sleep(currentSliceMs);
      remainingMs -= Date.now() - startTime;
    }

    return this.isCurrentSession(session);
  }

  private isCurrentSession(session: TypingSession): boolean {
    return this.session !== null && this.session.id === session.id;
  }

  private isTargetEditor(
    editor: vscode.TextEditor,
    targetUri: string,
  ): boolean {
    return editor.document.uri.toString() === targetUri;
  }

  private getConfiguration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(EXTENSION_CONFIGURATION_SECTION);
  }

  private getIndentUnitForEditor(editor: vscode.TextEditor): string {
    const tabSize = typeof editor.options.tabSize === "number"
      ? editor.options.tabSize
      : 2;

    if (editor.options.insertSpaces === false) {
      return "\t";
    }

    return " ".repeat(tabSize > 0 ? tabSize : 2);
  }

  private async syncUiState(): Promise<void> {
    const isRunning = Boolean(this.session && this.session.state === "running");
    const isPaused = Boolean(this.session && this.session.state === "paused");

    await Promise.all([
      vscode.commands.executeCommand(
        "setContext",
        CONTEXT_KEYS.IS_RUNNING,
        isRunning,
      ),
      vscode.commands.executeCommand(
        "setContext",
        CONTEXT_KEYS.IS_PAUSED,
        isPaused,
      ),
    ]);

    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    if (!this.session) {
      this.statusBarItem.text = "$(keyboard) char-by-char";
      this.statusBarItem.tooltip =
        "Play structured HTML/CSS/JS edits into the active editor.";
      this.statusBarItem.command = COMMANDS.START;
      this.statusBarItem.show();
      return;
    }

    const progressText = `${this.session.completedSteps}/${this.session.totalSteps}`;
    const modeText = this.session.mode === "marker-script"
      ? "marker mode"
      : "full document";
    const details =
      `${this.session.sourceLabel} | ${this.session.delayMs}ms/step | ${modeText}`;

    if (this.session.state === "running") {
      this.statusBarItem.text = `$(debug-pause) Playing ${progressText}`;
      this.statusBarItem.tooltip = `Click to pause\n${details}`;
      this.statusBarItem.command = COMMANDS.PAUSE;
      this.statusBarItem.show();
      return;
    }

    if (this.session.state === "paused") {
      this.statusBarItem.text = `$(play) Resume ${progressText}`;
      this.statusBarItem.tooltip = `Click to resume\n${details}`;
      this.statusBarItem.command = COMMANDS.RESUME;
      this.statusBarItem.show();
      return;
    }

    this.statusBarItem.hide();
  }

  private flashStatusMessage(message: string): void {
    vscode.window.setStatusBarMessage(message, STATUS_MESSAGE_TIMEOUT_MS);
  }

  public async dispose(): Promise<void> {
    if (this.session) {
      await this.finishSession(this.session, "cancelled");
    }

    this.statusBarItem.dispose();
  }
}
