import assert from "node:assert/strict";
import { test } from "node:test";

import MarkdownIt from "markdown-it";

import mdLinks from "./md-links.js";

// ---- Helpers ----------------------------------------------------------

function hrefOf(markdown) {
  const md = new MarkdownIt().use(mdLinks);
  const html = md.renderInline(markdown);
  const match = html.match(/href="([^"]*)"/);

  return match?.[1] ?? null;
}

// ---- Tests ------------------------------------------------------------

test("relative Markdown links point at the built page", () => {
  assert.equal(hrefOf("[data](data.md)"), "data.html");
  assert.equal(hrefOf("[up](../README.md)"), "../README.html");
});

test("fragments and queries survive", () => {
  assert.equal(hrefOf("[gaps](data.md#known-gaps)"), "data.html#known-gaps");
  assert.equal(hrefOf("[q](notes.md?v=2#top)"), "notes.html?v=2#top");
});

test("other links are left alone", () => {
  assert.equal(
    hrefOf("[x](https://example.com/a.md)"),
    "https://example.com/a.md",
  );
  assert.equal(hrefOf("[x](/reports/a.md)"), "/reports/a.md");
  assert.equal(hrefOf("[x](index.html)"), "index.html");
  assert.equal(hrefOf("[x](bakeoff/)"), "bakeoff/");
  assert.equal(hrefOf("[x](#results)"), "#results");
});

test("links inside a table cell are rewritten too", () => {
  const md = new MarkdownIt().use(mdLinks);
  const html = md.render("| a |\n| - |\n| [d](data.md) |");

  assert.match(html, /href="data\.html"/);
});
