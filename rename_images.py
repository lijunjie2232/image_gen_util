import os
import hashlib
from PIL import Image
import sys
import argparse


def rename_images_in_directory(directory_path, force=False, recursive=False):
    """重命名指定目录中的所有图片文件"""
    if not os.path.exists(directory_path):
        print(f"Error: Directory '{directory_path}' does not exist")
        return
    
    # 支持的图片格式
    supported_extensions = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff'}
    
    # 获取所有图片文件
    image_files = []
    if recursive:
        # 递归遍历所有子目录
        for root, dirs, files in os.walk(directory_path):
            for filename in files:
                file_path = os.path.join(root, filename)
                ext = os.path.splitext(filename)[1].lower()
                if ext in supported_extensions:
                    image_files.append(file_path)
    else:
        # 仅处理当前目录
        for filename in os.listdir(directory_path):
            file_path = os.path.join(directory_path, filename)
            if os.path.isfile(file_path):
                ext = os.path.splitext(filename)[1].lower()
                if ext in supported_extensions:
                    image_files.append(file_path)
    
    if not image_files:
        print(f"No image files found in '{directory_path}'")
        return
    
    print(f"Found {len(image_files)} image files to process\n")
    
    renamed_count = 0
    skipped_count = 0
    error_count = 0
    
    for i, file_path in enumerate(image_files, 1):
        filename = os.path.basename(file_path)
        file_dir = os.path.dirname(file_path)
        print(f"[{i}/{len(image_files)}] Processing: {filename}")
        
        try:
            # 读取图片文件
            with open(file_path, 'rb') as f:
                content = f.read()
            
            # 计算哈希值
            hash_sum = hashlib.md5(content).hexdigest()[:16]
            
            # 获取图片尺寸和格式
            img = Image.open(file_path)
            actual_width, actual_height = img.size
            img_format = img.format.lower() if img.format else 'jpg'
            
            # 确定文件扩展名
            suffix = img_format if img_format in ['jpg', 'jpeg', 'png', 'gif', 'webp'] else 'jpg'
            if suffix == 'jpeg':
                suffix = 'jpg'
            
            # 生成新文件名: {hashsum}_{width}x{height}.{suffix}
            new_filename = f"{hash_sum}_{actual_width}x{actual_height}.{suffix}"
            new_path = os.path.join(file_dir, new_filename)
            
            # 检查是否需要重命名
            if file_path == new_path:
                print(f"  ✓ Already correctly named")
                skipped_count += 1
            elif os.path.exists(new_path):
                if force:
                    # 强制覆盖已存在的文件
                    os.remove(new_path)
                    os.rename(file_path, new_path)
                    print(f"  ✓ Renamed to: {new_filename} (overwritten)")
                    print(f"    Dimensions: {actual_width}x{actual_height}")
                    print(f"    Hash: {hash_sum}")
                    renamed_count += 1
                else:
                    print(f"  ⚠ File already exists: {new_filename}")
                    print(f"    Skipping to avoid overwrite (use -f to force)")
                    skipped_count += 1
            else:
                # 重命名文件
                os.rename(file_path, new_path)
                print(f"  ✓ Renamed to: {new_filename}")
                print(f"    Dimensions: {actual_width}x{actual_height}")
                print(f"    Hash: {hash_sum}")
                renamed_count += 1
            
        except Exception as e:
            print(f"  ✗ Error processing {filename}: {e}")
            error_count += 1
        
        print()
    
    # 打印总结
    print("="*60)
    print("Rename Summary:")
    print(f"  Total files: {len(image_files)}")
    print(f"  Renamed: {renamed_count}")
    print(f"  Skipped: {skipped_count}")
    print(f"  Errors: {error_count}")
    print("="*60)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Rename image files in a directory')
    parser.add_argument('directory_path', help='Path to the directory containing images')
    parser.add_argument('-f', '--force', action='store_true', help='Force override existing files')
    parser.add_argument('-r', '--recursive', action='store_true', help='Recursively process subdirectories')
    
    args = parser.parse_args()
    rename_images_in_directory(args.directory_path, force=args.force, recursive=args.recursive)
