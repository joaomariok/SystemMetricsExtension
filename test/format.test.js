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

test('temp rounds to whole degrees and is null when unknown', () => {
  assert.equal(fmt.temp(39.6), '40 °C');
  assert.equal(fmt.temp(0.4), '0 °C');
  assert.equal(fmt.temp(null), null);
  assert.equal(fmt.temp(undefined), null);
});

const DISK_TEMPS = [
  { index: 0, name: 'HDD', tempC: 35, idle: true, mounts: ['D:', 'G:'] },
  { index: 1, name: 'SSD', tempC: 38, idle: false, mounts: ['C:', 'S:'] },
  { index: 2, name: 'USB', tempC: null, idle: false, mounts: ['E:'] },
  { index: 3, name: 'SSD2', tempC: 44, idle: false, mounts: ['S:'] },
];

test('driveTemp finds the disk holding a drive letter', () => {
  assert.equal(fmt.driveTemp('C:', DISK_TEMPS), '38 °C');
  assert.equal(fmt.driveTemp('G:', DISK_TEMPS), '35 °C (idle)');
  assert.equal(fmt.driveTemp('d:', DISK_TEMPS), '35 °C (idle)');
});

test('driveTemp takes the hottest disk of a spanned volume', () => {
  assert.equal(fmt.driveTemp('S:', DISK_TEMPS), '44 °C');
});

test('driveTemp is null without a reading, a matching disk or any data', () => {
  assert.equal(fmt.driveTemp('E:', DISK_TEMPS), null);
  assert.equal(fmt.driveTemp('Z:', DISK_TEMPS), null);
  assert.equal(fmt.driveTemp('/', null), null);
  assert.equal(fmt.driveTemp('C:', [{ index: 0, name: 'X', tempC: 30, idle: false }]), null);
});
