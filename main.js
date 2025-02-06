import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const cheerio = require('cheerio');

dotenv.config();

const app = express();
app.use(express.json({ limit: '20mb' }));

const PROXY_URL = process.env.PROXY_URL;
const PROXY_PORT = Number(process.env.PROXY_PORT);

const DEEPSEEK_R1_API_KEY = process.env.DEEPSEEK_R1_API_KEY;
const DEEPSEEK_R1_MODEL = process.env.DEEPSEEK_R1_MODEL;
const DEEPSEEK_R1_MAX_TOKENS = Number(process.env.DEEPSEEK_R1_MAX_TOKENS);
const DEEPSEEK_R1_CONTEXT_WINDOW = Number(process.env.DEEPSEEK_R1_CONTEXT_WINDOW);
const DEEPSEEK_R1_TEMPERATURE = Number(process.env.DEEPSEEK_R1_TEMPERATURE);

const Model_output_API_KEY = process.env.Model_output_API_KEY;
const Model_output_MODEL = process.env.Model_output_MODEL;
const Model_output_MAX_TOKENS = Number(process.env.Model_output_MAX_TOKENS);
const Model_output_CONTEXT_WINDOW = Number(process.env.Model_output_CONTEXT_WINDOW);
const Model_output_TEMPERATURE = Number(process.env.Model_output_TEMPERATURE);
const Model_output_WebSearch = process.env.Model_output_WebSearch === 'True';

const RELAY_PROMPT = process.env.RELAY_PROMPT;
const HYBRID_MODEL_NAME = process.env.HYBRID_MODEL_NAME || 'GeminiMIXR1';
const OUTPUT_API_KEY = process.env.OUTPUT_API_KEY;

const Image_Model_API_KEY = process.env.Image_Model_API_KEY;
const Image_MODEL = process.env.Image_MODEL;
const Image_Model_MAX_TOKENS = Number(process.env.Image_Model_MAX_TOKENS);
const Image_Model_CONTEXT_WINDOW = Number(process.env.Image_Model_CONTEXT_WINDOW);
const Image_Model_TEMPERATURE = Number(process.env.Image_Model_TEMPERATURE);
const Image_Model_PROMPT = process.env.Image_Model_PROMPT;
const Image_SendR1_PROMPT = process.env.Image_SendR1_PROMPT;

// 添加新的环境变量
const GoogleSearch_API_KEY = process.env.GoogleSearch_API_KEY;
const GoogleSearch_MODEL = process.env.GoogleSearch_MODEL;
const GoogleSearch_Model_MAX_TOKENS = Number(process.env.GoogleSearch_Model_MAX_TOKENS);
const GoogleSearch_Model_CONTEXT_WINDOW = Number(process.env.GoogleSearch_Model_CONTEXT_WINDOW);
const GoogleSearch_Model_TEMPERATURE = Number(process.env.GoogleSearch_Model_TEMPERATURE);
const GoogleSearch_Determine_PROMPT = process.env.GoogleSearch_Determine_PROMPT;
const GoogleSearch_PROMPT = process.env.GoogleSearch_PROMPT;
const GoogleSearch_Send_PROMPT = process.env.GoogleSearch_Send_PROMPT;

// 用于存储当前任务的信息
let currentTask = null;

// 添加URL内容缓存
const urlContentCache = new Map();

// 添加一个用于存储所有活动请求的数组
let activeRequests = [];

// 添加URL内容解析函数
async function parseUrlContent(url) {
    // 检查缓存
    if (urlContentCache.has(url)) {
        console.log('使用缓存的URL内容:', url);
        return urlContentCache.get(url);
    }

    console.log('开始解析URL内容:', url);
    try {
        // 使用通用的请求头
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        };

        const response = await axios.get(url, {
            headers,
            timeout: 10000,
            maxRedirects: 5,
            validateStatus: status => status < 400
        });

        const $ = cheerio.load(response.data);

        // 1. 移除所有干扰元素
        const removeSelectors = [
            'script', 'style', 'iframe', 'video',
            'header', 'footer', 'nav', 'aside',
            '[class*="banner"]', '[class*="advert"]', '[class*="ads"]',
            '[class*="cookie"]', '[class*="popup"]', '[id*="banner"]',
            '[id*="advert"]', '[id*="ads"]', '[class*="share"]',
            '[class*="social"]', '[class*="comment"]', '[class*="related"]'
        ];
        removeSelectors.forEach(selector => $(selector).remove());

        // 2. 智能识别主要内容区域
        let mainContent = '';
        
        // 2.1 首先尝试查找文章标题
        const possibleTitles = $('h1').first().text().trim() || 
                             $('[class*="title"]').first().text().trim() ||
                             $('title').text().trim();

        // 2.2 查找最可能的主要内容容器
        const contentSelectors = [
            'article', '[class*="article"]', '[class*="post"]',
            '[class*="content"]', 'main', '#main',
            '.text', '.body', '.entry'
        ];

        let $mainContainer = null;
        let maxTextLength = 0;

        // 遍历所有可能的内容容器,找到文本最多的那个
        contentSelectors.forEach(selector => {
            $(selector).each((_, element) => {
                const $element = $(element);
                const textLength = $element.text().trim().length;
                if (textLength > maxTextLength) {
                    maxTextLength = textLength;
                    $mainContainer = $element;
                }
            });
        });

        // 2.3 如果找到了主容器,提取其中的段落文本
        if ($mainContainer) {
            const paragraphs = [];
            $mainContainer.find('p, h2, h3, h4, li').each((_, element) => {
                const text = $(element).text().trim();
                if (text && text.length > 20) { // 只保留有意义的段落
                    paragraphs.push(text);
                }
            });
            mainContent = paragraphs.join('\n\n');
        }

        // 2.4 如果主容器没有足够的内容,回退到全文检索
        if (mainContent.length < 100) {
            const bodyText = [];
            $('body').find('p, h2, h3, h4, li').each((_, element) => {
                const text = $(element).text().trim();
                if (text && text.length > 20) {
                    bodyText.push(text);
                }
            });
            mainContent = bodyText.join('\n\n');
        }

        // 3. 清理和格式化文本
        let content = mainContent
            .replace(/\s+/g, ' ')
            .replace(/\n\s*\n/g, '\n\n')
            .replace(/([.!?])\s+/g, '$1\n')  // 在句子结尾添加换行
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        // 4. 添加标题(如果找到了)
        if (possibleTitles) {
            content = `${possibleTitles}\n\n${content}`;
        }

        // 5. 限制长度
        const maxLength = 8000;
        if (content.length > maxLength) {
            content = content.substring(0, maxLength) + '...';
        }

        // 6. 验证内容质量
        if (!content || content.length < 50 || 
            /404|error|not found|访问受限|无权访问|请稍后重试/.test(content)) {
            throw new Error('未能提取到有效内容');
        }

        // 7. 格式化最终输出
        const formattedContent = `[以下是来自 ${url} 的网页内容]\n${content}\n[网页内容结束]`;
        
        // 存入缓存
        urlContentCache.set(url, formattedContent);
        
        console.log('成功解析URL内容,长度:', content.length);
        return formattedContent;
        
    } catch (error) {
        console.error('URL内容解析失败:', error);
        return `[无法获取 ${url} 的内容: ${error.message}。这可能是因为该网站有访问限制或内容不可用。]`;
    }
}

// API 密钥验证中间件
const apiKeyAuth = (req, res, next) => {
    const apiKey = req.headers.authorization;

    if (!apiKey || apiKey !== `Bearer ${OUTPUT_API_KEY}`) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid API key' });
    }
    next();
};

// 添加一个用于简化日志输出的辅助函数
function sanitizeLogContent(content) {
    if (Array.isArray(content)) {
        return content.map(item => {
            if (item.type === 'image_url' && item.image_url?.url) {
                return {
                    ...item,
                    image_url: {
                        ...item.image_url,
                        url: item.image_url.url.substring(0, 20) + '...[base64]...'
                    }
                };
            }
            return item;
        });
    }
    return content;
}

// 简化的取消任务函数
function cancelCurrentTask() {
    if (!currentTask) {
        return;
    }

    console.log('收到新请求，取消当前任务...');
    
    try {
        // 1. 取消所有进行中的 API 请求
        activeRequests.forEach(request => {
            if (request.cancelTokenSource) {
                request.cancelTokenSource.cancel('收到新请求');
                console.log(`已取消 ${request.modelType} 的请求`);
            }
        });
        
        // 2. 结束当前响应流
        if (currentTask.res && !currentTask.res.writableEnded) {
            currentTask.res.write('data: {"choices": [{"delta": {"content": "\n\n[收到新请求，开始重新生成]"}, "index": 0, "finish_reason": "stop"}]}\n\n');
            currentTask.res.write('data: [DONE]\n\n');
            currentTask.res.end();
        }

        // 3. 确保取消当前任务的 cancelToken
        if (currentTask.cancelTokenSource) {
            currentTask.cancelTokenSource.cancel('收到新请求');
        }
        
        // 4. 清理资源
        activeRequests = [];
        currentTask = null;

    } catch (error) {
        console.error('取消任务时出错:', error);
        activeRequests = [];
        currentTask = null;
    }
}

// 修改主请求处理函数
app.post('/v1/chat/completions', apiKeyAuth, async (req, res) => {
    // 确保取消之前的任务
    if (currentTask) {
        console.log('存在正在进行的任务，准备取消...');
        cancelCurrentTask();
        // 等待一小段时间确保清理完成
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log('开始处理新请求...');
    
    // 创建新任务
    const cancelTokenSource = axios.CancelToken.source();
    currentTask = { 
        res,
        cancelTokenSource
    };

    try {
        const originalRequest = req.body;
        let messages = [...originalRequest.messages];
        
        // 检查模型
        const requestedModel = originalRequest.model;
        if (requestedModel !== HYBRID_MODEL_NAME) {
            throw new Error(`Model not supported: ${requestedModel}`);
        }

        try {
            // 预处理阶段
            let searchResults = null;
            let image_index_content = null;

            // 并行执行预处理任务
            const preprocessTasks = [];

            // 检查新图片
            if (hasNewImages(messages)) {
                console.log('发现新图片，开始处理');
                const images = extractLastImages(messages);
                const imageTask = Promise.all(
                    images.map(img => processImage(img))
                ).then(descriptions => {
                    image_index_content = descriptions.join('\n');
                });
                preprocessTasks.push(imageTask);
            }

            // 判断是否需要联网搜索
            const searchTask = determineIfSearchNeeded(messages).then(async needSearch => {
                if (needSearch) {
                    console.log('需要联网搜索，开始执行搜索');
                    searchResults = await performWebSearch(messages);
                }
            });
            preprocessTasks.push(searchTask);

            // 等待所有预处理任务完成
            await Promise.all(preprocessTasks);

            // 准备发送给 R1 的消息
            let messagesForR1 = [
                ...messages,
                ...(searchResults ? [{
                    role: 'system',
                    content: `${process.env.GoogleSearch_Send_PROMPT}${searchResults}`
                }] : []),
                ...(image_index_content ? [{
                    role: 'system',
                    content: `${process.env.Image_SendR1_PROMPT}${image_index_content}`
                }] : []),
                { 
                    role: "system", 
                    content: process.env.Think_Lora_PROMPT 
                }
            ];

            // R1 请求
            const r1CancelToken = axios.CancelToken.source();
            activeRequests.push({ 
                modelType: 'R1', 
                cancelTokenSource: r1CancelToken 
            });

            const deepseekResponse = await axios.post(
                `${PROXY_URL}/v1/chat/completions`,
                {
                    model: DEEPSEEK_R1_MODEL,
                    messages: messagesForR1,
                    max_tokens: DEEPSEEK_R1_MAX_TOKENS,
                    temperature: DEEPSEEK_R1_TEMPERATURE,
                    stream: true,
                },
                {
                    headers: {
                        Authorization: `Bearer ${DEEPSEEK_R1_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    responseType: 'stream',
                    cancelToken: r1CancelToken.token,
                    timeout: 30000,
                    'axios-retry': {
                        retries: 3,
                        retryDelay: (retryCount) => retryCount * 1000,
                        retryCondition: (error) => {
                            return (
                                axios.isNetworkError(error) ||
                                error.code === 'ECONNABORTED' ||
                                error.response?.status === 429 ||
                                error.response?.status >= 500
                            );
                        }
                    }
                }
            ).catch(async error => {
                console.error('R1 请求失败:', error.message);
                
                // 如果响应已经发送或结束，直接返回
                if (res.headersSent || res.writableEnded) {
                    throw error;
                }

                // 切换到 Gemini
                console.log('切换到 Gemini 模型');
                const geminiCancelToken = axios.CancelToken.source();
                
                const geminiMessages = [
                    ...messages,
                    ...(searchResults ? [{
                        role: 'system',
                        content: `${process.env.GoogleSearch_Send_PROMPT}${searchResults}`
                    }] : []),
                    { 
                        role: 'system', 
                        content: '由于前置思考系统暂时无法使用，请直接进行回复。请注意，你可以看到所有的搜索结果和图片内容。' 
                    }
                ];

                try {
                    // 直接返回，不继续执行后面的 deepseekResponse.data 相关代码
                    return await callGemini(geminiMessages, res, geminiCancelToken, originalRequest);
                } catch (geminiError) {
                    console.error('Gemini 也失败了:', geminiError);
                    if (!res.headersSent && !res.writableEnded) {
                        res.status(503).json({
                            error: 'Service unavailable',
                            message: '服务暂时不可用，请稍后重试'
                        });
                    }
                    throw geminiError;
                }
            });

            // 只有在 R1 请求成功时才执行这部分代码
            if (deepseekResponse) {
                let thinkingContent = '';
                let receivedThinkingEnd = false;
                let choiceIndex = 0;
                let geminiResponseSent = false;
                let thinkTagSent = false;

                deepseekResponse.data.on('data', (chunk) => {
                    setTimeout(() => {
                        const chunkStr = chunk.toString();
                        
                        // 修改日志输出方式
                        try {
                            if (chunkStr.trim() === 'data: [DONE]') {
                                return;
                            }
                            const deepseekData = JSON.parse(chunkStr.replace(/^data: /, ''));
                            
                            // 只输出实际的内容变化
                            const reasoningContent = deepseekData.choices[0]?.delta?.reasoning_content;
                            if (reasoningContent) {
                                process.stdout.write(reasoningContent); // 使用 process.stdout.write 实现流式输出
                            }

                            // 构造 OpenAI 格式的 SSE 消息
                            const formattedData = {
                                id: deepseekData.id,
                                object: 'chat.completion.chunk',
                                created: deepseekData.created,
                                model: HYBRID_MODEL_NAME,
                                choices: deepseekData.choices.map((choice, index) => {
                                    let deltaContent = choice.delta.reasoning_content;
                                    if (!deltaContent) {
                                        deltaContent = "";
                                    }
                                    return {
                                        delta: {
                                            content: deltaContent,
                                        },
                                        index: index,
                                        finish_reason: choice.finish_reason,
                                    };
                                }),
                            };

                            if (formattedData.choices[0].delta.content) { // 仅当 delta 中有内容时才发送
                                if (!geminiResponseSent && !thinkTagSent) { // 检查 Gemini 响应是否已发送和 thinkTagSent 标志位
                                    formattedData.choices[0].delta.content = "<think>AiModel辅助思考系统已载入。" + formattedData.choices[0].delta.content; // 添加 <think> 标签
                                    thinkTagSent = true; // 设置 thinkTagSent 为 true
                                }
                                res.write(`data: ${JSON.stringify(formattedData)}\n\n`);
                            }

                            if (!receivedThinkingEnd) {
                                const reasoningContent = deepseekData.choices[0]?.delta?.reasoning_content || '';
                                thinkingContent += reasoningContent;
                                
                                // 只在 reasoning_content 结束时输出一次完整的思考内容
                                if (!reasoningContent && thinkingContent !== '') {
                                    console.log('\n\nR1 思考完成，完整内容：\n', thinkingContent, '\n');
                                    receivedThinkingEnd = true;
                                    
                                    // 1. 首先取消 R1 的生成请求
                                    try {
                                        // 使用 axios 的 CancelToken 来取消请求
                                        r1CancelToken.cancel('Reasoning content finished');
                                        console.log('已发送取消请求给 R1 服务器');
                                    } catch (cancelError) {
                                        console.error('取消 R1 请求时出错:', cancelError);
                                    }
                                    
                                    // 2. 然后关闭数据流
                                    deepseekResponse.data.destroy();
                                    
                                    // 3. 为 Gemini 创建新的 cancelToken
                                    const geminiCancelToken = axios.CancelToken.source();
                                    
                                    // 4. 继续后续的 Gemini 调用
                                    const geminiMessages = [
                                        ...messages,
                                        ...(searchResults ? [{
                                            role: 'system',
                                            content: `${process.env.GoogleSearch_Send_PROMPT}${searchResults}`
                                        }] : []),
                                        { 
                                            role: 'assistant', 
                                            content: thinkingContent 
                                        },
                                        { 
                                            role: 'user', 
                                            content: RELAY_PROMPT 
                                        }
                                    ];

                                    // 在 Gemini 请求发起时添加到活动请求列表
                                    activeRequests.push({ 
                                        modelType: 'Gemini', 
                                        cancelTokenSource: geminiCancelToken 
                                    });

                                    axios.post(
                                        `${process.env.PROXY_URL2}/v1/chat/completions`,
                                        {
                                            model: Model_output_MODEL,
                                            messages: geminiMessages,
                                            max_tokens: Model_output_MAX_TOKENS,
                                            temperature: Model_output_TEMPERATURE,
                                            stream: true,
                                        },
                                        {
                                            headers: {
                                                Authorization: `Bearer ${Model_output_API_KEY}`,
                                                'Content-Type': 'application/json',
                                            },
                                            responseType: 'stream',
                                            cancelToken: geminiCancelToken.token, // 使用新的 cancelToken
                                            timeout: 30000,
                                            'axios-retry': {
                                                retries: 3,
                                                retryDelay: (retryCount) => retryCount * 1000,
                                                retryCondition: (error) => {
                                                    return (
                                                        axios.isNetworkError(error) ||
                                                        error.code === 'ECONNABORTED' ||
                                                        error.response?.status === 429 ||
                                                        error.response?.status >= 500
                                                    );
                                                }
                                            },
                                        }
                                    ).then(geminiResponse => {
                                        console.log('Gemini API call successful - from Deepseek flow'); // 修改日志
                                        console.log('Gemini API request config:', geminiResponse.config); // 打印请求配置
                                        console.log('Gemini API response data:', geminiResponse.data); // 打印响应数据
                                        geminiResponseSent = true; // 标记 Gemini 响应已发送
                                        res.write('data: {"choices": [{"delta": {"content": "\\n辅助思考已结束，以上辅助思考内容用户不可见，请MODEL开始以中文作为主要语言进行正式输出</think>"}, "index": 0, "finish_reason": null}]}\n\n'); // 输出 </think> 标签
                                        geminiResponse.data.on('data', chunk => {
                                            try {
                                                const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
                                                for (const line of lines) {
                                                    if (line.startsWith('data: ')) {
                                                        // 检查是否是 [DONE] 信号
                                                        if (line.includes('[DONE]')) {
                                                            continue;
                                                        }
                                                        
                                                        try {
                                                            const data = JSON.parse(line.slice(6));
                                                            const content = data.choices[0]?.delta?.content || '';
                                                            if (content) {
                                                                const formattedChunk = {
                                                                    id: `chatcmpl-${Date.now()}`,
                                                                    object: 'chat.completion.chunk',
                                                                    created: Math.floor(Date.now() / 1000),
                                                                    model: HYBRID_MODEL_NAME,
                                                                    choices: [{
                                                                        delta: { content },
                                                                        index: choiceIndex++,
                                                                        finish_reason: null
                                                                    }]
                                                                };
                                                                res.write(`data: ${JSON.stringify(formattedChunk)}\n\n`);
                                                            }
                                                        } catch (parseError) {
                                                            // 忽略 [DONE] 和其他非 JSON 数据的解析错误
                                                            if (!line.includes('[DONE]')) {
                                                                console.error('Error parsing chunk data:', parseError);
                                                            }
                                                        }
                                                    }
                                                }
                                            } catch (error) {
                                                console.error('Error processing chunk:', error);
                                            }
                                        });

                                        // 修改结束处理
                                        geminiResponse.data.on('end', () => {
                                            console.log('\n\nGemini response ended.'); // 添加换行使输出更清晰
                                            res.write('data: [DONE]\n\n');
                                            if (!res.writableEnded) {
                                                res.end();
                                            }
                                            currentTask = null;
                                            removeActiveRequest('Gemini');
                                        });

                                        geminiResponse.data.on('error', (error) => {
                                            console.error('Gemini response error:', error);
                                            if (!res.writableEnded) {
                                                res.end();
                                            }
                                            currentTask = null;
                                            removeActiveRequest('Gemini');
                                        });
                                    }).catch(error => {
                                        console.error('Gemini API call error:', error);
                                        console.error('Gemini API request config:', error.config);
                                        console.error('Gemini API response data:', error.response?.data);
                                        
                                        if (!res.writableEnded) {
                                            let errorMessage = 'Error calling Gemini API';
                                            if (error.code === 'ECONNABORTED') {
                                                errorMessage = 'Gemini API request timed out.';
                                                res.status(504).send({ error: errorMessage }); // 504 Gateway Timeout
                                            } else if (error.response?.status === 429) {
                                                errorMessage = 'Gemini API rate limit exceeded.';
                                                res.status(429).send({ error: errorMessage, details: error.response?.data }); // 429 Too Many Requests
                                            } else if (error.config?.__retryCount >= 3) { // 假设重试 3 次后失败
                                                errorMessage = 'Gemini API request failed after multiple retries.';
                                                console.log('返回 503 错误 - callGemini 函数中，Gemini API 多次重试失败'); // 添加日志
                                                res.status(503).send({ error: errorMessage }); // 503 Service Unavailable
                                            }
                                            else {
                                                res.status(error.response?.status || 500).send({ error: `${errorMessage}: ${error.message}`, details: error.response?.data?.message || error.response?.data }); // 500 Internal Server Error 或 Gemini 返回的状态码, 只发送 message 或 简化的 data
                                            }
                                            res.end(); // 确保在 Gemini API 错误时也结束响应
                                        }
                                        currentTask = null;
                                        removeActiveRequest('Gemini');
                                    });
                                }
                            }
                        } catch (error) {
                            console.error('Error parsing Deepseek R1 chunk:', error);
                        }
                    }, 600);
                });

                deepseekResponse.data.on('end', () => {
                    console.log('Deepseek response ended. receivedThinkingEnd:', receivedThinkingEnd);
                    removeActiveRequest('R1');
                    if (!geminiResponseSent && !res.writableEnded) {
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }
                    currentTask = null;
                });

                deepseekResponse.data.on('error', async (error) => {
                    // 如果是取消请求导致的错误，只输出简单日志
                    if (axios.isCancel(error)) {
                        console.log('R1 请求已取消:', error.message);
                        return;
                    }

                    // 其他错误继续原有的处理逻辑
                    console.error('Deepseek R1 请求出错:', error);
                    
                    if (error.code === 'ECONNRESET' || error.code === 'ECONNABORTED') {
                        if (!geminiResponseSent && !res.headersSent && !res.writableEnded) {
                            // 为 Gemini 创建新的 cancelToken
                            const geminiCancelToken = axios.CancelToken.source();
                            
                            const geminiMessages = [
                                ...messages,
                                ...(searchResults ? [{
                                    role: 'system',
                                    content: `${process.env.GoogleSearch_Send_PROMPT}${searchResults}`
                                }] : []),
                                { 
                                    role: 'system', 
                                    content: '由于前置思考系统连接中断，请直接进行回复。请注意，你可以看到所有的搜索结果和图片内容。' 
                                }
                            ];

                            try {
                                await callGemini(geminiMessages, res, geminiCancelToken, originalRequest);
                            } catch (geminiError) {
                                console.error('Both R1 and Gemini failed:', geminiError);
                                if (!res.headersSent && !res.writableEnded) {
                                    res.status(500).json({
                                        error: 'Connection interrupted',
                                        message: '网络连接中断，请重新发送请求'
                                    });
                                }
                            }
                        }
                        
                        if (currentTask) {
                            currentTask.cancelTokenSource.cancel('Connection interrupted');
                            currentTask = null;
                        }
                        
                        return;
                    }
                });
            }
        } catch (error) {
            console.error('请求处理错误:', error);
            if (!res.headersSent && !res.writableEnded) {
                res.status(500).json({
                    error: 'Internal server error',
                    message: error.message
                });
            }
            currentTask = null;
        }
    } catch (error) {
        console.error('请求处理错误:', error);
        if (!res.headersSent && !res.writableEnded) {
            res.status(500).json({
                error: 'Internal server error',
                message: error.message
            });
        }
        currentTask = null;
    }
});

// 修改 callGemini 函数
function callGemini(messages, res, cancelTokenSource, originalRequest) {
    return new Promise((resolve, reject) => {
        let choiceIndex = 0;
        
        const makeRequest = async () => {
            try {
                // 检查响应是否已经发送
                if (res.headersSent || res.writableEnded) {
                    console.log('响应已经发送，取消 Gemini 请求');
                    return;
                }

                // 准备请求配置
                const requestConfig = {
                    model: Model_output_MODEL,
                    messages: messages,
                    max_tokens: Model_output_MAX_TOKENS,
                    temperature: Model_output_TEMPERATURE,
                    stream: true,
                };

                // 如果启用了 WebSearch，添加 function calling 配置
                if (Model_output_WebSearch) {
                    requestConfig.tools = [{
                        type: "function",
                        function: {
                            name: "googleSearch",
                            description: "Search the web for relevant information",
                            parameters: {
                                type: "object",
                                properties: {
                                    query: {
                                        type: "string",
                                        description: "The search query"
                                    }
                                },
                                required: ["query"]
                            }
                        }
                    }];
                }

                const geminiResponse = await axios.post(
                    `${process.env.PROXY_URL2}/v1/chat/completions`,
                    requestConfig,
                    {
                        headers: {
                            Authorization: `Bearer ${Model_output_API_KEY}`,
                            'Content-Type': 'application/json',
                        },
                        responseType: 'stream',
                        cancelToken: cancelTokenSource.token,
                        timeout: 30000,
                        'axios-retry': {
                            retries: 3,
                            retryDelay: (retryCount) => retryCount * 1000,
                            retryCondition: (error) => {
                                return (
                                    axios.isNetworkError(error) ||
                                    error.code === 'ECONNABORTED' ||
                                    error.response?.status === 429 ||
                                    error.response?.status >= 500
                                );
                            }
                        }
                    }
                );

                console.log('Gemini 请求成功');

                // 处理响应流
                geminiResponse.data.on('data', chunk => {
                    try {
                        // 再次检查响应状态
                        if (res.writableEnded) {
                            console.log('响应已结束，停止处理数据');
                            return;
                        }

                        const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                if (line.includes('[DONE]')) continue;
                                
                                const data = JSON.parse(line.slice(6));
                                
                                // 处理 function calling 的响应
                                if (data.choices[0]?.delta?.tool_calls) {
                                    const toolCalls = data.choices[0].delta.tool_calls;
                                    console.log('收到 function calling 请求:', JSON.stringify(toolCalls));
                                    // 这里可以添加处理 function calling 的逻辑
                                    continue;
                                }
                                
                                const content = data.choices[0]?.delta?.content || '';
                                if (content) {
                                    const formattedChunk = {
                                        id: `chatcmpl-${Date.now()}`,
                                        object: 'chat.completion.chunk',
                                        created: Math.floor(Date.now() / 1000),
                                        model: HYBRID_MODEL_NAME,
                                        choices: [{
                                            delta: { content },
                                            index: choiceIndex++,
                                            finish_reason: null
                                        }]
                                    };
                                    res.write(`data: ${JSON.stringify(formattedChunk)}\n\n`);
                                }
                            }
                        }
                    } catch (error) {
                        console.error('处理数据块时出错:', error);
                    }
                });

                geminiResponse.data.on('end', () => {
                    if (!res.writableEnded) {
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }
                    resolve();
                });

                geminiResponse.data.on('error', error => {
                    console.error('Gemini 流错误:', error);
                    reject(error);
                });

            } catch (error) {
                console.error('Gemini 请求错误:', error);
                reject(error);
            }
        };

        makeRequest().catch(reject);
    });
}

// 处理图片识别的函数
async function processImage(imageMessage) {
    // 创建用于日志的安全版本
    const logSafeImageMessage = {
        ...imageMessage,
        image_url: imageMessage.image_url ? {
            ...imageMessage.image_url,
            url: imageMessage.image_url.url.substring(0, 20) + '...[base64]...'
        } : imageMessage.image_url
    };
    console.log('开始处理图片:', JSON.stringify(logSafeImageMessage, null, 2));
    
    try {
        const requestBody = {
            model: Image_MODEL,
            messages: [
                { role: "system", content: Image_Model_PROMPT },
                { role: "user", content: [imageMessage] }  // 保持原始数据用于实际请求
            ],
            max_tokens: Image_Model_MAX_TOKENS,
            temperature: Image_Model_TEMPERATURE,
            stream: false,
        };
        
        // 创建用于日志的安全版本
        const logSafeRequestBody = {
            ...requestBody,
            messages: requestBody.messages.map(msg => ({
                ...msg,
                content: Array.isArray(msg.content) 
                    ? msg.content.map(item => {
                        if (item.type === 'image_url' && item.image_url?.url) {
                            return {
                                ...item,
                                image_url: {
                                    ...item.image_url,
                                    url: item.image_url.url.substring(0, 20) + '...[base64]...'
                                }
                            };
                        }
                        return item;
                    })
                    : msg.content
            }))
        };
        
        console.log('发送给图像识别模型的请求:', JSON.stringify(logSafeRequestBody, null, 2));
        
        const response = await axios.post(
            `${process.env.PROXY_URL3}/v1/chat/completions`,
            requestBody,  // 使用原始数据发送请求
            {
                headers: {
                    Authorization: `Bearer ${Image_Model_API_KEY}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        
        console.log('图像识别模型响应:', JSON.stringify(response.data, null, 2));
        
        const content = response.data.choices[0].message.content;
        console.log('图片描述结果:', content);
        return content;
    } catch (error) {
        console.error('图片处理错误:', error);
        console.error('错误详情:', {
            message: error.message,
            response: error.response?.data,
            config: {
                ...error.config,
                data: error.config?.data ? JSON.parse(error.config.data).messages.map(msg => ({
                    ...msg,
                    content: Array.isArray(msg.content) 
                        ? msg.content.map(item => {
                            if (item.type === 'image_url' && item.image_url?.url) {
                                return {
                                    ...item,
                                    image_url: {
                                        ...item.image_url,
                                        url: item.image_url.url.substring(0, 20) + '...[base64]...'
                                    }
                                };
                            }
                            return item;
                        })
                        : msg.content
                })) : error.config?.data
            }
        });
        throw error;
    }
}

// 检查消息是否包含本轮新的图片
function hasNewImages(messages) {
    const logSafeMessages = messages.map(msg => ({
        ...msg,
        content: sanitizeLogContent(msg.content)
    }));
    console.log('检查新图片 - 完整消息:', JSON.stringify(logSafeMessages, null, 2));
    const lastMessage = messages[messages.length - 1];
    const hasImages = lastMessage && Array.isArray(lastMessage.content) && 
                     lastMessage.content.some(item => item.type === 'image_url');
    console.log('是否包含新图片:', hasImages); // 添加日志
    return hasImages;
}

// 提取最后一条消息中的图片
function extractLastImages(messages) {
    const lastMessage = messages[messages.length - 1];
    const logSafeMessage = {
        ...lastMessage,
        content: sanitizeLogContent(lastMessage.content)
    };
    console.log('提取图片 - 最后一条消息:', JSON.stringify(logSafeMessage, null, 2));
    if (!lastMessage || !Array.isArray(lastMessage.content)) {
        console.log('没有找到图片消息');
        return [];
    }
    const images = lastMessage.content.filter(item => item.type === 'image_url');
    // 创建用于日志的安全版本
    const logSafeImages = images.map(img => ({
        ...img,
        image_url: img.image_url ? {
            ...img.image_url,
            url: img.image_url.url.substring(0, 20) + '...[base64]...'
        } : img.image_url
    }));
    console.log('提取到的图片:', JSON.stringify(logSafeImages, null, 2));
    return images;
}

// 添加判断是否需要联网搜索的函数
async function determineIfSearchNeeded(messages) {
    console.log('开始判断是否需要联网搜索');
    try {
        const response = await axios.post(
            `${process.env.PROXY_URL4}/v1/chat/completions`,
            {
                model: process.env.SearchDetermine_MODEL, // 改用新的小模型
                messages: [
                    { role: "system", content: process.env.GoogleSearch_Determine_PROMPT },
                    ...messages
                ],
                max_tokens: Number(process.env.SearchDetermine_Model_MAX_TOKENS), // 使用对应的参数
                temperature: Number(process.env.SearchDetermine_Model_TEMPERATURE), // 使用对应的参数
                stream: false,
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.SearchDetermine_API_KEY}`, // 使用对应的API密钥
                    'Content-Type': 'application/json',
                }
            }
        );

        const decision = response.data.choices[0].message.content.trim().toLowerCase();
        console.log('联网判断结果:', decision);
        return decision === 'yes';
    } catch (error) {
        console.error('联网判断出错:', error);
        return false;
    }
}

// 添加执行联网搜索的函数
async function performWebSearch(messages) {
    console.log('开始执行联网搜索');
    try {
        // 第一步：获取搜索关键词
        const searchTermsResponse = await axios.post(
            `${process.env.PROXY_URL4}/v1/chat/completions`,
            {
                model: GoogleSearch_MODEL,
                messages: [
                    { role: "system", content: GoogleSearch_PROMPT },
                    ...messages
                ],
                max_tokens: GoogleSearch_Model_MAX_TOKENS,
                temperature: GoogleSearch_Model_TEMPERATURE,
                stream: false
            },
            {
                headers: {
                    Authorization: `Bearer ${GoogleSearch_API_KEY}`,
                    'Content-Type': 'application/json',
                }
            }
        );

        const searchTerms = searchTermsResponse.data.choices[0].message.content;
        console.log('搜索关键词:', searchTerms);

        // 第二步：执行实际的搜索
        const searchResponse = await axios.post(
            `${process.env.PROXY_URL4}/v1/chat/completions`,
            {
                model: GoogleSearch_MODEL,
                messages: [
                    { role: "system", content: "Please search the web for the following query and provide relevant information:" },
                    { role: "user", content: searchTerms }
                ],
                max_tokens: GoogleSearch_Model_MAX_TOKENS,
                temperature: GoogleSearch_Model_TEMPERATURE,
                stream: false,
                tools: [{
                    type: "function",
                    function: {
                        name: "googleSearch",
                        description: "Search the web for relevant information",
                        parameters: {
                            type: "object",
                            properties: {
                                query: {
                                    type: "string",
                                    description: "The search query"
                                }
                            },
                            required: ["query"]
                        }
                    }
                }],
                tool_choice: {
                    type: "function",
                    function: {
                        name: "googleSearch"
                    }
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${GoogleSearch_API_KEY}`,
                    'Content-Type': 'application/json',
                }
            }
        );

        const searchResults = searchResponse.data.choices[0].message.content;
        console.log('搜索结果:', searchResults);
        return searchResults;
    } catch (error) {
        console.error('联网搜索出错:', error);
        console.error('错误详情:', {
            message: error.message,
            response: error.response?.data,
            config: error.config
        });
        return null;
    }
}

// 添加正确的 removeActiveRequest 函数
function removeActiveRequest(modelType) {
    activeRequests = activeRequests.filter(req => req.modelType !== modelType);
    console.log(`${modelType} 请求已完成，从活动请求列表中移除`);
}

app.listen(PROXY_PORT, () => {
    console.log(`Hybrid AI proxy server started on port ${PROXY_PORT}`);
});
