// Builds the lab's site from the same Markdown that GitHub shows.
//
// No Markdown file carries front matter, because GitHub would show it
// as a table. Each page's layout, address and title come from here
// instead: the layout is site/layouts/page.ejs, `data.md` becomes
// `data.html`, and the title is the file's first heading.
//
// Components live in site/components as a pair of files: `name.ejs`
// draws it and `name.js` turns the block into the template's data.
// A comment block such as `<!-- lab:name {...} -->` picks one.
//
// A report's `index.md` uses site/layouts/report.ejs, set by its
// `index.11tydata.json`; its folder's data file holds the palette.
// The repo's own README.md is the landing page: its data file picks
// site/layouts/home.ejs and sets `output` to index.html.
// Harnesses and data are copied as they are. Their .md files are data,
// not pages, so they're never rendered.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import ejs from "ejs";

import commentBlocks from "./site/plugins/comment-blocks.js";
import mdLinks from "./site/plugins/md-links.js";

// ---- Constants --------------------------------------------------------

const NAMESPACE = "lab";

const COMPONENTS_DIR = "site/components";

const SOURCE_URL = "https://github.com/saxby-tools/lab/blob/main/";

const SITE_URL = "https://saxby-tools.github.io/lab/";

const SITE_SUMMARY = "The tests, harnesses and raw results behind the " +
  "Saxby lab reports. Every number can be checked and every run " +
  "repeated.";

const PASSTHROUGH = [
  "LICENSE",
  "LICENSE-DATA",
  "CITATION.cff",
  "reports/*/bakeoff",
  "reports/*/checks",
];

const IGNORES = [
  "site/**",
  "reports/*/bakeoff/**",
  "reports/*/checks/**",
];

// ---- Components -------------------------------------------------------

async function loadPrepare(name) {
  const path = join(COMPONENTS_DIR, `${name}.js`);

  if (!existsSync(path)) {
    return (block) => block;
  }

  const module = await import(pathToFileURL(path).href);

  return module.default;
}

async function loadComponents() {
  const components = {};

  for (const file of readdirSync(COMPONENTS_DIR)) {
    if (!file.endsWith(".ejs")) {
      continue;
    }

    const name = basename(file, ".ejs");
    const path = join(COMPONENTS_DIR, file);
    const template = ejs.compile(readFileSync(path, "utf8"), {
      filename: path,
    });
    const prepare = await loadPrepare(name);

    components[name] = (block) => template(prepare(block));
  }

  return components;
}

// ---- Page data --------------------------------------------------------

// The first heading, without the Markdown around it.
function titleOf(inputPath) {
  const text = readFileSync(inputPath, "utf8");
  const heading = text.match(/^#\s+(.+)$/m);

  if (!heading) {
    return "Saxby lab";
  }

  return heading[1]
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_]/g, "")
    .trim();
}

// "../" once per folder, so links work under any base path.
function rootOf(filePathStem) {
  const depth = filePathStem.split("/").length - 2;

  return depth > 0 ? "../".repeat(depth) : "./";
}

function sourceOf(inputPath) {
  return SOURCE_URL + inputPath.replace(/^\.\//, "");
}

// The page's full address, for share tags; "index.html" is dropped.
function canonicalOf(url) {
  return SITE_URL + url.replace(/^\//, "").replace(/index\.html$/, "");
}

// ---- Config -----------------------------------------------------------

export default async function (eleventyConfig) {
  const components = await loadComponents();

  eleventyConfig.addExtension("ejs", {
    compile: (input, inputPath) => {
      const template = ejs.compile(input, { filename: inputPath });

      return (data) => template(data);
    },
  });

  eleventyConfig.amendLibrary("md", (md) => {
    md.use(commentBlocks, { namespace: NAMESPACE, components });
    md.use(mdLinks);
  });

  for (const path of PASSTHROUGH) {
    eleventyConfig.addPassthroughCopy(path);
  }

  // Icons, the web manifest and the share image sit at the site's root.
  eleventyConfig.addPassthroughCopy({ "site/static": "/" });

  for (const glob of IGNORES) {
    eleventyConfig.ignores.add(glob);
  }

  eleventyConfig.addGlobalData("layout", "page.ejs");
  eleventyConfig.addGlobalData("siteUrl", SITE_URL);
  eleventyConfig.addGlobalData("eleventyComputed", {
    summary: (data) => data.description ?? SITE_SUMMARY,
    canonical: (data) => canonicalOf(data.page.url),
    permalink: (data) => data.output ?? `${data.page.filePathStem}.html`,
    title: (data) => titleOf(data.page.inputPath),
    root: (data) => rootOf(data.page.filePathStem),
    source: (data) => sourceOf(data.page.inputPath),
  });

  return {
    dir: { input: ".", includes: "site/layouts", output: "_site" },
    templateFormats: ["md"],
    markdownTemplateEngine: false,
  };
}
