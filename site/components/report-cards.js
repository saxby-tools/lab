// One card per report, from the table of reports:
//
//   <!-- lab:report-cards {"files": "https://github.com/o/r/tree/HEAD/"} -->
//
//   | No. | Report        | Published | Summary     | Files      |
//   | --- | ------------- | --------- | ----------- | ---------- |
//   | 001 | [Title][001]  | Oct. 2026 | Six local … | [Files][f] |
//
// The Report cell links the report; the Files cell links its folder.
// A relative folder link works on GitHub as it is; on the site it's
// joined to the `files` option so it opens the folder on GitHub.
//
// Options:
//   files     the base for relative folder links (required)
//   read      the report link's text (default "Read the report")
//   filesText the folder link's text (default "Files and data on
//             GitHub")

import { fail, requireColumns, requireTable } from "./shared.js";

// ---- Constants --------------------------------------------------------

const COLUMNS = ["No.", "Report", "Published", "Summary", "Files"];

const LINK = /<a href="([^"]*)">([\s\S]*?)<\/a>/;

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// ---- Cards ------------------------------------------------------------

function readLink(block, html, where) {
  const link = html.match(LINK);

  if (!link) {
    fail(block, `the ${where} cell needs a link`);
  }

  return { href: link[1], text: link[2] };
}

function folderUrl(base, href) {
  if (SCHEME.test(href)) {
    return href;
  }

  return base + href.replace(/^\.\//, "").replace(/\/$/, "");
}

export default function reportCards(block) {
  const table = requireTable(block);
  const { options } = block;

  if (options.files === undefined) {
    fail(block, 'needs a "files" option: the base for folder links');
  }

  requireColumns(block, COLUMNS);

  return {
    readText: options.read ?? "Read the report",
    filesText: options.filesText ?? "Files and data on GitHub",
    cards: table.htmlRows.map((cells, i) => {
      const number = table.rows[i]["No."];
      const report = readLink(block, cells.Report, `${number} Report`);
      const files = readLink(block, cells.Files, `${number} Files`);

      return {
        number,
        title: report.text,
        href: report.href,
        published: cells.Published,
        summary: cells.Summary,
        files: folderUrl(options.files, files.href),
      };
    }),
  };
}
