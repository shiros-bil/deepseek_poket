"""Extract only libc++ runtimes and notices from Google's official NDK ZIP.

HTTP range reads avoid downloading the multi-gigabyte toolchain. ZIP CRC32 is
verified, and TLS validates the official download endpoint.
"""
import json
from pathlib import Path
import struct
import urllib.request
import zlib
import hashlib

url = 'https://dl.google.com/android/repository/android-ndk-r28c-windows.zip'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open(urllib.request.Request(url, method='HEAD'), timeout=60) as r:
    size = int(r.headers['Content-Length'])
def read_range(start, end):
    request = urllib.request.Request(url, headers={'Range': f'bytes={start}-{end}'})
    with opener.open(request, timeout=60) as r:
        if r.status != 206:
            raise RuntimeError('Download server does not support HTTP ranges')
        data = r.read()
    assert len(data) == end-start+1
    return data
tail = read_range(size-65536, size-1)
end = tail.rfind(b'PK\x05\x06')
directory_size, directory_offset = struct.unpack_from('<II', tail, end+12)
directory = read_range(directory_offset, directory_offset+directory_size-1)
out = Path(__file__).resolve().parent.parent / '.tools/ndk28-runtime'
out.mkdir(parents=True, exist_ok=True)
targets = {f'android-ndk-r28c/toolchains/llvm/prebuilt/windows-x86_64/sysroot/usr/lib/{abi}/libc++_shared.so': abi+'/libc++_shared.so'
           for abi in ['aarch64-linux-android', 'arm-linux-androideabi', 'x86_64-linux-android']}
targets['android-ndk-r28c/NOTICE'] = 'NOTICE'
metadata=[]
pos=0
while pos < len(directory):
    assert directory[pos:pos+4] == b'PK\x01\x02'
    method = struct.unpack_from('<H', directory, pos+10)[0]
    crc, compressed, uncompressed = struct.unpack_from('<III', directory, pos+16)
    n, e, c = struct.unpack_from('<HHH', directory, pos+28)
    local_offset = struct.unpack_from('<I', directory, pos+42)[0]
    name = directory[pos+46:pos+46+n].decode('utf-8')
    pos += 46+n+e+c
    if name not in targets:
        continue
    header = read_range(local_offset, local_offset+29)
    ln, le = struct.unpack_from('<HH', header, 26)
    start = local_offset+30+ln+le
    packed = read_range(start, start+compressed-1)
    data = zlib.decompress(packed,-15) if method == 8 else packed
    assert len(data) == uncompressed and zlib.crc32(data) == crc
    target = out/targets.pop(name)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    metadata.append({'file':str(target.relative_to(out)), 'sha256':hashlib.sha256(data).hexdigest()})
    print('Extracted', name, len(data))
assert not targets, targets
(out/'provenance.json').write_text(json.dumps({'source':url,'files':metadata},indent=2),encoding='utf-8')
