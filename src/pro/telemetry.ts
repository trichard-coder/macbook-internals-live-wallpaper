// Client du flux SSE /telemetry (copie de src/telemetry.ts, version Air, non modifiée).
// Si le serveur est injoignable, une simulation locale prend le relais et la reconnexion est retentée avec un délai croissant (5 s à 5 min), pour ne pas
// encombrer la console ni consommer de ressources.

import { createSimulator } from './sim.mjs';
import type { TelemetrySnapshot } from './types';

export type TelemetryStatus = 'connecting' | 'live' | 'sim';

export class TelemetryClient {
  status: TelemetryStatus = 'connecting';
  last: TelemetrySnapshot | null = null;
  private es: EventSource | null = null;
  private sim = createSimulator({ cores: navigator.hardwareConcurrency || 14 });
  private simTimer = 0;
  private retryTimer = 0;
  private watchdog = 0;
  private lastMsg = 0;
  private retryDelay = 15000;
  private running = false;

  constructor(private url: string | null, private onSnap: (s: TelemetrySnapshot) => void) {}

  start() {
    if (this.running) return;
    this.running = true;
    if (!this.url) { this.startSim(); return; }
    this.connect();
    this.watchdog = window.setInterval(() => {
      // Flux ouvert mais muet depuis 6 s : on considère la source perdue.
      if (this.es && this.lastMsg && performance.now() - this.lastMsg > 6000) this.fail();
    }, 3000);
  }

  stop() {
    this.running = false;
    this.es?.close();
    this.es = null;
    clearInterval(this.simTimer); this.simTimer = 0;
    clearTimeout(this.retryTimer);
    clearInterval(this.watchdog);
  }

  private connect() {
    if (!this.running || !this.url) return;
    this.status = this.simTimer ? 'sim' : 'connecting';
    const es = new EventSource(this.url);
    this.es = es;
    es.onmessage = (e) => {
      this.lastMsg = performance.now();
      this.retryDelay = 15000;
      this.stopSim();
      this.status = 'live';
      try { this.emit(JSON.parse(e.data)); } catch { /* message invalide ignoré */ }
    };
    es.onerror = () => {
      // Erreur passagère d'un flux qui marchait : EventSource se reconnecte seul.
      if (this.lastMsg && performance.now() - this.lastMsg < 4000) return;
      this.fail();
    };
  }

  private fail() {
    this.es?.close();
    this.es = null;
    this.lastMsg = 0;
    this.startSim();
    clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 300000);
  }

  private startSim() {
    this.status = 'sim';
    if (this.simTimer) return;
    this.emit(this.sim.step(1));
    this.simTimer = window.setInterval(() => this.emit(this.sim.step(1)), 1000);
  }

  private stopSim() {
    clearInterval(this.simTimer);
    this.simTimer = 0;
  }

  private emit(s: TelemetrySnapshot) {
    this.last = s;
    this.onSnap(s);
  }
}
