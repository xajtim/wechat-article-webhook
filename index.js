const express = require('express');
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const xml2js = require('xml2js');

const app = express();

// 关键：必须按顺序使用中间件，先解析XML
app.use(express.text({ type: 'text/xml', limit: '10mb' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const CONFIG = {
  CORPID: process.env.CORPID,
  CORPSECRET: process.env.CORPSECRET,
  USER_ID: process.env.USER_ID,
  WECHAT_APPID: process.env.WECHAT_APPID,
  WECHAT_SECRET: process.env.WECHAT_SECRET,
  WECHAT_TOKEN: process.env.WECHAT_TOKEN,
  ENCODING_AES_KEY: process.env.ENCODING_AES_KEY,
  TAG_ID: process.env.TAG_ID
};

// PKCS7 去除填充
function pkcs7Unpad(buffer) {
  const pad = buffer[buffer.length - 1];
  return buffer.slice(0, buffer.length - pad);
}

// AES-256-CBC 解密
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

// 验证签名
function verifySignature(query) {
  const { signature, timestamp, nonce } = query;
  const token = CONFIG.WECHAT_TOKEN;
  const arr = [token, timestamp, nonce].sort();
  const str = arr.join('');
  const sha1 = crypto.createHash('sha1').update(str).digest('hex');
  return sha1 === signature;
}

// 解析XML为JS对象
async function parseXML(xmlStr) {
  return new Promise((resolve, reject) => {
    xml2js.parseString(xmlStr, { explicitArray: false }, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// 获取企微 Token
async function getWeworkToken() {
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
}

// 获取公众号 Token
async function getWechatToken() {
  const result = await cloud.call({
    url: 'https://api.weixin.qq.com/cgi-bin/token',
    method: 'GET',
    data: {
      grant_type: 'client_credential',
      appid: CONFIG.WECHAT_APPID,
      secret: CONFIG.WECHAT_SECRET
    }
  });
  if (!result.access_token) throw new Error(`公众号Token错误`);
  return result.access_token;
}

// 生成活码
async function generateContactWay(accessToken, title, mediaId) {
  const result = await cloud.call({
    url: `https://qyapi.weixin.qq.com/cgi-bin/externalcontact/add_contact_way?access_token=${accessToken}`,
    method: 'POST',
    data: {
      type: 2,
      scene: 2,
      user: [CONFIG.USER_ID],
      remark: `公众号-${title}`,
      tags: [CONFIG.TAG_ID],
      skip_verify: true,
      state: `article-${mediaId}`
    }
  });
  if (result.errcode !== 0) throw new Error(`生成活码失败: ${result.errmsg}`);
  return result.config_id; // 注意：返回的是config_id，不是qr_code
}

// 更新文章阅读原文
async function updateArticle(accessToken, mediaId, title, configId) {
  // 通过config_id生成实际链接
  const qrCode = `https://work.weixin.qq.com/ca/cawcde${configId}`;
  
  const result = await cloud.call({
    url: `https://api.weixin.qq.com/cgi-bin/material/update_news?access_token=${accessToken}`,
    method: 'POST',
    data: {
      media_id: mediaId,
      index: 0,
      articles: [{
        title: title,
        content_source_url: qrCode,
        show_cover_pic: 1
      }]
    }
  });
  if (result.errcode !== 0) throw new Error(`更新文章失败: ${result.errmsg}`);
  return result;
}

// 主路由 - 关键修复部分
app.all('/', async (req, res) => {
  try {
    console.log('===== 收到请求 =====');
    console.log('Method:', req.method);
    console.log('Query:', req.query);
    
    // GET 验证服务器
    if (req.method === 'GET' && req.query.echostr) {
      if (!verifySignature(req.query)) {
        console.error('签名验证失败');
        return res.status(403).send('Forbidden');
      }
      console.log('服务器验证成功');
      return res.send(req.query.echostr);
    }
    
    // POST 处理微信推送
    if (req.method === 'POST') {
      console.log('收到POST，Body类型:', typeof req.body);
      console.log('Body内容:', req.body);
      
      let xmlData;
      
      // 解析XML
      try {
        if (typeof req.body === 'string') {
          xmlData = await parseXML(req.body);
        } else {
          xmlData = req.body;
        }
      } catch (parseErr) {
        console.error('XML解析失败:', parseErr);
        return res.send('success'); // 即使解析失败也要返回success
      }
      
      console.log('解析后XML:', JSON.stringify(xmlData));
      
      let msgData = xmlData.xml || xmlData;
      
      // 如果是加密消息，先解密
      if (msgData.Encrypt && CONFIG.ENCODING_AES_KEY) {
        try {
          const decrypted = decryptWechatMessage(msgData.Encrypt, CONFIG.ENCODING_AES_KEY);
          const decryptedXML = await parseXML(decrypted.message);
          msgData = decryptedXML.xml || decryptedXML;
          console.log('解密后数据:', JSON.stringify(msgData));
        } catch (decryptErr) {
          console.error('解密失败:', decryptErr);
          // 继续用原始数据尝试
        }
      }
      
      // 关键：微信事件字段名可能是小写
      const eventType = msgData.Event || msgData.event;
      const msgType = msgData.MsgType || msgData.msgType;
      
      console.log('事件类型:', eventType);
      console.log('消息类型:', msgType);
      
      // 处理发布完成事件
      if (eventType === 'publish_job_finish') {
        console.log('✓ 匹配到 publish_job_finish 事件');
        
        const publishStatus = msgData.PublishStatus || msgData.publishStatus;
        const mediaId = msgData.MediaId || msgData.mediaId;
        
        console.log('发布状态:', publishStatus);
        console.log('MediaId:', mediaId);
        
        if (publishStatus === 'success' && mediaId) {
          try {
            // 获取文章标题（可能在不同字段）
            let title = '未命名文章';
            if (msgData.Articles && msgData.Articles.item) {
              const articles = Array.isArray(msgData.Articles.item) 
                ? msgData.Articles.item 
                : [msgData.Articles.item];
              title = articles[0].Title || articles[0].title || title;
            }
            
            console.log(`开始处理文章: ${title}, MediaId: ${mediaId}`);
            
            // 并行获取Token
            const [weworkToken, wechatToken] = await Promise.all([
              getWeworkToken(),
              getWechatToken()
            ]);
            
            // 生成活码
            const configId = await generateContactWay(weworkToken, title, mediaId);
            console.log('活码生成成功, configId:', configId);
            
            // 更新文章
            await updateArticle(wechatToken, mediaId, title, configId);
            console.log('文章更新成功');
            
          } catch (processErr) {
            console.error('处理文章失败:', processErr);
            // 继续返回success，避免微信重试
          }
        } else {
          console.log('发布未成功或无MediaId');
        }
      } else {
        console.log('不是 publish_job_finish 事件，忽略');
      }
      
      // 必须返回success，否则微信会重试
      return res.send('success');
    }
    
    res.send('success');
    
  } catch (error) {
    console.error('处理失败:', error);
    res.send('success'); // 即使出错也要返回success
  }
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    time: new Date().toISOString(),
    hasAesKey: !!CONFIG.ENCODING_AES_KEY
  });
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('支持XML解密:', !!CONFIG.ENCODING_AES_KEY);
});
