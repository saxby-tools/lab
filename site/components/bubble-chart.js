// A scatter of bubbles: x on a log scale, y as a share, bubble area
// from a third column.
//
//   <!-- lab:bubble-chart {"x": "Median time", "y": "Fully passing",
//        "size": "Memory", "xTicks": [10, 20, 50, 100, 200],
//        "yTicks": [40, 60, 80, 100]} -->
//
// Options:
//   x, y, size      columns (required); y reads "23/24" as a percent
//   xTicks, yTicks  tick values (required); the first and last set
//                   each axis's range
//   xSuffix, ySuffix  appended to tick labels, such as "s" and "%"
//   label           the column naming each bubble (default: first)
//   labels          {"name": {"dx": 40, "dy": 6, "anchor": "start",
//                   "text": "shown instead of the name"}}: where each
//                   label sits, from its bubble's center
//   tooltip         hover text, with {label}, {x}, {y} and {size}
//   title, xLabel, svgTitle, desc, id, maxRadius
//
// Bigger bubbles draw first, so small ones stay on top.

import {
  captionOf,
  fail,
  fillTemplate,
  requireColumns,
  requireNumber,
  requireTable,
  seriesClass,
} from "./shared.js";

// ---- Constants --------------------------------------------------------

const VIEW = { width: 720, height: 470 };

const PLOT = { left: 64, right: 700, top: 34, bottom: 400 };

const TICK_LABEL_X = 54;

const X_TICK_Y = 426;

const AXIS_LABEL_Y = 462;

const DEFAULT_MAX_RADIUS = 33.5;

// ---- Scales -----------------------------------------------------------

function logScale(ticks) {
  const low = Math.log10(ticks[0]);
  const span = Math.log10(ticks.at(-1)) - low;

  return (value) => {
    const share = (Math.log10(value) - low) / span;

    return PLOT.left + share * (PLOT.right - PLOT.left);
  };
}

function linearScale(ticks) {
  const low = ticks[0];
  const span = ticks.at(-1) - low;

  return (value) => {
    const share = (value - low) / span;

    return PLOT.bottom - share * (PLOT.bottom - PLOT.top);
  };
}

function asPercent(cell) {
  return cell.max === null ? cell.value : (cell.value / cell.max) * 100;
}

// ---- Chart ------------------------------------------------------------

export default function bubbleChart(block) {
  const table = requireTable(block);
  const { options } = block;

  for (const option of ["x", "y", "size", "xTicks", "yTicks"]) {
    if (options[option] === undefined) {
      fail(block, `needs a "${option}" option`);
    }
  }

  const label = options.label ?? table.columns[0];

  requireColumns(block, [label, options.x, options.y, options.size]);

  const x = logScale(options.xTicks);
  const y = linearScale(options.yTicks);
  const maxRadius = options.maxRadius ?? DEFAULT_MAX_RADIUS;
  const labels = options.labels ?? {};

  const points = table.rows.map((row) => {
    const name = row[label];
    const where = `"${name}"`;
    const cx = x(requireNumber(block, row[options.x], where).value);
    const cy = y(asPercent(requireNumber(block, row[options.y], where)));
    const size = requireNumber(block, row[options.size], where).value;
    const place = labels[name] ?? {};

    return { name, row, cx, cy, size, place };
  });

  const biggest = Math.max(...points.map((point) => point.size));

  points.sort((a, b) => b.size - a.size);

  return {
    id: options.id ?? "bubbles",
    title: options.title ?? null,
    svgTitle: options.svgTitle ?? options.title ?? "",
    desc: options.desc ?? null,
    caption: captionOf(block.html),
    view: VIEW,
    plot: PLOT,
    tickLabelX: TICK_LABEL_X,
    xTickY: X_TICK_Y,
    axisLabelY: AXIS_LABEL_Y,
    xLabel: options.xLabel ?? null,
    yTicks: options.yTicks.map((tick) => {
      return { at: y(tick), text: `${tick}${options.ySuffix ?? ""}` };
    }),
    xTicks: options.xTicks.map((tick) => {
      return { at: x(tick), text: `${tick}${options.xSuffix ?? ""}` };
    }),
    points: points.map((point) => {
      const r = maxRadius * Math.sqrt(point.size / biggest);
      const dx = point.place.dx ?? r + 6;
      const dy = point.place.dy ?? 6;

      return {
        series: seriesClass(block, point.name),
        cx: point.cx,
        cy: point.cy,
        r,
        labelX: point.cx + dx,
        labelY: point.cy + dy,
        anchor: point.place.anchor ?? "start",
        text: point.place.text ?? point.name,
        tooltip: fillTemplate(options.tooltip ?? "{label}", {
          label: point.name,
          x: point.row[options.x],
          y: point.row[options.y],
          size: point.row[options.size],
        }),
      };
    }),
  };
}
