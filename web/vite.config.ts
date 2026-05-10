import { defineConfig } from 'vite';

// GitHub Pages: 部署到 https://dtq1997.github.io/path-algebroid-viz/
// VITE_BASE 环境变量在 CI 里设, 本地 dev 走 '/'
const base = process.env.VITE_BASE || '/';

export default defineConfig({
  root: '.',
  base,
  publicDir: 'public',  // public/data/n4_simple.json → fetch /data/n4_simple.json
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
});
