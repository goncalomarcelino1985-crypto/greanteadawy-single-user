// Drag-and-drop payload types shared by the Browser (drag source) and Channel Rack / Playlist (drop targets).
export const DND_INSTRUMENT = 'application/x-gtd-instrument';
export const DND_SAMPLE = 'application/x-gtd-sample';
export const isStudioDrag = (e) => [...e.dataTransfer.types].some((t) => t === DND_INSTRUMENT || t === DND_SAMPLE);
