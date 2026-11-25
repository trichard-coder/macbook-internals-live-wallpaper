// Configuration Vite de la version MacBook Pro (séparée de vite.config.ts, qui reste celle de la
// version Air). Entrée unique pro.html ; mode "single" pour le build monofichier (Plash en file://).
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';
// @ts-expect-error module JS sans déclaration de types
import { writeProfileFile } from './server/profile-pro-io.mjs';

// POST /__profile-pro réécrit profiles/pro.json (bouton « Exporter » de l'éditeur).
function profileEndpoint(): Plugin {
  return {
    name: 'pro-profile-endpoint',
    configureServer(server) {
      server.middlewares.use('/__profile-pro', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', async () => {
          try {
            await writeProfileFile(path.resolve(import.meta.dirname, 'profiles/pro.json'), JSON.parse(body));
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
  return {
    base: './',
    // Cache de dépendances séparé de celui de la version Air.
    cacheDir: 'node_modules/.vite-pro',
    plugins: [profileEndpoint(), ...(single ? [viteSingleFile()] : [])],
    build: {
      outDir: single ? 'dist-pro-single' : 'dist-pro',
      emptyOutDir: true,
      target: 'safari15',
      assetsInlineLimit: single ? 100_000_000 : 0,
      reportCompressedSize: false,
      rollupOptions: { input: path.resolve(import.meta.dirname, 'pro.html') },
    },
    server: {
      port: 5174,
      strictPort: true,
      proxy,
      // Les sources et builds ne déclenchent pas de rechargement.
      watch: { ignored: ['**/dist*/**', '**/assets/pro/src/**'] },
    },
    preview: { port: 5175, strictPort: true, proxy },
  };
});
