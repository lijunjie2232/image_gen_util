#!/usr/bin/env python3
"""
Twitter Image Downloader Server
Receives images from browser extension and saves to specified directory
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Twitter Image Downloader Server")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for browser extension
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global configuration
IMG_ROOT = None


class CacheSyncRequest(BaseModel):
    """Request model for cache synchronization"""
    directory: str
    cache_data: list[str]


class DownloadStatus(BaseModel):
    """Response model for download status"""
    success: bool
    message: str
    saved_path: Optional[str] = None


@app.on_event("startup")
async def startup_event():
    """Initialize IMG_ROOT on startup"""
    global IMG_ROOT
    if IMG_ROOT is None:
        raise RuntimeError("IMG_ROOT must be set via command line argument")
    
    # Create IMG_ROOT if it doesn't exist
    Path(IMG_ROOT).mkdir(parents=True, exist_ok=True)
    print(f"Image root directory: {IMG_ROOT}")


@app.post("/download/image", response_model=DownloadStatus)
async def download_image(
    file: UploadFile = File(...),
    directory: str = Form(...),
    filename: str = Form(...)
):
    """
    Receive and save an image file
    
    Args:
        file: The image file to save
        directory: Subdirectory under IMG_ROOT (e.g., 'twitter_images')
        filename: The filename to save as
    
    Returns:
        DownloadStatus with success/failure information
    """
    try:
        # Validate directory name (prevent path traversal)
        if '..' in directory or directory.startswith('/'):
            raise HTTPException(status_code=400, detail="Invalid directory name")
        
        # Create target directory
        target_dir = Path(IMG_ROOT) / directory
        target_dir.mkdir(parents=True, exist_ok=True)
        
        # Save the file
        file_path = target_dir / filename
        
        # Read file content and save
        content = await file.read()
        with open(file_path, 'wb') as f:
            f.write(content)
        
        print(f"Saved image: {file_path}")
        
        return DownloadStatus(
            success=True,
            message="Image saved successfully",
            saved_path=str(file_path)
        )
    
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error saving image: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save image: {str(e)}")


@app.post("/cache/sync")
async def sync_cache(request: CacheSyncRequest):
    """
    Synchronize cache data with server
    
    Args:
        request: Contains directory and cache data (list of image URLs)
    
    Returns:
        Success status
    """
    try:
        # Validate directory name
        if '..' in request.directory or request.directory.startswith('/'):
            raise HTTPException(status_code=400, detail="Invalid directory name")
        
        # Create target directory
        target_dir = Path(IMG_ROOT) / request.directory
        target_dir.mkdir(parents=True, exist_ok=True)
        
        # Save cache file
        cache_file = target_dir / ".cache"
        with open(cache_file, 'w', encoding='utf-8') as f:
            json.dump(request.cache_data, f, indent=2, ensure_ascii=False)
        
        print(f"Cache synced for '{request.directory}': {len(request.cache_data)} entries")
        
        return {
            "success": True,
            "message": f"Cache synced with {len(request.cache_data)} entries",
            "cache_file": str(cache_file)
        }
    
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error syncing cache: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to sync cache: {str(e)}")


@app.get("/cache/{directory}")
async def get_cache(directory: str):
    """
    Get cache data for a specific directory
    
    Args:
        directory: Subdirectory under IMG_ROOT
    
    Returns:
        List of cached image URLs
    """
    try:
        # Validate directory name
        if '..' in directory or directory.startswith('/'):
            raise HTTPException(status_code=400, detail="Invalid directory name")
        
        cache_file = Path(IMG_ROOT) / directory / ".cache"
        
        if not cache_file.exists():
            return {"cache_data": []}
        
        with open(cache_file, 'r', encoding='utf-8') as f:
            cache_data = json.load(f)
        
        return {"cache_data": cache_data}
    
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error reading cache: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to read cache: {str(e)}")


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "img_root": IMG_ROOT
    }


def parse_args():
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(description="Twitter Image Downloader Server")
    parser.add_argument(
        "--img-root",
        type=str,
        required=True,
        help="Root directory for storing downloaded images"
    )
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="Host to bind to (default: 127.0.0.1)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Port to listen on (default: 8000)"
    )
    return parser.parse_args()


def main():
    """Main entry point"""
    global IMG_ROOT
    args = parse_args()
    
    IMG_ROOT = os.path.abspath(args.img_root)
    
    print(f"Starting Twitter Image Downloader Server")
    print(f"Image Root: {IMG_ROOT}")
    print(f"Server: http://{args.host}:{args.port}")
    print(f"\nEndpoints:")
    print(f"  POST /download/image - Upload an image")
    print(f"  POST /cache/sync     - Sync cache data")
    print(f"  GET  /cache/{{dir}}   - Get cache data")
    print(f"  GET  /health         - Health check")
    
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
