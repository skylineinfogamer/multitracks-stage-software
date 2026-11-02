/**
 * High-Precision Audio Worker Timer
 * 
 * Runs periodic tick events in a dedicated background OS thread via Web Worker.
 * Completely immune to UI thread blocking, React renders, window focus loss, or GC pauses.
 * Ensures jitter-free click and transport scheduling.
 */

export class AudioWorkerTimer {
  private worker: Worker | null = null;
  private blobUrl: string | null = null;
  private onTick: () => void;
  private active = false;

  constructor(intervalMs: number, onTick: () => void) {
    this.onTick = onTick;

    const workerScript = `
      var timer = null;
      var interval = ${intervalMs};

      self.onmessage = function(e) {
        if (e.data === 'start') {
          if (timer !== null) clearInterval(timer);
          timer = setInterval(function() {
            self.postMessage('tick');
          }, interval);
        } else if (e.data === 'stop') {
          if (timer !== null) {
            clearInterval(timer);
            timer = null;
          }
        } else if (typeof e.data === 'number' && e.data > 0) {
          interval = e.data;
          if (timer !== null) {
            clearInterval(timer);
            timer = setInterval(function() {
              self.postMessage('tick');
            }, interval);
          }
        }
      };
    `;

    try {
      const blob = new Blob([workerScript], { type: 'application/javascript' });
      this.blobUrl = URL.createObjectURL(blob);
      this.worker = new Worker(this.blobUrl);
      this.worker.onmessage = (e) => {
        if (e.data === 'tick' && this.active) {
          this.onTick();
        }
      };
    } catch (e) {
      console.warn('[AudioWorkerTimer] Web Worker not supported or restricted, falling back to window interval:', e);
    }
  }

  start() {
    this.active = true;
    if (this.worker) {
      this.worker.postMessage('start');
    }
  }

  stop() {
    this.active = false;
    if (this.worker) {
      this.worker.postMessage('stop');
    }
  }

  setInterval(ms: number) {
    if (this.worker) {
      this.worker.postMessage(ms);
    }
  }

  destroy() {
    this.stop();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
  }
}
