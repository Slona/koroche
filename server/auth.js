import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function createAuth({ secret, vk, panelOrigin, secureCookies }) {
  const sign = (payload) => {
    const body = b64u(JSON.stringify(payload));
    return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
  };

  const verify = (token) => {
    if (!token) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const want = createHmac('sha256', secret).update(body).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString());
      return p.exp > Date.now() ? p : null;
    } catch {
      return null;
    }
  };

  const parseCookies = (header = '') =>
    Object.fromEntries(
      header.split(';').map((c) => {
        const i = c.indexOf('=');
        return i < 0 ? ['', ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
      }),
    );

  const cookie = (name, value, maxAgeSec) =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureCookies ? '; Secure' : ''}`;

  const SESSION_DAYS = 30;

  return {
    sessionFrom: (req) => verify(parseCookies(req.headers.cookie).ls),

    startSession: (vkId) => cookie('ls', sign({ sub: String(vkId), exp: Date.now() + SESSION_DAYS * 864e5 }), SESSION_DAYS * 86400),
    endSession: () => cookie('ls', '', 0),

    // VK ID, Authorization Code + PKCE.
    beginVk() {
      const state = b64u(randomBytes(16));
      const verifier = b64u(randomBytes(48));
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const url = new URL('https://id.vk.com/authorize');
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: vk.clientId,
        redirect_uri: `${panelOrigin}/auth/callback`,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: '',
      }).toString();
      return { url: url.toString(), flowCookie: cookie('vkflow', sign({ state, verifier, exp: Date.now() + 600000 }), 600) };
    },

    async finishVk(req, { code, state, device_id }) {
      const flow = verify(parseCookies(req.headers.cookie).vkflow);
      if (!flow || flow.state !== state || !code || !device_id) throw new Error('Неверный ответ VK или сессия входа истекла');
      const res = await fetch('https://id.vk.com/oauth2/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code_verifier: flow.verifier,
          redirect_uri: `${panelOrigin}/auth/callback`,
          code,
          client_id: vk.clientId,
          device_id,
          state,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.user_id) throw new Error(`VK отклонил вход: ${data.error_description ?? data.error ?? res.status}`);
      let name = null;
      try {
        // Имя для отображения в панели; ошибка здесь не мешает входу.
        const info = await fetch('https://id.vk.com/oauth2/user_info', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: vk.clientId, access_token: data.access_token }),
          signal: AbortSignal.timeout(5000),
        }).then((r) => r.json());
        name = [info.user?.first_name, info.user?.last_name].filter(Boolean).join(' ').slice(0, 100) || null;
      } catch { /* имя необязательно */ }
      return { vkId: String(data.user_id), name };
    },

    clearFlow: () => cookie('vkflow', '', 0),
  };
}
