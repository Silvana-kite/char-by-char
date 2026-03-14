import * as assert from "assert";
import * as vscode from "vscode";
import { getStoredTextLength } from "../utils/document";
import {
  applyTextEditsToContent,
  choosePreferredFormattedTextForTest,
  formatCssText,
  formatHtmlText,
  formatJavaScriptText,
  formatTextForLanguage,
  shouldAttemptOnTypeFormatting,
  translateOffsetThroughEdits,
} from "../utils/formatting";
import { buildPlaybackSteps } from "../utils/playback";
import { findMarkerMatch, parseMarkerSections } from "../utils/script";
import {
  normalizeSourceText,
  reindentMultilineText,
  splitIntoSegments,
} from "../utils/text";

suite("Extension Test Suite", () => {
  test("normalizeSourceText converts CRLF and CR into LF", () => {
    assert.strictEqual(
      normalizeSourceText("line1\r\nline2\rline3\nline4"),
      "line1\nline2\nline3\nline4",
    );
  });

  test("splitIntoSegments keeps grapheme clusters intact", () => {
    assert.deepStrictEqual(splitIntoSegments(`Ae\u0301B`), ["A", `e\u0301`, "B"]);
  });

  test("reindentMultilineText rebases multiline code to the marker indent", () => {
    const source = [
      "<div>",
      "  <span>demo</span>",
      "</div>",
    ].join("\n");

    assert.strictEqual(
      reindentMultilineText(source, "    "),
      [
        "    <div>",
        "      <span>demo</span>",
        "    </div>",
      ].join("\n"),
    );
  });

  test("parseMarkerSections parses marker blocks and empty save blocks", () => {
    const sections = parseMarkerSections([
      "#title",
      "<h1>demo</h1>",
      "#save",
      "",
      "#body",
      "<p>content</p>",
    ].join("\n"));

    assert.deepStrictEqual(sections, [
      {
        marker: "title",
        text: "<h1>demo</h1>",
      },
      {
        marker: "save",
        text: "",
      },
      {
        marker: "body",
        text: "<p>content</p>",
      },
    ]);
  });

  test("findMarkerMatch expands a whole-line placeholder to the full line", async () => {
    const document = await vscode.workspace.openTextDocument({
      language: "javascript",
      content: [
        "function demo() {",
        "  //title//",
        "}",
      ].join("\n"),
    });

    const match = findMarkerMatch(document, "title");
    assert.ok(match);
    assert.strictEqual(match?.baseIndent, "  ");
    assert.strictEqual(document.getText(match!.range), "  //title//\n");
  });

  test("findMarkerMatch resolves html comment placeholders", async () => {
    const document = await vscode.workspace.openTextDocument({
      language: "html",
      content: "<body><!-- body --></body>",
    });

    const match = findMarkerMatch(document, "body");
    assert.ok(match);
    assert.strictEqual(document.getText(match!.range), "<!-- body -->");
  });

  test("shouldAttemptOnTypeFormatting only triggers on structural characters", () => {
    assert.strictEqual(shouldAttemptOnTypeFormatting("\n"), true);
    assert.strictEqual(shouldAttemptOnTypeFormatting("}"), true);
    assert.strictEqual(shouldAttemptOnTypeFormatting(">"), true);
    assert.strictEqual(shouldAttemptOnTypeFormatting("a"), false);
  });

  test("formatHtmlText expands a minified html document into multiple lines", () => {
    const source =
      '<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>Demo</title></head><body><div class="loader"><span></span></div></body></html>';

    const formatted = formatHtmlText(source, "  ");

    assert.strictEqual(
      formatted,
      [
        "<!doctype html>",
        '<html lang="en">',
        "  <head>",
        '    <meta charset="UTF-8" />',
        "    <title>",
        "      Demo",
        "    </title>",
        "  </head>",
        "  <body>",
        '    <div class="loader">',
        "      <span>",
        "      </span>",
        "    </div>",
        "  </body>",
        "</html>",
      ].join("\n"),
    );
  });

  test("formatJavaScriptText expands minified javascript into readable lines", () => {
    const source =
      'const toggle = document.getElementById("coffeeToggle");const wrap = document.querySelector(".toggle-wrap");function createSmoke(){const rect = toggle.getBoundingClientRect();return rect.width;}';

    const formatted = formatJavaScriptText(source, "  ");

    assert.strictEqual(
      formatted,
      [
        'const toggle = document.getElementById("coffeeToggle");',
        'const wrap = document.querySelector(".toggle-wrap");',
        "function createSmoke() {",
        "  const rect = toggle.getBoundingClientRect();",
        "  return rect.width;",
        "}",
      ].join("\n"),
    );
  });

  test("formatCssText expands minified css into readable rules", () => {
    const source =
      ".card{display:flex;gap:12px;}.card .title{font-size:14px;color:#222;}";

    const formatted = formatCssText(source, "  ");

    assert.strictEqual(
      formatted,
      [
        ".card {",
        "  display: flex;",
        "  gap: 12px;",
        "}",
        ".card .title {",
        "  font-size: 14px;",
        "  color: #222;",
        "}",
      ].join("\n"),
    );
  });

  test("formatTextForLanguage applies css fallback formatting", () => {
    assert.strictEqual(
      formatTextForLanguage(".a{color:red;}", "css", "  "),
      [
        ".a {",
        "  color: red;",
        "}",
      ].join("\n"),
    );
  });

  test("structured languages prefer the more expanded formatted result", () => {
    assert.strictEqual(
      choosePreferredFormattedTextForTest(
        "css",
        ".a{color:red;}",
        ".a { color: red; }",
        [
          ".a {",
          "  color: red;",
          "}",
        ].join("\n"),
      ),
      [
        ".a {",
        "  color: red;",
        "}",
      ].join("\n"),
    );
  });

  test("buildPlaybackSteps keeps indentation and newlines as explicit steps", () => {
    const steps = buildPlaybackSteps(
      [
        "function demo() {",
        "  return 1;",
        "}",
      ].join("\n"),
      "javascript",
    );

    assert.strictEqual(steps[0], "f");
    assert.ok(steps.includes("\n"));
    assert.ok(steps.includes("  "));
  });

  test("buildPlaybackSteps keeps newline steps for the provided html sample", () => {
    const source = [
      "<!DOCTYPE html>",
      '<html lang="en">',
      "<head>",
      '    <meta charset="UTF-8">',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      "    <title>css3d加载旋转器</title>",
      '    <link rel="stylesheet" href="./style.css">',
      "</head>",
      "<body>",
      '    <div class="loader">',
      '        <div class="circle"><span></span></div>',
      "    </div>",
      "</body>",
      "</html>",
    ].join("\n");

    const steps = buildPlaybackSteps(source, "html");
    const reconstructed = steps.join("");

    assert.strictEqual(reconstructed, source);
    assert.ok(steps.includes("\n"));
    assert.ok(steps.includes("    "));
    assert.ok(steps.includes("        "));
  });

  test("incremental insertion reproduces the provided html sample exactly", async () => {
    const source = [
      "<!DOCTYPE html>",
      '<html lang="en">',
      "<head>",
      '    <meta charset="UTF-8">',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      "    <title>css3d加载旋转器</title>",
      '    <link rel="stylesheet" href="./style.css">',
      "</head>",
      "<body>",
      '    <div class="loader">',
      '        <div class="circle"><span></span></div>',
      "    </div>",
      "</body>",
      "</html>",
    ].join("\n");
    const document = await vscode.workspace.openTextDocument({
      language: "html",
      content: "",
    });
    const editor = await vscode.window.showTextDocument(document);
    const steps = buildPlaybackSteps(source, "html");

    for (const step of steps) {
      const position = editor.selection.active;
      const applied = await editor.edit((editBuilder: vscode.TextEditorEdit) => {
        editBuilder.insert(position, step);
      });

      assert.strictEqual(applied, true);

      const nextOffset =
        editor.document.offsetAt(position)
        + getStoredTextLength(editor.document, step);
      const nextPosition = editor.document.positionAt(nextOffset);
      editor.selection = new vscode.Selection(nextPosition, nextPosition);
      editor.selections = [editor.selection];
    }

    assert.strictEqual(
      normalizeSourceText(editor.document.getText()),
      source,
    );
  });

  test("applyTextEditsToContent builds formatted source text in memory", async () => {
    const document = await vscode.workspace.openTextDocument({
      language: "html",
      content: "<div><span></span></div>",
    });
    const edits = [
      new vscode.TextEdit(
        new vscode.Range(
          new vscode.Position(0, 5),
          new vscode.Position(0, 18),
        ),
        "\n  <span></span>\n",
      ),
    ];

    const nextText = applyTextEditsToContent(document, edits);
    assert.strictEqual(nextText, "<div>\n  <span></span>\n</div>");
  });

  test("translateOffsetThroughEdits keeps cursor aligned after formatting edits", async () => {
    const document = await vscode.workspace.openTextDocument({
      language: "html",
      content: "<div><span></span></div>",
    });
    const edits = [
      new vscode.TextEdit(
        new vscode.Range(
          new vscode.Position(0, 5),
          new vscode.Position(0, 24),
        ),
        "\n  <span></span>\n",
      ),
    ];

    const nextOffset = translateOffsetThroughEdits(document, 24, edits);
    assert.strictEqual(nextOffset, 22);
  });
});
