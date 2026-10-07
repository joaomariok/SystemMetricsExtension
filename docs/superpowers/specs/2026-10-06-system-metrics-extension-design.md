# System Metrics Extension — Design

Date: 2026-10-06

## Goal

A VS Code extension that shows live system metrics, Task Manager style, in a
sidebar view opened from its own activity-bar icon. Works on Windows, macOS and
Linux; Windows gets the richest data.

## Metrics

| Metric | Display | Rate | Source (Windows) | Source (macOS/Linux) |
|---|---|---|---|---|
| CPU total + per core | graph + per-core bars | 1s | `si.currentLoad()` | `si.currentLoad()` |
| Memory used/total | graph | 1s | `os.totalmem()/os.freemem()` | same |
| Network down/up | graph (two lines) | 1s | counter loop | `si.networkStats()` |
| GPU utilization, per adapter | graph per adapter | 1s (10s on macOS/Linux) | counter loop | `si.graphics()` (NVIDIA only reports utilization) |
| GPU dedicated memory, per adapter | bar (used / total) | 1s (10s on macOS/Linux) | counter loop + DXGI total | `si.graphics()` `memoryUsed`/`vram` where reported |
| GPU shared memory, per adapter | bar (used / limit) | 1s | counter loop + DXGI limit | always `null` (N/A) |
| Disk activity % | graph | 1s | counter loop | `si.disksIO()` → N/A when unsupported |
| Disk space per drive | bars | 10s | `si.fsSize()` | `si.fsSize()` |
| Battery | value | 10s | `si.battery()` (`null` when no battery) | same |
| CPU temperature | value | 10s | always `null` (N/A) | `si.cpuTemperature()` |
| Uptime | value | 10s | `os.uptime()` | same |

`si` = the `systeminformation` npm package (only runtime dependency).

CPU temperature is deliberately N/A on Windows: the only unprivileged source
(ACPI thermal zones) reported 28°C/17°C on the dev machine — not CPU temps.

On macOS/Linux the 1s tier calls `si.networkStats()` and `si.disksIO()`;
`si.graphics()` is slow, so GPU is in the 10s tier there.

## Measurements behind the design (dev machine, Windows 11, i7 16 threads, Intel UHD 770 + RTX 3060)

- `si.graphics()` ~640ms, `si.fsSize()` ~300ms, `si.cpuTemperature()` ~300ms,
  `si.battery()` ~350ms, `si.mem()` ~280ms — each spawns PowerShell.
- `si.disksIO()` / `si.fsStats()` return `null` on Windows.
- A persistent PowerShell `Get-Counter` loop: ~1s per iteration (one sample
  interval), ~0.5% of total CPU (8% of one core).
- Windows exposes 3 adapters on this 2-GPU machine (RTX 3060, UHD 770, and
  Microsoft Basic Render Driver), so names cannot be matched by order. DXGI
  `EnumAdapters1` from PowerShell (`Add-Type` C#) returns LUID + name + flags +
  memory sizes for all three in ~180ms, once.

## Architecture

Plain JavaScript (CommonJS), no build step, no bundler.

```
package.json            manifest: activity-bar container + webview view, activation onView
media/icon.svg          monochrome activity-bar icon (gauge)
media/view.js           webview: renders snapshots, 60-point history, canvas graphs
media/view.css          layout, bars; colors from --vscode-* theme variables
media/format.js         formatters, shared by webview and tests
src/extension.js        WebviewViewProvider; starts sources when visible, stops when hidden
src/metrics.js          cross-platform collection; takes `si` as a parameter
src/winCounters.js      Windows only: persistent PowerShell Get-Counter loop
test/*.test.js          node:test unit tests
```

Boundaries: `metrics.js` and `winCounters.js` know nothing about VS Code; the
webview knows nothing about `systeminformation`. The snapshot shape below is
the only contract between them.

### Data flow

1. The view becomes visible → `extension.js` starts a 1s timer and a 10s timer
   calling `metrics.js`; on Windows it also starts `winCounters.js`.
2. Each result is posted to the webview with `postMessage` as a partial snapshot.
3. `view.js` updates numbers and bars, and appends graph values to a 60-point
   history (60s at 1s).
4. The view is hidden or disposed → timers cleared, PowerShell child killed.
   Visible again → everything restarts. `retainContextWhenHidden` is not used,
   so the webview is recreated and graph history starts empty — same as
   reopening Task Manager.

### Snapshot shape

Partial updates; only present fields change. `null` means N/A.

```js
// fast, every 1s
{ cpu: { total: 23.1, cores: [18.0, 31.2] },          // %
  mem: { used: 21.5e9, total: 34.1e9 },               // bytes
  net: { rxSec: 2367, txSec: 512 },                   // bytes/s
  gpu: [ { name: 'NVIDIA GeForce RTX 3060',
           util: 4.2,                                 // %
           dedicated: { used: 10.2e9, total: 12.7e9 } | null,   // bytes
           shared: { used: 1.3e9, total: 17.0e9 } | null } ],   // bytes
  disk: { active: 10.6 } }                            // %
// slow, every 10s
{ disks: [ { mount: 'C:', used: 390e9, size: 478e9 } ],
  battery: { percent: 80, charging: true } | null,
  tempC: 54 | null,
  uptimeSec: 308444 }
```

### Windows counter loop (`winCounters.js`)

One long-lived `powershell.exe -NoProfile` child. At startup it compiles a small
`Add-Type` C# helper that calls DXGI `CreateDXGIFactory1` / `EnumAdapters1` and
emits one JSON line listing adapters: `luid` (formatted
`luid_0x{high:x8}_0x{low:x8}`, matching counter instance names), `name`,
`software` (`DXGI_ADAPTER_FLAG_SOFTWARE`), `dedicatedTotal`
(`DedicatedVideoMemory`), `sharedTotal` (`SharedSystemMemory`). COM interop
note, verified in the probe: `EnumAdapters1` is preceded by 9 inherited vtable
methods on `IDXGIFactory1`, `GetDesc1` by 7 on `IDXGIAdapter1`; declaring fewer
silently returns no adapters.

Then it loops, calling `Get-Counter` on:

- `\GPU Engine(*engtype_3D)\Utilization Percentage`
- `\GPU Adapter Memory(*)\Dedicated Usage`
- `\GPU Adapter Memory(*)\Shared Usage`
- `\PhysicalDisk(_Total)\% Idle Time`
- `\Network Interface(*)\Bytes Received/sec`
- `\Network Interface(*)\Bytes Sent/sec`

The wildcard is re-expanded every iteration, so GPU work by processes started
later is counted. The script emits one compact JSON line per iteration with the
raw samples (`path`, `value`); parsing happens in Node:

- GPU: group samples by adapter LUID (extracted from the instance name).
  Utilization = sum of `engtype_3D` samples, capped at 100. Dedicated/shared
  `used` come from the memory counters; `total` from the DXGI line.
- Software adapters are dropped. A LUID with no DXGI entry is labeled `GPU n`
  and its memory totals are `null`.
- Disk active: `100 − idle`, clamped to 0–100.
- Network: sum received and sent across interfaces.
- Lines that fail `JSON.parse` are ignored.

The parser is a pure exported function so it is tested without PowerShell.

## Error handling

- Each `si` call is wrapped; a throw or missing field becomes `null`.
- A timer tick is skipped if the previous call for that tier is still running.
- PowerShell child exits unexpectedly → restart after 5s; after 3 consecutive
  failures, stop and report GPU/disk/net as `null`.
- The webview renders `N/A` for any `null`; it never throws on a missing field.

## UI

Sections, top to bottom: CPU (graph + per-core bars), Memory (graph), one
section per physical GPU titled with its name (utilization graph + Dedicated
memory bar + Shared memory bar), Disk (activity graph + space bar per drive), Network (graph
with down and up lines), then a footer with battery, temperature and uptime.

Graphs: hand-drawn `<canvas>` area charts with a faint grid, newest value on
the right, current value in the section header, sized to the sidebar width and
redrawn on resize. Colors from VS Code theme variables. No chart library.
Webview CSP allows only the extension's own scripts and styles (nonce).

Formatting: bytes `21.5 GB`, rates `2.3 KB/s`, percentages one decimal, uptime
`3d 13:40:44`.

## Testing

`npm test` runs `node --test`:

- `winCounters` parser: DXGI line → adapter map, software adapter dropped,
  per-LUID GPU utilization sum and cap, dedicated/shared used + totals, LUID
  missing from DXGI → `GPU n` with `null` totals, disk clamp, network sum,
  malformed line ignored.
- `metrics.js` with a fake `si`: throwing/missing calls → `null`, snapshot shape.
- `media/format.js`: bytes, rates, uptime.
- Child lifecycle with an injected fake spawn: stop kills the child, crash
  restarts after 5s, gives up after 3 failures.
- Windows only (registered when `process.platform === 'win32'`): run the real
  loop ~3s, assert at least one non-software adapter with a name and numeric
  utilization, and disk/net arrive as numbers.

Not automated: loading in a real VS Code extension host. Checked manually with
F5 — panel opens, graphs move, closing the panel ends the `powershell.exe`
child.

Verification gate: `npm test` and `npx @vscode/vsce package`.

## Out of scope

Process list, refresh-rate setting, hover tooltips, Chart.js, Marketplace
publishing.
