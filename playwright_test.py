from playwright.sync_api import sync_playwright
import httpx
import urllib.parse
import os
import hashlib
from PIL import Image

url = "https://www.google.com/imgres?q=shirakami%20fubuki&imgurl=https%3A%2F%2Fimages.alphacoders.com%2F130%2Fthumb-1920-1306217.jpg&imgrefurl=https%3A%2F%2Fwall.alphacoders.com%2Fbig.php%3Fi%3D1306217&docid=ZmWmOkBDMgWzGM&tbnid=hnIGoJZ53PDLWM&vet=12ahUKEwiYx52-9emTAxVybPUHHYdHAmoQnPAOegQIIBAB..i&w=1920&h=1335&hcb=2&ved=2ahUKEwiYx52-9emTAxVybPUHHYdHAmoQnPAOegQIIBAB"

def download_image():
    with sync_playwright() as p:
        # Launch browser
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()
        
        print("Navigating to Google Images...")
        page.goto(url, wait_until="networkidle")
        
        # Wait for the image viewer to load
        page.wait_for_timeout(3000)
        
        # Try to find and click on the original image link
        # Google Images usually has a "View original" or similar button
        try:
            # Look for the original image link in the page
            # Method 1: Try to find the direct image URL from the page source
            original_url = None
            
            # Extract imgurl parameter from the current URL or page
            parsed = urllib.parse.urlparse(url)
            params = urllib.parse.parse_qs(parsed.query)
            if 'imgurl' in params:
                original_url = urllib.parse.unquote(params['imgurl'][0])
                print(f"Found original URL from parameters: {original_url}")
            
            if not original_url:
                # Method 2: Try to find the image element and get its src
                img_element = page.query_selector('img[jsname]')
                if img_element:
                    original_url = img_element.get_attribute('src')
                    print(f"Found image URL from element: {original_url}")
            
            if original_url:
                print(f"Downloading original image from: {original_url}")
                
                # Download using httpx for better control
                with httpx.Client(timeout=30.0) as client:
                    response = client.get(original_url)
                    response.raise_for_status()
                    
                    # Save temporarily to get image dimensions
                    temp_path = os.path.join(os.path.dirname(__file__), "temp_image")
                    with open(temp_path, 'wb') as f:
                        f.write(response.content)
                    
                    # Get image dimensions and format
                    try:
                        img = Image.open(temp_path)
                        width, height = img.size
                        img_format = img.format.lower() if img.format else 'jpg'
                        
                        # Calculate hash sum
                        hash_sum = hashlib.md5(response.content).hexdigest()[:16]
                        
                        # Generate filename: {hashsum}_{width}x{height}.{suffix}
                        suffix = img_format if img_format in ['jpg', 'jpeg', 'png', 'gif', 'webp'] else 'jpg'
                        if suffix == 'jpeg':
                            suffix = 'jpg'
                        filename = f"{hash_sum}_{width}x{height}.{suffix}"
                        
                        # Rename to final path
                        output_path = os.path.join(os.path.dirname(__file__), filename)
                        os.rename(temp_path, output_path)
                        
                        print(f"Image saved to: {output_path}")
                        print(f"Dimensions: {width}x{height}")
                        print(f"Hash: {hash_sum}")
                        print(f"File size: {len(response.content)} bytes")
                    except Exception as e:
                        # Fallback: use original filename if PIL fails
                        os.remove(temp_path)
                        filename = os.path.basename(urllib.parse.urlparse(original_url).path)
                        if not filename or '.' not in filename:
                            filename = "downloaded_image.jpg"
                        output_path = os.path.join(os.path.dirname(__file__), filename)
                        with open(output_path, 'wb') as f:
                            f.write(response.content)
                        print(f"Image saved to: {output_path} (fallback naming)")
                        print(f"File size: {len(response.content)} bytes")
            else:
                print("Could not find original image URL")
                
        except Exception as e:
            print(f"Error: {e}")
            import traceback
            traceback.print_exc()
        
        finally:
            browser.close()

if __name__ == "__main__":
    download_image()