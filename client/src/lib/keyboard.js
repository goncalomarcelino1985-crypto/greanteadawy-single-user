// Global keyboard: transport/window shortcuts and the "typing keyboard to piano".
import { useStore } from '../state/store.js';
import { newPattern } from './actions.js';

// Two rows: Z-row = lower octave, Q-row = upper octave
const PIANO = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21,
  Digit7: 22, KeyU: 23, KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28, BracketLeft: 29, Equal: 30, BracketRight: 31
};

// physical key -> { key, channelId } captured at key-down, so key-up releases the same note even if
// the octave or selected channel changed while the key was held
const heldKeys = new Map();

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function installKeyboard() {
  const down = (e) => {
    if (isTyping(e)) return;
    const st = useStore.getState();
    if (!st.project) return;
    const mod = e.ctrlKey || e.metaKey;
    if (st.modal) return;

    if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) st.redo(); else st.undo(); return; }
    if (mod && e.code === 'KeyY') { e.preventDefault(); st.redo(); return; }
    if (mod && e.code === 'KeyS') { e.preventDefault(); st.toast('Projects save automatically', 'info', 1800); return; }
    if (mod) return; // leave other ctrl shortcuts to focused editors / browser

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        st.unlockAudio();
        st.togglePlay();
        return;
      case 'F5': e.preventDefault(); st.toggleWindow('playlist'); return;
      case 'F6': e.preventDefault(); st.toggleWindow('channelRack'); return;
      case 'F7': e.preventDefault(); st.toggleWindow('pianoRoll'); return;
      case 'F8':
        e.preventDefault();
        if (e.altKey) st.setPref('browserOpen', !st.browserOpen);
        else st.toggleWindow('channelSettings');
        return;
      case 'F9': e.preventDefault(); st.toggleWindow('mixer'); return;
      case 'F4': e.preventDefault(); newPattern(); return;
      case 'Escape': st.hideContextMenu(); return;
      default:
    }
    if (e.altKey) return;
    if (e.code === 'KeyL' && e.shiftKey) { st.setMode(st.mode === 'song' ? 'pattern' : 'song'); return; }
    if (e.code === 'NumpadAdd' || (e.code === 'ArrowUp' && e.shiftKey && !e.target.closest?.('.piano-roll'))) {
      const i = st.project.patterns.findIndex((p) => p.id === st.selectedPatternId);
      if (i < st.project.patterns.length - 1) st.selectPattern(st.project.patterns[i + 1].id);
      return;
    }
    if (e.code === 'NumpadSubtract') {
      const i = st.project.patterns.findIndex((p) => p.id === st.selectedPatternId);
      if (i > 0) st.selectPattern(st.project.patterns[i - 1].id);
      return;
    }
    if (e.target.closest?.('.piano-roll-grid, .playlist-grid') && ['Delete', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) return;
    if (e.code === 'ArrowDown' && e.shiftKey) return;
    if (e.code === 'Minus' && !e.repeat) { const o = Math.max(0, st.kbOctave - 1); st.setPref('kbOctave', o); st.toast(`Keyboard octave C${o}`, 'info', 1000); return; }
    if (e.code === 'Equal' && e.shiftKey && !e.repeat) { const o = Math.min(8, st.kbOctave + 1); st.setPref('kbOctave', o); st.toast(`Keyboard octave C${o}`, 'info', 1000); return; }
    if (e.shiftKey) return;
    const semi = PIANO[e.code];
    if (semi !== undefined) {
      e.preventDefault();
      if (e.repeat || heldKeys.has(e.code)) return;
      const key = (st.kbOctave + 1) * 12 + semi;
      if (key <= 127 && st.selectedChannelId) {
        heldKeys.set(e.code, { key, channelId: st.selectedChannelId });
        st.liveNoteOn(key, 0.8, st.selectedChannelId);
      }
    }
  };
  const up = (e) => {
    const h = heldKeys.get(e.code);
    if (!h) return;
    heldKeys.delete(e.code);
    useStore.getState().liveNoteOff(h.key, h.channelId);
  };
  const blur = () => {
    heldKeys.clear();
    useStore.getState().finishRecordingNotes();
  };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', blur);
  return () => {
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
    window.removeEventListener('blur', blur);
  };
}

export const SHORTCUTS = [
  ['Space', 'Play / stop'],
  ['Shift+L', 'Toggle pattern / song mode'],
  ['F4', 'New pattern'],
  ['F5 / F6 / F7 / F8 / F9', 'Playlist / Channel rack / Piano roll / Channel settings / Mixer'],
  ['Alt+F8', 'Toggle browser'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo (also undoes Claude\'s edits)'],
  ['Z S X D C V … / Q 2 W 3 E …', 'Play the selected channel from your computer keyboard (two octaves)'],
  ['- / Shift+=', 'Keyboard octave down / up'],
  ['Numpad + / -', 'Next / previous pattern'],
  ['Channel rack: Ctrl+click a channel light', 'Solo the channel'],
  ['Piano roll: click / drag', 'Draw notes, drag to move, drag right edge to resize, right-click to delete'],
  ['Piano roll: Shift+click / Ctrl+drag', 'Add to selection / box select'],
  ['Piano roll: Alt+drag', 'Duplicate the dragged notes'],
  ['Piano roll: Ctrl+A, Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+D, Del', 'Select all, copy, cut, paste, duplicate, delete'],
  ['Piano roll: Ctrl+Q', 'Quantize (selection or all)'],
  ['Piano roll: ↑ ↓ (Shift = octave), ← →', 'Transpose / nudge selected notes'],
  ['Playlist: click / drag', 'Paint the selected pattern, drag clips, edges resize/trim, right-click for options'],
  ['Playlist: Shift+drag, Ctrl+A, Ctrl+D, Del', 'Duplicate clips, select all, duplicate selection, delete'],
  ['Wave editor: drag / Shift+click / double-click', 'Select a range / extend it / select everything'],
  ['Wave editor: Space, Ctrl+Z, Ctrl+Shift+Z', 'Play the selection; undo / redo (the editor\'s own history)'],
  ['Wave editor: Ctrl+X, Ctrl+C, Ctrl+V, Ctrl+A, Del, + / −', 'Cut, copy, paste, select all, delete, zoom'],
  ['Pitch correction: drag a note (Alt = fine), ↑ ↓, 0, B, [ ], Esc', 'Move it, nudge it, back to the scale, bypass, previous / next note, deselect'],
  ['Knobs & faders', 'Drag up/down (Shift = fine), wheel, double-click to reset; Tab to focus, then arrow keys, Home/End, Delete']
];
