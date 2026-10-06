const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const escpos = require('./escpos');

const DEFAULT_PORT = 17777;
const PX_PER_MM = 96 / 25.4;
const MAX_BODY = 15 * 1024 * 1024;
const DOTS_PER_MM = 8;
const SLICE_PX = 1000;

const MODES = {
  driver: 'Driver de Windows',
  usb: 'ESC/POS USB directo',
  raw: 'ESC/POS por Windows (RAW)',
  net: 'ESC/POS por red (IP)',
};

const PAPERS = {
  '58': { label: 'Térmica 58 mm', widthMm: 58, printableMm: 48 },
  '80': { label: 'Térmica 80 mm', widthMm: 80, printableMm: 72 },
  custom: { label: 'Térmica personalizada' },
  Letter: { label: 'Carta', pageSize: 'Letter' },
  A4: { label: 'A4', pageSize: 'A4' },
  driver: { label: 'Tamaño del driver', pageSize: null },
};

const DEFAULT_CONFIG = {
  port: DEFAULT_PORT,
  mode: 'driver',
  printer: '',
  usbDevice: '',
  netHost: '',
  netPort: 9100,
  cut: true,
  drawer: false,
  threshold: 170,
  paper: '80',
  customWidthMm: 80,
  printableMm: 72,
  offsetMm: 0,
  scale: 100,
  copies: 1,
  forceBlack: true,
  autoStart: true,
  allowedOrigins: '',
};

let config = { ...DEFAULT_CONFIG };
let tray = null;
let settingsWin = null;
let server = null;
let serverError = '';
let queue = Promise.resolve();
const jobs = [];

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
}

function saveConfig(next) {
  const prevPort = config.port;
  config = { ...config, ...sanitize(next) };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
  applyAutoStart();
  if (prevPort !== config.port) startServer();
  return config;
}

function sanitize(c) {
  const num = (v, min, max, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  const out = {};
  if ('mode' in c) out.mode = MODES[c.mode] ? c.mode : 'driver';
  if ('printer' in c) out.printer = String(c.printer || '');
  if ('usbDevice' in c) out.usbDevice = String(c.usbDevice || '');
  if ('netHost' in c) out.netHost = String(c.netHost || '').trim();
  if ('netPort' in c) out.netPort = Math.round(num(c.netPort, 1, 65535, 9100));
  if ('cut' in c) out.cut = !!c.cut;
  if ('drawer' in c) out.drawer = !!c.drawer;
  if ('threshold' in c) out.threshold = Math.round(num(c.threshold, 50, 250, 170));
  if ('paper' in c) out.paper = PAPERS[c.paper] ? c.paper : '80';
  if ('customWidthMm' in c) out.customWidthMm = num(c.customWidthMm, 30, 120, 80);
  if ('printableMm' in c) out.printableMm = num(c.printableMm, 20, 120, 72);
  if ('offsetMm' in c) out.offsetMm = num(c.offsetMm, -10, 20, 0);
  if ('scale' in c) out.scale = Math.round(num(c.scale, 30, 200, 100));
  if ('copies' in c) out.copies = Math.round(num(c.copies, 1, 10, 1));
  if ('forceBlack' in c) out.forceBlack = !!c.forceBlack;
  if ('autoStart' in c) out.autoStart = !!c.autoStart;
  if ('allowedOrigins' in c) out.allowedOrigins = String(c.allowedOrigins || '');
  if ('port' in c) out.port = Math.round(num(c.port, 1024, 65535, DEFAULT_PORT));
  return out;
}

function applyAutoStart() {
  if (process.platform === 'linux') return;
  app.setLoginItemSettings({ openAtLogin: !!config.autoStart, args: ['--hidden'] });
}

/* ───────────── Impresión ───────────── */

function paperSpec(cfg) {
  if (cfg.paper === '58' || cfg.paper === '80') {
    const p = PAPERS[cfg.paper];
    return { thermal: true, widthMm: p.widthMm, printableMm: Math.min(cfg.printableMm || p.printableMm, p.widthMm) };
  }
  if (cfg.paper === 'custom') {
    return { thermal: true, widthMm: cfg.customWidthMm, printableMm: Math.min(cfg.printableMm, cfg.customWidthMm) };
  }
  return { thermal: false, pageSize: PAPERS[cfg.paper]?.pageSize ?? null };
}

function injectCss(html, css) {
  const tag = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'"><style id="__umo_print">${css}</style>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${tag}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${tag}</head><body>${html}</body></html>`;
}

function buildCss(spec, cfg) {
  let css = '*{-webkit-print-color-adjust:exact;print-color-adjust:exact}';
  if (cfg.forceBlack) css += '*{color:#000 !important}';
  if (spec.thermal) {
    css += `@page{size:${spec.widthMm}mm auto;margin:0}
html{margin:0 !important;padding:0 !important;width:${spec.widthMm}mm !important}
body{box-sizing:border-box;width:${spec.printableMm}mm !important;max-width:${spec.printableMm}mm !important;margin:0 0 0 ${cfg.offsetMm}mm !important;word-wrap:break-word}
html{overflow-x:hidden !important}::-webkit-scrollbar{display:none}
img{max-width:100%}`;
  }
  return css;
}

function printHtml(html, overrides = {}) {
  const job = () => doPrint(html, overrides);
  const p = queue.then(job, job);
  queue = p.catch(() => {});
  return p;
}

async function doPrint(html, overrides) {
  const cfg = { ...config, ...sanitize(overrides) };
  if (cfg.mode !== 'driver') return doPrintEscPos(html, cfg);
  const spec = paperSpec(cfg);
  const started = Date.now();
  const tmp = path.join(os.tmpdir(), `umo-print-${started}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(tmp, injectCss(html, buildCss(spec, cfg)), 'utf8');

  const widthPx = Math.ceil((spec.thermal ? spec.widthMm : 216) * PX_PER_MM);
  const win = new BrowserWindow({
    show: false,
    width: widthPx,
    height: 100,
    useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  try {
    await win.loadFile(tmp);
    const printers = await win.webContents.getPrintersAsync();
    const deviceName = cfg.printer && printers.some((p) => p.name === cfg.printer) ? cfg.printer : undefined;
    if (cfg.printer && !deviceName) throw new Error(`Impresora no encontrada: ${cfg.printer}`);

    const opts = {
      silent: true,
      printBackground: true,
      deviceName,
      copies: cfg.copies,
      scaleFactor: cfg.scale,
      margins: { marginType: spec.thermal ? 'none' : 'default' },
    };

    if (spec.thermal) {
      const heightPx = await win.webContents.executeJavaScript(
        'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)', true,
      );
      const heightMm = Math.min(5000, Math.max(30, (heightPx / PX_PER_MM) * (cfg.scale / 100) + 6));
      opts.pageSize = { width: Math.round(spec.widthMm * 1000), height: Math.round(heightMm * 1000) };
    } else if (spec.pageSize) {
      opts.pageSize = spec.pageSize;
    } else {
      opts.usePrinterDefaultPageSize = true;
    }

    await new Promise((resolve, reject) => {
      win.webContents.print(opts, (ok, reason) => (ok ? resolve() : reject(new Error(reason || 'Fallo de impresión'))));
    });
    logJob({ ok: true, printer: deviceName || '(predeterminada)', ms: Date.now() - started });
    return { ok: true, printer: deviceName || null };
  } catch (err) {
    logJob({ ok: false, printer: cfg.printer || '(predeterminada)', error: err.message });
    throw err;
  } finally {
    if (!win.isDestroyed()) win.destroy();
    fs.rm(tmp, { force: true }, () => {});
  }
}

function escposTargetLabel(cfg) {
  if (cfg.mode === 'usb') return `USB ${cfg.usbDevice || '?'}`;
  if (cfg.mode === 'net') return `${cfg.netHost || '?'}:${cfg.netPort}`;
  return `RAW ${cfg.printer || '?'}`;
}

async function doPrintEscPos(html, cfg) {
  const started = Date.now();
  const target = escposTargetLabel(cfg);
  try {
    const spec = paperSpec(cfg).thermal ? paperSpec(cfg) : paperSpec({ ...cfg, paper: '80' });
    const raster = await renderRaster(html, cfg, spec);
    const data = escpos.buildEscPos(raster, { cut: cfg.cut, drawer: cfg.drawer, copies: cfg.copies });
    if (cfg.mode === 'usb') {
      if (!cfg.usbDevice) throw new Error('Selecciona la impresora USB');
      await escpos.sendUsb(cfg.usbDevice, data);
    } else if (cfg.mode === 'net') {
      if (!cfg.netHost) throw new Error('Escribe la IP de la impresora');
      await escpos.sendNet(cfg.netHost, cfg.netPort, data);
    } else {
      if (!cfg.printer) throw new Error('Selecciona la impresora de Windows');
      await escpos.sendRawWindows(cfg.printer, data);
    }
    logJob({ ok: true, printer: target, ms: Date.now() - started });
    return { ok: true, printer: target };
  } catch (err) {
    logJob({ ok: false, printer: target, error: err.message });
    throw err;
  }
}

/** Renderiza el HTML a 203 dpi (8 puntos/mm) y lo devuelve como raster monocromo. */
async function renderRaster(html, cfg, spec) {
  const dots = Math.floor((spec.printableMm * DOTS_PER_MM) / 8) * 8;
  const zoom = dots / (spec.printableMm * PX_PER_MM);
  const offsetDots = Math.max(0, Math.round(cfg.offsetMm * DOTS_PER_MM));
  const widthDots = dots + offsetDots;
  const tmp = path.join(os.tmpdir(), `umo-raster-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  const css = buildCss(spec, { ...cfg, offsetMm: 0 }) + `html,body{background:#fff !important}`;
  fs.writeFileSync(tmp, injectCss(html, css), 'utf8');

  const win = new BrowserWindow({
    show: false,
    width: Math.ceil(dots),
    height: SLICE_PX,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, zoomFactor: zoom },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  try {
    await win.loadFile(tmp);
    win.webContents.setZoomFactor(zoom);
    await new Promise((r) => setTimeout(r, 80));
    const { total, view, cssWidth } = await win.webContents.executeJavaScript(
      '({ total: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)), view: window.innerHeight, cssWidth: window.innerWidth })',
      true,
    );
    const rows = [];
    for (let y = 0; y < total; y += view) {
      const actual = await win.webContents.executeJavaScript(`window.scrollTo(0, ${y}); window.scrollY`, true);
      await new Promise((r) => setTimeout(r, 60));
      let img = await win.webContents.capturePage();
      if (img.getSize().width !== dots) img = img.resize({ width: dots, quality: 'best' });
      const { width, height } = img.getSize();
      const k = width / cssWidth;
      const start = Math.max(0, Math.round((y - actual) * k));
      const end = Math.min(height, Math.round((Math.min(total, actual + view) - actual) * k));
      const bmp = img.toBitmap();
      for (let r = start; r < end; r++) {
        const row = Buffer.alloc(widthDots * 4, 0xff);
        bmp.copy(row, offsetDots * 4, r * width * 4, (r + 1) * width * 4);
        rows.push(row);
      }
    }
    const raster = escpos.rowsToRaster(rows, widthDots, cfg.threshold);
    if (!raster.height) throw new Error('El ticket salió vacío');
    return raster;
  } finally {
    if (!win.isDestroyed()) win.destroy();
    fs.rm(tmp, { force: true }, () => {});
  }
}

function logJob(j) {
  jobs.unshift({ ...j, at: new Date().toLocaleString('es-MX') });
  jobs.length = Math.min(jobs.length, 30);
  settingsWin?.webContents.send('jobs', jobs);
}

function testTicketHtml(cfg) {
  const spec = paperSpec(cfg);
  const ruler = spec.thermal
    ? `<div style="box-sizing:border-box;width:100%;border:1px solid #000;height:8mm;position:relative;margin:2mm 0;overflow:hidden">${Array.from({ length: Math.floor(spec.printableMm / 5) + 1 }, (_, i) => `<span style="position:absolute;left:${i * 5}mm;top:0;height:${i % 2 ? 2 : 4}mm;border-left:1px solid #000"></span>`).join('')}<span style="position:absolute;bottom:0;left:1mm;font-size:9px">0</span><span style="position:absolute;bottom:0;right:1mm;font-size:9px">${spec.printableMm} mm</span></div>`
    : '';
  const desc = PAPERS[cfg.paper]?.label || cfg.paper;
  return `<html><head><meta charset="utf-8"><style>body{font-family:monospace;font-size:12px;padding:0}.p{padding:0 2mm}.c{text-align:center}hr{border:none;border-top:1px dashed #000;margin:6px 0}table{width:100%}.r{text-align:right}</style></head><body>${ruler}<div class="p">
<div class="c"><h2 style="margin:0">UMO</h2><p style="margin:2px 0">PRUEBA DE IMPRESIÓN</p></div><hr>
<p>Modo: ${escapeHtml(MODES[cfg.mode] || cfg.mode)}</p>
<p>Impresora: ${escapeHtml(cfg.mode === 'driver' ? cfg.printer || '(predeterminada)' : escposTargetLabel(cfg))}</p>
<p>Papel: ${escapeHtml(desc)}${spec.thermal ? ` · imprimible ${spec.printableMm} mm` : ''}</p>
<p>Escala: ${cfg.scale}% · Copias: ${cfg.copies}</p>
<p>Fecha: ${new Date().toLocaleString('es-MX')}</p><hr>
<table><tr><td>1x Producto de prueba</td><td class="r">$100.00</td></tr><tr><td>2x Artículo con nombre largo para probar el corte</td><td class="r">$250.50</td></tr></table><hr>
<table><tr><td><b>TOTAL</b></td><td class="r"><b>$350.50</b></td></tr></table><hr>
<p>ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789</p>
<div class="c"><p>Si la regla se ve completa,<br>el ancho es correcto.</p></div></div>${ruler}</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function listPrinters() {
  const w = settingsWin && !settingsWin.isDestroyed() ? settingsWin : new BrowserWindow({ show: false });
  try {
    const list = await w.webContents.getPrintersAsync();
    return list.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!(p.isDefault || p.options?.['printer-is-default'] === 'true'), status: p.status }));
  } finally {
    if (w !== settingsWin) w.destroy();
  }
}

/* ───────────── Servidor HTTP local ───────────── */

function originAllowed(origin) {
  const list = config.allowedOrigins.split(/[\s,]+/).map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  if (!list.length || !origin) return true;
  return list.some((o) => o === '*' || o === origin || (o.startsWith('*.') && origin.endsWith(o.slice(1))));
}

function send(res, status, data, origin) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  });
  res.end(data === undefined ? '' : JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Contenido demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const origin = req.headers.origin;
  if (!originAllowed(origin)) return send(res, 403, { ok: false, error: 'Origen no permitido' });
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'OPTIONS') return send(res, 204, undefined, origin);

  if (req.method === 'GET' && url.pathname === '/status') {
    return send(res, 200, { ok: true, app: 'umo-print-agent', version: app.getVersion(), mode: config.mode, printer: config.mode === 'driver' ? config.printer || null : escposTargetLabel(config), paper: config.paper }, origin);
  }
  if (req.method === 'GET' && url.pathname === '/printers') {
    return send(res, 200, { ok: true, printers: await listPrinters(), usb: await escpos.listUsbPrinters() }, origin);
  }
  if (req.method === 'POST' && url.pathname === '/print') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body || typeof body.html !== 'string' || !body.html.trim()) return send(res, 400, { ok: false, error: 'Falta html' }, origin);
      const { html, ...overrides } = body;
      const r = await printHtml(html, overrides);
      return send(res, 200, r, origin);
    } catch (err) {
      return send(res, 500, { ok: false, error: err.message }, origin);
    }
  }
  if (req.method === 'POST' && url.pathname === '/test') {
    try {
      return send(res, 200, await printHtml(testTicketHtml(config)), origin);
    } catch (err) {
      return send(res, 500, { ok: false, error: err.message }, origin);
    }
  }
  return send(res, 404, { ok: false, error: 'No encontrado' }, origin);
}

function startServer() {
  if (server) server.close();
  serverError = '';
  server = http.createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, { ok: false, error: err.message }));
  });
  server.on('error', (err) => {
    serverError = err.code === 'EADDRINUSE' ? `El puerto ${config.port} ya está en uso` : err.message;
    settingsWin?.webContents.send('status', status());
  });
  server.listen(config.port, '127.0.0.1', () => settingsWin?.webContents.send('status', status()));
}

function status() {
  return { listening: !!server?.listening, port: config.port, error: serverError, version: app.getVersion() };
}

/* ───────────── UI ───────────── */

function trayIcon() {
  return nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 760,
    title: 'UMO Print Agent',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      settingsWin.hide();
    }
  });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('UMO Print Agent');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Configuración', click: openSettings },
    { label: 'Imprimir prueba', click: () => printHtml(testTicketHtml(config)).catch((e) => notify(e.message)) },
    { type: 'separator' },
    { label: 'Salir', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', openSettings);
}

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: 'UMO Print Agent', body }).show();
}

ipcMain.handle('get-config', () => ({ config, papers: PAPERS, modes: MODES }));
ipcMain.handle('get-usb', () => escpos.listUsbPrinters());
ipcMain.handle('save-config', (_e, c) => saveConfig(c));
ipcMain.handle('get-printers', () => listPrinters());
ipcMain.handle('get-status', () => status());
ipcMain.handle('get-jobs', () => jobs);
ipcMain.handle('test-print', async (_e, c) => {
  const cfg = { ...config, ...sanitize(c || {}) };
  try {
    await printHtml(testTicketHtml(cfg), cfg);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', openSettings);
  app.whenReady().then(() => {
    loadConfig();
    applyAutoStart();
    startServer();
    createTray();
    if (!process.argv.includes('--hidden')) openSettings();
  });
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { app.isQuitting = true; });
}
