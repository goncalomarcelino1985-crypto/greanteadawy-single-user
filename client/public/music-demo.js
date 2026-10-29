// This preview uses the same authenticated, same-origin API as the existing DAW.
const byId = (id) => document.getElementById(id);
const sampleUrl = (sample) => `/api/samples/${encodeURIComponent(sample.id)}/file`;
const rounded = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : null;

function facts(sample, target) {
  target.replaceChildren();
  const metadata = sample.metadata || {};
  const analysis = sample.analysis || {};
  const values = [
    Number.isFinite(sample.duration) ? `${rounded(sample.duration, 2)} segundos` : null,
    Number.isFinite(metadata.sampleRate) ? `${rounded(metadata.sampleRate / 1000)} kHz` : null,
    metadata.bitsPerSample ? `${metadata.bitsPerSample} bits` : null,
    metadata.channels ? `${metadata.channels} canais` : null,
    Number.isFinite(analysis.lufs) ? `${rounded(analysis.lufs)} LUFS` : null,
    Number.isFinite(analysis.peakDb) ? `Pico: ${rounded(analysis.peakDb)} dB` : null,
    analysis.tempo?.confidence >= 0.35 && Number.isFinite(analysis.tempo.bpm) ? `Tempo estimado: ${rounded(analysis.tempo.bpm)} BPM` : null,
    analysis.key?.confidence > 0.5 ? `Tonalidade estimada: ${analysis.key.key} ${analysis.key.scale}` : null
  ].filter(Boolean);
  for (const value of values) {
    const span = document.createElement('span');
    span.textContent = value;
    target.append(span);
  }
}

function player(sample, title) {
  const card = document.createElement('article');
  card.className = 'card';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.src = sampleUrl(sample);
  audio.setAttribute('aria-label', `Ouvir ${title}`);
  const details = document.createElement('div');
  details.className = 'facts';
  facts(sample, details);
  const link = document.createElement('a');
  link.href = sampleUrl(sample);
  link.download = `${title}.wav`;
  link.textContent = 'Descarregar WAV';
  card.append(heading, details, audio, link);
  return card;
}

// Avoid accidentally comparing two overlapping recordings.
document.addEventListener('play', (event) => {
  for (const audio of document.querySelectorAll('audio')) if (audio !== event.target) audio.pause();
}, true);

async function loadStems() {
  try {
    const response = await fetch('/api/samples', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Não foi possível abrir as pistas. Volta a abrir o teu link privado do estúdio.');
    const samples = await response.json();
    if (!Array.isArray(samples)) throw new Error('O estúdio devolveu uma resposta inesperada.');
    const names = ['Voz', 'Bateria', 'Baixo', 'Outros instrumentos'];
    let available = 0;
    for (const name of names) {
      const sample = samples.find((entry) => entry.name === name);
      if (!sample) continue;
      byId('stems').append(player(sample, name));
      available++;
    }
    const original = samples.find((entry) => entry.name === 'Original preservado');
    if (original) facts(original, byId('original-analysis'));
    byId('status').textContent = available === 4 ? 'Quatro stems prontos para ouvir.' : `${available} de 4 stems disponíveis; a preparação da demonstração ainda não terminou.`;
  } catch (error) {
    byId('status').textContent = error.message;
  }
}

byId('upload-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = byId('wav-file').files[0];
  const status = byId('upload-status');
  if (!file || !/\.wav$/i.test(file.name)) { status.textContent = 'Escolhe um ficheiro WAV.'; return; }
  if (file.size > 50 * 1024 * 1024) { status.textContent = 'Este teste aceita ficheiros até 50 MB.'; return; }
  const button = byId('upload-button');
  button.disabled = true;
  status.textContent = 'A enviar e analisar o WAV no servidor…';
  try {
    const form = new FormData();
    form.append('file', file, file.name);
    const response = await fetch('/api/samples', { method: 'POST', credentials: 'same-origin', body: form });
    const sample = await response.json();
    if (!response.ok) throw new Error(sample.error || 'Não foi possível carregar este WAV.');
    byId('uploaded').append(player(sample, sample.name || file.name));
    status.textContent = sample.analysis ? 'WAV carregado e analisado. Podes ouvi-lo aqui ou abri-lo em Samples na DAW.' : 'WAV carregado. A análise ainda não está disponível; podes ouvi-lo aqui ou abri-lo na DAW.';
    byId('wav-file').value = '';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

loadStems();
