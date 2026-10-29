#  The lab's site

Eleventy builds <https://saxby-tools.github.io/lab/> from the same
Markdown files GitHub shows. One rule shapes everything here: **a
Markdown file must read as plain Markdown on GitHub.** Anything only
the site needs lives in HTML comments, which GitHub hides.

##  Build it

```bash
npm ci
```

```bash
npm run serve
```

`npm test` runs the plugin and component tests. `npm run build`
writes the site to `_site/`. Pull requests build it in CI, and pushes
to `main` deploy it.

##  Writing pages

Every `.md` file in a report folder becomes a page beside it:
`data.md` becomes `data.html`, and links between Markdown files are
rewritten to match. Don't add front matter; GitHub shows it as a
table. The layout, address and title come from `eleventy.config.js`,
and the title is the file's first heading.

Two small data files beside a report's Markdown carry what front
matter would:

- `index.11tydata.json` gives the report itself `report.ejs`, the
  report layout. Other pages use `page.ejs`.
- `<folder>.11tydata.json` holds the folder's `palette`: each name
  as it appears in a table, mapped to a series color from 1 to 8.

The repo's own `README.md` is the site's front page. Its
`README.11tydata.json` picks `home.ejs`, the landing layout, and sets
`output` to `index.html`. That layout builds the "On this page" list
from the README's `##` headings, with the same anchors GitHub gives
them, so a link like `#known-gaps` works in both places. It's the one
spot where the site adds something the Markdown doesn't hold.

Data files under `bakeoff/` and `checks/` are copied as they are,
never rendered.

##  Comment blocks

A comment block puts a component around ordinary Markdown:

```markdown
<!-- lab:bar-chart {"value": "Fully passing", "title": "Runs"} -->

| Model | Fully passing |
| ----- | ------------- |
| Qwen  | 23/24         |

Runs that passed every hidden test.

<!-- /lab:bar-chart -->
```

On GitHub, a reader sees the table and its caption. On the site, the
table becomes a chart, and the paragraph after it becomes the chart's
caption.

The grammar follows WordPress block comments:

- `<!-- lab:name {...} -->` opens a block. The options are strict
  JSON: quote every key. Long options may span several lines.
- `<!-- /lab:name -->` closes it.
- `<!-- lab:name {...} /-->` is a block with no content.
- Put each comment on its own line, with both comments at the same
  level: not one inside a list item and one outside it.
- Comments outside the `lab:` namespace are left alone.

A mistake stops the build and names the file and line: an unknown
component, invalid JSON, a closer that doesn't match its opener, a
block left open, a missing column, or a cell that isn't a number.

##  Components

Each component's own file lists its options at the top.

| Component | Wraps | Draws |
| --- | --- | --- |
| `bar-chart` | A table | Bars for one column, with an optional marker line |
| `race` | A table | A ranked finish order |
| `bubble-chart` | A table | Bubbles on a log-scale x axis |
| `heatmap` | A table | Shaded cells such as `3/3 (100%)` |
| `stacked-bar` | A table | One stacked bar per row |
| `grouped-bars` | A table | A group of bars per row |
| `verdicts` | A table | Picks as colored pills; split rows shaded |
| `data-table` | A table | A compact table with a color per row |
| `judge-cards` | A list | One card per item, score first |
| `lessons` | A list | Items with bold leads; `class` sets the list's class |
| `label` | A heading | The red label; GitHub shows the heading |
| `deck` | A paragraph | The larger opening paragraph |
| `notice` | A heading and text | A boxed aside with a kicker |
| `bulletin` | Any Markdown | A boxed bulletin; `class` sets its class |
| `footer` | Paragraphs | The page footer; the first is the colophon unless `colophon` is false |
| `report-cards` | A table | One card per report, from the front page's list |
| `tree` | A list | A folder's files, each named in code |
| `canary` | A code block | The block boxed, with a copy button |

Charts read each cell as a number with an optional `/max` and unit,
so `23/24`, `17.2 GiB` and `96%` all work.

To add a component, add `name.ejs` to `site/components/` to draw it,
and `name.js` to turn the block into the template's data if it needs
more than the block itself. The block holds `name`, `options`,
`line`, `env` (the page's data), `html` (the Markdown inside,
rendered) and `table`: the first table inside, as `columns`, `rows`
of raw cells and `htmlRows` of rendered ones. `shared.js` has the
helpers for failing, numbers and colors.

##  Files

```
eleventy.config.js        layout, addresses, titles, copying
site/plugins/             markdown-it plugins: comment blocks, links
site/components/          a .ejs, and often a .js, per component
site/layouts/page.ejs     the page around most rendered Markdown
site/layouts/report.ejs   the page around a report's index.md
site/layouts/home.ejs     the front page, from the repo's README.md
```
