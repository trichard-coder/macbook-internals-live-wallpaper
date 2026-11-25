// Simulation réaliste de télémétrie pour la version Pro, partagée par server/telemetry-pro.mjs
// (repli quand une mesure échoue) et par le client (repli quand le serveur est injoignable).
// Copie adaptée de src/shared/simulation.mjs (version Air, non modifiée), avec en plus
// le régime des ventilateurs et les puissances CPU / GPU.
// Modèle : un fond calme avec des rafales d'activité, une batterie qui alterne charge et
// décharge, de l'audio par sessions, des ventilateurs qui suivent la chaleur avec retard.

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const rand = (a, b) => a + Math.random() * (b - a);
const approach = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

/**
 * @param {{ cores?: number, totalGB?: number }} [opts]
 */
export function createSimulator(opts = {}) {
  const cores = opts.cores ?? 14;
  const totalGB = opts.totalGB ?? 24;
  const s = {
    busy: 0.6, busyTarget: 0.6, burstLeft: rand(5, 20), inBurst: false,
    gpu: 0.05, gpuSession: 0, avg30: 0.05, load20: 0.05,
    mem: 0.6, memDrift: rand(0, Math.PI * 2),
    disk: 5e4, diskBurst: 0, net: 8e3, netBurst: 0,
    battery: 0.72, ac: false, acLeft: rand(240, 420),
    audio: false, audioLeft: rand(40, 120), volume: 0.5,
    t: 0,
  };

  return {
    step(dt = 1) {
      s.t += dt;
      s.burstLeft -= dt;
      if (s.burstLeft <= 0) {
        s.inBurst = !s.inBurst;
        s.burstLeft = s.inBurst ? rand(3, 14) : rand(10, 40);
        s.busyTarget = s.inBurst ? rand(1, cores * 0.7) : rand(0.3, 0.9);
        if (s.inBurst && Math.random() < 0.4) s.diskBurst = rand(2, 6);
      }
      s.busy = Math.max(0.05, Math.min(cores, approach(s.busy, s.busyTarget + rand(-0.15, 0.15), dt, 1.2)));
      const avg = s.busy / cores;
      s.avg30 = approach(s.avg30, avg, dt, 30);

      if (s.gpuSession > 0) s.gpuSession -= dt;
      else if (Math.random() < dt / 90) s.gpuSession = rand(10, 45);
      s.gpu = approach(s.gpu, clamp01((s.gpuSession > 0 ? rand(0.35, 0.7) : rand(0.02, 0.08)) + avg * 0.3), dt, 1.5);

      s.memDrift += dt * 0.01;
      s.mem = approach(s.mem, clamp01(0.6 + 0.08 * Math.sin(s.memDrift) + (s.inBurst ? 0.08 : 0)), dt, 8);

      if (s.diskBurst > 0) s.diskBurst -= dt;
      s.disk = s.diskBurst > 0 ? rand(4e7, 3e8) : Math.exp(rand(Math.log(1e4), Math.log(4e5)));
      if (s.netBurst > 0) s.netBurst -= dt;
      else if (Math.random() < dt / 60) s.netBurst = rand(3, 20);
      s.net = s.netBurst > 0 ? rand(2e6, 4e7) : Math.exp(rand(Math.log(1e3), Math.log(6e4)));

      s.acLeft -= dt;
      if (s.acLeft <= 0) { s.ac = !s.ac; s.acLeft = s.ac ? rand(180, 300) : rand(240, 420); }
      const charging = s.ac && s.battery < 0.995;
      s.battery = clamp01(s.battery + dt * (charging ? 0.0012 : s.ac ? 0 : -0.0006 * (1 + avg * 2)));

      s.audioLeft -= dt;
      if (s.audioLeft <= 0) {
        s.audio = !s.audio;
        s.audioLeft = s.audio ? rand(30, 120) : rand(60, 240);
        if (s.audio && Math.random() < 0.3) s.volume = Math.round(rand(0.25, 0.8) * 16) / 16;
      }

      // Ventilateurs : charge CPU + GPU lissée sur 20 s, avec un seuil (silencieux au repos).
      s.load20 = approach(s.load20, Math.max(avg * 1.6, s.gpu), dt, 20);
      const fan = clamp01(0.08 + (s.load20 - 0.12) * 1.4);
      const cpuW = 0.8 + s.busy * 2.6, gpuW = 0.3 + s.gpu * 22;
      const pressure = clamp01((s.avg30 - 0.45) * 2.5);
      return {
        t: Date.now(),
        source: 'sim',
        simulated: ['cpu', 'gpu', 'mem', 'disk', 'net', 'power', 'battery', 'thermal', 'audio', 'fan'],
        cpu: { avg, busyCores: s.busy, cores, top: clamp01(s.busy * 0.6 + 0.1), avg30: s.avg30, topProc: Math.min(s.busy, 1) * (s.inBurst ? 1 : 0.3), topProcName: s.inBurst ? 'clang' : 'Finder' },
        gpu: s.gpu,
        mem: { used: s.mem, totalGB },
        disk: { bps: s.disk },
        net: { rxBps: s.net * 0.85, txBps: s.net * 0.15 },
        power: { watts: 4 + cpuW + gpuW + (charging ? 20 : 0), source: 'sim', cpuW, gpuW },
        battery: { present: true, level: s.battery, charging, ac: s.ac, charged: s.ac && !charging },
        thermal: { pressure, level: pressure > 0.66 ? 'heavy' : pressure > 0.33 ? 'moderate' : 'nominal' },
        audio: { playing: s.audio, volume: s.volume, muted: false },
        fan: { level: fan, rpm: null, source: 'sim' },
      };
    },
  };
}
