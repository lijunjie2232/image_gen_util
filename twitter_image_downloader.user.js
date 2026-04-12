// ==UserScript==
// @name         Twitter Image Downloader
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Download all images from current Twitter page with infinite scroll (uses FastAPI server)
// @author       lijunjie2232
// @match        https://twitter.com/*
// @match        https://x.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      twitter.com
// @connect      twimg.com
// @connect      pbs.twimg.com
// @connect      abs.twimg.com
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // Configuration
    const SERVER_URL = GM_getValue('serverUrl', 'http://127.0.0.1:8000');
    let MAX_NUM = GM_getValue('maxNum', 100);
    
    // Extract username from URL for default directory (not persisted)
    function getDefaultDirectory() {
        // Try to extract username from Twitter URL
        const match = window.location.pathname.match(/^\/([^\/]+)/);
        if (match && match[1] && !['home', 'explore', 'notifications', 'messages', 'settings', 'compose'].includes(match[1])) {
            return match[1];
        }
        
        return 'twitter_images';
    }
    
    // Get the actual directory to use (saved value or default)
    function getEffectiveDirectory() {
        const savedDir = GM_getValue('downloadDir', null);
        return savedDir || getDefaultDirectory();
    }
    
    let DEFAULT_DIR = getEffectiveDirectory();
    let isRunning = false;
    let downloadedCount = 0;
    let skippedCount = 0;
    let foundCount = 0; // Total images found on page
    let imageCache = new Set();
    
    // Three-queue architecture
    let taskQueue = []; // Queue of image URLs to fetch (from scroll thread)
    let imageQueue = []; // Queue of fetched image data (from fetch thread)
    let activeFetches = 0; // Active fetch operations
    let activeUploads = 0; // Active upload operations
    const MAX_CONCURRENT_FETCH = 4; // Max concurrent fetch operations
    const MAX_CONCURRENT_UPLOAD = 2; // Max concurrent upload operations
    const MAX_TASK_QUEUE = 8; // Pause scroll if task queue exceeds this
    const MIN_TASK_QUEUE = 2; // Resume scroll when task queue drops below this
    
    let isUIHidden = false;
    let isScrolling = false; // Flag to prevent concurrent scrolling
    let shouldStopScrolling = false; // Signal to stop scrolling
    
    // Async task management
    let fetchTaskPromises = []; // Track all fetch promises
    let uploadTaskPromises = []; // Track all upload promises
    let scrollTaskPromise = null; // Current scroll task promise

    // Load cache from server
    async function loadCache() {
        const dir = getEffectiveDirectory();
        try {
            const response = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `${SERVER_URL}/cache/${encodeURIComponent(dir)}`,
                    onload: resolve,
                    onerror: reject
                });
            });
            
            if (response.status === 200) {
                const data = JSON.parse(response.responseText);
                imageCache = new Set(data.cache_data || []);
                console.log(`Loaded ${imageCache.size} cached images from server`);
            }
        } catch (error) {
            console.log('No cache found on server, starting fresh');
            imageCache = new Set();
        }
    }

    // Save cache to server
    async function saveCache() {
        const dir = getEffectiveDirectory();
        const cacheData = Array.from(imageCache);
        
        try {
            await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: `${SERVER_URL}/cache/sync`,
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    data: JSON.stringify({
                        directory: dir,
                        cache_data: cacheData
                    }),
                    onload: (response) => {
                        if (response.status === 200) {
                            console.log(`Cache synced to server: ${cacheData.length} entries`);
                            resolve();
                        } else {
                            reject(new Error(`Server error: ${response.status}`));
                        }
                    },
                    onerror: reject
                });
            });
        } catch (error) {
            console.error('Error syncing cache to server:', error);
        }
    }

    // Create floating UI
    function createUI() {
        const ui = document.createElement('div');
        ui.id = 'twitter-downloader-ui';
        ui.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 12px;
            z-index: 10000;
            
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            min-width: 280px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.18);
            transition: all 0.3s ease;
        `;

        ui.innerHTML = `
            <div id="ui-full">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                    <h3 style="margin: 0; font-size: 18px; font-weight: 600;">📥 Twitter Image Downloader</h3>
                    <button id="toggle-ui-btn" title="Hide UI" style="background: rgba(255, 255, 255, 0.2); border: none; border-radius: 6px; padding: 6px 10px; cursor: pointer; font-size: 16px; transition: all 0.3s ease;">➖</button>
                </div>
                
                <div style="background: rgba(255, 255, 255, 0.1); padding: 12px; border-radius: 8px; margin-bottom: 12px;">
                    <div style="margin-bottom: 10px;">
                        <label style="display: block; font-size: 12px; margin-bottom: 5px; opacity: 0.9;">Server URL:</label>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <input type="text" id="server-url" value="${SERVER_URL}" style="flex: 1; padding: 8px; border: none; border-radius: 6px; background: rgba(255, 255, 255, 0.9); color: #333; font-size: 14px; box-sizing: border-box;">
                            <button id="test-server-btn" title="Test server connection" style="background: rgba(255, 255, 255, 0.2); border: none; border-radius: 6px; padding: 8px 12px; cursor: pointer; font-size: 16px; transition: all 0.3s ease; white-space: nowrap;">🔍 Test</button>
                        </div>
                    </div>
                    <div style="margin-bottom: 10px;">
                        <label style="display: block; font-size: 12px; margin-bottom: 5px; opacity: 0.9;">Max Images:</label>
                        <input type="number" id="max-num" value="${MAX_NUM}" style="width: 100%; padding: 8px; border: none; border-radius: 6px; background: rgba(255, 255, 255, 0.9); color: #333; font-size: 14px; box-sizing: border-box;">
                    </div>
                    <div style="margin-bottom: 5px;">
                        <label style="display: block; font-size: 12px; margin-bottom: 5px; opacity: 0.9;">Directory:</label>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <input type="text" id="download-dir" value="${GM_getValue('downloadDir', '')}" placeholder="${getDefaultDirectory()}" style="flex: 1; padding: 8px; border: none; border-radius: 6px; background: rgba(255, 255, 255, 0.9); color: #333; font-size: 14px; box-sizing: border-box;">
                        </div>
                        <div style="font-size: 10px; opacity: 0.7; margin-top: 5px;">💡 Leave empty to auto-detect from URL</div>
                    </div>
                    <div style="font-size: 10px; opacity: 0.7; margin-top: 5px;">💾 Images saved to server's IMG_ROOT/directory/</div>
                </div>
                
                <div style="background: rgba(255, 255, 255, 0.15); padding: 12px; border-radius: 8px; margin-bottom: 12px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <span style="font-size: 12px; opacity: 0.9;">Progress:</span>
                        <span style="font-size: 14px; font-weight: 600;"><span id="progress">0</span> / <span id="max-display">${MAX_NUM}</span></span>
                    </div>
                    <div style="background: rgba(0, 0, 0, 0.2); height: 6px; border-radius: 3px; overflow: hidden;">
                        <div id="progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #4CAF50, #8BC34A); transition: width 0.3s ease;"></div>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-top: 10px; font-size: 12px;">
                        <span>✅ Downloaded: <strong id="downloaded-count">0</strong></span>
                        <span>⏭️ Skipped: <strong id="skipped-count">0</strong></span>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-top: 8px; font-size: 12px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, 0.1);">
                        <span>🔍 Found: <strong id="found-count">0</strong></span>
                        <span>📥 Queue: <strong id="queue-count">0</strong></span>
                    </div>
                </div>
                
                <div style="display: flex; gap: 8px; margin-bottom: 10px;">
                    <button id="start-btn" style="flex: 1; background: linear-gradient(135deg, #4CAF50, #45a049); color: white; border: none; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; transition: all 0.3s ease; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.2);">▶ Start</button>
                    <button id="stop-btn" style="flex: 1; background: linear-gradient(135deg, #f44336, #da190b); color: white; border: none; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; transition: all 0.3s ease; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.2);" disabled>⏹ Stop</button>
                </div>
                
                <div id="status" style="font-size: 11px; color: rgba(255, 255, 255, 0.8); text-align: center; padding: 8px; background: rgba(0, 0, 0, 0.2); border-radius: 6px;">Ready to start</div>
            </div>
            
            <div id="ui-icon" style="display: none; cursor: pointer; width: 50px; height: 50px; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); align-items: center; justify-content: center; font-size: 24px; transition: all 0.3s ease;" title="Click to show UI">
                📥
            </div>
        `;

        document.body.appendChild(ui);

        // Event listeners
        document.getElementById('start-btn').addEventListener('click', startDownload);
        document.getElementById('stop-btn').addEventListener('click', stopDownload);
        document.getElementById('toggle-ui-btn').addEventListener('click', toggleUI);
        document.getElementById('ui-icon').addEventListener('click', toggleUI);
        document.getElementById('test-server-btn').addEventListener('click', testServerConnection);
        
        document.getElementById('server-url').addEventListener('change', (e) => {
            GM_setValue('serverUrl', e.target.value.trim());
        });
        
        document.getElementById('max-num').addEventListener('change', (e) => {
            MAX_NUM = parseInt(e.target.value);
            GM_setValue('maxNum', MAX_NUM);
            document.getElementById('max-display').textContent = MAX_NUM;
        });
        
        document.getElementById('download-dir').addEventListener('change', (e) => {
            const value = e.target.value.trim();
            if (value) {
                // Only save if user entered a value
                GM_setValue('downloadDir', value);
                DEFAULT_DIR = value;
            } else {
                // Clear saved value, will use auto-detected default
                GM_setValue('downloadDir', null);
                DEFAULT_DIR = getEffectiveDirectory();
            }
        });
    }

    // Toggle UI visibility
    function toggleUI() {
        const fullUI = document.getElementById('ui-full');
        const icon = document.getElementById('ui-icon');
        const toggleBtn = document.getElementById('toggle-ui-btn');
        const ui = document.getElementById('twitter-downloader-ui');
        
        if (isUIHidden) {
            // Show full UI - restore all styles
            fullUI.style.display = 'block';
            icon.style.display = 'none';
            toggleBtn.textContent = '➖';
            ui.style.padding = '20px';
            ui.style.minWidth = '280px';
            ui.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
            ui.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.3)';
            ui.style.backdropFilter = 'blur(10px)';
            ui.style.border = '1px solid rgba(255, 255, 255, 0.18)';
            isUIHidden = false;
        } else {
            // Hide to icon only
            fullUI.style.display = 'none';
            icon.style.display = 'flex';
            toggleBtn.textContent = '➕';
            ui.style.padding = '0';
            ui.style.minWidth = 'auto';
            ui.style.background = 'transparent';
            ui.style.boxShadow = 'none';
            ui.style.backdropFilter = 'none';
            ui.style.border = 'none';
            isUIHidden = true;
        }
    }

    // Test server connection
    async function testServerConnection() {
        const testBtn = document.getElementById('test-server-btn');
        const statusEl = document.getElementById('status');
        const serverUrl = GM_getValue('serverUrl', 'http://127.0.0.1:8000');
        
        // Disable button and show testing status
        testBtn.disabled = true;
        testBtn.textContent = '⏳ Testing...';
        statusEl.textContent = 'Testing server connection...';
        
        try {
            const response = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `${serverUrl}/health`,
                    timeout: 5000,
                    onload: resolve,
                    onerror: reject,
                    ontimeout: () => reject(new Error('Connection timeout'))
                });
            });
            
            if (response.status === 200) {
                const data = JSON.parse(response.responseText);
                testBtn.textContent = '✅ OK';
                testBtn.style.background = 'rgba(76, 175, 80, 0.6)';
                statusEl.textContent = `✓ Server connected! IMG_ROOT: ${data.img_root}`;
                statusEl.style.color = '#4CAF50';
                
                // Reset button after 2 seconds
                setTimeout(() => {
                    testBtn.textContent = '🔍 Test';
                    testBtn.style.background = 'rgba(255, 255, 255, 0.2)';
                    testBtn.disabled = false;
                    statusEl.style.color = 'rgba(255, 255, 255, 0.8)';
                }, 2000);
            } else {
                throw new Error(`Server returned status ${response.status}`);
            }
        } catch (error) {
            testBtn.textContent = '❌ Failed';
            testBtn.style.background = 'rgba(244, 67, 54, 0.6)';
            statusEl.textContent = `✗ Connection failed: ${error.message}`;
            statusEl.style.color = '#f44336';
            
            // Reset button after 3 seconds
            setTimeout(() => {
                testBtn.textContent = '🔍 Test';
                testBtn.style.background = 'rgba(255, 255, 255, 0.2)';
                testBtn.disabled = false;
                statusEl.style.color = 'rgba(255, 255, 255, 0.8)';
                statusEl.textContent = 'Ready to start';
            }, 3000);
        }
    }


    // Calculate hash for image URL
    function calculateHash(url) {
        let hash = 0;
        for (let i = 0; i < url.length; i++) {
            const char = url.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash).toString(16);
    }

    // Get image dimensions
    async function getImageDimensions(url) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                resolve({ width: img.width, height: img.height });
            };
            img.onerror = () => {
                resolve({ width: 0, height: 0 });
            };
            img.src = url;
        });
    }

    // Extract file extension from URL
    function getFileExtension(url) {
        const match = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
        return match ? match[1].toLowerCase() : 'jpg';
    }

    // Fetch single image (Fetch Thread)
    async function fetchImage(imageUrl) {
        try {
            if (imageCache.has(imageUrl)) {
                console.log('Skipping cached image');
                skippedCount++;
                updateProgress();
                return null; // Already downloaded
            }

            console.log('Fetching image data...');
            
            // Try GM_xmlhttpRequest first, fallback to fetch
            let imageData;
            try {
                imageData = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: imageUrl,
                        responseType: 'blob',
                        onload: (response) => {
                            if (response.status === 200) {
                                resolve(response.response);
                            } else {
                                reject(new Error(`Failed to fetch image: ${response.status}`));
                            }
                        },
                        onerror: reject,
                        ontimeout: () => reject(new Error('Request timeout'))
                    });
                });
            } catch (gmError) {
                console.warn('GM_xmlhttpRequest failed, trying fetch API...', gmError.message);
                
                // Fallback to fetch API
                try {
                    const response = await fetch(imageUrl, {
                        method: 'GET',
                        credentials: 'include' // Include cookies for authentication
                    });
                    
                    if (!response.ok) {
                        throw new Error(`Fetch failed with status ${response.status}`);
                    }
                    
                    imageData = await response.blob();
                    console.log('✅ Successfully fetched using fetch API');
                } catch (fetchError) {
                    console.error('Both GM_xmlhttpRequest and fetch failed:', fetchError);
                    throw fetchError;
                }
            }
            
            console.log('Image data fetched successfully');
            
            return {
                url: imageUrl,
                data: imageData
            };
        } catch (error) {
            console.error('Error fetching image:', error);
            return null;
        }
    }
    
    // Upload single image to server (Upload Thread)
    async function uploadImage(imageObj) {
        if (!imageObj) return false;
        
        try {
            const { url, data } = imageObj;
            
            console.log('Getting image dimensions...');
            const dimensions = await getImageDimensions(url);
            console.log(`Dimensions: ${dimensions.width}x${dimensions.height}`);
            
            const hash = calculateHash(url);
            const ext = getFileExtension(url);
            const dir = getEffectiveDirectory();
            const filename = `${hash}_${dimensions.width}x${dimensions.height}.${ext}`;
            console.log(`Filename: ${filename}`);

            // Upload to server
            const formData = new FormData();
            formData.append('file', data, filename);
            formData.append('directory', dir);
            formData.append('filename', filename);

            await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: `${SERVER_URL}/download/image`,
                    data: formData,
                    onload: (response) => {
                        if (response.status === 200) {
                            console.log('Upload successful!');
                            imageCache.add(url);
                            downloadedCount++;
                            // Save cache periodically (every 10 images)
                            if (downloadedCount % 10 === 0) {
                                saveCache();
                            }
                            updateProgress();
                            resolve(true);
                        } else {
                            console.error('Server error:', response.status, response.responseText);
                            reject(new Error(`Server error: ${response.status}`));
                        }
                    },
                    onerror: (error) => {
                        console.error('Upload error:', error);
                        reject(error);
                    }
                });
            });
            
            return true;
        } catch (error) {
            console.error('Error uploading image:', error);
            return false;
        }
    }

    // Process fetch queue - Fetch Thread
    function processFetchQueue() {
        // Start fetches up to MAX_CONCURRENT_FETCH without blocking
        while (taskQueue.length > 0 && 
               activeFetches < MAX_CONCURRENT_FETCH && 
               downloadedCount + activeFetches + activeUploads < MAX_NUM) {
            
            const imageUrl = taskQueue.shift();
            activeFetches++;
            console.log(`🔄 Starting fetch (${activeFetches}/${MAX_CONCURRENT_FETCH}): ${imageUrl.substring(0, 80)}...`);
            
            // Create async fetch task and track it
            const fetchPromise = (async () => {
                try {
                    const imageObj = await fetchImage(imageUrl);
                    if (imageObj) {
                        // Push to image queue for upload thread
                        imageQueue.push(imageObj);
                        console.log(`✅ Fetch complete, added to image queue (ImgQ: ${imageQueue.length})`);
                        updateProgress();
                    } else {
                        console.log('⏭️ Fetch skipped (cached or failed)');
                    }
                } catch (error) {
                    console.error('✗ Fetch failed:', error.message);
                } finally {
                    activeFetches--;
                    updateProgress();
                }
            })();
            
            fetchTaskPromises.push(fetchPromise);
            
            // Keep array size manageable - clean up when too large
            if (fetchTaskPromises.length > 100) {
                // Remove oldest entries (they're likely completed)
                fetchTaskPromises = fetchTaskPromises.slice(-50);
            }
        }
    }
    
    // Process upload queue - Upload Thread
    function processUploadQueue() {
        // Start uploads up to MAX_CONCURRENT_UPLOAD without blocking
        while (imageQueue.length > 0 && 
               activeUploads < MAX_CONCURRENT_UPLOAD && 
               downloadedCount + activeFetches + activeUploads < MAX_NUM) {
            
            const imageObj = imageQueue.shift();
            activeUploads++;
            console.log(`📤 Starting upload (${activeUploads}/${MAX_CONCURRENT_UPLOAD})`);
            
            // Create async upload task and track it
            const uploadPromise = (async () => {
                try {
                    const success = await uploadImage(imageObj);
                    if (success) {
                        console.log(`✅ Upload complete (Downloaded: ${downloadedCount})`);
                    } else {
                        console.log('⏭️ Upload skipped or failed');
                    }
                } catch (error) {
                    console.error('✗ Upload failed:', error.message);
                } finally {
                    activeUploads--;
                    updateProgress();
                }
            })();
            
            uploadTaskPromises.push(uploadPromise);
            
            // Keep array size manageable - clean up when too large
            if (uploadTaskPromises.length > 100) {
                // Remove oldest entries (they're likely completed)
                uploadTaskPromises = uploadTaskPromises.slice(-50);
            }
        }
    }
    
    // Start continuous download processing loop - manages both fetch and upload threads
    function startDownloadProcessor() {
        // Use requestAnimationFrame for smooth, responsive processing
        let lastProcessTime = 0;
        const processInterval = 50; // Process every 50ms
        
        async function processLoop() {
            const totalActive = activeFetches + activeUploads;
            const totalQueued = taskQueue.length + imageQueue.length;
            
            if (!isRunning && totalQueued === 0 && totalActive === 0) {
                // All done, exit loop
                console.log('✅ All downloads completed');
                return;
            }
            
            const now = Date.now();
            if (now - lastProcessTime >= processInterval) {
                lastProcessTime = now;
                
                // Process fetch queue
                if (taskQueue.length > 0 && 
                    activeFetches < MAX_CONCURRENT_FETCH && 
                    downloadedCount + totalActive < MAX_NUM) {
                    processFetchQueue();
                }
                
                // Process upload queue
                if (imageQueue.length > 0 && 
                    activeUploads < MAX_CONCURRENT_UPLOAD && 
                    downloadedCount + totalActive < MAX_NUM) {
                    processUploadQueue();
                }
                
                // Update UI
                updateProgress();
            }
            
            // Continue loop
            requestAnimationFrame(processLoop);
        }
        
        // Start the processing loop
        requestAnimationFrame(processLoop);
        console.log('✅ Download processor started (3-thread architecture: Scroll/Fetch/Upload)');
    }

    // Find all images on current page - comprehensive detection
    function findImages() {
        const images = [];
        const seenUrls = new Set();
        
        // Comprehensive selectors covering tweets, replies, media galleries, etc.
        const selectors = [
            // Main tweet images
            'article img[src*="twimg.com"]',
            'article img[src*="pbs.twimg.com"]',
            '[data-testid="tweetPhoto"] img',
            'div[data-testid="tweetPhoto"] img',
            
            // Reply images
            'section[aria-labelledby] img[src*="twimg.com"]',
            'div[role="group"] img[src*="twimg.com"]',
            'div[data-testid="cellInnerDiv"] img[src*="twimg.com"]',
            
            // Media gallery images
            'div[rarity="gallery"] img',
            'div[data-testid="videoPlayer"] img',
            
            // Profile header and banner
            'div[data-testid="UserProfileHeader_Items"] img',
            'div[data-testid="UserAvatar-Container"] img',
            
            // General Twitter image patterns
            'img[src*="twimg.com/media/"]',
            'img[src*="pbs.twimg.com/media/"]',
            'img[src*="ton.twitter.com"]',
            
            // Lazy-loaded images
            'img[data-testid="tweetPhoto"]',
            'img[alt]:not([alt=""])',
            
            // All images as fallback
            'img'
        ];
        
        let imgElements = new Set();
        selectors.forEach(selector => {
            try {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    elements.forEach(img => imgElements.add(img));
                }
            } catch (e) {
                // Ignore invalid selectors
            }
        });
        
        imgElements = Array.from(imgElements);
        console.log(`Checking ${imgElements.length} unique img elements`);
        
        imgElements.forEach(img => {
            // Extract image URL from multiple possible sources
            let src = img.currentSrc || 
                      img.src || 
                      img.getAttribute('src') ||
                      img.getAttribute('data-src') || 
                      img.getAttribute('data-url') ||
                      img.getAttribute('srcset')?.split(',')[0]?.split(' ')[0] ||
                      '';
            
            if (!src) return;
            
            // Decode HTML entities
            src = src.replace(/&amp;/g, '&');
            
            // Normalize URL for deduplication (remove query params)
            const normalizedSrc = src.split('?')[0];
            
            if (seenUrls.has(normalizedSrc)) return;
            seenUrls.add(normalizedSrc);
            
            // Only skip SVG files
            if (src.toLowerCase().includes('.svg')) return;
            
            // Only process Twitter images
            if (!src.includes('twimg.com') && !src.includes('pbs.twimg.com')) return;
            
            // CRITICAL: Only allow /media/ path images (actual tweet media)
            // Block all other types that may be restricted by browser/extensions
            if (!src.includes('/media/')) {
                console.log(`Skipping non-media image: ${src.substring(0, 100)}...`);
                return;
            }
            
            // Additional safety: explicitly block known problematic paths
            if (src.includes('/profile_images/') || 
                src.includes('/profile_banners/') ||
                src.includes('/amplify_video_thumb/') ||
                src.includes('/sticky/') ||
                src.includes('_normal.jpg') || 
                src.includes('_bigger.jpg') || 
                src.includes('_mini.jpg') ||
                src.includes('/emoji/') || 
                src.includes('/icons/') || 
                src.includes('/badges/')) {
                console.log(`Skipping blocked image type: ${src.substring(0, 100)}...`);
                return;
            }
            
            // CRITICAL: Update URL to highest resolution BEFORE any filtering
            src = addOrUpdateNameParameter(src, '4096x4096');
            
            // Add if not already in cache or task queue
            if (!imageCache.has(src) && !taskQueue.includes(src)) {
                images.push(src);
            }
        });

        // Update total found count
        if (images.length > 0) {
            foundCount += images.length;
            console.log(`✓ Found ${images.length} new images (total: ${foundCount})`);
        } else {
            console.log('⚠️ No new images found in current view');
        }
        
        return images;
    }
    
    // Add or update the 'name' parameter in Twitter image URL
    function addOrUpdateNameParameter(url, size) {
        try {
            const urlObj = new URL(url);
            
            // Check if it's a media URL (contains /media/)
            if (urlObj.pathname.includes('/media/')) {
                // Set or update the name parameter
                urlObj.searchParams.set('name', size);
                return urlObj.toString();
            }
            
            // For non-media URLs, return as-is
            return url;
        } catch (e) {
            // If URL parsing fails, return original URL
            console.warn('Failed to parse URL:', url);
            return url;
        }
    }

    // Scroll down smoothly like a human user (small steps with waits)
    async function scrollToBottom() {
        // Prevent concurrent scrolling
        if (isScrolling) {
            console.log('Scroll already in progress, skipping...');
            return;
        }
        
        isScrolling = true;
        shouldStopScrolling = false;
        
        try {
            const scrollStep = 800; // Scroll 800px at a time
            const stepDelay = 500;  // Wait 500ms between steps
            
            let previousHeight = 0;
            let consecutiveNoChange = 0;
            const maxNoChange = 3; // Stop if height doesn't change 3 times
            
            while (consecutiveNoChange < maxNoChange && !shouldStopScrolling) {
                const currentHeight = document.body.scrollHeight;
                const currentScroll = window.scrollY + window.innerHeight;
                
                // Check if we've reached the bottom
                if (currentScroll >= currentHeight - 100) {
                    // Wait to see if more content loads, update UI during wait
                    for (let i = 0; i < 15 && !shouldStopScrolling; i++) { // 15 * 100ms = 1500ms
                        await new Promise(resolve => setTimeout(resolve, 100));
                        updateProgress(); // Update UI every 100ms during wait
                    }
                    
                    if (shouldStopScrolling) break;
                    
                    const newHeight = document.body.scrollHeight;
                    if (newHeight === currentHeight) {
                        consecutiveNoChange++;
                    } else {
                        consecutiveNoChange = 0; // Reset counter if height changed
                    }
                } else {
                    // Scroll down by step (use instant scroll to avoid conflicts)
                    window.scrollTo({
                        top: window.scrollY + scrollStep,
                        behavior: 'auto' // Use 'auto' instead of 'smooth' for better control
                    });
                    
                    // Wait for content to load, update UI during wait
                    for (let i = 0; i < 5 && !shouldStopScrolling; i++) { // 5 * 100ms = 500ms
                        await new Promise(resolve => setTimeout(resolve, 100));
                        updateProgress(); // Update UI every 100ms during wait
                    }
                    
                    if (shouldStopScrolling) break;
                    
                    consecutiveNoChange = 0; // Reset counter after scrolling
                }
            }
        } finally {
            isScrolling = false;
        }
    }

    // Update progress display
    function updateProgress() {
        document.getElementById('progress').textContent = downloadedCount;
        document.getElementById('downloaded-count').textContent = downloadedCount;
        document.getElementById('skipped-count').textContent = skippedCount;
        document.getElementById('found-count').textContent = foundCount;
        document.getElementById('queue-count').textContent = `${taskQueue.length}/${MAX_TASK_QUEUE}`;
        
        // Update progress bar
        const progressPercent = MAX_NUM > 0 ? (downloadedCount / MAX_NUM) * 100 : 0;
        document.getElementById('progress-bar').style.width = progressPercent + '%';
        
        // Color code the queue count based on status
        const queueCountEl = document.getElementById('queue-count');
        if (taskQueue.length >= MAX_TASK_QUEUE) {
            queueCountEl.style.color = '#ff6b6b'; // Red when full
        } else if (taskQueue.length >= MIN_TASK_QUEUE) {
            queueCountEl.style.color = '#ffd93d'; // Yellow when moderate
        } else {
            queueCountEl.style.color = '#6bcf7f'; // Green when low
        }
        
        document.getElementById('status').textContent =
            `Fetch: ${activeFetches} | Upload: ${activeUploads} | TaskQ: ${taskQueue.length}/${MAX_TASK_QUEUE} | ImgQ: ${imageQueue.length}`;
    }

    // Start download process
    async function startDownload() {
        if (isRunning) return;

        isRunning = true;
        shouldStopScrolling = false;
        downloadedCount = 0;
        skippedCount = 0;
        foundCount = 0;
        taskQueue = [];
        imageQueue = [];
        fetchTaskPromises = [];
        uploadTaskPromises = [];
        document.getElementById('start-btn').disabled = true;
        document.getElementById('stop-btn').disabled = false;
        document.getElementById('status').textContent = 'Starting...';
        updateProgress();
        
        console.log('=== Download Started (3-Thread Architecture) ===');
        console.log('Threads: Main(Scroll+Find) → Fetch → Upload');
        
        // Start the download processor (manages fetch and upload threads)
        startDownloadProcessor();
        
        // Start main thread: continuous scrolling and image finding (don't await!)
        startScrollingTask();
        
        console.log('✅ All threads started');
    }
    
    // Continuous scrolling task to find and queue images
    function startScrollingTask() {
        if (scrollTaskPromise) {
            console.log('Scroll task already running');
            return;
        }
        
        let isScrollPaused = false;
        let lastScrollTime = 0;
        const minScrollInterval = 2000; // Reduced to 2 seconds for faster scanning
        
        scrollTaskPromise = (async () => {
            try {
                while (!shouldStopScrolling) {
                    // Check if we've reached the limit
                    if (downloadedCount >= MAX_NUM) {
                        console.log('✅ Reached maximum download count');
                        break;
                    }
                    
                    // Always update UI first to ensure real-time feedback
                    updateProgress();
                    
                    // Check queue size and pause/resume scrolling
                    if (taskQueue.length >= MAX_TASK_QUEUE) {
                        if (!isScrollPaused) {
                            console.log(`⏸ Task queue full (${taskQueue.length}/${MAX_TASK_QUEUE}), pausing scroll`);
                            isScrollPaused = true;
                        }
                        document.getElementById('status').textContent = `⏳ Task queue full, fetching/uploading... (Fetch:${activeFetches} Upload:${activeUploads})`;
                        
                        // Wait until queue drains
                        await new Promise(resolve => setTimeout(resolve, 500));
                        continue;
                    }
                    
                    if (isScrollPaused && taskQueue.length < MIN_TASK_QUEUE) {
                        console.log(`▶ Task queue cleared (${taskQueue.length}), resuming scroll`);
                        isScrollPaused = false;
                    }
                    
                    if (isScrollPaused) {
                        await new Promise(resolve => setTimeout(resolve, 300));
                        continue;
                    }
                    
                    // Rate limiting
                    const now = Date.now();
                    if (now - lastScrollTime < minScrollInterval) {
                        await new Promise(resolve => setTimeout(resolve, 300));
                        continue;
                    }
                    
                    // Prevent concurrent scrolling
                    if (isScrolling) {
                        console.log('⏭ Scroll in progress, skipping iteration');
                        await new Promise(resolve => setTimeout(resolve, 500));
                        continue;
                    }
                    
                    // Step 1: Find images BEFORE scrolling
                    const preScrollImages = findImages();
                    if (preScrollImages.length > 0) {
                        taskQueue.push(...preScrollImages);
                        foundCount += preScrollImages.length;
                        console.log(`📥 Queued ${preScrollImages.length} images to task queue (total found: ${foundCount}, taskQ: ${taskQueue.length})`);
                        updateProgress();
                    } else {
                        console.log('No new images found before scroll');
                    }
                    
                    // Step 2: Scroll to load more content
                    lastScrollTime = Date.now();
                    document.getElementById('status').textContent = `🔄 Scrolling... (${downloadedCount}/${MAX_NUM})`;
                    await scrollToBottom();
                    
                    if (shouldStopScrolling) break;
                    
                    // Step 3: Wait for lazy-loaded images
                    await new Promise(resolve => setTimeout(resolve, 800));
                    
                    if (shouldStopScrolling) break;
                    
                    // Step 4: Find images AFTER scrolling (catches lazy-loaded)
                    const postScrollImages = findImages();
                    if (postScrollImages.length > 0) {
                        taskQueue.push(...postScrollImages);
                        foundCount += postScrollImages.length;
                        console.log(`📥 Queued ${postScrollImages.length} more images to task queue (total found: ${foundCount}, taskQ: ${taskQueue.length})`);
                        updateProgress();
                    } else {
                        console.log('No new images found after scroll');
                    }
                    
                    // Brief pause before next iteration
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            } catch (error) {
                console.error('Scroll task error:', error);
            } finally {
                scrollTaskPromise = null;
                console.log('Scroll task ended');
            }
        })();
        
        console.log('✅ Scrolling task started (async, non-blocking)');
    }

    // Stop download process
    async function stopDownload() {
        // Signal to stop scrolling (but don't stop fetch/upload threads)
        shouldStopScrolling = true;
        isRunning = false;
        
        document.getElementById('start-btn').disabled = false;
        document.getElementById('stop-btn').disabled = true;
        
        const totalActive = activeFetches + activeUploads;
        const totalQueued = taskQueue.length + imageQueue.length;
        
        document.getElementById('status').textContent = 
            `Stopping scroll... Fetch/Upload will continue (${taskQueue.length} in taskQ, ${imageQueue.length} in imgQ, ${activeFetches} fetching, ${activeUploads} uploading)`;
        
        console.log(`🛑 Stop signal sent. TaskQ: ${taskQueue.length}, ImgQ: ${imageQueue.length}, Fetching: ${activeFetches}, Uploading: ${activeUploads}`);
        console.log('   → Fetch and Upload threads will continue processing queued items');
        
        // Only wait if there are actually active tasks
        if (totalActive > 0 || totalQueued > 0) {
            console.log(`⏳ Waiting for ${totalActive} active tasks and ${totalQueued} queued items to complete...`);
            
            // Wait a bit for tasks to finish (with timeout)
            const maxWaitTime = 30000; // 30 seconds max
            const startTime = Date.now();
            
            while ((activeFetches > 0 || activeUploads > 0 || taskQueue.length > 0 || imageQueue.length > 0) && 
                   (Date.now() - startTime < maxWaitTime)) {
                await new Promise(resolve => setTimeout(resolve, 100));
                updateProgress();
            }
            
            if (Date.now() - startTime >= maxWaitTime) {
                console.warn('⚠️ Timeout waiting for tasks to complete');
            } else {
                console.log('✅ All tasks completed');
            }
        } else {
            console.log('✅ No active tasks, proceeding immediately');
        }
        
        // Sync cache to server when all downloads are done
        document.getElementById('status').textContent = 'Syncing cache...';
        await saveCache();
        
        document.getElementById('status').textContent = `Completed - Downloaded: ${downloadedCount}, Skipped: ${skippedCount}, Total Found: ${foundCount}`;
        console.log(`=== Download Session Complete ===\nDownloaded: ${downloadedCount}\nSkipped: ${skippedCount}\nTotal Found: ${foundCount}`);
    }

    // Initialize
    async function init() {
        createUI();
        const serverUrl = GM_getValue('serverUrl', 'http://127.0.0.1:8000');
        const effectiveDir = getEffectiveDirectory();
        const savedDir = GM_getValue('downloadDir', null);
        
        console.log('Twitter Image Downloader initialized (v2.0 - Server Mode)');
        console.log('Server URL:', serverUrl);
        console.log('Directory:', effectiveDir);
        
        // Check if directory was auto-extracted from URL
        if (!savedDir) {
            const usernameMatch = window.location.pathname.match(/^\/([^\/]+)/);
            if (usernameMatch && usernameMatch[1]) {
                console.log('✓ Auto-detected username from URL:', usernameMatch[1]);
                console.log('  (Input field is empty, using placeholder default)');
            }
        } else {
            console.log('✓ Using saved directory:', savedDir);
        }
        
        console.log('Images will be saved to: [SERVER_IMG_ROOT]/' + effectiveDir + '/');
        
        // Load cache from server
        await loadCache();
    }

    // Start the script
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
