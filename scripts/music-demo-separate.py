#!/usr/bin/env python3
"""Bounded public-source CI demo; importing this module never imports a model.

The only accepted source is scripts/music-demo-source.json, reviewed and tracked
in Git. There are no URL, path, credential, model or duration CLI overrides.
Manifest schema: schemaVersion=1; source={url, sha256, format, title, artist,
pageUrl}; license={id, url, attribution}; approved={publicAudio, remix,
redistribution}; clip={startSeconds, durationSeconds}. All approval values must
be true. Source and licence URLs must be HTTPS without credentials/query strings.

This script produces files only. It never publishes, commits or accesses the
private studio, Neon, Render or user music. Heavy execution is Linux CI-only.
"""

import argparse
import array
import copy
import hashlib
import importlib.metadata
import ipaddress
import json
import math
import os
from pathlib import Path
import random
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import wave

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'scripts/music-demo-source.json'
OUTPUT = ROOT / 'demo-output'
MAX_SECONDS = 30
MAX_BYTES = 32 * 1024 * 1024
RATE = 44100
STEMS = ('vocals', 'drums', 'bass', 'other')
MODEL = 'htdemucs'
VERSIONS = {'demucs': '4.0.1', 'torch': '2.2.2', 'torchaudio': '2.2.2', 'numpy': '1.26.4'}
LICENSES = {'CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'CC-BY-SA-3.0', 'CC-BY-SA-4.0'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def public_url(value):
    require(isinstance(value, str) and len(value) <= 2000, 'Invalid public URL')
    parsed = urllib.parse.urlsplit(value)
    require(parsed.scheme == 'https' and parsed.hostname and not parsed.username
            and not parsed.password and not parsed.query and not parsed.fragment
            and parsed.port in (None, 443), 'Only plain public HTTPS URLs are allowed')
    require('.' in parsed.hostname and not parsed.hostname.endswith(('.localhost', '.local', '.internal')),
            'Private hosts are not allowed')
    try:
        literal = ipaddress.ip_address(parsed.hostname)
    except ValueError:
        literal = None
    require(literal is None, 'Source URLs must use reviewed public hostnames')
    return parsed


def validate_manifest(value):
    require(isinstance(value, dict) and value.get('schemaVersion') == 1, 'Manifest schemaVersion must be 1')
    source, license_info, approved, clip = (value.get(key, {}) for key in ('source', 'license', 'approved', 'clip'))
    require(all(isinstance(item, dict) for item in (source, license_info, approved, clip)), 'Malformed manifest')
    require(all(approved.get(key) is True for key in ('publicAudio', 'remix', 'redistribution')),
            'The source must be reviewed for public audio, remix and redistribution')
    for key in ('url', 'pageUrl'):
        public_url(source.get(key))
    public_url(license_info.get('url'))
    require(source.get('format') in ('wav', 'mp3', 'flac', 'ogg'), 'Unsupported source format')
    require(isinstance(source.get('sha256'), str) and re.fullmatch(r'[0-9a-f]{64}', source['sha256']),
            'Pin the complete source SHA-256 before running')
    if 'bytes' in source:
        require(type(source['bytes']) is int and 0 < source['bytes'] <= MAX_BYTES, 'Invalid source size')
    require(license_info.get('id') in LICENSES, 'A reviewed public remix licence is required')
    for section, key in ((source, 'title'), (source, 'artist'), (license_info, 'attribution')):
        require(isinstance(section.get(key), str) and 0 < len(section[key]) <= 2000
                and not any(ord(char) < 32 for char in section[key]), 'Missing or malformed attribution')
    for key in ('startSeconds', 'durationSeconds'):
        require(type(clip.get(key)) in (int, float) and math.isfinite(clip[key]), 'Invalid excerpt bounds')
    require(0 <= clip['startSeconds'] <= 600 and 1 <= clip['durationSeconds'] <= MAX_SECONDS,
            'The excerpt must be 1–30 seconds and start within the first 10 minutes')
    return value


def load_manifest():
    require(MANIFEST.is_file() and not MANIFEST.is_symlink(), 'Reviewed source manifest is not configured')
    tracked = subprocess.run(['git', 'ls-files', '--error-unmatch', '--', 'scripts/music-demo-source.json'],
                             cwd=ROOT, capture_output=True, timeout=5, check=False)
    require(tracked.returncode == 0, 'The reviewed source manifest must be tracked in Git')
    require(MANIFEST.stat().st_size <= 16384, 'Manifest exceeds its size limit')
    return validate_manifest(json.loads(MANIFEST.read_text(encoding='utf-8')))


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Source redirects are not allowed; review and pin the final public URL')


def download_source(source, target):
    parsed = public_url(source['url'])
    addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
    require(addresses and all(ipaddress.ip_address(item[4][0]).is_global for item in addresses),
            'Source host must resolve exclusively to public addresses')
    # Do not inherit proxy credentials, follow redirects or send auth headers.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirects())
    # The reviewed ccMixter source requires browser-style public request headers.
    request = urllib.request.Request(source['url'], headers={
        'User-Agent': 'Mozilla/5.0 (compatible; GM-AI-Worker-Public-Demo/1)',
        'Referer': source['pageUrl'],
    })
    digest, count, began = hashlib.sha256(), 0, time.monotonic()
    with opener.open(request, timeout=15) as response, target.open('xb') as output:
        require(response.status == 200, 'Public source download failed')
        length = response.headers.get('Content-Length')
        require(length is None or int(length) <= MAX_BYTES, 'Source exceeds 32 MiB')
        while True:
            require(time.monotonic() - began < 90, 'Source download exceeded its time limit')
            chunk = response.read(65536)
            if not chunk:
                break
            count += len(chunk)
            require(count <= MAX_BYTES, 'Source exceeds 32 MiB')
            output.write(chunk)
            digest.update(chunk)
    require(count > 0 and digest.hexdigest() == source['sha256'], 'Source SHA-256 did not match the reviewed manifest')
    require('bytes' not in source or source['bytes'] == count, 'Source size did not match the reviewed manifest')


def wav_info(file):
    with wave.open(str(file), 'rb') as wav:
        require(wav.getsampwidth() == 2 and wav.getnchannels() == 2 and wav.getframerate() == RATE,
                'Output must be stereo 16-bit PCM at 44100 Hz')
        frames = wav.getnframes()
        require(0 < frames <= MAX_SECONDS * RATE, 'Output duration exceeds the limit')
        pcm = array.array('h', wav.readframes(frames))
    if sys.byteorder != 'little':
        pcm.byteswap()
    require(len(pcm) == frames * 2, 'Truncated WAV')
    rms = math.sqrt(sum(sample * sample for sample in pcm) / len(pcm)) / 32768
    return {'bytes': file.stat().st_size, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(),
            'sampleRate': RATE, 'channels': 2, 'bitDepth': 16, 'frames': frames,
            'durationSeconds': frames / RATE, 'peak': max(abs(sample) for sample in pcm) / 32768,
            'rms': rms, 'rmsDbfs': 20 * math.log10(rms) if rms else None,
            'nonZeroSamples': sum(sample != 0 for sample in pcm),
            'clippedSamples': sum(sample in (-32768, 32767) for sample in pcm)}


def separate(manifest):
    require(sys.platform == 'linux' and os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted',
            'Model execution is restricted to the GitHub-hosted Linux runner')
    require(not OUTPUT.exists(), 'demo-output already exists; refusing to overwrite it')
    for package, expected in VERSIONS.items():
        require(importlib.metadata.version(package).split('+')[0] == expected,
                f'Unexpected {package} version')
    # Heavy dependencies are never imported by validation or lightweight tests.
    import numpy as np
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    torch.manual_seed(0)
    random.seed(0)
    np.random.seed(0)
    require(torch.version.cuda is None, 'Install CPU-only PyTorch wheels')
    began = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='gm-public-demo-') as temporary:
        work = Path(temporary)
        source = work / ('source.' + manifest['source']['format'])
        download_source(manifest['source'], source)
        mixture = work / 'mixture.wav'
        safe_env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TMPDIR') if key in os.environ}
        converted = subprocess.run(['ffmpeg', '-hide_banner', '-nostdin', '-loglevel', 'error',
            '-protocol_whitelist', 'file', '-f', manifest['source']['format'], '-i', str(source),
            '-ss', str(manifest['clip']['startSeconds']), '-t', str(manifest['clip']['durationSeconds']),
            '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-threads', '4', '-filter_threads', '4',
            '-ar', str(RATE), '-ac', '2', '-c:a', 'pcm_s16le', '-f', 'wav', str(mixture)],
            env=safe_env, capture_output=True, timeout=90, check=False)
        require(converted.returncode == 0, 'Public source could not be decoded as the reviewed audio format')
        input_info = wav_info(mixture)
        require(input_info['nonZeroSamples'] > 0, 'The source excerpt is silent')
        require(abs(input_info['durationSeconds'] - manifest['clip']['durationSeconds']) < 0.1,
                'Source is shorter than the reviewed excerpt')
        with wave.open(str(mixture), 'rb') as wav:
            samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32)
        audio = torch.from_numpy(samples.reshape(-1, 2).T.copy() / 32768)
        model = get_model(MODEL).cpu().eval()
        require(set(model.sources) == set(STEMS), 'The model must return exactly four expected stems')
        reference = audio.mean(0)
        mean, std = reference.mean(), reference.std()
        require(float(std) > 1e-8, 'The source cannot be normalized safely')
        with torch.inference_mode():
            estimates = apply_model(model, ((audio - mean) / std)[None], device='cpu', shifts=1,
                                    split=True, overlap=0.25, progress=False, num_workers=0, segment=7)[0]
            estimates = estimates * std + mean
        require(bool(torch.isfinite(estimates).all()), 'The separator produced non-finite audio')
        require(tuple(estimates.shape) == (4, 2, input_info['frames']), 'Unexpected stem dimensions')
        peak = max(float(audio.abs().max()), float(estimates.abs().max()))
        gain = min(1.0, 0.98 / max(peak, 1e-8))
        # One gain for every output preserves relative levels; never normalize stems independently.
        outputs = {'mixture': audio, **dict(zip(model.sources, estimates))}
        result = work / 'result'
        result.mkdir()
        for name, data in outputs.items():
            pcm = np.rint(data.numpy().T * gain * 32767).astype('<i2')
            with wave.open(str(result / f'{name}.wav'), 'wb') as wav:
                wav.setnchannels(2)
                wav.setsampwidth(2)
                wav.setframerate(RATE)
                wav.writeframes(pcm.tobytes())
        measured = {f'{name}.wav': wav_info(result / f'{name}.wav') for name in ('mixture', *STEMS)}
        require(all(info['nonZeroSamples'] > 0 for info in measured.values()), 'One or more outputs are silent')
        require(len({info['sha256'] for info in measured.values()}) == 5, 'Outputs must not be duplicated audio')
        residual = estimates.sum(0) - audio
        report = {'schemaVersion': 1, 'source': manifest['source'], 'license': manifest['license'],
                  'clip': manifest['clip'], 'model': MODEL, 'device': 'cpu', 'threads': 4,
                  'versions': {name: importlib.metadata.version(name) for name in VERSIONS},
                  'sourceCommit': os.environ.get('GITHUB_SHA'), 'elapsedSeconds': round(time.monotonic() - began, 3),
                  'outputCommonGain': gain, 'decodedInputSha256': input_info['sha256'],
                  'reconstructionResidualRms': float(residual.square().mean().sqrt()),
                  'audio': measured, 'listeningQualityValidated': False,
                  'note': 'Real model separation; waveform checks do not establish musical quality.'}
        (result / 'report.json').write_text(json.dumps(report, indent=2, allow_nan=False) + '\n')
        license_info = manifest['license']
        (result / 'SOURCE-LICENSE.txt').write_text(
            f"{manifest['source']['title']} — {manifest['source']['artist']}\n"
            f"Source: {manifest['source']['pageUrl']}\n"
            f"Licence: {license_info['id']} — {license_info['url']}\n"
            f"Attribution: {license_info['attribution']}\n"
            f"Changes: {manifest['clip']['durationSeconds']}s excerpt at {manifest['clip']['startSeconds']}s; "
            'converted to PCM; separated with Demucs; common gain applied.\n'
            'This licence applies to the source audio and derived stems, independently of the code licence.\n')
        require(sum(file.stat().st_size for file in result.iterdir()) <= MAX_BYTES, 'Outputs exceed 32 MiB')
        shutil.copytree(result, OUTPUT)
    print('PASS: four real separated stems and mixture verified; no files published.')


def self_test():
    fixture = {'schemaVersion': 1, 'source': {'url': 'https://example.org/source.wav', 'sha256': 'a' * 64,
        'format': 'wav', 'title': 'Synthetic test', 'artist': 'Test', 'pageUrl': 'https://example.org/source'},
        'license': {'id': 'CC0-1.0', 'url': 'https://creativecommons.org/publicdomain/zero/1.0/', 'attribution': 'Test'},
        'approved': {'publicAudio': True, 'remix': True, 'redistribution': True},
        'clip': {'startSeconds': 0, 'durationSeconds': 30}}
    validate_manifest(fixture)
    rejected = 0
    changes = [('source', 'url', 'https://127.0.0.1/test.wav'), ('source', 'url', 'file:///tmp/music.wav'),
               ('source', 'url', 'https://example.org/test?token=secret'), ('source', 'url', 'https://x:y@example.org/a'),
               ('source', 'sha256', 'bad'), ('source', 'format', 'hls'), ('clip', 'durationSeconds', 31),
               ('clip', 'durationSeconds', float('nan')), ('clip', 'startSeconds', -1),
               ('approved', 'remix', False), ('approved', 'redistribution', 'true'), ('license', 'id', 'unknown')]
    for section, key, value in changes:
        bad = copy.deepcopy(fixture)
        bad[section][key] = value
        try:
            validate_manifest(bad)
        except ValueError:
            rejected += 1
    require(rejected == len(changes), 'Manifest boundary regression')
    with tempfile.TemporaryDirectory(prefix='gm-demo-unit-') as temporary:
        file = Path(temporary) / 'test.wav'
        with wave.open(str(file), 'wb') as wav:
            wav.setnchannels(2)
            wav.setsampwidth(2)
            wav.setframerate(RATE)
            wav.writeframes(b'\x00\x20\x00\xe0' * 441)
        info = wav_info(file)
        require(info['frames'] == 441 and info['peak'] == 0.25 and info['rms'] == 0.25
                and info['nonZeroSamples'] == 882 and info['clippedSamples'] == 0, 'PCM analysis regression')
    require('torch' not in sys.modules and 'numpy' not in sys.modules, 'Light tests must not import model dependencies')
    print(f'PASS: {len(changes)} rejected unsafe manifests, valid fixture and tiny PCM analysis; no network or models.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check-manifest', action='store_true')
    mode.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        manifest = load_manifest()
        if args.check_manifest:
            print('PASS: tracked public source, hash, licence and excerpt bounds reviewed.')
        else:
            separate(manifest)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print network exceptions, request URLs, environment or provider response bodies.
        message = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(f'Music demo stopped: {message}', file=sys.stderr)
        sys.exit(1)
