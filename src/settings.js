const $ = (id) => document.getElementById(id);
const FIELDS = ['mode', 'printer', 'usbDevice', 'netHost', 'netPort', 'cut', 'drawer', 'threshold', 'paper', 'customWidthMm', 'printableMm', 'offsetMm', 'scale', 'copies', 'forceBlack', 'autoStart', 'port', 'allowedOrigins'];
let papers = {};

function readForm() {
  const c = {};
  for (const f of FIELDS) {
    const el = $(f);
    c[f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  }
  return c;
}

function fillForm(c) {
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === 'checkbox') el.checked = !!c[f];
    else el.value = c[f] ?? '';
  }
  toggleMode();
}

const HINTS = {
  driver: 'Usa el driver instalado en Windows (impresoras que aparecen en Configuración > Impresoras).',
  usb: 'Para impresoras térmicas conectadas por USB sin driver de Windows (como en Poster). Requiere driver WinUSB/libusbK.',
  raw: 'Envía comandos ESC/POS a una impresora de Windows (p. ej. "Generic / Text Only" en el puerto USB de la térmica).',
  net: 'Impresoras térmicas con cable de red o WiFi (puerto 9100).',
};

function toggleMode() {
  const m = $('mode').value;
  $('winWrap').classList.toggle('hidden', !['driver', 'raw'].includes(m));
  $('usbWrap').classList.toggle('hidden', m !== 'usb');
  $('netWrap').classList.toggle('hidden', m !== 'net');
  $('escposWrap').classList.toggle('hidden', m === 'driver');
  $('hint').textContent = HINTS[m] || '';
  if (m !== 'driver' && !['58', '80', 'custom'].includes($('paper').value)) {
    $('paper').value = '80';
    $('printableMm').value = 72;
  }
  [...$('paper').options].forEach((o) => { o.disabled = m !== 'driver' && !['58', '80', 'custom'].includes(o.value); });
  toggleThermal();
}

async function loadUsb(selected) {
  const sel = $('usbDevice');
  sel.innerHTML = '<option value="">Buscando…</option>';
  const list = await window.agent.getUsb();
  sel.innerHTML = list.length ? '' : '<option value="">No se encontraron impresoras USB</option>';
  for (const p of list) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  if (selected && !list.some((p) => p.id === selected)) {
    const o = document.createElement('option');
    o.value = selected;
    o.textContent = `USB ${selected} (no conectada)`;
    sel.appendChild(o);
  }
  if (selected) sel.value = selected;
}

function toggleThermal() {
  const p = $('paper').value;
  $('thermal').classList.toggle('hidden', !['58', '80', 'custom'].includes(p));
  $('customWrap').classList.toggle('hidden', p !== 'custom');
}

function msg(text, kind) {
  $('msg').textContent = text;
  $('msg').className = kind || '';
}

async function loadPrinters(selected) {
  const sel = $('printer');
  sel.innerHTML = '<option value="">Predeterminada del sistema</option>';
  const list = await window.agent.getPrinters();
  for (const p of list) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.displayName + (p.isDefault ? ' (predeterminada)' : '');
    sel.appendChild(o);
  }
  if (selected && !list.some((p) => p.name === selected)) {
    const o = document.createElement('option');
    o.value = selected;
    o.textContent = `${selected} (no conectada)`;
    sel.appendChild(o);
  }
  sel.value = selected || '';
}

function renderStatus(s) {
  const el = $('status');
  if (s.listening) { el.textContent = `Activo · 127.0.0.1:${s.port}`; el.className = 'pill ok'; }
  else { el.textContent = s.error || 'Detenido'; el.className = 'pill err'; }
}

function renderJobs(jobs) {
  const ul = $('jobs');
  ul.innerHTML = '';
  if (!jobs.length) { ul.innerHTML = '<li>Sin impresiones</li>'; return; }
  for (const j of jobs) {
    const li = document.createElement('li');
    const a = document.createElement('span');
    a.textContent = `${j.at} · ${j.printer}`;
    const b = document.createElement('span');
    b.className = j.ok ? 'o' : 'e';
    b.textContent = j.ok ? `OK ${j.ms} ms` : j.error;
    li.append(a, b);
    ul.appendChild(li);
  }
}

$('paper').addEventListener('change', () => {
  const p = papers[$('paper').value];
  if (p?.printableMm) $('printableMm').value = p.printableMm;
  if ($('paper').value === 'custom') $('printableMm').value = Math.max(20, Number($('customWidthMm').value) - 8);
  toggleThermal();
});

$('refresh').addEventListener('click', () => loadPrinters($('printer').value));
$('refreshUsb').addEventListener('click', () => loadUsb($('usbDevice').value));
$('mode').addEventListener('change', toggleMode);

$('save').addEventListener('click', async () => {
  fillForm(await window.agent.saveConfig(readForm()));
  msg('Configuración guardada', 'ok');
});

$('test').addEventListener('click', async () => {
  $('test').disabled = true;
  msg('Imprimiendo…');
  const r = await window.agent.testPrint(readForm());
  $('test').disabled = false;
  msg(r.ok ? 'Prueba enviada a la impresora' : `Error: ${r.error}`, r.ok ? 'ok' : 'err');
});

(async () => {
  const { config, papers: p, modes } = await window.agent.getConfig();
  papers = p;
  $('mode').innerHTML = Object.entries(modes).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('paper').innerHTML = Object.entries(p).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  await Promise.all([loadPrinters(config.printer), loadUsb(config.usbDevice)]);
  fillForm(config);
  renderStatus(await window.agent.getStatus());
  renderJobs(await window.agent.getJobs());
  window.agent.onStatus(renderStatus);
  window.agent.onJobs(renderJobs);
})();
