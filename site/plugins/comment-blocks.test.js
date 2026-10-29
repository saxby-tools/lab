import assert from "node:assert/strict";
import { test } from "node:test";

import MarkdownIt from "markdown-it";

import commentBlocks, { CommentBlockError } from "./comment-blocks.js";

// ---- Constants --------------------------------------------------------

const TABLE = [
  "| Model | Score |",
  "| ----- | ----- |",
  "| Qwen  | 23/24 |",
  "| Gemma | 22/24 |",
].join("\n");

// ---- Helpers ----------------------------------------------------------

// Each component echoes what it received, so tests can read it back.
function recorder() {
  const calls = [];

  const echo = (block) => {
    calls.push(block);
    return `<div data-block="${block.name}">${block.html}</div>\n`;
  };

  return { calls, components: { chart: echo, list: echo, box: echo } };
}

function render(source, components, env = {}) {
  const md = new MarkdownIt({ html: true });

  md.use(commentBlocks, { namespace: "lab", components });

  return md.render(source, env);
}

// ---- Blocks -----------------------------------------------------------

test("a wrapping block gets its options, table and inner HTML", () => {
  const { calls, components } = recorder();
  const source = [
    '<!-- lab:chart {"value": "Score", "max": 24} -->',
    "",
    TABLE,
    "",
    "<!-- /lab:chart -->",
  ].join("\n");

  const html = render(source, components);
  const [block] = calls;

  assert.equal(calls.length, 1);
  assert.equal(block.name, "chart");
  assert.deepEqual(block.options, { value: "Score", max: 24 });
  assert.equal(block.line, 1);
  assert.deepEqual(block.table.columns, ["Model", "Score"]);
  assert.deepEqual(block.table.rows, [
    { Model: "Qwen", Score: "23/24" },
    { Model: "Gemma", Score: "22/24" },
  ]);
  assert.match(block.html, /<table>/);
  assert.match(html, /^<div data-block="chart"><table>/);
  assert.doesNotMatch(html, /lab:chart/);
});

test("tables also come rendered, for cells with code or links", () => {
  const { calls, components } = recorder();
  const source = [
    "<!-- lab:chart -->",
    "",
    "| Task | Why |",
    "| ---- | --- |",
    "| html | `<script>` got [through](a.md) |",
    "",
    "<!-- /lab:chart -->",
  ].join("\n");

  render(source, components);

  const [row] = calls[0].table.rows;
  const [htmlRow] = calls[0].table.htmlRows;

  assert.equal(row.Why, "`<script>` got [through](a.md)");
  assert.equal(
    htmlRow.Why,
    '<code>&lt;script&gt;</code> got <a href="a.md">through</a>',
  );
});

test("a table right after the comment, no blank line, still counts", () => {
  const { calls, components } = recorder();

  render(`<!-- lab:chart -->\n${TABLE}\n<!-- /lab:chart -->`, components);

  assert.deepEqual(calls[0].table.columns, ["Model", "Score"]);
});

test("a self-closing block has no content and no table", () => {
  const { calls, components } = recorder();

  render('<!-- lab:list {"limit": 3} /-->', components);

  assert.equal(calls[0].name, "list");
  assert.deepEqual(calls[0].options, { limit: 3 });
  assert.equal(calls[0].html, "");
  assert.equal(calls[0].table, null);
});

test("options may span lines, to keep long ones under 80 columns", () => {
  const { calls, components } = recorder();
  const source = [
    "<!-- lab:chart {",
    '  "value": "Score",',
    '  "title": "Runs"',
    "} -->",
    "",
    TABLE,
    "",
    "<!-- /lab:chart -->",
  ].join("\n");

  render(source, components);

  assert.deepEqual(calls[0].options, { value: "Score", title: "Runs" });
  assert.equal(calls[0].table.rows.length, 2);
});

test("options are optional", () => {
  const { calls, components } = recorder();

  render("<!-- lab:box -->\ntext\n<!-- /lab:box -->", components);

  assert.deepEqual(calls[0].options, {});
});

test("blocks nest, and the inner one renders first", () => {
  const { calls, components } = recorder();
  const source = [
    "<!-- lab:box -->",
    "<!-- lab:chart -->",
    TABLE,
    "<!-- /lab:chart -->",
    "<!-- /lab:box -->",
  ].join("\n");

  const html = render(source, components);

  assert.deepEqual(calls.map((call) => call.name), ["chart", "box"]);
  assert.match(html, /data-block="box"><div data-block="chart">/);
});

test("other comments and other namespaces pass through untouched", () => {
  const { calls, components } = recorder();
  const source = "<!-- a note -->\n\n<!-- wp:paragraph -->\n\nplain";

  const html = render(source, components);

  assert.equal(calls.length, 0);
  assert.match(html, /<!-- a note -->/);
  assert.match(html, /<!-- wp:paragraph -->/);
});

test("Markdown inside a block renders as Markdown", () => {
  const { calls, components } = recorder();

  render("<!-- lab:box -->\n\n**bold**\n\n<!-- /lab:box -->", components);

  assert.equal(calls[0].html, "<p><strong>bold</strong></p>\n");
});

// ---- Mistakes ---------------------------------------------------------

function assertFails(source, pattern, env) {
  const { components } = recorder();

  assert.throws(() => render(source, components, env), (error) => {
    assert.ok(error instanceof CommentBlockError);
    assert.match(error.message, pattern);
    return true;
  });
}

test("a misspelled closer names both blocks and the opening line", () => {
  assertFails(
    "<!-- lab:chart -->\n\ntext\n\n<!-- /lab:char -->",
    /line 5: "\/char" does not match "chart", opened on line 1/,
  );
});

test("a block left open fails", () => {
  assertFails("<!-- lab:chart -->\n\ntext", /"chart" is never closed/);
});

test("a closer with no opener fails", () => {
  assertFails("text\n\n<!-- /lab:chart -->", /never opened/);
});

test("an unknown component fails", () => {
  assertFails("<!-- lab:pie-chart /-->", /unknown component "pie-chart"/);
});

test("options that aren't JSON fail", () => {
  assertFails(
    "<!-- lab:chart {foo: false} -->\n<!-- /lab:chart -->",
    /"chart" options are not valid JSON/,
  );
});

test("options that aren't wrapped in braces are malformed", () => {
  assertFails('<!-- lab:list ["a"] /-->', /malformed block comment/);
  assertFails("<!-- lab:list {} /-->\n\n<!-- lab:list null /-->", /malformed/);
});

test("a block may not open in a list item and close outside it", () => {
  assertFails(
    "- item\n\n  <!-- lab:box -->\n\n  text\n\n<!-- /lab:box -->",
    /different nesting levels/,
  );
});

test("errors name the file when the build provides one", () => {
  assertFails(
    "<!-- lab:nope /-->",
    /^reports\/x\.md:1: unknown component/,
    { page: { inputPath: "reports/x.md" } },
  );
});
