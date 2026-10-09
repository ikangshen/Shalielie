// Place this directory at the root of the original Shalielie repository.
import { discoverHeic } from '../../web/src/heif.js';
import { patch, profileFor } from '../../web/src/port.js';
import { addTexture, hasTexture } from '../../web/src/texture.js';
import { loadProfile } from '../../web/src/zip.js';

const MAX_BYTES = 20 * 1024 * 1024;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (message, status) => new Response(message, { status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });

async function authorized(request, secret) {
  const candidate = request.headers.get('Authorization') || '';
  if (!secret || !candidate.startsWith('Bearer ')) return false;
  // Digest both strings and compare every byte, rather than early-exiting on a mismatch.
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(candidate)),
    crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${secret}`)),
  ]);
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

async function readLimited(stream, maxBytes) {
  if (!stream) throw new Error('empty');
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('too-large');
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

function isHeic(b) {
  if (b.length < 12 || String.fromCharCode(...b.subarray(4, 8)) !== 'ftyp') return false;
  const brand = String.fromCharCode(...b.subarray(8, 12));
  return /^(hei|mif|msf)/.test(brand);
}

async function getAsset(env, path) {
  // ASSETS is an internal static-assets binding. Requests never expose it directly.
  const response = await env.ASSETS.fetch(new Request(`https://assets.invalid/${path}`));
  if (!response.ok) throw new Error(`Missing bundled asset: ${path}`);
  return response;
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/health' && request.method === 'GET') return reply('ok', 200);
    if (pathname !== '/patch') return reply('Not found', 404);
    if (request.method !== 'POST') return reply('Method not allowed', 405);
    if (!(await authorized(request, env.API_TOKEN))) return reply('Unauthorized', 401);
    const lengthHeader = request.headers.get('Content-Length');
    if (lengthHeader !== null) {
      if (!/^\d+$/.test(lengthHeader)) return reply('Invalid length', 400);
      if (Number(lengthHeader) > MAX_BYTES) return reply('File too large (20 MB max)', 413);
    }
    const fullType = request.headers.get('Content-Type') || '';
    const contentType = fullType.split(';')[0].trim().toLowerCase();
    const multipart = contentType === 'multipart/form-data';
    if (!multipart && !['image/heic', 'image/heif', 'application/octet-stream'].includes(contentType)) {
      return reply('Use raw HEIC or multipart/form-data with a File field named photo', 415);
    }
    let upload;
    try { upload = await readLimited(request.body, MAX_BYTES); }
    catch (err) { return reply(err.message === 'too-large' ? 'File too large' : 'Invalid upload', err.message === 'too-large' ? 413 : 400); }
    let bytes = upload;
    if (multipart) {
      try {
        // Parse multipart after bounding its TOTAL size. Preserve the boundary from iOS.
        const parsed = new Request('https://upload.invalid/', {
          method: 'POST', headers: { 'Content-Type': fullType }, body: upload,
        });
        const form = await parsed.formData();
        const photo = form.get('photo');
        if (!(photo instanceof File)) return reply('Missing File field: photo', 400);
        if (photo.size > MAX_BYTES) return reply('File too large', 413);
        bytes = new Uint8Array(await photo.arrayBuffer());
      } catch (err) {
        return reply('Invalid multipart upload', 400);
      }
    }
    if (!isHeic(bytes)) return reply('Not a HEIC file', 415);
    try {
      const d = discoverHeic(bytes);
      let output;
      let suffix;
      if (d.stylesItem !== null) {
        if (hasTexture(d.infos)) return reply('Photo already has Texture/Grain', 422);
        output = addTexture(bytes).data;
        suffix = 'TextureGrain';
      } else {
        if (d.thumbnail === null) return reply('Embedded thumbnail required by the no-encoder mode', 422);
        const index = await (await getAsset(env, 'index.json')).json();
        const profileName = profileFor(index, d);
        const fileName = index[profileName]?.file;
        if (!fileName || !/^[\w-]+\.zip$/.test(fileName)) throw new Error('Invalid profile index');
        const zipBytes = new Uint8Array(await (await getAsset(env, fileName)).arrayBuffer());
        const profile = await loadProfile(zipBytes);
        output = (await patch(bytes, profile, { sceneStats: 'donor', lightMaps: 'flat' })).data;
        suffix = 'PhotographicStyle';
      }
      return new Response(output, { status: 200, headers: {
        ...headers, 'Content-Type': 'image/heic',
        'Content-Disposition': `attachment; filename="Shalielie_${suffix}.HEIC"`,
      }});
    } catch (err) {
      // Do not disclose binary parser details to unauthenticated callers or log photo contents.
      console.error('Shalielie conversion error:', err?.message || 'unknown');
      return reply('Unsupported HEIC or processing error', 422);
    }
  },
};
