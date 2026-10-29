import assert from "node:assert/strict";
import { test } from "node:test";

import canary from "./canary.js";
import lessons from "./lessons.js";
import reportCards from "./report-cards.js";
import tree from "./tree.js";
import { CommentBlockError } from "../plugins/comment-blocks.js";

// ---- Helpers ----------------------------------------------------------

function block(name, html, options = {}, table = null) {
  return { name, line: 3, env: {}, html, options, table };
}

function assertFails(run, pattern) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof CommentBlockError);
    assert.match(error.message, pattern);
    return true;
  });
}

// ---- Lessons ----------------------------------------------------------

test("lessons split each item into its bold lead and the rest", () => {
  const html = "<ul>\n<li><strong>Run it.</strong> Yours picked Qwen.</li>\n" +
    "<li><strong>CC BY-SA 4.0</strong> — Reports and data.</li>\n</ul>\n";
  const view = lessons(block("lessons", html, { class: "licenses" }));

  assert.equal(view.className, "licenses");
  assert.deepEqual(view.items, [
    { lead: "Run it.", text: "Yours picked Qwen." },
    { lead: "CC BY-SA 4.0", text: "Reports and data." },
  ]);
});

test("a lesson without a bold lead fails", () => {
  assertFails(
    () => lessons(block("lessons", "<ul>\n<li>plain</li>\n</ul>\n")),
    /line 3: lessons: each item must start with its lead in bold/,
  );
});

// ---- Tree -------------------------------------------------------------

test("tree items split into the name in code and its note", () => {
  const html = "<ul>\n<li><code>index.md</code>: The report.</li>\n</ul>\n";
  const view = tree(block("tree", html, { root: "reports/x/" }));

  assert.equal(view.root, "reports/x/");
  assert.deepEqual(view.items, [{ name: "index.md", text: "The report." }]);
});

// ---- Canary -----------------------------------------------------------

test("the canary keeps its code exact and the notes after it", () => {
  const html = "<pre><code>LINE ONE\nLINE TWO\n</code></pre>\n" +
    "<p>Please drop it.</p>\n";
  const view = canary(block("canary", html, { kicker: "For trainers" }));

  assert.equal(view.code, "LINE ONE\nLINE TWO");
  assert.equal(view.notes, "<p>Please drop it.</p>");
  assert.equal(view.id, "canary");
});

test("a canary needs a code block", () => {
  assertFails(
    () => canary(block("canary", "<p>no code</p>\n")),
    /needs a code block/,
  );
});

// ---- Report cards -----------------------------------------------------

function cardsTable(files) {
  const columns = ["No.", "Report", "Published", "Summary", "Files"];
  const cells = {
    "No.": "001",
    "Report": '<a href="https://example.com/001/">The bake-off</a>',
    "Published": "Oct. 2026",
    "Summary": "Six models.",
    "Files": `<a href="${files}">Files</a>`,
  };

  return { columns, rows: [{ "No.": "001" }], htmlRows: [cells] };
}

test("a relative folder link opens on GitHub from the site", () => {
  const base = "https://github.com/o/r/tree/HEAD/";
  const view = reportCards(
    block("report-cards", "", { files: base }, cardsTable("reports/001/")),
  );

  assert.deepEqual(view.cards[0], {
    number: "001",
    title: "The bake-off",
    href: "https://example.com/001/",
    published: "Oct. 2026",
    summary: "Six models.",
    files: "https://github.com/o/r/tree/HEAD/reports/001",
  });
});

test("report cards need the files option", () => {
  assertFails(
    () => reportCards(block("report-cards", "", {}, cardsTable("x/"))),
    /needs a "files" option/,
  );
});
