import * as vscode from "vscode";

export function isDocumentWritable(document: vscode.TextDocument): boolean {
  if (typeof vscode.workspace.fs.isWritableFileSystem !== "function") {
    return true;
  }

  const writable = vscode.workspace.fs.isWritableFileSystem(
    document.uri.scheme,
  );
  return writable !== false;
}

export function restoreInsertionCursor(
  editor: vscode.TextEditor,
  desiredOffset: number,
): void {
  const maxOffset = editor.document.getText().length;
  const safeOffset = Math.min(desiredOffset, maxOffset);
  const position = editor.document.positionAt(safeOffset);
  const selection = new vscode.Selection(position, position);

  // 无论经历过格式化还是直接插入，都强制恢复成单光标，避免后续输入错位。
  editor.selections = [selection];
  editor.selection = selection;
  editor.revealRange(
    new vscode.Range(position, position),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport,
  );
}

export function getStoredTextLength(
  document: vscode.TextDocument,
  text: string,
): number {
  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (document.eol === vscode.EndOfLine.CRLF) {
    return normalizedText.replace(/\n/g, "\r\n").length;
  }

  return normalizedText.length;
}
