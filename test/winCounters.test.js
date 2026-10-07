const test = require('node:test');
const assert = require('node:assert/strict');
const { createParser, toSnapshot } = require('../src/winCounters.js');

const NV = 'luid_0x00000000_0x0000dcad';
const IG = 'luid_0x00000000_0x00011fef';
const SW = 'luid_0x00000000_0x00011fc4';

const ADAPTERS = [
  { luid: NV, name: 'NVIDIA GeForce RTX 3060', software: false, dedicatedTotal: 12e9, sharedTotal: 17e9 },
  { luid: IG, name: 'Intel(R) UHD Graphics 770', software: false, dedicatedTotal: 128e6, sharedTotal: 17e9 },
  { luid: SW, name: 'Microsoft Basic Render Driver', software: true, dedicatedTotal: 0, sharedTotal: 17e9 },
];

const s = (path, v) => ({ p: `\\\\pc\\${path}`, v });

const SAMPLES = [
  s(`gpu engine(pid_1_${NV}_phys_0_eng_0_engtype_3d)\\utilization percentage`, 60),
  s(`gpu engine(pid_2_${NV}_phys_0_eng_0_engtype_3d)\\utilization percentage`, 55),
  s(`gpu engine(pid_3_${IG}_phys_0_eng_0_engtype_3d)\\utilization percentage`, 2.5),
  s(`gpu engine(pid_4_${SW}_phys_0_eng_0_engtype_3d)\\utilization percentage`, 1),
  s(`gpu adapter memory(${NV}_phys_0)\\dedicated usage`, 10e9),
  s(`gpu adapter memory(${NV}_phys_0)\\shared usage`, 1e9),
  s(`gpu adapter memory(${IG}_phys_0)\\dedicated usage`, 0),
  s(`gpu adapter memory(${IG}_phys_0)\\shared usage`, 142e6),
  s(`gpu adapter memory(${SW}_phys_0)\\shared usage`, 5),
  s('physicaldisk(_total)\\% idle time', 89.4),
  s('network interface(eth)\\bytes received/sec', 1000),
  s('network interface(wifi)\\bytes received/sec', 500),
  s('network interface(eth)\\bytes sent/sec', 200),
];

test('toSnapshot groups GPUs by LUID, caps utilization, drops software adapters', () => {
  const snap = toSnapshot(SAMPLES, ADAPTERS);
  assert.deepEqual(snap.gpu, [
    {
      name: 'NVIDIA GeForce RTX 3060',
      util: 100,
      dedicated: { used: 10e9, total: 12e9 },
      shared: { used: 1e9, total: 17e9 },
    },
    {
      name: 'Intel(R) UHD Graphics 770',
      util: 2.5,
      dedicated: { used: 0, total: 128e6 },
      shared: { used: 142e6, total: 17e9 },
    },
  ]);
});

test('toSnapshot computes disk active from idle and sums network', () => {
  const snap = toSnapshot(SAMPLES, ADAPTERS);
  assert.ok(Math.abs(snap.disk.active - 10.6) < 1e-9);
  assert.deepEqual(snap.net, { rxSec: 1500, txSec: 200 });
});

test('toSnapshot clamps disk active to 0..100', () => {
  assert.equal(toSnapshot([s('physicaldisk(_total)\\% idle time', 120)], []).disk.active, 0);
  assert.equal(toSnapshot([s('physicaldisk(_total)\\% idle time', -5)], []).disk.active, 100);
});

test('toSnapshot labels LUIDs unknown to DXGI as GPU n with null totals', () => {
  const snap = toSnapshot(
    [
      s(`gpu engine(pid_1_${NV}_phys_0_eng_0_engtype_3d)\\utilization percentage`, 10),
      s(`gpu adapter memory(${NV}_phys_0)\\dedicated usage`, 5e9),
    ],
    [],
  );
  assert.deepEqual(snap.gpu, [{ name: 'GPU 0', util: 10, dedicated: { used: 5e9, total: null }, shared: null }]);
});

test('toSnapshot lists idle adapters and reports missing counters as null', () => {
  const snap = toSnapshot([], ADAPTERS);
  assert.deepEqual(snap.gpu, [
    { name: 'NVIDIA GeForce RTX 3060', util: 0, dedicated: null, shared: null },
    { name: 'Intel(R) UHD Graphics 770', util: 0, dedicated: null, shared: null },
  ]);
  assert.deepEqual(snap.disk, { active: null });
  assert.deepEqual(snap.net, { rxSec: null, txSec: null });
});

test('toSnapshot matches counter paths case-insensitively', () => {
  const snap = toSnapshot([{ p: '\\\\PC\\PhysicalDisk(_Total)\\% Idle Time', v: 75 }], []);
  assert.equal(snap.disk.active, 25);
});

test('parser remembers adapters and ignores malformed lines', () => {
  const parse = createParser();
  assert.equal(parse(JSON.stringify({ adapters: ADAPTERS })), null);
  assert.equal(parse('not json'), null);
  assert.equal(parse(''), null);
  const snap = parse(JSON.stringify({ samples: SAMPLES }));
  assert.equal(snap.gpu[0].name, 'NVIDIA GeForce RTX 3060');
  assert.equal(snap.gpu.length, 2);
});

const { EventEmitter } = require('node:events');
const { startCounters, EMPTY } = require('../src/winCounters.js');

function fakeSpawn() {
  const procs = [];
  const spawn = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stdout.setEncoding = () => {};
    p.killed = false;
    p.kill = () => {
      p.killed = true;
    };
    procs.push(p);
    return p;
  };
  return { spawn, procs };
}

test('startCounters streams snapshots across chunk boundaries', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { spawn, procs } = fakeSpawn();
  const got = [];
  const c = startCounters({ onSnapshot: (x) => got.push(x), spawn });
  const text = `${JSON.stringify({ adapters: ADAPTERS })}\r\n${JSON.stringify({ samples: SAMPLES })}\r\n`;
  procs[0].stdout.emit('data', text.slice(0, 50));
  procs[0].stdout.emit('data', text.slice(50));
  assert.equal(got.length, 1);
  assert.equal(got[0].gpu[0].name, 'NVIDIA GeForce RTX 3060');
  c.stop();
});

test('stop kills the child and prevents restarts', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { spawn, procs } = fakeSpawn();
  const c = startCounters({ onSnapshot: () => {}, spawn });
  c.stop();
  assert.equal(procs[0].killed, true);
  procs[0].emit('exit', 1);
  t.mock.timers.tick(60000);
  assert.equal(procs.length, 1);
});

test('an unexpected exit restarts after 5s', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { spawn, procs } = fakeSpawn();
  const c = startCounters({ onSnapshot: () => {}, spawn });
  procs[0].emit('exit', 1);
  t.mock.timers.tick(4999);
  assert.equal(procs.length, 1);
  t.mock.timers.tick(1);
  assert.equal(procs.length, 2);
  c.stop();
});

test('error followed by exit counts as one failure', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { spawn, procs } = fakeSpawn();
  const c = startCounters({ onSnapshot: () => {}, spawn });
  procs[0].emit('error', new Error('spawn ENOENT'));
  procs[0].emit('exit', -2);
  t.mock.timers.tick(5000);
  assert.equal(procs.length, 2);
  c.stop();
});

test('gives up after 3 consecutive failures and posts EMPTY once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { spawn, procs } = fakeSpawn();
  const got = [];
  startCounters({ onSnapshot: (x) => got.push(x), spawn });
  procs[0].emit('exit', 1);
  t.mock.timers.tick(5000);
  procs[1].emit('exit', 1);
  t.mock.timers.tick(5000);
  procs[2].emit('exit', 1);
  t.mock.timers.tick(60000);
  assert.equal(procs.length, 3);
  assert.deepEqual(got, [EMPTY]);
});

test('a received snapshot resets the failure count', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { spawn, procs } = fakeSpawn();
  const c = startCounters({ onSnapshot: () => {}, spawn });
  procs[0].emit('exit', 1);
  t.mock.timers.tick(5000);
  procs[1].emit('exit', 1);
  t.mock.timers.tick(5000);
  procs[2].stdout.emit('data', `${JSON.stringify({ samples: [] })}\n`);
  procs[2].emit('exit', 1);
  t.mock.timers.tick(5000);
  assert.equal(procs.length, 4);
  c.stop();
});

if (process.platform === 'win32') {
  test('real counter loop reports named GPUs, disk and network', { timeout: 30000 }, async () => {
    const snap = await new Promise((resolve) => {
      const c = startCounters({
        onSnapshot: (x) => {
          c.stop();
          resolve(x);
        },
      });
    });
    assert.ok(Array.isArray(snap.gpu) && snap.gpu.length >= 1, 'at least one GPU');
    for (const g of snap.gpu) {
      assert.equal(typeof g.name, 'string');
      assert.notEqual(g.name, 'Microsoft Basic Render Driver');
      assert.equal(typeof g.util, 'number');
    }
    assert.equal(typeof snap.disk.active, 'number');
    assert.equal(typeof snap.net.rxSec, 'number');
    assert.equal(typeof snap.net.txSec, 'number');
  });
}
