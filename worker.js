/**
 * 众和航空 · 客票写库代理（Cloudflare Worker）
 * ------------------------------------------------------------------
 * 作用：浏览器 → 本 Worker → GitHub Contents API → 你的仓库
 *      仓库是 public 也没关系，因为写权限 token 只存在于 Worker 的环境变量里。
 *
 * 部署（约 5 分钟）：
 *   1. npm i -g wrangler
 *   2. wrangler init 一个 Worker，把本文件内容贴进 src/index.js
 *   3. wrangler secret put GITHUB_TOKEN     ← 只放「该仓库 + Contents: Read and write」的 fine-grained PAT
 *   4. wrangler secret put DJAIR_SECRET     ← 随便一长串随机字符；公开站点可不配
 *   5. wrangler secret put API_KEY          ← （可选）wrangler.toml 里加 [vars] API_KEY="..." 也行
 *   6. wrangler deploy                     ← 得到 https://xxx.workers.dev
 *   7. 把地址填进 db-config.js 的 proxyUrl
 *
 * 可选变量：
 *   OWNER / REPO / BRANCH / DIR    默认 dhj221 / djair / main / tickets
 *   ALLOW_ORIGIN                   允许的来源，默认 *；建议改成你的站点域名
 *   API_KEY                        前端必须带上的 X-Api-Key
 * ================================================================ */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
    'Access-Control-Max-Age': '86400'
  };
}

function reply(env, status, body) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { ...cors(env), ...JSON_HEADERS }
  });
}

function b64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const SENSITIVE = ['idNo', 'birth', 'nationality', 'issuer', 'customerKey', 'customerCode'];
const ALLOWED_PATH = /^[A-Za-z0-9._\-/]+\.(json|txt)$/;

/** 递归删除敏感字段；idNo 只保留掩码 */
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (SENSITIVE.includes(k)) {
        if (k === 'idNo' && val && !v.idNoMask) out.idNoMask = maskId(v.idType, val);
        continue;
      }
      out[k] = scrub(val);
    }
    return out;
  }
  return v;
}

function maskId(type, no) {
  const s = String(no || '');
  if (!s) return '';
  if (type === '护照' || type === '其它证件') {
    return s.length <= 4 ? s : s.slice(0, 2) + '*'.repeat(Math.max(2, s.length - 4)) + s.slice(-2);
  }
  return s.length <= 6 ? s : s.slice(0, 3) + '*'.repeat(Math.max(3, s.length - 6)) + s.slice(-3);
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    if (req.method === 'GET') {
      return reply(env, 200, {
        ok: true,
        service: 'djair-ticket-db',
        repo: `${env.OWNER || 'dhj221'}/${env.REPO || 'djair'}`,
        configured: !!env.GITHUB_TOKEN
      });
    }
    if (req.method !== 'POST') return reply(env, 405, 'Method Not Allowed');

    if (env.API_KEY && req.headers.get('X-Api-Key') !== env.API_KEY) {
      return reply(env, 401, { ok: false, error: 'unauthorized' });
    }
    if (!env.GITHUB_TOKEN) return reply(env, 500, { ok: false, error: 'worker 未配置 GITHUB_TOKEN' });

    let body;
    try {
      body = await req.json();
    } catch {
      return reply(env, 400, { ok: false, error: 'body 不是合法 JSON' });
    }

    const path = String(body.path || '').trim();
    if (!ALLOWED_PATH.test(path) || path.startsWith('/') || path.includes('..')) {
      return reply(env, 400, { ok: false, error: 'path 不合法：' + path });
    }
    if (!/^(tickets|orders)\//.test(path) && !path.startsWith((env.DIR || 'tickets') + '/')) {
      return reply(env, 400, { ok: false, error: '只允许写入客票目录' });
    }
    if (typeof body.content !== 'string' || body.content.length > 800_000) {
      return reply(env, 413, { ok: false, error: 'content 为空或过大' });
    }
    if (path.endsWith('.json')) {
      let obj;
      try {
        obj = JSON.parse(body.content);
      } catch {
        return reply(env, 400, { ok: false, error: 'JSON 内容无法解析' });
      }
      if (obj && obj.orderNo && !/^PE\d{17}$/.test(String(obj.orderNo))) {
        return reply(env, 400, { ok: false, error: 'orderNo 不合法' });
      }
      /* 服务端兜底：无论如何都不让明文证件号进仓库 */
      body.content = JSON.stringify(scrub(obj), null, 2);
    }

    const owner = env.OWNER || 'dhj221';
    const repo = env.REPO || 'djair';
    const branch = env.BRANCH || 'main';
    const url =
      `https://api.github.com/repos/${owner}/${repo}/contents/` +
      path.split('/').map(encodeURIComponent).join('/');

    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'djair-ticket-db'
      },
      body: JSON.stringify({
        message: body.message || `db: ${path}`,
        content: b64Utf8(body.content),
        branch
      })
    });

    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text };
    }

    if (!res.ok) {
      /* 内容完全一致时 GitHub 会返回 422；这里视为成功，避免重复提交报错 */
      const msg = String(json.message || '');
      if (res.status === 422 && /identical|same|already exists/i.test(msg) === false && body.allowSame) {
        return reply(env, 200, { ok: true, same: true, path });
      }
      return reply(env, res.status, { ok: false, status: res.status, error: msg || 'GitHub 写入失败', path });
    }

    return reply(env, 200, {
      ok: true,
      path,
      commit: json.commit && json.commit.sha,
      url: json.content && json.content.html_url
    });
  }
};
