#!/usr/bin/env python3
import argparse
import hashlib
import json
import multiprocessing
import os
import re
import sys
from pathlib import Path

from loguru import logger
from PIL import Image


def sanitize_dirname(name):
    """Replace invalid characters for directory names with underscore."""
    # Keep only alphanumeric, underscore, hyphen
    return re.sub(r"[^a-zA-Z0-9_\-]", "_", name)


def process_post(task):
    """
    Process a single post: filter by size, convert to PNG, rename, and return metadata.
    """
    post_id, post_data, src_dir, out_dir, min_size = task

    url = post_data.get("url", "")
    if not url:
        return None

    ext = Path(url).suffix
    src_file = Path(src_dir) / f"post_{post_id}{ext}"

    # Double check existence (though main pre-filters)
    if not src_file.exists():
        return None

    try:
        with Image.open(src_file) as img:
            width, height = img.size
            if max(width, height) < min_size:
                return "filtered_size"
            
            # Read original bytes for hashing
            src_file_bytes = src_file.read_bytes()
            file_hash = hashlib.md5(src_file_bytes).hexdigest()

            # Determine artist and create subdirectory
            artists = post_data.get("tags", {}).get("artists", ["unknown"])
            artist_name = sanitize_dirname("_".join(artists))
            if not artist_name:
                artist_name = "unknown"

            artist_dir = Path(out_dir) / artist_name
            artist_dir.mkdir(parents=True, exist_ok=True)

            # Construct new filename and full path
            new_filename = f"{file_hash}_{post_id}_{width}x{height}.png"
            dest_file = artist_dir / new_filename

            # Transform and save as PNG
            img.save(dest_file, "PNG")

            # Extract tags for caption
            characters = post_data.get("tags", {}).get("characters", [])
            general = post_data.get("tags", {}).get("general", [])
            all_tags = characters + general
            caption = ", ".join(all_tags)

            # Relative path from out_dir for metadata.jsonl
            rel_path = dest_file.relative_to(out_dir)

            return {"file_name": str(rel_path), "text": caption}
    except Exception as e:
        logger.error(f"Error processing post_{post_id}: {e}")
        return "error"


def main():
    parser = argparse.ArgumentParser(
        description="Generate Stable Diffusion LoRA training dataset."
    )
    parser.add_argument(
        "-j",
        "--json",
        default="danbooru_posts.json",
        help="Path to danbooru_posts.json",
    )
    parser.add_argument(
        "-s",
        "--src_dir",
        default="danbooru_downloads",
        help="Directory containing source images",
    )
    parser.add_argument(
        "-o", "--out_dir", required=True, help="Output directory for the dataset"
    )
    parser.add_argument(
        "-m",
        "--min_size",
        type=int,
        default=512,
        help="Minimum size for the longest side of the image",
    )
    parser.add_argument(
        "-p",
        "--processes",
        type=int,
        default=multiprocessing.cpu_count(),
        help="Number of processes to use",
    )
    args = parser.parse_args()

    src_dir = Path(args.src_dir)
    out_dir = Path(args.out_dir)

    if not src_dir.exists():
        logger.error(f"Source directory '{src_dir}' does not exist.")
        sys.exit(1)

    out_dir.mkdir(parents=True, exist_ok=True)

    logger.info(f"Loading metadata from {args.json}...")
    try:
        with open(args.json, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        logger.error(f"Error loading JSON: {e}")
        sys.exit(1)

    posts = data.get("posts", {})
    if not posts:
        logger.error("No posts found in the JSON file.")
        sys.exit(1)

    total_posts = len(posts)
    logger.info(f"Found {total_posts} post entries in JSON.")

    # 1. Skip missing images and print calculation information first
    tasks = []
    missing_count = 0
    for post_key, post_data in posts.items():
        post_id = post_key.replace("post_", "")
        url = post_data.get("url", "")
        if not url:
            missing_count += 1
            continue
            
        ext = Path(url).suffix
        src_file = src_dir / f"post_{post_id}{ext}"
        
        if src_file.exists():
            tasks.append((post_id, post_data, args.src_dir, args.out_dir, args.min_size))
        else:
            missing_count += 1

    logger.info("--- Initial Statistics ---")
    logger.info(f"Total posts in JSON: {total_posts}")
    logger.info(f"Images found:        {len(tasks)}")
    logger.info(f"Images missing:      {missing_count} (will be skipped)")
    logger.info(f"Target min_size:     {args.min_size}px")
    logger.info(f"Output directory:    {args.out_dir}")
    logger.info("--------------------------")

    if not tasks:
        logger.warning("No valid images found to process. Exiting.")
        return

    logger.info(f"Starting processing pool with {args.processes} processes...")

    metadata_list = []
    processed_count = 0
    success_count = 0
    filtered_count = 0
    error_count = 0
    total_tasks = len(tasks)

    with multiprocessing.Pool(args.processes) as pool:
        for result in pool.imap_unordered(process_post, tasks):
            processed_count += 1
            if isinstance(result, dict):
                metadata_list.append(result)
                success_count += 1
            elif result == "filtered_size":
                filtered_count += 1
            elif result == "error":
                error_count += 1
            
            if processed_count % 100 == 0:
                logger.info(f"Progress: {processed_count}/{total_tasks} ({success_count} success, {filtered_count} small, {error_count} errors)")

    # 2. Add log for result of pool
    logger.info("--- Processing Results ---")
    logger.info(f"Total tasks:         {total_tasks}")
    logger.info(f"Successfully saved:  {success_count}")
    logger.info(f"Filtered (too small): {filtered_count}")
    logger.info(f"Errors encountered:  {error_count}")
    logger.info("--------------------------")

    # Write metadata.jsonl
    metadata_file = out_dir / "metadata.jsonl"
    logger.info(f"Writing metadata to {metadata_file}...")
    with open(metadata_file, "w", encoding="utf-8") as f:
        for entry in metadata_list:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    logger.info(f"Dataset generation complete. Saved {success_count} images to '{args.out_dir}'.")


if __name__ == "__main__":
    main()
