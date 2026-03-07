
import { invalidRanges } from './ranges.js';

// Estado global
let stream = null;
let track = null;
let torchEnabled = false;
let isScanning = false;
let deferredPrompt = null;

// Helpers de UI
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function show(el) { el.style.display = ''; }
function hide(el) { el.style.display = 'none'; }

// Registro PWA
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  show($('#installBtn'));
});

window.installPWA = function installPWA() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.finally(() => {
    deferredPrompt = null;
    hide($('#installBtn'));
  });
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Cámara
window.startCamera = async function startCamera() {
  try {
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    track = stream.getVideoTracks()[0];
    const video = $('#video');
    video.srcObject = stream;
    show(video);
    hide($('#placeholder'));
    show($('#captureBtn'));
    show($('#stopBtn'));
    show($('#scanOverlay'));
    show($('#multipleIndicator'));

    const torchBtn = $('#torchBtn');
    show(torchBtn);
    const capabilities = track.getCapabilities ? track.getCapabilities() : {};
    if (!capabilities.torch) {
      torchBtn.disabled = true; torchBtn.title = 'Linterna no disponible'; torchBtn.style.opacity = '0.3';
    } else {
      torchBtn.disabled = false; torchBtn.title = 'Encender linterna'; torchBtn.style.opacity = '1';
    }
    await video.play();
  } catch (err) {
    alert('Error al acceder a la cámara: ' + err.message);
  }
}

window.stopCamera = function stopCamera() {
  if (torchEnabled && track) toggleTorch();
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  track = null; torchEnabled = false;
  hide($('#video')); show($('#placeholder'));
  hide($('#captureBtn')); hide($('#stopBtn')); hide($('#scanOverlay')); hide($('#multipleIndicator'));
  const torchBtn = $('#torchBtn'); hide(torchBtn); torchBtn.classList.remove('active'); torchBtn.innerHTML = '🔦';
}

window.toggleTorch = async function toggleTorch() {
  if (!track || !track.applyConstraints) return;
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (!caps.torch) { alert('Tu dispositivo no soporta control de linterna'); return; }
    torchEnabled = !torchEnabled;
    await track.applyConstraints({ advanced: [{ torch: torchEnabled }] });
    const btn = $('#torchBtn');
    if (torchEnabled) { btn.classList.add('active'); btn.innerHTML = '💡'; btn.title = 'Apagar linterna'; }
    else { btn.classList.remove('active'); btn.innerHTML = '🔦'; btn.title = 'Encender linterna'; }
  } catch (e) {
    alert('No se pudo controlar la linterna: ' + e.message);
    torchEnabled = false; const btn = $('#torchBtn'); btn.classList.remove('active'); btn.innerHTML = '🔦';
  }
}

// OCR + Lógica
window.captureAndScan = async function captureAndScan() {
  if (isScanning) return; isScanning = true;
  const video = $('#video');
  const canvas = $('#canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  show($('#loading'));
  try {
    const result = await Tesseract.recognize(canvas, 'eng', {
      logger: m => console.log(m.status, m.progress),
      // Permitimos letras A/B y dígitos para detectar series
      tessedit_char_whitelist: 'AB0123456789'
    });
    const analysis = analyzeOcr(result.data);
    displayResults(analysis);
  } catch (err) {
    alert('Error al escanear: ' + err.message);
  } finally {
    hide($('#loading')); isScanning = false;
  }
}

function analyzeOcr(data) {
  // Extraer candidatos de denominación (10/20/50) y palabras clave
  const denomCandidates = [];
  if (data.words) {
    for (let i = 0; i < data.words.length; i++) {
      const w = data.words[i];
      const txt = (w.text || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      const bbox = { x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0, cx: (w.bbox.x0 + w.bbox.x1)/2, cy: (w.bbox.y0 + w.bbox.y1)/2 };
      const h = bbox.h;
      const conf = w.confidence || w.conf || 0;
      const addCandidate = (val) => denomCandidates.push({ value: val, bbox, h, conf });
      if (txt === '10' || txt === '010') addCandidate(10);
      if (txt === '20' || txt === '020') addCandidate(20);
      if (txt === '50' || txt === '050') addCandidate(50);
      if (txt.includes('DIEZ')) addCandidate(10);
      if (txt.includes('VEINTE')) addCandidate(20);
      if (txt.includes('CINCUENTA')) addCandidate(50);
    }
  }

  // Extraer series A/B con su bounding box (uniendo letra + número si están separados)
  const serials = [];
  const words = (data.words || []).map(w => ({
    text: (w.text || '').toUpperCase(),
    bbox: { x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0, cx: (w.bbox.x0 + w.bbox.x1)/2, cy: (w.bbox.y0 + w.bbox.y1)/2 },
    conf: w.confidence || w.conf || 0
  }));

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const t = w.text.replace(/[^A-Z0-9]/g, '');
    // Caso 1: todo junto A######## o B########
    let m = t.match(/^([AB])(\d{7,9})$/);
    if (m) {
      serials.push({ raw: `${m[1]}${m[2]}`, series: m[1], number: parseInt(m[2], 10), bbox: w.bbox, conf: w.conf });
      continue;
    }
    // Caso 2: letra sola seguida de número en la siguiente palabra
    if ((t === 'A' || t === 'B') && i + 1 < words.length) {
      const nTxt = words[i+1].text.replace(/[^0-9]/g, '');
      if (nTxt.match(/^\d{7,9}$/)) {
        const bbox = mergeBbox(w.bbox, words[i+1].bbox);
        serials.push({ raw: `${t}${nTxt}`, series: t, number: parseInt(nTxt, 10), bbox, conf: Math.min(w.conf, words[i+1].conf) });
        i++; // saltamos el siguiente
        continue;
      }
    }
    // Caso 3: número solo (asumimos Serie B por compatibilidad, pero lo marcamos como inferido)
    const onlyNum = t.match(/^(\d{8,9})$/);
    if (onlyNum) {
      serials.push({ raw: `B${onlyNum[1]}`, series: 'B', number: parseInt(onlyNum[1], 10), bbox: w.bbox, conf: w.conf, inferredB: true });
    }
  }

  // Asignar denominación a cada serie por cercanía espacial
  const results = serials.map(s => ({ ...s, denom: inferDenominationForSerial(s, denomCandidates) }));

  // Determinar validez
  results.forEach(r => {
    if (r.series === 'A') {
      r.status = 'valid';
      r.reason = 'Serie A (válida por regla)';
    } else {
      if (r.denom) {
        r.isInvalidRange = checkIfInvalid(r.number, r.denom);
        r.status = r.isInvalidRange ? 'invalid' : 'valid';
        r.reason = r.isInvalidRange ? 'En rango inhabilitado de Serie B' : 'Fuera de rangos inhabilitados';
      } else {
        // Si no pudimos identificar corte, marcamos como pendiente
        r.status = 'unknown';
        r.reason = 'Corte no identificado';
      }
    }
  });

  return { serials: results, denomCandidates };
}

function mergeBbox(a, b) {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: (x0 + x1)/2, cy: (y0 + y1)/2 };
}

function inferDenominationForSerial(serial, denomCandidates) {
  if (!denomCandidates.length) return null;
  // Peso por distancia + tamaño de palabra (mayor h es mejor)
  let best = null, bestScore = Infinity;
  denomCandidates.forEach(dc => {
    const dx = (serial.bbox.cx - dc.bbox.cx);
    const dy = (serial.bbox.cy - dc.bbox.cy);
    const dist2 = dx*dx + dy*dy;
    const sizeBonus = Math.max(1, dc.h); // mayor tamaño => menor score efectivo
    const score = dist2 / (sizeBonus * sizeBonus);
    if (score < bestScore) { bestScore = score; best = dc; }
  });
  return best ? best.value : null;
}

function checkIfInvalid(number, denomination) {
  const ranges = invalidRanges[denomination] || [];
  return ranges.some(r => number >= r[0] && number <= r[1]);
}

function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const tone = (f, d, delay, type='square') => setTimeout(() => {
      const osc = ctx.createOscillator(); const g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination); osc.frequency.value = f; osc.type = type;
      g.gain.setValueAtTime(0.4, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + d);
      osc.start(); osc.stop(ctx.currentTime + d);
    }, delay);
    tone(880, 0.2, 0); tone(880, 0.2, 250); tone(880, 0.2, 500); tone(440, 0.6, 750, 'sawtooth');
  } catch {}
}

function showAlert(serialText, denom, series) {
  $('#alertSerial').textContent = serialText + (denom ? ` • Bs ${denom}` : '');
  $('#alertDetails').textContent = series === 'B' ? 'Serie B dentro de rango inhabilitado' : '';
  $('#alertOverlay').style.display = 'flex';
}

window.closeAlert = function closeAlert(){ $('#alertOverlay').style.display = 'none'; }

function clearResults() {
  $('#resultsContainer').innerHTML = '';
  hide($('#statsBar'));
  hide($('#clearBtn'));
}
window.clearResults = clearResults;

function badge(status) {
  if (status === 'invalid') return '<span class="status-badge status-invalid">⚠ Billete inhabilitado</span>';
  if (status === 'valid') return '<span class="status-badge status-valid">✔ Billete válido</span>';
  return '<span class="status-badge" style="background:#bdc3c7;color:#2c3e50">¿Pendiente?</span>'
}

function displayResults(analysis) {
  const { serials } = analysis;
  const container = $('#resultsContainer');
  const statsBar = $('#statsBar');
  const clearBtn = $('#clearBtn');
  container.innerHTML = '';

  let invalidCount = 0; let validCount = 0; let firstInvalid = null;

  serials.forEach((r, i) => {
    const stateClass = r.status === 'invalid' ? 'invalid' : (r.status === 'valid' ? 'valid' : '');
    if (r.status === 'invalid') { invalidCount++; if (!firstInvalid) firstInvalid = r; }
    else if (r.status === 'valid') { validCount++; }

    const denomText = r.denom ? `Bs ${r.denom}` : 'No identificado';
    const html = `
      <div class="result-item ${stateClass}">
        <div class="result-header">
          <span class="result-number">${r.raw}</span>
          ${badge(r.status)}
        </div>
        <div class="result-details">
          Número de serie: <strong>${r.raw}</strong> • Tipo: <strong>${r.series}</strong> • Corte: <strong>${denomText}</strong>
          ${r.reason ? `<br><em>${r.reason}</em>` : ''}
        </div>
      </div>`;
    const div = document.createElement('div');
    div.innerHTML = html; container.appendChild(div.firstElementChild);
  });

  $('#totalCount').textContent = serials.length;
  $('#invalidCount').textContent = invalidCount;
  $('#validCount').textContent = validCount;
  show(statsBar); show(clearBtn);

  if (firstInvalid) {
    playAlertSound();
    setTimeout(() => showAlert(firstInvalid.raw, firstInvalid.denom, firstInvalid.series), 500);
    if (navigator.vibrate) navigator.vibrate([300,150,300,150,500]);
  }
}

// --- Verificación manual ---
window.checkManual = function checkManual() {
  const input = $('#manualInput');
  const value = (input.value || '').trim().toUpperCase();
  const m = value.replace(/\s+/g, '').match(/^([AB])?\s*(\d{8,9})$/);
  if (!m) { alert('Formato inválido. Ejemplos válidos: A77100001, B77100001, 77100001'); return; }
  const series = m[1] || 'B'; // si no se especifica, asumimos B por compatibilidad
  const number = parseInt(m[2], 10);
  // Intento de detectar denominación desde selector auxiliar (opcional)
  const denomSel = $('#manualDenom');
  const denom = denomSel && denomSel.value ? parseInt(denomSel.value, 10) : null;

  let status = 'unknown', reason = '';
  if (series === 'A') { status = 'valid'; reason = 'Serie A (válida por regla)'; }
  else if (denom) {
    const invalid = checkIfInvalid(number, denom);
    status = invalid ? 'invalid' : 'valid';
    reason = invalid ? 'En rango inhabilitado de Serie B' : 'Fuera de rangos inhabilitados';
  } else {
    reason = 'Corte no identificado';
  }

  displayResults({ serials: [{ raw: series + String(number).padStart(m[2].length, '0'), series, number, denom, status, reason }] });
  input.value = '';
}

// Inicialización DOM
document.addEventListener('DOMContentLoaded', () => {
  const manualInput = $('#manualInput');
  if (manualInput) {
    manualInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') window.checkManual(); });
  }
});
