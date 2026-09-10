"""Split model files into <=24 MiB chunks under magenta-jam/models and write
manifest.json + README.md (with sha256 of each whole file).
usage: chunk_models.py llm=path.tflite decoder=path.tflite"""
import hashlib
import json
import os
import sys

OUT = '/home/user/tools/magenta-jam/models'
CHUNK = 24 * 1024 * 1024
os.makedirs(OUT, exist_ok=True)
manifest = {}
for arg in sys.argv[1:]:
    name, path = arg.split('=', 1)
    data = open(path, 'rb').read()
    sha = hashlib.sha256(data).hexdigest()
    chunks = []
    for i in range(0, len(data), CHUNK):
        fn = f'{name}.tflite.{i // CHUNK:02d}'
        open(os.path.join(OUT, fn), 'wb').write(data[i:i + CHUNK])
        chunks.append(fn)
    manifest[name] = {'chunks': chunks, 'bytes': len(data), 'sha256': sha, 'source': os.path.basename(path)}
    print(name, len(data), 'bytes ->', len(chunks), 'chunks', sha)
json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=2)
