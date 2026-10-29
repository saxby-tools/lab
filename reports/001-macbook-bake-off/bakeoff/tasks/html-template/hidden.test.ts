import { assertEquals, assertInstanceOf } from "jsr:@std/assert@1";
import { escapeHtml, html, raw, SafeHtml } from "./solution.ts";

// ---- escapeHtml -------------------------------------------------------

Deno.test("escapeHtml replaces exactly the five characters", () => {
  assertEquals(
    escapeHtml(`<a href="x">Tom & Jerry's</a>`),
    "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
  );
  assertEquals(escapeHtml("plain / ` = text"), "plain / ` = text");
  assertEquals(escapeHtml(""), "");
});

Deno.test("escapeHtml escapes ampersands exactly once", () => {
  assertEquals(escapeHtml("&amp; &lt;"), "&amp;amp; &amp;lt;");
});

// ---- html basics ------------------------------------------------------

Deno.test("html returns a SafeHtml whose string is the markup", () => {
  const result = html`<p>${"hi"}</p>`;

  assertInstanceOf(result, SafeHtml);
  assertEquals(String(result), "<p>hi</p>");
  assertEquals(result.toString(), "<p>hi</p>");
  assertEquals(`${result}`, "<p>hi</p>");
});

Deno.test("literal text is not escaped", () => {
  assertEquals(String(html`<b class="x">&nbsp;</b>`), `<b class="x">&nbsp;</b>`);
});

Deno.test("no values", () => {
  assertEquals(String(html``), "");
  assertEquals(String(html`<br>`), "<br>");
});

Deno.test("values at the edges and side by side", () => {
  assertEquals(String(html`${"<"}${">"}`), "&lt;&gt;");
  assertEquals(String(html`${1}-${2}`), "1-2");
});

// ---- Escaping values --------------------------------------------------

Deno.test("strings are escaped in text", () => {
  assertEquals(
    String(html`<p>${"<script>alert(1)</script>"}</p>`),
    "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
  );
});

Deno.test("strings cannot break out of an attribute", () => {
  const evil = `x" onmouseover="alert(1)`;
  const single = `x' onmouseover='alert(1)`;

  assertEquals(
    String(html`<a title="${evil}">`),
    `<a title="x&quot; onmouseover=&quot;alert(1)">`,
  );
  assertEquals(
    String(html`<a title='${single}'>`),
    `<a title='x&#39; onmouseover=&#39;alert(1)'>`,
  );
});

Deno.test("null, undefined and booleans render empty", () => {
  assertEquals(String(html`[${null}|${undefined}|${true}|${false}]`), "[|||]");
});

Deno.test("numbers and bigints render with String", () => {
  assertEquals(String(html`${0}|${-1.5}|${NaN}|${10n}`), "0|-1.5|NaN|10");
});

Deno.test("other values are stringified then escaped", () => {
  const sneaky = { toString: () => "<img src=x onerror=alert(1)>" };

  assertEquals(String(html`${sneaky}`), "&lt;img src=x onerror=alert(1)&gt;");
  assertEquals(String(html`${{}}`), "[object Object]");
  assertEquals(String(html`${Symbol("<s>")}`), "Symbol(&lt;s&gt;)");
});

Deno.test("objects shaped like SafeHtml are not trusted", () => {
  const fakes = [
    { __html: "<b>", toString: () => "<b>" },
    { markup: "<b>", value: "<b>", html: "<b>", toString: () => "<b>" },
    Object.assign(Object.create(null), { toString: () => "<b>" }),
  ];

  for (const fake of fakes) {
    assertEquals(String(html`${fake}`), "&lt;b&gt;");
  }
});

// ---- Arrays -----------------------------------------------------------

Deno.test("arrays join without separators and escape each item", () => {
  assertEquals(String(html`${["<a>", 1, null, false, "&"]}`), "&lt;a&gt;1&amp;");
});

Deno.test("nested arrays render recursively", () => {
  assertEquals(String(html`${["a", ["<b>", ["c", [true, 2]]]]}`), "a&lt;b&gt;c2");
});

Deno.test("arrays of html results are not escaped", () => {
  const items = ["one", "<two>"];
  const list = html`<ul>${items.map((item) => html`<li>${item}</li>`)}</ul>`;

  assertEquals(
    String(list),
    "<ul><li>one</li><li>&lt;two&gt;</li></ul>",
  );
});

// ---- Nesting and raw --------------------------------------------------

Deno.test("nested html is not double-escaped", () => {
  const inner = html`<i>${"a & b"}</i>`;
  const outer = html`<p>${inner}</p>`;
  const outermost = html`<div>${outer}</div>`;

  assertEquals(String(outermost), "<div><p><i>a &amp; b</i></p></div>");
});

Deno.test("raw markup is inserted unchanged", () => {
  const trusted = raw("<b>&nbsp;</b>");

  assertInstanceOf(trusted, SafeHtml);
  assertEquals(String(trusted), "<b>&nbsp;</b>");
  assertEquals(String(html`<p>${trusted}</p>`), "<p><b>&nbsp;</b></p>");
});

Deno.test("raw inside an array is not escaped", () => {
  assertEquals(String(html`${[raw("<hr>"), "<hr>"]}`), "<hr>&lt;hr&gt;");
});
