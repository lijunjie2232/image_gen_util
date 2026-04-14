#!/usr/bin/env python3
"""
Filter images based on maximum side length.
Keeps images where max(width, height) >= specified threshold.
Useful for preparing training datasets with minimum size requirements.
"""

import sys
import os
import shutil
import hashlib
from pathlib import Path
from PIL import Image


def get_image_files(directory: Path) -> list:
    """
    Get all image files from the directory.
    
    Args:
        directory: Path to the directory
    
    Returns:
        List of image file paths sorted by name
    """
    # Common image extensions
    image_extensions = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', 
                       '.tiff', '.tif', '.svg', '.ico', '.psd'}
    
    image_files = []
    for file_path in directory.iterdir():
        if file_path.is_file() and file_path.suffix.lower() in image_extensions:
            image_files.append(file_path)
    
    # Sort by filename
    return sorted(image_files, key=lambda x: x.name)


def calculate_file_hash(file_path: Path) -> str:
    """
    Calculate SHA256 hash of a file.
    
    Args:
        file_path: Path to the file
    
    Returns:
        Hex digest of the hash (first 16 characters)
    """
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()[:16]


def get_image_max_side(file_path: Path) -> tuple:
    """
    Get the maximum side (width or height) and dimensions of an image.
    
    Args:
        file_path: Path to the image file
    
    Returns:
        Tuple of (max_side, width, height) or None if failed
    """
    try:
        with Image.open(file_path) as img:
            width, height = img.size
            max_side = max(width, height)
            return max_side, width, height
    except Exception as e:
        print(f"Warning: Could not read {file_path.name}: {e}", file=sys.stderr)
        return None


def filter_images_by_size(image_files: list, min_max_side: int) -> tuple:
    """
    Filter images based on maximum side length.
    
    Args:
        image_files: List of image file paths
        min_max_side: Minimum required maximum side length
    
    Returns:
        Tuple of (kept_files, filtered_out_files)
        Each kept_file is (file_path, max_side, width, height)
        Each filtered_out_file is (file_path, max_side)
    """
    kept_files = []
    filtered_out_files = []
    
    for file_path in image_files:
        result = get_image_max_side(file_path)
        
        if result is None:
            print(f"Skipping {file_path.name} (could not read dimensions)")
            continue
        
        max_side, width, height = result
        
        if max_side >= min_max_side:
            kept_files.append((file_path, max_side, width, height))
        else:
            filtered_out_files.append((file_path, max_side))
    
    return kept_files, filtered_out_files


def generate_new_filename(file_path: Path, width: int, height: int) -> str:
    """
    Generate new filename in format: {hashsum}_{width}_{height}.{extension}
    
    Args:
        file_path: Original file path
        width: Image width
        height: Image height
    
    Returns:
        New filename string
    """
    hashsum = calculate_file_hash(file_path)
    extension = file_path.suffix.lower()
    new_name = f"{hashsum}_{width}_{height}{extension}"
    return new_name


def copy_and_rename_filtered_images(kept_files: list, output_dir: Path):
    """
    Copy kept images to output directory with renamed filenames.
    New format: {hashsum}_{width}_{height}.{extension}
    
    Args:
        kept_files: List of (file_path, max_side, width, height) tuples
        output_dir: Destination directory
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    
    renamed_count = 0
    for file_path, max_side, width, height in kept_files:
        new_filename = generate_new_filename(file_path, width, height)
        dest_path = output_dir / new_filename
        shutil.copy2(file_path, dest_path)
        print(f"Copied: {file_path.name} -> {new_filename} (max side: {max_side}px)")
        renamed_count += 1
    
    return renamed_count


def main():
    """Main entry point."""
    import argparse
    
    parser = argparse.ArgumentParser(
        description='Filter images based on maximum side length for training datasets.'
    )
    parser.add_argument(
        'input_dir',
        help='Input directory containing images'
    )
    parser.add_argument(
        '--min-size',
        type=int,
        default=1024,
        help='Minimum required maximum side length (default: 1024)'
    )
    parser.add_argument(
        '--output-dir',
        '-o',
        help='Output directory for filtered images (optional, if not provided only lists results)'
    )
    parser.add_argument(
        '--list-only',
        action='store_true',
        help='Only list filtered results without copying files'
    )
    
    args = parser.parse_args()
    
    input_dir = Path(args.input_dir)
    min_max_side = args.min_size
    output_dir = Path(args.output_dir) if args.output_dir else None
    
    # Check if input directory exists
    if not input_dir.exists():
        print(f"Error: Directory '{input_dir}' does not exist.", file=sys.stderr)
        sys.exit(1)
    
    if not input_dir.is_dir():
        print(f"Error: '{input_dir}' is not a directory.", file=sys.stderr)
        sys.exit(1)
    
    # Get image files
    print(f"Scanning directory: {input_dir.absolute()}")
    image_files = get_image_files(input_dir)
    
    if not image_files:
        print("No image files found in the directory.")
        sys.exit(0)
    
    print(f"Found {len(image_files)} image files")
    print(f"Filtering images with max side >= {min_max_side}px...\n")
    
    # Filter images
    kept_files, filtered_out_files = filter_images_by_size(image_files, min_max_side)
    
    # Print results
    print("=" * 60)
    print("FILTERING RESULTS")
    print("=" * 60)
    print(f"Total images scanned: {len(image_files)}")
    print(f"Images kept (max side >= {min_max_side}px): {len(kept_files)}")
    print(f"Images filtered out: {len(filtered_out_files)}")
    print()
    
    if kept_files:
        print("KEPT IMAGES:")
        print("-" * 40)
        for file_path, max_side, width, height in kept_files:
            print(f"  ✓ {file_path.name} (max side: {max_side}px, dimensions: {width}x{height})")
        print()
    
    if filtered_out_files:
        print("FILTERED OUT IMAGES:")
        print("-" * 40)
        for file_path, max_side in filtered_out_files:
            print(f"  ✗ {file_path.name} (max side: {max_side}px)")
        print()
    
    # Copy files if output directory is specified
    if output_dir and not args.list_only:
        print(f"\nCopying and renaming {len(kept_files)} images to: {output_dir.absolute()}")
        print(f"New naming format: {{hashsum}}_{{width}}_{{height}}.{{extension}}\n")
        renamed_count = copy_and_rename_filtered_images(kept_files, output_dir)
        print(f"\nDone! {renamed_count} images copied and renamed to {output_dir.absolute()}")
    elif args.list_only:
        print("\nList-only mode. No files were copied.")
    else:
        print("\nNo output directory specified. Use --output-dir to copy filtered images.")


if __name__ == "__main__":
    main()
