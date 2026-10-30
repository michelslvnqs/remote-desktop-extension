import sys
import os
import zipfile

def main():
    if len(sys.argv) < 3:
        print("Uso: python make-zip.py <diretorio_fonte> <arquivo_zip>")
        sys.exit(1)

    source_dir = os.path.abspath(sys.argv[1])
    zip_target = os.path.abspath(sys.argv[2])

    target_dir = os.path.dirname(zip_target)
    if target_dir and not os.path.exists(target_dir):
        os.makedirs(target_dir, exist_ok=True)

    if os.path.exists(zip_target):
        os.remove(zip_target)

    # Cria o zip garantindo separador POSIX ('/') para total compatibilidade com AMO (Firefox) e Chrome Store
    with zipfile.ZipFile(zip_target, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in sorted(os.walk(source_dir)):
            dirs.sort()
            for f in sorted(files):
                full_path = os.path.join(root, f)
                rel_path = os.path.relpath(full_path, source_dir).replace('\\', '/')
                z.write(full_path, rel_path)

    print(f"[make-zip] Zip criado com sucesso: {zip_target}")

if __name__ == '__main__':
    main()
