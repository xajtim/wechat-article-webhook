const express = require('express');
const crypto = require('crypto');
const https = require('https');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 环境变量
const CONFIG = {
  CORPID: process.env.CORPID,
  CORPSECRET: process.env.CORPSECRET,
  USER_ID: process.env.USER_ID,
  WECHAT_APPID: process.env.WECHAT_APPID,
  WECHAT_SECRET: process.env.WECHAT_SECRET,
  WECHAT_TOKEN: process.env.WECHAT_TOKEN,
  TAG_ID: process.env.TAG_ID
};

// HTTP请求工具
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } 
        catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// 验证签名
function verifySignature(query) {
  const { signature, timestamp, nonce } = query;
  const token = CONFIG.WECHAT_TOKEN;
  const arr = [token, timestamp, nonce].sort();
  const str = arr.join('');
  const sha1 = crypto.createHash('sha1').update(str).digest('hex');
  return sha1 === signature;
}

// 获取企微Token
async function getWeworkToken() {
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CONFIG.CORPID}&corpsecret=${CONFIG.CORPSECRET}`;
  const res = await request(url);
  if (res.errcode !== 0) throw new Error(`企微Token错误: ${res.errmsg}`);
  return res.access_token;
}

// 获取公众号Token
async function getWechatToken() {
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${CONFIG.WECHAT_APPID}&secret=${CONFIG.WECHAT_SECRET}`;
  const res = await request(url);
  if (!res.access_token) throw new Error(`公众号Token错误`);
  return res.access_token;
}

// 生成活码
async function generateContactWay(accessToken, title, mediaId) {
  const url = `https://qyapi.weixin.qq.com/cgi-bin/externalcontact/add_contact_way?access_token=${accessToken}`;
  const body = JSON.stringify({
    type: 2, scene: 2, user: [CONFIG.USER_ID],
    remark: `公众号-${title}`, tags: [CONFIG.TAG_ID],
    skip_verify: true, state: `auto-generated-${mediaId}`
  });
  const res = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (res.errcode !== 0) throw new Error(`生成活码失败: ${res.errmsg}`);
  return res.qr_code;
}

// 更新文章
async function updateArticle(accessToken, mediaId, title, qrCode) {
  const url = `https://api.weixin.qq.com/cgi-bin/material/update_news?access_token=${accessToken}`;
  const body = JSON.stringify({
    media_id: mediaId, index: 0,
    articles: [{ title: title, content_source_url: qrCode }]
  });
  const res = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (res.errcode !== 0) throw new Error(`更新文章失败: ${res.errmsg}`);
  return res;
}

// 主路由
app.all('/', async (req, res) => {
  try {
    // GET 验证
    if (req.method === 'GET' && req.query.echostr) {
      if (!verifySignature(req.query)) return res.status(403).send('Forbidden');
      return res.send(req.query.echostr);
    }
    
    // POST 处理
    if (req.method === 'POST') {
      const body = req.body;
      if (body.Event === 'publish_job_finish' && body.PublishStatus === 'success') {
        const article = body.Articles[0];
        const [weworkToken, wechatToken] = await Promise.all([
          getWeworkToken(), getWechatToken()
        ]);
        const qrCode = await generateContactWay(weworkToken, article.Title, body.MediaId);
        await updateArticle(wechatToken, body.MediaId, article.Title, qrCode);
        return res.json({ errcode: 0, errmsg: 'ok' });
      }
      return res.json({ errcode: 0, errmsg: 'ignored' });
    }
    
    res.json({ errcode: 0, errmsg: 'ok' });
  } catch (error) {
    console.error('错误:', error);
    res.status(500).json({ errcode: -1, errmsg: error.message });
  }
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
