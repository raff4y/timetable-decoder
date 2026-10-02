import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

// Multi-page app: only pages that exist at build time are included, so a page
// that hasn't been written yet never breaks the build. (publicDir is left at
// its default, `public/`, which the design session owns.)
const PAGES = [
  'index.html', 'login.html', 'app.html', 'pending.html', 'admin.html',
  // Free Room Finder: a separate module with its own login (docs/ARCHITECTURE.md).
  'rooms/index.html', 'rooms/login.html',
  // Admin CMS at /cms, with its own admin-only login at /cms/login (src/cms/).
  'cms/index.html', 'cms/login.html',
];

// Dev-server twin of the vercel.json rewrites: /cms -> cms/index.html.
const cmsRoute = {
  name: 'cms-route',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (/^\/cms(?:[?#]|$)/.test(req.url)) req.url = `/cms/${req.url.slice(4)}`;
      next();
    });
  },
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '');
  const apiTarget = `http://localhost:${env.API_PORT || 8787}`;
  return {
    root,
    appType: 'mpa',
    plugins: [cmsRoute],
    build: {
      rollupOptions: {
        input: Object.fromEntries(
          PAGES.filter((p) => fs.existsSync(path.join(root, p))).map((p) => [p.replace(/\.html$/, ''), path.join(root, p)]),
        ),
      },
    },
    server: {
      proxy: {
        '/api': { target: apiTarget, changeOrigin: false },
      },
    },
  };
});
