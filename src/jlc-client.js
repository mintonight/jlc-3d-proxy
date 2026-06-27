// JLC 3D Viewer 纯 HTTP API 客户端
// 无需浏览器常驻。登录后用 token + sign 签名纯 HTTP 上传，拿回预览URL。
const crypto = require('crypto');
const fs = require('fs');

// 从 JS 逆向出的签名密钥（444 chunk 第807行）
const SIGN_SECRET = 'NjVkczQxczRkNTZBQVMxRDU2MWQwMzJBQTFTRCAzMmExZDU2czFkMzFTMEQzc2RT';
const API = 'https://api.forface3d.com/forface';

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const md5Base64 = (buf) => crypto.createHash('md5').update(buf).digest('base64');

// 生成签名：sign = MD5(requestId + SECRET)，requestId = 毫秒时间戳
function makeSign() {
  const requestId = String(Date.now());
  return { sign: md5(requestId + SIGN_SECRET), requestId };
}

class JlcClient {
  constructor(creds) {
    // creds = { token, cookies, userInfo } 从本地凭证文件读
    this.token = (creds && creds.token) || '';
    this.cookies = (creds && creds.cookies) || [];
  }

  // 解析 cookie 数组为 header 字符串
  cookieHeader() {
    if (!this.cookies || !this.cookies.length) return '';
    return this.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  // 通用 POST 调用
  async call(endpoint, body, opts = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'System-Sources-Side': 'Web',
    };
    if (this.token) headers.token = this.token;
    const ck = this.cookieHeader();
    if (ck) headers.cookie = ck;
    Object.assign(headers, opts.headers || {});
    const r = await fetch(API + endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { j = { success: false, _raw: text }; }
    return { status: r.status, json: j };
  }

  // token 是否有效：调 getUserInfo，成功即有效
  async checkToken() {
    if (!this.token) return false;
    const { json } = await this.call('/user/user/getUserInfo', {});
    return !!(json.success && json.data);
  }

  // 完整上传流程：返回 { modelId, modelName, shareUrl }
  async upload(filePath, onProgress) {
    const pn = (m) => { console.log('[jlc]', m); onProgress && onProgress(m); };
    if (!fs.existsSync(filePath)) throw new Error('文件不存在: ' + filePath);
    const buf = fs.readFileSync(filePath);
    const path = require('path');
    const fileName = path.basename(filePath);
    const fileType = path.extname(fileName).slice(1).toUpperCase();
    const fileMd5 = md5Base64(buf);
    pn(`文件 ${fileName} (${(buf.length / 1024).toFixed(0)}KB)`);

    // token 有效性
    if (!(await this.checkToken())) {
      throw new Error('TOKEN_EXPIRED');
    }

    // 1. 获取 OSS 上传地址
    pn('获取上传地址…');
    const { sign, requestId } = makeSign();
    const r1 = await this.call('/model/viewer/browser/v2/genUploadFileUrl',
      { sign, requestId, fileName, fileSize: buf.length, fileType, fileMd5 });
    if (!r1.json.success) throw new Error('genUploadFileUrl失败: ' + (r1.json.msg || r1.json.code));
    const { fileIndexId, uploadUrl } = r1.json.data;

    // 2. 直传 OSS（PUT 二进制）
    // 关键 header（逆向自浏览器实际上传）：content-type 必须为空、带 content-disposition 和 token
    pn('上传到OSS…');
    const fileNameEncoded = encodeURIComponent(fileName);
    const ossHeaders = {
      'content-md5': fileMd5,
      'content-type': '',                                    // 必须空字符串！否则 OSS 签名不匹配
      'content-disposition': "attachment; filename*=UTF-8''" + fileNameEncoded,
      'accept': 'application/json, text/plain, */*',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    };
    if (this.token) ossHeaders.token = this.token;
    const r2 = await fetch(uploadUrl, { method: 'PUT', body: buf, headers: ossHeaders });
    if (r2.status !== 200) {
      const errBody = await r2.text().catch(() => '');
      throw new Error('OSS直传失败: ' + r2.status + ' ' + errBody.slice(0, 200));
    }

    // 3. 通知上传完成
    pn('确认上传…');
    const r3 = await this.call('/model/viewer/browser/v2/updateFileStatus',
      { sign, requestId, fileIndexId, fileStatus: 3 });
    if (!r3.json.success) throw new Error('updateFileStatus失败: ' + (r3.json.msg || r3.json.code));

    // 4. 注册模型，拿 modelId
    pn('注册模型…');
    const form = new FormData();
    form.append('file[]', fileIndexId);
    const r4 = await fetch(API + '/model/viewer/browser/v2/uploadModel', {
      method: 'POST',
      body: form,
      headers: { 'System-Sources-Side': 'Web', ...(this.token ? { token: this.token } : {}), cookie: this.cookieHeader() },
    });
    const j4 = await r4.json();
    if (!j4.success) throw new Error('uploadModel失败: ' + (j4.msg || j4.code));
    const modelId = j4.data.modelId;
    const modelName = j4.data.modelName;
    pn('转码中…');

    // 5. 等转码 + 创建分享 + 拿 tokenKey
    let shareUrl = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      // 创建分享（首次成功，后续返回 10209 已分享，无所谓）
      await this.call('/model/viewer/browser/v2/shareModel', { modelId, shareHours: 24 });
      const ps = await this.call('/model/viewer/browser/v2/previewShareModel', { modelId });
      const tk = ps.json.data && ps.json.data.tokenKey;
      if (tk) {
        shareUrl = `https://3d-viewer.jlc.com/share?modelId=${modelId}&tokenKey=${tk}`;
        break;
      }
      if (i % 3 === 0) pn(`转码中… ${(i + 1) * 3}s`);
    }

    if (!shareUrl) {
      // 分享链路失败也返回 modelId（模型已上传成功）
      return { modelId, modelName, shareUrl: null, warning: '模型已上传但分享链接生成超时，可稍后重试或用 modelId 查看' };
    }
    pn('完成');
    return { modelId, modelName, shareUrl };
  }
}

module.exports = { JlcClient, makeSign, SIGN_SECRET, API };
