const test = require('node:test');
const assert = require('node:assert/strict');
const fmt = require('../media/format.js');

test('bytes uses 1024 steps and one decimal above bytes', () => {
  assert.equal(fmt.bytes(0), '0 B');
  assert.equal(fmt.bytes(1023), '1023 B');
  assert.equal(fmt.bytes(1536), '1.5 KB');
  assert.equal(fmt.bytes(21.5 * 1024 ** 3), '21.5 GB');
  assert.equal(fmt.bytes(null), 'N/A');
});

test('rate appends /s', () => {
  assert.equal(fmt.rate(2355), '2.3 KB/s');
  assert.equal(fmt.rate(null), 'N/A');
});

test('pct has one decimal', () => {
  assert.equal(fmt.pct(23.14), '23.1%');
  assert.equal(fmt.pct(0), '0.0%');
  assert.equal(fmt.pct(undefined), 'N/A');
});

test('uptime is [Nd ]hh:mm:ss', () => {
  assert.equal(fmt.uptime(308444.656), '3d 13:40:44');
  assert.equal(fmt.uptime(59), '00:00:59');
  assert.equal(fmt.uptime(null), 'N/A');
});
