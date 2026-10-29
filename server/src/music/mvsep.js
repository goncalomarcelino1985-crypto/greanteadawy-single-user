import { openAsBlob } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Official API and limits: https://mvsep.com/en/full_api and /en/plans.
// A fixed regional endpoint avoids forwarding credentials through redirects.
const API = 'https://de.mvsep.com/api';
const HOSTS = new Set(['mvsep.com', 'de.mvsep.com', 'de2.mvsep.com', 'sg.mvsep.com']);
const STEMS = ['drums', 'bass', 'vocals', 'other'];
const MAX_INPUT_BYTES = 100_000_000;
const MAX_JSON_BYTES = 512 * 1024;
const WAITING = new Set(['waiting', 'processing', 'distributing', 'merging']);

function failure(code, message, status = 502) {
  return Object.assign(new Error(message), { code, status });
}

function safeUrl(value, { audio = false } = {}) {
  let url;
  try { url = new URL(value); } catch {
    throw failure('MVSEP_INVALID_RESPONSE', 'O serviço devolveu um endereço inválido.');
  }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password
      || url.hash || (audio && (!url.pathname.startsWith('/storage/processed/') || !/\.wav$/i.test(url.pathname)))) {
    throw failure('MVSEP_INVALID_RESPONSE', 'O serviço devolveu um endereço de áudio não permitido.');
  }
  return url;
}

async function readJson(response) {
  const declared = response.headers?.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON_BYTES)) {
    throw failure('MVSEP_INVALID_RESPONSE', 'A resposta do serviço excede o limite permitido.');
  }
  const chunks = [];
  let size = 0;
  if (!response.body) throw failure('MVSEP_INVALID_RESPONSE', 'O serviço não devolveu uma resposta válida.');
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel();
        throw failure('MVSEP_INVALID_RESPONSE', 'A resposta do serviço excede o limite permitido.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw failure('MVSEP_INVALID_RESPONSE', 'O serviço não devolveu uma resposta válida.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('MVSEP_INVALID_RESPONSE', 'O serviço não devolveu uma resposta válida.');
  }
  return value;
}

function resultFiles(data) {
  if (!data || !Array.isArray(data.files) || data.files.length < 4 || data.files.length > 8) {
    throw failure('MVSEP_INVALID_RESULT', 'O serviço não devolveu os quatro stems esperados.');
  }
  if (data.output_format !== undefined && ![1, '1', 'wav', 'wav (uncompressed, 16 bit)'].includes(data.output_format)) {
    throw failure('MVSEP_INVALID_RESULT', 'O serviço não confirmou o formato WAV solicitado.');
  }
  const files = {};
  for (const file of data.files) {
    if (!file || typeof file !== 'object' || typeof file.url !== 'string') {
      throw failure('MVSEP_INVALID_RESULT', 'O serviço devolveu um stem inválido.');
    }
    const url = safeUrl(file.url, { audio: true });
    // Official examples use {url, download}; category/name may additionally be present.
    // Only the terminal stem suffix counts: words in the user's filename must not match.
    let filename;
    try { filename = decodeURIComponent(url.pathname.split('/').at(-1)); } catch {
      throw failure('MVSEP_INVALID_RESULT', 'O serviço devolveu um nome de stem inválido.');
    }
    const suffix = filename.toLowerCase().match(/(?:^|[_\s-])(drums|bass|vocals|other|instrumental|instrum)\.wav$/)?.[1];
    const category = typeof file.category === 'string' ? file.category.toLowerCase().trim() : null;
    const stem = STEMS.includes(category) ? category : suffix;
    if (STEMS.includes(category) && suffix && category !== suffix) {
      throw failure('MVSEP_INVALID_RESULT', 'A identificação dos stems é contraditória.');
    }
    if (stem === 'instrumental' || stem === 'instrum') continue;
    if (!STEMS.includes(stem) || files[stem]) {
      throw failure('MVSEP_INVALID_RESULT', 'Os stems devolvidos estão incompletos ou duplicados.');
    }
    files[stem] = url.href;
  }
  if (!STEMS.every(stem => files[stem]) || new Set(Object.values(files)).size !== 4) {
    throw failure('MVSEP_INVALID_RESULT', 'O serviço não devolveu quatro stems distintos.');
  }
  return files;
}

/** No API calls or model execution occur on construction. Results contain private
 * provider URLs: keep them on the server and expose only authenticated app routes.
 * Unit tests use a mocked fetch; they do not prove a real cloud separation. */
export function createMvsepProvider({ token, fetchImpl = fetch, pollIntervalMs = 15000,
  timeoutMs = 60 * 60 * 1000 } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw failure('MVSEP_CONFIGURATION', 'A configuração do serviço de separação é inválida.', 500);
  }
  let busy = false;

  function requireToken() {
    if (typeof token !== 'string' || !token.trim() || token.length > 4096 || /[\r\n]/.test(token)) {
      throw failure('MVSEP_AUTH_REQUIRED', 'Falta ligar uma conta gratuita MVSEP para separar a música.', 503);
    }
  }

  async function request(url, options, signal) {
    safeUrl(url);
    try {
      const response = await fetchImpl(String(url), { ...options, redirect: 'error', credentials: 'omit',
        signal, headers: { Accept: 'application/json' } });
      if (response.url) safeUrl(response.url);
      if (response.status >= 300 && response.status < 400) {
        throw failure('MVSEP_REDIRECT', 'O serviço pediu um redirecionamento; o envio foi interrompido.');
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw failure('MVSEP_AUTH_REQUIRED', 'A conta MVSEP precisa de autenticação válida.', 503);
        }
        if (response.status === 429) throw failure('MVSEP_QUOTA', 'O limite gratuito do serviço foi atingido. Tenta mais tarde.', 429);
        throw failure('MVSEP_UNAVAILABLE', 'O serviço de separação está indisponível. Tenta mais tarde.');
      }
      return await readJson(response);
    } catch (error) {
      if (error?.code?.startsWith('MVSEP_')) throw error;
      if (signal.aborted) throw failure('MVSEP_TIMEOUT', 'A separação excedeu o tempo de espera. Não foi iniciado outro pedido.', 504);
      // Never expose remote text, request URLs, credentials or underlying fetch causes.
      throw failure('MVSEP_NETWORK', 'Não foi possível comunicar com o serviço de separação.');
    }
  }

  async function checkAccount(signal) {
    requireToken();
    const url = new URL(`${API}/app/user`);
    url.searchParams.set('api_token', token);
    const response = await request(url, { method: 'GET' }, signal);
    if (response.success !== true || !response.data || ![0, '0'].includes(response.data.premium_enabled)) {
      throw failure('MVSEP_FREE_REQUIRED', 'A separação está bloqueada: a conta tem de confirmar que o consumo de créditos está desativado.', 409);
    }
    // Do not return the API key, email, credit balance or other account details.
    return { provider: 'MVSEP', premiumEnabled: false, paidCreditsAllowed: false };
  }

  async function checkFreeAccount() {
    return checkAccount(AbortSignal.timeout(Math.min(timeoutMs, 30000)));
  }

  async function separate({ inputPath, onProgress = () => {} } = {}) {
    requireToken();
    if (busy) throw failure('MVSEP_BUSY', 'Já existe uma separação em curso. Aguarda o resultado.', 409);
    busy = true;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      if (typeof inputPath !== 'string' || !inputPath) {
        throw failure('MVSEP_INPUT', 'É necessário um ficheiro WAV válido para separar.', 400);
      }
      let file, info;
      try {
        info = await lstat(inputPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size < 44 || info.size > MAX_INPUT_BYTES) {
          throw new Error('input');
        }
        file = await open(inputPath, 'r');
        const header = Buffer.alloc(12);
        await file.read(header, 0, 12, 0);
        if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('input');
      } catch {
        throw failure('MVSEP_INPUT', 'O ficheiro tem de ser WAV, não vazio, e ter no máximo 100 MB.', 400);
      } finally { await file?.close(); }
      await checkAccount(signal);
      const form = new FormData();
      let audio;
      try { audio = await openAsBlob(inputPath, { type: 'audio/wav' }); } catch {
        throw failure('MVSEP_INPUT', 'Não foi possível ler o WAV para separação.', 400);
      }
      form.set('audiofile', audio, 'input.wav');
      form.set('api_token', token);
      form.set('sep_type', '20');
      form.set('add_opt1', '0');
      form.set('output_format', '1');
      form.set('is_demo', '0');
      onProgress({ status: 'submitting' });
      // Never retry this POST automatically: a network failure may still have created a job.
      const created = await request(`${API}/separation/create`, { method: 'POST', body: form }, signal);
      const jobHash = created.data?.hash;
      if (created.success !== true || typeof jobHash !== 'string' || !/^[A-Za-z0-9._-]{1,512}$/.test(jobHash)) {
        throw failure('MVSEP_CREATE_FAILED', 'O serviço não confirmou a criação da separação. Não foi iniciado outro pedido.');
      }
      const pollUrl = new URL(`${API}/separation/get`);
      pollUrl.searchParams.set('hash', jobHash);
      for (;;) {
        const result = await request(pollUrl, { method: 'GET' }, signal);
        if (result.status === 'failed' || result.status === 'not_found') {
          throw failure('MVSEP_JOB_FAILED', 'A separação falhou ou expirou no serviço. O original permanece preservado.');
        }
        if (result.success !== true || (result.status !== 'done' && !WAITING.has(result.status))) {
          throw failure('MVSEP_INVALID_RESPONSE', 'O serviço devolveu um estado de separação desconhecido.');
        }
        if (result.status === 'done') {
          const files = resultFiles(result.data);
          onProgress({ status: 'separated' });
          return { files, model: 'htdemucs_ft', provider: 'MVSEP', jobHash };
        }
        const event = { status: result.status };
        if (Number.isSafeInteger(result.data?.current_order) && result.data.current_order >= 0) {
          event.queuePosition = result.data.current_order;
        }
        onProgress(event);
        try { await delay(pollIntervalMs, undefined, { signal }); } catch {
          throw failure('MVSEP_TIMEOUT', 'A separação excedeu o tempo de espera. Não foi iniciado outro pedido.', 504);
        }
      }
    } finally { busy = false; }
  }

  return { checkFreeAccount, separate };
}
