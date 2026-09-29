import { PanoramaViewer } from './viewer.js';

const $ = (id) => document.getElementById(id);
const IMAGE = /\.(jpe?g|png|tiff?)$/i;
const CSV = /\.csv$/i;
const RAW = /\.(dng|raw|arw|cr2|cr3|nef|orf|rw2)$/i;
const TIME_HINTS = {
  2000: 'Preview usually takes 4–8 minutes.',
  4000: 'High usually takes 6–12 minutes and needs more memory.',
};
// Progress milestones for the messages stitch.py and alignment.py report.
const pairsBefore = (k, n) => k * n - (k * (k + 1)) / 2;
const STAGES = [
  [/^Finding detail (\d+)\/(\d+)/, (i, n) => 2 + (13 * i) / n],
  [/^Matching detail (\d+)\/(\d+)/, (i, n) => 15 + (60 * pairsBefore(i - 1, n)) / ((n * (n - 1)) / 2)],
  [/^Refining/, () => 76],
  [/^Median alignment error/, () => 80],
  [/^Blending aligned photo (\d+)\/(\d+)/, (i, n) => 80 + (18 * i) / n],
  [/^Loaded (\d+)\/(\d+)/, (i, n) => 5 + (30 * i) / n],
  [/^Matching and blending/, () => 40],
  [/^Saved /, () => 100],
];

const viewer = new PanoramaViewer($('viewer-canvas'), $('viewer'));
let chosen = { images: [], csv: [], raw: 0, folder: '' };
let worker = null;
let running = false;
let startedAt = 0;
let clock = 0;
let saved = '';
let urls = [];

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
const minutes = (ms) => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

function note(text, kind = '') {
  const p = document.createElement('p');
  p.className = `note ${kind}`.trim();
  p.textContent = text;
  return p;
}

// ---- Choosing the capture ----

function choose(files, folder = '') {
  if (running) return;
  const images = [];
  const csv = [];
  let raw = 0;
  for (const file of files) {
    // Like the desktop app, use only the files directly inside the chosen folder.
    if (file.webkitRelativePath && file.webkitRelativePath.split('/').length > 2) continue;
    if (IMAGE.test(file.name)) images.push(file);
    else if (CSV.test(file.name)) csv.push(file);
    else if (RAW.test(file.name)) raw += 1;
  }
  images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  folder ||= files[0]?.webkitRelativePath?.split('/')[0] || '';
  chosen = { images, csv, raw, folder };
  showSelection();
  if (images.length >= 2) startEngine();
}

function showSelection() {
  const { images, csv, raw, folder } = chosen;
  const size = [...images, ...csv].reduce((total, file) => total + file.size, 0);
  const parts = [`${images.length} photo${images.length === 1 ? '' : 's'}`];
  if (csv.length) parts.push(csv[0].name);
  const summary = `${parts.join(' and ')} selected (${megabytes(size)})${folder ? ` from “${folder}”` : ''}.`;
  const box = $('selection');
  box.replaceChildren(note(summary));
  if (images.length < 2) box.append(note('Choose a folder with at least two overlapping source photos.', 'bad'));
  else if (!csv.length) box.append(note('No DJI CSV found. You will get a general panorama, which may not suit the 360 viewer.', 'warn'));
  if (raw) box.append(note(`${raw} DNG/RAW file${raw === 1 ? ' was skipped. Convert it' : 's were skipped. Convert them'} to JPG or TIFF first.`, 'warn'));
  box.hidden = false;
  $('stitch-btn').disabled = running || images.length < 2;
}

function filesIn(directory) {
  const reader = directory.createReader();
  const entries = [];
  return new Promise((resolve, reject) => {
    const next = () => reader.readEntries((batch) => {
      if (batch.length) {
        entries.push(...batch);
        next();
        return;
      }
      const files = entries.filter((entry) => entry.isFile);
      Promise.all(files.map((entry) => new Promise((ok, fail) => entry.file(ok, fail)))).then(resolve, reject);
    }, reject);
    next();
  });
}

const drop = $('drop');
drop.addEventListener('dragover', (event) => {
  event.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (event) => {
  event.preventDefault();
  drop.classList.remove('over');
  if (running) return;
  const entries = [...event.dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length === 1 && entries[0].isDirectory) choose(await filesIn(entries[0]), entries[0].name);
  else choose([...event.dataTransfer.files]);
});
// A drop that misses the drop zone should not open the photo in this tab.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

$('pick-folder-btn').addEventListener('click', () => $('pick-folder').click());
$('pick-files-btn').addEventListener('click', () => $('pick-files').click());
for (const id of ['pick-folder', 'pick-files']) {
  $(id).addEventListener('change', (event) => {
    choose([...event.target.files]);
    event.target.value = '';
  });
}

const showTimeHint = () => {
  $('time-hint').textContent = `${TIME_HINTS[$('resolution').value]} Keep this tab open while it works.`;
};
$('resolution').addEventListener('change', showTimeHint);
showTimeHint();

// ---- The stitching engine (a Web Worker running Python) ----

function showEngine(text) {
  $('engine').textContent = text;
  $('engine').hidden = false;
}

function startEngine() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', ({ data }) => handle(data));
  worker.addEventListener('error', (event) => {
    event.preventDefault();
    stopEngine();
    const text = 'The image engine could not start. Check your internet connection, then try again.';
    if (running) fail(text);
    else showEngine(text);
  });
  worker.postMessage({ type: 'init' });
  showEngine('Preparing the image engine…');
  return worker;
}

function stopEngine() {
  worker?.terminate();
  worker = null;
}

function handle(message) {
  if (message.type === 'engine') {
    showEngine(message.text);
    if (running && !message.ready) setStatus(message.text);
  } else if (message.type === 'log') {
    report(message.text);
  } else if (message.type === 'done') {
    finish(message);
  } else if (message.type === 'error') {
    if (message.fatal) stopEngine();
    if (running) fail(message.text);
    else showEngine(message.text);
  }
}

// ---- Running a stitch ----

function setStatus(text) {
  $('status').textContent = text;
}

function setProgress(value) {
  const percent = Math.max(0, Math.min(100, value));
  $('fill').style.width = `${percent}%`;
  $('bar').setAttribute('aria-valuenow', String(Math.round(percent)));
}

function setBusy(busy) {
  for (const id of ['pick-folder-btn', 'pick-files-btn', 'resolution', 'format']) $(id).disabled = busy;
  $('stitch-btn').disabled = busy || chosen.images.length < 2;
  $('cancel-btn').hidden = !busy;
}

function tick() {
  $('elapsed').textContent = `· ${minutes(performance.now() - startedAt)}`;
}

function report(text) {
  const log = $('log');
  log.textContent += `${text}\n`;
  log.scrollTop = log.scrollHeight;
  if (text.startsWith('Saved ')) saved = text;
  for (const [pattern, value] of STAGES) {
    const match = text.match(pattern);
    if (match) {
      setProgress(value(Number(match[1]), Number(match[2])));
      break;
    }
  }
  // The engine's working folder means nothing to visitors.
  setStatus(text.replace(/^Saved \S+ /, 'Saved '));
}

async function stitch() {
  if (running || chosen.images.length < 2) return;
  running = true;
  setBusy(true);
  $('error').hidden = true;
  $('result').hidden = true;
  $('log').textContent = '';
  saved = '';
  setProgress(0);
  setStatus('Reading the photos…');
  $('progress').hidden = false;
  startedAt = performance.now();
  clock = setInterval(tick, 1000);
  tick();
  try {
    const files = await Promise.all([...chosen.images, ...chosen.csv].map(async (file) => ({ name: file.name, data: await file.arrayBuffer() })));
    const format = $('format').value;
    const base = chosen.folder ? `${chosen.folder.replace(/[^\w.-]+/g, '_')}_panorama` : 'panorama';
    const message = { type: 'stitch', files, maxEdge: Number($('resolution').value), outName: `${base}.${format}` };
    startEngine().postMessage(message, files.map((file) => file.data));
    setStatus('Waiting for the image engine…');
  } catch (error) {
    fail(`The photos could not be read: ${error.message}`);
  }
}

function stopRunning() {
  running = false;
  clearInterval(clock);
  setBusy(false);
}

function fail(text) {
  if (running) stopRunning();
  setStatus('Stopped.');
  $('error').textContent = text;
  $('error').hidden = false;
}

function finish({ name, data, report: alignment }) {
  const took = performance.now() - startedAt;
  stopRunning();
  setProgress(100);
  setStatus('Done.');
  $('elapsed').textContent = `· ${minutes(took)}`;
  for (const url of urls) URL.revokeObjectURL(url);
  const blob = new Blob([data], { type: name.endsWith('.png') ? 'image/png' : 'image/jpeg' });
  const url = URL.createObjectURL(blob);
  urls = [url];
  $('result-thumb').src = url;
  $('download').href = url;
  $('download').download = name;
  const size = saved.match(/\((\d+) × (\d+) pixels\)/);
  const coverage = saved.match(/coverage: ([\d.]+)%/);
  $('result-info').textContent = [
    size && `${size[1]} × ${size[2]} pixels`,
    megabytes(blob.size),
    coverage && `${coverage[1]}% of the sphere covered`,
    `stitched in ${minutes(took)}`,
  ].filter(Boolean).join(' · ');
  if (alignment) {
    const reportUrl = URL.createObjectURL(new Blob([alignment], { type: 'application/json' }));
    urls.push(reportUrl);
    $('report').href = reportUrl;
    $('report').download = `${name}.alignment.json`;
  }
  $('report-line').hidden = !alignment;
  $('result').hidden = false;
  showInViewer(blob);
}

$('stitch-btn').addEventListener('click', stitch);
$('cancel-btn').addEventListener('click', () => {
  stopEngine();
  stopRunning();
  setStatus('Cancelled.');
  showEngine('Cancelled. The image engine restarts when you stitch again.');
});
window.addEventListener('beforeunload', (event) => {
  if (!running) return;
  event.preventDefault();
  event.returnValue = '';
});

// ---- The 360 viewer ----

async function showInViewer(source) {
  const empty = $('viewer-empty');
  const text = empty.firstElementChild;
  empty.hidden = false;
  if (!viewer.supported) {
    text.textContent = 'This browser cannot show 360 panoramas because WebGL 2 is unavailable.';
    return;
  }
  text.textContent = 'Loading…';
  try {
    await viewer.load(await source);
    empty.hidden = true;
  } catch (error) {
    text.textContent = `This image could not be opened (${error.message}).`;
  }
}

const sample = () => showInViewer(fetch('sample.jpg').then((response) => {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
}));

$('sample-btn').addEventListener('click', sample);
$('try-viewer').addEventListener('click', () => {
  if (!viewer.hasImage) sample();
});
$('open-btn').addEventListener('click', () => $('open-file').click());
$('open-file').addEventListener('change', (event) => {
  const [file] = event.target.files;
  if (file) showInViewer(file);
  event.target.value = '';
});
$('view-result').addEventListener('click', () => {
  $('viewer-section').scrollIntoView({ behavior: 'smooth' });
  $('viewer-canvas').focus({ preventScroll: true });
});
$('reset-btn').addEventListener('click', () => viewer.reset());
$('fullscreen-btn').addEventListener('click', () => viewer.toggleFullscreen());
viewer.onexpand = (on) => {
  const label = on ? 'Exit full screen' : 'Full screen';
  $('fullscreen-btn').title = label;
  $('fullscreen-btn').setAttribute('aria-label', label);
};
if (!viewer.supported) showInViewer(null);
