// Runs the shot analysis off the UI thread.
import { analyze } from './shots.js';

self.onmessage = (e) => {
  const { seq, balls, opts } = e.data;
  try {
    const shots = analyze(balls, opts);
    self.postMessage({ seq, shots });
  } catch (err) {
    self.postMessage({ seq, error: String(err && err.stack || err) });
  }
};
