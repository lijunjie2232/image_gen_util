// ==UserScript==
// @name         Google Image Search Downloader
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Collect image URLs from Google Image Search and send to server for processing
// @author       lijunjie2232
// @match        https://www.google.com/search*
// @match        https://google.com/search*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const SERVER_URL = GM_getValue('serverUrl', 'http://127.0.0.1:8000');
    let MAX_NUM = GM_getValue('maxNum', 100);

    function getDefaultDirectory() {
        // Extract search query from URL
        const urlParams = new URLSearchParams(window.location.search);
        const query = urlParams.get('q') || 'google_images';
        // Clean up the query to make it a valid directory name
        const cleanQuery = query.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
        return cleanQuery || 'google_images';
    }

    function getEffectiveDirectory() {
        const savedDir = GM_getValue('downloadDir', null);
        return savedDir || getDefaultDirectory();
    }

    let isRunning = false;
    let foundCount = 0;
    let sentCount = 0;
    let collectedUrls = new Set();
    let isUIHidden = false;
    let sendTimeoutId = null; // Store timeout ID for cancellation

    // Send a single URL to server synchronously
    function sendUrlToServer(url) {
        const dir = getEffectiveDirectory();

        try {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `${SERVER_URL}/google/batch/urls`,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({
                    directory: dir,
                    urls: [url],
                    max_num: MAX_NUM
                }),
                synchronous: true,
                onload: (response) => {
                    if (response.status === 200) {
                        console.log(`✅ Sent URL to server`);
                        sentCount++;
                        updateProgress();
                    } else {
                        console.error('Server error:', response.status);
                    }
                },
                onerror: (error) => {
                    console.error('Error sending URL:', error);
                }
            });
        } catch (error) {
            console.error('Error sending URL:', error);
        }
    }

    // Create UI
    function createUI() {
        const ui = document.createElement('div');
        ui.id = 'google-image-collector-ui';
        ui.style.cssText = `
            position: fixed; top: 20px; right: 20px;
            background: linear-gradient(135deg, #4285f4 0%, #34a853 100%);
            color: white; padding: 20px; border-radius: 12px;
            z-index: 10000; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            min-width: 280px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.18);
        `;

        ui.innerHTML = `
            <div id="ui-full">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                    <h3 style="margin: 0; font-size: 18px;">📥 Google Image Collector</h3>
                    <button id="toggle-ui-btn" style="background: rgba(255,255,255,0.2); border: none; border-radius: 6px; padding: 6px 10px; cursor: pointer;">➖</button>
                </div>
                
                <div style="background: rgba(255,255,255,0.1); padding: 12px; border-radius: 8px; margin-bottom: 12px;">
                    <div style="margin-bottom: 10px;">
                        <label style="display: block; font-size: 12px; margin-bottom: 5px;">Server URL:</label>
                        <input type="text" id="server-url" value="${SERVER_URL}" style="width: 100%; padding: 8px; border: none; border-radius: 6px; box-sizing: border-box;">
                    </div>
                    <div style="margin-bottom: 10px;">
                        <label style="display: block; font-size: 12px; margin-bottom: 5px;">Max Images:</label>
                        <input type="number" id="max-num" value="${MAX_NUM}" style="width: 100%; padding: 8px; border: none; border-radius: 6px; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="display: block; font-size: 12px; margin-bottom: 5px;">Directory:</label>
                        <input type="text" id="download-dir" value="${GM_getValue('downloadDir', '')}" placeholder="${getDefaultDirectory()}" style="width: 100%; padding: 8px; border: none; border-radius: 6px; box-sizing: border-box;">
                    </div>
                </div>
                
                <div style="background: rgba(255,255,255,0.15); padding: 12px; border-radius: 8px; margin-bottom: 12px;">
                    <div style="display: flex; justify-content: space-between;">
                        <span style="font-size: 12px;">Progress:</span>
                        <span style="font-size: 14px; font-weight: 600;"><span id="found-count">0</span> found | <span id="sent-count">0</span> sent</span>
                    </div>
                </div>
                
                <div style="display: flex; gap: 8px; margin-bottom: 10px;">
                    <button id="start-btn" style="flex: 1; background: #4CAF50; color: white; border: none; padding: 10px; border-radius: 8px; cursor: pointer; font-weight: 600;">▶ Start</button>
                    <button id="stop-btn" style="flex: 1; background: #f44336; color: white; border: none; padding: 10px; border-radius: 8px; cursor: pointer; font-weight: 600;" disabled>⏹ Stop</button>
                </div>
                
                <div id="status" style="font-size: 11px; text-align: center; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 6px;">Ready</div>
            </div>
            
            <div id="ui-icon" style="display: none; cursor: pointer; width: 50px; height: 50px; border-radius: 50%; background: linear-gradient(135deg, #4285f4 0%, #34a853 100%); box-shadow: 0 4px 12px rgba(0,0,0,0.3); align-items: center; justify-content: center; font-size: 24px;">📥</div>
        `;

        document.body.appendChild(ui);

        document.getElementById('start-btn').addEventListener('click', startCollection);
        document.getElementById('stop-btn').addEventListener('click', stopCollection);
        document.getElementById('toggle-ui-btn').addEventListener('click', toggleUI);
        document.getElementById('ui-icon').addEventListener('click', toggleUI);

        document.getElementById('server-url').addEventListener('change', (e) => GM_setValue('serverUrl', e.target.value.trim()));
        document.getElementById('max-num').addEventListener('change', (e) => { MAX_NUM = parseInt(e.target.value); GM_setValue('maxNum', MAX_NUM); });
        document.getElementById('download-dir').addEventListener('change', (e) => {
            const value = e.target.value.trim();
            GM_setValue('downloadDir', value || null);
        });
    }

    function toggleUI() {
        const fullUI = document.getElementById('ui-full');
        const icon = document.getElementById('ui-icon');
        const toggleBtn = document.getElementById('toggle-ui-btn');
        const ui = document.getElementById('google-image-collector-ui');

        if (isUIHidden) {
            fullUI.style.display = 'block';
            icon.style.display = 'none';
            toggleBtn.textContent = '➖';
            ui.style.padding = '20px';
            ui.style.background = 'linear-gradient(135deg, #4285f4 0%, #34a853 100%)';
            isUIHidden = false;
        } else {
            fullUI.style.display = 'none';
            icon.style.display = 'flex';
            toggleBtn.textContent = '➕';
            ui.style.padding = '0';
            ui.style.background = 'transparent';
            isUIHidden = true;
        }
    }

    function updateProgress() {
        document.getElementById('found-count').textContent = foundCount;
        document.getElementById('sent-count').textContent = sentCount;
        document.getElementById('status').textContent = `Found: ${foundCount} | Sent: ${sentCount}`;
    }

    // Find Google Image result URLs
    function findImageUrls() {
        const urls = [];
                
        // Look for image containers with jsname="dTDiAc"
        const imageContainers = document.querySelectorAll('div[jsname="dTDiAc"]');
        console.log(`Found ${imageContainers.length} image containers`);
            
        // Debug: Check structure of first container
        if (imageContainers.length > 0) {
            const firstContainer = imageContainers[0];
            console.log('First container HTML structure:');
            console.log('- Has div[jsname="qQjpJ"]:', !!firstContainer.querySelector('div[jsname="qQjpJ"]'));
            console.log('- Has h3:', !!firstContainer.querySelector('h3'));
            console.log('- Has a[href*="/imgres?"]:', !!firstContainer.querySelector('a[href*="/imgres?"]'));
                
            // Try different selectors
            const allLinks = firstContainer.querySelectorAll('a[href]');
            console.log(`- Total links in container: ${allLinks.length}`);
            allLinks.forEach((link, idx) => {
                console.log(`  Link ${idx}: ${link.href.substring(0, 100)}...`);
            });
        }
                
        imageContainers.forEach((container, index) => {
            let imageUrl = null;
                    
            // Method 1: Try to find any link with /imgres?
            try {
                const imgresLink = container.querySelector('a[href*="/imgres?"]');
                    
                if (imgresLink && imgresLink.href) {
                    const href = imgresLink.href;
                    console.log(`Container ${index}: Found /imgres? link`);
                    imageUrl = href;
                } else {
                    if (index < 3) { // Only log first 3 containers
                        console.log(`Container ${index}: No /imgres? link found`);
                        // Debug: show what's inside
                        const allDivs = container.querySelectorAll('div');
                        console.log(`  - Total divs: ${allDivs.length}`);
                        allDivs.forEach((div, i) => {
                            if (i < 5) { // Show first 5 divs
                                const jsname = div.getAttribute('jsname');
                                const className = div.className;
                                console.log(`    Div ${i}: jsname="${jsname}", class="${className}"`);
                            }
                        });
                    }
                }
            } catch (e) {
                console.warn(`Container ${index}: querySelector failed:`, e);
            }
                    
            // Add to results if valid and not already collected
            if (imageUrl && !collectedUrls.has(imageUrl)) {
                collectedUrls.add(imageUrl);
                urls.push(imageUrl);
                console.log(`✓ Added URL ${urls.length}: ${imageUrl.substring(0, 60)}...`);
            }
        });
        
        if (urls.length > 0) {
            foundCount += urls.length;
            updateProgress();
            console.log(`✓ Found ${urls.length} new image URLs (Total: ${foundCount})`);
        } else {
            console.log('⚠ No new image URLs found');
        }
        
        return urls;
    }



    // Main collection - no scrolling, just collect current page
    function startCollection() {
        if (isRunning) return;

        isRunning = true;
        foundCount = 0;
        sentCount = 0;
        collectedUrls = new Set();

        document.getElementById('start-btn').disabled = true;
        document.getElementById('stop-btn').disabled = false;
        document.getElementById('status').textContent = 'Collecting...';
        updateProgress();

        console.log('=== Google Image Collection Started ===');

        // Find all image URLs on current page
        const allUrls = findImageUrls();
        console.log(`Found ${allUrls.length} image URLs`);

        // Send them to server synchronously one by one
        if (allUrls.length > 0) {
            let index = 0;
            
            function sendNext() {
                // Check if stopped
                if (!isRunning) {
                    console.log('🛑 Send loop stopped');
                    return;
                }

                if (index >= allUrls.length || sentCount >= MAX_NUM) {
                    // Finished
                    document.getElementById('status').textContent = `Completed - Found: ${foundCount}, Sent: ${sentCount}`;
                    document.getElementById('start-btn').disabled = false;
                    document.getElementById('stop-btn').disabled = true;
                    isRunning = false;
                    sendTimeoutId = null;
                    console.log(`=== Collection Complete ===\nFound: ${foundCount}\nSent: ${sentCount}`);
                    return;
                }

                sendUrlToServer(allUrls[index]);
                index++;
                
                // Continue with next URL
                sendTimeoutId = setTimeout(sendNext, 100);
            }
            
            sendNext();
        } else {
            document.getElementById('status').textContent = 'No images found on current page';
            document.getElementById('start-btn').disabled = false;
            document.getElementById('stop-btn').disabled = true;
            isRunning = false;
        }
    }

    // Stop collection
    function stopCollection() {
        isRunning = false;
        
        // Cancel any pending timeout
        if (sendTimeoutId !== null) {
            clearTimeout(sendTimeoutId);
            sendTimeoutId = null;
            console.log('🛑 Cancelled pending send timeout');
        }

        document.getElementById('start-btn').disabled = false;
        document.getElementById('stop-btn').disabled = true;
        document.getElementById('status').textContent = `Stopped - Found: ${foundCount}, Sent: ${sentCount}`;

        console.log('🛑 Collection stopped');
    }

    // Initialize
    function init() {
        createUI();
        console.log('Google Image Collector initialized');
        console.log('Server URL:', SERVER_URL);
        console.log('Directory:', getEffectiveDirectory());
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
