#!/usr/bin/env python3
import os
import argparse
import hashlib
import multiprocessing
from pathlib import Path
from PIL import Image
from functools import partial

def calculate_hash(file_path):
    """Calculate SHA256 hash of a file (first 16 chars)."""
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()[:16]

def process_single_image(img_path, input_root, output_root, target_size, min_long_side):
    """
    Processes a single image: filters, resizes, pads to square, and renames.
    """
    try:
        with Image.open(img_path) as img:
            # 1. Filter by size
            w, h = img.size
            if max(w, h) < min_long_side:
                return f"Skipped: {img_path.name} (longest side {max(w, h)} < {min_long_side})"

            # 2. Preparation
            # Handle palette images with transparency to avoid UserWarning
            if img.mode == 'P' and 'transparency' in img.info:
                img = img.convert('RGBA')
            
            if img.mode != 'RGB':
                img = img.convert('RGB')
            
            # 3. Optimize Resize Logic
            # Resize so the longest side matches target_size
            ratio = target_size / max(w, h)
            new_w, new_h = int(w * ratio), int(h * ratio)
            img_resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

            # 4. Create Square Canvas (Padding)
            new_img = Image.new("RGB", (target_size, target_size), (0, 0, 0))
            paste_x = (target_size - new_w) // 2
            paste_y = (target_size - new_h) // 2
            new_img.paste(img_resized, (paste_x, paste_y))

            # 5. Generate New Filename: {hashsum}_{width}x{height}.png
            hashsum = calculate_hash(img_path)
            # Use original dimensions in filename as requested
            new_filename = f"{hashsum}_{w}x{h}.png"
            
            # Maintain directory structure
            relative_dir = img_path.relative_to(input_root).parent
            target_dir = output_root / relative_dir
            target_dir.mkdir(parents=True, exist_ok=True)
            
            final_path = target_dir / new_filename
            new_img.save(final_path, "PNG", optimize=True)
            
            return f"Processed: {img_path.name} -> {final_path.relative_to(output_root)}"

    except Exception as e:
        return f"Error processing {img_path.name}: {str(e)}"

def main():
    parser = argparse.ArgumentParser(description="Process dataset: Resize/Pad to square and Rename.")
    parser.add_argument("input_dir", help="Source directory")
    parser.add_argument("output_dir", help="Target directory")
    parser.add_argument("--size", type=int, default=1920, help="Target square size (default: 1920)")
    parser.add_argument("--min-size", type=int, default=1080, help="Minimum longest side to keep (default: 1080)")
    parser.add_argument("--workers", type=int, default=multiprocessing.cpu_count(), help="Number of workers")
    
    args = parser.parse_args()
    
    input_root = Path(args.input_dir).resolve()
    output_root = Path(args.output_dir).resolve()
    
    if not input_root.exists():
        print(f"Error: {input_root} not found.")
        return

    image_extensions = {'.jpg', '.jpeg', '.png', '.webp', '.bmp'}
    all_files = [f for f in input_root.rglob("*") if f.suffix.lower() in image_extensions]
    
    print(f"Found {len(all_files)} images. Processing with {args.workers} workers...")
    print(f"Settings: Square Size={args.size}, Min Long Side={args.min_size}")
    print("-" * 50)

    # Use multiprocessing
    worker_func = partial(
        process_single_image, 
        input_root=input_root, 
        output_root=output_root, 
        target_size=args.size, 
        min_long_side=args.min_size
    )

    with multiprocessing.Pool(args.workers) as pool:
        for result in pool.imap_unordered(worker_func, all_files):
            print(result)

    print("-" * 50)
    print("Done!")

if __name__ == "__main__":
    main()
