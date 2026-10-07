// Shared by the webview (as window.fmt) and by node tests (as a CommonJS module).
(function (root) {
  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

  function bytes(n) {
    if (n == null) return 'N/A';
    let i = 0;
    while (n >= 1024 && i < UNITS.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${UNITS[i]}`;
  }

  function rate(n) {
    return n == null ? 'N/A' : `${bytes(n)}/s`;
  }

  function pct(n) {
    return n == null ? 'N/A' : `${n.toFixed(1)}%`;
  }

  function uptime(sec) {
    if (sec == null) return 'N/A';
    sec = Math.floor(sec);
    const pad = (x) => String(x).padStart(2, '0');
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${d ? `${d}d ` : ''}${pad(h)}:${pad(m)}:${pad(sec % 60)}`;
  }

  const api = { bytes, rate, pct, uptime };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.fmt = api;
})(this);
