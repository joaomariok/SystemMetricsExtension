const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SOURCE = path.join(__dirname, '..', 'src', 'temps.cs');
const NEVER = 2147483647; // int.MaxValue: the disk was never read

// Loads src/temps.cs the way counters.ps1 does, runs body and parses its JSON output.
function ps(body) {
  const script = `Add-Type -Path '${SOURCE}'; ${body}`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return JSON.parse(out);
}

const lit = (v) => (v == null ? '$null' : typeof v === 'boolean' ? `$${v}` : String(v));

function shouldQuery(cases) {
  const calls = cases.map((args) => `[Temps]::ShouldQuery(${args.map(lit).join(', ')})`).join(', ');
  return ps(`ConvertTo-Json -Compress @(${calls})`);
}

// Feeds one drive through Record tick by tick: steps are [tick, queried, reading, active].
function record(spins, steps) {
  const calls = steps
    .map(
      ([tick, queried, reading, active]) =>
        `$r = [Temps]::Record($d, 0, ${tick}, ${lit(queried)}, ${lit(reading)}, ${lit(active)}); ` +
        `$out += ,@{ c = $r.C; idle = $r.Idle; unsupported = $d.Unsupported }`,
    )
    .join('; ');
  return ps(
    `$d = New-Object 'Temps+Drive'; $d.Name = 'X'; $d.Spins = $${spins}; $out = @(); ${calls}; ` +
      'ConvertTo-Json -Compress -InputObject $out',
  );
}

if (process.platform === 'win32') {
  test('ShouldQuery reads a drive that does not spin whenever it is due', { timeout: 30000 }, () => {
    assert.deepEqual(
      shouldQuery([
        [false, true, false, 10],
        [false, false, null, NEVER],
        [false, true, true, 9],
      ]),
      [true, true, false],
    );
  });

  test('ShouldQuery reads a spinning drive only while it is on and active', { timeout: 30000 }, () => {
    assert.deepEqual(
      shouldQuery([
        [true, true, true, 10],
        [true, true, true, NEVER],
        [true, true, false, NEVER],
        [true, false, true, NEVER],
        [true, true, true, 3],
      ]),
      [true, true, false, false, false],
    );
  });

  test('ShouldQuery never reads a spinning drive without activity counters', { timeout: 30000 }, () => {
    assert.deepEqual(
      shouldQuery([
        [true, true, null, NEVER],
        [true, true, null, 600],
        [true, false, null, NEVER],
      ]),
      [false, false, false],
    );
  });

  test('Record lists a spinning drive before its first reading and marks it idle once due', { timeout: 30000 }, () => {
    assert.deepEqual(
      record(true, [
        [0, false, null, false], // idle at startup: N/A (idle)
        [1, true, 36, true], // busy: read
        [5, false, null, false], // not due yet: plain value
        [11, false, null, false], // due but idle: last value (idle)
        [12, false, null, null], // counters gone: not called idle
      ]),
      [
        { c: 0, idle: true, unsupported: false },
        { c: 36, idle: false, unsupported: false },
        { c: 36, idle: false, unsupported: false },
        { c: 36, idle: true, unsupported: false },
        { c: 36, idle: false, unsupported: false },
      ],
    );
  });

  test('Record keeps the last value when a query fails after earlier readings', { timeout: 30000 }, () => {
    assert.deepEqual(
      record(false, [
        [0, true, 40, null],
        [10, true, null, null], // transient failure
        [20, true, 41, null], // retried when due
      ]),
      [
        { c: 40, idle: false, unsupported: false },
        { c: 40, idle: false, unsupported: false },
        { c: 41, idle: false, unsupported: false },
      ],
    );
  });

  test('Record marks a drive that never answers unsupported and keeps listing it', { timeout: 30000 }, () => {
    assert.deepEqual(
      record(false, [
        [0, true, null, null],
        [10, false, null, null],
      ]),
      [
        { c: 0, idle: false, unsupported: true },
        { c: 0, idle: false, unsupported: true },
      ],
    );
  });

  test('Disks maps the system drive letter to a physical disk', { timeout: 30000 }, () => {
    const letter = process.env.SystemDrive || 'C:';
    const rows = ps(
      '$r = @([Temps]::Disks(0, $null) | ForEach-Object { @{ index = $_.Index; mounts = @($_.Mounts) } }); ' +
        'ConvertTo-Json -Compress -Depth 3 -InputObject $r',
    );
    const holders = rows.filter((r) => r.mounts.some((m) => m.toUpperCase() === letter.toUpperCase()));
    assert.equal(holders.length, 1, `exactly one disk holds ${letter}`);
  });

  test('Transfers maps counter instances to drive numbers', { timeout: 30000 }, () => {
    const out = ps(
      "$t = [Temps]::Transfers(@('0 d:', '1 c:', '12 e: f:', '_total', '3', 'x 4'), @(0, 71, 5, 76, 2, 9)); " +
        'ConvertTo-Json -Compress @($t[0], $t[1], $t[12], $t[3], $t[4], $t.Length)',
    );
    assert.deepEqual(out, [0, 71, 5, 2, 0, 32]);
  });

  test('Transfers returns null without per-disk instances', { timeout: 30000 }, () => {
    const out = ps(
      "ConvertTo-Json -Compress @(($null -eq [Temps]::Transfers(@('_total'), @(5))), " +
        '($null -eq [Temps]::Transfers($null, $null)))',
    );
    assert.deepEqual(out, [true, true]);
  });
}
