import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// Загрузка <title> страницы. Ссылки создают любые пользователи, поэтому запросы
// во внутреннюю сеть и на служебные адреса запрещены (в т.ч. через редиректы и DNS).

function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19));
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateV4(mapped[1]);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => !isPrivateIp(a.address));
    if (!ok.length) return cb(new Error('blocked address'));
    return opts?.all ? cb(null, ok) : cb(null, ok[0].address, ok[0].family);
  });
}

function request(url, depth) {
  return new Promise((resolve) => {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return resolve(null);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateIp(host)) return resolve(null);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, {
      lookup: safeLookup,
      timeout: 5000,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; KorocheBot/1.0)', accept: 'text/html' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 3) {
        res.resume();
        try { return resolve(request(new URL(res.headers.location, u).href, depth + 1)); } catch { return resolve(null); }
      }
      const type = res.headers['content-type'] ?? '';
      if (res.statusCode !== 200 || !type.includes('html')) { res.resume(); return resolve(null); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        chunks.push(c);
        size += c.length;
        if (size >= 131072) res.destroy();
      });
      const done = () => resolve(parse(Buffer.concat(chunks), type));
      res.on('end', done);
      res.on('close', done);
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function parse(buf, type) {
  const charset = /charset=([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.toString('latin1'))?.[1] ?? 'utf-8';
  let html;
  try { html = new TextDecoder(charset).decode(buf); } catch { html = buf.toString('utf8'); }
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  return m[1].replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim().slice(0, 300) || null;
}

export const fetchTitle = (url) => request(url, 0);
