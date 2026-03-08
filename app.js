
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
  const torchBtn = $('#torchBtn'); hide(torchBtn); torchBtn.classList.remove('active'); torchBtn.textContent = '🔦';
}

window.toggleTorch = async function toggleTorch() {
  if (!track || !track.applyConstraints) return;
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (!caps.torch) { alert('Tu dispositivo no soporta control de linterna'); return; }
    torchEnabled = !torchEnabled;
    await track.applyConstraints({ advanced: [{ torch: torchEnabled }] });
    const btn = $('#torchBtn');
    if (torchEnabled) { btn.classList.add('active'); btn.textContent = '💡'; btn.title = 'Apagar linterna'; }
    else { btn.classList.remove('active'); btn.textContent = '🔦'; btn.title = 'Encender linterna'; }
  } catch (e) {
    alert('No se pudo controlar la linterna: ' + e.message);
    torchEnabled = false; const btn = $('#torchBtn'); btn.classList.remove('active'); btn.textContent = '🔦';
  }
}

// --- Utilidades de color ---
function rgbToHsv(r,g,b){
  r/=255; g/=255; b/=255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h=0, s=0, v=max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;
  if (d !== 0) {
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return {h, s, v};
}

function dominantHueFromCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const { width:w, height:h } = canvas;
  const step = Math.max(4, Math.floor(Math.min(w,h)/120));
  const hist = new Array(360).fill(0);
  const img = ctx.getImageData(0,0,w,h).data;
  for (let y=0; y<h; y+=step){
    for (let x=0; x<w; x+=step){
      const i = (y*w + x)*4;
      const R=img[i], G=img[i+1], B=img[i+2];
      const {h:H, s:S, v:V} = rgbToHsv(R,G,B);
      const weight = Math.max(0, S)*Math.max(0.2, V);
      if (!Number.isNaN(H)) hist[Math.floor(H)%360]+=weight;
    }
  }
  let bestI=0; let bestV=-1;
  for (let i=0;i<360;i++){ if(hist[i]>bestV){bestV=hist[i]; bestI=i;} }
  return bestI; // 0..359
}

function inferDenominationByColor(canvas){
  const hue = dominantHueFromCanvas(canvas);
  // Mapeo aproximado (iluminación puede variar):
  // 10 Bs: predominio azules (200-260)
  // 20 Bs: naranjas/rojos claros (10-40)
  // 50 Bs: violetas/lilas (270-315)
  if ((hue>=200 && hue<=265)) return 10;
  if ((hue>=10 && hue<=40) || (hue>=0 && hue<10)) return 20;
  if ((hue>=270 && hue<=315)) return 50;
  return null;
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
      tessedit_char_whitelist: 'AB0123456789'
    });
    const analysis = analyzeOcr(result.data, canvas);
    displayResults(analysis);
  } catch (err) {
    alert('Error al escanear: ' + err.message);
  } finally {
    hide($('#loading')); isScanning = false;
  }
}

function analyzeOcr(data, canvas) {
  // Candidatos de denominación (10/20/50) con sesgo a la franja izquierda
  const denomCandidates = [];
  const words = (data.words || []).map(w => ({
    text: (w.text || '').toUpperCase(),
    bbox: { x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0, cx: (w.bbox.x0 + w.bbox.x1)/2, cy: (w.bbox.y0 + w.bbox.y1)/2 },
    conf: w.confidence || w.conf || 0
  }));
  const imgW = canvas.width || 1;
  const leftBandX = imgW * 0.35; // priorizamos lecturas a la izquierda

  const pushDenom = (val, bbox, h, conf, leftBias=false) => denomCandidates.push({ value: val, bbox, h, conf, leftBias });

  for (let i=0;i<words.length;i++){
    const w = words[i];
    const raw = (w.text||'').replace(/[^A-Za-z0-9]/g,'');
    const txt = raw.toUpperCase();
    const isLeft = (w.bbox.x < leftBandX);
    if (txt==='10' || txt==='010' || txt.includes('DIEZ')) pushDenom(10, w.bbox, w.bbox.h, w.conf, isLeft);
    if (txt==='20' || txt==='020' || txt.includes('VEINTE')) pushDenom(20, w.bbox, w.bbox.h, w.conf, isLeft);
    if (txt==='50' || txt==='050' || txt.includes('CINCUENTA')) pushDenom(50, w.bbox, w.bbox.h, w.conf, isLeft);
  }

  // Extraer series A/B con variantes
  const serials = [];
  for (let i=0; i<words.length; i++){
    const w = words[i];
    const t = (w.text||'').replace(/[^A-Z0-9]/g,'');

    // 1) A######## o B########
    let m = t.match(/^([AB])(\d{7,9})$/);
    if (m) { serials.push({ raw:`${m[1]}${m[2]}`, series:m[1], number:parseInt(m[2],10), bbox:w.bbox, conf:w.conf }); continue; }

    // 2) ########A o ########B (letra a la derecha)
    m = t.match(/^(\d{7,9})([AB])$/);
    if (m) { serials.push({ raw:`${m[2]}${m[1]}`, series:m[2], number:parseInt(m[1],10), bbox:w.bbox, conf:w.conf }); continue; }

    // 3) 'A' o 'B' seguido de número en la palabra siguiente
    if ((t==='A' || t==='B') && i+1<words.length){
      const nTxt = (words[i+1].text||'').replace(/[^0-9]/g,'');
      if (/^\d{7,9}$/.test(nTxt)){
        const bbox = mergeBbox(w.bbox, words[i+1].bbox);
        serials.push({ raw:`${t}${nTxt}`, series:t, number:parseInt(nTxt,10), bbox, conf:Math.min(w.conf, words[i+1].conf) });
        i++; continue;
      }
    }

    // 4) Número seguido por 'A' o 'B' en la palabra siguiente
    const nOnly = t.match(/^(\d{7,9})$/);
    if (nOnly && i+1<words.length){
      const nextT = (words[i+1].text||'').replace(/[^A-Z]/g,'').toUpperCase();
      if (nextT==='A' || nextT==='B'){
        const bbox = mergeBbox(w.bbox, words[i+1].bbox);
        serials.push({ raw:`${nextT}${nOnly[1]}`, series:nextT, number:parseInt(nOnly[1],10), bbox, conf:Math.min(w.conf, words[i+1].conf) });
        i++; continue;
      }
    }

    // 5) Número solo ⇒ asumimos B (compat), marcado como inferido
    if (nOnly){ serials.push({ raw:`B${nOnly[1]}`, series:'B', number:parseInt(nOnly[1],10), bbox:w.bbox, conf:w.conf, inferredB:true }); }
  }

  // Si tenemos candidatos en la franja izquierda, nos quedamos con esos para darles prioridad
  const leftCandidates = denomCandidates.filter(d => d.leftBias);
  const usedCandidates = leftCandidates.length ? leftCandidates : denomCandidates;

  // Asignar denominación a cada serie por cercanía y, si falta, por color dominante
  const colorDenom = inferDenominationByColor(canvas);
  const results = serials.map(s => {
    const d = inferDenominationForSerial(s, usedCandidates);
    return { ...s, denom: d || colorDenom || null };
  });

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
        r.status = 'unknown';
        r.reason = 'Corte no identificado';
      }
    }
  });

  return { serials: results, denomCandidates: usedCandidates, colorDenom };
}

function mergeBbox(a, b) {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: (x0 + x1)/2, cy: (y0 + y1)/2 };
}

function inferDenominationForSerial(serial, denomCandidates) {
  if (!denomCandidates.length) return null;
  let best = null, bestScore = Infinity;
  denomCandidates.forEach(dc => {
    const dx = (serial.bbox.cx - dc.bbox.cx);
    const dy = (serial.bbox.cy - dc.bbox.cy);
    const dist2 = dx*dx + dy*dy;
    // Bonificación si el candidato está en la franja izquierda (donde el corte grande suele estar)
    const leftBonus = dc.leftBias ? 0.4 : 1.0;
    const sizeBonus = Math.max(1, dc.h);
    const score = (dist2 / (sizeBonus*sizeBonus)) * leftBonus;
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

  serials.forEach((r) => {
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

// --- Verificación manual (con selección OBLIGATORIA de corte) ---
window.checkManual = function checkManual() {
  const input = $('#manualInput');
  const denomSel = $('#manualDenom');
  if (!denomSel || !denomSel.value) { alert('Selecciona el corte del billete (Bs 10, 20 o 50) para validar manualmente.'); return; }
  const denom = parseInt(denomSel.value, 10);

  const value = (input.value || '').trim().toUpperCase();
  const m = value.replace(/\s+/g, '').match(/^([AB])?\s*(\d{8,9})$/);
  if (!m) { alert('Formato inválido. Ejemplos válidos: A77100001, B77100001, 77100001'); return; }
  const series = m[1] || 'B'; // si no se especifica, asumimos B por compatibilidad
  const number = parseInt(m[2], 10);

  let status = 'unknown', reason = '';
  if (series === 'A') { status = 'valid'; reason = 'Serie A (válida por regla)'; }
  else {
    const invalid = checkIfInvalid(number, denom);
    status = invalid ? 'invalid' : 'valid';
    reason = invalid ? 'En rango inhabilitado de Serie B' : 'Fuera de rangos inhabilitados';
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
