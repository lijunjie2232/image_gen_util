import asyncio
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError
import json
import os
from concurrent.futures import ThreadPoolExecutor
import threading
import queue
import httpx
from pathlib import Path
from loguru import logger

# Configuration
MAX_THREADS = 1
TOTAL_PAGES = 866
DATA_FILE = "danbooru_posts.json"
MAX_DOWNLOAD_WORKERS = 4
DOWNLOAD_DIR = "danbooru_downloads"

# Thread-safe data storage
data_lock = threading.Lock()
posts_data = {}
finished_pages = set()

# Download queue
download_queue = queue.Queue()


def load_existing_data():
    """Load existing posts data from JSON file"""
    global posts_data, finished_pages
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                # Separate posts and finished pages
                posts_data = data.get("posts", {})
                finished_pages = set(data.get("finished_pages", []))
            logger.info(f"Loaded {len(posts_data)} existing posts from {DATA_FILE}")
            logger.info(f"Loaded {len(finished_pages)} finished pages")
        except Exception as e:
            logger.error(f"Error loading data file: {e}")
            posts_data = {}
            finished_pages = set()
    else:
        logger.info(f"No existing data file found, starting fresh")
        posts_data = {}
        finished_pages = set()


def save_data():
    """Save posts data to JSON file (thread-safe)"""
    with data_lock:
        try:
            data = {
                "posts": posts_data,
                "finished_pages": sorted(list(finished_pages))
            }
            with open(DATA_FILE, 'w', encoding='utf-8') as f:
                # Use compact format to reduce file size
                json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
            logger.success(f"Saved {len(posts_data)} posts and {len(finished_pages)} finished pages to {DATA_FILE}")
        except Exception as e:
            logger.error(f"Error saving data: {e}")


def add_post(post_id, image_url, url_type, tags_data=None):
    """Add a post to the data store (thread-safe)"""
    with data_lock:
        if post_id not in posts_data:
            post_info = {
                "url": image_url,
                "type": url_type  # "original_link" or "img_src"
            }
            if tags_data:
                post_info["tags"] = tags_data
            posts_data[post_id] = post_info
            return True
        return False


def add_failed_post(post_id, error_type):
    """Add a failed post to the data store (thread-safe)"""
    with data_lock:
        if post_id not in posts_data:
            posts_data[post_id] = {
                "url": None,
                "type": "failed",
                "error": error_type
            }
            return True
        return False


def mark_page_finished(page_number):
    """Mark a page as finished (thread-safe)"""
    with data_lock:
        finished_pages.add(page_number)


def download_worker(worker_id):
    """Download worker that processes the download queue"""
    logger.info(f"[Worker {worker_id}] Starting download worker")
    
    # Create a persistent httpx client for this worker
    client = httpx.Client(
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        timeout=30.0
    )
    
    downloaded_count = 0
    skipped_count = 0
    failed_count = 0
    
    try:
        while True:
            # Get task from queue (blocking)
            task = download_queue.get()
            
            # Check for end signal
            if task == "<end>":
                logger.info(f"[Worker {worker_id}] Received end signal, shutting down...")
                logger.info(f"[Worker {worker_id}] Stats - Downloaded: {downloaded_count}, Skipped: {skipped_count}, Failed: {failed_count}")
                break
            
            post_id, image_url = task
            
            try:
                # Extract file extension from URL
                ext = Path(image_url).suffix or '.jpg'
                filename = f"{post_id}{ext}"
                filepath = Path(DOWNLOAD_DIR) / filename
                
                # Skip if file already exists
                if filepath.exists():
                    logger.debug(f"[Worker {worker_id}] Skipping existing: {filename}")
                    skipped_count += 1
                    continue
                
                # Download the image
                logger.info(f"[Worker {worker_id}] Downloading: {filename}")
                response = client.get(image_url)
                response.raise_for_status()
                
                # Save the file
                filepath.parent.mkdir(parents=True, exist_ok=True)
                with open(filepath, 'wb') as f:
                    f.write(response.content)
                
                downloaded_count += 1
                logger.success(f"[Worker {worker_id}] Saved: {filename} ({len(response.content)} bytes)")
                
            except Exception as e:
                failed_count += 1
                logger.error(f"[Worker {worker_id}] Failed to download {post_id}: {type(e).__name__}: {e}")
            finally:
                # Mark task as done
                download_queue.task_done()
    
    finally:
        # Close the client when worker exits
        client.close()
        logger.info(f"[Worker {worker_id}] Client closed")


async def process_page(page_number, tags):
    """Process a single page and extract image URLs"""
    posts_url = "https://danbooru.donmai.us/posts"
    
    logger.info(f"[Page {page_number}] Starting to process page")
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        context = await browser.new_context()
        page = await context.new_page()
        
        try:
            # Navigate to the page
            params = {"page": str(page_number), "tags": tags, "limit": 10}
            query_string = "&".join([f"{key}={value}" for key, value in params.items()])
            full_url = f"{posts_url}?{query_string}"
            
            logger.info(f"[Page {page_number}] Navigating to {full_url}")
            await page.goto(full_url, timeout=30000)
            
            # Wait for posts to load
            await page.wait_for_selector("#posts", timeout=10000)
            
            # Extract post elements
            posts = await page.query_selector_all("#posts > div > div.posts-container > article")
            logger.info(f"[Page {page_number}] Found {len(posts)} posts")
            
            processed_count = 0
            skipped_count = 0
            
            # Process each post
            for idx, post in enumerate(posts, 1):
                # Get post ID
                post_id_full = await post.get_attribute("id")
                post_number_id = post_id_full.replace("post_", "") if post_id_full else None
                
                if not post_number_id:
                    logger.warning(f"[Page {page_number}] Post {idx}: No valid ID")
                    continue
                
                # Check if already processed
                if post_id_full in posts_data:
                    logger.debug(f"[Page {page_number}] Post {idx}: Already in database, skipping")
                    skipped_count += 1
                    continue
                
                logger.info(f"[Page {page_number}] Processing post {idx}/{len(posts)}: {post_id_full}")
                
                # Open detail page in new tab
                detail_page = await context.new_page()
                
                try:
                    detail_url = f"https://danbooru.donmai.us/posts/{post_number_id}"
                    await detail_page.goto(detail_url, timeout=10000)
                    
                    original_url = None
                    url_type = None
                    tags_data = None
                    
                    # Try method 1: Get from original link
                    original_link = await detail_page.query_selector("a.image-view-original-link")
                    if original_link:
                        original_url = await original_link.get_attribute("href")
                        if original_url:
                            url_type = "original_link"
                            logger.debug(f"[Page {page_number}] Got URL from original_link")
                    
                    # Try method 2: If no original link, get from #image img tag
                    if not original_url:
                        image_container = await detail_page.query_selector("#image")
                        if image_container:
                            img_tag = await image_container.query_selector("img")
                            if img_tag:
                                original_url = await img_tag.get_attribute("src")
                                if original_url:
                                    url_type = "img_src"
                                    logger.debug(f"[Page {page_number}] Got URL from img_src")
                    
                    # Extract tags information from #tag-list
                    if original_url:
                        try:
                            tag_list = await detail_page.query_selector("#tag-list > div")
                            if tag_list:
                                tags_data = await tag_list.evaluate("""
                                    (el) => {
                                        const data = {
                                            artists: [],
                                            copyrights: [],
                                            characters: [],
                                            general: []
                                        };
                                        
                                        // Extract artists
                                        const artistList = el.querySelector('ul.artist-tag-list');
                                        if (artistList) {
                                            data.artists = Array.from(artistList.querySelectorAll('li')).map(li => {
                                                const link = li.querySelector('a.search-tag');
                                                return link ? link.textContent.trim() : '';
                                            }).filter(t => t);
                                        }
                                        
                                        // Extract copyrights
                                        const copyrightList = el.querySelector('ul.copyright-tag-list');
                                        if (copyrightList) {
                                            data.copyrights = Array.from(copyrightList.querySelectorAll('li')).map(li => {
                                                const link = li.querySelector('a.search-tag');
                                                return link ? link.textContent.trim() : '';
                                            }).filter(t => t);
                                        }
                                        
                                        // Extract characters
                                        const characterList = el.querySelector('ul.character-tag-list');
                                        if (characterList) {
                                            data.characters = Array.from(characterList.querySelectorAll('li')).map(li => {
                                                const link = li.querySelector('a.search-tag');
                                                return link ? link.textContent.trim() : '';
                                            }).filter(t => t);
                                        }
                                        
                                        // Extract general tags
                                        const generalList = el.querySelector('ul.general-tag-list');
                                        if (generalList) {
                                            data.general = Array.from(generalList.querySelectorAll('li')).map(li => {
                                                const link = li.querySelector('a.search-tag');
                                                return link ? link.textContent.trim() : '';
                                            }).filter(t => t);
                                        }
                                        
                                        return data;
                                    }
                                """)
                                logger.debug(f"[Page {page_number}] Extracted tags: {len(tags_data.get('artists', []))} artists, {len(tags_data.get('characters', []))} characters, {len(tags_data.get('general', []))} general")
                        except Exception as e:
                            logger.warning(f"[Page {page_number}] Could not extract tags: {e}")
                    
                    # Add to data store if we got a URL
                    if original_url and url_type:
                        if add_post(post_id_full, original_url, url_type, tags_data):
                            processed_count += 1
                            # Add to download queue
                            download_queue.put((post_id_full, original_url))
                            logger.success(f"[Page {page_number}] Added to queue: {post_id_full}")
                        else:
                            skipped_count += 1
                            logger.debug(f"[Page {page_number}] Post already exists, skipped")
                    else:
                        # Record as failed - no image found
                        add_failed_post(post_id_full, "no_image_found")
                        skipped_count += 1
                        logger.warning(f"[Page {page_number}] No image URL found for {post_id_full}")
                        
                except PlaywrightTimeoutError:
                    # Record as failed - timeout
                    add_failed_post(post_id_full, "timeout")
                    skipped_count += 1
                    logger.warning(f"[Page {page_number}] Timeout for {post_id_full}")
                except Exception as e:
                    # Record as failed - other error
                    add_failed_post(post_id_full, f"error: {type(e).__name__}")
                    skipped_count += 1
                    logger.error(f"[Page {page_number}] Error processing {post_id_full}: {e}")
                finally:
                    await detail_page.close()
            
            logger.info(f"[Page {page_number}] Completed - Processed: {processed_count}, Skipped: {skipped_count}")
            
            # Mark page as finished
            mark_page_finished(page_number)
            
        except Exception as e:
            logger.error(f"[Page {page_number}] Page processing error: {e}")
        finally:
            await browser.close()
            logger.info(f"[Page {page_number}] Browser closed")


def run_page_sync(page_number, tags):
    """Synchronous wrapper for async page processing"""
    asyncio.run(process_page(page_number, tags))


async def main():
    tags = "shirakami_fubuki+solo"
    
    logger.info("="*80)
    logger.info("Danbooru Spider Starting")
    logger.info("="*80)
    
    # Create download directory
    Path(DOWNLOAD_DIR).mkdir(parents=True, exist_ok=True)
    logger.info(f"Download directory: {DOWNLOAD_DIR}/")
    
    # Load existing data
    load_existing_data()
    
    logger.info(f"\nConfiguration:")
    logger.info(f"  - Crawler threads: {MAX_THREADS}")
    logger.info(f"  - Download workers: {MAX_DOWNLOAD_WORKERS}")
    logger.info(f"  - Total pages: {TOTAL_PAGES}")
    logger.info(f"  - Already finished: {len(finished_pages)} pages")
    logger.info(f"  - Tags: {tags}")
    logger.info(f"  - Data file: {DATA_FILE}")
    
    # Start download workers
    logger.info(f"\nStarting {MAX_DOWNLOAD_WORKERS} download workers...")
    download_threads = []
    for i in range(MAX_DOWNLOAD_WORKERS):
        t = threading.Thread(target=download_worker, args=(i,), daemon=True)
        t.start()
        download_threads.append(t)
        logger.info(f"[Main] Started download worker {i}")
    
    # Create page numbers to process (skip finished pages)
    page_numbers = [p for p in range(1, TOTAL_PAGES + 1) if p not in finished_pages]
    logger.info(f"\nPages to process: {len(page_numbers)} (from {page_numbers[0] if page_numbers else 'N/A'} to {page_numbers[-1] if page_numbers else 'N/A'})\n")
    
    # Use thread pool to process pages in parallel
    with ThreadPoolExecutor(max_workers=MAX_THREADS) as executor:
        futures = []
        
        for page_num in page_numbers:
            future = executor.submit(run_page_sync, page_num, tags)
            futures.append(future)
        
        # Wait for all pages to complete and save after each completes
        for i, future in enumerate(futures):
            future.result()  # Wait for completion
            # Save data after each page completes
            if (i + 1) % MAX_THREADS == 0 or (i + 1) == len(futures):
                save_data()
                logger.info(f"Progress: {i + 1}/{len(futures)} pages completed\n")
    
    logger.success(f"\n{'='*80}")
    logger.success(f"Crawling complete!")
    logger.success(f"Total posts collected: {len(posts_data)}")
    logger.success(f"{'='*80}")
    
    # Send end signals to all download workers
    logger.info("\nSending end signals to download workers...")
    for _ in range(MAX_DOWNLOAD_WORKERS):
        download_queue.put("<end>")
    
    # Wait for all download workers to finish
    logger.info("Waiting for download workers to finish...")
    for t in download_threads:
        t.join()
    
    logger.success(f"\n{'='*80}")
    logger.success(f"All downloads complete!")
    logger.success(f"Data saved to: {DATA_FILE}")
    logger.success(f"Images saved to: {DOWNLOAD_DIR}/")
    logger.success(f"{'='*80}")


if __name__ == "__main__":
    asyncio.run(main())