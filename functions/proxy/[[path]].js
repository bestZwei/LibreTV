// functions/proxy/[[path]].js

// --- 配置 (读取自 config.js，这里为了独立运行先定义) ---
// 注意：在实际Pages Function环境中，我们无法直接 `import config.js`
// 所以需要将必要的配置硬编码或通过环境变量传入。这里我们硬编码。
const FUNCTION_CONFIG = {
    CACHE_TTL: 86400, // 24 hours
    MAX_RECURSION: 5,
    FILTER_DISCONTINUITY: true, // 是否过滤M3U8中的 #EXT-X-DISCONTINUITY
    USER_AGENTS: [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
    ],
    DEBUG: false // 改成 true 可以在 Cloudflare Functions 日志看到更多信息
};

const MEDIA_FILE_EXTENSIONS = [
    '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.f4v', '.m4v', '.3gp', '.3g2', '.ts', '.mts', '.m2ts',
    '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.alac', '.aiff', '.opus',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg', '.avif', '.heic'
];
const MEDIA_CONTENT_TYPES = ['video/', 'audio/', 'image/'];
// --- 配置结束 ---


/**
 * 主要的 Pages Function 处理函数
 * 拦截发往 /proxy/* 的请求
 */
export async function onRequest(context) {
    const { request, env, next, waitUntil } = context; // next 和 waitUntil 可能需要
    const url = new URL(request.url);

    // --- 辅助函数 (大部分从 workers1.js 适配过来) ---

    // 输出调试日志 (需要设置 DEBUG: true)
    function logDebug(message) {
        if (FUNCTION_CONFIG.DEBUG) {
            console.log(`[Proxy Func] ${message}`);
        }
    }

    // 从请求路径中提取目标 URL
    function getTargetUrlFromPath(pathname) {
        // 路径格式: /proxy/经过编码的URL
        // 例如: /proxy/https%3A%2F%2Fexample.com%2Fplaylist.m3u8
        const encodedUrl = pathname.replace(/^\/proxy\//, '');
        if (!encodedUrl) return null;
        try {
            // 解码
            let decodedUrl = decodeURIComponent(encodedUrl);

             // 简单检查解码后是否是有效的 http/https URL
             if (!decodedUrl.match(/^https?:\/\//i)) {
                 // 也许原始路径就没有编码？如果看起来像URL就直接用
                 if (encodedUrl.match(/^https?:\/\//i)) {
                     decodedUrl = encodedUrl;
                     logDebug(`Warning: Path was not encoded but looks like URL: ${decodedUrl}`);
                 } else {
                    logDebug(`无效的目标URL格式 (解码后): ${decodedUrl}`);
                    return null;
                 }
             }
             return decodedUrl;

        } catch (e) {
            logDebug(`解码目标URL时出错: ${encodedUrl} - ${e.message}`);
            return null;
        }
    }

    // 创建标准化的响应
    function createResponse(body, status = 200, headers = {}) {
        const responseHeaders = new Headers(headers);
        // 关键：添加 CORS 跨域头，允许前端 JS 访问代理后的响应
        responseHeaders.set("Access-Control-Allow-Origin", "*"); // 允许任何来源访问
        responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS"); // 允许的方法
        responseHeaders.set("Access-Control-Allow-Headers", "*"); // 允许所有请求头

        // 处理 CORS 预检请求 (OPTIONS)
         if (request.method === "OPTIONS") {
             return new Response(null, { headers: responseHeaders, status: 204 }); // 返回空内容和允许头
         }

        return new Response(body, { status, headers: responseHeaders });
    }

    // 创建 M3U8 类型的响应
    function createM3u8Response(content) {
        return createResponse(content, 200, {
            "Content-Type": "application/vnd.apple.mpegurl", // M3U8 的标准 MIME 类型
            "Cache-Control": `public, max-age=${FUNCTION_CONFIG.CACHE_TTL}` // 允许浏览器和CDN缓存
        });
    }

    // 获取随机 User-Agent
    function getRandomUserAgent() {
        return FUNCTION_CONFIG.USER_AGENTS[Math.floor(Math.random() * FUNCTION_CONFIG.USER_AGENTS.length)];
    }

    // 获取 URL 的基础路径 (用于解析相对路径)
    function getBaseUrl(urlStr) {
        try {
            const parsedUrl = new URL(urlStr);
            const pathParts = parsedUrl.pathname.split('/');
            pathParts.pop(); // 移除文件名部分
            return `${parsedUrl.origin}${pathParts.join('/')}/`;
        } catch (e) {
            // 备用方法：找到最后一个斜杠
            const lastSlashIndex = urlStr.lastIndexOf('/');
            // 确保不是协议部分的斜杠 (http://)
            return lastSlashIndex > urlStr.indexOf('://') + 2 ? urlStr.substring(0, lastSlashIndex + 1) : urlStr + '/';
        }
    }

    // 将相对 URL 转换为绝对 URL
    function resolveUrl(baseUrl, relativeUrl) {
        // 如果已经是绝对 URL，直接返回
        if (relativeUrl.match(/^https?:\/\//i)) {
            return relativeUrl;
        }
        try {
            // 使用 URL 对象来处理相对路径
            return new URL(relativeUrl, baseUrl).toString();
        } catch (e) {
            logDebug(`解析 URL 失败: baseUrl=${baseUrl}, relativeUrl=${relativeUrl}, error=${e.message}`);
            // 简单的备用方法
            if (relativeUrl.startsWith('/')) {
                // 处理根路径相对 URL
                const urlObj = new URL(baseUrl);
                return `${urlObj.origin}${relativeUrl}`;
            }
            // 处理同级目录相对 URL
            return `${baseUrl}${relativeUrl}`;
        }
    }

    // 将目标 URL 重写为内部代理路径 (/proxy/...)
    function rewriteUrlToProxy(targetUrl) {
        // 确保目标URL被正确编码，以便作为路径的一部分
        return `/proxy/${encodeURIComponent(targetUrl)}`;
    }

    // 获取远程内容及其类型
    async function fetchContentWithType(targetUrl) {
        const headers = new Headers({
            'User-Agent': getRandomUserAgent(),
            'Accept': '*/*',
            // 尝试传递一些原始请求的头信息
            'Accept-Language': request.headers.get('Accept-Language') || 'zh-CN,zh;q=0.9,en;q=0.8',
            'Referer': new URL(targetUrl).origin // 设置 Referer 为目标网站的域名
        });

        try {
            // 直接请求目标 URL，不再需要中间的 worker 代理
            logDebug(`开始直接请求: ${targetUrl}`);
            // Cloudflare Functions 的 fetch 默认支持重定向
            const response = await fetch(targetUrl, { headers, redirect: 'follow' });

            if (!response.ok) {
                 // 如果请求失败，尝试读取错误信息
                 const errorBody = await response.text().catch(() => ''); // 忽略读取错误体本身的错误
                 logDebug(`请求失败: ${response.status} ${response.statusText} - ${targetUrl}`);
                 throw new Error(`HTTP error ${response.status}: ${response.statusText}. URL: ${targetUrl}. Body: ${errorBody.substring(0, 150)}`);
            }

            // 读取响应内容为文本
            const content = await response.text();
            const contentType = response.headers.get('Content-Type') || '';
            logDebug(`请求成功: ${targetUrl}, Content-Type: ${contentType}, 内容长度: ${content.length}`);
            return { content, contentType, responseHeaders: response.headers }; // 同时返回原始响应头

        } catch (error) {
             logDebug(`请求彻底失败: ${targetUrl}: ${error.message}`);
            // 抛出更详细的错误
            throw new Error(`请求目标URL失败 ${targetUrl}: ${error.message}`);
        }
    }

    // 判断是否是 M3U8 内容
    function isM3u8Content(content, contentType) {
        // 检查 Content-Type
        if (contentType && (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl') || contentType.includes('audio/mpegurl'))) {
            return true;
        }
        // 检查内容本身是否以 #EXTM3U 开头
        return content && typeof content === 'string' && content.trim().startsWith('#EXTM3U');
    }

    // 判断是否是媒体文件 (根据扩展名和 Content-Type)
    function isMediaFile(url, contentType) {
        // 检查 Content-Type
        if (contentType) {
            for (const mediaType of MEDIA_CONTENT_TYPES) {
                // 如果 Content-Type 以 video/ audio/ image/ 开头
                if (contentType.toLowerCase().startsWith(mediaType)) {
                    return true;
                }
            }
        }
        // 检查文件扩展名
        const urlLower = url.toLowerCase();
        for (const ext of MEDIA_FILE_EXTENSIONS) {
            // 如果 URL 以 .ts 等结尾，或者后面紧跟着 ? (查询参数)
            if (urlLower.endsWith(ext) || urlLower.includes(`${ext}?`)) {
                return true;
            }
        }
        return false;
    }

    // 处理 M3U8 中的 #EXT-X-KEY 行 (加密密钥)
    function processKeyLine(line, baseUrl) {
        // 替换 URI="..." 部分
        return line.replace(/URI="([^"]+)"/, (match, uri) => {
            const absoluteUri = resolveUrl(baseUrl, uri); // 转换为绝对 URL
            logDebug(`处理 KEY URI: 原始='${uri}', 绝对='${absoluteUri}'`);
            return `URI="${rewriteUrlToProxy(absoluteUri)}"`; // 重写为代理路径
        });
    }

    // 处理 M3U8 中的 #EXT-X-MAP 行 (初始化片段)
    function processMapLine(line, baseUrl) {
         return line.replace(/URI="([^"]+)"/, (match, uri) => {
             const absoluteUri = resolveUrl(baseUrl, uri);
             logDebug(`处理 MAP URI: 原始='${uri}', 绝对='${absoluteUri}'`);
             return `URI="${rewriteUrlToProxy(absoluteUri)}"`; // 重写为代理路径
         });
     }

    // 处理媒体 M3U8 播放列表 (包含视频/音频片段)
    function processMediaPlaylist(url, content) {
        const baseUrl = getBaseUrl(url);
        const lines = content.split('\n');
        const output = []; // 存储处理后的行

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            // 保留最后的空行
            if (!line && i === lines.length - 1) {
                output.push(line); // 添加空行并跳过后续处理
                continue;
            }
            if (!line) continue; // 跳过中间的空行

            // 如果配置了过滤，则跳过 #EXT-X-DISCONTINUITY
            if (FUNCTION_CONFIG.FILTER_DISCONTINUITY && line === '#EXT-X-DISCONTINUITY') {
                logDebug(`过滤 Discontinuity 标记: ${url}`);
                continue;
            }
            // 处理加密密钥行
            if (line.startsWith('#EXT-X-KEY')) {
                output.push(processKeyLine(line, baseUrl));
                continue;
            }
            // 处理初始化片段行
            if (line.startsWith('#EXT-X-MAP')) {
                output.push(processMapLine(line, baseUrl));
                 continue;
            }
             // 处理 #EXTINF (片段时长信息)，直接添加
             if (line.startsWith('#EXTINF')) {
                 output.push(line);
                 continue;
             }
             // 处理片段 URL (不是 # 开头的行，并且非空)
             if (!line.startsWith('#')) {
                 const absoluteUrl = resolveUrl(baseUrl, line); // 转换成绝对 URL
                 logDebug(`重写媒体片段: 原始='${line}', 绝对='${absoluteUrl}'`);
                 output.push(rewriteUrlToProxy(absoluteUrl)); // 重写为代理路径
                 continue;
             }
             // 其他 M3U8 标签 (#EXTM3U, #EXT-X-VERSION 等) 直接添加
             output.push(line);
        }
        return output.join('\n'); // 将处理后的行合并成字符串
    }

    // 递归处理 M3U8 内容 (可能是主列表或媒体列表)
     async function processM3u8Content(targetUrl, content, recursionDepth = 0, env) {
         // 检查是否是主列表 (包含 #EXT-X-STREAM-INF 或 #EXT-X-MEDIA)
         if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) {
             logDebug(`检测到主播放列表: ${targetUrl}`);
             return await processMasterPlaylist(targetUrl, content, recursionDepth, env);
         }
         // 否则，作为媒体播放列表处理
         logDebug(`检测到媒体播放列表: ${targetUrl}`);
         return processMediaPlaylist(targetUrl, content);
     }

    // 处理主 M3U8 播放列表 (选择合适的子 M3U8)
    async function processMasterPlaylist(url, content, recursionDepth, env) {
        // 防止无限递归
        if (recursionDepth > FUNCTION_CONFIG.MAX_RECURSION) {
            throw new Error(`处理主列表时递归层数过多 (${FUNCTION_CONFIG.MAX_RECURSION}): ${url}`);
        }

        const baseUrl = getBaseUrl(url);
        const lines = content.split('\n');
        let highestBandwidth = -1; // 最高带宽
        let bestVariantUrl = '';   // 最佳子 M3U8 的 URL

        // 查找最高带宽的子 M3U8
        for (let i = 0; i < lines.length; i++) {
            // 找到 #EXT-X-STREAM-INF 行
            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                // 提取带宽信息
                const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                const currentBandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;

                // 在下一行（或之后几行，跳过注释）找到子 M3U8 的 URI
                 let variantUriLine = '';
                 for (let j = i + 1; j < lines.length; j++) {
                     const line = lines[j].trim();
                     if (line && !line.startsWith('#')) { // 确保不是空行或注释
                         variantUriLine = line;
                         i = j; // 更新外层循环索引，避免重复处理
                         break;
                     }
                 }

                 // 如果找到 URI 且带宽更高，则更新最佳选择
                 if (variantUriLine && currentBandwidth >= highestBandwidth) { // 使用 >= 保证至少选一个
                     highestBandwidth = currentBandwidth;
                     bestVariantUrl = resolveUrl(baseUrl, variantUriLine);
                 }
            }
        }

        // 如果没有找到带 BANDWIDTH 的，尝试查找第一个 .m3u8 链接作为备选
         if (!bestVariantUrl) {
             logDebug(`主列表中未找到 BANDWIDTH 或 STREAM-INF，尝试查找第一个子列表引用: ${url}`);
             for (let i = 0; i < lines.length; i++) {
                 const line = lines[i].trim();
                 // 如果行不是注释，且包含 .m3u8
                 if (line && !line.startsWith('#') && (line.endsWith('.m3u8') || line.includes('m3u8?'))) {
                    bestVariantUrl = resolveUrl(baseUrl, line);
                     logDebug(`备选方案：找到第一个子列表引用: ${bestVariantUrl}`);
                     break;
                 }
             }
         }

        // 如果最终还是没找到子 M3U8 URL
        if (!bestVariantUrl) {
            logDebug(`在主列表 ${url} 中未找到任何有效的子播放列表 URL。可能格式有问题或仅包含音频/字幕。将尝试按媒体列表处理原始内容。`);
            // 尝试将原始主列表作为媒体列表处理（可能里面直接是片段？）
            return processMediaPlaylist(url, content);
        }

        // --- 获取并处理选中的子 M3U8 ---

        // 定义缓存 Key
        const cacheKey = `m3u8_processed:${bestVariantUrl}`; // 使用处理后的缓存键

        // 检查 KV 缓存 (如果 KV 已绑定)
        let kvNamespace = null;
        try {
            kvNamespace = env.LIBRETV_PROXY_KV; // 从环境获取 KV 命名空间
        } catch (e) {
            logDebug("KV 命名空间 'LIBRETV_PROXY_KV' 未绑定或访问出错。");
        }

        if (kvNamespace) {
            const cachedContent = await kvNamespace.get(cacheKey);
            if (cachedContent) {
                logDebug(`[缓存命中] 主列表的子列表: ${bestVariantUrl}`);
                return cachedContent; // 直接返回缓存的处理后内容
            } else {
                logDebug(`[缓存未命中] 主列表的子列表: ${bestVariantUrl}`);
            }
        }

        // 缓存未命中或 KV 不可用，则请求子 M3U8
        logDebug(`选择的子列表 (带宽: ${highestBandwidth}): ${bestVariantUrl}`);
        const { content: variantContent, contentType: variantContentType } = await fetchContentWithType(bestVariantUrl);

        // 再次确保获取到的是 M3U8
        if (!isM3u8Content(variantContent, variantContentType)) {
            logDebug(`获取到的子列表 ${bestVariantUrl} 不是 M3U8 内容 (类型: ${variantContentType})。可能直接是媒体文件，返回原始内容。`);
            // 如果不是M3U8，可能是最终的媒体文件，直接返回
            return createResponse(variantContent, 200, { 'Content-Type': variantContentType || 'application/octet-stream' });
        }

        // 递归处理获取到的子 M3U8 内容
        const processedVariant = await processM3u8Content(bestVariantUrl, variantContent, recursionDepth + 1, env);

        // 将处理结果存入 KV 缓存 (如果 KV 可用)
        if (kvNamespace) {
             // 使用 waitUntil 异步写入缓存，不阻塞响应返回
             waitUntil(kvNamespace.put(cacheKey, processedVariant, { expirationTtl: FUNCTION_CONFIG.CACHE_TTL }));
             logDebug(`已将处理后的子列表写入缓存: ${bestVariantUrl}`);
        }

        return processedVariant; // 返回处理后的子 M3U8 内容
    }

    // --- 主要请求处理逻辑 ---

    try {
        // 从请求路径中提取目标 URL
        const targetUrl = getTargetUrlFromPath(url.pathname);

        // 如果无法提取目标 URL，返回错误
        if (!targetUrl) {
            logDebug(`无效的代理请求路径: ${url.pathname}`);
            return createResponse("无效的代理请求。路径应为 /proxy/<经过编码的URL>", 400);
        }

        logDebug(`收到代理请求: ${targetUrl}`);

        // 定义缓存 Key (使用原始目标 URL)
        const cacheKey = `proxy_raw:${targetUrl}`; // 使用原始内容的缓存键

        // 检查 KV 缓存 (如果 KV 已绑定)
        let kvNamespace = null;
        try {
            kvNamespace = env.LIBRETV_PROXY_KV;
        } catch (e) { /* 忽略错误，表示KV不可用 */ }

        if (kvNamespace) {
            // 尝试读取缓存，这里缓存的是原始未处理的内容和头信息
            const cachedData = await kvNamespace.get(cacheKey, { type: 'json' });
            if (cachedData && cachedData.body && cachedData.headers) {
                logDebug(`[缓存命中] 原始内容: ${targetUrl}`);
                const content = cachedData.body;
                let headers = {};
                try { headers = JSON.parse(cachedData.headers); } catch(e){}
                const contentType = headers['content-type'] || headers['Content-Type'] || '';

                // 如果缓存的是 M3U8，需要重新处理（因为里面的链接需要是动态代理的）
                if (isM3u8Content(content, contentType)) {
                    logDebug(`缓存内容是 M3U8，重新处理: ${targetUrl}`);
                    const processedM3u8 = await processM3u8Content(targetUrl, content, 0, env);
                    // 注意：这里不再缓存处理后的 M3U8，因为 processMasterPlaylist 内部会缓存
                    return createM3u8Response(processedM3u8);
                } else {
                    // 如果缓存的是其他内容，直接返回
                    logDebug(`从缓存返回非 M3U8 内容: ${targetUrl}`);
                    return createResponse(content, 200, new Headers(headers));
                }
            } else {
                 logDebug(`[缓存未命中] 原始内容: ${targetUrl}`);
             }
        }

        // --- 缓存未命中或 KV 不可用，执行实际请求 ---
        const { content, contentType, responseHeaders } = await fetchContentWithType(targetUrl);

        // 将获取到的原始内容存入缓存 (如果 KV 可用)
        if (kvNamespace) {
             const headersToCache = {};
             responseHeaders.forEach((value, key) => { headersToCache[key.toLowerCase()] = value; }); // 转小写存入
             const cacheValue = { body: content, headers: JSON.stringify(headersToCache) };
             // 异步写入缓存
             waitUntil(kvNamespace.put(cacheKey, JSON.stringify(cacheValue), { expirationTtl: FUNCTION_CONFIG.CACHE_TTL }));
             logDebug(`已将原始内容写入缓存: ${targetUrl}`);
        }

        // 判断获取到的内容是否是 M3U8
        if (isM3u8Content(content, contentType)) {
            logDebug(`内容是 M3U8，开始处理: ${targetUrl}`);
            // 是 M3U8，调用处理函数
            const processedM3u8 = await processM3u8Content(targetUrl, content, 0, env);
            return createM3u8Response(processedM3u8);
        } else {
            logDebug(`内容不是 M3U8 (类型: ${contentType})，直接返回: ${targetUrl}`);
            // 不是 M3U8，直接返回获取到的原始内容和响应头
            const finalHeaders = new Headers(responseHeaders); // 使用原始响应头
            finalHeaders.set('Cache-Control', `public, max-age=${FUNCTION_CONFIG.CACHE_TTL}`); // 添加缓存控制头
            return createResponse(content, 200, finalHeaders);
        }

    } catch (error) {
        // 捕获处理过程中的所有错误
        logDebug(`处理代理请求时发生严重错误: ${error.message} \n ${error.stack}`);
        // 返回 500 服务器错误，并在响应体中包含错误信息
        return createResponse(`代理处理错误: ${error.message}`, 500);
    }
}

// 添加一个处理 OPTIONS 预检请求的函数 (可选但推荐)
// Cloudflare Pages 会自动为 `onRequest` 处理 OPTIONS，但明确定义可以提供更多控制
export async function onOptions(context) {
    // 直接返回允许跨域的头信息
    return new Response(null, {
        status: 204, // No Content
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*", // 允许所有请求头
            "Access-Control-Max-Age": "86400", // 预检请求结果缓存一天
        },
    });
}
