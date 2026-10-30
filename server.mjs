import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createMapRepository } from './server/repository.js';
import { createApiHandler } from './server/api.js';
import { createAdminHandler } from './server/admin-api.js';

export async function createAppServer({ root = path.dirname(fileURLToPath(import.meta.url)), development = false, databasePath = process.env.HDU_DB_PATH, repository: providedRepository, rateLimit = { windowMs: 60_000, max: 1000 }, logger = console, publicOrigin = process.env.HDU_PUBLIC_ORIGIN } = {}) {
  const dist = path.resolve(root, 'dist');
  const repository = providedRepository || createMapRepository({ filename: databasePath || path.join(root, 'var/hdu-map.sqlite') });
  const api = createApiHandler({ repository, logger });
  let adminApi;
  try { adminApi = createAdminHandler({ repository, logger, publicOrigin }); }
  catch(error) { if (!providedRepository) repository.close(); throw error; }
  const buckets = new Map();
  const sendError = (req, res, status, code, message) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: { code, message } }));
  };
  function allowApiRequest(req, res) {
    if (!rateLimit || rateLimit.max <= 0) return true;
    const now = Date.now(), key = req.socket.remoteAddress || 'unknown';
    let bucket = buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      if (buckets.size >= 10_000) {
        for (const [ip, item] of buckets) if (item.reset <= now) buckets.delete(ip);
        if (buckets.size >= 10_000) buckets.delete(buckets.keys().next().value);
      }
      bucket = { count: 0, reset: now + rateLimit.windowMs }; buckets.set(key, bucket);
    }
    bucket.count++;
    res.setHeader('RateLimit-Limit', rateLimit.max);
    res.setHeader('RateLimit-Remaining', Math.max(0, rateLimit.max - bucket.count));
    if (bucket.count <= rateLimit.max) return true;
    res.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.reset - now) / 1000)));
    sendError(req, res, 429, 'RATE_LIMITED', 'Too many requests. Try again shortly.'); return false;
  }
  let vite;
  const server = http.createServer({ maxHeaderSize: 16_384 }, async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
    if ((req.url || '').length > 2048) { sendError(req, res, 414, 'INVALID_QUERY', 'Request URL is too long.'); return; }
    let pathname;
    try { pathname = decodeURIComponent((req.url || '/').split('?')[0]); }
    catch { sendError(req, res, 400, 'INVALID_QUERY', 'Invalid URL.'); return; }
    if (pathname.includes('\0') || pathname.split(/[\\/]/).includes('..')) {
      sendError(req, res, 400, 'INVALID_QUERY', 'Invalid path.'); return;
    }
    if (pathname === '/api/health') {
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); sendError(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, service: 'hdu-map', frontend: 'react', storage: 'sqlite', apiVersion: 1 })); return;
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      if (!allowApiRequest(req, res)) return;
      const url = new URL(req.url, 'http://localhost');
      if (!await adminApi(req, res, url) && !await api(req, res, url)) sendError(req, res, 404, 'NOT_FOUND', 'API endpoint not found.');
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    if (development && vite) { vite.middlewares(req, res); return; }
    const requested = path.resolve(dist, '.' + pathname);
    if (requested !== dist && !requested.startsWith(dist + path.sep)) { res.writeHead(400); res.end(); return; }
    let file = requested, info;
    try { info = await stat(file); if (info.isDirectory()) { file = path.join(file, 'index.html'); info = await stat(file); } }
    catch {
      // Only extensionless navigation falls back to the app; missing assets remain 404.
      if (!path.extname(pathname)) {
        file = path.join(dist, 'index.html');
        try { info = await stat(file); } catch {}
      }
    }
    if (!info?.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
    const ext = path.extname(file);
    res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : /-[\w-]{8,}\.(js|css)$/.test(file) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    const compress = ['.html', '.js', '.css', '.json', '.svg', '.txt'].includes(ext) && info.size > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.setHeader('Vary', 'Accept-Encoding');
    if (compress) res.setHeader('Content-Encoding', 'gzip'); else res.setHeader('Content-Length', info.size);
    res.writeHead(200);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(file);
    // pipeline closes the source file and gzip stream when a client disconnects.
    pipeline(stream, ...(compress ? [createGzip()] : []), res, error => { if (error && !res.destroyed) res.destroy(); });
    } catch (error) {
      try { logger?.error?.({ requestId, event: 'request_failed', code: error?.code || 'INTERNAL_ERROR' }); } catch {}
      if (res.headersSent) res.destroy(); else sendError(req, res, 500, 'INTERNAL_ERROR', 'The request could not be completed.');
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 200;
  if (development) {
    try {
      const { createServer } = await import('vite');
      vite = await createServer({ root, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
    } catch(error) { adminApi.close(); if (!providedRepository) repository.close(); throw error; }
  }
  server.on('close', () => { void vite?.close(); buckets.clear(); adminApi.close(); if (!providedRepository) repository.close(); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createAppServer({ development: process.argv.includes('--dev') });
  const port = Number(process.env.PORT || 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`HDU Map: http://${process.env.HOST || '127.0.0.1'}:${port}/`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
