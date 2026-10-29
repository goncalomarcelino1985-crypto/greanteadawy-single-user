// Private, same-origin workbench. All separation, timing analysis and WAV rendering run on the server/cloud.
const byId = (id) => document.getElementById(id);
const audioA = byId('audio-a');
const audioB = byId('audio-b');
const busyStates = new Set(['preparing', 'queued', 'separating', 'validating']);
const labels = { drums: 'Bateria', bass: 'Baixo', vocals: 'Voz', other: 'Outros instrumentos' };
let capabilities = { available: false, reason: 'A verificar disponibilidade.', limits: { maxUploadMb: 50, maxDurationSeconds: 600 } };
let jobs = [];
let current = null;
let timer = null;
let submitting = false;
let requestSequence = 0;
let stemsSignature = '';
let editedInvalidated = false;
let lastAB = audioA;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const number = (value, digits = 2) => finite(value) ? value.toLocaleString('pt-PT', { maximumFractionDigits: digits }) : '—';
const jobPath = (id) => `/api/music/jobs/${encodeURIComponent(id)}`;

function localUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith('/api/') ? url.pathname + url.search : null;
  } catch { return null; }
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('Acesso privado necessário. Volta a abrir o teu link de acesso ao estúdio.');
    throw new Error(typeof data?.error === 'string' ? data.error : `O pedido não foi concluído (${response.status}).`);
  }
  if (data == null) throw new Error('O servidor não devolveu uma resposta válida.');
  return data;
}

function facts(target, values) {
  target.replaceChildren();
  for (const value of values.filter(Boolean)) {
    const span = document.createElement('span');
    span.textContent = value;
    target.append(span);
  }
}

function setAudio(audio, url) {
  const next = localUrl(url);
  if ((audio.getAttribute('src') || null) === next) return;
  audio.pause();
  if (next) audio.src = next;
  else { audio.removeAttribute('src'); audio.load(); }
}

function setLink(link, url, filename) {
  const target = localUrl(url);
  link.hidden = !target;
  if (!target) { link.removeAttribute('href'); return; }
  link.href = target;
  if (filename) link.download = filename;
}

function updateProvider() {
  const status = byId('provider-status');
  status.textContent = capabilities.available
    ? `Separação gratuita disponível: ${capabilities.provider || 'MVSEP'} · ${capabilities.model || 'htdemucs_ft'} · quatro stems WAV.`
    : capabilities.reason || 'A separação cloud ainda não está ligada. A importação preserva o original, mas não cria stems.';
  status.classList.toggle('error', !capabilities.available);
  byId('provider-setup').open = !capabilities.available;
  const limit = capabilities.limits || {};
  byId('upload-limit').textContent = `até ${limit.maxUploadMb || 50} MB e ${number((limit.maxDurationSeconds || 600) / 60)} minutos`;
}

function updateHistory() {
  const select = byId('job-select');
  select.replaceChildren();
  for (const job of jobs) {
    const option = document.createElement('option');
    option.value = job.id;
    option.textContent = job.name || job.original?.name || 'Importação';
    select.append(option);
  }
  byId('history').hidden = jobs.length === 0;
  if (current) select.value = current.id;
}

function upsert(job) {
  const existing = jobs.findIndex((entry) => entry.id === job.id);
  if (existing >= 0) jobs[existing] = job;
  else jobs.unshift(job);
  updateHistory();
}

function stemCard(stem) {
  const card = document.createElement('article');
  card.className = 'card';
  const title = document.createElement('h3');
  title.textContent = labels[stem.key] || stem.name || 'Stem';
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.setAttribute('aria-label', `Ouvir ${title.textContent}`);
  setAudio(audio, stem.url);
  const link = document.createElement('a');
  link.textContent = 'Descarregar stem WAV';
  setLink(link, stem.url, `${stem.key || 'stem'}.wav`);
  card.append(title, audio, link);
  return card;
}

function invalidateEdited() {
  editedInvalidated = true;
  setAudio(audioB, null);
  audioB.hidden = true;
  byId('download-edited').hidden = true;
  byId('listen-b').disabled = true;
  byId('edited-empty').hidden = false;
  byId('edited-empty').textContent = 'Depois das alterações na DAW, pede uma nova exportação para comparar a versão atual.';
  byId('edited-revision').textContent = '';
}

function renderJob(job, { selected = false } = {}) {
  if (selected || current?.id !== job.id) {
    document.querySelectorAll('audio').forEach((audio) => audio.pause());
    stemsSignature = '';
    editedInvalidated = false;
    lastAB = audioA;
    byId('action-status').textContent = '';
  }
  current = job;
  upsert(job);
  byId('workspace').hidden = false;
  byId('job-heading').textContent = job.name || job.original?.name || 'Original importado';
  byId('job-status').textContent = job.error || job.message || ({ imported: 'Original importado. Pronto para pedir a separação.', ready: 'Quatro stems disponíveis para edição.', failed: 'A separação não terminou. O original continua preservado.' }[job.status] || 'A processar na cloud…');
  byId('job-status').classList.toggle('error', job.status === 'failed');
  const original = job.original || {};
  facts(byId('original-facts'), [original.name, finite(original.bytes) ? `${number(original.bytes / 1024 / 1024)} MB` : null,
    finite(job.clip?.startSeconds) ? `Excerto desde ${number(job.clip.startSeconds)} s` : null,
    finite(job.clip?.durationSeconds) ? `${number(job.clip.durationSeconds)} s de áudio` : null]);
  byId('original-hash').textContent = original.sha256 || 'Ainda não disponível';
  setLink(byId('download-original'), original.url, original.name);
  const busy = busyStates.has(job.status);
  byId('separate-button').disabled = submitting || job.status !== 'imported' || !capabilities.available;
  byId('separate-button').textContent = busy ? 'Separação em curso…' : 'Separar em quatro stems';
  const stems = Array.isArray(job.stems) ? job.stems.filter((stem) => labels[stem.key] && localUrl(stem.url)) : [];
  const verified = job.status === 'ready' && job.alignment?.verified === true && stems.length === 4 && new Set(stems.map((stem) => stem.key)).size === 4;
  const signature = verified ? JSON.stringify(stems.map((stem) => [stem.key, stem.url])) : '';
  if (stemsSignature !== signature) {
    byId('stems').replaceChildren(...(verified ? ['drums', 'bass', 'vocals', 'other'].map((key) => stemCard(stems.find((stem) => stem.key === key))) : []));
    stemsSignature = signature;
  }
  byId('stems-empty').hidden = verified;
  const timing = job.analysis || {};
  facts(byId('timing-facts'), [finite(timing.bpm) ? `BPM estimado: ${number(timing.bpm, 3)}` : null,
    finite(timing.confidence) ? `Confiança: ${number(timing.confidence <= 1 ? timing.confidence * 100 : timing.confidence, 0)}%` : null,
    finite(timing.beatOffsetSeconds) ? `Fase da pulsação: ${number(timing.beatOffsetSeconds, 3)} s` : null,
    verified ? 'Alinhamento dos quatro stems verificado' : null]);
  const warnings = Array.isArray(timing.warnings) ? timing.warnings.filter((warning) => typeof warning === 'string') : [];
  if (timing.halfDoubleTimeAmbiguous) warnings.push('Pode existir ambiguidade entre a pulsação, a sua metade e o seu dobro.');
  byId('timing-note').textContent = [timing.note, ...warnings].filter(Boolean).join(' ') || (verified ? 'A gravação mantém a velocidade original. Confirma a grelha de BPM antes de editar por compassos.' : 'O BPM e o alinhamento serão apresentados depois da análise cloud.');
  byId('open-daw-button').disabled = !verified || !job.projectId || submitting;
  byId('render-button').disabled = !verified || !job.projectId || job.renderStatus === 'rendering' || submitting;
  byId('render-button').textContent = job.renderStatus === 'rendering' ? 'A exportar na cloud…' : 'Atualizar versão editada em WAV';
  const clipUrl = localUrl(job.clip?.url);
  setAudio(audioA, clipUrl);
  setLink(byId('download-clip'), clipUrl);
  byId('listen-a').disabled = !clipUrl;
  const staleRevision = job.projectRevision !== undefined && job.edited?.revision !== undefined && job.projectRevision !== job.edited.revision;
  const editedUrl = !editedInvalidated && !staleRevision && !['rendering', 'failed'].includes(job.renderStatus) ? localUrl(job.edited?.url) : null;
  setAudio(audioB, editedUrl);
  audioB.hidden = !editedUrl;
  byId('edited-empty').hidden = !!editedUrl;
  if (staleRevision) byId('edited-empty').textContent = 'O arranjo mudou desde a última exportação. Atualiza o WAV para comparar a versão atual.';
  byId('listen-b').disabled = !editedUrl;
  setLink(byId('download-edited'), editedUrl);
  byId('edited-revision').textContent = editedUrl ? `Exportação da revisão ${job.edited?.revision ?? 'guardada'}. Não muda automaticamente quando editas na DAW.` : '';
  byId('render-status').textContent = job.renderStatus === 'rendering' ? 'A renderizar o arranjo atual no servidor. Mantém o original disponível.' : job.renderStatus === 'failed' ? job.renderError || 'A exportação falhou. Nenhum áudio novo foi apresentado como resultado.' : '';
  byId('render-status').classList.toggle('error', job.renderStatus === 'failed');
  clearTimeout(timer);
  if (busy || job.renderStatus === 'rendering') timer = setTimeout(() => refreshCurrent().catch(showActionError), 15000);
}

function showActionError(error) { byId('action-status').textContent = error.message; }

async function refreshCurrent() {
  if (!current) return;
  const id = current.id;
  const sequence = ++requestSequence;
  const job = await api(jobPath(id));
  if (sequence !== requestSequence || current?.id !== id) return;
  renderJob(job);
}

async function jobAction(action) {
  if (!current || submitting) return;
  const id = current.id;
  submitting = true;
  byId('action-status').textContent = '';
  renderJob(current);
  try {
    const result = await api(`${jobPath(id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (current?.id !== id) return;
    if (action === 'open') {
      invalidateEdited();
      window.location.assign('/');
    } else {
      if (action === 'render') {
        editedInvalidated = false;
        setAudio(audioB, null);
      }
      renderJob(result);
    }
  } catch (error) { showActionError(error); }
  finally { submitting = false; if (current) renderJob(current); }
}

byId('import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;
  const file = byId('source-file').files[0];
  const status = byId('import-status');
  const start = Number(byId('start-seconds').value || 0);
  const durationText = byId('duration-seconds').value;
  const duration = durationText === '' ? null : Number(durationText);
  const maxMb = capabilities.limits?.maxUploadMb || 50;
  const maxSeconds = capabilities.limits?.maxDurationSeconds || 600;
  status.classList.remove('error');
  if (!file || !/\.(wav|mp3)$/i.test(file.name)) { status.textContent = 'Escolhe um ficheiro WAV ou MP3.'; return; }
  if (file.size > maxMb * 1024 * 1024) { status.textContent = `O ficheiro ultrapassa o limite de ${maxMb} MB deste teste.`; return; }
  if (!finite(start) || start < 0 || (duration !== null && (!finite(duration) || duration < 1 || duration > maxSeconds))) { status.textContent = 'Confirma o início e a duração do excerto.'; return; }
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('startSeconds', String(start));
  if (duration !== null) form.append('durationSeconds', String(duration));
  submitting = true;
  byId('import-button').disabled = true;
  status.textContent = 'A enviar o original para o estúdio de teste…';
  try {
    const job = await api('/api/music/jobs', { method: 'POST', body: form });
    ++requestSequence;
    renderJob(job, { selected: true });
    status.textContent = 'Original recebido. O ficheiro completo fica preservado, mesmo quando trabalhas só um excerto.';
    byId('source-file').value = '';
  } catch (error) { status.textContent = error.message; status.classList.add('error'); }
  finally { submitting = false; byId('import-button').disabled = false; if (current) renderJob(current); }
});

byId('job-select').addEventListener('change', async () => {
  const id = byId('job-select').value;
  const selected = jobs.find((job) => job.id === id);
  if (!selected) return;
  ++requestSequence;
  renderJob(selected, { selected: true });
  await refreshCurrent().catch(showActionError);
});
byId('separate-button').addEventListener('click', () => jobAction('separate'));
byId('open-daw-button').addEventListener('click', () => jobAction('open'));
byId('render-button').addEventListener('click', () => jobAction('render'));
byId('refresh-button').addEventListener('click', () => refreshCurrent().catch(showActionError));

byId('provider-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;
  const field = byId('provider-token');
  const status = byId('provider-form-status');
  const token = field.value.trim();
  if (!token) return;
  submitting = true;
  byId('provider-button').disabled = true;
  status.classList.remove('error');
  status.textContent = 'A verificar se a conta permite separação gratuita, sem iniciar processamento…';
  try {
    capabilities = await api('/api/music/provider', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    updateProvider();
    status.textContent = capabilities.available ? 'Conta gratuita verificada. A chave fica apenas nesta sessão do servidor de teste.' : capabilities.reason || 'A ligação não está disponível.';
  } catch (error) { status.textContent = error.message; status.classList.add('error'); }
  finally {
    field.value = '';
    submitting = false;
    byId('provider-button').disabled = false;
    if (current) renderJob(current);
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && current) refreshCurrent().catch(showActionError);
});

async function playAB(target) {
  if (!target.getAttribute('src')) return;
  const source = lastAB;
  const position = source.ended ? 0 : source !== target && finite(source.currentTime) ? source.currentTime : target.currentTime;
  document.querySelectorAll('audio').forEach((audio) => audio.pause());
  if (target.readyState < 1) {
    await new Promise((resolve, reject) => {
      const ready = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error('Não foi possível abrir este WAV.')); };
      const cleanup = () => { target.removeEventListener('loadedmetadata', ready); target.removeEventListener('error', fail); clearTimeout(timeout); };
      const timeout = setTimeout(fail, 20000);
      target.addEventListener('loadedmetadata', ready, { once: true });
      target.addEventListener('error', fail, { once: true });
    });
  }
  target.currentTime = Math.max(0, Math.min(position, finite(target.duration) ? Math.max(0, target.duration - 0.01) : position));
  lastAB = target;
  await target.play();
}
byId('listen-a').addEventListener('click', () => playAB(audioA).catch(showActionError));
byId('listen-b').addEventListener('click', () => playAB(audioB).catch(showActionError));
document.addEventListener('play', (event) => {
  if (!(event.target instanceof HTMLAudioElement)) return;
  const target = event.target;
  if (target === audioA || target === audioB) {
    const other = target === audioA ? audioB : audioA;
    if (!other.paused && finite(other.currentTime)) target.currentTime = Math.min(other.currentTime, finite(target.duration) ? Math.max(0, target.duration - 0.01) : other.currentTime);
    lastAB = target;
  }
  document.querySelectorAll('audio').forEach((audio) => { if (audio !== target) audio.pause(); });
}, true);

async function initialize() {
  const results = await Promise.allSettled([api('/api/music/capabilities'), api('/api/music/jobs')]);
  if (results[0].status === 'fulfilled') capabilities = results[0].value;
  else capabilities.reason = results[0].reason.message;
  updateProvider();
  if (results[1].status === 'fulfilled') {
    if (!Array.isArray(results[1].value)) throw new Error('A lista de trabalhos devolvida pelo servidor é inválida.');
    jobs = results[1].value;
    updateHistory();
    // The list omits the current DAW revision. Read the selected job before making B available.
    if (jobs.length) renderJob(await api(jobPath(jobs[0].id)), { selected: true });
  } else throw results[1].reason;
}
initialize().catch((error) => { byId('import-status').textContent = error.message; byId('import-status').classList.add('error'); });
