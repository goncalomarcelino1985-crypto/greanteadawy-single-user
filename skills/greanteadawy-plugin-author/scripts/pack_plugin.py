#!/usr/bin/env python3
"""Validate a GreanTeaDawy plugin folder and zip it for Settings -> Plugins -> Install plugin...

    python3 pack_plugin.py path/to/my-plugin [--out dist/]

Follows the studio's install checks as closely as a standalone script can (manifest schema and per-type permissions,
referenced files, file names and types, only the main file may be code, no import/importScripts, real audio
samples, size and compression limits). The studio re-checks everything on upload and has the final say. Only what
the plugin needs is packed.
"""
import io
import json
import math
import re
import sys
import zipfile
from pathlib import Path

A = re.ASCII  # JavaScript's \\w, \\d and \\b are ASCII-only: match the studio exactly
ID_RE = re.compile(r"[a-z0-9][a-z0-9.-]{1,62}[a-z0-9]", A)
VERSION_RE = re.compile(r"\d+\.\d+\.\d+([-+][\w.]+)?", A)
KEY_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,31}", A)
FILE_RE = re.compile(r"(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]{0,120}", A)
ZIP_PATH_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_./-]{0,150}", A)
AUDIO_RE = re.compile(r".*\.(wav|mp3|ogg|flac)", re.I | A)
ALLOWED_EXT = re.compile(r".*\.(json|js|wav|mp3|ogg|flac|md|txt|png)", re.I | A)
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]+")
FLOAT_RE = re.compile(r"[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|Infinity)", A)
PERMISSIONS = {"audio-processing", "samples", "generator", "project-read"}
FORBIDDEN = {"network", "internet", "storage", "files", "account", "cookies", "clipboard", "microphone", "camera"}
OPTIONAL = ["README.md", "LICENSE.txt", "LICENSE", "LICENSE.md", "icon.png"]
MAX_CODE, MAX_MANIFEST = 512 * 1024, 64 * 1024
MAX_FILES, MAX_FILE, MAX_TOTAL, MAX_ZIP, MAX_RATIO = 256, 30 * 1024 * 1024, 60 * 1024 * 1024, 20 * 1024 * 1024, 200


class PluginError(Exception):
    pass


def fail(msg):
    raise PluginError(msg)


def js_round(x):
    """Math.round: halves round up (computed without the floor(x + 0.5) rounding error)."""
    r = math.floor(x)
    return r + 1 if x - r >= 0.5 else r


# String.prototype.trim(): JavaScript's whitespace and line terminators (not Python's: e.g. U+0085 stays)
JS_SPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def js_truthy(v):
    """JavaScript truthiness: empty lists and objects are true, 0/''/null/false/NaN are false."""
    if v is None or v is False:
        return False
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v != 0 and not math.isnan(v)
    if isinstance(v, str):
        return v != ""
    return True


def text(v, max_len, what, required=False):
    """The studio's str(): missing/empty -> '' (or an error when required), non-strings refused, control characters
    replaced, trimmed and cut to max_len."""
    if v is None or v == "":
        if required:
            fail(f"{what} is required")
        return ""
    if not isinstance(v, str):
        fail(f"{what} must be a string")
    return js_slice(CONTROL_RE.sub(" ", v).strip(JS_SPACE), max_len)


def js_slice(s, n):
    """String.prototype.slice(0, n): JavaScript counts UTF-16 code units (an emoji is 2)."""
    b = s.encode("utf-16-le", "surrogatepass")
    return s if len(b) <= 2 * n else b[:2 * n].decode("utf-16-le", "surrogatepass")


def finite(v, what):
    """A JSON number (not a bool), finite, |v| <= 1e6."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or abs(v) > 1e6:
        fail(f"{what} must be a number")
    return v


def default(d, key, value):
    """JavaScript's `d[key] ?? value`."""
    v = d.get(key)
    return value if v is None else v


def js_string(v):
    """JavaScript's String(v) for JSON values (arrays join their items with commas, recursively)."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, list):
        return ",".join("" if x is None else js_string(x) for x in v)
    if isinstance(v, dict):
        return "[object Object]"
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e21:
        return str(int(v))
    return str(v)


def parse_float(v):
    """JavaScript's parseFloat(String(v))."""
    m = FLOAT_RE.match(js_string(v).lstrip(JS_SPACE))
    if not m:
        return float("nan")
    t = m.group(0).strip()
    return float(t.replace("Infinity", "inf"))


def safe_zip_path(name):
    if not ZIP_PATH_RE.fullmatch(name) or "//" in name:
        return False
    parts = name.split("/")
    return len(parts) <= 6 and all(x and not x.startswith(".") for x in parts)


def check_params(params):
    if not isinstance(params, list) or len(params) > 48:
        fail("params must be a list of at most 48")
    defs = {}
    for i, p in enumerate(params):
        if not isinstance(p, dict):
            fail(f"params[{i}] must be an object")
        key = p.get("key")
        if not isinstance(key, str) or not KEY_RE.fullmatch(key):
            fail(f"params[{i}].key must be a short identifier (letters, digits, _)")
        if key.lower().startswith("gtd"):
            fail(f'params[{i}].key: names starting with "gtd" are reserved')
        if key in defs:
            fail("param keys must be unique")
        text(p.get("label"), 32, f"params[{i}].label")
        t = p["type"] if js_truthy(p.get("type")) else "number"
        if t == "number":
            lo = finite(default(p, "min", 0), f"params[{i}].min")
            hi = finite(default(p, "max", 1), f"params[{i}].max")
            if not hi > lo:
                fail(f"params[{i}]: max must be greater than min")
            d = finite(default(p, "default", lo), f"params[{i}].default")
            if not lo <= d <= hi:
                fail(f"params[{i}].default must be between min and max")
            if p.get("curve") == "log" and not lo > 0:
                fail(f"params[{i}]: a log curve needs min > 0")
            if "step" in p:
                finite(p["step"], f"params[{i}].step")
            if js_truthy(p.get("unit")):
                text(p["unit"], 8, f"params[{i}].unit")
            if js_truthy(p.get("group")):
                text(p["group"], 24, f"params[{i}].group")
            defs[key] = {"type": "number", "min": lo, "max": hi}
        elif t == "select":
            opts = p.get("options")
            if not isinstance(opts, list) or not 1 <= len(opts) <= 24:
                fail(f"params[{i}].options must list 1-24 choices")
            options = [text(o, 24, f"params[{i}].options[{k}]", True) for k, o in enumerate(opts)]
            if default(p, "default", options[0]) not in options:
                fail(f"params[{i}].default must be one of the options (options are cut to 24 characters)")
            if js_truthy(p.get("group")):
                text(p["group"], 24, "group")
            defs[key] = {"type": "select", "options": options}
        elif t == "bool":
            if js_truthy(p.get("group")):
                text(p["group"], 24, "group")
            defs[key] = {"type": "bool"}
        else:
            fail(f"params[{i}].type must be number, select or bool")
    return defs


def check_presets(presets, defs):
    if not isinstance(presets, dict) or len(presets) > 64:
        fail("presets must be an object of at most 64 presets")
    for name, values in presets.items():
        text(name, 32, "preset name", True)
        if not isinstance(values, dict):
            fail(f'preset "{name}": must be an object')
        for k, v in values.items():
            d = defs.get(k)
            if not d:
                fail(f'preset "{name}": unknown parameter "{k}"')
            if d["type"] == "number":
                x = v if isinstance(v, (int, float)) and not isinstance(v, bool) else parse_float(v)
                if not math.isfinite(x) or not d["min"] <= x <= d["max"]:
                    fail(f'preset "{name}": "{k}" must be between {d["min"]} and {d["max"]}')
            elif d["type"] == "select" and v not in d["options"]:
                fail(f'preset "{name}": "{k}" must be one of {", ".join(d["options"])}')


def looks_like_audio(data, name):
    head = data[:12]
    ext = name.rsplit(".", 1)[-1].lower()
    if ext == "wav":
        return head[:4] == b"RIFF" and head[8:12] == b"WAVE"
    if ext == "ogg":
        return head[:4] == b"OggS"
    if ext == "flac":
        return head[:4] == b"fLaC"
    if ext == "mp3":
        return head[:3] == b"ID3" or (len(head) > 1 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0)
    return False


def no_constants(c):
    fail(f"plugin.json is not valid JSON ({c} is not a JSON number)")


def validate(folder):
    mf = folder / "plugin.json"
    if not mf.is_file():
        fail("no plugin.json in the folder")
    raw = mf.read_bytes()
    if len(raw) > MAX_MANIFEST:
        fail("plugin.json is too large (max 64 KB)")
    try:
        # JSON numbers are doubles in JavaScript: parse integers as floats too (no huge-int errors)
        m = json.loads(raw.decode("utf-8", errors="replace"), parse_constant=no_constants, parse_int=float)
    except json.JSONDecodeError as e:
        fail(f"plugin.json is not valid JSON: {e}")
    except RecursionError:
        fail("plugin.json is nested too deeply")
    if not isinstance(m, dict):
        fail("plugin.json must be a JSON object")
    if not isinstance(m.get("id"), str) or not ID_RE.fullmatch(m["id"]):
        fail('id must be 3-64 lowercase letters, digits, dots or dashes, e.g. "acme.tape-echo"')
    if not VERSION_RE.fullmatch(text(m.get("version"), 32, "version", True)):
        fail("version must look like 1.0.0")
    t = m.get("type")
    if t not in ("instrument", "effect", "generator"):
        fail("type must be instrument, effect or generator")
    api = default(m, "apiVersion", 1)
    if isinstance(api, bool) or api != 1:
        fail(f"apiVersion {api} is not supported (this studio supports 1)")
    perms = default(m, "permissions", [])
    if not isinstance(perms, list):
        fail("permissions must be a list")
    for p in perms:
        if not isinstance(p, str):
            fail("permissions must be strings")
        if p.lower() in FORBIDDEN:
            fail(f'the "{p}" permission is never granted')
        if p not in PERMISSIONS:
            fail(f'unknown permission "{p}" (known: {", ".join(sorted(PERMISSIONS))})')
    main = None if m.get("main") is None else text(m["main"], 120, "main")
    files = {"plugin.json"}
    if main:
        if not FILE_RE.fullmatch(main) or not main.endswith(".js"):
            fail("main must be a .js file inside the folder")
        if not (folder / main).is_file():
            fail(f'main "{main}" is not in the folder')
        files.add(main)
    defs = check_params(default(m, "params", []))
    samples = []
    if "samples" in m:
        zones = m["samples"]
        if not isinstance(zones, list) or len(zones) > 128:
            fail("samples must be a list of at most 128 zones")
        for i, z in enumerate(zones):
            f = text(z.get("file") if isinstance(z, dict) else None, 120, f"samples[{i}].file", True)
            if not FILE_RE.fullmatch(f) or not AUDIO_RE.fullmatch(f):
                fail(f"samples[{i}].file must be a .wav, .mp3, .ogg or .flac file in the folder")
            if not (folder / f).is_file():
                fail(f'samples[{i}].file "{f}" is not in the folder')

            def key(name, d, lo, hi):
                x = d if name not in z else js_round(finite(z[name], f"samples[{i}].{name}"))
                if not lo <= x <= hi:
                    fail(f"samples[{i}].{name} must be {lo}..{hi}")
                return x
            lo, hi = key("lo", 0, 0, 127), key("hi", 127, 0, 127)
            if hi < lo:
                fail(f"samples[{i}]: hi must be >= lo")
            vlo = 0 if "velLo" not in z else finite(z["velLo"], f"samples[{i}].velLo")
            vhi = 1 if "velHi" not in z else finite(z["velHi"], f"samples[{i}].velHi")
            if vlo < 0 or vhi > 1 or vhi < vlo:
                fail(f"samples[{i}]: velocities are 0..1 with velLo <= velHi")
            key("root", 60, 0, 127)
            samples.append(f)
            files.add(f)
    has = lambda p: p in perms  # noqa: E731
    if t == "generator":
        if not main:
            fail("a generator needs main (its .js file)")
        if not has("generator"):
            fail('a generator must ask for the "generator" permission')
        if samples or has("samples"):
            fail("generators can't ship samples")
        if has("audio-processing"):
            fail("generators don't process audio")
    else:
        if has("generator") or has("project-read"):
            fail(f"an {t} can't ask for generator or project-read")
        if main and not has("audio-processing"):
            fail('plugins with code (main) must ask for the "audio-processing" permission')
        if not main and has("audio-processing"):
            fail('"audio-processing" needs main (the DSP code)')
        if t == "effect" and not main:
            fail("an effect needs main (its DSP code)")
        if t == "effect" and samples:
            fail("effects can't ship samples")
        if t == "instrument" and not main and not samples:
            fail("an instrument needs main (DSP code) or samples")
        if samples and not has("samples"):
            fail('plugins with samples must ask for the "samples" permission')
        if not samples and has("samples"):
            fail('"samples" permission without samples')
        if main and samples:
            fail("an instrument is either DSP code (main) or samples, not both")
    if "presets" in m:
        check_presets(m["presets"], defs)
    if "polyphony" in m:
        if not 1 <= js_round(finite(m["polyphony"], "polyphony")) <= 64:
            fail("polyphony must be 1..64")
    if "defaultKey" in m:
        finite(m["defaultKey"], "defaultKey")
    text(m.get("name"), 48, "name", True)
    for k, n in (("author", 64), ("description", 600), ("license", 40)):
        text(m.get(k), n, k)
    if main:
        code = (folder / main).read_bytes()
        if len(code) > MAX_CODE:
            fail(f"{main} is too large (max 512 KB)")
        src = code.decode("utf-8", errors="replace")
        if re.search(r"\bimport\b", src, A):
            fail(f'{main} uses "import" (plugins must be a single file and may not load other code)')
        if re.search(r"\bimportScripts\b", src, A):
            fail(f"{main} uses importScripts")
        if "\x00" in src[1:] or "﻿" in src[1:]:
            fail(f"{main} contains NUL/BOM characters")
        if not re.search(r"gtd\s*(\.\s*|\[\s*['\"])register(Instrument|Effect|Generator)", src):
            print(f"! {main} doesn't seem to call gtd.registerInstrument / registerEffect / registerGenerator", file=sys.stderr)
    for f in OPTIONAL:
        if (folder / f).is_file() and not (f == "LICENSE" and "LICENSE.txt" in files):
            files.add("LICENSE.txt" if f == "LICENSE" else f)
    for name in files:
        if not ALLOWED_EXT.fullmatch(name):
            fail(f"files of this type aren't allowed in a plugin: {name}")
        if not safe_zip_path(name):
            fail(f"unsafe or unsupported file name: {name} (letters, digits, _ . - /, at most 6 levels, no hidden parts)")
    names = sorted(files)
    for name in names:  # a name can't be a file and a folder at once
        if any(other.startswith(name + "/") for other in names):
            fail(f'"{name}" is both a file and a folder')
    return m, names


def source(folder, name):
    return folder / ("LICENSE" if name == "LICENSE.txt" and not (folder / name).is_file() else name)


def build_zip(folder, names):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name in names:
            z.writestr(name, source(folder, name).read_bytes())
    data = buf.getvalue()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        infos = z.infolist()
        if len(infos) > MAX_FILES:
            fail("too many files (max 256)")
        total = 0
        for info in infos:
            if info.file_size > MAX_FILE:
                fail(f"{info.filename} is too large (max 30 MB)")
            if info.compress_size and info.file_size / info.compress_size > MAX_RATIO and info.file_size > 1024 * 1024:
                fail(f"{info.filename} compresses more than {MAX_RATIO}:1 — the studio refuses that as a possible zip bomb")
            total += info.file_size
        if total > MAX_TOTAL:
            fail("the plugin is too large unpacked (max 60 MB)")
    if len(data) > MAX_ZIP:
        fail("the zip is larger than the studio's 20 MB upload limit")
    return data


def main_cli(argv):
    for stream in (sys.stdout, sys.stderr):  # names can contain anything: never crash while printing them
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 2
    folder = Path(argv[0]).resolve()
    out_dir = Path(argv[argv.index("--out") + 1]).resolve() if "--out" in argv else folder.parent / "dist"
    try:
        m, names = validate(folder)
        for name in names:
            if AUDIO_RE.fullmatch(name) and not looks_like_audio(source(folder, name).read_bytes(), name):
                fail(f"{name} is not a valid audio file")
        data = build_zip(folder, names)
    except PluginError as e:
        print(f"x {folder.name}: {e}", file=sys.stderr)
        return 1
    out_dir.mkdir(parents=True, exist_ok=True)
    version = text(m["version"], 32, "version")
    out = out_dir / f"{m['id']}-{version}.zip"
    out.write_bytes(data)
    print(f"ok {text(m['name'], 48, 'name')} {version} ({m['type']}) -> {out} ({len(names)} files, {len(data) // 1024 or 1} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main_cli(sys.argv[1:]))
