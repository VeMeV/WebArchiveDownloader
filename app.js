const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const URLParse = require('url-parse');

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
        console.log('Downloading main page...💪🤖');
        const response = await axios.get(archiveUrl);
        const $ = cheerio.load(response.data);

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
        const assets = new Set();
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
        console.log('Downloading assets...💪🤖');
        for (const assetUrl of assets) {
            try {
                if (!assetUrl) continue;

                const relativePath = getRelativePath(assetUrl);
                if (!relativePath) continue;

                const localPath = path.join(outputDir, relativePath);
                assetMap.set(assetUrl, relativePath);

                // Create directory if it doesn't exist
                await fs.ensureDir(path.dirname(localPath));

                // Download and save the asset
                const assetResponse = await axios.get(assetUrl, { 
                    responseType: 'arraybuffer',
                    maxRedirects: 5,
                    timeout: 10000
                });
                await fs.writeFile(localPath, assetResponse.data);
                console.log(`Downloaded: ${relativePath} 🤖✔`);
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
