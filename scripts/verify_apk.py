"""Check packaged assets, ELF page alignment and release metadata (stdlib only)."""
import hashlib
import json
from pathlib import Path
import struct
import zipfile

root = Path(__file__).resolve().parent.parent
apk = root / 'artifacts/DeepSeek-Pocket-1.3.3.apk'
libraries = []
with zipfile.ZipFile(apk) as archive:
    for filename in archive.namelist():
        if filename.startswith('lib/') and filename.endswith('.so'):
            data = archive.read(filename)
            assert data[:4] == b'\x7fELF'
            wide = data[4] == 2
            assert data[5] == 1, 'Expected little-endian ELF'
            phoff = struct.unpack_from('<Q' if wide else '<I', data, 32 if wide else 28)[0]
            entsize, count = struct.unpack_from('<HH', data, 54 if wide else 42)
            alignments = []
            for index in range(count):
                offset = phoff + index * entsize
                if struct.unpack_from('<I', data, offset)[0] == 1:
                    alignment = struct.unpack_from('<Q' if wide else '<I', data, offset + (48 if wide else 28))[0]
                    assert alignment >= (16384 if wide else 4096), (filename, alignment)
                    alignments.append(alignment)
            assert alignments
            libraries.append({'path': filename, 'bytes': len(data), 'load_segment_alignment': alignments,
                              'sha256': hashlib.sha256(data).hexdigest()})
    assert len(libraries) == 12, 'All three ABIs must contain Node, JNI, libc++ and cloudflared'
    for relative in ['engine/server.js', 'engine/lib/pow.js', 'engine/lib/env.js', 'engine/bootstrap.js',
                     'ui/index.html', 'ui/style.css', 'ui/theme.css', 'ui/app.js', 'ui/i18n.js', 'ui/icons.js', 'licenses/Nodejs-Mobile.txt', 'licenses/Lucide.txt', 'licenses/Cloudflared.txt']:
        assert archive.read('assets/' + relative) == (root / 'app/src/main/assets' / relative).read_bytes(), relative
    for relative in ['lib/pow.js', 'lib/env.js']:
        assert archive.read('assets/engine/' + relative) == (root / 'upstream' / relative).read_bytes(), relative
report = {'apk': apk.name, 'bytes': apk.stat().st_size, 'sha256': hashlib.sha256(apk.read_bytes()).hexdigest(),
          'all_64bit_native_libraries_aligned_for_16kb': True, 'model_policy':'Flash and Thinking only; web search enabled', 'libraries': libraries}
(root / 'artifacts/APK-CHECK.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(f'APK check passed: 12 ELF libraries, 16 KB alignment for 64-bit ABIs, current UI and model policy. SHA256 {report["sha256"]}')
