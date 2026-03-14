import * as vscode from "vscode";
import { normalizeSourceText } from "./text";

export interface MarkerSection {
  marker: string;
  text: string;
}

export interface MarkerMatch {
  marker: string;
  range: vscode.Range;
  baseIndent: string;
}

const MARKER_PATTERNS = [
  (escapedMarker: string) =>
    new RegExp(`\\{[ \\t]*//[ \\t]*${escapedMarker}[ \\t]*//[ \\t]*\\}`, "g"),
  (escapedMarker: string) =>
    new RegExp(`<!--[ \\t]*${escapedMarker}[ \\t]*-->`, "g"),
  (escapedMarker: string) =>
    new RegExp(`/\\*[ \\t]*${escapedMarker}[ \\t]*\\*/`, "g"),
  (escapedMarker: string) =>
    new RegExp(`//[ \\t]*${escapedMarker}[ \\t]*//`, "g"),
] as const;

export function parseMarkerSections(sourceText: string): MarkerSection[] | null {
  const normalizedText = normalizeSourceText(sourceText);
  const lines = normalizedText.split("\n");
  const sections: MarkerSection[] = [];

  let activeMarker: string | null = null;
  let activeLines: string[] = [];
  let sawHeader = false;

  for (const line of lines) {
    const header = line.match(/^#\s*(.+?)\s*$/);
    if (header) {
      if (activeMarker !== null) {
        sections.push({
          marker: activeMarker,
          text: activeLines.join("\n"),
        });
      }

      activeMarker = header[1];
      activeLines = [];
      sawHeader = true;
      continue;
    }

    if (activeMarker === null) {
      if (line.trim().length === 0) {
        continue;
      }

      return null;
    }

    activeLines.push(line);
  }

  if (!sawHeader || activeMarker === null) {
    return null;
  }

  sections.push({
    marker: activeMarker,
    text: activeLines.join("\n"),
  });

  return sections;
}

export function findMarkerMatch(
  document: vscode.TextDocument,
  marker: string,
): MarkerMatch | null {
  const escapedMarker = escapeForRegex(marker);
  const content = document.getText();

  for (const createPattern of MARKER_PATTERNS) {
    const match = createPattern(escapedMarker).exec(content);
    if (!match || typeof match.index !== "number") {
      continue;
    }

    const matchStart = document.positionAt(match.index);
    const matchEnd = document.positionAt(match.index + match[0].length);
    const lineStartOffset = content.lastIndexOf("\n", match.index - 1) + 1;
    const rawLineEndOffset = content.indexOf("\n", match.index + match[0].length);
    const lineEndOffset = rawLineEndOffset >= 0 ? rawLineEndOffset : content.length;
    const lineEndWithBreakOffset = rawLineEndOffset >= 0
      ? rawLineEndOffset + 1
      : lineEndOffset;
    const beforeText = content.slice(lineStartOffset, match.index).replace(/\r$/, "");
    const afterText = content
      .slice(match.index + match[0].length, lineEndOffset)
      .replace(/\r$/, "");

    if (beforeText.trim().length === 0 && afterText.trim().length === 0) {
      return {
        marker,
        range: new vscode.Range(
          document.positionAt(lineStartOffset),
          document.positionAt(lineEndWithBreakOffset),
        ),
        baseIndent: beforeText,
      };
    }

    return {
      marker,
      range: new vscode.Range(matchStart, matchEnd),
      baseIndent: "",
    };
  }

  return null;
}

function escapeForRegex(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
