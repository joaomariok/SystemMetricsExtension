const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { fast, slow, poll, startSources } = require('../src/metrics.js');

const MB = 1024 * 1024;
const flush = () => new Promise((r) => setImmediate(r));
const boom = async () => {
  throw new Error('boom');
};

function fakeSi(over = {}) {
  return {
    currentLoad: async () => ({ currentLoad: 23.1, cpus: [{ load: 18 }, { load: 31.2 }] }),
    networkStats: async () => [
      { rx_sec: 1000, tx_sec: 200 },
      { rx_sec: 500, tx_sec: null },
    ],
    fsSize: async () => [
      { mount: 'C:', used: 390, size: 478 },
      { mount: 'Z:', used: 0, size: 0 },
    ],
    battery: async () => ({ hasBattery: true, percent: 80, isCharging: true }),
    cpuTemperature: async () => ({ main: 54 }),
    graphics: async () => ({
      controllers: [
        { model: 'NVIDIA X', utilizationGpu: 4, memoryUsed: 1024, memoryTotal: 12288 },
        { model: 'Intel Y', vram: 128 },
      ],
    }),
    ...over,
  };
}

test('fast on Windows returns cpu and memory only', async () => {
  const snap = await fast(fakeSi(), { windows: true });
  assert.deepEqual(snap.cpu, { total: 23.1, cores: [18, 31.2] });
  assert.equal(snap.mem.total, os.totalmem());
  assert.ok(snap.mem.used > 0 && snap.mem.used <= snap.mem.total);
  assert.equal('net' in snap, false);
  assert.equal('disk' in snap, false);
});

test('fast elsewhere adds summed network and null disk activity', async () => {
  const snap = await fast(fakeSi(), { windows: false });
  assert.deepEqual(snap.net, { rxSec: 1500, txSec: 200 });
  assert.deepEqual(snap.disk, { active: null });
});

test('fast turns failures and missing rates into null', async () => {
  const snap = await fast(
    fakeSi({
      currentLoad: boom,
      networkStats: async () => [{ rx_sec: null, tx_sec: null }],
    }),
    { windows: false },
  );
  assert.deepEqual(snap.cpu, { total: null, cores: [] });
  assert.deepEqual(snap.net, { rxSec: null, txSec: null });
});

test('slow on Windows: drives, battery, no temperature, no gpu', async () => {
  const snap = await slow(fakeSi(), { windows: true });
  assert.deepEqual(snap.disks, [{ mount: 'C:', used: 390, size: 478 }]);
  assert.deepEqual(snap.battery, { percent: 80, charging: true });
  assert.equal(snap.tempC, null);
  assert.equal(typeof snap.uptimeSec, 'number');
  assert.equal('gpu' in snap, false);
});

test('slow elsewhere adds temperature and gpu from systeminformation', async () => {
  const snap = await slow(fakeSi(), { windows: false });
  assert.equal(snap.tempC, 54);
  assert.deepEqual(snap.gpu, [
    { name: 'NVIDIA X', util: 4, dedicated: { used: 1024 * MB, total: 12288 * MB }, shared: null },
    { name: 'Intel Y', util: null, dedicated: null, shared: null },
  ]);
});

test('slow turns failures, no battery and unknown temperature into null', async () => {
  const all = await slow(fakeSi({ fsSize: boom, battery: boom, cpuTemperature: boom, graphics: boom }), {
    windows: false,
  });
  assert.deepEqual(all.disks, []);
  assert.equal(all.battery, null);
  assert.equal(all.tempC, null);
  assert.equal(all.gpu, null);

  const none = await slow(
    fakeSi({
      battery: async () => ({ hasBattery: false }),
      cpuTemperature: async () => ({ main: -1 }),
    }),
    { windows: false },
  );
  assert.equal(none.battery, null);
  assert.equal(none.tempC, null);
});

test('poll posts immediately and on every interval', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const posted = [];
  let n = 0;
  const stop = poll(
    async () => ++n,
    1000,
    (v) => posted.push(v),
  );
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(posted, [1, 2]);
  stop();
});

test('poll skips ticks while the previous call is pending', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  let release;
  const posted = [];
  const stop = poll(
    () => {
      calls++;
      return new Promise((r) => {
        release = r;
      });
    },
    1000,
    (v) => posted.push(v),
  );
  t.mock.timers.tick(3000);
  assert.equal(calls, 1);
  release('a');
  await flush();
  assert.deepEqual(posted, ['a']);
  t.mock.timers.tick(1000);
  assert.equal(calls, 2);
  stop();
});

test('poll never posts after stop', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  let release;
  const posted = [];
  const stop = poll(
    () => {
      calls++;
      return new Promise((r) => {
        release = r;
      });
    },
    1000,
    (v) => posted.push(v),
  );
  stop();
  release('late');
  await flush();
  t.mock.timers.tick(5000);
  assert.deepEqual(posted, []);
  assert.equal(calls, 1);
});

test('startSources runs both tiers, starts counters on Windows, and stops everything', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const posted = [];
  const post = (m) => posted.push(m);
  let counterArgs = null;
  let counterStopped = false;
  const stop = startSources({
    si: fakeSi(),
    post,
    windows: true,
    counters: (args) => {
      counterArgs = args;
      return {
        stop: () => {
          counterStopped = true;
        },
      };
    },
  });
  await flush();
  assert.ok(
    posted.some((m) => m.cpu),
    'fast tier posted',
  );
  assert.ok(
    posted.some((m) => m.disks),
    'slow tier posted',
  );
  assert.equal(counterArgs.onSnapshot, post);

  stop();
  assert.equal(counterStopped, true);
  const count = posted.length;
  t.mock.timers.tick(20000);
  await flush();
  assert.equal(posted.length, count);
});

test('poll keeps polling after fn throws', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const posted = [];
  let calls = 0;
  const stop = poll(
    async () => {
      calls++;
      if (calls === 1) throw new Error('fail');
      return 'ok';
    },
    1000,
    (v) => posted.push(v),
  );
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(posted, ['ok']);
  stop();
});

test('slow tolerates graphics without controllers', async () => {
  const snap = await slow(fakeSi({ graphics: async () => ({}) }), { windows: false });
  assert.deepEqual(snap.gpu, []);
});
