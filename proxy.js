const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const AUTH_KEY = process.env.PROXY_AUTH_KEY || 'XuAiJieProxy2024';
const WECHAT_APPID = process.env.WECHAT_APPID;
const WECHAT_SECRET = process.env.WECHAT_SECRET;
const CORPID = process.env.CORPID;
const CORPSECRET = process.env.CORPSECRET;

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
      detail: err.response && err.response.data ? err.response.data : null
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
      detail: err.response && err.response.data ? err.response.data : null
    });
  }
});

// 通用企微 API 代理（解决客户联系等接口的 IP 白名单问题）
app.all('/wework-proxy/*', checkAuth, async (req, res) => {
  try {
    const targetPath = req.params[0];
    const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const url = `https://qyapi.weixin.qq.com/cgi-bin/${targetPath}${search}`;
    const result = await axios({
      method: req.method,
      url,
      data: req.body,
      timeout: 15000
    });
    res.status(result.status).json(result.data);
  } catch (err) {
    res.status(err.response ? err.response.status : 500).json(
      err.response ? err.response.data : { error: err.message }
    );
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Token proxy running on port ' + PORT);
});
