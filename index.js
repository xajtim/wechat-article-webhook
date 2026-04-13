const express = require('express');
const cloud = require('wx-server-sdk');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 初始化微信云托管 SDK（关键！）
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV  // 使用当前环境
});

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

// 获取企微 AccessToken（免白名单）
async function getWeworkToken() {
  try {
    // 使用云调用 HTTP 请求（走内网，免 IP 白名单）
    const result = await cloud.call({
      url: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
      method: 'GET',
      data: {
        corpid: CONFIG.CORPID,
        corpsecret: CONFIG.CORPSECRET
      }
    });
    
    if (result.errcode !== 0) throw new Error(`企微Token错误: ${result.errmsg}`);
    return result.access_token;
  } catch (err) {
    console.error('获取企微Token失败:', err);
    throw err;
  }
}

// 获取公众号 AccessToken（免白名单）
async function getWechatToken() {
  try {
    const result = await cloud.call({
      url: 'https://api.weixin.qq.com/cgi-bin/token',
      method: 'GET',
      data: {
        grant_type: 'client_credential',
        appid: CONFIG.WECHAT_APPID,
        secret: CONFIG.WECHAT_SECRET
      }
    });
    
    if (!result.access_token) throw new Error(`公众号Token错误: ${JSON.stringify(result)}`);
    return result.access_token;
  } catch (err) {
    console.error('获取公众号Token失败:', err);
    throw err;
  }
}

// 生成活码（免白名单）
async function generateContactWay(accessToken, title, mediaId) {
  try {
    const result = await cloud.call({
      url: `https://qyapi.weixin.qq.com/cgi-bin/externalcontact/add_contact_way?access_token=${accessToken}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      data: {
        type: 2,
        scene: 2,
        user: [CONFIG.USER_ID],
        remark: `公众号-${title}`,
        tags: [CONFIG.TAG_ID],
        skip_verify: true,
        state: `auto-generated-${mediaId}`
      }
    });
    
    if (result.errcode !== 0) throw new Error(`生成活码失败: ${result.errmsg}`);
    return result.qr_code;
  } catch (err) {
    console.error('生成活码失败:', err);
    throw err;
  }
}

// 更新文章阅读原文（免白名单）
async function updateArticle(accessToken, mediaId, title, qrCode) {
  try {
    const result = await cloud.call({
      url: `https://api.weixin.qq.com/cgi-bin/material/update_news?access_token=${accessToken}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      data: {
        media_id: mediaId,
        index: 0,
        articles: [{
          title: title,
          content_source_url: qrCode
        }]
      }
    });
    
    if (result.errcode !== 0) throw new Error(`更新文章失败: ${result.errmsg}`);
    return result;
  } catch (err) {
    console.error('更新文章失败:', err);
    throw err;
  }
}

// 验证签名（和之前一样）
function verifySignature(query) {
  const { signature, timestamp, nonce } = query;
  const token = CONFIG.WECHAT_TOKEN;
  const arr = [token, timestamp, nonce].sort();
  const str = arr.join('');
  const crypto = require('crypto');
  const sha1 = crypto.createHash('sha1').update(str).digest('hex');
  return sha1 === signature;
}

// 主路由
app.all('/', async (req, res) => {
  try {
    // GET 验证
    if (req.method === 'GET' && req.query.echostr) {
      if (!verifySignature(req.query)) {
        return res.status(403).send('Forbidden');
      }
      return res.send(req.query.echostr);
    }
    
    // POST 处理
    if (req.method === 'POST') {
      const body = req.body;
      console.log('收到事件:', body.Event);
      
      if (body.Event === 'publish_job_finish' && body.PublishStatus === 'success') {
        const article = body.Articles[0];
        const mediaId = body.MediaId;
        const title = article.Title;
        
        console.log(`处理文章: ${title}`);
        
        // 并行获取 Token
        const [weworkToken, wechatToken] = await Promise.all([
          getWeworkToken(),
          getWechatToken()
        ]);
        
        console.log('Token 获取成功');
        
        // 生成活码
        const qrCode = await generateContactWay(weworkToken, title, mediaId);
        console.log('活码生成成功:', qrCode);
        
        // 更新文章
        await updateArticle(wechatToken, mediaId, title, qrCode);
        console.log('文章更新成功');
        
        return res.json({ errcode: 0, errmsg: 'ok' });
      }
      
      return res.json({ errcode: 0, errmsg: 'ignored' });
    }
    
    res.json({ errcode: 0, errmsg: 'ok' });
    
  } catch (error) {
    console.error('处理失败:', error);
    res.status(500).json({ errcode: -1, errmsg: error.message });
  }
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    time: new Date().toISOString(),
    sdk: 'wx-server-sdk'
  });
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('使用 SDK: wx-server-sdk (免IP白名单)');
});
