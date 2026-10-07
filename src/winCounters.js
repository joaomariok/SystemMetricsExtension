const path = require('path');
const childProcess = require('child_process');

const SCRIPT_PATH = path.join(__dirname, 'counters.ps1');

const LUID_RE = /luid_0x[0-9a-f]{8}_0x[0-9a-f]{8}/;
const EMPTY = { gpu: null, disk: { active: null }, net: { rxSec: null, txSec: null } };

const clamp = (v) => Math.min(100, Math.max(0, v));

function toSnapshot(samples, adapters) {
  const known = new Map(adapters.map((a) => [a.luid.toLowerCase(), a]));
  const gpus = new Map();
  const entry = (luid) => {
    if (!gpus.has(luid)) gpus.set(luid, { util: 0, dedicated: null, shared: null });
    return gpus.get(luid);
  };
  for (const a of adapters) if (!a.software) entry(a.luid.toLowerCase());

  let idle = null;
  let rx = null;
  let tx = null;
  for (const { p, v } of samples) {
    const key = String(p).toLowerCase();
    const luid = (key.match(LUID_RE) || [])[0];
    if (luid && known.get(luid)?.software) continue;
    if (luid && key.includes('\\gpu engine(')) entry(luid).util += v;
    else if (luid && key.endsWith('\\dedicated usage')) entry(luid).dedicated = v;
    else if (luid && key.endsWith('\\shared usage')) entry(luid).shared = v;
    else if (key.endsWith('\\% idle time')) idle = v;
    else if (key.endsWith('\\bytes received/sec')) rx = (rx ?? 0) + v;
    else if (key.endsWith('\\bytes sent/sec')) tx = (tx ?? 0) + v;
  }

  const gpu = [...gpus].map(([luid, g], i) => {
    const a = known.get(luid);
    return {
      name: a ? a.name : `GPU ${i}`,
      util: Math.min(100, g.util),
      dedicated: g.dedicated == null ? null : { used: g.dedicated, total: a ? a.dedicatedTotal : null },
      shared: g.shared == null ? null : { used: g.shared, total: a ? a.sharedTotal : null },
    };
  });

  return {
    gpu,
    disk: { active: idle == null ? null : clamp(100 - idle) },
    net: { rxSec: rx, txSec: tx },
  };
}

function createParser() {
  let adapters = [];
  return (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return null;
    }
    if (Array.isArray(msg?.adapters)) {
      adapters = msg.adapters;
      return null;
    }
    if (Array.isArray(msg?.samples)) return toSnapshot(msg.samples, adapters);
    return null;
  };
}

function startCounters({ onSnapshot, spawn = childProcess.spawn, restartMs = 5000, maxFailures = 3 }) {
  const parse = createParser();
  let child = null;
  let timer = null;
  let failures = 0;
  let stopped = false;

  function launch() {
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH],
      { windowsHide: true },
    );
    child = proc;
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      const lines = (buf + chunk).split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const snap = parse(line);
        if (snap && !stopped) {
          failures = 0;
          onSnapshot(snap);
        }
      }
    });
    // 'exit' may or may not follow 'error'; count the failure once.
    let ended = false;
    const onEnd = () => {
      if (ended || stopped) return;
      ended = true;
      child = null;
      failures += 1;
      if (failures >= maxFailures) onSnapshot(EMPTY);
      else timer = setTimeout(launch, restartMs);
    };
    proc.on('error', onEnd);
    proc.on('exit', onEnd);
  }

  launch();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      if (child) child.kill();
      child = null;
    },
  };
}

module.exports = { createParser, toSnapshot, startCounters, EMPTY };
