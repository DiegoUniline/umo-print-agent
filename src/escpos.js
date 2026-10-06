const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

/* ───────────── Comandos ESC/POS ───────────── */

const ESC = 0x1b;
const GS = 0x1d;
const RASTER_CHUNK_ROWS = 128;

/** raster: { widthBytes, height, data } con 1 bit por punto (1 = negro). */
function buildEscPos(raster, { cut = true, drawer = false, copies = 1, feedLines = 4 } = {}) {
  const parts = [Buffer.from([ESC, 0x40])];
  if (drawer) parts.push(Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]));
  for (let c = 0; c < copies; c++) {
    for (let y = 0; y < raster.height; y += RASTER_CHUNK_ROWS) {
      const rows = Math.min(RASTER_CHUNK_ROWS, raster.height - y);
      const xL = raster.widthBytes & 0xff;
      const xH = raster.widthBytes >> 8;
      parts.push(Buffer.from([GS, 0x76, 0x30, 0x00, xL, xH, rows & 0xff, rows >> 8]));
      parts.push(raster.data.subarray(y * raster.widthBytes, (y + rows) * raster.widthBytes));
    }
    parts.push(Buffer.from([ESC, 0x64, feedLines]));
    if (cut) parts.push(Buffer.from([GS, 0x56, 0x42, 0x00]));
  }
  return Buffer.concat(parts);
}

/** Convierte filas BGRA (ancho = dots) a raster monocromo, recortando blancos al final. */
function rowsToRaster(bgraRows, dots, threshold) {
  const widthBytes = Math.ceil(dots / 8);
  const packed = bgraRows.map((row) => {
    const out = Buffer.alloc(widthBytes);
    for (let x = 0; x < dots; x++) {
      const i = x * 4;
      const a = row[i + 3] / 255;
      const lum = (row[i + 2] * 299 + row[i + 1] * 587 + row[i] * 114) / 1000;
      const v = lum * a + 255 * (1 - a);
      if (v < threshold) out[x >> 3] |= 0x80 >> (x & 7);
    }
    return out;
  });
  let end = packed.length;
  while (end > 0 && packed[end - 1].every((b) => b === 0)) end--;
  return { widthBytes, height: end, data: Buffer.concat(packed.slice(0, end)) };
}

/* ───────────── Transportes ───────────── */

let usbLib;
let usbLoadError = '';
function getUsb() {
  if (usbLib === undefined) {
    try {
      usbLib = require('usb');
    } catch (err) {
      usbLib = null;
      usbLoadError = err.message;
    }
  }
  return usbLib;
}

const hex4 = (n) => n.toString(16).padStart(4, '0');

function isPrinterDevice(dev) {
  try {
    const cfg = dev.configDescriptor;
    return !!cfg && cfg.interfaces.some((alts) => alts.some((i) => i.bInterfaceClass === 7));
  } catch {
    return false;
  }
}

function readProductName(dev) {
  return new Promise((resolve) => {
    const idx = dev.deviceDescriptor.iProduct;
    if (!idx) return resolve('');
    try {
      dev.open();
    } catch {
      return resolve('');
    }
    dev.getStringDescriptor(idx, (err, s) => {
      try { dev.close(); } catch { /* ignore */ }
      resolve(err ? '' : s || '');
    });
  });
}

async function listUsbPrinters() {
  const usb = getUsb();
  if (!usb) return [];
  const out = [];
  for (const dev of usb.getDeviceList()) {
    if (!isPrinterDevice(dev)) continue;
    const { idVendor, idProduct } = dev.deviceDescriptor;
    const id = `${hex4(idVendor)}:${hex4(idProduct)}`;
    const name = await readProductName(dev);
    out.push({ id, name: name ? `${name} (${id})` : `Impresora USB ${id}`, available: !!name });
  }
  return out;
}

function usbHelp(err) {
  const msg = String(err?.message || err);
  if (/NOT_SUPPORTED|ACCESS|NOT_FOUND|BUSY/i.test(msg)) {
    return `${msg}. La impresora USB debe tener driver WinUSB/libusbK (el mismo que usa Poster) y no estar ocupada por otro programa. Si tiene driver de Windows usa el modo "ESC/POS por Windows (RAW)".`;
  }
  return msg;
}

async function sendUsb(id, data) {
  const usb = getUsb();
  if (!usb) throw new Error(`Módulo USB no disponible: ${usbLoadError}`);
  const [vid, pid] = String(id).split(':').map((h) => parseInt(h, 16));
  const dev = usb.findByIds(vid, pid);
  if (!dev) throw new Error(`Impresora USB ${id} no conectada`);
  try {
    dev.open();
  } catch (err) {
    throw new Error(usbHelp(err));
  }
  try {
    const iface = dev.interfaces.find((i) => i.descriptor.bInterfaceClass === 7) || dev.interfaces[0];
    if (process.platform === 'linux') {
      try { if (iface.isKernelDriverActive()) iface.detachKernelDriver(); } catch { /* ignore */ }
    }
    try {
      iface.claim();
    } catch (err) {
      throw new Error(usbHelp(err));
    }
    const ep = iface.endpoints.find((e) => e.direction === 'out');
    if (!ep) throw new Error('La impresora USB no tiene endpoint de salida');
    ep.timeout = 15000;
    for (let i = 0; i < data.length; i += 16384) {
      const chunk = data.subarray(i, i + 16384);
      await new Promise((resolve, reject) => ep.transfer(chunk, (err) => (err ? reject(new Error(usbHelp(err))) : resolve())));
    }
    await new Promise((resolve) => iface.release(true, () => resolve()));
  } finally {
    try { dev.close(); } catch { /* ignore */ }
  }
}

function sendNet(host, port, data) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port: Number(port) || 9100 });
    sock.setTimeout(10000);
    sock.on('connect', () => sock.end(data));
    sock.on('timeout', () => { sock.destroy(); reject(new Error(`Sin respuesta de ${host}:${port}`)); });
    sock.on('error', (err) => reject(new Error(`Red ${host}:${port}: ${err.message}`)));
    sock.on('close', (hadErr) => { if (!hadErr) resolve(); });
  });
}

const RAW_PS1 = `param([string]$Printer, [string]$DataPath)
$ErrorActionPreference = 'Stop'
$src = @"
using System;
using System.Runtime.InteropServices;
public class UmoRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool OpenPrinter(string name, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);
  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("No se pudo abrir la impresora (" + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = "UMO Ticket"; di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) throw new Exception("StartDocPrinter (" + Marshal.GetLastWin32Error() + ")");
      StartPagePrinter(h);
      int w; bool ok = WritePrinter(h, data, data.Length, out w);
      EndPagePrinter(h); EndDocPrinter(h);
      if (!ok || w != data.Length) throw new Exception("WritePrinter (" + Marshal.GetLastWin32Error() + ")");
    } finally { ClosePrinter(h); }
  }
}
"@
if (-not ([System.Management.Automation.PSTypeName]'UmoRawPrinter').Type) { Add-Type -TypeDefinition $src }
[UmoRawPrinter]::Send($Printer, [System.IO.File]::ReadAllBytes($DataPath))
`;

function sendRawWindows(printer, data) {
  if (process.platform !== 'win32') return Promise.reject(new Error('El modo RAW solo funciona en Windows'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umo-raw-'));
  const ps1 = path.join(dir, 'raw.ps1');
  const bin = path.join(dir, 'ticket.bin');
  fs.writeFileSync(ps1, RAW_PS1, 'utf8');
  fs.writeFileSync(bin, data);
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Printer', printer, '-DataPath', bin],
      { windowsHide: true, timeout: 30000 },
      (err, _stdout, stderr) => {
        fs.rm(dir, { recursive: true, force: true }, () => {});
        if (err) reject(new Error((stderr || err.message).trim().split('\n')[0]));
        else resolve();
      },
    );
  });
}

module.exports = { buildEscPos, rowsToRaster, listUsbPrinters, sendUsb, sendNet, sendRawWindows };
