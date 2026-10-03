// Background renderer for physical-model notes (piano, guitar, bass, pizzicato and the world strings): see modelPool.js.
import { renderModel } from './models.js';

self.onmessage = (e) => {
  const { id, model, sr, key, layer, p } = e.data;
  try {
    const data = renderModel(model, sr, key, layer, p);
    self.postMessage({ id, data }, [data.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
