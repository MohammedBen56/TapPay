"""HTML generation for the session-browsing pages. Plain f-strings, no templating
engine needed for two pages this small.
"""

from __future__ import annotations

import html
import json
from datetime import datetime, timezone

PAGE_STYLE = """
body { font-family: system-ui, sans-serif; margin: 1.5rem; background: #111; color: #eee; }
h1 { font-size: 1.1rem; font-weight: 600; }
a { color: #4ea8ff; }
table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
th, td { text-align: left; padding: 0.4rem 0.8rem; border-bottom: 1px solid #333; font-size: 0.9rem; }
th { color: #999; font-weight: 500; }
tr:hover { background: #1b1b1b; }
"""


def render_sessions_index(sessions: list[dict]) -> str:
    rows = []
    for s in sessions:
        mtime = datetime.fromtimestamp(s["mtime"], tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        size_kb = s["size_bytes"] / 1024
        session_id = html.escape(s["session_id"])
        rows.append(
            f"<tr>"
            f"<td><a href='/sessions/{session_id}'>{session_id}</a></td>"
            f"<td>{', '.join(s['roles']) or '-'}</td>"
            f"<td>{s['sample_count']}</td>"
            f"<td>{s['marker_count']}</td>"
            f"<td>{size_kb:.0f} KB</td>"
            f"<td>{mtime}</td>"
            f"</tr>"
        )
    rows_html = "\n".join(rows) if rows else "<tr><td colspan='6'>No sessions captured yet.</td></tr>"

    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>TapPay Sessions</title><style>{PAGE_STYLE}</style></head>
<body>
<h1>Captured telemetry sessions</h1>
<table>
<thead><tr><th>Session</th><th>Roles</th><th>Samples</th><th>Markers</th><th>Size</th><th>Last updated</th></tr></thead>
<tbody>
{rows_html}
</tbody>
</table>
</body></html>
"""


def render_session_viewer(payload: dict) -> str:
    session_id = html.escape(payload["session_id"])
    payload_json = json.dumps(payload)

    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>TapPay Session {session_id}</title>
<style>{PAGE_STYLE}
#chart {{ width: 100%; }}
.note {{ color: #999; font-size: 0.85rem; }}
</style>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
<h1>Session {session_id}</h1>
<p class="note">Scroll/drag the bottom range slider to move through time; drag on any
track to box-zoom (zooms all tracks together, they share one time axis). Double-click
to reset zoom. Red markers = "Mark Bump" presses; hover a marker dot (top track) for
its grip/orientation/contact tag. Note: with two phones, each trace uses its own
device clock (unsynced until M3) -- shape comparison only, not cross-device timing.</p>
<div id="chart"></div>
<script>
const payload = {payload_json};
const ROLE_COLORS = {{ A: "#4ea8ff", B: "#ff8a4e" }};

const ROWS = [
  {{ key: "raw_accel_g", title: "Accel magnitude, raw", unit: "g" }},
  {{ key: "filtered_accel_g", title: "Accel magnitude, high-pass filtered", unit: "g" }},
  {{ key: "jerk_g_s", title: "Jerk magnitude, d(accel)/dt", unit: "g/s" }},
  {{ key: "gyro_rad_s", title: "Gyro magnitude", unit: "rad/s" }},
  {{ key: "mag_ut", title: "Magnetometer magnitude", unit: "µT" }},
];
const N = ROWS.length;
const GAP = 0.06;
const ROW_HEIGHT = (1 - GAP * (N - 1)) / N;

const traces = [];
const annotations = [];
const layout = {{
  height: 1700,
  // Explicit, not left to default -- box-drag inside a row zooms that row's Y (and
  // its own X). Without this, drag defaults to a select/lasso-style mode that draws
  // a shape but doesn't zoom.
  dragmode: "zoom",
  paper_bgcolor: "#111",
  plot_bgcolor: "#111",
  font: {{ color: "#ccc" }},
  showlegend: true,
  legend: {{ orientation: "h", y: 1.02 }},
  margin: {{ t: 40, b: 80, l: 70, r: 30 }},
}};

// Each row gets its OWN x-axis object (x, x2, x3, ...), linked via `matches` so they
// pan/zoom together -- this is the standard Plotly pattern for "shared x, independent
// y per row" (what plotly.py's make_subplots(shared_xaxes=True) generates under the
// hood). Earlier this used one literal shared 'x' object for every row, which made
// Plotly treat the whole chart as a single interaction region: that's why drag and
// scroll-zoom only ever affected the x-axis and never a specific row's y-axis. The
// rangeslider and visible time labels live on the BOTTOM row's x-axis (matches
// linkage still keeps every row in sync when you drag/scroll any of them).
const bottomXaxisId = N === 1 ? "x" : `x${{N}}`;

ROWS.forEach((row, i) => {{
  const isBottom = i === N - 1;
  const xaxisId = i === 0 ? "x" : `x${{i + 1}}`;
  const yaxisId = i === 0 ? "y" : `y${{i + 1}}`;
  const xaxisKey = i === 0 ? "xaxis" : `xaxis${{i + 1}}`;
  const yaxisKey = i === 0 ? "yaxis" : `yaxis${{i + 1}}`;

  const top = 1 - i * (ROW_HEIGHT + GAP);
  const bottom = top - ROW_HEIGHT;

  // Short unit-only axis title -- the descriptive name goes in an annotation above
  // the row instead, since 5 full-sentence rotated titles packed this tight is
  // guaranteed to overlap into unreadable text.
  layout[yaxisKey] = {{ domain: [Math.max(bottom, 0), top], title: row.unit, gridcolor: "#333", anchor: xaxisId }};

  layout[xaxisKey] = {{ anchor: yaxisId, gridcolor: "#333", showticklabels: isBottom }};
  if (isBottom) {{
    layout[xaxisKey].rangeslider = {{ visible: true }};
    layout[xaxisKey].title = "time (s)";
  }} else {{
    layout[xaxisKey].matches = bottomXaxisId;
  }}

  annotations.push({{
    text: row.title,
    xref: "paper", yref: "paper",
    x: 0, y: top,
    xanchor: "left", yanchor: "bottom",
    showarrow: false,
    font: {{ size: 13, color: "#eee" }},
  }});

  for (const role of Object.keys(payload.roles)) {{
    const data = payload.roles[role];
    traces.push({{
      x: data.t_rel_s,
      y: data[row.key],
      type: "scattergl",
      mode: "lines",
      name: `Phone ${{role}}`,
      legendgroup: role,
      showlegend: i === 0,
      line: {{ color: ROLE_COLORS[role] || "#888", width: 1 }},
      xaxis: xaxisId,
      yaxis: yaxisId,
    }});
  }}
}});
layout.annotations = annotations;

// Bump markers: a vertical line spanning the whole figure per marker, plus a
// hoverable dot in the top track carrying the grip/orientation/contact tag.
layout.shapes = payload.markers.map((m) => ({{
  type: "line", xref: "x", yref: "paper",
  x0: m.t_rel_s, x1: m.t_rel_s, y0: 0, y1: 1,
  line: {{ color: "#e53e3e", dash: "dash", width: 1 }},
}}));

if (payload.markers.length > 0) {{
  const topRowMax = Math.max(...Object.values(payload.roles).flatMap((d) => d.raw_accel_g), 1);
  traces.push({{
    x: payload.markers.map((m) => m.t_rel_s),
    y: payload.markers.map(() => topRowMax),
    type: "scatter",
    mode: "markers",
    name: "Bump markers",
    marker: {{ color: "#e53e3e", size: 9, symbol: "triangle-down" }},
    text: payload.markers.map((m) => {{
      const tag = m.tag || {{}};
      return `role=${{m.role}} grip=${{tag.grip ?? "-"}} orientation=${{tag.orientation ?? "-"}} contact=${{tag.contact_point ?? "-"}}`;
    }}),
    hoverinfo: "text+x",
    xaxis: "x",
    yaxis: "y",
  }});
}}

Plotly.newPlot("chart", traces, layout, {{
  responsive: true,
  scrollZoom: true, // mouse-wheel zoom over any row, as a reliable alternative to drag
  modeBarButtonsToRemove: ["lasso2d", "select2d"], // not useful here -- were live but did nothing worth doing
}});
</script>
</body></html>
"""
