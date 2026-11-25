import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';
// @ts-expect-error module JS sans déclaration de types
import { writeZonesFile } from './server/zones-io.mjs';

// Endpoint du serveur de dev : POST /__zones réécrit src/zones.json (bouton « Exporter » de l'éditeur).
function zonesEndpoint(): Plugin {
  return {
    name: 'zones-endpoint',
    configureServer(server) {
      server.middlewares.use('/__zones', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        // Pages locales uniquement : un site tiers ne doit pas pouvoir réécrire le fichier.
        const origin = req.headers.origin;
        if (origin && origin !== 'null' && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
          res.statusCode = 403; res.end(); return;
        }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', async () => {
          try {
            await writeZonesFile(path.resolve(import.meta.dirname, 'src/zones.json'), JSON.parse(body));
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

const TELEMETRY = process.env.TELEMETRY_URL ?? 'http://127.0.0.1:8787';
const proxy = { '/telemetry': TELEMETRY, '/cursor': TELEMETRY };

export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    base: './',
    plugins: [zonesEndpoint(), ...(single ? [viteSingleFile()] : [])],
    build: {
      outDir: single ? 'dist-single' : 'dist',
      emptyOutDir: true,
      target: 'safari15',
      assetsInlineLimit: single ? 100_000_000 : 0,
      reportCompressedSize: false,
    },
    server: { port: 5173, proxy },
    preview: { port: 5174, proxy },
  };
});
