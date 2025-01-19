const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const URLParse = require('url-parse');

// Sleep function to add delay between requests
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Function to download with retries
async function downloadWithRetry(url, options, maxRetries = 3, delayMs = 10000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Add browser-like headers
            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Connection': 'keep-alive',
                'Referer': 'https://web.archive.org/'
            };

            const response = await axios({
                ...options,
                url,
                headers,
                timeout: 15000, // Increased timeout
                maxRedirects: 5
            });

            return response;
        } catch (error) {
            if (attempt === maxRetries) {
                throw error;
            }
            console.log(`Attempt ${attempt} failed for ${url}, retrying after ${delayMs}ms...`);
            await sleep(delayMs);
            // Increase delay for next attempt
            delayMs *= 2;
        }
    }
}

async function downloadWebArchivePage(archiveUrl) {
    try {
        // Create URL parser instance
        const parsedUrl = new URLParse(archiveUrl);
        const timestamp = parsedUrl.pathname.split('/')[2];
        const originalUrl = parsedUrl.pathname.split('/').slice(3).join('/');
        
        // Create output directory based on timestamp and domain
        const domain = new URLParse(originalUrl).hostname;
        const outputDir = path.join(process.cwd(), `${domain}_${timestamp}`);
        await fs.ensureDir(outputDir);

        // Download the main HTML page
        console.log('Downloading main page...🤖');
        const response = await downloadWithRetry(archiveUrl, {});
        let $ = cheerio.load(response.data);

        // Clean up the head section by removing Wayback Machine content
        const headContent = $.html('head');
        const cleanedHeadContent = headContent.replace(/<head>[\s\S]*?<!-- End Wayback Rewrite JS Include -->/, '<head>');
        $('head').replaceWith(cleanedHeadContent);

        // Clean up content after </html>
        let htmlContent = $.html();
        htmlContent = htmlContent.replace(/<\/html>[\s\S]*$/, '</html>');
        $ = cheerio.load(htmlContent);

        // Function to fix archive URLs
        const fixArchiveUrl = (url) => {
            if (!url) return null;
            if (url.startsWith('data:')) return null; // Skip data URLs
            if (url.startsWith('//')) url = 'https:' + url;
            if (url.startsWith('/')) {
                return `https://web.archive.org${url}`;
            }
            if (!url.includes('web.archive.org')) {
                return `https://web.archive.org/web/${timestamp}/${url}`;
            }
            return url;
        };

        // Add favicon to assets
        const faviconUrls = new Set();
        
        // Check for favicon in link tags
        $('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').each((_, elem) => {
            const href = $(elem).attr('href');
            if (href) faviconUrls.add(fixArchiveUrl(href));
        });

        // Add default favicon location if no favicon found in links
        if (faviconUrls.size === 0) {
            const defaultFaviconUrl = `https://web.archive.org/web/${timestamp}/http://${domain}/favicon.ico`;
            faviconUrls.add(defaultFaviconUrl);
        }

        // Function to get relative path for asset
        const getRelativePath = (url) => {
            try {
                const parsedAssetUrl = new URLParse(url);
                let urlPath = parsedAssetUrl.pathname;
                
                // Remove the /web/timestamp/im_ parts from web archive URLs
                const parts = urlPath.split('/');
                if (parts[1] === 'web' && parts[3]?.includes('im_')) {
                    parts.splice(1, 3); // Remove web archive specific parts
                } else if (parts[1] === 'web') {
                    parts.splice(1, 2); // Remove web and timestamp
                }
                urlPath = parts.join('/');

                // Remove protocol and domain parts if they exist in the path
                urlPath = urlPath.replace(/^\/https?:\/\//, '').replace(/^\//, '');
                
                // Convert the URL path to a safe file path
                const safePath = urlPath
                    .split('/')
                    .map(segment => segment.replace(/[<>:"|?*]/g, '_'))
                    .join('/');

                return safePath;
            } catch (error) {
                console.error('Error processing URL:', url, error.message);
                return null;
            }
        };

        // Process and download assets
        const assets = new Set([...faviconUrls]);
        const assetMap = new Map(); // Map to store original URL to local path

        // Handle CSS files
        $('link[rel="stylesheet"]').each((_, elem) => {
            const href = $(elem).attr('href');
            if (href) assets.add(fixArchiveUrl(href));
        });

        // Handle JavaScript files
        $('script[src]').each((_, elem) => {
            const src = $(elem).attr('src');
            if (src) assets.add(fixArchiveUrl(src));
        });

        // Handle all possible image sources
        $('img').each((_, elem) => {
            const src = $(elem).attr('src');
            const dataSrc = $(elem).attr('data-src');
            const srcset = $(elem).attr('srcset');
            
            if (src) assets.add(fixArchiveUrl(src));
            if (dataSrc) assets.add(fixArchiveUrl(dataSrc));
            if (srcset) {
                srcset.split(',').forEach(src => {
                    const url = src.trim().split(' ')[0];
                    assets.add(fixArchiveUrl(url));
                });
            }
        });

        // Also check for background images in style attributes
        $('[style*="background"]').each((_, elem) => {
            const style = $(elem).attr('style');
            if (style) {
                const matches = style.match(/url\(['"]?(.*?)['"]?\)/g);
                if (matches) {
                    matches.forEach(match => {
                        const url = match.replace(/url\(['"]?(.*?)['"]?\)/, '$1');
                        assets.add(fixArchiveUrl(url));
                    });
                }
            }
        });

        // Download all assets
        console.log('Downloading assets...🤖');
        for (const assetUrl of assets) {
            try {
                if (!assetUrl) continue;

                const relativePath = getRelativePath(assetUrl);
                if (!relativePath) continue;

                const localPath = path.join(outputDir, relativePath);
                assetMap.set(assetUrl, relativePath);

                // Create directory if it doesn't exist
                await fs.ensureDir(path.dirname(localPath));

                // Download and save the asset with retry logic
                const assetResponse = await downloadWithRetry(assetUrl, { 
                    responseType: 'arraybuffer'
                });
                
                await fs.writeFile(localPath, assetResponse.data);
                console.log(`Downloaded: ${relativePath} ✔`);
                
                // Add a small delay between downloads to avoid rate limiting
                await sleep(5000);
            } catch (error) {
                console.error(`Failed to download asset: ${assetUrl} ❌`, error.message);
            }
        }

        // Update HTML to use local paths
        $('link[rel="stylesheet"]').each((_, elem) => {
            const href = $(elem).attr('href');
            const fixedHref = fixArchiveUrl(href);
            if (fixedHref && assetMap.has(fixedHref)) {
                $(elem).attr('href', assetMap.get(fixedHref));
            }
        });

        $('script[src]').each((_, elem) => {
            const src = $(elem).attr('src');
            const fixedSrc = fixArchiveUrl(src);
            if (fixedSrc && assetMap.has(fixedSrc)) {
                $(elem).attr('src', assetMap.get(fixedSrc));
            }
        });

        $('img').each((_, elem) => {
            const src = $(elem).attr('src');
            const fixedSrc = fixArchiveUrl(src);
            if (fixedSrc && assetMap.has(fixedSrc)) {
                $(elem).attr('src', assetMap.get(fixedSrc));
            }

            const srcset = $(elem).attr('srcset');
            if (srcset) {
                const newSrcset = srcset.split(',').map(src => {
                    const [url, size] = src.trim().split(' ');
                    const fixedUrl = fixArchiveUrl(url);
                    return fixedUrl && assetMap.has(fixedUrl) ? 
                        `${assetMap.get(fixedUrl)} ${size || ''}` : '';
                }).filter(Boolean).join(', ');
                
                if (newSrcset) {
                    $(elem).attr('srcset', newSrcset);
                }
            }
        });

        // Clean up all remaining web archive URLs in href attributes
        $('[href]').each((_, elem) => {
            const href = $(elem).attr('href');
            if (href && href.includes('web.archive.org/web/')) {
                const cleanUrl = href.replace(/https?:\/\/web\.archive\.org\/web\/\d+\w*\//, '');
                $(elem).attr('href', cleanUrl);
            }
        });

        // Clean up all remaining web archive URLs in src attributes
        $('[src]').each((_, elem) => {
            const src = $(elem).attr('src');
            if (src && src.includes('web.archive.org/web/')) {
                const cleanUrl = src.replace(/https?:\/\/web\.archive\.org\/web\/\d+\w*\//, '');
                $(elem).attr('src', cleanUrl);
            }
        });

        // Clean up any remaining web archive URLs in any other attributes
        $('*').each((_, elem) => {
            const attributes = $(elem).attr();
            Object.keys(attributes).forEach(attr => {
                const value = attributes[attr];
                if (typeof value === 'string' && value.includes('web.archive.org/web/')) {
                    const cleanUrl = value.replace(/https?:\/\/web\.archive\.org\/web\/\d+\w*\//, '');
                    $(elem).attr(attr, cleanUrl);
                }
            });
        });

        // Save the modified HTML file
        const htmlPath = path.join(outputDir, 'index.html');
        await fs.writeFile(htmlPath, $.html());

        console.log(`\nDownload complete! 🎉✔🤖✔🎉 Files saved in: ${outputDir}`);
    } catch (error) {
        console.error('Error:', error.message);
    }
}

// Check if URL is provided as command line argument
const archiveUrl = process.argv[2];
if (!archiveUrl) {
    console.log('Please provide a web.archive.org URL as a command line argument');
    console.log('Example: node app.js https://web.archive.org/web/20160328000145/http://www.google.com/');
    process.exit(1);
}

downloadWebArchivePage(archiveUrl);
