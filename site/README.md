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

Data files under `bakeoff/` and `checks/` are copied as they are,
never rendered.

##  Comment blocks

A comment block puts a component around ordinary Markdown:

```markdown
<!-- lab:bar-chart {"value": "Fully passing", "title": "Runs"} -->

| Model | Fully passing |
| ----- | ------------- |
| Qwen  | 23/24         |

<!-- /lab:bar-chart -->
```

On GitHub, a reader sees the table. On the site, the table becomes a
chart, and the table stays underneath it.

The grammar follows WordPress block comments:

- `<!-- lab:name {...} -->` opens a block. The options are strict
  JSON: quote every key. Long options may span several lines.
- `<!-- /lab:name -->` closes it.
- `<!-- lab:name {...} /-->` is a block with no content.
- Put each comment on its own line, with both comments at the same
  level: not one inside a list item and one outside it.
- Comments outside the `lab:` namespace are left alone.

A mistake stops the build and names the file and line: an unknown
component, invalid JSON, a closer that doesn't match its opener, or a
block left open.

##  Components

| Component | Wraps | Options |
| --- | --- | --- |
| `bar-chart` | A table | `value`, `label`, `title`, `max` |

`bar-chart` options:

- `value` (required): the column to chart.
- `label`: the column naming each bar. Default: the first column.
- `title`: a caption above the chart.
- `max`: the top of the scale. Default: the largest `/max` in the
  column, or else its largest value.

It reads each cell as a number with an optional `/max` and unit, so
`23/24`, `17.2 GiB` and `96%` all work. A cell that isn't a number
stops the build.

To add a component, add two files to `site/components/`: `name.ejs`
draws it, and `name.js` turns the block into the template's data. The
block holds `name`, `options`, `line`, `html` (the Markdown inside,
rendered) and `table` (the first table inside, as `columns` and
`rows`).

##  Files

```
eleventy.config.js        layout, addresses, titles, copying
site/plugins/             markdown-it plugins: comment blocks, links
site/components/          one .ejs and one .js per component
site/layouts/page.ejs     the page around every rendered Markdown file
```
