/* ============================================================
  众和航空 · 客票数据库（GitHub 存储层）
  ------------------------------------------------------------
  这是一个普通脚本（非模块），直接放在仓库根目录，由
  checkout.html / payment.html / my-orders.html 用 <script src> 引入。

  公开仓库不能放写权限 token，所以：
    有后端代理（推荐）→ 配置 db-config.js 里的 proxyUrl
    没有后端           → 由站长本人在「录票模式」下单写库
  详见 README-db.md。
============================================================ */
(function (global) {
  'use strict';

  /* ============ 1. 配置 ============ */
  var CFG = {
    owner: 'dhj221',
    repo: 'djair',
    branch: 'main',
    dir: 'tickets',
    /* 写库代理（Cloudflare Worker 等）。留空表示没有后端。 */
    proxyUrl: '',
    /* 录票模式：浏览器的 localStorage 中该键为 '1' 时，允许用本机 token 直接写库。
       打开方式：任意页面控制台执行
         localStorage.setItem('djair_db_station','1')    开启
         localStorage.removeItem('djair_db_station')    关闭
       注意：token 只存在你本机浏览器，不会写进页面代码。 */
    stationKey: 'djair_db_station',
    tokenKey: 'djair_db_token'
  };
  try {
    if (global.DJAIR_DB_CONFIG) {
      for (var k in CFG) {
        if (Object.prototype.hasOwnProperty.call(global.DJAIR_DB_CONFIG, k) &&
            global.DJAIR_DB_CONFIG[k] != null && global.DJAIR_DB_CONFIG[k] !== '') {
          CFG[k] = global.DJAIR_DB_CONFIG[k];
        }
      }
    }
  } catch (e) { /* 配置缺失时用默认值 */ }

  /* ============ 2. 基础工具 ============ */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function utf8ToB64(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToUtf8(b64) {
    var bin = atob(String(b64).replace(/\s/g, '')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function seg(p, enc) {
    return String(p).split('/').filter(Boolean).map(enc ? encodeURIComponent : function (x) { return x; }).join('/');
  }

  /* SHA-256（crypto.subtle，要求 https 或 localhost） */
  function sha256(text) {
    if (!global.crypto || !global.crypto.subtle || !global.TextEncoder) {
      return Promise.reject(new Error('当前环境不支持 SHA-256（需 https 或 localhost）'));
    }
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)))
      .then(function (buf) {
        var b = new Uint8Array(buf), out = '';
        for (var i = 0; i < b.length; i++) out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
        return out;
      });
  }

  /* ============ 3. 路径规则 ============
     订单文件：<dir>/orders/<YYYY>/<MM>/<orderNo>.json
     站点索引：<dir>/index.json（由 GitHub Actions 构建）
     可读档：  <dir>/public/<YYYY>/<orderNo>.json（脱敏，不含证件信息）
     人读档：  <dir>/<orderNo>.txt（保留原有行为）
  ==================================== */
  function isOrderNo(s) { return /^PE\d{17}$/.test(String(s || '').trim()) }
  function orderPath(orderNo) {
    var n = String(orderNo || '').trim();
    if (!isOrderNo(n)) throw new Error('订单号格式不正确：' + n);
    return CFG.dir + '/orders/' + n.slice(2, 6) + '/' + n.slice(6, 8) + '/' + n + '.json';
  }
  function publicPath(orderNo) {
    var n = String(orderNo || '').trim();
    if (!isOrderNo(n)) throw new Error('订单号格式不正确：' + n);
    return CFG.dir + '/public/' + n.slice(2, 6) + '/' + n + '.json';
  }
  function txtPath(orderNo) { return CFG.dir + '/' + String(orderNo || '').trim() + '.txt' }
  function indexPath() { return CFG.dir + '/index.json' }

  function ghUrl(p) { return 'https://api.github.com/repos/' + CFG.owner + '/' + CFG.repo + '/contents/' + seg(p, true) }
  function rawUrl(p) { return 'https://raw.githubusercontent.com/' + CFG.owner + '/' + CFG.repo + '/' + CFG.branch + '/' + seg(p, false) }
  function blobUrl(p) { return 'https://github.com/' + CFG.owner + '/' + CFG.repo + '/blob/' + CFG.branch + '/' + seg(p, false) }
  function bust(u) { return u + (u.indexOf('?') > -1 ? '&' : '?') + 't=' + Date.now() }

  /* ============ 4. 兼容以前的 GH 写法 ============
     如果页面上仍有旧版 var GH={owner,repo,branch,dir,token}，自动并入配置 */
  try {
    if (global.GH && global.GH.owner) {
      ['owner', 'repo', 'branch', 'dir'].forEach(function (k) {
        if (global.GH[k]) CFG[k] = global.GH[k];
      });
      if (global.GH.token) CFG.__legacyToken = global.GH.token;
    }
  } catch (e) { }

  /* ============ 5. 写权限来源 ============ */
  function getStationToken() {
    var legacy = CFG.__legacyToken || '';
    try {
      var own = localStorage.getItem(CFG.tokenKey) || '';
      if (own) return own;
    } catch (e) { }
    return legacy;
  }
  function hasProxy() { return !!CFG.proxyUrl }
  function isStation() {
    try { return localStorage.getItem(CFG.stationKey) === '1' } catch (e) { return false }
  }
  function canWrite() { return hasProxy() || (isStation() && !!getStationToken()) }
  function mode() {
    if (hasProxy()) return 'server';
    if (canWrite()) return 'station';
    return 'readonly';
  }
  function modeLabel() {
    return { server: '服务端代理写库', station: '站长录票模式', readonly: '只读（需人工存档）' }[mode()];
  }

  /* ============ 6. 请求 ============ */
  function req(url, opt) {
    return fetch(url, opt).then(function (r) {
      return r.text().then(function (txt) {
        var j = null;
        try { j = txt ? JSON.parse(txt) : null } catch (e) { j = { raw: txt } }
        if (!r.ok) {
          var e = new Error((j && j.message) || ('HTTP ' + r.status));
          e.status = r.status;
          e.body = j;
          throw e;
        }
        return { status: r.status, json: j };
      });
    });
  }
  function headers(extra) {
    var h = { 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' };
    var t = getStationToken();
    if (t) h['Authorization'] = 'Bearer ' + t;
    for (var k in (extra || {})) h[k] = extra[k];
    return h;
  }

  /* 读取一个文件并解析 JSON；不存在返回 null */
  function readJson(p) {
    return req(bust(rawUrl(p)), { method: 'GET', cache: 'no-store' }).then(function (r) {
      if (!r.json) return null;
      return { data: r.json, path: p, raw: rawUrl(p), blob: blobUrl(p) };
    }).catch(function (e) {
      if (e.status === 404) return null;
      /* raw 域名偶发 5xx / 缓存未生效：再试一次 */
      return req(bust(ghUrl(p)), { method: 'GET', cache: 'no-store' })
        .then(function (r) {
          var content = r.json && r.json.content ? b64ToUtf8(r.json.content) : '';
          if (!content) return null;
          var data = JSON.parse(content);
          return { data: data, path: p, raw: rawUrl(p), blob: blobUrl(p), sha: r.json.sha };
        })
        .catch(function (e2) {
          if (e2.status === 404) return null;
          if (e.status === 429 || e.status >= 500) throw new Error('网络繁忙，请稍后重试（' + (e.status || '网络错误') + '）');
          throw e;
        });
    });
  }

  /* 写入（新建或覆盖） */
  function putFile(p, text, message) {
    var body = { message: message || ('db: ' + p), content: utf8ToB64(text), branch: CFG.branch };
    if (mode() === 'server') {
      return req(CFG.proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'put', path: p, content: text, message: body.message })
      });
    }
    if (mode() !== 'station') {
      return Promise.reject(new Error('当前没有写库权限：请配置 proxyUrl，或开启站长录票模式（见 README-db.md）'));
    }
    return req(ghUrl(p), { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
  }

  /* ============ 7. 脱敏 & 摘要 ============ */
  function maskIdNo(t, no) {
    var s = String(no || '');
    if (!s) return '';
    if (t === '护照' || t === '其它证件') {
      return s.length <= 4 ? s : s.slice(0, 2) + '*'.repeat(Math.max(2, s.length - 4)) + s.slice(-2);
    }
    return s.length <= 6 ? s : s.slice(0, 3) + '*'.repeat(Math.max(3, s.length - 6)) + s.slice(-3);
  }
  function maskNameEn(en) {
    return String(en || '').split(/\s+/).filter(Boolean).map(function (w) {
      return w.length <= 2 ? w[0] + '*' : w[0] + '*'.repeat(w.length - 2) + w[w.length - 1];
    }).join(' ');
  }
  function displayName(nameCn, nameEn) {
    var cn = String(nameCn || '').trim(), en = String(nameEn || '').trim();
    return cn || en || '—';
  }
  function shortName(nameCn, nameEn) {
    var cn = String(nameCn || '').trim();
    if (cn) return cn.length > 1 ? cn[0] + '**' : cn;
    return maskNameEn(nameEn);
  }
  /* 轻量摘要，用于 index.json，不含任何证件信息 */
  function digest(order) {
    var ps = order.passengers || [], segs = order.segments || [];
    var fl = [];
    segs.forEach(function (s) { (s.flights || []).forEach(function (f) { fl.push(f) }) });
    var first = fl[0] || {}, last = fl[fl.length - 1] || {}, s0 = segs[0] || {};
    return {
      orderNo: order.orderNo,
      issuedAt: order.issuedAt,
      status: order.status || 'PAID',
      name: displayName(ps[0] && ps[0].nameCn, ps[0] && ps[0].nameEn),
      pax: ps.length,
      from: first.fromCity || s0.fromCity || '',
      to: last.toCity || s0.toCity || '',
      depDate: first.depDate || s0.date || '',
      airlines: fl.map(function (f) { return f.no }).filter(Boolean).join(' + '),
      total: order.total,
      roundTrip: !!(order.roundTripRate < 1)
    };
  }

  /* ============ 8. 安全检查：服务端文件是否已脱敏 ============ */
  var HIDDEN_FIELDS = ['idNo', 'birth', 'nationality', 'issuer', 'customerKey'];
  function leaks(o, path) {
    if (o && typeof o === 'object') {
      for (var k in o) {
        if (HIDDEN_FIELDS.indexOf(k) > -1) return path + '.' + k;
        var hit = leaks(o[k], path + '.' + k);
        if (hit) return hit;
      }
    }
    return '';
  }

  /* ============ 9. 高层操作 ============ */

  /* 保存订单：<dir>/orders/.../<orderNo>.json + <dir>/<orderNo>.txt */
  function saveOrder(order, txt) {
    if (!order || !order.orderNo) return Promise.reject(new Error('缺少订单号'));
    var op = orderPath(order.orderNo), tp = txtPath(order.orderNo);
    return putFile(op, JSON.stringify(order, null, 2), 'ticket: ' + order.orderNo + ' (json)').then(function () {
      if (!txt) return [];
      return putFile(tp, txt, 'ticket: ' + order.orderNo + ' (txt)').then(function () { return [op, tp] });
    }).then(function (paths) {
      return { paths: [op, tp], storage: {
        provider: 'github', ok: true, mode: mode(),
        orderPath: op, txtPath: tp, publicPath: publicPath(order.orderNo),
        repoUrl: blobUrl(op), rawUrl: rawUrl(op), txtUrl: blobUrl(tp)
      } };
    });
  }

  /* 出票后自检：把刚写进去的文件读回来，确认「存档」不是「存到本机而已」 */
  function verifyReadable(orderNo) {
    if (!isOrderNo(orderNo)) return Promise.resolve({ ok: false, reason: 'bad-order' });
    var p = orderPath(orderNo), tries = 0;
    function attempt() {
      return readJson(p).then(function (r) {
        if (r && r.data && r.data.orderNo === orderNo) return { ok: true, path: p, raw: r.raw };
        if (++tries >= 4) return { ok: false, reason: 'not-found', path: p };
        return new Promise(function (res) { setTimeout(res, 1500 * tries) }).then(attempt);
      }).catch(function (e) {
        if (++tries >= 4) return { ok: false, reason: e.message || 'error', path: p };
        return new Promise(function (res) { setTimeout(res, 1500 * tries) }).then(attempt);
      });
    }
    return attempt();
  }

  /* 给客服/录票台用的归档文本（不含证件号、出生日期等敏感信息） */
  function archiveText(order) {
    var L = [], line = '================================================', thin = '------------------------------------------------';
    var ps = order.passengers || [], segs = order.segments || [];
    L.push(line); L.push('  众和航空 Peace Airlines — 客票归档摘要'); L.push(line); L.push('');
    L.push('订单号    : ' + order.orderNo);
    L.push('出票时间  : ' + String(order.issuedAt || '').replace('T', ' ').replace(/\..+/, ''));
    L.push('订单状态  : ' + (order.status || 'PAID'));
    L.push('');
    L.push(thin); L.push('  旅客'); L.push(thin);
    ps.forEach(function (p, i) {
      L.push('  [' + (i + 1) + '] ' + displayName(p.nameCn, p.nameEn) + (p.nameCn && p.nameEn ? ' / ' + p.nameEn : ''));
      L.push('      类型    : ' + (p.typeName || '成人'));
      L.push('      证件    : ' + (p.idType || '') + ' ' + maskIdNo(p.idType, p.idNo) + '（完整信息请查本机原客票）');
      L.push('');
    });
    L.push(thin); L.push('  行程'); L.push(thin);
    segs.forEach(function (s) {
      L.push('  ── ' + (s.dir || '航段') + ' ─ ' + (s.fromCity || '') + ' → ' + (s.toCity || ''));
      L.push('     子仓位: ' + (s.subName || '') + '（' + (s.subCode || '') + '）');
      (s.flights || []).forEach(function (f) {
        var t = function (x) { return x ? String(x).slice(0, 2) + ':' + String(x).slice(2) : '' };
        L.push('     ' + f.no + '  ' + (f.airlineName || '') + '  ' + (f.ac || ''));
        L.push('       ' + (f.depDate || '') + ' ' + t(f.dep) + '  ' + (f.fromCity || '') + (f.fromAirport || '') + ' (' + (f.fromCode || '') + ')');
        L.push('       ' + (f.arrDate || '') + ' ' + t(f.arr) + '  ' + (f.toCity || '') + (f.toAirport || '') + ' (' + (f.toCode || '') + ')' + (f.arrNextDay ? '  [次日到达]' : ''));
      });
      L.push('');
    });
    L.push(thin); L.push('  价格'); L.push(thin);
    L.push('  各航段折后小计     : MZB ' + order.subtotal);
    if (order.roundTripRate < 1 && order.roundTripSave > 0) {
      L.push('  往返折扣           : -MZB ' + order.roundTripSave);
    }
    L.push('  应付总额           : MZB ' + order.total);
    L.push('');
    L.push(line);
    L.push('  本归档不含证件号码、出生日期、国籍、签发国等敏感字段。');
    L.push(line);
    return L.join('\r\n');
  }

  /* 站点索引：优先读 index.json → 没有就现场扫描订单目录（API） */
  function listOrders() {
    return readJson(indexPath()).then(function (r) {
      if (r && r.data && r.data.orders && r.data.orders.length) {
        return { source: 'index', updatedAt: r.data.updatedAt || '', orders: r.data.orders };
      }
      return scanDates();
    }).catch(function () { return scanDates() });
  }

  function scanDates() {
    return req(bust('https://api.github.com/repos/' + CFG.owner + '/' + CFG.repo + '/commits?path=' +
      encodeURIComponent(CFG.dir + '/orders') + '&sha=' + encodeURIComponent(CFG.branch) + '&per_page=100'),
      { method: 'GET', cache: 'no-store' }).then(function (r) {
        var dates = [];
        (r.json || []).forEach(function (c) {
          var d = (c.commit && c.commit.committer && c.commit.committer.date) || '';
          if (/^\d{4}-\d{2}/.test(d)) {
            var k = d.slice(0, 7);           /* YYYY-MM */
            if (dates.indexOf(k) < 0) dates.push(k);
          }
        });
        return scanMonths(dates.sort());
      });
  }

  function scanMonths(months) {
    var out = [];
    return months.reduce(function (chain, ym) {
      return chain.then(function () {
        var y = ym.slice(0, 4), m = ym.slice(5, 7);
        return req(bust('https://api.github.com/repos/' + CFG.owner + '/' + CFG.repo +
          '/contents/' + encodeURIComponent(CFG.dir + '/orders/' + y + '/' + m) +
          '?ref=' + encodeURIComponent(CFG.branch)),
          { method: 'GET', cache: 'no-store' }).then(function (r) {
            var files = (r.json || []).filter(function (f) { return /\.json$/i.test(f.name) });
            var ps = files.map(function (f) {
              return readJson((CFG.dir + '/orders/' + y + '/' + m + '/' + f.name)).then(function (x) {
                return x && x.data ? digest(x.data) : null;
              }).catch(function () { return null });
            });
            return Promise.all(ps).then(function (arr) {
              arr.forEach(function (d) { if (d) out.push(d) });
            });
          }).catch(function () { });
      });
    }, Promise.resolve()).then(function () {
      out.sort(function (a, b) { return String(b.issuedAt).localeCompare(String(a.issuedAt)) });
      return { source: 'scan', updatedAt: new Date().toISOString(), orders: out };
    });
  }

  /* 读取订单：未登录读脱敏档，已登录（本机存有口径一致的口令哈希）读订单档 */
  function fetchOrder(orderNo) {
    orderNo = String(orderNo || '').trim();
    if (!isOrderNo(orderNo)) return Promise.reject(new Error('订单号格式不正确'));
    var station = canWrite();
    var fullP = orderPath(orderNo);
    var chain = station ? readJson(fullP) : Promise.resolve(null);
    return chain.then(function (full) {
      if (full && full.data) return { data: full.data, level: 'full', path: fullP, raw: full.raw, blob: full.blob };
      return readJson(publicPath(orderNo)).then(function (r) {
        if (r && r.data) return { data: r.data, level: 'public', path: publicPath(orderNo), raw: r.raw, blob: r.blob };
        return null;
      });
    });
  }

  /* ============ 10. 导出 ============ */
  var DB = {
    CFG: CFG,
    esc: esc,
    utf8ToB64: utf8ToB64,
    b64ToUtf8: b64ToUtf8,
    sha256: sha256,
    isOrderNo: isOrderNo,
    paths: { order: orderPath, public: publicPath, txt: txtPath, index: indexPath },
    urls: { gh: ghUrl, raw: rawUrl, blob: blobUrl },
    maskIdNo: maskIdNo,
    maskNameEn: maskNameEn,
    displayName: displayName,
    shortName: shortName,
    digest: digest,
    leaks: leaks,
    readJson: readJson,
    putFile: putFile,
    saveOrder: saveOrder,
    verifyReadable: verifyReadable,
    archiveText: archiveText,
    listOrders: listOrders,
    fetchOrder: fetchOrder,
    hasProxy: hasProxy,
    isStation: isStation,
    canWrite: canWrite,
    mode: mode,
    modeLabel: modeLabel
  };

  global.DJAIR_DB = DB;
})(window);
