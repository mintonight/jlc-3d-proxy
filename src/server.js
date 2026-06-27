// JLC 3D Viewer 纯 HTTP 代理服务
// 登录时短暂弹浏览器抓凭证后关闭；上传全程纯HTTP，无需浏览器常驻
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { LoginManager } = require('./login-manager');
const { JlcClient } = require('./jlc-client');

const PORT = process.env.PORT || 3721;
const upload = multer({ dest: path.join(os.tmpdir(), 'jlc-3d-proxy-uploads') });

const loginMgr = new LoginManager();
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

function getClient() {
  const creds = loginMgr.loadCreds();
  if (!creds || !creds.token) return null;
  return new JlcClient(creds);
}

// ====== /status 查询登录状态（检查 token 是否有效） ======
app.get('/status', async (req, res) => {
  try {
    const client = getClient();
    if (!client) return res.json({ ok: true, loggedIn: false, service: 'JLC 3D Viewer Proxy' });
    // 真实验证 token
    const valid = await client.checkToken();
    res.json({
      ok: true,
      loggedIn: valid,
      userInfo: valid ? (loginMgr.loadCreds().userInfo || null) : null,
      tokenPreview: valid ? client.token.slice(0, 20) + '…' : null,
      service: 'JLC 3D Viewer Proxy',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ====== /login 弹浏览器登录，抓凭证后关浏览器 ======
// SSE 风格：用 query ?wait=1 阻塞等待完成；否则立即返回让前端轮询
app.get('/login', async (req, res) => {
  try {
    const wait = req.query.wait === '1';
    if (!wait) {
      // 异步触发登录，前端轮询 /status
      res.json({ ok: true, message: '请用 ?wait=1 调用此接口以阻塞等待登录完成' });
      return;
    }
    // 阻塞式：实时推送进度
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const send = (msg) => res.write(`data: ${JSON.stringify({ msg })}\n\n`);
    const creds = await loginMgr.login(send);
    if (creds) {
      res.write(`data: ${JSON.stringify({ ok: true, loggedIn: true, userInfo: creds.userInfo })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ ok: false, loggedIn: false, error: '登录未完成' })}\n\n`);
    }
    res.end();
  } catch (e) {
    console.error('[login] ERROR', e);
    try { res.write(`data: ${JSON.stringify({ ok: false, error: String(e) })}\n\n`); res.end(); }
    catch { res.status(500).json({ ok: false, error: String(e) }); }
  }
});

// ====== /upload 纯HTTP上传，返回预览URL ======
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: '缺少 file 字段' });
    const client = getClient();
    if (!client) {
      return res.status(401).json({ ok: false, error: '未登录，请先访问 /login?wait=1', loggedIn: false });
    }

    // 重命名临时文件为原始文件名（中文正确）
    const originalName = req.file.originalname;
    const ext = path.extname(originalName) || '';
    let finalPath = req.file.path;
    if (ext && !finalPath.toLowerCase().endsWith(ext.toLowerCase())) {
      finalPath = req.file.path + ext;
      fs.renameSync(req.file.path, finalPath);
    }

    const t0 = Date.now();
    const result = await client.upload(finalPath, (m) => console.log('[upload progress]', m));

    // 清理临时文件
    try { fs.unlinkSync(finalPath); } catch {}

    res.json({
      ok: true,
      loggedIn: true,
      file: originalName,
      modelId: result.modelId,
      modelName: result.modelName,
      shareUrl: result.shareUrl,
      previewOpened: false, // 纯HTTP不自动开浏览器，由前端用 shareUrl 打开
      warning: result.warning || null,
      duration: ((Date.now() - t0) / 1000).toFixed(1) + 's',
      message: result.shareUrl ? '上传成功，预览链接已生成' : '上传成功但分享链接生成超时',
    });
  } catch (e) {
    console.error('[upload] ERROR', e.message);
    if (e.message === 'TOKEN_EXPIRED') {
      return res.status(401).json({ ok: false, error: '登录已过期，请重新访问 /login?wait=1', tokenExpired: true });
    }
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ====== /logout 清除本地凭证 ======
app.post('/logout', (req, res) => {
  loginMgr.clearCreds();
  res.json({ ok: true, message: '本地凭证已清除' });
});

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  JLC 3D Viewer Proxy (纯HTTP模式)`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`========================================\n`);
});
