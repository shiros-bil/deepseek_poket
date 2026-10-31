param(
    [string]$SdkPath = $env:ANDROID_HOME,
    [string]$NdkPath = '',
    [string]$CxxRuntimePath = '',
    [switch]$RebuildNative
)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
Push-Location $projectRoot
try {
    if(!$SdkPath) { $SdkPath=Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
    if(!(Test-Path "$SdkPath/platforms/android-34/android.jar")) { throw 'Установите Android SDK Platform 34 и передайте -SdkPath.' }
    $localFile=Join-Path $projectRoot 'local.properties'
    $sdkSetting='sdk.dir='+$SdkPath.Replace('\','/')
    if(!(Test-Path $localFile) -or [IO.File]::ReadAllText($localFile).Trim() -ne $sdkSetting){
        if(Test-Path $localFile){[IO.File]::SetAttributes($localFile,[IO.FileAttributes]::Normal)}
        [IO.File]::WriteAllText($localFile,$sdkSetting,[Text.UTF8Encoding]::new($false))
    }
    foreach($abi in @('arm64-v8a','armeabi-v7a','x86_64')){if(!(Test-Path "app/src/main/jniLibs/$abi/libcloudflared.so")){throw "Build cloudflared for $abi with scripts/build-cloudflared.ps1 first."}}
    $nativeReady=(Test-Path 'app/src/main/jniLibs/arm64-v8a/libpocket.so') -and (Test-Path 'app/src/main/jniLibs/armeabi-v7a/libpocket.so') -and (Test-Path 'app/src/main/jniLibs/x86_64/libpocket.so')
    if($RebuildNative -or !$nativeReady) {
        if(!$NdkPath) { $NdkPath=Join-Path $projectRoot '.tools/android-ndk-r27c' }
        $llvm=Join-Path $NdkPath 'toolchains/llvm/prebuilt/windows-x86_64'
        if(!(Test-Path "$llvm/bin/clang++.exe")) { throw 'Для нативной сборки установите Android NDK r27c и передайте -NdkPath.' }
        New-Item -ItemType Directory -Force .tools | Out-Null
        if(!(Test-Path '.tools/node-android-24/bin/arm64-v8a/libnode.so')) {
            $ProgressPreference='SilentlyContinue'
            Invoke-WebRequest 'https://github.com/digidem/nodejs-mobile/releases/download/v24.20.0-0/nodejs-mobile-android-24.20.0-0.zip' -OutFile .tools/node-android-24.zip
            $expected='f5ffbaf4f2679fa9180b0758c637c2f8fc8828300f95129badf213a028fb37bb'
            if((Get-FileHash .tools/node-android-24.zip -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw 'Node.js archive SHA256 mismatch.' }
            Expand-Archive .tools/node-android-24.zip .tools/node-android-24 -Force
        }
        foreach($abi in @(@('arm64-v8a','aarch64-linux-android','aarch64-linux-android'),@('armeabi-v7a','armv7a-linux-androideabi','arm-linux-androideabi'),@('x86_64','x86_64-linux-android','x86_64-linux-android'))) {
            $dest=Join-Path $projectRoot ('app/src/main/jniLibs/'+$abi[0]);New-Item -ItemType Directory -Force $dest | Out-Null
            Copy-Item ('.tools/node-android-24/bin/'+$abi[0]+'/libnode.so') $dest -Force
            $runtimeRoot=if($CxxRuntimePath){$CxxRuntimePath}else{Join-Path $projectRoot '.tools/ndk28-runtime'}
            $runtime=Join-Path $runtimeRoot ($abi[2]+'/libc++_shared.so')
            if(Test-Path $runtime){Copy-Item $runtime $dest -Force}
            elseif(!(Test-Path "$dest/libc++_shared.so")){throw 'Нужен libc++ из NDK r28c: выполните python scripts/fetch-cxx-runtime.py либо передайте -CxxRuntimePath.'}
            & "$llvm/bin/llvm-strip.exe" --strip-unneeded "$dest/libc++_shared.so"
            & "$llvm/bin/clang++.exe" ('--target='+$abi[1]+'26') ('--sysroot='+$llvm+'/sysroot') -shared -fPIC -O2 '-std=c++17' -nostdlib++ '-Wl,-z,max-page-size=16384' '-Wl,-z,common-page-size=16384' app/src/main/cpp/bridge.cpp ('-L'+$dest) -lnode -o ($dest+'/libpocket.so')
            if($LASTEXITCODE) { throw 'Ошибка сборки JNI.' }
        }
    }
    & ./gradlew.bat :app:assembleRelease :app:lintDebug --console=plain
    if($LASTEXITCODE) { throw 'Gradle завершился с ошибкой.' }
    New-Item -ItemType Directory -Force .tools,artifacts | Out-Null
    $keyFile=Join-Path $projectRoot '.tools/deepseek-pocket.keystore'
    $passFile=Join-Path $projectRoot '.tools/signing-password.txt'
    if(!(Test-Path $keyFile)) {
        $secretBytes=New-Object byte[] 32
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($secretBytes)
        [IO.File]::WriteAllText($passFile,[Convert]::ToBase64String($secretBytes),[Text.UTF8Encoding]::new($false))
        & keytool -genkeypair -keystore $keyFile -storepass:file $passFile -keypass:file $passFile -alias pocket -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=DeepSeek Pocket, O=Local Android Build'
        if($LASTEXITCODE) { throw 'Не удалось создать ключ подписи.' }
    }
    $buildTools=Join-Path $SdkPath 'build-tools/34.0.0'
    & "$buildTools/zipalign.exe" -f -p 4 app/build/outputs/apk/release/app-release-unsigned.apk artifacts/DeepSeek-Pocket-1.3.3-aligned.apk
    if($LASTEXITCODE) { throw 'zipalign завершился с ошибкой.' }
    & "$buildTools/apksigner.bat" sign --ks $keyFile --ks-key-alias pocket --ks-pass ('file:'+$passFile) --out artifacts/DeepSeek-Pocket-1.3.3.apk artifacts/DeepSeek-Pocket-1.3.3-aligned.apk
    if($LASTEXITCODE) { throw 'Не удалось подписать APK.' }
    & "$buildTools/apksigner.bat" verify --verbose artifacts/DeepSeek-Pocket-1.3.3.apk
    if($LASTEXITCODE) { throw 'Проверка подписи не пройдена.' }
    Get-FileHash artifacts/DeepSeek-Pocket-1.3.3.apk -Algorithm SHA256 | Format-List
    Write-Host 'APK: artifacts/DeepSeek-Pocket-1.3.3.apk'
    Write-Host 'Для обновлений сохраните .tools/deepseek-pocket.keystore и .tools/signing-password.txt в надёжном месте.'
} finally { Pop-Location }
