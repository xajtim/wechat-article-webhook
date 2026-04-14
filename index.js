const express = require('express');
const crypto = require('crypto');
const xml2js = require('xml2js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(express.text({ type: 'text/xml', limit: '10mb' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CONFIG = {
  CORPID: process.env.CORPID,
  CORPSECRET: process.env.CORPSECRET,
  USER_ID: process.env.USER_ID,
  WECHAT_APPID: process.env.WECHAT_APPID,
  WECHAT_SECRET: process.env.WECHAT_SECRET,
  WECHAT_TOKEN: process.env.WECHAT_TOKEN,
  ENCODING_AES_KEY: process.env.ENCODING_AES_KEY,
  WEWORK_TOKEN: process.env.WEWORK_TOKEN,
  WEWORK_AES_KEY: process.env.WEWORK_AES_KEY,
  TAG_ID: process.env.TAG_ID
};

// 固定 IP 代理配置（解决云托管出口 IP 漂移问题）
const PROXY_BASE = process.env.PROXY_BASE || 'http://175.178.219.156:3001';
const PROXY_AUTH = process.env.PROXY_AUTH || 'XuAiJieProxy2024';

// =================== 工具函数 ===================

async function httpRequest(config) {
  try {
    const response = await axios({ ...config, timeout: 15000 });
    return response.data;
  } catch (err) {
    console.error('HTTP 请求失败:', err.message, config.url);
    throw new Error(`HTTP 请求失败: ${err.message}`);
  }
}

const tokenCache = {
  wework: { token: null, expiresAt: 0 },
  wechat: { token: null, expiresAt: 0 }
};

let serverIpCache = { ip: null, expiresAt: 0 };

async function getServerIp() {
  const now = Date.now();
  if (serverIpCache.ip && serverIpCache.expiresAt > now) {
    return serverIpCache.ip;
  }

  const ipApis = [
    { url: 'https://api.ip.sb/geoip', extract: d => d.ip },
    { url: 'https://httpbin.org/ip', extract: d => d.origin },
    { url: 'https://ipinfo.io/json', extract: d => d.ip }
  ];

  for (const api of ipApis) {
    try {
      const res = await axios.get(api.url, { timeout: 5000 });
      let ip = api.extract(res.data);
      if (ip && typeof ip === 'string') {
        // httpbin 的 origin 可能包含 ipv6 前缀，清理一下
        ip = ip.split(',')[0].trim().replace(/^::ffff:/, '');
        serverIpCache = { ip, expiresAt: now + 5 * 60 * 1000 };
        return ip;
      }
    } catch (e) {
      console.error(`IP查询失败 ${api.url}:`, e.message);
    }
  }

  return null;
}

async function getWeworkToken() {
  const now = Date.now();
  if (tokenCache.wework.token && tokenCache.wework.expiresAt > now + 60000) {
    return tokenCache.wework.token;
  }
  const result = await httpRequest({
    url: `${PROXY_BASE}/wework-token`,
    method: 'GET',
    headers: { 'x-auth-key': PROXY_AUTH }
  });
  if (result.errcode !== 0) throw new Error(`企微Token错误: ${result.errmsg}`);
  tokenCache.wework.token = result.access_token;
  tokenCache.wework.expiresAt = now + result.expires_in * 1000;
  return result.access_token;
}

async function getWechatToken() {
  const now = Date.now();
  if (tokenCache.wechat.token && tokenCache.wechat.expiresAt > now + 60000) {
    return tokenCache.wechat.token;
  }
  const result = await httpRequest({
    url: `${PROXY_BASE}/wechat-token`,
    method: 'GET',
    headers: { 'x-auth-key': PROXY_AUTH }
  });
  if (!result.access_token) throw new Error(`公众号Token错误: ${JSON.stringify(result)}`);
  tokenCache.wechat.token = result.access_token;
  tokenCache.wechat.expiresAt = now + result.expires_in * 1000;
  return result.access_token;
}

async function getDraft(accessToken, mediaId) {
  const result = await httpRequest({
    url: `https://api.weixin.qq.com/cgi-bin/draft/get?access_token=${accessToken}`,
    method: 'POST',
    data: { media_id: mediaId }
  });
  if (result.errcode !== undefined && result.errcode !== 0) {
    throw new Error(`获取草稿失败: ${result.errmsg}`);
  }
  return result;
}

async function createAcquisitionLink(accessToken, title, mediaId, articleIndex = 0) {
  const shortId = crypto.createHash('md5').update(mediaId).digest('hex').slice(0, 8);
  const customerChannel = `a${shortId}${articleIndex}`;
  const result = await httpRequest({
    url: `${PROXY_BASE}/wework-proxy/externalcontact/customer_acquisition/create_link?access_token=${accessToken}`,
    method: 'POST',
    headers: { 'x-auth-key': PROXY_AUTH },
    data: {
      link_name: `公众号-${title}`,
      range: {
        user_list: [CONFIG.USER_ID]
      },
      skip_verify: true
    }
  });
  if (result.errcode !== 0) throw new Error(`生成获客链接失败: ${result.errmsg}`);

  // 在 URL 后拼接 customer_channel 用于追踪来源
  const linkUrl = result.link && result.link.url ? result.link.url : '';
  const linkId = result.link && result.link.link_id ? result.link.link_id : '';
  const qrCode = linkUrl + '?customer_channel=' + encodeURIComponent(customerChannel);

  return { linkId, qrCode, customerChannel };
}

async function updateArticle(accessToken, mediaId, title, qrCode, articleIndex = 0) {
  const draft = await getDraft(accessToken, mediaId);
  const items = draft.news_item || [];
  if (!items.length) throw new Error('草稿内容为空，请确认 media_id 是草稿箱中的图文');
  if (articleIndex >= items.length) throw new Error(`文章索引 ${articleIndex} 超出范围，该草稿共 ${items.length} 篇文章`);

  const original = items[articleIndex];

  const updatedArticle = {
    title: title || original.title,
    thumb_media_id: original.thumb_media_id,
    show_cover_pic: original.show_cover_pic,
    author: original.author || '',
    digest: original.digest || '',
    content: original.content,
    content_source_url: qrCode,
    need_open_comment: original.need_open_comment || 0,
    only_fans_can_comment: original.only_fans_can_comment || 0
  };

  const result = await httpRequest({
    url: `https://api.weixin.qq.com/cgi-bin/draft/update?access_token=${accessToken}`,
    method: 'POST',
    data: {
      media_id: mediaId,
      index: articleIndex,
      articles: updatedArticle
    }
  });

  if (result.errcode !== 0) throw new Error(`更新草稿失败: ${result.errmsg}`);
  return { result, qrCode, title: updatedArticle.title };
}

function verifySignature(query) {
  const { signature, timestamp, nonce } = query;
  const token = CONFIG.WECHAT_TOKEN;
  const arr = [token, timestamp, nonce].sort();
  const str = arr.join('');
  const sha1 = crypto.createHash('sha1').update(str).digest('hex');
  return sha1 === signature;
}

async function parseXML(xmlStr) {
  return new Promise((resolve, reject) => {
    xml2js.parseString(xmlStr, { explicitArray: false }, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function pkcs7Unpad(buffer) {
  const pad = buffer[buffer.length - 1];
  return buffer.slice(0, buffer.length - pad);
}

function decryptWechatMessage(encrypted, aesKey) {
  try {
    const key = Buffer.from(aesKey, 'base64');
    const iv = key.slice(0, 16);
    const encryptedBuffer = Buffer.from(encrypted, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(false);
    let decrypted = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
    decrypted = pkcs7Unpad(decrypted);
    const content = decrypted.slice(16);
    const msgLen = content.readUInt32BE(0);
    const message = content.slice(4, 4 + msgLen).toString('utf8');
    const appId = content.slice(4 + msgLen).toString('utf8');
    return { message, appId };
  } catch (err) {
    console.error('解密失败:', err);
    throw err;
  }
}

// =================== 路由 ===================

// Webhook + 首页
app.all('/', async (req, res) => {
  try {
    console.log('===== 收到请求 ===== Method:', req.method, 'Query:', req.query);

    // GET 验证服务器（微信服务器配置）
    if (req.method === 'GET' && req.query.echostr) {
      if (!verifySignature(req.query)) {
        console.error('签名验证失败');
        return res.status(403).send('Forbidden');
      }
      console.log('服务器验证成功');
      return res.send(req.query.echostr);
    }

    // GET 无 echostr -> 返回管理页面
    if (req.method === 'GET') {
      const htmlPath = path.join(__dirname, 'index.html');
      if (fs.existsSync(htmlPath)) {
        return res.sendFile(htmlPath);
      }
      return res.send('服务运行中');
    }

    // POST 处理微信事件推送
    if (req.method === 'POST') {
      let xmlData;
      try {
        xmlData = typeof req.body === 'string' ? await parseXML(req.body) : req.body;
      } catch (parseErr) {
        console.error('XML解析失败:', parseErr);
        return res.send('success');
      }

      let msgData = xmlData.xml || xmlData;
      if (msgData.Encrypt && CONFIG.ENCODING_AES_KEY) {
        try {
          const decrypted = decryptWechatMessage(msgData.Encrypt, CONFIG.ENCODING_AES_KEY);
          const decryptedXML = await parseXML(decrypted.message);
          msgData = decryptedXML.xml || decryptedXML;
        } catch (e) {
          console.error('解密失败:', e);
        }
      }

      const eventType = msgData.Event || msgData.event;
      console.log('收到事件:', eventType, JSON.stringify(msgData));

      if (eventType === 'PUBLISHJOBFINISH') {
        const publishStatus = msgData.publish_status;
        const publishId = msgData.publish_id;
        const articleId = msgData.article_id;
        console.log(`发布完成事件 - status:${publishStatus} publishId:${publishId} articleId:${articleId}`);
        // 已发布的文章无法通过 API 修改，此处仅记录日志
      }

      return res.send('success');
    }

    res.send('success');
  } catch (error) {
    console.error('处理失败:', error);
    res.send('success');
  }
});

// API：发布前处理（生成活码 + 更新阅读原文）
app.post('/api/process', async (req, res) => {
  try {
    const { media_id, title: manualTitle, index: articleIndex = 0 } = req.body;
    if (!media_id) {
      return res.status(400).json({ success: false, message: '缺少 media_id 参数' });
    }

    console.log('开始处理 media_id:', media_id);

    const [weworkToken, wechatToken] = await Promise.all([
      getWeworkToken(),
      getWechatToken()
    ]);

    let title = manualTitle;
    if (!title) {
      const material = await getNewsMaterial(wechatToken, media_id);
      const items = material.news_item || [];
      if (items.length) title = items[0].title;
    }
    if (!title) title = '未命名文章';

    const { linkId, qrCode, customerChannel } = await createAcquisitionLink(weworkToken, title, media_id, articleIndex);
    console.log('获客链接生成成功, linkId:', linkId, 'qrCode:', qrCode, 'channel:', customerChannel, 'index:', articleIndex);

    const { title: finalTitle } = await updateArticle(wechatToken, media_id, title, qrCode, articleIndex);
    console.log('草稿更新成功, qrCode:', qrCode, 'index:', articleIndex);

    return res.json({
      success: true,
      data: {
        media_id,
        title: finalTitle,
        link_id: linkId,
        qrcode_url: qrCode,
        index: articleIndex
      }
    });
  } catch (error) {
    console.error('处理失败:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 企微 Webhook - 接收消息服务器配置
// API：获取已生成的获客链接列表
app.get('/api/contact-ways', async (req, res) => {
  try {
    const weworkToken = await getWeworkToken();

    // 1. 拉取所有 link_id 列表
    const listResult = await httpRequest({
      url: `${PROXY_BASE}/wework-proxy/externalcontact/customer_acquisition/list_link?access_token=${weworkToken}`,
      method: 'POST',
      headers: { 'x-auth-key': PROXY_AUTH },
      data: { limit: 100 }
    });

    if (listResult.errcode !== 0) {
      return res.status(500).json({ success: false, message: `拉取获客链接列表失败: ${listResult.errmsg}` });
    }

    const linkIds = listResult.link_id_list || [];

    // 2. 逐个获取详情
    const items = [];
    for (const linkId of linkIds) {
      try {
        const detail = await httpRequest({
          url: `${PROXY_BASE}/wework-proxy/externalcontact/customer_acquisition/get?access_token=${weworkToken}`,
          method: 'POST',
          headers: { 'x-auth-key': PROXY_AUTH },
          data: { link_id: linkId }
        });
        if (detail.errcode === 0 && detail.link) {
          items.push({
            link_id: linkId,
            link_name: detail.link.link_name || '',
            url: detail.link.url || '',
            create_time: detail.link.create_time,
            skip_verify: detail.link.skip_verify
          });
        }
      } catch (e) {
        console.error('获取获客链接详情失败:', linkId, e.message);
      }
    }

    return res.json({ success: true, data: items });
  } catch (error) {
    console.error('获取获客链接列表失败:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// API：删除获客链接
app.post('/api/contact-ways/delete', async (req, res) => {
  try {
    const { link_id } = req.body;
    if (!link_id) {
      return res.status(400).json({ success: false, message: '缺少 link_id' });
    }
    const weworkToken = await getWeworkToken();
    const result = await httpRequest({
      url: `${PROXY_BASE}/wework-proxy/externalcontact/customer_acquisition/delete_link?access_token=${weworkToken}`,
      method: 'POST',
      headers: { 'x-auth-key': PROXY_AUTH },
      data: { link_id }
    });
    if (result.errcode !== 0) {
      return res.status(500).json({ success: false, message: `删除失败: ${result.errmsg}` });
    }
    return res.json({ success: true });
  } catch (error) {
    console.error('删除获客链接失败:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.all('/api/wework-webhook', async (req, res) => {
  try {
    console.log('===== 收到企微请求 ===== Method:', req.method, 'Query:', req.query);

    // GET 验证服务器
    if (req.method === 'GET' && req.query.echostr) {
      const { msg_signature, timestamp, nonce, echostr } = req.query;
      const token = CONFIG.WEWORK_TOKEN;
      const arr = [token, timestamp, nonce, echostr].sort();
      const str = arr.join('');
      const sha1 = crypto.createHash('sha1').update(str).digest('hex');

      if (sha1 !== msg_signature) {
        console.error('企微签名验证失败');
        return res.status(403).send('Forbidden');
      }

      console.log('企微服务器验证成功');

      // 如果有 AESKey，解密 echostr 后返回明文
      if (CONFIG.WEWORK_AES_KEY) {
        try {
          const decrypted = decryptWechatMessage(echostr, CONFIG.WEWORK_AES_KEY);
          return res.send(decrypted.message);
        } catch (decryptErr) {
          console.error('企微 echostr 解密失败:', decryptErr);
          return res.status(500).send('decrypt error');
        }
      }

      return res.send(echostr);
    }

    // POST 处理企微事件推送（如客户联系变更回调）
    if (req.method === 'POST') {
      let xmlData;
      try {
        xmlData = typeof req.body === 'string' ? await parseXML(req.body) : req.body;
      } catch (parseErr) {
        console.error('企微 XML 解析失败:', parseErr);
        return res.send('success');
      }

      let msgData = xmlData.xml || xmlData;
      if (msgData.Encrypt && CONFIG.WEWORK_AES_KEY) {
        try {
          const decrypted = decryptWechatMessage(msgData.Encrypt, CONFIG.WEWORK_AES_KEY);
          const decryptedXML = await parseXML(decrypted.message);
          msgData = decryptedXML.xml || decryptedXML;
          console.log('企微解密后数据:', JSON.stringify(msgData));
        } catch (e) {
          console.error('企微解密失败:', e);
        }
      }

      console.log('企微收到事件:', JSON.stringify(msgData));
      // 目前只返回 success，避免企微重试
      return res.send('success');
    }

    res.send('success');
  } catch (error) {
    console.error('企微处理失败:', error);
    res.send('success');
  }
});

// 通用：格式化图文列表
function formatNewsItems(items) {
  return items.map(it => {
    const articles = it.content && it.content.news_item ? it.content.news_item : [];
    return {
      media_id: it.media_id,
      update_time: it.update_time,
      articles: articles.map((article, idx) => ({
        index: idx,
        title: article.title || '无标题',
        has_qrcode: (article.content_source_url || '').includes('work.weixin.qq.com')
      }))
    };
  });
}

// API：获取草稿箱列表
app.get('/api/drafts', async (req, res) => {
  try {
    const accessToken = await getWechatToken();
    const result = await httpRequest({
      url: `https://api.weixin.qq.com/cgi-bin/draft/batchget?access_token=${accessToken}`,
      method: 'POST',
      data: { offset: 0, count: 20 }
    });

    if (result.errcode !== undefined && result.errcode !== 0) {
      return res.status(500).json({ success: false, message: `获取草稿失败: ${result.errmsg}` });
    }

    return res.json({ success: true, data: formatNewsItems(result.item || []) });
  } catch (error) {
    console.error('获取草稿失败:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// API：获取永久素材库列表（图文）
app.get('/api/materials', async (req, res) => {
  try {
    const accessToken = await getWechatToken();
    const result = await httpRequest({
      url: `https://api.weixin.qq.com/cgi-bin/material/batchget_material?access_token=${accessToken}`,
      method: 'POST',
      data: { type: 'news', offset: 0, count: 20 }
    });

    if (result.errcode !== undefined && result.errcode !== 0) {
      return res.status(500).json({ success: false, message: `获取素材失败: ${result.errmsg}` });
    }

    return res.json({ success: true, data: formatNewsItems(result.item || []) });
  } catch (error) {
    console.error('获取素材失败:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// API：获取当前服务器出口 IP
app.get('/api/server-ip', async (req, res) => {
  try {
    const ip = await getServerIp();
    if (ip) {
      return res.json({ success: true, ip });
    }
    return res.status(503).json({ success: false, message: '无法获取服务器出口 IP' });
  } catch (error) {
    console.error('获取服务器IP失败:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    env: {
      hasCorpid: !!CONFIG.CORPID,
      hasCorpsecret: !!CONFIG.CORPSECRET,
      hasUserId: !!CONFIG.USER_ID,
      hasWechatAppid: !!CONFIG.WECHAT_APPID,
      hasWechatSecret: !!CONFIG.WECHAT_SECRET,
      hasWechatToken: !!CONFIG.WECHAT_TOKEN,
      hasAesKey: !!CONFIG.ENCODING_AES_KEY,
      hasTagId: !!CONFIG.TAG_ID
    }
  });
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
