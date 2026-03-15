let stream = null, track = null, torchEnabled = false, isScanning = false;
let currentDenomination = 10;

const $ = sel => document.querySelector(sel);
const show = el => el.style.display = '';
const hide = el => el.style.display = 'none';

// ==================== CÁMARA (VERSIÓN ULTRA COMPATIBLE) ====================
window.startCamera = async () => {
  try {
    const constraints = { video: { facingMode: "environment" } }; // lo más compatible posible
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    track = stream.getVideoTracks()[0];

    const video = $('#video');
    video.srcObject = stream;
    show(video);
    hide($('#placeholder'));
    show($('#captureBtn')); show($('#stopBtn')); show($('#torchBtn'));

    await video.play();
  } catch (e) {
    alert('No se pudo abrir la cámara.\nPrueba en Chrome móvil o asegúrate de dar permiso a la cámara trasera.');
  }
};

window.stopCamera = () => {
  stream?.getTracks().forEach(t => t.stop());
  stream = track = null; torchEnabled = false;
  hide($('#video')); show($('#placeholder'));
  hide($('#captureBtn')); hide($('#stopBtn')); hide($('#torchBtn'));
};

window.toggleTorch = async () => {
  if (!track) return;
  torchEnabled = !torchEnabled;
  await track.applyConstraints({ advanced: [{ torch: torchEnabled }] });
  $('#torchBtn').textContent = torchEnabled ? '💡' : '🔦';
};

// ==================== MANUAL (CORREGIDO - 9 dígitos + ceros) ====================
window.checkManual = () => {
  let val = $('#manualInput').value.trim().toUpperCase().replace(/\s/g,'');
  if (!val) return;

  const letter = (val.match(/[AB]/i) || ['B'])[0].toUpperCase();
  let digits = val.replace(/[^0-9]/g,'').padStart(9, '0');
  const number = parseInt(digits, 10);

  const isInvalid = letter === 'B' && checkIfInvalid(number, currentDenomination);

  displayResults([{
    raw: digits + letter,
    series: letter,
    denom: currentDenomination,
    status: letter === 'A' ? 'valid' : (isInvalid ? 'invalid' : 'valid'),
    reason: letter === 'A' ? 'Serie A siempre válida' : (isInvalid ? 'Rango inhabilitado' : '')
  }]);

  $('#manualInput').value = '';
};

// ==================== VALIDACIÓN RANGOS ====================
function checkIfInvalid(number, denom) {
  const ranges = invalidRanges[denom] || [];
  return ranges.some(([min, max]) => number >= min && number <= max);
}

// ==================== RESULTADOS ====================
function displayResults(results) {
  const container = $('#resultsContainer');
  container.innerHTML = '';

  let invalid = 0;
  results.forEach(r => {
    const div = document.createElement('div');
    div.style.cssText = `background:#f8f9fa;padding:15px;border-radius:12px;margin:10px 0;border-left:5px solid ${r.status==='invalid'?'#e74c3c':'#27ae60'};`;
    div.innerHTML = `
      <div style="font-size:1.4rem;font-weight:bold;">${r.raw}</div>
      <div>Serie: <b>${r.series}</b> • Corte: <b>Bs ${r.denom}</b></div>
      <div style="color:${r.status==='invalid'?'#e74c3c':'#27ae60'};font-weight:bold;">
        ${r.status.toUpperCase()} ${r.reason}
      </div>
    `;
    container.appendChild(div);
    if (r.status === 'invalid') invalid++;
  });

  if (invalid > 0) {
    const first = results.find(r => r.status === 'invalid');
    $('#alertSerial').textContent = first.raw;
    show($('#alertOverlay'));
  }
}

window.clearResults = () => {
  $('#resultsContainer').innerHTML = '';
  hide($('#alertOverlay'));
};

// Cerrar alert
window.closeAlert = () => hide($('#alertOverlay'));

// Actualizar rangos
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.denom-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.denom-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentDenomination = parseInt(btn.dataset.value);
      $('#currentDenom').textContent = currentDenomination;
      updateRangeList();
    };
  });
  updateRangeList();
});

function updateRangeList() {
  const list = $('#rangeList');
  list.innerHTML = (invalidRanges[currentDenomination] || []).map(r => 
    `<div>${r[0]} — ${r[1]}</div>`
  ).join('');
}