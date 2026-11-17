/* ============================================================
  众和航空 · 客票数据库配置
  ------------------------------------------------------------
  这个文件会被 checkout.html / payment.html / my-orders.html
  通过 <script src="db-config.js"> 加载，然后并入 ticket-db.js 的 CFG。

  公开仓库 = 所有人都能看到这个文件，所以：
    ✗ 绝对不要在这里写 GitHub token
    ✓ 只写仓库坐标、目录名和写库代理地址

  「写库代理」是指你自己的一个服务端接口（Cloudflare Worker /
    Vercel Function / 你自己的服务器），它持有 token 并代浏览器写库。
  部署方法见 README-db.md 第 3 节。
============================================================ */
window.DJAIR_DB_CONFIG = {
  owner: 'dhj221',
  repo: 'djair',
  branch: 'main',
  dir: 'tickets',

  /* 写库代理地址；没有就留空（此时浏览器无法写库，只读 + 站长录票模式可用） */
  proxyUrl: 'https://djair.jackyzhu905.workers.dev/api/ticket'
};
