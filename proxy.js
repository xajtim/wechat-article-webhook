/**
 * 微信 Token 代理服务
 * 运行在你自己的固定 IP 服务器上，解决微信云托管出口 IP 不稳定的问题
 *
 * 启动方式:
 *   npm install express axios
 *   nohup node proxy.js > proxy.log 2>&1 &
 */
const express = require('express');
const axios = require('axios');

const app = express();

// ========== 配置区 ==========
// 建议从环境变量读取，防止密钥泄露在代码里
const AUTH_KEY = process.env.PROXY_AUTH_KEY || 'XuAiJieProxy2024';
const WECHAT_APPID = process.env.WECHAT_APPID;
const WECHAT_SECRET = process.env.WECHAT_SECRET;
const CORPID = process.env.CORPID;
const CORPSECRET = process.env.CORPSECRET;
// ===========================

function checkAuth(req, res, next) {
  if (req.headers['x-auth-key'] !== AUTH_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/wechat-token', checkAuth, async (req, res) => {
  try {
    const result = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
      params: {
        grant_type: 'client_credential',
        appid: WECHAT_APPID,
        secret: WECHAT_SECRET
      },
      timeout: 10000
    });
    res.json(result.data);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      detail: err.response?.data || null
    });
  }
});

app.get('/wework-token', checkAuth, async (req, res) => {
  try {
    const result = await axios.get('https://qyapi.weixin.qq.com/cgi-bin/gettoken', {
      params: {
        corpid: CORPID,
        corpsecret: CORPSECRET
      },
      timeout: 10000
    });
    res.json(result.data);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      detail: err.response?.data || null
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Token proxy running on port ${PORT}`);
  console.log(`Auth key: ${AUTH_KEY}`);
});
