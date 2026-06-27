// 登录管理器：弹浏览器扫码/账密登录 → 抓 token(JWT) + cookies + userInfo → 关浏览器 → 存本地 JSON
// 浏览器只在登录时短暂开启，登录完立即关闭。
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const STATE_DIR = path.join(__dirname, '..', 'browser-state');
const CREDS_FILE = path.join(__dirname, '..', 'creds.json');
const SITE = 'https://3d-viewer.jlc.com/';

class LoginManager {
  // 读本地凭证
  loadCreds() {
    try { return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')); }
    catch { return null; }
  }

  saveCreds(creds) {
    fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
    console.log('[login] 凭证已保存:', CREDS_FILE);
  }

  clearCreds() {
    try { fs.unlinkSync(CREDS_FILE); } catch {}
  }

  // 弹浏览器登录，抓凭证后关浏览器。返回 creds 或 null
  // onProgress(status) 回调通知进度
  async login(onProgress) {
    const pn = (m) => { console.log('[login]', m); onProgress && onProgress(m); };
    fs.mkdirSync(STATE_DIR, { recursive: true });

    pn('启动浏览器…');
    const ctx = await chromium.launchPersistentContext(STATE_DIR, {
      headless: false, viewport: { width: 1100, height: 800 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const page = ctx.pages()[0] || (await ctx.newPage());

    let creds = null;
    // 监听 windowLogin 响应（登录成功会返回 JWT）和 getUserInfo
    ctx.on('response', async (res) => {
      const u = res.url();
      if (!u.includes('forface3d')) return;
      try {
        if (u.includes('/user/login/windowLogin') && res.status() === 200) {
          const j = await res.json();
          if (j.success && j.data && typeof j.data === 'string' && j.data.startsWith('eyJ')) {
            pn('已捕获登录 token');
            creds = creds || {};
            creds.token = j.data;
            creds.loginAt = new Date().toISOString();
          }
        }
        if (u.includes('/user/user/getUserInfo') && res.status() === 200) {
          const j = await res.json();
          if (j.success && j.data) {
            pn('已捕获用户信息: ' + j.data.account);
            creds = creds || {};
            creds.userInfo = j.data;
            creds.loginAt = creds.loginAt || new Date().toISOString();
          }
        }
      } catch {}
    });

    pn('打开登录页…');
    await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    // 如果已有登录态（cookie 复用），页面加载就会自动触发 windowLogin + getUserInfo
    // 否则等用户手动登录
    pn('请在弹出的浏览器窗口中登录（扫码或账号密码）…');

    // 轮询等待 token + userInfo 都到齐（最多 5 分钟）
    const start = Date.now();
    while (Date.now() - start < 5 * 60 * 1000) {
      if (creds && creds.token && creds.userInfo) break;
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (creds && creds.token) {
      // 实测：纯 token(JWT) 即可完成所有上传，cookie 非必须。
      // 仅保留 CAS 续期相关 cookie（token 过期后可能用于免扫码续期），其余全丢弃。
      const allCookies = await ctx.cookies();
      const RENEW_KEYS = ['tgc', 'PROD-JLC-CAS-SID', 'customer_auto_login_info'];
      creds.cookies = allCookies
        .filter((c) => RENEW_KEYS.includes(c.name))
        .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
      pn('已保存凭证（token + ' + creds.cookies.length + ' 个续期cookie）');
      this.saveCreds(creds);
    }

    // 关闭浏览器（登录完不再需要）
    pn('关闭浏览器…');
    await ctx.close().catch(() => {});

    if (creds && creds.token) {
      pn('登录成功，浏览器已关闭');
      return creds;
    }
    pn('登录未完成（超时或未登录）');
    return null;
  }
}

module.exports = { LoginManager, CREDS_FILE };
