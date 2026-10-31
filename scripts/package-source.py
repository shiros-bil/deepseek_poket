"""Package the Android project with ready native binaries, without keys/caches."""
import hashlib
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
output = root/'artifacts/DeepSeek-Pocket-source-1.3.3.zip'
paths=[]
for name in ['app','gradle','scripts','tests','third-party','upstream','native']:
    for file in (root/name).rglob('*'):
        if file.is_file() and not set(file.relative_to(root).parts).intersection({'.git','.gradle','build','__pycache__'}):
            paths.append(file)
for name in ['README.md','LICENSE','THIRD-PARTY.md','.gitignore','build.gradle','settings.gradle','gradle.properties','gradlew','gradlew.bat']:
    paths.append(root/name)
for name in ['VERIFICATION.md','APK-CHECK.json','SIGNATURE.txt','android-adapter-tests.log','android-smoke.log','ui-tests.log','android-native-tests-130.log','android-tunnel-smoke-130.log','android-settings-smoke-130.log','УСТАНОВКА.txt']:
    paths.append(root/'artifacts'/name)
for file in (root/'artifacts/screenshots').glob('*.png'):
    if file.name.startswith(('01-','02-','03-','04-','05-','06-','07-','android-1.3-')):
        paths.append(file)
manifest=[]
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
    for file in sorted(paths):
        relative=file.relative_to(root).as_posix()
        assert '.tools/' not in relative and not relative.endswith(('.keystore','.jks','signing-password.txt','local.properties'))
        archive.write(file,'DeepSeek-Pocket/'+relative)
        manifest.append({'path':relative,'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
    archive.writestr('DeepSeek-Pocket/SOURCE-MANIFEST.json',json.dumps(manifest,indent=2))
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
print(f'Source archive: {output} ({output.stat().st_size:,} bytes, {len(paths)} files, no signing keys).')
