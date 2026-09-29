// Runs the desktop app's Python stitcher (py/stitch.py and py/alignment.py) in Pyodide, off the page's main thread.
import { loadPyodide } from 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs';

const PACKAGES = ['numpy', 'scipy', 'opencv-python', 'Pillow'];
let engine = null;

const send = (type, fields = {}) => self.postMessage({ type, ...fields });

async function load() {
  send('engine', { text: 'Starting the image engine…' });
  const pyodide = await loadPyodide();
  send('engine', { text: 'Downloading image libraries (about 35 MB, first visit only)…' });
  await pyodide.loadPackage(PACKAGES, { messageCallback() {} });
  pyodide.FS.mkdirTree('/app');
  for (const name of ['stitch.py', 'alignment.py']) {
    const response = await fetch(new URL(`py/${name}`, import.meta.url));
    if (!response.ok) throw new Error(`could not download ${name} (HTTP ${response.status})`);
    pyodide.FS.writeFile(`/app/${name}`, await response.text());
  }
  pyodide.runPython("import sys; sys.path.insert(0, '/app'); import stitch, alignment");
  send('engine', { text: 'Image engine ready.', ready: true });
  return pyodide;
}

function startEngine() {
  if (!engine) {
    engine = load();
    engine.catch(() => { engine = null; });
  }
  return engine;
}

function emptyDir(FS, dir) {
  FS.mkdirTree(dir);
  for (const name of FS.readdir(dir)) {
    if (name !== '.' && name !== '..') FS.unlink(`${dir}/${name}`);
  }
}

async function stitch({ files, maxEdge, outName }) {
  const pyodide = await startEngine();
  const { FS } = pyodide;
  const output = `/out/${outName}`;
  emptyDir(FS, '/capture');
  emptyDir(FS, '/out');
  try {
    for (const file of files) FS.writeFile(`/capture/${file.name}`, new Uint8Array(file.data));
    const module = pyodide.globals.get('stitch');
    try {
      module.stitch('/capture', output, maxEdge, (text) => send('log', { text }))?.destroy?.();
    } finally {
      module.destroy();
    }
    const image = FS.readFile(output);
    let report = null;
    try {
      report = FS.readFile(`${output}.alignment.json`, { encoding: 'utf8' });
    } catch {
      // General (non-CSV) panoramas have no alignment report.
    }
    self.postMessage({ type: 'done', name: outName, data: image.buffer, report }, [image.buffer]);
  } finally {
    emptyDir(FS, '/capture');
    emptyDir(FS, '/out');
  }
}

function explain(error) {
  const text = String(error?.message ?? error);
  if (/MemoryError|out of memory|Cannot enlarge memory|allocation failed/i.test(text)) {
    return 'Your browser ran out of memory. Try the Preview resolution, close other tabs, or use a computer with more memory.';
  }
  if (error?.type) {
    // A Python exception: show its message, as the desktop app does.
    return text.trim().split('\n').pop().replace(/^[\w.]+: /, '');
  }
  if (/fetch|network|import/i.test(text)) {
    return 'The image engine could not be downloaded. Check your internet connection, then try again.';
  }
  return `The image engine stopped unexpectedly (${text.split('\n')[0]}). This can happen with unsupported TIFF files or when memory runs out.`;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') await startEngine();
    if (data.type === 'stitch') await stitch(data);
  } catch (error) {
    send('error', { text: explain(error), fatal: !error?.type });
  }
};
