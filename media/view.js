(function () {
  const vscode = acquireVsCodeApi();
  const POINTS = 60;
  const root = document.getElementById('root');
  let graphs = [];

  const BLUE = ['--vscode-charts-blue', '#3794ff'];
  const PURPLE = ['--vscode-charts-purple', '#b180d7'];
  const GREEN = ['--vscode-charts-green', '#89d185'];
  const ORANGE = ['--vscode-charts-orange', '#d18616'];
  const YELLOW = ['--vscode-charts-yellow', '#cca700'];

  function el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function section(title, parent = root) {
    const box = el('section', 'section', parent);
    const head = el('div', 'head', box);
    const name = el('span', 'name', head);
    el('span', 'title', name, title);
    const temp = el('span', 'temp', name);
    const value = el('span', 'value', head, 'N/A');
    return { box, value, temp };
  }

  function cssVar([name, fallback]) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  // max: fixed scale (percent graphs) or null to auto-scale (network, floor 1 KB/s).
  function graph(parent, colors, max) {
    const g = { canvas: el('canvas', 'graph', parent), colors, max, hist: colors.map(() => []) };
    graphs.push(g);
    return g;
  }

  function push(g, values) {
    values.forEach((v, i) => {
      const h = g.hist[i];
      h.push(v == null ? 0 : v);
      if (h.length > POINTS) h.shift();
    });
    draw(g);
  }

  function draw(g) {
    const { canvas } = g;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = cssVar(['--vscode-panel-border', 'rgba(128,128,128,0.35)']);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const y = Math.round((h * i) / 4) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    for (let i = 1; i < 6; i++) {
      const x = Math.round((w * i) / 6) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    ctx.stroke();

    const max = g.max ?? Math.max(1024, ...g.hist.flat());
    const step = w / (POINTS - 1);
    g.hist.forEach((hist, k) => {
      if (!hist.length) return;
      const color = cssVar(g.colors[k]);
      const x0 = w - (hist.length - 1) * step;
      const y = (v) => h - 1 - (Math.min(v, max) / max) * (h - 2);
      ctx.beginPath();
      hist.forEach((v, i) => (i ? ctx.lineTo(x0 + i * step, y(v)) : ctx.moveTo(x0, y(v))));
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineTo(w, h);
      ctx.lineTo(x0, h);
      ctx.closePath();
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    });
  }

  function bar(parent, label) {
    const row = el('div', 'bar-row', parent);
    const text = el('div', 'bar-label', row);
    const name = el('span', 'name', text);
    el('span', 'title', name, label);
    const temp = el('span', 'temp', name);
    const value = el('span', null, text, 'N/A');
    const fill = el('div', 'fill', el('div', 'bar', row));
    return { value, fill, temp };
  }

  function setBar(b, used, total, text) {
    b.fill.style.width = `${used != null && total ? Math.min(100, (used / total) * 100) : 0}%`;
    b.value.textContent = text;
  }

  // Temperature sits after the name, so the main value keeps the right edge.
  const showTemp = (target, text) => (target.temp.textContent = text ? ` · ${text}` : '');

  const usedOf = (part) => (part ? `${fmt.bytes(part.used)} / ${fmt.bytes(part.total)}` : 'N/A');

  function info(label, parent) {
    const row = el('div', 'info', parent);
    el('span', null, row, label);
    return el('span', 'value', row, 'N/A');
  }

  // Layout, top to bottom.
  const cpu = section('CPU');
  const cpuGraph = graph(cpu.box, [BLUE], 100);
  const coresBox = el('div', 'cores', cpu.box);
  coresBox.style.display = 'none'; // shown only when the systemMetrics.showCores setting is on
  let coreBars = [];

  const mem = section('Memory');
  const memGraph = graph(mem.box, [PURPLE], 100);

  const gpuBox = el('div', null, root);
  let gpuKey = null;
  let gpuViews = [];

  const disk = section('Disk');
  const diskGraph = graph(disk.box, [GREEN], 100);
  const drivesBox = el('div', null, disk.box);
  let drivesKey = null;
  let driveBars = [];
  let drives = [];
  let diskTemps = null;

  const net = section('Network');
  const netGraph = graph(net.box, [ORANGE, BLUE], null);

  const footer = el('section', 'section footer', root);
  const battery = info('Battery', footer);
  const temp = info('CPU temperature', footer);
  const uptime = info('Uptime', footer);

  function renderCpu({ total, cores }) {
    cpu.value.textContent = fmt.pct(total);
    push(cpuGraph, [total]);
    if (coreBars.length !== cores.length) {
      coresBox.replaceChildren();
      coreBars = cores.map((_, i) => bar(coresBox, `Core ${i}`));
    }
    cores.forEach((v, i) => setBar(coreBars[i], v, 100, fmt.pct(v)));
  }

  function renderMem({ used, total }) {
    mem.value.textContent = `${fmt.bytes(used)} / ${fmt.bytes(total)}`;
    push(memGraph, [total ? (used / total) * 100 : null]);
  }

  function renderGpu(list) {
    const key = list ? list.map((g) => g.name).join('|') : 'none';
    if (key !== gpuKey) {
      gpuKey = key;
      graphs = graphs.filter((g) => !gpuViews.some((v) => v.graph === g));
      gpuBox.replaceChildren();
      gpuViews = (list || []).map((g) => {
        const s = section(g.name, gpuBox);
        return {
          s,
          graph: graph(s.box, [YELLOW], 100),
          dedicated: bar(s.box, 'Dedicated memory'),
          shared: bar(s.box, 'Shared memory'),
        };
      });
      if (!list) section('GPU', gpuBox);
    }
    (list || []).forEach((g, i) => {
      const v = gpuViews[i];
      v.s.value.textContent = fmt.pct(g.util);
      showTemp(v.s, fmt.temp(g.tempC));
      push(v.graph, [g.util]);
      setBar(v.dedicated, g.dedicated?.used, g.dedicated?.total, usedOf(g.dedicated));
      setBar(v.shared, g.shared?.used, g.shared?.total, usedOf(g.shared));
    });
  }

  function renderDisk({ active }) {
    disk.value.textContent = fmt.pct(active);
    push(diskGraph, [active]);
  }

  // Drive space (every 10s) and disk temperatures (every second on Windows) arrive
  // separately; each re-renders the bars with the latest of both.
  function renderDrives() {
    const key = drives.map((d) => d.mount).join('|');
    if (key !== drivesKey) {
      drivesKey = key;
      drivesBox.replaceChildren();
      driveBars = drives.map((d) => bar(drivesBox, d.mount));
    }
    drives.forEach((d, i) => {
      setBar(driveBars[i], d.used, d.size, `${fmt.bytes(d.used)} / ${fmt.bytes(d.size)}`);
      showTemp(driveBars[i], fmt.driveTemp(d.mount, diskTemps));
    });
  }

  function renderNet({ rxSec, txSec }) {
    net.value.textContent = `↓ ${fmt.rate(rxSec)}  ↑ ${fmt.rate(txSec)}`;
    push(netGraph, [rxSec, txSec]);
  }

  window.addEventListener('message', ({ data: m }) => {
    if (m.settings) coresBox.style.display = m.settings.showCores ? '' : 'none';
    if (m.cpu) renderCpu(m.cpu);
    if (m.mem) renderMem(m.mem);
    if ('gpu' in m) renderGpu(m.gpu);
    if (m.disk) renderDisk(m.disk);
    if (m.disks) drives = m.disks;
    if ('diskTemps' in m) diskTemps = m.diskTemps;
    if (m.disks || 'diskTemps' in m) renderDrives();
    if (m.net) renderNet(m.net);
    if ('battery' in m) {
      battery.textContent = m.battery ? `${m.battery.percent}%${m.battery.charging ? ' (charging)' : ''}` : 'N/A';
    }
    if ('tempC' in m) temp.textContent = m.tempC == null ? 'N/A' : `${Math.round(m.tempC)} °C`;
    if ('uptimeSec' in m) uptime.textContent = fmt.uptime(m.uptimeSec);
  });

  new ResizeObserver(() => graphs.forEach(draw)).observe(root);
  vscode.postMessage('ready');
})();
