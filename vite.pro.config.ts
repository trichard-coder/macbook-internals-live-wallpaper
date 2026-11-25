// Configuration Vite du moteur WebGL, commun aux versions MacBook Pro (pro.html) et MacBook Air
// (air.html). vite.config.ts reste celle de l'ancienne version Air en Canvas 2D (« classique »).
// Build normal : les deux pages dans dist-pro/. Mode "single" : une page par build, choisie par
// la variable WALL_DEVICE (pro ou air), dans dist-pro-single/ ou dist-air-single/.
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';
// @ts-expect-error module JS sans déclaration de types
import { writeProfileFile } from './server/profile-pro-io.mjs';

// POST /__profile-pro ou /__profile-air réécrit le profil correspondant (bouton « Exporter »).
function profileEndpoint(): Plugin {
  return {
    name: 'pro-profile-endpoint',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/__profile-(pro|air)$/);
        if (!m) { next(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', async () => {
          try {
            await writeProfileFile(path.resolve(import.meta.dirname, `profiles/${m[1]}.json`), JSON.parse(body));
            res.setHeader('Content-Type', 'application/json');
            res.end('{"ok":true}');
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
          }
        });
      });
    },
  };
}

const TELEMETRY = process.env.TELEMETRY_PRO_URL ?? 'http://127.0.0.1:8788';
const proxy = { '/telemetry': TELEMETRY, '/cursor': TELEMETRY };

export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  const deviceId = process.env.WALL_DEVICE === 'air' ? 'air' : 'pro';
  const page = (id: string) => path.resolve(import.meta.dirname, `${id}.html`);
  return {
    base: './',
    // Cache de dépendances séparé de celui de la version Air.
    cacheDir: 'node_modules/.vite-pro',
    plugins: [profileEndpoint(), ...(single ? [viteSingleFile()] : [])],
    build: {
      outDir: single ? `dist-${deviceId}-single` : 'dist-pro',
      emptyOutDir: true,
      target: 'safari15',
      assetsInlineLimit: single ? 100_000_000 : 0,
      reportCompressedSize: false,
      rollupOptions: { input: single ? page(deviceId) : { pro: page('pro'), air: page('air') } },
    },
    server: {
      port: 5174,
      strictPort: true,
      proxy,
      // Les sources et builds ne déclenchent pas de rechargement.
      watch: { ignored: ['**/dist*/**', '**/assets/pro/src/**', '**/assets/air/src/**'] },
    },
    preview: { port: 5175, strictPort: true, proxy },
  };
});
