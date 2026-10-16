const os = require('os');
const { startCounters } = require('./winCounters');

const FAST_MS = 1000;
const SLOW_MS = 10000;
const MB = 1024 * 1024;
const IS_WINDOWS = process.platform === 'win32';

async function safe(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function sum(values) {
  const nums = values.filter((v) => typeof v === 'number');
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

async function fast(si, { windows = IS_WINDOWS } = {}) {
  const [load, nets] = await Promise.all([
    safe(() => si.currentLoad()),
    windows ? null : safe(() => si.networkStats('*')),
  ]);
  const total = os.totalmem();
  const snap = {
    cpu: load ? { total: load.currentLoad, cores: (load.cpus || []).map((c) => c.load) } : { total: null, cores: [] },
    mem: { used: total - os.freemem(), total },
  };
  if (!windows) {
    snap.net = {
      rxSec: sum((nets || []).map((n) => n.rx_sec)),
      txSec: sum((nets || []).map((n) => n.tx_sec)),
    };
    // ponytail: systeminformation has no disk busy % on macOS/Linux; read /proc/diskstats io_ticks if it is wanted
    snap.disk = { active: null };
  }
  return snap;
}

function toGpu(g) {
  const total = g.memoryTotal ?? g.vram;
  return {
    name: g.model,
    util: g.utilizationGpu ?? null,
    dedicated: g.memoryUsed == null ? null : { used: g.memoryUsed * MB, total: total == null ? null : total * MB },
    shared: null,
    tempC: g.temperatureGpu ?? null,
  };
}

async function slow(si, { windows = IS_WINDOWS } = {}) {
  const [fs, bat, temp, gfx] = await Promise.all([
    safe(() => si.fsSize()),
    safe(() => si.battery()),
    windows ? null : safe(() => si.cpuTemperature()),
    windows ? null : safe(() => si.graphics()),
  ]);
  const snap = {
    disks: (fs || []).filter((d) => d.size > 0).map((d) => ({ mount: d.mount, used: d.used, size: d.size })),
    battery: bat && bat.hasBattery ? { percent: bat.percent, charging: bat.isCharging } : null,
    tempC: temp && temp.main > 0 ? temp.main : null,
    uptimeSec: os.uptime(),
  };
  if (!windows) snap.gpu = gfx ? (gfx.controllers || []).map(toGpu) : null;
  return snap;
}

function poll(fn, ms, post) {
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const value = await fn();
      if (!stopped) post(value);
    } catch {
      // one failing source must never stop polling
    } finally {
      busy = false;
    }
  };
  tick();
  const id = setInterval(tick, ms);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}

function startSources({ si, post, windows = IS_WINDOWS, counters = startCounters }) {
  const stops = [poll(() => fast(si, { windows }), FAST_MS, post), poll(() => slow(si, { windows }), SLOW_MS, post)];
  if (windows) {
    const c = counters({ onSnapshot: post });
    stops.push(() => c.stop());
  }
  return () => stops.forEach((stop) => stop());
}

module.exports = { fast, slow, poll, startSources };
