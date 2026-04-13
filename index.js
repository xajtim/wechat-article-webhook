const express = require('express');
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const xml2js = require('xml2js');

const app = express();
app.use(express.text({ type: 'text/xml' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 初始化微信云托管 SDK
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

// 环境变量
const CONFIG = {
  CORPID: process.env.CORPID,
  CORPSECRET: process.env.CORPSECRET,
  USER_ID: process.env.USER_ID,
  WECHAT_APPID: process.env.WECHAT_APPID,
  WECHAT_SECRET: process.env.WECHAT_SECRET,
  WECHAT_TOKEN: process.env.WECHAT_TOKEN,
  ENCODING_AES_KEY: process.env.ENCODING_AES_KEY, // 微信后台设置的EncodingAESKey
  TAG_ID: process.env.TAG_ID
};

// ========== XML 解密相关函数 ==========

// PKCS7 去除填充
function pkcs7Unpad(buffer) {
  const pad = buffer[buffer.length - 1];
  return buffer.slice(0, buffer.length - pad);
}

// AES-256-CBC 解密（微信消息体解密）
function decryptWechatMessage(encrypted, aesKey) {
  try {
    // Base64解码AESKey得到32字节Key
    const key = Buffer.from(aesKey, 'base64');
    const iv = key.slice(0, 16); // 取前16字节作为IV
    
    // Base64解码密文
    const encryptedBuffer = Buffer.from(encrypted, 'base64');
    
    // AES-256-CBC 解密
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(false);
    let decrypted = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
    
    // 去除PKCS7填充
    decrypted = pkcs7Unpad(decrypted);
    
    // 微信消息格式：16字节随机字符串 + 4字节消息长度 + 消息内容 + appid
    const content = decrypted.slice(16); // 去掉前16字节随机串
    const msgLen = content.readUInt32BE(0); // 前4字节是消息长度
    const message = content.slice(4, 4 + msgLen).toString('utf8'); // 提取消息
    const appId = content.slice(4 + msgLen).toString('utf8'); // 后面的appid
    
    return {
      message: message,
      appId: appId
    };
  } catch (err) {
    console.error('解密失败:', err);
    throw new Error('消息解密失败: ' + err.message);
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

// 生成返回给微信服务器的加密消息（如果需要的话）
function encryptMessage(message, aesKey, token, timestamp, nonce) {
  // 简单实现：如果你需要返回加密消息才用这个，目前你只需要解密接收，返回明文success即可
  return message;
}

// 解析XML
async function parseXML(xmlStr) {
  return new Promise((resolve, reject) => {
    xml2js.parseString(xmlStr, { explicitArray: false }, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// 构建XML响应
function buildXML(obj) {
  const builder = new xml2js.Builder({ 
    headless: true, 
    rootName: 'xml',
    renderOpts: { pretty: false }
  });
  return builder.buildObject(obj);
}

// ========== 业务逻辑函数 ==========

// 获取企微 AccessToken
async function getWeworkToken() {
  try {
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

// 获取公众号 AccessToken
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

// 生成活码
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

// 更新文章阅读原文
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

// ========== 主路由 ==========

app.all('/', async (req, res) => {
  try {
    console.log('收到请求:', req.method, req.query, req.body);
    
    // GET 验证服务器地址有效性
    if (req.method === 'GET' && req.query.echostr) {
      if (!verifySignature(req.query)) {
        console.error('签名验证失败');
        return res.status(403).send('Forbidden');
      }
      console.log('服务器验证成功');
      return res.send(req.query.echostr);
    }
    
    // POST 处理微信推送事件
    if (req.method === 'POST') {
      let xmlData;
      
      // 1. 解析XML
      if (typeof req.body === 'string') {
        xmlData = await parseXML(req.body);
      } else {
        xmlData = req.body;
      }
      
      console.log('收到XML:', JSON.stringify(xmlData));
      
      let decryptedBody = xmlData.xml;
      
      // 2. 如果有加密消息，进行解密（安全模式）
      if (decryptedBody.Encrypt && CONFIG.ENCODING_AES_KEY) {
        try {
          const encrypt = decryptedBody.Encrypt;
          const decrypted = decryptWechatMessage(encrypt, CONFIG.ENCODING_AES_KEY);
          // 解密后再次解析XML
          const decryptedXML = await parseXML(decrypted.message);
          decryptedBody = decryptedXML.xml || decryptedXML;
          console.log('解密后消息:', decryptedBody);
        } catch (decryptErr) {
          console.error('解密失败，尝试使用明文模式:', decryptErr);
          // 如果解密失败，可能是明文模式，继续使用原始数据
        }
      } else {
        console.log('明文模式，无需解密');
      }
      
      // 3. 处理发布成功事件
      if (decryptedBody.Event === 'publish_job_finish') {
        const publishStatus = decryptedBody.PublishStatus || decryptedBody.PublishStatusEvent?.PublishStatus;
        
        if (publishStatus === 'success') {
          // 解析文章信息（可能在不同字段）
          let mediaId, articleTitle;
          
          // 尝试从不同位置获取MediaId
          mediaId = decryptedBody.MediaId || decryptedBody.media_id;
          
          // 文章标题可能在Articles数组或直接在字段里
          if (decryptedBody.Articles && decryptedBody.Articles.item) {
            const articles = Array.isArray(decryptedBody.Articles.item) 
              ? decryptedBody.Articles.item 
              : [decryptedBody.Articles.item];
            articleTitle = articles[0]?.Title || articles[0]?.title;
          } else if (decryptedBody.PublishStatusEvent?.ArticleId) {
            articleTitle = '文章' + decryptedBody.PublishStatusEvent.ArticleId;
          }
          
          if (!mediaId) {
            console.error('未获取到MediaId，原始数据:', decryptedBody);
            return res.send('success'); // 微信要求返回success
          }
          
          console.log(`处理文章: ${articleTitle}, MediaId: ${mediaId}`);
          
          // 4. 获取Token
          const [weworkToken, wechatToken] = await Promise.all([
            getWeworkToken(),
            getWechatToken()
          ]);
          console.log('Token获取成功');
          
          // 5. 生成活码
          const qrCode = await generateContactWay(weworkToken, articleTitle || '未命名', mediaId);
          console.log('活码生成成功:', qrCode);
          
          // 6. 更新文章阅读原文
          await updateArticle(wechatToken, mediaId, articleTitle || '未命名', qrCode);
          console.log('文章更新成功');
        }
      }
      
      // 7. 给微信返回success（必须返回，否则微信会重试）
      // 如果处于加密模式，应该返回加密的成功消息，但微信也接受明文success
      return res.send('success');
    }
    
    res.json({ errcode: 0, errmsg: 'ok' });
    
  } catch (error) {
    console.error('处理失败:', error);
    // 即使出错也要返回success，避免微信无限重试
    res.send('success');
  }
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    time: new Date().toISOString(),
    sdk: 'wx-server-sdk',
    hasAesKey: !!CONFIG.ENCODING_AES_KEY
  });
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('使用 SDK: wx-server-sdk');
  console.log('支持XML解密:', !!CONFIG.ENCODING_AES_KEY ? '是' : '否（明文模式）');
});
