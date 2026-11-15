/* ============================================================
  众和航空 · 客票数据库配置（示例）
  ------------------------------------------------------------
  复制这份文件为 db-config.js 后再改名填写。
  公开仓库里绝对不要写 GitHub token —— 只写仓库坐标和代理地址。
============================================================ */
window.DJAIR_DB_CONFIG = {
  owner: 'YOUR_GITHUB_USER',      // 仓库所有者
  repo: 'YOUR_REPO',              // 仓库名
  branch: 'main',                 // 默认分支
  dir: 'tickets',                 // 客票存放目录（与工作流一致）

  /* 写库代理地址（Cloudflare Worker 等）。
     例如：'https://djair-db-ticket.xxxx.workers.dev/save'
     留空 = 只有站长录票模式能写库 */
  proxyUrl: ''
};
