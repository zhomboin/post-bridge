import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const target = env.API_PROXY_TARGET || 'http://127.0.0.1:18080';
  return {
    plugins: [react()],
    server: { proxy: { '/api': target, '/healthz': target } },
    test: { environment: 'jsdom', setupFiles: ['./tests/setup.ts'], restoreMocks: true },
  };
});
